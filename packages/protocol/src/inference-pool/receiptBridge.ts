/**
 * OCV5-915 P3-1 — Pure `TurnReceiptV5` builder/converter & Dual-Pool Parity verifier.
 *
 * Bridges v4 remote receipts (`RemoteReceiptV4`) and local turn outcomes onto the
 * single authoritative `TurnReceiptV5` contract with deterministic `semanticDigest`
 * parity verification across `local_pool` and `remote_pool`.
 *
 * L0 Contract Invariant (R2-contract-node): ZERO `node:*` imports allowed.
 */
import type { ModelAuthorityEngine } from '../modelAuthority.js'
import { remoteCanonicalSha256 } from '../remotePool/canonical.js'
import type { RemoteReceiptV4 } from '../remotePool/receipt.js'
import {
  INFERENCE_ENGINE_FAMILIES,
  INFERENCE_POOL_KINDS,
  INFERENCE_SERVICE_TIERS,
  type InferenceEngineFamily,
  type InferencePoolKind,
  type InferenceServiceTier,
  type NormalizedUsageCounters,
  type TurnReceiptV5,
  type TurnReceiptV5Body,
} from './contracts.js'
import {
  computeTurnReceiptV5Digests,
  resolveLogicalModelId,
  validateTurnReceiptV5,
} from './validators.js'

export const DEFAULT_TURN_RECEIPT_V5_USAGE_SEMANTICS = 'unified_pool_v5' as const
export const DEFAULT_RECEIPT_V5_DRIVER_VERSION = '5.0.0' as const

const SHA256_RE = /^[a-f0-9]{64}$/
const MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/
const DRIVER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const IDENT_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const TENANT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function stripControlChars(value: string): string {
  if (!hasControlChar(value)) return value
  let out = ''
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code > 0x1f && code !== 0x7f) {
      out += value[i]
    }
  }
  return out
}

const POOL_KIND_SET: ReadonlySet<string> = new Set<string>(INFERENCE_POOL_KINDS)
const ENGINE_FAMILY_SET: ReadonlySet<string> = new Set<string>(INFERENCE_ENGINE_FAMILIES)
const SERVICE_TIER_SET: ReadonlySet<string> = new Set<string>(INFERENCE_SERVICE_TIERS)

export const AUTHORITY_ENGINE_TO_INFERENCE_FAMILY: Readonly<
  Record<ModelAuthorityEngine, InferenceEngineFamily>
> = Object.freeze({
  ccb: 'cc',
  codex: 'codex',
  antigravity: 'antigravity',
  grok: 'grok',
  cursor: 'cursor',
  zcode: 'zcode',
})

const ENGINE_ALIAS_TO_FAMILY: Readonly<Record<string, InferenceEngineFamily>> = Object.freeze({
  ccb: 'cc',
  cc: 'cc',
  'claude-code': 'cc',
  codex: 'codex',
  antigravity: 'antigravity',
  grok: 'grok',
  'grok-build': 'grok',
  cursor: 'cursor',
  zcode: 'zcode',
})

export function authorityEngineToInferenceFamily(
  authorityEngine: ModelAuthorityEngine,
): InferenceEngineFamily {
  return AUTHORITY_ENGINE_TO_INFERENCE_FAMILY[authorityEngine]
}

export function inferEngineFamilyFromIdentifier(raw: string | undefined): InferenceEngineFamily {
  if (typeof raw === 'string') {
    const lower = raw.trim().toLowerCase()
    if (ENGINE_FAMILY_SET.has(lower)) {
      return lower as InferenceEngineFamily
    }
    const mapped = ENGINE_ALIAS_TO_FAMILY[lower]
    if (mapped !== undefined) return mapped
  }
  return 'cc'
}

function safeNonNegativeInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))
}

function sanitizeIdent(raw: string | undefined, fallback: string): string {
  if (typeof raw === 'string') {
    const cleaned = raw.trim().replace(/[^A-Za-z0-9._:-]/g, '_')
    if (cleaned.length > 0 && IDENT_RE.test(cleaned)) {
      return cleaned.slice(0, 128)
    }
  }
  return fallback
}

function sanitizeTenant(raw: string | undefined, fallback: string): string {
  if (typeof raw === 'string') {
    const cleaned = raw.trim().replace(/[^A-Za-z0-9._:-]/g, '_')
    if (cleaned.length > 0 && TENANT_ID_RE.test(cleaned)) {
      return cleaned.slice(0, 64)
    }
  }
  return fallback
}

function sanitizeModel(raw: string | undefined, fallback: string): string {
  if (typeof raw === 'string') {
    const cleaned = raw.trim().toLowerCase()
    if (MODEL_ID_RE.test(cleaned)) return cleaned
  }
  return fallback
}

function sanitizeDriverId(raw: string | undefined, fallback: string): string {
  if (typeof raw === 'string') {
    const cleaned = raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-')
    if (cleaned.length > 0 && DRIVER_ID_RE.test(cleaned)) {
      return cleaned.slice(0, 64)
    }
  }
  return fallback
}

function sanitizeSessionKey(raw: string | undefined, fallback: string): string {
  if (typeof raw === 'string') {
    const stripped = stripControlChars(raw).trim()
    if (stripped.length > 0) {
      return stripped.slice(0, 512)
    }
  }
  return fallback
}

function normalizeServiceTier(raw: string | null | undefined): InferenceServiceTier {
  if (typeof raw === 'string' && SERVICE_TIER_SET.has(raw)) {
    return raw as InferenceServiceTier
  }
  return 'standard'
}

function normalizePoolKind(raw: string | undefined, fallback: InferencePoolKind): InferencePoolKind {
  if (typeof raw === 'string' && POOL_KIND_SET.has(raw)) {
    return raw as InferencePoolKind
  }
  return fallback
}

function normalizeFinalizedAt(raw: string | undefined, completedAtMs?: number): string {
  if (typeof raw === 'string' && raw.length >= 10 && raw.length <= 64 && Number.isFinite(Date.parse(raw))) {
    return raw
  }
  if (typeof completedAtMs === 'number' && Number.isFinite(completedAtMs) && completedAtMs >= Date.UTC(2020, 0, 1)) {
    return new Date(completedAtMs).toISOString()
  }
  return new Date().toISOString()
}

function normalizeUsage(
  usage: {
    readonly inputTokens?: number
    readonly outputTokens?: number
    readonly cacheReadTokens?: number
    readonly cacheWriteTokens?: number
    readonly cacheCreationTokens?: number
    readonly reasoningTokens?: number
  },
): NormalizedUsageCounters {
  const cacheWrite = usage.cacheWriteTokens ?? usage.cacheCreationTokens ?? 0
  return Object.freeze({
    inputTokens: safeNonNegativeInt(usage.inputTokens),
    outputTokens: safeNonNegativeInt(usage.outputTokens),
    cacheReadTokens: safeNonNegativeInt(usage.cacheReadTokens),
    cacheWriteTokens: safeNonNegativeInt(cacheWrite),
    ...(usage.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: safeNonNegativeInt(usage.reasoningTokens) }),
  })
}

function resolveLogicalModelSafe(rawModel: string, fallback = 'default-model'): string {
  const sanitized = sanitizeModel(rawModel, fallback)
  try {
    return resolveLogicalModelId(sanitized).logicalModel
  } catch {
    return sanitized
  }
}

function parsePositiveEpoch(raw: number | string | undefined, fallback = 1): number {
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 1) {
    return raw
  }
  if (typeof raw === 'string' && /^[1-9][0-9]{0,15}$/.test(raw.trim())) {
    const parsed = Number.parseInt(raw.trim(), 10)
    if (Number.isSafeInteger(parsed) && parsed >= 1) return parsed
  }
  return fallback
}

export interface BuildTurnReceiptV5FromRemoteV4Input {
  readonly receiptV4: RemoteReceiptV4
  readonly authorityEngine?: ModelAuthorityEngine
  readonly engineFamily?: InferenceEngineFamily
  readonly poolKind?: InferencePoolKind
  readonly tenantId?: string
  readonly turnId?: string
  readonly logicalModel?: string
  readonly canonicalModel?: string
  readonly upstreamModel?: string
  readonly serviceTier?: InferenceServiceTier | null
  readonly placementEpoch?: number
  readonly usageSemantics?: string
  readonly errorCode?: string
  readonly finalizedAt?: string
  readonly completedAtMs?: number
}

/**
 * Pure converter building a self-validated `TurnReceiptV5` from an authoritative `RemoteReceiptV4`.
 * Preserves semantic equivalence with local pool receipts so identical logical turns produce
 * byte-identical `semanticDigest` values across `local_pool` and `remote_pool`.
 */
export function buildTurnReceiptV5FromRemoteV4(
  input: BuildTurnReceiptV5FromRemoteV4Input,
): TurnReceiptV5 {
  const r = input.receiptV4
  const engineFamily =
    input.engineFamily ??
    (input.authorityEngine !== undefined
      ? authorityEngineToInferenceFamily(input.authorityEngine)
      : inferEngineFamilyFromIdentifier(r.engineId))

  const canonicalModel = sanitizeModel(input.canonicalModel ?? r.canonicalModel, 'default-model')
  const logicalModel = sanitizeModel(
    input.logicalModel ?? resolveLogicalModelSafe(canonicalModel),
    canonicalModel,
  )
  const upstreamModel = sanitizeModel(input.upstreamModel ?? r.upstreamModel, canonicalModel)
  const status = r.nativeStatus
  const resolvedErrorCode =
    status === 'success'
      ? undefined
      : input.errorCode !== undefined
        ? sanitizeIdent(input.errorCode, status === 'interrupted' ? 'interrupted' : 'remote_error')
        : undefined

  const body: TurnReceiptV5Body = {
    version: 5,
    poolKind: normalizePoolKind(input.poolKind, 'remote_pool'),
    engineFamily,
    driverId: sanitizeDriverId(r.driverId, engineFamily),
    driverVersion:
      typeof r.driverVersion === 'string' && r.driverVersion.length > 0 && r.driverVersion.length <= 64
        ? r.driverVersion
        : DEFAULT_RECEIPT_V5_DRIVER_VERSION,
    tenantId: sanitizeTenant(input.tenantId ?? r.uid, 'tenant-remote'),
    sessionKey: sanitizeSessionKey(r.sessionKey, 'session-remote'),
    turnId: sanitizeIdent(input.turnId ?? r.authorityTurnId, 'turn-remote'),
    turnKey: SHA256_RE.test(r.turnKey)
      ? r.turnKey
      : remoteCanonicalSha256({ domain: 'oc-turn-key-v5-bridge', turnKey: r.turnKey }),
    requestId: sanitizeIdent(r.requestId, 'req-remote'),
    logicalModel,
    canonicalModel,
    upstreamModel,
    serviceTier: normalizeServiceTier(input.serviceTier),
    placementEpoch: parsePositiveEpoch(input.placementEpoch ?? r.provenance.generation, 1),
    usageSemantics: sanitizeIdent(
      input.usageSemantics ?? r.usageSemantics,
      DEFAULT_TURN_RECEIPT_V5_USAGE_SEMANTICS,
    ),
    usage: normalizeUsage(r.usage),
    status,
    ...(resolvedErrorCode === undefined ? {} : { errorCode: resolvedErrorCode }),
    rawEvidenceDigest: SHA256_RE.test(r.rawEvidenceDigest)
      ? r.rawEvidenceDigest
      : remoteCanonicalSha256({
          domain: 'oc-raw-evidence-v5-from-v4',
          receiptDigest: r.receiptDigest,
          requestId: r.requestId,
        }),
    finalizedAt: normalizeFinalizedAt(input.finalizedAt, input.completedAtMs),
  }

  const digests = computeTurnReceiptV5Digests(body)
  return validateTurnReceiptV5({
    ...body,
    semanticDigest: digests.semanticDigest,
    receiptDigest: digests.receiptDigest,
  })
}

export interface BuildTurnReceiptV5FromLocalOutcomeInput {
  readonly poolKind?: InferencePoolKind
  readonly authorityEngine?: ModelAuthorityEngine
  readonly engineFamily?: InferenceEngineFamily
  readonly driverId?: string
  readonly driverVersion?: string
  readonly tenantId: string
  readonly sessionKey: string
  readonly turnId: string
  readonly turnKey: string
  readonly requestId: string
  readonly logicalModel: string
  readonly canonicalModel?: string
  readonly upstreamModel?: string
  readonly serviceTier?: InferenceServiceTier | null
  readonly placementEpoch?: number
  readonly usageSemantics?: string
  readonly usage: {
    readonly inputTokens?: number
    readonly outputTokens?: number
    readonly cacheReadTokens?: number
    readonly cacheWriteTokens?: number
    readonly cacheCreationTokens?: number
    readonly reasoningTokens?: number
  }
  readonly status: 'success' | 'error' | 'interrupted'
  readonly errorCode?: string
  readonly rawEvidenceDigest?: string
  readonly evidencePayload?: unknown
  readonly finalizedAt?: string
}

/**
 * Pure builder producing a self-validated `TurnReceiptV5` from a local turn outcome.
 */
export function buildTurnReceiptV5FromLocalOutcome(
  input: BuildTurnReceiptV5FromLocalOutcomeInput,
): TurnReceiptV5 {
  const poolKind = normalizePoolKind(input.poolKind, 'local_pool')
  const engineFamily =
    input.engineFamily ??
    (input.authorityEngine !== undefined
      ? authorityEngineToInferenceFamily(input.authorityEngine)
      : 'cc')
  const driverId = sanitizeDriverId(input.driverId, `local-${engineFamily}`)
  const driverVersion =
    typeof input.driverVersion === 'string' &&
    input.driverVersion.length > 0 &&
    input.driverVersion.length <= 64
      ? input.driverVersion
      : DEFAULT_RECEIPT_V5_DRIVER_VERSION

  const logicalModel = resolveLogicalModelSafe(input.logicalModel)
  const canonicalModel = sanitizeModel(input.canonicalModel ?? logicalModel, logicalModel)
  const upstreamModel = sanitizeModel(input.upstreamModel ?? canonicalModel, canonicalModel)
  const turnId = sanitizeIdent(input.turnId, 'turn-local')
  const requestId = sanitizeIdent(input.requestId, 'req-local')
  const turnKey = SHA256_RE.test(input.turnKey)
    ? input.turnKey
    : remoteCanonicalSha256({
        domain: 'oc-turn-key-v5-local',
        sessionKey: input.sessionKey,
        turnId,
        requestId,
        rawTurnKey: input.turnKey,
      })

  const rawEvidenceDigest =
    typeof input.rawEvidenceDigest === 'string' && SHA256_RE.test(input.rawEvidenceDigest)
      ? input.rawEvidenceDigest
      : remoteCanonicalSha256({
          domain: 'oc-raw-evidence-v5-local',
          poolKind,
          driverId,
          turnId,
          requestId,
          evidencePayload: input.evidencePayload ?? null,
        })

  const resolvedErrorCode =
    input.status === 'success'
      ? undefined
      : input.errorCode !== undefined
        ? sanitizeIdent(
            input.errorCode,
            input.status === 'interrupted' ? 'interrupted' : 'engine_error',
          )
        : undefined

  const body: TurnReceiptV5Body = {
    version: 5,
    poolKind,
    engineFamily,
    driverId,
    driverVersion,
    tenantId: sanitizeTenant(input.tenantId, 'local-tenant'),
    sessionKey: sanitizeSessionKey(input.sessionKey, 'session-local'),
    turnId,
    turnKey,
    requestId,
    logicalModel,
    canonicalModel,
    upstreamModel,
    serviceTier: normalizeServiceTier(input.serviceTier),
    placementEpoch: parsePositiveEpoch(input.placementEpoch, 1),
    usageSemantics: sanitizeIdent(input.usageSemantics, DEFAULT_TURN_RECEIPT_V5_USAGE_SEMANTICS),
    usage: normalizeUsage(input.usage),
    status: input.status,
    ...(resolvedErrorCode === undefined ? {} : { errorCode: resolvedErrorCode }),
    rawEvidenceDigest,
    finalizedAt: normalizeFinalizedAt(input.finalizedAt),
  }

  const digests = computeTurnReceiptV5Digests(body)
  return validateTurnReceiptV5({
    ...body,
    semanticDigest: digests.semanticDigest,
    receiptDigest: digests.receiptDigest,
  })
}

export interface DualPoolReceiptParityOptions {
  /** Defaults to true: verifies local and remote receipts originated from distinct pools. */
  readonly requireDistinctPools?: boolean
  readonly expectedLocalPoolKind?: InferencePoolKind
  readonly expectedRemotePoolKind?: InferencePoolKind
}

export interface DualPoolReceiptParityResult {
  readonly ok: boolean
  readonly semanticDigestMatch: boolean
  readonly localPoolKind: InferencePoolKind
  readonly remotePoolKind: InferencePoolKind
  readonly localSemanticDigest: string
  readonly remoteSemanticDigest: string
  readonly localReceiptDigest: string
  readonly remoteReceiptDigest: string
  readonly parityDigest: string
  readonly mismatchReasons: readonly string[]
}

/**
 * Deterministically validates both `TurnReceiptV5` envelopes and verifies Dual-Pool
 * semantic parity (`local.semanticDigest === remote.semanticDigest`).
 * Fail-closed on tampered receipts (`validateTurnReceiptV5` throws).
 */
export function verifyDualPoolReceiptParity(
  localReceiptRaw: TurnReceiptV5,
  remoteReceiptRaw: TurnReceiptV5,
  opts: DualPoolReceiptParityOptions = {},
): DualPoolReceiptParityResult {
  const local = validateTurnReceiptV5(localReceiptRaw)
  const remote = validateTurnReceiptV5(remoteReceiptRaw)

  const mismatchReasons: string[] = []
  const requireDistinct = opts.requireDistinctPools !== false
  if (requireDistinct && local.poolKind === remote.poolKind) {
    mismatchReasons.push(`pool_kind_not_distinct:${local.poolKind}`)
  }
  if (opts.expectedLocalPoolKind !== undefined && local.poolKind !== opts.expectedLocalPoolKind) {
    mismatchReasons.push(`local_pool_kind_mismatch:${local.poolKind}!=${opts.expectedLocalPoolKind}`)
  }
  if (opts.expectedRemotePoolKind !== undefined && remote.poolKind !== opts.expectedRemotePoolKind) {
    mismatchReasons.push(
      `remote_pool_kind_mismatch:${remote.poolKind}!=${opts.expectedRemotePoolKind}`,
    )
  }

  const fieldChecks: ReadonlyArray<readonly [string, unknown, unknown]> = [
    ['tenantId', local.tenantId, remote.tenantId],
    ['sessionKey', local.sessionKey, remote.sessionKey],
    ['turnId', local.turnId, remote.turnId],
    ['turnKey', local.turnKey, remote.turnKey],
    ['requestId', local.requestId, remote.requestId],
    ['logicalModel', local.logicalModel, remote.logicalModel],
    ['canonicalModel', local.canonicalModel, remote.canonicalModel],
    ['upstreamModel', local.upstreamModel, remote.upstreamModel],
    ['serviceTier', local.serviceTier, remote.serviceTier],
    ['usageSemantics', local.usageSemantics, remote.usageSemantics],
    ['usage.inputTokens', local.usage.inputTokens, remote.usage.inputTokens],
    ['usage.outputTokens', local.usage.outputTokens, remote.usage.outputTokens],
    ['usage.cacheReadTokens', local.usage.cacheReadTokens, remote.usage.cacheReadTokens],
    ['usage.cacheWriteTokens', local.usage.cacheWriteTokens, remote.usage.cacheWriteTokens],
    ['usage.reasoningTokens', local.usage.reasoningTokens ?? null, remote.usage.reasoningTokens ?? null],
    ['status', local.status, remote.status],
    ['errorCode', local.errorCode ?? null, remote.errorCode ?? null],
  ]

  for (const [name, leftVal, rightVal] of fieldChecks) {
    if (leftVal !== rightVal) {
      mismatchReasons.push(`semantic_field_mismatch:${name}`)
    }
  }

  const semanticDigestMatch = local.semanticDigest === remote.semanticDigest
  if (!semanticDigestMatch) {
    mismatchReasons.push('semantic_digest_mismatch')
  }

  const ok = semanticDigestMatch && mismatchReasons.length === 0
  const parityDigest = remoteCanonicalSha256({
    domain: 'oc-dual-pool-receipt-parity-v5',
    ok,
    localPoolKind: local.poolKind,
    remotePoolKind: remote.poolKind,
    localSemanticDigest: local.semanticDigest,
    remoteSemanticDigest: remote.semanticDigest,
    localReceiptDigest: local.receiptDigest,
    remoteReceiptDigest: remote.receiptDigest,
  })

  return Object.freeze({
    ok,
    semanticDigestMatch,
    localPoolKind: local.poolKind,
    remotePoolKind: remote.poolKind,
    localSemanticDigest: local.semanticDigest,
    remoteSemanticDigest: remote.semanticDigest,
    localReceiptDigest: local.receiptDigest,
    remoteReceiptDigest: remote.receiptDigest,
    parityDigest,
    mismatchReasons: Object.freeze(mismatchReasons),
  })
}
