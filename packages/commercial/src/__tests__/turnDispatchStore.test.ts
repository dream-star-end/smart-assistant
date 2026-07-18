/**
 * turnDispatchStore unit:受理冲突表全 kind(RFC §2.1 / §7)+ 关键 CAS 迁移。
 * 用假 Queryable 按 SQL 路由,不依赖 PG(SQL 真行为由 integ 覆盖)。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  admitDispatch,
  casToTerminal,
  heartbeatLease,
  type Queryable,
} from '../dispatch/turnDispatchStore.js'

/** 假 query 面转成 store 期望的 Queryable(pg 的 query 是重载类型,结构不直接可赋)。 */
const asQ = (x: unknown): Queryable => x as unknown as Queryable

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
    status: 'admitted',
    outcome: null,
    failure_code: null,
    conflict_reason: null,
    resolution: null,
    resolved_at: null,
    client_notified: false,
    owner_id: 'owner-old',
    lease_epoch: '1',
    lease_until: new Date(Date.now() + 90_000),
    anchor_seq: '5',
    admitted_at: new Date(),
    accepted_at: null,
    terminal_at: null,
    last_attempt_at: null,
    ...o,
  }
}

/** 假 Queryable:SELECT FOR UPDATE 返 existing;INSERT/UPDATE 返回给定的结果行。 */
function makeFakeQ(opts: {
  existing?: Raw | null
  onInsert?: (params: unknown[]) => Raw
  onTakeover?: () => Raw | null
}) {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const q = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params })
      const s = sql.replace(/\s+/g, ' ')
      if (s.includes('SELECT') && s.includes('FOR UPDATE') && s.includes('client_message_id = $3')) {
        return { rows: opts.existing ? [opts.existing] : [], rowCount: opts.existing ? 1 : 0 }
      }
      if (s.startsWith('INSERT INTO turn_dispatches')) {
        const row = opts.onInsert ? opts.onInsert(params) : rawRow()
        return { rows: [row], rowCount: 1 }
      }
      if (s.includes('UPDATE turn_dispatches') && s.includes('lease_epoch + 1') && s.includes("status = 'admitted'")) {
        const row = opts.onTakeover ? opts.onTakeover() : null
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
      }
      // getDispatch re-read
      if (s.includes('WHERE dispatch_id = $1') && s.includes('SELECT')) {
        return { rows: opts.existing ? [opts.existing] : [], rowCount: opts.existing ? 1 : 0 }
      }
      return { rows: [], rowCount: 0 }
    },
    calls,
  }
  return q
}

const baseInput = {
  dispatchId: 'd-new',
  userId: 42n,
  sessionId: 'sess-0001',
  clientMessageId: 'cm-1',
  agentId: 'main',
  model: null,
  requestHash: 'hash-a',
  billingRequestId: 'br-new',
  ownerId: 'owner-me',
  anchorSeq: 5n,
}

describe('admitDispatch conflict table', () => {
  test('no existing row → admitted (insert)', async () => {
    const q = makeFakeQ({ existing: null, onInsert: () => rawRow({ dispatch_id: 'd-new', billing_request_id: 'br-new', owner_id: 'owner-me' }) })
    const r = await admitDispatch(asQ(q), baseInput)
    assert.equal(r.kind, 'admitted')
    if (r.kind === 'admitted') {
      assert.equal(r.takeover, false)
      assert.equal(r.dispatch.billingRequestId, 'br-new')
    }
    assert.ok(q.calls.some((c) => c.sql.includes('INSERT INTO turn_dispatches')))
  })

  test('admitted ∧ lease active → already_owned (no insert/update)', async () => {
    const q = makeFakeQ({ existing: rawRow({ status: 'admitted', lease_until: new Date(Date.now() + 60_000) }) })
    const r = await admitDispatch(asQ(q), baseInput)
    assert.equal(r.kind, 'already_owned')
    assert.ok(!q.calls.some((c) => c.sql.includes('INSERT INTO turn_dispatches')))
  })

  test('admitted ∧ lease expired → takeover admitted (epoch bump, billing reuse)', async () => {
    const q = makeFakeQ({
      existing: rawRow({ status: 'admitted', lease_until: new Date(Date.now() - 1000), lease_epoch: '3', billing_request_id: 'br-old' }),
      onTakeover: () => rawRow({ status: 'admitted', lease_epoch: '4', owner_id: 'owner-me', billing_request_id: 'br-old' }),
    })
    const r = await admitDispatch(asQ(q), baseInput)
    assert.equal(r.kind, 'admitted')
    if (r.kind === 'admitted') {
      assert.equal(r.takeover, true)
      assert.equal(r.dispatch.leaseEpoch, 4)
      assert.equal(r.dispatch.billingRequestId, 'br-old', 'takeover reuses billing_request_id')
    }
  })

  test('admitted ∧ lease expired ∧ takeover CAS lost → already_owned', async () => {
    const q = makeFakeQ({
      existing: rawRow({ status: 'admitted', lease_until: new Date(Date.now() - 1000) }),
      onTakeover: () => null, // 并发接管输了
    })
    const r = await admitDispatch(asQ(q), baseInput)
    assert.equal(r.kind, 'already_owned')
  })

  test('accepted → in_flight', async () => {
    const q = makeFakeQ({ existing: rawRow({ status: 'accepted' }) })
    const r = await admitDispatch(asQ(q), baseInput)
    assert.equal(r.kind, 'in_flight')
  })

  test('rejecting → in_flight', async () => {
    const q = makeFakeQ({ existing: rawRow({ status: 'rejecting', lease_until: null }) })
    const r = await admitDispatch(asQ(q), baseInput)
    assert.equal(r.kind, 'in_flight')
  })

  test('terminal ∧ completed → deduplicated', async () => {
    const q = makeFakeQ({ existing: rawRow({ status: 'terminal', outcome: 'completed', terminal_at: new Date() }) })
    const r = await admitDispatch(asQ(q), baseInput)
    assert.equal(r.kind, 'deduplicated')
  })

  test('terminal ∧ not_accepted → previously_failed', async () => {
    const q = makeFakeQ({ existing: rawRow({ status: 'terminal', outcome: 'not_accepted', terminal_at: new Date() }) })
    const r = await admitDispatch(asQ(q), baseInput)
    assert.equal(r.kind, 'previously_failed')
  })

  test('manual_reconcile → manual_hold', async () => {
    const q = makeFakeQ({ existing: rawRow({ status: 'manual_reconcile', conflict_reason: 'billed_but_failed' }) })
    const r = await admitDispatch(asQ(q), baseInput)
    assert.equal(r.kind, 'manual_hold')
  })

  test('request_hash mismatch → immutable_conflict (no state change)', async () => {
    const q = makeFakeQ({ existing: rawRow({ request_hash: 'hash-DIFFERENT' }) })
    const r = await admitDispatch(asQ(q), baseInput)
    assert.equal(r.kind, 'immutable_conflict')
    // 只有一次 SELECT FOR UPDATE,无任何写(INSERT/UPDATE 语句)。
    assert.equal(q.calls.length, 1)
    assert.ok(!q.calls.some((c) => c.sql.includes('INSERT INTO') || c.sql.includes('SET ')))
  })
})

describe('CAS helpers', () => {
  test('casToTerminal maps rowCount to row|null and keeps DDL outcome invariant', async () => {
    const captured: string[] = []
    const q = {
      async query(sql: string) {
        captured.push(sql.replace(/\s+/g, ' '))
        return { rows: [rawRow({ status: 'terminal', outcome: 'not_accepted', terminal_at: new Date() })], rowCount: 1 }
      },
    }
    const r = await casToTerminal(asQ(q), { dispatchId: 'd-1', outcome: 'not_accepted', failureCode: 'X', clientNotified: true })
    assert.ok(r !== null)
    assert.equal(r!.outcome, 'not_accepted')
    assert.ok(captured[0]!.includes("status = 'terminal'"))
    assert.ok(captured[0]!.includes('client_notified = client_notified OR'), 'notified is monotonic OR')
  })

  test('casToTerminal returns null when CAS matches nothing', async () => {
    const q = { async query() { return { rows: [], rowCount: 0 } } }
    const r = await casToTerminal(asQ(q), { dispatchId: 'd-1', outcome: 'completed' })
    assert.equal(r, null)
  })

  test('heartbeatLease returns true only on rowCount 1 (owner+epoch fence)', async () => {
    const ok = { async query() { return { rows: [], rowCount: 1 } } }
    const lost = { async query() { return { rows: [], rowCount: 0 } } }
    assert.equal(await heartbeatLease(asQ(ok), { dispatchId: 'd', ownerId: 'o', leaseEpoch: 2 }), true)
    assert.equal(await heartbeatLease(asQ(lost), { dispatchId: 'd', ownerId: 'o', leaseEpoch: 2 }), false)
  })
})
