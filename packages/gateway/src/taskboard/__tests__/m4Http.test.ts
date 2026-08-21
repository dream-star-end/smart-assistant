/**
 * M4 HTTP:成本统计 / 周报 / 流水线模板路由形状。
 *
 * Run: npx tsx --test packages/gateway/src/taskboard/__tests__/m4Http.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { type TaskboardDb, openTaskboardDb } from '../db/index.js'
import { listPipelines } from '../db/pipelines.js'
import { insertRun, updateRun } from '../db/runs.js'
import { type TaskboardHttpContext, handleTaskboardApi } from '../http.js'
import { zonedYmd } from '../notify.js'

const dirs: string[] = []

function freshDb(): TaskboardDb {
  const dir = mkdtempSync(join(tmpdir(), 'oc-tb-m4http-'))
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
  return { db, actor: 'human' }
}

describe('成本统计 HTTP', () => {
  it('GET /api/board/stats/cost 区分 priced 与 unpriced', async () => {
    const db = freshDb()
    await withServer(humanCtx(db), async (base) => {
      const created = await call(base, 'POST', '/api/board/projects', {
        key: 'COST',
        name: '成本',
        templateIds: ['builtin:chore'],
      })
      assert.equal(created.status, 201, JSON.stringify(created.body))
      const project = created.body.project as { id: string }
      const ticketRes = await call(base, 'POST', '/api/board/tickets', {
        projectId: project.id,
        type: 'chore',
        title: '用量',
      })
      const ticket = ticketRes.body.ticket as { id: string }
      const pipes = listPipelines(db, project.id)
      const listed = await call(base, 'GET', `/api/board/pipelines/${pipes[0].id}/stages`)
      const stageItems = listed.body.items as { id: string }[]
      const stageId = stageItems[0].id
      const priced = insertRun(db, {
        ticketId: ticket.id,
        stageId,
        trigger: 'manual',
        status: 'queued',
      })
      updateRun(db, priced.id, {
        status: 'succeeded',
        tokensIn: 100,
        tokensOut: 20,
        costUsd: 0.2,
      })
      const unpriced = insertRun(db, {
        ticketId: ticket.id,
        stageId,
        trigger: 'manual',
        status: 'queued',
      })
      updateRun(db, unpriced.id, {
        status: 'succeeded',
        tokensIn: 97419,
        tokensOut: 8532,
        costUsd: 0,
      })
      const today = zonedYmd(new Date())
      const res = await call(
        base,
        'GET',
        `/api/board/stats/cost?from=${today}&to=${today}&groupBy=ticket`,
      )
      assert.equal(res.status, 200, JSON.stringify(res.body))
      const totals = res.body.totals as {
        coverage: string
        costUsd: number
        unpriced: { runCount: number; tokensIn: number }
      }
      assert.equal(totals.coverage, 'partial')
      assert.equal(totals.costUsd, 0.2)
      assert.equal(totals.unpriced.runCount, 1)
      assert.equal(totals.unpriced.tokensIn, 97419)
    })
    db.close()
  })
})

describe('周报 HTTP', () => {
  it('GET /api/board/reports/weekly 返回 period + flow + cost', async () => {
    const db = freshDb()
    await withServer(humanCtx(db), async (base) => {
      const created = await call(base, 'POST', '/api/board/projects', {
        key: 'WEEK',
        name: '周报',
        templateIds: [],
      })
      assert.equal(created.status, 201)
      const project = created.body.project as { id: string }
      assert.equal(listPipelines(db, project.id).length, 0)
      await call(base, 'POST', '/api/board/tickets', {
        projectId: project.id,
        type: 'chore',
        title: '本周',
      })
      const res = await call(base, 'GET', `/api/board/reports/weekly?projectId=${project.id}`)
      assert.equal(res.status, 200, JSON.stringify(res.body))
      const report = res.body.report as {
        period: { fromYmd: string; toYmd: string }
        flow: { created: number }
        cost: { coverage: string }
      }
      assert.ok(report.period.fromYmd)
      assert.ok(report.period.toYmd >= report.period.fromYmd)
      assert.ok(report.flow.created >= 1)
      assert.ok(report.cost.coverage)
    })
    db.close()
  })
})

describe('流水线模板 HTTP', () => {
  it('列出内置、套用、从流水线另存自定义', async () => {
    const db = freshDb()
    await withServer(humanCtx(db), async (base) => {
      const listed = await call(base, 'GET', '/api/board/templates')
      assert.equal(listed.status, 200)
      const items = listed.body.items as { id: string; source: string }[]
      assert.ok(items.some((t) => t.id === 'builtin:bug'))

      const created = await call(base, 'POST', '/api/board/projects', {
        key: 'TMPL',
        name: '模板项目',
        templateIds: ['builtin:spike'],
      })
      assert.equal(created.status, 201, JSON.stringify(created.body))
      const project = created.body.project as { id: string }
      const pipes = listPipelines(db, project.id)
      assert.equal(pipes.length, 1)
      assert.equal(pipes[0].ticketType, 'spike')

      const saved = await call(base, 'POST', '/api/board/templates', {
        pipelineId: pipes[0].id,
        slug: 'my-spike',
        name: '我的调研线',
      })
      assert.equal(saved.status, 201, JSON.stringify(saved.body))
      const template = saved.body.template as { id: string; slug: string }
      assert.equal(template.slug, 'my-spike')

      const other = await call(base, 'POST', '/api/board/projects', {
        key: 'TMP2',
        name: '另一项目',
        templateIds: [],
      })
      const otherId = (other.body.project as { id: string }).id
      const applied = await call(base, 'POST', `/api/board/templates/${template.id}/apply`, {
        projectId: otherId,
      })
      assert.equal(applied.status, 200, JSON.stringify(applied.body))
      assert.equal(applied.body.createdPipelines as number, 1)
      assert.equal(listPipelines(db, otherId).length, 1)

      const delBuiltin = await call(base, 'DELETE', '/api/board/templates/builtin:bug')
      assert.equal(delBuiltin.status, 400)
    })
    db.close()
  })
})
