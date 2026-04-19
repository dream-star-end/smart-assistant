// OpenClaude — 科研模式工具条
//
// 仅在用户选中「科研模式」pill(max effort)时可见。提供两类便捷操作:
//
//   1) 受众切换(toggle pill):同行 / 跨领域 / 决策层
//      选中后,composer textarea 末尾附上一行 `[受众: 跨领域]` 标签,
//      用户可见、可编辑、可删除 — 零协议改动,gateway 不需要识别。
//      科研守则 slot(promptSlots.ts buildResearchSlot)会告诉 agent
//      "根据 [受众:] 标签调整表述"。
//
//   2) 浓缩模板(one-shot button):一页纸 / 半页纸 / 摘要
//      点一下 → 向 textarea 注入预设文案(结构化四段压缩模板)。
//      用户可编辑后发送。
//
// 所有状态仅属当前会话(sessionStorage,不跨会话),避免污染其它对话。

import { $ } from './dom.js'
import { getCurrentEffort, modelSupportsExtraEffort } from './effortMode.js'
import { getSession, state } from './state.js'

// 受众选择按 session.id 分桶存在 sessionStorage(随标签页关闭清空)。
// 不同会话独立;同 agent 切会话也独立。
// memory feedback_localstorage_user_bucket 的精神是"分桶 key 拿不到 id 就返 null
// 不落盘",这里也遵循:getSession() 返回不了就不存。
const AUDIENCE_KEY_PREFIX = 'openclaude_research_audience_v2:'
const AUDIENCES = /** @type {const} */ ({
  peer: '同行',
  cross: '跨领域',
  exec: '决策层',
})

function audienceStorageKey() {
  const sid = getSession()?.id
  return sid ? `${AUDIENCE_KEY_PREFIX}${sid}` : null
}

// ── 受众标签文案生成 ──
// 文案要求:用户直接可见(不是隐藏 preamble),删改都行。所以用明显方括号。
function audienceTag(key) {
  const zh = AUDIENCES[key]
  if (!zh) return ''
  const hint =
    key === 'cross'
      ? '(跨领域受众,展开所有缩写并加一句人话解释)'
      : key === 'exec'
        ? '(决策层,去掉推导,保留结论与数字,不超过半页)'
        : '(同行,可保留专业表述,不用展开缩写)'
  return `[受众: ${zh}${hint}]`
}

/** 读当前会话的受众选择。返回 'peer'|'cross'|'exec'|''。无会话时返回 ''。 */
function readAudience() {
  try {
    const key = audienceStorageKey()
    if (!key) return ''
    const v = sessionStorage.getItem(key) ?? ''
    return v in AUDIENCES ? v : ''
  } catch {
    return ''
  }
}

function writeAudience(v) {
  try {
    const key = audienceStorageKey()
    if (!key) return
    if (v && v in AUDIENCES) sessionStorage.setItem(key, v)
    else sessionStorage.removeItem(key)
  } catch {
    // ignore
  }
}

/** 根据当前受众选择,在 textarea 里同步 `[受众: ...]` 标签:
 *   - 只删**末尾独占一行**且精确匹配 audienceTag() 输出格式的 tag
 *   - 不对正文中间出现的 `[受众: ...]` 字串做任何处理(避免误伤用户正文)
 *   - 若新值非空,追加到 textarea 末尾(前面补换行)
 *  这样用户切换受众或取消不会堆积残留,同时不会静默损坏用户打字的正文。 */
function syncAudienceInTextarea(newKey) {
  const ta = /** @type {HTMLTextAreaElement|null} */ ($('input'))
  if (!ta) return
  // 构造三种 audience 的精确 tag 文案,只匹配"独占末尾一行"的 tag:
  //   - 行首锚: 整个字符串开头 或 紧挨在换行之后
  //   - 行尾锚: 字符串末尾(tag 后面只允许可选空白)
  // 这样若用户在一行尾部直接写 `note:[受众: 同行(...)]` 不会被当成本模块注入的 tag。
  const allTags = Object.keys(AUDIENCES).map((k) => audienceTag(k))
  let cleaned = ta.value
  let stripped = false
  for (const t of allTags) {
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // 前导:字符串开头 OR 一个换行(把换行一起吃掉以免留下空白行)
    const re = new RegExp(`(?:^|\\r?\\n)${escaped}\\s*$`, 'u')
    const m = cleaned.match(re)
    if (m) {
      cleaned = cleaned.slice(0, m.index ?? 0)
      stripped = true
      break // 末尾只可能有一个 audience tag
    }
  }
  // 只在刚剥掉 tag 时收尾部空白(tag 前的换行/空格可能已被贪婪消耗)。
  // 没匹配到 tag 就不动用户原文 —— 尊重用户手打的尾部换行。
  if (stripped) cleaned = cleaned.replace(/\s+$/, '')
  const tag = newKey ? audienceTag(newKey) : ''
  const next = cleaned ? (tag ? `${cleaned}\n${tag}` : cleaned) : tag
  if (next === ta.value) return // 幂等:无变化不触发事件,避免 renderResearchTools 连环触发
  ta.value = next
  // 触发 input 事件让 autosize 和 send-btn 的 disabled 状态刷新
  ta.dispatchEvent(new Event('input', { bubbles: true }))
}

// ── 浓缩模板文案 ──
const CONDENSE_TEMPLATES = {
  onepage: [
    '请把上一个回答压缩成**一页纸**,按以下四段结构:',
    '1. **背景**(2~3 行)',
    '2. **核心问题**(2~3 行)',
    '3. **关键数据**(一张不超过 6 行的小表,保留最重要的定量结论)',
    '4. **结论**(3~5 行,含推荐方案与主要风险)',
    '去掉详细推导、公式、冗余说明。',
  ].join('\n'),
  halfpage: [
    '请把上一个回答压缩成**半页纸**(约 300 字),只保留:',
    '- 一句话背景',
    '- 问题/方案的核心点 3 条',
    '- 1~2 个最关键数字(含单位和不确定度)',
    '- 一句话结论',
  ].join('\n'),
  tldr: [
    '请用**一段话 TL;DR**(不超过 80 字)总结上一个回答,',
    '必须包含:结论是什么、最关键的一个数字、最大的一个风险或前提。',
  ].join('\n'),
}

function insertCondenseTemplate(kind) {
  const text = CONDENSE_TEMPLATES[kind]
  if (!text) return
  const ta = /** @type {HTMLTextAreaElement|null} */ ($('input'))
  if (!ta) return
  const existing = ta.value.trim()
  ta.value = existing ? `${existing}\n\n${text}` : text
  ta.focus()
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  // 光标放最后
  ta.setSelectionRange(ta.value.length, ta.value.length)
}

// ── Render / visibility ──
// 整条工具条仅当同时满足:
//   - 当前 agent 的 model 支持 extra effort(Opus 4.7)
//   - 用户显式选了 effort=max("科研模式" pill)
// 才显示。避免"某 agent 以前存了 max,后来 model 改成非 4.7"时,前端工具条
// 还在但后端不再注入 research slot 的错位。
function currentModelSupportsResearch() {
  const sess = getSession()
  if (!sess) return false
  const agentId = sess.agentId || state.defaultAgentId
  const agent = (state.agentsList || []).find((a) => a.id === agentId)
  return modelSupportsExtraEffort(agent?.model)
}

export function renderResearchTools() {
  const wrap = $('research-tools')
  if (!wrap) return
  const visible = currentModelSupportsResearch() && getCurrentEffort() === 'max'
  wrap.hidden = !visible
  if (!visible) {
    // 工具条隐藏时,顺手把 textarea 里可能残留的 audience tag 清掉 —— 防止
    // "在 A 会话的 max 模式下加了 tag,切到 B 会话非 max 或非 4.7 agent"后,
    // 发送时把 tag 和正文一起发出去。只动独占末尾行的 tag,不碰正文。
    syncAudienceInTextarea('')
    return
  }
  const cur = readAudience()
  for (const btn of wrap.querySelectorAll('.audience-pill')) {
    const v = btn.dataset.audience
    btn.setAttribute('aria-pressed', v === cur ? 'true' : 'false')
  }
  // 把 textarea 里的 tag 同步到当前 session 的 audience 选择。
  // 注:syncAudienceInTextarea 是幂等的 —— tag 已对则无改动,不对才替换。
  syncAudienceInTextarea(cur)
}

/** 一次性绑定科研工具条的事件(受众 pill toggle + 浓缩按钮 click)。 */
export function initResearchTools() {
  const wrap = $('research-tools')
  if (!wrap) return
  wrap.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target)
    const audienceBtn = target.closest('.audience-pill')
    if (audienceBtn && wrap.contains(audienceBtn)) {
      const v = audienceBtn.dataset.audience ?? ''
      if (!(v in AUDIENCES)) return
      const cur = readAudience()
      const next = cur === v ? '' : v
      writeAudience(next)
      syncAudienceInTextarea(next)
      renderResearchTools()
      return
    }
    const condenseBtn = target.closest('.condense-btn')
    if (condenseBtn && wrap.contains(condenseBtn)) {
      const kind = condenseBtn.dataset.condense ?? ''
      insertCondenseTemplate(kind)
    }
  })
  // effort pill 被点击后 effortMode.setCurrentEffort 会调 renderModePills,
  // 但它不知道要同步我们。在这里额外挂一个监听 — composer-modes 的 click
  // 冒泡完成后,下一 microtask 同步可见性。
  const modesRow = $('composer-modes')
  if (modesRow) {
    modesRow.addEventListener('click', () => {
      queueMicrotask(() => renderResearchTools())
    })
  }
  renderResearchTools()
}
