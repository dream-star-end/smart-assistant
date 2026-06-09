// OpenClaude — visual Codex Goal mode panel for WebChat composer
import { $, htmlSafeEscape } from './dom.js'
import { currentAgentSupportsGoals, sendGoalControl } from './goalControl.js?v=2'
import { getSession } from './state.js'
import { toast } from './ui.js'

let _root = null
let _expanded = false
let _pending = false
let _autoRefreshTimer = null
let _lastAutoRefreshKey = ''

const STATUS_LABELS = {
  active: '进行中',
  paused: '已暂停',
  blocked: '已阻塞',
  usageLimited: '用量受限',
  budgetLimited: '预算用尽',
  complete: '已完成',
  cleared: '未设置',
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

function _currentGoal() {
  const sess = getSession()
  return sess ? getLatestGoalFromMessages(sess.messages) : null
}

function _statusLabel(goal) {
  if (!goal) return '未设置'
  return STATUS_LABELS[goal.status] || goal.status || '未知'
}

function _formatBudget(goal) {
  if (!goal || !goal.tokenBudget) return '无预算限制'
  const used = goal.tokensUsed || 0
  return `${used.toLocaleString()} / ${goal.tokenBudget.toLocaleString()} tokens`
}

function _progressPercent(goal) {
  if (!goal || !goal.tokenBudget || goal.tokenBudget <= 0) return null
  const used = goal.tokensUsed || 0
  return Math.max(0, Math.min(100, (used / goal.tokenBudget) * 100))
}

function _ensureRoot() {
  if (_root && document.body.contains(_root)) return _root
  const anchor = document.querySelector('.composer-input-row')
  if (!anchor) return null

  _root = document.createElement('div')
  _root.id = 'goal-mode'
  _root.className = 'goal-mode'
  _root.hidden = true
  _root.innerHTML = `
    <div class="goal-mode-bar">
      <button id="goal-mode-toggle" type="button" class="mode-pill goal-mode-toggle" aria-expanded="false">
        <span class="goal-mode-dot" aria-hidden="true">🎯</span>
        <span>Goal 模式</span>
      </button>
      <div id="goal-mode-summary" class="goal-mode-summary">给 Codex 设置一个持续目标</div>
      <button id="goal-mode-refresh" type="button" class="goal-mode-mini" title="刷新当前 Goal">刷新</button>
    </div>
    <div id="goal-mode-panel" class="goal-mode-panel" hidden>
      <div id="goal-mode-current" class="goal-mode-current" hidden></div>
      <label class="goal-mode-field">
        <span>目标</span>
        <textarea id="goal-mode-objective" rows="2" placeholder="例如：把当前功能完整做完、测试通过并上线"></textarea>
      </label>
      <label class="goal-mode-field goal-mode-budget-field">
        <span>Token 预算 <em>可选</em></span>
        <input id="goal-mode-budget" type="number" min="1" step="100" inputmode="numeric" placeholder="不填表示不限" />
      </label>
      <div class="goal-mode-actions">
        <button id="goal-mode-save" type="button" class="btn btn-primary btn-sm">启用 / 更新 Goal</button>
        <button id="goal-mode-pause" type="button" class="btn btn-ghost btn-sm">暂停</button>
        <button id="goal-mode-complete" type="button" class="btn btn-ghost btn-sm">完成</button>
        <button id="goal-mode-clear" type="button" class="btn btn-ghost btn-sm danger">清除</button>
        <button id="goal-mode-collapse" type="button" class="btn btn-ghost btn-sm">收起</button>
      </div>
    </div>
  `
  anchor.parentElement.insertBefore(_root, anchor)
  _bindRoot()
  return _root
}

function _setExpanded(next) {
  _expanded = !!next
  renderGoalModePanel()
  if (_expanded) {
    const objective = $('goal-mode-objective')
    setTimeout(() => objective?.focus(), 20)
  }
}

function _fillForm(goal) {
  const objective = $('goal-mode-objective')
  const budget = $('goal-mode-budget')
  if (!objective || !budget) return
  objective.value = goal?.cleared ? '' : goal?.objective || ''
  budget.value = goal?.tokenBudget ? String(goal.tokenBudget) : ''
}

function _setPending(next) {
  _pending = !!next
  for (const id of [
    'goal-mode-save',
    'goal-mode-pause',
    'goal-mode-complete',
    'goal-mode-clear',
    'goal-mode-refresh',
  ]) {
    const el = $(id)
    if (el) el.disabled = _pending
  }
}

function _send(action, fields = {}, opts = {}) {
  const ok = sendGoalControl(action, fields, opts)
  if (ok) {
    _setPending(true)
    setTimeout(() => _setPending(false), 6000)
  }
  return ok
}

function _saveGoal() {
  const objective = $('goal-mode-objective')?.value.trim() || ''
  const budgetRaw = $('goal-mode-budget')?.value.trim() || ''
  if (!objective) {
    toast('请先填写 Goal 目标', 'error')
    $('goal-mode-objective')?.focus()
    return
  }
  let tokenBudget
  if (budgetRaw) {
    const n = Number(budgetRaw)
    if (!Number.isFinite(n) || n <= 0) {
      toast('Token 预算必须是正数，或留空表示不限', 'error')
      $('goal-mode-budget')?.focus()
      return
    }
    tokenBudget = Math.floor(n)
  }
  _send('set', {
    objective,
    status: 'active',
    ...(tokenBudget !== undefined ? { tokenBudget } : { tokenBudget: null }),
  })
}

function _bindRoot() {
  $('goal-mode-toggle')?.addEventListener('click', () => {
    const goal = _currentGoal()
    if (!_expanded && goal && !goal.cleared) _fillForm(goal)
    _setExpanded(!_expanded)
  })
  $('goal-mode-refresh')?.addEventListener('click', () => _send('get'))
  $('goal-mode-save')?.addEventListener('click', _saveGoal)
  $('goal-mode-pause')?.addEventListener('click', () => {
    const goal = _currentGoal()
    if (goal?.status === 'paused') _send('set', { status: 'active' })
    else _send('set', { status: 'paused' })
  })
  $('goal-mode-complete')?.addEventListener('click', () => _send('set', { status: 'complete' }))
  $('goal-mode-clear')?.addEventListener('click', () => _send('clear'))
  $('goal-mode-collapse')?.addEventListener('click', () => _setExpanded(false))
}

function _renderCurrentGoal(root, goal) {
  const box = $('goal-mode-current')
  if (!box) return
  if (!goal || goal.cleared) {
    box.hidden = true
    box.innerHTML = ''
    return
  }
  const pct = _progressPercent(goal)
  const statusClass = String(goal.status || 'active')
  box.hidden = false
  box.innerHTML = `
    <div class="goal-mode-current-head">
      <span class="goal-mode-current-label">当前 Goal</span>
      <span class="goal-mode-state ${htmlSafeEscape(statusClass)}">${htmlSafeEscape(_statusLabel(goal))}</span>
    </div>
    <div class="goal-mode-current-objective"></div>
    <div class="goal-mode-current-meta">
      <span>${htmlSafeEscape(_formatBudget(goal))}</span>
      ${goal.timeUsedSeconds ? `<span>${Math.round(goal.timeUsedSeconds / 60)} min</span>` : ''}
    </div>
    ${pct === null ? '' : `<div class="goal-mode-progress"><span style="width:${pct}%"></span></div>`}
  `
  box.querySelector('.goal-mode-current-objective').textContent = goal.objective || '未命名目标'
}

function _maybeAutoRefresh() {
  const sess = getSession()
  if (!sess || !currentAgentSupportsGoals()) return
  const key = `${sess.id}:${sess.agentId || ''}`
  if (_lastAutoRefreshKey === key) return
  clearTimeout(_autoRefreshTimer)
  _autoRefreshTimer = setTimeout(() => {
    if (getSession()?.id !== sess.id || !currentAgentSupportsGoals()) return
    if (sendGoalControl('get', {}, { silent: true })) _lastAutoRefreshKey = key
  }, 250)
}

export function renderGoalModePanel({ autoRefresh = false } = {}) {
  const root = _ensureRoot()
  if (!root) return
  const supported = currentAgentSupportsGoals()
  root.hidden = !supported
  if (!supported) {
    _expanded = false
    return
  }
  const goal = _currentGoal()
  if (autoRefresh) _maybeAutoRefresh()

  const hasGoal = !!goal && !goal.cleared
  const panel = $('goal-mode-panel')
  const toggle = $('goal-mode-toggle')
  const summary = $('goal-mode-summary')
  const pause = $('goal-mode-pause')
  const complete = $('goal-mode-complete')
  const clear = $('goal-mode-clear')
  const save = $('goal-mode-save')

  root.classList.toggle('has-goal', hasGoal)
  root.classList.toggle('expanded', _expanded || hasGoal)
  if (toggle) {
    toggle.setAttribute('aria-expanded', _expanded || hasGoal ? 'true' : 'false')
    toggle.setAttribute('aria-pressed', hasGoal ? 'true' : 'false')
  }
  if (summary) {
    summary.textContent = hasGoal
      ? `${_statusLabel(goal)} · ${goal.objective || '未命名目标'}`
      : '给 Codex 设置一个持续目标，后续消息自动围绕它推进'
  }
  if (panel) panel.hidden = !(_expanded || hasGoal)

  _renderCurrentGoal(root, goal)
  if (_expanded && hasGoal) _fillForm(goal)

  if (pause) {
    pause.hidden = !hasGoal || goal.status === 'complete'
    pause.textContent = goal?.status === 'paused' ? '继续' : '暂停'
  }
  if (complete) complete.hidden = !hasGoal || goal.status === 'complete'
  if (clear) clear.hidden = !hasGoal
  if (save) save.textContent = hasGoal ? '更新 Goal' : '启用 Goal'
}

export function settleGoalModePanel() {
  _setPending(false)
  renderGoalModePanel()
}

export function initGoalModePanel() {
  _ensureRoot()
  window.addEventListener('openclaude:goal-panel-open', (event) => {
    const detail = event.detail || {}
    _setExpanded(true)
    if (typeof detail.prefill === 'string' && detail.prefill) {
      const input = $('goal-mode-objective')
      if (input) input.value = detail.prefill
    } else {
      _fillForm(_currentGoal())
    }
  })
  renderGoalModePanel({ autoRefresh: true })
}

// Re-export for code that wants to open the panel without depending on DOM details.
export { openGoalPanel } from './goalControl.js?v=2'
