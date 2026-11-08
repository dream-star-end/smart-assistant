/** Versioned remote execution identity. Legacy CC wire bytes remain unchanged. */
import { type Cc5ExecutionBackend, isCc5BackendAuthority, parseCc5ExecutionBackend } from './cc5Backend.js'
export const CODEX_REMOTE_BACKEND = 'codex-app-server-v1' as const
export interface CodexExecutionBackend {
  readonly kind: typeof CODEX_REMOTE_BACKEND
  readonly version: 1
  readonly sessionKey: string
  readonly operationId: string
  readonly generation: string
  readonly profileId: string
  readonly authEpoch: string
}
export type RemoteExecutionBackend = Cc5ExecutionBackend | CodexExecutionBackend
export function parseCodexExecutionBackend(raw: unknown): CodexExecutionBackend {
  const b = raw as CodexExecutionBackend
  if (!b || typeof b !== 'object' || Array.isArray(b) ||
    Object.keys(b).sort().join(',') !== 'authEpoch,generation,kind,operationId,profileId,sessionKey,version' ||
    b.kind !== CODEX_REMOTE_BACKEND || b.version !== 1 ||
    typeof b.generation !== 'string' || !/^[1-9][0-9]{0,15}$/.test(b.generation) ||
    typeof b.profileId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(b.profileId) ||
    typeof b.authEpoch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(b.authEpoch))
    throw new Error('CODEX_BACKEND_SCOPE_INVALID')
  // Reuse only the legacy grammar, never its wire discriminator or authority semantics.
  parseCc5ExecutionBackend({ kind: 'cc5-interactive-v1', sessionKey: b.sessionKey, operationId: b.operationId })
  return Object.freeze({ ...b })
}
export function parseRemoteExecutionBackend(raw: unknown): RemoteExecutionBackend {
  return (raw as { kind?: unknown })?.kind === CODEX_REMOTE_BACKEND
    ? parseCodexExecutionBackend(raw) : parseCc5ExecutionBackend(raw)
}
export function isRemoteBackendAuthority(raw: unknown): boolean {
  if (isCc5BackendAuthority(raw)) return true
  const a = raw as { engine?: unknown; canonicalModel?: unknown; executionBackend?: unknown }
  try {
    return a?.engine === 'codex' && typeof a.canonicalModel === 'string' &&
      /^[a-z0-9][a-z0-9._-]{0,56}-remote$/.test(a.canonicalModel) && !!parseCodexExecutionBackend(a.executionBackend)
  } catch { return false }
}
export function sameRemoteExecutionBackend(a: RemoteExecutionBackend | undefined, b: RemoteExecutionBackend | undefined): boolean {
  if (!a || !b) return a === b
  const x = parseRemoteExecutionBackend(a), y = parseRemoteExecutionBackend(b)
  return x.kind === y.kind && x.sessionKey === y.sessionKey && x.operationId === y.operationId &&
    (x.kind !== CODEX_REMOTE_BACKEND || y.kind === CODEX_REMOTE_BACKEND &&
      x.generation === y.generation && x.profileId === y.profileId && x.authEpoch === y.authEpoch)
}
