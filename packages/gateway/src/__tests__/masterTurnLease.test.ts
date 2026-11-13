import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  RenewTurnLeaseError,
  refreshTurnModelAuthorityLease,
  renewTurnLease,
} from '../masterTurnLease.js'

test('retry refresh saves the latest lease before any subprocess hot-update', async () => {
  const authority = { leaseEnvelope: 'old' }
  const seen: string[] = []
  const renew = async (_key: string, lease: string) => {
    seen.push(lease)
    return { lease: `new-${seen.length}`, expiresAt: seen.length * 1000 }
  }
  await refreshTurnModelAuthorityLease('turn', authority, { renew })
  assert.equal(authority.leaseEnvelope, 'new-1')
  await refreshTurnModelAuthorityLease('turn', authority, { renew })
  assert.deepEqual(seen, ['old', 'new-1'])
  assert.equal(authority.leaseEnvelope, 'new-2')
})

test('transient transport/429/5xx failures wait 60s and recover even after old expiry', async () => {
  const authority = { leaseEnvelope: 'expired' }
  let attempts = 0
  let now = 0
  const waits: number[] = []
  const result = await refreshTurnModelAuthorityLease('turn', authority, {
    renew: async () => {
      attempts += 1
      if (attempts === 1) throw new Error('ECONNRESET')
      if (attempts === 2) throw new RenewTurnLeaseError(429, 'BUSY')
      if (attempts === 3) throw new RenewTurnLeaseError(503, 'SIGNER_UNAVAILABLE')
      return { lease: 'fresh', expiresAt: now + 50 * 60_000 }
    },
    wait: async (delay) => { waits.push(delay); now += delay },
  })
  assert.deepEqual(waits, [60_000, 60_000, 60_000])
  assert.equal(attempts, 4)
  assert.equal(result.expiresAt, now + 50 * 60_000)
  assert.equal(authority.leaseEnvelope, 'fresh')
})

test('terminal/revoked/identity errors reject without rewriting or retrying the lease', async () => {
  for (const status of [401, 403, 409]) {
    const authority = { leaseEnvelope: 'old' }
    const error = new RenewTurnLeaseError(status, 'MODEL_CONFIG_CHANGED')
    await assert.rejects(refreshTurnModelAuthorityLease('turn', authority, {
      renew: async () => { throw error },
      wait: async () => { assert.fail('must not retry policy rejection') },
    }), (err) => err === error)
    assert.equal(authority.leaseEnvelope, 'old')
  }
})

test('a finalized/replaced turn cannot apply an in-flight renewal response', async () => {
  const controller = new AbortController()
  const authority = { leaseEnvelope: 'old' }
  let resolve!: (result: { lease: string; expiresAt: number }) => void
  const pending = refreshTurnModelAuthorityLease('turn', authority, {
    signal: controller.signal,
    renew: () => new Promise((r) => { resolve = r }),
  })
  const stopped = new Error('turn ended')
  controller.abort(stopped)
  resolve({ lease: 'late', expiresAt: 1000 })
  await assert.rejects(pending, (err) => err === stopped)
  assert.equal(authority.leaseEnvelope, 'old')
})

test('Stop aborts the pending 60s retry timer without another request', async () => {
  const controller = new AbortController()
  let attempts = 0
  let waiting!: () => void
  const reachedWait = new Promise<void>((resolve) => { waiting = resolve })
  const pending = refreshTurnModelAuthorityLease('turn', { leaseEnvelope: 'old' }, {
    signal: controller.signal,
    renew: async () => { attempts++; throw new Error('offline') },
    wait: async (_ms, signal) => new Promise<void>((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
      waiting()
    }),
  })
  await reachedWait
  const stopped = new Error('stopped')
  controller.abort(stopped)
  await assert.rejects(pending, (err) => err === stopped)
  assert.equal(attempts, 1)
})

test('renewal HTTP error retains typed status/code without exposing its raw response', async () => {
  await assert.rejects(renewTurnLease('turn', 'old', {
    env: { OPENCLAUDE_V3_MASTER_BASE_URL: 'http://master', OPENCLAUDE_V3_CONTAINER_TOKEN: 'token' },
    fetcher: (async () => ({
      statusCode: 409,
      body: (async function* () { yield Buffer.from('{"error":{"code":"TURN_FINALIZED","message":"secret details"}}') })(),
    })) as never,
  }), (error) => error instanceof RenewTurnLeaseError && error.status === 409 &&
    error.code === 'TURN_FINALIZED' && !error.message.includes('secret details'))
})
