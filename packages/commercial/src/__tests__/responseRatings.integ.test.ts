/**
 * response_rating 隐式评分(方案 b)upsert 冲突语义 — 集成测试(需 PG)。
 *
 * 核心不变量:**显式永远压过隐式**。
 *  - 隐式来件不得覆盖既有显式评分(否则用户手点的 👍 会被中途打断信号静默清掉,
 *    核心信号被数据损坏);
 *  - 显式来件照常覆盖一切(含隐式);
 *  - 隐式可刷新隐式;
 *  - listSessionRatings(前端已评回读)排除隐式行 —— UI 不得渲染用户没点过的 👎。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import { closePool, createPool, resetPool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { query } from '../db/queries.js'
import {
  getResponseRatingStats,
  listDownRatings,
  listSessionRatings,
  upsertResponseRating,
} from '../responseRatings.js'
import { resetTestSchemaForTest } from './helpers/db.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'

let pgAvailable = false
let uid = ''

async function probe(): Promise<boolean> {
  const p = createPool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1500 })
  try {
    await p.query('SELECT 1')
    await p.end()
    return true
  } catch {
    try {
      await p.end()
    } catch {
      /* */
    }
    return false
  }
}

before(async () => {
  pgAvailable = await probe()
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error('Postgres test fixture required')
    return
  }
  await resetPool()
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 5 }))
  await resetTestSchemaForTest()
  await runMigrations()
  const r = await query<{ id: string }>(
    `INSERT INTO users(email, password_hash, email_verified)
     VALUES ('implicit-rating-it@test.local', 'x', true) RETURNING id::text AS id`,
  )
  uid = r.rows[0].id
})

after(async () => {
  if (pgAvailable) await closePool().catch(() => {})
})

type UpsertInput = Parameters<typeof upsertResponseRating>[0]
const base = (over: Pick<UpsertInput, 'rating' | 'tags'> & Partial<UpsertInput>): UpsertInput => ({
  userId: uid,
  sessionId: 's1',
  messageId: 'm1',
  traceId: null,
  model: 'test-model',
  comment: null,
  ...over,
})

async function readRow(messageId: string) {
  const r = await query<{ rating: string; tags: string[] }>(
    `SELECT rating, tags FROM response_rating WHERE user_id=$1::bigint AND message_id=$2`,
    [uid, messageId],
  )
  return r.rows[0] ?? null
}

describe('implicit rating upsert semantics (PG)', () => {
  test('隐式插入空位 → 正常落库;隐式刷新隐式 → 更新', async (t) => {
    if (!pgAvailable) return t.skip('no PG fixture')
    await upsertResponseRating(base({ rating: 'down', tags: ['implicit', '中途打断'] }))
    assert.deepEqual(await readRow('m1'), { rating: 'down', tags: ['implicit', '中途打断'] })
    await upsertResponseRating(base({ rating: 'down', tags: ['implicit', '改写重发'] }))
    assert.deepEqual(await readRow('m1'), { rating: 'down', tags: ['implicit', '改写重发'] })
  })

  test('显式覆盖隐式;随后隐式不得覆盖显式(核心不变量)', async (t) => {
    if (!pgAvailable) return t.skip('no PG fixture')
    await upsertResponseRating(base({ rating: 'up', tags: ['准确'] }))
    assert.deepEqual(await readRow('m1'), { rating: 'up', tags: ['准确'] })
    await upsertResponseRating(base({ rating: 'down', tags: ['implicit', '中途打断'] }))
    assert.deepEqual(
      await readRow('m1'),
      { rating: 'up', tags: ['准确'] },
      '隐式来件覆盖了显式评分',
    )
  })

  test('listSessionRatings 排除隐式行(UI 不渲染未点过的 👎)', async (t) => {
    if (!pgAvailable) return t.skip('no PG fixture')
    await upsertResponseRating(
      base({ messageId: 'm-imp', rating: 'down', tags: ['implicit', '中途打断'] }),
    )
    await upsertResponseRating(base({ messageId: 'm-exp', rating: 'down', tags: ['不准确'] }))
    const map = await listSessionRatings(uid, 's1')
    assert.equal(map['m-imp'], undefined)
    assert.deepEqual(map['m-exp'], { rating: 'down', tags: ['不准确'] })
    assert.deepEqual(map['m1'], { rating: 'up', tags: ['准确'] })
  })

  test('listDownRatings 默认仅显式，并可切换 implicit / all 来源', async (t) => {
    if (!pgAvailable) return t.skip('no PG fixture')
    await upsertResponseRating(
      base({
        messageId: 'm-source-explicit',
        rating: 'down',
        tags: ['没完成'],
        comment: 'EXPLICIT_SOURCE_MARKER',
      }),
    )
    await upsertResponseRating(
      base({
        messageId: 'm-source-implicit',
        rating: 'down',
        tags: ['implicit', '中途打断'],
        comment: 'IMPLICIT_SOURCE_MARKER',
      }),
    )

    const explicit = await listDownRatings({ limit: 200 })
    assert.equal(
      explicit.rows.some((row) => row.comment === 'EXPLICIT_SOURCE_MARKER'),
      true,
    )
    assert.equal(
      explicit.rows.some((row) => row.comment === 'IMPLICIT_SOURCE_MARKER'),
      false,
    )

    const implicit = await listDownRatings({ source: 'implicit', limit: 200 })
    assert.equal(
      implicit.rows.some((row) => row.comment === 'EXPLICIT_SOURCE_MARKER'),
      false,
    )
    assert.equal(
      implicit.rows.some((row) => row.comment === 'IMPLICIT_SOURCE_MARKER'),
      true,
    )

    const all = await listDownRatings({ source: 'all', limit: 200 })
    assert.equal(
      all.rows.some((row) => row.comment === 'EXPLICIT_SOURCE_MARKER'),
      true,
    )
    assert.equal(
      all.rows.some((row) => row.comment === 'IMPLICIT_SOURCE_MARKER'),
      true,
    )
  })

  test('exact tape record closes trace attribution and finalized completed tapes are the denominator', async (t) => {
    if (!pgAvailable) return t.skip('no PG fixture')
    const before = await getResponseRatingStats('production_user')
    const now = Date.now()
    const sessionId = 's-trace-closure'
    const userKey = `c:${uid}`
    const tapeId = 'a'.repeat(64)
    const interruptedTapeId = 'b'.repeat(64)
    const canonicalTrace = 'trace-canonical-rating'
    const payload = Buffer.from(JSON.stringify({ usage: { traceId: canonicalTrace } }))
    await query(
      `INSERT INTO turn_traces(trace_id,user_id,session_key,agent_id,model)
       VALUES ($1,$2::bigint,$3,'main','test-model')`,
      [canonicalTrace, uid, `${userKey}:main:webchat:dm:${sessionId}`],
    )
    await query(
      `INSERT INTO client_sessions(id,user_id,created_at,last_at,updated_at)
       VALUES ($1,$2,$3,$3,$3)`,
      [sessionId, userKey, now],
    )
    await query(
      `INSERT INTO client_session_turn_tapes
         (session_id,user_id,tape_id,agent_id,turn_index,status,turn_key,tape_sha256,
          total_bytes,part_count,billing_anchor_id,created_at,finalized_at)
       VALUES
         ($1,$2,$3,'main',0,'completed',$4,$5,$6,1,'m-linked',$7,$7),
         ($1,$2,$8,'main',1,'interrupted',$9,$10,0,1,'m-interrupted',$7,$7)`,
      [
        sessionId,
        userKey,
        tapeId,
        'c'.repeat(64),
        'd'.repeat(64),
        payload.length,
        now,
        interruptedTapeId,
        'e'.repeat(64),
        'f'.repeat(64),
      ],
    )
    await query(
      `INSERT INTO client_session_turn_tape_records
         (session_id,user_id,tape_id,msg_id,ordinal,role,ts,content_sha256,payload)
       VALUES ($1,$2,$3,'m-linked',0,'assistant',$4,$5,$6)`,
      [
        sessionId,
        userKey,
        tapeId,
        now,
        createHash('sha256').update(payload).digest('hex'),
        payload,
      ],
    )
    await upsertResponseRating(
      base({
        sessionId,
        messageId: 'm-linked',
        traceId: 'untrusted-trace',
        rating: 'up',
        tags: ['准确'],
      }),
    )
    const linked = await query<{ trace_id: string | null }>(
      `SELECT trace_id FROM response_rating
        WHERE user_id=$1::bigint AND message_id='m-linked'`,
      [uid],
    )
    assert.equal(linked.rows[0]?.trace_id, canonicalTrace)

    const after = await getResponseRatingStats('production_user')
    assert.equal(after.overall.total, before.overall.total + 1)
    assert.equal(after.completed_turns.last_30d, before.completed_turns.last_30d + 1)
    assert.equal(
      after.explicit_coverage.last_30d,
      Math.round((after.last_30d.total / after.completed_turns.last_30d) * 1e4) / 1e4,
    )
    assert.equal(after.overall.sample_note, 'small_sample')
    assert.ok(after.overall.ci95_low !== null)
    assert.ok(after.overall.ci95_high !== null)
  })

  test('traffic filter excludes administrators from the production-user rating view', async (t) => {
    if (!pgAvailable) return t.skip('no PG fixture')
    const beforeProduction = await getResponseRatingStats('production_user')
    const admin = await query<{ id: string; signal_traffic_class: string }>(
      `INSERT INTO users(email,password_hash,email_verified,role)
       VALUES ('rating-admin@test.local','x',true,'admin')
       RETURNING id::text,signal_traffic_class`,
    )
    assert.equal(admin.rows[0]?.signal_traffic_class, 'internal_admin')
    await upsertResponseRating({
      ...base({ rating: 'down', tags: ['不准确'] }),
      userId: admin.rows[0]!.id,
      messageId: 'admin-rating',
    })
    const production = await getResponseRatingStats('production_user')
    const internal = await getResponseRatingStats('internal_admin')
    assert.deepEqual(production, beforeProduction)
    assert.equal(internal.overall.down, 1)
    assert.equal(internal.rating_users, 1)
  })
})
