/** Candidate files only. This is NOT a delivery owner, result store or ACK. */
import { createHash, randomBytes } from 'node:crypto'
import { constants, openSync, closeSync, fstatSync, mkdirSync, readSync, writeSync,
  fsyncSync, renameSync, unlinkSync, readdirSync, lstatSync, rmdirSync } from 'node:fs'
import { isAbsolute, join, dirname } from 'node:path'
import { withReceiptWriteBarrier } from './receiptWriteBarrier.js'

export interface ReceiptCandidateScope {
  partition: string; userId: string; agentId: string; sessionKey: string
  owner: Record<string, unknown>; clientSessionId?: string
}
export interface ReceiptCandidateDeletionRef { userId: string; clientSessionId: string }
export type ReceiptCandidateManifest = { v: 1; partition: string; state: 'retired'; deletionRef?: ReceiptCandidateDeletionRef } |
  { v: 1; partition: string; state: 'active'; scope: ReceiptCandidateScope }
const HASH = /^[a-f0-9]{64}$/
const MAX_MANIFEST = 16384
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT'
function checkedHash(value: string): string {
  if (!HASH.test(value)) throw new Error('invalid receipt candidate key')
  return value
}
export function receiptReportId(toolUseId: string): string {
  if (!toolUseId || toolUseId.length > 256) throw new Error('invalid receipt report consumer')
  return createHash('sha256').update('receipt-report-v1\0').update(toolUseId).digest('hex')
}
function privateDirectory(path: string): number {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  const stat = fstatSync(fd)
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) {
    closeSync(fd); throw new Error('receipt candidate directory must be private and owned')
  }
  return fd
}
function childDirectory(parent: number, name: string, create: boolean): number {
  const path = `/proc/self/fd/${parent}/${name}`
  if (create) {
    try { mkdirSync(path, { mode: 0o700 }) }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e }
    fsyncSync(parent)
  }
  return privateDirectory(path)
}
function readRecord(directory: number, key: string): unknown {
  let fd: number
  try { fd = openSync(`/proc/self/fd/${directory}/${key}.json`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
  catch (e) { if (missing(e)) return undefined; throw e }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > MAX_MANIFEST) throw new Error('invalid receipt candidate manifest')
    const bytes = Buffer.alloc(MAX_MANIFEST + 1)
    const size = readSync(fd, bytes, 0, bytes.length, 0)
    if (size > MAX_MANIFEST) throw new Error('oversized receipt candidate manifest')
    return JSON.parse(bytes.subarray(0, size).toString()) as unknown
  } finally { closeSync(fd) }
}
function validRef(ref: unknown): ref is ReceiptCandidateDeletionRef {
  return !!ref && typeof ref === 'object' && !Array.isArray(ref) &&
    typeof (ref as ReceiptCandidateDeletionRef).userId === 'string' && !!(ref as ReceiptCandidateDeletionRef).userId &&
    typeof (ref as ReceiptCandidateDeletionRef).clientSessionId === 'string' && !!(ref as ReceiptCandidateDeletionRef).clientSessionId
}
export function receiptCandidateDeletionRef(scope: ReceiptCandidateScope): ReceiptCandidateDeletionRef | undefined {
  if (scope.clientSessionId === undefined) return undefined
  const ref = { userId: scope.userId, clientSessionId: scope.clientSessionId }
  if (!validRef(ref)) throw new Error('invalid receipt candidate deletion reference')
  return ref
}
export function receiptCandidateDeletionKey(ref: ReceiptCandidateDeletionRef): string {
  if (!validRef(ref)) throw new Error('invalid receipt candidate deletion reference')
  return createHash('sha256').update('receipt-client-deletion-v1\0').update(JSON.stringify([ref.userId, ref.clientSessionId])).digest('hex')
}
function readManifest(directory: number, partition: string): ReceiptCandidateManifest | undefined {
  const m = readRecord(directory, partition) as ReceiptCandidateManifest | undefined
  if (m === undefined) return undefined
  if (!m || m.v !== 1 || m.partition !== partition || (m.state !== 'active' && m.state !== 'retired') ||
      (m.state === 'active' && (!m.scope || m.scope.partition !== partition || !m.scope.owner))) throw new Error('invalid receipt candidate manifest')
  if (m.state === 'active') receiptCandidateDeletionRef(m.scope)
  if (m.state === 'retired' && m.deletionRef !== undefined && !validRef(m.deletionRef)) throw new Error('invalid receipt candidate deletion reference')
  return m
}
function manifestRef(m: ReceiptCandidateManifest): ReceiptCandidateDeletionRef | undefined {
  return m.state === 'active' ? receiptCandidateDeletionRef(m.scope) : m.deletionRef
}
function readDeletion(directory: number, ref: ReceiptCandidateDeletionRef): boolean {
  const value = readRecord(directory, receiptCandidateDeletionKey(ref)) as { v: number; ref: ReceiptCandidateDeletionRef } | undefined
  if (value === undefined) return false
  if (!value || value.v !== 1 || !validRef(value.ref) ||
      value.ref.userId !== ref.userId || value.ref.clientSessionId !== ref.clientSessionId) throw new Error('invalid receipt deletion fence')
  return true
}
function isDeleted(root: number, ref: ReceiptCandidateDeletionRef | undefined): boolean {
  if (!ref) return false
  let deleted: number
  try { deleted = childDirectory(root, 'deleted', false) } catch (e) { if (missing(e)) return false; throw e }
  try { return readDeletion(deleted, ref) } finally { closeSync(deleted) }
}
function proveRecord(directory: number, key: string): void {
  const fd = openSync(`/proc/self/fd/${directory}/${key}.json`, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { fsyncSync(fd) } finally { closeSync(fd) }
  fsyncSync(directory)
}
function writeManifest(directory: number, manifest: ReceiptCandidateManifest): void {
  writeRecord(directory, manifest.partition, manifest)
}

function writeRecord(directory: number, key: string, record: unknown): void {
  const path = `/proc/self/fd/${directory}`
  const temp = join(path, '.pending-' + randomBytes(16).toString('hex'))
  const bytes = Buffer.from(JSON.stringify(record))
  if (bytes.length > MAX_MANIFEST) throw new Error('oversized receipt candidate manifest')
  const fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  let renamed = false
  try {
    if (writeSync(fd, bytes) !== bytes.length) throw new Error('short receipt candidate manifest write')
    fsyncSync(fd)
    renameSync(temp, join(path, key + '.json')); renamed = true
    fsyncSync(directory)
  } finally { closeSync(fd); if (!renamed) unlinkSync(temp) }
}
function sameParent(a: ReceiptCandidateScope, b: ReceiptCandidateScope): boolean {
  const key = (s: ReceiptCandidateScope) => JSON.stringify([s.partition, s.userId, s.agentId, s.sessionKey,
    s.clientSessionId, ...['adapterInstanceId', 'parentOwnerEpoch', 'turnKey', 'nativeSessionId', 'parentProcess'].map(k => s.owner[k])])
  return key(a) === key(b)
}
/** Refuse links/unknown inode kinds. Every descendant stays anchored to a held fd. */
function removeDataDirectory(parent: number, name: string): void {
  let fd: number
  try { fd = childDirectory(parent, name, false) } catch (e) { if (missing(e)) return; throw e }
  try {
    const path = `/proc/self/fd/${fd}`
    for (const entry of readdirSync(path)) {
      const item = join(path, entry), stat = lstatSync(item)
      if (stat.uid !== process.getuid?.()) throw new Error('foreign receipt candidate data')
      if (stat.isDirectory()) removeDataDirectory(fd, entry)
      else if (stat.isFile()) unlinkSync(item)
      else throw new Error('unknown receipt candidate data inode')
    }
    fsyncSync(fd)
  } finally { closeSync(fd) }
  rmdirSync(`/proc/self/fd/${parent}/${name}`); fsyncSync(parent)
}

export class ReceiptCandidateLifecycle {
  constructor(readonly root: string) {
    if (process.platform !== 'linux' || !isAbsolute(root)) throw new Error('receipt candidate lifecycle requires absolute Linux root')
  }
  reportPath(partition: string, toolUseId: string): string {
    return join(this.root, 'data', checkedHash(partition), 'reports', receiptReportId(toolUseId))
  }
  private async locked<T>(create: boolean, work: (root: number, manifests: number, data: number) => T | Promise<T>): Promise<T> {
    // Only authoritative registration/deletion may create the control root. Writers and
    // retirement open it first, so the barrier helper's mkdir cannot resurrect it.
    if (create) {
      mkdirSync(this.root, { recursive: true, mode: 0o700 })
      const parent = openSync(dirname(this.root), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try { fsyncSync(parent) } finally { closeSync(parent) }
    }
    const root = privateDirectory(this.root)
    try {
      return await withReceiptWriteBarrier(`/proc/self/fd/${root}/barrier.lock`, async () => {
        const manifests = childDirectory(root, 'namespaces', create)
        try {
          const data = childDirectory(root, 'data', create)
          try { return await work(root, manifests, data) } finally { closeSync(data) }
        } finally { closeSync(manifests) }
      })
    } finally { closeSync(root) }
  }
  async register(scope: ReceiptCandidateScope, toolUseId: string, validate: () => void): Promise<string> {
    checkedHash(scope.partition)
    return this.locked(true, (root, manifests, data) => {
      validate() // final HTTP credentials + real original owner, AFTER awaiting flock
      if (isDeleted(root, receiptCandidateDeletionRef(scope))) throw new Error('receipt client session deleted')
      const current = readManifest(manifests, scope.partition)
      if (current?.state === 'retired') throw new Error('receipt candidate namespace retired')
      if (current?.state === 'active' && !sameParent(current.scope, scope)) throw new Error('receipt candidate parent conflict')
      if (!current) writeManifest(manifests, { v: 1, partition: scope.partition, state: 'active', scope })
      const ns = childDirectory(data, scope.partition, true)
      try {
        closeSync(childDirectory(ns, 'cache', true))
        const reports = childDirectory(ns, 'reports', true)
        try { closeSync(childDirectory(reports, receiptReportId(toolUseId), true)) } finally { closeSync(reports) }
      } finally { closeSync(ns) }
      return this.reportPath(scope.partition, toolUseId)
    })
  }
  async withActive<T>(partition: string, work: (namespacePath: string) => T | Promise<T>): Promise<T> {
    checkedHash(partition)
    return this.locked(false, async (root, manifests, data) => {
      const current = readManifest(manifests, partition)
      if (current?.state !== 'active' || isDeleted(root, manifestRef(current))) throw new Error('receipt candidate namespace unavailable')
      const ns = childDirectory(data, partition, false)
      try { return await work(`/proc/self/fd/${ns}`) } finally { closeSync(ns) }
    })
  }
  async retire(partition: string, inactive: (scope: ReceiptCandidateScope) => boolean): Promise<boolean> {
    checkedHash(partition)
    return this.locked(false, (_root, manifests, data) => {
      const current = readManifest(manifests, partition)
      if (!current) return false
      if (current.state === 'active') {
        if (!inactive(current.scope)) return false
        // Preserve the original exact tenant mapping even if GC later refuses
        // an unknown inode. A retired partition hash cannot recover this identity.
        const deletionRef = receiptCandidateDeletionRef(current.scope)
        writeManifest(manifests, { v: 1, partition, state: 'retired', ...(deletionRef ? { deletionRef } : {}) })
      }
      // A previous directory fsync failure may have left visible but unproved
      // retirement. Re-prove it before deleting anything on retry.
      proveRecord(manifests, partition)
      removeDataDirectory(data, partition)
      return true
    })
  }
  /** Called ONLY with post-transaction, exact owned-deleted references. Not an authentication API. */
  async fenceDeleted(refs: readonly ReceiptCandidateDeletionRef[]): Promise<{ pending: number }> {
    const keys = new Map(refs.map(ref => [receiptCandidateDeletionKey(ref), { ...ref }]))
    if (!keys.size) return { pending: 0 }
    return this.locked(true, (root, manifests, data) => {
      const deleted = childDirectory(root, 'deleted', true)
      try {
        for (const [key, ref] of keys) {
          if (!readDeletion(deleted, ref)) writeRecord(deleted, key, { v: 1, ref })
          // A prior rename followed by failed fsync is visible but not durable.
          proveRecord(deleted, key)
        }
      } finally { closeSync(deleted) }
      let pending = 0
      // Discover again UNDER the same writer lock, after the permanent fence.
      // A namespace enrolled after a caller's SQL snapshot must not be missed.
      for (const name of readdirSync(`/proc/self/fd/${manifests}`)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
        const partition = name.slice(0, -5)
        try {
          const current = readManifest(manifests, partition)
          if (!current) continue
          const ref = manifestRef(current)
          if (!ref || !keys.has(receiptCandidateDeletionKey(ref))) continue
          if (current.state === 'active') writeManifest(manifests, { v: 1, partition, state: 'retired', deletionRef: ref })
          proveRecord(manifests, partition)
          removeDataDirectory(data, partition)
        } catch { pending++ } // unknown inode/record is preserved, other matches still retire
      }
      return { pending }
    })
  }
  /** Snapshots are discovery only. Destructive matching is repeated under the barrier. */
  snapshots(): ReceiptCandidateManifest[] {
    let root: number
    try { root = privateDirectory(this.root) } catch (e) { if (missing(e)) return []; throw e }
    try {
      const manifests = childDirectory(root, 'namespaces', false)
      try {
        return readdirSync(`/proc/self/fd/${manifests}`).filter(n => /^[a-f0-9]{64}\.json$/.test(n))
          .flatMap(n => { const m = readManifest(manifests, n.slice(0, -5)); return m ? [m] : [] })
      } finally { closeSync(manifests) }
    } finally { closeSync(root) }
  }
  list(): string[] {
    let root: number
    try { root = privateDirectory(this.root) } catch (e) { if (missing(e)) return []; throw e }
    try {
      const manifests = childDirectory(root, 'namespaces', false)
      try { return readdirSync(`/proc/self/fd/${manifests}`).filter(n => /^[a-f0-9]{64}\.json$/.test(n)).map(n => n.slice(0, -5)) }
      finally { closeSync(manifests) }
    } finally { closeSync(root) }
  }
}
