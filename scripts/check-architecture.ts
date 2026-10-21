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

/** Glob with `*` (no slash) and `**` (any depth), anchored. */
export function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*' && glob[i + 1] === '*') {
      re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'
      i += glob[i + 2] === '/' ? 2 : 1
    } else if (c === '*') re += '[^/]*'
    else if ('\\^$+?.()|{}[]'.includes(c)) re += `\\${c}`
    else re += c
  }
  return new RegExp(`^${re}$`)
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
  constructor(readonly def: ModulesFile) {
    if (def.schema !== 1 || typeof def.modules !== 'object')
      throw new Error('modules.json: schema must be 1 with a modules object')
    for (const [id, m] of Object.entries(def.modules)) {
      if (!(m.layer in LAYER_RANK))
        throw new Error(`modules.json: ${id} has unknown layer ${m.layer}`)
      if (!Array.isArray(m.match) || !m.match.length)
        throw new Error(`modules.json: ${id} has no match globs`)
      for (const a of m.allow ?? [])
        if (!(a in def.modules)) throw new Error(`modules.json: ${id} allows unknown module ${a}`)
      for (const a of m.authorities ?? []) {
        if (!(AUTHORITIES as readonly string[]).includes(a))
          throw new Error(`modules.json: ${id} has unknown authority ${a}`)
      }
      for (const g of m.match) this.rules.push({ id, re: globToRegExp(g), score: specificity(g) })
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
  get(id: string): ModuleDef {
    return this.def.modules[id]!
  }
}

function specificity(glob: string): number {
  const star = glob.indexOf('*')
  const prefix = star < 0 ? glob.length + 10_000 : star
  return prefix * 1000 + glob.replace(/\*/g, '').length
}

function findCycle(g: Record<string, string[]>): string[] | null {
  const state = new Map<string, number>()
  const stack: string[] = []
  const visit = (n: string): string[] | null => {
    state.set(n, 1)
    stack.push(n)
    for (const m of g[n] ?? []) {
      if (state.get(m) === 1) return [...stack.slice(stack.indexOf(m)), m]
      if (!state.get(m)) {
        const c = visit(m)
        if (c) return c
      }
    }
    stack.pop()
    state.set(n, 2)
    return null
  }
  for (const n of Object.keys(g))
    if (!state.get(n)) {
      const c = visit(n)
      if (c) return c
    }
  return null
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
): { file: string | null; pkg: Pkg | null } {
  if (spec.startsWith('.')) {
    const f = resolveFile(
      root,
      path.posix.normalize(path.posix.join(path.posix.dirname(from), spec)),
    )
    return { file: f, pkg: f ? pkgOf(pkgs, f) : null }
  }
  const p = pkgs.find((x) => spec === x.name || spec.startsWith(`${x.name}/`))
  if (!p) return { file: null, pkg: null }
  const sub = spec.slice(p.name.length + 1)
  // package.json `exports` first (the runtime resolves through it), then the src/ convention.
  const target = exportTarget(p.exports, sub ? `./${sub}` : '.')
  const viaExports = target ? resolveFile(root, path.posix.normalize(`${p.dir}/${target}`)) : null
  const f =
    viaExports ??
    (sub
      ? (resolveFile(root, `${p.dir}/src/${sub}`) ?? resolveFile(root, `${p.dir}/${sub}`))
      : resolveFile(root, `${p.dir}/src/index`))
  return { file: f, pkg: p }
}
/** The file an `exports` entry points at for this subpath (types, then default; wildcards one level). */
function exportTarget(exp: unknown, sub: string): string | null {
  if (!exp) return null
  if (typeof exp === 'string') return sub === '.' ? exp : null
  if (typeof exp !== 'object') return null
  const map = exp as Record<string, unknown>
  const pick = (v: unknown): string | null => {
    if (typeof v === 'string') return v
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      return pick(o.types ?? o.default ?? o.import ?? o.require ?? null)
    }
    return null
  }
  if (!Object.keys(map).some((k) => k.startsWith('.'))) return sub === '.' ? pick(map) : null
  if (sub in map) return pick(map[sub])
  for (const [k, v] of Object.entries(map)) {
    const star = k.indexOf('*')
    if (star < 0) continue
    const pre = k.slice(0, star)
    const post = k.slice(star + 1)
    if (sub.startsWith(pre) && sub.endsWith(post)) {
      const t = pick(v)
      if (t) return t.replace('*', sub.slice(pre.length, sub.length - post.length))
    }
  }
  return null
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
  // local name → imported name, so `import { createHmac as h }` and `const { requireAuth: ra } = x`
  // are still recognised at the call site.
  const alias = new Map<string, string>()
  const collect = (n: ts.Node): void => {
    if (ts.isImportSpecifier(n)) alias.set(n.name.text, (n.propertyName ?? n.name).text)
    else if (
      ts.isBindingElement(n) &&
      ts.isIdentifier(n.name) &&
      n.propertyName &&
      ts.isIdentifier(n.propertyName)
    )
      alias.set(n.name.text, n.propertyName.text)
    else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const init = n.initializer
      if (ts.isIdentifier(init)) alias.set(n.name.text, alias.get(init.text) ?? init.text)
      else if (ts.isPropertyAccessExpression(init)) alias.set(n.name.text, init.name.text)
    }
    ts.forEachChild(n, collect)
  }
  collect(sf)
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
      const name = ts.isIdentifier(callee)
        ? (alias.get(callee.text) ?? callee.text)
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : ''
      if (
        name === 'fetch' &&
        (ts.isIdentifier(callee) ||
          (ts.isPropertyAccessExpression(callee) &&
            ts.isIdentifier(callee.expression) &&
            ['globalThis', 'window', 'self'].includes(callee.expression.text)))
      )
        f.net++
      if (CRYPTO_FNS.has(name)) f.crypto++
      if (AUTH_FNS.has(name)) f.handlerAuth++
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
): { violations: Violation[]; files: number; edges: number } {
  const pkgs = packages(root)
  const files = productionFiles(root)
  const out: Violation[] = []
  let edges = 0
  const v = (rule: string, file: string, target = '-') => out.push({ rule, file, target })
  for (const file of files) {
    const mod = map.moduleOf(file)
    if (!mod) {
      v('R1-unmapped', file)
      continue
    }
    const amb = map.ambiguous(file)
    if (amb.length) fail(`modules.json maps ${file} to ${amb.join(' and ')} with equal specificity`)
    const me = map.get(mod)
    let facts: FileFacts
    try {
      facts = factsOf(file, readFileSync(path.join(root, file), 'utf8'))
    } catch (e) {
      fail(`cannot parse ${(e as Error).message}`)
    }
    const myPkg = pkgOf(pkgs, file)
    for (const imp of facts.imports) {
      if (imp.spec.startsWith('node:') && me.layer === 'L0' && !imp.type)
        v('R2-contract-node', file, imp.spec)
      if (imp.type) continue
      const r = resolveSpec(root, pkgs, file, imp.spec)
      if (!r.pkg) continue // external package
      if (!r.file) {
        v('R2-unresolved-internal', file, imp.spec) // an internal import the checker cannot follow is not "no violation"
        continue
      }
      if (imp.spec.startsWith('.') && r.pkg !== myPkg) v('R2-cross-package-internal', file, r.file)
      if (
        /\.(ts|tsx|mts)$/.test(r.file) &&
        !/\.d\.ts$/.test(r.file) &&
        !isProductionSource(r.file)
      ) {
        v('R2-imports-test-code', file, r.file) // production code must not import test helpers (§3.1)
        continue
      }
      const tm = map.moduleOf(r.file)
      if (!tm || tm === mod) continue
      edges++
      const t = map.get(tm)
      const front = me.layer.startsWith('F')
      if (front !== t.layer.startsWith('F') && !(front && t.layer === 'L0'))
        v('R2-front-back', file, tm)
      else if (LAYER_RANK[t.layer]! > LAYER_RANK[me.layer]!) v('R2-upward', file, tm)
      else if (t.layer === me.layer && !(me.allow ?? []).includes(tm)) v('R2-same-layer', file, tm)
      const ms = me.scope ?? []
      const tsc = t.scope ?? []
      if (ms.length > 1 && tsc.length && !ms.every((s) => tsc.includes(s))) v('R2-scope', file, tm)
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
  return { violations: out, files: files.length, edges }
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
  const txt = execFileSync(
    'git',
    ['diff', '-M', '--name-status', '--diff-filter=R', `${base}...HEAD`],
    { cwd: root, encoding: 'utf8' },
  )
  for (const l of txt.split('\n')) {
    const [st, from, to] = l.split('\t')
    if (st?.startsWith('R') && from && to) out.set(from, to)
  }
  return out
}

export function compare(
  baseline: Record<string, number>,
  current: Record<string, number>,
  renames = new Map<string, string>(),
) {
  const moved: Record<string, number> = {}
  for (const [k, n] of Object.entries(baseline)) {
    const [rule, file, target] = k.split('|')
    const nk = `${rule}|${renames.get(file!) ?? file}|${renames.get(target!) ?? target}`
    moved[nk] = (moved[nk] ?? 0) + n
  }
  const grown: { key: string; baseline: number; now: number }[] = []
  const stale: { key: string; baseline: number; now: number }[] = []
  for (const [k, n] of Object.entries(current))
    if (n > (moved[k] ?? 0)) grown.push({ key: k, baseline: moved[k] ?? 0, now: n })
  for (const [k, n] of Object.entries(moved))
    if ((current[k] ?? 0) < n) stale.push({ key: k, baseline: n, now: current[k] ?? 0 })
  return { grown, stale }
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
  if (argv.includes('--write-baseline')) {
    writeFileSync(
      bf,
      `${JSON.stringify({ schema: 1, note: 'rule|file|target → count; may only shrink (plan §5.3)', entries: current }, null, 1)}\n`,
    )
    console.log(
      `[architecture] wrote baseline: ${Object.keys(current).length} identities, ${res.violations.length} violations`,
    )
    return
  }
  if (!existsSync(bf)) fail(`missing ${bf}`)
  const baseline = JSON.parse(readFileSync(bf, 'utf8'))
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
  const { grown, stale } = compare(
    baseline.entries,
    current,
    base ? renamesSince(root, base) : undefined,
  )
  const byRule: Record<string, number> = {}
  for (const x of res.violations) byRule[x.rule] = (byRule[x.rule] ?? 0) + 1
  const unmapped = res.violations.filter((x) => x.rule === 'R1-unmapped').length
  const seconds = (Date.now() - t0) / 1000
  const report = {
    mode: enforce ? 'enforce' : 'report',
    files: res.files,
    edges: res.edges,
    seconds,
    unmapped,
    byRule,
    identities: Object.keys(current).length,
    grown,
    stale,
  }
  const jout = opt('--json')
  if (jout) writeFileSync(jout, `${JSON.stringify(report, null, 1)}\n`)
  console.log(
    `[architecture] ${report.mode}: ${res.files} files, ${res.edges} cross-module value edges, ${seconds.toFixed(1)} s`,
  )
  console.log(
    `[architecture] violations by rule: ${
      Object.entries(byRule)
        .map(([r, n]) => `${r}=${n}`)
        .join(' ') || 'none'
    }`,
  )
  for (const g of grown.slice(0, 50)) console.log(`  NEW/GROWN ${g.key} ${g.baseline} → ${g.now}`)
  if (grown.length > 50) console.log(`  … ${grown.length - 50} more new/grown`)
  for (const s of stale.slice(0, 50))
    console.log(`  STALE     ${s.key} ${s.baseline} → ${s.now} (remove from the baseline)`)
  if (stale.length > 50) console.log(`  … ${stale.length - 50} more stale`)
  console.log(`[architecture] new/grown=${grown.length} stale=${stale.length} unmapped=${unmapped}`)
  if (enforce && (grown.length || stale.length)) process.exit(1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
