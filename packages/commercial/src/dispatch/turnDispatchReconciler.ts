// turnDispatchReconciler —— open dispatch 的周期收敛(RFC-v5-durable-turn-dispatch §2.3)。
//
// leaderBundle shared 单跑(双 master 下只 leader 跑,避免双求证竞态)。四分支全 CAS + 有界 LIMIT:
//   ⓪ open ∧ 租约过期 ∧ 会话墓碑/行亡 → manual_reconcile(session_deleted)+ 机器 resolution
//        自动结案(用户面已消失:tape 落不进、状态无处渲染、容器求证永不收敛;不告警)
//   ① admitted ∧ 租约过期 ∧ age>5min → CAS rejecting(epoch fence)→ 容器求证 reject-if-absent:
//        rejected tombstone → terminal(not_accepted) → fail-visible;有行 → accepted;不可达 → 留 rejecting 重试
//   ② accepted ∧ 卡 stuck 阈值 → 容器 dispatch-state:sink_staged/terminal/running 等;sink_stage_failed/
//        行消失 → manual_reconcile+告警
//   ③ terminal(not_accepted/executed_error) ∧ 未通知 → 财务联查(journal+usage_records):
//        未计费 → client_notified 状态可见(免单 tone);有计费证据 → manual_reconcile(绝不写"未计费")+告警
// 另:open>7d 只读告警(永不 GC)。
//
// 钱安全(I5):有任何计费证据一律 manual_reconcile,绝不静默写"未计费"。negative proof(I2):
// 只有容器**显式** rejected tombstone 才允许 not_accepted 终态,不可达/超时一律重试,绝不推断。

import type { Pool } from 'pg'

import { EVENTS } from '../admin/alertEvents.js'
import { safeEnqueueAlert } from '../admin/alertOutbox.js'
import { isPermanentCodexWaiver, permanentCodexWaiverReason } from '../billing/codexFinalizer.js'
import {
  GATEWAY_EXITED_AT_CTX_KEY,
  clearGatewayShutdownEvidenceByDispatchIds,
  markGatewayShutdownEvidence,
} from '../billing/finalizeJournalReconciler.js'
import { advanceClientTimelineIdentityInTransaction } from '../db/pgSessionsBackend.js'
import type { ContainerCallResult, DispatchIdentity } from './containerDispatchClient.js'
import {
  classifyVisibleOrphan,
} from './visibleOrphan.js'
import {
  casAdmittedToRejecting,
  casRejectingToAccepted,
  casToManualReconcile,
  casToTerminal,
  clearDispatchShutdownEvidence,
  DISPATCH_OPEN_ALERT_AGE_MS,
  DISPATCH_REJECT_MIN_AGE_MS,
  dispatchHasShutdownEvidence,
  getDispatchForUpdate,
  markClientNotified,
  markOpenDispatchShutdownEvidence,
  resolveManualReconcile,
  scanAcceptedStuck,
  scanAdmittedLeaseExpired,
  scanOpenAged,
  scanOpenSessionGone,
  scanRejecting,
  scanTerminalUnnotified,
  type Queryable,
  type TurnDispatchRow,
} from './turnDispatchStore.js'

export const DEFAULT_RECONCILE_INTERVAL_MS = 30_000
export const MIN_INTERVAL_MS = 5_000

export function buildTurnDispatchReconcileFrame(input: {
  sessionId: string
  clientMessageId: string
  reconcile?: 'turn_completed' | 'interrupted' | 'turn_state_unknown'
}): Record<string, unknown> {
  const terminal = input.reconcile === 'turn_completed' || input.reconcile === 'interrupted'
  return {
    type: 'outbound.message',
    channel: 'webchat',
    peer: { id: input.sessionId, kind: 'dm' },
    clientMessageId: input.clientMessageId,
    isFinal: terminal,
    meta: {
      reconcile: terminal ? input.reconcile : 'turn_state_unknown',
      clientMessageId: input.clientMessageId,
    },
    ts: Date.now(),
  }
}

export const DEFAULT_LIMIT = 50

let visibleOrphanScanOffset = 0

/** Test-only: reset closeVisibleOrphans OFFSET cursor. */
export function _resetVisibleOrphanScanOffset(): void {
  visibleOrphanScanOffset = 0
}
export const DEFAULT_CODEX_SESSION_MAX_MS = 600_000
/** accepted stuck 阈值 floor = max(codexMax*2, 90min);env 只允许向上夹(更保守)。 */
export const DEFAULT_ACCEPTED_STUCK_FLOOR_MS = 90 * 60 * 1000
export const MAX_ACCEPTED_STUCK_MS = 24 * 3_600_000
/** rejecting 容器不可达超此龄 → 运维告警(不碰用户面)。 */
export const REJECTING_UNREACHABLE_ALERT_MS = 30 * 60 * 1000
/** accepted 等 sink 超此龄 → 告警。 */
export const SINK_WAIT_ALERT_MS = 24 * 3_600_000
/**
 * accepted 行的容器求证持续失败超此龄 → 运维告警。曾经此路径静默 continue,唯一兜底是
 * 7d open_aged:2026-07-18 transport SSRF 白名单网段错配把求证 100% 拦死(81 连败),
 * 收敛链瘫痪 27h 无人知晓。求证失败必须有告警出口,不允许无限静默重试。
 */
export const ACCEPTED_UNREACHABLE_ALERT_MS = 15 * 60 * 1000
/** 优雅停机总预算:先落证据,再尽力求证;超时放弃求证,不挡退出。 */
export const DEFAULT_SHUTDOWN_HANDOFF_BUDGET_MS = 5_000
/** 停机单次容器求证上限,避免默认 5s transport timeout 吃完整预算。 */
export const SHUTDOWN_PROBE_TIMEOUT_MS = 700

/** accepted stuck 阈值解析:向上夹(同 finalizeJournalReconciler.resolveStuckThresholdMs 模式)。 */
export function resolveDispatchStuckThresholdMs(
  envValue: string | number | undefined,
  codexSessionMaxMs?: number,
): number {
  const codexMax =
    typeof codexSessionMaxMs === 'number' &&
    Number.isFinite(codexSessionMaxMs) &&
    codexSessionMaxMs >= 1000
      ? codexSessionMaxMs
      : DEFAULT_CODEX_SESSION_MAX_MS
  const floor = Math.max(codexMax * 2, DEFAULT_ACCEPTED_STUCK_FLOOR_MS)
  const cap = Math.max(floor, MAX_ACCEPTED_STUCK_MS)
  const raw = Number(envValue)
  const fromEnv = Number.isSafeInteger(raw) && raw > floor ? raw : floor
  return Math.min(fromEnv, cap)
}

/** 财务证据评估结果:有任何计费证据 → billed(不可写"未计费")。 */
export type BillingAssessment = 'not_billed' | 'billed'

/**
 * 联查 journal(按 dispatch_id)+ usage_records(按 dispatch_id)判定是否有计费证据。
 * usage_records 是永久财务真相(有行=已计费)。
 *
 * **零计费证明收紧(B8)**:aborted journal **不能**一律当「未计费」。旧实现把任意
 * aborted 都视作零计费,但非永久 abort = 结算瞬态失败(DB 抖动 / 未知 COMMIT),
 * durableCodexBilling.ts §193 的可重开逻辑证明它**可能仍会补账** → 属财务歧义。
 * 只有携带 `permanent_codex_waiver:` 前缀的 aborted(finalizer.fail 的 proven no-usage
 * 决定)才是真「未计费」。判据:
 *   - 有 usage 行                          → billed
 *   - 有非 aborted journal 行(inflight/finalizing/committed) → billed
 *   - 有非永久 waiver 的 aborted 行         → billed(歧义,走 manual_reconcile,绝不写"未计费")
 *   - 无 journal / usage,或 journal 全为永久 waiver aborted → not_billed
 * 在事务内调用时传入锁行的 client(与 SELECT ... FOR UPDATE 同一 snapshot)。
 */
export async function assessDispatchBilling(q: Queryable, dispatchId: string): Promise<BillingAssessment> {
  const usage = await q.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM usage_records WHERE dispatch_id = $1`,
    [dispatchId],
  )
  if (Number(usage.rows[0]?.n ?? '0') > 0) return 'billed'
  const journal = await q.query<{ state: string; error_msg: string | null }>(
    `SELECT state, error_msg FROM request_finalize_journal WHERE dispatch_id = $1`,
    [dispatchId],
  )
  for (const r of journal.rows) {
    if (r.state !== 'aborted') return 'billed'
    // aborted 但非永久 waiver = 可重开的瞬态失败 → 财务歧义,当作 billed 走 manual。
    if (!isPermanentCodexWaiver(r.error_msg)) return 'billed'
  }
  return 'not_billed'
}

/** abort 掉的 pre-forward journal 引用(供释放对应 preCheck reservation)。 */
export interface AbortedJournalRef {
  userId: string
  requestId: string
}

/**
 * B-R1-1(钱安全):容器 durable **not_accepted** proof(= 从未执行)收敛后,把该 dispatch 的
 * pre-forward inflight journal(bridge attach 前 startInflightJournal 写的,从未产出 usage)CAS 为
 * **永久 no-execution waiver aborted**。复用 abortInflightJournal 的 SET 语义(state='aborted' +
 * final_credits=0 + 清 settlementClaimId)+ permanentCodexWaiverReason 前缀,使随后的
 * assessDispatchBilling 判定 not_billed(否则「非 aborted 的 inflight journal」被当 billed →
 * 全进 manual、用户不可见、违反 I1)。
 *
 * **内嵌 no-usage 守卫**:仅当该 dispatch **无** usage_records 时才 abort。若竟有账(理论上
 * not_accepted 不该有,防御性),WHERE 不命中 → 不动 journal,assess 随后见 usage → billed →
 * manual(钱安全:绝不把有账的写成「未计费」)。同理只碰 state='inflight' 行:finalizing/committed
 * 是在途/已结算,由 settlement fence 独占,永不被本路径抢改。
 *
 * 必须在**锁本 dispatch 行的事务 client** 上调(与 assessDispatchBilling 同一 snapshot)。
 * 返回被 abort 行的 (user_id, request_id) 供释放 reservation。
 */
export async function abortNeverExecutedJournalForDispatch(
  client: Queryable,
  dispatchId: string,
): Promise<AbortedJournalRef[]> {
  const reason = permanentCodexWaiverReason('dispatch_never_executed')
  const res = await client.query<{ user_id: string; request_id: string }>(
    `UPDATE request_finalize_journal
        SET state='aborted', error_msg=$2, failure_code='INTERNAL_ERROR',
            final_credits=0, ctx=ctx - 'settlementClaimId' - 'gatewayExitedAt' - 'gatewayExitReason', updated_at=NOW()
      WHERE dispatch_id=$1 AND state='inflight'
        AND NOT EXISTS (SELECT 1 FROM usage_records ur WHERE ur.dispatch_id=$1)
      RETURNING user_id, request_id`,
    [dispatchId, reason],
  )
  return res.rows.map((r) => ({ userId: r.user_id, requestId: r.request_id }))
}

export interface TurnDispatchReconcilerDeps {
  pool: Pool
  container: {
    rejectIfAbsent: (id: DispatchIdentity) => Promise<ContainerCallResult>
    getDispatchState: (id: DispatchIdentity) => Promise<ContainerCallResult>
  }
  enqueueAlert?: (event: Parameters<typeof safeEnqueueAlert>[0]) => void
  /** 测试注入:覆盖财务评估(接收锁行事务 client)。 */
  assessBilling?: (q: Queryable, dispatchId: string) => Promise<BillingAssessment>
  /**
   * B-R1-1:释放被 abort 的 pre-forward journal 对应的 preCheck reservation(commit 后 best-effort,
   * 复用 releasePreCheck(preCheckRedis, {userId, requestId}))。reservation 本会自然过期,提前释放
   * 只是尽快归还预扣额度。未注入(deps 缺 preCheckRedis)时对本轮存在的 reservation 记一次 log。
   */
  releaseReservation?: (ref: AbortedJournalRef) => Promise<void>
  /**
   * best-effort 实时通知:verified failure 状态提交后,若用户在线,推一条轻量 sync-nudge
   * 让前端立即拉回 turn_dispatches 状态,不必等下次 hello/sync。published≠delivered
   * 是现实:失败/离线一律无害吞掉(状态已持久,下次进会话/sync 必达)。
   */
  nudgeClient?: (
    uid: bigint,
    sessionId: string,
    clientMessageId: string,
    reconcile?: 'turn_completed' | 'interrupted' | 'turn_state_unknown',
  ) => void
  stuckThresholdMs?: number
  rejectMinAgeMs?: number
  limit?: number
  now?: () => number
  /**
   * 测试注入:本轮哪些 dispatch 带有「承载进程已退出」证据。
   * 默认查 turn_dispatches.shutdown_ctx ∪ journal.ctx.gatewayExitedAt。
   */
  listCarrierDeadDispatchIds?: () => Promise<string[]>
  /** Parts-complete branch: same Phase A entry as HTTP finalize. */
  commitVisibleTape?: (input: {
    userId: string
    sessionId: string
    tapeId: string
  }) => Promise<void>
}

function idOf(row: TurnDispatchRow): DispatchIdentity {
  return {
    uid: row.userId,
    dispatchId: row.dispatchId,
    attemptNo: row.attemptNo,
    sessionId: row.sessionId,
    clientMessageId: row.clientMessageId,
  }
}

export interface ReconcileTickCounts {
  rejectedTerminal: number
  accepted: number
  manualReconcile: number
  visibleFailures: number
  notified: number
  alerts: number
  /** ⓪ 会话墓碑/行亡 → 自动结案(manual_reconcile(session_deleted)+ 机器 resolution)。 */
  sessionGoneClosed: number
  /** rev2 closeVisibleOrphans: visible fallback / interrupt / fence. */
  visibleOrphans: number
}

/**
 * 跑一轮收敛。顺序:⓪ 会话亡自动结案 → ① rejecting 求证(可能产出新 terminal)→ ③ terminal
 * 未通知(消化① 的产物)→ ② accepted stuck → open>7d 告警。全 best-effort:单行失败不拖累其余。
 */
export async function runReconcileTick(deps: TurnDispatchReconcilerDeps): Promise<ReconcileTickCounts> {
  const now = deps.now ?? Date.now
  const limit = deps.limit ?? DEFAULT_LIMIT
  const rejectMinAge = deps.rejectMinAgeMs ?? DISPATCH_REJECT_MIN_AGE_MS
  const stuckMs = deps.stuckThresholdMs ?? DEFAULT_ACCEPTED_STUCK_FLOOR_MS
  const assess = deps.assessBilling ?? assessDispatchBilling
  const enqueue = deps.enqueueAlert ?? safeEnqueueAlert
  const counts: ReconcileTickCounts = {
    rejectedTerminal: 0,
    accepted: 0,
    manualReconcile: 0,
    visibleFailures: 0,
    notified: 0,
    alerts: 0,
    sessionGoneClosed: 0,
    visibleOrphans: 0,
  }

  // ── ⓪ open ∧ 租约过期 ∧ 会话墓碑/行亡 → 自动结案(session_deleted)────────
  // 会话墓碑是 durable proof「用户面已不存在」:tape 落不进(stage 返 session_deleted)、
  // 状态无处渲染、容器常随会话回收 → ①② 的容器求证对这类行永远收敛不动
  // (2026-07-18 e2e 实证:accepted 恒卡,直到 open>7d 才以告警冒头)。执行 outcome 无从
  // 求证也不可伪造(I2:not_accepted 只认容器 tombstone)→ 不走 terminal,走
  // manual_reconcile(证据行永存)+ 机器 resolution 立即记账进 90d GC 窗。不告警:
  // 用户删会话 / e2e teardown 是正常生命周期,不是运维事件。放最前:免得这类行先被
  // ①CAS 进 rejecting 白耗容器求证轮次。
  const gone = await scanOpenSessionGone(deps.pool, { minAgeMs: rejectMinAge, limit, now: now() })
  for (const row of gone) {
    const held = await casToManualReconcile(deps.pool, {
      dispatchId: row.dispatchId,
      conflictReason: 'session_deleted',
      fromStatuses: ['admitted', 'accepted', 'rejecting'],
      now: now(),
    })
    if (held === null) continue // 竞态:tape finalize / 别的路径先动了
    await resolveManualReconcile(deps.pool, {
      dispatchId: row.dispatchId,
      resolution: 'auto_closed:session_deleted',
      now: now(),
    })
    await clearExitMark(deps, row)
    counts.sessionGoneClosed++
  }

  // ── ① admitted ∧ 租约过期 ∧ age>rejectMinAge ─────────────────────────────
  // 租约过期本身就是「owner 进程不再续租」的证据;5min age 门只挡无证据的幼龄行。
  const admitted = await scanAdmittedLeaseExpired(deps.pool, { minAgeMs: 0, limit, now: now() })
  const youngAdmitted = admitted.filter((row) => now() - row.admittedAt.getTime() < rejectMinAge)
  const admittedDeadIds = new Set(await resolveCarrierDeadDispatchIds(deps, youngAdmitted))
  for (const row of admitted) {
    const admittedAge = now() - row.admittedAt.getTime()
    if (admittedAge < rejectMinAge && !admittedDeadIds.has(row.dispatchId)) continue
    const rejecting = await casAdmittedToRejecting(deps.pool, {
      dispatchId: row.dispatchId,
      expectedEpoch: row.leaseEpoch,
      ownerId: 'turn-dispatch-reconciler',
      now: now(),
    })
    if (rejecting === null) continue // 竞态:bridge 心跳续上 / 别的路径先动了
    await resolveRejecting(deps, rejecting, counts, enqueue, now())
  }

  // 已在 rejecting 但上轮不可达的行,本轮继续求证。
  const stillRejecting = await scanRejecting(deps.pool, { limit })
  for (const row of stillRejecting) {
    await resolveRejecting(deps, row, counts, enqueue, now())
  }

  // ── ③ terminal(not_accepted/executed_error) ∧ 未通知 → fail-visible ──────
  // B8:每行走**单事务** SELECT ... FOR UPDATE 锁本 dispatch 行 → tx 内重验终态 + 财务联查
  // (journal/usage 同 snapshot)→ markClientNotified 同 tx 提交。与 tape
  // finalize 的 convergeDispatchOnFinalize(其 casToTerminal 取本行写锁)共享互斥序:要么先
  // late-tape 转 manual,要么先状态通知——绝不并发产出「失败状态 + 完整 tape」。
  const unnotified = await scanTerminalUnnotified(deps.pool, { limit })
  for (const scanned of unnotified) {
    await settleTerminalUnnotified(deps, scanned, counts, enqueue, assess, now())
  }

  // ── ② accepted:>ALERT_MS 起只读求证探测(告警),>stuckMs 才进入状态收敛 ──
  // 扫描下限取 ALERT_MS(15min)而非 stuckMs(下限 90min):否则求证系统性瘫痪
  // (如 SSRF 拦死)要等 stuckMs 才首告(Codex R1 MAJOR)。[ALERT_MS, stuckMs)
  // 窗口内的行**只探测+告警,零状态迁移**——所有既有收敛分支仍由下方 age 门守住。
  const stuck = await scanAcceptedStuck(deps.pool, {
    // Read typed container state every tick. This is a bounded indexed page,
    // not a timeout: it lets a restarted executor publish an interruption
    // without fabricating an Agent tape or waiting 15/90 minutes.
    stuckMs: 0,
    limit,
    now: now(),
  })
  const youngAccepted = stuck.filter(
    (row) => now() - (row.acceptedAt ?? row.admittedAt).getTime() < stuckMs,
  )
  const acceptedDeadIds = new Set(await resolveCarrierDeadDispatchIds(deps, youngAccepted))
  for (const row of stuck) {
    const age = now() - (row.acceptedAt ?? row.admittedAt).getTime()
    const hasDeadEvidence = acceptedDeadIds.has(row.dispatchId) || dispatchHasShutdownEvidence(row)
    const res = await deps.container.getDispatchState(idOf(row))
    if (res.kind === 'ok' && (res.state === 'running' || res.state === 'queued' || res.state === 'sink_staged')) {
      // 真在飞:禁止因停机证据收口。清掉证据,避免下一轮不可达时误杀。
      if (hasDeadEvidence) await clearExitMark(deps, row)
      if (res.state === 'sink_staged' && age > SINK_WAIT_ALERT_MS) {
        alertWarn(enqueue, row, `accepted dispatch awaiting sink for ${Math.round(age / 3_600_000)}h`, 'sink_wait')
        counts.alerts++
      }
      continue
    }
    if (res.kind !== 'ok') {
      // 不可达:有停机/carrier-dead 证据才允许收口;否则等下轮,持续失败才告警。
      if (hasDeadEvidence) {
        const closed = await closeAcceptedAsServiceRestart(deps, row, now())
        if (closed) {
          counts.visibleFailures++
          counts.notified++
          await clearExitMark(deps, row)
          try {
            deps.nudgeClient?.(row.userId, row.sessionId, row.clientMessageId)
          } catch { /* status is durable; live nudge is best-effort */ }
        }
        continue
      }
      if (age > ACCEPTED_UNREACHABLE_ALERT_MS) {
        alertWarn(
          enqueue,
          row,
          `accepted dispatch 容器求证持续失败 ${Math.round(age / 60_000)}min(${res.kind}: ${res.detail})`,
          'accepted_unreachable',
        )
        counts.alerts++
      }
      continue
    }
    if (res.state === 'terminal' && res.outcome === 'crashed') {
      // The container durably proves its execution process ended, but it does
      // not prove that a fully staged result can never arrive later. Persist a
      // typed dispatch status only; never occupy or replace the immutable tape
      // namespace. A late real finalize moves this row out of terminal and the
      // direct timeline naturally removes the status.
      const closed = await closeAcceptedAsServiceRestart(deps, row, now())
      if (closed) {
        counts.visibleFailures++
        counts.notified++
        await clearExitMark(deps, row)
        try {
          deps.nudgeClient?.(row.userId, row.sessionId, row.clientMessageId)
        } catch { /* status is durable; live nudge is best-effort */ }
      }
      continue
    }
    if (res.state === 'recovery_pending') {
      // 容器已离开 running 进入恢复协议(非 live)。尽快 sentinel,迟到真 tape 可覆盖。
      const closed = await closeAcceptedAsServiceRestart(deps, row, now())
      if (closed) {
        counts.visibleFailures++
        counts.notified++
        await clearExitMark(deps, row)
        try {
          deps.nudgeClient?.(row.userId, row.sessionId, row.clientMessageId)
        } catch { /* status is durable; live nudge is best-effort */ }
      }
      continue
    }
    // 无进程死亡证据时保持 90min 门(防误杀活流);有标记则容器已给出 rejected/absent 即可收敛。
    if (age < stuckMs && !hasDeadEvidence) continue
    if (res.state === 'rejected') {
      // 容器把这条 accepted 的 inbox 行终态化为 rejected tombstone(如 boot recovery:
      // queued/running 被拒)。这是**显式** durable negative proof(I2 允许),→ CAS
      // terminal(not_accepted)进 fail-visible(下轮 ③ 分支消化,或若已过则次轮)。
      const terminal = await casToTerminal(deps.pool, {
        dispatchId: row.dispatchId,
        outcome: 'not_accepted',
        failureCode: 'DISPATCH_NOT_ACCEPTED',
        clientNotified: false,
        fromStatuses: ['accepted'],
        now: now(),
      })
      if (terminal) {
        counts.rejectedTerminal++
        await clearExitMark(deps, row)
      }
    } else if (res.state === 'absent' && hasDeadEvidence) {
      // 重启后行消失:已执行过,写 SERVICE_RESTART,绝不 not_accepted。
      const closed = await closeAcceptedAsServiceRestart(deps, row, now())
      if (closed) {
        counts.visibleFailures++
        counts.notified++
        await clearExitMark(deps, row)
        try {
          deps.nudgeClient?.(row.userId, row.sessionId, row.clientMessageId)
        } catch { /* status is durable; live nudge is best-effort */ }
      }
    } else if (res.state === 'sink_stage_failed' || res.state === 'absent') {
      const held = await casToManualReconcile(deps.pool, {
        dispatchId: row.dispatchId,
        conflictReason: `container_${res.state}`,
        now: now(),
      })
      if (held) {
        counts.manualReconcile++
        alertManual(enqueue, row, `container inbox state=${res.state} for an accepted dispatch`)
        counts.alerts++
        await clearExitMark(deps, row)
      }
    } else if (res.state === 'sink_staged' || res.state === 'terminal') {
      // 等 sink ACK(无 TTL 必达);过久告警但不动状态。
      if (age > SINK_WAIT_ALERT_MS) {
        alertWarn(enqueue, row, `accepted dispatch awaiting sink for ${Math.round(age / 3_600_000)}h`, 'sink_wait')
        counts.alerts++
      }
    }
    // running/queued 已在上方 live 分支 continue。
  }

  // ── closeVisibleOrphans (rev2 B4): tapeless fallback + fence + late tape ──
  counts.visibleOrphans = await closeVisibleOrphans(deps, now(), limit)

  // ── open>7d 只读告警(永不 GC)─────────────────────────────────────────────
  const openAged = await scanOpenAged(deps.pool, { ageMs: DISPATCH_OPEN_ALERT_AGE_MS, limit, now: now() })
  for (const row of openAged) {
    alertWarn(enqueue, row, `dispatch stuck open (${row.status}) for >7d`, 'open_aged')
    counts.alerts++
  }

  return counts
}


async function aggregateDispatchLiveText(pool: import('pg').Pool, dispatchId: string): Promise<string> {
  const frames = await pool.query<{ payload: Buffer }>(
    `SELECT f.payload
       FROM client_session_live_streams s
       JOIN client_session_live_frames f ON f.stream_key=s.stream_key
      WHERE s.dispatch_id=$1::uuid
      ORDER BY f.created_at`,
    [dispatchId],
  )
  const chunks: string[] = []
  for (const row of frames.rows) {
    try {
      const parsed = JSON.parse(row.payload.toString('utf8')) as {
        type?: string
        blocks?: Array<{ kind?: string; text?: string }>
        text?: string
      }
      if (parsed.type && parsed.type !== 'outbound.message') continue
      if (typeof parsed.text === 'string' && parsed.text) chunks.push(parsed.text)
      for (const block of parsed.blocks ?? []) {
        if (block.kind === 'text' && typeof block.text === 'string') chunks.push(block.text)
      }
    } catch {
      /* ignore malformed frame */
    }
  }
  return chunks.join('')
}

async function projectTapelessVisibleToSession(
  client: { query: import('pg').Pool['query'] },
  input: {
    sessionId: string
    userId: string
    dispatchId: string
    clientMessageId: string
    text: string
    nowMs: number
  },
): Promise<void> {
  const session = await client.query<{ messages: string; next_seq: number | null }>(
    `SELECT messages, next_seq FROM client_sessions
      WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE`,
    [input.sessionId, input.userId],
  )
  const row = session.rows[0]
  if (!row) return
  let messages: Array<Record<string, unknown>> = []
  try {
    const parsed = JSON.parse(row.messages)
    if (Array.isArray(parsed)) messages = parsed as Array<Record<string, unknown>>
  } catch {
    return
  }
  const id = `visible-fallback:${input.dispatchId}`
  if (messages.some((message) => message.id === id)) return
  messages.push({
    id,
    role: 'assistant',
    text: input.text,
    ts: input.nowMs,
    _source: 'server',
    _clientMessageId: input.clientMessageId,
  })
  await client.query(
    `UPDATE client_sessions
        SET messages=$3, message_count=COALESCE(archived_count,0)+$4,
            last_at=$5, updated_at=GREATEST(updated_at+1, $5),
            history_revision=history_revision+1,
            timeline_generation=timeline_generation+1
      WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`,
    [input.sessionId, input.userId, JSON.stringify(messages), messages.length, input.nowMs],
  )
}

async function finalizeOrphanDispatch(input: {
  deps: TurnDispatchReconcilerDeps
  row: {
    dispatch_id: string
    user_id: string
    session_id: string
    client_message_id: string
  }
  outcome: 'completed' | 'interrupted'
  nowMs: number
  fence: boolean
  projectFallback: boolean
  fallbackText: string
}): Promise<boolean> {
  const client = await input.deps.pool.connect()
  try {
    await client.query('BEGIN')
    const locked = await client.query<{ status: string }>(
      `SELECT status FROM turn_dispatches WHERE dispatch_id=$1::uuid FOR UPDATE -- closeVisibleOrphans lock`,
      [input.row.dispatch_id],
    )
    const status = locked.rows[0]?.status
    if (status !== 'admitted' && status !== 'accepted' && status !== 'rejecting') {
      await client.query('ROLLBACK')
      return false
    }
    if (input.fence) {
      await client.query(
        `UPDATE turn_dispatches SET producer_fenced_at=COALESCE(producer_fenced_at, NOW())
          WHERE dispatch_id=$1::uuid AND producer_fenced_at IS NULL`,
        [input.row.dispatch_id],
      )
    }
    if (input.projectFallback) {
      await client.query(
        `UPDATE turn_dispatches
            SET visible_head=$2::jsonb, visible_at=COALESCE(visible_at,$3)
          WHERE dispatch_id=$1::uuid`,
        [
          input.row.dispatch_id,
          JSON.stringify({
            role: 'assistant',
            text: input.fallbackText,
            ts: input.nowMs,
            messageId: `visible-fallback:${input.row.dispatch_id}`,
            clientMessageId: input.row.client_message_id,
          }),
          input.nowMs,
        ],
      )
      await projectTapelessVisibleToSession(client, {
        sessionId: input.row.session_id,
        userId: `c:${input.row.user_id}`,
        dispatchId: input.row.dispatch_id,
        clientMessageId: input.row.client_message_id,
        text: input.fallbackText,
        nowMs: input.nowMs,
      })
    }
    const terminal = await casToTerminal(client, {
      dispatchId: input.row.dispatch_id,
      outcome: input.outcome,
      fromStatuses: ['admitted', 'accepted', 'rejecting'],
    })
    if (!terminal) {
      await client.query('ROLLBACK')
      return false
    }
    await client.query('COMMIT')
    return true
  } catch (err) {
    try { await client.query('ROLLBACK') } catch { /* ignore */ }
    throw err
  } finally {
    client.release()
  }
}

async function closeVisibleOrphans(
  deps: TurnDispatchReconcilerDeps,
  nowMs: number,
  limit: number,
): Promise<number> {
  const scanLimit = Math.min(200, Math.max(limit * 4, limit))
  const queryVisible = async (offset: number) => deps.pool.query<{
    dispatch_id: string
    user_id: string
    session_id: string
    client_message_id: string
    status: string
    admitted_at: Date
    accepted_at: Date | null
    tape_visible_at: string | null
    tape_part_count: number | null
    tape_id: string | null
    tape_parts_rows: string
    last_frame_at: Date | null
    container_running: boolean
  }>(
    `SELECT -- closeVisibleOrphans
            d.dispatch_id, d.user_id::text AS user_id, d.session_id, d.client_message_id,
            d.status, d.admitted_at, d.accepted_at,
            t.visible_at::text AS tape_visible_at,
            t.part_count AS tape_part_count,
            t.tape_id,
            COALESCE((
              SELECT count(*)::text FROM client_session_turn_tape_parts p
               WHERE t.tape_id IS NOT NULL
                 AND p.session_id = t.session_id
                 AND p.user_id = t.user_id
                 AND p.tape_id = t.tape_id
            ), '0') AS tape_parts_rows,
            (
              SELECT MAX(f.created_at)
                FROM client_session_live_streams s
                JOIN client_session_live_frames f ON f.stream_key = s.stream_key
               WHERE s.dispatch_id = d.dispatch_id
            ) AS last_frame_at,
            EXISTS (
              SELECT 1 FROM agent_containers ac
               WHERE ac.user_id = d.user_id AND ac.state = 'active'
            ) AS container_running
       FROM turn_dispatches d
       LEFT JOIN client_session_turn_tapes t ON t.dispatch_id = d.dispatch_id
      WHERE d.status IN ('admitted','accepted')
      ORDER BY d.admitted_at, d.dispatch_id
      OFFSET $2 LIMIT $1`,
    [scanLimit, offset],
  )
  let rows = await queryVisible(visibleOrphanScanOffset)
  if (rows.rows.length === 0 && visibleOrphanScanOffset > 0) {
    visibleOrphanScanOffset = 0
    rows = await queryVisible(0)
  }
  if (rows.rows.length < scanLimit) visibleOrphanScanOffset = 0
  else visibleOrphanScanOffset += rows.rows.length
  let closed = 0
  for (const row of rows.rows) {
    const action = classifyVisibleOrphan({
      tapeVisibleAt: row.tape_visible_at === null ? null : Number(row.tape_visible_at),
      tapePartCount: row.tape_part_count,
      tapePartsRows: Number(row.tape_parts_rows ?? '0'),
      lastFrameAtMs: row.last_frame_at ? row.last_frame_at.getTime() : null,
      acceptedOrAdmittedAtMs: (row.accepted_at ?? row.admitted_at).getTime(),
      containerRunning: row.container_running === true,
      nowMs,
    })
    if (action === 'skip') continue
    const hasTape = typeof row.tape_id === 'string' && row.tape_id.length > 0
    const outcome = action === 'complete_from_frames' || action === 'converge_only'
      ? 'completed' as const
      : 'interrupted' as const
    if (hasTape && action === 'complete_from_frames') {
      const tapeId = row.tape_id
      if (!tapeId || !deps.commitVisibleTape) continue
      try {
        await deps.commitVisibleTape({
          userId: `c:${row.user_id}`,
          sessionId: row.session_id,
          tapeId,
        })
      } catch {
        continue
      }
      closed++
      try {
        deps.nudgeClient?.(
          BigInt(row.user_id),
          row.session_id,
          row.client_message_id,
          'turn_completed',
        )
      } catch {
        /* best-effort */
      }
      continue
    }
    const projectFallback = !hasTape
    if (hasTape && !projectFallback && action !== 'converge_only'
      && action !== 'interrupt_tapeless' && action !== 'fence_hard_cap') {
      continue
    }
    const aggregated = projectFallback ? await aggregateDispatchLiveText(deps.pool, row.dispatch_id) : ''
    const text = aggregated
      || (outcome === 'completed'
        ? 'turn completed (visible fallback)'
        : 'turn interrupted (visible fallback)')
    const ok = await finalizeOrphanDispatch({
      deps,
      row,
      outcome,
      nowMs,
      fence: action === 'fence_hard_cap',
      projectFallback,
      fallbackText: text,
    })
    if (!ok) continue
    closed++
    try {
      deps.nudgeClient?.(
        BigInt(row.user_id),
        row.session_id,
        row.client_message_id,
        outcome === 'completed' ? 'turn_completed' : 'interrupted',
      )
    } catch {
      /* best-effort */
    }
  }
  return closed
}

/** A verified user-visible status is a new durable timeline identity attached
 * to an existing user record. Publish the status bit and invalidate every
 * already-issued history cursor in one transaction; otherwise an older loaded
 * page can remain permanently unaware of the new status. */
async function advanceVisibleTimelineIdentity(
  q: Queryable,
  row: Pick<TurnDispatchRow, 'sessionId' | 'userId'>,
): Promise<void> {
  await advanceClientTimelineIdentityInTransaction(q, row.sessionId, `c:${row.userId}`)
}

/**
 * B8:terminal-未通知单行的**单事务**收敛。锁本 dispatch 行(与 tape finalize 互斥),
 * tx 内重验终态未变 + 财务联查同 snapshot,再决定直接状态可见(免单)或 manual_reconcile(歧义)。
 * 告警/计数/实时 nudge 都在 commit 之后做(不在持锁窗口内做 I/O,也不为回滚的决定发告警)。
 */
async function settleTerminalUnnotified(
  deps: TurnDispatchReconcilerDeps,
  scanned: TurnDispatchRow,
  counts: ReconcileTickCounts,
  enqueue: (event: Parameters<typeof safeEnqueueAlert>[0]) => void,
  assess: (q: Queryable, dispatchId: string) => Promise<BillingAssessment>,
  nowMs: number,
): Promise<void> {
  const client = await deps.pool.connect()
  // commit 之后要做的副作用(告警/计数/nudge/释放 reservation)在 tx 外执行:先攒起来。
  type Post =
    | { kind: 'manual'; reason: string; reservations: AbortedJournalRef[] }
    | { kind: 'visible'; notified: boolean; reservations: AbortedJournalRef[] }
  let post: Post | null = null
  try {
    await client.query('BEGIN')
    const row = await getDispatchForUpdate(client, scanned.dispatchId)
    if (
      row === null ||
      row.status !== 'terminal' ||
      (row.outcome !== 'not_accepted' && row.outcome !== 'executed_error') ||
      row.clientNotified
    ) {
      // finalize 已在锁前把它收敛(late tape→manual / 或已通知)。放弃本行,无副作用。
      await client.query('ROLLBACK')
      return
    }
    if (row.anchorSeq === null) {
      // 没有 anchor 无法把状态排到原用户轮次后;交人工(理论上受理即写 anchor,不该出现)。
      const held = await casToManualReconcile(client, {
        dispatchId: row.dispatchId,
        conflictReason: 'missing_anchor_seq',
        now: nowMs,
      })
      await client.query('COMMIT')
      if (held) post = { kind: 'manual', reason: 'missing anchor_seq — cannot place verified failure status', reservations: [] }
      finalizeSettlePost(post, scanned, counts, enqueue, deps)
      return
    }
    // B-R1-1(钱安全):not_accepted = 容器 durable rejected proof = 从未执行 → 同一 tx 内先把
    // pre-forward inflight journal CAS 为永久 no-execution waiver aborted(no-usage 守卫内嵌),
    // assess 遂得 not_billed → 状态可见。executed_error(已转发执行后出错,可能有账)不碰。
    let reservations: AbortedJournalRef[] = []
    if (row.outcome === 'not_accepted') {
      reservations = await abortNeverExecutedJournalForDispatch(client, row.dispatchId)
    }
    let assessment: BillingAssessment
    try {
      assessment = await assess(client, row.dispatchId)
    } catch {
      await client.query('ROLLBACK') // DB 抖动,下轮重试;绝不在评估失败时写用户面(abort 亦回滚)
      return
    }
    if (assessment === 'billed') {
      const held = await casToManualReconcile(client, {
        dispatchId: row.dispatchId,
        conflictReason: 'billed_but_failed',
        now: nowMs,
      })
      await client.query('COMMIT')
      if (held) {
        post = {
          kind: 'manual',
          reason: 'terminal failure but billing evidence exists — never mark "not billed"',
          reservations,
        }
      }
      finalizeSettlePost(post, scanned, counts, enqueue, deps)
      return
    }
    // 未计费 → 直接把 durable dispatch 标记为用户可见。读侧从本行生成 typed
    // status record；不再复制/改写为 assistant message。
    const notified = await markClientNotified(client, row.dispatchId)
    if (notified) await advanceVisibleTimelineIdentity(client, row)
    await client.query('COMMIT')
    post = { kind: 'visible', notified, reservations }
    finalizeSettlePost(post, scanned, counts, enqueue, deps)
  } catch {
    try {
      await client.query('ROLLBACK')
    } catch {
      /* connection already broken */
    }
    // best-effort:吞掉,下轮重试(scanTerminalUnnotified 仍会选中它)。
  } finally {
    client.release()
  }
}

/** deps 无 releaseReservation 时,对存在待释放 reservation 只 log 一次(避免每轮刷屏)。 */
let loggedMissingReservationReleaser = false

/** commit 之后的无锁副作用:计数 + 告警 + best-effort 实时 nudge + 释放被 abort 的 reservation。 */
function finalizeSettlePost(
  post:
    | { kind: 'manual'; reason: string; reservations: AbortedJournalRef[] }
    | { kind: 'visible'; notified: boolean; reservations: AbortedJournalRef[] }
    | null,
  row: TurnDispatchRow,
  counts: ReconcileTickCounts,
  enqueue: (event: Parameters<typeof safeEnqueueAlert>[0]) => void,
  deps: TurnDispatchReconcilerDeps,
): void {
  if (post === null) return
  // B-R1-1:被 abort 的 pre-forward journal 对应 preCheck reservation 提前释放(best-effort;
  // reservation 本会过期,失败无害)。无 releaser 注入时对本轮存在的 reservation 记一次 log。
  releaseAbortedReservations(post.reservations, deps)
  if (post.kind === 'manual') {
    counts.manualReconcile++
    alertManual(enqueue, row, post.reason)
    counts.alerts++
    void clearExitMark(deps, row)
    return
  }
  if (post.notified) {
    counts.visibleFailures++
    counts.notified++
    void clearExitMark(deps, row)
  }
  // 状态已持久 → 用户在线则推一条轻量 nudge 触发前端 reconcile。
  if (post.notified) {
    try {
      deps.nudgeClient?.(row.userId, row.sessionId, row.clientMessageId)
    } catch {
      /* nudge 是 best-effort,失败无害(状态已持久) */
    }
  }
}

function releaseAbortedReservations(
  reservations: AbortedJournalRef[],
  deps: TurnDispatchReconcilerDeps,
): void {
  if (reservations.length === 0) return
  if (!deps.releaseReservation) {
    if (!loggedMissingReservationReleaser) {
      loggedMissingReservationReleaser = true
      // eslint-disable-next-line no-console
      console.warn(
        '[turnDispatchReconciler] aborted pre-forward journal(s) but no releaseReservation wired; ' +
          'preCheck reservations will only free on natural expiry',
        { count: reservations.length },
      )
    }
    return
  }
  for (const ref of reservations) {
    void deps.releaseReservation(ref).catch(() => {
      /* best-effort:reservation 自然过期兜底 */
    })
  }
}

async function resolveRejecting(
  deps: TurnDispatchReconcilerDeps,
  row: TurnDispatchRow,
  counts: ReconcileTickCounts,
  enqueue: (event: Parameters<typeof safeEnqueueAlert>[0]) => void,
  nowMs: number,
): Promise<void> {
  const res = await deps.container.rejectIfAbsent(idOf(row))
  if (res.kind !== 'ok') {
    // 不可达/错误 → 保持 rejecting 重试。超 30min 且不可达 → 告警(不碰用户面)。
    const age = nowMs - row.admittedAt.getTime()
    if (age > REJECTING_UNREACHABLE_ALERT_MS) {
      alertWarn(enqueue, row, `rejecting dispatch: container unreachable for ${Math.round(age / 60000)}min (${res.detail})`, 'rejecting_unreachable')
      counts.alerts++
    }
    return
  }
  if (res.state === 'rejected') {
    // 显式 tombstone → not_accepted 终态(未通知,交 ③ 分支 fail-visible)。
    const terminal = await casToTerminal(deps.pool, {
      dispatchId: row.dispatchId,
      outcome: 'not_accepted',
      failureCode: 'DISPATCH_NOT_ACCEPTED',
      clientNotified: false,
      fromStatuses: ['rejecting'],
      now: nowMs,
    })
    if (terminal) {
      counts.rejectedTerminal++
      await clearExitMark(deps, row)
    }
  } else if (res.state === 'absent') {
    // reject-if-absent 契约下不该回 absent(无行必插 tombstone);保守当错误重试。
  } else {
    // 容器有行(queued/running/…) → 转 accepted 分支。
    const accepted = await casRejectingToAccepted(deps.pool, { dispatchId: row.dispatchId, now: nowMs })
    if (accepted) counts.accepted++
  }
}

function alertManual(
  enqueue: (event: Parameters<typeof safeEnqueueAlert>[0]) => void,
  row: TurnDispatchRow,
  reason: string,
): void {
  enqueue({
    event_type: EVENTS.OPS_INCIDENT_OPENED,
    severity: 'critical',
    title: 'turn dispatch 需人工核对',
    body:
      `dispatch \`${row.dispatchId}\`(user \`${row.userId}\`, session \`${row.sessionId}\`)` +
      ` 进入 manual_reconcile:${reason}。请核对计费与执行归宿后手工收敛。`,
    payload: {
      source: 'turnDispatchReconciler',
      kind: 'manual_reconcile',
      dispatch_id: row.dispatchId,
      user_id: row.userId.toString(),
      session_id: row.sessionId,
      client_message_id: row.clientMessageId,
    },
    dedupe_key: `${EVENTS.OPS_INCIDENT_OPENED}:turn_dispatch:${row.dispatchId}`,
  })
}

function alertWarn(
  enqueue: (event: Parameters<typeof safeEnqueueAlert>[0]) => void,
  row: TurnDispatchRow,
  reason: string,
  kind: string,
): void {
  const day = new Date().toISOString().slice(0, 10)
  enqueue({
    event_type: EVENTS.OPS_DAILY_ANOMALY,
    severity: 'warning',
    title: 'turn dispatch 异常滞留',
    body: `dispatch \`${row.dispatchId}\`(user \`${row.userId}\`):${reason}。`,
    payload: {
      source: 'turnDispatchReconciler',
      kind,
      dispatch_id: row.dispatchId,
      user_id: row.userId.toString(),
      status: row.status,
    },
    dedupe_key: `${EVENTS.OPS_DAILY_ANOMALY}:turn_dispatch:${kind}:${row.dispatchId}:${day}`,
    dedupe_all_statuses: true,
  })
}


async function closeAcceptedAsServiceRestart(
  deps: TurnDispatchReconcilerDeps,
  row: TurnDispatchRow,
  nowMs: number,
): Promise<TurnDispatchRow | null> {
  const client = await deps.pool.connect()
  let terminal: TurnDispatchRow | null = null
  try {
    await client.query('BEGIN')
    terminal = await casToTerminal(client, {
      dispatchId: row.dispatchId,
      outcome: 'executed_error',
      failureCode: 'SERVICE_RESTART',
      clientNotified: true,
      fromStatuses: ['accepted'],
      now: nowMs,
    })
    if (terminal) await advanceVisibleTimelineIdentity(client, row)
    await client.query('COMMIT')
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { /* connection already broken */ }
    throw error
  } finally {
    client.release()
  }
  return terminal
}

async function resolveCarrierDeadDispatchIds(
  deps: TurnDispatchReconcilerDeps,
  rows: Array<Pick<TurnDispatchRow, 'dispatchId' | 'shutdownCtx'>>,
): Promise<string[]> {
  const fromRows = rows.filter(dispatchHasShutdownEvidence).map((r) => r.dispatchId)
  if (deps.listCarrierDeadDispatchIds) {
    return [...new Set([...fromRows, ...(await deps.listCarrierDeadDispatchIds())])]
  }
  return [...new Set([...fromRows, ...(await loadGatewayExitDispatchIds(deps.pool, rows))])]
}

/**
 * 从小集合按 dispatch_id 反查停机标记。一轮 turn 有多条 journal,
 * 标记打在调用级 request_id 上,通常 ≠ billing_request_id。空候选不发查询。
 */
export async function loadGatewayExitDispatchIds(
  pool: Pool,
  rows: Array<{ dispatchId: string }>,
): Promise<string[]> {
  const dispatchIds = [...new Set(rows.map((r) => r.dispatchId).filter((id) => id.length > 0))]
  if (dispatchIds.length === 0) return []
  try {
    const res = await pool.query<{ dispatch_id: string }>(
      `SELECT dispatch_id::text AS dispatch_id
         FROM turn_dispatches
        WHERE dispatch_id = ANY($1::uuid[])
          AND COALESCE(shutdown_ctx->>$2, '') <> ''
       UNION
       SELECT DISTINCT dispatch_id::text AS dispatch_id
         FROM request_finalize_journal
        WHERE dispatch_id = ANY($1::uuid[])
          AND COALESCE(ctx->>$2, '') <> ''`,
      [dispatchIds, GATEWAY_EXITED_AT_CTX_KEY],
    )
    return res.rows.map((r) => r.dispatch_id)
  } catch {
    return []
  }
}

async function clearExitMark(
  deps: TurnDispatchReconcilerDeps,
  row: { dispatchId: string },
): Promise<void> {
  if (!row.dispatchId) return
  try {
    await clearDispatchShutdownEvidence(deps.pool, row.dispatchId)
  } catch {
    /* 终态已落,清标记失败下轮可重试 */
  }
  try {
    await clearGatewayShutdownEvidenceByDispatchIds(
      [row.dispatchId],
      async (sql, params) => {
        const res = await deps.pool.query(sql, params ?? [])
        return { rows: res.rows as Array<{ request_id: string }>, rowCount: res.rowCount }
      },
    )
  } catch {
    /* 终态已落,清标记失败下轮可重试 */
  }
}

export async function expireAdmittedLeasesOnShutdown(
  pool: Pool,
  nowMs?: number,
): Promise<number> {
  const at = new Date(nowMs ?? Date.now())
  const res = await pool.query(
    `UPDATE turn_dispatches
        SET lease_until = $1
      WHERE status = 'admitted'
        AND lease_until IS NOT NULL
        AND lease_until > $1`,
    [at],
  )
  return res.rowCount ?? 0
}

function withProbeBudget(
  container: TurnDispatchReconcilerDeps['container'],
  timeoutMs: number,
): TurnDispatchReconcilerDeps['container'] {
  const wrap = async (work: Promise<ContainerCallResult>): Promise<ContainerCallResult> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        work,
        new Promise<ContainerCallResult>((resolve) => {
          timer = setTimeout(
            () => resolve({ kind: 'unreachable', detail: 'shutdown_budget' }),
            Math.max(50, timeoutMs),
          )
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  return {
    rejectIfAbsent: (id) => wrap(container.rejectIfAbsent(id)),
    getDispatchState: (id) => wrap(container.getDispatchState(id)),
  }
}

export interface ShutdownHandoffResult {
  markedJournals: number
  markedDispatches: number
  expiredLeases: number
  probed: boolean
  timedOut: boolean
  tick: ReconcileTickCounts | null
}

export interface ShutdownHandoffDeps extends TurnDispatchReconcilerDeps {
  markJournals?: () => Promise<number>
  markOpenDispatches?: () => Promise<number>
  expireLeases?: () => Promise<number>
  budgetMs?: number
}

/**
 * 优雅停机钩子:先落「进程在 T 退出」证据,再在预算内复用容器求证收敛已死的 dispatch。
 * 不盲 finalize——容器回 running/不可达则只留证据,让重启后的 tick 立刻判定。
 */
export async function runShutdownDispatchHandoff(
  deps: ShutdownHandoffDeps,
): Promise<ShutdownHandoffResult> {
  const now = deps.now ?? Date.now
  const started = now()
  const budgetMs = deps.budgetMs ?? DEFAULT_SHUTDOWN_HANDOFF_BUDGET_MS
  const markedJournals = await (deps.markJournals
    ?? (() => markGatewayShutdownEvidence({ reason: 'process_shutdown' })))()
  const markedDispatches = await (deps.markOpenDispatches
    ?? (() => markOpenDispatchShutdownEvidence(deps.pool, { now: now(), reason: 'process_shutdown' })))()
  const expiredLeases = await (deps.expireLeases
    ?? (() => expireAdmittedLeasesOnShutdown(deps.pool, now())))()

  const remain = budgetMs - (now() - started)
  if (remain <= 150) {
    return { markedJournals, markedDispatches, expiredLeases, probed: false, timedOut: true, tick: null }
  }

  const probeTimeout = Math.min(SHUTDOWN_PROBE_TIMEOUT_MS, Math.max(80, remain - 80))
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const tickPromise = runReconcileTick({
    ...deps,
    container: withProbeBudget(deps.container, probeTimeout),
    limit: Math.min(deps.limit ?? 8, 8),
  })
  const timeoutPromise = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true
      resolve(null)
    }, remain)
  })
  const tick = await Promise.race([tickPromise, timeoutPromise])
  if (timer !== undefined) clearTimeout(timer)
  return {
    markedJournals,
    markedDispatches,
    expiredLeases,
    probed: tick !== null,
    timedOut,
    tick,
  }
}

// ─── 调度器(leaderBundle shared + trackScheduler)──────────────────────────

export interface TurnDispatchReconcilerHandle {
  stop(): void
  runNow(): Promise<ReconcileTickCounts>
}

export interface StartTurnDispatchReconcilerOptions extends TurnDispatchReconcilerDeps {
  intervalMs?: number
  runOnStart?: boolean
  onError?: (err: unknown) => void
}

function defaultOnError(err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn('[turnDispatchReconciler] tick failed:', err)
}

export function startTurnDispatchReconciler(
  opts: StartTurnDispatchReconcilerOptions,
): TurnDispatchReconcilerHandle {
  const interval = Math.max(MIN_INTERVAL_MS, opts.intervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS)
  const onError = opts.onError ?? defaultOnError
  const runOnStart = opts.runOnStart ?? true
  let stopped = false
  let running = false

  const empty: ReconcileTickCounts = {
    rejectedTerminal: 0,
    accepted: 0,
    manualReconcile: 0,
    visibleFailures: 0,
    notified: 0,
    alerts: 0,
    sessionGoneClosed: 0,
    visibleOrphans: 0,
  }

  async function runOneTick(): Promise<ReconcileTickCounts> {
    if (running) return empty // DB 卡时跳过重叠 tick
    running = true
    try {
      // jitter:错开双 master 抢先(leaderBundle 只 leader 跑,jitter 再防定时对齐踩踏)。
      return await runReconcileTick(opts)
    } catch (err) {
      onError(err)
      return empty
    } finally {
      running = false
    }
  }

  const jitter = Math.floor(Math.random() * Math.min(5_000, interval))
  const timer = setInterval(() => {
    if (!stopped) void runOneTick()
  }, interval + jitter)
  if (typeof timer.unref === 'function') timer.unref()
  if (runOnStart) void runOneTick()

  return {
    stop() {
      stopped = true
      clearInterval(timer)
    },
    runNow: runOneTick,
  }
}
