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

test('browser session full/incremental/archive routes request the direct timeline', () => {
  assert.ok(start >= 0, 'client session route block not found')
  assert.match(routes, /getClientSession\(sessId, userId, \{ view: 'timeline' \}\)/)
  assert.match(routes, /getClientSessionPartial\(sessId, userId, sinceSeq, \{[\s\S]*?view: 'timeline',[\s\S]*?sinceHistoryRevision,[\s\S]*?\}\)/)
  assert.match(routes, /readArchivedMessages\(sessId, userId, beforeSeq, limit, \{ view: 'timeline' \}\)/)
  assert.match(routes, /url\.searchParams\.get\('since_history_revision'\)/)
  assert.match(routes, /_parseHistoryRevisionCursor\(historyRevisionRaw\)/)
  assert.match(routes, /userPayloadMatch/)
  assert.match(routes, /readUserMessagePayload\(sessId, userId, msgId, 0, 1\)/)
  assert.match(routes, /!isPersistedClientMessageId\(msgId\)/)
  assert.match(routes, /!isPersistedClientMessageId\(data\.id\)/)
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
