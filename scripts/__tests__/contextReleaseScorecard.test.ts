import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  type AntigravityRelayRow,
  type ArmDataset,
  type ContextEvalTelemetry,
  type ProtocolTurnRow,
  type QueryFn,
  type TurnFactRow,
  aggregateSessionRate,
  analyzeAssistantProtocolText,
  classifyPromptDecision,
  collectAndEvaluate,
  computeCappedSessionWeights,
  computeWilsonInterval,
  evaluateScorecardVerdict,
  extractReleaseSha,
  parseArgs,
  redactSecrets,
  renderMarkdownScorecard,
  resolveAutoCommits,
  summarizeAntigravityDenoised,
  summarizePromptDecisionRows,
  turnPhaseOf,
  twoProportionZTest,
  validateOptionsBlockJson,
} from '../context-release-scorecard.js'

const PENDING_EVAL: ContextEvalTelemetry = {
  status: 'telemetry_pending_0353',
  tableExists: false,
  compaction: null,
  promptDecision: null,
}

function makeTurn(overrides: Partial<TurnFactRow> & { dispatchId: string; sessionId: string }): TurnFactRow {
  return {
    sessionKey: `agent:main:webchat:dm:${overrides.sessionId}`,
    mode: 'chat',
    model: 'deepseek-v4-flash',
    turnIndex: 1,
    outcome: 'completed',
    tapeStatus: 'completed',
    inputTokens: 1000,
    outputTokens: 300,
    cacheReadTokens: 9000,
    cacheWriteTokens: 0,
    costCredits: 100,
    hasUsageRecord: true,
    hasUsageError: false,
    isRewriteResend: false,
    explicitUp: 0,
    explicitDown: 0,
    isWebchat: true,
    ...overrides,
  }
}

function makeHealthyArm(args: {
  label: string
  sessions: number
  turnsPerSession: number
  cacheHitRatio?: number
  costCredits?: number
  rewriteEveryN?: number
  errorEveryN?: number
  uiEveryN?: number
  nextEveryN?: number
  model?: string
}): ArmDataset {
  const {
    label,
    sessions,
    turnsPerSession,
    cacheHitRatio = 0.9,
    costCredits = 100,
    rewriteEveryN = 0,
    errorEveryN = 0,
    uiEveryN = 2,
    nextEveryN = 1,
    model = 'deepseek-v4-flash',
  } = args

  const turns: TurnFactRow[] = []
  const protocolTurns: ProtocolTurnRow[] = []
  let seq = 0
  for (let s = 0; s < sessions; s++) {
    const sessionId = `${label}-sess-${s}`
    for (let t = 0; t < turnsPerSession; t++) {
      seq++
      const dispatchId = `${label}-d-${s}-${t}`
      const isErr = errorEveryN > 0 && seq % errorEveryN === 0
      const isRewrite = rewriteEveryN > 0 && seq % rewriteEveryN === 0
      const totalIn = 10_000
      const cacheRead = Math.round(totalIn * cacheHitRatio)
      const input = totalIn - cacheRead
      turns.push(
        makeTurn({
          dispatchId,
          sessionId,
          model,
          turnIndex: t + 1,
          outcome: isErr ? 'crashed' : 'completed',
          tapeStatus: isErr ? 'crashed' : 'completed',
          inputTokens: input,
          cacheReadTokens: cacheRead,
          costCredits,
          hasUsageError: false,
          isRewriteResend: !isErr && isRewrite,
        }),
      )
      if (!isErr) {
        protocolTurns.push({
          dispatchId,
          sessionId,
          hasRichUi: uiEveryN > 0 && seq % uiEveryN === 0,
          hasInputPrediction: nextEveryN > 0 && seq % nextEveryN === 0,
          optionsBlockCount: seq % 5 === 0 ? 1 : 0,
          optionsValidCount: seq % 5 === 0 ? 1 : 0,
        })
      }
    }
  }
  return {
    filter: { kind: 'commit', label, commitPrefix: label },
    turns,
    relayRows: [],
    protocolTurns,
    contextEval: PENDING_EVAL,
  }
}

describe('CLI argument parsing and secret redaction', () => {
  test('defaults to auto-commit markdown mode', () => {
    const opts = parseArgs([])
    assert.deepEqual(opts.spec, { kind: 'auto-commit', lookbackDays: 30 })
    assert.equal(opts.format, 'markdown')
    assert.equal(opts.minCompletedTurns, 50)
    assert.equal(opts.minDistinctSessions, 10)
    assert.equal(opts.sessionWeightCap, 0.25)
  })

  test('parses commit, window, hours, and json flags', () => {
    const c = parseArgs(['--before-commit', 'a1b2c3d4', '--after-commit', 'deadbeef1234', '--json'])
    assert.deepEqual(c.spec, {
      kind: 'commit',
      beforeCommit: 'a1b2c3d4',
      afterCommit: 'deadbeef1234',
    })
    assert.equal(c.format, 'json')

    const now = new Date('2026-11-24T12:00:00Z')
    const h = parseArgs(['--hours', '12', '--format', 'json'], now)
    assert.deepEqual(h.spec, {
      kind: 'window',
      beforeStart: '2026-11-23T12:00:00.000Z',
      beforeEnd: '2026-11-24T00:00:00.000Z',
      afterStart: '2026-11-24T00:00:00.000Z',
      afterEnd: '2026-11-24T12:00:00.000Z',
    })

    const w = parseArgs([
      '--before-window',
      '2026-11-20T00:00:00Z..2026-11-21T00:00:00Z',
      '--after-window',
      '2026-11-21T00:00:00Z..2026-11-22T00:00:00Z',
    ])
    assert.equal(w.spec.kind, 'window')
  })

  test('rejects invalid combinations and malformed commit prefixes', () => {
    assert.throws(() => parseArgs(['--before-commit', 'abc1234']))
    assert.throws(() => parseArgs(['--before-commit', 'abcd1234', '--after-commit', 'abcd1234']))
    assert.throws(() =>
      parseArgs(['--before-commit', 'abcd; DROP TABLE users', '--after-commit', '1234abcd']),
    )
    assert.throws(() =>
      parseArgs(['--before-commit', 'abcd1234', '--after-commit', '1234abcd', '--hours', '24']),
    )
    assert.throws(() =>
      parseArgs([
        '--before-window',
        '2026-11-22T00:00:00Z..2026-11-21T00:00:00Z',
        '--after-window',
        '2026-11-22T00:00:00Z..2026-11-23T00:00:00Z',
      ]),
    )
    assert.throws(() => parseArgs(['--format', 'yaml']))
  })

  test('redacts postgres connection strings from error messages', () => {
    const out = redactSecrets(
      'connect failed for postgresql://user:supersecret@127.0.0.1:5432/openclaude_v5_selfhost',
    )
    assert.ok(!out.includes('supersecret'))
    assert.ok(out.includes('postgres://[REDACTED]'))
  })
})

describe('implicit protocol parsing (```ui, {"type":"next"}, ```options)', () => {
  test('distinguishes rich ui blocks from trailing input-prediction next block', () => {
    const nextOnly = '你好，已完成。\n```ui\n{"type":"next","text":"帮我运行单测"}\n```'
    const a1 = analyzeAssistantProtocolText(nextOnly)
    assert.equal(a1.hasRichUi, false)
    assert.equal(a1.hasInputPrediction, true)

    const both = [
      '对比如下：',
      '```ui',
      '{"type":"table","columns":["A","B"],"rows":[["1","2"]]}',
      '```',
      '```ui',
      '{"type":"next","text":"导出 CSV"}',
      '```',
    ].join('\n')
    const a2 = analyzeAssistantProtocolText(both)
    assert.equal(a2.hasRichUi, true)
    assert.equal(a2.hasInputPrediction, true)
  })

  test('validates ```options JSON schema accurately', () => {
    assert.equal(
      validateOptionsBlockJson('{"question":"风格?","options":[{"label":"正式"},{"label":"轻松"}]}'),
      true,
    )
    assert.equal(
      validateOptionsBlockJson('{"questions":[{"question":"Q1","options":["A","B"]}]}'),
      true,
    )
    assert.equal(validateOptionsBlockJson('["选项1","选项2"]'), true)
    assert.equal(validateOptionsBlockJson('{"question":"空","options":[]}'), false)
    assert.equal(validateOptionsBlockJson('{invalid json'), false)
    assert.equal(
      validateOptionsBlockJson(
        JSON.stringify({ options: Array.from({ length: 13 }, (_, i) => `opt-${i}`) }),
      ),
      false,
    )

    const text = [
      '```options',
      '{"question":"选一个","options":[{"label":"A"},{"label":"B"}]}',
      '```',
      '```options',
      'not-valid-json',
      '```',
    ].join('\n')
    const res = analyzeAssistantProtocolText(text)
    assert.equal(res.optionsBlockCount, 2)
    assert.equal(res.optionsValidCount, 1)
  })
})

describe('anti-Goodhart statistical primitives', () => {
  test('caps a single flooding session strictly at 25% weight after normalization', () => {
    const sessions = [
      { sessionId: 'spammer', n: 80 },
      ...Array.from({ length: 9 }, (_, i) => ({ sessionId: `normal-${i}`, n: 2 })),
    ]
    const weights = computeCappedSessionWeights(sessions, 0.25)
    const sum = Array.from(weights.values()).reduce((a, b) => a + b, 0)
    assert.ok(Math.abs(sum - 1) < 1e-9, `weights must sum to 1, got ${sum}`)
    assert.ok((weights.get('spammer') ?? 0) <= 0.25 + 1e-12)
    assert.ok(Math.abs((weights.get('spammer') ?? 0) - 0.25) < 1e-9)
    // Remaining 0.75 split equally across 9 normal sessions
    assert.ok(Math.abs((weights.get('normal-0') ?? 0) - 0.75 / 9) < 1e-9)
  })

  test('computes valid Wilson CI and two-proportion z-test', () => {
    const [lo, hi] = computeWilsonInterval(0.8, 100)
    assert.ok(lo > 0.7 && lo < 0.8)
    assert.ok(hi > 0.8 && hi < 0.9)

    const sig = twoProportionZTest(0.9, 100, 0.7, 100)
    assert.ok(sig.pValue < 0.001)

    const ns = twoProportionZTest(0.85, 60, 0.84, 60)
    assert.ok(ns.pValue > 0.5)
  })

  test('aggregateSessionRate downweights Kish effective sample size under imbalance', () => {
    const balanced = Array.from({ length: 10 }, (_, i) => ({
      sessionId: `s-${i}`,
      numerator: 9,
      denominator: 10,
    }))
    const aggBalanced = aggregateSessionRate(balanced, 0.25)
    assert.ok(Math.abs(aggBalanced.effectiveSampleSize - 100) < 1e-6)

    const skewed = [
      { sessionId: 'spammer', numerator: 0, denominator: 80 },
      ...Array.from({ length: 9 }, (_, i) => ({
        sessionId: `normal-${i}`,
        numerator: 2,
        denominator: 2,
      })),
    ]
    const aggSkewed = aggregateSessionRate(skewed, 0.25)
    assert.ok(aggSkewed.rawRate! < 0.2) // Naive raw rate is hijacked (~18.4%)
    assert.ok(aggSkewed.weightedRate! >= 0.749) // Capped weighted rate protects majority (75.0%)
    assert.ok(aggSkewed.effectiveSampleSize < 40) // Kish Neff shrinks from 98 down to ~31
  })
})

describe('anti-Goodhart verdict engine', () => {
  test('returns INCONCLUSIVE when completedTurns < 50 (never REJECT even on extreme drop)', () => {
    // 48 turns across 12 sessions (< 50 threshold!) with catastrophic cache drop 95% -> 10%
    const before = makeHealthyArm({ label: 'before', sessions: 12, turnsPerSession: 4, cacheHitRatio: 0.95 })
    const after = makeHealthyArm({ label: 'after', sessions: 12, turnsPerSession: 4, cacheHitRatio: 0.1 })

    const report = evaluateScorecardVerdict(before, after)
    assert.equal(report.sampleGatePassed, false)
    assert.equal(report.verdict, 'INCONCLUSIVE')
    assert.equal(report.rollbackRecommended, false)
    assert.equal(report.breaches.length, 0)
    assert.ok(report.inconclusiveReasons.some((r) => r.includes('completedTurns=48 < 50')))
    // Still exposes actual measured metrics
    assert.ok((report.metrics.resumedMainCacheHitRate.before.weightedRate ?? 0) > 0.9)
    assert.ok((report.metrics.resumedMainCacheHitRate.after.weightedRate ?? 1) < 0.2)
  })

  test('returns INCONCLUSIVE when distinctSessions < 10 (even with >= 50 turns)', () => {
    // 9 sessions x 10 turns = 90 turns, but only 9 sessions (< 10 threshold!)
    const before = makeHealthyArm({ label: 'before', sessions: 9, turnsPerSession: 10, cacheHitRatio: 0.9 })
    const after = makeHealthyArm({ label: 'after', sessions: 9, turnsPerSession: 10, cacheHitRatio: 0.2 })

    const report = evaluateScorecardVerdict(before, after)
    assert.equal(report.sampleGatePassed, false)
    assert.equal(report.verdict, 'INCONCLUSIVE')
    assert.equal(report.rollbackRecommended, false)
    assert.ok(report.inconclusiveReasons.some((r) => r.includes('distinctSessions=9 < 10')))
  })

  test('suppresses false REJECT when 1 heavy session spams 80 degraded turns while 9+ sessions stay healthy', () => {
    const before = makeHealthyArm({
      label: 'before',
      sessions: 12,
      turnsPerSession: 6,
      cacheHitRatio: 0.9,
      costCredits: 100,
    })
    const after = makeHealthyArm({
      label: 'after',
      sessions: 11,
      turnsPerSession: 6,
      cacheHitRatio: 0.9,
      costCredits: 100,
    })
    // Add 1 heavy spammer session with 80 degraded turns (10% cache hit, 100% rewrite-resend, 300 credits)
    for (let i = 0; i < 80; i++) {
      const dispatchId = `spam-d-${i}`
      after.turns.push(
        makeTurn({
          dispatchId,
          sessionId: 'heavy-spammer-session',
          turnIndex: i + 1,
          inputTokens: 9000,
          cacheReadTokens: 1000,
          costCredits: 300,
          isRewriteResend: true,
        }),
      )
      after.protocolTurns.push({
        dispatchId,
        sessionId: 'heavy-spammer-session',
        hasRichUi: false,
        hasInputPrediction: false,
        optionsBlockCount: 0,
        optionsValidCount: 0,
      })
    }

    const report = evaluateScorecardVerdict(before, after)
    assert.equal(report.sampleGatePassed, true)
    // Raw unweighted cache hit plummeted due to the 80-turn spammer
    assert.ok((report.metrics.resumedMainCacheHitRate.after.rawRate ?? 1) < 0.5)
    // Capped session weight kept spammer <= 25% AND cluster bootstrap prevented false REJECT
    assert.ok(report.metrics.resumedMainCacheHitRate.after.maxCappedSessionWeight <= 0.25 + 1e-12)
    assert.equal(report.verdict, 'PASS')
    assert.equal(report.rollbackRecommended, false)
  })

  test('triggers REJECT on real systemic resumed cache regression (>8pp) across >=10 sessions & >=50 turns', () => {
    const before = makeHealthyArm({
      label: 'before',
      sessions: 12,
      turnsPerSession: 6,
      cacheHitRatio: 0.9,
    })
    const after = makeHealthyArm({
      label: 'after',
      sessions: 12,
      turnsPerSession: 6,
      cacheHitRatio: 0.72, // -18pp systemic drop
    })

    const report = evaluateScorecardVerdict(before, after)
    assert.equal(report.sampleGatePassed, true)
    assert.equal(report.verdict, 'REJECT')
    assert.equal(report.rollbackRecommended, true)
    assert.ok(report.breaches.some((b) => b.id === 'resumed_main_cache_hit_rate'))
  })

  test('triggers REJECT on cost spike (>20%), protocol drop (>40% rel & >=5pp abs), and rewrite-resend spike (>5pp & >=1.5x)', () => {
    const before = makeHealthyArm({
      label: 'before',
      sessions: 12,
      turnsPerSession: 6,
      cacheHitRatio: 0.9,
      costCredits: 100,
      rewriteEveryN: 20, // 5%
      uiEveryN: 2, // 50%
      nextEveryN: 1, // 100%
    })
    const after = makeHealthyArm({
      label: 'after',
      sessions: 12,
      turnsPerSession: 6,
      cacheHitRatio: 0.9,
      costCredits: 145, // +45% (> +20%)
      rewriteEveryN: 5, // 20% (+15pp, 4x)
      uiEveryN: 10, // 10% (-80% rel, -40pp abs)
      nextEveryN: 4, // 25% (-75% rel, -75pp abs)
    })

    const report = evaluateScorecardVerdict(before, after)
    assert.equal(report.verdict, 'REJECT')
    assert.equal(report.rollbackRecommended, true)
    const ids = new Set(report.breaches.map((b) => b.id))
    assert.ok(ids.has('avg_cost_credits_per_turn'))
    assert.ok(ids.has('ui_component_trigger_rate'))
    assert.ok(ids.has('input_prediction_trigger_rate'))
    assert.ok(ids.has('rewrite_resend_rate'))
  })

  test('Antigravity flash-lite denoising prevents false cache regression when flash-lite traffic surges', () => {
    const makeAgyArm = (label: string, flashLitePromptPerTurn: number, mainCacheRatio: number): ArmDataset => {
      const arm = makeHealthyArm({
        label,
        sessions: 12,
        turnsPerSession: 6,
        model: 'antigravity-gemini-4-neon',
        cacheHitRatio: 0.5, // polluted usage_records number to verify relay denoising takes precedence
      })
      const relayRows: AntigravityRelayRow[] = arm.turns.map((t) => ({
        dispatchId: t.dispatchId,
        sessionId: t.sessionId,
        routeModelId: 'antigravity-gemini-4-neon',
        turnIndex: t.turnIndex,
        mainCalls: 4,
        mainPromptTokens: 100_000,
        mainCachedTokens: Math.round(100_000 * mainCacheRatio),
        flashLiteCalls: flashLitePromptPerTurn > 0 ? 12 : 1,
        flashLitePromptTokens: flashLitePromptPerTurn,
        flashLiteCachedTokens: 0,
      }))
      return { ...arm, relayRows }
    }

    // Before: low flash-lite traffic; After: massive flash-lite surge (80,000 uncached tokens/turn)
    // Raw cache hit drops from 89% to 50% (-39pp!), while main model stays steady at 92% -> 91%.
    const before = makeAgyArm('before', 1_000, 0.92)
    const after = makeAgyArm('after', 80_000, 0.91)

    const beforeDenoised = summarizeAntigravityDenoised(before.relayRows, 0.25, 200, 0)
    const afterDenoised = summarizeAntigravityDenoised(after.relayRows, 0.25, 200, 0)
    assert.equal(beforeDenoised.length, 1)
    assert.ok(Math.abs((beforeDenoised[0]!.denoisedCacheHitRate ?? 0) - 0.92) < 1e-6)
    assert.ok(Math.abs((afterDenoised[0]!.denoisedCacheHitRate ?? 0) - 0.91) < 1e-6)
    // Raw cache hit on after is dragged down to ~50.6% by flash-lite
    assert.ok((afterDenoised[0]!.rawCacheHitRate ?? 1) < 0.52)
    assert.ok((afterDenoised[0]!.flashLiteCallShare ?? 0) > 0.7)

    // Verdict uses denoised main cache -> PASS (no false alarm!)
    const reportPass = evaluateScorecardVerdict(before, after)
    assert.equal(reportPass.verdict, 'PASS')
    assert.equal(reportPass.rollbackRecommended, false)

    // Now simulate a REAL main-model cache drop (92% -> 75%) -> REJECT!
    const afterRealDrop = makeAgyArm('after-drop', 1_000, 0.75)
    const reportReject = evaluateScorecardVerdict(before, afterRealDrop)
    assert.equal(reportReject.verdict, 'REJECT')
    assert.ok(reportReject.breaches.some((b) => b.id === 'resumed_main_cache_hit_rate'))
  })

  test('supports both 0-indexed (0=first, >=1=resumed) and 1-indexed (1=first, >=2=resumed) turn_index conventions', () => {
    assert.equal(turnPhaseOf(0, 0), 'first')
    assert.equal(turnPhaseOf(1, 0), 'resumed')
    assert.equal(turnPhaseOf(1, 1), 'first')
    assert.equal(turnPhaseOf(2, 1), 'resumed')
    assert.equal(turnPhaseOf(null, 1), 'unknown')
  })
})

describe('DB collector read-only safety & context_eval_events graceful degradation', () => {
  test('degrades gracefully to telemetry_pending_0353 when context_eval_events does not exist, and runs only read-only SQL', async () => {
    const seenSql: string[] = []
    const q: QueryFn = async (sql) => {
      seenSql.push(sql)
      if (sql.includes("to_regclass('public.context_eval_events')")) {
        return [{ tbl: null }] as never
      }
      return [] as never
    }

    const opts = parseArgs(['--before-commit', 'aaaa1111', '--after-commit', 'bbbb2222'])
    const report = await collectAndEvaluate(q, opts, new Date('2026-11-24T12:00:00Z'))

    assert.equal(report.before.contextEval.status, 'telemetry_pending_0353')
    assert.equal(report.after.contextEval.status, 'telemetry_pending_0353')
    assert.equal(report.before.contextEval.tableExists, false)
    assert.equal(report.verdict, 'INCONCLUSIVE')

    // Never queried context_eval_events table when to_regclass returned null
    assert.equal(
      seenSql.some((s) => s.includes('FROM context_eval_events')),
      false,
    )
    // Every single query is strictly read-only SELECT / WITH ... SELECT
    for (const sql of seenSql) {
      assert.match(sql.trim(), /^(SELECT|WITH)\b/i, sql)
      assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/i, sql)
    }

    const md = renderMarkdownScorecard(report)
    assert.ok(md.includes('telemetry_pending_0353'))
    assert.ok(md.includes('INCONCLUSIVE'))
  })

  test('collects compaction and prompt_context_decision metrics when context_eval_events exists, including dispatch_id IS NULL compactions and full decision enums', async () => {
    const seenSql: string[] = []
    const q: QueryFn = async (sql) => {
      seenSql.push(sql)
      if (sql.includes("to_regclass('public.context_eval_events')")) {
        return [{ tbl: 'context_eval_events' }] as never
      }
      if (sql.includes("column_name = 'runtime_source_commit'")) {
        return [{ has_col: true }] as never
      }
      if (sql.includes('SUM(before_bytes)')) {
        return [
          {
            event_count: '12',
            distinct_sessions: '8',
            before_bytes: '480000',
            after_bytes: '96000',
            before_tokens: '120000',
            after_tokens: '24000',
            dropped_entries: '64',
          },
        ] as never
      }
      if (sql.includes('compaction_scope')) {
        return [{ scope: 'session', strategy: 'anchored_v2', n: '12' }] as never
      }
      if (sql.includes('next_tapes')) {
        return [{ follow_turns: '20', non_completed: '1', rewrite_resend: '2' }] as never
      }
      if (sql.includes("event_kind = 'prompt_context_decision'") && sql.includes('GROUP BY 1')) {
        if (sql.includes('unnest')) {
          return [
            { slot: 'DYNAMIC_MEMORY_INDEX', n: '15' },
            { slot: 'COLLABORATOR_AGENTS', n: '5' },
          ] as never
        }
        return [
          { decision: 'elide_resumed', n: '30' },
          { decision: 'reuse', n: '15' },
          { decision: 'prompt_freeze_reuse', n: '25' },
          { decision: 'full_inject', n: '10' },
          { decision: 'fresh_inputs', n: '5' },
          { decision: 'prompt_freeze_fresh_inputs', n: '5' },
          { decision: 'expired', n: '5' },
          { decision: 'prompt_freeze_expired', n: '5' },
          // First-turn decisions MUST be excluded from reuse denominator!
          { decision: 'fresh_first', n: '40' },
          { decision: 'prompt_freeze_fresh_first', n: '35' },
          { decision: 'fresh_conversation', n: '25' },
        ] as never
      }
      return [] as never
    }

    const opts = parseArgs(['--before-commit', 'aaaa1111', '--after-commit', 'bbbb2222'])
    const report = await collectAndEvaluate(q, opts, new Date('2026-11-24T12:00:00Z'))

    assert.equal(report.before.contextEval.status, 'available')
    assert.equal(report.before.contextEval.tableExists, true)
    assert.equal(report.before.contextEval.compaction?.eventCount, 12)
    assert.ok(Math.abs((report.before.contextEval.compaction?.byteCompressionRatio ?? 0) - 0.2) < 1e-6)
    assert.ok(
      Math.abs((report.before.contextEval.compaction?.postCompactionNonCompletedRate ?? 0) - 0.05) <
        1e-6,
    )
    assert.ok(
      Math.abs((report.before.contextEval.compaction?.postCompactionRewriteRate ?? 0) - 0.1) < 1e-6,
    )
    // Reuse numerator = 30 + 15 + 25 = 70; Non-reuse = 10 + 5 + 5 + 5 + 5 = 30; Eligible = 100; First-turn excluded = 100
    assert.equal(report.before.contextEval.promptDecision?.elideOrReuseCount, 70)
    assert.equal(report.before.contextEval.promptDecision?.eligibleCount, 100)
    assert.equal(report.before.contextEval.promptDecision?.firstTurnExcludedCount, 100)
    assert.ok(
      Math.abs((report.before.contextEval.promptDecision?.elideOrReuseRate ?? 0) - 0.7) < 1e-6,
    )
    assert.equal(
      report.before.contextEval.promptDecision?.topChangedSlots[0]?.slot,
      'DYNAMIC_MEMORY_INDEX',
    )

    // Verify Blocker #2 SQL: LEFT JOIN + COALESCE(e.runtime_source_commit, tro.runtime_source_commit)
    // AND session_key + timestamp fallback for dispatch_id IS NULL compactions!
    const evalSql = seenSql.filter((s) => s.includes('FROM context_eval_events'))
    assert.ok(evalSql.length > 0)
    for (const s of evalSql) {
      assert.match(
        s,
        /LEFT JOIN tro_by_dispatch tro ON tro\.dispatch_id = COALESCE\(e\.dispatch_id, tt_late\.dispatch_id\)/,
      )
      assert.match(s, /COALESCE\(e\.runtime_source_commit, tro\.runtime_source_commit\)/)
      assert.doesNotMatch(s, /JOIN cohort c ON c\.dispatch_id = e\.dispatch_id/)
    }
    const postCompSql = seenSql.find((s) => s.includes('next_by_session_time'))
    assert.ok(postCompSql, 'post-compaction SQL must include session_key + timestamp fallback')
    assert.match(postCompSql, /'c:' \|\| cp\.user_id::text/)
    assert.match(postCompSql, /cp\.session_key LIKE '%:' \|\| t\.session_id/)
    assert.match(postCompSql, /EXTRACT\(EPOCH FROM cp\.observed_at\)/)

    const md = renderMarkdownScorecard(report)
    assert.ok(md.includes('DYNAMIC_MEMORY_INDEX(15)'))
    assert.ok(md.includes('70.0%'))
  })

  test('Blocker #5: resolveAutoCommits picks freshly deployed recent commit over older high-volume commits', async () => {
    const q: QueryFn = async (sql) => {
      if (sql.includes("to_regclass('public.deploy_state')")) {
        return [{ tbl: null }] as never
      }
      if (sql.includes('FROM turn_runtime_observations')) {
        // Ordered by MAX(observed_at) DESC:
        // C (brand new release, 18 obs), probe (2 obs noise), B (older, 500 obs), A (oldest, 1000 obs)
        return [
          {
            commit: 'cccccccccccccccccccccccccccccccccccccccc',
            obs_count: '18',
            dispatches: '15',
            first_at: '2026-11-24T10:00:00Z',
            last_at: '2026-11-24T12:00:00Z',
          },
          {
            commit: '1111111111111111111111111111111111111111',
            obs_count: '2',
            dispatches: '2',
            first_at: '2026-11-24T09:00:00Z',
            last_at: '2026-11-24T09:05:00Z',
          },
          {
            commit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            obs_count: '500',
            dispatches: '450',
            first_at: '2026-11-22T00:00:00Z',
            last_at: '2026-11-23T23:00:00Z',
          },
          {
            commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            obs_count: '1000',
            dispatches: '900',
            first_at: '2026-11-18T00:00:00Z',
            last_at: '2026-11-21T23:00:00Z',
          },
        ] as never
      }
      return [] as never
    }

    const resolved = await resolveAutoCommits(q, 30)
    // Must evaluate C (newest active >=3 obs) against B (immediately preceding active), NEVER skip C for A vs B!
    assert.equal(resolved.after.commitPrefix, 'cccccccccccc')
    assert.equal(resolved.before.commitPrefix, 'bbbbbbbbbbbb')
  })

  test('Blocker #5: resolveAutoCommits honors deploy_state active_release / committed_sha when observed', async () => {
    assert.equal(
      extractReleaseSha('/opt/openclaude/openclaude-v5-selfhost-releases/rel-9e1f875f4-20261124-092944'),
      '9e1f875f4',
    )
    assert.equal(extractReleaseSha('deadbeef12345678'), 'deadbeef12345678')

    const q: QueryFn = async (sql) => {
      if (sql.includes("to_regclass('public.deploy_state')")) {
        return [{ tbl: 'deploy_state' }] as never
      }
      if (sql.includes("table_name = 'deploy_state'")) {
        return [
          { column_name: 'active_release' },
          { column_name: 'previous_active_release' },
        ] as never
      }
      if (sql.includes('FROM deploy_state')) {
        return [
          {
            active_release: '/opt/openclaude/releases/rel-9e1f875f4-20261124-092944',
            previous_active_release: '/opt/openclaude/releases/rel-d919a1dfc-20261124-071119',
          },
        ] as never
      }
      if (sql.includes('FROM turn_runtime_observations')) {
        return [
          {
            commit: '9e1f875f40000000000000000000000000000000',
            obs_count: '2',
            dispatches: '2',
            first_at: '2026-11-24T09:30:00Z',
            last_at: '2026-11-24T09:35:00Z',
          },
          {
            commit: 'd919a1dfcc840000000000000000000000000000',
            obs_count: '60',
            dispatches: '55',
            first_at: '2026-11-24T07:15:00Z',
            last_at: '2026-11-24T09:20:00Z',
          },
          {
            commit: '8675139469a40000000000000000000000000000',
            obs_count: '900',
            dispatches: '800',
            first_at: '2026-11-20T00:00:00Z',
            last_at: '2026-11-23T00:00:00Z',
          },
        ] as never
      }
      return [] as never
    }

    const resolved = await resolveAutoCommits(q, 30)
    assert.equal(resolved.after.commitPrefix, '9e1f875f4000')
    assert.equal(resolved.before.commitPrefix, 'd919a1dfcc84')
  })

  test('Blocker #6: classifyPromptDecision and summarizePromptDecisionRows bucket all reuse/non-reuse/first-turn enums accurately', () => {
    for (const d of ['elide_resumed', 'reuse', 'prompt_freeze_reuse']) {
      assert.equal(classifyPromptDecision(d), 'reuse', d)
    }
    for (const d of [
      'full_inject',
      'fresh_inputs',
      'prompt_freeze_fresh_inputs',
      'expired',
      'prompt_freeze_expired',
    ]) {
      assert.equal(classifyPromptDecision(d), 'non_reuse', d)
    }
    for (const d of ['fresh_first', 'prompt_freeze_fresh_first', 'fresh_conversation']) {
      assert.equal(classifyPromptDecision(d), 'first_turn_excluded', d)
    }

    const summary = summarizePromptDecisionRows(
      [
        { decision: 'prompt_freeze_reuse', n: 8 },
        { decision: 'prompt_freeze_fresh_inputs', n: 2 },
        { decision: 'prompt_freeze_fresh_first', n: 50 },
        { decision: 'full_inject', reason: 'fresh_conversation', n: 30 },
      ],
      [{ slot: 'MEMORY_INDEX', n: 2 }],
    )
    assert.equal(summary.eventCount, 90)
    assert.equal(summary.firstTurnExcludedCount, 80)
    assert.equal(summary.eligibleCount, 10)
    assert.equal(summary.elideOrReuseCount, 8)
    assert.ok(Math.abs((summary.elideOrReuseRate ?? 0) - 0.8) < 1e-9)
  })

  test('Blocker #5 residual: deploy_state newest SHA with 0 observations is NEVER replaced by older A/B commits', async () => {
    const q: QueryFn = async (sql) => {
      if (sql.includes("to_regclass('public.deploy_state')")) {
        return [{ tbl: 'deploy_state' }] as never
      }
      if (sql.includes("table_name = 'deploy_state'")) {
        return [{ column_name: 'active_release' }, { column_name: 'previous_active_release' }] as never
      }
      if (sql.includes('FROM deploy_state')) {
        return [
          {
            active_release: 'rel-cccccccccccc-20261124-100000',
            previous_active_release: 'rel-bbbbbbbbbbbb-20261124-080000',
          },
        ] as never
      }
      if (sql.includes('FROM turn_runtime_observations')) {
        return [
          {
            commit: 'bbbbbbbbbbbb0000000000000000000000000000',
            obs_count: '500',
            dispatches: '480',
            first_at: '2026-11-24T08:00:00Z',
            last_at: '2026-11-24T09:59:00Z',
          },
          {
            commit: 'aaaaaaaaaaaa0000000000000000000000000000',
            obs_count: '1000',
            dispatches: '950',
            first_at: '2026-11-23T00:00:00Z',
            last_at: '2026-11-24T07:59:00Z',
          },
        ] as never
      }
      return [] as never
    }

    const resolved = await resolveAutoCommits(q, 30)
    assert.equal(resolved.after.commitPrefix, 'cccccccccccc')
    assert.equal(resolved.before.commitPrefix, 'bbbbbbbbbbbb')
  })
})
