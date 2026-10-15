/**
 * OCV5-434 GPT Fast on the OpenCode Go /responses Lunas — the proxy's single decision point.
 *
 * CCB carries `service_tier: "priority"` only while the user has Fast on. Upstream echoes
 * neither tier nor price, so OpenAI's published Fast rate (2× Standard) is composed into this
 * request's multiplier; the pre-check, the price snapshot and the finalizer all receive the
 * returned pricing. On any other model our "priority" marker is removed so it never reaches an
 * upstream; other service_tier values are left untouched.
 */
import {
  OPENAI_FAST_SERVICE_TIER,
  OPENCODE_GO_FAST_BILLING_MULTIPLIER,
  OPENCODE_GO_FAST_MODELS,
  composeMultiplier,
} from '@openclaude/protocol'

export function applyFastServiceTierPricing<P extends { multiplier: string }>(
  body: { model: string; service_tier?: unknown },
  pricing: P,
): { fast: boolean; pricing: P } {
  const fast =
    body.service_tier === OPENAI_FAST_SERVICE_TIER && OPENCODE_GO_FAST_MODELS.has(body.model)
  if (body.service_tier === OPENAI_FAST_SERVICE_TIER && !fast) Reflect.deleteProperty(body, 'service_tier')
  return fast
    ? {
        fast,
        pricing: {
          ...pricing,
          multiplier: composeMultiplier(pricing.multiplier, OPENCODE_GO_FAST_BILLING_MULTIPLIER),
        },
      }
    : { fast, pricing }
}
