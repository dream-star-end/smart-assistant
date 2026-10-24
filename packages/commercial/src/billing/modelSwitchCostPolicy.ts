import { computeCostFen, type CostPriceDims } from '@openclaude/protocol'
import type { ModelSwitchCostRange } from '@openclaude/protocol'

export interface SwitchCostPolicy {
  minimumCredits: bigint
  minimumDeltaCredits: bigint
  absoluteCredits: bigint
  ratioMilli: bigint
  outputDefault: number
  outputHigh: number
  ttlMs: number
}
function integer(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined) return fallback
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) <= 0) {
    throw new TypeError(`Invalid ${name}`)
  }
  return Number(raw)
}
export function readSwitchCostPolicy(env: NodeJS.ProcessEnv = process.env): SwitchCostPolicy {
  const policy = {
    minimumCredits: BigInt(integer(env, 'OC_MODEL_SWITCH_MIN_CREDITS', 100)),
    minimumDeltaCredits: BigInt(integer(env, 'OC_MODEL_SWITCH_DELTA_CREDITS', 50)),
    absoluteCredits: BigInt(integer(env, 'OC_MODEL_SWITCH_ABSOLUTE_CREDITS', 500)),
    ratioMilli: BigInt(integer(env, 'OC_MODEL_SWITCH_RATIO_MILLI', 1500)),
    outputDefault: integer(env, 'OC_MODEL_SWITCH_OUTPUT_TOKENS', 2048),
    outputHigh: integer(env, 'OC_MODEL_SWITCH_OUTPUT_HIGH_TOKENS', 4096),
    ttlMs: integer(env, 'OC_MODEL_SWITCH_QUOTE_TTL_MS', 300000),
  }
  if (policy.outputHigh < policy.outputDefault || policy.ratioMilli <= 1000n) {
    throw new TypeError('Invalid model switch cost policy range')
  }
  return policy
}
export function expensiveSwitch(
  target: bigint,
  current: bigint,
  policy: SwitchCostPolicy,
): boolean {
  if (target <= current || target - current < policy.minimumDeltaCredits) return false
  return (
    (target >= policy.minimumCredits && target * 1000n >= current * policy.ratioMilli) ||
    target >= policy.absoluteCredits
  )
}
export function outputPrediction(
  samples: readonly number[],
  policy: SwitchCostPolicy,
): [number, number] {
  const values = samples
    .filter((n) => Number.isSafeInteger(n) && n >= 0)
    .slice(0, 5)
    .sort((a, b) => a - b)
  if (values.length < 5) return [policy.outputDefault, policy.outputHigh]
  return [values[2], values[4]]
}
function cost(
  context: number,
  freshInput: number,
  output: number,
  calls: number,
  price: CostPriceDims,
  warmRatio: number,
  followupWarm = true,
  coldMode: 'input' | 'max' = 'max',
): bigint {
  const coldWrite =
    coldMode !== 'input' && BigInt(price.cache_write_per_mtok) > BigInt(price.input_per_mtok)
  const cacheable = BigInt(price.cache_read_per_mtok) > 0n
  const read = cacheable ? Math.floor(context * Math.min(1, Math.max(0, warmRatio))) : 0
  const request = (fresh: number, cached: number, out: number) =>
    computeCostFen(
      {
        input_tokens: coldWrite ? 0 : fresh,
        output_tokens: out,
        cache_read_tokens: cached,
        cache_write_tokens: coldWrite ? fresh : 0,
      },
      price,
    )
  // Newly typed input and the last assistant output have never hit the old
  // cache. Apply the observed cache ratio only to the prior input context.
  const first = request(context - read + freshInput, read, output)
  const repeated = context + freshInput + output
  const next = cacheable && followupWarm ? request(0, repeated, 0) : request(repeated, 0, 0)
  return first + BigInt(Math.max(0, calls - 1)) * next
}
/** Predict, never reserve or settle. Each predicted request uses platform math. */
export function switchCostRange(args: {
  contextTokens: number
  additionalTokens: number
  output: [number, number]
  calls: number
  price: CostPriceDims
  warmRatio: number
  coldMode?: 'input' | 'max'
  additionalHighTokens?: number
}): ModelSwitchCostRange {
  const n = Math.max(512, args.additionalTokens)
  const k = Math.max(1, args.calls)
  const expected = cost(
    args.contextTokens,
    n,
    args.output[0],
    k,
    args.price,
    args.warmRatio,
    true,
    args.coldMode,
  )
  const low = cost(args.contextTokens, n, 0, 1, args.price, args.warmRatio, true, args.coldMode)
  // Runner/tokenizer envelopes may change; this interval is not a spend cap.
  // Include the possible per-request rounding difference when output is split.
  const high =
    cost(
      Math.ceil(args.contextTokens * 1.15),
      Math.ceil(Math.max(n, args.additionalHighTokens ?? n) * 1.15),
      args.output[1],
      k,
      args.price,
      0,
      false,
      args.coldMode,
    ) + BigInt(k - 1)
  return {
    lowCredits: low.toString(),
    expectedCredits: expected.toString(),
    highCredits: (high > expected ? high : expected).toString(),
  }
}
