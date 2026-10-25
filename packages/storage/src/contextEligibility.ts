/** P0 internal contracts, not a wire format or an authenticated CLI lease reader. */
import { createHash } from 'node:crypto'
import type { MemoryTurnPolicyDecision } from './memoryTurnPolicy.js'
import { inheritMemoryTurnPolicy } from './memoryTurnPolicy.js'
import { isMemoryExpired, type MemoryTtlWarn } from './memoryTtl.js'
import { scanMemoryContent } from './memoryShared.js'
import type { SourceDescriptor } from './contextSource.js'

/** Supplied only by trusted gateway composition after existing authorization.
 * Root, identity, binding and privacy fingerprint must never come from a request/env.
 * This contract does not authenticate its caller; no production caller is wired in P0.
 */
export interface GatewayContextAuthority {
  readonly runtime: 'gateway'
  readonly domainId: string
  readonly effectiveAgentId: string
  readonly sessionId: string
  readonly turnId: string
  readonly boardProjectId: string | null
  readonly contextVersion: number | null
  readonly authorityEpoch: string
  readonly mode: 'legacy' | 'formal'
  readonly root: string
  /** Includes the existing turn decision and session-scoped promptPrivacyFingerprint. */
  readonly policyFingerprint: string
  readonly memoryPolicy: Readonly<MemoryTurnPolicyDecision>
  readonly expiresAt: number
  readonly revoked: boolean
}

export type ContextAuthority = GatewayContextAuthority | {
  readonly runtime: 'cli-managed' | 'cli-unmanaged'
  /** Locator/claims are deliberately opaque and never interpreted as authority. */
  readonly lease?: unknown
}
export interface ContextReadOptions {
  /** Default off. No production env flag or hot-path integration in P0. */
  readonly enabled?: boolean
  readonly now?: () => number
  readonly today: string
  readonly warn?: MemoryTtlWarn
}
export type ContextRejection = 'disabled' | 'cli_lease_blocked' | 'authority_unavailable'
  | 'policy_denied' | 'source_unavailable' | 'scope_changed' | 'source_changed' | 'expired' | 'unsafe'
export type ContextAccess = { readonly allowed: true } | { readonly allowed: false; readonly reason: ContextRejection }

/** Must run before even enumerating source metadata. Existing CLI paths are unaffected. */
export function contextAccess(authority: ContextAuthority, options: ContextReadOptions): ContextAccess {
  if (options.enabled !== true) return { allowed: false, reason: 'disabled' }
  if (authority.runtime !== 'gateway') return { allowed: false, reason: 'cli_lease_blocked' }
  if (authority.revoked || !Number.isFinite(authority.expiresAt)
    || authority.expiresAt <= (options.now ?? Date.now)()
    || !authority.domainId || !authority.effectiveAgentId || !authority.sessionId || !authority.turnId
    || !authority.authorityEpoch || !authority.policyFingerprint || !authority.root) {
    return { allowed: false, reason: 'authority_unavailable' }
  }
  if (!inheritMemoryTurnPolicy(authority.memoryPolicy).allowed) return { allowed: false, reason: 'policy_denied' }
  return { allowed: true }
}

export function contextContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/** Logical identity, never realpath-based permission inference. No persistent cache in P0. */
export function contextScopeKey(authority: GatewayContextAuthority): string {
  return contextContentHash(JSON.stringify([
    authority.domainId, authority.effectiveAgentId, authority.sessionId, authority.turnId,
    authority.boardProjectId, authority.contextVersion, authority.authorityEpoch,
    authority.mode, authority.root, authority.policyFingerprint,
    authority.memoryPolicy.allowed, authority.memoryPolicy.reason,
  ]))
}

export interface ContextSourceReference {
  readonly sourceId: string
  readonly scopeKey: string
  readonly sourceVersion: string
}

/** A current, authorized re-read is mandatory; an old manifest is not source proof.
 * This checks source eligibility only, not summary authenticity or a P1 read budget.
 */
export function contextEligibility(
  authority: ContextAuthority,
  options: ContextReadOptions,
  reference: ContextSourceReference,
  current: SourceDescriptor | null,
): ContextAccess {
  const access = contextAccess(authority, options)
  if (!access.allowed) return access
  if (authority.runtime !== 'gateway') return { allowed: false, reason: 'cli_lease_blocked' }
  if (!current) return { allowed: false, reason: 'source_unavailable' }
  const scope = contextScopeKey(authority)
  if (reference.scopeKey !== scope || current.scopeKey !== scope) return { allowed: false, reason: 'scope_changed' }
  if (current.sourceId !== reference.sourceId || current.sourceVersion !== reference.sourceVersion
    || contextContentHash(current.content) !== current.sourceVersion) return { allowed: false, reason: 'source_changed' }
  if (current.expires.some(expires => isMemoryExpired(expires, options.today, options.warn))) return { allowed: false, reason: 'expired' }
  if (!scanMemoryContent(current.content).ok) return { allowed: false, reason: 'unsafe' }
  return { allowed: true }
}
