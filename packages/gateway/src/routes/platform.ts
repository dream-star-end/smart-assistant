/**
 * Platform routes (/v1/, auth session/logout, /internal/v3/*)
 *
 * Ordered route table moved out of Gateway._handleHttpAfterCommercial (FINDINGS §7.5 step 2b,
 * OCV5-468). Each entry's match is the original branch condition and its handler the original
 * branch body (`return` → `return true`; a branch that falls through returns false; `path` /
 * `method` are the method's own `url.pathname` / `req.method ?? 'GET'` copies), so dispatchRoutes()
 * over this table behaves exactly like the if-chain it replaces. The Gateway dispatches it at the spot
 * the inline block used to be. Order matters: the first entry whose handler returns true wins.
 *
 * Dependencies are the narrow PlatformRoutesIo below instead of the whole Gateway (read-only Gateway fields are
 * exposed as getters). Equivalence with the original chain: __tests__/httpRouteTables.test.ts.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { TURN_CANCEL_IF_QUEUED_PATH } from '@openclaude/protocol'
import { type AgentsConfig, countRuntimeRecycleUnsafeTurnDispatches } from '@openclaude/storage'
import type { DelegateJobStore, DelegateJobSnapshot } from '../delegateJobs.js'
import { isDelegateCutoverEffective } from '../delegateSmFlag.js'
import {
  beginDelegateCutover,
  endDelegateCutover,
  resolveDelegateCutoverFreezeMs,
} from '../delegateCutover.js'
import { handleOpenAIRequest } from '../openaiCompat.js'
import type { SessionManager } from '../sessionManager.js'
import { RuntimeRecycleDrainCoordinator } from '../runtimeRecycleDrain.js'
import type { Gateway, GatewayDeps } from '../server.js'
import { type HttpRoute, predicateRoute, regexRoute } from './routeTable.js'

export interface PlatformRoutesIo {
  _delegateRunnerIdle(job: DelegateJobSnapshot): boolean
  _ensureDelegateJobStore(): DelegateJobStore
  _getAgentsConfigUserView(): Promise<AgentsConfig>
  checkHttpAuth(req: IncomingMessage): boolean
  checkInboundBypass(req: IncomingMessage, url: URL): boolean
  handleEnginePreheat(req: IncomingMessage, res: ServerResponse): Promise<void>
  handleTurnCancelIfQueued(req: IncomingMessage, res: ServerResponse): Promise<void>
  handleTurnDispatchState(url: URL, res: ServerResponse): Promise<void>
  handleTurnRejectIfAbsent(req: IncomingMessage, res: ServerResponse): Promise<void>
  handleWechatInbound: Gateway['handleWechatInbound']
  handleWechatInboundCompensate(req: IncomingMessage, res: ServerResponse): Promise<void>
  handleWechatStop(req: IncomingMessage, res: ServerResponse): Promise<void>
  isHttps(req: IncomingMessage): boolean
  readBody: Gateway['readBody']
  sendError(res: ServerResponse, code: number, message: string): void
  sendInternalError(res: ServerResponse, err: unknown): void
  sendJson(res: ServerResponse, code: number, body: unknown): void
  setSessionCookie(res: ServerResponse, req: IncomingMessage): boolean
  readonly _runLog: Gateway['_runLog']
  _runtimeRecycleDrainCoordinator: RuntimeRecycleDrainCoordinator | null
  _runtimeRecycleDrainUntil: Gateway['_runtimeRecycleDrainUntil']
  readonly _runtimeRecycleIngressActive: Gateway['_runtimeRecycleIngressActive']
  readonly deps: GatewayDeps
  readonly log: Gateway['log']
  readonly sessions: SessionManager
}

export const PLATFORM_ROUTES: readonly HttpRoute<PlatformRoutesIo>[] = [
  // OpenAI-compatible API: /v1/chat/completions, /v1/models
  predicateRoute(
    '/v1/*',
    (_req, url) => url.pathname.startsWith('/v1/'),
    (io, req, res, url) => {
      // /v1/models 枚举面走用户可见投影(隐藏系统 agent 不列);/v1/chat/completions
      // 目标解析/拒绝仍用全量 agentsConfig + predicate(判定面)。
      io._getAgentsConfigUserView()
        .then((agentsConfigUserView) =>
          handleOpenAIRequest(req, res, url, {
            config: io.deps.config,
            agentsConfig: io.deps.agentsConfig,
            agentsConfigUserView,
            sessions: io.sessions,
            runLog: io._runLog,
            readBody: (r) => io.readBody(r),
            sendJson: (r, c, b) => io.sendJson(r, c, b),
            sendError: (r, c, m) => io.sendError(r, c, m),
          }),
        )
        .then((handled) => {
          if (!handled) io.sendError(res, 404, 'unknown v1 endpoint')
        })
        .catch((err) => io.sendInternalError(res, err))
      return true
    },
  ),
  // Session cookie endpoint — called by frontend after login to set HttpOnly cookie
  // (so img/audio/video elements can access /api/file and /api/media without JS headers)
  predicateRoute(
    'POST /api/auth/session',
    (req, url) => url.pathname === '/api/auth/session' && req.method === 'POST',
    (io, req, res, _url) => {
      if (!io.checkHttpAuth(req)) {
        res.writeHead(401)
        res.end('unauthorized')
        return true
      }
      // setSessionCookie re-verifies the token; if JWT just raced into expiry,
      // return 401 rather than silently downgrading to 'default' identity.
      if (!io.setSessionCookie(res, req)) {
        res.writeHead(401)
        res.end('unauthorized')
        return true
      }
      io.sendJson(res, 200, { ok: true })
      return true
    },
  ),
  // Logout: expire the HttpOnly session cookie
  predicateRoute(
    'POST /api/auth/logout',
    (req, url) => url.pathname === '/api/auth/logout' && req.method === 'POST',
    (io, req, res, _url) => {
      const secure = io.isHttps(req) ? '; Secure' : ''
      res.setHeader(
        'Set-Cookie',
        `oc_session=; HttpOnly; SameSite=Strict${secure}; Path=/api/; Max-Age=0`,
      )
      io.sendJson(res, 200, { ok: true })
      return true
    },
  ),
  // v5 stale-image recycle handshake. Authentication reuses the existing
  // host→container inbound nonce; v3 never calls this endpoint.
  predicateRoute(
    'POST /internal/v3/runtime-recycle-drain',
    (req, url) => url.pathname === '/internal/v3/runtime-recycle-drain' && req.method === 'POST',
    (io, req, res, url) => {
      if (!io.checkInboundBypass(req, url)) {
        io.sendJson(res, 401, { error: 'unauthorized' })
        return true
      }
      const ttlMs = 10_000
      let coordinator = io._runtimeRecycleDrainCoordinator
      if (coordinator === null) {
        coordinator = new RuntimeRecycleDrainCoordinator({
          ttlMs,
          now: () => Date.now(),
          armGatewayDrain: (until) => {
            io._runtimeRecycleDrainUntil = until
          },
          isGatewayDrainActive: (now) => io._runtimeRecycleDrainUntil > now,
          releaseGatewayDrain: () => {
            io._runtimeRecycleDrainUntil = 0
          },
          armSessionDrain: (ttl) => io.sessions.armRuntimeRecycleDrain(ttl),
          isSessionDrainActive: (now) => io.sessions.isRuntimeRecycleDraining(now),
          releaseSessionDrain: () => io.sessions.releaseRuntimeRecycleDrain(),
          activeIngress: () => io._runtimeRecycleIngressActive,
          countDurableRunning: () => countRuntimeRecycleUnsafeTurnDispatches(),
          ...(isDelegateCutoverEffective()
            ? {
                countRunningDelegateJobs: () => io._ensureDelegateJobStore().countRunning(),
                peekRunningDelegateJobs: () => io._ensureDelegateJobStore().countRunning(),
                freezeDelegateDispatch: (holder: string, expiresAt?: number) => {
                  io._ensureDelegateJobStore().freezeDispatch(holder, expiresAt)
                },
                thawDelegateDispatch: (holder: string) => {
                  io._ensureDelegateJobStore().thawDispatch(holder)
                },
              }
            : {}),
        })
        io._runtimeRecycleDrainCoordinator = coordinator
      }
      void coordinator.attempt().then(
        (decision) => {
          if (decision.ok) {
            io.sendJson(res, 200, { ok: true, drainTtlMs: decision.drainTtlMs })
            return
          }
          io.sendJson(res, decision.status, decision)
        },
        (err) => {
          // Unexpected callback failure is still fail-closed: never leave a
          // half-armed drain or let the supervisor interpret it as accepted.
          io._runtimeRecycleDrainUntil = 0
          io.sessions.releaseRuntimeRecycleDrain()
          io.log.error('runtime recycle drain evaluation failed', undefined, err as Error)
          io.sendJson(res, 503, { ok: false, reason: 'drain_state_unavailable' })
        },
      )
      return true
    },
  ),
  // OCV5-22 stage 3: host cutover freeze. Scripts are wired in a later
  // deploy batch; this endpoint is the gateway-side BeginCutover signal.
  predicateRoute(
    'POST /internal/v3/delegate-begin-cutover',
    (req, url) => url.pathname === '/internal/v3/delegate-begin-cutover' && req.method === 'POST',
    (io, req, res, url) => {
      if (!io.checkInboundBypass(req, url)) {
        io.sendJson(res, 401, { error: 'unauthorized' })
        return true
      }
      if (!isDelegateCutoverEffective()) {
        io.sendJson(res, 409, { ok: false, reason: 'cutover_flag_off' })
        return true
      }
      const store = io._ensureDelegateJobStore()
      const rawGeneration = Number.parseInt(url.searchParams.get('generation') ?? '', 10)
      const generation = Number.isFinite(rawGeneration) ? rawGeneration : Date.now()
      void beginDelegateCutover(store, {
        generation,
        freezeBudgetMs: resolveDelegateCutoverFreezeMs(),
        isIdle: (job) => io._delegateRunnerIdle(job),
      }).then(
        (result) => {
          io.sendJson(res, 200, { ok: true, ...result })
        },
        (err) => {
          endDelegateCutover(store, generation)
          io.log.error('delegate begin-cutover failed', undefined, err as Error)
          io.sendJson(res, 503, { ok: false, reason: 'cutover_quiesce_failed' })
        },
      )
      return true
    },
  ),
  predicateRoute(
    'POST /internal/v3/delegate-end-cutover',
    (req, url) => url.pathname === '/internal/v3/delegate-end-cutover' && req.method === 'POST',
    (io, req, res, url) => {
      if (!io.checkInboundBypass(req, url)) {
        io.sendJson(res, 401, { error: 'unauthorized' })
        return true
      }
      if (!isDelegateCutoverEffective()) {
        io.sendJson(res, 409, { ok: false, reason: 'cutover_flag_off' })
        return true
      }
      const store = io._ensureDelegateJobStore()
      const rawGeneration = Number.parseInt(url.searchParams.get('generation') ?? '', 10)
      if (!Number.isFinite(rawGeneration)) {
        io.sendJson(res, 400, { ok: false, reason: 'generation_required' })
        return true
      }
      io.sendJson(res, 200, { ok: true, ...endDelegateCutover(store, rawGeneration) })
      return true
    },
  ),
  // v3 WeChat broker → 容器 inbound 通道(D3d:HMAC-derived nonce 鉴权)。
  // master 侧 broker 经 docker bridge gateway 主动 POST 把 WeChat 收到的消息塞进
  // 容器的 dispatchInbound() 路径,等价于"模拟一条 WS inbound.message"。
  //
  // 鉴权完全靠 checkInboundBypass —— **不接受任何 JWT / 旧 token,也不允许 host loopback**;
  // env(OPENCLAUDE_TRUST_BRIDGE_IP/OC_CONTAINER_ID/OPENCLAUDE_INBOUND_NONCE)缺失 / 形态错
  // 一律 false,fail-closed。401 时只回最小 JSON,不暴露原因(防 oracle)。
  //
  // 端点放到 needsAuth 块之前并提前 return —— 防 `/internal/*` 之类未来路由意外
  // 被 needsAuth 漏判公开化(/internal/ 不在 needsAuth 当前的 prefix 列表里)。
  predicateRoute(
    'POST /internal/v3/wechat-inbound',
    (req, url) => url.pathname === '/internal/v3/wechat-inbound' && req.method === 'POST',
    (io, req, res, url) => {
      if (!io.checkInboundBypass(req, url)) {
        io.sendJson(res, 401, { error: 'unauthorized' })
        return true
      }
      io.handleWechatInbound(req, res).catch((err) => {
        io.log.error('wechat-inbound handler crashed', undefined, err)
        if (!res.headersSent) {
          try {
            io.sendJson(res, 500, { error: 'internal' })
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
    'POST /internal/v3/qq-inbound',
    (req, url) => url.pathname === '/internal/v3/qq-inbound' && req.method === 'POST',
    (io, req, res, url) => {
      if (!io.checkInboundBypass(req, url)) {
        io.sendJson(res, 401, { error: 'unauthorized' })
        return true
      }
      io.handleWechatInbound(req, res, 'qqbot').catch((err) => {
        io.log.error('qq-inbound handler crashed', undefined, err)
        if (!res.headersSent) {
          try {
            io.sendJson(res, 500, { error: 'internal' })
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
  // master → 容器 session-open 引擎预热。鉴权同 wechat-inbound(checkInboundBypass)。
  // 内部口自带 gate,不读 OC_ENGINE_PREHEAT。先 200 再异步 spawn,避免卡住 master POST。
  predicateRoute(
    'POST /internal/v3/engine-preheat',
    (req, url) => url.pathname === '/internal/v3/engine-preheat' && req.method === 'POST',
    (io, req, res, url) => {
      if (!io.checkInboundBypass(req, url)) {
        io.sendJson(res, 401, { error: 'unauthorized' })
        return true
      }
      io.handleEnginePreheat(req, res).catch((err) => {
        io.log.warn('engine-preheat handler crashed', undefined, err as Error)
        if (!res.headersSent) {
          try {
            io.sendJson(res, 200, { ok: true, skipped: true })
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
  // 容器侧 WeChat inbound 补偿端点。master broker 的 inboundDispatcher Step 2
  // 失败时调本端点撤销 Step 1 写入的 client_sessions row。
  //
  //   - 鉴权同 /wechat-inbound:走 checkInboundBypass(已支持 /internal/v3/* 前缀)
  //   - **idempotent + always-200**:dispatcher 视任何 500 / 非-200 都为 "compensation
  //     failed",而 reconcile 30s 才兜底。always-200 + `deleted` 字段把"行不存在 / 已
  //     删 / 真删了"三种状态显式化,避免 dispatcher 把 idempotent no-op 错记成 error
  //   - 真 DB 错也照 200 返(body 内带 errMessage 让 broker log 观测,但 dispatcher
  //     不重试 — 重试同一条 compensation 也不会成,reconcile 会兜底清孤儿)
  predicateRoute(
    'POST /internal/v3/wechat-inbound-compensate',
    (req, url) =>
      url.pathname === '/internal/v3/wechat-inbound-compensate' && req.method === 'POST',
    (io, req, res, url) => {
      if (!io.checkInboundBypass(req, url)) {
        io.sendJson(res, 401, { error: 'unauthorized' })
        return true
      }
      io.handleWechatInboundCompensate(req, res).catch((err) => {
        io.log.error('wechat-inbound-compensate handler crashed', undefined, err)
        if (!res.headersSent) {
          // crash 路径也照 200 返 — dispatcher 永远不该 retry compensation
          try {
            io.sendJson(res, 200, { ok: true, deleted: false, errMessage: 'internal' })
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
    'POST /internal/v3/qq-inbound-compensate',
    (req, url) => url.pathname === '/internal/v3/qq-inbound-compensate' && req.method === 'POST',
    (io, req, res, url) => {
      if (!io.checkInboundBypass(req, url)) {
        io.sendJson(res, 401, { error: 'unauthorized' })
        return true
      }
      io.handleWechatInboundCompensate(req, res).catch((err) => {
        io.log.error('qq-inbound-compensate handler crashed', undefined, err)
        if (!res.headersSent) {
          try {
            io.sendJson(res, 200, { ok: true, deleted: false, errMessage: 'internal' })
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
  // v3 WeChat `/stop` bridge. Master broker resolves the current wsess and
  // POSTs here so the container can interrupt the in-process runner. Same
  // HMAC gate as `/wechat-inbound`; the endpoint is intentionally internal
  // and never exposed to browser/client traffic.
  predicateRoute(
    'POST /internal/v3/wechat-stop',
    (req, url) => url.pathname === '/internal/v3/wechat-stop' && req.method === 'POST',
    (io, req, res, url) => {
      if (!io.checkInboundBypass(req, url)) {
        io.sendJson(res, 401, { error: 'unauthorized' })
        return true
      }
      io.handleWechatStop(req, res).catch((err) => {
        io.log.error('wechat-stop handler crashed', undefined, err)
        if (!res.headersSent) {
          try {
            io.sendJson(res, 500, { error: 'internal' })
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
    'POST /internal/v3/qq-stop',
    (req, url) => url.pathname === '/internal/v3/qq-stop' && req.method === 'POST',
    (io, req, res, url) => {
      if (!io.checkInboundBypass(req, url)) {
        io.sendJson(res, 401, { error: 'unauthorized' })
        return true
      }
      io.handleWechatStop(req, res).catch((err) => {
        io.log.error('qq-stop handler crashed', undefined, err)
        if (!res.headersSent) {
          try {
            io.sendJson(res, 500, { error: 'internal' })
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
  // ── RFC-v5-durable-turn-dispatch §3 端点(鉴权同 wechat-inbound:checkInboundBypass,
  //    HMAC-derived nonce,fail-closed;master reconciler / turnDispatchReconciler 调用)──
  //
  // POST /internal/v3/turn-reject-if-absent —— reconciler rejecting 分支:有 inbox 行
  // 返状态(negative proof 不成立);无行插 rejected(not_accepted)墓碑。durable
  // rejected tombstone 是 I2 里 negative proof 的**唯一**合法来源。
  predicateRoute(
    'POST TURN_CANCEL_IF_QUEUED_PATH',
    (req, url) => url.pathname === TURN_CANCEL_IF_QUEUED_PATH && req.method === 'POST',
    (io, req, res, url) => {
      if (!io.checkInboundBypass(req, url)) {
        io.sendJson(res, 401, { error: 'unauthorized' })
        return true
      }
      io.handleTurnCancelIfQueued(req, res).catch((err) => {
        io.log.error('turn-cancel-if-queued handler crashed', undefined, err)
        if (!res.headersSent) {
          try {
            io.sendJson(res, 500, { error: 'internal' })
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
    'POST /internal/v3/turn-reject-if-absent',
    (req, url) => url.pathname === '/internal/v3/turn-reject-if-absent' && req.method === 'POST',
    (io, req, res, url) => {
      if (!io.checkInboundBypass(req, url)) {
        io.sendJson(res, 401, { error: 'unauthorized' })
        return true
      }
      io.handleTurnRejectIfAbsent(req, res).catch((err) => {
        io.log.error('turn-reject-if-absent handler crashed', undefined, err)
        if (!res.headersSent) {
          try {
            io.sendJson(res, 500, { error: 'internal' })
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
  // GET /internal/v3/turn-dispatch-state —— reconciler accepted 分支查行(按逻辑键)。
  predicateRoute(
    'GET /internal/v3/turn-dispatch-state',
    (req, url) => url.pathname === '/internal/v3/turn-dispatch-state' && req.method === 'GET',
    (io, req, res, url) => {
      if (!io.checkInboundBypass(req, url)) {
        io.sendJson(res, 401, { error: 'unauthorized' })
        return true
      }
      io.handleTurnDispatchState(url, res).catch((err) => {
        io.log.error('turn-dispatch-state handler crashed', undefined, err)
        if (!res.headersSent) {
          try {
            io.sendJson(res, 500, { error: 'internal' })
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
]
