import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fenceIdleSourceRunner } from '../boxIdleCandidateRecovery.js'
import type { EngineAdapter } from '../engine/engineAdapter.js'

test('t1642u shutdown requires drained output and cannot hang session.lock', async () => {
  for (const block of ['shutdown', 'drain']) {
    const never = new Promise<void>(() => {})
    const runner = { shutdown: () => block === 'shutdown' ? never : Promise.resolve(),
      waitForOutputDrain: () => never, isRunning: false } as unknown as EngineAdapter
    assert.equal(await fenceIdleSourceRunner(runner, 10), false, block)
  }
  let drain!: () => void
  const barrier = new Promise<void>(r => { drain = r })
  const runner = { shutdown: async () => {}, waitForOutputDrain: () => barrier, isRunning: false } as unknown as EngineAdapter
  const fenced = fenceIdleSourceRunner(runner)
  drain()
  assert.equal(await fenced, true)
})
