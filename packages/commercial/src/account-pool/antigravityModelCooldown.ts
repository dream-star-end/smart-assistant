/**
 * Per-(account, model) cooldown for Antigravity (OCV5-415).
 *
 * Cloud Code answers a model that has no capacity (e.g. "No capacity available
 * for model gpt-oss-120b-medium", HTTP 503) while every other model on the
 * same account keeps working. Those 5xx answers therefore cool only that
 * catalog model on that account; the account row (health, status) is left to
 * account-level signals. State lives in the shared relay KV (Redis in
 * production) because the relay (egress) writes it and admission (master)
 * reads it; tests use the in-memory map.
 *
 * TODO(OCV5-424): move into the policy layer with the rest of the interim pool.
 */
import { getAntigravityRelayKv } from '../billing/antigravityRouteContext.js'

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

export interface AntigravityModelCooldownState {
  strikes: number
  /** Epoch ms; 0 = counting strikes, not cooling. */
  until: number
}

const KV_PREFIX = 'oc:v5:antigravity-model-cooldown:'
const memory = new Map<string, { state: AntigravityModelCooldownState; expiresAt: number }>()

function key(accountId: bigint, modelId: string): string {
  return `${KV_PREFIX}${accountId.toString()}:${modelId}`
}

/** Pure transition (unit-tested). `null` = clear the state. */
export function decideAntigravityModelCooldown(
  prev: AntigravityModelCooldownState | null,
  ok: boolean,
  now: number,
): AntigravityModelCooldownState | null {
  if (ok) return null
  const p = ANTIGRAVITY_MODEL_COOLDOWN_POLICY
  const strikes = (prev?.strikes ?? 0) + 1
  if (strikes < p.strikeThreshold) return { strikes, until: 0 }
  const ms = Math.min(p.maxMs, p.baseMs * 2 ** Math.min(strikes - p.strikeThreshold, 20))
  return { strikes, until: now + ms }
}

function parse(raw: string | null): AntigravityModelCooldownState | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Record<string, unknown>
    if (Number.isInteger(v.strikes) && typeof v.until === 'number' && Number.isFinite(v.until)) {
      return { strikes: v.strikes as number, until: v.until }
    }
  } catch {
    // corrupt entry: treat as absent
  }
  return null
}

async function read(k: string, now: number): Promise<AntigravityModelCooldownState | null> {
  const kv = getAntigravityRelayKv()
  if (kv) return parse(await kv.get(k))
  const hit = memory.get(k)
  if (!hit) return null
  if (hit.expiresAt <= now) {
    memory.delete(k)
    return null
  }
  return hit.state
}

/** Record one generate-call result for the route's catalog model. */
export async function reportAntigravityModelOutcome(
  accountId: bigint,
  modelId: string,
  ok: boolean,
  deps: { now?: () => number } = {},
): Promise<void> {
  const now = (deps.now ?? Date.now)()
  const k = key(accountId, modelId)
  const kv = getAntigravityRelayKv()
  const prev = await read(k, now)
  if (ok && prev === null) return
  const next = decideAntigravityModelCooldown(prev, ok, now)
  if (next === null) {
    if (kv) await kv.del(k)
    else memory.delete(k)
    return
  }
  const ttlMs = Math.max(0, next.until - now) + ANTIGRAVITY_MODEL_COOLDOWN_POLICY.strikeWindowMs
  if (kv) await kv.set(k, JSON.stringify(next), Math.ceil(ttlMs / SEC))
  else memory.set(k, { state: next, expiresAt: now + ttlMs })
}

/** Epoch ms the model stays cooled on this account, or null if usable. */
export async function antigravityModelCoolingUntil(
  accountId: bigint,
  modelId: string,
  deps: { now?: () => number } = {},
): Promise<number | null> {
  const now = (deps.now ?? Date.now)()
  const state = await read(key(accountId, modelId), now)
  return state && state.until > now ? state.until : null
}

export function _resetAntigravityModelCooldownForTests(): void {
  memory.clear()
}
