/**
 * Large source file ratchet (FINDINGS §7 / ARC-3, Governance Blueprint §4.2 ③).
 *
 * .github/file-size-baseline.json governs:
 *   - `files`: pre-existing > `limit` (3,000) line monoliths (cap = baseline + `slack`);
 *   - `cssFiles`: pre-existing > `limit` CSS monoliths (e.g. `studio.css` 3,074 lines,
 *     cap = baseline + 0, strictly shrink-only);
 *   - `yellowZoneFiles` (`yellowZoneLimit` = 2,000, `yellowZoneSlack` = 0): frozen
 *     2,000–3,000 line production files (strictly shrink-only, prevents 2,999-line cliff
 *     piling!);
 *   - any other source file may not exceed `yellowZoneLimit` (when set) or `limit`;
 *   - the baseline only goes down: a PR may lower a number or drop an entry
 *     (after a split, run with --update-baseline), never raise or add one.
 *
 * A deliberate overrun goes in .github/file-size-ratchet-exceptions.json:
 *   { "path": "...", "maxLines": N, "ticket": "OCV5-123", "reason": "...", "expires": "YYYY-MM-DD" }
 * (unexpired, at most 30 days out; the PR diff shows it).
 *
 * Usage:
 *   npx tsx scripts/check-file-size-ratchet.ts                                (full working-tree check)
 *   npx tsx scripts/check-file-size-ratchet.ts --base <git-ref> [--head <ref>] (diff + baseline monotonic check)
 *   npx tsx scripts/check-file-size-ratchet.ts --update-baseline              (lowers only)
 * Exit: 0 ok, 1 violations, 2 usage/git error.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const MAX_EXCEPTION_DAYS = 30
export const BASELINE_PATH = '.github/file-size-baseline.json'
export const EXCEPTIONS_PATH = '.github/file-size-ratchet-exceptions.json'
const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs|sh|py|css)$/
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
    | 'new-over-limit'
    | 'new-over-yellow-zone'
    | 'baseline-raised'
}

export function isRatchetSource(file: string): boolean {
  return SOURCE.test(file) && !EXCLUDE.some((re) => re.test(file))
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

export function parseBaseline(raw: unknown): Baseline {
  const b = raw as Partial<Baseline>
  if (
    !b ||
    !Number.isInteger(b.limit) ||
    !Number.isInteger(b.slack) ||
    !isIntMap(b.files) ||
    (b.cssFiles !== undefined && !isIntMap(b.cssFiles)) ||
    (b.yellowZoneLimit !== undefined &&
      (!Number.isInteger(b.yellowZoneLimit) || (b.yellowZoneLimit as number) <= 0)) ||
    (b.yellowZoneSlack !== undefined &&
      (!Number.isInteger(b.yellowZoneSlack) || (b.yellowZoneSlack as number) < 0)) ||
    (b.yellowZoneFiles !== undefined && !isIntMap(b.yellowZoneFiles))
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
  const todayMs = Date.parse(`${today}T00:00:00Z`)
  for (const [i, e] of entries.entries()) {
    const x = e as Partial<Exception>
    const p = typeof x?.path === 'string' ? x.path : null
    const own: string[] = []
    if (!p || !Number.isInteger(x.maxLines) || (x.maxLines as number) <= 0)
      own.push('needs path and a positive integer maxLines')
    if (typeof x?.ticket !== 'string' || !/^OCV5-\d+$/.test(x.ticket))
      own.push('ticket must look like OCV5-123')
    if (typeof x?.reason !== 'string' || x.reason.trim().length < 10)
      own.push('reason must say why (>= 10 chars)')
    const exp =
      typeof x?.expires === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.expires)
        ? Date.parse(`${x.expires}T00:00:00Z`)
        : Number.NaN
    if (!Number.isFinite(exp)) own.push('expires must be YYYY-MM-DD')
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

/** Line caps for the checked files under the head baseline (+ exceptions). */
export function evaluate(
  changes: Array<{ path: string; head: number }>,
  baseline: Baseline,
  exceptions: Map<string, Exception>,
): Violation[] {
  const out: Violation[] = []
  const yellowSlack = baseline.yellowZoneSlack ?? 0
  for (const c of changes) {
    const ex = exceptions.get(c.path)
    const listedRed = baseline.files[c.path]
    if (listedRed !== undefined) {
      const allowed = listedRed + baseline.slack
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
      const allowed = listedYellow + yellowSlack
      if (c.head <= allowed || (ex && c.head <= ex.maxLines)) continue
      out.push({ path: c.path, head: c.head, allowed, kind: 'over-yellow-zone' })
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
    }
  }
  return out
}

/** The baseline only goes down: no new entries, no raised numbers, same/tighter limit/slack. */
export function baselineRaises(base: Baseline, head: Baseline): Violation[] {
  const out: Violation[] = []
  if (head.limit > base.limit || head.slack > base.slack) {
    out.push({
      path: BASELINE_PATH,
      head: head.slack,
      allowed: base.slack,
      kind: 'baseline-raised',
    })
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
    out.push({
      path: BASELINE_PATH,
      head: head.slack,
      allowed: base.yellowZoneSlack,
      kind: 'baseline-raised',
    })
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
        // Allow lowering a red (>3000) file down into yellow zone; forbid any raise or new entry.
        const allowedPrev = wasYellow !== undefined ? wasYellow : wasRed
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
    // A missing path is an expected answer here (new file, first baseline); keep git quiet.
    return execFileSync('git', ['-C', root, 'show', `${ref}:${file}`], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
}

function updateBaseline(root: string): number {
  const file = path.join(root, BASELINE_PATH)
  const b = parseBaseline(JSON.parse(readFileSync(file, 'utf8')))
  const nextFiles: Record<string, number> = {}
  const nextYellow: Record<string, number> | undefined = b.yellowZoneFiles ? {} : undefined

  for (const [p, was] of Object.entries(b.files)) {
    let now: number
    try {
      now = lineCount(readFileSync(path.join(root, p), 'utf8'))
    } catch {
      continue // file removed
    }
    if (now > b.limit) nextFiles[p] = Math.min(was, now)
    else if (nextYellow && b.yellowZoneLimit !== undefined && now >= b.yellowZoneLimit) {
      nextYellow[p] = Math.min(was, now)
    }
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
      if (now > b.limit) nextCss[p] = Math.min(was, now)
      else if (nextYellow && b.yellowZoneLimit !== undefined && now >= b.yellowZoneLimit) {
        nextYellow[p] = Math.min(was, now)
      }
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
      if (now >= yLimit) nextYellow[p] = Math.min(was, now)
    }
  }

  const updated: Baseline = {
    ...b,
    files: nextFiles,
    ...(nextCss !== undefined ? { cssFiles: nextCss } : {}),
    ...(nextYellow !== undefined
      ? {
          yellowZoneFiles: Object.fromEntries(
            Object.entries(nextYellow).sort(([a], [bKey]) => (a < bKey ? -1 : a > bKey ? 1 : 0)),
          ),
        }
      : {}),
  }
  writeFileSync(file, `${JSON.stringify(updated, null, 2)}\n`)
  console.log(
    `baseline: ${Object.keys(b.files).length} -> ${Object.keys(nextFiles).length} files (lowered only)`,
  )
  return 0
}

function formatViolationMessages(v: Violation, headBaseline: Baseline): {
  annotation: string
  gateError: string
} {
  const isCss = headBaseline.cssFiles?.[v.path] !== undefined
  const msg =
    v.kind === 'over-baseline'
      ? `${v.path} has ${v.head} lines; its cap is ${v.allowed} (${isCss ? 'CSS baseline, shrink-only' : `baseline + ${headBaseline.slack}`}). Move code out of it, or add a dated exception (scripts/check-file-size-ratchet.ts).`
      : v.kind === 'over-yellow-zone'
        ? `${v.path} has ${v.head} lines; yellow-zone frozen cap is ${v.allowed} (2,000–3,000 line freeze, net growth <= 0). Extract cohesive helper/hook/sub-module instead of growing toward the 3,000-line cliff.`
        : v.kind === 'new-over-yellow-zone'
          ? `${v.path} has ${v.head} lines (>= yellow-zone limit ${headBaseline.yellowZoneLimit}). Split into domain modules before crossing 2,000 lines, or add a dated exception.`
          : v.kind === 'new-over-limit'
            ? `${v.path} has ${v.head} lines (> ${headBaseline.limit}). Split it, or add a dated exception.`
            : `${v.path}: the size baseline may only go down (was ${v.allowed}, now ${v.head}).`
  const fileRef = v.kind === 'baseline-raised' ? BASELINE_PATH : v.path
  const gateError = [
    `[GATE-ERROR] FILE-SIZE-RATCHET (${v.kind}) at ${fileRef}`,
    `  Violation : ${msg}`,
    '  Why       : Large monoliths and 2,999-line cliff files degrade modularity and agent edit reliability (Blueprint §4.2 ③).',
    `  How to Fix: Extract cohesive domain helpers/hooks/stylesheets to stay <= ${v.allowed} lines (run \`npx tsx scripts/check-file-size-ratchet.ts --update-baseline\` after shrinking), or add a <=30d dated exception in ${EXCEPTIONS_PATH} (CODEOWNERS-approved).`,
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

  // Full working-tree check when --base is omitted
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
      console.log(`::warning file=${EXCEPTIONS_PATH}::${p.message}`)
    }
    for (const v of violations) {
      const { annotation, gateError } = formatViolationMessages(v, headBaseline)
      console.log(annotation)
      console.error(gateError)
    }
    console.log(
      `file-size ratchet (worktree): ${entries.length} source files scanned, ${Object.keys(headBaseline.files).length} red + ${Object.keys(headBaseline.cssFiles ?? {}).length} css + ${Object.keys(headBaseline.yellowZoneFiles ?? {}).length} yellow-zone baselined, ${violations.length} violations`,
    )
    return violations.length > 0 ? 1 : 0
  }

  let names: string[]
  try {
    // -z: NUL-separated, unquoted paths. Without it git quotes and escapes
    // non-ASCII names, the quoted name fails the extension filter, and the
    // file skips the check.
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
  if (baseBaselineText !== null)
    violations.push(...baselineRaises(parseBaseline(JSON.parse(baseBaselineText)), headBaseline))

  const changes = names
    .filter(isRatchetSource)
    .map((p) => ({ path: p, head: lineCount(fileAt(root, head, p) ?? '') }))
  let rawEx: unknown = []
  const exText = fileAt(root, head, EXCEPTIONS_PATH)
  if (exText !== null) rawEx = JSON.parse(exText)
  const { ok, problems } = validateExceptions(rawEx, today)
  violations.push(...evaluate(changes, headBaseline, ok))

  // A broken or expired exception fails only the PR that touches its file or the
  // exceptions file; elsewhere it warns, so one stale entry cannot block every PR.
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
      headBaseline.yellowZoneFiles?.[c.path] !== undefined,
  )
  console.log(
    `file-size ratchet: ${changes.length} changed source files, ${listed.length} on the baseline, ${violations.length} violations, ${problemErrors} blocking exception problems`,
  )
  for (const c of listed) {
    const isRed = headBaseline.files[c.path] !== undefined
    const isCss = headBaseline.cssFiles?.[c.path] !== undefined
    const b = (headBaseline.files[c.path] ??
      headBaseline.cssFiles?.[c.path] ??
      headBaseline.yellowZoneFiles?.[c.path]) as number
    const cap = isRed ? b + headBaseline.slack : isCss ? b : b + (headBaseline.yellowZoneSlack ?? 0)
    console.log(`  ${c.path}: ${c.head} lines (baseline ${b}, cap ${cap})`)
    if (c.head < b)
      console.log('    shrank below its baseline: run --update-baseline in this PR to lock it in')
  }
  return violations.length + problemErrors > 0 ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)))
}
