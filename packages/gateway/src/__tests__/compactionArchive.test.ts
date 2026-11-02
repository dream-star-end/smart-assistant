import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { ClientTimelinePage, MessageLike } from '@openclaude/storage'
import {
  captureCompactionOriginal,
  COMPACTION_ORIGINAL_RETENTION_MS,
  pruneCompactionOriginals,
  readCompactionOriginal,
  readCompactionOriginalByTrace,
  readFullCompactionTimeline,
  startCompactionArchiveCleanup,
  type CompactionArchiveOptions,
} from '../compactionArchive.js'

const row = (index: number): MessageLike => ({
  id: `original-${index}`, role: 'user', text: `原文 ${index}`, _orderSeq: index, _seq: index,
})
const page = (messages: MessageLike[], before: number | null, revision = 1): ClientTimelinePage => ({
  messages, nextCursor: before === null ? null : { version: 1, timelineGeneration: 1, beforeOrderSeq: before },
  hasMore: before !== null, timelineGeneration: 1, historyRevision: revision, snapshotMaxSeq: 450,
})
const onePage: NonNullable<CompactionArchiveOptions['readPage']> = async () => page([row(1)], null)
const input = (ownerUserId = 'owner-a', sessionId = 'session-raw-a') => ({
  ownerUserId, sessionId, sessionKey: `agent:main:webchat:dm:${sessionId}`,
  traceId: 'a'.repeat(32), trigger: 'compacting', currentInput: '当前用户输入\n不许执行 X。',
})

async function treeBytes(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    files++
    bytes += (await stat(join(entry.parentPath, entry.name))).size
  }
  return { files, bytes }
}

test('full originals page archived rows and hot rows without a model-window cap', async () => {
  const calls: Array<{ sessionId: string; userId: string; before: number | undefined; limit: number | undefined }> = []
  const result = await readFullCompactionTimeline('session-full', 'owner-full', {
    readPage: async (sessionId, userId, cursor, limit) => {
      calls.push({ sessionId, userId, before: cursor?.beforeOrderSeq, limit })
      if (!cursor) return page(Array.from({ length: 50 }, (_, n) => row(n + 401)), 401)
      if (cursor.beforeOrderSeq === 401) return page(Array.from({ length: 200 }, (_, n) => row(n + 201)), 201)
      return page(Array.from({ length: 200 }, (_, n) => row(n + 1)), null)
    },
  })
  assert.equal(result.timeline.length, 450)
  assert.deepEqual(result.timeline.map((value) => value.id), Array.from({ length: 450 }, (_, n) => `original-${n + 1}`))
  assert.deepEqual(calls.map((value) => value.before), [undefined, 401, 201])
  assert.ok(calls.every((value) => value.sessionId === 'session-full' && value.userId === 'owner-full' && value.limit === 200))
})

test('revision changes discard partial pages and retry a consistent snapshot', async () => {
  let reads = 0
  const result = await readFullCompactionTimeline('session-revision', 'owner-a', {
    readPage: async (_session, _owner, cursor) => {
      reads++
      if (reads === 1) return page([row(2)], 2, 1)
      return cursor ? page([row(1)], null, 2) : page([row(2)], 2, 2)
    },
  })
  assert.equal(reads, 4)
  assert.equal(result.historyRevision, 2)
  assert.deepEqual(result.timeline.map((value) => value.id), ['original-1', 'original-2'])
})

test('persistent timeline mutation and cyclic cursors fail without publishing partial originals', async () => {
  let revision = 0
  await assert.rejects(readFullCompactionTimeline('session-unstable', 'owner-a', {
    readPage: async (_session, _owner, cursor) => cursor
      ? page([row(1)], null, ++revision)
      : page([row(2)], 2, ++revision),
  }), /COMPACTION_ARCHIVE_TIMELINE_CHANGED/)
  await assert.rejects(readFullCompactionTimeline('session-cycle', 'owner-a', {
    readPage: async () => page([row(2)], 2),
  }), /COMPACTION_ARCHIVE_INVALID_CURSOR/)
})

test('missing timeline is denied unless the authenticated new-session caller explicitly allows it', async () => {
  await assert.rejects(readFullCompactionTimeline('absent', 'other-owner', { readPage: async () => null }), /SESSION_NOT_FOUND/)
  assert.deepEqual(await readFullCompactionTimeline('new', 'owner-a', {
    readPage: async () => null, allowMissingTimeline: true,
  }), { timeline: [], timelineGeneration: null, historyRevision: null, snapshotMaxSeq: null })
})

test('a capture keeps exact private records and reconstructs the timeline in order', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'oc-compaction-archive-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const root = join(temp, 'originals')
  const rows = [row(1), { id: 'fallback', role: 'assistant', text: 'visible', _displayDegraded: true, _displayDegradeReason: 'records_failed' }, row(1)]
  const options = { root, readPage: async () => page(rows, null), now: () => 1000 }
  const original = { ...input(), currentInput: [{ type: 'text', text: '保留\n全文' }] }
  const saved = await captureCompactionOriginal(original, options)
  original.currentInput[0]!.text = 'later mutation'
  assert.equal(saved.manifest.source, 'platform-full-timeline')
  assert.equal(saved.manifest.trigger, 'compacting')
  assert.equal(saved.manifest.degradedRecords, 1)
  assert.equal(saved.manifest.expiresAt - saved.manifest.createdAt, COMPACTION_ORIGINAL_RETENTION_MS)
  assert.equal((await stat(root)).mode & 0o777, 0o700)
  const sessionDir = join(root, 'sessions', (await readdir(join(root, 'sessions')))[0]!)
  for (const name of await readdir(join(sessionDir, 'records'))) {
    assert.equal((await stat(join(sessionDir, 'records', name))).mode & 0o777, 0o600)
  }
  assert.equal((await readdir(join(sessionDir, 'records'))).length, 2, 'identical records are stored once')
  const recovered = await readCompactionOriginal({
    sessionId: original.sessionId, archiveId: saved.manifest.archiveId,
    principal: { kind: 'owner', userId: original.ownerUserId },
  }, options)
  assert.deepEqual(recovered?.timeline, rows)
  assert.deepEqual(recovered?.manifest.currentInput, [{ type: 'text', text: '保留\n全文' }])
})

test('owner and explicit ops-trace reads cannot cross session or owner boundaries', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'oc-compaction-acl-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  let now = 1000
  const options = { root: join(temp, 'originals'), readPage: onePage, now: () => now }
  const a = await captureCompactionOriginal(input('owner-a'), options)
  now++
  await captureCompactionOriginal(input('owner-b', 'session-raw-b'), options)
  const id = a.manifest.archiveId
  assert.equal(await readCompactionOriginal({ sessionId: a.manifest.sessionId, archiveId: id,
    principal: { kind: 'owner', userId: 'owner-b' } }, options), null)
  assert.equal(await readCompactionOriginal({ sessionId: 'another-session', archiveId: id,
    principal: { kind: 'owner', userId: 'owner-a' } }, options), null)
  assert.equal(await readCompactionOriginal({ sessionId: a.manifest.sessionId, archiveId: id,
    principal: { kind: 'ops-trace' } }, options), null)
  const byOwner = await readCompactionOriginalByTrace({ traceId: 'a'.repeat(32),
    principal: { kind: 'owner', userId: 'owner-a' } }, options)
  assert.equal(byOwner?.manifest.ownerUserId, 'owner-a')
  const byOps = await readCompactionOriginalByTrace({ traceId: 'a'.repeat(32),
    principal: { kind: 'ops-trace' } }, options)
  assert.equal(byOps?.manifest.ownerUserId, 'owner-b')
  assert.equal(await readCompactionOriginalByTrace({ traceId: 'a'.repeat(32),
    principal: { kind: 'owner', userId: 'stranger' } }, options), null)
  assert.equal(await readCompactionOriginalByTrace({ traceId: '../escape', principal: { kind: 'ops-trace' } }, options), null)
})

// Acceptance GAP-B (#1309): three turns over a ~1 MB timeline used to write
// three complete copies twice over (~6 MB). Captures now share records.
test('GAP-B: repeated captures of a ~1 MB timeline store each record once', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'oc-compaction-dedupe-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const rows: MessageLike[] = [{ id: 'u0', role: 'user', text: '禁止执行 X（原文）' },
    ...Array.from({ length: 50 }, (_, i) => ({ id: `a${i}`, role: 'assistant', text: 'r'.repeat(20_000) }))]
  const timelineBytes = Buffer.byteLength(JSON.stringify(rows))
  let current = rows
  const options = { root: join(temp, 'originals'), readPage: async () => page(current, null), now: () => 1000 }
  for (let i = 0; i < 3; i++) await captureCompactionOriginal(input(), options)
  current = [...rows, { id: 'u1', role: 'user', text: '新的一轮' }]
  await captureCompactionOriginal(input(), options)
  const { bytes } = await treeBytes(options.root)
  console.log(`# GAP-B timelineBytes=${timelineBytes} archiveBytes=${bytes} captures=4`)
  assert.ok(bytes < timelineBytes * 1.1, `archive ${bytes} B must stay near one timeline copy (${timelineBytes} B)`)
})

test('expiry denies both read seams and cleanup removes manifests, unshared records and trace indexes', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'oc-compaction-retention-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  let now = 1000
  let rows = [row(1), row(2)]
  const options = { root: join(temp, 'originals'), readPage: async () => page(rows, null), now: () => now }
  const first = await captureCompactionOriginal(input(), options)
  now += 60_000
  rows = [row(2), row(3)]
  const second = await captureCompactionOriginal({ ...input(), traceId: 'b'.repeat(32) }, options)
  now = first.manifest.expiresAt
  assert.equal(await readCompactionOriginal({ sessionId: first.manifest.sessionId,
    archiveId: first.manifest.archiveId, principal: { kind: 'owner', userId: 'owner-a' } }, options), null)
  assert.equal(await readCompactionOriginalByTrace({ traceId: 'a'.repeat(32), principal: { kind: 'ops-trace' } }, options), null)
  assert.deepEqual(await pruneCompactionOriginals(options), { removed: 1 })
  const kept = await readCompactionOriginal({ sessionId: second.manifest.sessionId,
    archiveId: second.manifest.archiveId, principal: { kind: 'owner', userId: 'owner-a' } }, options)
  assert.deepEqual(kept?.timeline, [row(2), row(3)], 'records shared with a live capture survive')
  const sessionDir = join(options.root, 'sessions', (await readdir(join(options.root, 'sessions')))[0]!)
  assert.equal((await readdir(join(sessionDir, 'records'))).length, 2, 'the record only the expired capture named is gone')
  const traceDir = join(options.root, 'traces', createHash('sha256').update('a'.repeat(32)).digest('hex'))
  assert.deepEqual(await readdir(traceDir), [], 'the expired trace index is removed')
  now = second.manifest.expiresAt
  assert.deepEqual(await pruneCompactionOriginals(options), { removed: 1 })
  await assert.rejects(stat(sessionDir), { code: 'ENOENT' })
})

test('unpublished crash manifests are swept and insecure roots fail closed', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'oc-compaction-path-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const now = Date.now()
  const options = { root: join(temp, 'originals'), readPage: onePage, now: () => now }
  const saved = await captureCompactionOriginal({ ...input(), traceId: undefined }, options)
  const captures = join(options.root, 'sessions', (await readdir(join(options.root, 'sessions')))[0]!, 'captures')
  const crashed = join(captures, `.${'1'.repeat(64)}.tmp`)
  await writeFile(crashed, '{"partial', { mode: 0o600 })
  await utimes(crashed, new Date(now - 2 * 60 * 60_000), new Date(now - 2 * 60 * 60_000))
  assert.deepEqual(await pruneCompactionOriginals(options), { removed: 0 })
  await assert.rejects(stat(crashed), { code: 'ENOENT' })
  assert.ok(await stat(join(captures, `${saved.manifest.archiveId}.json`)))
  const path = join(temp, 'root-is-file')
  await writeFile(path, 'not a directory')
  await assert.rejects(captureCompactionOriginal(input(), { ...options, root: path }))
  await chmod(options.root, 0o755)
  await assert.rejects(captureCompactionOriginal(input(), options), /PRIVATE_DIRECTORY/)
})

test('startup and hourly idle cleanup delete expired originals without a new chat, coalesce sweeps and stop', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'oc-compaction-idle-retention-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const hour = 60 * 60_000
  let now = 1000
  let clockReads = 0
  const options = { root: join(temp, 'originals'), readPage: onePage, now: () => { clockReads++; return now } }
  const first = await captureCompactionOriginal(input(), options)
  now += hour
  const second = await captureCompactionOriginal(input(), options)
  now = first.manifest.expiresAt + 1
  clockReads = 0
  t.mock.timers.enable({ apis: ['setInterval'] })
  const errors: unknown[] = []
  const stop = startCompactionArchiveCleanup(options, error => { errors.push(error) })
  t.after(stop)
  assert.equal(clockReads, 1, 'startup begins cleanup immediately')
  t.mock.timers.tick(hour * 3)
  assert.equal(clockReads, 1, 'a running filesystem sweep is never re-entered')
  const immediate = pruneCompactionOriginals(options)
  assert.equal(immediate, pruneCompactionOriginals(options), 'foreground capture and timer share the root sweep')
  await immediate
  const live = (archive: typeof first) => readCompactionOriginal({ sessionId: archive.manifest.sessionId,
    archiveId: archive.manifest.archiveId, principal: { kind: 'owner', userId: 'owner-a' } }, { ...options, now: () => 0 })
  assert.equal(await live(first), null)
  assert.ok(await live(second))
  now = second.manifest.expiresAt + 1
  t.mock.timers.tick(hour)
  assert.equal(clockReads, 2, 'the timer starts a new sweep without another capture')
  await pruneCompactionOriginals(options)
  assert.equal(await live(second), null)
  stop()
  t.mock.timers.tick(hour * 3)
  assert.equal(clockReads, 2, 'stop cancels every future sweep')
  assert.deepEqual(errors, [])
})

test('cleanup reports failures without unhandled rejections even when its error callback rejects', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'oc-compaction-cleanup-errors-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const root = join(temp, 'root-is-file')
  await writeFile(root, 'not a directory')
  let errors = 0
  let clockReads = 0
  const options = { root, now: () => { clockReads++; return 1000 } }
  t.mock.timers.enable({ apis: ['setInterval'] })
  const stop = startCompactionArchiveCleanup(options, async () => { errors++; throw new Error('logger failed') })
  t.after(stop)
  await assert.rejects(pruneCompactionOriginals(options), { code: 'ENOTDIR' })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(errors, 1)
  t.mock.timers.tick(60 * 60_000)
  assert.equal(clockReads, 2, 'a logging error cannot strand the running fence')
  await assert.rejects(pruneCompactionOriginals(options), { code: 'ENOTDIR' })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(errors, 2)
})
