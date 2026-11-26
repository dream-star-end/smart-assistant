/**
 * Debt TTL Decay Ratchet & Auto Debt-First Feature Freeze Gate (OCV5-906).
 *
 * Reads `arch/debt-ttl-policy.json` and evaluates:
 *   1. Monthly/quarterly baseline decay targets against `arch/violations-baseline.json`
 *      (total violations & `R2-*` structural coupling) and `.github/file-size-baseline.json`.
 *   2. Active debt TTL expirations across `.github/file-size-ratchet-exceptions.json`,
 *      `deploy/v5/feature-flags-registry.json`, and `policy.ttlPolicy.debtExemptions`.
 *   3. Rolling 2-week git rework ratio (`fix` + `bug` commit share) across two consecutive
 *      7-day windows (`week1` = [-14d, -7d), `week2` = [-7d, 0d]).
 *   4. Automatic `debt_first` mode transition with hysteresis:
 *        - Before `effectiveFrom` (grace window): advisory only (`effectiveMode = 'autonomous'`,
 *          unless external mode file explicitly pins a stricter mode).
 *        - On/after `effectiveFrom`:
 *            Trigger `debt_first`: (week1 > 40% AND week2 > 40%) OR expiredTtlCount >= threshold.
 *            Release `debt_first`: week2 < 30% AND twoWeekRatio < 30% AND expiredTtlCount === 0.
 *   5. Commit prefix gate (`--check-commit-prefix <msg>`): blocks `feat` in `debt_first` mode
 *      and allows `bug/fix/refactor/chore/ci/docs/perf/test/revert`.
 *
 * Usage:
 *   npx tsx scripts/check-debt-ttl.ts [--status] [--enforce] [--json]
 *     [--check-commit-prefix "<msg>"] [--today YYYY-MM-DD] [--root <dir>]
 *     [--policy <rel>] [--mode-file <path>]
 *
 * Exit: 0 ok, 1 policy violation / freeze block, 2 usage/IO error.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const DEFAULT_POLICY_PATH = 'arch/debt-ttl-policy.json'
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86_400_000

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

export interface CommitRecord {
  subject: string
  timestampMs: number
}

export interface WeekReworkWindow {
  total: number
  rework: number
  ratio: number
}

export interface ReworkStats {
  week1: WeekReworkWindow
  week2: WeekReworkWindow
  twoWeekTotal: number
  twoWeekRework: number
  twoWeekRatio: number
  consecutiveTwoWeeksOverTrigger: boolean
}

export interface ExpiredTtlItem {
  source: string
  id: string
  expiresAt: string
  overdueDays: number
  owner?: string
  ticket?: string
}

export interface TtlScanSummary {
  totalTracked: number
  expiredCount: number
  expiredItems: ExpiredTtlItem[]
}

export interface BaselineDecayStatus {
  monthsElapsed: number
  violationsTotal: number
  violationsAllowedMax: number
  violationsOnTrack: boolean
  r2Total: number
  r2AllowedMax: number
  r2OnTrack: boolean
  redFilesCount: number
  redFilesAllowedMax: number
  redFilesOnTrack: boolean
  totalTrackedLines: number
  totalTrackedLinesAllowedMax: number
  totalTrackedLinesOnTrack: boolean
  allOnTrack: boolean
}

export interface DebtTtlEvaluation {
  schema: 1
  today: string
  anchorDate: string
  effectiveFrom: string
  inGraceWindow: boolean
  externalMode: GovernorMode | null
  recommendedMode: GovernorMode
  effectiveMode: GovernorMode
  triggerReasons: string[]
  releaseBlockedReasons: string[]
  rework: ReworkStats
  ttl: TtlScanSummary
  decay: BaselineDecayStatus
  commitCheck?: {
    message: string
    prefix: string | null
    allowed: boolean
    reason: string
  }
}

export function parseIsoDateMs(dateStr: string): number {
  if (!ISO_DATE_RE.test(dateStr)) return Number.NaN
  const ms = Date.parse(`${dateStr}T00:00:00Z`)
  if (!Number.isFinite(ms)) return Number.NaN
  return new Date(ms).toISOString().slice(0, 10) === dateStr ? ms : Number.NaN
}

export function loadPolicy(root: string, policyRel = DEFAULT_POLICY_PATH): DebtTtlPolicy {
  const abs = path.join(root, policyRel)
  if (!existsSync(abs)) {
    throw new Error(`missing policy file: ${policyRel}`)
  }
  const raw = JSON.parse(readFileSync(abs, 'utf8')) as DebtTtlPolicy
  if (!raw || raw.schema !== 1) {
    throw new Error(`invalid policy schema in ${policyRel} (expected schema=1)`)
  }
  if (!Number.isFinite(parseIsoDateMs(raw.anchorDate))) {
    throw new Error(`invalid anchorDate in ${policyRel}: ${String(raw.anchorDate)}`)
  }
  if (!Number.isFinite(parseIsoDateMs(raw.effectiveFrom))) {
    throw new Error(`invalid effectiveFrom in ${policyRel}: ${String(raw.effectiveFrom)}`)
  }
  return raw
}

/** Extracts conventional commit prefix (e.g. `feat(v5): ...` -> `feat`, `bug(v5):` -> `bug`). */
export function classifyCommitPrefix(subject: string): string | null {
  const trimmed = subject.trim()
  const m = /^([a-z][a-z0-9_-]*)(?:\([^)]*\))?!?:\s*/i.exec(trimmed)
  return m ? m[1]!.toLowerCase() : null
}

export function computeWeeklyReworkStats(
  commits: readonly CommitRecord[],
  today: string,
  reworkPrefixes: readonly string[],
  triggerRatio: number,
): ReworkStats {
  const todayEndMs = parseIsoDateMs(today) + DAY_MS
  const week2StartMs = todayEndMs - 7 * DAY_MS
  const week1StartMs = todayEndMs - 14 * DAY_MS
  const reworkSet = new Set(reworkPrefixes.map((p) => p.toLowerCase()))

  let w1Total = 0
  let w1Rework = 0
  let w2Total = 0
  let w2Rework = 0

  for (const c of commits) {
    if (c.timestampMs < week1StartMs || c.timestampMs >= todayEndMs) continue
    // Exclude automated merge commits from conventional rework denominator.
    if (/^Merge\s+(pull request|branch|remote-tracking)/i.test(c.subject.trim())) continue
    const prefix = classifyCommitPrefix(c.subject)
    const isRework = prefix !== null && reworkSet.has(prefix)
    if (c.timestampMs >= week2StartMs) {
      w2Total += 1
      if (isRework) w2Rework += 1
    } else {
      w1Total += 1
      if (isRework) w1Rework += 1
    }
  }

  const w1Ratio = w1Total > 0 ? w1Rework / w1Total : 0
  const w2Ratio = w2Total > 0 ? w2Rework / w2Total : 0
  const twoWeekTotal = w1Total + w2Total
  const twoWeekRework = w1Rework + w2Rework
  const twoWeekRatio = twoWeekTotal > 0 ? twoWeekRework / twoWeekTotal : 0

  return {
    week1: { total: w1Total, rework: w1Rework, ratio: w1Ratio },
    week2: { total: w2Total, rework: w2Rework, ratio: w2Ratio },
    twoWeekTotal,
    twoWeekRework,
    twoWeekRatio,
    consecutiveTwoWeeksOverTrigger:
      w1Total > 0 && w2Total > 0 && w1Ratio > triggerRatio && w2Ratio > triggerRatio,
  }
}

export function readGitCommitsWindow(root: string, today: string): CommitRecord[] {
  const todayEndMs = parseIsoDateMs(today) + DAY_MS
  const sinceIso = new Date(todayEndMs - 15 * DAY_MS).toISOString()
  const untilIso = new Date(todayEndMs).toISOString()
  try {
    const out = execFileSync(
      'git',
      [
        '-C',
        root,
        'log',
        '--no-merges',
        `--since=${sinceIso}`,
        `--until=${untilIso}`,
        '--format=%ct\t%s',
      ],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    const commits: CommitRecord[] = []
    for (const line of out.split('\n')) {
      if (!line.trim()) continue
      const tab = line.indexOf('\t')
      if (tab === -1) continue
      const sec = Number.parseInt(line.slice(0, tab), 10)
      const subject = line.slice(tab + 1)
      if (Number.isFinite(sec)) {
        commits.push({ subject, timestampMs: sec * 1000 })
      }
    }
    return commits
  } catch {
    return []
  }
}

export function scanExpiredDebtTtls(
  root: string,
  today: string,
  policy: DebtTtlPolicy,
): TtlScanSummary {
  const todayMs = parseIsoDateMs(today)
  const expiredItems: ExpiredTtlItem[] = []
  let totalTracked = 0

  const recordIfExpired = (item: {
    source: string
    id: string
    expiresAt: string
    owner?: string
    ticket?: string
  }) => {
    totalTracked += 1
    const expMs = parseIsoDateMs(item.expiresAt)
    if (Number.isFinite(expMs) && expMs < todayMs) {
      expiredItems.push({
        source: item.source,
        id: item.id,
        expiresAt: item.expiresAt,
        overdueDays: Math.floor((todayMs - expMs) / DAY_MS),
        owner: item.owner,
        ticket: item.ticket,
      })
    }
  }

  // 1. File-size ratchet exceptions (.github/file-size-ratchet-exceptions.json)
  const fsExcPath = path.join(root, policy.ttlPolicy.sources.fileSizeExceptions)
  if (existsSync(fsExcPath)) {
    const parsed = JSON.parse(readFileSync(fsExcPath, 'utf8'))
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (entry && typeof entry === 'object' && typeof entry.expires === 'string') {
          recordIfExpired({
            source: policy.ttlPolicy.sources.fileSizeExceptions,
            id: String(entry.path ?? 'unknown'),
            expiresAt: entry.expires,
            ticket: typeof entry.ticket === 'string' ? entry.ticket : undefined,
          })
        }
      }
    }
  }

  // 2. Temporary feature flags (deploy/v5/feature-flags-registry.json)
  const flagsPath = path.join(root, policy.ttlPolicy.sources.featureFlagsRegistry)
  if (existsSync(flagsPath)) {
    const parsed = JSON.parse(readFileSync(flagsPath, 'utf8')) as { flags?: unknown[] }
    if (Array.isArray(parsed?.flags)) {
      for (const flag of parsed.flags) {
        if (
          flag &&
          typeof flag === 'object' &&
          (flag as Record<string, unknown>).permanent === false &&
          typeof (flag as Record<string, unknown>).expireAt === 'string'
        ) {
          const f = flag as Record<string, unknown>
          recordIfExpired({
            source: policy.ttlPolicy.sources.featureFlagsRegistry,
            id: String(f.name ?? 'unknown'),
            expiresAt: f.expireAt as string,
            owner: typeof f.owner === 'string' ? f.owner : undefined,
            ticket: typeof f.ticket === 'string' ? f.ticket : undefined,
          })
        }
      }
    }
  }

  // 3. Explicit debtExemptions in policy
  for (const ex of policy.ttlPolicy.debtExemptions ?? []) {
    if (ex && typeof ex.expiresAt === 'string') {
      recordIfExpired({
        source: DEFAULT_POLICY_PATH,
        id: ex.id,
        expiresAt: ex.expiresAt,
        owner: ex.owner,
        ticket: ex.ticket,
      })
    }
  }

  return {
    totalTracked,
    expiredCount: expiredItems.length,
    expiredItems,
  }
}

export function computeBaselineDecayStatus(
  root: string,
  today: string,
  policy: DebtTtlPolicy,
): BaselineDecayStatus {
  const todayMs = parseIsoDateMs(today)
  const effectiveMs = parseIsoDateMs(policy.effectiveFrom)
  const anchorMs = parseIsoDateMs(policy.anchorDate)
  // Full 30-day cycles elapsed since anchorDate (0 while before effectiveFrom).
  const monthsElapsed =
    todayMs < effectiveMs ? 0 : Math.max(0, Math.floor((todayMs - anchorMs) / (30 * DAY_MS)))
  const quartersElapsed = Math.floor(monthsElapsed / 3)

  const vSpec = policy.decayTargets.violationsBaseline
  let violationsTotal = vSpec.anchorTotal
  let r2Total = vSpec.anchorR2Total
  const vAbs = path.join(root, vSpec.path)
  if (existsSync(vAbs)) {
    const raw = JSON.parse(readFileSync(vAbs, 'utf8')) as { entries?: Record<string, number> }
    violationsTotal = 0
    r2Total = 0
    for (const [k, count] of Object.entries(raw.entries ?? {})) {
      if (typeof count !== 'number') continue
      violationsTotal += count
      if (k.startsWith('R2-')) r2Total += count
    }
  }

  const violationsAllowedMax = Math.floor(
    vSpec.anchorTotal * (1 - vSpec.monthlyTotalDecayRate) ** monthsElapsed,
  )
  const r2AllowedMax = Math.floor(
    vSpec.anchorR2Total * (1 - vSpec.monthlyR2DecayRate) ** monthsElapsed,
  )

  const fSpec = policy.decayTargets.fileSizeBaseline
  let redFilesCount = fSpec.anchorRedFiles
  let totalTrackedLines = fSpec.anchorTotalTrackedLines
  const fAbs = path.join(root, fSpec.path)
  if (existsSync(fAbs)) {
    const raw = JSON.parse(readFileSync(fAbs, 'utf8')) as {
      files?: Record<string, number>
      cssFiles?: Record<string, number>
      yellowZoneFiles?: Record<string, number>
    }
    const sumMap = (m?: Record<string, number>) =>
      Object.values(m ?? {}).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0)
    redFilesCount = Object.keys(raw.files ?? {}).length
    totalTrackedLines = sumMap(raw.files) + sumMap(raw.cssFiles) + sumMap(raw.yellowZoneFiles)
  }

  const redFilesAllowedMax = Math.max(
    0,
    fSpec.anchorRedFiles - fSpec.monthlyRedFileReduction * monthsElapsed,
  )
  const totalTrackedLinesAllowedMax = Math.floor(
    fSpec.anchorTotalTrackedLines * (1 - fSpec.quarterlyTotalLinesDecayRate) ** quartersElapsed,
  )

  const violationsOnTrack = violationsTotal <= violationsAllowedMax
  const r2OnTrack = r2Total <= r2AllowedMax
  const redFilesOnTrack = redFilesCount <= redFilesAllowedMax
  const totalTrackedLinesOnTrack = totalTrackedLines <= totalTrackedLinesAllowedMax

  return {
    monthsElapsed,
    violationsTotal,
    violationsAllowedMax,
    violationsOnTrack,
    r2Total,
    r2AllowedMax,
    r2OnTrack,
    redFilesCount,
    redFilesAllowedMax,
    redFilesOnTrack,
    totalTrackedLines,
    totalTrackedLinesAllowedMax,
    totalTrackedLinesOnTrack,
    allOnTrack:
      violationsOnTrack && r2OnTrack && redFilesOnTrack && totalTrackedLinesOnTrack,
  }
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
  const blocked = new Set(policy.debtFirstPolicy.blockedPrefixesInDebtFirst.map((p) => p.toLowerCase()))
  const allowed = new Set(policy.debtFirstPolicy.allowedPrefixesInDebtFirst.map((p) => p.toLowerCase()))

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

export function evaluateDebtTtlPolicy(opts: {
  root: string
  policy: DebtTtlPolicy
  today: string
  commits?: readonly CommitRecord[]
  externalMode?: GovernorMode | null
  commitMessage?: string
}): DebtTtlEvaluation {
  const todayMs = parseIsoDateMs(opts.today)
  if (!Number.isFinite(todayMs)) {
    throw new Error(`invalid --today date: ${opts.today} (expected YYYY-MM-DD)`)
  }
  const effectiveMs = parseIsoDateMs(opts.policy.effectiveFrom)
  const inGraceWindow = todayMs < effectiveMs

  const commits = opts.commits ?? readGitCommitsWindow(opts.root, opts.today)
  const rework = computeWeeklyReworkStats(
    commits,
    opts.today,
    opts.policy.debtFirstPolicy.reworkPrefixes,
    opts.policy.debtFirstPolicy.triggerReworkRatio,
  )
  const ttl = scanExpiredDebtTtls(opts.root, opts.today, opts.policy)
  const decay = computeBaselineDecayStatus(opts.root, opts.today, opts.policy)

  const triggerReasons: string[] = []
  if (rework.consecutiveTwoWeeksOverTrigger) {
    triggerReasons.push(
      `consecutive 2-week rework ratio exceeded ${Math.round(opts.policy.debtFirstPolicy.triggerReworkRatio * 100)}% (week1=${(rework.week1.ratio * 100).toFixed(1)}%, week2=${(rework.week2.ratio * 100).toFixed(1)}%)`,
    )
  }
  if (ttl.expiredCount >= opts.policy.ttlPolicy.debtFirstExpiredThreshold) {
    triggerReasons.push(
      `expired debt TTL items (${ttl.expiredCount}) >= threshold (${opts.policy.ttlPolicy.debtFirstExpiredThreshold})`,
    )
  }

  const releaseBlockedReasons: string[] = []
  const releaseCutoff = opts.policy.debtFirstPolicy.releaseReworkRatio
  if (rework.week2.ratio >= releaseCutoff || rework.twoWeekRatio >= releaseCutoff) {
    releaseBlockedReasons.push(
      `rework ratio not yet below ${Math.round(releaseCutoff * 100)}% (week2=${(rework.week2.ratio * 100).toFixed(1)}%, 14d=${(rework.twoWeekRatio * 100).toFixed(1)}%)`,
    )
  }
  if (ttl.expiredCount > 0) {
    releaseBlockedReasons.push(`expired debt TTL items must reach 0 (current=${ttl.expiredCount})`)
  }

  const externalMode = opts.externalMode ?? null
  let recommendedMode: GovernorMode = 'autonomous'

  if (externalMode === 'emergency_stop') {
    recommendedMode = 'emergency_stop'
  } else if (externalMode === 'debt_first') {
    // Hysteresis: remain in debt_first until BOTH release criteria are satisfied.
    recommendedMode = releaseBlockedReasons.length === 0 ? 'autonomous' : 'debt_first'
  } else if (triggerReasons.length > 0) {
    recommendedMode = 'debt_first'
  }

  // Effective enforcement mode:
  //   - Explicit external `emergency_stop` or `debt_first` from host control plane always stays enforced
  //     until unlocked (while `recommendedMode` signals when release criteria are met).
  //   - During initial grace window (today < effectiveFrom), autonomous mode is not auto-locked.
  //   - On/after effectiveFrom, auto-trigger escalates autonomous -> debt_first immediately.
  const effectiveMode: GovernorMode =
    externalMode === 'emergency_stop'
      ? 'emergency_stop'
      : externalMode === 'debt_first'
        ? 'debt_first'
        : inGraceWindow
          ? 'autonomous'
          : recommendedMode

  const commitCheck =
    opts.commitMessage !== undefined
      ? checkCommitPrefixAllowed(opts.commitMessage, effectiveMode, opts.policy)
      : undefined

  return {
    schema: 1,
    today: opts.today,
    anchorDate: opts.policy.anchorDate,
    effectiveFrom: opts.policy.effectiveFrom,
    inGraceWindow,
    externalMode,
    recommendedMode,
    effectiveMode,
    triggerReasons,
    releaseBlockedReasons,
    rework,
    ttl,
    decay,
    ...(commitCheck ? { commitCheck } : {}),
  }
}

function formatHumanReport(ev: DebtTtlEvaluation): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`
  const lines = [
    `[debt-ttl] today=${ev.today} anchor=${ev.anchorDate} effectiveFrom=${ev.effectiveFrom} graceWindow=${ev.inGraceWindow}`,
    `[debt-ttl] mode: external=${ev.externalMode ?? 'none'} recommended=${ev.recommendedMode} effective=${ev.effectiveMode}`,
    `[debt-ttl] rework(14d): week1=${ev.rework.week1.rework}/${ev.rework.week1.total} (${pct(ev.rework.week1.ratio)}) week2=${ev.rework.week2.rework}/${ev.rework.week2.total} (${pct(ev.rework.week2.ratio)}) total=${ev.rework.twoWeekRework}/${ev.rework.twoWeekTotal} (${pct(ev.rework.twoWeekRatio)})`,
    `[debt-ttl] ttl: tracked=${ev.ttl.totalTracked} expired=${ev.ttl.expiredCount}`,
    `[debt-ttl] decay(months=${ev.decay.monthsElapsed}): violations=${ev.decay.violationsTotal}/${ev.decay.violationsAllowedMax} r2=${ev.decay.r2Total}/${ev.decay.r2AllowedMax} redFiles=${ev.decay.redFilesCount}/${ev.decay.redFilesAllowedMax} trackedLines=${ev.decay.totalTrackedLines}/${ev.decay.totalTrackedLinesAllowedMax} onTrack=${ev.decay.allOnTrack}`,
  ]
  if (ev.triggerReasons.length > 0) {
    lines.push(`[debt-ttl] triggerSignals: ${ev.triggerReasons.join('; ')}`)
  }
  if (ev.commitCheck) {
    lines.push(
      `[debt-ttl] commitPrefix: allowed=${ev.commitCheck.allowed} prefix=${ev.commitCheck.prefix ?? 'none'} (${ev.commitCheck.reason})`,
    )
  }
  return lines.join('\n')
}

export function main(argv: string[]): number {
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  let policyRel = DEFAULT_POLICY_PATH
  let today = new Date().toISOString().slice(0, 10)
  let enforce = false
  let jsonOut = false
  let modeFile: string | undefined = process.env.OC_GOVERNOR_MODE_FILE
  let commitMessage: string | undefined

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === '--status') {
      // Explicit status mode (default read-only summary, exit 0)
    } else if (arg === '--enforce') {
      enforce = true
    } else if (arg === '--json') {
      jsonOut = true
    } else if (arg === '--root') {
      root = path.resolve(argv[++i] ?? '')
    } else if (arg === '--policy') {
      policyRel = argv[++i] ?? DEFAULT_POLICY_PATH
    } else if (arg === '--today') {
      today = argv[++i] ?? ''
    } else if (arg === '--mode-file') {
      modeFile = argv[++i] ?? ''
    } else if (arg === '--check-commit-prefix') {
      commitMessage = argv[++i] ?? ''
    } else {
      console.error(`[debt-ttl] unknown argument: ${arg}`)
      return 2
    }
  }

  let policy: DebtTtlPolicy
  try {
    policy = loadPolicy(root, policyRel)
  } catch (err) {
    console.error(`[debt-ttl] ${(err as Error).message}`)
    return 2
  }

  const externalMode = readExternalModeFile(modeFile ?? policy.debtFirstPolicy.defaultModeFile)
  let evaluation: DebtTtlEvaluation
  try {
    evaluation = evaluateDebtTtlPolicy({
      root,
      policy,
      today,
      externalMode,
      commitMessage,
    })
  } catch (err) {
    console.error(`[debt-ttl] ${(err as Error).message}`)
    return 2
  }

  if (jsonOut) {
    console.log(JSON.stringify(evaluation, null, 2))
  } else {
    console.log(formatHumanReport(evaluation))
  }

  if (evaluation.commitCheck && !evaluation.commitCheck.allowed) {
    console.error(
      `[GATE-ERROR] DEBT-FIRST-FREEZE: ${evaluation.commitCheck.reason}`,
    )
    return 1
  }

  if (enforce && !evaluation.inGraceWindow) {
    const errors: string[] = []
    if (!evaluation.decay.allOnTrack) {
      errors.push(
        `baseline decay behind schedule (violations=${evaluation.decay.violationsTotal}/${evaluation.decay.violationsAllowedMax}, r2=${evaluation.decay.r2Total}/${evaluation.decay.r2AllowedMax}, redFiles=${evaluation.decay.redFilesCount}/${evaluation.decay.redFilesAllowedMax})`,
      )
    }
    if (evaluation.ttl.expiredCount > 0) {
      errors.push(`expired debt TTL items=${evaluation.ttl.expiredCount}`)
    }
    if (evaluation.effectiveMode !== 'autonomous') {
      errors.push(
        `effectiveMode=${evaluation.effectiveMode} (${evaluation.triggerReasons.join('; ') || 'debt_first active'})`,
      )
    }
    if (errors.length > 0) {
      console.error(`[GATE-ERROR] DEBT-TTL-ENFORCE: ${errors.join(' | ')}`)
      return 1
    }
  }

  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)))
}
