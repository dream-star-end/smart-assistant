/**
 * Platform token-cost math (CNY 分). Single source for commercial settle
 * and gateway usage display — do not fork a second price table or formula.
 *
 *   cost_fen = ceil(Σ tokens_i * per_mtok_fen_i * multiplier / 1e9)
 *   multiplier is NUMERIC(*,3) scaled ×1000 ( "2.000" → 2000n ).
 *
 * USD display uses the 0223 official mid-rate (USD × 6.7905 = CNY).
 */

export const COST_SCALE = 1_000_000_000n

/** 2026-08-18 CNY mid-rate used by migration 0223 (100 USD = 679.05 CNY). */
export const CNY_PER_USD = 6.7905

export interface CostTokenUsage {
  input_tokens: bigint | number
  output_tokens: bigint | number
  cache_read_tokens: bigint | number
  cache_write_tokens: bigint | number
}

export interface CostPriceDims {
  input_per_mtok: bigint | number | string
  output_per_mtok: bigint | number | string
  cache_read_per_mtok: bigint | number | string
  cache_write_per_mtok: bigint | number | string
  multiplier: string
}

function normalizeTokens(name: string, v: bigint | number): bigint {
  const b = typeof v === 'bigint' ? v : BigInt(v)
  if (b < 0n) {
    throw new TypeError(`${name} must be non-negative, got ${b.toString()}`)
  }
  return b
}

function normalizePrice(name: string, v: bigint | number | string): bigint {
  const b = typeof v === 'bigint' ? v : BigInt(v)
  if (b < 0n) {
    throw new TypeError(`${name} must be non-negative, got ${b.toString()}`)
  }
  return b
}

/** multiplier 字符串 → BigInt 放大到 10^3。例如 "2.0" → 2000n,"1.234" → 1234n。 */
export function multiplierToScaled(multiplier: string): bigint {
  const [intPart, fracRaw = ''] = multiplier.split('.')
  const frac = fracRaw.padEnd(3, '0').slice(0, 3)
  const scaled = BigInt(intPart + frac)
  if (scaled < 0n) {
    throw new TypeError(`multiplier must be non-negative, got ${multiplier}`)
  }
  return scaled
}

/**
 * 复合 model × agent 两个 NUMERIC(*,3) multiplier。
 * 与 commercial `composeMultiplier` 同口径:BigInt scale 1000、向下截断,
 * 正×正截到 0 时 clamp 到 0.001。gateway 补价必须走这里,禁止 JS 浮点相乘。
 */
export function composeMultiplier(modelMul: string, agentMul: string): string {
  const m = multiplierToScaled(modelMul)
  const a = multiplierToScaled(agentMul)
  let composed = (m * a) / 1000n
  if (composed === 0n && m > 0n && a > 0n) {
    composed = 1n
  }
  const intPart = composed / 1000n
  const fracPart = composed % 1000n
  return `${intPart.toString()}.${fracPart.toString().padStart(3, '0')}`
}

/** 四维 token × 单价 × multiplier，向上取整到分。全零 usage → 0。 */
export function computeCostFen(usage: CostTokenUsage, price: CostPriceDims): bigint {
  const input = normalizeTokens('input_tokens', usage.input_tokens)
  const output = normalizeTokens('output_tokens', usage.output_tokens)
  const cacheRead = normalizeTokens('cache_read_tokens', usage.cache_read_tokens)
  const cacheWrite = normalizeTokens('cache_write_tokens', usage.cache_write_tokens)

  const mul = multiplierToScaled(price.multiplier)
  const scaled =
    input * normalizePrice('input_per_mtok', price.input_per_mtok) * mul +
    output * normalizePrice('output_per_mtok', price.output_per_mtok) * mul +
    cacheRead * normalizePrice('cache_read_per_mtok', price.cache_read_per_mtok) * mul +
    cacheWrite * normalizePrice('cache_write_per_mtok', price.cache_write_per_mtok) * mul

  if (scaled === 0n) return 0n
  return (scaled + COST_SCALE - 1n) / COST_SCALE
}

export function fenToUsd(fen: bigint | number): number {
  const n = typeof fen === 'bigint' ? Number(fen) : fen
  if (!Number.isFinite(n) || n === 0) return 0
  return n / 100 / CNY_PER_USD
}
