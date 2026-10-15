/**
 * OCV5-434 — GPT "Fast" service tier (OpenAI priority processing), turn-level, default off.
 *
 * Upstream semantics (2026-10): OpenAI renamed priority processing to Fast mode;
 * `service_tier: "fast"` and `"priority"` are the same tier (≈2× API price, up to ~2.5× speed).
 *  - Codex (ChatGPT subscription): app-server `turn/start.serviceTierForTurn` — `"fast"` or
 *    `"default"` (explicit standard). Fast spends the plan's limits at 2.5×; no credits.
 *  - OpenCode Go `/responses`: the request carries `service_tier: "priority"`; upstream echoes
 *    neither tier nor price, so we bill the published Fast multiplier.
 * Only models that documented Fast support AND are wired here get the toggle; everything else
 * silently ignores the field.
 */
import { OPENCODE_GO_RESPONSES_MODELS } from './staticKeyProviders.js'

export const SERVICE_TIERS = ['fast'] as const
export type ServiceTier = (typeof SERVICE_TIERS)[number]

export function isServiceTier(value: unknown): value is ServiceTier {
  return typeof value === 'string' && (SERVICE_TIERS as readonly string[]).includes(value)
}

/** Codex engine (ChatGPT subscription) canonical ids with documented Fast support. */
export const CODEX_FAST_MODELS: ReadonlySet<string> = new Set([
  'gpt-6-astra',
  'gpt-6-astra-1m',
  'gpt-6.1-sol',
  'gpt-6.1-sol-1m',
  'gpt-6-luna',
  'gpt-6-luna-1m',
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

export type FastServiceTierRoute = 'codex' | 'opencode-responses'

export function fastServiceTierRoute(
  modelId: string | null | undefined,
): FastServiceTierRoute | null {
  if (!modelId) return null
  if (CODEX_FAST_MODELS.has(modelId)) return 'codex'
  if (OPENCODE_GO_FAST_MODELS.has(modelId)) return 'opencode-responses'
  return null
}

export function supportsFastServiceTier(modelId: string | null | undefined): boolean {
  return fastServiceTierRoute(modelId) !== null
}

/** The OpenAI request value for Fast on a Responses endpoint. */
export const OPENAI_FAST_SERVICE_TIER = 'priority'

/**
 * Billing multiplier composed onto a metered (OpenCode Go) request that ran with Fast:
 * OpenAI's published Fast rates are 2× Standard for GPT-6 Luna and GPT-5.6 Luna.
 * Codex turns are not metered in credits (they spend the ChatGPT plan's limits).
 */
export const OPENCODE_GO_FAST_BILLING_MULTIPLIER = '2.000'
