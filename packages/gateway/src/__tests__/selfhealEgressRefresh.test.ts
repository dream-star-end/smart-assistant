import * as assert from 'node:assert/strict'
/**
 * MED16 route-branch tests (block C / §C5): /api/egress-proxy/refresh prefers
 * the selector-preserving resync and only falls back to the legacy refresh for
 * a not-yet-migrated (non-selector) config.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/selfhealEgressRefresh.test.ts
 */
import { describe, it } from 'node:test'
import { type EgressRefreshImpl, refreshEgressPreferSelector } from '../selfheal/egressRefresh.js'

const STATUS = { installed: true } as never

function impls(resyncResult: { resynced: boolean; reason?: string }) {
  const calls: string[] = []
  const impl: EgressRefreshImpl = {
    resync: (async () => {
      calls.push('resync')
      return { ...resyncResult, status: STATUS }
    }) as never,
    refresh: (async () => {
      calls.push('refresh')
      return { refreshed: true, count: 3, status: STATUS }
    }) as never,
  }
  return { impl, calls }
}

describe('refreshEgressPreferSelector (MED16)', () => {
  it('a successful resync is returned as-is; the legacy refresh never runs', async () => {
    const { impl, calls } = impls({ resynced: true })
    const r = (await refreshEgressPreferSelector({}, impl)) as { resynced?: boolean }
    assert.equal(r.resynced, true)
    assert.deepEqual(calls, ['resync'])
  })

  it('a NOT-migrated config falls back to the legacy refresh', async () => {
    const { impl, calls } = impls({
      resynced: false,
      reason: 'not a selector config; run migrate first',
    })
    const r = (await refreshEgressPreferSelector({}, impl)) as { refreshed?: boolean }
    assert.equal(r.refreshed, true)
    assert.deepEqual(calls, ['resync', 'refresh'])
  })

  it('any OTHER resync failure is returned verbatim — no fallback (a selector config must never be clobbered)', async () => {
    const { impl, calls } = impls({ resynced: false, reason: 'no primary member in config' })
    const r = (await refreshEgressPreferSelector({}, impl)) as {
      resynced?: boolean
      reason?: string
    }
    assert.equal(r.resynced, false)
    assert.equal(r.reason, 'no primary member in config')
    assert.deepEqual(calls, ['resync'], 'legacy refresh must NOT run on a selector config')
  })
})
