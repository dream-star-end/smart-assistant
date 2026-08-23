/**
 * 锁死:codex / grok / cursor 引擎的 delegate 结果在有 token 时 cost_usd > 0。
 * 定价走 protocol computeCostFen(model_pricing + multiplier),不另写价格表。
 *
 * 跑法:npx tsx --test packages/gateway/src/__tests__/usageCost.test.ts
 */

import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import {
  _setPlatformPricingLookupForTests,
  applyPlatformCostIfMissing,
  estimatePlatformCostUsd,
  resolveDelegateCostUsd,
  type PlatformPricing,
} from '../usageCost.js'

const TERRA: PlatformPricing = {
  inputPerMtok: '150',
  outputPerMtok: '899',
  cacheReadPerMtok: '15',
  cacheWritePerMtok: '0',
  multiplier: '1.000',
}

const FAST_TERRA: PlatformPricing = { ...TERRA, multiplier: '2.000' }

const GROK: PlatformPricing = {
  inputPerMtok: '200',
  outputPerMtok: '1500',
  cacheReadPerMtok: '50',
  cacheWritePerMtok: '0',
  multiplier: '1.000',
}

const CURSOR_GROK: PlatformPricing = {
  inputPerMtok: '200',
  outputPerMtok: '1500',
  cacheReadPerMtok: '50',
  cacheWritePerMtok: '0',
  multiplier: '1.000',
}

const PRICES: Record<string, PlatformPricing> = {
  'gpt-5.6-terra': TERRA,
  'gpt-5.6-terra-fast': FAST_TERRA,
  'grok-build': GROK,
  'cursor-grok-4.6-high': CURSOR_GROK,
}

afterEach(() => {
  _setPlatformPricingLookupForTests(null)
})

describe('estimatePlatformCostUsd', () => {
  test('codex / grok / cursor 有 token 时 cost_usd > 0,且 Fast multiplier 加倍', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
    const codex = estimatePlatformCostUsd(usage, TERRA)
    const grok = estimatePlatformCostUsd(usage, GROK)
    const cursor = estimatePlatformCostUsd(usage, CURSOR_GROK)
    const fast = estimatePlatformCostUsd(usage, FAST_TERRA)
    assert.ok(codex > 0, `codex cost should be > 0, got ${codex}`)
    assert.ok(grok > 0, `grok cost should be > 0, got ${grok}`)
    assert.ok(cursor > 0, `cursor cost should be > 0, got ${cursor}`)
    assert.ok(Math.abs(fast - codex * 2) < 1e-9, `Fast should be 2× standard: ${fast} vs ${codex * 2}`)
  })

  test('零 token → 0(不把免费模型抬成 1 分再换成 USD)', () => {
    assert.equal(
      estimatePlatformCostUsd(
        { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        TERRA,
      ),
      0,
    )
  })
})

describe('resolveDelegateCostUsd — engine-reported delegate 结果', () => {
  test('codex / grok / cursor 有 token、引擎 cost=0 时补出 cost_usd > 0', async () => {
    _setPlatformPricingLookupForTests(async (model) => PRICES[model] ?? null)
    for (const model of ['gpt-5.6-terra', 'grok-build', 'cursor-grok-4.6-high'] as const) {
      const cost = await resolveDelegateCostUsd({
        totalCostUSD: 0,
        totalInputTokens: 97_419,
        totalOutputTokens: 8_532,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        model,
      })
      assert.ok(cost != null && cost > 0, `${model} delegate cost_usd should be > 0, got ${cost}`)
    }
  })

  test('CCB 已累计的 vendor USD 不覆盖', async () => {
    _setPlatformPricingLookupForTests(async () => TERRA)
    const cost = await resolveDelegateCostUsd({
      totalCostUSD: 0.3538614,
      totalInputTokens: 58_817,
      totalOutputTokens: 5_924,
      model: 'glm-5.3-zai',
    })
    assert.equal(cost, 0.3538614)
  })

  test('查不到单价 → 保持 0/null,不编造', async () => {
    _setPlatformPricingLookupForTests(async () => null)
    const cost = await resolveDelegateCostUsd({
      totalCostUSD: 0,
      totalInputTokens: 10,
      totalOutputTokens: 2,
      model: 'cursor-auto',
    })
    assert.equal(cost, null)
  })
})

describe('applyPlatformCostIfMissing', () => {
  test('写入 usage.cost 并返回本轮 USD', async () => {
    _setPlatformPricingLookupForTests(async () => TERRA)
    const usage = { cost: 0, inputTokens: 1_000_000, outputTokens: 0 }
    const filled = await applyPlatformCostIfMissing({
      model: 'gpt-5.6-terra',
      usage,
      sessionCostUsd: 0,
      prevCostUsd: 0,
    })
    assert.ok(filled != null && filled > 0)
    assert.equal(usage.cost, filled)
  })

  test('引擎已报 cost > 0 不改', async () => {
    _setPlatformPricingLookupForTests(async () => TERRA)
    const usage = { cost: 0.02, inputTokens: 3, outputTokens: 2 }
    const filled = await applyPlatformCostIfMissing({
      model: 'gpt-5.6-terra',
      usage,
      sessionCostUsd: 0.02,
      prevCostUsd: 0,
    })
    assert.equal(filled, null)
    assert.equal(usage.cost, 0.02)
  })
})
