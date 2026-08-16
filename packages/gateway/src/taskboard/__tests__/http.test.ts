/**
 * Taskboard HTTP 层单测。库文件落 os.tmpdir(),跑完删除,绝不碰真实 ~/.openclaude。
 *
 * Run: npx tsx --test packages/gateway/src/taskboard/__tests__/http.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { signJwt } from '../../auth.js'
import { type TaskboardDb, openTaskboardDb } from '../db/index.js'
import { listPipelines, listStages } from '../db/pipelines.js'
import { type TaskboardHttpContext, handleTaskboardApi, resolveTaskboardActor } from '../http.js'

const dirs: string[] = []

function freshDb(): TaskboardDb {
  const dir = mkdtempSync(join(tmpdir(), 'oc-tb-http-'))
  dirs.push(dir)
  return openTaskboardDb(join(dir, 'taskboard.db'))
}

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

interface JsonRes {
  status: number
  body: Record<string, unknown>
}

async function withServer(
  ctx: TaskboardHttpContext,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((req, res) => {
    handleTaskboardApi(req, res, ctx)
      .then((handled) => {
        if (!handled && !res.headersSent) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'not found', code: 'not_found' }))
        }
      })
      .catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'internal error' }))
        }
        void err
      })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
    })
  }
}

async function call(base: string, method: string, path: string, body?: unknown): Promise<JsonRes> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: Record<string, unknown> = {}
  if (text) {
    parsed = JSON.parse(text) as Record<string, unknown>
  }
  return { status: res.status, body: parsed }
}

function humanCtx(db: TaskboardDb): TaskboardHttpContext {
  return {
    db,
    actor: 'human',
    listAgents: async () => [
      { id: 'main', name: '主助手', model: 'x', description: '' },
      { id: 'coding-assistant', name: '编码', model: 'x', description: '' },
      { id: 'hidden-reviewer', name: '隐藏审查员', model: 'x', description: '不可见' },
    ],
  }
}

function agentCtx(db: TaskboardDb): TaskboardHttpContext {
  return { ...humanCtx(db), actor: 'agent' }
}

async function seedProject(
  base: string,
): Promise<{ projectId: string; ticket: Record<string, unknown> }> {
  const created = await call(base, 'POST', '/api/board/projects', {
    key: 'OCV5',
    name: 'V5 自用',
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const project = created.body.project as { id: string }
  const ticketRes = await call(base, 'POST', '/api/board/tickets', {
    projectId: project.id,
    type: 'bug',
    title: '登录 500',
  })
  assert.equal(ticketRes.status, 201, JSON.stringify(ticketRes.body))
  return { projectId: project.id, ticket: ticketRes.body.ticket as Record<string, unknown> }
}

describe('404 / 400 / 405 基本形状', () => {
  it('未知子路径 404,错误形状带 code', async () => {
    const db = freshDb()
    await withServer(humanCtx(db), async (base) => {
      const res = await call(base, 'GET', '/api/board/nope')
      assert.equal(res.status, 404)
      assert.equal(res.body.error, 'not found')
      assert.equal(res.body.code, 'not_found')
    })
    db.close()
  })

  it('方法不对 405', async () => {
    const db = freshDb()
    await withServer(humanCtx(db), async (base) => {
      const res = await call(base, 'PUT', '/api/board/projects')
      assert.equal(res.status, 405)
      assert.equal(res.body.error, 'method not allowed')
    })
    db.close()
  })

  it('坏 JSON 400;缺字段 400 validation', async () => {
    const db = freshDb()
    await withServer(humanCtx(db), async (base) => {
      const bad = await fetch(`${base}/api/board/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not-json',
      })
      assert.equal(bad.status, 400)
      assert.equal(((await bad.json()) as { error: string }).error, 'invalid JSON')

      const missing = await call(base, 'POST', '/api/board/tickets', { type: 'bug' })
      assert.equal(missing.status, 400)
      assert.equal(missing.body.code, 'validation')
    })
    db.close()
  })

  it('未初始化库 503', async () => {
    await withServer({ db: null, actor: 'human' }, async (base) => {
      const res = await call(base, 'GET', '/api/board/projects')
      assert.equal(res.status, 503)
      assert.equal(res.body.error, 'taskboard not initialized')
    })
  })

  it('非 /api/board 前缀返回 false', async () => {
    const db = freshDb()
    let handled: boolean | undefined
    const server = createServer((req, res) => {
      handleTaskboardApi(req, res, humanCtx(db)).then((h) => {
        handled = h
        if (!h) {
          res.writeHead(299)
          res.end('{}')
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/cron`)
      assert.equal(res.status, 299)
      assert.equal(handled, false)
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      })
      db.close()
    }
  })
})

describe('建项目自动 seed / 建单挂默认流水线', () => {
  it('POST 项目后已有四条默认流水线', async () => {
    const db = freshDb()
    await withServer(humanCtx(db), async (base) => {
      const created = await call(base, 'POST', '/api/board/projects', {
        key: 'ocv5',
        name: 'V5',
      })
      assert.equal(created.status, 201)
      const project = created.body.project as { id: string; key: string }
      assert.equal(project.key, 'OCV5')
      const pipes = await call(base, 'GET', `/api/board/pipelines?projectId=${project.id}`)
      assert.equal(pipes.status, 200)
      const items = pipes.body.items as { ticketType: string; isDefault: boolean }[]
      assert.equal(items.length, 4)
      assert.deepEqual(items.map((p) => p.ticketType).sort(), ['bug', 'chore', 'feature', 'spike'])
      assert.ok(items.every((p) => p.isDefault))
      assert.equal(listPipelines(db, project.id).length, 4)
    })
    db.close()
  })

  it('建单未传 pipelineId 时挂默认线与第一站', async () => {
    const db = freshDb()
    await withServer(humanCtx(db), async (base) => {
      const { projectId, ticket } = await seedProject(base)
      const pipes = listPipelines(db, projectId)
      const bug = pipes.find((p) => p.ticketType === 'bug')
      assert.ok(bug)
      const first = listStages(db, bug.id)[0]
      assert.ok(first)
      assert.equal(ticket.pipelineId, bug.id)
      assert.equal(ticket.stageId, first.id)
      assert.equal(ticket.status, 'backlog')
      assert.equal(ticket.identifier, 'OCV5-1')
      assert.equal(typeof ticket.version, 'number')
    })
    db.close()
  })
})

describe('状态机越权 403', () => {
  it('agent 调 POST …/done → 403;agent 调 POST …/ready → 403', async () => {
    const db = freshDb()
    let ticketId = ''
    let version = 0
    await withServer(humanCtx(db), async (base) => {
      const seeded = await seedProject(base)
      ticketId = seeded.ticket.id as string
      version = seeded.ticket.version as number
    })
    await withServer(agentCtx(db), async (base) => {
      const ready = await call(base, 'POST', `/api/board/tickets/${ticketId}/ready`, {
        expectedVersion: version,
      })
      assert.equal(ready.status, 403, JSON.stringify(ready.body))
      assert.equal(ready.body.error, 'forbidden')
      assert.equal(ready.body.code, 'forbidden')

      const done = await call(base, 'POST', `/api/board/tickets/${ticketId}/done`, {
        expectedVersion: version,
      })
      assert.equal(done.status, 403, JSON.stringify(done.body))
      assert.equal(done.body.error, 'forbidden')
      assert.equal(done.body.code, 'forbidden')
    })
    db.close()
  })
})

describe('乐观锁 409', () => {
  it('过期 expectedVersion → 409 version_conflict', async () => {
    const db = freshDb()
    await withServer(humanCtx(db), async (base) => {
      const { ticket } = await seedProject(base)
      const res = await call(base, 'PATCH', `/api/board/tickets/${ticket.identifier}`, {
        expectedVersion: 0,
        title: '过期写',
      })
      assert.equal(res.status, 409)
      assert.equal(res.body.code, 'version_conflict')
      assert.equal(res.body.expectedVersion, 0)
      assert.equal(res.body.actualVersion, ticket.version)
    })
    db.close()
  })
})

describe('lease 423', () => {
  it('重复 claim → 423 lease_held', async () => {
    const db = freshDb()
    let ident = ''
    let version = 0
    await withServer(humanCtx(db), async (base) => {
      const seeded = await seedProject(base)
      ident = seeded.ticket.identifier as string
      version = seeded.ticket.version as number
      const ready = await call(base, 'POST', `/api/board/tickets/${ident}/ready`, {
        expectedVersion: version,
      })
      assert.equal(ready.status, 200, JSON.stringify(ready.body))
      version = (ready.body.ticket as { version: number }).version
    })
    await withServer(agentCtx(db), async (base) => {
      const first = await call(base, 'POST', `/api/board/tickets/${ident}/claim`, {
        expectedVersion: version,
        owner: 'agent:coding-assistant',
      })
      assert.equal(first.status, 200, JSON.stringify(first.body))
      const nextVersion = (first.body.ticket as { version: number }).version
      const second = await call(base, 'POST', `/api/board/tickets/${ident}/claim`, {
        expectedVersion: nextVersion,
        owner: 'agent:explorer',
      })
      assert.equal(second.status, 423, JSON.stringify(second.body))
      assert.equal(second.body.code, 'lease_held')
      assert.equal(second.body.error, 'lease held')
    })
    db.close()
  })
})

describe('GET /agents 排除 hidden-reviewer', () => {
  it('列表不含 hidden-reviewer', async () => {
    const db = freshDb()
    await withServer(humanCtx(db), async (base) => {
      const res = await call(base, 'GET', '/api/board/agents')
      assert.equal(res.status, 200)
      const items = res.body.items as { id: string }[]
      assert.ok(items.some((a) => a.id === 'main'))
      assert.ok(items.some((a) => a.id === 'coding-assistant'))
      assert.ok(!items.some((a) => a.id === 'hidden-reviewer'))
    })
    db.close()
  })
})

describe('actor 判定', () => {
  it('浏览器 JWT → human;raw token / 无 JWT → agent', () => {
    const secret = 'test-jwt-secret'
    const jwt = signJwt({ userId: 'default', exp: Math.floor(Date.now() / 1000) + 3600 }, secret)
    const fakeReq = (headers: Record<string, string>) =>
      ({ headers }) as unknown as import('node:http').IncomingMessage
    assert.equal(
      resolveTaskboardActor(fakeReq({ authorization: `Bearer ${jwt}` }), { jwtSecret: secret }),
      'human',
    )
    assert.equal(
      resolveTaskboardActor(fakeReq({ authorization: 'Bearer deadbeefdeadbeef' }), {
        jwtSecret: secret,
      }),
      'agent',
    )
  })

  it('提权回归:伪造 bridge 头不得升成 human,只认已校验的 bridgeVerified', () => {
    const secret = 'test-jwt-secret'
    const fakeReq = (headers: Record<string, string>) =>
      ({ headers }) as unknown as import('node:http').IncomingMessage
    // 容器内 agent 可以任意设置请求头。哪怕伪造出形态完全合法的 64 位 hex nonce,
    // 也必须仍是 agent —— 真正的校验(源 IP + container-id + timingSafeEqual)在
    // server.ts checkBridgeBypass(),其结论经 bridgeVerified 传入。
    for (const forged of ['ab'.repeat(32), 'x', '1']) {
      assert.equal(
        resolveTaskboardActor(fakeReq({ 'x-openclaude-bridge-nonce': forged }), {
          jwtSecret: secret,
        }),
        'agent',
        `伪造 nonce "${forged}" 不应被判成 human`,
      )
    }
    // 只有 server.ts 校验通过后显式传入 true,才认成浏览器经 master 代理进来的请求。
    assert.equal(
      resolveTaskboardActor(fakeReq({ 'x-openclaude-bridge-nonce': 'ab'.repeat(32) }), {
        jwtSecret: secret,
        bridgeVerified: true,
      }),
      'human',
    )
  })

  it('不信 body.actor:agent 自称 human 仍 403', async () => {
    const db = freshDb()
    let ident = ''
    let version = 0
    await withServer(humanCtx(db), async (base) => {
      const seeded = await seedProject(base)
      ident = seeded.ticket.identifier as string
      version = seeded.ticket.version as number
    })
    await withServer(agentCtx(db), async (base) => {
      const res = await call(base, 'POST', `/api/board/tickets/${ident}/done`, {
        expectedVersion: version,
        actor: 'human',
      })
      assert.equal(res.status, 403)
      assert.equal(res.body.code, 'forbidden')
    })
    db.close()
  })
})

describe('settings / 超大 body', () => {
  it('GET settings 带 usage;agent PATCH 403', async () => {
    const db = freshDb()
    await withServer(humanCtx(db), async (base) => {
      const res = await call(base, 'GET', '/api/board/settings')
      assert.equal(res.status, 200)
      assert.equal(res.body.maxConcurrentRuns, 2)
      assert.ok(
        res.body.usage && typeof (res.body.usage as { runsToday: number }).runsToday === 'number',
      )
      const patched = await call(base, 'PATCH', '/api/board/settings', { patrolPaused: true })
      assert.equal(patched.status, 200)
      assert.equal(patched.body.patrolPaused, true)
    })
    await withServer(agentCtx(db), async (base) => {
      const res = await call(base, 'PATCH', '/api/board/settings', { patrolPaused: false })
      assert.equal(res.status, 403)
    })
    db.close()
  })

  it('超大 body → 413', async () => {
    const db = freshDb()
    await withServer(humanCtx(db), async (base) => {
      const huge = { title: 'x'.repeat(512 * 1024 + 64), projectId: 'p', type: 'bug' }
      const res = await fetch(`${base}/api/board/tickets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(huge),
      })
      assert.equal(res.status, 413)
      assert.equal(((await res.json()) as { error: string }).error, 'payload too large')
    })
    db.close()
  })
})
