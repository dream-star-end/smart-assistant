/** Billing for a remote-pool chat lane: the canonical model is the lane binding's, the native
 * upstream model is the one its node runs. Recovery only settles a durable original receipt;
 * it cannot launch a worker.
 */
import { isDeepStrictEqual } from 'node:util'
import { constants, closeSync, fstatSync, openSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Pool } from 'pg'
import {
  type AuthorityKeyring, type ModelAuthorityPayload,
  assertLeaseMatchesAuthority, verifyAuthority, verifyTurnLease,
} from '@openclaude/protocol'
import { type RemoteBridgeBinding, type CodexRemoteBinding, type RemoteNativeTerminalReceipt, type CodexNativeTerminalReceipt, type CodexNativeTokens, type RemoteFinancePort, type RemoteFinanceTurn, buildCodexReceipt, nativeTokens, nativeId, zeroNativeTokens } from '@openclaude/gateway/remote-finance'
import type {
  Cc5FinancePort, Cc5FinanceTurn, Cc5FinanceTerminalOutcome, Cc5NativeTerminalReceipt,
} from '@openclaude/gateway/cc5-finance'
import type { UserModelAuthzLoader } from '../auth/userModelAuthz.js'
import { loadSettledUsageAttribution } from '../db/pgSessionsBackend.js'
import {
  AUTHORITY_HEADER, TURN_LEASE_HEADER, enforceModelAuthority, enforceRemoteNativeModelAuthority,
} from '../http/proxy/modelAuthorityGate.js'
import type { Logger } from '../logging/logger.js'
import { computeCost, type TokenUsage } from './calculator.js'
import type { ModelCatalogCache } from './modelCatalog.js'
import { parseBillingPricing, serializeBillingPricing, type PersistedBillingPricingV1 } from './persistedBillingPricing.js'
import { CODEX_REMOTE_BILLING_RECOVERY_VERSION, REMOTE_NATIVE_BILLING_RECOVERY_VERSION } from './remoteNativeBillingIdentity.js'
import {
  preCheckWithCost, releasePreCheck, type PreCheckRedis, type ReservationHandle,
} from './preCheck.js'
import {
  claimInflightJournalForSettlement, finalizeInflightJournal, settleUsageAndLedger,
  startInflightJournal, type BillingAuthorityStamp,
} from './proxyBilling.js'

export { REMOTE_NATIVE_BILLING_RECOVERY_VERSION } from './remoteNativeBillingIdentity.js'
const BACKEND = 'cc5-interactive-v1'
const MODEL = /^[a-z0-9][a-z0-9._-]{0,63}$/
/** Soft reservation only, not a promise that upstream spend is capped. */
export const REMOTE_NATIVE_RESERVATION_CREDITS = 100n
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const HASH = /^[a-f0-9]{64}$/
const POSITIVE_ID = /^[1-9][0-9]{0,18}$/
const STALE_SETTLEMENT_MS = 5 * 60_000
const reject = (): never => { throw new Error('REMOTE_NATIVE_BILLING_REJECTED') }
function need(value: unknown): asserts value { if (!value) reject() }
function object(value: unknown): Record<string, unknown> {
  need(value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}
function marker(c: Context): string {
  return c.v === 2 ? CODEX_REMOTE_BILLING_RECOVERY_VERSION : REMOTE_NATIVE_BILLING_RECOVERY_VERSION
}
interface Scope {
  uid: string; containerDbId: string; dockerId: string; operationId: string; runId: string
  sessionKey: string; canonicalModel: string; backendKind: typeof BACKEND | 'codex-app-server-v1'; expiresAt: number
  generation?: string; profileId?: string; authEpoch?: string; manifestSha256?: string
  /** The lane node's CLI model; every native receipt must carry exactly it. Absent in journals
   * written before remote-pool lanes, whose only worker ran the pinned Sonnet. */
  upstreamModel?: string
}
/** Pre-lane journals persisted no upstream: their single pinned worker ran exactly this pair. */
const LEGACY_PINNED_WORKER = { canonicalModel: 'box-claude-sonnet-5', upstreamModel: 'claude-sonnet-5' } as const
function scopeUpstream(scope: Pick<Scope, 'canonicalModel' | 'upstreamModel'>): string | undefined {
  if (scope.upstreamModel !== undefined) return scope.upstreamModel
  return scope.canonicalModel === LEGACY_PINNED_WORKER.canonicalModel ? LEGACY_PINNED_WORKER.upstreamModel : undefined
}
interface Context {
  v: 1 | 2; scope: Scope; requestId: string; turnKey: string; authorityTurnId: string
  dispatchId: string; attemptNo: number; sessionId: string
  pricing: PersistedBillingPricingV1; billingRevision: string
  authority: { kind: 'bridge_signed'; executionRevision: string; projectionRevision: null; securityEpoch: string }
  hostStartAttempted: boolean; input: { sequence: number; inputSha256: string } | null
  native?: { threadId: string; baseline: CodexNativeTokens };
  receipt: RemoteNativeTerminalReceipt | null; reserved: boolean; reservedCredits: string
}
export interface RemoteNativeTurnFinanceDeps {
  pool: Pool
  preCheckRedis: PreCheckRedis
  catalog: ModelCatalogCache
  keyring: AuthorityKeyring | (() => AuthorityKeyring)
  loadUserModelAuthz: UserModelAuthzLoader
  log: Logger
  /** The lane node's CLI model (target upstream). */
  upstreamModel: string
  now?: () => number
}
/** Primitive substitutes are for isolated tests only. Production passes no second argument. */
export interface RemoteNativeFinanceFixtures {
  reserve?: typeof preCheckWithCost
  release?: typeof releasePreCheck
  settle?: typeof settleUsageAndLedger
}
function scopeOf(binding: Readonly<RemoteBridgeBinding>, upstreamModel: string): Scope {
  need((binding.version === 2 && binding.backendKind === BACKEND || binding.version === 3 && binding.backendKind === 'codex-app-server-v1')
    && MODEL.test(binding.canonicalModel) && MODEL.test(upstreamModel)
    && POSITIVE_ID.test(binding.uid) && POSITIVE_ID.test(binding.containerDbId)
    && HASH.test(binding.dockerId) && UUID.test(binding.operationId) && UUID.test(binding.runId)
    && typeof binding.sessionKey === 'string' && binding.sessionKey.length > 0
    && binding.sessionKey.length <= 512 && Number.isSafeInteger(binding.expiresAt))
  if (binding.version === 3) need(/^[1-9][0-9]{0,15}$/.test(binding.generation)
    && /^[a-z0-9][a-z0-9-]{0,31}$/.test(binding.profileId) && nativeId(binding.authEpoch)
    && HASH.test(binding.manifestSha256) && binding.canonicalModel === `${upstreamModel}-remote`)
  return { uid: binding.uid, containerDbId: binding.containerDbId, dockerId: binding.dockerId,
    operationId: binding.operationId, runId: binding.runId, sessionKey: binding.sessionKey,
    canonicalModel: binding.canonicalModel, backendKind: binding.backendKind, expiresAt: binding.expiresAt, upstreamModel,
    ...(binding.version === 3 ? { generation: binding.generation, profileId: binding.profileId, authEpoch: binding.authEpoch, manifestSha256: binding.manifestSha256 } : {}) }
}
function validateCodexReceipt(raw: unknown, scope: Scope): CodexNativeTerminalReceipt {
  const r = object(raw)
  need(r.version === 3 && nativeId(r.nativeThreadId) && nativeId(r.nativeTurnId)
    && typeof r.authorityTurnId === 'string' && /^[a-f0-9]{32}$/.test(r.authorityTurnId)
    && typeof r.turnKey === 'string' && HASH.test(r.turnKey)
    && ['completed', 'failed', 'interrupted'].includes(String(r.nativeStatus)))
  const b: CodexRemoteBinding = { version: 3, backendKind: 'codex-app-server-v1',
    uid: scope.uid, containerDbId: scope.containerDbId, dockerId: scope.dockerId, operationId: scope.operationId,
    runId: scope.runId, sessionKey: scope.sessionKey, canonicalModel: scope.canonicalModel,
    generation: scope.generation!, profileId: scope.profileId!, authEpoch: scope.authEpoch!,
    manifestSha256: scope.manifestSha256!, expiresAt: scope.expiresAt, capability: '0'.repeat(64) }
  const expected = buildCodexReceipt(b, { authorityTurnId: r.authorityTurnId, turnKey: r.turnKey,
    upstreamModel: scope.upstreamModel!, nativeThreadId: r.nativeThreadId, nativeTurnId: r.nativeTurnId },
    nativeTokens(r.baseline), nativeTokens(r.total), r.nativeStatus as CodexNativeTerminalReceipt['nativeStatus'])
  need(isDeepStrictEqual(expected, raw))
  return expected
}
export function validateRemoteNativeReceipt(raw: unknown, scope: Scope): RemoteNativeTerminalReceipt {
  const r = object(raw)
  if (scope.backendKind === 'codex-app-server-v1') return validateCodexReceipt(raw, scope)
  const keys = 'backendKind,canonicalModel,containerDbId,dockerId,nativeSessionId,operationId,resultSha256,runId,sessionKey,status,uid,upstreamModel,usage,version'
  need(r.version === 1 || r.version === 2)
  need(Object.keys(r).sort().join(',') === (r.version === 1 ? keys
    : `authorityTurnId,${keys.replace(',uid,', ',turnKey,uid,')}`))
  if (r.version === 2) need(typeof r.authorityTurnId === 'string' && /^[a-f0-9]{32}$/.test(r.authorityTurnId)
    && typeof r.turnKey === 'string' && HASH.test(r.turnKey))
  need(r.backendKind === BACKEND && r.uid === scope.uid
    && r.containerDbId === scope.containerDbId && r.dockerId === scope.dockerId
    && r.operationId === scope.operationId && r.runId === scope.runId
    && r.sessionKey === scope.sessionKey && r.canonicalModel === scope.canonicalModel
    && r.upstreamModel === scopeUpstream(scope) && typeof r.nativeSessionId === 'string'
    && UUID.test(r.nativeSessionId) && typeof r.resultSha256 === 'string' && HASH.test(r.resultSha256)
    && (r.status === 'success' || r.status === 'error'))
  const u = object(r.usage)
  need(Object.keys(u).sort().join(',') === 'cacheReadTokens,cacheWriteTokens,inputTokens,outputTokens')
  for (const value of Object.values(u)) need(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
  return structuredClone(raw) as Cc5NativeTerminalReceipt
}
function parseContext(raw: unknown): Context {
  const c = object(raw)
  need((c.v === 1 || c.v === 2) && typeof c.requestId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(c.requestId)
    && typeof c.turnKey === 'string' && HASH.test(c.turnKey)
    && typeof c.authorityTurnId === 'string' && /^[a-f0-9]{32}$/.test(c.authorityTurnId)
    && typeof c.dispatchId === 'string' && UUID.test(c.dispatchId)
    && typeof c.attemptNo === 'number' && Number.isSafeInteger(c.attemptNo) && c.attemptNo > 0
    && typeof c.sessionId === 'string' && c.sessionId.length > 0 && c.sessionId.length <= 256
    && typeof c.billingRevision === 'string' && c.billingRevision.length > 0
    && typeof c.hostStartAttempted === 'boolean' && typeof c.reserved === 'boolean'
    && typeof c.reservedCredits === 'string' && /^\d+$/.test(c.reservedCredits)
    && BigInt(c.reservedCredits) <= REMOTE_NATIVE_RESERVATION_CREDITS)
  const s = object(c.scope)
  // The persisted scope is kept byte-for-byte (JSONB CAS/repair compare it); only validation reads the legacy pair.
  const upstream = scopeUpstream(s as unknown as Scope)
  need(upstream !== undefined && (s.upstreamModel === undefined || typeof s.upstreamModel === 'string'))
  need((c.v === 2) === (s.backendKind === 'codex-app-server-v1'))
  scopeOf({ ...s, version: c.v === 2 ? 3 : 2 } as unknown as RemoteBridgeBinding, upstream)
  if (c.v === 2 && c.native !== undefined) {
    const n = object(c.native); need(nativeId(n.threadId)); nativeTokens(n.baseline)
  }
  need(parseBillingPricing(c.pricing, s.canonicalModel as string))
  const a = object(c.authority)
  need(a.kind === 'bridge_signed' && typeof a.executionRevision === 'string'
    && a.executionRevision.length > 0 && a.projectionRevision === null
    && typeof a.securityEpoch === 'string' && /^\d+$/.test(a.securityEpoch))
  if (c.input !== null) {
    const i = object(c.input)
    need(typeof i.sequence === 'number' && Number.isSafeInteger(i.sequence) && i.sequence > 0
      && typeof i.inputSha256 === 'string' && HASH.test(i.inputSha256))
  }
  if (c.receipt !== null) {
    const receipt = validateRemoteNativeReceipt(c.receipt, s as unknown as Scope)
    if (receipt.version !== 1) need(receipt.authorityTurnId === c.authorityTurnId && receipt.turnKey === c.turnKey)
    if (receipt.version === 3) need(c.native && (c.native as Context['native'])!.threadId === receipt.nativeThreadId
      && isDeepStrictEqual((c.native as Context['native'])!.baseline, receipt.baseline))
  }
  return structuredClone(raw) as Context
}
function reservation(c: Context): ReservationHandle {
  return { userId: c.scope.uid, requestId: c.requestId }
}
async function releaseSoftReservation(
  redis: PreCheckRedis, c: Context, log: Logger, release = releasePreCheck,
): Promise<void> {
  try { await release(redis, reservation(c)) }
  catch {
    // Redis is a TTL-bounded soft reservation, never settlement/delivery proof.
    // Its cleanup must not hide a result whose debit was independently proven.
    try { log.warn('remote_native_precheck_release_failed', { requestId: c.requestId }) }
    catch { /* logging is not financial proof either */ }
  }
}
function nativeStamp(c: Context) {
  const r = c.receipt!
  if (r.version === 3) return { version: 3, backendKind: r.backendKind, operationId: r.operationId,
    nativeThreadId: r.nativeThreadId, nativeTurnId: r.nativeTurnId, resultSha256: r.resultSha256,
    authorityTurnId: r.authorityTurnId, turnKey: r.turnKey, usageSemantics: r.usageSemantics, nativeUsage: r.nativeUsage, baseline: r.baseline, total: r.total }
  return { version: r.version, backendKind: BACKEND, operationId: c.scope.operationId, runId: c.scope.runId,
    nativeSessionId: r.nativeSessionId, resultSha256: r.resultSha256,
    ...(r.version === 2 ? { authorityTurnId: r.authorityTurnId, turnKey: r.turnKey } : {}) }
}
function usageOf(c: Context): TokenUsage {
  const u = c.receipt!.usage
  return { input_tokens: u.inputTokens, output_tokens: u.outputTokens,
    cache_read_tokens: u.cacheReadTokens, cache_write_tokens: u.cacheWriteTokens }
}
interface JournalRow { state: string; ctx: Record<string, unknown>; updated_at?: Date }
interface ProofRow extends JournalRow {
  usage_id: string; ledger_id: string | null; cost_credits: string; account_id: string | null
  model: string; container_id: string; session_id: string; turn_key: string; dispatch_id: string; attempt_no: number
  status: string; input_tokens: string; output_tokens: string; cache_read_tokens: string; cache_write_tokens: string
  price_snapshot: Record<string, unknown>; execution_revision: string; security_epoch: string; authority_kind: string
}
async function readProof(pool: Pool, c: Context): Promise<ProofRow | null> {
  const row = (await pool.query<ProofRow>(`/* remote-native:readback */
    SELECT j.state,j.ctx,ur.id::text AS usage_id,ur.ledger_id::text AS ledger_id,
      ur.cost_credits::text,ur.account_id::text,ur.model,j.container_id::text,ur.session_id,
      ur.turn_key,ur.dispatch_id::text,ur.attempt_no,ur.status,
      ur.input_tokens::text,ur.output_tokens::text,ur.cache_read_tokens::text,ur.cache_write_tokens::text,
      ur.price_snapshot,ur.execution_revision,ur.security_epoch::text,ur.authority_kind
    FROM request_finalize_journal j JOIN usage_records ur
      ON ur.request_id=j.request_id AND ur.user_id=j.user_id
    WHERE j.request_id=$1 AND j.user_id=$2 AND j.ctx->>'remoteNativeBillingRecovery'=$3`,
  [c.requestId, c.scope.uid, marker(c)])).rows[0]
  if (!row) return null
  need(c.receipt && row.account_id === null && row.model === c.scope.canonicalModel
    && row.container_id === c.scope.containerDbId && row.session_id === c.sessionId && row.turn_key === c.turnKey
    && row.dispatch_id === c.dispatchId && Number(row.attempt_no) === c.attemptNo
    && row.status === (c.receipt.status === 'success' ? 'success' : 'error')
    && row.execution_revision === c.authority.executionRevision
    && row.security_epoch === c.authority.securityEpoch && row.authority_kind === 'bridge_signed')
  const stored = parseContext(row.ctx.remoteNative)
  need(isDeepStrictEqual(stored, c))
  const u = c.receipt.usage
  need(row.input_tokens === String(u.inputTokens) && row.output_tokens === String(u.outputTokens)
    && row.cache_read_tokens === String(u.cacheReadTokens) && row.cache_write_tokens === String(u.cacheWriteTokens)
    && isDeepStrictEqual(row.price_snapshot.remote_native, nativeStamp(c)))
  const p = c.pricing
  for (const [key, value] of Object.entries({ model_id: p.modelId, input_per_mtok: p.inputPerMtok,
    output_per_mtok: p.outputPerMtok, cache_read_per_mtok: p.cacheReadPerMtok,
    cache_write_per_mtok: p.cacheWritePerMtok, multiplier: p.multiplier })) need(row.price_snapshot[key] === value)
  const attribution = await loadSettledUsageAttribution(pool, BigInt(c.scope.uid), c.requestId)
  need(attribution && attribution.usageId.toString() === row.usage_id
    && (attribution.ledgerId?.toString() ?? null) === row.ledger_id
    && attribution.costCredits.toString() === row.cost_credits && attribution.attributionCredits !== null)
  const pricing = parseBillingPricing(c.pricing, c.scope.canonicalModel)
  need(pricing)
  const nominal = computeCost(usageOf(c), pricing).cost_credits
  const expected = c.receipt.status === 'error' || c.receipt.usage.outputTokens === 0 ? 0n : nominal
  const autoWaived = row.price_snapshot.waived === 'turn_auto_waive'
    && row.price_snapshot.wouldHaveCharged === expected.toString()
  need(attribution.costCredits === (autoWaived ? 0n : expected)
    && attribution.attributionCredits >= 0n && attribution.attributionCredits <= attribution.costCredits
    && (attribution.attributionCredits === 0n || row.ledger_id !== null))
  // The existing settlement owns clamp/waiver/organization semantics. The exact
  // transaction-authored cost locator proves actual debit, including zero.
  return row
}
async function proveAndRepair(pool: Pool, c: Context): Promise<boolean> {
  const proof = await readProof(pool, c)
  if (!proof) return false
  if (proof.state === 'committed') { await releaseNativeBoundary(pool, c); return true }
  need(proof.state === 'inflight' || proof.state === 'finalizing')
  const repaired = await pool.query(`/* remote-native:repair */
    UPDATE request_finalize_journal SET state='committed',usage_id=$4,ledger_id=$5,
      final_credits=$6,failure_code=NULL,ctx=ctx-'settlementClaimId',updated_at=NOW()
    WHERE request_id=$1 AND user_id=$2 AND ctx->>'remoteNativeBillingRecovery'=$3
      AND ctx->'remoteNative'=$7::jsonb AND state IN ('inflight','finalizing')`,
  [c.requestId, c.scope.uid, marker(c), proof.usage_id,
    proof.ledger_id, proof.cost_credits, JSON.stringify(c)])
  const proven = repaired.rowCount === 1 || (await readProof(pool, c))?.state === 'committed'
  if (proven) await releaseNativeBoundary(pool, c)
  return proven
}
async function releaseNativeBoundary(pool: Pool, c: Context): Promise<void> {
  if (c.receipt?.version !== 3) return
  const r = c.receipt
  // Never release another turn's boundary. A later turn may already own this thread.
  await pool.query(`/* remote-native:release-boundary */ UPDATE remote_native_threads
    SET pending_request_id=NULL,updated_at=NOW()
    WHERE uid=$1 AND operation_id=$2 AND native_thread_id=$3 AND pending_request_id=$4
      AND last_native_turn_id=$5 AND total=$6::jsonb`,
  [c.scope.uid, c.scope.operationId, r.nativeThreadId, c.requestId, r.nativeTurnId, JSON.stringify(r.total)])
}
async function bindNativeBoundary(pool: Pool, c: Context, threadId: string, newlyCreated: boolean): Promise<CodexNativeTokens> {
  need(c.v === 2 && nativeId(threadId) && c.hostStartAttempted && c.input === null && c.native === undefined)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (newlyCreated) {
      const added = await client.query(`INSERT INTO remote_native_threads
        (uid,operation_id,native_thread_id,profile_id,auth_epoch,upstream_model,total)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT DO NOTHING`,
      [c.scope.uid, c.scope.operationId, threadId, c.scope.profileId, c.scope.authEpoch, c.scope.upstreamModel, JSON.stringify(zeroNativeTokens())])
      need(added.rowCount === 1) // a thread/start response cannot reset a prior thread's usage.
    }
    const row = (await client.query(`SELECT * FROM remote_native_threads
      WHERE uid=$1 AND operation_id=$2 AND native_thread_id=$3 FOR UPDATE`,
    [c.scope.uid, c.scope.operationId, threadId])).rows[0]
    need(row && row.profile_id === c.scope.profileId && row.auth_epoch === c.scope.authEpoch
      && row.pending_request_id === null)
    const baseline = nativeTokens(row.total)
    const native = { threadId, baseline }
    await client.query(`UPDATE remote_native_threads SET pending_request_id=$4,upstream_model=$5,updated_at=NOW()
      WHERE uid=$1 AND operation_id=$2 AND native_thread_id=$3`, [c.scope.uid, c.scope.operationId, threadId, c.requestId, c.scope.upstreamModel])
    const bound = await client.query(`UPDATE request_finalize_journal SET ctx=jsonb_set(ctx,'{remoteNative,native}',$4::jsonb),updated_at=NOW()
      WHERE request_id=$1 AND user_id=$2 AND ctx->>'remoteNativeBillingRecovery'=$3 AND state='inflight'
        AND NOT (ctx->'remoteNative' ? 'native') AND ctx#>>'{remoteNative,hostStartAttempted}'='true'`,
    [c.requestId, c.scope.uid, marker(c), JSON.stringify(native)])
    need(bound.rowCount === 1)
    await client.query('COMMIT')
    c.native = native
    return baseline
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
  finally { client.release() }
}
async function persistCodexReceipt(pool: Pool, c: Context, r: CodexNativeTerminalReceipt): Promise<void> {
  need(c.native?.threadId === r.nativeThreadId && isDeepStrictEqual(c.native.baseline, r.baseline))
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const boundary = (await client.query(`SELECT * FROM remote_native_threads
      WHERE uid=$1 AND operation_id=$2 AND native_thread_id=$3 FOR UPDATE`,
    [c.scope.uid, c.scope.operationId, r.nativeThreadId])).rows[0]
    need(boundary && boundary.pending_request_id === c.requestId)
    const previous = (await client.query(`SELECT * FROM remote_native_turns
      WHERE uid=$1 AND operation_id=$2 AND native_thread_id=$3 AND native_turn_id=$4`,
    [c.scope.uid, c.scope.operationId, r.nativeThreadId, r.nativeTurnId])).rows[0]
    if (previous) need(previous.request_id === c.requestId && previous.receipt_sha256 === r.resultSha256
      && isDeepStrictEqual(previous.receipt, r))
    else {
      need(isDeepStrictEqual(boundary.total, r.baseline))
      await client.query(`INSERT INTO remote_native_turns
        (uid,operation_id,native_thread_id,native_turn_id,request_id,receipt_sha256,receipt)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [c.scope.uid, c.scope.operationId, r.nativeThreadId, r.nativeTurnId, c.requestId, r.resultSha256, JSON.stringify(r)])
      await client.query(`UPDATE remote_native_threads SET total=$4::jsonb,last_native_turn_id=$5,updated_at=NOW()
        WHERE uid=$1 AND operation_id=$2 AND native_thread_id=$3`,
      [c.scope.uid, c.scope.operationId, r.nativeThreadId, JSON.stringify(r.total), r.nativeTurnId])
    }
    const saved = await client.query(`UPDATE request_finalize_journal SET ctx=jsonb_set(ctx,'{remoteNative,receipt}',$4::jsonb),updated_at=NOW()
      WHERE request_id=$1 AND user_id=$2 AND ctx->>'remoteNativeBillingRecovery'=$3 AND state='inflight'
      AND ctx#>>'{remoteNative,hostStartAttempted}'='true' AND ctx#>'{remoteNative,input}'<>'null'::jsonb
      AND (ctx#>'{remoteNative,receipt}'='null'::jsonb OR ctx#>'{remoteNative,receipt}'=$4::jsonb)`,
    [c.requestId, c.scope.uid, marker(c), JSON.stringify(r)])
    need(saved.rowCount === 1)
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
  finally { client.release() }
}
async function settleReceipt(pool: Pool, c: Context, settle: typeof settleUsageAndLedger): Promise<boolean> {
  need(c.hostStartAttempted && c.input && c.receipt)
  if (await proveAndRepair(pool, c)) return true
  const claim = await claimInflightJournalForSettlement(pool, c.requestId)
  if (!claim) return false
  const pricing = parseBillingPricing(c.pricing, c.scope.canonicalModel)
  need(pricing)
  const usage = usageOf(c)
  const calculated = computeCost(usage, pricing)
  const noOutput = c.receipt.status === 'success' && c.receipt.usage.outputTokens === 0 && calculated.cost_credits > 0n
  const cost = c.receipt.status === 'error' || noOutput ? 0n : calculated.cost_credits
  const result = await settle(pool, {
    userId: BigInt(c.scope.uid), accountId: null, requestId: c.requestId, model: c.scope.canonicalModel,
    usage, snapshotJson: JSON.stringify({ ...calculated.snapshot, remote_native: nativeStamp(c),
      ...(noOutput ? { waived: 'no_output', wouldHaveCharged: calculated.cost_credits.toString() } : {}) }),
    costCredits: cost, status: c.receipt.status === 'success' ? 'success' : 'error',
    sessionId: c.sessionId, mode: 'chat', turnKey: c.turnKey,
    authority: { ...c.authority, securityEpoch: BigInt(c.authority.securityEpoch) } as BillingAuthorityStamp,
    dispatchId: c.dispatchId, attemptNo: c.attemptNo,
  })
  await finalizeInflightJournal(pool, { requestId: c.requestId,
    finalCredits: result.settledCostCredits ?? cost, ledgerId: result.ledgerId,
    usageId: result.usageId, settlementClaimId: claim })
  return proveAndRepair(pool, c)
}

export function createRemoteNativeTurnFinance(
  deps: RemoteNativeTurnFinanceDeps, fixtures: RemoteNativeFinanceFixtures = {},
): RemoteFinancePort {
  const reserve = fixtures.reserve ?? preCheckWithCost
  const release = fixtures.release ?? releasePreCheck
  const settle = fixtures.settle ?? settleUsageAndLedger
  const claimedAuthorities = new Set<string>()
  const claimedRequests = new Set<string>()
  const claimedTurns = new Set<string>()
  const activeOperations = new Map<string, string>()
  const now = deps.now ?? Date.now
  return { async admit(input) {
    const scope = scopeOf(input.binding, deps.upstreamModel)
    need(scope.expiresAt > now() && input.sessionKey === scope.sessionKey && HASH.test(input.turnKey))
    const keys = typeof deps.keyring === 'function' ? deps.keyring() : deps.keyring
    const a = verifyAuthority(input.authorityEnvelope, keys, now())
    const lease = verifyTurnLease(input.leaseEnvelope, keys, now())
    assertLeaseMatchesAuthority(lease, a)
    const backend = (a as ModelAuthorityPayload & { executionBackend?: { kind: string; sessionKey: string; operationId: string } }).executionBackend
    const engine = scope.backendKind === BACKEND ? 'ccb' : 'codex'
    need(a.engine === engine && a.canonicalModel === scope.canonicalModel
      && String(a.uid) === scope.uid && String(a.containerId) === scope.containerDbId
      && backend?.kind === scope.backendKind && backend.operationId === scope.operationId
      && backend.sessionKey === scope.sessionKey && typeof a.billingRequestId === 'string'
      && /^[A-Za-z0-9_-]{1,64}$/.test(a.billingRequestId))
    if (input.binding.version === 3) {
      const b = a.executionBackend
      need(b?.kind === 'codex-app-server-v1' && b.generation === scope.generation
        && b.profileId === scope.profileId && b.authEpoch === scope.authEpoch)
    }
    // The Worker binding outlives a turn. Burn each signed turn/request before
    // awaiting I/O, while retaining one active financial owner per operation.
    need(!activeOperations.has(scope.operationId) && !claimedAuthorities.has(a.authorityTurnId)
      && !claimedRequests.has(a.billingRequestId) && !claimedTurns.has(input.turnKey))
    claimedAuthorities.add(a.authorityTurnId)
    claimedRequests.add(a.billingRequestId)
    claimedTurns.add(input.turnKey)
    activeOperations.set(scope.operationId, a.billingRequestId)
    const releaseActive = () => {
      if (activeOperations.get(scope.operationId) === a.billingRequestId) activeOperations.delete(scope.operationId)
    }
    const fence = () => (engine === 'codex' ? enforceRemoteNativeModelAuthority : enforceModelAuthority)({ catalog: deps.catalog,
      keyring: typeof deps.keyring === 'function' ? deps.keyring() : deps.keyring,
      headers: { [AUTHORITY_HEADER]: input.authorityEnvelope, [TURN_LEASE_HEADER]: input.leaseEnvelope },
      uid: BigInt(scope.uid), containerId: BigInt(scope.containerDbId), model: scope.canonicalModel,
      loadUserModelAuthz: deps.loadUserModelAuthz, logger: deps.log, now: now() })
    const gate = await fence()
    need(gate.authorityKind === 'bridge_signed' && gate.canonicalModel === scope.canonicalModel
      && gate.descriptor.engine === engine && (engine === 'codex'
        ? gate.descriptor.placement === 'remote_pool' : gate.verifiedSignedContextOwner === 'box-native-v1'))
    const pricing = gate.snapshot.billingPricingFor(scope.canonicalModel)
    need(pricing)
    const client = await deps.pool.connect()
    let dispatch: { dispatch_id: string; attempt_no: number; session_id: string; turn_key: string | null; authority_turn_key: string | null }
    try {
      await client.query('BEGIN')
      if (engine === 'codex') {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`remote-finance:${scope.uid}:${scope.operationId}`])
        const pending = await client.query(`SELECT 1 FROM request_finalize_journal
          WHERE user_id=$1 AND ctx->>'remoteNativeBillingRecovery'=$2
            AND ctx#>>'{remoteNative,scope,operationId}'=$3 AND state IN ('inflight','finalizing') LIMIT 1`,
        [scope.uid,CODEX_REMOTE_BILLING_RECOVERY_VERSION,scope.operationId])
        need(!pending.rows.length)
      }
      const selected = (await client.query<typeof dispatch>(
      `/* remote-native:dispatch */ SELECT d.dispatch_id::text,d.attempt_no,d.session_id,
        d.turn_key,atd.turn_key AS authority_turn_key
       FROM authority_turn_dispatches atd JOIN turn_dispatches d ON d.dispatch_id=atd.dispatch_id
       WHERE atd.authority_turn_id=$1 AND atd.user_id=$2 AND d.user_id=atd.user_id
         AND d.billing_request_id=$3 AND d.agent_container_id=$4
         AND atd.canonical_model=$5 AND d.model=$5 AND d.attempt_no=atd.attempt_no
         AND d.session_id=atd.session_id AND d.status IN ('admitted','accepted')
         AND d.terminal_at IS NULL AND d.producer_fenced_at IS NULL
       FOR UPDATE OF atd,d`,
      [a.authorityTurnId, scope.uid, a.billingRequestId, scope.containerDbId, scope.canonicalModel])).rows[0]
      need(selected && UUID.test(selected.dispatch_id) && selected.attempt_no > 0
        && typeof selected.session_id === 'string'
        && (selected.turn_key === null || selected.turn_key === input.turnKey)
        && (selected.authority_turn_key === null || selected.authority_turn_key === input.turnKey))
      // The gateway derives turnKey after master admission. Bind it exactly
      // once under the already-signed dispatch identity, never by request key
      // alone. Lock both records so renewal cannot race a different binding.
      const bound = await client.query(`/* remote-native:bind-turn */
        WITH authority_bound AS (
          UPDATE authority_turn_dispatches SET turn_key=$6
           WHERE authority_turn_id=$1 AND user_id=$2 AND dispatch_id=$3
             AND attempt_no=$4 AND session_id=$5 AND (turn_key IS NULL OR turn_key=$6)
          RETURNING dispatch_id
        ) UPDATE turn_dispatches SET turn_key=$6
           WHERE dispatch_id=$3 AND user_id=$2 AND attempt_no=$4 AND session_id=$5
             AND (turn_key IS NULL OR turn_key=$6)
             AND EXISTS(SELECT 1 FROM authority_bound WHERE dispatch_id=$3)`,
      [a.authorityTurnId, scope.uid, selected.dispatch_id, selected.attempt_no, selected.session_id, input.turnKey])
      need(bound.rowCount === 1)
      await client.query('COMMIT')
      dispatch = selected
    } catch (err) {
      try { await client.query('ROLLBACK') } catch { /* unknown binding cannot launch a worker */ }
      throw err
    } finally { client.release() }
    const c: Context = { v: scope.backendKind === BACKEND ? 1 : 2, scope, requestId: a.billingRequestId, turnKey: input.turnKey,
      authorityTurnId: a.authorityTurnId, dispatchId: dispatch.dispatch_id, attemptNo: dispatch.attempt_no,
      sessionId: dispatch.session_id, pricing: serializeBillingPricing(pricing),
      billingRevision: gate.snapshot.billingRevision,
      authority: { kind: 'bridge_signed', executionRevision: gate.executionRevision,
        projectionRevision: null, securityEpoch: gate.securityEpoch.toString() },
      hostStartAttempted: false, input: null, receipt: null, reserved: false, reservedCredits: '0' }
    const started = await startInflightJournal(deps.pool, { requestId: c.requestId,
      userId: BigInt(scope.uid), containerId: BigInt(scope.containerDbId), model: scope.canonicalModel,
      precheckCredits: REMOTE_NATIVE_RESERVATION_CREDITS, dispatchId: c.dispatchId, attemptNo: c.attemptNo,
      ctxJson: { remoteNativeBillingRecovery: marker(c), remoteNative: c } })
    need(started) // do not overwrite/release another invocation's reservation
    const prehostAbort = async (reason: 'USER_CANCELLED' | 'INTERNAL_ERROR', provenNoHostEffect = false, diagnostic = 'remote_native_prehost_stopped'): Promise<boolean> => {
      const row = await deps.pool.query(`/* remote-native:prehost-abort */
        UPDATE request_finalize_journal SET state='aborted',final_credits=0,
          failure_code=$5,error_msg=$7,updated_at=NOW()
        WHERE request_id=$1 AND user_id=$2 AND ctx->>'remoteNativeBillingRecovery'=$3
          AND ctx#>>'{remoteNative,scope,operationId}'=$4 AND state='inflight'
          AND (ctx#>>'{remoteNative,hostStartAttempted}'='false' OR $6::boolean)
          AND NOT (ctx->'remoteNative' ? 'native')
          AND ctx#>'{remoteNative,input}'='null'::jsonb`,
      [c.requestId, scope.uid, marker(c), scope.operationId, reason, provenNoHostEffect, diagnostic])
      if (row.rowCount === 1) {
        await releaseSoftReservation(deps.preCheckRedis, c, deps.log, release)
        releaseActive()
        return true
      }
      return false
    }
    try {
      const pre = await reserve(deps.preCheckRedis, { userId: scope.uid, requestId: c.requestId,
        maxCost: REMOTE_NATIVE_RESERVATION_CREDITS,
        ttlSeconds: Math.min(14700, Math.max(300, Math.ceil((scope.expiresAt - now()) / 1000) + 300)) })
      c.reserved = true
      c.reservedCredits = pre.maxCost.toString()
      const reserved = await deps.pool.query(`/* remote-native:reserved */
        UPDATE request_finalize_journal SET ctx=jsonb_set(ctx,'{remoteNative}',$4::jsonb),
          precheck_credits=$5,updated_at=NOW()
        WHERE request_id=$1 AND user_id=$2 AND ctx->>'remoteNativeBillingRecovery'=$3
          AND state='inflight' AND ctx#>>'{remoteNative,hostStartAttempted}'='false'`,
      [c.requestId, scope.uid, marker(c), JSON.stringify(c), c.reservedCredits])
      need(reserved.rowCount === 1)
    } catch (err) {
      // This invocation won journal ownership and has not exposed a host port.
      // A lost reserve/update ACK can therefore close only its prehost row.
      try { await prehostAbort('INTERNAL_ERROR') } catch { /* retain unknown journal/reservation */ }
      throw err
    }
    let hostAttempted = false
    let inputAttempted = false
    let finish: Promise<Cc5FinanceTerminalOutcome> | undefined
    const scopedUpdate = async (tag: string, path: string, value: unknown, extra: string) => deps.pool.query(
      `/* remote-native:${tag} */ UPDATE request_finalize_journal
         SET ctx=jsonb_set(ctx,'{remoteNative,${path}}',$5::jsonb),updated_at=NOW()
       WHERE request_id=$1 AND user_id=$2 AND ctx->>'remoteNativeBillingRecovery'=$3
         AND ctx#>>'{remoteNative,scope,operationId}'=$4 AND state='inflight' ${extra}`,
      [c.requestId, scope.uid, marker(c), scope.operationId, JSON.stringify(value)])
    const turn: RemoteFinanceTurn = {
      ...(c.v === 2 ? { bindNativeThread: (id: string, fresh: boolean) => bindNativeBoundary(deps.pool, c, id, fresh) } : {}),
      async beforeHostStart() {
        need(!hostAttempted && scope.expiresAt > now())
        hostAttempted = true // a failed CAS acknowledgement never permits a second start
        await fence()
        const row = await scopedUpdate('host-start', 'hostStartAttempted', true,
          "AND ctx#>>'{remoteNative,hostStartAttempted}'='false' AND ctx#>>'{remoteNative,reserved}'='true'")
        need(row.rowCount === 1)
        c.hostStartAttempted = true
      },
      async beforeDispatch(value) {
        need(scope.expiresAt > now() && hostAttempted && c.hostStartAttempted
          && (c.v === 1 || c.native !== undefined)
          && !inputAttempted && Number.isSafeInteger(value.sequence) && value.sequence > 0 && HASH.test(value.inputSha256))
        inputAttempted = true
        await fence()
        const row = await scopedUpdate('dispatch-input', 'input', value,
          "AND ctx#>>'{remoteNative,hostStartAttempted}'='true' AND ctx#>'{remoteNative,input}'='null'::jsonb")
        need(row.rowCount === 1)
        c.input = structuredClone(value)
      },
      terminal(raw) {
        const receipt = validateRemoteNativeReceipt(raw, scope)
        // v1 receipts remain readable by recovery only. A live continued turn
        // must carry the exact current signed admission, not just session IDs.
        need(receipt.version !== 1 && receipt.authorityTurnId === c.authorityTurnId && receipt.turnKey === c.turnKey)
        need(hostAttempted && inputAttempted && c.input)
        if (c.receipt) need(isDeepStrictEqual(c.receipt, receipt))
        if (finish) return finish
        c.receipt = receipt
        finish = (async () => {
          try {
            if (receipt.version === 3) await persistCodexReceipt(deps.pool, c, receipt)
            else {
              const row = await scopedUpdate('receipt', 'receipt', receipt,
                "AND ctx#>>'{remoteNative,hostStartAttempted}'='true' AND ctx#>'{remoteNative,input}'<>'null'::jsonb AND (ctx#>'{remoteNative,receipt}'='null'::jsonb OR ctx#>'{remoteNative,receipt}'=$5::jsonb)")
              need(row.rowCount === 1)
            }
            if (await settleReceipt(deps.pool, c, settle)) {
              await releaseSoftReservation(deps.preCheckRedis, c, deps.log, release)
              releaseActive()
              return { state: 'proven' as const, requestId: c.requestId }
            }
          } catch {
            // Even a COMMIT error may hide a real debit. A complete readback,
            // never an optimistic finalizer result, is the delivery authority.
            try {
              if (await proveAndRepair(deps.pool, c)) {
                await releaseSoftReservation(deps.preCheckRedis, c, deps.log, release)
                releaseActive()
                return { state: 'proven' as const, requestId: c.requestId }
              }
            } catch { /* unknown remains durable and unreplayed */ }
          }
          return { state: 'pending' as const }
        })()
        return finish
      },
      /**
       * A turn cancelled between host start and the first model frame. Nothing was sent to the
       * model, so there is no usage to settle and no receipt to invent: close the journal row
       * and release the thread claim by identity. Anything this invocation cannot prove durably
       * stays closed (`pending`) instead of guessing zero effect.
       */
      async abandonUndispatched() {
        need(c.v === 2 && !inputAttempted && c.input === null && !c.receipt)
        // The host never started at all: the ordinary prehost closure is already exact.
        if (!hostAttempted && !c.hostStartAttempted) {
          return (await prehostAbort('USER_CANCELLED')) ? { state: 'proven' as const, requestId: c.requestId } : { state: 'pending' as const }
        }
        const client = await deps.pool.connect()
        try {
          await client.query('BEGIN')
          const journal = await client.query(`/* remote-native:abandon-undispatched */
            UPDATE request_finalize_journal SET state='aborted',final_credits=0,
              failure_code='USER_CANCELLED',error_msg='remote_native_abandoned_before_dispatch',updated_at=NOW()
            WHERE request_id=$1 AND user_id=$2 AND ctx->>'remoteNativeBillingRecovery'=$3
              AND ctx#>>'{remoteNative,scope,operationId}'=$4 AND state='inflight'
              AND ctx#>>'{remoteNative,hostStartAttempted}'='true'
              AND ctx#>'{remoteNative,input}'='null'::jsonb
              AND ctx#>'{remoteNative,receipt}'='null'::jsonb`,
          [c.requestId, scope.uid, marker(c), scope.operationId])
          if (journal.rowCount !== 1) { await client.query('ROLLBACK'); return { state: 'pending' as const } }
          if (c.native) {
            // Only this thread's own claim, and only while its ledger total is still the
            // baseline recorded at bind time (no turn of another owner settled on it).
            const released = await client.query(`/* remote-native:abandon-pending-thread */
              UPDATE remote_native_threads SET pending_request_id=NULL,updated_at=NOW()
              WHERE uid=$1 AND operation_id=$2 AND native_thread_id=$3 AND pending_request_id=$4
                AND total=$5::jsonb`,
            [scope.uid, scope.operationId, c.native.threadId, c.requestId, JSON.stringify(c.native.baseline)])
            need(released.rowCount === 1)
          }
          await client.query('COMMIT')
        } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
        finally { client.release() }
        await releaseSoftReservation(deps.preCheckRedis, c, deps.log, release)
        releaseActive()
        return { state: 'proven' as const, requestId: c.requestId }
      },
      async stop(value) {
        if (value.userSubmitted || !value.remoteStopped) return
        // A pinned node's pre-exec resource rejection plus independent stop proof is a zero-effect
        // boundary, even though the durable 'attempted' marker was correctly written beforehand.
        if (value.nodeAdmissionRejected && !c.native && !inputAttempted) {
          await prehostAbort('INTERNAL_ERROR', true, value.nodeAdmissionReason ?? 'REMOTE_NODE_MEMORY_EXHAUSTED')
          return
        }
        if (value.hostStartAttempted) return
        // Codex stop waits for admission; a durable marker alone is not a launched host.
        const noCodexEffect = c.v === 2 && !c.native && !inputAttempted
        if ((hostAttempted || c.hostStartAttempted) && !noCodexEffect) return
        await prehostAbort('USER_CANCELLED', noCodexEffect)
      },
    }
    return turn
  } }
}

async function importCodexSpool(pool: Pool, c: Context, root: string): Promise<void> {
  if (c.v !== 2 || c.receipt || !c.native || !c.input || !c.hostStartAttempted) return
  need(UUID.test(c.scope.operationId) && /^[1-9][0-9]{0,15}$/.test(c.scope.generation!))
  const dir = join(root,c.scope.operationId,c.scope.generation!,'journal')
  let files: string[]
  try { files = readdirSync(dir).filter(f => /^[0-9]{8}-native-terminal\.json$/.test(f)).sort() }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  for (const file of files) {
    const fd = openSync(join(dir,file),constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    let raw: unknown
    try {
      const st = fstatSync(fd)
      need(st.isFile() && st.nlink === 1 && st.size <= 131072 && !(st.mode & 0o022) && st.uid === process.getuid?.())
      raw = JSON.parse(readFileSync(fd,'utf8'))
    } finally { closeSync(fd) }
    const r = validateRemoteNativeReceipt(raw,c.scope)
    if (r.version !== 3 || r.authorityTurnId !== c.authorityTurnId || r.turnKey !== c.turnKey) continue
    await persistCodexReceipt(pool,c,r)
    c.receipt = r
    return
  }
}

/** Only durable terminal receipts enter this recovery path; no model/SSH port exists here. */
export async function recoverRemoteNativeTurnBilling(
  deps: Pick<RemoteNativeTurnFinanceDeps, 'pool' | 'preCheckRedis' | 'log'>,
  options: { limit?: number; settle?: typeof settleUsageAndLedger; evidenceRoot?: string } = {},
): Promise<{ proven: number; pending: number }> {
  const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 25)))
  const rows = (await deps.pool.query<JournalRow & { request_id: string; user_id: string }>(
    `/* remote-native:recovery-scan */ SELECT request_id,user_id::text,state,ctx,updated_at
     FROM request_finalize_journal WHERE ctx->>'remoteNativeBillingRecovery'=ANY($1::text[])
       AND (state IN ('inflight','finalizing') OR (state='committed' AND EXISTS (
         SELECT 1 FROM remote_native_threads t WHERE t.uid=user_id AND t.pending_request_id=request_id)))
       AND (ctx#>'{remoteNative,receipt}'<>'null'::jsonb OR ctx->>'remoteNativeBillingRecovery'='remote-native-v2')
     ORDER BY updated_at ASC LIMIT $2`, [[REMOTE_NATIVE_BILLING_RECOVERY_VERSION, CODEX_REMOTE_BILLING_RECOVERY_VERSION], limit])).rows
  let proven = 0
  let pending = 0
  for (const row of rows) {
    try {
      const c = parseContext(row.ctx.remoteNative)
      need(c.requestId === row.request_id && c.scope.uid === row.user_id)
      await importCodexSpool(deps.pool,c,options.evidenceRoot ?? '/var/lib/openclaude/remote-native')
      if (!c.receipt && c.v === 2 && !c.input && !c.native) {
        // No current native/input marker means no turn effect could be dispatched. An older
        // resident app/scope is irrelevant; require its exact generation independently released.
        const aborted = await deps.pool.query(`UPDATE request_finalize_journal j SET state='aborted',final_credits=0,
          failure_code='INTERNAL_ERROR',error_msg='remote_native_prehost_stopped',updated_at=NOW()
          WHERE request_id=$1 AND user_id=$2 AND state='inflight' AND ctx->'remoteNative'=$3::jsonb
            AND EXISTS(SELECT 1 FROM remote_agent_bindings b WHERE b.operation_id=$4 AND b.generation=$5
              AND b.engine='codex' AND b.state='released')`,
        [c.requestId,c.scope.uid,JSON.stringify(c),c.scope.operationId,c.scope.generation])
        if (aborted.rowCount === 1) { await releaseSoftReservation(deps.preCheckRedis,c,deps.log); proven++; continue }
      }
      if (!c.receipt) {
        // Rotate still-unknown spools; an old batch must not starve a later recoverable terminal.
        await deps.pool.query(`UPDATE request_finalize_journal SET updated_at=NOW()
          WHERE request_id=$1 AND user_id=$2 AND state='inflight' AND ctx->'remoteNative'=$3::jsonb
            AND ctx#>'{remoteNative,receipt}'='null'::jsonb`,[c.requestId,c.scope.uid,JSON.stringify(c)])
        pending++; continue
      }
      if (await proveAndRepair(deps.pool, c)) {
        await releaseSoftReservation(deps.preCheckRedis, c, deps.log); proven++; continue
      }
      if (row.state === 'finalizing') {
        // Existing unique usage key makes settlement retry safe, but only a
        // stale journal claim can be reclaimed. Re-execution is never an option.
        const reset = await deps.pool.query(`/* remote-native:reclaim */
          UPDATE request_finalize_journal SET state='inflight',ctx=ctx-'settlementClaimId',updated_at=NOW()
          WHERE request_id=$1 AND user_id=$2 AND ctx->>'remoteNativeBillingRecovery'=$3
            AND ctx->'remoteNative'=$4::jsonb AND state='finalizing'
            AND updated_at < NOW()-($5::bigint*INTERVAL '1 millisecond')
            AND NOT EXISTS(SELECT 1 FROM usage_records u WHERE u.request_id=$1 AND u.user_id=$2)`,
        [c.requestId, c.scope.uid, marker(c), JSON.stringify(c), STALE_SETTLEMENT_MS])
        if (reset.rowCount !== 1) { pending++; continue }
      }
      if (await settleReceipt(deps.pool, c, options.settle ?? settleUsageAndLedger)) {
        await releaseSoftReservation(deps.preCheckRedis, c, deps.log); proven++
      } else pending++
    } catch {
      pending++
      deps.log.warn('remote_native_billing_recovery_pending', {})
    }
  }
  return { proven, pending }
}
