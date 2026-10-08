/**
 * The project home's read-only folder view never leaves the project's root.
 * Run: npx tsx --test packages/gateway/src/taskboard/__tests__/projectWorkspaceFiles.test.ts
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import {
  PROJECT_WORKSPACE_LIST_MAX,
  listProjectWorkspaceDir,
  openProjectWorkspaceFile,
  resolveProjectWorkspaceRoot,
} from '../projectWorkspaceFiles.js'

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function tree() {
  const base = mkdtempSync(join(tmpdir(), 'oc-wsfiles-'))
  const root = join(base, 'root')
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(join(root, 'README.md'), '# hi')
  writeFileSync(join(root, 'docs', 'plan.md'), 'plan')
  writeFileSync(join(base, 'secret.txt'), 'outside')
  symlinkSync(join(base, 'secret.txt'), join(root, 'escape.txt'))
  symlinkSync(base, join(root, 'up'))
  return { base, root }
}

describe('project workspace files', () => {
  test('lists folders first, marks symlinks as links, gives sizes for files', async () => {
    const { root } = tree()
    const r = await listProjectWorkspaceDir(root, '')
    assert.ok(r.ok)
    assert.deepEqual(
      r.entries.map((e) => [e.name, e.type]),
      [
        ['docs', 'dir'],
        ['escape.txt', 'link'],
        ['README.md', 'file'],
        ['up', 'link'],
      ],
    )
    assert.equal(r.entries.find((e) => e.name === 'README.md')?.size, 4)
    const sub = await listProjectWorkspaceDir(root, 'docs')
    assert.ok(sub.ok)
    assert.equal(sub.path, 'docs')
    assert.deepEqual(sub.entries.map((e) => e.name), ['plan.md'])
  })

  test('.., absolute paths and symlinks out of the root are refused', async () => {
    const { root, base } = tree()
    for (const p of ['..', 'docs/../..', join(base, 'secret.txt'), 'up']) {
      const r = await listProjectWorkspaceDir(root, p)
      assert.equal(r.ok, false, p)
    }
    const esc = await openProjectWorkspaceFile(root, 'escape.txt')
    assert.deepEqual(esc, { ok: false, error: 'invalid_path' })
    const viaDir = await openProjectWorkspaceFile(root, 'up/secret.txt')
    assert.deepEqual(viaDir, { ok: false, error: 'invalid_path' })
    // A link that resolves back inside the root is fine.
    const back = await openProjectWorkspaceFile(root, 'up/root/README.md')
    assert.ok(back.ok)
  })

  test('opens a file inside the root; a folder or a missing file is not a file', async () => {
    const { root } = tree()
    const ok = await openProjectWorkspaceFile(root, 'docs/plan.md')
    assert.ok(ok.ok)
    assert.equal(ok.name, 'plan.md')
    assert.equal(ok.size, 4)
    assert.deepEqual(await openProjectWorkspaceFile(root, 'docs'), { ok: false, error: 'not_file' })
    assert.deepEqual(await openProjectWorkspaceFile(root, 'nope.md'), { ok: false, error: 'not_found' })
    assert.deepEqual(await openProjectWorkspaceFile(root, ''), { ok: false, error: 'invalid_path' })
  })

  test('long folders are cut at the limit and say so', async () => {
    const root = mkdtempSync(join(tmpdir(), 'oc-wsfiles-many-'))
    for (let i = 0; i <= PROJECT_WORKSPACE_LIST_MAX; i++) writeFileSync(join(root, `f${i}`), '')
    const r = await listProjectWorkspaceDir(root, '')
    assert.ok(r.ok)
    assert.equal(r.truncated, true)
    assert.equal(r.entries.length, PROJECT_WORKSPACE_LIST_MAX)
  })

  test('a default-workspace project has a folder only when the default workspace is configured', () => {
    const ws = mkdtempSync(join(tmpdir(), 'oc-wsfiles-default-'))
    assert.deepEqual(resolveProjectWorkspaceRoot({ id: ID, workspaceSpec: { kind: 'default' } }, {}), {
      ok: false,
      error: 'no_workspace',
    })
    const r = resolveProjectWorkspaceRoot({ id: ID, workspaceSpec: null }, { OPENCLAUDE_DEFAULT_WORKSPACE: ws })
    assert.deepEqual(r, { ok: true, root: ws, kind: 'default' })
  })
})
