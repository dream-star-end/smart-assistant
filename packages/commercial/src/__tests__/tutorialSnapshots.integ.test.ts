import assert from 'node:assert/strict'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'

import { signAccess } from '../auth/jwt.js'
import { query } from '../db/queries.js'
import { HttpError, sendJson } from '../http/util.js'
import { truncateAllForTest, useDedicatedTestDatabase } from './helpers/db.js'
import {
  TUTORIAL_SNAPSHOT_MAX_BODY_BYTES,
  handleAdminPendingCommunityTutorials,
  handleAdminReviewCommunityTutorial,
  handleAdminTakedownCommunityTutorial,
  handleGetCommunityTutorial,
  handleListCommunityTutorials,
  handleListOwnCommunityTutorials,
  handleSubmitCommunityTutorial,
  handleSubmitTutorialSnapshot,
  handleTutorialUserGet,
  handleWithdrawCommunityTutorial,
} from '../tutorials/communityTutorialRoutes.js'
import { handleGetTutorialBlob, handleGetTutorialEmbed } from '../tutorials/tutorialBlobRoutes.js'
import { setTutorialTimelineReaderForTest } from '../tutorials/tutorialTimeline.js'

const db = useDedicatedTestDatabase('openclaude_tutorial_snapshots_test')
const JWT_SECRET = 'tutorial-snapshot-route-secret'.repeat(3)
let server: Server | null = null
let baseUrl = ''

before(async () => {
  const deps = { jwtSecret: JWT_SECRET }
  server = createServer(async (req, res) => {
    try {
      const path = (req.url ?? '').split('?')[0] ?? ''
      if (req.method === 'GET' && path === '/api/tutorials') await handleListCommunityTutorials(req, res)
      else if (req.method === 'POST' && path === '/api/tutorials')
        await handleSubmitCommunityTutorial(req, res, deps)
      else if (req.method === 'POST' && path === '/api/tutorials/snapshots')
        await handleSubmitTutorialSnapshot(req, res, deps)
      else if (req.method === 'GET' && path === '/api/tutorials/mine')
        await handleListOwnCommunityTutorials(req, res, deps)
      else if (req.method === 'POST' && path.endsWith('/withdraw'))
        await handleWithdrawCommunityTutorial(req, res, deps)
      else if (req.method === 'GET' && path === '/api/admin/tutorials/pending')
        await handleAdminPendingCommunityTutorials(req, res, deps)
      else if (req.method === 'POST' && path.endsWith('/review'))
        await handleAdminReviewCommunityTutorial(req, res, deps)
      else if (req.method === 'POST' && path.endsWith('/takedown'))
        await handleAdminTakedownCommunityTutorial(req, res, deps)
      else if (req.method === 'GET' && path.startsWith('/api/tutorial-blobs/'))
        await handleGetTutorialBlob(req, res)
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
  if (!server) return
  server.closeAllConnections()
  await new Promise<void>((resolve) => server!.close(() => resolve()))
})

beforeEach(async () => {
  if (!db.available) return
  await truncateAllForTest([
    'tutorial_blob_refs',
    'tutorial_blobs',
    'community_tutorials',
    'admin_audit',
    'users',
  ])
})

afterEach(() => {
  setTutorialTimelineReaderForTest(null)
})

async function createUser(email: string, role: 'user' | 'admin') {
  const result = await query<{ id: string }>(
    `INSERT INTO users(email, password_hash, credits, role, status, display_name)
     VALUES ($1, 'argon2$stub', 0, $2, 'active', $3)
     RETURNING id::text AS id`,
    [email, role, role === 'admin' ? '管理员' : '投稿用户'],
  )
  const id = result.rows[0]!.id
  return { id, token: (await signAccess({ sub: id, role }, JWT_SECRET)).token }
}

function request(path: string, options: { method?: string; token?: string; body?: unknown } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
}

async function readJson<T>(res: Response, expectedStatus = 201): Promise<T> {
  const text = await res.text()
  assert.equal(res.status, expectedStatus, text)
  return JSON.parse(text) as T
}

const SESSION_ID = 'sess-owner01'
const cleanMessages = [
  { id: 'msg-1', role: 'user', text: '请根据公开数据写一份简报', ts: 1 },
  { id: 'msg-2', role: 'assistant', text: '简报已完成，结论可核对。', ts: 2 },
]

function stubOwnedTimeline(
  userId: string,
  messages: Array<Record<string, unknown>>,
  sessionId = SESSION_ID,
): void {
  setTutorialTimelineReaderForTest({
    async readClientTimelinePage(sid, uid) {
      if (sid !== sessionId || uid !== `c:${userId}`) return null
      return { messages, nextCursor: null, hasMore: false }
    },
  })
}

describe('tutorial snapshots HTTP', () => {
  test('draft/pending snapshots are owner-only; anonymous sees them only after approve', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const user = await createUser('user@example.com', 'user')
    const admin = await createUser('admin@example.com', 'admin')
    stubOwnedTimeline(user.id, cleanMessages)
    const created = await request('/api/tutorials/snapshots', {
      method: 'POST',
      token: user.token,
      body: {
        title: '公开数据简报快照',
        summary: '把一次干净会话做成可回放教程。',
        category: 'general',
        sourceSessionId: SESSION_ID,
        asDraft: true,
      },
    })
    const createdJson = await readJson<{ tutorial: { id: string; kind: string } }>(created)
    assert.equal(createdJson.tutorial.kind, 'snapshot')
    const id = createdJson.tutorial.id
    assert.equal((await request(`/api/tutorials/${id}`)).status, 404)
    const mine = await request(`/api/tutorials/mine/${id}`, { token: user.token })
    assert.equal(mine.status, 200)
    const mineBody = (await mine.json()) as {
      tutorial: { sourceSessionId: string | null; snapshot: { messageCount: number } }
    }
    assert.equal(mineBody.tutorial.snapshot.messageCount, 2)
    assert.equal(mineBody.tutorial.sourceSessionId, SESSION_ID)
    const listed = await request('/api/tutorials/mine', { token: user.token })
    const listedJson = (await listed.json()) as { tutorials: Array<{ sourceSessionId?: unknown }> }
    assert.equal(listedJson.tutorials[0]?.sourceSessionId, undefined)
    const other = await createUser('other@example.com', 'user')
    assert.equal((await request(`/api/tutorials/mine/${id}`, { token: other.token })).status, 404)

    stubOwnedTimeline(user.id, cleanMessages)
    const pending = await request('/api/tutorials/snapshots', {
      method: 'POST',
      token: user.token,
      body: {
        title: '待审公开数据简报快照',
        summary: '把一次干净会话做成可回放教程。',
        category: 'general',
        sourceSessionId: SESSION_ID,
      },
    })
    const pendingJson = await readJson<{ tutorial: { id: string } }>(pending)
    const pendingId = pendingJson.tutorial.id
    const approved = await request(`/api/admin/tutorials/${pendingId}/review`, {
      method: 'POST',
      token: admin.token,
      body: { decision: 'approve', note: '干净' },
    })
    assert.equal(approved.status, 200)
    const publicDetail = await request(`/api/tutorials/${pendingId}`)
    assert.equal(publicDetail.status, 200)
    const detail = (await publicDetail.json()) as {
      tutorial: { kind: string; snapshot: { pages: Array<{ sha256: string }>; messageCount: number }; sourceSessionId?: unknown }
    }
    assert.equal(detail.tutorial.kind, 'snapshot')
    assert.equal(detail.tutorial.sourceSessionId, undefined)
    const sha = detail.tutorial.snapshot.pages[0]!.sha256
    const blob = await request(`/api/tutorial-blobs/${sha}`)
    assert.equal(blob.status, 200)
    assert.equal(blob.headers.get('content-disposition')?.startsWith('attachment'), true)
    assert.equal(blob.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(blob.headers.get('content-type'), 'application/octet-stream')
    assert.equal(blob.headers.get('cache-control'), 'no-store')
  })

  test('withdraw and takedown immediately hide blobs', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const user = await createUser('user@example.com', 'user')
    const admin = await createUser('admin@example.com', 'admin')
    const html = Buffer.from('<div>hello</div>').toString('base64')
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')
    stubOwnedTimeline(user.id, cleanMessages)
    const created = await request('/api/tutorials/snapshots', {
      method: 'POST',
      token: user.token,
      body: {
        title: '可撤回的交互快照教程',
        summary: '包含一份无外链 HTML 预览。',
        category: 'coding',
        sourceSessionId: SESSION_ID,
        selectedArtifacts: [
          { name: 'demo.html', mimeType: 'text/html', contentBase64: html },
          { name: 'shot.png', mimeType: 'image/png', contentBase64: png },
        ],
      },
    })
    const createdJson = await readJson<{ tutorial: { id: string; kind: string } }>(created)
    assert.equal(createdJson.tutorial.kind, 'snapshot')
    const id = createdJson.tutorial.id
    assert.equal(
      (
        await request(`/api/admin/tutorials/${id}/review`, {
          method: 'POST',
          token: admin.token,
          body: { decision: 'approve' },
        })
      ).status,
      200,
    )
    const detail = (await (await request(`/api/tutorials/${id}`)).json()) as {
      tutorial: {
        snapshot: { pages: Array<{ sha256: string }>; artifacts: Array<{ mimeType: string }> }
        refs: Array<{ sha256: string; kind: string; mime: string }>
      }
    }
    assert.ok(detail.tutorial.snapshot.artifacts.some((row) => row.mimeType === 'text/html'))
    const pageSha = detail.tutorial.snapshot.pages[0]!.sha256
    const htmlSha = detail.tutorial.refs.find((row) => row.kind === 'htmlpreview')!.sha256
    const pngSha = detail.tutorial.refs.find((row) => row.kind === 'media')!.sha256
    const embed = await request(`/api/tutorial-embeds/${htmlSha}`)
    assert.equal(embed.status, 200)
    assert.match(embed.headers.get('content-security-policy') ?? '', /connect-src 'none'/)
    assert.match(embed.headers.get('content-security-policy') ?? '', /form-action 'none'/)
    assert.match(embed.headers.get('content-security-policy') ?? '', /navigate-to 'none'/)
    assert.equal(embed.headers.get('content-disposition')?.startsWith('inline'), true)
    assert.equal(embed.headers.get('cache-control'), 'no-store')
    const pngEmbed = await request(`/api/tutorial-embeds/${pngSha}`)
    assert.equal(pngEmbed.status, 200)
    assert.equal(pngEmbed.headers.get('content-type'), 'image/png')
    assert.equal(pngEmbed.headers.get('content-disposition')?.startsWith('inline'), true)
    assert.equal(pngEmbed.headers.get('cache-control'), 'no-store')

    assert.equal(
      (await request(`/api/tutorials/${id}/withdraw`, { method: 'POST', token: user.token })).status,
      200,
    )
    assert.equal((await request(`/api/tutorials/${id}`)).status, 404)
    assert.equal((await request(`/api/tutorial-blobs/${pageSha}`)).status, 404)
    assert.equal((await request(`/api/tutorial-embeds/${htmlSha}`)).status, 404)
    assert.equal((await request(`/api/tutorial-embeds/${pngSha}`)).status, 404)
  })

  test('takedown hides blobs; reject still works on unsafe pending; owner/open-turn locked', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const user = await createUser('user@example.com', 'user')
    const admin = await createUser('admin@example.com', 'admin')
    stubOwnedTimeline(user.id, [{ id: 'm1', role: 'user', text: '联系 foo@example.com', ts: 1 }])
    const leaked = await request('/api/tutorials/snapshots', {
      method: 'POST',
      token: user.token,
      body: {
        title: '含邮箱的非法快照教程',
        summary: '这一条必须被扫描拒绝。',
        category: 'general',
        sourceSessionId: SESSION_ID,
      },
    })
    assert.equal(leaked.status, 400)
    const leakedJson = (await leaked.json()) as { leakReport: { leaks: Array<{ rule: string; field: string }> } }
    assert.equal(leakedJson.leakReport.leaks[0]?.rule, 'email')
    assert.equal(JSON.stringify(leakedJson).includes('foo@example.com'), false)

    assert.equal(TUTORIAL_SNAPSHOT_MAX_BODY_BYTES, 48 * 1024 * 1024)
    stubOwnedTimeline(user.id, cleanMessages)
    const shortBody = await request('/api/tutorials/snapshots', {
      method: 'POST',
      token: user.token,
      body: {
        title: '导语过短的快照教程',
        summary: '导语过短必须 400 而不是撞库约束 500。',
        category: 'general',
        sourceSessionId: SESSION_ID,
        bodyMarkdown: '太短了',
      },
    })
    assert.equal(shortBody.status, 400)

    const missing = await request('/api/tutorials/snapshots', {
      method: 'POST',
      token: user.token,
      body: {
        title: '无权会话不能导出快照',
        summary: '他人或不存在的会话必须 404。',
        category: 'general',
        sourceSessionId: 'sess-missing',
      },
    })
    assert.equal(missing.status, 404)

    setTutorialTimelineReaderForTest({
      async readClientTimelinePage() {
        return {
          messages: [{ id: 'm1', role: 'user', text: '进行中', ts: 1, _turnTapeProcess: true }],
          nextCursor: null,
          hasMore: false,
        }
      },
    })
    const openTurn = await request('/api/tutorials/snapshots', {
      method: 'POST',
      token: user.token,
      body: {
        title: '未结束回合不能发布快照',
        summary: 'open turn 必须拒绝。',
        category: 'general',
        sourceSessionId: SESSION_ID,
      },
    })
    assert.equal(openTurn.status, 409)

    stubOwnedTimeline(user.id, cleanMessages)
    const created = await request('/api/tutorials/snapshots', {
      method: 'POST',
      token: user.token,
      body: {
        title: '将被管理员下架的快照',
        summary: '下架后公开 blob 必须 404。',
        category: 'general',
        sourceSessionId: SESSION_ID,
      },
    })
    const createdJson = await readJson<{ tutorial: { id: string } }>(created)
    const id = createdJson.tutorial.id
    await query(`UPDATE community_tutorials SET body_markdown = $2 WHERE id = $1::bigint`, [
      id,
      '联系 leaked@example.com 的不安全待审正文，长度必须超过四十个字符。',
    ])
    const rejected = await request(`/api/admin/tutorials/${id}/review`, {
      method: 'POST',
      token: admin.token,
      body: { decision: 'reject', note: '内容不安全但仍允许拒绝' },
    })
    assert.equal(rejected.status, 200, await rejected.text())

    stubOwnedTimeline(user.id, cleanMessages)
    const created2 = await request('/api/tutorials/snapshots', {
      method: 'POST',
      token: user.token,
      body: {
        title: '批准后下架的快照教程',
        summary: '下架后公开 blob 必须 404。',
        category: 'general',
        sourceSessionId: SESSION_ID,
      },
    })
    const created2Json = await readJson<{ tutorial: { id: string } }>(created2)
    const id2 = created2Json.tutorial.id
    await request(`/api/admin/tutorials/${id2}/review`, {
      method: 'POST',
      token: admin.token,
      body: { decision: 'approve' },
    })
    const sha = (
      (await (await request(`/api/tutorials/${id2}`)).json()) as {
        tutorial: { snapshot: { pages: Array<{ sha256: string }> } }
      }
    ).tutorial.snapshot.pages[0]!.sha256
    const takedown = await request(`/api/admin/tutorials/${id2}/takedown`, {
      method: 'POST',
      token: admin.token,
      body: { note: '含未授权材料' },
    })
    assert.equal(takedown.status, 200, await takedown.text())
    assert.equal((await request(`/api/tutorial-blobs/${sha}`)).status, 404)
  })
})
