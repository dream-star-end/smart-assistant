import {
  codexServiceTierBillingMultiplier,
  resolveEffectiveTurnServiceTier,
  type ServiceTier,
} from '@openclaude/protocol'
import { composeMultiplier } from './agentMultiplier.js'
import type { ModelPricing } from './pricing.js'

export function extractInboundPromptText(frame: Record<string, unknown>): string {
  const c = frame.content
  if (typeof c === 'string') return c
  if (c && typeof c === 'object' && !Array.isArray(c)) {
    const t = (c as { text?: unknown }).text
    if (typeof t === 'string') return t
  }
  return ''
}

export function applyAdmittedServiceTierToFrame<T extends Record<string, unknown>>(
  frame: T,
  serviceTier: ServiceTier | null,
): T {
  const next: Record<string, unknown> = { ...frame }
  if (serviceTier !== null) next.serviceTier = serviceTier
  else Reflect.deleteProperty(next, 'serviceTier')
  return next as T
}

/**
 * Composes Codex speed-tier multiplier (`2×` Fast, `6×` Ultrafast on `gpt-6.2-sol*`)
 * onto `modelPricing` after the agent multiplier. Unsupported `(model, serviceTier)`,
 * read-only advisor turns, and gateways lacking speed-tier support normalize to `null` (`1×`).
 */
export function composeCodexTurnPricing(
  modelPricing: ModelPricing,
  agentMul: string,
  modelId: string,
  requestedServiceTier: unknown,
  opts?: {
    agentId?: string | null
    collabMode?: unknown
    advisorModel?: unknown
    text?: string | null
    gatewaySupportsSpeedTiers?: boolean
  },
): { pricing: ModelPricing; serviceTier: ServiceTier | null } {
  let multiplier = composeMultiplier(modelPricing.multiplier, agentMul)
  const serviceTier =
    opts?.gatewaySupportsSpeedTiers === false
      ? null
      : resolveEffectiveTurnServiceTier({
          model: modelId,
          serviceTier: requestedServiceTier,
          agentId: opts?.agentId,
          collabMode: opts?.collabMode,
          advisorModel: opts?.advisorModel,
          text: opts?.text,
        })
  const tierMul = codexServiceTierBillingMultiplier(modelId, serviceTier)
  if (tierMul) {
    multiplier = composeMultiplier(multiplier, tierMul)
  }
  return {
    pricing: {
      ...modelPricing,
      multiplier,
    },
    serviceTier: tierMul ? serviceTier : null,
  }
}

export type TakenOverJournalBilling = {
  state: string
  userId: string
  dispatchId: string | null
  attemptNo: number | null
  model: string | null
  serviceTier?: ServiceTier | null | 'invalid'
  billingPricing?: ModelPricing | null
  hasBillingPricing?: boolean
} | null

export type TakenOverCodexBillingResolution =
  | { kind: 'reuse'; serviceTier: ServiceTier | null; pricing: ModelPricing }
  | { kind: 'aborted' }
  | { kind: 'capability_mismatch' }
  | { kind: 'conflict' }

/**
 * Reuses the original immutable journal speed tier & pricing on durable takeover so
 * cross-bridge execution, live settlement, and disconnect recovery cannot diverge.
 */
export function resolveTakenOverCodexBilling(
  existing: TakenOverJournalBilling,
  expected: {
    userId: string
    dispatchId: string
    attemptNo: number
    model: string
    gatewaySupportsSpeedTiers: boolean
  },
  fallbackPricingForTier: (tier: ServiceTier | null) => ModelPricing,
): TakenOverCodexBillingResolution {
  if (!existing) return { kind: 'conflict' }
  if (existing.state === 'aborted') return { kind: 'aborted' }
  if (
    existing.state !== 'inflight' ||
    existing.userId !== expected.userId ||
    existing.dispatchId !== expected.dispatchId ||
    existing.attemptNo !== expected.attemptNo ||
    existing.model !== expected.model ||
    existing.serviceTier === 'invalid' ||
    (existing.hasBillingPricing && !existing.billingPricing)
  ) {
    return { kind: 'conflict' }
  }
  const tier = existing.serviceTier ?? null
  if (tier !== null && !expected.gatewaySupportsSpeedTiers) {
    return { kind: 'capability_mismatch' }
  }
  return {
    kind: 'reuse',
    serviceTier: tier,
    pricing: existing.billingPricing ?? fallbackPricingForTier(tier),
  }
}
