import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { createAuthorityPaths } from '../authorityPaths.js'
import { profileSnapshot, writeUserProfileAt } from '../userProfile.js'

test('explicit profile writer shares the once-normalized read CAS contract and preserves a stale write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oc-profile-cas-'))
  const locations = createAuthorityPaths(root)
  const raw = 'first\r\r\nsecond'
  await writeFile(locations.sharedUserMd, raw)
  const first = profileSnapshot(raw)
  const result = await writeUserProfileAt(locations, 'approved update', first.version)
  assert.equal(result.ok, true)
  const stale = await writeUserProfileAt(locations, 'stale update', first.version)
  assert.equal(stale.ok, false)
  assert.equal(await readFile(locations.sharedUserMd, 'utf8'), 'approved update')
})
test('explicit writer rejects missing CAS and never treats an IO error as empty input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oc-profile-io-'))
  const locations = createAuthorityPaths(root)
  await assert.rejects(writeUserProfileAt(locations, 'update', ''), /CAS version/)
  await mkdir(locations.sharedUserMd)
  await assert.rejects(writeUserProfileAt(locations, 'update', profileSnapshot('').version), { code: 'EISDIR' })
})
