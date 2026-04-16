// OpenClaude -- Main entry point (ES module)
// Imports everything and wires the application together.
// This file exports nothing; it IS the application.

// ── DOM utilities ──
import { $, _isMac, _mod, fallbackCopy, htmlSafeEscape } from './dom.js'

// ── Pure utilities ──
import {
  GROUP_ORDER,
  _basename,
  _cronHuman,
  formatSize,
  msgId,
  sessionGroup,
  shortTime,
  uuid,
} from './util.js'

// ── App state ──
import { getSession, isSending, setSending, state } from './state.js'

// ── API layer ──
import { apiFetch, apiGet, apiJson, authHeaders, onAuthExpired, resetAuthExpired } from './api.js'

// ── IndexedDB ──
import { dbDelete, dbGetAll, dbPut, onIdbUnavailable, openDB } from './db.js'

// ── Cross-device sync ──
import { setSyncDeps, syncSessionsFromServer } from './sync.js'

// ── Theme ──
import { applyTheme, cycleTheme, effectiveTheme, setToastFn } from './theme.js'

// ── Markdown / rich rendering ──
import {
  _imgHtml,
  _renderLocalMedia,
  embedMediaUrls,
  localPathToUrl,
  processRichBlocks,
  renderMarkdown,
} from './markdown.js'

// ── UI helpers ──
import { closeLightbox, closeModal, openLightbox, openModal, toast } from './ui.js'

// ── Attachments ──
import {
  addFiles,
  classifyFile,
  fileToDataURL,
  fileToText,
  removeAttachment,
  renderAttachments,
} from './attachments.js'

// ── Speech recognition ──
import { initSpeech, setAutoResize, toggleVoice } from './speech.js'

// ── Notifications ──
import { maybeNotify, requestNotifyPermission, setTitleBusy } from './notifications.js'

// ── OAuth ──
import { initOAuthListeners, openOAuthModal } from './oauth.js'

// ── Memory & Skills ──
import { loadMemoryTab, openMemoryModal, openSkillsModal, saveMemory } from './memory.js'

// ── Scheduled tasks ──
import {
  initTasksListeners,
  loadBgTasks,
  loadExecLog,
  openTasksModal,
  switchTasksTab,
} from './tasks.js'

// ── Agents ──
import {
  openPersonaEditor,
  reloadAgents,
  renderAgentDropdown,
  renderAgentsManagementList,
} from './agents.js'

// ── Sessions ──
import {
  _buildSessionItem,
  _rebuildSearchIndex,
  createSession,
  deleteSession,
  exportSessionMd,
  flushPendingSaves,
  hideContextMenu,
  renderSidebar,
  restoreCurrentSessionInFlightUI,
  sanitizeLoadedTurnState,
  scheduleSave,
  scheduleSaveFromUserEdit,
  setSessionDeps,
  setSessionUIDeps,
  showContextMenu,
  startInlineRename,
  switchSession,
} from './sessions.js'

// ── Messages ──
import {
  _buildMessageEl,
  ensureInner,
  initMessagesListeners,
  isAtBottom,
  renderMessage,
  renderMessages,
  renderMetaInto,
  scrollBottom,
  setMessageDeps,
  updateMessageEl,
  updateSessionSub,
} from './messages.js'

// ── WebSocket ──
import {
  _renderTasksPanel,
  addBgTask,
  addMessage,
  addSystemMessage,
  buildToolUseLabel,
  completeBgTask,
  clearTurnTiming,
  connect,
  formatMeta,
  handleOutbound,
  hideTypingIndicator,
  notifyNetworkOffline,
  notifyNetworkOnline,
  notifyTabVisible,
  resetThinkingSafety,
  setMeta,
  setStatus,
  setWsDeps,
  showTypingIndicator,
  stopCurrentTurn,
  updateMessage,
  updateMsgStatus,
  updateSendEnabled,
} from './websocket.js'

// ── Slash commands ──
import {
  getSlashMatches,
  getSlashSelected,
  handleSlashCommand,
  hideSlashPopup,
  selectSlashItem,
  setCommandDeps,
  setSlashSelected,
  showSlashPopup,
  slashPopupVisible,
} from './commands.js'

// ═══════════════════════════════════════════════════════════
// 1. Wire late-bound dependencies
// ═══════════════════════════════════════════════════════════

setToastFn(toast)

setSessionDeps({
  renderMessages,
  updateSendEnabled,
  updateSessionSub,
  scrollBottom,
})

setSessionUIDeps({
  showTypingIndicator,
  hideTypingIndicator,
  renderAgentDropdown,
})

setMessageDeps({
  updateSendEnabled,
  showTypingIndicator,
  hideTypingIndicator,
  setTitleBusy,
  scheduleSave,
  scheduleSaveFromUserEdit,
  clearTurnTiming,
})

setWsDeps({
  scheduleSave,
  renderMessage,
  updateMessageEl,
  scrollBottom,
  ensureInner,
  renderSidebar,
  renderMessages,
  updateSessionSub,
  processRichBlocks,
  showLogin,
  msgId,
})

setCommandDeps({
  createNewChat: () => createNewChat(),
  renderMessages,
  scheduleSave,
  scheduleSaveFromUserEdit,
  openMemoryModal,
  openSkillsModal,
  openPersonaEditor,
  openTasksModal,
  cycleTheme,
  send: () => send(),
})

// Inject autoResize into speech module so voice input can resize the textarea
setAutoResize(() => autoResize())

// ═══════════════════════════════════════════════════════════
// 2. Side effects from modules
// ═══════════════════════════════════════════════════════════

// ── Theme: apply on load + listen for OS-level changes ──
applyTheme()
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if ((localStorage.getItem('openclaude_theme') || 'system') === 'system') applyTheme()
})

// ── State: visibility & focus tracking ──
document.addEventListener('visibilitychange', () => {
  state.windowFocused = !document.hidden
})
window.addEventListener('focus', () => {
  state.windowFocused = true
})
window.addEventListener('blur', () => {
  state.windowFocused = false
})
// Flush pending saves before page unload to prevent data loss on refresh.
// iOS Safari + modern Chromium bfcache don't fire beforeunload reliably,
// so we also hook pagehide (which IS fired under bfcache) and
// visibilitychange (app switch / tab hide on mobile). All three are
// best-effort: the browser may kill async IDB transactions mid-write, but
// the retry-on-rehydrate path in _doSave + scheduleSave on next edit
// will eventually catch up.
window.addEventListener('beforeunload', () => {
  flushPendingSaves()
})
window.addEventListener('pagehide', () => {
  flushPendingSaves()
})
document.addEventListener('visibilitychange', () => {
  if (document.hidden) flushPendingSaves()
})
// ── Progressive reconnect safety ──
// `online`/`offline`: browser-reported network status. Pausing reconnect
// attempts while offline prevents the exponential backoff from ratcheting
// up against no network at all (e.g. laptop lid closed for an hour).
// `visibilitychange` (tab shown): kick off an immediate reconnect attempt
// instead of waiting out the scheduled backoff, since mobile/desktop can
// pause JS timers while hidden.
window.addEventListener('online', () => notifyNetworkOnline())
window.addEventListener('offline', () => notifyNetworkOffline())
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) notifyTabVisible()
})
// ── Global error handlers ──
// Last-resort UI feedback for any uncaught exception or unhandled promise
// rejection that escapes module-level try/catch. Without this the user
// silently loses information (console is hidden), and a noisy loop of the
// same error can still spam the UI, so we rate-limit by signature.
//
// Denylist: errors known to be benign or impossible to act on in-browser:
//   • AbortError — user cancelled a fetch (stop button, navigation).
//   • TimeoutError — apiFetch's own timeout guard (see api.js _composeSignal);
//     already surfaces through the affected feature.
//   • "ResizeObserver loop …" — Chromium warning, never actionable.
//   • "Script error." — cross-origin script without CORS; no details anyway.
//   • "Load failed" / TypeError from aborted fetch on Safari.
const _errorToastHistory = new Map() // signature → last shown ts
const ERROR_TOAST_COOLDOWN_MS = 10000
// Error names we always suppress — these are either user-initiated (fetch
// cancellation), our own timeout (apiFetch aborts with TimeoutError), or
// non-actionable browser warnings.
const _SUPPRESSED_ERROR_NAMES = new Set(['AbortError', 'TimeoutError'])

function _shouldSuppressError(errLike, msg) {
  // Primary: inspect the actual Error/DOMException object — this correctly
  // catches apiFetch's DOMException('…', 'TimeoutError') even though the
  // message itself contains no "AbortError" substring.
  const name = errLike?.name
  if (name && _SUPPRESSED_ERROR_NAMES.has(name)) return true
  if (!msg) return true
  const s = String(msg)
  // Fallback for events that only expose a string message (cross-origin,
  // older browsers, or rejections thrown as plain strings).
  if (s.includes('AbortError') || s === 'AbortError') return true
  if (s.includes('TimeoutError')) return true
  if (s.includes('Request timeout')) return true
  if (s.includes('ResizeObserver loop')) return true
  if (s === 'Script error.' || s.startsWith('Script error')) return true
  if (s === 'Load failed') return true
  return false
}

function _showErrorToastOnce(errLike, msg) {
  if (_shouldSuppressError(errLike, msg)) return
  const sig = String(msg || errLike?.message || 'error').slice(0, 120)
  const now = Date.now()
  const last = _errorToastHistory.get(sig) || 0
  if (now - last < ERROR_TOAST_COOLDOWN_MS) return
  _errorToastHistory.set(sig, now)
  // Light cap on map size so long-running tabs don't grow it unbounded.
  if (_errorToastHistory.size > 64) {
    const oldest = [...(_errorToastHistory.entries())].sort((a, b) => a[1] - b[1])[0]
    if (oldest) _errorToastHistory.delete(oldest[0])
  }
  toast(`出错了: ${sig}`, 'error')
}

window.addEventListener('error', (ev) => {
  // ev.error is the raw Error for scripts we own; ev.message is the display
  // string the browser already computed. Prefer ev.error.message when available.
  const msg = ev.error?.message || ev.message || '未知脚本错误'
  // Full details to console for debugging — NOT muted by the toast guard.
  console.error('[global error]', ev.error || ev)
  _showErrorToastOnce(ev.error, msg)
})

window.addEventListener('unhandledrejection', (ev) => {
  const reason = ev.reason
  // Prefer Error.message, fall back to String(reason). Some code rejects with
  // a plain object {error: "..."} — dig a level.
  const msg = reason?.message
    || reason?.error
    || (typeof reason === 'string' ? reason : null)
    || '未处理的异步错误'
  console.error('[unhandled rejection]', reason)
  _showErrorToastOnce(reason, msg)
})

// Auto-resize htmlpreview iframes based on content height
window.addEventListener('message', (e) => {
  if (e.data?.type === 'iframe-resize' && e.data.id && e.data.h) {
    // Only accept resize from our own managed iframes (id starts with htmlpv-)
    if (typeof e.data.id !== 'string' || !e.data.id.startsWith('htmlpv-')) return
    const iframe = document.getElementById(e.data.id)
    // Validate that the message source matches the iframe's contentWindow
    if (iframe && iframe.tagName === 'IFRAME' && e.source === iframe.contentWindow) {
      iframe.style.height = `${Math.min(Math.max(e.data.h + 10, 200), 800)}px`
    }
  }
})

// ── Markdown: global click handler for [data-copy] and [data-view-source] ──
document.addEventListener('click', (e) => {
  // view source toggle for htmlpreview iframes
  const srcBtn = e.target.closest?.('[data-view-source]')
  if (srcBtn) {
    const id = srcBtn.dataset.viewSource
    const iframe = document.getElementById(id)
    if (!iframe) return
    const wrap = iframe.parentElement
    const showing = wrap.dataset.showingSource === '1'
    if (showing) {
      const pre = wrap.querySelector('pre.src-view')
      if (pre) pre.remove()
      iframe.style.display = ''
      wrap.dataset.showingSource = '0'
      srcBtn.textContent = 'view source'
    } else {
      iframe.style.display = 'none'
      const pre = document.createElement('pre')
      pre.className = 'src-view'
      pre.style.cssText =
        'background:var(--code-bg);color:var(--fg);padding:14px 16px;margin:0;max-height:400px;overflow:auto;font-family:var(--font-mono);font-size:12px;white-space:pre-wrap;word-break:break-all'
      pre.textContent = iframe.dataset.source || ''
      wrap.appendChild(pre)
      wrap.dataset.showingSource = '1'
      srcBtn.textContent = 'hide source'
    }
    return
  }
  // Code block copy button
  const btn = e.target.closest?.('[data-copy]')
  if (!btn) return
  const pre = btn.closest('pre')
  const code = pre?.querySelector('code')
  if (!code) return
  const text = code.innerText
  const done = () => {
    btn.textContent = '已复制'
    btn.classList.add('copied')
    setTimeout(() => {
      btn.textContent = '复制'
      btn.classList.remove('copied')
    }, 1500)
  }
  if (navigator.clipboard?.writeText) {
    navigator.clipboard
      .writeText(text)
      .then(done)
      .catch(() => {
        fallbackCopy(text)
        done()
      })
  } else {
    fallbackCopy(text)
    done()
  }
})

// ── UI: modal close on backdrop click / close-modal buttons ──
document.addEventListener('click', (e) => {
  const btn = e.target.closest?.('[data-close-modal]')
  if (btn) closeModal(btn.dataset.closeModal)
  // close modal on backdrop click
  const backdrop = e.target.classList?.contains('modal-backdrop') ? e.target : null
  if (backdrop) {
    // Use closeModal to properly clean up focus trap
    closeModal(backdrop.id)
  }
})

// ── Lightbox: click on inline images/videos, close on backdrop ──
document.addEventListener('click', (e) => {
  const img = e.target.closest?.('.inline-img')
  if (img) {
    e.preventDefault()
    openLightbox(img)
    return
  }
  // Inline videos: don't hijack single clicks (let native controls work)
  // Lightbox is triggered by double-click instead (see dblclick listener below)
  if (e.target.closest?.('.lightbox-close')) {
    closeLightbox()
    return
  }
  if (e.target.id === 'lightbox' || e.target.classList?.contains('lightbox-backdrop')) {
    closeLightbox()
    return
  }
})

// ── Video double-click to lightbox ──
document.addEventListener('dblclick', (e) => {
  const vid = e.target.closest?.('.inline-video')
  if (vid && !e.target.closest('.lightbox-body')) {
    e.preventDefault()
    openLightbox(vid)
  }
})

// ── Image action buttons (copy/download/open) ──
document.addEventListener('click', (e) => {
  const btn = e.target.closest?.('[data-img-action]')
  if (!btn) return
  e.preventDefault()
  e.stopPropagation()
  const action = btn.dataset.imgAction
  const src = btn.dataset.imgSrc
  if (!src) return

  if (action === 'copy') {
    fallbackCopy(src)
    toast('已复制图片链接')
  } else if (action === 'download') {
    const a = document.createElement('a')
    a.href = src
    a.download = src.split('/').pop()?.split('?')[0] || 'image.jpg'
    a.target = '_blank'
    a.click()
  } else if (action === 'open') {
    window.open(src, '_blank', 'noopener,noreferrer')
  }
})

// ── Escape key: close modals, lightbox, palette ──
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    // Lightbox takes priority
    if (!$('lightbox').hidden) {
      closeLightbox()
      e.stopPropagation()
      return
    }
    // Close any open modal via closeModal (handles focus trap cleanup)
    document.querySelectorAll('.modal-backdrop.open').forEach((el) => closeModal(el.id))
    document.querySelectorAll('.palette-backdrop.open').forEach((el) => el.classList.remove('open'))
  }
})

// Lightbox-specific Escape (separate listener that can stopPropagation)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('lightbox').hidden) {
    closeLightbox()
    e.stopPropagation()
  }
})

// ── Messages: scroll-tracking listener ──
initMessagesListeners()

// ── Tasks: tab switching + add-task wiring ──
initTasksListeners()

// ── OAuth: button click listeners ──
initOAuthListeners()

// ── Feedback: submit wiring ──
$('feedback-submit-btn').onclick = submitFeedback
$('feedback-desc').addEventListener('input', () => {
  if ($('feedback-desc').value.trim().length >= FEEDBACK_MIN_CHARS) {
    $('feedback-clarify').hidden = true
  }
})

// ═══════════════════════════════════════════════════════════
// 3. Functions defined in main.js
// ═══════════════════════════════════════════════════════════

// ── inferLangFromExt ──
function inferLangFromExt(name) {
  const m = /\.([^.]+)$/.exec(name)
  if (!m) return ''
  const ext = m[1].toLowerCase()
  const map = {
    js: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    py: 'python',
    go: 'go',
    rs: 'rust',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    md: 'markdown',
    json: 'json',
    yml: 'yaml',
    yaml: 'yaml',
    sh: 'bash',
    bash: 'bash',
    html: 'html',
    css: 'css',
    sql: 'sql',
    xml: 'xml',
    toml: 'ini',
    ini: 'ini',
  }
  return map[ext] || ''
}

// ── buildMessageText ──
const MAX_INLINE_TEXT_CHARS = 30000 // ~30K chars inline, larger files get truncated

function buildMessageText(userText, attachments) {
  if (!attachments || attachments.length === 0) return userText
  const parts = [userText]
  const textFiles = attachments.filter((a) => a.kind === 'text')
  if (textFiles.length > 0) {
    parts.push('')
    parts.push('---')
    parts.push('Attached files:')
    for (const a of textFiles) {
      const lang = inferLangFromExt(a.name)
      const content = a.text || ''
      const truncated = content.length > MAX_INLINE_TEXT_CHARS
      parts.push('')
      parts.push(`### ${a.name}  _(${formatSize(a.size)})_`)
      parts.push(`\`\`\`${lang}`)
      parts.push(truncated ? content.slice(0, MAX_INLINE_TEXT_CHARS) : content)
      parts.push('```')
      if (truncated) {
        parts.push(
          `_(truncated: showing first ${MAX_INLINE_TEXT_CHARS} of ${content.length} chars)_`,
        )
      }
    }
  }
  const imageFiles = attachments.filter((a) => a.kind === 'image')
  if (imageFiles.length > 0) {
    parts.push('')
    parts.push('---')
    parts.push(`Attached images (${imageFiles.length}):`)
    for (const im of imageFiles) parts.push(`- ${im.name}  _(${im.type}, ${formatSize(im.size)})_`)
    parts.push('')
    parts.push(
      '_(note: if you cannot see the image contents directly, tell the user so they can describe it)_',
    )
  }
  return parts.join('\n')
}

// ── send ──
function send() {
  const text = $('input').value.trim()
  if (!text && state.attachments.length === 0) return
  // Intercept slash commands
  if (text.startsWith('/') && state.attachments.length === 0) {
    hideSlashPopup()
    if (handleSlashCommand(text)) {
      $('input').value = ''
      autoResize()
      return
    }
  }
  const sess = getSession()
  if (!sess) return
  const displayText =
    (text || '(文件上传)') +
    (state.attachments.length > 0
      ? `\n\n📎 ${state.attachments.map((a) => a.name).join(', ')}`
      : '')
  const modelText = buildMessageText(text, state.attachments)
  const media = state.attachments
    .filter((a) => a.kind !== 'text')
    .map((a) => ({
      kind: a.kind,
      base64: a.dataUrl,
      mimeType: a.type,
      filename: a.name,
    }))
  const wsPayload = {
    type: 'inbound.message',
    idempotencyKey: `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    channel: 'webchat',
    peer: { id: sess.id, kind: 'dm' },
    agentId: sess.agentId || state.defaultAgentId,
    content: { text: modelText, media: media.length > 0 ? media : undefined },
    ts: Date.now(),
  }
  // Add user message with status tracking + persist media & full text for regen
  const userMsg = addMessage(sess, 'user', displayText, {
    status: 'sending',
    _media: media.length > 0 ? media : undefined,
    _modelText: modelText !== text ? modelText : undefined,  // Full text with attachments for replay
  })
  sess._streamingAssistant = null
  sess._streamingThinking = null
  sess._blockIdToMsgId = new Map()
  sess._agentSwitchedAt = null  // Clear switch guard — new send is intentional
  // If offline queue is draining or pending for this session, route through queue
  // to prevent message reordering (new msg arriving before old queued ones)
  const _hasQueuedForSess = (state.offlineQueue?.some(i => i.sessId === sess.id)) ||
    (state._offlineQueuePending?.some(i => i.sessId === sess.id)) ||
    (state._offlineDrainingCurrent?.sessId === sess.id)
  if (state.ws && state.ws.readyState === 1 && !_hasQueuedForSess) {
    state.ws.send(JSON.stringify(wsPayload))
    userMsg.status = 'sent'
    updateMsgStatus(userMsg)
    setSending(true)
    resetThinkingSafety(sess.id)
    updateSendEnabled()
    showTypingIndicator()
    setTitleBusy(true)
  } else {
    // Offline or has pending queue items: queue to maintain order
    state.offlineQueue.push({ sessId: sess.id, payload: wsPayload, msgId: userMsg.id })
    userMsg.status = 'queued'
    updateMsgStatus(userMsg)
    if (!state.ws || state.ws.readyState !== 1) {
      toast('离线排队中，重连后自动发送')
    }
  }
  $('input').value = ''
  state.attachments = []
  renderAttachments()
  autoResize()
  scheduleSaveFromUserEdit(sess)
  renderSidebar()
}

// ── autoResize ──
function autoResize() {
  const el = $('input')
  el.style.height = 'auto'
  el.style.height = `${Math.min(window.innerHeight * 0.35, el.scrollHeight)}px`
}

// ═══════════════ COMMAND PALETTE ═══════════════

const paletteActions = [
  {
    id: 'new-chat',
    label: '新建会话',
    kbd: `${_mod}N`,
    section: '动作',
    icon: 'plus',
    run: () => {
      createNewChat()
      closePalette()
    },
  },
  {
    id: 'toggle-sidebar',
    label: '切换侧栏',
    kbd: `${_mod}B`,
    section: '动作',
    icon: 'menu',
    run: () => {
      $('sidebar').classList.toggle('open')
      $('sidebar-backdrop').classList.toggle('open')
      closePalette()
    },
  },
  {
    id: 'open-memory',
    label: '查看 / 编辑 Memory',
    kbd: `${_mod}M`,
    section: '学习循环',
    icon: 'brain',
    run: () => {
      closePalette()
      openMemoryModal()
    },
  },
  {
    id: 'open-skills',
    label: '查看 / 管理 Skills',
    section: '学习循环',
    icon: 'bot',
    run: () => {
      closePalette()
      openSkillsModal()
    },
  },
  {
    id: 'open-tasks',
    label: '定时任务 / 提醒',
    section: '学习循环',
    icon: 'clock',
    run: () => {
      closePalette()
      openTasksModal()
    },
  },
  {
    id: 'manage-agents',
    label: '管理 Agents',
    section: '动作',
    icon: 'settings',
    run: () => {
      closePalette()
      openModal('agents-modal')
    },
  },
  {
    id: 'open-changelog',
    label: '更新日志',
    section: '信息',
    icon: 'doc',
    run: () => {
      closePalette()
      openChangelog()
    },
  },
  {
    id: 'send-feedback',
    label: '发送反馈',
    section: '信息',
    icon: 'chat',
    run: () => {
      closePalette()
      openFeedbackModal()
    },
  },
  {
    id: 'theme-cycle',
    label: '切换主题',
    section: '设置',
    icon: 'sun',
    run: () => {
      cycleTheme()
      closePalette()
    },
  },
  {
    id: 'logout',
    label: '退出登录',
    section: '设置',
    icon: 'logout',
    run: () => {
      $('logout-btn').click()
      closePalette()
    },
  },
]

const ICON_SVG = {
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>',
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>',
  settings:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/></svg>',
  logout:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
  bot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="7" width="16" height="12" rx="2"/><line x1="12" y1="3" x2="12" y2="7"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  brain:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/></svg>',
  clock:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
}

let paletteItems = []
let paletteSelected = 0

function buildPaletteItems(query) {
  const q = query.trim().toLowerCase()
  const items = []
  // Actions
  for (const a of paletteActions) {
    if (!q || a.label.toLowerCase().includes(q)) {
      items.push({ ...a, section: a.section })
    }
  }
  // Agents
  for (const a of state.agentsList) {
    const label = `切换 agent \u2192 ${a.id}`
    if (!q || label.toLowerCase().includes(q) || a.id.toLowerCase().includes(q)) {
      items.push({
        id: `switch-agent-${a.id}`,
        label,
        section: 'Agents',
        icon: 'bot',
        run: () => {
          const sess = getSession()
          if (sess) {
            // Stop in-flight request before switching agent
            if (state.sendingInFlight) stopCurrentTurn()
            sess.agentId = a.id
            sess._agentSwitchedAt = Date.now()
            sess._streamingAssistant = null
            sess._streamingThinking = null
            sess._sendingInFlight = false
            clearTurnTiming(sess)
            state.sendingInFlight = false
            hideTypingIndicator()
            updateSendEnabled()
            setTitleBusy(false)
            scheduleSaveFromUserEdit(sess)
            renderAgentDropdown()
            toast(`已切换到 ${a.id}`)
          }
          closePalette()
        },
      })
    }
  }
  // Sessions
  const sessions = [...state.sessions.values()].sort((a, b) => b.lastAt - a.lastAt)
  for (const s of sessions) {
    if (!q || s.title.toLowerCase().includes(q)) {
      items.push({
        id: `switch-session-${s.id}`,
        label: s.title,
        hint: shortTime(s.lastAt),
        section: '会话',
        icon: 'chat',
        run: () => {
          switchSession(s.id)
          closePalette()
        },
      })
    }
  }
  return items
}

function renderPalette() {
  const list = $('palette-list')
  list.innerHTML = ''
  if (paletteItems.length === 0) {
    list.innerHTML = '<div class="palette-empty">没有匹配的命令</div>'
    return
  }
  let lastSection = null
  paletteItems.forEach((item, idx) => {
    if (item.section !== lastSection) {
      const label = document.createElement('div')
      label.className = 'palette-section-label'
      label.textContent = item.section
      list.appendChild(label)
      lastSection = item.section
    }
    const btn = document.createElement('button')
    btn.className = `palette-item${idx === paletteSelected ? ' active' : ''}`
    btn.type = 'button'
    btn.innerHTML = `${ICON_SVG[item.icon] || ''}<span class="palette-item-label">${htmlSafeEscape(item.label)}</span>${item.hint ? `<span class="palette-item-hint">${htmlSafeEscape(item.hint)}</span>` : ''}${item.kbd ? `<span class="palette-item-hint">${item.kbd}</span>` : ''}`
    btn.onclick = () => item.run()
    btn.onmouseenter = () => {
      paletteSelected = idx
      document
        .querySelectorAll('.palette-item')
        .forEach((e, i) => e.classList.toggle('active', i === idx))
    }
    list.appendChild(btn)
  })
}

function openPalette() {
  $('palette-input').value = ''
  paletteItems = buildPaletteItems('')
  paletteSelected = 0
  renderPalette()
  $('palette-backdrop').classList.add('open')
  setTimeout(() => $('palette-input').focus(), 20)
}

function closePalette() {
  $('palette-backdrop').classList.remove('open')
}

// ── Views ──

// Tear down all authenticated client state and return to login.
// serverLogout=true: fire-and-forget POST /api/auth/logout to expire the
// HttpOnly session cookie. Not awaited — the UI should never block on the
// network here; a stalled server must not prevent the user from reaching
// the login screen. Skipped entirely when triggered by 401 auth-expired —
// the cookie is already invalid server-side and another round-trip would
// just 401 again (and funnel back through this handler).
async function _forceLogout({ serverLogout } = {}) {
  if (serverLogout) {
    // suppressAuthRedirect=true: a 401 on this call would be meaningless
    // (we're already tearing down), and we don't want to recursively fire
    // the auth-expired handler. 5s timeout — if the server is slow the
    // local teardown continues regardless.
    apiFetch('/api/auth/logout', {
      method: 'POST',
      timeout: 5000,
      suppressAuthRedirect: true,
    }).catch(() => {})
  }
  localStorage.removeItem('openclaude_token')
  state.token = ''  // Clear token BEFORE close so onclose handler won't auto-reconnect
  // Rearm the auth-expired one-shot so a future session expiry can trigger
  // the logout flow again. login success also does this, but doing it here
  // too keeps the semantics symmetric across both teardown paths.
  resetAuthExpired()
  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null }
  if (state.reconnectCountdown) { clearInterval(state.reconnectCountdown); state.reconnectCountdown = null }
  // Clear all in-memory session data and offline queues to prevent cross-identity leakage
  state.sessions.clear()
  state.currentSessionId = null
  state.offlineQueue = []
  state._offlineQueuePending = []
  state._offlineDrainingCurrent = null
  state._offlineQueueDraining = false
  state.sendingInFlight = false
  state.attachments = []
  renderAttachments()
  hideTypingIndicator()
  // Clear IndexedDB to prevent cross-user data leakage on shared browsers
  try {
    const all = await dbGetAll()
    for (const s of all) await dbDelete(s.id)
  } catch {}
  if (state.ws) state.ws.close(1000)
  showLogin()
}

function showLogin() {
  $('login-view').hidden = false
  $('app-view').hidden = true
  $('login-error').style.display = 'none'
  $('username').value = ''
  $('token').value = ''
  // Clear all in-memory state to prevent cross-identity leakage on auth-expiry re-login
  state.sessions.clear()
  state.currentSessionId = null
  state.offlineQueue = []
  state._offlineQueuePending = []
  state._offlineDrainingCurrent = null
  state._offlineQueueDraining = false
  state.sendingInFlight = false
  state.attachments = []
  renderAttachments()
  hideTypingIndicator()
  setTitleBusy(false)
  // Clear composer draft
  const composer = $('input')
  if (composer) composer.value = ''
  setTimeout(() => $('username').focus(), 50)
}

// Session-cookie handshake for media preview.
// HTML5 <img>/<audio>/<video> can't attach an Authorization header, so the
// gateway issues an HttpOnly cookie via POST /api/auth/session. We have to
// await this before rendering messages — otherwise the first batch of
// media elements fire requests with no credential and 401. The request is
// timeboxed to MEDIA_COOKIE_TIMEOUT_MS: if the gateway is slow/unreachable,
// the UI still loads, and the delegated media-error retry (see
// _installMediaErrorRetry) will re-attempt once the cookie eventually lands.
const MEDIA_COOKIE_TIMEOUT_MS = 3000
let _cookieInflight = null
async function _ensureSessionCookie() {
  if (!state.token) return false
  if (_cookieInflight) return _cookieInflight
  // suppressAuthRedirect: if this specific call 401s we do NOT want to force
  // logout — caller is about to render messages and the delegated media-error
  // retry will re-attempt. If the token is genuinely expired, the *next* API
  // call (sync/etc.) will hit 401 and trigger the logout properly.
  _cookieInflight = (async () => {
    try {
      const r = await apiFetch('/api/auth/session', {
        method: 'POST',
        headers: authHeaders(),
        timeout: MEDIA_COOKIE_TIMEOUT_MS,
        suppressAuthRedirect: true,
      })
      return r.ok
    } catch {
      return false
    }
  })().finally(() => {
    _cookieInflight = null
  })
  return _cookieInflight
}

async function showApp() {
  $('login-view').hidden = true
  $('app-view').hidden = false
  await _ensureSessionCookie()
}

// Delegated media-error retry. `error` events on <img>/<audio>/<video> don't
// bubble, so we listen in the capture phase from the document root. A load
// failure on an /api/media or /api/file URL most often means the session
// cookie wasn't in place when the element's src first resolved. We try
// once to (re-)set the cookie and cache-bust the src. The retry is guarded
// by a WeakSet to prevent infinite loops if the URL is genuinely broken.
const _mediaRetried = new WeakSet()
const _API_MEDIA_PATH_RE = /^\/api\/(?:media|file)(?:\/|$)/
function _shouldRetryMediaSrc(src) {
  if (!src) return false
  try {
    const u = new URL(src, location.href)
    if (u.origin !== location.origin) return false
    return _API_MEDIA_PATH_RE.test(u.pathname)
  } catch {
    return false
  }
}
function _installMediaErrorRetry() {
  document.addEventListener(
    'error',
    async (e) => {
      const el = e.target
      if (!el || _mediaRetried.has(el)) return
      const tag = el.tagName
      if (tag !== 'IMG' && tag !== 'AUDIO' && tag !== 'VIDEO') return
      const src = el.getAttribute('src') || el.src || ''
      if (!_shouldRetryMediaSrc(src)) return
      _mediaRetried.add(el)
      const ok = await _ensureSessionCookie()
      if (!ok) return
      // Cache-bust: force the browser to reissue the request (now with cookie).
      try {
        const u = new URL(src, location.href)
        u.searchParams.set('_retry', Date.now().toString())
        el.src = u.toString()
      } catch {
        // Relative/malformed URL fallback — just append the query string.
        const sep = src.includes('?') ? '&' : '?'
        el.src = `${src}${sep}_retry=${Date.now()}`
      }
    },
    true,
  )
}

function createNewChat() {
  // Inherit current session's agent, fallback to default. Do NOT write the
  // global `state.sendingInFlight` back onto `oldSess._sendingInFlight` —
  // the session flag is the source of truth (see rationale in
  // sessions.switchSession). The new session is never in-flight, so we
  // only clear the global UI state below.
  const oldSess = getSession()
  const agentId = oldSess?.agentId || state.defaultAgentId
  createSession(agentId)
  // New session is never sending — reset UI state
  state.sendingInFlight = false
  hideTypingIndicator()
  updateSendEnabled()
  setTitleBusy(false)
  renderSidebar()
  renderMessages()
  renderAgentDropdown()
  // Close sidebar on mobile
  $('sidebar').classList.remove('open')
  $('sidebar-backdrop').classList.remove('open')
  // Show agent greeting if configured
  const sess = getSession()
  const agentInfo = state.agentsList.find((a) => a.id === (sess?.agentId || state.defaultAgentId))
  if (agentInfo?.greeting && sess) {
    addMessage(sess, 'assistant', agentInfo.greeting, { system: true })
    scheduleSave(sess)
  }
  $('input').focus()
}

// _renderTasksPanel is imported from websocket.js (has access to _bgTasks)

// ═══════════════ SESSION MIGRATION ═══════════════

async function checkUnclaimedSessions() {
  try {
    const resp = await apiGet('/api/sessions/unclaimed')
    const unclaimed = resp?.sessions || []
    if (unclaimed.length === 0) return
    showMigrateModal(unclaimed)
  } catch {}
}

function showMigrateModal(sessions) {
  const list = $('migrate-list')
  list.innerHTML = ''
  const selected = new Set()

  for (const s of sessions) {
    const item = document.createElement('label')
    item.className = 'migrate-item'
    item.style.cssText = 'display:flex;gap:var(--space-2);padding:var(--space-2) 0;border-bottom:1px solid var(--border);cursor:pointer;align-items:flex-start'
    const date = new Date(s.lastAt).toLocaleString('zh-CN', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })
    item.innerHTML = `
      <input type="checkbox" data-sid="${htmlSafeEscape(s.id)}" style="margin-top:3px;flex-shrink:0">
      <div style="flex:1;min-width:0">
        <div style="font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${htmlSafeEscape(s.title)}</div>
        <div style="font-size:var(--text-xs);color:var(--fg-muted);margin-top:2px">${htmlSafeEscape(s.summary || '(无消息)')}</div>
        <div style="font-size:var(--text-xs);color:var(--fg-muted);margin-top:2px">${date} · ${s.messageCount} 条消息 · ${htmlSafeEscape(s.agentId)}</div>
      </div>
    `
    const cb = item.querySelector('input')
    cb.onchange = () => {
      if (cb.checked) selected.add(s.id)
      else selected.delete(s.id)
      $('migrate-count').textContent = String(selected.size)
      $('migrate-btn').disabled = selected.size === 0
    }
    list.appendChild(item)
  }

  $('migrate-count').textContent = '0'
  $('migrate-btn').disabled = true

  $('migrate-skip-btn').onclick = () => closeModal('migrate-modal')
  $('migrate-btn').onclick = async () => {
    if (selected.size === 0) return
    $('migrate-btn').disabled = true
    $('migrate-btn').innerHTML = '迁移中…'
    try {
      const resp = await apiJson('POST', '/api/sessions/claim', { sessionIds: [...selected] })
      const claimed = Object.values(resp?.results || {}).filter(Boolean).length
      toast(`已迁移 ${claimed} 个会话`, 'success')
      closeModal('migrate-modal')
      // Re-sync to pull claimed sessions into local state
      await syncSessionsFromServer()
      const updated = [...state.sessions.values()].sort((a, b) => b.lastAt - a.lastAt)
      if (!state.currentSessionId || !state.sessions.has(state.currentSessionId)) {
        state.currentSessionId = updated[0]?.id || null
        if (!state.currentSessionId) createSession()
        renderMessages()
      }
      renderSidebar()
    } catch {
      toast('迁移失败', 'error')
    } finally {
      $('migrate-btn').disabled = false
      $('migrate-btn').innerHTML = `迁移选中 (<span id="migrate-count">${selected.size}</span>)`
    }
  }

  openModal('migrate-modal')
}

// ═══════════════ CHANGELOG & VERSION ═══════════════

let _changelogData = null

async function loadChangelog() {
  try {
    _changelogData = await apiGet('/api/changelog')
    // Show version in sidebar
    if (_changelogData.currentVersion) {
      const vEl = $('app-version')
      if (vEl) vEl.textContent = `v${_changelogData.currentVersion}`
    }
    // Check if user has seen this version (scoped by token to avoid cross-user collision)
    const _userKey = `openclaude_changelog_seen_${(state.token || '').slice(-8)}`
    const lastSeen = localStorage.getItem(_userKey)
    if (lastSeen !== _changelogData.currentVersion && _changelogData.releases?.length > 0) {
      const badge = $('changelog-badge')
      if (badge) {
        badge.hidden = false
        badge.textContent = 'NEW'
      }
    }
  } catch {}
}

function openChangelog() {
  const content = $('changelog-content')
  const versionEl = $('changelog-version')
  if (!_changelogData || !_changelogData.releases?.length) {
    content.innerHTML = '<p style="color:var(--fg-muted);text-align:center">暂无更新记录</p>'
  } else {
    content.innerHTML = _changelogData.releases.map((r, i) => `
      <div class="changelog-entry${i === 0 ? ' latest' : ''}">
        <div class="changelog-entry-head">
          <span class="changelog-version-tag">v${htmlSafeEscape(r.version)}</span>
          <span class="changelog-date">${htmlSafeEscape(r.date)}</span>
        </div>
        <h4 class="changelog-title">${htmlSafeEscape(r.title)}</h4>
        <ul class="changelog-list">
          ${r.highlights.map(h => `<li>${htmlSafeEscape(h)}</li>`).join('')}
        </ul>
      </div>
    `).join('')
    versionEl.textContent = `当前版本 v${_changelogData.currentVersion}`
  }
  // Mark as seen (scoped by user token)
  if (_changelogData?.currentVersion) {
    const _userKey = `openclaude_changelog_seen_${(state.token || '').slice(-8)}`
    localStorage.setItem(_userKey, _changelogData.currentVersion)
    const badge = $('changelog-badge')
    if (badge) badge.hidden = true
  }
  openModal('changelog-modal')
}

// ═══════════════ FEEDBACK ═══════════════

const FEEDBACK_MIN_CHARS = 15
const FEEDBACK_CLARIFY_MESSAGES = [
  '描述太简短了，能否补充更多细节？比如：发生了什么、你期望什么、如何复现。',
  '为了更好地处理你的反馈，请提供更详细的描述 — 例如具体步骤、错误信息或截图。',
  '好的反馈需要足够的上下文。请至少说明：问题是什么、何时发生、影响是什么。',
]

function openFeedbackModal() {
  $('feedback-desc').value = ''
  $('feedback-category').value = 'bug'
  $('feedback-clarify').hidden = true
  $('feedback-success').hidden = true
  $('feedback-foot').style.display = ''
  $('feedback-desc').parentElement.style.display = ''
  $('feedback-category').parentElement.style.display = ''
  openModal('feedback-modal')
  setTimeout(() => $('feedback-desc').focus(), 50)
}

async function submitFeedback() {
  const desc = $('feedback-desc').value.trim()
  const category = $('feedback-category').value
  // Clarification check
  if (desc.length < FEEDBACK_MIN_CHARS) {
    const clarifyEl = $('feedback-clarify')
    const textEl = $('feedback-clarify-text')
    const msg = FEEDBACK_CLARIFY_MESSAGES[Math.floor(Math.random() * FEEDBACK_CLARIFY_MESSAGES.length)]
    textEl.textContent = msg
    clarifyEl.hidden = false
    $('feedback-desc').focus()
    return
  }
  $('feedback-clarify').hidden = true
  const btn = $('feedback-submit-btn')
  btn.disabled = true
  btn.textContent = '提交中…'
  try {
    const sess = getSession()
    const resp = await apiJson('POST', '/api/feedback', {
      category,
      description: desc,
      sessionId: sess?.id || null,
      userAgent: navigator.userAgent,
    })
    if (resp.ok) {
      // Show success state
      $('feedback-success').hidden = false
      $('feedback-foot').style.display = 'none'
      $('feedback-desc').parentElement.style.display = 'none'
      $('feedback-category').parentElement.style.display = 'none'
      setTimeout(() => closeModal('feedback-modal'), 2000)
    } else {
      toast(resp.error || '提交失败', 'error')
    }
  } catch (err) {
    toast('提交失败: ' + String(err), 'error')
  } finally {
    btn.disabled = false
    btn.textContent = '提交反馈'
  }
}

// ═══════════════════════════════════════════════════════════
// 5. init() -- THE application bootstrap
// ═══════════════════════════════════════════════════════════

async function init() {
  // Global retry-once for <img>/<audio>/<video> that 401 before the session
  // cookie handshake lands (e.g. the cookie fetch was slow on first boot).
  _installMediaErrorRetry()
  // Central auth-expired handler: any API call that returns 401 funnels here,
  // we tear down local state and show the login screen. Idempotent — only
  // fires once per expiry (see api.js). Skip if we're already on the login
  // view (e.g. login endpoint itself responded 401 with wrong credentials).
  onAuthExpired(() => {
    if (!$('login-view').hidden) return
    toast('登录已过期，请重新登录', 'error')
    _forceLogout()
  })
  // Fired once per tab if IndexedDB is unavailable (private browsing, blocked
  // by another tab during an upgrade, corrupted profile). Sessions still
  // work for the lifetime of this tab via the in-memory fallback in db.js,
  // but the user should know their chat history won't persist across refresh.
  onIdbUnavailable(() => {
    toast('本地存储不可用，当前会话不会保存到本地', 'error')
  })
  // Cross-device sync conflict resolution: when pushSessionToServer hits a
  // 409 and pulls the server version, the in-memory session has been rewritten
  // but the DOM is still rendering the old snapshot. Re-render so the user
  // sees the winning server state immediately instead of after the next full
  // sync tick.
  setSyncDeps({
    onConflictResolved: (sessId) => {
      if (sessId === state.currentSessionId) renderMessages()
      renderSidebar() // title / lastAt may have changed either way
    },
  })
  // Sidebar search
  let _searchDebounce = null
  // Tasks panel toggle
  $('tasks-btn').onclick = (e) => {
    e.stopPropagation()
    const panel = _renderTasksPanel()
    panel.hidden = !panel.hidden
    if (!panel.hidden)
      setTimeout(
        () =>
          document.addEventListener(
            'click',
            () => {
              panel.hidden = true
            },
            { once: true },
          ),
        10,
      )
  }
  $('sidebar-search').addEventListener('input', () => {
    clearTimeout(_searchDebounce)
    _searchDebounce = setTimeout(renderSidebar, 150)
  })
  // Replace hardcoded command-key in HTML with platform-appropriate modifier
  if (!_isMac) {
    document.querySelectorAll('.kbd, kbd').forEach((el) => {
      el.textContent = el.textContent.replace(/\u2318/g, 'Ctrl+')
    })
    $('new-chat-btn')?.setAttribute('title', '新建会话 (Ctrl+N)')
  }
  $('new-chat-btn').onclick = createNewChat
  $('logout-btn').onclick = () => _forceLogout({ serverLogout: true })
  $('theme-btn').onclick = cycleTheme
  $('toggle-sidebar').onclick = () => {
    $('sidebar').classList.toggle('open')
    $('sidebar-backdrop').classList.toggle('open')
  }
  $('sidebar-backdrop').onclick = () => {
    $('sidebar').classList.remove('open')
    $('sidebar-backdrop').classList.remove('open')
  }
  $('agent-select').onchange = (e) => {
    const sess = getSession()
    if (!sess) return
    // Stop in-flight request before switching to prevent late tokens from old agent
    if (state.sendingInFlight) stopCurrentTurn()
    sess.agentId = e.target.value
    // Mark switch time — handleOutbound will ignore frames arriving before this
    sess._agentSwitchedAt = Date.now()
    // Reset streaming state to prevent cross-agent message contamination
    sess._streamingAssistant = null
    sess._streamingThinking = null
    sess._sendingInFlight = false
    clearTurnTiming(sess)
    if (sess._regenSafetyTimer) { clearTimeout(sess._regenSafetyTimer); sess._regenSafetyTimer = null }
    state.sendingInFlight = false
    hideTypingIndicator()
    updateSendEnabled()
    setTitleBusy(false)
    scheduleSaveFromUserEdit(sess)
    toast(`已切换到 ${sess.agentId}`)
  }
  // Settings dropdown
  $('manage-agents-btn').onclick = (e) => {
    e.stopPropagation()
    const dd = $('settings-dropdown')
    dd.hidden = !dd.hidden
    if (!dd.hidden) {
      setTimeout(
        () =>
          document.addEventListener(
            'click',
            () => {
              dd.hidden = true
            },
            { once: true },
          ),
        10,
      )
    }
  }
  document.addEventListener('click', (e) => {
    const btn = e.target.closest?.('[data-settings]')
    if (!btn) return
    const action = btn.dataset.settings
    $('settings-dropdown').hidden = true
    if (action === 'persona') {
      const sess = getSession()
      openPersonaEditor(sess?.agentId || state.defaultAgentId)
    } else if (action === 'agents') openModal('agents-modal')
    else if (action === 'memory') openMemoryModal()
    else if (action === 'skills') openSkillsModal()
    else if (action === 'tasks') openTasksModal()
    else if (action === 'theme') cycleTheme()
    else if (action === 'config') {
      ;(async () => {
        try {
          const cfg = await apiGet('/api/config')
          addSystemMessage(`**当前配置:**\n\`\`\`json\n${JSON.stringify(cfg, null, 2)}\n\`\`\``)
        } catch {
          toast('获取配置失败', 'error')
        }
      })()
    } else if (action === 'changelog') openChangelog()
    else if (action === 'feedback') openFeedbackModal()
    else if (action === 'claude-oauth') openOAuthModal()
    else if (action === 'logout') $('logout-btn').click()
  })
  // Memory modal events
  $('memory-tab-memory').onclick = async () => {
    $('memory-tab-memory').className = 'btn btn-secondary'
    $('memory-tab-user').className = 'btn btn-ghost'
    await loadMemoryTab('memory')
  }
  $('memory-tab-user').onclick = async () => {
    $('memory-tab-user').className = 'btn btn-secondary'
    $('memory-tab-memory').className = 'btn btn-ghost'
    await loadMemoryTab('user')
  }
  $('save-memory-btn').onclick = saveMemory
  $('voice-btn').onclick = toggleVoice
  $('upload-btn').onclick = () => $('file-input').click()
  $('file-input').addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) addFiles(e.target.files)
    e.target.value = ''
  })
  // Drag-drop
  const dropZone = $('messages')
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault()
    dropZone.style.outline = '2px dashed var(--accent)'
  })
  dropZone.addEventListener('dragleave', () => {
    dropZone.style.outline = ''
  })
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault()
    dropZone.style.outline = ''
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files)
  })
  // Paste images from clipboard
  $('input').addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])]
    if (files.length > 0) {
      e.preventDefault()
      addFiles(files)
    }
  })
  // Input events -- single keydown handler for both slash popup and send
  $('input').addEventListener('keydown', (e) => {
    // Slash popup navigation takes priority when visible
    if (slashPopupVisible) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashSelected(Math.min(getSlashSelected() + 1, getSlashMatches().length - 1))
        const popup = $('slash-popup')
        if (popup)
          popup
            .querySelectorAll('.slash-popup-item')
            .forEach((el, i) => el.classList.toggle('active', i === getSlashSelected()))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashSelected(Math.max(getSlashSelected() - 1, 0))
        const popup = $('slash-popup')
        if (popup)
          popup
            .querySelectorAll('.slash-popup-item')
            .forEach((el, i) => el.classList.toggle('active', i === getSlashSelected()))
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && getSlashMatches().length > 0)) {
        e.preventDefault()
        if (getSlashMatches()[getSlashSelected()])
          selectSlashItem(getSlashMatches()[getSlashSelected()])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        hideSlashPopup()
        return
      }
    }
    // Normal Enter -> send (skip during IME composition to avoid CJK input issues)
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      if (state.sendingInFlight) stopCurrentTurn()
      else send()
    }
  })
  $('input').addEventListener('input', () => {
    autoResize()
    const val = $('input').value
    if (val.startsWith('/') && !val.includes('\n') && val.length < 40) {
      showSlashPopup(val)
    } else {
      hideSlashPopup()
    }
  })
  $('input').addEventListener('blur', () => {
    setTimeout(hideSlashPopup, 200)
  })
  $('send').onclick = () => {
    if (state.sendingInFlight) stopCurrentTurn()
    else send()
  }
  // Agents modal
  $('create-agent-btn').onclick = async () => {
    const id = $('new-agent-id').value.trim()
    if (!id) return
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      toast('非法 id', 'error')
      return
    }
    try {
      await apiJson('POST', '/api/agents', { id })
      $('new-agent-id').value = ''
      toast(`已创建 ${id}`, 'success')
      await reloadAgents()
    } catch (err) {
      toast(String(err), 'error')
    }
  }
  // Persona model preset syncs to free-text field
  $('persona-model-preset')?.addEventListener('change', (e) => {
    if (e.target.value) $('persona-model').value = e.target.value
  })
  // Login (username + password → JWT)
  $('login-btn').onclick = async () => {
    const username = $('username').value.trim()
    const password = $('token').value.trim()
    if (!password) return
    $('login-error').style.display = 'none'
    $('login-btn').disabled = true
    $('login-btn').textContent = '登录中…'
    try {
      const resp = await apiFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username || '', password }),
        suppressAuthRedirect: true, // bad credentials → we render inline error, not logout flow
      })
      const data = await resp.json().catch(() => ({}))
      if (!resp.ok) {
        $('login-error').textContent = data.error || '登录失败'
        $('login-error').style.display = 'block'
        return
      }
      state.token = data.token
      localStorage.setItem('openclaude_token', data.token)
      // A fresh login re-arms the auth-expired handler so the *next* token
      // expiry can trigger logout again (it's a one-shot guard per session).
      resetAuthExpired()
      // Clear stale IDB from previous user BEFORE sync to prevent cross-user leakage
      try {
        const stale = await dbGetAll()
        for (const s of stale) await dbDelete(s.id)
      } catch {}
      // Await so the HttpOnly session cookie is in place before any
      // <img>/<audio>/<video> tags get their src set by renderMessages.
      await showApp()
      renderSidebar()
      renderMessages()
      connect()
      reloadAgents()
      loadChangelog()
      // Pull sessions from server for this user (cross-device sync)
      syncSessionsFromServer().then((result) => {
        const updated = [...state.sessions.values()].sort((a, b) => b.lastAt - a.lastAt)
        if (!state.currentSessionId || !state.sessions.has(state.currentSessionId)) {
          state.currentSessionId = updated[0]?.id || null
          if (!state.currentSessionId) createSession()
          renderMessages()
        } else if (result?.needsRenderMessages) {
          renderMessages()
        }
        renderSidebar()
      }).catch(() => {})
      // Check for unclaimed sessions to migrate
      checkUnclaimedSessions()
    } catch {
      $('login-error').textContent = '网络错误，请重试'
      $('login-error').style.display = 'block'
    } finally {
      $('login-btn').disabled = false
      $('login-btn').textContent = '登录'
    }
  }
  $('token').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) $('login-btn').click()
  })
  $('username').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) $('token').focus()
  })
  // Palette input
  $('palette-input').addEventListener('input', (e) => {
    paletteItems = buildPaletteItems(e.target.value)
    paletteSelected = 0
    renderPalette()
  })
  $('palette-input').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (paletteItems.length) {
        paletteSelected = (paletteSelected + 1) % paletteItems.length
        renderPalette()
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (paletteItems.length) {
        paletteSelected = (paletteSelected - 1 + paletteItems.length) % paletteItems.length
        renderPalette()
      }
    } else if (e.key === 'Enter') {
      e.preventDefault()
      paletteItems[paletteSelected]?.run()
    }
  })
  // Global shortcuts — skip when focus is inside form fields (except Cmd/Ctrl+K which is universal)
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey
    if (!mod) return
    const key = e.key.toLowerCase()
    // Cmd/Ctrl+K: always open palette (even from input)
    if (key === 'k') {
      e.preventDefault()
      openPalette()
      return
    }
    // Other shortcuts: skip when typing in input/textarea/contenteditable
    const tag = document.activeElement?.tagName
    const editable = document.activeElement?.isContentEditable
    if (tag === 'INPUT' || tag === 'TEXTAREA' || editable) return
    if (key === 'n') {
      e.preventDefault()
      createNewChat()
    } else if (key === 'm') {
      e.preventDefault()
      openMemoryModal()
    } else if (key === 'b') {
      e.preventDefault()
      $('sidebar').classList.toggle('open')
      $('sidebar-backdrop').classList.toggle('open')
    }
  })

  // Load sessions from IndexedDB
  try {
    const all = await dbGetAll()
    for (const s of all) {
      // Stale turn-state detection: a persisted _sendingInFlight from a
      // long-ago session is dropped; recent ones are kept so UI can restore
      // and the reconnect handshake can settle ownership.
      sanitizeLoadedTurnState(s)
      _rebuildSearchIndex(s)
      state.sessions.set(s.id, s)
    }
  } catch (e) {
    console.warn('IDB load failed', e)
  }
  const arr = [...state.sessions.values()].sort((a, b) => b.lastAt - a.lastAt)
  if (arr.length > 0) state.currentSessionId = arr[0].id
  else createSession()

  if (state.token) {
    // Await so the HttpOnly session cookie is in place before any
    // <img>/<audio>/<video> tags get their src set by renderMessages.
    await showApp()
    renderSidebar()
    renderMessages()
    // Restore in-flight UI for the selected session before ws connects.
    // sanitizeLoadedTurnState() above already cleared stale flags; anything
    // surviving here is a turn interrupted within the freshness window.
    // Without this, users would see a blank window until ws.onopen fires
    // (websocket.js:423 only restores state for the then-current session).
    restoreCurrentSessionInFlightUI()
    connect()
    reloadAgents()
    loadChangelog()
    // Cross-device sync: pull sessions from server in background
    syncSessionsFromServer().then((result) => {
      // Re-render if sessions changed (added or removed) or current session was updated
      const updated = [...state.sessions.values()].sort((a, b) => b.lastAt - a.lastAt)
      let currentChanged = false
      if (!state.currentSessionId || !state.sessions.has(state.currentSessionId)) {
        state.currentSessionId = updated[0]?.id || null
        if (!state.currentSessionId) createSession()
        currentChanged = true
        renderMessages()
      } else if (result?.needsRenderMessages) {
        renderMessages()
      }
      // Sync the typing indicator / title-busy state if the current session
      // was swapped or re-fetched (sync may have replaced the session object
      // with a fresh one whose persisted turn-state differs from what the
      // UI is showing). This is the sync-path counterpart to the initial
      // boot-time restore above.
      if (currentChanged || result?.needsRenderMessages) {
        restoreCurrentSessionInFlightUI()
      }
      renderSidebar()
    }).catch(() => {})
  } else {
    showLogin()
  }

  // Service worker
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {})
    })
  }

  // Periodic time refresh -- update time labels every 30s
  setInterval(() => {
    const s = getSession()
    if (s) updateSessionSub(s)
    document.querySelectorAll('.session-item .session-time-hint').forEach((el) => {
      if (el.dataset.ts) el.textContent = shortTime(Number(el.dataset.ts))
    })
  }, 30000)
}

// ═══════════════════════════════════════════════════════════
// 6. Debug helper
// ═══════════════════════════════════════════════════════════

window.__oc_render = (text) => {
  const inner = ensureInner()
  const wrap = document.createElement('div')
  wrap.className = 'msg assistant'
  wrap.dataset.msgId = `__oc_debug_${Date.now()}`
  wrap.innerHTML = `<div class="avatar">O</div><div class="msg-body">${renderMarkdown(text)}</div>`
  inner.appendChild(wrap)
  processRichBlocks()
}

// ═══════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════

init()
