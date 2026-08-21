import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'

import { query } from '../db/queries.js'
import {
  CommunityTutorialError,
  decodeTutorialCursor,
  getPublishedCommunityTutorial,
  listOwnCommunityTutorials,
  listPendingCommunityTutorials,
  listPublishedCommunityTutorials,
  reviewCommunityTutorial,
  submitCommunityTutorial,
  withdrawCommunityTutorial,
} from '../tutorials/communityTutorials.js'
import { truncateAllForTest, useDedicatedTestDatabase } from './helpers/db.js'

const db = useDedicatedTestDatabase('openclaude_community_tutorials_test')

beforeEach(async () => {
  if (!db.available) return
  await truncateAllForTest([
    'tutorial_compass_notes',
    'tutorial_eval_jobs',
    'tutorial_blob_refs',
    'tutorial_blobs',
    'tutorial_case_specs',
    'community_tutorials',
    'admin_audit',
    'users',
  ])
})

async function createUser(
  email: string,
  displayName: string | null,
  role: 'user' | 'admin' = 'user',
) {
  const result = await query<{ id: string }>(
    `INSERT INTO users(email, password_hash, credits, role, status, display_name)
     VALUES ($1, 'argon2$stub', 0, $2, 'active', $3)
     RETURNING id::text AS id`,
    [email, role, displayName],
  )
  return result.rows[0]!.id
}

function draft(index = 1) {
  return {
    title: `社区教程 ${index}`,
    summary: `这是第 ${index} 份可审核的社区教程摘要。`,
    category: (index % 2 === 0 ? 'coding' : 'general') as 'coding' | 'general',
    bodyMarkdown: `# 教程 ${index}\n\n这是完整正文，包含足够长度的步骤说明。\n\n1. 准备材料\n2. 执行任务\n3. 核对结果`,
  }
}

async function expectTutorialError(action: () => Promise<unknown>, code: string) {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof CommunityTutorialError)
    assert.equal(error.code, code)
    return true
  })
}

describe('community tutorials', () => {
  test('pending 不公开；管理员 approve 后公开，详情只暴露昵称与审核后的正文', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const author = await createUser('author@example.com', '小明')
    const admin = await createUser('admin@example.com', '审核员', 'admin')
    const submitted = await submitCommunityTutorial(author, draft())

    assert.equal(submitted.status, 'pending')
    assert.deepEqual((await listPublishedCommunityTutorials({ cursor: null, limit: 20 })).items, [])
    const mine = await listOwnCommunityTutorials(author, { cursor: null, limit: 20 })
    assert.equal(mine.items[0]?.status, 'pending')
    assert.equal(mine.items[0]?.bodyMarkdown, draft().bodyMarkdown)

    const reviewed = await reviewCommunityTutorial({
      id: submitted.id,
      reviewerUserId: admin,
      decision: 'approve',
      note: null,
    })
    assert.equal(reviewed.status, 'approved')
    assert.ok(reviewed.publishedAt)

    const published = await listPublishedCommunityTutorials({ cursor: null, limit: 20 })
    assert.equal(published.items.length, 1)
    assert.deepEqual(published.items[0], {
      id: submitted.id,
      title: draft().title,
      summary: draft().summary,
      category: draft().category,
      kind: 'markdown',
      authorName: '小明',
      publishedAt: reviewed.publishedAt,
    })
    const detail = await getPublishedCommunityTutorial(submitted.id)
    assert.equal(detail?.kind, 'markdown')
    assert.equal(detail?.snapshot, null)
    assert.deepEqual(detail?.refs, [])
    assert.equal(detail?.bodyMarkdown, draft().bodyMarkdown)
    assert.equal(JSON.stringify(detail).includes('author@example.com'), false)
  })

  test('reject 保留理由但不公开；空昵称只投影为“社区用户”', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const author = await createUser('private@example.com', null)
    const admin = await createUser('admin@example.com', null, 'admin')
    const rejected = await submitCommunityTutorial(author, draft(2))
    await reviewCommunityTutorial({
      id: rejected.id,
      reviewerUserId: admin,
      decision: 'reject',
      note: '请补充可复现步骤',
    })
    assert.equal(await getPublishedCommunityTutorial(rejected.id), null)
    const mine = await listOwnCommunityTutorials(author, { cursor: null, limit: 20 })
    assert.equal(mine.items[0]?.status, 'rejected')
    assert.equal(mine.items[0]?.reviewNote, '请补充可复现步骤')

    const approved = await submitCommunityTutorial(author, draft(3))
    await reviewCommunityTutorial({
      id: approved.id,
      reviewerUserId: admin,
      decision: 'approve',
      note: '结构清楚',
    })
    const publicRow = (await listPublishedCommunityTutorials({ cursor: null, limit: 20 })).items[0]
    assert.equal(publicRow?.authorName, '社区用户')
  })

  test('owner-only withdraw 与审核状态迁移原子化，不覆盖已处理记录', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const author = await createUser('author@example.com', '作者')
    const other = await createUser('other@example.com', '其他用户')
    const admin = await createUser('admin@example.com', '管理员', 'admin')

    const withdrawn = await submitCommunityTutorial(author, draft(4))
    await expectTutorialError(() => withdrawCommunityTutorial(withdrawn.id, other), 'NOT_FOUND')
    await withdrawCommunityTutorial(withdrawn.id, author)
    await expectTutorialError(
      () =>
        reviewCommunityTutorial({
          id: withdrawn.id,
          reviewerUserId: admin,
          decision: 'approve',
          note: null,
        }),
      'NOT_PENDING',
    )

    const approved = await submitCommunityTutorial(author, draft(5))
    const firstReview = await reviewCommunityTutorial({
      id: approved.id,
      reviewerUserId: admin,
      decision: 'approve',
      note: null,
    })
    await expectTutorialError(
      () =>
        reviewCommunityTutorial({
          id: approved.id,
          reviewerUserId: other,
          decision: 'reject',
          note: '不能覆盖',
        }),
      'NOT_PENDING',
    )
    const state = await query<{
      status: string
      reviewed_by: string
      published_at: Date
    }>(
      `SELECT status, reviewed_by::text, published_at
         FROM community_tutorials WHERE id = $1::bigint`,
      [approved.id],
    )
    assert.equal(state.rows[0]?.status, 'approved')
    assert.equal(state.rows[0]?.reviewed_by, admin)
    assert.equal(state.rows[0]?.published_at.toISOString(), firstReview.publishedAt)
    await withdrawCommunityTutorial(approved.id, author)
    const withdrawnApproved = await query<{ status: string; published_at: Date | null }>(
      `SELECT status, published_at FROM community_tutorials WHERE id = $1::bigint`,
      [approved.id],
    )
    assert.equal(withdrawnApproved.rows[0]?.status, 'withdrawn')
    assert.equal(withdrawnApproved.rows[0]?.published_at, null)
  })

  test('公开、我的投稿与待审队列 keyset 分页无遗漏', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const author = await createUser('author@example.com', '作者')
    const admin = await createUser('admin@example.com', '管理员', 'admin')
    const ids: string[] = []
    for (let i = 1; i <= 5; i += 1) {
      const submitted = await submitCommunityTutorial(author, draft(i))
      ids.push(submitted.id)
    }

    const pendingSeen: string[] = []
    let pendingCursor: string | null = null
    do {
      const page = await listPendingCommunityTutorials({
        cursor: decodeTutorialCursor(pendingCursor),
        limit: 2,
      })
      pendingSeen.push(...page.items.map((item) => item.id))
      pendingCursor = page.nextCursor
    } while (pendingCursor)
    assert.deepEqual(pendingSeen, ids)

    for (const id of ids) {
      await reviewCommunityTutorial({ id, reviewerUserId: admin, decision: 'approve', note: null })
    }
    const publicSeen: string[] = []
    let publicCursor: string | null = null
    do {
      const page = await listPublishedCommunityTutorials({
        cursor: decodeTutorialCursor(publicCursor),
        limit: 2,
      })
      publicSeen.push(...page.items.map((item) => item.id))
      publicCursor = page.nextCursor
    } while (publicCursor)
    assert.deepEqual(
      [...publicSeen].sort((a, b) => Number(a) - Number(b)),
      ids,
    )

    const ownSeen: string[] = []
    let ownCursor: string | null = null
    do {
      const page = await listOwnCommunityTutorials(author, {
        cursor: decodeTutorialCursor(ownCursor),
        limit: 2,
      })
      ownSeen.push(...page.items.map((item) => item.id))
      ownCursor = page.nextCursor
    } while (ownCursor)
    assert.deepEqual(
      [...ownSeen].sort((a, b) => Number(a) - Number(b)),
      ids,
    )
  })
})
