import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { ClientTimelinePage, MessageLike } from '@openclaude/storage'
import {
  appendCompactionTurnOriginal,
  captureCompactionOriginal,
  COMPACTION_ORIGINAL_RETENTION_MS,
  pruneCompactionOriginals,
  readCompactionOriginal,
  readCompactionOriginalByTrace,
  readFullCompactionTimeline,
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
  traceId: 'a'.repeat(32), currentInput: '当前用户输入\n不许执行 X。',
  platformContext: 'Authoritative original restriction: 不许执行 X。',
  activeIds: [{ jobId: 'dlgjob-original', state: 'running' }],
})

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

test('archive retains exact large platform context and input with immutable private files', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'oc-compaction-archive-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const root = join(temp, 'originals')
  const options = { root, readPage: onePage, now: () => 1000 }
  const longContext = '原文禁止 X，摘要的批准未经确认。\n'.repeat(20_000)
  let contextBuilds = 0
  const original = { ...input(), currentInput: [{ type: 'text', text: '保留\n全文' }] }
  const saved = await captureCompactionOriginal({ ...original, platformContext: async (timeline) => {
    contextBuilds++
    assert.equal(timeline[0]?.id, 'original-1')
    return longContext
  } }, options)
  original.currentInput[0]!.text = 'later mutation'
  assert.equal(contextBuilds, 1)
  assert.equal(saved.snapshot.source, 'platform-full-timeline')
  assert.equal(saved.snapshot.platformContext, longContext)
  assert.equal(saved.snapshot.expiresAt - saved.snapshot.createdAt, COMPACTION_ORIGINAL_RETENTION_MS)
  const text = await readFile(saved.reference.textPath, 'utf8')
  assert.ok(text.includes(longContext))
  assert.ok(text.includes('原文 1'))
  assert.equal((await stat(root)).mode & 0o777, 0o700)
  assert.equal((await stat(saved.reference.path)).mode & 0o777, 0o600)
  assert.equal((await stat(saved.reference.textPath)).mode & 0o777, 0o600)
  const recovered = await readCompactionOriginal({
    sessionId: original.sessionId, archiveId: saved.reference.archiveId,
    principal: { kind: 'owner', userId: original.ownerUserId },
  }, options)
  assert.deepEqual(recovered?.snapshot.currentInput, [{ type: 'text', text: '保留\n全文' }])
  assert.equal(recovered?.snapshot.platformContext, longContext)
  assert.equal(recovered?.reference.contextTextPath, saved.reference.textPath)
})

test('owner and explicit ops-trace reads cannot cross session or owner boundaries', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'oc-compaction-acl-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  let now = 1000
  const options = { root: join(temp, 'originals'), readPage: onePage, now: () => now }
  const a = await captureCompactionOriginal(input('owner-a'), options)
  now++
  await captureCompactionOriginal(input('owner-b', 'session-raw-b'), options)
  assert.equal(await readCompactionOriginal({ sessionId: a.reference.sessionId, archiveId: a.reference.archiveId,
    principal: { kind: 'owner', userId: 'owner-b' } }, options), null)
  assert.equal(await readCompactionOriginal({ sessionId: 'another-session', archiveId: a.reference.archiveId,
    principal: { kind: 'owner', userId: 'owner-a' } }, options), null)
  assert.equal(await readCompactionOriginal({ sessionId: a.reference.sessionId, archiveId: a.reference.archiveId,
    principal: { kind: 'ops-trace' } }, options), null)
  const byOwner = await readCompactionOriginalByTrace({ traceId: 'a'.repeat(32),
    principal: { kind: 'owner', userId: 'owner-a' } }, options)
  assert.equal(byOwner?.snapshot.ownerUserId, 'owner-a')
  const byOps = await readCompactionOriginalByTrace({ traceId: 'a'.repeat(32),
    principal: { kind: 'ops-trace' } }, options)
  assert.equal(byOps?.snapshot.ownerUserId, 'owner-b')
  assert.equal(await readCompactionOriginalByTrace({ traceId: 'a'.repeat(32),
    principal: { kind: 'owner', userId: 'stranger' } }, options), null)
  assert.equal(await readCompactionOriginalByTrace({ traceId: '../escape', principal: { kind: 'ops-trace' } }, options), null)
})

test('in-turn original snapshots append synchronously with pending tool IDs, preserving the base', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'oc-compaction-turn-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const options = { root: join(temp, 'originals'), readPage: onePage, now: () => 1000 }
  const saved = await captureCompactionOriginal(input(), options)
  const before = await readFile(saved.reference.path, 'utf8')
  const payload = { assistantText: '压缩前当轮原文', completedTools: [{ toolUseId: 'tool-exact-7', completed: false }] }
  const fragment = appendCompactionTurnOriginal(saved.reference, {
    kind: 'compacting', payload, pendingTools: [{ toolUseId: 'tool-exact-7' }],
  }, options)
  payload.assistantText = 'mutated after synchronous append'
  assert.equal((await stat(fragment.path)).mode & 0o777, 0o600)
  const recovered = await readCompactionOriginal({ sessionId: saved.reference.sessionId,
    archiveId: saved.reference.archiveId, principal: { kind: 'owner', userId: 'owner-a' } }, options)
  assert.equal(recovered?.turnOriginals.length, 1)
  assert.deepEqual(recovered?.turnOriginals[0]?.payload, {
    assistantText: '压缩前当轮原文', completedTools: [{ toolUseId: 'tool-exact-7', completed: false }],
  })
  assert.deepEqual(recovered?.turnOriginals[0]?.pendingTools, [{ toolUseId: 'tool-exact-7' }])
  assert.equal(await readFile(saved.reference.path, 'utf8'), before)
})

test('expiry denies both read seams and cleanup removes the snapshot and all fragments', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'oc-compaction-retention-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  let now = 1000
  const options = { root: join(temp, 'originals'), readPage: onePage, now: () => now }
  const saved = await captureCompactionOriginal(input(), options)
  const fragment = appendCompactionTurnOriginal(saved.reference, { kind: 'compacting', payload: 'raw exact text' }, options)
  now += COMPACTION_ORIGINAL_RETENTION_MS
  assert.equal(await readCompactionOriginal({ sessionId: saved.reference.sessionId,
    archiveId: saved.reference.archiveId, principal: { kind: 'owner', userId: 'owner-a' } }, options), null)
  assert.equal(await readCompactionOriginalByTrace({ traceId: 'a'.repeat(32), principal: { kind: 'ops-trace' } }, options), null)
  assert.throws(() => appendCompactionTurnOriginal(saved.reference, { kind: 'late', payload: '' }, options), /EXPIRED/)
  assert.deepEqual(await pruneCompactionOriginals(options), { removed: 1 })
  await assert.rejects(stat(saved.reference.path), { code: 'ENOENT' })
  await assert.rejects(stat(fragment.path), { code: 'ENOENT' })
  assert.equal(await readCompactionOriginalByTrace({ traceId: 'a'.repeat(32), principal: { kind: 'ops-trace' } }, options), null)
})

test('missing trace IDs mint independent immutable captures and insecure roots fail closed', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'oc-compaction-path-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const options = { root: join(temp, 'originals'), readPage: onePage, now: () => 1000 }
  const noTrace = { ...input(), traceId: undefined }
  const a = await captureCompactionOriginal(noTrace, options)
  const b = await captureCompactionOriginal(noTrace, options)
  assert.notEqual(a.reference.archiveId, b.reference.archiveId)
  const path = join(temp, 'root-is-file')
  await writeFile(path, 'not a directory')
  await assert.rejects(captureCompactionOriginal(input(), { ...options, root: path }))
})
