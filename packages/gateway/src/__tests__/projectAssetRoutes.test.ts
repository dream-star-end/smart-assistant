/**
 * 项目资产网关接线:server.ts 必须用 pathname 字面量认领路由(containerRouteInventory
 * 靠扫描这三种形态收路由),并覆盖 KNOWN_ROUTES / normalizePath,且不进 bridge allowlist。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/projectAssetRoutes.test.ts
 */
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const serverSrc = readFileSync(join(here, '../server.ts'), 'utf8')
// OCV5-376: the route branches live in routes/projectAssets.ts; server.ts dispatches to it.
const routeSrc = readFileSync(join(here, '../routes/projectAssets.ts'), 'utf8')
const allowlistSrc = readFileSync(join(here, '../bridgeApiAllowlist.ts'), 'utf8')

describe('project-assets 网关接线', () => {
  it('集合路由用 url.pathname === 字面量,条目路由用 match 字面量', () => {
    assert.ok(
      routeSrc.includes("url.pathname === '/api/project-assets'"),
      "routes/projectAssets.ts 必须有 url.pathname === '/api/project-assets'",
    )
    assert.ok(
      routeSrc.includes('url.pathname.match(/^\\/api\\/project-assets\\/([a-zA-Z0-9_-]{8,64})$/)'),
      'PATCH/DELETE 必须是 url.pathname.match(/^\\/api\\/project-assets\\/:id$/)',
    )
    assert.match(routeSrc, /listProjectAssets\(/)
    assert.match(routeSrc, /createProjectAsset\(/)
    assert.match(routeSrc, /updateProjectAsset\(/)
    assert.match(routeSrc, /deleteProjectAsset\(/)
  })

  it('KNOWN_ROUTES 含 /api/project-assets,normalizePath 收动态段', () => {
    assert.ok(
      serverSrc.includes("'/api/project-assets'"),
      'KNOWN_ROUTES 漏 /api/project-assets 会塌成 /__other__',
    )
    assert.ok(
      serverSrc.includes("'/api/project-assets/:id'") ||
        serverSrc.includes('/api/project-assets/:id'),
      'normalizePath 必须把 /api/project-assets/:id 规整掉',
    )
  })

  it('不进 BRIDGE_API_ALLOWLIST(与 /api/chat-projects 同平面,浏览器直打 gateway)', () => {
    assert.doesNotMatch(allowlistSrc, /project-assets/)
    assert.doesNotMatch(allowlistSrc, /chat-projects/)
  })

  it('产出物版本路由:versions(GET) 与 restore(POST) 用 match 字面量,normalizePath 收口', () => {
    assert.ok(
      routeSrc.includes('url.pathname.match(/^\\/api\\/project-assets\\/([a-zA-Z0-9_-]{8,64})\\/versions$/)'),
      'versions 必须是 url.pathname.match 字面量',
    )
    assert.ok(
      routeSrc.includes('url.pathname.match(/^\\/api\\/project-assets\\/([a-zA-Z0-9_-]{8,64})\\/restore$/)'),
      'restore 必须是 url.pathname.match 字面量',
    )
    assert.match(routeSrc, /listProjectAssetVersions\(/)
    assert.ok(serverSrc.includes("'/api/project-assets/:id/versions'"))
    assert.ok(serverSrc.includes("'/api/project-assets/:id/restore'"))
  })

  it('server.ts 在原位置(chat-projects 之后、sessions/unclaimed 之前)把请求交给 handleProjectAssetsHttp', () => {
    const dispatch = serverSrc.indexOf('if (handleProjectAssetsHttp(this.httpIo, req, res, url)) return')
    const unclaimed = serverSrc.indexOf("url.pathname === '/api/sessions/unclaimed'")
    assert.ok(dispatch >= 0 && unclaimed > dispatch)
  })

  it('GET/POST/PATCH/DELETE 四个方法都接线', () => {
    const start = routeSrc.indexOf("url.pathname === '/api/project-assets'")
    assert.ok(start >= 0)
    const block = routeSrc.slice(start)
    assert.match(block, /req\.method === 'GET'/)
    assert.match(block, /req\.method === 'POST'/)
    assert.match(block, /req\.method === 'PATCH'/)
    assert.match(block, /req\.method === 'DELETE'/)
    assert.match(block, /tryExtractProjectAssetExcerpt/)
  })

  it('GET ?q= switches to cross-project search with a validated source and capped limit', () => {
    const start = routeSrc.indexOf("url.pathname === '/api/project-assets'")
    const block = routeSrc.slice(start, routeSrc.indexOf("req.method === 'POST'", start))
    assert.match(block, /searchParams\.get\('q'\)/)
    assert.match(block, /searchProjectAssets\(userId, /)
    assert.match(block, /'invalid source'/)
    assert.match(block, /PROJECT_ASSET_SEARCH_LIMIT_MAX/)
  })
})
