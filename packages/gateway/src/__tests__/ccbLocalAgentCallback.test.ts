import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import {
  buildCcbLocalAgentCallbackText,
  ccbLocalAgentCallbackClientMessageId,
  ccbLocalAgentCallbackIdempotencyKey,
  handleCcbLocalAgentNotification,
  planCcbLocalAgentCallback,
  resetCcbLocalAgentCallbackDedupeForTest,
  sessionHasInFlightTurn,
} from '../ccbLocalAgentCallback.js'

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

describe('ccbLocalAgentCallback dual-wake plan', () => {
  it('does not dispatchInbound while the parent turn is in flight', () => {
    let dispatched = 0
    const plan = handleCcbLocalAgentNotification({
      sessionKey: 'agent:main:webchat:dm:sess-1',
      taskId: 'agt-busy',
      hasInFlightTurn: true,
      dispatch: () => {
        dispatched += 1
      },
    })
    assert.equal(plan, 'skip-inflight')
    assert.equal(dispatched, 0)
  })

  it('injects exactly once after the parent turn has finalized', () => {
    let dispatched = 0
    const first = handleCcbLocalAgentNotification({
      sessionKey: 'agent:main:webchat:dm:sess-1',
      taskId: 'agt-idle',
      hasInFlightTurn: false,
      dispatch: () => {
        dispatched += 1
      },
    })
    const second = handleCcbLocalAgentNotification({
      sessionKey: 'agent:main:webchat:dm:sess-1',
      taskId: 'agt-idle',
      hasInFlightTurn: false,
      dispatch: () => {
        dispatched += 1
      },
    })
    assert.equal(first, 'inject')
    assert.equal(second, 'noop')
    assert.equal(dispatched, 1)
  })

  it('does not inject later after an in-flight sighting of the same taskId', () => {
    let dispatched = 0
    assert.equal(
      handleCcbLocalAgentNotification({
        sessionKey: 'agent:main:webchat:dm:sess-1',
        taskId: 'agt-once',
        hasInFlightTurn: true,
        dispatch: () => {
          dispatched += 1
        },
      }),
      'skip-inflight',
    )
    assert.equal(
      handleCcbLocalAgentNotification({
        sessionKey: 'agent:main:webchat:dm:sess-1',
        taskId: 'agt-once',
        hasInFlightTurn: false,
        dispatch: () => {
          dispatched += 1
        },
      }),
      'noop',
    )
    assert.equal(dispatched, 0)
    assert.equal(
      planCcbLocalAgentCallback({
        sessionKey: 'agent:main:webchat:dm:sess-1',
        taskId: 'agt-once',
        hasInFlightTurn: false,
      }),
      'noop',
    )
  })
})
