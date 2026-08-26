import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import {
  ackCcbTaskNotificationDelivered,
  beginCcbLocalAgentInject,
  buildCcbLocalAgentCallbackText,
  CCB_LOCAL_AGENT_INJECT_MAX_FINALIZE_ROUNDS,
  CCB_LOCAL_AGENT_INJECT_PENDING_TTL_MS,
  ccbLocalAgentCallbackClientMessageId,
  ccbLocalAgentCallbackIdempotencyKey,
  ccbLocalAgentPendingSizeForTest,
  clearCcbLocalAgentPendingForSession,
  completeCcbLocalAgentInject,
  evaluateCcbLocalAgentInjectLimit,
  failCcbLocalAgentInject,
  getCcbLocalAgentAbandonReason,
  getCcbLocalAgentCallbackState,
  getCcbLocalAgentPendingMetaForTest,
  noteCcbLocalAgentFinalizeRoundExhausted,
  noteCcbTaskNotification,
  resetCcbLocalAgentCallbackDedupeForTest,
  sessionHasInFlightTurn,
  setCcbLocalAgentFirstSeenAtForTest,
  takePendingInjectionsForSession,
} from '../ccbLocalAgentCallback.js'
import {
  ORIGIN_INJECT_RETRY_BUDGET,
  runBoundedOriginInjectBackoff,
} from '../originInjectBackoff.js'

const SESSION = 'agent:main:webchat:dm:sess-1'

function note(
  taskId: string,
  hasInFlightTurn: boolean,
  extra: { status?: string; outputFile?: string; summary?: string } = {},
) {
  return noteCcbTaskNotification({
    sessionKey: SESSION,
    hasInFlightTurn,
    userId: 'default',
    notification: {
      taskId,
      status: extra.status ?? 'completed',
      outputFile: extra.outputFile ?? '/tmp/output/' + taskId,
      summary: extra.summary ?? `Agent "${taskId}" completed`,
    },
  })
}

function failRound(taskId: string) {
  failCcbLocalAgentInject(SESSION, taskId)
  return noteCcbLocalAgentFinalizeRoundExhausted(SESSION, taskId)
}

afterEach(() => {
  resetCcbLocalAgentCallbackDedupeForTest()
})

describe('ccbLocalAgentCallback text + ids', () => {
  it('stamps deterministic clientMessageId and dedupe key', () => {
    assert.equal(ccbLocalAgentCallbackClientMessageId('agt-abc'), 'ccb-tn-agt-abc')
    assert.equal(
      ccbLocalAgentCallbackIdempotencyKey('agent:main:webchat:dm:sess-1', 'agt-abc'),
      'ccb-local-agent:agent:main:webchat:dm:sess-1:agt-abc',
    )
  })

  it('points the injected user turn at output_file and a short summary', () => {
    const text = buildCcbLocalAgentCallbackText({
      taskId: 'agt-1',
      status: 'completed',
      outputFile: '/tmp/output/agt-1',
      summary: 'Agent "research" completed',
    })
    assert.match(text, /output_file/)
    assert.match(text, /\/tmp\/output\/agt-1/)
    assert.match(text, /Agent "research" completed/)
    assert.match(text, /完成回调/)
  })

  it('detects in-flight parent turns from either counter', () => {
    assert.equal(sessionHasInFlightTurn({}), false)
    assert.equal(sessionHasInFlightTurn({ _activeTurnCount: 1 }), true)
    assert.equal(sessionHasInFlightTurn({ _activeClientTurnCount: 2 }), true)
  })
})

describe('blocker 1: notify after mid-turn snapshot / no more tool boundary', () => {
  it('does not treat in-flight as already-consumed; finalize injects exactly once', () => {
    const started: string[] = []
    assert.equal(note('agt-late', true), 'wait')
    assert.equal(getCcbLocalAgentCallbackState(SESSION, 'agt-late'), 'pending')
    assert.deepEqual(takePendingInjectionsForSession(SESSION).map((x) => x.payload.taskId), [
      'agt-late',
    ])

    assert.equal(beginCcbLocalAgentInject(SESSION, 'agt-late'), true)
    started.push('agt-late')
    completeCcbLocalAgentInject(SESSION, 'agt-late')

    assert.equal(getCcbLocalAgentCallbackState(SESSION, 'agt-late'), 'delivered')
    assert.equal(note('agt-late', false), 'noop')
    assert.equal(beginCcbLocalAgentInject(SESSION, 'agt-late'), false)
    assert.equal(takePendingInjectionsForSession(SESSION).length, 0)
    assert.deepEqual(started, ['agt-late'])
  })

  it('idle parent (no in-flight turn) injects immediately and only once', () => {
    assert.equal(note('agt-idle', false), 'inject')
    assert.equal(beginCcbLocalAgentInject(SESSION, 'agt-idle'), true)
    completeCcbLocalAgentInject(SESSION, 'agt-idle')
    assert.equal(note('agt-idle', false), 'noop')
    assert.equal(takePendingInjectionsForSession(SESSION).length, 0)
  })
})

describe('blocker 2: ack vs finalize mutex', () => {
  it('mid-turn ack before finalize: gateway does not inject', () => {
    assert.equal(note('agt-acked', true), 'wait')
    assert.equal(ackCcbTaskNotificationDelivered({ sessionKey: SESSION, taskId: 'agt-acked' }), 'acked')
    assert.equal(getCcbLocalAgentCallbackState(SESSION, 'agt-acked'), 'delivered')
    assert.equal(takePendingInjectionsForSession(SESSION).length, 0)
    assert.equal(beginCcbLocalAgentInject(SESSION, 'agt-acked'), false)
  })

  it('ack vs finalize race: finalize first, then ack aborts inject', () => {
    assert.equal(note('agt-race', true), 'wait')
    const due = takePendingInjectionsForSession(SESSION)
    assert.equal(due.length, 1)
    assert.equal(beginCcbLocalAgentInject(SESSION, 'agt-race'), true)
    assert.equal(ackCcbTaskNotificationDelivered({ sessionKey: SESSION, taskId: 'agt-race' }), 'acked')
    assert.equal(getCcbLocalAgentCallbackState(SESSION, 'agt-race'), 'delivered')
    failCcbLocalAgentInject(SESSION, 'agt-race')
    assert.equal(getCcbLocalAgentCallbackState(SESSION, 'agt-race'), 'delivered')
    assert.equal(takePendingInjectionsForSession(SESSION).length, 0)
  })

  it('ack arriving before the bookend still suppresses inject', () => {
    assert.equal(ackCcbTaskNotificationDelivered({ sessionKey: SESSION, taskId: 'agt-early' }), 'acked')
    assert.equal(note('agt-early', false), 'noop')
    assert.equal(beginCcbLocalAgentInject(SESSION, 'agt-early'), false)
  })
})

describe('blocker 3: retryable inject keeps pending and retries once', () => {
  it('BUSY then success injects exactly once', async () => {
    assert.equal(note('agt-busy', false), 'inject')
    assert.equal(beginCcbLocalAgentInject(SESSION, 'agt-busy'), true)

    const codes: string[] = []
    let calls = 0
    const result = await runBoundedOriginInjectBackoff({
      sleep: async () => {},
      shouldAbort: () => getCcbLocalAgentCallbackState(SESSION, 'agt-busy') === 'delivered',
      tryOnce: async () => {
        calls += 1
        if (calls === 1) {
          failCcbLocalAgentInject(SESSION, 'agt-busy')
          assert.equal(getCcbLocalAgentCallbackState(SESSION, 'agt-busy'), 'pending')
          assert.equal(beginCcbLocalAgentInject(SESSION, 'agt-busy'), true)
          return { kind: 'retryable_failure', code: 'ORIGIN_SESSION_BUSY' }
        }
        codes.push('injected')
        completeCcbLocalAgentInject(SESSION, 'agt-busy')
        return { kind: 'injected' }
      },
    })
    assert.equal(result.kind, 'injected')
    assert.equal(calls, 2)
    assert.deepEqual(codes, ['injected'])
    assert.equal(getCcbLocalAgentCallbackState(SESSION, 'agt-busy'), 'delivered')
    assert.equal(note('agt-busy', false), 'noop')
  })

  it('NO_TRANSPORT then success injects exactly once', async () => {
    assert.equal(note('agt-nt', false), 'inject')
    assert.equal(beginCcbLocalAgentInject(SESSION, 'agt-nt'), true)
    let calls = 0
    const result = await runBoundedOriginInjectBackoff({
      sleep: async () => {},
      tryOnce: async () => {
        calls += 1
        if (calls === 1) {
          failCcbLocalAgentInject(SESSION, 'agt-nt')
          beginCcbLocalAgentInject(SESSION, 'agt-nt')
          return { kind: 'retryable_failure', code: 'NO_TRANSPORT' }
        }
        completeCcbLocalAgentInject(SESSION, 'agt-nt')
        return { kind: 'injected' }
      },
    })
    assert.equal(result.kind, 'injected')
    assert.equal(calls, 2)
    assert.equal(getCcbLocalAgentCallbackState(SESSION, 'agt-nt'), 'delivered')
  })

  it('retry budget exhausted keeps pending so a later finalize can retry', async () => {
    assert.equal(note('agt-ex', false), 'inject')
    assert.equal(beginCcbLocalAgentInject(SESSION, 'agt-ex'), true)
    const delays: number[] = []
    let exhausted = 0
    const result = await runBoundedOriginInjectBackoff({
      sleep: async (ms) => {
        delays.push(ms)
      },
      onBudgetExhausted: () => {
        exhausted += 1
        failCcbLocalAgentInject(SESSION, 'agt-ex')
        assert.equal(failRound('agt-ex'), undefined)
      },
      tryOnce: async () => ({ kind: 'retryable_failure', code: 'ORIGIN_SESSION_BUSY' }),
    })
    assert.equal(result.kind, 'fallback')
    assert.equal(exhausted, 1)
    assert.equal(delays.length, ORIGIN_INJECT_RETRY_BUDGET)
    assert.equal(delays[0], 500)
    assert.equal(delays.at(-1), 5_000)
    assert.equal(getCcbLocalAgentCallbackState(SESSION, 'agt-ex'), 'pending')
    assert.equal(getCcbLocalAgentAbandonReason(SESSION, 'agt-ex'), undefined)
    assert.equal(note('agt-ex', false), 'inject')
    assert.deepEqual(takePendingInjectionsForSession(SESSION).map((x) => x.payload.taskId), [
      'agt-ex',
    ])
    assert.equal(beginCcbLocalAgentInject(SESSION, 'agt-ex'), true)
  })

  it('later finalize after budget exhaust injects exactly once', async () => {
    assert.equal(note('agt-retry', false), 'inject')
    assert.equal(beginCcbLocalAgentInject(SESSION, 'agt-retry'), true)

    const first = await runBoundedOriginInjectBackoff({
      sleep: async () => {},
      onBudgetExhausted: () => {
        failCcbLocalAgentInject(SESSION, 'agt-retry')
        assert.equal(noteCcbLocalAgentFinalizeRoundExhausted(SESSION, 'agt-retry'), undefined)
      },
      tryOnce: async () => ({ kind: 'retryable_failure', code: 'ORIGIN_SESSION_BUSY' }),
    })
    assert.equal(first.kind, 'fallback')
    assert.equal(getCcbLocalAgentCallbackState(SESSION, 'agt-retry'), 'pending')
    assert.equal(takePendingInjectionsForSession(SESSION).length, 1)
    assert.equal(getCcbLocalAgentPendingMetaForTest(SESSION, 'agt-retry')?.finalizeRetryRounds, 1)

    assert.equal(beginCcbLocalAgentInject(SESSION, 'agt-retry'), true)
    let calls = 0
    const second = await runBoundedOriginInjectBackoff({
      sleep: async () => {},
      tryOnce: async () => {
        calls += 1
        completeCcbLocalAgentInject(SESSION, 'agt-retry')
        return { kind: 'injected' }
      },
    })
    assert.equal(second.kind, 'injected')
    assert.equal(calls, 1)
    assert.equal(getCcbLocalAgentCallbackState(SESSION, 'agt-retry'), 'delivered')
    assert.equal(getCcbLocalAgentAbandonReason(SESSION, 'agt-retry'), undefined)
    assert.equal(note('agt-retry', false), 'noop')
    assert.equal(beginCcbLocalAgentInject(SESSION, 'agt-retry'), false)
    assert.equal(takePendingInjectionsForSession(SESSION).length, 0)
  })

  it('abandons observably after max finalize rounds', () => {
    assert.equal(note('agt-cap', false), 'inject')
    const reasons: Array<string | undefined> = []
    for (let i = 0; i < CCB_LOCAL_AGENT_INJECT_MAX_FINALIZE_ROUNDS; i += 1) {
      assert.equal(beginCcbLocalAgentInject(SESSION, 'agt-cap'), true)
      reasons.push(failRound('agt-cap'))
    }
    assert.deepEqual(
      reasons.slice(0, -1),
      Array(CCB_LOCAL_AGENT_INJECT_MAX_FINALIZE_ROUNDS - 1).fill(undefined),
    )
    assert.equal(reasons.at(-1), 'max_finalize_rounds')
    assert.equal(getCcbLocalAgentCallbackState(SESSION, 'agt-cap'), 'delivered')
    assert.equal(getCcbLocalAgentAbandonReason(SESSION, 'agt-cap'), 'max_finalize_rounds')
    assert.equal(getCcbLocalAgentPendingMetaForTest(SESSION, 'agt-cap')?.finalizeRetryRounds, 5)
    assert.equal(note('agt-cap', false), 'noop')
    assert.equal(takePendingInjectionsForSession(SESSION).length, 0)
    assert.equal(beginCcbLocalAgentInject(SESSION, 'agt-cap'), false)
  })

  it('abandons observably after pending TTL', () => {
    assert.equal(note('agt-ttl', false), 'inject')
    setCcbLocalAgentFirstSeenAtForTest(
      SESSION,
      'agt-ttl',
      Date.now() - CCB_LOCAL_AGENT_INJECT_PENDING_TTL_MS - 1,
    )
    assert.equal(evaluateCcbLocalAgentInjectLimit(SESSION, 'agt-ttl'), 'pending_ttl')
    assert.equal(getCcbLocalAgentCallbackState(SESSION, 'agt-ttl'), 'delivered')
    assert.equal(getCcbLocalAgentAbandonReason(SESSION, 'agt-ttl'), 'pending_ttl')
    assert.equal(note('agt-ttl', false), 'noop')
    assert.equal(takePendingInjectionsForSession(SESSION).length, 0)
    assert.equal(beginCcbLocalAgentInject(SESSION, 'agt-ttl'), false)
  })
})

describe('pending table lifecycle', () => {
  it('clears one session without touching another', () => {
    note('agt-a', true)
    noteCcbTaskNotification({
      sessionKey: 'agent:main:webchat:dm:other',
      hasInFlightTurn: true,
      notification: { taskId: 'agt-b', status: 'completed', outputFile: '', summary: '' },
    })
    clearCcbLocalAgentPendingForSession(SESSION)
    assert.equal(getCcbLocalAgentCallbackState(SESSION, 'agt-a'), undefined)
    assert.equal(getCcbLocalAgentCallbackState('agent:main:webchat:dm:other', 'agt-b'), 'pending')
  })

  it('caps the process-level table', () => {
    for (let i = 0; i < 1100; i += 1) {
      note(`agt-cap-${i}`, true)
    }
    assert.ok(ccbLocalAgentPendingSizeForTest() <= 1024)
  })
})
