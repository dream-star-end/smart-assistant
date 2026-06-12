import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'modules', 'officialTerminal.js'),
  'utf-8',
)
const STYLE = readFileSync(resolve(import.meta.dirname, '..', 'public', 'style.css'), 'utf-8')
const INDEX = readFileSync(resolve(import.meta.dirname, '..', 'public', 'index.html'), 'utf-8')
const MAIN = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'modules', 'main.js'),
  'utf-8',
)
const SW = readFileSync(resolve(import.meta.dirname, '..', 'public', 'sw.js'), 'utf-8')

function extractFunction(source: string, name: string): string {
  const lines = source.split('\n')
  const fnLineIdx = lines.findIndex((line) =>
    new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`).test(line),
  )
  if (fnLineIdx === -1) throw new Error(`Function "${name}" not found`)

  let endLineIdx = fnLineIdx + 1
  for (; endLineIdx < lines.length; endLineIdx++) {
    if (/^}\s*$/.test(lines[endLineIdx])) break
  }
  return lines.slice(fnLineIdx, endLineIdx + 1).join('\n')
}

describe('official Claude terminal lifecycle', () => {
  it('modal close only hides the terminal and keeps the PTY websocket alive', () => {
    const hideSrc = extractFunction(SRC, 'hideOfficialClaudeTerminal')
    const closeSrc = extractFunction(SRC, 'closeOfficialClaudeTerminal')

    assert.match(hideSrc, /closeModal\(MODAL_ID\)/)
    assert.doesNotMatch(hideSrc, /closeSocket|disposeTerminal|type:\s*['"]kill/)
    assert.match(closeSrc, /hideOfficialClaudeTerminal\(\)/)
    assert.doesNotMatch(closeSrc, /closeSocket|disposeTerminal|type:\s*['"]kill/)
  })

  it('terminate remains the explicit path that closes and disposes the terminal', () => {
    const terminateSrc = extractFunction(SRC, 'terminateOfficialClaudeTerminal')

    assert.match(terminateSrc, /terminateOfficialClaudeTerminalAsync\(\)/)
    assert.doesNotMatch(terminateSrc, /closeSocket\(true\)/)
    assert.match(SRC, /apiJson\('POST', '\/api\/claude-terminal\/terminate', \{\}\)/)
    assert.match(SRC, /closeSocket\(false\)/)
    assert.match(SRC, /closeSocket\(true\)/)
    assert.match(SRC, /已通过当前连接发送终止/)
    assert.match(SRC, /disposeTerminal\(\)/)
    assert.match(SRC, /终止失败/)
  })

  it('reconnect and reopen keep the server-side PTY instead of sending kill', () => {
    const connectSrc = extractFunction(SRC, 'connectTerminal')
    const reconnectSrc = extractFunction(SRC, 'reconnectTerminal')
    const openSrc = extractFunction(SRC, 'openOfficialClaudeTerminal')

    assert.match(connectSrc, /closeSocket\(false\)/)
    assert.match(reconnectSrc, /closeSocket\(false\)/)
    assert.doesNotMatch(reconnectSrc, /closeSocket\(true\)/)
    assert.match(openSrc, /socket\.readyState === WebSocket\.CLOSED/)
    assert.match(openSrc, /connectTerminal\(\)/)
  })

  it('replay frames reset and restore the terminal buffer on resume', () => {
    const connectSrc = extractFunction(SRC, 'connectTerminal')

    assert.match(connectSrc, /payload\.type === 'replay'/)
    assert.match(connectSrc, /terminal\?\.reset\(\)/)
    assert.match(connectSrc, /terminal\?\.write\(payload\.data\)/)
    assert.match(connectSrc, /hideNewOutputButton\(\)/)
  })

  it('auto-reconnects on mobile resume without treating transient errors as fatal', () => {
    const ensureSrc = extractFunction(SRC, 'ensureTerminalConnected')
    const initSrc = extractFunction(SRC, 'initOfficialClaudeTerminal')

    assert.match(ensureSrc, /socketIsConnectingOrOpen\(\)/)
    assert.match(ensureSrc, /RECONNECT_ATTEMPT_MIN_MS/)
    assert.match(ensureSrc, /status === 'exited' \|\| status === 'disabled'/)
    assert.doesNotMatch(ensureSrc, /status === 'error'/)
    assert.match(initSrc, /visibilitychange/)
    assert.match(initSrc, /window\.addEventListener\('focus'/)
    assert.match(initSrc, /window\.addEventListener\('online'/)
    assert.match(initSrc, /handleTerminalVisibilityResume\('从后台恢复，正在重连'\)/)
  })

  it('preserves scrollback reading position and exposes a new-output jump chip', () => {
    const writeSrc = extractFunction(SRC, 'writeTerminalOutput')
    const bottomSrc = extractFunction(SRC, 'scrollTerminalToBottom')

    assert.match(INDEX, /claude-terminal-new-output-btn/)
    assert.match(STYLE, /\.claude-terminal-new-output/)
    assert.match(writeSrc, /terminalAtBottom\(\)/)
    assert.match(writeSrc, /previousViewportY/)
    assert.match(writeSrc, /terminal\.write\(data, afterWrite\)/)
    assert.match(writeSrc, /restoreTerminalViewport\(previousViewportY\)/)
    assert.match(writeSrc, /showNewOutputButton\(\)/)
    assert.match(bottomSrc, /terminal\.scrollToBottom\(\)/)
    assert.match(bottomSrc, /hideNewOutputButton\(\)/)
  })

  it('quick terminal keys send bytes without focusing the mobile textarea', () => {
    const quickKeySrc = extractFunction(SRC, 'sendQuickKey')
    const initSrc = extractFunction(SRC, 'initOfficialClaudeTerminal')

    assert.match(initSrc, /pointerdown/)
    assert.doesNotMatch(quickKeySrc, /focusMobileInput/)
    assert.match(quickKeySrc, /button\?\.blur\?\.\(\)/)
  })

  it('mobile bottom button uses xterm scrollback action instead of textarea focus', () => {
    const scrollSrc = extractFunction(SRC, 'scrollTerminal')
    const controlSrc = extractFunction(SRC, 'runMobileControl')

    assert.match(INDEX, /data-claude-terminal-action="bottom"/)
    assert.doesNotMatch(INDEX, /data-claude-terminal-action="page-up"/)
    assert.doesNotMatch(INDEX, /data-claude-terminal-action="page-down"/)
    assert.match(scrollSrc, /terminal\.scrollPages\(-1\)/)
    assert.match(scrollSrc, /terminal\.scrollPages\(1\)/)
    assert.match(scrollSrc, /scrollTerminalToBottom\(\)/)
    assert.match(controlSrc, /scrollTerminal\(button\.dataset\.claudeTerminalAction\)/)
    assert.doesNotMatch(controlSrc, /focusMobileInput/)
  })

  it('mobile composer stores command history without exposing extra history buttons', () => {
    const rememberSrc = extractFunction(SRC, 'rememberMobileCommand')
    const loadSrc = extractFunction(SRC, 'loadMobileCommandHistory')

    assert.doesNotMatch(INDEX, /claude-terminal-history-prev-btn/)
    assert.doesNotMatch(INDEX, /claude-terminal-history-next-btn/)
    assert.match(loadSrc, /MOBILE_COMMAND_HISTORY_KEY/)
    assert.match(rememberSrc, /MAX_MOBILE_COMMAND_HISTORY/)
  })

  it('mobile quick controls include prompt navigation keys', () => {
    assert.match(INDEX, /claude-terminal-mobile-input/)
    assert.match(INDEX, /claude-terminal-mobile-send-btn/)
    assert.match(INDEX, /claude-terminal-mobile-focus-btn/)
    assert.match(INDEX, /data-claude-terminal-action="bottom"/)
    assert.match(INDEX, /data-claude-terminal-key="up"/)
    assert.match(INDEX, /data-claude-terminal-key="down"/)
    assert.match(INDEX, /data-claude-terminal-key="enter"/)
    assert.match(INDEX, /data-claude-terminal-key="tab"/)
    assert.match(INDEX, /data-claude-terminal-key="ctrl-c"/)
    assert.match(INDEX, /data-claude-terminal-key="esc"/)
    assert.match(SRC, /up:\s*'\\x1b\[A'/)
    assert.match(SRC, /down:\s*'\\x1b\[B'/)
    assert.doesNotMatch(INDEX, /claude-terminal-wake-lock-btn/)
  })

  it('cache-busts terminal module when changing mobile controls', () => {
    assert.match(MAIN, /from '\.\/officialTerminal\.js\?v=7'/)
    assert.match(SW, /\/modules\/officialTerminal\.js\?v=7/)
    assert.match(INDEX, /\/modules\/main\.js\?v=59/)
    assert.match(INDEX, /\/style\.css\?v=51/)
    assert.match(INDEX, /sw-flush-v21/)
    assert.match(SW, /openclaude-v79/)
  })

  it('terminal files live in a separate wide modal with Escape closing files first', () => {
    const toggleSrc = extractFunction(SRC, 'toggleTerminalFilePanel')
    const hideSrc = extractFunction(SRC, 'hideOfficialClaudeTerminal')
    const initSrc = extractFunction(SRC, 'initOfficialClaudeTerminal')

    assert.match(INDEX, /id="claude-terminal-files-modal"/)
    assert.match(INDEX, /claude-terminal-files-modal[\s\S]*id="claude-terminal-file-panel"/)
    assert.doesNotMatch(
      INDEX,
      /claude-terminal-body[\s\S]*id="claude-terminal-file-panel"[\s\S]*claude-terminal-terminal-wrap/,
    )
    assert.match(STYLE, /\.claude-terminal-files-modal\s*{[\s\S]*?max-width:\s*min\(1080px/)
    assert.match(toggleSrc, /openModal\(FILE_MODAL_ID\)/)
    assert.match(toggleSrc, /closeTerminalFileModal\(\)/)
    assert.match(hideSrc, /closeTerminalFileModal\(\)/)
    assert.match(
      initSrc,
      /isTerminalFileModalOpen\(\)[\s\S]*?closeTerminalFileModal\(\)[\s\S]*?return/,
    )
  })

  it('wake lock helper remains gated even though the mobile shortcut is hidden', () => {
    const requestSrc = extractFunction(SRC, 'requestWakeLock')
    const releaseSrc = extractFunction(SRC, 'releaseWakeLock')
    const initSrc = extractFunction(SRC, 'initOfficialClaudeTerminal')

    assert.doesNotMatch(INDEX, /claude-terminal-wake-lock-btn/)
    assert.match(requestSrc, /navigator\.wakeLock\.request\('screen'\)/)
    assert.match(requestSrc, /!isModalOpen\(\)/)
    assert.match(requestSrc, /!terminal/)
    assert.match(requestSrc, /document\.visibilityState !== 'visible'/)
    assert.match(releaseSrc, /keepWanted = false/)
    assert.match(initSrc, /releaseWakeLock\(\{ keepWanted: true \}\)/)
  })

  it('mobile input dock is hidden on desktop and shown on narrow screens only', () => {
    assert.match(STYLE, /\.claude-terminal-mobile-dock\s*{\s*display:\s*none;/)
    assert.match(
      STYLE,
      /@media \(max-width: 860px\) {[\s\S]*?\.claude-terminal-mobile-dock\s*{[\s\S]*?display:\s*flex;/,
    )
  })

  it('touch dragging the terminal maps to xterm scrollback lines', () => {
    const moveSrc = extractFunction(SRC, 'moveTerminalTouchScroll')
    const bindTouchSrc = extractFunction(SRC, 'bindTerminalTouchScrollTargets')
    const cleanupTouchSrc = extractFunction(SRC, 'cleanupTerminalTouchScrollTargets')
    const bindCaptureSrc = extractFunction(SRC, 'bindTerminalScrollCapture')
    const cleanupCaptureSrc = extractFunction(SRC, 'cleanupTerminalScrollCapture')
    const pointerMoveSrc = extractFunction(SRC, 'handleScrollCapturePointerMove')
    const fallbackSrc = extractFunction(SRC, 'fallbackScrollTerminalViewport')

    assert.match(moveSrc, /terminal\.scrollLines\(lines\)/)
    assert.match(moveSrc, /terminalViewportY\(\)/)
    assert.match(moveSrc, /fallbackScrollTerminalViewport\(lines, lineHeight\)/)
    assert.match(moveSrc, /terminalTouchScrollRemainder/)
    assert.match(moveSrc, /event\?\.cancelable/)
    assert.match(fallbackSrc, /viewport\.scrollTop = next/)
    assert.match(bindTouchSrc, /'touchmove'/)
    assert.match(bindTouchSrc, /passive:\s*false/)
    assert.match(cleanupTouchSrc, /removeEventListener\('touchmove'/)
    assert.match(bindCaptureSrc, /window\.PointerEvent/)
    assert.match(bindCaptureSrc, /'pointerdown'/)
    assert.match(bindCaptureSrc, /'pointermove'/)
    assert.match(bindCaptureSrc, /'lostpointercapture'/)
    assert.match(bindCaptureSrc, /'touchmove'/)
    assert.match(bindCaptureSrc, /terminalScrollCaptureCleanup/)
    assert.match(cleanupCaptureSrc, /endTerminalTouchScroll\(\)/)
    assert.match(cleanupCaptureSrc, /terminalScrollCaptureCleanup/)
    assert.match(pointerMoveSrc, /terminalScrollPointerId !== event\.pointerId/)
  })

  it('mobile terminal exposes a dedicated scroll capture overlay', () => {
    assert.match(INDEX, /id="claude-terminal-scroll-capture"/)
    assert.match(
      INDEX,
      /claude-terminal-container[\s\S]*claude-terminal-scroll-capture[\s\S]*claude-terminal-new-output-btn/,
    )
    assert.match(STYLE, /\.claude-terminal-scroll-capture\s*{\s*display:\s*none;/)
    assert.match(
      STYLE,
      /@media \(max-width: 860px\) {[\s\S]*?\.claude-terminal-scroll-capture\s*{[\s\S]*?display:\s*block;[\s\S]*?z-index:\s*1;[\s\S]*?overscroll-behavior:\s*contain;[\s\S]*?touch-action:\s*none;/,
    )
    assert.match(
      STYLE,
      /@media \(max-width: 860px\) and \(hover: hover\) and \(pointer: fine\) {[\s\S]*?\.claude-terminal-scroll-capture\s*{[\s\S]*?display:\s*none;/,
    )
    assert.match(STYLE, /\.claude-terminal-new-output\s*{[\s\S]*?z-index:\s*3;/)
  })
})
