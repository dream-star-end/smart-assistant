/**
 * Engine-reported / external 底座(codex / grok / cursor / zcode)的 result 帧
 * 不带 USD 成本(codex 的 total_cost_usd 恒 0;grok/cursor 适配器写死 cost:0)。
 * 真扣费走 billing 侧信道 + master computeCost。taskboard / usage_log / delegate
 * 返回值抄的是 session.totalCostUSD,所以这些引擎会 token 有数、钱是 0。
 *
 * 这里用 catalog 下发的 model_pricing(含 xN / Fast multiplier)走同一份
 * computeCostFen,再按 0223 汇率换成 USD 填回去。CCB 已有 vendor USD 时不覆盖。
 */

import { computeCostFen, fenToUsd } from '@openclaude/protocol'
import {
  getModelCatalogClient,
  type LocalCatalogPricing,
} from './modelCatalogClient.js'

export interface UsageCostTokens {
  cost?: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
}

export interface PlatformPricing {
  inputPerMtok: string | number | bigint
  outputPerMtok: string | number | bigint
  cacheReadPerMtok: string | number | bigint
  cacheWritePerMtok: string | number | bigint
  multiplier: string
}

type PricingLookup = (modelId: string) => Promise<PlatformPricing | null>

let testLookup: PricingLookup | null = null

export function _setPlatformPricingLookupForTests(fn: PricingLookup | null): void {
  testLookup = fn
}

export function estimatePlatformCostUsd(
  usage: UsageCostTokens,
  pricing: PlatformPricing,
): number {
  const fen = computeCostFen(
    {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_read_tokens: usage.cacheReadTokens ?? 0,
      cache_write_tokens: usage.cacheCreationTokens ?? 0,
    },
    {
      input_per_mtok: pricing.inputPerMtok,
      output_per_mtok: pricing.outputPerMtok,
      cache_read_per_mtok: pricing.cacheReadPerMtok,
      cache_write_per_mtok: pricing.cacheWritePerMtok,
      multiplier: pricing.multiplier,
    },
  )
  return fenToUsd(fen)
}

function catalogPricingToPlatform(p: LocalCatalogPricing): PlatformPricing {
  return {
    inputPerMtok: p.inputPerMtok,
    outputPerMtok: p.outputPerMtok,
    cacheReadPerMtok: p.cacheReadPerMtok,
    cacheWritePerMtok: p.cacheWritePerMtok,
    multiplier: p.multiplier,
  }
}

export async function lookupPlatformPricing(modelId: string): Promise<PlatformPricing | null> {
  if (testLookup) return testLookup(modelId)
  if (!modelId) return null
  const client = getModelCatalogClient()
  if (!client.configured) return null
  try {
    const view = await client.getView()
    const canonical = view.canonicalize(modelId)
    const row = view.resolve(canonical)
    return row?.pricing ? catalogPricingToPlatform(row.pricing) : null
  } catch {
    return null
  }
}

function usageTokenTotal(usage: UsageCostTokens): number {
  return (
    (usage.inputTokens || 0) +
    (usage.outputTokens || 0) +
    (usage.cacheReadTokens || 0) +
    (usage.cacheCreationTokens || 0)
  )
}

/**
 * 引擎没报本轮成本、session 累计也没动,但有 token → 用平台价补 USD。
 * 返回补上的本轮 USD;无需补则 null。会写入 usage.cost。
 */
export async function applyPlatformCostIfMissing(args: {
  model?: string
  usage: UsageCostTokens
  sessionCostUsd: number
  prevCostUsd: number
}): Promise<number | null> {
  if ((args.usage.cost ?? 0) > 0) return null
  if (args.sessionCostUsd !== args.prevCostUsd) return null
  if (usageTokenTotal(args.usage) <= 0) return null
  const model = args.model?.trim()
  if (!model) return null
  const pricing = await lookupPlatformPricing(model)
  if (!pricing) return null
  const usd = estimatePlatformCostUsd(args.usage, pricing)
  if (!(usd > 0)) return null
  args.usage.cost = usd
  return usd
}

export interface DelegateCostSource {
  totalCostUSD: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens?: number
  totalCacheCreationTokens?: number
  model?: string
}

/** delegate 返回给 taskboard 的 costUsd:优先用 session 已累计,否则按平台价补。 */
export async function resolveDelegateCostUsd(session: DelegateCostSource): Promise<number | null> {
  if (session.totalCostUSD > 0) return session.totalCostUSD
  const usage: UsageCostTokens = {
    cost: session.totalCostUSD,
    inputTokens: session.totalInputTokens,
    outputTokens: session.totalOutputTokens,
    cacheReadTokens: session.totalCacheReadTokens,
    cacheCreationTokens: session.totalCacheCreationTokens,
  }
  const filled = await applyPlatformCostIfMissing({
    model: session.model,
    usage,
    sessionCostUsd: session.totalCostUSD,
    prevCostUsd: session.totalCostUSD,
  })
  if (filled != null && filled > 0) return filled
  return session.totalCostUSD || null
}
