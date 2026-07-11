/**
 * Tests for the v3 skill-training engine (draft mode, DeepSeek-locked).
 *
 * Run:
 *   npx tsx --test packages/mcp-memory/src/__tests__/skillTrain.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  FEEDBACK_SCENARIO_MAX_CHARS,
  MAX_FEEDBACK_SCENARIOS,
  SKILL_TRAIN_DEFAULT_MODEL,
  buildFeedbackScenariosSection,
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

describe('buildFeedbackScenariosSection', () => {
  it('empty scenarios → empty string (caller skips injection)', () => {
    assert.equal(buildFeedbackScenariosSection([]), '')
    assert.equal(buildFeedbackScenariosSection([{ text: '   ' }]), '') // 空白文本被过滤
  })

  it('renders the down-vote section with numbered blocks and titles', () => {
    const section = buildFeedbackScenariosSection([
      { title: '部署失败会话', text: '用户: 帮我部署\n助手: 部署失败了' },
      { text: '用户: 又报错' },
    ])
    // 注意:小节标题含中文圆括号,用 includes 避免正则分组歧义。
    assert.ok(section.includes('用户差评过的真实场景(优先分析这些失败案例)'))
    assert.ok(section.includes('### 差评场景 1(部署失败会话)'))
    assert.ok(section.includes('### 差评场景 2'))
    assert.ok(section.includes('部署失败了'))
  })

  it('caps at MAX_FEEDBACK_SCENARIOS blocks', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ text: `场景${i}` }))
    const section = buildFeedbackScenariosSection(many)
    const blocks = section.match(/### 差评场景 /g) ?? []
    assert.equal(blocks.length, MAX_FEEDBACK_SCENARIOS)
  })

  it('hard-truncates an over-long excerpt to <= FEEDBACK_SCENARIO_MAX_CHARS', () => {
    const huge = 'x'.repeat(FEEDBACK_SCENARIO_MAX_CHARS + 500)
    const section = buildFeedbackScenariosSection([{ text: huge }])
    // 取正文块(标题行之后)长度不超过上限。
    const body = section.split('### 差评场景 1\n')[1] ?? ''
    assert.ok(body.length <= FEEDBACK_SCENARIO_MAX_CHARS, `body len ${body.length}`)
    assert.ok(body.endsWith('…'))
  })
})

describe('buildSkillTrainPrompt feedback injection', () => {
  const base = normalizeSkillTrainArgs({ runId: 'run-fb', targetSkill: 'deploy-flow' }, 'main')

  it('injects the feedback section when provided', () => {
    const section = buildFeedbackScenariosSection([{ text: '用户: 部署炸了' }])
    const prompt = buildSkillTrainPrompt(base, new Date('2026-06-18T00:00:00.000Z'), section)
    assert.match(prompt, /用户差评过的真实场景/)
    assert.match(prompt, /部署炸了/)
    // 仍保留原有 CRITICAL guards(注入不破坏后续结构)。
    assert.match(prompt, /CRITICAL guards:/)
  })

  it('omits the feedback section when absent/empty (fail-open no-refs branch)', () => {
    const noArg = buildSkillTrainPrompt(base, new Date('2026-06-18T00:00:00.000Z'))
    assert.doesNotMatch(noArg, /用户差评过的真实场景/)
    const emptyArg = buildSkillTrainPrompt(base, new Date('2026-06-18T00:00:00.000Z'), '')
    assert.doesNotMatch(emptyArg, /用户差评过的真实场景/)
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
