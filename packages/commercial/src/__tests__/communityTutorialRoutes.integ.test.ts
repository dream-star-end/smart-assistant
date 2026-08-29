import assert from 'node:assert/strict'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, beforeEach, describe, test } from 'node:test'

import { signAccess } from '../auth/jwt.js'
import { query } from '../db/queries.js'
import {
  handleAdminPendingCommunityTutorials,
  handleAdminReviewCommunityTutorial,
  handleGetCommunityTutorial,
  handleListCommunityTutorials,
  handleListOwnCommunityTutorials,
  handleSubmitCommunityTutorial,
  handleWithdrawCommunityTutorial,
} from '../tutorials/communityTutorialRoutes.js'
import { HttpError, sendJson } from '../http/util.js'
import { truncateAllForTest, useDedicatedTestDatabase } from './helpers/db.js'

const db = useDedicatedTestDatabase('openclaude_community_tutorial_routes_test')
const JWT_SECRET = 'community-tutorial-route-secret'.repeat(3)
let server: Server | null = null
let baseUrl = ''

before(async () => {
  const deps = { jwtSecret: JWT_SECRET }
  server = createServer(async (req, res) => {
    try {
      const path = (req.url ?? '').split('?')[0]
      if (req.method === 'GET' && path === '/api/tutorials')
        await handleListCommunityTutorials(req, res)
      else if (req.method === 'POST' && path === '/api/tutorials')
        await handleSubmitCommunityTutorial(req, res, deps)
      else if (req.method === 'GET' && path === '/api/tutorials/mine')
        await handleListOwnCommunityTutorials(req, res, deps)
      else if (req.method === 'POST' && path.endsWith('/withdraw'))
        await handleWithdrawCommunityTutorial(req, res, deps)
      else if (req.method === 'GET' && path === '/api/admin/tutorials/pending')
        await handleAdminPendingCommunityTutorials(req, res, deps)
      else if (req.method === 'POST' && path.startsWith('/api/admin/tutorials/'))
        await handleAdminReviewCommunityTutorial(req, res, deps)
      else if (req.method === 'GET' && path.startsWith('/api/tutorials/'))
        await handleGetCommunityTutorial(req, res)
      else sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'not found' } })
    } catch (error) {
      const http =
        error instanceof HttpError ? error : new HttpError(500, 'INTERNAL', String(error))
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
  await truncateAllForTest(['community_tutorials', 'admin_audit', 'users'])
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

const validDraft = {
  title: '从零完成一份公开数据分析',
  summary: '展示如何准备数据、运行分析并核对最终交付物。',
  category: 'research',
  bodyMarkdown:
    '# 准备\n\n下载公开数据并记录来源。\n\n# 执行\n\n运行分析并逐项核对每个结果与交付文件。',
}

describe('community tutorial HTTP routes', () => {
  test('approved 目录允许匿名读取；未登录投稿被拒绝', async (t) => {
    if (db.skipIfUnavailable(t)) return
    assert.equal((await request('/api/tutorials')).status, 200)
    assert.equal(
      (await request('/api/tutorials', { method: 'POST', body: validDraft })).status,
      401,
    )
  })

  test('普通用户可投稿/查看/撤回自己的 pending，不能访问 admin 队列', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const user = await createUser('user@example.com', 'user')
    const submitted = await request('/api/tutorials', {
      method: 'POST',
      token: user.token,
      body: validDraft,
    })
    assert.equal(submitted.status, 201)
    const id = ((await submitted.json()) as { tutorial: { id: string } }).tutorial.id
    const mine = await request('/api/tutorials/mine', { token: user.token })
    assert.equal(mine.status, 200)
    assert.equal(
      ((await mine.json()) as { tutorials: Array<{ status: string }> }).tutorials[0]?.status,
      'pending',
    )
    assert.equal((await request('/api/admin/tutorials/pending', { token: user.token })).status, 403)
    assert.equal(
      (await request(`/api/tutorials/${id}/withdraw`, { method: 'POST', token: user.token }))
        .status,
      200,
    )
  })

  test('管理员拒绝须给理由；approve 后立即进入匿名目录并写审计', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const user = await createUser('user@example.com', 'user')
    const admin = await createUser('admin@example.com', 'admin')
    const submitted = await request('/api/tutorials', {
      method: 'POST',
      token: user.token,
      body: validDraft,
    })
    const id = ((await submitted.json()) as { tutorial: { id: string } }).tutorial.id
    const pending = await request('/api/admin/tutorials/pending', { token: admin.token })
    assert.equal(pending.status, 200)
    assert.equal(
      ((await pending.json()) as { tutorials: Array<{ id: string }> }).tutorials[0]?.id,
      id,
    )

    const blankReject = await request(`/api/admin/tutorials/${id}/review`, {
      method: 'POST',
      token: admin.token,
      body: { decision: 'reject', note: '' },
    })
    assert.equal(blankReject.status, 400)
    const approved = await request(`/api/admin/tutorials/${id}/review`, {
      method: 'POST',
      token: admin.token,
      body: { decision: 'approve', note: '内容完整' },
    })
    assert.equal(approved.status, 200)
    const publicList = (await (await request('/api/tutorials')).json()) as {
      tutorials: Array<{ id: string }>
    }
    assert.equal(publicList.tutorials[0]?.id, id)
    assert.equal((await request(`/api/tutorials/${id}`)).status, 200)
    const audit = await query<{ action: string; target: string }>(
      `SELECT action, target FROM admin_audit WHERE action = 'tutorial.review'`,
    )
    assert.deepEqual(audit.rows, [
      { action: 'tutorial.review', target: `community_tutorial:${id}` },
    ])
  })
})
