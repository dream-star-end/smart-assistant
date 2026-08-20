import assert from 'node:assert/strict'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, beforeEach, describe, test } from 'node:test'

import { signAccess } from '../auth/jwt.js'
import { query } from '../db/queries.js'
import { HttpError, sendJson } from '../http/util.js'
import { truncateAllForTest, useDedicatedTestDatabase } from './helpers/db.js'
import {
  handleAdminTutorialControlGet,
  handleAdminTutorialControlPost,
} from '../tutorials/tutorialEvalRoutes.js'
import {
  claimEvalJob,
  finishEvalJob,
  recoverExpiredEvalLeases,
} from '../tutorials/tutorialEval.js'

const db = useDedicatedTestDatabase('openclaude_tutorial_eval_test')
const JWT_SECRET = 'tutorial-eval-route-secret'.repeat(3)
let server: Server | null = null
let baseUrl = ''

before(async () => {
  const deps = { jwtSecret: JWT_SECRET }
  server = createServer(async (req, res) => {
    try {
      const path = (req.url ?? '').split('?')[0] ?? ''
      if (req.method === 'GET' && path.startsWith('/api/admin/tutorials/'))
        await handleAdminTutorialControlGet(req, res, deps)
      else if (req.method === 'POST') await handleAdminTutorialControlPost(req, res, deps)
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
    'tutorial_compass_notes',
    'tutorial_eval_jobs',
    'tutorial_case_specs',
    'admin_audit',
    'users',
  ])
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

const specBody = {
  publicId: 'research-bike-demand-eval',
  title: '公开自行车需求回归评测',
  sourceUrl: 'https://archive.ics.uci.edu/dataset/275/bike+sharing+dataset',
  sourcePlatform: 'UCI',
  collectedAt: new Date().toISOString(),
  frozenPrompt: '使用冻结输入完成回归，交付报告、图表与可复跑工程。',
  frozenMaterials: { items: [{ name: 'hour.csv', sha256: 'ab'.repeat(32) }] },
  rubric: {
    checks: [{ id: 'r2', method: 'metric', passCriterion: 'test R2 >= 0.85' }],
  },
}

describe('tutorial eval control plane', () => {
  test('authors cannot touch eval APIs; admin spec/job is idempotent', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const user = await createUser('user@example.com', 'user')
    const admin = await createUser('admin@example.com', 'admin')
    assert.equal(
      (await request('/api/admin/tutorials/case-specs', { method: 'POST', token: user.token, body: specBody }))
        .status,
      403,
    )
    const created = await request('/api/admin/tutorials/case-specs', {
      method: 'POST',
      token: admin.token,
      body: specBody,
    })
    assert.equal(created.status, 201)
    const specId = ((await created.json()) as { spec: { id: string } }).spec.id
    const first = await request('/api/admin/tutorials/eval-jobs', {
      method: 'POST',
      token: admin.token,
      body: { specId, idempotencyKey: 'eval-key-12345678' },
    })
    const second = await request('/api/admin/tutorials/eval-jobs', {
      method: 'POST',
      token: admin.token,
      body: { specId, idempotencyKey: 'eval-key-12345678' },
    })
    assert.equal(first.status, 201)
    assert.equal(second.status, 200)
    const firstId = ((await first.json()) as { job: { id: string } }).job.id
    const secondId = ((await second.json()) as { job: { id: string } }).job.id
    assert.equal(firstId, secondId)
    const listed = await request('/api/admin/tutorials/eval-jobs', { token: admin.token })
    const listedJson = (await listed.json()) as { jobs: Array<{ fencingToken?: unknown }> }
    assert.equal(listedJson.jobs[0]?.fencingToken, undefined)
  })

  test('claim uses fencing; wrong token cannot finish; expired lease is recoverable', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const admin = await createUser('admin@example.com', 'admin')
    const created = await request('/api/admin/tutorials/case-specs', {
      method: 'POST',
      token: admin.token,
      body: specBody,
    })
    const specId = ((await created.json()) as { spec: { id: string } }).spec.id
    const job = await request('/api/admin/tutorials/eval-jobs', {
      method: 'POST',
      token: admin.token,
      body: { specId, idempotencyKey: 'eval-lease-12345678' },
    })
    const jobId = ((await job.json()) as { job: { id: string } }).job.id
    const claimed = await claimEvalJob({ ownerId: 'worker-a', leaseMs: 60_000 })
    assert.ok(claimed)
    assert.equal(claimed!.id, jobId)
    await assert.rejects(() =>
      finishEvalJob({
        jobId,
        fencingToken: 'not-the-token',
        result: 'failed',
        evidence: { ok: false },
      }),
    )
    const finished = await finishEvalJob({
      jobId,
      fencingToken: claimed!.fencingToken,
      result: 'failed',
      evidence: { checks: [{ id: 'r2', passed: false }] },
    })
    assert.equal(finished.status, 'compass_pending')
    const note = await request('/api/admin/tutorials/compass', {
      method: 'POST',
      token: admin.token,
      body: {
        evalJobId: jobId,
        clusterKey: 'r2-miss',
        severity: 'P1',
        summary: '冻结评测未达到 R2 门槛，需要脱敏后交给 grok 罗盘。',
      },
    })
    assert.equal(note.status, 201, await note.text())
    const compass = await request('/api/admin/tutorials/compass', { token: admin.token })
    const compassJson = (await compass.json()) as { notes: Array<{ grokModel?: string }> }
    assert.equal(compassJson.notes[0]?.grokModel, 'cursor-grok-4.6-high')

    const job2 = await request('/api/admin/tutorials/eval-jobs', {
      method: 'POST',
      token: admin.token,
      body: { specId, idempotencyKey: 'eval-recover-12345678' },
    })
    const job2Id = ((await job2.json()) as { job: { id: string } }).job.id
    await claimEvalJob({ ownerId: 'worker-b', leaseMs: 1 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    await query(
      `UPDATE tutorial_eval_jobs SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1::bigint`,
      [job2Id],
    )
    const recovered = await recoverExpiredEvalLeases()
    assert.ok(recovered >= 1)
    const reclaimed = await claimEvalJob({ ownerId: 'worker-c', leaseMs: 60_000 })
    assert.equal(reclaimed?.id, job2Id)
    assert.ok(reclaimed!.attempt >= 2)
  })
})
