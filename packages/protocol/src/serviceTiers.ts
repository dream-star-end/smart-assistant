/**
 * OCV5-434 / OCV5-798 — GPT service tiers (Fast & Ultrafast), turn-level, default standard.
 *
 * - OpenCode Go `/responses` (`opencode-gpt-6-luna`, `opencode-gpt-5.6-luna`): offers `fast`
 *   (`service_tier: "priority"`, billed at `2×`).
 * - Codex (`codex-app-server`, ChatGPT OAuth):
 *   - `fast` (`serviceTierForTurn: "priority"`, billed at `2×`): active local GPT-6 models
 *     (`gpt-6.2-astra`, `gpt-6.2-astra-1m`, `gpt-6.2-sol`, `gpt-6.2-sol-1m`, `gpt-6-luna`,
 *     `gpt-6-luna-1m`). Empirically verified ~1.6× streaming speedup even though upstream SSE
 *     echoes `service_tier: "default"`.
 *   - `ultrafast` (`serviceTierForTurn: "ultrafast"`, billed at `6×`): `gpt-6.2-sol` &
 *     `gpt-6.2-sol-1m` only (ChatGPT Pro $200 plan gate; empirically verified ~13× streaming
 *     throughput).
 *   - Remote Codex (`gpt-6-luna-remote`): closed RPC grammar does not expose speed tiers.
 *   - Explicit standard turns on any GPT-6 local Codex model still state `"default"` so a
 *     catalog default never applies unexpectedly.
 */
import { OPENCODE_GO_RESPONSES_MODELS } from './staticKeyProviders.js'

/** Hello attestation capability confirming gateway enforces per-turn Codex speed tiers safely. */
export const CODEX_SPEED_TIERS_CAPABILITY = 'codex-speed-tiers-v1'

export const SERVICE_TIERS = ['fast', 'ultrafast'] as const
export type ServiceTier = (typeof SERVICE_TIERS)[number]

export function isServiceTier(value: unknown): value is ServiceTier {
  return typeof value === 'string' && (SERVICE_TIERS as readonly string[]).includes(value)
}

/**
 * Codex engine (ChatGPT subscription) local GPT-6 ids whose catalog offers — or defaults to —
 * non-standard tiers. Explicit standard turns send `serviceTierForTurn: "default"`.
 */
export const CODEX_EXPLICIT_STANDARD_MODELS: ReadonlySet<string> = new Set([
  'gpt-6.2-astra',
  'gpt-6.2-astra-1m',
  'gpt-6.2-sol',
  'gpt-6.2-sol-1m',
  'gpt-6-astra',
  'gpt-6-astra-1m',
  'gpt-6.1-sol',
  'gpt-6.1-sol-1m',
  'gpt-6-luna',
  'gpt-6-luna-1m',
])

/** Active local Codex GPT-6 ids that support Fast (`priority`, 2×). Excludes remote & retired ids. */
export const CODEX_FAST_MODELS: ReadonlySet<string> = new Set([
  'gpt-6.2-astra',
  'gpt-6.2-astra-1m',
  'gpt-6.2-sol',
  'gpt-6.2-sol-1m',
  'gpt-6-luna',
  'gpt-6-luna-1m',
])

/** Local Codex ids that support Ultrafast (`ultrafast`, 6×). Pro $200 grants Ultrafast to 6.2-Sol only. */
export const CODEX_ULTRAFAST_MODELS: ReadonlySet<string> = new Set([
  'gpt-6.2-sol',
  'gpt-6.2-sol-1m',
])

/** OpenCode Go `/responses` canonical ids whose upstream accepts `service_tier: "priority"`. */
export const OPENCODE_GO_FAST_MODELS: ReadonlySet<string> = new Set([
  'opencode-gpt-6-luna',
  'opencode-gpt-5.6-luna',
])

/** The upstream ids (lowercase) of OPENCODE_GO_FAST_MODELS, for the proxy after catalog resolution. */
const OPENCODE_GO_FAST_UPSTREAMS: ReadonlySet<string> = new Set(
  [...OPENCODE_GO_FAST_MODELS]
    .map((id) => OPENCODE_GO_RESPONSES_MODELS[id]?.toLowerCase())
    .filter((id): id is string => typeof id === 'string'),
)

export function isOpenCodeGoFastUpstream(upstreamModel: string): boolean {
  return OPENCODE_GO_FAST_UPSTREAMS.has(upstreamModel.toLowerCase())
}

export type FastServiceTierRoute = 'opencode-responses' | 'codex-app-server'

export function fastServiceTierRoute(
  modelId: string | null | undefined,
): FastServiceTierRoute | null {
  if (!modelId) return null
  if (OPENCODE_GO_FAST_MODELS.has(modelId)) return 'opencode-responses'
  if (CODEX_FAST_MODELS.has(modelId)) return 'codex-app-server'
  return null
}

export function supportsFastServiceTier(modelId: string | null | undefined): boolean {
  return fastServiceTierRoute(modelId) !== null
}

export function supportsUltrafastServiceTier(modelId: string | null | undefined): boolean {
  return typeof modelId === 'string' && CODEX_ULTRAFAST_MODELS.has(modelId)
}

export function supportedServiceTiers(modelId: string | null | undefined): readonly ServiceTier[] {
  if (supportsUltrafastServiceTier(modelId)) return ['fast', 'ultrafast']
  if (supportsFastServiceTier(modelId)) return ['fast']
  return []
}

export function supportsServiceTier(
  modelId: string | null | undefined,
  tier: ServiceTier | null | undefined,
): boolean {
  if (!tier) return false
  if (tier === 'ultrafast') return supportsUltrafastServiceTier(modelId)
  return supportsFastServiceTier(modelId)
}

/** Filters an arbitrary requested tier down to one supported by `modelId`; unsupported -> null (Standard). */
export function normalizeServiceTierForModel(
  modelId: string | null | undefined,
  tier: unknown,
): ServiceTier | null {
  if (!isServiceTier(tier)) return null
  return supportsServiceTier(modelId, tier) ? tier : null
}

/** The OpenAI request value for Fast on a Responses / Codex endpoint. */
export const OPENAI_FAST_SERVICE_TIER = 'priority'

/** Codex app-server wire value for Ultrafast. */
export const CODEX_ULTRAFAST_SERVICE_TIER = 'ultrafast'

/** Codex app-server's explicit standard tier id (catalog ids; "fast" would be ignored). */
export const CODEX_STANDARD_SERVICE_TIER = 'default'

/**
 * Billing multiplier composed onto a metered (OpenCode Go) request that ran with Fast:
 * OpenAI's published Fast rates are 2× Standard for GPT-6 Luna and GPT-5.6 Luna.
 */
export const OPENCODE_GO_FAST_BILLING_MULTIPLIER = '2.000'

/** Billing multipliers composed onto Codex turns running with Fast (2×) or Ultrafast (6×). */
export const CODEX_FAST_BILLING_MULTIPLIER = '2.000'
export const CODEX_ULTRAFAST_BILLING_MULTIPLIER = '6.000'

/** Numeric billing multiplier for a model's active speed tier (1 = Standard, 2 = Fast, 6 = Ultrafast). */
export function serviceTierBillingMultiplierNumber(
  modelId: string | null | undefined,
  tier: unknown,
): number {
  const normalized = normalizeServiceTierForModel(modelId, tier)
  if (normalized === 'ultrafast') return 6
  if (normalized === 'fast') return 2
  return 1
}

/** Returns the speed-tier billing multiplier for a Codex turn, or null for Standard / non-Codex. */
export function codexServiceTierBillingMultiplier(
  modelId: string | null | undefined,
  tier: unknown,
): string | null {
  if (fastServiceTierRoute(modelId) !== 'codex-app-server') return null
  const normalized = normalizeServiceTierForModel(modelId, tier)
  if (normalized === 'ultrafast') return CODEX_ULTRAFAST_BILLING_MULTIPLIER
  if (normalized === 'fast') return CODEX_FAST_BILLING_MULTIPLIER
  return null
}

/** Resolves the `serviceTierForTurn` parameter sent to `codex app-server`. */
export function codexTurnServiceTierValue(
  modelId: string | null | undefined,
  tier: unknown,
): string | undefined {
  if (fastServiceTierRoute(modelId) === 'codex-app-server') {
    const normalized = normalizeServiceTierForModel(modelId, tier)
    if (normalized === 'ultrafast') return CODEX_ULTRAFAST_SERVICE_TIER
    if (normalized === 'fast') return OPENAI_FAST_SERVICE_TIER
  }
  if (modelId && CODEX_EXPLICIT_STANDARD_MODELS.has(modelId)) {
    return CODEX_STANDARD_SERVICE_TIER
  }
  return undefined
}
