import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'

import { enqueueQqDelivery } from '../qqbot/outbox.js'
import { consumeBindCode, createBindCode, getQqBinding, unbindQq } from '../qqbot/store.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'
const SCHEMA = 'oc_migration0187_test'
const here = path.dirname(fileURLToPath(import.meta.url))
const MIGRATION = path.resolve(here, '../db/migrations/0187_qq_bot_channel.sql')
const SECRET = 'binding-hmac-secret-'.padEnd(40, 'x')

let pool: Pool
let pgAvailable = false

before(async () => {
  const probe = new Pool({ connectionString: TEST_DB_URL, max: 1, connectionTimeoutMillis: 1500 })
  try {
    await probe.query('SELECT 1')
    pgAvailable = true
  } catch {
    if (REQUIRE_TEST_DB) throw new Error('Postgres test fixture required')
  } finally {
    await probe.end().catch(() => undefined)
  }
  if (!pgAvailable) return
  const admin = new Pool({ connectionString: TEST_DB_URL, max: 1 })
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
  await admin.query(`CREATE SCHEMA ${SCHEMA}`)
  await admin.end()
  pool = new Pool({
    connectionString: TEST_DB_URL,
    max: 4,
    options: `-c search_path=${SCHEMA}`,
  })
  await pool.query('CREATE TABLE users (id BIGINT PRIMARY KEY)')
  await pool.query('INSERT INTO users(id) VALUES (1),(2)')
  await pool.query(await readFile(MIGRATION, 'utf8'))
})

after(async () => {
  if (!pgAvailable) return
  await pool.end()
  const admin = new Pool({ connectionString: TEST_DB_URL, max: 1 })
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
  await admin.end()
})

function maybe(name: string, fn: () => Promise<void>): void {
  test(name, async (t) => {
    if (!pgAvailable) return t.skip('Postgres unavailable')
    await fn()
  })
}

describe('0187_qq_bot_channel', () => {
  maybe('atomically binds one OpenID to one user and preserves the losing token', async () => {
    const first = await createBindCode(pool, 1n, SECRET, 1_000)
    const second = await createBindCode(pool, 2n, SECRET, 1_000)
    assert.equal(
      (await consumeBindCode(pool, first.code, 'openid-one', SECRET, 2_000)).kind,
      'bound',
    )
    assert.equal(
      (await consumeBindCode(pool, second.code, 'openid-one', SECRET, 2_001)).kind,
      'already_bound_elsewhere',
    )
    assert.equal(
      (await consumeBindCode(pool, second.code, 'openid-two', SECRET, 2_002)).kind,
      'bound',
    )
    assert.equal((await getQqBinding(pool, 2n))?.openid, 'openid-two')
  })

  maybe(
    'queues text before every media child and deduplicates the whole delivery tree',
    async () => {
      const args = {
        deliveryId: 'delivery.stageb.mixed',
        userId: 2n,
        text: '请查收',
        kind: 'reply' as const,
        sessionId: 'wsess-0123456789abcdef',
        media: [
          {
            type: 'image' as const,
            containerPath: '/home/agent/.openclaude/generated/photo.jpg',
            filename: 'photo.jpg',
            mimeType: 'image/jpeg',
          },
          {
            type: 'voice' as const,
            containerPath: '/home/agent/.openclaude/generated/answer.wav',
            filename: 'answer.wav',
            mimeType: 'audio/wav',
          },
          {
            type: 'file' as const,
            containerPath: '/home/agent/.openclaude/generated/report.pdf',
            filename: 'report.pdf',
            mimeType: 'application/pdf',
          },
        ],
        now: 2_500,
      }
      assert.equal((await enqueueQqDelivery(pool, args)).outcome, 'queued')
      assert.equal((await enqueueQqDelivery(pool, args)).outcome, 'queued')

      const rows = await pool.query<{
        delivery_id: string
        payload: { chunks?: string[]; media?: { filename: string } }
      }>(
        `SELECT delivery_id, payload
         FROM qq_outbox
        WHERE user_id=2 AND created_at=2500
        ORDER BY id`,
      )
      assert.equal(rows.rows.length, 4)
      assert.deepEqual(rows.rows[0]?.payload, { chunks: ['请查收'] })
      assert.deepEqual(
        rows.rows.slice(1).map((row) => row.payload.media?.filename),
        ['photo.jpg', 'answer.wav', 'report.pdf'],
      )
      assert.equal(new Set(rows.rows.map((row) => row.delivery_id)).size, 4)
    },
  )

  maybe('keeps a silent root before a media-only child', async () => {
    const queued = await enqueueQqDelivery(pool, {
      deliveryId: 'delivery.stageb.mediaonly',
      userId: 2n,
      text: '',
      kind: 'reply',
      sessionId: 'wsess-0123456789abcdef',
      media: [
        {
          type: 'video',
          containerPath: '/home/agent/.openclaude/generated/result.mp4',
          filename: 'result.mp4',
          mimeType: 'video/mp4',
        },
      ],
      now: 2_600,
    })
    assert.equal(queued.outcome, 'queued')
    const rows = await pool.query<{ payload: { mediaRoot?: boolean; media?: unknown } }>(
      `SELECT payload
         FROM qq_outbox
        WHERE user_id=2 AND created_at=2600
        ORDER BY id`,
    )
    assert.equal(rows.rows.length, 2)
    assert.deepEqual(rows.rows[0]?.payload, { mediaRoot: true })
    assert.ok(rows.rows[1]?.payload.media)
  })

  maybe('unbind fences and cancels pending deliveries without deleting the tombstone', async () => {
    const binding = await getQqBinding(pool, 1n)
    assert.ok(binding)
    const queued = await enqueueQqDelivery(pool, {
      deliveryId: 'delivery.0187.1',
      userId: 1n,
      text: 'private payload',
      kind: 'proactive',
      now: 3_000,
    })
    assert.equal(queued.outcome, 'queued')
    assert.equal(await unbindQq(pool, 1n, 3_001), true)
    const row = await pool.query<{ status: string; cancelled_at: string }>(
      "SELECT status, cancelled_at FROM qq_outbox WHERE user_id=1 AND delivery_id='delivery.0187.1'",
    )
    assert.deepEqual(row.rows, [{ status: 'cancelled', cancelled_at: '3001' }])
  })

  maybe('persistent per-OpenID limit blocks online enumeration', async () => {
    let result: Awaited<ReturnType<typeof consumeBindCode>> | undefined
    for (let i = 0; i < 6; i++) {
      result = await consumeBindCode(pool, '2222222222', 'attacker-openid', SECRET, 4_000 + i)
    }
    assert.equal(result?.kind, 'rate_limited')
  })

  maybe(
    'ACK-loss replay after unbind and rebind cannot attach old media to the new OpenID',
    async () => {
      const oldBinding = await getQqBinding(pool, 2n)
      assert.ok(oldBinding)
      const original = await enqueueQqDelivery(pool, {
        deliveryId: 'delivery.stageb.rebind',
        userId: 2n,
        text: '旧绑定回复',
        kind: 'reply',
        media: [
          {
            type: 'file',
            containerPath: '/home/agent/.openclaude/generated/old.pdf',
            filename: 'old.pdf',
          },
        ],
        expectedBinding: {
          version: oldBinding.bindingVersion,
          openid: oldBinding.openid,
        },
        now: 5_000,
      })
      assert.equal(original.outcome, 'queued')
      assert.equal(await unbindQq(pool, 2n, 5_001), true)
      const next = await createBindCode(pool, 2n, SECRET, 5_002)
      assert.equal(
        (await consumeBindCode(pool, next.code, 'openid-two-rebound', SECRET, 5_003)).kind,
        'bound',
      )

      const firstAfterRebind = await enqueueQqDelivery(pool, {
        deliveryId: 'delivery.stageb.first-after-rebind',
        userId: 2n,
        text: '旧 OpenID 会话的迟到回复',
        kind: 'reply',
        media: [
          {
            type: 'file',
            containerPath: '/home/agent/.openclaude/generated/private.pdf',
            filename: 'private.pdf',
          },
        ],
        expectedBinding: {
          version: oldBinding.bindingVersion,
          openid: oldBinding.openid,
        },
        now: 5_004,
      })
      assert.equal(firstAfterRebind.outcome, 'no_binding')
      const firstRows = await pool.query<{ count: string }>(
        `SELECT count(*) FROM qq_outbox
          WHERE user_id=2 AND delivery_id='delivery.stageb.first-after-rebind'`,
      )
      assert.deepEqual(firstRows.rows, [{ count: '0' }])

      const replay = await enqueueQqDelivery(pool, {
        deliveryId: 'delivery.stageb.rebind',
        userId: 2n,
        text: '旧绑定回复',
        kind: 'reply',
        media: [
          {
            type: 'file',
            containerPath: '/home/agent/.openclaude/generated/old.pdf',
            filename: 'old.pdf',
          },
        ],
        now: 5_005,
      })
      assert.equal(replay.outcome, 'cancelled')
      const rows = await pool.query<{
        status: string
        binding_version: string
        target_openid: string
      }>(
        `SELECT status, binding_version, target_openid
         FROM qq_outbox
        WHERE user_id=2 AND created_at=5000
        ORDER BY id`,
      )
      assert.equal(rows.rows.length, 2)
      assert.deepEqual(new Set(rows.rows.map((row) => row.status)), new Set(['cancelled']))
      assert.equal(new Set(rows.rows.map((row) => row.binding_version)).size, 1)
      assert.equal(new Set(rows.rows.map((row) => row.target_openid)).size, 1)
      assert.notEqual(rows.rows[0]?.target_openid, 'openid-two-rebound')
    },
  )
})
