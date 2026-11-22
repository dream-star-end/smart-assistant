/**
 * Multi-Tenant Three-Way Route Sync Gate (Governance Blueprint §4.2 ①).
 *
 * Statically parses and cross-checks the three authoritative route surfaces:
 *   1. Container gateway routes (`packages/gateway/src/server.ts` + `packages/gateway/src/routes/*.ts`)
 *   2. Bridge allowlist (`packages/gateway/src/bridgeApiAllowlist.ts` -> `BRIDGE_API_ALLOWLIST`)
 *   3. Commercial master host-singleton firewall (`packages/commercial/src/http/router.ts` -> `BLOCKED_FOR_USER_RULES`)
 *   (+ optional deliberate non-proxy registry in `packages/commercial/src/__tests__/containerRouteProxyClosure.test.ts`)
 *
 * Enforced invariants:
 *   - ROUTE-SYNC-UNOWNED            Open-family gateway route missing from both BRIDGE_API_ALLOWLIST and NOT_PROXIED_ON_PURPOSE
 *   - ROUTE-SYNC-UNDEFENDED         Non-proxied gateway route missing from BLOCKED_FOR_USER_RULES (host singleton exposure)
 *   - ROUTE-SYNC-MISSING-HOST-DENY  Sensitive / memory gateway route missing from BLOCKED_FOR_USER_RULES
 *   - ROUTE-SYNC-DEAD-ALLOWLIST     BRIDGE_API_ALLOWLIST rule matches no real gateway route
 *   - ROUTE-SYNC-INTERNAL-EXPOSED   `/internal/*` route exposed in BRIDGE_API_ALLOWLIST with `proxyFromCommercial: true`
 *   - ROUTE-SYNC-STALE-EXEMPT       Stale, ghost, or undocumented NOT_PROXIED_ON_PURPOSE entry
 *
 * Usage:
 *   npx tsx scripts/check-v5-route-sync.ts [--root <repo>]
 *
 * Exit: 0 ok, 1 violation(s) found, 2 parse/structure error (fail-closed).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

export interface GatewayRoute {
  kind: 'exact' | 'prefix' | 'regex'
  declared: string
  sample: string
  samples: readonly string[]
  file: string
  line: number
}

export interface AllowlistRule {
  label: string
  re: RegExp
  proxyFromCommercial: boolean
  line: number
}

export interface BlockedRule {
  label: string
  re: RegExp
  line: number
}

export interface NotProxiedEntry {
  re: RegExp
  reason: string
  line: number
}

export interface RouteSyncViolation {
  rule:
    | 'ROUTE-SYNC-UNOWNED'
    | 'ROUTE-SYNC-UNDEFENDED'
    | 'ROUTE-SYNC-MISSING-HOST-DENY'
    | 'ROUTE-SYNC-DEAD-ALLOWLIST'
    | 'ROUTE-SYNC-INTERNAL-EXPOSED'
    | 'ROUTE-SYNC-STALE-EXEMPT'
  file: string
  line: number
  route: string
  detail: string
  howToFix: string
}

const GATEWAY_SERVER_REL = 'packages/gateway/src/server.ts'
const GATEWAY_ROUTES_DIR_REL = 'packages/gateway/src/routes'
const ALLOWLIST_REL = 'packages/gateway/src/bridgeApiAllowlist.ts'
const ROUTER_REL = 'packages/commercial/src/http/router.ts'
const CLOSURE_TEST_REL = 'packages/commercial/src/__tests__/containerRouteProxyClosure.test.ts'

/**
 * Sensitive gateway route patterns that MUST always be defended by `BLOCKED_FOR_USER_RULES`
 * on the commercial master host singleton.
 */
const SENSITIVE_HOST_DENY_PATTERNS: readonly RegExp[] = [
  /^\/api\/agents$/,
  /^\/api\/agents\/[^/]+$/,
  /^\/api\/agents\/[^/]+\/(persona|message|delegate)$/,
  /^\/api\/agents\/advisor\/consult$/,
  /^\/api\/agents\/[^/]+\/memory\/.+$/,
  /^\/api\/agents\/[^/]+\/browser\/(live|action)$/,
  /^\/api\/agents\/[^/]+\/auto-dream-optimizer(?:\/.*)?$/,
  /^\/api\/agents\/[^/]+\/skills(?:\/.*)?$/,
  /^\/api\/skills$/,
  /^\/api\/skills\/[^/]+\/(train|evals(?:\/generate)?|eval-run)$/,
  /^\/api\/skill-(?:training|eval|eval-gen)\/.+$/,
  /^\/api\/cron(?:\/[^/]+)?$/,
  /^\/api\/board(?:\/.*)?$/,
  /^\/api\/tasks(?:\/[^/]+)?$/,
  /^\/api\/tasks-executions$/,
  /^\/api\/webhooks(?:\/[^/]+)?$/,
  /^\/api\/(config|doctor|runs|usage(?:\/events)?|search)$/,
  /^\/api\/sessions\/(unclaimed|claim)$/,
  /^\/api\/file$/,
  /^\/api\/media\/.+$/,
  /^\/v1\/.+$/,
  /^\/metrics$/,
]

/**
 * Pre-existing baseline gap at `35c963ab7`: these two container-proxied memory archive
 * endpoints are in BRIDGE_API_ALLOWLIST (`proxyFromCommercial: true`) but not yet listed
 * in `BLOCKED_FOR_USER_RULES` in `router.ts`. Any OTHER `/api/agents/:id/memory/*` route
 * MUST be covered in BOTH `bridgeApiAllowlist.ts` and `BLOCKED_FOR_USER_RULES`.
 */
const BASELINE_HOST_DENY_GAP_RES: readonly RegExp[] = [
  /^\/api\/agents\/[^/]+\/memory\/archive(?:\/restore)?$/,
]

function pickCharForClass(classBody: string): string {
  const re = new RegExp(`^[${classBody}]$`)
  for (const ch of ['a', 'b', '0', '1', 'x', 'z', '_', '-', '.']) {
    if (re.test(ch)) return ch
  }
  throw new Error(`cannot synthesize char for regex class [${classBody}]`)
}

const MAX_BRANCH_SAMPLES = 32

function combineSamples(prefixes: readonly string[], suffixes: readonly string[], cap: number): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const p of prefixes) {
    for (const s of suffixes) {
      const merged = p + s
      if (seen.has(merged)) continue
      seen.add(merged)
      out.push(merged)
      if (out.length >= cap) return out
    }
  }
  return out
}

export function synthesizeSamplesFromRegex(src: string, maxSamples = MAX_BRANCH_SAMPLES): string[] {
  let i = 0
  const readMinRepeat = (): number => {
    const c = src[i]
    if (c === '+' || c === '*') {
      i++
      return 1
    }
    if (c === '?') throw new Error(`unsupported optional quantifier ? at ${i} in ${src}`)
    if (c === '{') {
      const close = src.indexOf('}', i)
      if (close < 0) throw new Error(`unclosed { at ${i} in ${src}`)
      const m = /^(\d+)(?:,(\d*))?$/.exec(src.slice(i + 1, close))
      if (!m) throw new Error(`bad quantifier in ${src}`)
      i = close + 1
      return Number(m[1])
    }
    return 1
  }
  const parseBranches = (inGroup: boolean): string[] => {
    const all: string[] = []
    const seen = new Set<string>()
    while (true) {
      const seq = parseSeq(inGroup)
      for (const s of seq) {
        if (!seen.has(s)) {
          seen.add(s)
          all.push(s)
          if (all.length >= maxSamples) break
        }
      }
      if (inGroup && src[i] === '|') {
        i++
        continue
      }
      break
    }
    return all
  }
  const parseSeq = (inGroup: boolean): string[] => {
    let acc: string[] = ['']
    while (i < src.length) {
      const c = src[i]!
      if (c === '^' || c === '$') {
        i++
        continue
      }
      if (c === '|' || c === ')') {
        if (inGroup) return acc
        throw new Error(`unexpected ${c} at ${i} in ${src}`)
      }
      if (c === '(') {
        i++
        if (src[i] === '?') {
          if (src[i + 1] === ':') {
            i += 2
          } else {
            throw new Error(`unsupported group (?...) at ${i} in ${src}`)
          }
        }
        const branchSamples = parseBranches(true)
        if (src[i] !== ')') throw new Error(`unclosed ( in ${src}`)
        i++
        const times = readMinRepeat()
        const repeated = branchSamples.map((s) => s.repeat(times))
        acc = combineSamples(acc, repeated, maxSamples)
        continue
      }
      if (c === '[') {
        let j = i + 1
        if (src[j] === '^') j++
        if (src[j] === ']') j++
        while (j < src.length && src[j] !== ']') {
          if (src[j] === '\\') j++
          j++
        }
        if (j >= src.length) throw new Error(`unclosed [ in ${src}`)
        const body = src.slice(i + 1, j)
        i = j + 1
        const piece = pickCharForClass(body).repeat(readMinRepeat())
        acc = acc.map((s) => s + piece)
        continue
      }
      if (c === '\\') {
        const esc = src[i + 1]
        if (esc === undefined) throw new Error(`dangling \\ in ${src}`)
        i += 2
        const ch = esc === 'd' ? '0' : esc === 'w' ? 'a' : esc
        const piece = ch.repeat(readMinRepeat())
        acc = acc.map((s) => s + piece)
        continue
      }
      if (c === '.') {
        i++
        const piece = 'a'.repeat(readMinRepeat())
        acc = acc.map((s) => s + piece)
        continue
      }
      if (/[A-Za-z0-9_/:-]/.test(c)) {
        i++
        const piece = c.repeat(readMinRepeat())
        acc = acc.map((s) => s + piece)
        continue
      }
      throw new Error(`unsupported char ${JSON.stringify(c)} at ${i} in ${src}`)
    }
    if (inGroup) throw new Error(`unclosed group in ${src}`)
    return acc
  }
  const samples = parseBranches(false)
  const re = new RegExp(src)
  for (const sample of samples) {
    if (!re.test(sample)) {
      throw new Error(`synthesized sample ${JSON.stringify(sample)} does not match /${src}/`)
    }
  }
  return samples
}

export function synthesizeSampleFromRegex(src: string): string {
  return synthesizeSamplesFromRegex(src)[0]!
}

export function routeFamily(p: string): string {
  const seg = p.split('/').filter(Boolean)
  return `/${seg.slice(0, 2).join('/')}`
}

function lineNumberOf(source: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i++) if (source.charCodeAt(i) === 10) line++
  return line
}

export function extractGatewayRoutes(root: string): GatewayRoute[] {
  const serverAbs = path.join(root, GATEWAY_SERVER_REL)
  const routesDirAbs = path.join(root, GATEWAY_ROUTES_DIR_REL)
  const files: { rel: string; abs: string }[] = []
  if (existsSync(serverAbs)) files.push({ rel: GATEWAY_SERVER_REL, abs: serverAbs })
  if (existsSync(routesDirAbs)) {
    for (const name of readdirSync(routesDirAbs).sort()) {
      if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
        files.push({
          rel: `${GATEWAY_ROUTES_DIR_REL}/${name}`,
          abs: path.join(routesDirAbs, name),
        })
      }
    }
  }
  if (!files.length) {
    throw new Error(`no gateway route files found under ${GATEWAY_SERVER_REL} or ${GATEWAY_ROUTES_DIR_REL}`)
  }

  const routes: GatewayRoute[] = []
  const seen = new Set<string>()
  const push = (r: GatewayRoute) => {
    const key = `${r.kind} ${r.declared}`
    if (seen.has(key)) return
    seen.add(key)
    routes.push(r)
  }

  for (const { rel, abs } of files) {
    const src = readFileSync(abs, 'utf8')
    for (const m of src.matchAll(/url\.pathname\s*===\s*['"](\/(?:api|internal|v1|metrics)[^'"]*)['"]/g)) {
      push({
        kind: 'exact',
        declared: m[1]!,
        sample: m[1]!,
        samples: [m[1]!],
        file: rel,
        line: lineNumberOf(src, m.index!),
      })
    }
    for (const m of src.matchAll(/url\.pathname\.startsWith\(\s*['"](\/(?:api|internal|v1)\/[^'"]*)['"]\s*\)/g)) {
      const prefix = m[1]!
      if (prefix === '/api/' || prefix === '/internal/') continue
      const sample = `${prefix}sample`
      push({
        kind: 'prefix',
        declared: prefix,
        sample,
        samples: [sample],
        file: rel,
        line: lineNumberOf(src, m.index!),
      })
    }
    for (const m of src.matchAll(
      /url\.pathname\.match\(\s*\/(\^\\\/(?:api|internal|v1)\\\/[^\n]*?)\/[a-z]*\s*[,)]/g,
    )) {
      const pattern = m[1]!
      const samples = synthesizeSamplesFromRegex(pattern)
      push({
        kind: 'regex',
        declared: pattern,
        sample: samples[0]!,
        samples,
        file: rel,
        line: lineNumberOf(src, m.index!),
      })
    }
  }
  return routes
}

function parseRegexLiteralNode(node: ts.Expression): RegExp | null {
  if (!ts.isRegularExpressionLiteral(node)) return null
  const text = node.text
  const lastSlash = text.lastIndexOf('/')
  if (lastSlash <= 0) return null
  return new RegExp(text.slice(1, lastSlash), text.slice(lastSlash + 1))
}

function parseStringExpr(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = parseStringExpr(node.left)
    const r = parseStringExpr(node.right)
    if (l !== null && r !== null) return l + r
  }
  return null
}

function findConstArrayInitializer(sf: ts.SourceFile, varName: string): ts.ArrayLiteralExpression | null {
  let found: ts.ArrayLiteralExpression | null = null
  const visit = (node: ts.Node) => {
    if (found) return
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === varName &&
      node.initializer
    ) {
      let init: ts.Expression = node.initializer
      while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init) || ts.isParenthesizedExpression(init)) {
        init = init.expression
      }
      if (ts.isArrayLiteralExpression(init)) {
        found = init
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

export function extractAllowlistRules(root: string): AllowlistRule[] {
  const abs = path.join(root, ALLOWLIST_REL)
  if (!existsSync(abs)) throw new Error(`missing ${ALLOWLIST_REL}`)
  const text = readFileSync(abs, 'utf8')
  const sf = ts.createSourceFile(ALLOWLIST_REL, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const arr = findConstArrayInitializer(sf, 'BRIDGE_API_ALLOWLIST')
  if (!arr) throw new Error(`missing BRIDGE_API_ALLOWLIST array in ${ALLOWLIST_REL}`)

  const rules: AllowlistRule[] = []
  for (const el of arr.elements) {
    if (!ts.isObjectLiteralExpression(el)) continue
    let label = ''
    let re: RegExp | null = null
    let proxyFromCommercial = false
    for (const prop of el.properties) {
      if (!ts.isPropertyAssignment(prop)) continue
      const key = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : ''
      if (key === 'label') label = parseStringExpr(prop.initializer) ?? ''
      else if (key === 're') re = parseRegexLiteralNode(prop.initializer)
      else if (key === 'proxyFromCommercial') {
        proxyFromCommercial = prop.initializer.kind === ts.SyntaxKind.TrueKeyword
      }
    }
    if (re) {
      const line = sf.getLineAndCharacterOfPosition(el.getStart(sf)).line + 1
      rules.push({ label: label || re.source, re, proxyFromCommercial, line })
    }
  }
  return rules
}

export function extractBlockedForUserRules(root: string): BlockedRule[] {
  const abs = path.join(root, ROUTER_REL)
  if (!existsSync(abs)) throw new Error(`missing ${ROUTER_REL}`)
  const text = readFileSync(abs, 'utf8')
  const sf = ts.createSourceFile(ROUTER_REL, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const arr = findConstArrayInitializer(sf, 'BLOCKED_FOR_USER_RULES')
  if (!arr) throw new Error(`missing BLOCKED_FOR_USER_RULES array in ${ROUTER_REL}`)

  const rules: BlockedRule[] = []
  for (const el of arr.elements) {
    if (!ts.isObjectLiteralExpression(el)) continue
    let label = ''
    let re: RegExp | null = null
    for (const prop of el.properties) {
      if (!ts.isPropertyAssignment(prop)) continue
      const key = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : ''
      if (key === 'label') label = parseStringExpr(prop.initializer) ?? ''
      else if (key === 're') re = parseRegexLiteralNode(prop.initializer)
    }
    if (re) {
      const line = sf.getLineAndCharacterOfPosition(el.getStart(sf)).line + 1
      rules.push({ label: label || re.source, re, line })
    }
  }
  return rules
}

export function extractNotProxiedEntries(root: string): NotProxiedEntry[] {
  const abs = path.join(root, CLOSURE_TEST_REL)
  if (!existsSync(abs)) return []
  const text = readFileSync(abs, 'utf8')
  const sf = ts.createSourceFile(CLOSURE_TEST_REL, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const arr = findConstArrayInitializer(sf, 'NOT_PROXIED_ON_PURPOSE')
  if (!arr) return []

  const entries: NotProxiedEntry[] = []
  for (const el of arr.elements) {
    if (!ts.isObjectLiteralExpression(el)) continue
    let re: RegExp | null = null
    let reason = ''
    for (const prop of el.properties) {
      if (!ts.isPropertyAssignment(prop)) continue
      const key = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : ''
      if (key === 're') re = parseRegexLiteralNode(prop.initializer)
      else if (key === 'reason') reason = parseStringExpr(prop.initializer) ?? ''
    }
    if (re) {
      const line = sf.getLineAndCharacterOfPosition(el.getStart(sf)).line + 1
      entries.push({ re, reason, line })
    }
  }
  return entries
}

export function checkV5RouteSync(root: string): {
  gatewayRoutes: number
  allowlistRules: number
  blockedRules: number
  violations: RouteSyncViolation[]
} {
  const gatewayRoutes = extractGatewayRoutes(root)
  const allowlist = extractAllowlistRules(root)
  const blocked = extractBlockedForUserRules(root)
  const notProxied = extractNotProxiedEntries(root)

  const apiRoutes = gatewayRoutes.filter((r) => r.sample.startsWith('/api/'))
  const violations: RouteSyncViolation[] = []

  const isAllowlisted = (sample: string) => allowlist.some((rule) => rule.re.test(sample))
  const isBlocked = (sample: string) => blocked.some((rule) => rule.re.test(sample))
  const isNotProxied = (sample: string) => notProxied.some((entry) => entry.re.test(sample))

  // 1. Open family closure: every gateway route (and every expanded regex branch) in a proxied family must be owned.
  const proxiedFamilies = new Set(
    allowlist.filter((r) => r.proxyFromCommercial).map((r) => routeFamily(r.label)),
  )
  for (const route of apiRoutes) {
    for (const sample of route.samples) {
      if (!proxiedFamilies.has(routeFamily(sample))) continue
      const ownedByAllowlist = isAllowlisted(sample)
      const ownedByNotProxied = isNotProxied(sample)
      if (!ownedByAllowlist && !ownedByNotProxied) {
        violations.push({
          rule: 'ROUTE-SYNC-UNOWNED',
          file: route.file,
          line: route.line,
          route: route.declared,
          detail: `Gateway route ${route.declared} (sample ${sample}) is in open family ${routeFamily(sample)}, but missing from both ${ALLOWLIST_REL} and NOT_PROXIED_ON_PURPOSE.`,
          howToFix: `Add a rule to BRIDGE_API_ALLOWLIST in ${ALLOWLIST_REL} (and host fallback in ${ROUTER_REL} BLOCKED_FOR_USER_RULES), OR register it in NOT_PROXIED_ON_PURPOSE in ${CLOSURE_TEST_REL} and deny it in BLOCKED_FOR_USER_RULES.`,
        })
      } else if (ownedByNotProxied && !isBlocked(sample)) {
        violations.push({
          rule: 'ROUTE-SYNC-UNDEFENDED',
          file: ROUTER_REL,
          line: 1,
          route: route.declared,
          detail: `Route ${route.declared} (sample ${sample}) is marked NOT_PROXIED_ON_PURPOSE but NOT denied in ${ROUTER_REL} BLOCKED_FOR_USER_RULES.`,
          howToFix: `Add a matching deny rule to BLOCKED_FOR_USER_RULES in ${ROUTER_REL} so ordinary users cannot hit the host singleton.`,
        })
      }
    }
  }

  // 2. Sensitive & memory routes declared in gateway must be defended by BLOCKED_FOR_USER_RULES.
  for (const route of gatewayRoutes) {
    for (const sample of route.samples) {
      if (!SENSITIVE_HOST_DENY_PATTERNS.some((re) => re.test(sample))) continue
      if (BASELINE_HOST_DENY_GAP_RES.some((re) => re.test(sample))) continue
      if (!isBlocked(sample)) {
        violations.push({
          rule: 'ROUTE-SYNC-MISSING-HOST-DENY',
          file: ROUTER_REL,
          line: 1,
          route: route.declared,
          detail: `Sensitive gateway route ${route.declared} (${route.file}:${route.line}, sample ${sample}) is missing from BLOCKED_FOR_USER_RULES in ${ROUTER_REL}.`,
          howToFix: `Add a host-singleton deny rule matching ${sample} to BLOCKED_FOR_USER_RULES in ${ROUTER_REL}.`,
        })
      }
    }
  }

  // 3. No dead allowlist rules & no /internal/* routes exposed via commercial proxy.
  for (const rule of allowlist) {
    if (rule.proxyFromCommercial && (rule.label.startsWith('/internal/') || rule.re.test('/internal/v3/probe'))) {
      violations.push({
        rule: 'ROUTE-SYNC-INTERNAL-EXPOSED',
        file: ALLOWLIST_REL,
        line: rule.line,
        route: rule.label,
        detail: `Internal container route ${rule.label} must NEVER have proxyFromCommercial: true in ${ALLOWLIST_REL}.`,
        howToFix: `Remove ${rule.label} from BRIDGE_API_ALLOWLIST or set proxyFromCommercial: false; internal routes must stay on authenticated container-local channels.`,
      })
    }
    if (!apiRoutes.some((r) => r.samples.some((s) => rule.re.test(s)))) {
      violations.push({
        rule: 'ROUTE-SYNC-DEAD-ALLOWLIST',
        file: ALLOWLIST_REL,
        line: rule.line,
        route: rule.label,
        detail: `BRIDGE_API_ALLOWLIST rule ${rule.label} (/${rule.re.source}/) matches no real gateway route in server.ts or routes/*.ts.`,
        howToFix: `Update the regex to match the real gateway route or remove the obsolete rule from ${ALLOWLIST_REL}.`,
      })
    }
  }

  // 4. NOT_PROXIED_ON_PURPOSE hygiene (no stale/ghost/undocumented entries).
  for (const entry of notProxied) {
    const matchedSamples = apiRoutes.flatMap((r) => r.samples.filter((s) => entry.re.test(s)))
    if (matchedSamples.length === 0) {
      violations.push({
        rule: 'ROUTE-SYNC-STALE-EXEMPT',
        file: CLOSURE_TEST_REL,
        line: entry.line,
        route: entry.re.source,
        detail: `NOT_PROXIED_ON_PURPOSE entry /${entry.re.source}/ matches no gateway route (ghost entry).`,
        howToFix: `Remove the obsolete entry from NOT_PROXIED_ON_PURPOSE in ${CLOSURE_TEST_REL}.`,
      })
    } else if (matchedSamples.some((s) => isAllowlisted(s))) {
      violations.push({
        rule: 'ROUTE-SYNC-STALE-EXEMPT',
        file: CLOSURE_TEST_REL,
        line: entry.line,
        route: entry.re.source,
        detail: `NOT_PROXIED_ON_PURPOSE entry /${entry.re.source}/ is already claimed by BRIDGE_API_ALLOWLIST.`,
        howToFix: `Remove the stale entry from NOT_PROXIED_ON_PURPOSE in ${CLOSURE_TEST_REL}.`,
      })
    } else if (entry.reason.trim().length < 20) {
      violations.push({
        rule: 'ROUTE-SYNC-STALE-EXEMPT',
        file: CLOSURE_TEST_REL,
        line: entry.line,
        route: entry.re.source,
        detail: `NOT_PROXIED_ON_PURPOSE entry /${entry.re.source}/ must document a reason (>= 20 chars).`,
        howToFix: 'Explain why this route is intentionally excluded from commercial container proxy.',
      })
    }
  }

  return {
    gatewayRoutes: gatewayRoutes.length,
    allowlistRules: allowlist.length,
    blockedRules: blocked.length,
    violations,
  }
}

export function formatViolation(v: RouteSyncViolation): string {
  return [
    `[GATE-ERROR] ${v.rule} at ${v.file}:${v.line}`,
    `  Violation : ${v.detail}`,
    '  Why       : Multi-tenant security & routing contract: gateway routes, BRIDGE_API_ALLOWLIST, and BLOCKED_FOR_USER_RULES must stay strictly synchronized to prevent 404 blackouts or host-singleton privilege escalation.',
    `  How to Fix: ${v.howToFix}`,
    '  Re-verify : npx tsx scripts/check-v5-route-sync.ts',
  ].join('\n')
}

function main(argv: string[]): number {
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') {
      const val = argv[++i]
      if (!val) {
        console.error('[v5-route-sync] --root requires a path')
        return 2
      }
      root = path.resolve(val)
    } else {
      console.error(`[v5-route-sync] unknown arg: ${argv[i]}`)
      return 2
    }
  }
  const t0 = Date.now()
  try {
    const res = checkV5RouteSync(root)
    const ms = Date.now() - t0
    for (const v of res.violations) console.error(formatViolation(v))
    console.log(
      `[v5-route-sync] gatewayRoutes=${res.gatewayRoutes} allowlist=${res.allowlistRules} blocked=${res.blockedRules} violations=${res.violations.length} (${ms}ms)`,
    )
    return res.violations.length > 0 ? 1 : 0
  } catch (err) {
    console.error(`[v5-route-sync] FAIL-CLOSED: ${(err as Error).message}`)
    return 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)))
}
