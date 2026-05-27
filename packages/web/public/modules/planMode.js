// OpenClaude — Codex plan-first mode
import { $ } from './dom.js'
import { getSession, state } from './state.js'

const STORAGE_KEY = 'openclaude_plan_mode_by_agent'
let _forceDefaultNextSubmit = false

function readStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const obj = JSON.parse(raw)
    return obj && typeof obj === 'object' ? obj : {}
  } catch {
    return {}
  }
}

function writeStore(obj) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj))
  } catch {}
}

function currentAgent() {
  const sess = getSession()
  const agentId = sess?.agentId || state.defaultAgentId
  if (!agentId) return null
  return (state.agentsList || []).find((a) => a.id === agentId) || null
}

export function currentAgentSupportsPlanMode() {
  const a = currentAgent()
  return a?.provider === 'codex-native' && a?.runnerKind === 'app-server'
}

export function getCurrentPlanMode() {
  const a = currentAgent()
  if (!a || !currentAgentSupportsPlanMode()) return false
  const store = readStore()
  return store[a.id] === true
}

function setCurrentPlanMode(enabled) {
  const a = currentAgent()
  if (!a) return
  const store = readStore()
  if (enabled) store[a.id] = true
  else delete store[a.id]
  writeStore(store)
  renderPlanModePill()
}

export function requestDefaultNextSubmit() {
  _forceDefaultNextSubmit = true
}

export function getConversationModeForSubmit() {
  if (_forceDefaultNextSubmit) {
    _forceDefaultNextSubmit = false
    return 'default'
  }
  if (!currentAgentSupportsPlanMode()) return undefined
  return getCurrentPlanMode() ? 'plan' : undefined
}

export function renderPlanModePill() {
  const wrap = $('composer-plan-mode')
  const btn = $('mode-pill-plan')
  if (!wrap || !btn) return
  const visible = currentAgentSupportsPlanMode()
  wrap.hidden = !visible
  if (!visible) return
  btn.setAttribute('aria-pressed', getCurrentPlanMode() ? 'true' : 'false')
}

export function initPlanModePill() {
  const btn = $('mode-pill-plan')
  if (!btn) return
  btn.addEventListener('click', () => {
    if (!currentAgentSupportsPlanMode()) return
    setCurrentPlanMode(!getCurrentPlanMode())
  })
  renderPlanModePill()
}
