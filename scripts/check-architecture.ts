/**
 * Architecture guardrails, rules 1–4 of phase 3 plan v3.6 §5.5 (OCV5-543, P0b).
 *
 *   1 module coverage      every production source file maps to one module of arch/modules.json
 *   2 layers and direction value imports go down the layers; same-layer modules only along the
 *                          registered DAG (`allow`); no `export *` in a module's index.ts; no reading
 *                          another package's internals by relative path; a shared module (scope with
 *                          several processes) does not depend on a module of narrower scope; no
 *                          non-literal import()/require(); L0 contracts (protocol) do not import node:*;
 *                          production code does not import test code
 *   3 single authorities   process.env, network APIs, crypto primitives, billing-table writes,
 *                          handler-level auth calls and engine/provider special cases only in the
 *                          modules registered for them (`authorities`)
 *   4 baseline only shrinks a violation's identity is rule + file + target; per identity the count may
 *                          not grow and new identities may not appear (enforce mode); entries that went
 *                          away must be removed from the baseline in the same PR
 *
 * Report period (§5.1): the default mode prints the report and exits 0; `--enforce` exits 1 on any
 * new or grown violation or stale baseline entry. Fail-closed in both modes (exit 2): missing or
 * invalid modules.json, missing baseline, a file that cannot be parsed.
 *
 * Usage: npx tsx scripts/check-architecture.ts [--root <repo>] [--enforce] [--base <git-ref>]
 *          [--json <out.json>] [--write-baseline]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import {
  type BaselineDelta,
  type CompiledSubdomainRule,
  FILE_CYCLES_BASELINE_REL,
  type FileCycle,
  RULE_REMEDIATION,
  SUBDOMAIN_BASELINE_REL,
  type SubdomainDef,
  ambiguousSubdomainMatch,
  carryFileCycles,
  checkIntramoduleEdge,
  compareFileCycles,
  compareFileCyclesBaseline,
  emitArchitectureSummary,
  evaluateAuxBaselines,
  fileCycleKey,
  findCycle,
  findFileCycles,
  formatGateRemediation,
  gitShowFileAt,
  globToRegExp,
  matchSubdomain,
  sha256Hex,
  specificity,
  tallyFileCycles,
  validateAndCompileSubdomains,
  writeRequestedBaselines,
} from './lib/archMapUpgrades.ts'

export {
  FILE_CYCLES_BASELINE_REL,
  RULE_REMEDIATION,
  SUBDOMAIN_BASELINE_REL,
  carryFileCycles,
  compareFileCycles,
  compareFileCyclesBaseline,
  fileCycleKey,
  findFileCycles,
  formatGateRemediation,
  globToRegExp,
  sha256Hex,
  tallyFileCycles,
}
export type { BaselineDelta, FileCycle, SubdomainDef }

type Layer =
  | 'L0'
  | 'L1'
  | 'L2'
  | 'L3'
  | 'L4'
  | 'L5'
  | 'L6'
  | 'F0'
  | 'F1'
  | 'F2'
  | 'F3'
  | 'F4'
  | 'F5'
interface ModuleDef {
  layer: Layer
  scope?: string[]
  match: string[]
  allow?: string[]
  authorities?: string[]
  boundaryBaseline?: 'main' | 'subdomain'
  subdomains?: Record<string, SubdomainDef>
  note?: string
}
interface ModulesFile {
  schema: number
  modules: Record<string, ModuleDef>
}
export interface Violation {
  rule: string
  file: string
  target: string
}

const LAYER_RANK: Record<string, number> = {
  L0: 0,
  L1: 1,
  L2: 2,
  L3: 3,
  L4: 4,
  L5: 5,
  L6: 6,
  F0: 0,
  F1: 1,
  F2: 2,
  F3: 3,
  F4: 4,
  F5: 5,
}
const AUTHORITIES = ['env', 'net', 'crypto', 'billing-sql', 'handler-auth', 'special-case'] as const
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  'coverage',
  '.vite',
  '.cache',
  '__tests__',
  '__smoke__',
])

function fail(msg: string): never {
  console.error(`[architecture] ${msg}`)
  process.exit(2)
}

export function isProductionSource(rel: string): boolean {
  return (
    /\.(ts|tsx|mts)$/.test(rel) &&
    !/\.d\.ts$/.test(rel) &&
    !/\.(test|spec)\.(ts|tsx)$/.test(rel) &&
    !/(^|\/)(__tests__|__smoke__|test|tests|browser-tests)\//.test(rel)
  )
}

function walk(root: string, rel: string, out: string[]): void {
  const abs = path.join(root, rel)
  if (!existsSync(abs)) return
  for (const ent of readdirSync(abs, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue
    const r = `${rel}/${ent.name}`
    if (ent.isDirectory()) walk(root, r, out)
    else if (ent.isFile() && isProductionSource(r)) out.push(r)
  }
}

/** Production files: every package's source tree (packages/<p>/src and packages/channels/<c>/src). */
export function productionFiles(root: string): string[] {
  const out: string[] = []
  for (const p of readdirSync(path.join(root, 'packages'))) {
    if (p === 'channels') {
      for (const c of readdirSync(path.join(root, 'packages/channels')))
        walk(root, `packages/channels/${c}/src`, out)
    } else walk(root, `packages/${p}/src`, out)
  }
  return out.sort()
}

export class ModuleMap {
  private readonly rules: { id: string; re: RegExp; score: number }[] = []
  private readonly subdomainRules = new Map<string, CompiledSubdomainRule[]>()
  constructor(readonly def: ModulesFile) {
    if (def.schema !== 1 || typeof def.modules !== 'object')
      throw new Error('modules.json: schema must be 1 with a modules object')
    for (const [id, m] of Object.entries(def.modules)) {
      if (!(m.layer in LAYER_RANK))
        throw new Error(`modules.json: ${id} has unknown layer ${m.layer}`)
      if (!Array.isArray(m.match) || !m.match.length)
        throw new Error(`modules.json: ${id} has no match globs`)
      if (
        m.boundaryBaseline !== undefined &&
        m.boundaryBaseline !== 'main' &&
        m.boundaryBaseline !== 'subdomain'
      )
        throw new Error(
          `modules.json: ${id} has invalid boundaryBaseline ${String(m.boundaryBaseline)}`,
        )
      for (const a of m.allow ?? [])
        if (!(a in def.modules)) throw new Error(`modules.json: ${id} allows unknown module ${a}`)
      for (const a of m.authorities ?? []) {
        if (!(AUTHORITIES as readonly string[]).includes(a))
          throw new Error(`modules.json: ${id} has unknown authority ${a}`)
      }
      for (const g of m.match) this.rules.push({ id, re: globToRegExp(g), score: specificity(g) })
      if (m.subdomains !== undefined) {
        this.subdomainRules.set(id, validateAndCompileSubdomains(id, m.subdomains))
      }
    }
    // Same-layer `allow` edges must form a DAG.
    const cyc = findCycle(
      Object.fromEntries(
        Object.entries(def.modules).map(([id, m]) => [
          id,
          (m.allow ?? []).filter((a) => def.modules[a]!.layer === m.layer),
        ]),
      ),
    )
    if (cyc)
      throw new Error(`modules.json: same-layer allow edges form a cycle: ${cyc.join(' → ')}`)
  }
  /** Most specific match wins (longest literal prefix, then most literal characters); a tie between
   * two modules is an error in modules.json, reported by `ambiguous`. */
  moduleOf(file: string): string | null {
    let best: { id: string; score: number } | null = null
    for (const r of this.rules) {
      if (!r.re.test(file)) continue
      if (!best || r.score > best.score) best = { id: r.id, score: r.score }
    }
    return best?.id ?? null
  }
  ambiguous(file: string): string[] {
    const hits = this.rules.filter((r) => r.re.test(file))
    const top = Math.max(...hits.map((r) => r.score))
    const ids = [...new Set(hits.filter((r) => r.score === top).map((r) => r.id))]
    return ids.length > 1 ? ids : []
  }
  subdomainOf(modId: string, file: string): string | null {
    const rules = this.subdomainRules.get(modId)
    return rules ? matchSubdomain(rules, file) : null
  }
  ambiguousSubdomain(modId: string, file: string): string[] {
    const rules = this.subdomainRules.get(modId)
    return rules ? ambiguousSubdomainMatch(rules, file) : []
  }
  usesSubdomainBoundaryBaseline(modId: string): boolean {
    return this.def.modules[modId]?.boundaryBaseline === 'subdomain'
  }
  get(id: string): ModuleDef {
    return this.def.modules[id]!
  }
}

// ── package resolution ─────────────────────────────────────────────────────────
interface Pkg {
  name: string
  dir: string
  exports?: unknown
}
function packages(root: string): Pkg[] {
  const out: Pkg[] = []
  const add = (dir: string) => {
    const f = path.join(root, dir, 'package.json')
    if (existsSync(f)) {
      const j = JSON.parse(readFileSync(f, 'utf8'))
      out.push({ name: j.name, dir, exports: j.exports })
    }
  }
  for (const p of readdirSync(path.join(root, 'packages'))) {
    if (p === 'channels')
      for (const c of readdirSync(path.join(root, 'packages/channels')))
        add(`packages/channels/${c}`)
    else add(`packages/${p}`)
  }
  return out
}
const EXTS = ['.ts', '.tsx', '.mts', '.js', '.mjs', '.json']
function resolveFile(root: string, base: string): string | null {
  const cands = [base]
  const noJs = base.replace(/\.(m|c)?js$/, '')
  if (noJs !== base) cands.push(...EXTS.map((e) => noJs + e))
  cands.push(...EXTS.map((e) => base + e), ...EXTS.map((e) => `${base}/index${e}`))
  for (const c of cands) {
    const abs = path.join(root, c)
    if (existsSync(abs) && statSync(abs).isFile()) return c
  }
  return null
}
export function resolveSpec(
  root: string,
  pkgs: Pkg[],
  from: string,
  spec: string,
): { files: string[]; pkg: Pkg | null } {
  if (spec.startsWith('.')) {
    const f = resolveFile(
      root,
      path.posix.normalize(path.posix.join(path.posix.dirname(from), spec)),
    )
    // an unresolved relative import is internal by definition: report it, never treat it as external
    return { files: f ? [f] : [], pkg: f ? pkgOf(pkgs, f) : pkgOf(pkgs, from) }
  }
  const p = pkgs.find((x) => spec === x.name || spec.startsWith(`${x.name}/`))
  if (!p) return { files: [], pkg: null }
  const sub = spec.slice(p.name.length + 1)
  // package.json `exports` first (the runtime resolves through it), then the src/ convention.
  const viaExports = exportTargets(p.exports, sub ? `./${sub}` : '.')
    .map((t) => resolveFile(root, path.posix.normalize(`${p.dir}/${t}`)))
    .filter((f): f is string => !!f)
  if (viaExports.length) return { files: [...new Set(viaExports)], pkg: p }
  const f = sub
    ? (resolveFile(root, `${p.dir}/src/${sub}`) ?? resolveFile(root, `${p.dir}/${sub}`))
    : resolveFile(root, `${p.dir}/src/index`)
  return { files: f ? [f] : [], pkg: p }
}
/**
 * Every runtime file an `exports` entry can load for this subpath (wildcards one level). `types` is
 * not a runtime target, so it is never an edge; when conditions disagree, each one is an edge.
 */
export function exportTargets(exp: unknown, sub: string): string[] {
  if (!exp) return []
  if (typeof exp === 'string') return sub === '.' ? [exp] : []
  if (typeof exp !== 'object') return []
  const map = exp as Record<string, unknown>
  const pick = (v: unknown): string[] => {
    if (typeof v === 'string') return [v]
    if (Array.isArray(v)) return v.flatMap(pick)
    if (v && typeof v === 'object')
      return Object.entries(v as Record<string, unknown>)
        .filter(([k]) => k !== 'types')
        .flatMap(([, x]) => pick(x))
    return []
  }
  const uniq = (xs: string[]) => [...new Set(xs)]
  if (!Object.keys(map).some((k) => k.startsWith('.'))) return sub === '.' ? uniq(pick(map)) : []
  if (sub in map) return uniq(pick(map[sub]))
  for (const [k, v] of Object.entries(map)) {
    const star = k.indexOf('*')
    if (star < 0) continue
    const pre = k.slice(0, star)
    const post = k.slice(star + 1)
    if (sub.startsWith(pre) && sub.endsWith(post))
      return uniq(
        pick(v).map((t) => t.replace('*', sub.slice(pre.length, sub.length - post.length))),
      )
  }
  return []
}

function pkgOf(pkgs: Pkg[], file: string): Pkg | null {
  let best: Pkg | null = null
  for (const p of pkgs)
    if (file.startsWith(`${p.dir}/`) && (!best || p.dir.length > best.dir.length)) best = p
  return best
}

// ── per-file facts from the TypeScript AST ─────────────────────────────────────
export interface FileFacts {
  imports: { spec: string; type: boolean; line: number }[]
  dynamicNonLiteral: number
  exportStar: number
  env: number
  net: number
  crypto: number
  billingSql: number
  handlerAuth: number
  specialCase: number
}
const NET_MODULES = new Set([
  'undici',
  'node:http',
  'node:https',
  'http',
  'https',
  'node:net',
  'net',
  'node:tls',
  'tls',
  'node:http2',
  'http2',
])
const CRYPTO_FNS = new Set([
  'createCipheriv',
  'createDecipheriv',
  'createHmac',
  'timingSafeEqual',
  'createSign',
  'createVerify',
  'pbkdf2',
  'pbkdf2Sync',
  'scrypt',
  'scryptSync',
  'hkdf',
  'hkdfSync',
])
const AUTH_FNS = new Set([
  'requireAuth',
  'requireAdmin',
  'requireAdminVerifyDb',
  'requireUserVerifyDb',
  'verifyContainerIdentity',
])
const SPECIAL_NAMES = /^(engineId|engine|provider|providerId|upstreamProvider)$/
const BILLING_SQL =
  /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?(?:credit_ledger|usage_records|request_finalize_journal|orders|topup_orders|refunds?)\b|\bUPDATE\s+"?users"?\s+SET\s+[^;]*\bcredits\b/i

export function factsOf(fileName: string, text: string): FileFacts {
  const sf = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const f: FileFacts = {
    imports: [],
    dynamicNonLiteral: 0,
    exportStar: 0,
    env: 0,
    net: 0,
    crypto: 0,
    billingSql: 0,
    handlerAuth: 0,
    specialCase: 0,
  }
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  // local name → every name it was bound from, so `import { createHmac as h }` and
  // `const { requireAuth: ra } = x` are still recognised at the call site. Bindings are only ever
  // added, never replaced: a same-named local in another scope must not erase an import's identity
  // (that can over-count a shadowed name, never under-count a real call).
  const alias = new Map<string, Set<string>>()
  const bind = (local: string, from: string) => {
    const s = alias.get(local) ?? new Set<string>()
    s.add(from)
    for (const x of alias.get(from) ?? []) s.add(x)
    alias.set(local, s)
  }
  const collect = (n: ts.Node): void => {
    if (ts.isImportSpecifier(n)) bind(n.name.text, (n.propertyName ?? n.name).text)
    else if (
      ts.isBindingElement(n) &&
      ts.isIdentifier(n.name) &&
      n.propertyName &&
      ts.isIdentifier(n.propertyName)
    )
      bind(n.name.text, n.propertyName.text)
    else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const init = n.initializer
      if (ts.isIdentifier(init)) bind(n.name.text, init.text)
      else if (ts.isPropertyAccessExpression(init)) bind(n.name.text, init.name.text)
    }
    ts.forEachChild(n, collect)
  }
  collect(sf)
  const namesOf = (id: string) => new Set([id, ...(alias.get(id) ?? [])])
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const c = n.importClause
      const allTypeNamed =
        !!c &&
        !c.name &&
        !!c.namedBindings &&
        ts.isNamedImports(c.namedBindings) &&
        c.namedBindings.elements.length > 0 &&
        c.namedBindings.elements.every((e) => e.isTypeOnly)
      const type = !!c && (c.isTypeOnly || allTypeNamed)
      f.imports.push({ spec: n.moduleSpecifier.text, type, line: line(n) })
      if (!type && NET_MODULES.has(n.moduleSpecifier.text)) f.net++
    } else if (
      ts.isExportDeclaration(n) &&
      n.moduleSpecifier &&
      ts.isStringLiteral(n.moduleSpecifier)
    ) {
      f.imports.push({ spec: n.moduleSpecifier.text, type: n.isTypeOnly, line: line(n) })
      if (!n.exportClause && !n.isTypeOnly) f.exportStar++
    } else if (
      ts.isImportEqualsDeclaration(n) &&
      ts.isExternalModuleReference(n.moduleReference) &&
      ts.isStringLiteral(n.moduleReference.expression)
    ) {
      f.imports.push({ spec: n.moduleReference.expression.text, type: n.isTypeOnly, line: line(n) })
    } else if (ts.isCallExpression(n)) {
      const callee = n.expression
      const isImport = callee.kind === ts.SyntaxKind.ImportKeyword
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require'
      if (isImport || isRequire) {
        const a = n.arguments[0]
        if (a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a))) {
          f.imports.push({ spec: a.text, type: false, line: line(n) })
          if (NET_MODULES.has(a.text)) f.net++
        } else f.dynamicNonLiteral++
      }
      const names = ts.isIdentifier(callee)
        ? namesOf(callee.text)
        : new Set(ts.isPropertyAccessExpression(callee) ? [callee.name.text] : [])
      if (
        names.has('fetch') &&
        (ts.isIdentifier(callee) ||
          (ts.isPropertyAccessExpression(callee) &&
            ts.isIdentifier(callee.expression) &&
            ['globalThis', 'window', 'self'].includes(callee.expression.text)))
      )
        f.net++
      if ([...names].some((x) => CRYPTO_FNS.has(x))) f.crypto++
      if ([...names].some((x) => AUTH_FNS.has(x))) f.handlerAuth++
    } else if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
      const nameText = ts.isPropertyAccessExpression(n)
        ? n.name.text
        : ts.isStringLiteral(n.argumentExpression)
          ? n.argumentExpression.text
          : ''
      if (nameText === 'env') {
        const obj = n.expression
        const isProcess =
          (ts.isIdentifier(obj) && obj.text === 'process') ||
          (ts.isPropertyAccessExpression(obj) &&
            obj.name.text === 'process' &&
            ts.isIdentifier(obj.expression) &&
            obj.expression.text === 'globalThis')
        if (isProcess) f.env++
      }
    } else if (ts.isBinaryExpression(n)) {
      const op = n.operatorToken.kind
      if (
        op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsEqualsToken
      ) {
        const named = (e: ts.Expression) =>
          (ts.isIdentifier(e) && SPECIAL_NAMES.test(e.text)) ||
          (ts.isPropertyAccessExpression(e) && SPECIAL_NAMES.test(e.name.text))
        const lit = (e: ts.Expression) =>
          ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)
        if ((named(n.left) && lit(n.right)) || (named(n.right) && lit(n.left))) f.specialCase++
      }
    } else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      if (BILLING_SQL.test(n.text)) f.billingSql++
    } else if (ts.isTemplateExpression(n)) {
      const t = n.head.text + n.templateSpans.map((s) => ` $ ${s.literal.text}`).join('')
      if (BILLING_SQL.test(t)) f.billingSql++
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  if (sf.parseDiagnostics?.length)
    throw new Error(
      `${fileName}: ${ts.flattenDiagnosticMessageText(sf.parseDiagnostics[0]!.messageText, ' ')}`,
    )
  return f
}

// ── rules ──────────────────────────────────────────────────────────────────────
export function check(
  root: string,
  map: ModuleMap,
): {
  violations: Violation[]
  subdomainViolations: Violation[]
  fileCycles: FileCycle[]
  files: number
  edges: number
  intramoduleEdges: number
} {
  const pkgs = packages(root)
  const files = productionFiles(root)
  const prodFileSet = new Set(files)
  const fileGraph = new Map<string, Set<string>>(files.map((f) => [f, new Set<string>()]))
  const out: Violation[] = []
  const subdomainOut: Violation[] = []
  let edges = 0
  let intramoduleEdges = 0
  const v = (rule: string, file: string, target = '-') => out.push({ rule, file, target })
  const pushBoundary = (toSubdomain: boolean, rule: string, file: string, target: string) =>
    (toSubdomain ? subdomainOut : out).push({ rule, file, target })

  for (const file of files) {
    const mod = map.moduleOf(file)
    // parse every production file first: an unmapped file that does not parse is still exit 2
    let facts: FileFacts
    try {
      facts = factsOf(file, readFileSync(path.join(root, file), 'utf8'))
    } catch (e) {
      fail(`cannot parse ${(e as Error).message}`)
    }
    if (!mod) {
      v('R1-unmapped', file)
      continue
    }
    const amb = map.ambiguous(file)
    if (amb.length) fail(`modules.json maps ${file} to ${amb.join(' and ')} with equal specificity`)
    const ambSub = map.ambiguousSubdomain(mod, file)
    if (ambSub.length)
      fail(
        `modules.json maps ${file} in ${mod} to subdomains ${ambSub.join(' and ')} with equal specificity`,
      )
    const me = map.get(mod)
    const myPkg = pkgOf(pkgs, file)
    const fromSub = me.subdomains ? map.subdomainOf(mod, file) : null
    for (const imp of facts.imports) {
      if (imp.spec.startsWith('node:') && me.layer === 'L0' && !imp.type)
        v('R2-contract-node', file, imp.spec)
      if (imp.type) continue
      const r = resolveSpec(root, pkgs, file, imp.spec)
      if (!r.pkg) continue // external package
      if (!r.files.length) {
        v('R2-unresolved-internal', file, imp.spec) // an internal import the checker cannot follow is not "no violation"
        continue
      }
      for (const target of r.files) {
        if (target !== file && prodFileSet.has(target)) fileGraph.get(file)!.add(target)
        if (imp.spec.startsWith('.') && r.pkg !== myPkg)
          v('R2-cross-package-internal', file, target)
        if (
          /\.(ts|tsx|mts)$/.test(target) &&
          !/\.d\.ts$/.test(target) &&
          !isProductionSource(target)
        ) {
          v('R2-imports-test-code', file, target) // production code must not import test helpers (§3.1)
          continue
        }
        const tm = map.moduleOf(target)
        if (!tm) continue
        if (tm === mod) {
          if (me.subdomains && fromSub && target !== file) {
            const toSub = map.subdomainOf(mod, target)
            if (toSub && toSub !== fromSub) {
              intramoduleEdges++
              const bad = checkIntramoduleEdge(mod, me.subdomains, fromSub, toSub)
              if (bad) subdomainOut.push({ rule: 'R2-intramodule-boundary', file, target: bad })
            }
          }
          continue
        }
        edges++
        const t = map.get(tm)
        const toSubdomain =
          map.usesSubdomainBoundaryBaseline(mod) || map.usesSubdomainBoundaryBaseline(tm)
        const front = me.layer.startsWith('F')
        if (front !== t.layer.startsWith('F') && !(front && t.layer === 'L0'))
          pushBoundary(toSubdomain, 'R2-front-back', file, tm)
        else if (LAYER_RANK[t.layer]! > LAYER_RANK[me.layer]!)
          pushBoundary(toSubdomain, 'R2-upward', file, tm)
        else if (t.layer === me.layer && !(me.allow ?? []).includes(tm))
          pushBoundary(toSubdomain, 'R2-same-layer', file, tm)
        const ms = me.scope ?? []
        const tsc = t.scope ?? []
        if (ms.length > 1 && tsc.length && !ms.every((s) => tsc.includes(s)))
          pushBoundary(toSubdomain, 'R2-scope', file, tm)
      }
    }
    if (facts.dynamicNonLiteral)
      for (let i = 0; i < facts.dynamicNonLiteral; i++) v('R2-dynamic-import', file)
    if (facts.exportStar && /\/index\.tsx?$/.test(file))
      for (let i = 0; i < facts.exportStar; i++) v('R2-export-star', file)
    const auth = new Set(me.authorities ?? [])
    const count = (n: number, a: string) => {
      if (!auth.has(a)) for (let i = 0; i < n; i++) v(`R3-${a}`, file)
    }
    count(facts.env, 'env')
    count(facts.net, 'net')
    count(facts.crypto, 'crypto')
    count(facts.billingSql, 'billing-sql')
    count(facts.handlerAuth, 'handler-auth')
    count(facts.specialCase, 'special-case')
  }
  const fileCycles = findFileCycles(fileGraph)
  return {
    violations: out,
    subdomainViolations: subdomainOut,
    fileCycles,
    files: files.length,
    edges,
    intramoduleEdges,
  }
}

export const keyOf = (x: Violation) => `${x.rule}|${x.file}|${x.target}`
export function tally(vs: Violation[]): Record<string, number> {
  const t: Record<string, number> = {}
  for (const x of vs) t[keyOf(x)] = (t[keyOf(x)] ?? 0) + 1
  return Object.fromEntries(Object.entries(t).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/** Git renames base...HEAD (one-to-one pairs only), used to carry baseline entries across a move. */
export function renamesSince(root: string, base: string): Map<string, string> {
  const out = new Map<string, string>()
  let txt: string
  try {
    txt = execFileSync(
      'git',
      ['diff', '-M', '--name-status', '--diff-filter=R', `${base}...HEAD`],
      {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
  } catch (e) {
    fail(`git diff ${base}...HEAD: ${(e as Error).message.split('\n')[0]}`)
  }
  for (const l of txt.split('\n')) {
    const [st, from, to] = l.split('\t')
    if (st?.startsWith('R') && from && to) out.set(from, to)
  }
  return out
}

/** Raw text of `arch/violations-baseline.json` as committed at `rev`, or null when absent. */
export function baselineRawAt(root: string, rev: string): string | null {
  return gitShowFileAt(root, rev, 'arch/violations-baseline.json', fail)
}

/** The baseline entries as committed at `rev`, or null when that commit has no baseline file. */
export function baselineAt(root: string, rev: string): Record<string, number> | null {
  const raw = baselineRawAt(root, rev)
  if (raw === null) return null
  try {
    const j = JSON.parse(raw)
    if (j.schema !== 1 || !j.entries || typeof j.entries !== 'object') throw new Error('bad shape')
    return j.entries
  } catch (e) {
    fail(`invalid baseline at ${rev}: ${(e as Error).message}`)
  }
}

/** Baseline keys rewritten through git renames (file and target), counts summed. */
export function carry(entries: Record<string, number>, renames = new Map<string, string>()) {
  const moved: Record<string, number> = {}
  for (const [k, n] of Object.entries(entries)) {
    const [rule, file, target] = k.split('|')
    const nk = `${rule}|${renames.get(file!) ?? file}|${renames.get(target!) ?? target}`
    moved[nk] = (moved[nk] ?? 0) + n
  }
  return moved
}

export function compare(
  baseline: Record<string, number>,
  current: Record<string, number>,
  renames = new Map<string, string>(),
) {
  const moved = carry(baseline, renames)
  const grown: BaselineDelta[] = []
  const stale: BaselineDelta[] = []
  for (const [k, n] of Object.entries(current))
    if (n > (moved[k] ?? 0)) grown.push({ key: k, baseline: moved[k] ?? 0, now: n })
  for (const [k, n] of Object.entries(moved))
    if ((current[k] ?? 0) < n) stale.push({ key: k, baseline: n, now: current[k] ?? 0 })
  return { grown, stale }
}

export interface ApprovedRebaseline {
  readonly ticket: string
  /** Exact SHA-256 hex digest of `<base>:arch/violations-baseline.json` raw bytes. */
  readonly fromBaselineSha256: string
  /** Exact SHA-256 hex digest of calibrated `arch/violations-baseline.json` raw bytes. */
  readonly toBaselineSha256: string
}

/**
 * Single-use CODEOWNERS-locked dual-hash rebaseline transition (OCV5-847):
 * permits ONLY the exact transition `fromBaselineSha256 -> toBaselineSha256`.
 * Immune to concurrent commits moving the base ref before merge, and permanently
 * self-invalidates after merge once base advances to `toBaselineSha256`.
 */
export const APPROVED_REBASELINE: ApprovedRebaseline = {
  ticket: 'OCV5-847',
  fromBaselineSha256: 'fa8553f1bf291dcf3e887f7a4e4a138c0c94a24b311c2ab19eaebffaa9b71eb6',
  toBaselineSha256: '897f3d1626d20b563406811442962fe550c445146dabc74f8f9bb42aadc6d3f4',
}

export function isApprovedRebaseline(
  baseBaselineRaw: string | null,
  headBaselineRaw: string,
  anchor: ApprovedRebaseline | null = APPROVED_REBASELINE,
): boolean {
  if (!anchor || baseBaselineRaw === null) return false
  return (
    sha256Hex(baseBaselineRaw) === anchor.fromBaselineSha256.toLowerCase() &&
    sha256Hex(headBaselineRaw) === anchor.toBaselineSha256.toLowerCase()
  )
}

function main() {
  const argv = process.argv.slice(2)
  const opt = (name: string) => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const root = path.resolve(
    opt('--root') ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'),
  )
  const enforce = argv.includes('--enforce')
  const t0 = Date.now()
  const mf = path.join(root, 'arch/modules.json')
  const bf = path.join(root, 'arch/violations-baseline.json')
  if (!existsSync(mf)) fail(`missing ${mf}`)
  let map: ModuleMap
  try {
    map = new ModuleMap(JSON.parse(readFileSync(mf, 'utf8')))
  } catch (e) {
    fail(`invalid modules.json: ${(e as Error).message}`)
  }
  const res = check(root, map)
  const current = tally(res.violations)
  const currentSubdomains = tally(res.subdomainViolations)
  const currentFileCycles = tallyFileCycles(res.fileCycles)
  if (
    writeRequestedBaselines({
      root,
      bf,
      argv,
      current,
      currentSubdomains,
      currentFileCycles,
      mainCount: res.violations.length,
      subCount: res.subdomainViolations.length,
    })
  )
    return

  if (!existsSync(bf)) fail(`missing ${bf}`)
  const baselineRaw = readFileSync(bf, 'utf8')
  const baseline = JSON.parse(baselineRaw)
  if (
    baseline.schema !== 1 ||
    !baseline.entries ||
    typeof baseline.entries !== 'object' ||
    Array.isArray(baseline.entries)
  )
    fail('invalid violations-baseline.json')
  for (const [k, n] of Object.entries(baseline.entries)) {
    if (!/^R\d-[a-z-]+\|[^|]+\|[^|]+$/.test(k) || !Number.isInteger(n) || (n as number) < 1)
      fail(`invalid violations-baseline.json entry ${JSON.stringify(k)}: ${JSON.stringify(n)}`)
  }
  const base = opt('--base')
  const renames = base ? renamesSince(root, base) : undefined
  const { grown, stale } = compare(baseline.entries, current, renames)
  let baselineGrown: BaselineDelta[] = []
  let baseHasBaseline = false
  let rebaselineAnchored = false
  if (base) {
    const prevRaw = baselineRawAt(root, base)
    if (prevRaw !== null) {
      baseHasBaseline = true
      if (isApprovedRebaseline(prevRaw, baselineRaw)) rebaselineAnchored = true
      else {
        let prev: Record<string, number>
        try {
          const j = JSON.parse(prevRaw)
          if (j.schema !== 1 || !j.entries || typeof j.entries !== 'object')
            throw new Error('bad shape')
          prev = j.entries
        } catch (e) {
          fail(`invalid baseline at ${base}: ${(e as Error).message}`)
        }
        baselineGrown = compare(prev, carry(baseline.entries, renames), renames).grown
      }
    }
  }
  const aux = evaluateAuxBaselines({
    root,
    base,
    renames,
    currentFileCycles,
    currentSubdomains,
    compareEntries: compare,
    carryEntries: carry,
    fail,
  })
  const allGrown = [...grown, ...aux.fileCycleGrown, ...aux.subdomainGrown]
  const allStale = [...stale, ...aux.fileCycleStale, ...aux.subdomainStale]
  const allBaselineGrown = [
    ...baselineGrown,
    ...aux.fileCycleBaselineGrown,
    ...aux.subdomainBaselineGrown,
  ]
  const byRule: Record<string, number> = {}
  for (const x of res.violations) byRule[x.rule] = (byRule[x.rule] ?? 0) + 1
  for (const x of res.subdomainViolations) byRule[x.rule] = (byRule[x.rule] ?? 0) + 1
  if (res.fileCycles.length) byRule['R2-file-cycle'] = res.fileCycles.length
  const unmapped = res.violations.filter((x) => x.rule === 'R1-unmapped').length
  const seconds = (Date.now() - t0) / 1000
  const report = {
    mode: enforce ? ('enforce' as const) : ('report' as const),
    files: res.files,
    edges: res.edges,
    intramoduleEdges: res.intramoduleEdges,
    seconds,
    unmapped,
    byRule,
    identities: Object.keys(current).length,
    fileCycles: res.fileCycles.length,
    subdomainIdentities: Object.keys(currentSubdomains).length,
    grown,
    stale,
    baselineGrown,
    ...aux,
  }
  const jout = opt('--json')
  if (jout) writeFileSync(jout, `${JSON.stringify(report, null, 1)}\n`)
  emitArchitectureSummary({
    mode: report.mode,
    files: res.files,
    edges: res.edges,
    intramoduleEdges: res.intramoduleEdges,
    fileCyclesCount: res.fileCycles.length,
    seconds,
    byRule,
    allGrown,
    allStale,
    allBaselineGrown,
    unmapped,
    rebaselineNotice: rebaselineAnchored
      ? `[architecture] approved rebaseline anchor matched (${APPROVED_REBASELINE.ticket}, ${APPROVED_REBASELINE.fromBaselineSha256.slice(0, 12)} -> ${APPROVED_REBASELINE.toBaselineSha256.slice(0, 12)}): skipping baseline-grown diff; enforcing new/grown=0 stale=0 unmapped=0`
      : null,
    baseIntroducedNotice:
      base && !baseHasBaseline ? `[architecture] ${base} has no baseline: introduced here` : null,
  })
  if (enforce && (allGrown.length || allStale.length || allBaselineGrown.length || unmapped))
    process.exit(1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
