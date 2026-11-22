import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  buildVlmJudgePrompt,
  evaluateVlmResponse,
  loadVlmRubric,
  shouldTriggerVlmJudge,
  validateVlmRubric,
} from '../check-vlm-aesthetic-judge.ts'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts/check-vlm-aesthetic-judge.ts')

function makeResponse(
  scores: Record<string, number>,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    observations: [
      { zone: 'top-bar', finding: '顶栏按钮与标题基线对齐，右侧间距 12px 均匀' },
      { zone: 'composer', finding: '输入坞圆角与表面 token 一致，暗色边框清晰' },
    ],
    scores,
    defects: [],
    summary: '整体视觉工艺与层级清晰。',
    ...extra,
  })
}

function runCli(
  args: string[],
  envOverrides: Record<string, string | undefined> = {},
): { status: number; stdout: string; stderr: string } {
  const cleanEnv: NodeJS.ProcessEnv = { ...process.env }
  for (const key of [
    'OC_VLM_JUDGE_API_KEY',
    'VLM_JUDGE_API_KEY',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
  ]) {
    delete cleanEnv[key]
  }
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete cleanEnv[k]
    else cleanEnv[k] = v
  }
  const res = spawnSync(process.execPath, ['--import', 'tsx', SCRIPT_PATH, ...args], {
    cwd: REPO_ROOT,
    env: cleanEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return {
    status: res.status ?? 1,
    stdout: String(res.stdout ?? ''),
    stderr: String(res.stderr ?? ''),
  }
}

describe('L6 VLM Aesthetic Rubric Judge (scripts/check-vlm-aesthetic-judge.ts)', () => {
  it('loads and validates rubric.json with 5 dimensions, thresholds, temperature=0, $0.50 cap, advisory mode', () => {
    const rubric = loadVlmRubric()
    assert.equal(rubric.schemaVersion, 1)
    assert.equal(rubric.mode, 'advisory')
    assert.equal(rubric.calibrationWeeks, 2)
    assert.equal(rubric.temperature, 0)
    assert.equal(rubric.hardRejectFloor, 3.5)
    assert.equal(rubric.maxCostUsdPerPr, 0.5)
    assert.equal(rubric.maxRoundsPerPr, 2)

    const byId = new Map(rubric.dimensions.map((d) => [d.id, d]))
    assert.equal(byId.get('craft')?.minScore, 4.0)
    assert.equal(byId.get('hierarchy_density')?.minScore, 4.0)
    assert.equal(byId.get('design_system_coherence')?.minScore, 4.0)
    assert.equal(byId.get('anti_slop_restraint')?.minScore, 3.5)
    assert.equal(byId.get('interactive_usability')?.minScore, 4.0)

    assert.throws(
      () => validateVlmRubric({ ...rubric, temperature: 0.7 }),
      /VLM-RUBRIC-INVALID/,
    )
  })

  it('shouldTriggerVlmJudge: precisely filters high-risk UI surfaces and skips T0/local bugfixes at $0 cost', () => {
    const rubric = loadVlmRubric()

    // High-risk triggers
    assert.equal(
      shouldTriggerVlmJudge(['packages/web-react/src/styles.css'], [], { rubric }).trigger,
      true,
    )
    assert.equal(
      shouldTriggerVlmJudge(['packages/web-react/src/components/ui/Button.tsx'], [], { rubric })
        .trigger,
      true,
    )
    for (const shellPath of [
      'packages/web-react/src/App.tsx',
      'packages/web-react/src/components/Sidebar.tsx',
      'packages/web-react/src/components/InspectorPanel.tsx',
      'packages/web-react/src/components/Composer.tsx',
      'packages/web-react/src/components/chat/SwarmBoardDrawer.tsx',
    ]) {
      const dec = shouldTriggerVlmJudge([shellPath], [], { rubric })
      assert.equal(dec.trigger, true, `expected shell path to trigger: ${shellPath}`)
    }
    // New top-level center page (status A) triggers
    assert.equal(
      shouldTriggerVlmJudge(
        [{ path: 'packages/web-react/src/components/AnalyticsCenter.tsx', status: 'A' }],
        [],
        { rubric },
      ).trigger,
      true,
    )
    // ui-redesign label triggers even on non-shell files
    const labelDec = shouldTriggerVlmJudge(
      ['packages/web-react/src/components/ToolCard.tsx'],
      ['ui-redesign'],
      { rubric },
    )
    assert.equal(labelDec.trigger, true)
    assert.deepEqual(labelDec.matchedLabels, ['ui-redesign'])

    // Non-triggers -> skip with $0 cost
    const t0Skip = shouldTriggerVlmJudge(
      ['packages/commercial/src/billing/ledger.ts', 'docs/V5_CI.md', 'scripts/check-ui-hard-gates.ts'],
      [],
      { rubric },
    )
    assert.equal(t0Skip.trigger, false)
    assert.equal(t0Skip.estimatedCostUsd, 0)

    const localBugSkip = shouldTriggerVlmJudge(
      [
        { path: 'packages/web-react/src/components/ToolCard.tsx', status: 'M' },
        { path: 'packages/web-react/src/components/SettingsCenter.tsx', status: 'M' },
        { path: 'packages/web-react/src/components/Composer.test.tsx', status: 'M' },
        { path: 'packages/web-react/src/components/ui/Button.test.tsx', status: 'M' },
      ],
      ['bugfix'],
      { rubric },
    )
    assert.equal(localBugSkip.trigger, false)
    assert.equal(localBugSkip.estimatedCostUsd, 0)
  })

  it('buildVlmJudgePrompt: enforces adversarial persona, CoT zone-by-zone observations before scoring, and few-shot anchors', () => {
    const rubric = loadVlmRubric()
    const prompt = buildVlmJudgePrompt(rubric, {
      prTitle: 'Refresh sidebar density',
      changedFiles: ['packages/web-react/src/components/Sidebar.tsx'],
      scenes: ['sidebar-overview'],
      viewports: ['mobile', 'desktop'],
      themes: ['light', 'dark'],
      round: 1,
    })
    assert.equal(prompt.temperature, 0)
    assert.equal(prompt.responseFormat, 'json_object')
    assert.match(prompt.system, /独立挑刺设计审计员/)
    assert.match(prompt.system, /先逐区列出像素级观察缺陷/)
    assert.match(prompt.system, /Few-shot 标定锚点/)
    for (const dim of rubric.dimensions) {
      assert.match(prompt.system, new RegExp(dim.id))
    }
    assert.match(prompt.user, /Sidebar\.tsx/)
  })

  it('evaluateVlmResponse: passes high scores, hard-rejects <3.5, flags 3.5-3.9 for review, and distinguishes advisory vs enforce', () => {
    const rubric = loadVlmRubric()

    // High scores PASS in both advisory and enforce
    const highJson = makeResponse({
      craft: 4.4,
      hierarchy_density: 4.3,
      design_system_coherence: 4.5,
      anti_slop_restraint: 4.1,
      interactive_usability: 4.2,
    })
    const passEnforce = evaluateVlmResponse(highJson, rubric, {
      mode: 'enforce',
      costUsd: 0.16,
      round: 1,
    })
    assert.equal(passEnforce.ok, true)
    assert.equal(passEnforce.blocked, false)
    assert.equal(passEnforce.verdict, 'pass')
    assert.equal(passEnforce.exitCode, 0)
    assert.ok((passEnforce.weightedScore ?? 0) >= 4.2)

    // Single dimension < 3.5 -> hard-reject
    const lowJson = makeResponse({
      craft: 4.2,
      hierarchy_density: 4.1,
      design_system_coherence: 4.3,
      anti_slop_restraint: 3.2,
      interactive_usability: 4.0,
    })
    const rejectEnforce = evaluateVlmResponse(lowJson, rubric, {
      mode: 'enforce',
      costUsd: 0.2,
      round: 1,
    })
    assert.equal(rejectEnforce.ok, false)
    assert.equal(rejectEnforce.blocked, true)
    assert.equal(rejectEnforce.verdict, 'hard-reject')
    assert.equal(rejectEnforce.exitCode, 1)
    assert.equal(rejectEnforce.hardRejectDimensions.length, 1)
    assert.equal(rejectEnforce.hardRejectDimensions[0].id, 'anti_slop_restraint')
    assert.match(rejectEnforce.errors[0], /\[GATE-ERROR\] VLM-AESTHETIC-HARD-REJECT/)

    const rejectAdvisory = evaluateVlmResponse(lowJson, rubric, {
      mode: 'advisory',
      costUsd: 0.2,
      round: 1,
    })
    assert.equal(rejectAdvisory.ok, true)
    assert.equal(rejectAdvisory.blocked, false)
    assert.equal(rejectAdvisory.advisoryWarning, true)
    assert.equal(rejectAdvisory.verdict, 'hard-reject')
    assert.equal(rejectAdvisory.exitCode, 0)

    // 3.5-3.9 range -> needs-review (still passes anti_slop_restraint at 3.5 since its target is 3.5)
    const reviewJson = makeResponse({
      craft: 3.8,
      hierarchy_density: 4.1,
      design_system_coherence: 4.0,
      anti_slop_restraint: 3.5,
      interactive_usability: 4.2,
    })
    const reviewEnforce = evaluateVlmResponse(reviewJson, rubric, {
      mode: 'enforce',
      costUsd: 0.18,
      round: 1,
    })
    assert.equal(reviewEnforce.ok, false)
    assert.equal(reviewEnforce.blocked, true)
    assert.equal(reviewEnforce.needsHumanReview, true)
    assert.equal(reviewEnforce.verdict, 'needs-review')
    assert.equal(reviewEnforce.exitCode, 1)
    assert.deepEqual(
      reviewEnforce.reviewDimensions.map((d) => d.id),
      ['craft'],
    )

    const reviewAdvisory = evaluateVlmResponse(reviewJson, rubric, {
      mode: 'advisory',
      costUsd: 0.18,
      round: 1,
    })
    assert.equal(reviewAdvisory.ok, true)
    assert.equal(reviewAdvisory.advisoryWarning, true)
    assert.equal(reviewAdvisory.needsHumanReview, true)
    assert.equal(reviewAdvisory.verdict, 'needs-review')
    assert.equal(reviewAdvisory.exitCode, 0)
  })

  it('evaluateVlmResponse fail-closed: blocks >$0.50 budget, >2 rounds, and malformed/incomplete JSON even in advisory mode', () => {
    const rubric = loadVlmRubric()
    const validHigh = makeResponse({
      craft: 4.5,
      hierarchy_density: 4.5,
      design_system_coherence: 4.5,
      anti_slop_restraint: 4.5,
      interactive_usability: 4.5,
    })

    // Budget exceeded > $0.50 blocks in BOTH advisory and enforce
    const overBudget = evaluateVlmResponse(validHigh, rubric, {
      mode: 'advisory',
      costUsd: 0.51,
      round: 1,
    })
    assert.equal(overBudget.ok, false)
    assert.equal(overBudget.blocked, true)
    assert.equal(overBudget.verdict, 'budget-exceeded')
    assert.equal(overBudget.exitCode, 1)
    assert.match(overBudget.errors[0], /VLM-JUDGE-BUDGET-EXCEEDED/)

    // Round > 2 blocks
    const overRounds = evaluateVlmResponse(validHigh, rubric, {
      mode: 'advisory',
      costUsd: 0.3,
      round: 3,
    })
    assert.equal(overRounds.ok, false)
    assert.equal(overRounds.verdict, 'round-limit-exceeded')
    assert.equal(overRounds.exitCode, 1)

    // Malformed JSON -> fail-closed
    const malformed = evaluateVlmResponse('{not-json', rubric, { mode: 'advisory', costUsd: 0.1 })
    assert.equal(malformed.ok, false)
    assert.equal(malformed.verdict, 'invalid-response')
    assert.equal(malformed.exitCode, 1)

    // Missing CoT observations -> fail-closed
    const noObs = evaluateVlmResponse(
      JSON.stringify({
        observations: [],
        scores: {
          craft: 4.5,
          hierarchy_density: 4.5,
          design_system_coherence: 4.5,
          anti_slop_restraint: 4.5,
          interactive_usability: 4.5,
        },
      }),
      rubric,
      { mode: 'advisory', costUsd: 0.1 },
    )
    assert.equal(noObs.ok, false)
    assert.equal(noObs.verdict, 'invalid-response')
    assert.equal(noObs.exitCode, 1)

    // Missing dimension or out-of-range score -> fail-closed
    const outOfRange = evaluateVlmResponse(
      makeResponse({
        craft: 5.5,
        hierarchy_density: 4.2,
        design_system_coherence: 4.2,
        anti_slop_restraint: 4.0,
        interactive_usability: 4.2,
      }),
      rubric,
      { mode: 'advisory', costUsd: 0.1 },
    )
    assert.equal(outOfRange.ok, false)
    assert.equal(outOfRange.verdict, 'invalid-response')
    assert.equal(outOfRange.exitCode, 1)
  })

  it('CLI --dry-run gracefully skips non-trigger paths and handles missing API key by mode', () => {
    const skip = runCli([
      '--dry-run',
      '--changed-files',
      'packages/commercial/src/billing/ledger.ts,docs/V5_CI.md',
    ])
    assert.equal(skip.status, 0)
    assert.match(skip.stdout, /SKIP \(cost=\$0\.00/)

    const triggerDryRun = runCli([
      '--dry-run',
      '--changed-files',
      'packages/web-react/src/styles.css',
    ])
    assert.equal(triggerDryRun.status, 0)
    assert.match(triggerDryRun.stdout, /DRY-RUN TRIGGERED/)
    assert.match(triggerDryRun.stdout, /not configured/)

    const advisoryNoKey = runCli([
      '--changed-files',
      'packages/web-react/src/styles.css',
      '--mode',
      'advisory',
    ])
    assert.equal(advisoryNoKey.status, 0)
    assert.match(advisoryNoKey.stderr, /\[VLM-ADVISORY\]/)

    const enforceNoKey = runCli([
      '--changed-files',
      'packages/web-react/src/styles.css',
      '--mode',
      'enforce',
    ])
    assert.equal(enforceNoKey.status, 1)
    assert.match(enforceNoKey.stderr, /VLM-JUDGE-NO-API-KEY/)
  })
})
