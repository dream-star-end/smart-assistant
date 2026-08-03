import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'modules', 'websocket.js'),
  'utf-8',
)

describe('conversation turn lifetime', () => {
  it('never converts browser silence into an automatic stop', () => {
    assert.match(SRC, /function _resetThinkingSafety\(_sessId\) \{\}/)
    assert.doesNotMatch(SRC, /state\._thinkingSafetyTimer\s*=\s*setTimeout/)
    assert.doesNotMatch(SRC, /state\._reconnectInFlightTimer\s*=\s*setTimeout/)
  })

  it('does not force-complete a busy turn while draining offline messages', () => {
    assert.doesNotMatch(SRC, /state\._drainTimeout\s*=\s*setTimeout/)
    assert.match(SRC, /still busy after 60s, deferring/)
    assert.match(SRC, /if \(allBusy\) \{/)
  })

  it('accepts only authoritative running or idle status after reconnect', () => {
    assert.match(
      SRC,
      /frame\.status === 'running' \|\| frame\.status === 'compacting' \|\| frame\.status === 'idle'/,
    )
    assert.match(SRC, /else if \(status === 'idle' && sess\._sendingInFlight\)/)
  })
})
