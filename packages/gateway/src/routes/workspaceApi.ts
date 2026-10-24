/**
 * Workspace API routes (changelog, feedback, search, cron, board, tasks, webhooks, wechat, Claude auth, uploads, media, file)
 *
 * Ordered route table moved out of Gateway._handleHttpAfterCommercial (FINDINGS §7.5 step 2b,
 * OCV5-468). Each entry's match is the original branch condition and its handler the original
 * branch body (`return` → `return true`; a branch that falls through returns false; `path` /
 * `method` are the method's own `url.pathname` / `req.method ?? 'GET'` copies), so dispatchRoutes()
 * over this table behaves exactly like the if-chain it replaces. The Gateway dispatches it at the spot
 * the inline block used to be. Order matters: the first entry whose handler returns true wins.
 *
 * Dependencies are the narrow WorkspaceApiRoutesIo below instead of the whole Gateway (read-only Gateway fields are
 * exposed as getters). Equivalence with the original chain: __tests__/httpRouteTables.test.ts.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { type AgentsConfig, paths } from '@openclaude/storage'
import { filterUserVisibleByAgentField } from '../agentVisibility.js'
import { handleTaskboardApi, resolveTaskboardActor, type TaskboardHttpContext } from '../taskboard/http.js'
import type { WebhookRouter } from '../webhooks.js'
import type { Gateway, GatewayDeps } from '../server.js'
import { type HttpRoute, predicateRoute, regexRoute } from './routeTable.js'

export interface WorkspaceApiRoutesIo {
  preflightStages: NonNullable<TaskboardHttpContext['preflightStages']>
  getRunSnapshots: NonNullable<TaskboardHttpContext['getRunSnapshots']>
  _getAgentsConfigUserView(): Promise<AgentsConfig>
  _handleTaskItem(req: IncomingMessage, res: ServerResponse, taskId: string): Promise<void>
  _handleTasksApi(req: IncomingMessage, res: ServerResponse): Promise<void>
  _handleWebhook(req: IncomingMessage, res: ServerResponse, whId: string): Promise<void>
  _handleWechat(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void>
  checkBridgeBypass(req: IncomingMessage, url: URL): boolean
  getUserId(req: IncomingMessage): string
  handleApiFile(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void>
  handleCronApi(req: IncomingMessage, res: ServerResponse): Promise<void>
  handleCronChannels(req: IncomingMessage, res: ServerResponse): Promise<void>
  handleCronItem(req: IncomingMessage, res: ServerResponse, id: string): Promise<void>
  handleMediaGet(req: IncomingMessage, res: ServerResponse, rawFilename: string): Promise<void>
  handleOAuthCallback(req: IncomingMessage, res: ServerResponse): Promise<void>
  handleOAuthStart(req: IncomingMessage, res: ServerResponse): Promise<void>
  handleSearch(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void>
  handleUpload(req: IncomingMessage, res: ServerResponse): Promise<void>
  readBody: Gateway['readBody']
  sendInternalError(res: ServerResponse, err: unknown): void
  sendJson(res: ServerResponse, code: number, body: unknown): void
  verifyCommercialJwt(token: string): { sub: string; role: 'user' | 'admin'; exp: number } | null
  readonly _taskStore: Gateway['_taskStore']
  readonly deps: GatewayDeps
  readonly log: Gateway['log']
  readonly webhookRouter: WebhookRouter | null
}

export const WORKSPACE_API_ROUTES: readonly HttpRoute<WorkspaceApiRoutesIo>[] = [
  // ── Changelog / Release Notes ──
  predicateRoute(
    'GET /api/changelog',
    (req, url) => url.pathname === '/api/changelog' && req.method === 'GET',
    (io, _req, res, _url) => {
      const changelogPath = join(paths.home, 'changelog.json')
      try {
        const raw = readFileSync(changelogPath, 'utf-8')
        const data = JSON.parse(raw)
        io.sendJson(res, 200, data)
      } catch {
        io.sendJson(res, 200, { currentVersion: '0.0.0', releases: [] })
      }
      return true
    },
  ),
  // ── User Feedback ──
  predicateRoute(
    'POST /api/feedback',
    (req, url) => url.pathname === '/api/feedback' && req.method === 'POST',
    (io, req, res, _url) => {
      io.readBody(req)
        .then(async (body) => {
          try {
            const { category, description, sessionId, userAgent } = JSON.parse(body)
            if (!description || typeof description !== 'string' || description.trim().length < 15) {
              io.sendJson(res, 400, { error: '反馈描述至少需要 15 个字符' })
              return
            }
            const feedbackDir = join(paths.home, 'feedback')
            await mkdir(feedbackDir, { recursive: true })
            const entry = {
              id: `fb-${Date.now()}-${randomBytes(4).toString('hex')}`,
              category: category || 'general',
              description,
              sessionId: sessionId || null,
              userAgent: userAgent || null,
              userId: io.getUserId(req),
              createdAt: new Date().toISOString(),
            }
            const filePath = join(feedbackDir, `${entry.id}.json`)
            await writeFile(filePath, JSON.stringify(entry, null, 2))
            io.sendJson(res, 200, { ok: true, id: entry.id })
          } catch (err) {
            // E5 — 原始错误(可能含内部路径/栈)只进日志,响应体给受控文案。
            io.log.warn('feedback submit failed', undefined, err as Error)
            io.sendJson(res, 400, { error: '反馈提交失败，请稍后重试' })
          }
        })
        .catch(() => io.sendJson(res, 400, { error: 'invalid body' }))
      return true
    },
  ),
  predicateRoute(
    'GET /api/feedback',
    (req, url) => url.pathname === '/api/feedback' && req.method === 'GET',
    (io, req, res, _url) => {
      const feedbackDir = join(paths.home, 'feedback')
      const userId = io.getUserId(req)
      try {
        const files = existsSync(feedbackDir)
          ? readdirSync(feedbackDir)
              .filter((f) => f.endsWith('.json'))
              .sort()
              .reverse()
          : []
        const items: unknown[] = []
        for (const f of files) {
          if (items.length >= 50) break
          try {
            const entry = JSON.parse(readFileSync(join(feedbackDir, f), 'utf-8'))
            if (entry && entry.userId === userId) items.push(entry)
          } catch {
            /* skip corrupt files */
          }
        }
        io.sendJson(res, 200, { feedback: items })
      } catch {
        io.sendJson(res, 200, { feedback: [] })
      }
      return true
    },
  ),
  predicateRoute(
    '/api/search',
    (_req, url) => url.pathname === '/api/search',
    (io, req, res, url) => {
      io.handleSearch(req, res, url).catch((err) => io.sendInternalError(res, err))
      return true
    },
  ),
  // ── Cron/reminder REST API ──
  // /api/cron/channels 必须写在 :id 匹配之前,否则会被当成 job id「channels」。
  predicateRoute(
    '/api/cron/channels',
    (_req, url) => url.pathname === '/api/cron/channels',
    (io, req, res, _url) => {
      io.handleCronChannels(req, res).catch((err) => io.sendInternalError(res, err))
      return true
    },
  ),
  predicateRoute(
    '/api/cron',
    (_req, url) => url.pathname === '/api/cron',
    (io, req, res, _url) => {
      io.handleCronApi(req, res).catch((err) => io.sendInternalError(res, err))
      return true
    },
  ),
  regexRoute(
    '/api/cron/:1',
    (_req, url) => url.pathname.match(/^\/api\/cron\/([a-zA-Z0-9_-]+)$/),
    (io, req, res, _url, cronItemMatch) => {
      io.handleCronItem(req, res, cronItemMatch[1]).catch((err) => io.sendInternalError(res, err))
      return true
    },
  ),
  // ── Taskboard REST API (`/api/board/*`) ──
  // 分发形态必须写在本文件的 url.pathname === / match 上,containerRouteInventory
  // 靠扫描这三种字面量收路由;藏进 helper 会让 allowlist 闭包测试变死规则。
  predicateRoute(
    '/api/board/projects | /api/board/tickets | /api/board/pipelines | /api/board/agents | /api/board/settings | /api/board/stats/cost | /api/board/templates | /api/board/reports/weekly',
    (_req, url) =>
      url.pathname === '/api/board/projects' ||
      url.pathname === '/api/board/tickets' ||
      url.pathname === '/api/board/pipelines' ||
      url.pathname === '/api/board/agents' ||
      url.pathname === '/api/board/settings' ||
      url.pathname === '/api/board/stats/cost' ||
      url.pathname === '/api/board/templates' ||
      url.pathname === '/api/board/reports/weekly' ||
      url.pathname.match(/^\/api\/board\/projects\/([^/]+)$/) ||
      url.pathname.match(/^\/api\/board\/projects\/([^/]+)\/board$/) ||
      url.pathname.match(/^\/api\/board\/projects\/([^/]+)\/context$/) ||
      url.pathname.match(/^\/api\/board\/projects\/([^/]+)\/context\/preview$/) ||
      url.pathname.match(/^\/api\/board\/projects\/([^/]+)\/ensure$/) ||
      url.pathname.match(/^\/api\/board\/projects\/([^/]+)\/workspace$/) ||
      url.pathname.match(/^\/api\/board\/projects\/([^/]+)\/workspace\/file$/) ||
      url.pathname.match(/^\/api\/board\/projects\/([^/]+)\/memories$/) ||
      url.pathname.match(/^\/api\/board\/projects\/([^/]+)\/memories\/([^/]+)$/) ||
      url.pathname.match(
        /^\/api\/board\/projects\/([^/]+)\/memories\/([^/]+)\/(promote|reject|deprecate)$/,
      ) ||
      url.pathname.match(/^\/api\/board\/runs\/([^/]+)\/context$/) ||
      url.pathname.match(/^\/api\/board\/tickets\/([^/]+)$/) ||
      url.pathname.match(/^\/api\/board\/tickets\/([^/]+)\/(ready|claim|advance)$/) ||
      url.pathname.match(/^\/api\/board\/tickets\/([^/]+)\/(block|approve|reject)$/) ||
      url.pathname.match(/^\/api\/board\/tickets\/([^/]+)\/(done|cancel|comment|patrol|stop|move)$/) ||
      url.pathname.match(/^\/api\/board\/tickets\/([^/]+)\/runs$/) ||
      url.pathname.match(/^\/api\/board\/tickets\/([^/]+)\/relations$/) ||
      url.pathname.match(/^\/api\/board\/tickets\/([^/]+)\/comments$/) ||
      url.pathname.match(/^\/api\/board\/tickets\/([^/]+)\/activity$/) ||
      url.pathname.match(/^\/api\/board\/tickets\/([^/]+)\/timeline$/) ||
      url.pathname.match(/^\/api\/board\/pipelines\/([^/]+)$/) ||
      url.pathname.match(/^\/api\/board\/pipelines\/([^/]+)\/reorder$/) ||
      url.pathname.match(/^\/api\/board\/pipelines\/([^/]+)\/stages$/) ||
      url.pathname.match(/^\/api\/board\/stages\/([^/]+)$/) ||
      url.pathname.match(/^\/api\/board\/runs\/([^/]+)$/) ||
      url.pathname.match(/^\/api\/board\/relations\/([^/]+)$/) ||
      url.pathname.match(/^\/api\/board\/templates\/([^/]+)$/) ||
      url.pathname.match(/^\/api\/board\/templates\/([^/]+)\/apply$/),
    (io, req, res, url) => {
      handleTaskboardApi(req, res, {
        preflightStages: io.preflightStages,
        getRunSnapshots: (runs) => io.getRunSnapshots(runs),
        resolveActor: (r) =>
          resolveTaskboardActor(r, {
            jwtSecret: io.deps.config.gateway.accessToken,
            isCommercialJwt: (t) => io.verifyCommercialJwt(t) !== null,
            // 必须传真实校验结果:taskboard 层不得自行嗅 X-OpenClaude-Bridge-Nonce,
            // 否则容器内 agent 伪造该头即可冒充 human 自批自结单。
            bridgeVerified: io.checkBridgeBypass(r, url),
          }),
        listAgents: async () => {
          const view = await io._getAgentsConfigUserView()
          return view.agents.map((a) => ({
            id: a.id,
            name: a.displayName ?? a.id,
            model: a.model ?? '',
            description: a.greeting ?? '',
          }))
        },
      }).catch((err) => io.sendInternalError(res, err))
      return true
    },
  ),
  // ── Tasks REST API ──
  predicateRoute(
    '/api/tasks',
    (_req, url) => url.pathname === '/api/tasks',
    (io, req, res, _url) => {
      io._handleTasksApi(req, res).catch((err) => io.sendInternalError(res, err))
      return true
    },
  ),
  regexRoute(
    '/api/tasks/:1',
    (_req, url) => url.pathname.match(/^\/api\/tasks\/([a-zA-Z0-9_-]+)$/),
    (io, req, res, _url, taskItemMatch) => {
      io._handleTaskItem(req, res, taskItemMatch[1]).catch((err) => io.sendInternalError(res, err))
      return true
    },
  ),
  predicateRoute(
    'GET /api/tasks-executions',
    (req, url) => url.pathname === '/api/tasks-executions' && req.method === 'GET',
    (io, _req, res, _url) => {
      io._taskStore
        .recentExecutions()
        .then((execs) => io.sendJson(res, 200, { executions: execs }))
        .catch((err) => io.sendInternalError(res, err))
      return true
    },
  ),
  // ── Webhook REST API ──
  predicateRoute(
    'GET /api/webhooks',
    (req, url) => url.pathname === '/api/webhooks' && req.method === 'GET',
    (io, _req, res, _url) => {
      const list = filterUserVisibleByAgentField(io.webhookRouter?.list() ?? [])
      io.sendJson(res, 200, { webhooks: list })
      return true
    },
  ),
  regexRoute(
    '/api/webhooks/:1',
    (_req, url) => url.pathname.match(/^\/api\/webhooks\/([a-zA-Z0-9_-]+)$/),
    (io, req, res, _url, webhookMatch) => {
      io._handleWebhook(req, res, webhookMatch[1]).catch((err) => io.sendInternalError(res, err))
      return true
    },
  ),
  // ── WeChat (iLink) bot binding ──
  // Multi-tenant: each OC user can bind their own WeChat bot via QR scan.
  //   POST   /api/wechat/pair/start            → { qrcode, qrcodeImgContent }
  //   POST   /api/wechat/pair/poll  {qrcode}   → { status, accountId?, loginUserId? }
  //   GET    /api/wechat/binding               → { binding: {...} | null }
  //   DELETE /api/wechat/binding               → { ok: true }
  //   PUT    /api/wechat/binding/status        → { ok, status }
  predicateRoute(
    '/api/wechat/*',
    (_req, url) => url.pathname.startsWith('/api/wechat/'),
    (io, req, res, url) => {
      io._handleWechat(req, res, url.pathname).catch((err) => io.sendInternalError(res, err))
      return true
    },
  ),
  // ── Claude.ai OAuth ──
  predicateRoute(
    '/api/auth/claude/start',
    (_req, url) => url.pathname === '/api/auth/claude/start',
    (io, req, res, _url) => {
      io.handleOAuthStart(req, res).catch((err) => io.sendInternalError(res, err))
      return true
    },
  ),
  predicateRoute(
    '/api/auth/claude/callback',
    (_req, url) => url.pathname === '/api/auth/claude/callback',
    (io, req, res, _url) => {
      io.handleOAuthCallback(req, res).catch((err) => io.sendInternalError(res, err))
      return true
    },
  ),
  predicateRoute(
    '/api/auth/claude/status',
    (_req, url) => url.pathname === '/api/auth/claude/status',
    (io, _req, res, _url) => {
      const oauth = io.deps.config.auth.claudeOAuth
      io.sendJson(res, 200, {
        authenticated: !!oauth?.accessToken,
        expiresAt: oauth?.expiresAt,
        scope: oauth?.scope,
      })
      return true
    },
  ),
  // ── Streaming upload endpoint (Plan B 2026-05-09) ──
  // Single-file raw-binary POST. Body streams directly to disk, sha256-named.
  // Replaces sending base64 inside the WS frame's `_media[i].base64` — that
  // path bloated `client_sessions.messages` JSON and triggered the 2026-05-08
  // event-loop stall incident. See feedback memo
  // v3_attachments_independent_channel.md.
  predicateRoute(
    'POST /api/uploads',
    (req, url) => url.pathname === '/api/uploads' && req.method === 'POST',
    (io, req, res, _url) => {
      io.handleUpload(req, res).catch((err) => io.sendInternalError(res, err))
      return true
    },
  ),
  // ── Media file serving ──
  // Serve user-uploaded and MCP-generated media files for inline rendering.
  // Async because v3 commercial uploads dir resolution touches PG + docker.
  // Use the same dispatch pattern as /api/uploads to keep handleHttp sync.
  regexRoute(
    '/api/media/:1',
    (_req, url) => url.pathname.match(/^\/api\/media\/(.+)$/),
    (io, req, res, _url, mediaMatch) => {
      io.handleMediaGet(req, res, mediaMatch[1]).catch((err) => {
        if (!res.headersSent) {
          io.sendInternalError(res, err)
        } else {
          try {
            res.end()
          } catch {
            /* socket gone */
          }
        }
      })
      return true
    },
  ),
  // ── File serving by absolute path (whitelist-restricted) ──
  // Async dispatch because v3 commercial requires resolving the caller's
  // {uploads, generated} dirs for a user-scoped allowlist predicate (DB +
  // docker inspect). Pattern mirrors /api/uploads and /api/media.
  predicateRoute(
    '/api/file',
    (_req, url) => url.pathname === '/api/file',
    (io, req, res, url) => {
      io.handleApiFile(req, res, url).catch((err) => {
        if (!res.headersSent) {
          io.sendInternalError(res, err)
        } else {
          try {
            res.end()
          } catch {
            /* socket gone */
          }
        }
      })
      return true
    },
  ),
]
