/**
 * Large source file ratchet (FINDINGS §7 / ARC-3, user decision 2026-10-16:
 * fixed baseline + small allowance).
 *
 * .github/file-size-baseline.json lists every source file that had more than
 * `limit` lines when the ratchet started, with its line count then.
 *   - a listed file may never exceed its baseline + `slack` lines (a total cap,
 *     not per PR: small fixes fit, steady growth does not);
 *   - any other source file may not exceed `limit` lines;
 *   - the baseline only goes down: a PR may lower a number or drop an entry
 *     (after a split, run with --update-baseline), never raise or add one.
 * A deliberate overrun goes in .github/file-size-ratchet-exceptions.json:
 *   { "path": "...", "maxLines": N, "ticket": "OCV5-123", "reason": "...", "expires": "YYYY-MM-DD" }
 * (unexpired, at most 30 days out; the PR diff shows it).
 *
 * Usage:
 *   npx tsx scripts/check-file-size-ratchet.ts --base <git-ref> [--head <git-ref>]
 *   npx tsx scripts/check-file-size-ratchet.ts --update-baseline   (lowers only)
 * Exit: 0 ok, 1 violations, 2 usage/git error.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const MAX_EXCEPTION_DAYS = 30
export const BASELINE_PATH = '.github/file-size-baseline.json'
export const EXCEPTIONS_PATH = '.github/file-size-ratchet-exceptions.json'
const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs|sh|py)$/
const EXCLUDE = [
  /(^|\/)(node_modules|dist|dist-types|vendor|__fixtures__|fixtures|__snapshots__|generated)\//,
  /\.d\.ts$/,
  /\.min\.js$/,
  /(^|\/)__tests__\//,
  /\.(test|spec|integ\.test|node-test)\.[cm]?[jt]sx?$/,
  /^claude-code-best\//,
]

export type Baseline = { limit: number; slack: number; files: Record<string, number> }
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
  kind: 'over-baseline' | 'new-over-limit' | 'baseline-raised'
}

export function isRatchetSource(file: string): boolean {
  return SOURCE.test(file) && !EXCLUDE.some((re) => re.test(file))
}

export function lineCount(text: string): number {
  if (text === '') return 0
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

export function parseBaseline(raw: unknown): Baseline {
  const b = raw as Partial<Baseline>
  if (
    !b ||
    !Number.isInteger(b.limit) ||
    !Number.isInteger(b.slack) ||
    typeof b.files !== 'object' ||
    b.files === null ||
    Object.values(b.files).some((n) => !Number.isInteger(n))
  ) {
    throw new Error(`${BASELINE_PATH} must be {limit, slack, files: {path: lines}}`)
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

/** Line caps for the changed files under the head baseline (+ exceptions). */
export function evaluate(
  changes: Array<{ path: string; head: number }>,
  baseline: Baseline,
  exceptions: Map<string, Exception>,
): Violation[] {
  const out: Violation[] = []
  for (const c of changes) {
    const listed = baseline.files[c.path]
    const allowed = listed !== undefined ? listed + baseline.slack : baseline.limit
    const ex = exceptions.get(c.path)
    if (c.head <= allowed || (ex && c.head <= ex.maxLines)) continue
    out.push({
      path: c.path,
      head: c.head,
      allowed,
      kind: listed !== undefined ? 'over-baseline' : 'new-over-limit',
    })
  }
  return out
}

/** The baseline only goes down: no new entries, no raised numbers, same limit/slack. */
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
  const next: Record<string, number> = {}
  for (const [p, was] of Object.entries(b.files)) {
    let now: number
    try {
      now = lineCount(readFileSync(path.join(root, p), 'utf8'))
    } catch {
      continue // file removed
    }
    if (now > b.limit) next[p] = Math.min(was, now)
  }
  writeFileSync(file, `${JSON.stringify({ ...b, files: next }, null, 2)}\n`)
  console.log(
    `baseline: ${Object.keys(b.files).length} -> ${Object.keys(next).length} files (lowered only)`,
  )
  return 0
}

function main(argv: string[]): number {
  let base = ''
  let head = 'HEAD'
  let update = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') base = argv[++i] ?? ''
    else if (argv[i] === '--head') head = argv[++i] ?? ''
    else if (argv[i] === '--update-baseline') update = true
    else {
      console.error(`unknown arg: ${argv[i]}`)
      return 2
    }
  }
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim()
  if (update) return updateBaseline(root)
  if (!base) {
    console.error('--base is required')
    return 2
  }
  let names: string[]
  try {
    names = git(root, ['diff', '--name-only', '--diff-filter=AMR', `${base}...${head}`])
      .split('\n')
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
  const today = new Date().toISOString().slice(0, 10)
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
    const msg =
      v.kind === 'over-baseline'
        ? `${v.path} has ${v.head} lines; its cap is ${v.allowed} (baseline + ${headBaseline.slack}). Move code out of it, or add a dated exception (scripts/check-file-size-ratchet.ts).`
        : v.kind === 'new-over-limit'
          ? `${v.path} has ${v.head} lines (> ${headBaseline.limit}). Split it, or add a dated exception.`
          : `${v.path}: the size baseline may only go down (was ${v.allowed}, now ${v.head}).`
    console.log(`::error file=${v.kind === 'baseline-raised' ? BASELINE_PATH : v.path}::${msg}`)
  }
  const listed = changes.filter((c) => headBaseline.files[c.path] !== undefined)
  console.log(
    `file-size ratchet: ${changes.length} changed source files, ${listed.length} on the baseline, ${violations.length} violations, ${problemErrors} blocking exception problems`,
  )
  for (const c of listed) {
    const b = headBaseline.files[c.path] as number
    console.log(`  ${c.path}: ${c.head} lines (baseline ${b}, cap ${b + headBaseline.slack})`)
    if (c.head < b)
      console.log(`    shrank below its baseline: run --update-baseline in this PR to lock it in`)
  }
  return violations.length + problemErrors > 0 ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)))
}
