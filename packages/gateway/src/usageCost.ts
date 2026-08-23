/**
 * Engine-reported / external 底座(codex / grok / cursor / zcode)的 result 帧
 * 不带 USD 成本(codex 的 total_cost_usd 恒 0;grok/cursor 适配器写死 cost:0)。
 * 真扣费走 billing 侧信道 + master computeCost。taskboard / usage_log / delegate
 * 返回值抄的是 session.totalCostUSD,所以这些引擎会 token 有数、钱是 0。
 *
 * 这里用 catalog 下发的 model_pricing(含 xN / Fast multiplier)走同一份
 * computeCostFen,再按 0223 汇率换成 USD 填回去。CCB 已有 vendor USD 时不覆盖。
 */

import { composeMultiplier, computeCostFen, fenToUsd, type TurnWaiveReason } from '@openclaude/protocol'
import {
  getModelCatalogClient,
  lookupCatalogAgentMultiplier,
  type LocalCatalogPricing,
  type LocalCatalogView,
} from './modelCatalogClient.js'

export interface UsageCostTokens {
  cost?: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  /**
   * 补算因缺 agent_cost_overrides 倍率无法对齐结算。
   * 为 true 时禁止把 catalog 基础价写入 cost(fail-closed)。
   */
  costImprecise?: boolean
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
let testCatalogView: LocalCatalogView | null = null

export function _setPlatformPricingLookupForTests(fn: PricingLookup | null): void {
  testLookup = fn
}

/** 测试注入一份已 parse 的 catalog 投影,用来验倍率字段在/不在的区分。 */
export function _setCatalogViewForTests(view: LocalCatalogView | null): void {
  testCatalogView = view
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
 *
 * 零输出免单 / terminal waiver:商业结算扣 0,这里也不得改写。
 *
 * agent 倍率必须来自 master catalog 的 `agent_cost_overrides` 字段(或测试显式传入)。
 * 核心区分:
 *   - 字段在(哪怕是空字典)且该 agent 无行 → 按 "1.000" 正常补价
 *   - 压根没拿到该字段(旧 LKG / 旧 master / catalog 不可达)→ fail-closed
 *     保持 0 + costImprecise,禁止拿 1.000 蒙过去
 */
export async function applyPlatformCostIfMissing(args: {
  model?: string
  usage: UsageCostTokens
  sessionCostUsd: number
  prevCostUsd: number
  waiveReason?: TurnWaiveReason
  /** session.agentId / delegate 目标 agent。用来查 catalog 倍率。 */
  agentId?: string
  /** 测试 / 显式覆盖。生产路径应走 catalog + agentId。 */
  agentMultiplier?: string | null
}): Promise<number | null> {
  if ((args.usage.cost ?? 0) > 0) return null
  if (args.sessionCostUsd !== args.prevCostUsd) return null
  if (args.waiveReason) return null
  const tokenTotal = usageTokenTotal(args.usage)
  if (tokenTotal <= 0) return null
  // 零输出免单:正 input/cache + output=0,与 proxy 扣 0 / waiveReason=no_response 对齐。
  if (args.usage.outputTokens === 0) return null
  const model = args.model?.trim()
  if (!model) return null
  const agentMul = await resolveAgentMultiplier(args.agentMultiplier, args.agentId)
  if (!agentMul) {
    // 没拿到 master 的倍率字段,或没有 agent 身份。不得默认 1.000。
    args.usage.costImprecise = true
    return null
  }
  const pricing = await lookupPlatformPricing(model)
  if (!pricing) return null
  const usd = estimatePlatformCostUsd(args.usage, {
    ...pricing,
    multiplier: composeMultiplier(pricing.multiplier, agentMul),
  })
  if (!(usd > 0)) return null
  args.usage.cost = usd
  return usd
}

/**
 * 显式传入的 agentMultiplier 优先(单测)。否则用 agentId 查 catalog:
 * lookupCatalogAgentMultiplier 在「字段缺席」时返回 null,在「字段在、无 override」时返回 "1.000"。
 */
async function resolveAgentMultiplier(
  explicit: string | null | undefined,
  agentId: string | undefined,
): Promise<string | null> {
  const trimmed = explicit?.trim()
  if (trimmed) return trimmed
  const id = agentId?.trim()
  if (!id) return null
  if (testCatalogView) return lookupCatalogAgentMultiplier(testCatalogView, id)
  const client = getModelCatalogClient()
  if (!client.configured) return null
  try {
    return await client.lookupAgentCostMultiplier(id)
  } catch {
    return null
  }
}

export interface DelegateCostSource {
  totalCostUSD: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens?: number
  totalCacheCreationTokens?: number
  model?: string
  agentId?: string
  agentMultiplier?: string | null
}

export interface ResolvedDelegateCost {
  costUsd: number | null
  costImprecise: boolean
}

/** delegate 返回给 taskboard 的 costUsd:优先用 session 已累计,否则按平台价补。 */
export async function resolveDelegateCostUsd(session: DelegateCostSource): Promise<ResolvedDelegateCost> {
  if (session.totalCostUSD > 0) {
    return { costUsd: session.totalCostUSD, costImprecise: false }
  }
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
    agentId: session.agentId,
    agentMultiplier: session.agentMultiplier,
  })
  if (filled != null && filled > 0) {
    return { costUsd: filled, costImprecise: false }
  }
  return {
    costUsd: session.totalCostUSD || null,
    costImprecise: usage.costImprecise === true,
  }
}
