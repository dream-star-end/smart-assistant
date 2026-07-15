/**
 * Marketplace storage keeps the historical `connector` discriminator for wire/DB
 * compatibility. Product surfaces expose those rows as declarative HTTP plugins.
 */
export type MarketplaceStorageKind = 'skill' | 'agent' | 'connector'

export type MarketplaceArtifactKind = 'skill' | 'agent' | 'plugin'

export type MarketplacePluginType = 'declarative-http'

/**
 * Public Agent composition vocabulary. A Skill contributes reusable guidance;
 * a Plugin contributes a declarative external-system tool surface.
 */
export type MarketplaceCapabilityKind = 'skill' | 'plugin'

/** Historical DB/wire storage keeps `connector`; public manifests use `plugin`. */
export type MarketplaceCapabilityStorageKind = 'skill' | 'connector'

export interface MarketplaceCapabilityRef {
  kind: MarketplaceCapabilityKind
  slug: string
  optional: boolean
}

export type MarketplaceCapabilityStatus = 'ready' | 'missing' | 'revoked' | 'needs_authorization'

export type MarketplaceCapabilityReadinessItem = MarketplaceCapabilityRef & {
  installed: boolean
  bound: boolean
  status: MarketplaceCapabilityStatus
  /** True when atomically reinstalling the Agent can restore this requirement. */
  repairable?: boolean
}

export interface MarketplaceCapabilityReadiness {
  installed: boolean
  ready: boolean
  requirements: MarketplaceCapabilityReadinessItem[]
  needsAuthorization: string[]
}

/** Shared portion of browser/internal atomic-install responses. */
export interface MarketplaceCapabilityInstallOutcome {
  installedCapabilities: MarketplaceCapabilityRef[]
  skippedOptional: Array<MarketplaceCapabilityRef & { reason: 'unavailable' }>
  needsAuthorization: string[]
  ready: boolean
}

export function marketplaceCapabilityStorageKind(
  kind: MarketplaceCapabilityKind,
): MarketplaceCapabilityStorageKind {
  return kind === 'plugin' ? 'connector' : 'skill'
}

export function marketplaceCapabilityKind(
  kind: MarketplaceCapabilityStorageKind,
): MarketplaceCapabilityKind {
  return kind === 'connector' ? 'plugin' : 'skill'
}

export type MarketplaceArtifactCompatibility =
  | { artifactKind: 'skill' }
  | { artifactKind: 'agent' }
  | { artifactKind: 'plugin'; pluginType: MarketplacePluginType }

/** Additive public projection; never changes the legacy `kind` field. */
export function marketplaceArtifactCompatibility(
  kind: MarketplaceStorageKind,
): MarketplaceArtifactCompatibility {
  if (kind === 'connector') {
    return { artifactKind: 'plugin', pluginType: 'declarative-http' }
  }
  return { artifactKind: kind }
}

/** Public review vocabulary. `manual` deliberately hides the DB's historical `human` name. */
export type MarketplaceReviewSource = 'ai' | 'manual' | 'platform'

export function marketplaceReviewSource(source: unknown): MarketplaceReviewSource | null {
  if (source === 'ai' || source === 'platform') return source
  if (source === 'human') return 'manual'
  return null
}
