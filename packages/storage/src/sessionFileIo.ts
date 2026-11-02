/** Serialized transcript IO. Existing data inodes are never replaced: cwd
 * relocation can give a native session several hard-link names. */
import { constants } from 'node:fs'
import { open, mkdir, lstat, realpath, rename, unlink, readdir } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'

export class SessionFileIntegrityError extends Error {
  constructor(readonly code: string) {
    super(code.includes('RESTORE') || code.includes('CORRUPT') || code.includes('ALIAS')
      ? '系统暂时无法完整恢复这段对话的历史资料。你的消息和原始文件均已保留，请稍后直接重试。'
      : '对话记录暂时未能完整保存，系统已保留你的消息和原始资料，请稍后直接重试。')
    this.name = 'SessionFileIntegrityError'
  }
}
export interface SessionFileScope {
  projectsDir: string
  sessionId: string
  /** Main and each subagent have separate artifacts; cwd aliases share this. */
  artifactId?: string
  requireKernelLock?: boolean
}
export type SessionReadHandle = Pick<FileHandle, 'stat' | 'read'>
export interface SessionFileRestoreReceipt {
  schema: 1
  sourceSha256: string
  targetSha256: string
  archiveSha256: string
  sourceBytes: number
  targetBytes: number
  verifiedReadCount: number
  fragmentCount: number
  fragmentManifestSha256: string
}
interface Lease {
  file: FileHandle; dir: string; dev: number; ino: number; active: boolean
  pending: Promise<void> | null
  failure?: unknown
}
/** An opaque, process-local capability. It is valid only inside its actual
 * withSessionFile mutation; a JSON claim or user-provided assert is insufficient. */
export interface SessionFileLeaseCapability { readonly sessionFileLease: unique symbol }
export interface SessionFileLeaseIdentity {
  readonly projectsDir: string
  readonly sessionId: string
  readonly filePath: string
  readonly stagingDirectory: string
}
const leaseCapabilities = new WeakMap<object, { lease: Lease; key: string; identity: SessionFileLeaseIdentity }>()
export function assertSessionFileLease(capability: SessionFileLeaseCapability): SessionFileLeaseIdentity {
  const value = capability && typeof capability === 'object' ? leaseCapabilities.get(capability) : undefined
  check(value?.lease.active && owned.getStore()?.get(value.key) === value.lease, 'CCB_TRANSCRIPT_LEASE_INVALID')
  if (value!.lease.failure) throw value!.lease.failure
  return value!.identity
}
/** Checks a trusted cwd alias against the inode already locked by this lease. */
export async function assertSessionFileAlias(capability: SessionFileLeaseCapability, path: string): Promise<void> {
  const identity = assertSessionFileLease(capability)
  const rel = relative(identity.projectsDir, path)
  check(path === resolve(path) && rel && !rel.startsWith('..') && !isAbsolute(rel), 'CCB_TRANSCRIPT_PATH_INVALID')
  let parent = identity.projectsDir
  for (const part of rel.split('/').slice(0, -1)) {
    parent = join(parent, part)
    const stat = await lstat(parent)
    check(stat.isDirectory() && !stat.isSymbolicLink(), 'CCB_TRANSCRIPT_PATH_INVALID')
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    const named = await lstat(path)
    assertSessionFileLease(capability)
    const lease = leaseCapabilities.get(capability)!.lease
    check(stat.isFile() && stat.dev === lease.dev && stat.ino === lease.ino && stat.nlink > 0 && !named.isSymbolicLink() && named.dev === stat.dev && named.ino === stat.ino, 'CCB_TRANSCRIPT_ALIAS_DIVERGED')
  } finally { await file.close() }
}
export type SessionFileDependency = (capability: SessionFileLeaseCapability) => Promise<void>
export type SessionFilePatch = (offset: number, target: Buffer, beforePatch?: SessionFileDependency) => Promise<void>
interface Intent {
  schema: 1
  dev: number
  ino: number
  offset: number
  sourceBytes: number
  sourceSha256: string
  targetBytes: number
  targetSha256: string
}
const queues = new Map<string, Promise<unknown>>()
const owned = new AsyncLocalStorage<Map<string, Lease>>()
const sha = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex')
const fail = (code: string): never => { throw new SessionFileIntegrityError(code) }
const check = (yes: unknown, code: string): void => { if (!yes) fail(code) }
const isMissing = (e: unknown): boolean => !!e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT'
const digestPattern = /^[a-f0-9]{64}$/

async function privateDirectory(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); await syncDirectory(dirname(path)) } catch (e) { if (!(e && typeof e === 'object' && 'code' in e && e.code === 'EEXIST')) throw e }
  const s = await lstat(path)
  check(s.isDirectory() && !s.isSymbolicLink() && s.uid === process.getuid?.() && (s.mode & 0o777) === 0o700, 'CCB_TRANSCRIPT_PRIVATE_DIRECTORY')
}
async function syncDirectory(path: string): Promise<void> {
  const f = await open(path, constants.O_RDONLY)
  try { await f.sync() } finally { await f.close() }
}
async function privateRead(path: string): Promise<Buffer> {
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const s = await f.stat()
    check(s.isFile() && s.nlink === 1 && s.uid === process.getuid?.() && (s.mode & 0o777) === 0o600, 'CCB_TRANSCRIPT_PRIVATE_FILE')
    return await f.readFile()
  } finally { await f.close() }
}
async function writeAll(f: FileHandle, bytes: Buffer, position: number): Promise<void> {
  let offset = 0
  while (offset < bytes.length) {
    const { bytesWritten } = await f.write(bytes, offset, Math.min(65536, bytes.length - offset), position + offset)
    check(bytesWritten > 0, 'CCB_TRANSCRIPT_SHORT_WRITE')
    offset += bytesWritten
  }
}
async function readRange(f: SessionReadHandle, start: number, length: number): Promise<Buffer> {
  const bytes = Buffer.alloc(length)
  let offset = 0
  while (offset < length) {
    const { bytesRead } = await f.read(bytes, offset, Math.min(65536, length - offset), start + offset)
    check(bytesRead > 0, 'CCB_TRANSCRIPT_SHORT_READ')
    offset += bytesRead
  }
  return bytes
}
async function writePrivate(path: string, bytes: Buffer): Promise<void> {
  const tmp = join(dirname(path), `.stage-${randomUUID()}`)
  const f = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await writeAll(f, bytes, 0); await f.sync() } finally { await f.close() }
  await rename(tmp, path)
  await syncDirectory(dirname(path))
}
async function storeBlob(dir: string, bytes: Buffer, role: 'source' | 'target'): Promise<string> {
  const digest = sha(bytes)
  const path = join(dir, `${role}-${digest}.blob`)
  try { check((await privateRead(path)).equals(bytes), 'CCB_TRANSCRIPT_BACKUP_CONFLICT') }
  catch (e) { if (!isMissing(e)) throw e; await writePrivate(path, bytes) }
  return digest
}
async function lockFd(f: FileHandle, strict: boolean): Promise<void> {
  check(process.platform === 'linux', 'CCB_TRANSCRIPT_KERNEL_LOCK_UNAVAILABLE')
  void strict // This managed V5 primitive never falls back to a PID/TTL lock.
  // The inherited FD shares the parent's open-file-description. flock's
  // acquire child exits; the parent FD continues to own the kernel lock.
  await new Promise<void>((accept, reject) => {
    const child = spawn('/usr/bin/flock', ['-x', '3'], { stdio: ['ignore', 'ignore', 'ignore', f.fd], env: { LC_ALL: 'C' } })
    child.once('error', () => reject(new SessionFileIntegrityError('CCB_TRANSCRIPT_KERNEL_LOCK_UNAVAILABLE')))
    child.once('exit', code => code === 0 ? accept() : reject(new SessionFileIntegrityError('CCB_TRANSCRIPT_KERNEL_LOCK_UNAVAILABLE')))
  })
}
function parseIntent(bytes: Buffer): Intent {
  let v: unknown
  try { v = JSON.parse(bytes.toString('utf8')) } catch { return fail('CCB_TRANSCRIPT_INTENT_INVALID') }
  check(v && typeof v === 'object' && !Array.isArray(v), 'CCB_TRANSCRIPT_INTENT_INVALID')
  const x = v as Record<string, unknown>
  check(Object.keys(x).sort().join(',') === 'dev,ino,offset,schema,sourceBytes,sourceSha256,targetBytes,targetSha256', 'CCB_TRANSCRIPT_INTENT_INVALID')
  check(x.schema === 1 && ['dev', 'ino', 'offset', 'sourceBytes', 'targetBytes'].every(k => Number.isSafeInteger(x[k]) && Number(x[k]) >= 0), 'CCB_TRANSCRIPT_INTENT_INVALID')
  check(typeof x.sourceSha256 === 'string' && digestPattern.test(x.sourceSha256) && typeof x.targetSha256 === 'string' && digestPattern.test(x.targetSha256), 'CCB_TRANSCRIPT_INTENT_INVALID')
  return x as unknown as Intent
}
async function bindArtifactIdentity(lease: Lease): Promise<void> {
  const path = join(lease.dir, 'artifact.json')
  let bytes: Buffer
  try { bytes = await privateRead(path) }
  catch (error) {
    if (!isMissing(error)) throw error
    await writePrivate(path, Buffer.from(JSON.stringify({ schema: 1, dev: lease.dev, ino: lease.ino })))
    return
  }
  let value: unknown
  try { value = JSON.parse(bytes.toString('utf8')) } catch { return fail('CCB_TRANSCRIPT_ARTIFACT_INVALID') }
  check(value && typeof value === 'object' && !Array.isArray(value), 'CCB_TRANSCRIPT_ARTIFACT_INVALID')
  const identity = value as Record<string, unknown>
  check(Object.keys(identity).sort().join(',') === 'dev,ino,schema' && identity.schema === 1,
    'CCB_TRANSCRIPT_ARTIFACT_INVALID')
  check(identity.dev === lease.dev && identity.ino === lease.ino, 'CCB_TRANSCRIPT_ALIAS_DIVERGED')
}
async function retainOriginalBackup(lease: Lease, x: Intent): Promise<void> {
  if (x.offset !== 0 || x.sourceBytes === 0) return
  const path = join(lease.dir, 'original-backup.json')
  try { await privateRead(path) }
  catch (error) {
    if (!isMissing(error)) throw error
    await writePrivate(path, Buffer.from(JSON.stringify({ schema: 1, bytes: x.sourceBytes, sha256: x.sourceSha256 })))
  }
}
async function pruneCommittedSourceStaging(lease: Lease, currentSha: string): Promise<void> {
  const keep = new Set([currentSha])
  try {
    const value = JSON.parse((await privateRead(join(lease.dir, 'original-backup.json'))).toString('utf8')) as Record<string, unknown>
    check(value.schema === 1 && typeof value.sha256 === 'string' && digestPattern.test(value.sha256)
      && Number.isSafeInteger(value.bytes) && Number(value.bytes) > 0, 'CCB_TRANSCRIPT_BACKUP_INVALID')
    keep.add(value.sha256 as string)
  } catch (error) { if (!isMissing(error)) return }
  try {
    const receipt = JSON.parse((await privateRead(join(lease.dir, 'restore-receipt.json'))).toString('utf8')) as Record<string, unknown>
    check(typeof receipt.sourceSha256 === 'string' && digestPattern.test(receipt.sourceSha256), 'CCB_TRANSCRIPT_RECEIPT_INVALID')
    keep.add(receipt.sourceSha256 as string)
  } catch (error) { if (!isMissing(error)) return }
  for (const name of await readdir(lease.dir)) {
    const match = /^source-([a-f0-9]{64})\.blob$/.exec(name)
    if (!match || keep.has(match[1]!)) continue
    // Only superseded, committed transaction backups. The first original
    // and this transaction's source remain; uncommitted .stage files stay.
    await privateRead(join(lease.dir, name))
    await unlink(join(lease.dir, name))
  }
  await syncDirectory(lease.dir)
}
async function completeIntent(lease: Lease): Promise<void> {
  let bytes: Buffer
  try { bytes = await privateRead(join(lease.dir, 'intent.json')) } catch (e) { if (isMissing(e)) return; throw e }
  const x = parseIntent(bytes)
  const s = await lease.file.stat()
  check(s.dev === x.dev && s.ino === x.ino && s.nlink > 0 && s.size >= x.offset, 'CCB_TRANSCRIPT_ALIAS_DIVERGED')
  const source = await privateRead(join(lease.dir, `source-${x.sourceSha256}.blob`))
  const target = await privateRead(join(lease.dir, `target-${x.targetSha256}.blob`))
  check(source.length === x.sourceBytes && sha(source) === x.sourceSha256 && target.length === x.targetBytes && sha(target) === x.targetSha256, 'CCB_TRANSCRIPT_STAGE_INVALID')
  check(s.size - x.offset <= Math.max(source.length, target.length), 'CCB_TRANSCRIPT_UNTRACKED_WRITE')
  const current = await readRange(lease.file, x.offset, s.size - x.offset)
  // Before mutation the original tail is intact; after truncate/write the
  // tail can only be an exact prefix of the fsynced target. No guessing.
  check(current.equals(source) || (current.length <= target.length && current.equals(target.subarray(0, current.length))), 'CCB_TRANSCRIPT_UNTRACKED_WRITE')
  await lease.file.truncate(x.offset)
  await writeAll(lease.file, target, x.offset)
  await lease.file.sync()
  const final = await lease.file.stat()
  check(final.dev === x.dev && final.ino === x.ino && final.nlink > 0 && final.size === x.offset + target.length, 'CCB_TRANSCRIPT_ALIAS_DIVERGED')
  check((await readRange(lease.file, x.offset, target.length)).equals(target), 'CCB_TRANSCRIPT_COMMIT_MISMATCH')
  await writePrivate(join(lease.dir, 'committed.json'), Buffer.from(JSON.stringify(x)))
  await unlink(join(lease.dir, 'intent.json'))
  await syncDirectory(lease.dir)
  // Committed data and the original backup are durable; this is only the
  // transaction's temporary target, not a user's original file.
  try {
    await unlink(join(lease.dir, `target-${x.targetSha256}.blob`))
    await syncDirectory(lease.dir)
    await pruneCommittedSourceStaging(lease, x.sourceSha256)
  } catch { /* Staging cleanup cannot turn a durable commit into a failure. */ }
}
function useLeaseMutation(lease: Lease, apply: () => Promise<void>): Promise<void> {
  check(lease.active, 'CCB_TRANSCRIPT_LEASE_ENDED')
  if (lease.pending) {
    const error = new SessionFileIntegrityError('CCB_TRANSCRIPT_CONCURRENT_MUTATION')
    lease.failure ??= error
    const rejected = Promise.reject<void>(error)
    void rejected.catch(() => {})
    return rejected
  }
  // Register ownership before invoking a dependency that can synchronously reenter.
  const pending = Promise.resolve().then(apply)
  lease.pending = pending
  const clear = () => { if (lease.pending === pending) lease.pending = null }
  void pending.then(clear, error => { lease.failure ??= error; clear() })
  return pending
}
async function saveRestoreReceipt(lease: Lease, receipt: SessionFileRestoreReceipt): Promise<void> {
  check(lease.active && receipt.schema === 1, 'CCB_TRANSCRIPT_RECEIPT_INVALID')
  check(Object.keys(receipt).sort().join(',') === 'archiveSha256,fragmentCount,fragmentManifestSha256,schema,sourceBytes,sourceSha256,targetBytes,targetSha256,verifiedReadCount', 'CCB_TRANSCRIPT_RECEIPT_INVALID')
  check([receipt.sourceSha256, receipt.targetSha256, receipt.archiveSha256, receipt.fragmentManifestSha256].every(value => typeof value === 'string' && digestPattern.test(value)), 'CCB_TRANSCRIPT_RECEIPT_INVALID')
  check([receipt.sourceBytes, receipt.targetBytes, receipt.verifiedReadCount, receipt.fragmentCount].every(value => Number.isSafeInteger(value) && value > 0), 'CCB_TRANSCRIPT_RECEIPT_INVALID')
  const source = await privateRead(join(lease.dir, `source-${receipt.sourceSha256}.blob`))
  check(source.length === receipt.sourceBytes && sha(source) === receipt.sourceSha256, 'CCB_TRANSCRIPT_RECEIPT_INVALID')
  const stats = await lease.file.stat()
  check(stats.dev === lease.dev && stats.ino === lease.ino && stats.size === receipt.targetBytes, 'CCB_TRANSCRIPT_RECEIPT_INVALID')
  check(sha(await readRange(lease.file, 0, stats.size)) === receipt.targetSha256, 'CCB_TRANSCRIPT_RECEIPT_INVALID')
  await writePrivate(join(lease.dir, 'restore-receipt.json'), Buffer.from(JSON.stringify(receipt)))
}
async function checkedPath(filePath: string, scope: SessionFileScope): Promise<{ path: string; root: string; key: string }> {
  check(typeof scope.sessionId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(scope.sessionId), 'CCB_TRANSCRIPT_SCOPE_INVALID')
  const requestedRoot = resolve(scope.projectsDir)
  const requestedFile = resolve(filePath)
  const rel = relative(requestedRoot, requestedFile)
  check(rel && !rel.startsWith('..') && !isAbsolute(rel), 'CCB_TRANSCRIPT_PATH_INVALID')
  await mkdir(requestedRoot, { recursive: true, mode: 0o700 })
  const root = await realpath(requestedRoot)
  const parts = rel.split(/[\\/]/)
  check(!parts.includes('.oc-transcript-integrity'), 'CCB_TRANSCRIPT_PATH_INVALID')
  let parent = root
  for (const part of parts.slice(0, -1)) {
    check(part && part !== '.' && part !== '..', 'CCB_TRANSCRIPT_PATH_INVALID')
    parent = join(parent, part)
    try { await mkdir(parent, { mode: 0o700 }) } catch (e) { if (!(e && typeof e === 'object' && 'code' in e && e.code === 'EEXIST')) throw e }
    const s = await lstat(parent)
    check(s.isDirectory() && !s.isSymbolicLink() && s.uid === process.getuid?.(), 'CCB_TRANSCRIPT_PATH_INVALID')
  }
  const artifact = scope.artifactId ?? (parts.includes('subagents') ? basename(requestedFile) : 'main')
  check(/^[A-Za-z0-9_.-]{1,160}$/.test(artifact), 'CCB_TRANSCRIPT_SCOPE_INVALID')
  return { path: join(parent, parts[parts.length - 1]!), root, key: sha(`${root}\n${scope.sessionId}\n${artifact}`) }
}
export interface SessionFileReadRequest {
  readonly filePath: string
  readonly scope: SessionFileScope
}
export interface SessionFileGroupReadEntry {
  readonly filePath: string
  readonly file: SessionReadHandle
}
interface SessionFileRequest extends SessionFileReadRequest { readonly create: boolean; readonly queueKey: string; readonly durableRead: boolean }
interface OpenedSessionFile {
  request: SessionFileRequest
  path: Awaited<ReturnType<typeof checkedPath>>
  lock: FileHandle
  metadataInode: string
  file?: FileHandle
  dataInode?: string
  lease?: Lease
}
const physicalOrder = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0
function sessionQueueKey(filePath: string, scope: SessionFileScope): string {
  const rootHint = resolve(scope.projectsDir)
  const relativeHint = relative(rootHint, resolve(filePath))
  const artifactHint = scope.artifactId ?? (relativeHint.split(/[\\/]/).includes('subagents') ? basename(filePath) : 'main')
  return sha(`${rootHint}\n${scope.sessionId}\n${artifactHint}`)
}
async function closeSessionFiles(entries: readonly OpenedSessionFile[]): Promise<void> {
  const failures: unknown[] = []
  for (const entry of entries) if (entry.lease) entry.lease.active = false
  for (const entry of entries) if (entry.lease?.pending) await entry.lease.pending.catch(() => {})
  // Release all data locks before metadata locks. A failed close must not leak
  // the rest of the group; no further acquisition occurs during cleanup.
  for (const entry of [...entries].reverse()) {
    try { if (entry.file) await entry.file.close() } catch (error) { failures.push(error) }
  }
  for (const entry of [...entries].reverse()) {
    try { await entry.lock.close() } catch (error) { failures.push(error) }
  }
  if (failures.length) throw failures[0]
}
async function acquireSessionFiles(requests: readonly SessionFileRequest[]): Promise<OpenedSessionFile[]> {
  const entries: OpenedSessionFile[] = []
  try {
    // Every caller, including a single-file mutation, uses the same global
    // metadata -> data lock hierarchy. Physical identities include bind aliases.
    for (const request of requests) {
      const path = await checkedPath(request.filePath, request.scope)
      const root = join(path.root, '.oc-transcript-integrity')
      await privateDirectory(root)
      const dir = join(root, path.key)
      await privateDirectory(dir)
      const lock = await open(join(dir, 'lock'), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
      // Track the FD before any validation/stat can throw.
      const entry: OpenedSessionFile = { request, path, lock, metadataInode: '' }
      entries.push(entry)
      const stat = await lock.stat({ bigint: true })
      check(stat.isFile() && stat.nlink === 1n && stat.uid === BigInt(process.getuid?.() ?? -1) && (stat.mode & 0o777n) === 0o600n, 'CCB_TRANSCRIPT_PRIVATE_FILE')
      entry.metadataInode = `${stat.dev}:${stat.ino}`
    }
    const metadata = [...entries].sort((a, b) => physicalOrder(a.metadataInode, b.metadataInode))
    const metadataIds = new Set(metadata.map(entry => entry.metadataInode))
    check(metadataIds.size === entries.length, 'CCB_TRANSCRIPT_DUPLICATE_INODE')
    for (const entry of metadata) await lockFd(entry.lock, entry.request.scope.requireKernelLock ?? false)
    // Open and identify the entire data set before locking any data inode.
    // A duplicate detected after flock would deadlock on its own independent FD.
    const dataIds = new Set<string>()
    for (const entry of entries) {
      const { path, request } = entry
      const dir = join(path.root, '.oc-transcript-integrity', path.key)
      if (request.create) {
        let exists = true
        try { await lstat(path.path) } catch (error) { if (!isMissing(error)) throw error; exists = false }
        if (!exists) {
          try { await privateRead(join(dir, 'artifact.json')); fail('CCB_TRANSCRIPT_ALIAS_DIVERGED') }
          catch (error) { if (!isMissing(error)) throw error }
        }
        try {
          entry.file = await open(path.path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_CREAT | constants.O_EXCL, 0o600)
          await entry.file.sync(); await syncDirectory(dirname(path.path))
        } catch (error) {
          if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error
          entry.file = await open(path.path, constants.O_RDWR | constants.O_NOFOLLOW)
        }
      } else entry.file = await open(path.path, constants.O_RDWR | constants.O_NOFOLLOW)
      const stat = await entry.file.stat({ bigint: true })
      check(stat.isFile() && stat.nlink > 0n && stat.uid === BigInt(process.getuid?.() ?? -1), 'CCB_TRANSCRIPT_PATH_INVALID')
      entry.dataInode = `${stat.dev}:${stat.ino}`
      check(!dataIds.has(entry.dataInode) && !metadataIds.has(entry.dataInode), 'CCB_TRANSCRIPT_DUPLICATE_INODE')
      dataIds.add(entry.dataInode)
    }
    const data = [...entries].sort((a, b) => physicalOrder(a.dataInode!, b.dataInode!))
    for (const entry of data) await lockFd(entry.file!, entry.request.scope.requireKernelLock ?? false)
    for (const entry of entries) {
      const stat = await entry.file!.stat()
      const alias = await lstat(entry.path.path)
      check(!alias.isSymbolicLink() && alias.dev === stat.dev && alias.ino === stat.ino && stat.nlink > 0, 'CCB_TRANSCRIPT_ALIAS_DIVERGED')
      entry.lease = { file: entry.file!, dir: join(entry.path.root, '.oc-transcript-integrity', entry.path.key), dev: stat.dev, ino: stat.ino, active: false, pending: null }
      await bindArtifactIdentity(entry.lease)
      await completeIntent(entry.lease)
      // The group readback may be used as a durable Writer commit boundary.
      if (entry.request.durableRead) await entry.file!.sync()
    }
    for (const entry of entries) entry.lease!.active = true
    return entries
  } catch (error) {
    await closeSessionFiles(entries).catch(() => {})
    throw error
  }
}
async function runSessionFiles<T>(input: readonly (SessionFileReadRequest & { create: boolean; durableRead?: boolean })[], use: (entries: readonly OpenedSessionFile[]) => Promise<T>): Promise<T> {
  check(input.length > 0 && input.length <= 10001, 'CCB_TRANSCRIPT_GROUP_INVALID')
  check(![...(owned.getStore()?.values() ?? [])].some(lease => lease.active), 'CCB_TRANSCRIPT_NESTED_IO')
  const requests = input.map(request => {
    const scope = Object.freeze({ ...request.scope })
    return Object.freeze({ filePath: request.filePath, scope, create: request.create, queueKey: sessionQueueKey(request.filePath, scope), durableRead: request.durableRead ?? false })
  })
  check(requests.every(request => request.scope.sessionId === requests[0]!.scope.sessionId && resolve(request.scope.projectsDir) === resolve(requests[0]!.scope.projectsDir)), 'CCB_TRANSCRIPT_GROUP_SCOPE_INVALID')
  const keys = requests.map(request => request.queueKey)
  check(new Set(keys).size === keys.length, 'CCB_TRANSCRIPT_GROUP_DUPLICATE_TARGET')
  // Atomic queue reservation: gather ALL predecessors before replacing ANY
  // queue entry, without awaiting path IO or acquiring a partial lock set.
  const previous = keys.map(key => queues.get(key) ?? Promise.resolve())
  const next = Promise.allSettled(previous).then(async () => {
    const entries = await acquireSessionFiles(requests)
    const context = new Map(entries.map(entry => [entry.request.queueKey, entry.lease!]))
    let outcome: { result: T } | { error: unknown }
    try {
      const result = await owned.run(context, () => use(entries))
      for (const entry of entries) {
        if (entry.lease!.pending) await entry.lease!.pending
        if (entry.lease!.failure) throw entry.lease!.failure
      }
      outcome = { result }
    } catch (error) { outcome = { error } }
    try { await closeSessionFiles(entries) } catch (error) { if (!('error' in outcome)) outcome = { error } }
    if ('error' in outcome) throw outcome.error
    return outcome.result
  })
  for (const key of keys) queues.set(key, next)
  try { return await next } finally { for (const key of keys) if (queues.get(key) === next) queues.delete(key) }
}
export async function withSessionFile<T>(filePath: string, scope: SessionFileScope, create: boolean, use: (file: SessionReadHandle, patch: SessionFilePatch, receipt: (value: SessionFileRestoreReceipt) => Promise<void>) => Promise<T>): Promise<T> {
  return runSessionFiles([{ filePath, scope, create }], async entries => {
    const entry = entries[0]!
    const lease = entry.lease!
    const capability = Object.freeze({}) as SessionFileLeaseCapability
    leaseCapabilities.set(capability, { lease, key: entry.request.queueKey, identity: Object.freeze({ projectsDir: entry.path.root, sessionId: entry.request.scope.sessionId, filePath: entry.path.path, stagingDirectory: join(lease.dir, 'artifact-staging') }) })
    return use(entry.file!, (offset, target, beforePatch) => useLeaseMutation(lease, async () => {
      if (beforePatch) { await beforePatch(capability); assertSessionFileLease(capability) }
      await patchTail(lease, offset, target)
    }), value => useLeaseMutation(lease, () => saveRestoreReceipt(lease, value)))
  })
}
/** Holds every existing target through the awaited commit callback. This is a
 * read-only capability: it exposes neither FD, patch nor a public lease handle. */
export async function withSessionFileGroupRead<T>(requests: readonly SessionFileReadRequest[], use: (files: readonly SessionFileGroupReadEntry[]) => Promise<T>): Promise<T> {
  return runSessionFiles(requests.map(request => ({ ...request, create: false, durableRead: true })), async entries => use(Object.freeze(entries.map(entry => Object.freeze({ filePath: entry.request.filePath, file: Object.freeze({ stat: entry.file!.stat.bind(entry.file!), read: entry.file!.read.bind(entry.file!) }) })))))
}
async function patchTail(lease: Lease, offset: number, target: Buffer): Promise<void> {
  check(lease.active, 'CCB_TRANSCRIPT_LEASE_ENDED')
  const s = await lease.file.stat()
  check(Number.isSafeInteger(offset) && offset >= 0 && offset <= s.size && s.dev === lease.dev && s.ino === lease.ino && s.nlink > 0, 'CCB_TRANSCRIPT_PATCH_INVALID')
  const source = await readRange(lease.file, offset, s.size - offset)
  const sourceSha256 = await storeBlob(lease.dir, source, 'source')
  const targetSha256 = await storeBlob(lease.dir, target, 'target')
  const intent: Intent = { schema: 1, dev: s.dev, ino: s.ino, offset, sourceBytes: source.length, sourceSha256, targetBytes: target.length, targetSha256 }
  await retainOriginalBackup(lease, intent)
  await writePrivate(join(lease.dir, 'intent.json'), Buffer.from(JSON.stringify(intent)))
  await completeIntent(lease)
}
export async function appendSessionFile(filePath: string, text: string, scope: SessionFileScope): Promise<void> {
  await withSessionFile(filePath, scope, true, async (file, patch) => { await patch((await file.stat()).size, Buffer.from(text)) })
}
export async function replaceSessionFile(filePath: string, bytes: Buffer, scope: SessionFileScope): Promise<void> {
  await withSessionFile(filePath, scope, true, async (_file, patch) => { await patch(0, bytes) })
}
export async function readSessionFile(filePath: string, scope: SessionFileScope): Promise<Buffer> {
  return withSessionFile(filePath, scope, false, async file => readRange(file, 0, (await file.stat()).size))
}
export async function flushSessionFileIo(): Promise<void> {
  check(![...(owned.getStore()?.values() ?? [])].some(lease => lease.active), 'CCB_TRANSCRIPT_NESTED_FLUSH')
  let failure: unknown
  while (queues.size) {
    const settled = await Promise.allSettled([...queues.values()])
    for (const result of settled) if (result.status === 'rejected') failure ??= result.reason
  }
  if (failure) throw failure
}
