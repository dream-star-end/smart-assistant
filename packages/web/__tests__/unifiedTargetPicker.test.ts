import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const MODEL = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'modules', 'modelPicker.js'),
  'utf-8',
)
const TEAMS = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'modules', 'agentTeams.js'),
  'utf-8',
)
const MAIN = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'modules', 'main.js'),
  'utf-8',
)
const WEBSOCKET = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'modules', 'websocket.js'),
  'utf-8',
)
const EFFORT = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'modules', 'effortMode.js'),
  'utf-8',
)
const MESSAGES = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'modules', 'messages.js'),
  'utf-8',
)

describe('unified assistant picker wiring', () => {
  it('renders single-agent and multi-agent sections', () => {
    assert.match(MODEL, /section\('单 Agent'/)
    assert.match(MODEL, /section\('多 Agent'/)
    assert.match(MODEL, /targetType === 'agent'/)
    assert.match(MODEL, /targetType === 'team'/)
  })

  it('team edit button opens agents modal and team editor without selecting the row', () => {
    assert.match(MODEL, /target-menu-edit/)
    assert.match(MODEL, /ev\.stopPropagation\(\)/)
    assert.match(MODEL, /openModal\('agents-modal'\)/)
    assert.match(MODEL, /openTeamEditor\(team\.id\)/)
  })

  it('single agent/model selection clears selected team and team selection persists team id', () => {
    assert.match(MODEL, /clearSelectedAgentTeam\(\)/)
    assert.match(MODEL, /selectAgentTeam\(teamId\)/)
    assert.match(TEAMS, /export function selectAgentTeam/)
    assert.match(TEAMS, /localStorage\.setItem\(SELECTED_TEAM_KEY/)
  })

  it('main injects agent switching callback instead of binding #agent-select', () => {
    assert.match(MAIN, /initModelPicker\(\{ onSwitchAgent: switchCurrentSessionAgent \}\)/)
    assert.doesNotMatch(MAIN, /\$\('agent-select'\)\.onchange/)
  })

  it('team runs keep a turn-scoped typing label instead of showing the default agent', () => {
    assert.match(MAIN, /sess\._activeTeamRun\s*=\s*teamForSend/)
    assert.match(MAIN, /leaderAgentId:\s*teamForSend\.leaderAgentId/)
    assert.match(WEBSOCKET, /function _typingDisplayTarget/)
    assert.match(WEBSOCKET, /sess\?\._activeTeamRun/)
    assert.match(WEBSOCKET, /团队: \$\{team\.name \|\| team\.id\}/)
    assert.match(WEBSOCKET, /sess\._activeTeamRun = null/)
  })

  it('team mode scopes effort to the leader and renders delegate progress separately', () => {
    assert.match(EFFORT, /getSelectedTeamLeaderModel/)
    assert.match(EFFORT, /队长思考深度/)
    assert.match(EFFORT, /agent-team-selection-changed/)
    assert.match(MODEL, /当前团队由队长配置决定/)
    assert.match(WEBSOCKET, /block\.kind === 'delegate_progress'/)
    assert.match(WEBSOCKET, /delegate-progress/)
    assert.match(MESSAGES, /function _renderDelegateProgress/)
    assert.match(MESSAGES, /委派过程/)
  })
})
