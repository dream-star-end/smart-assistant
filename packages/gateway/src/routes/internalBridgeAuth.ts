/**
 * Fail-closed internal bridge authentication & anti-replay verification for
 * master → container `/internal/*` routes (Office preview & Swarm control commands).
 *
 * Security invariants (B7 / OCV5-832 R2):
 *   1. Valid env (`OPENCLAUDE_TRUST_BRIDGE_IP`, `OC_CONTAINER_ID`, `OC_BRIDGE_NONCE`)
 *   2. Remote socket IP matches `OPENCLAUDE_TRUST_BRIDGE_IP` (IPv4 or IPv4-mapped IPv6)
 *   3. `X-Oc-Container-Id` matches `OC_CONTAINER_ID`
 *   4. Per-request freshness & HMAC signature (`X-Oc-Bridge-Ts`, `X-Oc-Bridge-Nonce`,
 *      `X-Oc-Bridge-Sig`) keyed by a domain-separated signing key derived from the shared
 *      per-container `OC_BRIDGE_NONCE` secret (NEVER transmitted in request headers),
 *      bound to containerId + METHOD + canonical path/query + SHA-256(body)
 *   5. Single-use nonce replay rejection via TTL cache that NEVER evicts unexpired nonces
 *      (replays -> 409 REPLAY_REJECTED; full active window -> 503 REPLAY_CACHE_FULL).
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { isIPv4 } from 'node:net'

export const BRIDGE_CONTAINER_ID_HEADER = 'x-oc-container-id'
export const BRIDGE_TS_HEADER = 'x-oc-bridge-ts'
export const BRIDGE_NONCE_HEADER = 'x-oc-bridge-nonce'
/** Alias kept for backwards compatibility with existing imports. */
export const BRIDGE_REQ_NONCE_HEADER = BRIDGE_NONCE_HEADER
export const BRIDGE_SIG_HEADER = 'x-oc-bridge-sig'

export const DEFAULT_BRIDGE_MAX_SKEW_MS = 60_000
const DEFAULT_REPLAY_CACHE_MAX_ENTRIES = 20_000
const SAFE_REQ_NONCE_RE = /^[A-Za-z0-9._:-]{16,128}$/
const SIGNING_KEY_DOMAIN = 'openclaude:internal-bridge-sig:v2'

export type ReplayCacheConsumeStatus = 'accepted' | 'replay' | 'capacity_exceeded'

export class InternalBridgeReplayCache {
  private readonly seen = new Map<string, number>()
  private readonly maxEntries: number

  constructor(opts?: { maxEntries?: number }) {
    this.maxEntries = opts?.maxEntries ?? DEFAULT_REPLAY_CACHE_MAX_ENTRIES
  }

  /**
   * Consume a single-use request nonce for `ttlMs`:
   *   - `'replay'` if `nonce` is still within its active TTL window.
   *   - `'capacity_exceeded'` if cache is full of UNEXPIRED nonces (fail-closed overload
   *     rejection; NEVER evicts unexpired entries before their TTL expires).
   *   - `'accepted'` after recording `nonce` until `nowMs + ttlMs`.
   */
  consume(nonce: string, nowMs: number, ttlMs: number): ReplayCacheConsumeStatus {
    const existing = this.seen.get(nonce)
    if (existing !== undefined && existing > nowMs) {
      return 'replay'
    }
    if (existing !== undefined) {
      this.seen.delete(nonce)
    }
    if (this.seen.size >= this.maxEntries) {
      this.prune(nowMs)
      if (this.seen.size >= this.maxEntries) {
        return 'capacity_exceeded'
      }
    }
    this.seen.set(nonce, nowMs + Math.max(1_000, ttlMs))
    return 'accepted'
  }

  prune(nowMs = Date.now()): void {
    for (const [k, exp] of this.seen) {
      if (exp <= nowMs) this.seen.delete(k)
    }
  }

  size(): number {
    return this.seen.size
  }

  clear(): void {
    this.seen.clear()
  }
}

const defaultReplayCache = new InternalBridgeReplayCache()

function deriveInternalBridgeSigningKey(sharedContainerSecretHex: string): Buffer {
  return createHmac('sha256', Buffer.from(sharedContainerSecretHex, 'hex'))
    .update(SIGNING_KEY_DOMAIN)
    .digest()
}

/**
 * Canonicalize `pathAndQuery` deterministically so signatures match identically
 * across direct local HTTP and remote Go node-agent tunnels (which re-encode query params).
 */
export function canonicalizeBridgePathAndQuery(rawUrl: string): string {
  const parsed = new URL(rawUrl || '/', 'http://container.internal')
  const entries = Array.from(parsed.searchParams.entries()).sort((a, b) => {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1
    return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0
  })
  if (entries.length === 0) return parsed.pathname
  const qs = entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
  return `${parsed.pathname}?${qs}`
}

export function computeInternalBridgeRequestSig(params: {
  containerId?: number | string
  bridgeNonce: string
  ts: string
  reqNonce: string
  method: string
  pathAndQuery: string
  body?: Buffer | string | null
}): string {
  const bodyBuf =
    params.body === undefined || params.body === null
      ? Buffer.alloc(0)
      : Buffer.isBuffer(params.body)
        ? params.body
        : Buffer.from(params.body, 'utf8')
  const bodySha256 = createHash('sha256').update(bodyBuf).digest('hex')
  const canonicalTarget = canonicalizeBridgePathAndQuery(params.pathAndQuery)
  const payload = [
    String(params.containerId ?? ''),
    params.ts,
    params.reqNonce,
    params.method.toUpperCase(),
    canonicalTarget,
    bodySha256,
  ].join('\n')
  const signingKey = deriveInternalBridgeSigningKey(params.bridgeNonce)
  return createHmac('sha256', signingKey).update(payload).digest('hex')
}

/**
 * Build per-request signed internal bridge headers.
 * NEVER transmits the shared per-container secret (`bridgeNonce` / `bridgeToken`) on the wire.
 */
export function buildSignedInternalBridgeHeaders(params: {
  containerId: number | string
  bridgeNonce: string
  method: string
  pathAndQuery: string
  body?: Buffer | string | null
  nowMs?: number
  reqNonce?: string
}): Record<string, string> {
  const ts = String(Math.trunc(params.nowMs ?? Date.now()))
  const reqNonce = params.reqNonce ?? randomBytes(16).toString('hex')
  const sig = computeInternalBridgeRequestSig({
    containerId: params.containerId,
    bridgeNonce: params.bridgeNonce,
    ts,
    reqNonce,
    method: params.method,
    pathAndQuery: params.pathAndQuery,
    body: params.body,
  })
  return {
    'X-Oc-Container-Id': String(params.containerId),
    'X-Oc-Bridge-Ts': ts,
    'X-Oc-Bridge-Nonce': reqNonce,
    'X-Oc-Bridge-Sig': sig,
  }
}

export interface InternalBridgeAuthOptions {
  env?: NodeJS.ProcessEnv
  body?: Buffer | string | null
  now?: () => number
  maxSkewMs?: number
  replayCache?: InternalBridgeReplayCache
}

export type InternalBridgeAuthResult =
  | { ok: true }
  | {
      ok: false
      status: 401 | 409 | 503
      code: 'UNAUTHORIZED' | 'REPLAY_REJECTED' | 'REPLAY_CACHE_FULL'
      error: string
    }

function headerStr(req: IncomingMessage, name: string): string {
  const raw = req.headers[name.toLowerCase()]
  return (Array.isArray(raw) ? raw[0] : raw ?? '').trim()
}

/**
 * Cheap pre-body check: verifies IP, container ID, and presence/freshness of signed
 * anti-replay headers so unauthenticated callers cannot force the server to buffer POST bodies.
 */
export function verifyInternalBridgeHeaderPrecheck(
  req: IncomingMessage,
  opts: Omit<InternalBridgeAuthOptions, 'body' | 'replayCache'> = {},
): InternalBridgeAuthResult {
  const env = opts.env ?? process.env
  const trustIp = (env.OPENCLAUDE_TRUST_BRIDGE_IP || '').trim()
  const containerId = (env.OC_CONTAINER_ID || '').trim()
  const bridgeNonce = (env.OC_BRIDGE_NONCE || '').trim()

  if (!trustIp || !containerId || !bridgeNonce) {
    return { ok: false, status: 401, code: 'UNAUTHORIZED', error: 'unauthorized' }
  }
  if (!isIPv4(trustIp)) {
    return { ok: false, status: 401, code: 'UNAUTHORIZED', error: 'unauthorized' }
  }
  if (!/^[1-9][0-9]{0,18}$/.test(containerId)) {
    return { ok: false, status: 401, code: 'UNAUTHORIZED', error: 'unauthorized' }
  }
  if (!/^[0-9a-f]{64}$/i.test(bridgeNonce)) {
    return { ok: false, status: 401, code: 'UNAUTHORIZED', error: 'unauthorized' }
  }

  const remoteIp = req.socket?.remoteAddress || ''
  if (remoteIp !== trustIp && remoteIp !== `::ffff:${trustIp}`) {
    return { ok: false, status: 401, code: 'UNAUTHORIZED', error: 'unauthorized' }
  }

  const hdrId = headerStr(req, BRIDGE_CONTAINER_ID_HEADER)
  if (hdrId !== containerId) {
    return { ok: false, status: 401, code: 'UNAUTHORIZED', error: 'unauthorized' }
  }

  const tsStr = headerStr(req, BRIDGE_TS_HEADER)
  if (!/^\d{10,16}$/.test(tsStr)) {
    return { ok: false, status: 401, code: 'UNAUTHORIZED', error: 'missing or invalid bridge timestamp' }
  }
  const tsMs = Number(tsStr)
  const nowMs = (opts.now ?? Date.now)()
  const maxSkewMs = opts.maxSkewMs ?? DEFAULT_BRIDGE_MAX_SKEW_MS
  if (!Number.isFinite(tsMs) || Math.abs(nowMs - tsMs) > maxSkewMs) {
    return { ok: false, status: 401, code: 'UNAUTHORIZED', error: 'bridge request timestamp expired' }
  }

  const reqNonce = headerStr(req, BRIDGE_NONCE_HEADER)
  if (!SAFE_REQ_NONCE_RE.test(reqNonce)) {
    return { ok: false, status: 401, code: 'UNAUTHORIZED', error: 'missing or invalid bridge request nonce' }
  }

  const sig = headerStr(req, BRIDGE_SIG_HEADER)
  if (!/^[0-9a-f]{64}$/i.test(sig)) {
    return { ok: false, status: 401, code: 'UNAUTHORIZED', error: 'missing or invalid bridge signature' }
  }

  return { ok: true }
}

/**
 * Full fail-closed internal bridge verification including per-request HMAC signature
 * (bound to containerId + METHOD + canonical path/query + SHA-256(body)) and
 * non-evicting TTL single-use nonce replay rejection.
 */
export function verifyInternalBridgeAuthDetailed(
  req: IncomingMessage,
  opts: InternalBridgeAuthOptions = {},
): InternalBridgeAuthResult {
  const pre = verifyInternalBridgeHeaderPrecheck(req, opts)
  if (!pre.ok) return pre

  const env = opts.env ?? process.env
  const containerId = (env.OC_CONTAINER_ID || '').trim()
  const bridgeNonce = (env.OC_BRIDGE_NONCE || '').trim()
  const tsStr = headerStr(req, BRIDGE_TS_HEADER)
  const reqNonce = headerStr(req, BRIDGE_NONCE_HEADER)
  const sig = headerStr(req, BRIDGE_SIG_HEADER)

  const expectedSig = computeInternalBridgeRequestSig({
    containerId,
    bridgeNonce,
    ts: tsStr,
    reqNonce,
    method: req.method ?? 'GET',
    pathAndQuery: req.url ?? '/',
    body: opts.body,
  })
  try {
    if (!timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expectedSig, 'hex'))) {
      return { ok: false, status: 401, code: 'UNAUTHORIZED', error: 'bridge signature mismatch' }
    }
  } catch {
    return { ok: false, status: 401, code: 'UNAUTHORIZED', error: 'bridge signature mismatch' }
  }

  const nowMs = (opts.now ?? Date.now)()
  const maxSkewMs = opts.maxSkewMs ?? DEFAULT_BRIDGE_MAX_SKEW_MS
  const cache = opts.replayCache ?? defaultReplayCache
  const consumeStatus = cache.consume(reqNonce, nowMs, maxSkewMs * 2)
  if (consumeStatus === 'replay') {
    return { ok: false, status: 409, code: 'REPLAY_REJECTED', error: 'bridge request replay rejected' }
  }
  if (consumeStatus === 'capacity_exceeded') {
    return {
      ok: false,
      status: 503,
      code: 'REPLAY_CACHE_FULL',
      error: 'bridge replay cache at capacity',
    }
  }
  return { ok: true }
}

export function verifyInternalBridgeAuth(
  req: IncomingMessage,
  env: NodeJS.ProcessEnv = process.env,
  opts: Omit<InternalBridgeAuthOptions, 'env'> = {},
): boolean {
  return verifyInternalBridgeAuthDetailed(req, { ...opts, env }).ok
}
