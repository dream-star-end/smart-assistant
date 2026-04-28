// OpenClaude — composer 模型选择器(2026-04-26 v1.0.4 重写为 C 方案)
//
// 模型选择是 per-user(走 user_preferences.default_model),不是 per-agent。
// 切换路径:
//   1. PATCH /api/me/preferences { default_model: '<model-id>' }
//   2. 写回 state.userPrefs(setCachedPrefField),prefs modal / effortMode 同步
//   3. 后续 sendMessage 帧里塞 frame.model = state.userPrefs.default_model
//      → server.ts WS 入口经静态白名单后透传给 sessionManager.submit(model)
//      → runner setModel + shutdown,下次 spawn 用新模型(anthropicProxy 自动改计费)
//
// 真相源:state.userPrefs.default_model(由 main.js 在登录 + 冷启动两条路径
//   prefetch,失败 fallback {})。pill 文案展示"用户偏好 || agent 默认"。
//
// 列表来源:GET /api/models(getEnabledModels 缓存,与 prefs modal 共用)。
//   admin 把某模型下线后,菜单不再列;若 prefs.default_model 仍指向已下线模型
//   pill 仍显示该 id(便于让用户知道并主动改),发出去由 server 静态白名单兜底。
//
// 弹窗 / 键盘导航 / position:fixed 完全照旧,只换数据源。
//
// 之前的 PUT /api/agents/:id { model } 路径被 v3 多租户防火墙 BLOCKED_FOR_USER
// 拦截(只有 host admin 能改 agent 配置),因此切换不到这条路。

import { apiJson } from './api.js?v=e75ef57'
import { $ } from './dom.js?v=e75ef57'
import { renderModePills } from './effortMode.js?v=e75ef57'
import { getSession, state } from './state.js?v=e75ef57'
import { toast, toastOptsFromError } from './ui.js?v=e75ef57'
import { getEnabledModels, setCachedPrefField } from './userPrefs.js?v=e75ef57'

// ── 当前选择(prefs 优先,否则 agent.model)─────────────────────────

function getCurrentAgent() {
  const sess = getSession()
  if (!sess) return null
  const agentId = sess.agentId || state.defaultAgentId
  if (!agentId) return null
  return (state.agentsList || []).find((a) => a.id === agentId) || null
}

/** 当前生效模型 id:用户偏好 > agent 默认 > ''。 */
function getEffectiveModel() {
  const pref = state.userPrefs?.default_model
  if (typeof pref === 'string' && pref) return pref
  return getCurrentAgent()?.model || ''
}

let _modelsCache = null
async function _ensureModels() {
  _modelsCache = await getEnabledModels()
  return _modelsCache
}

function modelDisplayName(modelId) {
  if (!modelId) return '—'
  const m = (_modelsCache || []).find((x) => x.id === modelId)
  if (m && m.display_name) {
    // 把"Claude Opus 4.7" → "Opus 4.7"(去品牌前缀,pill 紧凑)
    return String(m.display_name).replace(/^Claude\s+/i, '')
  }
  // fallback: 从 id 推 e.g. claude-opus-4-7 → Opus 4.7
  const m2 = /^claude-(opus|sonnet|haiku)-(\d+)-(\d+)/i.exec(modelId)
  if (m2) {
    const cap = m2[1].charAt(0).toUpperCase() + m2[1].slice(1).toLowerCase()
    return `${cap} ${m2[2]}.${m2[3]}`
  }
  return modelId
}

// ── 弹窗位置(原样)─────────────────────────────────────────────────

function getTrigger() { return $('model-trigger') }
function getMenu() { return $('model-menu') }

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
  const menuMinWidth = 240
  const maxLeft = Math.max(8, window.innerWidth - menuMinWidth - 8)
  menu.style.left = `${Math.min(rect.left, maxLeft)}px`
  menu.style.right = 'auto'
  menu.style.top = 'auto'
}

let outsideClickListener = null
let keydownListener = null
let reflowListener = null

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

async function openMenu(focusFirst = false) {
  const trigger = getTrigger()
  const menu = getMenu()
  if (!trigger || !menu) return
  await ensureMenuRendered()
  positionMenu()
  menu.hidden = false
  trigger.setAttribute('aria-expanded', 'true')
  const items = Array.from(menu.querySelectorAll('[role="option"]'))
  if (items.length > 0) {
    const cur = getEffectiveModel()
    const target = items.find((el) => el.dataset.modelId === cur) || items[0]
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

// ── 渲染 ───────────────────────────────────────────────────────────

async function ensureMenuRendered() {
  const menu = getMenu()
  if (!menu) return
  await _ensureModels()
  const cur = getEffectiveModel()
  menu.innerHTML = ''
  const frag = document.createDocumentFragment()
  for (const m of (_modelsCache || [])) {
    if (!m.id) continue
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'effort-menu-item'
    btn.setAttribute('role', 'option')
    btn.dataset.modelId = String(m.id)
    btn.tabIndex = -1
    const sel = m.id === cur
    btn.setAttribute('aria-selected', sel ? 'true' : 'false')
    if (sel) btn.classList.add('effort-menu-item--selected')
    const dn = String(m.display_name || m.id)
    const hint = m.id === 'claude-opus-4-7'
      ? '深度推理 · 默认推荐'
      : m.id === 'claude-sonnet-4-6'
        ? '更便宜 · 适合常规任务'
        : ''
    btn.innerHTML =
      `<span class="effort-menu-label">${escapeHtml(dn)}</span>` +
      `<span class="effort-menu-hint">${escapeHtml(hint)}</span>`
    frag.appendChild(btn)
  }
  if (frag.childElementCount === 0) {
    const empty = document.createElement('div')
    empty.className = 'effort-menu-item'
    empty.style.opacity = '0.6'
    empty.style.pointerEvents = 'none'
    empty.innerHTML = '<span class="effort-menu-label">无可用模型</span>'
    frag.appendChild(empty)
  }
  menu.appendChild(frag)
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c])
}

/** 渲染 model pill 的可见性 + label。
 *  - state.userPrefs===null(未拉取)→ 隐藏整个 composer-modes,避免"Opus → Sonnet"闪烁
 *  - 没有当前 agent → 隐藏(冷启动 race 等)
 *  - 否则展示 effective model */
export function renderModelPill() {
  const wrap = $('composer-modes')
  if (!wrap) return
  // prefs 还在拉取 → 暂时不暴露 pill,给后台 prefetch 收尾
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
  if (labelEl) labelEl.textContent = `模型: ${modelDisplayName(getEffectiveModel())}`
}

// ── 提交切换 ───────────────────────────────────────────────────────

async function _commitModel(modelId) {
  const cur = getEffectiveModel()
  if (modelId === cur) return  // 无变化
  const trigger = getTrigger()
  if (trigger) trigger.disabled = true
  try {
    await apiJson('PATCH', '/api/me/preferences', { default_model: modelId })
    setCachedPrefField('default_model', modelId)
    // 切到 / 离开 Opus 4.7 时 effort pill 可见性会变,要刷新
    renderModePills()
    renderModelPill()
    toast(`已切换到 ${modelDisplayName(modelId)}`, 'success')
  } catch (err) {
    toast('切换模型失败: ' + (err?.message || err), 'error', toastOptsFromError(err))
    // 失败 → state.userPrefs 没变,UI 由 renderModelPill 自洽
    renderModelPill()
  } finally {
    if (trigger) trigger.disabled = false
  }
}

// ── Bind ───────────────────────────────────────────────────────────

let _wired = false

/** 一次性绑定 trigger 点击 + 菜单键盘导航。
 *  v1.0.4 起 opts.reload 不再使用(无 agent 写,不需要刷 agents.js 缓存),
 *  保留参数签名兼容 main.js 老调用。 */
export function initModelPicker(_opts = {}) {
  if (_wired) return
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
    const btn = e.target.closest('[role="option"]')
    if (!btn || !menu.contains(btn)) return
    const id = btn.dataset.modelId
    if (!id) return
    closeMenu(true)
    _commitModel(id)
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
        const id = btn.dataset.modelId
        if (id) {
          closeMenu(true)
          _commitModel(id)
        }
      }
    }
  })
  _wired = true
  renderModelPill()
}
