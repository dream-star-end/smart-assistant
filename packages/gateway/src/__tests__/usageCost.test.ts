/**
 * 锁死:codex / grok / cursor 引擎的 delegate 结果在有 token 时 cost_usd > 0。
 * 定价走 protocol computeCostFen(model_pricing + multiplier),不另写价格表。
 *
 * 跑法:npx tsx --test packages/gateway/src/__tests__/usageCost.test.ts
 */

import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { ENGINE_BACKFILL_STRATEGIES, resolveBackfillPolicy } from '../costBackfillPolicy.js'
import {
  AGENT_COST_OVERRIDE_TTL_MS,
  ModelCatalogClient,
  _setModelCatalogClientForTests,
  parseCatalogResponse,
} from '../modelCatalogClient.js'
import {
  _setCatalogViewForTests,
  _setPlatformPricingLookupForTests,
  applyPlatformCostIfMissing,
  estimatePlatformCostUsd,
  resolveDelegateCostUsd,
  type PlatformPricing,
  type UsageCostTokens,
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
  _setCatalogViewForTests(null)
  _setModelCatalogClientForTests(null)
})

function catalogView(overrides?: Record<string, string>) {
  return parseCatalogResponse({
    models: [
      {
        model_id: 'gpt-5.6-terra',
        display_name: 'Terra',
        engine: 'codex',
        provider_id: 'codex',
        context_window: null,
        supported_efforts: ['high'],
        supports_vision: false,
        capability_zero: false,
        supports_thinking: false,
        default_effort: null,
        input_per_mtok: '150',
        output_per_mtok: '899',
        cache_read_per_mtok: '15',
        cache_write_per_mtok: '0',
        multiplier: '1.000',
      },
    ],
    projection_revision: 'proj-cost',
    security_epoch: '1',
    ...(overrides !== undefined ? { agent_cost_overrides: overrides } : {}),
  })
}

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
    const engines = {
      'gpt-5.6-terra': 'codex',
      'grok-build': 'grok',
      'cursor-grok-4.6-high': 'cursor',
    } as const
    for (const model of ['gpt-5.6-terra', 'grok-build', 'cursor-grok-4.6-high'] as const) {
      const cost = await resolveDelegateCostUsd({
        totalCostUSD: 0,
        totalInputTokens: 97_419,
        totalOutputTokens: 8_532,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        model,
        agentMultiplier: '1.000',
        engine: engines[model],
        isError: false,
      })
      assert.ok(
        cost.costUsd != null && cost.costUsd > 0,
        `${model} delegate cost_usd should be > 0, got ${cost.costUsd}`,
      )
      assert.equal(cost.costImprecise, true)
    }
  })

  test('缺 agentMultiplier 时不补 catalog 基础价(与结算不对齐)', async () => {
    _setPlatformPricingLookupForTests(async () => TERRA)
    const cost = await resolveDelegateCostUsd({
      totalCostUSD: 0,
      totalInputTokens: 97_419,
      totalOutputTokens: 8_532,
      model: 'gpt-5.6-terra',
      engine: 'codex',
      isError: false,
    })
    assert.equal(cost.costUsd, null)
    assert.equal(cost.costImprecise, true)
  })

  test('CCB 已累计的 vendor USD 不覆盖', async () => {
    _setPlatformPricingLookupForTests(async () => TERRA)
    const cost = await resolveDelegateCostUsd({
      totalCostUSD: 0.3538614,
      totalInputTokens: 58_817,
      totalOutputTokens: 5_924,
      model: 'glm-5.3-zai',
    })
    assert.equal(cost.costUsd, 0.3538614)
    assert.equal(cost.costImprecise, false)
  })

  test('resumable aggregate keeps an earlier imprecise turn sticky', async () => {
    const cost = await resolveDelegateCostUsd({
      totalCostUSD: 0.3538614,
      totalInputTokens: 58_817,
      totalOutputTokens: 5_924,
      model: 'glm-5.3-zai',
      costImprecise: true,
    })
    assert.equal(cost.costUsd, 0.3538614)
    assert.equal(cost.costImprecise, true)
  })

  test('查不到单价 → 保持 0/null,不编造', async () => {
    _setPlatformPricingLookupForTests(async () => null)
    const cost = await resolveDelegateCostUsd({
      totalCostUSD: 0,
      totalInputTokens: 10,
      totalOutputTokens: 2,
      model: 'cursor-auto',
      agentMultiplier: '1.000',
      engine: 'cursor',
      isError: false,
    })
    assert.equal(cost.costUsd, null)
    assert.equal(cost.costImprecise, true)
  })
})

describe('applyPlatformCostIfMissing', () => {
  test('写入 usage.cost 并返回本轮 USD', async () => {
    _setPlatformPricingLookupForTests(async () => TERRA)
    const usage = { cost: 0, inputTokens: 1_000_000, outputTokens: 1_000 }
    const filled = await applyPlatformCostIfMissing({
      model: 'gpt-5.6-terra',
      usage,
      sessionCostUsd: 0,
      prevCostUsd: 0,
      agentMultiplier: '1.000',
      engine: 'codex',
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

  // blocker 1 回归:零输出免单已被前段标 waiveReason=no_response,补价不得改写 cost。
  // 显式传入 agentMultiplier=1.000,把「缺倍率 fail-closed」从本用例里摘干净,
  // 只锁零输出 / terminal waiver。
  test('blocker1: 正 input/cache + outputTokens=0 不得补价(零输出免单)', async () => {
    _setPlatformPricingLookupForTests(async () => TERRA)
    const usage = {
      cost: 0,
      inputTokens: 30_875,
      outputTokens: 0,
      cacheReadTokens: 128,
      cacheCreationTokens: 0,
    }
    const filled = await applyPlatformCostIfMissing({
      model: 'gpt-5.6-terra',
      usage,
      sessionCostUsd: 0,
      prevCostUsd: 0,
      agentMultiplier: '1.000',
    })
    assert.equal(filled, null, `zero-output waiver must not fill, got ${filled}`)
    assert.equal(usage.cost, 0)
  })

  test('blocker1: terminal waiveReason 即使有 output 也不得补价', async () => {
    _setPlatformPricingLookupForTests(async () => TERRA)
    const usage = { cost: 0, inputTokens: 1_000, outputTokens: 40 }
    const filled = await applyPlatformCostIfMissing({
      model: 'gpt-5.6-terra',
      usage,
      sessionCostUsd: 0,
      prevCostUsd: 0,
      agentMultiplier: '1.000',
      waiveReason: 'no_response',
    })
    assert.equal(filled, null, `terminal waiver must not fill, got ${filled}`)
    assert.equal(usage.cost, 0)
  })

  // blocker 2 回归:catalog 只有 model multiplier。缺 agent 倍率时补算值必然
  // 低于结算(model×agent),禁止把偏低的数写入 usage.cost。
  test('blocker2: 缺 agentMultiplier 不得写入 catalog 基础价,并标记不精确', async () => {
    _setPlatformPricingLookupForTests(async () => TERRA)
    const usage: UsageCostTokens = { cost: 0, inputTokens: 1_000_000, outputTokens: 1_000 }
    const filled = await applyPlatformCostIfMissing({
      model: 'gpt-5.6-terra',
      usage,
      sessionCostUsd: 0,
      prevCostUsd: 0,
      engine: 'codex',
    })
    assert.equal(filled, null, `must fail-closed without agent multiplier, got ${filled}`)
    assert.equal(usage.cost, 0, 'must not write the known-low catalog-only estimate')
    assert.equal(usage.costImprecise, true)
  })

  test('blocker2: agentMultiplier=1.500 必须走 bigint compose,不得只乘 model multiplier', async () => {
    _setPlatformPricingLookupForTests(async () => TERRA)
    const tokens = { inputTokens: 1_000_000, outputTokens: 1_000, cacheReadTokens: 0, cacheCreationTokens: 0 }
    const baseUsage: UsageCostTokens = { cost: 0, ...tokens }
    const mulUsage: UsageCostTokens = { cost: 0, ...tokens }
    const base = await applyPlatformCostIfMissing({
      model: 'gpt-5.6-terra',
      usage: baseUsage,
      sessionCostUsd: 0,
      prevCostUsd: 0,
      agentMultiplier: '1.000',
      engine: 'codex',
    })
    const mul = await applyPlatformCostIfMissing({
      model: 'gpt-5.6-terra',
      usage: mulUsage,
      sessionCostUsd: 0,
      prevCostUsd: 0,
      agentMultiplier: '1.500',
      engine: 'codex',
    })
    const modelOnly = estimatePlatformCostUsd(tokens, TERRA)
    const expected = estimatePlatformCostUsd(tokens, { ...TERRA, multiplier: '1.500' })
    assert.equal(base, modelOnly)
    assert.equal(mul, expected)
    assert.ok(mul !== modelOnly, '1.500 must not silently record the catalog base price')
    assert.equal(mulUsage.costImprecise, undefined)
  })

  test('blocker2: compose 截断与 commercial 同口径(1.234×1.234=1.522)', async () => {
    _setPlatformPricingLookupForTests(async () => ({ ...TERRA, multiplier: '1.234' }))
    const usage = { cost: 0, inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
    // 本用例只锁 compose 截断,给正 output 以免撞上零输出免单。
    usage.outputTokens = 1
    const filled = await applyPlatformCostIfMissing({
      model: 'gpt-5.6-terra',
      usage,
      sessionCostUsd: 0,
      prevCostUsd: 0,
      agentMultiplier: '1.234',
      engine: 'codex',
    })
    const expected = estimatePlatformCostUsd(
      { inputTokens: 1_000_000, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      { ...TERRA, multiplier: '1.522' },
    )
    assert.ok(filled != null)
    assert.equal(filled, expected)
  })

  test('master 下发了倍率字段 + agent 有 1.500 override → 按复合倍率补价', async () => {
    _setPlatformPricingLookupForTests(async () => TERRA)
    _setCatalogViewForTests(catalogView({ 'coding-assistant': '1.500' }))
    const usage: UsageCostTokens = { cost: 0, inputTokens: 1_000_000, outputTokens: 1_000 }
    const filled = await applyPlatformCostIfMissing({
      model: 'gpt-5.6-terra',
      usage,
      sessionCostUsd: 0,
      prevCostUsd: 0,
      agentId: 'coding-assistant',
      engine: 'codex',
    })
    const expected = estimatePlatformCostUsd(
      { inputTokens: 1_000_000, outputTokens: 1_000, cacheReadTokens: 0, cacheCreationTokens: 0 },
      { ...TERRA, multiplier: '1.500' },
    )
    assert.equal(filled, expected)
    assert.equal(usage.costImprecise, undefined)
  })

  test('master 下发了倍率字段 + agent 无 override → 按 1.000 正常补价(不是 fail-closed)', async () => {
    _setPlatformPricingLookupForTests(async () => TERRA)
    _setCatalogViewForTests(catalogView({}))
    const usage: UsageCostTokens = { cost: 0, inputTokens: 1_000_000, outputTokens: 1_000 }
    const filled = await applyPlatformCostIfMissing({
      model: 'gpt-5.6-terra',
      usage,
      sessionCostUsd: 0,
      prevCostUsd: 0,
      agentId: 'coding-assistant',
      engine: 'codex',
    })
    const expected = estimatePlatformCostUsd(
      { inputTokens: 1_000_000, outputTokens: 1_000, cacheReadTokens: 0, cacheCreationTokens: 0 },
      TERRA,
    )
    assert.ok(filled != null && filled > 0, `empty overrides must still price, got ${filled}`)
    assert.equal(filled, expected)
    assert.equal(usage.costImprecise, undefined)
  })

  test('没拿到倍率字段 → 保持 0 且 costImprecise=true', async () => {
    _setPlatformPricingLookupForTests(async () => TERRA)
    _setCatalogViewForTests(catalogView())
    const usage: UsageCostTokens = { cost: 0, inputTokens: 1_000_000, outputTokens: 1_000 }
    const filled = await applyPlatformCostIfMissing({
      model: 'gpt-5.6-terra',
      usage,
      sessionCostUsd: 0,
      prevCostUsd: 0,
      agentId: 'coding-assistant',
      engine: 'codex',
    })
    assert.equal(filled, null)
    assert.equal(usage.cost, 0)
    assert.equal(usage.costImprecise, true)
  })
})

describe('resolveBackfillPolicy — 显式引擎策略 / fail-closed', () => {
  const tokens = { cost: 0, inputTokens: 1_000, outputTokens: 40 }

  test('未知引擎 → 默认 fail-closed', () => {
    const decision = resolveBackfillPolicy({
      engine: 'new-vendor',
      usage: tokens,
      sessionCostUsd: 0,
      prevCostUsd: 0,
    })
    assert.equal(decision.ok, false)
    if (decision.ok) throw new Error('expected fail-closed')
    assert.equal(decision.reason, 'engine_unknown:new-vendor')
    assert.equal(decision.markImprecise, true)
  })

  test('缺 engine → fail-closed,不得默认补', () => {
    const decision = resolveBackfillPolicy({
      usage: tokens,
      sessionCostUsd: 0,
      prevCostUsd: 0,
    })
    assert.equal(decision.ok, false)
    if (decision.ok) throw new Error('expected fail-closed')
    assert.equal(decision.reason, 'engine_missing')
  })

  test('策略表:codex/grok 复合;cursor/zcode 不复合;ccb 不补', () => {
    assert.deepEqual(ENGINE_BACKFILL_STRATEGIES.codex, {
      allowBackfill: true,
      composeAgentMultiplier: true,
      chargeOnlyOnSuccess: false,
    })
    assert.deepEqual(ENGINE_BACKFILL_STRATEGIES.grok, {
      allowBackfill: true,
      composeAgentMultiplier: true,
      chargeOnlyOnSuccess: false,
    })
    assert.deepEqual(ENGINE_BACKFILL_STRATEGIES.cursor, {
      allowBackfill: true,
      composeAgentMultiplier: false,
      chargeOnlyOnSuccess: true,
    })
    assert.deepEqual(ENGINE_BACKFILL_STRATEGIES.zcode, {
      allowBackfill: true,
      composeAgentMultiplier: false,
      chargeOnlyOnSuccess: true,
    })
    assert.equal(ENGINE_BACKFILL_STRATEGIES.ccb.allowBackfill, false)
  })
})

describe('applyPlatformCostIfMissing — 2026-08 关门审查 blocker', () => {
  test('blocker1: Cursor 错误终态 + 正 output token → 不补价、标 costImprecise', async () => {
    _setPlatformPricingLookupForTests(async () => CURSOR_GROK)
    const usage: UsageCostTokens = {
      cost: 0,
      inputTokens: 12_000,
      outputTokens: 800,
    }
    const filled = await applyPlatformCostIfMissing({
      model: 'cursor-grok-4.6-high',
      usage,
      sessionCostUsd: 0,
      prevCostUsd: 0,
      agentMultiplier: '1.000',
      engine: 'cursor',
      isError: true,
      terminalBillingStatus: 'error',
    })
    assert.equal(filled, null, `cursor error must not backfill, got ${filled}`)
    assert.equal(usage.cost, 0)
    assert.equal(usage.costImprecise, true)
    assert.equal(usage.costImpreciseReason, 'terminal_billing_not_success')
  })

  test('blocker1: Cursor isError=true 且无 billing status 也不得补', async () => {
    _setPlatformPricingLookupForTests(async () => CURSOR_GROK)
    const usage: UsageCostTokens = { cost: 0, inputTokens: 12_000, outputTokens: 800 }
    const filled = await applyPlatformCostIfMissing({
      model: 'cursor-grok-4.6-high',
      usage,
      sessionCostUsd: 0,
      prevCostUsd: 0,
      agentMultiplier: '1.000',
      engine: 'cursor',
      isError: true,
    })
    assert.equal(filled, null)
    assert.equal(usage.cost, 0)
    assert.equal(usage.costImprecise, true)
    assert.equal(usage.costImpreciseReason, 'turn_is_error')
  })

  test('blocker2: Cursor 成功 + agent override 1.500 → 不复合(与 cursorExternalSettle 一致)', async () => {
    _setPlatformPricingLookupForTests(async () => CURSOR_GROK)
    const tokens = {
      inputTokens: 1_000_000,
      outputTokens: 1_000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    }
    const usage: UsageCostTokens = { cost: 0, ...tokens }
    const filled = await applyPlatformCostIfMissing({
      model: 'cursor-grok-4.6-high',
      usage,
      sessionCostUsd: 0,
      prevCostUsd: 0,
      agentMultiplier: '1.500',
      engine: 'cursor',
      isError: false,
      terminalBillingStatus: 'success',
    })
    const modelOnly = estimatePlatformCostUsd(tokens, CURSOR_GROK)
    const composed = estimatePlatformCostUsd(tokens, { ...CURSOR_GROK, multiplier: '1.500' })
    assert.equal(filled, modelOnly)
    assert.ok(filled !== composed, 'cursor must not compose agent multiplier')
    assert.equal(usage.costImprecise, undefined)
  })

  test('blocker2: Codex 成功 + agent override 1.500 → 复合(与 durableCodexBilling 一致)', async () => {
    _setPlatformPricingLookupForTests(async () => TERRA)
    const tokens = {
      inputTokens: 1_000_000,
      outputTokens: 1_000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    }
    const usage: UsageCostTokens = { cost: 0, ...tokens }
    const filled = await applyPlatformCostIfMissing({
      model: 'gpt-5.6-terra',
      usage,
      sessionCostUsd: 0,
      prevCostUsd: 0,
      agentMultiplier: '1.500',
      engine: 'codex',
      isError: false,
    })
    const expected = estimatePlatformCostUsd(tokens, { ...TERRA, multiplier: '1.500' })
    assert.equal(filled, expected)
  })

  test('未知引擎 → 默认 fail-closed,保持 0 + costImprecise', async () => {
    _setPlatformPricingLookupForTests(async () => TERRA)
    const usage: UsageCostTokens = { cost: 0, inputTokens: 1_000_000, outputTokens: 1_000 }
    const filled = await applyPlatformCostIfMissing({
      model: 'gpt-5.6-terra',
      usage,
      sessionCostUsd: 0,
      prevCostUsd: 0,
      agentMultiplier: '1.000',
      engine: 'future-engine',
      isError: false,
    })
    assert.equal(filled, null)
    assert.equal(usage.cost, 0)
    assert.equal(usage.costImprecise, true)
    assert.equal(usage.costImpreciseReason, 'engine_unknown:future-engine')
  })

  test('blocker3: 倍率过期且刷新失败 → 不用陈旧值,保持 0 + costImprecise', async () => {
    _setPlatformPricingLookupForTests(async () => TERRA)
    let now = 1_000
    let catalogOk = true
    const body = {
      models: [
        {
          model_id: 'gpt-5.6-terra',
          display_name: 'Terra',
          engine: 'codex',
          provider_id: 'codex',
          context_window: null,
          supported_efforts: ['high'],
          supports_vision: false,
          capability_zero: false,
          supports_thinking: false,
          default_effort: null,
          input_per_mtok: '150',
          output_per_mtok: '899',
          cache_read_per_mtok: '15',
          cache_write_per_mtok: '0',
          multiplier: '1.000',
        },
      ],
      projection_revision: 'proj-ttl',
      security_epoch: '1',
      agent_cost_overrides: {},
    }
    const client = new ModelCatalogClient({
      env: {
        OPENCLAUDE_V3_MASTER_BASE_URL: 'http://master.invalid:18791',
        OPENCLAUDE_V3_CONTAINER_TOKEN: 'oc-v3.1.deadbeef',
      },
      lkgPath: '/tmp/oc-agent-mul-ttl-lkg.json',
      now: () => now,
      // biome-ignore lint/suspicious/noExplicitAny: 测试桩
      fetcher: (async () => {
        if (!catalogOk) throw new Error('ECONNREFUSED')
        return {
          statusCode: 200,
          body: (async function* () {
            yield Buffer.from(JSON.stringify(body), 'utf8')
          })(),
        }
      }) as any,
    })
    _setModelCatalogClientForTests(client)

    const firstUsage: UsageCostTokens = { cost: 0, inputTokens: 1_000_000, outputTokens: 1_000 }
    const first = await applyPlatformCostIfMissing({
      model: 'gpt-5.6-terra',
      usage: firstUsage,
      sessionCostUsd: 0,
      prevCostUsd: 0,
      agentId: 'coding-assistant',
      engine: 'codex',
    })
    const expectedFresh = estimatePlatformCostUsd(
      { inputTokens: 1_000_000, outputTokens: 1_000, cacheReadTokens: 0, cacheCreationTokens: 0 },
      TERRA,
    )
    assert.equal(first, expectedFresh, 'within TTL empty overrides still price at 1.000')

    now += AGENT_COST_OVERRIDE_TTL_MS + 1
    catalogOk = false
    const staleUsage: UsageCostTokens = { cost: 0, inputTokens: 1_000_000, outputTokens: 1_000 }
    const stale = await applyPlatformCostIfMissing({
      model: 'gpt-5.6-terra',
      usage: staleUsage,
      sessionCostUsd: 0,
      prevCostUsd: 0,
      agentId: 'coding-assistant',
      engine: 'codex',
    })
    assert.equal(stale, null, `expired refresh-fail must not reuse stale 1.000, got ${stale}`)
    assert.equal(staleUsage.cost, 0)
    assert.equal(staleUsage.costImprecise, true)
    assert.equal(staleUsage.costImpreciseReason, 'agent_multiplier_unavailable')
  })
})
