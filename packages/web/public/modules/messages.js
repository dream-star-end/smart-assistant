// OpenClaude — Message rendering and display
import { _openTopupModal } from './billing.js?v=7e6fc8e6'
import { $, _mod, fallbackCopy, htmlSafeEscape, makeDisclosure } from './dom.js?v=7e6fc8e6'
import { getEffortForSubmit } from './effortMode.js?v=7e6fc8e6'
import { refreshPlanPanel } from './planPanel.js?v=7e6fc8e6'
import { getConversationModeForSubmit, requestDefaultNextSubmit } from './planMode.js?v=7e6fc8e6'
import { exportMessageDocx } from './export-docx.js?v=7e6fc8e6'
import { exportMessageTex } from './export-tex.js?v=7e6fc8e6'
import {
  clearChartInstances,
  embedMediaUrls,
  processRichBlocks,
  renderMarkdown,
  _renderLocalMedia,
  renderStreamingMarkdown,
} from './markdown.js?v=7e6fc8e6'
import { getSession, state, tryEnqueueOffline, MAX_OFFLINE_QUEUE } from './state.js?v=7e6fc8e6'
import { toast } from './ui.js?v=7e6fc8e6'
import { getSingleAgentModelOverride } from './modelPolicy.js?v=7e6fc8e6'
import { parsePartialJson } from './partialJson.js?v=7e6fc8e6'
import { msgTimeLabel, shortTime } from './util.js?v=7e6fc8e6'
import {
  formatMeta,
  getMsgRequestId,
  getActiveStopAgentId,
  safeWsSend,
  setActiveTeamRunForSession,
  _resetTurnBillingState,
} from './websocket.js?v=7e6fc8e6'

// ── Export helpers for save-as feature ──
const _EXPORT_CSS =
  'body{font-family:"Microsoft YaHei","Segoe UI",Arial,sans-serif;font-size:14px;line-height:1.8;color:#333;max-width:800px;margin:0 auto;padding:20px}' +
  'h1{font-size:24px;border-bottom:1px solid #eee;padding-bottom:8px}h2{font-size:20px}h3{font-size:18px}' +
  'code{background:#f5f5f5;padding:2px 6px;border-radius:3px;font-family:Consolas,"Courier New",monospace;font-size:13px}' +
  'pre{background:#f5f5f5;padding:16px;border-radius:6px;overflow-x:auto;border:1px solid #e8e8e8}pre code{background:none;padding:0}' +
  'table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px 12px;text-align:left}th{background:#f5f5f5;font-weight:600}' +
  'blockquote{border-left:4px solid #ddd;margin:0 0 16px;padding:0 16px;color:#666}img{max-width:100%}ul,ol{padding-left:24px}a{color:#0366d6}'

function _exportTs() {
  const d = new Date()
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`
}

function _dlBlob(blob, name) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// Pure render: independent marked instance — no custom renderers, no queue side effects
let _cleanMarked = null
function _renderCleanHtml(text) {
  if (!text || !window.marked || !window.DOMPurify) {
    // Strip image markdown to avoid leaking local paths in fallback
    const safe = (text || '').replace(/!\[([^\]]*)\]\([^)]+\)/g, (_, alt) => (alt ? `[图片: ${alt}]` : '[图片]'))
    return htmlSafeEscape(safe).replace(/\n/g, '<br>')
  }
  if (!_cleanMarked) _cleanMarked = new marked.Marked({ gfm: true, breaks: true })
  const html = DOMPurify.sanitize(_cleanMarked.parse(text))
  // Strip images with local/server paths to prevent path leakage
  const div = document.createElement('div')
  div.innerHTML = html
  div.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') || ''
    if (!src.startsWith('http://') && !src.startsWith('https://') && !src.startsWith('data:')) {
      const ph = document.createElement('span')
      ph.textContent = img.alt ? `[图片: ${img.alt}]` : '[图片]'
      ph.style.cssText = 'color:#999;font-style:italic'
      img.replaceWith(ph)
    }
  })
  return div.innerHTML
}

function _exportMd(text) {
  _dlBlob(new Blob([text], { type: 'text/markdown;charset=utf-8' }), `openclaude-${_exportTs()}.md`)
}

function _exportPdf(text) {
  const html = _renderCleanHtml(text)
  const w = window.open('', '_blank')
  if (!w) {
    toast('请允许弹窗以导出 PDF', 'error')
    return
  }
  w.document.write(
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>OpenClaude</title>' +
      `<style>${_EXPORT_CSS}@media print{body{padding:0;margin:10px}}</style></head>` +
      `<body>${html}<script>window.onload=function(){window.print()}<\/script></body></html>`,
  )
  w.document.close()
}

// Late-bound references set by main.js to break circular deps
let _updateSendEnabled
let _showTypingIndicator
let _hideTypingIndicator
let _setTitleBusy
let _scheduleSaveFromUserEdit
let _clearTurnTiming
let _resetReplyTracker
let _openMemoryModal
let _openSkillsModal
let _openTasksModal
// 2026-06-18 — 逐条反馈入口(main.js openFeedbackModal 带消息上下文)。
let _openMessageFeedback
export function setMessageDeps(deps) {
  _updateSendEnabled = deps.updateSendEnabled
  _showTypingIndicator = deps.showTypingIndicator
  _hideTypingIndicator = deps.hideTypingIndicator
  _setTitleBusy = deps.setTitleBusy
  _scheduleSaveFromUserEdit = deps.scheduleSaveFromUserEdit
  _clearTurnTiming = deps.clearTurnTiming
  _resetReplyTracker = deps.resetReplyTracker
  _openMemoryModal = deps.openMemoryModal
  _openSkillsModal = deps.openSkillsModal
  _openTasksModal = deps.openTasksModal
  _openMessageFeedback = deps.openMessageFeedback
}

// 2026-06-18 — 消息操作栏"反馈"按钮(替代原"删除")。点击打开反馈弹窗并带上本条
// 消息的请求ID(traceId)做关联键。图标用 message-square,与现有 inline-svg 风格一致。
const _SVG_FEEDBACK =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'
const _FEEDBACK_BTN_HTML = `<button data-action="feedback" title="反馈">${_SVG_FEEDBACK}</button>`

// 从消息对象组装逐条反馈上下文:请求ID(traceId)+ 会话/消息 id + 角色 + 文本摘要。
// 摘要截断到 280 字,够 admin 还原问题语境又不灌满 meta(后端 8KB 上限)。
function _buildMsgFeedbackContext(sess, msg) {
  const text = typeof msg?.text === 'string' ? msg.text : ''
  return {
    traceId: getMsgRequestId(msg) || null,
    sessionId: sess?.id || null,
    msgId: msg?.id || null,
    role: msg?.role || null,
    errorCode: msg?._errorCode || null,
    snippet: text ? text.slice(0, 280) : null,
  }
}

// ── Closure-stale msg ref helpers (sync server-wins guard) ──
// Background: when sync.js's 409 server-wins path overwrites sess.messages
// (sync.js:1392 "sess.messages was just overwritten"), DOM event handlers
// that captured `msg` in a closure at build time become orphans —
// `sess.messages.indexOf(msg)` returns -1. Click → silent no-op (regen/del)
// or stale-content read (copy/save/tts). _findMsgIdx resolves a fresh idx
// by id; live-resolved msg is then used for both array ops and content reads.
export function _findMsgIdx(sess, msg) {
  if (!sess || !Array.isArray(sess.messages) || !msg) return -1
  let idx = sess.messages.indexOf(msg)
  if (idx >= 0) return idx
  if (msg.id) idx = sess.messages.findIndex((m) => m && m.id === msg.id)
  return idx
}

// ── Message status rendering ──
const _STATUS_SVG = {
  sending:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10" stroke-dasharray="20" stroke-dashoffset="10"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/></circle></svg>',
  queued:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  sent: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>',
  read: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="18 6 7 17 2 12"/><polyline points="22 6 11 17 8 14"/></svg>',
  replied:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="18 6 7 17 2 12"/><polyline points="22 6 11 17 8 14"/></svg>',
}
const _STATUS_LABEL = {
  sending: '发送中',
  // 2026-04-27:"排队中"→"待发送"。"排队"暗示后端拥堵,实际只是离线缓冲。
  // websocket.js 同名表也同步改了,两处必须保持一致。
  queued: '待发送',
  sent: '已发送',
  read: '已读',
  replied: '已回复',
}

// 2026-05-06 §4.6 改动 13 — user msg 角标改为派生:
// 'sending' / 'queued' / 'sent' / 'read' 仍由 client UI 显式写 msg.status;
// 'replied' 永远不持久化字段,在 render 时按"本 user 之后(到下一 user 之前)
// 是否有 server-authored && status:'completed' 的 assistant"现算。
//
// 严格条件(Codex R1 收紧后):
//   - thinking-only turn 不算 'replied'(只思考没回复)
//   - interrupted/crashed assistant 不算 'replied'(渲染 'sent' 让 boss 看到没回完)
//   - 历史 m.status === 'replied' 在 dbGetAll 阶段被 strip(db.js _normalizeLoadedSession)
//
// 行为:
//   1) 显式 sending/queued 优先返回(客户端发送中态,不能被派生覆盖)
//   2) 扫 [idx+1, ...] 至下一 user 边界:
//      - role === 'assistant' && _source === 'server' && status === 'completed' → 'replied'
//   3) 默认回退 m.status || 'sent'
export function _deriveUserMsgStatus(messages, idx) {
  if (!Array.isArray(messages)) return null
  const m = messages[idx]
  if (!m || m.role !== 'user') return null
  if (m.status === 'sending' || m.status === 'queued') return m.status
  for (let j = idx + 1; j < messages.length; j++) {
    const next = messages[j]
    if (!next) continue
    if (next.role === 'user') break
    if (next.role !== 'assistant') continue
    if (next._source !== 'server') continue
    if (next.status === 'completed') return 'replied'
    // interrupted / crashed / 其他:不返 'replied',继续扫(虽然下一个一般不会再有 completed)
  }
  return m.status || 'sent'
}

// 2026-05-06 §4.5 改动 10 — 仅更新 .msg-meta 元素的轻量 DOM 路径。
// setUsage(websocket.js)合入 msg.usage 后调本函数,避免触发 .msg 气泡 innerHTML
// 全量 re-render(后者会让 streaming caret 跳动 / Markdown 重排闪烁)。
// 找不到 .msg-meta 时按需 append;formatMeta(msg) 返空时移除现有 .msg-meta。
export function updateMsgMetaEl(msg) {
  if (!msg || !msg.id) return
  const el = document.querySelector(`[data-msg-id="${msg.id}"]`)
  if (!el) return
  const text = formatMeta(msg)
  let meta = el.querySelector('.msg-meta')
  if (!text) {
    if (meta) meta.remove()
  } else {
    if (!meta) {
      meta = document.createElement('div')
      meta.className = 'msg-meta'
      // 放在 .msg-reqid / .msg-time 之前,保持"积分 → 请求ID → 时间"的视觉顺序。
      const anchor = el.querySelector('.msg-reqid') || el.querySelector('.msg-time')
      if (anchor) el.insertBefore(meta, anchor)
      else el.appendChild(meta)
    }
    renderMetaInto(meta, text)
  }
  // 2026-06-18 — 请求ID 与积分分离:即使本轮无计费(text 为空),只要 usage.traceId
  // 到了就渲染请求ID 芯片。setUsage 异步合入 traceId 后会再次走到这里。
  _renderReqIdInto(el, msg)
}

// 2026-06-18 — 渲染响应底部"请求ID"芯片(替代原 token 统计)。
// 读 msg.usage.traceId(master per-turn canonical id):点击复制全量 id,短显前 8 位,
// title 给全量值。运维拿这串能 grep master turn 日志;逐条反馈也带它做关联键。
// 与 .msg-meta(积分)职责分离,统一插在 .msg-time 之前。幂等:重复调用先清旧芯片。
function _renderReqIdInto(parentEl, msg) {
  if (!parentEl) return
  const existing = parentEl.querySelector('.msg-reqid')
  if (existing) existing.remove()
  const rid = getMsgRequestId(msg)
  if (!rid) return
  const chip = document.createElement('button')
  chip.type = 'button'
  chip.className = 'msg-reqid'
  chip.title = `请求ID ${rid}（点击复制，用于反馈/排查）`
  chip.setAttribute('aria-label', `复制请求ID ${rid}`)
  chip.innerHTML =
    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
  const label = document.createElement('span')
  label.className = 'msg-reqid-text'
  label.textContent = `ID ${rid.length > 8 ? rid.slice(0, 8) : rid}`
  chip.appendChild(label)
  chip.addEventListener('click', (e) => {
    e.stopPropagation()
    try {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(rid).catch(() => fallbackCopy(rid))
      } else fallbackCopy(rid)
      toast('已复制请求 ID', 'success')
    } catch {
      fallbackCopy(rid)
    }
  })
  const timeEl = parentEl.querySelector('.msg-time')
  if (timeEl) parentEl.insertBefore(chip, timeEl)
  else parentEl.appendChild(chip)
}

// ═══════════════ RENDERING ═══════════════
export function ensureInner() {
  let inner = document.querySelector('.messages-inner')
  if (!inner) {
    inner = document.createElement('div')
    inner.className = 'messages-inner'
    $('messages').appendChild(inner)
  }
  return inner
}

export function isAtBottom() {
  const m = $('messages')
  return m.scrollHeight - m.scrollTop - m.clientHeight < 120
}

// Track whether user has manually scrolled up during streaming -- if so, don't auto-scroll
let _userScrolledUp = false
let _scrollDebounce = null

export function initMessagesListeners() {
  const _handleUserScroll = () => {
    if (state.sendingInFlight) {
      _userScrolledUp = !isAtBottom()
      clearTimeout(_scrollDebounce)
      _scrollDebounce = setTimeout(() => {
        _userScrolledUp = false
      }, 3000)
    }
  }
  const msgEl = $('messages')
  if (!msgEl) return
  // Listen to wheel (desktop), touchmove (mobile), and generic scroll (scrollbar drag, keyboard)
  // All listeners are passive: handler only reads state + sets timeout, never preventDefault
  msgEl.addEventListener('wheel', _handleUserScroll, { passive: true })
  msgEl.addEventListener('touchmove', _handleUserScroll, { passive: true })
  msgEl.addEventListener('scroll', _handleUserScroll, { passive: true })
}

export function scrollBottom(force) {
  const m = $('messages')
  // During streaming: always scroll unless user explicitly scrolled up
  if (force || (state.sendingInFlight && !_userScrolledUp) || isAtBottom()) {
    // Use instant scroll during streaming to avoid fighting with CSS smooth-scroll
    if (state.sendingInFlight) {
      m.scrollTo({ top: m.scrollHeight, behavior: 'instant' })
    } else {
      m.scrollTop = m.scrollHeight
    }
  }
}

// ── Tool card SVG icons ──
const _ICON_TERMINAL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>'
const _ICON_FILE_TEXT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
const _ICON_PEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>'
const _ICON_FILE_PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>'
const _ICON_SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>'
const _ICON_FOLDER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'
const _ICON_GLOBE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>'
const _ICON_CHECK_LIST = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>'
const _ICON_BROWSER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><circle cx="6.5" cy="6.5" r="0.6"/></svg>'
const _ICON_CAMERA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>'
const _ICON_CURSOR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l7 18 2-8 8-2z"/></svg>'
const _ICON_KEYBOARD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><line x1="6" y1="10" x2="6" y2="10"/><line x1="10" y1="10" x2="10" y2="10"/><line x1="14" y1="10" x2="14" y2="10"/><line x1="18" y1="10" x2="18" y2="10"/><line x1="7" y1="15" x2="17" y2="15"/></svg>'
const _ICON_FORM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="7" y1="9" x2="17" y2="9"/><line x1="7" y1="13" x2="17" y2="13"/><line x1="7" y1="17" x2="13" y2="17"/></svg>'
const _ICON_IMAGE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>'
const _ICON_VIDEO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>'
const _ICON_MUSIC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>'
const _ICON_MIC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10a7 7 0 0 1-14 0"/><line x1="12" y1="17" x2="12" y2="22"/></svg>'
const _ICON_BRAIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3a3 3 0 0 0-3 3 3 3 0 0 0-3 3 3 3 0 0 0 1.5 2.6A3 3 0 0 0 6 18a3 3 0 0 0 3 3"/><path d="M15 3a3 3 0 0 1 3 3 3 3 0 0 1 3 3 3 3 0 0 1-1.5 2.6A3 3 0 0 1 18 18a3 3 0 0 1-3 3"/><line x1="12" y1="3" x2="12" y2="21"/></svg>'
const _ICON_ARCHIVE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>'
const _ICON_CLOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>'
const _ICON_BOT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="7" width="16" height="12" rx="2"/><line x1="12" y1="3" x2="12" y2="7"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/></svg>'
const _ICON_SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>'
const _ICON_SPARKLE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 5.4L19 10l-5.2 1.6L12 17l-1.8-5.4L5 10l5.2-1.6z"/><path d="M19 17l1 3 3 1-3 1-1 3-1-3-3-1 3-1z"/></svg>'
const _ICON_EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'
const _ICON_CHART = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg>'
const _ICON_GEAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>'
const _ICON_NOTEBOOK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>'

const _TOOL_ICONS = {
  Bash: _ICON_TERMINAL,
  Read: _ICON_FILE_TEXT,
  Edit: _ICON_PEN,
  Write: _ICON_FILE_PLUS,
  Grep: _ICON_SEARCH,
  Glob: _ICON_FOLDER,
  WebFetch: _ICON_GLOBE,
  WebSearch: _ICON_GLOBE,
  TodoWrite: _ICON_CHECK_LIST,
  NotebookEdit: _ICON_NOTEBOOK,
  Task: _ICON_BOT,
  Agent: _ICON_BOT,
  'Codex:multiAgent': _ICON_BOT,
  _default: _ICON_GEAR,
}

const _TOOL_LABELS = {
  Bash: '终端', Read: '读取文件', Edit: '编辑文件', Write: '写入文件',
  Grep: '搜索内容', Glob: '搜索文件', WebFetch: '网页抓取', WebSearch: '网页搜索',
  TodoWrite: '任务列表', NotebookEdit: '笔记本', Task: '子任务', Agent: '子任务',
  'Codex:multiAgent': '多 Agent 控制',
}

// ── MCP server prefix → friendly meta (icon + base label) ──
// Tools are named `mcp__<server>__<op>`. We classify by server, then by op.
const _MCP_SERVER_META = {
  browser: { icon: _ICON_BROWSER, label: '浏览器' },
  'minimax-media': { icon: _ICON_SPARKLE, label: '媒体生成' },
  'minimax-vision': { icon: _ICON_EYE, label: '视觉理解' },
  'openclaude-vision': { icon: _ICON_EYE, label: '视觉理解' },
  'openclaude-memory': { icon: _ICON_BRAIN, label: '记忆' },
  'scansci-pdf': { icon: _ICON_FILE_TEXT, label: '论文检索' },
  codex: { icon: _ICON_BOT, label: 'Codex' },
  'quant-system': { icon: _ICON_CHART, label: '量化' },
}

// Codex thread item types — emitted as `codex:<itemType>` tool_use by
// CodexAppServerRunner.handleItemStarted (gateway). commandExecution and
// fileChange are aliased to Bash/Write/Edit upstream and never reach this
// table. userMessage / hookPrompt / agentMessage are suppressed at the
// gateway; reasoning is streamed as a thinking_delta and surfaces as a
// 💭 thinking card instead of a tool card. The remaining types fall here.
//
// Label policy: align with claude-code tool labels (no "Codex" prefix) so
// the user sees one consistent vocabulary across both runners. mcpToolCall
// / dynamicToolCall / collabAgentToolCall labels here are fallbacks —
// `_resolveCodexMeta` unwraps the inner server/tool/agent and prefers the
// matching `_MCP_OP_META` / `_TOOL_LABELS` entry so codex calls into
// browser / minimax-media / openclaude-memory render with the same icon
// and label as their native MCP counterparts.
const _CODEX_TYPE_META = {
  // Both `plan` (codex 0.125-era) and `todo_list` (codex 0.130+) emit the
  // same shape after `_normalizeCodexPlanInput`. Keep both keys so the icon
  // + label resolves regardless of which schema version the CLI uses.
  plan: { icon: _ICON_CHECK_LIST, label: '任务列表' },
  todo_list: { icon: _ICON_CHECK_LIST, label: '任务列表' },
  mcpToolCall: { icon: _ICON_GEAR, label: 'MCP 工具' },
  dynamicToolCall: { icon: _ICON_GEAR, label: '工具调用' },
  collabAgentToolCall: { icon: _ICON_BOT, label: '委托子任务' },
  webSearch: { icon: _ICON_GLOBE, label: '网页搜索' },
  imageView: { icon: _ICON_EYE, label: '查看图片' },
  imageGeneration: { icon: _ICON_IMAGE, label: '生成图片' },
  enteredReviewMode: { icon: _ICON_BOT, label: '进入审阅模式' },
  exitedReviewMode: { icon: _ICON_BOT, label: '退出审阅模式' },
  contextCompaction: { icon: _ICON_ARCHIVE, label: '压缩上下文' },
}

// Per-op overrides for richer icons (server-scoped).
const _MCP_OP_META = {
  // browser
  'browser:browser_navigate': { icon: _ICON_GLOBE, label: '打开网页' },
  'browser:browser_navigate_back': { icon: _ICON_GLOBE, label: '后退' },
  'browser:browser_take_screenshot': { icon: _ICON_CAMERA, label: '截图' },
  'browser:browser_snapshot': { icon: _ICON_BROWSER, label: '页面快照' },
  'browser:browser_click': { icon: _ICON_CURSOR, label: '点击' },
  'browser:browser_type': { icon: _ICON_KEYBOARD, label: '输入文本' },
  'browser:browser_fill_form': { icon: _ICON_FORM, label: '填写表单' },
  'browser:browser_press_key': { icon: _ICON_KEYBOARD, label: '按键' },
  'browser:browser_select_option': { icon: _ICON_FORM, label: '选择选项' },
  'browser:browser_evaluate': { icon: _ICON_TERMINAL, label: '执行脚本' },
  'browser:browser_run_code': { icon: _ICON_TERMINAL, label: '执行代码' },
  'browser:browser_wait_for': { icon: _ICON_CLOCK, label: '等待' },
  'browser:browser_close': { icon: _ICON_BROWSER, label: '关闭浏览器' },
  'browser:browser_tabs': { icon: _ICON_BROWSER, label: '标签页' },
  'browser:browser_console_messages': { icon: _ICON_TERMINAL, label: '控制台' },
  'browser:browser_network_requests': { icon: _ICON_GLOBE, label: '网络请求' },
  'browser:browser_pdf_save': { icon: _ICON_FILE_TEXT, label: '保存 PDF' },
  'browser:browser_resize': { icon: _ICON_BROWSER, label: '调整窗口' },
  'browser:browser_hover': { icon: _ICON_CURSOR, label: '悬停' },
  'browser:browser_drag': { icon: _ICON_CURSOR, label: '拖拽' },
  'browser:browser_file_upload': { icon: _ICON_FILE_PLUS, label: '上传文件' },
  'browser:browser_handle_dialog': { icon: _ICON_BROWSER, label: '处理弹窗' },
  // minimax-media
  'minimax-media:text_to_image': { icon: _ICON_IMAGE, label: '生成图片' },
  'minimax-media:generate_video': { icon: _ICON_VIDEO, label: '生成视频' },
  'minimax-media:query_video_generation': { icon: _ICON_VIDEO, label: '查询视频' },
  'minimax-media:music_generation': { icon: _ICON_MUSIC, label: '生成音乐' },
  'minimax-media:text_to_audio': { icon: _ICON_MIC, label: '语音合成' },
  'minimax-media:voice_clone': { icon: _ICON_MIC, label: '克隆音色' },
  'minimax-media:voice_design': { icon: _ICON_MIC, label: '设计音色' },
  'minimax-media:list_voices': { icon: _ICON_MIC, label: '音色列表' },
  'minimax-media:play_audio': { icon: _ICON_MUSIC, label: '播放音频' },
  // vision
  'minimax-vision:understand_image': { icon: _ICON_EYE, label: '图片理解' },
  'minimax-vision:web_search': { icon: _ICON_GLOBE, label: '联网搜索' },
  'openclaude-vision:understand_image': { icon: _ICON_EYE, label: '图片理解' },
  // memory
  'openclaude-memory:memory': { icon: _ICON_BRAIN, label: '核心记忆' },
  'openclaude-memory:archival_add': { icon: _ICON_ARCHIVE, label: '归档写入' },
  'openclaude-memory:archival_search': { icon: _ICON_ARCHIVE, label: '归档检索' },
  'openclaude-memory:archival_delete': { icon: _ICON_ARCHIVE, label: '归档删除' },
  'openclaude-memory:session_search': { icon: _ICON_SEARCH, label: '历史检索' },
  'openclaude-memory:create_reminder': { icon: _ICON_CLOCK, label: '创建提醒' },
  'openclaude-memory:delegate_task': { icon: _ICON_BOT, label: '委托子任务' },
  'openclaude-memory:send_to_agent': { icon: _ICON_SEND, label: '发送给子 Agent' },
  'openclaude-memory:skill_list': { icon: _ICON_SPARKLE, label: '技能列表' },
  'openclaude-memory:skill_view': { icon: _ICON_SPARKLE, label: '查看技能' },
  'openclaude-memory:skill_save': { icon: _ICON_SPARKLE, label: '保存技能' },
  'openclaude-memory:skill_delete': { icon: _ICON_SPARKLE, label: '删除技能' },
  // scansci-pdf
  'scansci-pdf:scansci_pdf_download': { icon: _ICON_FILE_TEXT, label: '下载论文 PDF' },
  'scansci-pdf:scansci_pdf_batch_download': { icon: _ICON_FILE_PLUS, label: '批量下载论文' },
  'scansci-pdf:scansci_pdf_search': { icon: _ICON_SEARCH, label: '搜索论文' },
  'scansci-pdf:scansci_pdf_citation': { icon: _ICON_FILE_TEXT, label: '生成引用' },
  'scansci-pdf:scansci_pdf_health_check': { icon: _ICON_CHECK_LIST, label: '论文源健康检查' },
  'scansci-pdf:scansci_pdf_network_diagnose': { icon: _ICON_GLOBE, label: '论文网络诊断' },
  'scansci-pdf:scansci_pdf_source_scores': { icon: _ICON_CHART, label: '论文源评分' },
  'scansci-pdf:scansci_pdf_vpnsci_status': { icon: _ICON_BROWSER, label: '机构登录状态' },
  'scansci-pdf:scansci_pdf_vpnsci_login': { icon: _ICON_BROWSER, label: '机构登录' },
  'scansci-pdf:scansci_pdf_vpnsci_test': { icon: _ICON_BROWSER, label: '测试机构访问' },
  'scansci-pdf:scansci_pdf_parse_list': { icon: _ICON_FILE_TEXT, label: '解析论文列表' },
  'scansci-pdf:scansci_pdf_resolve_and_download': { icon: _ICON_FILE_PLUS, label: '解析并下载' },
  // codex
  'codex:codex': { icon: _ICON_BOT, label: 'Codex 审查' },
  'codex:codex-reply': { icon: _ICON_BOT, label: 'Codex 回复' },
}

// Parse `mcp__<server>__<op>` → { server, op } or null for non-MCP names.
function _parseMcpName(name) {
  if (typeof name !== 'string' || !name.startsWith('mcp__')) return null
  const rest = name.slice(5)
  const idx = rest.indexOf('__')
  if (idx < 0) return { server: rest, op: '' }
  return { server: rest.slice(0, idx), op: rest.slice(idx + 2) }
}

// Convert snake_case op name into a friendlier label (`browser_navigate` → `browser navigate`).
function _humanizeOp(op) {
  return (op || '').replace(/_/g, ' ').trim()
}

// Parse `codex:<itemType>` → itemType (e.g. `codex:webSearch` → `webSearch`).
// Returns null for non-codex names. Lowercase prefix is required (gateway
// emits lowercase as of v1.0.65; older `Codex:` prefix from earlier
// rollouts is intentionally NOT matched — those messages are stale and
// should fall through to the generic gear icon).
function _parseCodexTypeName(name) {
  if (typeof name !== 'string' || !name.startsWith('codex:')) return null
  return name.slice(6)
}

// Unpack a codex mcpToolCall / dynamicToolCall ThreadItem to a canonical
// `{ server, tool, args }` triple. Codex protocol uses several spellings
// across versions (`server` vs `serverName`, `tool`/`toolName`/`name`,
// `arguments`/`args`/`params`) — this is the single source of truth so
// `_resolveCodexMeta` / `_codexSummary` / `_renderCodexItem` don't drift.
//
// args is force-coerced to a plain object: codex sometimes carries `args`
// as a JSON-stringified string or null/undefined; downstream MCP body
// renderers expect a dict, so we hand them `{}` instead of letting them
// trip on a string-typed input.
export function _codexResolveMcpCall(input) {
  if (!input || typeof input !== 'object') {
    return { server: '', tool: '', args: {}, rawArgs: undefined }
  }
  const server = typeof input.server === 'string' ? input.server
    : typeof input.serverName === 'string' ? input.serverName : ''
  const tool = typeof input.tool === 'string' ? input.tool
    : typeof input.toolName === 'string' ? input.toolName
    : typeof input.name === 'string' ? input.name : ''
  let rawArgs = input.arguments
  if (rawArgs === undefined) rawArgs = input.args
  if (rawArgs === undefined) rawArgs = input.params
  let args = {}
  if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
    args = rawArgs
  } else if (typeof rawArgs === 'string') {
    // Codex sometimes carries the args dict as a stringified JSON blob.
    try {
      const parsed = JSON.parse(rawArgs)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed
    } catch { /* ignore — caller falls back to rawArgs */ }
  }
  // rawArgs surfaced so unknown-tool fallbacks can still show the original
  // input when `args` was force-coerced to `{}` for downstream renderers
  // (codex review CONCERN #3 — don't silently swallow non-dict args).
  return { server, tool, args, rawArgs }
}

// Codex-aware meta resolution. Only invoked from `_toolMeta` when name is
// `codex:<itemType>` AND input is available. Unwraps the inner tool so
// codex calls into native MCP servers show the same icon+label as direct
// claude-code MCP calls.
//
// Returns null when no unwrap is possible — caller falls back to the
// generic `_CODEX_TYPE_META` entry.
function _resolveCodexMeta(codexType, input) {
  if (!input || typeof input !== 'object') return null
  if (codexType === 'mcpToolCall') {
    const { server, tool } = _codexResolveMcpCall(input)
    if (server && tool) {
      const opMeta = _MCP_OP_META[`${server}:${tool}`]
      if (opMeta) return opMeta
      const srvMeta = _MCP_SERVER_META[server]
      if (srvMeta) return { icon: srvMeta.icon, label: `${srvMeta.label}: ${_humanizeOp(tool)}` }
    }
    return null
  }
  if (codexType === 'dynamicToolCall') {
    const { tool } = _codexResolveMcpCall(input)
    if (!tool) return null
    // builtin claude-code tool (Bash/Read/Edit/Grep/...): reuse its meta
    if (_TOOL_ICONS[tool]) {
      return { icon: _TOOL_ICONS[tool], label: _TOOL_LABELS[tool] || tool }
    }
    // mcp__server__op shape: parse and look up
    const mcp = _parseMcpName(tool)
    if (mcp) {
      const opMeta = _MCP_OP_META[`${mcp.server}:${mcp.op}`]
      if (opMeta) return opMeta
      const srvMeta = _MCP_SERVER_META[mcp.server]
      const opLabel = _humanizeOp(mcp.op) || mcp.server
      if (srvMeta) return { icon: srvMeta.icon, label: `${srvMeta.label}: ${opLabel}` }
      return { icon: _ICON_GEAR, label: opLabel }
    }
    // unknown tool name — surface it (truncated) so the user at least sees
    // what codex is calling, rather than a useless "工具调用" placeholder.
    // 60-char cap mirrors `_codexSummary` truncation so a pathologically
    // long `mcp__some_long_server__some_long_op_name` doesn't stretch the
    // tool-card header (codex review CONCERN #5).
    const labelTool = tool.length > 60 ? `${tool.slice(0, 60)}…` : tool
    return { icon: _ICON_GEAR, label: labelTool }
  }
  return null
}

// Resolve icon + label for a tool name (handles MCP names + codex items).
// `input` is the tool's parsed input dict (from `_safeInput(msg)`); pass
// undefined when the caller has none (codex unwrap simply falls back to
// the static `_CODEX_TYPE_META` entry in that case).
export function _toolMeta(name, input) {
  if (_TOOL_ICONS[name]) return { icon: _TOOL_ICONS[name], label: _TOOL_LABELS[name] || name }
  const codexType = _parseCodexTypeName(name)
  if (codexType) {
    const unwrapped = _resolveCodexMeta(codexType, input)
    if (unwrapped) return unwrapped
    const meta = _CODEX_TYPE_META[codexType]
    if (meta) return meta
    return { icon: _ICON_BOT, label: `Codex: ${codexType}` }
  }
  const mcp = _parseMcpName(name)
  if (mcp) {
    const opMeta = _MCP_OP_META[`${mcp.server}:${mcp.op}`]
    if (opMeta) return opMeta
    const srvMeta = _MCP_SERVER_META[mcp.server]
    const opLabel = _humanizeOp(mcp.op) || mcp.server
    if (srvMeta) return { icon: srvMeta.icon, label: `${srvMeta.label}: ${opLabel}` }
    return { icon: _ICON_GEAR, label: opLabel }
  }
  return { icon: _ICON_GEAR, label: name }
}

function _safeInput(msg) {
  // Priority: final inputJson > tolerant-parsed partialJson > legacy inputPreview parse.
  // partialJson is the gateway-streamed accumulator of `input_json_delta` events
  // and drives partial Edit/Write body rendering before the tool block closes.
  if (msg.inputJson && typeof msg.inputJson === 'object') return msg.inputJson
  if (typeof msg.partialJson === 'string' && msg.partialJson.length > 0) {
    return parsePartialJson(msg.partialJson)
  }
  if (msg.inputPreview) {
    try { return JSON.parse(msg.inputPreview) } catch { return null }
  }
  return null
}

function _shortPath(p) {
  if (!p || typeof p !== 'string') return ''
  // Show last 2-3 path segments
  const parts = p.replace(/\\/g, '/').split('/')
  return parts.length > 3 ? '…/' + parts.slice(-3).join('/') : p
}

function _buildPermissionCard(el, msg) {
  // AskUserQuestion is rendered as an interview summary (one line per
  // question→answer) instead of the generic Permission Request chip. Feeds
  // off msg._answers which websocket.js stores on allow-submit.
  if (msg.toolName === 'AskUserQuestion' && msg.inputJson && Array.isArray(msg.inputJson.questions)) {
    _buildAskUserQuestionCard(el, msg)
    return
  }

  const toolName = htmlSafeEscape(msg.toolName || 'unknown')
  const resolved = msg._resolved
  const behavior = msg._behavior
  const statusIcon = !resolved ? '⏳' : behavior === 'allow' ? '✓' : '✗'
  const statusText = !resolved ? 'Waiting for approval...' : behavior === 'allow' ? 'Allowed' : 'Denied'
  const statusClass = !resolved ? '' : behavior === 'allow' ? 'resolved-allow' : 'resolved-deny'

  const body = document.createElement('div')
  body.className = `msg-body ${statusClass}`
  body.innerHTML = `<div style="display:flex;align-items:center;gap:8px">` +
    `<span style="font-size:16px">${statusIcon}</span>` +
    `<span style="font-weight:600">Permission: </span>` +
    `<code>${toolName}</code>` +
    `<span style="color:var(--fg-muted);margin-left:auto;font-size:12px">${statusText}</span>` +
    `</div>` +
    (msg.inputPreview ? `<div style="font-size:12px;color:var(--fg-muted);margin-top:4px;word-break:break-all">${htmlSafeEscape(msg.inputPreview.slice(0, 200))}</div>` : '')
  el.appendChild(body)
}

function _buildAskUserQuestionCard(el, msg) {
  const resolved = msg._resolved
  const behavior = msg._behavior
  const answers = msg._answers || {}
  const questions = msg.inputJson.questions
  const statusIcon = !resolved ? '⏳' : behavior === 'allow' ? '✓' : '✗'
  const statusText = !resolved
    ? '等待回答…'
    : behavior === 'allow'
      ? '已提交'
      : '已跳过'
  const statusClass = !resolved ? '' : behavior === 'allow' ? 'resolved-allow' : 'resolved-deny'

  const body = document.createElement('div')
  body.className = `msg-body aq-card ${statusClass}`

  const headerEl = document.createElement('div')
  headerEl.className = 'aq-card-header'
  headerEl.innerHTML =
    `<span class="aq-card-icon">${statusIcon}</span>` +
    `<span class="aq-card-title">用户问答</span>` +
    `<span class="aq-card-status">${htmlSafeEscape(statusText)}</span>`
  body.appendChild(headerEl)

  const list = document.createElement('div')
  list.className = 'aq-card-list'
  for (const q of questions) {
    const row = document.createElement('div')
    row.className = 'aq-card-row'
    const qtext = document.createElement('div')
    qtext.className = 'aq-card-q'
    qtext.textContent = q.question
    row.appendChild(qtext)
    if (resolved && behavior === 'allow') {
      const ans = answers[q.question]
      const ansEl = document.createElement('div')
      ansEl.className = 'aq-card-a'
      ansEl.textContent = ans ? `→ ${ans}` : '→ (未回答)'
      row.appendChild(ansEl)
    }
    list.appendChild(row)
  }
  body.appendChild(list)
  el.appendChild(body)
}

// ── Agent group card (subagent container) ──
//
// Renders the Agent tool_use as a collapsible parent card whose body shows
// every child block produced by the subagent (routed in websocket.js via
// parentToolUseId). Rules:
//   - Expand/collapse is manual via clicking the header. Default:
//       * running  → expanded   (so the user sees live progress)
//       * completed → collapsed (auto-folds to a single-line summary)
//     Once the user clicks the header, msg._userCollapsed locks the choice;
//     later re-renders (streaming updates, updateMessageEl) respect it
//     rather than snapping back to the auto default.
//   - Nested Agent tools (a subagent spawning its own subagent) render as
//     a single tool card inside the child list — their grand-child output
//     is flattened into the same top-level group by websocket.js so the
//     UI never exceeds two visual levels ("再深就都算子 agent").
const _SVG_BOT_AGENT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="7" width="16" height="12" rx="2"/><line x1="12" y1="3" x2="12" y2="7"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/></svg>'
const _SVG_CHEVRON_AGENT =
  '<svg class="agent-group-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>'

function _resolveAgentGroupCollapsed(msg) {
  // User explicitly toggled → honor their choice forever.
  if (typeof msg._userCollapsed === 'boolean') return msg._userCollapsed
  // Auto: collapsed after completion, expanded while running.
  return !!msg._completed
}

// Build the DOM node for a single child block (text / thinking / tool_use), or
// null when there's nothing to render. Split out from _appendAgentChildBlock so
// _renderAgentGroup can diff and replace children individually (per-child
// incremental patch) instead of rebuilding the whole body every frame.
function _buildAgentChildNode(child) {
  if (!child || typeof child !== 'object') return null
  if (child.kind === 'text') {
    if (!child.text) return null
    const p = document.createElement('div')
    p.className = 'agent-group-child-text'
    // 与主聊天一致:文本走 markdown 渲染(主聊天 assistant 文本同款 renderMarkdown)。
    p.innerHTML = renderMarkdown(child.text)
    return p
  }
  if (child.kind === 'thinking') {
    if (!child.text) return null
    const p = document.createElement('div')
    p.className = 'agent-group-child-thinking'
    p.textContent = child.text
    return p
  }
  if (child.kind === 'tool_use') {
    const card = document.createElement('div')
    card.className = 'msg tool agent-group-child-tool'
    // Mark nested Agent calls (subagent spawning a grand-child subagent)
    // so CSS can add a subtle indent/accent — grand-child output is
    // flattened into this same group (see websocket.js), so a data
    // attribute is the only remaining visual cue.
    if (/^Agent$/i.test(child.toolName || '')) {
      card.dataset.nestedAgent = '1'
    }
    // _buildToolCard expects a msg-like object; child carries the same
    // field names (toolName, inputPreview, inputJson, _completed, output,
    // error, _partial) so it can be passed through directly.
    _buildToolCard(card, child)
    return card
  }
  return null
}

function _appendAgentChildBlock(body, child) {
  const node = _buildAgentChildNode(child)
  if (node) body.appendChild(node)
}

// Per-child render signature. _renderAgentGroup re-renders a child's DOM only
// when its signature changes, so completed cards above an actively-streaming
// child are not destroyed+rebuilt every frame (the flicker root cause).
//
// The live coalescer (_appendSubagentBlock) only ever APPENDS to text/thinking
// (length monotonic) and mutates tool_use in place — so length + flags are a
// faithful change detector for the streaming path. The extra fields below
// (text tail sample, toolName, truncatedHead) guard the non-append edge cases
// an audit raised (same-length replacement / metadata-only changes) so a stale
// child node can't survive a content change that happens to keep the length.
function _agentChildSig(ch) {
  if (!ch || typeof ch !== 'object') return ''
  if (ch.kind === 'text' || ch.kind === 'thinking') {
    const t = ch.text || ''
    return `${ch.kind}#${t.length}#${t.slice(-32)}`
  }
  if (ch.kind === 'tool_use') {
    const ij =
      ch.inputJson && typeof ch.inputJson === 'object' ? JSON.stringify(ch.inputJson).length : 0
    return [
      'tool',
      ch.blockId || '',
      ch.toolName || '',
      ch._partial ? 1 : 0,
      ch._completed ? 1 : 0,
      (ch.inputPreview || '').length,
      ij,
      (ch.output || '').length,
      ch.error ? 1 : 0,
      ch.bashTail?.totalBytes || 0,
      ch.bashTail?.truncatedHead ? 1 : 0,
    ].join('#')
  }
  return ch.kind || ''
}

// Renders the Agent / delegate_task tool_use as a collapsible parent card whose
// body shows every streamed child block. Incremental: the first call builds the
// full structure; later calls (every streaming frame) patch only what changed —
// status, title, newly-arrived/changed children, result preview. This is the
// #2b fix: we no longer innerHTML='' the whole card each frame, so a completed
// tool card above an actively-streaming one stops flickering.
function _renderAgentGroup(el, msg) {
  const collapsed = _resolveAgentGroupCollapsed(msg)
  // Title: delegate_task reads as "委托子任务: <goal>", native Agent as "子任务: …".
  const titlePrefix = msg._delegate ? '委托子任务' : '子任务'
  const wantTitle = `${titlePrefix}: ${msg.text || ''}`

  let statusHtml
  if (msg._completed) {
    if (msg._isError) {
      statusHtml = '<span style="color:var(--danger)">失败</span>'
    } else {
      const dur = typeof msg._duration === 'number' ? ` (${(msg._duration / 1000).toFixed(1)}s)` : ''
      statusHtml = `<span style="color:var(--success)">完成${dur}</span>`
    }
  } else {
    statusHtml = '运行中…'
  }

  if (!el._agentGroupInit) {
    // ── First build: full structure (one-time) ──
    el.innerHTML = ''
    el.className = 'agent-group'
    const header = document.createElement('div')
    header.className = 'agent-group-header'
    header.innerHTML = `${_SVG_BOT_AGENT}<span class="agent-group-title"></span><span class="agent-group-status"></span>${_SVG_CHEVRON_AGENT}`
    makeDisclosure(header, el, {
      onToggle: () => {
        msg._userCollapsed = !el.classList.contains('collapsed')
        el.classList.toggle('collapsed', msg._userCollapsed)
      },
    })
    el.appendChild(header)
    const body = document.createElement('div')
    body.className = 'agent-group-body'
    el.appendChild(body)
    el._agentGroupHeader = header
    el._agentGroupBody = body
    el._childEls = [] // childBlocks index → mounted DOM node (or null)
    el._childSigs = [] // childBlocks index → last render signature
    el._agentGroupInit = true
  }

  el.classList.toggle('collapsed', collapsed)

  const titleSpan = el._agentGroupHeader.querySelector('.agent-group-title')
  if (titleSpan && titleSpan.textContent !== wantTitle) titleSpan.textContent = wantTitle
  const statusSpan = el._agentGroupHeader.querySelector('.agent-group-status')
  if (statusSpan && statusSpan._html !== statusHtml) {
    statusSpan.innerHTML = statusHtml
    statusSpan._html = statusHtml
  }

  // ── Children: per-index diff. Only changed/new children touch the DOM. ──
  const body = el._agentGroupBody
  const children = Array.isArray(msg.childBlocks) ? msg.childBlocks : []
  for (let i = 0; i < children.length; i++) {
    const sig = _agentChildSig(children[i])
    if (el._childEls[i] !== undefined && el._childSigs[i] === sig) continue
    const node = _buildAgentChildNode(children[i])
    const prev = el._childEls[i]
    if (prev) {
      if (node) body.replaceChild(node, prev)
      else body.removeChild(prev)
    } else if (node) {
      // Insert in order, before the result row if it's already mounted.
      body.insertBefore(node, el._resultEl || null)
    }
    el._childEls[i] = node || null
    el._childSigs[i] = sig
  }

  // ── Result preview (in body, after children) + collapsed summary (on el). ──
  // body is display:none when collapsed, so a single-line copy is mirrored onto
  // the element itself; CSS hides whichever is redundant.
  if (msg._resultPreview) {
    const resHtml = `<span class="tool-icon">${msg._isError ? '⚠️' : '✓'}</span><div class="tool-body">${htmlSafeEscape(msg._resultPreview)}</div>`
    if (!el._resultEl) {
      el._resultEl = document.createElement('div')
      el._resultEl.className = 'agent-group-result'
      body.appendChild(el._resultEl)
    }
    if (el._resultEl._html !== resHtml) {
      el._resultEl.innerHTML = resHtml
      el._resultEl._html = resHtml
    }
    const summ = msg._resultPreview.slice(0, 200)
    if (!el._collapsedSummaryEl) {
      el._collapsedSummaryEl = document.createElement('div')
      el._collapsedSummaryEl.className = 'agent-group-collapsed-summary'
      el.appendChild(el._collapsedSummaryEl)
    }
    if (el._collapsedSummaryEl.textContent !== summ) el._collapsedSummaryEl.textContent = summ
  }
}

// Keys worth surfacing from a tool's (possibly truncated) JSON arg preview, in
// priority order, so a delegate tool chip reads like "father involvement…"
// instead of '{"query":"…"}'.
const _DELEGATE_ARG_KEYS = [
  'query', 'command', 'cmd', 'prompt', 'pattern', 'url', 'file_path', 'path', 'goal', 'description', 'content',
]

function _delegateClip(s, n) {
  const str = String(s)
  return str.length > n ? `${str.slice(0, n - 1)}…` : str
}

function _readableToolArg(arg) {
  const trimmed = String(arg).trim()
  if (!trimmed) return ''
  try {
    const obj = JSON.parse(trimmed)
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      for (const k of _DELEGATE_ARG_KEYS) {
        if (typeof obj[k] === 'string' && obj[k].trim()) return _delegateClip(obj[k].trim(), 96)
      }
      const firstStr = Object.values(obj).find((v) => typeof v === 'string' && v.trim())
      return firstStr ? _delegateClip(String(firstStr).trim(), 96) : ''
    }
  } catch {
    // Truncated/invalid JSON preview — pull the first interesting quoted value.
    for (const k of _DELEGATE_ARG_KEYS) {
      const mm = trimmed.match(new RegExp(`"${k}"\\s*:\\s*"([^"]+)"`))
      if (mm) return _delegateClip(mm[1].trim(), 96)
    }
    const any = trimmed.match(/"([^"]{3,})"/)
    if (any) return _delegateClip(any[1].trim(), 96)
  }
  return _delegateClip(trimmed.replace(/^[{[]\s*/, '').replace(/\s*[}\]]$/, ''), 96)
}

function _delegateToolArgPreview(text) {
  // Backend tool_use text: "调用工具 <name>: <preview>" | "调用工具 <name>".
  const m = String(text).match(/^调用工具\s+\S+\s*[:：]\s*([\s\S]+)$/)
  return m ? _readableToolArg(m[1]) : ''
}

// Render a delegate tool entry as a compact icon+name chip with a one-line arg
// preview, instead of raw "调用工具 X: {json}" debug text. Successful
// tool_result / output-tail entries are redundant with the call chip and are
// dropped; failures still surface.
function _buildDelegateToolChip(entry, text) {
  const isCall = text.startsWith('调用工具')
  if (!isCall && !entry.isError) return null
  const toolName = String(entry.toolName || '').trim() || 'tool'
  const meta = _toolMeta(toolName, null)
  const chip = document.createElement('div')
  chip.className = 'delegate-tool-chip'
  if (entry.isError) chip.classList.add('error')
  const arg = entry.isError ? '执行出错' : _delegateToolArgPreview(text)
  chip.innerHTML =
    `<span class="delegate-tool-chip-icon">${meta.icon}</span>` +
    `<span class="delegate-tool-chip-name">${htmlSafeEscape(meta.label || toolName)}</span>` +
    (arg ? `<span class="delegate-tool-chip-arg">${htmlSafeEscape(arg)}</span>` : '')
  return chip
}

// Build the render node for one legacy delegate-progress `entry` (tool chip for
// a tool call, plain text otherwise). Split out from the inline loop so the
// incremental diff in _renderDelegateProgress can build/replace entries
// individually instead of rebuilding the whole list. Returns null for
// nothing-to-render (empty / thinking) entries.
function _buildDelegateEntryNode(entry) {
  const text = String(entry?.text || '').trim()
  if (!text || entry.phase === 'thinking') return null
  if (entry.phase === 'tool') return _buildDelegateToolChip(entry, text)
  const p = document.createElement('div')
  p.className = 'agent-group-child-text'
  if (entry.isError) p.classList.add('error')
  p.textContent = text
  return p
}

// Per-entry render signature for the legacy entries view — same idea as
// _agentChildSig: re-render an entry's DOM only when its content/flags change.
function _delegateEntrySig(entry) {
  const text = String(entry?.text || '')
  return `${entry?.phase || ''}#${entry?.isError ? 1 : 0}#${entry?.toolName || ''}#${text.length}#${text.slice(-24)}`
}

// Standalone "委派过程" fallback card (used when a delegate run can't be nested
// into the leader's delegate_task agent-group — old gateway w/o goal, ambiguous
// match, or non-webchat parent). Incremental, mirroring _renderAgentGroup: the
// first call builds the structure; later calls (every streaming frame) patch
// only the title/status and the changed/new children via a per-index signature
// diff. The previous implementation rebuilt the whole card (el.innerHTML='')
// every frame, destroying+recreating every tool card — the flicker this fixes.
function _renderDelegateProgress(el, msg) {
  const collapsed = _resolveAgentGroupCollapsed(msg)
  const wantTitle = `委派过程: ${msg.agentId || 'agent'}`
  const statusHtml = msg.error
    ? '<span style="color:var(--danger)">失败</span>'
    : msg._completed
      ? '<span style="color:var(--success)">完成</span>'
      : '运行中…'

  if (!el._delegateProgressInit) {
    // ── First build: full structure (one-time) ──
    el.innerHTML = ''
    el.className = 'agent-group delegate-progress'
    const header = document.createElement('div')
    header.className = 'agent-group-header'
    header.innerHTML = `${_SVG_BOT_AGENT}<span class="agent-group-title"></span><span class="agent-group-status"></span>${_SVG_CHEVRON_AGENT}`
    // 折叠语义与子任务卡(agent-group)统一:运行中展开看实时进度、完成自动折叠,
    // 用户手动 toggle 后永久尊重其选择(_userCollapsed)。
    makeDisclosure(header, el, {
      onToggle: () => {
        msg._userCollapsed = !el.classList.contains('collapsed')
        el.classList.toggle('collapsed', msg._userCollapsed)
      },
    })
    el.appendChild(header)
    const body = document.createElement('div')
    body.className = 'agent-group-body'
    el.appendChild(body)
    el._delegateProgressHeader = header
    el._delegateProgressBody = body
    el._childEls = [] // item index → mounted DOM node (or null)
    el._childSigs = [] // item index → last render signature
    el._delegateProgressInit = true
  }

  el.classList.toggle('collapsed', collapsed)
  el.classList.toggle('error', !!msg.error)

  const titleSpan = el._delegateProgressHeader.querySelector('.agent-group-title')
  if (titleSpan && titleSpan.textContent !== wantTitle) titleSpan.textContent = wantTitle
  const statusSpan = el._delegateProgressHeader.querySelector('.agent-group-status')
  if (statusSpan && statusSpan._html !== statusHtml) {
    statusSpan.innerHTML = statusHtml
    statusSpan._html = statusHtml
  }

  // Unify both render modes into one ordered item list so a single per-index
  // diff covers them: rich passthrough (childBlocks) takes priority; the legacy
  // entries view is the fallback for old in-container gateways. A trailing
  // summary item, or an empty-state placeholder when there's nothing yet.
  const childBlocks = Array.isArray(msg.childBlocks) ? msg.childBlocks : []
  const entries = Array.isArray(msg.entries) ? msg.entries : []
  const items = []
  if (childBlocks.length > 0) {
    for (const ch of childBlocks) {
      items.push({ sig: `c:${_agentChildSig(ch)}`, build: () => _buildAgentChildNode(ch) })
    }
  } else {
    for (const entry of entries) {
      items.push({ sig: `e:${_delegateEntrySig(entry)}`, build: () => _buildDelegateEntryNode(entry) })
    }
  }
  if (msg.summary) {
    const summary = String(msg.summary)
    items.push({
      sig: `s:${summary.length}#${summary.slice(-24)}`,
      build: () => {
        const preview = document.createElement('div')
        preview.className = 'agent-group-result'
        preview.textContent = summary
        return preview
      },
    })
  }
  if (items.length === 0) {
    items.push({
      sig: 'empty',
      build: () => {
        const empty = document.createElement('div')
        empty.className = 'agent-group-empty'
        empty.textContent = '等待子 agent 输出…'
        return empty
      },
    })
  }

  // ── Per-index diff: only changed/new items touch the DOM. ──
  const body = el._delegateProgressBody
  for (let i = 0; i < items.length; i++) {
    const sig = items[i].sig
    if (el._childEls[i] !== undefined && el._childSigs[i] === sig) continue
    const node = items[i].build()
    const prev = el._childEls[i]
    if (prev) {
      if (node) body.replaceChild(node, prev)
      else body.removeChild(prev)
    } else if (node) {
      // prev is null/undefined (a previously empty slot, e.g. a legacy `entries`
      // item that built to null and later got content, or a brand-new index).
      // Insert before the NEXT already-mounted sibling so order is preserved
      // even when earlier slots are null — a plain appendChild would land the
      // node at the tail and misorder once entries shift under the 120 cap.
      let ref = null
      for (let j = i + 1; j < el._childEls.length; j++) {
        if (el._childEls[j]) {
          ref = el._childEls[j]
          break
        }
      }
      body.insertBefore(node, ref)
    }
    el._childEls[i] = node || null
    el._childSigs[i] = sig
  }
  // Drop trailing nodes left over from a previous, longer render (entries
  // trimmed at the 120 cap, or the empty placeholder superseded by real items).
  for (let i = el._childEls.length - 1; i >= items.length; i--) {
    const prev = el._childEls[i]
    if (prev) body.removeChild(prev)
    el._childEls.pop()
    el._childSigs.pop()
  }

  // Idempotent: creates the .msg-time on first render, updates it in place on
  // later frames (ts → completedAt). _appendMsgTime is NOT idempotent, so it
  // must not be called per-frame here (it would stack duplicate timestamps).
  _refreshMsgTime(el, msg)
}

function _buildToolCard(el, msg) {
  const name = msg.toolName || 'unknown'
  // `input` is computed before `_toolMeta` so codex mcpToolCall /
  // dynamicToolCall can unwrap the inner server/tool and surface the
  // matching native MCP icon+label instead of the generic gear card.
  const input = _safeInput(msg)
  const meta = _toolMeta(name, input)
  const completed = msg._completed
  const isError = msg.error
  const isRunning = !completed && !isError

  el.classList.add('tool-card')
  el.classList.toggle('tool-running', isRunning)
  el.classList.toggle('tool-error', !!isError)
  el.classList.toggle('tool-done', !!completed && !isError)

  // ── Header ──
  const header = document.createElement('div')
  header.className = 'tool-card-header'
  const headerLeft = document.createElement('div')
  headerLeft.className = 'tool-card-header-left'
  headerLeft.innerHTML = `<span class="tool-card-icon">${meta.icon}</span><span class="tool-card-label">${htmlSafeEscape(meta.label)}</span>`

  // Summary info in header (file path, command preview, etc.)
  const summary = _toolSummary(name, input, msg)
  if (summary) {
    const sumEl = document.createElement('span')
    sumEl.className = 'tool-card-summary'
    sumEl.textContent = summary
    headerLeft.appendChild(sumEl)
  }
  header.appendChild(headerLeft)

  // Status badge
  const badge = document.createElement('span')
  badge.className = 'tool-card-badge'
  if (isRunning) {
    badge.innerHTML = '<span class="tool-spinner"></span>'
  } else if (isError) {
    badge.textContent = '失败'
    badge.classList.add('badge-error')
  } else {
    badge.textContent = '✓'
    badge.classList.add('badge-done')
  }
  header.appendChild(badge)
  makeDisclosure(header, el)
  el.appendChild(header)

  // ── Body (collapsible) ──
  const body = document.createElement('div')
  body.className = 'tool-card-body'
  _renderToolBody(body, name, input, msg)
  el.appendChild(body)
}

function _renderToolBody(body, name, input, msg) {
  switch (name) {
    case 'Bash': return _renderBash(body, input, msg)
    case 'Edit': return _renderEdit(body, input, msg)
    case 'Read': return _renderRead(body, input, msg)
    case 'Write': return _renderWrite(body, input, msg)
    case 'Grep': return _renderGrep(body, input, msg)
    case 'Glob': return _renderGlob(body, input, msg)
    case 'TodoWrite': return _renderTodoWrite(body, input, msg)
    case 'WebFetch': return _renderWebFetch(body, input, msg)
    case 'WebSearch': return _renderWebSearch(body, input, msg)
  }
  const codexType = _parseCodexTypeName(name)
  if (codexType) return _renderCodexItem(body, codexType, input, msg)
  const mcp = _parseMcpName(name)
  if (mcp) {
    if (mcp.server === 'browser') return _renderBrowser(body, mcp.op, input, msg)
    if (mcp.server === 'minimax-media') return _renderMedia(body, mcp.op, input, msg)
    if (mcp.server === 'minimax-vision') return _renderVision(body, mcp.op, input, msg)
    if (mcp.server === 'openclaude-memory') return _renderMemory(body, mcp.op, input, msg)
    if (mcp.server === 'scansci-pdf') return _renderScanSci(body, mcp.op, input, msg)
  }
  return _renderGeneric(body, input, msg)
}

function _toolSummary(name, input, msg) {
  if (!input) return ''
  switch (name) {
    case 'Bash': return (input.description || (input.command || '').split('\n')[0]).slice(0, 60)
    case 'Edit': return _shortPath(input.file_path)
    case 'Read': return _shortPath(input.file_path)
    case 'Write': return _shortPath(input.file_path)
    case 'Grep': return `/${input.pattern || ''}/`
    case 'Glob': return input.pattern || ''
    case 'WebFetch': return (input.url || '').slice(0, 60)
    case 'WebSearch': return (input.query || '').slice(0, 60)
    case 'TodoWrite': {
      const todos = Array.isArray(input.todos) ? input.todos : []
      const done = todos.filter((t) => t && t.status === 'completed').length
      return todos.length ? `${done}/${todos.length}` : ''
    }
    case 'NotebookEdit': return _shortPath(input.notebook_path)
    case 'Task': case 'Agent': return (input.description || input.prompt || '').slice(0, 60)
    case 'Codex:multiAgent':
      return (input.description || input.codexTool || input.prompt || '').slice(0, 60)
  }
  // codex:<itemType> summaries
  const codexType = _parseCodexTypeName(name)
  if (codexType) return _codexSummary(codexType, input).slice(0, 80)
  // MCP fallback summaries
  const mcp = _parseMcpName(name)
  if (!mcp) return ''
  return _mcpSummary(mcp.server, mcp.op, input).slice(0, 80)
}

// Compact summary for codex thread items rendered as tool cards.
// Looked up from the `input` blob (which is the raw ThreadItem JSON for
// fallback emits in CodexAppServerRunner.handleItemStarted).
//
// Where the codex item wraps another tool (mcpToolCall, dynamicToolCall),
// the summary is delegated to the same `_toolSummary` / `_mcpSummary`
// helpers as native claude-code calls, so the header line reads identically
// (e.g. codex calling `browser_navigate` shows the URL, not `browser · navigate`).
// Normalize a codex plan / todo_list ThreadItem to a uniform shape so
// `_renderCodexPlan` and `_codexSummary` share one source of truth across
// codex CLI schema versions.
//
// Codex CLI schema drift (verified 2026-05-25 against codex 0.130 / 0.133):
//   - 0.125-era `plan` items carried `steps: [{ text|description, status }]`
//     with `status` ∈ {pending|in_progress|completed}
//   - 0.130+ `todo_list` items carry `items: [{ text, completed: boolean }]`
//     — no `status` enum, no in_progress mid-state
//
// We accept both spellings on input AND derive a uniform `{steps:[{text,status}]}`
// output. Status derivation:
//   - If `s.status` is a string, preserve it verbatim (old `plan` schema —
//     keeps in_progress mid-state and any custom string codex might emit).
//   - Otherwise, `s.completed === true` → 'completed'; everything else
//     (false / missing / non-bool) → 'pending'.
// We do NOT synthesize `in_progress` from "first incomplete item" or similar
// heuristics — the new schema has no reliable in_progress signal and
// guessing would mislead the UI.
export function _normalizeCodexPlanInput(input) {
  if (!input || typeof input !== 'object') return { steps: [] }
  const rawSteps = Array.isArray(input.steps)
    ? input.steps
    : Array.isArray(input.items) ? input.items : []
  const steps = []
  for (const s of rawSteps) {
    if (!s || typeof s !== 'object') continue
    const text = typeof s.text === 'string' ? s.text
      : typeof s.description === 'string' ? s.description
      : ''
    // Old codex `plan` carried `status: string` enum — preserve it verbatim
    // so in_progress survives. New `todo_list` only carries `completed: bool`
    // — map true → 'completed', false / missing → 'pending'.
    let status
    if (typeof s.status === 'string') {
      status = s.status
    } else if (s.completed === true) {
      status = 'completed'
    } else {
      status = 'pending'
    }
    steps.push({ text, status })
  }
  return { steps }
}

export function _codexSummary(codexType, input) {
  if (!input || typeof input !== 'object') return ''
  switch (codexType) {
    case 'plan':
    case 'todo_list': {
      // Align with TodoWrite summary format ("done/total") instead of the
      // old "N 步" so users see the same progress vocabulary across plan
      // sources.
      const { steps } = _normalizeCodexPlanInput(input)
      if (steps.length === 0) return ''
      const done = steps.filter((s) => s.status === 'completed').length
      return `${done}/${steps.length}`
    }
    case 'webSearch': return input.query || ''
    case 'imageView': return _shortPath(input.path || input.url || '')
    case 'imageGeneration': return input.prompt ? input.prompt.slice(0, 60) : (input.savedPath ? _shortPath(input.savedPath) : '')
    case 'mcpToolCall': {
      const { server, tool, args } = _codexResolveMcpCall(input)
      if (server && tool) {
        const s = _mcpSummary(server, tool, args)
        if (s) return s
        return `${server} · ${tool}`
      }
      return tool || server || ''
    }
    case 'dynamicToolCall': {
      const { tool, args } = _codexResolveMcpCall(input)
      if (!tool) return ''
      // builtin claude-code tool → reuse its summary (same as a direct call)
      if (_TOOL_ICONS[tool]) {
        const s = _toolSummary(tool, args, { output: '' })
        if (s) return s
      }
      // mcp__server__op shape → reuse native MCP summary
      const mcp = _parseMcpName(tool)
      if (mcp) {
        const s = _mcpSummary(mcp.server, mcp.op, args)
        if (s) return s
      }
      return tool
    }
    case 'collabAgentToolCall': {
      // Align with delegate_task / send_to_agent summary in _mcpSummary so
      // codex-spawned subagents and memory-driven delegates read the same.
      const agent = input.agentId || input.agent || input.target || ''
      const goal = input.goal || input.message || input.prompt || ''
      const tgt = agent ? `→ ${agent} ` : ''
      return `${tgt}${goal.slice(0, 60)}`
    }
    case 'contextCompaction': return ''
    case 'enteredReviewMode': case 'exitedReviewMode': return ''
  }
  return ''
}

function _mcpSummary(server, op, input) {
  if (!input) return ''
  if (server === 'browser') {
    if (op === 'browser_navigate' || op === 'browser_navigate_back') return input.url || ''
    if (op === 'browser_click' || op === 'browser_hover') return input.element || input.ref || ''
    if (op === 'browser_type' || op === 'browser_press_key') return input.text || input.key || ''
    if (op === 'browser_take_screenshot') return input.filename || ''
    if (op === 'browser_evaluate' || op === 'browser_run_code') return (input.code || input.function || '').replace(/\s+/g, ' ').slice(0, 60)
    if (op === 'browser_wait_for') return input.text || `${input.time || 0}s`
    return op
  }
  if (server === 'minimax-media') {
    if (op === 'text_to_image' || op === 'generate_video' || op === 'music_generation' || op === 'text_to_audio') {
      return (input.prompt || input.text || input.lyrics || '').slice(0, 60)
    }
    if (op === 'query_video_generation') return input.task_id || ''
    return op
  }
  if (server === 'minimax-vision') {
    if (op === 'understand_image') return (input.prompt || input.question || '').slice(0, 60)
    if (op === 'web_search') return input.query || ''
    return op
  }
  if (server === 'openclaude-memory') {
    if (op === 'memory') return `${input.op || 'read'} ${input.section || ''}`.trim()
    if (op === 'archival_add' || op === 'archival_search' || op === 'archival_delete') {
      return input.query || input.id || (input.text || '').slice(0, 50)
    }
    if (op === 'session_search') return input.query || ''
    if (op === 'create_reminder') return input.message || input.label || input.schedule || ''
    if (op === 'delegate_task' || op === 'send_to_agent') {
      const tgt = input.agentId ? `→ ${input.agentId} ` : ''
      return `${tgt}${(input.goal || input.message || input.prompt || '').slice(0, 60)}`
    }
    if (op === 'skill_view' || op === 'skill_delete' || op === 'skill_save') return input.name || ''
    return op
  }
  if (server === 'scansci-pdf') {
    if (op === 'scansci_pdf_search') return (input.query || '').slice(0, 60)
    if (op === 'scansci_pdf_batch_download') {
      const ids = Array.isArray(input.identifiers) ? input.identifiers : []
      return ids.length ? `${ids.length} 篇` : ''
    }
    if (
      op === 'scansci_pdf_download' ||
      op === 'scansci_pdf_citation' ||
      op === 'scansci_pdf_resolve_and_download'
    ) {
      return (input.identifier || input.file_path || '').slice(0, 70)
    }
    if (op === 'scansci_pdf_parse_list') return _shortPath(input.file_path)
    if (op.includes('health') || op.includes('diagnose') || op.includes('source')) return op
    if (op.includes('vpnsci')) return input.school || input.query || input.doi || ''
    return op
  }
  if (server === 'codex') {
    return (input.prompt || input.message || '').slice(0, 60)
  }
  return ''
}

// ── Bash: terminal-like card ──
function _renderBash(body, input, msg) {
  if (input?.command) {
    const cmdText = typeof input.command === 'string' ? input.command.slice(0, 2000) : ''
    const cmdBlock = document.createElement('div')
    cmdBlock.className = 'tool-terminal'
    const prompt = document.createElement('span')
    prompt.className = 'tool-terminal-prompt'
    prompt.textContent = '$ '
    const cmd = document.createElement('span')
    cmd.className = 'tool-terminal-cmd'
    cmd.textContent = cmdText
    cmdBlock.appendChild(prompt)
    cmdBlock.appendChild(cmd)
    body.appendChild(cmdBlock)
  }
  // bg-bash 的 tool_result.preview 永远只是 placeholder 文案 (CCB
  // backgroundInfo:"Command running in background with ID: …. Output is being
  // written to: …."),不是真实输出 — 后台进程的真实 stdout/stderr 走 SDK
  // bash_output_tail → tool_output_tail 帧 → msg.bashTail。原来 `if (msg.output)`
  // 优先级让 placeholder 永远遮住 bashTail,bg-bash 卡片就只显示 ID 行不见 tail。
  // 识别三种 backgroundInfo 句首(BashTool.tsx 615/613/611):显式 bg、用户手动
  // bg、assistant-mode 自动 bg。命中 → 优先 bashTail;tail 还没到再回退 placeholder。
  const isBgPlaceholder = typeof msg.output === 'string' && (
    msg.output.startsWith('Command running in background with ID:') ||
    msg.output.startsWith('Command was manually backgrounded by user with ID:') ||
    msg.output.includes('was moved to the background with ID:')
  )
  if (msg.output && !isBgPlaceholder) {
    // Final tool_result preview wins once the command finishes. The
    // streaming bashTail is hidden in this branch — the gateway-emitted
    // tool_result.preview is the canonical truncated output sent by CCB.
    const outBlock = document.createElement('pre')
    outBlock.className = 'tool-output'
    outBlock.textContent = msg.output
    body.appendChild(outBlock)
  } else if (msg.bashTail && typeof msg.bashTail.tail === 'string') {
    // Live tail snapshot from CCB's TaskOutput poller (~1 Hz). Replace
    // semantics: the snapshot already contains the latest tail window
    // (~4 KB); we render it as-is. truncatedHead === true means earlier
    // output exceeded the window and is missing, signalled with a
    // single muted prefix line.
    const outBlock = document.createElement('pre')
    outBlock.className = 'tool-output bash-tail-live'
    if (msg.bashTail.truncatedHead) {
      const note = document.createElement('div')
      note.className = 'tool-file-meta'
      const total = typeof msg.bashTail.totalBytes === 'number' ? msg.bashTail.totalBytes : 0
      note.textContent = `… (head 已截断, 共 ${total} 字节)`
      body.appendChild(note)
    }
    outBlock.textContent = msg.bashTail.tail
    body.appendChild(outBlock)
  } else if (msg.output) {
    // 兜底:bg-bash placeholder 命中、tail 还没到 (命令几乎瞬间完成 / 没产出
    // stdout / 第一个 1Hz 轮询前 detach 了),至少先把 placeholder 显示出来,
    // 避免空卡片。后续 tail 到达时 updateMessageEl 会重渲染换成 tail。
    const outBlock = document.createElement('pre')
    outBlock.className = 'tool-output'
    outBlock.textContent = msg.output
    body.appendChild(outBlock)
  }
}

// ── Edit: diff view ──
const _MAX_DIFF_LINES = 60
function _renderEdit(body, input, msg) {
  if (input?.old_string || input?.new_string) {
    const diffBlock = document.createElement('div')
    diffBlock.className = 'tool-diff'
    let lineCount = 0
    const oldStr = typeof input.old_string === 'string' ? input.old_string.slice(0, 3000) : ''
    const newStr = typeof input.new_string === 'string' ? input.new_string.slice(0, 3000) : ''
    if (oldStr) {
      for (const line of oldStr.split('\n')) {
        if (++lineCount > _MAX_DIFF_LINES) break
        const el = document.createElement('div')
        el.className = 'tool-diff-del'
        el.textContent = '- ' + line
        diffBlock.appendChild(el)
      }
    }
    if (newStr) {
      for (const line of newStr.split('\n')) {
        if (++lineCount > _MAX_DIFF_LINES) break
        const el = document.createElement('div')
        el.className = 'tool-diff-add'
        el.textContent = '+ ' + line
        diffBlock.appendChild(el)
      }
    }
    if (lineCount > _MAX_DIFF_LINES) {
      const more = document.createElement('div')
      more.className = 'tool-file-meta'
      more.textContent = '… (diff 过长，已截断)'
      diffBlock.appendChild(more)
    }
    body.appendChild(diffBlock)
  }
  if (msg.output && !msg.error) {
    const status = document.createElement('div')
    status.className = 'tool-status-ok'
    status.textContent = msg.output.slice(0, 200)
    body.appendChild(status)
  } else if (msg.output && msg.error) {
    const status = document.createElement('div')
    status.className = 'tool-status-err'
    status.textContent = msg.output.slice(0, 300)
    body.appendChild(status)
  }
}

// ── Read: file preview ──
function _renderRead(body, input, msg) {
  if (input) {
    const meta = document.createElement('div')
    meta.className = 'tool-file-meta'
    const parts = []
    if (input.offset) parts.push(`行 ${input.offset}`)
    if (input.limit) parts.push(`${input.limit} 行`)
    if (parts.length) meta.textContent = parts.join(', ')
    if (parts.length) body.appendChild(meta)
  }
  if (msg.output) {
    const pre = document.createElement('pre')
    pre.className = 'tool-output tool-file-content'
    pre.textContent = msg.output.slice(0, 2000)
    if (msg.output.length > 2000) pre.textContent += '\n…'
    body.appendChild(pre)
  }
}

// ── Write: file creation ──
function _renderWrite(body, input, msg) {
  if (input?.content) {
    const preview = document.createElement('pre')
    preview.className = 'tool-output'
    preview.textContent = input.content.slice(0, 500)
    if (input.content.length > 500) preview.textContent += '\n…'
    body.appendChild(preview)
  }
  if (msg.output) {
    const status = document.createElement('div')
    status.className = msg.error ? 'tool-status-err' : 'tool-status-ok'
    status.textContent = msg.output.slice(0, 200)
    body.appendChild(status)
  }
}

// ── Grep: search results ──
function _renderGrep(body, input, msg) {
  if (input) {
    const meta = document.createElement('div')
    meta.className = 'tool-file-meta'
    const parts = []
    if (input.path) parts.push(htmlSafeEscape(_shortPath(input.path)))
    if (input.glob) parts.push(`glob: ${htmlSafeEscape(input.glob)}`)
    if (input.output_mode) parts.push(htmlSafeEscape(input.output_mode))
    if (parts.length) { meta.innerHTML = parts.join(' &middot; '); body.appendChild(meta) }
  }
  if (msg.output) {
    const pre = document.createElement('pre')
    pre.className = 'tool-output tool-search-results'
    pre.textContent = msg.output.slice(0, 2000)
    if (msg.output.length > 2000) pre.textContent += '\n…'
    body.appendChild(pre)
  }
}

// ── Glob: file listing ──
function _renderGlob(body, input, msg) {
  if (input?.path) {
    const meta = document.createElement('div')
    meta.className = 'tool-file-meta'
    meta.textContent = _shortPath(input.path)
    body.appendChild(meta)
  }
  if (msg.output) {
    const pre = document.createElement('pre')
    pre.className = 'tool-output tool-file-list'
    pre.textContent = msg.output.slice(0, 2000)
    if (msg.output.length > 2000) pre.textContent += '\n…'
    body.appendChild(pre)
  }
}

// ── Shared helpers ──
function _isSafeHttpUrl(s) {
  return typeof s === 'string' && /^https?:\/\//i.test(s)
}

// Format a value for compact display. Arrays/objects are summarised
// rather than fully serialised to avoid quadratic stringify cost on
// streaming tool blocks that may rebuild many times.
function _formatValue(v) {
  if (v == null) return '—'
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]'
    if (v.length <= 3 && v.every((x) => x == null || typeof x !== 'object')) {
      try { return JSON.stringify(v) } catch { return `Array(${v.length})` }
    }
    return `Array(${v.length})`
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v)
    if (keys.length === 0) return '{}'
    if (keys.length <= 3 && keys.every((k) => v[k] == null || typeof v[k] !== 'object')) {
      try { return JSON.stringify(v) } catch { return `{${keys.length} 字段}` }
    }
    const head = keys.slice(0, 3).join(', ')
    return keys.length > 3 ? `{${head}, …+${keys.length - 3}}` : `{${head}}`
  }
  return String(v)
}

// Render an object as a key-value list. Long values get clamped + monospace.
function _renderKvList(parent, obj, opts) {
  const keys = Object.keys(obj || {})
  if (keys.length === 0) return
  const list = document.createElement('div')
  list.className = 'tool-kv-list'
  const skip = new Set((opts && opts.skip) || [])
  const maxValueLen = (opts && opts.maxValueLen) || 240
  for (const k of keys) {
    if (skip.has(k)) continue
    const v = obj[k]
    if (v == null || v === '') continue
    const item = document.createElement('div')
    item.className = 'tool-kv-item'
    const keyEl = document.createElement('span')
    keyEl.className = 'tool-kv-key'
    keyEl.textContent = k
    const valEl = document.createElement('span')
    valEl.className = 'tool-kv-val'
    let str = _formatValue(v)
    if (str.length > maxValueLen) str = str.slice(0, maxValueLen) + '…'
    valEl.textContent = str
    item.appendChild(keyEl)
    item.appendChild(valEl)
    list.appendChild(item)
  }
  if (list.children.length) parent.appendChild(list)
}

// Render output as text. If JSON, pretty-print; if URL, embed.
function _renderOutput(body, output, opts) {
  if (!output) return
  const max = (opts && opts.max) || 1500
  let text = String(output)
  // Try JSON pretty-print
  if (text.length < 4000 && /^\s*[\[{]/.test(text)) {
    try {
      const obj = JSON.parse(text)
      text = JSON.stringify(obj, null, 2)
    } catch {}
  }
  const pre = document.createElement('pre')
  pre.className = 'tool-output'
  if (text.length > max) {
    pre.textContent = text.slice(0, max) + '\n…'
  } else {
    pre.textContent = text
  }
  body.appendChild(pre)
}

// ── TodoWrite: checklist ──
function _renderTodoWrite(body, input, msg) {
  const todos = Array.isArray(input?.todos) ? input.todos : null
  if (!todos || todos.length === 0) {
    if (msg.output) _renderOutput(body, msg.output)
    return
  }
  const list = document.createElement('div')
  list.className = 'tool-todo-list'
  for (const t of todos) {
    if (!t || typeof t !== 'object') continue
    const row = document.createElement('div')
    const status = t.status || 'pending'
    row.className = `tool-todo-item tool-todo-${status}`
    const mark = document.createElement('span')
    mark.className = 'tool-todo-mark'
    mark.textContent = status === 'completed' ? '✓' : status === 'in_progress' ? '◐' : '○'
    const text = document.createElement('span')
    text.className = 'tool-todo-text'
    text.textContent = (status === 'in_progress' && t.activeForm) ? t.activeForm : (t.content || '')
    row.appendChild(mark)
    row.appendChild(text)
    list.appendChild(row)
  }
  body.appendChild(list)
}

// ── WebFetch: URL + prompt ──
function _renderWebFetch(body, input, msg) {
  if (input) _renderKvList(body, { url: input.url, prompt: input.prompt })
  _renderOutput(body, msg.output)
}

// ── WebSearch: query + results ──
function _renderWebSearch(body, input, msg) {
  if (input) _renderKvList(body, { query: input.query, allowed_domains: input.allowed_domains, blocked_domains: input.blocked_domains })
  _renderOutput(body, msg.output)
}

// ── MCP browser: per-op visualisation ──
function _renderBrowser(body, op, input, msg) {
  if (op === 'browser_navigate' && input?.url) {
    const url = String(input.url)
    let card
    if (_isSafeHttpUrl(url)) {
      card = document.createElement('a')
      card.href = url
      card.target = '_blank'
      card.rel = 'noopener noreferrer'
    } else {
      // Reject non-http(s) URLs (e.g. javascript:) — render as plain text only.
      card = document.createElement('div')
    }
    card.className = 'tool-url-card'
    card.textContent = url
    body.appendChild(card)
  } else if (op === 'browser_evaluate' || op === 'browser_run_code') {
    const code = input?.code || input?.function || ''
    if (code) {
      const block = document.createElement('pre')
      block.className = 'tool-output tool-code-block'
      block.textContent = String(code).slice(0, 1500)
      body.appendChild(block)
    }
  } else if (input) {
    _renderKvList(body, input, { skip: ['_meta'] })
  }
  _renderOutput(body, msg.output)
}

// ── MCP minimax-media: prompt + parameters ──
function _renderMedia(body, op, input, msg) {
  if (input) {
    const promptKeys = ['prompt', 'text', 'lyrics', 'first_frame_image', 'last_frame_image', 'subject_reference']
    const promptVal = promptKeys.map((k) => input[k]).find((v) => typeof v === 'string' && v)
    if (promptVal) {
      const p = document.createElement('div')
      p.className = 'tool-prompt'
      p.textContent = promptVal
      body.appendChild(p)
    }
    _renderKvList(body, input, { skip: ['prompt', 'text', 'lyrics', 'output_directory'] })
  }
  _renderOutput(body, msg.output)
}

// ── MCP minimax-vision: prompt + image ──
function _renderVision(body, op, input, msg) {
  if (input) {
    const promptVal = input.prompt || input.question || input.query || ''
    if (promptVal) {
      const p = document.createElement('div')
      p.className = 'tool-prompt'
      p.textContent = promptVal
      body.appendChild(p)
    }
    _renderKvList(body, input, { skip: ['prompt', 'question', 'query'] })
  }
  _renderOutput(body, msg.output)
}

// ── MCP openclaude-memory: per-op formatting ──
function _renderMemory(body, op, input, msg) {
  if (input) {
    if (op === 'memory') {
      _renderKvList(body, { op: input.op, section: input.section, content: input.content })
    } else if (op === 'create_reminder') {
      _renderKvList(body, { schedule: input.schedule, message: input.message, label: input.label, oneshot: input.oneshot, deliver: input.deliver })
    } else if (op === 'delegate_task' || op === 'send_to_agent') {
      _renderKvList(body, {
        agent: input.agentId,
        goal: input.goal,
        message: input.message,
        prompt: input.prompt,
        context: input.context,
      })
    } else {
      _renderKvList(body, input)
    }
  }
  _renderOutput(body, msg.output)
  _appendContextToolActions(body, op)
}

function _appendContextToolActions(body, op) {
  const actions = document.createElement('div')
  actions.className = 'context-tool-actions'
  const add = (label, fn) => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'btn btn-ghost btn-sm'
    btn.textContent = label
    btn.addEventListener('click', fn)
    actions.appendChild(btn)
  }
  if (op === 'memory' || op === 'archival_add' || op === 'archival_search' || op === 'session_search') add('打开记忆中心', () => _openMemoryModal?.())
  if (op === 'skill_list' || op === 'skill_view' || op === 'skill_save' || op === 'skill_delete' || op === 'skill_search') add('打开技能库', () => _openSkillsModal?.())
  if (op === 'create_reminder') add('查看定时任务', () => _openTasksModal?.())
  if (actions.children.length > 0) body.appendChild(actions)
}

function _parseToolJson(output) {
  if (!output) return null
  if (typeof output === 'object') return output
  const text = String(output).trim()
  if (!text || !/^[\[{]/.test(text)) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function _findPdfPath(v) {
  if (typeof v === 'string') {
    const m = v.match(/\/[^\s"'<>]+\.pdf\b/i)
    return m ? m[0] : ''
  }
  if (Array.isArray(v)) {
    for (const x of v) {
      const p = _findPdfPath(x)
      if (p) return p
    }
    return ''
  }
  if (v && typeof v === 'object') {
    for (const key of ['file', 'pdf', 'pdf_path', 'path', 'output_file']) {
      const p = _findPdfPath(v[key])
      if (p) return p
    }
    for (const value of Object.values(v)) {
      const p = _findPdfPath(value)
      if (p) return p
    }
  }
  return ''
}

function _scanSciResultIdentifier(r) {
  if (!r || typeof r !== 'object') return ''
  const val = r.doi || r.arxiv || r.arxiv_id || r.identifier || r.url || r.title || r.display_name
  return typeof val === 'string' ? val.trim().slice(0, 320) : ''
}

function _appendScanSciResultActions(item, r) {
  const identifier = _scanSciResultIdentifier(r)
  if (!identifier) return
  const actions = document.createElement('div')
  actions.className = 'scansci-result-actions'
  const download = document.createElement('button')
  download.type = 'button'
  download.className = 'scansci-result-action'
  download.dataset.paperChatAction = 'download'
  download.dataset.paperIdentifier = identifier
  download.textContent = '下载 PDF'
  actions.appendChild(download)

  const citation = document.createElement('button')
  citation.type = 'button'
  citation.className = 'scansci-result-action'
  citation.dataset.paperChatAction = 'citation'
  citation.dataset.paperIdentifier = identifier
  citation.textContent = '生成引用'
  actions.appendChild(citation)
  item.appendChild(actions)
}

function _renderScanSciResults(body, results) {
  if (!Array.isArray(results) || results.length === 0) return false
  const list = document.createElement('div')
  list.className = 'scansci-result-list'
  for (const r of results.slice(0, 8)) {
    if (!r || typeof r !== 'object') continue
    const item = document.createElement('div')
    item.className = 'scansci-result-item'
    const title = document.createElement('div')
    title.className = 'scansci-result-title'
    title.textContent = r.title || r.display_name || r.identifier || r.doi || 'Untitled paper'
    const meta = document.createElement('div')
    meta.className = 'scansci-result-meta'
    const authors = Array.isArray(r.authors) ? r.authors.slice(0, 3).join(', ') : r.authors
    const parts = [r.year || r.publication_year, authors, r.doi || r.arxiv || r.arxiv_id, r.source]
      .filter(Boolean)
      .map(String)
    meta.textContent = parts.join(' · ')
    item.appendChild(title)
    if (parts.length) item.appendChild(meta)
    _appendScanSciResultActions(item, r)
    list.appendChild(item)
  }
  if (list.children.length === 0) return false
  body.appendChild(list)
  return true
}

function _renderScanSciChecks(body, checks) {
  if (!checks || typeof checks !== 'object') return false
  const list = document.createElement('div')
  list.className = 'scansci-check-grid'
  for (const [name, info] of Object.entries(checks).slice(0, 12)) {
    const pill = document.createElement('div')
    const status = info && typeof info === 'object' ? info.status : info
    pill.className = `scansci-check-pill ${status === 'ok' ? 'ok' : 'warn'}`
    const label = document.createElement('span')
    label.textContent = name
    const val = document.createElement('strong')
    val.textContent = status ? String(status) : '—'
    pill.appendChild(label)
    pill.appendChild(val)
    list.appendChild(pill)
  }
  if (list.children.length === 0) return false
  body.appendChild(list)
  return true
}

// ── MCP ScanSci PDF: paper-oriented rendering ──
const _SCANSCI_SENSITIVE_OPS = new Set(['scansci_pdf_config_get', 'scansci_pdf_config_set'])

function _renderScanSci(body, op, input, msg) {
  if (_SCANSCI_SENSITIVE_OPS.has(op)) {
    const status = document.createElement('div')
    status.className = 'tool-status-ok'
    status.textContent = '配置类工具已执行；为保护机构登录、代理、Cookie 或 Token 等敏感信息，参数与输出已隐藏。'
    body.appendChild(status)
    return
  }

  if (input) {
    const promptVal = input.identifier || input.query || input.file_path || ''
    if (promptVal) {
      const p = document.createElement('div')
      p.className = 'tool-prompt'
      p.textContent = String(promptVal)
      body.appendChild(p)
    }
    _renderKvList(body, input, { skip: ['identifier', 'query', 'file_path'] })
  }

  const data = _parseToolJson(msg.output)
  if (!data || typeof data !== 'object') {
    _renderOutput(body, msg.output)
    return
  }

  const renderedResults = _renderScanSciResults(body, data.results || data.items)
  if (renderedResults && op === 'scansci_pdf_search') return

  const statusText = data.success === true
    ? '完成'
    : data.success === false
      ? (data.error || '失败')
      : data.overall || data.status || ''
  if (statusText) {
    const status = document.createElement('div')
    status.className = data.success === false ? 'tool-status-err' : 'tool-status-ok'
    status.textContent = String(statusText).slice(0, 200)
    body.appendChild(status)
  }

  const pdfPath = _findPdfPath(data)
  if (pdfPath) {
    const file = document.createElement('div')
    file.className = 'scansci-file-card'
    file.innerHTML = _renderLocalMedia(pdfPath)
    body.appendChild(file)
  }

  if (data.citation) {
    const cite = document.createElement('pre')
    cite.className = 'tool-output scansci-citation'
    cite.textContent = String(data.citation).slice(0, 2000)
    body.appendChild(cite)
  }

  if (_renderScanSciChecks(body, data.checks)) return

  _renderKvList(body, {
    title: data.title,
    doi: data.doi,
    source: data.source,
    file: data.file || data.pdf_path || data.path,
    strategy: data.strategy,
    batch: data.batch_id,
  })

  if (!pdfPath && !data.citation) _renderOutput(body, msg.output, { max: 900 })
}

// ── Generic fallback: key-value list (no raw JSON dump) ──
function _renderGeneric(body, input, msg) {
  if (input && typeof input === 'object') _renderKvList(body, input)
  _renderOutput(body, msg.output)
}

// ── codex thread items: per-type body renderer ──
//
// `input` is the raw ThreadItem JSON the gateway forwarded as the tool_use
// `input` field (CodexAppServerRunner.emitAssistantToolUse passes the
// item object directly, so e.g. for `webSearch` you get { id, type,
// query, results? }). msg.output is the JSON-stringified item from the
// generic completion path in handleItemCompleted (used as a result
// fallback when no specialized handler emitted a richer tool_result).
function _renderCodexItem(body, codexType, input, msg) {
  if (!input || typeof input !== 'object') {
    _renderOutput(body, msg.output)
    return
  }
  switch (codexType) {
    case 'plan':
    case 'todo_list': return _renderCodexPlan(body, input, msg)
    case 'webSearch': return _renderCodexWebSearch(body, input, msg)
    case 'imageGeneration': return _renderCodexImageGeneration(body, input, msg)
    case 'imageView': return _renderCodexImageView(body, input, msg)
    case 'mcpToolCall': return _renderCodexMcpToolCall(body, input, msg)
    case 'dynamicToolCall': return _renderCodexDynamicToolCall(body, input, msg)
    case 'collabAgentToolCall': return _renderCodexCollabAgent(body, input, msg)
    case 'contextCompaction': return _renderCodexContextCompaction(body, input, msg)
    case 'enteredReviewMode':
    case 'exitedReviewMode': return _renderCodexReviewMode(body, codexType, input, msg)
  }
  // Unknown codex type — clean kv-list, never raw JSON dump.
  _renderKvList(body, input, { skip: ['id', 'type'] })
  _renderOutput(body, msg.output)
}

function _renderCodexPlan(body, input, msg) {
  // Both `plan` (older codex) and `todo_list` (codex 0.130+) feed in here
  // via `_renderCodexItem` switch fall-through. Normalizer collapses the two
  // schemas into `{steps:[{text, status}]}`.
  const { steps } = _normalizeCodexPlanInput(input)
  if (steps.length === 0) {
    _renderKvList(body, input, { skip: ['id', 'type'] })
    _renderOutput(body, msg.output)
    return
  }
  const list = document.createElement('div')
  list.className = 'tool-todo-list'
  for (const s of steps) {
    const row = document.createElement('div')
    const status = s.status
    row.className = `tool-todo-item tool-todo-${status}`
    const mark = document.createElement('span')
    mark.className = 'tool-todo-mark'
    mark.textContent = status === 'completed' ? '✓' : status === 'in_progress' ? '◐' : '○'
    const text = document.createElement('span')
    text.className = 'tool-todo-text'
    text.textContent = s.text
    row.appendChild(mark)
    row.appendChild(text)
    list.appendChild(row)
  }
  body.appendChild(list)
}

function _renderCodexWebSearch(body, input, msg) {
  if (input.query) {
    const p = document.createElement('div')
    p.className = 'tool-prompt'
    p.textContent = input.query
    body.appendChild(p)
  }
  // Some codex builds attach results inline; render as compact list when present.
  const results = Array.isArray(input.results) ? input.results : null
  if (results && results.length > 0) {
    const list = document.createElement('div')
    list.className = 'tool-kv-list'
    for (const r of results.slice(0, 8)) {
      if (!r || typeof r !== 'object') continue
      const item = document.createElement('div')
      item.className = 'tool-kv-item'
      const titleEl = document.createElement('span')
      titleEl.className = 'tool-kv-key'
      titleEl.textContent = (r.title || r.url || '').slice(0, 80)
      const urlEl = document.createElement('span')
      urlEl.className = 'tool-kv-val'
      urlEl.textContent = r.url || ''
      item.appendChild(titleEl)
      item.appendChild(urlEl)
      list.appendChild(item)
    }
    if (list.children.length) body.appendChild(list)
  }
  _renderOutput(body, msg.output)
}

function _renderCodexImageGeneration(body, input, msg) {
  if (input.prompt) {
    const p = document.createElement('div')
    p.className = 'tool-prompt'
    p.textContent = input.prompt
    body.appendChild(p)
  }
  if (input.savedPath) {
    const meta = document.createElement('div')
    meta.className = 'tool-file-meta'
    meta.textContent = _shortPath(input.savedPath)
    body.appendChild(meta)
  }
  _renderOutput(body, msg.output)
}

function _renderCodexImageView(body, input, msg) {
  const target = input.path || input.url || ''
  if (target) {
    const meta = document.createElement('div')
    meta.className = 'tool-file-meta'
    meta.textContent = _shortPath(target)
    body.appendChild(meta)
  }
  _renderOutput(body, msg.output)
}

// Normalise a non-dict `rawArgs` payload into a displayable string for the
// fallback kv renderer. Returns `''` (falsy) when there's nothing worth
// surfacing — caller then collapses to a `{server, tool}`-only card.
// Cases (codex review v3 — array/object rawArgs coverage):
//   - string: return as-is (already display-ready)
//   - array / non-dict object: JSON.stringify so user sees the structure
//   - primitive (number/bool): String() coerce
//   - null/undefined or empty container: return ''
export function _codexRawArgsDisplay(rawArgs) {
  if (rawArgs == null) return ''
  if (typeof rawArgs === 'string') return rawArgs
  if (Array.isArray(rawArgs)) {
    if (rawArgs.length === 0) return ''
    try { return JSON.stringify(rawArgs) } catch { return '' }
  }
  if (typeof rawArgs === 'object') {
    // Object that wasn't a plain dict (the resolver consumed plain dicts into
    // `args` already), e.g. Date / Map / class instance — best effort stringify.
    try {
      const s = JSON.stringify(rawArgs)
      return s && s !== '{}' ? s : ''
    } catch { return '' }
  }
  return String(rawArgs)
}

// Codex's mcpToolCall wraps a call into a registered MCP server. We unwrap
// `{server, tool, args}` and hand off to the native MCP body renderers
// (`_renderBrowser` / `_renderMedia` / `_renderVision` / `_renderMemory`)
// so the card looks identical to a direct claude-code MCP call on the same
// server. Unknown servers fall back to a clean kv list.
function _renderCodexMcpToolCall(body, input, msg) {
  const { server, tool, args, rawArgs } = _codexResolveMcpCall(input)
  if (server && tool) {
    if (server === 'browser') return _renderBrowser(body, tool, args, msg)
    if (server === 'minimax-media') return _renderMedia(body, tool, args, msg)
    if (server === 'minimax-vision') return _renderVision(body, tool, args, msg)
    if (server === 'openclaude-memory') return _renderMemory(body, tool, args, msg)
    if (server === 'scansci-pdf') return _renderScanSci(body, tool, args, msg)
  }
  // Unknown server (custom user MCP) — render the args dict directly so the
  // user still sees structured info, not raw JSON.
  if (args && typeof args === 'object' && Object.keys(args).length > 0) {
    _renderKvList(body, args, { maxValueLen: 300 })
  } else {
    const display = _codexRawArgsDisplay(rawArgs)
    if (display) {
      // Custom MCP that ships non-dict args (free-form text, array, primitive)
      // — show the original payload so the user isn't staring at an empty card.
      _renderKvList(body, { server, tool, args: display }, { maxValueLen: 300 })
    } else if (server || tool) {
      _renderKvList(body, { server, tool }, { maxValueLen: 300 })
    }
  }
  _renderOutput(body, msg.output)
}

// Codex's dynamicToolCall is a registered-by-name tool dispatch. When the
// inner name matches a claude-code builtin (Bash/Read/Edit/Grep/...) or a
// `mcp__server__op` MCP shape, recurse into the same body renderer the
// builtin/MCP path would use, so the card is visually indistinguishable
// from a direct claude-code call.
function _renderCodexDynamicToolCall(body, input, msg) {
  const { tool, args, rawArgs } = _codexResolveMcpCall(input)
  if (tool) {
    // builtin claude-code tool — recurse into the dispatch table so the
    // body looks identical to a direct Bash/Read/Edit call.
    if (_TOOL_ICONS[tool]) {
      return _renderToolBody(body, tool, args, msg)
    }
    // mcp__server__op — dispatch like a direct MCP call
    const mcp = _parseMcpName(tool)
    if (mcp) {
      if (mcp.server === 'browser') return _renderBrowser(body, mcp.op, args, msg)
      if (mcp.server === 'minimax-media') return _renderMedia(body, mcp.op, args, msg)
      if (mcp.server === 'minimax-vision') return _renderVision(body, mcp.op, args, msg)
      if (mcp.server === 'openclaude-memory') return _renderMemory(body, mcp.op, args, msg)
      if (mcp.server === 'scansci-pdf') return _renderScanSci(body, mcp.op, args, msg)
    }
  }
  // Unknown tool — kv list fallback.
  if (args && typeof args === 'object' && Object.keys(args).length > 0) {
    _renderKvList(body, args, { maxValueLen: 300 })
  } else {
    const display = _codexRawArgsDisplay(rawArgs)
    if (display) {
      // args got coerced to {} because rawArgs wasn't a dict (free-form text,
      // array, primitive). Show the original payload so the user isn't
      // staring at an empty card — codex review CONCERN #3.
      _renderKvList(body, { tool: tool || '(unknown)', args: display }, { maxValueLen: 300 })
    } else if (tool) {
      _renderKvList(body, { tool }, { maxValueLen: 300 })
    }
  }
  _renderOutput(body, msg.output)
}

function _renderCodexCollabAgent(body, input, msg) {
  const kv = {
    agent: input.agentId || input.agent || input.target,
    goal: input.goal || input.prompt || input.message,
    context: input.context,
  }
  _renderKvList(body, kv, { maxValueLen: 300 })
  _renderOutput(body, msg.output)
}

function _renderCodexContextCompaction(body, input, msg) {
  const kv = {
    'tokens before': input.tokensBefore ?? input.beforeTokens,
    'tokens after': input.tokensAfter ?? input.afterTokens,
    note: input.note || input.summary,
  }
  _renderKvList(body, kv)
  _renderOutput(body, msg.output)
}

function _renderCodexReviewMode(body, codexType, input, msg) {
  const note = document.createElement('div')
  note.className = 'tool-status-ok'
  note.textContent = codexType === 'enteredReviewMode' ? '已进入审阅模式' : '已退出审阅模式'
  body.appendChild(note)
  if (input.note || input.summary) {
    const p = document.createElement('div')
    p.className = 'tool-prompt'
    p.textContent = input.note || input.summary
    body.appendChild(p)
  }
  _renderOutput(body, msg.output)
}

// ── Truncated assistant message banner ──
//
// Show a "继续" affordance when the model stopped mid-answer (max_tokens /
// pause_turn). websocket.js stamps `msg._truncated = '<reason>'` on the
// streaming assistant before final render. This helper is idempotent: it
// adds, refreshes, or removes the banner so it stays in sync if the message
// state changes (e.g. on regen the new reply may not be truncated).
//
// Click handler programmatically drives the existing send pipeline by
// stuffing a canned "续写" prompt into #input and clicking #send. We don't
// import send() from main.js — the textarea/button fire path keeps state
// (effort pill, attachments, autosize) consistent with a normal user send.
function _applyTruncatedBanner(el, msg) {
  const reason = msg && msg._truncated
  let banner = el.querySelector(':scope > .msg-truncated-banner')
  if (!reason) {
    if (banner) banner.remove()
    return
  }
  if (!banner) {
    banner = document.createElement('div')
    banner.className = 'msg-truncated-banner'
    // Insert AFTER msg-body so it sits between body and actions/meta.
    const body = el.querySelector(':scope > .msg-body')
    if (body && body.nextSibling) el.insertBefore(banner, body.nextSibling)
    else el.appendChild(banner)
  }
  const reasonText =
    reason === 'max_tokens'
      ? '本轮输出达到 token 上限,内容可能不完整。'
      : reason === 'pause_turn'
        ? '模型暂停了本轮(通常因长任务超时),可让它继续。'
        : '本轮输出未完成。'
  banner.innerHTML = ''
  const note = document.createElement('span')
  note.className = 'msg-truncated-note'
  note.textContent = reasonText
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'msg-continue-btn'
  btn.textContent = '继续'
  btn.title = '让模型从上面被截断的位置接着写'
  btn.addEventListener('click', () => {
    const ta = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('input'))
    const sendBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('send'))
    if (!ta || !sendBtn) return
    // 续写文案保持中性、不绑定特定话题,避免触发模型重新做总结。
    const prompt = '请接着上一条回复被截断的位置继续完成,不要重复已写过的内容,直接续写。'
    const existingDraft = ta.value.trim()
    const hasAttachments =
      Array.isArray(state.attachments) && state.attachments.length > 0
    if (existingDraft || hasAttachments) {
      // 用户已有草稿 / 已选附件:不能直接 send 把它们和"续写"混在一起 ——
      // 把 prompt 追加到末尾,光标置末,等用户 review 后自己按 Enter。
      ta.value = existingDraft ? `${existingDraft}\n\n${prompt}` : prompt
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      ta.focus()
      ta.setSelectionRange(ta.value.length, ta.value.length)
      return
    }
    // textarea 空、无附件 — 一键续写,直接发送,不打扰用户。
    ta.value = prompt
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    sendBtn.click()
  })
  banner.appendChild(note)
  banner.appendChild(btn)
}

function _planStatusLabel(status) {
  if (status === 'completed') return '完成'
  if (status === 'inProgress' || status === 'in_progress') return '进行中'
  return '待处理'
}

function _renderPlanMarkdownInto(el, text, streaming = false) {
  el.innerHTML = streaming ? renderStreamingMarkdown(text || '') : renderMarkdown(text || '')
  el.style.whiteSpace = ''
}

function _buildPlanCard(el, msg) {
  const header = document.createElement('div')
  header.className = 'plan-card-header'
  const title = document.createElement('div')
  title.className = 'plan-card-title'
  title.textContent = '计划表'
  const stateEl = document.createElement('div')
  stateEl.className = 'plan-card-state'
  stateEl.textContent = msg._partial ? '生成中' : '待确认'
  header.appendChild(title)
  header.appendChild(stateEl)
  el.appendChild(header)

  const body = document.createElement('div')
  body.className = 'plan-card-body'
  if (msg.text) {
    const draft = document.createElement('div')
    draft.className = 'plan-card-draft'
    _renderPlanMarkdownInto(draft, msg.text, !!msg._partial)
    body.appendChild(draft)
  } else if (msg.explanation) {
    const explanation = document.createElement('div')
    explanation.className = 'plan-card-explanation'
    _renderPlanMarkdownInto(explanation, msg.explanation, !!msg._partial)
    body.appendChild(explanation)
  }
  if (!msg.text && Array.isArray(msg.steps) && msg.steps.length > 0) {
    const steps = document.createElement('div')
    steps.className = 'plan-steps'
    for (const s of msg.steps) {
      const row = document.createElement('div')
      row.className = 'plan-step'
      const status = document.createElement('div')
      status.className = `plan-step-status ${s.status || 'pending'}`
      status.textContent = _planStatusLabel(s.status)
      const text = document.createElement('div')
      text.className = 'plan-step-text'
      text.textContent = s.step || ''
      row.appendChild(status)
      row.appendChild(text)
      steps.appendChild(row)
    }
    body.appendChild(steps)
  }
  el.appendChild(body)

  if (!msg._partial) {
    const actions = document.createElement('div')
    actions.className = 'plan-card-actions'
    const run = document.createElement('button')
    run.type = 'button'
    run.className = 'plan-run-btn'
    run.textContent = '开始实施'
    run.onclick = () => {
      requestDefaultNextSubmit()
      const input = document.getElementById('input')
      const sendBtn = document.getElementById('send')
      if (input) input.value = '按上面的计划开始实施。'
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      sendBtn?.click()
    }
    actions.appendChild(run)
    el.appendChild(actions)
  }
  _appendMsgTime(el, msg.completedAt || msg.ts)
}

function _goalStatusLabel(status) {
  switch (status) {
    case 'active':
      return '进行中'
    case 'paused':
      return '已暂停'
    case 'blocked':
      return '阻塞'
    case 'usageLimited':
      return '用量受限'
    case 'budgetLimited':
      return '预算受限'
    case 'complete':
      return '完成'
    default:
      return status || '未设置'
  }
}

function _formatGoalDuration(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return ''
  if (seconds < 60) return `${Math.round(seconds)}s`
  const mins = Math.floor(seconds / 60)
  const secs = Math.round(seconds % 60)
  if (mins < 60) return secs ? `${mins}m ${secs}s` : `${mins}m`
  const hours = Math.floor(mins / 60)
  const rem = mins % 60
  return rem ? `${hours}h ${rem}m` : `${hours}h`
}

function _buildGoalCard(el, msg) {
  el.innerHTML = ''
  el.className = 'msg goal'
  if (msg.error) el.classList.add('error')
  el.dataset.msgId = msg.id

  const header = document.createElement('div')
  header.className = 'goal-card-header'
  const title = document.createElement('div')
  title.className = 'goal-card-title'
  title.textContent = '目标'
  const state = document.createElement('div')
  state.className = `goal-card-state ${msg.status || ''}`
  state.textContent = msg.cleared ? '已清除' : _goalStatusLabel(msg.status)
  header.appendChild(title)
  header.appendChild(state)
  el.appendChild(header)

  const body = document.createElement('div')
  body.className = 'goal-card-body'
  const objective = document.createElement('div')
  objective.className = 'goal-card-objective'
  objective.textContent = msg.cleared
    ? '当前 Codex goal 已清除。'
    : msg.text || 'Codex goal 已更新。'
  body.appendChild(objective)

  const meta = document.createElement('div')
  meta.className = 'goal-card-meta'
  if (typeof msg.tokensUsed === 'number') {
    const token = document.createElement('span')
    token.textContent =
      typeof msg.tokenBudget === 'number'
        ? `Tokens ${msg.tokensUsed}/${msg.tokenBudget}`
        : `Tokens ${msg.tokensUsed}`
    meta.appendChild(token)
  }
  const duration = _formatGoalDuration(msg.timeUsedSeconds)
  if (duration) {
    const dur = document.createElement('span')
    dur.textContent = `用时 ${duration}`
    meta.appendChild(dur)
  }
  if (typeof msg.updatedAt === 'number' && Number.isFinite(msg.updatedAt)) {
    const updated = document.createElement('span')
    try {
      const ts = msg.updatedAt < 1000000000000 ? msg.updatedAt * 1000 : msg.updatedAt
      updated.textContent = `更新 ${new Date(ts).toLocaleTimeString('zh-CN')}`
    } catch {
      updated.textContent = ''
    }
    if (updated.textContent) meta.appendChild(updated)
  }
  if (meta.childNodes.length > 0) body.appendChild(meta)

  if (
    typeof msg.tokensUsed === 'number' &&
    typeof msg.tokenBudget === 'number' &&
    msg.tokenBudget > 0
  ) {
    const pct = Math.max(0, Math.min(100, (msg.tokensUsed / msg.tokenBudget) * 100))
    const bar = document.createElement('div')
    bar.className = 'goal-card-progress'
    const fill = document.createElement('div')
    fill.className = 'goal-card-progress-fill'
    fill.style.width = `${pct}%`
    bar.appendChild(fill)
    body.appendChild(bar)
  }

  el.appendChild(body)
  _appendMsgTime(el, msg.completedAt || msg.ts)
}

export function _buildMessageEl(msg) {
  const el = document.createElement('div')
  el.className = `msg ${msg.role}`
  if (msg.error) el.classList.add('error')
  el.dataset.msgId = msg.id
  if (msg.role === 'assistant') {
    if (msg.cronPush) {
      el.classList.add('cron-push')
    }
    const avatar = document.createElement('div')
    avatar.className = 'avatar'
    // Use agent persona emoji if available, fallback to 'O'
    const agentInfo = state.agentsList.find(
      (a) => a.id === (getSession()?.agentId || state.defaultAgentId),
    )
    avatar.textContent = agentInfo?.avatarEmoji || 'O'
    el.appendChild(avatar)
    // Cron push badge -- visually marks system-generated messages
    if (msg.cronPush) {
      const badge = document.createElement('div')
      badge.className = 'cron-push-badge'
      badge.textContent = `📋 ${msg.cronLabel || '定时任务'}`
      el.appendChild(badge)
    }
    // P1-3: 服务端归类的可识别错误 (insufficient_credits / rate_limited /
    // upstream_failed) 走独立的红色错误卡渲染,不走 markdown,也不要 regen/tts
    // 等动作 — 这些在错误状态下没有意义。保留 copy/del 让用户可以复制错误文案
    // 或清掉这条消息。
    if (msg._errorCode) {
      el.classList.add('msg-error-card')
      const card = document.createElement('div')
      card.className = 'msg-body msg-error'
      card.dataset.errorCode = msg._errorCode
      const title = document.createElement('div')
      title.className = 'msg-error-title'
      title.textContent = msg.text || '出错了'
      card.appendChild(title)
      if (msg._errorDetail) {
        const det = document.createElement('details')
        det.className = 'msg-error-detail'
        const sum = document.createElement('summary')
        sum.textContent = '查看详情'
        det.appendChild(sum)
        const pre = document.createElement('pre')
        pre.textContent = String(msg._errorDetail)
        det.appendChild(pre)
        card.appendChild(det)
      }
      if (msg._errorCode === 'insufficient_credits') {
        const cta = document.createElement('button')
        cta.className = 'msg-error-cta'
        cta.type = 'button'
        cta.textContent = '去充值'
        cta.addEventListener('click', () => {
          try {
            _openTopupModal({ force: true })
          } catch (e) {
            toast('打开充值失败', 'error')
            console.error('[msg-error-cta] _openTopupModal failed', e)
          }
        })
        card.appendChild(cta)
      }
      el.appendChild(card)
      const actErr = document.createElement('div')
      actErr.className = 'msg-actions'
      actErr.innerHTML =
        '<button data-action="copy" title="复制"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>' +
        _FEEDBACK_BTN_HTML
      actErr.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]')
        if (!btn) return
        const sess = getSession()
        if (!sess) return
        if (btn.dataset.action === 'copy') {
          const _idx = _findMsgIdx(sess, msg)
          const liveMsg = _idx >= 0 ? sess.messages[_idx] : msg
          const raw = liveMsg.text || ''
          if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(raw).catch(() => fallbackCopy(raw))
          } else fallbackCopy(raw)
          toast('已复制', 'success')
        } else if (btn.dataset.action === 'feedback') {
          // 错误消息反馈尤其有价值:带上 traceId + errorCode,admin 直接对得上日志。
          const _idx = _findMsgIdx(sess, msg)
          const liveMsg = _idx >= 0 ? sess.messages[_idx] : msg
          _openMessageFeedback?.(_buildMsgFeedbackContext(sess, liveMsg))
        }
      })
      el.appendChild(actErr)
      // 2026-06-18 — 错误卡片也渲染请求ID 芯片(若 usage.traceId 存在):错误恰是最需要
      // 反查日志的场景,芯片可点复制,与"反馈"图标互补。
      _renderReqIdInto(el, msg)
      const ts = document.createElement('div')
      ts.className = 'msg-time'
      ts.textContent = msgTimeLabel(msg.ts)
      el.appendChild(ts)
      return el
    }
    const body = document.createElement('div')
    body.className = 'msg-body'
    body.innerHTML = renderMarkdown(msg.text || '')
    el.appendChild(body)
    // ── Message action bar ──
    const actions = document.createElement('div')
    actions.className = 'msg-actions'
    actions.innerHTML =
      '<button data-action="copy" title="复制"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>' +
      '<span class="msg-save-wrap"><button data-action="save" title="保存为文件"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button></span>' +
      '<button data-action="regen" title="重新生成"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button>' +
      '<button data-action="tts" title="朗读"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg></button>' +
      _FEEDBACK_BTN_HTML
    actions.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]')
      if (!btn) return
      const action = btn.dataset.action
      const sess = getSession()
      if (!sess) return
      const _svgCopy =
        '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
      const _svgCheck =
        '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
      const _svgVol =
        '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>'
      const _svgStop =
        '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>'
      if (action === 'copy') {
        const _doCopied = () => {
          btn.classList.add('copied')
          btn.innerHTML = _svgCheck
          setTimeout(() => {
            btn.classList.remove('copied')
            btn.innerHTML = _svgCopy
          }, 1500)
        }
        const _idx = _findMsgIdx(sess, msg)
        const liveMsg = _idx >= 0 ? sess.messages[_idx] : msg
        const raw = liveMsg.text || ''
        const html = `<div style="font-family:sans-serif;line-height:1.6">${_renderCleanHtml(raw)}</div>`
        // Rich copy: HTML (for Word/Docs) + plain text (Markdown source)
        if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
          navigator.clipboard
            .write([
              new ClipboardItem({
                'text/html': new Blob([html], { type: 'text/html' }),
                'text/plain': new Blob([raw], { type: 'text/plain' }),
              }),
            ])
            .then(_doCopied)
            .catch(() => {
              // Fallback to writeText if ClipboardItem fails (e.g. Firefox)
              if (navigator.clipboard.writeText) {
                navigator.clipboard.writeText(raw).then(_doCopied).catch(() => {
                  fallbackCopy(raw)
                  _doCopied()
                })
              } else {
                fallbackCopy(raw)
                _doCopied()
              }
            })
        } else if (navigator.clipboard?.writeText) {
          navigator.clipboard
            .writeText(raw)
            .then(_doCopied)
            .catch(() => {
              fallbackCopy(raw)
              _doCopied()
            })
        } else {
          fallbackCopy(raw)
          _doCopied()
        }
      } else if (action === 'save') {
        // Toggle save-as dropdown menu
        const wrap = btn.closest('.msg-save-wrap')
        const existing = wrap.querySelector('.msg-save-menu')
        if (existing) {
          existing._ac?.abort()
          existing.remove()
          actions.classList.remove('menu-open')
          return
        }
        // Close any other open save menus — abort their listeners too
        document.querySelectorAll('.msg-save-menu').forEach((m) => {
          m._ac?.abort()
          m.remove()
        })
        document.querySelectorAll('.msg-actions.menu-open').forEach((a) => a.classList.remove('menu-open'))
        actions.classList.add('menu-open')
        const menu = document.createElement('div')
        menu.className = 'msg-save-menu'
        menu.innerHTML =
          '<button data-save="md"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> Markdown (.md)</button>' +
          '<button data-save="docx"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg> Word 文档 (.docx)</button>' +
          '<button data-save="tex"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><text x="7" y="17" font-family="Georgia,serif" font-size="8" font-weight="bold" fill="currentColor" stroke="none">TeX</text></svg> LaTeX (.tex)</button>' +
          '<button data-save="pdf"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="15" x2="15" y2="15"/></svg> 打印为 PDF</button>'
        wrap.appendChild(menu)
        const _menuAc = new AbortController()
        menu._ac = _menuAc
        menu.addEventListener(
          'click',
          (ev) => {
            ev.stopPropagation()
            const savBtn = ev.target.closest('[data-save]')
            if (!savBtn) return
            const fmt = savBtn.dataset.save
            const _idx = _findMsgIdx(sess, msg)
            const liveMsg = _idx >= 0 ? sess.messages[_idx] : msg
            const raw = liveMsg.text || ''
            if (fmt === 'md') _exportMd(raw)
            else if (fmt === 'docx') exportMessageDocx(liveMsg, { title: getSession()?.title || 'openclaude' })
            else if (fmt === 'tex') exportMessageTex(liveMsg, { title: getSession()?.title || 'openclaude' })
            else if (fmt === 'pdf') _exportPdf(raw)
            menu.remove()
            actions.classList.remove('menu-open')
            _menuAc.abort()
          },
          { signal: _menuAc.signal },
        )
        // Close on outside click — AbortController ensures cleanup on any close path
        setTimeout(() => {
          document.addEventListener(
            'click',
            (ev) => {
              // Self-cleanup if menu was removed by re-render or message deletion
              if (!menu.isConnected) {
                _menuAc.abort()
                return
              }
              if (!wrap.contains(ev.target)) {
                menu.remove()
                actions.classList.remove('menu-open')
                _menuAc.abort()
              }
            },
            { signal: _menuAc.signal },
          )
        }, 0)
      } else if (action === 'regen') {
        // Stop any in-flight turn before regenerating to avoid concurrent requests.
        if (state.sendingInFlight) {
          if (state.ws && state.ws.readyState === 1) {
            // safeWsSend:背压时 close+reconnect,stop 丢了也 OK —— server 端
            // channel cleanup 会终止 turn,比靠 stop 帧更彻底。
            safeWsSend(state.ws, JSON.stringify({
              type: 'inbound.control.stop',
              channel: 'webchat',
              peer: { id: sess.id, kind: 'dm' },
              agentId: getActiveStopAgentId(sess),
            }))
          }
          sess._sendingInFlight = false
          _clearTurnTiming?.(sess)
          // Reset reply tracker BEFORE we re-post the same user message below.
          // Regen special case: since it reuses the same boundMsg, the primary
          // stale-final guard (frame.ts < boundMsg.ts) can't distinguish the
          // aborted prior turn's late isFinal from the fresh regen turn —
          // both share the same boundMsg.ts. The fallback guard uses
          // `_trackerResetAt` set by this helper, so we must call it here;
          // otherwise a late final from the stopped turn would slip through
          // once the regen frame rebinds the tracker.
          _resetReplyTracker?.(sess)
          state.sendingInFlight = false
          _hideTypingIndicator()
          _updateSendEnabled()
          _setTitleBusy(false)
        }
        // Find the last user message before this assistant message
        const idx = _findMsgIdx(sess, msg)
        if (idx < 0) return
        let lastUserMsg = null
        for (let i = idx - 1; i >= 0; i--) {
          if (sess.messages[i].role === 'user') {
            lastUserMsg = sess.messages[i]
            break
          }
        }
        if (!lastUserMsg) {
          toast('没有找到可重发的用户消息', 'error')
          return
        }
        const _regenTeamRun = lastUserMsg._teamRun?.leaderAgentId
          ? {
              id: lastUserMsg._teamRun.id || '',
              name: lastUserMsg._teamRun.name || lastUserMsg._teamRun.id || '',
              leaderAgentId: lastUserMsg._teamRun.leaderAgentId || '',
              ...(lastUserMsg._teamRun.modelOverride !== undefined
                ? { modelOverride: lastUserMsg._teamRun.modelOverride }
                : {}),
            }
          : null
        // Remove messages from this one onwards (snapshot for restore on enqueue-full)
        const _regenSnapshot = sess.messages.slice(idx)
        sess.messages.splice(idx)
        renderMessages()
        // Re-send via proper path: build payload with original media if present
        const _regenEffort = getEffortForSubmit()
        const _regenConversationMode = getConversationModeForSubmit(
          lastUserMsg._modelText || lastUserMsg.text || '',
          lastUserMsg._media || [],
        )
        // 普通 regen 与 main.js send() 共享 model policy;团队 regen 必须复用原团队队长和原团队
        // model override,否则会从团队协作退回单 Agent/default model。
        const _regenAgentId = _regenTeamRun?.leaderAgentId || sess.agentId || state.defaultAgentId
        const _regenModelOverride = _regenTeamRun
          ? _regenTeamRun.modelOverride
          : getSingleAgentModelOverride({
              userPrefs: state.userPrefs,
              agentId: _regenAgentId,
              defaultAgentId: state.defaultAgentId,
              agentsList: state.agentsList,
            })
        const wsPayload = {
          type: 'inbound.message',
          idempotencyKey: `regen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          channel: 'webchat',
          peer: { id: sess.id, kind: 'dm' },
          agentId: _regenAgentId,
          content: {
            text: lastUserMsg._modelText || lastUserMsg.text || '',
            media: lastUserMsg._media || undefined,
          },
          // 与 main.js send() 同语义:string=切档 / null=清除 / undefined=不参与
          ...(_regenEffort !== undefined ? { effortLevel: _regenEffort } : {}),
          ...(_regenConversationMode !== undefined ? { conversationMode: _regenConversationMode } : {}),
          ...(_regenModelOverride !== undefined ? { model: _regenModelOverride } : {}),
          ts: Date.now(),
        }
        // Check if there are pending offline items for this session to prevent reordering
        const _hasQueued = (state.offlineQueue?.some(i => i.sessId === sess.id)) ||
          (state._offlineQueuePending?.some(i => i.sessId === sess.id)) ||
          (state._offlineDrainingCurrent?.sessId === sess.id)
        // 2026-04-22 Codex R1 BLOCKING#1:regen 也必须走 safeWsSend + requeue。
        let _regenSentNow = false
        if (state.ws && state.ws.readyState === 1 && !_hasQueued) {
          _regenSentNow = safeWsSend(state.ws, JSON.stringify(wsPayload))
        }
        if (_regenSentNow) {
          setActiveTeamRunForSession(sess, _regenTeamRun)
          sess._sendingInFlight = true
          // 新 turn 开始(regen 路径):清跨 turn cost-charged 归因状态。
          // 跟普通 send 路径(websocket.js:541)对齐。
          _resetTurnBillingState(sess, 'regen-start')
          // Clear any leftover regen timer from a previous regen/stop cycle
          if (sess._regenSafetyTimer) { clearTimeout(sess._regenSafetyTimer); sess._regenSafetyTimer = null }
          sess._regenSafetyTimer = setTimeout(() => {
            sess._regenSafetyTimer = null
            if (sess._sendingInFlight) {
              console.warn('[regen] Safety timeout, clearing inFlight for', sess.id)
              // Also interrupt the backend turn — safeWsSend 自含 try/close 逻辑
              if (state.ws && state.ws.readyState === 1) {
                safeWsSend(state.ws, JSON.stringify({
                  type: 'inbound.control.stop',
                  channel: 'webchat',
                  peer: { id: sess.id, kind: 'dm' },
                  agentId: getActiveStopAgentId(sess),
                }))
              }
              sess._sendingInFlight = false
              _clearTurnTiming?.(sess)
              // Abandon the reply tracker so any belated isFinal arriving for
              // this timed-out regen can't retroactively flag the user message
              // as empty or attach to the next fresh turn.
              _resetReplyTracker?.(sess)
              if (sess.id === state.currentSessionId) {
                state.sendingInFlight = false
                _updateSendEnabled()
                _hideTypingIndicator()
                _setTitleBusy(false)
              }
            }
          }, 10 * 60_000)
          state.sendingInFlight = true
          _updateSendEnabled()
          _showTypingIndicator()
          _setTitleBusy(true)
        } else {
          // Offline / 已排队 / safeWsSend 背压 close:统统 requeue 保序。
          // P2-24 软上限 — 满了直接拒,提示用户。
          const enqueued = tryEnqueueOffline({
            sessId: sess.id,
            payload: wsPayload,
            msgId: lastUserMsg.id,
            teamRun: _regenTeamRun || undefined,
          })
          if (!enqueued) {
            // P2-24 数据保护:enqueue 失败必须恢复 splice 掉的消息,否则 regen 操作
            // 既没发出去、又把会话历史搞没了。restore 后跳过 _scheduleSaveFromUserEdit
            // 避免把本次"恢复后的状态"再写入磁盘(等价于无操作,但显式更稳)。
            sess.messages.push(..._regenSnapshot)
            renderMessages()
            toast(`离线缓冲已满 (${MAX_OFFLINE_QUEUE} 条),请恢复网络后重试`, 'danger')
            return
          }
          if (!state.ws || state.ws.readyState !== 1) {
            toast('离线排队中，重连后自动重新生成')
          }
        }
        _scheduleSaveFromUserEdit(sess)
      } else if (action === 'tts-stop') {
        // Stop ongoing TTS playback
        if (window.speechSynthesis) window.speechSynthesis.cancel()
        btn.innerHTML = _svgVol
        btn.title = '朗读'
        btn.dataset.action = 'tts'
      } else if (action === 'tts') {
        // Use Web Speech API for quick read-aloud
        const _idx = _findMsgIdx(sess, msg)
        const liveMsg = _idx >= 0 ? sess.messages[_idx] : msg
        const text = (liveMsg.text || '').replace(/[#*`>_~\[\]()]/g, '').slice(0, 2000)
        if (!text) return
        if (window.speechSynthesis) {
          window.speechSynthesis.cancel()
          const utter = new SpeechSynthesisUtterance(text)
          utter.lang = 'zh-CN'
          utter.rate = 1.1
          window.speechSynthesis.speak(utter)
          btn.innerHTML = _svgStop
          btn.title = '停止朗读'
          btn.dataset.action = 'tts-stop'  // Change action to prevent re-entry from delegated handler
          utter.onend = () => {
            btn.innerHTML = _svgVol
            btn.title = '朗读'
            btn.dataset.action = 'tts'
          }
        } else {
          toast('浏览器不支持语音合成', 'error')
        }
      } else if (action === 'feedback') {
        // 2026-06-18 — 原"删除"位改为"反馈":打开反馈弹窗并带上本条消息的请求ID
        // (traceId)+ 会话/消息上下文,让用户一键就近反馈,admin 据 traceId 反查日志。
        const _idx = _findMsgIdx(sess, msg)
        const liveMsg = _idx >= 0 ? sess.messages[_idx] : msg
        _openMessageFeedback?.(_buildMsgFeedbackContext(sess, liveMsg))
      }
    })
    el.appendChild(actions)
    _applyTruncatedBanner(el, msg)
    // 2026-05-06 §4.6 改动 12 — meta 字串现算:formatMeta(msg) 读 msg.usage,
    // 替代历史 msg.metaText 字串字段。usage 字段由 server-authored merge / IDB load /
    // cost_charged broadcast 三路写入,server 是权威源(client PUT 时被 strip)。
    {
      const metaTxt = formatMeta(msg)
      if (metaTxt) {
        const meta = document.createElement('div')
        meta.className = 'msg-meta'
        renderMetaInto(meta, metaTxt)
        el.appendChild(meta)
      }
    }
    // 2026-06-18 — 响应底部请求ID 芯片(替代原 token 统计)。读 msg.usage.traceId,
    // 此处 .msg-time 尚未创建,_renderReqIdInto 会 append,随后 _appendMsgTime 接在其后。
    _renderReqIdInto(el, msg)
    // Absolute timestamp. For assistant messages we prefer `completedAt`
    // (set on final frame / when streaming hands off to a tool) so the
    // stamp reflects when the reply actually finished, not when the first
    // token arrived. Falls back to `ts` (creation) while streaming, and for
    // legacy messages that predate the completedAt field.
    _appendMsgTime(el, msg.completedAt || msg.ts)
  } else if (msg.role === 'agent-group') {
    _renderAgentGroup(el, msg)
  } else if (msg.role === 'delegate-progress') {
    _renderDelegateProgress(el, msg)
  } else if (msg.role === 'plan') {
    _buildPlanCard(el, msg)
  } else if (msg.role === 'goal') {
    _buildGoalCard(el, msg)
  } else if (msg.role === 'thinking') {
    const header = document.createElement('div')
    header.className = 'thinking-header'
    header.innerHTML = '<span class="thinking-label">💭 思考中…</span>'
    makeDisclosure(header, el)
    el.appendChild(header)
    const body = document.createElement('div')
    body.className = 'msg-body thinking-body'
    body.textContent = msg.text || ''
    el.appendChild(body)
  } else if (msg.role === 'permission') {
    _buildPermissionCard(el, msg)
  } else if (msg.role === 'tool') {
    // Detect legacy tool messages: old format stored toolName+text but no _completed flag.
    // New format always sets _completed to a boolean (false initially, true on result).
    const isLegacy = typeof msg._completed !== 'boolean'
    if (isLegacy) {
      const icon = document.createElement('span')
      icon.className = 'tool-icon-legacy'
      icon.textContent = msg.toolIcon || '🔧'
      const body = document.createElement('div')
      body.className = 'tool-body-legacy'
      body.textContent = msg.text || ''
      el.appendChild(icon)
      el.appendChild(body)
    } else {
      _buildToolCard(el, msg)
    }
  } else {
    // User messages: render with media URL embedding but XSS-safe
    const body = document.createElement('div')
    body.className = 'msg-body'
    const safeHtml = htmlSafeEscape(msg.text || '').replace(/\n/g, '<br>')
    body.innerHTML = embedMediaUrls(safeHtml)
    el.appendChild(body)
    // 2026-05-06 §4.6 改动 13 — 角标状态走派生:
    // 'sending'/'queued' 显式;'replied' 现算(后续有 server-authored completed assistant);
    // 其余('sent'/'read')沿用 msg.status。
    // 找到本 msg 在 sess.messages 里的 idx — getSession() 在当前会话渲染上下文里
    // 必命中(renderMessages / load-more 都遍历当前 session messages)。
    const sess = getSession()
    let displayStatus = null
    if (sess && Array.isArray(sess.messages)) {
      const idx = _findMsgIdx(sess, msg)
      if (idx >= 0) displayStatus = _deriveUserMsgStatus(sess.messages, idx)
    }
    if (!displayStatus) displayStatus = msg.status || null
    if (displayStatus) {
      const statusEl = document.createElement('div')
      statusEl.className = `msg-status ${displayStatus}`
      statusEl.innerHTML = `${_STATUS_SVG[displayStatus] || ''}<span>${_STATUS_LABEL[displayStatus] || ''}</span>`
      el.appendChild(statusEl)
    }
    _appendMsgTime(el, msg.ts)
  }
  return el
}

// Shared timestamp append helper. Uses textContent + title for safety and
// no-ops on falsy/invalid ts (legacy messages without a ts field render
// without this row rather than showing a blank badge). `data-ts` carries
// the exact ms epoch so _refreshMsgTime can detect same-minute updates
// (label precision is minute-level; tooltip precision is second-level).
function _appendMsgTime(el, ts) {
  const label = msgTimeLabel(ts)
  if (!label) return
  const timeEl = document.createElement('div')
  timeEl.className = 'msg-time'
  timeEl.textContent = label
  timeEl.dataset.ts = String(ts)
  // Full timestamp in title for hover inspection
  try { timeEl.title = new Date(ts).toLocaleString('zh-CN') } catch {}
  el.appendChild(timeEl)
}

// Keep the rendered msg-time in sync with the effective timestamp
// (completedAt once set, else ts). Called from updateMessageEl on every
// re-render so isFinal / tool-handoff completion flips the label from
// "first-token time" to "turn-ended time" without rebuilding the whole node.
// Uses data-ts (exact ms) rather than textContent comparison — the label
// is minute-precision, so streaming deltas within the same minute would
// otherwise leave a stale `title` tooltip pointing at the first-token time.
function _refreshMsgTime(el, msg) {
  const effectiveTs = msg.completedAt || msg.ts
  if (!effectiveTs) return
  const existing = el.querySelector(':scope > .msg-time')
  if (!existing) {
    _appendMsgTime(el, effectiveTs)
    return
  }
  if (Number(existing.dataset.ts) === effectiveTs) return
  existing.dataset.ts = String(effectiveTs)
  const label = msgTimeLabel(effectiveTs)
  if (label) existing.textContent = label
  try { existing.title = new Date(effectiveTs).toLocaleString('zh-CN') } catch {}
}

export function renderMessage(msg, skipRichBlocks = false) {
  const main = ensureInner()
  const el = _buildMessageEl(msg)
  // Register in the keyed-reconcile WeakMap so a subsequent
  // renderMessages() (e.g., after sync) sees this row as already
  // mounted and skips rebuilding it. Without this, every streaming
  // append + sync cycle would still flash on this row.
  _renderedMsgEls.set(msg, el)
  // Keep the typing indicator pinned at the bottom — if it is currently visible,
  // insert new messages above it instead of appending after it.
  const typing = main.querySelector('.typing-indicator')
  if (typing) main.insertBefore(el, typing)
  else main.appendChild(el)
  if (!skipRichBlocks) processRichBlocks()
  if (!skipRichBlocks) refreshPlanPanel()
}

export function updateMessageEl(msg, streaming) {
  const el = document.querySelector(`[data-msg-id="${msg.id}"]`)
  if (!el) return
  if (msg.role === 'assistant') {
    const body = el.querySelector('.msg-body')
    if (body) {
      if (streaming) {
        // Streaming: lightweight Markdown (no hljs, no rich-block side effects)
        body.innerHTML = renderStreamingMarkdown(msg.text || '')
        body.style.whiteSpace = ''
        // Append blinking caret inside the deepest last block element
        // so it appears at the actual text cursor position
        let _caretTarget = body
        while (_caretTarget.lastElementChild &&
               !_caretTarget.lastElementChild.classList?.contains('code-block') &&
               _caretTarget.lastElementChild.tagName !== 'PRE') {
          const last = _caretTarget.lastElementChild
          // Only descend into block-level elements that contain text
          const tag = last.tagName
          if (['P','LI','TD','TH','H1','H2','H3','H4','H5','H6','BLOCKQUOTE','DIV','OL','UL'].includes(tag)) {
            _caretTarget = last
          } else {
            break
          }
        }
        const caret = document.createElement('span')
        caret.className = 'streaming-caret'
        _caretTarget.appendChild(caret)
      } else {
        body.innerHTML = renderMarkdown(msg.text || '')
        body.style.whiteSpace = ''
      }
    }
    _applyTruncatedBanner(el, msg)
    // 2026-05-06 §4.6 改动 12 — 同上,meta 字串现算 formatMeta(msg)。
    {
      const metaTxt = formatMeta(msg)
      if (metaTxt) {
        let meta = el.querySelector('.msg-meta')
        if (!meta) {
          meta = document.createElement('div')
          meta.className = 'msg-meta'
          el.appendChild(meta)
        }
        renderMetaInto(meta, metaTxt)
      } else {
        // usage 缺失 → 移除现有 meta(防止持久化时移除 metaText/usage 字段后
        // 屏幕仍残留旧字串)
        const meta = el.querySelector('.msg-meta')
        if (meta) meta.remove()
      }
    }
    // 2026-06-18 — 全量更新路径同样刷新请求ID 芯片(幂等,内部先清旧再渲染)。
    _renderReqIdInto(el, msg)
    // Refresh msg-time when completedAt has been set (isFinal / tool handoff).
    // The initial _buildMessageEl append shows ts (first token) while streaming;
    // once the turn completes we want the actual completion wall-clock instead.
    _refreshMsgTime(el, msg)
  } else if (msg.role === 'agent-group') {
    _renderAgentGroup(el, msg)
  } else if (msg.role === 'delegate-progress') {
    _renderDelegateProgress(el, msg)
  } else if (msg.role === 'plan') {
    el.innerHTML = ''
    el.className = 'msg plan'
    if (msg.error) el.classList.add('error')
    el.dataset.msgId = msg.id
    _buildPlanCard(el, msg)
  } else if (msg.role === 'goal') {
    _buildGoalCard(el, msg)
  } else if (msg.role === 'thinking') {
    const body = el.querySelector('.thinking-body') || el.querySelector('.msg-body')
    if (body) body.textContent = msg.text || ''
    // Update header: streaming → "思考中…", done → "思考过程"
    const label = el.querySelector('.thinking-label')
    if (label) label.textContent = streaming ? '💭 思考中…' : '💭 思考过程'
    // Auto-collapse when streaming ends
    if (!streaming) {
      el.classList.add('collapsed')
      // 头不重建,手动同步 aria-expanded(makeDisclosure 的 syncAria 在此拿不到引用)
      el.querySelector('.thinking-header')?.setAttribute('aria-expanded', 'false')
    }
  } else if (msg.role === 'permission') {
    el.innerHTML = ''
    el.className = 'msg permission'
    el.dataset.msgId = msg.id
    _buildPermissionCard(el, msg)
  } else if (msg.role === 'tool') {
    // Legacy tool messages don't need rich re-render
    if (typeof msg._completed !== 'boolean') {
      const body = el.querySelector('.tool-body-legacy')
      if (body) body.textContent = msg.text || ''
    } else {
      // Preserve collapsed state across re-renders. Restore `collapsed`
      // BEFORE _buildToolCard so makeDisclosure's initial aria-expanded sync
      // reads the correct state (else a collapsed card gets aria-expanded=true).
      const wasCollapsed = el.classList.contains('collapsed')
      el.innerHTML = ''
      el.className = `msg tool`
      if (msg.error) el.classList.add('error')
      if (wasCollapsed) el.classList.add('collapsed')
      el.dataset.msgId = msg.id
      _buildToolCard(el, msg)
    }
  } else {
    const body = el.querySelector('.msg-body')
    if (body) {
      const safeHtml = htmlSafeEscape(msg.text || '').replace(/\n/g, '<br>')
      body.innerHTML = embedMediaUrls(safeHtml)
    }
  }
  processRichBlocks()
  refreshPlanPanel()
}

export function renderMetaInto(container, metaText) {
  container.innerHTML = ''
  const parts = (metaText || '').split(' · ')
  for (const p of parts) {
    if (!p) continue
    const span = document.createElement('span')
    span.className = 'msg-meta-item'
    span.textContent = p
    container.appendChild(span)
  }
}

// ── DOM reconcile state for renderMessages() ─────────────────────────────
// `_renderedMsgEls` is the keyed-reconcile bookkeeping for the messages
// pane: it maps the in-memory msg object reference to its rendered DOM
// element. We use object identity (not msg.id) as the key intentionally:
//
//  - sync.js's `_mergeServerAuthoredIntoLocal` returns the SAME
//    reference for any msg the server delivered with identical content
//    (via `_overlayServerAuthoritative`'s no-change fast path). So when
//    a sync replaces `sess.messages`, msg refs that didn't actually
//    change are preserved → `_renderedMsgEls.get(msg)` finds the
//    existing DOM node and we skip the rebuild entirely (no flash).
//  - When server-authoritative fields DID change (usage backfill,
//    truncated flag, etc.) the merger returns a NEW object — same id,
//    different ref. WeakMap miss → we look up by `[data-msg-id]` and
//    patch in-place via `updateMessageEl()`.
//  - When a brand-new msg appears (cross-device, server-only row)
//    nothing in the WeakMap or DOM matches → we `_buildMessageEl()`
//    and insert.
//
// WeakMap means entries are GC'd automatically when a msg object goes
// out of scope (e.g., session deleted, conversation truncated by the
// PUT strip path), so we don't need explicit cleanup.
let _renderedMsgEls = new WeakMap()
// Track session-id and overflow-pagination boundary so we can fall back
// to full wipe-and-rebuild on transitions where reconcile semantics
// would be wrong (different session = different msg-id namespace; load-
// more closure captures msgs array → stale after reconcile).
let _renderedSessionId = null
let _renderedHadOverflow = false
let _renderedWasEmpty = false

const _RENDER_MAX_INITIAL = 100

// Reset reconcile state — called when we know the DOM is being wiped
// outside of the normal renderMessages() flow (e.g., session switch
// via main.js, or test resets).
export function _resetRenderReconcile() {
  _renderedMsgEls = new WeakMap()
  _renderedSessionId = null
  _renderedHadOverflow = false
  _renderedWasEmpty = false
}

// Diff the desired msg list against current DOM children of `.messages-inner`.
// Reuses elements by `_renderedMsgEls` (same ref → no work) or by
// `[data-msg-id]` (same id, different ref → updateMessageEl). Walks once
// in desired order, moving / inserting / building as needed; then removes
// any stale msg elements that didn't match a desired msg.
//
// Returns `true` if any DOM mutation occurred (caller may need to refresh
// rich blocks). Returns `false` if every desired msg matched an existing
// element by ref (a true no-op pass — common when sync replaces the
// messages array with the same refs everywhere).
function _reconcileMessages(inner, desired) {
  // Index current msg-id DOM children once for the by-id fallback path.
  const idToEl = new Map()
  for (const child of inner.children) {
    const id = child.dataset?.msgId
    if (id) idToEl.set(id, child)
  }
  let mutated = false
  // Track which DOM elements survived this pass; everything else
  // (with a data-msg-id) is a candidate for removal at the end.
  const kept = new Set()
  // Anchor walks forward through inner.children, matching the desired
  // order. When the current anchor matches the desired element we
  // advance; otherwise we insertBefore the desired and leave anchor
  // pointing at the same node (so the next desired msg compares against
  // it again).
  let anchor = inner.firstChild
  // Skip non-msg leading children (load-more button, typing-indicator
  // is normally at the end but be defensive).
  while (anchor && !anchor.dataset?.msgId) anchor = anchor.nextSibling
  for (const msg of desired) {
    let el = _renderedMsgEls.get(msg)
    if (el && el.parentNode !== inner) el = null  // stale GC artifact
    if (!el) {
      const existing = idToEl.get(msg.id)
      if (existing) {
        // Same id, different ref → server-authoritative fields changed
        // or streaming-tail content shifted. Patch in place rather than
        // wholesale rebuild so collapsed-tool-card state and any
        // scroll position inside long messages are preserved.
        // Bind the new ref to the existing DOM BEFORE updateMessageEl
        // so any inner querySelector by msg-id continues to work.
        _renderedMsgEls.set(msg, existing)
        try {
          updateMessageEl(msg, false)
          el = existing
          // updateMessageEl mutated the DOM (text/blocks/status). Surface that
          // through `mutated` so the caller's scrollBottom-on-wasAtBottom and
          // processRichBlocks() both fire — a same-id patch can still change
          // message height, e.g. streaming overlay added a token or
          // _overlayServerAuthoritative attached a usage row.
          mutated = true
        } catch (err) {
          console.warn('[renderMessages] updateMessageEl failed during reconcile, falling back to rebuild', err)
          // Patch failed — replace wholesale. If existing was the
          // current anchor, advance anchor to a stable sibling BEFORE
          // detaching it, so the position-walk below can still find
          // its bearings without dereferencing a detached node.
          el = _buildMessageEl(msg)
          if (anchor === existing) anchor = existing.nextSibling
          existing.replaceWith(el)
          _renderedMsgEls.set(msg, el)
          mutated = true
        }
      } else {
        // Brand-new row.
        el = _buildMessageEl(msg)
        _renderedMsgEls.set(msg, el)
        mutated = true
      }
    }
    kept.add(el)
    // Position: if anchor === el, advance. Else insert/move el before anchor.
    if (anchor === el) {
      anchor = anchor.nextSibling
      while (anchor && !anchor.dataset?.msgId) anchor = anchor.nextSibling
    } else {
      inner.insertBefore(el, anchor)
      mutated = true
      // Don't advance anchor — we want the next desired msg compared
      // against the same DOM node again (which is now after `el`).
    }
  }
  // Remove leftover msg children that weren't matched. Non-msg children
  // (typing-indicator, load-more button) are skipped by the dataset
  // guard, preserving them.
  for (const child of [...inner.children]) {
    if (!child.dataset?.msgId) continue
    if (kept.has(child)) continue
    child.remove()
    mutated = true
  }
  return mutated
}

export function renderMessages() {
  const main = $('messages')
  const s = getSession()
  if (!s) {
    // No active session: wipe and reset reconcile state.
    clearChartInstances()
    main.innerHTML = ''
    _resetRenderReconcile()
    $('session-title').textContent = '无会话'
    $('session-sub').textContent = ''
    refreshPlanPanel()
    return
  }
  const isEmpty = s.messages.length === 0
  const hasOverflow = s.messages.length > _RENDER_MAX_INITIAL
  // Decide whether reconcile or full rebuild applies. Full rebuild is
  // required when:
  //   - session id changed (different msg-id namespace; reconcile would
  //     leak stale DOM from prior chat),
  //   - we're entering or leaving empty-state (the empty-state branding
  //     card is structurally different from the messages-inner tree),
  //   - we're entering or leaving overflow mode (the load-more closure
  //     captures `msgs` at render time; on reconcile the captured
  //     reference would be stale).
  // `.messages-inner` may be missing on first render after a hard
  // navigation — treat that as full rebuild too.
  const inner = main.querySelector('.messages-inner')
  const needsFullRebuild =
    !inner ||
    _renderedSessionId !== s.id ||
    _renderedWasEmpty !== isEmpty ||
    _renderedHadOverflow !== hasOverflow
  $('session-title').textContent = s.title
  updateSessionSub(s)
  if (isEmpty) {
    // Empty-state path is always a full wipe — the empty starter-card
    // tree is structurally different from `.messages-inner` and there's
    // nothing reconcilable here anyway (zero messages).
    clearChartInstances()
    main.innerHTML = ''
    _resetRenderReconcile()
    const empty = document.createElement('div')
    empty.className = 'empty-state'
    const _ai = state.agentsList.find((a) => a.id === (s.agentId || state.defaultAgentId))
    const _name = _ai?.displayName || 'OpenClaude'
    const _av = htmlSafeEscape(_ai?.avatarEmoji || 'O')
    empty.innerHTML = `<div class="empty-brand">${_av}</div><h1>${htmlSafeEscape(_name)}</h1><p>你的个人 AI 助理，随时待命</p><div class="hint-kbd">按 <kbd>${_mod}K</kbd> 打开命令面板 · 输入 <kbd>/</kbd> 查看命令</div>`
    // 首次会话引导:starter prompt 卡片(2026-04-30)
    // 数据观察:赠送积分后的真实用户里 ~60% 进了 chat 页但没发任何消息,
    // 容器拉起后停留几十秒到几十分钟再离开 — 主因是面对空白输入框不知道
    // 说什么。用户反馈首屏太杂后,这里只保留 2 个轻量示例;学习循环入口
    // 收到下面一行低调快捷按钮里,避免空会话像“功能广告墙”。
    const _STARTERS = [
      { title: '写代码', text: '用 Python 写一个简单的脚本,读取 CSV 并按某一列分组求和' },
      { title: '解释概念', text: '用通俗语言解释一下 React 的 useEffect 是干嘛的' },
    ]
    const grid = document.createElement('div')
    grid.className = 'empty-starter-grid'
    for (const item of _STARTERS) {
      const card = document.createElement('button')
      card.type = 'button'
      card.className = 'empty-starter-card'
      const t = document.createElement('div')
      t.className = 'empty-starter-title'
      t.textContent = item.title
      const p = document.createElement('div')
      p.className = 'empty-starter-text'
      p.textContent = item.text
      card.appendChild(t)
      card.appendChild(p)
      card.addEventListener('click', () => {
        const input = document.getElementById('input')
        if (!input || input.disabled) return
        input.value = item.text
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.focus()
        try { input.setSelectionRange(input.value.length, input.value.length) } catch {}
      })
      grid.appendChild(card)
    }
    empty.appendChild(grid)
    const contextStrip = document.createElement('div')
    contextStrip.className = 'empty-context-strip'
    const stripLabel = document.createElement('span')
    stripLabel.textContent = '更多'
    contextStrip.appendChild(stripLabel)
    const contextActions = [
      { label: '记忆', run: () => _openMemoryModal?.() },
      { label: '技能', run: () => _openSkillsModal?.() },
      { label: '提醒', run: () => _openTasksModal?.() },
    ]
    for (const item of contextActions) {
      const card = document.createElement('button')
      card.type = 'button'
      card.className = 'empty-context-link'
      card.textContent = item.label
      card.addEventListener('click', item.run)
      contextStrip.appendChild(card)
    }
    empty.appendChild(contextStrip)
    main.appendChild(empty)
    _renderedSessionId = s.id
    _renderedHadOverflow = hasOverflow
    _renderedWasEmpty = isEmpty
    refreshPlanPanel()
    return
  }
  // Non-empty path.
  if (needsFullRebuild) {
    // Tear down: Chart.js needs explicit cleanup before innerHTML wipe,
    // and we must invalidate the WeakMap because surviving msg refs
    // would otherwise point at orphan DOM nodes.
    clearChartInstances()
    main.innerHTML = ''
    _renderedMsgEls = new WeakMap()
    const innerNew = document.createElement('div')
    innerNew.className = 'messages-inner'
    main.appendChild(innerNew)
    const msgs = s.messages
    if (hasOverflow) {
      // Overflow path: explicit "load older messages" pagination.
      // Full rebuild only fires when the overflow boundary is crossed
      // (≤MAX_INITIAL ↔ >MAX_INITIAL). Steady-state overflow→overflow
      // renders take the reconcile branch below. The load-more
      // `_doLoadMore` closure captures the `msgs` array at THIS render
      // — Phase 1 sync's ref-preserving merger means older msg refs
      // (which load-more re-renders) stay valid across syncs unless
      // server-authoritative fields changed, in which case the WeakMap
      // entry is updated on reconcile and the next load-more click
      // would still find the correct DOM via _renderedMsgEls. Worst
      // case (server replaced an older msg ref): user clicks load-more
      // and sees the stale content for that one row until next full
      // rebuild — acceptable trade-off.
      const LOAD_BATCH = 50
      let _loadedUpTo = msgs.length - _RENDER_MAX_INITIAL
      const loadMore = document.createElement('button')
      loadMore.className = 'load-more-btn'
      loadMore.textContent = `加载更早的 ${_loadedUpTo} 条消息`
      const _doLoadMore = () => {
        const batchStart = Math.max(0, _loadedUpTo - LOAD_BATCH)
        const batchEnd = _loadedUpTo
        if (batchStart >= batchEnd) return
        const scrollBefore = main.scrollHeight
        const frag = document.createDocumentFragment()
        for (let i = batchStart; i < batchEnd; i++) {
          const el = _buildMessageEl(msgs[i])
          _renderedMsgEls.set(msgs[i], el)
          frag.appendChild(el)
        }
        _loadedUpTo = batchStart
        if (_loadedUpTo > 0) {
          loadMore.textContent = `加载更早的 ${_loadedUpTo} 条消息`
          loadMore.after(frag)
        } else {
          loadMore.replaceWith(frag)
        }
        processRichBlocks()
        refreshPlanPanel()
        main.scrollTop += main.scrollHeight - scrollBefore
      }
      loadMore.onclick = _doLoadMore
      if (window.IntersectionObserver) {
        const obs = new IntersectionObserver(
          ([entry]) => {
            if (entry.isIntersecting) {
              obs.disconnect()
              _doLoadMore()
            }
          },
          { root: main },
        )
        obs.observe(loadMore)
      }
      innerNew.appendChild(loadMore)
      for (let i = msgs.length - _RENDER_MAX_INITIAL; i < msgs.length; i++) {
        const el = _buildMessageEl(msgs[i])
        _renderedMsgEls.set(msgs[i], el)
        innerNew.appendChild(el)
      }
    } else {
      for (const m of msgs) {
        const el = _buildMessageEl(m)
        _renderedMsgEls.set(m, el)
        innerNew.appendChild(el)
      }
    }
    processRichBlocks()
    refreshPlanPanel()
    // Full rebuild wiped the user's scroll position; bring them back to
    // the bottom (the conversational expectation after a re-render).
    scrollBottom(true)
  } else {
    // Reconcile path — same session, same overflow / empty mode.
    // Compute the desired msg list. For ≤MAX_INITIAL it's the whole
    // array; for overflow we preserve whatever load-more revealed
    // (=current DOM-resident msg ids) plus the trailing window.
    const msgs = s.messages
    let desired
    if (hasOverflow) {
      // Build desired = (msgs already in DOM, in their original
      // s.messages order) ∪ (trailing window). Anything beyond what
      // load-more had revealed stays hidden; the latest tail still
      // gets included.
      const visibleIds = new Set()
      for (const child of inner.children) {
        const id = child.dataset?.msgId
        if (id) visibleIds.add(id)
      }
      const tailStart = msgs.length - _RENDER_MAX_INITIAL
      desired = []
      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i]
        if (!m?.id) continue
        if (i >= tailStart || visibleIds.has(m.id)) desired.push(m)
      }
    } else {
      desired = msgs
    }
    // Capture scroll-anchor before reconcile so we can decide whether
    // to keep position or auto-scroll. Mobile streaming-end flash is
    // partly because the wipe-and-rebuild forced scrollBottom; in
    // reconcile we want to respect where the user is reading.
    const wasAtBottom = isAtBottom()
    const mutated = _reconcileMessages(inner, desired)
    if (mutated) {
      processRichBlocks()
      // Only re-anchor to bottom if the user was already there (or if
      // a turn is streaming and they haven't manually scrolled up —
      // scrollBottom's internal guard handles that). Crucially we do
      // NOT force-scroll here: the whole point of reconcile is to
      // preserve the visual frame across sync events.
      if (wasAtBottom) scrollBottom(false)
    }
  }
  _renderedSessionId = s.id
  _renderedHadOverflow = hasOverflow
  _renderedWasEmpty = isEmpty
  refreshPlanPanel()
}

export function updateSessionSub(s) {
  const el = $('session-sub')
  if (!s) {
    el.textContent = ''
    return
  }
  const n = s.messages.filter((m) => m.role === 'user').length
  const shortId = s.id.replace(/^web-/, '')
  el.textContent = (n > 0 ? `${n} 轮 · ` : '') + shortTime(s.lastAt) + ` · ${shortId}`
  el.title = s.id // full ID on hover
}
