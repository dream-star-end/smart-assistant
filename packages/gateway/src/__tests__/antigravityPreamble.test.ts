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
  it('documents eager core tools, 600000ms oc_bash ceiling, parallel reads, and no manage_task polling', () => {
    const text = ANTIGRAVITY_PREAMBLE
    assert.match(text, /oc_bash/)
    assert.match(text, /mcp_openclaude-memory_oc_bash/)
    assert.match(text, /600000/)
    assert.equal(text.includes('170000'), false)
    assert.equal(text.includes('180000'), false)
    assert.match(text, /oc_grep/)
    assert.match(text, /oc_glob/)
    assert.match(text, /call_mcp_tool/)
    assert.match(text, /manage_task/)
    assert.match(text, /parallel/i)
    assert.match(text, /brain/)
    assert.match(text, /file:\/\//)
    assert.match(text, /Prefer native `read_file`, `oc_grep`, and `oc_glob` over/)
    assert.match(text, /filter large JSON or log command outputs at the source/)
    assert.equal(text.includes('force_all_tools_eager'), false)
    assert.equal(text.includes('forceAllToolsEager'), false)
  })
})
