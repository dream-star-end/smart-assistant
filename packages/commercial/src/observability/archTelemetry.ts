/**
 * OCV5-906 — Lightweight in-process architecture & dead-code runtime telemetry.
 *
 * Design invariants:
 *   1. Ultra-low overhead on hot paths: O(1) Map lookups & fixed-capacity circular ring buffers.
 *   2. Hard memory bounds: fixed key caps per asset kind, route, and commit/module bucket prevent
 *      cardinality explosion or OOM under untrusted/high-cardinality inputs.
 *   3. Zero synchronous blocking I/O: all hot-path recording is pure in-memory; optional snapshot
 *      persistence uses `node:fs/promises` atomic rename (`writeFile` + `rename`).
 */
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { type IntervalHistogram, monitorEventLoopDelay, performance } from 'node:perf_hooks'
import {
  ARCH_TELEMETRY_SCHEMA_VERSION,
  type ArchTelemetryOptions,
  type ArchTelemetrySnapshot,
  type AssetKindSummary,
  type AssetRecord,
  type CommitAttributionSummary,
  type DeadCandidate,
  type DeadCandidatesReport,
  type EventLoopBlockAlert,
  type EventLoopDelaySample,
  type ImplicitFeedbackEvent,
  type ModuleAttributionSummary,
  type QueryBudgetAlert,
  type RequestQueryBudgetContext,
  type RewriteFeedbackKind,
  RingBuffer,
  TELEMETRY_ASSET_KINDS,
  THIRTY_DAYS_MS,
  type TelemetryAssetKind,
} from './archTelemetryTypes.js'

export {
  ARCH_TELEMETRY_SCHEMA_VERSION,
  RingBuffer,
  TELEMETRY_ASSET_KINDS,
  THIRTY_DAYS_MS,
  type ArchTelemetryOptions,
  type ArchTelemetrySnapshot,
  type AssetKindSummary,
  type AssetRecord,
  type CommitAttributionSummary,
  type DeadCandidate,
  type DeadCandidatesReport,
  type EventLoopBlockAlert,
  type EventLoopDelaySample,
  type ImplicitFeedbackEvent,
  type ModuleAttributionSummary,
  type QueryBudgetAlert,
  type RequestQueryBudgetContext,
  type RewriteFeedbackKind,
  type TelemetryAssetKind,
}

interface CommitBucket {
  sourceCommit: string
  firstSeenAt: number
  lastSeenAt: number
  turns: number
  rewriteResendCount: number
  modules: Map<string, { turns: number; rewriteResendCount: number }>
}

interface RouteOffenderStat {
  alerts: number
  maxQueriesSeen: number
}

function roundMetric(val: number): number {
  return Math.round(val * 1000) / 1000
}

function nsToMs(ns: number): number {
  if (!Number.isFinite(ns) || ns < 0) return 0
  return roundMetric(ns / 1_000_000)
}

function sanitizeKey(raw: string, fallback: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return fallback
  return trimmed.length > 160 ? trimmed.slice(0, 160) : trimmed
}

export class ArchTelemetryCollector {
  private readonly maxKeysPerKind: number
  private readonly maxRouteBudgetKeys: number
  private readonly maxTrackedCommits: number
  private readonly maxModulesPerCommit: number
  private readonly zeroHitWindowMs: number
  private readonly eventLoopResolutionMs: number
  private readonly elWarnP99Ms: number
  private readonly elMaxBlockMs: number
  private readonly defaultMaxQueriesPerRequest: number
  private readonly defaultMaxQueryDurationMs: number
  private readonly minTurnsForRegression: number
  private readonly regressionDeltaThreshold: number
  private readonly baselineCommitWindow: number
  private readonly onEventLoopAlert?: (alert: EventLoopBlockAlert) => void
  private readonly onQueryBudgetAlert?: (alert: QueryBudgetAlert) => void

  private readonly assets: Record<TelemetryAssetKind, Map<string, AssetRecord>> = {
    route: new Map(),
    featureFlag: new Map(),
    skill: new Map(),
    cron: new Map(),
  }
  private readonly droppedKeysByKind: Record<TelemetryAssetKind, number> = {
    route: 0,
    featureFlag: 0,
    skill: 0,
    cron: 0,
  }

  private histogram: IntervalHistogram | null = null
  private sampleTimer: ReturnType<typeof setInterval> | null = null
  private elAlertCount = 0
  private latestElSample: EventLoopDelaySample | null = null
  private readonly elAlerts: RingBuffer<EventLoopBlockAlert>

  private observedRequests = 0
  private observedQueries = 0
  private nPlusOneAlertCount = 0
  private durationBudgetAlertCount = 0
  private droppedRouteKeys = 0
  private readonly routeOffenders = new Map<string, RouteOffenderStat>()
  private readonly queryAlerts: RingBuffer<QueryBudgetAlert>

  private evictedCommits = 0
  private droppedModules = 0
  private readonly commits = new Map<string, CommitBucket>()
  private readonly feedbackEvents: RingBuffer<ImplicitFeedbackEvent>

  constructor(opts: ArchTelemetryOptions = {}) {
    this.maxKeysPerKind = Math.max(1, opts.maxKeysPerKind ?? 2048)
    this.maxRouteBudgetKeys = Math.max(1, opts.maxRouteBudgetKeys ?? 512)
    this.maxTrackedCommits = Math.max(2, opts.maxTrackedCommits ?? 256)
    this.maxModulesPerCommit = Math.max(1, opts.maxModulesPerCommit ?? 64)
    this.zeroHitWindowMs = Math.max(1, opts.zeroHitWindowMs ?? THIRTY_DAYS_MS)
    this.eventLoopResolutionMs = Math.max(1, opts.eventLoopResolutionMs ?? 20)
    this.elWarnP99Ms = Math.max(1, opts.elWarnP99Ms ?? 100)
    this.elMaxBlockMs = Math.max(1, opts.elMaxBlockMs ?? 200)
    this.defaultMaxQueriesPerRequest = Math.max(1, opts.defaultMaxQueriesPerRequest ?? 25)
    this.defaultMaxQueryDurationMs = Math.max(1, opts.defaultMaxQueryDurationMs ?? 500)
    this.minTurnsForRegression = Math.max(1, opts.minTurnsForRegression ?? 10)
    this.regressionDeltaThreshold = Math.max(0.001, opts.regressionDeltaThreshold ?? 0.05)
    this.baselineCommitWindow = Math.max(1, opts.baselineCommitWindow ?? 3)
    this.onEventLoopAlert = opts.onEventLoopAlert
    this.onQueryBudgetAlert = opts.onQueryBudgetAlert

    const ringSize = Math.max(4, opts.ringBufferSize ?? 256)
    this.elAlerts = new RingBuffer<EventLoopBlockAlert>(ringSize)
    this.queryAlerts = new RingBuffer<QueryBudgetAlert>(ringSize)
    this.feedbackEvents = new RingBuffer<ImplicitFeedbackEvent>(ringSize * 2)
  }

  registerAsset(kind: TelemetryAssetKind, rawKey: string, nowMs = Date.now()): boolean {
    const key = sanitizeKey(rawKey, '')
    if (!key) return false
    const bucket = this.assets[kind]
    const existing = bucket.get(key)
    if (existing) {
      if (nowMs < existing.registeredAt) existing.registeredAt = nowMs
      existing.autoDiscovered = false
      return true
    }
    if (bucket.size >= this.maxKeysPerKind) {
      this.droppedKeysByKind[kind] += 1
      return false
    }
    bucket.set(key, {
      kind,
      key,
      registeredAt: nowMs,
      lastHitAt: null,
      hits: 0,
      autoDiscovered: false,
    })
    return true
  }

  registerAssets(kind: TelemetryAssetKind, keys: Iterable<string>, nowMs = Date.now()): number {
    let added = 0
    for (const k of keys) {
      if (this.registerAsset(kind, k, nowMs)) added += 1
    }
    return added
  }

  recordAssetHit(kind: TelemetryAssetKind, rawKey: string, nowMs = Date.now()): boolean {
    const key = sanitizeKey(rawKey, '')
    if (!key) return false
    const bucket = this.assets[kind]
    const existing = bucket.get(key)
    if (existing) {
      existing.hits += 1
      if (existing.lastHitAt === null || nowMs > existing.lastHitAt) existing.lastHitAt = nowMs
      return true
    }
    if (bucket.size >= this.maxKeysPerKind) {
      this.droppedKeysByKind[kind] += 1
      return false
    }
    bucket.set(key, {
      kind,
      key,
      registeredAt: nowMs,
      lastHitAt: nowMs,
      hits: 1,
      autoDiscovered: true,
    })
    return true
  }

  exportDeadCandidates(
    nowMs = Date.now(),
    windowMs = this.zeroHitWindowMs,
  ): DeadCandidatesReport {
    const deadCandidates: DeadCandidate[] = []
    const byKind = {} as Record<TelemetryAssetKind, AssetKindSummary>
    const totals: AssetKindSummary = { registered: 0, hit: 0, zeroHitWindowCount: 0, droppedKeys: 0 }

    for (const kind of TELEMETRY_ASSET_KINDS) {
      const summary: AssetKindSummary = {
        registered: this.assets[kind].size,
        hit: 0,
        zeroHitWindowCount: 0,
        droppedKeys: this.droppedKeysByKind[kind],
      }
      for (const rec of this.assets[kind].values()) {
        if (rec.hits > 0) summary.hit += 1
        const idleMs = nowMs - (rec.lastHitAt ?? rec.registeredAt)
        if (idleMs >= windowMs) {
          summary.zeroHitWindowCount += 1
          deadCandidates.push({
            kind: rec.kind,
            key: rec.key,
            registeredAt: new Date(rec.registeredAt).toISOString(),
            lastHitAt: rec.lastHitAt !== null ? new Date(rec.lastHitAt).toISOString() : null,
            hits: rec.hits,
            idleDays: roundMetric(idleMs / 86_400_000),
            reason: rec.lastHitAt === null ? 'never_hit_30d' : 'stale_30d',
          })
        }
      }
      byKind[kind] = summary
      totals.registered += summary.registered
      totals.hit += summary.hit
      totals.zeroHitWindowCount += summary.zeroHitWindowCount
      totals.droppedKeys += summary.droppedKeys
    }

    deadCandidates.sort(
      (a, b) =>
        b.idleDays - a.idleDays || a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key),
    )

    return {
      schemaVersion: ARCH_TELEMETRY_SCHEMA_VERSION,
      generatedAt: new Date(nowMs).toISOString(),
      windowDays: roundMetric(windowMs / 86_400_000),
      byKind,
      totals,
      deadCandidates,
    }
  }

  startEventLoopMonitor(autoSampleIntervalMs = 0): void {
    if (!this.histogram) {
      this.histogram = monitorEventLoopDelay({ resolution: this.eventLoopResolutionMs })
      this.histogram.enable()
    }
    if (autoSampleIntervalMs > 0 && !this.sampleTimer) {
      this.sampleTimer = setInterval(() => {
        this.sampleEventLoopDelay()
      }, autoSampleIntervalMs)
      this.sampleTimer.unref()
    }
  }

  stopEventLoopMonitor(): void {
    if (this.sampleTimer) {
      clearInterval(this.sampleTimer)
      this.sampleTimer = null
    }
    if (this.histogram) {
      this.histogram.disable()
      this.histogram = null
    }
  }

  sampleEventLoopDelay(nowMs = Date.now()): EventLoopDelaySample | null {
    if (!this.histogram) return null
    if (this.histogram.count === 0) {
      const empty = { sampledAt: new Date(nowMs).toISOString(), p95Ms: 0, p99Ms: 0, maxMs: 0 }
      this.latestElSample = empty
      return empty
    }
    const baseNs = this.eventLoopResolutionMs * 1e6
    const p95Ms = Math.max(0, nsToMs(this.histogram.percentile(95) - baseNs))
    const p99Ms = Math.max(0, nsToMs(this.histogram.percentile(99) - baseNs))
    const maxMs = Math.max(0, nsToMs(this.histogram.max - baseNs))
    this.histogram.reset()
    return this.ingestEventLoopMetrics({ p95Ms, p99Ms, maxMs }, nowMs)
  }

  ingestEventLoopMetrics(
    metrics: { p95Ms: number; p99Ms: number; maxMs: number },
    nowMs = Date.now(),
  ): EventLoopDelaySample {
    const sample: EventLoopDelaySample = {
      sampledAt: new Date(nowMs).toISOString(),
      p95Ms: roundMetric(Math.max(0, metrics.p95Ms)),
      p99Ms: roundMetric(Math.max(0, metrics.p99Ms)),
      maxMs: roundMetric(Math.max(0, metrics.maxMs)),
    }
    this.latestElSample = sample
    const p99Bad = sample.p99Ms >= this.elWarnP99Ms
    const maxBad = sample.maxMs >= this.elMaxBlockMs
    if (p99Bad || maxBad) {
      this.elAlertCount += 1
      const alert: EventLoopBlockAlert = {
        ...sample,
        reason: p99Bad && maxBad ? 'p99_and_max_exceeded' : p99Bad ? 'p99_exceeded' : 'max_exceeded',
        warnP99Ms: this.elWarnP99Ms,
        maxBlockThresholdMs: this.elMaxBlockMs,
      }
      this.elAlerts.push(alert)
      this.onEventLoopAlert?.(alert)
    }
    return sample
  }

  beginRequestQueryBudget(
    rawRoute: string,
    overrides?: { maxQueries?: number; maxTotalDurationMs?: number },
  ): RequestQueryBudgetContext {
    this.observedRequests += 1
    return {
      route: sanitizeKey(rawRoute, '/unknown'),
      startedAtMs: performance.now(),
      maxQueries: Math.max(1, overrides?.maxQueries ?? this.defaultMaxQueriesPerRequest),
      maxTotalDurationMs: Math.max(
        1,
        overrides?.maxTotalDurationMs ?? this.defaultMaxQueryDurationMs,
      ),
      queryCount: 0,
      totalDurationMs: 0,
      maxSingleQueryMs: 0,
      alertFired: false,
    }
  }

  recordPgQuery(
    ctx: RequestQueryBudgetContext | null | undefined,
    durationMs: number,
    nowMs = Date.now(),
  ): void {
    const safeDuration = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0
    this.observedQueries += 1
    if (!ctx) return
    ctx.queryCount += 1
    ctx.totalDurationMs = roundMetric(ctx.totalDurationMs + safeDuration)
    if (safeDuration > ctx.maxSingleQueryMs) ctx.maxSingleQueryMs = roundMetric(safeDuration)
    this.trackRouteQueriesSeen(ctx.route, ctx.queryCount)

    const overCount = ctx.queryCount > ctx.maxQueries
    const overTime = ctx.totalDurationMs > ctx.maxTotalDurationMs
    if ((overCount || overTime) && !ctx.alertFired) {
      ctx.alertFired = true
      if (overCount) this.nPlusOneAlertCount += 1
      if (overTime) this.durationBudgetAlertCount += 1
      this.incrementRouteAlert(ctx.route, ctx.queryCount)
      const alert: QueryBudgetAlert = {
        detectedAt: new Date(nowMs).toISOString(),
        route: ctx.route,
        queryCount: ctx.queryCount,
        maxQueries: ctx.maxQueries,
        totalDurationMs: ctx.totalDurationMs,
        maxTotalDurationMs: ctx.maxTotalDurationMs,
        maxSingleQueryMs: ctx.maxSingleQueryMs,
        reason: overCount && overTime ? 'both' : overCount ? 'n_plus_one_query_count' : 'query_duration_budget',
      }
      this.queryAlerts.push(alert)
      this.onQueryBudgetAlert?.(alert)
    }
  }

  private trackRouteQueriesSeen(route: string, queryCount: number): void {
    const stat = this.routeOffenders.get(route)
    if (stat && queryCount > stat.maxQueriesSeen) stat.maxQueriesSeen = queryCount
  }

  private incrementRouteAlert(route: string, queryCount: number): void {
    const existing = this.routeOffenders.get(route)
    if (existing) {
      existing.alerts += 1
      if (queryCount > existing.maxQueriesSeen) existing.maxQueriesSeen = queryCount
      return
    }
    if (this.routeOffenders.size >= this.maxRouteBudgetKeys) {
      this.droppedRouteKeys += 1
      return
    }
    this.routeOffenders.set(route, { alerts: 1, maxQueriesSeen: queryCount })
  }

  recordCommitTurn(input: { sourceCommit: string; module: string; nowMs?: number }): void {
    const nowMs = input.nowMs ?? Date.now()
    const bucket = this.ensureCommitBucket(input.sourceCommit, nowMs)
    bucket.turns += 1
    const mod = this.ensureModuleBucket(bucket, input.module)
    if (mod) mod.turns += 1
  }

  recordUserRewriteResend(input: {
    sourceCommit: string
    module: string
    kind?: RewriteFeedbackKind
    countAsTurn?: boolean
    nowMs?: number
  }): void {
    const nowMs = input.nowMs ?? Date.now()
    const commitKey = sanitizeKey(input.sourceCommit, 'unknown')
    const moduleKey = sanitizeKey(input.module, 'unattributed')
    const kind = input.kind ?? 'rewrite'
    const bucket = this.ensureCommitBucket(commitKey, nowMs)
    if (input.countAsTurn) bucket.turns += 1
    bucket.rewriteResendCount += 1
    const mod = this.ensureModuleBucket(bucket, moduleKey)
    if (mod) {
      if (input.countAsTurn) mod.turns += 1
      mod.rewriteResendCount += 1
    }
    this.feedbackEvents.push({
      recordedAt: new Date(nowMs).toISOString(),
      sourceCommit: commitKey,
      module: moduleKey,
      kind,
    })
  }

  private ensureCommitBucket(rawCommit: string, nowMs: number): CommitBucket {
    const key = sanitizeKey(rawCommit, 'unknown')
    const existing = this.commits.get(key)
    if (existing) {
      if (nowMs > existing.lastSeenAt) existing.lastSeenAt = nowMs
      return existing
    }
    if (this.commits.size >= this.maxTrackedCommits) {
      const oldestKey = this.commits.keys().next().value
      if (oldestKey !== undefined) {
        this.commits.delete(oldestKey)
        this.evictedCommits += 1
      }
    }
    const created: CommitBucket = {
      sourceCommit: key,
      firstSeenAt: nowMs,
      lastSeenAt: nowMs,
      turns: 0,
      rewriteResendCount: 0,
      modules: new Map(),
    }
    this.commits.set(key, created)
    return created
  }

  private ensureModuleBucket(
    commit: CommitBucket,
    rawModule: string,
  ): { turns: number; rewriteResendCount: number } | null {
    const modKey = sanitizeKey(rawModule, 'unattributed')
    const existing = commit.modules.get(modKey)
    if (existing) return existing
    if (commit.modules.size >= this.maxModulesPerCommit) {
      this.droppedModules += 1
      return null
    }
    const created = { turns: 0, rewriteResendCount: 0 }
    commit.modules.set(modKey, created)
    return created
  }

  computeCommitAttribution(): CommitAttributionSummary[] {
    const ordered = [...this.commits.values()].sort(
      (a, b) => a.firstSeenAt - b.firstSeenAt || a.sourceCommit.localeCompare(b.sourceCommit),
    )
    const summaries: CommitAttributionSummary[] = []
    for (let i = 0; i < ordered.length; i++) {
      const cur = ordered[i]!
      const rate = cur.turns > 0 ? roundMetric(cur.rewriteResendCount / cur.turns) : null
      const baselineRate = this.computePriorBaselineRate(ordered, i)
      const deltaRate =
        rate !== null && baselineRate !== null ? roundMetric(rate - baselineRate) : null
      const regressing =
        cur.turns >= this.minTurnsForRegression &&
        deltaRate !== null &&
        deltaRate >= this.regressionDeltaThreshold

      const byModule: ModuleAttributionSummary[] = [...cur.modules.entries()]
        .map(([mod, m]) => ({
          module: mod,
          turns: m.turns,
          rewriteResendCount: m.rewriteResendCount,
          rewriteResendRate: m.turns > 0 ? roundMetric(m.rewriteResendCount / m.turns) : null,
        }))
        .sort(
          (a, b) =>
            b.rewriteResendCount - a.rewriteResendCount || a.module.localeCompare(b.module),
        )

      const topMod = byModule[0]?.module ?? 'unattributed'
      const regressionReason = regressing
        ? `rewrite/resend rate ${(rate! * 100).toFixed(1)}% vs baseline ${(baselineRate! * 100).toFixed(1)}% (+${(deltaRate! * 100).toFixed(1)}pp, top module: ${topMod})`
        : null

      summaries.push({
        sourceCommit: cur.sourceCommit,
        firstSeenAt: new Date(cur.firstSeenAt).toISOString(),
        lastSeenAt: new Date(cur.lastSeenAt).toISOString(),
        turns: cur.turns,
        rewriteResendCount: cur.rewriteResendCount,
        rewriteResendRate: rate,
        baselineRate,
        deltaRate,
        regressing,
        regressionReason,
        byModule,
      })
    }
    return summaries
  }

  private computePriorBaselineRate(ordered: CommitBucket[], index: number): number | null {
    let priorTurns = 0
    let priorRewrites = 0
    let taken = 0
    for (let j = index - 1; j >= 0 && taken < this.baselineCommitWindow; j--) {
      const prev = ordered[j]!
      if (prev.turns < this.minTurnsForRegression) continue
      priorTurns += prev.turns
      priorRewrites += prev.rewriteResendCount
      taken += 1
    }
    return priorTurns > 0 ? roundMetric(priorRewrites / priorTurns) : null
  }

  snapshot(nowMs = Date.now()): ArchTelemetrySnapshot {
    if (this.histogram && this.histogram.count > 0) this.sampleEventLoopDelay(nowMs)
    const deadCode = this.exportDeadCandidates(nowMs)
    const commits = this.computeCommitAttribution()
    const offendersByRoute = [...this.routeOffenders.entries()]
      .map(([route, s]) => ({ route, alerts: s.alerts, maxQueriesSeen: s.maxQueriesSeen }))
      .sort((a, b) => b.alerts - a.alerts || a.route.localeCompare(b.route))

    return {
      schemaVersion: ARCH_TELEMETRY_SCHEMA_VERSION,
      generatedAt: new Date(nowMs).toISOString(),
      deadCode,
      eventLoop: {
        monitoring: this.histogram !== null,
        alertCount: this.elAlertCount,
        warnP99Ms: this.elWarnP99Ms,
        maxBlockMs: this.elMaxBlockMs,
        latestSample: this.latestElSample,
        recentAlerts: this.elAlerts.toArray(),
      },
      pgQueryBudget: {
        observedRequests: this.observedRequests,
        observedQueries: this.observedQueries,
        nPlusOneAlertCount: this.nPlusOneAlertCount,
        durationBudgetAlertCount: this.durationBudgetAlertCount,
        droppedRouteKeys: this.droppedRouteKeys,
        offendersByRoute,
        recentAlerts: this.queryAlerts.toArray(),
      },
      commitAttribution: {
        trackedCommits: this.commits.size,
        evictedCommits: this.evictedCommits,
        droppedModules: this.droppedModules,
        regressingCommits: commits.filter((c) => c.regressing).map((c) => c.sourceCommit),
        commits,
        recentEvents: this.feedbackEvents.toArray(),
      },
    }
  }

  async exportSnapshotAsync(filePath: string, nowMs = Date.now()): Promise<ArchTelemetrySnapshot> {
    const snap = this.snapshot(nowMs)
    await mkdir(path.dirname(filePath), { recursive: true })
    const tmpPath = `${filePath}.tmp-${process.pid}-${nowMs}`
    await writeFile(tmpPath, `${JSON.stringify(snap, null, 2)}\n`, 'utf8')
    await rename(tmpPath, filePath)
    return snap
  }

  resetForTest(): void {
    this.stopEventLoopMonitor()
    for (const kind of TELEMETRY_ASSET_KINDS) {
      this.assets[kind].clear()
      this.droppedKeysByKind[kind] = 0
    }
    this.elAlertCount = 0
    this.latestElSample = null
    this.elAlerts.clear()
    this.observedRequests = 0
    this.observedQueries = 0
    this.nPlusOneAlertCount = 0
    this.durationBudgetAlertCount = 0
    this.droppedRouteKeys = 0
    this.routeOffenders.clear()
    this.queryAlerts.clear()
    this.evictedCommits = 0
    this.droppedModules = 0
    this.commits.clear()
    this.feedbackEvents.clear()
  }
}

export function createArchTelemetryCollector(
  opts: ArchTelemetryOptions = {},
): ArchTelemetryCollector {
  return new ArchTelemetryCollector(opts)
}

export const defaultArchTelemetry = new ArchTelemetryCollector()
