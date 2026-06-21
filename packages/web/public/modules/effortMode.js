// OpenClaude — 思考深度(effort)选择器
//
// 与模型选择器(modelMode.js)同构的 composer popover:一个 trigger 显示当前
// 档位「思考深度: 中」,点开是下拉菜单。选中值按 agent 持久化在 localStorage,
// 作为 inbound.message.effortLevel 发给 gateway。
//
// 可见性 / 可选档位**能力驱动**:取当前生效 model(含模型选择器的 per-session
// 覆盖)在 config.models 里声明的 `efforts`(来自后端 effortsForModel(),前端不
// 写死)。空/缺省 = 不显示思考深度控件。
//
// popover 交互沿用 v3-popover-menu-pattern:pointerdown capture 外部关闭、roving
// tabindex、键盘全导航、Tab 跳出不还焦、render 幂等(与 modelMode.js 一致)。
import { $ } from './dom.js'
import { getEffectiveModel } from './modelMode.js?v=1'
import { getSession, state } from './state.js'

const STORAGE_KEY = 'openclaude_effort_by_agent'
// 与 protocol/frames.ts InboundMessage.effortLevel + config.ts EFFORT_LEVELS 一致。
const VALID = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
// 档位 id → 中文标签(纯档位命名,不带「模式」叙事)。ultracode = xhigh + 多 agent 工作流编排。
const LABELS = {
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高',
  ultracode: '多agent工作流',
}

let globalListenersBound = false
let outsideListener = null
let keydownListener = null
let repositionListener = null

/** 返回该 model 在 UI 中可调的思考深度档,**能力驱动**,两个权威源(都来自后端
 *  effortsForModel(),前端不写死):
 *    1. state.modelsList — 模型选择器的"可覆盖目标"池(config.models / 默认 seed)。
 *    2. state.agentsList — 某个 agent 自己的默认 model 带的 efforts。覆盖池里查不到时
 *       回退到这里,这样 codex 的 gpt-5.5(不是可覆盖目标、不在池里)也能正确显示思考深度。
 *  空/缺省 = 该 model 不暴露思考深度控件。新增模型只改后端能力推断,不动前端。 */
function getSupportedEfforts(modelId) {
  if (!modelId || typeof modelId !== 'string') return []
  const list = Array.isArray(state.modelsList) ? state.modelsList : []
  const inPool = list.find((x) => x && x.id === modelId)
  if (Array.isArray(inPool?.efforts)) return inPool.efforts.filter((e) => VALID.has(e))
  const agents = Array.isArray(state.agentsList) ? state.agentsList : []
  const owner = agents.find((a) => a && a.model === modelId && Array.isArray(a.efforts))
  return owner ? owner.efforts.filter((e) => VALID.has(e)) : []
}

export function modelSupportsExtraEffort(modelId) {
  return getSupportedEfforts(modelId).length > 0
}

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

/** 当前生效 model = 模型选择器的 per-session 覆盖 ?? agent 默认。 */
function currentModel() {
  return getEffectiveModel()
}

/** 取当前会话 agent 选中的 effort('low'|'medium'|'high'|'xhigh'|'max'|undefined)。
 *  返回 undefined 表示没选(用模型默认)。仅在档位被当前 model 支持时才有效。 */
export function getCurrentEffort() {
  const id = currentAgentId()
  if (!id) return undefined
  const v = readStore()[id]
  const supported = getSupportedEfforts(currentModel())
  return VALID.has(v) && supported.includes(v) ? v : undefined
}

/** 决定 inbound.message.effortLevel 的取值:
 *    - 字符串:用户在支持 effort 的会话里选了对应档
 *    - null:**显式清除** — 当前 model 支持 effort 但没选。让 gateway 把已存在
 *           runner 的 effort env 复位到模型默认(否则一旦升过档就回不去)
 *    - undefined:不传字段 — 当前 model 不支持前端 effort,完全不参与协商 */
export function getEffortForSubmit() {
  if (!modelSupportsExtraEffort(currentModel())) return undefined
  const cur = getCurrentEffort()
  return cur === undefined ? null : cur
}

/** 设置当前会话 agent 的 effort。传 undefined/null/'' 取消选中(回模型默认)。 */
function setCurrentEffort(level) {
  const id = currentAgentId()
  if (!id) return
  const store = readStore()
  if (level && VALID.has(level) && getSupportedEfforts(currentModel()).includes(level)) {
    store[id] = level
  } else {
    delete store[id]
  }
  writeStore(store)
  closeMenu(false)
  renderEffortPicker()
}

/** 选项列表:置顶「默认」(清除选择,用模型默认 effort),再拼当前 model 支持的档。 */
function effortOptions() {
  const supported = getSupportedEfforts(currentModel())
  const out = [{ id: '', label: '默认', isDefault: true }]
  for (const lvl of supported) out.push({ id: lvl, label: LABELS[lvl] || lvl })
  return out
}

function isMenuOpen() {
  const menu = $('effort-menu')
  return !!menu && !menu.hidden
}

/** 把菜单定位到 trigger 正上方(向上弹)。与 modelMode.positionMenu 同构:
 *  position:fixed + 视口坐标,逃出 .composer-inner 的 overflow:hidden。 */
function positionMenu() {
  const menu = $('effort-menu')
  const trigger = $('effort-trigger')
  if (!menu || !trigger || menu.hidden) return
  const r = trigger.getBoundingClientRect()
  const gap = 6
  const maxLeft = window.innerWidth - menu.offsetWidth - 8
  menu.style.left = `${Math.max(8, Math.min(r.left, maxLeft))}px`
  menu.style.bottom = `${Math.max(8, window.innerHeight - r.top + gap)}px`
}

function openMenu() {
  const menu = $('effort-menu')
  const trigger = $('effort-trigger')
  if (!menu || !trigger) return
  menu.hidden = false
  trigger.setAttribute('aria-expanded', 'true')
  const items = [...menu.querySelectorAll('[role="option"]')]
  if (items.length === 0) {
    menu.hidden = true
    trigger.setAttribute('aria-expanded', 'false')
    return
  }
  positionMenu()
  const cur = getCurrentEffort() ?? ''
  const target = items.find((el) => el.dataset.effort === cur) ?? items[0]
  for (const it of items) it.setAttribute('tabindex', it === target ? '0' : '-1')
  target.focus()
  attachGlobalListeners()
}

function closeMenu(returnFocus = true) {
  const menu = $('effort-menu')
  const trigger = $('effort-trigger')
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
  const wrap = $('composer-effort')
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
  repositionListener = () => positionMenu()
  document.addEventListener('pointerdown', outsideListener, true)
  document.addEventListener('keydown', keydownListener, true)
  window.addEventListener('resize', repositionListener)
  window.addEventListener('scroll', repositionListener, true)
}

function detachGlobalListeners() {
  if (!globalListenersBound) return
  globalListenersBound = false
  if (outsideListener) document.removeEventListener('pointerdown', outsideListener, true)
  if (keydownListener) document.removeEventListener('keydown', keydownListener, true)
  if (repositionListener) {
    window.removeEventListener('resize', repositionListener)
    window.removeEventListener('scroll', repositionListener, true)
  }
  outsideListener = null
  keydownListener = null
  repositionListener = null
}

/** 重渲选项 + 同步 trigger 标签/选中态。agent/session/model 切换、models 加载后
 *  调用,幂等。不支持思考深度的 model → 整个控件隐藏。 */
export function renderEffortPicker() {
  const wrap = $('composer-effort')
  const trigger = $('effort-trigger')
  const labelEl = $('effort-label')
  const menu = $('effort-menu')
  if (!wrap || !trigger || !labelEl || !menu) return
  const supported = getSupportedEfforts(currentModel())
  if (supported.length === 0) {
    wrap.hidden = true
    if (isMenuOpen()) closeMenu(false)
    return
  }
  wrap.hidden = false
  const cur = getCurrentEffort()
  labelEl.textContent = cur ? `思考深度: ${LABELS[cur] || cur}` : '思考深度'
  menu.replaceChildren()
  const selected = cur ?? ''
  for (const opt of effortOptions()) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'model-menu-item'
    btn.setAttribute('role', 'option')
    btn.dataset.effort = opt.id
    btn.tabIndex = -1
    const sel = opt.id === selected
    btn.setAttribute('aria-selected', sel ? 'true' : 'false')
    btn.classList.toggle('model-menu-item--selected', sel)
    const labelSpan = document.createElement('span')
    labelSpan.className = 'label'
    labelSpan.textContent = opt.label + (opt.isDefault ? ' · 模型默认' : '')
    btn.append(labelSpan)
    menu.appendChild(btn)
  }
}

/** 一次性绑定 trigger/menu 事件。与 modelMode.initModelPicker 同构。 */
export function initEffortPicker() {
  const trigger = $('effort-trigger')
  const menu = $('effort-menu')
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
    setCurrentEffort(btn.dataset.effort)
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
      if (cur?.dataset.effort !== undefined) setCurrentEffort(cur.dataset.effort)
    }
  })
  renderEffortPicker()
}
