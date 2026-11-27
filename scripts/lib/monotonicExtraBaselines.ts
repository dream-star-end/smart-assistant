/**
 * Extra Monotonic Governance Baseline Specs (OCV5-903 / OCV5-904 / OCV5-905).
 *
 * Plugs the 6 newly introduced governance baselines into `scripts/check-monotonic-baselines.ts`
 * by reusing each gate script's exported `parse*` and `compare*` pure functions:
 *   - `arch/ai-smells-baseline.json`
 *   - `arch/file-cycles-baseline.json`
 *   - `arch/subdomain-violations-baseline.json`
 *   - `arch/complexity-baseline.json`
 *   - `arch/clones-baseline.json`
 *   - `arch/security-sast-baseline.json`
 */
import {
  BASELINE_PATH as AI_SMELLS_BASELINE_PATH,
  SMELL_CATEGORIES,
  compareBaselineMonotonic as compareAiSmellsBaselines,
  parseBaseline as parseAiSmellsBaseline,
} from '../check-ai-smells-ratchet.js'
import {
  BASELINE_REL_PATH as CLONES_BASELINE_PATH,
  compareClonesBaselines,
  parseClonesBaseline,
} from '../check-clones-ratchet.js'
import {
  BASELINE_REL_PATH as COMPLEXITY_BASELINE_PATH,
  compareComplexityBaselines,
  parseComplexityBaseline,
} from '../check-complexity-ratchet.js'
import type { MonotonicViolation } from '../check-monotonic-baselines.js'
import {
  BASELINE_REL_PATH as SECURITY_SAST_BASELINE_PATH,
  compareSecurityBaselines,
  parseSecurityBaseline,
} from '../check-security-sast.js'
import {
  FILE_CYCLES_BASELINE_REL as FILE_CYCLES_BASELINE_PATH,
  SUBDOMAIN_BASELINE_REL as SUBDOMAIN_VIOLATIONS_BASELINE_PATH,
  compareFileCyclesBaseline,
  parseFileCycleMembers,
} from './archMapUpgrades.js'

export {
  AI_SMELLS_BASELINE_PATH,
  FILE_CYCLES_BASELINE_PATH,
  SUBDOMAIN_VIOLATIONS_BASELINE_PATH,
  COMPLEXITY_BASELINE_PATH,
  CLONES_BASELINE_PATH,
  SECURITY_SAST_BASELINE_PATH,
}

export interface MonotonicBaselineSpec {
  file: string
  validate: (head: unknown) => MonotonicViolation[]
  compare: (base: unknown, head: unknown) => MonotonicViolation[]
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function schemaErr(file: string, key: string, detail: string, headValue = 'invalid'): MonotonicViolation {
  return {
    rule: 'MONOTONIC-SCHEMA-INVALID',
    file,
    key,
    baseValue: '-',
    headValue,
    detail,
    howToFix: `Restore valid schema in ${file}.`,
  }
}

export function validateAiSmellsBaselineSchema(
  raw: unknown,
  file = AI_SMELLS_BASELINE_PATH,
): MonotonicViolation[] {
  try {
    const parsed = parseAiSmellsBaseline(raw)
    const totals = parsed.totals as Record<string, unknown>
    for (const cat of [...SMELL_CATEGORIES, 'all']) {
      const n = totals[cat]
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
        return [schemaErr(file, `totals.${cat}`, `${file}: totals.${cat} must be a non-negative integer`, String(n))]
      }
    }
    return []
  } catch (err) {
    return [schemaErr(file, '<root>', (err as Error).message)]
  }
}

export function compareAiSmellsMonotonic(
  baseRaw: unknown,
  headRaw: unknown,
  file = AI_SMELLS_BASELINE_PATH,
): MonotonicViolation[] {
  const schemaErrs = validateAiSmellsBaselineSchema(headRaw, file)
  if (schemaErrs.length > 0) return schemaErrs
  const base = parseAiSmellsBaseline(baseRaw)
  const head = parseAiSmellsBaseline(headRaw)
  return compareAiSmellsBaselines(base, head).map((v) => ({
    rule: v.allowed === 0 ? 'MONOTONIC-COUNT-ADDED' : 'MONOTONIC-COUNT-RAISED',
    file,
    key: `${v.file}:${v.category}`,
    baseValue: String(v.allowed),
    headValue: String(v.actual),
    detail: `ai-smells baseline "${v.file}" (${v.category}) increased from ${v.allowed} to ${v.actual}`,
    howToFix: `Eliminate new AI code smells instead of raising ${file}.`,
  }))
}

function parseEntriesBaseline(
  raw: unknown,
  file: string,
  requireFileCycleKey: boolean,
): { entries: Record<string, number> } | MonotonicViolation[] {
  if (!isPlainObject(raw) || raw.schema !== 1 || !isPlainObject(raw.entries)) {
    return [schemaErr(file, '<root>', `${file} must be { schema: 1, entries: { ... } }`)]
  }
  const errs: MonotonicViolation[] = []
  const entries: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw.entries)) {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < (requireFileCycleKey ? 2 : 0)) {
      errs.push(
        schemaErr(
          file,
          k,
          `${file}: entry "${k}" must be an integer >= ${requireFileCycleKey ? 2 : 0}`,
          JSON.stringify(v),
        ),
      )
      continue
    }
    if (requireFileCycleKey && !parseFileCycleMembers(k)) {
      errs.push(schemaErr(file, k, `${file}: invalid R2-file-cycle key "${k}"`, JSON.stringify(v)))
      continue
    }
    entries[k] = v
  }
  return errs.length > 0 ? errs : { entries }
}

export function validateFileCyclesBaselineSchema(
  raw: unknown,
  file = FILE_CYCLES_BASELINE_PATH,
): MonotonicViolation[] {
  const res = parseEntriesBaseline(raw, file, true)
  return Array.isArray(res) ? res : []
}

export function compareFileCyclesMonotonic(
  baseRaw: unknown,
  headRaw: unknown,
  file = FILE_CYCLES_BASELINE_PATH,
): MonotonicViolation[] {
  const head = parseEntriesBaseline(headRaw, file, true)
  if (Array.isArray(head)) return head
  const base = parseEntriesBaseline(baseRaw, file, true)
  if (Array.isArray(base)) return []
  return compareFileCyclesBaseline(base.entries, head.entries).grown.map((g) => ({
    rule: g.baseline === 0 ? 'MONOTONIC-COUNT-ADDED' : 'MONOTONIC-COUNT-RAISED',
    file,
    key: g.key,
    baseValue: String(g.baseline),
    headValue: String(g.now),
    detail: `file-cycle baseline entry "${g.key}" grew (${g.baseline} -> ${g.now})`,
    howToFix: `Break the file-level circular import instead of adding/growing entries in ${file}.`,
  }))
}

export function validateSubdomainBaselineSchema(
  raw: unknown,
  file = SUBDOMAIN_VIOLATIONS_BASELINE_PATH,
): MonotonicViolation[] {
  const res = parseEntriesBaseline(raw, file, false)
  return Array.isArray(res) ? res : []
}

export function compareSubdomainMonotonic(
  baseRaw: unknown,
  headRaw: unknown,
  compareCountRatchet: (b: unknown, h: unknown, f: string) => MonotonicViolation[],
  file = SUBDOMAIN_VIOLATIONS_BASELINE_PATH,
): MonotonicViolation[] {
  const head = parseEntriesBaseline(headRaw, file, false)
  if (Array.isArray(head)) return head
  const base = parseEntriesBaseline(baseRaw, file, false)
  if (Array.isArray(base)) return []
  return compareCountRatchet(base.entries, head.entries, file)
}

export function validateComplexityBaselineSchema(
  raw: unknown,
  file = COMPLEXITY_BASELINE_PATH,
): MonotonicViolation[] {
  try {
    parseComplexityBaseline(raw)
    return []
  } catch (err) {
    return [schemaErr(file, '<root>', (err as Error).message)]
  }
}

export function compareComplexityMonotonic(
  baseRaw: unknown,
  headRaw: unknown,
  file = COMPLEXITY_BASELINE_PATH,
): MonotonicViolation[] {
  const schemaErrs = validateComplexityBaselineSchema(headRaw, file)
  if (schemaErrs.length > 0) return schemaErrs
  const base = parseComplexityBaseline(baseRaw)
  const head = parseComplexityBaseline(headRaw)
  return compareComplexityBaselines(base, head).map((v) => ({
    rule: v.key === '<limits>' ? 'MONOTONIC-BUDGET-RAISED' : 'MONOTONIC-COUNT-RAISED',
    file,
    key: v.key,
    baseValue: `${v.allowed.lines}/${v.allowed.ccDirect}/${v.allowed.maxNesting}`,
    headValue: `${v.actual.lines}/${v.actual.ccDirect}/${v.actual.maxNesting}`,
    detail: v.detail,
    howToFix: `Refactor complex functions instead of loosening ${file}.`,
  }))
}

export function validateClonesBaselineSchema(
  raw: unknown,
  file = CLONES_BASELINE_PATH,
): MonotonicViolation[] {
  try {
    parseClonesBaseline(raw)
    return []
  } catch (err) {
    return [schemaErr(file, '<root>', (err as Error).message)]
  }
}

export function compareClonesMonotonic(
  baseRaw: unknown,
  headRaw: unknown,
  file = CLONES_BASELINE_PATH,
): MonotonicViolation[] {
  const schemaErrs = validateClonesBaselineSchema(headRaw, file)
  if (schemaErrs.length > 0) return schemaErrs
  const base = parseClonesBaseline(baseRaw)
  const head = parseClonesBaseline(headRaw)
  return compareClonesBaselines(base, head).map((v) => ({
    rule: v.allowedFiles === 0 ? 'MONOTONIC-COUNT-ADDED' : 'MONOTONIC-COUNT-RAISED',
    file,
    key: v.hash,
    baseValue: `${v.allowedFiles}f/${v.allowedInstances}i`,
    headValue: `${v.files}f/${v.instances}i`,
    detail: v.detail,
    howToFix: `Deduplicate cloned logic into shared helpers instead of raising ${file}.`,
  }))
}

export function validateSecuritySastBaselineSchema(
  raw: unknown,
  file = SECURITY_SAST_BASELINE_PATH,
): MonotonicViolation[] {
  try {
    parseSecurityBaseline(raw)
    return []
  } catch (err) {
    return [schemaErr(file, '<root>', (err as Error).message)]
  }
}

export function compareSecuritySastMonotonic(
  baseRaw: unknown,
  headRaw: unknown,
  file = SECURITY_SAST_BASELINE_PATH,
): MonotonicViolation[] {
  const schemaErrs = validateSecuritySastBaselineSchema(headRaw, file)
  if (schemaErrs.length > 0) return schemaErrs
  const base = parseSecurityBaseline(baseRaw)
  const head = parseSecurityBaseline(headRaw)
  return compareSecurityBaselines(base, head).map((v) => ({
    rule: v.allowedCount === 0 ? 'MONOTONIC-COUNT-ADDED' : 'MONOTONIC-COUNT-RAISED',
    file,
    key: `${v.file}|${v.ruleId}`,
    baseValue: String(v.allowedCount),
    headValue: String(v.actualCount),
    detail: v.detail,
    howToFix: `Fix the SAST anti-pattern in source code instead of raising ${file}.`,
  }))
}

export function buildExtraMonotonicSpecs(
  compareCountRatchet: (b: unknown, h: unknown, f: string) => MonotonicViolation[],
): MonotonicBaselineSpec[] {
  return [
    {
      file: AI_SMELLS_BASELINE_PATH,
      validate: (h) => validateAiSmellsBaselineSchema(h, AI_SMELLS_BASELINE_PATH),
      compare: (b, h) => compareAiSmellsMonotonic(b, h, AI_SMELLS_BASELINE_PATH),
    },
    {
      file: FILE_CYCLES_BASELINE_PATH,
      validate: (h) => validateFileCyclesBaselineSchema(h, FILE_CYCLES_BASELINE_PATH),
      compare: (b, h) => compareFileCyclesMonotonic(b, h, FILE_CYCLES_BASELINE_PATH),
    },
    {
      file: SUBDOMAIN_VIOLATIONS_BASELINE_PATH,
      validate: (h) => validateSubdomainBaselineSchema(h, SUBDOMAIN_VIOLATIONS_BASELINE_PATH),
      compare: (b, h) => compareSubdomainMonotonic(b, h, compareCountRatchet, SUBDOMAIN_VIOLATIONS_BASELINE_PATH),
    },
    {
      file: COMPLEXITY_BASELINE_PATH,
      validate: (h) => validateComplexityBaselineSchema(h, COMPLEXITY_BASELINE_PATH),
      compare: (b, h) => compareComplexityMonotonic(b, h, COMPLEXITY_BASELINE_PATH),
    },
    {
      file: CLONES_BASELINE_PATH,
      validate: (h) => validateClonesBaselineSchema(h, CLONES_BASELINE_PATH),
      compare: (b, h) => compareClonesMonotonic(b, h, CLONES_BASELINE_PATH),
    },
    {
      file: SECURITY_SAST_BASELINE_PATH,
      validate: (h) => validateSecuritySastBaselineSchema(h, SECURITY_SAST_BASELINE_PATH),
      compare: (b, h) => compareSecuritySastMonotonic(b, h, SECURITY_SAST_BASELINE_PATH),
    },
  ]
}
