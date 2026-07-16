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
import { after, before, describe, test } from 'node:test'
import { closePool, createPool, resetPool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { query } from '../db/queries.js'
import { listSessionRatings, upsertResponseRating } from '../responseRatings.js'
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
const base = (
  over: Pick<UpsertInput, 'rating' | 'tags'> & Partial<UpsertInput>,
): UpsertInput => ({
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
    assert.deepEqual(await readRow('m1'), { rating: 'up', tags: ['准确'] }, '隐式来件覆盖了显式评分')
  })

  test('listSessionRatings 排除隐式行(UI 不渲染未点过的 👎)', async (t) => {
    if (!pgAvailable) return t.skip('no PG fixture')
    await upsertResponseRating(base({ messageId: 'm-imp', rating: 'down', tags: ['implicit', '中途打断'] }))
    await upsertResponseRating(base({ messageId: 'm-exp', rating: 'down', tags: ['不准确'] }))
    const map = await listSessionRatings(uid, 's1')
    assert.equal(map['m-imp'], undefined)
    assert.deepEqual(map['m-exp'], { rating: 'down', tags: ['不准确'] })
    assert.deepEqual(map['m1'], { rating: 'up', tags: ['准确'] })
  })
})
