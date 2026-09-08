/**
 * OCV5-180 B1 — exact-owner late delegate completion 回归。
 *
 * 三层:
 *   1. delegateLateCompletion 纯 helper:identity 确定性 / locator 校验。
 *   2. SessionManager exact-owner 缓冲契约:seal 前 → 随 owner turn drain;
 *      seal(= drain 同步临界段)后 → 持久晚到 continuation;跨 turn 拒入;
 *      同 run 幂等、内容冲突可观察且不二写。
 *   3. B-R2-1 可控 sink 反例:T1 drain/seal → sink pending → child 完成 →
 *      T2 开始/结束 → T1 恰好一张 continuation 卡、T2 tape 零 agent-group
 *      污染、重投不新增卡;对照 seal 前路径(group 随 T1 tape 正常落库)。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/delegateLateCompletion.test.ts
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import type { DurableAgentGroup } from '@openclaude/protocol'

import {
  buildLateDelegateContinuationArgs,
  isValidDelegateOwnerLocator,
  lateDelegateGroupIdentity,
  lateDelegateGroupTurnKey,
  lateDelegateLogicalRunKey,
  type DelegateOwnerTurnLocator,
} from '../delegateLateCompletion.js'
import { SessionManager, type AgentSession } from '../sessionManager.js'
import { CcbAdapter } from '../engine/ccbAdapter.js'
import { Gateway, PerTurnDelegationGuard } from '../server.js'
import {
  makeV3MasterSink,
  setV3MasterSinkSingleton,
  type V3MasterSink,
  type V3MasterSinkPayload,
} from '../v3MasterSink.js'

const OWNER_TURN_KEY = 'a'.repeat(64)
const OTHER_TURN_KEY = 'b'.repeat(64)

process.env.OC_MODEL_AUTHORITY = '0'
process.env.OC_DELEGATE_SM = process.env.OC_DELEGATE_SM ?? '0'

describe('OCV5-180 B1 serial', { concurrency: 1 }, () => {

function owner(over: Partial<DelegateOwnerTurnLocator> = {}): DelegateOwnerTurnLocator {
  return {
    parentSessionId: 'wsess-owner',
    parentTurnKey: OWNER_TURN_KEY,
    turnIndex: 3,
    ...over,
  }
}

function group(runId: string, over: Partial<DurableAgentGroup> = {}): DurableAgentGroup {
  return {
    runId,
    agentId: 'coding-assistant',
    goal: '子任务',
    status: 'ok',
    completedAt: 1_720_000_000_000,
    ...over,
  }
}

// ── 1. pure helpers ─────────────────────────────────────────────────────

describe('delegateLateCompletion helpers', () => {
  it('identity is deterministic and insertion-order insensitive', () => {
    const a = group('dlg-1', { resultSummary: 'x', transcript: [{ kind: 'text', text: 'r' }] })
    const b = group('dlg-1', { transcript: [{ kind: 'text', text: 'r' }], resultSummary: 'x' })
    assert.equal(lateDelegateGroupIdentity(owner(), a), lateDelegateGroupIdentity(owner(), b))
    // same run, different content → different identity (observable conflict)
    const c = group('dlg-1', { resultSummary: 'different' })
    assert.notEqual(lateDelegateGroupIdentity(owner(), a), lateDelegateGroupIdentity(owner(), c))
    // same content, different owner turn → different identity
    assert.notEqual(
      lateDelegateGroupIdentity(owner(), a),
      lateDelegateGroupIdentity(owner({ parentTurnKey: OTHER_TURN_KEY }), a),
    )
  })

  it('locator validation is strict', () => {
    assert.equal(isValidDelegateOwnerLocator(owner()), true)
    assert.equal(isValidDelegateOwnerLocator(owner({ parentTurnKey: 'not-hex' })), false)
    assert.equal(isValidDelegateOwnerLocator(owner({ parentTurnKey: '' })), false)
    assert.equal(isValidDelegateOwnerLocator(owner({ parentSessionId: '' })), false)
    assert.equal(isValidDelegateOwnerLocator(owner({ turnIndex: 0 })), false)
    assert.equal(isValidDelegateOwnerLocator(owner({ turnIndex: 1.5 })), false)
  })

  it('continuation args carry owner locator, empty text, deterministic 64-hex tape key', () => {
    const g = group('dlg-2')
    const args = buildLateDelegateContinuationArgs({ owner: owner(), group: g, sessionKey: 'k' })
    assert.equal(args.peerId, 'wsess-owner')
    assert.equal(args.turnIndex, 3)
    assert.equal(args.text, '')
    assert.equal(args.status, 'completed')
    assert.equal(args.continuationOfTurnKey, OWNER_TURN_KEY)
    assert.match(args.turnKey, /^[0-9a-f]{64}$/)
    assert.match(args.agentId, /^late_[0-9a-f]{24}$/)
    assert.deepEqual(args.agentGroups?.map((x) => x.runId), ['dlg-2'])
    // same inputs → same tape key (idempotent retries)
    const again = buildLateDelegateContinuationArgs({ owner: owner(), group: g, sessionKey: 'k' })
    assert.equal(args.turnKey, again.turnKey)
    // same logical run, different payload → still the SAME tape key so a
    // restart cannot mint a second card; conflict is observable at identity.
    const conflict = buildLateDelegateContinuationArgs({
      owner: owner(),
      group: group('dlg-2', { resultSummary: 'other' }),
      sessionKey: 'k',
    })
    assert.equal(args.turnKey, conflict.turnKey)
    assert.notEqual(lateDelegateGroupIdentity(owner(), g), lateDelegateGroupIdentity(owner(), conflict.agentGroups![0]!))
    const runKey = lateDelegateLogicalRunKey(owner(), 'dlg-2')
    assert.equal(args.turnKey, lateDelegateGroupTurnKey(runKey))
    assert.equal(lateDelegateGroupTurnKey('abcd'), lateDelegateGroupTurnKey('abcd'))
  })
})

// ── 2. SessionManager exact-owner buffer/drain/seal ────────────────────

function makeSessions(): { sm: SessionManager; session: AgentSession } {
  const sm = new SessionManager({
    version: 1,
    gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
    auth: { mode: 'subscription', claudeCodePath: '' },
    sessions: { dbPath: '' },
  } as never)
  const session = {
    sessionKey: 'agent:main:webchat:dm:owner-sess',
    agentId: 'main',
    channel: 'webchat',
    peerId: 'wsess-owner',
    _currentTurnKey: OWNER_TURN_KEY,
    _currentTurnIndex: 3,
    turns: 2,
  } as unknown as AgentSession
  ;(sm as unknown as { sessions: Map<string, AgentSession> }).sessions.set(
    session.sessionKey,
    session,
  )
  return { sm, session }
}

function makeCapturingSink(outcome: { ok: boolean; queued?: boolean } = { ok: true }): {
  sink: V3MasterSink
  payloads: V3MasterSinkPayload[]
} {
  const payloads: V3MasterSinkPayload[] = []
  const sink: V3MasterSink = {
    persistOrQueue: async (payload: V3MasterSinkPayload) => {
      payloads.push(payload)
      return outcome as never
    },
    attemptOnce: async () => {
      throw new Error('not used')
    },
  }
  return { sink, payloads }
}

describe('SessionManager exact-owner buffer contract (OCV5-180 B1)', () => {
  it('seal-before: matching current turn buffers and drains with that turn', () => {
    const { sm, session } = makeSessions()
    assert.equal(sm.bufferPendingAgentGroup(session.sessionKey, group('dlg-1'), owner()), true)
    const drained = sm.drainPendingAgentGroups(session, OWNER_TURN_KEY)
    assert.deepEqual(drained.map((g) => g.runId), ['dlg-1'])
    assert.equal(session._pendingAgentGroups, undefined)
    // drain sealed the owner in the same critical section
    assert.equal(session._sealedOwnerTurnKeys?.has(OWNER_TURN_KEY), true)
  })

  it('sealed owner rejects re-buffer; the caller must use the late path', () => {
    const { sm, session } = makeSessions()
    sm.drainPendingAgentGroups(session, OWNER_TURN_KEY)
    assert.equal(sm.bufferPendingAgentGroup(session.sessionKey, group('dlg-late'), owner()), false)
  })

  it('cross-turn owner is rejected: a T1 group never buffers onto T2', () => {
    const { sm, session } = makeSessions()
    session._currentTurnKey = OTHER_TURN_KEY
    assert.equal(sm.bufferPendingAgentGroup(session.sessionKey, group('dlg-t1'), owner()), false)
    assert.equal(session._pendingAgentGroups, undefined)
  })

  it('drain(turnKey) never takes another turn’s late entries', () => {
    const { sm, session } = makeSessions()
    assert.equal(sm.bufferPendingAgentGroup(session.sessionKey, group('dlg-1'), owner()), true)
    // owner moves to a new turn without a drain of T1 (defense path): T2's
    // drain must not absorb T1's card.
    session._currentTurnKey = OTHER_TURN_KEY
    const t2Drained = sm.drainPendingAgentGroups(session, OTHER_TURN_KEY)
    assert.deepEqual(t2Drained, [])
    assert.deepEqual(session._pendingAgentGroups?.map((e) => e.group.runId), ['dlg-1'])
  })

  it('invalid locator is rejected before touching the buffer', () => {
    const { sm, session } = makeSessions()
    assert.equal(
      sm.bufferPendingAgentGroup(session.sessionKey, group('dlg-x'), owner({ parentTurnKey: 'zz' })),
      false,
    )
  })

  it('absent parent session returns false (caller persists via frozen locator)', () => {
    const sm = new SessionManager({
      version: 1,
      gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
      auth: { mode: 'subscription', claudeCodePath: '' },
      sessions: { dbPath: '' },
    } as never)
    assert.equal(sm.bufferPendingAgentGroup('agent:gone', group('dlg-x'), owner()), false)
  })

  it('same owner/run is idempotent in the ordinary buffer; conflict is visible', () => {
    const { sm, session } = makeSessions()
    assert.equal(sm.bufferPendingAgentGroup(session.sessionKey, group('dlg-1'), owner()), true)
    assert.equal(sm.bufferPendingAgentGroup(session.sessionKey, group('dlg-1'), owner()), true)
    assert.equal(session._pendingAgentGroups?.length, 1)
    assert.equal(
      sm.bufferPendingAgentGroup(
        session.sessionKey,
        group('dlg-1', { resultSummary: 'other' }),
        owner(),
      ),
      false,
    )
    assert.equal(session._pendingAgentGroups?.length, 1)
  })

  it('cross-session owner locator is rejected even when turnKey matches', () => {
    const { sm, session } = makeSessions()
    assert.equal(
      sm.bufferPendingAgentGroup(
        session.sessionKey,
        group('dlg-x'),
        owner({ parentSessionId: 'other-session' }),
      ),
      false,
    )
    assert.equal(session._pendingAgentGroups, undefined)
  })
})

describe('SessionManager late delivery (OCV5-180 B1)', () => {
  it('writes one restricted continuation; retry is idempotent; conflict suppressed', async () => {
    const captured = makeCapturingSink()
    setV3MasterSinkSingleton(captured.sink)
    try {
      const { sm } = makeSessions()
      const g = group('dlg-late', {
        engineBillings: [
          {
            requestId: 'c'.repeat(32),
            turnKey: 'd'.repeat(64),
            parentTurnKey: OWNER_TURN_KEY,
            parentSessionId: 'wsess-owner',
            delegateAgentId: 'coding-assistant',
            engineSessionId: `oceng-${'e'.repeat(48)}`,
            status: 'success',
            durationMs: 100,
            usage: { input_tokens: 1, output_tokens: 1 },
          } as never,
        ],
      })
      assert.equal(await sm.deliverLateDelegateAgentGroup({ owner: owner(), group: g }), true)
      // duplicate replay of the SAME completion → no second tape
      assert.equal(await sm.deliverLateDelegateAgentGroup({ owner: owner(), group: g }), true)
      assert.equal(captured.payloads.length, 1, 'same logical run keeps exactly one card')
      const payload = captured.payloads[0]!
      assert.equal(payload.continuationOfTurnKey, OWNER_TURN_KEY)
      assert.equal(payload.text, '')
      assert.equal(payload.status, 'completed')
      assert.equal(payload.turnIndex, 3)
      assert.match(payload.turnKey as string, /^[0-9a-f]{64}$/)
      assert.deepEqual(payload.agentGroups?.map((x) => x.runId), ['dlg-late'])
      // conflicting content under the same run → observable, no second write
      assert.equal(
        await sm.deliverLateDelegateAgentGroup({
          owner: owner(),
          group: group('dlg-late', { resultSummary: 'conflicting rewrite' }),
        }),
        false,
      )
      assert.equal(captured.payloads.length, 1, 'conflict must not mint a second card')
    } finally {
      setV3MasterSinkSingleton(null)
    }
  })

  it('cross-session sessionKey/peer mismatch never schedules a write', async () => {
    const captured = makeCapturingSink()
    setV3MasterSinkSingleton(captured.sink)
    try {
      const { sm, session } = makeSessions()
      assert.equal(
        await sm.deliverLateDelegateAgentGroup({
          owner: owner({ parentSessionId: 'other-session' }),
          group: group('dlg-x'),
          sessionKey: session.sessionKey,
        }),
        false,
      )
      assert.equal(captured.payloads.length, 0)
    } finally {
      setV3MasterSinkSingleton(null)
    }
  })

  it('invalid locator never schedules a write', async () => {
    const captured = makeCapturingSink()
    setV3MasterSinkSingleton(captured.sink)
    try {
      const { sm } = makeSessions()
      assert.equal(
        await sm.deliverLateDelegateAgentGroup({
          owner: owner({ parentTurnKey: 'no-hex' }),
          group: group('dlg-x'),
        }),
        false,
      )
      assert.equal(captured.payloads.length, 0)
    } finally {
      setV3MasterSinkSingleton(null)
    }
  })

  it('queued outcome is reliable waiting, not a drop: retry keeps one card', async () => {
    const captured = makeCapturingSink({ ok: false, queued: true })
    setV3MasterSinkSingleton(captured.sink)
    try {
      const { sm } = makeSessions()
      const g = group('dlg-q')
      assert.equal(await sm.deliverLateDelegateAgentGroup({ owner: owner(), group: g }), true)
      await Promise.resolve()
      // a later replay of the same completion while master is unreachable must
      // not enqueue a duplicate tape; the fsynced drainer owns delivery.
      assert.equal(await sm.deliverLateDelegateAgentGroup({ owner: owner(), group: g }), true)
      assert.equal(captured.payloads.length, 1)
    } finally {
      setV3MasterSinkSingleton(null)
    }
  })

  it('stageDurable failure does not cache-swallow the same payload retry', async () => {
    let stages = 0
    const sink = makeV3MasterSink({
      config: { baseUrl: 'http://master.test:18791', bearer: `oc-v3.7.${'a'.repeat(64)}` },
      retryQueue: {
        stageDurable: async () => {
          stages += 1
          if (stages === 1) throw new Error('controlled stageDurable EIO')
          return 'receipt-2'
        },
        ackDurable: async () => {},
        enqueueDurable: async () => {},
        drainOnce: async () => ({
          considered: 0, drained: 0, retried: 0, ttlDropped: 0, fatalDropped: 0, errors: 0, pending: 0,
        }),
        kick: () => {},
        startPeriodic: () => {},
        stopPeriodic: () => {},
        pendingCount: async () => 0,
        hasEntryForDispatch: async () => false,
      },
      attemptSendImpl: async () => ({}),
    })
    setV3MasterSinkSingleton(sink)
    try {
      const { sm } = makeSessions()
      const g = group('dlg-retry')
      assert.equal(await sm.deliverLateDelegateAgentGroup({ owner: owner(), group: g }), true)
      await sm.awaitPendingPersistence()
      assert.equal(await sm.deliverLateDelegateAgentGroup({ owner: owner(), group: g }), true)
      await sm.awaitPendingPersistence()
      assert.equal(stages, 2, 'same frozen payload must retry after non-durable drop')
    } finally {
      setV3MasterSinkSingleton(null)
    }
  })

  it('concurrent same-payload late deliveries merge into one inflight write', async () => {
    let stages = 0
    const sink = makeV3MasterSink({
      config: { baseUrl: 'http://master.test:18791', bearer: `oc-v3.7.${'a'.repeat(64)}` },
      retryQueue: {
        stageDurable: async () => {
          stages += 1
          await new Promise((resolve) => setTimeout(resolve, 20))
          return `receipt-${stages}`
        },
        ackDurable: async () => {},
        enqueueDurable: async () => {},
        drainOnce: async () => ({
          considered: 0, drained: 0, retried: 0, ttlDropped: 0, fatalDropped: 0, errors: 0, pending: 0,
        }),
        kick: () => {},
        startPeriodic: () => {},
        stopPeriodic: () => {},
        pendingCount: async () => 0,
        hasEntryForDispatch: async () => false,
      },
      attemptSendImpl: async () => ({}),
    })
    setV3MasterSinkSingleton(sink)
    try {
      const { sm } = makeSessions()
      const g = group('dlg-merge')
      assert.equal(await sm.deliverLateDelegateAgentGroup({ owner: owner(), group: g }), true)
      assert.equal(await sm.deliverLateDelegateAgentGroup({ owner: owner(), group: g }), true)
      await sm.awaitPendingPersistence()
      assert.equal(stages, 1)
    } finally {
      setV3MasterSinkSingleton(null)
    }
  })

  it('session_deleted is terminal and does not resurrect', async () => {
    const sink = {
      persistOrQueue: async () => ({ ok: false, queued: false, droppedReason: 'session_deleted: gone' }),
      attemptOnce: async () => {
        throw new Error('not used')
      },
    } as unknown as V3MasterSink
    setV3MasterSinkSingleton(sink)
    try {
      const { sm } = makeSessions()
      const g = group('dlg-deleted')
      assert.equal(await sm.deliverLateDelegateAgentGroup({ owner: owner(), group: g }), true)
      await sm.awaitPendingPersistence()
      assert.equal(await sm.deliverLateDelegateAgentGroup({ owner: owner(), group: g }), false)
    } finally {
      setV3MasterSinkSingleton(null)
    }
  })

  it('acked root run stays unique after FIFO eviction of the admission map', async () => {
    const captured = makeCapturingSink()
    setV3MasterSinkSingleton(captured.sink)
    try {
      const { sm, session } = makeSessions()
      const g = group('dlg-acked-root')
      assert.equal(sm.bufferPendingAgentGroup(session.sessionKey, g, owner()), true)
      const drained = sm.drainPendingAgentGroups(session, OWNER_TURN_KEY)
      type Settler = {
        _settleDrainedOwnerGroups: (
          s: AgentSession,
          turnKey: string,
          groups: DurableAgentGroup[],
          outcome: 'acked' | 'queued' | 'dropped' | 'skipped',
        ) => void
      }
      ;(sm as unknown as Settler)._settleDrainedOwnerGroups(session, OWNER_TURN_KEY, drained, 'acked')
      for (let i = 0; i < 256; i++) {
        const otherTurn = createHash('sha256').update(`acked-churn-${i}`).digest('hex')
        await sm.deliverLateDelegateAgentGroup({
          owner: owner({ parentTurnKey: otherTurn }),
          group: group(`acked-churn-${i}`),
        })
        await sm.awaitPendingPersistence()
      }
      const before = captured.payloads.length
      assert.equal(await sm.deliverLateDelegateAgentGroup({ owner: owner(), group: g }), true)
      await sm.awaitPendingPersistence()
      assert.equal(captured.payloads.length, before, 'acked root run must not mint a continuation after map eviction')
    } finally {
      setV3MasterSinkSingleton(null)
    }
  })

  it('root drain claims the logical run so late does not mint a second card', async () => {
    const captured = makeCapturingSink()
    setV3MasterSinkSingleton(captured.sink)
    try {
      const { sm, session } = makeSessions()
      const g = group('dlg-root')
      assert.equal(sm.bufferPendingAgentGroup(session.sessionKey, g, owner()), true)
      const drained = sm.drainPendingAgentGroups(session, OWNER_TURN_KEY)
      assert.equal(drained.length, 1)
      assert.equal(await sm.deliverLateDelegateAgentGroup({ owner: owner(), group: g }), true)
      await sm.awaitPendingPersistence()
      assert.equal(captured.payloads.length, 0, 'root already contains the run; no continuation')
    } finally {
      setV3MasterSinkSingleton(null)
    }
  })

  it('256 sequential ACK of other owners cannot duplicate a live buffered run', async () => {
    const captured = makeCapturingSink()
    setV3MasterSinkSingleton(captured.sink)
    try {
      const { sm, session } = makeSessions()
      const billed = group('dlg-live', {
        engineBillings: [
          {
            requestId: 'b'.repeat(32),
            turnKey: OWNER_TURN_KEY,
            parentTurnKey: OWNER_TURN_KEY,
            parentSessionId: 'wsess-owner',
            delegateAgentId: 'coding-assistant',
            engineSessionId: `oceng-${'e'.repeat(48)}`,
            status: 'success',
            durationMs: 1,
            usage: { input_tokens: 1, output_tokens: 1 },
          } as never,
        ],
      })
      assert.equal(sm.bufferPendingAgentGroup(session.sessionKey, billed, owner()), true)
      for (let i = 0; i < 256; i++) {
        const otherTurn = createHash('sha256').update(`churn-${i}`).digest('hex')
        assert.equal(
          await sm.deliverLateDelegateAgentGroup({
            owner: owner({ parentTurnKey: otherTurn }),
            group: group(`churn-${i}`),
          }),
          true,
        )
        await sm.awaitPendingPersistence()
      }
      assert.equal(sm.bufferPendingAgentGroup(session.sessionKey, billed, owner()), true)
      const drained = sm.drainPendingAgentGroups(session, OWNER_TURN_KEY)
      assert.equal(drained.length, 1)
      assert.equal(drained[0]?.runId, 'dlg-live')
    } finally {
      setV3MasterSinkSingleton(null)
    }
  })

  it('sink-pending inflight survives other-owner ACK churn; late does not mint a second card', async () => {
    const captured = makeCapturingSink({ ok: false, queued: true })
    setV3MasterSinkSingleton(captured.sink)
    try {
      const { sm, session } = makeSessions()
      const g = group('dlg-pending')
      assert.equal(sm.bufferPendingAgentGroup(session.sessionKey, g, owner()), true)
      const drained = sm.drainPendingAgentGroups(session, OWNER_TURN_KEY)
      assert.equal(drained.length, 1)
      type Settler = {
        _settleDrainedOwnerGroups: (
          s: AgentSession,
          turnKey: string,
          groups: DurableAgentGroup[],
          outcome: 'acked' | 'queued' | 'dropped' | 'skipped',
        ) => void
      }
      ;(sm as unknown as Settler)._settleDrainedOwnerGroups(session, OWNER_TURN_KEY, drained, 'queued')
      const acked = makeCapturingSink()
      setV3MasterSinkSingleton(acked.sink)
      for (let i = 0; i < 256; i++) {
        const otherTurn = createHash('sha256').update(`pending-churn-${i}`).digest('hex')
        await sm.deliverLateDelegateAgentGroup({
          owner: owner({ parentTurnKey: otherTurn }),
          group: group(`pending-churn-${i}`),
        })
        await sm.awaitPendingPersistence()
      }
      assert.equal(await sm.deliverLateDelegateAgentGroup({ owner: owner(), group: g }), true)
      await sm.awaitPendingPersistence()
      assert.equal(
        acked.payloads.filter((p) => p.agentGroups?.some((ag) => ag.runId === 'dlg-pending')).length,
        0,
        'queued root run must not mint a continuation after churn',
      )
    } finally {
      setV3MasterSinkSingleton(null)
    }
  })

  // Cross-root comparisons are master authority tests, not a fake ACK map.
  it('fresh manager stages a late completion without relying on local root state', async () => {
    const captured = makeCapturingSink()
    setV3MasterSinkSingleton(captured.sink)
    try {
      await captured.sink.persistOrQueue({
        sessionId: owner().parentSessionId,
        agentId: 'main',
        turnIndex: 3,
        turnKey: OWNER_TURN_KEY,
        status: 'completed',
        text: 'root answer',
        createdAt: 1,
      })
      const fresh = makeSessions().sm
      const g = group('dlg-absent')
      assert.equal(await fresh.deliverLateDelegateAgentGroup({ owner: owner(), group: g }), true)
      await fresh.awaitPendingPersistence()
      assert.equal(captured.payloads.filter((payload) => payload.continuationOfTurnKey).length, 1)
    } finally {
      setV3MasterSinkSingleton(null)
    }
  })

  it('root persist drop is not durable: late retry of the same run is allowed', async () => {
    const captured = makeCapturingSink()
    setV3MasterSinkSingleton(captured.sink)
    try {
      const { sm, session } = makeSessions()
      const g = group('dlg-root-fail')
      assert.equal(sm.bufferPendingAgentGroup(session.sessionKey, g, owner()), true)
      const drained = sm.drainPendingAgentGroups(session, OWNER_TURN_KEY)
      assert.equal(drained.length, 1)
      type Settler = {
        _settleDrainedOwnerGroups: (
          s: AgentSession,
          turnKey: string,
          groups: DurableAgentGroup[],
          outcome: 'acked' | 'queued' | 'dropped' | 'skipped',
        ) => void
      }
      ;(sm as unknown as Settler)._settleDrainedOwnerGroups(session, OWNER_TURN_KEY, drained, 'dropped')
      assert.equal(await sm.deliverLateDelegateAgentGroup({ owner: owner(), group: g }), true)
      await sm.awaitPendingPersistence()
      assert.equal(captured.payloads.length, 1)
      assert.equal(captured.payloads[0]!.continuationOfTurnKey, OWNER_TURN_KEY)
    } finally {
      setV3MasterSinkSingleton(null)
    }
  })
})

// ── 3. B-R2-1 controlled sink: T1 drain/seal → sink pending → child完成 → T2 ──

class FakeCcbRunner extends EventEmitter {
  lastActivityAt = Date.now()
  isRunning = true
  private submitHandler: (runner: FakeCcbRunner) => void | Promise<void>
  constructor(onSubmit: (runner: FakeCcbRunner) => void | Promise<void>) {
    super()
    this.submitHandler = onSubmit
  }
  setSubmitHandler(onSubmit: (runner: FakeCcbRunner) => void | Promise<void>): void {
    this.submitHandler = onSubmit
  }
  async start(): Promise<void> {}
  interrupt(): boolean {
    return false
  }
  async shutdown(): Promise<void> {}
  clearSessionId(): void {}
  async waitForOutputDrain(): Promise<void> {}
  async submit(): Promise<void> {
    await this.submitHandler(this)
  }
  text(text: string): void {
    this.emit('message', {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
    })
  }
  result(): void {
    this.emit('message', { type: 'result', total_cost_usd: 0, usage: {}, is_error: false })
  }
}

function makeTurnHarness() {
  const sm = new SessionManager({
    version: 1,
    gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
    auth: { mode: 'subscription', claudeCodePath: '' },
    sessions: { dbPath: '' },
  } as never)
  let session!: AgentSession
  const runner = new FakeCcbRunner((r) => {
    r.text('answer')
    r.result()
  })
  const adapter = new CcbAdapter({} as never, runner as never)
  session = {
    sessionKey: 'agent:main:webchat:dm:br21',
    agentId: 'main',
    channel: 'webchat',
    peerId: 'wsess-br21',
    userId: 'user-1',
    title: 't',
    startedAt: Date.now(),
    runner: adapter,
    ccbSessionId: null,
    lock: Promise.resolve(),
    lastUsedAt: 0,
    totalCostUSD: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    turns: 0,
    _lastCcbCumulativeCost: 0,
    toolUseIdToName: new Map(),
    executionTarget: { kind: 'local' },
    providerTag: 'ccb',
  } as unknown as AgentSession
  ;(sm as unknown as { sessions: Map<string, AgentSession> }).sessions.set(session.sessionKey, session)
  return { sm, session, runner }
}

async function waitFor(predicate: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('B-R2-1 controlled sink: late child lands as T1 continuation, T2 stays clean', () => {
  it('seal-after path: one continuation card for T1, zero pollution in T2, no duplicate', async () => {
    const payloads: V3MasterSinkPayload[] = []
    let releaseFirst!: (value: unknown) => void
    const firstGate = new Promise((resolve) => {
      releaseFirst = resolve
    })
    let firstCall = true
    const sink = {
      persistOrQueue: async (payload: V3MasterSinkPayload) => {
        payloads.push(payload)
        if (firstCall) {
          firstCall = false
          await firstGate
        }
        return { ok: true } as never
      },
      attemptOnce: async () => {
        throw new Error('not used')
      },
    } as unknown as V3MasterSink
    setV3MasterSinkSingleton(sink)
    try {
      const { sm, session } = makeTurnHarness()
      const requestId = 'f'.repeat(32)
      const t1 = sm.submit(session, 'T1 question', () => {}, undefined, undefined, requestId)
      // T1's tape payload is staged (payload frozen + owner sealed) while the
      // master ACK is still pending — this is the B-R2-1 window.
      await waitFor(() => payloads.length >= 1)
      const ownerLocator = {
        parentSessionId: session.peerId,
        parentTurnKey: session._currentTurnKey!,
        turnIndex: session._currentTurnIndex!,
      }
      const lateGroup = group('dlg-br21', {
        engineBillings: [
          {
            requestId: '1'.repeat(32),
            turnKey: '2'.repeat(64),
            parentTurnKey: ownerLocator.parentTurnKey,
            parentSessionId: ownerLocator.parentSessionId,
            delegateAgentId: 'coding-assistant',
            engineSessionId: `oceng-${'3'.repeat(48)}`,
            status: 'success',
            durationMs: 50,
            usage: { input_tokens: 2, output_tokens: 2 },
          } as never,
        ],
      })
      // child completes inside the window: exact-owner buffer must reject.
      assert.equal(
        sm.bufferPendingAgentGroup(session.sessionKey, lateGroup, ownerLocator),
        false,
        'sealed owner must reject in-memory buffering',
      )
      assert.equal(await sm.deliverLateDelegateAgentGroup({ owner: ownerLocator, group: lateGroup }), true)
      await waitFor(() => payloads.length >= 2)
      // replay of the same completion must not mint a second card
      assert.equal(await sm.deliverLateDelegateAgentGroup({ owner: ownerLocator, group: lateGroup }), true)

      releaseFirst(undefined)
      await t1

      // T2 runs and completes afterwards.
      const t2 = sm.submit(session, 'T2 question', () => {}, undefined, undefined, 'e'.repeat(32))
      await t2

      const continuation = payloads.find((p) => p.continuationOfTurnKey !== undefined)
      assert.ok(continuation, 'late completion produced a continuation tape')
      assert.equal(continuation.continuationOfTurnKey, ownerLocator.parentTurnKey)
      assert.deepEqual(continuation.agentGroups?.map((g) => g.runId), ['dlg-br21'])
      assert.equal(continuation.text, '')
      // exactly ONE tape in the whole window carries agentGroups
      assert.equal(payloads.filter((p) => (p.agentGroups?.length ?? 0) > 0).length, 1)
      // the two root turn tapes are clean: no delegation content leaked into T2
      const rootTapes = payloads.filter((p) => p.continuationOfTurnKey === undefined)
      assert.equal(rootTapes.length, 2)
      for (const tape of rootTapes) {
        assert.equal(tape.agentGroups, undefined, 'root tapes must not carry late groups')
      }
      // no duplicate: 3 payloads total (T1, continuation, T2)
      assert.equal(payloads.length, 3)
    } finally {
      setV3MasterSinkSingleton(null)
    }
  })

  it('seal-before contrast: the same group buffered mid-turn rides the owner tape', async () => {
    const payloads: V3MasterSinkPayload[] = []
    const sink = {
      persistOrQueue: async (payload: V3MasterSinkPayload) => {
        payloads.push(payload)
        return { ok: true } as never
      },
      attemptOnce: async () => {
        throw new Error('not used')
      },
    } as unknown as V3MasterSink
    setV3MasterSinkSingleton(sink)
    try {
      const { sm, session, runner } = makeTurnHarness()
      runner.setSubmitHandler((r: FakeCcbRunner) => {
        r.text('answer')
        // child completes while the owner turn is still open
        const ownerLocator = {
          parentSessionId: session.peerId,
          parentTurnKey: session._currentTurnKey!,
          turnIndex: session._currentTurnIndex!,
        }
        assert.equal(
          sm.bufferPendingAgentGroup(session.sessionKey, group('dlg-early'), ownerLocator),
          true,
        )
        r.result()
      })
      await sm.submit(session, 'T1 with live child', () => {}, undefined, undefined, 'd'.repeat(32))
      assert.equal(payloads.length, 1)
      assert.deepEqual(payloads[0]!.agentGroups?.map((g) => g.runId), ['dlg-early'])
      assert.equal(payloads[0]!.continuationOfTurnKey, undefined)
      // and no continuation tape was minted
      assert.equal(payloads.filter((p) => p.continuationOfTurnKey !== undefined).length, 0)
    } finally {
      setV3MasterSinkSingleton(null)
    }
  })
})

// ── 4. server launch-freeze + collection routing (real handleDelegateTask) ──

describe('handleDelegateTask owner freeze and collection routing (OCV5-180 B1)', { concurrency: 1 }, () => {
  const PARENT_KEY = 'agent:main:webchat:dm:wsess-late-owner'
  const PARENT_PEER = 'wsess-late-owner'
  const PARENT_TURN_KEY = 'a'.repeat(64)

  function makeGateway(opts: { bufferResult?: boolean }) {
    const bufferCalls: Array<{ sessionKey: string; group: DurableAgentGroup; owner?: unknown }> = []
    const lateCalls: Array<{ owner: unknown; group: DurableAgentGroup }> = []
    const parentSession = {
      sessionKey: PARENT_KEY,
      channel: 'webchat',
      peerId: PARENT_PEER,
      agentId: 'main',
      userId: '1',
      repoSessionId: undefined,
      _currentTurnKey: PARENT_TURN_KEY,
      _currentTurnIndex: 7,
      runner: Object.assign(new EventEmitter(), { lastActivityAt: 1 }),
    }
    const gw = Object.create(Gateway.prototype) as any
    gw._shuttingDown = false
    gw._activeDelegations = 0
    gw._activeDelegationsByParent = new Map()
    gw._hiddenDelegateGuard = new PerTurnDelegationGuard()
    gw._memberDelegateGuard = new PerTurnDelegationGuard(8)
    gw._delegateQueuePollMs = 10
    gw._readDelegateMemoryPressure = () => null
    gw.log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
    gw.deps = {
      config: {
        version: 1,
        provider: 'anthropic',
        gateway: { bind: '127.0.0.1', port: 18789, accessToken: 'test' },
        auth: { mode: 'subscription', claudeCodePath: '/tmp/ccb' },
        defaults: { model: 'glm-5.2', permissionMode: 'default' },
        channels: { webchat: { enabled: true } },
      },
    }
    gw._getAgentsConfig = async () => ({
      default: 'main',
      agents: [
        { id: 'main', provider: 'anthropic', model: 'glm-5.2' },
        { id: 'coding-assistant' },
      ],
    })
    gw._runLog = { start: () => ({}), complete: () => {} }
    gw.sessions = {
      flushSessionTailFolding: async () => {},
      destroySession: async () => {},
      getByKey: (key: string) => (key === PARENT_KEY ? parentSession : undefined),
      getOrCreate: async (input: any) => ({
        agentId: input.agent?.id ?? 'coding-assistant',
        currentTurnStatus: null,
        runner: Object.assign(new EventEmitter(), {
          lastActivityAt: 1,
          engineId: 'ccb',
          interrupt: () => {},
          shutdown: async () => {},
          waitForOutputDrain: async () => {},
          sendPermissionResponse: () => {},
        }),
      }),
      submit: async (_s: unknown, _p: string, onEvent: (e: any) => void) => {
        onEvent({ kind: 'block', block: { kind: 'text', text: '子任务完成' } })
        onEvent({ kind: 'final', meta: { cost: 0, inputTokens: 1, outputTokens: 1, turn: 1 } })
      },
      bufferPendingAgentGroup: (sessionKey: string, g: DurableAgentGroup, o?: unknown) => {
        bufferCalls.push({ sessionKey, group: g, owner: o })
        return opts.bufferResult !== false
      },
      deliverLateDelegateAgentGroup: (args: { owner: unknown; group: DurableAgentGroup }) => {
        lateCalls.push(args)
        return true
      },
    }
    gw.deliver = () => {}
    return { gw, bufferCalls, lateCalls, parentSession }
  }

  async function delegate(gw: any, body: Record<string, unknown>) {
    const req: any = { method: 'POST', headers: {} }
    gw.readBody = async () => JSON.stringify(body)
    let status = 0
    let raw = ''
    const res: any = {
      writeHead: (code: number) => {
        status = code
      },
      end: (chunk?: unknown) => {
        raw = String(chunk ?? '')
      },
    }
    await gw.handleDelegateTask(req, res, 'coding-assistant')
    return { status, body: raw ? JSON.parse(raw) : {} }
  }

  it('freezes the exact owner at launch and passes it to the buffer', async () => {
    const { gw, bufferCalls, lateCalls } = makeGateway({ bufferResult: true })
    const r = await delegate(gw, {
      goal: '子任务',
      sourceAgent: 'main',
      parentSessionKey: PARENT_KEY,
    })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(bufferCalls.length, 1)
    const call = bufferCalls[0]!
    assert.equal(call.sessionKey, PARENT_KEY)
    assert.deepEqual(call.owner, {
      parentSessionId: PARENT_PEER,
      parentTurnKey: PARENT_TURN_KEY,
      turnIndex: 7,
    })
    assert.equal(lateCalls.length, 0)
    // owner map entry is consumed (bounded memory)
    assert.equal(gw._delegateOwnerByRunId?.size, 0)
  })

  it('routes to the persistent late path when the exact-owner buffer rejects', async () => {
    const { gw, bufferCalls, lateCalls } = makeGateway({ bufferResult: false })
    const r = await delegate(gw, {
      goal: '晚到子任务',
      sourceAgent: 'main',
      parentSessionKey: PARENT_KEY,
    })
    assert.equal(r.status, 200)
    assert.equal(bufferCalls.length, 1, 'buffer was attempted with the frozen owner')
    assert.equal(lateCalls.length, 1, 'rejection must fall through to the late path')
    assert.equal((lateCalls[0]!.owner as DelegateOwnerTurnLocator).parentTurnKey, PARENT_TURN_KEY)
    assert.equal((lateCalls[0]!.group as DurableAgentGroup).runId, bufferCalls[0]!.group.runId)
  })

  it('falls back to ownerless buffering when no webchat progress target exists', async () => {
    const { gw, bufferCalls, lateCalls } = makeGateway({ bufferResult: true })
    const r = await delegate(gw, {
      goal: '无父任务',
      sourceAgent: 'main',
      parentSessionKey: 'agent:main:webchat:dm:not-routed',
    })
    assert.equal(r.status, 200)
    // resolveDelegateProgressTarget found no webchat session → no locator, no
    // buffer call for the card at all (legacy degrade), and never a late write.
    assert.equal(bufferCalls.length, 0)
    assert.equal(lateCalls.length, 0)
  })
})

describe('handleDelegateTask FIFO eviction counterexample (OCV5-180 B1)', { concurrency: 1 }, () => {
  it('512 capacity-rejected attempts cannot evict a live frozen owner onto T2', async () => {
    const PARENT_KEY = 'agent:main:webchat:dm:wsess-late-owner'
    const PARENT_PEER = 'wsess-late-owner'
    const PARENT_TURN_KEY = OWNER_TURN_KEY
    let releaseFirst: (() => void) | undefined
    const bufferCalls: Array<{ sessionKey: string; group: DurableAgentGroup; owner?: unknown }> = []
    const parentSession = {
      sessionKey: PARENT_KEY,
      channel: 'webchat',
      peerId: PARENT_PEER,
      agentId: 'main',
      userId: '1',
      repoSessionId: undefined,
      _currentTurnKey: PARENT_TURN_KEY,
      _currentTurnIndex: 7,
      runner: Object.assign(new EventEmitter(), { lastActivityAt: 1 }),
    }
    type GwFifoFixture = {
      handleDelegateTask: (req: unknown, res: unknown, agentId: string) => Promise<void>
      _shuttingDown: boolean
      _activeDelegations: number
      _activeDelegationsByParent: Map<string, Set<string>>
      _hiddenDelegateGuard: PerTurnDelegationGuard
      _memberDelegateGuard: PerTurnDelegationGuard
      _delegateQueuePollMs: number
      _readDelegateMemoryPressure: () => null
      log: { debug: () => void; info: () => void; warn: () => void; error: () => void }
      deps: unknown
      _getAgentsConfig: () => Promise<unknown>
      _runLog: { start: () => object; complete: () => void }
      sessions: unknown
      deliver: () => void
      readBody: () => Promise<string>
      _waitForDelegateCapacity: () => Promise<{ status: 'ok' } | { status: 'queue_full'; blocked: { kind: 'memory'; pct: number; limitPct: number } }>
      _applyDelegateCapacityReject: (
        input: unknown,
        reject: { httpStatus: number; message: string; failureClass?: string },
      ) => Promise<{ kind: 'rejected'; httpStatus: number; message: string; failureClass?: string }>
    }
    const gw = Object.create(Gateway.prototype) as GwFifoFixture
    gw._shuttingDown = false
    gw._activeDelegations = 0
    gw._activeDelegationsByParent = new Map()
    gw._hiddenDelegateGuard = new PerTurnDelegationGuard()
    gw._memberDelegateGuard = new PerTurnDelegationGuard(8)
    gw._delegateQueuePollMs = 10
    gw._readDelegateMemoryPressure = () => null
    gw.log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
    gw.deps = {
      config: {
        version: 1,
        provider: 'anthropic',
        gateway: { bind: '127.0.0.1', port: 18789, accessToken: 'test' },
        auth: { mode: 'subscription', claudeCodePath: '/tmp/ccb' },
        defaults: { model: 'glm-5.2', permissionMode: 'default' },
        channels: { webchat: { enabled: true } },
      },
    }
    gw._getAgentsConfig = async () => ({
      default: 'main',
      agents: [
        { id: 'main', provider: 'anthropic', model: 'glm-5.2' },
        { id: 'coding-assistant' },
      ],
    })
    gw._runLog = { start: () => ({}), complete: () => {} }
    gw.sessions = {
      flushSessionTailFolding: async () => {},
      destroySession: async () => {},
      getByKey: (key: string) => (key === PARENT_KEY ? parentSession : undefined),
      getOrCreate: async (input: { agent?: { id?: string } }) => ({
        agentId: input.agent?.id ?? 'coding-assistant',
        currentTurnStatus: null,
        runner: Object.assign(new EventEmitter(), {
          lastActivityAt: 1,
          engineId: 'ccb',
          interrupt: () => {},
          shutdown: async () => {},
          waitForOutputDrain: async () => {},
          sendPermissionResponse: () => {},
        }),
      }),
      submit: async (
        _s: unknown,
        _p: string,
        onEvent: (event: { kind: string; block?: { kind: string; text: string }; meta?: { cost: number; inputTokens: number; outputTokens: number; turn: number } }) => void,
      ) => {
        await new Promise<void>((resolve) => {
          releaseFirst = () => {
            onEvent({ kind: 'block', block: { kind: 'text', text: 'done' } })
            onEvent({ kind: 'final', meta: { cost: 0, inputTokens: 1, outputTokens: 1, turn: 1 } })
            resolve()
          }
        })
      },
      bufferPendingAgentGroup: (sessionKey: string, g: DurableAgentGroup, o?: unknown) => {
        bufferCalls.push({ sessionKey, group: g, owner: o })
        return true
      },
      deliverLateDelegateAgentGroup: () => true,
    }
    gw.deliver = () => {}
    gw._applyDelegateCapacityReject = async (
      _input: unknown,
      reject: { httpStatus: number; message: string; failureClass?: string },
    ) => ({
      kind: 'rejected' as const,
      httpStatus: reject.httpStatus,
      message: reject.message,
      failureClass: reject.failureClass,
    })
    const run = async (goal: string) => {
      const req = { method: 'POST', headers: {} }
      gw.readBody = async () => JSON.stringify({ goal, sourceAgent: 'main', parentSessionKey: PARENT_KEY })
      let status = 0
      const res = {
        writeHead: (code: number) => {
          status = code
        },
        end: () => {},
      }
      await gw.handleDelegateTask(req, res, 'coding-assistant')
      return status
    }
    const first = run('活任务')
    const deadline = Date.now() + 5000
    while (!releaseFirst) {
      if (Date.now() > deadline) throw new Error('first submit did not start')
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    gw._waitForDelegateCapacity = async () => ({
      status: 'queue_full' as const,
      blocked: { kind: 'memory' as const, pct: 95, limitPct: 85 },
    })
    for (let i = 0; i < 512; i++) {
      if (i % 7 === 0) gw._memberDelegateGuard.resetForParent(PARENT_KEY)
      await run(`reject-${i}`)
    }
    parentSession._currentTurnKey = OTHER_TURN_KEY
    releaseFirst()
    await first
    assert.equal(bufferCalls.length, 1)
    assert.deepEqual(bufferCalls[0]!.owner, {
      parentSessionId: PARENT_PEER,
      parentTurnKey: PARENT_TURN_KEY,
      turnIndex: 7,
    })
  })
})
})
