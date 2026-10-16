/**
 * 侧栏会话网关接线:search / batch / list 分页 / PATCH archived。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/sessionSidebarRoutes.test.ts
 */
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const serverSrc = readFileSync(join(here, '../server.ts'), 'utf8')
// OCV5-465: the client session routes live in routes/clientSessions.ts; server.ts dispatches to it.
const sessionsSrc = readFileSync(join(here, '../routes/clientSessions.ts'), 'utf8')
const allowlistSrc = readFileSync(join(here, '../bridgeApiAllowlist.ts'), 'utf8')

describe('sessions sidebar 网关接线', () => {
  it('search / batch / list 用 pathname 字面量', () => {
    assert.ok(sessionsSrc.includes("url.pathname === '/api/sessions/search'"))
    assert.ok(sessionsSrc.includes("url.pathname === '/api/sessions/batch'"))
    assert.ok(sessionsSrc.includes("url.pathname === '/api/sessions/list'"))
    assert.ok(sessionsSrc.includes("url.pathname === '/api/sessions/read-all'"))
    assert.ok(
      sessionsSrc.includes('url.pathname.match(/^\\/api\\/sessions\\/([a-zA-Z0-9_-]{8,50})\\/read$/)'),
      'POST /api/sessions/:id/read 必须用 pathname.match 字面量,否则 containerRouteInventory 扫不到会线上 404',
    )
    assert.match(sessionsSrc, /searchClientSessions\(/)
    assert.match(sessionsSrc, /batchClientSessions\(/)
    assert.match(sessionsSrc, /markClientSessionRead\(/)
    assert.match(sessionsSrc, /markAllClientSessionsRead\(/)
    assert.doesNotMatch(sessionsSrc, /unread-migrate/)
    assert.doesNotMatch(sessionsSrc, /migrateClientSessionsUnread/)
    assert.ok(serverSrc.includes('if (handleClientSessionsHttp(this.clientSessionsIo, req, res, url)) return'))
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
    const clientSess = sessionsSrc.indexOf('const clientSessMatch')
    assert.ok(clientSess >= 0)
    const patchBlock = sessionsSrc.slice(
      sessionsSrc.indexOf('元数据专用更新', clientSess),
      sessionsSrc.indexOf("if (req.method === 'DELETE')", clientSess),
    )
    assert.match(patchBlock, /archived/)
    assert.match(patchBlock, /hasArchived/)

    const listStart = sessionsSrc.indexOf("if (url.pathname === '/api/sessions/list'")
    const listBlock = sessionsSrc.slice(listStart, listStart + 1800)
    assert.match(listBlock, /includeArchived/)
    assert.match(listBlock, /nextCursor/)
    assert.match(listBlock, /SESSION_LIST_LIMIT_MAX/)
  })
})
