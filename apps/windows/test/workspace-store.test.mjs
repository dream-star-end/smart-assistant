import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { buildWorkspaceEnv } from '../src/host/workspace/workspaceEnv.mjs'
import {
  createWorkspaceStore,
  parseWorkspacesDoc,
  resolveWorkspacesPath,
} from '../src/host/workspace/workspaces.mjs'

test('resolveWorkspacesPath uses %LOCALAPPDATA%\\Clarvy\\workspaces.json on Windows', () => {
  assert.equal(
    resolveWorkspacesPath({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' } }),
    'C:\\Users\\a\\AppData\\Local\\Clarvy\\workspaces.json',
  )
})

test('workspaces.json stores plaintext roots and no secret fields', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'clarvy-ws-'))
  const filePath = path.join(directory, 'workspaces.json')
  try {
    const store = createWorkspaceStore({ filePath })
    const first = await store.setWorkspace('/tmp/proj')
    assert.equal(first.ok, true)
    assert.deepEqual(first.roots, ['/tmp/proj'])
    const second = await store.setWorkspace('/tmp/other')
    assert.deepEqual(second.roots, ['/tmp/other', '/tmp/proj'])
    const raw = await readFile(filePath, 'utf8')
    assert.equal(raw.includes('oc-v3'), false)
    assert.equal(raw.includes('oc-dv'), false)
    assert.equal(raw.includes('BEGIN '), false)
    const parsed = JSON.parse(raw)
    assert.deepEqual(Object.keys(parsed).sort(), ['roots', 'version'])
    assert.equal(parsed.version, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('parseWorkspacesDoc ignores junk and dedupes roots', () => {
  assert.deepEqual(parseWorkspacesDoc('not-json').roots, [])
  assert.deepEqual(parseWorkspacesDoc(JSON.stringify({ roots: ['/a', '/a', ''] })).roots, ['/a'])
})

test('buildWorkspaceEnv exposes engineCwd and --add-dir for S6 to merge', () => {
  const env = buildWorkspaceEnv({ roots: ['/w/proj', '/w/other'], platform: 'posix' })
  assert.equal(env.engineCwd, '/w/proj')
  assert.deepEqual(env.addDirs, ['/w/proj', '/w/other'])
  assert.equal(env.extraEnv.OPENCLAUDE_ENGINE_CWD, '/w/proj')
  assert.equal(env.extraEnv.OPENCLAUDE_ADD_DIRS, '/w/proj:/w/other')
  assert.deepEqual(env.spawn.args, ['--add-dir', '/w/proj', '--add-dir', '/w/other'])
  assert.equal(env.spawn.cwd, '/w/proj')
})
