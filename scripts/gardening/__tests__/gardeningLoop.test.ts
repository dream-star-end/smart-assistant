import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  evaluateCronLiveness,
  normalizeRunTimestampMs,
  parseCronJobsYaml,
  validateCronExpr,
} from '../../check-cron-liveness.js'
import {
  type PrioritizedDebtItem,
  computeMagnetScore,
  generateArchHealthSnapshot,
  rankDebtCandidates,
  tarjanScc,
} from '../arch-health-snapshot.js'
import {
  ITEM_COOLDOWN_MS,
  createEmptyCooldownLedger,
  isItemInCooldown,
  planGardeningDispatch,
  readGovernorState,
  recordGardeningFailure,
} from '../run-gardening-dispatch.js'
import { diffBaselineJson, verifyMicroPrBounds } from '../verify-micro-pr-bounds.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

describe('1. arch-health-snapshot: magnetScore, graceful baselines, and debt ranking', () => {
  test('computeMagnetScore matches touches_60d * log2(loc) * debtWeight and tarjanScc detects cycles', () => {
    // 10 * log2(256=8) * 2.5 = 200
    assert.equal(computeMagnetScore(10, 256, 2.5), 200)
    assert.equal(computeMagnetScore(0, 512, 4), 0)

    const graph = new Map<string, Set<string>>([
      ['a.ts', new Set(['b.ts'])],
      ['b.ts', new Set(['c.ts'])],
      ['c.ts', new Set(['a.ts', 'leaf.ts'])],
      ['leaf.ts', new Set()],
    ])
    assert.deepEqual(tarjanScc(graph), [['a.ts', 'b.ts', 'c.ts']])
  })

  test('generates valid snapshot on synthetic repo with missing optional baselines and ranks magnetScore * ttlUrgency', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arch-health-test-'))
    try {
      await mkdir(path.join(root, 'packages/gateway/src'), { recursive: true })
      await mkdir(path.join(root, 'packages/commercial/src'), { recursive: true })
      await mkdir(path.join(root, 'arch'), { recursive: true })
      await mkdir(path.join(root, '.github'), { recursive: true })

      await writeFile(
        path.join(root, 'packages/gateway/src/barrel.ts'),
        'export * from "./helper.js"\nexport const x = 1\n',
      )
      await writeFile(
        path.join(root, 'packages/gateway/src/wheelUser.ts'),
        [
          'function isRecord(v: unknown): v is Record<string, unknown> {',
          '  return typeof v === "object" && v !== null && !Array.isArray(v)',
          '}',
          'export function check(x: unknown) { return isRecord(x) }',
        ].join('\n'),
      )
      await writeFile(
        path.join(root, 'packages/commercial/src/envReader.ts'),
        'export const flag = process.env.MY_RAW_FLAG ?? "0"\n',
      )
      await writeFile(
        path.join(root, 'packages/commercial/src/deadLeaf.ts'),
        Array.from({ length: 30 }, (_, i) => `export const unused_${i} = ${i}`).join('\n'),
      )
      await writeFile(
        path.join(root, 'packages/commercial/src/bloatedModule.ts'),
        Array.from({ length: 128 }, (_, i) => `export const line_${i} = ${i}`).join('\n'),
      )

      // Only write violations-baseline & file-size-baseline; omit ai-smells/complexity/clones/file-cycles
      // to prove graceful degradation when optional baselines do not exist yet.
      await writeFile(
        path.join(root, 'arch/violations-baseline.json'),
        JSON.stringify({
          schema: 1,
          entries: {
            'R2-export-star|packages/gateway/src/barrel.ts|-': 2,
            'R3-env|packages/commercial/src/envReader.ts|-': 3,
            'R2-same-layer|packages/commercial/src/bloatedModule.ts|billing': 4,
          },
        }),
      )
      await writeFile(
        path.join(root, '.github/file-size-baseline.json'),
        JSON.stringify({
          limit: 3000,
          slack: 0,
          files: {},
          yellowZoneLimit: 2000,
          yellowZoneFiles: {
            'packages/commercial/src/bloatedModule.ts': 2100,
          },
        }),
      )

      const snapshot = await generateArchHealthSnapshot({
        root,
        now: new Date('2026-11-26T12:00:00Z'),
        gitStatsOverride: {
          window14dCommits: 20,
          window14dReworkCommits: 9,
          reworkRate14d: 0.45,
          touches14dByFile: {
            'packages/gateway/src/barrel.ts': 6,
            'packages/gateway/src/wheelUser.ts': 4,
          },
          rework14dByFile: {
            'packages/gateway/src/wheelUser.ts': 2,
          },
          touches60dByFile: {
            'packages/gateway/src/barrel.ts': 25,
            'packages/gateway/src/wheelUser.ts': 15,
            'packages/commercial/src/envReader.ts': 8,
            'packages/commercial/src/bloatedModule.ts': 5,
            'packages/commercial/src/deadLeaf.ts': 0,
          },
        },
      })

      assert.equal(snapshot.schemaVersion, 1)
      assert.equal(snapshot.git14d.status, 'RED')
      assert.equal(snapshot.baselines.violations.available, true)
      assert.equal(snapshot.baselines.fileSize.available, true)
      assert.equal(snapshot.baselines.aiSmells.available, false)
      assert.equal(snapshot.baselines.complexity.available, false)
      assert.equal(snapshot.baselines.clones.available, false)
      assert.equal(snapshot.baselines.fileCycles.available, false)

      const categories = new Set(snapshot.prioritizedDebtQueue.map((i) => i.category))
      for (const expected of ['r2-export-star', 'wheel-consolidation', 'r3-env', 'dead-code']) {
        assert.ok(categories.has(expected as PrioritizedDebtItem['category']), `missing ${expected}`)
      }

      // Verify strict descending order by priorityScore (= magnetScore * ttlUrgency)
      for (let i = 1; i < snapshot.prioritizedDebtQueue.length; i++) {
        assert.ok(
          snapshot.prioritizedDebtQueue[i - 1]!.priorityScore >=
            snapshot.prioritizedDebtQueue[i]!.priorityScore,
          'prioritizedDebtQueue must be sorted descending by magnetScore * ttlUrgency',
        )
      }

      // Also verify deterministic ranking helper directly
      const ranked = rankDebtCandidates(snapshot.prioritizedDebtQueue, 3)
      assert.equal(ranked.length, 3)
      assert.deepEqual(
        ranked.map((r) => r.rank),
        [1, 2, 3],
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('2. verify-micro-pr-bounds: >300L, >5 files, raised/flat baseline, test/gate guards', () => {
  const shrunkBaseline = diffBaselineJson(
    'arch/violations-baseline.json',
    { schema: 1, entries: { 'R3-env|packages/a.ts|-': 5 } },
    { schema: 1, entries: { 'R3-env|packages/a.ts|-': 3 } },
  )

  test('accepts a clean micro-PR within <=300 netLoc, <=5 files, and negative baselineDelta', () => {
    const res = verifyMicroPrBounds({
      category: 'r3-env',
      files: [
        { file: 'packages/commercial/src/a.ts', status: 'M', added: 12, deleted: 20 },
        { file: 'packages/commercial/src/config.ts', status: 'M', added: 6, deleted: 0 },
        { file: 'arch/violations-baseline.json', status: 'M', added: 1, deleted: 1 },
      ],
      baselineDeltas: [shrunkBaseline],
    })
    assert.equal(res.ok, true)
    assert.equal(res.summary.nonBaselineFiles, 2)
    assert.equal(res.summary.netLoc, -2)
    assert.equal(res.summary.prefersNetReduction, true)
    assert.equal(res.summary.minBaselineDelta, -2)
  })

  test('rejects micro-PR exceeding 300 net LOC', () => {
    const res = verifyMicroPrBounds({
      category: 'strangler-extract',
      files: [{ file: 'packages/gateway/src/extracted.ts', status: 'A', added: 305, deleted: 0 }],
      baselineDeltas: [shrunkBaseline],
    })
    assert.equal(res.ok, false)
    assert.ok(res.violations.some((v) => v.code === 'NET_LOC_EXCEEDED'))
  })

  test('rejects >5 touched files normally, allows 6..8 ONLY for mechanical wheel-consolidation, rejects >8 always', () => {
    const sixFilesStandard = verifyMicroPrBounds({
      category: 'r2-export-star',
      files: Array.from({ length: 6 }, (_, i) => ({
        file: `packages/gateway/src/f${i}.ts`,
        status: 'M' as const,
        added: 2,
        deleted: 2,
      })),
      baselineDeltas: [shrunkBaseline],
    })
    assert.equal(sixFilesStandard.ok, false)
    assert.ok(sixFilesStandard.violations.some((v) => v.code === 'TOUCHED_FILES_EXCEEDED'))

    const sevenMechanicalWheel = verifyMicroPrBounds({
      category: 'wheel-consolidation',
      files: Array.from({ length: 7 }, (_, i) => ({
        file: `packages/gateway/src/w${i}.ts`,
        status: 'M' as const,
        added: 1,
        deleted: 3,
        patchLines: [
          "+import { errMsg } from '@openclaude/kernel'",
          '-function errMsg(e: unknown): string {',
          '-  return e instanceof Error ? e.message : String(e)',
          '-}',
        ],
      })),
      baselineDeltas: [shrunkBaseline],
    })
    assert.equal(sevenMechanicalWheel.ok, true, JSON.stringify(sevenMechanicalWheel.violations))

    const sevenNonMechanicalWheel = verifyMicroPrBounds({
      category: 'wheel-consolidation',
      files: Array.from({ length: 7 }, (_, i) => ({
        file: `packages/gateway/src/w${i}.ts`,
        status: 'M' as const,
        added: 2,
        deleted: 1,
        patchLines: [
          '+export async function rewriteBusinessFlow() { await doSideEffect() }',
          '-const old = 1',
        ],
      })),
      baselineDeltas: [shrunkBaseline],
    })
    assert.equal(sevenNonMechanicalWheel.ok, false)
    assert.ok(sevenNonMechanicalWheel.violations.some((v) => v.code === 'NON_MECHANICAL_WHEEL_EDIT'))

    const nineMechanicalWheel = verifyMicroPrBounds({
      category: 'wheel-consolidation',
      files: Array.from({ length: 9 }, (_, i) => ({
        file: `packages/gateway/src/w${i}.ts`,
        status: 'M' as const,
        added: 1,
        deleted: 3,
        patchLines: ["+import { isRecord } from '@openclaude/kernel'"],
      })),
      baselineDeltas: [shrunkBaseline],
    })
    assert.equal(nineMechanicalWheel.ok, false)
    assert.ok(nineMechanicalWheel.violations.some((v) => v.code === 'TOUCHED_FILES_EXCEEDED'))
  })

  test('rejects raised baseline, stagnant baseline (delta == 0), gate edits, and test assertion weakening', () => {
    const raised = diffBaselineJson(
      'arch/violations-baseline.json',
      { schema: 1, entries: { 'R3-env|packages/a.ts|-': 2 } },
      { schema: 1, entries: { 'R3-env|packages/a.ts|-': 4 } },
    )
    const resRaised = verifyMicroPrBounds({
      files: [{ file: 'packages/a.ts', status: 'M', added: 2, deleted: 5 }],
      baselineDeltas: [raised],
    })
    assert.equal(resRaised.ok, false)
    assert.ok(resRaised.violations.some((v) => v.code === 'BASELINE_RAISED'))
    assert.ok(resRaised.violations.some((v) => v.code === 'NO_BASELINE_REDUCTION'))

    const resNoDrop = verifyMicroPrBounds({
      files: [{ file: 'packages/a.ts', status: 'M', added: 1, deleted: 5 }],
      baselineDeltas: [],
    })
    assert.equal(resNoDrop.ok, false)
    assert.ok(resNoDrop.violations.some((v) => v.code === 'NO_BASELINE_REDUCTION'))

    const resGateAndTest = verifyMicroPrBounds({
      files: [
        { file: 'scripts/check-architecture.ts', status: 'M', added: 1, deleted: 1 },
        {
          file: 'packages/gateway/src/__tests__/foo.test.ts',
          status: 'M',
          added: 1,
          deleted: 1,
          patchLines: ['-  assert.equal(result.ok, true)', '+  // removed assertion'],
        },
      ],
      baselineDeltas: [shrunkBaseline],
    })
    assert.equal(resGateAndTest.ok, false)
    assert.ok(resGateAndTest.violations.some((v) => v.code === 'PROTECTED_GATE_TOUCHED'))
    assert.ok(resGateAndTest.violations.some((v) => v.code === 'TEST_ASSERTION_MODIFIED'))
  })
})

describe('3. run-gardening-dispatch: 14d isolated cooldown (no collective freeze) & governor breaker', () => {
  const sampleQueue: PrioritizedDebtItem[] = ['a', 'b', 'c', 'd'].map((id, idx) => ({
    rank: idx + 1,
    itemKey: `wheel-consolidation:packages/gateway/src/${id}.ts`,
    category: 'wheel-consolidation',
    file: `packages/gateway/src/${id}.ts`,
    loc: 120,
    touches60d: 10 - idx,
    touches14d: 3,
    debtWeight: 2.5,
    magnetScore: (10 - idx) * 15,
    ttlUrgency: 1.25,
    priorityScore: (10 - idx) * 18.75,
    targetBaseline: 'arch/clones-baseline.json',
    autonomyTier: 'L3-auto',
    details: 'duplicate sha256Hex',
    suggestedAction: 'import sha256Hex from @openclaude/kernel',
  }))

  test('single-item failure cools down ONLY that itemKey for 14 days while peers still dispatch', () => {
    const t0 = new Date('2026-11-26T08:00:00Z')
    let ledger = createEmptyCooldownLedger(t0)

    // Fail item 'a' (gate failure / non-prod revert, or even 1st prod rollback < 2 threshold)
    ledger = recordGardeningFailure(ledger, {
      itemKey: sampleQueue[0]!.itemKey,
      reason: 'unit test failed in candidate branch',
      now: t0,
      isProductionRollback: false,
    })

    const day7 = new Date(t0.getTime() + 7 * 24 * 3600 * 1000)
    assert.equal(isItemInCooldown(ledger, sampleQueue[0]!.itemKey, day7), true)
    assert.equal(isItemInCooldown(ledger, sampleQueue[1]!.itemKey, day7), false)

    const dispatchAtDay7 = planGardeningDispatch({
      snapshot: { prioritizedDebtQueue: sampleQueue },
      ledger,
      governorMode: 'autonomous',
      limit: 3,
      dryRun: true,
      now: day7,
    })
    assert.equal(dispatchAtDay7.status, 'dispatched')
    assert.deepEqual(
      dispatchAtDay7.selected.map((s) => s.itemKey),
      [sampleQueue[1]!.itemKey, sampleQueue[2]!.itemKey, sampleQueue[3]!.itemKey],
    )
    assert.match(dispatchAtDay7.selected[0]!.ocv5TicketCommand, /^oc-task ticket create --project-id OCV5/)

    // After 14 days + 1s, item 'a' cooldown expires and re-enters #1 slot
    const after14d = new Date(t0.getTime() + ITEM_COOLDOWN_MS + 1000)
    assert.equal(isItemInCooldown(ledger, sampleQueue[0]!.itemKey, after14d), false)
    const dispatchAfter14d = planGardeningDispatch({
      snapshot: { prioritizedDebtQueue: sampleQueue },
      ledger,
      governorMode: 'autonomous',
      limit: 2,
      now: after14d,
    })
    assert.equal(dispatchAfter14d.selected[0]!.itemKey, sampleQueue[0]!.itemKey)
  })

  test('emergency_stop skips dispatch and global breaker trips ONLY at >=2 prod rollbacks in 7d', async () => {
    const t0 = new Date('2026-11-26T08:00:00Z')
    let ledger = createEmptyCooldownLedger(t0)

    const emergencyRes = planGardeningDispatch({
      snapshot: { prioritizedDebtQueue: sampleQueue },
      ledger,
      governorMode: 'emergency_stop',
      now: t0,
    })
    assert.equal(emergencyRes.status, 'skipped_emergency_stop')
    assert.equal(emergencyRes.selected.length, 0)

    // 1st production rollback does NOT freeze global dispatch
    ledger = recordGardeningFailure(ledger, {
      itemKey: sampleQueue[0]!.itemKey,
      reason: 'prod rollback #1',
      now: t0,
      isProductionRollback: true,
    })
    const afterOneRollback = planGardeningDispatch({
      snapshot: { prioritizedDebtQueue: sampleQueue },
      ledger,
      governorMode: 'debt_first',
      limit: 2,
      now: new Date(t0.getTime() + 3600_000),
    })
    assert.equal(afterOneRollback.status, 'dispatched')
    assert.equal(afterOneRollback.recentProductionRollbacks7d, 1)

    // 2nd production rollback within 7 days DOES trip global circuit breaker
    ledger = recordGardeningFailure(ledger, {
      itemKey: sampleQueue[1]!.itemKey,
      reason: 'prod rollback #2',
      now: new Date(t0.getTime() + 2 * 24 * 3600 * 1000),
      isProductionRollback: true,
    })
    const afterTwoRollbacks = planGardeningDispatch({
      snapshot: { prioritizedDebtQueue: sampleQueue },
      ledger,
      governorMode: 'autonomous',
      now: new Date(t0.getTime() + 3 * 24 * 3600 * 1000),
    })
    assert.equal(afterTwoRollbacks.status, 'halted_global_breaker')
    assert.equal(afterTwoRollbacks.selected.length, 0)

    // Missing governor mode.json degrades gracefully to autonomous
    const missingGov = await readGovernorState('/nonexistent/governor/mode.json')
    assert.deepEqual(missingGov, { mode: 'autonomous', breakerTripped: false })
  })
})

describe('4. check-cron-liveness & 4-beat cadence template verification', () => {
  test('flags crit when any enabled: true recurring job stalls > 2 * period, passes healthy/disabled/warmup', () => {
    const nowMs = Date.parse('2026-11-26T12:30:00Z')
    const nowMinuteKey = Math.floor(nowMs / 60_000)

    const yamlText = [
      'jobs:',
      '  - id: hourly-healthy',
      '    schedule: "7 * * * *"',
      '    enabled: true',
      '  - id: hourly-stalled',
      '    schedule: "7 * * * *"',
      '    enabled: true',
      '  - id: disabled-zombie',
      '    schedule: "17 3 * * *"',
      '    enabled: false',
      '  - id: fresh-weekly',
      '    schedule: "0 8 * * 1"',
      '    enabled: true',
      `    createdAt: ${nowMs - 3600_000}`,
    ].join('\n')

    const jobs = parseCronJobsYaml(yamlText)
    assert.equal(normalizeRunTimestampMs(nowMinuteKey - 23), (nowMinuteKey - 23) * 60_000)

    // hourly-stalled last ran 150 minutes ago (> 2 * 60 = 120 minutes) -> crit!
    const stalledReport = evaluateCronLiveness({
      jobs,
      lastRunByJob: {
        'hourly-healthy': normalizeRunTimestampMs(nowMinuteKey - 23),
        'hourly-stalled': normalizeRunTimestampMs(nowMinuteKey - 150),
        'disabled-zombie': normalizeRunTimestampMs(nowMinuteKey - 100_000),
        'fresh-weekly': null,
      },
      nowMs,
    })
    assert.equal(stalledReport.ok, false)
    assert.equal(stalledReport.level, 'crit')
    assert.equal(stalledReport.critCount, 1)
    assert.match(stalledReport.critSummaryLines[0]!, /\[CRON-LIVENESS\] crit/)
    assert.match(stalledReport.critSummaryLines[1]!, /hourly-stalled/)

    // When hourly-stalled runs 40m ago (<= 120m), report is ok!
    const healthyReport = evaluateCronLiveness({
      jobs,
      lastRunByJob: {
        'hourly-healthy': normalizeRunTimestampMs(nowMinuteKey - 23),
        'hourly-stalled': normalizeRunTimestampMs(nowMinuteKey - 40),
        'disabled-zombie': null,
        'fresh-weekly': null,
      },
      nowMs,
    })
    assert.equal(healthyReport.ok, true)
    assert.equal(healthyReport.critCount, 0)
  })

  test('deploy/v5/harness/cron-recommended-cadence.yaml defines exact 4 clean beats with valid cron schedules and zero zombies', async () => {
    const cadencePath = path.join(REPO_ROOT, 'deploy/v5/harness/cron-recommended-cadence.yaml')
    const raw = await readFile(cadencePath, 'utf8')
    const jobs = parseCronJobsYaml(raw)
    assert.deepEqual(
      jobs.map((j) => j.id),
      [
        'butler-light',
        'daily-friction-triage',
        'weekly-gardening-and-cockpit',
        'weekly-antidrift-retention',
      ],
    )
    for (const job of jobs) {
      assert.equal(job.enabled, true, `${job.id} should be enabled`)
      assert.equal(validateCronExpr(job.schedule), null, `${job.id} schedule must be valid`)
      assert.ok(!job.id.startsWith('remind-'), `zombie reminder left in template: ${job.id}`)
    }
    assert.ok(!raw.includes('agent:main:webchat:dm:webmuqjhduqb0ifd9'), 'OCV5-308 watchdog removed')
  })
})
