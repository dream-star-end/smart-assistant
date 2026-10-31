import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import test from 'node:test'
import type { request } from 'undici'
import type { ClientTimelinePage } from '@openclaude/storage'
import { COMPACTION_TIMELINE_PATH } from '@openclaude/protocol'
import { createCompactionTimelineReader } from '../compactionTimelineClient.js'

const env = { OPENCLAUDE_V3_MASTER_BASE_URL: 'http://master.invalid:18791/', OPENCLAUDE_V3_CONTAINER_TOKEN: 'fixture-token' }
const page: ClientTimelinePage = {
  messages: [{ id: 'original', role: 'user', text: '禁止 X' }], hasMore: false, nextCursor: null,
  historyRevision: 3, timelineGeneration: 2, snapshotMaxSeq: 71,
}
const wire = (value: ClientTimelinePage = page, owner = 'c:765') => ({ ownerUserId: owner, sessionId: 'session-raw-1', page: value })
function response(value: unknown, options: { status?: number; sha?: string; raw?: Buffer } = {}) {
  const bytes = options.raw ?? Buffer.from(JSON.stringify(value))
  return {
    statusCode: options.status ?? 200,
    headers: { 'x-openclaude-content-sha256': options.sha ?? createHash('sha256').update(bytes).digest('hex') },
    body: Readable.from([bytes]),
  } as unknown as Awaited<ReturnType<typeof request>>
}
const fetcher = (value: Awaited<ReturnType<typeof request>>) =>
  (async () => value) as unknown as typeof request

test('managed credentials always read master authority and preserve cursor transport', async () => {
  let called = false
  const cursor = { version: 1 as const, timelineGeneration: 2, beforeOrderSeq: 20 }
  const read = createCompactionTimelineReader({ env,
    localReadPage: async () => { assert.fail('local SQLite is not master authority') },
    fetcher: (async (url: string, options: { headers: Record<string, string> }) => {
      called = true
      const parsed = new URL(url)
      assert.equal(parsed.pathname, COMPACTION_TIMELINE_PATH)
      assert.equal(parsed.searchParams.get('sessionId'), 'session-raw-1')
      assert.equal(parsed.searchParams.has('userId'), false)
      assert.ok(parsed.searchParams.get('cursor'))
      assert.equal(options.headers.authorization, 'Bearer fixture-token')
      return response(wire())
    }) as unknown as typeof request,
  })
  assert.deepEqual(await read('session-raw-1', 'c:765', cursor, 200), page)
  assert.equal(called, true)
})

test('standalone runtime without master credentials keeps the exact local reader', async () => {
  const calls: unknown[][] = []
  const read = createCompactionTimelineReader({ env: {}, localReadPage: async (...args) => { calls.push(args); return page } })
  assert.deepEqual(await read('session-raw-1', 'local-user', null, 100), page)
  assert.deepEqual(calls, [['session-raw-1', 'local-user', null, 100]])
})

test('remote errors and incomplete credentials never fall back to local stale history', async () => {
  let localReads = 0
  const localReadPage = async () => { localReads++; return page }
  const remoteError = createCompactionTimelineReader({ env, localReadPage,
    fetcher: (async () => { throw new Error('transport failed with private detail') }) as unknown as typeof request })
  await assert.rejects(remoteError('session-raw-1', 'c:765'), /REMOTE_UNAVAILABLE/)
  const serverError = createCompactionTimelineReader({ env, localReadPage,
    fetcher: fetcher(response({}, { status: 503 })) })
  await assert.rejects(serverError('session-raw-1', 'c:765'), /REMOTE_STATUS_503/)
  const partial = createCompactionTimelineReader({ env: { OPENCLAUDE_V3_MASTER_BASE_URL: env.OPENCLAUDE_V3_MASTER_BASE_URL }, localReadPage })
  await assert.rejects(partial('session-raw-1', 'c:765'), /CONFIG_INCOMPLETE/)
  assert.equal(localReads, 0)
})

test('degraded tape-fallback rows are accepted with their reason', async () => {
  const messages = [{ id: 'fallback', text: 'projection', _displayDegraded: true, _displayDegradeReason: 'records_unpublished' }]
  const read = await createCompactionTimelineReader({ env, fetcher: fetcher(response(wire({ ...page, messages }))) })('session-raw-1', 'c:765')
  assert.deepEqual(read?.messages, messages)
})

test('wrong owner, deferred placeholders, truncated bytes and an explicit ceiling fail closed', async () => {
  for (const result of [
    response(wire(page, 'c:other')),
    response(wire({ ...page, messages: [{ id: 'locator', text: '', _payloadDeferred: true }] })),
    response(wire({ ...page, hasMore: true, nextCursor: null })),
    response(wire({ ...page, hasMore: true, nextCursor: { version: 1, timelineGeneration: 2, beforeOrderSeq: -1 } })),
    response(wire(), { sha: '0'.repeat(64) }),
  ]) {
    await assert.rejects(createCompactionTimelineReader({ env, fetcher: fetcher(result) })('session-raw-1', 'c:765'), /RESPONSE_(INVALID|INTEGRITY)/)
  }
  await assert.rejects(createCompactionTimelineReader({ env, maxResponseBytes: 8,
    fetcher: fetcher(response(wire())) })('session-raw-1', 'c:765'), /RESPONSE_TOO_LARGE/)
})

test('cut-off response bodies cannot pass the complete-page digest check', async () => {
  const full = Buffer.from(JSON.stringify(wire()))
  const truncated = response(null, { raw: full.subarray(0, full.length - 12),
    sha: createHash('sha256').update(full).digest('hex') })
  await assert.rejects(createCompactionTimelineReader({ env, fetcher: fetcher(truncated) })('session-raw-1', 'c:765'), /RESPONSE_INTEGRITY/)
  const broken = response(wire())
  broken.body = Readable.from((async function* () { yield full.subarray(0, 7); throw new Error('connection reset') })()) as unknown as typeof broken.body
  await assert.rejects(createCompactionTimelineReader({ env, fetcher: fetcher(broken) })('session-raw-1', 'c:765'), /INCOMPLETE_RESPONSE/)
})

test('multi-megabyte originals are kept whole and master misses remain misses', async () => {
  const text = '完整原文'.repeat(500_000)
  const large = { ...page, messages: [{ id: 'large', role: 'tool', text }] }
  const result = await createCompactionTimelineReader({ env, fetcher: fetcher(response(wire(large))) })('session-raw-1', 'c:765')
  assert.equal(result?.messages[0]?.text, text)
  assert.equal(await createCompactionTimelineReader({ env,
    fetcher: fetcher(response({}, { status: 404 })) })('session-raw-1', 'c:765'), null)
  await assert.rejects(createCompactionTimelineReader({ env,
    fetcher: fetcher(response({}, { status: 409 })) })('session-raw-1', 'c:765'), { name: 'ClientTimelineCursorStaleError' })
})
