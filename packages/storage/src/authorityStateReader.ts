/** Pure sealed-state reader. Production facade has no host private-parent/staging/lock or legacy fallback. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { decodeManifest, decodeReceipt } from './authorityGenerationCodec.js'
import { profileSnapshot } from './userProfile.js'
export type AuthorityProfileReadContext = Readonly<{
  userId: string; generation: string; manifestSha256: string
  profile: Readonly<{ text: string; version: string }>
}>
const unavailable = () => new Error('Sealed authority state unavailable')
const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex')
function user(value: string) {
  if (typeof value !== 'string' || value.length > 19 || !/^[1-9][0-9]*$/.test(value) || BigInt(value).toString() !== value || BigInt(value) > 9223372036854775807n) throw unavailable()
  return value
}
/** Trusted composition/testing input only. Never put these parameters into an agent/body/environment protocol. */
export async function readSealedAuthorityStateAt(input: Readonly<{ stateRoot: string; userId: string; ownerUid: number }>): Promise<AuthorityProfileReadContext> {
  const stateRoot = input.stateRoot; const userId = user(input.userId); const ownerUid = input.ownerUid
  if (!isAbsolute(stateRoot) || resolve(stateRoot) !== stateRoot || stateRoot === '/' || !Number.isSafeInteger(ownerUid) || ownerUid < 0) throw unavailable()
  const directory = async (path: string) => {
    const stat = await lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== ownerUid || (stat.mode & 0o022) !== 0 || await realpath(path) !== path) throw unavailable()
  }
  const regular = async (path: string, max: number) => {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== ownerUid || stat.size > max || (stat.mode & 0o022) !== 0) throw unavailable()
    const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const actual = await fd.stat()
      if (actual.ino !== stat.ino || actual.dev !== stat.dev || actual.nlink !== 1 || actual.uid !== ownerUid || actual.size > max || (actual.mode & 0o022) !== 0) throw unavailable()
      return await fd.readFile()
    } finally { await fd.close() }
  }
  await directory(stateRoot)
  const generations = join(stateRoot, 'generations'); const commits = join(stateRoot, 'commits')
  await directory(generations); await directory(commits)
  const current = await regular(join(stateRoot, 'current.json'), 16777216)
  const manifest = decodeManifest(current, userId)
  const manifestSha256 = sha(current)
  const expectedSeal = Buffer.from(JSON.stringify({ version: 1, userId, generation: manifest.generation, manifestSha256 }))
  const seal = await regular(join(stateRoot, 'sealed.json'), 1024)
  if (!seal.equals(expectedSeal) || !(await regular(join(commits, `${manifestSha256}.json`), 1024)).equals(expectedSeal)) throw unavailable()
  const selected = join(generations, manifest.generation)
  await directory(selected); await directory(join(selected, 'data')); await directory(join(selected, 'receipts'))
  if (JSON.stringify((await readdir(selected)).sort()) !== '["data","manifest.json","receipts"]'
    || JSON.stringify(await readdir(join(selected, 'data'))) !== '["user.md"]'
    || !(await regular(join(selected, 'manifest.json'), 16777216)).equals(current)) throw unavailable()
  const receipts = manifest.files.filter(f => f.path.startsWith('receipts/')).map(f => f.path.slice(9)).sort()
  if (JSON.stringify((await readdir(join(selected, 'receipts'))).sort()) !== JSON.stringify(receipts)) throw unavailable()
  let profile: Buffer | undefined
  for (const file of manifest.files) {
    const value = await regular(join(selected, file.path), file.path === 'data/user.md' ? 1048576 : 65536)
    if (value.length !== file.size || sha(value) !== file.sha256) throw unavailable()
    if (file.path === 'data/user.md') profile = value
    else decodeReceipt(value, userId, file.path.slice(9, -5))
  }
  if (!profile || !(await regular(join(stateRoot, 'current.json'), 16777216)).equals(current)
    || !(await regular(join(stateRoot, 'sealed.json'), 1024)).equals(seal)) throw unavailable()
  return Object.freeze({ userId, generation: manifest.generation, manifestSha256, profile: Object.freeze(profileSnapshot(profile.toString('utf8'))) })
}
/** No environment/user paths or owner overrides. Does not assert that an actual kernel RO mount exists. */
export function createContainerAuthorityStateReader(trustedUserId: string) {
  const userId = user(trustedUserId)
  return Object.freeze({ capture: () => readSealedAuthorityStateAt({ stateRoot: '/run/oc/system-state', userId, ownerUid: 0 }) })
}
