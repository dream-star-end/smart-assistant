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
const SYNC = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'modules', 'sync.js'),
  'utf-8',
)
const COMMANDS = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'modules', 'commands.js'),
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
    assert.match(TEAMS, /SELECTED_TEAM_USER_PREFIX/)
    assert.match(TEAMS, /localStorage\.setItem\(key, teamId\)/)
    assert.match(TEAMS, /sess\._selectedTeamId = nextTeamId/)
    assert.match(TEAMS, /scheduleSaveFromUserEdit\(sess\)/)
    assert.match(TEAMS, /hasOwnProperty\.call\(sess, '_selectedTeamId'\)/)
    assert.match(TEAMS, /let _agentTeamsLoaded = false/)
    assert.match(TEAMS, /let _agentTeamsOwnerUserId = ''/)
    assert.match(TEAMS, /if \(!_agentTeamsLoaded\) return/)
    assert.match(TEAMS, /Transient reload failures should not erase/)
    assert.match(TEAMS, /_agentTeamsOwnerUserId !== ownerUserId/)
    assert.match(MAIN, /clearStoredAgentTeamSelection\(\)/)
    assert.match(MAIN, /newSess\._selectedTeamId = teamId/)
    assert.match(MAIN, /syncAgentTeamSelectionForSession: syncSelectedTeamForCurrentSession/)
    assert.match(MAIN, /const identityReady = refreshBalance\(\)/)
    assert.match(MAIN, /then\(\(\) => identityReady\)/)
    assert.match(SYNC, /hasOwnProperty\.call\(existingLocal, '_selectedTeamId'\)/)
    assert.match(SYNC, /_activeTeamRun\) sess\._activeTeamRun = \{ \.\.\.existingLocal\._activeTeamRun \}/)
  })

  it('main injects agent switching callback instead of binding #agent-select', () => {
    assert.match(MAIN, /initModelPicker\(\{ onSwitchAgent: switchCurrentSessionAgent \}\)/)
    assert.doesNotMatch(MAIN, /\$\('agent-select'\)\.onchange/)
  })

  it('team runs keep a turn-scoped typing label instead of showing the default agent', () => {
    assert.match(MAIN, /const teamRunMeta = teamForSend/)
    assert.match(MAIN, /_teamRun: teamRunMeta/)
    assert.match(MAIN, /setActiveTeamRunForSession\(sess, teamRunMeta\)/)
    assert.match(MAIN, /tryEnqueueOffline\(\{[\s\S]*teamRun: teamRunMeta/)
    assert.match(WEBSOCKET, /function _typingDisplayTarget/)
    assert.match(WEBSOCKET, /sess\?\._activeTeamRun/)
    assert.match(WEBSOCKET, /团队: \$\{team\.name \|\| team\.id\}/)
    assert.match(WEBSOCKET, /sess\._activeTeamRun = null/)
  })

  it('team stop and regen route to the active team leader instead of the session agent', () => {
    assert.match(WEBSOCKET, /export function getActiveStopAgentId/)
    assert.match(WEBSOCKET, /agentId: getActiveStopAgentId\(s\)/)
    assert.match(WEBSOCKET, /agentId: getActiveStopAgentId\(sess\)/)
    assert.match(WEBSOCKET, /function _offlineItemTeamRun/)
    assert.match(WEBSOCKET, /setActiveTeamRunForSession\(sess, _offlineItemTeamRun\(sess, item\)\)/)
    assert.match(MESSAGES, /getActiveStopAgentId/)
    assert.match(COMMANDS, /getActiveStopAgentId/)
    assert.match(MESSAGES, /const _regenTeamRun = lastUserMsg\._teamRun/)
    assert.match(MESSAGES, /agentId: _regenAgentId/)
    assert.match(MESSAGES, /tryEnqueueOffline\(\{[\s\S]*teamRun: _regenTeamRun/)
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
