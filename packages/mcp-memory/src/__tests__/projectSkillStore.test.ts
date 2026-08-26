/**
 * MCP skill store uses OPENCLAUDE_PROJECT_ID the same way prompt SKILLS does.
 * Run: npx tsx --test packages/mcp-memory/src/__tests__/projectSkillStore.test.ts
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const home = await mkdtemp(join(tmpdir(), 'oc-mcp-psk-'))
process.env.OPENCLAUDE_HOME = home
process.env.OC_PROJECT_CONTEXT = '1'

const { buildRunSkillStore } = await import('@openclaude/storage')
const { commitProjectSkillOverlay } = await import('@openclaude/storage')

const PID = '55555555-5555-4555-8555-555555555555'

describe('mcp-memory project overlay wiring', () => {
  it('buildSkillStore reads OPENCLAUDE_PROJECT_ID and buildRunSkillStore', () => {
    const src = readFileSync(join(here, '../index.ts'), 'utf8')
    assert.match(src, /OPENCLAUDE_PROJECT_ID/)
    assert.match(src, /buildRunSkillStore/)
  })

  it('skill_list/view overlay returns project skill body, not just wiring strings', async () => {
    const srcDir = join(home, 'skill-src', 'overlay-skill')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(
      join(srcDir, 'SKILL.md'),
      '---\nname: overlay-skill\ndescription: from project overlay\n---\nsearch-me-unique-token\n',
    )
    const committed = await commitProjectSkillOverlay(PID, ['overlay-skill'], 0, {
      sourceFor: () => srcDir,
    })
    assert.equal(committed.ok, true)
    const store = buildRunSkillStore({ agentId: 'main', projectId: PID })
    const list = await store.list()
    assert.ok(list.some((s) => s.name === 'overlay-skill'))
    const viewed = await store.view('overlay-skill')
    assert.ok(viewed && typeof viewed !== 'string')
    assert.match(viewed.body, /search-me-unique-token/)
    const unbound = buildRunSkillStore({ agentId: 'main' })
    const unboundList = await unbound.list()
    assert.equal(unboundList.some((s) => s.name === 'overlay-skill'), false)
  })
})
