/**
 * 聊天项目网关接线:server.ts 必须用 pathname 字面量认领路由(containerRouteInventory
 * 靠扫描这三种形态收路由),并覆盖 KNOWN_ROUTES / normalizePath,扩展既有会话 PATCH。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/chatProjectRoutes.test.ts
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
// OCV5-376: the route branches live in routes/chatProjects.ts; server.ts dispatches to it.
const routeSrc = readFileSync(join(here, '../routes/chatProjects.ts'), 'utf8')
const allowlistSrc = readFileSync(join(here, '../bridgeApiAllowlist.ts'), 'utf8')

describe('chat-projects 网关接线', () => {
  it('集合路由用 url.pathname === 字面量,条目路由用 match 字面量', () => {
    assert.ok(
      routeSrc.includes("url.pathname === '/api/chat-projects'"),
      "routes/chatProjects.ts 必须有 url.pathname === '/api/chat-projects'",
    )
    assert.ok(
      routeSrc.includes('url.pathname.match(/^\\/api\\/chat-projects\\/([a-zA-Z0-9_-]{8,64})$/)'),
      'PATCH/DELETE 必须是 url.pathname.match(/^\\/api\\/chat-projects\\/:id$/)',
    )
    assert.match(routeSrc, /listChatProjects\(/)
    assert.match(routeSrc, /createChatProject\(/)
    assert.match(routeSrc, /updateChatProject\(/)
    assert.match(routeSrc, /deleteChatProject\(/)
    assert.match(routeSrc, /boardProjectId/)
    assert.match(routeSrc, /board_project_bound/)
  })

  it('server.ts 在原位置(read-all 之后、project-assets 之前)把请求交给 handleChatProjectsHttp', () => {
    const readAll = sessionsSrc.indexOf("url.pathname === '/api/sessions/read-all'")
    const dispatch = sessionsSrc.indexOf('if (handleChatProjectsHttp(io, req, res, url)) return true')
    const assets = sessionsSrc.indexOf('if (handleProjectAssetsHttp(io, req, res, url)) return true')
    assert.ok(readAll >= 0 && dispatch > readAll && assets > dispatch)
  })

  it('KNOWN_ROUTES 含 /api/chat-projects,normalizePath 收动态段', () => {
    assert.ok(
      serverSrc.includes("'/api/chat-projects'"),
      'KNOWN_ROUTES 漏 /api/chat-projects 会塌成 /__other__',
    )
    assert.ok(
      serverSrc.includes("'/api/chat-projects/:id'") ||
        serverSrc.includes('/api/chat-projects/:id'),
      'normalizePath 必须把 /api/chat-projects/:id 规整掉',
    )
  })

  it('不进 BRIDGE_API_ALLOWLIST(与 /api/sessions/list 同平面,浏览器直打 gateway)', () => {
    assert.doesNotMatch(allowlistSrc, /chat-projects/)
    assert.doesNotMatch(allowlistSrc, /\/api\/sessions\/list/)
  })

  it('既有 PATCH /api/sessions/:id 接受 projectId 与 pinned', () => {
    const clientSess = sessionsSrc.indexOf('const clientSessMatch')
    assert.ok(clientSess >= 0, 'clientSessMatch 必须存在')
    const patchBlock = sessionsSrc.slice(
      sessionsSrc.indexOf('元数据专用更新', clientSess),
      sessionsSrc.indexOf("if (req.method === 'DELETE')", clientSess),
    )
    assert.match(patchBlock, /projectId/)
    assert.match(patchBlock, /pinned/)
    assert.match(patchBlock, /patchClientSessionMeta\(/)
    assert.match(patchBlock, /project not found/)
  })
})
