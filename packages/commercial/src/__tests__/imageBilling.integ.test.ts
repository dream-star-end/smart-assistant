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
  beginImageUpstreamAttempt,
  finishImageUpstreamAttempt,
  getCompletedImageUsage,
  markImageUsage,
  reserveImageUsage,
  settleImageCharge,
  sweepStaleImageUsage,
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
  const client = new Client({ connectionString: BASE_URL, connectionTimeoutMillis: 5000 })
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
  // Abort any straggling relay query before Pool.end(): a disconnected HTTP
  // client can outlive its socket briefly, and Pool.end() waits forever for a
  // checked-out client. The dedicated test database makes termination safe.
  await admin(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DB_NAME}' AND pid<>pg_backend_pid()`).catch(() => {})
  await closePool()
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
  test('global stale sweep finalizes abandoned journeys and pending attempts', async (t) => {
    if (skip(t)) return
    const userId = await user()
    const requestId = 'image:stale-global'
    await reserveImageUsage(getPool(), {
      userId, containerId: null, requestId, operation: 'generation',
    })
    await beginImageUpstreamAttempt(getPool(), { userId, requestId })
    await query(
      `UPDATE image_generation_usage_records
          SET updated_at=NOW()-INTERVAL '16 minutes'
        WHERE user_id=$1 AND request_id=$2`,
      [userId.toString(), requestId],
    )
    assert.equal(await sweepStaleImageUsage(getPool()), 1)
    assert.deepEqual((await query<{ status: string; error_code: string | null }>(
      `SELECT status,error_code FROM image_generation_usage_records
        WHERE user_id=$1 AND request_id=$2`,
      [userId.toString(), requestId],
    )).rows, [{ status: 'failed', error_code: 'IMAGE_STALE_TIMEOUT' }])
    assert.deepEqual((await query<{ outcome: string; error_code: string | null }>(
      `SELECT outcome,error_code FROM image_generation_attempts WHERE user_id=$1`,
      [userId.toString()],
    )).rows, [{ outcome: 'failed', error_code: 'IMAGE_STALE_TIMEOUT' }])
    assert.equal(await sweepStaleImageUsage(getPool()), 0, 'sweep is idempotent')
  })

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

  test('native_image bills 50×n and records image_count/cost_credits', async (t) => {
    if (skip(t)) return
    const userId = await user()
    const requestId = 'native:' + 'a'.repeat(64)
    const reserved = await reserveImageUsage(getPool(), {
      userId, containerId: null, requestId, operation: 'native_image', imageCount: 2,
    })
    assert.equal(reserved.alreadyCharged, false)
    const body = Buffer.from('{"data":[{"b64_json":"x"},{"b64_json":"y"}]}')
    const settled = await settleImageCharge(getPool(), {
      userId, containerId: null, requestId, operation: 'native_image', imageCount: 2, responseBody: body,
    })
    assert.equal(settled.duplicate, false)
    assert.equal((await query<{ credits: string }>('SELECT credits::text AS credits FROM users WHERE id=$1', [userId.toString()])).rows[0]!.credits, '400')
    assert.deepEqual(
      (await query<{ delta: string }>("SELECT delta::text AS delta FROM credit_ledger WHERE user_id=$1 AND reason='image_generation'", [userId.toString()])).rows,
      [{ delta: '-100' }],
    )
    const rec = await query<{ image_count: number; cost_credits: string; operation: string }>(
      'SELECT image_count, cost_credits::text AS cost_credits, operation FROM image_generation_usage_records WHERE user_id=$1 AND request_id=$2',
      [userId.toString(), requestId],
    )
    assert.deepEqual(rec.rows[0], { image_count: 2, cost_credits: '100', operation: 'native_image' })
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

  test('0151 remains writable by the old runtime and captures only proven legacy fetches', async (t) => {
    if (skip(t)) return
    const userId = await user()
    const relayRequest = 'image:legacy-relay'
    const invalidRequest = 'image:legacy-invalid'
    const successRequest = 'image:legacy-success'

    // These are the exact lowercase writes made by the pre-0151 process while
    // the backward-compatible migration is already live.
    await reserveImageUsage(getPool(), {
      userId, containerId: null, requestId: relayRequest, operation: 'generation',
    })
    await query(
      `UPDATE image_generation_usage_records
          SET status='failed',error_code='relay_failed',updated_at=NOW()
        WHERE user_id=$1 AND request_id=$2`,
      [userId.toString(), relayRequest],
    )
    await reserveImageUsage(getPool(), {
      userId, containerId: null, requestId: invalidRequest, operation: 'generation',
    })
    await query(
      `UPDATE image_generation_usage_records
          SET status='failed',error_code='invalid_request',updated_at=NOW()
        WHERE user_id=$1 AND request_id=$2`,
      [userId.toString(), invalidRequest],
    )
    await reserveImageUsage(getPool(), {
      userId, containerId: null, requestId: successRequest, operation: 'generation',
    })
    await query(
      `UPDATE image_generation_usage_records
          SET status='success',error_code=NULL,completed_at=NOW(),updated_at=NOW()
        WHERE user_id=$1 AND request_id=$2`,
      [userId.toString(), successRequest],
    )

    assert.deepEqual((await query<{ request_id: string; attempt_count: number; error_code: string | null }>(
      `SELECT request_id,attempt_count,error_code
         FROM image_generation_usage_records WHERE user_id=$1 ORDER BY request_id`,
      [userId.toString()],
    )).rows, [
      { request_id: invalidRequest, attempt_count: 0, error_code: 'invalid_request' },
      { request_id: relayRequest, attempt_count: 1, error_code: 'relay_failed' },
      { request_id: successRequest, attempt_count: 1, error_code: null },
    ])
    assert.deepEqual((await query<{ request_id: string; outcome: string; error_code: string | null }>(
      `SELECT u.request_id,a.outcome,a.error_code
         FROM image_generation_attempts a
         JOIN image_generation_usage_records u ON u.id=a.usage_id
        WHERE a.user_id=$1 ORDER BY u.request_id`,
      [userId.toString()],
    )).rows, [
      { request_id: relayRequest, outcome: 'failed', error_code: 'IMAGE_RELAY_FAILED' },
      { request_id: successRequest, outcome: 'succeeded', error_code: null },
    ])
  })

  test('attempt_count is cumulative across failed journey recovery and every real fetch has a row', async (t) => {
    if (skip(t)) return
    const userId = await user()
    const requestId = 'image:cumulative-recovery'
    await reserveImageUsage(getPool(), { userId, containerId: null, requestId, operation: 'generation' })
    const first = await beginImageUpstreamAttempt(getPool(), { userId, requestId })
    await finishImageUpstreamAttempt(getPool(), {
      userId, requestId, attemptId: first.attemptId,
      outcome: 'failed', errorCode: 'IMAGE_UPSTREAM_RATE_LIMITED',
    })
    await markImageUsage(getPool(), {
      userId, containerId: null, requestId, operation: 'generation',
      status: 'failed', errorCode: 'IMAGE_UPSTREAM_RATE_LIMITED',
    })

    await reserveImageUsage(getPool(), { userId, containerId: null, requestId, operation: 'generation' })
    const second = await beginImageUpstreamAttempt(getPool(), { userId, requestId })
    await finishImageUpstreamAttempt(getPool(), {
      userId, requestId, attemptId: second.attemptId, outcome: 'succeeded',
    })

    assert.equal(second.attemptNo, 2, 'reopening a failed stable request must not reset journey attempts')
    assert.deepEqual((await query<{ attempt_count: number; last_attempt_at: Date | null }>(
      `SELECT attempt_count,last_attempt_at FROM image_generation_usage_records
        WHERE user_id=$1 AND request_id=$2`,
      [userId.toString(), requestId],
    )).rows.map((row) => ({ attempt_count: row.attempt_count, hasLastAttempt: row.last_attempt_at instanceof Date })), [
      { attempt_count: 2, hasLastAttempt: true },
    ])
    assert.deepEqual((await query<{ attempt_no: number; outcome: string; error_code: string | null }>(
      `SELECT attempt_no,outcome,error_code FROM image_generation_attempts
        WHERE user_id=$1 ORDER BY attempt_no`,
      [userId.toString()],
    )).rows, [
      { attempt_no: 1, outcome: 'failed', error_code: 'IMAGE_UPSTREAM_RATE_LIMITED' },
      { attempt_no: 2, outcome: 'succeeded', error_code: null },
    ])
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
  test('explicit short 429 retries once under the same reservation and charges once', async (t) => {
    if (skip(t)) return
    const userId = await user(100n)
    await addContainer(userId)
    const tracker = redisTracker()
    const generated = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#33aa77' } }).png().toBuffer()
    let upstreamCalls = 0
    const handler = makeCodexRelayHandler({
      identityRepo: repo(userId),
      db: { async readContainerBinding() { return { codexAccountId: 53n, userId, state: 'active', provider: 'codex', accountStatus: 'active' } } },
      upstreamBaseUrl: 'https://example.test/v1',
      resolveDispatcher: async () => ({ accountId: 53n, proxyId: 4n, dispatcher: {} as never }),
      fetchImpl: (async () => {
        upstreamCalls++
        if (upstreamCalls === 1) return new Response('', { status: 429, headers: { 'retry-after': '0' } })
        return Response.json({ data: [{ b64_json: generated.toString('base64') }] })
      }) as typeof fetch,
      pgPool: getPool(), preCheckRedis: tracker.redis, image2Enabled: true,
    })
    const server = createServer((req, res) => { void handler(req, res, CTX) })
    const port = await listen(server)
    const jobId = '8'.repeat(32)
    try {
      const response = await fetch(`http://127.0.0.1:${port}${CODEX_RELAY_PREFIX}/v1/images/annotated-edits`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, [CODEX_UPSTREAM_AUTH_HEADER]: 'Bearer upstream', 'content-type': 'application/json', 'x-openclaude-image-job': jobId },
        body: await annotatedInput(jobId),
      })
      assert.equal(response.status, 200)
      assert.equal(upstreamCalls, 2)
      assert.equal(tracker.releases(), 1, 'one reservation is released exactly once')
      assert.deepEqual((await query<{ status: string; attempt_count: number }>(
        'SELECT status,attempt_count FROM image_generation_usage_records WHERE user_id=$1 AND request_id=$2',
        [userId.toString(), `image-job:${jobId}`],
      )).rows, [{ status: 'success', attempt_count: 2 }])
      assert.deepEqual((await query<{ attempt_no: number; outcome: string; error_code: string | null }>(
        `SELECT attempt_no,outcome,error_code FROM image_generation_attempts
          WHERE user_id=$1 ORDER BY attempt_no`,
        [userId.toString()],
      )).rows, [
        { attempt_no: 1, outcome: 'failed', error_code: 'IMAGE_UPSTREAM_RATE_LIMITED' },
        { attempt_no: 2, outcome: 'succeeded', error_code: null },
      ])
      assert.equal((await query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM credit_ledger WHERE user_id=$1 AND reason='image_generation'",
        [userId.toString()],
      )).rows[0]!.count, '1')
      assert.equal((await query<{ credits: string }>('SELECT credits::text AS credits FROM users WHERE id=$1', [userId.toString()])).rows[0]!.credits, '50')
    } finally {
      await close(server)
    }
  })

  test('client abort during Retry-After wait records only the fetch that actually started', async (t) => {
    if (skip(t)) return
    const userId = await user(100n)
    await addContainer(userId)
    const tracker = redisTracker()
    let upstreamCalls = 0
    let resolveFirst!: () => void
    const firstCall = new Promise<void>((resolve) => { resolveFirst = resolve })
    const handler = makeCodexRelayHandler({
      identityRepo: repo(userId),
      db: { async readContainerBinding() { return { codexAccountId: 53n, userId, state: 'active', provider: 'codex', accountStatus: 'active' } } },
      upstreamBaseUrl: 'https://example.test/v1',
      resolveDispatcher: async () => ({ accountId: 53n, proxyId: 4n, dispatcher: {} as never }),
      fetchImpl: (async () => {
        upstreamCalls++
        resolveFirst()
        return new Response('', { status: 429, headers: { 'retry-after': '2' } })
      }) as typeof fetch,
      pgPool: getPool(), preCheckRedis: tracker.redis, image2Enabled: true,
    })
    const server = createServer((req, res) => { void handler(req, res, CTX) })
    const port = await listen(server)
    const jobId = '9'.repeat(32)
    const controller = new AbortController()
    try {
      const request = fetch(`http://127.0.0.1:${port}${CODEX_RELAY_PREFIX}/v1/images/annotated-edits`, {
        method: 'POST', signal: controller.signal,
        headers: { authorization: `Bearer ${TOKEN}`, [CODEX_UPSTREAM_AUTH_HEADER]: 'Bearer upstream', 'content-type': 'application/json', 'x-openclaude-image-job': jobId },
        body: await annotatedInput(jobId),
      })
      await firstCall
      controller.abort()
      await assert.rejects(request)
      await new Promise((resolve) => setTimeout(resolve, 200))
      assert.equal(upstreamCalls, 1, 'abort in the delay must happen before a second upstream fetch')
      assert.deepEqual((await query<{ attempt_count: number; status: string; error_code: string | null }>(
        `SELECT attempt_count,status,error_code FROM image_generation_usage_records
          WHERE user_id=$1 AND request_id=$2`,
        [userId.toString(), `image-job:${jobId}`],
      )).rows, [{ attempt_count: 1, status: 'failed', error_code: 'IMAGE_CLIENT_ABORT' }])
      assert.deepEqual((await query<{ attempt_no: number; outcome: string; error_code: string | null }>(
        `SELECT attempt_no,outcome,error_code FROM image_generation_attempts
          WHERE user_id=$1 ORDER BY attempt_no`,
        [userId.toString()],
      )).rows, [{ attempt_no: 1, outcome: 'failed', error_code: 'IMAGE_UPSTREAM_RATE_LIMITED' }])
    } finally {
      await close(server)
    }
  })

  test('429 retry followed by network throw records the second attempt as relay failure', async (t) => {
    if (skip(t)) return
    const userId = await user(100n)
    await addContainer(userId)
    const tracker = redisTracker()
    let upstreamCalls = 0
    const handler = makeCodexRelayHandler({
      identityRepo: repo(userId),
      db: { async readContainerBinding() { return { codexAccountId: 53n, userId, state: 'active', provider: 'codex', accountStatus: 'active' } } },
      upstreamBaseUrl: 'https://example.test/v1',
      resolveDispatcher: async () => ({ accountId: 53n, proxyId: 4n, dispatcher: {} as never }),
      fetchImpl: (async () => {
        upstreamCalls++
        if (upstreamCalls === 1) return new Response('', { status: 429, headers: { 'retry-after': '0' } })
        throw new Error('simulated network reset')
      }) as typeof fetch,
      pgPool: getPool(), preCheckRedis: tracker.redis, image2Enabled: true,
    })
    const server = createServer((req, res) => { void handler(req, res, CTX) })
    const port = await listen(server)
    const jobId = 'a'.repeat(32)
    try {
      const response = await fetch(`http://127.0.0.1:${port}${CODEX_RELAY_PREFIX}/v1/images/annotated-edits`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, [CODEX_UPSTREAM_AUTH_HEADER]: 'Bearer upstream', 'content-type': 'application/json', 'x-openclaude-image-job': jobId },
        body: await annotatedInput(jobId),
      })
      assert.equal(response.status, 502)
      assert.equal(upstreamCalls, 2)
      assert.deepEqual((await query<{ attempt_no: number; error_code: string | null }>(
        `SELECT attempt_no,error_code FROM image_generation_attempts
          WHERE user_id=$1 ORDER BY attempt_no`,
        [userId.toString()],
      )).rows, [
        { attempt_no: 1, error_code: 'IMAGE_UPSTREAM_RATE_LIMITED' },
        { attempt_no: 2, error_code: 'IMAGE_RELAY_FAILED' },
      ])
      assert.deepEqual((await query<{ status: string; error_code: string | null; attempt_count: number }>(
        `SELECT status,error_code,attempt_count FROM image_generation_usage_records
          WHERE user_id=$1 AND request_id=$2`,
        [userId.toString(), `image-job:${jobId}`],
      )).rows, [{ status: 'failed', error_code: 'IMAGE_RELAY_FAILED', attempt_count: 2 }])
    } finally {
      await close(server)
    }
  })

  test('429 without Retry-After and all 5xx never auto-retry or charge', async (t) => {
    if (skip(t)) return
    const userId = await user(100n)
    await addContainer(userId)
    const tracker = redisTracker()
    const statuses = [429, 503]
    let upstreamCalls = 0
    const handler = makeCodexRelayHandler({
      identityRepo: repo(userId),
      db: { async readContainerBinding() { return { codexAccountId: 53n, userId, state: 'active', provider: 'codex', accountStatus: 'active' } } },
      upstreamBaseUrl: 'https://example.test/v1',
      resolveDispatcher: async () => ({ accountId: 53n, proxyId: 4n, dispatcher: {} as never }),
      fetchImpl: (async () => {
        const status = statuses[upstreamCalls++]!
        return new Response('{"error":"provider detail must not matter"}', {
          status,
          headers: status === 503 ? { 'retry-after': '0' } : {},
        })
      }) as typeof fetch,
      pgPool: getPool(), preCheckRedis: tracker.redis, image2Enabled: true,
    })
    const server = createServer((req, res) => { void handler(req, res, CTX) })
    const port = await listen(server)
    try {
      for (const [i, expectedStatus] of statuses.entries()) {
        const jobId = String(i + 6).repeat(32)
        const response = await fetch(`http://127.0.0.1:${port}${CODEX_RELAY_PREFIX}/v1/images/annotated-edits`, {
          method: 'POST',
          headers: { authorization: `Bearer ${TOKEN}`, [CODEX_UPSTREAM_AUTH_HEADER]: 'Bearer upstream', 'content-type': 'application/json', 'x-openclaude-image-job': jobId },
          body: await annotatedInput(jobId),
        })
        assert.equal(response.status, expectedStatus)
      }
      assert.equal(upstreamCalls, 2, 'each request reaches upstream exactly once')
      assert.equal(tracker.releases(), 2)
      assert.deepEqual((await query<{ status: string; attempt_count: number; error_code: string | null }>(
        'SELECT status,attempt_count,error_code FROM image_generation_usage_records WHERE user_id=$1 ORDER BY request_id',
        [userId.toString()],
      )).rows, [
        { status: 'failed', attempt_count: 1, error_code: 'IMAGE_UPSTREAM_RATE_LIMITED' },
        { status: 'failed', attempt_count: 1, error_code: 'IMAGE_UPSTREAM_FAILED' },
      ])
      assert.equal((await query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM credit_ledger WHERE user_id=$1 AND reason='image_generation'",
        [userId.toString()],
      )).rows[0]!.count, '0')
    } finally {
      await close(server)
    }
  })

  // Regression guard for the R7 "Unsupported content type" 400: the codex backend
  // /images/edits endpoint only accepts application/json (multipart is rejected)
  // and has no separate `mask` field — the mask must ride in the image alpha
  // channel. Assert the REALIZED upstream request form (content-type + JSON body
  // shape), not merely our intent.
  for (const shape of ['annotated', 'outpaint'] as const) {
    test(`sends ${shape} to upstream as application/json with images[{image_url}] and no multipart/mask`, async (t) => {
      if (skip(t)) return
      const userId = await user(100n)
      await addContainer(userId)
      const tracker = redisTracker()
      const generated = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#2288cc' } }).png().toBuffer()
      // ref 对象而非裸 let:TS CFA 不追踪闭包内对局部变量的赋值(microsoft/TypeScript#9998),
      // 裸 let 在下方 assert.ok 处会被窄化成 null,`captured!` 变 never → 属性访问全线报错。
      const captured: { current: { contentType: string | null; body: string; isFormData: boolean } | null } = { current: null }
      const handler = makeCodexRelayHandler({
        identityRepo: repo(userId),
        db: { async readContainerBinding() { return { codexAccountId: 53n, userId, state: 'active', provider: 'codex', accountStatus: 'active' } } },
        upstreamBaseUrl: 'https://example.test/v1',
        resolveDispatcher: async () => ({ accountId: 53n, proxyId: 4n, dispatcher: {} as never }),
        fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
          // Realize the request exactly as undici would (content-type gets derived
          // from a FormData body; an explicit header survives for a string body).
          const realized = new Request(String(input), { method: 'POST', headers: init?.headers, body: init?.body as BodyInit })
          captured.current = {
            contentType: realized.headers.get('content-type'),
            body: await realized.text(),
            isFormData: init?.body instanceof FormData,
          }
          return Response.json({ data: [{ b64_json: generated.toString('base64') }] })
        }) as unknown as typeof fetch,
        pgPool: getPool(),
        preCheckRedis: tracker.redis,
        image2Enabled: true,
      })
      const server = createServer((req, res) => { void handler(req, res, CTX) })
      const port = await listen(server)
      const jobId = (shape === 'annotated' ? 'a' : 'b').repeat(32)
      try {
        const res = await fetch(`http://127.0.0.1:${port}${CODEX_RELAY_PREFIX}/v1/images/annotated-edits`, {
          method: 'POST',
          headers: { authorization: `Bearer ${TOKEN}`, [CODEX_UPSTREAM_AUTH_HEADER]: 'Bearer upstream', 'content-type': 'application/json', 'x-openclaude-image-job': jobId },
          body: shape === 'annotated' ? await annotatedInput(jobId) : await outpaintInput(jobId),
        })
        assert.equal(res.status, 200)
        assert.ok(captured.current, 'upstream must have been called')
        const cap = captured.current
        assert.equal(cap.isFormData, false, 'upstream body must not be multipart FormData')
        assert.equal(cap.contentType, 'application/json', 'upstream content-type must be application/json (multipart is rejected by codex backend)')
        const parsed = JSON.parse(cap.body) as { model?: string; prompt?: string; n?: number; size?: string; images?: Array<{ image_url?: string }>; mask?: unknown }
        assert.equal(parsed.model, 'gpt-image-2')
        assert.equal(typeof parsed.prompt, 'string')
        assert.equal(parsed.n, 1)
        assert.equal(typeof parsed.size, 'string')
        assert.equal(parsed.mask, undefined, 'endpoint has no separate mask field; mask must be baked into the image alpha')
        assert.equal(parsed.images?.length, 1)
        const url = parsed.images?.[0]?.image_url ?? ''
        assert.ok(url.startsWith('data:image/png;base64,'), 'image must be sent as a png data URL')
        // The image the model receives must carry an alpha channel (transparency =
        // editable region); without it the endpoint's mask-via-alpha edit is lost.
        const sent = await sharp(Buffer.from(url.slice('data:image/png;base64,'.length), 'base64')).metadata()
        assert.equal(sent.hasAlpha, true, 'sent image must have an alpha channel encoding the mask')
      } finally {
        await close(server)
      }
    })
  }

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
      assert.equal((await query<{ attempt_count: number }>(
        `SELECT attempt_count FROM image_generation_usage_records
          WHERE user_id=$1 AND request_id=$2`,
        [userId.toString(), `image-job:${jobId}`],
      )).rows[0]!.attempt_count, 2, 'paid cache recovery adds to the same stable journey')
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

  test('native imagegen bills 50×n once, clamps n to [1,4], and replays cache by content hash', async (t) => {
    if (skip(t)) return
    const userId = await user(500n)
    await addContainer(userId)
    const tracker = redisTracker()
    const generated = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#3366cc' } }).png().toBuffer()
    let upstreamCalls = 0
    const handler = makeCodexRelayHandler({
      identityRepo: repo(userId),
      db: { async readContainerBinding() { return { codexAccountId: 53n, userId, state: 'active', provider: 'codex', accountStatus: 'active' } } },
      upstreamBaseUrl: 'https://example.test/v1',
      resolveDispatcher: async () => ({ accountId: 53n, proxyId: 4n, dispatcher: {} as never }),
      // Upstream honours whatever n we forwarded (clamped): returns exactly that many images.
      fetchImpl: (async (_url: string, init: RequestInit) => {
        upstreamCalls++
        const n = (JSON.parse(String(init.body)) as { n: number }).n
        return Response.json({ data: Array.from({ length: n }, () => ({ b64_json: generated.toString('base64') })) })
      }) as unknown as typeof fetch,
      pgPool: getPool(), preCheckRedis: tracker.redis, image2Enabled: true,
    })
    const server = createServer((req, res) => { void handler(req, res, CTX) })
    const port = await listen(server)
    const gen = async (n: number, prompt = 'a blue square') => fetch(`http://127.0.0.1:${port}${CODEX_RELAY_PREFIX}/v1/images/generations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, [CODEX_UPSTREAM_AUTH_HEADER]: 'Bearer upstream', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-2', prompt, n }),
    })
    try {
      const first = await gen(2)
      assert.equal(first.status, 200)
      const firstJson = await first.json() as { data: Array<{ b64_json: string }> }
      assert.equal(firstJson.data.length, 2, 'forwards n=2 and returns 2 images')
      assert.equal(upstreamCalls, 1)
      // Identical request → identical content hash → cached replay, no second upstream call, no second charge.
      const second = await gen(2)
      assert.equal(second.status, 200)
      assert.deepEqual(await second.json(), firstJson)
      assert.equal(upstreamCalls, 1, 'identical native request replays cache without a second upstream call')
      assert.equal((await query<{ credits: string }>('SELECT credits::text AS credits FROM users WHERE id=$1', [userId.toString()])).rows[0]!.credits, '400', '50×2 charged exactly once')
      // n above the ceiling clamps to 4; different prompt = different hash = a new paid generation.
      const clamped = await gen(9, 'a green triangle')
      assert.equal(clamped.status, 200)
      assert.equal((await clamped.json() as { data: unknown[] }).data.length, 4, 'n=9 clamped to 4 images')
      assert.equal(upstreamCalls, 2)
      assert.equal((await query<{ credits: string }>('SELECT credits::text AS credits FROM users WHERE id=$1', [userId.toString()])).rows[0]!.credits, '200', '50×4 charged for the clamped request')
      assert.equal((await query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM credit_ledger WHERE user_id=$1 AND reason='image_generation'",
        [userId.toString()],
      )).rows[0]!.count, '2')
    } finally {
      await close(server)
    }
  })

  test('native imagegen with insufficient balance never debits or calls upstream', async (t) => {
    if (skip(t)) return
    const userId = await user(50n) // needs 50×2=100 for n=2
    await addContainer(userId)
    const tracker = redisTracker()
    let upstreamCalls = 0
    const handler = makeCodexRelayHandler({
      identityRepo: repo(userId),
      db: { async readContainerBinding() { return { codexAccountId: 53n, userId, state: 'active', provider: 'codex', accountStatus: 'active' } } },
      upstreamBaseUrl: 'https://example.test/v1',
      resolveDispatcher: async () => ({ accountId: 53n, proxyId: 4n, dispatcher: {} as never }),
      fetchImpl: (async () => { upstreamCalls++; return Response.json({ data: [] }) }) as typeof fetch,
      pgPool: getPool(), preCheckRedis: tracker.redis, image2Enabled: true,
    })
    const server = createServer((req, res) => { void handler(req, res, CTX) })
    const port = await listen(server)
    try {
      const response = await fetch(`http://127.0.0.1:${port}${CODEX_RELAY_PREFIX}/v1/images/generations`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, [CODEX_UPSTREAM_AUTH_HEADER]: 'Bearer upstream', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-image-2', prompt: 'a red square', n: 2 }),
      })
      assert.equal(response.status, 402)
      assert.equal(upstreamCalls, 0, 'precheck fails before any upstream call')
      assert.equal((await query<{ credits: string }>('SELECT credits::text AS credits FROM users WHERE id=$1', [userId.toString()])).rows[0]!.credits, '50', 'no debit')
    } finally { await close(server) }
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
