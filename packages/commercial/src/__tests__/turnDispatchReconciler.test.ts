/**
 * turnDispatchReconciler unit:阈值钳制 + 三分支关键行为(RFC §2.3 / §7)。
 * 钱安全焦点:terminal-未通知分支在有计费证据时绝不写"未计费",走 manual_reconcile+告警。
 * 假 pool 按 SQL 路由(SQL 真行为由 integ 覆盖)。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { Pool } from 'pg'
import {
  isProducerFenced,
  resetProducerFenceForTests,
} from '../db/liveTurnFrames.js'
import {
  assessDispatchBilling,
  buildTurnDispatchReconcileFrame,
  DEFAULT_ACCEPTED_STUCK_FLOOR_MS,
  expireAdmittedLeasesOnShutdown,
  MAX_ACCEPTED_STUCK_MS,
  resolveDispatchStuckThresholdMs,
  runReconcileTick,
  runShutdownDispatchHandoff,
  loadGatewayExitDispatchIds,
  _resetVisibleOrphanScanOffset,
} from '../dispatch/turnDispatchReconciler.js'
import { markOpenDispatchShutdownEvidence } from '../dispatch/turnDispatchStore.js'
import { PERMANENT_CODEX_WAIVER_PREFIX } from '../billing/codexFinalizer.js'
import type { ContainerCallResult } from '../dispatch/containerDispatchClient.js'
import { permanentCodexWaiverReason } from '../billing/codexFinalizer.js'

type Raw = Record<string, unknown>

function rawRow(o: Partial<Raw> = {}): Raw {
  return {
    dispatch_id: 'd-1',
    user_id: '42',
    session_id: 'sess-0001',
    client_message_id: 'cm-1',
    agent_id: 'main',
    model: null,
    request_hash: 'hash-a',
    billing_request_id: 'br-1',
    attempt_no: 1,
    status: 'terminal',
    outcome: 'not_accepted',
    failure_code: 'DISPATCH_NOT_ACCEPTED',
    conflict_reason: null,
    resolution: null,
    resolved_at: null,
    client_notified: false,
    owner_id: null,
    lease_epoch: '1',
    lease_until: null,
    anchor_seq: '5',
    admitted_at: new Date(Date.now() - 10 * 60_000),
    accepted_at: null,
    terminal_at: new Date(Date.now() - 60_000),
    last_attempt_at: null,
    ...o,
  }
}

interface Canned {
  admittedLeaseExpired?: Raw[]
  rejecting?: Raw[]
  terminalUnnotified?: Raw[]
  acceptedStuck?: Raw[]
  openAged?: Raw[]
  openSessionGone?: Raw[]
  visibleOrphans?: Raw[]
  firstVisibleTraces?: Raw[]
  casToTerminalMiss?: boolean
  abortedJournalRefs?: { user_id: string; request_id: string }[]
  /**
   * INC-20260831 gap2:锁内重验(finalizeOrphanDispatch)看到的"扫描之后"证据。
   * frame 重验返回比扫描时更新的帧 → finalize 必须 ROLLBACK 且零 UPDATE。
   */
  orphanFrameReverify?: Date | null
  /** 锁内 first_visible 重验返回的 turn_traces 行(扫描时没有的存活证据)。 */
  orphanFirstVisibleReverify?: Raw[]
}

function makeFakePool(canned: Canned) {
  const writes: string[] = []
  const writeParams: unknown[][] = []
  const queries: string[] = []
  // accepted 扫描的 SQL 时间参数捕获(Codex R1 MAJOR 回归锁:扫描下限必须是
  // ACCEPTED_UNREACHABLE_ALERT_MS 而非 stuckMs,否则求证瘫痪要等 90min+ 才首告)。
  const acceptedScanCutoffs: Date[] = []
  let txDepth = 0
  let txBuf: string[] = []
  const attemptedWrites: string[] = []
  const recordWrite = (s: string) => {
    attemptedWrites.push(s)
    if (txDepth > 0) txBuf.push(s)
    else writes.push(s)
  }
  // 单点路由:pool.query 与事务 client.query 共用。B8 的 terminal-未通知分支走
  // pool.connect() 单事务(SELECT … FOR UPDATE 锁行 → 重验 → 财务联查 → visible/manual),
  // 故 fake 必须提供 connect() + 事务 client。
  const route = (sql: string, params?: unknown[]) => {
    const s = sql.replace(/\s+/g, ' ')
    queries.push(s)
    if (s === 'BEGIN') {
      txDepth += 1
      txBuf = []
      return { rows: [], rowCount: 0 }
    }
    if (s === 'COMMIT') {
      writes.push(...txBuf)
      writes.push('COMMIT')
      txDepth = 0
      txBuf = []
      return { rows: [], rowCount: 0 }
    }
    if (s === 'ROLLBACK') {
      writes.push('ROLLBACK')
      txDepth = 0
      txBuf = []
      return { rows: [], rowCount: 0 }
    }
    if (s.includes('-- closeVisibleOrphans lock')) {
      const id = params?.[0]
      const orphan = (canned.visibleOrphans ?? []).find((row) => row.dispatch_id === id)
        ?? canned.visibleOrphans?.[0]
      if (!orphan) return { rows: [], rowCount: 0 }
      return { rows: [{ status: orphan.status }], rowCount: 1 }
    }
    // INC-20260831 gap2:finalize 锁内证据重验 —— 可注入"扫描后新出现"的帧/trace。
    if (s.includes('-- orphanFinalizeFrameReverify')) {
      if (canned.orphanFrameReverify == null) return { rows: [], rowCount: 0 }
      return { rows: [{ last_frame_at: canned.orphanFrameReverify }], rowCount: 1 }
    }
    if (s.includes('-- orphanFinalizeFirstVisibleReverify')) {
      const traces = canned.orphanFirstVisibleReverify ?? []
      return { rows: traces, rowCount: traces.length }
    }
    // 行锁读(getDispatchForUpdate):返回锁定的 terminal 行,重验通过。
    if (s.includes('FROM turn_dispatches') && s.includes('FOR UPDATE')) {
      return { rows: [rawRow()], rowCount: 1 }
    }
    if (s.startsWith('UPDATE') || s.startsWith('INSERT')) {
      recordWrite(s)
      writeParams.push(params ?? [])
      if (s.includes("state='aborted'") && s.includes('request_finalize_journal')) {
        return { rows: canned.abortedJournalRefs ?? [], rowCount: canned.abortedJournalRefs?.length ?? 0 }
      }
      if (s.includes('client_notified = TRUE')) return { rows: [], rowCount: 1 }
      if (s.includes("status = 'manual_reconcile'")) return { rows: [rawRow({ status: 'manual_reconcile', conflict_reason: 'x' })], rowCount: 1 }
      if (s.includes("status = 'terminal'")) {
        if (canned.casToTerminalMiss) return { rows: [], rowCount: 0 }
        return { rows: [rawRow({ status: 'terminal', outcome: 'not_accepted', terminal_at: new Date() })], rowCount: 1 }
      }
      if (s.includes("status = 'accepted'")) return { rows: [rawRow({ status: 'accepted' })], rowCount: 1 }
      if (s.includes("status = 'rejecting'")) return { rows: [rawRow({ status: 'rejecting' })], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    }
    // reads (scans)
    if (s.includes("status = 'admitted'") && s.includes('lease_until')) return { rows: canned.admittedLeaseExpired ?? [], rowCount: (canned.admittedLeaseExpired ?? []).length }
    if (s.includes("status = 'rejecting'") && s.includes('ORDER BY admitted_at')) return { rows: canned.rejecting ?? [], rowCount: (canned.rejecting ?? []).length }
    if (s.includes("status = 'terminal'") && s.includes('client_notified = FALSE')) return { rows: canned.terminalUnnotified ?? [], rowCount: (canned.terminalUnnotified ?? []).length }
    if (s.includes("status = 'accepted'") && s.includes('COALESCE(accepted_at')) {
      if (params?.[0] instanceof Date) acceptedScanCutoffs.push(params[0] as Date)
      return { rows: canned.acceptedStuck ?? [], rowCount: (canned.acceptedStuck ?? []).length }
    }
    if (s.includes('-- firstVisiblePrefetch')) {
      if (canned.firstVisibleTraces) {
        return { rows: canned.firstVisibleTraces, rowCount: canned.firstVisibleTraces.length }
      }
      const traces = (canned.visibleOrphans ?? [])
        .filter((row) => row.first_visible_at)
        .map((row) => ({
          dispatch_id: row.dispatch_id,
          user_id: row.user_id,
          session_key: typeof row.session_id === 'string'
            ? `agent:main:webchat:dm:${row.session_id}`
            : String(row.session_id ?? ''),
          first_visible_at: row.first_visible_at,
        }))
      return { rows: traces, rowCount: traces.length }
    }
    // rev2 closeVisibleOrphans must win before session-gone: its SQL joins
    // client_session_turn_tapes (substring of client_sessions).
    if (s.includes('-- closeVisibleOrphans')) {
      return { rows: canned.visibleOrphans ?? [], rowCount: (canned.visibleOrphans ?? []).length }
    }
    // ⓪ scanOpenSessionGone(LEFT JOIN)必须先于 openAged 路由:两者都含 status IN (open 三态)。
    if (s.includes('LEFT JOIN client_sessions s')) return { rows: canned.openSessionGone ?? [], rowCount: (canned.openSessionGone ?? []).length }
    if (s.includes("status IN ('admitted', 'accepted', 'rejecting')")) return { rows: canned.openAged ?? [], rowCount: (canned.openAged ?? []).length }
    return { rows: [], rowCount: 0 }
  }
  const pool = {
    async query(sql: string, params?: unknown[]) {
      return route(sql, params)
    },
    async connect() {
      return {
        async query(sql: string, params?: unknown[]) {
          return route(sql, params)
        },
        release() {},
      }
    },
    writes,
    writeParams,
    queries,
    attemptedWrites,
    acceptedScanCutoffs,
  }
  return pool
}

const noContainer = {
  rejectIfAbsent: async (): Promise<ContainerCallResult> => ({ kind: 'unreachable', detail: 'test' }),
  getDispatchState: async (): Promise<ContainerCallResult> => ({ kind: 'unreachable', detail: 'test' }),
}

describe('authoritative reconcile frame', () => {
  test('terminal reconcile is final and exact-id; unknown stays non-final', () => {
    const completed = buildTurnDispatchReconcileFrame({
      sessionId: 'sess-0001',
      clientMessageId: 'cm-1',
      reconcile: 'turn_completed',
    })
    assert.equal(completed.isFinal, true)
    assert.equal(completed.clientMessageId, 'cm-1')
    assert.deepEqual(completed.meta, {
      reconcile: 'turn_completed',
      clientMessageId: 'cm-1',
    })

    const unknown = buildTurnDispatchReconcileFrame({
      sessionId: 'sess-0001',
      clientMessageId: 'cm-1',
    })
    assert.equal(unknown.isFinal, false)
    assert.deepEqual(unknown.meta, {
      reconcile: 'turn_state_unknown',
      clientMessageId: 'cm-1',
    })
  })
})

describe('resolveDispatchStuckThresholdMs', () => {
  test('floor = max(codexMax*2, 90min); env only raises', () => {
    assert.equal(resolveDispatchStuckThresholdMs(undefined, 600_000), DEFAULT_ACCEPTED_STUCK_FLOOR_MS)
    // codexMax*2 = 4h > 90min → floor 4h
    assert.equal(resolveDispatchStuckThresholdMs(undefined, 7_200_000), 14_400_000)
    // env below floor ignored
    assert.equal(resolveDispatchStuckThresholdMs(1000, 600_000), DEFAULT_ACCEPTED_STUCK_FLOOR_MS)
    // env above floor honored, capped at 24h
    assert.equal(resolveDispatchStuckThresholdMs(String(3 * 3_600_000), 600_000), 3 * 3_600_000)
    assert.equal(resolveDispatchStuckThresholdMs(String(999 * 3_600_000), 600_000), MAX_ACCEPTED_STUCK_MS)
  })
})

describe('⓪ session-gone auto close(2026-07-18 e2e 残留 accepted 恒卡实证)', () => {
  test('会话亡的 open dispatch → manual(session_deleted)+机器 resolution;零告警零容器求证', async () => {
    const pool = makeFakePool({
      openSessionGone: [rawRow({ status: 'accepted', outcome: null, failure_code: null })],
    })
    const alerts: unknown[] = []
    let containerCalls = 0
    const counts = await runReconcileTick({
      pool: pool as unknown as Pool,
      container: {
        rejectIfAbsent: async (): Promise<ContainerCallResult> => {
          containerCalls++
          return { kind: 'unreachable', detail: 'test' }
        },
        getDispatchState: async (): Promise<ContainerCallResult> => {
          containerCalls++
          return { kind: 'unreachable', detail: 'test' }
        },
      },
      enqueueAlert: (e) => alerts.push(e),
    })
    assert.equal(counts.sessionGoneClosed, 1)
    assert.equal(alerts.length, 0)
    assert.equal(containerCalls, 0)
    assert.ok(pool.writes.some((w) => w.includes("status = 'manual_reconcile'") && w.includes('conflict_reason')))
    assert.ok(pool.writes.some((w) => w.includes('SET resolution =')))
  })
})

describe('terminal-unnotified branch (financial safety)', () => {
  test('not billed → durable client_notified status, no manual_reconcile or shadow content write', async () => {
    const pool = makeFakePool({ terminalUnnotified: [rawRow()] })
    const alerts: unknown[] = []
    const counts = await runReconcileTick({
      pool: pool as unknown as Pool,
      container: noContainer,
      enqueueAlert: (e) => alerts.push(e),
      assessBilling: async () => 'not_billed',
    })
    assert.equal(counts.visibleFailures, 1)
    assert.equal(counts.notified, 1)
    assert.equal(counts.manualReconcile, 0)
    assert.ok(pool.writes.some((w) => w.includes('client_notified = TRUE')))
    assert.ok(pool.writes.some((w) =>
      w.includes('history_revision = history_revision + 1') &&
      w.includes('timeline_generation = timeline_generation + 1')))
    assert.ok(!pool.writes.some((w) => w.includes('turn_dispatch_error_projections')))
    assert.ok(!pool.writes.some((w) => w.includes("status = 'manual_reconcile'")))
    assert.equal(alerts.length, 0)
  })

  test('billed evidence → manual_reconcile + critical alert, never exposes "not billed"', async () => {
    const pool = makeFakePool({ terminalUnnotified: [rawRow()] })
    const alerts: Array<{ severity?: string }> = []
    const counts = await runReconcileTick({
      pool: pool as unknown as Pool,
      container: noContainer,
      enqueueAlert: (e) => alerts.push(e as { severity?: string }),
      assessBilling: async () => 'billed',
    })
    assert.equal(counts.manualReconcile, 1)
    assert.equal(counts.visibleFailures, 0)
    assert.equal(counts.notified, 0)
    assert.ok(pool.writes.some((w) => w.includes("status = 'manual_reconcile'")))
    assert.ok(!pool.writes.some((w) => w.includes('client_notified = TRUE')))
    assert.equal(alerts.length, 1)
    assert.equal(alerts[0]!.severity, 'critical')
  })

  test('assessBilling throw → no user-facing write (retry next tick)', async () => {
    const pool = makeFakePool({ terminalUnnotified: [rawRow()] })
    const counts = await runReconcileTick({
      pool: pool as unknown as Pool,
      container: noContainer,
      assessBilling: async () => { throw new Error('db blip') },
    })
    assert.equal(counts.visibleFailures, 0)
    assert.equal(counts.notified, 0)
    assert.equal(counts.manualReconcile, 0)
    assert.ok(!pool.writes.some((w) => w.includes('client_notified = TRUE')))
  })
})

describe('B-R1-1: not_accepted → abort pre-forward journal → durable visible status', () => {
  // 故障注入:accepted→(容器 rejected)→terminal(not_accepted),但 bridge attach 前写的
  // pre-forward inflight journal 仍在(state='inflight' 无 usage)。旧实现里 assessDispatchBilling
  // 把它当 billed → 全进 manual、用户看不到终态、违反 I1。修复后:③ 分支先在同一 tx 内 CAS 该
  // journal 为永久 no-execution waiver aborted,assess 遂得 not_billed → 直接状态可见。
  // 用**真实** assessDispatchBilling(不注入),让 journal 状态随 abort UPDATE 真转移。
  function makeBillingFakePool(opts: { hasUsage?: boolean } = {}) {
    const writes: string[] = []
    let journalAborted = false
    let releasedReservation: { userId: string; requestId: string } | null = null
    const route = (sql: string) => {
      const s = sql.replace(/\s+/g, ' ')
      if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [], rowCount: 0 }
      if (s.includes('FROM turn_dispatches') && s.includes('FOR UPDATE')) {
        return { rows: [rawRow({ outcome: 'not_accepted', failure_code: 'DISPATCH_NOT_ACCEPTED' })], rowCount: 1 }
      }
      // B-R1-1 abort:按 dispatch_id 把 inflight journal 置永久 waiver aborted(no-usage 守卫内嵌)。
      if (s.startsWith('UPDATE request_finalize_journal') && s.includes("state='aborted'") && s.includes('dispatch_id')) {
        writes.push(s)
        // no-usage 守卫命中(hasUsage=false)才 abort;有 usage 则 WHERE 不命中 → 0 行。
        if (opts.hasUsage) return { rows: [], rowCount: 0 }
        journalAborted = true
        return { rows: [{ user_id: '42', request_id: 'br-1' }], rowCount: 1 }
      }
      // assess:usage_records 计数。
      if (s.includes('FROM usage_records')) {
        return { rows: [{ n: opts.hasUsage ? '1' : '0' }], rowCount: 1 }
      }
      // assess:journal 现态 —— abort 后返回永久 waiver aborted,否则 inflight(never-executed)。
      if (s.includes('FROM request_finalize_journal')) {
        const state = journalAborted ? 'aborted' : 'inflight'
        const error_msg = journalAborted ? `${PERMANENT_CODEX_WAIVER_PREFIX}dispatch_never_executed` : null
        return { rows: [{ state, error_msg }], rowCount: 1 }
      }
      if (s.startsWith('UPDATE') || s.startsWith('INSERT')) {
        writes.push(s)
        if (s.includes('client_notified = TRUE')) return { rows: [], rowCount: 1 }
        if (s.includes("status = 'manual_reconcile'")) return { rows: [rawRow({ status: 'manual_reconcile', conflict_reason: 'x' })], rowCount: 1 }
        return { rows: [], rowCount: 1 }
      }
      if (s.includes("status = 'terminal'") && s.includes('client_notified = FALSE')) {
        return { rows: [rawRow({ outcome: 'not_accepted' })], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }
    return {
      pool: {
        async query(sql: string) { return route(sql) },
        async connect() { return { async query(sql: string) { return route(sql) }, release() {} } },
      },
      writes,
      get journalAborted() { return journalAborted },
      get releasedReservation() { return releasedReservation },
      setReleased(r: { userId: string; requestId: string }) { releasedReservation = r },
    }
  }

  test('inflight journal 存在 → journal aborted(永久 waiver) + status 可见 + 非 manual + 释放 reservation', async () => {
    const fake = makeBillingFakePool()
    const alerts: unknown[] = []
    const counts = await runReconcileTick({
      pool: fake.pool as unknown as Pool,
      container: noContainer,
      enqueueAlert: (e) => alerts.push(e),
      releaseReservation: async (ref) => { fake.setReleased(ref) },
    })
    // journal 被 CAS 为永久 no-execution waiver aborted。
    assert.ok(fake.journalAborted, 'pre-forward inflight journal 应被 abort 为永久 waiver')
    const abortWrite = fake.writes.find((w) => w.startsWith('UPDATE request_finalize_journal') && w.includes("state='aborted'"))
    assert.ok(abortWrite, 'abort UPDATE 应按 dispatch_id 发出')
    // 财务判定 not_billed → durable status(免单 tone),非 manual。
    assert.equal(counts.visibleFailures, 1)
    assert.equal(counts.notified, 1)
    assert.equal(counts.manualReconcile, 0)
    assert.ok(fake.writes.some((w) => w.includes('client_notified = TRUE')))
    assert.ok(!fake.writes.some((w) => w.includes('turn_dispatch_error_projections')))
    assert.ok(!fake.writes.some((w) => w.includes("status = 'manual_reconcile'")))
    assert.equal(alerts.length, 0)
    // reservation 提前释放(best-effort)。
    assert.deepEqual(fake.releasedReservation, { userId: '42', requestId: 'br-1' })
  })

  test('not_accepted 但竟有 usage(no-usage 守卫不命中)→ 不 abort → billed → manual(钱安全)', async () => {
    const fake = makeBillingFakePool({ hasUsage: true })
    const alerts: Array<{ severity?: string }> = []
    const counts = await runReconcileTick({
      pool: fake.pool as unknown as Pool,
      container: noContainer,
      enqueueAlert: (e) => alerts.push(e as { severity?: string }),
    })
    assert.equal(fake.journalAborted, false, 'no-usage 守卫不命中时绝不 abort journal')
    assert.equal(counts.manualReconcile, 1)
    assert.equal(counts.visibleFailures, 0)
    assert.ok(fake.writes.some((w) => w.includes("status = 'manual_reconcile'")))
    assert.ok(!fake.writes.some((w) => w.includes('client_notified = TRUE')))
    assert.equal(alerts[0]?.severity, 'critical')
  })
})

describe('rejecting resolution', () => {
  test('container rejected tombstone → terminal(not_accepted)', async () => {
    const pool = makeFakePool({ rejecting: [rawRow({ status: 'rejecting', lease_until: null })] })
    const container = {
      ...noContainer,
      rejectIfAbsent: async (): Promise<ContainerCallResult> => ({ kind: 'ok', state: 'rejected' }),
    }
    const counts = await runReconcileTick({ pool: pool as unknown as Pool, container })
    assert.equal(counts.rejectedTerminal, 1)
    assert.ok(pool.writes.some((w) => w.includes("status = 'terminal'") && w.includes("outcome = $2")))
  })

  test('container has running row → accepted (not terminal)', async () => {
    const pool = makeFakePool({ rejecting: [rawRow({ status: 'rejecting', lease_until: null })] })
    const container = {
      ...noContainer,
      rejectIfAbsent: async (): Promise<ContainerCallResult> => ({ kind: 'ok', state: 'running' }),
    }
    const counts = await runReconcileTick({ pool: pool as unknown as Pool, container })
    assert.equal(counts.accepted, 1)
    assert.equal(counts.rejectedTerminal, 0)
  })

  test('container unreachable → no terminal, no accepted (retry, never infer)', async () => {
    const pool = makeFakePool({ rejecting: [rawRow({ status: 'rejecting', lease_until: null, admitted_at: new Date() })] })
    const counts = await runReconcileTick({ pool: pool as unknown as Pool, container: noContainer })
    assert.equal(counts.rejectedTerminal, 0)
    assert.equal(counts.accepted, 0)
  })
})

describe('accepted-stuck branch (B2: container rejected tombstone)', () => {
  test('accepted dispatch whose container inbox is rejected → terminal(not_accepted)', async () => {
    const pool = makeFakePool({
      acceptedStuck: [rawRow({ status: 'accepted', accepted_at: new Date(Date.now() - 3 * 3_600_000) })],
    })
    const container = {
      ...noContainer,
      getDispatchState: async (): Promise<ContainerCallResult> => ({ kind: 'ok', state: 'rejected' }),
    }
    const counts = await runReconcileTick({ pool: pool as unknown as Pool, container })
    assert.equal(counts.rejectedTerminal, 1)
    // CAS terminal(not_accepted) from ['accepted'] 的 UPDATE 落地。
    assert.ok(pool.writes.some((w) => w.includes("status = 'terminal'") && w.includes("outcome = $2")))
  })

  test('accepted 容器求证持续失败 >15min → accepted_unreachable 告警(不再静默 continue)', async () => {
    // 2026-07-18 SSRF 网段错配把求证 100% 拦死,原实现静默 continue,收敛链瘫痪 27h
    // 无告警(唯一兜底 7d open_aged)。契约:持续不可达必须走 alertWarn 出口,但不动状态。
    const alerts: Array<{ payload?: { kind?: string }; dedupe_all_statuses?: boolean }> = []
    const pool = makeFakePool({
      acceptedStuck: [rawRow({ status: 'accepted', accepted_at: new Date(Date.now() - 3 * 3_600_000) })],
    })
    const counts = await runReconcileTick({
      pool: pool as unknown as Pool,
      container: noContainer, // getDispatchState 恒 unreachable
      enqueueAlert: (event) => alerts.push(event as {
        payload?: { kind?: string }
        dedupe_all_statuses?: boolean
      }),
    })
    assert.ok(counts.alerts >= 1, '持续不可达必须计入告警')
    assert.ok(
      alerts.some((a) => a.payload?.kind === 'accepted_unreachable'),
      'accepted_unreachable 告警必须入队',
    )
    assert.equal(
      alerts.find((a) => a.payload?.kind === 'accepted_unreachable')?.dedupe_all_statuses,
      true,
      '按日 key 必须跨 sent 状态去重,避免每个 reconciler tick 重发',
    )
    assert.equal(counts.rejectedTerminal, 0, '不可达绝不推断终态')
    assert.equal(counts.manualReconcile, 0)
    assert.ok(!pool.writes.some((w) => w.includes("status = 'terminal'")), '不动 dispatch 状态')
    // All accepted rows are now probed so a durable typed interruption is
    // visible on the next tick instead of waiting 15/90 minutes.
    assert.equal(pool.acceptedScanCutoffs.length >= 1, true, 'accepted 扫描必须带时间参数')
    const cutoffAge = Date.now() - pool.acceptedScanCutoffs[0]!.getTime()
    assert.ok(
      cutoffAge >= 0 && cutoffAge < 5_000,
      `扫描下限必须≈当前时刻(实际 ${cutoffAge}ms)`,
    )
  })

  test('accepted 求证失败但龄 <15min → 不告警(等下轮,避免抖动噪音)', async () => {
    const alerts: Array<{ payload?: { kind?: string } }> = []
    const pool = makeFakePool({
      acceptedStuck: [rawRow({ status: 'accepted', accepted_at: new Date(Date.now() - 5 * 60_000) })],
    })
    await runReconcileTick({
      pool: pool as unknown as Pool,
      container: noContainer,
      enqueueAlert: (event) => alerts.push(event as { payload?: { kind?: string } }),
    })
    assert.ok(
      !alerts.some((a) => a.payload?.kind === 'accepted_unreachable'),
      '15min 内的瞬时不可达不告警',
    )
  })

  test('young accepted + durable rejected tombstone → immediate not_accepted convergence', async () => {
    // rejected is an irreversible container tombstone, not an absence guess;
    // it must bypass the generic 90-minute age gate.
    const pool = makeFakePool({
      acceptedStuck: [rawRow({ status: 'accepted', accepted_at: new Date(Date.now() - 5_000) })],
    })
    const counts = await runReconcileTick({
      pool: pool as unknown as Pool,
      container: {
        ...noContainer,
        getDispatchState: async (): Promise<ContainerCallResult> => ({ kind: 'ok', state: 'rejected' }),
      },
    })
    assert.equal(counts.rejectedTerminal, 1, '明确 negative proof 要立即收敛')
    assert.equal(counts.manualReconcile, 0)
    assert.ok(pool.writes.some((w) => w.includes("status = 'terminal'")), '写 not_accepted 终态')
  })

  test('accepted dispatch still running → no terminal (keep waiting)', async () => {
    const pool = makeFakePool({
      acceptedStuck: [rawRow({ status: 'accepted', accepted_at: new Date(Date.now() - 3 * 3_600_000) })],
    })
    const container = {
      ...noContainer,
      getDispatchState: async (): Promise<ContainerCallResult> => ({ kind: 'ok', state: 'running' }),
    }
    const counts = await runReconcileTick({ pool: pool as unknown as Pool, container })
    assert.equal(counts.rejectedTerminal, 0)
    assert.equal(counts.manualReconcile, 0)
  })

  test('container typed crash becomes a direct status without fabricating Agent tape', async () => {
    const pool = makeFakePool({
      acceptedStuck: [rawRow({ status: 'accepted', accepted_at: new Date() })],
    })
    let nudged = 0
    const counts = await runReconcileTick({
      pool: pool as unknown as Pool,
      container: {
        ...noContainer,
        getDispatchState: async (): Promise<ContainerCallResult> => ({
          kind: 'ok', state: 'terminal', outcome: 'crashed',
        }),
      },
      nudgeClient: () => { nudged++ },
    })
    assert.equal(counts.visibleFailures, 1)
    assert.equal(counts.notified, 1)
    assert.equal(nudged, 1)
    assert.ok(pool.writes.some((w) =>
      w.includes("status = 'terminal'") && w.includes('failure_code = $3')))
    assert.ok(pool.writeParams.some((p) => p[2] === 'RESULT_RECOVERY_PENDING'))
    assert.ok(!pool.writeParams.some((p) => p[2] === 'SERVICE_RESTART'))
    assert.ok(pool.writes.some((w) =>
      w.includes('history_revision = history_revision + 1') &&
      w.includes('timeline_generation = timeline_generation + 1')))
  })
})

describe('assessDispatchBilling (B8: 零计费证明收紧)', () => {
  // 按 dispatch_id 联查 usage_records + request_finalize_journal 的假 queryable。
  function q(usageCount: number, journal: Array<{ state: string; error_msg: string | null }>) {
    return {
      async query(sql: string) {
        const s = sql.replace(/\s+/g, ' ')
        if (s.includes('FROM usage_records')) return { rows: [{ n: String(usageCount) }], rowCount: 1 }
        if (s.includes('FROM request_finalize_journal')) return { rows: journal, rowCount: journal.length }
        return { rows: [], rowCount: 0 }
      },
    }
  }

  test('usage row exists → billed', async () => {
    assert.equal(await assessDispatchBilling(q(1, []) as unknown as Pool, 'd'), 'billed')
  })

  test('no usage, no journal → not_billed', async () => {
    assert.equal(await assessDispatchBilling(q(0, []) as unknown as Pool, 'd'), 'not_billed')
  })

  test('non-aborted journal (inflight) → billed', async () => {
    assert.equal(
      await assessDispatchBilling(q(0, [{ state: 'inflight', error_msg: null }]) as unknown as Pool, 'd'),
      'billed',
    )
  })

  test('aborted WITHOUT permanent waiver → billed (歧义,走 manual,绝不写"未计费")', async () => {
    // 非永久 abort = 结算瞬态失败(可重开),不是零计费证明。
    assert.equal(
      await assessDispatchBilling(
        q(0, [{ state: 'aborted', error_msg: 'codex_settlement_failed_before_commit' }]) as unknown as Pool,
        'd',
      ),
      'billed',
    )
  })

  test('aborted WITH permanent waiver → not_billed (proven no-usage)', async () => {
    assert.equal(
      await assessDispatchBilling(
        q(0, [{ state: 'aborted', error_msg: permanentCodexWaiverReason('bridge_disconnect') }]) as unknown as Pool,
        'd',
      ),
      'not_billed',
    )
  })
})

describe('carrier-death fast path (accepted)', () => {
  test('有进程退出证据时,探测窗内 container rejected → 立即 terminal', async () => {
    const pool = makeFakePool({
      acceptedStuck: [rawRow({ status: 'accepted', accepted_at: new Date(Date.now() - 20 * 60_000) })],
    })
    const counts = await runReconcileTick({
      pool: pool as unknown as Pool,
      container: {
        ...noContainer,
        getDispatchState: async (): Promise<ContainerCallResult> => ({ kind: 'ok', state: 'rejected' }),
      },
      listCarrierDeadDispatchIds: async () => ['d-1'],
    })
    assert.equal(counts.rejectedTerminal, 1)
  })

  test('有进程退出证据但容器仍 running → 不终态(不误杀活引擎)', async () => {
    const pool = makeFakePool({
      acceptedStuck: [rawRow({ status: 'accepted', accepted_at: new Date(Date.now() - 20 * 60_000) })],
    })
    const counts = await runReconcileTick({
      pool: pool as unknown as Pool,
      container: {
        ...noContainer,
        getDispatchState: async (): Promise<ContainerCallResult> => ({ kind: 'ok', state: 'running' }),
      },
      listCarrierDeadDispatchIds: async () => ['d-1'],
    })
    assert.equal(counts.rejectedTerminal, 0)
    assert.equal(counts.manualReconcile, 0)
    assert.ok(!pool.writes.some((w) => w.includes("status = 'terminal'")))
  })

  test('accepted + 停机证据 + 容器不可达 → 保留证据、等下轮、不写 SERVICE_RESTART', async () => {
    const pool = makeFakePool({
      acceptedStuck: [rawRow({
        status: 'accepted',
        accepted_at: new Date(),
        shutdown_ctx: { gatewayExitedAt: '2026-08-20T00:00:00.000Z' },
      })],
    })
    const counts = await runReconcileTick({
      pool: pool as unknown as Pool,
      container: noContainer,
    })
    assert.equal(counts.visibleFailures, 0)
    assert.equal(counts.rejectedTerminal, 0)
    assert.equal(counts.manualReconcile, 0)
    assert.ok(!pool.writes.some((w) => w.includes("status = 'terminal'")))
    assert.ok(!pool.writeParams.some((p) => p[2] === 'SERVICE_RESTART'))
    assert.ok(!pool.writes.some((w) => w.includes('shutdown_ctx -')), '不可达不得清停机证据')
  })

  test('accepted + 停机证据 + 容器 error 探测 → 同样不收口、保留证据', async () => {
    const pool = makeFakePool({
      acceptedStuck: [rawRow({
        status: 'accepted',
        accepted_at: new Date(),
        shutdown_ctx: { gatewayExitedAt: '2026-08-20T00:00:00.000Z' },
      })],
    })
    const counts = await runReconcileTick({
      pool: pool as unknown as Pool,
      container: {
        ...noContainer,
        getDispatchState: async (): Promise<ContainerCallResult> => ({ kind: 'error', detail: '502' }),
      },
    })
    assert.equal(counts.visibleFailures, 0)
    assert.ok(!pool.writeParams.some((p) => p[2] === 'SERVICE_RESTART'))
    assert.ok(!pool.writes.some((w) => w.includes('shutdown_ctx -')))
  })

  test('accepted + 停机证据 + 容器 absent → 收口成 SERVICE_RESTART', async () => {
    const pool = makeFakePool({
      acceptedStuck: [rawRow({
        status: 'accepted',
        accepted_at: new Date(),
        shutdown_ctx: { gatewayExitedAt: '2026-08-20T00:00:00.000Z' },
      })],
    })
    const counts = await runReconcileTick({
      pool: pool as unknown as Pool,
      container: {
        ...noContainer,
        getDispatchState: async (): Promise<ContainerCallResult> => ({ kind: 'ok', state: 'absent' }),
      },
    })
    assert.equal(counts.visibleFailures, 1)
    assert.equal(counts.rejectedTerminal, 0)
    assert.ok(pool.writeParams.some((p) => p[1] === 'executed_error' && p[2] === 'SERVICE_RESTART'))
    assert.ok(!pool.writeParams.some((p) => p[1] === 'not_accepted' || p[2] === 'DISPATCH_NOT_ACCEPTED'))
    assert.ok(!pool.writeParams.some((p) => p[2] === 'RESULT_RECOVERY_PENDING'))
  })

  test('terminal+crashed 且无停机证据 → 不写 SERVICE_RESTART', async () => {
    const pool = makeFakePool({
      acceptedStuck: [rawRow({ status: 'accepted', accepted_at: new Date() })],
    })
    const counts = await runReconcileTick({
      pool: pool as unknown as Pool,
      container: {
        ...noContainer,
        getDispatchState: async (): Promise<ContainerCallResult> => ({
          kind: 'ok',
          state: 'terminal',
          outcome: 'crashed',
        }),
      },
    })
    assert.equal(counts.visibleFailures, 1)
    assert.ok(pool.writeParams.some((p) => p[1] === 'executed_error' && p[2] === 'RESULT_RECOVERY_PENDING'))
    assert.ok(!pool.writeParams.some((p) => p[2] === 'SERVICE_RESTART'))
  })

  test('terminal+crashed 且有 shutdown_ctx → 收口成 SERVICE_RESTART', async () => {
    const pool = makeFakePool({
      acceptedStuck: [rawRow({
        status: 'accepted',
        accepted_at: new Date(),
        shutdown_ctx: { gatewayExitedAt: '2026-08-20T00:00:00.000Z' },
      })],
    })
    const counts = await runReconcileTick({
      pool: pool as unknown as Pool,
      container: {
        ...noContainer,
        getDispatchState: async (): Promise<ContainerCallResult> => ({
          kind: 'ok',
          state: 'terminal',
          outcome: 'crashed',
        }),
      },
    })
    assert.equal(counts.visibleFailures, 1)
    assert.ok(pool.writeParams.some((p) => p[1] === 'executed_error' && p[2] === 'SERVICE_RESTART'))
    assert.ok(!pool.writeParams.some((p) => p[2] === 'RESULT_RECOVERY_PENDING'))
  })

  test('recovery_pending 且无停机证据 → 不写 SERVICE_RESTART', async () => {
    const pool = makeFakePool({
      acceptedStuck: [rawRow({ status: 'accepted', accepted_at: new Date() })],
    })
    const counts = await runReconcileTick({
      pool: pool as unknown as Pool,
      container: {
        ...noContainer,
        getDispatchState: async (): Promise<ContainerCallResult> => ({
          kind: 'ok',
          state: 'recovery_pending',
        }),
      },
    })
    assert.equal(counts.visibleFailures, 0)
    assert.equal(counts.rejectedTerminal, 0)
    assert.equal(counts.manualReconcile, 0)
    assert.ok(!pool.writes.some((w) => w.includes("status = 'terminal'")))
    assert.ok(!pool.writeParams.some((p) => p[2] === 'SERVICE_RESTART'))
    assert.ok(!pool.writeParams.some((p) => p[2] === 'RESULT_RECOVERY_PENDING'))
  })

  test('recovery_pending 且有 shutdown_ctx → 收口成 SERVICE_RESTART', async () => {
    const pool = makeFakePool({
      acceptedStuck: [rawRow({
        status: 'accepted',
        accepted_at: new Date(),
        shutdown_ctx: { gatewayExitedAt: '2026-08-20T00:00:00.000Z' },
      })],
    })
    const counts = await runReconcileTick({
      pool: pool as unknown as Pool,
      container: {
        ...noContainer,
        getDispatchState: async (): Promise<ContainerCallResult> => ({
          kind: 'ok',
          state: 'recovery_pending',
        }),
      },
    })
    assert.equal(counts.visibleFailures, 1)
    assert.equal(counts.rejectedTerminal, 0)
    assert.ok(pool.writeParams.some((p) => p[1] === 'executed_error' && p[2] === 'SERVICE_RESTART'))
    assert.ok(!pool.writeParams.some((p) => p[2] === 'RESULT_RECOVERY_PENDING'))
  })

  test('accepted + 停机证据 + 容器 running → 不动', async () => {
    const pool = makeFakePool({
      acceptedStuck: [rawRow({ status: 'accepted', accepted_at: new Date() })],
    })
    const counts = await runReconcileTick({
      pool: pool as unknown as Pool,
      container: {
        ...noContainer,
        getDispatchState: async (): Promise<ContainerCallResult> => ({ kind: 'ok', state: 'running' }),
      },
      listCarrierDeadDispatchIds: async () => ['d-1'],
    })
    assert.equal(counts.visibleFailures, 0)
    assert.equal(counts.rejectedTerminal, 0)
    assert.equal(counts.manualReconcile, 0)
    assert.ok(!pool.writes.some((w) => w.includes("status = 'terminal'")))
    assert.ok(!pool.writeParams.some((p) => p[2] === 'SERVICE_RESTART'))
  })

  test('幼龄 admitted + 租约过期 + 进程退出证据 → 进入 reject-if-absent', async () => {
    const pool = makeFakePool({
      admittedLeaseExpired: [rawRow({
        status: 'admitted',
        outcome: null,
        failure_code: null,
        admitted_at: new Date(Date.now() - 30_000),
        lease_until: new Date(Date.now() - 1_000),
      })],
    })
    const counts = await runReconcileTick({
      pool: pool as unknown as Pool,
      container: {
        ...noContainer,
        rejectIfAbsent: async (): Promise<ContainerCallResult> => ({ kind: 'ok', state: 'rejected' }),
      },
      listCarrierDeadDispatchIds: async () => ['d-1'],
    })
    assert.equal(counts.rejectedTerminal, 1)
  })

  test('幼龄 admitted + 租约过期但无进程退出证据 → 仍走 5min 门,不接管', async () => {
    const pool = makeFakePool({
      admittedLeaseExpired: [rawRow({
        status: 'admitted',
        outcome: null,
        failure_code: null,
        admitted_at: new Date(Date.now() - 30_000),
        lease_until: new Date(Date.now() - 1_000),
      })],
    })
    const counts = await runReconcileTick({
      pool: pool as unknown as Pool,
      container: {
        ...noContainer,
        rejectIfAbsent: async (): Promise<ContainerCallResult> => ({ kind: 'ok', state: 'rejected' }),
      },
    })
    assert.equal(counts.rejectedTerminal, 0)
    assert.ok(!pool.writes.some((w) => w.includes("status = 'rejecting'") || w.includes("status = 'terminal'")))
  })
})

describe('runShutdownDispatchHandoff', () => {
  test('先落证据再求证;容器 running 不 finalize', async () => {
    const pool = makeFakePool({
      acceptedStuck: [rawRow({ status: 'accepted', accepted_at: new Date() })],
    })
    let marked = 0
    let expired = 0
    const out = await runShutdownDispatchHandoff({
      pool: pool as unknown as Pool,
      container: {
        ...noContainer,
        getDispatchState: async (): Promise<ContainerCallResult> => ({ kind: 'ok', state: 'running' }),
      },
      markJournals: async () => {
        marked = 3
        return 3
      },
      expireLeases: async () => {
        expired = 2
        return 2
      },
      listCarrierDeadDispatchIds: async () => ['d-1'],
      budgetMs: 2_000,
    })
    assert.equal(out.markedJournals, 3)
    assert.equal(out.expiredLeases, 2)
    assert.equal(out.timedOut, false)
    assert.equal(out.probed, true)
    assert.equal(out.tick?.rejectedTerminal ?? 0, 0)
    assert.equal(marked, 3)
    assert.equal(expired, 2)
  })

  test('停机探测超时/不可达但容器仍 running → 不终态化', async () => {
    const pool = makeFakePool({
      acceptedStuck: [rawRow({
        status: 'accepted',
        accepted_at: new Date(),
        shutdown_ctx: { gatewayExitedAt: '2026-08-20T00:00:00.000Z' },
      })],
    })
    const out = await runShutdownDispatchHandoff({
      pool: pool as unknown as Pool,
      container: {
        ...noContainer,
        getDispatchState: async (): Promise<ContainerCallResult> => ({
          kind: 'unreachable',
          detail: 'shutdown_budget',
        }),
      },
      markJournals: async () => 1,
      expireLeases: async () => 0,
      budgetMs: 2_000,
    })
    assert.equal(out.timedOut, false)
    assert.equal(out.probed, true)
    assert.equal(out.tick?.visibleFailures ?? 0, 0)
    assert.equal(out.tick?.rejectedTerminal ?? 0, 0)
    assert.ok(!pool.writeParams.some((p) => p[2] === 'SERVICE_RESTART'))
    assert.ok(!pool.writes.some((w) => w.includes("status = 'terminal'")))
    assert.ok(!pool.writes.some((w) => w.includes('shutdown_ctx -')), '超时不可达须保留停机证据')

    const follow = await runReconcileTick({
      pool: pool as unknown as Pool,
      container: {
        ...noContainer,
        getDispatchState: async (): Promise<ContainerCallResult> => ({ kind: 'ok', state: 'running' }),
      },
      listCarrierDeadDispatchIds: async () => ['d-1'],
    })
    assert.equal(follow.visibleFailures, 0)
    assert.equal(follow.rejectedTerminal, 0)
    assert.ok(!pool.writeParams.some((p) => p[2] === 'SERVICE_RESTART'))
    assert.ok(!pool.writes.some((w) => w.includes("status = 'terminal'")))
  })

  test('预算耗尽时仍返回已落的证据,不把 shutdown 拖死', async () => {
    const pool = makeFakePool({
      acceptedStuck: [rawRow({ status: 'accepted', accepted_at: new Date() })],
    })
    const started = Date.now()
    const out = await runShutdownDispatchHandoff({
      pool: pool as unknown as Pool,
      container: {
        rejectIfAbsent: () => new Promise(() => { /* hang */ }),
        getDispatchState: () => new Promise(() => { /* hang */ }),
      },
      markJournals: async () => 1,
      expireLeases: async () => 1,
      listCarrierDeadDispatchIds: async () => ['d-1'],
      budgetMs: 80,
    })
    const elapsed = Date.now() - started
    assert.equal(out.markedJournals, 1)
    assert.equal(out.expiredLeases, 1)
    assert.equal(out.timedOut, true)
    assert.ok(elapsed < 1_500, `shutdown handoff exceeded budget: ${elapsed}ms`)
  })

  test('expireAdmittedLeasesOnShutdown 只动 admitted 且 lease 仍活的行', async () => {
    const writes: string[] = []
    const pool = {
      async query(sql: string) {
        writes.push(sql.replace(/\s+/g, ' '))
        return { rows: [], rowCount: 4 }
      },
    }
    const n = await expireAdmittedLeasesOnShutdown(pool as unknown as Pool, 1_700_000_000_000)
    assert.equal(n, 4)
    assert.match(writes[0]!, /status = 'admitted'/)
    assert.match(writes[0]!, /lease_until > \$1/)
  })

  test('markOpenDispatchShutdownEvidence 打 open 三态且不碰 lease', async () => {
    const writes: string[] = []
    const pool = {
      async query(sql: string) {
        writes.push(sql.replace(/\s+/g, ' '))
        return { rows: [], rowCount: 3 }
      },
    }
    const n = await markOpenDispatchShutdownEvidence(pool as unknown as Pool, {
      now: new Date('2026-08-20T00:00:00.000Z'),
      reason: 'process_shutdown',
    })
    assert.equal(n, 3)
    assert.match(writes[0]!, /status IN \('admitted','accepted','rejecting'\)/)
    assert.match(writes[0]!, /shutdown_ctx/)
    assert.doesNotMatch(writes[0]!, /lease_until/)
    assert.doesNotMatch(writes[0]!, /status = 'terminal'/)
  })
})

describe('loadGatewayExitDispatchIds — 按 dispatch_id 反查', () => {
  test('空候选不发查询', async () => {
    let calls = 0
    const pool = {
      async query() {
        calls++
        return { rows: [], rowCount: 0 }
      },
    }
    const ids = await loadGatewayExitDispatchIds(pool as unknown as Pool, [])
    assert.deepEqual(ids, [])
    assert.equal(calls, 0)
  })

  test('标记打在 request_id ≠ billing_request_id 的调用级 journal 上仍能命中', async () => {
    const sqls: string[] = []
    const params: unknown[][] = []
    const pool = {
      async query(sql: string, p?: unknown[]) {
        sqls.push(sql.replace(/\s+/g, ' '))
        params.push(p ?? [])
        // 模拟:该 dispatch 有多条 journal,标记在 call-level request_id 上,
        // 若误按 billing_request_id=br-not-marked 查 PK,这里不会被问到。
        return { rows: [{ dispatch_id: 'd-1' }], rowCount: 1 }
      },
    }
    const ids = await loadGatewayExitDispatchIds(pool as unknown as Pool, [
      { dispatchId: 'd-1' },
    ])
    assert.deepEqual(ids, ['d-1'])
    assert.match(sqls[0]!, /dispatch_id = ANY\(\$1::uuid\[\]\)/)
    assert.ok(!/request_id = ANY/.test(sqls[0]!), '按 billing/request_id 查会漏掉调用级标记')
    assert.deepEqual(params[0]![0], ['d-1'])
  })
})

describe('carrier-dead 语义:多 journal 且标记不在 billing_request_id 那一行', () => {
  test('20min accepted + 容器 rejected + 标记在 call-level journal → 立即 terminal', async () => {
    const pool = makeFakePool({
      acceptedStuck: [rawRow({
        status: 'accepted',
        accepted_at: new Date(Date.now() - 20 * 60_000),
        billing_request_id: 'br-not-the-marked-row',
      })],
    })
    const origQuery = pool.query.bind(pool)
    pool.query = async (sql: string, params?: unknown[]) => {
      const s = sql.replace(/\s+/g, ' ')
      if (s.includes('FROM request_finalize_journal') && s.includes('dispatch_id = ANY')) {
        return { rows: [{ dispatch_id: 'd-1' }], rowCount: 1 }
      }
      if (s.includes('FROM request_finalize_journal') && s.includes('request_id = ANY')) {
        return { rows: [], rowCount: 0 }
      }
      return origQuery(sql, params)
    }
    const counts = await runReconcileTick({
      pool: pool as unknown as Pool,
      container: {
        ...noContainer,
        getDispatchState: async (): Promise<ContainerCallResult> => ({ kind: 'ok', state: 'rejected' }),
      },
    })
    assert.equal(counts.rejectedTerminal, 1, '标记在 request_id≠billing_request_id 的行上必须仍能走快路径')
  })
})


describe('closeVisibleOrphans (rev2 B4)', () => {
  const PARTS_COMPLETE_QUIET_MS = 2 * 60_000
  const nowMs = 1_700_000_000_000

  function orphanRow(over: Partial<Raw> = {}): Raw {
    return {
      dispatch_id: 'd-vis-1',
      attempt_no: 1,
      user_id: '42',
      session_id: 'sess-vis',
      client_message_id: 'cm-vis',
      status: 'accepted',
      admitted_at: new Date(nowMs - 10 * 60_000),
      accepted_at: new Date(nowMs - 10 * 60_000),
      tape_visible_at: null,
      tape_part_count: null,
      tape_id: null,
      tape_parts_rows: '0',
      last_frame_at: new Date(nowMs - 10 * 60_000),
      first_visible_at: null,
      container_running: false,
      agent_container_id: null,
      runtime_kind: null,
      ...over,
    }
  }

  test('parts-complete quiet → Phase A only, no fallback projection', async () => {
    _resetVisibleOrphanScanOffset()
    const nudges: string[] = []
    const commits: string[] = []
    const pool = makeFakePool({
      visibleOrphans: [orphanRow({
        tape_id: 'tape-complete',
        tape_part_count: 12,
        tape_parts_rows: '12',
        last_frame_at: new Date(nowMs - PARTS_COMPLETE_QUIET_MS),
      })],
    })
    const counts = await runReconcileTick({
      pool: pool as unknown as Pool,
      container: noContainer,
      now: () => nowMs,
      listCarrierDeadDispatchIds: async () => [],
      commitVisibleTape: async (input) => {
        commits.push(input.tapeId)
      },
      nudgeClient: (_uid, _sid, _cmid, reconcile) => {
        if (reconcile) nudges.push(reconcile)
      },
    })
    assert.equal(counts.visibleOrphans, 1)
    assert.deepEqual(commits, ['tape-complete'])
    assert.ok(!pool.writes.some((sql) => sql.includes('visible-fallback') || sql.includes('visible_head')))
    assert.ok(!pool.writes.some((sql) => sql.includes("status = 'terminal'")))
    assert.deepEqual(nudges, ['turn_completed'])
  })

  test('Phase A failure keeps dispatch open, skips fallback, retries next tick', async () => {
    _resetVisibleOrphanScanOffset()
    let attempts = 0
    const pool = makeFakePool({
      visibleOrphans: [orphanRow({
        tape_id: 'tape-fail-a',
        tape_part_count: 3,
        tape_parts_rows: '3',
        last_frame_at: new Date(nowMs - PARTS_COMPLETE_QUIET_MS),
      })],
    })
    const deps = {
      pool: pool as unknown as Pool,
      container: noContainer,
      now: () => nowMs,
      listCarrierDeadDispatchIds: async () => [],
      commitVisibleTape: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('phase a failed')
      },
    }
    const first = await runReconcileTick(deps)
    assert.equal(first.visibleOrphans, 0)
    assert.equal(attempts, 1)
    assert.ok(!pool.writes.some((sql) => sql.includes('visible-fallback') || sql.includes('visible_head')))
    assert.ok(!pool.writes.some((sql) => sql.includes("status = 'terminal'")))
    assert.ok(!pool.writes.includes('COMMIT'))
    const second = await runReconcileTick(deps)
    assert.equal(second.visibleOrphans, 1)
    assert.equal(attempts, 2)
  })

  test('CAS miss rolls back so fallback projection does not commit', async () => {
    _resetVisibleOrphanScanOffset()
    const pool = makeFakePool({
      visibleOrphans: [orphanRow({
        tape_id: null,
        tape_part_count: null,
        tape_parts_rows: '0',
        last_frame_at: new Date(nowMs - 20 * 60_000),
        container_running: false,
      })],
      casToTerminalMiss: true,
    })
    const counts = await runReconcileTick({
      pool: pool as unknown as Pool,
      container: noContainer,
      now: () => nowMs,
      listCarrierDeadDispatchIds: async () => [],
    })
    assert.equal(counts.visibleOrphans, 0)
    assert.ok(pool.writes.includes('ROLLBACK'))
    assert.ok(!pool.writes.includes('COMMIT'))
    assert.ok(!pool.writes.some((sql) => sql.includes('visible-fallback') || sql.includes('visible_head')))
  })

  test("SQL prefetches turn_traces first_visible_at without LIKE or per-row subquery", async () => {
    _resetVisibleOrphanScanOffset()
    const pool = makeFakePool({
      visibleOrphans: [orphanRow({
        last_frame_at: new Date(nowMs),
        admitted_at: new Date(nowMs),
        accepted_at: new Date(nowMs),
        container_running: true,
      })],
    })
    await runReconcileTick({
      pool: pool as unknown as Pool,
      container: noContainer,
      now: () => nowMs,
      listCarrierDeadDispatchIds: async () => [],
    })
    const scan = pool.queries.find((query) => query.includes("-- closeVisibleOrphans") && !query.includes("lock"))
    const prefetch = pool.queries.find((query) => query.includes("-- firstVisiblePrefetch"))
    assert.ok(scan, "closeVisibleOrphans scan SQL must run")
    assert.ok(prefetch, "firstVisiblePrefetch SQL must run")
    assert.equal(scan.includes("turn_traces"), false, "scan must not correlate turn_traces")
    assert.equal(/LIKE/i.test(scan), false)
    assert.ok(prefetch.includes("turn_traces"), "prefetch must read turn_traces")
    assert.ok(prefetch.includes("first_visible_at"), "scan must select first_visible_at")
    assert.ok(prefetch.includes("dispatch_id IS NULL"), "prefetch includes NULL-dispatch fallback")
    assert.ok(prefetch.includes("session_key"), "prefetch matches session_key")
    assert.ok(prefetch.includes("UNION ALL"), "prefetch is one-shot UNION, not per-row subquery")
    assert.equal(/LIKE/i.test(prefetch), false, "prefetch must not use LIKE wildcards")
    assert.ok(prefetch.includes("unnest("), "NULL-dispatch arm binds this page's candidate pairs")
    assert.ok(prefetch.includes("right("), "NULL-dispatch arm uses exact suffix via right(), not LIKE")
    assert.ok(
      prefetch.includes("char_length(cand.session_id) + 1"),
      "suffix length is ':' + session_id, matching visibleOrphan endsWith",
    )
  })

  test("OCV5-43 hydrate-dead engine attempts interrupt fence even if CAS misses", async () => {
    _resetVisibleOrphanScanOffset()
    const pool = makeFakePool({
      visibleOrphans: [orphanRow({
        tape_id: null,
        tape_part_count: null,
        tape_parts_rows: "0",
        last_frame_at: null,
        first_visible_at: null,
        admitted_at: new Date(nowMs - 15 * 60_000),
        accepted_at: new Date(nowMs - 15 * 60_000),
        container_running: false,
      })],
      casToTerminalMiss: true,
    })
    const counts = await runReconcileTick({
      pool: pool as unknown as Pool,
      container: noContainer,
      now: () => nowMs,
      listCarrierDeadDispatchIds: async () => [],
    })
    assert.equal(counts.visibleOrphans, 0)
    assert.ok(pool.writes.includes("ROLLBACK"))
    assert.ok(!pool.writes.includes("COMMIT"))
    assert.ok(
      pool.attemptedWrites.some((sql) => sql.includes("producer_fenced_at")),
      "interrupt_tapeless must attempt producer fence",
    )
  })

  test("OCV5-57 first_visible plus zero dispatch frames skips and does not fence", async () => {
    _resetVisibleOrphanScanOffset()
    const pool = makeFakePool({
      visibleOrphans: [orphanRow({
        tape_id: null,
        tape_part_count: null,
        tape_parts_rows: "0",
        last_frame_at: null,
        first_visible_at: new Date(nowMs - 14 * 60_000),
        admitted_at: new Date(nowMs - 15 * 60_000),
        accepted_at: new Date(nowMs - 15 * 60_000),
        container_running: true,
      })],
    })
    const counts = await runReconcileTick({
      pool: pool as unknown as Pool,
      container: noContainer,
      now: () => nowMs,
      listCarrierDeadDispatchIds: async () => [],
    })
    assert.equal(counts.visibleOrphans, 0)
    assert.ok(!pool.writes.includes("COMMIT"))
    assert.ok(!pool.writes.some((sql) => sql.includes("producer_fenced_at")))
    assert.ok(!pool.writes.some((sql) => sql.includes("visible-fallback")))
  })

  test("interrupt fence COMMIT writes producer_fenced_at and terminal together", async () => {
    resetProducerFenceForTests()
    _resetVisibleOrphanScanOffset()
    const pool = makeFakePool({
      visibleOrphans: [orphanRow({
        tape_id: "tape-present",
        tape_part_count: 3,
        tape_parts_rows: "1",
        last_frame_at: null,
        first_visible_at: null,
        admitted_at: new Date(nowMs - 15 * 60_000),
        accepted_at: new Date(nowMs - 15 * 60_000),
        container_running: false,
      })],
    })
    const counts = await runReconcileTick({
      pool: pool as unknown as Pool,
      container: noContainer,
      now: () => nowMs,
      listCarrierDeadDispatchIds: async () => [],
    })
    assert.equal(counts.visibleOrphans, 1)
    assert.ok(pool.writes.includes("COMMIT"))
    assert.ok(pool.writes.some((sql) => sql.includes("producer_fenced_at")))
    assert.ok(pool.writes.some((sql) => sql.includes("status = 'terminal'")))
    assert.equal(
      pool.writes.indexOf("COMMIT") >
        Math.max(
          pool.writes.findIndex((sql) => sql.includes("producer_fenced_at")),
          pool.writes.findIndex((sql) => sql.includes("status = 'terminal'")),
        ),
      true,
    )
    assert.equal(isProducerFenced({
      dispatchId: "d-vis-1",
      sessionId: "sess-vis",
      clientMessageId: "cm-vis",
    }), true)
  })


  test("overlapping admits: late first_visible skips both A and B", async () => {
    _resetVisibleOrphanScanOffset()
    const pool = makeFakePool({
      visibleOrphans: [
        orphanRow({
          dispatch_id: "disp-a",
          last_frame_at: null,
          first_visible_at: new Date(nowMs - 12 * 60_000),
          admitted_at: new Date(nowMs - 15 * 60_000),
          accepted_at: new Date(nowMs - 15 * 60_000),
          container_running: true,
        }),
        orphanRow({
          dispatch_id: "disp-b",
          last_frame_at: null,
          first_visible_at: new Date(nowMs - 12 * 60_000),
          admitted_at: new Date(nowMs - 13 * 60_000),
          accepted_at: new Date(nowMs - 13 * 60_000),
          container_running: true,
        }),
      ],
    })
    const counts = await runReconcileTick({
      pool: pool as unknown as Pool,
      container: noContainer,
      now: () => nowMs,
      listCarrierDeadDispatchIds: async () => [],
    })
    assert.equal(counts.visibleOrphans, 0)
    assert.ok(!pool.writes.includes("COMMIT"))
  })

  test("session_id underscore does not steal a sibling NULL-dispatch first_visible", async () => {
    _resetVisibleOrphanScanOffset()
    const pool = makeFakePool({
      visibleOrphans: [orphanRow({
        dispatch_id: "disp-under",
        session_id: "sess_001",
        last_frame_at: null,
        first_visible_at: null,
        admitted_at: new Date(nowMs - 15 * 60_000),
        accepted_at: new Date(nowMs - 15 * 60_000),
        container_running: false,
      })],
      firstVisibleTraces: [{
        dispatch_id: null,
        user_id: "42",
        session_key: "agent:main:webchat:dm:sessX001",
        first_visible_at: new Date(nowMs - 12 * 60_000),
      }],
    })
    const counts = await runReconcileTick({
      pool: pool as unknown as Pool,
      container: noContainer,
      now: () => nowMs,
      listCarrierDeadDispatchIds: async () => [],
    })
    assert.ok(pool.queries.some(sql => sql.includes('-- orphanFinalizeFirstVisibleReverify')),
      'sibling trace was not credited: absent first_visible is rechecked inside the lock')
    assert.equal(counts.visibleOrphans, 1, "LIKE '_' must not credit sibling sessX001")
    assert.ok(pool.writes.some((sql) => sql.includes("producer_fenced_at")))
  })

  test("exact session_key suffix with underscore is still credited", async () => {
    _resetVisibleOrphanScanOffset()
    let probes = 0
    const pool = makeFakePool({
      visibleOrphans: [orphanRow({
        dispatch_id: "disp-under-hit",
        session_id: "sess_001",
        last_frame_at: null,
        first_visible_at: null,
        admitted_at: new Date(nowMs - 15 * 60_000),
        accepted_at: new Date(nowMs - 15 * 60_000),
        container_running: true,
      })],
      firstVisibleTraces: [{
        dispatch_id: null,
        user_id: "42",
        session_key: "agent:main:webchat:dm:sess_001",
        first_visible_at: new Date(nowMs - 12 * 60_000),
      }],
    })
    const counts = await runReconcileTick({
      pool: pool as unknown as Pool,
      container: { ...noContainer, getDispatchState: async () => { probes++; return { kind: 'unreachable', detail: 'unexpected probe after credited first_visible' } } },
      now: () => nowMs,
      listCarrierDeadDispatchIds: async () => [],
    })
    assert.equal(probes, 0, 'credited first_visible skips before any typed-state probe')
    assert.equal(counts.visibleOrphans, 0)
    assert.ok(!pool.writes.includes("COMMIT"))
  })

  // ── INC-20260831-VISIBLE-ORPHAN-FALSE-KILL 后续:两处缺口的回归锁 ──────────
  // gap1: typed state(running/queued/sink_staged)的存活结论必须传进 orphan 收口;
  // gap2: 扫描→提交之间帧/first_visible 推进必须使 finalize 回滚。

  test("INC-20260831 gap1: typed-state proven-live running dispatch is never interrupted (16min, zero frames)", async () => {
    _resetVisibleOrphanScanOffset()
    // 主循环 accepted-stuck 探测返回 running;同一 dispatch 出现在 orphan 扫描里,
    // 零帧 + 无 first_visible + 静默 16min + 容器在跑 —— 旧实现对这种行判 interrupt_tapeless。
    const pool = makeFakePool({
      acceptedStuck: [rawRow({
        dispatch_id: 'd-live-1',
        status: 'accepted',
        outcome: null,
        failure_code: null,
        admitted_at: new Date(nowMs - 16 * 60_000),
        accepted_at: new Date(nowMs - 16 * 60_000),
      })],
      visibleOrphans: [orphanRow({
        dispatch_id: 'd-live-1',
        tape_id: null,
        tape_part_count: null,
        tape_parts_rows: '0',
        last_frame_at: null,
        first_visible_at: null,
        admitted_at: new Date(nowMs - 16 * 60_000),
        accepted_at: new Date(nowMs - 16 * 60_000),
        container_running: true,
      })],
    })
    const counts = await runReconcileTick({
      pool: pool as unknown as Pool,
      container: {
        ...noContainer,
        getDispatchState: async (): Promise<ContainerCallResult> => ({ kind: 'ok', state: 'running' }),
      },
      now: () => nowMs,
      listCarrierDeadDispatchIds: async () => [],
    })
    assert.equal(counts.visibleOrphansSkippedLive, 1, 'proven-live 行必须计入 skipped-live')
    assert.equal(counts.visibleOrphans, 0)
    assert.ok(!pool.writes.includes('COMMIT'), '不得中断提交')
    assert.ok(!pool.writes.some((sql) => sql.includes('producer_fenced_at')), '不得 fence')
    assert.ok(!pool.writes.some((sql) => sql.includes("status = 'terminal'")), '不得写终态')
    assert.ok(!pool.writes.some((sql) => sql.includes('visible-fallback')), '不得投影 fallback')
  })

  test("INC-20260831 gap1: interrupt_tapeless outside the stuck page re-probes typed state; queued skips", async () => {
    _resetVisibleOrphanScanOffset()
    // orphan 扫描有自己的 OFFSET 分页且含 admitted 行:这行不在主循环 stuck 页里,
    // 分类为 interrupt_tapeless 后必须在提交前再查一次 typed state。
    let probes = 0
    const pool = makeFakePool({
      visibleOrphans: [orphanRow({
        tape_id: null,
        tape_part_count: null,
        tape_parts_rows: '0',
        last_frame_at: null,
        first_visible_at: null,
        admitted_at: new Date(nowMs - 16 * 60_000),
        accepted_at: new Date(nowMs - 16 * 60_000),
        container_running: true,
      })],
    })
    const counts = await runReconcileTick({
      pool: pool as unknown as Pool,
      container: {
        ...noContainer,
        getDispatchState: async (): Promise<ContainerCallResult> => {
          probes++
          return { kind: 'ok', state: 'queued' }
        },
      },
      now: () => nowMs,
      listCarrierDeadDispatchIds: async () => [],
    })
    assert.ok(probes >= 1, '未在 stuck 页里的 interrupt 行必须复查 typed state')
    assert.equal(counts.visibleOrphansSkippedLive, 1)
    assert.equal(counts.visibleOrphans, 0)
    assert.ok(!pool.writes.includes('COMMIT'))
    assert.ok(!pool.writes.some((sql) => sql.includes('producer_fenced_at')))
    assert.ok(!pool.writes.some((sql) => sql.includes("status = 'terminal'")))
  })

  test("INC-20260831 gap2: frame landed between scan and lock → ROLLBACK, zero UPDATE, counted stale", async () => {
    _resetVisibleOrphanScanOffset()
    // 扫描时零帧;锁内重验返回 5 分钟前的新帧(producer 在扫描后落帧)。
    const pool = makeFakePool({
      visibleOrphans: [orphanRow({
        tape_id: null,
        tape_part_count: null,
        tape_parts_rows: '0',
        last_frame_at: null,
        first_visible_at: null,
        admitted_at: new Date(nowMs - 16 * 60_000),
        accepted_at: new Date(nowMs - 16 * 60_000),
        container_running: false,
      })],
      orphanFrameReverify: new Date(nowMs - 5 * 60_000),
    })
    const counts = await runReconcileTick({
      pool: pool as unknown as Pool,
      container: noContainer,
      now: () => nowMs,
      listCarrierDeadDispatchIds: async () => [],
    })
    const lock = pool.queries.findIndex(sql => sql.includes('-- closeVisibleOrphans lock'))
    const frame = pool.queries.findIndex(sql => sql.includes('-- orphanFinalizeFrameReverify'))
    const rollback = pool.queries.indexOf('ROLLBACK')
    assert.ok(lock >= 0 && frame > lock && rollback > frame, 'lock and frame recheck execute before rollback')
    assert.equal(pool.attemptedWrites.length, 0, 'no UPDATE/INSERT before stale-evidence rollback')
    assert.equal(pool.queries.some(sql => sql.includes('-- orphanFinalizeFirstVisibleReverify')), false,
      'new frame returns before later rechecks or writes')
    assert.equal(counts.visibleOrphans, 0)
    assert.equal(counts.visibleOrphansEvidenceStale, 1, '证据推进必须计数')
    assert.ok(pool.writes.includes('ROLLBACK'))
    assert.ok(!pool.writes.includes('COMMIT'))
    assert.ok(
      !pool.attemptedWrites.some((sql) => sql.includes('producer_fenced_at') || sql.includes("status = 'terminal'")),
      '锁内重验失败必须在任何 UPDATE 之前回滚',
    )
  })

  test("INC-20260831 gap2: first_visible appearing between scan and lock → ROLLBACK", async () => {
    _resetVisibleOrphanScanOffset()
    const pool = makeFakePool({
      visibleOrphans: [orphanRow({
        tape_id: null,
        tape_part_count: null,
        tape_parts_rows: '0',
        last_frame_at: null,
        first_visible_at: null,
        admitted_at: new Date(nowMs - 16 * 60_000),
        accepted_at: new Date(nowMs - 16 * 60_000),
        container_running: false,
      })],
      orphanFirstVisibleReverify: [{
        dispatch_id: 'd-vis-1',
        user_id: '42',
        session_key: 'agent:main:webchat:dm:sess-vis',
        first_visible_at: new Date(nowMs - 60_000),
      }],
    })
    const counts = await runReconcileTick({
      pool: pool as unknown as Pool,
      container: noContainer,
      now: () => nowMs,
      listCarrierDeadDispatchIds: async () => [],
    })
    const lock = pool.queries.findIndex(sql => sql.includes('-- closeVisibleOrphans lock'))
    const frame = pool.queries.findIndex(sql => sql.includes('-- orphanFinalizeFrameReverify'))
    const rollback = pool.queries.indexOf('ROLLBACK')
    assert.ok(lock >= 0 && frame > lock && rollback > frame, 'lock and frame recheck execute before rollback')
    assert.equal(pool.attemptedWrites.length, 0, 'no UPDATE/INSERT before stale-evidence rollback')
    const trace = pool.queries.findIndex(sql => sql.includes('-- orphanFinalizeFirstVisibleReverify'))
    assert.ok(trace > frame && rollback > trace, 'first_visible recheck executes inside the lock')
    assert.equal(counts.visibleOrphans, 0)
    assert.equal(counts.visibleOrphansEvidenceStale, 1)
    assert.ok(pool.writes.includes('ROLLBACK'))
    assert.ok(!pool.writes.includes('COMMIT'))
    assert.ok(!pool.attemptedWrites.some((sql) => sql.includes('producer_fenced_at')))
  })

  test("INC-20260831: inactive carrier remains independent dead evidence despite typed-state error", async () => {
    _resetVisibleOrphanScanOffset()
    // typed error is not death evidence; the inactive carrier is independent proof.
    // Keep interrupt/fence assertions; active-error cases separately prove fail-closed.
    const pool = makeFakePool({
      visibleOrphans: [orphanRow({
        tape_id: null,
        tape_part_count: null,
        tape_parts_rows: '0',
        last_frame_at: null,
        first_visible_at: null,
        admitted_at: new Date(nowMs - 16 * 60_000),
        accepted_at: new Date(nowMs - 16 * 60_000),
        container_running: false,
      })],
    })
    const counts = await runReconcileTick({
      pool: pool as unknown as Pool,
      container: {
        ...noContainer,
        getDispatchState: async (): Promise<ContainerCallResult> => ({ kind: 'error', detail: '502' }),
      },
      now: () => nowMs,
      listCarrierDeadDispatchIds: async () => [],
    })
    assert.equal(counts.visibleOrphans, 1, 'OCV5-43 仍须中断')
    assert.equal(counts.visibleOrphansSkippedLive, 0)
    assert.equal(counts.visibleOrphansEvidenceStale, 0)
    assert.ok(pool.writes.includes('COMMIT'))
    assert.ok(pool.writes.some((sql) => sql.includes('producer_fenced_at')))
    assert.ok(pool.writes.some((sql) => sql.includes("status = 'terminal'")))
  })

})

describe('OCV5-121 queued consumer full tick', () => {
  for (const age of [16 * 60_000, 6 * 3_600_000]) {
    for (const acceptedPage of [true, false]) {
      test('queued age=' + age + ' acceptedPage=' + acceptedPage, async () => {
        _resetVisibleOrphanScanOffset()
        const now = Date.now()
        const row = rawRow({ status: 'accepted', outcome: null,
          admitted_at: new Date(now - age), accepted_at: new Date(now - age),
          tape_visible_at: null, tape_id: null, tape_part_count: null, tape_parts_rows: '0',
          last_frame_at: null, container_running: true })
        const pool = makeFakePool({ acceptedStuck: acceptedPage ? [row] : [], visibleOrphans: [row] })
        let probes = 0
        let cancels = 0
        const counts = await runReconcileTick({
          pool: pool as unknown as Pool, now: () => now,
          listCarrierDeadDispatchIds: async () => [],
          container: { ...noContainer,
            getDispatchState: async () => { probes++; return { kind: 'ok', state: 'queued' } },
            cancelIfQueued: async (id) => {
              assert.equal(id.attemptNo, 1)
              cancels++
              return { kind: 'ok', state: 'rejected', outcome: 'not_accepted' }
            },
          },
        })
        assert.equal(counts.visibleOrphans, 0)
        assert.equal(probes, 1, 'accepted cache or exact per-row probe')
        assert.equal(cancels, age >= 6 * 3_600_000 ? 1 : 0)
        assert.equal(pool.writes.some(s => s.includes('producer_fenced_at') || s.includes("status = 'terminal'")), false)
      })
    }
  }
})

test('OCV5-121 cancel outcomes always defer this tick; durable rejected settles without fallback', async () => {
  for (const cancelResult of [
    { kind: 'ok', state: 'rejected', outcome: 'not_accepted' },
    { kind: 'ok', state: 'running' }, { kind: 'ok', state: 'absent' },
    { kind: 'unreachable', detail: 'old runtime 404' },
    { kind: 'error', detail: 'lost response after CAS' },
  ] as ContainerCallResult[]) {
    _resetVisibleOrphanScanOffset()
    const now = Date.now()
    const row = rawRow({ status: 'accepted', outcome: null, admitted_at: new Date(now - 6 * 3_600_000),
      accepted_at: new Date(now - 6 * 3_600_000), tape_visible_at: null, tape_id: null,
      tape_part_count: null, tape_parts_rows: '0', last_frame_at: null, container_running: true })
    const canned: Canned = { acceptedStuck: [row], visibleOrphans: [row],
      abortedJournalRefs: [{ user_id: '42', request_id: 'br-1' }] }
    const pool = makeFakePool(canned)
    let state: ContainerCallResult = { kind: 'ok', state: 'queued' }
    let cancels = 0
    const released: unknown[] = []
    const deps = { pool: pool as unknown as Pool, now: () => now, listCarrierDeadDispatchIds: async () => [],
      assessBilling: async () => 'not_billed' as const,
      releaseReservation: async (ref: unknown) => { released.push(ref) },
      container: { ...noContainer, getDispatchState: async () => state,
        cancelIfQueued: async () => { cancels++; return cancelResult } } }
    const first = await runReconcileTick(deps)
    assert.equal(cancels, 1)
    assert.equal(first.visibleOrphans, 0)
    assert.equal(pool.writes.length, 0)
    if (cancelResult.kind === 'unreachable' || (cancelResult.kind === 'ok' && cancelResult.state === 'absent')) {
      const next = await runReconcileTick(deps)
      assert.equal(next.rejectedTerminal, 0)
      assert.equal(next.visibleOrphans, 0)
      assert.equal(pool.writes.length, 0)
      continue
    }
    if (cancelResult.kind === 'ok' && cancelResult.state === 'running') {
      state = cancelResult
      const next = await runReconcileTick(deps)
      assert.equal(next.rejectedTerminal, 0)
      assert.equal(next.visibleOrphans, 1, 'next tick retains running hard cap')
      assert.equal(cancels, 1)
      continue
    }
    // A successful or response-lost cancellation is discovered only by the next GET.
    state = { kind: 'ok', state: 'rejected', outcome: 'not_accepted' }
    const next = await runReconcileTick(deps)
    assert.equal(next.rejectedTerminal, 1)
    assert.equal(next.visibleOrphans, 0)
    assert.equal(cancels, 1)
    // Existing tick order visits terminal-unnotified before accepted; finance is the following tick.
    canned.acceptedStuck = []
    canned.visibleOrphans = []
    canned.terminalUnnotified = [rawRow()]
    const settled = await runReconcileTick(deps)
    assert.equal(settled.notified, 1)
    assert.deepEqual(released, [{ userId: '42', requestId: 'br-1' }])
    assert.ok(pool.writes.some(s => s.includes("state='aborted'") && s.includes('request_finalize_journal')))
    assert.equal(pool.writes.some(s => /producer_fenced_at\s*=/.test(s) || s.includes('visible-fallback')), false)
  }
})

test('OCV5-121 active destructive candidates require exact running proof', async () => {
  for (const state of [
    { kind: 'unreachable', detail: 'timeout' }, { kind: 'error', detail: 'bad body' },
    ...['rejected', 'terminal', 'absent', 'sink_staged', 'sink_stage_failed', 'recovery_pending'].map(state => ({ kind: 'ok', state })),
  ] as ContainerCallResult[]) {
    const now = Date.now()
    const pool = makeFakePool({ visibleOrphans: [rawRow({ status: 'accepted',
      admitted_at: new Date(now - 7 * 3_600_000), accepted_at: new Date(now - 7 * 3_600_000),
      tape_visible_at: null, tape_id: null, tape_part_count: null, tape_parts_rows: '0',
      last_frame_at: null, container_running: true })] })
    const counts = await runReconcileTick({ pool: pool as unknown as Pool, now: () => now,
      listCarrierDeadDispatchIds: async () => [], container: { ...noContainer, getDispatchState: async () => state } })
    assert.equal(counts.visibleOrphans, 0)
    assert.equal(pool.writes.length, 0)
  }
})

describe('OCV5-121 R4 exact-attempt liveness integration', () => {
  const rowAt = (now: number, age: number, attempt = 1) => rawRow({
    status: 'accepted', outcome: null, attempt_no: attempt,
    admitted_at: new Date(now - age), accepted_at: new Date(now - age),
    tape_visible_at: null, tape_id: null, tape_part_count: null, tape_parts_rows: '0',
    first_visible_at: null, last_frame_at: null, container_running: true,
  })
  const assertNoDestructive = (pool: ReturnType<typeof makeFakePool>) => {
    assert.equal(pool.attemptedWrites.length, 0)
    assert.equal(pool.writes.includes('COMMIT'), false)
    assert.equal(pool.queries.some(sql => sql.includes('SELECT f.payload') && sql.includes('FROM client_session_live_streams')), false)
  }

  for (const age of [16 * 60_000, 6 * 3_600_000]) {
    for (const acceptedPage of [true, false]) {
      test('running age=' + age + ' acceptedPage=' + acceptedPage, async () => {
        _resetVisibleOrphanScanOffset()
        const now = Date.now(), row = rowAt(now, age)
        const pool = makeFakePool({ acceptedStuck: acceptedPage ? [row] : [], visibleOrphans: [row] })
        let probes = 0
        const counts = await runReconcileTick({
          pool: pool as unknown as Pool, now: () => now, listCarrierDeadDispatchIds: async () => [],
          container: { ...noContainer, getDispatchState: async () => {
            probes++; return { kind: 'ok', state: 'running' }
          }, cancelIfQueued: async () => { assert.fail('running is never a queued cancellation') } },
        })
        assert.equal(probes, 1)
        if (age < 6 * 3_600_000) {
          assert.equal(counts.visibleOrphans, 0)
          assert.equal(counts.visibleOrphansSkippedLive, 1)
          assertNoDestructive(pool)
        } else {
          assert.equal(counts.visibleOrphans, 1)
          assert.equal(counts.visibleOrphansSkippedLive, 0)
          assert.ok(pool.writes.includes('COMMIT'))
          assert.ok(pool.writes.some(sql => sql.includes('producer_fenced_at')))
          assert.ok(pool.writes.some(sql => sql.includes("status = 'terminal'")))
        }
      })
    }
  }

  for (const currentState of ['queued', 'running'] as const) {
    test('raw-id live/probed hits cannot reuse a different attempt: ' + currentState, async () => {
      _resetVisibleOrphanScanOffset()
      const now = Date.now(), age = 6 * 3_600_000
      const old = rowAt(now, age, 1), current = rowAt(now, age, 2)
      const pool = makeFakePool({ acceptedStuck: [old], visibleOrphans: [current] })
      const attempts: number[] = [], canceled: number[] = []
      const counts = await runReconcileTick({
        pool: pool as unknown as Pool, now: () => now, listCarrierDeadDispatchIds: async () => [],
        container: { ...noContainer, getDispatchState: async id => {
          attempts.push(id.attemptNo)
          return { kind: 'ok', state: id.attemptNo === 1 ? 'sink_staged' : currentState }
        }, cancelIfQueued: async id => {
          canceled.push(id.attemptNo); return { kind: 'ok', state: 'rejected', outcome: 'not_accepted' }
        } },
      })
      assert.deepEqual(attempts, [1, 2])
      assert.deepEqual(canceled, currentState === 'queued' ? [2] : [])
      assert.equal(counts.visibleOrphans, currentState === 'queued' ? 0 : 1)
      if (currentState === 'queued') assertNoDestructive(pool)
    })
  }

  for (const kind of ['error', 'unreachable'] as const) {
    for (const age of [16 * 60_000, 6 * 3_600_000]) {
      for (const acceptedPage of [true, false]) {
        test('active unknown ' + kind + ' age=' + age + ' acceptedPage=' + acceptedPage, async () => {
          _resetVisibleOrphanScanOffset()
          const now = Date.now(), row = rowAt(now, age)
          const pool = makeFakePool({ acceptedStuck: acceptedPage ? [row] : [], visibleOrphans: [row] })
          let probes = 0
          const counts = await runReconcileTick({
            pool: pool as unknown as Pool, now: () => now, listCarrierDeadDispatchIds: async () => [],
            container: { ...noContainer, getDispatchState: async () => { probes++; return { kind, detail: 'unknown' } } },
          })
          assert.equal(probes, 1)
          assert.equal(counts.visibleOrphans, 0)
          assertNoDestructive(pool)
        })
      }
    }
  }

  for (const acceptedPage of [true, false]) {
    test('sink_staged at 6h remains live acceptedPage=' + acceptedPage, async () => {
      _resetVisibleOrphanScanOffset()
      const now = Date.now(), row = rowAt(now, 6 * 3_600_000)
      const pool = makeFakePool({ acceptedStuck: acceptedPage ? [row] : [], visibleOrphans: [row] })
      let probes = 0
      const counts = await runReconcileTick({
        pool: pool as unknown as Pool, now: () => now, listCarrierDeadDispatchIds: async () => [],
        container: { ...noContainer, getDispatchState: async () => { probes++; return { kind: 'ok', state: 'sink_staged' } } },
      })
      assert.equal(probes, 1)
      assert.equal(counts.visibleOrphans, 0)
      assert.equal(counts.visibleOrphansSkippedLive, 1)
      assertNoDestructive(pool)
    })

    test('queued hard-cap waits for durable next-tick GET; first acceptedPage=' + acceptedPage, async () => {
      _resetVisibleOrphanScanOffset()
      const now = Date.now(), row = rowAt(now, 6 * 3_600_000)
      const canned: Canned = { acceptedStuck: acceptedPage ? [row] : [], visibleOrphans: [row] }
      const pool = makeFakePool(canned)
      let state: ContainerCallResult = { kind: 'ok', state: 'queued' }
      let probes = 0, cancels = 0
      const deps = {
        pool: pool as unknown as Pool, now: () => now, listCarrierDeadDispatchIds: async () => [],
        container: { ...noContainer, getDispatchState: async () => { probes++; return state },
          cancelIfQueued: async () => {
            cancels++; state = { kind: 'ok', state: 'rejected', outcome: 'not_accepted' }; return state
          } },
      }
      const first = await runReconcileTick(deps)
      assert.equal(probes, 1)
      assert.equal(cancels, 1)
      assert.equal(first.rejectedTerminal, 0)
      assert.equal(first.visibleOrphans, 0)
      assertNoDestructive(pool)
      // The next accepted scan visits this identity even when the previous page did not.
      canned.acceptedStuck = [row]
      const next = await runReconcileTick(deps)
      assert.equal(probes, 2)
      assert.equal(cancels, 1)
      assert.equal(next.rejectedTerminal, 1)
      assert.equal(next.visibleOrphans, 0)
      assert.ok(pool.writes.some(sql => sql.includes("status = 'terminal'")))
      assert.equal(pool.writes.some(sql => /producer_fenced_at\s*=/.test(sql) || sql.includes('visible-fallback')), false)
    })
  }
})
