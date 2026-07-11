import * as assert from 'node:assert/strict'
/**
 * Tests for the self-heal webhook receiver (slice ② / block B2a).
 *
 * Exercises the full trust chain against a fresh selfheal.db under a temp
 * OPENCLAUDE_HOME: loopback, size cap, ts window, HMAC, atomic nonce, plus the
 * durable job commit (202 / duplicate-202 / 409 conflict).
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/selfhealReceiver.test.ts
 */
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

const testHome = await mkdtemp(join(tmpdir(), 'oc-selfheal-rx-'))
process.env.OPENCLAUDE_HOME = testHome

const {
  getSelfhealReceiverConfig,
  isLoopbackAddress,
  receiveSelfhealDispatch,
} = await import('../selfheal/receiver.js')
const { closeSelfhealDb } = await import('@openclaude/storage')

after(async () => {
  await closeSelfhealDb()
})

const SECRET = 'test-secret-abc'
const cfg = getSelfhealReceiverConfig({ OC_SELFHEAL_WEBHOOK_HMAC: SECRET } as NodeJS.ProcessEnv)!

function sign(secret: string, ts: string, nonce: string, repairId: string, rawBody: Buffer): string {
  const bodySha256 = createHash('sha256').update(rawBody).digest('hex')
  return createHmac('sha256', secret).update(`${ts}.${nonce}.${repairId}.${bodySha256}`).digest('hex')
}

function makeInput(opts: {
  repairId: string
  incidentId?: string
  attempt?: number
  secret?: string
  ts?: string
  nonce?: string
  remoteAddress?: string
  now?: number
  body?: Buffer
}) {
  const now = opts.now ?? Date.now()
  const rawBody =
    opts.body ??
    Buffer.from(
      JSON.stringify({
        repairId: opts.repairId,
        incidentId: opts.incidentId ?? 'inc-1',
        attempt: opts.attempt ?? 0,
      }),
      'utf8',
    )
  const ts = opts.ts ?? String(now)
  const nonce = opts.nonce ?? randomBytes(8).toString('hex')
  const sig = sign(opts.secret ?? SECRET, ts, nonce, opts.repairId, rawBody)
  return {
    input: {
      remoteAddress: opts.remoteAddress ?? '127.0.0.1',
      ts,
      nonce,
      sig,
      rawBody,
    },
    now,
  }
}

describe('isLoopbackAddress', () => {
  it('accepts loopback forms', () => {
    for (const a of ['127.0.0.1', '127.5.5.5', '::1', '::ffff:127.0.0.1']) {
      assert.equal(isLoopbackAddress(a), true, a)
    }
  })
  it('rejects non-loopback / empty', () => {
    for (const a of ['10.0.0.1', '192.168.1.9', '::ffff:8.8.8.8', undefined, '']) {
      assert.equal(isLoopbackAddress(a), false, String(a))
    }
  })
})

describe('receiveSelfhealDispatch — trust chain', () => {
  it('accepts a well-formed dispatch (202) and commits it durably', async () => {
    const { input, now } = makeInput({ repairId: 'rx-ok' })
    const r = await receiveSelfhealDispatch(input, cfg, now)
    assert.equal(r.status, 202)
    assert.equal(r.body.ok, true)
    assert.equal(r.body.deduped, false)
  })

  it('rejects a non-loopback source (403)', async () => {
    const { input, now } = makeInput({ repairId: 'rx-remote', remoteAddress: '8.8.8.8' })
    const r = await receiveSelfhealDispatch(input, cfg, now)
    assert.equal(r.status, 403)
  })

  it('rejects a bad signature (401)', async () => {
    const { input, now } = makeInput({ repairId: 'rx-badsig', secret: 'wrong-secret' })
    const r = await receiveSelfhealDispatch(input, cfg, now)
    assert.equal(r.status, 401)
  })

  it('rejects a stale timestamp (401)', async () => {
    const now = Date.now()
    const { input } = makeInput({ repairId: 'rx-stale', ts: String(now - 5 * 60_000), now })
    const r = await receiveSelfhealDispatch(input, cfg, now)
    assert.equal(r.status, 401)
  })

  it('rejects a replayed nonce (401)', async () => {
    const fixedNonce = randomBytes(8).toString('hex')
    const a = makeInput({ repairId: 'rx-replay', nonce: fixedNonce })
    const first = await receiveSelfhealDispatch(a.input, cfg, a.now)
    assert.equal(first.status, 202)
    // Same nonce, different repair → still rejected purely on nonce replay.
    const b = makeInput({ repairId: 'rx-replay-2', nonce: fixedNonce, now: a.now })
    const second = await receiveSelfhealDispatch(b.input, cfg, b.now)
    assert.equal(second.status, 401)
  })

  it('rejects an oversized body (413)', async () => {
    const big = Buffer.alloc(cfg.maxBodyBytes + 1, 0x20)
    const { input, now } = makeInput({ repairId: 'rx-big', body: big })
    const r = await receiveSelfhealDispatch(input, cfg, now)
    assert.equal(r.status, 413)
  })

  it('rejects a malformed body (400)', async () => {
    const { input, now } = makeInput({ repairId: 'rx-bad', body: Buffer.from('not json', 'utf8') })
    const r = await receiveSelfhealDispatch(input, cfg, now)
    assert.equal(r.status, 400)
  })

  it('is idempotent for a re-dispatch with an identical body (202 duplicate)', async () => {
    const first = makeInput({ repairId: 'rx-dup', incidentId: 'inc-dup', attempt: 3 })
    const r1 = await receiveSelfhealDispatch(first.input, cfg, first.now)
    assert.equal(r1.status, 202)
    // Fresh nonce (new HTTP attempt), same body → duplicate, still 202.
    const second = makeInput({ repairId: 'rx-dup', incidentId: 'inc-dup', attempt: 3 })
    const r2 = await receiveSelfhealDispatch(second.input, cfg, second.now)
    assert.equal(r2.status, 202)
    assert.equal(r2.body.deduped, true)
  })

  it('conflicts (409) when the same repair_id re-dispatches a different body', async () => {
    const first = makeInput({ repairId: 'rx-conflict', attempt: 0 })
    assert.equal((await receiveSelfhealDispatch(first.input, cfg, first.now)).status, 202)
    const second = makeInput({ repairId: 'rx-conflict', attempt: 9 })
    const r = await receiveSelfhealDispatch(second.input, cfg, second.now)
    assert.equal(r.status, 409)
  })
})
