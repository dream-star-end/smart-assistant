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
import {
  MAX_OFFLINE_QUEUE,
  _clearStoredAccessToken,
  _writeStoredAccessToken,
  getSession,
  isSending,
  setSending,
  state,
  tryEnqueueOffline,
} from './state.js'

// ── API layer ──
import {
  abortInflightRefresh,
  apiFetch,
  apiGet,
  apiJson,
  authHeaders,
  clearProactiveRefresh,
  onAuthExpired,
  resetAuthExpired,
  scheduleProactiveRefresh,
  silentRefresh,
  snapshotDiagnostics,
} from './api.js'

// ── IndexedDB ──
import { dbDelete, dbGetAll, dbPut, onIdbUnavailable, openDB } from './db.js'

// ── Cross-device sync ──
import { maybeSyncNow, setSyncDeps, syncSessionsFromServer } from './sync.js'

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
import {
  closeLightbox,
  closeModal,
  openLightbox,
  openModal,
  toast,
  toastOptsFromError,
} from './ui.js'

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
import {
  maybeNotify,
  refreshDocumentTitle,
  requestNotifyPermission,
  setTitleBusy,
} from './notifications.js'

// ?v= bust:auth.js Turnstile reset 修复,未带 ?v= 导致 CF 边缘 4h max-age 吃住旧版。
// 加上后每次 deploy bump-version 会自动刷新,用户刷新即拉新。
import {
  abortInflightMintClear,
  clearSessionCookie,
  initAuth,
  mintSessionCookie,
  setMode as setAuthMode,
  onLoginSuccess as setAuthSuccessHandler,
} from './auth.js?v=abe05b5'
// ?v=abe05b5 bust: websocket.js now imports billing.js for refreshBalance() after
// outbound.cost_charged frame, and formatMeta switched from $X.XXXX to credits.
// CF edge caches /modules/*.js for up to 1h (gateway sends `public, max-age=3600`);
// without bumped query-strings users get stale billing.js (no refreshBalance export
// = runtime error) or stale websocket.js (still shows $ not 积分).
import { initBilling, isHostAgentAdmin, refreshBalance } from './billing.js?v=abe05b5'
import { onAuthBroadcast, publishLogout, shouldAdoptTokenRefresh } from './broadcast.js?v=abe05b5'
// ── OAuth ──
import { initOAuthListeners, openOAuthModal } from './oauth.js'
// ?v= 带版本:新模块必须跟随 bump-version 刷缓存,避免 CF/SW 里停留旧代码。
import { initUsageStats, openUsageModal } from './usageStats.js?v=abe05b5'
import { clearUserPrefsCache, initUserPrefs, loadUserPrefs, openPrefsModal, setOnPrefsChanged } from './userPrefs.js?v=abe05b5'
import { initWechatListeners, openWechatModal } from './wechat.js'

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
  setRenderModelPill,
} from './agents.js?v=abe05b5' // 2026-04-22 fix: 非 admin 用户 /api/agents 403 兜底 + 隐藏 agent-select

// ── Sessions ──
import {
  _buildSessionItem,
  _rebuildSearchIndex,
  createSession,
  deleteSession,
  enqueueSaveForRetry,
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
  clearTurnTiming,
  completeBgTask,
  connect,
  formatMeta,
  handleOutbound,
  hideTypingIndicator,
  notifyNetworkOffline,
  notifyNetworkOnline,
  notifyTabVisible,
  resetReplyTracker,
  resetThinkingSafety,
  safeWsSend,
  setMeta,
  setProvisioningBanner,
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
import {
  clearEffortOnLogout,
  getEffortForSubmit,
  initModePills,
  renderModePills,
} from './effortMode.js'
import { initModelPicker, renderModelPill } from './modelPicker.js?v=abe05b5'

// Signal to the inline boot-watchdog in index.html that the module graph loaded.
// If ANY static import above fails (typically CF edge cache mismatch after a
// deploy where main.js?v=abe05b5 imports a bare-URL state.js that CF still serves
// old), this line is never reached → watchdog fires at T+15s and self-heals.
window.__ocBooted = true

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
  resetReplyTracker,
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
  if (document.hidden) return
  // 2026-04-23:手机浏览器长时间后台 resume 前的 proactive refresh。
  // access token 快过期或已过期时先刷,再触发 WS 重连 / sessions sync —— 避开多路
  // 并发用旧 token 打请求、撞上 _tearDownWsAuth / _notifyAuthExpired 误踢登录。
  // 写成 async IIFE:不阻塞事件处理器,但在 refresh 期间确保 sync/reconnect 延后。
  void (async () => {
    const nowSec = Math.floor(Date.now() / 1000)
    if (state.token && (!state.tokenExp || state.tokenExp - nowSec < 120)) {
      await silentRefresh().catch(() => false)
    }
    // 等待期间用户可能登出 —— 别在已 teardown 的 state 上继续
    if (!state.token) return
    notifyTabVisible()
    // Pull fresh session list from server. Mobile browsers pause JS when the
    // tab is hidden, so sessions created/updated on another device won't
    // appear until the next full-page init unless we pull here. Throttled
    // inside maybeSyncNow to avoid storms on rapid focus flaps.
    maybeSyncNow({ onResult: _applySyncResult })
  })()
})
// Window focus on desktop (covers alt-tab / click-back-to-window without a
// hidden→visible transition). Same pull semantics.
window.addEventListener('focus', () => {
  maybeSyncNow({ onResult: _applySyncResult })
})
// Network recovery: force a pull regardless of throttle — we want the latest
// list as soon as connectivity is back, even if the last sync was recent
// (it likely failed because we were offline).
window.addEventListener('online', () => {
  maybeSyncNow({ force: true, onResult: _applySyncResult })
})

// Post-sync re-render for the background triggers (visibilitychange / focus /
// online). Invoked only when maybeSyncNow actually ran a sync:
//   - throttle-skipped calls resolve with null WITHOUT dispatching onResult,
//     so this helper never sees that case
//   - list-fetch failures surface here as `undefined` (syncSessionsFromServer's
//     network-error branch returns nothing) — we short-circuit because we have
//     no fresh server state to apply; the UI stays on whatever the last
//     successful sync left behind rather than flashing a stale re-render
//   - a truthy result means server data was merged into state.sessions; we
//     always repaint the sidebar in that case (even if needsRenderMessages is
//     false) since meta-only changes — lastAt ordering, pin state, new remote
//     sessions — still affect the sidebar rendering
// Narrower than the inline versions in init() and the login submit handler:
// those run on first paint and need to repaint unconditionally. Keep in
// sync with init() at main.js:~1740 when its inline logic changes (not
// unified yet to avoid altering boot-path ordering guarantees).
function _applySyncResult(result) {
  if (!result) return
  const updated = [...state.sessions.values()].sort((a, b) => b.lastAt - a.lastAt)
  let currentChanged = false
  if (!state.currentSessionId || !state.sessions.has(state.currentSessionId)) {
    state.currentSessionId = updated[0]?.id || null
    if (!state.currentSessionId) createSession()
    currentChanged = true
    renderMessages()
  } else if (result.needsRenderMessages) {
    renderMessages()
  }
  if (currentChanged || result.needsRenderMessages) {
    restoreCurrentSessionInFlightUI()
  }
  renderSidebar()
}

let _syncBannerTimer = null
function updateSyncIndicator(status) {
  const banner = $('sync-banner')
  if (!banner || !status?.state) return
  const title = $('sync-banner-title')
  const detail = $('sync-banner-detail')
  if (_syncBannerTimer) {
    clearTimeout(_syncBannerTimer)
    _syncBannerTimer = null
  }

  banner.classList.remove('idle', 'syncing', 'synced', 'error')
  banner.classList.add(status.state)
  banner.setAttribute('aria-hidden', status.state === 'idle' ? 'true' : 'false')
  if (title) title.textContent = status.label || '正在同步多端会话'
  if (detail) detail.textContent = status.detail || ''

  if (status.state === 'synced' || status.state === 'error') {
    _syncBannerTimer = setTimeout(() => {
      banner.classList.remove('syncing', 'synced', 'error')
      banner.classList.add('idle')
      banner.setAttribute('aria-hidden', 'true')
    }, status.state === 'error' ? 4500 : 1800)
  }
}
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
    const oldest = [..._errorToastHistory.entries()].sort((a, b) => a[1] - b[1])[0]
    if (oldest) _errorToastHistory.delete(oldest[0])
  }
  toast(`出错了: ${sig}`, 'error')
}

// 2026-04-23 改造:全局 handler 加结构化上下文。
// toast 仍走 _shouldSuppressError 原有静默规则(AbortError/TimeoutError 不骚扰
// 用户,因为调用方通常自己处理了 inline UI),但 console.error 一律详尽打印
// —— 这样 F12 截图就是可用工单,运维看得到"是超时还是 JS 异常"。
window.addEventListener('error', (ev) => {
  const msg = ev.error?.message || ev.message || '未知脚本错误'
  try {
    console.error('[global error]', {
      message: msg,
      name: ev.error?.name,
      filename: ev.filename,
      lineno: ev.lineno,
      colno: ev.colno,
      stack: ev.error?.stack,
    })
  } catch {
    console.error('[global error]', ev.error || ev)
  }
  _showErrorToastOnce(ev.error, msg)
})

window.addEventListener('unhandledrejection', (ev) => {
  const reason = ev.reason
  const msg =
    reason?.message ||
    reason?.error ||
    (typeof reason === 'string' ? reason : null) ||
    '未处理的异步错误'
  try {
    console.error('[unhandled rejection]', {
      message: msg,
      name: reason?.name,
      // 如果 reason 是 Error 抛自 api.js,它带 e.status/code/requestId —— 打进 log
      status: reason?.status,
      code: reason?.code,
      requestId: reason?.requestId,
      stack: reason?.stack,
    })
  } catch {
    console.error('[unhandled rejection]', reason)
  }
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
initWechatListeners()

// ── 思考深度选择器: bind once + render initial visibility ──
// 完整可见性由 agent.model 决定,真正的渲染会在 reloadAgents → renderAgentDropdown
// 内再触发一次;这里只是绑定点击/键盘事件并把初始隐藏态打上去。
initModePills()

// ── 模型选择器(v1.0.4 新增): bind once + 注入 reloadAgents 回调 ──
// 切换成功后内部会调 _reloadAgents() 拉最新 agent.model 进 state,然后再
// renderModelPill / renderModePills。直接传 reloadAgents 避免循环依赖。
// 同时把 renderModelPill 注入回 agents.js,让 reloadAgents 完成后能刷新 pill。
initModelPicker({ reload: reloadAgents })
setRenderModelPill(renderModelPill)

// 2026-04-26 v1.0.4 — prefs modal 保存成功后回调:同时刷 model + effort pill,
// 避免用户在「偏好」里改 default_model / default_effort 后 composer 还显示旧值
// 直到下次刷新。setCachedPrefField 只在 modelPicker pill 单字段切换时用,modal
// 走 PATCH 后已直接覆盖 state.userPrefs;这里只负责"看"。
setOnPrefsChanged(() => {
  renderModelPill()
  renderModePills()
})

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
  const effortLevel = getEffortForSubmit()
  // v1.0.4 — frame.model 从 user prefs 取(C 方案)。空字符串视同未设。
  // server.ts WS 入口对此值做静态白名单兜底,前端无需 validate。
  const _prefModel = state.userPrefs?.default_model
  const modelOverride = (typeof _prefModel === 'string' && _prefModel) ? _prefModel : undefined
  const wsPayload = {
    type: 'inbound.message',
    idempotencyKey: `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    channel: 'webchat',
    peer: { id: sess.id, kind: 'dm' },
    agentId: sess.agentId || state.defaultAgentId,
    content: { text: modelText, media: media.length > 0 ? media : undefined },
    // string='xhigh'/'max' → 切到该 effort;null → 显式清除回模型默认;
    // undefined → 不参与 effort 协商(非 Opus 4.7 agent 走这条)。
    ...(effortLevel !== undefined ? { effortLevel } : {}),
    // string=model id → 触发 runner 切模型(下次 spawn 生效);
    // undefined → 沿用 agent.model。无清除语义(setModel(undefined) 会重置)
    ...(modelOverride !== undefined ? { model: modelOverride } : {}),
    ts: Date.now(),
  }
  // Add user message with status tracking + persist media & full text for regen
  const userMsg = addMessage(sess, 'user', displayText, {
    status: 'sending',
    _media: media.length > 0 ? media : undefined,
    _modelText: modelText !== text ? modelText : undefined, // Full text with attachments for replay
  })
  sess._streamingAssistant = null
  sess._streamingThinking = null
  sess._blockIdToMsgId = new Map()
  sess._agentSwitchedAt = null // Clear switch guard — new send is intentional
  // If offline queue is draining or pending for this session, route through queue
  // to prevent message reordering (new msg arriving before old queued ones)
  const _hasQueuedForSess =
    state.offlineQueue?.some((i) => i.sessId === sess.id) ||
    state._offlineQueuePending?.some((i) => i.sessId === sess.id) ||
    state._offlineDrainingCurrent?.sessId === sess.id
  // 2026-04-22 Codex R1 BLOCKING#1:主发送必须走 safeWsSend。
  // 背压超阈值时 safeWsSend 返回 false 并触发 close→reconnect。此时必须把消息
  // requeue 到 offlineQueue,reconnect 后 drainOfflineQueue 会按序重发 —— 否则
  // 消息在半死 buffer 里永久滞留,UI 已 markStatus='sent' 但 server 没收到。
  let _sentNow = false
  if (state.ws && state.ws.readyState === 1 && !_hasQueuedForSess) {
    _sentNow = safeWsSend(state.ws, JSON.stringify(wsPayload))
  }
  if (_sentNow) {
    userMsg.status = 'sent'
    updateMsgStatus(userMsg)
    setSending(true)
    resetThinkingSafety(sess.id)
    updateSendEnabled()
    showTypingIndicator()
    setTitleBusy(true)
  } else {
    // 三种进来的路径:
    //   (a) ws 未 open / readyState ≠ 1 → 纯离线
    //   (b) _hasQueuedForSess → 已有本 session 排队,保序插队
    //   (c) safeWsSend 返回 false → 背压触发 close,正在 reconnect
    // 统统 push offlineQueue + status='queued',reconnect 后 drain 按序重发。
    // P2-24 软上限 — 超过 200 直接拒收避免无限堆积。
    const enqueued = tryEnqueueOffline({ sessId: sess.id, payload: wsPayload, msgId: userMsg.id })
    if (!enqueued) {
      userMsg.status = 'error'
      updateMsgStatus(userMsg)
      toast(`离线缓冲已满 (${MAX_OFFLINE_QUEUE} 条),请恢复网络后重试`, 'danger')
      $('input').value = ''
      state.attachments = []
      renderAttachments()
      autoResize()
      scheduleSaveFromUserEdit(sess)
      renderSidebar()
      return
    }
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

// V3 商用版多租户安全 PR2:这批 palette action 命中 PR1 firewall 的 host-scope
// 端点,非 admin commercial user 点了只会看到 403。跟 settings-dropdown 同一张
// 用户体验策略 —— admin 可见,其他人隐藏。isHostAgentAdmin() 默认返 false,
// refreshBalance 拉到 user.role==='admin' 时置 true。注意:这只是 UX 过滤,
// 服务端 PR1 仍是真正的安全边界。
const HOST_SCOPED_PALETTE_IDS = new Set([
  'open-memory',
  'open-skills',
  'open-tasks',
  'manage-agents',
])

function buildPaletteItems(query) {
  const q = query.trim().toLowerCase()
  const items = []
  const hostAdmin = isHostAgentAdmin()
  // Actions
  for (const a of paletteActions) {
    if (HOST_SCOPED_PALETTE_IDS.has(a.id) && !hostAdmin) continue
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
            // Drop reply tracker so any stray isFinal from the old agent's
            // aborted turn can't mis-attribute to a fresh turn after switch
            // (parity with the agent-select dropdown handler).
            resetReplyTracker(sess)
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
// M5(P1-7):broadcast 默认绑定 serverLogout —— 只有用户主动点退出才广播。
// reactive 路径(401 teardown、refresh 失败、WS 1008)不广播:本 tab 因 BC 丢失 /
// 早期 userId 缺失 / refresh race 导致 teardown 时,可能 tab A 仍有效会话,广播会
// 误踢 tab A。Codex M5 review:_forceLogout({ serverLogout: false }) 必须不广播。
async function _forceLogout({ serverLogout, broadcast = Boolean(serverLogout) } = {}) {
  if (serverLogout) {
    // V3 commercial: POST /api/auth/logout 用 HttpOnly cookie(oc_rt)定位要吊销的
    // refresh token —— 浏览器自动随同源请求带它。HIGH#4 之前的 body fallback
    // 仅在 state.refreshToken 还残留(老用户 localStorage)时才发,顺便让 server
    // 把残留 cookie 同步清掉。suppressAuthRedirect=true:正在 teardown,401 没意义。
    const legacyToken = state.refreshToken || ''
    apiFetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: legacyToken ? { 'Content-Type': 'application/json' } : undefined,
      body: legacyToken ? JSON.stringify({ refresh_token: legacyToken }) : undefined,
      timeout: 5000,
      suppressAuthRedirect: true,
    }).catch(() => {})
    // V3 file-proxy:清 oc_session cookie(fire-and-forget,Max-Age=0),
    // 否则退出后还能继续用旧 cookie 拉 /api/file,跟 access JWT 的 logout 语义不一致。
    // clearSessionCookie() 内部先 abortInflightMintClear() 阻止潜在在飞的 mint。
    void clearSessionCookie()
  } else {
    // 非 serverLogout 路径(401 teardown):也要中断任何在飞的 mint,防止 mint 响应
    // 回来后 Set-Cookie 把 HttpOnly 旧 cookie 留在浏览器。
    // R4 SHOULD#1:还得 void clearSessionCookie() —— spurious 401 / WS 1008 时
    // access JWT 可能还在 Max-Age 内,不主动清的话 oc_session 会继续让 /api/file
    // 带旧身份访问,跟 UI 已登出语义分裂。fire-and-forget 即可,UI 马上跳 landing。
    abortInflightMintClear()
    void clearSessionCookie()
  }
  localStorage.removeItem('openclaude_token')
  localStorage.removeItem('openclaude_refresh_token')
  // 2026-04-24 "记住我":access token 可能落在 localStorage 或 sessionStorage,
  // 两处都清,防止漏清让下次冷启动又被认证。
  _clearStoredAccessToken()
  // 2026-04-21 安全审计 HIGH#F3:清 per-agent effort pill 缓存,避免同浏览器
  // 切账号时新用户继承老用户的 xhigh/max 选择(服务端 credits 会拦,但 pill
  // 视觉状态会误导用户)。
  clearEffortOnLogout()
  // 2026-04-26 v1.0.4 — 同样清 user prefs 缓存,避免下个用户读到上个用户的
  // default_model / default_effort,导致 sendMessage 帧带错 model id。
  clearUserPrefsCache()
  state.token = '' // Clear token BEFORE close so onclose handler won't auto-reconnect
  state.refreshToken = ''
  state.tokenExp = 0
  state.userId = null
  // 2026-04-22 Codex R3:先 abort 在飞的 refresh(最大限度减少旧 response
  // 里的 Set-Cookie 覆盖未来新账号 oc_rt 的时间窗),再 bump epoch(JS 侧
  // 保险,_doRefreshOnce commit 前比对)。两层防护缺一不可。
  abortInflightRefresh()
  // 清主动续期 timer —— 不然登出后仍会在 2min 后打 /api/auth/refresh。
  clearProactiveRefresh()
  state.authEpoch = (state.authEpoch || 0) + 1
  // Rearm the auth-expired one-shot so a future session expiry can trigger
  // the logout flow again. login success also does this, but doing it here
  // too keeps the semantics symmetric across both teardown paths.
  resetAuthExpired()
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer)
    state.reconnectTimer = null
  }
  if (state.reconnectCountdown) {
    clearInterval(state.reconnectCountdown)
    state.reconnectCountdown = null
  }
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
  // 2026-04-27:容器初始化 banner 是上一身份的 ws 容器状态信号,logout 后必须清,
  // 否则跳到 landing 还闪着"环境初始化中…"完全不合语义。
  setProvisioningBanner(false)
  // 2026-04-25:logout teardown 才清登录密码字段(不在 showLogin 清,以保留浏览器
  // 密码管理器自动填充的值)。手输未保存的密码不应跨 logout 残留在 DOM。
  // email 不清 — 用户登出后再登录通常还是同一邮箱,保留减少摩擦。
  const _pwEl = $('auth-login-password')
  if (_pwEl) _pwEl.value = ''
  // Clear IndexedDB to prevent cross-user data leakage on shared browsers
  try {
    const all = await dbGetAll()
    for (const s of all) await dbDelete(s.id)
  } catch {}
  if (state.ws) state.ws.close(1000)
  // M5(P1-7):通知同源其他 tab 一起切登录态。broadcast=false 表示本次 teardown
  // 由对端广播触发(避免风暴 / 二次广播)。fire-and-forget。
  if (broadcast) {
    try {
      publishLogout()
    } catch {}
  }
  // 2026-04-22:过期后回营销首页 (landing),而不是硬跳 /login —— 用户看到
  // "/" 被强制变 "/login" 会困惑。landing 顶栏已有「登录」按钮,想继续用的
  // 用户一键就能进。landing-view 不存在 (老模板) 才 fallback showLogin()。
  if ($('landing-view')) showLanding()
  else showLogin()
}

// URL routing helpers.
//
// Problem before this: all three views (landing / login / app) shared the same
// path `/`, so clicking "登录" from landing seemed to "莫名跳到登录页" —— the URL
// never changed and the browser back button was inert. Now we maintain:
//   /        → landing (cold) or app (logged in)
//   /login   → login view
// Each show*() callee syncs the URL via pushState (or replaceState when already
// matched) so history + reloads respect the current view. A popstate handler
// re-routes when the user hits back/forward.
function _syncPath(target, { replace = false } = {}) {
  try {
    const cur = window.location.pathname + window.location.search + window.location.hash
    const qh = window.location.search + window.location.hash
    const next = target + qh
    if (cur === next) return
    if (replace) window.history.replaceState(null, '', next)
    else window.history.pushState(null, '', next)
  } catch {
    /* history API unavailable in exotic sandboxes — don't block the view switch */
  }
}

function showLogin() {
  _syncPath('/login')
  $('login-view').hidden = false
  $('app-view').hidden = true
  if ($('landing-view')) $('landing-view').hidden = true
  document.body.classList.remove('body-landing')
  if ($('login-error')) $('login-error').hidden = true
  // Clear v3 commercial auth-mode form fields if present.
  // 2026-04-25:故意不清 auth-login-email / auth-login-password —— 让浏览器密码管理器
  // 自动填的值能保留下来。手输密码的残留在 _forceLogout() 里清(logout teardown 才清,
  // 进入登录页的常规路径不清)。register/forgot/reset 字段保持清空(草稿数据残留防御)。
  for (const id of [
    'auth-register-email',
    'auth-register-password',
    'auth-register-confirm',
    'auth-forgot-email',
    'auth-reset-password',
    'auth-reset-confirm',
  ]) {
    const el = $(id)
    if (el) el.value = ''
  }
  // Reset post-submit success panels back to form state
  for (const [formId, successId] of [
    ['auth-register-form', 'auth-register-success'],
    ['auth-forgot-form', 'auth-forgot-success'],
    ['auth-reset-form', 'auth-reset-success'],
  ]) {
    if ($(formId)) $(formId).hidden = false
    if ($(successId)) $(successId).hidden = true
  }
  if ($('auth-login-resend-row')) $('auth-login-resend-row').hidden = true
  if ($('auth-login-resend-status')) {
    $('auth-login-resend-status').hidden = true
    $('auth-login-resend-status').textContent = ''
  }
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
  // Default back to login mode (auth.js handles tab visuals)
  try {
    setAuthMode('login')
  } catch {}
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
  // replace (not push) so back-from-app skips the intermediate /login step —
  // going back from a logged-in session should land on wherever the user
  // came from (landing), not on a login form they no longer need.
  _syncPath('/', { replace: true })
  $('login-view').hidden = true
  $('app-view').hidden = false
  if ($('landing-view')) $('landing-view').hidden = true
  document.body.classList.remove('body-landing')
  await _ensureSessionCookie()
}

// ───────── Landing page (cold-visitor marketing surface) ─────────
let _landingDataLoaded = false
function _ktokToCreditsPretty(creditsPerKtok) {
  // Backend's /api/public/models returns *_per_ktok_credits as "分 per 1000 tok"
  // but BIASED by a factor of 100 under the legacy "1 积分 = ¥1 = 100 分" semantic
  // (see packages/commercial/src/billing/pricing.ts → perKtokCredits, which divides
  // by 100_000 = 1_000 × 100). For Opus 4.7 input (500 分/Mtok × 2.0 mul) the API
  // returns "0.010000" meaning "¥0.01 / 1K tok".
  //
  // 2026-04-21 展示口径改为「1 积分 = 1 分 = ¥0.01」—— 同样的 Opus 4.7 input 现在
  // 应显示为 "1 积分 / 1K tok"。换算:新单位 = 旧值 × 100 (¥ → 分 = 积分)。
  //
  // 未改后端公式以保持 API 契约兼容,仅在前端做 × 100 转换。Stable 小数位四舍五入
  // 到最多 3 位(1.000 → "1"、0.600 → "0.6"、0.075 → "0.075")。
  const n = Number(creditsPerKtok)
  if (!Number.isFinite(n)) return '—'
  if (n === 0) return '0'
  const credits = n * 100
  // up to 3 decimals, trim trailing zeros
  return credits.toFixed(3).replace(/\.?0+$/, '')
}
function _modelTagFor(id) {
  if (/opus/i.test(id)) return '旗舰推理'
  if (/sonnet/i.test(id)) return '日常对话'
  return '通用'
}
async function _loadLandingData() {
  if (_landingDataLoaded) return
  _landingDataLoaded = true
  // Models
  ;(async () => {
    const wrap = $('landing-models')
    if (!wrap) return
    try {
      const r = await apiFetch('/api/public/models', { suppressAuthRedirect: true })
      const j = await r.json().catch(() => ({}))
      const models = Array.isArray(j?.models) ? j.models : []
      if (models.length === 0) {
        wrap.innerHTML = '<div class="landing-models-loading">暂无可用模型</div>'
        return
      }
      wrap.innerHTML = models
        .map((m) => {
          const name = htmlSafeEscape(m.display_name || m.id || '')
          const id = htmlSafeEscape(m.id || '')
          const tag = htmlSafeEscape(_modelTagFor(m.id || ''))
          const inP = _ktokToCreditsPretty(m.input_per_ktok_credits)
          const outP = _ktokToCreditsPretty(m.output_per_ktok_credits)
          const cacheR = _ktokToCreditsPretty(m.cache_read_per_ktok_credits)
          const cacheW = _ktokToCreditsPretty(m.cache_write_per_ktok_credits)
          return `
          <div class="landing-model">
            <div class="landing-model-head">
              <div>
                <div class="landing-model-name">${name}</div>
                <div class="landing-model-id">${id}</div>
              </div>
              <span class="landing-model-tag">${tag}</span>
            </div>
            <div class="landing-model-prices">
              <div class="landing-model-price">
                <span class="landing-model-price-label">输入</span>
                <span class="landing-model-price-val">${inP} <span class="unit">积分 / 1K tok</span></span>
              </div>
              <div class="landing-model-price">
                <span class="landing-model-price-label">输出</span>
                <span class="landing-model-price-val">${outP} <span class="unit">积分 / 1K tok</span></span>
              </div>
              <div class="landing-model-price">
                <span class="landing-model-price-label">缓存读</span>
                <span class="landing-model-price-val">${cacheR} <span class="unit">积分 / 1K tok</span></span>
              </div>
              <div class="landing-model-price">
                <span class="landing-model-price-label">缓存写</span>
                <span class="landing-model-price-val">${cacheW} <span class="unit">积分 / 1K tok</span></span>
              </div>
            </div>
          </div>
        `
        })
        .join('')
    } catch {
      wrap.innerHTML = '<div class="landing-models-loading">加载失败,请刷新重试</div>'
    }
  })()
  // Plans
  ;(async () => {
    const wrap = $('landing-plans')
    if (!wrap) return
    try {
      const r = await apiFetch('/api/payment/plans', { suppressAuthRedirect: true })
      const j = await r.json().catch(() => ({}))
      const plans = Array.isArray(j?.data?.plans) ? j.data.plans : []
      if (plans.length === 0) {
        wrap.innerHTML = '<div class="landing-models-loading">暂无充值方案</div>'
        return
      }
      // Featured = "plan-200" (best ratio of bonus + accessible price)
      const featuredCode = 'plan-200'
      wrap.innerHTML = plans
        .map((p) => {
          const yuan = Math.round(Number(p.amount_cents) / 100)
          // 积分单位:1 元 = 100 积分 = $1 美元 = 100 美分。
          // p.credits 是 raw cents,直接当积分数显示。
          const credits = Math.round(Number(p.credits))
          const baseCredits = yuan * 100
          const bonusCredits = credits - baseCredits
          const bonusPct = baseCredits > 0 ? Math.round((bonusCredits / baseCredits) * 100) : 0
          const featured = p.code === featuredCode
          return `
          <div class="landing-plan${featured ? ' landing-plan-featured' : ''}">
            <div class="landing-plan-amount"><span class="yuan">¥</span>${yuan}</div>
            <div class="landing-plan-credits">${credits.toLocaleString('zh-CN')} 积分</div>
            <div class="landing-plan-bonus">${bonusCredits > 0 ? `多送 ${bonusCredits.toLocaleString('zh-CN')} 积分 (+${bonusPct}%)` : '基础档'}</div>
          </div>
        `
        })
        .join('')
    } catch {
      wrap.innerHTML = '<div class="landing-models-loading">加载失败,请刷新重试</div>'
    }
  })()
}
function showLanding() {
  if (!$('landing-view')) {
    showLogin()
    return
  }
  _syncPath('/')
  $('landing-view').hidden = false
  $('login-view').hidden = true
  $('app-view').hidden = true
  // Body baseline is overflow:hidden + height:100dvh for the chat SPA;
  // landing needs auto height + scrollable body to expose all sections.
  document.body.classList.add('body-landing')
  _loadLandingData()
  // Smooth scroll to top so cross-page anchor returns to hero
  try {
    window.scrollTo({ top: 0, behavior: 'instant' })
  } catch {
    window.scrollTo(0, 0)
  }
}
function _wireLandingButtons() {
  const lv = $('landing-view')
  if (!lv) return
  const goRegister = () => {
    showLogin()
    try {
      setAuthMode('register')
    } catch {}
  }
  const goLogin = () => {
    showLogin()
    try {
      setAuthMode('login')
    } catch {}
  }
  ;['landing-register-btn', 'landing-hero-register-btn', 'landing-foot-register-btn'].forEach(
    (id) => {
      $(id)?.addEventListener('click', goRegister)
    },
  )
  ;['landing-login-btn', 'landing-hero-login-btn'].forEach((id) => {
    $(id)?.addEventListener('click', goLogin)
  })
  $('landing-theme-btn')?.addEventListener('click', () => {
    try {
      cycleTheme()
    } catch {}
  })
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
    item.style.cssText =
      'display:flex;gap:var(--space-2);padding:var(--space-2) 0;border-bottom:1px solid var(--border);cursor:pointer;align-items:flex-start'
    const date = new Date(s.lastAt).toLocaleString('zh-CN', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
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
      if (vEl) vEl.textContent = _changelogData.currentVersion
    }
    // 2026-04-21 安全审计 HIGH#F1 修复:用户桶原用 state.token 末 8 字节,
    // 但 JWT 每次 refresh 会换,导致同一用户的"已读"状态反复丢失;更糟的是
    // 首次进入(token 为空)时会落到 `openclaude_changelog_seen_`(空后缀)
    // 这个共享 key,跨账号串到同一个桶。改用 billing.refreshBalance 写入的
    // 稳定 state.userId;拿不到 user.id(未登录 / commercial 未启用 / /api/me
    // 还没返回)时直接跳过"已读"判断,只显示版本号,避免污染 localStorage。
    const _uid = state.userId ? String(state.userId) : ''
    if (_uid && _changelogData.currentVersion) {
      const _userKey = `openclaude_changelog_seen_${_uid}`
      const lastSeen = localStorage.getItem(_userKey)
      if (lastSeen !== _changelogData.currentVersion && _changelogData.releases?.length > 0) {
        const badge = $('changelog-badge')
        if (badge) {
          badge.hidden = false
          badge.textContent = 'NEW'
        }
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
    content.innerHTML = _changelogData.releases
      .map(
        (r, i) => `
      <div class="changelog-entry${i === 0 ? ' latest' : ''}">
        <div class="changelog-entry-head">
          <span class="changelog-version-tag">${htmlSafeEscape(r.version)}</span>
          <span class="changelog-date">${htmlSafeEscape(r.date)}</span>
        </div>
        <h4 class="changelog-title">${htmlSafeEscape(r.title)}</h4>
        <ul class="changelog-list">
          ${r.items.map((h) => `<li>${htmlSafeEscape(h)}</li>`).join('')}
        </ul>
      </div>
    `,
      )
      .join('')
    versionEl.textContent = `当前版本 ${_changelogData.currentVersion}`
  }
  // Mark as seen (scoped by stable user.id; 未登录用户不写入避免 key 污染)
  if (_changelogData?.currentVersion && state.userId) {
    const _userKey = `openclaude_changelog_seen_${String(state.userId)}`
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
    const msg =
      FEEDBACK_CLARIFY_MESSAGES[Math.floor(Math.random() * FEEDBACK_CLARIFY_MESSAGES.length)]
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
    // P1-1 (2026-04-25):附诊断上下文给 admin 反查。_diagBuffer 存最近 50 条 API
    // 错误,这里取最后 5 条;request_id 取这 5 条里有的 requestId 去重前 10 个。
    const diag = snapshotDiagnostics()
    const lastErrors = diag.slice(-5).map((e) => ({
      ts: e.ts,
      route: e.route,
      status: e.status,
      code: e.code,
      message: e.message,
      requestId: e.requestId,
    }))
    const requestIds = Array.from(new Set(diag.map((e) => e.requestId).filter(Boolean))).slice(-10)
    const swCtl =
      typeof navigator !== 'undefined' && navigator.serviceWorker
        ? navigator.serviceWorker.controller
        : null
    const meta = {
      last_api_errors: lastErrors,
      request_ids: requestIds,
      current_route: window.location.pathname + window.location.search + window.location.hash,
      sw_active: !!swCtl,
      sw_state: swCtl?.state ?? null,
      ts: new Date().toISOString(),
    }
    const resp = await apiJson('POST', '/api/feedback', {
      category,
      description: desc,
      // 后端字段命名:snake_case (与 admin/feedback.ts 入参一致)
      session_id: sess?.id || null,
      user_agent: navigator.userAgent,
      version: (_changelogData && _changelogData.currentVersion) || null,
      meta,
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
    toast('提交失败: ' + String(err), 'error', toastOptsFromError(err))
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
  //
  // `mode` ('local-dominates' | 'server-wins') distinguishes the two resolver
  // branches in sync.js.
  //   - server-wins: sess.messages was overwritten → full renderMessages().
  //   - local-dominates: sess.messages is PRESERVED; only title / pinned /
  //     agentId / lastAt may have been adopted from server. Doing a full
  //     renderMessages() here is both wasted work and a visible flicker on
  //     long streaming turns (a single turn can legitimately fire several
  //     409s in a row). Instead, refresh just the stale metadata surfaces:
  //     pane header title + subtitle (both normally set inside renderMessages),
  //     plus the agent dropdown (reflects sess.agentId).
  setSyncDeps({
    onSyncStatusChange: updateSyncIndicator,
    onConflictResolved: (sessId, mode) => {
      if (sessId === state.currentSessionId) {
        const s = state.sessions.get(sessId)
        // Empty-state branding (messages.js:1653) is rendered only when
        // s.messages.length === 0 and depends on s.agentId. _localDominates
        // returns true for two empty arrays, so empty sessions CAN reach
        // local-dominates with an adopted agentId. Fall back to a full
        // renderMessages() in that case — no flicker concern because empty
        // sessions don't stream.
        const isEmpty = !s || s.messages.length === 0
        if (mode === 'server-wins' || isEmpty) {
          renderMessages()
        } else {
          // local-dominates with non-empty messages: patch header without
          // wiping the messages pane DOM (messages.js:1638).
          $('session-title').textContent = s.title
          updateSessionSub(s)
        }
        // Agent selector / mode pills / research tools only refresh via
        // renderAgentDropdown() (agents.js:21). Every branch here may have
        // adopted s.agentId from the server (both server-wins and
        // local-dominates mutate it), so we always re-run it on the current
        // session — renderMessages() does NOT sync #agent-select.
        renderAgentDropdown()
        // Browser tab title tracks sess.title but must not clobber the
        // "思考中..." indicator if the turn is still in flight.
        refreshDocumentTitle()
      }
      renderSidebar() // title / lastAt may have changed either way
    },
    // 409 local-dominates path requests a follow-up PUT carrying the
    // refreshed _baseSyncedAt pulled during the conflict resolution.
    // enqueueSaveForRetry chains one extra _doSave without touching
    // lastAt or retry budget (retry is not a user edit).
    onRequestRetryPush: (sessId) => enqueueSaveForRetry(sessId),
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
    // 思考深度选择器跟着新 agent 的 model 走 — 切到非 Opus 4.7 自动隐藏,
    // 选中态按新 agent 的 localStorage 读。
    renderModePills()
    // Mark switch time — handleOutbound will ignore frames arriving before this
    sess._agentSwitchedAt = Date.now()
    // Reset streaming state to prevent cross-agent message contamination
    sess._streamingAssistant = null
    sess._streamingThinking = null
    sess._sendingInFlight = false
    // Drop reply tracker so a late isFinal from the old agent doesn't bind to
    // a new user message on the switched-to agent.
    resetReplyTracker(sess)
    clearTurnTiming(sess)
    if (sess._regenSafetyTimer) {
      clearTimeout(sess._regenSafetyTimer)
      sess._regenSafetyTimer = null
    }
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
    else if (action === 'wechat') openWechatModal()
    else if (action === 'prefs') openPrefsModal()
    else if (action === 'usage') openUsageModal()
    else if (action === 'admin') {
      // V3 Phase 4E:打开超管控制台。新窗口避免覆盖正在进行的对话。
      // 后端 /api/admin/* + 前端 admin.js 都会再校验一次 role,这里只是入口。
      window.open('/admin.html', '_blank', 'noopener,noreferrer')
    } else if (action === 'logout') $('logout-btn').click()
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
      toast(String(err), 'error', toastOptsFromError(err))
    }
  }
  // Persona model preset syncs to free-text field
  $('persona-model-preset')?.addEventListener('change', (e) => {
    if (e.target.value) $('persona-model').value = e.target.value
  })
  // ── V3 commercial auth (Phase 4A → 2026-04-21 HIGH#4) ──
  // 多模态登录(login/register/forgot/reset/verify)+ Turnstile 由 modules/auth.js 接管。
  // main.js 只负责"登录成功后该做什么"——清 IDB、装 access token、连 ws、起 app view。
  // refresh token 由 server 通过 Set-Cookie(HttpOnly oc_rt)下发,JS 读不到,这里
  // 也不要尝试读 refresh_token 字段(后端已经从响应里拿掉)。
  setAuthSuccessHandler(async ({ access_token, access_exp, remember }) => {
    // 2026-04-22 Codex R3:login 前先 abort 可能在飞的 refresh(防止旧身份的
    // Set-Cookie 覆盖新账号刚拿到的 oc_rt),再写新 state.token + bump epoch。
    abortInflightRefresh()
    state.token = access_token
    state.tokenExp = Number(access_exp) || 0
    // bump authEpoch —— 让任何在此之前起的 silentRefresh() 在它的响应回来时
    // 不再敢把 state.token 覆写(那是上一个身份的 refresh 结果,旧 refresh
    // token 已经在 server 端 rotate,新 access 可能串号)。
    state.authEpoch = (state.authEpoch || 0) + 1
    // 主动清掉老版本可能残留的 localStorage refresh token —— 一旦走完一次新版
    // login,旧 token 既无用又是 XSS 攻击面,立刻零化。
    state.refreshToken = ''
    try {
      localStorage.removeItem('openclaude_refresh_token')
    } catch {}
    // 2026-04-24 "记住我":remember=true(默认)→ localStorage(持久),
    // false → sessionStorage(关窗口即清,与 cookie 同生命周期)。
    _writeStoredAccessToken(access_token, access_exp, remember !== false)
    // Re-arm 401 handler — next token expiry will fire it again.
    resetAuthExpired()
    // V3 file-proxy 身份切换 race 硬化(Codex R2 BLOCKER):先 await 清旧 oc_session,
    // 再 await mint 新身份 cookie,然后才继续 showApp/renderMessages。
    // 原因:浏览器 Set-Cookie 在 response header 到达时就被应用,AbortController
    // 没法在 header 已到后撤回;所以必须用"反向操作"——清后再种——保证进入 app
    // 之前 HttpOnly oc_session 一定是当前身份。否则冷启动/切账号那几百 ms 内
    // <img src="/api/file?..."> 原生请求会捎旧 cookie 跑到 HOST → 按旧身份代理
    // 到旧容器 → 跨用户泄漏。clearSessionCookie 内部带 AbortController,中断的是
    // 先前 mint 的 signal;它自身发出的 clear 会正常到达 server 落盘 Max-Age=0。
    try {
      await clearSessionCookie()
    } catch {}
    try {
      await mintSessionCookie(access_token, state.authEpoch)
    } catch {}
    // 启动主动续期 timer,见 init() 的注释。
    scheduleProactiveRefresh()
    // Clear stale IDB from previous user BEFORE sync to prevent cross-user leakage.
    try {
      const stale = await dbGetAll()
      for (const s of stale) await dbDelete(s.id)
    } catch {}
    // 2026-04-26 v1.0.4 — 拉取用户偏好(default_model / default_effort 等)给
    // composer 顶部的 model/effort pill 用。await 让 connect() 之前 prefs 已就位,
    // 否则 sendMessage 帧里 frame.model 就漏了 → 第一条消息按 agent 默认模型走。
    // 失败 fallback 已在 loadUserPrefs 内部处理(state.userPrefs={}),不会卡登录。
    clearUserPrefsCache()
    await loadUserPrefs(true)
    await showApp()
    renderSidebar()
    renderMessages()
    connect()
    reloadAgents()
    loadChangelog()
    refreshBalance().catch(() => {})
    syncSessionsFromServer()
      .then((result) => {
        const updated = [...state.sessions.values()].sort((a, b) => b.lastAt - a.lastAt)
        if (!state.currentSessionId || !state.sessions.has(state.currentSessionId)) {
          state.currentSessionId = updated[0]?.id || null
          if (!state.currentSessionId) createSession()
          renderMessages()
        } else if (result?.needsRenderMessages) {
          renderMessages()
        }
        renderSidebar()
        // 2026-04-22:agents + sessions 两条 fetch 在 login 后并发起飞,谁先谁后
        // 决定了 renderModePills 首次跑时 state.currentSessionId 是否已定。如果
        // sessions 后到,reloadAgents 里的 renderModePills 拿不到有效 sess →
        // getCurrentAgentModel 返回 '' → 思考深度选择器一直 hidden,直到用户手动
        // 刷新页面。兜底:sessions sync 完成后再 render 一次,让 selector 补显。
        renderModePills()
      })
      .catch(() => {})
    checkUnclaimedSessions()
  })
  initAuth()
  // M5(P1-7):多 tab 认证状态同步。同浏览器同源的其他 tab 退出 / 刷新 token 时,
  // 本 tab in-place 跟进,免去 reactive 401 → 重登流程。
  // 严格同身份校验(userId)+ stale guard(access_exp 必须新于本 tab 当前 tokenExp)。
  onAuthBroadcast((msg) => {
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'logout') {
      // 对端已经 server logout 过,本地仅做 teardown。broadcast:false 避免再发出去
      // 触发风暴,也避免对端反复收到自己的回声(BC 标准上不会,storage fallback 可能会)。
      void _forceLogout({ serverLogout: false, broadcast: false })
      return
    }
    if (msg.type === 'token_refresh') {
      // 五重校验全收敛在 shouldAdoptTokenRefresh —— 单元测试覆盖。
      if (!shouldAdoptTokenRefresh(state, msg)) return
      state.token = msg.access_token
      state.tokenExp = msg.access_exp
      try {
        _writeStoredAccessToken(msg.access_token, msg.access_exp, msg.remember !== false)
      } catch {}
      try {
        scheduleProactiveRefresh()
      } catch {}
      // file-proxy session cookie 也跟着续期。绑当前 epoch,与 reactive 路径一致。
      void mintSessionCookie(msg.access_token, state.authEpoch || 0).catch(() => {})
    }
  })
  initBilling()
  initUserPrefs()
  initUsageStats()
  _wireLandingButtons()
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
      // PR2: Ctrl/Cmd+M → Memory modal 同样命中 PR1 firewall 会 403 的 host-scope
      // /api/agents/:id/memory/*,非 admin 直接吞按键不弹 modal(同 palette / slash
      // / settings 一张表)。
      if (!isHostAgentAdmin()) return
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
    // 2026-04-23:冷启动 proactive refresh。localStorage 里的 access token 极可能
    // 已过期(手机浏览器长时间后台导致),若直接走 mintSessionCookie / connect() 会
    // 撞一堆 401/1008,多路并发可能误踢登录。先做一次 silentRefresh,拿新 access
    // 再继续下游流程。失败不 teardown —— 保留旧 token 给 reactive 路径再试一次,
    // 真 cookie 丢了才走 _forceLogout。
    const nowSec = Math.floor(Date.now() / 1000)
    if (!state.tokenExp || state.tokenExp - nowSec < 60) {
      await silentRefresh().catch(() => false)
    }
    // V3 file-proxy:冷启动 state.token 从 localStorage 恢复,但 oc_session cookie
    // 可能已过期(或跨浏览器清理),renderMessages 里 <img src="/api/file?..."> 会
    // 因没 cookie 被 firewall 403。await mint —— 小概率 renderMessages 会立刻用到
    // 图片 src,先把 cookie 种上再展示,避免首次 paint 里的 403 闪红。
    // 传 state.authEpoch 做 self-heal:冷启动瞬间 epoch 一般不会变,兜底处理。
    await mintSessionCookie(state.token, state.authEpoch || 0)
    // 启动后台 timer:access token 到期前 2min 主动续期,只要 tab 活着就不掉线。
    scheduleProactiveRefresh()
    // 2026-04-26 v1.0.4 — 冷启动 prefetch 用户偏好(同登录路径)。必须在 connect()
    // 之前完成,sendMessage 才能把 default_model 塞进首帧。失败兜底见 loadUserPrefs。
    await loadUserPrefs(true)
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
    refreshBalance().catch(() => {})
    // Cross-device sync: pull sessions from server in background
    syncSessionsFromServer()
      .then((result) => {
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
      })
      .catch(() => {})
  } else {
    // Cold visitor (no token):
    //  - URL-driven flows (?verify_email / ?reset_password / explicit ?login=1)
    //    skip landing and jump straight into the auth view.
    //  - Pathname `/login` (shareable URL 2026-04-21+) also forces the auth view.
    //  - Otherwise show the marketing landing page; user clicks CTA → login-view.
    const sp = new URLSearchParams(window.location.search)
    const goStraightToAuth =
      window.location.pathname === '/login' ||
      sp.has('verify_email') ||
      sp.has('reset_password') ||
      sp.has('login') ||
      sp.has('register') ||
      sp.has('signin') ||
      sp.has('signup')
    if (goStraightToAuth) {
      showLogin()
      if (sp.has('register') || sp.has('signup')) {
        try {
          setAuthMode('register')
        } catch {}
      }
    } else {
      showLanding()
    }
  }

  // Popstate: browser back/forward button must round-trip between landing
  // and login when the user pivoted via CTA. We re-derive the view from
  // the new pathname + token state. showApp/showLanding/showLogin internally
  // call _syncPath(), but _syncPath() no-ops when the URL already matches —
  // so re-entering isn't double-pushing history entries.
  window.addEventListener('popstate', () => {
    if (window.location.pathname === '/login') {
      if (!$('login-view').hidden) return // already showing login
      showLogin()
      return
    }
    // `/` (or any other) path: app if logged in, else landing
    if (state.token) {
      if (!$('app-view').hidden) return
      showApp().catch(() => {})
    } else {
      if ($('landing-view') && !$('landing-view').hidden) return
      showLanding()
    }
  })

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
