/**
 * Integ 测试(PG-only;无测试库时跳过,除非 REQUIRE_TEST_DB=1):
 * 市场 AI 审批数据层 + 0107 列 round-trip。
 *
 * 覆盖:
 *  - 发布入列:publishSkillVersion 默认 ai_review_state='queued';queueAiReview:false → NULL(seed 隔离);
 *  - claim:queued → running / attempts+1 / ai_locked_at;FOR UPDATE SKIP LOCKED;
 *  - 三态写回:reviewVersion(source='ai') approve/reject → review_source='ai'+ai_review_state='done'+
 *    ai_note+reviewed_by NULL;escalate/skip 保持 pending 只翻 ai_review_state;
 *  - 人审路径写 review_source='human';
 *  - key 缺席 bulk skip;僵尸回收(requeued vs skipped by attempts);
 *  - listRecentAiReviews / listPendingVersions.aiNote。
 */
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'

import { closePool, createPool, resetPool, setPoolOverride } from '../../db/index.js'
import { runMigrations } from '../../db/migrate.js'
import { query } from '../../db/queries.js'
import { resetTestSchemaForTest } from '../../__tests__/helpers/db.js'
import {
  claimNextAiReview,
  finishAiReviewEscalate,
  listPendingVersions,
  listRecentAiReviews,
  markAiReviewSkipped,
  publishSkillVersion,
  recoverStaleAiReviews,
  reviewVersion,
  skipQueuedAiReviews,
} from '../marketplaceDb.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'
let pgAvailable = false

let vseq = 0
async function publish(
  slug: string,
  submittedBy: number,
  opts: { version?: string; queueAiReview?: boolean } = {},
): Promise<string> {
  const version = opts.version ?? `1.0.${vseq++}`
  const raw = `# ${slug}\n正文 ${version}`
  const { versionId } = await publishSkillVersion({
    slug,
    ownerUserId: submittedBy,
    version,
    name: slug,
    description: `${slug} 描述`,
    tags: ['tool'],
    rawSkillMd: raw,
    rawArtifact: raw,
    artifactHash: `hash-${slug}-${version}`,
    embeddingHash: `emb-${slug}-${version}`,
    riskFlags: [],
    policyVersion: 1,
    submittedBy,
    ...(opts.queueAiReview === false ? { queueAiReview: false } : {}),
  })
  return versionId
}

async function stateOf(versionId: string): Promise<{
  status: string
  review_source: string | null
  ai_review_state: string | null
  ai_note: string | null
  reviewed_by: string | null
  ai_attempts: number
}> {
  const r = await query<{
    status: string
    review_source: string | null
    ai_review_state: string | null
    ai_note: string | null
    reviewed_by: string | null
    ai_attempts: string
  }>(
    `SELECT status, review_source, ai_review_state, ai_note, reviewed_by::text, ai_attempts
       FROM marketplace_skill_versions WHERE id = $1`,
    [versionId],
  )
  const row = r.rows[0]
  return { ...row, ai_attempts: Number.parseInt(row.ai_attempts, 10) }
}

async function probe(): Promise<boolean> {
  const p = createPool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1500 })
  try {
    await p.query('SELECT 1')
    await p.end()
    return true
  } catch {
    try {
      await p.end()
    } catch {}
    return false
  }
}

before(async () => {
  pgAvailable = await probe()
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error('Postgres test fixture required (REQUIRE_TEST_DB=1)')
    return
  }
  await resetPool()
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 10 }))
  await resetTestSchemaForTest()
  await runMigrations()
})
after(async () => {
  if (pgAvailable) {
    await closePool()
  }
})
beforeEach(async () => {
  if (!pgAvailable) return
  await query(
    'TRUNCATE TABLE marketplace_installs, marketplace_skill_versions, marketplace_skill_listings, users RESTART IDENTITY CASCADE',
  )
})
function skip(t: { skip: (r: string) => void }): boolean {
  if (!pgAvailable) {
    t.skip('pg not running')
    return true
  }
  return false
}

describe('marketplace AI review data layer (integ)', () => {
  test('0107 列存在且发布默认入列 queued;queueAiReview:false → NULL', async (t) => {
    if (skip(t)) return
    const queued = await publish('a-skill', 10)
    assert.equal((await stateOf(queued)).ai_review_state, 'queued')
    const notQueued = await publish('b-skill', 10, { queueAiReview: false })
    assert.equal((await stateOf(notQueued)).ai_review_state, null)
  })

  test('claim:queued → running / attempts+1 / 排干后返回 null', async (t) => {
    if (skip(t)) return
    const id = await publish('c-skill', 10)
    const cand = await claimNextAiReview()
    assert.ok(cand)
    assert.equal(cand?.versionId, id)
    const s = await stateOf(id)
    assert.equal(s.ai_review_state, 'running')
    assert.equal(s.ai_attempts, 1)
    // b-skill queueAiReview:false 不应被 claim;当前只有这一个 queued → 再 claim 得 null
    assert.equal(await claimNextAiReview(), null)
  })

  test('claim 不认领 queueAiReview:false / 非 pending', async (t) => {
    if (skip(t)) return
    await publish('d-skill', 10, { queueAiReview: false })
    assert.equal(await claimNextAiReview(), null)
  })

  test('AI approve 写回:review_source=ai / ai_review_state=done / reviewed_by NULL / 上架', async (t) => {
    if (skip(t)) return
    const id = await publish('e-skill', 10)
    await claimNextAiReview()
    await reviewVersion({
      versionId: id,
      reviewerUserId: null,
      approve: true,
      source: 'ai',
      note: 'AI 审核:内容合规,自动通过',
      aiNote: '内容合规,自动通过',
    })
    const s = await stateOf(id)
    assert.equal(s.status, 'approved')
    assert.equal(s.review_source, 'ai')
    assert.equal(s.ai_review_state, 'done')
    assert.equal(s.reviewed_by, null)
    assert.equal(s.ai_note, '内容合规,自动通过')
    const listing = await query<{ cur: string | null }>(
      'SELECT current_approved_version_id::text AS cur FROM marketplace_skill_listings WHERE slug=$1',
      ['e-skill'],
    )
    assert.equal(listing.rows[0].cur, id)
  })

  test('AI reject 写回:rejected / review_note 回显发布者', async (t) => {
    if (skip(t)) return
    const id = await publish('f-skill', 10)
    await claimNextAiReview()
    await reviewVersion({
      versionId: id,
      reviewerUserId: null,
      approve: false,
      source: 'ai',
      note: 'AI 审核:移除内网地址后重试',
      aiNote: '拒绝依据:含内网地址',
    })
    const s = await stateOf(id)
    assert.equal(s.status, 'rejected')
    assert.equal(s.review_source, 'ai')
    assert.equal(s.ai_review_state, 'done')
    const note = await query<{ review_note: string }>(
      'SELECT review_note FROM marketplace_skill_versions WHERE id=$1',
      [id],
    )
    assert.match(note.rows[0].review_note, /移除内网地址/)
  })

  test('escalate:保持 pending,ai_review_state=done + ai_note;仍进人审队列且带 aiNote', async (t) => {
    if (skip(t)) return
    const id = await publish('g-skill', 10)
    await claimNextAiReview()
    await finishAiReviewEscalate(id, 'AI 判为通过,但存在风险信号(read_creds),转人工复核')
    const s = await stateOf(id)
    assert.equal(s.status, 'pending')
    assert.equal(s.review_source, null)
    assert.equal(s.ai_review_state, 'done')
    assert.match(s.ai_note ?? '', /read_creds/)
    const pending = await listPendingVersions()
    const row = pending.find((p) => p.versionId === id)
    assert.ok(row)
    assert.match(row?.aiNote ?? '', /read_creds/)
  })

  test('skip:保持 pending,ai_review_state=skipped', async (t) => {
    if (skip(t)) return
    const id = await publish('h-skill', 10)
    await claimNextAiReview()
    await markAiReviewSkipped(id, 'AI 审核调用失败,已转人工复核')
    const s = await stateOf(id)
    assert.equal(s.status, 'pending')
    assert.equal(s.ai_review_state, 'skipped')
  })

  test('escalate/skip 只在 running 时生效(守卫并发人审)', async (t) => {
    if (skip(t)) return
    const id = await publish('i-skill', 10)
    // 未 claim(仍 queued)→ escalate/skip 应 no-op
    await finishAiReviewEscalate(id, 'x')
    assert.equal((await stateOf(id)).ai_review_state, 'queued')
    await markAiReviewSkipped(id, 'y')
    assert.equal((await stateOf(id)).ai_review_state, 'queued')
  })

  test('人审路径写 review_source=human', async (t) => {
    if (skip(t)) return
    const id = await publish('j-skill', 10)
    await reviewVersion({ versionId: id, reviewerUserId: 999, approve: true })
    const s = await stateOf(id)
    assert.equal(s.status, 'approved')
    assert.equal(s.review_source, 'human')
    assert.equal(s.reviewed_by, '999')
    // 人审不应改动 ai_review_state(仍为发布时的 queued)
    assert.equal(s.ai_review_state, 'queued')
  })

  test('key 缺席 bulk skip:queued → skipped', async (t) => {
    if (skip(t)) return
    await publish('k-skill', 10)
    await publish('l-skill', 10)
    const n = await skipQueuedAiReviews('AI 审核未配置(缺 key),已转人工复核')
    assert.equal(n, 2)
    const pending = await listPendingVersions()
    // 仍 pending(转人工),但都不再 queued
    for (const p of pending) assert.notEqual(p.aiNote, null)
  })

  test('僵尸回收:attempts<max → requeued;attempts≥max → skipped', async (t) => {
    if (skip(t)) return
    const id1 = await publish('m-skill', 10)
    const id2 = await publish('n-skill', 10)
    await query(
      `UPDATE marketplace_skill_versions
          SET ai_review_state='running', ai_locked_at = NOW() - INTERVAL '20 minutes', ai_attempts=1
        WHERE id=$1`,
      [id1],
    )
    await query(
      `UPDATE marketplace_skill_versions
          SET ai_review_state='running', ai_locked_at = NOW() - INTERVAL '20 minutes', ai_attempts=2
        WHERE id=$1`,
      [id2],
    )
    const rec = await recoverStaleAiReviews(10 * 60_000, 2)
    assert.equal(rec.requeued, 1)
    assert.equal(rec.skipped, 1)
    assert.equal((await stateOf(id1)).ai_review_state, 'queued')
    assert.equal((await stateOf(id2)).ai_review_state, 'skipped')
  })

  test('僵尸回收不碰未过期的 running', async (t) => {
    if (skip(t)) return
    const id = await publish('o-skill', 10)
    await query(
      `UPDATE marketplace_skill_versions
          SET ai_review_state='running', ai_locked_at = NOW(), ai_attempts=1 WHERE id=$1`,
      [id],
    )
    const rec = await recoverStaleAiReviews(10 * 60_000, 2)
    assert.equal(rec.requeued, 0)
    assert.equal(rec.skipped, 0)
    assert.equal((await stateOf(id)).ai_review_state, 'running')
  })

  test('listRecentAiReviews:只出 review_source=ai,按 reviewed_at DESC', async (t) => {
    if (skip(t)) return
    const idA = await publish('p-skill', 10)
    await claimNextAiReview()
    await reviewVersion({
      versionId: idA,
      reviewerUserId: null,
      approve: true,
      source: 'ai',
      note: 'AI 审核:通过',
      aiNote: '通过',
    })
    const idB = await publish('q-skill', 10)
    await claimNextAiReview()
    await reviewVersion({
      versionId: idB,
      reviewerUserId: null,
      approve: false,
      source: 'ai',
      note: 'AI 审核:拒绝',
      aiNote: '拒绝依据:垃圾内容',
    })
    // 人审一个 —— 不应出现在 AI 记录里
    const idC = await publish('r-skill', 10)
    await reviewVersion({ versionId: idC, reviewerUserId: 999, approve: true })

    const recs = await listRecentAiReviews()
    const slugs = recs.map((r) => r.slug)
    assert.ok(slugs.includes('p-skill'))
    assert.ok(slugs.includes('q-skill'))
    assert.ok(!slugs.includes('r-skill'))
    assert.equal(recs.find((r) => r.slug === 'q-skill')?.status, 'rejected')
    assert.equal(recs.find((r) => r.slug === 'p-skill')?.status, 'approved')
  })
})
