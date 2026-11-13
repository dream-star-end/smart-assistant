import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createAuthorityPaths, openProjectFormalReadonly } from '@openclaude/storage'
import { initializeProjectFormalLedger } from '../system-assistant/projectFormalInit.js'
const projectId = 'd6100000-0000-4000-8000-000000000765'
test('host-only initializer creates the independent complete readonly schema in an explicit private fixture root', async () => {
  const a = createAuthorityPaths(await mkdtemp(join(tmpdir(), 'oc-project-formal-init-')))
  initializeProjectFormalLedger(a)
  const view = openProjectFormalReadonly(a)
  try { assert.deepEqual(view.snapshot(projectId), { skills: [], official: [] }) } finally { view.close() }
  const before = await readFile(a.projectLedgerDb)
  assert.throws(() => initializeProjectFormalLedger(a), { code: 'EEXIST' })
  assert.deepEqual(await readFile(a.projectLedgerDb), before)
})
test('host-only initializer refuses public or symlinked fixture roots without creating a ledger', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oc-project-formal-init-'))
  await chmod(root, 0o755)
  assert.throws(() => initializeProjectFormalLedger(createAuthorityPaths(root)), /private/)
  await assert.rejects(readFile(join(root, 'formal-project.sqlite')), { code: 'ENOENT' })
  const parent = await mkdtemp(join(tmpdir(), 'oc-project-formal-alias-'))
  const alias = join(parent, 'alias'); await symlink(root, alias)
  assert.throws(() => initializeProjectFormalLedger(createAuthorityPaths(alias)), /symlink/)
})
