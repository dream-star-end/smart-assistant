/** Inert host-only prototype. No operation registration, legacy import, worker or container activation. */
import { constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, readdir, realpath, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { createAuthorityPaths, type AuthorityPaths } from './authorityPaths.js'
import { acquireKernelFileLock } from './kernelFileLock.js'
import { profileSnapshot, writeUserProfileAt } from './userProfile.js'
import type { SystemActionReceiptBinding } from './systemActions.js'

export type AuthorityStore = Readonly<{ hostRoot: string; userId: string }>
type FileEntry = { path: string; size: number; sha256: string }
type Manifest = { version: 1; userId: string; generation: string; parent: string | null; files: FileEntry[] }
export type ProfileGenerationReceipt = Readonly<{
  binding: SystemActionReceiptBinding
  generation: string
  result: { version: string }
}>
export type AuthorityGeneration = Readonly<{
  userId: string; generation: string; manifestSha256: string; paths: AuthorityPaths
  /** Private verified snapshot, not a mutable on-disk writer. */
  manifest: Readonly<Manifest>
}>
export type GenerationFault = 'generation-durable' | 'manifest-visible' | 'manifest-durable' | 'seal-prepared' | 'seal-durable'
/** Fixed fault names are solely a crash-test seam; no user callbacks/commands are accepted. */
type TestFault = { faultAfter?: GenerationFault }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHA = /^[0-9a-f]{64}$/
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value))
const unknown = () => new Error('Authority generation unavailable; outcome unknown')

function identity(store: AuthorityStore) {
  if (!/^[1-9][0-9]*$/.test(store.userId) || BigInt(store.userId) > 9223372036854775807n) throw unknown()
  if (!isAbsolute(store.hostRoot) || resolve(store.hostRoot) !== store.hostRoot || store.hostRoot === '/') throw unknown()
  const root = join(store.hostRoot, `u${store.userId}`)
  const state = join(root, 'state')
  return { root, state, generations: join(state, 'generations'), commits: join(state, 'commits'), staging: join(root, 'staging'), lock: join(root, 'publish.lock') }
}
function snapshotStore(store: AuthorityStore): AuthorityStore {
  const captured = Object.freeze({ hostRoot: store.hostRoot, userId: store.userId })
  identity(captured)
  return captured
}
async function directory(path: string, privateMode = false) {
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & (privateMode ? 0o077 : 0o022)) !== 0 || await realpath(path) !== path) throw unknown()
}
async function locations(store: AuthorityStore) {
  const out = identity(store)
  await directory(store.hostRoot, true)
  await directory(out.root, true)
  await directory(out.state)
  await directory(out.generations)
  await directory(out.commits)
  await directory(out.staging, true)
  return out
}
async function regular(path: string, maxBytes: number) {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.size > maxBytes || (stat.mode & 0o022) !== 0) throw unknown()
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const actual = await handle.stat()
    if (actual.ino !== stat.ino || actual.dev !== stat.dev) throw unknown()
    return await handle.readFile()
  } finally { await handle.close() }
}
async function sync(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}
async function createDirectory(path: string, mode: number) {
  await mkdir(path, { mode }).catch(err => { if (err.code !== 'EEXIST') throw err })
  await directory(path, mode === 0o700)
}
function binding(value: SystemActionReceiptBinding, userId: string): SystemActionReceiptBinding {
  if (!value || value.userId !== userId || !UUID.test(value.id) || !SHA.test(value.inputHash) || (typeof value.requestHash !== 'string' || !SHA.test(value.requestHash)) || !Number.isSafeInteger(value.operationVersion) || value.operationVersion < 1) throw unknown()
  for (const part of [value.sessionId, value.agentId, value.operationId]) if (typeof part !== 'string' || !part || part.length > 256 || part.includes('\0')) throw unknown()
  return { id: value.id, userId, sessionId: value.sessionId, agentId: value.agentId, operationId: value.operationId, operationVersion: value.operationVersion, requestHash: value.requestHash, inputHash: value.inputHash }
}
function decodeReceipt(raw: Buffer, userId: string, id: string): ProfileGenerationReceipt {
  const value = JSON.parse(raw.toString('utf8')) as ProfileGenerationReceipt
  const exact = binding(value.binding, userId)
  if (exact.id !== id || !UUID.test(value.generation) || !/^[0-9a-f]{16}$/.test(value.result?.version)) throw unknown()
  if (!bytes({ binding: exact, generation: value.generation, result: { version: value.result.version } }).equals(raw)) throw unknown()
  return Object.freeze({ binding: Object.freeze(exact), generation: value.generation, result: Object.freeze({ version: value.result.version }) })
}
function decodeManifest(raw: Buffer, userId: string): Manifest {
  const m = JSON.parse(raw.toString('utf8')) as Manifest
  if (m.version !== 1 || m.userId !== userId || !UUID.test(m.generation) || (m.parent !== null && !SHA.test(m.parent)) || !Array.isArray(m.files)) throw unknown()
  const seen = new Set<string>()
  for (const file of m.files) {
    if (!file || (file.path !== 'data/user.md' && !/^receipts\/[0-9a-f-]{36}\.json$/.test(file.path)) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > (file.path === 'data/user.md' ? 1048576 : 65536) || !SHA.test(file.sha256) || seen.has(file.path)) throw unknown()
    seen.add(file.path)
  }
  if (!bytes(m.files).equals(bytes(m.files.map(f => ({ path: f.path, size: f.size, sha256: f.sha256 }))))) throw unknown()
  if (!seen.has('data/user.md') || !bytes(m.files.map(f => f.path)).equals(bytes([...seen].sort()))) throw unknown()
  if (!bytes({ version: 1, userId, generation: m.generation, parent: m.parent, files: m.files }).equals(raw)) throw unknown()
  return m
}
async function verifyTree(store: AuthorityStore, manifest: Manifest, stagingRoot?: string) {
  const loc = await locations(store)
  const root = stagingRoot ?? join(loc.generations, manifest.generation)
  await directory(root)
  for (const name of ['data', 'receipts']) await directory(join(root, name))
  const actual = (await readdir(root)).sort()
  if (JSON.stringify(actual) !== '["data","manifest.json","receipts"]' || JSON.stringify(await readdir(join(root, 'data'))) !== '["user.md"]') throw unknown()
  if (!(await regular(join(root, 'manifest.json'), 16777216)).equals(bytes(manifest))) throw unknown()
  const expected = manifest.files.filter(f => f.path.startsWith('receipts/')).map(f => f.path.slice(9)).sort()
  if (JSON.stringify((await readdir(join(root, 'receipts'))).sort()) !== JSON.stringify(expected)) throw unknown()
  for (const file of manifest.files) {
    const value = await regular(join(root, file.path), file.path === 'data/user.md' ? 1048576 : 65536)
    if (value.length !== file.size || hash(value) !== file.sha256) throw unknown()
    if (file.path.startsWith('receipts/')) decodeReceipt(value, store.userId, file.path.slice(9, -5))
  }
  return root
}
async function readCurrent(store: AuthorityStore, sealed: boolean) {
  const loc = await locations(store)
  const raw = await regular(join(loc.state, 'current.json'), 16777216)
  const manifest = decodeManifest(raw, store.userId)
  const manifestSha256 = hash(raw)
  if (sealed) {
    const seal = await regular(join(loc.state, 'sealed.json'), 1024)
    if (!seal.equals(bytes({ version: 1, userId: store.userId, generation: manifest.generation, manifestSha256 }))) throw unknown()
  }
  const root = await verifyTree(store, manifest)
  return { loc, root, manifest, manifestSha256 }
}
/** Pure lookup: no creation, repair, fallback to RW legacy data or orphan activation. */
export async function readAuthorityGeneration(store: AuthorityStore): Promise<AuthorityGeneration> {
  store = snapshotStore(store)
  const current = await readCurrent(store, true)
  return Object.freeze({ userId: store.userId, generation: current.manifest.generation, manifestSha256: current.manifestSha256, paths: createAuthorityPaths(join(current.root, 'data')), manifest: Object.freeze({ ...current.manifest, files: Object.freeze(current.manifest.files.map(file => Object.freeze(file))) }) as Readonly<Manifest> })
}
export async function findProfileGenerationReceipt(store: AuthorityStore, expected: SystemActionReceiptBinding): Promise<ProfileGenerationReceipt | null> {
  store = snapshotStore(store)
  const exact = binding(expected, store.userId)
  const current = await readCurrent(store, true)
  const path = `receipts/${exact.id}.json`
  if (!current.manifest.files.some(file => file.path === path)) return null // Absence never authorizes retry/unfencing.
  const receipt = decodeReceipt(await regular(join(current.root, path), 65536), store.userId, exact.id)
  if (!bytes(receipt.binding).equals(bytes(exact))) throw unknown()
  return receipt
}
async function atomicMetadata(state: string, name: string, value: Buffer, fault?: TestFault) {
  const temp = join(state, `.${name}-${randomUUID()}`)
  await writeFile(temp, value, { flag: 'wx', mode: 0o444 })
  await sync(temp)
  if (fault) crash(fault, 'seal-prepared')
  await rename(temp, join(state, name))
}
function crash(fault: TestFault, phase: GenerationFault) { if (fault.faultAfter === phase) throw unknown() }
async function sealCurrent(store: AuthorityStore, m: Manifest, sha: string, fault: TestFault = {}) {
  const loc = await locations(store)
  const proof = bytes({ version: 1, userId: store.userId, generation: m.generation, manifestSha256: sha })
  const history = join(loc.commits, `${sha}.json`)
  // Every publisher/recovery holds this uid's stable flock; never replace an observed proof.
  let present = true
  try { await lstat(history) } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; present = false }
  if (present) {
    if (!(await regular(history, 1024)).equals(proof)) throw unknown()
  } else {
    // A crash can only leave an unpublished temporary file, never a partial final seal.
    await atomicMetadata(loc.commits, `${sha}.json`, proof, fault)
  }
  await sync(history)
  await sync(loc.commits)
  await atomicMetadata(loc.state, 'sealed.json', proof)
  await sync(loc.state)
}
async function publish(store: AuthorityStore, stage: string, manifest: Manifest, fault: TestFault) {
  const loc = await locations(store)
  const raw = bytes(manifest)
  if (raw.length > 16777216) throw unknown()
  decodeManifest(raw, store.userId)
  await writeFile(join(stage, 'manifest.json'), raw, { flag: 'wx', mode: 0o444 })
  await sync(join(stage, 'manifest.json'))
  await chmod(stage, 0o755)
  for (const file of manifest.files) { await chmod(join(stage, file.path), 0o444); await sync(join(stage, file.path)) }
  await verifyTree(store, manifest, stage)
  for (const dir of ['data', 'receipts']) await sync(join(stage, dir))
  await sync(stage)
  await rename(stage, join(loc.generations, manifest.generation))
  await sync(loc.generations)
  crash(fault, 'generation-durable')
  await atomicMetadata(loc.state, 'current.json', raw)
  crash(fault, 'manifest-visible')
  await sync(loc.state)
  crash(fault, 'manifest-durable')
  await sealCurrent(store, manifest, hash(raw), fault)
  crash(fault, 'seal-durable')
}
async function stageDirectory(loc: Awaited<ReturnType<typeof locations>>, generation: string) {
  const stage = join(loc.staging, generation)
  await mkdir(stage, { mode: 0o700 })
  await mkdir(join(stage, 'data'), { mode: 0o755 })
  await mkdir(join(stage, 'receipts'), { mode: 0o755 })
  return stage
}
async function inventory(stage: string): Promise<FileEntry[]> {
  const names = ['data/user.md', ...(await readdir(join(stage, 'receipts'))).map(name => `receipts/${name}`)].sort()
  return Promise.all(names.map(async path => { const data = await regular(join(stage, path), path === 'data/user.md' ? 1048576 : 65536); return { path, size: data.length, sha256: hash(data) } }))
}
/** Host baseline only, never imports legacy receipt claims. Existing state cannot be replaced. */
export async function initializeAuthorityGeneration(store: AuthorityStore, profile: string, fault: TestFault = {}) {
  store = snapshotStore(store)
  if (typeof profile !== 'string' || Buffer.byteLength(profile) > 1048576) throw unknown()
  fault = { faultAfter: fault.faultAfter }
  const loc = identity(store)
  await directory(store.hostRoot, true)
  await createDirectory(loc.root, 0o700)
  const lock = await acquireKernelFileLock(loc.lock)
  try {
    await createDirectory(loc.state, 0o755)
    await createDirectory(loc.generations, 0o755)
    await createDirectory(loc.commits, 0o755)
    await createDirectory(loc.staging, 0o700)
    for (const name of ['current.json', 'sealed.json']) {
      try { await lstat(join(loc.state, name)); throw unknown() } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err }
    }
    if ((await readdir(loc.generations)).length || (await readdir(loc.staging)).length || (await readdir(loc.commits)).length) throw unknown()
    await sync(loc.state)
    await sync(loc.root)
    await sync(store.hostRoot)
    const generation = randomUUID()
    const stage = await stageDirectory(loc, generation)
    const result = await writeUserProfileAt(createAuthorityPaths(join(stage, 'data')), profile, profileSnapshot('').version)
    if (!result.ok) throw unknown()
    const manifest: Manifest = { version: 1, userId: store.userId, generation, parent: null, files: await inventory(stage) }
    await publish(store, stage, manifest, fault)
    return await readAuthorityGeneration(store)
  } finally { await lock.release() }
}
/** Caller must supply an approval-verified binding. No public API or executor currently calls this inert primitive. */
export async function publishProfileGeneration(store: AuthorityStore, input: { baseManifestSha256: string; expectedVersion: string; text: string; binding: SystemActionReceiptBinding }, fault: TestFault = {}): Promise<ProfileGenerationReceipt> {
  store = snapshotStore(store)
  input = { baseManifestSha256: input.baseManifestSha256, expectedVersion: input.expectedVersion, text: input.text, binding: binding(input.binding, store.userId) }
  fault = { faultAfter: fault.faultAfter }
  if (!SHA.test(input.baseManifestSha256) || !/^[a-f0-9]{16}$/.test(input.expectedVersion) || typeof input.text !== 'string' || Buffer.byteLength(input.text) > 1048576) throw unknown()
  const exact = input.binding
  const loc = await locations(store)
  const lock = await acquireKernelFileLock(loc.lock)
  try {
    const current = await readCurrent(store, true)
    const previous = await findProfileGenerationReceipt(store, exact)
    if (previous) return previous
    if (current.manifestSha256 !== input.baseManifestSha256) throw new Error('Authority generation conflict')
    const generation = randomUUID()
    const stage = await stageDirectory(loc, generation)
    for (const file of current.manifest.files) await writeFile(join(stage, file.path), await regular(join(current.root, file.path), file.size), { flag: 'wx', mode: 0o600 })
    const result = await writeUserProfileAt(createAuthorityPaths(join(stage, 'data')), input.text, input.expectedVersion)
    if (!result.ok) throw new Error('Profile generation CAS or content rejected')
    const receipt: ProfileGenerationReceipt = { binding: exact, generation, result: { version: result.version } }
    await writeFile(join(stage, 'receipts', `${exact.id}.json`), bytes(receipt), { flag: 'wx', mode: 0o600 })
    const manifest: Manifest = { version: 1, userId: store.userId, generation, parent: current.manifestSha256, files: await inventory(stage) }
    // Lock inode is stable, no age-based takeover. Recheck the captured base before activation.
    if ((await readCurrent(store, true)).manifestSha256 !== input.baseManifestSha256) throw new Error('Authority generation conflict')
    await publish(store, stage, manifest, fault)
    return decodeReceipt(bytes(receipt), store.userId, exact.id)
  } finally { await lock.release() }
}
/** Recovery needs a trusted host authorization for the exact pending generation; it never chooses an orphan or reapplies data. */
export async function recoverProfileGeneration(store: AuthorityStore, permit: { manifestSha256: string; parentManifestSha256: string; binding: SystemActionReceiptBinding; profileSha256: string }) {
  store = snapshotStore(store)
  permit = { manifestSha256: permit.manifestSha256, parentManifestSha256: permit.parentManifestSha256, binding: binding(permit.binding, store.userId), profileSha256: permit.profileSha256 }
  if (![permit.manifestSha256, permit.parentManifestSha256, permit.profileSha256].every(v => SHA.test(v))) throw unknown()
  const loc = await locations(store)
  const lock = await acquireKernelFileLock(loc.lock)
  try {
    const current = await readCurrent(store, false)
    const exact = permit.binding
    if (current.manifestSha256 !== permit.manifestSha256 || current.manifest.parent !== permit.parentManifestSha256) throw unknown()
    const proofRaw = await regular(join(loc.commits, `${permit.parentManifestSha256}.json`), 1024)
    const proof = JSON.parse(proofRaw.toString('utf8')) as { generation: string }
    if (!UUID.test(proof.generation) || !proofRaw.equals(bytes({ version: 1, userId: store.userId, generation: proof.generation, manifestSha256: permit.parentManifestSha256 }))) throw unknown()
    const parentRaw = await regular(join(loc.generations, proof.generation, 'manifest.json'), 16777216)
    if (hash(parentRaw) !== permit.parentManifestSha256) throw unknown()
    const parentManifest = decodeManifest(parentRaw, store.userId)
    const parentRoot = await verifyTree(store, parentManifest)
    const inherited = current.manifest.files.filter(f => f.path.startsWith('receipts/') && f.path !== `receipts/${exact.id}.json`)
    const prior = parentManifest.files.filter(f => f.path.startsWith('receipts/'))
    if (!bytes(inherited).equals(bytes(prior)) || prior.some(f => f.path === `receipts/${exact.id}.json`)) throw unknown()
    const receipt = decodeReceipt(await regular(join(current.root, 'receipts', `${exact.id}.json`), 65536), store.userId, exact.id)
    const profile = await regular(join(current.root, 'data/user.md'), 1048576)
    if (!bytes(receipt.binding).equals(bytes(exact)) || receipt.generation !== current.manifest.generation || hash(profile) !== permit.profileSha256 || profileSnapshot(profile.toString('utf8')).version !== receipt.result.version) throw unknown()
    // Validate all ancestors by exact inventory; no receipt is inherited from a mutable legacy root.
    await directory(parentRoot)
    for (const file of current.manifest.files) await sync(join(current.root, file.path))
    for (const dir of ['data', 'receipts']) await sync(join(current.root, dir))
    await sync(join(current.root, 'manifest.json'))
    await sync(current.root)
    await sync(loc.generations)
    await sync(join(loc.state, 'current.json'))
    await sync(loc.state)
    await sealCurrent(store, current.manifest, current.manifestSha256)
    return receipt
  } finally { await lock.release() }
}

/** Initial baseline has no business receipt. Only an independently authorized exact baseline permit can recover it. */
export async function recoverBaselineAuthorityGeneration(store: AuthorityStore, permit: { manifestSha256: string; profileSha256: string }) {
  store = snapshotStore(store)
  permit = { manifestSha256: permit.manifestSha256, profileSha256: permit.profileSha256 }
  if (![permit.manifestSha256, permit.profileSha256].every(v => SHA.test(v))) throw unknown()
  const loc = await locations(store)
  const lock = await acquireKernelFileLock(loc.lock)
  try {
    const current = await readCurrent(store, false)
    if (current.manifestSha256 !== permit.manifestSha256 || current.manifest.parent !== null || current.manifest.files.length !== 1 || current.manifest.files[0]?.path !== 'data/user.md') throw unknown()
    const history = await readdir(loc.commits)
    if (history.some(name => name !== `${current.manifestSha256}.json` && !/^\.[0-9a-f]{64}\.json-[0-9a-f-]{36}$/.test(name)) || JSON.stringify(await readdir(loc.generations)) !== JSON.stringify([current.manifest.generation])) throw unknown()
    const profile = await regular(join(current.root, 'data/user.md'), 1048576)
    if (hash(profile) !== permit.profileSha256) throw unknown()
    await sync(join(current.root, 'data/user.md'))
    await sync(join(current.root, 'manifest.json'))
    for (const dir of ['data', 'receipts']) await sync(join(current.root, dir))
    await sync(join(current.root, 'manifest.json'))
    await sync(current.root)
    await sync(loc.generations)
    await sync(join(loc.state, 'current.json'))
    await sync(loc.state)
    await sync(loc.root)
    await sync(store.hostRoot)
    await sealCurrent(store, current.manifest, current.manifestSha256)
    return await readAuthorityGeneration(store)
  } finally { await lock.release() }
}
