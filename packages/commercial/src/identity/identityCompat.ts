import type { IdentityCompatProfile, IdentityCompatProjection } from '@openclaude/protocol'
import type { FlavorIdentity } from '../flavor/assertFlavor.js'
import type { loadMarketplaceRuntimeSnapshot } from '../marketplace/marketplaceDb.js'

/**
 * Sole registration authority for the inspected selfhost uid3 namespace.
 * Installation/readiness NEVER controls whether this registration exists.
 * Callers pass the result of boot assertFlavorIdentity, not a request/env hint.
 */
const SELFHOST_U3_BUTLER: Readonly<IdentityCompatProfile> = Object.freeze({
  profileId: 'selfhost-u3-butler-v1',
  legacyAgentId: 'butler',
  canonicalAgentId: 'personal-butler',
  localPersonaPath: 'agents/butler/CLAUDE.md',
  localSkillStorageId: 'butler',
})

export function registeredIdentityCompatProfiles(
  identity: FlavorIdentity | undefined,
  authenticatedUid: bigint | number,
): readonly IdentityCompatProfile[] {
  return identity?.status === 'ok' && identity.flavor === 'selfhost' && BigInt(authenticatedUid) === 3n
    ? [SELFHOST_U3_BUTLER]
    : []
}

export type MarketplaceRuntimeSnapshot = Awaited<ReturnType<typeof loadMarketplaceRuntimeSnapshot>>

/** A positive ready-membership check in the caller's same read-only PG snapshot. */
export function projectIdentityCompat(
  authenticatedUid: bigint | number,
  profiles: readonly IdentityCompatProfile[],
  snapshot: MarketplaceRuntimeSnapshot,
): IdentityCompatProjection {
  const ready = new Set([...snapshot.agentSets.presets, ...snapshot.agentSets.installed].map((agent) => agent.slug))
  return {
    schema: 1,
    userId: authenticatedUid.toString(),
    profiles: profiles.map((profile) => ({
      profile,
      readiness: ready.has(profile.canonicalAgentId) ? 'ready' : 'unavailable',
    })),
  }
}
