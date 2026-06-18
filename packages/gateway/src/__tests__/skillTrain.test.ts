/**
 * Tests for the v3 skill-training engine (draft mode, DeepSeek-locked).
 *
 * Run:
 *   npx tsx --test packages/mcp-memory/src/__tests__/skillTrain.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  SKILL_TRAIN_DEFAULT_MODEL,
  buildSkillTrainContext,
  buildSkillTrainPrompt,
  isNestedSkillTrainBlocked,
  normalizeSkillTrainArgs,
} from '../skillTrain.js'

describe('normalizeSkillTrainArgs', () => {
  it('requires a valid runId', () => {
    assert.throws(() => normalizeSkillTrainArgs({ runId: '' }, 'main'))
    assert.throws(() => normalizeSkillTrainArgs({ runId: 'bad id!' }, 'main'))
  })

  it('applies defaults and clamps bounds', () => {
    const n = normalizeSkillTrainArgs(
      { runId: 'run-1', lookbackHours: 9999, maxSessions: 0, maxProposals: 99 },
      'agent-x',
    )
    assert.equal(n.runId, 'run-1')
    assert.equal(n.targetAgentId, 'agent-x')
    assert.equal(n.lookbackHours, 168) // clamped to max
    assert.equal(n.maxSessions, 1) // clamped to min
    assert.equal(n.maxProposals, 10) // clamped to max
    assert.equal(n.model, SKILL_TRAIN_DEFAULT_MODEL)
  })

  it('locks model to a DeepSeek variant (rejects arbitrary models)', () => {
    const flash = normalizeSkillTrainArgs({ runId: 'r', model: 'deepseek-v4-flash' }, 'main')
    assert.equal(flash.model, 'deepseek-v4-flash')
    // Non-DeepSeek model falls back to the default DeepSeek model — never honored.
    const claude = normalizeSkillTrainArgs(
      { runId: 'r', model: 'claude-opus-4-7' as never },
      'main',
    )
    assert.equal(claude.model, SKILL_TRAIN_DEFAULT_MODEL)
  })

  it('passes through targetSkill and focus when present', () => {
    const n = normalizeSkillTrainArgs(
      { runId: 'r', targetSkill: 'deploy-flow', focus: 'deployment' },
      'main',
    )
    assert.equal(n.targetSkill, 'deploy-flow')
    assert.equal(n.focus, 'deployment')
  })
})

describe('buildSkillTrainPrompt', () => {
  const base = normalizeSkillTrainArgs({ runId: 'run-xyz', targetSkill: 'deploy-flow' }, 'main')
  const prompt = buildSkillTrainPrompt(base, new Date('2026-06-18T00:00:00.000Z'))

  it('instructs draft mode via skill_propose and forbids authoritative writes', () => {
    assert.match(prompt, /skill_propose/)
    assert.match(prompt, /Do NOT call\s+`skill_save`, `skill_delete`, or `skill_train_auto`/)
    assert.match(prompt, /runId="run-xyz"/)
  })

  it('forbids editing platform baseline / agent-seed skills', () => {
    assert.match(prompt, /NEVER propose changes to platform baseline or agent-seed skills/)
  })

  it('embeds the locked model and the lookback window', () => {
    assert.match(prompt, /Training model: deepseek-v4-pro/)
    assert.match(prompt, /2026-06-17T00:00:00\.000Z through 2026-06-18T00:00:00\.000Z/)
  })

  it('names the target skill when provided', () => {
    assert.match(prompt, /Skill under training: `deploy-flow`/)
  })

  it('auto-select wording when no target skill', () => {
    const auto = buildSkillTrainPrompt(normalizeSkillTrainArgs({ runId: 'r2' }, 'main'))
    assert.match(auto, /auto-select among the USER'S OWN skills/)
  })
})

describe('buildSkillTrainContext', () => {
  it('summarizes the run params and flags draft mode', () => {
    const ctx = buildSkillTrainContext(normalizeSkillTrainArgs({ runId: 'r3' }, 'main'))
    assert.match(ctx, /draft mode/)
    assert.match(ctx, /runId=r3/)
    assert.match(ctx, /model=deepseek-v4-pro/)
    assert.match(ctx, /targetSkill=\(auto\)/)
  })
})

describe('isNestedSkillTrainBlocked', () => {
  it('allows top-level (depth 0 or unset) and blocks nested delegated runs', () => {
    assert.equal(isNestedSkillTrainBlocked(undefined), false)
    assert.equal(isNestedSkillTrainBlocked(''), false)
    assert.equal(isNestedSkillTrainBlocked('0'), false)
    assert.equal(isNestedSkillTrainBlocked('1'), true)
    assert.equal(isNestedSkillTrainBlocked('2'), true)
  })
})
