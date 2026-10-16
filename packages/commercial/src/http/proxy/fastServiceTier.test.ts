/**
 * OCV5-434 GPT Fast — proxy pricing decision.
 *
 * Run: npx tsx --test packages/commercial/src/http/proxy/fastServiceTier.test.ts
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { applyFastServiceTierPricing } from './fastServiceTier.js'

const pricing = { multiplier: '1.000', input_per_mtok: 5n }

describe('OCV5-434 applyFastServiceTierPricing', () => {
  test('Fast on an OpenCode Go Luna composes ×2 and keeps the marker for the bridge', () => {
    for (const model of ['opencode-gpt-6-luna', 'opencode-gpt-5.6-luna']) {
      const body: { model: string; service_tier?: unknown } = { model, service_tier: 'priority' }
      const r = applyFastServiceTierPricing(body, pricing)
      assert.equal(r.fast, true)
      assert.equal(r.pricing.multiplier, '2.000')
      assert.equal(r.pricing.input_per_mtok, 5n)
      assert.equal(body.service_tier, 'priority')
    }
    assert.equal(
      applyFastServiceTierPricing(
        { model: 'opencode-gpt-6-luna', service_tier: 'priority' },
        { multiplier: '1.500' },
      ).pricing.multiplier,
      '3.000',
    )
  })
  test('standard requests are billed unchanged', () => {
    const body = { model: 'opencode-gpt-6-luna' }
    const r = applyFastServiceTierPricing(body, pricing)
    assert.equal(r.fast, false)
    assert.equal(r.pricing, pricing)
  })
  test('our marker on any other model is dropped and never billed as Fast', () => {
    for (const model of ['opencode-grok-4.7', 'glm-5.3-go', 'gpt-6-luna', 'claude-haiku-5-5-go']) {
      const body: { model: string; service_tier?: unknown } = { model, service_tier: 'priority' }
      const r = applyFastServiceTierPricing(body, pricing)
      assert.equal(r.fast, false, model)
      assert.equal(r.pricing.multiplier, '1.000')
      assert.equal('service_tier' in body, false, model)
    }
  })
  test('other service_tier values are left exactly as before', () => {
    const body: { model: string; service_tier?: unknown } = {
      model: 'claude-haiku-5-5-go',
      service_tier: 'auto',
    }
    assert.equal(applyFastServiceTierPricing(body, pricing).fast, false)
    assert.equal(body.service_tier, 'auto')
  })
})
