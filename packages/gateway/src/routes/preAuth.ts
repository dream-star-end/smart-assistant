import { SYSTEM_HELP_LOCAL_PATH } from '../systemHelpRelay.js'
/**
 * Pre-auth routes (local relays, project search, login): dispatched BEFORE the auth gate
 *
 * Ordered route table moved out of Gateway._handleHttpAfterCommercial (FINDINGS §7.5 step 2b,
 * OCV5-468). Each entry's match is the original branch condition and its handler the original
 * branch body (`return` → `return true`; a branch that falls through returns false; `path` /
 * `method` are the method's own `url.pathname` / `req.method ?? 'GET'` copies), so dispatchRoutes()
 * over this table behaves exactly like the if-chain it replaces. The Gateway dispatches it at the spot
 * the inline block used to be. Order matters: the first entry whose handler returns true wins.
 *
 * Dependencies are the narrow PreAuthRoutesIo below instead of the whole Gateway (read-only Gateway fields are
 * exposed as getters). Equivalence with the original chain: __tests__/httpRouteTables.test.ts.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { checkToken, verifyPassword, signJwt } from '../auth.js'
import {
  handleV3CodexRelayLocal,
  readV3CodexRelayConfig,
  V3_CODEX_RELAY_PREFIX,
} from '../v3CodexRelay.js'
import {
  handleV5GrokRelayLocal,
  readV5GrokRelayConfig,
  V5_GROK_RELAY_PREFIX,
} from '../v5GrokRelay.js'
import {
  handleV5ZcodeRelayLocal,
  readV5ZcodeRelayConfig,
  V5_ZCODE_RELAY_PREFIX,
} from '../v5ZcodeRelay.js'
import {
  handleV5AntigravityRelayLocal,
  readV5AntigravityRelayConfig,
  V5_ANTIGRAVITY_RELAY_PREFIX,
} from '../v5AntigravityRelay.js'
import {
  handleV3MarketplaceRelayLocal,
  readV3MarketplaceRelayConfig,
  V3_MARKETPLACE_LOCAL_RELAY_PREFIX,
} from '../v3MarketplaceRelay.js'
import { decideSkillLocalRelay, SKILL_LOCAL_RELAY_PREFIX } from '../ocSkillLocalRelay.js'
import { handleProjectSearchLocal, PROJECT_SEARCH_LOCAL_PATH } from '../projectSearchLocal.js'
import type { Gateway, GatewayDeps } from '../server.js'
import { type HttpRoute, predicateRoute, regexRoute } from './routeTable.js'

export interface PreAuthRoutesIo {
  handleSystemHelp?(req: IncomingMessage, res: ServerResponse): Promise<void>
  _handleSkillEvalGenStart(
    req: IncomingMessage,
    res: ServerResponse,
    skillName: string,
  ): Promise<void>
  _handleSkillEvalGenStatus(req: IncomingMessage, res: ServerResponse, runId: string): Promise<void>
  _handleSkillTrainRun(req: IncomingMessage, res: ServerResponse, runId: string): Promise<void>
  _handleSkillTrainStart(
    req: IncomingMessage,
    res: ServerResponse,
    skillName: string,
  ): Promise<void>
  extractToken(req: IncomingMessage): string
  readBody: Gateway['readBody']
  sendInternalError(res: ServerResponse, err: unknown): void
  sendJson(res: ServerResponse, code: number, body: unknown): void
  readonly deps: GatewayDeps
  readonly log: Gateway['log']
  readonly rateLimiter: Gateway['rateLimiter']
  readonly JWT_TTL_SECONDS: (typeof Gateway)['JWT_TTL_SECONDS']
}

export const PRE_AUTH_ROUTES: readonly HttpRoute<PreAuthRoutesIo>[] = [
  predicateRoute('SYSTEM_HELP_LOCAL', (_req, url) => url.pathname === SYSTEM_HELP_LOCAL_PATH, (io, req, res) => {
    if (!io.handleSystemHelp) { io.sendJson(res, 503, { error: { code: 'UNAVAILABLE' } }); return true }
    void io.handleSystemHelp(req, res).catch(() => { if (!res.headersSent && !res.destroyed) io.sendJson(res, 503, { error: { code: 'UNAVAILABLE' } }) })
    return true
  }),
  // v3 commercial Codex local relay(M1a 复活)。Codex CLI uses Authorization
  // for its upstream token, so the container gateway must translate it into a
  // private header and authenticate to master with OPENCLAUDE_V3_CONTAINER_TOKEN.
  // The handler is loopback-only; other bridge containers cannot use it.
  predicateRoute(
    'V3_CODEX_RELAY_PREFIX',
    (_req, url) =>
      url.pathname === V3_CODEX_RELAY_PREFIX ||
      url.pathname.startsWith(`${V3_CODEX_RELAY_PREFIX}/`),
    (io, req, res, _url) => {
      const relayCfg = readV3CodexRelayConfig(process.env)
      if (!relayCfg) {
        io.sendJson(res, 404, {
          error: { code: 'CODEX_RELAY_NOT_CONFIGURED', message: 'codex relay not configured' },
        })
        return true
      }
      handleV3CodexRelayLocal(req, res, relayCfg).catch((err) => {
        io.log.error('v3 codex local relay crashed', undefined, err)
        if (!res.headersSent) {
          try {
            io.sendJson(res, 500, { error: { code: 'INTERNAL', message: 'codex relay crashed' } })
          } catch {}
        } else {
          try {
            res.end()
          } catch {}
        }
      })
      return true
    },
  ),
  predicateRoute(
    'V5_GROK_RELAY_PREFIX',
    (_req, url) =>
      url.pathname === V5_GROK_RELAY_PREFIX || url.pathname.startsWith(`${V5_GROK_RELAY_PREFIX}/`),
    (io, req, res, _url) => {
      const relayCfg = readV5GrokRelayConfig(process.env)
      if (!relayCfg) {
        io.sendJson(res, 404, {
          error: { code: 'GROK_RELAY_NOT_CONFIGURED', message: 'grok relay not configured' },
        })
        return true
      }
      handleV5GrokRelayLocal(req, res, relayCfg).catch((err) => {
        io.log.error('v5 grok local relay crashed', undefined, err)
        if (!res.headersSent) {
          try {
            io.sendJson(res, 500, { error: { code: 'INTERNAL', message: 'grok relay crashed' } })
          } catch {}
        } else {
          try {
            res.end()
          } catch {}
        }
      })
      return true
    },
  ),
  predicateRoute(
    'V5_ZCODE_RELAY_PREFIX',
    (_req, url) =>
      url.pathname === V5_ZCODE_RELAY_PREFIX ||
      url.pathname.startsWith(`${V5_ZCODE_RELAY_PREFIX}/`),
    (io, req, res, _url) => {
      const relayCfg = readV5ZcodeRelayConfig(process.env)
      if (!relayCfg) {
        io.sendJson(res, 404, {
          error: { code: 'ZCODE_RELAY_NOT_CONFIGURED', message: 'zcode relay not configured' },
        })
        return true
      }
      handleV5ZcodeRelayLocal(req, res, relayCfg).catch((err) => {
        io.log.error('v5 zcode local relay crashed', undefined, err)
        if (!res.headersSent) {
          try {
            io.sendJson(res, 500, { error: { code: 'INTERNAL', message: 'zcode relay crashed' } })
          } catch {}
        } else {
          try {
            res.end()
          } catch {}
        }
      })
      return true
    },
  ),
  predicateRoute(
    'V5_ANTIGRAVITY_RELAY_PREFIX',
    (_req, url) =>
      url.pathname === V5_ANTIGRAVITY_RELAY_PREFIX ||
      url.pathname.startsWith(`${V5_ANTIGRAVITY_RELAY_PREFIX}/`),
    (io, req, res, _url) => {
      const relayCfg = readV5AntigravityRelayConfig(process.env)
      if (!relayCfg) {
        io.sendJson(res, 404, {
          error: {
            code: 'ANTIGRAVITY_RELAY_NOT_CONFIGURED',
            message: 'antigravity relay not configured',
          },
        })
        return true
      }
      handleV5AntigravityRelayLocal(req, res, relayCfg).catch((err) => {
        io.log.error('v5 antigravity local relay crashed', undefined, err)
        if (!res.headersSent) {
          try {
            io.sendJson(res, 500, {
              error: { code: 'INTERNAL', message: 'antigravity relay crashed' },
            })
          } catch {}
        } else {
          try {
            res.end()
          } catch {}
        }
      })
      return true
    },
  ),
  // v3/v5 commercial marketplace relay. Codex subprocesses cannot see
  // OPENCLAUDE_* env, so oc-market falls back to this loopback-only path.
  predicateRoute(
    'V3_MARKETPLACE_LOCAL_RELAY_PREFIX',
    (_req, url) =>
      url.pathname === V3_MARKETPLACE_LOCAL_RELAY_PREFIX ||
      url.pathname.startsWith(`${V3_MARKETPLACE_LOCAL_RELAY_PREFIX}/`),
    (io, req, res, _url) => {
      const relayCfg = readV3MarketplaceRelayConfig(process.env)
      if (!relayCfg) {
        io.sendJson(res, 404, {
          error: {
            code: 'MARKETPLACE_RELAY_NOT_CONFIGURED',
            message: 'marketplace relay not configured',
          },
        })
        return true
      }
      handleV3MarketplaceRelayLocal(req, res, relayCfg).catch((err) => {
        io.log.error('v3 marketplace local relay crashed', undefined, err)
        if (!res.headersSent) {
          try {
            io.sendJson(res, 500, {
              error: { code: 'INTERNAL', message: 'marketplace relay crashed' },
            })
          } catch {}
        } else {
          try {
            res.end()
          } catch {}
        }
      })
      return true
    },
  ),
  // oc-skill 对话内训练/评测生成:容器内 CLI(回环)打本 gateway 自己的 train/eval-gen
  // API。Codex 子进程 env 被擦拿不到 accessToken,故走这条 loopback-only 路径映射到既有
  // /api 处理器。身份仍走 getUserId(回环无 JWT → 'default',与 master 代理剥掉
  // auth/cookie 后的前端请求同一分区 → CLI 起的训练在管理中心可见)。relay 只做「回环 +
  // 路径匹配」,可写性门/生成-评测互斥/owner/method 一律由被派发的处理器权威执行。
  predicateRoute(
    'SKILL_LOCAL_RELAY_PREFIX',
    (_req, url) =>
      url.pathname === SKILL_LOCAL_RELAY_PREFIX ||
      url.pathname.startsWith(`${SKILL_LOCAL_RELAY_PREFIX}/`),
    (io, req, res, url) => {
      const decision = decideSkillLocalRelay(url.pathname, req.socket.remoteAddress)
      if (decision.action === 'forbidden') {
        io.sendJson(res, 403, {
          error: { code: 'FORBIDDEN', message: 'skill relay is loopback-only' },
        })
        return true
      }
      if (decision.action === 'not-found') {
        io.sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'unknown skill relay path' } })
        return true
      }
      const p = decision.param
      const guarded = (pr: Promise<void>) => pr.catch((err) => io.sendInternalError(res, err))
      switch (decision.route) {
        case 'train-start':
          guarded(io._handleSkillTrainStart(req, res, p))
          return true
        case 'train-status':
          guarded(io._handleSkillTrainRun(req, res, p))
          return true
        case 'evalgen-start':
          guarded(io._handleSkillEvalGenStart(req, res, p))
          return true
        case 'evalgen-status':
          guarded(io._handleSkillEvalGenStatus(req, res, p))
          return true
      }
      return true
    },
  ),
  // project_search MCP tool (P5a): loopback-only + the raw gateway token (no JWT,
  // no bridge bypass). Not an /api/* path, so the browser proxy never reaches it.
  predicateRoute(
    'PROJECT_SEARCH_LOCAL_PATH',
    (_req, url) => url.pathname === PROJECT_SEARCH_LOCAL_PATH,
    (io, req, res, url) => {
      const authorized = checkToken(io.extractToken(req), io.deps.config.gateway.accessToken)
      handleProjectSearchLocal({
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        remoteAddress: req.socket.remoteAddress,
        authorized,
      })
        .then((r) => io.sendJson(res, r.status, r.body))
        .catch((err) => io.sendInternalError(res, err))
      return true
    },
  ),
  // ── Multi-user login (no auth required, rate-limited) ──
  predicateRoute(
    'POST /api/auth/login',
    (req, url) => url.pathname === '/api/auth/login' && req.method === 'POST',
    (io, req, res, _url) => {
      // Use socket address only — X-Forwarded-For is client-spoofable; cloudflared connects locally
      const clientIp = req.socket.remoteAddress || 'unknown'
      if (!io.rateLimiter.check(clientIp, 'login')) {
        io.sendJson(res, 429, { error: 'too many login attempts, try again later' })
        return true
      }
      io.readBody(req)
        .then((body) => {
          let parsed: any
          try {
            parsed = JSON.parse(body)
          } catch {
            io.sendJson(res, 400, { error: 'invalid JSON' })
            return
          }
          if (typeof parsed !== 'object' || parsed === null) {
            io.sendJson(res, 400, { error: 'body must be a JSON object' })
            return
          }
          const { username, password } = parsed
          const users = io.deps.config.gateway.users
          if (!users?.length) {
            // Legacy mode: accept raw accessToken as password — username not required
            if (typeof password !== 'string') {
              io.sendJson(res, 400, { error: 'password must be a string' })
              return
            }
            if (checkToken(password, io.deps.config.gateway.accessToken)) {
              const token = signJwt(
                { userId: 'default', exp: Math.floor(Date.now() / 1000) + io.JWT_TTL_SECONDS },
                io.deps.config.gateway.accessToken,
              )
              io.sendJson(res, 200, { token, userId: 'default', name: 'Default' })
            } else {
              io.sendJson(res, 401, { error: 'invalid credentials' })
            }
            return
          }
          if (typeof username !== 'string' || typeof password !== 'string') {
            io.sendJson(res, 400, { error: 'username and password must be strings' })
            return
          }
          const user = users.find((u) => u.id === username)
          if (!user || !verifyPassword(password, user.passwordHash)) {
            io.sendJson(res, 401, { error: 'invalid credentials' })
            return
          }
          const token = signJwt(
            { userId: user.id, exp: Math.floor(Date.now() / 1000) + io.JWT_TTL_SECONDS },
            io.deps.config.gateway.accessToken,
          )
          io.sendJson(res, 200, { token, userId: user.id, name: user.name })
        })
        .catch(() => io.sendJson(res, 400, { error: 'invalid body' }))
      return true
    },
  ),
]
