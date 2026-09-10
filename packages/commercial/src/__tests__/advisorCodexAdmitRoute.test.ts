import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  bindingAllowsOfficialOAuth,
  projectAdvisorAdmitRoute,
  selectAdvisorCodexAdmitRoute,
} from '../billing/advisorCodexAdmitRoute.js'

const TOKEN = 'ab'.repeat(32)
const USER = 42n

describe('projectAdvisorAdmitRoute', () => {
  it('strips api_relay baseUrl and unknown kinds', () => {
    assert.equal(
      projectAdvisorAdmitRoute({
        kind: 'api_relay',
        token: TOKEN,
        modelProvider: 'api111',
        baseUrl: 'http://127.0.0.1:18789/internal/v3/codex-relay/route/' + TOKEN,
        engine: 'codex',
      } as never).kind,
      'api_relay',
    )
    const projected = projectAdvisorAdmitRoute({
      kind: 'api_relay',
      token: TOKEN,
      modelProvider: 'api111',
      engine: 'codex',
    })
    assert.equal(projected.kind, 'api_relay')
    if (projected.kind === 'api_relay') {
      assert.equal('baseUrl' in projected, false)
      assert.equal(projected.token, TOKEN)
    }
    assert.deepEqual(projectAdvisorAdmitRoute({ kind: 'mystery' }), {
      kind: 'unavailable',
      reason: 'unknown_kind',
    })
    assert.deepEqual(projectAdvisorAdmitRoute({ kind: 'api_relay', token: TOKEN, modelProvider: 'x', engine: 'grok' }), {
      kind: 'unavailable',
      reason: 'unsupported_engine',
    })
  })
})

describe('selectAdvisorCodexAdmitRoute', () => {
  it('rejects official_oauth when this container has no bound account', async () => {
    const route = await selectAdvisorCodexAdmitRoute({
      containerId: 7,
      userId: USER,
      modelId: 'gpt-6-astra',
      createRoute: async () => ({ kind: 'official_oauth', groupId: '9' }),
      readBinding: async () => null,
    })
    assert.deepEqual(route, { kind: 'unavailable', reason: 'no_bound_codex_account' })
  })

  it('rejects official_oauth for another owner binding', async () => {
    const route = await selectAdvisorCodexAdmitRoute({
      containerId: 7,
      userId: USER,
      modelId: 'gpt-6-astra',
      createRoute: async () => ({ kind: 'official_oauth', groupId: '9' }),
      readBinding: async () => ({
        codexAccountId: 53n,
        userId: 99n,
        state: 'active',
        provider: 'codex',
        accountStatus: 'active',
      }),
    })
    assert.deepEqual(route, { kind: 'unavailable', reason: 'no_bound_codex_account' })
    assert.equal(
      bindingAllowsOfficialOAuth(
        {
          codexAccountId: 53n,
          userId: USER,
          state: 'active',
          provider: 'codex',
          accountStatus: 'active',
        },
        USER,
      ),
      true,
    )
  })

  it('keeps official_oauth when the container binding matches', async () => {
    const route = await selectAdvisorCodexAdmitRoute({
      containerId: 7,
      userId: USER,
      modelId: 'gpt-6-astra',
      createRoute: async () => ({ kind: 'official_oauth', groupId: '9' }),
      readBinding: async () => ({
        codexAccountId: 53n,
        userId: USER,
        state: 'active',
        provider: 'codex',
        accountStatus: 'active',
      }),
    })
    assert.deepEqual(route, { kind: 'official_oauth', groupId: '9' })
  })
})
