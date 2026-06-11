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

function extractFunction(source: string, name: string): string {
  const lines = source.split('\n')
  const fnLineIdx = lines.findIndex((line) =>
    new RegExp(`^(?:export\\s+)?function\\s+${name}\\s*\\(`).test(line),
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

    assert.match(terminateSrc, /closeSocket\(true\)/)
    assert.match(terminateSrc, /disposeTerminal\(\)/)
  })

  it('quick terminal keys send bytes without focusing the mobile textarea', () => {
    const quickKeySrc = extractFunction(SRC, 'sendQuickKey')
    const initSrc = extractFunction(SRC, 'initOfficialClaudeTerminal')

    assert.match(initSrc, /pointerdown/)
    assert.doesNotMatch(quickKeySrc, /focusMobileInput/)
    assert.match(quickKeySrc, /button\?\.blur\?\.\(\)/)
  })

  it('mobile scroll buttons use xterm scrollback actions instead of textarea focus', () => {
    const scrollSrc = extractFunction(SRC, 'scrollTerminal')
    const controlSrc = extractFunction(SRC, 'runMobileControl')

    assert.match(INDEX, /data-claude-terminal-action="page-up"/)
    assert.match(INDEX, /data-claude-terminal-action="page-down"/)
    assert.match(INDEX, /data-claude-terminal-action="bottom"/)
    assert.match(scrollSrc, /terminal\.scrollPages\(-1\)/)
    assert.match(scrollSrc, /terminal\.scrollPages\(1\)/)
    assert.match(scrollSrc, /terminal\.scrollToBottom\(\)/)
    assert.match(controlSrc, /scrollTerminal\(button\.dataset\.claudeTerminalAction\)/)
    assert.doesNotMatch(controlSrc, /focusMobileInput/)
  })

  it('mobile input dock is hidden on desktop and shown on narrow screens only', () => {
    assert.match(STYLE, /\.claude-terminal-mobile-dock\s*{\s*display:\s*none;/)
    assert.match(
      STYLE,
      /@media \(max-width: 860px\) {[\s\S]*?\.claude-terminal-mobile-dock\s*{[\s\S]*?display:\s*flex;/,
    )
  })

  it('touch dragging the terminal maps to xterm scrollback lines', () => {
    const moveSrc = extractFunction(SRC, 'handleTerminalTouchMove')
    const bindSrc = extractFunction(SRC, 'bindTerminalTouchScrollTargets')
    const cleanupSrc = extractFunction(SRC, 'cleanupTerminalTouchScrollTargets')

    assert.match(moveSrc, /terminal\.scrollLines\(lines\)/)
    assert.match(moveSrc, /terminalTouchScrollRemainder/)
    assert.match(moveSrc, /event\.cancelable/)
    assert.match(bindSrc, /'touchmove'/)
    assert.match(bindSrc, /passive:\s*false/)
    assert.match(cleanupSrc, /removeEventListener\('touchmove'/)
  })
})
