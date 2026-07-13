import type { ModelPricing } from "./pricing.js";

/** Server-owned effective pricing frozen into request_finalize_journal. */
export interface PersistedBillingPricingV1 {
  v: 1;
  modelId: string;
  displayName: string;
  inputPerMtok: string;
  outputPerMtok: string;
  cacheReadPerMtok: string;
  cacheWritePerMtok: string;
  multiplier: string;
}

export function serializeBillingPricing(pricing: ModelPricing): PersistedBillingPricingV1 {
  return {
    v: 1,
    modelId: pricing.model_id,
    displayName: pricing.display_name,
    inputPerMtok: pricing.input_per_mtok.toString(),
    outputPerMtok: pricing.output_per_mtok.toString(),
    cacheReadPerMtok: pricing.cache_read_per_mtok.toString(),
    cacheWritePerMtok: pricing.cache_write_per_mtok.toString(),
    multiplier: pricing.multiplier,
  };
}

const BILLING_AMOUNT_RE = /^\d+$/;
const BILLING_MULTIPLIER_RE = /^\d+(?:\.\d{1,3})?$/;

/** Strictly restores the immutable journal price. Malformed evidence returns
 * null so callers can waive rather than silently charge another generation. */
export function parseBillingPricing(raw: unknown, expectedModel: string): ModelPricing | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (
    p.v !== 1 ||
    p.modelId !== expectedModel ||
    typeof p.displayName !== "string" ||
    typeof p.inputPerMtok !== "string" || !BILLING_AMOUNT_RE.test(p.inputPerMtok) ||
    typeof p.outputPerMtok !== "string" || !BILLING_AMOUNT_RE.test(p.outputPerMtok) ||
    typeof p.cacheReadPerMtok !== "string" || !BILLING_AMOUNT_RE.test(p.cacheReadPerMtok) ||
    typeof p.cacheWritePerMtok !== "string" || !BILLING_AMOUNT_RE.test(p.cacheWritePerMtok) ||
    typeof p.multiplier !== "string" || !BILLING_MULTIPLIER_RE.test(p.multiplier)
  ) {
    return null;
  }
  return {
    model_id: expectedModel,
    display_name: p.displayName,
    input_per_mtok: BigInt(p.inputPerMtok),
    output_per_mtok: BigInt(p.outputPerMtok),
    cache_read_per_mtok: BigInt(p.cacheReadPerMtok),
    cache_write_per_mtok: BigInt(p.cacheWritePerMtok),
    multiplier: p.multiplier,
    enabled: true,
    sort_order: 0,
    visibility: "hidden",
    extra_system_prompt: null,
    default_effort: null,
    updated_at: new Date(0),
  };
}
