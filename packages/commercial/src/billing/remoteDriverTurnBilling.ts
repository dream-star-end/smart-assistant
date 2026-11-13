/**
 * Generic `remote-driver-v4` financial admission, receipt persistence, ledger settlement,
 * and crash spool recovery (`OCV5-749`).
 *
 * Contains ZERO per-engine branches (`AC-6`): both `per_turn` (`cc`, `example_echo`, future
 * drivers) and `cumulative` (`codex`, future cumulative drivers) settle through a single
 * policy-driven `RemoteReceiptV4` boundary backed by `remote_native_threads` and
 * `remote_native_turns`.
 */
import { closeSync, constants, fstatSync, openSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Pool } from 'pg'
import {
  REMOTE_DRIVER_BACKEND,
  REMOTE_DRIVER_PROTOCOL_VERSION,
  assertLeaseMatchesAuthority,
  normalizeUsageWithPolicy,
  sameRemoteExecutionBackend,
  validateRemoteReceiptV4,
  validateUsagePolicy,
  verifyAuthority,
  verifyTurnLease,
  zeroCountersForUsagePolicy,
  type AuthorityKeyring,
  type RemoteDriverAuthorityEngine,
  type RemoteDriverUsagePolicy,
  type RemoteReceiptV4,
} from '@openclaude/protocol'
import {
  assertRemotePoolBinding,
  remotePoolBackendOf,
  type RemotePoolBinding,
  type RemotePoolFinancePort,
  type RemotePoolFinanceTurn,
} from '@openclaude/gateway/remote-pool'
import type { Cc5FinanceTerminalOutcome } from '@openclaude/gateway/cc5-finance'
import { loadRemoteDriverRegistry } from '../account-pool/remotePool/registry.js'
import type { UserModelAuthzLoader } from '../auth/userModelAuthz.js'
import { loadSettledUsageAttribution } from '../db/pgSessionsBackend.js'
import {
  AUTHORITY_HEADER,
  TURN_LEASE_HEADER,
  enforceRemoteNativeModelAuthority,
  type CatalogSource,
} from '../http/proxy/modelAuthorityGate.js'
import type { Logger } from '../logging/logger.js'
import { computeCost, type TokenUsage } from './calculator.js'
import {
  parseBillingPricing,
  serializeBillingPricing,
  type PersistedBillingPricingV1,
} from './persistedBillingPricing.js'
import {
  preCheckWithCost,
  releasePreCheck,
  type PreCheckRedis,
  type ReservationHandle,
} from './preCheck.js'
import {
  claimInflightJournalForSettlement,
  finalizeInflightJournal,
  settleUsageAndLedger,
  startInflightJournal,
  type BillingAuthorityStamp,
} from './proxyBilling.js'
import {
  CODEX_REMOTE_BILLING_RECOVERY_VERSION,
  REMOTE_DRIVER_V4_BILLING_RECOVERY_VERSION,
  REMOTE_NATIVE_BILLING_RECOVERY_VERSION,
} from './remoteNativeBillingIdentity.js'

export { REMOTE_DRIVER_V4_BILLING_RECOVERY_VERSION } from './remoteNativeBillingIdentity.js'

const REMOTE_DRIVER_RESERVATION_CREDITS = 100n
const UUID_RE = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const HASH_RE = /^[a-f0-9]{64}$/
const IDENT_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const STALE_SETTLEMENT_MS = 5 * 60_000

function need(condition: unknown, code = 'REMOTE_DRIVER_BILLING_REJECTED'): asserts condition {
  if (!condition) throw new Error(code)
}

function asObject(value: unknown, code = 'REMOTE_DRIVER_BILLING_REJECTED'): Record<string, unknown> {
  need(value && typeof value === 'object' && !Array.isArray(value), code)
  return value as Record<string, unknown>
}

export interface RemoteDriverScopeV4 {
  readonly version: 4
  readonly backendKind: typeof REMOTE_DRIVER_BACKEND
  readonly operationId: string
  readonly runId: string
  readonly uid: string
  readonly containerDbId: string
  readonly dockerId: string
  readonly sessionKey: string
  readonly canonicalModel: string
  readonly upstreamModel: string
  readonly driverId: string
  readonly engineId: string
  readonly authorityEngine: RemoteDriverAuthorityEngine
  readonly driverVersion: string
  readonly driverDigest: string
  readonly coreDigest: string
  readonly probeFingerprint: string
  readonly manifestSha256: string
  readonly generation: string
  readonly profileId: string
  readonly authEpoch: string
  readonly expiresAt: number
}

interface RemoteDriverJournalContextV4 {
  v: 4
  scope: RemoteDriverScopeV4
  requestId: string
  turnKey: string
  authorityTurnId: string
  dispatchId: string
  attemptNo: number
  sessionId: string
  pricing: PersistedBillingPricingV1
  billingRevision: string
  authority: {
    kind: 'bridge_signed'
    executionRevision: string
    projectionRevision: null
    securityEpoch: string
  }
  usagePolicy: RemoteDriverUsagePolicy
  hostStartAttempted: boolean
  input: { sequence: number; inputSha256: string } | null
  native?: {
    sessionId: string
    baseline: Record<string, number> | null
  }
  receipt: RemoteReceiptV4 | null
  reserved: boolean
  reservedCredits: string
}

export interface RemoteDriverTurnFinanceDeps {
  pool: Pool
  preCheckRedis: PreCheckRedis
  catalog: CatalogSource
  keyring: AuthorityKeyring | (() => AuthorityKeyring)
  loadUserModelAuthz: UserModelAuthzLoader
  log: Logger
  registryPath?: string
  now?: () => number
}

export interface RemoteDriverFinanceFixtures {
  reserve?: typeof preCheckWithCost
  release?: typeof releasePreCheck
  settle?: typeof settleUsageAndLedger
}

function scopeFromBinding(
  binding: Readonly<RemotePoolBinding>,
  registryPath?: string,
  verifyCurrentRegistry = true,
): RemoteDriverScopeV4 {
  assertRemotePoolBinding(binding)
  if (verifyCurrentRegistry) {
    const regMap = loadRemoteDriverRegistry(registryPath)
    const reg = regMap.get(binding.driverId)
    need(
      reg &&
        reg.engineId === binding.engineId &&
        reg.authorityEngine === binding.authorityEngine &&
        reg.driverVersion === binding.driverVersion &&
        reg.driverDigest === binding.driverDigest &&
        reg.coreDigest === binding.coreDigest,
      'REMOTE_DRIVER_REGISTRY_DIGEST_MISMATCH',
    )
  }
  return {
    version: REMOTE_DRIVER_PROTOCOL_VERSION,
    backendKind: REMOTE_DRIVER_BACKEND,
    operationId: binding.operationId,
    runId: binding.runId,
    uid: binding.uid,
    containerDbId: binding.containerDbId,
    dockerId: binding.dockerId,
    sessionKey: binding.sessionKey,
    canonicalModel: binding.canonicalModel,
    upstreamModel: binding.upstreamModel,
    driverId: binding.driverId,
    engineId: binding.engineId,
    authorityEngine: binding.authorityEngine,
    driverVersion: binding.driverVersion,
    driverDigest: binding.driverDigest,
    coreDigest: binding.coreDigest,
    probeFingerprint: binding.probeFingerprint,
    manifestSha256: binding.manifestSha256,
    generation: binding.generation,
    profileId: binding.profileId,
    authEpoch: binding.authEpoch,
    expiresAt: binding.expiresAt,
  }
}

function validateDriverReceiptForScope(
  raw: unknown,
  scope: RemoteDriverScopeV4,
  policy: RemoteDriverUsagePolicy,
): RemoteReceiptV4 {
  const r = validateRemoteReceiptV4(raw, policy)
  need(
    r.engineId === scope.engineId &&
      r.driverId === scope.driverId &&
      r.driverVersion === scope.driverVersion &&
      r.driverDigest === scope.driverDigest &&
      r.uid === scope.uid &&
      r.containerDbId === scope.containerDbId &&
      r.dockerId === scope.dockerId &&
      r.operationId === scope.operationId &&
      r.runId === scope.runId &&
      r.sessionKey === scope.sessionKey &&
      r.canonicalModel === scope.canonicalModel &&
      r.upstreamModel === scope.upstreamModel &&
      r.profileId === scope.profileId &&
      r.authEpoch === scope.authEpoch &&
      r.usageSemantics === policy.semanticsId &&
      r.usageMode === policy.mode &&
      r.provenance.generation === scope.generation &&
      r.provenance.manifestHash === scope.manifestSha256 &&
      r.provenance.coreDigest === scope.coreDigest &&
      r.provenance.probeFingerprint === scope.probeFingerprint,
    'REMOTE_RECEIPT_V4_SCOPE_MISMATCH',
  )
  return r
}

function parseContextV4(raw: unknown): RemoteDriverJournalContextV4 {
  const c = asObject(raw)
  need(
    c.v === 4 &&
      typeof c.requestId === 'string' &&
      /^[A-Za-z0-9_-]{1,64}$/.test(c.requestId) &&
      typeof c.turnKey === 'string' &&
      HASH_RE.test(c.turnKey) &&
      typeof c.authorityTurnId === 'string' &&
      /^[a-f0-9]{32}$/.test(c.authorityTurnId) &&
      typeof c.dispatchId === 'string' &&
      UUID_RE.test(c.dispatchId) &&
      typeof c.attemptNo === 'number' &&
      Number.isSafeInteger(c.attemptNo) &&
      c.attemptNo > 0 &&
      typeof c.sessionId === 'string' &&
      c.sessionId.length > 0 &&
      c.sessionId.length <= 256 &&
      typeof c.billingRevision === 'string' &&
      c.billingRevision.length > 0 &&
      typeof c.hostStartAttempted === 'boolean' &&
      typeof c.reserved === 'boolean' &&
      typeof c.reservedCredits === 'string' &&
      /^\d+$/.test(c.reservedCredits) &&
      BigInt(c.reservedCredits) <= REMOTE_DRIVER_RESERVATION_CREDITS,
  )
  const s = asObject(c.scope)
  const scope = scopeFromBinding(
    { ...(s as unknown as RemotePoolBinding), capability: '0'.repeat(64) },
    undefined,
    false,
  )
  const usagePolicy = validateUsagePolicy(c.usagePolicy)
  need(parseBillingPricing(c.pricing, scope.canonicalModel))
  const a = asObject(c.authority)
  need(
    a.kind === 'bridge_signed' &&
      typeof a.executionRevision === 'string' &&
      a.executionRevision.length > 0 &&
      a.projectionRevision === null &&
      typeof a.securityEpoch === 'string' &&
      /^\d+$/.test(a.securityEpoch),
  )
  if (c.input !== null) {
    const i = asObject(c.input)
    need(
      typeof i.sequence === 'number' &&
        Number.isSafeInteger(i.sequence) &&
        i.sequence > 0 &&
        typeof i.inputSha256 === 'string' &&
        HASH_RE.test(i.inputSha256),
    )
  }
  if (c.native !== undefined) {
    const n = asObject(c.native)
    need(typeof n.sessionId === 'string' && IDENT_RE.test(n.sessionId))
    if (usagePolicy.mode === 'cumulative') {
      need(n.baseline !== null && typeof n.baseline === 'object' && !Array.isArray(n.baseline))
      normalizeUsageWithPolicy(
        usagePolicy,
        n.baseline as Record<string, number>,
        n.baseline as Record<string, number>,
      )
    } else {
      need(n.baseline === null)
    }
  }
  if (c.receipt !== null) {
    const r = validateDriverReceiptForScope(c.receipt, scope, usagePolicy)
    need(
      r.authorityTurnId === c.authorityTurnId &&
        r.turnKey === c.turnKey &&
        r.requestId === c.requestId &&
        c.native !== undefined &&
        r.nativeSessionId === (c.native as RemoteDriverJournalContextV4['native'])!.sessionId &&
        isDeepStrictEqual(
          r.countersBaseline,
          (c.native as RemoteDriverJournalContextV4['native'])!.baseline,
        ),
    )
  }
  return structuredClone(raw) as RemoteDriverJournalContextV4
}

function reservationHandle(c: RemoteDriverJournalContextV4): ReservationHandle {
  return { userId: c.scope.uid, requestId: c.requestId }
}

async function releaseSoftReservation(
  redis: PreCheckRedis,
  c: RemoteDriverJournalContextV4,
  log: Logger,
  release = releasePreCheck,
): Promise<void> {
  try {
    await release(redis, reservationHandle(c))
  } catch {
    try {
      log.warn('remote_driver_v4_precheck_release_failed', { requestId: c.requestId })
    } catch {}
  }
}

function driverReceiptStamp(c: RemoteDriverJournalContextV4) {
  const r = c.receipt!
  return {
    version: 4,
    backendKind: r.backendKind,
    engineId: r.engineId,
    driverId: r.driverId,
    driverVersion: r.driverVersion,
    driverDigest: r.driverDigest,
    operationId: r.operationId,
    runId: r.runId,
    nativeSessionId: r.nativeSessionId,
    terminalId: r.terminalId,
    authorityTurnId: r.authorityTurnId,
    turnKey: r.turnKey,
    usageSemantics: r.usageSemantics,
    usageMode: r.usageMode,
    countersBaseline: r.countersBaseline,
    countersFinal: r.countersFinal,
    rawEvidenceDigest: r.rawEvidenceDigest,
    semanticDigest: r.semanticDigest,
    receiptDigest: r.receiptDigest,
    provenance: r.provenance,
  }
}

function usageOf(c: RemoteDriverJournalContextV4): TokenUsage {
  const u = c.receipt!.usage
  return {
    input_tokens: u.inputTokens,
    output_tokens: u.outputTokens,
    cache_read_tokens: u.cacheReadTokens,
    cache_write_tokens: u.cacheWriteTokens,
  }
}

interface JournalRow {
  state: string
  ctx: Record<string, unknown>
  updated_at?: Date
}

interface ProofRow extends JournalRow {
  usage_id: string
  ledger_id: string | null
  cost_credits: string
  account_id: string | null
  model: string
  container_id: string
  session_id: string
  turn_key: string
  dispatch_id: string
  attempt_no: number
  status: string
  input_tokens: string
  output_tokens: string
  cache_read_tokens: string
  cache_write_tokens: string
  price_snapshot: Record<string, unknown>
  execution_revision: string
  security_epoch: string
  authority_kind: string
}

async function readProofV4(pool: Pool, c: RemoteDriverJournalContextV4): Promise<ProofRow | null> {
  const row = (
    await pool.query<ProofRow>(
      `/* remote-driver-v4:readback */
       SELECT j.state, j.ctx, ur.id::text AS usage_id, ur.ledger_id::text AS ledger_id,
              ur.cost_credits::text, ur.account_id::text, ur.model, j.container_id::text, ur.session_id,
              ur.turn_key, ur.dispatch_id::text, ur.attempt_no, ur.status,
              ur.input_tokens::text, ur.output_tokens::text, ur.cache_read_tokens::text, ur.cache_write_tokens::text,
              ur.price_snapshot, ur.execution_revision, ur.security_epoch::text, ur.authority_kind
         FROM request_finalize_journal j
         JOIN usage_records ur
           ON ur.request_id = j.request_id AND ur.user_id = j.user_id
        WHERE j.request_id = $1
          AND j.user_id = $2
          AND j.ctx->>'remoteNativeBillingRecovery' = $3`,
      [c.requestId, c.scope.uid, REMOTE_DRIVER_V4_BILLING_RECOVERY_VERSION],
    )
  ).rows[0]
  if (!row) return null
  need(
    c.receipt &&
      row.account_id === null &&
      row.model === c.scope.canonicalModel &&
      row.container_id === c.scope.containerDbId &&
      row.session_id === c.sessionId &&
      row.turn_key === c.turnKey &&
      row.dispatch_id === c.dispatchId &&
      Number(row.attempt_no) === c.attemptNo &&
      row.status === (c.receipt.status === 'success' ? 'success' : 'error') &&
      row.execution_revision === c.authority.executionRevision &&
      row.security_epoch === c.authority.securityEpoch &&
      row.authority_kind === 'bridge_signed',
  )
  const stored = parseContextV4(row.ctx.remoteDriverV4)
  need(isDeepStrictEqual(stored, c))
  const u = c.receipt.usage
  need(
    row.input_tokens === String(u.inputTokens) &&
      row.output_tokens === String(u.outputTokens) &&
      row.cache_read_tokens === String(u.cacheReadTokens) &&
      row.cache_write_tokens === String(u.cacheWriteTokens) &&
      isDeepStrictEqual(row.price_snapshot.remote_native, driverReceiptStamp(c)),
  )
  const p = c.pricing
  for (const [key, value] of Object.entries({
    model_id: p.modelId,
    input_per_mtok: p.inputPerMtok,
    output_per_mtok: p.outputPerMtok,
    cache_read_per_mtok: p.cacheReadPerMtok,
    cache_write_per_mtok: p.cacheWritePerMtok,
    multiplier: p.multiplier,
  })) {
    need(row.price_snapshot[key] === value)
  }
  const attribution = await loadSettledUsageAttribution(pool, BigInt(c.scope.uid), c.requestId)
  need(
    attribution &&
      attribution.usageId.toString() === row.usage_id &&
      (attribution.ledgerId?.toString() ?? null) === row.ledger_id &&
      attribution.costCredits.toString() === row.cost_credits &&
      attribution.attributionCredits !== null,
  )
  const pricing = parseBillingPricing(c.pricing, c.scope.canonicalModel)
  need(pricing)
  const nominal = computeCost(usageOf(c), pricing).cost_credits
  const expected = c.receipt.status === 'error' || c.receipt.usage.outputTokens === 0 ? 0n : nominal
  const autoWaived =
    row.price_snapshot.waived === 'turn_auto_waive' &&
    row.price_snapshot.wouldHaveCharged === expected.toString()
  need(
    attribution.costCredits === (autoWaived ? 0n : expected) &&
      attribution.attributionCredits >= 0n &&
      attribution.attributionCredits <= attribution.costCredits &&
      (attribution.attributionCredits === 0n || row.ledger_id !== null),
  )
  return row
}

async function releaseNativeBoundaryV4(pool: Pool, c: RemoteDriverJournalContextV4): Promise<void> {
  if (!c.receipt) return
  const r = c.receipt
  await pool.query(
    `/* remote-driver-v4:release-boundary */
     UPDATE remote_native_threads
        SET pending_request_id = NULL,
            updated_at = NOW()
      WHERE uid = $1
        AND operation_id = $2
        AND native_thread_id = $3
        AND pending_request_id = $4
        AND last_native_turn_id = $5
        AND total = $6::jsonb`,
    [
      c.scope.uid,
      c.scope.operationId,
      r.nativeSessionId,
      c.requestId,
      r.terminalId,
      JSON.stringify(r.countersFinal),
    ],
  )
}

async function proveAndRepairV4(pool: Pool, c: RemoteDriverJournalContextV4): Promise<boolean> {
  const proof = await readProofV4(pool, c)
  if (!proof) return false
  if (proof.state === 'committed') {
    await releaseNativeBoundaryV4(pool, c)
    return true
  }
  need(proof.state === 'inflight' || proof.state === 'finalizing')
  const repaired = await pool.query(
    `/* remote-driver-v4:repair */
     UPDATE request_finalize_journal
        SET state = 'committed',
            usage_id = $4,
            ledger_id = $5,
            final_credits = $6,
            failure_code = NULL,
            ctx = ctx - 'settlementClaimId',
            updated_at = NOW()
      WHERE request_id = $1
        AND user_id = $2
        AND ctx->>'remoteNativeBillingRecovery' = $3
        AND ctx->'remoteDriverV4' = $7::jsonb
        AND state IN ('inflight', 'finalizing')`,
    [
      c.requestId,
      c.scope.uid,
      REMOTE_DRIVER_V4_BILLING_RECOVERY_VERSION,
      proof.usage_id,
      proof.ledger_id,
      proof.cost_credits,
      JSON.stringify(c),
    ],
  )
  const proven = repaired.rowCount === 1 || (await readProofV4(pool, c))?.state === 'committed'
  if (proven) await releaseNativeBoundaryV4(pool, c)
  return proven
}

async function bindNativeThreadV4(
  pool: Pool,
  c: RemoteDriverJournalContextV4,
  nativeSessionId: string,
  newlyCreated: boolean,
): Promise<Readonly<Record<string, number>> | null> {
  need(
    IDENT_RE.test(nativeSessionId) &&
      c.hostStartAttempted &&
      c.input === null &&
      c.native === undefined,
    'REMOTE_SESSION_BIND_INVALID',
  )
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (newlyCreated) {
      const zeroCounters = zeroCountersForUsagePolicy(c.usagePolicy)
      const added = await client.query(
        `INSERT INTO remote_native_threads
           (uid, operation_id, native_thread_id, profile_id, auth_epoch, upstream_model,
            total, engine_id, driver_id, usage_semantics, usage_mode)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)
         ON CONFLICT DO NOTHING`,
        [
          c.scope.uid,
          c.scope.operationId,
          nativeSessionId,
          c.scope.profileId,
          c.scope.authEpoch,
          c.scope.upstreamModel,
          JSON.stringify(zeroCounters),
          c.scope.engineId,
          c.scope.driverId,
          c.usagePolicy.semanticsId,
          c.usagePolicy.mode,
        ],
      )
      need(added.rowCount === 1, 'REMOTE_SESSION_ALREADY_EXISTS')
    }
    const row = (
      await client.query(
        `SELECT * FROM remote_native_threads
          WHERE uid = $1 AND operation_id = $2 AND native_thread_id = $3
          FOR UPDATE`,
        [c.scope.uid, c.scope.operationId, nativeSessionId],
      )
    ).rows[0]
    need(
      row &&
        row.profile_id === c.scope.profileId &&
        row.auth_epoch === c.scope.authEpoch &&
        row.pending_request_id === null,
      'REMOTE_SESSION_BOUNDARY_BUSY_OR_MISMATCH',
    )
    if (row.engine_id !== null) {
      need(row.engine_id === c.scope.engineId, 'REMOTE_THREAD_ENGINE_MISMATCH')
    }
    if (row.usage_mode !== null) {
      need(row.usage_mode === c.usagePolicy.mode, 'REMOTE_USAGE_MODE_INCOMPATIBLE')
    }
    if (row.usage_semantics !== null) {
      need(row.usage_semantics === c.usagePolicy.semanticsId, 'REMOTE_USAGE_SEMANTICS_INCOMPATIBLE')
    }

    let baseline: Record<string, number> | null = null
    if (c.usagePolicy.mode === 'cumulative') {
      const storedTotal = asObject(row.total, 'REMOTE_CUMULATIVE_BASELINE_INVALID') as Record<string, number>
      const validated = normalizeUsageWithPolicy(c.usagePolicy, storedTotal, storedTotal)
      baseline = { ...validated.final }
    }

    const native = { sessionId: nativeSessionId, baseline }
    await client.query(
      `UPDATE remote_native_threads
          SET pending_request_id = $4,
              upstream_model = $5,
              engine_id = COALESCE(engine_id, $6),
              driver_id = COALESCE(driver_id, $7),
              usage_semantics = COALESCE(usage_semantics, $8),
              usage_mode = COALESCE(usage_mode, $9),
              updated_at = NOW()
        WHERE uid = $1 AND operation_id = $2 AND native_thread_id = $3`,
      [
        c.scope.uid,
        c.scope.operationId,
        nativeSessionId,
        c.requestId,
        c.scope.upstreamModel,
        c.scope.engineId,
        c.scope.driverId,
        c.usagePolicy.semanticsId,
        c.usagePolicy.mode,
      ],
    )
    const bound = await client.query(
      `UPDATE request_finalize_journal
          SET ctx = jsonb_set(ctx, '{remoteDriverV4,native}', $4::jsonb),
              updated_at = NOW()
        WHERE request_id = $1
          AND user_id = $2
          AND ctx->>'remoteNativeBillingRecovery' = $3
          AND state = 'inflight'
          AND NOT (ctx->'remoteDriverV4' ? 'native')
          AND ctx#>>'{remoteDriverV4,hostStartAttempted}' = 'true'`,
      [c.requestId, c.scope.uid, REMOTE_DRIVER_V4_BILLING_RECOVERY_VERSION, JSON.stringify(native)],
    )
    need(bound.rowCount === 1, 'REMOTE_JOURNAL_BIND_FAILED')
    const bindingRows = (
      await client.query<{ native_session_id: string | null }>(
        `SELECT native_session_id
           FROM remote_agent_bindings
          WHERE operation_id = $1
            AND generation = $2
            AND remote_protocol_version = 4
          FOR UPDATE`,
        [c.scope.operationId, c.scope.generation],
      )
    ).rows
    need(bindingRows.length === 1, 'REMOTE_BINDING_NOT_FOUND')
    const existingNative = bindingRows[0]!.native_session_id
    need(
      existingNative === null || existingNative === nativeSessionId,
      'REMOTE_BINDING_NATIVE_SESSION_MISMATCH',
    )
    await client.query(
      `UPDATE remote_agent_bindings
          SET native_session_id = $3,
              updated_at = NOW()
        WHERE operation_id = $1
          AND generation = $2
          AND remote_protocol_version = 4`,
      [c.scope.operationId, c.scope.generation, nativeSessionId],
    )
    await client.query('COMMIT')
    c.native = native
    return baseline ? Object.freeze({ ...baseline }) : null
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

async function persistDriverReceiptV4(
  pool: Pool,
  c: RemoteDriverJournalContextV4,
  r: RemoteReceiptV4,
): Promise<void> {
  need(
    c.native &&
      c.native.sessionId === r.nativeSessionId &&
      isDeepStrictEqual(c.native.baseline, r.countersBaseline),
    'REMOTE_RECEIPT_BOUNDARY_MISMATCH',
  )
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const boundary = (
      await client.query(
        `SELECT * FROM remote_native_threads
          WHERE uid = $1 AND operation_id = $2 AND native_thread_id = $3
          FOR UPDATE`,
        [c.scope.uid, c.scope.operationId, r.nativeSessionId],
      )
    ).rows[0]
    need(boundary && boundary.pending_request_id === c.requestId, 'REMOTE_BOUNDARY_OWNER_MISMATCH')

    const existingByTurn = (
      await client.query(
        `SELECT * FROM remote_native_turns
          WHERE uid = $1 AND operation_id = $2 AND native_thread_id = $3 AND native_turn_id = $4`,
        [c.scope.uid, c.scope.operationId, r.nativeSessionId, r.terminalId],
      )
    ).rows[0]
    const existingByReq = (
      await client.query('SELECT * FROM remote_native_turns WHERE request_id = $1', [c.requestId])
    ).rows[0]

    const previous = existingByTurn ?? existingByReq
    if (previous) {
      need(
        previous.uid?.toString() === c.scope.uid &&
          String(previous.operation_id) === c.scope.operationId &&
          previous.native_thread_id === r.nativeSessionId &&
          previous.native_turn_id === r.terminalId &&
          previous.request_id === c.requestId &&
          previous.receipt_sha256 === r.receiptDigest &&
          previous.semantic_digest === r.semanticDigest &&
          isDeepStrictEqual(previous.receipt, r),
        'REMOTE_RECEIPT_CONFLICT',
      )
    } else {
      if (c.usagePolicy.mode === 'cumulative') {
        need(isDeepStrictEqual(boundary.total, r.countersBaseline), 'REMOTE_CUMULATIVE_BASELINE_DRIFT')
      }
      await client.query(
        `INSERT INTO remote_native_turns
           (uid, operation_id, native_thread_id, native_turn_id, request_id,
            receipt_sha256, receipt, engine_id, driver_id, usage_semantics, usage_mode,
            semantic_digest, raw_evidence_digest)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13)`,
        [
          c.scope.uid,
          c.scope.operationId,
          r.nativeSessionId,
          r.terminalId,
          c.requestId,
          r.receiptDigest,
          JSON.stringify(r),
          r.engineId,
          r.driverId,
          r.usageSemantics,
          r.usageMode,
          r.semanticDigest,
          r.rawEvidenceDigest,
        ],
      )
      await client.query(
        `UPDATE remote_native_threads
            SET total = $4::jsonb,
                last_native_turn_id = $5,
                driver_id = $6,
                engine_id = $7,
                usage_semantics = $8,
                usage_mode = $9,
                updated_at = NOW()
          WHERE uid = $1 AND operation_id = $2 AND native_thread_id = $3`,
        [
          c.scope.uid,
          c.scope.operationId,
          r.nativeSessionId,
          JSON.stringify(r.countersFinal),
          r.terminalId,
          r.driverId,
          r.engineId,
          r.usageSemantics,
          r.usageMode,
        ],
      )
    }

    const saved = await client.query(
      `UPDATE request_finalize_journal
          SET ctx = jsonb_set(ctx, '{remoteDriverV4,receipt}', $4::jsonb),
              updated_at = NOW()
        WHERE request_id = $1
          AND user_id = $2
          AND ctx->>'remoteNativeBillingRecovery' = $3
          AND state = 'inflight'
          AND ctx#>>'{remoteDriverV4,hostStartAttempted}' = 'true'
          AND ctx#>'{remoteDriverV4,input}' <> 'null'::jsonb
          AND (ctx#>'{remoteDriverV4,receipt}' = 'null'::jsonb OR ctx#>'{remoteDriverV4,receipt}' = $4::jsonb)`,
      [c.requestId, c.scope.uid, REMOTE_DRIVER_V4_BILLING_RECOVERY_VERSION, JSON.stringify(r)],
    )
    need(saved.rowCount === 1, 'REMOTE_RECEIPT_CONFLICT')
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

async function settleDriverReceiptV4(
  pool: Pool,
  c: RemoteDriverJournalContextV4,
  settle: typeof settleUsageAndLedger,
): Promise<boolean> {
  need(c.hostStartAttempted && c.input && c.receipt)
  if (await proveAndRepairV4(pool, c)) return true
  const claim = await claimInflightJournalForSettlement(pool, c.requestId)
  if (!claim) return false
  const pricing = parseBillingPricing(c.pricing, c.scope.canonicalModel)
  need(pricing)
  const usage = usageOf(c)
  const calculated = computeCost(usage, pricing)
  const noOutput =
    c.receipt.status === 'success' &&
    c.receipt.usage.outputTokens === 0 &&
    calculated.cost_credits > 0n
  const cost = c.receipt.status === 'error' || noOutput ? 0n : calculated.cost_credits
  const result = await settle(pool, {
    userId: BigInt(c.scope.uid),
    accountId: null,
    requestId: c.requestId,
    model: c.scope.canonicalModel,
    usage,
    snapshotJson: JSON.stringify({
      ...calculated.snapshot,
      remote_native: driverReceiptStamp(c),
      ...(noOutput ? { waived: 'no_output', wouldHaveCharged: calculated.cost_credits.toString() } : {}),
    }),
    costCredits: cost,
    status: c.receipt.status === 'success' ? 'success' : 'error',
    sessionId: c.sessionId,
    mode: 'chat',
    turnKey: c.turnKey,
    authority: {
      ...c.authority,
      securityEpoch: BigInt(c.authority.securityEpoch),
    } as BillingAuthorityStamp,
    dispatchId: c.dispatchId,
    attemptNo: c.attemptNo,
  })
  await finalizeInflightJournal(pool, {
    requestId: c.requestId,
    finalCredits: result.settledCostCredits ?? cost,
    ledgerId: result.ledgerId,
    usageId: result.usageId,
    settlementClaimId: claim,
  })
  return proveAndRepairV4(pool, c)
}

const MAX_INPROCESS_DEDUP_ENTRIES = 16_384

function rememberBounded(set: Set<string>, key: string): void {
  if (set.has(key)) return
  if (set.size >= MAX_INPROCESS_DEDUP_ENTRIES) {
    const oldest = set.values().next().value
    if (oldest !== undefined) set.delete(oldest)
  }
  set.add(key)
}

export function createRemoteDriverTurnFinance(
  deps: RemoteDriverTurnFinanceDeps,
  fixtures: RemoteDriverFinanceFixtures = {},
): RemotePoolFinancePort {
  const reserve = fixtures.reserve ?? preCheckWithCost
  const release = fixtures.release ?? releasePreCheck
  const settle = fixtures.settle ?? settleUsageAndLedger
  const claimedAuthorities = new Set<string>()
  const claimedRequests = new Set<string>()
  const claimedTurns = new Set<string>()
  const activeOperations = new Map<string, string>()
  const now = deps.now ?? Date.now

  return {
    async admit(input): Promise<RemotePoolFinanceTurn> {
      const scope = scopeFromBinding(input.binding, deps.registryPath, true)
      const usagePolicy = validateUsagePolicy(input.usagePolicy)
      need(
        scope.expiresAt > now() &&
          input.sessionKey === scope.sessionKey &&
          HASH_RE.test(input.turnKey),
        'REMOTE_DRIVER_ADMISSION_SCOPE_INVALID',
      )
      const keys = typeof deps.keyring === 'function' ? deps.keyring() : deps.keyring
      const a = verifyAuthority(input.authorityEnvelope, keys, now())
      const lease = verifyTurnLease(input.leaseEnvelope, keys, now())
      assertLeaseMatchesAuthority(lease, a)
      need(
        a.engine === scope.authorityEngine &&
          a.canonicalModel === scope.canonicalModel &&
          String(a.uid) === scope.uid &&
          String(a.containerId) === scope.containerDbId &&
          sameRemoteExecutionBackend(a.executionBackend, remotePoolBackendOf(input.binding)) &&
          typeof a.billingRequestId === 'string' &&
          /^[A-Za-z0-9_-]{1,64}$/.test(a.billingRequestId),
        'REMOTE_DRIVER_AUTHORITY_MISMATCH',
      )
      const requestId = a.billingRequestId
      need(
        !activeOperations.has(scope.operationId) &&
          !claimedAuthorities.has(a.authorityTurnId) &&
          !claimedRequests.has(requestId) &&
          !claimedTurns.has(input.turnKey),
        'REMOTE_DRIVER_REPLAY_OR_OPERATION_BUSY',
      )
      rememberBounded(claimedAuthorities, a.authorityTurnId)
      rememberBounded(claimedRequests, requestId)
      rememberBounded(claimedTurns, input.turnKey)
      activeOperations.set(scope.operationId, requestId)
      const releaseActive = () => {
        if (activeOperations.get(scope.operationId) === requestId) {
          activeOperations.delete(scope.operationId)
        }
      }

      let gate: Awaited<ReturnType<typeof enforceRemoteNativeModelAuthority>>
      try {
        const fence = () =>
          enforceRemoteNativeModelAuthority({
            catalog: deps.catalog,
            keyring: typeof deps.keyring === 'function' ? deps.keyring() : deps.keyring,
            headers: {
              [AUTHORITY_HEADER]: input.authorityEnvelope,
              [TURN_LEASE_HEADER]: input.leaseEnvelope,
            },
            uid: BigInt(scope.uid),
            containerId: BigInt(scope.containerDbId),
            model: scope.canonicalModel,
            loadUserModelAuthz: deps.loadUserModelAuthz,
            logger: deps.log,
            now: now(),
          })
        gate = await fence()
        need(
          gate.authorityKind === 'bridge_signed' &&
            gate.canonicalModel === scope.canonicalModel &&
            gate.descriptor.engine === scope.authorityEngine &&
            gate.descriptor.placement === 'remote_pool',
        )
        const pricing = gate.snapshot.billingPricingFor(scope.canonicalModel)
        need(pricing)

        const client = await deps.pool.connect()
        let dispatch: {
          dispatch_id: string
          attempt_no: number
          session_id: string
          turn_key: string | null
          authority_turn_key: string | null
        }
        try {
          await client.query('BEGIN')
          await client.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
            [`remote-finance:${scope.uid}:${scope.operationId}`],
          )
          const pending = await client.query(
            `SELECT 1 FROM request_finalize_journal
              WHERE user_id = $1
                AND ctx->>'remoteNativeBillingRecovery' = ANY($2::text[])
                AND (
                  ctx#>>'{remoteNative,scope,operationId}' = $3
                  OR ctx#>>'{remoteDriverV4,scope,operationId}' = $3
                )
                AND state IN ('inflight', 'finalizing')
              LIMIT 1`,
            [
              scope.uid,
              [
                REMOTE_NATIVE_BILLING_RECOVERY_VERSION,
                CODEX_REMOTE_BILLING_RECOVERY_VERSION,
                REMOTE_DRIVER_V4_BILLING_RECOVERY_VERSION,
              ],
              scope.operationId,
            ],
          )
          need(pending.rows.length === 0, 'REMOTE_OPERATION_BILLING_PENDING')

          const selected = (
            await client.query<typeof dispatch>(
              `/* remote-driver-v4:dispatch */
               SELECT d.dispatch_id::text, d.attempt_no, d.session_id,
                      d.turn_key, atd.turn_key AS authority_turn_key
                 FROM authority_turn_dispatches atd
                 JOIN turn_dispatches d ON d.dispatch_id = atd.dispatch_id
                WHERE atd.authority_turn_id = $1
                  AND atd.user_id = $2
                  AND d.user_id = atd.user_id
                  AND d.billing_request_id = $3
                  AND d.agent_container_id = $4
                  AND atd.canonical_model = $5
                  AND d.model = $5
                  AND d.attempt_no = atd.attempt_no
                  AND d.session_id = atd.session_id
                  AND d.status IN ('admitted', 'accepted')
                  AND d.terminal_at IS NULL
                  AND d.producer_fenced_at IS NULL
                FOR UPDATE OF atd, d`,
              [a.authorityTurnId, scope.uid, requestId, scope.containerDbId, scope.canonicalModel],
            )
          ).rows[0]
          need(
            selected &&
              UUID_RE.test(selected.dispatch_id) &&
              selected.attempt_no > 0 &&
              typeof selected.session_id === 'string' &&
              (selected.turn_key === null || selected.turn_key === input.turnKey) &&
              (selected.authority_turn_key === null || selected.authority_turn_key === input.turnKey),
            'REMOTE_DISPATCH_BINDING_INVALID',
          )
          const bound = await client.query(
            `/* remote-driver-v4:bind-turn */
             WITH authority_bound AS (
               UPDATE authority_turn_dispatches
                  SET turn_key = $6
                WHERE authority_turn_id = $1
                  AND user_id = $2
                  AND dispatch_id = $3
                  AND attempt_no = $4
                  AND session_id = $5
                  AND (turn_key IS NULL OR turn_key = $6)
                RETURNING dispatch_id
             )
             UPDATE turn_dispatches
                SET turn_key = $6
              WHERE dispatch_id = $3
                AND user_id = $2
                AND attempt_no = $4
                AND session_id = $5
                AND (turn_key IS NULL OR turn_key = $6)
                AND EXISTS (SELECT 1 FROM authority_bound WHERE dispatch_id = $3)`,
            [
              a.authorityTurnId,
              scope.uid,
              selected.dispatch_id,
              selected.attempt_no,
              selected.session_id,
              input.turnKey,
            ],
          )
          need(bound.rowCount === 1, 'REMOTE_DISPATCH_TURN_KEY_CONFLICT')
          await client.query('COMMIT')
          dispatch = selected
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {})
          throw err
        } finally {
          client.release()
        }

        const c: RemoteDriverJournalContextV4 = {
          v: 4,
          scope,
          requestId,
          turnKey: input.turnKey,
          authorityTurnId: a.authorityTurnId,
          dispatchId: dispatch.dispatch_id,
          attemptNo: dispatch.attempt_no,
          sessionId: dispatch.session_id,
          pricing: serializeBillingPricing(pricing),
          billingRevision: gate.snapshot.billingRevision,
          authority: {
            kind: 'bridge_signed',
            executionRevision: gate.executionRevision,
            projectionRevision: null,
            securityEpoch: gate.securityEpoch.toString(),
          },
          usagePolicy,
          hostStartAttempted: false,
          input: null,
          receipt: null,
          reserved: false,
          reservedCredits: '0',
        }

        const started = await startInflightJournal(deps.pool, {
          requestId: c.requestId,
          userId: BigInt(scope.uid),
          containerId: BigInt(scope.containerDbId),
          model: scope.canonicalModel,
          precheckCredits: REMOTE_DRIVER_RESERVATION_CREDITS,
          dispatchId: c.dispatchId,
          attemptNo: c.attemptNo,
          ctxJson: {
            remoteNativeBillingRecovery: REMOTE_DRIVER_V4_BILLING_RECOVERY_VERSION,
            remoteDriverV4: c,
          },
        })
        need(started, 'REMOTE_JOURNAL_START_CONFLICT')

        const prehostAbort = async (
          reason: 'USER_CANCELLED' | 'INTERNAL_ERROR',
          provenNoHostEffect = false,
          diagnostic = 'remote_driver_v4_prehost_stopped',
        ): Promise<boolean> => {
          const row = await deps.pool.query(
            `/* remote-driver-v4:prehost-abort */
             UPDATE request_finalize_journal
                SET state = 'aborted',
                    final_credits = 0,
                    failure_code = $5,
                    error_msg = $7,
                    updated_at = NOW()
              WHERE request_id = $1
                AND user_id = $2
                AND ctx->>'remoteNativeBillingRecovery' = $3
                AND ctx#>>'{remoteDriverV4,scope,operationId}' = $4
                AND state = 'inflight'
                AND (ctx#>>'{remoteDriverV4,hostStartAttempted}' = 'false' OR $6::boolean)
                AND NOT (ctx->'remoteDriverV4' ? 'native')
                AND ctx#>'{remoteDriverV4,input}' = 'null'::jsonb`,
            [
              c.requestId,
              scope.uid,
              REMOTE_DRIVER_V4_BILLING_RECOVERY_VERSION,
              scope.operationId,
              reason,
              provenNoHostEffect,
              diagnostic,
            ],
          )
          if (row.rowCount === 1) {
            await releaseSoftReservation(deps.preCheckRedis, c, deps.log, release)
            releaseActive()
            return true
          }
          return false
        }

        try {
          const pre = await reserve(deps.preCheckRedis, {
            userId: scope.uid,
            requestId: c.requestId,
            maxCost: REMOTE_DRIVER_RESERVATION_CREDITS,
            ttlSeconds: Math.min(
              14_700,
              Math.max(300, Math.ceil((scope.expiresAt - now()) / 1000) + 300),
            ),
          })
          c.reserved = true
          c.reservedCredits = pre.maxCost.toString()
          const reserved = await deps.pool.query(
            `/* remote-driver-v4:reserved */
             UPDATE request_finalize_journal
                SET ctx = jsonb_set(ctx, '{remoteDriverV4}', $4::jsonb),
                    precheck_credits = $5,
                    updated_at = NOW()
              WHERE request_id = $1
                AND user_id = $2
                AND ctx->>'remoteNativeBillingRecovery' = $3
                AND state = 'inflight'
                AND ctx#>>'{remoteDriverV4,hostStartAttempted}' = 'false'`,
            [
              c.requestId,
              scope.uid,
              REMOTE_DRIVER_V4_BILLING_RECOVERY_VERSION,
              JSON.stringify(c),
              c.reservedCredits,
            ],
          )
          need(reserved.rowCount === 1)
        } catch (err) {
          await prehostAbort('INTERNAL_ERROR').catch(() => {})
          throw err
        }

        let hostAttempted = false
        let inputAttempted = false
        let finish: Promise<Cc5FinanceTerminalOutcome> | undefined

        const scopedUpdate = async (tag: string, path: string, value: unknown, extra: string) =>
          deps.pool.query(
            `/* remote-driver-v4:${tag} */
             UPDATE request_finalize_journal
                SET ctx = jsonb_set(ctx, '{remoteDriverV4,${path}}', $5::jsonb),
                    updated_at = NOW()
              WHERE request_id = $1
                AND user_id = $2
                AND ctx->>'remoteNativeBillingRecovery' = $3
                AND ctx#>>'{remoteDriverV4,scope,operationId}' = $4
                AND state = 'inflight' ${extra}`,
            [
              c.requestId,
              scope.uid,
              REMOTE_DRIVER_V4_BILLING_RECOVERY_VERSION,
              scope.operationId,
              JSON.stringify(value),
            ],
          )

        return {
          requestId: c.requestId,
          async beforeHostStart() {
            need(!hostAttempted && scope.expiresAt > now())
            hostAttempted = true
            await fence()
            const row = await scopedUpdate(
              'host-start',
              'hostStartAttempted',
              true,
              "AND ctx#>>'{remoteDriverV4,hostStartAttempted}' = 'false' AND ctx#>>'{remoteDriverV4,reserved}' = 'true'",
            )
            need(row.rowCount === 1)
            c.hostStartAttempted = true
          },
          bindNativeThread(nativeSessionId: string, newlyCreated: boolean) {
            return bindNativeThreadV4(deps.pool, c, nativeSessionId, newlyCreated)
          },
          async beforeDispatch(value) {
            need(
              scope.expiresAt > now() &&
                hostAttempted &&
                c.hostStartAttempted &&
                c.native !== undefined &&
                !inputAttempted &&
                Number.isSafeInteger(value.sequence) &&
                value.sequence > 0 &&
                HASH_RE.test(value.inputSha256),
            )
            inputAttempted = true
            await fence()
            const row = await scopedUpdate(
              'dispatch-input',
              'input',
              value,
              "AND ctx#>>'{remoteDriverV4,hostStartAttempted}' = 'true' AND ctx#>'{remoteDriverV4,input}' = 'null'::jsonb",
            )
            need(row.rowCount === 1)
            c.input = structuredClone(value)
          },
          terminal(rawReceipt) {
            const receipt = validateDriverReceiptForScope(rawReceipt, scope, usagePolicy)
            need(
              receipt.authorityTurnId === c.authorityTurnId &&
                receipt.turnKey === c.turnKey &&
                receipt.requestId === c.requestId,
              'REMOTE_RECEIPT_TURN_IDENTITY_MISMATCH',
            )
            need(hostAttempted && inputAttempted && c.input && c.native)
            if (c.receipt) {
              need(isDeepStrictEqual(c.receipt, receipt), 'REMOTE_RECEIPT_CONFLICT')
            }
            if (finish) return finish
            c.receipt = receipt
            finish = (async () => {
              try {
                await persistDriverReceiptV4(deps.pool, c, receipt)
                if (await settleDriverReceiptV4(deps.pool, c, settle)) {
                  await releaseSoftReservation(deps.preCheckRedis, c, deps.log, release)
                  releaseActive()
                  return { state: 'proven' as const, requestId: c.requestId }
                }
              } catch (err) {
                if (err instanceof Error && err.message === 'REMOTE_RECEIPT_CONFLICT') {
                  throw err
                }
                try {
                  if (await proveAndRepairV4(deps.pool, c)) {
                    await releaseSoftReservation(deps.preCheckRedis, c, deps.log, release)
                    releaseActive()
                    return { state: 'proven' as const, requestId: c.requestId }
                  }
                } catch {}
              }
              return { state: 'pending' as const }
            })()
            return finish
          },
          async abandonUndispatched(cause?: { failureCode: 'INTERNAL_ERROR'; diagnostic: string }) {
            need(!inputAttempted && c.input === null && !c.receipt)
            need(
              cause === undefined ||
                (cause.failureCode === 'INTERNAL_ERROR' && /^[a-z0-9_]{1,64}$/.test(cause.diagnostic)),
            )
            const failureCode = cause?.failureCode ?? 'USER_CANCELLED'
            if (!hostAttempted && !c.hostStartAttempted) {
              return (await prehostAbort(failureCode, false, cause?.diagnostic))
                ? { state: 'proven' as const, requestId: c.requestId }
                : { state: 'pending' as const }
            }
            const client = await deps.pool.connect()
            try {
              await client.query('BEGIN')
              const journal = await client.query(
                `/* remote-driver-v4:abandon-undispatched */
                 UPDATE request_finalize_journal
                    SET state = 'aborted',
                        final_credits = 0,
                        failure_code = $5,
                        error_msg = $6,
                        updated_at = NOW()
                  WHERE request_id = $1
                    AND user_id = $2
                    AND ctx->>'remoteNativeBillingRecovery' = $3
                    AND ctx#>>'{remoteDriverV4,scope,operationId}' = $4
                    AND state = 'inflight'
                    AND ctx#>>'{remoteDriverV4,hostStartAttempted}' = 'true'
                    AND ctx#>'{remoteDriverV4,input}' = 'null'::jsonb
                    AND ctx#>'{remoteDriverV4,receipt}' = 'null'::jsonb`,
                [
                  c.requestId,
                  scope.uid,
                  REMOTE_DRIVER_V4_BILLING_RECOVERY_VERSION,
                  scope.operationId,
                  failureCode,
                  cause?.diagnostic ?? 'remote_driver_v4_abandoned_before_dispatch',
                ],
              )
              if (journal.rowCount !== 1) {
                await client.query('ROLLBACK')
                return { state: 'pending' as const }
              }
              if (c.native) {
                const released =
                  c.usagePolicy.mode === 'cumulative'
                    ? await client.query(
                        `UPDATE remote_native_threads
                            SET pending_request_id = NULL,
                                updated_at = NOW()
                          WHERE uid = $1
                            AND operation_id = $2
                            AND native_thread_id = $3
                            AND pending_request_id = $4
                            AND total = $5::jsonb`,
                        [
                          scope.uid,
                          scope.operationId,
                          c.native.sessionId,
                          c.requestId,
                          JSON.stringify(c.native.baseline),
                        ],
                      )
                    : await client.query(
                        `UPDATE remote_native_threads
                            SET pending_request_id = NULL,
                                updated_at = NOW()
                          WHERE uid = $1
                            AND operation_id = $2
                            AND native_thread_id = $3
                            AND pending_request_id = $4`,
                        [scope.uid, scope.operationId, c.native.sessionId, c.requestId],
                      )
                need(released.rowCount === 1)
              }
              await client.query('COMMIT')
            } catch (err) {
              await client.query('ROLLBACK').catch(() => {})
              throw err
            } finally {
              client.release()
            }
            await releaseSoftReservation(deps.preCheckRedis, c, deps.log, release)
            releaseActive()
            return { state: 'proven' as const, requestId: c.requestId }
          },
          async stop(value) {
            if (value.userSubmitted || !value.remoteStopped) return
            if (value.nodeAdmissionRejected && !c.native && !inputAttempted) {
              await prehostAbort(
                'INTERNAL_ERROR',
                true,
                value.nodeAdmissionReason ?? 'REMOTE_NODE_MEMORY_EXHAUSTED',
              )
              return
            }
            const noTurnEffect = !c.native && !inputAttempted
            if ((value.hostStartAttempted || hostAttempted || c.hostStartAttempted) && !noTurnEffect) {
              return
            }
            await prehostAbort('USER_CANCELLED', noTurnEffect)
          },
        }
      } catch (err) {
        releaseActive()
        throw err
      }
    },
  }
}

async function importDriverV4Spool(
  pool: Pool,
  c: RemoteDriverJournalContextV4,
  root: string,
): Promise<void> {
  if (c.receipt || !c.native || !c.input || !c.hostStartAttempted) return
  need(UUID_RE.test(c.scope.operationId) && /^[1-9][0-9]{0,15}$/.test(c.scope.generation))
  const dir = join(root, c.scope.operationId, c.scope.generation, 'journal')
  let files: string[]
  try {
    files = readdirSync(dir)
      .filter((f) => /^[0-9]{8}-native-terminal\.json$/.test(f))
      .sort()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
  for (const file of files) {
    const fd = openSync(
      join(dir, file),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    let raw: unknown
    try {
      const st = fstatSync(fd)
      need(
        st.isFile() &&
          st.nlink === 1 &&
          st.size <= 262_144 &&
          !(st.mode & 0o022) &&
          st.uid === process.getuid?.(),
      )
      raw = JSON.parse(readFileSync(fd, 'utf8'))
    } finally {
      closeSync(fd)
    }
    const r = validateDriverReceiptForScope(raw, c.scope, c.usagePolicy)
    if (
      r.authorityTurnId !== c.authorityTurnId ||
      r.turnKey !== c.turnKey ||
      r.requestId !== c.requestId
    ) {
      continue
    }
    await persistDriverReceiptV4(pool, c, r)
    c.receipt = r
    return
  }
}

/**
 * Durable-receipt-only crash recovery for `remote-driver-v4` journals.
 * Never opens an SSH/model port or re-executes a turn.
 */
export async function recoverRemoteDriverTurnBilling(
  deps: Pick<RemoteDriverTurnFinanceDeps, 'pool' | 'preCheckRedis' | 'log'>,
  options: {
    limit?: number
    settle?: typeof settleUsageAndLedger
    evidenceRoot?: string
    preloadedRows?: Array<JournalRow & { request_id: string; user_id: string }>
  } = {},
): Promise<{ proven: number; pending: number }> {
  const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 25)))
  const rows =
    options.preloadedRows ??
    (
      await deps.pool.query<JournalRow & { request_id: string; user_id: string }>(
        `/* remote-driver-v4:recovery-scan */
         SELECT request_id, user_id::text, state, ctx, updated_at
           FROM request_finalize_journal
          WHERE ctx->>'remoteNativeBillingRecovery' = $1
            AND (
              state IN ('inflight', 'finalizing')
              OR (
                state = 'committed'
                AND EXISTS (
                  SELECT 1 FROM remote_native_threads t
                   WHERE t.uid = user_id AND t.pending_request_id = request_id
                )
              )
            )
          ORDER BY updated_at ASC
          LIMIT $2`,
        [REMOTE_DRIVER_V4_BILLING_RECOVERY_VERSION, limit],
      )
    ).rows

  let proven = 0
  let pending = 0
  for (const row of rows) {
    try {
      const c = parseContextV4(row.ctx.remoteDriverV4)
      need(c.requestId === row.request_id && c.scope.uid === row.user_id)
      await importDriverV4Spool(
        deps.pool,
        c,
        options.evidenceRoot ?? '/var/lib/openclaude/remote-native',
      )
      if (!c.receipt && !c.input && !c.native) {
        const aborted = await deps.pool.query(
          `UPDATE request_finalize_journal j
              SET state = 'aborted',
                  final_credits = 0,
                  failure_code = 'INTERNAL_ERROR',
                  error_msg = 'remote_driver_v4_prehost_stopped',
                  updated_at = NOW()
            WHERE request_id = $1
              AND user_id = $2
              AND state = 'inflight'
              AND ctx->'remoteDriverV4' = $3::jsonb
              AND EXISTS (
                SELECT 1 FROM remote_agent_bindings b
                 WHERE b.operation_id = $4
                   AND b.generation = $5
                   AND b.remote_protocol_version = 4
                   AND b.state = 'released'
              )`,
          [c.requestId, c.scope.uid, JSON.stringify(c), c.scope.operationId, c.scope.generation],
        )
        if (aborted.rowCount === 1) {
          await releaseSoftReservation(deps.preCheckRedis, c, deps.log)
          proven++
          continue
        }
      }
      if (!c.receipt) {
        await deps.pool.query(
          `UPDATE request_finalize_journal
              SET updated_at = NOW()
            WHERE request_id = $1
              AND user_id = $2
              AND state = 'inflight'
              AND ctx->'remoteDriverV4' = $3::jsonb
              AND ctx#>'{remoteDriverV4,receipt}' = 'null'::jsonb`,
          [c.requestId, c.scope.uid, JSON.stringify(c)],
        )
        pending++
        continue
      }
      if (await proveAndRepairV4(deps.pool, c)) {
        await releaseSoftReservation(deps.preCheckRedis, c, deps.log)
        proven++
        continue
      }
      if (row.state === 'finalizing') {
        const reset = await deps.pool.query(
          `/* remote-driver-v4:reclaim */
           UPDATE request_finalize_journal
              SET state = 'inflight',
                  ctx = ctx - 'settlementClaimId',
                  updated_at = NOW()
            WHERE request_id = $1
              AND user_id = $2
              AND ctx->>'remoteNativeBillingRecovery' = $3
              AND ctx->'remoteDriverV4' = $4::jsonb
              AND state = 'finalizing'
              AND updated_at < NOW() - ($5::bigint * INTERVAL '1 millisecond')
              AND NOT EXISTS (
                SELECT 1 FROM usage_records u WHERE u.request_id = $1 AND u.user_id = $2
              )`,
          [
            c.requestId,
            c.scope.uid,
            REMOTE_DRIVER_V4_BILLING_RECOVERY_VERSION,
            JSON.stringify(c),
            STALE_SETTLEMENT_MS,
          ],
        )
        if (reset.rowCount !== 1) {
          pending++
          continue
        }
      }
      if (await settleDriverReceiptV4(deps.pool, c, options.settle ?? settleUsageAndLedger)) {
        await releaseSoftReservation(deps.preCheckRedis, c, deps.log)
        proven++
      } else {
        pending++
      }
    } catch {
      pending++
      deps.log.warn('remote_driver_v4_billing_recovery_pending', {})
    }
  }
  return { proven, pending }
}
