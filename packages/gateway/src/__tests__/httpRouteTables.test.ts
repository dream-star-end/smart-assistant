/**
 * FINDINGS §7.5 step 2b (OCV5-468): the Gateway._handleHttpAfterCommercial if-chain became ordered
 * route tables (routes/preAuth|platform|system|appConfig|agents|workspaceApi.ts). Release gate
 * required by the 2b approval:
 *  - every table has the original routes in the original order;
 *  - over every route's sample paths and their near misses × 7 methods, the routes that match —
 *    across the whole chain, in order — are identical between the frozen original predicates
 *    (fixtures/legacyHttpDispatch.ts) and the tables;
 *  - every route is reached by a sample;
 *  - thin-dispatch routes call the same Gateway handler as the original branch;
 *  - server.ts dispatches each table at its original spot; the pre-auth table (local relays,
 *    project search, login) stays BEFORE the auth gate.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/httpRouteTables.test.ts
 */
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { AGENT_ROUTES } from '../routes/agents.js'
import { APP_CONFIG_ROUTES } from '../routes/appConfig.js'
import { PLATFORM_ROUTES } from '../routes/platform.js'
import { PRE_AUTH_ROUTES } from '../routes/preAuth.js'
import { dispatchRoutes, type HttpRoute, matchingRouteIds } from '../routes/routeTable.js'
import { SYSTEM_ROUTES } from '../routes/system.js'
import { WORKSPACE_API_ROUTES } from '../routes/workspaceApi.js'
import { LEGACY_HTTP_DISPATCH, type LegacyGroup } from './fixtures/legacyHttpDispatch.js'

const here = dirname(fileURLToPath(import.meta.url))
// Preserve the frozen extraction baseline; specify later route additions independently.
const CURRENT_HTTP_DISPATCH: Record<string, LegacyGroup> = {
  ...LEGACY_HTTP_DISPATCH,
  PRE_AUTH_ROUTES: {
    ...LEGACY_HTTP_DISPATCH.PRE_AUTH_ROUTES,
    routes: [{ id: 'SYSTEM_HELP_LOCAL', line: 0, calls: ['handleSystemHelp'],
      match: (_req, url) => url.pathname === '/api/internal/system-help' }, ...LEGACY_HTTP_DISPATCH.PRE_AUTH_ROUTES.routes],
    samples: ['/api/internal/system-help', ...LEGACY_HTTP_DISPATCH.PRE_AUTH_ROUTES.samples],
  },
  AGENT_ROUTES: (() => {
    const agents = LEGACY_HTTP_DISPATCH.AGENT_ROUTES
    const at = agents.routes.findIndex((r) => r.id === '/api/agents/:1/memory/usage') + 1
    // OpenViking B1 façade view (gateway-only), right after memory/usage.
    const memoryContext = { id: '/api/agents/:1/memory/context', line: 0, calls: ['handleMemoryContext', 'sendInternalError'],
      match: (_req: { method?: string }, url: URL) => /^\/api\/agents\/([a-zA-Z0-9_-]+)\/memory\/context$/.test(url.pathname) }
    return {
      ...agents,
      routes: [...agents.routes.slice(0, at), memoryContext, ...agents.routes.slice(at)],
      samples: [...agents.samples, '/api/agents/a/memory/context', '/api/agents/aaa/memory/context'],
    }
  })(),
  WORKSPACE_API_ROUTES: (() => {
    const group = LEGACY_HTTP_DISPATCH.WORKSPACE_API_ROUTES
    const at = group.routes.findIndex((r) => r.id === 'POST /api/uploads')
    const hex = 'a'.repeat(32)
    const chunkRoutes = [
      { id: 'POST /api/uploads/init', line: 0, calls: ['handleChunkedUpload', 'sendInternalError'],
        match: (req: { method?: string }, url: URL) => url.pathname === '/api/uploads/init' && req.method === 'POST' },
      { id: 'PUT /api/uploads/:id/chunks/:index', line: 0, calls: ['handleChunkedUpload', 'sendInternalError'],
        match: (req: { method?: string }, url: URL) => req.method === 'PUT' && /^\/api\/uploads\/[a-f0-9]{32}\/chunks\/\d+$/.test(url.pathname) },
      { id: 'GET /api/uploads/:id', line: 0, calls: ['handleChunkedUpload', 'sendInternalError'],
        match: (req: { method?: string }, url: URL) => req.method === 'GET' && /^\/api\/uploads\/[a-f0-9]{32}$/.test(url.pathname) },
      { id: 'POST /api/uploads/:id/complete', line: 0, calls: ['handleChunkedUpload', 'sendInternalError'],
        match: (req: { method?: string }, url: URL) => req.method === 'POST' && /^\/api\/uploads\/[a-f0-9]{32}\/complete$/.test(url.pathname) },
    ]
    return {
      ...group,
      routes: [...group.routes.slice(0, at), ...chunkRoutes, ...group.routes.slice(at)],
      samples: [
        '/api/uploads/init',
        `/api/uploads/${hex}/chunks/0`,
        `/api/uploads/${'b'.repeat(32)}`,
        `/api/uploads/${'c'.repeat(32)}/complete`,
        ...group.samples,
      ],
    }
  })(),
}
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

// Original chain order (the client-session block between SYSTEM and APP_CONFIG was already a module).
// biome-ignore lint/suspicious/noExplicitAny: tables have different io types; only match() is used here
const TABLES: [string, readonly HttpRoute<any>[]][] = [
  ['PRE_AUTH_ROUTES', PRE_AUTH_ROUTES],
  ['PLATFORM_ROUTES', PLATFORM_ROUTES],
  ['SYSTEM_ROUTES', SYSTEM_ROUTES],
  ['APP_CONFIG_ROUTES', APP_CONFIG_ROUTES],
  ['AGENT_ROUTES', AGENT_ROUTES],
  ['WORKSPACE_API_ROUTES', WORKSPACE_API_ROUTES],
]

const reqOf = (method: string) => ({ method, headers: {} }) as IncomingMessage

function corpus(): string[] {
  const out = new Set<string>([
    '/',
    '/api',
    '/api/',
    '/v1',
    '/internal',
    '/internal/v3/',
    '/healthz/',
    '/metricsx',
  ])
  for (const group of Object.values(CURRENT_HTTP_DISPATCH)) {
    for (const s of group.samples) {
      out.add(s)
      out.add(`${s}/`)
      out.add(`${s}/extra`)
      out.add(`${s}.json`)
      out.add(s.toUpperCase())
      out.add(s.replace(/\/[^/]*$/, '/'))
      out.add(s.replace(/\/[^/]*$/, '/bad%20value'))
      out.add(s.replace(/^\/api\//, '/api/v1/'))
    }
  }
  return [...out]
}

describe('route tables ≡ original if-chain', () => {
  it('fixture covers exactly these tables, in chain order', () => {
    assert.deepEqual(
      Object.keys(CURRENT_HTTP_DISPATCH),
      TABLES.map(([name]) => name),
    )
  })

  for (const [name, table] of TABLES) {
    it(`${name}: same routes, same order`, () => {
      assert.deepEqual(
        table.map((r) => r.id),
        CURRENT_HTTP_DISPATCH[name].routes.map((r) => r.id),
      )
    })
  }

  it('every path × method matches the same routes, in the same order, across the whole chain', () => {
    let compared = 0
    for (const path of corpus()) {
      const url = new URL(path, 'http://gateway.test')
      for (const method of METHODS) {
        const req = reqOf(method)
        const legacy = TABLES.flatMap(([name]) =>
          CURRENT_HTTP_DISPATCH[name].routes
            .filter((r) => r.match(req, url))
            .map((r) => `${name}:${r.id}`),
        )
        const next = TABLES.flatMap(([name, table]) =>
          matchingRouteIds(table, req, url).map((id) => `${name}:${id}`),
        )
        assert.deepEqual(next, legacy, `${method} ${path}`)
        compared++
      }
    }
    assert.ok(compared > 3000, `corpus too small: ${compared}`)
  })

  it('every route is reached by a sample', () => {
    const unreached: string[] = []
    for (const [name, table] of TABLES) {
      const hit = new Set<string>()
      for (const path of CURRENT_HTTP_DISPATCH[name].samples) {
        const url = new URL(path, 'http://gateway.test')
        for (const method of METHODS)
          for (const id of matchingRouteIds(table, reqOf(method), url)) hit.add(id)
      }
      for (const r of table) if (!hit.has(r.id)) unreached.push(`${name}:${r.id}`)
    }
    assert.deepEqual(unreached, [])
  })
})

/** io whose methods record calls and resolve; used for routes that only forward to one handler. */
function recordingIo() {
  const calls: string[] = []
  const io = new Proxy(
    {},
    {
      get:
        (_t, name: string) =>
        (..._args: unknown[]) => {
          calls.push(name)
          return name === 'sendInternalError' ? undefined : Promise.resolve()
        },
    },
  )
  return { io, calls }
}

describe('thin-dispatch routes call the original handler', () => {
  for (const [name, table] of TABLES) {
    const legacy = CURRENT_HTTP_DISPATCH[name]
    // routes whose original branch only did `this.handler(...).catch((err) => this.sendInternalError(res, err))`
    const thin = legacy.routes.filter(
      (r) =>
        r.calls.length === 2 &&
        r.calls[1] === 'sendInternalError' &&
        r.calls[0] !== 'sendInternalError',
    )
    if (!thin.length) continue
    it(`${name}: ${thin.length} routes`, () => {
      for (const r of thin) {
        const sample = legacy.samples.find((s) =>
          METHODS.some((m) => r.match(reqOf(m), new URL(s, 'http://gateway.test'))),
        )
        assert.ok(sample, `no sample for ${r.id}`)
        const url = new URL(sample, 'http://gateway.test')
        const method = METHODS.find((m) => r.match(reqOf(m), url)) as string
        // the first matching route for this request must be r itself (otherwise another route wins)
        const first = legacy.routes.find((x) => x.match(reqOf(method), url))
        if (first?.id !== r.id) continue
        const { io, calls } = recordingIo()
        assert.equal(
          dispatchRoutes(table, io, reqOf(method), {} as ServerResponse, url),
          true,
          r.id,
        )
        assert.deepEqual(calls, [r.calls[0]], `${r.id}: ${calls.join(',')}`)
      }
    })
  }
})

describe('server.ts wiring', () => {
  // The HTTP entry (handleHttp / _handleHttpAfterCommercial) moved to gatewayHttp.ts (OCV5-493).
  const src = readFileSync(join(here, '../gatewayHttp.ts'), 'utf8')
  const at = (s: string) => {
    const i = src.indexOf(s)
    assert.ok(i > 0, `missing: ${s}`)
    return i
  }
  it('tables are dispatched in the original chain order; pre-auth before the auth gate', () => {
    const order = [
      at('if (dispatchRoutes(PRE_AUTH_ROUTES, this.preAuthRoutesIo, req, res, url)) return'),
      at('const needsAuth ='),
      at('this.checkHttpAuth(req)'),
      at('if (dispatchRoutes(PLATFORM_ROUTES, this.platformRoutesIo, req, res, url)) return'),
      at('if (dispatchRoutes(SYSTEM_ROUTES, this.systemRoutesIo, req, res, url)) return'),
      at('if (handleClientSessionsHttp(this.clientSessionsIo, req, res, url)) return'),
      at('if (dispatchRoutes(APP_CONFIG_ROUTES, this.appConfigRoutesIo, req, res, url)) return'),
      at('if (dispatchRoutes(AGENT_ROUTES, this.agentRoutesIo, req, res, url)) return'),
      at(
        'if (dispatchRoutes(WORKSPACE_API_ROUTES, this.workspaceApiRoutesIo, req, res, url)) return',
      ),
      at("if (this.deps.staticMode === 'spa'"),
    ]
    assert.deepEqual(
      order,
      [...order].sort((a, b) => a - b),
    )
  })
})
