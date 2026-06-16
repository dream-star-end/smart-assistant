// OpenClaude — 模型选择器(composer popover,per-session 覆盖)
//
// 选中的 model 按 agent 持久化在 localStorage,作为"本会话覆盖"发给 gateway
// (inbound.message.model),gateway 用 setModel + recycle 切换 runner,不改
// agents.yaml。选项来自 /api/agents 响应里的 models(config.models 或默认 seed),
// 外加当前 agent 自己的默认 model(置顶,便于"回默认")。
// popover 交互沿用 v3-popover-menu-pattern:pointerdown capture 外部关闭、roving
// tabindex、键盘全导航、Tab 跳出不还焦、render 幂等。
import { $ } from './dom.js'
import { getSession, state } from './state.js'

const STORAGE_KEY = 'openclaude_model_by_agent'

let onChangeCb = null
let globalListenersBound = false
let outsideListener = null
let keydownListener = null

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
  } catch {
    // localStorage 满 / 隐私模式 — 静默失败,UI 还能用,只是不持久。
  }
}

function currentAgentId() {
  const sess = getSession()
  if (!sess) return null
  return sess.agentId || state.defaultAgentId || null
}

function agentDefaultModel() {
  const id = currentAgentId()
  const a = (state.agentsList || []).find((x) => x.id === id)
  return (typeof a?.model === 'string' && a.model) || ''
}

function labelFor(id) {
  const list = Array.isArray(state.modelsList) ? state.modelsList : []
  const m = list.find((x) => x && x.id === id)
  return m?.label || id
}

/** 选项列表:agent 默认 model 置顶(标 isDefault),再拼 config.models,按 id 去重。 */
function modelOptions() {
  const list = Array.isArray(state.modelsList) ? state.modelsList : []
  const def = agentDefaultModel()
  const out = []
  const seen = new Set()
  if (def) {
    out.push({ id: def, label: labelFor(def), isDefault: true })
    seen.add(def)
  }
  for (const m of list) {
    if (!m || typeof m.id !== 'string' || seen.has(m.id)) continue
    seen.add(m.id)
    out.push({ id: m.id, label: m.label || m.id, isDefault: m.id === def })
  }
  return out
}

/** 当前生效 model = 合法覆盖 ?? agent 默认。供 effortMode 决定思考深度档位。 */
export function getEffectiveModel() {
  const id = currentAgentId()
  const def = agentDefaultModel()
  if (!id) return def
  const v = readStore()[id]
  return modelOptions().some((o) => o.id === v) ? v : def
}

/** 决定 inbound.message.model:store 有合法选择→该 id(含"显式选默认"以便 recycle 回默认);
 *  无选择→undefined(调用方省略字段,runner 用 agent 默认 model spawn)。 */
export function getModelForSubmit() {
  const id = currentAgentId()
  if (!id) return undefined
  const v = readStore()[id]
  return modelOptions().some((o) => o.id === v) ? v : undefined
}

export function getCurrentModelLabel() {
  return labelFor(getEffectiveModel())
}

function setCurrentModel(modelId) {
  const id = currentAgentId()
  if (!id) return
  const store = readStore()
  if (modelId && modelOptions().some((o) => o.id === modelId)) store[id] = modelId
  else delete store[id]
  writeStore(store)
  closeMenu(false)
  renderModelPicker()
  // model 变 → 思考深度档位随之变(由 main.js 注入的回调驱动,避免与 effortMode 形成循环依赖)。
  if (typeof onChangeCb === 'function') onChangeCb()
}

function isMenuOpen() {
  const menu = $('model-menu')
  return !!menu && !menu.hidden
}

function openMenu() {
  const menu = $('model-menu')
  const trigger = $('model-trigger')
  if (!menu || !trigger) return
  menu.hidden = false
  trigger.setAttribute('aria-expanded', 'true')
  const items = [...menu.querySelectorAll('[role="option"]')]
  if (items.length === 0) return
  const cur = getEffectiveModel()
  const target = items.find((el) => el.dataset.model === cur) ?? items[0]
  for (const it of items) it.setAttribute('tabindex', it === target ? '0' : '-1')
  target.focus()
  attachGlobalListeners()
}

function closeMenu(returnFocus = true) {
  const menu = $('model-menu')
  const trigger = $('model-trigger')
  if (menu) menu.hidden = true
  if (trigger) {
    trigger.setAttribute('aria-expanded', 'false')
    if (returnFocus) trigger.focus()
  }
  detachGlobalListeners()
}

function attachGlobalListeners() {
  if (globalListenersBound) return
  globalListenersBound = true
  const wrap = $('composer-model')
  outsideListener = (ev) => {
    if (wrap && !wrap.contains(ev.target)) closeMenu(false)
  }
  keydownListener = (ev) => {
    if (!isMenuOpen()) return
    if (ev.key === 'Escape') {
      ev.preventDefault()
      closeMenu(true)
    } else if (ev.key === 'Tab') {
      closeMenu(false) // 非 modal:Tab 跳出不还焦
    }
  }
  // pointerdown(capture)覆盖 mouse/touch/pen,早于 menu click,保证移动端外点也能关。
  document.addEventListener('pointerdown', outsideListener, true)
  document.addEventListener('keydown', keydownListener, true)
}

function detachGlobalListeners() {
  if (!globalListenersBound) return
  globalListenersBound = false
  if (outsideListener) document.removeEventListener('pointerdown', outsideListener, true)
  if (keydownListener) document.removeEventListener('keydown', keydownListener, true)
  outsideListener = null
  keydownListener = null
}

/** 重渲选项 + 同步 trigger 标签/选中态。agent/session 切换、models 加载后调用,幂等。 */
export function renderModelPicker() {
  const wrap = $('composer-model')
  const trigger = $('model-trigger')
  const labelEl = $('model-label')
  const menu = $('model-menu')
  if (!wrap || !trigger || !labelEl || !menu) return
  const opts = modelOptions()
  // 没有可选 model(列表为空且无 agent 默认)→ 整个控件隐藏。
  if (opts.length === 0) {
    wrap.hidden = true
    if (isMenuOpen()) closeMenu(false)
    return
  }
  wrap.hidden = false
  const effective = getEffectiveModel()
  labelEl.textContent = `模型: ${labelFor(effective)}`
  // 选项随 agent 变,每次重建(清空 + append),开销低。
  menu.replaceChildren()
  for (const opt of opts) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'model-menu-item'
    btn.setAttribute('role', 'option')
    btn.dataset.model = opt.id
    btn.tabIndex = -1
    const sel = opt.id === effective
    btn.setAttribute('aria-selected', sel ? 'true' : 'false')
    btn.classList.toggle('model-menu-item--selected', sel)
    const labelSpan = document.createElement('span')
    labelSpan.className = 'label'
    labelSpan.textContent = opt.label + (opt.isDefault ? ' · 默认' : '')
    const hintSpan = document.createElement('span')
    hintSpan.className = 'hint'
    hintSpan.textContent = opt.id
    btn.append(labelSpan, hintSpan)
    menu.appendChild(btn)
  }
}

/** 一次性绑定 trigger/menu 事件。opts.onChange 在 model 选中变化后调用(用于联动 effort)。 */
export function initModelPicker(opts = {}) {
  onChangeCb = typeof opts.onChange === 'function' ? opts.onChange : null
  const trigger = $('model-trigger')
  const menu = $('model-menu')
  if (!trigger || !menu) return
  trigger.addEventListener('click', (e) => {
    e.preventDefault()
    if (isMenuOpen()) closeMenu(true)
    else openMenu()
  })
  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      isMenuOpen() ? closeMenu(true) : openMenu()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      openMenu()
    }
  })
  menu.addEventListener('click', (e) => {
    const btn = e.target.closest('[role="option"]')
    if (!btn || !menu.contains(btn)) return
    setCurrentModel(btn.dataset.model)
  })
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('[role="option"]')]
    if (items.length === 0) return
    const idx = items.indexOf(document.activeElement)
    const move = (next) => {
      for (const it of items) it.setAttribute('tabindex', it === next ? '0' : '-1')
      next.focus()
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      move(items[(idx + 1 + items.length) % items.length])
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      move(items[(idx - 1 + items.length) % items.length])
    } else if (e.key === 'Home') {
      e.preventDefault()
      move(items[0])
    } else if (e.key === 'End') {
      e.preventDefault()
      move(items[items.length - 1])
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      const cur = items[idx] || document.activeElement
      if (cur?.dataset.model) setCurrentModel(cur.dataset.model)
    }
  })
  renderModelPicker()
}
