/**
 * OCV5-890 Layer 2 — Inference Pool v5 pure validators & capability helpers.
 *
 * L0 Contract Invariant (R2-contract-node): ZERO `node:*` imports allowed.
 * All canonical hashing delegates to `../remotePool/canonical.js`.
 */
import { PLATFORM_REASONING_EFFORTS, type PlatformReasoningEffort } from '../engineModels.js'
import type { ModelAuthorityEngine } from '../modelAuthority.js'
import {
  assertWellFormedJsonValue,
  remoteCanonicalSha256,
} from '../remotePool/canonical.js'
import {
  INFERENCE_ENGINE_FAMILIES,
  INFERENCE_POOL_KINDS,
  INFERENCE_SERVICE_TIERS,
  TURN_POOL_PREFERENCES,
  type CacheAffinityKeyParts,
  type CapabilitySupersetCheckResult,
  type DriverCapabilityManifest,
  type InferenceEngineFamily,
  type InferencePoolKind,
  type InferenceServiceTier,
  type LogicalModelCapability,
  type NormalizedUsageCounters,
  type PoolFallbackPolicy,
  type RequiredTurnCapabilities,
  type ResolvedLogicalModelId,
  type ToolBridgeEndpoint,
  type TurnPlacementHint,
  type TurnPoolPreference,
  type TurnReceiptV5,
  type TurnReceiptV5Body,
  type UnifiedTurnInputBlock,
  type UnifiedTurnRequest,
} from './contracts.js'

const SHA256_RE = /^[a-f0-9]{64}$/
const MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/
const DRIVER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const IDENT_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const TENANT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const STICKY_KEY_RE = /^s-[a-f0-9]{16}$/

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

const POOL_KIND_SET: ReadonlySet<string> = new Set<string>(INFERENCE_POOL_KINDS)
const ENGINE_FAMILY_SET: ReadonlySet<string> = new Set<string>(INFERENCE_ENGINE_FAMILIES)
const SERVICE_TIER_SET: ReadonlySet<string> = new Set<string>(INFERENCE_SERVICE_TIERS)
const EFFORT_SET: ReadonlySet<string> = new Set<string>(PLATFORM_REASONING_EFFORTS)
const POOL_PREF_SET: ReadonlySet<string> = new Set<string>(TURN_POOL_PREFERENCES)
const AUTHORITY_ENGINE_SET: ReadonlySet<ModelAuthorityEngine> = new Set<ModelAuthorityEngine>([
  'ccb',
  'codex',
  'antigravity',
  'grok',
  'cursor',
  'zcode',
])
const TOOL_BRIDGE_KIND_SET: ReadonlySet<string> = new Set<string>([
  'unix_socket',
  'loopback_http',
  'in_process',
  'stdio_mcp',
])
const ATTESTATION_MODE_SET: ReadonlySet<string> = new Set<string>([
  'gateway_signed_grant',
  'dual_channel_observed',
  'schema_filtered_hook',
])

const CAPABILITY_KEYS: ReadonlySet<string> = new Set<string>([
  'logicalModel', 'upstreamModelId', 'supportsVision', 'supportedEfforts',
  'defaultEffort', 'supportedServiceTiers', 'supportsReadOnly', 'supportsConsultTurn',
  'supportsHermeticNoTools', 'supportsSwarm', 'supportsAdaptiveThinking', 'contextWindow',
])

const MANIFEST_KEYS: ReadonlySet<string> = new Set<string>([
  'schemaVersion', 'poolKind', 'engineFamily', 'authorityEngine',
  'driverId', 'driverVersion', 'observedAt', 'models',
])

const PLACEMENT_HINT_KEYS: ReadonlySet<string> = new Set<string>([
  'poolPreference', 'stickyHomeKey', 'cacheAffinityKey',
  'preferredDriverId', 'preferredProfileId', 'placementEpoch',
])

const TOOL_BRIDGE_KEYS: ReadonlySet<string> = new Set<string>([
  'kind', 'uri', 'authTokenRef', 'attestationMode',
])

const TURN_REQUEST_KEYS: ReadonlySet<string> = new Set<string>([
  'schemaVersion', 'turnId', 'turnKey', 'requestId', 'tenantId', 'sessionKey',
  'logicalModel', 'reasoningEffort', 'serviceTier', 'input', 'systemInstructions',
  'placementHint', 'toolBridge', 'readOnly', 'consultTurn', 'hermeticNoTools',
  'needsSwarm', 'nativeSessionId', 'authorityTurnId',
])

const USAGE_COUNTER_KEYS: ReadonlySet<string> = new Set<string>([
  'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens',
])

const RECEIPT_V5_KEYS: ReadonlySet<string> = new Set<string>([
  'version', 'poolKind', 'engineFamily', 'driverId', 'driverVersion', 'tenantId',
  'sessionKey', 'turnId', 'turnKey', 'requestId', 'logicalModel', 'canonicalModel',
  'upstreamModel', 'serviceTier', 'placementEpoch', 'usageSemantics', 'usage',
  'status', 'errorCode', 'rawEvidenceDigest', 'semanticDigest', 'receiptDigest',
  'finalizedAt',
])

const RECEIPT_V5_SEMANTIC_DOMAIN = 'oc-turn-receipt-v5-semantic'
const RECEIPT_V5_ENVELOPE_DOMAIN = 'oc-turn-receipt-v5-envelope'

export const DEFAULT_POOL_FALLBACK_POLICY: PoolFallbackPolicy = Object.freeze({
  neverSilentDowngradeModel: true,
  requireCapabilitySuperset: true,
  allowCrossPoolOnPostDispatchFailure: false,
  allowPreDispatchPoolFallback: true,
  maxPreDispatchFallbackAttempts: 2,
  allowedFallbackPools: Object.freeze(['local_pool', 'remote_pool', 'box_pool'] as const),
})

function need(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code)
}

function asPlainObject(raw: unknown, code: string): Record<string, unknown> {
  need(raw !== null && typeof raw === 'object' && !Array.isArray(raw), code)
  const proto = Object.getPrototypeOf(raw)
  need(proto === Object.prototype || proto === null, code)
  assertWellFormedJsonValue(raw, true)
  return raw as Record<string, unknown>
}

function assertAllowedKeys(
  obj: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  code: string,
): void {
  for (const key of Object.keys(obj)) {
    need(allowed.has(key), code)
  }
}

function isValidIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 10 || value.length > 64) return false
  return Number.isFinite(Date.parse(value))
}

/**
 * Resolves a raw model identifier into its logical model id and pool preference.
 * Legacy `<base>-remote` identifiers degrade to a compatibility alias pinning the remote pool.
 */
export function resolveLogicalModelId(rawModelId: string): ResolvedLogicalModelId {
  need(typeof rawModelId === 'string', 'INFERENCE_MODEL_ID_INVALID')
  const trimmed = rawModelId.trim()
  need(trimmed.length > 0 && MODEL_ID_RE.test(trimmed), 'INFERENCE_MODEL_ID_INVALID')

  const suffix = '-remote'
  if (trimmed.endsWith(suffix) && trimmed.length > suffix.length) {
    const base = trimmed.slice(0, -suffix.length)
    need(MODEL_ID_RE.test(base), 'INFERENCE_MODEL_ID_INVALID')
    return Object.freeze({
      logicalModel: base,
      poolPreference: 'pin_remote',
      isLegacyRemoteAlias: true,
    })
  }

  return Object.freeze({
    logicalModel: trimmed,
    poolPreference: 'auto',
    isLegacyRemoteAlias: false,
  })
}

/**
 * Computes effective model capabilities as the strict intersection of probed CLI,
 * transport/bridge, and catalog declarations. Never silently relaxes or widens capabilities.
 */
export function computeEffectiveModelCapabilities(
  probed: LogicalModelCapability,
  transport: LogicalModelCapability,
  catalog: LogicalModelCapability,
): LogicalModelCapability {
  need(
    probed.logicalModel === transport.logicalModel &&
      probed.logicalModel === catalog.logicalModel,
    'INFERENCE_CAPABILITY_MODEL_MISMATCH',
  )

  const transportEfforts = new Set(transport.supportedEfforts)
  const catalogEfforts = new Set(catalog.supportedEfforts)
  const probedEfforts = new Set(probed.supportedEfforts)
  const supportedEfforts = PLATFORM_REASONING_EFFORTS.filter(
    (e) => probedEfforts.has(e) && transportEfforts.has(e) && catalogEfforts.has(e),
  )

  const effortIntersectionSet = new Set<PlatformReasoningEffort>(supportedEfforts)
  let defaultEffort: PlatformReasoningEffort | null = null
  for (const candidate of [catalog.defaultEffort, probed.defaultEffort, transport.defaultEffort]) {
    if (candidate !== null && effortIntersectionSet.has(candidate)) {
      defaultEffort = candidate
      break
    }
  }

  const probedTiers = new Set(probed.supportedServiceTiers)
  const transportTiers = new Set(transport.supportedServiceTiers)
  const catalogTiers = new Set(catalog.supportedServiceTiers)
  const supportedServiceTiers = INFERENCE_SERVICE_TIERS.filter(
    (t) => probedTiers.has(t) && transportTiers.has(t) && catalogTiers.has(t),
  )

  const windows = [probed.contextWindow, transport.contextWindow, catalog.contextWindow].filter(
    (w): w is number => typeof w === 'number' && Number.isSafeInteger(w) && w > 0,
  )
  const contextWindow = windows.length > 0 ? Math.min(...windows) : null

  const adaptiveValues = [
    probed.supportsAdaptiveThinking,
    transport.supportsAdaptiveThinking,
    catalog.supportsAdaptiveThinking,
  ].filter((v): v is boolean => typeof v === 'boolean')
  const supportsAdaptiveThinking =
    adaptiveValues.length === 3 ? adaptiveValues.every(Boolean) : undefined

  const upstreamModelId =
    probed.upstreamModelId ?? transport.upstreamModelId ?? catalog.upstreamModelId

  return Object.freeze({
    logicalModel: probed.logicalModel,
    ...(upstreamModelId === undefined ? {} : { upstreamModelId }),
    supportsVision: probed.supportsVision && transport.supportsVision && catalog.supportsVision,
    supportedEfforts: Object.freeze(supportedEfforts),
    defaultEffort,
    supportedServiceTiers: Object.freeze(supportedServiceTiers),
    supportsReadOnly:
      probed.supportsReadOnly && transport.supportsReadOnly && catalog.supportsReadOnly,
    supportsConsultTurn:
      probed.supportsConsultTurn && transport.supportsConsultTurn && catalog.supportsConsultTurn,
    supportsHermeticNoTools:
      probed.supportsHermeticNoTools &&
      transport.supportsHermeticNoTools &&
      catalog.supportsHermeticNoTools,
    supportsSwarm: probed.supportsSwarm && transport.supportsSwarm && catalog.supportsSwarm,
    ...(supportsAdaptiveThinking === undefined ? {} : { supportsAdaptiveThinking }),
    contextWindow,
  })
}

/**
 * Verifies that a driver capability manifest is a strict superset of all required turn capabilities.
 */
export function checkCapabilitySuperset(
  manifest: DriverCapabilityManifest,
  logicalModel: string,
  required: RequiredTurnCapabilities = {},
): CapabilitySupersetCheckResult {
  const matched = manifest.models.find((m) => m.logicalModel === logicalModel)
  if (!matched) {
    return Object.freeze({
      satisfied: false,
      logicalModel,
      unsatisfiedReasons: Object.freeze([`logical_model_unsupported:${logicalModel}`]),
    })
  }

  const reasons: string[] = []
  if (required.needsVision === true && !matched.supportsVision) {
    reasons.push('vision_unsupported')
  }
  if (
    required.reasoningEffort !== undefined &&
    !matched.supportedEfforts.includes(required.reasoningEffort)
  ) {
    reasons.push(`reasoning_effort_unsupported:${required.reasoningEffort}`)
  }
  if (
    required.serviceTier !== undefined &&
    !matched.supportedServiceTiers.includes(required.serviceTier)
  ) {
    reasons.push(`service_tier_unsupported:${required.serviceTier}`)
  }
  if (required.readOnly === true && !matched.supportsReadOnly) {
    reasons.push('read_only_unsupported')
  }
  if (required.consultTurn === true && !matched.supportsConsultTurn) {
    reasons.push('consult_turn_unsupported')
  }
  if (required.hermeticNoTools === true && !matched.supportsHermeticNoTools) {
    reasons.push('hermetic_no_tools_unsupported')
  }
  if (required.needsSwarm === true && !matched.supportsSwarm) {
    reasons.push('swarm_unsupported')
  }

  return Object.freeze({
    satisfied: reasons.length === 0,
    logicalModel,
    matchedModel: matched,
    unsatisfiedReasons: Object.freeze(reasons),
  })
}

/**
 * Computes a stable sticky home key (`s-<16hex>`) from `sessionKey` alone,
 * deliberately excluding ephemeral operationId/generation noise (OCV5-782).
 */
export function computeStickyHomeKey(sessionKey: string): string {
  need(
    typeof sessionKey === 'string' &&
      sessionKey.length > 0 &&
      sessionKey.length <= 512 &&
      !hasControlChar(sessionKey),
    'INFERENCE_STICKY_HOME_SESSION_KEY_INVALID',
  )
  const digest = remoteCanonicalSha256({
    domain: 'oc-sticky-home-v5',
    sessionKey,
  })
  return `s-${digest.slice(0, 16)}`
}

/**
 * Computes a stable prompt-cache affinity key (`s-<16hex>`) free of op/gen churn.
 */
export function computeCacheAffinityKey(parts: CacheAffinityKeyParts): string {
  need(
    parts !== null &&
      typeof parts === 'object' &&
      typeof parts.tenantId === 'string' &&
      TENANT_ID_RE.test(parts.tenantId) &&
      typeof parts.sessionKey === 'string' &&
      parts.sessionKey.length > 0 &&
      parts.sessionKey.length <= 512 &&
      !hasControlChar(parts.sessionKey) &&
      typeof parts.logicalModel === 'string' &&
      MODEL_ID_RE.test(parts.logicalModel),
    'INFERENCE_CACHE_AFFINITY_PARTS_INVALID',
  )
  if (parts.engineFamily !== undefined) {
    need(ENGINE_FAMILY_SET.has(parts.engineFamily), 'INFERENCE_CACHE_AFFINITY_PARTS_INVALID')
  }
  if (parts.systemPromptSha256 !== undefined) {
    need(
      typeof parts.systemPromptSha256 === 'string' && SHA256_RE.test(parts.systemPromptSha256),
      'INFERENCE_CACHE_AFFINITY_PARTS_INVALID',
    )
  }

  const digest = remoteCanonicalSha256({
    domain: 'oc-cache-affinity-v5',
    tenantId: parts.tenantId,
    sessionKey: parts.sessionKey,
    logicalModel: parts.logicalModel,
    engineFamily: parts.engineFamily ?? null,
    systemPromptSha256: parts.systemPromptSha256 ?? null,
  })
  return `s-${digest.slice(0, 16)}`
}

export function computeTurnReceiptV5Digests(
  input: TurnReceiptV5Body,
): { readonly semanticDigest: string; readonly receiptDigest: string } {
  assertWellFormedJsonValue(input, false)
  const semanticDigest = remoteCanonicalSha256({
    domain: RECEIPT_V5_SEMANTIC_DOMAIN,
    version: input.version,
    tenantId: input.tenantId,
    sessionKey: input.sessionKey,
    turnId: input.turnId,
    turnKey: input.turnKey,
    requestId: input.requestId,
    logicalModel: input.logicalModel,
    canonicalModel: input.canonicalModel,
    upstreamModel: input.upstreamModel,
    serviceTier: input.serviceTier,
    usageSemantics: input.usageSemantics,
    usage: input.usage,
    status: input.status,
    errorCode: input.errorCode ?? null,
  })

  const receiptDigest = remoteCanonicalSha256({
    domain: RECEIPT_V5_ENVELOPE_DOMAIN,
    version: input.version,
    poolKind: input.poolKind,
    engineFamily: input.engineFamily,
    driverId: input.driverId,
    driverVersion: input.driverVersion,
    tenantId: input.tenantId,
    sessionKey: input.sessionKey,
    turnId: input.turnId,
    turnKey: input.turnKey,
    requestId: input.requestId,
    logicalModel: input.logicalModel,
    canonicalModel: input.canonicalModel,
    upstreamModel: input.upstreamModel,
    serviceTier: input.serviceTier,
    placementEpoch: input.placementEpoch,
    usageSemantics: input.usageSemantics,
    usage: input.usage,
    status: input.status,
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
    rawEvidenceDigest: input.rawEvidenceDigest,
    semanticDigest,
    finalizedAt: input.finalizedAt,
  })

  return Object.freeze({ semanticDigest, receiptDigest })
}

function validateNormalizedUsageCounters(raw: unknown): NormalizedUsageCounters {
  const u = asPlainObject(raw, 'TURN_RECEIPT_V5_USAGE_INVALID')
  assertAllowedKeys(u, USAGE_COUNTER_KEYS, 'TURN_RECEIPT_V5_USAGE_INVALID')
  for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) {
    const val = u[field]
    need(
      typeof val === 'number' && Number.isSafeInteger(val) && val >= 0,
      'TURN_RECEIPT_V5_USAGE_INVALID',
    )
  }
  if (u.reasoningTokens !== undefined) {
    need(
      typeof u.reasoningTokens === 'number' &&
        Number.isSafeInteger(u.reasoningTokens) &&
        u.reasoningTokens >= 0,
      'TURN_RECEIPT_V5_USAGE_INVALID',
    )
  }
  return Object.freeze({
    inputTokens: u.inputTokens as number,
    outputTokens: u.outputTokens as number,
    cacheReadTokens: u.cacheReadTokens as number,
    cacheWriteTokens: u.cacheWriteTokens as number,
    ...(u.reasoningTokens === undefined ? {} : { reasoningTokens: u.reasoningTokens as number }),
  })
}

export function validateTurnReceiptV5(raw: unknown): TurnReceiptV5 {
  const r = asPlainObject(raw, 'TURN_RECEIPT_V5_INVALID')
  assertAllowedKeys(r, RECEIPT_V5_KEYS, 'TURN_RECEIPT_V5_INVALID')

  need(
    r.version === 5 &&
      typeof r.poolKind === 'string' &&
      POOL_KIND_SET.has(r.poolKind) &&
      typeof r.engineFamily === 'string' &&
      ENGINE_FAMILY_SET.has(r.engineFamily) &&
      typeof r.driverId === 'string' &&
      DRIVER_ID_RE.test(r.driverId) &&
      typeof r.driverVersion === 'string' &&
      r.driverVersion.length > 0 &&
      r.driverVersion.length <= 64 &&
      typeof r.tenantId === 'string' &&
      TENANT_ID_RE.test(r.tenantId) &&
      typeof r.sessionKey === 'string' &&
      r.sessionKey.length > 0 &&
      r.sessionKey.length <= 512 &&
      !hasControlChar(r.sessionKey) &&
      typeof r.turnId === 'string' &&
      IDENT_RE.test(r.turnId) &&
      typeof r.turnKey === 'string' &&
      SHA256_RE.test(r.turnKey) &&
      typeof r.requestId === 'string' &&
      IDENT_RE.test(r.requestId) &&
      typeof r.logicalModel === 'string' &&
      MODEL_ID_RE.test(r.logicalModel) &&
      typeof r.canonicalModel === 'string' &&
      MODEL_ID_RE.test(r.canonicalModel) &&
      typeof r.upstreamModel === 'string' &&
      MODEL_ID_RE.test(r.upstreamModel) &&
      typeof r.serviceTier === 'string' &&
      SERVICE_TIER_SET.has(r.serviceTier) &&
      typeof r.placementEpoch === 'number' &&
      Number.isSafeInteger(r.placementEpoch) &&
      r.placementEpoch >= 1 &&
      typeof r.usageSemantics === 'string' &&
      IDENT_RE.test(r.usageSemantics) &&
      (r.status === 'success' || r.status === 'error' || r.status === 'interrupted') &&
      (r.errorCode === undefined || (typeof r.errorCode === 'string' && IDENT_RE.test(r.errorCode))) &&
      typeof r.rawEvidenceDigest === 'string' &&
      SHA256_RE.test(r.rawEvidenceDigest) &&
      typeof r.semanticDigest === 'string' &&
      SHA256_RE.test(r.semanticDigest) &&
      typeof r.receiptDigest === 'string' &&
      SHA256_RE.test(r.receiptDigest) &&
      isValidIsoTimestamp(r.finalizedAt),
    'TURN_RECEIPT_V5_INVALID',
  )

  const usage = validateNormalizedUsageCounters(r.usage)
  const body: TurnReceiptV5Body = {
    version: 5,
    poolKind: r.poolKind as InferencePoolKind,
    engineFamily: r.engineFamily as InferenceEngineFamily,
    driverId: r.driverId,
    driverVersion: r.driverVersion,
    tenantId: r.tenantId,
    sessionKey: r.sessionKey,
    turnId: r.turnId,
    turnKey: r.turnKey,
    requestId: r.requestId,
    logicalModel: r.logicalModel,
    canonicalModel: r.canonicalModel,
    upstreamModel: r.upstreamModel,
    serviceTier: r.serviceTier as InferenceServiceTier,
    placementEpoch: r.placementEpoch,
    usageSemantics: r.usageSemantics,
    usage,
    status: r.status,
    ...(r.errorCode === undefined ? {} : { errorCode: r.errorCode as string }),
    rawEvidenceDigest: r.rawEvidenceDigest,
    finalizedAt: r.finalizedAt,
  }

  const digests = computeTurnReceiptV5Digests(body)
  need(
    digests.semanticDigest === r.semanticDigest && digests.receiptDigest === r.receiptDigest,
    'TURN_RECEIPT_V5_DIGEST_MISMATCH',
  )

  return Object.freeze({
    ...body,
    semanticDigest: digests.semanticDigest,
    receiptDigest: digests.receiptDigest,
  })
}

function validateLogicalModelCapability(raw: unknown): LogicalModelCapability {
  const c = asPlainObject(raw, 'INFERENCE_CAPABILITY_INVALID')
  assertAllowedKeys(c, CAPABILITY_KEYS, 'INFERENCE_CAPABILITY_INVALID')

  need(
    typeof c.logicalModel === 'string' &&
      MODEL_ID_RE.test(c.logicalModel) &&
      (c.upstreamModelId === undefined ||
        (typeof c.upstreamModelId === 'string' && MODEL_ID_RE.test(c.upstreamModelId))) &&
      typeof c.supportsVision === 'boolean' &&
      Array.isArray(c.supportedEfforts) &&
      Array.isArray(c.supportedServiceTiers) &&
      typeof c.supportsReadOnly === 'boolean' &&
      typeof c.supportsConsultTurn === 'boolean' &&
      typeof c.supportsHermeticNoTools === 'boolean' &&
      typeof c.supportsSwarm === 'boolean',
    'INFERENCE_CAPABILITY_INVALID',
  )

  const efforts: PlatformReasoningEffort[] = []
  const seenEfforts = new Set<string>()
  for (const e of c.supportedEfforts) {
    need(typeof e === 'string' && EFFORT_SET.has(e) && !seenEfforts.has(e), 'INFERENCE_CAPABILITY_INVALID')
    seenEfforts.add(e)
    efforts.push(e as PlatformReasoningEffort)
  }

  need(
    c.defaultEffort === null ||
      (typeof c.defaultEffort === 'string' && seenEfforts.has(c.defaultEffort)),
    'INFERENCE_CAPABILITY_INVALID',
  )

  const tiers: InferenceServiceTier[] = []
  const seenTiers = new Set<string>()
  for (const t of c.supportedServiceTiers) {
    need(typeof t === 'string' && SERVICE_TIER_SET.has(t) && !seenTiers.has(t), 'INFERENCE_CAPABILITY_INVALID')
    seenTiers.add(t)
    tiers.push(t as InferenceServiceTier)
  }

  if (c.supportsAdaptiveThinking !== undefined) {
    need(typeof c.supportsAdaptiveThinking === 'boolean', 'INFERENCE_CAPABILITY_INVALID')
  }
  if (c.contextWindow !== undefined && c.contextWindow !== null) {
    need(
      typeof c.contextWindow === 'number' &&
        Number.isSafeInteger(c.contextWindow) &&
        c.contextWindow > 0,
      'INFERENCE_CAPABILITY_INVALID',
    )
  }

  return Object.freeze({
    logicalModel: c.logicalModel,
    ...(c.upstreamModelId === undefined ? {} : { upstreamModelId: c.upstreamModelId as string }),
    supportsVision: c.supportsVision,
    supportedEfforts: Object.freeze(efforts),
    defaultEffort: c.defaultEffort as PlatformReasoningEffort | null,
    supportedServiceTiers: Object.freeze(tiers),
    supportsReadOnly: c.supportsReadOnly,
    supportsConsultTurn: c.supportsConsultTurn,
    supportsHermeticNoTools: c.supportsHermeticNoTools,
    supportsSwarm: c.supportsSwarm,
    ...(c.supportsAdaptiveThinking === undefined
      ? {}
      : { supportsAdaptiveThinking: c.supportsAdaptiveThinking as boolean }),
    ...(c.contextWindow === undefined
      ? {}
      : { contextWindow: c.contextWindow as number | null }),
  })
}

export function validateDriverCapabilityManifest(raw: unknown): DriverCapabilityManifest {
  const m = asPlainObject(raw, 'INFERENCE_MANIFEST_INVALID')
  assertAllowedKeys(m, MANIFEST_KEYS, 'INFERENCE_MANIFEST_INVALID')

  need(
    m.schemaVersion === 5 &&
      typeof m.poolKind === 'string' &&
      POOL_KIND_SET.has(m.poolKind) &&
      typeof m.engineFamily === 'string' &&
      ENGINE_FAMILY_SET.has(m.engineFamily) &&
      typeof m.authorityEngine === 'string' &&
      AUTHORITY_ENGINE_SET.has(m.authorityEngine as ModelAuthorityEngine) &&
      typeof m.driverId === 'string' &&
      DRIVER_ID_RE.test(m.driverId) &&
      typeof m.driverVersion === 'string' &&
      m.driverVersion.length > 0 &&
      m.driverVersion.length <= 64 &&
      isValidIsoTimestamp(m.observedAt) &&
      Array.isArray(m.models) &&
      m.models.length > 0,
    'INFERENCE_MANIFEST_INVALID',
  )

  const seenModels = new Set<string>()
  const models: LogicalModelCapability[] = []
  for (const rawModel of m.models) {
    const model = validateLogicalModelCapability(rawModel)
    need(!seenModels.has(model.logicalModel), 'INFERENCE_MANIFEST_DUPLICATE_MODEL')
    seenModels.add(model.logicalModel)
    models.push(model)
  }

  return Object.freeze({
    schemaVersion: 5,
    poolKind: m.poolKind as InferencePoolKind,
    engineFamily: m.engineFamily as InferenceEngineFamily,
    authorityEngine: m.authorityEngine as ModelAuthorityEngine,
    driverId: m.driverId,
    driverVersion: m.driverVersion,
    observedAt: m.observedAt,
    models: Object.freeze(models),
  })
}

function validateTurnInputBlock(raw: unknown): UnifiedTurnInputBlock {
  const b = asPlainObject(raw, 'INFERENCE_TURN_INPUT_INVALID')
  switch (b.type) {
    case 'text': {
      assertAllowedKeys(b, new Set(['type', 'text']), 'INFERENCE_TURN_INPUT_INVALID')
      need(typeof b.text === 'string', 'INFERENCE_TURN_INPUT_INVALID')
      return Object.freeze({ type: 'text', text: b.text })
    }
    case 'blob_ref': {
      assertAllowedKeys(
        b,
        new Set(['type', 'blobId', 'sha256', 'mimeType', 'logicalName']),
        'INFERENCE_TURN_INPUT_INVALID',
      )
      need(
        typeof b.blobId === 'string' &&
          IDENT_RE.test(b.blobId) &&
          typeof b.sha256 === 'string' &&
          SHA256_RE.test(b.sha256) &&
          typeof b.mimeType === 'string' &&
          b.mimeType.length > 0 &&
          b.mimeType.length <= 128,
        'INFERENCE_TURN_INPUT_INVALID',
      )
      if (b.logicalName !== undefined) {
        need(
          typeof b.logicalName === 'string' && b.logicalName.length > 0 && b.logicalName.length <= 256,
          'INFERENCE_TURN_INPUT_INVALID',
        )
      }
      return Object.freeze({
        type: 'blob_ref',
        blobId: b.blobId,
        sha256: b.sha256,
        mimeType: b.mimeType,
        ...(b.logicalName === undefined ? {} : { logicalName: b.logicalName as string }),
      })
    }
    case 'image_ref': {
      assertAllowedKeys(
        b,
        new Set(['type', 'blobId', 'uri', 'sha256', 'mimeType', 'altText']),
        'INFERENCE_TURN_INPUT_INVALID',
      )
      need(
        typeof b.mimeType === 'string' && b.mimeType.startsWith('image/') && b.mimeType.length <= 128,
        'INFERENCE_TURN_INPUT_INVALID',
      )
      need(b.blobId !== undefined || b.uri !== undefined, 'INFERENCE_TURN_INPUT_INVALID')
      if (b.blobId !== undefined) {
        need(typeof b.blobId === 'string' && IDENT_RE.test(b.blobId), 'INFERENCE_TURN_INPUT_INVALID')
      }
      if (b.uri !== undefined) {
        need(
          typeof b.uri === 'string' && b.uri.length > 0 && b.uri.length <= 2048,
          'INFERENCE_TURN_INPUT_INVALID',
        )
      }
      if (b.sha256 !== undefined) {
        need(typeof b.sha256 === 'string' && SHA256_RE.test(b.sha256), 'INFERENCE_TURN_INPUT_INVALID')
      }
      if (b.altText !== undefined) {
        need(typeof b.altText === 'string' && b.altText.length <= 1024, 'INFERENCE_TURN_INPUT_INVALID')
      }
      return Object.freeze({
        type: 'image_ref',
        ...(b.blobId === undefined ? {} : { blobId: b.blobId as string }),
        ...(b.uri === undefined ? {} : { uri: b.uri as string }),
        ...(b.sha256 === undefined ? {} : { sha256: b.sha256 as string }),
        mimeType: b.mimeType,
        ...(b.altText === undefined ? {} : { altText: b.altText as string }),
      })
    }
    default:
      throw new Error('INFERENCE_TURN_INPUT_INVALID')
  }
}

function validatePlacementHint(raw: unknown): TurnPlacementHint {
  const h = asPlainObject(raw, 'INFERENCE_PLACEMENT_HINT_INVALID')
  assertAllowedKeys(h, PLACEMENT_HINT_KEYS, 'INFERENCE_PLACEMENT_HINT_INVALID')
  need(
    typeof h.poolPreference === 'string' && POOL_PREF_SET.has(h.poolPreference),
    'INFERENCE_PLACEMENT_HINT_INVALID',
  )
  if (h.stickyHomeKey !== undefined) {
    need(
      typeof h.stickyHomeKey === 'string' && STICKY_KEY_RE.test(h.stickyHomeKey),
      'INFERENCE_PLACEMENT_HINT_INVALID',
    )
  }
  if (h.cacheAffinityKey !== undefined) {
    need(
      typeof h.cacheAffinityKey === 'string' && STICKY_KEY_RE.test(h.cacheAffinityKey),
      'INFERENCE_PLACEMENT_HINT_INVALID',
    )
  }
  if (h.preferredDriverId !== undefined) {
    need(
      typeof h.preferredDriverId === 'string' && DRIVER_ID_RE.test(h.preferredDriverId),
      'INFERENCE_PLACEMENT_HINT_INVALID',
    )
  }
  if (h.preferredProfileId !== undefined) {
    need(
      typeof h.preferredProfileId === 'string' && IDENT_RE.test(h.preferredProfileId),
      'INFERENCE_PLACEMENT_HINT_INVALID',
    )
  }
  if (h.placementEpoch !== undefined) {
    need(
      typeof h.placementEpoch === 'number' &&
        Number.isSafeInteger(h.placementEpoch) &&
        h.placementEpoch >= 1,
      'INFERENCE_PLACEMENT_HINT_INVALID',
    )
  }
  return Object.freeze({
    poolPreference: h.poolPreference as TurnPoolPreference,
    ...(h.stickyHomeKey === undefined ? {} : { stickyHomeKey: h.stickyHomeKey as string }),
    ...(h.cacheAffinityKey === undefined ? {} : { cacheAffinityKey: h.cacheAffinityKey as string }),
    ...(h.preferredDriverId === undefined
      ? {}
      : { preferredDriverId: h.preferredDriverId as string }),
    ...(h.preferredProfileId === undefined
      ? {}
      : { preferredProfileId: h.preferredProfileId as string }),
    ...(h.placementEpoch === undefined ? {} : { placementEpoch: h.placementEpoch as number }),
  })
}

function validateToolBridgeEndpoint(raw: unknown): ToolBridgeEndpoint {
  const e = asPlainObject(raw, 'INFERENCE_TOOL_BRIDGE_INVALID')
  assertAllowedKeys(e, TOOL_BRIDGE_KEYS, 'INFERENCE_TOOL_BRIDGE_INVALID')
  need(
    typeof e.kind === 'string' &&
      TOOL_BRIDGE_KIND_SET.has(e.kind) &&
      typeof e.uri === 'string' &&
      e.uri.length > 0 &&
      e.uri.length <= 1024 &&
      !hasControlChar(e.uri),
    'INFERENCE_TOOL_BRIDGE_INVALID',
  )
  if (e.authTokenRef !== undefined) {
    need(typeof e.authTokenRef === 'string' && IDENT_RE.test(e.authTokenRef), 'INFERENCE_TOOL_BRIDGE_INVALID')
  }
  if (e.attestationMode !== undefined) {
    need(
      typeof e.attestationMode === 'string' && ATTESTATION_MODE_SET.has(e.attestationMode),
      'INFERENCE_TOOL_BRIDGE_INVALID',
    )
  }
  return Object.freeze({
    kind: e.kind as ToolBridgeEndpoint['kind'],
    uri: e.uri,
    ...(e.authTokenRef === undefined ? {} : { authTokenRef: e.authTokenRef as string }),
    ...(e.attestationMode === undefined
      ? {}
      : { attestationMode: e.attestationMode as ToolBridgeEndpoint['attestationMode'] }),
  })
}

export function validateUnifiedTurnRequest(raw: unknown): UnifiedTurnRequest {
  const q = asPlainObject(raw, 'INFERENCE_TURN_REQUEST_INVALID')
  assertAllowedKeys(q, TURN_REQUEST_KEYS, 'INFERENCE_TURN_REQUEST_INVALID')

  need(
    q.schemaVersion === 5 &&
      typeof q.turnId === 'string' &&
      IDENT_RE.test(q.turnId) &&
      typeof q.turnKey === 'string' &&
      SHA256_RE.test(q.turnKey) &&
      typeof q.requestId === 'string' &&
      IDENT_RE.test(q.requestId) &&
      typeof q.tenantId === 'string' &&
      TENANT_ID_RE.test(q.tenantId) &&
      typeof q.sessionKey === 'string' &&
      q.sessionKey.length > 0 &&
      q.sessionKey.length <= 512 &&
      !hasControlChar(q.sessionKey) &&
      typeof q.logicalModel === 'string' &&
      MODEL_ID_RE.test(q.logicalModel) &&
      Array.isArray(q.input) &&
      q.input.length > 0,
    'INFERENCE_TURN_REQUEST_INVALID',
  )

  if (q.reasoningEffort !== undefined) {
    need(
      typeof q.reasoningEffort === 'string' && EFFORT_SET.has(q.reasoningEffort),
      'INFERENCE_TURN_REQUEST_INVALID',
    )
  }
  if (q.serviceTier !== undefined) {
    need(
      typeof q.serviceTier === 'string' && SERVICE_TIER_SET.has(q.serviceTier),
      'INFERENCE_TURN_REQUEST_INVALID',
    )
  }
  if (q.systemInstructions !== undefined) {
    need(typeof q.systemInstructions === 'string', 'INFERENCE_TURN_REQUEST_INVALID')
  }
  for (const flag of ['readOnly', 'consultTurn', 'hermeticNoTools', 'needsSwarm'] as const) {
    if (q[flag] !== undefined) {
      need(typeof q[flag] === 'boolean', 'INFERENCE_TURN_REQUEST_INVALID')
    }
  }
  if (q.nativeSessionId !== undefined && q.nativeSessionId !== null) {
    need(
      typeof q.nativeSessionId === 'string' &&
        q.nativeSessionId.length > 0 &&
        q.nativeSessionId.length <= 256 &&
        !hasControlChar(q.nativeSessionId),
      'INFERENCE_TURN_REQUEST_INVALID',
    )
  }
  if (q.authorityTurnId !== undefined) {
    need(typeof q.authorityTurnId === 'string' && IDENT_RE.test(q.authorityTurnId), 'INFERENCE_TURN_REQUEST_INVALID')
  }

  const input = Object.freeze(q.input.map(validateTurnInputBlock))
  const placementHint =
    q.placementHint === undefined ? undefined : validatePlacementHint(q.placementHint)
  const toolBridge =
    q.toolBridge === undefined ? undefined : validateToolBridgeEndpoint(q.toolBridge)

  if (q.hermeticNoTools === true && toolBridge !== undefined) {
    throw new Error('INFERENCE_TURN_HERMETIC_TOOL_BRIDGE_FORBIDDEN')
  }

  return Object.freeze({
    schemaVersion: 5,
    turnId: q.turnId,
    turnKey: q.turnKey,
    requestId: q.requestId,
    tenantId: q.tenantId,
    sessionKey: q.sessionKey,
    logicalModel: q.logicalModel,
    ...(q.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: q.reasoningEffort as PlatformReasoningEffort }),
    ...(q.serviceTier === undefined
      ? {}
      : { serviceTier: q.serviceTier as InferenceServiceTier }),
    input,
    ...(q.systemInstructions === undefined
      ? {}
      : { systemInstructions: q.systemInstructions as string }),
    ...(placementHint === undefined ? {} : { placementHint }),
    ...(toolBridge === undefined ? {} : { toolBridge }),
    ...(q.readOnly === undefined ? {} : { readOnly: q.readOnly as boolean }),
    ...(q.consultTurn === undefined ? {} : { consultTurn: q.consultTurn as boolean }),
    ...(q.hermeticNoTools === undefined ? {} : { hermeticNoTools: q.hermeticNoTools as boolean }),
    ...(q.needsSwarm === undefined ? {} : { needsSwarm: q.needsSwarm as boolean }),
    ...(q.nativeSessionId === undefined
      ? {}
      : { nativeSessionId: q.nativeSessionId as string | null }),
    ...(q.authorityTurnId === undefined ? {} : { authorityTurnId: q.authorityTurnId as string }),
  })
}
