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
const allowlistSrc = readFileSync(join(here, '../bridgeApiAllowlist.ts'), 'utf8')

describe('sessions sidebar 网关接线', () => {
  it('search / batch / list 用 pathname 字面量', () => {
    assert.ok(serverSrc.includes("url.pathname === '/api/sessions/search'"))
    assert.ok(serverSrc.includes("url.pathname === '/api/sessions/batch'"))
    assert.ok(serverSrc.includes("url.pathname === '/api/sessions/list'"))
    assert.ok(serverSrc.includes("url.pathname === '/api/sessions/read-all'"))
    assert.ok(serverSrc.includes("url.pathname === '/api/sessions/unread-migrate'"))
    assert.ok(
      serverSrc.includes('url.pathname.match(/^\\/api\\/sessions\\/([a-zA-Z0-9_-]{8,50})\\/read$/)'),
      'POST /api/sessions/:id/read 必须用 pathname.match 字面量,否则 containerRouteInventory 扫不到会线上 404',
    )
    assert.match(serverSrc, /searchClientSessions\(/)
    assert.match(serverSrc, /batchClientSessions\(/)
    assert.match(serverSrc, /markClientSessionRead\(/)
    assert.match(serverSrc, /markAllClientSessionsRead\(/)
    assert.match(serverSrc, /migrateClientSessionsUnread\(/)
  })

  it('KNOWN_ROUTES 含新路径,不进 BRIDGE_API_ALLOWLIST', () => {
    assert.ok(serverSrc.includes("'/api/sessions/search'"))
    assert.ok(serverSrc.includes("'/api/sessions/batch'"))
    assert.ok(serverSrc.includes("'/api/sessions/list'"))
    assert.ok(serverSrc.includes("'/api/sessions/read-all'"))
    assert.ok(serverSrc.includes("'/api/sessions/unread-migrate'"))
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
