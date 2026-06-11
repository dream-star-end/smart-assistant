import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'modules', 'officialTerminal.js'),
  'utf-8',
)

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
})
