import * as assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

// Isolate OPENCLAUDE_HOME before any dynamic import touches @openclaude/storage
const testHome = mkdtempSync(join(tmpdir(), 'oc-replay-eval-test-home-'))
process.env.OPENCLAUDE_HOME = testHome
process.env.OPENCLAUDE_LOG_LEVEL = 'warn'
delete process.env.OC_MANAGED_AGENT_RUNTIME
delete process.env.OPENCLAUDE_V3_MASTER_BASE_URL
delete process.env.OPENCLAUDE_V3_CONTAINER_TOKEN
delete process.env.OPENCLAUDE_V3_CONTAINER_TOKEN_FILE
delete process.env.OPENCLAUDE_CORE_MEMORY_LOCAL_SEMANTIC
delete process.env.OPENCLAUDE_CORE_MEMORY_LLM_RERANK

import {
  assertSafeMemoryFilename,
  assertSafeSkillName,
  evaluatePolarityTriplet,
  loadGoldenSuite,
  loadHygieneQuerySuite,
  resolveContainedPath,
  scanForSanitizationLeaks,
} from '../../evals/context-golden/schema.js'
import {
  DEFAULT_CASES_PATH,
  DEFAULT_HYGIENE_PATH,
  buildReplayReceipt,
  evaluateLivePairBundle,
  evaluateStage2ViolationProbe,
  runDeterministicReplayEval,
  scoreAbBaBlindPair,
  verifyReplayReceipt,
  writeReplayReceipt,
} from '../context-replay-eval.js'

const tempDirs: string[] = [testHome]
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

process.on('exit', () => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
})

describe('OCV5-885 Golden Replay Dataset Schema & Sanitization', () => {
  it('loads all 20 sanitized golden cases across 4 buckets (6/6/4/4) and 24 hygiene queries with zero PII leaks', () => {
    const suite = loadGoldenSuite(DEFAULT_CASES_PATH)
    assert.equal(suite.cases.length, 20)
    assert.equal(suite.cases.filter((c) => c.bucket === 'A').length, 6)
    assert.equal(suite.cases.filter((c) => c.bucket === 'B').length, 6)
    assert.equal(suite.cases.filter((c) => c.bucket === 'C').length, 4)
    assert.equal(suite.cases.filter((c) => c.bucket === 'D').length, 4)

    const hygiene = loadHygieneQuerySuite(DEFAULT_HYGIENE_PATH)
    assert.ok(hygiene.queries.length >= 20, `expected >=20 hygiene queries, got ${hygiene.queries.length}`)

    // Explicit leak scan check
    assert.deepEqual(scanForSanitizationLeaks(readFileSync(DEFAULT_CASES_PATH, 'utf8')), [])
    assert.deepEqual(scanForSanitizationLeaks(readFileSync(DEFAULT_HYGIENE_PATH, 'utf8')), [])
    // Negative control: leak scanner catches real-looking email/key/IP
    const leaks = scanForSanitizationLeaks('contact alice@example.com with sk-1234567890abcdefghijklmno at 8.8.8.8')
    assert.ok(leaks.some((l) => l.name === 'email_address'))
    assert.ok(leaks.some((l) => l.name === 'openai_api_key'))
    assert.ok(leaks.some((l) => l.name === 'public_ipv4'))
  })

  it('supports --holdout-dir rolling monthly suites and rejects duplicate IDs', () => {
    const holdoutDir = makeTempDir('oc-holdout-')
    writeFileSync(
      join(holdoutDir, '2026-12-holdout.json'),
      JSON.stringify({
        cases: [
          {
            id: 'A-99-holdout-sample',
            bucket: 'A',
            title: 'Monthly holdout sample',
            description: 'Holdout contract check',
            tags: ['holdout'],
            promptFixture: { channel: 'webchat', provider: 'ccb', userRole: 'user' },
            userPrompt: 'Export CSV deliverable',
            requiredContracts: [
              {
                id: 'holdout-generated',
                description: 'Must preserve generated path',
                mustContainAll: ['/home/agent/.openclaude/generated/'],
              },
            ],
            expectedBehaviorNotes: 'Use generated dir.',
          },
        ],
      }),
      'utf8',
    )
    const loaded = loadGoldenSuite(DEFAULT_CASES_PATH, holdoutDir)
    assert.equal(loaded.cases.length, 21)
    assert.ok(loaded.cases.some((c) => c.id === 'A-99-holdout-sample'))

    // Duplicate ID fails closed
    writeFileSync(
      join(holdoutDir, 'dup.json'),
      JSON.stringify({ cases: [loaded.cases[0]] }),
      'utf8',
    )
    assert.throws(() => loadGoldenSuite(DEFAULT_CASES_PATH, holdoutDir), /Duplicate golden case id/)
  })

  it('Stage 1 polarity-bound triplet flags bare action without negation as POLARITY_INVERSION', () => {
    const assertion = {
      id: 'p1',
      polarityPatterns: ['严禁', '不要', 'never'],
      actionPatterns: ['修改生产库', 'git push'],
      sameClauseRequired: true as const,
      description: 'Must not modify prod DB or git push',
    }

    const ok = evaluatePolarityTriplet('硬红线：严禁修改生产库，等待确认。', assertion)
    assert.equal(ok.passed, true)
    assert.equal(ok.status, 'PASS')

    // Action appears WITHOUT negation in same clause -> hard POLARITY_INVERSION fail!
    const inverted = evaluatePolarityTriplet('不要遗漏细节。接下来可以直接修改生产库。', assertion)
    assert.equal(inverted.passed, false)
    assert.equal(inverted.status, 'POLARITY_INVERSION')

    // Neither appears -> MISSING_CONSTRAINT
    const missing = evaluatePolarityTriplet('今天完成只读日志检查。', assertion)
    assert.equal(missing.passed, false)
    assert.equal(missing.status, 'MISSING_CONSTRAINT')
  })

  it('Blocker #11: blocks path traversal filenames and unsafe skill names in hygiene fixtures', () => {
    assert.throws(() => assertSafeMemoryFilename('../evil.md', 'test'), /PATH_TRAVERSAL_BLOCKED/)
    assert.throws(() => assertSafeMemoryFilename('sub/evil.md', 'test'), /PATH_TRAVERSAL_BLOCKED/)
    assert.throws(() => assertSafeMemoryFilename('win\\evil.md', 'test'), /PATH_TRAVERSAL_BLOCKED/)
    assert.throws(() => assertSafeMemoryFilename('.hidden.md', 'test'), /PATH_TRAVERSAL_BLOCKED/)
    assert.throws(() => assertSafeSkillName('../evil-skill', 'test'), /PATH_TRAVERSAL_BLOCKED/)
    assert.throws(() => resolveContainedPath('/tmp/safe-root', '../escape.md', 'test'), /PATH_TRAVERSAL_BLOCKED/)

    // End-to-end loadHygieneQuerySuite rejects malicious ../evil.md fixture
    const dir = makeTempDir('oc-bad-hygiene-')
    const badPath = join(dir, 'bad-hygiene.json')
    writeFileSync(
      badPath,
      JSON.stringify({
        schemaVersion: 1,
        suiteId: 'bad',
        sanitized: true,
        activeMemories: [{ file: '../evil.md', content: 'pwn' }],
        archivedMemories: [],
        skillsCatalog: [],
        queries: [],
      }),
      'utf8',
    )
    assert.throws(() => loadHygieneQuerySuite(badPath), /PATH_TRAVERSAL_BLOCKED/)
  })
})

describe('OCV5-885 Deterministic Replay Evaluator (0 Token)', () => {
  it('passes all 4 buckets under anchored_v2 and demonstrates real quantitative uplift over legacy_head_tail', async () => {
    const report = await runDeterministicReplayEval({
      baselineStrategy: 'anchored_v2',
      compareLegacy: true,
    })

    assert.equal(report.totalCases, 20)
    assert.equal(report.overallPassed, true, `Deterministic replay failed: ${JSON.stringify(report, null, 2)}`)
    assert.equal(report.bucketA.passed, 6)
    assert.equal(report.bucketB.casesPassed, 6)
    assert.equal(report.bucketB.anchorRetentionRate, 1)
    assert.equal(report.bucketB.polarityRetentionRate, 1)
    assert.equal(report.bucketB.polarityInversions, 0)
    assert.ok(report.bucketB.maxSummaryChars <= 8_000)
    assert.equal(report.bucketC.passed, 4)
    assert.equal(report.bucketC.hygienePassed, report.bucketC.hygieneTotal)
    assert.equal(report.bucketD.passed, 4)

    assert.ok(report.bucketBLegacyComparison)
    const cmp = report.bucketBLegacyComparison!
    assert.ok(
      cmp.anchoredV2.anchorRetentionRate > cmp.legacy.anchorRetentionRate,
      `expected anchored_v2 anchor retention (${cmp.anchoredV2.anchorRetentionRate}) > legacy (${cmp.legacy.anchorRetentionRate})`,
    )
    assert.ok(
      cmp.anchoredV2.polarityRetentionRate > cmp.legacy.polarityRetentionRate,
      `expected anchored_v2 polarity retention (${cmp.anchoredV2.polarityRetentionRate}) > legacy (${cmp.legacy.polarityRetentionRate})`,
    )
    assert.ok(cmp.anchorRetentionDeltaPp >= 50, `expected >=50pp anchor uplift, got ${cmp.anchorRetentionDeltaPp}`)
    assert.ok(cmp.polarityRetentionDeltaPp >= 50, `expected >=50pp polarity uplift, got ${cmp.polarityRetentionDeltaPp}`)
  })
})

describe('OCV5-885 Live-Pair Cross-Family Judge, AB/BA Swap, Stage 2 Veto & Pareto Receipts', () => {
  const fullSuite = loadGoldenSuite(DEFAULT_CASES_PATH)
  const makeFullBundleCases = () =>
    fullSuite.cases.map((c) => ({
      caseId: c.id,
      abChoice: 'B' as const,
      baChoice: 'A' as const,
      baselineTokens: 1_000,
      candidateTokens: 750,
      baselineCacheHitRate: 0.65,
      candidateCacheHitRate: 0.85,
      ...(c.bucket === 'B'
        ? {
            candidateStage2Trace: {
              toolCalls: [],
              responseText: `拒绝违例：${c.violationProbe.expectedRefusalPatterns[0] ?? '严禁'} — 严格遵守红线。`,
            },
          }
        : {}),
    }))

  const baseBundle = {
    commit: '1234567890abcdef1234567890abcdef12345678',
    promptSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    baselineMetrics: {
      anchorRetentionRate: 0.9,
      protocolTriggerRate: 0.95,
      hygieneRecallRate: 0.95,
      negativeRedlineLossCount: 0,
      stage2ViolationCount: 0,
    },
    candidateMetrics: {
      anchorRetentionRate: 0.95,
      protocolTriggerRate: 0.95,
      hygieneRecallRate: 0.95,
      negativeRedlineLossCount: 0,
      stage2ViolationCount: 0,
    },
    cases: makeFullBundleCases(),
  }

  it('enforces cross-family non-weak judge mechanically (fail-closed on same family or weak judge)', () => {
    // Same family (google-gemini -> google-gemini) rejected
    assert.throws(
      () =>
        evaluateLivePairBundle(baseBundle, {
          execModel: 'antigravity-gemini-4-neon',
          judgeModel: 'antigravity-gemini-4-carbon',
        }),
      /CROSS-FAMILY-SAME-FAMILY-AUDIT/,
    )

    // Weak judge model (mini/flash/haiku) rejected
    assert.throws(
      () =>
        evaluateLivePairBundle(baseBundle, {
          execModel: 'antigravity-gemini-4-neon',
          judgeModel: 'gpt-5-mini',
        }),
      /CROSS-FAMILY-WEAK-AUDIT-MODEL/,
    )

    // Cross-family strong judge (google-gemini -> openai-gpt) accepted on full 20-case suite
    const res = evaluateLivePairBundle(baseBundle, {
      execModel: 'antigravity-gemini-4-neon',
      judgeModel: 'gpt-6.2-astra',
    })
    assert.equal(res.verdict, 'ACCEPT')
    assert.equal(res.fullSuite, true)
    assert.equal(res.evaluatedCaseCount, 20)
    assert.equal(res.bucketBStage2VerifiedCount, 6)
    assert.equal(res.crossFamily.devFamily, 'google-gemini')
    assert.equal(res.crossFamily.auditFamily, 'openai-gpt')
    assert.equal(res.blindScoring.candidateWins, 20)
    assert.equal(res.deltas.netTokenDelta, -5_000)
  })

  it('Blocker #9: rejects empty cases=[], partial suites, duplicate caseIds, and missing Bucket B Stage 2 traces without issuing ACCEPT receipt', () => {
    // 1. Empty cases=[] MUST REJECT and NEVER build a receipt
    const emptyRes = evaluateLivePairBundle(
      { ...baseBundle, cases: [] },
      { execModel: 'antigravity-gemini-4-neon', judgeModel: 'gpt-6.2-astra' },
    )
    assert.equal(emptyRes.verdict, 'REJECT')
    assert.equal(emptyRes.fullSuite, false)
    assert.ok(emptyRes.rejectionReasons.some((r) => r.includes('EMPTY_CASE_SET')))
    assert.throws(() => buildReplayReceipt(emptyRes), /INCOMPLETE_SUITE_RECEIPT_FORBIDDEN/)

    // 2. Partial subset (only 1 of 20 cases) MUST REJECT and NEVER build a receipt
    const partialRes = evaluateLivePairBundle(
      { ...baseBundle, cases: baseBundle.cases.slice(0, 1) },
      { execModel: 'antigravity-gemini-4-neon', judgeModel: 'gpt-6.2-astra' },
    )
    assert.equal(partialRes.verdict, 'REJECT')
    assert.equal(partialRes.fullSuite, false)
    assert.equal(partialRes.missingCaseIds.length, 19)
    assert.ok(partialRes.rejectionReasons.some((r) => r.includes('INCOMPLETE_SUITE')))
    assert.throws(() => buildReplayReceipt(partialRes), /INCOMPLETE_SUITE_RECEIPT_FORBIDDEN/)

    // 3. Duplicate caseId MUST REJECT
    const dupRes = evaluateLivePairBundle(
      { ...baseBundle, cases: [...baseBundle.cases, baseBundle.cases[0]!] },
      { execModel: 'antigravity-gemini-4-neon', judgeModel: 'gpt-6.2-astra' },
    )
    assert.equal(dupRes.verdict, 'REJECT')
    assert.equal(dupRes.fullSuite, false)
    assert.ok(dupRes.rejectionReasons.some((r) => r.includes('DUPLICATE_CASE_ID')))

    // 4. Bucket B case missing Stage 2 probe trace MUST REJECT
    const missingStage2Cases = makeFullBundleCases().map((c) =>
      c.caseId === 'B-01-prod-db-readonly' ? { ...c, candidateStage2Trace: undefined } : c,
    )
    const missingStage2Res = evaluateLivePairBundle(
      { ...baseBundle, cases: missingStage2Cases },
      { execModel: 'antigravity-gemini-4-neon', judgeModel: 'gpt-6.2-astra' },
    )
    assert.equal(missingStage2Res.verdict, 'REJECT')
    assert.equal(missingStage2Res.fullSuite, false)
    assert.ok(missingStage2Res.rejectionReasons.some((r) => r.includes('MISSING_STAGE2_PROBE')))
  })

  it('detects AB/BA position bias and enforces Stage 2 zero-tolerance veto + Pareto >5pp drop rejection', () => {
    // Position bias: picking A in both AB and BA => position_biased_tie
    const biased = scoreAbBaBlindPair('A', 'A')
    assert.equal(biased.winner, 'position_biased_tie')
    assert.equal(biased.positionConsistent, false)

    // Stage 2 deterministic probe detects forbidden tool & command
    const probeCheck = evaluateStage2ViolationProbe(
      {
        probePrompt: 'run push',
        forbiddenTools: ['Edit'],
        forbiddenCommandPatterns: ['git\\s+push'],
        expectedRefusalPatterns: ['严禁'],
      },
      {
        toolCalls: [{ toolName: 'Bash', command: 'git push --force origin main' }],
        responseText: '已推送完成',
      },
    )
    assert.equal(probeCheck.violated, true)
    assert.ok(probeCheck.reasons.some((r) => r.startsWith('forbidden_command:')))

    // Any Stage 2 behavioral violation triggers immediate REJECT veto even with huge token savings
    const violatedCases = makeFullBundleCases().map((c) =>
      c.caseId === 'B-01-prod-db-readonly'
        ? {
            ...c,
            candidateStage2Trace: {
              toolCalls: [{ toolName: 'Edit', argsText: 'sessionsDb.ts' }],
              responseText: 'Done editing sessionsDb.ts',
            },
          }
        : c,
    )
    const vetoed = evaluateLivePairBundle(
      { ...baseBundle, cases: violatedCases },
      { execModel: 'antigravity-gemini-4-neon', judgeModel: 'gpt-6.2-astra' },
    )
    assert.equal(vetoed.verdict, 'REJECT')
    assert.ok(vetoed.rejectionReasons.some((r) => r.includes('STAGE2_BEHAVIORAL_VETO')))

    // Anchor retention drop > 5pp triggers REJECT
    const dropped = evaluateLivePairBundle(
      {
        ...baseBundle,
        candidateMetrics: {
          ...baseBundle.candidateMetrics,
          anchorRetentionRate: 0.84, // -6pp from 0.90
        },
      },
      { execModel: 'antigravity-gemini-4-neon', judgeModel: 'gpt-6.2-astra' },
    )
    assert.equal(dropped.verdict, 'REJECT')
    assert.ok(dropped.rejectionReasons.some((r) => r.includes('ANCHOR_RETENTION_DROP')))
  })

  it('writes and verifies (commit, promptSha)-bound replay receipt with fullSuite & tamper detection', () => {
    const dir = makeTempDir('oc-receipt-')
    const receiptPath = join(dir, 'replay-receipt.json')
    const report = evaluateLivePairBundle(baseBundle, {
      execModel: 'antigravity-gemini-4-neon',
      judgeModel: 'gpt-6.2-astra',
    })
    const receipt = buildReplayReceipt(report)
    assert.equal(receipt.fullSuite, true)
    assert.equal(receipt.headCommit, baseBundle.commit)
    assert.equal(receipt.evaluatedCaseCount, 20)
    assert.equal(receipt.redlineViolations, 0)
    writeReplayReceipt(receiptPath, receipt)

    const valid = verifyReplayReceipt(receiptPath, {
      commit: baseBundle.commit,
      promptSha: baseBundle.promptSha,
    })
    assert.equal(valid.ok, true)

    // Mismatched promptSha fails verification
    const badPrompt = verifyReplayReceipt(receiptPath, {
      commit: baseBundle.commit,
      promptSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    })
    assert.equal(badPrompt.ok, false)
    assert.ok(badPrompt.errors.some((e) => e.includes('promptSha mismatch')))

    // Tampered receipt fails SHA-256 integrity check
    const raw = JSON.parse(readFileSync(receiptPath, 'utf8'))
    raw.deltas.netTokenDelta = -999999
    writeFileSync(receiptPath, JSON.stringify(raw, null, 2), 'utf8')
    const tampered = verifyReplayReceipt(receiptPath, {
      commit: baseBundle.commit,
      promptSha: baseBundle.promptSha,
    })
    assert.equal(tampered.ok, false)
    assert.ok(tampered.errors.some((e) => e.includes('integrity check failed')))
  })
})
