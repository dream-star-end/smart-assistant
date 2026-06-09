// OpenClaude — Codex persistent goal controls
import { $ } from './dom.js'
import { getSession, state } from './state.js'
import { toast } from './ui.js'

const VALID_STATUSES = new Set(['active', 'paused', 'budgetLimited', 'complete'])

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

export function sendGoalControl(action, fields = {}) {
  if (!currentAgentSupportsGoals()) {
    toast('当前 agent 不支持 Codex goals', 'error')
    return false
  }
  if (!state.ws || state.ws.readyState !== 1) {
    toast('WebSocket 未连接，无法操作 Codex goal', 'error')
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
  state.ws.send(JSON.stringify(frame))
  return true
}

export function focusGoalComposer(prefill = '') {
  const input = $('input')
  if (!input) return
  input.value = `/goal ${prefill || ''}`
  input.focus()
  const pos = input.value.length
  try {
    input.setSelectionRange(pos, pos)
  } catch {}
}

export function parseGoalCommand(args = '') {
  const raw = String(args || '').trim()
  if (!raw || raw === 'status') return { action: 'get' }
  const lower = raw.toLowerCase()
  if (lower === 'clear' || lower === 'delete' || lower === 'remove') return { action: 'clear' }
  if (lower === 'pause' || lower === 'paused') {
    return { action: 'set', fields: { status: 'paused' } }
  }
  if (lower === 'resume' || lower === 'active' || lower === 'continue') {
    return { action: 'set', fields: { status: 'active' } }
  }
  if (lower === 'complete' || lower === 'done' || lower === 'finish') {
    return { action: 'set', fields: { status: 'complete' } }
  }
  const budgetMatch = raw.match(/^budget\s+(.+)$/i)
  if (budgetMatch) {
    const val = budgetMatch[1].trim()
    if (/^(none|null|clear|off)$/i.test(val)) {
      return { action: 'set', fields: { tokenBudget: null } }
    }
    const n = Number(val.replace(/,/g, ''))
    if (!Number.isFinite(n) || n <= 0) {
      return { error: '预算必须是正数，或使用 `/goal budget none` 清除预算。' }
    }
    return { action: 'set', fields: { tokenBudget: Math.floor(n) } }
  }

  let objective = raw
  let tokenBudget
  const budgetFlag = objective.match(/\s+--budget(?:=|\s+)([0-9][0-9,]*)\s*$/i)
  if (budgetFlag) {
    tokenBudget = Math.floor(Number(budgetFlag[1].replace(/,/g, '')))
    objective = objective.slice(0, budgetFlag.index).trim()
  }
  if (!objective) return { error: '目标不能为空。' }
  return {
    action: 'set',
    fields: {
      objective,
      status: 'active',
      ...(typeof tokenBudget === 'number' && tokenBudget > 0 ? { tokenBudget } : {}),
    },
  }
}
