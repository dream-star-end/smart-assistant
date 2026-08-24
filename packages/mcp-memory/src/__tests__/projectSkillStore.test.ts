/**
 * MCP skill store uses OPENCLAUDE_PROJECT_ID the same way prompt SKILLS does.
 * Run: npx tsx --test packages/mcp-memory/src/__tests__/projectSkillStore.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

describe('mcp-memory project overlay wiring', () => {
  it('buildSkillStore reads OPENCLAUDE_PROJECT_ID and buildRunSkillStore', () => {
    const src = readFileSync(join(here, '../index.ts'), 'utf8')
    assert.match(src, /OPENCLAUDE_PROJECT_ID/)
    assert.match(src, /buildRunSkillStore/)
  })
})
