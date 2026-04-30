// OpenClaude — 思考深度选择器(Opus 4.7 专属)
//
// 过去这里有两个独立 pill(编码模式 / 科研模式),只能开 xhigh 或 max。2026-04-22
// 重构为一个带弹出菜单的选择器,覆盖五档 (low / medium / high / xhigh / max)。
// 当前显示策略与旧版一致:仅 Opus 4.7 agent 展示入口。注意这是 commercial v3
// 的**产品 UI 策略**,不是协议限制 —— 后端/协议 low/medium/high 对所有模型都
// 支持(见 packages/protocol/src/frames.ts:48-57)。
//
// 2026-04-26 v1.0.4 起去掉"默认 / 由模型决定"档位:Opus 4.7 会话默认就是
// 'medium',永远向 gateway 显式发 effortLevel(不再发 null)。理由:产品要给
// 用户稳定可预期的体验,'让模型自决' 在不同模型/不同时段有歧义,新用户难以
// 理解。store 里旧的 ''(empty,代表旧"默认"档)在 getCurrentEffort 中自动
// fallback 到 DEFAULT_EFFORT。
//
// pill 状态按 agent 持久化在 localStorage,page reload 后复原。store 缺失或
// 含非法值 → 视为 DEFAULT_EFFORT。
import { $ } from './dom.js?v=50ec63e'
import { getSession, state } from './state.js?v=50ec63e'

const STORAGE_KEY = 'openclaude_effort_by_agent'

// 与 protocol/frames.ts InboundMessage.effortLevel 严格一一对应。
// 改动时同步更新两处。
const VALID = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

// 默认档位:store 缺失或被清掉时显示的值。v1.0.4 从"由模型决定"改成 medium。
const DEFAULT_EFFORT = 'medium'

// 菜单渲染顺序 + 文案。v1.0.4 移除首项"默认 / 由模型决定" — 永远落到具体档位。
const MENU_OPTIONS = [
  { value: 'low', label: '低', hint: '快速响应' },
  { value: 'medium', label: '中', hint: '均衡(默认)' },
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

/** 取当前会话 agent 当前选中的 effort('low' | 'medium' | 'high' | 'xhigh' | 'max')。
 *  v1.0.4 起:store 缺失 / 旧版 '' / 非法值 全部 fallback 到 DEFAULT_EFFORT('medium'),
 *  不再返回 undefined。session 缺失时(冷启动 race)仍返回 undefined,让调用方跳过 UI。
 *
 *  自愈:store 里如果留有非法值或旧版 '',顺手清掉,下次读直接 fallback。 */
export function getCurrentEffort() {
  const sess = getSession()
  if (!sess) return undefined
  const agentId = sess.agentId || state.defaultAgentId
  if (!agentId) return undefined
  const store = readStore()
  const v = store[agentId]
  if (VALID.has(v)) return v
  // store 缺失 / 旧版 '' / 非法值 — 清理(若有)并 fallback 到默认
  if (v !== undefined) {
    delete store[agentId]
    writeStore(store)
  }
  return DEFAULT_EFFORT
}

/** 决定 inbound.message.effortLevel 的取值:
 *    - 字符串 ∈ VALID:当前 agent 是 Opus 4.7 → 永远发具体档位(默认 medium)
 *    - undefined:不传字段 — 当前 agent 不支持扩展 effort,完全不参与 effort 协商
 *
 *  v1.0.4 起不再返回 null:'让模型自决' 档位被废,Opus 4.7 永远显式带 effort。 */
export function getEffortForSubmit() {
  // v1.0.4 改读"effective model"(state.userPrefs.default_model 优先);否则
  // 切到 Sonnet 但还按 agent.model=Opus 4.7 算,会发出 effortLevel='medium' →
  // 后端虽然能 accept,但产品语义上 Sonnet 不该带这字段。
  if (!modelSupportsExtraEffort(getEffectiveModel())) return undefined
  return getCurrentEffort() ?? DEFAULT_EFFORT
}

/** 设置当前会话 agent 的 effort。
 *  - 传 DEFAULT_EFFORT:delete store entry — 缺失语义就是 medium,免无意义写
 *  - 传其他 VALID 值:写入 store
 *  - 传非法值:静默忽略 */
function setCurrentEffort(level) {
  const sess = getSession()
  if (!sess) return
  const agentId = sess.agentId || state.defaultAgentId
  if (!agentId) return
  if (!VALID.has(level)) return
  const store = readStore()
  if (level === DEFAULT_EFFORT) {
    delete store[agentId]
  } else {
    store[agentId] = level
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

/** 当前生效模型 id:state.userPrefs.default_model 优先,否则 agent.model。
 *  注意 state.userPrefs===null 表示尚未拉取 — 调用方应单独处理(返回空串
 *  让 shouldShowEffortControl 判 false,但 renderModePills 会显式隐藏避免闪烁)。 */
function getEffectiveModel() {
  const pref = state.userPrefs?.default_model
  if (typeof pref === 'string' && pref) return pref
  return getCurrentAgentModel()
}

// ── Menu open/close ────────────────────────────────────────────────
// 模块内状态:当前菜单是否打开。保证只维护一份 listener,避免重复绑定。

let menuEventsBound = false
let outsideClickListener = null
let keydownListener = null
let reflowListener = null

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

/** 基于 trigger 的 viewport 坐标把菜单摆好。
 *
 *  用 position: fixed 是为了逃离 .composer-inner 的 overflow:hidden —— 该父元素
 *  为了让 textarea 尊重圆角裁剪得很严,导致默认 position: absolute 的菜单
 *  (bottom: calc(100% + 6px)) 从上方弹出时整个被切掉。mobile 上 composer 更贴
 *  视口底,裁剪最明显,表现就是"弹不出来"。fixed 定位后内联 top/bottom/left/right
 *  会覆盖 CSS 里的 absolute 坐标。 */
function positionMenu() {
  const trigger = getTrigger()
  const menu = getMenu()
  if (!trigger || !menu) return
  const rect = trigger.getBoundingClientRect()
  menu.style.position = 'fixed'
  // 菜单 bottom 边对齐到 trigger top 上方 6px(用 viewport 坐标)
  menu.style.bottom = `${Math.max(0, window.innerHeight - rect.top + 6)}px`
  // 菜单左对齐 trigger,但不超出视口右缘(min-width 220px,预留 8px 边距)
  const menuMinWidth = 220
  const maxLeft = Math.max(8, window.innerWidth - menuMinWidth - 8)
  menu.style.left = `${Math.min(rect.left, maxLeft)}px`
  menu.style.right = 'auto'
  menu.style.top = 'auto'
}

function openMenu(focusFirst = false) {
  const trigger = getTrigger()
  const menu = getMenu()
  if (!trigger || !menu) return
  positionMenu()
  menu.hidden = false
  trigger.setAttribute('aria-expanded', 'true')
  // roving tabindex:标记选中项(或首项)为可 tab,其余 -1。
  const items = Array.from(menu.querySelectorAll('[role="option"]'))
  if (items.length > 0) {
    const current = getCurrentEffort() ?? DEFAULT_EFFORT
    const target = items.find((el) => el.dataset.effort === current) || items[0]
    for (const it of items) it.setAttribute('tabindex', it === target ? '0' : '-1')
    // 只在键盘触发(focusFirst=true)时主动 .focus(),避免 mobile tap 触发
    // 程序性 focus 引起的滚动跳动 / 虚拟键盘弹出(按钮获取 focus 不会唤键盘,但
    // 有些 mobile 浏览器仍会 scrollIntoView)。鼠标/触摸打开时保持 trigger focus。
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
  // position: fixed 下窗口 resize / scroll / viewport 变化时(移动端虚拟键盘、
  // 浏览器 URL 栏伸缩)要重新计算坐标,否则菜单会偏离 trigger。用 rAF 节流。
  let rafId = 0
  reflowListener = () => {
    if (rafId) return
    rafId = requestAnimationFrame(() => {
      rafId = 0
      if (isMenuOpen()) positionMenu()
    })
  }
  // pointerdown + capture=true:覆盖 mouse / touch / pen 三类指针设备
  // (mousedown 会漏掉部分移动浏览器对触摸的行为)。外部点击时关菜单。
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

// ── Render ─────────────────────────────────────────────────────────

function labelForCurrent() {
  const cur = getCurrentEffort() ?? DEFAULT_EFFORT
  const opt = MENU_OPTIONS.find((o) => o.value === cur)
  const which = opt ? opt.label : '中'
  return `思考深度: ${which}`
}

/** 根据当前会话 agent 的 model 决定 effort-trigger 自身的可见性,并同步 trigger
 *  label / pressed 态 / menu option 的 aria-selected / 选中项样式。
 *  (roving tabindex 由 openMenu() 按焦点接管,这里不动 tabindex。)
 *  应在 agent 切换、session 切换、agent list 加载完成后调用。
 *
 *  v1.0.4 起:此函数只控制 effort-trigger + effort-menu 自身,不再 hide
 *  整个 composer-modes 容器(那由 modelPicker.renderModelPill 控制)。
 *  切到不展示控件的 agent 时强制关闭菜单,避免"pop-open 后切 agent 留幽灵弹出"。 */
export function renderModePills() {
  const trigger = getTrigger()
  const menu = getMenu()
  if (!trigger || !menu) return
  // v1.0.4 — prefs 还没拉取(冷启动/登录 race)时统一隐藏,避免"先按 agent
  // 默认显 Opus → loadUserPrefs 完后切 Sonnet 又消失"的闪烁。
  if (state.userPrefs === null) {
    trigger.hidden = true
    menu.hidden = true
    if (isMenuOpen()) closeMenu(false)
    return
  }
  const model = getEffectiveModel()
  const visible = shouldShowEffortControl(model)
  // 只 hide trigger + menu,不动 composer-modes wrap
  trigger.hidden = !visible
  if (!visible) {
    menu.hidden = true
    if (isMenuOpen()) closeMenu(false)
    return
  }

  const current = getCurrentEffort() ?? DEFAULT_EFFORT
  // trigger:仅非默认档位(medium)pressed
  trigger.setAttribute('aria-pressed', current !== DEFAULT_EFFORT ? 'true' : 'false')
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
    setCurrentEffort(btn.dataset.effort)
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
        setCurrentEffort(btn.dataset.effort)
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
