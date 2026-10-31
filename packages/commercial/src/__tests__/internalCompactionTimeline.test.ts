import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import test from 'node:test'
import { encodeClientTimelineCursor, type ClientTimelineCursor, type ClientTimelinePage, type MessageLike } from '@openclaude/storage'
import { hashSecret, type ContainerIdentityRepo } from '../auth/containerIdentity.js'
import { makeCompactionTimelineHandler, COMPACTION_TIMELINE_PATH } from '../http/internalCompactionTimeline.js'

const fixtureSecret = 'ab'.repeat(32)
const page: ClientTimelinePage = {
  messages: [{ id: 'raw-user-1', role: 'user', text: '原文禁止 X' }],
  hasMore: false, nextCursor: null, historyRevision: 7, timelineGeneration: 3, snapshotMaxSeq: 81,
}
type HandlerDeps = Parameters<typeof makeCompactionTimelineHandler>[0]
const identityRepo: ContainerIdentityRepo = {
  async findActiveByHostAndBoundIp(hostUuid, boundIp) {
    if (hostUuid !== 'host-fixture' || boundIp !== '172.30.0.7') return null
    return { id: 7, user_id: 765, bound_ip: boundIp, host_uuid: hostUuid, secret_hash: hashSecret(fixtureSecret) }
  },
}

async function call(options: {
  auth?: string | null
  method?: string
  query?: string
  deps?: Partial<HandlerDeps>
  boundIp?: string
} = {}) {
  const reads: unknown[][] = []
  const req = Readable.from([]) as unknown as IncomingMessage
  Object.assign(req, {
    method: options.method ?? 'GET', url: `${COMPACTION_TIMELINE_PATH}?${options.query ?? 'sessionId=session-raw-1'}`,
    headers: options.auth === null ? {} : { authorization: options.auth ?? `Bearer oc-v3.7.${fixtureSecret}` },
  })
  let status = 0
  let sent = false
  const headers: Record<string, unknown> = {}
  const chunks: Buffer[] = []
  const res = {
    set statusCode(value: number) { status = value },
    get headersSent() { return sent },
    destroyed: false,
    setHeader(name: string, value: unknown) { headers[name.toLowerCase()] = value },
    write(value: Buffer) { sent = true; chunks.push(Buffer.from(value)); return true },
    end(value?: string) { sent = true; if (value) chunks.push(Buffer.from(value)) },
    destroy() { this.destroyed = true },
  } as unknown as ServerResponse
  const handler = makeCompactionTimelineHandler({
    identityRepo,
    readPage: async (...args) => { reads.push(args); return page },
    ...options.deps,
  })
  await handler(req, res, { hostUuid: 'host-fixture', boundIp: options.boundIp ?? '172.30.0.7' })
  const bytes = Buffer.concat(chunks)
  return { status, headers, reads, bytes, json: bytes.length ? JSON.parse(bytes.toString()) : null }
}

test('full timeline read uses verified container owner, exact storage cursor and fixed page quantum', async () => {
  const cursor = { version: 1 as const, timelineGeneration: 3, beforeOrderSeq: 50 }
  const result = await call({ query: `sessionId=session-raw-1&cursor=${encodeURIComponent(encodeClientTimelineCursor(cursor))}` })
  assert.equal(result.status, 200)
  assert.deepEqual(result.reads, [['session-raw-1', 'c:765', cursor, 200]])
  assert.deepEqual(result.json, { ownerUserId: 'c:765', sessionId: 'session-raw-1', page })
  assert.equal(result.headers['cache-control'], 'no-store')
  assert.equal(result.headers['x-openclaude-content-sha256'], createHash('sha256').update(result.bytes).digest('hex'))
})

test('both identity factors and strict query validation reject before reading any original', async () => {
  for (const [options, expected] of [
    [{ auth: null }, 401],
    [{ auth: `Bearer oc-v3.8.${fixtureSecret}` }, 401],
    [{ boundIp: '172.30.0.8' }, 401],
    [{ method: 'POST' }, 405],
    [{ query: 'sessionId=session-raw-1&userId=c%3Aother' }, 400],
    [{ query: 'sessionId=session-raw-1&cursor=bad' }, 400],
    [{ query: 'sessionId=session-raw-1&sessionId=another-session' }, 400],
  ] as const) {
    const result = await call(options)
    assert.equal(result.status, expected)
    assert.equal(result.reads.length, 0)
  }
})

test('cross-owner session miss stays 404 and cannot select another owner', async () => {
  let readOwner = ''
  const result = await call({ deps: { readPage: async (_id, owner) => { readOwner = owner; return null } } })
  assert.equal(readOwner, 'c:765')
  assert.equal(result.status, 404)
  assert.equal(result.json.error.code, 'SESSION_NOT_FOUND')
})

test('deferred tool and user originals are fully hydrated with byte and hash verification', async () => {
  const toolText = '工具完整原文'.repeat(220_000)
  const toolPayload = Buffer.from(JSON.stringify({ id: 'tool-raw', role: 'tool', text: toolText }))
  const userPayload = Buffer.from(JSON.stringify({ id: 'user-raw', role: 'user', text: '大用户原文禁止执行 X' }))
  const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
  const calls: unknown[][] = []
  const result = await call({ deps: {
    readPage: async () => ({ ...page, messages: [
      { id: 'tool-raw', role: 'tool', text: '', _payloadDeferred: true, _payloadSha256: sha(toolPayload),
        _turnTapeId: 'tape-fixture', _turnTapeSha256: 'a'.repeat(64), _recordOrdinal: 7, _orderSeq: 50 },
      { id: 'user-raw', role: 'user', text: '', _payloadDeferred: true, _userPayloadDeferred: true,
        _payloadSha256: sha(userPayload), _orderSeq: 51 },
    ] }),
    readTapePayload: async (...args) => {
      calls.push(args)
      const offset = args[4] ?? 0
      const length = args[5] ?? toolPayload.length
      return { payload: toolPayload.subarray(offset, offset + length), totalBytes: toolPayload.length, offset,
        msgId: 'tool-raw', role: 'tool', contentSha256: sha(toolPayload), tapeSha256: 'a'.repeat(64) }
    },
    readUserPayload: async (...args) => {
      calls.push(args)
      const offset = args[3] ?? 0
      const length = args[4] ?? userPayload.length
      return { payload: userPayload.subarray(offset, offset + length), totalBytes: userPayload.length, offset,
        msgId: 'user-raw', role: 'user', contentSha256: sha(userPayload) }
    },
  } })
  assert.equal(result.status, 200)
  assert.equal(result.json.page.messages[0].text, toolText)
  assert.equal(result.json.page.messages[1].text, '大用户原文禁止执行 X')
  assert.equal(result.json.page.messages[0]._payloadDeferred, false)
  assert.equal(result.json.page.messages[0]._orderSeq, 50)
  assert.ok(calls.every(args => args[0] === 'session-raw-1' && args[1] === 'c:765'))
  assert.deepEqual(calls[0], ['session-raw-1', 'c:765', 'tape-fixture', 7, 0, 1])
  assert.ok(calls.some(args => args[2] === 'tape-fixture' && Number(args[4]) > 0))
  assert.ok(calls.some(args => args[2] === 'user-raw' && args[3] === 0 && args[4] === 1))
})

test('hydration failure or explicit page ceiling never returns a partial success', async () => {
  const failed = await call({ deps: {
    readPage: async () => ({ ...page, messages: [{ id: 'user-raw', _payloadDeferred: true, _userPayloadDeferred: true }] }),
    readUserPayload: async () => null,
  } })
  assert.equal(failed.status, 503)
  assert.equal(failed.json.page, undefined)
  const tooLarge = await call({ deps: { maxResponseBytes: 8 } })
  assert.equal(tooLarge.status, 413)
  assert.equal(tooLarge.json.error.code, 'COMPACTION_TIMELINE_PAGE_TOO_LARGE')
  assert.equal(tooLarge.json.page, undefined)
  const degraded = await call({ deps: { readPage: async () => ({ ...page,
    messages: [{ id: 'fallback', text: 'visible head projection', _displayDegraded: true }] }) } })
  assert.equal(degraded.status, 503)
  assert.equal(degraded.json.page, undefined)
})

test('oversized deferred pages shrink through storage cursors and recover every original plus the terminal', async () => {
  // Scale the review's 33 x 2 MiB / 64 MiB counterexample down by 1024 so
  // the same page-size defect is quick to reproduce without a large fixture.
  const maxResponseBytes = 64 * 1024
  const originals = Array.from({ length: 33 }, (_, index) => ({
    id: `tool-${index + 1}`, role: 'tool', text: `${index + 1}:` + 'x'.repeat(2 * 1024),
  }))
  const payloads = new Map(originals.map(original => [original.id, Buffer.from(JSON.stringify(original))]))
  const rows: MessageLike[] = originals.map((original, index) => {
    const payload = payloads.get(original.id)!
    return { id: original.id, role: 'tool', text: '', _orderSeq: index + 1,
      _payloadDeferred: true, _payloadBytes: payload.length,
      _payloadSha256: createHash('sha256').update(payload).digest('hex'),
      _turnTapeId: 'tape-sized-page', _turnTapeSha256: 'a'.repeat(64), _recordOrdinal: index + 1 }
  })
  rows.push({ id: 'terminal-original', role: 'assistant', text: '正常完整终态', _orderSeq: 34 })
  const calls: Array<{ cursor: ClientTimelineCursor | null; limit: number }> = []
  const deps: Partial<HandlerDeps> = {
    maxResponseBytes,
    readPage: async (_sessionId, owner, cursor = null, limit = 200) => {
      assert.equal(owner, 'c:765')
      calls.push({ cursor, limit })
      const available = rows.filter(row => Number(row._orderSeq) < (cursor?.beforeOrderSeq ?? Infinity))
      const selected = available.slice(-limit)
      const hasMore = available.length > selected.length
      return { ...page, messages: selected, hasMore,
        nextCursor: hasMore ? { version: 1, timelineGeneration: 3, beforeOrderSeq: Number(selected[0]!._orderSeq) } : null }
    },
    readTapePayload: async (_sessionId, owner, tapeId, ordinal, offset = 0, length) => {
      assert.equal(owner, 'c:765')
      assert.equal(tapeId, 'tape-sized-page')
      const payload = payloads.get(`tool-${ordinal}`)!
      return { payload: payload.subarray(offset, offset + (length ?? payload.length)),
        totalBytes: payload.length, offset, msgId: `tool-${ordinal}`, role: 'tool',
        contentSha256: createHash('sha256').update(payload).digest('hex'), tapeSha256: 'a'.repeat(64) }
    },
  }
  const pages: MessageLike[][] = []
  let cursor: ClientTimelineCursor | null = null
  for (let pageNo = 0; ; pageNo++) {
    assert.ok(pageNo < rows.length)
    const result = await call({ deps, query: 'sessionId=session-raw-1' +
      (cursor ? `&cursor=${encodeURIComponent(encodeClientTimelineCursor(cursor))}` : '') })
    assert.equal(result.status, 200)
    assert.ok(result.bytes.length <= maxResponseBytes)
    pages.push(result.json.page.messages)
    if (!result.json.page.hasMore) break
    assert.ok(result.json.page.nextCursor)
    cursor = result.json.page.nextCursor
  }
  const recovered = pages.reverse().flat()
  assert.deepEqual(recovered.map(row => row.id), [...originals.map(row => row.id), 'terminal-original'])
  assert.deepEqual(recovered.slice(0, 33).map(row => row.text), originals.map(row => row.text))
  assert.equal(recovered.at(-1)?.text, '正常完整终态')
  assert.ok(calls.some(call => call.limit < 200))
  const firstCursorRead = calls.findIndex(call => call.cursor !== null)
  assert.ok(firstCursorRead > 0)
  assert.ok(calls.slice(0, firstCursorRead).every(call => call.cursor === null))
})
