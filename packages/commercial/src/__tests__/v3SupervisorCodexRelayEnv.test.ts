/**
 * V3 commercial — supervisor Codex relay env tests.
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/v3SupervisorCodexRelayEnv.test.ts
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  buildCodexRelayContainerEnv,
  isCodexLocalRelayEnabled,
  V3_CODEX_LOCAL_RELAY_ORIGIN,
} from '../agent-sandbox/v3supervisor.js'
import { buildCodexRelayLocalBaseUrl } from '../http/internalCodexRelay.js'

describe('buildCodexRelayContainerEnv', () => {
  test('does not enable Codex relay env unless a Codex provider is configured on master', () => {
    assert.deepEqual(buildCodexRelayContainerEnv({}), [])
    assert.deepEqual(buildCodexRelayContainerEnv({ OC_CODEX_UPSTREAM_BASE_URL: 'https://yunwu.ai/v1' }), [])
    assert.deepEqual(buildCodexRelayContainerEnv({ OC_CODEX_BASE_URL: 'https://legacy.example/v1' }), [])
  })

  test('defaults to legacy pass-through until the local relay rollout gate is flipped', () => {
    const out = buildCodexRelayContainerEnv({
      OC_CODEX_MODEL_PROVIDER: 'openai-compatible',
      OC_CODEX_PROVIDER_NAME: 'Codex Upstream',
      OC_CODEX_WIRE_API: 'responses',
      OC_CODEX_PREFERRED_AUTH_METHOD: 'chatgpt',
      OC_CODEX_DISABLE_RESPONSE_STORAGE: '1',
      OC_CODEX_BASE_URL: 'https://legacy.example/v1',
      OC_CODEX_UPSTREAM_BASE_URL: 'https://yunwu.ai/v1',
      OC_CODEX_API_KEY: 'must-not-leak',
    })

    assert.equal(isCodexLocalRelayEnabled({}), false)
    assert.ok(out.includes('OC_CODEX_MODEL_PROVIDER=openai-compatible'))
    assert.ok(out.includes('OC_CODEX_PROVIDER_NAME=Codex Upstream'))
    assert.ok(out.includes('OC_CODEX_BASE_URL=https://legacy.example/v1'))
    assert.ok(out.includes('OC_CODEX_WIRE_API=responses'))
    assert.ok(out.includes('OC_CODEX_PREFERRED_AUTH_METHOD=chatgpt'))
    assert.ok(out.includes('OC_CODEX_DISABLE_RESPONSE_STORAGE=1'))
    assert.equal(out.some((v) => v.includes('OC_CODEX_UPSTREAM_BASE_URL=')), false)
    assert.equal(out.some((v) => v.includes('OC_CODEX_API_KEY=')), false)
  })

  test('legacy mode maps the dedicated upstream env to OC_CODEX_BASE_URL when needed', () => {
    const out = buildCodexRelayContainerEnv({
      OC_CODEX_MODEL_PROVIDER: 'openai-compatible',
      OC_CODEX_UPSTREAM_BASE_URL: 'https://yunwu.ai/v1',
    })

    assert.ok(out.includes('OC_CODEX_MODEL_PROVIDER=openai-compatible'))
    assert.ok(out.includes('OC_CODEX_BASE_URL=https://yunwu.ai/v1'))
    assert.equal(out.some((v) => v.includes('OC_CODEX_UPSTREAM_BASE_URL=')), false)
  })

  test('when enabled, passes only non-secret knobs and rewrites OC_CODEX_BASE_URL to the container loopback relay', () => {
    const out = buildCodexRelayContainerEnv({
      OC_V3_CODEX_LOCAL_RELAY_ENABLED: '1',
      OC_CODEX_MODEL_PROVIDER: 'openai-compatible',
      OC_CODEX_PROVIDER_NAME: 'Codex Upstream',
      OC_CODEX_WIRE_API: 'responses',
      OC_CODEX_PREFERRED_AUTH_METHOD: 'chatgpt',
      OC_CODEX_DISABLE_RESPONSE_STORAGE: '1',
      OC_CODEX_BASE_URL: 'https://legacy.example/v1',
      OC_CODEX_UPSTREAM_BASE_URL: 'https://yunwu.ai/v1',
      OC_CODEX_API_KEY: 'must-not-leak',
    })

    assert.ok(out.includes('OC_CODEX_MODEL_PROVIDER=openai-compatible'))
    assert.ok(out.includes('OC_CODEX_PROVIDER_NAME=Codex Upstream'))
    assert.ok(out.includes('OC_CODEX_WIRE_API=responses'))
    assert.ok(out.includes('OC_CODEX_PREFERRED_AUTH_METHOD=chatgpt'))
    assert.ok(out.includes('OC_CODEX_DISABLE_RESPONSE_STORAGE=1'))
    assert.ok(out.includes(`OC_CODEX_BASE_URL=${buildCodexRelayLocalBaseUrl(V3_CODEX_LOCAL_RELAY_ORIGIN, 'https://yunwu.ai/v1')}`))
    assert.equal(out.some((v) => v.includes('legacy.example')), false)
    assert.equal(out.some((v) => v.includes('OC_CODEX_UPSTREAM_BASE_URL=')), false)
    assert.equal(out.some((v) => v.includes('OC_CODEX_API_KEY=')), false)
  })
})
