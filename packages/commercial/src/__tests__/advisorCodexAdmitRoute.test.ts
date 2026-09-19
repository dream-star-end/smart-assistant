import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  bindingAllowsOfficialOAuth,
  officialOAuthBindingDenial,
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
          accountGroupId: 9n,
        },
        USER,
        '9',
      ),
      true,
    )
  })

  it('keeps official_oauth when the bound account belongs to the selected group', async () => {
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
        accountGroupId: 9n,
      }),
    })
    assert.deepEqual(route, { kind: 'official_oauth', groupId: '9' })
  })

  it('refuses official_oauth when the bound account is in another group', async () => {
    const route = await selectAdvisorCodexAdmitRoute({
      containerId: 11,
      userId: USER,
      modelId: 'gpt-6-astra',
      createRoute: async () => ({ kind: 'official_oauth', groupId: '9' }),
      readBinding: async () => ({
        codexAccountId: 53n,
        userId: USER,
        state: 'active',
        provider: 'codex',
        accountStatus: 'active',
        accountGroupId: 8n,
      }),
    })
    assert.deepEqual(route, { kind: 'unavailable', reason: 'bound_account_group_mismatch' })
    assert.equal(
      officialOAuthBindingDenial(
        {
          codexAccountId: 53n,
          userId: USER,
          state: 'active',
          provider: 'codex',
          accountStatus: 'active',
          accountGroupId: 8n,
        },
        USER,
        '9',
      ),
      'bound_account_group_mismatch',
    )
  })

  it('refuses official_oauth when the bound account group is unknown', async () => {
    const missing = await selectAdvisorCodexAdmitRoute({
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
    assert.deepEqual(missing, { kind: 'unavailable', reason: 'bound_account_group_unknown' })
    const nulled = await selectAdvisorCodexAdmitRoute({
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
        accountGroupId: null,
      }),
    })
    assert.deepEqual(nulled, { kind: 'unavailable', reason: 'bound_account_group_unknown' })
  })

  it('propagates binding lookup failures instead of authorizing', async () => {
    await assert.rejects(
      () =>
        selectAdvisorCodexAdmitRoute({
          containerId: 7,
          userId: USER,
          modelId: 'gpt-6-astra',
          createRoute: async () => ({ kind: 'official_oauth', groupId: '9' }),
          readBinding: async () => {
            throw new Error('db down')
          },
        }),
      /db down/,
    )
  })

  it('does not apply official group matching to api_relay', async () => {
    const route = await selectAdvisorCodexAdmitRoute({
      containerId: 7,
      userId: USER,
      modelId: 'gpt-6-astra',
      createRoute: async () => ({
        kind: 'api_relay',
        token: TOKEN,
        modelProvider: 'api111',
        engine: 'codex',
      }),
      readBinding: async () => {
        throw new Error('must not read binding for api_relay')
      },
    })
    assert.equal(route.kind, 'api_relay')
  })
})
