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
import {
  cancelReleaseJob,
  clearReleaseFuse,
  getReleaseFuse,
  getReleaseJob,
  insertJobReceived,
  purgeExpiredNonces,
  recordNonceIfFresh,
} from '@openclaude/storage'
import type { CancelOutcome } from './cancel.js'
import { createLogger } from '../logger.js'
import { enqueueReleaseJob, readCommittedCutoverPlan } from './releaseIntake.js'

const log = createLogger({ module: 'selfheal-receiver' })

/** Exact dispatch path this receiver owns (see server.ts pre-auth routing). */
export const SELFHEAL_WEBHOOK_PATH = '/api/webhooks/v5-selfheal'
/** Canonical cancel path (design §A2/§C4) — same trust chain as dispatch. The
 *  legacy /internal/selfheal/cancel route is deleted. */
export const SELFHEAL_CANCEL_WEBHOOK_PATH = '/api/webhooks/v5-selfheal-cancel'
/** One-click release path (batch1b §3.1) — same trust chain as dispatch. Durable
 *  intake: a 202 means the release job is on disk; the release worker deploys it
 *  asynchronously (release is NEVER a synchronous socket action). */
export const SELFHEAL_RELEASE_WEBHOOK_PATH = '/api/webhooks/v5-selfheal-release'
/** Release-fuse clear path (batch1b §3.3) — same trust chain; body carries the
 *  fixed repairId literal "fuse" so the shared signed-string format is reused. */
export const SELFHEAL_FUSE_CLEAR_WEBHOOK_PATH = '/api/webhooks/v5-selfheal-fuse-clear'

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
  status: 200 | 202 | 400 | 401 | 403 | 409 | 413 | 423
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
 * Parse a signed command body carrying ids only (cancel). Returns null on any
 * deviation. `requireIncidentId` is set for cancel (the tombstone's NOT NULL
 * incident_id comes from the body — design §A2). An OPTIONAL `releaseRequestId`
 * (batch1b §3.2) routes cancel to a specific release job instead of the repair.
 */
export function parseSelfhealIdBody(
  raw: Buffer,
  opts: { requireIncidentId?: boolean } = {},
): { repairId: string; incidentId?: string; releaseRequestId?: string } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const p = parsed as Record<string, unknown>
  if (typeof p.repairId !== 'string' || !SELFHEAL_ID_RE.test(p.repairId)) return null
  let releaseRequestId: string | undefined
  if (p.releaseRequestId !== undefined) {
    if (typeof p.releaseRequestId !== 'string' || !SELFHEAL_ID_RE.test(p.releaseRequestId)) {
      return null
    }
    releaseRequestId = p.releaseRequestId
  }
  const withRrid = <T extends { repairId: string }>(base: T): T & { releaseRequestId?: string } =>
    releaseRequestId ? { ...base, releaseRequestId } : base
  if (opts.requireIncidentId) {
    if (typeof p.incidentId !== 'string' || !SELFHEAL_ID_RE.test(p.incidentId)) return null
    return withRrid({ repairId: p.repairId, incidentId: p.incidentId })
  }
  if (p.incidentId !== undefined) {
    if (typeof p.incidentId !== 'string' || !SELFHEAL_ID_RE.test(p.incidentId)) return null
    return withRrid({ repairId: p.repairId, incidentId: p.incidentId })
  }
  return withRrid({ repairId: p.repairId })
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

const HEX40_RE = /^[0-9a-f]{40}$/
const HEX64_RE = /^[0-9a-f]{64}$/

export interface ReleaseWebhookBody {
  repairId: string
  incidentId: string
  releaseRequestId: string
  approvedSha: string
  baseSha: string | null
  deployPlanHash: string
  manifestHash: string
}

/** Parse the v5 admin one-click release body (§3.1). Strict shape — any
 *  deviation is null (the caller answers 400). The frozen fields carried here are
 *  re-checked against the LOCAL durable cutover record; the webhook is never the
 *  authority for them. */
export function parseReleaseBody(raw: Buffer): ReleaseWebhookBody | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const p = parsed as Record<string, unknown>
  if (typeof p.repairId !== 'string' || !SELFHEAL_ID_RE.test(p.repairId)) return null
  if (typeof p.incidentId !== 'string' || !SELFHEAL_ID_RE.test(p.incidentId)) return null
  if (typeof p.releaseRequestId !== 'string' || !SELFHEAL_ID_RE.test(p.releaseRequestId)) return null
  if (typeof p.approvedSha !== 'string' || !HEX40_RE.test(p.approvedSha)) return null
  let baseSha: string | null = null
  if (p.baseSha !== null && p.baseSha !== undefined) {
    if (typeof p.baseSha !== 'string' || !HEX40_RE.test(p.baseSha)) return null
    baseSha = p.baseSha
  }
  if (typeof p.deployPlanHash !== 'string' || !HEX64_RE.test(p.deployPlanHash)) return null
  if (typeof p.manifestHash !== 'string' || !HEX64_RE.test(p.manifestHash)) return null
  return {
    repairId: p.repairId,
    incidentId: p.incidentId,
    releaseRequestId: p.releaseRequestId,
    approvedSha: p.approvedSha,
    baseSha,
    deployPlanHash: p.deployPlanHash,
    manifestHash: p.manifestHash,
  }
}

/**
 * Durable intake for the v5 admin one-click release (§3.1). Verify → local fuse
 * → LOCAL authority re-check → idempotent insert → 202. A 202 means the release
 * job is on disk; the release worker deploys it asynchronously.
 *
 *   423 release_fuse_engaged  — local Tier2 fuse tripped (v5 keeps queued, retries)
 *   409 authority_mismatch    — no local cutover record, or its frozen
 *                               sha/deployPlanHash/manifestHash != the webhook's
 *   409 release_job_conflict  — same rrid, different frozen plan
 *   202 { ok, status:'accepted', releaseRequestId }
 */
export async function receiveSelfhealRelease(
  input: SelfhealWebhookInput,
  cfg: SelfhealReceiverConfig,
  now = Date.now(),
): Promise<ReceiverResult> {
  if (input.rawBody.length > cfg.maxBodyBytes) {
    return { status: 413, body: { error: 'payload too large' } }
  }
  const body = parseReleaseBody(input.rawBody)
  if (!body) return { status: 400, body: { error: 'invalid release body' } }
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
  if (!verified.ok) return { status: verified.status, body: { error: verified.error } }

  // §3.1(1) local fuse — v5 keeps the request queued and backs off.
  const fuse = await getReleaseFuse()
  if (fuse.engaged) {
    log.warn('release refused — local fuse engaged', { repairId: body.repairId })
    return { status: 423, body: { ok: false, error: 'release_fuse_engaged' } }
  }

  // §3.1(2) LOCAL authority re-check — the durable committed cutover record is
  // the single authority; the webhook's frozen fields must match it exactly. When
  // the webhook carries a baseSha it MUST equal the local record's baseSha too
  // (§F11 authority binding — the base a plan was classified against is part of
  // its identity).
  const plan = await readCommittedCutoverPlan(body.repairId)
  if (
    !plan ||
    plan.sha !== body.approvedSha ||
    plan.deployPlanHash !== body.deployPlanHash ||
    plan.manifestHash !== body.manifestHash ||
    (body.baseSha !== null && plan.baseSha !== body.baseSha)
  ) {
    log.warn('release refused — authority mismatch', {
      repairId: body.repairId,
      haveRecord: !!plan,
    })
    return { status: 409, body: { ok: false, error: 'authority_mismatch' } }
  }

  // §3.1(3-4) idempotent durable insert (frozen from the LOCAL record).
  const result = await enqueueReleaseJob({
    repairId: body.repairId,
    incidentId: body.incidentId,
    releaseRequestId: body.releaseRequestId,
    origin: 'v5',
    plan,
  })
  if (result.outcome === 'conflict') {
    log.warn('release rrid reused with a different frozen plan', {
      repairId: body.repairId,
      releaseRequestId: body.releaseRequestId,
    })
    return { status: 409, body: { ok: false, error: 'release_job_conflict' } }
  }
  log.info('release accepted', {
    repairId: body.repairId,
    releaseRequestId: body.releaseRequestId,
    deduped: result.outcome === 'duplicate',
  })
  return {
    status: 202,
    body: { ok: true, status: 'accepted', releaseRequestId: body.releaseRequestId },
  }
}

/** Machine outcome of a release-job-scoped cancel (§3.2 + §F11). The cross-repo
 *  cancel response contract (the v5 side mirrors it exactly):
 *    200 { ok:true,  releaseCancel: 'cancelled' | 'idempotent' | 'not_found' }
 *    409 { ok:false, releaseCancel: 'too_late' | 'repair_mismatch' } */
export interface ReleaseJobCancelResult {
  status: 200 | 409
  body: {
    ok: boolean
    releaseRequestId: string
    releaseCancel: 'cancelled' | 'idempotent' | 'not_found' | 'too_late' | 'repair_mismatch'
    /** Terminal job status when releaseCancel='idempotent' (post-cancel re-read,
     *  so a concurrent worker terminalization is never mis-snapshotted). Drives
     *  the R3-1 skip decision in {@link resolveDualCancel}. */
    releaseJobStatus?: string
  }
}

/**
 * Resolve a release-job-scoped cancel (rrid present on the cancel webhook).
 * §F11 rrid↔repair binding: the signature is route-bound to the body's repairId,
 * but the rrid is a SEPARATE id, so the targeted job MUST exist AND belong to
 * that repair before we ever cancel it — a mismatched (rrid, repairId) pair is
 * 409 repair_mismatch (never cancels an unrelated repair's release). Otherwise
 * the three-state cancelReleaseJob decides (received-unclaimed→cancelled,
 * terminal→idempotent, claimed→too_late, vanished→not_found).
 */
export async function resolveReleaseJobCancel(
  releaseRequestId: string,
  repairId: string,
): Promise<ReleaseJobCancelResult> {
  const job = await getReleaseJob(releaseRequestId)
  if (!job) {
    return { status: 200, body: { ok: true, releaseRequestId, releaseCancel: 'not_found' } }
  }
  if (job.repairId !== repairId) {
    return { status: 409, body: { ok: false, releaseRequestId, releaseCancel: 'repair_mismatch' } }
  }
  const result = await cancelReleaseJob(releaseRequestId)
  const status = result === 'too_late' ? 409 : 200
  // R3-1: 'idempotent' means "already terminal" — but terminal-HOW decides whether a
  // repair-level cancel may still run (cancelled/manual_required/deploy_failed: yes;
  // deployed/deploy_unknown: the deploy effect exists, the receipt/probe owns the
  // repair's fate). Re-read AFTER the cancel so a concurrent worker terminalization
  // between the earlier getReleaseJob and cancelReleaseJob is never mis-snapshotted.
  let releaseJobStatus: string | undefined
  if (result === 'idempotent') {
    releaseJobStatus = (await getReleaseJob(releaseRequestId))?.status
  }
  return {
    status,
    body: {
      ok: result !== 'too_late',
      releaseRequestId,
      releaseCancel: result,
      ...(releaseJobStatus ? { releaseJobStatus } : {}),
    },
  }
}

/** The merged HTTP result of an rrid-scoped cancel: the release-job three-state
 *  AND the repair-level four-case, so the v5 postCancel can collect BOTH the
 *  release job and the repair in one round-trip (§3.2 + §F11 dual cancel). */
export interface DualCancelResult {
  status: number
  body: Record<string, unknown>
}

/**
 * Orchestrate an rrid-present cancel: run the release-job resolver AND the
 * repair-level cancel, then merge (R2-1 BLOCKER — the old handler dropped the
 * repair-level `terminated/accepted/status`, so v5's postCancel could never
 * settle a repair stuck `cancelling`).
 *
 * Contract (the v5 side mirrors it verbatim):
 *   - `repair_mismatch` — a suspicious (rrid, repairId) pair: keep the resolver's
 *     409 and run NO cancel of any kind (neither release job nor repair). This is
 *     the ONLY non-200 outcome now.
 *   - otherwise — BOTH ran: the resolver already applied the release-job
 *     three-state; `runRepairCancel` applies the repair four-case. The REPAIR
 *     result decides the main HTTP code (200 — the original repair contract), and
 *     `releaseCancel`/`releaseRequestId` ride along in the body. A `too_late`/
 *     `not_found`/`idempotent` release outcome is NO LONGER a separate 409 — v5
 *     reads the body value and adjudicates.
 *
 * `runRepairCancel` is a thunk so it is invoked ONLY when NOT a mismatch (the
 * skip is part of the contract), and so the whole decision is unit-testable
 * without the HTTP server or a live session backend.
 */
export async function resolveDualCancel(
  releaseOutcome: ReleaseJobCancelResult,
  runRepairCancel: () => Promise<CancelOutcome>,
): Promise<DualCancelResult> {
  if (releaseOutcome.body.releaseCancel === 'repair_mismatch') {
    return { status: releaseOutcome.status, body: releaseOutcome.body }
  }
  // R3-1 BLOCKER: when the deploy is IN FLIGHT (too_late) or its effect EXISTS /
  // is AMBIGUOUS (idempotent over deployed / deploy_unknown), the repair's fate
  // belongs to the receipt → probe pipeline — running the repair-level cancel here
  // could report terminated=true and let v5 terminal-cancel a repair whose code IS
  // live in production (the deployed receipt can then never push a terminal
  // `cancelled` repair to verifying). Skip the repair-level cancel entirely and
  // answer terminated=false so v5 leaves the repair in cancel_requested; the
  // release-scoped terminal callback settles it (deployed → verifying via the
  // cancel-state-aware CAS; unknown → fuse + human).
  const rc = releaseOutcome.body.releaseCancel
  const jobStatus = releaseOutcome.body.releaseJobStatus
  const deployOwnsRepair =
    rc === 'too_late' || (rc === 'idempotent' && (jobStatus === 'deployed' || jobStatus === 'deploy_unknown'))
  if (deployOwnsRepair) {
    return {
      status: 200,
      body: {
        ok: true,
        terminated: false,
        accepted: false,
        status: `release_${jobStatus ?? 'deploying'}`,
        releaseCancel: rc,
        releaseRequestId: releaseOutcome.body.releaseRequestId,
        ...(jobStatus ? { releaseJobStatus: jobStatus } : {}),
      },
    }
  }
  const repair = await runRepairCancel()
  return {
    status: 200,
    body: {
      ok: true,
      repairId: repair.repairId,
      terminated: repair.terminated,
      accepted: repair.accepted,
      status: repair.status,
      releaseCancel: rc,
      releaseRequestId: releaseOutcome.body.releaseRequestId,
      ...(jobStatus ? { releaseJobStatus: jobStatus } : {}),
    },
  }
}

export interface FuseClearBody {
  repairId: 'fuse'
  reason: string
  clearedBy: string
  expectedReleaseRequestId: string
}

/** Parse the fuse-clear body (§3.3): the fixed repairId literal "fuse" (so the
 *  shared HMAC signed-string format applies), the exact immutable fuse epoch,
 *  and free-text reason / clearedBy. */
export function parseFuseClearBody(raw: Buffer): FuseClearBody | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const p = parsed as Record<string, unknown>
  if (p.repairId !== 'fuse') return null
  if (typeof p.reason !== 'string' || p.reason.length === 0 || p.reason.length > 500) return null
  if (typeof p.clearedBy !== 'string' || p.clearedBy.length === 0 || p.clearedBy.length > 200) {
    return null
  }
  if (
    typeof p.expectedReleaseRequestId !== 'string' ||
    !SELFHEAL_ID_RE.test(p.expectedReleaseRequestId)
  ) {
    return null
  }
  return {
    repairId: 'fuse',
    reason: p.reason,
    clearedBy: p.clearedBy,
    expectedReleaseRequestId: p.expectedReleaseRequestId,
  }
}

/** Clear the LOCAL Tier2 release fuse (§3.3), audited. The v5 side initiates
 *  this only after a human-audited PG-side clear (double-sided convergence). */
export async function receiveSelfhealFuseClear(
  input: SelfhealWebhookInput,
  cfg: SelfhealReceiverConfig,
  now = Date.now(),
): Promise<ReceiverResult> {
  if (input.rawBody.length > cfg.maxBodyBytes) {
    return { status: 413, body: { error: 'payload too large' } }
  }
  const body = parseFuseClearBody(input.rawBody)
  if (!body) return { status: 400, body: { error: 'invalid fuse-clear body' } }
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
  if (!verified.ok) return { status: verified.status, body: { error: verified.error } }
  const result = await clearReleaseFuse({
    clearedBy: body.clearedBy,
    expectedReleaseRequestId: body.expectedReleaseRequestId,
    now: new Date(now).toISOString(),
  })
  // Durable audit line — the fuse clear is a privileged Tier2 gate reset.
  log.warn('selfheal release fuse clear', {
    clearedBy: body.clearedBy,
    reason: body.reason,
    expectedReleaseRequestId: body.expectedReleaseRequestId,
    outcome: result.outcome,
    ...(result.outcome === 'epoch_mismatch'
      ? { currentReleaseRequestId: result.currentReleaseRequestId }
      : {}),
  })
  if (result.outcome === 'epoch_mismatch') {
    return {
      status: 409,
      body: {
        ok: false,
        error: 'release_fuse_epoch_mismatch',
        expectedReleaseRequestId: body.expectedReleaseRequestId,
        currentReleaseRequestId: result.currentReleaseRequestId,
      },
    }
  }
  return {
    status: 200,
    body: {
      ok: true,
      cleared: true,
      releaseRequestId: result.releaseRequestId,
      outcome: result.outcome,
    },
  }
}
