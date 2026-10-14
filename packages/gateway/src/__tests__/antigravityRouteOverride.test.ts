/**
 * V5 Antigravity route validation (OCV5-415 P2). The master-authored route
 * becomes CLOUD_CODE_URL plus the CLI token file, so its shape is closed.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/antigravityRouteOverride.test.ts
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { _buildSafeAntigravityRouteOverride } from '../server.js'
import { V5_ANTIGRAVITY_RELAY_PREFIX } from '../v5AntigravityRelay.js'

const PORT = 18791
const TOKEN = 'a'.repeat(64)
const VALID = {
  baseUrl: `http://127.0.0.1:${PORT}${V5_ANTIGRAVITY_RELAY_PREFIX}/route/${TOKEN}`,
  routeToken: TOKEN,
  accessToken: 'ya29.limited-openid-userinfo-only',
  accessTokenExpiresAt: '2026-10-14T06:00:00.000Z',
}

function build(
  rawRoute: unknown,
  overrides: {
    model?: string
    port?: number
    authority?: {
      canonicalModel: string
      engine: 'ccb' | 'codex' | 'grok' | 'cursor' | 'zcode' | 'antigravity'
    }
  } = {},
) {
  return _buildSafeAntigravityRouteOverride({
    agent: { id: 'main' },
    model: 'model' in overrides ? overrides.model : 'antigravity-gemini-3.8-flash',
    rawRoute,
    officialRelayPort: overrides.port ?? PORT,
    authority: overrides.authority,
  })
}

describe('_buildSafeAntigravityRouteOverride', () => {
  test('accepts the exact token-bound loopback route with a limited token (id token optional)', () => {
    assert.deepEqual(build(VALID), VALID)
    const withId = { ...VALID, idToken: 'eyJhbGciOi.payload.signature' }
    assert.deepEqual(
      build(withId, {
        authority: { canonicalModel: 'antigravity-gemini-3.8-flash', engine: 'antigravity' },
      }),
      withId,
    )
  })

  test('is ignored for other engines', () => {
    assert.equal(build(VALID, { model: 'glm-5.3-zai' }), null)
    assert.equal(
      build(VALID, {
        authority: { canonicalModel: 'antigravity-gemini-3.8-flash', engine: 'ccb' },
      }),
      null,
    )
  })

  test('rejects unknown fields, token mismatch, alternate hosts/ports and query tricks', () => {
    for (const raw of [
      null,
      'route',
      { ...VALID, extra: true },
      { ...VALID, refreshToken: 'x'.repeat(40) },
      { baseUrl: VALID.baseUrl, routeToken: TOKEN },
      { ...VALID, accessToken: 'has space in it and is long' },
      { ...VALID, accessToken: 'short' },
      { ...VALID, accessTokenExpiresAt: 'not a date' },
      { ...VALID, idToken: 'bad id token with spaces' },
      { ...VALID, routeToken: 'b'.repeat(64) },
      { ...VALID, baseUrl: VALID.baseUrl.replace('127.0.0.1', 'localhost') },
      { ...VALID, baseUrl: VALID.baseUrl.replace('http:', 'https:') },
      { ...VALID, baseUrl: `${VALID.baseUrl}/v1internal:loadCodeAssist` },
      { ...VALID, baseUrl: `${VALID.baseUrl}?next=https://evil.example` },
      { ...VALID, baseUrl: VALID.baseUrl.replace(String(PORT), '18790') },
    ]) {
      assert.equal(build(raw), null, JSON.stringify(raw))
    }
  })
})
