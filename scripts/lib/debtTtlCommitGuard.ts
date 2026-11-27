/**
 * Commit-prefix enforcement & net debt-paydown helpers for `scripts/check-debt-ttl.ts` (OCV5-906 / OCV5-903 B9).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

export const DEFAULT_POLICY_PATH = 'arch/debt-ttl-policy.json'
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export type GovernorMode = 'autonomous' | 'debt_first' | 'emergency_stop'

export interface DebtExemptionEntry {
  id: string
  owner: string
  reason: string
  ticket?: string
  expiresAt: string
}

export interface DebtTtlPolicy {
  schema: number
  note?: string
  anchorDate: string
  effectiveFrom: string
  decayTargets: {
    violationsBaseline: {
      path: string
      anchorTotal: number
      anchorR2Total: number
      monthlyTotalDecayRate: number
      quarterlyTotalDecayRate: number
      monthlyR2DecayRate: number
      quarterlyR2DecayRate: number
    }
    fileSizeBaseline: {
      path: string
      anchorRedFiles: number
      anchorCssFiles: number
      anchorYellowFiles: number
      anchorTotalTrackedLines: number
      monthlyRedFileReduction: number
      quarterlyTotalLinesDecayRate: number
    }
  }
  ttlPolicy: {
    maxExceptionDays: number
    debtFirstExpiredThreshold: number
    sources: {
      fileSizeExceptions: string
      featureFlagsRegistry: string
    }
    debtExemptions: DebtExemptionEntry[]
  }
  debtFirstPolicy: {
    windowWeeks: number
    triggerReworkRatio: number
    releaseReworkRatio: number
    reworkPrefixes: string[]
    blockedPrefixesInDebtFirst: string[]
    allowedPrefixesInDebtFirst: string[]
    defaultModeFile?: string
  }
}

export interface DebtPaydownSnapshot {
  ttl: { expiredCount: number }
  decay: {
    violationsTotal: number
    r2Total: number
    redFilesCount: number
    totalTrackedLines: number
  }
}

export function parseIsoDateMs(dateStr: string): number {
  if (!ISO_DATE_RE.test(dateStr)) return Number.NaN
  const ms = Date.parse(`${dateStr}T00:00:00Z`)
  if (!Number.isFinite(ms)) return Number.NaN
  return new Date(ms).toISOString().slice(0, 10) === dateStr ? ms : Number.NaN
}

/** Extracts conventional commit prefix (e.g. `feat(v5): ...` -> `feat`, `bug(v5):` -> `bug`). */
export function classifyCommitPrefix(subject: string): string | null {
  const trimmed = subject.trim()
  const m = /^([a-z][a-z0-9_-]*)(?:\([^)]*\))?!?:\s*/i.exec(trimmed)
  return m ? m[1]!.toLowerCase() : null
}

export function readExternalModeFile(modeFilePath?: string): GovernorMode | null {
  if (!modeFilePath || !existsSync(modeFilePath)) return null
  try {
    const parsed = JSON.parse(readFileSync(modeFilePath, 'utf8')) as { mode?: unknown }
    if (
      parsed.mode === 'autonomous' ||
      parsed.mode === 'debt_first' ||
      parsed.mode === 'emergency_stop'
    ) {
      return parsed.mode
    }
  } catch {
    return null
  }
  return null
}

export function checkCommitPrefixAllowed(
  message: string,
  effectiveMode: GovernorMode,
  policy: DebtTtlPolicy,
): { message: string; prefix: string | null; allowed: boolean; reason: string } {
  const firstLine = message.split('\n')[0]!.trim()
  const prefix = classifyCommitPrefix(firstLine)

  if (effectiveMode === 'emergency_stop') {
    return {
      message: firstLine,
      prefix,
      allowed: false,
      reason: 'emergency_stop mode active — all automated merges blocked',
    }
  }
  if (effectiveMode === 'autonomous') {
    return {
      message: firstLine,
      prefix,
      allowed: true,
      reason: 'autonomous mode — commit prefix permitted',
    }
  }

  // debt_first mode: block `feat` (and any unknown prefix outside allowed list)
  const blocked = new Set(
    policy.debtFirstPolicy.blockedPrefixesInDebtFirst.map((p) => p.toLowerCase()),
  )
  const allowed = new Set(
    policy.debtFirstPolicy.allowedPrefixesInDebtFirst.map((p) => p.toLowerCase()),
  )

  if (prefix !== null && blocked.has(prefix)) {
    return {
      message: firstLine,
      prefix,
      allowed: false,
      reason: `debt_first feature freeze active: "${prefix}" commits are blocked until rework < ${Math.round(policy.debtFirstPolicy.releaseReworkRatio * 100)}% and expired TTLs === 0`,
    }
  }
  if (prefix !== null && allowed.has(prefix)) {
    return {
      message: firstLine,
      prefix,
      allowed: true,
      reason: `debt_first mode permits maintenance/fix prefix "${prefix}"`,
    }
  }
  return {
    message: firstLine,
    prefix,
    allowed: false,
    reason: `debt_first mode only permits prefixes [${policy.debtFirstPolicy.allowedPrefixesInDebtFirst.join(', ')}]`,
  }
}

export function checkCommitSubjectsAllowed(
  messages: readonly string[],
  effectiveMode: GovernorMode,
  policy: DebtTtlPolicy,
): {
  message: string
  prefix: string | null
  allowed: boolean
  reason: string
  checkedCommits: number
} {
  if (effectiveMode === 'emergency_stop') {
    const first = messages[0]?.split('\n')[0]?.trim() ?? ''
    return {
      message: first,
      prefix: first ? classifyCommitPrefix(first) : null,
      allowed: false,
      reason: 'emergency_stop mode active — all automated merges and forward deploys blocked',
      checkedCommits: messages.length,
    }
  }
  if (effectiveMode === 'autonomous') {
    const first = messages[0]?.split('\n')[0]?.trim() ?? ''
    return {
      message: first,
      prefix: first ? classifyCommitPrefix(first) : null,
      allowed: true,
      reason: 'autonomous mode — commit prefix permitted',
      checkedCommits: messages.length,
    }
  }
  if (messages.length === 0) {
    return {
      message: '',
      prefix: null,
      allowed: false,
      reason:
        'debt_first mode requires a verified commit subject (pass --check-commit-prefix or --base/--head in a git repo)',
      checkedCommits: 0,
    }
  }

  let lastOk: { message: string; prefix: string | null; allowed: boolean; reason: string } | null =
    null
  for (const msg of messages) {
    const res = checkCommitPrefixAllowed(msg, effectiveMode, policy)
    if (!res.allowed) {
      return { ...res, checkedCommits: messages.length }
    }
    lastOk = res
  }
  return {
    ...(lastOk ?? {
      message: '',
      prefix: null,
      allowed: true,
      reason: 'debt_first mode permits maintenance commits',
    }),
    checkedCommits: messages.length,
  }
}

export function readCommitSubjectsForCheck(
  root: string,
  baseRef?: string,
  headRef = 'HEAD',
): string[] {
  const runGitLog = (args: string[]): string[] | null => {
    const r = spawnSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    })
    if (r.status !== 0) return null
    return r.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  }

  if (baseRef) {
    const rangeCommits = runGitLog(['log', '--no-merges', '--format=%s', `${baseRef}..${headRef}`])
    if (rangeCommits && rangeCommits.length > 0) return rangeCommits
  }
  const headCommit = runGitLog(['log', '-1', '--format=%s', headRef])
  return headCommit ?? []
}

function readGitJsonAt<T>(root: string, ref: string, relPath: string): T | null {
  const r = spawnSync('git', ['-C', root, 'show', `${ref}:${relPath}`], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  if (r.status !== 0) return null
  try {
    return JSON.parse(r.stdout) as T
  } catch {
    return null
  }
}

/**
 * Check if a maintenance commit in `debt_first` mode strictly pays down expired TTLs or
 * behind-schedule baselines compared to `baseRef` (without regressing any tracked counter).
 */
export function isNetDebtPayingCommit(
  root: string,
  baseRef: string,
  today: string,
  policy: DebtTtlPolicy,
  current: DebtPaydownSnapshot,
): boolean {
  const todayMs = parseIsoDateMs(today)
  let baseExpired = 0
  const baseFsExc = readGitJsonAt<Array<{ expires?: string }>>(
    root,
    baseRef,
    policy.ttlPolicy.sources.fileSizeExceptions,
  )
  if (Array.isArray(baseFsExc)) {
    for (const e of baseFsExc) {
      const ms = typeof e?.expires === 'string' ? parseIsoDateMs(e.expires) : Number.NaN
      if (Number.isFinite(ms) && ms < todayMs) baseExpired += 1
    }
  }
  const baseFlags = readGitJsonAt<{ flags?: Array<{ permanent?: unknown; expireAt?: unknown }> }>(
    root,
    baseRef,
    policy.ttlPolicy.sources.featureFlagsRegistry,
  )
  if (Array.isArray(baseFlags?.flags)) {
    for (const f of baseFlags.flags) {
      if (f?.permanent === false && typeof f.expireAt === 'string') {
        const ms = parseIsoDateMs(f.expireAt)
        if (Number.isFinite(ms) && ms < todayMs) baseExpired += 1
      }
    }
  }
  const basePolicy = readGitJsonAt<DebtTtlPolicy>(root, baseRef, DEFAULT_POLICY_PATH)
  for (const ex of basePolicy?.ttlPolicy?.debtExemptions ?? []) {
    const ms = typeof ex?.expiresAt === 'string' ? parseIsoDateMs(ex.expiresAt) : Number.NaN
    if (Number.isFinite(ms) && ms < todayMs) baseExpired += 1
  }

  let baseViolations = current.decay.violationsTotal
  let baseR2 = current.decay.r2Total
  const baseV = readGitJsonAt<{ entries?: Record<string, number> }>(
    root,
    baseRef,
    policy.decayTargets.violationsBaseline.path,
  )
  if (baseV?.entries) {
    baseViolations = 0
    baseR2 = 0
    for (const [k, v] of Object.entries(baseV.entries)) {
      if (typeof v !== 'number') continue
      baseViolations += v
      if (k.startsWith('R2-')) baseR2 += v
    }
  }

  let baseRedFiles = current.decay.redFilesCount
  let baseTrackedLines = current.decay.totalTrackedLines
  const baseF = readGitJsonAt<{
    files?: Record<string, number>
    cssFiles?: Record<string, number>
    yellowZoneFiles?: Record<string, number>
  }>(root, baseRef, policy.decayTargets.fileSizeBaseline.path)
  if (baseF) {
    const sumMap = (m?: Record<string, number>) =>
      Object.values(m ?? {}).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0)
    baseRedFiles = Object.keys(baseF.files ?? {}).length
    baseTrackedLines = sumMap(baseF.files) + sumMap(baseF.cssFiles) + sumMap(baseF.yellowZoneFiles)
  }

  const noRegressions =
    current.ttl.expiredCount <= baseExpired &&
    current.decay.violationsTotal <= baseViolations &&
    current.decay.r2Total <= baseR2 &&
    current.decay.redFilesCount <= baseRedFiles &&
    current.decay.totalTrackedLines <= baseTrackedLines

  const strictlyReduced =
    current.ttl.expiredCount < baseExpired ||
    current.decay.violationsTotal < baseViolations ||
    current.decay.r2Total < baseR2 ||
    current.decay.redFilesCount < baseRedFiles ||
    current.decay.totalTrackedLines < baseTrackedLines

  return noRegressions && strictlyReduced
}
