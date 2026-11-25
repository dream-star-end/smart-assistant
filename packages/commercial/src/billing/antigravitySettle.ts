import {
  ANTIGRAVITY_AUX_UPSTREAM_MODELS,
  antigravityAllowedUpstreamModels,
  antigravityCanonicalModelForUpstream,
} from '@openclaude/protocol'
import { antigravityOwnerProtectedSql } from './antigravityRouteAuthority.js'
import { hasActiveAntigravityRelayRouteForRequest } from './antigravityRouteContext.js'
/**
 * Antigravity turn settlement (OCV5-415 P2).
 *
 * Usage is server-observed: the relay writes one antigravity_relay_usage row
 * per forwarded generate call (title generation, web_search, agent_monitoring
 * included) from the upstream usageMetadata. The container's own report is
 * never billed: the CLI omits auxiliary calls and its usage is cumulative
 * across a resumed conversation.
 *
 * Per-bucket attribution (strictly keyed on server-routed upstream_model,
 * never on untrusted client-declared request_type):
 *   - Primary calls (route model, plus legacy rows missing upstream_model):
 *     billed at the turn's catalog model pricing.
 *   - Auxiliary calls (ANTIGRAVITY_AUX_UPSTREAM_MODELS such as
 *     gemini-3.5-flash-lite, regardless of request_type): billed at the aux
 *     light-model rate (catalog row if present, else commercial-aligned
 *     flash-lite fallback, capped at primary pricing), combined with primary
 *     under a single ceiling. Client request_type='agent_monitoring' is
 *     recorded only as an observational count (`monitoring_calls`) in
 *     price_snapshot.antigravity_aux and never waives charges or budget.
 */
import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { COST_SCALE, type TokenUsage, computeCost, multiplierToScaled } from './calculator.js'

const CANONICAL_TURN_KEY_RE = /^[0-9a-f]{64}$/
function canonicalTurnKey(raw: string | null | undefined): string | null {
  return typeof raw === 'string' && CANONICAL_TURN_KEY_RE.test(raw) ? raw : null
}
import type { ModelPricing, PricingCache } from './pricing.js'
import { type SettleResult, settleUsageAndLedger } from './proxyBilling.js'
import { releaseInflight } from '../account-pool/policy/affinity.js'

export type AntigravityEngineStatus = 'success' | 'error' | 'unavailable'

/**
 * CLI-internal safety monitor requestType observed on aux flash-lite calls.
 * Used strictly for observational counters (`monitoring_calls`), never for
 * billing waivers or budget exemptions (client-supplied header/body metadata
 * is untrusted).
 */
export const ANTIGRAVITY_MONITORING_REQUEST_TYPE = 'agent_monitoring' as const

/**
 * Fallback commercial-aligned light-model rates for Antigravity auxiliary models
 * (gemini-3.5-flash-lite: ~$0.10/MTok input, ~$0.40/MTok output, ~$0.01/MTok cache read →
 * 20 / 80 / 1 / 0 fen/MTok at commercial 200 fen/USD input/output and 100 fen/USD cache read).
 * Used when model_pricing has no explicit row for the aux model. Each dimension is capped
 * at the route's primary pricing so an aux call can never exceed the primary model's rate.
 */
export const ANTIGRAVITY_AUX_FALLBACK_RATES = Object.freeze({
  model_id: 'antigravity-aux-flash-lite',
  display_name: 'Gemini Flash Lite (Antigravity Aux)',
  input_per_mtok: 20n,
  output_per_mtok: 80n,
  cache_read_per_mtok: 1n,
  cache_write_per_mtok: 0n,
})

const ANTIGRAVITY_AUX_PRICING_KEYS = [
  'antigravity-gemini-3.5-flash-lite',
  'gemini-3.5-flash-lite',
] as const

export interface AntigravityAuxPricing {
  model_id: string
  display_name: string
  input_per_mtok: bigint
  output_per_mtok: bigint
  cache_read_per_mtok: bigint
  cache_write_per_mtok: bigint
  multiplier: string
  source: 'catalog' | 'fallback'
}

export interface AntigravityUsageBucket {
  promptTokens: bigint
  candidatesTokens: bigint
  thoughtsTokens: bigint
  cachedTokens: bigint
  calls: number
  /** Observational subset of aux calls labeled request_type='agent_monitoring' (no billing effect). */
  monitoringCalls?: number
}

export class MissingAntigravityModelPricingError extends Error {
  readonly modelId: string
  constructor(modelId: string) {
    super(`missing pricing for Antigravity swarm member model: ${modelId}`)
    this.name = 'MissingAntigravityModelPricingError'
    this.modelId = modelId
  }
}

export interface AntigravityUsageTotals {
  /** Primary (route model) tokens — and legacy rows lacking upstream_model. */
  promptTokens: bigint
  candidatesTokens: bigint
  thoughtsTokens: bigint
  cachedTokens: bigint
  /** Total relay calls across all buckets (primary + aux + extraModels). */
  calls: number
  /** Server-observed HTTP 200 retirement banner on the primary route model, persisted as relay status 410. */
  retired?: boolean
  /** Auxiliary-model calls (ANTIGRAVITY_AUX_UPSTREAM_MODELS, billed at light-model rate). */
  aux?: AntigravityUsageBucket
  /** Per-model billable buckets for local native swarm members using a different built-in Antigravity model (OCV5-879). */
  extraModels?: Record<string, AntigravityUsageBucket>
  /** Observational count of HTTP 410 retirement-banner calls on extra swarm member models (never waives primary delivery, never charged). */
  retiredExtraModels?: Record<string, number>
}

export const EMPTY_ANTIGRAVITY_USAGE: AntigravityUsageTotals = Object.freeze({
  promptTokens: 0n,
  candidatesTokens: 0n,
  thoughtsTokens: 0n,
  cachedTokens: 0n,
  calls: 0,
})

/** True when upstreamModel is one of the CLI's auxiliary light models (e.g. gemini-3.5-flash-lite). */
export function isAntigravityAuxUpstreamModel(upstreamModel: string | null | undefined): boolean {
  return (
    typeof upstreamModel === 'string' &&
    upstreamModel.length > 0 &&
    (ANTIGRAVITY_AUX_UPSTREAM_MODELS as readonly string[]).includes(upstreamModel)
  )
}

export type AntigravityBillableTarget =
  | { bucket: 'primary'; modelId: string }
  | { bucket: 'aux'; modelId: 'aux' }
  | { bucket: 'model'; modelId: string }

/**
 * Resolve which billing & cooldown bucket a forwarded Antigravity generate call
 * belongs to, strictly from server-observed `(routeModelId, upstreamModel)`.
 */
export function resolveAntigravityBillableTarget(
  routeModelId: string,
  upstreamModel: string | null | undefined,
): AntigravityBillableTarget {
  if (isAntigravityAuxUpstreamModel(upstreamModel)) {
    return { bucket: 'aux', modelId: 'aux' }
  }
  if (!upstreamModel || antigravityAllowedUpstreamModels(routeModelId).includes(upstreamModel)) {
    return { bucket: 'primary', modelId: routeModelId }
  }
  const canonical = antigravityCanonicalModelForUpstream(upstreamModel)
  if (canonical) {
    return canonical === routeModelId
      ? { bucket: 'primary', modelId: routeModelId }
      : { bucket: 'model', modelId: canonical }
  }
  return { bucket: 'primary', modelId: routeModelId }
}

/** True iff every billable extra member model present in `totals` has authoritative pricing. */
export function hasAllAntigravityExtraPricing(
  totals: AntigravityUsageTotals,
  pricingLookup?: Pick<PricingCache, 'get'> | null,
): boolean {
  if (!totals.extraModels) return true
  for (const [modelId, bucket] of Object.entries(totals.extraModels)) {
    if (!bucket || bucket.calls <= 0) continue
    const found = pricingLookup?.get(modelId) ?? null
    if (found === null) return false
  }
  return true
}

function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b
}

export function resolveAntigravityAuxPricing(
  primaryPricing: ModelPricing,
  pricingLookup?: Pick<PricingCache, 'get'> | null,
): AntigravityAuxPricing {
  let catalogMatch: ModelPricing | null = null
  let frozenFallbackMatch: ModelPricing | null = null
  if (pricingLookup) {
    const frozenFallback = pricingLookup.get(ANTIGRAVITY_AUX_FALLBACK_RATES.model_id)
    if (
      frozenFallback !== null &&
      frozenFallback.model_id === ANTIGRAVITY_AUX_FALLBACK_RATES.model_id
    ) {
      frozenFallbackMatch = frozenFallback
    } else {
      for (const key of ANTIGRAVITY_AUX_PRICING_KEYS) {
        const found = pricingLookup.get(key)
        // Require exact model_id match so wildcard stubs or alias fallbacks
        // never misidentify the primary model's row as aux pricing.
        if (found !== null && found.model_id === key) {
          catalogMatch = found
          break
        }
      }
    }
  }
  const base = frozenFallbackMatch ?? catalogMatch ?? ANTIGRAVITY_AUX_FALLBACK_RATES
  return {
    model_id: base.model_id,
    display_name: base.display_name,
    input_per_mtok: minBigInt(base.input_per_mtok, primaryPricing.input_per_mtok),
    output_per_mtok: minBigInt(base.output_per_mtok, primaryPricing.output_per_mtok),
    cache_read_per_mtok: minBigInt(base.cache_read_per_mtok, primaryPricing.cache_read_per_mtok),
    cache_write_per_mtok: minBigInt(base.cache_write_per_mtok, primaryPricing.cache_write_per_mtok),
    multiplier: primaryPricing.multiplier,
    source: catalogMatch ? 'catalog' : 'fallback',
  }
}

/**
 * Gemini usageMetadata → platform tokens. promptTokenCount includes the
 * cached part; thoughts are billed as output (as the upstream does).
 */
export function mapAntigravityUsage(
  totals: Pick<
    AntigravityUsageBucket,
    'promptTokens' | 'candidatesTokens' | 'thoughtsTokens' | 'cachedTokens'
  >,
): TokenUsage {
  const cached =
    totals.cachedTokens < totals.promptTokens ? totals.cachedTokens : totals.promptTokens
  return {
    input_tokens: totals.promptTokens - cached,
    output_tokens: totals.candidatesTokens + totals.thoughtsTokens,
    cache_read_tokens: cached,
    cache_write_tokens: 0n,
  }
}

export async function sumAntigravityRelayUsage(
  pool: Pick<Pool, 'query'>,
  requestId: string,
  userId: bigint,
  options?: { excludeRetired?: boolean },
): Promise<AntigravityUsageTotals> {
  const excludeRetiredSql = options?.excludeRetired ? ' AND status_code <> 410' : ''
  const res = await pool.query<{
    bucket?: string | null
    route_model_id?: string | null
    upstream_model?: string | null
    prompt: string | null
    candidates: string | null
    thoughts: string | null
    cached: string | null
    billable_prompt?: string | null
    billable_candidates?: string | null
    billable_thoughts?: string | null
    billable_cached?: string | null
    calls: string
    billable_calls?: string | null
    retired_calls?: string | null
    monitoring_calls?: string | null
    retired: boolean | null
  }>(
    `SELECT route_model_id,
            COALESCE(upstream_model, '') AS upstream_model,
            SUM(prompt_tokens)::text AS prompt, SUM(candidates_tokens)::text AS candidates,
            SUM(thoughts_tokens)::text AS thoughts, SUM(cached_tokens)::text AS cached,
            COALESCE(SUM(prompt_tokens) FILTER (WHERE status_code <> 410), 0)::text AS billable_prompt,
            COALESCE(SUM(candidates_tokens) FILTER (WHERE status_code <> 410), 0)::text AS billable_candidates,
            COALESCE(SUM(thoughts_tokens) FILTER (WHERE status_code <> 410), 0)::text AS billable_thoughts,
            COALESCE(SUM(cached_tokens) FILTER (WHERE status_code <> 410), 0)::text AS billable_cached,
            COUNT(*)::text AS calls,
            COUNT(*) FILTER (WHERE status_code <> 410)::text AS billable_calls,
            COUNT(*) FILTER (WHERE status_code = 410)::text AS retired_calls,
            COUNT(*) FILTER (WHERE COALESCE(request_type, '') = $3)::text AS monitoring_calls,
            BOOL_OR(status_code = 410) AS retired
       FROM antigravity_relay_usage WHERE request_id = $1 AND user_id = $2${excludeRetiredSql}
      GROUP BY 1, 2`,
    [
      requestId,
      userId.toString(),
      ANTIGRAVITY_MONITORING_REQUEST_TYPE,
    ],
  )
  if (res.rows.length === 0) return { ...EMPTY_ANTIGRAVITY_USAGE }
  const totals: AntigravityUsageTotals = {
    promptTokens: 0n,
    candidatesTokens: 0n,
    thoughtsTokens: 0n,
    cachedTokens: 0n,
    calls: 0,
    retired: false,
  }
  for (const row of res.rows) {
    const prompt = BigInt(row.prompt ?? '0')
    const candidates = BigInt(row.candidates ?? '0')
    const thoughts = BigInt(row.thoughts ?? '0')
    const cached = BigInt(row.cached ?? '0')
    const calls = Number(row.calls ?? '0')
    const monitoringCalls = Number(row.monitoring_calls ?? '0')
    totals.calls += calls
    const target: AntigravityBillableTarget =
      row.upstream_model === undefined && row.bucket !== undefined
        ? row.bucket === 'aux'
          ? { bucket: 'aux', modelId: 'aux' }
          : { bucket: 'primary', modelId: row.route_model_id ?? '' }
        : resolveAntigravityBillableTarget(row.route_model_id ?? '', row.upstream_model)
    if (target.bucket === 'aux') {
      if (row.retired === true) totals.retired = true
      const prev = totals.aux
      const nextMonitoringCalls = (prev?.monitoringCalls ?? 0) + monitoringCalls
      totals.aux = {
        promptTokens: (prev?.promptTokens ?? 0n) + prompt,
        candidatesTokens: (prev?.candidatesTokens ?? 0n) + candidates,
        thoughtsTokens: (prev?.thoughtsTokens ?? 0n) + thoughts,
        cachedTokens: (prev?.cachedTokens ?? 0n) + cached,
        calls: (prev?.calls ?? 0) + calls,
        ...(nextMonitoringCalls > 0 ? { monitoringCalls: nextMonitoringCalls } : {}),
      }
    } else if (target.bucket === 'model') {
      const retiredCalls =
        row.retired_calls !== undefined && row.retired_calls !== null
          ? Number(row.retired_calls)
          : row.retired === true
            ? calls
            : 0
      const billableCalls =
        row.billable_calls !== undefined && row.billable_calls !== null
          ? Number(row.billable_calls)
          : Math.max(0, calls - retiredCalls)
      const billablePrompt =
        row.billable_prompt !== undefined && row.billable_prompt !== null
          ? BigInt(row.billable_prompt)
          : row.retired === true && billableCalls === 0
            ? 0n
            : prompt
      const billableCandidates =
        row.billable_candidates !== undefined && row.billable_candidates !== null
          ? BigInt(row.billable_candidates)
          : row.retired === true && billableCalls === 0
            ? 0n
            : candidates
      const billableThoughts =
        row.billable_thoughts !== undefined && row.billable_thoughts !== null
          ? BigInt(row.billable_thoughts)
          : row.retired === true && billableCalls === 0
            ? 0n
            : thoughts
      const billableCached =
        row.billable_cached !== undefined && row.billable_cached !== null
          ? BigInt(row.billable_cached)
          : row.retired === true && billableCalls === 0
            ? 0n
            : cached
      if (retiredCalls > 0) {
        if (!totals.retiredExtraModels) totals.retiredExtraModels = {}
        totals.retiredExtraModels[target.modelId] =
          (totals.retiredExtraModels[target.modelId] ?? 0) + retiredCalls
      }
      if (billableCalls > 0) {
        if (!totals.extraModels) totals.extraModels = {}
        const prev = totals.extraModels[target.modelId]
        totals.extraModels[target.modelId] = {
          promptTokens: (prev?.promptTokens ?? 0n) + billablePrompt,
          candidatesTokens: (prev?.candidatesTokens ?? 0n) + billableCandidates,
          thoughtsTokens: (prev?.thoughtsTokens ?? 0n) + billableThoughts,
          cachedTokens: (prev?.cachedTokens ?? 0n) + billableCached,
          calls: (prev?.calls ?? 0) + billableCalls,
        }
      }
    } else {
      if (row.retired === true) totals.retired = true
      totals.promptTokens += prompt
      totals.candidatesTokens += candidates
      totals.thoughtsTokens += thoughts
      totals.cachedTokens += cached
    }
  }
  return totals
}

function scaledTokenCost(
  usage: TokenUsage,
  pricing: Pick<
    ModelPricing,
    'input_per_mtok' | 'output_per_mtok' | 'cache_read_per_mtok' | 'cache_write_per_mtok' | 'multiplier'
  >,
): bigint {
  const mul = multiplierToScaled(pricing.multiplier)
  return (
    BigInt(usage.input_tokens) * pricing.input_per_mtok * mul +
    BigInt(usage.output_tokens) * pricing.output_per_mtok * mul +
    BigInt(usage.cache_read_tokens) * pricing.cache_read_per_mtok * mul +
    BigInt(usage.cache_write_tokens) * pricing.cache_write_per_mtok * mul
  )
}

function ceilScaledCredits(scaled: bigint): bigint {
  return scaled === 0n ? 0n : (scaled + COST_SCALE - 1n) / COST_SCALE
}

function computeAntigravityBreakdown(
  totals: AntigravityUsageTotals,
  pricing: ModelPricing,
  pricingLookup?: Pick<PricingCache, 'get'> | null,
) {
  const primaryUsage = mapAntigravityUsage(totals)
  const auxUsage = totals.aux && totals.aux.calls > 0 ? mapAntigravityUsage(totals.aux) : null
  const auxPricing = auxUsage ? resolveAntigravityAuxPricing(pricing, pricingLookup) : null
  const primaryScaled = scaledTokenCost(primaryUsage, pricing)
  const auxScaled = auxUsage && auxPricing ? scaledTokenCost(auxUsage, auxPricing) : 0n
  let extraScaled = 0n
  let extraCalls = 0
  let extraInputTokens = 0n
  let extraOutputTokens = 0n
  let extraCacheReadTokens = 0n
  const extraModels: Array<{
    modelId: string
    calls: number
    usage: TokenUsage
    costCredits: bigint
    pricing: ModelPricing
  }> = []
  if (totals.extraModels) {
    for (const modelId of Object.keys(totals.extraModels).sort()) {
      const bucket = totals.extraModels[modelId]
      if (!bucket || bucket.calls <= 0) continue
      const lookedUp = pricingLookup?.get(modelId) ?? null
      if (lookedUp === null) {
        throw new MissingAntigravityModelPricingError(modelId)
      }
      const usage = mapAntigravityUsage(bucket)
      const scaled = scaledTokenCost(usage, lookedUp)
      extraScaled += scaled
      extraCalls += bucket.calls
      extraInputTokens += BigInt(usage.input_tokens)
      extraOutputTokens += BigInt(usage.output_tokens)
      extraCacheReadTokens += BigInt(usage.cache_read_tokens)
      extraModels.push({
        modelId,
        calls: bucket.calls,
        usage,
        costCredits: ceilScaledCredits(scaled),
        pricing: lookedUp,
      })
    }
  }
  let retiredExtraCalls = 0
  if (totals.retiredExtraModels) {
    for (const n of Object.values(totals.retiredExtraModels)) {
      if (typeof n === 'number' && n > 0) retiredExtraCalls += n
    }
  }
  const totalScaled = primaryScaled + auxScaled + extraScaled
  const costCredits = ceilScaledCredits(totalScaled)
  const hasSecondary = Boolean(auxUsage) || extraModels.length > 0
  const billableUsage: TokenUsage = hasSecondary
    ? {
        input_tokens:
          BigInt(primaryUsage.input_tokens) +
          BigInt(auxUsage?.input_tokens ?? 0n) +
          extraInputTokens,
        output_tokens:
          BigInt(primaryUsage.output_tokens) +
          BigInt(auxUsage?.output_tokens ?? 0n) +
          extraOutputTokens,
        cache_read_tokens:
          BigInt(primaryUsage.cache_read_tokens) +
          BigInt(auxUsage?.cache_read_tokens ?? 0n) +
          extraCacheReadTokens,
        cache_write_tokens: 0n,
      }
    : primaryUsage
  return {
    primaryUsage,
    auxUsage,
    auxPricing,
    extraModels,
    extraCalls,
    retiredExtraCalls,
    extraOutputTokens,
    primaryCostCredits: ceilScaledCredits(primaryScaled),
    auxCostCredits: ceilScaledCredits(auxScaled),
    costCredits,
    billableUsage,
  }
}

export function antigravityUsageCostOrNull(
  totals: AntigravityUsageTotals,
  pricing: ModelPricing,
  pricingLookup?: Pick<PricingCache, 'get'> | null,
): bigint | null {
  if (!hasAllAntigravityExtraPricing(totals, pricingLookup)) return null
  return computeAntigravityBreakdown(totals, pricing, pricingLookup).costCredits
}

export function antigravityUsageCost(
  totals: AntigravityUsageTotals,
  pricing: ModelPricing,
  pricingLookup?: Pick<PricingCache, 'get'> | null,
): bigint {
  return computeAntigravityBreakdown(totals, pricing, pricingLookup).costCredits
}

export function planAntigravitySettle(args: {
  engineStatus: AntigravityEngineStatus
  totals: AntigravityUsageTotals
  pricing: ModelPricing
  pricingLookup?: Pick<PricingCache, 'get'> | null
  terminalCode?: string | null
}): {
  settleStatus: 'success' | 'error'
  costCredits: bigint
  snapshotJson: string
  usage: TokenUsage
} {
  const breakdown = computeAntigravityBreakdown(args.totals, args.pricing, args.pricingLookup)
  const { snapshot } = computeCost(breakdown.primaryUsage, args.pricing)
  const cost_credits = breakdown.costCredits
  const usage = breakdown.billableUsage
  const effectiveStatus = args.totals.retired ? 'error' : args.engineStatus
  const engineOk = effectiveStatus === 'success'
  const primaryCalls = Math.max(
    0,
    args.totals.calls - (args.totals.aux?.calls ?? 0) - breakdown.extraCalls - breakdown.retiredExtraCalls,
  )
  const nonAuxCalls = primaryCalls + breakdown.extraCalls
  const nonAuxOutputTokens = BigInt(breakdown.primaryUsage.output_tokens) + breakdown.extraOutputTokens
  const hasOutput =
    nonAuxCalls > 0 ? nonAuxOutputTokens > 0n : BigInt(usage.output_tokens) > 0n
  const waivedNoOutput = engineOk && !hasOutput && cost_credits > 0n
  const costCredits = engineOk && !waivedNoOutput ? cost_credits : 0n
  const hasBreakdown =
    Boolean(breakdown.auxUsage) || breakdown.extraModels.length > 0 || breakdown.retiredExtraCalls > 0
  const monitoringCalls = args.totals.aux?.monitoringCalls ?? 0
  const snapshotJson = JSON.stringify({
    ...snapshot,
    antigravity_status: effectiveStatus,
    ...(args.totals.retired ? { antigravity_terminal_code: 'ANTIGRAVITY_MODEL_RETIRED' } : {}),
    antigravity_calls: args.totals.calls,
    ...(hasBreakdown
      ? {
          antigravity_primary: {
            calls: primaryCalls,
            input_tokens: BigInt(breakdown.primaryUsage.input_tokens).toString(),
            output_tokens: BigInt(breakdown.primaryUsage.output_tokens).toString(),
            cache_read_tokens: BigInt(breakdown.primaryUsage.cache_read_tokens).toString(),
            cost_credits: breakdown.primaryCostCredits.toString(),
          },
        }
      : {}),
    ...(breakdown.extraModels.length > 0
      ? {
          antigravity_models: Object.fromEntries(
            breakdown.extraModels.map((m) => [
              m.modelId,
              {
                calls: m.calls,
                input_tokens: BigInt(m.usage.input_tokens).toString(),
                output_tokens: BigInt(m.usage.output_tokens).toString(),
                cache_read_tokens: BigInt(m.usage.cache_read_tokens).toString(),
                cost_credits: m.costCredits.toString(),
                pricing: {
                  model_id: m.pricing.model_id,
                  input_per_mtok: m.pricing.input_per_mtok.toString(),
                  output_per_mtok: m.pricing.output_per_mtok.toString(),
                  cache_read_per_mtok: m.pricing.cache_read_per_mtok.toString(),
                  cache_write_per_mtok: m.pricing.cache_write_per_mtok.toString(),
                  multiplier: m.pricing.multiplier,
                  source: 'catalog',
                },
              },
            ]),
          ),
        }
      : {}),
    ...(breakdown.retiredExtraCalls > 0 && args.totals.retiredExtraModels
      ? { antigravity_retired_models: args.totals.retiredExtraModels }
      : {}),
    ...(breakdown.auxUsage && breakdown.auxPricing && args.totals.aux
      ? {
          antigravity_aux: {
            calls: args.totals.aux.calls,
            ...(monitoringCalls > 0 ? { monitoring_calls: monitoringCalls } : {}),
            input_tokens: BigInt(breakdown.auxUsage.input_tokens).toString(),
            output_tokens: BigInt(breakdown.auxUsage.output_tokens).toString(),
            cache_read_tokens: BigInt(breakdown.auxUsage.cache_read_tokens).toString(),
            cost_credits: breakdown.auxCostCredits.toString(),
            pricing: {
              model_id: breakdown.auxPricing.model_id,
              input_per_mtok: breakdown.auxPricing.input_per_mtok.toString(),
              output_per_mtok: breakdown.auxPricing.output_per_mtok.toString(),
              cache_read_per_mtok: breakdown.auxPricing.cache_read_per_mtok.toString(),
              cache_write_per_mtok: breakdown.auxPricing.cache_write_per_mtok.toString(),
              multiplier: breakdown.auxPricing.multiplier,
              source: breakdown.auxPricing.source,
            },
          },
        }
      : {}),
    ...(!args.totals.retired && args.terminalCode
      ? { antigravity_terminal_code: args.terminalCode }
      : {}),
    ...(waivedNoOutput ? { waived: 'no_output', wouldHaveCharged: cost_credits.toString() } : {}),
    ...(!engineOk && cost_credits > 0n
      ? { waived: 'antigravity_engine_not_success', wouldHaveCharged: cost_credits.toString() }
      : {}),
  })
  return { settleStatus: engineOk ? 'success' : 'error', costCredits, snapshotJson, usage }
}

export interface AntigravitySettleAttribution {
  delegateAgentId?: string
  parentSessionId?: string
  parentTurnKey?: string
}

export async function settleAntigravityTurn(args: {
  pool: Pool
  // OCV5-738 blocker 2: the delegate settle path must pass the journal's
  // frozen price snapshot, not the live cache, so `Pick<..,'get'>` is all
  // that is actually required (and all `refreshWaivedAntigravityUsage`
  // below already assumes).
  pricing: Pick<PricingCache, 'get'>
  userId: bigint
  requestId: string
  modelId: string
  sessionId: string | null
  engineStatus: AntigravityEngineStatus
  terminalCode?: string | null
  turnKey?: string | null
  parentTurnKey?: string | null
  dispatchId?: string | null
  attemptNo?: number | null
  /**
   * Delegate turn attribution (OCV5-738). Chat turns omit it and keep the
   * historical mode='chat' shape; a delegate turn must land mode='delegate'
   * like every other engine so spend reports are not silently mixed.
   */
  attribution?: AntigravitySettleAttribution | null
}): Promise<SettleResult | null> {
  const pricing = args.pricing.get(args.modelId)
  if (pricing === null) return null
  const totals = await sumAntigravityRelayUsage(args.pool, args.requestId, args.userId)
  if (!hasAllAntigravityExtraPricing(totals, args.pricing)) return null
  const plan = planAntigravitySettle({
    engineStatus: args.engineStatus,
    totals,
    pricing,
    pricingLookup: args.pricing,
    terminalCode: args.terminalCode ?? null,
  })
  const effectiveParentTurnKey = canonicalTurnKey(
    args.parentTurnKey ?? args.attribution?.parentTurnKey ?? null,
  )
  const settled = await settleUsageAndLedger(args.pool, {
    userId: args.userId,
    accountId: null,
    requestId: args.requestId,
    model: args.modelId,
    usage: plan.usage,
    snapshotJson: plan.snapshotJson,
    costCredits: plan.costCredits,
    status: plan.settleStatus,
    sessionId: args.sessionId,
    turnKey: canonicalTurnKey(args.turnKey),
    parentTurnKey: effectiveParentTurnKey,
    dispatchId: args.dispatchId ?? null,
    attemptNo: args.attemptNo ?? null,
    ...(args.attribution
      ? {
          mode: 'delegate' as const,
          parentSessionId: args.attribution.parentSessionId ?? null,
          delegateAgentId: args.attribution.delegateAgentId ?? null,
          parentTurnKey: effectiveParentTurnKey,
        }
      : {}),
  })
  // A call that recorded its row between the sum above and this write would
  // otherwise be missed: its relay refresh found no usage row to update yet.
  if (args.engineStatus !== 'success' || totals.retired) {
    await refreshWaivedAntigravityUsage({
      pool: args.pool,
      pricing: args.pricing,
      requestId: args.requestId,
      userId: args.userId,
    }).catch(() => {})
  }
  return settled
}

/**
 * A Stop ends the turn while a call is still streaming: the CLI drops the
 * relay socket, the relay keeps reading Google to the end and records the
 * call's row after the turn already settled (OCV5-451). Such a turn is waived,
 * so nothing is charged, but its usage row and `wouldHaveCharged` must still
 * cover every call. Recomputes the waived row from the full relay sum under a
 * row lock; idempotent, and a no-op for charged or still-running turns.
 * Returns true when the row changed.
 */
export async function refreshWaivedAntigravityUsage(args: {
  pool: Pool
  pricing: Pick<PricingCache, 'get'>
  requestId: string
  userId: bigint
}): Promise<boolean> {
  const client = await args.pool.connect()
  try {
    await client.query('BEGIN')
    const cur = await client.query<{
      id: string
      model: string
      snapshot: Record<string, unknown>
    }>(
      `SELECT id::text AS id, model, price_snapshot AS snapshot FROM usage_records
        WHERE user_id = $1 AND request_id = $2 AND cost_credits = 0 AND ledger_id IS NULL
          AND status = 'error' AND price_snapshot ? 'antigravity_status'
          AND price_snapshot->>'antigravity_status' <> 'success'
        FOR UPDATE`,
      [args.userId.toString(), args.requestId],
    )
    const row = cur.rows[0]
    const pricing = row ? args.pricing.get(row.model) : null
    if (!row || pricing === null) {
      await client.query('ROLLBACK')
      return false
    }
    const totals = await sumAntigravityRelayUsage(client, args.requestId, args.userId)
    if (!hasAllAntigravityExtraPricing(totals, args.pricing)) {
      await client.query('ROLLBACK')
      return false
    }
    if (totals.calls === Number(row.snapshot.antigravity_calls)) {
      await client.query('ROLLBACK')
      return false
    }
    const terminalCode = row.snapshot.antigravity_terminal_code
    const plan = planAntigravitySettle({
      engineStatus: row.snapshot.antigravity_status as AntigravityEngineStatus,
      totals,
      pricing,
      pricingLookup: args.pricing,
      terminalCode: typeof terminalCode === 'string' ? terminalCode : null,
    })
    await client.query(
      `UPDATE usage_records SET input_tokens = $2, output_tokens = $3, cache_read_tokens = $4,
              cache_write_tokens = $5, price_snapshot = $6::jsonb
        WHERE id = $1 AND cost_credits = 0`,
      [
        row.id,
        plan.usage.input_tokens.toString(),
        plan.usage.output_tokens.toString(),
        plan.usage.cache_read_tokens.toString(),
        plan.usage.cache_write_tokens.toString(),
        plan.snapshotJson,
      ],
    )
    await client.query('COMMIT')
    return true
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

// ─── Durable turn record (Codex r1 P1) ──────────────────────────────────────
// Settlement must not depend on the admitting bridge's memory: after a
// reconnect the terminal frame reaches a different bridge. Every admitted
// turn gets an antigravity_turns row; whichever bridge sees the terminal
// frame claims it by (request_id, user_id). Turns nobody reported are settled
// from relay usage on the user's next admission (no timer).

/** Minimum orphan age; live execution owners are excluded separately. */
export const ANTIGRAVITY_STALE_TURN_MS = 2 * 60 * 60 * 1000

export interface AntigravityTurnRecord {
  requestId: string
  userId: bigint
  modelId: string
  sessionId: string | null
  traceId: string | null
  turnKey?: string | null
  parentTurnKey?: string | null
  dispatchId?: string | null
  attemptNo?: number | null
}

export async function recordAntigravityTurn(
  pool: Pick<Pool, 'query'>,
  turn: AntigravityTurnRecord,
): Promise<{ inserted: boolean }> {
  const res = await pool.query<{ request_id: string }>(
    `INSERT INTO antigravity_turns (request_id, user_id, model_id, session_id, trace_id)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (request_id) DO NOTHING RETURNING request_id`,
    [turn.requestId, turn.userId.toString(), turn.modelId, turn.sessionId, turn.traceId],
  )
  const inserted = (res.rows?.length ?? 0) > 0 || (res.rowCount ?? 0) > 0
  return { inserted }
}

/** Admission failed after the row was written: nothing ran on the route. */
export async function abandonAntigravityTurn(
  pool: Pick<Pool, 'query'>,
  requestId: string,
  userId: bigint,
  expectedTraceId?: string | null,
): Promise<void> {
  if (typeof expectedTraceId === 'string' && expectedTraceId.length > 0) {
    await pool.query(
      `UPDATE antigravity_turns SET status = 'abandoned', updated_at = NOW()
        WHERE request_id = $1 AND user_id = $2 AND trace_id = $3 AND status = 'pending'
          AND NOT EXISTS (SELECT 1 FROM antigravity_relay_usage u WHERE u.request_id = $1 AND u.user_id = $2)`,
      [requestId, userId.toString(), expectedTraceId],
    )
    return
  }
  await pool.query(
    `UPDATE antigravity_turns SET status = 'abandoned', updated_at = NOW()
      WHERE request_id = $1 AND user_id = $2 AND status = 'pending'
        AND NOT EXISTS (SELECT 1 FROM antigravity_relay_usage u WHERE u.request_id = $1 AND u.user_id = $2)`,
    [requestId, userId.toString()],
  )
}

type SettledTurn = { settled: SettleResult; turn: AntigravityTurnRecord }

/**
 * Claim (pending → settling) and settle one turn. Returns null when another
 * bridge already claimed it, the row is unknown, or pricing is missing (the
 * row goes back to pending so a later pass retries).
 */
export async function settleAntigravityTurnRecord(args: {
  pool: Pool
  pricing: Pick<PricingCache, 'get'>
  requestId: string
  userId: bigint
  engineStatus: AntigravityEngineStatus | 'unknown'
  terminalCode?: string | null
  turnKey?: string | null
  parentTurnKey?: string | null
  dispatchId?: string | null
  attemptNo?: number | null
  /** Delegate attribution; omitted for chat turns (OCV5-738). */
  attribution?: AntigravitySettleAttribution | null
  /** Reconcile pass: also take over a 'settling' row abandoned by a crash. */
  staleBefore?: Date
}): Promise<SettledTurn | null> {
  // The turn is over: free its in-flight slot on the account (OCV5-424 per-account cap).
  if (!args.staleBefore) releaseInflight(args.requestId)
  // A reconcile pass ('unknown') never overwrites a terminal status a bridge
  // already persisted: an error turn whose first settle attempt failed must
  // stay free (Codex r2 P1).
  const claim = await args.pool.query<{
    model_id: string
    session_id: string | null
    trace_id: string | null
    engine_status: string
  }>(
    `UPDATE antigravity_turns SET status = 'settling',
            engine_status = CASE WHEN $3 = 'unknown' THEN COALESCE(engine_status, 'unknown') ELSE $3 END,
            updated_at = NOW()
      WHERE request_id = $1 AND user_id = $2
        AND (status = 'pending' OR ($4::timestamptz IS NOT NULL AND status = 'settling' AND updated_at < $4))
        AND ($4::timestamptz IS NULL OR (updated_at < $4
          AND NOT ${antigravityOwnerProtectedSql('antigravity_turns')}))
      RETURNING model_id, session_id, trace_id, engine_status`,
    [args.requestId, args.userId.toString(), args.engineStatus, args.staleBefore ?? null],
  )
  const row = claim.rows[0]
  if (!row) return null
  if (args.staleBefore) releaseInflight(args.requestId)

  // P1-01: An aborted delegate_antigravity journal is a permanent waiver decision;
  // never settle or debit it on orphan/reconcile/late passes — close the turn row.
  try {
    const delegateJournal = await args.pool.query<{ state: string }>(
      `SELECT state FROM request_finalize_journal
        WHERE request_id = $1 AND user_id = $2
          AND ctx->>'source' = 'delegate_antigravity'
        LIMIT 1`,
      [args.requestId, args.userId.toString()],
    )
    if (delegateJournal.rows[0]?.state === 'aborted') {
      await args.pool
        .query(
          "UPDATE antigravity_turns SET status = 'abandoned', updated_at = NOW() WHERE request_id = $1 AND user_id = $2",
          [args.requestId, args.userId.toString()],
        )
        .catch(() => {})
      return null
    }
  } catch (err) {
    const pgCode = (err as { code?: string } | null)?.code
    if (pgCode !== '42P01') {
      await args.pool
        .query("UPDATE antigravity_turns SET status = 'pending', updated_at = NOW() WHERE request_id = $1 AND user_id = $2", [
          args.requestId,
          args.userId.toString(),
        ])
        .catch(() => {})
      throw err
    }
  }

  let resolvedDispatchId = args.dispatchId ?? null
  let resolvedAttemptNo = args.attemptNo ?? null
  let resolvedTurnKey = canonicalTurnKey(args.turnKey)
  let inferredOutcome: 'completed' | 'interrupted' | 'crashed' | 'open_dispatch' | null = null
  try {
    const loc = await args.pool.query<{
      dispatch_id: string | null
      attempt_no: number | null
      dispatch_status: string | null
      dispatch_outcome: string | null
      authority_turn_key: string | null
      tape_turn_key: string | null
      tape_status: string | null
    }>(
      `SELECT d.dispatch_id::text AS dispatch_id,
              d.attempt_no,
              d.status AS dispatch_status,
              d.outcome AS dispatch_outcome,
              a.turn_key AS authority_turn_key,
              t.turn_key AS tape_turn_key,
              t.status AS tape_status
         FROM turn_dispatches d
         LEFT JOIN authority_turn_dispatches a
           ON a.dispatch_id = d.dispatch_id AND a.user_id = d.user_id AND a.attempt_no = d.attempt_no
         LEFT JOIN LATERAL (
           SELECT ct.turn_key, ct.status
             FROM client_session_turn_tapes ct
            WHERE ct.dispatch_id = d.dispatch_id AND ct.finalized_at IS NOT NULL
            ORDER BY ct.finalized_at ASC LIMIT 1
         ) t ON TRUE
        WHERE d.billing_request_id = $1 AND d.user_id = $2
        LIMIT 1`,
      [args.requestId, args.userId.toString()],
    )
    const lr = loc.rows[0]
    if (lr) {
      resolvedDispatchId ??= lr.dispatch_id
      resolvedAttemptNo ??= lr.attempt_no
      const serverTurnKey = canonicalTurnKey(lr.authority_turn_key) ?? canonicalTurnKey(lr.tape_turn_key)
      if (serverTurnKey) {
        resolvedTurnKey = serverTurnKey
      }
      if (lr.tape_status === 'interrupted' || lr.dispatch_outcome === 'interrupted') {
        inferredOutcome = 'interrupted'
      } else if (
        lr.tape_status === 'crashed' ||
        lr.dispatch_outcome === 'crashed' ||
        lr.dispatch_outcome === 'executed_error' ||
        lr.dispatch_outcome === 'not_accepted' ||
        lr.dispatch_outcome === 'rejected'
      ) {
        inferredOutcome = 'crashed'
      } else if (lr.tape_status === 'completed' || lr.dispatch_outcome === 'completed') {
        inferredOutcome = 'completed'
      } else if (lr.dispatch_status !== 'terminal') {
        inferredOutcome = 'open_dispatch'
      }
    }
  } catch (err) {
    // B2: Only ignore missing tables ('42P01') in minimal unit-test stubs; ANY other error
    // (including connection drops without a SQLSTATE `.code`) MUST reset pending and rethrow!
    const pgCode = (err as { code?: string } | null)?.code
    if (pgCode !== '42P01') {
      await args.pool
        .query("UPDATE antigravity_turns SET status = 'pending', updated_at = NOW() WHERE request_id = $1 AND user_id = $2", [
          args.requestId,
          args.userId.toString(),
        ])
        .catch(() => {})
      throw err
    }
  }

  const engineStatus = row.engine_status as AntigravityEngineStatus | 'unknown'
  if (engineStatus === 'unknown' && inferredOutcome === 'open_dispatch') {
    await args.pool
      .query("UPDATE antigravity_turns SET status = 'pending', updated_at = NOW() WHERE request_id = $1 AND user_id = $2", [
        args.requestId,
        args.userId.toString(),
      ])
      .catch(() => {})
    return null
  }
  const reconciled = args.engineStatus === 'unknown'
  const effectiveEngineStatus: AntigravityEngineStatus =
    engineStatus === 'unknown'
      ? inferredOutcome === 'interrupted' || inferredOutcome === 'crashed'
        ? 'error'
        : 'success'
      : engineStatus
  const effectiveTerminalCode: string | null =
    engineStatus === 'unknown'
      ? inferredOutcome === 'interrupted'
        ? 'USER_CANCELLED'
        : inferredOutcome === 'crashed'
          ? 'ENGINE_ERROR'
          : 'RECONCILED'
      : reconciled
        ? null
        : (args.terminalCode ?? null)
  const effectiveParentTurnKey = canonicalTurnKey(
    args.parentTurnKey ?? args.attribution?.parentTurnKey ?? null,
  )
  const turn: AntigravityTurnRecord = {
    requestId: args.requestId,
    userId: args.userId,
    modelId: row.model_id,
    sessionId: row.session_id,
    traceId: row.trace_id,
    ...(resolvedTurnKey ? { turnKey: resolvedTurnKey } : {}),
    ...(effectiveParentTurnKey ? { parentTurnKey: effectiveParentTurnKey } : {}),
    ...(resolvedDispatchId ? { dispatchId: resolvedDispatchId } : {}),
    ...(resolvedAttemptNo !== null ? { attemptNo: resolvedAttemptNo } : {}),
  }
  let settled: SettleResult | null = null
  try {
    settled = await settleAntigravityTurn({
      pool: args.pool,
      pricing: args.pricing,
      userId: args.userId,
      requestId: args.requestId,
      modelId: row.model_id,
      sessionId: row.session_id,
      engineStatus: effectiveEngineStatus,
      terminalCode: effectiveTerminalCode,
      turnKey: resolvedTurnKey,
      parentTurnKey: effectiveParentTurnKey,
      dispatchId: resolvedDispatchId,
      attemptNo: resolvedAttemptNo,
      attribution: args.attribution ?? null,
    })
  } finally {
    await args.pool
      .query(
        'UPDATE antigravity_turns SET status = $3, engine_status = CASE WHEN $4::text IS NOT NULL THEN $4 ELSE engine_status END, updated_at = NOW() WHERE request_id = $1 AND user_id = $2',
        [
          args.requestId,
          args.userId.toString(),
          settled === null ? 'pending' : 'settled',
          settled !== null && engineStatus === 'unknown' && effectiveEngineStatus === 'error'
            ? 'error'
            : null,
        ],
      )
      .catch(() => {})
  }
  return settled === null ? null : { settled, turn }
}

function parseFrozenModelPricingObj(
  modelId: string,
  raw: Record<string, unknown> | null | undefined,
): ModelPricing | null {
  if (!raw || typeof raw !== 'object') return null
  try {
    const inRate = BigInt(String(raw.input_per_mtok ?? ''))
    const outRate = BigInt(String(raw.output_per_mtok ?? ''))
    const cacheReadRate = BigInt(String(raw.cache_read_per_mtok ?? '0'))
    const cacheWriteRate = BigInt(String(raw.cache_write_per_mtok ?? '0'))
    const mult = typeof raw.multiplier === 'string' && raw.multiplier.trim() ? raw.multiplier : '1.000'
    if (inRate < 0n || outRate < 0n || cacheReadRate < 0n || cacheWriteRate < 0n) return null
    return {
      model_id: typeof raw.model_id === 'string' && raw.model_id ? raw.model_id : modelId,
      display_name: modelId,
      input_per_mtok: inRate,
      output_per_mtok: outRate,
      cache_read_per_mtok: cacheReadRate,
      cache_write_per_mtok: cacheWriteRate,
      multiplier: mult,
      enabled: true,
    } as ModelPricing
  } catch {
    return null
  }
}

/**
 * B4: Reconstruct frozen pricing (including composed delegate agent multiplier and
 * catalog rates at parent settlement time) from `parent.snapshot`, falling back to
 * `liveFallback` only for a brand-new extra/aux model never seen on the parent turn.
 */
function buildFrozenAntigravityPricingLookup(
  parentModelId: string,
  parentSnapshot: Record<string, unknown>,
  childSnapshots: readonly Record<string, unknown>[],
  liveFallback: Pick<PricingCache, 'get'>,
): { primary: ModelPricing | null; lookup: Pick<PricingCache, 'get'> } {
  const frozenMap = new Map<string, ModelPricing>()
  const primary = parseFrozenModelPricingObj(parentModelId, parentSnapshot) ?? liveFallback.get(parentModelId)
  if (primary) frozenMap.set(parentModelId, primary)

  const foldSnapshotModels = (snap: Record<string, unknown>): void => {
    const modelsObj = snap.antigravity_models
    if (modelsObj && typeof modelsObj === 'object' && !Array.isArray(modelsObj)) {
      for (const [mId, entry] of Object.entries(modelsObj as Record<string, unknown>)) {
        if (!frozenMap.has(mId) && entry && typeof entry === 'object' && !Array.isArray(entry)) {
          const p = parseFrozenModelPricingObj(
            mId,
            (entry as Record<string, unknown>).pricing as Record<string, unknown> | undefined,
          )
          if (p) frozenMap.set(mId, p)
        }
      }
    }
    const auxObj = snap.antigravity_aux
    if (auxObj && typeof auxObj === 'object' && !Array.isArray(auxObj)) {
      const auxPricingRaw = (auxObj as Record<string, unknown>).pricing as Record<string, unknown> | undefined
      const auxModelId = typeof auxPricingRaw?.model_id === 'string' ? auxPricingRaw.model_id : ''
      if (auxModelId) {
        const p = parseFrozenModelPricingObj(auxModelId, auxPricingRaw)
        if (p) {
          if (!frozenMap.has(auxModelId)) frozenMap.set(auxModelId, p)
          for (const key of ANTIGRAVITY_AUX_PRICING_KEYS) {
            if (!frozenMap.has(key)) frozenMap.set(key, { ...p, model_id: key })
          }
        }
      }
    }
  }

  foldSnapshotModels(parentSnapshot)
  for (const childSnap of childSnapshots) {
    foldSnapshotModels(childSnap)
  }

  return {
    primary,
    lookup: {
      get: (modelId: string) => frozenMap.get(modelId) ?? liveFallback.get(modelId),
    },
  }
}

function countRetiredExtraCalls(raw: unknown): number {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 0
  let sum = 0
  for (const v of Object.values(raw as Record<string, unknown>)) {
    const n = Number(v)
    if (Number.isFinite(n) && n > 0) sum += Math.trunc(n)
  }
  return sum
}

/**
 * Settle an incremental delta row when an orphaned in-flight worker stream finishes
 * recording in `antigravity_relay_usage` AFTER the parent turn already settled as
 * `status = 'success'` (OCV5-887).
 *
 * Preserves OCV5-451 (`refreshWaivedAntigravityUsage` never mutates the parent
 * charged row) and `turn_tape_cost_components` immutability per `request_id` by
 * writing an exact delta `usage_records` row keyed by CAS `sha256("${requestId}:late-from:${accountedCalls}")`.
 */
export async function settleLateAntigravityRelayUsage(args: {
  pool: Pool
  pricing: Pick<PricingCache, 'get'>
  requestId: string
  userId: bigint
  appendCostCredits?: (
    requestId: string,
    rawUserId: string,
    costCredits: string,
    sessionId?: string | null,
    parentSessionId?: string | null,
    delegateAgentId?: string | null,
    turnKey?: string | null,
    parentTurnKey?: string | null,
  ) => Promise<unknown>
}): Promise<boolean> {
  const uidStr = args.userId.toString()
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parentRes = await args.pool.query<{
      model: string
      session_id: string | null
      parent_session_id: string | null
      delegate_agent_id: string | null
      mode: string
      turn_key: string | null
      parent_turn_key: string | null
      dispatch_id: string | null
      attempt_no: number | null
      cost_credits: string
      input_tokens: string
      output_tokens: string
      cache_read_tokens: string
      snapshot: Record<string, unknown>
      created_at: Date
    }>(
      `SELECT model, session_id, parent_session_id, delegate_agent_id, mode,
              turn_key, parent_turn_key, dispatch_id::text AS dispatch_id, attempt_no,
              cost_credits::text, input_tokens::text, output_tokens::text, cache_read_tokens::text,
              price_snapshot AS snapshot, created_at
         FROM usage_records
        WHERE user_id = $1 AND request_id = $2
          AND status = 'success'
          AND price_snapshot ? 'antigravity_status'
          AND price_snapshot->>'antigravity_status' = 'success'
        LIMIT 1`,
      [uidStr, args.requestId],
    )
    const parent = parentRes.rows[0]
    if (!parent) return false

    const lateRes = await args.pool.query<{
      cost_credits: string
      input_tokens: string
      output_tokens: string
      cache_read_tokens: string
      snapshot: Record<string, unknown>
    }>(
      `SELECT cost_credits::text, input_tokens::text, output_tokens::text, cache_read_tokens::text,
              price_snapshot AS snapshot
         FROM usage_records
        WHERE user_id = $1
          AND created_at >= $2
          AND price_snapshot->>'antigravity_late_of' = $3
        ORDER BY created_at ASC`,
      [uidStr, parent.created_at, args.requestId],
    )

    const { primary: primaryPricing, lookup: frozenPricingLookup } =
      buildFrozenAntigravityPricingLookup(
        parent.model,
        parent.snapshot,
        lateRes.rows.map((r) => r.snapshot),
        args.pricing,
      )
    if (!primaryPricing) return false

    let accountedCalls = Math.max(
      0,
      Number(parent.snapshot.antigravity_calls ?? 0) -
        countRetiredExtraCalls(parent.snapshot.antigravity_retired_models),
    )
    // Keep the idempotency key watermark strictly monotonic even across pre-upgrade
    // child rows whose `antigravity_late_from_calls` included extra-model 410 calls.
    let keyWatermark = accountedCalls
    let accountedCredits = BigInt(parent.cost_credits)
    let accountedIn = BigInt(parent.input_tokens)
    let accountedOut = BigInt(parent.output_tokens)
    let accountedCache = BigInt(parent.cache_read_tokens)
    for (const child of lateRes.rows) {
      const childFrom = Number(child.snapshot.antigravity_late_from_calls ?? 0)
      const childDelta = Number(child.snapshot.antigravity_late_calls ?? 0)
      accountedCalls += childDelta
      if (Number.isFinite(childFrom) && Number.isFinite(childDelta)) {
        keyWatermark = Math.max(keyWatermark, childFrom + childDelta)
      }
      accountedCredits += BigInt(child.cost_credits)
      accountedIn += BigInt(child.input_tokens)
      accountedOut += BigInt(child.output_tokens)
      accountedCache += BigInt(child.cache_read_tokens)
    }
    keyWatermark = Math.max(keyWatermark, accountedCalls)

    const totals = await sumAntigravityRelayUsage(args.pool, args.requestId, args.userId, {
      excludeRetired: true,
    })
    if (totals.calls <= accountedCalls) return false
    if (!hasAllAntigravityExtraPricing(totals, frozenPricingLookup)) return false

    const fullPlan = planAntigravitySettle({
      engineStatus: 'success',
      totals,
      pricing: primaryPricing,
      pricingLookup: frozenPricingLookup,
    })
    const deltaCalls = totals.calls - accountedCalls
    const deltaCredits =
      fullPlan.costCredits > accountedCredits ? fullPlan.costCredits - accountedCredits : 0n
    const fullIn = BigInt(fullPlan.usage.input_tokens)
    const fullOut = BigInt(fullPlan.usage.output_tokens)
    const fullCache = BigInt(fullPlan.usage.cache_read_tokens)
    const deltaUsage: TokenUsage = {
      input_tokens: fullIn > accountedIn ? fullIn - accountedIn : 0n,
      output_tokens: fullOut > accountedOut ? fullOut - accountedOut : 0n,
      cache_read_tokens: fullCache > accountedCache ? fullCache - accountedCache : 0n,
      cache_write_tokens: 0n,
    }
    const lateRequestId = createHash('sha256')
      .update(`${args.requestId}:late-from:${keyWatermark}`, 'utf8')
      .digest('hex')
      .slice(0, 32)
    const lateSnapshotJson = JSON.stringify({
      ...(JSON.parse(fullPlan.snapshotJson) as Record<string, unknown>),
      antigravity_late_of: args.requestId,
      antigravity_late_from_calls: keyWatermark,
      antigravity_late_calls: deltaCalls,
    })

    let effectiveTurnKey = canonicalTurnKey(parent.turn_key)
    let effectiveParentTurnKey = canonicalTurnKey(parent.parent_turn_key)
    const settled = await settleUsageAndLedger(args.pool, {
      userId: args.userId,
      accountId: null,
      requestId: lateRequestId,
      model: parent.model,
      usage: deltaUsage,
      snapshotJson: lateSnapshotJson,
      costCredits: deltaCredits,
      status: 'success',
      sessionId: parent.session_id,
      ...(parent.mode === 'delegate'
        ? {
            mode: 'delegate' as const,
            parentSessionId: parent.parent_session_id,
            delegateAgentId: parent.delegate_agent_id,
          }
        : {}),
      turnKey: effectiveTurnKey,
      parentTurnKey: effectiveParentTurnKey,
      dispatchId: parent.dispatch_id,
      attemptNo: parent.attempt_no,
    })
    if (settled.commitDisposition === 'existing') {
      continue
    }
    // P1-06 store-load barrier: if parent turn_key/parent_turn_key was NULL when we read it
    // before INSERT, re-read parent AFTER late row commit so a concurrent tape attribution repair
    // that already finished scanning late rows cannot leave this late row keyless.
    if (!effectiveTurnKey || (parent.mode === 'delegate' && !effectiveParentTurnKey)) {
      const refreshedParent = await args.pool.query<{
        turn_key: string | null
        parent_turn_key: string | null
      }>(
        `SELECT turn_key, parent_turn_key FROM usage_records
          WHERE user_id = $1 AND request_id = $2 LIMIT 1`,
        [uidStr, args.requestId],
      )
      const rp = refreshedParent.rows[0]
      const freshTurnKey = canonicalTurnKey(rp?.turn_key)
      const freshParentTurnKey = canonicalTurnKey(rp?.parent_turn_key)
      if (freshTurnKey !== effectiveTurnKey || freshParentTurnKey !== effectiveParentTurnKey) {
        effectiveTurnKey = effectiveTurnKey ?? freshTurnKey
        effectiveParentTurnKey = effectiveParentTurnKey ?? freshParentTurnKey
        if (effectiveTurnKey || effectiveParentTurnKey) {
          await args.pool.query(
            `UPDATE usage_records
                SET turn_key = COALESCE(turn_key, $3),
                    parent_turn_key = COALESCE(parent_turn_key, $4)
              WHERE user_id = $1 AND request_id = $2`,
            [uidStr, lateRequestId, effectiveTurnKey, effectiveParentTurnKey],
          )
        }
      }
    }
    const persistCredits =
      settled.attributionCredits !== null && settled.attributionCredits !== undefined
        ? settled.attributionCredits
        : settled.debitedCredits !== null && settled.debitedCredits > 0n
          ? settled.debitedCredits
          : null
    if (persistCredits !== null && args.appendCostCredits) {
      await args
        .appendCostCredits(
          lateRequestId,
          uidStr,
          persistCredits.toString(),
          parent.session_id,
          parent.parent_session_id,
          parent.delegate_agent_id,
          effectiveTurnKey,
          effectiveParentTurnKey,
        )
        .catch(() => {})
    }
    return true
  }
  return false
}

/** Settle this user's turns that never got a terminal frame. Best-effort, bounded. */
export async function reconcileStaleAntigravityTurns(args: {
  pool: Pool
  pricing: PricingCache
  userId: bigint
  now?: number
  limit?: number
}): Promise<SettledTurn[]> {
  const now = args.now ?? Date.now()
  const staleBefore = new Date(now - ANTIGRAVITY_STALE_TURN_MS)
  const due = await args.pool.query<{ request_id: string; has_durable_owner: boolean }>(
    `SELECT request_id,
            (EXISTS (
               SELECT 1 FROM turn_dispatches d
                WHERE d.billing_request_id = antigravity_turns.request_id
                  AND d.user_id = antigravity_turns.user_id
             ) OR EXISTS (
               SELECT 1 FROM request_finalize_journal j
                WHERE j.request_id = antigravity_turns.request_id
                  AND j.user_id = antigravity_turns.user_id
             )) AS has_durable_owner
       FROM antigravity_turns
      WHERE user_id = $1 AND status IN ('pending','settling') AND updated_at < $2
        AND NOT ${antigravityOwnerProtectedSql('antigravity_turns')}
      ORDER BY created_at LIMIT $3`,
    [args.userId.toString(), staleBefore, args.limit ?? 5],
  )
  const out: SettledTurn[] = []
  for (const { request_id, has_durable_owner } of due.rows) {
    if (!has_durable_owner && (await hasActiveAntigravityRelayRouteForRequest(request_id, args.userId, now))) {
      continue
    }
    const done = await settleAntigravityTurnRecord({
      pool: args.pool,
      pricing: args.pricing,
      requestId: request_id,
      userId: args.userId,
      engineStatus: 'unknown',
      staleBefore,
    })
    if (done) out.push(done)
  }
  return out
}
