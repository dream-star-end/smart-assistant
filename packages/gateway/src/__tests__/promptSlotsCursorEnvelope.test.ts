/**
 * Cursor constant-compact envelope: no index / top-15, G1 byte-stable.
 * Run: npx tsx --test packages/gateway/src/__tests__/promptSlotsCursorEnvelope.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { FrozenProjectContext } from '@openclaude/storage'

const TEST_HOME = mkdtempSync(join(tmpdir(), 'oc-cursor-envelope-'))
process.env.OPENCLAUDE_HOME = TEST_HOME
process.env.OC_PROJECT_CONTEXT = '1'
delete process.env.OPENCLAUDE_PLATFORM_PROMPTS_DIR
delete process.env.OPENCLAUDE_V3_MASTER_BASE_URL
delete process.env.OPENCLAUDE_V3_CONTAINER_TOKEN
delete process.env.OC_USER_ROLE

const {
  buildMemorySlot,
  buildPromptContext,
  buildProjectMemorySlot,
  buildSkillsSlot,
  CURSOR_SKILLS_COMPACT,
} = await import('../promptSlots.js')
const { _internals } = await import('../engine/cursorAdapter.js')

const MCP_TOOLS = [
  'skill_search',
  'skill_list',
  'skill_view',
  'skill_save',
  'skill_delete',
  'create_reminder',
  'list_reminders',
  'update_reminder',
  'delete_reminder',
  'send_to_agent',
  'present_options',
]

function utf8(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

function seedSkill(agentId: string, name: string, desc: string): void {
  const dir = join(TEST_HOME, 'agents', agentId, 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\n`,
  )
}

function seedMemory(agentId: string, slug: string, desc: string): void {
  const dir = join(TEST_HOME, 'agents', agentId, 'memory')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${slug}.md`),
    `---\nname: ${slug}\ndescription: ${desc}\ntype: project\n---\nbody\n`,
  )
}

function seedMemoryIndex(agentId: string, rows: string[]): void {
  const root = join(TEST_HOME, 'agents', agentId)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'MEMORY.md'), `<!-- oc-memdir-index v1 -->\n${rows.join('\n')}\n`)
}

function fakeFrozen(over: Partial<FrozenProjectContext> = {}): FrozenProjectContext {
  return {
    boardProjectId: '11111111-1111-4111-8111-111111111111',
    bound: true,
    contextVersion: 1,
    assetsRevision: 0,
    assets: [],
    workspaceSpec: null,
    workspaceCwd: null,
    cwdSource: null,
    instructions: null,
    projectMdSha256: null,
    skills: [],
    skillManifestSha256: '0'.repeat(64),
    officialMemory: [],
    officialMemoryIndex: null,
    officialMemoryManifestSha256: null,
    ...over,
  }
}

function envelopeBytes(content: string, payload = 'ping'): number {
  const prompt = _internals.renderCursorPrompt(content, payload, _internals.CURSOR_PREAMBLE)
  return utf8(prompt) - utf8(payload)
}

describe('Cursor constant-compact envelope', () => {
  it('CURSOR_SKILLS_COMPACT is 132B and contains no digits', () => {
    assert.equal(utf8(CURSOR_SKILLS_COMPACT), 132)
    assert.doesNotMatch(CURSOR_SKILLS_COMPACT, /\d/)
    assert.doesNotMatch(CURSOR_SKILLS_COMPACT, /# Skills \(/)
  })

  it('cursor + bound fake project stays under 32KiB envelope', async () => {
    const agentId = 'cursor-bound-env'
    seedSkill(agentId, 'alpha-skill', 'an injected skill that must not enter the compact envelope')
    seedMemory(agentId, 'core-note', 'core hook that must not enter the compact envelope')
    seedMemoryIndex(agentId, ['- [core-note](memory/core-note.md) — core hook that must not enter the compact envelope'])
    const indexLines = Array.from({ length: 26 }, (_, i) => `- [m${i}](memory/m${i}.md) — official hook ${i}`)
    const frozen = fakeFrozen({
      officialMemoryIndex: indexLines.join('\n'),
      skills: Array.from({ length: 10 }, (_, i) => ({
        name: `proj-skill-${i}`,
        description: `project overlay skill ${i} with a long description that used to displace user skills`,
        files: [],
        treeSha256: '0'.repeat(64),
        skillMd: `---\nname: proj-skill-${i}\n---\n`,
      })),
    })
    const result = await buildPromptContext({
      agentId,
      provider: 'cursor',
      model: 'cursor-grok-4.6-high',
      availableMcpTools: MCP_TOOLS,
      frozenProjectContext: frozen,
      projectId: frozen.boardProjectId,
    })
    assert.ok(result.applied.some((s) => s.name === 'SKILLS'))
    assert.ok(result.applied.some((s) => s.name === 'MEMORY'))
    assert.ok(result.applied.some((s) => s.name === 'PROJECT_MEMORY'))
    const skills = result.applied.find((s) => s.name === 'SKILLS')
    assert.equal(skills?.bytes, 132)
    assert.doesNotMatch(result.content, /## 当前索引/)
    assert.doesNotMatch(result.content, /## 项目索引/)
    assert.doesNotMatch(result.content, /alpha-skill/)
    assert.doesNotMatch(result.content, /proj-skill-0/)
    assert.doesNotMatch(result.content, /core hook that must not enter/)
    const envelope = envelopeBytes(result.content)
    assert.ok(
      envelope < 32 * 1024,
      `bound compact envelope ${envelope} must stay under 32KiB (content ${utf8(result.content)})`,
    )
  })

  it('adding 50 memories and 50 skills does not change cursor content bytes', async () => {
    const agentId = 'cursor-g1'
    seedSkill(agentId, 'seed-skill', 'baseline skill')
    seedMemory(agentId, 'seed-note', 'baseline hook')
    seedMemoryIndex(agentId, ['- [seed-note](memory/seed-note.md) — baseline hook'])
    const frozen = fakeFrozen({
      officialMemoryIndex: '- [official](memory/official.md) — official hook',
    })
    const ctx = {
      agentId,
      provider: 'cursor' as const,
      availableMcpTools: MCP_TOOLS,
      frozenProjectContext: frozen,
      projectId: frozen.boardProjectId,
    }
    const before = await buildPromptContext(ctx)
    for (let i = 0; i < 50; i++) {
      seedSkill(agentId, `extra-skill-${i}`, `extra skill description ${i}`)
      seedMemory(agentId, `extra-note-${i}`, `extra hook ${i}`)
    }
    const extraRows = [
      '- [seed-note](memory/seed-note.md) — baseline hook',
      ...Array.from({ length: 50 }, (_, i) => `- [extra-note-${i}](memory/extra-note-${i}.md) — extra hook ${i}`),
    ]
    seedMemoryIndex(agentId, extraRows)
    const grownFrozen = fakeFrozen({
      officialMemoryIndex: [
        '- [official](memory/official.md) — official hook',
        ...Array.from({ length: 50 }, (_, i) => `- [pm-${i}](memory/pm-${i}.md) — project hook ${i}`),
      ].join('\n'),
      skills: Array.from({ length: 50 }, (_, i) => ({
        name: `grown-skill-${i}`,
        description: `grown overlay ${i}`,
        files: [],
        treeSha256: '0'.repeat(64),
        skillMd: `---\nname: grown-skill-${i}\n---\n`,
      })),
    })
    const after = await buildPromptContext({ ...ctx, frozenProjectContext: grownFrozen })
    assert.equal(utf8(after.content), utf8(before.content), 'G1: cursor content bytes must not grow')
    assert.equal(after.content, before.content, 'G1: cursor compact content must be identical')
  })

  it('non-cursor providers still inject memory and project indexes', async () => {
    const agentId = 'ccb-full-index'
    seedSkill(agentId, 'visible-skill', 'this skill must remain visible for CCB')
    seedMemory(agentId, 'visible-note', 'this hook must remain visible for CCB')
    seedMemoryIndex(agentId, ['- [visible-note](memory/visible-note.md) — this hook must remain visible for CCB'])
    const frozen = fakeFrozen({
      officialMemoryIndex: '- [official](memory/official.md) — official hook remains for CCB',
    })
    const result = await buildPromptContext({
      agentId,
      provider: 'ccb',
      frozenProjectContext: frozen,
      projectId: frozen.boardProjectId,
    })
    assert.match(result.content, /## 当前索引/)
    assert.match(result.content, /this hook must remain visible for CCB/)
    assert.match(result.content, /## 项目索引/)
    assert.match(result.content, /official hook remains for CCB/)
    assert.match(result.content, /visible-skill/)
    assert.match(result.content, /# Skills \(/)
  })

  it('compact SKILLS text has no numeric totals', async () => {
    const agentId = 'cursor-skills-digits'
    for (let i = 0; i < 20; i++) seedSkill(agentId, `n-skill-${i}`, `desc ${i}`)
    const slot = await buildSkillsSlot({ agentId, provider: 'cursor' })
    assert.ok(slot)
    assert.equal(slot.content, CURSOR_SKILLS_COMPACT)
    assert.doesNotMatch(slot.content, /\d/)
    const memory = await buildMemorySlot({ agentId, provider: 'cursor' })
    assert.doesNotMatch(memory.content, /## 当前索引/)
    const project = await buildProjectMemorySlot({
      agentId,
      provider: 'cursor',
      frozenProjectContext: fakeFrozen({
        officialMemoryIndex: '- [x](memory/x.md) — should not appear',
      }),
    })
    assert.ok(project)
    assert.doesNotMatch(project.content, /## 项目索引/)
    assert.doesNotMatch(project.content, /should not appear/)
  })
})
