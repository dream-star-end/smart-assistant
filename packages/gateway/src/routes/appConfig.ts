/**
 * App config routes (/api/features, /api/config)
 *
 * Ordered route table moved out of Gateway._handleHttpAfterCommercial (FINDINGS §7.5 step 2b,
 * OCV5-468). Each entry's match is the original branch condition and its handler the original
 * branch body (`return` → `return true`; a branch that falls through returns false; `path` /
 * `method` are the method's own `url.pathname` / `req.method ?? 'GET'` copies), so dispatchRoutes()
 * over this table behaves exactly like the if-chain it replaces. The Gateway dispatches it at the spot
 * the inline block used to be. Order matters: the first entry whose handler returns true wins.
 *
 * Dependencies are the narrow AppConfigRoutesIo below instead of the whole Gateway (read-only Gateway fields are
 * exposed as getters). Equivalence with the original chain: __tests__/httpRouteTables.test.ts.
 */
import { readServerFeatures } from '@openclaude/protocol'
import type { ServerResponse } from 'node:http'
import type { GatewayDeps } from '../server.js'
import { type HttpRoute, predicateRoute, regexRoute } from './routeTable.js'

export interface AppConfigRoutesIo {
  sendError(res: ServerResponse, code: number, message: string): void
  sendJson(res: ServerResponse, code: number, body: unknown): void
  readonly deps: GatewayDeps
}

export const APP_CONFIG_ROUTES: readonly HttpRoute<AppConfigRoutesIo>[] = [
  // Server-side feature flags for the web UI (env predicates, see protocol/serverFeatures).
  // Its own route because /api/config stays host-only: the master proxies only this one.
  predicateRoute(
    '/api/features',
    (_req, url) => url.pathname === '/api/features',
    (io, req, res, _url) => {
      if (req.method !== 'GET') {
        io.sendError(res, 405, 'method not allowed')
        return true
      }
      io.sendJson(res, 200, { features: readServerFeatures(process.env) })
      return true
    },
  ),
  predicateRoute(
    '/api/config',
    (_req, url) => url.pathname === '/api/config',
    (io, _req, res, _url) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      const activeMcps: Array<{ id: string; label?: string; provider?: string; tools?: string[] }> =
        []
      const activeProvider = io.deps.config.provider
      for (const srv of io.deps.config.mcpServers ?? []) {
        if (srv.enabled === false) continue
        if (srv.provider && srv.provider !== activeProvider) continue
        activeMcps.push({ id: srv.id, label: srv.label, provider: srv.provider, tools: srv.tools })
      }
      const authInfo: Record<string, any> = { mode: io.deps.config.auth.mode }
      if (io.deps.config.auth.claudeOAuth?.accessToken) {
        authInfo.claudeOAuth = {
          active: true,
          expiresAt: io.deps.config.auth.claudeOAuth.expiresAt,
        }
      }
      res.end(
        JSON.stringify({
          gateway: { bind: io.deps.config.gateway.bind, port: io.deps.config.gateway.port },
          defaults: io.deps.config.defaults,
          channels: Object.keys(io.deps.config.channels),
          provider: activeProvider,
          auth: authInfo,
          mcpServers: activeMcps,
          features: readServerFeatures(process.env),
        }),
      )
      return true
    },
  ),
]
