import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  PluginAccountLeaseError,
  type PluginLeaseRedis,
  acquirePluginAccountLease,
} from './accountLease.js'

class FakeRedis implements PluginLeaseRedis {
  readonly values = new Map<string, string>()
  fail = false
  renewMismatch = false

  async eval(script: string, _numKeys: number, ...args: Array<string | number>): Promise<unknown> {
    if (this.fail) throw new Error('redis down')
    const [key, token] = args.map(String)
    if (script.includes("'SET'")) {
      if (this.values.has(key!)) return 0
      this.values.set(key!, token!)
      return 1
    }
    if (script.includes("'PEXPIRE'")) {
      if (this.renewMismatch) return 0
      return this.values.get(key!) === token ? 1 : 0
    }
    if (script.includes("'DEL'")) {
      if (this.values.get(key!) !== token) return 0
      this.values.delete(key!)
      return 1
    }
    return this.values.get(key!) === token ? 1 : 0
  }
}

describe('Plugin account Redis lease', () => {
  test('serializes the same account across independent runtime instances', async () => {
    const redis = new FakeRedis()
    const first = await acquirePluginAccountLease(redis, '41', {
      hardTimeoutMs: 1000,
      renewalIntervalMs: 20,
    })
    await assert.rejects(
      acquirePluginAccountLease(redis, '41', { hardTimeoutMs: 1000, renewalIntervalMs: 20 }),
      (error: unknown) => error instanceof PluginAccountLeaseError && error.code === 'LEASE_BUSY',
    )
    await first.assertHeld()
    await first.release()
    const second = await acquirePluginAccountLease(redis, '41', {
      hardTimeoutMs: 1000,
      renewalIntervalMs: 20,
    })
    await second.release()
  })

  test('fails closed when Redis is unavailable and aborts when renewal loses ownership', async () => {
    const down = new FakeRedis()
    down.fail = true
    await assert.rejects(
      acquirePluginAccountLease(down, '41', { hardTimeoutMs: 1000 }),
      (error: unknown) =>
        error instanceof PluginAccountLeaseError && error.code === 'LEASE_UNAVAILABLE',
    )

    const redis = new FakeRedis()
    const lease = await acquirePluginAccountLease(redis, '41', {
      hardTimeoutMs: 1000,
      renewalIntervalMs: 10,
    })
    redis.renewMismatch = true
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(lease.signal.aborted, true)
    assert.equal(lease.lost, true)
    await assert.rejects(lease.assertHeld(), /lease lost/i)
    await lease.release()
  })
})
