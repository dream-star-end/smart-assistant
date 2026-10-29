/**
 * Gateway HTTP entry: request routing, static cache, hardened file open, session cookie/token/JWT auth, body readers
 *
 * Moved verbatim out of Gateway (server.ts) — FINDINGS §7.6, OCV5-493. The class
 * keeps one-line forwarders that call these with the instance as `this`, so behaviour, closures and
 * `this.x` reads/writes are unchanged. GatewayHttpHost lists exactly the Gateway members this code
 * touches (typed from the class itself).
 */
import { PRE_AUTH_ROUTES } from './routes/preAuth.js'
import { PLATFORM_ROUTES } from './routes/platform.js'
import { SYSTEM_ROUTES } from './routes/system.js'
import { APP_CONFIG_ROUTES } from './routes/appConfig.js'
import { AGENT_ROUTES } from './routes/agents.js'
import { WORKSPACE_API_ROUTES } from './routes/workspaceApi.js'
import { dispatchRoutes } from './routes/routeTable.js'
import { handleClientSessionsHttp } from './routes/clientSessions.js'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { constants as fsConstants, closeSync, openSync, readFileSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, resolve } from 'node:path'
import { checkLocalBridge } from './localBridgeAuth.js'
import { resolveOpenedPath } from './openedPath.js'
import { readConfig, writeConfig } from '@openclaude/storage'
import { checkToken, verifyJwt } from './auth.js'
import { httpRequestsTotal, httpRequestDuration } from './metrics.js'
import { isFileAllowed, isFileBlocked } from './gatewayFilePolicy.js'
import { CLAUDE_OAUTH_USER_AGENT, JWT_TTL_SECONDS } from './server.js'
import { shouldLogHttpAccess, mimeFor, staticCacheControl, staticFileCandidates } from './httpUploadStatic.js'
import type { Gateway } from './server.js'

export interface GatewayHttpHost {
  OAUTH_PROVIDERS: Gateway['OAUTH_PROVIDERS']
  _containerPreview: Gateway['_containerPreview']
  _handleHttpAfterCommercial: Gateway['_handleHttpAfterCommercial']
  _hasValidDelegateContext: Gateway['_hasValidDelegateContext']
  _isDelegateHttpPath: Gateway['_isDelegateHttpPath']
  _serveStaticCached: Gateway['_serveStaticCached']
  _shuttingDown: Gateway['_shuttingDown']
  _staticCacheFreshOnDisk: Gateway['_staticCacheFreshOnDisk']
  _staticFileCache: Gateway['_staticFileCache']
  agentRoutesIo: Gateway['agentRoutesIo']
  appConfigRoutesIo: Gateway['appConfigRoutesIo']
  checkBridgeBypass: Gateway['checkBridgeBypass']
  checkHttpAuth: Gateway['checkHttpAuth']
  clientSessionsIo: Gateway['clientSessionsIo']
  deps: Gateway['deps']
  extractToken: Gateway['extractToken']
  isHttps: Gateway['isHttps']
  log: Gateway['log']
  platformRoutesIo: Gateway['platformRoutesIo']
  preAuthRoutesIo: Gateway['preAuthRoutesIo']
  sendJson: Gateway['sendJson']
  sessions: Gateway['sessions']
  systemRoutesIo: Gateway['systemRoutesIo']
  verifyCommercialJwt: Gateway['verifyCommercialJwt']
  workspaceApiRoutesIo: Gateway['workspaceApiRoutesIo']
}

/** Known route prefixes for metrics normalization (avoids high-cardinality labels). */
const KNOWN_ROUTES = [
  '/api/healthz',
  '/api/doctor',
  '/api/usage',
  '/api/usage/events',
  '/api/runs',
  '/api/sessions',
  '/api/sessions/list',
  '/api/sessions/search',
  '/api/sessions/batch',
  '/api/sessions/read-all',
  '/api/chat-projects',
  '/api/project-assets',
  '/api/config',
  '/api/features',
  '/api/agents',
  '/api/collaboration-config',
  '/api/search',
  '/api/cron',
  '/api/cron/channels',
  '/api/board',
  '/api/board/projects',
  '/api/board/tickets',
  '/api/board/pipelines',
  '/api/board/agents',
  '/api/board/settings',
  '/api/board/stats/cost',
  '/api/board/templates',
  '/api/board/reports/weekly',
  '/api/delegate/wait',
  '/api/tasks',
  '/api/tasks-executions',
  '/api/webhooks',
  '/api/wechat/pair/start',
  '/api/wechat/pair/poll',
  '/api/wechat/pair/cancel',
  '/api/wechat/binding',
  '/api/wechat/binding/status',
  '/api/auth/session',
  '/api/auth/logout',
  '/api/auth/claude/start',
  '/api/auth/claude/callback',
  '/api/auth/claude/status',
  '/api/file',
  '/healthz',
  '/metrics',
]

/** Normalize URL paths for metrics labels (replace dynamic IDs with :id to avoid high cardinality). */
function normalizePath(p: string): string {
  // Exact match for known routes
  if (KNOWN_ROUTES.includes(p)) return p
  // Dynamic API routes — normalize IDs
  const normalized = p
    .replace(
      /\/api\/sessions\/[a-zA-Z0-9_-]+\/inflight-delegates$/,
      '/api/sessions/:id/inflight-delegates',
    )
    .replace(/\/api\/sessions\/[a-zA-Z0-9_-]+\/read$/, '/api/sessions/:id/read')
    .replace(/\/api\/agents\/[a-zA-Z0-9_-]+\/skills\/[a-z0-9-]+/, '/api/agents/:id/skills/:name')
    .replace(/\/api\/skills\/[a-z0-9-]+/, '/api/skills/:name')
    .replace(/\/api\/agents\/[a-zA-Z0-9_-]+\/([a-z]+)/, '/api/agents/:id/$1')
    .replace(/\/api\/agents\/[a-zA-Z0-9_-]+/, '/api/agents/:id')
    .replace(/\/api\/cron\/[a-zA-Z0-9_-]+/, '/api/cron/:id')
    .replace(/\/api\/chat-projects\/[a-zA-Z0-9_-]+\/restore/, '/api/chat-projects/:id/restore')
    .replace(/\/api\/chat-projects\/[a-zA-Z0-9_-]+/, '/api/chat-projects/:id')
    .replace(/\/api\/project-assets\/[a-zA-Z0-9_-]+\/versions/, '/api/project-assets/:id/versions')
    .replace(/\/api\/project-assets\/[a-zA-Z0-9_-]+\/restore/, '/api/project-assets/:id/restore')
    .replace(/\/api\/project-assets\/[a-zA-Z0-9_-]+/, '/api/project-assets/:id')
    .replace(/\/api\/board\/projects\/[^/]+\/board/, '/api/board/projects/:id/board')
    .replace(
      /\/api\/board\/projects\/[^/]+\/context\/preview/,
      '/api/board/projects/:id/context/preview',
    )
    .replace(/\/api\/board\/projects\/[^/]+\/ensure/, '/api/board/projects/:id/ensure')
    .replace(
      /\/api\/board\/projects\/[^/]+\/workspace\/file/,
      '/api/board/projects/:id/workspace/file',
    )
    .replace(/\/api\/board\/projects\/[^/]+\/workspace$/, '/api/board/projects/:id/workspace')
    .replace(/\/api\/board\/projects\/[^/]+\/context/, '/api/board/projects/:id/context')
    .replace(
      /\/api\/board\/projects\/[^/]+\/memories\/[^/]+\/[a-z]+/,
      '/api/board/projects/:id/memories/:file/:action',
    )
    .replace(/\/api\/board\/projects\/[^/]+\/memories/, '/api/board/projects/:id/memories')
    .replace(/\/api\/board\/projects\/[^/]+/, '/api/board/projects/:id')
    .replace(/\/api\/board\/tickets\/[^/]+\/[a-z_]+/, '/api/board/tickets/:id/:action')
    .replace(/\/api\/board\/tickets\/[^/]+/, '/api/board/tickets/:id')
    .replace(/\/api\/board\/pipelines\/[^/]+\/reorder/, '/api/board/pipelines/:id/reorder')
    .replace(/\/api\/board\/pipelines\/[^/]+\/stages/, '/api/board/pipelines/:id/stages')
    .replace(/\/api\/board\/pipelines\/[^/]+/, '/api/board/pipelines/:id')
    .replace(/\/api\/board\/stages\/[^/]+/, '/api/board/stages/:id')
    .replace(/\/api\/board\/runs\/[^/]+\/context/, '/api/board/runs/:id/context')
    .replace(/\/api\/board\/runs\/[^/]+/, '/api/board/runs/:id')
    .replace(/\/api\/board\/relations\/[^/]+/, '/api/board/relations/:id')
    .replace(/\/api\/board\/templates\/[^/]+\/apply/, '/api/board/templates/:id/apply')
    .replace(/\/api\/board\/templates\/[^/]+/, '/api/board/templates/:id')
    .replace(/\/api\/tasks\/[a-zA-Z0-9_-]+/, '/api/tasks/:id')
    .replace(/\/api\/webhooks\/[a-zA-Z0-9_-]+/, '/api/webhooks/:id')
    .replace(/\/api\/media\/.+/, '/api/media/:file')
  if (normalized !== p) return normalized
  // OpenAI compat
  if (p.startsWith('/v1/')) return '/v1/:endpoint'
  // Static files and unknown paths — collapse to prevent cardinality explosion
  return '/__other__'
}

// ───────── HTTP ─────────
export function handleHttp(this: GatewayHttpHost, req: IncomingMessage, res: ServerResponse): void {
  // Ingress guard: refuse new work once shutdown has begun
  if (this._shuttingDown) {
    res.statusCode = 503
    res.setHeader('Connection', 'close')
    res.setHeader('Content-Type', 'text/plain')
    res.end('shutting down')
    return
  }

  // V5 direct webpage preview: only the commercial master can reach this
  // signed internal path. It must run before commercial/gateway routing so
  // the user app can never collide with a platform API path.
  try {
    if (this._containerPreview.handleHttp(req, res)) return
  } catch (err) {
    this.log.error('containerPreview.handleHttp threw', undefined, err)
    if (!res.headersSent) {
      res.statusCode = 500
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.end('preview proxy error')
    } else if (!res.writableEnded) {
      try {
        res.destroy()
      } catch {}
    }
    return
  }

  // V3 2H: 商业化模块优先 — 其 router 自管 auth + 输入校验 + status code,
  // 返 true 即"已处理",gateway 不再走自家 /api/auth/login 等路径。
  // 必须在 security headers 之前,否则 commercial 自己设置的 CSP/headers 会被覆盖。
  if (this.deps.commercial) {
    const r = this.deps.commercial.handle(req, res)
    if (r === true) return
    if (r && typeof (r as Promise<boolean>).then === 'function') {
      ;(r as Promise<boolean>)
        .then((handled) => {
          if (handled) return
          this._handleHttpAfterCommercial(req, res)
        })
        .catch((err) => {
          this.log.error('commercial.handle threw', undefined, err)
          if (!res.headersSent) {
            try {
              res.statusCode = 500
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ error: { code: 'INTERNAL', message: 'commercial error' } }))
            } catch {}
          } else {
            try {
              res.end()
            } catch {}
          }
        })
      return
    }
    // false 同步 → 走 gateway 路由
  }
  this._handleHttpAfterCommercial(req, res)
}

export function _handleHttpAfterCommercial(
  this: GatewayHttpHost,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const reqStart = Date.now()
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  const method = req.method ?? 'GET'
  const path = url.pathname

  // M1: Security headers on every response
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  // Cloudflare Turnstile widget iframe (challenges.cloudflare.com) needs a
  // handful of sensor/attestation features delegated to it; default deny
  // policy makes the widget hang at "before-interactive" and never produce a
  // token (silent failure — user sees blank widget area). See:
  // https://developers.cloudflare.com/turnstile/troubleshooting/permissions-policy
  // microphone=(self): 允许同源页面用 getUserMedia 录音(语音输入 /ws/voice-transcribe）。
  // 之前 microphone=() 对所有源(含自身)禁用 → 浏览器报 "Permissions policy violation:
  // microphone is not allowed" → 语音输入彻底不可用。用户仍需显式授予麦克风权限,无安全损失。
  res.setHeader(
    'Permissions-Policy',
    [
      'camera=()',
      'microphone=(self)',
      'geolocation=()',
      'accelerometer=(self "https://challenges.cloudflare.com")',
      'gyroscope=(self "https://challenges.cloudflare.com")',
      'magnetometer=(self "https://challenges.cloudflare.com")',
      'xr-spatial-tracking=(self "https://challenges.cloudflare.com")',
      'attribution-reporting=(self "https://challenges.cloudflare.com")',
      'private-state-token-issuance=(self "https://challenges.cloudflare.com")',
      'private-state-token-redemption=(self "https://challenges.cloudflare.com")',
    ].join(', '),
  )

  // Instrument response — record metrics after response finishes
  res.on('finish', () => {
    const duration = Date.now() - reqStart
    const status = String(res.statusCode)
    httpRequestsTotal.inc({ method, path: normalizePath(path), status })
    httpRequestDuration.observe(duration, { method, path: normalizePath(path) })
    // Log non-static requests (skip static assets to reduce noise)
    if (shouldLogHttpAccess(path, res.statusCode, duration)) {
      this.log.info('http', { method, path, status: res.statusCode, durationMs: duration })
    }
  })
  // Pre-auth routes (local relays, project search, login): dispatched BEFORE the auth gate: routes/preAuth.ts (FINDINGS §7.5 2b).
  if (dispatchRoutes(PRE_AUTH_ROUTES, this.preAuthRoutesIo, req, res, url)) return

  // Routes that need auth
  // All /api/*, /v1/*, and /metrics endpoints require auth except healthz
  const needsAuth =
    (url.pathname.startsWith('/api/') && url.pathname !== '/api/healthz') ||
    url.pathname.startsWith('/v1/') ||
    url.pathname === '/metrics'
  // v3 file proxy: HOST gateway → container /api/file or /api/media via docker bridge
  // bypasses checkHttpAuth if all four conditions hold (see checkBridgeBypass).
  const bridgeVerified = needsAuth ? this.checkBridgeBypass(req, url) : false
  const delegateAuthedByContext =
    this._isDelegateHttpPath(url.pathname) && this._hasValidDelegateContext(req)
  if (
    needsAuth &&
    !bridgeVerified &&
    !this.checkHttpAuth(req) &&
    !checkLocalBridge(req) &&
    !delegateAuthedByContext
  ) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'unauthorized' }))
    return
  }
  // Platform routes (/v1/, auth session/logout, /internal/v3/*): routes/platform.ts (FINDINGS §7.5 2b).
  if (dispatchRoutes(PLATFORM_ROUTES, this.platformRoutesIo, req, res, url)) return
  // System routes (web-trace, healthz, metrics, version, doctor, usage, runs): routes/system.ts (FINDINGS §7.5 2b).
  if (dispatchRoutes(SYSTEM_ROUTES, this.systemRoutesIo, req, res, url)) return
  // Client session routes (/api/sessions/*): routes/clientSessions.ts (FINDINGS §7 step 2a).
  if (handleClientSessionsHttp(this.clientSessionsIo, req, res, url)) return
  // App config routes (/api/features, /api/config): routes/appConfig.ts (FINDINGS §7.5 2b).
  if (dispatchRoutes(APP_CONFIG_ROUTES, this.appConfigRoutesIo, req, res, url)) return
  // Agent routes (agents, persona, memory, auto-dream optimizer, skills, skill eval/training, release jobs, messaging, delegate, advisor, ask-user, collaboration config): routes/agents.ts (FINDINGS §7.5 2b).
  if (dispatchRoutes(AGENT_ROUTES, this.agentRoutesIo, req, res, url)) return
  // Workspace API routes (changelog, feedback, search, cron, board, tasks, webhooks, wechat, Claude auth, uploads, media, file): routes/workspaceApi.ts (FINDINGS §7.5 2b).
  if (dispatchRoutes(WORKSPACE_API_ROUTES, this.workspaceApiRoutesIo, req, res, url)) return

  // ── API / WS 404 守卫（仅 spa 模式）────────────────────────────────────
  // 走到这里说明请求未匹配上方任何 /api/* 或 /ws/* 路由(所有已匹配路由都已 return)。
  // spa 模式必须在 SPA fallback 之前对未匹配的 /api/*、/ws/* 显式返回 404 JSON:
  // 否则它们会落到下方 SPA fallback 拿到 index.html(200),新 React client 调错端点
  // 时会把 HTML 当 JSON 解析直接抛错、难定位。
  // 严格 gate 在 staticMode==='spa':vanilla(v3) 分支完全不进此守卫,行为字节级不变
  // (v3 零影响);且只拦"本就该 404 的兜底",不触碰任何已匹配路由。
  if (
    this.deps.staticMode === 'spa' &&
    (url.pathname.startsWith('/api/') || url.pathname === '/ws' || url.pathname.startsWith('/ws/'))
  ) {
    this.sendJson(res, 404, { error: 'not found' })
    return
  }

  // 静态 web UI (with in-memory cache)
  if (serveWebStatic.call(this, url, req, res)) return
  res.writeHead(404)
  res.end('not found')
}

/**
 * 静态 web UI(含 /admin 302 与 SPA 回退)。true = 已响应;false = 交给调用方 404。
 * 自 _handleHttpAfterCommercial 原样抽出以便单测(OCV5-632);在原逻辑上只多两件事,
 * 规则都在 staticFileCandidates:spa 下 /assets/* 在 webRoot 未命中时回落资产池(按真实路径
 * 判包含),spa 下 .map 一律 404(路径归一后判)。未配置资产池时除 .map 外与抽出前逐字一致。
 */
export function serveWebStatic(
  this: Pick<GatewayHttpHost, 'deps' | '_serveStaticCached'>,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const webRoot = this.deps.webRoot
  if (!webRoot) return false
  // /admin → /admin.html:React 管理后台是 web-react 的第二 Vite 入口,产物是 dist 里
  // 真实存在的 /admin.html。提供一个无扩展名的 /admin 便捷入口,302 到真实文件后由下方
  // 通用静态服务命中(no-cache,同 index.html);否则 /admin 会落到 SPA fallback 拿到用户端
  // index.html。仅 spa(v5 Aurora)模式:vanilla(v3/personal)产物不含 admin.html。
  if (this.deps.staticMode === 'spa' && url.pathname === '/admin') {
    res.writeHead(302, { Location: '/admin.html' })
    res.end()
    return true
  }
  const safePath = url.pathname === '/' ? '/index.html' : url.pathname
  // Cache-Control 按托管模式分流(规则单一权威 = staticCacheControl)。两模式共用下方的
  // ETag/304、路径白名单与 SPA 回退;仅本头不同 → vanilla 分支与历史完全一致(v3 零变化)。
  // 资产池命中同样落在 /assets/ 下,沿用 immutable(内容哈希文件名)。
  const cacheHeader = staticCacheControl(safePath, this.deps.staticMode)
  const candidates = staticFileCandidates(safePath, {
    webRoot,
    staticMode: this.deps.staticMode,
    assetsPool: this.deps.webAssetsPool,
  })
  if (candidates === null) return false
  for (const filePath of candidates) {
    if (this._serveStaticCached(filePath, cacheHeader, req, res, mimeFor(filePath))) return true
  }
  // SPA fallback — only for navigation requests (no file extension)
  // Static assets (.js/.css/.map/.min.js etc.) should 404, not serve index.html
  const hasExtension = /\.\w+$/.test(url.pathname)
  if (!hasExtension) {
    const indexPath = resolve(webRoot, 'index.html')
    if (this._serveStaticCached(indexPath, 'no-cache', req, res, 'text/html')) return true
  }
  return false
}

/**
 * 静态文件内存缓存的统一命中+读盘路径(通用静态资产与 SPA fallback 的 index.html 共用)。
 * 缓存条目带源文件 mtimeMs,命中时 stat 回盘比对:dist 被 rsync 覆盖(mtime 变)后
 * 下一个请求即拿到新内容 —— 与 ws/frontendBuild.ts 版本探针同语义自愈,漏重启 master
 * 时不会出现「WS 帧已收敛到新 build、HTTP 却一直吐旧 index.html」的分裂(那种分裂会让
 * 前端 update banner 陷入刷新死循环)。
 * 返回 true = 已响应(200/304);false = 磁盘无此文件,由调用方走兜底/404。
 */
export function _serveStaticCached(
  this: GatewayHttpHost,
  filePath: string,
  cacheHeader: string,
  req: IncomingMessage,
  res: ServerResponse,
  mime: string,
): boolean {
  const cached = this._staticFileCache.get(filePath)
  if (cached && this._staticCacheFreshOnDisk(filePath, cached)) {
    if (req.headers['if-none-match'] === cached.etag) {
      res.writeHead(304)
      res.end()
      return true
    }
    res.writeHead(200, {
      'Content-Type': cached.mime,
      ETag: cached.etag,
      'Cache-Control': cacheHeader,
    })
    res.end(cached.content)
    return true
  }
  try {
    const s = statSync(filePath)
    if (!s.isFile()) return false
    const content = readFileSync(filePath)
    const etag = `"${createHash('md5').update(content).digest('hex').slice(0, 16)}"`
    if (this._staticFileCache.size >= 200) {
      const firstKey = this._staticFileCache.keys().next().value
      if (firstKey !== undefined) this._staticFileCache.delete(firstKey)
    }
    this._staticFileCache.set(filePath, {
      content,
      mime,
      etag,
      mtimeMs: s.mtimeMs,
      ino: s.ino,
      size: s.size,
    })
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304)
      res.end()
      return true
    }
    res.writeHead(200, { 'Content-Type': mime, ETag: etag, 'Cache-Control': cacheHeader })
    res.end(content)
    return true
  } catch {
    return false
  }
}

/**
 * 缓存条目与磁盘是否仍一致(mtimeMs + inode + size 比对;stat 失败/文件已删 → 视为失效)。
 * inode/size 是为 P0-Web(OCV5-489):webRoot 是 overlay 符号链接,换指向后同一路径是
 * 另一个文件,cp -a 保留的 mtime 可能与旧文件相同。缺字段的旧条目只比 mtime。
 */
export function _staticCacheFreshOnDisk(
  this: GatewayHttpHost,
  filePath: string,
  entry: { mtimeMs: number; ino?: number; size?: number },
): boolean {
  try {
    const s = statSync(filePath)
    if (s.mtimeMs !== entry.mtimeMs) return false
    if (entry.ino !== undefined && s.ino !== entry.ino) return false
    if (entry.size !== undefined && s.size !== entry.size) return false
    return true
  } catch {
    return false
  }
}

/**
 * v3 file proxy: open a file with TOCTOU-hardened realpath checking.
 * Callers must have already verified `realPath` against allowlist/blocklist.
 *
 *  - openSync(O_NOFOLLOW): last-component symlink defense.
 *  - realpathSync(/proc/self/fd/<fd>) === realPath: middle-directory
 *    symlink race defense. An attacker who swaps a parent directory
 *    between our allowlist check and open() will show up here with
 *    fdReal ≠ realPath.
 *  - isFileAllowed/isFileBlocked re-checked on fdReal as fail-closed
 *    defense (redundant but cheap).
 *
 * `extraAllowed` is the **caller-provided** user-scoped predicate. Callers
 * in v3 commercial must NOT pull a global textual predicate from `deps`
 * — that would re-introduce the cross-tenant IDOR risk where user A can
 * read user B's docker volume media by absolute path. Caller constructs
 * a closure over the **current request's** resolved `{uploads, generated}`
 * dirs and passes that down.
 *
 * Returns an fd on success; writes 403/404 to res and returns null on failure.
 */
export function openFileHardened(
  this: GatewayHttpHost,
  res: ServerResponse,
  realPath: string,
  agentCwds: string[],
  extraAllowed?: (p: string) => boolean,
): number | null {
  let fd: number
  try {
    fd = openSync(realPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch {
    res.writeHead(404)
    res.end('not found')
    return null
  }
  let fdReal: string
  try {
    fdReal = resolveOpenedPath(fd, realPath)
  } catch {
    closeSync(fd)
    res.writeHead(404)
    res.end('not found')
    return null
  }
  // Re-check via fd realpath as fail-closed defense (redundant with caller's
  // upstream check, but cheap). The user-scoped `extraAllowed` predicate
  // covers v3 commercial docker-volume paths for the **current** uid.
  if (
    fdReal !== realPath ||
    !isFileAllowed(fdReal, agentCwds, extraAllowed) ||
    isFileBlocked(fdReal)
  ) {
    closeSync(fd)
    res.writeHead(403)
    res.end('access denied')
    return null
  }
  return fd
}

// 30 days

/** Set HttpOnly session cookie on response — stores the verified auth token so
 *  <img src="/api/file/...">, <audio>, <video> can access protected media on
 *  the same origin without JS-supplied headers.
 *
 *  Rules:
 *   - JWT mode: store the JWT verbatim (preserves userId); Max-Age tracks the
 *     JWT's remaining exp so the cookie can never outlive its token, avoiding
 *     silent 401 storms on subresource requests. Floored at 60s to avoid
 *     setting an already-dead cookie on the same response that just authed.
 *   - Legacy raw-token mode: store the raw accessToken; Max-Age capped at
 *     JWT_TTL_SECONDS since the raw token has no server-side revocation.
 *   - Otherwise (e.g. JWT just expired in the microsecond race between
 *     checkHttpAuth and here): refuse. We do NOT silently downgrade a JWT
 *     user's identity into the shared 'default' raw-token principal; caller
 *     sees `false` and returns 401 so the client can re-login cleanly.
 *
 *  Returns true if a cookie was set; false if the caller should 401. */
export function setSessionCookie(
  this: GatewayHttpHost,
  res: ServerResponse,
  req: IncomingMessage,
): boolean {
  const t = this.extractToken(req)
  const secure = this.isHttps(req) ? '; Secure' : ''

  const jwt = verifyJwt(t, this.deps.config.gateway.accessToken)
  if (jwt && typeof jwt.exp === 'number') {
    // Clamp remaining seconds to [60, JWT_TTL_SECONDS]. Max-Age=0 semantically
    // means "delete cookie"; a positive floor keeps the cookie alive long
    // enough for the client to renew or get a clean 401 on the next request.
    const remaining = jwt.exp - Math.floor(Date.now() / 1000)
    const maxAge = Math.max(60, Math.min(remaining, JWT_TTL_SECONDS))
    res.setHeader(
      'Set-Cookie',
      `oc_session=${t}; HttpOnly; SameSite=Strict${secure}; Path=/api/; Max-Age=${maxAge}`,
    )
    return true
  }
  if (checkToken(t, this.deps.config.gateway.accessToken)) {
    // Legacy raw-token auth. `t` is constant-time equal to the configured
    // accessToken (which came from trusted config), so it's safe to echo
    // into Set-Cookie without further sanitization.
    res.setHeader(
      'Set-Cookie',
      `oc_session=${t}; HttpOnly; SameSite=Strict${secure}; Path=/api/; Max-Age=${JWT_TTL_SECONDS}`,
    )
    return true
  }
  // V3 commercial JWT — same Max-Age clamping logic as personal-version JWT.
  const cm = this.verifyCommercialJwt(t)
  if (cm) {
    const remaining = cm.exp - Math.floor(Date.now() / 1000)
    const maxAge = Math.max(60, Math.min(remaining, JWT_TTL_SECONDS))
    res.setHeader(
      'Set-Cookie',
      `oc_session=${t}; HttpOnly; SameSite=Strict${secure}; Path=/api/; Max-Age=${maxAge}`,
    )
    return true
  }
  return false
}

export async function _refreshToken(
  this: GatewayHttpHost,
  providerKey: string,
  oauth: { refreshToken: string; scope: string; expiresAt: number },
): Promise<void> {
  const prov = this.OAUTH_PROVIDERS[providerKey]
  if (!prov || !prov.tokenUrl) {
    this.log.warn('oauth skipping refresh', {
      provider: providerKey,
      reason: !prov ? 'unknown provider' : 'no tokenUrl configured',
    })
    return
  }

  try {
    const tokenRes = await fetch(prov.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(providerKey === 'claude' ? { 'User-Agent': CLAUDE_OAUTH_USER_AGENT } : {}),
      },
      // 出站硬超时:refresh 挂起会卡住定时续期链路(与 commercial refresh.ts 同款收口)。
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: prov.clientId,
        refresh_token: oauth.refreshToken,
        ...(providerKey === 'claude' ? { scope: prov.scopes } : {}),
      }),
    })

    if (!tokenRes.ok) {
      this.log.error('oauth refresh failed', { provider: providerKey, status: tokenRes.status })
      return
    }

    const tokens = (await tokenRes.json()) as any
    const config = await readConfig()
    if (config) {
      const refreshed = {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? oauth.refreshToken,
        expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
        scope: tokens.scope ?? oauth.scope,
      }
      if (providerKey === 'claude') config.auth.claudeOAuth = refreshed
      else (config.auth as any)[`${providerKey}OAuth`] = refreshed
      await writeConfig(config)
      this.deps.config = config
      this.sessions.updateConfig(config)
      this.log.info('oauth token refreshed', {
        provider: providerKey,
        expiresInSec: tokens.expires_in,
      })
    }
  } catch (err) {
    this.log.error('oauth refresh error', { provider: providerKey }, err)
  }
}

/**
 * Verify an HS256 JWT signed by the commercial module's jwtSecret.
 * Synchronous (uses node:crypto) so we don't have to make checkHttpAuth /
 * getUserId async — those are called from many spots in this file and
 * propagating async would balloon the diff.
 *
 * Accepts payload shape: { sub: string, role: 'user'|'admin', iat, exp, jti }.
 * Returns null on any verification failure (bad alg, bad sig, expired,
 * malformed payload, or commercial module not loaded).
 */
export function verifyCommercialJwt(
  this: GatewayHttpHost,
  token: string,
): { sub: string; role: 'user' | 'admin'; exp: number } | null {
  if (!token || !this.deps.commercial?.jwtSecret) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [headerB64, payloadB64, sigB64] = parts
  let header: any
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString())
  } catch {
    return null
  }
  if (header?.alg !== 'HS256') return null
  let actualSig: Buffer
  try {
    actualSig = Buffer.from(sigB64, 'base64url')
  } catch {
    return null
  }
  const expectedSig = createHmac('sha256', this.deps.commercial.jwtSecret)
    .update(`${headerB64}.${payloadB64}`)
    .digest()
  if (expectedSig.length !== actualSig.length) return null
  if (!timingSafeEqual(expectedSig, actualSig)) return null
  let payload: any
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString())
  } catch {
    return null
  }
  const now = Math.floor(Date.now() / 1000)
  if (typeof payload?.exp !== 'number' || payload.exp <= now) return null
  if (typeof payload?.sub !== 'string' || payload.sub.length === 0) return null
  if (payload.role !== 'user' && payload.role !== 'admin') return null
  return { sub: payload.sub, role: payload.role, exp: payload.exp }
}

export function checkHttpAuth(this: GatewayHttpHost, req: IncomingMessage): boolean {
  const t = this.extractToken(req)
  // Try JWT first (multi-user mode)
  const jwt = verifyJwt(t, this.deps.config.gateway.accessToken)
  if (jwt) return true
  // V3 commercial: accept JWTs signed by commercial module's jwtSecret too,
  // otherwise paths that fall through to gateway (e.g. /api/agents,
  // /api/sessions/*, /api/changelog) would 401 right after a successful
  // commercial login and trigger a token-expired redirect storm.
  if (this.verifyCommercialJwt(t) !== null) return true
  // Fall back to legacy single token
  return checkToken(t, this.deps.config.gateway.accessToken)
}

/** Extract bearer token from request (header, WS protocol, or cookie). */
export function extractToken(this: GatewayHttpHost, req: IncomingMessage): string {
  const authHeader = req.headers.authorization?.replace(/^Bearer\s+/, '') ?? ''
  const protocols = (req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim())
  const protoToken =
    protocols.includes('bearer') && protocols.length >= 2 ? protocols[protocols.length - 1] : ''
  const cookies = (req.headers.cookie || '').split(';').reduce(
    (acc, c) => {
      const [k, ...v] = c.trim().split('=')
      if (k) acc[k] = v.join('=')
      return acc
    },
    {} as Record<string, string>,
  )
  const cookieToken = cookies.oc_session || ''
  return authHeader || protoToken || cookieToken
}

/** Check if the request arrived over HTTPS (direct TLS or behind a trusted reverse proxy like cloudflared).
 * X-Forwarded-Proto is only trusted when the connection originates from a loopback address (127.0.0.1 / ::1),
 * i.e. a local reverse proxy. External connections must use direct TLS.
 */
export function isHttps(this: GatewayHttpHost, req: IncomingMessage): boolean {
  if ((req.socket as any).encrypted === true) return true
  const remoteAddr = req.socket.remoteAddress ?? ''
  // Trust X-Forwarded-Proto only from loopback (127.x.x.x, ::1, IPv4-mapped ::ffff:127.x.x.x)
  const isLoopback =
    remoteAddr === '::1' || remoteAddr.startsWith('127.') || remoteAddr.startsWith('::ffff:127.')
  return isLoopback && req.headers['x-forwarded-proto'] === 'https'
}

/** Get authenticated userId from request. Returns 'default' for legacy token auth. */
export function getUserId(this: GatewayHttpHost, req: IncomingMessage): string {
  const t = this.extractToken(req)
  const jwt = verifyJwt(t, this.deps.config.gateway.accessToken)
  if (jwt?.userId) return jwt.userId
  // Commercial JWT: prefix sub (BIGINT user_id as string) so it cannot
  // collide with personal-version userIds (which are arbitrary usernames).
  // Used as partition key for SQLite client_sessions etc.
  const cm = this.verifyCommercialJwt(t)
  if (cm) return `c:${cm.sub}`
  return 'default'
}

export function readBody(
  this: GatewayHttpHost,
  req: IncomingMessage,
  maxBytes = 10 * 1024 * 1024,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > maxBytes) {
        req.destroy()
        reject(new Error('body too large'))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}
