import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { beforeEach, test } from 'node:test'
import type { Pool } from 'pg'
import sharp from 'sharp'
import { truncateAllForTest, useDedicatedTestDatabase } from '../../__tests__/helpers/db.js'
import { getPool } from '../../db/index.js'
import { runMigrations } from '../../db/migrate.js'
import { query } from '../../db/queries.js'
import { LiteratureCaptchaSolver } from './captcha.js'
import { LiteratureError } from './errors.js'
import { LiteratureLoginManager } from './login.js'
import { type PlatformCaptchaUsage, createOfficialCaptchaReader } from './officialCaptchaReader.js'
import { PostgresPlatformCaptchaMeter } from './platformUsage.js'

const db = useDedicatedTestDatabase('ocv5_literature_captcha_usage_test')
let userId: number
let otherId: number
const code = (expected: string) => (error: unknown) =>
  error instanceof LiteratureError && error.code === expected
const begin = () => ({
  requestId: randomUUID(),
  provider: 'anthropic' as const,
  model: 'claude-fixture',
})
const usage = {
  inputTokens: 10,
  outputTokens: 2,
  cacheReadTokens: 3,
  cacheWriteTokens: 4,
  thoughtTokens: 0,
  totalTokens: 19,
}
async function createUser() {
  const row = await query<{ id: string }>(
    `INSERT INTO users(email,password_hash,email_verified,credits) VALUES ($1,'fixture',TRUE,12345) RETURNING id::text`,
    [`${randomUUID()}@captcha.test`],
  )
  return Number(row.rows[0]!.id)
}
function meter(operationKey = randomUUID(), owner = userId, limits = {}) {
  return new PostgresPlatformCaptchaMeter({ userId: owner, operationKey, limits })
}
async function walletSnapshot() {
  return {
    users: (await query('SELECT id::text, credits::text FROM users ORDER BY id')).rows,
    subscriptions: (
      await query(
        'SELECT user_id::text,period_credits::text FROM user_subscriptions ORDER BY user_id',
      )
    ).rows,
    ledger: (await query('SELECT COUNT(*)::int AS count FROM credit_ledger')).rows,
    usage: (await query('SELECT COUNT(*)::int AS count FROM usage_records')).rows,
  }
}
beforeEach(async () => {
  if (!db.available) return
  await truncateAllForTest(['literature_captcha_requests'])
  userId = await createUser()
  otherId = await createUser()
  await query(
    `INSERT INTO user_subscriptions(user_id,plan_code,period_end,period_credits)
    VALUES ($1,'free',NOW()+interval '30 days',100), ($2,'free',NOW()+interval '30 days',100)`,
    [userId, otherId],
  )
})

test('platform reservation and completed usage leave user wallets untouched', async (t) => {
  if (db.skipIfUnavailable(t)) return
  const before = await walletSnapshot()
  const m = meter()
  const event = begin()
  await m.beginPlatformUsage(event)
  const row = (await query('SELECT * FROM literature_captcha_requests')).rows[0]!
  assert.equal(row.outcome, null)
  assert.equal(row.input_tokens, null)
  assert(
    !Object.keys(row).some((key) => /password|cookie|image|answer|credential|api_key/.test(key)),
  )
  await m.recordPlatformUsage({ ...event, outcome: 'success', usage })
  assert.equal(
    (await query('SELECT total_tokens FROM literature_captcha_requests')).rows[0]!.total_tokens,
    19,
  )
  assert.deepEqual(await walletSnapshot(), before)
})

test('concurrent admissions cannot exceed global or per-user daily caps', async (t) => {
  if (db.skipIfUnavailable(t)) return
  // Force overlapping count/insert windows in the real database. A missing
  // admission lock must overshoot, even on a fast/serial local scheduler.
  await query(`CREATE FUNCTION literature_captcha_test_delay() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_sleep(0.03); RETURN NEW; END $$;
    CREATE TRIGGER literature_captcha_test_delay BEFORE INSERT ON literature_captcha_requests
    FOR EACH ROW EXECUTE FUNCTION literature_captcha_test_delay()`)
  try {
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        meter(randomUUID(), i % 2 ? userId : otherId, {
          globalDaily: 2,
          userDaily: 3,
        }).beginPlatformUsage(begin()),
      ),
    )
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 2)
    for (const result of results)
      if (result.status === 'rejected') assert(code('RATE_LIMITED')(result.reason))
    await truncateAllForTest(['literature_captcha_requests'])
    const perUser = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        meter(randomUUID(), userId, { globalDaily: 5, userDaily: 1 }).beginPlatformUsage(begin()),
      ),
    )
    assert.equal(perUser.filter((result) => result.status === 'fulfilled').length, 1)
    for (const result of perUser)
      if (result.status === 'rejected') assert(code('RATE_LIMITED')(result.reason))
  } finally {
    await query(`DROP TRIGGER literature_captcha_test_delay ON literature_captcha_requests;
      DROP FUNCTION literature_captcha_test_delay()`)
  }
})

test('UTC day rollover releases daily caps but never resets an operation total', async (t) => {
  if (db.skipIfUnavailable(t)) return
  const operation = randomUUID()
  const m = meter(operation, userId, { userDaily: 2, operationTotal: 2 })
  await m.beginPlatformUsage(begin())
  await m.beginPlatformUsage(begin())
  await query(
    `UPDATE literature_captcha_requests SET created_at = (date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') - interval '1 second'`,
  )
  await assert.rejects(m.beginPlatformUsage(begin()), code('RATE_LIMITED'))
  await meter(randomUUID(), userId, { userDaily: 1 }).beginPlatformUsage(begin())
  await assert.rejects(
    meter(randomUUID(), userId, { userDaily: 1 }).beginPlatformUsage(begin()),
    code('RATE_LIMITED'),
  )
})

test('duplicate admission is never permission to resend and finish is scoped and idempotent', async (t) => {
  if (db.skipIfUnavailable(t)) return
  const operation = randomUUID()
  const m = meter(operation)
  const event = begin()
  const admitted = await Promise.allSettled(
    Array.from({ length: 8 }, () => m.beginPlatformUsage(event)),
  )
  assert.equal(admitted.filter((result) => result.status === 'fulfilled').length, 1)
  for (const result of admitted)
    if (result.status === 'rejected') assert(code('RATE_LIMITED')(result.reason))
  const finished: PlatformCaptchaUsage = { ...event, outcome: 'success', usage }
  await Promise.all([m.recordPlatformUsage(finished), m.recordPlatformUsage(finished)])
  const before = (await query('SELECT * FROM literature_captcha_requests')).rows
  await assert.rejects(
    m.recordPlatformUsage({ ...finished, outcome: 'invalid' }),
    code('RESPONSE_INVALID'),
  )
  await assert.rejects(
    m.recordPlatformUsage({ ...finished, model: 'claude-other' }),
    code('NOT_FOUND'),
  )
  await assert.rejects(meter(operation, otherId).recordPlatformUsage(finished), code('NOT_FOUND'))
  await assert.rejects(meter().recordPlatformUsage(finished), code('NOT_FOUND'))
  await assert.rejects(
    m.recordPlatformUsage({ ...finished, requestId: randomUUID() }),
    code('NOT_FOUND'),
  )
  assert.deepEqual((await query('SELECT * FROM literature_captcha_requests')).rows, before)
})

test('unfinished and unknown-usage attempts still occupy quota after a new meter instance', async (t) => {
  if (db.skipIfUnavailable(t)) return
  const m = meter(randomUUID(), userId, { userDaily: 2 })
  const unknown = begin()
  await m.beginPlatformUsage(unknown)
  await m.beginPlatformUsage(begin())
  await m.recordPlatformUsage({ ...unknown, outcome: 'network_error', usage: null })
  await assert.rejects(
    meter(randomUUID(), userId, { userDaily: 2 }).beginPlatformUsage(begin()),
    code('RATE_LIMITED'),
  )
  const rows = (await query('SELECT outcome,total_tokens FROM literature_captcha_requests')).rows
  assert.equal(rows.length, 2)
  assert(rows.every((row) => row.total_tokens === null))
  assert.equal(rows.filter((row) => row.outcome === null).length, 1)
})

test('deleting a user preserves the anonymous reservation in the global budget', async (t) => {
  if (db.skipIfUnavailable(t)) return
  const deleted = await createUser()
  await meter(randomUUID(), deleted, { globalDaily: 1 }).beginPlatformUsage(begin())
  await query('DELETE FROM users WHERE id = $1', [deleted])
  assert.equal(
    (await query('SELECT user_id FROM literature_captcha_requests')).rows[0]!.user_id,
    null,
  )
  await assert.rejects(
    meter(randomUUID(), userId, { globalDaily: 1 }).beginPlatformUsage(begin()),
    code('RATE_LIMITED'),
  )
})

test('an acknowledged-lost COMMIT retains quota and causes zero provider dispatches', async (t) => {
  if (db.skipIfUnavailable(t)) return
  const pool = getPool()
  const uncertainPool = {
    async connect() {
      const client = await pool.connect()
      return {
        async query(sql: string, params?: unknown[]) {
          const result = await client.query(sql, params)
          if (sql === 'COMMIT') throw new Error('synthetic commit acknowledgement lost')
          return result
        },
        release() {
          client.release()
        },
      }
    },
  } as unknown as Pool
  const m = new PostgresPlatformCaptchaMeter({
    userId,
    operationKey: randomUUID(),
    pool: uncertainPool,
    limits: { userDaily: 1 },
  })
  let fetches = 0
  const config = {
    provider: 'anthropic' as const,
    model: 'claude-fixture',
    upstreamModel: 'claude-fixture-001',
    usageApproved: true,
  }
  const reader = createOfficialCaptchaReader(config, 'fixture-operation', {
    resolveRoute: async () => ({
      ...config,
      active: true,
      supportsVision: true,
      transport: 'official-api',
    }),
    selectKey: async () => ({
      service: 'claude',
      memberId: 'fixture-member',
      apiKey: 'synthetic-fixture-api-key',
    }),
    beginPlatformUsage: m.beginPlatformUsage.bind(m),
    recordPlatformUsage: m.recordPlatformUsage.bind(m),
    reportOutcome: async () => {
      assert.fail('no provider health report before dispatch')
    },
    fetchImpl: async () => {
      fetches++
      throw new Error('provider must not be dispatched')
    },
  })
  const image = {
    data: await sharp({ create: { width: 47, height: 20, channels: 3, background: '#666666' } })
      .png()
      .toBuffer(),
    mediaType: 'image/png' as const,
  }
  await assert.rejects(
    reader.recognize({
      image,
      prompt: '',
      maxOutputTokens: 64,
      signal: AbortSignal.timeout(15_000),
    }),
    code('MODEL_UNAVAILABLE'),
  )
  assert.equal(fetches, 0)
  assert.equal(
    (await query('SELECT COUNT(*)::int AS count FROM literature_captcha_requests')).rows[0]!.count,
    1,
  )
  await assert.rejects(
    meter(randomUUID(), userId, { userDaily: 1 }).beginPlatformUsage(begin()),
    code('RATE_LIMITED'),
  )
})

test('migration rollback refuses retained usage and an empty-table rollback can be reapplied', async (t) => {
  if (db.skipIfUnavailable(t)) return
  await meter().beginPlatformUsage(begin())
  const sql = await readFile(
    new URL('../../db/rollbacks/0322_selfhost_literature_captcha_requests.sql', import.meta.url),
    'utf8',
  )
  const client = await getPool().connect()
  try {
    await assert.rejects(client.query(sql), /retained platform usage/)
    await client.query('ROLLBACK')
    assert.equal(
      (await client.query("SELECT to_regclass('literature_captcha_requests')::text AS name"))
        .rows[0].name,
      'literature_captcha_requests',
    )
    await truncateAllForTest(['literature_captcha_requests'], client)
    await client.query(sql)
    assert.equal(
      (await client.query("SELECT to_regclass('literature_captcha_requests') AS name")).rows[0]
        .name,
      null,
    )
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
  await runMigrations()
  await meter().beginPlatformUsage(begin())
})

test('one manager meters interleaved tenant operations under their actual IDs across retries', async (t) => {
  if (db.skipIfUnavailable(t)) return
  const image = {
    data: await sharp({ create: { width: 47, height: 20, channels: 3, background: '#666666' } })
      .png()
      .toBuffer(),
    mediaType: 'image/png' as const,
  }
  const config = {
    provider: 'anthropic' as const,
    model: 'claude-fixture',
    upstreamModel: 'claude-fixture-001',
    usageApproved: true,
  }
  const before = await walletSnapshot()
  let factories = 0
  const manager = new LiteratureLoginManager(({ owner, operationId }) => {
    factories++
    const m = new PostgresPlatformCaptchaMeter({ userId: owner.userId, operationKey: operationId })
    const reader = createOfficialCaptchaReader(config, operationId, {
      resolveRoute: async () => ({
        ...config,
        active: true,
        supportsVision: true,
        transport: 'official-api',
      }),
      selectKey: async () => ({
        service: 'claude',
        memberId: 'fixture-member',
        apiKey: 'synthetic-fixture-api-key',
      }),
      beginPlatformUsage: (event) => m.beginPlatformUsage(event),
      recordPlatformUsage: (event) => m.recordPlatformUsage(event),
      reportOutcome: async () => {},
      fetchImpl: async () => {
        await new Promise((resolve) => setImmediate(resolve))
        return new Response(
          JSON.stringify({
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: '1234' }],
            usage: { input_tokens: 4, output_tokens: 2 },
          }),
          { headers: { 'content-type': 'application/json' } },
        )
      },
    })
    return new LiteratureCaptchaSolver([reader])
  })
  t.after(() => manager.close())
  function open(retry: boolean) {
    let submits = 0
    return async () => ({
      challenge: async () => image,
      submit: async () =>
        retry && submits++ === 0 ? ('captcha_invalid' as const) : ('authenticated' as const),
      probe: async () => false,
      snapshot: async () => ({}),
      close: async () => {},
    })
  }
  const a = manager.start({ userId, accountId: '1' }, open(true), async () => {})
  const b = manager.start({ userId: otherId, accountId: '1' }, open(false), async () => {})
  assert.equal((await manager.settled(userId, a.operationId)).status, 'authenticated')
  assert.equal((await manager.settled(otherId, b.operationId)).status, 'authenticated')
  assert.equal(factories, 2)
  const rows = (
    await query<{ user_id: string; operation_key: string; count: number }>(
      'SELECT user_id::text AS user_id,operation_key,COUNT(*)::int AS count FROM literature_captcha_requests GROUP BY user_id,operation_key ORDER BY literature_captcha_requests.user_id',
    )
  ).rows
  assert.deepEqual(rows, [
    { user_id: String(userId), operation_key: a.operationId, count: 2 },
    { user_id: String(otherId), operation_key: b.operationId, count: 1 },
  ])
  assert.deepEqual(await walletSnapshot(), before)
})
