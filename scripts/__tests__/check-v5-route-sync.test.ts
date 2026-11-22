import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkV5RouteSync } from '../check-v5-route-sync.ts'

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../check-v5-route-sync.ts')
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function makeFixture(
  t: { after(fn: () => void): void },
  overrides: {
    agentsTs?: string
    allowlistTs?: string
    routerTs?: string
    closureTs?: string
  } = {},
): string {
  const root = mkdtempSync(path.join(tmpdir(), 'route-sync-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (rel: string, text: string) => {
    const abs = path.join(root, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, text)
  }
  put('packages/gateway/src/server.ts', `export function handle(url: URL) { if (url.pathname === '/api/config') return true; return false }\n`)
  put(
    'packages/gateway/src/routes/agents.ts',
    overrides.agentsTs ??
      `export function match(url: URL) {
  if (url.pathname === '/api/agents') return 1
  if (url.pathname.match(/^\\/api\\/agents\\/([a-zA-Z0-9_-]+)\\/memory\\/(memory|user)$/)) return 2
  if (url.pathname.match(/^\\/api\\/agents\\/([a-zA-Z0-9_-]+)\\/message$/)) return 3
  return 0
}
`,
  )
  put(
    'packages/gateway/src/bridgeApiAllowlist.ts',
    overrides.allowlistTs ??
      `const M = (...m: string[]) => new Set(m)
export const BRIDGE_API_ALLOWLIST = [
  { label: '/api/agents', re: /^\\/api\\/agents$/, methods: M('GET'), proxyFromCommercial: true },
  { label: '/api/agents/:id/memory/:target', re: /^\\/api\\/agents\\/[^/]+\\/memory\\/(memory|user)$/, methods: M('GET', 'PUT'), proxyFromCommercial: true },
]
`,
  )
  put(
    'packages/commercial/src/http/router.ts',
    overrides.routerTs ??
      `const BLOCKED_FOR_USER_RULES = [
  { re: /^\\/api\\/agents$/, label: '/api/agents' },
  { re: /^\\/api\\/agents\\/[^/]+\\/memory\\/(memory|user)$/, label: '/api/agents/:id/memory/*' },
  { re: /^\\/api\\/agents\\/[^/]+\\/message$/, label: '/api/agents/:id/message' },
  { re: /^\\/api\\/config$/, label: '/api/config' },
]
`,
  )
  put(
    'packages/commercial/src/__tests__/containerRouteProxyClosure.test.ts',
    overrides.closureTs ??
      `const NOT_PROXIED_ON_PURPOSE = [
  { re: /^\\/api\\/agents\\/[^/]+\\/message$/, reason: 'Personal legacy REST message route; commercial turns go via WebSocket pipeline.' },
]
`,
  )
  return root
}

describe('check-v5-route-sync', () => {
  test('GREEN: synchronized 3-surface fixture passes cleanly', (t) => {
    const root = makeFixture(t)
    const res = checkV5RouteSync(root)
    assert.deepEqual(res.violations, [])
    const cli = spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, '--root', root], {
      encoding: 'utf8',
    })
    assert.equal(cli.status, 0, cli.stderr)
  })

  test('RED: new unregistered sensitive memory sub-route in gateway fails with ROUTE-SYNC-UNOWNED & ROUTE-SYNC-MISSING-HOST-DENY', (t) => {
    const root = makeFixture(t, {
      agentsTs: `export function match(url: URL) {
  if (url.pathname === '/api/agents') return 1
  if (url.pathname.match(/^\\/api\\/agents\\/([a-zA-Z0-9_-]+)\\/memory\\/(memory|user)$/)) return 2
  if (url.pathname.match(/^\\/api\\/agents\\/([a-zA-Z0-9_-]+)\\/memory\\/export$/)) return 4
  if (url.pathname.match(/^\\/api\\/agents\\/([a-zA-Z0-9_-]+)\\/message$/)) return 3
  return 0
}
`,
    })
    const cli = spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, '--root', root], {
      encoding: 'utf8',
    })
    assert.equal(cli.status, 1)
    assert.match(cli.stderr, /\[GATE-ERROR\] ROUTE-SYNC-UNOWNED/)
    assert.match(cli.stderr, /\[GATE-ERROR\] ROUTE-SYNC-MISSING-HOST-DENY/)
    assert.match(cli.stderr, /memory\\\/export/)
  })

  test('RED: removing memory rule from BLOCKED_FOR_USER_RULES fails with ROUTE-SYNC-MISSING-HOST-DENY', (t) => {
    const root = makeFixture(t, {
      routerTs: `const BLOCKED_FOR_USER_RULES = [
  { re: /^\\/api\\/agents$/, label: '/api/agents' },
  { re: /^\\/api\\/agents\\/[^/]+\\/message$/, label: '/api/agents/:id/message' },
  { re: /^\\/api\\/config$/, label: '/api/config' },
]
`,
    })
    const res = checkV5RouteSync(root)
    assert.ok(res.violations.some((v) => v.rule === 'ROUTE-SYNC-MISSING-HOST-DENY'))
  })

  test('RED: removing NOT_PROXIED route from BLOCKED_FOR_USER_RULES fails with ROUTE-SYNC-UNDEFENDED', (t) => {
    const root = makeFixture(t, {
      routerTs: `const BLOCKED_FOR_USER_RULES = [
  { re: /^\\/api\\/agents$/, label: '/api/agents' },
  { re: /^\\/api\\/agents\\/[^/]+\\/memory\\/(memory|user)$/, label: '/api/agents/:id/memory/*' },
  { re: /^\\/api\\/config$/, label: '/api/config' },
]
`,
    })
    const res = checkV5RouteSync(root)
    assert.ok(res.violations.some((v) => v.rule === 'ROUTE-SYNC-UNDEFENDED'))
  })

  test('RED: removing memory route from BRIDGE_API_ALLOWLIST fails with ROUTE-SYNC-UNOWNED', (t) => {
    const root = makeFixture(t, {
      allowlistTs: `const M = (...m: string[]) => new Set(m)
export const BRIDGE_API_ALLOWLIST = [
  { label: '/api/agents', re: /^\\/api\\/agents$/, methods: M('GET'), proxyFromCommercial: true },
]
`,
    })
    const res = checkV5RouteSync(root)
    assert.ok(res.violations.some((v) => v.rule === 'ROUTE-SYNC-UNOWNED'))
  })

  test('RED: exposing /internal/* in BRIDGE_API_ALLOWLIST with proxyFromCommercial:true fails with ROUTE-SYNC-INTERNAL-EXPOSED', (t) => {
    const root = makeFixture(t, {
      allowlistTs: `const M = (...m: string[]) => new Set(m)
export const BRIDGE_API_ALLOWLIST = [
  { label: '/api/agents', re: /^\\/api\\/agents$/, methods: M('GET'), proxyFromCommercial: true },
  { label: '/api/agents/:id/memory/:target', re: /^\\/api\\/agents\\/[^/]+\\/memory\\/(memory|user)$/, methods: M('GET', 'PUT'), proxyFromCommercial: true },
  { label: '/internal/v3/engine-preheat', re: /^\\/internal\\/v3\\/engine-preheat$/, methods: M('POST'), proxyFromCommercial: true },
]
`,
    })
    const res = checkV5RouteSync(root)
    assert.ok(res.violations.some((v) => v.rule === 'ROUTE-SYNC-INTERNAL-EXPOSED'))
  })

  test('GREEN: equivalent split of regex branch (apply|dismiss) into two allowlist rules passes without false dead-rule', (t) => {
    const root = makeFixture(t, {
      agentsTs: `export function match(url: URL) {
  if (url.pathname === '/api/agents') return 1
  if (url.pathname.match(/^\\/api\\/agents\\/([a-zA-Z0-9_-]+)\\/memory\\/(?:memory|user)$/)) return 2
  if (url.pathname.match(/^\\/api\\/agents\\/([a-zA-Z0-9_-]+)\\/auto-dream-optimizer\\/proposals\\/([0-9a-f]{32})\\/(apply|dismiss)$/)) return 4
  if (url.pathname.match(/^\\/api\\/agents\\/([a-zA-Z0-9_-]+)\\/message$/)) return 3
  return 0
}
`,
      allowlistTs: `const M = (...m: string[]) => new Set(m)
export const BRIDGE_API_ALLOWLIST = [
  { label: '/api/agents', re: /^\\/api\\/agents$/, methods: M('GET'), proxyFromCommercial: true },
  { label: '/api/agents/:id/memory/:target', re: /^\\/api\\/agents\\/[^/]+\\/memory\\/(memory|user)$/, methods: M('GET', 'PUT'), proxyFromCommercial: true },
  { label: '/api/agents/:id/auto-dream-optimizer/proposals/:proposalId/apply', re: /^\\/api\\/agents\\/[A-Za-z0-9_-]+\\/auto-dream-optimizer\\/proposals\\/[0-9a-f]{32}\\/apply$/, methods: M('POST'), proxyFromCommercial: true },
  { label: '/api/agents/:id/auto-dream-optimizer/proposals/:proposalId/dismiss', re: /^\\/api\\/agents\\/[A-Za-z0-9_-]+\\/auto-dream-optimizer\\/proposals\\/[0-9a-f]{32}\\/dismiss$/, methods: M('POST'), proxyFromCommercial: true },
]
`,
      routerTs: `const BLOCKED_FOR_USER_RULES = [
  { re: /^\\/api\\/agents$/, label: '/api/agents' },
  { re: /^\\/api\\/agents\\/[^/]+\\/memory\\/(memory|user)$/, label: '/api/agents/:id/memory/*' },
  { re: /^\\/api\\/agents\\/[A-Za-z0-9_-]+\\/auto-dream-optimizer\\/proposals\\/[0-9a-f]{32}\\/(apply|dismiss)$/, label: '/api/agents/:id/auto-dream-optimizer/proposals/:proposalId/:action' },
  { re: /^\\/api\\/agents\\/[^/]+\\/message$/, label: '/api/agents/:id/message' },
  { re: /^\\/api\\/config$/, label: '/api/config' },
]
`,
    })
    assert.deepEqual(checkV5RouteSync(root).violations, [])
  })

  test('RED: omitting one branch (dismiss) from split allowlist fails with ROUTE-SYNC-UNOWNED', (t) => {
    const root = makeFixture(t, {
      agentsTs: `export function match(url: URL) {
  if (url.pathname === '/api/agents') return 1
  if (url.pathname.match(/^\\/api\\/agents\\/([a-zA-Z0-9_-]+)\\/memory\\/(memory|user)$/)) return 2
  if (url.pathname.match(/^\\/api\\/agents\\/([a-zA-Z0-9_-]+)\\/auto-dream-optimizer\\/proposals\\/([0-9a-f]{32})\\/(apply|dismiss)$/)) return 4
  if (url.pathname.match(/^\\/api\\/agents\\/([a-zA-Z0-9_-]+)\\/message$/)) return 3
  return 0
}
`,
      allowlistTs: `const M = (...m: string[]) => new Set(m)
export const BRIDGE_API_ALLOWLIST = [
  { label: '/api/agents', re: /^\\/api\\/agents$/, methods: M('GET'), proxyFromCommercial: true },
  { label: '/api/agents/:id/memory/:target', re: /^\\/api\\/agents\\/[^/]+\\/memory\\/(memory|user)$/, methods: M('GET', 'PUT'), proxyFromCommercial: true },
  { label: '/api/agents/:id/auto-dream-optimizer/proposals/:proposalId/apply', re: /^\\/api\\/agents\\/[A-Za-z0-9_-]+\\/auto-dream-optimizer\\/proposals\\/[0-9a-f]{32}\\/apply$/, methods: M('POST'), proxyFromCommercial: true },
]
`,
      routerTs: `const BLOCKED_FOR_USER_RULES = [
  { re: /^\\/api\\/agents$/, label: '/api/agents' },
  { re: /^\\/api\\/agents\\/[^/]+\\/memory\\/(memory|user)$/, label: '/api/agents/:id/memory/*' },
  { re: /^\\/api\\/agents\\/[A-Za-z0-9_-]+\\/auto-dream-optimizer\\/proposals\\/[0-9a-f]{32}\\/(apply|dismiss)$/, label: '/api/agents/:id/auto-dream-optimizer/proposals/:proposalId/:action' },
  { re: /^\\/api\\/agents\\/[^/]+\\/message$/, label: '/api/agents/:id/message' },
  { re: /^\\/api\\/config$/, label: '/api/config' },
]
`,
    })
    const res = checkV5RouteSync(root)
    assert.ok(res.violations.some((v) => v.rule === 'ROUTE-SYNC-UNOWNED' && v.detail.includes('/dismiss')))
  })

  test('real repository baseline passes with zero violations', () => {
    const res = checkV5RouteSync(REPO_ROOT)
    assert.ok(res.gatewayRoutes >= 50, `expected >=50 gateway routes, got ${res.gatewayRoutes}`)
    assert.ok(res.allowlistRules >= 40, `expected >=40 allowlist rules, got ${res.allowlistRules}`)
    assert.ok(res.blockedRules >= 30, `expected >=30 blocked rules, got ${res.blockedRules}`)
    assert.deepEqual(res.violations, [])
  })
})
