import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { Client } from 'pg'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import sharp from 'sharp'

import { createPool, closePool, getPool, resetPool, setPoolOverride } from '../db/index.js'
import { query } from '../db/queries.js'
import { runMigrations } from '../db/migrate.js'
import { hashSecret, type ContainerIdentityRepo } from '../auth/containerIdentity.js'
import { CODEX_RELAY_PREFIX, CODEX_UPSTREAM_AUTH_HEADER, makeCodexRelayHandler } from '../http/internalCodexRelay.js'
import type { PreCheckRedis } from '../billing/preCheck.js'
import {
  ImageDailyLimitError,
  getCompletedImageUsage,
  reserveImageUsage,
  settleImageCharge,
} from '../billing/imageBilling.js'

const BASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const DB_NAME = 'openclaude_image2_test'
const REQUIRED = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'
const withDb = (url: string, name: string) => {
  const parsed = new URL(url)
  parsed.pathname = `/${name}`
  return parsed.toString()
}
let available = false

async function admin(sql: string): Promise<void> {
  const client = new Client({ connectionString: BASE_URL, connectionTimeoutMillis: 1500 })
  await client.connect()
  try { await client.query(sql) } finally { await client.end() }
}

before(async () => {
  try { await admin('SELECT 1'); available = true } catch { available = false }
  if (!available) {
    if (REQUIRED) throw new Error('Postgres test fixture required')
    return
  }
  await admin(`DROP DATABASE IF EXISTS ${DB_NAME}`)
  await admin(`CREATE DATABASE ${DB_NAME} TEMPLATE template0`)
  await resetPool()
  setPoolOverride(createPool({ connectionString: withDb(BASE_URL, DB_NAME), max: 8 }))
  await runMigrations()
})

after(async () => {
  if (!available) return
  await closePool()
  await admin(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DB_NAME}' AND pid<>pg_backend_pid()`).catch(() => {})
  await admin(`DROP DATABASE IF EXISTS ${DB_NAME}`).catch(() => {})
})

beforeEach(async () => {
  if (!available) return
  await query('TRUNCATE image_generation_usage_records, credit_ledger, user_subscriptions, users RESTART IDENTITY CASCADE')
})

function skip(t: { skip: (reason: string) => void }): boolean {
  if (available) return false
  t.skip('pg not running')
  return true
}

async function user(credits = 500n): Promise<bigint> {
  const result = await query<{ id: string }>(
    `INSERT INTO users(email,password_hash,role,status,email_verified,free_bootstrap_settled,credits)
     VALUES ($1,'argon2$stub','user','active',TRUE,TRUE,$2) RETURNING id::text AS id`,
    [`image-${Date.now()}-${Math.random()}@example.com`, credits.toString()],
  )
  return BigInt(result.rows[0]!.id)
}

const SECRET = 'b'.repeat(64)
const TOKEN = `oc-v3.11.${SECRET}`
const CTX = { hostUuid: 'host-self', boundIp: '172.30.0.11' }

async function addContainer(userId: bigint): Promise<void> {
  await query(
    `INSERT INTO agent_containers(id,user_id,secret_hash,state,runtime_channel)
     VALUES (11,$1,$2,'active','v5')`,
    [userId.toString(), Buffer.alloc(32)],
  )
}

function repo(userId: bigint): ContainerIdentityRepo {
  return {
    async findActiveByHostAndBoundIp() {
      return { id: 11, user_id: Number(userId), bound_ip: CTX.boundIp, host_uuid: CTX.hostUuid, secret_hash: hashSecret(SECRET) }
    },
  }
}

function redisTracker() {
  let releases = 0
  const redis: PreCheckRedis = {
    async atomicReserve(input) {
      return input.balance >= input.maxCost
        ? { ok: true, locked: input.maxCost, needed: input.maxCost }
        : { ok: false, locked: 0n, needed: input.maxCost }
    },
    async releaseReservation() { releases++; return true },
  }
  return { redis, releases: () => releases }
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

async function annotatedInput(jobId: string, prompt = 'make the selected area red'): Promise<string> {
  const source = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#4477aa' } }).png().toBuffer()
  const rawMask = Buffer.alloc(120 * 80)
  for (let y = 20; y < 60; y++) for (let x = 40; x < 80; x++) rawMask[y * 120 + x] = 255
  const mask = await sharp(rawMask, { raw: { width: 120, height: 80, channels: 1 } }).png().toBuffer()
  return JSON.stringify({
    jobId, prompt, width: 120, height: 80,
    sourceBase64: source.toString('base64'), maskBase64: mask.toString('base64'),
  })
}

async function outpaintInput(jobId: string, aspect = '16:9', prompt = 'expand to a 16:9 widescreen frame'): Promise<string> {
  // outpaint 无用户 mask;relay 端按 aspect 合成透明画布外扩。
  const source = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#4477aa' } }).png().toBuffer()
  return JSON.stringify({
    jobId, prompt, width: 120, height: 80,
    sourceBase64: source.toString('base64'), outpaint: { aspect },
  })
}

describe('Image 2 exact billing', () => {
  test('charges exactly 50 once and replays the committed response', async (t) => {
    if (skip(t)) return
    const userId = await user()
    const requestId = 'image:test-exact'
    await reserveImageUsage(getPool(), { userId, containerId: null, requestId, operation: 'generation' })
    const body = Buffer.from('{"data":[{"b64_json":"cached"}]}')
    const settled = await settleImageCharge(getPool(), {
      userId, containerId: null, requestId, operation: 'generation', responseBody: body,
    })
    assert.equal(settled.duplicate, false)
    const balance = await query<{ credits: string }>('SELECT credits::text AS credits FROM users WHERE id=$1', [userId.toString()])
    assert.equal(balance.rows[0]!.credits, '450')
    const ledger = await query<{ delta: string; reason: string }>(
      "SELECT delta::text AS delta,reason FROM credit_ledger WHERE user_id=$1 AND reason='image_generation'",
      [userId.toString()],
    )
    assert.deepEqual(ledger.rows, [{ delta: '-50', reason: 'image_generation' }])
    assert.deepEqual((await getCompletedImageUsage(getPool(), { userId, requestId }))?.responseBody, body)

    const duplicate = await settleImageCharge(getPool(), {
      userId, containerId: null, requestId, operation: 'generation', responseBody: body,
    })
    assert.equal(duplicate.duplicate, true)
    assert.equal((await query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM credit_ledger WHERE user_id=$1 AND reason='image_generation'",
      [userId.toString()],
    )).rows[0]!.count, '1')
  })

  test('annotated paid result remains recoverable after ordinary cache expiry', async (t) => {
    if (skip(t)) return
    const userId = await user()
    const requestId = 'image-job:' + 'f'.repeat(32)
    const jobId = 'f'.repeat(32)
    const body = Buffer.from('{"data":[{"b64_json":"durable-annotated-result"}]}')
    await reserveImageUsage(getPool(), {
      userId, containerId: null, requestId, jobId, operation: 'annotated_edit',
    })
    await settleImageCharge(getPool(), {
      userId, containerId: null, requestId, jobId, operation: 'annotated_edit', responseBody: body,
    })
    await query(
      `UPDATE image_generation_usage_records SET response_expires_at=NOW() - INTERVAL '1 day'
       WHERE user_id=$1 AND request_id=$2`,
      [userId.toString(), requestId],
    )

    assert.equal(await getCompletedImageUsage(getPool(), { userId, requestId }), null)
    const recovery = await reserveImageUsage(getPool(), {
      userId, containerId: null, requestId, jobId, operation: 'annotated_edit',
    })
    assert.equal(recovery.alreadyCharged, true)
    const regenerated = Buffer.from('{"data":[{"b64_json":"regenerated-without-charge"}]}')
    const recoverySettle = await settleImageCharge(getPool(), {
      userId, containerId: null, requestId, jobId, operation: 'annotated_edit', responseBody: regenerated,
    })
    assert.equal(recoverySettle.duplicate, true)
    assert.deepEqual(
      (await getCompletedImageUsage(getPool(), { userId, requestId }))?.responseBody,
      regenerated,
    )
    assert.equal((await query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM credit_ledger WHERE user_id=$1 AND reason='image_generation'",
      [userId.toString()],
    )).rows[0]!.count, '1')
    assert.equal((await query<{ credits: string }>(
      'SELECT credits::text AS credits FROM users WHERE id=$1',
      [userId.toString()],
    )).rows[0]!.credits, '450')
  })

  test('admits only one concurrent request per user', async (t) => {
    if (skip(t)) return
    const userId = await user()
    const results = await Promise.allSettled([
      reserveImageUsage(getPool(), { userId, containerId: null, requestId: 'image:a', operation: 'generation' }),
      reserveImageUsage(getPool(), { userId, containerId: null, requestId: 'image:b', operation: 'edit' }),
    ])
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
    assert.equal(results.filter((r) => r.status === 'rejected').length, 1)
    assert.equal((await query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM image_generation_usage_records WHERE user_id=$1 AND status='reserved'",
      [userId.toString()],
    )).rows[0]!.count, '1')
  })

  test('enforces the UTC daily limit atomically', async (t) => {
    if (skip(t)) return
    const userId = await user()
    for (let i = 0; i < 10; i++) {
      await query(
        `INSERT INTO image_generation_usage_records(user_id,request_id,operation,status,completed_at)
         VALUES ($1,$2,'generation','success',NOW())`,
        [userId.toString(), `done:${i}`],
      )
    }
    await assert.rejects(
      reserveImageUsage(getPool(), { userId, containerId: null, requestId: 'image:eleven', operation: 'generation' }),
      ImageDailyLimitError,
    )
  })
})

describe('Image 2 relay orchestration', () => {
  test('composites, charges once, survives callback failure, and replays cache without upstream', async (t) => {
    if (skip(t)) return
    const userId = await user(100n)
    await addContainer(userId)
    const tracker = redisTracker()
    const generated = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#ee3344' } }).png().toBuffer()
    let upstreamCalls = 0
    const handler = makeCodexRelayHandler({
      identityRepo: repo(userId),
      db: { async readContainerBinding() { return { codexAccountId: 53n, userId, state: 'active', provider: 'codex', accountStatus: 'active' } } },
      upstreamBaseUrl: 'https://example.test/v1',
      resolveDispatcher: async () => ({ accountId: 53n, proxyId: 4n, dispatcher: {} as never }),
      fetchImpl: (async () => {
        upstreamCalls++
        return Response.json({ data: [{ b64_json: generated.toString('base64') }] })
      }) as typeof fetch,
      pgPool: getPool(),
      preCheckRedis: tracker.redis,
      image2Enabled: true,
      onImageCharge: () => { throw new Error('broadcast unavailable') },
    })
    const server = createServer((req, res) => { void handler(req, res, CTX) })
    const port = await listen(server)
    const jobId = 'c'.repeat(32)
    const send = async (prompt?: string) => fetch(`http://127.0.0.1:${port}${CODEX_RELAY_PREFIX}/v1/images/annotated-edits`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        [CODEX_UPSTREAM_AUTH_HEADER]: 'Bearer upstream',
        'content-type': 'application/json',
        'x-openclaude-image-job': jobId,
      },
      body: await annotatedInput(jobId, prompt),
    })
    try {
      const first = await send()
      assert.equal(first.status, 200)
      const firstJson = await first.json() as { data: Array<{ b64_json: string }> }
      const finalMeta = await sharp(Buffer.from(firstJson.data[0]!.b64_json, 'base64')).metadata()
      assert.deepEqual({ width: finalMeta.width, height: finalMeta.height, format: finalMeta.format }, { width: 120, height: 80, format: 'png' })
      const second = await send()
      assert.equal(second.status, 200)
      assert.deepEqual(await second.json(), firstJson)
      assert.equal(upstreamCalls, 1)
      await query(
        `UPDATE image_generation_usage_records SET response_expires_at=NOW() - INTERVAL '1 minute'
         WHERE user_id=$1 AND job_id=$2`,
        [userId.toString(), jobId],
      )
      const recovered = await send()
      assert.equal(recovered.status, 200)
      const recoveredJson = await recovered.json() as { data: Array<{ b64_json: string }> }
      assert.deepEqual(recoveredJson.data, firstJson.data)
      assert.equal(upstreamCalls, 2, 'expired paid edit regenerates once without a second charge')
      await query(
        `UPDATE image_generation_usage_records SET response_expires_at=NOW() - INTERVAL '1 minute'
         WHERE user_id=$1 AND job_id=$2`,
        [userId.toString(), jobId],
      )
      const changedInput = await send('replace the selection with a new gold statue')
      assert.equal(changedInput.status, 400)
      assert.equal(upstreamCalls, 2, 'changed input cannot reuse a previously paid recovery id')
      assert.equal((await query<{ credits: string }>('SELECT credits::text AS credits FROM users WHERE id=$1', [userId.toString()])).rows[0]!.credits, '50')
      assert.equal((await query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM credit_ledger WHERE user_id=$1 AND reason='image_generation'",
        [userId.toString()],
      )).rows[0]!.count, '1')
      assert.equal(tracker.releases() >= 1, true)
    } finally {
      await close(server)
    }
  })

  test('outpaint composites to the target aspect, charges 50 once, and replays cache', async (t) => {
    if (skip(t)) return
    const userId = await user(100n)
    await addContainer(userId)
    const tracker = redisTracker()
    // Model returns a full native 16:9-nearest frame (1536x1024); the relay
    // crops it back to the exact target-aspect canvas (142x80 for 120x80 → 16:9).
    const generated = await sharp({ create: { width: 1536, height: 1024, channels: 3, background: '#22aa55' } }).png().toBuffer()
    let upstreamCalls = 0
    const handler = makeCodexRelayHandler({
      identityRepo: repo(userId),
      db: { async readContainerBinding() { return { codexAccountId: 53n, userId, state: 'active', provider: 'codex', accountStatus: 'active' } } },
      upstreamBaseUrl: 'https://example.test/v1',
      resolveDispatcher: async () => ({ accountId: 53n, proxyId: 4n, dispatcher: {} as never }),
      fetchImpl: (async () => {
        upstreamCalls++
        return Response.json({ data: [{ b64_json: generated.toString('base64') }] })
      }) as typeof fetch,
      pgPool: getPool(),
      preCheckRedis: tracker.redis,
      image2Enabled: true,
    })
    const server = createServer((req, res) => { void handler(req, res, CTX) })
    const port = await listen(server)
    const jobId = 'd'.repeat(32)
    const send = async () => fetch(`http://127.0.0.1:${port}${CODEX_RELAY_PREFIX}/v1/images/annotated-edits`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        [CODEX_UPSTREAM_AUTH_HEADER]: 'Bearer upstream',
        'content-type': 'application/json',
        'x-openclaude-image-job': jobId,
      },
      body: await outpaintInput(jobId),
    })
    try {
      const first = await send()
      assert.equal(first.status, 200)
      const firstJson = await first.json() as { data: Array<{ b64_json: string }> }
      const finalMeta = await sharp(Buffer.from(firstJson.data[0]!.b64_json, 'base64')).metadata()
      assert.deepEqual(
        { width: finalMeta.width, height: finalMeta.height, format: finalMeta.format },
        { width: 142, height: 80, format: 'png' },
        'outpaint output cropped to exact 16:9 canvas',
      )
      const second = await send()
      assert.equal(second.status, 200)
      assert.deepEqual(await second.json(), firstJson)
      assert.equal(upstreamCalls, 1, 'outpaint cache replays without a second upstream call')
      // Billed exactly once at 50 credits under the annotated_edit operation.
      assert.equal(
        (await query<{ credits: string }>('SELECT credits::text AS credits FROM users WHERE id=$1', [userId.toString()])).rows[0]!.credits,
        '50',
      )
      assert.equal(
        (await query<{ count: string }>(
          "SELECT COUNT(*)::text AS count FROM credit_ledger WHERE user_id=$1 AND reason='image_generation'",
          [userId.toString()],
        )).rows[0]!.count,
        '1',
      )
    } finally {
      await close(server)
    }
  })

  test('invalid upstream image and insufficient balance never debit', async (t) => {
    if (skip(t)) return
    const richUser = await user(100n)
    await addContainer(richUser)
    const tracker = redisTracker()
    let upstreamCalls = 0
    const make = (userId: bigint) => makeCodexRelayHandler({
      identityRepo: repo(userId),
      db: { async readContainerBinding() { return { codexAccountId: 53n, userId, state: 'active', provider: 'codex', accountStatus: 'active' } } },
      upstreamBaseUrl: 'https://example.test/v1',
      resolveDispatcher: async () => ({ accountId: 53n, proxyId: 4n, dispatcher: {} as never }),
      fetchImpl: (async () => { upstreamCalls++; return Response.json({ data: [{ b64_json: 'not-an-image' }] }) }) as typeof fetch,
      pgPool: getPool(), preCheckRedis: tracker.redis, image2Enabled: true,
    })
    const server = createServer((req, res) => { void make(richUser)(req, res, CTX) })
    const port = await listen(server)
    try {
      const jobId = 'd'.repeat(32)
      const invalid = await fetch(`http://127.0.0.1:${port}${CODEX_RELAY_PREFIX}/v1/images/annotated-edits`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, [CODEX_UPSTREAM_AUTH_HEADER]: 'Bearer upstream', 'content-type': 'application/json', 'x-openclaude-image-job': jobId },
        body: await annotatedInput(jobId),
      })
      assert.equal(invalid.status, 502)
      assert.equal((await query<{ credits: string }>('SELECT credits::text AS credits FROM users WHERE id=$1', [richUser.toString()])).rows[0]!.credits, '100')
      assert.equal(upstreamCalls, 1)
    } finally { await close(server) }

    await query('TRUNCATE image_generation_usage_records, agent_containers, credit_ledger, user_subscriptions, users RESTART IDENTITY CASCADE')
    const poorUser = await user(49n)
    await addContainer(poorUser)
    const poorHandler = make(poorUser)
    const poorServer = createServer((req, res) => { void poorHandler(req, res, CTX) })
    const poorPort = await listen(poorServer)
    try {
      const jobId = 'e'.repeat(32)
      const response = await fetch(`http://127.0.0.1:${poorPort}${CODEX_RELAY_PREFIX}/v1/images/annotated-edits`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, [CODEX_UPSTREAM_AUTH_HEADER]: 'Bearer upstream', 'content-type': 'application/json', 'x-openclaude-image-job': jobId },
        body: await annotatedInput(jobId),
      })
      assert.equal(response.status, 402)
      assert.equal(upstreamCalls, 1)
    } finally { await close(poorServer) }
  })
})
