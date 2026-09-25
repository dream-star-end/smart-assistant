// Session goal, docked on the composer. The transcript card stays in the
// message list for history, but CSS hides it. This bar is the only copy
// the user sees, and it stays one line unless they open it.
import { getSession, state } from './state.js?v=501cba4f'
import { safeWsSend } from './websocket.js?v=501cba4f'
import { updateMessageEl } from './messages.js?v=501cba4f'

const STATUS_LABEL = {
  active: '进行中',
  paused: '已暂停',
  blocked: '阻塞',
  complete: '已完成',
  completed: '已完成',
  usageLimited: '用量受限',
  usage_limited: '用量受限',
  budgetLimited: '预算到顶',
  budget_limited: '预算到顶',
  cleared: '已清除',
}

let collapseTimer = 0
let pointerInside = false
let bound = false

function $(id) {
  return document.getElementById(id)
}

function latestGoal(sess) {
  if (!sess?.messages) return null
  for (let i = sess.messages.length - 1; i >= 0; i--) {
    const msg = sess.messages[i]
    if (msg?.role === 'goal') return msg
  }
  return null
}

function visibleGoal(sess) {
  const msg = latestGoal(sess)
  if (!msg || msg.cleared || msg.status === 'cleared') return null
  return msg
}

function compactTokens(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return ''
  if (value < 1000) return String(Math.round(value))
  if (value < 10000) {
    const text = (value / 1000).toFixed(1)
    return `${text.endsWith('.0') ? text.slice(0, -2) : text}k`
  }
  if (value < 1000000) return `${Math.round(value / 1000)}k`
  const text = (value / 1000000).toFixed(1)
  return `${text.endsWith('.0') ? text.slice(0, -2) : text}M`
}

function formatDuration(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return ''
  const total = Math.round(seconds)
  if (total < 60) return `${total}秒`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}分`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours}小时${rest}分` : `${hours}小时`
}

function tokenStat(msg) {
  const used = compactTokens(msg.tokensUsed)
  if (!used) return ''
  const budget = compactTokens(msg.tokenBudget)
  return budget ? `${used}/${budget}` : used
}

function statusKey(status) {
  if (status === 'paused') return 'paused'
  if (status === 'complete' || status === 'completed') return 'done'
  if (status === 'blocked' || status === 'budgetLimited' || status === 'budget_limited') return 'warn'
  return 'active'
}

function setOpen(open) {
  const dock = $('goal-dock')
  const line = $('goal-dock-line')
  const body = $('goal-dock-body')
  if (!dock || !line || !body) return
  if (!open && dock.dataset.editing === '1') return
  dock.dataset.open = open ? '1' : '0'
  line.setAttribute('aria-expanded', open ? 'true' : 'false')
  body.hidden = !open
}

function armCollapse() {
  clearTimeout(collapseTimer)
  const dock = $('goal-dock')
  if (!dock || dock.dataset.open !== '1') return
  if (pointerInside || dock.dataset.editing === '1' || dock.dataset.confirm === '1') return
  collapseTimer = setTimeout(() => setOpen(false), 3000)
}

function sendAction(action, objective) {
  const sess = getSession()
  if (!sess) return
  const payload = {
    type: 'inbound.control.goal',
    channel: 'webchat',
    peer: { id: sess.id, kind: 'dm' },
    agentId: sess.agentId || state.defaultAgentId,
    action,
  }
  if (typeof objective === 'string') payload.objective = objective
  safeWsSend(state.ws, JSON.stringify(payload))
  const msg = latestGoal(sess)
  if (!msg) return
  if (action === 'clear') {
    msg.cleared = true
    msg.status = 'cleared'
  } else if (action === 'pause') {
    msg.status = 'paused'
    msg.cleared = false
  } else if (action === 'resume' || action === 'set') {
    msg.status = 'active'
    msg.cleared = false
    if (action === 'set' && objective) msg.text = objective
  }
  try { updateMessageEl(msg, false) } catch {}
}

function paintActions(msg) {
  const edit = $('goal-dock-edit')
  const toggle = $('goal-dock-toggle')
  const save = $('goal-dock-save')
  const cancel = $('goal-dock-cancel')
  const ask = $('goal-dock-ask')
  const dock = $('goal-dock')
  if (!edit || !toggle || !save || !cancel || !ask || !dock) return
  const editing = dock.dataset.editing === '1'
  const done = msg.status === 'complete' || msg.status === 'completed'
  edit.hidden = editing || done
  toggle.hidden = editing || done
  ask.hidden = editing
  save.hidden = !editing
  cancel.hidden = !editing
  if (!editing) {
    toggle.textContent = msg.status === 'paused' ? '继续' : '暂停'
  }
}

export function syncGoalDock() {
  const dock = $('goal-dock')
  const inner = document.querySelector('.composer-inner')
  if (!dock) return
  const msg = visibleGoal(getSession())
  if (!msg || dock.dataset.editing === '1') {
    if (!msg) {
      dock.hidden = true
      dock.dataset.open = '0'
      inner?.classList.remove('has-goal')
    }
    return
  }
  dock.hidden = false
  inner?.classList.add('has-goal')
  const status = msg.status || 'active'
  dock.dataset.state = statusKey(status)
  const pill = $('goal-dock-pill')
  const title = $('goal-dock-title')
  const stat = $('goal-dock-stat')
  const objective = $('goal-dock-objective')
  const meta = $('goal-dock-meta')
  const note = $('goal-dock-note')
  const text = msg.text || ''
  if (pill) pill.textContent = STATUS_LABEL[status] || status || '进行中'
  if (title) title.textContent = text
  const pieces = [tokenStat(msg), formatDuration(msg.timeUsedSeconds)].filter(Boolean)
  if (stat) stat.textContent = pieces.join(' · ')
  if (objective) objective.textContent = text
  if (meta) {
    const fullUsed = typeof msg.tokensUsed === 'number' ? msg.tokensUsed.toLocaleString('zh-CN') : ''
    const fullBudget = typeof msg.tokenBudget === 'number' ? msg.tokenBudget.toLocaleString('zh-CN') : ''
    const tokenText = fullUsed
      ? (fullBudget ? `Token ${fullUsed} / ${fullBudget}` : `Token ${fullUsed}`)
      : ''
    const bits = [tokenText, formatDuration(msg.timeUsedSeconds) ? `已跑 ${formatDuration(msg.timeUsedSeconds)}` : '']
    meta.textContent = bits.filter(Boolean).join(' · ')
  }
  if (note) {
    note.textContent = status === 'paused'
      ? '已暂停，不会自动续跑。离开后折回一行。'
      : '点这一行展开。不在编辑时，离开约 3 秒折回一行。'
  }
  paintActions(msg)
}

function beginEdit() {
  const msg = visibleGoal(getSession())
  const dock = $('goal-dock')
  const box = $('goal-dock-editbox')
  if (!msg || !dock || !box) return
  clearTimeout(collapseTimer)
  setOpen(true)
  dock.dataset.editing = '1'
  dock.dataset.confirm = '0'
  box.value = msg.text || ''
  const objective = $('goal-dock-objective')
  if (objective) objective.hidden = true
  box.hidden = false
  paintActions(msg)
  box.focus()
}

function endEdit(save) {
  const dock = $('goal-dock')
  const box = $('goal-dock-editbox')
  const objective = $('goal-dock-objective')
  if (!dock || !box) return
  const next = box.value.trim()
  if (save && next) sendAction('set', next)
  dock.dataset.editing = '0'
  box.hidden = true
  if (objective) objective.hidden = false
  syncGoalDock()
  if (save) setOpen(false)
  else armCollapse()
}

export function bindGoalDock() {
  if (bound) return
  const dock = $('goal-dock')
  const line = $('goal-dock-line')
  if (!dock || !line) return
  bound = true
  line.addEventListener('click', () => {
    const open = dock.dataset.open === '1'
    setOpen(!open)
    if (!open) armCollapse()
  })
  dock.addEventListener('pointerenter', () => {
    pointerInside = true
    clearTimeout(collapseTimer)
  })
  dock.addEventListener('pointerleave', () => {
    pointerInside = false
    armCollapse()
  })
  $('goal-dock-edit')?.addEventListener('click', beginEdit)
  $('goal-dock-save')?.addEventListener('click', () => endEdit(true))
  $('goal-dock-cancel')?.addEventListener('click', () => endEdit(false))
  $('goal-dock-toggle')?.addEventListener('click', () => {
    const msg = visibleGoal(getSession())
    if (!msg) return
    sendAction(msg.status === 'paused' ? 'resume' : 'pause', msg.text || '')
    syncGoalDock()
    armCollapse()
  })
  $('goal-dock-ask')?.addEventListener('click', () => {
    clearTimeout(collapseTimer)
    dock.dataset.confirm = '1'
  })
  $('goal-dock-no')?.addEventListener('click', () => {
    dock.dataset.confirm = '0'
    armCollapse()
  })
  $('goal-dock-yes')?.addEventListener('click', () => {
    sendAction('clear')
    dock.dataset.confirm = '0'
    dock.dataset.editing = '0'
    setOpen(false)
    syncGoalDock()
  })
  const root = document.getElementById('messages')
  if (root && typeof MutationObserver === 'function') {
    const observer = new MutationObserver(() => syncGoalDock())
    observer.observe(root, { childList: true, subtree: true, characterData: true })
  }
  syncGoalDock()
}
