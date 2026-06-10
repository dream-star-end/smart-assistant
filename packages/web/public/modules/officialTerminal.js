// Official Claude Code terminal modal.
// Runs the official `claude` CLI inside a gateway-owned PTY over /ws/claude-terminal.
import { $ } from './dom.js'
import { state } from './state.js'
import { closeModal, openModal, toast } from './ui.js'

const MODAL_ID = 'claude-terminal-modal'
const CONTAINER_ID = 'claude-terminal-container'
const STATUS_ID = 'claude-terminal-status'
const KILL_BTN_ID = 'claude-terminal-kill-btn'
const RECONNECT_BTN_ID = 'claude-terminal-reconnect-btn'
const CLOSE_SELECTOR = '[data-claude-terminal-close]'
const MAX_TERMINAL_INPUT_BYTES = 32 * 1024

let TerminalCtor = null
let FitAddonCtor = null
let terminal = null
let fitAddon = null
let socket = null
let resizeObserver = null
let reconnectRequested = false
let initialized = false

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
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    if (byteLength(data) > MAX_TERMINAL_INPUT_BYTES) {
      toast('终端输入过大，已拦截', 'error')
      return
    }
    send({ type: 'input', data })
  })
  terminal.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }))
}

function attachTerminal() {
  const container = $(CONTAINER_ID)
  if (!container || !terminal) return
  container.innerHTML = ''
  terminal.open(container)
  fitTerminal()
  terminal.focus()
  resizeObserver = new ResizeObserver(() => fitTerminal())
  resizeObserver.observe(container)
}

function disposeTerminal() {
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
  try {
    fitAddon.fit()
  } catch {}
}

function send(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return
  socket.send(JSON.stringify(payload))
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

function closeSocket(kill = true) {
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
  closeSocket(true)
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
    fitTerminal()
    if (terminal) send({ type: 'resize', cols: terminal.cols, rows: terminal.rows })
    terminal?.focus()
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
    if (socket === ws) socket = null
    if (reconnectRequested) return
    const current = $(STATUS_ID)?.dataset.state
    if (current !== 'exited' && current !== 'error' && current !== 'disabled') setStatus('closed')
  }
}

export async function openOfficialClaudeTerminal() {
  await ensureTerminalDeps()
  openModal(MODAL_ID)
  createTerminal()
  attachTerminal()
  terminal?.writeln('OpenClaude official Claude Code terminal')
  terminal?.writeln('Starting `claude` in a server-side PTY...\r\n')
  connectTerminal()
}

export function closeOfficialClaudeTerminal() {
  reconnectRequested = false
  closeSocket(true)
  disposeTerminal()
  setStatus('closed')
  closeModal(MODAL_ID)
}

function reconnectTerminal() {
  reconnectRequested = true
  closeSocket(true)
  if (!terminal) {
    createTerminal()
    attachTerminal()
  } else {
    terminal.reset()
  }
  connectTerminal()
}

export function initOfficialClaudeTerminal() {
  if (initialized) return
  initialized = true
  $(KILL_BTN_ID)?.addEventListener('click', () => {
    send({ type: 'kill' })
    setStatus('closed', '已发送终止信号')
  })
  $(RECONNECT_BTN_ID)?.addEventListener('click', () => reconnectTerminal())
  window.addEventListener('resize', () => fitTerminal())

  document.addEventListener(
    'click',
    (event) => {
      const modal = $(MODAL_ID)
      if (!modal?.classList.contains('open')) return
      const target = event.target
      if (target?.id === MODAL_ID || target?.closest?.(CLOSE_SELECTOR)) {
        event.preventDefault()
        event.stopPropagation()
        closeOfficialClaudeTerminal()
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
      closeOfficialClaudeTerminal()
    },
    true,
  )
}
