/**
 * B7: one loadFrozenProjectContext; slots + persist consume the same object.
 * Run: npx tsx --test packages/gateway/src/__tests__/frozenProjectContext.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'oc-frozen-pc-'))
process.env.OPENCLAUDE_HOME = home
process.env.OC_PROJECT_CONTEXT = '1'

const {
  commitProjectSkillOverlay,
  frozenProjectDigests,
  loadFrozenProjectContext,
  writeProjectInstructions,
} = await import('@openclaude/storage')
const { buildPromptContext, buildProjectSlot, buildProjectMemorySlot, buildSkillsSlot } =
  await import('../promptSlots.js')
const { persistRunContextSnapshot, createRunContextDescriptor } = await import('../runContextPersist.js')
const { getTaskboardDb } = await import('../taskboard/db/index.js')
const { createProject } = await import('../taskboard/db/projects.js')
const { ProjectMemoryLedger } = await import('@openclaude/storage')

describe('single frozen project context', () => {
  it('mutating after freeze does not change current slots or snapshot', async () => {
    const db = getTaskboardDb()
    const project = createProject(db, { key: 'FRZ', name: 'frozen' })
    const first = await writeProjectInstructions(project.id, 'old-ins', 0)
    assert.equal(first.ok, true)
    const src = join(home, 'skill-src', 'frz-skill')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'SKILL.md'), '---\nname: frz-skill\ndescription: frozen-skill\n---\nold-skill\n')
    const overlay = await commitProjectSkillOverlay(project.id, ['frz-skill'], first.ok ? first.snapshot.version : 0, {
      sourceFor: () => src,
      db,
    })
    assert.equal(overlay.ok, true)
    const cand = await new ProjectMemoryLedger(db).createCandidate({
      projectId: project.id,
      slug: 'notes.md',
      content: '---\nname: n\ndescription: d\ntype: project\n---\nold-mem\n',
      actor: 'agent:x',
    })
    assert.equal(cand.ok, true)
    if (cand.ok) {
      await new ProjectMemoryLedger(db).promote({
        projectId: project.id,
        candidateId: cand.candidate.id,
        expectedVersion: cand.candidate.version,
        actor: 'user:default',
      })
    }

    const frozen = await loadFrozenProjectContext({
      boardProjectId: project.id,
      assets: [{ id: 'a1', name: 'old.png' } as never],
      assetsRevision: 11,
      db,
    })
    assert.equal(frozen.instructions, 'old-ins')
    assert.ok(frozen.skills.some((s) => s.name === 'frz-skill'))
    assert.ok(frozen.officialMemory.some((m) => m.slug === 'notes.md'))

    await writeProjectInstructions(project.id, 'new-ins', frozen.contextVersion)
    writeFileSync(join(src, 'SKILL.md'), '---\nname: frz-skill\ndescription: new\n---\nnew-skill\n')
    const live = await loadFrozenProjectContext({ boardProjectId: project.id, db })
    const restage = await commitProjectSkillOverlay(project.id, ['frz-skill'], live.contextVersion, {
      sourceFor: () => src,
      db,
    })
    assert.equal(restage.ok, true)

    const ctx = {
      agentId: 'main',
      projectId: project.id,
      projectContext: {
        boardProjectId: project.id,
        chatProjectId: null,
        name: 'frozen',
        instructions: frozen.instructions,
        assets: frozen.assets,
        assetsRevision: frozen.assetsRevision,
        bound: true as const,
      },
      frozenProjectContext: frozen,
    }
    const projectSlot = await buildProjectSlot(ctx)
    assert.match(projectSlot?.content ?? '', /old-ins/)
    assert.doesNotMatch(projectSlot?.content ?? '', /new-ins/)
    const skillSlot = await buildSkillsSlot(ctx)
    assert.match(skillSlot?.content ?? '', /frozen-skill/)
    const memSlot = await buildProjectMemorySlot(ctx)
    assert.ok(memSlot)

    const built = await buildPromptContext(ctx)
    assert.equal(built.frozenProjectContext?.contextVersion, frozen.contextVersion)
    assert.equal(built.frozenProjectContext?.projectMdSha256, frozen.projectMdSha256)

    const persisted = await persistRunContextSnapshot({
      descriptor: createRunContextDescriptor({
        runId: 'freeze-run',
        boardProjectId: project.id,
        channel: 'taskboard',
        agentId: 'main',
        sessionKey: 'sk',
        persistSnapshot: true,
      }),
      applied: built.applied,
      promptContentSha256: built.contentSha256,
      cwd: home,
      frozen: frozenProjectDigests(frozen),
    })
    assert.equal(persisted.wrote, true)
    assert.equal(persisted.contextVersion, frozen.contextVersion)

    const next = await loadFrozenProjectContext({ boardProjectId: project.id, db })
    assert.equal(next.instructions, 'new-ins')
    assert.notEqual(next.contextVersion, frozen.contextVersion)
  })
})
