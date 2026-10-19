/**
 * Run: npx tsx --test packages/gateway/src/__tests__/antigravityPreamble.test.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

process.env.OPENCLAUDE_HOME ??= mkdtempSync(join(tmpdir(), 'oc-agy-preamble-'))

const { ANTIGRAVITY_PREAMBLE } = await import('../engine/antigravityPlatform.js')

describe('ANTIGRAVITY_PREAMBLE local CLI hints', () => {
  it('names oc_bash/oc_grep/oc_glob and does not invent an eager config key', () => {
    const text = ANTIGRAVITY_PREAMBLE
    assert.match(text, /oc_bash/)
    assert.match(text, /170000/)
    assert.equal(text.includes('180000'), false)
    assert.match(text, /oc_grep/)
    assert.match(text, /oc_glob/)
    assert.match(text, /call_mcp_tool/)
    assert.match(text, /brain/)
    assert.match(text, /file:\/\//)
    assert.equal(text.includes('force_all_tools_eager'), false)
    assert.equal(text.includes('forceAllToolsEager'), false)
  })
})
