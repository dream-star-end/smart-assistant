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

export interface CreditBudgetUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
}

/**
 * Per-turn budget guard shared by every engine adapter. Adapters feed each
 * cumulative usage snapshot; the guard prices it and fires `onExhausted`
 * exactly once when the running cost reaches the admitted budget.
 *
 * - `budgetFen === undefined` (no master admission, e.g. selfhost without
 *   commercial, or a delegate/cron turn) → the guard is inert.
 * - Missing pricing → fail-open (never kills a turn on a catalog miss).
 * - Async pricing lookups are serialised through `isLive()` so a snapshot
 *   from a finished / superseded turn cannot abort the next one.
 */
export class CreditBudgetGuard {
  private exhausted = false
  private inflight = 0
  private pending: CreditBudgetUsage | null = null

  constructor(
    private readonly opts: {
      budgetFen: bigint | undefined
      modelId: () => string | undefined
      agentId?: string
      composeAgentMultiplier: boolean
      /** true while this turn is still the adapter's live turn. */
      isLive: () => boolean
      onExhausted: () => void
    },
  ) {}

  get active(): boolean {
    return this.opts.budgetFen !== undefined
  }

  get isExhausted(): boolean {
    return this.exhausted
  }

  /** Observe a cumulative usage snapshot; fire-and-forget. */
  observe(usage: CreditBudgetUsage): void {
    if (!this.active || this.exhausted) return
    // Coalesce bursts: one lookup in flight, latest snapshot wins.
    if (this.inflight > 0) {
      this.pending = usage
      return
    }
    void this.evaluate(usage)
  }

  private async evaluate(usage: CreditBudgetUsage): Promise<void> {
    const budget = this.opts.budgetFen
    if (budget === undefined) return
    this.inflight++
    try {
      const fen = await runningCostFenForUsage({
        modelId: this.opts.modelId(),
        usage,
        agentId: this.opts.agentId,
        composeAgentMultiplier: this.opts.composeAgentMultiplier,
      })
      if (this.exhausted || !this.opts.isLive()) return
      if (fen !== null && shouldAbortForCreditBudget(fen, budget)) {
        this.exhausted = true
        this.pending = null
        this.opts.onExhausted()
      }
    } finally {
      this.inflight--
      const next = this.pending
      this.pending = null
      if (next && !this.exhausted && this.opts.isLive()) void this.evaluate(next)
    }
  }
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
