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
    assert.match(
      SRC,
      /api\/claude-terminal\/terminate\?sessionId=\$\{encodeURIComponent\(sessionId\)\}/,
    )
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
    const canReconnectSrc = extractFunction(SRC, 'terminalCanReconnect')
    const initSrc = extractFunction(SRC, 'initOfficialClaudeTerminal')

    assert.match(ensureSrc, /socketIsConnectingOrOpen\(\)/)
    assert.match(ensureSrc, /RECONNECT_ATTEMPT_MIN_MS/)
    assert.match(canReconnectSrc, /status !== 'exited' && status !== 'disabled'/)
    assert.doesNotMatch(canReconnectSrc, /status !== 'error'|status === 'error'/)
    assert.match(initSrc, /visibilitychange/)
    assert.match(initSrc, /window\.addEventListener\('focus'/)
    assert.match(initSrc, /window\.addEventListener\('online'/)
    assert.match(initSrc, /handleTerminalVisibilityResume\('从后台恢复，正在重连'\)/)
  })

  it('forces a fresh websocket after long mobile background without killing the PTY', () => {
    const handleSrc = extractFunction(SRC, 'handleTerminalVisibilityResume')
    const forceSrc = extractFunction(SRC, 'forceReconnectTerminal')
    const initSrc = extractFunction(SRC, 'initOfficialClaudeTerminal')

    assert.match(SRC, /STALE_BACKGROUND_RECONNECT_MS = 30 \* 1000/)
    assert.match(initSrc, /terminalHiddenAt = Date\.now\(\)/)
    assert.match(handleSrc, /const hiddenAt = terminalHiddenAt/)
    assert.match(handleSrc, /terminalHiddenAt = null/)
    assert.match(handleSrc, /hiddenMs >= STALE_BACKGROUND_RECONNECT_MS/)
    assert.match(handleSrc, /forceReconnectTerminal\(reason\)/)
    assert.match(forceSrc, /connectTerminal\(reason\)/)
    assert.doesNotMatch(forceSrc, /type:\s*['"]kill|closeSocket\(true\)/)
  })

  it('clears failed websocket handles and schedules a throttled retry', () => {
    const connectSrc = extractFunction(SRC, 'connectTerminal')
    const scheduleSrc = extractFunction(SRC, 'scheduleTerminalReconnect')

    assert.match(connectSrc, /ws\.onerror/)
    assert.match(connectSrc, /socket = null/)
    assert.match(connectSrc, /ws\.close\(\)/)
    assert.match(connectSrc, /scheduleTerminalReconnect\('WebSocket 连接失败，正在重连'\)/)
    assert.match(scheduleSrc, /terminalReconnectTimer/)
    assert.match(scheduleSrc, /RECONNECT_ATTEMPT_MIN_MS/)
    assert.match(scheduleSrc, /document\.visibilityState === 'hidden'/)
    assert.match(scheduleSrc, /!socketIsConnectingOrOpen\(\)/)
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

  it('mobile command history feature is fully removed, leaving no orphan code', () => {
    assert.doesNotMatch(INDEX, /claude-terminal-history-prev-btn/)
    assert.doesNotMatch(INDEX, /claude-terminal-history-next-btn/)
    assert.doesNotMatch(SRC, /MOBILE_COMMAND_HISTORY_KEY/)
    assert.doesNotMatch(SRC, /rememberMobileCommand|mobileCommandHistory/)
    assert.doesNotMatch(STYLE, /claude-terminal-mobile-tools/)
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

  it('terminal exposes an explicit copy path for selection or visible output', () => {
    assert.match(INDEX, /id="claude-terminal-copy-btn"/)
    assert.match(INDEX, /复制选中内容；未选中时复制当前可见输出/)
    assert.match(SRC, /const COPY_BTN_ID = 'claude-terminal-copy-btn'/)
    assert.match(SRC, /function selectedTerminalText\(\)/)
    assert.match(SRC, /terminal\?\.hasSelection\?\.\(\) \? terminal\.getSelection\(\) : ''/)
    assert.match(SRC, /window\.getSelection\?\.\(\)/)
    assert.match(SRC, /container\.contains\(selection\.anchorNode\)/)
    assert.match(SRC, /container\.contains\(selection\.focusNode\)/)
    assert.match(
      SRC,
      /button\.addEventListener\([\s\S]*?'pointerdown'[\s\S]*?event\.preventDefault\(\)[\s\S]*?lastTerminalCopyPointerAt = Date\.now\(\)[\s\S]*?void copyTerminalContent\(\)/,
    )
    assert.match(SRC, /Date\.now\(\) - lastTerminalCopyPointerAt < 500/)
    assert.match(SRC, /const buffer = terminal\.buffer\.active/)
    assert.match(SRC, /buffer\.viewportY/)
    assert.match(SRC, /translateToString\(true\)/)
    assert.match(SRC, /已复制选中内容/)
    assert.match(SRC, /已复制当前可见终端内容/)
  })

  it('terminal supports right-click menu and keyboard clipboard shortcuts', () => {
    const showMenuSrc = extractFunction(SRC, 'showTerminalContextMenu')
    const actionSrc = extractFunction(SRC, 'handleTerminalContextMenuAction')
    const shortcutSrc = extractFunction(SRC, 'handleTerminalClipboardShortcut')
    const pasteSrc = extractFunction(SRC, 'pasteClipboardToTerminal')
    const initSrc = extractFunction(SRC, 'initOfficialClaudeTerminal')
    const hideSrc = extractFunction(SRC, 'hideOfficialClaudeTerminal')

    assert.match(INDEX, /id="claude-terminal-context-menu"/)
    assert.match(INDEX, /data-claude-terminal-menu-action="copy-selection"/)
    assert.match(INDEX, /data-claude-terminal-menu-action="copy-visible"/)
    assert.match(INDEX, /data-claude-terminal-menu-action="paste"/)
    assert.match(STYLE, /\.claude-terminal-context-menu\s*{[\s\S]*?position:\s*fixed;/)
    assert.match(showMenuSrc, /terminalContextSelectionText = selectedTerminalText\(\)/)
    assert.match(
      showMenuSrc,
      /copySelectionButton\.disabled = !terminalContextSelectionText\.trim\(\)/,
    )
    assert.match(actionSrc, /const selection = terminalContextSelectionText/)
    assert.match(actionSrc, /copyTerminalContent\(\{ mode: 'selection', selection \}\)/)
    assert.match(actionSrc, /copyTerminalContent\(\{ mode: 'visible' \}\)/)
    assert.match(actionSrc, /pasteClipboardToTerminal\(\)/)
    assert.match(pasteSrc, /navigator\.clipboard\.readText/)
    assert.match(pasteSrc, /sendTerminalInput\(normalized\)/)
    assert.match(shortcutSrc, /if \(!event\.shiftKey && !selection\.trim\(\)\) return/)
    assert.match(shortcutSrc, /key === 'v' && navigator\.clipboard\?\.readText/)
    assert.match(
      initSrc,
      /document\.addEventListener\('contextmenu', handleTerminalContextMenu, true\)/,
    )
    assert.match(
      initSrc,
      /document\.addEventListener\('keydown', handleTerminalClipboardShortcut, true\)/,
    )
    assert.match(hideSrc, /hideTerminalContextMenu\(\)/)
  })

  it('cache-busts terminal assets consistently across index/sw/main', () => {
    assert.match(MAIN, /from '\.\/officialTerminal\.js\?v=17'/)
    assert.match(SW, /\/modules\/officialTerminal\.js\?v=17/)
    assert.match(INDEX, /\/modules\/main\.js\?v=81/)
    assert.match(INDEX, /\/style\.css\?v=66/)
    assert.match(INDEX, /sw-flush-v25/)
    assert.match(SW, /openclaude-v104/)
  })

  it('caches xterm selection (TTL + consume + new-interaction bounded) so TUI redraws do not drop copy', () => {
    // 选区一出现就缓存，复制兜底用缓存，TTL/消费/dispose 三重边界防陈旧。
    assert.match(SRC, /onSelectionChange\?\.\(/)
    assert.match(SRC, /lastTerminalSelection\s*=\s*selected/)
    const selSrc = extractFunction(SRC, 'cachedTerminalSelection')
    assert.match(selSrc, /TERMINAL_SELECTION_CACHE_TTL_MS/)
    const copySrc = extractFunction(SRC, 'copyTerminalContent')
    assert.match(copySrc, /clearTerminalSelectionCache\(\)/)
    const disposeSrc = extractFunction(SRC, 'disposeTerminal')
    assert.match(disposeSrc, /clearTerminalSelectionCache\(\)/)
  })

  it('drag/paste auto-uploads and writes the resulting path into the terminal input', () => {
    const dropSrc = extractFunction(SRC, 'handleTerminalDrop')
    assert.match(dropSrc, /insertPaths:\s*true/)
    const pasteSrc = extractFunction(SRC, 'handleTerminalPaste')
    assert.match(pasteSrc, /insertPaths:\s*true/)
    // 粘贴兼容 clipboardData.items 的截图，而不仅是 .files
    const clipSrc = extractFunction(SRC, 'clipboardFilesFromEvent')
    assert.match(clipSrc, /clipboardData\?\.items/)
    // 手动上传仍不写路径（保留原 uploads 面板行为）
    const upSrc = extractFunction(SRC, 'uploadTerminalFiles')
    assert.match(upSrc, /insertPaths\s*=\s*false/)
    assert.match(upSrc, /if \(insertPaths && path\) pasteTerminalFilePath\(path\)/)
  })

  it('re-fits terminal after web fonts load so the last row is not clipped', () => {
    const attachSrc = extractFunction(SRC, 'attachTerminal')
    assert.match(attachSrc, /document\.fonts\?\.ready/)
    assert.match(attachSrc, /fitTerminal\(\)/)
  })

  it('positions the sessions menu inside the viewport on both desktop and mobile', () => {
    // 桌面贴右缘向左展开，移动端覆盖回贴左缘；都限宽视口内。
    assert.match(STYLE, /\.claude-terminal-sessions-menu\s*\{[^}]*right:\s*0/)
    assert.match(
      STYLE,
      /\.claude-terminal-sessions-menu\s*\{[^}]*width:\s*min\(340px,\s*calc\(100vw/,
    )
  })

  it('terminal file downloads use short-lived ticket URLs instead of cookie-only navigation', () => {
    assert.match(SRC, /createTerminalFileDownloadUrl/)
    assert.match(SRC, /apiJson\(\s*'POST',\s*'\/api\/claude-terminal\/download-ticket'/)
    assert.match(SRC, /a\.href = url/)
    assert.doesNotMatch(SRC, /ensureSessionCookieForTerminalFiles/)
    assert.doesNotMatch(SRC, /\/api\/auth\/session/)
    assert.doesNotMatch(SRC, /state\.token[\s\S]*new URLSearchParams/)
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

  it('wake lock feature is fully removed, leaving no orphan code', () => {
    assert.doesNotMatch(INDEX, /claude-terminal-wake-lock-btn/)
    assert.doesNotMatch(SRC, /wakeLock|WAKE_LOCK_BTN_ID/)
    assert.doesNotMatch(STYLE, /claude-terminal-mobile-tools/)
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

  it('exposes a sessions popover with new + history controls in the toolbar', () => {
    assert.match(INDEX, /id="claude-terminal-sessions-btn"[\s\S]*aria-haspopup="menu"/)
    assert.match(INDEX, /id="claude-terminal-sessions-menu"[\s\S]*role="menu"/)
    assert.match(INDEX, /id="claude-terminal-sessions-new-btn"[\s\S]*role="menuitem"/)
    assert.match(INDEX, /id="claude-terminal-sessions-list"/)
    assert.match(STYLE, /\.claude-terminal-sessions-menu\s*{/)
  })

  it('new and attach intents reach the gateway via WS action query params', () => {
    const connectSrc = extractFunction(SRC, 'connectTerminal')
    assert.match(connectSrc, /action=new/)
    assert.match(
      connectSrc,
      /action=attach&sessionId=\$\{encodeURIComponent\(intent\.sessionId\)\}/,
    )
    // Auto-reconnects re-attach to the session being viewed.
    assert.match(connectSrc, /action=attach&sessionId=\$\{encodeURIComponent\(currentSessionId\)\}/)
    const newSrc = extractFunction(SRC, 'startNewClaudeSession')
    assert.match(newSrc, /reconnectTerminal\(\{ action: 'new' \}\)/)
    const attachSrc = extractFunction(SRC, 'attachClaudeSession')
    assert.match(attachSrc, /reconnectTerminal\(\{ action: 'attach', sessionId \}\)/)
  })

  it('renders a per-session delete control wired to the DELETE route', () => {
    const renderSrc = extractFunction(SRC, 'renderTerminalSessions')
    assert.match(renderSrc, /claude-terminal-session-delete/)
    assert.match(renderSrc, /deleteClaudeSession\(session\.sessionId\)/)
    assert.match(renderSrc, /stopPropagation\(\)/)
    const deleteSrc = extractFunction(SRC, 'deleteClaudeSession')
    assert.match(
      deleteSrc,
      /apiJson\(\s*'DELETE',\s*`\/api\/claude-terminal\/session\?sessionId=\$\{encodeURIComponent\(sessionId\)\}`/,
    )
    assert.match(STYLE, /\.claude-terminal-session-delete\s*{/)
  })

  it('renders session titles as untrusted text, not innerHTML', () => {
    const renderSrc = extractFunction(SRC, 'renderTerminalSessions')
    assert.match(renderSrc, /\.textContent = session\.title/)
    assert.doesNotMatch(renderSrc, /innerHTML\s*=\s*[^']*session\.title/)
  })

  it('connection status is announced to assistive tech via aria-live', () => {
    assert.match(INDEX, /id="claude-terminal-status"[\s\S]*aria-live="polite"/)
  })

  it('file tabs use valid tab/tabpanel ARIA roles', () => {
    assert.match(
      INDEX,
      /id="ct-file-tab-recent"\s+role="tab"\s+aria-selected="true"\s+aria-controls="ct-file-pane-recent"/,
    )
    assert.match(
      INDEX,
      /id="ct-file-pane-recent"\s+role="tabpanel"\s+aria-labelledby="ct-file-tab-recent"/,
    )
    const tabSrc = extractFunction(SRC, 'setTerminalFilePanelTab')
    assert.match(tabSrc, /setAttribute\('aria-selected'/)
  })

  it('context menu is keyboard navigable and busy buttons are disabled in flight', () => {
    const showSrc = extractFunction(SRC, 'showTerminalContextMenu')
    assert.match(showSrc, /contextMenuFocusables\(\)\[0\]\?\.focus\(\)/)
    const keySrc = extractFunction(SRC, 'handleTerminalContextMenuKeydown')
    assert.match(keySrc, /ArrowDown/)
    assert.match(keySrc, /ArrowUp/)
    const busySrc = extractFunction(SRC, 'updateTerminalBusyButtons')
    assert.match(busySrc, /reconnect\.disabled = connecting \|\| terminateInFlight/)
    assert.match(busySrc, /kill\.disabled = terminateInFlight/)
  })
})
