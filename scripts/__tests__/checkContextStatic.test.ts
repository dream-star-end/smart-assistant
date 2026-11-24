/**
 * Unit & integration tests for scripts/check-context-static.ts (OCV5-885 Workstream 1).
 *
 * Run:
 *   npx tsx --test scripts/__tests__/checkContextStatic.test.ts
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_BASELINE_PATH,
  FIXTURE_NAMES,
  buildSyntheticFixtures,
  evaluateResidentContracts,
  evaluateSlotLedgerRatchet,
  evaluateSubEvalMetrics,
  readBaselineFile,
  runContextStaticGate,
  runStaticPrefixStabilityGuard,
  type ContextEvalBaseline,
  type FixtureName,
  type MeasuredFixture,
} from '../check-context-static.ts'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const FIXED_NOW_MS = Date.parse('2026-11-24T00:00:00Z')
const VALID_HEAD_COMMIT = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

function cloneBaseline(b: ContextEvalBaseline): ContextEvalBaseline {
  return JSON.parse(JSON.stringify(b)) as ContextEvalBaseline
}

function cloneMeasured(m: Record<FixtureName, MeasuredFixture>): Record<FixtureName, MeasuredFixture> {
  return JSON.parse(JSON.stringify(m)) as Record<FixtureName, MeasuredFixture>
}

function writeReceiptArtifact(
  repoRoot: string,
  relPath: string,
  payload: Record<string, unknown>,
): { receiptPath: string; receiptSha256: string; absPath: string } {
  const absPath = join(repoRoot, relPath)
  mkdirSync(dirname(absPath), { recursive: true })
  const raw = `${JSON.stringify(payload, null, 2)}\n`
  writeFileSync(absPath, raw, 'utf8')
  const receiptSha256 = createHash('sha256').update(Buffer.from(raw, 'utf8')).digest('hex')
  return { receiptPath: relPath, receiptSha256, absPath }
}

describe('OCV5-885 check-context-static guards', async () => {
  const realMeasured = await buildSyntheticFixtures()
  const realBaseline = readBaselineFile(DEFAULT_BASELINE_PATH)

  test('Guard 1: baseline file matches all 5 synthetic fixtures with 0 budget degradation', () => {
    const res = evaluateSlotLedgerRatchet(realMeasured, realBaseline, FIXED_NOW_MS)
    assert.equal(res.pass, true, `expected ratchet PASS, got issues: ${JSON.stringify(res.issues)}`)
    for (const name of FIXTURE_NAMES) {
      const f = res.fixtures[name]
      assert.ok(f.totalBytes > 0 && f.totalBytes <= 44_000, `${name} bytes=${f.totalBytes}`)
      assert.deepEqual(f.degradedReasons, [])
      assert.equal(f.deltaBytes, 0, `${name} should match exact initial baseline`)
    }
    assert.ok(realMeasured.research_turn.slots.RESEARCH! > 0, 'research_turn must include RESEARCH slot')
    assert.ok(realMeasured.project_memory_full.slots.PROJECT! > 0, 'project_memory_full must include PROJECT slot')
    assert.ok(
      realMeasured.project_memory_full.slots.PROJECT_MEMORY! > 0,
      'project_memory_full must include PROJECT_MEMORY slot',
    )
    assert.equal(
      realMeasured.wechat_turn.slots.INTELLIGENT_UI,
      undefined,
      'wechat_turn must NOT inject INTELLIGENT_UI slot',
    )
  })

  test('Guard 1: shrinking bytes passes monotonically; >+5% growth fails without waiver', () => {
    const shrunk = cloneMeasured(realMeasured)
    shrunk.webchat_first_turn.totalBytes -= 500
    assert.equal(
      evaluateSlotLedgerRatchet(shrunk, realBaseline, FIXED_NOW_MS).pass,
      true,
      'shrinking bytes must always pass',
    )

    const bloated = cloneMeasured(realMeasured)
    bloated.webchat_first_turn.totalBytes = Math.ceil(realBaseline.fixtures.webchat_first_turn.totalBytes * 1.08)
    const failRes = evaluateSlotLedgerRatchet(bloated, realBaseline, FIXED_NOW_MS)
    assert.equal(failRes.pass, false)
    assert.ok(failRes.issues.some((i) => i.code === 'TOTAL_BYTES_RATCHET_EXCEEDED'))
  })

  test('Guard 1: single-slot spike (>+15% and >+256B) fails even if totalBytes <= +5%', () => {
    const spiked = cloneMeasured(realMeasured)
    const baseTools = realBaseline.fixtures.webchat_first_turn.slots.TOOLS!
    spiked.webchat_first_turn.slots.TOOLS = baseTools + Math.max(400, Math.ceil(baseTools * 0.25))
    const res = evaluateSlotLedgerRatchet(spiked, realBaseline, FIXED_NOW_MS)
    assert.equal(res.pass, false)
    assert.ok(res.issues.some((i) => i.code === 'SLOT_BYTES_SPIKE' && i.target === 'webchat_first_turn.TOOLS'))
  })

  test('Guard 1: hard cap (>44_000B) and unexpected budget degradation fail unconditionally', () => {
    const overCap = cloneMeasured(realMeasured)
    overCap.project_memory_full.totalBytes = 44_001
    const resCap = evaluateSlotLedgerRatchet(overCap, realBaseline, FIXED_NOW_MS)
    assert.equal(resCap.pass, false)
    assert.ok(resCap.issues.some((i) => i.code === 'TOTAL_BYTES_CAP_EXCEEDED'))

    const degraded = cloneMeasured(realMeasured)
    degraded.project_memory_full.degradedReasons = ['skills_degraded_to_l0']
    const resDeg = evaluateSlotLedgerRatchet(degraded, realBaseline, FIXED_NOW_MS)
    assert.equal(resDeg.pass, false)
    assert.ok(resDeg.issues.some((i) => i.code === 'UNEXPECTED_BUDGET_DEGRADATION'))
  })

  test('Guard 1: valid <=30d waiver allows bounded growth; expired or >30d waiver fails', () => {
    const bloated = cloneMeasured(realMeasured)
    const targetBytes = Math.ceil(realBaseline.fixtures.webchat_first_turn.totalBytes * 1.08)
    bloated.webchat_first_turn.totalBytes = targetBytes

    const withValidWaiver = cloneBaseline(realBaseline)
    withValidWaiver.waivers.push({
      ticket: 'OCV5-999',
      fixture: 'webchat_first_turn',
      maxBytes: targetBytes + 100,
      expiresAt: '2026-12-09',
      reason: 'Temporary migration window during prompt refactor',
    })
    const passRes = evaluateSlotLedgerRatchet(bloated, withValidWaiver, FIXED_NOW_MS)
    assert.equal(passRes.pass, true, JSON.stringify(passRes.issues))
    assert.equal(passRes.waiversApplied.length, 1)
    assert.equal(passRes.waiversApplied[0]!.ticket, 'OCV5-999')

    const withExpired = cloneBaseline(realBaseline)
    withExpired.waivers.push({
      ticket: 'OCV5-998',
      fixture: 'webchat_first_turn',
      maxBytes: targetBytes + 100,
      expiresAt: '2026-11-20',
      reason: 'Already expired',
    })
    const expRes = evaluateSlotLedgerRatchet(bloated, withExpired, FIXED_NOW_MS)
    assert.equal(expRes.pass, false)
    assert.ok(expRes.issues.some((i) => i.code === 'TOTAL_BYTES_RATCHET_EXCEEDED'))

    const withLongTtl = cloneBaseline(realBaseline)
    withLongTtl.waivers.push({
      ticket: 'OCV5-997',
      fixture: 'webchat_first_turn',
      maxBytes: targetBytes + 100,
      expiresAt: '2027-02-01',
      reason: 'Too long TTL',
    })
    const ttlRes = evaluateSlotLedgerRatchet(bloated, withLongTtl, FIXED_NOW_MS)
    assert.equal(ttlRes.pass, false)
    assert.ok(ttlRes.issues.some((i) => i.code === 'WAIVER_TTL_EXCEEDS_30D'))
  })

  test('Guard 2: StaticPrefixStability proves 100% static prefix SHA256 identity & applyPromptFreeze reuse', async () => {
    const res = await runStaticPrefixStabilityGuard()
    assert.equal(res.pass, true, `StaticPrefixStability failed: ${JSON.stringify(res.issues)}`)
    assert.equal(res.turn1PrefixSha256, res.turn2PrefixSha256)
    assert.notEqual(res.turn1DynamicSha256, res.turn2DynamicSha256)
    assert.equal(res.agentsStaticSha256Equal, true)
    assert.equal(res.freezeReused, true)
    assert.equal(res.freezeDecision, 'reuse')
    assert.deepEqual(res.freezeStaticSlotsChanged, [])
    assert.ok(res.freezeChangedSlots.length > 0, 'dynamic slots should differ across turns')
  })

  test('Guard 3: ResidentContractGuard passes on current prompts and blocks bare skill pointer degradation', () => {
    const okRes = evaluateResidentContracts(realMeasured, realBaseline, FIXED_NOW_MS)
    assert.equal(okRes.pass, true, JSON.stringify(okRes.issues))
    assert.equal(okRes.checks.length, 4)

    const badIui = cloneMeasured(realMeasured)
    badIui.webchat_first_turn.iuiSlotContent = '按需加载 `/run/oc/platform/current/bin/oc-system skill ui`'
    const badIuiRes = evaluateResidentContracts(badIui, realBaseline, FIXED_NOW_MS)
    assert.equal(badIuiRes.pass, false)
    assert.ok(
      badIuiRes.issues.some(
        (i) =>
          i.code === 'CONTRACT_DEGRADED_TO_BARE_SKILL_POINTER' &&
          i.target === 'webchat_first_turn:iui_trigger_catalog',
      ),
    )

    const badPred = cloneMeasured(realMeasured)
    badPred.webchat_first_turn.iuiSlotContent =
      'table/chart/stats/compare/cards ```ui {"type":"table"}``` 按需加载 `/run/oc/platform/current/bin/oc-system skill input-prediction`'
    const badPredRes = evaluateResidentContracts(badPred, realBaseline, FIXED_NOW_MS)
    assert.equal(badPredRes.pass, false)
    assert.ok(
      badPredRes.issues.some(
        (i) =>
          i.code === 'CONTRACT_DEGRADED_TO_BARE_SKILL_POINTER' &&
          i.target === 'webchat_first_turn:input_prediction_inline',
      ),
    )

    const badOpts = cloneMeasured(realMeasured)
    badOpts.webchat_resumed_turn.content = '按需加载 `/run/oc/platform/current/bin/oc-system skill options`'
    const badOptsRes = evaluateResidentContracts(badOpts, realBaseline, FIXED_NOW_MS)
    assert.equal(badOptsRes.pass, false)
    assert.ok(badOptsRes.issues.some((i) => i.target === 'webchat_resumed_turn:options_block_schema'))

    const badGen = cloneMeasured(realMeasured)
    badGen.webchat_first_turn.content = badGen.webchat_first_turn.content.replaceAll(
      '/home/agent/.openclaude/generated/',
      '/removed/',
    )
    const badGenRes = evaluateResidentContracts(badGen, realBaseline, FIXED_NOW_MS)
    assert.equal(badGenRes.pass, false)
    assert.ok(badGenRes.issues.some((i) => i.target === 'webchat_first_turn:generated_dir_delivery'))
  })

  test('Guard 3 (Blocker #8): replayReceipts anti-forgery rejects missing/tampered/symlink/REJECT/partial/expired receipts', (t) => {
    const fakeRepo = mkdtempSync(join(tmpdir(), 'oc-receipt-repo-'))
    const outsideDir = mkdtempSync(join(tmpdir(), 'oc-receipt-outside-'))
    t.after(() => {
      rmSync(fakeRepo, { recursive: true, force: true })
      rmSync(outsideDir, { recursive: true, force: true })
    })

    const badPred = cloneMeasured(realMeasured)
    badPred.webchat_first_turn.iuiSlotContent =
      'table/chart/stats/compare/cards ```ui {"type":"table"}``` 按需加载 `/run/oc/platform/current/bin/oc-system skill input-prediction`'
    const livePromptSha = badPred.webchat_first_turn.contentSha256

    const validPayload = {
      schemaVersion: 1,
      verdict: 'ACCEPT',
      redlineViolations: 0,
      fullSuite: true,
      evaluatedCaseCount: 20,
      execModel: 'antigravity-gemini-4-neon',
      judgeModel: 'gpt-6.2-astra',
      promptSha: livePromptSha,
      headCommit: VALID_HEAD_COMMIT,
    }

    // 1. Valid in-repo receipt file PASSES
    const validArt = writeReceiptArtifact(fakeRepo, 'evals/receipts/valid.json', validPayload)
    const withValid = cloneBaseline(realBaseline)
    withValid.replayReceipts.push({
      ticket: 'OCV5-910',
      contract: 'input_prediction_inline',
      receiptPath: validArt.receiptPath,
      receiptSha256: validArt.receiptSha256,
      expiresAt: '2026-12-10',
      reason: 'Verified via cross-family live-pair replay eval',
    })
    const okRes = evaluateResidentContracts(badPred, withValid, FIXED_NOW_MS, fakeRepo)
    assert.equal(okRes.pass, true, JSON.stringify(okRes.issues))

    // 2. Missing file FAILS (cannot self-attest without real file)
    const withMissing = cloneBaseline(withValid)
    withMissing.replayReceipts[0]!.receiptPath = 'evals/receipts/does-not-exist.json'
    const missRes = evaluateResidentContracts(badPred, withMissing, FIXED_NOW_MS, fakeRepo)
    assert.equal(missRes.pass, false)
    assert.match(missRes.issues[0]!.message, /does not exist/)

    // 3. Tampered file bytes after receiptSha256 FAILS
    const tamperedArt = writeReceiptArtifact(fakeRepo, 'evals/receipts/tampered.json', validPayload)
    writeFileSync(tamperedArt.absPath, `${JSON.stringify({ ...validPayload, extra: 1 }, null, 2)}\n`, 'utf8')
    const withTampered = cloneBaseline(withValid)
    withTampered.replayReceipts[0]!.receiptPath = tamperedArt.receiptPath
    withTampered.replayReceipts[0]!.receiptSha256 = tamperedArt.receiptSha256
    const tamperRes = evaluateResidentContracts(badPred, withTampered, FIXED_NOW_MS, fakeRepo)
    assert.equal(tamperRes.pass, false)
    assert.match(tamperRes.issues[0]!.message, /receiptSha256 mismatch/)

    // 4. Symlinked receipt file FAILS
    const outsideArt = writeReceiptArtifact(outsideDir, 'outside.json', validPayload)
    const symPath = join(fakeRepo, 'evals/receipts/symlinked.json')
    symlinkSync(outsideArt.absPath, symPath)
    const withSymlink = cloneBaseline(withValid)
    withSymlink.replayReceipts[0]!.receiptPath = 'evals/receipts/symlinked.json'
    withSymlink.replayReceipts[0]!.receiptSha256 = outsideArt.receiptSha256
    const symRes = evaluateResidentContracts(badPred, withSymlink, FIXED_NOW_MS, fakeRepo)
    assert.equal(symRes.pass, false)
    assert.match(symRes.issues[0]!.message, /symlink/)

    // 5. Path traversal outside repo root FAILS
    const withTraversal = cloneBaseline(withValid)
    withTraversal.replayReceipts[0]!.receiptPath = '../outside.json'
    const travRes = evaluateResidentContracts(badPred, withTraversal, FIXED_NOW_MS, fakeRepo)
    assert.equal(travRes.pass, false)
    assert.match(travRes.issues[0]!.message, /escapes repo root/)

    // 6. REJECT verdict in receipt file FAILS
    const rejectArt = writeReceiptArtifact(fakeRepo, 'evals/receipts/reject.json', {
      ...validPayload,
      verdict: 'REJECT',
    })
    const withReject = cloneBaseline(withValid)
    withReject.replayReceipts[0]!.receiptPath = rejectArt.receiptPath
    withReject.replayReceipts[0]!.receiptSha256 = rejectArt.receiptSha256
    const rejRes = evaluateResidentContracts(badPred, withReject, FIXED_NOW_MS, fakeRepo)
    assert.equal(rejRes.pass, false)
    assert.match(rejRes.issues[0]!.message, /expected ACCEPT/)

    // 7. Non-zero redlineViolations or fullSuite !== true FAILS
    const redlineArt = writeReceiptArtifact(fakeRepo, 'evals/receipts/redline.json', {
      ...validPayload,
      redlineViolations: 1,
    })
    const withRedline = cloneBaseline(withValid)
    withRedline.replayReceipts[0]!.receiptPath = redlineArt.receiptPath
    withRedline.replayReceipts[0]!.receiptSha256 = redlineArt.receiptSha256
    assert.equal(evaluateResidentContracts(badPred, withRedline, FIXED_NOW_MS, fakeRepo).pass, false)

    const partialArt = writeReceiptArtifact(fakeRepo, 'evals/receipts/partial.json', {
      ...validPayload,
      fullSuite: false,
    })
    const withPartial = cloneBaseline(withValid)
    withPartial.replayReceipts[0]!.receiptPath = partialArt.receiptPath
    withPartial.replayReceipts[0]!.receiptSha256 = partialArt.receiptSha256
    assert.equal(evaluateResidentContracts(badPred, withPartial, FIXED_NOW_MS, fakeRepo).pass, false)

    // 8. Mismatched promptSha or non-40-hex headCommit FAILS
    const badShaArt = writeReceiptArtifact(fakeRepo, 'evals/receipts/badsha.json', {
      ...validPayload,
      promptSha: '0'.repeat(64),
    })
    const withBadSha = cloneBaseline(withValid)
    withBadSha.replayReceipts[0]!.receiptPath = badShaArt.receiptPath
    withBadSha.replayReceipts[0]!.receiptSha256 = badShaArt.receiptSha256
    assert.equal(evaluateResidentContracts(badPred, withBadSha, FIXED_NOW_MS, fakeRepo).pass, false)

    const shortCommitArt = writeReceiptArtifact(fakeRepo, 'evals/receipts/shortcommit.json', {
      ...validPayload,
      headCommit: 'abcdef123456',
    })
    const withShortCommit = cloneBaseline(withValid)
    withShortCommit.replayReceipts[0]!.receiptPath = shortCommitArt.receiptPath
    withShortCommit.replayReceipts[0]!.receiptSha256 = shortCommitArt.receiptSha256
    assert.equal(evaluateResidentContracts(badPred, withShortCommit, FIXED_NOW_MS, fakeRepo).pass, false)

    // 9. Expired or >30d TTL FAILS
    const withExpired = cloneBaseline(withValid)
    withExpired.replayReceipts[0]!.expiresAt = '2026-11-20'
    assert.equal(evaluateResidentContracts(badPred, withExpired, FIXED_NOW_MS, fakeRepo).pass, false)

    const withLongTtl = cloneBaseline(withValid)
    withLongTtl.replayReceipts[0]!.expiresAt = '2027-02-01'
    assert.equal(evaluateResidentContracts(badPred, withLongTtl, FIXED_NOW_MS, fakeRepo).pass, false)
  })

  test('Guard 4: evaluateSubEvalMetrics detects core memory & skill shadow regressions', () => {
    const healthyCore = {
      pass: true,
      precisionAt3: 1.0,
      mrr: 1.0,
      noMatchAccuracy: 1.0,
      avgHits: 1.97,
      corpusFiles: 15,
      avgHitsRatio: 1.97 / 15,
      casesPassed: 30,
      casesTotal: 30,
      elapsedMs: 120,
    }
    const healthySkill = {
      cases: 40,
      skillsWithEvals: 10,
      catalogSize: 42,
      routes: {
        existing_keyword_fallback: { recallAt3: 0.375, recallAt5: 0.45, hitsAt3: 15, hitsAt5: 18 },
        zh_lexical: { recallAt3: 0.55, recallAt5: 0.625, hitsAt3: 22, hitsAt5: 25 },
        char_ngram: { recallAt3: 0.725, recallAt5: 0.725, hitsAt3: 29, hitsAt5: 29 },
        bm25_multiquery: { recallAt3: 0.75, recallAt5: 0.8, hitsAt3: 30, hitsAt5: 32 },
      },
      elapsedMs: 90,
    }
    assert.deepEqual(evaluateSubEvalMetrics(healthyCore, healthySkill, realBaseline.subEvals), [])

    const regressedCore = { ...healthyCore, precisionAt3: 0.75 }
    const regressedSkill = {
      ...healthySkill,
      routes: {
        ...healthySkill.routes,
        bm25_multiquery: { recallAt3: 0.6, recallAt5: 0.7, hitsAt3: 24, hitsAt5: 28 },
      },
    }
    const issues = evaluateSubEvalMetrics(regressedCore, regressedSkill, realBaseline.subEvals)
    assert.ok(issues.some((i) => i.code === 'CORE_MEMORY_P3_REGRESSION'))
    assert.ok(issues.some((i) => i.code === 'SKILL_SHADOW_RECALL3_REGRESSION'))
    assert.ok(issues.some((i) => i.code === 'SKILL_SHADOW_RECALL5_REGRESSION'))
  })

  test('CLI --skip-sub-evals --json exits 0 with clean JSON report', async () => {
    const report = await runContextStaticGate({ skipSubEvals: true, nowMs: FIXED_NOW_MS })
    assert.equal(report.pass, true, JSON.stringify(report.issues))
    assert.equal(report.guards.subEvals.status, 'skipped')

    const tsxCli = join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs')
    const cmd = existsSync(tsxCli) ? process.execPath : 'npx'
    const args = existsSync(tsxCli)
      ? [tsxCli, join(REPO_ROOT, 'scripts/check-context-static.ts'), '--skip-sub-evals', '--json']
      : ['tsx', join(REPO_ROOT, 'scripts/check-context-static.ts'), '--skip-sub-evals', '--json']
    const r = spawnSync(cmd, args, { cwd: REPO_ROOT, encoding: 'utf8' })
    assert.equal(r.status, 0, `CLI exited ${r.status}: ${r.stderr}`)
    const parsed = JSON.parse(r.stdout) as { pass: boolean; guards: { subEvals: { status: string } } }
    assert.equal(parsed.pass, true)
    assert.equal(parsed.guards.subEvals.status, 'skipped')
  })
})
