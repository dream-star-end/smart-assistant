/** Existing Sonnet billing for one pinned native worker, never a pool account.
 * Recovery only settles a durable original receipt; it cannot launch a worker.
 */
import { isDeepStrictEqual } from 'node:util'
import type { Pool } from 'pg'
import {
  type AuthorityKeyring, type ModelAuthorityPayload,
  assertLeaseMatchesAuthority, verifyAuthority, verifyTurnLease,
} from '@openclaude/protocol'
import type { Cc5BridgeBinding } from '@openclaude/gateway/cc5-container-runtime'
import type {
  Cc5FinancePort, Cc5FinanceTurn, Cc5FinanceTerminalOutcome, Cc5NativeTerminalReceipt,
} from '@openclaude/gateway/cc5-finance'
import type { UserModelAuthzLoader } from '../auth/userModelAuthz.js'
import { loadSettledUsageAttribution } from '../db/pgSessionsBackend.js'
import {
  AUTHORITY_HEADER, TURN_LEASE_HEADER, enforceModelAuthority,
} from '../http/proxy/modelAuthorityGate.js'
import type { Logger } from '../logging/logger.js'
import { computeCost, type TokenUsage } from './calculator.js'
import type { ModelCatalogCache } from './modelCatalog.js'
import { parseBillingPricing, serializeBillingPricing, type PersistedBillingPricingV1 } from './persistedBillingPricing.js'
import { REMOTE_NATIVE_BILLING_RECOVERY_VERSION } from './remoteNativeBillingIdentity.js'
import {
  preCheckWithCost, releasePreCheck, type PreCheckRedis, type ReservationHandle,
} from './preCheck.js'
import {
  claimInflightJournalForSettlement, finalizeInflightJournal, settleUsageAndLedger,
  startInflightJournal, type BillingAuthorityStamp,
} from './proxyBilling.js'

export { REMOTE_NATIVE_BILLING_RECOVERY_VERSION } from './remoteNativeBillingIdentity.js'
export const REMOTE_NATIVE_CANONICAL_MODEL = 'box-claude-sonnet-5'
const UPSTREAM_MODEL = 'claude-sonnet-5'
const BACKEND = 'cc5-interactive-v1'
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
interface Scope {
  uid: string; containerDbId: string; dockerId: string; operationId: string; runId: string
  sessionKey: string; canonicalModel: string; backendKind: typeof BACKEND; expiresAt: number
}
interface Context {
  v: 1; scope: Scope; requestId: string; turnKey: string; authorityTurnId: string
  dispatchId: string; attemptNo: number; sessionId: string
  pricing: PersistedBillingPricingV1; billingRevision: string
  authority: { kind: 'bridge_signed'; executionRevision: string; projectionRevision: null; securityEpoch: string }
  hostStartAttempted: boolean; input: { sequence: number; inputSha256: string } | null
  receipt: Cc5NativeTerminalReceipt | null; reserved: boolean; reservedCredits: string
}
export interface RemoteNativeTurnFinanceDeps {
  pool: Pool
  preCheckRedis: PreCheckRedis
  catalog: ModelCatalogCache
  keyring: AuthorityKeyring | (() => AuthorityKeyring)
  loadUserModelAuthz: UserModelAuthzLoader
  log: Logger
  now?: () => number
}
/** Primitive substitutes are for isolated tests only. Production passes no second argument. */
export interface RemoteNativeFinanceFixtures {
  reserve?: typeof preCheckWithCost
  release?: typeof releasePreCheck
  settle?: typeof settleUsageAndLedger
}
function scopeOf(binding: Readonly<Cc5BridgeBinding>): Scope {
  need(binding.version === 2 && binding.backendKind === BACKEND
    && binding.canonicalModel === REMOTE_NATIVE_CANONICAL_MODEL
    && POSITIVE_ID.test(binding.uid) && POSITIVE_ID.test(binding.containerDbId)
    && HASH.test(binding.dockerId) && UUID.test(binding.operationId) && UUID.test(binding.runId)
    && typeof binding.sessionKey === 'string' && binding.sessionKey.length > 0
    && binding.sessionKey.length <= 512 && Number.isSafeInteger(binding.expiresAt))
  return { uid: binding.uid, containerDbId: binding.containerDbId, dockerId: binding.dockerId,
    operationId: binding.operationId, runId: binding.runId, sessionKey: binding.sessionKey,
    canonicalModel: binding.canonicalModel, backendKind: BACKEND, expiresAt: binding.expiresAt }
}
export function validateRemoteNativeReceipt(raw: unknown, scope: Scope): Cc5NativeTerminalReceipt {
  const r = object(raw)
  need(Object.keys(r).sort().join(',') === 'backendKind,canonicalModel,containerDbId,dockerId,nativeSessionId,operationId,resultSha256,runId,sessionKey,status,uid,upstreamModel,usage,version')
  need(r.version === 1 && r.backendKind === BACKEND && r.uid === scope.uid
    && r.containerDbId === scope.containerDbId && r.dockerId === scope.dockerId
    && r.operationId === scope.operationId && r.runId === scope.runId
    && r.sessionKey === scope.sessionKey && r.canonicalModel === scope.canonicalModel
    && r.upstreamModel === UPSTREAM_MODEL && typeof r.nativeSessionId === 'string'
    && UUID.test(r.nativeSessionId) && typeof r.resultSha256 === 'string' && HASH.test(r.resultSha256)
    && (r.status === 'success' || r.status === 'error'))
  const u = object(r.usage)
  need(Object.keys(u).sort().join(',') === 'cacheReadTokens,cacheWriteTokens,inputTokens,outputTokens')
  for (const value of Object.values(u)) need(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
  return structuredClone(raw) as Cc5NativeTerminalReceipt
}
function parseContext(raw: unknown): Context {
  const c = object(raw)
  need(c.v === 1 && typeof c.requestId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(c.requestId)
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
  scopeOf({ ...s, version: 2 } as unknown as Cc5BridgeBinding)
  need(parseBillingPricing(c.pricing, REMOTE_NATIVE_CANONICAL_MODEL))
  const a = object(c.authority)
  need(a.kind === 'bridge_signed' && typeof a.executionRevision === 'string'
    && a.executionRevision.length > 0 && a.projectionRevision === null
    && typeof a.securityEpoch === 'string' && /^\d+$/.test(a.securityEpoch))
  if (c.input !== null) {
    const i = object(c.input)
    need(i.sequence === 1 && typeof i.inputSha256 === 'string' && HASH.test(i.inputSha256))
  }
  if (c.receipt !== null) validateRemoteNativeReceipt(c.receipt, s as unknown as Scope)
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
  return { version: 1, backendKind: BACKEND, operationId: c.scope.operationId, runId: c.scope.runId,
    nativeSessionId: r.nativeSessionId, resultSha256: r.resultSha256 }
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
  [c.requestId, c.scope.uid, REMOTE_NATIVE_BILLING_RECOVERY_VERSION])).rows[0]
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
  if (proof.state === 'committed') return true
  need(proof.state === 'inflight' || proof.state === 'finalizing')
  const repaired = await pool.query(`/* remote-native:repair */
    UPDATE request_finalize_journal SET state='committed',usage_id=$4,ledger_id=$5,
      final_credits=$6,failure_code=NULL,ctx=ctx-'settlementClaimId',updated_at=NOW()
    WHERE request_id=$1 AND user_id=$2 AND ctx->>'remoteNativeBillingRecovery'=$3
      AND ctx->'remoteNative'=$7::jsonb AND state IN ('inflight','finalizing')`,
  [c.requestId, c.scope.uid, REMOTE_NATIVE_BILLING_RECOVERY_VERSION, proof.usage_id,
    proof.ledger_id, proof.cost_credits, JSON.stringify(c)])
  return repaired.rowCount === 1 || (await readProof(pool, c))?.state === 'committed'
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
): Cc5FinancePort {
  const reserve = fixtures.reserve ?? preCheckWithCost
  const release = fixtures.release ?? releasePreCheck
  const settle = fixtures.settle ?? settleUsageAndLedger
  const claimedOperations = new Set<string>()
  const now = deps.now ?? Date.now
  return { async admit(input) {
    const scope = scopeOf(input.binding)
    need(scope.expiresAt > now() && input.sessionKey === scope.sessionKey && HASH.test(input.turnKey)
      && !claimedOperations.has(scope.operationId))
    claimedOperations.add(scope.operationId) // one admission, including an unknown ACK
    const keys = typeof deps.keyring === 'function' ? deps.keyring() : deps.keyring
    const a = verifyAuthority(input.authorityEnvelope, keys, now())
    const lease = verifyTurnLease(input.leaseEnvelope, keys, now())
    assertLeaseMatchesAuthority(lease, a)
    const backend = (a as ModelAuthorityPayload & { executionBackend?: { kind: string; sessionKey: string; operationId: string } }).executionBackend
    need(a.engine === 'ccb' && a.canonicalModel === scope.canonicalModel
      && String(a.uid) === scope.uid && String(a.containerId) === scope.containerDbId
      && backend?.kind === BACKEND && backend.operationId === scope.operationId
      && backend.sessionKey === scope.sessionKey && typeof a.billingRequestId === 'string'
      && /^[A-Za-z0-9_-]{1,64}$/.test(a.billingRequestId))
    const fence = () => enforceModelAuthority({ catalog: deps.catalog,
      keyring: typeof deps.keyring === 'function' ? deps.keyring() : deps.keyring,
      headers: { [AUTHORITY_HEADER]: input.authorityEnvelope, [TURN_LEASE_HEADER]: input.leaseEnvelope },
      uid: BigInt(scope.uid), containerId: BigInt(scope.containerDbId), model: scope.canonicalModel,
      loadUserModelAuthz: deps.loadUserModelAuthz, logger: deps.log, now: now() })
    const gate = await fence()
    need(gate.authorityKind === 'bridge_signed' && gate.canonicalModel === scope.canonicalModel
      && gate.descriptor.engine === 'ccb' && gate.verifiedSignedContextOwner === 'box-native-v1')
    const pricing = gate.snapshot.billingPricingFor(scope.canonicalModel)
    need(pricing)
    const client = await deps.pool.connect()
    let dispatch: { dispatch_id: string; attempt_no: number; session_id: string; turn_key: string | null; authority_turn_key: string | null }
    try {
      await client.query('BEGIN')
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
    const c: Context = { v: 1, scope, requestId: a.billingRequestId, turnKey: input.turnKey,
      authorityTurnId: a.authorityTurnId, dispatchId: dispatch.dispatch_id, attemptNo: dispatch.attempt_no,
      sessionId: dispatch.session_id, pricing: serializeBillingPricing(pricing),
      billingRevision: gate.snapshot.billingRevision,
      authority: { kind: 'bridge_signed', executionRevision: gate.executionRevision,
        projectionRevision: null, securityEpoch: gate.securityEpoch.toString() },
      hostStartAttempted: false, input: null, receipt: null, reserved: false, reservedCredits: '0' }
    const started = await startInflightJournal(deps.pool, { requestId: c.requestId,
      userId: BigInt(scope.uid), containerId: BigInt(scope.containerDbId), model: scope.canonicalModel,
      precheckCredits: REMOTE_NATIVE_RESERVATION_CREDITS, dispatchId: c.dispatchId, attemptNo: c.attemptNo,
      ctxJson: { remoteNativeBillingRecovery: REMOTE_NATIVE_BILLING_RECOVERY_VERSION, remoteNative: c } })
    need(started) // do not overwrite/release another invocation's reservation
    const prehostAbort = async (reason: 'USER_CANCELLED' | 'INTERNAL_ERROR') => {
      const row = await deps.pool.query(`/* remote-native:prehost-abort */
        UPDATE request_finalize_journal SET state='aborted',final_credits=0,
          failure_code=$5,error_msg='remote_native_prehost_stopped',updated_at=NOW()
        WHERE request_id=$1 AND user_id=$2 AND ctx->>'remoteNativeBillingRecovery'=$3
          AND ctx#>>'{remoteNative,scope,operationId}'=$4 AND state='inflight'
          AND ctx#>>'{remoteNative,hostStartAttempted}'='false'
          AND ctx#>'{remoteNative,input}'='null'::jsonb`,
      [c.requestId, scope.uid, REMOTE_NATIVE_BILLING_RECOVERY_VERSION, scope.operationId, reason])
      if (row.rowCount === 1) await releaseSoftReservation(deps.preCheckRedis, c, deps.log, release)
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
      [c.requestId, scope.uid, REMOTE_NATIVE_BILLING_RECOVERY_VERSION, JSON.stringify(c), c.reservedCredits])
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
      [c.requestId, scope.uid, REMOTE_NATIVE_BILLING_RECOVERY_VERSION, scope.operationId, JSON.stringify(value)])
    const turn: Cc5FinanceTurn = {
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
          && !inputAttempted && value.sequence === 1 && HASH.test(value.inputSha256))
        inputAttempted = true
        await fence()
        const row = await scopedUpdate('dispatch-input', 'input', value,
          "AND ctx#>>'{remoteNative,hostStartAttempted}'='true' AND ctx#>'{remoteNative,input}'='null'::jsonb")
        need(row.rowCount === 1)
        c.input = structuredClone(value)
      },
      terminal(raw) {
        const receipt = validateRemoteNativeReceipt(raw, scope)
        need(hostAttempted && inputAttempted && c.input)
        if (c.receipt) need(isDeepStrictEqual(c.receipt, receipt))
        if (finish) return finish
        c.receipt = receipt
        finish = (async () => {
          try {
            const row = await scopedUpdate('receipt', 'receipt', receipt,
              "AND ctx#>>'{remoteNative,hostStartAttempted}'='true' AND ctx#>'{remoteNative,input}'<>'null'::jsonb AND (ctx#>'{remoteNative,receipt}'='null'::jsonb OR ctx#>'{remoteNative,receipt}'=$5::jsonb)")
            need(row.rowCount === 1)
            if (await settleReceipt(deps.pool, c, settle)) {
              await releaseSoftReservation(deps.preCheckRedis, c, deps.log, release)
              return { state: 'proven' as const, requestId: c.requestId }
            }
          } catch {
            // Even a COMMIT error may hide a real debit. A complete readback,
            // never an optimistic finalizer result, is the delivery authority.
            try {
              if (await proveAndRepair(deps.pool, c)) {
                await releaseSoftReservation(deps.preCheckRedis, c, deps.log, release)
                return { state: 'proven' as const, requestId: c.requestId }
              }
            } catch { /* unknown remains durable and unreplayed */ }
          }
          return { state: 'pending' as const }
        })()
        return finish
      },
      async stop(value) {
        if (hostAttempted || c.hostStartAttempted || value.hostStartAttempted || value.userSubmitted || !value.remoteStopped) return
        await prehostAbort('USER_CANCELLED')
      },
    }
    return turn
  } }
}

/** Only durable terminal receipts enter this recovery path; no model/SSH port exists here. */
export async function recoverRemoteNativeTurnBilling(
  deps: Pick<RemoteNativeTurnFinanceDeps, 'pool' | 'preCheckRedis' | 'log'>,
  options: { limit?: number; settle?: typeof settleUsageAndLedger } = {},
): Promise<{ proven: number; pending: number }> {
  const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 25)))
  const rows = (await deps.pool.query<JournalRow & { request_id: string; user_id: string }>(
    `/* remote-native:recovery-scan */ SELECT request_id,user_id::text,state,ctx,updated_at
     FROM request_finalize_journal WHERE ctx->>'remoteNativeBillingRecovery'=$1
       AND state IN ('inflight','finalizing') AND ctx#>'{remoteNative,receipt}'<>'null'::jsonb
     ORDER BY updated_at ASC LIMIT $2`, [REMOTE_NATIVE_BILLING_RECOVERY_VERSION, limit])).rows
  let proven = 0
  let pending = 0
  for (const row of rows) {
    try {
      const c = parseContext(row.ctx.remoteNative)
      need(c.requestId === row.request_id && c.scope.uid === row.user_id)
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
        [c.requestId, c.scope.uid, REMOTE_NATIVE_BILLING_RECOVERY_VERSION, JSON.stringify(c), STALE_SETTLEMENT_MS])
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
