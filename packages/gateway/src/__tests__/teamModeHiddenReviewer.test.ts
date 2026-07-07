/**
 * 团队模式隐藏审查员 —— 队长自主送审(2026-07-07 boss 裁决)+ 可见性守护回归。
 *
 * 演化史:P2 之前是 preamble 软约束(模型不照做,漂移)→ P2 债C 收归 gateway 硬编排
 * (final 扣住 + _runTeamReviewPass 状态机)→ 2026-07-07 boss 裁决改回**队长自主决定**:
 * preamble 纪律强引导"除明显简单任务外都送审"(request_review 工具),平台侧保证收敛为
 * 三件:送审通道(isReview 按目标身份派生)+ hidden guard 熔断(≤3/turn)+ 团队门
 * (非团队 turn 409)。硬编排状态机整体退役,本文件相应断言:
 *   1. preamble 含自主送审纪律;
 *   2. 硬编排产物(finalHeld/_runTeamReviewPass/continuation)已不存在(防復活);
 *   3. 可见性/管理面/直连拒绝守护不变。
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


describe('team mode preamble — 协作语义 + 队长自主送审纪律', () => {
  it('preamble 保留组队/委派/领域路由/综合语义', () => {
    const src = readFileSync(SERVER_TS, 'utf8')
    assert.match(src, /if \(teamMode && agent\.id === 'main'\)/)
    assert.match(src, /可委派的成员（已安装 agent）/)
    assert.match(src, /listCollaboratorAgents\(teamCfg, \{ selfId: 'main', includeMain: false \}\)/)
    assert.match(src, /领域匹配优先于泛泛并行/)
    assert.match(src, /只走 `delegate_task`/)
    assert.match(src, /collabAgentPolicy: 'team-mode-prefer-delegate'/)
  })

  it('preamble 含自主送审纪律(request_review,除明显简单任务外都送审,草稿不进正文)', () => {
    const src = readFileSync(SERVER_TS, 'utf8')
    assert.match(src, /request_review\(draft\)/)
    assert.match(src, /除非任务明显简单/)
    assert.match(src, /草稿只放在工具参数里/)
    assert.match(src, /VERDICT: PASS/)
  })

  it('硬编排产物已整体退役(防复活:队长自主送审是现行唯一机制)', () => {
    const src = readFileSync(SERVER_TS, 'utf8')
    assert.doesNotMatch(src, /finalHeld/)
    assert.doesNotMatch(src, /_runTeamReviewPass/)
    assert.doesNotMatch(src, /buildTeamReviewContinuation/)
    assert.doesNotMatch(src, /teamRevision/)
    assert.doesNotMatch(src, /deliverHeldFinal/)
    // 审查语义单一权威 = 目标身份派生 + 团队门。
    assert.match(src, /isHiddenSystemAgentId\(targetAgentId\)/)
    assert.match(src, /仅在团队模式的队长回合中可用/)
    assert.match(src, /buildTeamReviewContext\(parent\._currentTurnUserText/)
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
