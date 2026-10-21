/**
 * Short-lived opaque Antigravity relay routes (OCV5-415 P2).
 * A token is bound to container + user + requestId + canonical model + the
 * gemini OAuth account picked for the turn. No credential is stored here.
 *
 * Hosted turns mint on master and are consumed on egress, so production MUST
 * configure the shared KV (Redis); tests keep the in-memory map.
 */
import { createHash, randomBytes } from 'node:crypto'

import { ANTIGRAVITY_RELAY_PREFIX, isAntigravityEngineModel } from '@openclaude/protocol'

export { ANTIGRAVITY_RELAY_PREFIX }
/**
 * Idle window: each call that finds less than half of it left renews it, so a
 * long turn keeps its route (OCV5-556: an 82-minute turn outlived a fixed
 * 60-minute route). The bridge expires the route when the turn ends.
 */
export const ANTIGRAVITY_RELAY_TTL_MS = 60 * 60 * 1000
/** Renewals stop here, counted from mint, for turns that never end. */
export const ANTIGRAVITY_RELAY_MAX_LIFETIME_MS = 6 * 60 * 60 * 1000

const TOKEN_RE = /^[0-9a-f]{64}$/
const REQUEST_ID_RE = /^[0-9a-f]{32}$/
const KV_PREFIX = 'oc:v5:antigravity-relay:'
/** requestKey value once the turn ended; a racing renewal sees it and backs out. */
const EXPIRED_MARK = 'expired'

export type AntigravityRelayRoute = {
  token: string
  containerId: number
  userId: bigint
  requestId: string
  modelId: string
  accountId: bigint
  /** Spendable credits at admission; the relay stops new generate calls past it. */
  budgetCredits: bigint
  expiresAt: number
  /** Renewal ceiling; rows minted before renewal existed carry expiresAt here. */
  maxExpiresAt: number
}

export type AntigravityRelayKv = {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlSec: number): Promise<void>
  del(key: string): Promise<void>
}

const routes = new Map<string, AntigravityRelayRoute>()
let kv: AntigravityRelayKv | null = null

export function configureAntigravityRelayKv(next: AntigravityRelayKv | null): void {
  kv = next
}

function tokenKey(token: string): string {
  return `${KV_PREFIX}${createHash('sha256').update(token, 'utf8').digest('hex')}`
}

/** requestId → token key, so whichever bridge sees the terminal frame can expire the route. */
function requestKey(requestId: string): string {
  return `${KV_PREFIX}req:${requestId}`
}

function serialize(row: AntigravityRelayRoute): string {
  return JSON.stringify({
    containerId: row.containerId,
    userId: row.userId.toString(),
    requestId: row.requestId,
    modelId: row.modelId,
    accountId: row.accountId.toString(),
    budgetCredits: row.budgetCredits.toString(),
    expiresAt: row.expiresAt,
    maxExpiresAt: row.maxExpiresAt,
  })
}

function deserialize(token: string, raw: string): AntigravityRelayRoute | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const body = parsed as Record<string, unknown>
  if (!Number.isInteger(body.containerId) || (body.containerId as number) <= 0) return null
  if (typeof body.userId !== 'string' || !/^\d+$/.test(body.userId)) return null
  if (typeof body.accountId !== 'string' || !/^\d+$/.test(body.accountId)) return null
  if (typeof body.budgetCredits !== 'string' || !/^\d+$/.test(body.budgetCredits)) return null
  if (typeof body.requestId !== 'string' || !REQUEST_ID_RE.test(body.requestId)) return null
  if (typeof body.modelId !== 'string' || !isAntigravityEngineModel(body.modelId)) return null
  if (typeof body.expiresAt !== 'number' || !Number.isFinite(body.expiresAt)) return null
  const maxExpiresAt =
    typeof body.maxExpiresAt === 'number' && Number.isFinite(body.maxExpiresAt)
      ? body.maxExpiresAt
      : body.expiresAt
  return {
    token,
    containerId: body.containerId as number,
    userId: BigInt(body.userId),
    requestId: body.requestId,
    modelId: body.modelId,
    accountId: BigInt(body.accountId),
    budgetCredits: BigInt(body.budgetCredits),
    expiresAt: body.expiresAt,
    maxExpiresAt,
  }
}

export async function mintAntigravityRelayRoute(args: {
  containerId: number
  userId: bigint | number
  requestId: string
  modelId: string
  accountId: bigint
  budgetCredits: bigint
  relayPort: number
  nowMs?: number
  ttlMs?: number
  maxLifetimeMs?: number
}): Promise<{ token: string; baseUrl: string }> {
  if (!Number.isInteger(args.containerId) || args.containerId <= 0) {
    throw new Error('antigravity relay containerId is invalid')
  }
  if (!REQUEST_ID_RE.test(args.requestId)) {
    throw new Error('antigravity relay requestId is invalid')
  }
  if (!isAntigravityEngineModel(args.modelId)) {
    throw new Error('antigravity relay model is not allowlisted')
  }
  if (args.budgetCredits <= 0n) {
    throw new Error('antigravity relay budget must be positive')
  }
  if (!Number.isInteger(args.relayPort) || args.relayPort <= 0 || args.relayPort > 65535) {
    throw new Error('antigravity relay port is invalid')
  }
  const token = randomBytes(32).toString('hex')
  const now = args.nowMs ?? Date.now()
  const ttl = args.ttlMs ?? ANTIGRAVITY_RELAY_TTL_MS
  const maxExpiresAt = now + Math.max(ttl, args.maxLifetimeMs ?? ANTIGRAVITY_RELAY_MAX_LIFETIME_MS)
  const row: AntigravityRelayRoute = {
    token,
    containerId: args.containerId,
    userId: BigInt(args.userId),
    requestId: args.requestId,
    modelId: args.modelId,
    accountId: args.accountId,
    budgetCredits: args.budgetCredits,
    expiresAt: now + ttl,
    maxExpiresAt,
  }
  if (kv) {
    await kv.set(tokenKey(token), serialize(row), ttlSeconds(ttl))
    // Outlives every renewal of the token key, so the turn end can always find it.
    await kv.set(requestKey(args.requestId), tokenKey(token), ttlSeconds(maxExpiresAt - now))
  } else {
    routes.set(token, row)
  }
  return {
    token,
    baseUrl: `http://127.0.0.1:${args.relayPort}${ANTIGRAVITY_RELAY_PREFIX}/route/${token}`,
  }
}

export async function resolveAntigravityRelayRoute(args: {
  token: string
  containerId: number
  userId: bigint | number
  nowMs?: number
}): Promise<AntigravityRelayRoute | null> {
  if (!TOKEN_RE.test(args.token)) return null
  const now = args.nowMs ?? Date.now()
  let row: AntigravityRelayRoute | null = null
  if (kv) {
    const raw = await kv.get(tokenKey(args.token))
    row = raw ? deserialize(args.token, raw) : null
  } else {
    row = routes.get(args.token) ?? null
  }
  if (!row) return null
  if (row.expiresAt <= now) {
    await expireAntigravityRelayRoute(args.token)
    return null
  }
  if (row.containerId !== args.containerId) return null
  if (row.userId !== BigInt(args.userId)) return null
  // A renewal racing the turn end can briefly write the token key back; the
  // request's mark is authoritative, so no call is served after the turn ended.
  if (kv && (await kv.get(requestKey(row.requestId))) === EXPIRED_MARK) {
    await kv.del(tokenKey(row.token))
    return null
  }
  return renewIfDue(row, now)
}

function ttlSeconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000))
}

async function renewIfDue(
  row: AntigravityRelayRoute,
  now: number,
): Promise<AntigravityRelayRoute | null> {
  const next = Math.min(now + ANTIGRAVITY_RELAY_TTL_MS, row.maxExpiresAt)
  if (row.expiresAt - now >= ANTIGRAVITY_RELAY_TTL_MS / 2 || next <= row.expiresAt) return row
  const renewed = { ...row, expiresAt: next }
  if (!kv) {
    // An expired route is gone from the map; renewing a detached row revives nothing.
    if (routes.get(row.token) === row) routes.set(row.token, renewed)
    return renewed
  }
  await kv.set(tokenKey(row.token), serialize(renewed), ttlSeconds(next - now))
  // expireAntigravityRelayRouteForRequest marks the request before deleting the
  // token key: if the mark is here now, this write may have put the key back.
  if ((await kv.get(requestKey(row.requestId))) === EXPIRED_MARK) {
    await kv.del(tokenKey(row.token))
    return null
  }
  return renewed
}

export async function expireAntigravityRelayRoute(token: string): Promise<void> {
  if (!TOKEN_RE.test(token)) return
  if (kv) {
    await kv.del(tokenKey(token))
    return
  }
  routes.delete(token)
}

/**
 * Expire the route of one turn by its requestId (OCV5-415). The turn's terminal frame may reach
 * a reconnected bridge that never saw the token; a closed bridge no longer expires routes,
 * because the container keeps running the turn across browser reconnects.
 */
export async function expireAntigravityRelayRouteForRequest(requestId: string): Promise<void> {
  if (!REQUEST_ID_RE.test(requestId)) return
  if (kv) {
    const key = await kv.get(requestKey(requestId))
    if (key === EXPIRED_MARK) return
    await kv.set(requestKey(requestId), EXPIRED_MARK, ttlSeconds(ANTIGRAVITY_RELAY_MAX_LIFETIME_MS))
    if (key?.startsWith(KV_PREFIX) && !key.startsWith(`${KV_PREFIX}req:`)) await kv.del(key)
    return
  }
  for (const [token, row] of routes) if (row.requestId === requestId) routes.delete(token)
}

export function _resetAntigravityRelayRoutesForTests(): void {
  routes.clear()
  kv = null
}
