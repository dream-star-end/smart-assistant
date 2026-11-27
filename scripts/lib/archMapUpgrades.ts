/**
 * Architecture Map Upgrades (OCV5-905):
 *   - Tarjan SCC file-level circular dependency detection (`R2-file-cycle`) reusing
 *     `scripts/arch-measure/lib.mjs`, with canonical SHA-256 cycle keys and subset-aware
 *     monotonic baseline comparison (`arch/file-cycles-baseline.json`).
 *   - Intramodule subdomain boundary compilation & checking (`R2-intramodule-boundary`) for
 *     modules declaring `subdomains` in `arch/modules.json`, plus fine-grained frontend F4
 *     boundary ratchet (`arch/subdomain-violations-baseline.json`).
 *   - Gate remediation messages & auxiliary baseline fail-closed I/O.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { scc } from '../arch-measure/lib.mjs'

export const FILE_CYCLES_BASELINE_REL = 'arch/file-cycles-baseline.json'
export const SUBDOMAIN_BASELINE_REL = 'arch/subdomain-violations-baseline.json'

export interface SubdomainDef {
  /** Relative rank inside the module (0 = lowest/foundation, higher = orchestration). Defaults to 0. */
  rank?: number
  /** Glob patterns matching files inside the parent module. Most specific match wins; ties fail closed. */
  match: string[]
  /** Same-rank target subdomains explicitly allowed (must form a DAG). */
  allow?: string[]
  /** Explicitly forbidden target subdomains (even if target has lower rank). */
  deny?: string[]
  note?: string
}

export interface CompiledSubdomainRule {
  id: string
  re: RegExp
  score: number
}

export interface FileCycle {
  fingerprint: string
  files: string[]
  key: string
  size: number
}

export interface BaselineDelta {
  key: string
  baseline: number
  now: number
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
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

export function specificity(glob: string): number {
  const star = glob.indexOf('*')
  const prefix = star < 0 ? glob.length + 10_000 : star
  return prefix * 1000 + glob.replace(/\*/g, '').length
}

export function findCycle(g: Record<string, string[]>): string[] | null {
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

export function fileCycleKey(files: readonly string[]): {
  fingerprint: string
  files: string[]
  key: string
  size: number
} {
  const sorted = [...files].sort()
  const fingerprint = sha256Hex(sorted.join('\n')).slice(0, 12)
  return {
    fingerprint,
    files: sorted,
    key: `R2-file-cycle|scc:${fingerprint}|${sorted.join(',')}`,
    size: sorted.length,
  }
}

/**
 * Find all non-trivial strongly connected components (size >= 2) in the production file-level
 * value-import graph using the iterative Tarjan SCC implementation from `arch-measure/lib.mjs`.
 */
export function findFileCycles(graph: Map<string, Set<string>>): FileCycle[] {
  const rawComps = scc(graph) as string[][]
  return rawComps
    .filter((comp) => comp.length >= 2)
    .map((comp) => fileCycleKey(comp))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

export function tallyFileCycles(cycles: readonly FileCycle[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const c of cycles) out[c.key] = c.size
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

export function parseFileCycleMembers(key: string): string[] | null {
  const parts = key.split('|')
  if (parts.length !== 3 || parts[0] !== 'R2-file-cycle') return null
  if (!/^scc:[0-9a-f]{12}$/.test(parts[1]!)) return null
  const members = parts[2]!.split(',').filter(Boolean)
  if (members.length < 2) return null
  return members
}

/** Rewrite file-cycle baseline keys through 1-to-1 git renames, recomputing canonical fingerprints. */
export function carryFileCycles(
  entries: Record<string, number>,
  renames = new Map<string, string>(),
): Record<string, number> {
  if (!renames.size) return { ...entries }
  const moved: Record<string, number> = {}
  for (const [k, n] of Object.entries(entries)) {
    const members = parseFileCycleMembers(k)
    if (!members) {
      moved[k] = n
      continue
    }
    const rewritten = fileCycleKey(members.map((f) => renames.get(f) ?? f))
    moved[rewritten.key] = Math.max(moved[rewritten.key] ?? 0, n)
  }
  return moved
}

export function compareFileCycles(
  baseline: Record<string, number>,
  current: Record<string, number>,
  renames = new Map<string, string>(),
): { grown: BaselineDelta[]; stale: BaselineDelta[] } {
  const moved = carryFileCycles(baseline, renames)
  const grown: BaselineDelta[] = []
  const stale: BaselineDelta[] = []
  for (const [k, n] of Object.entries(current)) {
    if (n > (moved[k] ?? 0)) grown.push({ key: k, baseline: moved[k] ?? 0, now: n })
  }
  for (const [k, n] of Object.entries(moved)) {
    if ((current[k] ?? 0) < n) stale.push({ key: k, baseline: n, now: current[k] ?? 0 })
  }
  return { grown, stale }
}

/**
 * Monotonic comparison of `arch/file-cycles-baseline.json` against `<base>`.
 * Allows deleting cycles and shrinking an existing SCC to a strict subset (e.g. splitting a 31-file
 * SCC into smaller strictly-contained subsets without adding any new member). Any newly introduced
 * cycle or added member is reported as `grown`.
 */
export function compareFileCyclesBaseline(
  baseEntries: Record<string, number>,
  headEntries: Record<string, number>,
  renames = new Map<string, string>(),
): { grown: BaselineDelta[] } {
  const moved = carryFileCycles(baseEntries, renames)
  const baseCycles = Object.entries(moved).map(([key, size]) => ({
    key,
    size,
    members: new Set(parseFileCycleMembers(key) ?? []),
    claimed: new Set<string>(),
  }))
  const grown: BaselineDelta[] = []

  for (const [hk, hn] of Object.entries(headEntries)) {
    const exact = moved[hk]
    if (exact !== undefined && hn <= exact) continue
    const headMembers = parseFileCycleMembers(hk)
    if (!headMembers) {
      grown.push({ key: hk, baseline: exact ?? 0, now: hn })
      continue
    }
    const parent = baseCycles.find(
      (bc) => hn < bc.size && headMembers.every((m) => bc.members.has(m) && !bc.claimed.has(m)),
    )
    if (parent) {
      for (const m of headMembers) parent.claimed.add(m)
      continue
    }
    grown.push({ key: hk, baseline: exact ?? 0, now: hn })
  }
  return { grown }
}

export function validateAndCompileSubdomains(
  modId: string,
  subdomains: Record<string, SubdomainDef>,
): CompiledSubdomainRule[] {
  if (typeof subdomains !== 'object' || subdomains === null || Array.isArray(subdomains)) {
    throw new Error(`modules.json: ${modId}.subdomains must be a non-empty object`)
  }
  const entries = Object.entries(subdomains)
  if (!entries.length) {
    throw new Error(`modules.json: ${modId}.subdomains must define at least one subdomain`)
  }
  const rules: CompiledSubdomainRule[] = []
  for (const [subId, def] of entries) {
    if (!def || typeof def !== 'object') {
      throw new Error(`modules.json: ${modId}.subdomains.${subId} must be an object`)
    }
    if (def.rank !== undefined && (!Number.isInteger(def.rank) || def.rank < 0)) {
      throw new Error(
        `modules.json: ${modId}.subdomains.${subId} rank must be a non-negative integer`,
      )
    }
    if (!Array.isArray(def.match) || !def.match.length) {
      throw new Error(`modules.json: ${modId}.subdomains.${subId} has no match globs`)
    }
    for (const a of def.allow ?? []) {
      if (!(a in subdomains))
        throw new Error(`modules.json: ${modId}.subdomains.${subId} allows unknown subdomain ${a}`)
      if (a === subId)
        throw new Error(`modules.json: ${modId}.subdomains.${subId} must not allow itself`)
    }
    for (const d of def.deny ?? []) {
      if (!(d in subdomains))
        throw new Error(`modules.json: ${modId}.subdomains.${subId} denies unknown subdomain ${d}`)
      if (d === subId)
        throw new Error(`modules.json: ${modId}.subdomains.${subId} must not deny itself`)
    }
    for (const g of def.match) {
      rules.push({ id: subId, re: globToRegExp(g), score: specificity(g) })
    }
  }
  const sameRankGraph = Object.fromEntries(
    entries.map(([subId, def]) => {
      const rank = def.rank ?? 0
      return [subId, (def.allow ?? []).filter((a) => (subdomains[a]!.rank ?? 0) === rank)]
    }),
  )
  const cyc = findCycle(sameRankGraph)
  if (cyc) {
    throw new Error(
      `modules.json: ${modId} subdomains same-rank allow edges form a cycle: ${cyc.join(' → ')}`,
    )
  }
  return rules
}

export function matchSubdomain(
  rules: readonly CompiledSubdomainRule[],
  file: string,
): string | null {
  let best: { id: string; score: number } | null = null
  for (const r of rules) {
    if (!r.re.test(file)) continue
    if (!best || r.score > best.score) best = { id: r.id, score: r.score }
  }
  return best?.id ?? null
}

export function ambiguousSubdomainMatch(
  rules: readonly CompiledSubdomainRule[],
  file: string,
): string[] {
  const hits = rules.filter((r) => r.re.test(file))
  if (hits.length < 2) return []
  const top = Math.max(...hits.map((r) => r.score))
  const ids = [...new Set(hits.filter((r) => r.score === top).map((r) => r.id))]
  return ids.length > 1 ? ids : []
}

/**
 * Evaluate an intramodule value-import edge `fromSub -> toSub`.
 * Returns the violation target string (`<modId>:<fromSub>-><toSub>`) when disallowed, or null.
 */
export function checkIntramoduleEdge(
  modId: string,
  subdomains: Record<string, SubdomainDef>,
  fromSub: string,
  toSub: string,
): string | null {
  if (fromSub === toSub) return null
  const fs = subdomains[fromSub]
  const ts = subdomains[toSub]
  if (!fs || !ts) return null
  const target = `${modId}:${fromSub}->${toSub}`
  if ((fs.deny ?? []).includes(toSub)) return target
  const fr = fs.rank ?? 0
  const tr = ts.rank ?? 0
  if (tr > fr) return target
  if (tr === fr && !(fs.allow ?? []).includes(toSub)) return target
  return null
}

export function validateAuxBaselineEntries(
  raw: unknown,
  kind: 'file-cycles' | 'subdomain',
  label: string,
): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`invalid ${label}: expected JSON object`)
  }
  const obj = raw as { schema?: unknown; entries?: unknown }
  if (
    obj.schema !== 1 ||
    !obj.entries ||
    typeof obj.entries !== 'object' ||
    Array.isArray(obj.entries)
  ) {
    throw new Error(`invalid ${label}: expected { schema: 1, entries: { ... } }`)
  }
  const entries = obj.entries as Record<string, unknown>
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(entries)) {
    if (kind === 'subdomain') {
      if (!/^R\d-[a-z-]+\|[^|]+\|[^|]+$/.test(k) || !Number.isInteger(v) || (v as number) < 1) {
        throw new Error(`invalid ${label} entry ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
      }
      out[k] = v as number
    } else {
      const members = parseFileCycleMembers(k)
      if (!members || !Number.isInteger(v) || (v as number) !== members.length) {
        throw new Error(`invalid ${label} entry ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
      }
      const expected = fileCycleKey(members)
      if (expected.key !== k) {
        throw new Error(
          `invalid ${label} entry ${JSON.stringify(k)}: canonical key mismatch (expected ${expected.key})`,
        )
      }
      out[k] = v as number
    }
  }
  return out
}

export function gitShowFileAt(
  root: string,
  rev: string,
  relPath: string,
  fail: (msg: string) => never,
): string | null {
  const r = spawnSync('git', ['show', `${rev}:${relPath}`], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  })
  if (r.status !== 0) {
    if (/does not exist in|exists on disk, but not in/.test(r.stderr)) return null
    fail(`git show ${rev}:${relPath}: ${r.stderr.trim().split('\n')[0]}`)
  }
  return r.stdout
}

export function loadOptionalAuxBaseline(
  root: string,
  relPath: string,
  kind: 'file-cycles' | 'subdomain',
  base: string | undefined,
  fail: (msg: string) => never,
): {
  entries: Record<string, number>
  baseEntries: Record<string, number> | null
  exists: boolean
} {
  const abs = path.join(root, relPath)
  const exists = existsSync(abs)
  let baseEntries: Record<string, number> | null = null
  if (base) {
    const baseRaw = gitShowFileAt(root, base, relPath, fail)
    if (baseRaw !== null) {
      try {
        baseEntries = validateAuxBaselineEntries(JSON.parse(baseRaw), kind, `${base}:${relPath}`)
      } catch (e) {
        fail((e as Error).message)
      }
    }
  }
  if (!exists) {
    if (baseEntries !== null)
      fail(`missing ${relPath} (existed at ${base}; baselines cannot be deleted)`)
    return { entries: {}, baseEntries: null, exists: false }
  }
  try {
    const entries = validateAuxBaselineEntries(JSON.parse(readFileSync(abs, 'utf8')), kind, relPath)
    return { entries, baseEntries, exists: true }
  } catch (e) {
    fail((e as Error).message)
  }
}

export function writeAuxBaselineFile(
  absPath: string,
  note: string,
  entries: Record<string, number>,
): void {
  mkdirSync(path.dirname(absPath), { recursive: true })
  writeFileSync(absPath, `${JSON.stringify({ schema: 1, note, entries }, null, 1)}\n`)
}

export function writeRequestedBaselines(opts: {
  root: string
  bf: string
  argv: readonly string[]
  current: Record<string, number>
  currentSubdomains: Record<string, number>
  currentFileCycles: Record<string, number>
  mainCount: number
  subCount: number
}): boolean {
  const writeAll = opts.argv.includes('--write-all-baselines')
  const writeMain = writeAll || opts.argv.includes('--write-baseline')
  const writeCycles = writeAll || opts.argv.includes('--write-file-cycles-baseline')
  const writeSub = writeAll || opts.argv.includes('--write-subdomain-baseline')
  if (!writeMain && !writeCycles && !writeSub) return false
  if (writeMain) {
    writeAuxBaselineFile(
      opts.bf,
      'rule|file|target → count; may only shrink (plan §5.3)',
      opts.current,
    )
    console.log(
      `[architecture] wrote baseline: ${Object.keys(opts.current).length} identities, ${opts.mainCount} violations`,
    )
  }
  if (writeCycles) {
    writeAuxBaselineFile(
      path.join(opts.root, FILE_CYCLES_BASELINE_REL),
      'File-level value-import SCCs (size >= 2); R2-file-cycle|scc:<sha256-12>|<sorted files> → member count; monotonically non-increasing (OCV5-905)',
      opts.currentFileCycles,
    )
    console.log(
      `[architecture] wrote ${FILE_CYCLES_BASELINE_REL}: ${Object.keys(opts.currentFileCycles).length} cycles`,
    )
  }
  if (writeSub) {
    writeAuxBaselineFile(
      path.join(opts.root, SUBDOMAIN_BASELINE_REL),
      'Intramodule subdomain & refined frontend domain boundary violations; rule|file|target → count; monotonically non-increasing (OCV5-905)',
      opts.currentSubdomains,
    )
    console.log(
      `[architecture] wrote ${SUBDOMAIN_BASELINE_REL}: ${Object.keys(opts.currentSubdomains).length} identities, ${opts.subCount} violations`,
    )
  }
  return true
}

export function evaluateAuxBaselines(opts: {
  root: string
  base: string | undefined
  renames: Map<string, string> | undefined
  currentFileCycles: Record<string, number>
  currentSubdomains: Record<string, number>
  compareEntries: (
    base: Record<string, number>,
    cur: Record<string, number>,
    renames?: Map<string, string>,
  ) => { grown: BaselineDelta[]; stale: BaselineDelta[] }
  carryEntries: (
    entries: Record<string, number>,
    renames?: Map<string, string>,
  ) => Record<string, number>
  fail: (msg: string) => never
}) {
  const cyclesBase = loadOptionalAuxBaseline(
    opts.root,
    FILE_CYCLES_BASELINE_REL,
    'file-cycles',
    opts.base,
    opts.fail,
  )
  const { grown: fileCycleGrown, stale: fileCycleStale } = compareFileCycles(
    cyclesBase.entries,
    opts.currentFileCycles,
    opts.renames,
  )
  const fileCycleBaselineGrown =
    cyclesBase.baseEntries !== null
      ? compareFileCyclesBaseline(
          cyclesBase.baseEntries,
          carryFileCycles(cyclesBase.entries, opts.renames),
          opts.renames,
        ).grown
      : []

  const subBase = loadOptionalAuxBaseline(
    opts.root,
    SUBDOMAIN_BASELINE_REL,
    'subdomain',
    opts.base,
    opts.fail,
  )
  const { grown: subdomainGrown, stale: subdomainStale } = opts.compareEntries(
    subBase.entries,
    opts.currentSubdomains,
    opts.renames,
  )
  const subdomainBaselineGrown =
    subBase.baseEntries !== null
      ? opts.compareEntries(
          subBase.baseEntries,
          opts.carryEntries(subBase.entries, opts.renames),
          opts.renames,
        ).grown
      : []

  return {
    fileCycleGrown,
    fileCycleStale,
    fileCycleBaselineGrown,
    subdomainGrown,
    subdomainStale,
    subdomainBaselineGrown,
  }
}

export function emitArchitectureSummary(opts: {
  mode: 'enforce' | 'report'
  files: number
  edges: number
  intramoduleEdges: number
  fileCyclesCount: number
  seconds: number
  byRule: Record<string, number>
  allGrown: readonly BaselineDelta[]
  allStale: readonly BaselineDelta[]
  allBaselineGrown: readonly BaselineDelta[]
  unmapped: number
  rebaselineNotice: string | null
  baseIntroducedNotice: string | null
}): void {
  console.log(
    `[architecture] ${opts.mode}: ${opts.files} files, ${opts.edges} cross-module + ${opts.intramoduleEdges} intramodule value edges, ${opts.fileCyclesCount} file cycles, ${opts.seconds.toFixed(1)} s`,
  )
  console.log(
    `[architecture] violations by rule: ${
      Object.entries(opts.byRule)
        .map(([r, n]) => `${r}=${n}`)
        .join(' ') || 'none'
    }`,
  )
  for (const g of opts.allGrown.slice(0, 50))
    console.log(`  NEW/GROWN ${g.key} ${g.baseline} → ${g.now}`)
  if (opts.allGrown.length > 50) console.log(`  … ${opts.allGrown.length - 50} more new/grown`)
  for (const s of opts.allStale.slice(0, 50))
    console.log(`  STALE     ${s.key} ${s.baseline} → ${s.now} (remove from the baseline)`)
  if (opts.allStale.length > 50) console.log(`  … ${opts.allStale.length - 50} more stale`)
  for (const g of opts.allBaselineGrown)
    console.log(`  BASELINE-GROWN ${g.key} ${g.baseline} → ${g.now} (the baseline may only shrink)`)
  for (const line of formatGateRemediation(opts.allGrown, 'NEW/GROWN')) console.log(line)
  for (const line of formatGateRemediation(opts.allBaselineGrown, 'BASELINE-GROWN'))
    console.log(line)
  if (opts.rebaselineNotice) console.log(opts.rebaselineNotice)
  if (opts.baseIntroducedNotice) console.log(opts.baseIntroducedNotice)
  console.log(
    `[architecture] new/grown=${opts.allGrown.length} stale=${opts.allStale.length} baseline-grown=${opts.allBaselineGrown.length} unmapped=${opts.unmapped}`,
  )
}

export const RULE_REMEDIATION: Record<string, { why: string; fix: string }> = {
  'R1-unmapped': {
    why: 'Every production source file must belong to a declared layer/module in arch/modules.json.',
    fix: 'Move the file into an existing domain directory or register its glob in arch/modules.json (CODEOWNERS-protected).',
  },
  'R2-upward': {
    why: 'Value imports must only flow downward across layers (L6→L0 backend, F5→F0 frontend).',
    fix: 'Use `import type` if only types are needed, move shared contracts to a lower layer (e.g. @openclaude/protocol L0 or web-primitives F0 / web-lib F1), or invert control via DI.',
  },
  'R2-same-layer': {
    why: 'Same-layer modules may only import along the registered acyclic DAG (`allow` in arch/modules.json).',
    fix: 'Use `import type`, extract shared primitives to a lower layer (F0/F1/F2), or orchestrate cross-domain calls from an upper composition layer (L4/L5/L6 or F5).',
  },
  'R2-file-cycle': {
    why: 'File-level circular value imports create initialization-order hazards, tight coupling, and bundle/runtime fragility.',
    fix: 'Break the cycle by extracting shared types/contracts to a lower-layer file, converting type-only edges to `import type`, or injecting callbacks/dependencies from a caller.',
  },
  'R2-intramodule-boundary': {
    why: 'Large modules enforce internal subdomain boundaries (`subdomains` in arch/modules.json) to stop god-module tangling.',
    fix: 'Keep lower-rank foundation subdomains free of imports from higher-rank orchestrators and avoid unlisted cross-subdomain edges; extract shared types/helpers to a rank-0 subdomain or use `import type`.',
  },
  'R2-cross-package-internal': {
    why: 'Relative imports across package boundaries bypass package.json `exports` and break container/bundle isolation.',
    fix: 'Import from the public package entrypoint (`@openclaude/<pkg>` or its declared `exports` subpath) instead of relative `../../*/src/` paths.',
  },
  'R2-contract-node': {
    why: 'L0 contract modules (@openclaude/protocol) must stay runtime-agnostic with zero value imports of `node:*`.',
    fix: 'Remove runtime `node:*` imports from L0 contracts; use pure JS/Web APIs, `import type`, or move Node logic to L1/L2 (@openclaude/kernel / storage / gateway).',
  },
  'R3-billing-sql': {
    why: 'Mutations to billing/ledger/credit/order tables belong strictly to single-authority `billing` / `payment` modules.',
    fix: 'Delegate all writes to credit_ledger, usage_records, orders, or users.credits through billing/payment service APIs instead of raw SQL DML.',
  },
  'R3-env': {
    why: 'Direct `process.env` reads outside `platform-config` cause config drift and hidden runtime coupling.',
    fix: 'Declare and parse the variable in `packages/commercial/src/config.ts` (platform-config) or accept it via injected config/deps.',
  },
  'R3-net': {
    why: 'Direct `fetch`/`undici`/`node:http(s)` calls outside registered `net` authorities bypass egress, timeout, and observability controls.',
    fix: 'Route outbound requests through a registered `net` adapter module (e.g. `adapters-providers`, `web-lib` API client) or inject `fetchImpl`.',
  },
  'R3-handler-auth': {
    why: 'Handler-level auth guards (`requireAuth`, `requireAdmin`, `verifyContainerIdentity`) belong strictly in L5 HTTP boundary modules.',
    fix: 'Authenticate requests in the HTTP boundary (`interface-http` / `gateway-interface`) and pass the verified principal/identity into lower layers.',
  },
  'R3-crypto': {
    why: 'Cryptographic primitives must be centralized in `platform-auth-crypto` to guarantee safe algorithms and key hygiene.',
    fix: 'Reuse helpers from `packages/commercial/src/crypto/**` or `platform-auth-crypto` instead of calling low-level `node:crypto` APIs directly.',
  },
  'R3-special-case': {
    why: 'Provider/engine name branching outside adapter boundaries leaks upstream quirks across the codebase.',
    fix: 'Encapsulate provider/engine-specific behavior behind capabilities/adapters in `adapters-providers` or `gateway-engines`.',
  },
  'R2-scope': {
    why: 'A multi-process shared module must not depend on a module with narrower process scope.',
    fix: 'Move the dependency to a shared-scope module or pass process-specific behavior in via dependency injection.',
  },
  'R2-front-back': {
    why: 'Frontend (F0-F5) and backend (L1-L6) must stay isolated; frontend may only import L0 contracts.',
    fix: 'Share types/schemas through `@openclaude/protocol` (L0) instead of importing backend implementation modules.',
  },
}

export function formatGateRemediation(
  items: ReadonlyArray<BaselineDelta>,
  kind: 'NEW/GROWN' | 'BASELINE-GROWN',
): string[] {
  const byRule = new Map<string, { count: number; sample: string }>()
  for (const item of items) {
    const [rule, file, target] = item.key.split('|')
    if (!rule) continue
    const prev = byRule.get(rule)
    const sample = target && target !== '-' ? `${file} -> ${target}` : (file ?? item.key)
    if (!prev) byRule.set(rule, { count: 1, sample })
    else prev.count++
  }
  const lines: string[] = []
  for (const [rule, info] of byRule) {
    const guide = RULE_REMEDIATION[rule]
    if (!guide) continue
    lines.push(
      `[GATE-ERROR] ${rule} (${kind}, ${info.count} identit${info.count === 1 ? 'y' : 'ies'}, e.g. ${info.sample})`,
      `  Why       : ${guide.why}`,
      `  How to Fix: ${guide.fix}`,
      '  Re-verify : npx tsx scripts/check-architecture.ts --enforce',
    )
  }
  return lines
}
