/**
 * Project context directory, instruction CAS, cwd allowlist (B3).
 * Run: npx tsx --test packages/storage/src/__tests__/projectContext.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const testHome = await mkdtemp(join(tmpdir(), 'oc-projctx-'))
process.env.OPENCLAUDE_HOME = testHome

const {
  assertAllowedCwd,
  commitProjectSkillOverlay,
  loadProjectContext,
  parseBoardProjectId,
  resolveProjectCwd,
  seedProjectInstructionsIfEmpty,
  writeProjectInstructions,
} = await import('../projectContext.js')

const ID = '11111111-1111-4111-8111-111111111111'

describe('parseBoardProjectId', () => {
  it('accepts uuid / null unbind / rejects junk', () => {
    assert.deepEqual(parseBoardProjectId(undefined), { present: false })
    assert.deepEqual(parseBoardProjectId(null), { present: true, value: null })
    assert.deepEqual(parseBoardProjectId(''), { present: true, value: null })
    const ok = parseBoardProjectId(ID)
    assert.equal('present' in ok && ok.present, true)
    if ('present' in ok && ok.present) assert.equal(ok.value, ID)
    assert.equal('invalid' in parseBoardProjectId('OCV5'), true)
    assert.equal('invalid' in parseBoardProjectId('../etc'), true)
  })
})

describe('PROJECT.md CAS (B2 single authority)', () => {
  it('writes with expectedVersion and rejects stale', async () => {
    const first = await writeProjectInstructions(ID, 'use tables', 0)
    assert.equal(first.ok, true)
    if (!first.ok) return
    assert.equal(first.snapshot.version, 1)
    assert.equal(first.snapshot.instructions, 'use tables')
    const stale = await writeProjectInstructions(ID, 'nope', 0)
    assert.equal(stale.ok, false)
    if (!stale.ok) assert.equal(stale.error, 'version_conflict')
    const loaded = await loadProjectContext(ID)
    assert.equal(loaded.instructions, 'use tables')
  })

  it('tampered PROJECT.md is not loaded for the next run', async () => {
    const id = '33333333-3333-4333-8333-333333333333'
    const first = await writeProjectInstructions(id, 'canonical', 0)
    assert.equal(first.ok, true)
    const file = (await import('../paths.js')).paths.projectInstructionsFile(id)
    await writeFile(file, 'tampered by agent\n', 'utf8')
    const loaded = await loadProjectContext(id)
    assert.equal(loaded.instructions, null)
  })

  it('skill overlay stages then CAS-flips; stale CAS leaves dir/hash/version unchanged', async () => {
    const id = '44444444-4444-4444-8444-444444444444'
    const { mkdir, writeFile: wf } = await import('node:fs/promises')
    const { paths } = await import('../paths.js')
    const { buildRunSkillStore } = await import('../skillStore.js')
    const src = join(testHome, 'skill-src', 'proj-skill')
    await mkdir(join(src, 'references'), { recursive: true })
    await mkdir(join(src, 'scripts'), { recursive: true })
    await wf(
      join(src, 'SKILL.md'),
      '---\nname: proj-skill\ndescription: overlay\n---\nbody-v1\n',
      'utf8',
    )
    await wf(join(src, 'references', 'note.md'), 'ref-ok\n', 'utf8')
    await wf(join(src, 'scripts', 'run.sh'), 'echo ok\n', 'utf8')
    const ok = await commitProjectSkillOverlay(id, ['proj-skill'], 0, { sourceFor: () => src })
    assert.equal(ok.ok, true)
    if (!ok.ok) return
    const liveDir = join(paths.projectSkillsDir(id), 'proj-skill')
    const liveMd = join(liveDir, 'SKILL.md')
    const before = await (await import('node:fs/promises')).readFile(liveMd, 'utf8')
    const stale = await commitProjectSkillOverlay(id, ['proj-skill'], 0, { sourceFor: () => src })
    assert.equal(stale.ok, false)
    if (!stale.ok) assert.equal(stale.error, 'version_conflict')
    const after = await (await import('node:fs/promises')).readFile(liveMd, 'utf8')
    assert.equal(after, before)
    const loaded = await loadProjectContext(id)
    assert.equal(loaded.version, 1)

    const store0 = buildRunSkillStore({ agentId: 'main', projectId: id })
    assert.ok((await store0.list()).some((s) => s.name === 'proj-skill'))
    const viewed = await store0.view('proj-skill')
    assert.ok(viewed && typeof viewed !== 'string')
    const sub = await store0.view('proj-skill', 'references/note.md')
    assert.equal(sub, 'ref-ok\n')

    await wf(liveMd, '---\nname: proj-skill\ndescription: overlay\n---\ntampered\n', 'utf8')
    const storeTamperMd = buildRunSkillStore({ agentId: 'main', projectId: id })
    assert.equal((await storeTamperMd.list()).some((s) => s.name === 'proj-skill'), false)
    assert.equal(await storeTamperMd.view('proj-skill'), null)
    assert.equal(await storeTamperMd.view('proj-skill', 'references/note.md'), null)

    await wf(liveMd, before, 'utf8')
    await wf(join(liveDir, 'references', 'note.md'), 'tampered-ref\n', 'utf8')
    const storeTamperRef = buildRunSkillStore({ agentId: 'main', projectId: id })
    assert.equal(await storeTamperRef.view('proj-skill'), null)
    assert.equal(await storeTamperRef.view('proj-skill', 'references/note.md'), null)

    await wf(join(liveDir, 'references', 'note.md'), 'ref-ok\n', 'utf8')
    await wf(join(liveDir, 'scripts', 'run.sh'), 'echo pwned\n', 'utf8')
    const storeTamperScript = buildRunSkillStore({ agentId: 'main', projectId: id })
    assert.equal(await storeTamperScript.view('proj-skill'), null)

    await wf(join(liveDir, 'scripts', 'run.sh'), 'echo ok\n', 'utf8')
    await wf(
      paths.projectMeta(id),
      JSON.stringify({
        schemaVersion: 1,
        version: 99,
        skillOverlay: ['forged'],
        contentManifest: { schemaVersion: 1, projectMdSha256: null, skills: [] },
      }),
    )
    const storeMeta = buildRunSkillStore({ agentId: 'main', projectId: id })
    assert.ok((await storeMeta.list()).some((s) => s.name === 'proj-skill'))

    const afterForge = await loadProjectContext(id)
    const unselect = await commitProjectSkillOverlay(id, [], afterForge.version)
    assert.equal(unselect.ok, true)
    const gone = await loadProjectContext(id)
    assert.deepEqual(gone.skillOverlay, [])
    const { existsSync } = await import('node:fs')
    assert.equal(existsSync(join(paths.projectSkillsDir(id), 'proj-skill')), false)
    const storeGone = buildRunSkillStore({ agentId: 'main', projectId: id })
    assert.equal((await storeGone.list()).some((s) => s.name === 'proj-skill'), false)
  })

  it('seed copies once then ignores later source', async () => {
    const id = '22222222-2222-4222-8222-222222222222'
    const a = await seedProjectInstructionsIfEmpty(id, 'from chat')
    assert.equal(a.instructions, 'from chat')
    const b = await seedProjectInstructionsIfEmpty(id, 'later pg edit')
    assert.equal(b.instructions, 'from chat')
  })
})

const { readFile: rf, readdir } = await import('node:fs/promises')
const { paths } = await import('../paths.js')

describe('B4 instructions seed never overwrites', () => {

  it('a hand-edited PROJECT.md with a stale hash is preserved, not replaced by the seed', async () => {
    const id = '55555555-5555-4555-8555-555555555555'
    const first = await writeProjectInstructions(id, 'canonical', 0)
    assert.equal(first.ok, true)
    await writeFile(paths.projectInstructionsFile(id), 'edited by hand\n', 'utf8')
    const seeded = await seedProjectInstructionsIfEmpty(id, 'stale pg text')
    assert.equal(seeded.instructions, null)
    assert.equal(seeded.instructionsFileStatus, 'mismatch')
    assert.equal(await rf(paths.projectInstructionsFile(id), 'utf8'), 'edited by hand\n')
    const conflict = seeded.meta.instructionsConflict
    assert.ok(conflict)
    assert.equal(await rf(join(paths.projectDir(id), conflict.file), 'utf8'), 'edited by hand\n')
    // Re-running the seed (e.g. every turn) preserves the same bytes once.
    await seedProjectInstructionsIfEmpty(id, 'stale pg text')
    const copies = (await readdir(paths.projectDir(id))).filter((f) => f.startsWith('PROJECT.conflict-'))
    assert.equal(copies.length, 1)
  })

  it('a human save over a mismatched file keeps a copy of the old bytes first', async () => {
    const id = '66666666-6666-4666-8666-666666666666'
    const first = await writeProjectInstructions(id, 'canonical', 0)
    assert.equal(first.ok, true)
    await writeFile(paths.projectInstructionsFile(id), 'agent wrote this\n', 'utf8')
    const saved = await writeProjectInstructions(id, 'new human text', 1)
    assert.equal(saved.ok, true)
    if (!saved.ok) return
    assert.equal(saved.snapshot.instructions, 'new human text')
    const conflict = saved.snapshot.meta.instructionsConflict
    assert.ok(conflict)
    assert.equal(await rf(join(paths.projectDir(id), conflict.file), 'utf8'), 'agent wrote this\n')
  })

  it('a deliberate clear is never refilled by a stale PG mirror', async () => {
    const id = '77777777-7777-4777-8777-777777777777'
    const seeded = await seedProjectInstructionsIfEmpty(id, 'from chat')
    assert.equal(seeded.instructions, 'from chat')
    const cleared = await writeProjectInstructions(id, null, seeded.version)
    assert.equal(cleared.ok, true)
    if (!cleared.ok) return
    assert.equal(cleared.snapshot.meta.instructionsState, 'cleared')
    // Next turn: the PG mirror still has the old text.
    const next = await seedProjectInstructionsIfEmpty(id, 'from chat')
    assert.equal(next.instructions, null)
    assert.equal(next.meta.instructionsState, 'cleared')
  })

  it('pre-B4 meta derives its state: hash means set, seed without hash means cleared', async () => {
    const setId = '88888888-8888-4888-8888-888888888888'
    const clearedId = '99999999-9999-4999-8999-999999999999'
    const ok = await writeProjectInstructions(setId, 'legacy', 0)
    assert.equal(ok.ok, true)
    const metaFile = paths.projectMeta(setId)
    const legacy = JSON.parse(await rf(metaFile, 'utf8'))
    delete legacy.instructionsState
    await writeFile(metaFile, JSON.stringify(legacy), 'utf8')
    assert.equal((await loadProjectContext(setId)).meta.instructionsState, 'set')

    await (await import('node:fs/promises')).mkdir(paths.projectDir(clearedId), { recursive: true })
    await writeFile(
      paths.projectMeta(clearedId),
      JSON.stringify({
        schemaVersion: 1,
        version: 2,
        instructionsSha256: null,
        contentManifest: { schemaVersion: 1, projectMdSha256: null, skills: [] },
        instructionsSeed: { from: 'chat_project', at: 1 },
      }),
      'utf8',
    )
    const legacyCleared = await seedProjectInstructionsIfEmpty(clearedId, 'from chat')
    assert.equal(legacyCleared.instructions, null)
    assert.equal(legacyCleared.meta.instructionsState, 'cleared')
  })

  it('a seed racing a human write cannot overwrite it (checked under the lock)', async () => {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const before = await loadProjectContext(id)
    assert.equal(before.meta.instructionsState, 'never')
    const human = await writeProjectInstructions(id, 'human first', before.version)
    assert.equal(human.ok, true)
    // A seed computed from the pre-write snapshot must be refused.
    const late = await writeProjectInstructions(id, 'seed', before.version + 1, { seedFromChat: true })
    assert.equal(late.ok, false)
    if (!late.ok) assert.equal(late.error, 'not_seedable')
    assert.equal((await loadProjectContext(id)).instructions, 'human first')
  })
})

describe('cwd allowlist (B3)', () => {
  it('rejects project data root and symlink escape', async () => {
    const ws = join(testHome, 'workspace')
    await mkdir(ws, { recursive: true })
    const data = join(testHome, 'projects', ID)
    await mkdir(data, { recursive: true })
    const escaped = assertAllowedCwd(data)
    assert.equal(escaped.ok, false)
    if (!escaped.ok) assert.equal(escaped.error, 'project_data_root')

    const outside = join(testHome, 'outside')
    await mkdir(outside, { recursive: true })
    const link = join(ws, 'escape')
    await symlink(outside, link)
    const hop = assertAllowedCwd(link)
    assert.equal(hop.ok, false)

    const isolated = resolveProjectCwd({ kind: 'isolated' }, ID)
    assert.equal(isolated.ok, true)
    if (isolated.ok) {
      assert.ok(isolated.cwd.includes(`${join('workspace', 'projects', ID)}`))
      assert.equal(isolated.cwd.includes(`${join('projects', ID)}`) && !isolated.cwd.includes('workspace'), false)
    }
  })

  it('rejects relative container_path', () => {
    const r = resolveProjectCwd({ kind: 'container_path', path: 'relative/path' }, ID)
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.error, 'relative_path')
  })
})
