/**
 * 团队模式隐藏审查员 —— 硬编排 review pass 行为测试 + 可见性守护回归。
 *
 * P2 债C 重写:审查触发权威从 prompt 软约束收归 gateway 硬编排(dispatchInbound
 * 队长 final 放行前的 review pass,状态机在 Gateway._runTeamReviewPass)。因此本文件
 * 的第一组断言从"逐条匹配 preamble 审查文案"改为:
 *   1. preamble 只保留**协作**语义(拆解/委派/领域路由/综合),审查软约束整体删除;
 *   2. _runTeamReviewPass 的**编排行为**(mock 副作用):PASS 放行 / NEEDS_FIX 续写 /
 *      迭代封顶 / 降级放行 / continuation 报错不放行。
 * 其余(可见性/管理面/直连拒绝/执行面拒绝)仍是源码守护断言,守护意图不变。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/teamModeHiddenReviewer.test.ts
 */
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { Gateway } from '../server.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const SERVER_TS = join(__dirname, '..', 'server.ts')
const CRON_TS = join(__dirname, '..', 'cron.ts')

// ── 编排行为测试脚手架(沿用 hiddenDelegateLimit.test.ts 的 Object.create 先例)──
function makeReviewGateway(): any {
  const gw = Object.create(Gateway.prototype) as any
  gw.log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
  return gw
}
const PASS_RESULT = {
  kind: 'completed' as const,
  ok: true,
  output: 'looks good\nVERDICT: PASS',
  timedOut: false,
  runId: 'rev-1',
  verdict: 'PASS' as const,
}
const NEEDS_FIX_RESULT = {
  kind: 'completed' as const,
  ok: true,
  output: 'fix the thing\nVERDICT: NEEDS_FIX',
  timedOut: false,
  runId: 'rev-1',
  verdict: 'NEEDS_FIX' as const,
}

describe('team mode preamble — 只保留协作语义,审查软约束已删', () => {
  it('preamble 保留组队/委派/领域路由/综合语义', () => {
    const src = readFileSync(SERVER_TS, 'utf8')
    assert.match(src, /if \(teamMode && agent\.id === 'main'\)/)
    assert.match(src, /可委派的成员（已安装 agent）/)
    assert.match(src, /listCollaboratorAgents\(teamCfg, \{ selfId: 'main', includeMain: false \}\)/)
    assert.match(src, /const model = a\.model/)
    assert.match(src, /const provider = a\.provider/)
    assert.match(src, /teamMemberCapabilityHint\(a\)/)
    assert.match(src, /领域匹配优先于泛泛并行/)
    assert.match(src, /代码\/调试\/测试\/重构\/代码库 → `coding-assistant`/)
    assert.match(src, /科研\/文献\/论文\/引用\/学术分析 → `research-assistant`/)
    assert.match(src, /文档\/PPT\/Excel\/PDF\/周报\/公文\/邮件\/办公交付 → `office-assistant`/)
    assert.match(src, /首选.*delegate_task/)
    // 合并消解(P2批次3 × ux-reliability):委派通道语义已收敛为「只走 delegate_task,停用原生 Agent」
    assert.match(src, /只走 `delegate_task`/)
    assert.match(src, /collabAgentPolicy: 'team-mode-prefer-delegate'/)
    // 审查**感知**(2026-07-07):被动告知强制审查机制的存在与反馈应对方式。与下面
    // doesNotMatch 防回退的"触发侧软约束"(自觉调用/迭代自律)有本质区别 —— 触发权威
    // 仍唯一在 gateway 硬编排。
    assert.match(src, /强制质量审查\*\*再送达用户/)
    assert.match(src, /平台会把初稿折叠/)
  })

  it('NEEDS_FIX 续写前发修订标记帧(前端折叠草稿的 server 权威信号)', () => {
    const src = readFileSync(SERVER_TS, 'utf8')
    assert.match(src, /meta: \{ teamRevision: true \}/)
    // 标记必须先于 continuation 的 sessions.submit(顺序保证前端在修订稿首块到达前完成折叠)。
    const marker = src.indexOf('teamRevision: true')
    const contSubmit = src.indexOf('buildTeamReviewContinuation(reviewOutput)')
    assert.ok(marker > 0 && contSubmit > 0 && marker < contSubmit, '标记帧代码应在 continuation submit 之前')
  })

  it('preamble 已删除"自觉调用审查 / verdict 解读 / 迭代自律"软约束(审查改由 gateway 硬编排)', () => {
    const src = readFileSync(SERVER_TS, 'utf8')
    // 这些审查软约束都随硬编排上线整体删除;若哪天有人把它们加回 preamble 就会形成
    // 两套并行审查机制(prompt 软约束 + gateway 硬编排),本断言防回退。
    assert.doesNotMatch(src, /在最终答复前默认要再调用/)
    assert.doesNotMatch(src, /审查迭代闭环/)
    assert.doesNotMatch(src, /再次调用 `hidden-reviewer` 审查修订稿/)
    assert.doesNotMatch(src, /迭代直到隐藏审查 PASS/)
    assert.doesNotMatch(src, /避免无限循环/)
    assert.doesNotMatch(src, /审查结果只是建议，不是命令/)
    assert.doesNotMatch(src, /隐藏审查未完成\/失败/)
  })
})

describe('_runTeamReviewPass — 硬编排状态机行为', () => {
  it('PASS → 放行 final,不触发 continuation', async () => {
    const gw = makeReviewGateway()
    let continued = 0
    const outcome = await gw._runTeamReviewPass({
      sessionKey: 'agent:main:webchat:dm:w1',
      maxRounds: 2,
      runReview: async () => PASS_RESULT,
      submitContinuation: async () => {
        continued++
        return 'held'
      },
    })
    assert.deepEqual(outcome, { deliver: true })
    assert.equal(continued, 0, 'PASS 不应触发续写')
  })

  it('NEEDS_FIX 后续写、再审 PASS → 放行(无披露)', async () => {
    const gw = makeReviewGateway()
    const verdicts = [NEEDS_FIX_RESULT, PASS_RESULT]
    let round = 0
    let continued = 0
    const outcome = await gw._runTeamReviewPass({
      sessionKey: 'w2',
      maxRounds: 2,
      runReview: async () => verdicts[round++],
      submitContinuation: async () => {
        continued++
        return 'held'
      },
    })
    assert.equal(outcome.deliver, true)
    assert.equal(outcome.disclosure, undefined, '再审 PASS 不应有披露')
    assert.equal(continued, 1, 'NEEDS_FIX→PASS 恰好续写一次')
    assert.equal(round, 2, '共审查两轮')
  })

  it('NEEDS_FIX 反复到迭代封顶 → 强制放行 + 披露"达上限"', async () => {
    const gw = makeReviewGateway()
    let reviewCalls = 0
    let continued = 0
    const outcome = await gw._runTeamReviewPass({
      sessionKey: 'w3',
      maxRounds: 2,
      runReview: async () => {
        reviewCalls++
        return NEEDS_FIX_RESULT
      },
      submitContinuation: async () => {
        continued++
        return 'held'
      },
    })
    assert.equal(outcome.deliver, true, '到顶必须强制放行,绝不卡死')
    assert.match(outcome.disclosure ?? '', /迭代上限/)
    assert.equal(reviewCalls, 2, 'maxRounds=2 → 审查两轮')
    assert.equal(continued, 1, '第 2 轮到顶不再续写')
  })

  it('review 委派被闸拒(rejected) → 降级放行 + 披露"审查未完成"', async () => {
    const gw = makeReviewGateway()
    let continued = 0
    const outcome = await gw._runTeamReviewPass({
      sessionKey: 'w4',
      maxRounds: 2,
      runReview: async () => ({ kind: 'rejected', httpStatus: 429, message: 'too many' }),
      submitContinuation: async () => {
        continued++
        return 'held'
      },
    })
    assert.equal(outcome.deliver, true, '闸拒也必须放行队长 final')
    assert.match(outcome.disclosure ?? '', /审查未能完成/)
    assert.equal(continued, 0)
  })

  it('review 完成但解析不出 VERDICT → 降级放行 + 披露', async () => {
    const gw = makeReviewGateway()
    const outcome = await gw._runTeamReviewPass({
      sessionKey: 'w5',
      maxRounds: 2,
      runReview: async () => ({
        kind: 'completed',
        ok: true,
        output: '审查员忘了输出裁决行',
        timedOut: false,
        runId: 'rev-x',
        verdict: undefined,
      }),
      submitContinuation: async () => 'held',
    })
    assert.equal(outcome.deliver, true)
    assert.match(outcome.disclosure ?? '', /审查未能完成/)
  })

  it('review 超时 → 降级放行', async () => {
    const gw = makeReviewGateway()
    const outcome = await gw._runTeamReviewPass({
      sessionKey: 'w6',
      maxRounds: 2,
      runReview: async () => ({
        kind: 'completed',
        ok: false,
        output: '',
        error: 'DelegateTimeoutError',
        timedOut: true,
        runId: 'rev-t',
      }),
      submitContinuation: async () => 'held',
    })
    assert.equal(outcome.deliver, true)
    assert.match(outcome.disclosure ?? '', /审查未能完成/)
  })

  it('NEEDS_FIX 后 continuation 报错 → 不放行 held final(错误终态帧已由队长 turn 自投递)', async () => {
    const gw = makeReviewGateway()
    const outcome = await gw._runTeamReviewPass({
      sessionKey: 'w7',
      maxRounds: 2,
      runReview: async () => NEEDS_FIX_RESULT,
      submitContinuation: async () => 'errored',
    })
    assert.equal(outcome.deliver, false, 'continuation 报错 → 交给错误分支收尾,不重复放行')
  })

  it('NEEDS_FIX 后 continuation 非常规终态(other) → 防御性收尾放行,防挂起', async () => {
    const gw = makeReviewGateway()
    const outcome = await gw._runTeamReviewPass({
      sessionKey: 'w8',
      maxRounds: 2,
      runReview: async () => NEEDS_FIX_RESULT,
      submitContinuation: async () => 'other',
    })
    assert.equal(outcome.deliver, true, 'other 必须收尾放行,绝不让 turn 挂起')
  })
})

describe('team mode hidden reviewer — 可见性守护(不变)', () => {
  it('keeps hidden reviewer out of user-facing agent management APIs', () => {
    const src = readFileSync(SERVER_TS, 'utf8')
    assert.match(src, /filterUserVisibleAgentsForManagement\(cfg\.agents\)/)
    assert.match(src, /userVisibleDefaultAgentId\(cfg\.default\)/)
    assert.match(src, /filterUserVisibleRoutesForManagement\(cfg\.routes\)/)
    assert.match(src, /isHiddenSystemAgentId\(id\).*agent not found/)
    assert.match(src, /isHiddenSystemAgentId\(agentId\).*agent not found/)
    assert.match(src, /isHiddenSystemAgentId\(body\.id\).*agent id is reserved/s)
  })

  it('rejects direct user chat/message access while leaving delegate_task as the internal path', () => {
    const src = readFileSync(SERVER_TS, 'utf8')
    assert.match(src, /if \(frame\.agentId && isHiddenSystemAgentId\(frame\.agentId\)\)/)
    assert.match(src, /if \(isHiddenSystemAgentId\(agent\.id\)\)/)
    assert.match(src, /bootAutoResume[\s\S]*isHiddenSystemAgentId\(agentId\)/)
    assert.match(src, /autoResumeFromHello[\s\S]*isHiddenSystemAgentId\(aid\)/)
    assert.match(src, /handleStop[\s\S]*explicitStopAgentId[\s\S]*isHiddenSystemAgentId\(explicitStopAgentId\)/)
    assert.match(src, /handleAgentMessage[\s\S]*isHiddenSystemAgentId\(targetAgentId\)[\s\S]*agent "[^"]+" not found/)
    // P2 债C:委派执行核心已从 handleDelegateTask 抽到 _runDelegateTask(HTTP 壳 + 内部
    // 硬编排两个调用方共用),按 id 找 target 的逻辑随之搬到核心。
    assert.match(src, /_runDelegateTask[\s\S]*const targetAgent = cfg\.agents\.find\(\(a\) => a\.id === targetAgentId\)/)
  })

  it('rejects hidden reviewer from other user-controlled execution and mutation surfaces', () => {
    const src = readFileSync(SERVER_TS, 'utf8')
    const cronSrc = readFileSync(CRON_TS, 'utf8')
    // 枚举面(P2 债E 收口):skill 作用域 / webhook·task·cron 列表改走用户可见投影
    // (_getAgentsConfigUserView / filterUserVisibleByAgentField),不再各自手工过滤;
    // 守护意图不变=隐藏系统 agent 不进这些枚举面。判定面(下方 404/拒绝)仍用 predicate。
    assert.match(src, /validateSkillAgentScopeInput[\s\S]*_getAgentsConfigUserView\(\)/)
    assert.match(src, /eventBus\.on\('task\.created'[\s\S]*isHiddenSystemAgentId\(ev\.agentId\)/)
    assert.match(src, /eventBus\.on\('webhook\.received'[\s\S]*isHiddenSystemAgentId\(agentId\)/)
    assert.match(src, /filterUserVisibleByAgentField\(this\.webhookRouter\?\.list\(\) \?\? \[\]\)/)
    assert.match(src, /if \(isHiddenSystemAgentId\(wh\.agent\)\)[\s\S]*webhook not found/)
    assert.match(src, /filterUserVisibleByAgentField\(await this\._taskStore\.list\(\)\)/)
    assert.match(src, /const taskAgent = typeof agent === 'string' && agent \? agent : 'main'/)
    assert.match(src, /if \(isHiddenSystemAgentId\(taskAgent\)\) return this\.sendError\(res, 404, 'agent not found'\)/)
    assert.match(src, /if \(parsed\.agent !== undefined && isHiddenSystemAgentId\(parsed\.agent\)\)/)
    assert.match(src, /if \(isHiddenSystemAgentId\(task\.agent\)\)/)
    assert.match(src, /const cronAgent = typeof agent === 'string' && agent \? agent : 'main'/)
    assert.match(src, /if \(isHiddenSystemAgentId\(cronAgent\)\) return this\.sendError\(res, 404, 'agent not found'\)/)
    assert.match(src, /filterUserVisibleByAgentField\(await this\.cron\.listJobsWithMeta\(\)\)/)
    assert.match(cronSrc, /if \(isHiddenSystemAgentId\(job\.agent\)\)/)
  })
})
