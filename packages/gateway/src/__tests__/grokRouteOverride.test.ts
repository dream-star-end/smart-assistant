/**
 * V5 Grok route validation. The opaque route is master-authored and becomes
 * the official CLI's base URL/API key, so every byte of its shape is closed.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/grokRouteOverride.test.ts
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { _buildSafeGrokRouteOverride } from '../server.js'
import { V5_GROK_RELAY_PREFIX } from '../v5GrokRelay.js'

const PORT = 18789
const TOKEN = 'a'.repeat(64)
const VALID = {
  baseUrl: `http://127.0.0.1:${PORT}${V5_GROK_RELAY_PREFIX}/route/${TOKEN}/v1`,
  routeToken: TOKEN,
}

function build(rawRoute: unknown, overrides: { model?: string; port?: number; authority?: { canonicalModel: string; engine: 'ccb' | 'codex' | 'grok' } } = {}) {
  return _buildSafeGrokRouteOverride({
    agent: { id: 'main' },
    model: 'model' in overrides ? overrides.model : 'grok-build',
    rawRoute,
    officialRelayPort: overrides.port ?? PORT,
    authority: overrides.authority,
  })
}

describe('_buildSafeGrokRouteOverride', () => {
  test('accepts only the exact token-bound loopback route for the Grok engine', () => {
    assert.deepEqual(build(VALID), VALID)
    assert.deepEqual(build(VALID, {
      model: undefined,
      authority: { canonicalModel: 'grok-build', engine: 'grok' },
    }), VALID)
  })

  test('rejects non-Grok authority/model and malformed relay ports', () => {
    assert.equal(build(VALID, { model: 'glm-5.2' }), null)
    assert.equal(build(VALID, { authority: { canonicalModel: 'grok-build', engine: 'ccb' } }), null)
    for (const port of [0, -1, 65536, 1.5, Number.NaN]) {
      assert.equal(build(VALID, { port }), null)
    }
  })

  test('rejects unknown fields, token mismatch, alternate hosts and path/query tricks', () => {
    for (const raw of [
      null,
      'route',
      { ...VALID, extra: true },
      { ...VALID, routeToken: 'b'.repeat(64) },
      { ...VALID, baseUrl: VALID.baseUrl.replace('127.0.0.1', 'localhost') },
      { ...VALID, baseUrl: VALID.baseUrl.replace('http:', 'https:') },
      { ...VALID, baseUrl: `${VALID.baseUrl}/models` },
      { ...VALID, baseUrl: `${VALID.baseUrl}?next=https://evil.example` },
      { ...VALID, baseUrl: VALID.baseUrl.replace(String(PORT), '18790') },
    ]) {
      assert.equal(build(raw), null, JSON.stringify(raw))
    }
  })
})
