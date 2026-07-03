// OpenClaude — 思考深度选择器
//
// 历史:
//  - 2026-04-22 重构为一个带弹出菜单的选择器,覆盖 Opus 4.7 五档
//    (low / medium / high / xhigh / max)。
//  - 2026-04-26 v1.0.4 去掉"默认 / 由模型决定"档位 — 显示控件的会话永远显式
//    向 gateway 发具体档位。
//  - 2026-05-11 加 DeepSeek V4 接入 — 同一选择器覆盖 deepseek-v4-flash/pro 两档
//    (high / max)。后端口径见 api-docs.deepseek.com/guides/anthropic_api:
//    `output_config.effort` 支持 high/max;low/medium 自动映射 high,xhigh 映射 max。
//    我们前端不暴露 deepseek 的 xhigh/low/medium,避免给用户"伪选项"。
//  - 2026-05-25 v1.0.200 加 gpt-5.5 (codex provider) 接入 — 覆盖 low/medium/high/xhigh
//    四档。后端透传到 codex CLI 的 `-c model_reasoning_effort=...`(实测合法值
//    none/minimal/low/medium/high/xhigh)。`max` 在后端 helper
//    `codexReasoningEffortConfig` 显式映射 xhigh,前端不暴露 max(同 DeepSeek 模式,
//    避免给用户"伪选项")。
//  - 2026-06-17 加 火山方舟 glm-5.1/glm-5.2(智谱)接入 — 同 DeepSeek 暴露 high/max
//    两档(默认 max)。后端权威白名单 = protocol staticKeyProviders ark
//    `allowedOutputConfigEfforts=['high','max']`,master proxy 据此清洗 output_config.effort
//    透传火山(low/medium/minimal/xhigh 等会被兜底剥成"无 effort"=火山默认思考)。
//
// 协议契约:
//  - 后端 `InboundMessage.effortLevel`(`packages/protocol/src/frames.ts:48-57`)
//    接受 low/medium/high/xhigh/max 五档。改动时同步更新两处。
//  - 哪个模型支持哪些档位是**前端产品决策**,通过 `getEffortOptionsForModel`
//    集中维护;`modelSupportsExtraEffort` 是"是否展示选择器"的 UI 开关。
//
// 持久化契约(agent-scoped,Codex 2026-05-11 复核确认):
//  - localStorage `STORAGE_KEY` 按 agentId 存,**不区分 model**。
//  - 相同合法值跨模型共享(例如 Opus 选 high 切到 DeepSeek 仍是 high);
//  - 非法值(例如 Opus 选 low 切到 DeepSeek)只在 UI/submit 层兜底
//    (`getLegalCurrentEffort`),不清 store,切回原模型恢复;
//  - 只有用户在菜单显式点选时(`setCurrentEffort`)才按当前 agent 的
//    "模型默认值"决定写入还是删除 store entry。
//  - 这条契约不支持"严格 model-scoped 独立记忆":Opus 选 low → 切 DeepSeek
//    点高(=deepseek default)→ 切回 Opus,Opus 退回 medium。接受。第三个支持
//    effort 的模型接入时建议升级到模型元数据 / model-scoped store。

import { $ } from './dom.js?v=8bf22747'
import { getEffectiveSingleAgentModel } from './modelPolicy.js?v=8bf22747'
import { getSession, state } from './state.js?v=8bf22747'

const STORAGE_KEY = 'openclaude_effort_by_agent'

// 协议合法 effort 全集。`setCurrentEffort` 用这个挡住非法输入(防止注入)。
// 与 protocol/frames.ts InboundMessage.effortLevel 严格一一对应。
const VALID = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

// ── 模型 → 档位映射 ─────────────────────────────────────────────────

function isOpus47Model(modelId) {
  return /opus[-_]?4[-_]?7/i.test(modelId || '')
}
function isDeepseekModel(modelId) {
  // exact-match flash/pro(与 commercial v3 anthropicProxy ALLOWED_INBOUND_MODELS 一致),
  // 不放过未来未声明的 deepseek 变体。
  return /^deepseek-v4-(flash|pro)$/i.test(modelId || '')
}
function isCodexModel(modelId) {
  // exact-match `gpt-5.5`(与 server.ts ALLOWED_INBOUND_MODELS 一致)。
  // 后续若有 gpt-5.5-codex 等 alias 接入,改这里集中扩展。
  return /^gpt-5\.5$/i.test(modelId || '')
}
function isGlmModel(modelId) {
  // exact-match glm-5.1/glm-5.2(与 protocol staticKeyProviders ark matchesRoute 一致,
  // 大小写不敏感)。火山方舟 glm 思考深度同 DeepSeek 暴露 high/max 两档(boss 2026-06-17)。
  return /^glm-5\.[12]$/i.test(modelId || '')
}

const OPUS_47_OPTIONS = [
  { value: 'low', label: '低', hint: '快速响应' },
  { value: 'medium', label: '中', hint: '均衡' },
  { value: 'high', label: '高', hint: '更彻底' },
  { value: 'xhigh', label: '更高', hint: '长链路 / 复杂编码' },
  { value: 'max', label: '最高', hint: '深度推理(默认,token 消耗显著上升)' },
]

// DeepSeek 真实只有 high / max 两档(其他档位自动映射,见上方注释)。
// 2026-06-16 起默认 max(boss:可调思考默认拉满)。
const DEEPSEEK_OPTIONS = [
  { value: 'high', label: '高', hint: '标准推理' },
  { value: 'max', label: '最高', hint: '深度推理(默认)' },
]

// gpt-5.5 (codex) 暴露四档,与 codex CLI 接受值集合的子集对齐
// (none/minimal 不暴露 — 用户角度"低"已是最低有意义档位)。
// `max` 不暴露:后端 helper 会把任意上游 max payload 映射 xhigh,但前端避免
// "伪选项",同 DeepSeek 模式。默认 medium(对齐 codex CLI 自身默认)。
const CODEX_OPTIONS = [
  { value: 'low', label: '低', hint: '快速响应' },
  { value: 'medium', label: '中', hint: '均衡(默认)' },
  { value: 'high', label: '高', hint: '更彻底' },
  { value: 'xhigh', label: '更高', hint: '深度推理(token 消耗显著上升)' },
]

// 火山方舟 glm-5.1/glm-5.2 思考深度:产品暴露 高/最高 两档(boss 2026-06-17)。
// 后端权威白名单 = protocol staticKeyProviders ark `allowedOutputConfigEfforts=['high','max']`,
// master proxy 据此清洗 output_config.effort 透传火山;其他档位兜底剥成无 effort。默认 max。
const GLM_OPTIONS = [
  { value: 'high', label: '高', hint: '标准推理' },
  { value: 'max', label: '最高', hint: '深度推理(默认)' },
]

/** 返回该 model 在菜单里要展示的档位列表(顺序就是渲染顺序)。
 *  不支持思考深度选择的 model 返回空数组(由 `shouldShowEffortControl` 隐藏控件)。 */
function getEffortOptionsForModel(modelId) {
  if (isDeepseekModel(modelId)) return DEEPSEEK_OPTIONS
  if (isCodexModel(modelId)) return CODEX_OPTIONS
  if (isGlmModel(modelId)) return GLM_OPTIONS
  if (isOpus47Model(modelId)) return OPUS_47_OPTIONS
  return []
}

/** 该 model 在该会话冷启动 / store 缺失时的默认档位。
 *  2026-06-16 boss 决策:可调思考等级的模型默认拉满(最高),gpt-5.5(codex) 例外用中等。
 *  注意 getEffortForSubmit 永远显式带 effort(缺省即取本默认),故改这里即真正改变下发档位。 */
function getDefaultEffortForModel(modelId) {
  if (isDeepseekModel(modelId)) return 'max'
  if (isCodexModel(modelId)) return 'medium' // gpt-5.5:boss 指定默认中等
  if (isGlmModel(modelId)) return 'max' // 火山 glm:默认最高(显式,不依赖下方 fallback)
  return 'max' // Opus 4.7 等可调思考模型:默认最高
}

function getAllowedEffortsForModel(modelId) {
  return new Set(getEffortOptionsForModel(modelId).map((o) => o.value))
}

/** 协议能力:当前 model 是否支持额外的思考深度档位(即应展示选择器)。
 *  容忍模型 ID 大小写、preset / 自定义命名(如 anthropic/claude-opus-4-7)。 */
export function modelSupportsExtraEffort(modelId) {
  if (!modelId || typeof modelId !== 'string') return false
  return (
    isOpus47Model(modelId) ||
    isDeepseekModel(modelId) ||
    isCodexModel(modelId) ||
    isGlmModel(modelId)
  )
}

/** commercial v3 产品策略:当前 agent 是否应显示"思考深度"选择器。
 *  现阶段与 `modelSupportsExtraEffort` 等价 — 若未来产品决定对支持 effort 的
 *  模型暂不展示入口,改这一处即可,不动协议判断。 */
function shouldShowEffortControl(modelId) {
  return modelSupportsExtraEffort(modelId)
}

// ── localStorage IO ────────────────────────────────────────────────

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

// ── current effort 读写 ────────────────────────────────────────────

/** 取当前会话 agent 在 store 里写过的 effort(可能是任何协议合法值)。
 *  session 缺失(冷启动 race)返回 undefined,让调用方跳过 UI。
 *  store 缺失 / 旧版 '' / 非法值 → 用 `getDefaultEffortForModel(effectiveModel)`
 *  作 fallback,**不写 store**(避免把临时 fallback 物化成显式偏好)。
 *
 *  自愈:store 里如果留有协议非法值或旧版 '',顺手清掉,下次读直接 fallback。
 *  注:这只清协议非法值;对"协议合法但当前 model 不支持"的值(如 Opus 'low'
 *  切到 DeepSeek)不清,跨模型保留语义见顶部契约说明。 */
export function getEffortOwnerAgentId() {
  if (state.selectedTeamId) {
    const team = (state.agentTeams || []).find((t) => t.id === state.selectedTeamId)
    return team?.leaderAgentId || ''
  }
  const sess = getSession()
  return sess?.agentId || state.defaultAgentId || ''
}

function getSelectedTeamLeaderModel() {
  if (!state.selectedTeamId) return ''
  const team = (state.agentTeams || []).find((t) => t.id === state.selectedTeamId)
  if (!team?.leaderAgentId) return ''
  const leader = (state.agentsList || []).find((a) => a.id === team.leaderAgentId)
  return leader?.model || ''
}

function isTeamModeActive() {
  return Boolean(state.selectedTeamId)
}

function getCurrentEffort() {
  const agentId = getEffortOwnerAgentId()
  if (!agentId) return undefined
  const store = readStore()
  const v = store[agentId]
  if (VALID.has(v)) return v
  if (v !== undefined) {
    delete store[agentId]
    writeStore(store)
  }
  return getDefaultEffortForModel(getEffectiveModel())
}

/** 取"当前 effective model 下合法化"后的 effort。
 *  store 里的值如果是当前 model 不支持的档位(如 Opus 选 low 切到 DeepSeek),
 *  返回该 model 的默认值。submit / UI 显示统一走这个,确保我们永远不发非法值。 */
function getLegalCurrentEffort() {
  const model = getEffectiveModel()
  const cur = getCurrentEffort()
  const allowed = getAllowedEffortsForModel(model)
  if (cur && allowed.has(cur)) return cur
  return getDefaultEffortForModel(model)
}

/** 决定 `inbound.message.effortLevel` 的取值:
 *    - 字符串 ∈ 当前 model 合法档位:发出
 *    - undefined:不传字段 — 当前 model 不支持选择器,完全不参与 effort 协商
 *
 *  v1.0.4 起不再返回 null:'让模型自决' 档位被废,支持选择器的 model 永远显式带 effort。 */
export function getEffortForSubmit() {
  const model = getEffectiveModel()
  if (!modelSupportsExtraEffort(model)) return undefined
  return getLegalCurrentEffort()
}

/** 设置当前会话 agent 的 effort。
 *  - 协议非法值:静默忽略
 *  - 等于当前 effective model 的默认值:delete store entry(缺失语义就是该默认值)
 *  - 其他合法值:写入 store
 *
 *  注意:这里用 effective model 的默认值判定 delete,而不是固定 'medium'。
 *  所以 DeepSeek 用户选"高"会 delete entry,Opus 用户选"中"也会 delete entry。 */
function setCurrentEffort(level) {
  const agentId = getEffortOwnerAgentId()
  if (!agentId) return
  if (!VALID.has(level)) return
  const modelDefault = getDefaultEffortForModel(getEffectiveModel())
  const store = readStore()
  if (level === modelDefault) {
    delete store[agentId]
  } else {
    store[agentId] = level
  }
  writeStore(store)
  renderModePills()
}

function getCurrentAgentId() {
  const sess = getSession()
  return sess?.agentId || state.defaultAgentId || ''
}

/** 当前生效模型 id:兼容当前 agent 的 `default_model` 优先,否则 agent.model。
 *  注意 `state.userPrefs===null` 表示尚未拉取 — 调用方应单独处理(返回空串
 *  让 `shouldShowEffortControl` 判 false,但 `renderModePills` 会显式隐藏避免闪烁)。 */
function getEffectiveModel() {
  if (isTeamModeActive()) return getSelectedTeamLeaderModel()
  return getEffectiveSingleAgentModel({
    userPrefs: state.userPrefs,
    agentId: getCurrentAgentId(),
    defaultAgentId: state.defaultAgentId,
    agentsList: state.agentsList,
  })
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

// Keep the fixed-position popup out of .composer-inner. The refreshed glass
// composer uses overflow/backdrop filters, which can make fixed descendants
// behave like they are clipped by the composer instead of the viewport.
function ensureMenuPortal(menu) {
  if (!menu || !document.body || menu.parentElement === document.body) return
  menu.dataset.composerMenuPortal = 'true'
  document.body.appendChild(menu)
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

const POPUP_SOURCE = 'effort'

function openMenu(focusFirst = false) {
  const trigger = getTrigger()
  const menu = getMenu()
  if (!trigger || !menu) return
  // 通知 composer 同栏其他 popup(modelPicker)先关闭,避免双开重叠
  document.dispatchEvent(
    new CustomEvent('composer-popup-opening', { detail: { source: POPUP_SOURCE } }),
  )
  ensureMenuPortal(menu)
  positionMenu()
  menu.hidden = false
  trigger.setAttribute('aria-expanded', 'true')
  // roving tabindex:标记当前合法化后的选中项(或首项)为可 tab,其余 -1。
  const items = Array.from(menu.querySelectorAll('[role="option"]'))
  if (items.length > 0) {
    const current = getLegalCurrentEffort()
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
  const model = getEffectiveModel()
  const cur = getLegalCurrentEffort()
  const opt = getEffortOptionsForModel(model).find((o) => o.value === cur)
  const prefix = isTeamModeActive() ? '队长思考深度' : '思考深度'
  return `${prefix}: ${opt?.label || '高'}`
}

/** 模块级:上次渲染菜单 DOM 时用的 options 集合 key。
 *  Opus 5 档 / Codex 4 档 / DeepSeek 2 档 / GLM 2 档之间切换时必须重建 DOM,不能复用旧 DOM。
 *  2026-06-17:GLM 与 DeepSeek 的 values 都是 "high,max"(撞车),故 key **纳入 label+hint**
 *  (根治原注释预警的"values 相同但文案不同→stale DOM"风险):文案全同则复用 DOM(无害),
 *  任一档 label/hint 不同则重建。 */
let _lastRenderedOptionsKey = ''
function _optionsKey(model) {
  return getEffortOptionsForModel(model)
    .map((o) => `${o.value}:${o.label}:${o.hint}`)
    .join(',')
}

/** 根据当前会话 agent 的 model 决定 effort-trigger 自身的可见性,并同步 trigger
 *  label / pressed 态 / menu option 的 aria-selected / 选中项样式。
 *  (roving tabindex 由 openMenu() 按焦点接管,这里不动 tabindex。)
 *  应在 agent 切换、session 切换、agent list 加载完成后调用。
 *
 *  v1.0.4 起:此函数只控制 effort-trigger + effort-menu 自身,不再 hide
 *  整个 composer-modes 容器(那由 modelPicker.renderModelPill 控制)。
 *  切到不展示控件的 agent 时强制关闭菜单,避免"pop-open 后切 agent 留幽灵弹出"。
 *
 *  2026-05-11 起:菜单 DOM 按 options key 重建,跨支持 effort 的 model 切换
 *  (Opus 4.7 ↔ DeepSeek)时不复用旧 DOM。 */
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
    trigger.removeAttribute('title')
    trigger.removeAttribute('aria-label')
    if (isMenuOpen()) closeMenu(false)
    return
  }

  const teamMode = isTeamModeActive()
  const title = teamMode
    ? '选择队长思考深度。仅影响本次团队运行的队长模型,不会改变成员 agent 的模型或思考深度。'
    : '选择思考深度。可选档位与默认值随当前模型变化。'
  trigger.title = title
  trigger.setAttribute('aria-label', title)

  const current = getLegalCurrentEffort()
  const modelDefault = getDefaultEffortForModel(model)
  // trigger:仅非该 model 默认档位时 pressed
  trigger.setAttribute('aria-pressed', current !== modelDefault ? 'true' : 'false')
  const labelEl = $('effort-label')
  if (labelEl) labelEl.textContent = labelForCurrent()

  // 按模型重建菜单 DOM(首次渲染或 options 集合变化时)
  const key = _optionsKey(model)
  if (menu.childElementCount === 0 || _lastRenderedOptionsKey !== key) {
    menu.replaceChildren()
    const frag = document.createDocumentFragment()
    for (const opt of getEffortOptionsForModel(model)) {
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
    _lastRenderedOptionsKey = key
  }
  // 同步 aria-selected + 选中项样式
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
  // 同栏其他 popup 打开时,关闭本菜单(B4 dual menu 修复)
  document.addEventListener('composer-popup-opening', (e) => {
    if (e.detail?.source !== POPUP_SOURCE && isMenuOpen()) closeMenu(false)
  })
  document.addEventListener('agent-team-selection-changed', () => {
    renderModePills()
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
