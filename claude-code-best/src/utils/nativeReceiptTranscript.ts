import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

// Structural wire contract; no gateway/SQLite native addon in the CCB bundle.
export type NativeReceiptProof = Readonly<{
  nativeSessionId: string
  recordLocator: string
  recordHash: string
}>
export type NativeReceiptObservation =
  | { kind: 'present'; proof: NativeReceiptProof }
  | { kind: 'absent' }
  | { kind: 'unknown' }

const digest = (s: string) => createHash('sha256').update(s).digest('hex')
const MAX_LINE_BYTES = 16 * 1024 * 1024
const writeTails = new Map<string, Promise<void>>()

/** Serialize the existing queue writer with receipt writes, not a TTL lease. */
export async function serializeTranscriptWrite<T>(
  file: string,
  write: () => Promise<T>,
): Promise<T> {
  const previous = writeTails.get(file) ?? Promise.resolve()
  const current = previous.catch(() => {}).then(write)
  const settled = current.then(
    () => {},
    () => {},
  )
  writeTails.set(file, settled)
  try {
    return await current
  } finally {
    if (writeTails.get(file) === settled) writeTails.delete(file)
  }
}

export function prepareNativeReceiptRecord(
  file: string,
  nativeSessionId: string,
  uuid: string,
  line: string,
) {
  if (line.includes('\n') || Buffer.byteLength(line) > MAX_LINE_BYTES) {
    throw new Error('receipt transcript record is not a bounded JSONL entry')
  }
  const entry = JSON.parse(line)
  if (
    entry.uuid !== uuid ||
    entry.sessionId !== nativeSessionId ||
    entry.type !== 'user' ||
    entry.isSidechain !== false
  ) {
    throw new Error('receipt input must be a current main-thread user record')
  }
  const proof: NativeReceiptProof = Object.freeze({
    nativeSessionId,
    recordLocator: JSON.stringify([file, uuid]),
    recordHash: digest(line),
  })
  return Object.freeze({ file, uuid, line, proof })
}

type Prepared = ReturnType<typeof prepareNativeReceiptRecord>
type Handle = Awaited<ReturnType<typeof open>>

/** Bounded-memory scan. Partial/malformed JSONL is UNKNOWN, never ABSENT. */
async function scan(handle: Handle, uuid: string, hash: string) {
  const buffer = Buffer.alloc(64 * 1024)
  let pending = Buffer.alloc(0)
  let offset = 0
  let found = 0
  let mismatch = false
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
    if (!bytesRead) break
    offset += bytesRead
    pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)])
    let end: number
    while ((end = pending.indexOf(10)) >= 0) {
      if (end > MAX_LINE_BYTES) throw new Error('oversized transcript record')
      const line = pending.subarray(0, end).toString('utf8')
      pending = pending.subarray(end + 1)
      if (!line) continue
      const entry = JSON.parse(line)
      if (entry.uuid === uuid) {
        found++
        mismatch ||= digest(line) !== hash
      }
    }
    if (pending.length > MAX_LINE_BYTES)
      throw new Error('oversized transcript record')
  }
  if (pending.length) throw new Error('incomplete transcript record')
  if (mismatch || found > 1)
    throw new Error('receipt transcript identity conflict')
  return found === 1
}

async function syncFileAndDirectory(handle: Handle, file: string) {
  await handle.sync()
  // Also on recovery: append may have completed before its first fsync, or
  // creation may have completed before the containing directory was synced.
  // The ordinary materializer can have just created the project directory as
  // well. Sync its ancestors too; syncing a new directory alone does not make
  // that directory's own name durable in its parent.
  let path = dirname(file)
  for (;;) {
    const directory = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY,
    )
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
    const parent = dirname(path)
    if (parent === path) break
    path = parent
  }
  const [opened, named] = await Promise.all([handle.stat(), stat(file)])
  if (opened.dev !== named.dev || opened.ino !== named.ino) {
    throw new Error('receipt transcript was replaced during commit')
  }
}

/** Caller holds the receipt writer barrier; the native parent chain exists. */
export async function appendNativeReceiptRecord(
  record: Prepared,
): Promise<void> {
  // Intentionally do not create directories/files here. sessionStorage must
  // first materialize and flush the actual native parent, not a sidecar file.
  const handle = await open(
    record.file,
    constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW,
  )
  try {
    if (await scan(handle, record.uuid, record.proof.recordHash)) {
      throw new Error(
        'receipt input UUID already exists; recover instead of rewriting',
      )
    }
    const bytes = Buffer.from(record.line + '\n')
    const { bytesWritten } = await handle.write(bytes)
    if (bytesWritten !== bytes.length)
      throw new Error('short receipt transcript write')
    await syncFileAndDirectory(handle, record.file)
    if (!(await scan(handle, record.uuid, record.proof.recordHash))) {
      throw new Error('receipt transcript commit could not be read back')
    }
  } finally {
    await handle.close()
  }
}

/**
 * Only call while holding the same receipt barrier used by the writer.
 * A readable/hash-matching line alone is not a durable/native-resume proof.
 */
export async function observeNativeReceiptRecord(
  proof: NativeReceiptProof,
  isInNativeResume: (file: string, uuid: string) => Promise<boolean>,
): Promise<NativeReceiptObservation> {
  let handle: Handle | undefined
  try {
    const locator: unknown = JSON.parse(proof.recordLocator)
    if (
      !Array.isArray(locator) ||
      locator.length !== 2 ||
      typeof locator[0] !== 'string' ||
      typeof locator[1] !== 'string'
    ) {
      return { kind: 'unknown' }
    }
    const [file, uuid] = locator as [string, string]
    try {
      handle = await open(file, constants.O_RDWR | constants.O_NOFOLLOW)
    } catch (err) {
      return {
        kind:
          (err as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'absent'
            : 'unknown',
      }
    }
    if (!(await scan(handle, uuid, proof.recordHash))) return { kind: 'absent' }
    await syncFileAndDirectory(handle, file)
    if (!(await isInNativeResume(file, uuid))) return { kind: 'unknown' }
    if (!(await scan(handle, uuid, proof.recordHash)))
      return { kind: 'unknown' }
    return { kind: 'present', proof }
  } catch {
    return { kind: 'unknown' }
  } finally {
    await handle?.close()
  }
}
