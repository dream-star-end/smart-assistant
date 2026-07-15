/**
 * Marketplace storage keeps the historical `connector` discriminator for wire/DB
 * compatibility. Product surfaces expose those rows as declarative HTTP plugins.
 */
export type MarketplaceStorageKind = 'skill' | 'agent' | 'connector'

export type MarketplaceArtifactKind = 'skill' | 'agent' | 'plugin'

export type MarketplacePluginType = 'declarative-http'

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
