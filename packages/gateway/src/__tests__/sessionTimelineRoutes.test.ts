import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { isPersistedClientMessageId } from '@openclaude/protocol'
import { _parseHistoryRevisionCursor } from '../server.js'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'server.ts'), 'utf8')
const start = source.indexOf('// ── Client session sync (cross-device, multi-user) ──')
const end = source.indexOf('// ── Changelog', start)
const routes = source.slice(start, end > start ? end : start + 20_000)

test('browser history uses one opaque unified timeline route', () => {
  assert.ok(start >= 0, 'client session route block not found')
  assert.match(routes, /getClientSession\(sessId, userId, \{ view: 'timeline' \}\)/)
  assert.match(routes, /getClientSessionPartial\(sessId, userId, sinceSeq, \{[\s\S]*?view: 'timeline',[\s\S]*?sinceHistoryRevision,[\s\S]*?\}\)/)
  assert.match(routes, /const timelineMatch = url\.pathname\.match/)
  assert.match(routes, /decodeClientTimelineCursor\(rawCursor\)/)
  assert.match(routes, /readClientTimelinePage\(sessId, userId, cursor, limit\)/)
  assert.match(routes, /nextCursor: page\.nextCursor \? encodeClientTimelineCursor\(page\.nextCursor\) : null/)
  assert.match(routes, /error instanceof ClientTimelineCursorStaleError/)
  assert.match(routes, /TIMELINE_CURSOR_STALE/)
  assert.match(routes, /url\.searchParams\.get\('since_history_revision'\)/)
  assert.match(routes, /_parseHistoryRevisionCursor\(historyRevisionRaw\)/)
  assert.match(routes, /userPayloadMatch/)
  assert.match(routes, /readUserMessagePayload\(sessId, userId, msgId, 0, 1\)/)
  assert.match(routes, /!isPersistedClientMessageId\(msgId\)/)
  assert.match(routes, /!isPersistedClientMessageId\(data\.id\)/)
  const timelineRoute = routes.slice(
    routes.indexOf('const timelineMatch'),
    routes.indexOf('// 归档分页端点', routes.indexOf('const timelineMatch')),
  )
  assert.doesNotMatch(timelineRoute, /_turnTapeProcess|projection|listTurnTapeRecords/)
})

test('session GET failures log message+stack+sessionId and return requestId', () => {
  assert.match(source, /private sendSessionReadFailure\(/)
  assert.match(source, /this\.log\.error\('session read failed', \{ sessionId, requestId, publicError \}, err\)/)
  assert.match(source, /this\.sendJson\(res, 500, \{ error: publicError, requestId \}\)/)
  assert.match(routes, /this\.sendSessionReadFailure\(res, error, sessId, 'timeline read failed'\)/)
  assert.match(routes, /this\.sendSessionReadFailure\(res, error, sessId, 'get failed'\)/)
  assert.equal(
    (routes.match(/this\.sendSessionReadFailure\(res, error, sessId, 'get failed'\)/g) ?? []).length,
    2,
  )
  assert.doesNotMatch(
    routes.slice(routes.indexOf('const timelineMatch'), routes.indexOf('const archiveMatch')),
    /\.catch\(\(\) => this\.sendJson\(res, 500/,
  )
})

test('user payload routes cover canonical 128-char ids and legacy colon ids', () => {
  assert.equal(isPersistedClientMessageId('a'.repeat(128)), true)
  assert.equal(isPersistedClientMessageId('cm:user:large'), true)
  assert.equal(isPersistedClientMessageId('a'.repeat(129)), false)
  assert.equal(isPersistedClientMessageId(`${'a'.repeat(80)}:x`), false)
})

test('history revision cursor accepts only canonical non-negative decimal integers', () => {
  assert.equal(_parseHistoryRevisionCursor('0'), 0)
  assert.equal(_parseHistoryRevisionCursor('42'), 42)
  for (const invalid of [null, '', ' ', '00', '01', '+1', '-1', '0x0', '1.0', '9007199254740992']) {
    assert.equal(_parseHistoryRevisionCursor(invalid), undefined, `must reject ${JSON.stringify(invalid)}`)
  }
})
