/**
 * 建行探针：空 messages + base 0 打到已有活跃行应 200 空操作，不走 409。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/sessionEnsureProbe.test.ts
 */
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { isSessionEnsureProbe } from '../routes/clientSessions.js'

const here = dirname(fileURLToPath(import.meta.url))
const routes = readFileSync(join(here, '../routes/clientSessions.ts'), 'utf8')

describe('isSessionEnsureProbe', () => {
  it('空 messages 且 base 缺席或 0 是探针', () => {
    assert.equal(isSessionEnsureProbe({ messages: [], _baseSyncedAt: 0 }), true)
    assert.equal(isSessionEnsureProbe({ messages: [] }), true)
    assert.equal(isSessionEnsureProbe({}), true)
  })

  it('有消息或非 0 水位不是探针', () => {
    assert.equal(isSessionEnsureProbe({ messages: [{ role: 'user' }], _baseSyncedAt: 0 }), false)
    assert.equal(isSessionEnsureProbe({ messages: [], _baseSyncedAt: 1 }), false)
    assert.equal(isSessionEnsureProbe({ messages: [], _baseSyncedAt: 5 }), false)
    assert.equal(isSessionEnsureProbe({ messages: 'nope', _baseSyncedAt: 0 }), false)
    assert.equal(isSessionEnsureProbe({ _baseSyncedAt: 0, messages: null }), false)
  })

  it('PUT 在 upsert 之前对活跃行短路 200，不改 storage 契约', () => {
    const put = routes.indexOf("if (req.method === 'PUT')")
    const probe = routes.indexOf('isSessionEnsureProbe(data)', put)
    const upsert = routes.indexOf('upsertClientSession(', put)
    assert.ok(put > 0 && probe > put && upsert > probe)
    assert.ok(routes.includes('{ ok: true, applied: false, existed: true }'))
    assert.ok(routes.includes("io.sendJson(res, 409, { error: 'conflict' })"))
  })
})
