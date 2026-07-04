import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const SERVER_TS = join(__dirname, '..', 'server.ts')
const CRON_TS = join(__dirname, '..', 'cron.ts')

describe('team mode hidden reviewer prompt', () => {
  it('keeps hidden reviewer as a prompt-only delegate outside the visible collaborator list', () => {
    const src = readFileSync(SERVER_TS, 'utf8')
    assert.match(src, /if \(teamMode && agent\.id === 'main'\)/)
    assert.match(src, /可委派的成员（已安装 agent）/)
    assert.match(src, /listCollaboratorAgents\(teamCfg, \{ selfId: 'main', includeMain: false \}\)/)
    assert.match(src, /hidden-reviewer/)
    assert.match(src, /agentId: "hidden-reviewer"/)
    assert.match(src, /不在成员列表显示/)
  })

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
    assert.match(src, /handleDelegateTask[\s\S]*const targetAgent = cfg\.agents\.find\(\(a\) => a\.id === targetAgentId\)/)
  })

  it('rejects hidden reviewer from other user-controlled execution and mutation surfaces', () => {
    const src = readFileSync(SERVER_TS, 'utf8')
    const cronSrc = readFileSync(CRON_TS, 'utf8')
    assert.match(src, /validateSkillAgentScopeInput[\s\S]*!isHiddenSystemAgentId\(id\)/)
    assert.match(src, /eventBus\.on\('task\.created'[\s\S]*isHiddenSystemAgentId\(ev\.agentId\)/)
    assert.match(src, /eventBus\.on\('webhook\.received'[\s\S]*isHiddenSystemAgentId\(agentId\)/)
    assert.match(src, /webhookRouter\?\.list\(\) \?\? \[\]\)\.filter\(\(wh\) => !isHiddenSystemAgentId\(wh\.agent\)\)/)
    assert.match(src, /if \(isHiddenSystemAgentId\(wh\.agent\)\)[\s\S]*webhook not found/)
    assert.match(src, /this\._taskStore\.list\(\)\)\.filter\(\(task\) => !isHiddenSystemAgentId\(task\.agent\)\)/)
    assert.match(src, /const taskAgent = typeof agent === 'string' && agent \? agent : 'main'/)
    assert.match(src, /if \(isHiddenSystemAgentId\(taskAgent\)\) return this\.sendError\(res, 404, 'agent not found'\)/)
    assert.match(src, /if \(parsed\.agent !== undefined && isHiddenSystemAgentId\(parsed\.agent\)\)/)
    assert.match(src, /if \(isHiddenSystemAgentId\(task\.agent\)\)/)
    assert.match(src, /const cronAgent = typeof agent === 'string' && agent \? agent : 'main'/)
    assert.match(src, /if \(isHiddenSystemAgentId\(cronAgent\)\) return this\.sendError\(res, 404, 'agent not found'\)/)
    assert.match(src, /this\.cron\.listJobsWithMeta\(\)\)\.filter\(\(job\) => !isHiddenSystemAgentId\(job\.agent\)\)/)
    assert.match(cronSrc, /if \(isHiddenSystemAgentId\(job\.agent\)\)/)
  })
})
