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
