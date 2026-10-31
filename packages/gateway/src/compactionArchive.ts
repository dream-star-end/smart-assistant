/** Personal platform originals, never a claim to own an opaque CLI transcript.
 * Captured only at compaction boundaries. Timeline records are stored once per
 * session by content hash; each capture is a small immutable manifest. */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  paths,
  type readClientTimelinePage,
  type ClientTimelineCursor,
  type ClientTimelinePage,
  type MessageLike,
} from '@openclaude/storage'
import { readCompactionTimelinePage } from './compactionTimelineClient.js'

export const COMPACTION_ORIGINAL_RETENTION_MS = 30 * 24 * 60 * 60_000
export const COMPACTION_ORIGINAL_SOURCE = 'platform-full-timeline' as const

export interface CompactionArchiveOptions {
  root?: string
  now?: () => number
  readPage?: typeof readClientTimelinePage
}

export type CompactionArchivePrincipal =
  | { kind: 'owner'; userId: string }
  /** A trusted in-process capability, never a browser-supplied boolean. */
  | { kind: 'ops-trace' }

export interface CompactionArchiveManifest {
  schema: 2
  archiveId: string
  ownerUserId: string
  sessionId: string
  sessionKey: string
  traceId?: string
  trigger: string
  source: typeof COMPACTION_ORIGINAL_SOURCE
  createdAt: number
  expiresAt: number
  timelineGeneration: number | null
  historyRevision: number | null
  snapshotMaxSeq: number | null
  /** Content hashes of the exact timeline records, in timeline order. */
  records: string[]
  /** Master tape-fallback rows kept with their visible text and reason. */
  degradedRecords: number
  currentInput?: unknown
  /** Platform-visible partial output of the compacting turn, if any. */
  partial?: unknown
}

export interface CompactionArchiveRead {
  manifest: CompactionArchiveManifest
  timeline: MessageLike[]
}

const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
const rootFor = (options: CompactionArchiveOptions): string =>
  options.root ?? join(paths.home, 'compaction-originals')
const nowFor = (options: CompactionArchiveOptions): number => options.now?.() ?? Date.now()
const sessionHash = (owner: string, session: string): string => hash(`${owner}\0${session}`)
const safeId = (id: string): boolean => /^[a-f0-9]{64}$/.test(id)
const errorCode = (error: unknown): unknown => error && typeof error === 'object' && 'code' in error ? error.code : undefined
const fail = (code: string): never => { throw new Error(code) }
const sessionDir = (root: string, owner: string, session: string): string => join(root, 'sessions', sessionHash(owner, session))

/** Capture and prune of one session directory never interleave (record GC). */
const locks = new Map<string, Promise<unknown>>()
function withLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const next = (locks.get(key) ?? Promise.resolve()).then(run, run)
  const tail = next.catch(() => {})
  locks.set(key, tail)
  void tail.then(() => { if (locks.get(key) === tail) locks.delete(key) })
  return next
}

async function privateDirectory(path: string, recursive = false): Promise<void> {
  await mkdir(path, { mode: 0o700, recursive }).catch((error: unknown) => {
    if (errorCode(error) !== 'EEXIST') throw error
  })
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 ||
      stat.uid !== process.getuid?.()) fail('COMPACTION_ARCHIVE_PRIVATE_DIRECTORY')
}

async function privateRead(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 ||
        stat.uid !== process.getuid?.()) fail('COMPACTION_ARCHIVE_PRIVATE_FILE')
    return await file.readFile('utf8')
  } finally { await file.close() }
}

/** Exclusive create; an existing record with the same hash is the same bytes. */
async function writeImmutable(path: string, value: string, existingOk = false): Promise<boolean> {
  let file
  try {
    file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  } catch (error) {
    if (existingOk && errorCode(error) === 'EEXIST') return false
    throw error
  }
  try { await file.writeFile(value, 'utf8'); await file.sync() } finally { await file.close() }
  return true
}

async function syncDirectory(path: string): Promise<void> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { await file.sync() } finally { await file.close() }
}

class TimelineChanged extends Error {}

/** No model-window budget or row cap: page the complete authenticated timeline. */
export async function readFullCompactionTimeline(
  sessionId: string,
  ownerUserId: string,
  options: CompactionArchiveOptions & { allowMissingTimeline?: boolean } = {},
): Promise<{
  timeline: MessageLike[]
  timelineGeneration: number | null
  historyRevision: number | null
  snapshotMaxSeq: number | null
}> {
  const readPage = options.readPage ?? readCompactionTimelinePage
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const pages: MessageLike[][] = []
      let cursor: ClientTimelineCursor | null = null
      let first: ClientTimelinePage | null = null
      const cursors = new Set<string>()
      for (;;) {
        const page = await readPage(sessionId, ownerUserId, cursor, 200)
        if (!page) {
          if (!first && options.allowMissingTimeline) {
            return { timeline: [], timelineGeneration: null, historyRevision: null, snapshotMaxSeq: null }
          }
          return fail('COMPACTION_ARCHIVE_SESSION_NOT_FOUND')
        }
        if (first && (page.timelineGeneration !== first.timelineGeneration ||
            page.historyRevision !== first.historyRevision || page.snapshotMaxSeq !== first.snapshotMaxSeq)) {
          throw new TimelineChanged()
        }
        first ??= page
        pages.push(structuredClone(page.messages))
        if (!page.hasMore) {
          if (page.nextCursor !== null) fail('COMPACTION_ARCHIVE_INVALID_CURSOR')
          return {
            timeline: pages.reverse().flat(), timelineGeneration: first.timelineGeneration,
            historyRevision: first.historyRevision, snapshotMaxSeq: first.snapshotMaxSeq,
          }
        }
        if (!page.nextCursor) fail('COMPACTION_ARCHIVE_INVALID_CURSOR')
        const key = JSON.stringify(page.nextCursor)
        if (cursors.has(key)) fail('COMPACTION_ARCHIVE_INVALID_CURSOR')
        cursors.add(key)
        cursor = page.nextCursor
      }
    } catch (error) {
      if (!(error instanceof TimelineChanged) &&
          !(error instanceof Error && error.name === 'ClientTimelineCursorStaleError')) throw error
      if (attempt === 2) fail('COMPACTION_ARCHIVE_TIMELINE_CHANGED')
    }
  }
  return fail('COMPACTION_ARCHIVE_TIMELINE_CHANGED')
}

/** Best-effort audit copy at a compaction boundary. Callers run it off the
 * send path and only log failures. */
export async function captureCompactionOriginal(input: {
  ownerUserId: string
  sessionId: string
  sessionKey: string
  traceId?: string
  trigger?: string
  currentInput?: unknown
  partial?: unknown
  allowMissingTimeline?: boolean
}, options: CompactionArchiveOptions = {}): Promise<{ manifest: CompactionArchiveManifest; timeline: MessageLike[] }> {
  // Freeze caller-owned input before pagination yields to later engine output.
  const frozen = structuredClone(input)
  if (!frozen.ownerUserId || !frozen.sessionId || !frozen.sessionKey) fail('COMPACTION_ARCHIVE_IDENTITY_REQUIRED')
  const { timeline, ...versions } = await readFullCompactionTimeline(frozen.sessionId, frozen.ownerUserId, {
    ...options, allowMissingTimeline: frozen.allowMissingTimeline,
  })
  const root = rootFor(options)
  const dir = sessionDir(root, frozen.ownerUserId, frozen.sessionId)
  return withLock(dir, async () => {
    await privateDirectory(root, true)
    for (const sub of ['sessions', 'traces']) await privateDirectory(join(root, sub))
    await privateDirectory(dir)
    await privateDirectory(join(dir, 'records'))
    await privateDirectory(join(dir, 'captures'))
    const records: string[] = []
    let wrote = false
    for (const record of timeline) {
      const json = JSON.stringify(record)
      const id = hash(json)
      records.push(id)
      if (await writeImmutable(join(dir, 'records', `${id}.json`), json, true)) wrote = true
    }
    if (wrote) await syncDirectory(join(dir, 'records'))
    const createdAt = nowFor(options)
    const manifest: CompactionArchiveManifest = {
      schema: 2, archiveId: hash(randomUUID()), ownerUserId: frozen.ownerUserId,
      sessionId: frozen.sessionId, sessionKey: frozen.sessionKey,
      ...(frozen.traceId ? { traceId: frozen.traceId } : {}),
      trigger: frozen.trigger ?? 'compaction', source: COMPACTION_ORIGINAL_SOURCE,
      createdAt, expiresAt: createdAt + COMPACTION_ORIGINAL_RETENTION_MS, ...versions, records,
      degradedRecords: timeline.filter(record => record._displayDegraded === true).length,
      ...(frozen.currentInput !== undefined ? { currentInput: frozen.currentInput } : {}),
      ...(frozen.partial !== undefined ? { partial: frozen.partial } : {}),
    }
    // Publish the manifest atomically, only after every record it names is durable.
    const staged = join(dir, 'captures', `.${manifest.archiveId}.tmp`)
    await writeImmutable(staged, JSON.stringify(manifest))
    await rename(staged, join(dir, 'captures', `${manifest.archiveId}.json`))
    await syncDirectory(join(dir, 'captures'))
    if (manifest.traceId) {
      const traceDir = join(root, 'traces', hash(manifest.traceId))
      await privateDirectory(traceDir)
      await writeImmutable(join(traceDir, `${manifest.archiveId}.json`), JSON.stringify({
        ownerUserId: manifest.ownerUserId, sessionId: manifest.sessionId, archiveId: manifest.archiveId,
        traceId: manifest.traceId, createdAt, expiresAt: manifest.expiresAt,
      }))
      await syncDirectory(traceDir)
    }
    return { manifest, timeline }
  })
}

async function loadCapture(root: string, owner: string, sessionId: string, archiveId: string, now: number): Promise<CompactionArchiveRead | null> {
  if (!safeId(archiveId)) return null
  const dir = sessionDir(root, owner, sessionId)
  let manifest: CompactionArchiveManifest
  try {
    manifest = JSON.parse(await privateRead(join(dir, 'captures', `${archiveId}.json`))) as CompactionArchiveManifest
  } catch (error) { if (errorCode(error) === 'ENOENT') return null; throw error }
  if (manifest.schema !== 2 || manifest.source !== COMPACTION_ORIGINAL_SOURCE || manifest.archiveId !== archiveId ||
      manifest.ownerUserId !== owner || manifest.sessionId !== sessionId || !Array.isArray(manifest.records) ||
      !Number.isFinite(manifest.expiresAt) || manifest.expiresAt <= now) return null
  const timeline: MessageLike[] = []
  for (const id of manifest.records) {
    if (!safeId(id)) fail('COMPACTION_ARCHIVE_INVALID_MANIFEST')
    const json = await privateRead(join(dir, 'records', `${id}.json`))
    if (hash(json) !== id) fail('COMPACTION_ARCHIVE_RECORD_INTEGRITY')
    timeline.push(JSON.parse(json) as MessageLike)
  }
  return { manifest, timeline }
}

/** Owner reads are exact-session scoped. Ops access is deliberately trace-only. */
export async function readCompactionOriginal(input: {
  sessionId: string
  archiveId: string
  principal: CompactionArchivePrincipal
}, options: CompactionArchiveOptions = {}): Promise<CompactionArchiveRead | null> {
  if (input.principal.kind !== 'owner') return null
  return loadCapture(rootFor(options), input.principal.userId, input.sessionId, input.archiveId, nowFor(options))
}

export async function readCompactionOriginalByTrace(input: {
  traceId: string
  principal: CompactionArchivePrincipal
}, options: CompactionArchiveOptions = {}): Promise<CompactionArchiveRead | null> {
  if (!input.traceId || (input.principal.kind !== 'owner' && input.principal.kind !== 'ops-trace')) return null
  const root = rootFor(options)
  const dir = join(root, 'traces', hash(input.traceId))
  let names: string[]
  try { names = await readdir(dir) } catch (error) { if (errorCode(error) === 'ENOENT') return null; throw error }
  let latest: CompactionArchiveRead | null = null
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
    const index = JSON.parse(await privateRead(join(dir, name))) as {
      ownerUserId: string; sessionId: string; archiveId: string; traceId: string
    }
    if (index.traceId !== input.traceId || (input.principal.kind === 'owner' && index.ownerUserId !== input.principal.userId)) continue
    const read = await loadCapture(root, index.ownerUserId, index.sessionId, index.archiveId, nowFor(options))
    if (read?.manifest.traceId === input.traceId &&
        (!latest || read.manifest.createdAt > latest.manifest.createdAt)) latest = read
  }
  return latest
}

/** Expired manifests go first; records no live manifest names are then removed. */
async function pruneSession(root: string, dir: string, now: number): Promise<number> {
  let removed = 0
  const live = new Set<string>()
  let names: string[]
  try { names = await readdir(join(dir, 'captures')) } catch (error) { if (errorCode(error) === 'ENOENT') names = []; else throw error }
  for (const name of names) {
    const path = join(dir, 'captures', name)
    if (/^\.[a-f0-9]{64}\.tmp$/.test(name)) {
      // Crash leftover: a manifest that was never published.
      if ((await lstat(path)).mtimeMs < now - 60 * 60_000) await rm(path, { force: true })
      continue
    }
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
    const manifest = JSON.parse(await privateRead(path)) as CompactionArchiveManifest
    if (manifest.schema !== 2 || `${manifest.archiveId}.json` !== name || !Array.isArray(manifest.records) ||
        !Number.isFinite(manifest.expiresAt)) fail('COMPACTION_ARCHIVE_INVALID_MANIFEST')
    if (manifest.expiresAt > now) { for (const id of manifest.records) live.add(id); continue }
    await rm(path)
    if (manifest.traceId) await rm(join(root, 'traces', hash(manifest.traceId), name), { force: true })
    removed++
  }
  let records: string[]
  try { records = await readdir(join(dir, 'records')) } catch (error) { if (errorCode(error) === 'ENOENT') records = []; else throw error }
  for (const name of records) {
    if (/^[a-f0-9]{64}\.json$/.test(name) && !live.has(name.slice(0, 64))) await rm(join(dir, 'records', name))
  }
  if (live.size === 0 && !names.some(name => name.endsWith('.tmp'))) await rm(dir, { recursive: true, force: true })
  return removed
}

const pruning = new Map<string, Promise<{ removed: number }>>()

/** Timer sweeps coalesce per root; each session is pruned under its capture lock. */
export function pruneCompactionOriginals(options: CompactionArchiveOptions = {}): Promise<{ removed: number }> {
  const root = rootFor(options)
  const current = pruning.get(root)
  if (current) return current
  const pending = (async () => {
    const now = nowFor(options)
    let sessions: string[]
    try { sessions = await readdir(join(root, 'sessions')) } catch (error) { if (errorCode(error) === 'ENOENT') return { removed: 0 }; throw error }
    let removed = 0
    for (const session of sessions) {
      if (!safeId(session)) continue
      const dir = join(root, 'sessions', session)
      const stat = await lstat(dir)
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('COMPACTION_ARCHIVE_PRIVATE_DIRECTORY')
      removed += await withLock(dir, () => pruneSession(root, dir, now))
    }
    return { removed }
  })()
  pruning.set(root, pending)
  const release = () => { if (pruning.get(root) === pending) pruning.delete(root) }
  void pending.then(release, release)
  return pending
}

/** Enforce retention even if the user never sends another message. Stopping
 * prevents future sweeps; an already-running sweep is allowed to finish. */
export function startCompactionArchiveCleanup(
  options: CompactionArchiveOptions = {},
  onError: (error: unknown) => void | Promise<void> = () => {},
): () => void {
  let stopped = false
  const run = async (): Promise<void> => {
    if (stopped) return
    try {
      await pruneCompactionOriginals(options)
    } catch (error) {
      try { await onError(error) } catch { /* Logging cannot reject the timer task. */ }
    }
  }
  void run()
  const timer = setInterval(() => { void run() }, 60 * 60_000)
  timer.unref?.()
  return () => { stopped = true; clearInterval(timer) }
}
