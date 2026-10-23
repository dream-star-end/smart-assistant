import assert from 'node:assert/strict'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, beforeEach, describe, test } from 'node:test'
import sharp from 'sharp'

import { signAccess } from '../auth/jwt.js'
import { query } from '../db/queries.js'
import { HttpError, sendJson } from '../http/util.js'
import {
  getOwnCommunityTutorial,
  getPublishedCommunityTutorial,
  listAdminCommunityTutorials,
  listOwnCommunityTutorials,
  listTutorialModerations,
  reviewCommunityTutorial,
  submitCommunityTutorial,
  withdrawCommunityTutorial,
} from '../tutorials/communityTutorials.js'
import { handleAdminTutorialWrite, handleTutorialUserPost } from '../tutorials/communityTutorialRoutes.js'
import { getApprovedTutorialBlob, gcOrphanTutorialBlobs } from '../tutorials/tutorialBlobs.js'
import { prepareTutorialImage, storeTutorialImageUpload } from '../tutorials/tutorialImages.js'
import { type ModerationTransport, startTutorialModerationScheduler } from '../tutorials/tutorialModeration.js'
import { reviewCommunityTutorialRevision, reviseCommunityTutorial } from '../tutorials/tutorialRevisions.js'
import { truncateAllForTest, useDedicatedTestDatabase } from './helpers/db.js'

// OCV5-577 跟进：作者修改已投稿的经验分享，改完重新审核（迁移 0326，SQL 全真，模型用假 transport）。
const db = useDedicatedTestDatabase('openclaude_tutorial_revisions_test')
const JWT_SECRET = 'tutorial-revisions-route-secret'.repeat(3)
const previousMode = process.env.OC_TUTORIAL_AI_MODERATION
const previousFlag = process.env.OC_COMMUNITY_BLOG_ENABLED
let server: Server | null = null
let baseUrl = ''

before(async () => {
  const deps = { jwtSecret: JWT_SECRET }
  server = createServer(async (req, res) => {
    try {
      const path = (req.url ?? '').split('?')[0] ?? ''
      if (req.method === 'POST' && path.startsWith('/api/admin/tutorials/')) await handleAdminTutorialWrite(req, res, deps)
      else if (req.method === 'POST' && path.startsWith('/api/tutorials/')) await handleTutorialUserPost(req, res, deps)
      else sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'not found' } })
    } catch (error) {
      const http = error instanceof HttpError ? error : new HttpError(500, 'INTERNAL', String(error))
      sendJson(res, http.status, { error: { code: http.code, message: http.message } })
    }
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  if (previousMode === undefined) Reflect.deleteProperty(process.env, 'OC_TUTORIAL_AI_MODERATION')
  else process.env.OC_TUTORIAL_AI_MODERATION = previousMode
  if (previousFlag === undefined) Reflect.deleteProperty(process.env, 'OC_COMMUNITY_BLOG_ENABLED')
  else process.env.OC_COMMUNITY_BLOG_ENABLED = previousFlag
  if (!server) return
  server.closeAllConnections()
  await new Promise<void>((resolve) => server!.close(() => resolve()))
})

beforeEach(async () => {
  process.env.OC_TUTORIAL_AI_MODERATION = 'on'
  process.env.OC_COMMUNITY_BLOG_ENABLED = '1'
  if (!db.available) return
  await truncateAllForTest([
    'community_tutorial_revision_images',
    'community_tutorial_revisions',
    'community_tutorial_moderations',
    'community_tutorial_moderation_jobs',
    'tutorial_blob_refs',
    'tutorial_blob_uploads',
    'tutorial_blobs',
    'community_tutorials',
    'inbox_messages',
    'admin_audit',
    'users',
  ])
})

async function createUser(email: string, role: 'user' | 'admin' = 'user') {
  const result = await query<{ id: string }>(
    `INSERT INTO users(email, password_hash, credits, role, status, display_name)
     VALUES ($1, 'argon2$stub', 0, $2, 'active', $3)
     RETURNING id::text AS id`,
    [email, role, role === 'admin' ? '管理员' : '博主'],
  )
  const id = result.rows[0]!.id
  return { id, token: (await signAccess({ sub: id, role }, JWT_SECRET)).token }
}

const BODY =
  '先准备数据源，再写清楚口径，最后让定时任务每天自动跑一次并核对结果。遇到口径变化时，先改说明再重跑，不要直接改结果。'
const BODY_V2 = `${BODY}\n\n## 补充\n\n第二周加了一张表，口径说明里同步写清楚了新增字段的来源和计算方式。`

function draft(body = BODY, title = '用定时任务做周报') {
  return { title, summary: '记录配置步骤和踩过的坑，供大家参考。', category: 'general' as const, bodyMarkdown: body }
}

const NO = { answer: 'no', confidence: 0.97 }

function transport(text: Record<string, { answer: string; confidence: number }> = {}): ModerationTransport & {
  calls: { text: number; bodies: string[] }
} {
  const calls = { text: 0, bodies: [] as string[] }
  return {
    calls,
    async text(request) {
      calls.text += 1
      calls.bodies.push(JSON.stringify(request))
      return {
        structured: { violation: NO, ad: NO, leak: NO, low_quality: NO, addresses_moderator: NO, ...text },
        inputTokens: 800,
        outputTokens: 60,
      }
    },
    async vision() {
      return {
        text: '{"violation":"no","ad":"no","leak":"no","addresses_moderator":"no","confidence":0.95}',
        inputTokens: 1500,
        outputTokens: 40,
      }
    },
  }
}

async function runOnce(t: ModerationTransport) {
  const scheduler = startTutorialModerationScheduler({ transport: t, intervalMs: 3_600_000 })
  try {
    return await scheduler.runNow()
  } finally {
    scheduler.stop()
  }
}

async function image(userId: string, seed: number) {
  const raw = await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: seed, g: 90, b: 140 } } })
    .png()
    .toBuffer()
  const prepared = await prepareTutorialImage(raw, 'image/png')
  await storeTutorialImageUpload(userId, prepared)
  return prepared.sha256
}

/** 投稿并让 AI 自动通过，返回已发布的稿件 id。 */
async function published(authorId: string, body = BODY) {
  const { id } = await submitCommunityTutorial(authorId, draft(body), { moderationMode: 'on' })
  await runOnce(transport())
  assert.equal((await getPublishedCommunityTutorial(id))?.bodyMarkdown, body)
  return id
}

async function revisionRows(publicationId: string) {
  return (
    await query<{ status: string; needs_human: boolean; review_note: string | null }>(
      'SELECT status, needs_human, review_note FROM community_tutorial_revisions WHERE publication_id = $1::bigint ORDER BY id',
      [publicationId],
    )
  ).rows
}

async function inbox(userId: string) {
  return (
    await query<{ title: string; source_type: string; source_phase: string }>(
      'SELECT title, source_type, source_phase FROM inbox_messages WHERE user_id = $1::bigint ORDER BY id',
      [userId],
    )
  ).rows
}

function request(path: string, token: string, json: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(json),
  })
}

describe('经验分享 · 修改已发布的帖子', () => {
  test('修改期间旧版继续在线、新图不公开；AI 通过后替换正文与图片，发「修改已生效」', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await createUser('admin@example.com', 'admin')
    const author = await createUser('a@example.com')
    const oldSha = await image(author.id, 10)
    const newSha = await image(author.id, 20)
    const id = await published(author.id, `${BODY}\n\n![旧图](tutorial-blob:${oldSha})`)
    assert.ok(await getApprovedTutorialBlob(oldSha))

    const result = await reviseCommunityTutorial(author.id, id, draft(`${BODY_V2}\n\n![新图](tutorial-blob:${newSha})`, '用定时任务做周报（第二版）'), {
      moderationMode: 'on',
    })
    assert.equal(result.mode, 'pending')
    // 线上仍是旧版，新图不能被公开读到。
    const live = await getPublishedCommunityTutorial(id)
    assert.equal(live?.title, '用定时任务做周报')
    assert.match(live?.bodyMarkdown ?? '', /旧图/)
    assert.equal(await getApprovedTutorialBlob(newSha), null)
    const mine = (await listOwnCommunityTutorials(author.id, { cursor: null, limit: 10 })).items[0]!
    assert.equal(mine.status, 'approved')
    assert.equal(mine.edit?.status, 'pending')
    assert.equal(mine.edit?.title, '用定时任务做周报（第二版）')

    const fake = transport()
    assert.equal(await runOnce(fake), 1)
    assert.match(fake.calls.bodies[0] ?? '', /第二周加了一张表/)
    const after = await getPublishedCommunityTutorial(id)
    assert.equal(after?.title, '用定时任务做周报（第二版）')
    assert.match(after?.bodyMarkdown ?? '', /新图/)
    assert.ok(await getApprovedTutorialBlob(newSha))
    assert.equal(await getApprovedTutorialBlob(oldSha), null)
    assert.equal((await getOwnCommunityTutorial(id, author.id))?.contentVersion, 2)
    assert.equal((await getOwnCommunityTutorial(id, author.id))?.edit, null)
    assert.deepEqual((await revisionRows(id)).map((row) => row.status), ['approved'])
    const records = await listTutorialModerations({ cursor: null, limit: 10 })
    assert.equal(records.items[0]?.revisionId !== null, true)
    assert.equal(records.items[0]?.title, '用定时任务做周报（第二版）')
    assert.deepEqual(
      (await inbox(author.id)).map((row) => [row.title, row.source_type]),
      [
        ['你的经验分享已发布', 'community_tutorial'],
        ['你的经验分享修改已生效', 'community_tutorial_revision'],
      ],
    )
  })

  test('修改被 AI 驳回：线上旧版不变，作者看到理由，还能再改', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await createUser('admin@example.com', 'admin')
    const author = await createUser('a@example.com')
    const id = await published(author.id)
    await reviseCommunityTutorial(author.id, id, draft(`${BODY_V2}\n\n加我微信领资料。`), { moderationMode: 'on' })
    await runOnce(transport({ ad: { answer: 'yes', confidence: 0.96 } }))
    assert.equal((await getPublishedCommunityTutorial(id))?.bodyMarkdown, BODY)
    const mine = await getOwnCommunityTutorial(id, author.id)
    assert.equal(mine?.status, 'approved')
    assert.equal(mine?.edit?.status, 'rejected')
    assert.match(mine?.edit?.reviewNote ?? '', /站外联系方式、引流或推广信息/)
    assert.equal((await inbox(author.id)).at(-1)?.title, '你的经验分享修改未通过审核')

    const again = await reviseCommunityTutorial(author.id, id, draft(BODY_V2), { moderationMode: 'on' })
    assert.equal(again.mode, 'pending')
    assert.equal((await getOwnCommunityTutorial(id, author.id))?.edit?.status, 'pending')
    await runOnce(transport())
    assert.equal((await getPublishedCommunityTutorial(id))?.bodyMarkdown, BODY_V2)
  })

  test('拿不准 → 修改稿进人工队列（editId、reviewToken r:）；人工通过替换；作者又改过则旧 token 409', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const admin = await createUser('admin@example.com', 'admin')
    const author = await createUser('a@example.com')
    const id = await published(author.id)
    await reviseCommunityTutorial(author.id, id, draft(BODY_V2), { moderationMode: 'on' })
    await runOnce(transport({ ad: { answer: 'no', confidence: 0.8 } }))
    const queue = await listAdminCommunityTutorials({ status: 'pending', needsHuman: true, cursor: null, limit: 10 })
    assert.equal(queue.items.length, 1)
    const item = queue.items[0]!
    assert.equal(item.id, id)
    assert.ok(item.editId)
    assert.equal(item.reviewToken, `r:${item.editId}`)
    assert.equal(item.bodyMarkdown, BODY_V2)
    assert.equal(item.moderation?.verdict, 'uncertain')
    assert.equal((await getPublishedCommunityTutorial(id))?.bodyMarkdown, BODY)

    // 作者又改了一版：旧 token 审不了，新的那版重新进 AI。
    await reviseCommunityTutorial(author.id, id, draft(`${BODY_V2}\n\n再补一句。`), { moderationMode: 'on' })
    const stale = await request(`/api/admin/tutorials/${id}/review`, admin.token, {
      decision: 'approve',
      reviewToken: item.reviewToken,
    })
    assert.equal(stale.status, 409)
    assert.equal(((await stale.json()) as { error: { code: string } }).error.code, 'STALE')
    assert.deepEqual((await revisionRows(id)).map((row) => row.status), ['superseded', 'pending'])

    await runOnce(transport({ ad: { answer: 'no', confidence: 0.8 } }))
    const fresh = (await listAdminCommunityTutorials({ status: 'pending', needsHuman: true, cursor: null, limit: 10 })).items[0]!
    const ok = await request(`/api/admin/tutorials/${id}/review`, admin.token, {
      decision: 'approve',
      reviewToken: fresh.reviewToken,
    })
    assert.equal(ok.status, 200)
    assert.match((await getPublishedCommunityTutorial(id))?.bodyMarkdown ?? '', /再补一句/)
    const audit = await query<{ after: { revision_id?: string } }>(
      `SELECT after FROM admin_audit WHERE action = 'tutorial.review' ORDER BY id DESC LIMIT 1`,
    )
    assert.equal(audit.rows[0]?.after?.revision_id, fresh.editId)
  })

  test('人工驳回修改稿必须写理由；驳回后线上不变', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const admin = await createUser('admin@example.com', 'admin')
    const author = await createUser('a@example.com')
    const id = await published(author.id)
    const { revisionId } = await reviseCommunityTutorial(author.id, id, draft(BODY_V2), { moderationMode: 'off' })
    const result = await reviewCommunityTutorialRevision({
      publicationId: id,
      revisionId,
      reviewerUserId: admin.id,
      decision: 'reject',
      note: '补充部分和标题不符',
    })
    assert.equal(result.status, 'rejected')
    assert.equal((await getPublishedCommunityTutorial(id))?.bodyMarkdown, BODY)
    assert.equal((await getOwnCommunityTutorial(id, author.id))?.edit?.reviewNote, '补充部分和标题不符')
    await assert.rejects(
      reviewCommunityTutorialRevision({ publicationId: '999999', revisionId, reviewerUserId: admin.id, decision: 'approve', note: null }),
      /修改稿不存在/,
    )
  })

  test('撤回已发布帖：在审的修改稿一并作废，AI 不再处理；撤回后不能再改', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await createUser('admin@example.com', 'admin')
    const author = await createUser('a@example.com')
    const id = await published(author.id)
    await reviseCommunityTutorial(author.id, id, draft(BODY_V2), { moderationMode: 'on' })
    await withdrawCommunityTutorial(id, author.id)
    assert.deepEqual((await revisionRows(id)).map((row) => row.status), ['withdrawn'])
    const fake = transport()
    await runOnce(fake)
    assert.equal(fake.calls.text, 0)
    assert.equal(await getPublishedCommunityTutorial(id), null)
    await assert.rejects(reviseCommunityTutorial(author.id, id, draft(BODY_V2)), (error: Error & { code?: string }) => {
      assert.equal(error.code, 'NOT_EDITABLE')
      return true
    })
  })
})

describe('经验分享 · 修改待审 / 未通过的稿件', () => {
  test('未通过的稿件改后回到待审、旧理由清空；再次驳回也会发站内信（按版本去重）', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await createUser('admin@example.com', 'admin')
    const author = await createUser('a@example.com')
    const { id } = await submitCommunityTutorial(author.id, draft(), { moderationMode: 'on' })
    await runOnce(transport({ ad: { answer: 'yes', confidence: 0.96 } }))
    assert.equal((await getOwnCommunityTutorial(id, author.id))?.status, 'rejected')

    const result = await reviseCommunityTutorial(author.id, id, draft(BODY_V2), { moderationMode: 'on' })
    assert.equal(result.mode, 'inplace')
    assert.equal(result.contentVersion, 2)
    const mine = await getOwnCommunityTutorial(id, author.id)
    assert.equal(mine?.status, 'pending')
    assert.equal(mine?.reviewNote, null)
    assert.equal(mine?.needsHuman, false)
    assert.deepEqual((await revisionRows(id)).map((row) => row.status), ['direct'])

    const fake = transport({ ad: { answer: 'yes', confidence: 0.96 } })
    await runOnce(fake)
    assert.match(fake.calls.bodies[0] ?? '', /第二周加了一张表/)
    assert.equal((await getOwnCommunityTutorial(id, author.id))?.status, 'rejected')
    assert.deepEqual(
      (await inbox(author.id)).map((row) => row.source_phase),
      ['rejected', 'rejected:v2'],
    )
  })

  test('待审稿件改后作业重置；正在跑的那次结论落不下来（版本不符）', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await createUser('admin@example.com', 'admin')
    const author = await createUser('a@example.com')
    const { id } = await submitCommunityTutorial(author.id, draft(), { moderationMode: 'on' })
    // 模拟：worker 读了 v1、还没落结论时作者改了稿。
    let revised = false
    const racing: ModerationTransport = {
      ...transport(),
      async text(request) {
        if (!revised) {
          revised = true
          await reviseCommunityTutorial(author.id, id, draft(BODY_V2), { moderationMode: 'on' })
        }
        return transport().text(request)
      },
    }
    await runOnce(racing)
    assert.equal((await getOwnCommunityTutorial(id, author.id))?.status, 'pending')
    const job = await query<{ status: string; attempt: number }>(
      'SELECT status, attempt FROM community_tutorial_moderation_jobs WHERE publication_id = $1::bigint',
      [id],
    )
    assert.deepEqual(job.rows[0], { status: 'queued', attempt: 0 })
    await runOnce(transport())
    assert.equal((await getPublishedCommunityTutorial(id))?.bodyMarkdown, BODY_V2)
  })

  test('管理员按旧版本审核待审稿件 → 409 STALE；按新版本通过', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const admin = await createUser('admin@example.com', 'admin')
    const author = await createUser('a@example.com')
    const { id } = await submitCommunityTutorial(author.id, draft(), { moderationMode: 'off' })
    const item = (await listAdminCommunityTutorials({ status: 'pending', needsHuman: true, cursor: null, limit: 10 })).items[0]!
    assert.equal(item.reviewToken, 'p:1')
    assert.equal(item.editId, null)
    await reviseCommunityTutorial(author.id, id, draft(BODY_V2), { moderationMode: 'off' })
    await assert.rejects(
      reviewCommunityTutorial({ id, reviewerUserId: admin.id, decision: 'approve', note: null, expectedVersion: 1 }),
      (error: Error & { code?: string }) => error.code === 'STALE',
    )
    const ok = await request(`/api/admin/tutorials/${id}/review`, admin.token, { decision: 'approve', reviewToken: 'p:2' })
    assert.equal(ok.status, 200)
    assert.equal((await getPublishedCommunityTutorial(id))?.bodyMarkdown, BODY_V2)
  })
})

describe('经验分享 · 修改的权限与频控', () => {
  test('别人的稿件 404；快照教程不能改；正文图片必须是自己上传的', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const author = await createUser('a@example.com')
    const other = await createUser('o@example.com')
    const { id } = await submitCommunityTutorial(author.id, draft(), { moderationMode: 'off' })
    const res = await request(`/api/tutorials/${id}/revise`, other.token, draft(BODY_V2))
    assert.equal(res.status, 404)
    const bad = await request(`/api/tutorials/${id}/revise`, author.token, { ...draft(BODY_V2), title: '短' })
    assert.equal(bad.status, 400)
    const ok = await request(`/api/tutorials/${id}/revise`, author.token, draft(BODY_V2))
    assert.equal(ok.status, 200)
    assert.equal(((await ok.json()) as { tutorial: { mode: string } }).tutorial.mode, 'inplace')

    const foreign = await image(other.id, 30)
    await assert.rejects(
      reviseCommunityTutorial(author.id, id, draft(`${BODY}\n\n![别人的图](tutorial-blob:${foreign})`)),
      /不存在或不属于你的图片/,
    )
    const snapshot = await query<{ id: string }>(
      `INSERT INTO community_tutorials (author_user_id, title, summary, category, body_markdown, kind, snapshot_json, status)
       VALUES ($1::bigint, '快照教程标题', '快照教程的摘要内容写在这里', 'general', $2, 'snapshot', '{}'::jsonb, 'pending')
       RETURNING id::text AS id`,
      [author.id, BODY],
    ).catch(() => null)
    if (snapshot?.rows[0]) {
      await assert.rejects(reviseCommunityTutorial(author.id, snapshot.rows[0].id, draft(BODY_V2)), /快照教程不能修改/)
    }
  })

  test('24 小时修改次数上限；在审篇数（新稿 + 修改稿）合计上限', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await createUser('admin@example.com', 'admin')
    const author = await createUser('a@example.com')
    const { id } = await submitCommunityTutorial(author.id, draft(), { moderationMode: 'off' })
    const limits = { dailyEdits: 2, maxPending: 3 }
    await reviseCommunityTutorial(author.id, id, draft(BODY_V2), { moderationMode: 'off', limits })
    await reviseCommunityTutorial(author.id, id, draft(BODY), { moderationMode: 'off', limits })
    await assert.rejects(
      reviseCommunityTutorial(author.id, id, draft(BODY_V2), { moderationMode: 'off', limits }),
      /24 小时内最多修改 2 次/,
    )

    const live = await published(author.id)
    await submitCommunityTutorial(author.id, draft(BODY, '另一篇待审的经验'), { moderationMode: 'off' })
    await assert.rejects(
      reviseCommunityTutorial(author.id, live, draft(BODY_V2), { moderationMode: 'off', limits: { dailyEdits: 10, maxPending: 2 } }),
      /最多同时有 2 篇在审核/,
    )
  })

  test('只被修改稿引用的图片不被孤儿回收', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await createUser('admin@example.com', 'admin')
    const author = await createUser('a@example.com')
    const id = await published(author.id)
    const sha = await image(author.id, 40)
    await reviseCommunityTutorial(author.id, id, draft(`${BODY_V2}\n\n![图](tutorial-blob:${sha})`), { moderationMode: 'off' })
    await query(`UPDATE tutorial_blob_uploads SET created_at = NOW() - INTERVAL '40 days' WHERE sha256 = $1`, [sha])
    await gcOrphanTutorialBlobs()
    const kept = await query('SELECT 1 FROM tutorial_blobs WHERE sha256 = $1', [sha])
    assert.equal(kept.rowCount, 1)
  })
})
