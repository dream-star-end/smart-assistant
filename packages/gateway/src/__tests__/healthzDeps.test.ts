/**
 * Tests for `_buildHealthzDeps` — the pure /healthz deep-probe merge extracted
 * from the `/healthz` handler (server.ts).
 *
 * 承诺(2026-07-07 P0 监控盲区收口):
 *   - sessions.db 或 commercial 注入的任一强依赖(pg `SELECT 1` / redis `PING`)
 *     探活失败 → 顶层 `ok:false`(HTTP 仍恒 200,由 handler 保证,供监控消费 ok)。
 *   - deps 扁平形态保留既有 `sessionsDb`/`sessionsDbError` 键;失败依赖追加
 *     `<name>Error`。
 *
 * Run: node --import tsx --test packages/gateway/src/__tests__/healthzDeps.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { _buildHealthzDeps } from '../server.js'

describe('_buildHealthzDeps', () => {
  it('全部 ok → ok:true, deps 全 ok', () => {
    const { deps, ok } = _buildHealthzDeps({ ok: true }, { pg: { ok: true }, redis: { ok: true } })
    assert.equal(ok, true)
    assert.deepEqual(deps, { sessionsDb: 'ok', pg: 'ok', redis: 'ok' })
  })

  it('PG 探活失败 → ok:false(HTTP 200 由 handler 保证),deps 带 pgError', () => {
    const { deps, ok } = _buildHealthzDeps(
      { ok: true },
      { pg: { ok: false, error: 'ECONNREFUSED' }, redis: { ok: true } },
    )
    assert.equal(ok, false)
    assert.equal(deps.sessionsDb, 'ok')
    assert.equal(deps.pg, 'error')
    assert.equal(deps.pgError, 'ECONNREFUSED')
    assert.equal(deps.redis, 'ok')
  })

  it('Redis 探活失败 → ok:false + redisError', () => {
    const { deps, ok } = _buildHealthzDeps(
      { ok: true },
      { pg: { ok: true }, redis: { ok: false, error: 'PING timeout' } },
    )
    assert.equal(ok, false)
    assert.equal(deps.redis, 'error')
    assert.equal(deps.redisError, 'PING timeout')
  })

  it('sessions.db 失败保留既有形态(sessionsDb/sessionsDbError)', () => {
    const { deps, ok } = _buildHealthzDeps({ ok: false, error: 'db locked' }, {})
    assert.equal(ok, false)
    assert.deepEqual(deps, { sessionsDb: 'error', sessionsDbError: 'db locked' })
  })

  it('无 commercial 依赖(空 extra)→ 只探 sessions.db,退回旧行为', () => {
    assert.deepEqual(_buildHealthzDeps({ ok: true }, {}), {
      deps: { sessionsDb: 'ok' },
      ok: true,
    })
  })

  it('多依赖同时失败 → ok:false,各自都带 Error', () => {
    const { deps, ok } = _buildHealthzDeps(
      { ok: false, error: 'sess boom' },
      { pg: { ok: false, error: 'pg boom' } },
    )
    assert.equal(ok, false)
    assert.equal(deps.sessionsDbError, 'sess boom')
    assert.equal(deps.pgError, 'pg boom')
  })
})
