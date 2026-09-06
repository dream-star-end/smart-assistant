import assert from 'node:assert/strict'
import { execFile as execFileCb } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import { snapshotWorkspace } from '../src/host/workspace/snapshot.mjs'

const execFile = promisify(execFileCb)

async function git(cwd, args) {
  const result = await execFile('git', ['-C', cwd, ...args], { timeout: 8_000 })
  return String(result.stdout || '').trim()
}

test('snapshot writes refs/clarvy/* without moving HEAD or the current branch', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'clarvy-snap-'))
  try {
    await execFile('git', ['init', '-b', 'main'], { cwd: directory })
    await execFile('git', ['config', 'user.email', 's5@example.com'], { cwd: directory })
    await execFile('git', ['config', 'user.name', 'S5'], { cwd: directory })
    await writeFile(path.join(directory, 'README'), 's5\n')
    await execFile('git', ['add', 'README'], { cwd: directory })
    await execFile('git', ['commit', '-m', 'init'], { cwd: directory })
    const headBefore = await git(directory, ['rev-parse', 'HEAD'])
    const branchBefore = await git(directory, ['symbolic-ref', 'HEAD'])
    const snapped = await snapshotWorkspace(directory, { now: () => new Date('2026-09-06T12:00:00.000Z') })
    assert.equal(snapped.ok, true)
    assert.equal(snapped.ref, 'refs/clarvy/pre-session-2026-09-06T12-00-00-000Z')
    const resolved = await git(directory, ['rev-parse', snapped.ref])
    assert.equal(resolved, headBefore)
    assert.equal(await git(directory, ['rev-parse', 'HEAD']), headBefore)
    assert.equal(await git(directory, ['symbolic-ref', 'HEAD']), branchBefore)
    const branches = await git(directory, ['branch'])
    assert.equal(branches.includes('pre-session'), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('snapshot of a non-git directory returns a warning and does not throw', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'clarvy-nongit-'))
  try {
    const result = await snapshotWorkspace(directory)
    assert.equal(result.ok, false)
    assert.equal(result.warning, 'not-a-git-repository')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('snapshot warns when git is not on PATH', async () => {
  const result = await snapshotWorkspace('/tmp', {
    execFile: (_cmd, _args, _opts, callback) => {
      const error = new Error('not found')
      error.code = 'ENOENT'
      callback(error, '', '')
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.warning, 'git-not-found')
})
