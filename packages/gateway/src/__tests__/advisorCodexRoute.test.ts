import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseAdvisorAdmitRoute } from '../advisorCodexRoute.js'

describe('parseAdvisorAdmitRoute', () => {
  it('accepts official_oauth and api_relay without a client URL', () => {
    assert.deepEqual(parseAdvisorAdmitRoute({ kind: 'official_oauth', groupId: '9' }), {
      ok: true,
      route: { kind: 'official_oauth', groupId: '9' },
    })
    const token = 'ab'.repeat(32)
    const parsed = parseAdvisorAdmitRoute({
      kind: 'api_relay',
      token,
      modelProvider: 'api111',
    })
    assert.equal(parsed.ok, true)
    if (parsed.ok && parsed.route.kind === 'api_relay') {
      assert.equal(parsed.route.token, token)
    }
  })

  it('rejects missing, unavailable, extra fields, and hardcoded baseUrl', () => {
    assert.deepEqual(parseAdvisorAdmitRoute(undefined), { ok: false, reason: 'missing' })
    assert.deepEqual(parseAdvisorAdmitRoute({ kind: 'unavailable' }), { ok: false, reason: 'unavailable' })
    assert.deepEqual(parseAdvisorAdmitRoute({ kind: 'official_oauth', extra: 1 }), { ok: false, reason: 'invalid' })
    assert.deepEqual(
      parseAdvisorAdmitRoute({
        kind: 'api_relay',
        token: 'ab'.repeat(32),
        modelProvider: 'api111',
        baseUrl: 'http://127.0.0.1:18789/internal/v3/codex-relay/route/' + 'ab'.repeat(32),
      }),
      { ok: false, reason: 'invalid' },
    )
  })
})
