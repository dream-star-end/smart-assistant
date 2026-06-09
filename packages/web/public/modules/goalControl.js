// OpenClaude — Codex persistent goal controls
import { getSession, state } from './state.js'
import { toast } from './ui.js'

const VALID_STATUSES = new Set(['active', 'paused', 'budgetLimited', 'complete'])
let _suppressNextGoalGetToastUntil = 0

function _currentAgent() {
  const sess = getSession()
  const agentId = sess?.agentId || state.defaultAgentId
  if (!agentId) return null
  return (state.agentsList || []).find((a) => a.id === agentId) || null
}

export function currentAgentSupportsGoals() {
  const agent = _currentAgent()
  return agent?.provider === 'codex-native' && agent?.runnerKind === 'app-server'
}

function _goalFrame(action, fields = {}) {
  const sess = getSession()
  if (!sess) return null
  const frame = {
    type: 'inbound.control.goal',
    action,
    channel: 'webchat',
    peer: { id: sess.id, kind: 'dm' },
    agentId: sess.agentId || state.defaultAgentId,
  }
  if ('objective' in fields) frame.objective = fields.objective
  if ('status' in fields) frame.status = fields.status
  if ('tokenBudget' in fields) frame.tokenBudget = fields.tokenBudget
  return frame
}

export function sendGoalControl(action, fields = {}, opts = {}) {
  const notify = !opts.silent
  if (!currentAgentSupportsGoals()) {
    if (notify) toast('当前 agent 不支持 Codex goals', 'error')
    return false
  }
  if (!state.ws || state.ws.readyState !== 1) {
    if (notify) toast('WebSocket 未连接，无法操作 Codex goal', 'error')
    return false
  }
  if (action !== 'get' && action !== 'set' && action !== 'clear') {
    toast('未知 goal 操作', 'error')
    return false
  }
  if (fields.status !== undefined && fields.status !== null && !VALID_STATUSES.has(fields.status)) {
    toast(`不支持的 goal 状态: ${fields.status}`, 'error')
    return false
  }
  const frame = _goalFrame(action, fields)
  if (!frame) return false
  if (opts.silent && action === 'get') {
    _suppressNextGoalGetToastUntil = Date.now() + 5000
  }
  state.ws.send(JSON.stringify(frame))
  return true
}

export function shouldSuppressGoalStatusToast(frame) {
  if (!frame || frame.action !== 'get') return false
  if (Date.now() > _suppressNextGoalGetToastUntil) return false
  _suppressNextGoalGetToastUntil = 0
  return true
}

export function openGoalPanel(prefill = '') {
  window.dispatchEvent(
    new CustomEvent('openclaude:goal-panel-open', {
      detail: { prefill: String(prefill || '') },
    }),
  )
}
