/**
 * Generic versioned remote driver execution backend (`remote-driver-v4`).
 * Legacy `cc5-interactive-v1` and `codex-app-server-v1` wire formats remain dual-read compatible.
 */
import { parseCc5ExecutionBackend } from '../cc5Backend.js'
import type { ModelAuthorityEngine } from '../modelAuthority.js'

export const REMOTE_DRIVER_BACKEND = 'remote-driver-v4' as const

const ENGINE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/
const DRIVER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/
const DRIVER_VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9._-]{1,32})?$/
const GENERATION_RE = /^[1-9][0-9]{0,15}$/
const PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const AUTH_EPOCH_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const REMOTE_CANONICAL_MODEL_RE = /^[a-z0-9][a-z0-9._-]{0,56}-remote$/

const AUTHORITY_ENGINES: ReadonlySet<ModelAuthorityEngine> = new Set<ModelAuthorityEngine>([
  'ccb',
  'codex',
  'grok',
  'cursor',
  'zcode',
  'antigravity',
])

const BUILTIN_ENGINE_AUTHORITY_MAP: Readonly<Record<string, ModelAuthorityEngine>> = {
  cc: 'ccb',
  codex: 'codex',
  grok: 'grok',
  cursor: 'cursor',
  zcode: 'zcode',
  antigravity: 'antigravity',
}

export interface RemoteDriverExecutionBackend {
  readonly kind: typeof REMOTE_DRIVER_BACKEND
  readonly version: 4
  readonly engineId: string
  readonly authorityEngine: ModelAuthorityEngine
  readonly driverId: string
  readonly driverVersion: string
  readonly sessionKey: string
  readonly operationId: string
  readonly generation: string
  readonly profileId: string
  readonly authEpoch: string
}

const EXPECTED_KEYS = [
  'authEpoch',
  'authorityEngine',
  'driverId',
  'driverVersion',
  'engineId',
  'generation',
  'kind',
  'operationId',
  'profileId',
  'sessionKey',
  'version',
].join(',')

export function parseRemoteDriverExecutionBackend(raw: unknown): RemoteDriverExecutionBackend {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('REMOTE_DRIVER_BACKEND_SCOPE_INVALID')
  }
  const b = raw as Record<string, unknown>
  if (
    Object.keys(b).sort().join(',') !== EXPECTED_KEYS ||
    b.kind !== REMOTE_DRIVER_BACKEND ||
    b.version !== 4 ||
    typeof b.engineId !== 'string' ||
    !ENGINE_ID_RE.test(b.engineId) ||
    typeof b.authorityEngine !== 'string' ||
    !AUTHORITY_ENGINES.has(b.authorityEngine as ModelAuthorityEngine) ||
    typeof b.driverId !== 'string' ||
    !DRIVER_ID_RE.test(b.driverId) ||
    typeof b.driverVersion !== 'string' ||
    !DRIVER_VERSION_RE.test(b.driverVersion) ||
    typeof b.generation !== 'string' ||
    !GENERATION_RE.test(b.generation) ||
    typeof b.profileId !== 'string' ||
    !PROFILE_ID_RE.test(b.profileId) ||
    typeof b.authEpoch !== 'string' ||
    !AUTH_EPOCH_RE.test(b.authEpoch) ||
    typeof b.sessionKey !== 'string' ||
    typeof b.operationId !== 'string'
  ) {
    throw new Error('REMOTE_DRIVER_BACKEND_SCOPE_INVALID')
  }
  const requiredAuthority = BUILTIN_ENGINE_AUTHORITY_MAP[b.engineId]
  if (requiredAuthority !== undefined && b.authorityEngine !== requiredAuthority) {
    throw new Error('REMOTE_DRIVER_BACKEND_SCOPE_INVALID')
  }
  parseCc5ExecutionBackend({
    kind: 'cc5-interactive-v1',
    sessionKey: b.sessionKey,
    operationId: b.operationId,
  })
  return Object.freeze({
    kind: REMOTE_DRIVER_BACKEND,
    version: 4,
    engineId: b.engineId,
    authorityEngine: b.authorityEngine as ModelAuthorityEngine,
    driverId: b.driverId,
    driverVersion: b.driverVersion,
    sessionKey: b.sessionKey,
    operationId: b.operationId,
    generation: b.generation,
    profileId: b.profileId,
    authEpoch: b.authEpoch,
  })
}

export function isRemoteDriverExecutionBackend(raw: unknown): raw is RemoteDriverExecutionBackend {
  try {
    parseRemoteDriverExecutionBackend(raw)
    return true
  } catch {
    return false
  }
}

export function isRemoteDriverBackendAuthority(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const a = raw as { engine?: unknown; canonicalModel?: unknown; executionBackend?: unknown }
  if (typeof a.canonicalModel !== 'string' || !REMOTE_CANONICAL_MODEL_RE.test(a.canonicalModel)) {
    return false
  }
  try {
    const backend = parseRemoteDriverExecutionBackend(a.executionBackend)
    return a.engine === backend.authorityEngine
  } catch {
    return false
  }
}

export function sameRemoteDriverExecutionBackend(
  left: RemoteDriverExecutionBackend,
  right: RemoteDriverExecutionBackend,
): boolean {
  const a = parseRemoteDriverExecutionBackend(left)
  const b = parseRemoteDriverExecutionBackend(right)
  return (
    a.kind === b.kind &&
    a.version === b.version &&
    a.engineId === b.engineId &&
    a.authorityEngine === b.authorityEngine &&
    a.driverId === b.driverId &&
    a.driverVersion === b.driverVersion &&
    a.sessionKey === b.sessionKey &&
    a.operationId === b.operationId &&
    a.generation === b.generation &&
    a.profileId === b.profileId &&
    a.authEpoch === b.authEpoch
  )
}
