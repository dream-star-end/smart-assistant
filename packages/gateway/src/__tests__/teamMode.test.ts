/**
 * teamMode.ts —— 团队模式两策略(审议 / 执行)纯逻辑单测。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/teamMode.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { type LocalCatalogView, parseCatalogResponse } from '../modelCatalogClient.js'
import {
  REVIEW_DRAFT_MAX_CHARS,
  buildTeamPreamble,
  buildTeamReviewContext,
  extractArtifactPaths,
  formatReviewEvidence,
  modelFamily,
  parseTeamReviewMode,
  pickDeliberationPanel,
  pickReviewerModel,
} from '../teamMode.js'

function row(model_id: string, engine: string, available = true): Record<string, unknown> {
  return {
    model_id,
    display_name: model_id,
    engine,
    provider_id: engine,
    context_window: 128000,
    supported_efforts: ['low', 'medium', 'high'],
    supports_vision: false,
    capability_zero: false,
    supports_thinking: false,
    default_effort: 'medium',
    available,
  }
}

function view(models: Array<Record<string, unknown>>): LocalCatalogView {
  return parseCatalogResponse({ models, projection_revision: 'p1', security_epoch: '1' })
}

const FULL = view([
  row('glm-5.3-zai', 'ccb'),
  row('gpt-6-astra', 'codex'),
  row('gpt-5.6-sol', 'codex'),
  row('gpt-5.6-terra', 'codex'),
  row('grok-build', 'grok'),
  row('deepseek-v4-pro', 'ccb'),
  row('deepseek-v4-flash', 'ccb'),
  row('kimi-k3', 'ccb'),
  row('MiniMax-M3', 'ccb'),
  row('cursor-grok-4.6-high', 'cursor'),
  row('glm-5.3', 'ccb', false),
])

describe('modelFamily', () => {
  it('同家族归并、跨家族区分', () => {
    assert.equal(modelFamily('gpt-5.6-sol'), modelFamily('gpt-5.6-terra'))
    assert.equal(modelFamily('deepseek-v4-pro'), modelFamily('deepseek-v4-flash'))
    assert.notEqual(modelFamily('glm-5.3-zai'), modelFamily('grok-build'))
    assert.equal(modelFamily('cursor-grok-4.6-high'), 'cursor')
    // 认不出的按自身当独立家族
    assert.equal(modelFamily('some-new-model'), 'some-new-model')
  })
})

describe('pickDeliberationPanel', () => {
  it('默认 3 个不同家族,排除队长型号所在家族,排除 cursor 与不可用', () => {
    const panel = pickDeliberationPanel(FULL, { excludeModel: 'glm-5.3-zai' })
    assert.equal(panel.length, 3)
    const fams = new Set(panel.map((p) => p.family))
    assert.equal(fams.size, 3)
    assert.ok(!fams.has('zhipu'), '队长家族不进 panel')
    assert.ok(!panel.some((p) => p.engine === 'cursor'))
    assert.deepEqual(
      panel.map((p) => p.modelId),
      ['gpt-6-astra', 'grok-build', 'deepseek-v4-pro'],
    )
  })

  it('requireLocalEngines(生产非豁免)只收 ccb', () => {
    const panel = pickDeliberationPanel(FULL, {
      excludeModel: 'glm-5.3-zai',
      requireLocalEngines: true,
    })
    assert.ok(panel.every((p) => p.engine === 'ccb'))
    assert.deepEqual(
      panel.map((p) => p.modelId),
      ['deepseek-v4-pro', 'kimi-k3', 'MiniMax-M3'],
    )
  })

  it('投影不够多样时返回能凑到的(不抛)', () => {
    const small = view([row('glm-5.3-zai', 'ccb'), row('deepseek-v4-flash', 'ccb')])
    const panel = pickDeliberationPanel(small, { excludeModel: 'glm-5.3-zai' })
    assert.deepEqual(
      panel.map((p) => p.modelId),
      ['deepseek-v4-flash'],
    )
    assert.deepEqual(pickDeliberationPanel(view([]), {}), [])
  })
})

describe('pickReviewerModel', () => {
  it('审查员 ≠ 队长家族;审议时还避开 panel 成员', () => {
    assert.equal(pickReviewerModel(FULL, { leaderModel: 'glm-5.3-zai' }), 'gpt-6-astra')
    assert.equal(
      pickReviewerModel(FULL, {
        leaderModel: 'glm-5.3-zai',
        avoidModels: ['gpt-6-astra', 'grok-build', 'deepseek-v4-pro'],
      }),
      'kimi-k3',
    )
    // 队长就是 sol → 审查员不能是 openai 家族(terra 也不行)
    const r = pickReviewerModel(FULL, { leaderModel: 'gpt-5.6-sol' })
    assert.ok(r && modelFamily(r) !== 'openai')
  })

  it('家族全被占时退化为只避开精确型号;彻底选不出 → undefined', () => {
    const only = view([row('glm-5.3-zai', 'ccb'), row('glm-5.2', 'ccb')])
    // 只剩同家族两款:严格轮选不出,宽松轮选到另一款(不是队长本尊即可)
    assert.equal(pickReviewerModel(only, { leaderModel: 'glm-5.3-zai' }), 'glm-5.2')
    assert.equal(
      pickReviewerModel(view([row('glm-5.3-zai', 'ccb')]), { leaderModel: 'glm-5.3-zai' }),
      undefined,
    )
  })
})

describe('review evidence + templates', () => {
  it('extractArtifactPaths 抓 generated 路径并去重', () => {
    const txt =
      '报告在 `/home/agent/.openclaude/generated/a.md`,数据 /home/agent/.openclaude/generated/b.csv 。再提一次 /home/agent/.openclaude/generated/a.md'
    assert.deepEqual(extractArtifactPaths(txt), [
      '/home/agent/.openclaude/generated/a.md',
      '/home/agent/.openclaude/generated/b.csv',
    ])
    assert.deepEqual(extractArtifactPaths(undefined), [])
  })

  it('formatReviewEvidence 剔除审查员自身行、标注型号与产物', () => {
    const s = formatReviewEvidence([
      {
        runId: 'r1',
        agentId: 'coding-assistant',
        model: 'grok-build',
        goal: '修 bug',
        status: 'ok',
        resultSummary: '改好了,见 /home/agent/.openclaude/generated/fix.diff',
      },
      {
        runId: 'r2',
        agentId: 'hidden-reviewer',
        goal: '审查',
        status: 'ok',
        resultSummary: 'VERDICT: PASS',
      },
      { runId: 'r3', agentId: 'main', model: 'gpt-5.6-sol', goal: '答题', status: 'timeout' },
    ])
    assert.match(s, /成员 1:`coding-assistant`\(型号 grok-build\) · 状态 ok · runId r1/)
    assert.match(s, /产物文件:\n- \/home\/agent\/\.openclaude\/generated\/fix\.diff/)
    assert.doesNotMatch(s, /hidden-reviewer/)
    assert.match(s, /成员 2:`main`\(型号 gpt-5\.6-sol\) · 状态 timeout/)
    assert.match(s, /回传:\(无文本\)/)
    assert.match(formatReviewEvidence([]), /没有委派成员/)
  })

  it('execution 模板带证据与验收纪律;draft 超长显式标注截断', () => {
    const ctx = buildTeamReviewContext({
      mode: 'execution',
      userTask: '把登录 bug 修了',
      leaderDraft: 'x'.repeat(REVIEW_DRAFT_MAX_CHARS + 10),
      evidence: [
        {
          runId: 'r1',
          agentId: 'coding-assistant',
          goal: '修',
          status: 'ok',
          resultSummary: '测试通过',
        },
      ],
    })
    assert.match(ctx, /【验收任务】/)
    assert.match(ctx, /不要盲审/)
    assert.match(ctx, /## 本轮成员委派证据/)
    assert.match(ctx, /把登录 bug 修了/)
    assert.match(ctx, /已截断,原文 \d+ 字/)
    assert.match(ctx, /VERDICT: PASS/)
  })

  it('deliberation 模板是五段 analyst 任务书', () => {
    const ctx = buildTeamReviewContext({
      mode: 'deliberation',
      userTask: '碳税利弊',
      leaderDraft: '草稿',
      evidence: [
        {
          runId: 'a',
          agentId: 'main',
          model: 'gpt-5.6-sol',
          goal: '碳税利弊',
          status: 'ok',
          resultSummary: 'A 说',
        },
        {
          runId: 'b',
          agentId: 'main',
          model: 'grok-build',
          goal: '碳税利弊',
          status: 'ok',
          resultSummary: 'B 说',
        },
      ],
    })
    assert.match(ctx, /【审议对比任务】/)
    for (const k of ['共识', '矛盾', '部分覆盖', '独有洞见', '盲点'])
      assert.match(ctx, new RegExp(`\\*\\*${k}\\*\\*`))
    assert.match(ctx, /只比较,不合并,不自己重答/)
    assert.match(ctx, /## 成员各自的回答\(panel\)/)
    assert.match(ctx, /型号 gpt-5\.6-sol/)
    assert.match(ctx, /型号 grok-build/)
  })

  it('parseTeamReviewMode 非法回落 execution', () => {
    assert.equal(parseTeamReviewMode('deliberation'), 'deliberation')
    assert.equal(parseTeamReviewMode('execution'), 'execution')
    assert.equal(parseTeamReviewMode('nope'), 'execution')
    assert.equal(parseTeamReviewMode(undefined), 'execution')
  })
})

describe('buildTeamPreamble', () => {
  const panel = pickDeliberationPanel(FULL, { excludeModel: 'glm-5.3-zai' })
  const base = {
    members: [{ id: 'coding-assistant', displayName: '编程助手', model: 'glm-5.3-zai' } as never],
    memberHint: () => ' — 能力: 写代码',
    autoModelToken: '__auto__',
    panel,
    leaderModel: 'glm-5.3-zai',
  }

  it('CCB/Codex 版:分类规则 + panel + delegate_tasks 示例 + 两种 mode 送审 + 成本预告', () => {
    const p = buildTeamPreamble({ ...base, cursorEngine: false })
    assert.match(p, /## 第一步:分类/)
    assert.match(p, /审议类/)
    assert.match(p, /执行类/)
    assert.match(p, /`gpt-6-astra`（openai）/)
    assert.match(p, /delegate_tasks\(\{ tasks: \[\{ model: "gpt-6-astra", goal: "<同一个问题>" \}/)
    assert.match(p, /request_review\(draft, mode="deliberation"\)/)
    assert.match(p, /request_review\(draft, mode="execution"\)/)
    assert.match(p, /约为单模型直答的 5 倍/)
    assert.match(p, /`coding-assistant`（编程助手） \[glm-5.3-zai, 继承全局\] — 能力: 写代码/)
    assert.match(p, /resumeSessionKey/)
    assert.doesNotMatch(p, /oc-memory/)
  })

  it('Cursor 版:走 oc-memory CLI,panel 用 --allow-self --model', () => {
    const p = buildTeamPreamble({ ...base, cursorEngine: true })
    assert.match(p, /oc-memory delegate --allow-self --model gpt-6-astra --goal "<同一个问题>"/)
    assert.match(p, /oc-memory request-review --mode deliberation --draft/)
    assert.doesNotMatch(p, /delegate_tasks\(/)
  })

  it('panel 不足两家族 → 审议不可用文案,执行策略照常', () => {
    const p = buildTeamPreamble({ ...base, panel: panel.slice(0, 1), cursorEngine: false })
    assert.match(p, /审议策略不可用/)
    assert.match(p, /## 执行类 → 执行策略/)
  })
})
