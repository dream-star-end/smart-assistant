/**
 * OCV5-906 — Shared types & low-level helpers for the Weekly 4-Signal Governance Cockpit Digest.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'

export type TrafficLight = 'GREEN' | 'AMBER' | 'RED' | 'N/A'

export interface CockpitCliOptions {
  date: string
  offline: boolean
  outJson: string | null
  outMd: string | null
  repoRoot: string | null
  leaseDb: string | null
  harnessResultsDir: string | null
  governorRoot: string | null
  selfevolveReportDir: string | null
  archTelemetryJson: string | null
  costReportJson: string | null
  stewardReceiptDir: string | null
  envFile: string
  help: boolean
}

export interface StructureAndReworkGauge {
  status: TrafficLight
  rework14d: {
    fixBugCommits: number | 'N/A'
    totalCommits: number | 'N/A'
    ratio: number | 'N/A'
    status: TrafficLight
  }
  prodLoc7d: { added: number | 'N/A'; deleted: number | 'N/A'; netDelta: number | 'N/A' }
  archViolations: {
    total: number | 'N/A'
    r2Total: number | 'N/A'
    netDelta7d: number | 'N/A'
    r2NetDelta7d: number | 'N/A'
  }
  top10GodFiles: {
    trackedCount: number | 'N/A'
    totalLines: number | 'N/A'
    netDelta7d: number | 'N/A'
    grownCount: number | 'N/A'
  }
  expiredDebtTtlCount: number | 'N/A'
  notes: string[]
}

export interface DeliveryAndExperienceGauge {
  status: TrafficLight
  trainPassRate7d: {
    committed: number | 'N/A'
    terminalTotal: number | 'N/A'
    rate: number | 'N/A'
    baseline: number
    target: number
    status: TrafficLight
  }
  trainPassRate30d: { committed: number | 'N/A'; terminalTotal: number | 'N/A'; rate: number | 'N/A' }
  weeklyRollbacks: number | 'N/A'
  retentionLatest: {
    stamp: string | 'N/A'
    passed: number | 'N/A'
    total: number | 'N/A'
    ok: boolean | 'N/A'
    summary: string
  }
  implicitNegativeTrend: {
    current7d: number | 'N/A'
    previous7d: number | 'N/A'
    delta: number | 'N/A'
    regressingCommits: string[]
    summary: string
  }
  notes: string[]
}

export interface ComputeAndWasteGauge {
  status: TrafficLight
  weeklyConsumption: { totalCredits: number | 'N/A'; totalUsd: number | 'N/A'; source: string }
  dailySpike: {
    maxDailyValue: number | 'N/A'
    medianDailyValue: number | 'N/A'
    spikeRatio: number | 'N/A'
    spikeDetected: boolean | 'N/A'
    peakDate: string | 'N/A'
  }
  waste: {
    failedTrains7d: number | 'N/A'
    totalTrains7d: number | 'N/A'
    failedTrainRatio: number | 'N/A'
    failedDurationShare: number | 'N/A'
    retryWasteRatio: number | 'N/A'
  }
  costBreakerTripped: boolean | 'N/A'
  notes: string[]
}

export interface MetaGuardrailIntegrityGauge {
  status: TrafficLight
  a0Audit7d: {
    interceptedAttempts: number | 'N/A'
    approvedRelaxations: number | 'N/A'
    tamperedApprovals: number | 'N/A'
  }
  stewardSignoff7d: {
    totalReceipts: number | 'N/A'
    validCrossFamilyApprovals: number | 'N/A'
    vetoOrInvalid: number | 'N/A'
    signoffRate: number | 'N/A'
  }
  commercialBranchZeroTouch: {
    branch: 'feat/v5-aurora-rewrite'
    confirmedZeroUnauthorized: boolean | 'N/A'
    blockedAttempts7d: number | 'N/A'
    detail: string
  }
  governorMode: string
  notes: string[]
}

export interface GovernanceCockpitDigest {
  schemaVersion: 1
  generatedAt: string
  asOfDate: string
  offline: boolean
  overallStatus: TrafficLight
  gauges: {
    structureAndRework: StructureAndReworkGauge
    deliveryAndExperience: DeliveryAndExperienceGauge
    computeAndWaste: ComputeAndWasteGauge
    metaGuardrailIntegrity: MetaGuardrailIntegrityGauge
  }
}

export interface PgComputeData {
  dailyCredits: Array<{ day: string; credits: number }>
  totalCredits: number
  retryOrFailedCredits: number
}

export interface TrainRow {
  id: string
  status: string
  reason: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  updated_at: string
}

const LIGHT_RANK: Record<TrafficLight, number> = { 'N/A': 0, GREEN: 1, AMBER: 2, RED: 3 }

export function worstLight(lights: TrafficLight[]): TrafficLight {
  let best: TrafficLight = 'N/A'
  for (const l of lights) {
    if (LIGHT_RANK[l] > LIGHT_RANK[best]) best = l
  }
  return best
}

export function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000
}

export function fmtPct(v: number | 'N/A'): string {
  return typeof v === 'number' ? `${(v * 100).toFixed(1)}%` : 'N/A'
}

export function fmtNum(v: number | 'N/A'): string {
  return typeof v === 'number' ? String(v) : 'N/A'
}

export function fmtSigned(v: number | 'N/A'): string {
  if (typeof v !== 'number') return 'N/A'
  return v > 0 ? `+${v}` : String(v)
}

export function badge(light: TrafficLight): string {
  if (light === 'GREEN') return '🟢 GREEN'
  if (light === 'AMBER') return '🟡 AMBER'
  if (light === 'RED') return '🔴 RED'
  return '⚪ N/A'
}

export function windowBoundsIso(date: string, days: number): { sinceIso: string; untilIso: string } {
  const untilMs = Date.parse(`${date}T23:59:59Z`) + 1000
  return {
    sinceIso: new Date(untilMs - days * 86_400_000).toISOString(),
    untilIso: new Date(untilMs).toISOString(),
  }
}

export function safeGit(repoRoot: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-c', 'safe.directory=*', '-C', repoRoot, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    })
  } catch {
    return null
  }
}

export function safeReadJson<T = Record<string, unknown>>(filePath: string | null): T | null {
  if (!filePath || !existsSync(filePath)) return null
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T
  } catch {
    return null
  }
}

export function querySqliteJson<T>(dbPath: string, sql: string): T[] | null {
  if (!existsSync(dbPath)) return null
  try {
    const out = execFileSync(
      'sqlite3',
      ['-readonly', '-cmd', '.timeout 3000', '-json', dbPath, sql],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 },
    ).trim()
    return out ? (JSON.parse(out) as T[]) : []
  } catch {
    return null
  }
}

export function readJsonl(filePath: string): Array<Record<string, unknown>> {
  if (!existsSync(filePath)) return []
  const out: Array<Record<string, unknown>> = []
  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const obj = JSON.parse(trimmed)
      if (obj && typeof obj === 'object') out.push(obj as Record<string, unknown>)
    } catch {
      // ignore malformed trailing line
    }
  }
  return out
}

export function verifyApprovalChecksum(doc: Record<string, unknown>): boolean {
  const expected = doc.sha256 ?? doc.payloadSha256
  if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected)) return false
  const canonicalV1 = `a0-approval-v1\nsha=${doc.sha ?? ''}\nissuedAt=${doc.issuedAt ?? ''}\nexpiresAt=${doc.expiresAt ?? ''}\nreason=${doc.reason ?? ''}\n`
  if (createHash('sha256').update(canonicalV1, 'utf8').digest('hex') === expected) return true
  const legacy = `${doc.sha ?? ''}|${doc.issuedAt ?? ''}|${doc.expiresAt ?? ''}|${doc.reason ?? ''}`
  return createHash('sha256').update(legacy, 'utf8').digest('hex') === expected
}
