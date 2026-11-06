/** Pure scope contract. Structural validation is never a substitute for an envelope signature. */
export const CC5_INTERACTIVE_BACKEND = 'cc5-interactive-v1' as const
/** Default catalog id of the built-in remote target; a target/offer may declare another. */
export const CC5_NATIVE_MODEL = 'box-claude-sonnet-5' as const

export interface Cc5ExecutionBackend {
  readonly kind: typeof CC5_INTERACTIVE_BACKEND
  readonly sessionKey: string
  readonly operationId: string
}

/** Scope portion of a separately validated, supervisor-owned v2 binding. */
export interface Cc5BackendBindingScope {
  readonly backendKind: typeof CC5_INTERACTIVE_BACKEND
  /** Declared by the bound target/offer, not by a single hardcoded model. */
  readonly canonicalModel: Cc5CanonicalModel
  readonly sessionKey: string
  readonly operationId: string
}

const SESSION_KEY = /^agent:[A-Za-z0-9_-]{1,64}:webchat:dm:[A-Za-z0-9_-]{8,50}(?![\s\S])/
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/
const MODEL = /^[a-z0-9][a-z0-9._-]{0,63}(?![\s\S])/

/** A catalog model slug that a remote target or offer binds to. */
export type Cc5CanonicalModel = string

export function isCc5CanonicalModel(value: unknown): value is Cc5CanonicalModel {
  return typeof value === 'string' && MODEL.test(value)
}

/** Only the one normal web-chat scope is supported; auxiliary/sessionless routes are excluded. */
export function parseCc5ExecutionBackend(value: unknown): Cc5ExecutionBackend {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('CC5_BACKEND_SCOPE_INVALID')
  const scope = value as Record<string, unknown>
  if (
    Object.keys(scope).sort().join(',') !== 'kind,operationId,sessionKey' ||
    scope.kind !== CC5_INTERACTIVE_BACKEND ||
    typeof scope.sessionKey !== 'string' || !SESSION_KEY.test(scope.sessionKey) ||
    typeof scope.operationId !== 'string' || !OPERATION_ID.test(scope.operationId)
  ) throw new Error('CC5_BACKEND_SCOPE_INVALID')
  return Object.freeze({
    kind: CC5_INTERACTIVE_BACKEND,
    sessionKey: scope.sessionKey,
    operationId: scope.operationId,
  })
}

export function isCc5ExecutionBackend(value: unknown): value is Cc5ExecutionBackend {
  try { parseCc5ExecutionBackend(value); return true } catch { return false }
}

/** A stable runner identity: equal model/engine does not make local and remote state interchangeable. */
export function cc5BackendIdentity(value: Cc5ExecutionBackend | undefined): string {
  if (value === undefined) return 'local-ccb'
  const scope = parseCc5ExecutionBackend(value)
  return JSON.stringify([scope.kind, scope.sessionKey, scope.operationId])
}

export function sameCc5ExecutionBackend(
  left: Cc5ExecutionBackend | undefined,
  right: Cc5ExecutionBackend | undefined,
): boolean {
  return cc5BackendIdentity(left) === cc5BackendIdentity(right)
}

/** This checks the signed payload's semantics, but the caller must first establish its signature. */
export function isCc5BackendAuthority(value: unknown): value is {
  readonly engine: 'ccb'
  readonly canonicalModel: Cc5CanonicalModel
  readonly executionBackend: Cc5ExecutionBackend
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const authority = value as Record<string, unknown>
  return authority.engine === 'ccb' && isCc5CanonicalModel(authority.canonicalModel) &&
    isCc5ExecutionBackend(authority.executionBackend)
}

/** Signature and binding ownership must be checked by the caller before this equality check. */
export function assertCc5BackendBinding(
  authority: unknown,
  binding: Cc5BackendBindingScope,
  sessionKey: string = binding.sessionKey,
): asserts authority is {
  readonly engine: 'ccb'
  readonly canonicalModel: Cc5CanonicalModel
  readonly executionBackend: Cc5ExecutionBackend
} {
  if (!isCc5BackendAuthority(authority) ||
    binding.backendKind !== CC5_INTERACTIVE_BACKEND ||
    !isCc5CanonicalModel(binding.canonicalModel) ||
    authority.canonicalModel !== binding.canonicalModel ||
    authority.executionBackend.sessionKey !== binding.sessionKey ||
    authority.executionBackend.operationId !== binding.operationId ||
    sessionKey !== binding.sessionKey
  ) throw new Error('CC5_BACKEND_BINDING_MISMATCH')
}
