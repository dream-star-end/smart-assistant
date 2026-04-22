// OpenClaude — 思考深度选择器(Opus 4.7 专属)
//
// 过去这里有两个独立 pill(编码模式 / 科研模式),只能开 xhigh 或 max。2026-04-22
// 重构为一个带弹出菜单的选择器,覆盖五档 (low / medium / high / xhigh / max)
// + "默认"。当前显示策略与旧版一致:仅 Opus 4.7 agent 展示入口。注意这是
// commercial v3 的**产品 UI 策略**,不是协议限制 —— 后端/协议 low/medium/high
// 对所有模型都支持(见 packages/protocol/src/frames.ts:48-57)。
//
// pill 状态按 agent 持久化在 localStorage,page reload 后复原。默认空(unset),
// 让 CCB 用模型默认 effort。
import { $ } from './dom.js'
import { getSession, state } from './state.js'

const STORAGE_KEY = 'openclaude_effort_by_agent'

// 与 protocol/frames.ts InboundMessage.effortLevel 严格一一对应。
// 改动时同步更新两处。
const VALID = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

// 菜单渲染顺序 + 文案(key='' 代表"默认",value=null → getEffortForSubmit → 显式清除)。
// 顺序按思考强度递增,"默认"置顶。
const MENU_OPTIONS = [
  { value: '', label: '默认', hint: '由模型决定' },
  { value: 'low', label: '低', hint: '快速响应' },
  { value: 'medium', label: '中', hint: '均衡' },
  { value: 'high', label: '高', hint: '更彻底' },
  { value: 'xhigh', label: '更高', hint: '长链路 / 复杂编码' },
  { value: 'max', label: '最高', hint: '深度推理(token 消耗显著上升)' },
]

/** 协议能力:当前 model 是否支持 xhigh/max(仅 Opus 4.7)。
 *  容忍模型 ID 大小写、preset / 自定义命名(如 anthropic/claude-opus-4-7)。 */
export function modelSupportsExtraEffort(modelId) {
  if (!modelId || typeof modelId !== 'string') return false
  return /opus[-_]?4[-_]?7/i.test(modelId)
}

/** commercial v3 产品策略:当前 agent 是否应显示"思考深度"选择器。
 *  与 modelSupportsExtraEffort 区分,后者是协议能力。现阶段二者等价(Opus 4.7),
 *  若未来产品决定对其他模型也开放入口,改这一处即可,不动协议判断。 */
function shouldShowEffortControl(modelId) {
  return modelSupportsExtraEffort(modelId)
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

/** 取当前会话的 agent 当前选中的 effort('low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined)。
 *  返回 undefined 表示没选(默认档),仅用于 UI 渲染。
 *  发 inbound.message 用 getEffortForSubmit(),它会区分"未选" vs "Opus4.7 但取消"。
 *
 *  自愈:store 里如果留有非法值(比如老版本遗留),视为未选并顺手清掉。 */
export function getCurrentEffort() {
  const sess = getSession()
  if (!sess) return undefined
  const agentId = sess.agentId || state.defaultAgentId
  if (!agentId) return undefined
  const store = readStore()
  const v = store[agentId]
  if (v === undefined || v === null) return undefined
  if (VALID.has(v)) return v
  // 非法值 — 清理并返回 undefined
  delete store[agentId]
  writeStore(store)
  return undefined
}

/** 决定 inbound.message.effortLevel 的取值:
 *    - 字符串 ∈ VALID:用户在 Opus 4.7 会话里选了对应档位
 *    - null:**显式清除** — 当前 agent 是 Opus 4.7 但没选具体档位。让 gateway 把
 *           已存在 runner 的 effort env 复位到模型默认(否则一旦升过档就回不去)
 *    - undefined:不传字段 — 当前 agent 不支持扩展 effort,完全不参与 effort 协商
 *
 *  返回 undefined 时调用方应省略 effortLevel 字段;返回 null/string 时按值发送。 */
export function getEffortForSubmit() {
  if (!modelSupportsExtraEffort(getCurrentAgentModel())) return undefined
  const cur = getCurrentEffort()
  // Opus 4.7 + 未选档位 → 显式 null,让 gateway 重启回模型默认 effort
  return cur === undefined ? null : cur
}

/** 设置当前会话 agent 的 effort。传 undefined / '' / null 取消选中(回"默认")。 */
function setCurrentEffort(level) {
  const sess = getSession()
  if (!sess) return
  const agentId = sess.agentId || state.defaultAgentId
  if (!agentId) return
  const store = readStore()
  if (level === undefined || level === null || level === '') {
    delete store[agentId]
  } else if (VALID.has(level)) {
    store[agentId] = level
  } else {
    return
  }
  writeStore(store)
  renderModePills()
}

function getCurrentAgentModel() {
  const sess = getSession()
  if (!sess) return ''
  const agentId = sess.agentId || state.defaultAgentId
  const a = (state.agentsList || []).find((x) => x.id === agentId)
  return a?.model || ''
}

// ── Menu open/close ────────────────────────────────────────────────
// 模块内状态:当前菜单是否打开。保证只维护一份 listener,避免重复绑定。

let menuEventsBound = false
let outsideClickListener = null
let keydownListener = null

function getTrigger() {
  return $('effort-trigger')
}
function getMenu() {
  return $('effort-menu')
}

function isMenuOpen() {
  const m = getMenu()
  return !!m && !m.hidden
}

function openMenu(focusFirst = false) {
  const trigger = getTrigger()
  const menu = getMenu()
  if (!trigger || !menu) return
  menu.hidden = false
  trigger.setAttribute('aria-expanded', 'true')
  // 聚焦:优先选中项,否则第一项 / 最后一项
  const items = Array.from(menu.querySelectorAll('[role="option"]'))
  if (items.length === 0) return
  const current = getCurrentEffort() ?? ''
  let target = items.find((el) => el.dataset.effort === current)
  if (!target) target = focusFirst ? items[0] : items[0]
  // roving tabindex
  for (const it of items) it.setAttribute('tabindex', it === target ? '0' : '-1')
  target.focus()
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

function attachGlobalListeners() {
  if (outsideClickListener) return
  outsideClickListener = (ev) => {
    const wrap = $('composer-modes')
    if (!wrap) return
    if (!wrap.contains(ev.target)) closeMenu(false)
  }
  keydownListener = (ev) => {
    if (!isMenuOpen()) return
    if (ev.key === 'Escape') {
      ev.preventDefault()
      closeMenu(true)
    } else if (ev.key === 'Tab') {
      // Tab 离开菜单时直接关闭,让焦点自然流向下个可聚焦元素
      closeMenu(false)
    }
  }
  // pointerdown + capture=true:覆盖 mouse / touch / pen 三类指针设备
  // (mousedown 会漏掉部分移动浏览器对触摸的行为)。外部点击时关菜单。
  document.addEventListener('pointerdown', outsideClickListener, true)
  document.addEventListener('keydown', keydownListener, true)
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
}

// ── Render ─────────────────────────────────────────────────────────

function labelForCurrent() {
  const cur = getCurrentEffort()
  const opt = MENU_OPTIONS.find((o) => o.value === (cur ?? ''))
  const which = opt ? opt.label : '默认'
  return `思考深度: ${which}`
}

/** 根据当前会话 agent 的 model 决定整个选择器的可见性,并同步 trigger label /
 *  pressed 态 / menu option 的 aria-selected / 选中项样式。
 *  (roving tabindex 由 openMenu() 按焦点接管,这里不动 tabindex。)
 *  应在 agent 切换、session 切换、agent list 加载完成后调用。
 *
 *  切到不展示控件的 agent 时强制关闭菜单,避免"pop-open 后切 agent 留幽灵弹出"。 */
export function renderModePills() {
  const wrap = $('composer-modes')
  if (!wrap) return
  const model = getCurrentAgentModel()
  const visible = shouldShowEffortControl(model)
  wrap.hidden = !visible
  if (!visible) {
    // 隐藏时也要把菜单显式收起,避免切 agent 后菜单残留可见
    if (isMenuOpen()) closeMenu(false)
    return
  }
  const trigger = getTrigger()
  const menu = getMenu()
  if (!trigger || !menu) return

  const current = getCurrentEffort() ?? ''
  // trigger:仅非默认档位 pressed
  trigger.setAttribute('aria-pressed', current !== '' ? 'true' : 'false')
  const labelEl = $('effort-label')
  if (labelEl) labelEl.textContent = labelForCurrent()

  // 懒渲染菜单选项(幂等:重复调不会重复 append)
  if (menu.childElementCount === 0) {
    const frag = document.createDocumentFragment()
    for (const opt of MENU_OPTIONS) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'effort-menu-item'
      btn.setAttribute('role', 'option')
      btn.dataset.effort = opt.value
      btn.tabIndex = -1
      btn.innerHTML =
        `<span class="effort-menu-label">${opt.label}</span>` +
        `<span class="effort-menu-hint">${opt.hint}</span>`
      frag.appendChild(btn)
    }
    menu.appendChild(frag)
  }
  // 同步 aria-selected + roving tabindex
  const items = menu.querySelectorAll('[role="option"]')
  for (const it of items) {
    const sel = it.dataset.effort === current
    it.setAttribute('aria-selected', sel ? 'true' : 'false')
    it.classList.toggle('effort-menu-item--selected', sel)
  }
}

// ── Bind ───────────────────────────────────────────────────────────

/** 一次性绑定 trigger 点击 + 菜单键盘导航。 */
export function initModePills() {
  if (menuEventsBound) return
  const wrap = $('composer-modes')
  if (!wrap) return
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
    const v = btn.dataset.effort
    setCurrentEffort(v || undefined)
    closeMenu(true)
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
        const v = btn.dataset.effort
        setCurrentEffort(v || undefined)
        closeMenu(true)
      }
    }
  })
  menuEventsBound = true
  renderModePills()
}

/**
 * 2026-04-21 安全审计 HIGH#F3:logout 时清**所有** agent 的 effort 缓存。
 *
 * 此前 STORAGE_KEY 不带 user scope,同浏览器切换账号会把 A 用户设过的档位
 * 继承给 B 用户,哪怕 B 根本没资格(积分不够 / Opus 4.7 未订阅)。服务端会
 * 用 credits 拦住,但前端按钮视觉上已经 pressed 态,造成混淆。logout 时直接
 * 清空是最简洁的修复 —— 新用户一切从零开始。
 *
 * 在 auth.js 的 logout / doLogout 里调用。
 */
export function clearEffortOnLogout() {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* */
  }
}
