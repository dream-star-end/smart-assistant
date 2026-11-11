/**
 * Unified RemoteReceiptV4 and policy-driven usage normalization.
 *
 * Three digests with strict domain separation:
 * - `rawEvidenceDigest`: ordered hash chain over raw frame bytes received by core.
 * - `semanticDigest`: logical turn usage/identity digest (excludes transport runId/generation so
 *   reconnects on the same turn produce the identical semantic digest).
 * - `receiptDigest`: canonical sha256 over the full v4 receipt (excluding `receiptDigest` itself).
 */
import { isDeepStrictEqual } from 'node:util'
import { REMOTE_DRIVER_BACKEND } from './backend.js'
import { remoteCanonicalSha256 } from './canonical.js'
import type { RemoteDriverUsagePolicy } from './events.js'

const IDENT_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SHA256_RE = /^[a-f0-9]{64}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const POSITIVE_ID_RE = /^[1-9][0-9]{0,18}$/
const MODEL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

export interface RemoteNormalizedUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

export interface RemoteReceiptV4Provenance {
  readonly generation: string
  readonly manifestHash: string
  readonly coreDigest: string
  readonly probeFingerprint: string
}

export interface RemoteReceiptV4 {
  readonly version: 4
  readonly backendKind: typeof REMOTE_DRIVER_BACKEND
  readonly engineId: string
  readonly driverId: string
  readonly driverVersion: string
  readonly driverDigest: string
  readonly uid: string
  readonly containerDbId: string
  readonly dockerId: string
  readonly operationId: string
  readonly runId: string
  readonly sessionKey: string
  readonly canonicalModel: string
  readonly upstreamModel: string
  readonly profileId: string
  readonly authEpoch: string
  readonly authorityTurnId: string
  readonly turnKey: string
  readonly requestId: string
  readonly nativeSessionId: string
  readonly terminalId: string
  readonly usageSemantics: string
  readonly usageMode: 'per_turn' | 'cumulative'
  readonly countersBaseline: Readonly<Record<string, number>> | null
  readonly countersFinal: Readonly<Record<string, number>>
  readonly usage: RemoteNormalizedUsage
  readonly status: 'success' | 'error'
  readonly nativeStatus: 'success' | 'error' | 'interrupted'
  readonly rawEvidenceDigest: string
  readonly semanticDigest: string
  readonly provenance: RemoteReceiptV4Provenance
  readonly receiptDigest: string
}

function need(condition: unknown, code = 'REMOTE_RECEIPT_V4_INVALID'): asserts condition {
  if (!condition) throw new Error(code)
}

function validateCounterMap(raw: unknown): Readonly<Record<string, number>> {
  need(raw && typeof raw === 'object' && !Array.isArray(raw))
  const r = raw as Record<string, unknown>
  const keys = Object.keys(r)
  need(keys.length > 0 && keys.length <= 16)
  const out: Record<string, number> = {}
  for (const k of keys) {
    need(!/price|cost|credit|settled|usd/i.test(k), 'REMOTE_USAGE_FORBIDDEN_FIELD')
    const v = r[k]
    need(typeof v === 'number' && Number.isSafeInteger(v) && v >= 0, 'REMOTE_USAGE_COUNTER_INVALID')
    out[k] = v
  }
  return Object.freeze(out)
}

/**
 * Core-owned usage normalization from a driver's declarative UsagePolicy.
 * Rejects counter drops in cumulative mode, inclusion violations, and unproven cache-write tokens.
 */
export function normalizeUsageWithPolicy(
  policy: RemoteDriverUsagePolicy,
  countersFinalRaw: Readonly<Record<string, number>>,
  countersBaselineRaw: Readonly<Record<string, number>> | null,
): {
  readonly baseline: Readonly<Record<string, number>> | null
  readonly final: Readonly<Record<string, number>>
  readonly usage: RemoteNormalizedUsage
} {
  const final = validateCounterMap(countersFinalRaw)
  let effective: Record<string, number>
  let baseline: Readonly<Record<string, number>> | null = null

  if (policy.mode === 'cumulative') {
    need(countersBaselineRaw !== null, 'REMOTE_USAGE_BASELINE_REQUIRED')
    baseline = validateCounterMap(countersBaselineRaw)
    need(
      Object.keys(final).sort().join(',') === Object.keys(baseline).sort().join(','),
      'REMOTE_USAGE_COUNTER_SHAPE_MISMATCH',
    )
    effective = {}
    for (const k of Object.keys(final)) {
      const delta = final[k] - baseline[k]
      need(delta >= 0 && Number.isSafeInteger(delta), 'REMOTE_USAGE_COUNTER_DECREASED')
      effective[k] = delta
    }
  } else {
    need(countersBaselineRaw === null, 'REMOTE_USAGE_UNEXPECTED_BASELINE')
    effective = { ...final }
  }

  const readCounter = (field: string | undefined, required: boolean): number => {
    if (!field) return 0
    if (!(field in effective)) {
      need(!required, 'REMOTE_USAGE_MISSING_REQUIRED_COUNTER')
      return 0
    }
    const v = effective[field]
    need(typeof v === 'number' && Number.isSafeInteger(v) && v >= 0, 'REMOTE_USAGE_COUNTER_INVALID')
    return v
  }

  const rawInput = readCounter(policy.inputField, true)
  const rawOutput = readCounter(policy.outputField, true)
  const cacheRead = readCounter(policy.cacheReadField, false)
  const cacheWrite = readCounter(policy.cacheWriteField, false)
  const reasoning = readCounter(policy.reasoningField, false)

  if (!policy.allowCacheWrite) {
    need(cacheWrite === 0, 'REMOTE_USAGE_CACHE_WRITE_UNPROVEN')
  }
  if (policy.inputIncludesCacheRead) {
    need(cacheRead <= rawInput, 'REMOTE_USAGE_CACHE_EXCEEDS_INPUT')
  }
  if (policy.outputIncludesReasoning && policy.reasoningField) {
    need(reasoning <= rawOutput, 'REMOTE_USAGE_REASONING_EXCEEDS_OUTPUT')
  }

  const inputTokens = policy.inputIncludesCacheRead ? rawInput - cacheRead : rawInput
  const outputTokens = policy.outputIncludesReasoning ? rawOutput : rawOutput + reasoning
  need(
    Number.isSafeInteger(inputTokens) &&
      inputTokens >= 0 &&
      Number.isSafeInteger(outputTokens) &&
      outputTokens >= 0,
    'REMOTE_USAGE_NORMALIZED_OVERFLOW',
  )

  return {
    baseline,
    final,
    usage: Object.freeze({
      inputTokens,
      outputTokens,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
    }),
  }
}

export function computeReceiptV4SemanticDigest(
  r: Pick<
    RemoteReceiptV4,
    | 'uid'
    | 'operationId'
    | 'engineId'
    | 'driverId'
    | 'profileId'
    | 'authEpoch'
    | 'canonicalModel'
    | 'upstreamModel'
    | 'authorityTurnId'
    | 'turnKey'
    | 'requestId'
    | 'nativeSessionId'
    | 'terminalId'
    | 'usageSemantics'
    | 'usageMode'
    | 'countersBaseline'
    | 'countersFinal'
    | 'usage'
    | 'status'
    | 'nativeStatus'
  >,
): string {
  return remoteCanonicalSha256({
    version: 4,
    uid: r.uid,
    operationId: r.operationId,
    engineId: r.engineId,
    driverId: r.driverId,
    profileId: r.profileId,
    authEpoch: r.authEpoch,
    canonicalModel: r.canonicalModel,
    upstreamModel: r.upstreamModel,
    authorityTurnId: r.authorityTurnId,
    turnKey: r.turnKey,
    requestId: r.requestId,
    nativeSessionId: r.nativeSessionId,
    terminalId: r.terminalId,
    usageSemantics: r.usageSemantics,
    usageMode: r.usageMode,
    countersBaseline: r.countersBaseline,
    countersFinal: r.countersFinal,
    usage: r.usage,
    status: r.status,
    nativeStatus: r.nativeStatus,
  })
}

export interface BuildRemoteReceiptV4Input {
  readonly engineId: string
  readonly driverId: string
  readonly driverVersion: string
  readonly driverDigest: string
  readonly uid: string
  readonly containerDbId: string
  readonly dockerId: string
  readonly operationId: string
  readonly runId: string
  readonly sessionKey: string
  readonly canonicalModel: string
  readonly upstreamModel: string
  readonly profileId: string
  readonly authEpoch: string
  readonly authorityTurnId: string
  readonly turnKey: string
  readonly requestId: string
  readonly nativeSessionId: string
  readonly terminalId: string
  readonly policy: RemoteDriverUsagePolicy
  readonly countersBaseline: Readonly<Record<string, number>> | null
  readonly countersFinal: Readonly<Record<string, number>>
  readonly nativeStatus: 'success' | 'error' | 'interrupted'
  readonly rawEvidenceDigest: string
  readonly provenance: RemoteReceiptV4Provenance
}

export function buildRemoteReceiptV4(input: BuildRemoteReceiptV4Input): RemoteReceiptV4 {
  need(
    /^[a-z0-9][a-z0-9_-]{0,31}$/.test(input.engineId) &&
      /^[a-z0-9][a-z0-9_-]{0,31}$/.test(input.driverId) &&
      input.driverVersion.length > 0 &&
      input.driverVersion.length <= 64 &&
      SHA256_RE.test(input.driverDigest) &&
      POSITIVE_ID_RE.test(input.uid) &&
      POSITIVE_ID_RE.test(input.containerDbId) &&
      SHA256_RE.test(input.dockerId) &&
      UUID_RE.test(input.operationId) &&
      UUID_RE.test(input.runId) &&
      input.sessionKey.length > 0 &&
      input.sessionKey.length <= 512 &&
      MODEL_RE.test(input.canonicalModel) &&
      MODEL_RE.test(input.upstreamModel) &&
      /^[a-z0-9][a-z0-9_-]{0,63}$/.test(input.profileId) &&
      IDENT_RE.test(input.authEpoch) &&
      /^[a-f0-9]{32}$/.test(input.authorityTurnId) &&
      SHA256_RE.test(input.turnKey) &&
      /^[A-Za-z0-9_-]{1,64}$/.test(input.requestId) &&
      IDENT_RE.test(input.nativeSessionId) &&
      IDENT_RE.test(input.terminalId) &&
      IDENT_RE.test(input.policy.semanticsId) &&
      ['success', 'error', 'interrupted'].includes(input.nativeStatus) &&
      SHA256_RE.test(input.rawEvidenceDigest) &&
      /^[1-9][0-9]{0,15}$/.test(input.provenance.generation) &&
      SHA256_RE.test(input.provenance.manifestHash) &&
      SHA256_RE.test(input.provenance.coreDigest) &&
      SHA256_RE.test(input.provenance.probeFingerprint),
  )

  const normalized = normalizeUsageWithPolicy(input.policy, input.countersFinal, input.countersBaseline)
  const status: 'success' | 'error' = input.nativeStatus === 'success' ? 'success' : 'error'
  const bodyWithoutDigests = {
    version: 4 as const,
    backendKind: REMOTE_DRIVER_BACKEND,
    engineId: input.engineId,
    driverId: input.driverId,
    driverVersion: input.driverVersion,
    driverDigest: input.driverDigest,
    uid: input.uid,
    containerDbId: input.containerDbId,
    dockerId: input.dockerId,
    operationId: input.operationId,
    runId: input.runId,
    sessionKey: input.sessionKey,
    canonicalModel: input.canonicalModel,
    upstreamModel: input.upstreamModel,
    profileId: input.profileId,
    authEpoch: input.authEpoch,
    authorityTurnId: input.authorityTurnId,
    turnKey: input.turnKey,
    requestId: input.requestId,
    nativeSessionId: input.nativeSessionId,
    terminalId: input.terminalId,
    usageSemantics: input.policy.semanticsId,
    usageMode: input.policy.mode,
    countersBaseline: normalized.baseline,
    countersFinal: normalized.final,
    usage: normalized.usage,
    status,
    nativeStatus: input.nativeStatus,
    rawEvidenceDigest: input.rawEvidenceDigest,
    provenance: Object.freeze({ ...input.provenance }),
  }
  const semanticDigest = computeReceiptV4SemanticDigest(bodyWithoutDigests)
  const withSemantic = { ...bodyWithoutDigests, semanticDigest }
  const receiptDigest = remoteCanonicalSha256(withSemantic)
  return Object.freeze({ ...withSemantic, receiptDigest })
}

export function validateRemoteReceiptV4(
  raw: unknown,
  policy: RemoteDriverUsagePolicy,
): RemoteReceiptV4 {
  need(raw && typeof raw === 'object' && !Array.isArray(raw))
  const r = raw as Record<string, unknown>
  need(r.version === 4 && r.backendKind === REMOTE_DRIVER_BACKEND)
  need(r.provenance && typeof r.provenance === 'object' && !Array.isArray(r.provenance))
  const prov = r.provenance as Record<string, unknown>
  const rebuilt = buildRemoteReceiptV4({
    engineId: String(r.engineId),
    driverId: String(r.driverId),
    driverVersion: String(r.driverVersion),
    driverDigest: String(r.driverDigest),
    uid: String(r.uid),
    containerDbId: String(r.containerDbId),
    dockerId: String(r.dockerId),
    operationId: String(r.operationId),
    runId: String(r.runId),
    sessionKey: String(r.sessionKey),
    canonicalModel: String(r.canonicalModel),
    upstreamModel: String(r.upstreamModel),
    profileId: String(r.profileId),
    authEpoch: String(r.authEpoch),
    authorityTurnId: String(r.authorityTurnId),
    turnKey: String(r.turnKey),
    requestId: String(r.requestId),
    nativeSessionId: String(r.nativeSessionId),
    terminalId: String(r.terminalId),
    policy,
    countersBaseline: (r.countersBaseline ?? null) as Readonly<Record<string, number>> | null,
    countersFinal: r.countersFinal as Readonly<Record<string, number>>,
    nativeStatus: r.nativeStatus as 'success' | 'error' | 'interrupted',
    rawEvidenceDigest: String(r.rawEvidenceDigest),
    provenance: {
      generation: String(prov.generation),
      manifestHash: String(prov.manifestHash),
      coreDigest: String(prov.coreDigest),
      probeFingerprint: String(prov.probeFingerprint),
    },
  })
  need(isDeepStrictEqual(rebuilt, raw), 'REMOTE_RECEIPT_V4_DIGEST_MISMATCH')
  return rebuilt
}
