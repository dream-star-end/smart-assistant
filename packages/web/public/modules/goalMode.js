// OpenClaude — simple Codex Goal toggle for WebChat composer
import { $ } from './dom.js'
import { currentAgentSupportsGoals, sendGoalControl } from './goalControl.js?v=3'
import { getSession } from './state.js'

let _root = null

function _ensureRoot() {
  if (_root && document.body.contains(_root)) return _root
  const anchor = document.querySelector('.composer-input-row')
  if (!anchor) return null

  _root = document.createElement('div')
  _root.id = 'goal-mode'
  _root.className = 'goal-mode'
  _root.hidden = true
  _root.innerHTML = `
    <button
      id="goal-mode-toggle"
      type="button"
      class="mode-pill goal-mode-toggle"
      aria-pressed="false"
      title="开启后，下一条普通消息会建立 Codex Goal；后续消息沿用该 Goal，关闭会清除。"
    >
      <span class="goal-mode-dot" aria-hidden="true">🎯</span>
      <span>Goal</span>
    </button>
  `
  anchor.parentElement.insertBefore(_root, anchor)
  _bindRoot()
  return _root
}

function _notifyGoalModeStateChanged() {
  window.dispatchEvent(new CustomEvent('openclaude:goal-mode-state-changed'))
}

function _currentSessionGoalState() {
  const sess = getSession()
  return {
    sess,
    enabled: sess?.goalModeEnabled === true,
    seeded: sess?.goalModeSeeded === true,
  }
}

function _setGoalMode(enabled) {
  const sess = getSession()
  if (!sess) return
  const next = !!enabled
  sess.goalModeEnabled = next
  sess.goalModeSeeded = false
  if (!next) sendGoalControl('clear', {}, { silent: true })
  _notifyGoalModeStateChanged()
  renderGoalModePanel()
}

function _bindRoot() {
  $('goal-mode-toggle')?.addEventListener('click', () => {
    const { enabled } = _currentSessionGoalState()
    _setGoalMode(!enabled)
  })
}

function _title(enabled, seeded) {
  if (!enabled) return '开启后，下一条普通消息会建立 Codex Goal；聊天显示仍和正常模式一样。'
  if (!seeded) return '已开启：下一条普通消息会建立 Codex Goal；之后会自动沿用，不会反复覆盖。'
  return 'Goal 已生效：后续消息按正常聊天显示并沿用当前 Goal；点击关闭会清除。'
}

function _num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export function getLatestGoalFromMessages(messages = []) {
  if (!Array.isArray(messages)) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg || msg.role !== 'goal') continue
    const cleared = msg.cleared === true
    const objective =
      typeof msg.objective === 'string'
        ? msg.objective
        : typeof msg.text === 'string'
          ? msg.text
          : ''
    return {
      cleared,
      objective,
      status: cleared ? 'cleared' : typeof msg.status === 'string' ? msg.status : 'active',
      tokenBudget: _num(msg.tokenBudget),
      tokensUsed: _num(msg.tokensUsed),
      timeUsedSeconds: _num(msg.timeUsedSeconds),
      updatedAt: _num(msg.updatedAt),
    }
  }
  return null
}

export function getGoalModeForSubmit() {
  const { sess, enabled, seeded } = _currentSessionGoalState()
  if (!sess || !currentAgentSupportsGoals()) return undefined
  return enabled && !seeded ? true : undefined
}

export function markGoalModeSeeded() {
  const sess = getSession()
  if (!sess || !sess.goalModeEnabled) return
  sess.goalModeSeeded = true
  _notifyGoalModeStateChanged()
  renderGoalModePanel()
}

export function collapseGoalModePanel() {
  renderGoalModePanel()
}

export function renderGoalModePanel() {
  const root = _ensureRoot()
  if (!root) return
  const supported = currentAgentSupportsGoals()
  root.hidden = !supported
  if (!supported) return

  const { enabled, seeded } = _currentSessionGoalState()
  const toggle = $('goal-mode-toggle')
  root.classList.toggle('has-goal', enabled)
  root.classList.toggle('is-seeded', enabled && seeded)
  if (toggle) {
    toggle.setAttribute('aria-pressed', enabled ? 'true' : 'false')
    toggle.title = _title(enabled, seeded)
  }
}

export function settleGoalModePanel() {
  renderGoalModePanel()
}

export function initGoalModePanel() {
  _ensureRoot()
  window.addEventListener('openclaude:goal-panel-open', () => {
    _setGoalMode(true)
  })
  renderGoalModePanel()
}

// Re-export for code that wants to arm Goal mode without depending on DOM details.
export { openGoalPanel } from './goalControl.js?v=3'
