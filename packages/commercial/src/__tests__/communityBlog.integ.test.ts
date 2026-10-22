import assert from 'node:assert/strict'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, beforeEach, describe, test } from 'node:test'
import sharp from 'sharp'

import { signAccess } from '../auth/jwt.js'
import { query } from '../db/queries.js'
import { HttpError, sendJson } from '../http/util.js'
import {
  handleAdminListCommunityTutorials,
  handleAdminTutorialWrite,
  handleGetCommunityTutorial,
  handleListCommunityTutorials,
  handleListOwnCommunityTutorials,
  handleSubmitCommunityTutorial,
  handleTutorialUserGet,
  handleUploadTutorialImage,
  handleWithdrawCommunityTutorial,
} from '../tutorials/communityTutorialRoutes.js'
import { handleGetTutorialEmbed } from '../tutorials/tutorialBlobRoutes.js'
import { gcOrphanTutorialBlobs } from '../tutorials/tutorialBlobs.js'
import { TUTORIAL_IMAGE_DAILY_UPLOADS } from '../tutorials/tutorialImages.js'
import { truncateAllForTest, useDedicatedTestDatabase } from './helpers/db.js'

// OCV5-577 经验分享：图片上传/归属/预览授权、投稿频控与 256KiB 上限、公开可见性、迁移 0320 约束。
const db = useDedicatedTestDatabase('openclaude_community_blog_test')
const JWT_SECRET = 'community-blog-route-secret'.repeat(3)
let server: Server | null = null
let baseUrl = ''
const previousFlag = process.env.OC_COMMUNITY_BLOG_ENABLED

before(async () => {
  process.env.OC_COMMUNITY_BLOG_ENABLED = '1'
  const deps = { jwtSecret: JWT_SECRET }
  server = createServer(async (req, res) => {
    try {
      const path = (req.url ?? '').split('?')[0] ?? ''
      if (req.method === 'GET' && path === '/api/tutorials') await handleListCommunityTutorials(req, res)
      else if (req.method === 'POST' && path === '/api/tutorials')
        await handleSubmitCommunityTutorial(req, res, deps)
      else if (req.method === 'POST' && path === '/api/tutorials/images')
        await handleUploadTutorialImage(req, res, deps)
      else if (req.method === 'GET' && path === '/api/tutorials/mine')
        await handleListOwnCommunityTutorials(req, res, deps)
      else if (req.method === 'POST' && path.endsWith('/withdraw'))
        await handleWithdrawCommunityTutorial(req, res, deps)
      else if (req.method === 'GET' && path === '/api/admin/tutorials')
        await handleAdminListCommunityTutorials(req, res, deps)
      else if (req.method === 'POST' && path.startsWith('/api/admin/tutorials/'))
        await handleAdminTutorialWrite(req, res, deps)
      else if (req.method === 'GET' && path.startsWith('/api/tutorial-embeds/'))
        await handleGetTutorialEmbed(req, res)
      else if (req.method === 'GET' && path.startsWith('/api/tutorials/'))
        await handleTutorialUserGet(req, res, deps)
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
  if (previousFlag === undefined) Reflect.deleteProperty(process.env, 'OC_COMMUNITY_BLOG_ENABLED')
  else process.env.OC_COMMUNITY_BLOG_ENABLED = previousFlag
  if (!server) return
  server.closeAllConnections()
  await new Promise<void>((resolve) => server!.close(() => resolve()))
})

beforeEach(async () => {
  process.env.OC_COMMUNITY_BLOG_ENABLED = '1'
  if (!db.available) return
  await truncateAllForTest([
    'tutorial_blob_refs',
    'tutorial_blob_uploads',
    'tutorial_blobs',
    'community_tutorials',
    'admin_audit',
    'users',
  ])
})

async function createUser(email: string, role: 'user' | 'admin' = 'user', name = '博主') {
  const result = await query<{ id: string }>(
    `INSERT INTO users(email, password_hash, credits, role, status, display_name)
     VALUES ($1, 'argon2$stub', 0, $2, 'active', $3)
     RETURNING id::text AS id`,
    [email, role, name],
  )
  const id = result.rows[0]!.id
  return { id, token: (await signAccess({ sub: id, role }, JWT_SECRET)).token }
}

function request(
  path: string,
  options: { method?: string; token?: string; json?: unknown; raw?: Buffer; type?: string } = {},
) {
  const headers: Record<string, string> = {}
  if (options.token) headers.Authorization = `Bearer ${options.token}`
  let body: BodyInit | undefined
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(options.json)
  } else if (options.raw) {
    headers['Content-Type'] = options.type ?? 'image/png'
    body = new Uint8Array(options.raw) as BodyInit
  }
  return fetch(`${baseUrl}${path}`, { method: options.method ?? 'GET', headers, body })
}

async function png(seed: number) {
  return sharp({
    create: { width: 40, height: 30, channels: 3, background: { r: seed % 256, g: 80, b: 160 } },
  })
    .png()
    .toBuffer()
}

async function upload(token: string, raw: Buffer, type = 'image/png') {
  const res = await request('/api/tutorials/images', { method: 'POST', token, raw, type })
  const json = (await res.json()) as { image?: { sha256: string }; error?: { code: string } }
  return { status: res.status, sha: json.image?.sha256 ?? '', code: json.error?.code }
}

function post(body: string, title = '用 Agent 做周报的经验') {
  return {
    title,
    summary: '从数据源到定时任务，记录完整的配置步骤和踩坑。',
    category: 'general',
    bodyMarkdown: body,
  }
}

// 正文下限 40 字。
const LONG_TEXT =
  '先准备数据源，再写清楚口径，最后让定时任务每天自动跑一次并核对结果。遇到口径变化时，先改说明再重跑，不要直接改结果。'

async function submit(token: string, body: string) {
  const res = await request('/api/tutorials', { method: 'POST', token, json: post(body) })
  const json = (await res.json()) as { tutorial?: { id: string }; error?: { code: string } }
  return { status: res.status, id: json.tutorial?.id ?? '', code: json.error?.code }
}

describe('经验分享 · 图片上传与归属', () => {
  test('上传 png 返回 sha；同图重复上传幂等；SVG/伪装格式被拒；开关关闭 404', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const user = await createUser('u@example.com')
    const first = await upload(user.token, await png(1))
    assert.equal(first.status, 201)
    assert.match(first.sha, /^[a-f0-9]{64}$/)
    assert.equal((await upload(user.token, await png(1))).status, 201)
    const owners = await query('SELECT 1 FROM tutorial_blob_uploads WHERE user_id = $1::bigint', [user.id])
    assert.equal(owners.rowCount, 1)
    assert.equal(
      (await upload(user.token, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml')).code,
      'BAD_IMAGE',
    )
    assert.equal((await upload(user.token, await png(2), 'image/webp')).code, 'BAD_IMAGE')
    assert.equal(
      (await request('/api/tutorials/images', { method: 'POST', raw: await png(3) })).status,
      401,
    )
    process.env.OC_COMMUNITY_BLOG_ENABLED = '0'
    assert.equal((await upload(user.token, await png(4))).status, 404)
  })

  test(`24 小时最多 ${TUTORIAL_IMAGE_DAILY_UPLOADS} 张，超出 429`, async (t) => {
    if (db.skipIfUnavailable(t)) return
    const user = await createUser('u@example.com')
    const seed = await upload(user.token, await png(1))
    // 直接造满额度（逐张上传太慢），只让最后一张走真实接口。
    await query(
      `INSERT INTO tutorial_blobs (sha256, kind, mime, bytes, body)
       SELECT lpad(to_hex(g), 64, '0'), 'image', 'image/png', 1, '\\x00'::bytea
         FROM generate_series(1, $1::int) g`,
      [TUTORIAL_IMAGE_DAILY_UPLOADS - 1],
    )
    await query(
      `INSERT INTO tutorial_blob_uploads (sha256, user_id)
       SELECT lpad(to_hex(g), 64, '0'), $2::bigint FROM generate_series(1, $1::int) g`,
      [TUTORIAL_IMAGE_DAILY_UPLOADS - 1, user.id],
    )
    assert.equal(seed.status, 201)
    const over = await upload(user.token, await png(9))
    assert.equal(over.status, 429)
    assert.equal(over.code, 'RATE_LIMITED')
  })

  test('预览：上传者与管理员可读，其他人 404；公开 embed 只在 approved 后可读，下架后 404', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const author = await createUser('a@example.com')
    const other = await createUser('o@example.com')
    const admin = await createUser('admin@example.com', 'admin', '管理员')
    const { sha } = await upload(author.token, await png(7))
    assert.equal((await request(`/api/tutorials/images/${sha}`, { token: author.token })).status, 200)
    assert.equal((await request(`/api/tutorials/images/${sha}`, { token: other.token })).status, 404)
    assert.equal((await request(`/api/tutorials/images/${sha}`, { token: admin.token })).status, 200)
    assert.equal((await request(`/api/tutorials/images/${sha}`)).status, 401)

    const submitted = await submit(author.token, `${LONG_TEXT}\n\n![配置截图](tutorial-blob:${sha})`)
    assert.equal(submitted.status, 201)
    assert.equal((await request(`/api/tutorial-embeds/${sha}`)).status, 404)

    const approve = await request(`/api/admin/tutorials/${submitted.id}/review`, {
      method: 'POST',
      token: admin.token,
      json: { decision: 'approve', note: '' },
    })
    assert.equal(approve.status, 200)
    const embed = await request(`/api/tutorial-embeds/${sha}`)
    assert.equal(embed.status, 200)
    assert.equal(embed.headers.get('content-type'), 'image/png')

    const detail = await request(`/api/tutorials/${submitted.id}`)
    assert.equal(detail.headers.get('x-robots-tag'), 'noindex')
    const dto = ((await detail.json()) as { tutorial: { coverSha: string; refs: Array<{ role: string }> } })
      .tutorial
    assert.equal(dto.coverSha, sha)
    assert.deepEqual(dto.refs.map((ref) => ref.role), [`image:${sha.slice(0, 12)}`])

    const takedown = await request(`/api/admin/tutorials/${submitted.id}/takedown`, {
      method: 'POST',
      token: admin.token,
      json: { note: '违反社区规范' },
    })
    assert.equal(takedown.status, 200)
    assert.equal((await request(`/api/tutorials/${submitted.id}`)).status, 404)
    assert.equal((await request(`/api/tutorial-embeds/${sha}`)).status, 404)
  })

  test('未绑定的新上传不会被孤儿回收删掉', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const user = await createUser('u@example.com')
    const { sha } = await upload(user.token, await png(5))
    await gcOrphanTutorialBlobs()
    const rows = await query('SELECT 1 FROM tutorial_blobs WHERE sha256 = $1', [sha])
    assert.equal(rows.rowCount, 1)
  })
})

describe('经验分享 · 投稿', () => {
  test('引用他人图片、外链图片、超 20 张一律 400；开关关闭时带图投稿 404', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const author = await createUser('a@example.com')
    const other = await createUser('o@example.com')
    const { sha } = await upload(other.token, await png(11))
    assert.equal((await submit(author.token, `${LONG_TEXT}\n![x](tutorial-blob:${sha})`)).code, 'BAD_IMAGE')
    assert.equal(
      (await submit(author.token, `${LONG_TEXT}\n![x](https://example.com/a.png)`)).code,
      'EXTERNAL_IMAGE',
    )
    const many = Array.from({ length: 21 }, (_, i) => `![](tutorial-blob:${i.toString(16).padStart(64, '0')})`)
    assert.equal((await submit(author.token, `${LONG_TEXT}\n${many.join('\n')}`)).code, 'TOO_MANY_IMAGES')
    const own = await upload(author.token, await png(12))
    process.env.OC_COMMUNITY_BLOG_ENABLED = '0'
    assert.equal((await submit(author.token, `${LONG_TEXT}\n![x](tutorial-blob:${own.sha})`)).status, 404)
    // 纯文字投稿不受开关影响（旧的社区教程照常）。
    assert.equal((await submit(author.token, LONG_TEXT)).status, 201)
  })

  test('50000 字中文正文能投稿（256KiB 上限，修复 64KiB 下的 413）', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const author = await createUser('a@example.com')
    const body = '经验'.repeat(25_000)
    assert.ok(Buffer.byteLength(JSON.stringify(post(body))) > 64 * 1024)
    const res = await submit(author.token, body)
    assert.equal(res.status, 201)
    const tooLong = await submit(author.token, `${body}多`)
    assert.equal(tooLong.status, 400)
  })

  test('同时在审最多 3 篇、24 小时最多 5 篇，超出 429', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const author = await createUser('a@example.com')
    const admin = await createUser('admin@example.com', 'admin', '管理员')
    const ids: string[] = []
    for (let i = 0; i < 3; i += 1) {
      const res = await submit(author.token, `${LONG_TEXT} 第 ${i} 篇`)
      assert.equal(res.status, 201)
      ids.push(res.id)
    }
    const fourth = await submit(author.token, `${LONG_TEXT} 第 4 篇`)
    assert.equal(fourth.status, 429)
    assert.equal(fourth.code, 'RATE_LIMITED')
    for (const id of ids) {
      await request(`/api/admin/tutorials/${id}/review`, {
        method: 'POST',
        token: admin.token,
        json: { decision: 'reject', note: '请补充步骤' },
      })
    }
    assert.equal((await submit(author.token, `${LONG_TEXT} 第 5 篇`)).status, 201)
    assert.equal((await submit(author.token, `${LONG_TEXT} 第 6 篇`)).status, 201)
    const sixth = await submit(author.token, `${LONG_TEXT} 第 7 篇`)
    assert.equal(sixth.status, 429)
  })

  test('投稿进入人工队列；我的投稿带 needsHuman/reviewSource/viewCount；阅读计数只在公开后增长', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const author = await createUser('a@example.com')
    const admin = await createUser('admin@example.com', 'admin', '管理员')
    const { id } = await submit(author.token, LONG_TEXT)
    const queue = await request('/api/admin/tutorials?status=pending&needsHuman=1', { token: admin.token })
    assert.equal(queue.status, 200)
    const queued = ((await queue.json()) as { tutorials: Array<{ id: string; needsHuman: boolean }> })
      .tutorials
    assert.deepEqual(queued.map((row) => [row.id, row.needsHuman]), [[id, true]])
    assert.equal(
      (await request('/api/admin/tutorials?status=bogus', { token: admin.token })).status,
      400,
    )
    assert.equal((await request('/api/admin/tutorials', { token: author.token })).status, 403)
    assert.equal((await request(`/api/tutorials/${id}`)).status, 404)

    await request(`/api/admin/tutorials/${id}/review`, {
      method: 'POST',
      token: admin.token,
      json: { decision: 'approve', note: '' },
    })
    await request(`/api/tutorials/${id}`)
    await request(`/api/tutorials/${id}`)
    const mine = (await (await request('/api/tutorials/mine', { token: author.token })).json()) as {
      tutorials: Array<{ needsHuman: boolean; reviewSource: string; viewCount: number; readMinutes: number }>
    }
    assert.deepEqual(
      {
        needsHuman: mine.tutorials[0]?.needsHuman,
        reviewSource: mine.tutorials[0]?.reviewSource,
        viewCount: mine.tutorials[0]?.viewCount,
        readMinutes: mine.tutorials[0]?.readMinutes,
      },
      { needsHuman: false, reviewSource: 'human', viewCount: 2, readMinutes: 1 },
    )
    const approved = (await (
      await request('/api/admin/tutorials?status=approved', { token: admin.token })
    ).json()) as { tutorials: Array<{ id: string }> }
    assert.deepEqual(approved.tutorials.map((row) => row.id), [id])
    const list = (await (await request('/api/tutorials?q=博主')).json()) as {
      tutorials: Array<{ id: string }>
      total: number
    }
    assert.deepEqual(list.tutorials.map((row) => row.id), [id])
    assert.equal(list.total, 1)
    const markdownOnly = (await (await request('/api/tutorials?kind=markdown')).json()) as {
      tutorials: Array<{ id: string }>
    }
    assert.deepEqual(markdownOnly.tutorials.map((row) => row.id), [id])
    const snapshotOnly = (await (await request('/api/tutorials?kind=snapshot')).json()) as {
      tutorials: unknown[]
      total: number
    }
    assert.deepEqual([snapshotOnly.tutorials, snapshotOnly.total], [[], 0])
    assert.equal((await request('/api/tutorials?kind=video')).status, 400)
  })

  test('作者撤回后 needs_human 清掉，人工队列里不再出现', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const author = await createUser('a@example.com')
    const admin = await createUser('admin@example.com', 'admin', '管理员')
    const { id } = await submit(author.token, LONG_TEXT)
    assert.equal(
      (await request(`/api/tutorials/${id}/withdraw`, { method: 'POST', token: author.token })).status,
      200,
    )
    const row = await query<{ needs_human: boolean }>(
      'SELECT needs_human FROM community_tutorials WHERE id = $1::bigint',
      [id],
    )
    assert.equal(row.rows[0]?.needs_human, false)
    const queue = (await (
      await request('/api/admin/tutorials?status=pending&needsHuman=1', { token: admin.token })
    ).json()) as { tutorials: unknown[] }
    assert.deepEqual(queue.tutorials, [])
  })
})

describe('迁移 0320 约束', () => {
  test('AI 审核可以没有 reviewed_by；既无审核人又非 AI 的 approved 行被拒', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const author = await createUser('a@example.com')
    const { id } = await submit(author.token, LONG_TEXT)
    await query(
      `UPDATE community_tutorials
          SET status = 'approved', review_source = 'ai', reviewed_at = NOW(), published_at = NOW(),
              needs_human = false
        WHERE id = $1::bigint`,
      [id],
    )
    const second = await submit(author.token, `${LONG_TEXT} 另一篇`)
    await assert.rejects(
      query(
        `UPDATE community_tutorials
            SET status = 'approved', reviewed_at = NOW(), published_at = NOW()
          WHERE id = $1::bigint`,
        [second.id],
      ),
      /community_tutorials_review_state_chk/,
    )
    await assert.rejects(
      query(`UPDATE community_tutorials SET review_source = 'robot' WHERE id = $1::bigint`, [id]),
      /community_tutorials_review_source_chk/,
    )
  })
})
