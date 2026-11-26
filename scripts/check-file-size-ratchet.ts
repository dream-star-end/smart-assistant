/**
 * Large source file ratchet (FINDINGS §7 / ARC-3, Governance Blueprint §4.2 ③, OCV5-904).
 *
 * .github/file-size-baseline.json governs (ALL slacks strictly 0 — zero leak!):
 *   - `files`: pre-existing > `limit` (3,000) line monoliths (cap = baseline + 0, shrink-only);
 *   - `cssFiles`: pre-existing > `limit` CSS monoliths (cap = baseline + 0, shrink-only);
 *   - `yellowZoneFiles` (`yellowZoneLimit` = 2,000, `yellowZoneSlack` = 0): frozen
 *     2,000–3,000 line production files (shrink-only);
 *   - `orangeZoneFiles` (`orangeZoneLimit` = 800, `orangeZoneSlack` = 0): frozen
 *     801–1,999 line production `.ts/.tsx/.mts/.cts` files (shrink-only);
 *   - any new/unlisted `.ts/.tsx/.mts/.cts` production file may NOT exceed `orangeZoneLimit` (800 lines);
 *   - any other unlisted source file may NOT reach `yellowZoneLimit` (2,000) or exceed `limit` (3,000);
 *   - the baseline only goes down: a PR may lower a number or drop an entry
 *     (after a split, run with --update-baseline), never raise or add one.
 *
 * A deliberate overrun goes in .github/file-size-ratchet-exceptions.json:
 *   { "path": "...", "maxLines": N, "ticket": "OCV5-123", "reason": "...", "expires": "YYYY-MM-DD" }
 * (strictly unexpired, at most 30 days out, no duplicate paths, and NO renewal of existing/expired entries).
 *
 * Usage:
 *   npx tsx scripts/check-file-size-ratchet.ts                                (full working-tree check)
 *   npx tsx scripts/check-file-size-ratchet.ts --base <git-ref> [--head <ref>] (diff + baseline/exception monotonic check)
 *   npx tsx scripts/check-file-size-ratchet.ts --update-baseline              (lowers only)
 * Exit: 0 ok, 1 violations, 2 usage/git error.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const MAX_EXCEPTION_DAYS = 30
export const MAX_ALLOWED_SLACK = 0
export const NEW_TS_FILE_HARD_LIMIT = 800
export const BASELINE_PATH = '.github/file-size-baseline.json'
export const EXCEPTIONS_PATH = '.github/file-size-ratchet-exceptions.json'
const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs|sh|py|css)$/
const TS_SOURCE = /\.(ts|tsx|mts|cts)$/
const EXCLUDE = [
  /(^|\/)(node_modules|dist|dist-types|vendor|__fixtures__|fixtures|__snapshots__|generated)\//,
  /\.d\.ts$/,
  /\.min\.(?:js|css)$/,
  /(^|\/)__tests__\//,
  /\.(test|spec|integ\.test|node-test)\.[cm]?[jt]sx?$/,
  /^claude-code-best\//,
]

export type Baseline = {
  limit: number
  slack: number
  files: Record<string, number>
  cssFiles?: Record<string, number>
  yellowZoneLimit?: number
  yellowZoneSlack?: number
  yellowZoneFiles?: Record<string, number>
  orangeZoneLimit?: number
  orangeZoneSlack?: number
  orangeZoneFiles?: Record<string, number>
}

export type Exception = {
  path: string
  maxLines: number
  ticket: string
  reason: string
  expires: string
}

export type Violation = {
  path: string
  head: number
  allowed: number
  kind:
    | 'over-baseline'
    | 'over-yellow-zone'
    | 'over-orange-zone'
    | 'new-over-limit'
    | 'new-over-yellow-zone'
    | 'new-over-orange-zone'
    | 'baseline-raised'
    | 'slack-nonzero'
    | 'exception-renewed'
    | 'exception-raised'
}

export interface ApprovedCalibration {
  readonly ticket: string
  readonly fromBaselineSha256: string
  readonly toBaselineSha256: string
}

/**
 * Single-use A0-locked dual-hash calibration anchor (OCV5-904):
 * permits ONLY the exact one-time transition from the pre-OCV5-904 slack=100 baseline
 * to the zero-slack + 800-line orange-zone baseline frozen at HEAD 120d63ea1.
 * Permanently self-invalidates once merged.
 */
export const APPROVED_CALIBRATION: ApprovedCalibration = {
  ticket: 'OCV5-904',
  fromBaselineSha256: '458c08ed73c9fc50dacadb732ba581fd81a7a3c8f306cffef0312f13b72d37ba',
  toBaselineSha256: '462ce2061aa3a46e473387c3d3f00a15f731e658895754b1393ffbae83358cf6',
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function isApprovedCalibration(
  baseBaselineRaw: string | null,
  headBaselineRaw: string,
  anchor: ApprovedCalibration | null = APPROVED_CALIBRATION,
): boolean {
  if (!anchor || baseBaselineRaw === null) return false
  return (
    sha256Hex(baseBaselineRaw) === anchor.fromBaselineSha256.toLowerCase() &&
    sha256Hex(headBaselineRaw) === anchor.toBaselineSha256.toLowerCase()
  )
}

export function isRatchetSource(file: string): boolean {
  return SOURCE.test(file) && !EXCLUDE.some((re) => re.test(file))
}

export function isTsProductionFile(file: string): boolean {
  return TS_SOURCE.test(file) && isRatchetSource(file)
}

export function lineCount(text: string): number {
  if (text === '') return 0
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

function isIntMap(v: unknown): v is Record<string, number> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.values(v).every((n) => Number.isInteger(n) && (n as number) >= 0)
  )
}

function parseIsoDateMs(s: unknown): number {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return Number.NaN
  const ms = Date.parse(`${s}T00:00:00Z`)
  if (!Number.isFinite(ms)) return Number.NaN
  return new Date(ms).toISOString().slice(0, 10) === s ? ms : Number.NaN
}

export function parseBaseline(raw: unknown): Baseline {
  const b = raw as Partial<Baseline>
  if (
    !b ||
    !Number.isInteger(b.limit) ||
    !Number.isInteger(b.slack) ||
    (b.slack as number) < 0 ||
    !isIntMap(b.files) ||
    (b.cssFiles !== undefined && !isIntMap(b.cssFiles)) ||
    (b.yellowZoneLimit !== undefined &&
      (!Number.isInteger(b.yellowZoneLimit) || (b.yellowZoneLimit as number) <= 0)) ||
    (b.yellowZoneSlack !== undefined &&
      (!Number.isInteger(b.yellowZoneSlack) || (b.yellowZoneSlack as number) < 0)) ||
    (b.yellowZoneFiles !== undefined && !isIntMap(b.yellowZoneFiles)) ||
    (b.orangeZoneLimit !== undefined &&
      (!Number.isInteger(b.orangeZoneLimit) || (b.orangeZoneLimit as number) <= 0)) ||
    (b.orangeZoneSlack !== undefined &&
      (!Number.isInteger(b.orangeZoneSlack) || (b.orangeZoneSlack as number) < 0)) ||
    (b.orangeZoneFiles !== undefined && !isIntMap(b.orangeZoneFiles))
  ) {
    throw new Error(`${BASELINE_PATH} must be {limit, slack, files: {path: lines}, ...}`)
  }
  return b as Baseline
}

export function validateExceptions(
  entries: unknown,
  today: string,
): { ok: Map<string, Exception>; problems: Array<{ path: string | null; message: string }> } {
  const ok = new Map<string, Exception>()
  const problems: Array<{ path: string | null; message: string }> = []
  if (!Array.isArray(entries))
    return { ok, problems: [{ path: null, message: 'exceptions file must be a JSON array' }] }
  const todayMs = parseIsoDateMs(today)
  const seen = new Set<string>()
  for (const [i, e] of entries.entries()) {
    const x = e as Partial<Exception>
    const p = typeof x?.path === 'string' ? x.path : null
    const own: string[] = []
    if (!p || !Number.isInteger(x.maxLines) || (x.maxLines as number) <= 0)
      own.push('needs path and a positive integer maxLines')
    if (p && seen.has(p)) own.push('duplicate exception entry for the same path')
    if (p) seen.add(p)
    if (typeof x?.ticket !== 'string' || !/^OCV5-\d+$/.test(x.ticket))
      own.push('ticket must look like OCV5-123')
    if (typeof x?.reason !== 'string' || x.reason.trim().length < 10)
      own.push('reason must say why (>= 10 chars)')
    const exp = parseIsoDateMs(x?.expires)
    if (!Number.isFinite(exp)) own.push('expires must be a valid YYYY-MM-DD')
    else if (exp < todayMs) own.push(`expired on ${x.expires}`)
    else if (exp - todayMs > MAX_EXCEPTION_DAYS * 86_400_000)
      own.push(`expires more than ${MAX_EXCEPTION_DAYS} days out`)
    if (own.length > 0) {
      for (const m of own)
        problems.push({ path: p, message: `exceptions[${i}]${p ? ` (${p})` : ''}: ${m}` })
      continue
    }
    ok.set(p as string, x as Exception)
  }
  return { ok, problems }
}

/**
 * Forbids renewing/extending `expires` or raising `maxLines` on any pre-existing or expired exception.
 */
export function exceptionRenewals(baseRaw: unknown, headRaw: unknown): Violation[] {
  if (!Array.isArray(baseRaw) || !Array.isArray(headRaw)) return []
  const baseByPath = new Map<string, { expiresMs: number; maxLines: number }>()
  for (const item of baseRaw) {
    const x = item as Partial<Exception>
    if (typeof x?.path === 'string') {
      baseByPath.set(x.path, {
        expiresMs: parseIsoDateMs(x.expires),
        maxLines: Number.isInteger(x.maxLines) ? (x.maxLines as number) : 0,
      })
    }
  }
  const out: Violation[] = []
  for (const item of headRaw) {
    const x = item as Partial<Exception>
    if (typeof x?.path !== 'string') continue
    const prev = baseByPath.get(x.path)
    if (!prev) continue
    const headExpMs = parseIsoDateMs(x.expires)
    if (Number.isFinite(prev.expiresMs) && Number.isFinite(headExpMs) && headExpMs > prev.expiresMs) {
      out.push({
        path: x.path,
        head: Math.round(headExpMs / 86_400_000),
        allowed: Math.round(prev.expiresMs / 86_400_000),
        kind: 'exception-renewed',
      })
    }
    if (Number.isInteger(x.maxLines) && (x.maxLines as number) > prev.maxLines) {
      out.push({
        path: x.path,
        head: x.maxLines as number,
        allowed: prev.maxLines,
        kind: 'exception-raised',
      })
    }
  }
  return out
}

/** Line caps for the checked files under the head baseline (+ exceptions), strictly zero slack. */
export function evaluate(
  changes: Array<{ path: string; head: number }>,
  baseline: Baseline,
  exceptions: Map<string, Exception>,
): Violation[] {
  const out: Violation[] = []

  // Enforce slack === 0 across red, yellow, and orange zones (seals the 100-line leak permanently).
  if (baseline.slack > MAX_ALLOWED_SLACK) {
    out.push({ path: BASELINE_PATH, head: baseline.slack, allowed: MAX_ALLOWED_SLACK, kind: 'slack-nonzero' })
  }
  if ((baseline.yellowZoneSlack ?? 0) > MAX_ALLOWED_SLACK) {
    out.push({
      path: BASELINE_PATH,
      head: baseline.yellowZoneSlack ?? 0,
      allowed: MAX_ALLOWED_SLACK,
      kind: 'slack-nonzero',
    })
  }
  if ((baseline.orangeZoneSlack ?? 0) > MAX_ALLOWED_SLACK) {
    out.push({
      path: BASELINE_PATH,
      head: baseline.orangeZoneSlack ?? 0,
      allowed: MAX_ALLOWED_SLACK,
      kind: 'slack-nonzero',
    })
  }

  for (const c of changes) {
    const ex = exceptions.get(c.path)
    const listedRed = baseline.files[c.path]
    if (listedRed !== undefined) {
      const allowed = listedRed
      if (c.head <= allowed || (ex && c.head <= ex.maxLines)) continue
      out.push({ path: c.path, head: c.head, allowed, kind: 'over-baseline' })
      continue
    }
    const listedCss = baseline.cssFiles?.[c.path]
    if (listedCss !== undefined) {
      const allowed = listedCss
      if (c.head <= allowed || (ex && c.head <= ex.maxLines)) continue
      out.push({ path: c.path, head: c.head, allowed, kind: 'over-baseline' })
      continue
    }
    const listedYellow = baseline.yellowZoneFiles?.[c.path]
    if (listedYellow !== undefined) {
      const allowed = listedYellow
      if (c.head <= allowed || (ex && c.head <= ex.maxLines)) continue
      out.push({ path: c.path, head: c.head, allowed, kind: 'over-yellow-zone' })
      continue
    }
    const listedOrange = baseline.orangeZoneFiles?.[c.path]
    if (listedOrange !== undefined) {
      const allowed = listedOrange
      if (c.head <= allowed || (ex && c.head <= ex.maxLines)) continue
      out.push({ path: c.path, head: c.head, allowed, kind: 'over-orange-zone' })
      continue
    }
    if (c.head > baseline.limit) {
      if (ex && c.head <= ex.maxLines) continue
      out.push({ path: c.path, head: c.head, allowed: baseline.limit, kind: 'new-over-limit' })
      continue
    }
    if (baseline.yellowZoneLimit !== undefined && c.head >= baseline.yellowZoneLimit) {
      if (ex && c.head <= ex.maxLines) continue
      out.push({
        path: c.path,
        head: c.head,
        allowed: baseline.yellowZoneLimit - 1,
        kind: 'new-over-yellow-zone',
      })
      continue
    }
    if (
      baseline.orangeZoneLimit !== undefined &&
      isTsProductionFile(c.path) &&
      c.head > baseline.orangeZoneLimit
    ) {
      if (ex && c.head <= ex.maxLines) continue
      out.push({
        path: c.path,
        head: c.head,
        allowed: baseline.orangeZoneLimit,
        kind: 'new-over-orange-zone',
      })
    }
  }
  return out
}

/** The baseline only goes down: no new entries, no raised numbers, same/tighter limit/slack. */
export function baselineRaises(base: Baseline, head: Baseline): Violation[] {
  const out: Violation[] = []
  if (head.limit > base.limit || head.slack > base.slack) {
    out.push({ path: BASELINE_PATH, head: head.slack, allowed: base.slack, kind: 'baseline-raised' })
  }
  for (const [p, n] of Object.entries(head.files)) {
    const was = base.files[p]
    if (was === undefined || n > was)
      out.push({ path: p, head: n, allowed: was ?? 0, kind: 'baseline-raised' })
  }
  if (base.cssFiles !== undefined) {
    if (head.cssFiles === undefined) {
      out.push({
        path: BASELINE_PATH,
        head: 0,
        allowed: Object.keys(base.cssFiles).length,
        kind: 'baseline-raised',
      })
    } else {
      for (const [p, n] of Object.entries(head.cssFiles)) {
        const was = base.cssFiles[p]
        if (was === undefined || n > was)
          out.push({ path: p, head: n, allowed: was ?? 0, kind: 'baseline-raised' })
      }
    }
  }
  if (base.yellowZoneLimit !== undefined) {
    if (head.yellowZoneLimit === undefined || head.yellowZoneLimit > base.yellowZoneLimit) {
      out.push({
        path: BASELINE_PATH,
        head: head.yellowZoneLimit ?? head.limit,
        allowed: base.yellowZoneLimit,
        kind: 'baseline-raised',
      })
    }
  }
  const hasYellowZoneInBase =
    base.yellowZoneLimit !== undefined ||
    base.yellowZoneSlack !== undefined ||
    base.yellowZoneFiles !== undefined
  if (base.yellowZoneSlack !== undefined && head.yellowZoneSlack === undefined) {
    out.push({ path: BASELINE_PATH, head: head.slack, allowed: base.yellowZoneSlack, kind: 'baseline-raised' })
  } else if (hasYellowZoneInBase) {
    const baseEffectiveSlack = base.yellowZoneSlack ?? 0
    const headEffectiveSlack = head.yellowZoneSlack ?? 0
    if (headEffectiveSlack > baseEffectiveSlack) {
      out.push({
        path: BASELINE_PATH,
        head: headEffectiveSlack,
        allowed: baseEffectiveSlack,
        kind: 'baseline-raised',
      })
    }
  }
  if (base.yellowZoneFiles !== undefined) {
    if (head.yellowZoneFiles === undefined) {
      out.push({
        path: BASELINE_PATH,
        head: 0,
        allowed: Object.keys(base.yellowZoneFiles).length,
        kind: 'baseline-raised',
      })
    } else {
      for (const [p, n] of Object.entries(head.yellowZoneFiles)) {
        const wasYellow = base.yellowZoneFiles[p]
        const wasRed = base.files[p] ?? base.cssFiles?.[p]
        const allowedPrev = wasYellow !== undefined ? wasYellow : wasRed
        if (allowedPrev === undefined || n > allowedPrev)
          out.push({ path: p, head: n, allowed: allowedPrev ?? 0, kind: 'baseline-raised' })
      }
    }
  }
  if (base.orangeZoneLimit !== undefined) {
    if (head.orangeZoneLimit === undefined || head.orangeZoneLimit > base.orangeZoneLimit) {
      out.push({
        path: BASELINE_PATH,
        head: head.orangeZoneLimit ?? head.yellowZoneLimit ?? head.limit,
        allowed: base.orangeZoneLimit,
        kind: 'baseline-raised',
      })
    }
  }
  const hasOrangeZoneInBase =
    base.orangeZoneLimit !== undefined ||
    base.orangeZoneSlack !== undefined ||
    base.orangeZoneFiles !== undefined
  if (base.orangeZoneSlack !== undefined && head.orangeZoneSlack === undefined) {
    out.push({ path: BASELINE_PATH, head: head.slack, allowed: base.orangeZoneSlack, kind: 'baseline-raised' })
  } else if (hasOrangeZoneInBase) {
    const baseEffectiveSlack = base.orangeZoneSlack ?? 0
    const headEffectiveSlack = head.orangeZoneSlack ?? 0
    if (headEffectiveSlack > baseEffectiveSlack) {
      out.push({
        path: BASELINE_PATH,
        head: headEffectiveSlack,
        allowed: baseEffectiveSlack,
        kind: 'baseline-raised',
      })
    }
  }
  if (base.orangeZoneFiles !== undefined) {
    if (head.orangeZoneFiles === undefined) {
      out.push({
        path: BASELINE_PATH,
        head: 0,
        allowed: Object.keys(base.orangeZoneFiles).length,
        kind: 'baseline-raised',
      })
    } else {
      for (const [p, n] of Object.entries(head.orangeZoneFiles)) {
        const allowedPrev =
          base.orangeZoneFiles[p] ?? base.yellowZoneFiles?.[p] ?? base.files[p]
        if (allowedPrev === undefined || n > allowedPrev)
          out.push({ path: p, head: n, allowed: allowedPrev ?? 0, kind: 'baseline-raised' })
      }
    }
  }
  return out
}

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
}

function fileAt(root: string, ref: string, file: string): string | null {
  try {
    return execFileSync('git', ['-C', root, 'show', `${ref}:${file}`], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
}

function sortRecord(map: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  )
}

function updateBaseline(root: string): number {
  const file = path.join(root, BASELINE_PATH)
  const b = parseBaseline(JSON.parse(readFileSync(file, 'utf8')))
  const nextFiles: Record<string, number> = {}
  const nextYellow: Record<string, number> | undefined = b.yellowZoneFiles ? {} : undefined
  const nextOrange: Record<string, number> | undefined = b.orangeZoneFiles ? {} : undefined

  const placeLowered = (p: string, cap: number, isCss: boolean) => {
    if (cap > b.limit) {
      if (!isCss) nextFiles[p] = cap
    } else if (nextYellow && b.yellowZoneLimit !== undefined && cap >= b.yellowZoneLimit) {
      nextYellow[p] = Math.min(nextYellow[p] ?? cap, cap)
    } else if (
      !isCss &&
      nextOrange &&
      b.orangeZoneLimit !== undefined &&
      isTsProductionFile(p) &&
      cap > b.orangeZoneLimit
    ) {
      nextOrange[p] = Math.min(nextOrange[p] ?? cap, cap)
    }
  }

  for (const [p, was] of Object.entries(b.files)) {
    let now: number
    try {
      now = lineCount(readFileSync(path.join(root, p), 'utf8'))
    } catch {
      continue
    }
    placeLowered(p, Math.min(was, now), false)
  }

  let nextCss: Record<string, number> | undefined
  if (b.cssFiles) {
    nextCss = {}
    for (const [p, was] of Object.entries(b.cssFiles)) {
      let now: number
      try {
        now = lineCount(readFileSync(path.join(root, p), 'utf8'))
      } catch {
        continue
      }
      const cap = Math.min(was, now)
      if (cap > b.limit) nextCss[p] = cap
      else placeLowered(p, cap, true)
    }
  }

  if (b.yellowZoneFiles && nextYellow) {
    const yLimit = b.yellowZoneLimit ?? 2000
    for (const [p, was] of Object.entries(b.yellowZoneFiles)) {
      let now: number
      try {
        now = lineCount(readFileSync(path.join(root, p), 'utf8'))
      } catch {
        continue
      }
      const cap = Math.min(was, now)
      if (cap >= yLimit) nextYellow[p] = Math.min(nextYellow[p] ?? cap, cap)
      else placeLowered(p, cap, /\.css$/.test(p))
    }
  }

  if (b.orangeZoneFiles && nextOrange) {
    const oLimit = b.orangeZoneLimit ?? NEW_TS_FILE_HARD_LIMIT
    for (const [p, was] of Object.entries(b.orangeZoneFiles)) {
      let now: number
      try {
        now = lineCount(readFileSync(path.join(root, p), 'utf8'))
      } catch {
        continue
      }
      const cap = Math.min(was, now)
      if (cap > oLimit) nextOrange[p] = Math.min(nextOrange[p] ?? cap, cap)
    }
  }

  const updated: Baseline = {
    ...b,
    slack: 0,
    files: sortRecord(nextFiles),
    ...(nextCss !== undefined ? { cssFiles: sortRecord(nextCss) } : {}),
    ...(b.yellowZoneLimit !== undefined ? { yellowZoneSlack: 0 } : {}),
    ...(nextYellow !== undefined ? { yellowZoneFiles: sortRecord(nextYellow) } : {}),
    ...(b.orangeZoneLimit !== undefined ? { orangeZoneSlack: 0 } : {}),
    ...(nextOrange !== undefined ? { orangeZoneFiles: sortRecord(nextOrange) } : {}),
  }
  writeFileSync(file, `${JSON.stringify(updated, null, 2)}\n`)
  console.log(
    `baseline: red ${Object.keys(b.files).length} -> ${Object.keys(nextFiles).length}, yellow ${Object.keys(b.yellowZoneFiles ?? {}).length} -> ${Object.keys(nextYellow ?? {}).length}, orange ${Object.keys(b.orangeZoneFiles ?? {}).length} -> ${Object.keys(nextOrange ?? {}).length} (lowered only, slack=0)`,
  )
  return 0
}

function formatViolationMessages(v: Violation, headBaseline: Baseline): {
  annotation: string
  gateError: string
} {
  const isCss = headBaseline.cssFiles?.[v.path] !== undefined
  const msg =
    v.kind === 'slack-nonzero'
      ? `${BASELINE_PATH} sets slack=${v.head}; slack must be 0 across red, yellow, and orange zones (zero leak).`
      : v.kind === 'exception-renewed'
        ? `${v.path}: existing/expired exception in ${EXCEPTIONS_PATH} cannot be renewed or extended.`
        : v.kind === 'exception-raised'
          ? `${v.path}: existing exception maxLines in ${EXCEPTIONS_PATH} cannot be raised (${v.allowed} -> ${v.head}).`
          : v.kind === 'over-baseline'
            ? `${v.path} has ${v.head} lines; its cap is ${v.allowed} (${isCss ? 'CSS baseline, shrink-only' : 'zero-slack red baseline, net growth <= 0'}). Move code out of it, or add a dated <=30d exception.`
            : v.kind === 'over-yellow-zone'
              ? `${v.path} has ${v.head} lines; yellow-zone frozen cap is ${v.allowed} (2,000–3,000 line freeze, slack=0). Extract cohesive helpers/sub-modules instead of growing.`
              : v.kind === 'over-orange-zone'
                ? `${v.path} has ${v.head} lines; orange-zone frozen cap is ${v.allowed} (801–1,999 line TS freeze, slack=0). Extract cohesive helpers/sub-modules instead of growing.`
                : v.kind === 'new-over-orange-zone'
                  ? `${v.path} has ${v.head} lines (> new production TS/TSX hard limit ${headBaseline.orangeZoneLimit ?? NEW_TS_FILE_HARD_LIMIT}). Split into cohesive modules <= ${v.allowed} lines.`
                  : v.kind === 'new-over-yellow-zone'
                    ? `${v.path} has ${v.head} lines (>= yellow-zone limit ${headBaseline.yellowZoneLimit}). Split into domain modules before crossing 2,000 lines, or add a dated exception.`
                    : v.kind === 'new-over-limit'
                      ? `${v.path} has ${v.head} lines (> ${headBaseline.limit}). Split it, or add a dated exception.`
                      : `${v.path}: the size baseline may only go down (was ${v.allowed}, now ${v.head}).`
  const fileRef =
    v.kind === 'baseline-raised' || v.kind === 'slack-nonzero'
      ? BASELINE_PATH
      : v.kind === 'exception-renewed' || v.kind === 'exception-raised'
        ? EXCEPTIONS_PATH
        : v.path
  const gateError = [
    `[GATE-ERROR] FILE-SIZE-RATCHET (${v.kind}) at ${fileRef}`,
    `  Violation : ${msg}`,
    '  Why       : Zero-slack ratchets and the 800-line cap for new TS/TSX files prevent god-file drift (OCV5-904).',
    `  How to Fix: Extract cohesive domain helpers/hooks/stylesheets to stay <= ${v.allowed} lines (run \`npx tsx scripts/check-file-size-ratchet.ts --update-baseline\` after shrinking), or add a <=30d A0-approved exception in ${EXCEPTIONS_PATH}.`,
    '  Re-verify : npx tsx scripts/check-file-size-ratchet.ts',
  ].join('\n')
  return { annotation: `::error file=${fileRef}::${msg}`, gateError }
}

function main(argv: string[]): number {
  let base = ''
  let head = 'HEAD'
  let update = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') {
      base = argv[++i] ?? ''
      if (!base) {
        console.error('--base requires a git ref')
        return 2
      }
    } else if (argv[i] === '--head') head = argv[++i] ?? ''
    else if (argv[i] === '--update-baseline') update = true
    else {
      console.error(`unknown arg: ${argv[i]}`)
      return 2
    }
  }
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim()
  if (update) return updateBaseline(root)

  const today = new Date().toISOString().slice(0, 10)

  if (!base) {
    const baselineAbs = path.join(root, BASELINE_PATH)
    if (!existsSync(baselineAbs)) {
      console.error(`${BASELINE_PATH} missing in working tree`)
      return 2
    }
    const headBaseline = parseBaseline(JSON.parse(readFileSync(baselineAbs, 'utf8')))
    const exAbs = path.join(root, EXCEPTIONS_PATH)
    const rawEx: unknown = existsSync(exAbs) ? JSON.parse(readFileSync(exAbs, 'utf8')) : []
    const { ok, problems } = validateExceptions(rawEx, today)

    const allFiles = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
      .split('\0')
      .filter((p) => p && isRatchetSource(p) && existsSync(path.join(root, p)))
    const entries = allFiles.map((p) => ({
      path: p,
      head: lineCount(readFileSync(path.join(root, p), 'utf8')),
    }))
    const violations = evaluate(entries, headBaseline, ok)
    for (const p of problems) {
      console.log(`::error file=${EXCEPTIONS_PATH}::${p.message}`)
    }
    for (const v of violations) {
      const { annotation, gateError } = formatViolationMessages(v, headBaseline)
      console.log(annotation)
      console.error(gateError)
    }
    console.log(
      `file-size ratchet (worktree): ${entries.length} source files scanned, ${Object.keys(headBaseline.files).length} red + ${Object.keys(headBaseline.cssFiles ?? {}).length} css + ${Object.keys(headBaseline.yellowZoneFiles ?? {}).length} yellow + ${Object.keys(headBaseline.orangeZoneFiles ?? {}).length} orange baselined (slack=${headBaseline.slack}), ${violations.length} violations, ${problems.length} exception problems`,
    )
    return violations.length + problems.length > 0 ? 1 : 0
  }

  let names: string[]
  try {
    names = git(root, ['diff', '-z', '--name-only', '--diff-filter=AMR', `${base}...${head}`])
      .split('\0')
      .filter(Boolean)
  } catch (err) {
    console.error(`git diff ${base}...${head} failed: ${(err as Error).message}`)
    return 2
  }
  const headBaselineText = fileAt(root, head, BASELINE_PATH)
  if (headBaselineText === null) {
    console.error(`${BASELINE_PATH} missing at ${head}`)
    return 2
  }
  const headBaseline = parseBaseline(JSON.parse(headBaselineText))
  const baseBaselineText = fileAt(root, base, BASELINE_PATH)
  const violations: Violation[] = []
  if (baseBaselineText !== null && !isApprovedCalibration(baseBaselineText, headBaselineText)) {
    violations.push(...baselineRaises(parseBaseline(JSON.parse(baseBaselineText)), headBaseline))
  }

  const changes = names
    .filter(isRatchetSource)
    .map((p) => ({ path: p, head: lineCount(fileAt(root, head, p) ?? '') }))
  let rawEx: unknown = []
  const exText = fileAt(root, head, EXCEPTIONS_PATH)
  if (exText !== null) rawEx = JSON.parse(exText)
  const baseExText = fileAt(root, base, EXCEPTIONS_PATH)
  if (baseExText !== null) {
    try {
      violations.push(...exceptionRenewals(JSON.parse(baseExText), rawEx))
    } catch {
      // ignore invalid base exceptions json
    }
  }
  const { ok, problems } = validateExceptions(rawEx, today)
  violations.push(...evaluate(changes, headBaseline, ok))

  const touched = new Set(names)
  const exceptionsChanged = touched.has(EXCEPTIONS_PATH)
  let problemErrors = 0
  for (const p of problems) {
    const blocking = exceptionsChanged || (p.path !== null && touched.has(p.path))
    if (blocking) problemErrors++
    console.log(`::${blocking ? 'error' : 'warning'} file=${EXCEPTIONS_PATH}::${p.message}`)
  }
  for (const v of violations) {
    const { annotation, gateError } = formatViolationMessages(v, headBaseline)
    console.log(annotation)
    console.error(gateError)
  }
  const listed = changes.filter(
    (c) =>
      headBaseline.files[c.path] !== undefined ||
      headBaseline.cssFiles?.[c.path] !== undefined ||
      headBaseline.yellowZoneFiles?.[c.path] !== undefined ||
      headBaseline.orangeZoneFiles?.[c.path] !== undefined,
  )
  console.log(
    `file-size ratchet: ${changes.length} changed source files, ${listed.length} on the baseline, ${violations.length} violations, ${problemErrors} blocking exception problems`,
  )
  for (const c of listed) {
    const b = (headBaseline.files[c.path] ??
      headBaseline.cssFiles?.[c.path] ??
      headBaseline.yellowZoneFiles?.[c.path] ??
      headBaseline.orangeZoneFiles?.[c.path]) as number
    console.log(`  ${c.path}: ${c.head} lines (baseline ${b}, cap ${b})`)
    if (c.head < b)
      console.log('    shrank below its baseline: run --update-baseline in this PR to lock it in')
  }
  return violations.length + problemErrors > 0 ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)))
}
