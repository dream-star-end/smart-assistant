import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'server.ts'), 'utf8')
const start = source.indexOf('// ── Client session sync (cross-device, multi-user) ──')
const end = source.indexOf('// ── Changelog', start)
const routes = source.slice(start, end > start ? end : start + 20_000)

test('browser session full/incremental/archive routes request the bounded chat projection', () => {
  assert.ok(start >= 0, 'client session route block not found')
  assert.match(routes, /getClientSession\(sessId, userId, \{ projection: 'chat' \}\)/)
  assert.match(routes, /getClientSessionPartial\(sessId, userId, sinceSeq, \{ projection: 'chat' \}\)/)
  assert.match(routes, /readArchivedMessages\(sessId, userId, beforeSeq, limit, \{ projection: 'chat' \}\)/)
})
