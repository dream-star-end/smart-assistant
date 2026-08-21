/**
 * Picker xN vs DeepSeek V4 Pro.
 *
 * Baseline blended cost uses the live catalog fen/MTok prices (CNY 分) and
 * this environment's observed token mix from usage_records (status=success,
 * 14-day window sampled 2026-08-18):
 *   uncached input 108,578,309
 *   cache_read     1,146,891,059
 *   output         4,214,476
 * cache_write is ignored in the volume mix (the price-side 90/10 cache/input
 * weights already model cache hit rate).
 *
 * blended = ((0.9 * cache_read + 0.1 * input) * 0.9967 + output * 0.0033) * multiplier
 * xN      = round(blended / blended(deepseek-v4-pro), 1)
 */
export const COST_INDEX_BASELINE_MODEL_ID = 'deepseek-v4-pro'
export const COST_INDEX_CACHE_PRICE_WEIGHT = 0.9
export const COST_INDEX_INPUT_PRICE_WEIGHT = 0.1
export const COST_INDEX_INPUT_SHARE = 0.9967
export const COST_INDEX_OUTPUT_SHARE = 0.0033

export interface CostIndexPrice {
  inputPerMtok: bigint | number | string
  cacheReadPerMtok: bigint | number | string
  outputPerMtok: bigint | number | string
  multiplier?: string | number | null
}

function toNumber(value: bigint | number | string): number {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  return Number(value)
}

export function blendedCostFen(price: CostIndexPrice): number {
  const multiplier = toNumber(price.multiplier ?? 1)
  const effectiveInput =
    COST_INDEX_CACHE_PRICE_WEIGHT * toNumber(price.cacheReadPerMtok) +
    COST_INDEX_INPUT_PRICE_WEIGHT * toNumber(price.inputPerMtok)
  return (
    (effectiveInput * COST_INDEX_INPUT_SHARE +
      toNumber(price.outputPerMtok) * COST_INDEX_OUTPUT_SHARE) *
    (Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1)
  )
}

export function costXVsBaseline(
  price: CostIndexPrice,
  baseline: CostIndexPrice | null | undefined,
): number | undefined {
  if (!baseline) return undefined
  const baselineBlended = blendedCostFen(baseline)
  if (!(baselineBlended > 0)) return undefined
  return Math.round((blendedCostFen(price) / baselineBlended) * 10) / 10
}

export function formatCostX(costX: number | undefined): string | undefined {
  if (typeof costX !== 'number' || !Number.isFinite(costX)) return undefined
  return `x${costX.toFixed(1)}`
}
