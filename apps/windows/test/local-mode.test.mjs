import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_KILL_SWITCH_COOLDOWN_MS,
  LocalMode,
  createLocalModeController,
  localModeTrayLabel,
} from '../src/localMode.mjs'

test('localModeTrayLabel covers off / on / fallback', () => {
  assert.equal(localModeTrayLabel(LocalMode.CLOUD), '本地模式:关')
  assert.equal(localModeTrayLabel(LocalMode.LOCAL), '本地模式:开')
  assert.equal(localModeTrayLabel(LocalMode.FALLBACK), '本地模式:回落云端')
})

test('E6 kill switch falls back to cloud and refuses tight-loop re-enable during cooldown', () => {
  let now = 1_000
  const changes = []
  const mode = createLocalModeController({
    now: () => now,
    cooldownMs: 30_000,
    onChange: (info) => changes.push(info.reason),
  })
  assert.equal(DEFAULT_KILL_SWITCH_COOLDOWN_MS, 30_000)
  assert.deepEqual(mode.enableLocal(), { ok: true, mode: LocalMode.LOCAL })
  const first = mode.noteKillSwitch()
  assert.equal(first.mode, LocalMode.FALLBACK)
  assert.equal(first.reason, 'killswitch')
  const again = mode.enableLocal()
  assert.equal(again.ok, false)
  assert.equal(again.reason, 'cooldown')
  assert.equal(again.retryAfterMs >= 29_000, true)
  assert.equal(mode.enableAttempts, 2)
  now += 30_000
  const after = mode.enableLocal()
  assert.equal(after.ok, true)
  assert.equal(after.mode, LocalMode.LOCAL)
  assert.ok(changes.includes('killswitch'))
  assert.ok(changes.includes('cooldown'))
})

test('host unavailable and tunnel offline also fallback without flipping back immediately', () => {
  let now = 5_000
  const mode = createLocalModeController({ now: () => now, cooldownMs: 1_000 })
  mode.enableLocal()
  mode.noteHostUnavailable()
  assert.equal(mode.mode, LocalMode.FALLBACK)
  assert.equal(mode.enableLocal().ok, false)
  now += 1_000
  mode.enableLocal()
  mode.noteTunnelOffline()
  assert.equal(mode.mode, LocalMode.FALLBACK)
  assert.equal(mode.fallbackCloud().mode, LocalMode.CLOUD)
})
