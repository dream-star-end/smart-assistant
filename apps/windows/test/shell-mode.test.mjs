import assert from 'node:assert/strict'
import test from 'node:test'

import {
  canOpenDownloads,
  hasProductRecoveryState,
  shellModeAfterDownloadsClose,
} from '../src/shell-mode.mjs'

test('downloads cannot replace network or non-network recovery surfaces', () => {
  const offline = { network: 'offline', error: { kind: 'offline' } }
  const loadFailed = { network: 'unknown', error: { kind: 'load-failed' } }

  for (const state of [offline, loadFailed]) {
    assert.equal(hasProductRecoveryState(state), true)
    assert.equal(canOpenDownloads(state), false)
    assert.equal(shellModeAfterDownloadsClose(state), 'offline')
  }
})

test('downloads return to the toolbar only for a healthy product state', () => {
  const healthy = { network: 'online', error: null }
  assert.equal(hasProductRecoveryState(healthy), false)
  assert.equal(canOpenDownloads(healthy), true)
  assert.equal(shellModeAfterDownloadsClose(healthy), 'toolbar')
})
