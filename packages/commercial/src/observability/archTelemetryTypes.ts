/**
 * OCV5-906 — Types & bounded circular RingBuffer for lightweight runtime architecture telemetry.
 */
export const ARCH_TELEMETRY_SCHEMA_VERSION = 1 as const
export const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

export const TELEMETRY_ASSET_KINDS = ['route', 'featureFlag', 'skill', 'cron'] as const
export type TelemetryAssetKind = (typeof TELEMETRY_ASSET_KINDS)[number]

export type RewriteFeedbackKind = 'rewrite' | 'resend' | 'abort_resend'

export interface ArchTelemetryOptions {
  maxKeysPerKind?: number
  maxRouteBudgetKeys?: number
  maxTrackedCommits?: number
  maxModulesPerCommit?: number
  ringBufferSize?: number
  zeroHitWindowMs?: number
  eventLoopResolutionMs?: number
  elWarnP99Ms?: number
  elMaxBlockMs?: number
  defaultMaxQueriesPerRequest?: number
  defaultMaxQueryDurationMs?: number
  minTurnsForRegression?: number
  regressionDeltaThreshold?: number
  baselineCommitWindow?: number
  onEventLoopAlert?: (alert: EventLoopBlockAlert) => void
  onQueryBudgetAlert?: (alert: QueryBudgetAlert) => void
}

export interface AssetRecord {
  kind: TelemetryAssetKind
  key: string
  registeredAt: number
  lastHitAt: number | null
  hits: number
  autoDiscovered: boolean
}

export interface DeadCandidate {
  kind: TelemetryAssetKind
  key: string
  registeredAt: string
  lastHitAt: string | null
  hits: number
  idleDays: number
  reason: 'never_hit_30d' | 'stale_30d'
}

export interface AssetKindSummary {
  registered: number
  hit: number
  zeroHitWindowCount: number
  droppedKeys: number
}

export interface DeadCandidatesReport {
  schemaVersion: typeof ARCH_TELEMETRY_SCHEMA_VERSION
  generatedAt: string
  windowDays: number
  byKind: Record<TelemetryAssetKind, AssetKindSummary>
  totals: AssetKindSummary
  deadCandidates: DeadCandidate[]
}

export interface EventLoopDelaySample {
  sampledAt: string
  p95Ms: number
  p99Ms: number
  maxMs: number
}

export interface EventLoopBlockAlert extends EventLoopDelaySample {
  reason: 'p99_exceeded' | 'max_exceeded' | 'p99_and_max_exceeded'
  warnP99Ms: number
  maxBlockThresholdMs: number
}

export interface RequestQueryBudgetContext {
  readonly route: string
  readonly startedAtMs: number
  readonly maxQueries: number
  readonly maxTotalDurationMs: number
  queryCount: number
  totalDurationMs: number
  maxSingleQueryMs: number
  alertFired: boolean
}

export interface QueryBudgetAlert {
  detectedAt: string
  route: string
  queryCount: number
  maxQueries: number
  totalDurationMs: number
  maxTotalDurationMs: number
  maxSingleQueryMs: number
  reason: 'n_plus_one_query_count' | 'query_duration_budget' | 'both'
}

export interface ImplicitFeedbackEvent {
  recordedAt: string
  sourceCommit: string
  module: string
  kind: RewriteFeedbackKind
}

export interface ModuleAttributionSummary {
  module: string
  turns: number
  rewriteResendCount: number
  rewriteResendRate: number | null
}

export interface CommitAttributionSummary {
  sourceCommit: string
  firstSeenAt: string
  lastSeenAt: string
  turns: number
  rewriteResendCount: number
  rewriteResendRate: number | null
  baselineRate: number | null
  deltaRate: number | null
  regressing: boolean
  regressionReason: string | null
  byModule: ModuleAttributionSummary[]
}

export interface ArchTelemetrySnapshot {
  schemaVersion: typeof ARCH_TELEMETRY_SCHEMA_VERSION
  generatedAt: string
  deadCode: DeadCandidatesReport
  eventLoop: {
    monitoring: boolean
    alertCount: number
    warnP99Ms: number
    maxBlockMs: number
    latestSample: EventLoopDelaySample | null
    recentAlerts: EventLoopBlockAlert[]
  }
  pgQueryBudget: {
    observedRequests: number
    observedQueries: number
    nPlusOneAlertCount: number
    durationBudgetAlertCount: number
    droppedRouteKeys: number
    offendersByRoute: Array<{ route: string; alerts: number; maxQueriesSeen: number }>
    recentAlerts: QueryBudgetAlert[]
  }
  commitAttribution: {
    trackedCommits: number
    evictedCommits: number
    droppedModules: number
    regressingCommits: string[]
    commits: CommitAttributionSummary[]
    recentEvents: ImplicitFeedbackEvent[]
  }
}

/** Fixed-capacity O(1) circular ring buffer with zero shifting allocations. */
export class RingBuffer<T> {
  private readonly buf: Array<T | undefined>
  private head = 0
  private count = 0

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`RingBuffer capacity must be >= 1, got ${capacity}`)
    }
    this.buf = new Array<T | undefined>(capacity)
  }

  push(item: T): void {
    const idx = (this.head + this.count) % this.capacity
    if (this.count < this.capacity) {
      this.buf[idx] = item
      this.count += 1
      return
    }
    this.buf[this.head] = item
    this.head = (this.head + 1) % this.capacity
  }

  toArray(): T[] {
    const out: T[] = []
    for (let i = 0; i < this.count; i++) {
      const item = this.buf[(this.head + i) % this.capacity]
      if (item !== undefined) out.push(item)
    }
    return out
  }

  get size(): number {
    return this.count
  }

  clear(): void {
    this.buf.fill(undefined)
    this.head = 0
    this.count = 0
  }
}
