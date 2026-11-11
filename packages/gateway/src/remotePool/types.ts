/**
 * Shared TypeScript contracts for `remote-driver-v4` master relay, SSH/local host transport,
 * container lane, and `RemoteEngineAdapter`.
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  REMOTE_DRIVER_BACKEND,
  REMOTE_DRIVER_PROTOCOL_VERSION,
  parseRemoteDriverExecutionBackend,
  type RemoteControlReply,
  type RemoteDriverAuthorityEngine,
  type RemoteDriverExecutionBackend,
  type RemoteDriverUsagePolicy,
  type RemotePendingToolRequest,
  type RemotePresentationItem,
  type RemoteProbeSnapshot,
  type RemoteReceiptV4,
  type RemoteSecurityEvent,
} from '@openclaude/protocol'
import type { Cc5FinanceTerminalOutcome } from '../cc5Finance.js'
import type { RemoteResourceCode } from '../remoteNodeMemory.js'

const HEX64 = /^[a-f0-9]{64}$/
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

export function remotePoolNeed(condition: unknown, code = 'REMOTE_POOL_CONTRACT_INVALID'): asserts condition {
  if (!condition) {
    throw new Error(code)
  }
}

export interface RemotePoolBinding {
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
  readonly capability: string
  readonly expiresAt: number
}

export function assertRemotePoolBinding(value: unknown): asserts value is RemotePoolBinding {
  remotePoolNeed(value && typeof value === 'object' && !Array.isArray(value), 'REMOTE_POOL_BINDING_INVALID')
  const v = value as Record<string, unknown>
  remotePoolNeed(
    v.version === REMOTE_DRIVER_PROTOCOL_VERSION &&
      v.backendKind === REMOTE_DRIVER_BACKEND &&
      typeof v.operationId === 'string' &&
      UUID_RE.test(v.operationId) &&
      typeof v.runId === 'string' &&
      v.runId.length > 0 &&
      typeof v.uid === 'string' &&
      v.uid.length > 0 &&
      typeof v.containerDbId === 'string' &&
      v.containerDbId.length > 0 &&
      typeof v.dockerId === 'string' &&
      v.dockerId.length > 0 &&
      typeof v.sessionKey === 'string' &&
      v.sessionKey.length > 0 &&
      typeof v.canonicalModel === 'string' &&
      v.canonicalModel.length > 0 &&
      typeof v.upstreamModel === 'string' &&
      v.upstreamModel.length > 0 &&
      typeof v.driverVersion === 'string' &&
      v.driverVersion.length > 0 &&
      typeof v.driverDigest === 'string' &&
      HEX64.test(v.driverDigest) &&
      typeof v.coreDigest === 'string' &&
      HEX64.test(v.coreDigest) &&
      typeof v.probeFingerprint === 'string' &&
      HEX64.test(v.probeFingerprint) &&
      typeof v.manifestSha256 === 'string' &&
      HEX64.test(v.manifestSha256) &&
      typeof v.capability === 'string' &&
      HEX64.test(v.capability) &&
      typeof v.expiresAt === 'number' &&
      Number.isSafeInteger(v.expiresAt) &&
      v.expiresAt > 0,
    'REMOTE_POOL_BINDING_INVALID',
  )
  // Validate the embedded execution-backend identity fields via `@openclaude/protocol`.
  parseRemoteDriverExecutionBackend({
    kind: REMOTE_DRIVER_BACKEND,
    version: REMOTE_DRIVER_PROTOCOL_VERSION,
    engineId: v.engineId,
    driverId: v.driverId,
    driverVersion: v.driverVersion,
    authorityEngine: v.authorityEngine,
    operationId: v.operationId,
    sessionKey: v.sessionKey,
    generation: v.generation,
    profileId: v.profileId,
    authEpoch: v.authEpoch,
  })
}

export function remotePoolBackendOf(binding: Readonly<RemotePoolBinding>): RemoteDriverExecutionBackend {
  return parseRemoteDriverExecutionBackend({
    kind: REMOTE_DRIVER_BACKEND,
    version: REMOTE_DRIVER_PROTOCOL_VERSION,
    engineId: binding.engineId,
    driverId: binding.driverId,
    driverVersion: binding.driverVersion,
    authorityEngine: binding.authorityEngine,
    operationId: binding.operationId,
    sessionKey: binding.sessionKey,
    generation: binding.generation,
    profileId: binding.profileId,
    authEpoch: binding.authEpoch,
  })
}

export interface RemotePoolNodeManifest {
  readonly version: 4
  readonly root: string
  readonly driverId: string
  readonly engineId: string
  readonly operationId: string
  readonly runId: string
  readonly generation: string
  readonly profileId: string
  readonly authEpoch: string
  readonly model: string
  readonly driverDigest: string
  readonly coreDigest: string
  readonly nativeSessionId?: string | null
  readonly maxConcurrentLanes?: number
  readonly maxSliceMemoryBytes?: number
}

export interface RemotePoolLaneSpec {
  readonly controllerPath: string
  readonly controllerSha256: string
  readonly manifest: RemotePoolNodeManifest
  readonly driverContext: Record<string, unknown>
  readonly verifiedProbe: RemoteProbeSnapshot
  readonly registryPath?: string
}

export interface RemotePoolPreflight {
  readonly memoryOk: boolean
  readonly code?: RemoteResourceCode
  readonly activeSessions: number
}

export interface RemotePoolProbeOutput {
  readonly snapshot: RemoteProbeSnapshot
  readonly driverDigest: string
  readonly coreDigest: string
  readonly probeFingerprint: string
}

export interface RemotePoolHostPort {
  preflight(): Promise<RemotePoolPreflight>
  provision(tools: unknown, defaultsContext?: Readonly<Record<string, unknown>>): Promise<void>
  open(role: 'launch' | 'tool-socket'): ChildProcessWithoutNullStreams
  stop(): Promise<{ remoteStopped: true; noHostEffect?: boolean }>
  probe?(context: Record<string, unknown>, probeRoot?: string): Promise<RemotePoolProbeOutput>
}

export interface RemotePoolFinanceTurn {
  readonly requestId: string
  beforeHostStart(): Promise<void>
  beforeDispatch(input: { readonly sequence: number; readonly inputSha256: string }): Promise<void>
  bindNativeThread(
    nativeSessionId: string,
    newlyCreated: boolean,
  ): Promise<Readonly<Record<string, number>> | null>
  abandonUndispatched(cause?: {
    failureCode: 'INTERNAL_ERROR'
    diagnostic: string
  }): Promise<Cc5FinanceTerminalOutcome>
  terminal(receipt: RemoteReceiptV4): Promise<Cc5FinanceTerminalOutcome>
  stop(input: {
    nodeAdmissionRejected?: boolean
    nodeAdmissionReason?: 'REMOTE_NODE_MEMORY_EXHAUSTED' | 'REMOTE_NODE_TASKS_EXHAUSTED'
    readonly hostStartAttempted: boolean
    readonly userSubmitted: boolean
    readonly remoteStopped: boolean
  }): Promise<void>
}

export interface RemotePoolFinancePort {
  admit(input: {
    binding: Readonly<RemotePoolBinding>
    authorityEnvelope: string
    leaseEnvelope: string
    turnKey: string
    sessionKey: string
    usagePolicy: RemoteDriverUsagePolicy
  }): Promise<RemotePoolFinanceTurn>
}

export type RemoteRelayedFrame =
  | { readonly kind: 'security'; readonly event: RemoteSecurityEvent }
  | { readonly kind: 'presentation'; readonly item: RemotePresentationItem }
  | { readonly kind: 'control_reply'; readonly reply: RemoteControlReply }
  | { readonly kind: 'tool_request'; readonly request: RemotePendingToolRequest }
  | {
      readonly kind: 'turn_settled'
      readonly receipt: RemoteReceiptV4
      readonly outcome: Cc5FinanceTerminalOutcome
    }
  | { readonly kind: 'relay_error'; readonly code: string }
