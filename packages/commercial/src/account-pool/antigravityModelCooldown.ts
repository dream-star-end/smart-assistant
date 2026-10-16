/**
 * Per-(account, model) cooldown for Antigravity (OCV5-415).
 *
 * Cloud Code answers a model that has no capacity (e.g. "No capacity available
 * for model gpt-oss-120b-medium", HTTP 503) while every other model on the
 * same account keeps working. Those 5xx answers therefore cool only that
 * catalog model on that account; the account row (health, status) is left to
 * account-level signals. The relay (egress) writes strikes and admission
 * (master) reads cooldowns, so production configures the shared Redis store;
 * tests use the in-memory one.
 *
 * TODO(OCV5-424): move into the policy layer with the rest of the interim pool.
 */

const SEC = 1000
const MIN = 60 * SEC
export const ANTIGRAVITY_MODEL_COOLDOWN_POLICY = {
  /** Consecutive model 5xx before the model cools (CLI retries count). */
  strikeThreshold: 3,
  baseMs: 1 * MIN,
  maxMs: 10 * MIN,
  /** How long strikes are remembered after the last failure. */
  strikeWindowMs: 10 * MIN,
} as const

/** Cooldown length after `strikes` consecutive failures; 0 = not cooling yet. */
export function antigravityModelCooldownMs(strikes: number): number {
  const p = ANTIGRAVITY_MODEL_COOLDOWN_POLICY
  if (strikes < p.strikeThreshold) return 0
  return Math.min(p.maxMs, p.baseMs * 2 ** Math.min(strikes - p.strikeThreshold, 20))
}

export interface AntigravityModelCooldownStore {
  /** Atomically add one strike (window refreshed); returns the new count. */
  strike(key: string, windowMs: number): Promise<number>
  setUntil(key: string, untilMs: number, ttlMs: number): Promise<void>
  getUntil(key: string): Promise<number | null>
  clear(key: string): Promise<void>
}

export function createIoredisAntigravityModelCooldownStore(client: {
  multi(): {
    incr(key: string): unknown
    pexpire(key: string, ms: number): unknown
    exec(): Promise<Array<[Error | null, unknown]> | null>
  }
  get(key: string): Promise<string | null>
  set(key: string, value: string, mode: 'PX', ms: number): Promise<unknown>
  del(...keys: string[]): Promise<unknown>
}): AntigravityModelCooldownStore {
  return {
    async strike(key, windowMs) {
      const tx = client.multi()
      tx.incr(`${key}:strikes`)
      tx.pexpire(`${key}:strikes`, windowMs)
      const res = await tx.exec()
      const [err, count] = res?.[0] ?? [new Error('redis multi aborted'), null]
      if (err) throw err
      return Number(count)
    },
    async setUntil(key, untilMs, ttlMs) {
      await client.set(`${key}:until`, String(untilMs), 'PX', Math.max(1, ttlMs))
    },
    async getUntil(key) {
      const raw = await client.get(`${key}:until`)
      const until = raw === null ? Number.NaN : Number(raw)
      return Number.isFinite(until) ? until : null
    },
    async clear(key) {
      await client.del(`${key}:strikes`, `${key}:until`)
    },
  }
}

/** In-process store (tests, local dev). JS is single-threaded, so `strike` is atomic. */
export function createMemoryAntigravityModelCooldownStore(
  clock: () => number = Date.now,
): AntigravityModelCooldownStore {
  const strikes = new Map<string, { count: number; expiresAt: number }>()
  const until = new Map<string, { until: number; expiresAt: number }>()
  return {
    async strike(key, windowMs) {
      const now = clock()
      const prev = strikes.get(key)
      const count = (prev && prev.expiresAt > now ? prev.count : 0) + 1
      strikes.set(key, { count, expiresAt: now + windowMs })
      return count
    },
    async setUntil(key, untilMs, ttlMs) {
      until.set(key, { until: untilMs, expiresAt: clock() + ttlMs })
    },
    async getUntil(key) {
      const hit = until.get(key)
      return hit && hit.expiresAt > clock() ? hit.until : null
    },
    async clear(key) {
      strikes.delete(key)
      until.delete(key)
    },
  }
}

let store: AntigravityModelCooldownStore = createMemoryAntigravityModelCooldownStore()

export function configureAntigravityModelCooldownStore(next: AntigravityModelCooldownStore): void {
  store = next
}

const KV_PREFIX = 'oc:v5:antigravity-model-cooldown:'

function key(accountId: bigint, modelId: string): string {
  return `${KV_PREFIX}${accountId.toString()}:${modelId}`
}

/** Record one generate-call result for the route's catalog model. */
export async function reportAntigravityModelOutcome(
  accountId: bigint,
  modelId: string,
  ok: boolean,
  deps: { now?: () => number } = {},
): Promise<void> {
  const k = key(accountId, modelId)
  if (ok) {
    await store.clear(k)
    return
  }
  const p = ANTIGRAVITY_MODEL_COOLDOWN_POLICY
  const strikes = await store.strike(k, p.maxMs + p.strikeWindowMs)
  const ms = antigravityModelCooldownMs(strikes)
  if (ms > 0) await store.setUntil(k, (deps.now ?? Date.now)() + ms, ms)
}

/** Epoch ms the model stays cooled on this account, or null if usable. */
export async function antigravityModelCoolingUntil(
  accountId: bigint,
  modelId: string,
  deps: { now?: () => number } = {},
): Promise<number | null> {
  const until = await store.getUntil(key(accountId, modelId))
  return until !== null && until > (deps.now ?? Date.now)() ? until : null
}

export function _resetAntigravityModelCooldownForTests(clock?: () => number): void {
  store = createMemoryAntigravityModelCooldownStore(clock)
}
