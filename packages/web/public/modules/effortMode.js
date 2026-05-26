// OpenClaude — 思考强度 pill(编码模式 / 科研模式 / GPT reasoning depth)
//
// pill 状态按 agent 持久化在 localStorage 里(per-agent),page reload 后复原。
// 默认空(unset),让 CCB 用模型默认 effort。
import { $ } from './dom.js'
import { getSession, state } from './state.js'

const STORAGE_KEY = 'openclaude_effort_by_agent'
// 与 protocol/frames.ts InboundMessage.effortLevel 严格一一对应。
// 改动时同步更新两处。
const VALID = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
const OPUS_EXTRA_EFFORTS = ['xhigh', 'max']
const GPT55_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh']

/** 返回当前 model 在 UI 中可调的 effort 列表。
 *  - Opus 4.7: 保持原有"编码模式/科研模式"语义(xhigh/max)
 *  - GPT-5.5: Codex reasoning depth(low/medium/high/xhigh)
 *  容忍模型 ID 大小写、preset / 自定义命名(如 anthropic/claude-opus-4-7、openai/gpt-5.5)。 */
function getSupportedEfforts(modelId) {
  if (!modelId || typeof modelId !== 'string') return []
  if (/opus[-_]?4[-_]?7/i.test(modelId)) return OPUS_EXTRA_EFFORTS
  if (/(^|[/_-])gpt[-_]?5\.5($|[/_-])/i.test(modelId)) return GPT55_REASONING_EFFORTS
  return []
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

function getCurrentAgentModel() {
  const sess = getSession()
  if (!sess) return ''
  const agentId = sess.agentId || state.defaultAgentId
  const a = (state.agentsList || []).find((x) => x.id === agentId)
  return a?.model || ''
}

/** 根据当前会话 agent 的 model 决定整个 pill 行的可见性,并同步 pill 的可见性/aria-pressed 状态。
 *  应在 agent 切换、session 切换、agent list 加载完成后调用。 */
export function renderModePills() {
  const wrap = $('composer-modes')
  if (!wrap) return
  const model = getCurrentAgentModel()
  const supported = getSupportedEfforts(model)
  const visible = supported.length > 0
  wrap.hidden = !visible
  if (!visible) return
  wrap.setAttribute(
    'aria-label',
    /gpt[-_]?5\.5/i.test(model) ? '思考深度 (GPT-5.5)' : '思考强度模式 (Opus 4.7)',
  )
  const current = getCurrentEffort()
  const isGpt55 = /gpt[-_]?5\.5/i.test(model)
  for (const btn of wrap.querySelectorAll('.mode-pill')) {
    const v = btn.dataset.effort
    btn.hidden = !supported.includes(v)
    btn.setAttribute('aria-pressed', v === current ? 'true' : 'false')
    if (v === 'xhigh') {
      const label = btn.querySelector('span')
      if (label) label.textContent = isGpt55 ? '超高' : '编码模式'
    }
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
