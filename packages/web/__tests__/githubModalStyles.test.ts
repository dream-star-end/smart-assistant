import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const STYLE = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'style.css'),
  'utf-8',
)

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function cssBlock(selector: string): string {
  const re = new RegExp(`${escapeRegExp(selector)}\\s*\\{([\\s\\S]*?)\\n\\}`)
  const m = STYLE.match(re)
  assert.ok(m, `missing CSS block: ${selector}`)
  return m[1]
}

describe('GitHub modal selected row styles', () => {
  it('overrides the generic .github-row card background after that rule', () => {
    const genericIdx = STYLE.indexOf('.github-row,\n.key-row')
    assert.ok(genericIdx >= 0, 'expected generic .github-row card polish rule')

    const selectedIdx = STYLE.indexOf("#github-modal .github-row[aria-selected='true']")
    assert.ok(selectedIdx > genericIdx, 'selected GitHub row override must come after generic card rule')
  })

  it('keeps selected repo/branch rows readable over the selected background', () => {
    const block = cssBlock("#github-modal .github-row[aria-selected='true']")
    assert.match(block, /background:[^;]+!important;/)
    assert.match(block, /color:\s*var\(--accent-fg\) !important;/)
    assert.match(block, /border-color:[^;]+!important;/)

    const subBlock = cssBlock("#github-modal .github-row[aria-selected='true'] .github-row-sub")
    assert.match(subBlock, /color:[^;]+!important;/)
  })
})
