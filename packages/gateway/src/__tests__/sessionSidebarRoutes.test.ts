/**
 * 侧栏会话网关接线:search / batch / list 分页 / PATCH archived。
 * 后半部分:会话回收站(trash bin)HTTP 行为 —— list?trashed=1 / restore / purge /
 * batch restore|purge,起真 gateway + 真 SQLite(projectAssetHttp.test.ts 同款)。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/sessionSidebarRoutes.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const serverSrc = readFileSync(join(here, '../server.ts'), 'utf8')
const allowlistSrc = readFileSync(join(here, '../bridgeApiAllowlist.ts'), 'utf8')

describe('sessions sidebar 网关接线', () => {
  it('search / batch / list 用 pathname 字面量', () => {
    assert.ok(serverSrc.includes("url.pathname === '/api/sessions/search'"))
    assert.ok(serverSrc.includes("url.pathname === '/api/sessions/batch'"))
    assert.ok(serverSrc.includes("url.pathname === '/api/sessions/list'"))
    assert.ok(serverSrc.includes("url.pathname === '/api/sessions/read-all'"))
    assert.ok(
      serverSrc.includes('url.pathname.match(/^\\/api\\/sessions\\/([a-zA-Z0-9_-]{8,50})\\/read$/)'),
      'POST /api/sessions/:id/read 必须用 pathname.match 字面量,否则 containerRouteInventory 扫不到会线上 404',
    )
    assert.match(serverSrc, /searchClientSessions\(/)
    assert.match(serverSrc, /batchClientSessions\(/)
    assert.match(serverSrc, /markClientSessionRead\(/)
    assert.match(serverSrc, /markAllClientSessionsRead\(/)
    assert.doesNotMatch(serverSrc, /unread-migrate/)
    assert.doesNotMatch(serverSrc, /migrateClientSessionsUnread/)
  })

  it('KNOWN_ROUTES 含新路径,不进 BRIDGE_API_ALLOWLIST', () => {
    assert.ok(serverSrc.includes("'/api/sessions/search'"))
    assert.ok(serverSrc.includes("'/api/sessions/batch'"))
    assert.ok(serverSrc.includes("'/api/sessions/list'"))
    assert.ok(serverSrc.includes("'/api/sessions/read-all'"))
    assert.ok(
      serverSrc.includes("'/api/sessions/:id/read'") || serverSrc.includes('/api/sessions/:id/read'),
      'normalizePath 必须把 /api/sessions/:id/read 规整掉',
    )
    assert.doesNotMatch(allowlistSrc, /\/api\/sessions\/search/)
    assert.doesNotMatch(allowlistSrc, /\/api\/sessions\/batch/)
    assert.doesNotMatch(allowlistSrc, /\/api\/sessions\/list/)
    assert.doesNotMatch(allowlistSrc, /\/api\/sessions\/read-all/)
    assert.doesNotMatch(allowlistSrc, /\/api\/sessions\/unread-migrate/)
    assert.doesNotMatch(allowlistSrc, /\/api\/sessions\/:id\/read/)
  })

  it('PATCH 接受 archived;list 解析 includeArchived/limit/before', () => {
    const clientSess = serverSrc.indexOf('const clientSessMatch')
    assert.ok(clientSess >= 0)
    const patchBlock = serverSrc.slice(
      serverSrc.indexOf('元数据专用更新', clientSess),
      serverSrc.indexOf("if (req.method === 'DELETE')", clientSess),
    )
    assert.match(patchBlock, /archived/)
    assert.match(patchBlock, /hasArchived/)

    const listStart = serverSrc.indexOf("if (url.pathname === '/api/sessions/list'")
    const listBlock = serverSrc.slice(listStart, listStart + 1800)
    assert.match(listBlock, /includeArchived/)
    assert.match(listBlock, /nextCursor/)
    assert.match(listBlock, /SESSION_LIST_LIMIT_MAX/)
  })
})

// ── 会话回收站 HTTP 行为(真 gateway + 真 SQLite)──
const home = mkdtempSync(join(tmpdir(), 'oc-gw-trash-'))
process.env.OPENCLAUDE_HOME = home

const { Gateway } = await import('../server.js')
const { signJwt } = await import('../auth.js')

const TOKEN = 'test-gateway-token-trash'
const jwt = signJwt({ userId: 'default', exp: Math.floor(Date.now() / 1000) + 3600 }, TOKEN)

interface TrashSessionMeta {
  id: string
  deletedAt?: number
}

describe('sessions trash HTTP routes', () => {
  let base = ''
  let server: ReturnType<typeof createServer> | null = null
  const headers = { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' }

  before(async () => {
    const gw = new Gateway({
      config: {
        version: 1,
        gateway: { bind: '127.0.0.1', port: 0, accessToken: TOKEN },
        auth: { mode: 'subscription', claudeCodePath: '' },
        sessions: { dbPath: join(home, 'sessions.db') },
        defaults: { model: 'glm-5.2' },
      } as never,
      agentsConfig: { agents: [{ id: 'main' }], routes: [], default: 'main' },
    })
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      ;(gw as unknown as { handleHttp: (r: IncomingMessage, s: ServerResponse) => void }).handleHttp(
        req,
        res,
      )
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const addr = server!.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    base = `http://127.0.0.1:${port}`
  })

  after(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  async function putSession(id: string, title: string): Promise<void> {
    const r = await fetch(`${base}/api/sessions/${id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ agentId: 'main', title, createdAt: 1_700_000_000_000, lastAt: 1_700_000_000_000 }),
    })
    assert.equal(r.status, 200, `PUT ${id} must succeed`)
  }

  async function listSessions(trashed: boolean): Promise<TrashSessionMeta[]> {
    const r = await fetch(`${base}/api/sessions/list${trashed ? '?trashed=1' : ''}`, { headers })
    assert.equal(r.status, 200)
    const body = (await r.json()) as { sessions: TrashSessionMeta[] }
    return body.sessions
  }

  it('(a) list?trashed=1 returns only trashed sessions with deletedAt', async () => {
    await putSession('trash-list-a1', 'trash list A')
    await putSession('trash-list-b2', 'trash list B')
    const del = await fetch(`${base}/api/sessions/trash-list-a1`, { method: 'DELETE', headers })
    assert.equal(del.status, 200)
    assert.deepEqual(await del.json(), { ok: true })

    const normal = await listSessions(false)
    const normalIds = normal.map((s) => s.id)
    assert.ok(normalIds.includes('trash-list-b2'))
    assert.ok(!normalIds.includes('trash-list-a1'), 'soft-deleted session leaves the main list')

    const trashed = await listSessions(true)
    const trashedIds = trashed.map((s) => s.id)
    assert.ok(trashedIds.includes('trash-list-a1'), 'soft-deleted session appears in trash list')
    assert.ok(!trashedIds.includes('trash-list-b2'), 'active session not in trash list')
    const trashedA = trashed.find((s) => s.id === 'trash-list-a1')
    assert.ok(typeof trashedA?.deletedAt === 'number' && trashedA.deletedAt > 0, 'deletedAt is set')
    // 主列表(不带 trashed)不带 deletedAt
    const normalA = normal.find((s) => s.id === 'trash-list-b2')
    assert.equal(normalA?.deletedAt, undefined)
  })

  it('(b) POST /api/sessions/:id/restore — 200 restores, 404 for active', async () => {
    await putSession('trash-restore-c3', 'restore me')
    // 活跃行 → 404
    const active = await fetch(`${base}/api/sessions/trash-restore-c3/restore`, { method: 'POST', headers })
    assert.equal(active.status, 404)
    assert.deepEqual(await active.json(), { error: 'not found in trash' })

    // 软删 → restore → 回到主列表
    const del = await fetch(`${base}/api/sessions/trash-restore-c3`, { method: 'DELETE', headers })
    assert.equal(del.status, 200)
    const restored = await fetch(`${base}/api/sessions/trash-restore-c3/restore`, { method: 'POST', headers })
    assert.equal(restored.status, 200)
    const restoredBody = (await restored.json()) as { ok: boolean; updatedAt: number }
    assert.equal(restoredBody.ok, true)
    assert.ok(typeof restoredBody.updatedAt === 'number')

    const normal = await listSessions(false)
    assert.ok(normal.some((s) => s.id === 'trash-restore-c3'), 'restored session back in normal list')
    const trashed = await listSessions(true)
    assert.ok(!trashed.some((s) => s.id === 'trash-restore-c3'), 'restored session leaves trash list')

    // 再 restore 一次(已活跃)→ 404
    const again = await fetch(`${base}/api/sessions/trash-restore-c3/restore`, { method: 'POST', headers })
    assert.equal(again.status, 404)
  })

  it('(c) DELETE ?purge=1 — 404 for active, 200 after trashing, row gone', async () => {
    await putSession('trash-purge-d4', 'purge me')

    // 活跃行不可直接硬删
    const activePurge = await fetch(`${base}/api/sessions/trash-purge-d4?purge=1`, {
      method: 'DELETE',
      headers,
    })
    assert.equal(activePurge.status, 404)
    assert.deepEqual(await activePurge.json(), { error: 'not found in trash' })

    // 先软删进回收站,再 purge
    const del = await fetch(`${base}/api/sessions/trash-purge-d4`, { method: 'DELETE', headers })
    assert.equal(del.status, 200)
    const purge = await fetch(`${base}/api/sessions/trash-purge-d4?purge=1`, {
      method: 'DELETE',
      headers,
    })
    assert.equal(purge.status, 200)
    assert.deepEqual(await purge.json(), { ok: true, purged: true })

    // 行彻底消失:主列表 + 回收站列表都查不到
    const normal = await listSessions(false)
    assert.ok(!normal.some((s) => s.id === 'trash-purge-d4'))
    const trashed = await listSessions(true)
    assert.ok(!trashed.some((s) => s.id === 'trash-purge-d4'))
    // 幂等:再 purge → 404
    const again = await fetch(`${base}/api/sessions/trash-purge-d4?purge=1`, {
      method: 'DELETE',
      headers,
    })
    assert.equal(again.status, 404)
  })

  it('(d) batch restore/purge accepted; invalid action message mentions them', async () => {
    await putSession('trash-batch-e5', 'batch target')
    // batch delete(软删进回收站)
    const del = await fetch(`${base}/api/sessions/batch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ids: ['trash-batch-e5'], action: 'delete' }),
    })
    assert.equal(del.status, 200)

    // batch restore → 200,回到主列表
    const restore = await fetch(`${base}/api/sessions/batch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ids: ['trash-batch-e5'], action: 'restore' }),
    })
    assert.equal(restore.status, 200)
    const restoreBody = (await restore.json()) as { ok: boolean; updated: number }
    assert.equal(restoreBody.ok, true)
    assert.equal(restoreBody.updated, 1)
    let normal = await listSessions(false)
    assert.ok(normal.some((s) => s.id === 'trash-batch-e5'))

    // 再软删 → batch purge → 200,行没了
    const del2 = await fetch(`${base}/api/sessions/batch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ids: ['trash-batch-e5'], action: 'delete' }),
    })
    assert.equal(del2.status, 200)
    const purge = await fetch(`${base}/api/sessions/batch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ids: ['trash-batch-e5'], action: 'purge' }),
    })
    assert.equal(purge.status, 200)
    const purgeBody = (await purge.json()) as { ok: boolean; updated: number }
    assert.equal(purgeBody.ok, true)
    assert.equal(purgeBody.updated, 1)
    normal = await listSessions(false)
    assert.ok(!normal.some((s) => s.id === 'trash-batch-e5'))
    const trashed = await listSessions(true)
    assert.ok(!trashed.some((s) => s.id === 'trash-batch-e5'))

    // invalid action → 400,文案包含 restore 与 purge
    const invalid = await fetch(`${base}/api/sessions/batch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ids: ['trash-batch-e5'], action: 'explode' }),
    })
    assert.equal(invalid.status, 400)
    const invalidBody = (await invalid.json()) as { error: string }
    assert.match(invalidBody.error, /restore/)
    assert.match(invalidBody.error, /purge/)
  })
})
