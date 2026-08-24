/**
 * Human-only promote vs agent bearer; project memory isolation.
 * Run: npx tsx --test packages/gateway/src/taskboard/__tests__/projectMemoryHttp.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

const testHome = mkdtempSync(join(tmpdir(), 'oc-pmem-http-'))
process.env.OPENCLAUDE_HOME = testHome

const { handleTaskboardApi } = await import('../http.js')
const { openTaskboardDb } = await import('../db/index.js')
const { ProjectMemoryDir } = await import('@openclaude/storage')

const dirs: string[] = [testHome]
afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'oc-tb-pmem-'))
  dirs.push(dir)
  return openTaskboardDb(join(dir, 'taskboard.db'))
}

async function withServer(
  ctx: { db: ReturnType<typeof openTaskboardDb>; actor: 'human' | 'agent' },
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((req, res) => {
    handleTaskboardApi(req, res, ctx).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500)
        res.end('{}')
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  }
}

async function call(base: string, method: string, path: string, body?: unknown, actor?: 'human' | 'agent') {
  void actor
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

const CONTENT = '---\nname: 约定\ndescription: 表格\ntype: project\n---\n项目约定用表格。\n'

describe('project memory HTTP', () => {
  it('agent can create candidate but cannot promote; human can promote', async () => {
    const db = freshDb()
    const created = db.transaction(() => {
      return null
    })
    void created
    await withServer({ db, actor: 'human' }, async (base) => {
      const proj = await call(base, 'POST', '/api/board/projects', { key: 'TEST', name: 'V5' })
      assert.equal(proj.status, 201)
      const projectId = (proj.body.project as { id: string }).id

      await withServer({ db, actor: 'agent' }, async (agentBase) => {
        const cand = await call(agentBase, 'POST', `/api/board/projects/${projectId}/memories`, {
          slug: 'notes.md',
          content: CONTENT,
          sourceAgent: 'stage-implement',
        })
        assert.equal(cand.status, 201, JSON.stringify(cand.body))
        const candidate = cand.body.candidate as { id: string; version: number }
        const denied = await call(agentBase, 'POST', `/api/board/projects/${projectId}/memories/${candidate.id}/promote`, {
          expectedVersion: candidate.version,
        })
        assert.equal(denied.status, 403)
        assert.equal(denied.body.code, 'human_required')
      })

      const listed = await call(base, 'GET', `/api/board/projects/${projectId}/memories`)
      const candidates = listed.body.candidates as Array<{ id: string; version: number }>
      assert.equal(candidates.length, 1)
      const ok = await call(base, 'POST', `/api/board/projects/${projectId}/memories/${candidates[0].id}/promote`, {
        expectedVersion: candidates[0].version,
      })
      assert.equal(ok.status, 200, JSON.stringify(ok.body))

      const dir = new ProjectMemoryDir(projectId)
      const officialPath = dir.officialFile('notes.md')
      const { writeFile } = await import('node:fs/promises')
      await writeFile(officialPath, CONTENT + '\nagent tampered\n')
      const after = await call(base, 'GET', `/api/board/projects/${projectId}/memories?status=official`)
      const official = after.body.official as Array<{ tampered: boolean }>
      assert.equal(official[0]?.tampered, true)
    })
    db.close()
  })

  it('projects are isolated', async () => {
    const db = freshDb()
    await withServer({ db, actor: 'human' }, async (base) => {
      const a = await call(base, 'POST', '/api/board/projects', { key: 'AAA', name: 'A' })
      const b = await call(base, 'POST', '/api/board/projects', { key: 'BBB', name: 'B' })
      const idA = (a.body.project as { id: string }).id
      const idB = (b.body.project as { id: string }).id
      await call(base, 'POST', `/api/board/projects/${idA}/memories`, { slug: 'a.md', content: CONTENT })
      const listB = await call(base, 'GET', `/api/board/projects/${idB}/memories`)
      assert.equal((listB.body.candidates as unknown[]).length, 0)
      assert.equal((listB.body.official as unknown[]).length, 0)
    })
    db.close()
  })

  it('GET context/preview and old run context columns stay null', async () => {
    const db = freshDb()
    await withServer({ db, actor: 'human' }, async (base) => {
      const proj = await call(base, 'POST', '/api/board/projects', { key: 'CTX', name: 'ctx' })
      const projectId = (proj.body.project as { id: string }).id
      const ctx = await call(base, 'GET', `/api/board/projects/${projectId}/context`)
      assert.equal(ctx.status, 200)
      assert.equal(ctx.body.replay, 'audit_only_not_bit_identical')
      const preview = await call(base, 'GET', `/api/board/projects/${projectId}/context/preview`)
      assert.equal(preview.status, 200)
      assert.equal(preview.body.enabled, false)
      const ticket = await call(base, 'POST', '/api/board/tickets', {
        projectId,
        type: 'chore',
        title: 'old',
      })
      const ticketId = (ticket.body.ticket as { id: string }).id
      const { insertRun } = await import('../db/runs.js')
      const run = insertRun(db, {
        ticketId,
        stageId: 'none',
        trigger: 'patrol',
      })
      const runCtx = await call(base, 'GET', `/api/board/runs/${run.id}/context`)
      assert.equal(runCtx.status, 200)
      assert.equal(runCtx.body.contextSnapshotId, null)
      assert.equal(runCtx.body.snapshot, null)
    })
    db.close()
  })
})
