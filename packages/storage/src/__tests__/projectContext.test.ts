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
