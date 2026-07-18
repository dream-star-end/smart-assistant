/**
 * turnDispatchReconciler unit:阈值钳制 + 三分支关键行为(RFC §2.3 / §7)。
 * 钱安全焦点:terminal-未通知分支在有计费证据时绝不写"未计费",走 manual_reconcile+告警。
 * 假 pool 按 SQL 路由(SQL 真行为由 integ 覆盖)。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { Pool } from 'pg'
import {
  assessDispatchBilling,
  DEFAULT_ACCEPTED_STUCK_FLOOR_MS,
  MAX_ACCEPTED_STUCK_MS,
  resolveDispatchStuckThresholdMs,
  runReconcileTick,
} from '../dispatch/turnDispatchReconciler.js'
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
}

function makeFakePool(canned: Canned) {
  const writes: string[] = []
  // 单点路由:pool.query 与事务 client.query 共用。B8 的 terminal-未通知分支走
  // pool.connect() 单事务(SELECT … FOR UPDATE 锁行 → 重验 → 财务联查 → projection/manual),
  // 故 fake 必须提供 connect() + 事务 client。
  const route = (sql: string) => {
    const s = sql.replace(/\s+/g, ' ')
    // 事务控制帧。
    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [], rowCount: 0 }
    // 行锁读(getDispatchForUpdate):返回锁定的 terminal 行,重验通过。
    if (s.includes('FROM turn_dispatches') && s.includes('FOR UPDATE')) {
      return { rows: [rawRow()], rowCount: 1 }
    }
    if (s.startsWith('UPDATE') || s.startsWith('INSERT')) {
      writes.push(s)
      if (s.startsWith('INSERT INTO turn_dispatch_error_projections')) return { rows: [], rowCount: 1 }
      if (s.includes('client_notified = TRUE')) return { rows: [], rowCount: 1 }
      if (s.includes("status = 'manual_reconcile'")) return { rows: [rawRow({ status: 'manual_reconcile', conflict_reason: 'x' })], rowCount: 1 }
      if (s.includes("status = 'terminal'")) return { rows: [rawRow({ status: 'terminal', outcome: 'not_accepted', terminal_at: new Date() })], rowCount: 1 }
      if (s.includes("status = 'accepted'")) return { rows: [rawRow({ status: 'accepted' })], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    }
    // reads (scans)
    if (s.includes("status = 'admitted'") && s.includes('lease_until')) return { rows: canned.admittedLeaseExpired ?? [], rowCount: (canned.admittedLeaseExpired ?? []).length }
    if (s.includes("status = 'rejecting'") && s.includes('ORDER BY admitted_at')) return { rows: canned.rejecting ?? [], rowCount: (canned.rejecting ?? []).length }
    if (s.includes("status = 'terminal'") && s.includes('client_notified = FALSE')) return { rows: canned.terminalUnnotified ?? [], rowCount: (canned.terminalUnnotified ?? []).length }
    if (s.includes("status = 'accepted'") && s.includes('COALESCE(accepted_at')) return { rows: canned.acceptedStuck ?? [], rowCount: (canned.acceptedStuck ?? []).length }
    if (s.includes("status IN ('admitted', 'accepted', 'rejecting')")) return { rows: canned.openAged ?? [], rowCount: (canned.openAged ?? []).length }
    return { rows: [], rowCount: 0 }
  }
  const pool = {
    async query(sql: string) {
      return route(sql)
    },
    async connect() {
      return {
        async query(sql: string) {
          return route(sql)
        },
        release() {},
      }
    },
    writes,
  }
  return pool
}

const noContainer = {
  rejectIfAbsent: async (): Promise<ContainerCallResult> => ({ kind: 'unreachable', detail: 'test' }),
  getDispatchState: async (): Promise<ContainerCallResult> => ({ kind: 'unreachable', detail: 'test' }),
}

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

describe('terminal-unnotified branch (financial safety)', () => {
  test('not billed → error projection + client_notified, no manual_reconcile', async () => {
    const pool = makeFakePool({ terminalUnnotified: [rawRow()] })
    const alerts: unknown[] = []
    const counts = await runReconcileTick({
      pool: pool as unknown as Pool,
      container: noContainer,
      enqueueAlert: (e) => alerts.push(e),
      assessBilling: async () => 'not_billed',
    })
    assert.equal(counts.projections, 1)
    assert.equal(counts.notified, 1)
    assert.equal(counts.manualReconcile, 0)
    assert.ok(pool.writes.some((w) => w.startsWith('INSERT INTO turn_dispatch_error_projections')))
    assert.ok(!pool.writes.some((w) => w.includes("status = 'manual_reconcile'")))
    assert.equal(alerts.length, 0)
  })

  test('billed evidence → manual_reconcile + critical alert, never projects "not billed"', async () => {
    const pool = makeFakePool({ terminalUnnotified: [rawRow()] })
    const alerts: Array<{ severity?: string }> = []
    const counts = await runReconcileTick({
      pool: pool as unknown as Pool,
      container: noContainer,
      enqueueAlert: (e) => alerts.push(e as { severity?: string }),
      assessBilling: async () => 'billed',
    })
    assert.equal(counts.manualReconcile, 1)
    assert.equal(counts.projections, 0)
    assert.equal(counts.notified, 0)
    assert.ok(pool.writes.some((w) => w.includes("status = 'manual_reconcile'")))
    assert.ok(!pool.writes.some((w) => w.startsWith('INSERT INTO turn_dispatch_error_projections')))
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
    assert.equal(counts.projections, 0)
    assert.equal(counts.notified, 0)
    assert.equal(counts.manualReconcile, 0)
    assert.ok(!pool.writes.some((w) => w.startsWith('INSERT INTO turn_dispatch_error_projections')))
  })
})

describe('B-R1-1: not_accepted → abort pre-forward journal → not_billed projection', () => {
  // 故障注入:accepted→(容器 rejected)→terminal(not_accepted),但 bridge attach 前写的
  // pre-forward inflight journal 仍在(state='inflight' 无 usage)。旧实现里 assessDispatchBilling
  // 把它当 billed → 全进 manual、无 projection、违反 I1。修复后:③ 分支先在同一 tx 内 CAS 该
  // journal 为永久 no-execution waiver aborted,assess 遂得 not_billed → projection。
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
        if (s.startsWith('INSERT INTO turn_dispatch_error_projections')) return { rows: [], rowCount: 1 }
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

  test('inflight journal 存在 → journal aborted(永久 waiver) + projection 生成 + 非 manual + 释放 reservation', async () => {
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
    // 财务判定 not_billed → projection(免单 tone),非 manual。
    assert.equal(counts.projections, 1)
    assert.equal(counts.notified, 1)
    assert.equal(counts.manualReconcile, 0)
    assert.ok(fake.writes.some((w) => w.startsWith('INSERT INTO turn_dispatch_error_projections')))
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
    assert.equal(counts.projections, 0)
    assert.ok(fake.writes.some((w) => w.includes("status = 'manual_reconcile'")))
    assert.ok(!fake.writes.some((w) => w.startsWith('INSERT INTO turn_dispatch_error_projections')))
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
