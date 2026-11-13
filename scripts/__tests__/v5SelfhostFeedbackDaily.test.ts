import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import {
  type Report,
  buildFeedbackSql,
  cohortLines,
  modelHot,
  parseArgs,
  renderReport,
  toPublicJson,
  traceCommands,
  trainSectionFromDir,
  windowBounds,
} from '../v5-selfhost-feedback-daily.js'

function sample(): Report['ratings']['samples']['explicitUp'] {
  return { traceIds: [], sessionIds: [] }
}

function base(partial: Partial<Report> = {}): Report {
  const ratings: Report['ratings'] = {
    explicitUp: 0,
    explicitDown: 0,
    implicitInterrupt: 0,
    implicitRewrite: 0,
    implicitOther: 0,
    samples: {
      explicitUp: sample(),
      explicitDown: sample(),
      implicitInterrupt: sample(),
      implicitRewrite: sample(),
      implicitOther: sample(),
    },
    nudges: { exposed: 0, rated: 0, dismissed: 0, sample: sample() },
  }
  return {
    date: '2026-10-31',
    days: 7,
    windowStart: '2026-10-24 23:59:59+08',
    windowEnd: '2026-10-31 23:59:59+08',
    include765: false,
    daily: [],
    nonComplete: [],
    models: [],
    tools: {
      buckets: [],
      totalCalls: 0,
      failedCalls: 0,
      timeoutCalls: 0,
      top: [],
      timeoutTraceIds: [],
    },
    recovery: { groups: [], joinedNotCompleted: 0, noDispatch: 0 },
    stops: { groups: [], userCancelledTraceIds: [] },
    ratings,
    sameAsk: { groups: 0, turns: 0, pairs10m: 0, laterGroupTraceIds: [], laterPairTraceIds: [] },
    abandoned: { total: 0, interrupted: 0, traceIds: [] },
    modelSwitch: { n: 0, traceIds: [] },
    friction: [],
    journal: [],
    serviceRestart: { n: 0, p50Seconds: null, maxSeconds: null, ge1800: 0, traceIds: [] },
    trains: { missing: true },
    ...partial,
  }
}

describe('v5-selfhost-feedback-daily args and window', () => {
  test('defaults exclude 765 and use the CST date', () => {
    const opts = parseArgs([], new Date('2026-10-30T16:30:00Z'))
    assert.equal(opts.date, '2026-10-31')
    assert.equal(opts.days, 7)
    assert.equal(opts.include765, false)
    assert.equal(opts.dryRun, false)
  })

  test('flags and bad args', () => {
    const opts = parseArgs(['--dry-run', '--days', '14', '--date', '2026-10-31', '--include-765'])
    assert.equal(opts.dryRun, true)
    assert.equal(opts.days, 14)
    assert.equal(opts.include765, true)
    assert.throws(() => parseArgs(['--days', '0']))
    assert.throws(() => parseArgs(['--days', '7d']))
    assert.throws(() => parseArgs(['--date', '2026-13-40']))
    assert.throws(() => parseArgs(['--database-url', 'postgres://secret']))
  })

  test('window ends at 23:59:59+08 and goes back exactly --days', () => {
    const bounds = windowBounds('2026-10-31', 7)
    assert.equal(bounds.endText, '2026-10-31 23:59:59+08')
    assert.equal(bounds.startText, '2026-10-24 23:59:59+08')
    assert.equal(bounds.endExclusiveSql, '2026-11-01 00:00:00+08')
  })
})

describe('v5-selfhost-feedback-daily sql predicates', () => {
  test('default SQL excludes 765 and include-765 drops that predicate', () => {
    const def = buildFeedbackSql({ date: '2026-10-31', days: 7, include765: false })
    const inc = buildFeedbackSql({ date: '2026-10-31', days: 7, include765: true })
    assert.match(def, /user_id <> 765/)
    assert.match(def, /BEGIN READ ONLY/)
    assert.match(def, /statement_timeout = '20s'/)
    assert.match(def, /Asia\/Shanghai/)
    assert.match(def, /LIMIT/)
    assert.doesNotMatch(def, /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/i)
    assert.doesNotMatch(inc, /user_id <> 765/)
    assert.match(inc, /session_id LIKE 'web%'/)
    for (const sql of [def, inc]) {
      for (const column of [
        'comment',
        'description',
        'error_msg',
        'input_meta',
        'request_json',
        'payload_json',
        'last_payload',
        'snapshot',
        'body',
      ]) {
        assert.doesNotMatch(sql, new RegExp(`\\b${column}\\b`), column)
      }
      assert.doesNotMatch(sql, /unnest\s*\(/i)
      assert.doesNotMatch(sql, /['"]request_hash['"]/)
    }
  })
})

describe('v5-selfhost-feedback-daily thresholds', () => {
  test('model ratios use integer bounds', () => {
    assert.equal(modelHot(0, 5), true)
    assert.equal(modelHot(3, 3), true)
    assert.equal(modelHot(4, 2), false)
    assert.equal(modelHot(0, 4), false)
    assert.equal(modelHot(8, 2), true)
    assert.equal(modelHot(9, 1), false)
  })

  test('a hot model is named in 需要注意 with one legal trace command', () => {
    const md = renderReport(
      base({
        models: [
          {
            model: 'box-claude-haiku-5-5',
            completed: 0,
            other: 5,
            topFailureCode: 'ENGINE_ERROR',
            traceIds: ['trace-ok-1', 'bad id', 'short', 'ok'],
          },
        ],
      }),
    )
    const note = md.split('## H 逐日')[0] ?? ''
    assert.match(note, /需要注意/)
    assert.match(note, /box-claude-haiku-5-5/)
    assert.match(note, /^npx tsx scripts\/oc-trace\.ts trace-ok-1$/m)
    assert.doesNotMatch(note, /oc-trace\.ts short/)
    assert.doesNotMatch(note, /oc-trace\.ts ok$/)
    assert.doesNotMatch(note, /bad id/)
    assert.doesNotMatch(md, /--session/)
    assert.doesNotMatch(md, /--verbose/)
  })

  test('illegal traces never become commands', () => {
    assert.deepEqual(traceCommands(['bad id', 'short', 'abc', 'trace_ok']), ['npx tsx scripts/oc-trace.ts trace_ok'])
    assert.deepEqual(traceCommands(['has space']), [])
  })
})

describe('v5-selfhost-feedback-daily render', () => {
  test('completed recovery status is not called a recovered turn', () => {
    const md = renderReport(
      base({
        recovery: {
          groups: [
            {
              status: 'completed',
              errorCode: 'service_restart',
              outcome: 'interrupted',
              n: 3,
              traceIds: ['trace-ok-22'],
            },
          ],
          joinedNotCompleted: 3,
          noDispatch: 4,
        },
      }),
    )
    assert.doesNotMatch(md, /恢复成功/)
    assert.match(md, /status=completed/)
    assert.match(md, /interrupted/)
    assert.match(md, /没有 dispatch_id 的 4 行/)
  })

  test('friction lists row counts and session counts together', () => {
    const report = base({
      friction: [{ code: 'service_restart', rows: 118, sessions: 3, distinctTraces: 3, traceIds: [] }],
    })
    const md = renderReport(report)
    assert.match(md, /行数/)
    assert.match(md, /会话数/)
    assert.match(md, /\| service_restart \| 118 \| 3 \| 3 \|/)
    const json = JSON.stringify(toPublicJson(report))
    assert.match(json, /"行数":118/)
    assert.match(json, /"会话数":3/)
    assert.doesNotMatch(json, /request_hash/)
  })

  test('both cohort modes are named, and a missing train dir says 未找到', () => {
    const excluded = renderReport(base())
    assert.match(excluded, /窗口：/)
    assert.match(excluded, new RegExp(cohortLines(false).h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(excluded, /user_id <> 765/)
    const included = renderReport(base({ include765: true }))
    assert.match(included, /含验收号 765/)
    const trains = trainSectionFromDir('/tmp/no-such-feedback-train-dir-xyz', 0, 1)
    assert.deepEqual(trains, { missing: true })
    assert.match(renderReport(base({ trains })), /未找到/)
  })

  test('train files are counted without copying notes or paths', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fb-trains-'))
    try {
      const now = Date.now()
      writeFileSync(
        path.join(dir, 'a.summary.json'),
        JSON.stringify({ final: true, note: 'SECRETNOTE', argv: 'do-not-copy' }),
      )
      writeFileSync(path.join(dir, 'b.summary.json'), JSON.stringify({ final: false, note: 'SECRETNOTE' }))
      writeFileSync(path.join(dir, 'c.summary.json'), JSON.stringify({ final: 'true', note: 'SECRETNOTE' }))
      writeFileSync(path.join(dir, 'skip.txt'), 'SECRETNOTE')
      const trains = trainSectionFromDir(dir, now - 60_000, now + 60_000)
      assert.deepEqual(trains, { missing: false, finalTrue: 1, finalFalse: 1 })
      const md = renderReport(base({ trains }))
      assert.match(md, /final 为 true 的文件 1 个/)
      assert.match(md, /final 为 false 的文件 1 个/)
      assert.doesNotMatch(md, /SECRETNOTE/)
      assert.doesNotMatch(md, /summary\.json/)
      assert.doesNotMatch(md, /do-not-copy/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
