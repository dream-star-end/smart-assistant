// Official Claude Code terminal modal.
// Runs the official `claude` CLI inside a gateway-owned PTY over /ws/claude-terminal.
import { apiJson } from './api.js'
import { $ } from './dom.js'
import { state } from './state.js'
import { closeModal, openModal, toast } from './ui.js'

const MODAL_ID = 'claude-terminal-modal'
const CONTAINER_ID = 'claude-terminal-container'
const SCROLL_CAPTURE_ID = 'claude-terminal-scroll-capture'
const STATUS_ID = 'claude-terminal-status'
const KILL_BTN_ID = 'claude-terminal-kill-btn'
const RECONNECT_BTN_ID = 'claude-terminal-reconnect-btn'
const NEW_OUTPUT_BTN_ID = 'claude-terminal-new-output-btn'
const MOBILE_INPUT_ID = 'claude-terminal-mobile-input'
const MOBILE_SEND_BTN_ID = 'claude-terminal-mobile-send-btn'
const MOBILE_FOCUS_BTN_ID = 'claude-terminal-mobile-focus-btn'
const MOBILE_HISTORY_PREV_BTN_ID = 'claude-terminal-history-prev-btn'
const MOBILE_HISTORY_NEXT_BTN_ID = 'claude-terminal-history-next-btn'
const WAKE_LOCK_BTN_ID = 'claude-terminal-wake-lock-btn'
const CLOSE_SELECTOR = '[data-claude-terminal-close]'
const MAX_TERMINAL_INPUT_BYTES = 32 * 1024
const RECONNECT_ATTEMPT_MIN_MS = 1500
const MOBILE_COMMAND_HISTORY_KEY = 'openclaude:claude-terminal:mobile-command-history'
const MAX_MOBILE_COMMAND_HISTORY = 20
const QUICK_KEYS = {
  enter: '\r',
  tab: '\t',
  'ctrl-c': '\x03',
  esc: '\x1b',
  up: '\x1b[A',
  down: '\x1b[B',
}

let TerminalCtor = null
let FitAddonCtor = null
let terminal = null
let fitAddon = null
let socket = null
let resizeObserver = null
let terminalScrollDisposable = null
let reconnectRequested = false
let initialized = false
let lastMobileControlPointerAt = 0
let terminalTouchScrollY = null
let terminalTouchScrollRemainder = 0
let terminalTouchScrollTargets = []
let terminalScrollCaptureCleanup = null
let terminalScrollPointerId = null
let terminalScrollPointerTarget = null
let terminateInFlight = false
let lastReconnectAttemptAt = 0
let mobileCommandHistory = []
let mobileCommandHistoryCursor = null
let mobileCommandHistoryDraft = ''
let wakeLockSentinel = null
let wakeLockWanted = false

function byteLength(text) {
  return new TextEncoder().encode(text).length
}

function statusLabel(stateName, fallback = '') {
  if (stateName === 'connecting') return '连接中'
  if (stateName === 'running') return '运行中'
  if (stateName === 'closed') return '已关闭'
  if (stateName === 'error') return '错误'
  if (stateName === 'disabled') return '已禁用'
  if (stateName === 'exited') return '进程已退出'
  return fallback || '未连接'
}

function setStatus(stateName, message = '') {
  const el = $(STATUS_ID)
  if (!el) return
  el.dataset.state = stateName || 'idle'
  el.textContent = message ? `${statusLabel(stateName)} · ${message}` : statusLabel(stateName)
}

function terminalStatusState() {
  return $(STATUS_ID)?.dataset.state || 'idle'
}

async function ensureTerminalDeps() {
  if (TerminalCtor && FitAddonCtor) return
  const [xterm, fit] = await Promise.all([
    import('/vendor/xterm/xterm.js'),
    import('/vendor/xterm/addon-fit.js'),
  ])
  TerminalCtor = xterm.Terminal
  FitAddonCtor = fit.FitAddon
}

function cssVar(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

function createTerminal() {
  disposeTerminal()
  terminal = new TerminalCtor({
    cursorBlink: true,
    convertEol: false,
    fontFamily: cssVar('--font-mono', 'ui-monospace, SFMono-Regular, Menlo, monospace'),
    fontSize: 13,
    scrollback: 4000,
    theme: {
      background: cssVar('--bg', '#111111'),
      foreground: cssVar('--fg', '#f2f2f2'),
      cursor: cssVar('--accent', '#d97757'),
      selectionBackground: cssVar('--accent-border', 'rgba(217,119,87,0.35)'),
      black: '#000000',
      red: '#d14d41',
      green: '#5ca66b',
      yellow: '#c99a2e',
      blue: '#4f8fd9',
      magenta: '#b46ad8',
      cyan: '#4fa7a8',
      white: '#d7d7d7',
      brightBlack: '#666666',
      brightRed: '#e06c64',
      brightGreen: '#7cc386',
      brightYellow: '#e0b84a',
      brightBlue: '#6aa6e8',
      brightMagenta: '#c98df0',
      brightCyan: '#72c6c8',
      brightWhite: '#ffffff',
    },
  })
  fitAddon = new FitAddonCtor()
  terminal.loadAddon(fitAddon)
  terminal.onData((data) => {
    sendTerminalInput(data, false)
  })
  terminal.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }))
  terminalScrollDisposable = terminal.onScroll?.(() => updateNewOutputButton())
}

function isModalOpen() {
  return Boolean($(MODAL_ID)?.classList.contains('open'))
}

function shouldFocusTerminal() {
  return !window.matchMedia?.('(pointer: coarse)')?.matches
}

function focusTerminalIfDesktop() {
  if (shouldFocusTerminal()) terminal?.focus()
}

function attachTerminal() {
  const container = $(CONTAINER_ID)
  if (!container || !terminal) return
  container.innerHTML = ''
  terminal.open(container)
  bindTerminalTouchScrollTargets()
  bindTerminalScrollCapture()
  fitTerminal()
  focusTerminalIfDesktop()
  resizeObserver = new ResizeObserver(() => fitTerminal())
  resizeObserver.observe(container)
}

function disposeTerminal() {
  releaseWakeLock()
  hideNewOutputButton()
  cleanupTerminalScrollCapture()
  cleanupTerminalTouchScrollTargets()
  if (terminalScrollDisposable) {
    try {
      terminalScrollDisposable.dispose()
    } catch {}
    terminalScrollDisposable = null
  }
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }
  if (terminal) {
    try {
      terminal.dispose()
    } catch {}
    terminal = null
  }
  fitAddon = null
  const container = $(CONTAINER_ID)
  if (container) container.innerHTML = ''
}

function fitTerminal() {
  if (!terminal || !fitAddon) return
  if (!isModalOpen()) return
  try {
    fitAddon.fit()
  } catch {}
}

function fitVisibleTerminalSoon(focus = false) {
  requestAnimationFrame(() => {
    fitTerminal()
    if (terminal && socket?.readyState === WebSocket.OPEN) {
      send({ type: 'resize', cols: terminal.cols, rows: terminal.rows })
    }
    if (focus) focusTerminalIfDesktop()
  })
}

function activeTerminalBuffer() {
  try {
    return terminal?.buffer?.active || null
  } catch {
    return null
  }
}

function terminalAtBottom() {
  const buffer = activeTerminalBuffer()
  if (!buffer) return true
  return buffer.viewportY >= buffer.baseY
}

function showNewOutputButton() {
  const button = $(NEW_OUTPUT_BTN_ID)
  if (!button) return
  button.hidden = false
  button.setAttribute('aria-hidden', 'false')
  button.classList.add('is-visible')
}

function hideNewOutputButton() {
  const button = $(NEW_OUTPUT_BTN_ID)
  if (!button) return
  button.classList.remove('is-visible')
  button.setAttribute('aria-hidden', 'true')
  button.hidden = true
}

function updateNewOutputButton() {
  if (!terminal || terminalAtBottom()) {
    hideNewOutputButton()
  }
}

function scrollTerminalToBottom() {
  if (!terminal) return
  terminal.scrollToBottom()
  hideNewOutputButton()
}

function restoreTerminalViewport(line) {
  if (!terminal || typeof terminal.scrollToLine !== 'function') return
  const buffer = activeTerminalBuffer()
  const maxLine = Number.isFinite(buffer?.baseY) ? buffer.baseY : line
  const targetLine = Math.max(0, Math.min(line, maxLine))
  terminal.scrollToLine(targetLine)
}

function writeTerminalOutput(data) {
  if (!terminal) return
  const buffer = activeTerminalBuffer()
  const wasAtBottom = terminalAtBottom()
  const previousViewportY = Number.isFinite(buffer?.viewportY) ? buffer.viewportY : 0
  let finished = false
  const afterWrite = () => {
    if (finished || !terminal) return
    finished = true
    if (!wasAtBottom) {
      restoreTerminalViewport(previousViewportY)
      showNewOutputButton()
      return
    }
    hideNewOutputButton()
  }
  try {
    if (terminal.write.length >= 2) {
      terminal.write(data, afterWrite)
    } else {
      terminal.write(data)
      requestAnimationFrame(afterWrite)
    }
  } catch {
    try {
      terminal.write(data)
    } catch {}
    requestAnimationFrame(afterWrite)
  }
}

function terminalLineHeight() {
  const viewport = $(CONTAINER_ID)?.querySelector?.('.xterm-viewport')
  if (viewport?.clientHeight && terminal?.rows) {
    return Math.max(8, viewport.clientHeight / terminal.rows)
  }
  return 16
}

function resetTerminalTouchScroll() {
  terminalTouchScrollY = null
  terminalTouchScrollRemainder = 0
  terminalScrollPointerId = null
  terminalScrollPointerTarget = null
}

function beginTerminalTouchScroll(clientY) {
  if (!terminal || !Number.isFinite(clientY)) {
    resetTerminalTouchScroll()
    return false
  }
  terminalTouchScrollY = clientY
  terminalTouchScrollRemainder = 0
  return true
}

function moveTerminalTouchScroll(clientY, event = null) {
  if (terminalTouchScrollY == null || !terminal || !Number.isFinite(clientY)) return false
  const currentY = clientY
  const rawDelta = terminalTouchScrollY - currentY + terminalTouchScrollRemainder
  const lineHeight = terminalLineHeight()
  const lines = rawDelta > 0 ? Math.floor(rawDelta / lineHeight) : Math.ceil(rawDelta / lineHeight)
  if (lines === 0) return false

  if (event?.cancelable) event.preventDefault()
  event?.stopPropagation?.()
  terminal.scrollLines(lines)
  terminalTouchScrollY = currentY
  terminalTouchScrollRemainder = rawDelta - lines * lineHeight
  updateNewOutputButton()
  return true
}

function endTerminalTouchScroll() {
  if (terminalScrollPointerTarget && terminalScrollPointerId != null) {
    try {
      terminalScrollPointerTarget.releasePointerCapture?.(terminalScrollPointerId)
    } catch {}
  }
  resetTerminalTouchScroll()
}

function handleTerminalTouchStart(event) {
  if (event.touches.length !== 1) {
    resetTerminalTouchScroll()
    return
  }
  beginTerminalTouchScroll(event.touches[0].clientY)
}

function handleTerminalTouchMove(event) {
  if (event.touches.length !== 1) return
  moveTerminalTouchScroll(event.touches[0].clientY, event)
}

function isTerminalScrollPointer(event) {
  return event.pointerType === 'touch' || event.pointerType === 'pen'
}

function handleScrollCapturePointerDown(event) {
  if (!isTerminalScrollPointer(event)) return
  if (!beginTerminalTouchScroll(event.clientY)) return
  terminalScrollPointerId = event.pointerId
  terminalScrollPointerTarget = event.currentTarget
  try {
    event.currentTarget?.setPointerCapture?.(event.pointerId)
  } catch {}
  if (event.cancelable) event.preventDefault()
  event.stopPropagation()
}

function handleScrollCapturePointerMove(event) {
  if (terminalScrollPointerId !== event.pointerId || !isTerminalScrollPointer(event)) return
  moveTerminalTouchScroll(event.clientY, event)
}

function handleScrollCapturePointerEnd(event) {
  if (terminalScrollPointerId != null && event.pointerId !== terminalScrollPointerId) return
  if (event?.cancelable) event.preventDefault()
  event?.stopPropagation?.()
  endTerminalTouchScroll()
}

function handleScrollCaptureLostPointer(event) {
  if (terminalScrollPointerId != null && event.pointerId !== terminalScrollPointerId) return
  resetTerminalTouchScroll()
}

function handleScrollCaptureTouchStart(event) {
  if (event.touches.length !== 1) {
    resetTerminalTouchScroll()
    return
  }
  if (!beginTerminalTouchScroll(event.touches[0].clientY)) return
  if (event.cancelable) event.preventDefault()
  event.stopPropagation()
}

function handleScrollCaptureTouchMove(event) {
  if (event.touches.length !== 1) return
  moveTerminalTouchScroll(event.touches[0].clientY, event)
}

function handleScrollCaptureTouchEnd(event) {
  if (event?.cancelable) event.preventDefault()
  event?.stopPropagation?.()
  endTerminalTouchScroll()
}

function cleanupTerminalScrollCapture() {
  endTerminalTouchScroll()
  if (!terminalScrollCaptureCleanup) return
  try {
    terminalScrollCaptureCleanup()
  } catch {}
  terminalScrollCaptureCleanup = null
}

function bindTerminalScrollCapture() {
  cleanupTerminalScrollCapture()
  const overlay = $(SCROLL_CAPTURE_ID)
  if (!overlay) return

  const cleanup = []
  const add = (target, type, handler, options) => {
    target.addEventListener(type, handler, options)
    cleanup.push(() => target.removeEventListener(type, handler, options))
  }

  if (window.PointerEvent) {
    add(overlay, 'pointerdown', handleScrollCapturePointerDown, { passive: false })
    add(overlay, 'pointermove', handleScrollCapturePointerMove, { passive: false })
    add(overlay, 'pointerup', handleScrollCapturePointerEnd, { passive: false })
    add(overlay, 'pointercancel', handleScrollCapturePointerEnd, { passive: false })
    add(overlay, 'lostpointercapture', handleScrollCaptureLostPointer)
  } else {
    add(overlay, 'touchstart', handleScrollCaptureTouchStart, { passive: false })
    add(overlay, 'touchmove', handleScrollCaptureTouchMove, { passive: false })
    add(overlay, 'touchend', handleScrollCaptureTouchEnd, { passive: false })
    add(overlay, 'touchcancel', handleScrollCaptureTouchEnd, { passive: false })
  }
  add(window, 'blur', endTerminalTouchScroll)

  terminalScrollCaptureCleanup = () => {
    for (const dispose of cleanup) {
      try {
        dispose()
      } catch {}
    }
  }
}

function terminalTouchScrollTargetElements() {
  const container = $(CONTAINER_ID)
  if (!container) return []
  return [
    container,
    container.querySelector('.xterm'),
    container.querySelector('.xterm-viewport'),
    container.querySelector('.xterm-screen'),
  ].filter(Boolean)
}

function cleanupTerminalTouchScrollTargets() {
  for (const target of terminalTouchScrollTargets) {
    target.removeEventListener('touchstart', handleTerminalTouchStart, true)
    target.removeEventListener('touchmove', handleTerminalTouchMove, true)
    target.removeEventListener('touchend', endTerminalTouchScroll, true)
    target.removeEventListener('touchcancel', endTerminalTouchScroll, true)
  }
  terminalTouchScrollTargets = []
  endTerminalTouchScroll()
}

function bindTerminalTouchScrollTargets() {
  cleanupTerminalTouchScrollTargets()
  terminalTouchScrollTargets = [...new Set(terminalTouchScrollTargetElements())]
  for (const target of terminalTouchScrollTargets) {
    target.addEventListener('touchstart', handleTerminalTouchStart, {
      capture: true,
      passive: true,
    })
    target.addEventListener('touchmove', handleTerminalTouchMove, {
      capture: true,
      passive: false,
    })
    target.addEventListener('touchend', endTerminalTouchScroll, {
      capture: true,
      passive: true,
    })
    target.addEventListener('touchcancel', endTerminalTouchScroll, {
      capture: true,
      passive: true,
    })
  }
}

function scrollTerminal(action) {
  if (!terminal) return
  if (action === 'page-up') {
    terminal.scrollPages(-1)
  } else if (action === 'page-down') {
    terminal.scrollPages(1)
  } else if (action === 'bottom') {
    scrollTerminalToBottom()
  }
  updateNewOutputButton()
}

function send(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return
  socket.send(JSON.stringify(payload))
}

function sendTerminalInput(data, notifyDisconnected = true) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    if (notifyDisconnected) toast('终端尚未连接', 'error')
    return false
  }
  if (byteLength(data) > MAX_TERMINAL_INPUT_BYTES) {
    toast('终端输入过大，已拦截', 'error')
    return false
  }
  send({ type: 'input', data })
  return true
}

function normalizedMobileCommand(text) {
  const normalized = text.replace(/\r?\n/g, '\r')
  return normalized.endsWith('\r') ? normalized : `${normalized}\r`
}

function loadMobileCommandHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(MOBILE_COMMAND_HISTORY_KEY) || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item) => typeof item === 'string' && item.trim())
      .slice(0, MAX_MOBILE_COMMAND_HISTORY)
  } catch {
    return []
  }
}

function saveMobileCommandHistory() {
  try {
    localStorage.setItem(MOBILE_COMMAND_HISTORY_KEY, JSON.stringify(mobileCommandHistory))
  } catch {}
}

function updateMobileHistoryButtons() {
  const prev = $(MOBILE_HISTORY_PREV_BTN_ID)
  const next = $(MOBILE_HISTORY_NEXT_BTN_ID)
  if (prev) prev.disabled = mobileCommandHistory.length === 0
  if (next) next.disabled = mobileCommandHistoryCursor == null
}

function resetMobileHistoryCursor() {
  mobileCommandHistoryCursor = null
  mobileCommandHistoryDraft = ''
  updateMobileHistoryButtons()
}

function setMobileCommandText(text) {
  const input = $(MOBILE_INPUT_ID)
  if (!input) return
  input.value = text
  autoGrowMobileInput()
}

function rememberMobileCommand(text) {
  const command = text.trim()
  if (!command) return
  mobileCommandHistory = [
    command,
    ...mobileCommandHistory.filter((item) => item !== command),
  ].slice(0, MAX_MOBILE_COMMAND_HISTORY)
  saveMobileCommandHistory()
  resetMobileHistoryCursor()
}

function showPreviousMobileCommand() {
  if (!mobileCommandHistory.length) {
    toast('还没有移动端输入历史', 'info')
    return
  }
  const input = $(MOBILE_INPUT_ID)
  if (!input) return
  if (mobileCommandHistoryCursor == null) {
    mobileCommandHistoryDraft = input.value
    mobileCommandHistoryCursor = 0
  } else {
    mobileCommandHistoryCursor = Math.min(
      mobileCommandHistoryCursor + 1,
      mobileCommandHistory.length - 1,
    )
  }
  setMobileCommandText(mobileCommandHistory[mobileCommandHistoryCursor] || '')
  updateMobileHistoryButtons()
}

function showNextMobileCommand() {
  const input = $(MOBILE_INPUT_ID)
  if (!input || mobileCommandHistoryCursor == null) return
  if (mobileCommandHistoryCursor <= 0) {
    setMobileCommandText(mobileCommandHistoryDraft)
    resetMobileHistoryCursor()
    return
  }
  mobileCommandHistoryCursor -= 1
  setMobileCommandText(mobileCommandHistory[mobileCommandHistoryCursor] || '')
  updateMobileHistoryButtons()
}

function wakeLockSupported() {
  return Boolean(navigator.wakeLock?.request)
}

function updateWakeLockButton() {
  const button = $(WAKE_LOCK_BTN_ID)
  if (!button) return
  const supported = wakeLockSupported()
  button.hidden = !supported
  button.disabled = !supported
  button.dataset.active = wakeLockSentinel ? 'true' : 'false'
  button.textContent = wakeLockSentinel ? '亮屏中' : '亮屏'
}

async function requestWakeLock() {
  if (
    !wakeLockWanted ||
    wakeLockSentinel ||
    !wakeLockSupported() ||
    !isModalOpen() ||
    !terminal ||
    document.visibilityState !== 'visible'
  ) {
    updateWakeLockButton()
    return
  }
  try {
    const sentinel = await navigator.wakeLock.request('screen')
    wakeLockSentinel = sentinel
    sentinel.addEventListener?.('release', () => {
      if (wakeLockSentinel === sentinel) wakeLockSentinel = null
      updateWakeLockButton()
      if (wakeLockWanted && isModalOpen() && terminal && document.visibilityState === 'visible') {
        setTimeout(() => void requestWakeLock(), 500)
      }
    })
    updateWakeLockButton()
    toast('已开启亮屏保持', 'success')
  } catch (err) {
    wakeLockWanted = false
    wakeLockSentinel = null
    updateWakeLockButton()
    const message = err instanceof Error ? err.message : String(err)
    toast(message || '当前浏览器不允许保持亮屏', 'error')
  }
}

function releaseWakeLock({ keepWanted = false } = {}) {
  if (!keepWanted) wakeLockWanted = false
  const sentinel = wakeLockSentinel
  wakeLockSentinel = null
  updateWakeLockButton()
  try {
    void sentinel?.release?.()
  } catch {}
}

function toggleWakeLock() {
  if (!wakeLockSupported()) {
    toast('当前浏览器不支持保持亮屏', 'error')
    return
  }
  if (wakeLockWanted || wakeLockSentinel) {
    releaseWakeLock()
    toast('已关闭亮屏保持', 'success')
    return
  }
  wakeLockWanted = true
  void requestWakeLock()
}

function focusMobileInput() {
  const input = $(MOBILE_INPUT_ID)
  input?.focus()
}

function sendMobileCommand() {
  const input = $(MOBILE_INPUT_ID)
  if (!input) return
  const text = input.value
  if (!text.trim()) {
    focusMobileInput()
    return
  }
  if (sendTerminalInput(normalizedMobileCommand(text))) {
    rememberMobileCommand(text)
    input.value = ''
    input.style.height = ''
  }
  focusMobileInput()
}

function autoGrowMobileInput() {
  const input = $(MOBILE_INPUT_ID)
  if (!input) return
  input.style.height = 'auto'
  input.style.height = `${Math.min(input.scrollHeight, 120)}px`
}

async function readMessageData(data) {
  if (typeof data === 'string') return data
  if (data instanceof Blob) return data.text()
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data)
  return String(data)
}

function writeLine(text) {
  if (!terminal) return
  terminal.writeln(`\r\n${text}`)
}

function closeSocket(kill = false) {
  const ws = socket
  socket = null
  if (!ws) return
  try {
    if (kill && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'kill' }))
  } catch {}
  try {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close()
  } catch {}
}

function socketIsConnectingOrOpen() {
  return socket?.readyState === WebSocket.CONNECTING || socket?.readyState === WebSocket.OPEN
}

function ensureTerminalConnected(reason = '') {
  if (!isModalOpen() || !terminal || !state.token) return false
  if (socketIsConnectingOrOpen()) return false
  const status = terminalStatusState()
  if (status === 'exited' || status === 'disabled') return false
  const now = Date.now()
  if (now - lastReconnectAttemptAt < RECONNECT_ATTEMPT_MIN_MS) return false
  lastReconnectAttemptAt = now
  connectTerminal(reason)
  return true
}

function connectTerminal(reason = '') {
  if (!state.token) {
    toast('请先登录 OpenClaude', 'error')
    return
  }
  closeSocket(false)
  reconnectRequested = false
  setStatus('connecting', reason)
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const ws = new WebSocket(`${protocol}//${location.host}/ws/claude-terminal`, [
    'bearer',
    state.token,
  ])
  socket = ws

  ws.onopen = () => {
    if (socket !== ws) return
    setStatus('running', '官方 Claude Code 已连接')
    fitVisibleTerminalSoon(true)
    if (terminal) send({ type: 'resize', cols: terminal.cols, rows: terminal.rows })
  }

  ws.onmessage = async (event) => {
    let payload = null
    try {
      payload = JSON.parse(await readMessageData(event.data))
    } catch {
      return
    }
    if (!payload || typeof payload !== 'object') return
    if (payload.type === 'output' && typeof payload.data === 'string') {
      writeTerminalOutput(payload.data)
      return
    }
    if (payload.type === 'replay' && typeof payload.data === 'string') {
      terminal?.reset()
      if (payload.data) terminal?.write(payload.data)
      hideNewOutputButton()
      fitVisibleTerminalSoon(true)
      return
    }
    if (payload.type === 'status') {
      const message = typeof payload.message === 'string' ? payload.message : ''
      setStatus(payload.state || 'idle', message)
      if (payload.state === 'error' || payload.state === 'disabled') writeLine(message)
      return
    }
    if (payload.type === 'exit') {
      const code = payload.code == null ? 'null' : String(payload.code)
      const signal = payload.signal == null ? 'null' : String(payload.signal)
      setStatus('exited', `code=${code} signal=${signal}`)
      writeLine(`[Claude Code exited: code=${code}, signal=${signal}]`)
    }
  }

  ws.onerror = () => {
    if (socket !== ws) return
    setStatus('error', 'WebSocket 连接失败')
  }

  ws.onclose = () => {
    if (socket !== ws) return
    socket = null
    if (reconnectRequested) return
    const current = $(STATUS_ID)?.dataset.state
    if (current !== 'exited' && current !== 'error' && current !== 'disabled') setStatus('closed')
  }
}

export async function openOfficialClaudeTerminal() {
  await ensureTerminalDeps()
  openModal(MODAL_ID)
  updateWakeLockButton()
  if (terminal) {
    fitVisibleTerminalSoon(true)
    if (wakeLockWanted) void requestWakeLock()
    if (
      !socket ||
      socket.readyState === WebSocket.CLOSED ||
      socket.readyState === WebSocket.CLOSING
    ) {
      connectTerminal()
    }
    return
  }
  createTerminal()
  attachTerminal()
  terminal?.writeln('OpenClaude official Claude Code terminal')
  terminal?.writeln('Starting `claude` in a server-side PTY...')
  terminal?.writeln('关闭只隐藏窗口，点“终止”才结束进程。\r\n')
  connectTerminal()
  if (wakeLockWanted) void requestWakeLock()
}

export function hideOfficialClaudeTerminal() {
  releaseWakeLock()
  closeModal(MODAL_ID)
}

export function closeOfficialClaudeTerminal() {
  hideOfficialClaudeTerminal()
}

export function terminateOfficialClaudeTerminal() {
  void terminateOfficialClaudeTerminalAsync()
}

async function terminateOfficialClaudeTerminalAsync() {
  if (terminateInFlight) return
  if (!state.token) {
    toast('请先登录 OpenClaude', 'error')
    return
  }
  terminateInFlight = true
  setStatus('connecting', '正在终止 Claude Code')
  try {
    await apiJson('POST', '/api/claude-terminal/terminate', {})
    closeSocket(false)
    disposeTerminal()
    reconnectRequested = false
    setStatus('closed', '已终止，重新打开会新建终端')
  } catch (err) {
    if (socket?.readyState === WebSocket.OPEN) {
      closeSocket(true)
      disposeTerminal()
      reconnectRequested = false
      setStatus('closed', '已通过当前连接发送终止')
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    setStatus('error', '终止失败')
    toast(message || '终止 Claude Code 失败', 'error')
  } finally {
    terminateInFlight = false
  }
}

function reconnectTerminal() {
  reconnectRequested = true
  lastReconnectAttemptAt = 0
  closeSocket(false)
  if (!terminal) {
    createTerminal()
    attachTerminal()
  } else {
    terminal.reset()
    terminal.scrollToBottom()
    hideNewOutputButton()
  }
  connectTerminal()
}

function sendQuickKey(key, button) {
  if (!key || !QUICK_KEYS[key]) return
  sendTerminalInput(QUICK_KEYS[key])
  button?.blur?.()
}

function runMobileControl(button) {
  if (button.dataset.claudeTerminalKey) {
    sendQuickKey(button.dataset.claudeTerminalKey, button)
  } else if (button.dataset.claudeTerminalAction) {
    scrollTerminal(button.dataset.claudeTerminalAction)
    button.blur?.()
  }
}

function bindNoFocusButton(id, handler) {
  const button = $(id)
  if (!button) return
  button.tabIndex = -1
  button.addEventListener(
    'pointerdown',
    (event) => {
      event.preventDefault()
      event.stopPropagation()
      lastMobileControlPointerAt = Date.now()
      handler()
      button.blur?.()
    },
    { passive: false },
  )
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    if (Date.now() - lastMobileControlPointerAt < 500) return
    handler()
    button.blur?.()
  })
}

function handleTerminalVisibilityResume(reason) {
  ensureTerminalConnected(reason)
  if (wakeLockWanted) void requestWakeLock()
  fitVisibleTerminalSoon(false)
}

export function initOfficialClaudeTerminal() {
  if (initialized) return
  initialized = true
  mobileCommandHistory = loadMobileCommandHistory()
  updateMobileHistoryButtons()
  updateWakeLockButton()
  $(KILL_BTN_ID)?.addEventListener('click', () => terminateOfficialClaudeTerminal())
  $(RECONNECT_BTN_ID)?.addEventListener('click', () => reconnectTerminal())
  $(NEW_OUTPUT_BTN_ID)?.addEventListener('click', () => scrollTerminalToBottom())
  $(MOBILE_SEND_BTN_ID)?.addEventListener('click', () => sendMobileCommand())
  $(MOBILE_FOCUS_BTN_ID)?.addEventListener('click', () => focusMobileInput())
  bindNoFocusButton(MOBILE_HISTORY_PREV_BTN_ID, showPreviousMobileCommand)
  bindNoFocusButton(MOBILE_HISTORY_NEXT_BTN_ID, showNextMobileCommand)
  bindNoFocusButton(WAKE_LOCK_BTN_ID, toggleWakeLock)
  $(MOBILE_INPUT_ID)?.addEventListener('input', () => {
    autoGrowMobileInput()
    resetMobileHistoryCursor()
  })
  $(MOBILE_INPUT_ID)?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
    event.preventDefault()
    sendMobileCommand()
  })
  window.addEventListener('resize', () => fitTerminal())
  window.addEventListener('focus', () => handleTerminalVisibilityResume('窗口恢复，正在重连'))
  window.addEventListener('online', () => handleTerminalVisibilityResume('网络恢复，正在重连'))
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      handleTerminalVisibilityResume('从后台恢复，正在重连')
      return
    }
    releaseWakeLock({ keepWanted: true })
  })

  document
    .querySelectorAll('[data-claude-terminal-key], [data-claude-terminal-action]')
    .forEach((button) => {
      button.tabIndex = -1
      button.addEventListener(
        'pointerdown',
        (event) => {
          event.preventDefault()
          event.stopPropagation()
          lastMobileControlPointerAt = Date.now()
          runMobileControl(button)
        },
        { passive: false },
      )
      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (Date.now() - lastMobileControlPointerAt < 500) return
        runMobileControl(button)
      })
    })

  document.addEventListener(
    'click',
    (event) => {
      const modal = $(MODAL_ID)
      if (!modal?.classList.contains('open')) return
      const target = event.target
      if (target?.id === MODAL_ID || target?.closest?.(CLOSE_SELECTOR)) {
        event.preventDefault()
        event.stopPropagation()
        hideOfficialClaudeTerminal()
      }
    },
    true,
  )

  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape') return
      const modal = $(MODAL_ID)
      if (!modal?.classList.contains('open')) return
      event.preventDefault()
      event.stopPropagation()
      hideOfficialClaudeTerminal()
    },
    true,
  )
}
