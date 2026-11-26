import * as assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import {
  type CommitRecord,
  type DebtTtlPolicy,
  checkCommitPrefixAllowed,
  classifyCommitPrefix,
  computeWeeklyReworkStats,
  evaluateDebtTtlPolicy,
  loadPolicy,
  main,
  parseIsoDateMs,
} from '../check-debt-ttl.js'

const DAY_MS = 86_400_000

function makeFixtureRepo(opts: {
  effectiveFrom?: string
  violationsTotal?: number
  r2Total?: number
  redFiles?: number
  expiredFlag?: boolean
  expiredFileSizeException?: boolean
  modeJson?: string
} = {}): { dir: string; policy: DebtTtlPolicy; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'oc-debt-ttl-test-'))
  mkdirSync(path.join(dir, 'arch'), { recursive: true })
  mkdirSync(path.join(dir, '.github'), { recursive: true })
  mkdirSync(path.join(dir, 'deploy/v5'), { recursive: true })

  const r2Count = opts.r2Total ?? 1191
  const nonR2Count = Math.max(0, (opts.violationsTotal ?? 3448) - r2Count)
  writeFileSync(
    path.join(dir, 'arch/violations-baseline.json'),
    JSON.stringify({
      schema: 1,
      entries: {
        'R2-same-layer|a.ts|b': r2Count,
        'R3-env|a.ts|ENV': nonR2Count,
      },
    }),
  )

  const redFiles: Record<string, number> = {}
  for (let i = 0; i < (opts.redFiles ?? 18); i += 1) {
    redFiles[`f${i}.ts`] = 4000
  }
  writeFileSync(
    path.join(dir, '.github/file-size-baseline.json'),
    JSON.stringify({
      limit: 3000,
      slack: 0,
      files: redFiles,
      cssFiles: { 'a.css': 3000, 'b.css': 3000 },
      yellowZoneFiles: { 'y.ts': 2000 },
    }),
  )

  writeFileSync(
    path.join(dir, '.github/file-size-ratchet-exceptions.json'),
    JSON.stringify(
      opts.expiredFileSizeException
        ? [
            { path: 'a.ts', maxLines: 3100, ticket: 'OCV5-1', reason: 'split pending', expires: '2026-12-01' },
            { path: 'b.ts', maxLines: 3100, ticket: 'OCV5-2', reason: 'split pending', expires: '2026-12-02' },
            { path: 'c.ts', maxLines: 3100, ticket: 'OCV5-3', reason: 'split pending', expires: '2026-12-03' },
          ]
        : [{ path: 'a.ts', maxLines: 3100, ticket: 'OCV5-1', reason: 'split pending', expires: '2026-12-30' }],
    ),
  )

  writeFileSync(
    path.join(dir, 'deploy/v5/feature-flags-registry.json'),
    JSON.stringify({
      schema: 1,
      flags: [
        {
          name: 'OC_TEMP_FLAG',
          owner: '@dev',
          createdAt: '2026-11-22',
          expireAt: opts.expiredFlag ? '2026-12-01' : '2026-12-28',
          permanent: false,
          description: 'temp rollout flag',
        },
      ],
    }),
  )

  const policy: DebtTtlPolicy = {
    schema: 1,
    anchorDate: '2026-11-26',
    effectiveFrom: opts.effectiveFrom ?? '2026-12-03',
    decayTargets: {
      violationsBaseline: {
        path: 'arch/violations-baseline.json',
        anchorTotal: 3448,
        anchorR2Total: 1191,
        monthlyTotalDecayRate: 0.03,
        quarterlyTotalDecayRate: 0.1,
        monthlyR2DecayRate: 0.05,
        quarterlyR2DecayRate: 0.15,
      },
      fileSizeBaseline: {
        path: '.github/file-size-baseline.json',
        anchorRedFiles: 18,
        anchorCssFiles: 2,
        anchorYellowFiles: 1,
        anchorTotalTrackedLines: 80000,
        monthlyRedFileReduction: 1,
        quarterlyTotalLinesDecayRate: 0.05,
      },
    },
    ttlPolicy: {
      maxExceptionDays: 30,
      debtFirstExpiredThreshold: 3,
      sources: {
        fileSizeExceptions: '.github/file-size-ratchet-exceptions.json',
        featureFlagsRegistry: 'deploy/v5/feature-flags-registry.json',
      },
      debtExemptions: [],
    },
    debtFirstPolicy: {
      windowWeeks: 2,
      triggerReworkRatio: 0.4,
      releaseReworkRatio: 0.3,
      reworkPrefixes: ['fix', 'bug'],
      blockedPrefixesInDebtFirst: ['feat'],
      allowedPrefixesInDebtFirst: [
        'bug',
        'fix',
        'refactor',
        'chore',
        'ci',
        'docs',
        'perf',
        'test',
        'revert',
      ],
    },
  }
  writeFileSync(path.join(dir, 'arch/debt-ttl-policy.json'), JSON.stringify(policy, null, 2))
  if (opts.modeJson) {
    writeFileSync(path.join(dir, 'mode.json'), opts.modeJson)
  }
  return { dir, policy, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function makeCommitsForTwoWeeks(
  today: string,
  w1: { rework: number; feat: number },
  w2: { rework: number; feat: number },
): CommitRecord[] {
  const todayMs = parseIsoDateMs(today)
  const out: CommitRecord[] = []
  // Week 1: [-12d..-8d]
  for (let i = 0; i < w1.rework; i += 1) {
    out.push({ subject: `bug(v5): fix item ${i}`, timestampMs: todayMs - 10 * DAY_MS + i * 1000 })
  }
  for (let i = 0; i < w1.feat; i += 1) {
    out.push({ subject: `feat(v5): add item ${i}`, timestampMs: todayMs - 10 * DAY_MS + (w1.rework + i) * 1000 })
  }
  // Week 2: [-5d..-1d]
  for (let i = 0; i < w2.rework; i += 1) {
    out.push({ subject: `fix(v5): patch ${i}`, timestampMs: todayMs - 3 * DAY_MS + i * 1000 })
  }
  for (let i = 0; i < w2.feat; i += 1) {
    out.push({ subject: `feat(v5): ship ${i}`, timestampMs: todayMs - 3 * DAY_MS + (w2.rework + i) * 1000 })
  }
  return out
}

describe('check-debt-ttl: decay ratchet & auto Debt-First freeze', () => {
  it('classifies commit prefixes and honors grace window on 2026-11-26 even with >40% rework', () => {
    assert.equal(classifyCommitPrefix('feat(v5): add engine'), 'feat')
    assert.equal(classifyCommitPrefix('bug(v5): fix race'), 'bug')
    assert.equal(classifyCommitPrefix('fix!: urgent hotfix'), 'fix')
    assert.equal(classifyCommitPrefix('refactor(v5): split module'), 'refactor')

    const fx = makeFixtureRepo()
    try {
      const commits = makeCommitsForTwoWeeks('2026-11-26', { rework: 5, feat: 5 }, { rework: 5, feat: 5 })
      const ev = evaluateDebtTtlPolicy({
        root: fx.dir,
        policy: fx.policy,
        today: '2026-11-26',
        commits,
        commitMessage: 'feat(v5): land governance P2',
      })
      assert.equal(ev.inGraceWindow, true)
      assert.equal(ev.rework.consecutiveTwoWeeksOverTrigger, true)
      assert.equal(ev.recommendedMode, 'debt_first')
      // Grace window prevents self-locking today!
      assert.equal(ev.effectiveMode, 'autonomous')
      assert.equal(ev.commitCheck?.allowed, true)
    } finally {
      fx.cleanup()
    }
  })

  it('auto-triggers debt_first on/after effectiveFrom when 2 consecutive weeks exceed 40% rework and blocks feat(v5):', () => {
    const fx = makeFixtureRepo()
    try {
      // 50% rework in week 1 AND 50% rework in week 2 on 2026-12-05 (>= 2026-12-03).
      const commits = makeCommitsForTwoWeeks('2026-12-05', { rework: 5, feat: 5 }, { rework: 5, feat: 5 })
      const evFeat = evaluateDebtTtlPolicy({
        root: fx.dir,
        policy: fx.policy,
        today: '2026-12-05',
        commits,
        commitMessage: 'feat(v5): new dashboard widget',
      })
      assert.equal(evFeat.inGraceWindow, false)
      assert.equal(evFeat.recommendedMode, 'debt_first')
      assert.equal(evFeat.effectiveMode, 'debt_first')
      assert.equal(evFeat.commitCheck?.allowed, false)

      // Maintenance / bug / refactor / chore / ci / docs / perf prefixes stay allowed in debt_first.
      for (const msg of [
        'bug(v5): fix ledger drift',
        'fix(v5): guard race',
        'refactor(v5): break up monolith',
        'chore(v5): clean stale flags',
        'ci(v5): tighten gate',
        'docs(v5): update runbook',
        'perf(v5): avoid N+1 query',
      ]) {
        const res = checkCommitPrefixAllowed(msg, 'debt_first', fx.policy)
        assert.equal(res.allowed, true, `expected ${msg} to be allowed in debt_first`)
      }
    } finally {
      fx.cleanup()
    }
  })

  it('auto-triggers debt_first when expired debt TTL count hits threshold', () => {
    const fx = makeFixtureRepo({ expiredFileSizeException: true })
    try {
      const lowRework = makeCommitsForTwoWeeks('2026-12-10', { rework: 1, feat: 9 }, { rework: 1, feat: 9 })
      const ev = evaluateDebtTtlPolicy({
        root: fx.dir,
        policy: fx.policy,
        today: '2026-12-10',
        commits: lowRework,
        commitMessage: 'feat(v5): blocked by expired TTL backlog',
      })
      assert.equal(ev.ttl.expiredCount, 3)
      assert.equal(ev.recommendedMode, 'debt_first')
      assert.equal(ev.effectiveMode, 'debt_first')
      assert.equal(ev.commitCheck?.allowed, false)
    } finally {
      fx.cleanup()
    }
  })

  it('enforces hysteresis release: stays in debt_first in 30%..40% band or while expired TTL > 0, releases once <30% and 0 expired', () => {
    const fx = makeFixtureRepo({ expiredFlag: true })
    try {
      // 1. In 35% hysteresis band while already in debt_first -> stays debt_first.
      const bandCommits = makeCommitsForTwoWeeks('2026-12-10', { rework: 7, feat: 13 }, { rework: 7, feat: 13 })
      const stayBand = evaluateDebtTtlPolicy({
        root: fx.dir,
        policy: fx.policy,
        today: '2026-12-10',
        commits: bandCommits,
        externalMode: 'debt_first',
      })
      assert.equal(stayBand.recommendedMode, 'debt_first')

      // 2. Rework < 30% (20%), but 1 expired flag TTL still open -> stays debt_first!
      const cleanCommits = makeCommitsForTwoWeeks('2026-12-10', { rework: 2, feat: 8 }, { rework: 2, feat: 8 })
      const blockedByTtl = evaluateDebtTtlPolicy({
        root: fx.dir,
        policy: fx.policy,
        today: '2026-12-10',
        commits: cleanCommits,
        externalMode: 'debt_first',
      })
      assert.equal(blockedByTtl.ttl.expiredCount, 1)
      assert.equal(blockedByTtl.recommendedMode, 'debt_first')
    } finally {
      fx.cleanup()
    }

    // 3. Rework < 30% AND 0 expired TTLs -> recommends release back to autonomous!
    const fxClean = makeFixtureRepo({ expiredFlag: false })
    try {
      const cleanCommits = makeCommitsForTwoWeeks('2026-12-10', { rework: 2, feat: 8 }, { rework: 2, feat: 8 })
      const readyToRelease = evaluateDebtTtlPolicy({
        root: fxClean.dir,
        policy: fxClean.policy,
        today: '2026-12-10',
        commits: cleanCommits,
        externalMode: 'debt_first',
      })
      assert.equal(readyToRelease.ttl.expiredCount, 0)
      assert.equal(readyToRelease.recommendedMode, 'autonomous')
      assert.equal(readyToRelease.releaseBlockedReasons.length, 0)
      // Once governor unlocks mode back to autonomous (or no external lock), feat(v5): passes again.
      const unlocked = evaluateDebtTtlPolicy({
        root: fxClean.dir,
        policy: fxClean.policy,
        today: '2026-12-10',
        commits: cleanCommits,
        externalMode: 'autonomous',
        commitMessage: 'feat(v5): resume feature shipping',
      })
      assert.equal(unlocked.recommendedMode, 'autonomous')
      assert.equal(unlocked.effectiveMode, 'autonomous')
      assert.equal(unlocked.commitCheck?.allowed, true)
    } finally {
      fxClean.cleanup()
    }
  })

  it('tracks monthly baseline decay targets accurately after 1 month elapsed', () => {
    // 1 month after 2026-11-26 -> 2026-12-27:
    //   violationsAllowedMax = floor(3448 * 0.97) = 3344
    //   r2AllowedMax         = floor(1191 * 0.95) = 1131
    //   redFilesAllowedMax   = 18 - 1 = 17
    const fxBehind = makeFixtureRepo({ violationsTotal: 3448, r2Total: 1191, redFiles: 18 })
    const fxOnTrack = makeFixtureRepo({ violationsTotal: 3300, r2Total: 1120, redFiles: 17 })
    try {
      const behind = evaluateDebtTtlPolicy({
        root: fxBehind.dir,
        policy: fxBehind.policy,
        today: '2026-12-27',
        commits: [],
      })
      assert.equal(behind.decay.monthsElapsed, 1)
      assert.equal(behind.decay.allOnTrack, false)
      assert.equal(behind.decay.violationsOnTrack, false)
      assert.equal(behind.decay.r2OnTrack, false)
      assert.equal(behind.decay.redFilesOnTrack, false)

      const onTrack = evaluateDebtTtlPolicy({
        root: fxOnTrack.dir,
        policy: fxOnTrack.policy,
        today: '2026-12-27',
        commits: [],
      })
      assert.equal(onTrack.decay.monthsElapsed, 1)
      assert.equal(onTrack.decay.allOnTrack, true)
    } finally {
      fxBehind.cleanup()
      fxOnTrack.cleanup()
    }
  })

  it('CLI enforces external mode file and repo policy file parses cleanly', () => {
    const repoRoot = path.resolve(import.meta.dirname, '../..')
    const realPolicy = loadPolicy(repoRoot)
    assert.equal(realPolicy.schema, 1)
    assert.equal(realPolicy.effectiveFrom, '2026-12-03')

    const fx = makeFixtureRepo({ modeJson: JSON.stringify({ mode: 'debt_first' }) })
    try {
      assert.equal(
        main([
          '--root',
          fx.dir,
          '--today',
          '2026-12-10',
          '--mode-file',
          path.join(fx.dir, 'mode.json'),
          '--check-commit-prefix',
          'feat(v5): blocked feature',
        ]),
        1,
      )
      assert.equal(
        main([
          '--root',
          fx.dir,
          '--today',
          '2026-12-10',
          '--mode-file',
          path.join(fx.dir, 'mode.json'),
          '--check-commit-prefix',
          'refactor(v5): allowed debt payoff',
        ]),
        0,
      )
      // Validate computeWeeklyReworkStats skips merge commits.
      const stats = computeWeeklyReworkStats(
        [
          { subject: 'Merge pull request #1416 from foo/bar', timestampMs: parseIsoDateMs('2026-12-09') },
          { subject: 'bug(v5): one', timestampMs: parseIsoDateMs('2026-12-09') },
        ],
        '2026-12-10',
        ['fix', 'bug'],
        0.4,
      )
      assert.equal(stats.week2.total, 1)
      assert.equal(stats.week2.rework, 1)
    } finally {
      fx.cleanup()
    }
  })

  it('B9 bidirectional regression: on 2026-12-03 with external debt_first + budgets met, bug/refactor pass --enforce (exit 0) while feat fails (exit 1); emergency_stop always exits 1', () => {
    const fx = makeFixtureRepo({ modeJson: JSON.stringify({ mode: 'debt_first' }) })
    try {
      const modePath = path.join(fx.dir, 'mode.json')

      // Exact B9 scenario: effectiveFrom = 2026-12-03, external debt_first, 0 expired TTLs, budgets onTrack=true
      assert.equal(
        main([
          '--root',
          fx.dir,
          '--enforce',
          '--today',
          '2026-12-03',
          '--mode-file',
          modePath,
          '--check-commit-prefix',
          'bug(v5): fix lease worker timeout',
        ]),
        0,
        'bug(v5) fix commit MUST return exit 0 in debt_first mode when budgets & TTLs are met',
      )

      assert.equal(
        main([
          '--root',
          fx.dir,
          '--enforce',
          '--today',
          '2026-12-03',
          '--mode-file',
          modePath,
          '--check-commit-prefix',
          'refactor(v5): split large supervisor module',
        ]),
        0,
        'refactor(v5) commit MUST return exit 0 in debt_first mode when budgets & TTLs are met',
      )

      // Same conditions with feat(v5): MUST return exit 1!
      assert.equal(
        main([
          '--root',
          fx.dir,
          '--enforce',
          '--today',
          '2026-12-03',
          '--mode-file',
          modePath,
          '--check-commit-prefix',
          'feat(v5): add new experimental feature',
        ]),
        1,
        'feat(v5) commit MUST return exit 1 in debt_first mode',
      )

      // emergency_stop MUST ALWAYS exit 1, even for bug(v5): and even before effectiveFrom!
      const stopPath = path.join(fx.dir, 'stop-mode.json')
      writeFileSync(stopPath, JSON.stringify({ mode: 'emergency_stop' }))
      assert.equal(
        main([
          '--root',
          fx.dir,
          '--enforce',
          '--today',
          '2026-12-03',
          '--mode-file',
          stopPath,
          '--check-commit-prefix',
          'bug(v5): fix under emergency_stop',
        ]),
        1,
      )
      assert.equal(
        main([
          '--root',
          fx.dir,
          '--enforce',
          '--today',
          '2026-11-26',
          '--mode-file',
          stopPath,
        ]),
        1,
      )

      // Real git commit auto-detection (--enforce without --check-commit-prefix, and --base/--head range)
      const git = (...args: string[]) =>
        execFileSync('git', ['-C', fx.dir, ...args], { encoding: 'utf8' }).trim()
      git('init', '-q', '-b', 'feat/v5-selfhost')
      git('config', 'user.email', 't@t')
      git('config', 'user.name', 't')
      git('add', '-A')
      git('commit', '-qm', 'chore(v5): seed baseline')
      git('tag', 'base-debt')

      writeFileSync(path.join(fx.dir, 'note.txt'), 'fix 1\n')
      git('add', '-A')
      git('commit', '-qm', 'bug(v5): fix debt item')

      // --enforce alone auto-reads HEAD subject (`bug(v5): ...`) -> exit 0!
      assert.equal(
        main(['--root', fx.dir, '--enforce', '--today', '2026-12-03', '--mode-file', modePath]),
        0,
      )
      // --enforce --base base-debt --head HEAD -> exit 0!
      assert.equal(
        main([
          '--root',
          fx.dir,
          '--enforce',
          '--base',
          'base-debt',
          '--head',
          'HEAD',
          '--today',
          '2026-12-03',
          '--mode-file',
          modePath,
        ]),
        0,
      )

      // Adding a feat(v5) commit in the range -> exit 1!
      writeFileSync(path.join(fx.dir, 'note.txt'), 'feat 2\n')
      git('add', '-A')
      git('commit', '-qm', 'feat(v5): sneak feature during debt_first')
      assert.equal(
        main([
          '--root',
          fx.dir,
          '--enforce',
          '--base',
          'base-debt',
          '--head',
          'HEAD',
          '--today',
          '2026-12-03',
          '--mode-file',
          modePath,
        ]),
        1,
      )
      // Even if a subsequent bug commit is on top of feat in the same range, --base..--head catches the feat!
      writeFileSync(path.join(fx.dir, 'note.txt'), 'fix 3\n')
      git('add', '-A')
      git('commit', '-qm', 'bug(v5): follow-up fix')
      assert.equal(
        main([
          '--root',
          fx.dir,
          '--enforce',
          '--base',
          'base-debt',
          '--head',
          'HEAD',
          '--today',
          '2026-12-03',
          '--mode-file',
          modePath,
        ]),
        1,
      )
    } finally {
      fx.cleanup()
    }
  })
})
