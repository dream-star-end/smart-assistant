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
import { listComments } from '../db/comments.js'
import { type TaskboardDb, openTaskboardDb } from '../db/index.js'
import { listPipelines, listStages } from '../db/pipelines.js'
import { updateTicket } from '../db/tickets.js'
import {
  type TaskboardHttpContext,
  handleTaskboardApi,
  resolveTaskboardActor,
  resolveTaskboardActorId,
} from '../http.js'

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

type PipelineJson = {
  id: string
  name: string
  ticketType: string | null
  isDefault: boolean
}

type StageJson = {
  id: string
  pipelineId: string
  ordinal: number
  name: string
  kind: string
  agentId: string | null
  promptTemplate: string | null
  patrolCron: string | null
  patrolEnabled: boolean
  entryCondition: string | null
  autoClose: boolean
  timeoutSec: number
}

async function createProjectOnly(base: string): Promise<string> {
  const created = await call(base, 'POST', '/api/board/projects', {
    key: 'OCV5',
    name: 'V5 自用',
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  return (created.body.project as { id: string }).id
}

async function createEmptyPipeline(
  base: string,
  projectId: string,
  over: Record<string, unknown> = {},
): Promise<PipelineJson> {
  const res = await call(base, 'POST', '/api/board/pipelines', {
    projectId,
    name: 'hotfix',
    ticketType: 'bug',
    isDefault: false,
    ...over,
  })
  assert.equal(res.status, 201, JSON.stringify(res.body))
  return res.body.pipeline as PipelineJson
}

describe('POST /pipelines 建线', () => {
  it('建线成功,回 201 且可 GET 到', async () => {
    const db = freshDb()
    await withServer(humanCtx(db), async (base) => {
      const projectId = await createProjectOnly(base)
      const res = await call(base, 'POST', '/api/board/pipelines', {
        projectId,
        name: 'hotfix',
        ticketType: 'bug',
        isDefault: false,
      })
      assert.equal(res.status, 201, JSON.stringify(res.body))
      assert.equal(res.body.ok, true)
      const pipeline = res.body.pipeline as PipelineJson
      assert.equal(pipeline.name, 'hotfix')
      assert.equal(pipeline.ticketType, 'bug')
      assert.equal(pipeline.isDefault, false)
      assert.equal(typeof pipeline.id, 'string')

      const got = await call(base, 'GET', `/api/board/pipelines/${pipeline.id}`)
      assert.equal(got.status, 200)
      assert.equal((got.body.pipeline as PipelineJson).id, pipeline.id)
      assert.deepEqual(got.body.stages, [])
    })
    db.close()
  })

  it('缺 projectId / name → 400 validation', async () => {
    const db = freshDb()
    await withServer(humanCtx(db), async (base) => {
      const projectId = await createProjectOnly(base)
      const noName = await call(base, 'POST', '/api/board/pipelines', {
        projectId,
        ticketType: 'bug',
      })
      assert.equal(noName.status, 400, JSON.stringify(noName.body))
      assert.equal(noName.body.code, 'validation')

      const noProject = await call(base, 'POST', '/api/board/pipelines', {
        name: 'hotfix',
        ticketType: 'bug',
      })
      assert.equal(noProject.status, 400, JSON.stringify(noProject.body))
      assert.equal(noProject.body.code, 'validation')
    })
    db.close()
  })

  it('不存在的 projectId → 404', async () => {
    const db = freshDb()
    await withServer(humanCtx(db), async (base) => {
      const res = await call(base, 'POST', '/api/board/pipelines', {
        projectId: 'no-such-project',
        name: 'hotfix',
      })
      assert.equal(res.status, 404, JSON.stringify(res.body))
      assert.equal(res.body.code, 'not_found')
    })
    db.close()
  })
})

describe('POST /pipelines/:id/stages 建站与 ordinal', () => {
  it('未传 ordinal 时按现有站数追加(0, 1);显式 ordinal 生效', async () => {
    const db = freshDb()
    await withServer(humanCtx(db), async (base) => {
      const projectId = await createProjectOnly(base)
      const pipeline = await createEmptyPipeline(base, projectId)

      const first = await call(base, 'POST', `/api/board/pipelines/${pipeline.id}/stages`, {
        name: '实现',
        kind: 'ai',
        agentId: 'coding-assistant',
        promptTemplate: '修这个 bug',
      })
      assert.equal(first.status, 201, JSON.stringify(first.body))
      const s0 = first.body.stage as StageJson
      assert.equal(s0.ordinal, 0)
      assert.equal(s0.kind, 'ai')
      assert.equal(s0.agentId, 'coding-assistant')
      assert.equal(s0.pipelineId, pipeline.id)

      const second = await call(base, 'POST', `/api/board/pipelines/${pipeline.id}/stages`, {
        name: '确认',
        kind: 'human',
      })
      assert.equal(second.status, 201, JSON.stringify(second.body))
      assert.equal((second.body.stage as StageJson).ordinal, 1)

      const explicit = await call(base, 'POST', `/api/board/pipelines/${pipeline.id}/stages`, {
        name: '收尾',
        kind: 'human',
        ordinal: 5,
      })
      assert.equal(explicit.status, 201, JSON.stringify(explicit.body))
      assert.equal((explicit.body.stage as StageJson).ordinal, 5)

      const dup = await call(base, 'POST', `/api/board/pipelines/${pipeline.id}/stages`, {
        name: '撞号',
        kind: 'human',
        ordinal: 0,
      })
      assert.equal(dup.status, 400, JSON.stringify(dup.body))
      assert.equal(dup.body.code, 'validation')
      assert.match(String(dup.body.error), /ordinal/)
    })
    db.close()
  })

  it('缺 name / kind → 400;不存在的 pipelineId → 404', async () => {
    const db = freshDb()
    await withServer(humanCtx(db), async (base) => {
      const projectId = await createProjectOnly(base)
      const pipeline = await createEmptyPipeline(base, projectId)

      const missing = await call(base, 'POST', `/api/board/pipelines/${pipeline.id}/stages`, {
        kind: 'human',
      })
      assert.equal(missing.status, 400, JSON.stringify(missing.body))
      assert.equal(missing.body.code, 'validation')

      const noKind = await call(base, 'POST', `/api/board/pipelines/${pipeline.id}/stages`, {
        name: '确认',
      })
      assert.equal(noKind.status, 400, JSON.stringify(noKind.body))
      assert.equal(noKind.body.code, 'validation')

      const missingPipe = await call(base, 'POST', '/api/board/pipelines/no-such-pipe/stages', {
        name: '确认',
        kind: 'human',
      })
      assert.equal(missingPipe.status, 404, JSON.stringify(missingPipe.body))
      assert.equal(missingPipe.body.code, 'not_found')
    })
    db.close()
  })
})

describe('PATCH /stages/:id 可写字段', () => {
  it('能改 agentId / promptTemplate / patrolCron / entryCondition / autoClose / timeoutSec', async () => {
    const db = freshDb()
    await withServer(humanCtx(db), async (base) => {
      const projectId = await createProjectOnly(base)
      const pipeline = await createEmptyPipeline(base, projectId)
      const created = await call(base, 'POST', `/api/board/pipelines/${pipeline.id}/stages`, {
        name: '实现',
        kind: 'ai',
        agentId: 'main',
        promptTemplate: '初稿',
      })
      assert.equal(created.status, 201, JSON.stringify(created.body))
      const stageId = (created.body.stage as StageJson).id

      const patched = await call(base, 'PATCH', `/api/board/stages/${stageId}`, {
        agentId: 'coding-assistant',
        promptTemplate: '按复现步骤修',
        patrolCron: '0 9 * * *',
        entryCondition: 'no_open_blockers',
        autoClose: true,
        timeoutSec: 1800,
      })
      assert.equal(patched.status, 200, JSON.stringify(patched.body))
      const stage = patched.body.stage as StageJson
      assert.equal(stage.agentId, 'coding-assistant')
      assert.equal(stage.promptTemplate, '按复现步骤修')
      assert.equal(stage.patrolCron, '0 9 * * *')
      assert.equal(stage.entryCondition, 'no_open_blockers')
      assert.equal(stage.autoClose, true)
      assert.equal(stage.timeoutSec, 1800)
    })
    db.close()
  })
})

describe('stage 写路径校验', () => {
  it('绑定 hidden-reviewer → 400', async () => {
    const db = freshDb()
    await withServer(humanCtx(db), async (base) => {
      const projectId = await createProjectOnly(base)
      const pipeline = await createEmptyPipeline(base, projectId)
      const created = await call(base, 'POST', `/api/board/pipelines/${pipeline.id}/stages`, {
        name: '审查',
        kind: 'ai',
        agentId: 'hidden-reviewer',
        promptTemplate: '审',
      })
      assert.equal(created.status, 400, JSON.stringify(created.body))
      assert.equal(created.body.code, 'validation')
      assert.match(String(created.body.error), /hidden-reviewer/)

      const ok = await call(base, 'POST', `/api/board/pipelines/${pipeline.id}/stages`, {
        name: '实现',
        kind: 'ai',
        agentId: 'coding-assistant',
        promptTemplate: '修',
      })
      assert.equal(ok.status, 201, JSON.stringify(ok.body))
      const patched = await call(
        base,
        'PATCH',
        `/api/board/stages/${(ok.body.stage as StageJson).id}`,
        {
          agentId: 'hidden-reviewer',
        },
      )
      assert.equal(patched.status, 400, JSON.stringify(patched.body))
      assert.equal(patched.body.code, 'validation')
    })
    db.close()
  })

  it('kind=human 且 patrolEnabled=true → 400', async () => {
    const db = freshDb()
    await withServer(humanCtx(db), async (base) => {
      const projectId = await createProjectOnly(base)
      const pipeline = await createEmptyPipeline(base, projectId)
      const created = await call(base, 'POST', `/api/board/pipelines/${pipeline.id}/stages`, {
        name: '确认',
        kind: 'human',
        patrolEnabled: true,
      })
      assert.equal(created.status, 400, JSON.stringify(created.body))
      assert.equal(created.body.code, 'validation')
      assert.match(String(created.body.error), /human/i)

      const human = await call(base, 'POST', `/api/board/pipelines/${pipeline.id}/stages`, {
        name: '确认',
        kind: 'human',
      })
      assert.equal(human.status, 201, JSON.stringify(human.body))
      const patched = await call(
        base,
        'PATCH',
        `/api/board/stages/${(human.body.stage as StageJson).id}`,
        { patrolEnabled: true },
      )
      assert.equal(patched.status, 400, JSON.stringify(patched.body))
      assert.equal(patched.body.code, 'validation')
    })
    db.close()
  })

  it('timeoutSec 超过 delegate 硬超时 2700 → 400;2700 边界可通过', async () => {
    const db = freshDb()
    await withServer(humanCtx(db), async (base) => {
      const projectId = await createProjectOnly(base)
      const pipeline = await createEmptyPipeline(base, projectId)
      const over = await call(base, 'POST', `/api/board/pipelines/${pipeline.id}/stages`, {
        name: '实现',
        kind: 'ai',
        agentId: 'coding-assistant',
        promptTemplate: '修',
        timeoutSec: 2701,
      })
      assert.equal(over.status, 400, JSON.stringify(over.body))
      assert.equal(over.body.code, 'validation')
      assert.match(String(over.body.error), /2700/)

      const atCap = await call(base, 'POST', `/api/board/pipelines/${pipeline.id}/stages`, {
        name: '实现',
        kind: 'ai',
        agentId: 'coding-assistant',
        promptTemplate: '修',
        timeoutSec: 2700,
      })
      assert.equal(atCap.status, 201, JSON.stringify(atCap.body))
      assert.equal((atCap.body.stage as StageJson).timeoutSec, 2700)

      const patched = await call(
        base,
        'PATCH',
        `/api/board/stages/${(atCap.body.stage as StageJson).id}`,
        { timeoutSec: 2701 },
      )
      assert.equal(patched.status, 400, JSON.stringify(patched.body))
      assert.equal(patched.body.code, 'validation')
    })
    db.close()
  })

  // BUG-1: validateStageWrite 只拦 patrolEnabled,不拦 patrolCron。human+cron 会 201 入库。
  it('kind=human 带 patrolCron → 400', async () => {
    const db = freshDb()
    await withServer(humanCtx(db), async (base) => {
      const projectId = await createProjectOnly(base)
      const pipeline = await createEmptyPipeline(base, projectId)
      const created = await call(base, 'POST', `/api/board/pipelines/${pipeline.id}/stages`, {
        name: '确认',
        kind: 'human',
        patrolCron: '0 9 * * *',
      })
      assert.equal(created.status, 400, JSON.stringify(created.body))
      assert.equal(created.body.code, 'validation')

      const human = await call(base, 'POST', `/api/board/pipelines/${pipeline.id}/stages`, {
        name: '确认',
        kind: 'human',
      })
      assert.equal(human.status, 201, JSON.stringify(human.body))
      const patchedCron = await call(
        base,
        'PATCH',
        `/api/board/stages/${(human.body.stage as StageJson).id}`,
        { patrolCron: '0 9 * * *' },
      )
      assert.equal(patchedCron.status, 400, JSON.stringify(patchedCron.body))
      assert.equal(patchedCron.body.code, 'validation')

      const ai = await call(base, 'POST', `/api/board/pipelines/${pipeline.id}/stages`, {
        name: '实现',
        kind: 'ai',
        agentId: 'coding-assistant',
        promptTemplate: '修',
        patrolCron: '0 9 * * *',
        patrolEnabled: false,
      })
      assert.equal(ai.status, 201, JSON.stringify(ai.body))
      const patchedKind = await call(
        base,
        'PATCH',
        `/api/board/stages/${(ai.body.stage as StageJson).id}`,
        { kind: 'human' },
      )
      assert.equal(patchedKind.status, 400, JSON.stringify(patchedKind.body))
      assert.equal(patchedKind.body.code, 'validation')
    })
    db.close()
  })

  // BUG-2: handleCreateStage/handlePatchStage 未调用 parseEntryCondition,非法 DSL 原样入库。
  it('非法 entryCondition DSL → 400 且错误可读', async () => {
    const db = freshDb()
    await withServer(humanCtx(db), async (base) => {
      const projectId = await createProjectOnly(base)
      const pipeline = await createEmptyPipeline(base, projectId)
      const created = await call(base, 'POST', `/api/board/pipelines/${pipeline.id}/stages`, {
        name: '实现',
        kind: 'ai',
        agentId: 'coding-assistant',
        promptTemplate: '修',
        entryCondition: 'has_repro',
      })
      assert.equal(created.status, 400, JSON.stringify(created.body))
      assert.equal(created.body.code, 'validation')
      assert.match(String(created.body.error), /未知谓词|不能识别|不完整|谓词/)

      const ok = await call(base, 'POST', `/api/board/pipelines/${pipeline.id}/stages`, {
        name: '实现2',
        kind: 'ai',
        agentId: 'coding-assistant',
        promptTemplate: '修',
      })
      assert.equal(ok.status, 201, JSON.stringify(ok.body))
      const patched = await call(
        base,
        'PATCH',
        `/api/board/stages/${(ok.body.stage as StageJson).id}`,
        { entryCondition: 'always &&' },
      )
      assert.equal(patched.status, 400, JSON.stringify(patched.body))
      assert.match(String(patched.body.error), /不完整|谓词|不能识别/)
    })
    db.close()
  })

  it('PATCH 不存在的 stage → 404', async () => {
    const db = freshDb()
    await withServer(humanCtx(db), async (base) => {
      const res = await call(base, 'PATCH', '/api/board/stages/no-such-stage', {
        name: 'x',
      })
      assert.equal(res.status, 404, JSON.stringify(res.body))
      assert.equal(res.body.code, 'not_found')
    })
    db.close()
  })
})

describe('isDefault 互斥经 HTTP 生效', () => {
  it('同项目同 ticketType 把 B 设为默认后 A 自动降为非默认', async () => {
    const db = freshDb()
    await withServer(humanCtx(db), async (base) => {
      const projectId = await createProjectOnly(base)
      const listed = await call(base, 'GET', `/api/board/pipelines?projectId=${projectId}`)
      assert.equal(listed.status, 200)
      const seedBug = (listed.body.items as PipelineJson[]).find(
        (p) => p.ticketType === 'bug' && p.isDefault,
      )
      assert.ok(seedBug)
      const seedFeature = (listed.body.items as PipelineJson[]).find(
        (p) => p.ticketType === 'feature' && p.isDefault,
      )
      assert.ok(seedFeature)

      const createdB = await call(base, 'POST', '/api/board/pipelines', {
        projectId,
        name: 'bug-b',
        ticketType: 'bug',
        isDefault: false,
      })
      assert.equal(createdB.status, 201, JSON.stringify(createdB.body))
      const pipeB = createdB.body.pipeline as PipelineJson
      assert.equal(pipeB.isDefault, false)

      const patched = await call(base, 'PATCH', `/api/board/pipelines/${pipeB.id}`, {
        isDefault: true,
      })
      assert.equal(patched.status, 200, JSON.stringify(patched.body))
      assert.equal((patched.body.pipeline as PipelineJson).isDefault, true)

      const after = await call(base, 'GET', `/api/board/pipelines?projectId=${projectId}`)
      const items = after.body.items as PipelineJson[]
      const a = items.find((p) => p.id === seedBug.id)
      const b = items.find((p) => p.id === pipeB.id)
      const feature = items.find((p) => p.id === seedFeature.id)
      assert.equal(a?.isDefault, false, '原 bug 默认线应被降')
      assert.equal(b?.isDefault, true)
      assert.equal(feature?.isDefault, true, '不同类型默认线不受影响')
    })
    db.close()
  })

  it('POST 直接 isDefault=true 也会把同类型原默认线降掉', async () => {
    const db = freshDb()
    await withServer(humanCtx(db), async (base) => {
      const projectId = await createProjectOnly(base)
      const listed = await call(base, 'GET', `/api/board/pipelines?projectId=${projectId}`)
      const seedBug = (listed.body.items as PipelineJson[]).find(
        (p) => p.ticketType === 'bug' && p.isDefault,
      )
      assert.ok(seedBug)

      const created = await call(base, 'POST', '/api/board/pipelines', {
        projectId,
        name: 'bug-new-default',
        ticketType: 'bug',
        isDefault: true,
      })
      assert.equal(created.status, 201, JSON.stringify(created.body))
      assert.equal((created.body.pipeline as PipelineJson).isDefault, true)

      const after = await call(base, 'GET', `/api/board/pipelines?projectId=${projectId}`)
      const items = after.body.items as PipelineJson[]
      assert.equal(items.find((p) => p.id === seedBug.id)?.isDefault, false)
      assert.equal(
        items.find((p) => p.id === (created.body.pipeline as PipelineJson).id)?.isDefault,
        true,
      )
    })
    db.close()
  })
})

describe('advance 换站清零 stageLoopCount', () => {
  it('agent 自己 advance 到下一站时 stageLoopCount 归零,作者带上 stage agent', async () => {
    const db = freshDb()
    let ident = ''
    let version = 0
    let nextStageId = ''
    await withServer(humanCtx(db), async (base) => {
      const created = await call(base, 'POST', '/api/board/projects', {
        key: 'OCV5',
        name: 'V5 自用',
      })
      const projectId = (created.body.project as { id: string }).id
      const ticketRes = await call(base, 'POST', '/api/board/tickets', {
        projectId,
        type: 'feature',
        title: '换站清零',
      })
      assert.equal(ticketRes.status, 201, JSON.stringify(ticketRes.body))
      const ticket = ticketRes.body.ticket as {
        identifier: string
        version: number
        id: string
        stageId: string
        pipelineId: string
      }
      ident = ticket.identifier
      const stages = listStages(db, ticket.pipelineId)
      nextStageId = stages.find((s) => s.ordinal === 1)?.id ?? ''
      const bumped = updateTicket(db, ticket.id, ticket.version, { stageLoopCount: 3 })
      version = bumped.version
      const ready = await call(base, 'POST', `/api/board/tickets/${ident}/ready`, {
        expectedVersion: version,
      })
      assert.equal(ready.status, 200, JSON.stringify(ready.body))
      version = (ready.body.ticket as { version: number }).version
    })
    await withServer(agentCtx(db), async (base) => {
      const claimed = await call(base, 'POST', `/api/board/tickets/${ident}/claim`, {
        expectedVersion: version,
        owner: 'agent:general-assistant',
      })
      assert.equal(claimed.status, 200, JSON.stringify(claimed.body))
      version = (claimed.body.ticket as { version: number }).version
      const adv = await call(base, 'POST', `/api/board/tickets/${ident}/advance`, {
        expectedVersion: version,
        summary: '澄清完成',
        owner: 'agent:general-assistant',
      })
      assert.equal(adv.status, 200, JSON.stringify(adv.body))
      const after = adv.body.ticket as {
        stageLoopCount: number
        stageId: string
        status: string
        id: string
      }
      assert.equal(after.stageLoopCount, 0)
      assert.equal(after.stageId, nextStageId)
      assert.equal(after.status, 'ready')
      const comments = listComments(db, after.id)
      assert.ok(
        comments.some((c) => c.author === 'agent:general-assistant' && c.body.includes('澄清完成')),
      )
    })
    db.close()
  })
})

describe('agent 身份回落', () => {
  it('resolveTaskboardActorId: 显式 owner / stage / unidentified,不再用 unknown', () => {
    const prevA = process.env.OPENCLAUDE_AGENT_ID
    const prevB = process.env.OC_AGENT_ID
    process.env.OPENCLAUDE_AGENT_ID = ''
    process.env.OC_AGENT_ID = ''
    try {
      assert.equal(resolveTaskboardActorId('human'), 'user:default')
      assert.equal(resolveTaskboardActorId('agent', 'agent:explorer'), 'agent:explorer')
      assert.equal(
        resolveTaskboardActorId('agent', null, 'coding-assistant'),
        'agent:coding-assistant',
      )
      assert.equal(resolveTaskboardActorId('agent'), 'agent:unidentified')
      assert.notEqual(resolveTaskboardActorId('agent'), 'agent:unknown')
    } finally {
      if (prevA !== undefined) process.env.OPENCLAUDE_AGENT_ID = prevA
      else process.env.OPENCLAUDE_AGENT_ID = ''
      if (prevB !== undefined) process.env.OC_AGENT_ID = prevB
      else process.env.OC_AGENT_ID = ''
    }
  })

  it('评论不带 author 时用当前 stage 绑定的 agentId', async () => {
    const db = freshDb()
    let ident = ''
    await withServer(humanCtx(db), async (base) => {
      const seeded = await seedProject(base)
      ident = seeded.ticket.identifier as string
    })
    await withServer(agentCtx(db), async (base) => {
      const res = await call(base, 'POST', `/api/board/tickets/${ident}/comment`, {
        body: '定位中',
      })
      assert.equal(res.status, 200, JSON.stringify(res.body))
      const comment = res.body.comment as { author: string }
      assert.match(comment.author, /^agent:/)
      assert.notEqual(comment.author, 'agent:unknown')
    })
    db.close()
  })
})
