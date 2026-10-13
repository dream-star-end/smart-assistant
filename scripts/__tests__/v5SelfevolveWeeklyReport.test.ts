import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  type CoverageRow,
  type ReportAgg,
  collect,
  coverageTotal,
  findings,
  parseArgs,
  parseDays,
  pct,
  renderReport,
  safeDate,
} from '../v5-selfevolve-weekly-report.js'

function cov(partial: Partial<CoverageRow> & { origin: string }): CoverageRow {
  return {
    completed: 0,
    linked: 0,
    runtime: 0,
    control: 0,
    bundle: 0,
    client: 0,
    firstVisible: 0,
    ...partial,
  }
}

function agg(partial: Partial<ReportAgg> = {}): ReportAgg {
  return {
    date: '2026-10-13',
    days: 7,
    outcomes: [{ key: 'completed', n: 100 }],
    outcomesByModel: [{ model: 'deepseek-v4-flash', completed: 90, failed: 3 }],
    coverage: [
      cov({
        origin: 'conn',
        completed: 100,
        linked: 100,
        runtime: 100,
        control: 100,
        bundle: 100,
        client: 100,
        firstVisible: 100,
      }),
    ],
    traceNoise: { tracesTotal: 100, tracesWithoutDispatch: 0, topSessions: [] },
    ratings: {
      up: 5,
      downExplicit: 1,
      downImplicitByTag: [],
      nudgeExposures: 10,
      nudgeRated: 2,
      byModel: [],
    },
    readiness: [{ userId: '3', evaluations: 10, ready: 1, latestBlockers: [] }],
    friction: [],
    skills: { rows: [], shadowEvents: 0 },
    memory: [],
    autoDream: { receipts: [], openFindings: 0, findingsBySeverity: [] },
    ...partial,
  }
}

describe('v5-selfevolve-weekly-report args', () => {
  test('defaults and flags', () => {
    const now = new Date('2026-10-13T04:00:00Z')
    const d = parseArgs([], now)
    assert.equal(d.days, 7)
    assert.equal(d.date, '2026-10-13')
    assert.equal(d.dryRun, false)
    const o = parseArgs(
      ['--dry-run', '--days', '14', '--date', '2026-10-01', '--out-dir', '/tmp/x'],
      now,
    )
    assert.deepEqual([o.dryRun, o.days, o.date, o.outDir], [true, 14, '2026-10-01', '/tmp/x'])
  })

  test('rejects bad values', () => {
    assert.throws(() => parseDays('0'))
    assert.throws(() => parseDays('32'))
    assert.throws(() => parseDays('7d'))
    assert.throws(() => safeDate('2026-13-45'))
    assert.throws(() => safeDate('2026-10-13; DROP'))
    assert.throws(() => parseArgs(['--nope']))
    assert.throws(() => parseArgs(['--days']))
  })
})

describe('v5-selfevolve-weekly-report aggregation', () => {
  test('coverageTotal sums every origin', () => {
    const total = coverageTotal([
      cov({ origin: 'conn', completed: 10, linked: 10, client: 6 }),
      cov({ origin: 'cron', completed: 5, linked: 0 }),
    ])
    assert.equal(total.origin, 'all')
    assert.equal(total.completed, 15)
    assert.equal(total.linked, 10)
    assert.equal(total.client, 6)
  })

  test('findings name the weakest origin and the thin rating sample', () => {
    const notes = findings(
      agg({
        coverage: [
          cov({ origin: 'conn', completed: 90, linked: 90, client: 90 }),
          cov({ origin: 'cron', completed: 10, linked: 0 }),
        ],
        ratings: {
          up: 1,
          downExplicit: 0,
          downImplicitByTag: [{ key: '中途打断', n: 9 }],
          nudgeExposures: 50,
          nudgeRated: 1,
          byModel: [],
        },
        readiness: [
          { userId: '3', evaluations: 100, ready: 0, latestBlockers: ['explicit_rating_sample'] },
        ],
        traceNoise: { tracesTotal: 1000, tracesWithoutDispatch: 900, topSessions: [] },
      }),
    )
    assert.ok(
      notes.some((n) => n.includes('trace↔dispatch') && n.includes('cron 0.0%')),
      notes.join('\n'),
    )
    assert.ok(notes.some((n) => n.includes('显式评价只有 1 条')))
    assert.ok(notes.some((n) => n.includes('90.0% 的 trace 没有 dispatch')))
    assert.ok(notes.some((n) => n.includes('就绪门本期没有一次放行')))
  })

  test('healthy data produces no findings', () => {
    assert.deepEqual(findings(agg()), [])
  })

  test('pct handles an empty denominator', () => {
    assert.equal(pct(null), '—')
    assert.equal(pct(0.5), '50.0%')
  })
})

describe('v5-selfevolve-weekly-report render', () => {
  test('renders every section and escapes table pipes', () => {
    const md = renderReport(
      agg({
        skills: {
          rows: [{ slug: 'a|b', layer: 'hub', uses: 3, users: 1, downLinked: 1 }],
          shadowEvents: 4,
        },
      }),
    )
    for (const heading of [
      '## 1. 回合结局',
      '## 2. 信号归因',
      '## 3. 评价',
      '## 4. 遥测就绪门',
      '## 5. 摩擦',
      '## 6. 技能',
      '## 7. 记忆使用',
      '## 8. auto-dream',
    ]) {
      assert.ok(md.includes(heading), heading)
    }
    assert.ok(md.includes('a\\|b'))
    assert.ok(md.includes('| all | 100 | 100.0%'))
  })
})

describe('v5-selfevolve-weekly-report collect', () => {
  test('issues only read-only SELECTs, bound to the window parameters', async () => {
    const seen: Array<{ sql: string; params?: unknown[] }> = []
    const q = async (sql: string, params?: unknown[]) => {
      seen.push({ sql, params })
      return []
    }
    const result = await collect(q as never, 7, '2026-10-13')
    assert.ok(seen.length >= 10)
    for (const { sql, params } of seen) {
      assert.match(sql.trim(), /^SELECT\b/, sql)
      assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/i, sql)
      if (params !== undefined) assert.deepEqual(params, ['7', '2026-10-13'])
    }
    // Content columns never leave the database.
    const all = seen.map((s) => s.sql).join('\n')
    for (const column of [
      'comment',
      'problem',
      'recommendation',
      'message_hash',
      'query_hash',
      'routes',
    ]) {
      assert.doesNotMatch(all, new RegExp(`\\b${column}\\b`), column)
    }
    assert.equal(result.coverage.length, 0)
    assert.equal(result.ratings.up, 0)
  })
})
