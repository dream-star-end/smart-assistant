import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { projectAutoDreamCodexRoute } from '../http/internalAutoDreamOptimizer.js'
import { normalizeAutoDreamPreferencePatch } from '../user/autoDream.js'

describe('Auto-Dream V2 rollback preference boundary', () => {
  it('turns the legacy auto-mutating flag off when V2 consent is enabled', () => {
    const patch = normalizeAutoDreamPreferencePatch({
      auto_dream_enabled: true,
      auto_optimizer_enabled: true,
    })
    assert.equal(patch.auto_optimizer_enabled, true)
    assert.equal(
      patch.auto_dream_enabled,
      false,
      'an old runtime must see V1 disabled after rollback',
    )
  })

  it('keeps V1 and V2 mutually exclusive in both directions', () => {
    assert.deepEqual(normalizeAutoDreamPreferencePatch({ auto_dream_enabled: true }), {
      auto_dream_enabled: true,
      auto_optimizer_enabled: false,
    })
    assert.deepEqual(normalizeAutoDreamPreferencePatch({ auto_optimizer_enabled: false }), {
      auto_optimizer_enabled: false,
      auto_dream_enabled: false,
    })
  })
})

describe('Auto-Dream V2 Codex route admission', () => {
  it('routes official OAuth through the container loopback relay', () => {
    assert.deepEqual(projectAutoDreamCodexRoute({ kind: 'official_oauth' }), {
      token: null,
      routeFrame: {
        modelProvider: 'oc_chatgpt_official',
        baseUrl: 'http://127.0.0.1:18789/internal/v3/codex-relay/backend-api/codex',
        providerName: 'OpenAI (OpenClaude relay)',
        wireApi: 'responses',
        preferredAuthMethod: 'chatgpt',
        disableResponseStorage: true,
        requiresOpenaiAuth: true,
      },
    })
  })

  it('preserves the existing API relay frame and defaults', () => {
    assert.deepEqual(
      projectAutoDreamCodexRoute({
        kind: 'api_relay',
        token: 'relay-token',
        baseUrl: 'http://127.0.0.1:18789/internal/v3/codex-relay/route/relay-token',
        modelProvider: 'api111',
      }),
      {
        token: 'relay-token',
        routeFrame: {
          baseUrl: 'http://127.0.0.1:18789/internal/v3/codex-relay/route/relay-token',
          modelProvider: 'api111',
          providerName: null,
          wireApi: 'responses',
          preferredAuthMethod: 'apikey',
          disableResponseStorage: true,
        },
      },
    )
    assert.equal(projectAutoDreamCodexRoute(null), null)
    assert.equal(projectAutoDreamCodexRoute({ kind: 'unavailable' }), null)
  })

  it('wires admission to the commercial route decision before billing side effects', () => {
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
    const start = source.indexOf('if (path === AUTO_DREAM_OPTIMIZER_ADMIT_PATH)')
    const end = source.indexOf('if (path === AUTO_DREAM_OPTIMIZER_FINDINGS_PATH)', start)
    assert.ok(start >= 0 && end > start)
    const admission = source.slice(start, end)

    assert.match(admission, /projectAutoDreamCodexRoute\(\s*await createCommercialCodexRoute\(\{/)
    assert.doesNotMatch(admission, /createWechatApiRelayRoute/)
    const rejectedAt = admission.indexOf('AUTO_DREAM_ROUTE_UNAVAILABLE')
    assert.ok(rejectedAt >= 0)
    for (const later of ['pricing.get(', 'preCheckWithCost(', 'startInflightJournal(']) {
      assert.ok(admission.indexOf(later) > rejectedAt, `${later} must follow route rejection`)
    }
    assert.match(admission, /routeToken:\s*route\.token/)
    assert.match(admission, /routeFrame:\s*route\.routeFrame/)
  })
})
