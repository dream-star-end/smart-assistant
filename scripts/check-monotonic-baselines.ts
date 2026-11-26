/**
 * Cross-Baseline Monotonic Anti-Tamper Gate (Governance Blueprint §4.2 ⑤ Defense 2, OCV5-903).
 *
 * Compares working-tree governance baseline/budget/registry files against `<base>:<path>`
 * (default `--base origin/feat/v5-selfhost`). Initial introduction validates schema and PASSES;
 * once present at `<base>`, enforces strict monotonicity (shrink/tighten-only):
 *   - `packages/web-react/budgets.json`, `design-tokens-counts.json`, `ui-static-baseline.json`,
 *     `layout-invariants-baseline.json`, `deploy/v5/feature-flags-registry.json`
 *   - `arch/ai-smells-baseline.json`, `arch/file-cycles-baseline.json`,
 *     `arch/subdomain-violations-baseline.json`, `arch/complexity-baseline.json`,
 *     `arch/clones-baseline.json`, `arch/security-sast-baseline.json`
 *
 * Usage: npx tsx scripts/check-monotonic-baselines.ts [--root <repo>] [--base <git-ref>]
 * Exit: 0 ok, 1 monotonic/schema violation, 2 git/usage error (fail-closed).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import {
  AI_SMELLS_BASELINE_PATH,
  CLONES_BASELINE_PATH,
  COMPLEXITY_BASELINE_PATH,
  FILE_CYCLES_BASELINE_PATH,
  type MonotonicBaselineSpec,
  SECURITY_SAST_BASELINE_PATH,
  SUBDOMAIN_VIOLATIONS_BASELINE_PATH,
  buildExtraMonotonicSpecs,
  compareAiSmellsMonotonic,
  compareClonesMonotonic,
  compareComplexityMonotonic,
  compareFileCyclesMonotonic,
  compareSecuritySastMonotonic,
  compareSubdomainMonotonic,
} from './lib/monotonicExtraBaselines.js'

export {
  AI_SMELLS_BASELINE_PATH,
  CLONES_BASELINE_PATH,
  COMPLEXITY_BASELINE_PATH,
  FILE_CYCLES_BASELINE_PATH,
  SECURITY_SAST_BASELINE_PATH,
  SUBDOMAIN_VIOLATIONS_BASELINE_PATH,
  compareAiSmellsMonotonic,
  compareClonesMonotonic,
  compareComplexityMonotonic,
  compareFileCyclesMonotonic,
  compareSecuritySastMonotonic,
  compareSubdomainMonotonic,
}

export const DEFAULT_BASE_REF = 'origin/feat/v5-selfhost'

export const BUDGETS_PATH = 'packages/web-react/budgets.json'
export const DESIGN_TOKENS_COUNTS_PATH = 'packages/web-react/design-tokens-counts.json'
export const UI_STATIC_BASELINE_PATH = 'packages/web-react/ui-static-baseline.json'
export const LAYOUT_INVARIANTS_BASELINE_PATH = 'packages/web-react/layout-invariants-baseline.json'
export const FEATURE_FLAGS_REGISTRY_PATH = 'deploy/v5/feature-flags-registry.json'

export interface MonotonicViolation {
  rule: string
  file: string
  key: string
  baseValue: string
  headValue: string
  detail: string
  howToFix: string
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function parseIsoDateMs(s: unknown): number {
  if (typeof s !== 'string' || !ISO_DATE_RE.test(s)) return Number.NaN
  const ms = Date.parse(`${s}T00:00:00Z`)
  if (!Number.isFinite(ms)) return Number.NaN
  return new Date(ms).toISOString().slice(0, 10) === s ? ms : Number.NaN
}

export function validateBudgetsSchema(raw: unknown, file = BUDGETS_PATH): MonotonicViolation[] {
  if (!isPlainObject(raw)) {
    return [{ rule: 'MONOTONIC-SCHEMA-INVALID', file, key: '<root>', baseValue: '-', headValue: typeof raw, detail: `${file} must be a JSON object mapping budget names to non-negative numbers`, howToFix: `Restore valid numeric budget entries in ${file}.` }]
  }
  const out: MonotonicViolation[] = []
  let numericKeys = 0
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'note' || k === 'schema') continue
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      out.push({ rule: 'MONOTONIC-SCHEMA-INVALID', file, key: k, baseValue: '-', headValue: JSON.stringify(v), detail: `budget ${k} must be a finite non-negative number`, howToFix: `Set ${k} to a valid non-negative number in ${file}.` })
    } else {
      numericKeys++
    }
  }
  if (numericKeys === 0) {
    out.push({ rule: 'MONOTONIC-SCHEMA-INVALID', file, key: '<root>', baseValue: '-', headValue: '{}', detail: `${file} must define at least one numeric budget`, howToFix: `Restore numeric budget definitions in ${file}.` })
  }
  return out
}

export function compareBudgets(
  baseRaw: unknown,
  headRaw: unknown,
  file = BUDGETS_PATH,
): MonotonicViolation[] {
  const schemaErrs = validateBudgetsSchema(headRaw, file)
  if (schemaErrs.length > 0) return schemaErrs
  if (!isPlainObject(baseRaw)) return []
  const head = headRaw as Record<string, unknown>
  const out: MonotonicViolation[] = []

  for (const [k, bv] of Object.entries(baseRaw)) {
    if (k === 'note' || k === 'schema') continue
    if (typeof bv !== 'number' || !Number.isFinite(bv)) continue
    const hv = head[k]
    if (typeof hv !== 'number' || !Number.isFinite(hv)) {
      out.push({
        rule: 'MONOTONIC-BUDGET-REMOVED',
        file,
        key: k,
        baseValue: String(bv),
        headValue: 'missing',
        detail: `budget key ${k} was removed (base=${bv})`,
        howToFix: `Keep ${k} <= ${bv} in ${file}; removing a budget cap weakens the gate.`,
      })
    } else if (hv > bv) {
      out.push({
        rule: 'MONOTONIC-BUDGET-RAISED',
        file,
        key: k,
        baseValue: String(bv),
        headValue: String(hv),
        detail: `budget ${k} increased from ${bv} to ${hv}`,
        howToFix: `Reduce bundle/CSS size to stay within ${bv}, or seek CODEOWNERS human approval if a budget raise is truly required.`,
      })
    }
  }
  return out
}

export function validateCountRatchetSchema(raw: unknown, file: string): MonotonicViolation[] {
  if (!isPlainObject(raw)) {
    return [
      {
        rule: 'MONOTONIC-SCHEMA-INVALID',
        file,
        key: '<root>',
        baseValue: '-',
        headValue: typeof raw,
        detail: `${file} must be a JSON object of non-negative integer counts`,
        howToFix: `Restore valid JSON structure in ${file}.`,
      },
    ]
  }
  const out: MonotonicViolation[] = []
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'note' || k === 'schema') continue
    if (typeof v === 'number') {
      if (!Number.isInteger(v) || v < 0) {
        out.push({
          rule: 'MONOTONIC-SCHEMA-INVALID',
          file,
          key: k,
          baseValue: '-',
          headValue: String(v),
          detail: `count ${k} must be a non-negative integer`,
          howToFix: `Fix invalid count for ${k} in ${file}.`,
        })
      }
    } else if (isPlainObject(v)) {
      for (const [subK, subV] of Object.entries(v)) {
        if (typeof subV !== 'number' || !Number.isInteger(subV) || subV < 0) {
          out.push({
            rule: 'MONOTONIC-SCHEMA-INVALID',
            file,
            key: `${k}.${subK}`,
            baseValue: '-',
            headValue: JSON.stringify(subV),
            detail: `count ${k}.${subK} must be a non-negative integer`,
            howToFix: `Fix invalid count for ${k}.${subK} in ${file}.`,
          })
        }
      }
    } else {
      out.push({
        rule: 'MONOTONIC-SCHEMA-INVALID',
        file,
        key: k,
        baseValue: '-',
        headValue: typeof v,
        detail: `entry ${k} must be an integer or nested map of integers`,
        howToFix: `Restore valid count map for ${k} in ${file}.`,
      })
    }
  }
  return out
}

function flattenCounts(obj: Record<string, unknown>): Map<string, number> {
  const out = new Map<string, number>()
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'note' || k === 'schema') continue
    if (typeof v === 'number') {
      out.set(k, v)
    } else if (isPlainObject(v)) {
      for (const [subK, subV] of Object.entries(v)) {
        if (typeof subV === 'number') out.set(`${k} > ${subK}`, subV)
      }
    }
  }
  return out
}

export function compareCountRatchet(
  baseRaw: unknown,
  headRaw: unknown,
  file: string,
): MonotonicViolation[] {
  const schemaErrs = validateCountRatchetSchema(headRaw, file)
  if (schemaErrs.length > 0) return schemaErrs
  if (!isPlainObject(baseRaw)) return []

  const baseCounts = flattenCounts(baseRaw)
  const headCounts = flattenCounts(headRaw as Record<string, unknown>)
  const out: MonotonicViolation[] = []

  for (const [key, headVal] of headCounts) {
    const baseVal = baseCounts.get(key)
    if (baseVal === undefined) {
      if (headVal > 0) {
        out.push({
          rule: 'MONOTONIC-COUNT-ADDED',
          file,
          key,
          baseValue: '0 (absent)',
          headValue: String(headVal),
          detail: `new baseline entry "${key}" added with count ${headVal}`,
          howToFix: `Fix the newly introduced violations in code instead of adding entries to ${file}.`,
        })
      }
    } else if (headVal > baseVal) {
      out.push({
        rule: 'MONOTONIC-COUNT-RAISED',
        file,
        key,
        baseValue: String(baseVal),
        headValue: String(headVal),
        detail: `baseline count for "${key}" increased from ${baseVal} to ${headVal}`,
        howToFix: `Eliminate the new violations so "${key}" stays <= ${baseVal}; baseline counts may only shrink.`,
      })
    }
  }
  return out
}

export function validateLayoutInvariantsBaselineSchema(
  raw: unknown,
  file = LAYOUT_INVARIANTS_BASELINE_PATH,
): MonotonicViolation[] {
  if (!isPlainObject(raw)) {
    return [
      {
        rule: 'MONOTONIC-SCHEMA-INVALID',
        file,
        key: '<root>',
        baseValue: '-',
        headValue: typeof raw,
        detail: `${file} must be a JSON object with schemaVersion=1 and counts map`,
        howToFix: `Restore valid JSON schema in ${file} via layout-invariants.mjs.`,
      },
    ]
  }

  const out: MonotonicViolation[] = []
  if (raw.schemaVersion !== 1) {
    out.push({
      rule: 'MONOTONIC-SCHEMA-INVALID',
      file,
      key: 'schemaVersion',
      baseValue: '-',
      headValue: JSON.stringify(raw.schemaVersion),
      detail: `${file} must have schemaVersion === 1`,
      howToFix: `Set schemaVersion to 1 in ${file}.`,
    })
  }

  for (const listField of ['scenes', 'viewports', 'themes'] as const) {
    const val = raw[listField]
    if (
      val !== undefined &&
      (!Array.isArray(val) || val.some((item) => typeof item !== 'string' || !item.trim()))
    ) {
      out.push({
        rule: 'MONOTONIC-SCHEMA-INVALID',
        file,
        key: listField,
        baseValue: '-',
        headValue: JSON.stringify(val),
        detail: `${listField} in ${file} must be an array of non-empty strings`,
        howToFix: `Restore valid string array for ${listField} in ${file}.`,
      })
    }
  }

  if (!isPlainObject(raw.counts)) {
    out.push({
      rule: 'MONOTONIC-SCHEMA-INVALID',
      file,
      key: 'counts',
      baseValue: '-',
      headValue: typeof raw.counts,
      detail: `${file} must contain a plain object "counts" mapping "scene|viewport|theme|ruleId" to non-negative integers`,
      howToFix: `Restore a valid "counts" object in ${file}.`,
    })
    return out
  }

  for (const [key, val] of Object.entries(raw.counts)) {
    const parts = key.split('|')
    if (parts.length !== 4 || parts.some((p) => p.trim().length === 0 || p !== p.trim())) {
      out.push({
        rule: 'MONOTONIC-SCHEMA-INVALID',
        file,
        key,
        baseValue: '-',
        headValue: JSON.stringify(val),
        detail: `invalid layout baseline key "${key}" (expected "scene|viewport|theme|ruleId")`,
        howToFix: `Use exact 4-segment "scene|viewport|theme|ruleId" keys in ${file}.`,
      })
      continue
    }
    if (typeof val !== 'number' || !Number.isSafeInteger(val) || val < 0) {
      out.push({
        rule: 'MONOTONIC-SCHEMA-INVALID',
        file,
        key,
        baseValue: '-',
        headValue: JSON.stringify(val),
        detail: `count for "${key}" must be a non-negative integer`,
        howToFix: `Set a valid non-negative integer count for "${key}" in ${file}.`,
      })
    }
  }
  return out
}

export function compareLayoutInvariantsBaseline(
  baseRaw: unknown,
  headRaw: unknown,
  file = LAYOUT_INVARIANTS_BASELINE_PATH,
): MonotonicViolation[] {
  const schemaErrs = validateLayoutInvariantsBaselineSchema(headRaw, file)
  if (schemaErrs.length > 0) return schemaErrs
  if (!isPlainObject(baseRaw) || !isPlainObject(baseRaw.counts)) return []

  const baseCounts = baseRaw.counts as Record<string, unknown>
  const headCounts = (headRaw as { counts: Record<string, number> }).counts
  const out: MonotonicViolation[] = []

  for (const [key, headVal] of Object.entries(headCounts)) {
    const baseVal = baseCounts[key]
    if (typeof baseVal !== 'number' || !Number.isSafeInteger(baseVal)) {
      out.push({
        rule: 'MONOTONIC-COUNT-ADDED',
        file,
        key,
        baseValue: 'absent',
        headValue: String(headVal),
        detail: `new layout baseline key "${key}" added with count ${headVal}`,
        howToFix: `Fix the newly introduced layout/a11y violation in code instead of adding keys to ${file}.`,
      })
    } else if (headVal > baseVal) {
      out.push({
        rule: 'MONOTONIC-COUNT-RAISED',
        file,
        key,
        baseValue: String(baseVal),
        headValue: String(headVal),
        detail: `layout baseline count for "${key}" increased from ${baseVal} to ${headVal}`,
        howToFix: `Eliminate the new layout/a11y violations so "${key}" stays <= ${baseVal}; baseline counts may only shrink.`,
      })
    }
  }
  return out
}

interface FlagRecord {
  name: string
  env?: string
  permanent: boolean
  expireAt: string | null
}

const FLAG_SCAN_SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'dist-types',
  'build',
  'generated',
  '__tests__',
  '__smoke__',
])

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function lineNumberAt(text: string, pos: number): number {
  let line = 1
  for (let i = 0; i < pos; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

/**
 * Scans production source under `packages/<pkg>/src` (excluding `__tests__`, `*.test.*`,
 * `*.spec.*`, `*.d.ts`, `dist*`, `generated`) using the TypeScript scanner so comments are
 * ignored while identifiers, string literals, and template literals are checked accurately.
 */
export function findFlagCodeReferences(
  root: string,
  tokens: readonly string[],
): Map<string, { file: string; line: number }> {
  const hits = new Map<string, { file: string; line: number }>()
  const uniqueTokens = [...new Set(tokens.filter((t) => t.trim().length > 0))]
  if (uniqueTokens.length === 0) return hits

  const pkgRoot = path.join(root, 'packages')
  if (!existsSync(pkgRoot)) return hits

  const tokenRegexes = new Map(uniqueTokens.map((t) => [t, new RegExp(`\\b${escapeRegex(t)}\\b`)]))
  const quickRe = new RegExp(`\\b(?:${uniqueTokens.map(escapeRegex).join('|')})\\b`)
  const files: string[] = []

  const walk = (rel: string) => {
    const abs = path.join(root, rel)
    if (!existsSync(abs)) return
    for (const ent of readdirSync(abs, { withFileTypes: true })) {
      if (FLAG_SCAN_SKIP_DIRS.has(ent.name)) continue
      const next = `${rel}/${ent.name}`
      if (ent.isDirectory()) walk(next)
      else if (
        ent.isFile() &&
        /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(ent.name) &&
        !/\.d\.ts$/.test(ent.name) &&
        !/\.(test|spec|integ\.test|node-test)\.[cm]?[jt]sx?$/.test(ent.name)
      ) {
        files.push(next)
      }
    }
  }

  for (const pkg of readdirSync(pkgRoot).sort()) {
    if (pkg === 'channels') {
      const chRoot = path.join(pkgRoot, 'channels')
      if (existsSync(chRoot)) {
        for (const ch of readdirSync(chRoot).sort()) walk(`packages/channels/${ch}/src`)
      }
    } else {
      walk(`packages/${pkg}/src`)
    }
  }

  for (const rel of files) {
    if (hits.size === uniqueTokens.length) break
    const text = readFileSync(path.join(root, rel), 'utf8')
    if (!quickRe.test(text)) continue
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.JSX, text)
    let kind = scanner.scan()
    while (kind !== ts.SyntaxKind.EndOfFileToken) {
      if (
        kind === ts.SyntaxKind.Identifier ||
        kind === ts.SyntaxKind.StringLiteral ||
        kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
        kind === ts.SyntaxKind.TemplateHead ||
        kind === ts.SyntaxKind.TemplateMiddle ||
        kind === ts.SyntaxKind.TemplateTail
      ) {
        const val = scanner.getTokenValue()
        for (const [token, re] of tokenRegexes) {
          if (hits.has(token)) continue
          if (val === token || re.test(val)) {
            hits.set(token, { file: rel, line: lineNumberAt(text, scanner.getTokenPos()) })
          }
        }
      }
      kind = scanner.scan()
    }
  }
  return hits
}

export function validateFeatureFlagsSchema(
  raw: unknown,
  file = FEATURE_FLAGS_REGISTRY_PATH,
): MonotonicViolation[] {
  if (!isPlainObject(raw) || raw.schema !== 1 || !Array.isArray(raw.flags)) {
    return [
      {
        rule: 'MONOTONIC-SCHEMA-INVALID',
        file,
        key: '<root>',
        baseValue: '-',
        headValue: isPlainObject(raw) ? `schema=${String(raw.schema)}` : typeof raw,
        detail: `${file} must be { schema: 1, flags: [...] }`,
        howToFix: `Fix schema of ${file} and verify with scripts/check-feature-flags-ttl.ts.`,
      },
    ]
  }
  const out: MonotonicViolation[] = []
  const seen = new Set<string>()
  for (const [idx, item] of raw.flags.entries()) {
    if (!isPlainObject(item) || typeof item.name !== 'string' || !item.name.trim()) {
      out.push({
        rule: 'MONOTONIC-SCHEMA-INVALID',
        file,
        key: `flags[${idx}]`,
        baseValue: '-',
        headValue: JSON.stringify(item),
        detail: `flags[${idx}] must be an object with non-empty string name`,
        howToFix: `Repair entry flags[${idx}] in ${file}.`,
      })
      continue
    }
    if (seen.has(item.name)) {
      out.push({
        rule: 'MONOTONIC-SCHEMA-INVALID',
        file,
        key: item.name,
        baseValue: '-',
        headValue: 'duplicate',
        detail: `duplicate flag ${item.name}`,
        howToFix: `Deduplicate ${item.name} in ${file}.`,
      })
      continue
    }
    seen.add(item.name)
    if (typeof item.permanent !== 'boolean') {
      out.push({
        rule: 'MONOTONIC-SCHEMA-INVALID',
        file,
        key: item.name,
        baseValue: '-',
        headValue: String(item.permanent),
        detail: `flag ${item.name} must have boolean permanent field`,
        howToFix: `Set permanent to true or false for ${item.name} in ${file}.`,
      })
    } else if (item.permanent === false && !Number.isFinite(parseIsoDateMs(item.expireAt))) {
      out.push({
        rule: 'MONOTONIC-SCHEMA-INVALID',
        file,
        key: item.name,
        baseValue: '-',
        headValue: String(item.expireAt),
        detail: `temporary flag ${item.name} must have valid YYYY-MM-DD expireAt`,
        howToFix: `Set a valid YYYY-MM-DD expireAt for ${item.name} in ${file}.`,
      })
    }
  }
  return out
}

function indexFlags(raw: unknown): Map<string, FlagRecord> {
  const map = new Map<string, FlagRecord>()
  if (!isPlainObject(raw) || !Array.isArray(raw.flags)) return map
  for (const item of raw.flags) {
    if (!isPlainObject(item) || typeof item.name !== 'string') continue
    map.set(item.name, {
      name: item.name,
      env: typeof item.env === 'string' && item.env.trim() ? item.env.trim() : undefined,
      permanent: Boolean(item.permanent),
      expireAt: typeof item.expireAt === 'string' ? item.expireAt : null,
    })
  }
  return map
}

export function compareFeatureFlagsRegistry(
  baseRaw: unknown,
  headRaw: unknown,
  file = FEATURE_FLAGS_REGISTRY_PATH,
  opts?: { root?: string },
): MonotonicViolation[] {
  const schemaErrs = validateFeatureFlagsSchema(headRaw, file)
  if (schemaErrs.length > 0) return schemaErrs

  const baseFlags = indexFlags(baseRaw)
  const headFlags = indexFlags(headRaw)
  const out: MonotonicViolation[] = []

  // Removed flags must have 0 remaining references in production source (`packages/*/src`).
  const removedFlags: FlagRecord[] = []
  for (const [name, baseFlag] of baseFlags) {
    if (!headFlags.has(name)) removedFlags.push(baseFlag)
  }
  if (removedFlags.length > 0 && opts?.root) {
    const tokens = removedFlags.flatMap((f) => (f.env && f.env !== f.name ? [f.name, f.env] : [f.name]))
    const refs = findFlagCodeReferences(opts.root, tokens)
    for (const flag of removedFlags) {
      const hit = refs.get(flag.name) ?? (flag.env ? refs.get(flag.env) : undefined)
      if (hit) {
        const matchedToken = refs.has(flag.name) ? flag.name : (flag.env ?? flag.name)
        out.push({
          rule: 'MONOTONIC-FLAG-STILL-REFERENCED',
          file,
          key: flag.name,
          baseValue: `registered (${flag.permanent ? 'permanent=true' : `expireAt=${flag.expireAt}`})`,
          headValue: `deleted while ${matchedToken} still referenced at ${hit.file}:${hit.line}`,
          detail: `flag ${flag.name} was removed from ${file}, but ${matchedToken} is still referenced in production code at ${hit.file}:${hit.line}`,
          howToFix: `Remove all production code references to ${matchedToken} (e.g. ${hit.file}:${hit.line}) before retiring ${flag.name} from ${file}.`,
        })
      }
    }
  }

  for (const [name, headFlag] of headFlags) {
    const baseFlag = baseFlags.get(name)
    if (!baseFlag) continue // Newly added flag — validated by schema above

    if (baseFlag.permanent === false && headFlag.permanent === true) {
      out.push({
        rule: 'MONOTONIC-FLAG-MADE-PERMANENT',
        file,
        key: name,
        baseValue: `permanent=false (expireAt=${baseFlag.expireAt})`,
        headValue: 'permanent=true',
        detail: `flag ${name} was flipped from temporary (permanent=false) to permanent=true`,
        howToFix: `Do not convert temporary rollout flag ${name} into permanent=true autonomously; clean up the flag or obtain explicit human approval.`,
      })
      continue
    }

    if (baseFlag.permanent === false && headFlag.permanent === false) {
      const baseMs = parseIsoDateMs(baseFlag.expireAt)
      const headMs = parseIsoDateMs(headFlag.expireAt)
      if (Number.isFinite(baseMs) && Number.isFinite(headMs) && headMs > baseMs) {
        out.push({
          rule: 'MONOTONIC-FLAG-TTL-EXTENDED',
          file,
          key: name,
          baseValue: String(baseFlag.expireAt),
          headValue: String(headFlag.expireAt),
          detail: `flag ${name} expireAt extended from ${baseFlag.expireAt} to ${headFlag.expireAt}`,
          howToFix: `Keep ${name}.expireAt <= ${baseFlag.expireAt}; remove the flag once stabilized instead of pushing out its TTL.`,
        })
      }
    }
  }

  return out
}

function readGitFileAt(root: string, ref: string, rel: string): string | null {
  const r = spawnSync('git', ['-C', root, 'show', `${ref}:${rel}`], {
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  })
  if (r.status !== 0) {
    if (/does not exist in|exists on disk, but not in/.test(r.stderr)) return null
    throw new Error(`git show ${ref}:${rel}: ${r.stderr.trim().split('\n')[0]}`)
  }
  return r.stdout
}

export interface CheckedFileStatus {
  file: string
  status: 'compared' | 'introduced' | 'absent' | 'failed'
  violations: MonotonicViolation[]
}

export function checkMonotonicBaselines(opts: {
  root: string
  base: string
}): {
  results: CheckedFileStatus[]
  violations: MonotonicViolation[]
} {
  // Fail-closed if base ref does not resolve
  execFileSync('git', ['-C', opts.root, 'rev-parse', '--verify', `${opts.base}^{commit}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const specs: MonotonicBaselineSpec[] = [
    { file: BUDGETS_PATH, validate: (h) => validateBudgetsSchema(h, BUDGETS_PATH), compare: (b, h) => compareBudgets(b, h, BUDGETS_PATH) },
    { file: DESIGN_TOKENS_COUNTS_PATH, validate: (h) => validateCountRatchetSchema(h, DESIGN_TOKENS_COUNTS_PATH), compare: (b, h) => compareCountRatchet(b, h, DESIGN_TOKENS_COUNTS_PATH) },
    { file: UI_STATIC_BASELINE_PATH, validate: (h) => validateCountRatchetSchema(h, UI_STATIC_BASELINE_PATH), compare: (b, h) => compareCountRatchet(b, h, UI_STATIC_BASELINE_PATH) },
    { file: LAYOUT_INVARIANTS_BASELINE_PATH, validate: (h) => validateLayoutInvariantsBaselineSchema(h, LAYOUT_INVARIANTS_BASELINE_PATH), compare: (b, h) => compareLayoutInvariantsBaseline(b, h, LAYOUT_INVARIANTS_BASELINE_PATH) },
    { file: FEATURE_FLAGS_REGISTRY_PATH, validate: (h) => validateFeatureFlagsSchema(h, FEATURE_FLAGS_REGISTRY_PATH), compare: (b, h) => compareFeatureFlagsRegistry(b, h, FEATURE_FLAGS_REGISTRY_PATH, { root: opts.root }) },
    ...buildExtraMonotonicSpecs(compareCountRatchet),
  ]

  const results: CheckedFileStatus[] = []
  const violations: MonotonicViolation[] = []

  for (const spec of specs) {
    const baseText = readGitFileAt(opts.root, opts.base, spec.file)
    const headAbs = path.join(opts.root, spec.file)
    const headExists = existsSync(headAbs)

    if (baseText === null && !headExists) {
      results.push({ file: spec.file, status: 'absent', violations: [] })
      continue
    }
    if (baseText !== null && !headExists) {
      const v: MonotonicViolation = {
        rule: 'MONOTONIC-FILE-DELETED',
        file: spec.file,
        key: '<file>',
        baseValue: 'present',
        headValue: 'deleted',
        detail: `protected baseline file ${spec.file} existed in ${opts.base} but was deleted`,
        howToFix: `Restore ${spec.file}; governance baselines may only tighten, never be deleted.`,
      }
      violations.push(v)
      results.push({ file: spec.file, status: 'failed', violations: [v] })
      continue
    }

    let headJson: unknown
    try {
      headJson = JSON.parse(readFileSync(headAbs, 'utf8'))
    } catch (err) {
      const v: MonotonicViolation = {
        rule: 'MONOTONIC-JSON-PARSE',
        file: spec.file,
        key: '<json>',
        baseValue: '-',
        headValue: 'invalid JSON',
        detail: `${spec.file} is not valid JSON: ${(err as Error).message}`,
        howToFix: `Fix JSON syntax errors in ${spec.file}.`,
      }
      violations.push(v)
      results.push({ file: spec.file, status: 'failed', violations: [v] })
      continue
    }

    if (baseText === null) {
      // First introduction: validate JSON schema and PASS if valid
      const schemaErrs = spec.validate(headJson)
      violations.push(...schemaErrs)
      results.push({
        file: spec.file,
        status: schemaErrs.length ? 'failed' : 'introduced',
        violations: schemaErrs,
      })
      continue
    }

    let baseJson: unknown
    try {
      baseJson = JSON.parse(baseText)
    } catch (err) {
      throw new Error(`invalid JSON at ${opts.base}:${spec.file}: ${(err as Error).message}`)
    }
    const errs = spec.compare(baseJson, headJson)
    violations.push(...errs)
    results.push({
      file: spec.file,
      status: errs.length ? 'failed' : 'compared',
      violations: errs,
    })
  }

  return { results, violations }
}

export function formatMonotonicViolation(v: MonotonicViolation, base: string): string {
  return [
    `[GATE-ERROR] ${v.rule} at ${v.file} (${v.key})`,
    `  Violation : ${v.detail} (base=${v.baseValue}, head=${v.headValue})`,
    '  Why       : Anti-tamper monotonic ratchet (Blueprint §4.2 ⑤): budgets, debt baselines, and flag TTLs may only tighten, never loosen.',
    `  How to Fix: ${v.howToFix}`,
    `  Re-verify : npx tsx scripts/check-monotonic-baselines.ts --base ${base}`,
  ].join('\n')
}

function main(argv: string[]): number {
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  let base = DEFAULT_BASE_REF
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') {
      const val = argv[++i]
      if (!val) {
        console.error('[monotonic-baselines] --root requires a path')
        return 2
      }
      root = path.resolve(val)
    } else if (argv[i] === '--base') {
      const val = argv[++i]
      if (!val) {
        console.error('[monotonic-baselines] --base requires a git ref')
        return 2
      }
      base = val
    } else {
      console.error(`[monotonic-baselines] unknown arg: ${argv[i]}`)
      return 2
    }
  }

  try {
    const t0 = Date.now()
    const { results, violations } = checkMonotonicBaselines({ root, base })
    const ms = Date.now() - t0
    for (const v of violations) console.error(formatMonotonicViolation(v, base))
    const summary = results.map((r) => `${path.basename(r.file)}=${r.status}`).join(' ')
    console.log(
      `[monotonic-baselines] base=${base} (${ms}ms): ${summary} | violations=${violations.length}`,
    )
    return violations.length > 0 ? 1 : 0
  } catch (err) {
    console.error(`[monotonic-baselines] FAIL-CLOSED: ${(err as Error).message.split('\n')[0]}`)
    return 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)))
}
