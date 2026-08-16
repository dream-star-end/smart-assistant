/**
 * B1 — request_finalize_journal reconciler + GC(migration 0015 承诺、从未实现)。
 *
 * 背景:
 *   v3 chat 计费在 stream 开始前写一行 `inflight` journal(proxyBilling.startInflightJournal),
 *   finalize 时 CAS 到 committed/aborted。PG 真扣费只发生在 finalize(settleUsageAndLedger);
 *   preCheck 只是 Redis 软预扣(300s TTL)。如果进程在 startInflightJournal 与 finalize 之间
 *   崩溃(部署中断 / OOM / SIGKILL),journal 行永远卡 `inflight`:
 *     (a) 用户消耗了上游/账号池资源却**从未 PG 扣费** → 收入泄漏;
 *     (b) 表无限增长(0015 自估 ~200MB/月)。
 *   migration 0015 规定了 reconciler + 7d GC,但调度器里从来没接(只有 admin/ledger.ts 读取做展示 join)。
 *
 * 本模块的定位(**legacy terminalizer,不是 durable Codex replay**):
 *   旧 journal 只持久化了 model / codex 元信息,**没有**持久化最终 usage/pricing(结算用的是
 *   内存 snapshot)。因此旧请求崩溃后**无法**重算真实用量、无法"replay 成 committed"。
 *   新 Codex paid-turn 用 immutable turn tape 保存精确 billing evidence,ctx 带
 *   durableBillingRecovery 标记；这类行先由 tape 持久重试,不得套 legacy 30min 超时。
 *   但若 24h 后仍没有 tape/usage 证据,继续永久 inflight 只会制造假在途状态；此时仅对
 *   `inflight` 行写入显式永久免单裁决。`finalizing` 可能仍有 owner/结算事务,绝不按时间
 *   abort。GC 不删除 durable recovery 的任何终态裁决。对其余 legacy/Anthropic journal:
 *     - 已结算但 journal 没翻终态的(崩在 settle 提交与 journal 更新之间)→ 按 usage_records
 *       这个**持久财务真相**把 journal 补到 committed,并回填 usage_id/ledger_id/final_credits;
 *     - 非 durable 且从未结算的(崩在 observe/settle 之前,无 usage_records)→ 记为 aborted(error_msg=
 *       'reconciler_timeout'),**不退不扣**(precheck 只是估算预扣,非财务真相;Redis 预扣 300s
 *       TTL 早已过期)。这等于**接受这部分免费用量不可追回**,但至少把行终态化、可被 GC。
 *   想要真正可追回,需要另一改动:在 settle 之前把观测到的 usage/pricing 落进 journal。
 *
 * 阈值(关键):journal 在 streaming 期间**不**心跳更新 updated_at;codex 单 turn 上限
 *   CODEX_SESSION_MAX_MS=600s,anthropic 路径无硬超时。因此"stuck"阈值必须**远大于**任何
 *   存活请求时长,否则会把正在跑的长流误判成 stuck 并 abort。默认 30min,且对 env 覆盖
 *   **向上**夹到 max(CODEX_SESSION_MAX_MS*3, 30min)。
 *
 * 单进程部署(同 pendingOrdersExpirer 假设),不需要分布式锁;CAS `WHERE state IN
 * ('inflight','finalizing')` 保证幂等(蓝绿重叠 / 与真实 finalize 并发时二次执行 no-op)。
 */

import { query } from '../db/queries.js'
import {
  DURABLE_CODEX_RECOVERY_VERSION,
  permanentCodexWaiverReason,
} from './codexFinalizer.js'
import { transitionProductFrictionEventIfPresent } from '../productFriction/events.js'
import { safeEnqueueAlert } from '../admin/alertOutbox.js'
import { EVENTS } from '../admin/alertEvents.js'

export const DEFAULT_RECONCILE_INTERVAL_MS = 60_000
export const MIN_INTERVAL_MS = 5_000
/** stuck 判定:行 updated_at 早于 now-threshold 才动。默认 30min。 */
export const DEFAULT_STUCK_THRESHOLD_MS = 1_800_000
export const DEFAULT_CODEX_SESSION_MAX_MS = 600_000
/** Durable Codex evidence can retry for one full day before a no-evidence inflight row is waived. */
export const DEFAULT_DURABLE_WAIVER_AGE_MS = 24 * 3_600_000
/** Avoid unsafe/accidental multi-year interval values while keeping a generous operator ceiling. */
export const MAX_DURABLE_WAIVER_AGE_MS = 365 * 24 * 3_600_000
/** GC:非 durable Codex 的 committed/aborted 老于该时长才删。 */
export const DEFAULT_GC_AGE_MS = 7 * 24 * 3_600_000
/**
 * durable Codex 终态行的有界 GC(2026-07-16 巡检批;此前 durable 行永不删 → 每个
 * codex turn 永久留一行,无界增长)。settleDurableCodexBilling 对"journal 缺行"本就有
 * GC 竞态兜底:usage_records 是永久财务真相,缺行 + usage 在 → ACK already_committed。
 *   - committed:30d(且必须仍有 usage_records 证据才删——兜底路径依赖它证幂等);
 *   - aborted(含永久免单 waiver):90d。waiver 行无 usage 证据,删后若有 >90d 迟到
 *     tape 重放会在重试队列里响亮报错(journal missing)而非静默双扣——可见、可运维,
 *     且 90d 远超容器 fsync 重试队列的实际生存期。
 */
export const DURABLE_COMMITTED_GC_AGE_MS = 30 * 24 * 3_600_000
export const DURABLE_ABORTED_GC_AGE_MS = 90 * 24 * 3_600_000
export const MIN_GC_AGE_MS = 3_600_000 // 永不删 1h 内的终态行(防误删)
export const DEFAULT_GC_INTERVAL_MS = 3_600_000 // GC 比 reconcile 稀疏
export const DEFAULT_GC_LIMIT = 5_000 // 单次 GC 批量上限,避免一刀大删
/** stuck 阈值上限 24h:防 env 写 1e100 之类(指数记法 / 丢精度会把 $1::bigint 打挂)。 */
export const MAX_STUCK_THRESHOLD_MS = 86_400_000
/**
 * journal.ctx 键:承载该行的 gateway 进程在该时刻退出(优雅停机或即将被杀)。
 * 这不是「turn 已死」——引擎可能仍在容器里跑。重启后的对账用它走秒~分钟级快路径,
 * 仍必须先看容器/租约,绝不能单凭此键 abort 一轮还在跑的 accepted turn。
 */
export const GATEWAY_EXITED_AT_CTX_KEY = 'gatewayExitedAt'
export const GATEWAY_EXIT_REASON_CTX_KEY = 'gatewayExitReason'

/**
 * durable `finalizing` 老化告警阈值(二级检测,2026-07-17 batch G)。
 *
 * 审计缺口:reconcileStuckFinalizeJournal 的三条 CAS 都**不覆盖** durable `finalizing`
 * 无 evidence 行 —— committed CAS 要有 usage_records;aborted CAS 显式排除 durable 行
 * (`durableBillingRecovery <> version`);durableWaived CAS 只认 `state='inflight'`。因此
 * 一个 durable finalizing 行若既拿不到 settle owner、又永远等不到 usage_records,会**永久
 * 卡"假在途"**,任何自动路径都不会动它(故意保守:finalizing 可能仍有存活 owner/结算事务,
 * 绝不按时间 abort)。
 *
 * 本阈值触发的是**告警而非终态**:超龄(默认 48h)+ 无 usage 证据的 durable finalizing 行
 * → 发 admin 告警交人工裁定,**行状态一律不动**。48h 远超任何存活 settle 事务时长,命中
 * 基本可判定为真卡死。可经 startFinalizeJournalReconciler 的 durableFinalizingAlertAgeMs
 * option 覆盖(env 接线待 index.ts 归入所有权批次时补 COMMERCIAL_FINALIZE_DURABLE_
 * FINALIZING_ALERT_AGE_MS;当前 index.ts 不在本批所有权内,故只走 option + 常量)。
 */
export const DEFAULT_DURABLE_FINALIZING_ALERT_AGE_MS = 48 * 3_600_000
/** durable finalizing 告警龄上限(复用 waiver 的一年硬顶,拒 1e100/非安全整数)。 */
export const MAX_DURABLE_FINALIZING_ALERT_AGE_MS = MAX_DURABLE_WAIVER_AGE_MS
/** 单轮告警扫描行数上限(dedupe 已按行 id+天收敛,这里再加一道硬顶防一次性刷屏)。 */
export const DEFAULT_FINALIZING_ALERT_LIMIT = 100

export interface ReconcileCounts {
  committed: number
  aborted: number
  durableWaived: number
}

export function journalHasGatewayExitMark(ctx: unknown): boolean {
  if (!ctx || typeof ctx !== 'object') return false
  const v = (ctx as Record<string, unknown>)[GATEWAY_EXITED_AT_CTX_KEY]
  return typeof v === 'string' && v.length > 0
}

export type JournalExec = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: Array<{ request_id: string }>; rowCount: number | null }>

/**
 * 停机证据:给仍 inflight/finalizing 的 journal 打上 gatewayExitedAt,不改 state、不碰 updated_at
 * (避免把 30min stuck 时钟重置)。重启后的 reconcile 据此走快路径。
 */
export async function markGatewayShutdownEvidence(
  input: { now?: Date; reason?: string } = {},
  exec?: JournalExec,
): Promise<number> {
  const exitedAt = (input.now ?? new Date()).toISOString()
  const reason = input.reason ?? 'process_shutdown'
  const run = exec ?? (async (sql, params) => {
    const res = await query<{ request_id: string }>(sql, params ?? [])
    return { rows: res.rows, rowCount: res.rowCount }
  })
  const res = await run(
    `UPDATE request_finalize_journal
        SET ctx = COALESCE(ctx, '{}'::jsonb)
          || jsonb_build_object($1::text, $2::text, $3::text, $4::text),
            updated_at = updated_at
      WHERE state IN ('inflight', 'finalizing')
        AND COALESCE(ctx->>'gatewayExitedAt', '') = ''
      RETURNING request_id`,
    [GATEWAY_EXITED_AT_CTX_KEY, exitedAt, GATEWAY_EXIT_REASON_CTX_KEY, reason],
  )
  return res.rowCount ?? res.rows.length
}

/**
 * 终态时摘掉停机标记(PK 点更新)。dispatch/journal 任一侧翻终态都清,
 * 避免标记随部署单调堆积,也避免陈年标记让老行永远走快路径。
 */
export async function clearGatewayShutdownEvidenceByRequestIds(
  requestIds: string[],
  exec?: JournalExec,
): Promise<number> {
  const ids = [...new Set(requestIds.filter((id) => id.length > 0))]
  if (ids.length === 0) return 0
  const run = exec ?? (async (sql, params) => {
    const res = await query<{ request_id: string }>(sql, params ?? [])
    return { rows: res.rows, rowCount: res.rowCount }
  })
  const res = await run(
    `UPDATE request_finalize_journal
        SET ctx = ctx - $2::text - $3::text
      WHERE request_id = ANY($1::text[])
        AND (ctx ? $2 OR ctx ? $3)
      RETURNING request_id`,
    [ids, GATEWAY_EXITED_AT_CTX_KEY, GATEWAY_EXIT_REASON_CTX_KEY],
  )
  return res.rowCount ?? res.rows.length
}

/**
 * 解析 stuck 阈值:env 覆盖只允许**向上**(更保守);floor = max(codexMax*3, 30min)。
 * codexMax 非法/缺省 → 600s。
 */
export function resolveStuckThresholdMs(
  envValue: string | number | undefined,
  codexSessionMaxMs?: number,
): number {
  const codexMax =
    typeof codexSessionMaxMs === 'number' &&
    Number.isFinite(codexSessionMaxMs) &&
    codexSessionMaxMs >= 1000
      ? codexSessionMaxMs
      : DEFAULT_CODEX_SESSION_MAX_MS
  const floor = Math.max(codexMax * 3, DEFAULT_STUCK_THRESHOLD_MS)
  // 上限 = max(floor, 24h):正常 floor ≤ 24h → 封到 24h;极端大 codexMax 让 floor>24h 时
  // 不把活 codex 流误 abort(floor 优先)。isSafeInteger 拒掉 1e100/NaN/非整数 env。
  const cap = Math.max(floor, MAX_STUCK_THRESHOLD_MS)
  const raw = Number(envValue)
  const fromEnv = Number.isSafeInteger(raw) && raw > floor ? raw : floor
  return Math.min(fromEnv, cap)
}

/**
 * Durable recovery has a distinct, much longer SLA than legacy stuck rows.
 * It can only be raised by configuration; its floor is max(24h, stuck threshold).
 */
export function resolveDurableWaiverAgeMs(
  envValue: string | number | undefined,
  stuckThresholdMs?: number,
): number {
  const safeStuck =
    typeof stuckThresholdMs === 'number' &&
    Number.isSafeInteger(stuckThresholdMs) &&
    stuckThresholdMs >= 0
      ? stuckThresholdMs
      : DEFAULT_STUCK_THRESHOLD_MS
  const floor = Math.max(DEFAULT_DURABLE_WAIVER_AGE_MS, safeStuck)
  const cap = Math.max(floor, MAX_DURABLE_WAIVER_AGE_MS)
  const raw = Number(envValue)
  const fromEnv = Number.isSafeInteger(raw) && raw > floor ? raw : floor
  return Math.min(fromEnv, cap)
}

/**
 * 夹 durable finalizing 告警龄:floor=48h(默认),cap=一年硬顶;非安全整数/过小 → 默认。
 * 仅用于 option 覆盖场景(index.ts 当前不传 → 恒取 DEFAULT)。
 */
export function resolveDurableFinalizingAlertAgeMs(
  value: number | string | undefined,
): number {
  const raw = Number(value)
  const floor = DEFAULT_DURABLE_FINALIZING_ALERT_AGE_MS
  if (!Number.isSafeInteger(raw) || raw < floor) return floor
  return Math.min(raw, MAX_DURABLE_FINALIZING_ALERT_AGE_MS)
}

export interface StuckDurableFinalizingRow {
  requestId: string
  userId: string
  ageMs: number
}

/**
 * 只读扫描:durable(`durableBillingRecovery=version`)且 `state='finalizing'` 超过告警龄、
 * 又无 usage_records evidence 的行。**不发任何 UPDATE**,不碰行状态。谓词与三条 CAS 的
 * durable/finalizing/no-usage 判定同源,专挑三条 CAS 都不覆盖的"假在途"死角。
 */
export async function scanStuckDurableFinalizing(
  alertAgeMs: number,
  limit: number,
): Promise<StuckDurableFinalizingRow[]> {
  const ms = String(Math.max(0, Math.floor(alertAgeMs)))
  const lim = Math.max(1, Math.floor(limit))
  const res = await query<{ request_id: string; user_id: string; age_ms: string }>(
    `SELECT rfj.request_id,
            rfj.user_id::text AS user_id,
            (EXTRACT(EPOCH FROM (NOW() - rfj.updated_at)) * 1000)::bigint::text AS age_ms
       FROM request_finalize_journal rfj
      WHERE rfj.state = 'finalizing'
        AND rfj.updated_at < NOW() - ($1::bigint * INTERVAL '1 millisecond')
        AND COALESCE(rfj.ctx->>'durableBillingRecovery', '') = $2
        AND NOT EXISTS (
          SELECT 1 FROM usage_records ur
           WHERE ur.request_id = rfj.request_id AND ur.user_id = rfj.user_id
        )
      ORDER BY rfj.updated_at ASC
      LIMIT $3`,
    [ms, DURABLE_CODEX_RECOVERY_VERSION, String(lim)],
  )
  return res.rows.map((r) => ({
    requestId: r.request_id,
    userId: r.user_id,
    ageMs: Number(r.age_ms),
  }))
}

/**
 * 对每个老化 durable finalizing 行发一条 admin 告警(人工裁定),**不改任何行状态**。
 *
 * dedupe=行 id+天(`…:<request_id>:<YYYY-MM-DD>`):同一卡死行每天最多告警一次(持续提醒
 * 而非刷屏),跨天再提醒直到人工处置。event_type 复用已注册的 ops.daily_anomaly(warning
 * 级"周期性计费异常"桶)—— 本批所有权边界禁改 alertEvents.ts,故不新开 billing.finalize_
 * stuck 事件;payload.source 作判别,升格为专用事件待有批次归入 alertEvents.ts 所有权。
 * enqueue/scan 均可注入以便单测(默认走真 safeEnqueueAlert + 真 DB 扫描)。返回命中行数。
 */
export async function alertStuckDurableFinalizing(
  alertAgeMs: number = DEFAULT_DURABLE_FINALIZING_ALERT_AGE_MS,
  limit: number = DEFAULT_FINALIZING_ALERT_LIMIT,
  enqueue: (event: Parameters<typeof safeEnqueueAlert>[0]) => void = safeEnqueueAlert,
  scan: (
    ageMs: number,
    lim: number,
  ) => Promise<StuckDurableFinalizingRow[]> = scanStuckDurableFinalizing,
): Promise<number> {
  const rows = await scan(alertAgeMs, limit)
  if (rows.length === 0) return 0
  const day = new Date().toISOString().slice(0, 10)
  const ageHours = Math.round(alertAgeMs / 3_600_000)
  for (const row of rows) {
    enqueue({
      event_type: EVENTS.OPS_DAILY_ANOMALY,
      severity: 'warning',
      title: 'durable finalize journal 卡死(疑假在途)',
      body:
        `durable Codex finalize journal 行 \`${row.requestId}\`(user \`${row.userId}\`)已停在 ` +
        `\`finalizing\` ${Math.round(row.ageMs / 3_600_000)}h(> ${ageHours}h 告警龄)且无 ` +
        `usage_records 证据。三条 reconciler CAS 都不覆盖此形态,不会自动终态(保守:可能仍有 ` +
        `存活 settle owner)。请人工核对是否真卡死:确认后手工裁决(补 committed / 记 waiver)。`,
      payload: {
        source: 'finalizeJournalReconciler',
        kind: 'durable_finalizing_stuck',
        request_id: row.requestId,
        user_id: row.userId,
        age_ms: row.ageMs,
        alert_age_ms: alertAgeMs,
      },
      dedupe_key: `${EVENTS.OPS_DAILY_ANOMALY}:finalize_stuck:${row.requestId}:${day}`,
      dedupe_all_statuses: true,
    })
  }
  return rows.length
}

/**
 * 扫 stuck journal 行并终态化。三条 CAS UPDATE:
 *   1) committed:有对应 usage_records(结算记录已落,只是 journal 没翻终态)→ 回填 ids；
 *      不按 status 过滤——journal 'committed' 语义就是"存在结算记录"(success/billing_failed/
 *      codex 0-cost error 都算),与现有 finalizer 一致。
 *   2) aborted:非 durable Codex 且无 usage_records(从未结算的真泄漏)→
 *      记 'reconciler_timeout',不退不扣。带 durable recovery 标记的行保持可重放。
 *   3) durableWaived:durable `inflight` 超过独立 24h+ SLA 且仍无 usage_records →
 *      写显式永久免单裁决；晚到 tape 只 ACK waiver。`finalizing` 永不走此时间裁决。
 * 返回各自受影响行数。
 */
export async function reconcileStuckFinalizeJournal(
  thresholdMs: number,
  durableWaiverAgeMs: number = DEFAULT_DURABLE_WAIVER_AGE_MS,
): Promise<ReconcileCounts> {
  const ms = String(Math.max(0, Math.floor(thresholdMs)))
  const committedRes = await query<{ request_id: string }>(
    `UPDATE request_finalize_journal rfj
        SET state = 'committed',
            usage_id = ur.id,
            ledger_id = ur.ledger_id,
            final_credits = ur.cost_credits,
            failure_code = NULL,
            ctx = rfj.ctx - 'settlementClaimId' - 'gatewayExitedAt' - 'gatewayExitReason',
            updated_at = NOW()
       FROM usage_records ur
      WHERE rfj.request_id = ur.request_id
        AND rfj.user_id = ur.user_id
        AND rfj.state IN ('inflight', 'finalizing')
        AND (
          rfj.updated_at < NOW() - ($1::bigint * INTERVAL '1 millisecond')
          OR COALESCE(rfj.ctx->>'gatewayExitedAt', '') <> ''
          OR EXISTS (
            SELECT 1 FROM turn_dispatches td
             WHERE td.dispatch_id = rfj.dispatch_id
               AND td.status IN ('admitted', 'rejecting')
               AND (td.lease_until IS NULL OR td.lease_until <= NOW())
          )
        )
      RETURNING rfj.request_id`,
    [ms],
  )
  const abortedRes = await query<{ request_id: string }>(
    `UPDATE request_finalize_journal rfj
        SET state = 'aborted',
            error_msg = 'reconciler_timeout',
            final_credits = 0,
            failure_code = 'INTERNAL_ERROR',
            ctx = rfj.ctx - 'settlementClaimId' - 'gatewayExitedAt' - 'gatewayExitReason',
            updated_at = NOW()
      WHERE rfj.state IN ('inflight', 'finalizing')
        AND COALESCE(rfj.ctx->>'durableBillingRecovery', '') <> $2
        AND NOT EXISTS (
          SELECT 1 FROM usage_records ur
           WHERE ur.request_id = rfj.request_id AND ur.user_id = rfj.user_id
        )
        AND (
          rfj.updated_at < NOW() - ($1::bigint * INTERVAL '1 millisecond')
          OR (
            -- 进程死亡证据:标记或 admitted/rejecting 租约已过期。accepted 可能仍有活引擎,绝不走此快路径。
            (
              COALESCE(rfj.ctx->>'gatewayExitedAt', '') <> ''
              OR EXISTS (
                SELECT 1 FROM turn_dispatches td
                 WHERE td.dispatch_id = rfj.dispatch_id
                   AND td.status IN ('admitted', 'rejecting')
                   AND (td.lease_until IS NULL OR td.lease_until <= NOW())
              )
            )
            AND NOT EXISTS (
              SELECT 1 FROM turn_dispatches td
               WHERE td.dispatch_id = rfj.dispatch_id
                 AND td.status = 'accepted'
            )
            AND NOT EXISTS (
              SELECT 1 FROM turn_dispatches td
               WHERE td.dispatch_id = rfj.dispatch_id
                 AND td.status = 'admitted'
                 AND td.lease_until IS NOT NULL
                 AND td.lease_until > NOW()
            )
          )
        )
      RETURNING rfj.request_id`,
    [ms, DURABLE_CODEX_RECOVERY_VERSION],
  )
  const durableMs = String(
    resolveDurableWaiverAgeMs(durableWaiverAgeMs, Math.max(0, Math.floor(thresholdMs))),
  )
  const waiverReason = permanentCodexWaiverReason('durable_evidence_timeout')
  const durableWaivedRes = await query<{ request_id: string }>(
    `UPDATE request_finalize_journal rfj
        SET state = 'aborted',
            error_msg = $3,
            final_credits = 0,
            failure_code = 'INTERNAL_ERROR',
            ctx = rfj.ctx - 'settlementClaimId' - 'gatewayExitedAt' - 'gatewayExitReason',
            updated_at = NOW()
      WHERE rfj.state = 'inflight'
        AND rfj.updated_at < NOW() - ($1::bigint * INTERVAL '1 millisecond')
        AND COALESCE(rfj.ctx->>'durableBillingRecovery', '') = $2
        AND NOT EXISTS (
          SELECT 1 FROM usage_records ur
           WHERE ur.request_id = rfj.request_id AND ur.user_id = rfj.user_id
        )
      RETURNING rfj.request_id`,
    [durableMs, DURABLE_CODEX_RECOVERY_VERSION, waiverReason],
  )
  // Analytics must never roll back or delay a completed billing decision.
  for (const row of durableWaivedRes.rows) {
    void transitionProductFrictionEventIfPresent({
      correlation: row.request_id,
      surface: 'ws',
      stage: 'billing_recovery',
      outcome: 'abandoned',
    }).catch(() => false)
  }
  return {
    committed: committedRes.rowCount ?? 0,
    aborted: abortedRes.rowCount ?? 0,
    durableWaived: durableWaivedRes.rowCount ?? 0,
  }
}

/** GC:删终态老行,单批每分区 ≤ limit(最旧优先,确定性)。三分区:非 durable(入参
 * 窗口)、durable committed(30d + usage 证据仍在)、durable aborted(90d)。 */
export async function gcFinalizeJournal(olderThanMs: number, limit: number): Promise<number> {
  const ms = String(Math.max(0, Math.floor(olderThanMs)))
  const lim = Math.max(1, Math.floor(limit))
  const res = await query<{ request_id: string }>(
    `DELETE FROM request_finalize_journal
      WHERE ctid IN (
        SELECT ctid FROM request_finalize_journal
         WHERE state IN ('committed', 'aborted')
           AND updated_at < NOW() - ($1::bigint * INTERVAL '1 millisecond')
           AND COALESCE(ctx->>'durableBillingRecovery', '') <> $3
         ORDER BY updated_at ASC
         LIMIT $2
      )
      RETURNING request_id`,
    [ms, lim, DURABLE_CODEX_RECOVERY_VERSION],
  )
  let total = res.rowCount ?? 0
  // durable committed:settle 兜底路径靠 usage_records 证幂等,故只删证据仍在的行;
  // 无 usage 的 committed 行(理论不存在)保留 → 可见异常而非静默消失。
  const durableCommitted = await query<{ request_id: string }>(
    `DELETE FROM request_finalize_journal
      WHERE ctid IN (
        SELECT rfj.ctid FROM request_finalize_journal rfj
         WHERE rfj.state = 'committed'
           AND rfj.updated_at < NOW() - ($1::bigint * INTERVAL '1 millisecond')
           AND COALESCE(rfj.ctx->>'durableBillingRecovery', '') = $3
           AND EXISTS (
             SELECT 1 FROM usage_records ur
              WHERE ur.request_id = rfj.request_id AND ur.user_id = rfj.user_id
           )
         ORDER BY rfj.updated_at ASC
         LIMIT $2
      )
      RETURNING request_id`,
    [String(DURABLE_COMMITTED_GC_AGE_MS), lim, DURABLE_CODEX_RECOVERY_VERSION],
  )
  total += durableCommitted.rowCount ?? 0
  const durableAborted = await query<{ request_id: string }>(
    `DELETE FROM request_finalize_journal
      WHERE ctid IN (
        SELECT ctid FROM request_finalize_journal
         WHERE state = 'aborted'
           AND updated_at < NOW() - ($1::bigint * INTERVAL '1 millisecond')
           AND COALESCE(ctx->>'durableBillingRecovery', '') = $3
         ORDER BY updated_at ASC
         LIMIT $2
      )
      RETURNING request_id`,
    [String(DURABLE_ABORTED_GC_AGE_MS), lim, DURABLE_CODEX_RECOVERY_VERSION],
  )
  total += durableAborted.rowCount ?? 0
  return total
}

export interface ReconcilerHandle {
  stop(): void
  /** 测试/运维:立即跑一轮(reconcile + durable finalizing 老化告警 + 视 cadence 决定是否 GC)。与 interval tick 共用 running 守卫。 */
  runNow(): Promise<{
    committed: number
    aborted: number
    durableWaived: number
    finalizingAlerted: number
    gc: number
  }>
}

export interface ReconcilerOptions {
  intervalMs?: number
  /** 调用方应已用 resolveStuckThresholdMs 夹好;这里不再夹(但兜底取默认)。 */
  thresholdMs?: number
  /** 调用方应已用 resolveDurableWaiverAgeMs 夹好；默认 24h。 */
  durableWaiverAgeMs?: number
  gcAgeMs?: number
  gcIntervalMs?: number
  gcLimit?: number
  /** durable finalizing 老化告警龄;不传 → 常量 48h(index.ts 归入所有权后再补 env 接线)。 */
  durableFinalizingAlertAgeMs?: number
  /** 单轮告警扫描行上限;默认 100。 */
  finalizingAlertLimit?: number
  runOnStart?: boolean
  onError?: (err: unknown) => void
  /** 测试注入:覆盖默认 DB 调用。 */
  reconcileFn?: () => Promise<ReconcileCounts>
  gcFn?: () => Promise<number>
  /** 测试注入:覆盖 durable finalizing 老化告警(返回命中行数)。 */
  alertStuckFinalizingFn?: () => Promise<number>
  /** 测试注入:控制 GC cadence 判定的时钟。 */
  now?: () => number
}

function defaultOnError(err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn('[finalizeJournalReconciler] tick failed:', err)
}

export function startFinalizeJournalReconciler(opts: ReconcilerOptions = {}): ReconcilerHandle {
  const interval = Math.max(MIN_INTERVAL_MS, opts.intervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS)
  const thresholdMs = opts.thresholdMs ?? DEFAULT_STUCK_THRESHOLD_MS
  const durableWaiverAgeMs = resolveDurableWaiverAgeMs(
    opts.durableWaiverAgeMs,
    thresholdMs,
  )
  const gcAgeMs = Math.max(MIN_GC_AGE_MS, opts.gcAgeMs ?? DEFAULT_GC_AGE_MS)
  const gcIntervalMs = Math.max(interval, opts.gcIntervalMs ?? DEFAULT_GC_INTERVAL_MS)
  const gcLimit = Math.max(1, opts.gcLimit ?? DEFAULT_GC_LIMIT)
  const finalizingAlertAgeMs = resolveDurableFinalizingAlertAgeMs(opts.durableFinalizingAlertAgeMs)
  const finalizingAlertLimit = Math.max(1, opts.finalizingAlertLimit ?? DEFAULT_FINALIZING_ALERT_LIMIT)
  const reconcileFn = opts.reconcileFn ?? (
    () => reconcileStuckFinalizeJournal(thresholdMs, durableWaiverAgeMs)
  )
  const gcFn = opts.gcFn ?? (() => gcFinalizeJournal(gcAgeMs, gcLimit))
  const alertStuckFinalizingFn = opts.alertStuckFinalizingFn ?? (
    () => alertStuckDurableFinalizing(finalizingAlertAgeMs, finalizingAlertLimit)
  )
  const onError = opts.onError ?? defaultOnError
  const runOnStart = opts.runOnStart ?? true
  const now = opts.now ?? Date.now

  let stopped = false
  let running = false
  let lastGcAt = 0 // 0 → 首轮即 GC(部署后立即清历史终态行)

  async function runOneTick(): Promise<{
    committed: number
    aborted: number
    durableWaived: number
    finalizingAlerted: number
    gc: number
  }> {
    // DB 卡时跳过重叠 tick
    if (running) return { committed: 0, aborted: 0, durableWaived: 0, finalizingAlerted: 0, gc: 0 }
    running = true
    try {
      let committed = 0
      let aborted = 0
      let durableWaived = 0
      let finalizingAlerted = 0
      let gc = 0
      try {
        const r = await reconcileFn()
        committed = r.committed
        aborted = r.aborted
        durableWaived = r.durableWaived
      } catch (err) {
        onError(err)
      }
      // durable finalizing 老化告警(二级检测):独立 try —— 告警扫描失败不拖累 reconcile/GC。
      // 纯只读 + safeEnqueueAlert(fire-and-forget),不改任何行状态;dedupe 按行 id+天。
      try {
        finalizingAlerted = await alertStuckFinalizingFn()
      } catch (err) {
        onError(err)
      }
      const t = now()
      if (t - lastGcAt >= gcIntervalMs) {
        try {
          gc = await gcFn()
          lastGcAt = t // 只在成功后推进,失败下轮重试
        } catch (err) {
          onError(err)
        }
      }
      return { committed, aborted, durableWaived, finalizingAlerted, gc }
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => {
    if (!stopped) void runOneTick()
  }, interval)
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
