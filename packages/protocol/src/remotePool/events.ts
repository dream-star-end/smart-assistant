/**
 * Five-duty RemoteDriver protocol contracts:
 * 1. launchSpec  2. decode (5 normalized security events + presentation/control)
 * 3. encode      4. probe   5. usagePolicy
 *
 * Drivers return data only; they never authorize tools, release slots, or settle billing.
 */
import { assertWellFormedJsonValue, remoteCanonicalSha256 } from './canonical.js'

export const REMOTE_DRIVER_PROTOCOL_VERSION = 4 as const

const IDENT_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SHA256_RE = /^[a-f0-9]{64}$/
const TOOL_ALIAS_RE = /^(?:t[0-9]{1,3}|[A-Za-z0-9_-]{1,48})$/

export type RemoteDriverDecodeChannel = 'native' | 'fixed_mcp' | 'probe'

export interface RemoteRawFrameRef {
  readonly channel: RemoteDriverDecodeChannel
  readonly frameSeq: number
  readonly sha256: string
}

export interface RemoteToolCallObservedPayload {
  readonly kind: 'toolCallObserved'
  readonly callId: string
  readonly name: string
  readonly argsHash: string
  readonly arguments: Record<string, unknown>
  readonly phase: 'started' | 'completed'
}

export interface RemoteUsageSamplePayload {
  readonly kind: 'usage'
  readonly sampleId: string
  readonly scopeId: string
  readonly semanticsId: string
  readonly rawCounters: Readonly<Record<string, number>>
}

export interface RemoteTurnTerminalPayload {
  readonly kind: 'turnTerminal'
  readonly terminalId: string
  readonly status: 'success' | 'error' | 'interrupted'
  readonly errorCode?: string
}

export interface RemoteTextDeltaPayload {
  readonly kind: 'textDelta'
  readonly channel: 'answer' | 'reasoning'
  readonly delta: string
}

export interface RemoteDisallowedItemPayload {
  readonly kind: 'disallowedItem'
  readonly reason: string
  readonly itemType: string
}

export type RemoteDriverSecurityPayload =
  | RemoteToolCallObservedPayload
  | RemoteUsageSamplePayload
  | RemoteTurnTerminalPayload
  | RemoteTextDeltaPayload
  | RemoteDisallowedItemPayload

export interface RemoteDriverSecurityEvent {
  readonly protocolVersion: typeof REMOTE_DRIVER_PROTOCOL_VERSION
  readonly operationId: string
  readonly generation: string
  readonly profileId: string
  readonly authEpoch: string
  readonly authorityTurnId: string
  readonly nativeSessionId: string
  readonly nativeTurnId?: string
  readonly seq: number
  readonly rawFrameRef: RemoteRawFrameRef
  readonly driverId: string
  readonly driverVersion: string
  readonly payload: RemoteDriverSecurityPayload
}

export interface RemoteControlReply {
  readonly commandId: string
  readonly commandKind: 'initialize' | 'newTurn' | 'interrupt' | 'resume' | 'readState'
  readonly ok: boolean
  readonly nativeSessionId?: string
  readonly nativeTurnId?: string
  readonly upstreamModel?: string
  readonly errorCode?: string
}

export interface RemotePendingToolRequest {
  readonly rpcId: string | number
  readonly callId: string
  readonly nativeSessionId: string
  readonly nativeTurnId?: string
  readonly server: 'ocbridge'
  readonly name: string
  readonly arguments: Record<string, unknown>
  readonly argsHash: string
}

export interface RemotePresentationItem {
  readonly kind: 'text_delta' | 'thinking_delta' | 'status' | 'compaction' | 'error'
  readonly text?: string
  readonly code?: string
}

export interface RemoteDriverDecodeBatch {
  readonly securityEvents: readonly RemoteDriverSecurityEvent[]
  readonly presentation: readonly RemotePresentationItem[]
  readonly controlReplies: readonly RemoteControlReply[]
  readonly pendingToolRequest?: RemotePendingToolRequest
  readonly nextNativeState: Record<string, unknown>
}

export type RemoteDriverCommand =
  | { readonly kind: 'initialize'; readonly commandId: string; readonly model: string; readonly instructions?: string }
  | {
      readonly kind: 'newTurn'
      readonly commandId: string
      readonly model: string
      readonly prompt: string
      readonly nativeSessionId?: string
      readonly effort?: string
      readonly instructions?: string
    }
  | {
      readonly kind: 'interrupt'
      readonly commandId: string
      readonly nativeSessionId: string
      readonly nativeTurnId?: string
    }
  | {
      readonly kind: 'resume'
      readonly commandId: string
      readonly model: string
      readonly nativeSessionId: string
      readonly instructions?: string
    }
  | { readonly kind: 'readState'; readonly commandId: string; readonly nativeSessionId: string }

export interface RemoteDriverUsagePolicy {
  readonly semanticsId: string
  readonly mode: 'per_turn' | 'cumulative'
  readonly inputField: string
  readonly outputField: string
  readonly cacheReadField?: string
  readonly cacheWriteField?: string
  readonly reasoningField?: string
  /** True when `inputField` includes `cacheReadField` (e.g. Codex total inputTokens includes cachedInputTokens). */
  readonly inputIncludesCacheRead: boolean
  /** True when `outputField` already includes `reasoningField`. */
  readonly outputIncludesReasoning: boolean
  /** False when cacheWrite semantics are unproven and any non-zero value must fail-closed. */
  readonly allowCacheWrite: boolean
}

export interface RemoteProbedModel {
  readonly upstreamModelId: string
  readonly displayName: string
  readonly supportedEfforts: readonly string[]
  readonly defaultEffort: string | null
  readonly supportsAdaptiveThinking: boolean
  readonly supportsVision: boolean
}

export interface RemoteDriverModelSnapshot {
  readonly schemaVersion: 4
  readonly engineId: string
  readonly driverId: string
  readonly driverVersion: string
  readonly source: string
  readonly freshness: 'cli-observed'
  readonly authPresent: boolean
  readonly accountObserved: boolean
  readonly accountHint?: string
  readonly planType?: string
  readonly cliVersion: string
  readonly cliSha256: string
  readonly nativeSha256?: string
  readonly bridgeSha256?: string
  readonly models: readonly RemoteProbedModel[]
  readonly rawResponseSha256: string
  readonly observedAt: string
}

export type RemoteSecurityPayload = RemoteDriverSecurityPayload
export type RemoteSecurityEvent = RemoteDriverSecurityEvent
export type RemoteProbeSnapshot = RemoteDriverModelSnapshot

export function validateUsagePolicy(raw: unknown): RemoteDriverUsagePolicy {
  need(raw && typeof raw === 'object' && !Array.isArray(raw), 'REMOTE_USAGE_POLICY_INVALID')
  const p = raw as Record<string, unknown>
  need(
    typeof p.semanticsId === 'string' &&
      IDENT_RE.test(p.semanticsId) &&
      (p.mode === 'per_turn' || p.mode === 'cumulative') &&
      typeof p.inputField === 'string' &&
      p.inputField.length > 0 &&
      typeof p.outputField === 'string' &&
      p.outputField.length > 0 &&
      (p.cacheReadField === undefined || (typeof p.cacheReadField === 'string' && p.cacheReadField.length > 0)) &&
      (p.cacheWriteField === undefined || (typeof p.cacheWriteField === 'string' && p.cacheWriteField.length > 0)) &&
      (p.reasoningField === undefined || (typeof p.reasoningField === 'string' && p.reasoningField.length > 0)) &&
      typeof p.inputIncludesCacheRead === 'boolean' &&
      typeof p.outputIncludesReasoning === 'boolean' &&
      typeof p.allowCacheWrite === 'boolean',
    'REMOTE_USAGE_POLICY_INVALID',
  )
  return Object.freeze({
    semanticsId: p.semanticsId,
    mode: p.mode,
    inputField: p.inputField,
    outputField: p.outputField,
    ...(p.cacheReadField ? { cacheReadField: p.cacheReadField } : {}),
    ...(p.cacheWriteField ? { cacheWriteField: p.cacheWriteField } : {}),
    ...(p.reasoningField ? { reasoningField: p.reasoningField } : {}),
    inputIncludesCacheRead: p.inputIncludesCacheRead,
    outputIncludesReasoning: p.outputIncludesReasoning,
    allowCacheWrite: p.allowCacheWrite,
  })
}

export function validateRemoteProbeSnapshot(raw: unknown): RemoteDriverModelSnapshot {
  need(raw && typeof raw === 'object' && !Array.isArray(raw), 'REMOTE_PROBE_SNAPSHOT_INVALID')
  assertWellFormedJsonValue(raw, true)
  const s = raw as Record<string, unknown>
  need(
    s.schemaVersion === REMOTE_DRIVER_PROTOCOL_VERSION &&
      typeof s.engineId === 'string' &&
      /^[a-z0-9][a-z0-9_-]{0,31}$/.test(s.engineId) &&
      typeof s.driverId === 'string' &&
      /^[a-z0-9][a-z0-9_-]{0,31}$/.test(s.driverId) &&
      typeof s.driverVersion === 'string' &&
      s.driverVersion.length > 0 &&
      typeof s.source === 'string' &&
      s.source.includes(':') &&
      s.freshness === 'cli-observed' &&
      typeof s.authPresent === 'boolean' &&
      typeof s.accountObserved === 'boolean' &&
      typeof s.cliVersion === 'string' &&
      s.cliVersion.length > 0 &&
      typeof s.cliSha256 === 'string' &&
      SHA256_RE.test(s.cliSha256) &&
      (s.nativeSha256 === undefined || (typeof s.nativeSha256 === 'string' && SHA256_RE.test(s.nativeSha256))) &&
      (s.bridgeSha256 === undefined || (typeof s.bridgeSha256 === 'string' && SHA256_RE.test(s.bridgeSha256))) &&
      typeof s.rawResponseSha256 === 'string' &&
      SHA256_RE.test(s.rawResponseSha256) &&
      typeof s.observedAt === 'string' &&
      s.observedAt.length > 0 &&
      Array.isArray(s.models) &&
      s.models.length > 0,
    'REMOTE_PROBE_SNAPSHOT_INVALID',
  )
  const seenModels = new Set<string>()
  const models: RemoteProbedModel[] = []
  for (const rawModel of s.models) {
    need(rawModel && typeof rawModel === 'object' && !Array.isArray(rawModel), 'REMOTE_PROBE_MODEL_INVALID')
    const m = rawModel as Record<string, unknown>
    need(
      typeof m.upstreamModelId === 'string' &&
        /^[a-z0-9][a-z0-9._-]{0,63}$/.test(m.upstreamModelId) &&
        !seenModels.has(m.upstreamModelId) &&
        typeof m.displayName === 'string' &&
        Array.isArray(m.supportedEfforts) &&
        m.supportedEfforts.every((e) => typeof e === 'string') &&
        (m.defaultEffort === null ||
          (typeof m.defaultEffort === 'string' && m.supportedEfforts.includes(m.defaultEffort))) &&
        typeof m.supportsAdaptiveThinking === 'boolean' &&
        typeof m.supportsVision === 'boolean',
      'REMOTE_PROBE_MODEL_INVALID',
    )
    seenModels.add(m.upstreamModelId)
    models.push({
      upstreamModelId: m.upstreamModelId,
      displayName: m.displayName,
      supportedEfforts: [...(m.supportedEfforts as string[])],
      defaultEffort: m.defaultEffort as string | null,
      supportsAdaptiveThinking: m.supportsAdaptiveThinking,
      supportsVision: m.supportsVision,
    })
  }
  return Object.freeze({
    schemaVersion: REMOTE_DRIVER_PROTOCOL_VERSION,
    engineId: s.engineId,
    driverId: s.driverId,
    driverVersion: s.driverVersion,
    source: s.source,
    freshness: 'cli-observed',
    authPresent: s.authPresent,
    accountObserved: s.accountObserved,
    ...(typeof s.accountHint === 'string' ? { accountHint: s.accountHint } : {}),
    ...(typeof s.planType === 'string' ? { planType: s.planType } : {}),
    cliVersion: s.cliVersion,
    cliSha256: s.cliSha256,
    ...(typeof s.nativeSha256 === 'string' ? { nativeSha256: s.nativeSha256 } : {}),
    ...(typeof s.bridgeSha256 === 'string' ? { bridgeSha256: s.bridgeSha256 } : {}),
    models: Object.freeze(models),
    rawResponseSha256: s.rawResponseSha256,
    observedAt: s.observedAt,
  })
}

function need(condition: unknown, code = 'REMOTE_DRIVER_EVENT_INVALID'): asserts condition {
  if (!condition) throw new Error(code)
}

export function validateSecurityPayload(
  payload: unknown,
  channel: RemoteDriverDecodeChannel = 'native',
): RemoteDriverSecurityPayload {
  need(channel === 'native', 'REMOTE_DRIVER_NON_NATIVE_SECURITY_EVENT')
  need(payload && typeof payload === 'object' && !Array.isArray(payload))
  assertWellFormedJsonValue(payload, true)
  const p = payload as Record<string, unknown>
  switch (p.kind) {
    case 'toolCallObserved': {
      need(
        Object.keys(p).sort().join(',') === 'argsHash,arguments,callId,kind,name,phase' &&
          typeof p.callId === 'string' &&
          IDENT_RE.test(p.callId) &&
          typeof p.name === 'string' &&
          TOOL_ALIAS_RE.test(p.name) &&
          typeof p.argsHash === 'string' &&
          SHA256_RE.test(p.argsHash) &&
          (p.phase === 'started' || p.phase === 'completed') &&
          p.arguments !== null &&
          typeof p.arguments === 'object' &&
          !Array.isArray(p.arguments),
      )
      // Core independently recomputes argsHash; driver-claimed hash must match exact canonical bytes.
      const expectedHash = remoteCanonicalSha256(p.arguments)
      need(expectedHash === p.argsHash, 'REMOTE_DRIVER_TOOL_ARGS_HASH_MISMATCH')
      return {
        kind: 'toolCallObserved',
        callId: p.callId,
        name: p.name,
        argsHash: expectedHash,
        arguments: structuredClone(p.arguments) as Record<string, unknown>,
        phase: p.phase,
      }
    }
    case 'usage': {
      need(
        Object.keys(p).sort().join(',') === 'kind,rawCounters,sampleId,scopeId,semanticsId' &&
          typeof p.sampleId === 'string' &&
          IDENT_RE.test(p.sampleId) &&
          typeof p.scopeId === 'string' &&
          IDENT_RE.test(p.scopeId) &&
          typeof p.semanticsId === 'string' &&
          IDENT_RE.test(p.semanticsId) &&
          p.rawCounters !== null &&
          typeof p.rawCounters === 'object' &&
          !Array.isArray(p.rawCounters),
      )
      const counters = p.rawCounters as Record<string, unknown>
      const out: Record<string, number> = {}
      const keys = Object.keys(counters)
      need(keys.length > 0 && keys.length <= 16)
      // Driver cannot smuggle price/cost/settled flags in usage counters.
      for (const k of keys) {
        need(!/price|cost|credit|settled|usd/i.test(k), 'REMOTE_DRIVER_FORBIDDEN_BILLING_FIELD')
        const v = counters[k]
        need(typeof v === 'number' && Number.isSafeInteger(v) && v >= 0)
        out[k] = v
      }
      return {
        kind: 'usage',
        sampleId: p.sampleId,
        scopeId: p.scopeId,
        semanticsId: p.semanticsId,
        rawCounters: Object.freeze(out),
      }
    }
    case 'turnTerminal': {
      const allowedKeys = p.errorCode === undefined ? 'kind,status,terminalId' : 'errorCode,kind,status,terminalId'
      need(
        Object.keys(p).sort().join(',') === allowedKeys &&
          typeof p.terminalId === 'string' &&
          IDENT_RE.test(p.terminalId) &&
          (p.status === 'success' || p.status === 'error' || p.status === 'interrupted') &&
          (p.errorCode === undefined || (typeof p.errorCode === 'string' && IDENT_RE.test(p.errorCode))),
      )
      return {
        kind: 'turnTerminal',
        terminalId: p.terminalId,
        status: p.status,
        ...(p.errorCode === undefined ? {} : { errorCode: p.errorCode }),
      }
    }
    case 'textDelta': {
      need(
        Object.keys(p).sort().join(',') === 'channel,delta,kind' &&
          (p.channel === 'answer' || p.channel === 'reasoning') &&
          typeof p.delta === 'string',
      )
      return { kind: 'textDelta', channel: p.channel, delta: p.delta }
    }
    case 'disallowedItem': {
      need(
        Object.keys(p).sort().join(',') === 'itemType,kind,reason' &&
          typeof p.reason === 'string' &&
          p.reason.length > 0 &&
          p.reason.length <= 128 &&
          typeof p.itemType === 'string' &&
          p.itemType.length > 0 &&
          p.itemType.length <= 128,
      )
      return { kind: 'disallowedItem', reason: p.reason, itemType: p.itemType }
    }
    default:
      throw new Error('REMOTE_DRIVER_UNKNOWN_SECURITY_EVENT')
  }
}

export function validateSecurityEvent(raw: unknown): RemoteDriverSecurityEvent {
  need(raw && typeof raw === 'object' && !Array.isArray(raw))
  const e = raw as Record<string, unknown>
  const expectedKeys =
    e.nativeTurnId === undefined
      ? 'authEpoch,authorityTurnId,driverId,driverVersion,generation,nativeSessionId,operationId,payload,profileId,protocolVersion,rawFrameRef,seq'
      : 'authEpoch,authorityTurnId,driverId,driverVersion,generation,nativeSessionId,nativeTurnId,operationId,payload,profileId,protocolVersion,rawFrameRef,seq'
  need(
    Object.keys(e).sort().join(',') === expectedKeys &&
      e.protocolVersion === REMOTE_DRIVER_PROTOCOL_VERSION &&
      typeof e.operationId === 'string' &&
      IDENT_RE.test(e.operationId) &&
      typeof e.generation === 'string' &&
      /^[1-9][0-9]{0,15}$/.test(e.generation) &&
      typeof e.profileId === 'string' &&
      /^[a-z0-9][a-z0-9_-]{0,63}$/.test(e.profileId) &&
      typeof e.authEpoch === 'string' &&
      IDENT_RE.test(e.authEpoch) &&
      typeof e.authorityTurnId === 'string' &&
      IDENT_RE.test(e.authorityTurnId) &&
      typeof e.nativeSessionId === 'string' &&
      IDENT_RE.test(e.nativeSessionId) &&
      (e.nativeTurnId === undefined || (typeof e.nativeTurnId === 'string' && IDENT_RE.test(e.nativeTurnId))) &&
      typeof e.seq === 'number' &&
      Number.isSafeInteger(e.seq) &&
      e.seq >= 1 &&
      typeof e.driverId === 'string' &&
      /^[a-z0-9][a-z0-9_-]{0,31}$/.test(e.driverId) &&
      typeof e.driverVersion === 'string' &&
      e.driverVersion.length > 0 &&
      e.driverVersion.length <= 64,
  )
  need(e.rawFrameRef && typeof e.rawFrameRef === 'object' && !Array.isArray(e.rawFrameRef))
  const ref = e.rawFrameRef as Record<string, unknown>
  need(
    Object.keys(ref).sort().join(',') === 'channel,frameSeq,sha256' &&
      ref.channel === 'native' &&
      typeof ref.frameSeq === 'number' &&
      Number.isSafeInteger(ref.frameSeq) &&
      ref.frameSeq >= 1 &&
      typeof ref.sha256 === 'string' &&
      SHA256_RE.test(ref.sha256),
  )
  const payload = validateSecurityPayload(e.payload, 'native')
  return Object.freeze({
    protocolVersion: REMOTE_DRIVER_PROTOCOL_VERSION,
    operationId: e.operationId,
    generation: e.generation,
    profileId: e.profileId,
    authEpoch: e.authEpoch,
    authorityTurnId: e.authorityTurnId,
    nativeSessionId: e.nativeSessionId,
    ...(e.nativeTurnId === undefined ? {} : { nativeTurnId: e.nativeTurnId }),
    seq: e.seq,
    rawFrameRef: Object.freeze({ channel: 'native', frameSeq: ref.frameSeq, sha256: ref.sha256 }),
    driverId: e.driverId,
    driverVersion: e.driverVersion,
    payload,
  })
}

export function validatePendingToolRequest(raw: unknown): RemotePendingToolRequest {
  need(raw && typeof raw === 'object' && !Array.isArray(raw), 'REMOTE_DRIVER_MCP_REQUEST_INVALID')
  const r = raw as Record<string, unknown>
  const expectedKeys =
    r.nativeTurnId === undefined
      ? 'argsHash,arguments,callId,name,nativeSessionId,rpcId,server'
      : 'argsHash,arguments,callId,name,nativeSessionId,nativeTurnId,rpcId,server'
  need(
    Object.keys(r).sort().join(',') === expectedKeys &&
      ((typeof r.rpcId === 'string' && r.rpcId.length > 0 && r.rpcId.length <= 256) ||
        (typeof r.rpcId === 'number' && Number.isSafeInteger(r.rpcId))) &&
      typeof r.callId === 'string' &&
      IDENT_RE.test(r.callId) &&
      typeof r.nativeSessionId === 'string' &&
      IDENT_RE.test(r.nativeSessionId) &&
      (r.nativeTurnId === undefined || (typeof r.nativeTurnId === 'string' && IDENT_RE.test(r.nativeTurnId))) &&
      r.server === 'ocbridge' &&
      typeof r.name === 'string' &&
      TOOL_ALIAS_RE.test(r.name) &&
      r.arguments !== null &&
      typeof r.arguments === 'object' &&
      !Array.isArray(r.arguments) &&
      typeof r.argsHash === 'string' &&
      SHA256_RE.test(r.argsHash),
    'REMOTE_DRIVER_MCP_REQUEST_INVALID',
  )
  const expectedHash = remoteCanonicalSha256(r.arguments)
  need(expectedHash === r.argsHash, 'REMOTE_DRIVER_MCP_ARGS_HASH_MISMATCH')
  return {
    rpcId: r.rpcId,
    callId: r.callId,
    nativeSessionId: r.nativeSessionId,
    ...(r.nativeTurnId === undefined ? {} : { nativeTurnId: r.nativeTurnId }),
    server: 'ocbridge',
    name: r.name,
    arguments: structuredClone(r.arguments) as Record<string, unknown>,
    argsHash: expectedHash,
  }
}
