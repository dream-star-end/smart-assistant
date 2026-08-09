import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveReconnectTurnStatus } from '../server.js'

describe('reconnect turn reconciliation', () => {
  it('reports the exact running submit', () => {
    const result = resolveReconnectTurnStatus(
      { inFlight: true, inFlightClientMessageId: 'submit-1' },
      {
        _turnActiveSince: 123,
        _activeClientMessageId: 'submit-1',
      } as any,
    )
    assert.deepEqual(result, {
      status: 'running',
      clientMessageId: 'submit-1',
      startedAt: 123,
    })
  })

  it('reports a matching completed submit without inventing interruption content', () => {
    const result = resolveReconnectTurnStatus(
      { inFlight: true, inFlightClientMessageId: 'submit-2' },
      {
        _turnActiveSince: null,
        _lastClientMessageId: 'submit-2',
        _lastClientMessageOutcome: 'completed',
      } as any,
    )
    assert.deepEqual(result, { status: 'completed', clientMessageId: 'submit-2' })
  })

  it('uses unknown when an idle server cannot prove the requested outcome', () => {
    const result = resolveReconnectTurnStatus(
      { inFlight: true, inFlightClientMessageId: 'submit-after-restart' },
      null,
    )
    assert.deepEqual(result, {
      status: 'unknown',
      clientMessageId: 'submit-after-restart',
    })
  })

  it('uses a durable terminal outcome after the warm session was lost', () => {
    const result = resolveReconnectTurnStatus(
      { inFlight: true, inFlightClientMessageId: 'submit-durable' },
      null,
      {
        clientMessageId: 'submit-durable',
        state: 'completed',
      },
    )
    assert.deepEqual(result, {
      status: 'completed',
      clientMessageId: 'submit-durable',
    })
  })

  it('keeps an ordinary non-flight hello idle', () => {
    assert.deepEqual(resolveReconnectTurnStatus({ inFlight: false }, null), { status: 'idle' })
  })
})
