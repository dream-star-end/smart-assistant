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
    assert.match(serverSrc, /searchClientSessions\(/)
    assert.match(serverSrc, /batchClientSessions\(/)
  })

  it('KNOWN_ROUTES 含新路径,不进 BRIDGE_API_ALLOWLIST', () => {
    assert.ok(serverSrc.includes("'/api/sessions/search'"))
    assert.ok(serverSrc.includes("'/api/sessions/batch'"))
    assert.ok(serverSrc.includes("'/api/sessions/list'"))
    assert.doesNotMatch(allowlistSrc, /\/api\/sessions\/search/)
    assert.doesNotMatch(allowlistSrc, /\/api\/sessions\/batch/)
    assert.doesNotMatch(allowlistSrc, /\/api\/sessions\/list/)
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
