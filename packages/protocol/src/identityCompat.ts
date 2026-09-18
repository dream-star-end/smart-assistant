/** An explicit master registration, NOT an inference from matching local Agent IDs. */
export interface IdentityCompatProfile {
  profileId: string
  legacyAgentId: string
  canonicalAgentId: string
  /** Relative to OPENCLAUDE_HOME; gateway must verify the actual local resource. */
  localPersonaPath: string
  /** Sole private-skill write namespace; never an execution/capability identity. */
  localSkillStorageId: string
}

export interface IdentityCompatProjection {
  schema: 1
  userId: string
  /** Empty means explicitly no registration. Absence/fetch failure does NOT. */
  profiles: ReadonlyArray<{
    profile: IdentityCompatProfile
    readiness: 'ready' | 'unavailable'
  }>
}

export type IdentityCompatResolution = {
  requestedId: string
  executionAgentId: string
} & (
  | { status: 'no-registration'; profile?: undefined }
  | { status: 'registered-ready' | 'registered-unavailable'; profile: IdentityCompatProfile }
)

export class IdentityCompatError extends Error {
  constructor(
    readonly code: 'COMPAT_AUTHORITY_UNAVAILABLE' | 'COMPAT_NOT_READY' | 'COMPAT_CONFIG_CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'IdentityCompatError'
  }
}

/** Validate an authenticated wire projection before it becomes local authority. */
export function parseIdentityCompatProjection(value: unknown, expectedUserId: string): IdentityCompatProjection {
  const fail = (): never => {
    throw new IdentityCompatError('COMPAT_AUTHORITY_UNAVAILABLE', 'missing or invalid identity compatibility authority')
  }
  if (!value || typeof value !== 'object') return fail()
  const raw = value as Partial<IdentityCompatProjection>
  if (raw.schema !== 1 || raw.userId !== expectedUserId || !/^[1-9][0-9]*$/.test(expectedUserId) || !Array.isArray(raw.profiles)) return fail()
  const ids = new Set<string>()
  const profiles = new Set<string>()
  for (const entry of raw.profiles) {
    if (!entry || typeof entry !== 'object' || !['ready', 'unavailable'].includes(entry.readiness)) return fail()
    const p = entry.profile
    if (!p || typeof p !== 'object') return fail()
    for (const id of [p.profileId, p.legacyAgentId, p.canonicalAgentId, p.localSkillStorageId]) {
      if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) return fail()
    }
    if (typeof p.localPersonaPath !== 'string' || !p.localPersonaPath.startsWith('agents/')) return fail()
    if (p.localPersonaPath.includes('\\') || p.localPersonaPath.split('/').some((part: string) => !part || part === '.' || part === '..')) return fail()
    if (p.legacyAgentId === p.canonicalAgentId || profiles.has(p.profileId) || ids.has(p.legacyAgentId) || ids.has(p.canonicalAgentId)) return fail()
    profiles.add(p.profileId)
    ids.add(p.legacyAgentId)
    ids.add(p.canonicalAgentId)
  }
  return raw as IdentityCompatProjection
}

/** Pure identity semantics only. Never constructs or rewrites transport/durable keys. */
export function resolveIdentityCompat(requestedId: string, projection: IdentityCompatProjection): IdentityCompatResolution {
  const entry = projection.profiles.find(({ profile }) => profile.legacyAgentId === requestedId || profile.canonicalAgentId === requestedId)
  if (!entry) return { requestedId, executionAgentId: requestedId, status: 'no-registration' }
  return {
    requestedId,
    executionAgentId: entry.profile.canonicalAgentId,
    profile: entry.profile,
    status: entry.readiness === 'ready' ? 'registered-ready' : 'registered-unavailable',
  }
}

export function assertIdentityCompatReady(resolution: IdentityCompatResolution): void {
  if (resolution.status === 'registered-unavailable') {
    throw new IdentityCompatError('COMPAT_NOT_READY', `registered agent '${resolution.executionAgentId}' is not ready`)
  }
}

/** Semantic comparison AFTER raw ownership/binding validation; not an authorization grant. */
export function identityCompatAgentIdsEqual(left: string, right: string, projection: IdentityCompatProjection): boolean {
  return resolveIdentityCompat(left, projection).executionAgentId === resolveIdentityCompat(right, projection).executionAgentId
}
