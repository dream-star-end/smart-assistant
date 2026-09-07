/**
 * Session trash sweeper unit tests — injected fake sweep/now/log, no DB.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/sessionTrashSweeper.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  startSessionTrashSweeper,
  type SessionTrashSweeperOptions,
} from '../sessionTrashSweeper.js'

interface RecordedCall {
  cutoffMs: number
}

function fakeLogger() {
  const infos: Array<{ msg: string; meta?: Record<string, unknown> }> = []
  const warns: Array<{ msg: string; meta?: Record<string, unknown>; err?: unknown }> = []
  return {
    infos,
    warns,
    log: {
      info(msg: string, meta?: Record<string, unknown>) {
        infos.push({ msg, meta })
      },
      warn(msg: string, meta?: Record<string, unknown>, err?: unknown) {
        warns.push({ msg, meta, err })
      },
    },
  }
}

function immediateSweep(calls: RecordedCall[], result: { purged: number }) {
  return async (cutoffMs: number): Promise<{ purged: number }> => {
    calls.push({ cutoffMs })
    return result
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe('startSessionTrashSweeper', () => {
  it('runs immediately once with cutoff = now() - retentionMs', async () => {
    const calls: RecordedCall[] = []
    const NOW = 1_700_000_000_000
    const RETENTION = 3 * 24 * 60 * 60_000
    const { log, infos } = fakeLogger()
    const opts: SessionTrashSweeperOptions = {
      sweep: immediateSweep(calls, { purged: 0 }),
      retentionMs: RETENTION,
      intervalMs: 60 * 60_000, // long — interval irrelevant for this case
      now: () => NOW,
      log,
    }
    const sweeper = startSessionTrashSweeper(opts)
    try {
      // The boot run is fire-and-forget; give the microtask queue a tick.
      await sleep(5)
      assert.equal(calls.length, 1, 'exactly one immediate run')
      assert.equal(calls[0].cutoffMs, NOW - RETENTION)
      // purged = 0 → no info log at all
      assert.equal(infos.length, 0)
    } finally {
      sweeper.stop()
    }
  })

  it('logs info only when purged > 0', async () => {
    const calls: RecordedCall[] = []
    const { log, infos } = fakeLogger()
    const sweeper = startSessionTrashSweeper({
      sweep: immediateSweep(calls, { purged: 7 }),
      retentionMs: 1000,
      intervalMs: 60 * 60_000,
      now: () => 5000,
      log,
    })
    try {
      await sleep(5)
      assert.equal(calls.length, 1)
      assert.deepEqual(infos, [{ msg: 'session trash sweep', meta: { purged: 7 } }])
    } finally {
      sweeper.stop()
    }
  })

  it('runs on the interval; stop() prevents further runs', async () => {
    const calls: RecordedCall[] = []
    const sweeper = startSessionTrashSweeper({
      sweep: immediateSweep(calls, { purged: 0 }),
      retentionMs: 1000,
      intervalMs: 20,
      now: () => 5000,
      log: fakeLogger().log,
    })
    await sleep(5)
    const afterBoot = calls.length
    assert.ok(afterBoot >= 1, 'boot run happened')
    // Let a few interval ticks fire.
    await sleep(80)
    const afterTicks = calls.length
    assert.ok(afterTicks >= afterBoot + 2, `interval fired (boot=${afterBoot}, after=${afterTicks})`)

    sweeper.stop()
    const stoppedAt = calls.length
    await sleep(80)
    assert.equal(calls.length, stoppedAt, 'no runs after stop()')
  })

  it('swallows sweep errors: warn logged, runOnce resolves {purged:0}, interval keeps going', async () => {
    const { log, warns, infos } = fakeLogger()
    let boom = true
    const sweeper = startSessionTrashSweeper({
      sweep: async () => {
        if (boom) throw new Error('db locked')
        return { purged: 2 }
      },
      retentionMs: 1000,
      intervalMs: 20,
      now: () => 5000,
      log,
    })
    try {
      // Boot run throws; must not reject (fire-and-forget) and must not crash.
      await sleep(5)
      assert.equal(warns.length, 1)
      assert.equal(warns[0].msg, 'session trash sweep failed')

      const manual = await sweeper.runOnce()
      assert.deepEqual(manual, { purged: 0 })
      assert.equal(warns.length, 2)
      assert.ok(warns[1].err instanceof Error || warns[1].err !== undefined)

      // Recovers on later ticks once the error clears.
      boom = false
      await sleep(80)
      assert.ok(
        infos.some((e) => e.msg === 'session trash sweep' && e.meta?.purged === 2),
        'recovered tick logged purged=2',
      )
    } finally {
      sweeper.stop()
    }
  })

  it('runOnce skips while a previous run is still in flight (single-flight)', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let started = 0
    const sweeper = startSessionTrashSweeper({
      sweep: async () => {
        started++
        await gate
        return { purged: 1 }
      },
      retentionMs: 1000,
      intervalMs: 60 * 60_000,
      now: () => 5000,
      log: fakeLogger().log,
    })
    try {
      await sleep(5)
      assert.equal(started, 1, 'boot run is now blocked on the gate')
      const skipped = await sweeper.runOnce()
      assert.deepEqual(skipped, { purged: 0 }, 'in-flight run is skipped, not queued')
      assert.equal(started, 1)
      release()
      // Let the gated run finish its continuation (finally: inFlight = false).
      await sleep(5)
      const done = await sweeper.runOnce()
      assert.deepEqual(done, { purged: 1 })
      assert.equal(started, 2)
    } finally {
      release()
      sweeper.stop()
    }
  })

  it('runOnce returns the sweep result and cutoff honors injected now()', async () => {
    const calls: RecordedCall[] = []
    let tick = 0
    const sweeper = startSessionTrashSweeper({
      sweep: immediateSweep(calls, { purged: 3 }),
      retentionMs: 50,
      intervalMs: 60 * 60_000,
      now: () => 1000 + tick++ * 10,
      log: fakeLogger().log,
    })
    try {
      await sleep(5)
      const r = await sweeper.runOnce()
      assert.deepEqual(r, { purged: 3 })
      // boot used now=1000 → cutoff 950; manual run used now=1010 → cutoff 960
      assert.deepEqual(calls.map((c) => c.cutoffMs), [950, 960])
    } finally {
      sweeper.stop()
    }
  })
})
