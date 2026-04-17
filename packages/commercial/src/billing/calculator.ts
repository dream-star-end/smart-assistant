/**
 * T-21 — 扣费计算器。
 *
 * 输入:本次请求的 token usage(4 维)+ 当时的 ModelPricing 快照
 * 输出:`{ cost_credits, snapshot }`
 *   - cost_credits:**BigInt(分)**,向上取整到 1 分(避免给出白嫖余地)
 *   - snapshot:JSON 字符串,后续直接写进 `usage_records.price_snapshot`
 *
 * 规约:
 *   - 所有算术用 BigInt;绝不经过 Number 中转(1M tok × 1500 分 × 2.0 = 3 × 10^12 轻松越过
 *     Number.MAX_SAFE_INTEGER = 9.007×10^15,虽然单次可能没事,但 agent 长 session 累加会爆)
 *   - ceiling 在"总和"层做一次,不在每维做 —— 每维 ceiling 会双重舍入,系统性高估
 *   - `multiplier` 按 NUMERIC(6,3) 的整数放大形式参与(`"2.000"` → 2000n),不走 float
 *   - usage 为 0 → cost = 0(用户没用就别瞎扣);任意维 >0 → 至少 1 分(见 F-2 测试口径)
 *   - 负值 token 视为非法,直接抛(调用方 bug,别吞)
 */

import type { ModelPricing } from "./pricing.js";

export interface TokenUsage {
  input_tokens: bigint | number;
  output_tokens: bigint | number;
  cache_read_tokens: bigint | number;
  cache_write_tokens: bigint | number;
}

export interface PriceSnapshot {
  model_id: string;
  display_name: string;
  /** 以下 5 个字段皆为 string,为了 JSON 可序列化(BigInt 不能直接 JSON.stringify)。 */
  input_per_mtok: string;
  output_per_mtok: string;
  cache_read_per_mtok: string;
  cache_write_per_mtok: string;
  multiplier: string;
  /** 快照生成时间,ISO 字符串,便于 agent/chat 跨进程追溯。 */
  captured_at: string;
}

export interface CostResult {
  /** 扣费总积分(单位:分,1 积分 = 100 分)。 */
  cost_credits: bigint;
  /** 冻结的价格快照;调用方直接写进 usage_records.price_snapshot JSONB 列。 */
  snapshot: PriceSnapshot;
}

/** 把 usage 字段统一转成 bigint,并校验非负。 */
function normalizeTokens(name: string, v: bigint | number): bigint {
  const b = typeof v === "bigint" ? v : BigInt(v);
  if (b < 0n) {
    throw new TypeError(`${name} must be non-negative, got ${b.toString()}`);
  }
  return b;
}

/** multiplier 字符串 → BigInt 放大到 10^3。例如 "2.0" → 2000n,"1.234" → 1234n。 */
function multiplierToScaled(multiplier: string): bigint {
  const [intPart, fracRaw = ""] = multiplier.split(".");
  const frac = fracRaw.padEnd(3, "0").slice(0, 3);
  // 允许带正负号(BigInt 会自己处理),但负 multiplier 视为非法
  const scaled = BigInt(intPart + frac);
  if (scaled < 0n) {
    throw new TypeError(`multiplier must be non-negative, got ${multiplier}`);
  }
  return scaled;
}

/**
 * 计算本次请求的扣费。
 *
 * 推导:
 *   cost_cents = Σ_{i∈4dims} tokens_i * per_mtok_cents_i * multiplier
 *                / (1_000_000 tok/Mtok * 1000 mul_scale)
 *              = Σ scaled_{i} / 1_000_000_000
 *   其中 scaled_i = tokens_i * per_mtok_cents_i * mul_scaled_{10^3}
 *
 *   cost_cents 向上取整到整数:ceil(num / den) = (num + den - 1) / den (BigInt 整除)
 *   usage 全部 0 → cost 精确等于 0,跳过 ceiling(否则会被强拉到 0 不影响)
 */
export function computeCost(usage: TokenUsage, pricing: ModelPricing, capturedAt: Date = new Date()): CostResult {
  const input = normalizeTokens("input_tokens", usage.input_tokens);
  const output = normalizeTokens("output_tokens", usage.output_tokens);
  const cacheRead = normalizeTokens("cache_read_tokens", usage.cache_read_tokens);
  const cacheWrite = normalizeTokens("cache_write_tokens", usage.cache_write_tokens);

  const mul = multiplierToScaled(pricing.multiplier);

  const scaled =
    input * pricing.input_per_mtok * mul +
    output * pricing.output_per_mtok * mul +
    cacheRead * pricing.cache_read_per_mtok * mul +
    cacheWrite * pricing.cache_write_per_mtok * mul;

  // scale = 1_000_000 (Mtok) * 1000 (multiplier 放大) = 10^9
  const SCALE = 1_000_000_000n;
  let cost: bigint;
  if (scaled === 0n) {
    cost = 0n;
  } else {
    // 向上取整(scaled > 0 恒成立)
    cost = (scaled + SCALE - 1n) / SCALE;
  }

  const snapshot: PriceSnapshot = {
    model_id: pricing.model_id,
    display_name: pricing.display_name,
    input_per_mtok: pricing.input_per_mtok.toString(),
    output_per_mtok: pricing.output_per_mtok.toString(),
    cache_read_per_mtok: pricing.cache_read_per_mtok.toString(),
    cache_write_per_mtok: pricing.cache_write_per_mtok.toString(),
    multiplier: pricing.multiplier,
    captured_at: capturedAt.toISOString(),
  };

  return { cost_credits: cost, snapshot };
}
