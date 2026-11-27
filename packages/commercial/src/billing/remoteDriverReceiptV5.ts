/**
 * OCV5-915 P3-1 — Extracted `remote-driver-v4` / `TurnReceiptV5` Billing Receipt Bridge.
 *
 * Extracted from `remoteDriverTurnBilling.ts` (keeping `remoteDriverTurnBilling.ts` net-negative
 * below its 1762L frozen cap) while adding self-validated `TurnReceiptV5` generation and
 * validation alongside `RemoteReceiptV4` during Master settlement and crash spool recovery.
 *
 * Invariants:
 * - Module: `billing` (L3). ZERO imports from `@openclaude/gateway/*` (`R2-same-layer`/`R2-scope`).
 * - ZERO DDL, ZERO billing formula or balance/ledger modifications.
 * - Q1 backward compatibility: `driverReceiptStamp(receipt)` produces the EXACT byte-identical
 *   20-field object for `price_snapshot.remote_native`; `turn_receipt_v5` is strictly optional.
 * - ZERO `process.env`, `syncIo`, `emptyCatch`, `typeEscape`, `export *`, or engine literals.
 */
import { isDeepStrictEqual } from 'node:util'
import {
  REMOTE_DRIVER_BACKEND,
  REMOTE_DRIVER_PROTOCOL_VERSION,
  buildTurnReceiptV5FromRemoteV4,
  validateRemoteReceiptV4,
  validateTurnReceiptV5,
  type InferenceServiceTier,
  type RemoteDriverAuthorityEngine,
  type RemoteDriverUsagePolicy,
  type RemoteReceiptV4,
  type TurnReceiptV5,
} from '@openclaude/protocol'
import { loadRemoteDriverRegistry } from '../account-pool/remotePool/registry.js'

function need(condition: unknown, code = 'REMOTE_DRIVER_BILLING_REJECTED'): asserts condition {
  if (!condition) throw new Error(code)
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

export interface RemoteDriverBindingLike extends Omit<RemoteDriverScopeV4, 'version' | 'backendKind'> {
  readonly version: 4
  readonly backendKind: typeof REMOTE_DRIVER_BACKEND
  readonly capability?: string
}

export function scopeFromBinding(
  binding: Readonly<RemoteDriverBindingLike>,
  registryPath?: string,
  verifyCurrentRegistry = true,
): RemoteDriverScopeV4 {
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

export function validateDriverReceiptForScope(
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

/**
 * Q1 invariant: Byte-identical 20-field `price_snapshot.remote_native` stamp so pre-upgrade
 * inflight journal rows and proof readbacks match `isDeepStrictEqual` verbatim.
 */
export function driverReceiptStamp(r: RemoteReceiptV4) {
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

export function isRemoteDriverServiceTier(raw: unknown): raw is InferenceServiceTier {
  return raw === 'standard' || raw === 'fast' || raw === 'ultrafast'
}

export function isOptionalRemoteDriverServiceTier(raw: unknown): boolean {
  return raw === undefined || isRemoteDriverServiceTier(raw)
}

export function validateContextV4TurnReceiptV5(
  rawTurnReceiptV5: unknown,
  scope: RemoteDriverScopeV4,
  receipt: RemoteReceiptV4 | null,
): void {
  if (receipt === null) {
    need(rawTurnReceiptV5 === undefined, 'REMOTE_TURN_RECEIPT_V5_WITHOUT_V4')
    return
  }
  if (rawTurnReceiptV5 !== undefined) {
    validateRemoteDriverTurnReceiptV5(rawTurnReceiptV5, scope, receipt)
  }
}

export function matchesDriverSnapshotStamps(
  priceSnapshot: Record<string, unknown>,
  receipt: RemoteReceiptV4,
  turnReceiptV5?: TurnReceiptV5,
): boolean {
  if (!isDeepStrictEqual(priceSnapshot.remote_native, driverReceiptStamp(receipt))) {
    return false
  }
  if (turnReceiptV5 === undefined) return true
  return isDeepStrictEqual(priceSnapshot.turn_receipt_v5, turnReceiptV5)
}

export interface PersistedDispatchInputV4 {
  readonly sequence: number
  readonly inputSha256: string
  readonly serviceTier?: InferenceServiceTier
}

export function prepareRemoteDriverDispatchInput(value: {
  readonly sequence: number
  readonly inputSha256: string
  readonly serviceTier?: unknown
}): PersistedDispatchInputV4 {
  need(
    Number.isSafeInteger(value.sequence) &&
      value.sequence > 0 &&
      /^[a-f0-9]{64}$/.test(value.inputSha256) &&
      isOptionalRemoteDriverServiceTier(value.serviceTier),
  )
  return {
    sequence: value.sequence,
    inputSha256: value.inputSha256,
    ...(isRemoteDriverServiceTier(value.serviceTier) ? { serviceTier: value.serviceTier } : {}),
  }
}

export function validateContextV4Input(raw: unknown): void {
  need(raw !== null && typeof raw === 'object' && !Array.isArray(raw))
  const i = raw as Record<string, unknown>
  need(
    typeof i.sequence === 'number' &&
      Number.isSafeInteger(i.sequence) &&
      i.sequence > 0 &&
      typeof i.inputSha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(i.inputSha256) &&
      isOptionalRemoteDriverServiceTier(i.serviceTier),
  )
}

export interface JournalReceiptQueryClient {
  query<T = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rowCount: number | null; rows?: T[] }>
}

export async function persistJournalReceiptV4AndV5(
  client: JournalReceiptQueryClient,
  params: {
    readonly requestId: string
    readonly scope: RemoteDriverScopeV4
    readonly recoveryVersion: string
    readonly receipt: RemoteReceiptV4
    readonly serviceTier: InferenceServiceTier
    readonly turnReceiptV5?: TurnReceiptV5
  },
): Promise<TurnReceiptV5 | undefined> {
  const { requestId, scope, recoveryVersion, receipt, serviceTier, turnReceiptV5 } = params
  const saved = turnReceiptV5
    ? await client.query<{ persisted_turn_receipt_v5?: unknown }>(
        `UPDATE request_finalize_journal
            SET ctx = jsonb_set(
                  jsonb_set(ctx, '{remoteDriverV4,receipt}', $4::jsonb),
                  '{remoteDriverV4,turnReceiptV5}',
                  COALESCE(ctx#>'{remoteDriverV4,turnReceiptV5}', $5::jsonb)
                ),
                updated_at = NOW()
          WHERE request_id = $1
            AND user_id = $2
            AND ctx->>'remoteNativeBillingRecovery' = $3
            AND state = 'inflight'
            AND ctx#>>'{remoteDriverV4,hostStartAttempted}' = 'true'
            AND ctx#>'{remoteDriverV4,input}' <> 'null'::jsonb
            AND (ctx#>'{remoteDriverV4,receipt}' = 'null'::jsonb OR ctx#>'{remoteDriverV4,receipt}' = $4::jsonb)
        RETURNING ctx#>'{remoteDriverV4,turnReceiptV5}' AS persisted_turn_receipt_v5`,
        [requestId, scope.uid, recoveryVersion, JSON.stringify(receipt), JSON.stringify(turnReceiptV5)],
      )
    : await client.query<{ persisted_turn_receipt_v5?: unknown }>(
        `UPDATE request_finalize_journal
            SET ctx = jsonb_set(ctx, '{remoteDriverV4,receipt}', $4::jsonb),
                updated_at = NOW()
          WHERE request_id = $1
            AND user_id = $2
            AND ctx->>'remoteNativeBillingRecovery' = $3
            AND state = 'inflight'
            AND ctx#>>'{remoteDriverV4,hostStartAttempted}' = 'true'
            AND ctx#>'{remoteDriverV4,input}' <> 'null'::jsonb
            AND (ctx#>'{remoteDriverV4,receipt}' = 'null'::jsonb OR ctx#>'{remoteDriverV4,receipt}' = $4::jsonb)
        RETURNING ctx#>'{remoteDriverV4,turnReceiptV5}' AS persisted_turn_receipt_v5`,
        [requestId, scope.uid, recoveryVersion, JSON.stringify(receipt)],
      )
  need(saved.rowCount === 1, 'REMOTE_RECEIPT_CONFLICT')
  const persistedRaw = saved.rows?.[0]?.persisted_turn_receipt_v5
  if (persistedRaw !== undefined && persistedRaw !== null) {
    return validateRemoteDriverTurnReceiptV5(persistedRaw, scope, receipt, serviceTier)
  }
  return turnReceiptV5
}

export function resolveRemoteDriverServiceTier(sources: {
  readonly inputTier?: unknown
  readonly contextTier?: unknown
  readonly pricingTier?: unknown
  readonly scopeTier?: unknown
  readonly receiptTier?: unknown
}): InferenceServiceTier {
  for (const candidate of [
    sources.inputTier,
    sources.contextTier,
    sources.pricingTier,
    sources.scopeTier,
    sources.receiptTier,
  ]) {
    if (isRemoteDriverServiceTier(candidate)) return candidate
  }
  return 'standard'
}

export function buildRemoteDriverTurnReceiptV5(params: {
  readonly scope: RemoteDriverScopeV4
  readonly receiptV4: RemoteReceiptV4
  readonly serviceTier?: InferenceServiceTier
  readonly finalizedAt?: string
}): TurnReceiptV5 {
  const parsedGen = Number.parseInt(params.scope.generation, 10)
  const placementEpoch = Number.isSafeInteger(parsedGen) && parsedGen >= 1 ? parsedGen : 1
  return buildTurnReceiptV5FromRemoteV4({
    receiptV4: params.receiptV4,
    authorityEngine: params.scope.authorityEngine,
    serviceTier: params.serviceTier ?? 'standard',
    placementEpoch,
    finalizedAt: params.finalizedAt,
  })
}

export function validateRemoteDriverTurnReceiptV5(
  raw: unknown,
  scope: RemoteDriverScopeV4,
  receiptV4: RemoteReceiptV4,
  expectedServiceTier?: InferenceServiceTier,
): TurnReceiptV5 {
  const v5 = validateTurnReceiptV5(raw)
  need(
    v5.poolKind === 'remote_pool' &&
      v5.driverId === scope.driverId &&
      v5.tenantId === scope.uid &&
      v5.sessionKey === scope.sessionKey &&
      v5.turnId === receiptV4.authorityTurnId &&
      v5.turnKey === receiptV4.turnKey &&
      v5.requestId === receiptV4.requestId &&
      v5.canonicalModel === receiptV4.canonicalModel &&
      v5.upstreamModel === receiptV4.upstreamModel &&
      v5.usageSemantics === receiptV4.usageSemantics &&
      v5.usage.inputTokens === receiptV4.usage.inputTokens &&
      v5.usage.outputTokens === receiptV4.usage.outputTokens &&
      v5.usage.cacheReadTokens === receiptV4.usage.cacheReadTokens &&
      v5.usage.cacheWriteTokens === receiptV4.usage.cacheWriteTokens &&
      v5.status === receiptV4.nativeStatus &&
      v5.rawEvidenceDigest === receiptV4.rawEvidenceDigest &&
      (expectedServiceTier === undefined || v5.serviceTier === expectedServiceTier),
    'REMOTE_TURN_RECEIPT_V5_SCOPE_MISMATCH',
  )
  return v5
}
