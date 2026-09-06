import assert from 'node:assert/strict'
import test from 'node:test'

import {
  canFocusProduct,
  canOpenDownloads,
  canOpenMoreMenu,
  hasProductRecoveryState,
  isModalShellMode,
  normalizeShellMode,
  shellModeAfterDownloadsClose,
  shouldShowProduct,
} from '../src/shell-mode.mjs'

test('modal shell modes hide and own focus over the product view', () => {
  for (const mode of ['downloads', 'offline']) {
    assert.equal(isModalShellMode(mode), true)
    assert.equal(shouldShowProduct(mode), false)
    assert.equal(canFocusProduct(mode), false)
    assert.equal(canOpenMoreMenu(mode), false)
  }

  assert.equal(isModalShellMode('toolbar'), false)
  assert.equal(shouldShowProduct('toolbar'), true)
  assert.equal(canFocusProduct('toolbar'), true)
  assert.equal(canOpenMoreMenu('toolbar'), true)
  assert.equal(normalizeShellMode('attacker-mode'), 'toolbar')
})

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
