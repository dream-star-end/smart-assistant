/**
 * Hard-stop a turn once running platform cost reaches the remaining
 * spendable balance captured at admission.
 *
 * Master injects `_creditBudget` (fen, same unit as users.credits /
 * computeCostFen). Adapters compare incremental usage against that budget
 * and interrupt instead of draining the rest of an agentic loop after
 * the wallet hits zero.
 *
 * Missing pricing fails open (do not kill the turn). Admission still
 * rejects balance ≤ 0 before any engine work starts.
 */
import { composeMultiplier, computeCostFen } from '@openclaude/protocol'
import { getModelCatalogClient } from './modelCatalogClient.js'
import { lookupPlatformPricing } from './usageCost.js'

export const CREDIT_EXHAUSTED_DETAIL = 'INSUFFICIENT_CREDITS: credit budget exhausted'

export function parseCreditBudgetFen(raw: unknown): bigint | undefined {
  if (typeof raw === 'bigint') {
    return raw >= 0n ? raw : undefined
  }
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && Number.isSafeInteger(raw)) {
    return BigInt(raw)
  }
  if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw) || raw.length === 0 || raw.length > 32) {
    return undefined
  }
  try {
    return BigInt(raw)
  } catch {
    return undefined
  }
}

/** Abort when the running cost has consumed the remaining budget (including 0). */
export function shouldAbortForCreditBudget(runningFen: bigint, budgetFen: bigint): boolean {
  return runningFen >= 0n && budgetFen >= 0n && runningFen >= budgetFen
}

export async function runningCostFenForUsage(args: {
  modelId: string | undefined
  usage: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
  }
  agentId?: string
  /** Grok/Codex settlement composes agent_cost_overrides; Cursor does not. */
  composeAgentMultiplier?: boolean
}): Promise<bigint | null> {
  const modelId = args.modelId?.trim()
  if (!modelId) return null
  const pricing = await lookupPlatformPricing(modelId)
  if (!pricing) return null
  let multiplier = pricing.multiplier
  if (args.composeAgentMultiplier) {
    const agentMul = await lookupAgentMultiplier(args.agentId)
    if (!agentMul) return null
    try {
      multiplier = composeMultiplier(pricing.multiplier, agentMul)
    } catch {
      return null
    }
  }
  try {
    return computeCostFen(
      {
        input_tokens: args.usage.inputTokens,
        output_tokens: args.usage.outputTokens,
        cache_read_tokens: args.usage.cacheReadTokens ?? 0,
        cache_write_tokens: args.usage.cacheCreationTokens ?? 0,
      },
      {
        input_per_mtok: pricing.inputPerMtok,
        output_per_mtok: pricing.outputPerMtok,
        cache_read_per_mtok: pricing.cacheReadPerMtok,
        cache_write_per_mtok: pricing.cacheWritePerMtok,
        multiplier,
      },
    )
  } catch {
    return null
  }
}

async function lookupAgentMultiplier(agentId: string | undefined): Promise<string | null> {
  const id = agentId?.trim()
  if (!id) return null
  const client = getModelCatalogClient()
  if (!client.configured) return null
  try {
    // Override edits do not bump catalog epoch; getView() can reuse a stale
    // map. lookupAgentCostMultiplier() is the 60s-forced-refresh entry.
    return await client.lookupAgentCostMultiplier(id)
  } catch {
    return null
  }
}
