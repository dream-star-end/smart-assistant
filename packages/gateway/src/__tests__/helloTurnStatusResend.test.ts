/**
 * INC-20261028-STALE-ENGINE-STARTING — reconnect hello re-sends the running
 * turn's authoritative phase, including null.
 *
 * Commercial uid 4 (2026-10-28): the phone dropped its WS 10s after send; the
 * startup clear frame (status:null) was emitted while no browser was attached,
 * and the tab kept showing 「正在启动引擎 (1184s)」. autoResumeFromHello used to
 * skip the re-send when the cached phase was null.
 *
 * Run: npx tsx --test --test-force-exit packages/gateway/src/__tests__/helloTurnStatusResend.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { _helloTurnStatusResendPhase, _turnStatusWireFields } from '../server.js'

describe('_helloTurnStatusResendPhase', () => {
  it('running turn past startup (phase null) re-sends status:null', () => {
    const phase = _helloTurnStatusResendPhase(true, null)
    assert.equal(phase, null)
    assert.deepEqual(_turnStatusWireFields(phase!), { status: null })
  })

  it('running turn with no phase ever cached re-sends status:null', () => {
    assert.equal(_helloTurnStatusResendPhase(true, undefined), null)
  })

  it('running turn keeps re-sending its live phase verbatim', () => {
    assert.equal(_helloTurnStatusResendPhase(true, 'compacting'), 'compacting')
    assert.equal(_helloTurnStatusResendPhase(true, 'engine_starting'), 'engine_starting')
    assert.deepEqual(_helloTurnStatusResendPhase(true, { status: 'working', detail: 'thinking' }), {
      status: 'working',
      detail: 'thinking',
    })
  })

  it('idle runner sends nothing', () => {
    assert.equal(_helloTurnStatusResendPhase(false, null), undefined)
    assert.equal(_helloTurnStatusResendPhase(false, 'compacting'), undefined)
  })
})
