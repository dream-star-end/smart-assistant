/** Personal platform originals, never a claim to own an opaque CLI transcript.
 * Snapshots and in-turn fragments are immutable; summaries never enter this store. */
import { createHash, randomUUID } from 'node:crypto'
import { constants, closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  paths,
  readClientTimelinePage,
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

export interface CompactionArchiveReference {
  archiveId: string
  ownerUserId: string
  sessionId: string
  traceId?: string
  source: typeof COMPACTION_ORIGINAL_SOURCE
  path: string
  textPath: string
  contextTextPath: string
  createdAt: number
  expiresAt: number
}

export interface CompactionArchiveSnapshot {
  schema: 1
  archiveId: string
  ownerUserId: string
  sessionId: string
  sessionKey: string
  traceId?: string
  source: typeof COMPACTION_ORIGINAL_SOURCE
  createdAt: number
  expiresAt: number
  timelineGeneration: number | null
  historyRevision: number | null
  snapshotMaxSeq: number | null
  timeline: MessageLike[]
  currentInput: unknown
  platformContext?: string
  activeIds?: unknown[]
}

export interface CompactionTurnOriginal {
  schema: 1
  eventId: string
  archiveId: string
  sequence: number
  observedAt: number
  kind: string
  payload: unknown
  pendingTools?: unknown[]
}

export interface CompactionArchiveRead {
  snapshot: CompactionArchiveSnapshot
  reference: CompactionArchiveReference
  turnOriginals: CompactionTurnOriginal[]
}

const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
const rootFor = (options: CompactionArchiveOptions): string =>
  options.root ?? join(paths.home, 'compaction-originals')
const nowFor = (options: CompactionArchiveOptions): number => options.now?.() ?? Date.now()
const sessionHash = (owner: string, session: string): string => hash(`${owner}\0${session}`)
const safeId = (id: string): boolean => /^[a-f0-9]{64}$/.test(id)
const missing = (error: unknown): boolean =>
  !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
const fail = (code: string): never => { throw new Error(code) }

async function privateDirectory(path: string, recursive = false): Promise<void> {
  await mkdir(path, { mode: 0o700, recursive }).catch((error: unknown) => {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error
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

async function writeImmutable(path: string, value: string): Promise<void> {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await file.writeFile(value, 'utf8'); await file.sync() } finally { await file.close() }
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
          fail('COMPACTION_ARCHIVE_SESSION_NOT_FOUND')
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

function referenceFor(snapshot: CompactionArchiveSnapshot, root: string): CompactionArchiveReference {
  const dir = join(root, 'sessions', sessionHash(snapshot.ownerUserId, snapshot.sessionId), snapshot.archiveId)
  const textPath = join(dir, 'original.txt')
  return {
    archiveId: snapshot.archiveId, ownerUserId: snapshot.ownerUserId, sessionId: snapshot.sessionId,
    ...(snapshot.traceId ? { traceId: snapshot.traceId } : {}), source: snapshot.source,
    path: join(dir, 'snapshot.json'), textPath, contextTextPath: textPath,
    createdAt: snapshot.createdAt, expiresAt: snapshot.expiresAt,
  }
}

/** Capture under the caller's session lock, before handing anything to a CLI. */
export async function captureCompactionOriginal(input: {
  ownerUserId: string
  sessionId: string
  sessionKey: string
  traceId?: string
  currentInput: unknown
  platformContext?: string | ((timeline: readonly MessageLike[]) => string | Promise<string>)
  activeIds?: unknown[]
  allowMissingTimeline?: boolean
}, options: CompactionArchiveOptions = {}): Promise<{
  snapshot: CompactionArchiveSnapshot
  reference: CompactionArchiveReference
}> {
  // Freeze caller-owned input before pagination yields to later engine output.
  const contextBuilder = typeof input.platformContext === 'function'
    ? input.platformContext as (timeline: readonly MessageLike[]) => string | Promise<string>
    : undefined
  const frozen = structuredClone({ ...input, platformContext:
    typeof input.platformContext === 'string' ? input.platformContext : undefined })
  if (!frozen.ownerUserId || !frozen.sessionId || !frozen.sessionKey) fail('COMPACTION_ARCHIVE_IDENTITY_REQUIRED')
  const timeline = await readFullCompactionTimeline(frozen.sessionId, frozen.ownerUserId, {
    ...options, allowMissingTimeline: frozen.allowMissingTimeline,
  })
  if (contextBuilder) frozen.platformContext = await contextBuilder(structuredClone(timeline.timeline))
  const createdAt = nowFor(options)
  const snapshot: CompactionArchiveSnapshot = {
    schema: 1, archiveId: hash(randomUUID()), ownerUserId: frozen.ownerUserId,
    sessionId: frozen.sessionId, sessionKey: frozen.sessionKey,
    ...(frozen.traceId ? { traceId: frozen.traceId } : {}),
    source: COMPACTION_ORIGINAL_SOURCE, createdAt,
    expiresAt: createdAt + COMPACTION_ORIGINAL_RETENTION_MS, ...timeline,
    currentInput: frozen.currentInput,
    ...(frozen.platformContext !== undefined ? { platformContext: frozen.platformContext } : {}),
    ...(frozen.activeIds ? { activeIds: frozen.activeIds } : {}),
  }
  const root = rootFor(options)
  await privateDirectory(root, true)
  await privateDirectory(join(root, 'sessions'))
  await privateDirectory(join(root, 'traces'))
  await maybePrune(root, options)
  const parent = join(root, 'sessions', sessionHash(snapshot.ownerUserId, snapshot.sessionId))
  await privateDirectory(parent)
  const stage = join(parent, `.stage-${snapshot.archiveId}`)
  await privateDirectory(stage)
  try {
    await privateDirectory(join(stage, 'turn-originals'))
    await writeImmutable(join(stage, 'snapshot.json'), JSON.stringify(snapshot))
    const platformText = typeof snapshot.platformContext === 'string'
      ? snapshot.platformContext : JSON.stringify(snapshot.platformContext ?? null, null, 2)
    await writeImmutable(join(stage, 'original.txt'), [
      'Source: platform-full-timeline. Native CLI internal transcripts may contain additional material.',
      '\nAuthoritative platform context:\n', platformText,
      '\nExact platform timeline:\n', JSON.stringify(snapshot.timeline, null, 2),
      '\nExact current input:\n', typeof snapshot.currentInput === 'string'
        ? snapshot.currentInput : JSON.stringify(snapshot.currentInput, null, 2),
    ].join('\n'))
    await syncDirectory(stage)
    const target = join(parent, snapshot.archiveId)
    await rename(stage, target)
    await syncDirectory(parent)
    if (snapshot.traceId) {
      const traceDir = join(root, 'traces', hash(snapshot.traceId))
      await privateDirectory(traceDir)
      await writeImmutable(join(traceDir, `${snapshot.archiveId}.json`), JSON.stringify({
        ownerUserId: snapshot.ownerUserId, sessionId: snapshot.sessionId, archiveId: snapshot.archiveId,
        traceId: snapshot.traceId, createdAt, expiresAt: snapshot.expiresAt,
      }))
      await syncDirectory(traceDir)
    }
    return { snapshot, reference: referenceFor(snapshot, root) }
  } catch (error) {
    await rm(stage, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

const sequences = new Map<string, number>()

/** Call synchronously when compacting is observed, then catch failures in the
 * engine callback. A fresh immutable fragment preserves every exact snapshot. */
export function appendCompactionTurnOriginal(reference: CompactionArchiveReference, input: {
  kind: string
  payload: unknown
  pendingTools?: unknown[]
}, options: CompactionArchiveOptions = {}): { eventId: string; path: string } {
  const frozen = structuredClone(input)
  const observedAt = nowFor(options)
  if (reference.expiresAt <= observedAt) fail('COMPACTION_ARCHIVE_EXPIRED')
  if (!safeId(reference.archiveId)) fail('COMPACTION_ARCHIVE_INVALID_ID')
  const root = rootFor(options)
  const dir = join(root, 'sessions', sessionHash(reference.ownerUserId, reference.sessionId), reference.archiveId, 'turn-originals')
  const key = `${root}\0${reference.archiveId}`
  const sequence = (sequences.get(key) ?? 0) + 1
  sequences.set(key, sequence)
  const eventId = randomUUID()
  const event: CompactionTurnOriginal = {
    schema: 1, eventId, archiveId: reference.archiveId, sequence, observedAt, ...frozen,
  }
  const path = join(dir, `${observedAt}-${eventId}.json`)
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, JSON.stringify(event), 'utf8'); fsyncSync(fd) } finally { closeSync(fd) }
  const dirFd = openSync(dir, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
  return { eventId, path }
}

async function loadSnapshot(root: string, owner: string, sessionId: string, archiveId: string, now: number): Promise<CompactionArchiveSnapshot | null> {
  if (!safeId(archiveId)) return null
  try {
    const dir = join(root, 'sessions', sessionHash(owner, sessionId), archiveId)
    const snapshot = JSON.parse(await privateRead(join(dir, 'snapshot.json'))) as CompactionArchiveSnapshot
    if (snapshot.schema !== 1 || snapshot.source !== COMPACTION_ORIGINAL_SOURCE || snapshot.archiveId !== archiveId ||
        snapshot.ownerUserId !== owner || snapshot.sessionId !== sessionId || !Array.isArray(snapshot.timeline) ||
        !Number.isFinite(snapshot.expiresAt) || snapshot.expiresAt <= now) return null
    return snapshot
  } catch (error) { if (missing(error)) return null; throw error }
}

async function readWithFragments(snapshot: CompactionArchiveSnapshot, root: string): Promise<CompactionArchiveRead> {
  const reference = referenceFor(snapshot, root)
  const dir = join(root, 'sessions', sessionHash(snapshot.ownerUserId, snapshot.sessionId), snapshot.archiveId, 'turn-originals')
  const turnOriginals: CompactionTurnOriginal[] = []
  for (const name of await readdir(dir)) {
    if (!/^\d+-[a-f0-9-]+\.json$/.test(name)) continue
    const value = JSON.parse(await privateRead(join(dir, name))) as CompactionTurnOriginal
    if (value.schema !== 1 || value.archiveId !== snapshot.archiveId) fail('COMPACTION_ARCHIVE_INVALID_FRAGMENT')
    turnOriginals.push(value)
  }
  turnOriginals.sort((a, b) => a.observedAt - b.observedAt || a.sequence - b.sequence || a.eventId.localeCompare(b.eventId))
  return { snapshot, reference, turnOriginals }
}

/** Owner reads are exact-session scoped. Ops access is deliberately trace-only. */
export async function readCompactionOriginal(input: {
  sessionId: string
  archiveId: string
  principal: CompactionArchivePrincipal
}, options: CompactionArchiveOptions = {}): Promise<CompactionArchiveRead | null> {
  if (input.principal.kind !== 'owner') return null
  const root = rootFor(options)
  const snapshot = await loadSnapshot(root, input.principal.userId, input.sessionId, input.archiveId, nowFor(options))
  return snapshot ? readWithFragments(snapshot, root) : null
}

export async function readCompactionOriginalByTrace(input: {
  traceId: string
  principal: CompactionArchivePrincipal
}, options: CompactionArchiveOptions = {}): Promise<CompactionArchiveRead | null> {
  if (!input.traceId || (input.principal.kind !== 'owner' && input.principal.kind !== 'ops-trace')) return null
  const root = rootFor(options)
  const dir = join(root, 'traces', hash(input.traceId))
  let names: string[]
  try { names = await readdir(dir) } catch (error) { if (missing(error)) return null; throw error }
  const snapshots: CompactionArchiveSnapshot[] = []
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
    const index = JSON.parse(await privateRead(join(dir, name))) as {
      ownerUserId: string; sessionId: string; archiveId: string; traceId: string
    }
    if (index.traceId !== input.traceId || (input.principal.kind === 'owner' && index.ownerUserId !== input.principal.userId)) continue
    const snapshot = await loadSnapshot(root, index.ownerUserId, index.sessionId, index.archiveId, nowFor(options))
    if (snapshot?.traceId === input.traceId) snapshots.push(snapshot)
  }
  snapshots.sort((a, b) => b.createdAt - a.createdAt || b.archiveId.localeCompare(a.archiveId))
  return snapshots[0] ? readWithFragments(snapshots[0], root) : null
}

const lastPrune = new Map<string, number>()
async function maybePrune(root: string, options: CompactionArchiveOptions): Promise<void> {
  const now = nowFor(options)
  const previous = lastPrune.get(root)
  if (previous !== undefined && now - previous < 60 * 60_000) return
  await pruneCompactionOriginals(options)
  lastPrune.set(root, now)
}

/** Fragment files share their snapshot's retention; no orphan fragment store. */
export async function pruneCompactionOriginals(options: CompactionArchiveOptions = {}): Promise<{ removed: number }> {
  const root = rootFor(options)
  const now = nowFor(options)
  let sessions: string[]
  try { sessions = await readdir(join(root, 'sessions')) } catch (error) { if (missing(error)) return { removed: 0 }; throw error }
  let removed = 0
  for (const session of sessions) {
    if (!safeId(session)) continue
    const parent = join(root, 'sessions', session)
    const parentStat = await lstat(parent)
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) fail('COMPACTION_ARCHIVE_PRIVATE_DIRECTORY')
    for (const id of await readdir(parent)) {
      if (!safeId(id)) continue
      const dir = join(parent, id)
      const snapshot = JSON.parse(await privateRead(join(dir, 'snapshot.json'))) as CompactionArchiveSnapshot
      if (snapshot.schema !== 1 || snapshot.archiveId !== id ||
          sessionHash(snapshot.ownerUserId, snapshot.sessionId) !== session || !Number.isFinite(snapshot.expiresAt)) {
        fail('COMPACTION_ARCHIVE_INVALID_SNAPSHOT')
      }
      if (snapshot.expiresAt > now) continue
      await rm(dir, { recursive: true })
      sequences.delete(`${root}\0${id}`)
      if (snapshot.traceId) await rm(join(root, 'traces', hash(snapshot.traceId), `${id}.json`), { force: true })
      removed++
    }
  }
  return { removed }
}
