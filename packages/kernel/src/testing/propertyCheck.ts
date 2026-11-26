/**
 * Deterministic Model-Based Property Testing Engine (@openclaude/kernel/testing).
 *
 * Zero external dependencies and zero `node:*` imports so it remains strictly
 * L1-pure under `scripts/check-architecture.ts`. API mirrors `fast-check`:
 *   - Reproducible Mulberry32 + SplitMix32 PRNG seeded by 32-bit integer
 *   - Composable arbitraries: integer, nat, bigInt, boolean, string, constant,
 *     constantFrom, oneof, array, tuple, record, option, commands
 *   - Stateful model checking: `modelRun` / `asyncModelRun`
 *   - Delta-debugging (`ddmin`) shrinking to minimal failing counterexample /
 *     minimal command sequence with reproducible seed in error reports
 */

export interface Prng {
  readonly seed: number
  nextUint32(): number
  nextFloat(): number
  nextInt(min: number, max: number): number
  nextBigInt(min: bigint, max: bigint): bigint
  nextBoolean(trueProbability?: number): boolean
  pick<T>(items: readonly T[]): T
  fork(salt?: number): Prng
}

function splitMix32Step(state: number): number {
  let z = (state + 0x9e3779b9) | 0
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b)
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35)
  return (z ^ (z >>> 16)) >>> 0
}

/**
 * Deterministic 32-bit PRNG backed by SplitMix32 seed mixing + Mulberry32 stream.
 */
export function createPrng(seed: number): Prng {
  const normalizedSeed = (Math.trunc(seed) | 0) >>> 0
  let state = splitMix32Step(normalizedSeed)

  const nextUint32 = (): number => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return (t ^ (t >>> 14)) >>> 0
  }

  const nextFloat = (): number => nextUint32() / 0x1_0000_0000

  const nextInt = (min: number, max: number): number => {
    const lo = Math.ceil(min)
    const hi = Math.floor(max)
    if (lo > hi) {
      throw new RangeError(`nextInt: min (${min}) > max (${max})`)
    }
    if (lo === hi) return lo
    const span = hi - lo + 1
    if (span <= 0x1_0000_0000) {
      // Rejection sampling removes modulo bias for 32-bit spans.
      const limit = Math.floor(0x1_0000_0000 / span) * span
      let r = nextUint32()
      while (r >= limit) r = nextUint32()
      return lo + (r % span)
    }
    return lo + Math.floor(nextFloat() * span)
  }

  const nextBigInt = (min: bigint, max: bigint): bigint => {
    if (min > max) {
      throw new RangeError(`nextBigInt: min (${min}) > max (${max})`)
    }
    if (min === max) return min
    const span = max - min + 1n
    // Compute byte width needed to cover span uniformly.
    let bits = 0
    let tmp = span - 1n
    while (tmp > 0n) {
      tmp >>= 1n
      bits += 1
    }
    const words = Math.max(1, Math.ceil(bits / 32))
    const maskBits = BigInt(words * 32 - bits)
    for (;;) {
      let acc = 0n
      for (let i = 0; i < words; i += 1) {
        acc = (acc << 32n) | BigInt(nextUint32())
      }
      acc >>= maskBits
      if (acc < span) return min + acc
    }
  }

  const nextBoolean = (trueProbability = 0.5): boolean => nextFloat() < trueProbability

  const pick = <T>(items: readonly T[]): T => {
    if (items.length === 0) {
      throw new RangeError('pick: cannot pick from empty array')
    }
    return items[nextInt(0, items.length - 1)]!
  }

  const fork = (salt = 0): Prng => {
    const mixed = splitMix32Step((nextUint32() ^ (salt | 0)) >>> 0)
    return createPrng(mixed)
  }

  return {
    seed: normalizedSeed,
    nextUint32,
    nextFloat,
    nextInt,
    nextBigInt,
    nextBoolean,
    pick,
    fork,
  }
}

export interface Arbitrary<T> {
  generate(rng: Prng): T
  shrink(value: T): Iterable<T>
  map<U>(mapper: (value: T) => U, unmapper?: (value: U) => T | undefined): Arbitrary<U>
  filter(predicate: (value: T) => boolean, maxTries?: number): Arbitrary<T>
}

export function createArbitrary<T>(
  generate: (rng: Prng) => T,
  shrink: (value: T) => Iterable<T> = () => [],
): Arbitrary<T> {
  const arb: Arbitrary<T> = {
    generate,
    shrink,
    map<U>(mapper: (value: T) => U, unmapper?: (value: U) => T | undefined): Arbitrary<U> {
      return createArbitrary<U>(
        (rng) => mapper(generate(rng)),
        function* (value: U): Iterable<U> {
          if (!unmapper) return
          const raw = unmapper(value)
          if (raw === undefined) return
          for (const shrunk of shrink(raw)) {
            yield mapper(shrunk)
          }
        },
      )
    },
    filter(predicate: (value: T) => boolean, maxTries = 100): Arbitrary<T> {
      return createArbitrary<T>(
        (rng) => {
          for (let i = 0; i < maxTries; i += 1) {
            const candidate = generate(rng)
            if (predicate(candidate)) return candidate
          }
          throw new Error(`Arbitrary.filter failed to satisfy predicate after ${maxTries} attempts`)
        },
        function* (value: T): Iterable<T> {
          for (const candidate of shrink(value)) {
            if (predicate(candidate)) yield candidate
          }
        },
      )
    },
  }
  return arb
}

function* shrinkNumberToward(value: number, target: number): Iterable<number> {
  if (value === target) return
  yield target
  let diff = value - target
  while (Math.abs(diff) > 1) {
    diff = diff > 0 ? Math.trunc(diff / 2) : Math.trunc(diff / 2)
    const candidate = value - diff
    if (candidate !== value && candidate !== target) {
      yield candidate
    }
  }
  const step = value > target ? value - 1 : value + 1
  if (step !== target && step !== value) {
    yield step
  }
}

function* shrinkBigIntToward(value: bigint, target: bigint): Iterable<bigint> {
  if (value === target) return
  yield target
  let diff = value - target
  while (diff > 1n || diff < -1n) {
    diff = diff / 2n
    const candidate = value - diff
    if (candidate !== value && candidate !== target) {
      yield candidate
    }
  }
  const step = value > target ? value - 1n : value + 1n
  if (step !== target && step !== value) {
    yield step
  }
}

export function integer(opts: { min?: number; max?: number } = {}): Arbitrary<number> {
  const min = opts.min ?? -1000
  const max = opts.max ?? 1000
  if (min > max) throw new RangeError(`integer: min (${min}) > max (${max})`)
  const target = min <= 0 && max >= 0 ? 0 : min > 0 ? min : max
  return createArbitrary(
    (rng) => rng.nextInt(min, max),
    function* (value) {
      for (const candidate of shrinkNumberToward(value, target)) {
        if (candidate >= min && candidate <= max) yield candidate
      }
    },
  )
}

export function nat(max = 1000): Arbitrary<number> {
  if (max < 0) throw new RangeError(`nat: max (${max}) must be >= 0`)
  return integer({ min: 0, max })
}

export function bigInt(opts: { min?: bigint; max?: bigint } = {}): Arbitrary<bigint> {
  const min = opts.min ?? 0n
  const max = opts.max ?? 1_000_000n
  if (min > max) throw new RangeError(`bigInt: min (${min}) > max (${max})`)
  const target = min <= 0n && max >= 0n ? 0n : min > 0n ? min : max
  return createArbitrary(
    (rng) => rng.nextBigInt(min, max),
    function* (value) {
      for (const candidate of shrinkBigIntToward(value, target)) {
        if (candidate >= min && candidate <= max) yield candidate
      }
    },
  )
}

export function boolean(): Arbitrary<boolean> {
  return createArbitrary(
    (rng) => rng.nextBoolean(),
    function* (value) {
      if (value) yield false
    },
  )
}

const DEFAULT_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789_-'

export function string(
  opts: { minLength?: number; maxLength?: number; alphabet?: string } = {},
): Arbitrary<string> {
  const minLength = opts.minLength ?? 0
  const maxLength = opts.maxLength ?? 16
  const alphabet = opts.alphabet ?? DEFAULT_ALPHABET
  if (minLength < 0 || maxLength < minLength) {
    throw new RangeError(`string: invalid length range [${minLength}, ${maxLength}]`)
  }
  if (alphabet.length === 0) {
    throw new RangeError('string: alphabet must be non-empty')
  }
  return createArbitrary(
    (rng) => {
      const len = rng.nextInt(minLength, maxLength)
      let out = ''
      for (let i = 0; i < len; i += 1) {
        out += alphabet[rng.nextInt(0, alphabet.length - 1)]
      }
      return out
    },
    function* (value) {
      if (value.length > minLength) {
        if (minLength === 0) yield ''
        const half = Math.max(minLength, Math.floor(value.length / 2))
        if (half < value.length) {
          yield value.slice(0, half)
          yield value.slice(value.length - half)
        }
        yield value.slice(0, value.length - 1)
        yield value.slice(1)
      }
      const firstChar = alphabet[0]!
      for (let i = 0; i < value.length; i += 1) {
        if (value[i] !== firstChar) {
          yield value.slice(0, i) + firstChar + value.slice(i + 1)
        }
      }
    },
  )
}

export function constant<T>(value: T): Arbitrary<T> {
  return createArbitrary(() => value)
}

export function constantFrom<const T extends readonly unknown[]>(
  ...values: T
): Arbitrary<T[number]> {
  if (values.length === 0) {
    throw new RangeError('constantFrom requires at least one value')
  }
  return createArbitrary(
    (rng) => rng.pick(values),
    function* (value) {
      const idx = values.indexOf(value)
      if (idx > 0) {
        yield values[0]
        if (idx > 1) yield values[idx - 1]
      }
    },
  )
}

export type WeightedArbitrary<T> = Arbitrary<T> | { weight: number; arbitrary: Arbitrary<T> }

type UnwrapWeighted<W> = W extends Arbitrary<infer T>
  ? T
  : W extends { arbitrary: Arbitrary<infer T> }
    ? T
    : never

export function oneof<const T extends readonly WeightedArbitrary<any>[]>(
  ...entries: T
): Arbitrary<UnwrapWeighted<T[number]>> {
  if (entries.length === 0) {
    throw new RangeError('oneof requires at least one arbitrary')
  }
  const normalized = entries.map((entry) =>
    'arbitrary' in entry
      ? { weight: Math.max(1, Math.floor(entry.weight)), arbitrary: entry.arbitrary }
      : { weight: 1, arbitrary: entry },
  )
  const totalWeight = normalized.reduce((sum, e) => sum + e.weight, 0)
  return createArbitrary<UnwrapWeighted<T[number]>>(
    (rng) => {
      let pick = rng.nextInt(0, totalWeight - 1)
      for (const entry of normalized) {
        if (pick < entry.weight) return entry.arbitrary.generate(rng)
        pick -= entry.weight
      }
      return normalized[normalized.length - 1]!.arbitrary.generate(rng)
    },
    function* (value) {
      for (const entry of normalized) {
        try {
          for (const candidate of entry.arbitrary.shrink(value)) {
            yield candidate
          }
        } catch (err) {
          // Variant arbitrary did not match this runtime value; skip safely.
          void err
        }
      }
    },
  )
}

export function option<T>(
  arb: Arbitrary<T>,
  opts: { nil?: null | undefined; freq?: number } = {},
): Arbitrary<T | null> {
  const nil = (opts.nil === undefined ? null : opts.nil) as T | null
  const freq = Math.max(2, Math.floor(opts.freq ?? 5))
  return createArbitrary(
    (rng) => (rng.nextInt(1, freq) === 1 ? nil : arb.generate(rng)),
    function* (value) {
      if (value === nil) return
      yield nil
      for (const shrunk of arb.shrink(value as T)) {
        yield shrunk
      }
    },
  )
}

/**
 * Delta-debugging (ddmin) sequence shrinker:
 *   1. Try empty/minLength prefix
 *   2. Remove contiguous chunks of decreasing granularity (n/2, n/4, ..., 1)
 *   3. Try single-element removals from tail to head
 *   4. Shrink individual elements via itemArb.shrink
 */
export function* deltaDebugShrinkArray<T>(
  items: readonly T[],
  minLength: number,
  itemShrink?: (item: T) => Iterable<T>,
): Iterable<T[]> {
  const len = items.length
  if (len > minLength) {
    if (minLength === 0) yield []
    else yield items.slice(0, minLength)

    // ddmin chunk-removal pass: halves, quarters, eighths...
    let chunkSize = Math.floor(len / 2)
    while (chunkSize >= 1) {
      for (let start = 0; start < len; start += chunkSize) {
        const end = Math.min(len, start + chunkSize)
        if (len - (end - start) < minLength) continue
        if (start === 0 && end === len) continue
        yield [...items.slice(0, start), ...items.slice(end)]
      }
      if (chunkSize === 1) break
      chunkSize = Math.floor(chunkSize / 2)
    }

    // Also try keeping only a single chunk of size >= minLength (complement pass).
    let keepSize = Math.floor(len / 2)
    while (keepSize >= Math.max(1, minLength)) {
      for (let start = 0; start + keepSize <= len; start += keepSize) {
        if (keepSize === len) continue
        yield items.slice(start, start + keepSize)
      }
      if (keepSize <= Math.max(1, minLength)) break
      keepSize = Math.floor(keepSize / 2)
    }
  }

  if (itemShrink) {
    for (let i = 0; i < len; i += 1) {
      for (const shrunkItem of itemShrink(items[i]!)) {
        const copy = items.slice()
        copy[i] = shrunkItem
        yield copy
      }
    }
  }
}

export function array<T>(
  itemArb: Arbitrary<T>,
  opts: { minLength?: number; maxLength?: number } = {},
): Arbitrary<T[]> {
  const minLength = opts.minLength ?? 0
  const maxLength = opts.maxLength ?? 16
  if (minLength < 0 || maxLength < minLength) {
    throw new RangeError(`array: invalid length range [${minLength}, ${maxLength}]`)
  }
  return createArbitrary(
    (rng) => {
      const len = rng.nextInt(minLength, maxLength)
      const out: T[] = []
      for (let i = 0; i < len; i += 1) {
        out.push(itemArb.generate(rng))
      }
      return out
    },
    (value) => deltaDebugShrinkArray(value, minLength, (item) => itemArb.shrink(item)),
  )
}

export function tuple<T extends readonly unknown[]>(
  ...arbs: { [K in keyof T]: Arbitrary<T[K]> }
): Arbitrary<T> {
  return createArbitrary(
    (rng) => {
      const generated: readonly unknown[] = arbs.map((arb) => arb.generate(rng))
      return generated as T
    },
    function* (value) {
      for (let i = 0; i < arbs.length; i += 1) {
        for (const shrunk of arbs[i]!.shrink(value[i])) {
          const copy: unknown[] = value.slice()
          copy[i] = shrunk
          const next: readonly unknown[] = copy
          yield next as T
        }
      }
    },
  )
}

export function record<T extends Record<string, unknown>>(spec: {
  [K in keyof T]: Arbitrary<T[K]>
}): Arbitrary<T> {
  const keys = Object.keys(spec) as Array<keyof T>
  return createArbitrary(
    (rng) => {
      const out = {} as T
      for (const k of keys) {
        out[k] = spec[k].generate(rng)
      }
      return out
    },
    function* (value) {
      for (const k of keys) {
        for (const shrunk of spec[k].shrink(value[k])) {
          yield { ...value, [k]: shrunk }
        }
      }
    },
  )
}

// ─── Stateful Model-Based Testing ────────────────────────────────────────────

export interface Command<Model, Real> {
  check(model: Readonly<Model>): boolean
  run(model: Model, real: Real): void
  toString(): string
}

export interface AsyncCommand<Model, Real> {
  check(model: Readonly<Model>): boolean
  run(model: Model, real: Real): Promise<void> | void
  toString(): string
}

export function commands<Model, Real, C extends Command<Model, Real> | AsyncCommand<Model, Real>>(
  commandArbs: readonly WeightedArbitrary<C>[],
  opts: { minLength?: number; maxLength?: number } = {},
): Arbitrary<C[]> {
  const minLength = opts.minLength ?? 1
  const maxLength = opts.maxLength ?? 24
  const cmdArb = oneof(...commandArbs) as Arbitrary<C>
  return array(cmdArb, { minLength, maxLength })
}

export function modelRun<Model, Real>(
  setup: () => { model: Model; real: Real },
  cmds: readonly Command<Model, Real>[],
): void {
  const { model, real } = setup()
  for (const cmd of cmds) {
    if (cmd.check(model)) {
      cmd.run(model, real)
    }
  }
}

export async function asyncModelRun<Model, Real>(
  setup: () => Promise<{ model: Model; real: Real }> | { model: Model; real: Real },
  cmds: readonly AsyncCommand<Model, Real>[],
  teardown?: (state: { model: Model; real: Real }) => Promise<void> | void,
): Promise<void> {
  const state = await setup()
  try {
    for (const cmd of cmds) {
      if (cmd.check(state.model)) {
        await cmd.run(state.model, state.real)
      }
    }
  } finally {
    if (teardown) {
      await teardown(state)
    }
  }
}

// ─── Formatting & Error Reporting ────────────────────────────────────────────

function safeStringify(value: unknown): string {
  if (Array.isArray(value) && value.length > 0 && value.every(isCommandLike)) {
    return `[${value.map((c) => c.toString()).join(' -> ')}]`
  }
  try {
    return JSON.stringify(
      value,
      (_k, v) => (typeof v === 'bigint' ? `${v.toString()}n` : v),
    )
  } catch {
    return String(value)
  }
}

function isCommandLike(v: unknown): v is { check: unknown; run: unknown; toString: () => string } {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as Record<string, unknown>).check === 'function' &&
    typeof (v as Record<string, unknown>).run === 'function'
  )
}

export class PropertyFailureError<T = unknown> extends Error {
  readonly seed: number
  readonly runIndex: number
  readonly numRuns: number
  readonly shrinkSteps: number
  readonly originalCounterexample: T
  readonly counterexample: T
  readonly causeError: unknown

  constructor(info: {
    label?: string
    seed: number
    runIndex: number
    numRuns: number
    shrinkSteps: number
    originalCounterexample: T
    counterexample: T
    causeError: unknown
  }) {
    const causeMsg =
      info.causeError instanceof Error
        ? info.causeError.message
        : String(info.causeError)
    const header = info.label ? `Property "${info.label}" failed` : 'Property failed'
    const lines = [
      `${header} after ${info.runIndex + 1}/${info.numRuns} runs`,
      `  seed          : ${info.seed}`,
      `  shrinkSteps   : ${info.shrinkSteps}`,
      `  counterexample: ${safeStringify(info.counterexample)}`,
      `  cause         : ${causeMsg}`,
    ]
    super(lines.join('\n'))
    this.name = 'PropertyFailureError'
    this.seed = info.seed
    this.runIndex = info.runIndex
    this.numRuns = info.numRuns
    this.shrinkSteps = info.shrinkSteps
    this.originalCounterexample = info.originalCounterexample
    this.counterexample = info.counterexample
    this.causeError = info.causeError
  }
}

export interface PropertyOptions {
  numRuns?: number
  seed?: number
  maxShrinks?: number
  label?: string
}

export const DEFAULT_PBT_SEED = 0x5f3759df
export const DEFAULT_PBT_RUNS = 200
export const DEFAULT_MAX_SHRINKS = 400

/**
 * Pure parser for `PBT_RUNS` (caller passes `process.env.PBT_RUNS` so L1 kernel
 * stays free of `process.env` reads under R3-env).
 */
export function resolvePbtRuns(defaultRuns = DEFAULT_PBT_RUNS, rawEnv?: string): number {
  if (!rawEnv) return defaultRuns
  const parsed = Number.parseInt(rawEnv.trim(), 10)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return defaultRuns
  return parsed
}

export type SyncPredicate<T> = ((value: T) => boolean) | ((value: T) => void)
export type AsyncPredicate<T> =
  | ((value: T) => Promise<boolean>)
  | ((value: T) => Promise<void>)
  | ((value: T) => boolean)
  | ((value: T) => void)

function trySyncPredicate<T>(predicate: SyncPredicate<T>, value: T): unknown | null {
  try {
    const result = predicate(value)
    if (result === false) {
      return new Error('property predicate returned false')
    }
    return null
  } catch (err) {
    return err
  }
}

async function tryAsyncPredicate<T>(
  predicate: AsyncPredicate<T>,
  value: T,
): Promise<unknown | null> {
  try {
    const result = await predicate(value)
    if (result === false) {
      return new Error('property predicate returned false')
    }
    return null
  } catch (err) {
    return err
  }
}

export function assertProperty<T>(
  arb: Arbitrary<T>,
  predicate: SyncPredicate<T>,
  opts: PropertyOptions = {},
): { seed: number; numRuns: number } {
  const numRuns = opts.numRuns ?? DEFAULT_PBT_RUNS
  const seed = opts.seed ?? DEFAULT_PBT_SEED
  const maxShrinks = opts.maxShrinks ?? DEFAULT_MAX_SHRINKS
  const rng = createPrng(seed)

  for (let runIndex = 0; runIndex < numRuns; runIndex += 1) {
    const value = arb.generate(rng)
    const initialErr = trySyncPredicate(predicate, value)
    if (initialErr !== null) {
      let best = value
      let bestErr = initialErr
      let shrinkSteps = 0
      let budget = maxShrinks

      while (budget > 0) {
        let improved = false
        for (const candidate of arb.shrink(best)) {
          if (budget <= 0) break
          budget -= 1
          const err = trySyncPredicate(predicate, candidate)
          if (err !== null) {
            best = candidate
            bestErr = err
            shrinkSteps += 1
            improved = true
            break
          }
        }
        if (!improved) break
      }

      throw new PropertyFailureError({
        label: opts.label,
        seed: rng.seed,
        runIndex,
        numRuns,
        shrinkSteps,
        originalCounterexample: value,
        counterexample: best,
        causeError: bestErr,
      })
    }
  }

  return { seed: rng.seed, numRuns }
}

export async function assertAsyncProperty<T>(
  arb: Arbitrary<T>,
  predicate: AsyncPredicate<T>,
  opts: PropertyOptions = {},
): Promise<{ seed: number; numRuns: number }> {
  const numRuns = opts.numRuns ?? DEFAULT_PBT_RUNS
  const seed = opts.seed ?? DEFAULT_PBT_SEED
  const maxShrinks = opts.maxShrinks ?? DEFAULT_MAX_SHRINKS
  const rng = createPrng(seed)

  for (let runIndex = 0; runIndex < numRuns; runIndex += 1) {
    const value = arb.generate(rng)
    const initialErr = await tryAsyncPredicate(predicate, value)
    if (initialErr !== null) {
      let best = value
      let bestErr = initialErr
      let shrinkSteps = 0
      let budget = maxShrinks

      while (budget > 0) {
        let improved = false
        for (const candidate of arb.shrink(best)) {
          if (budget <= 0) break
          budget -= 1
          const err = await tryAsyncPredicate(predicate, candidate)
          if (err !== null) {
            best = candidate
            bestErr = err
            shrinkSteps += 1
            improved = true
            break
          }
        }
        if (!improved) break
      }

      throw new PropertyFailureError({
        label: opts.label,
        seed: rng.seed,
        runIndex,
        numRuns,
        shrinkSteps,
        originalCounterexample: value,
        counterexample: best,
        causeError: bestErr,
      })
    }
  }

  return { seed: rng.seed, numRuns }
}

export const fc = {
  createPrng,
  createArbitrary,
  integer,
  nat,
  bigInt,
  boolean,
  string,
  constant,
  constantFrom,
  oneof,
  option,
  array,
  tuple,
  record,
  commands,
  modelRun,
  asyncModelRun,
  assertProperty,
  assertAsyncProperty,
  resolvePbtRuns,
  PropertyFailureError,
} as const
