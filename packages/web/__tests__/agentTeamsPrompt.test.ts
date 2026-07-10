import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const src = readFileSync(resolve(import.meta.dirname, '..', 'public/modules/agentTeams.js'), 'utf-8')
const indexSrc = readFileSync(resolve(import.meta.dirname, '..', 'public/index.html'), 'utf-8')
const teamMaxParallelSelect =
  indexSrc.match(/<select id="team-max-parallel">[\s\S]*?<\/select>/)?.[0] || ''
const mainSrc = readFileSync(resolve(import.meta.dirname, '..', 'public/modules/main.js'), 'utf-8')
const agentsSrc = readFileSync(resolve(import.meta.dirname, '..', 'public/modules/agents.js'), 'utf-8')
const modelPolicySrc = readFileSync(resolve(import.meta.dirname, '..', 'public/modules/modelPolicy.js'), 'utf-8')

function extractFunction(source: string, name: string): string {
  const lines = source.split('\n')
  const start = lines.findIndex((line) => new RegExp(`\\bfunction\\s+${name}\\s*\\(`).test(line))
  if (start < 0) throw new Error(`function not found: ${name}`)
  const indent = lines[start]!.match(/^(\s*)/)?.[1] || ''
  const closing = new RegExp(`^${indent}\\}\\s*$`)
  let end = start + 1
  for (; end < lines.length; end++) {
    if (closing.test(lines[end]!)) break
  }
  return lines.slice(start, end + 1).join('\n').replace(/^export\s+/, '')
}

const buildTeamRunPrompt = new Function(
  [
    extractFunction(src, '_cleanPromptText'),
    extractFunction(src, '_cleanBlockText'),
    extractFunction(src, '_effectiveMaxParallel'),
    extractFunction(src, '_memberLines'),
    extractFunction(src, 'buildTeamRunPrompt'),
    'return buildTeamRunPrompt;',
  ].join('\n'),
)() as (team: any, userText: string) => string

const getModelOverrideForSend = new Function(
  [
    extractFunction(modelPolicySrc, 'findAgent'),
    extractFunction(modelPolicySrc, 'getSingleAgentModelOverride'),
    extractFunction(mainSrc, 'getModelOverrideForSend'),
    'return getModelOverrideForSend;',
  ].join('\n'),
)() as (teamForSend: any, userPrefs: any, agentsList?: any[], options?: any) => string | undefined

const missingAgentIds = new Function(
  [
    'let existingIds = []',
    'function _agentExists(id) { return existingIds.includes(id) }',
    extractFunction(src, '_missingAgentIds'),
    'return (ids, existing) => { existingIds = existing; return _missingAgentIds(ids) }',
  ].join('\n'),
)() as (ids: string[], existing: string[]) => string[]

describe('agent team prompt builder', () => {
  it('includes only configured leader and members and preserves the user goal', () => {
    const prompt = buildTeamRunPrompt(
      {
        id: 'dev_team',
        name: '研发小队',
        description: '代码任务',
        leaderAgentId: 'architect',
        members: [
          { agentId: 'coder', role: '实现', responsibility: '修改代码并说明文件' },
          { agentId: 'reviewer', role: '审阅', responsibility: '检查风险' },
        ],
        policy: { maxParallel: 2, requireReview: true, reviewAgentId: 'reviewer' },
      },
      '给仓库加一个导出 PDF 功能',
    )

    assert.match(prompt, /coordinator: architect/)
    assert.match(prompt, /- coder: 实现 — 修改代码并说明文件/)
    assert.match(prompt, /- reviewer: 审阅 — 检查风险/)
    assert.match(prompt, /最多同时推进 2 条子任务/)
    assert.match(prompt, /优先请 reviewer 复核/)
    assert.match(prompt, /任务账本/)
    assert.match(prompt, /成功标准/)
    assert.match(prompt, /最多再进行 1 轮/)
    assert.match(prompt, /缺口检查/)
    assert.match(prompt, /goal=\.\.\., agentId=\.\.\., context=\.\.\./)
    assert.match(prompt, /绑定了 GitHub 仓库/)
    assert.match(prompt, /owner\/repo、分支、本地工作目录/)
    assert.match(prompt, /当前仓库 cwd/)
    assert.match(prompt, /必须等待每个已发起的 delegate_task 明确返回/)
    assert.match(prompt, /未返回、报错或超时的委派只能列为缺口/)
    assert.match(prompt, /复核返回前不得声称已经完成复核/)
    assert.match(prompt, /实际参与的 agent/)
    assert.match(prompt, /给仓库加一个导出 PDF 功能/)
    assert.match(prompt, /队长角色定义/)
    assert.doesNotMatch(prompt, /researcher/)
  })

  it('caps team delegate fanout at two even when a persisted team asks for more', () => {
    const prompt = buildTeamRunPrompt(
      {
        id: 'heavy_science_team',
        name: '重型科研队',
        leaderAgentId: 'codex',
        members: [
          { agentId: 'researcher', role: '研究', responsibility: '查证资料' },
          { agentId: 'scientist', role: '分析', responsibility: '数据分析' },
          { agentId: 'coder', role: '实现', responsibility: '计算脚本' },
          { agentId: 'reviewer', role: '复核', responsibility: '审查风险' },
        ],
        policy: { maxParallel: 4, requireReview: true, reviewAgentId: 'reviewer' },
      },
      '分析一个复杂科研问题',
    )

    assert.match(prompt, /最多同时推进 2 条子任务/)
    assert.doesNotMatch(prompt, /最多同时推进 4 条子任务/)
  })

  it('suppresses user default model override during team runs so leader routing is preserved', () => {
    // 团队消息永远不带 frame.model override(leader 配置决定模型)。
    assert.equal(
      getModelOverrideForSend(
        { id: 'dev_team', leaderAgentId: 'main' },
        { default_model: 'MiniMax-M3' },
        [{ id: 'main', provider: 'minimax', model: 'MiniMax-M3' }],
      ),
      undefined,
    )
    // 单 agent 消息透传用户 default_model(v5 ccb-only:不再对 gpt-* 特判)。
    assert.equal(getModelOverrideForSend(null, { default_model: 'MiniMax-M3' }), 'MiniMax-M3')
    assert.equal(getModelOverrideForSend(null, { default_model: '' }), undefined)
  })

  it('single-agent send forwards the user default model as-is (v5 ccb-only)', () => {
    const agents = [
      { id: 'main', provider: 'minimax', model: 'MiniMax-M3' },
      { id: 'scientist', provider: 'minimax', model: 'MiniMax-M3' },
    ]
    for (const agentId of ['scientist', 'main']) {
      assert.equal(
        getModelOverrideForSend(null, { default_model: 'glm-5.2' }, agents, {
          agentId,
          defaultAgentId: 'main',
        }),
        'glm-5.2',
      )
    }
  })

  it('adds a configured review agent to the allowed delegation list when it is not a member', () => {
    const prompt = buildTeamRunPrompt(
      {
        id: 'review_team',
        name: '复核队',
        leaderAgentId: 'main',
        members: [{ agentId: 'coder', role: '实现', responsibility: '产出草案' }],
        policy: { maxParallel: 1, requireReview: true, reviewAgentId: 'reviewer' },
      },
      '写一个说明',
    )

    assert.match(prompt, /- coder: 实现 — 产出草案/)
    assert.match(prompt, /- reviewer: 复核 — 检查草案的遗漏、风险和错误/)
    assert.match(prompt, /优先请 reviewer 复核/)
  })

  it('includes team-specific leader and member role prompts', () => {
    const prompt = buildTeamRunPrompt(
      {
        id: 'science_research_team',
        name: '科研协作团队',
        leaderAgentId: 'main',
        leaderRole: '科研项目负责人',
        leaderPrompt: '先把研究问题拆成可验证子问题。\n最终输出证据链和局限。',
        members: [
          {
            agentId: 'researcher',
            role: '文献研究员',
            responsibility: '检索资料并列出处',
            rolePrompt: '区分已证实结论、假设和争议。',
          },
        ],
        policy: { maxParallel: 2, requireReview: false },
      },
      '分析一个论文方向',
    )

    assert.match(prompt, /角色: 科研项目负责人/)
    assert.match(prompt, /先把研究问题拆成可验证子问题/)
    assert.match(prompt, /- researcher: 文献研究员 — 检索资料并列出处/)
    assert.match(prompt, /角色提示词: 区分已证实结论、假设和争议/)
    assert.match(prompt, /同一个 agent 在不同团队可能有不同角色/)
    assert.match(prompt, /成员角色提示词/)
  })

  it('tracks stale team members/review agents while keeping templates prefillable', () => {
    assert.deepEqual(
      missingAgentIds(['main', 'coder', 'coder', 'reviewer'], ['main', 'reviewer']),
      ['coder'],
    )
    assert.match(src, /团队成员 agent 不存在/)
    assert.match(src, /团队复核 agent 不存在/)
    assert.match(src, /TEAM_TEMPLATES/)
    assert.match(src, /id: 'science_research_team'/)
    assert.match(src, /name: '科研协作团队'/)
    // 队长默认走 glm-5.2（2026-06-17）：模板 leaderAgentId 用 main（全能助手），不再是
    // codex（GPT-5.5）。codex-native runner 无法运行 glm-5.x。
    assert.match(src, /leaderAgentId: 'main'/)
    assert.doesNotMatch(src, /leaderAgentId: 'codex'/)
    assert.match(src, /agentId: 'scientist'/)
    assert.match(src, /role: '科研数据分析师'/)
    assert.match(src, /policy: \{ maxParallel: 2, requireReview: true, reviewAgentId: 'reviewer' \}/)
    assert.match(teamMaxParallelSelect, /<option value="2" selected>2<\/option>/)
    assert.doesNotMatch(teamMaxParallelSelect, /<option value="3"/)
    assert.match(src, /id: 'programming_team'/)
    assert.match(src, /name: '编程协作团队'/)
    assert.doesNotMatch(src, /id: 'full_stack_team'/)
    assert.match(src, /rolePrompt/)
    assert.match(src, /team-leader-prompt/)
    assert.doesNotMatch(src, /btn\.disabled = missing\.length > 0/)
    assert.match(src, /仍可点击预填/)
    assert.doesNotMatch(src, /模板不可用,缺少 agent/)
  })

  it('commercial fallback agents include the seeded collaboration agents', () => {
    assert.match(agentsSrc, /COMMERCIAL_FALLBACK_AGENTS/)
    assert.match(agentsSrc, /id: 'researcher'/)
    assert.match(agentsSrc, /id: 'scientist'/)
    assert.match(agentsSrc, /id: 'coder'/)
    assert.match(agentsSrc, /id: 'reviewer'/)
    // v5 ccb-only:fallback 不再含 codex/gpt-5.6-sol agent。
    assert.doesNotMatch(agentsSrc, /id: 'codex'/)
    assert.doesNotMatch(agentsSrc, /provider: 'codex-native'/)
    assert.match(agentsSrc, /model: 'deepseek-v4-pro'/)
    assert.match(agentsSrc, /provider: 'minimax'/)
    assert.match(agentsSrc, /provider: 'deepseek'/)
    assert.match(agentsSrc, /_isLimitedCommercialAgentList/)
    assert.match(agentsSrc, /_mergeCommercialFallbackAgents/)
    assert.match(agentsSrc, /state\.agentsListIsFallback = true/)
    assert.match(src, /state\.agentsListIsFallback/)
  })
})
