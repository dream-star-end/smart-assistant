/**
 * MSC 记忆子系统深审(docs/audit/msc-memory.md)阶段 A 红灯复现用例:MEM-05。
 * projectMemoryHttp.ts 自带的 readJson 不走 taskboard/http.ts 的 readBody(TASKBOARD_MAX_BODY_BYTES),
 * 超大 body 被整段读进内存并落盘为项目记忆;JSON 解析失败也不是 400 而是 500。
 *
 * Run: npx tsx --test --test-concurrency=1 packages/gateway/src/taskboard/__tests__/projectMemoryHttpBodyLimit.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

const testHome = mkdtempSync(join(tmpdir(), 'oc-pmem-body-'))
process.env.OPENCLAUDE_HOME = testHome

const { handleTaskboardApi, TASKBOARD_MAX_BODY_BYTES } = await import('../http.js')
const { openTaskboardDb } = await import('../db/index.js')

const dirs: string[] = [testHome]
afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'oc-tb-pmem-body-'))
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
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end('{"error":"internal"}')
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    )
  }
}

async function post(base: string, path: string, rawBody: string) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: rawBody,
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe('MSC-memory 阶段 A 红灯用例 · 项目记忆 HTTP body', () => {
  // TODO(msc-memory): 阶段 B 修复 MEM-05 —— dispatchProjectMemory 改用 http.ts 的 readJsonBody
  // (带 TASKBOARD_MAX_BODY_BYTES),超限应 413,与 taskboard 其余路由一致。
  it('MEM-05 超过 TASKBOARD_MAX_BODY_BYTES 的项目记忆 POST 应 413', async () => {
    const db = freshDb()
    await withServer({ db, actor: 'human' }, async (base) => {
      const proj = await post(
        base,
        '/api/board/projects',
        JSON.stringify({ key: 'BIG', name: 'V5' }),
      )
      assert.equal(proj.status, 201, JSON.stringify(proj.body))
      const projectId = (proj.body.project as { id: string }).id
      const huge = '正'.repeat(TASKBOARD_MAX_BODY_BYTES) // 3 字节/字 → 约 1.5MB,远超 512KB
      const res = await post(
        base,
        `/api/board/projects/${projectId}/memories`,
        JSON.stringify({
          slug: 'huge.md',
          content: `---\nname: huge\ndescription: d\ntype: project\n---\n${huge}\n`,
        }),
      )
      assert.equal(
        res.status,
        413,
        `期望 413,实际 ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`,
      )
    })
  })

  // TODO(msc-memory): 阶段 B 修复 MEM-05 —— 畸形 JSON 应映射为 400(InvalidJsonError),不是 500。
  it('MEM-05 畸形 JSON 的项目记忆 POST 应 400 而不是 500', async () => {
    const db = freshDb()
    await withServer({ db, actor: 'human' }, async (base) => {
      const proj = await post(
        base,
        '/api/board/projects',
        JSON.stringify({ key: 'BAD', name: 'V5' }),
      )
      assert.equal(proj.status, 201, JSON.stringify(proj.body))
      const projectId = (proj.body.project as { id: string }).id
      const res = await post(base, `/api/board/projects/${projectId}/memories`, '{ not json')
      assert.equal(res.status, 400, `期望 400,实际 ${res.status}: ${JSON.stringify(res.body)}`)
    })
  })
})
