/**
 * OCV5-434 — GPT "Fast" service tier (OpenAI priority processing), turn-level, default off.
 *
 * Only the OpenCode Go `/responses` Lunas offer it: the request carries
 * `service_tier: "priority"` (verified ≈1.6× faster) and billing composes the published Fast
 * multiplier (upstream echoes neither tier nor price).
 *
 * Codex (ChatGPT subscription) does NOT: its backend ignores `priority` from our client
 * (verified 2026-10-16 — tier echoed "default", no speedup). The user chose to hide it there
 * rather than impersonate the Codex CLI; Codex GPT-6 turns always state an explicit standard
 * tier so a catalog Fast default (GPT-6 Luna) never applies.
 */
import { OPENCODE_GO_RESPONSES_MODELS } from './staticKeyProviders.js'

export const SERVICE_TIERS = ['fast'] as const
export type ServiceTier = (typeof SERVICE_TIERS)[number]

export function isServiceTier(value: unknown): value is ServiceTier {
  return typeof value === 'string' && (SERVICE_TIERS as readonly string[]).includes(value)
}

/**
 * Codex engine (ChatGPT subscription) GPT-6 ids whose catalog offers — or defaults to — the
 * priority tier. They never get a Fast toggle; every turn sends an explicit standard tier.
 */
export const CODEX_EXPLICIT_STANDARD_MODELS: ReadonlySet<string> = new Set([
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

export type FastServiceTierRoute = 'opencode-responses'

export function fastServiceTierRoute(
  modelId: string | null | undefined,
): FastServiceTierRoute | null {
  if (!modelId) return null
  if (OPENCODE_GO_FAST_MODELS.has(modelId)) return 'opencode-responses'
  return null
}

export function supportsFastServiceTier(modelId: string | null | undefined): boolean {
  return fastServiceTierRoute(modelId) !== null
}

/** The OpenAI request value for Fast on a Responses endpoint. */
export const OPENAI_FAST_SERVICE_TIER = 'priority'

/** Codex app-server's explicit standard tier id (catalog ids; "fast" would be ignored). */
export const CODEX_STANDARD_SERVICE_TIER = 'default'

/**
 * Billing multiplier composed onto a metered (OpenCode Go) request that ran with Fast:
 * OpenAI's published Fast rates are 2× Standard for GPT-6 Luna and GPT-5.6 Luna.
 */
export const OPENCODE_GO_FAST_BILLING_MULTIPLIER = '2.000'
