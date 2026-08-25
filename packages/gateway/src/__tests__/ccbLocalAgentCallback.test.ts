import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import {
  ackCcbTaskNotificationDelivered,
  beginCcbLocalAgentInject,
  buildCcbLocalAgentCallbackText,
  ccbLocalAgentCallbackClientMessageId,
  ccbLocalAgentCallbackIdempotencyKey,
  ccbLocalAgentPendingSizeForTest,
  clearCcbLocalAgentPendingForSession,
  completeCcbLocalAgentInject,
  failCcbLocalAgentInject,
  getCcbLocalAgentCallbackState,
  noteCcbTaskNotification,
  resetCcbLocalAgentCallbackDedupeForTest,
  sessionHasInFlightTurn,
  takePendingInjectionsForSession,
  abandonCcbLocalAgentInject,
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

  it('retry budget exhausted falls back observably and does not retry later', async () => {
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
        abandonCcbLocalAgentInject(SESSION, 'agt-ex')
      },
      tryOnce: async () => ({ kind: 'retryable_failure', code: 'ORIGIN_SESSION_BUSY' }),
    })
    assert.equal(result.kind, 'fallback')
    assert.equal(exhausted, 1)
    assert.equal(delays.length, ORIGIN_INJECT_RETRY_BUDGET)
    assert.equal(delays[0], 500)
    assert.equal(delays.at(-1), 5_000)
    assert.equal(getCcbLocalAgentCallbackState(SESSION, 'agt-ex'), 'delivered')
    assert.equal(note('agt-ex', false), 'noop')
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
