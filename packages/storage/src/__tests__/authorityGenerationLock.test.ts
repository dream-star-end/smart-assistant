import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, link, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { acquireAuthorityGenerationLock } from '../authorityGenerationLock.js'
function attempt(path: string) {
  return new Promise<number | null>((resolve, reject) => {
    const child = spawn('/usr/bin/flock', ['--nonblock', path, '/usr/bin/true'], { stdio: 'ignore', env: { PATH: '/usr/bin:/bin' } })
    child.once('error', reject); child.once('close', resolve)
  })
}
test('retained Node fd keeps actual kernel lock after acquiring helper has exited', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oc-generation-retained-lock-'))
  const path = join(root, 'publish.lock')
  const lock = await acquireAuthorityGenerationLock(path)
  try {
    assert.equal(await attempt(path), 1)
    await assert.rejects(acquireAuthorityGenerationLock(path, 50), /lock/)
    assert.equal(await attempt(path), 1)
  } finally { await lock.release() }
  assert.equal(await attempt(path), 0)
  await lock.release()
})
test('generation lock rejects aliases, hard links and other-readable lock inodes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oc-generation-lock-alias-'))
  const original = join(root, 'original'); await writeFile(original, '', { mode: 0o600 })
  const alias = join(root, 'alias'); await symlink(original, alias)
  await assert.rejects(acquireAuthorityGenerationLock(alias))
  const hard = join(root, 'hard'); await link(original, hard)
  await assert.rejects(acquireAuthorityGenerationLock(hard))
  const broad = join(root, 'broad'); await writeFile(broad, '', { mode: 0o600 }); await chmod(broad, 0o644)
  await assert.rejects(acquireAuthorityGenerationLock(broad))
})
