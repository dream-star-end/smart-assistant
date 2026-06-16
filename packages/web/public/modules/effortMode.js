// OpenClaude — 思考深度 pill
//
// pill 状态按 agent 持久化在 localStorage 里(per-agent),page reload 后复原。
// 默认空(unset),让 claude 用模型默认 effort。
// 可见性 / 可调档位**能力驱动**:取当前生效 model(含模型选择器的 per-session 覆盖)
// 在 config.models 里声明的 `efforts`。
import { $ } from './dom.js'
import { getEffectiveModel } from './modelMode.js'
import { getSession, state } from './state.js'

const STORAGE_KEY = 'openclaude_effort_by_agent'
// 与 protocol/frames.ts InboundMessage.effortLevel + config.ts EFFORT_LEVELS 一致。
const VALID = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

/** 返回该 model 在 UI 中可调的思考深度档,**能力驱动**:查 state.modelsList
 *  (来自 /api/agents 的 config.models / 默认 seed)里该 model 的 `efforts`。
 *  空/缺省 = 该 model 不暴露思考深度控件。新增模型只改 config,不动前端代码。 */
function getSupportedEfforts(modelId) {
  if (!modelId || typeof modelId !== 'string') return []
  const list = Array.isArray(state.modelsList) ? state.modelsList : []
  const m = list.find((x) => x && x.id === modelId)
  return Array.isArray(m?.efforts) ? m.efforts.filter((e) => VALID.has(e)) : []
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

/** 取当前会话的 agent 当前选中的 effort('low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined)。
 *  返回 undefined 表示没选,仅用于 UI(pill 高亮态)。
 *  发 inbound.message 用 getEffortForSubmit(),它会区分"未选" vs "支持 effort 但取消"。 */
export function getCurrentEffort() {
  const sess = getSession()
  if (!sess) return undefined
  const agentId = sess.agentId || state.defaultAgentId
  if (!agentId) return undefined
  const store = readStore()
  const v = store[agentId]
  const supported = getSupportedEfforts(getCurrentAgentModel())
  return VALID.has(v) && supported.includes(v) ? v : undefined
}

/** 决定 inbound.message.effortLevel 的取值:
 *    - 字符串:用户在支持 effort 的会话里选了对应 pill
 *    - null:**显式清除** — 当前 agent 支持 effort 但没选 pill。让 gateway 把
 *           已存在 runner 的 effort env 复位到模型默认(否则一旦升过档就回不去)
 *    - undefined:不传字段 — 当前 agent 不支持前端 effort,完全不参与 effort 协商
 *
 *  返回 undefined 时调用方应省略 effortLevel 字段;返回 null/string 时按值发送。 */
export function getEffortForSubmit() {
  if (!modelSupportsExtraEffort(getCurrentAgentModel())) return undefined
  const cur = getCurrentEffort()
  // 支持 effort + 未选 pill → 显式 null,让 gateway 重启回模型默认 effort
  return cur === undefined ? null : cur
}

/** 设置当前会话 agent 的 effort。传 undefined 取消选中。 */
function setCurrentEffort(level) {
  const sess = getSession()
  if (!sess) return
  const agentId = sess.agentId || state.defaultAgentId
  if (!agentId) return
  const store = readStore()
  if (level === undefined || level === null) {
    delete store[agentId]
  } else if (VALID.has(level)) {
    store[agentId] = level
  } else {
    return
  }
  writeStore(store)
  renderModePills()
}

/** 当前生效 model = 模型选择器的 per-session 覆盖 ?? agent 默认。 */
function getCurrentAgentModel() {
  return getEffectiveModel()
}

/** 根据当前生效 model 决定整个 pill 行的可见性,并同步 pill 的可见性/aria-pressed 状态。
 *  应在 agent 切换、session 切换、model 切换、agent list 加载完成后调用。 */
export function renderModePills() {
  const wrap = $('composer-modes')
  if (!wrap) return
  const model = getCurrentAgentModel()
  const supported = getSupportedEfforts(model)
  const visible = supported.length > 0
  wrap.hidden = !visible
  if (!visible) return
  wrap.setAttribute('aria-label', '思考深度')
  const current = getCurrentEffort()
  for (const btn of wrap.querySelectorAll('.mode-pill')) {
    const v = btn.dataset.effort
    btn.hidden = !supported.includes(v)
    btn.setAttribute('aria-pressed', v === current ? 'true' : 'false')
  }
}

/** 一次性绑定 pill 的点击事件(切换:再次点击同一个 pill 取消)。 */
export function initModePills() {
  const wrap = $('composer-modes')
  if (!wrap) return
  wrap.addEventListener('click', (e) => {
    const btn = e.target.closest('.mode-pill')
    if (!btn || !wrap.contains(btn)) return
    const v = btn.dataset.effort
    if (!VALID.has(v)) return
    const current = getCurrentEffort()
    setCurrentEffort(current === v ? undefined : v)
  })
  renderModePills()
}
