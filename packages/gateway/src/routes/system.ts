/**
 * System routes (web-trace, healthz, metrics, version, doctor, usage, runs)
 *
 * Ordered route table moved out of Gateway._handleHttpAfterCommercial (FINDINGS §7.5 step 2b,
 * OCV5-468). Each entry's match is the original branch condition and its handler the original
 * branch body (`return` → `return true`; a branch that falls through returns false; `path` /
 * `method` are the method's own `url.pathname` / `req.method ?? 'GET'` copies), so dispatchRoutes()
 * over this table behaves exactly like the if-chain it replaces. The Gateway dispatches it at the spot
 * the inline block used to be. Order matters: the first entry whose handler returns true wins.
 *
 * Dependencies are the narrow SystemRoutesIo below instead of the whole Gateway (read-only Gateway fields are
 * exposed as getters). Equivalence with the original chain: __tests__/httpRouteTables.test.ts.
 */
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import { isHealthzFileProxyReady } from '../localBridgeAuth.js'
import {
  getUsageSummary,
  queryEvents,
  probeSessionsDb,
  turnDispatchInboxStats,
} from '@openclaude/storage'
import { serializeMetrics, sessionsActive } from '../metrics.js'
import type { SessionManager } from '../sessionManager.js'
import type { WebhookRouter } from '../webhooks.js'
import { durableTurnDispatchCapabilities } from '../turnDispatchInbox.js'
import type { Gateway, GatewayDeps } from '../server.js'
import { type HttpRoute, predicateRoute, regexRoute } from './routeTable.js'

export interface SystemRoutesIo {
  getUserId(req: IncomingMessage): string
  readBody: Gateway['readBody']
  sendJson(res: ServerResponse, code: number, body: unknown): void
  readonly _dispatchAuthority: Gateway['_dispatchAuthority']
  readonly _durableTurnDispatchReady: Gateway['_durableTurnDispatchReady']
  readonly _runLog: Gateway['_runLog']
  readonly deps: GatewayDeps
  readonly log: Gateway['log']
  readonly sessions: SessionManager
  readonly webhookRouter: WebhookRouter | null
}

export const SYSTEM_ROUTES: readonly HttpRoute<SystemRoutesIo>[] = [
  // Frontend diagnostic trace sink — receives ring-buffer events from
  // packages/web/public/modules/trace.js for diagnosing the "已读但无回复"
  // class of bug (assistant frame delivered by gateway but never landed in
  // client_sessions.messages). NO database write — pino structured log only,
  // queryable via journalctl/grep. 50KB body cap defends the endpoint from
  // accidental flood (RING_MAX*compact entries fits well under).
  predicateRoute(
    'POST /api/web-trace',
    (req, url) => url.pathname === '/api/web-trace' && req.method === 'POST',
    (io, req, res, _url) => {
      const userId = io.getUserId(req)
      io.readBody(req, 50 * 1024)
        .then((body) => {
          let payload: unknown
          try {
            payload = JSON.parse(body)
          } catch {
            io.sendJson(res, 400, { error: 'invalid json' })
            return
          }
          const events = (payload as { events?: unknown })?.events
          if (!Array.isArray(events)) {
            io.sendJson(res, 400, { error: 'events array required' })
            return
          }
          io.log.info('web-trace', { userId, count: events.length, events })
          res.writeHead(204)
          res.end()
        })
        .catch((err) => {
          const tooLarge = String(err?.message ?? err).includes('body too large')
          if (tooLarge) {
            io.sendJson(res, 413, { error: 'body too large' })
          } else {
            io.sendJson(res, 400, { error: 'read failed' })
          }
        })
      return true
    },
  ),
  predicateRoute(
    '/healthz',
    (_req, url) => url.pathname === '/healthz',
    (io, _req, res, _url) => {
      // V3 2H: /healthz 增加 commercial 模块状态(供运维快速判断 v2/v3 实例形态)
      const c = io.deps.commercial
      // v3 file proxy: advertise `file-proxy-v1` capability only when ALL three
      // env vars HOST relies on are injected AND well-formed. Incomplete或形态不对
      // (supervisor 写错 / 部署降级 / 容器复用)→ not ready → HOST 返 CONTAINER_OUTDATED,
      // 避免 HOST 按 bypass 发头结果容器内 checkBridgeBypass 失败 401 的 dead lock。
      // (Codex R1 SHOULD-3:校验形态,不只校验非空)
      const OC_CONTAINER_ID = process.env.OC_CONTAINER_ID || ''
      // file-proxy-v1 仍只看 TRUST_BRIDGE 三件套形态(isHealthzFileProxyReady)。
      // local-bridge token 不是三件套的一部分,W4:不得因此广播 file-proxy-v1。
      const bridgeReady = isHealthzFileProxyReady(process.env)
      const body: Record<string, unknown> = c
        ? {
            ok: true,
            commercial: {
              enabled: true,
              internalProxy: c.internalProxyAddress
                ? { host: c.internalProxyAddress.host, port: c.internalProxyAddress.port }
                : null,
            },
          }
        : { ok: true }
      body.containerId = OC_CONTAINER_ID || null
      // RFC-v5-durable-turn-dispatch §3/§B5 — durable-turn-dispatch-v1 runtime capability
      // 在 healthz 与 attest 两处一致广播,且**绑定完整 readiness**(验签能力 ∧ sink 装配 ∧
      // boot recovery 首跑成功);任一不满足 → 不申报(legacy)。单一权威 durableTurnDispatchCapabilities。
      const healthzCaps: string[] = []
      if (bridgeReady) healthzCaps.push('file-proxy-v1')
      healthzCaps.push(
        ...durableTurnDispatchCapabilities(
          io._dispatchAuthority.enabled,
          io._durableTurnDispatchReady,
        ),
      )
      body.capabilities = healthzCaps
      // v5 灰度可观测 — channel 标签 + commercial 运行时状态(控制面静默 / 运行时隔离 /
      // 灰度归属的只读断言面)。无标签默认 "v3";commercial 未注入 runtimeStatus 时省略。
      body.channel = process.env.OC_RUNTIME_CHANNEL?.trim() || 'v3'
      // P3(RFC D3/D5):v5 双 master 下 healthz 顶层暴露 slot 身份(与 commercial ocSlot 同权威源
      // OC_SLOT,A 默认)。Caddy verifier 经此断言"经分流命中的响应确实来自目标 slot"(去 || true 后严格)。
      if (body.channel === 'v5') body.slot = process.env.OC_SLOT?.trim() || 'A'
      const instanceId = process.env.OC_INSTANCE_ID?.trim()
      if (instanceId) body.instance = instanceId
      if (c?.runtimeStatus) body.runtime = c.runtimeStatus
      if (c) {
        // master 形态深度探活:sessions.db open 失败 = 会话 list/save/落库全崩;
        // commercial 注入的强依赖(PG `SELECT 1` / Redis `PING`,见 probeDeps)挂了
        // 同样致命。任一 fail → ok 翻 false 让监控(断言 .ok==true)与 deploy smoke
        // 抓到 —— 2026-07-06 存量库 schema 事故中进程活着但全站 500 两小时无告警的
        // 盲区收口,本波扩到 PG/Redis 维度(同构盲区:换权威源维度)。
        // 保持 HTTP 200:深度不健康 ≠ 完全不可服务(聊天引擎/静态资源仍在跑),
        // 不给上游 LB 摘流量的信号,只翻 ok 供告警面消费。
        // 容器内 gateway(c 为空)不探活:HOST probe 消费 capabilities 语义,不动。
        // commercial 未注入 probeDeps(旧接线/个人版)时退回仅探 sessions.db。
        void Promise.all([
          probeSessionsDb().catch((): { ok: false; error: string } => ({
            ok: false,
            error: 'probe rejected',
          })),
          c.probeDeps
            ? c.probeDeps().catch(
                (): Record<string, { ok: false; error: string }> => ({
                  commercialDeps: { ok: false, error: 'probe rejected' },
                }),
              )
            : Promise.resolve<Record<string, { ok: true } | { ok: false; error: string }>>({}),
        ])
          .then(([sess, extra]) => {
            const built = _buildHealthzDeps(sess, extra)
            body.deps = built.deps
            if (!built.ok) body.ok = false
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(body))
          })
          .catch(() => {
            // 兜底防 healthz 挂起(上面各探活分支已内部 catch,理论到不了这里)。
            body.ok = false
            body.deps = { sessionsDb: 'error', sessionsDbError: 'probe rejected' }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(body))
          })
        return true
      }
      // 容器/个人版形态(c 空):附 durable inbox open-job / 字节 gauge(RFC §3
      // healthz),异步取一次后 end。stats 失败不阻塞健康返回(inbox 是可观测面,
      // 非可服务面)。个人版(无 commercial 注入)同样深度探 sessions.db —— 本地
      // SQLite 在此形态下就是会话权威库,打不开 = list/save/落库全崩,必须翻 ok
      // 供监控/doctor 消费(与上方 master 形态同一探针与 deps 语义)。
      void Promise.all([
        probeSessionsDb().catch((): { ok: false; error: string } => ({
          ok: false,
          error: 'probe rejected',
        })),
        turnDispatchInboxStats()
          .then((stats): { openJobs: number | null; bytes: number | null } => ({
            openJobs: stats.openJobs,
            bytes: stats.bytes,
          }))
          .catch((): { openJobs: null; bytes: null } => ({ openJobs: null, bytes: null })),
      ])
        .then(([sess, inbox]) => {
          body.turnDispatchInbox = inbox
          const built = _buildHealthzDeps(sess, {})
          body.deps = built.deps
          if (!built.ok) body.ok = false
        })
        .catch(() => {
          // 兜底防 healthz 挂起(上面各探活分支已内部 catch,理论到不了这里)。
          body.ok = false
          body.deps = { sessionsDb: 'error', sessionsDbError: 'probe rejected' }
        })
        .finally(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(body))
        })
      return true
    },
  ),
  predicateRoute(
    '/metrics',
    (_req, url) => url.pathname === '/metrics',
    (io, _req, res, _url) => {
      sessionsActive.value = io.sessions.list().length
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' })
      res.end(serializeMetrics())
      return true
    },
  ),
  // /version — reports currently-live release. Written by scripts/deploy-v3.sh
  // as <cwd>/VERSION.json after rsync and before systemctl restart. Public
  // (no auth) because commit hash of a private repo carries no secret value
  // and matches the already-open /healthz posture.
  predicateRoute(
    'GET /version',
    (req, url) => url.pathname === '/version' && req.method === 'GET',
    (io, _req, res, _url) => {
      const body: { tag: string; builtAt: string | null; commit?: string } = {
        tag: 'unknown',
        builtAt: null,
      }
      try {
        const raw = readFileSync(resolve(process.cwd(), 'VERSION.json'), 'utf-8')
        const j = JSON.parse(raw)
        if (typeof j.tag === 'string') body.tag = j.tag
        if (typeof j.builtAt === 'string') body.builtAt = j.builtAt
        if (typeof j.commit === 'string') body.commit = j.commit
      } catch {
        // file missing / unreadable / malformed → return defaults above
      }
      io.sendJson(res, 200, body)
      return true
    },
  ),
  predicateRoute(
    '/api/doctor',
    (_req, url) => url.pathname === '/api/doctor',
    (io, _req, res, _url) => {
      const summary = io._runLog.summary()
      const recentRuns = io._runLog.recent(20)
      const sessions = io.sessions.list()
      const webhooks = io.webhookRouter?.list().length ?? 0
      io.sendJson(res, 200, {
        uptime: process.uptime(),
        memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        activeSessions: sessions.length,
        webhooks,
        runLog: summary,
        recentRuns,
      })
      return true
    },
  ),
  predicateRoute(
    'GET /api/usage',
    (req, url) => url.pathname === '/api/usage' && req.method === 'GET',
    (io, _req, res, url) => {
      const agentId = url.searchParams.get('agentId') ?? undefined
      const sessionId = url.searchParams.get('sessionId') ?? undefined
      const sinceRaw = url.searchParams.get('since')
      const since = sinceRaw ? Number(sinceRaw) : undefined
      if (since !== undefined && !Number.isFinite(since)) {
        io.sendJson(res, 400, { error: 'since must be a valid number' })
        return true
      }
      Promise.all([
        getUsageSummary({ agentId, sessionId, since }),
        queryEvents({ type: 'cost.recorded', agentId, sessionKey: sessionId, since, limit: 50 }),
      ])
        .then(([summary, events]) => {
          io.sendJson(res, 200, { summary, recentCostEvents: events })
        })
        .catch(() => io.sendJson(res, 500, { error: 'usage query failed' }))
      return true
    },
  ),
  predicateRoute(
    'GET /api/usage/events',
    (req, url) => url.pathname === '/api/usage/events' && req.method === 'GET',
    (io, _req, res, url) => {
      const type = url.searchParams.get('type') ?? undefined
      const agentId = url.searchParams.get('agentId') ?? undefined
      const sessionKey = url.searchParams.get('sessionKey') ?? undefined
      const sinceRaw = url.searchParams.get('since')
      const since = sinceRaw ? Number(sinceRaw) : undefined
      const limitRaw = url.searchParams.get('limit')
      const limitNum = limitRaw ? Number(limitRaw) : 100
      const limit = Number.isFinite(limitNum) ? Math.min(Math.max(limitNum, 1), 1000) : 100
      if (since !== undefined && !Number.isFinite(since)) {
        io.sendJson(res, 400, { error: 'since must be a valid number' })
        return true
      }
      queryEvents({ type, agentId, sessionKey, since, limit })
        .then((events) => io.sendJson(res, 200, { events }))
        .catch(() => io.sendJson(res, 500, { error: 'event query failed' }))
      return true
    },
  ),
  predicateRoute(
    'GET /api/runs',
    (req, url) => url.pathname === '/api/runs' && req.method === 'GET',
    (io, _req, res, _url) => {
      io.sendJson(res, 200, { runs: io._runLog.recent(50) })
      return true
    },
  ),
]

/**
 * /healthz 深度探活结果合并(纯函数,便于单测)。
 *
 * 输入:sessions.db 探活结果 + commercial 注入的其余依赖探活 map(pg/redis/...)。
 * 输出:扁平化 `deps`(`<name>: 'ok'|'error'` + 失败时 `<name>Error: <msg>`,保留
 * 既有 `sessionsDb`/`sessionsDbError` 形态供既有监控消费)与顶层 `ok`(任一 fail →
 * false)。**HTTP 状态码由调用方恒写 200**,本函数只决定 ok 供告警面消费。
 */
export function _buildHealthzDeps(
  sess: { ok: true } | { ok: false; error: string },
  extra: Record<string, { ok: true } | { ok: false; error: string }>,
): { deps: Record<string, string>; ok: boolean } {
  const deps: Record<string, string> = {}
  let ok = true
  const put = (name: string, r: { ok: true } | { ok: false; error: string }) => {
    if (r.ok) {
      deps[name] = 'ok'
    } else {
      deps[name] = 'error'
      deps[`${name}Error`] = r.error
      ok = false
    }
  }
  put('sessionsDb', sess)
  for (const [name, r] of Object.entries(extra)) put(name, r)
  return { deps, ok }
}
