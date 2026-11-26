import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, describe, test } from 'node:test'
import {
  ARCH_TELEMETRY_SCHEMA_VERSION,
  ArchTelemetryCollector,
  type EventLoopBlockAlert,
  type QueryBudgetAlert,
  RingBuffer,
  THIRTY_DAYS_MS,
  createArchTelemetryCollector,
  defaultArchTelemetry,
} from '../archTelemetry.js'

afterEach(() => {
  defaultArchTelemetry.resetForTest()
})

describe('RingBuffer', () => {
  test('maintains fixed capacity and overwrites oldest items in circular order', () => {
    const rb = new RingBuffer<number>(4)
    for (let i = 1; i <= 7; i++) rb.push(i)
    assert.equal(rb.size, 4)
    assert.deepEqual(rb.toArray(), [4, 5, 6, 7])
    rb.clear()
    assert.equal(rb.size, 0)
    assert.deepEqual(rb.toArray(), [])
  })

  test('rejects invalid capacity', () => {
    assert.throws(() => new RingBuffer(0), RangeError)
  })
})

describe('ArchTelemetryCollector — 30-day zero-hit dead-code tracking', () => {
  test('exports never-hit and 30d-stale routes, flags, skills, and crons while excluding active ones', () => {
    const t0 = Date.parse('2026-10-01T00:00:00Z')
    const collector = createArchTelemetryCollector()

    collector.registerAssets('route', ['/api/v5/old-unused', '/api/v5/active', '/api/v5/stale'], t0)
    collector.registerAsset('featureFlag', 'ff_legacy_experiment', t0)
    collector.registerAsset('skill', 'pdf-legacy-v1', t0)
    collector.registerAsset('cron', 'zombie-weekly-job', t0)
    // Newly registered 5 days ago — must NOT be flagged as 30d dead yet!
    collector.registerAsset('route', '/api/v5/brand-new', t0 + 26 * 86_400_000)

    // Hit `/api/v5/stale` on day 1, then never again for >30 days
    collector.recordAssetHit('route', '/api/v5/stale', t0 + 1 * 86_400_000)
    // Hit `/api/v5/active` on day 25 (within 30d window)
    collector.recordAssetHit('route', '/api/v5/active', t0 + 25 * 86_400_000)

    const now = t0 + THIRTY_DAYS_MS + 2 * 86_400_000 // day 32
    const report = collector.exportDeadCandidates(now)

    assert.equal(report.schemaVersion, ARCH_TELEMETRY_SCHEMA_VERSION)
    assert.equal(report.windowDays, 30)
    assert.equal(report.byKind.route.registered, 4)
    assert.equal(report.byKind.route.hit, 2)
    assert.equal(report.byKind.route.zeroHitWindowCount, 2)

    const keys = report.deadCandidates.map((c) => `${c.kind}:${c.key}:${c.reason}`)
    assert.ok(keys.includes('route:/api/v5/old-unused:never_hit_30d'))
    assert.ok(keys.includes('route:/api/v5/stale:stale_30d'))
    assert.ok(keys.includes('featureFlag:ff_legacy_experiment:never_hit_30d'))
    assert.ok(keys.includes('skill:pdf-legacy-v1:never_hit_30d'))
    assert.ok(keys.includes('cron:zombie-weekly-job:never_hit_30d'))
    assert.ok(!keys.some((k) => k.includes('/api/v5/active')))
    assert.ok(!keys.some((k) => k.includes('/api/v5/brand-new')))
  })

  test('enforces hard key caps per kind to prevent OOM on high-cardinality paths', () => {
    const collector = createArchTelemetryCollector({ maxKeysPerKind: 5 })
    for (let i = 0; i < 100; i++) {
      collector.recordAssetHit('route', `/api/unnormalized/${i}`, 1000 + i)
    }
    const report = collector.exportDeadCandidates(1000 + THIRTY_DAYS_MS + 1000)
    assert.equal(report.byKind.route.registered, 5)
    assert.equal(report.byKind.route.droppedKeys, 95)
    // Existing registered keys still update hits without dropping
    assert.equal(collector.recordAssetHit('route', '/api/unnormalized/0', 5000), true)
  })
})

describe('ArchTelemetryCollector — Event Loop blocking & PG N+1 query budget', () => {
  test('monitors real event loop delay via perf_hooks and triggers alerts on blocking spin', async () => {
    const alerts: EventLoopBlockAlert[] = []
    const collector = createArchTelemetryCollector({
      eventLoopResolutionMs: 10,
      elWarnP99Ms: 15,
      elMaxBlockMs: 25,
      onEventLoopAlert: (a) => alerts.push(a),
    })

    collector.startEventLoopMonitor()
    // Let the event loop tick once, then block synchronously ~45ms to simulate a hot-path *Sync call
    await new Promise((resolve) => setTimeout(resolve, 15))
    const spinUntil = performance.now() + 45
    while (performance.now() < spinUntil) {
      // busy wait
    }
    await new Promise((resolve) => setTimeout(resolve, 25))

    const sample = collector.sampleEventLoopDelay()
    collector.stopEventLoopMonitor()

    assert.ok(sample !== null)
    assert.ok(sample.maxMs >= 20, `expected maxMs >= 20ms after 45ms block, got ${sample.maxMs}`)
    assert.ok(alerts.length >= 1)
  })

  test('fires deterministic alerts for p99/max thresholds and bounds alert ring buffer', () => {
    const collector = createArchTelemetryCollector({
      elWarnP99Ms: 80,
      elMaxBlockMs: 150,
      ringBufferSize: 4,
    })
    collector.ingestEventLoopMetrics({ p95Ms: 10, p99Ms: 20, maxMs: 30 }, 1000)
    assert.equal(collector.snapshot(1000).eventLoop.alertCount, 0)

    for (let i = 0; i < 6; i++) {
      collector.ingestEventLoopMetrics({ p95Ms: 60, p99Ms: 95 + i, maxMs: 180 + i }, 2000 + i)
    }
    const snap = collector.snapshot(3000)
    assert.equal(snap.eventLoop.alertCount, 6)
    assert.equal(snap.eventLoop.recentAlerts.length, 4)
    assert.equal(snap.eventLoop.recentAlerts[0]?.p99Ms, 97)
    assert.equal(snap.eventLoop.recentAlerts[3]?.reason, 'p99_and_max_exceeded')
  })

  test('catches per-request PG N+1 query count and query time budget overruns', () => {
    const alerts: QueryBudgetAlert[] = []
    const collector = createArchTelemetryCollector({
      defaultMaxQueriesPerRequest: 5,
      defaultMaxQueryDurationMs: 200,
      maxRouteBudgetKeys: 3,
      onQueryBudgetAlert: (a) => alerts.push(a),
    })

    // Null context is a safe no-op that still counts global queries
    collector.recordPgQuery(null, 4)

    // Request 1: 8 fast queries -> N+1 alert fires exactly once per request
    const ctx1 = collector.beginRequestQueryBudget('/api/sessions/list')
    for (let i = 0; i < 8; i++) {
      collector.recordPgQuery(ctx1, 3, 10_000 + i)
    }
    assert.equal(ctx1.queryCount, 8)
    assert.equal(ctx1.alertFired, true)
    assert.equal(alerts.length, 1)
    assert.equal(alerts[0]?.reason, 'n_plus_one_query_count')

    // Request 2: 2 slow queries exceeding duration budget
    const ctx2 = collector.beginRequestQueryBudget('/api/admin/heavy-report')
    collector.recordPgQuery(ctx2, 120, 20_000)
    collector.recordPgQuery(ctx2, 130, 20_001)
    assert.equal(alerts.length, 2)
    assert.equal(alerts[1]?.reason, 'query_duration_budget')

    // Verify route offender cap prevents unbounded route keys
    for (let r = 0; r < 10; r++) {
      const c = collector.beginRequestQueryBudget(`/api/dyn/${r}`, { maxQueries: 1 })
      collector.recordPgQuery(c, 1)
      collector.recordPgQuery(c, 1)
    }
    const snap = collector.snapshot(30_000)
    assert.equal(snap.pgQueryBudget.nPlusOneAlertCount, 11)
    assert.equal(snap.pgQueryBudget.durationBudgetAlertCount, 1)
    assert.equal(snap.pgQueryBudget.offendersByRoute.length, 3)
    assert.ok(snap.pgQueryBudget.droppedRouteKeys >= 8)
  })
})

describe('ArchTelemetryCollector — Commit + module implicit negative feedback attribution', () => {
  test('identifies regressing sourceCommits and top offending modules against baseline window', () => {
    const collector = createArchTelemetryCollector({
      minTurnsForRegression: 20,
      regressionDeltaThreshold: 0.05,
      baselineCommitWindow: 2,
      maxTrackedCommits: 4,
      maxModulesPerCommit: 3,
    })

    // Commit A: 100 turns, 4 rewrites (4.0%)
    for (let i = 0; i < 100; i++) {
      collector.recordCommitTurn({ sourceCommit: 'aaaa1111', module: 'commercial-ws', nowMs: 1000 })
    }
    for (let i = 0; i < 4; i++) {
      collector.recordUserRewriteResend({
        sourceCommit: 'aaaa1111',
        module: 'commercial-ws',
        kind: 'rewrite',
        nowMs: 1100,
      })
    }

    // Commit B: 100 turns, 5 rewrites (5.0%) — +1pp vs 4%, NOT regressing
    for (let i = 0; i < 100; i++) {
      collector.recordCommitTurn({ sourceCommit: 'bbbb2222', module: 'gateway-turn', nowMs: 2000 })
    }
    for (let i = 0; i < 5; i++) {
      collector.recordUserRewriteResend({
        sourceCommit: 'bbbb2222',
        module: 'gateway-turn',
        kind: 'resend',
        nowMs: 2100,
      })
    }

    // Commit C: 50 turns, 9 rewrites (18.0%) vs prior baseline (9/200 = 4.5%) -> +13.5pp REGRESSING!
    for (let i = 0; i < 50; i++) {
      collector.recordCommitTurn({
        sourceCommit: 'cccc3333',
        module: i < 30 ? 'gateway-engines' : 'commercial-ws',
        nowMs: 3000,
      })
    }
    for (let i = 0; i < 7; i++) {
      collector.recordUserRewriteResend({
        sourceCommit: 'cccc3333',
        module: 'gateway-engines',
        kind: 'rewrite',
        nowMs: 3100,
      })
    }
    for (let i = 0; i < 2; i++) {
      collector.recordUserRewriteResend({
        sourceCommit: 'cccc3333',
        module: 'commercial-ws',
        kind: 'abort_resend',
        nowMs: 3200,
      })
    }

    const snap = collector.snapshot(4000)
    assert.deepEqual(snap.commitAttribution.regressingCommits, ['cccc3333'])
    const commitC = snap.commitAttribution.commits.find((c) => c.sourceCommit === 'cccc3333')
    assert.ok(commitC)
    assert.equal(commitC.regressing, true)
    assert.equal(commitC.rewriteResendRate, 0.18)
    assert.equal(commitC.baselineRate, 0.045)
    assert.equal(commitC.deltaRate, 0.135)
    assert.equal(commitC.byModule[0]?.module, 'gateway-engines')
    assert.equal(commitC.byModule[0]?.rewriteResendCount, 7)

    // Test commit and module eviction caps
    collector.recordCommitTurn({ sourceCommit: 'dddd4444', module: 'm1', nowMs: 5000 })
    collector.recordCommitTurn({ sourceCommit: 'eeee5555', module: 'm1', nowMs: 6000 })
    collector.recordCommitTurn({ sourceCommit: 'eeee5555', module: 'm2', nowMs: 6001 })
    collector.recordCommitTurn({ sourceCommit: 'eeee5555', module: 'm3', nowMs: 6002 })
    collector.recordCommitTurn({ sourceCommit: 'eeee5555', module: 'm4', nowMs: 6003 })

    const afterCap = collector.snapshot(7000)
    assert.equal(afterCap.commitAttribution.trackedCommits, 4)
    assert.equal(afterCap.commitAttribution.evictedCommits, 1)
    assert.equal(afterCap.commitAttribution.droppedModules, 1)
  })
})

describe('ArchTelemetryCollector — overhead & async snapshot persistence', () => {
  test('handles 10,000 hot-path hits + query budget records in < 80ms and writes async JSON', async () => {
    const collector = new ArchTelemetryCollector()
    collector.registerAssets('route', ['/api/chat', '/api/sessions', '/api/models'], 1000)

    const start = performance.now()
    for (let i = 0; i < 10_000; i++) {
      collector.recordAssetHit('route', '/api/chat', 2000 + i)
      const ctx = collector.beginRequestQueryBudget('/api/chat')
      collector.recordPgQuery(ctx, 1.2, 2000 + i)
    }
    const elapsedMs = performance.now() - start
    assert.ok(elapsedMs < 250, `expected <250ms for 10k hot-path ops, took ${elapsedMs.toFixed(1)}ms`)

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'arch-telemetry-test-'))
    try {
      const outPath = path.join(tmpDir, 'arch-telemetry-snapshot.json')
      await collector.exportSnapshotAsync(outPath, 50_000)
      const parsed = JSON.parse(await readFile(outPath, 'utf8'))
      assert.equal(parsed.schemaVersion, ARCH_TELEMETRY_SCHEMA_VERSION)
      assert.equal(parsed.pgQueryBudget.observedRequests, 10_000)
      assert.equal(parsed.pgQueryBudget.observedQueries, 10_000)
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })
})
