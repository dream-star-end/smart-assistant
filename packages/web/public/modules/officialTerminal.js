// Official Claude Code terminal modal.
// Runs the official `claude` CLI inside a gateway-owned PTY over /ws/claude-terminal.
import { apiJson } from './api.js'
import { $ } from './dom.js'
import { state } from './state.js'
import { closeModal, openModal, toast } from './ui.js'

const MODAL_ID = 'claude-terminal-modal'
const CONTAINER_ID = 'claude-terminal-container'
const STATUS_ID = 'claude-terminal-status'
const KILL_BTN_ID = 'claude-terminal-kill-btn'
const RECONNECT_BTN_ID = 'claude-terminal-reconnect-btn'
const MOBILE_INPUT_ID = 'claude-terminal-mobile-input'
const MOBILE_SEND_BTN_ID = 'claude-terminal-mobile-send-btn'
const MOBILE_FOCUS_BTN_ID = 'claude-terminal-mobile-focus-btn'
const CLOSE_SELECTOR = '[data-claude-terminal-close]'
const MAX_TERMINAL_INPUT_BYTES = 32 * 1024
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
let reconnectRequested = false
let initialized = false
let lastMobileControlPointerAt = 0
let terminalTouchScrollY = null
let terminalTouchScrollRemainder = 0
let terminalTouchScrollTargets = []
let terminateInFlight = false

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
  fitTerminal()
  focusTerminalIfDesktop()
  resizeObserver = new ResizeObserver(() => fitTerminal())
  resizeObserver.observe(container)
}

function disposeTerminal() {
  cleanupTerminalTouchScrollTargets()
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
}

function handleTerminalTouchStart(event) {
  if (!terminal || event.touches.length !== 1) {
    resetTerminalTouchScroll()
    return
  }
  terminalTouchScrollY = event.touches[0].clientY
  terminalTouchScrollRemainder = 0
}

function handleTerminalTouchMove(event) {
  if (terminalTouchScrollY == null || !terminal || event.touches.length !== 1) return

  const currentY = event.touches[0].clientY
  const rawDelta = terminalTouchScrollY - currentY + terminalTouchScrollRemainder
  const lineHeight = terminalLineHeight()
  const lines = rawDelta > 0 ? Math.floor(rawDelta / lineHeight) : Math.ceil(rawDelta / lineHeight)
  if (lines === 0) return

  if (event.cancelable) event.preventDefault()
  event.stopPropagation()
  terminal.scrollLines(lines)
  terminalTouchScrollY = currentY
  terminalTouchScrollRemainder = rawDelta - lines * lineHeight
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
    target.removeEventListener('touchend', resetTerminalTouchScroll, true)
    target.removeEventListener('touchcancel', resetTerminalTouchScroll, true)
  }
  terminalTouchScrollTargets = []
  resetTerminalTouchScroll()
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
    target.addEventListener('touchend', resetTerminalTouchScroll, {
      capture: true,
      passive: true,
    })
    target.addEventListener('touchcancel', resetTerminalTouchScroll, {
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
    terminal.scrollToBottom()
  }
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

function connectTerminal() {
  if (!state.token) {
    toast('请先登录 OpenClaude', 'error')
    return
  }
  closeSocket(false)
  reconnectRequested = false
  setStatus('connecting')
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
      terminal?.write(payload.data)
      return
    }
    if (payload.type === 'replay' && typeof payload.data === 'string') {
      terminal?.reset()
      if (payload.data) terminal?.write(payload.data)
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
  if (terminal) {
    fitVisibleTerminalSoon(true)
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
}

export function hideOfficialClaudeTerminal() {
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
  closeSocket(false)
  if (!terminal) {
    createTerminal()
    attachTerminal()
  } else {
    terminal.reset()
    terminal.scrollToBottom()
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

export function initOfficialClaudeTerminal() {
  if (initialized) return
  initialized = true
  $(KILL_BTN_ID)?.addEventListener('click', () => terminateOfficialClaudeTerminal())
  $(RECONNECT_BTN_ID)?.addEventListener('click', () => reconnectTerminal())
  $(MOBILE_SEND_BTN_ID)?.addEventListener('click', () => sendMobileCommand())
  $(MOBILE_FOCUS_BTN_ID)?.addEventListener('click', () => focusMobileInput())
  $(MOBILE_INPUT_ID)?.addEventListener('input', () => autoGrowMobileInput())
  $(MOBILE_INPUT_ID)?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
    event.preventDefault()
    sendMobileCommand()
  })
  window.addEventListener('resize', () => fitTerminal())

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
