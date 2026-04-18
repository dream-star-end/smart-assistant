// OpenClaude — 思考强度 pill(编码模式 / 科研模式),仅 Opus 4.7 显示
//
// pill 状态按 agent 持久化在 localStorage 里(per-agent),page reload 后复原。
// 默认空(unset),让 CCB 用模型默认 effort。
import { $ } from './dom.js'
import { getSession, state } from './state.js'

const STORAGE_KEY = 'openclaude_effort_by_agent'
// 与 protocol/frames.ts InboundMessage.effortLevel 严格一一对应。
// 改动时同步更新两处。
const VALID = new Set(['xhigh', 'max'])

/** 当前 model 是否支持 xhigh/max(目前仅 Opus 4.7,后续 Opus 4.8+ 同样匹配 4-7+ 可在此扩展)。
 *  容忍模型 ID 大小写、preset / 自定义命名(如 anthropic/claude-opus-4-7)。 */
export function modelSupportsExtraEffort(modelId) {
  if (!modelId || typeof modelId !== 'string') return false
  return /opus[-_]?4[-_]?7/i.test(modelId)
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

/** 取当前会话的 agent 当前选中的 effort('xhigh' | 'max' | undefined)。
 *  返回 undefined 表示没选,仅用于 UI(pill 高亮态)。
 *  发 inbound.message 用 getEffortForSubmit(),它会区分"未选" vs "Opus4.7 但取消"。 */
export function getCurrentEffort() {
  const sess = getSession()
  if (!sess) return undefined
  const agentId = sess.agentId || state.defaultAgentId
  if (!agentId) return undefined
  const store = readStore()
  const v = store[agentId]
  return VALID.has(v) ? v : undefined
}

/** 决定 inbound.message.effortLevel 的取值:
 *    - 字符串('xhigh' | 'max'):用户在 Opus 4.7 会话里选了对应 pill
 *    - null:**显式清除** — 当前 agent 是 Opus 4.7 但没选 pill。让 gateway 把
 *           已存在 runner 的 effort env 复位到模型默认(否则一旦升过档就回不去)
 *    - undefined:不传字段 — 当前 agent 不是 Opus 4.7,完全不参与 effort 协商
 *
 *  返回 undefined 时调用方应省略 effortLevel 字段;返回 null/string 时按值发送。 */
export function getEffortForSubmit() {
  if (!modelSupportsExtraEffort(getCurrentAgentModel())) return undefined
  const cur = getCurrentEffort()
  // Opus 4.7 + 未选 pill → 显式 null,让 gateway 重启回模型默认 effort
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

function getCurrentAgentModel() {
  const sess = getSession()
  if (!sess) return ''
  const agentId = sess.agentId || state.defaultAgentId
  const a = (state.agentsList || []).find((x) => x.id === agentId)
  return a?.model || ''
}

/** 根据当前会话 agent 的 model 决定整个 pill 行的可见性,并同步两个 pill 的 aria-pressed 状态。
 *  应在 agent 切换、session 切换、agent list 加载完成后调用。 */
export function renderModePills() {
  const wrap = $('composer-modes')
  if (!wrap) return
  const model = getCurrentAgentModel()
  const visible = modelSupportsExtraEffort(model)
  wrap.hidden = !visible
  if (!visible) return
  const current = getCurrentEffort()
  for (const btn of wrap.querySelectorAll('.mode-pill')) {
    const v = btn.dataset.effort
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
