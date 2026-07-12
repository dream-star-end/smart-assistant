// Self-heal webhook receiver (slice ② / block B2a, contract §派单请求).
//
// This is the DURABLE intake for repair dispatches from the v5 (Aurora)
// dispatcher. It replaces the legacy "emit an in-memory event and return"
// webhook shape: a 202 is returned to v5 ONLY after the repair is committed to
// selfheal.db, so a gateway crash between accept and execution never loses a
// dispatch (the jobWorker drains persisted `received` jobs on restart).
//
// Authentication is HMAC-only and intentionally bypasses the gateway's global
// Bearer gate (server.ts routes this exact path before the /api/* auth guard).
// The trust chain is layered so each cheap check fences the next:
//
//   1. remoteAddress is loopback   — only the reverse SSH tunnel reaches here.
//   2. raw body size cap           — bound work BEFORE hashing/parsing.
//   3. timestamp within ±120s      — bound the replay window.
//   4. HMAC-SHA256 match           — proves the sender holds the shared secret.
//   5. atomic nonce not-seen       — rejects replays of authenticated requests.
//
// Ordering note: we verify the HMAC BEFORE recording the nonce so that
// unauthenticated traffic can never mutate durable state (nonce table). Replay
// defense is unaffected — a replayed *authentic* request re-presents the same
// nonce, which the atomic INSERT rejects, and anything older than the window is
// already rejected at step 3.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { insertJobReceived, purgeExpiredNonces, recordNonceIfFresh } from '@openclaude/storage'
import { createLogger } from '../logger.js'

const log = createLogger({ module: 'selfheal-receiver' })

/** Exact dispatch path this receiver owns (see server.ts pre-auth routing). */
export const SELFHEAL_WEBHOOK_PATH = '/api/webhooks/v5-selfheal'
/** Canonical cancel path (design §A2/§C4) — same trust chain as dispatch. The
 *  legacy /internal/selfheal/cancel route is deleted. */
export const SELFHEAL_CANCEL_WEBHOOK_PATH = '/api/webhooks/v5-selfheal-cancel'
/** One-click release path (design §C3) — same trust chain as dispatch; the only
 *  remote entry into broker.releaseApproved (release is NEVER a socket action). */
export const SELFHEAL_RELEASE_WEBHOOK_PATH = '/api/webhooks/v5-selfheal-release'

const DEFAULT_MAX_BODY_BYTES = 8 * 1024 // dispatch bodies are 3 ids — kilobytes, not megabytes
const DEFAULT_TS_TOLERANCE_MS = 120_000
const DEFAULT_NONCE_TTL_MS = 10 * 60_000 // comfortably > ts window; purge floor

export interface SelfhealReceiverConfig {
  hmacSecret: string
  maxBodyBytes: number
  tsToleranceMs: number
  nonceTtlMs: number
}

/**
 * Build the receiver config from env, or return null when the feature is not
 * configured (no shared secret) so server.ts can treat the endpoint as absent.
 * Env is read directly (not via config.ts, which is owned by another slice).
 */
export function getSelfhealReceiverConfig(
  env: NodeJS.ProcessEnv = process.env,
): SelfhealReceiverConfig | null {
  const hmacSecret = env.OC_SELFHEAL_WEBHOOK_HMAC?.trim()
  if (!hmacSecret) return null
  const maxBodyBytes = Number(env.OC_SELFHEAL_MAX_BODY_BYTES) || DEFAULT_MAX_BODY_BYTES
  return {
    hmacSecret,
    maxBodyBytes,
    tsToleranceMs: DEFAULT_TS_TOLERANCE_MS,
    nonceTtlMs: DEFAULT_NONCE_TTL_MS,
  }
}

export interface SelfhealWebhookInput {
  remoteAddress: string | undefined
  /** HTTP method — part of the signed string (route binding, design §A6/M3). */
  method: string | undefined
  /** URL pathname (no query) — part of the signed string (route binding). */
  path: string | undefined
  ts: string | undefined
  nonce: string | undefined
  sig: string | undefined
  /** Raw request body bytes. HMAC is computed over sha256(rawBody). */
  rawBody: Buffer
}

export interface ReceiverResult {
  status: 202 | 400 | 401 | 403 | 409 | 413
  body: Record<string, unknown>
}

/** True for 127.0.0.0/8, ::1, and IPv4-mapped loopback. */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false
  const a = addr.trim()
  if (a === '::1' || a === '::ffff:127.0.0.1') return true
  const v4 = a.startsWith('::ffff:') ? a.slice('::ffff:'.length) : a
  return v4.startsWith('127.')
}

interface DispatchBody {
  repairId: string
  incidentId: string
  attempt: number
}

function parseDispatchBody(raw: Buffer): DispatchBody | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const p = parsed as Record<string, unknown>
  const repairId = p.repairId
  const incidentId = p.incidentId
  const attempt = p.attempt
  // Structured, id-only body (contract: no free text → no injection surface).
  if (typeof repairId !== 'string' || !repairId) return null
  if (typeof incidentId !== 'string' || !incidentId) return null
  if (typeof attempt !== 'number' || !Number.isFinite(attempt) || attempt < 0) return null
  // Constrain id shapes so they are safe as session-key / path components.
  if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(repairId)) return null
  if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(incidentId)) return null
  return { repairId, incidentId, attempt: Math.floor(attempt) }
}

/** Constant-time hex-string comparison (length-safe). */
function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false
  let ba: Buffer
  let bb: Buffer
  try {
    ba = Buffer.from(a, 'hex')
    bb = Buffer.from(b, 'hex')
  } catch {
    return false
  }
  if (ba.length !== bb.length || ba.length === 0) return false
  return timingSafeEqual(ba, bb)
}

export type VerifyResult = { ok: true } | { ok: false; status: 401 | 403 | 413; error: string }

/**
 * Build the canonical signed string. SINGLE AUTHORITY for the HMAC contract —
 * the receiver (inbound verify) and jobWorker (outbound signing) both use this,
 * and the v5 side mirrors it exactly (design §A6/M3, route-bound signatures):
 *
 *   `${METHOD}.${path}.${ts}.${nonce}.${repairId}.${bodySha256}`
 *
 * METHOD is uppercased; path is the URL pathname WITHOUT query. Binding the
 * route into the signature makes a signature minted for one endpoint (e.g.
 * dispatch) unusable against another (e.g. cancel/release).
 */
export function selfhealSignedString(input: {
  method: string
  path: string
  ts: string
  nonce: string
  repairId: string
  bodySha256: string
}): string {
  return `${input.method.toUpperCase()}.${input.path}.${input.ts}.${input.nonce}.${input.repairId}.${input.bodySha256}`
}

/**
 * Shared trust chain for every inbound self-heal request (dispatch, cancel AND
 * release): loopback → size cap → ts window → HMAC → atomic nonce. `repairId`
 * is passed in because it is part of the signed string but lives in the
 * (caller-parsed) body; `method`/`path` bind the signature to the exact route.
 *
 * HMAC is verified BEFORE the nonce is recorded so unauthenticated traffic can
 * never mutate the nonce table; replay defense is unaffected (see module header).
 */
export async function verifySelfhealSignedRequest(
  input: {
    remoteAddress: string | undefined
    method: string | undefined
    path: string | undefined
    ts: string | undefined
    nonce: string | undefined
    sig: string | undefined
    rawBody: Buffer
    repairId: string
  },
  cfg: SelfhealReceiverConfig,
  now = Date.now(),
): Promise<VerifyResult> {
  if (!isLoopbackAddress(input.remoteAddress)) {
    log.warn('rejected non-loopback request', { remoteAddress: input.remoteAddress })
    return { ok: false, status: 403, error: 'forbidden' }
  }
  if (input.rawBody.length > cfg.maxBodyBytes) {
    return { ok: false, status: 413, error: 'payload too large' }
  }
  if (!input.method || !input.path || !input.path.startsWith('/')) {
    return { ok: false, status: 401, error: 'missing method or path' }
  }
  const ts = Number(input.ts)
  if (!input.ts || !Number.isFinite(ts) || Math.abs(now - ts) > cfg.tsToleranceMs) {
    return { ok: false, status: 401, error: 'stale or missing timestamp' }
  }
  const { nonce, sig } = input
  if (!nonce || !sig) {
    return { ok: false, status: 401, error: 'missing nonce or signature' }
  }
  const bodySha256 = createHash('sha256').update(input.rawBody).digest('hex')
  const signed = selfhealSignedString({
    method: input.method,
    path: input.path,
    ts: input.ts,
    nonce,
    repairId: input.repairId,
    bodySha256,
  })
  const expected = createHmac('sha256', cfg.hmacSecret).update(signed).digest('hex')
  if (!timingSafeHexEqual(expected, sig)) {
    log.warn('rejected bad signature', { repairId: input.repairId, path: input.path })
    return { ok: false, status: 401, error: 'invalid signature' }
  }
  const fresh = await recordNonceIfFresh(nonce, now)
  if (!fresh) {
    log.warn('rejected replayed nonce', { repairId: input.repairId })
    return { ok: false, status: 401, error: 'replayed nonce' }
  }
  purgeExpiredNonces(cfg.nonceTtlMs, now).catch(() => {})
  return { ok: true }
}

/** sha256 hex of the raw body — the payload hash used for job idempotency. */
export function bodyPayloadHash(rawBody: Buffer): string {
  return createHash('sha256').update(rawBody).digest('hex')
}

/** Shared id-shape constraint (safe as session-key / path components). */
const SELFHEAL_ID_RE = /^[a-zA-Z0-9_.:-]{1,128}$/

/**
 * Parse a signed command body carrying ids only (cancel / release). Returns
 * null on any deviation. `requireIncidentId` is set for cancel (the tombstone's
 * NOT NULL incident_id comes from the body — design §A2).
 */
export function parseSelfhealIdBody(
  raw: Buffer,
  opts: { requireIncidentId?: boolean } = {},
): { repairId: string; incidentId?: string } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const p = parsed as Record<string, unknown>
  if (typeof p.repairId !== 'string' || !SELFHEAL_ID_RE.test(p.repairId)) return null
  if (opts.requireIncidentId) {
    if (typeof p.incidentId !== 'string' || !SELFHEAL_ID_RE.test(p.incidentId)) return null
    return { repairId: p.repairId, incidentId: p.incidentId }
  }
  if (p.incidentId !== undefined) {
    if (typeof p.incidentId !== 'string' || !SELFHEAL_ID_RE.test(p.incidentId)) return null
    return { repairId: p.repairId, incidentId: p.incidentId }
  }
  return { repairId: p.repairId }
}

/**
 * Verify + durably record one dispatch. Pure of any HTTP/transport concerns:
 * server.ts adapts req/res to {@link SelfhealWebhookInput} and this result.
 *
 * Returns:
 *   202 { ok, repairId, deduped } — committed (or idempotent duplicate)
 *   409 { error }                 — repair_id reused with a different payload
 *   413 { error }                 — body over cap
 *   401 { error }                 — bad/missing signature, ts, or replayed nonce
 *   403 { error }                 — non-loopback source
 *   400 { error }                 — malformed body
 */
export async function receiveSelfhealDispatch(
  input: SelfhealWebhookInput,
  cfg: SelfhealReceiverConfig,
  now = Date.now(),
): Promise<ReceiverResult> {
  // Loopback + size are re-checked inside verify, but parse must succeed first
  // to extract repairId (it is part of the signed string). Size is cheap to
  // gate up front so we don't parse an oversized body.
  if (input.rawBody.length > cfg.maxBodyBytes) {
    return { status: 413, body: { error: 'payload too large' } }
  }
  const body = parseDispatchBody(input.rawBody)
  if (!body) {
    return { status: 400, body: { error: 'invalid dispatch body' } }
  }
  const verified = await verifySelfhealSignedRequest(
    {
      remoteAddress: input.remoteAddress,
      method: input.method,
      path: input.path,
      ts: input.ts,
      nonce: input.nonce,
      sig: input.sig,
      rawBody: input.rawBody,
      repairId: body.repairId,
    },
    cfg,
    now,
  )
  if (!verified.ok) {
    return { status: verified.status, body: { error: verified.error } }
  }

  // Durable commit — payloadHash = sha256(rawBody), so a repair_id re-dispatched
  // with an identical body is idempotent, and a differing body is a 409 conflict.
  const result = await insertJobReceived({
    repairId: body.repairId,
    incidentId: body.incidentId,
    attempt: body.attempt,
    payloadHash: bodyPayloadHash(input.rawBody),
  })
  if (result.outcome === 'conflict') {
    log.warn('repair_id reused with different payload', { repairId: body.repairId })
    return { status: 409, body: { error: 'repair_id conflict' } }
  }
  log.info('dispatch accepted', {
    repairId: body.repairId,
    incidentId: body.incidentId,
    attempt: body.attempt,
    deduped: result.outcome === 'duplicate',
  })
  return {
    status: 202,
    body: { ok: true, repairId: body.repairId, deduped: result.outcome === 'duplicate' },
  }
}
