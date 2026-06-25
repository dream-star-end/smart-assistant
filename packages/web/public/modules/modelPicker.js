// OpenClaude — composer unified assistant picker
//
// The composer no longer exposes a separate header agent selector or team pill.
// This menu is the single target picker:
//   - 单 Agent: switch session agent and adjust the per-user default_model.
//   - 多 Agent: select a saved team; sendMessage routes through the team leader.

import { apiJson } from './api.js?v=c26a43d4'
import { $, htmlSafeEscape } from './dom.js?v=c26a43d4'
import { renderModePills } from './effortMode.js?v=c26a43d4'
import { openPersonaEditor } from './agents.js?v=c26a43d4'
import {
  clearSelectedAgentTeam,
  getAgentTeamById,
  openTeamEditor,
  selectAgentTeam,
  teamDisplayPrefix,
} from './agentTeams.js?v=c26a43d4'
import { getSession, state } from './state.js?v=c26a43d4'
import { openModal, toast, toastOptsFromError, confirmDialog } from './ui.js?v=c26a43d4'
import { getEnabledModels, setCachedPrefField } from './userPrefs.js?v=c26a43d4'
import { getEffectiveSingleAgentModel } from './modelPolicy.js?v=c26a43d4'

function getCurrentAgentId() {
  const sess = getSession()
  return sess?.agentId || state.defaultAgentId || ''
}

function getCurrentAgent() {
  const agentId = getCurrentAgentId()
  if (!agentId) return null
  return (state.agentsList || []).find((a) => a.id === agentId) || null
}

function getEffectiveModel() {
  return getEffectiveSingleAgentModel({
    userPrefs: state.userPrefs,
    agentId: getCurrentAgentId(),
    defaultAgentId: state.defaultAgentId,
    agentsList: state.agentsList,
  })
}

let _modelsCache = null
async function _ensureModels() {
  _modelsCache = await getEnabledModels()
  return _modelsCache
}

function modelDisplayName(modelId) {
  if (!modelId) return '未配置模型'
  const m = (_modelsCache || []).find((x) => x.id === modelId)
  if (m && m.display_name) return String(m.display_name).replace(/^Claude\s+/i, '')
  const m2 = /^claude-(opus|sonnet|haiku)-(\d+)-(\d+)/i.exec(modelId)
  if (m2) {
    const cap = m2[1].charAt(0).toUpperCase() + m2[1].slice(1).toLowerCase()
    return `${cap} ${m2[2]}.${m2[3]}`
  }
  return modelId
}

function agentLabel(agent) {
  if (!agent) return '默认 Agent'
  return `${agent.avatarEmoji ? `${agent.avatarEmoji} ` : ''}${agent.displayName || agent.id}`
}

// 退出团队模式确认 —— 委派给共享 confirmDialog(单一确认弹窗来源,U3)。
function confirmExitTeam(teamLabel) {
  return confirmDialog({
    title: '退出团队模式?',
    body: `当前正在使用团队「${teamLabel}」。切换模型会退出团队模式,本次之后将只发送给单 Agent。`,
    confirmText: '继续切换',
    icon: '👥',
  })
}

function notifyModelPolicyFixed(modelId) {
  try {
    window.dispatchEvent(new CustomEvent('openclaude:model-policy-fixed', { detail: { modelId } }))
  } catch {}
}

function getTrigger() { return $('model-trigger') }
function getMenu() { return $('model-menu') }

function ensureMenuPortal(menu) {
  if (!menu || !document.body || menu.parentElement === document.body) return
  menu.dataset.composerMenuPortal = 'true'
  document.body.appendChild(menu)
}

function isMenuOpen() {
  const m = getMenu()
  return !!m && !m.hidden
}

function positionMenu() {
  const trigger = getTrigger()
  const menu = getMenu()
  if (!trigger || !menu) return
  const rect = trigger.getBoundingClientRect()
  menu.style.position = 'fixed'
  menu.style.bottom = `${Math.max(0, window.innerHeight - rect.top + 6)}px`
  const menuWidth = Math.max(360, Math.min(menu.getBoundingClientRect().width || 560, window.innerWidth - 16))
  const maxLeft = Math.max(8, window.innerWidth - menuWidth - 8)
  menu.style.left = `${Math.min(rect.left, maxLeft)}px`
  menu.style.right = 'auto'
  menu.style.top = 'auto'
}

let outsideClickListener = null
let keydownListener = null
let reflowListener = null
let switchAgentHandler = null

function attachGlobalListeners() {
  if (outsideClickListener) return
  outsideClickListener = (ev) => {
    const trigger = getTrigger()
    const menu = getMenu()
    if (!trigger || !menu) return
    if (trigger.contains(ev.target) || menu.contains(ev.target)) return
    closeMenu(false)
  }
  keydownListener = (ev) => {
    if (!isMenuOpen()) return
    if (ev.key === 'Escape') {
      ev.preventDefault()
      closeMenu(true)
    } else if (ev.key === 'Tab') {
      closeMenu(false)
    }
  }
  let rafId = 0
  reflowListener = () => {
    if (rafId) return
    rafId = requestAnimationFrame(() => {
      rafId = 0
      if (isMenuOpen()) positionMenu()
    })
  }
  document.addEventListener('pointerdown', outsideClickListener, true)
  document.addEventListener('keydown', keydownListener, true)
  window.addEventListener('resize', reflowListener)
  window.addEventListener('scroll', reflowListener, true)
}

function detachGlobalListeners() {
  if (outsideClickListener) {
    document.removeEventListener('pointerdown', outsideClickListener, true)
    outsideClickListener = null
  }
  if (keydownListener) {
    document.removeEventListener('keydown', keydownListener, true)
    keydownListener = null
  }
  if (reflowListener) {
    window.removeEventListener('resize', reflowListener)
    window.removeEventListener('scroll', reflowListener, true)
    reflowListener = null
  }
}

const POPUP_SOURCE = 'model'

async function openMenu(focusFirst = false) {
  const trigger = getTrigger()
  const menu = getMenu()
  if (!trigger || !menu) return
  document.dispatchEvent(
    new CustomEvent('composer-popup-opening', { detail: { source: POPUP_SOURCE } }),
  )
  await ensureMenuRendered()
  ensureMenuPortal(menu)
  positionMenu()
  menu.hidden = false
  trigger.setAttribute('aria-expanded', 'true')
  const items = Array.from(menu.querySelectorAll('[role="option"]'))
  if (items.length > 0) {
    const selectedTeamId = state.selectedTeamId || ''
    const currentAgentId = getSession()?.agentId || state.defaultAgentId
    const currentModel = getEffectiveModel()
    const target =
      (selectedTeamId && items.find((el) => el.dataset.teamId === selectedTeamId)) ||
      items.find((el) => el.dataset.agentId === currentAgentId) ||
      items.find((el) => el.dataset.modelId === currentModel) ||
      items[0]
    for (const it of items) it.setAttribute('tabindex', it === target ? '0' : '-1')
    if (focusFirst) target.focus()
  }
  attachGlobalListeners()
}

function closeMenu(returnFocusToTrigger = true) {
  const trigger = getTrigger()
  const menu = getMenu()
  if (menu) menu.hidden = true
  if (trigger) {
    trigger.setAttribute('aria-expanded', 'false')
    if (returnFocusToTrigger) trigger.focus()
  }
  detachGlobalListeners()
}

function section(title, hint) {
  const el = document.createElement('div')
  el.className = 'target-menu-section'
  el.innerHTML = `<div class="target-menu-section-title">${htmlSafeEscape(title)}</div><div class="target-menu-section-hint">${htmlSafeEscape(hint)}</div>`
  return el
}

function optionButton({ type, id, title, hint, meta, selected, icon = '🤖' }) {
  const btn = document.createElement('div')
  btn.className = 'effort-menu-item target-menu-item'
  btn.setAttribute('role', 'option')
  btn.dataset.targetType = type
  if (type === 'agent') btn.dataset.agentId = id
  if (type === 'model') btn.dataset.modelId = id
  if (type === 'team') btn.dataset.teamId = id
  btn.tabIndex = -1
  btn.setAttribute('aria-selected', selected ? 'true' : 'false')
  if (selected) btn.classList.add('effort-menu-item--selected', 'target-menu-item--selected')
  btn.innerHTML = `
    <span class="target-menu-icon" aria-hidden="true">${htmlSafeEscape(icon)}</span>
    <span class="target-menu-copy">
      <span class="effort-menu-label">${htmlSafeEscape(title)}</span>
      <span class="effort-menu-hint">${htmlSafeEscape(hint || '')}</span>
      ${meta ? `<span class="target-menu-meta">${htmlSafeEscape(meta)}</span>` : ''}
    </span>`
  return btn
}

async function ensureMenuRendered() {
  const menu = getMenu()
  if (!menu) return
  await _ensureModels()
  const sess = getSession()
  const currentAgentId = sess?.agentId || state.defaultAgentId
  const currentModel = getEffectiveModel()
  const currentTeamId = state.selectedTeamId || ''
  menu.innerHTML = ''
  menu.classList.add('target-menu')

  menu.appendChild(section('单 Agent', '选择当前对话的 Agent；也可以在这里切换单 Agent 使用的模型。'))
  const agents = state.agentsList || []
  if (agents.length > 0) {
    for (const agent of agents) {
      const row = optionButton({
        type: 'agent',
        id: agent.id,
        icon: agent.avatarEmoji || '🤖',
        title: agent.displayName || agent.id,
        hint: `${agent.id}${agent.id === state.defaultAgentId ? ' · 默认' : ''}`,
        meta: `默认模型: ${modelDisplayName(agent.model || '')}`,
        selected: !currentTeamId && agent.id === currentAgentId,
      })
      const edit = document.createElement('button')
      edit.type = 'button'
      edit.className = 'target-menu-edit'
      edit.textContent = '编辑'
      edit.setAttribute('aria-label', `编辑 Agent ${agent.displayName || agent.id}`)
      edit.disabled = Boolean(state.agentsListIsFallback)
      edit.addEventListener('click', (ev) => {
        ev.preventDefault()
        ev.stopPropagation()
        closeMenu(false)
        openPersonaEditor(agent.id)
      })
      row.appendChild(edit)
      menu.appendChild(row)
    }
  } else {
    const empty = document.createElement('div')
    empty.className = 'target-menu-empty'
    empty.textContent = '暂无 Agent。请到管理 Agents 创建。'
    menu.appendChild(empty)
  }

  menu.appendChild(section('多 Agent', '选择团队后，本条消息会由队长分派成员协作并汇总。'))
  const teams = state.agentTeams || []
  if (teams.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'target-menu-empty'
    empty.innerHTML = '<span>还没有团队。到“管理 Agents”使用科研/编程模板创建。</span>'
    menu.appendChild(empty)
  } else {
    for (const team of teams) {
      const members = (team.members || []).map((m) => m.role || m.agentId).join(' / ')
      const row = optionButton({
        type: 'team',
        id: team.id,
        icon: '👥',
        title: team.name || team.id,
        hint: `队长: ${team.leaderAgentId} · ${team.leaderRole || '团队协调者'}`,
        meta: members ? `成员: ${members}` : '未配置成员',
        selected: currentTeamId === team.id,
      })
      const edit = document.createElement('button')
      edit.type = 'button'
      edit.className = 'target-menu-edit'
      edit.textContent = '编辑'
      edit.setAttribute('aria-label', `编辑团队 ${team.name || team.id}`)
      edit.addEventListener('click', (ev) => {
        ev.preventDefault()
        ev.stopPropagation()
        closeMenu(false)
        openModal('agents-modal')
        openTeamEditor(team.id)
      })
      row.appendChild(edit)
      menu.appendChild(row)
    }
  }

  const modelHead = document.createElement('div')
  modelHead.className = 'target-menu-subhead target-menu-subhead--models'
  modelHead.textContent = currentTeamId
    ? '运行模型 · 当前团队由队长配置决定'
    : `运行模型 · ${agentLabel(getCurrentAgent())}`
  menu.appendChild(modelHead)
  for (const m of (_modelsCache || [])) {
    if (!m.id) continue
    const dn = String(m.display_name || m.id)
    const hint = m.id === 'claude-opus-4-7'
      ? '深度推理 · 默认推荐'
      : m.id === 'claude-sonnet-4-6'
        ? '更便宜 · 适合常规任务'
        : currentTeamId
          ? '切换后会退出团队模式并应用到单 Agent 发送'
          : '切换后应用到单 Agent 发送'
    menu.appendChild(optionButton({
      type: 'model',
      id: String(m.id),
      icon: '',
      title: dn,
      hint,
      meta: String(m.id),
      selected: !currentTeamId && m.id === currentModel,
    }))
  }
}

export function renderModelPill() {
  const wrap = $('composer-modes')
  if (!wrap) return
  if (state.userPrefs === null) {
    wrap.hidden = true
    if (isMenuOpen()) closeMenu(false)
    return
  }
  const agent = getCurrentAgent()
  if (!agent) {
    wrap.hidden = true
    if (isMenuOpen()) closeMenu(false)
    return
  }
  wrap.hidden = false
  const trigger = getTrigger()
  if (!trigger) return
  const labelEl = $('model-label')
  const team = state.selectedTeamId ? getAgentTeamById(state.selectedTeamId) : null
  if (labelEl) {
    labelEl.textContent = team
      ? `团队: ${teamDisplayPrefix(team).replace(/^👥\s*/, '')}`
      : `助手: ${(agent.displayName || agent.id)} · ${modelDisplayName(getEffectiveModel())}`
  }
  trigger.setAttribute('aria-pressed', team ? 'true' : 'false')
}

async function _commitModel(modelId) {
  const cur = getEffectiveModel()
  const hadTeam = !!state.selectedTeamId
  if (hadTeam) {
    const team = getAgentTeamById(state.selectedTeamId)
    const ok = await confirmExitTeam(team?.name || state.selectedTeamId)
    if (!ok) {
      renderModelPill()
      return
    }
  }
  clearSelectedAgentTeam()
  if (modelId === cur) {
    renderModelPill()
    if (hadTeam) {
      toast('已退出团队模式，当前为单 Agent 发送', 'success')
      notifyModelPolicyFixed(modelId)
    }
    return
  }
  const trigger = getTrigger()
  if (trigger) trigger.disabled = true
  try {
    await apiJson('PATCH', '/api/me/preferences', { default_model: modelId })
    setCachedPrefField('default_model', modelId)
    renderModePills()
    renderModelPill()
    toast(`已切换到 ${modelDisplayName(modelId)}`, 'success')
    notifyModelPolicyFixed(modelId)
  } catch (err) {
    toast('切换模型失败: ' + (err?.message || err), 'error', toastOptsFromError(err))
    renderModelPill()
  } finally {
    if (trigger) trigger.disabled = false
  }
}

function _commitAgent(agentId) {
  clearSelectedAgentTeam()
  if (typeof switchAgentHandler === 'function') switchAgentHandler(agentId)
  renderModelPill()
}

function _commitTeam(teamId) {
  selectAgentTeam(teamId)
  renderModelPill()
  const team = getAgentTeamById(teamId)
  toast(`已切换到团队: ${team?.name || teamId}`, 'success')
}

let _wired = false

export function initModelPicker(opts = {}) {
  if (_wired) return
  switchAgentHandler = typeof opts.onSwitchAgent === 'function' ? opts.onSwitchAgent : null
  const trigger = getTrigger()
  const menu = getMenu()
  if (!trigger || !menu) return

  trigger.addEventListener('click', (e) => {
    e.preventDefault()
    isMenuOpen() ? closeMenu(false) : openMenu(false)
  })
  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      isMenuOpen() ? closeMenu(false) : openMenu(false)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      openMenu(true)
    }
  })
  menu.addEventListener('click', (e) => {
    if (e.target.closest('.target-menu-edit')) return
    const btn = e.target.closest('[role="option"]')
    if (!btn || !menu.contains(btn)) return
    closeMenu(true)
    if (btn.dataset.targetType === 'agent') _commitAgent(btn.dataset.agentId)
    else if (btn.dataset.targetType === 'model') _commitModel(btn.dataset.modelId)
    else if (btn.dataset.targetType === 'team') _commitTeam(btn.dataset.teamId)
  })
  menu.addEventListener('keydown', (e) => {
    const items = Array.from(menu.querySelectorAll('[role="option"]'))
    if (items.length === 0) return
    const active = document.activeElement
    const idx = items.indexOf(active)
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      const next = items[(idx + 1 + items.length) % items.length]
      for (const it of items) it.setAttribute('tabindex', it === next ? '0' : '-1')
      next.focus()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      const prev = items[(idx - 1 + items.length) % items.length]
      for (const it of items) it.setAttribute('tabindex', it === prev ? '0' : '-1')
      prev.focus()
    } else if (e.key === 'Home') {
      e.preventDefault()
      const first = items[0]
      for (const it of items) it.setAttribute('tabindex', it === first ? '0' : '-1')
      first.focus()
    } else if (e.key === 'End') {
      e.preventDefault()
      const last = items[items.length - 1]
      for (const it of items) it.setAttribute('tabindex', it === last ? '0' : '-1')
      last.focus()
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      const btn = items[idx]
      if (btn) {
        closeMenu(true)
        if (btn.dataset.targetType === 'agent') _commitAgent(btn.dataset.agentId)
        else if (btn.dataset.targetType === 'model') _commitModel(btn.dataset.modelId)
        else if (btn.dataset.targetType === 'team') _commitTeam(btn.dataset.teamId)
      }
    }
  })
  document.addEventListener('composer-popup-opening', (e) => {
    if (e.detail?.source !== POPUP_SOURCE && isMenuOpen()) closeMenu(false)
  })
  document.addEventListener('agent-team-selection-changed', () => {
    renderModelPill()
    if (isMenuOpen()) void ensureMenuRendered()
  })
  _wired = true
  renderModelPill()
}
