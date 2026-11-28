/**
 * Wire protocol, path constants, error serialization, and constant-time secret
 * verification shared between Master (`remoteRelayClient.ts`, L2) and the
 * standalone blue-green `remote-relay` daemon (`remoteRelay/{server,main}.ts`, L6).
 *
 * Architecture guardrail: L1 shared protocol module (`scope: ["master", "remote-relay"]`,
 * `authorities: ["crypto"]`). Must NOT value-import internal workspace packages.
 */
import { timingSafeEqual } from 'node:crypto'
import type { InferenceServiceTier, PlatformReasoningEffort } from '@openclaude/protocol'

export const DEFAULT_REMOTE_RELAY_ACTIVE_SOCKET =
  '/run/openclaude-v5-selfhost/remote-relay-active.sock'
export const DEFAULT_REMOTE_RELAY_SLOT_SOCK_PREFIX =
  '/run/openclaude-v5-selfhost/remote-relay'
export const DEFAULT_REMOTE_RELAY_STATE_FILE =
  '/var/lib/openclaude-v5-selfhost/remote-relay-state.json'
export const DEFAULT_REMOTE_RELAY_DRAIN_TIMEOUT_FILE =
  '/var/lib/openclaude-v5-selfhost/remote-relay-drain-timeout.json'

export const REMOTE_RELAY_MODE_ENV = 'OC_REMOTE_RELAY_MODE'
export const REMOTE_RELAY_SOCKET_ENV = 'OC_REMOTE_RELAY_SOCKET'
export const REMOTE_RELAY_SLOT_ENV = 'OC_REMOTE_RELAY_SLOT'
export const REMOTE_RELAY_SLOT_SOCK_PREFIX_ENV = 'OC_REMOTE_RELAY_SLOT_SOCK_PREFIX'
export const REMOTE_RELAY_DRAIN_MS_ENV = 'OC_REMOTE_RELAY_DRAIN_MS'
export const REMOTE_RELAY_BASE_ROOT_ENV = 'OC_REMOTE_RELAY_BASE_ROOT'
export const REMOTE_RELAY_EVIDENCE_ROOT_ENV = 'OC_REMOTE_RELAY_EVIDENCE_ROOT'
export const REMOTE_RELAY_STATE_FILE_ENV = 'OC_REMOTE_RELAY_STATE_FILE'
export const REMOTE_RELAY_DRAIN_TIMEOUT_FILE_ENV = 'OC_REMOTE_RELAY_DRAIN_TIMEOUT_FILE'

export const REMOTE_RELAY_SECRET_HEADER = 'x-oc-egress-secret'
export const REMOTE_RELAY_HOP_HEADER = 'x-oc-relay-hop'
export const REMOTE_RELAY_MAX_BODY_BYTES = 64 * 1024

export const REMOTE_RELAY_PATHS = Object.freeze({
  healthz: '/healthz',
  status: '/status',
  drain: '/drain',
  drainBegin: '/drain-begin',
  reopen: '/reopen',
  prepare: '/rpc/prepare',
  bindCreated: '/rpc/bind-created',
  activate: '/rpc/activate',
  release: '/rpc/release',
  ensureLane: '/rpc/ensure-lane',
  releaseChat: '/rpc/release-chat',
  releaseSessionKey: '/rpc/release-session-key',
  releaseSessionIfIdle: '/rpc/release-session-if-idle',
} as const)

export type RemoteRelaySlot = 'A' | 'B'
export type RemoteRelayRuntimeState = 'ready' | 'disabled' | 'error'

export function parseRemoteRelaySlot(raw: string | undefined): RemoteRelaySlot | null {
  const trimmed = (raw ?? '').trim()
  if (trimmed === 'A' || trimmed === 'B') return trimmed
  return null
}

export function peerRemoteRelaySlot(slot: RemoteRelaySlot): RemoteRelaySlot {
  return slot === 'A' ? 'B' : 'A'
}

export function remoteRelaySlotSocketPath(
  slot: RemoteRelaySlot | null,
  prefix = DEFAULT_REMOTE_RELAY_SLOT_SOCK_PREFIX,
): string {
  const cleanPrefix = prefix.trim() || DEFAULT_REMOTE_RELAY_SLOT_SOCK_PREFIX
  return slot ? `${cleanPrefix}-${slot}.sock` : `${cleanPrefix}.sock`
}

export interface RemoteRelayHealthStatus {
  readonly ok: boolean
  readonly role: 'remote-relay'
  readonly slot: RemoteRelaySlot | null
  readonly instanceId: string
  readonly pid: number
  readonly accepting: boolean
  readonly draining: boolean
  readonly activeRelayCount: number
  readonly registeredRelayCount: number
  readonly unsettledJournals: number
  readonly remoteRuntimeReady: boolean
  readonly runtimeState?: RemoteRelayRuntimeState
  readonly inFlightRpcCount?: number
}

export function isRemoteRelayHealthStatus(value: unknown): value is RemoteRelayHealthStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  const runtimeStateValid =
    v.runtimeState === undefined ||
    v.runtimeState === 'ready' ||
    v.runtimeState === 'disabled' ||
    v.runtimeState === 'error'
  const inFlightValid =
    v.inFlightRpcCount === undefined ||
    (typeof v.inFlightRpcCount === 'number' &&
      Number.isSafeInteger(v.inFlightRpcCount) &&
      v.inFlightRpcCount >= 0)
  return (
    typeof v.ok === 'boolean' &&
    v.role === 'remote-relay' &&
    (v.slot === null || v.slot === 'A' || v.slot === 'B') &&
    typeof v.instanceId === 'string' &&
    typeof v.pid === 'number' &&
    Number.isSafeInteger(v.pid) &&
    typeof v.accepting === 'boolean' &&
    typeof v.draining === 'boolean' &&
    typeof v.activeRelayCount === 'number' &&
    Number.isSafeInteger(v.activeRelayCount) &&
    typeof v.registeredRelayCount === 'number' &&
    Number.isSafeInteger(v.registeredRelayCount) &&
    typeof v.unsettledJournals === 'number' &&
    Number.isSafeInteger(v.unsettledJournals) &&
    typeof v.remoteRuntimeReady === 'boolean' &&
    runtimeStateValid &&
    inFlightValid
  )
}

export interface ReleaseSessionKeyResult {
  readonly released: boolean
  readonly state: 'released' | 'not_found' | 'mismatch' | 'unknown'
}

export interface ReleaseSessionIfIdleResult {
  readonly status: 'released' | 'busy' | 'not_found' | 'unknown'
}

export type RemoteMemoryErrorCode =
  | 'REMOTE_NODE_MEMORY_EXHAUSTED'
  | 'REMOTE_NODE_TASKS_EXHAUSTED'

export interface SerializedRpcError {
  readonly code: string
  readonly message: string
  readonly activeSessions?: number
  readonly memoryCode?: RemoteMemoryErrorCode
}

const UPPER_SNAKE_CODE_RE = /^[A-Z][A-Z0-9_]{2,96}$/

function isMemoryErrorCode(value: unknown): value is RemoteMemoryErrorCode {
  return value === 'REMOTE_NODE_MEMORY_EXHAUSTED' || value === 'REMOTE_NODE_TASKS_EXHAUSTED'
}

function asNonNegSafeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * Safely serializes an error thrown inside `remote-relay` for cross-process JSON transport.
 * Preserves actionable domain error codes (`REMOTE_POOL_DRAINING_RETRY_LATER`,
 * `REMOTE_DRIVER_REVERIFY_REQUIRED`, `REMOTE_LANE_UNAVAILABLE`, `REMOTE_LANE_CAPACITY_EXHAUSTED`,
 * `REMOTE_SESSION_KEY_RESERVED`, `CC5_FRESH_CONTAINER_BINDING_REJECTED`,
 * `REMOTE_LANE_PEER_RELEASE_UNPROVEN`, etc.) as well as `remoteNodeMemory` extended fields
 * (`activeSessions`, `memoryCode`) without leaking stack traces.
 */
export function serializeRpcError(err: unknown): SerializedRpcError {
  const obj =
    err && typeof err === 'object'
      ? (err as {
          code?: unknown
          message?: unknown
          activeSessions?: unknown
          memoryCode?: unknown
          cause?: unknown
        })
      : undefined

  const rawCode =
    typeof obj?.code === 'string' && obj.code.trim().length > 0 ? obj.code.trim() : undefined
  const rawMessage =
    err instanceof Error
      ? err.message
      : typeof obj?.message === 'string'
        ? obj.message
        : typeof err === 'string'
          ? err
          : ''

  let code: string
  if (rawCode) {
    code = rawCode.slice(0, 128)
  } else if (UPPER_SNAKE_CODE_RE.test(rawMessage)) {
    code = rawMessage
  } else {
    code = 'REMOTE_RELAY_RPC_ERROR'
  }

  let memoryCode: RemoteMemoryErrorCode | undefined = isMemoryErrorCode(obj?.memoryCode)
    ? obj.memoryCode
    : isMemoryErrorCode(code)
      ? code
      : undefined
  let activeSessions = asNonNegSafeInt(obj?.activeSessions)

  // Preserve memory rejection metadata even if wrapped in `cause`.
  if (!memoryCode && obj?.cause && typeof obj.cause === 'object') {
    const c = obj.cause as { code?: unknown; activeSessions?: unknown; memoryCode?: unknown }
    if (isMemoryErrorCode(c.code)) {
      memoryCode = c.code
      code = c.code
      activeSessions ??= asNonNegSafeInt(c.activeSessions)
    } else if (isMemoryErrorCode(c.memoryCode)) {
      memoryCode = c.memoryCode
      activeSessions ??= asNonNegSafeInt(c.activeSessions)
    }
  }

  const message = (rawMessage || code).slice(0, 512)
  return {
    code,
    message,
    ...(activeSessions !== undefined ? { activeSessions } : {}),
    ...(memoryCode !== undefined ? { memoryCode } : {}),
  }
}

export type DeserializedRpcError = Error & {
  code: string
  activeSessions?: number
  memoryCode?: RemoteMemoryErrorCode
}

/**
 * Reconstructs an Error on the Master RPC client side so both `err.message`-based checks
 * (`REMOTE_POOL_DRAINING_RETRY_LATER`, `REMOTE_DRIVER_REVERIFY_REQUIRED`, `REMOTE_LANE_UNAVAILABLE`,
 * etc.) and `err.code` / `err.activeSessions` checks (`memoryRejection()`,
 * `userChatBridgeRemotePoolSeal.ts`) work identically to in-process execution.
 */
export function deserializeRpcError(payload: unknown): DeserializedRpcError {
  const root =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : undefined
  const nested =
    root?.error && typeof root.error === 'object' && !Array.isArray(root.error)
      ? (root.error as Record<string, unknown>)
      : root

  let code = 'REMOTE_RELAY_RPC_ERROR'
  let message = ''
  let activeSessions: number | undefined
  let memoryCode: RemoteMemoryErrorCode | undefined

  if (typeof root?.error === 'string' && root.error.trim().length > 0) {
    code = root.error.trim().slice(0, 128)
    message = typeof root.message === 'string' && root.message.length > 0 ? root.message : code
  } else if (nested) {
    if (typeof nested.code === 'string' && nested.code.trim().length > 0) {
      code = nested.code.trim().slice(0, 128)
    } else if (typeof nested.message === 'string' && UPPER_SNAKE_CODE_RE.test(nested.message)) {
      code = nested.message
    }
    if (typeof nested.message === 'string' && nested.message.length > 0) {
      message = nested.message.slice(0, 512)
    } else {
      message = code
    }
    activeSessions = asNonNegSafeInt(nested.activeSessions)
    if (isMemoryErrorCode(nested.memoryCode)) {
      memoryCode = nested.memoryCode
    } else if (isMemoryErrorCode(code)) {
      memoryCode = code
    }
  } else if (typeof payload === 'string' && payload.trim().length > 0) {
    code = UPPER_SNAKE_CODE_RE.test(payload.trim()) ? payload.trim() : 'REMOTE_RELAY_RPC_ERROR'
    message = payload.slice(0, 512)
  } else {
    message = code
  }

  const effectiveCode = memoryCode ?? code
  const err = new Error(message || effectiveCode) as DeserializedRpcError
  err.code = effectiveCode
  if (memoryCode !== undefined) {
    err.memoryCode = memoryCode
  }
  if (activeSessions !== undefined) {
    err.activeSessions = activeSessions
  }
  return err
}

const HTTP_503_ERROR_CODES: ReadonlySet<string> = new Set([
  'REMOTE_POOL_DRAINING_RETRY_LATER',
  'REMOTE_LANE_UNAVAILABLE',
  'REMOTE_DRIVER_REVERIFY_REQUIRED',
  'REMOTE_NODE_MEMORY_EXHAUSTED',
  'REMOTE_NODE_TASKS_EXHAUSTED',
  'REMOTE_LANE_CAPACITY_EXHAUSTED',
  'REMOTE_RELAY_UNAVAILABLE',
  'REMOTE_LANE_PROFILE_UNAVAILABLE',
  'NO_ELIGIBLE_REMOTE_PROFILE',
  'REMOTE_DRIVER_PROBE_STALE',
  'REMOTE_LANE_PEER_RELEASE_UNPROVEN',
])

const HTTP_400_ERROR_CODES: ReadonlySet<string> = new Set([
  'CC5_FRESH_CONTAINER_BINDING_REJECTED',
  'CAPABILITY_UNSATISFIED',
  'INVALID_REQUEST',
  'INVALID_JSON',
])

const RELAY_EFFORT_TUPLE = ['low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly PlatformReasoningEffort[]
const _ASSERT_ALL_EFFORTS: Exclude<PlatformReasoningEffort, (typeof RELAY_EFFORT_TUPLE)[number]> extends never ? true : never = true
const RELAY_TIER_TUPLE = ['standard', 'fast', 'ultrafast'] as const satisfies readonly InferenceServiceTier[]
const _ASSERT_ALL_TIERS: Exclude<InferenceServiceTier, (typeof RELAY_TIER_TUPLE)[number]> extends never ? true : never = true
void _ASSERT_ALL_EFFORTS
void _ASSERT_ALL_TIERS
const RELAY_EFFORTS: ReadonlySet<string> = new Set<string>(RELAY_EFFORT_TUPLE)
const RELAY_TIERS: ReadonlySet<string> = new Set<string>(RELAY_TIER_TUPLE)
const RELAY_CAP_BOOL_KEYS = [
  'needsVision',
  'readOnly',
  'consultTurn',
  'hermeticNoTools',
  'needsSwarm',
] as const

export function parseRelayRequiredTurnCapabilities(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('INVALID_REQUIRED_CAPABILITIES')
  }
  const obj = raw as Record<string, unknown>
  for (const key of Object.keys(obj)) {
    if (
      key !== 'reasoningEffort' &&
      key !== 'serviceTier' &&
      !(RELAY_CAP_BOOL_KEYS as readonly string[]).includes(key)
    ) {
      throw new Error('INVALID_REQUIRED_CAPABILITIES')
    }
  }
  const out: Record<string, unknown> = {}
  for (const bKey of RELAY_CAP_BOOL_KEYS) {
    if (obj[bKey] !== undefined) {
      if (typeof obj[bKey] !== 'boolean') throw new Error('INVALID_REQUIRED_CAPABILITIES')
      out[bKey] = obj[bKey]
    }
  }
  if (obj.reasoningEffort !== undefined) {
    if (typeof obj.reasoningEffort !== 'string' || !RELAY_EFFORTS.has(obj.reasoningEffort)) {
      throw new Error('INVALID_REQUIRED_CAPABILITIES')
    }
    out.reasoningEffort = obj.reasoningEffort
  }
  if (obj.serviceTier !== undefined) {
    if (typeof obj.serviceTier !== 'string' || !RELAY_TIERS.has(obj.serviceTier)) {
      throw new Error('INVALID_REQUIRED_CAPABILITIES')
    }
    out.serviceTier = obj.serviceTier
  }
  return out
}

export function httpStatusForRpcError(code: string): number {
  if (code === 'UNAUTHORIZED') return 401
  if (code === 'REMOTE_SESSION_KEY_RESERVED') return 403
  if (code === 'REMOTE_RELEASE_DRAIN_TIMEOUT') return 409
  if (code === 'PAYLOAD_TOO_LARGE') return 413
  if (HTTP_400_ERROR_CODES.has(code)) return 400
  if (HTTP_503_ERROR_CODES.has(code)) return 503
  return 500
}

/**
 * Constant-time shared-secret check for AF_UNIX RPC requests.
 * Handles missing, array, empty, or different-length values without throwing.
 */
export function verifyRelaySecret(
  presented: string | readonly string[] | undefined,
  expected: string,
): boolean {
  if (typeof presented !== 'string' || presented.length === 0) return false
  if (typeof expected !== 'string' || expected.length === 0) return false
  const presentedBuf = Buffer.from(presented, 'utf8')
  const expectedBuf = Buffer.from(expected, 'utf8')
  if (presentedBuf.length !== expectedBuf.length) {
    // Perform a dummy constant-time comparison to avoid early-return timing skew.
    timingSafeEqual(expectedBuf, expectedBuf)
    return false
  }
  return timingSafeEqual(presentedBuf, expectedBuf)
}
