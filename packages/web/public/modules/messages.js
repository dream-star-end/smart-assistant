// OpenClaude — Message rendering and display
import { _openTopupModal } from './billing.js?v=e75ef57'
import { $, _mod, fallbackCopy, htmlSafeEscape } from './dom.js?v=e75ef57'
import { getEffortForSubmit } from './effortMode.js?v=e75ef57'
import { exportMessageDocx } from './export-docx.js?v=e75ef57'
import { exportMessageTex } from './export-tex.js?v=e75ef57'
import {
  clearChartInstances,
  embedMediaUrls,
  processRichBlocks,
  renderMarkdown,
  renderStreamingMarkdown,
} from './markdown.js?v=e75ef57'
import { getSession, state, tryEnqueueOffline, MAX_OFFLINE_QUEUE } from './state.js?v=e75ef57'
import { toast } from './ui.js?v=e75ef57'
import { msgTimeLabel, shortTime } from './util.js?v=e75ef57'
import { safeWsSend } from './websocket.js?v=e75ef57'

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
export function setMessageDeps(deps) {
  _updateSendEnabled = deps.updateSendEnabled
  _showTypingIndicator = deps.showTypingIndicator
  _hideTypingIndicator = deps.hideTypingIndicator
  _setTitleBusy = deps.setTitleBusy
  _scheduleSaveFromUserEdit = deps.scheduleSaveFromUserEdit
  _clearTurnTiming = deps.clearTurnTiming
  _resetReplyTracker = deps.resetReplyTracker
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
  msgEl.addEventListener('wheel', _handleUserScroll)
  msgEl.addEventListener('touchmove', _handleUserScroll)
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
  _default: _ICON_GEAR,
}

const _TOOL_LABELS = {
  Bash: '终端', Read: '读取文件', Edit: '编辑文件', Write: '写入文件',
  Grep: '搜索内容', Glob: '搜索文件', WebFetch: '网页抓取', WebSearch: '网页搜索',
  TodoWrite: '任务列表', NotebookEdit: '笔记本', Task: '子任务', Agent: '子任务',
}

// ── MCP server prefix → friendly meta (icon + base label) ──
// Tools are named `mcp__<server>__<op>`. We classify by server, then by op.
const _MCP_SERVER_META = {
  browser: { icon: _ICON_BROWSER, label: '浏览器' },
  'minimax-media': { icon: _ICON_SPARKLE, label: '媒体生成' },
  'minimax-vision': { icon: _ICON_EYE, label: '视觉理解' },
  'openclaude-memory': { icon: _ICON_BRAIN, label: '记忆' },
  codex: { icon: _ICON_BOT, label: 'Codex' },
  'quant-system': { icon: _ICON_CHART, label: '量化' },
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

// Resolve icon + label for a tool name (handles MCP names).
function _toolMeta(name) {
  if (_TOOL_ICONS[name]) return { icon: _TOOL_ICONS[name], label: _TOOL_LABELS[name] || name }
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
  if (msg.inputJson && typeof msg.inputJson === 'object') return msg.inputJson
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

function _appendAgentChildBlock(body, child) {
  if (!child || typeof child !== 'object') return
  if (child.kind === 'text') {
    if (!child.text) return
    const p = document.createElement('div')
    p.className = 'agent-group-child-text'
    p.textContent = child.text
    body.appendChild(p)
  } else if (child.kind === 'thinking') {
    if (!child.text) return
    const p = document.createElement('div')
    p.className = 'agent-group-child-thinking'
    p.textContent = child.text
    body.appendChild(p)
  } else if (child.kind === 'tool_use') {
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
    body.appendChild(card)
  }
}

function _renderAgentGroup(el, msg) {
  el.innerHTML = ''
  el.className = 'agent-group'
  const collapsed = _resolveAgentGroupCollapsed(msg)
  if (collapsed) el.classList.add('collapsed')

  let statusHtml
  if (msg._completed) {
    if (msg._isError) {
      statusHtml = '<span class="agent-group-status" style="color:var(--danger)">失败</span>'
    } else {
      const dur = typeof msg._duration === 'number' ? ` (${(msg._duration / 1000).toFixed(1)}s)` : ''
      statusHtml = `<span class="agent-group-status" style="color:var(--success)">完成${dur}</span>`
    }
  } else {
    statusHtml = '<span class="agent-group-status">运行中…</span>'
  }

  const header = document.createElement('div')
  header.className = 'agent-group-header'
  header.innerHTML = `${_SVG_BOT_AGENT}<span class="agent-group-title">子任务: ${htmlSafeEscape(msg.text || '')}</span>${statusHtml}${_SVG_CHEVRON_AGENT}`
  header.onclick = () => {
    msg._userCollapsed = !el.classList.contains('collapsed')
    el.classList.toggle('collapsed', msg._userCollapsed)
  }
  el.appendChild(header)

  const body = document.createElement('div')
  body.className = 'agent-group-body'

  // Child blocks: streamed subagent output (text / thinking / tool_use+result).
  const children = Array.isArray(msg.childBlocks) ? msg.childBlocks : []
  for (const ch of children) _appendAgentChildBlock(body, ch)

  // Final result preview (the wrapped agent's return value). Render as a
  // summary row so it's always visible even when the card is collapsed —
  // the body is display:none'd when collapsed, but we emit a second
  // single-line summary directly on the element so the header area stays
  // informative. CSS hides the body's summary copy when expanded to avoid
  // duplication.
  if (msg._resultPreview) {
    const preview = document.createElement('div')
    preview.className = 'agent-group-result'
    preview.innerHTML = `<span class="tool-icon">${msg._isError ? '⚠️' : '✓'}</span><div class="tool-body">${htmlSafeEscape(msg._resultPreview)}</div>`
    body.appendChild(preview)
  }

  el.appendChild(body)

  // Collapsed summary line (shown only when .collapsed): lets the user see
  // the final output without expanding the full child log.
  if (msg._resultPreview) {
    const collapsedSummary = document.createElement('div')
    collapsedSummary.className = 'agent-group-collapsed-summary'
    collapsedSummary.textContent = msg._resultPreview.slice(0, 200)
    el.appendChild(collapsedSummary)
  }
}

function _buildToolCard(el, msg) {
  const name = msg.toolName || 'unknown'
  const meta = _toolMeta(name)
  const input = _safeInput(msg)
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
  header.onclick = () => el.classList.toggle('collapsed')
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
  const mcp = _parseMcpName(name)
  if (mcp) {
    if (mcp.server === 'browser') return _renderBrowser(body, mcp.op, input, msg)
    if (mcp.server === 'minimax-media') return _renderMedia(body, mcp.op, input, msg)
    if (mcp.server === 'minimax-vision') return _renderVision(body, mcp.op, input, msg)
    if (mcp.server === 'openclaude-memory') return _renderMemory(body, mcp.op, input, msg)
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
  }
  // MCP fallback summaries
  const mcp = _parseMcpName(name)
  if (!mcp) return ''
  return _mcpSummary(mcp.server, mcp.op, input).slice(0, 80)
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
}

// ── Generic fallback: key-value list (no raw JSON dump) ──
function _renderGeneric(body, input, msg) {
  if (input && typeof input === 'object') _renderKvList(body, input)
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
            _openTopupModal()
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
        '<button data-action="del" title="删除"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg></button>'
      actErr.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]')
        if (!btn) return
        const sess = getSession()
        if (!sess) return
        if (btn.dataset.action === 'copy') {
          const raw = msg.text || ''
          if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(raw).catch(() => fallbackCopy(raw))
          } else fallbackCopy(raw)
          toast('已复制', 'success')
        } else if (btn.dataset.action === 'del') {
          const i = sess.messages.findIndex((m) => m.id === msg.id)
          if (i >= 0) {
            sess.messages.splice(i, 1)
            renderMessages()
            _scheduleSaveFromUserEdit?.(sess)
          }
        }
      })
      el.appendChild(actErr)
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
      '<button data-action="del" title="删除"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg></button>'
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
        const raw = msg.text || ''
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
            const raw = msg.text || ''
            if (fmt === 'md') _exportMd(raw)
            else if (fmt === 'docx') exportMessageDocx(msg, { title: getSession()?.title || 'openclaude' })
            else if (fmt === 'tex') exportMessageTex(msg, { title: getSession()?.title || 'openclaude' })
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
              agentId: sess.agentId || state.defaultAgentId,
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
        const idx = sess.messages.indexOf(msg)
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
        // Remove messages from this one onwards (snapshot for restore on enqueue-full)
        const _regenSnapshot = sess.messages.slice(idx)
        sess.messages.splice(idx)
        renderMessages()
        // Re-send via proper path: build payload with original media if present
        const _regenEffort = getEffortForSubmit()
        // v1.0.4 — regen 也走当前 user prefs 的 model(可能跟原消息不同;
        // 用户重发就是想换条件再试)。语义见 main.js send()。
        const _regenPrefModel = state.userPrefs?.default_model
        const _regenModelOverride = (typeof _regenPrefModel === 'string' && _regenPrefModel) ? _regenPrefModel : undefined
        const wsPayload = {
          type: 'inbound.message',
          idempotencyKey: `regen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          channel: 'webchat',
          peer: { id: sess.id, kind: 'dm' },
          agentId: sess.agentId || state.defaultAgentId,
          content: {
            text: lastUserMsg._modelText || lastUserMsg.text || '',
            media: lastUserMsg._media || undefined,
          },
          // 与 main.js send() 同语义:string=切档 / null=清除 / undefined=不参与
          ...(_regenEffort !== undefined ? { effortLevel: _regenEffort } : {}),
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
          sess._sendingInFlight = true
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
                  agentId: sess.agentId || state.defaultAgentId,
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
        const text = (msg.text || '').replace(/[#*`>_~\[\]()]/g, '').slice(0, 2000)
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
      } else if (action === 'del') {
        const idx = sess.messages.indexOf(msg)
        if (idx < 0) return
        // Soft delete with undo toast
        sess.messages.splice(idx, 1)
        el.style.display = 'none'
        const undoToast = document.createElement('div')
        undoToast.className = 'toast show'
        undoToast.innerHTML =
          '消息已删除 <button class="undo-btn" style="margin-left:12px;color:var(--accent);background:none;border:none;cursor:pointer;font-weight:600;text-decoration:underline">撤销</button>'
        document.body.appendChild(undoToast)
        let undone = false
        undoToast.querySelector('.undo-btn').onclick = () => {
          undone = true
          sess.messages.splice(idx, 0, msg)
          el.style.display = ''
          undoToast.remove()
          _scheduleSaveFromUserEdit(sess)
        }
        setTimeout(() => {
          if (!undone) {
            el.remove()
            _scheduleSaveFromUserEdit(sess)
          }
          undoToast.remove()
        }, 4000)
      }
    })
    el.appendChild(actions)
    _applyTruncatedBanner(el, msg)
    if (msg.metaText) {
      const meta = document.createElement('div')
      meta.className = 'msg-meta'
      renderMetaInto(meta, msg.metaText)
      el.appendChild(meta)
    }
    // Absolute timestamp. For assistant messages we prefer `completedAt`
    // (set on final frame / when streaming hands off to a tool) so the
    // stamp reflects when the reply actually finished, not when the first
    // token arrived. Falls back to `ts` (creation) while streaming, and for
    // legacy messages that predate the completedAt field.
    _appendMsgTime(el, msg.completedAt || msg.ts)
  } else if (msg.role === 'agent-group') {
    _renderAgentGroup(el, msg)
  } else if (msg.role === 'thinking') {
    const header = document.createElement('div')
    header.className = 'thinking-header'
    header.innerHTML = '<span class="thinking-label">💭 思考中…</span>'
    header.onclick = () => el.classList.toggle('collapsed')
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
    // Status indicator for user messages
    if (msg.status) {
      const statusEl = document.createElement('div')
      statusEl.className = `msg-status ${msg.status}`
      statusEl.innerHTML = `${_STATUS_SVG[msg.status] || ''}<span>${_STATUS_LABEL[msg.status] || ''}</span>`
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
  // Keep the typing indicator pinned at the bottom — if it is currently visible,
  // insert new messages above it instead of appending after it.
  const typing = main.querySelector('.typing-indicator')
  if (typing) main.insertBefore(el, typing)
  else main.appendChild(el)
  if (!skipRichBlocks) processRichBlocks()
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
    if (msg.metaText) {
      let meta = el.querySelector('.msg-meta')
      if (!meta) {
        meta = document.createElement('div')
        meta.className = 'msg-meta'
        el.appendChild(meta)
      }
      renderMetaInto(meta, msg.metaText)
    }
    // Refresh msg-time when completedAt has been set (isFinal / tool handoff).
    // The initial _buildMessageEl append shows ts (first token) while streaming;
    // once the turn completes we want the actual completion wall-clock instead.
    _refreshMsgTime(el, msg)
  } else if (msg.role === 'agent-group') {
    _renderAgentGroup(el, msg)
  } else if (msg.role === 'thinking') {
    const body = el.querySelector('.thinking-body') || el.querySelector('.msg-body')
    if (body) body.textContent = msg.text || ''
    // Update header: streaming → "思考中…", done → "思考过程"
    const label = el.querySelector('.thinking-label')
    if (label) label.textContent = streaming ? '💭 思考中…' : '💭 思考过程'
    // Auto-collapse when streaming ends
    if (!streaming) el.classList.add('collapsed')
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
      // Preserve collapsed state across re-renders
      const wasCollapsed = el.classList.contains('collapsed')
      el.innerHTML = ''
      el.className = `msg tool`
      if (msg.error) el.classList.add('error')
      el.dataset.msgId = msg.id
      _buildToolCard(el, msg)
      if (wasCollapsed) el.classList.add('collapsed')
    }
  } else {
    const body = el.querySelector('.msg-body')
    if (body) {
      const safeHtml = htmlSafeEscape(msg.text || '').replace(/\n/g, '<br>')
      body.innerHTML = embedMediaUrls(safeHtml)
    }
  }
  processRichBlocks()
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

export function renderMessages() {
  // Cleanup Chart.js instances before DOM wipe
  clearChartInstances()
  const main = $('messages')
  main.innerHTML = ''
  const s = getSession()
  if (!s) {
    $('session-title').textContent = '无会话'
    $('session-sub').textContent = ''
    return
  }
  $('session-title').textContent = s.title
  updateSessionSub(s)
  if (s.messages.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'empty-state'
    const _ai = state.agentsList.find((a) => a.id === (s.agentId || state.defaultAgentId))
    const _name = _ai?.displayName || 'OpenClaude'
    const _av = htmlSafeEscape(_ai?.avatarEmoji || 'O')
    empty.innerHTML = `<div class="empty-brand">${_av}</div><h1>${htmlSafeEscape(_name)}</h1><p>你的个人 AI 助理，随时待命</p><div class="hint-kbd">按 <kbd>${_mod}K</kbd> 打开命令面板 · 输入 <kbd>/</kbd> 查看命令</div>`
    main.appendChild(empty)
    return
  }
  const inner = document.createElement('div')
  inner.className = 'messages-inner'
  main.appendChild(inner)
  // Performance: only render last 100 messages; show "load more" for older ones
  const MAX_INITIAL = 100
  const msgs = s.messages
  if (msgs.length > MAX_INITIAL) {
    const LOAD_BATCH = 50
    let _loadedUpTo = msgs.length - MAX_INITIAL // index: messages before this are not yet rendered
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
        frag.appendChild(el)
      }
      _loadedUpTo = batchStart
      if (_loadedUpTo > 0) {
        // Still more to load -- update button text and keep it
        loadMore.textContent = `加载更早的 ${_loadedUpTo} 条消息`
        loadMore.after(frag)
      } else {
        // All loaded -- remove button
        loadMore.replaceWith(frag)
      }
      processRichBlocks()
      main.scrollTop += main.scrollHeight - scrollBefore
    }
    loadMore.onclick = _doLoadMore
    // Auto-load when scrolled to top (IntersectionObserver)
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
    inner.appendChild(loadMore)
    for (let i = msgs.length - MAX_INITIAL; i < msgs.length; i++) renderMessage(msgs[i], true)
  } else {
    for (const m of msgs) renderMessage(m, true)
  }
  // Batch process all rich blocks once instead of per-message
  processRichBlocks()
  scrollBottom(true)
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
