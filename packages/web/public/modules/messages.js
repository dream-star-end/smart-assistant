// OpenClaude — Message rendering and display
import { $, _mod, fallbackCopy, htmlSafeEscape } from './dom.js'
import {
  clearChartInstances,
  embedMediaUrls,
  processRichBlocks,
  renderMarkdown,
  renderStreamingMarkdown,
} from './markdown.js'
import { getSession, state } from './state.js'
import { toast } from './ui.js'
import { shortTime } from './util.js'

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

function _exportDoc(text) {
  const html = _renderCleanHtml(text)
  const doc =
    '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">' +
    `<head><meta charset="utf-8"><style>${_EXPORT_CSS}</style></head>` +
    `<body>${html}</body></html>`
  _dlBlob(new Blob(['\ufeff' + doc], { type: 'application/msword' }), `openclaude-${_exportTs()}.doc`)
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
export function setMessageDeps(deps) {
  _updateSendEnabled = deps.updateSendEnabled
  _showTypingIndicator = deps.showTypingIndicator
  _hideTypingIndicator = deps.hideTypingIndicator
  _setTitleBusy = deps.setTitleBusy
  _scheduleSaveFromUserEdit = deps.scheduleSaveFromUserEdit
  _clearTurnTiming = deps.clearTurnTiming
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
  queued: '排队中',
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
const _TOOL_ICONS = {
  Bash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
  Read: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
  Edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
  Write: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>',
  Grep: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
  Glob: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
  WebFetch: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
  WebSearch: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
  TodoWrite: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
  _default: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
}

const _TOOL_LABELS = {
  Bash: '终端', Read: '读取文件', Edit: '编辑文件', Write: '写入文件',
  Grep: '搜索内容', Glob: '搜索文件', WebFetch: '网页抓取', WebSearch: '网页搜索',
  TodoWrite: '任务列表', NotebookEdit: '笔记本',
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

function _buildToolCard(el, msg) {
  const name = msg.toolName || 'unknown'
  const icon = _TOOL_ICONS[name] || _TOOL_ICONS._default
  const label = _TOOL_LABELS[name] || name
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
  headerLeft.innerHTML = `<span class="tool-card-icon">${icon}</span><span class="tool-card-label">${htmlSafeEscape(label)}</span>`

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

  // Per-tool-type content
  switch (name) {
    case 'Bash': _renderBash(body, input, msg); break
    case 'Edit': _renderEdit(body, input, msg); break
    case 'Read': _renderRead(body, input, msg); break
    case 'Write': _renderWrite(body, input, msg); break
    case 'Grep': _renderGrep(body, input, msg); break
    case 'Glob': _renderGlob(body, input, msg); break
    default: _renderGeneric(body, input, msg); break
  }
  el.appendChild(body)
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
    default: return ''
  }
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
  if (msg.output) {
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

// ── Generic fallback ──
function _renderGeneric(body, input, msg) {
  if (input) {
    const pre = document.createElement('pre')
    pre.className = 'tool-output tool-generic-input'
    pre.textContent = JSON.stringify(input, null, 2).slice(0, 500)
    body.appendChild(pre)
  }
  if (msg.output) {
    const pre = document.createElement('pre')
    pre.className = 'tool-output'
    pre.textContent = msg.output.slice(0, 1500)
    if (msg.output.length > 1500) pre.textContent += '\n…'
    body.appendChild(pre)
  }
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
          '<button data-save="doc"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg> Word 兼容 (.doc)</button>' +
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
            else if (fmt === 'doc') _exportDoc(raw)
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
        // Stop any in-flight turn before regenerating to avoid concurrent requests
        if (state.sendingInFlight) {
          // Import stopCurrentTurn via late-bound deps isn't available here,
          // so send the stop command directly
          if (state.ws && state.ws.readyState === 1) {
            state.ws.send(JSON.stringify({
              type: 'inbound.control.stop',
              channel: 'webchat',
              peer: { id: sess.id, kind: 'dm' },
              agentId: sess.agentId || state.defaultAgentId,
            }))
          }
          sess._sendingInFlight = false
          _clearTurnTiming?.(sess)
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
        // Remove messages from this one onwards
        sess.messages.splice(idx)
        renderMessages()
        // Re-send via proper path: build payload with original media if present
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
          ts: Date.now(),
        }
        // Check if there are pending offline items for this session to prevent reordering
        const _hasQueued = (state.offlineQueue?.some(i => i.sessId === sess.id)) ||
          (state._offlineQueuePending?.some(i => i.sessId === sess.id)) ||
          (state._offlineDrainingCurrent?.sessId === sess.id)
        if (state.ws && state.ws.readyState === 1 && !_hasQueued) {
          state.ws.send(JSON.stringify(wsPayload))
          sess._sendingInFlight = true
          // Clear any leftover regen timer from a previous regen/stop cycle
          if (sess._regenSafetyTimer) { clearTimeout(sess._regenSafetyTimer); sess._regenSafetyTimer = null }
          sess._regenSafetyTimer = setTimeout(() => {
            sess._regenSafetyTimer = null
            if (sess._sendingInFlight) {
              console.warn('[regen] Safety timeout, clearing inFlight for', sess.id)
              // Also interrupt the backend turn
              try {
                if (state.ws && state.ws.readyState === 1) {
                  state.ws.send(JSON.stringify({
                    type: 'inbound.control.stop',
                    channel: 'webchat',
                    peer: { id: sess.id, kind: 'dm' },
                    agentId: sess.agentId || state.defaultAgentId,
                  }))
                }
              } catch {}
              sess._sendingInFlight = false
              _clearTurnTiming?.(sess)
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
          // Offline or has pending queue items: queue to maintain order
          state.offlineQueue.push({
            sessId: sess.id,
            payload: wsPayload,
            msgId: lastUserMsg.id,
          })
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
    if (msg.metaText) {
      const meta = document.createElement('div')
      meta.className = 'msg-meta'
      renderMetaInto(meta, msg.metaText)
      el.appendChild(meta)
    }
  } else if (msg.role === 'agent-group') {
    el.className = 'agent-group'
    const svgBot =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="7" width="16" height="12" rx="2"/><line x1="12" y1="3" x2="12" y2="7"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/></svg>'
    const svgChevron =
      '<svg class="agent-group-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>'
    const statusText = msg._completed
      ? msg._isError
        ? '<span class="agent-group-status" style="color:var(--danger)">失败</span>'
        : `<span class="agent-group-status" style="color:var(--success)">完成 (${(msg._duration / 1000).toFixed(1)}s)</span>`
      : '<span class="agent-group-status">运行中...</span>'
    const header = document.createElement('div')
    header.className = 'agent-group-header'
    header.innerHTML = `${svgBot}<span>子任务: ${htmlSafeEscape(msg.text || '')}</span>${statusText}${svgChevron}`
    header.onclick = () => el.classList.toggle('collapsed')
    el.appendChild(header)
    const body = document.createElement('div')
    body.className = 'agent-group-body'
    if (msg._resultPreview) {
      const preview = document.createElement('div')
      preview.className = 'msg tool'
      preview.style.cssText = 'padding:6px 10px;border:none;background:transparent;font-size:12px'
      preview.innerHTML = `<span class="tool-icon">${msg._isError ? '⚠️' : '✓'}</span><div class="tool-body">${htmlSafeEscape(msg._resultPreview)}</div>`
      body.appendChild(preview)
    }
    el.appendChild(body)
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
  }
  return el
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
    if (msg.metaText) {
      let meta = el.querySelector('.msg-meta')
      if (!meta) {
        meta = document.createElement('div')
        meta.className = 'msg-meta'
        el.appendChild(meta)
      }
      renderMetaInto(meta, msg.metaText)
    }
  } else if (msg.role === 'agent-group') {
    // Re-render the whole card (simpler than partial updates)
    el.innerHTML = ''
    el.className = 'agent-group'
    const svgBot =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="7" width="16" height="12" rx="2"/><line x1="12" y1="3" x2="12" y2="7"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/></svg>'
    const svgChevron =
      '<svg class="agent-group-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>'
    const statusText = msg._completed
      ? msg._isError
        ? '<span class="agent-group-status" style="color:var(--danger)">失败</span>'
        : `<span class="agent-group-status" style="color:var(--success)">完成 (${(msg._duration / 1000).toFixed(1)}s)</span>`
      : '<span class="agent-group-status">运行中...</span>'
    const header = document.createElement('div')
    header.className = 'agent-group-header'
    header.innerHTML = `${svgBot}<span>子任务: ${htmlSafeEscape(msg.text || '')}</span>${statusText}${svgChevron}`
    header.onclick = () => el.classList.toggle('collapsed')
    el.appendChild(header)
    if (msg._resultPreview) {
      const body = document.createElement('div')
      body.className = 'agent-group-body'
      const preview = document.createElement('div')
      preview.className = 'msg tool'
      preview.style.cssText = 'padding:6px 10px;border:none;background:transparent;font-size:12px'
      preview.innerHTML = `<span class="tool-icon">${msg._isError ? '⚠️' : '✓'}</span><div class="tool-body">${htmlSafeEscape(msg._resultPreview)}</div>`
      body.appendChild(preview)
      el.appendChild(body)
    }
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
    updateTokenUsageDisplay(null)
    return
  }
  const n = s.messages.filter((m) => m.role === 'user').length
  const shortId = s.id.replace(/^web-/, '')
  el.textContent = (n > 0 ? `${n} 轮 · ` : '') + shortTime(s.lastAt) + ` · ${shortId}`
  el.title = s.id // full ID on hover
  updateTokenUsageDisplay(s._tokenUsage)
}

function _formatTokenCount(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

export function updateTokenUsageDisplay(usage) {
  const el = $('token-usage')
  const textEl = $('token-usage-text')
  if (!el || !textEl) return
  if (!usage || (usage.input === 0 && usage.output === 0)) {
    el.classList.remove('has-usage')
    textEl.textContent = '0 tokens'
    el.title = '当前会话 token 消耗'
    return
  }
  el.classList.add('has-usage')
  const total = usage.input + usage.output
  const parts = [_formatTokenCount(total) + ' tokens']
  if (usage.cost > 0) parts.push('$' + usage.cost.toFixed(4))
  textEl.textContent = parts.join(' · ')
  el.title = `输入: ${_formatTokenCount(usage.input)} · 输出: ${_formatTokenCount(usage.output)}` +
    (usage.cacheRead > 0 ? ` · 缓存读: ${_formatTokenCount(usage.cacheRead)}` : '') +
    (usage.cacheWrite > 0 ? ` · 缓存写: ${_formatTokenCount(usage.cacheWrite)}` : '') +
    (usage.cost > 0 ? ` · 费用: $${usage.cost.toFixed(4)}` : '')
}
