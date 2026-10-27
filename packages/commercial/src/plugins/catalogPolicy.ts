import { ConnectorError } from '../connectors/errors.js'
import type { FlavorIdentity } from '../flavor/assertFlavor.js'

/** Product availability is independent of installs, signatures and user preferences. */
export const SELFHOST_PLUGIN_SLUGS = Object.freeze([
  'weibo', 'knowledge-planet', 'github', 'ths', 'literature-db',
] as const)
const selfhostPlugins: ReadonlySet<string> = new Set(SELFHOST_PLUGIN_SLUGS)

export function pluginAvailableForIdentity(identity: FlavorIdentity | undefined, slug: string): boolean {
  return identity?.status !== 'ok' || identity.flavor !== 'selfhost' || selfhostPlugins.has(slug)
}

let deploymentIdentity: FlavorIdentity | undefined

/** Called with boot-verified identity before seeding or registering any user surface. */
export function configurePluginCatalog(identity: FlavorIdentity): void {
  if (identity.status !== 'ok') return
  if (deploymentIdentity?.status === 'ok' && deploymentIdentity.flavor !== identity.flavor)
    throw new Error('Plugin catalog deployment identity cannot change during a process lifetime')
  deploymentIdentity = identity
}

export function isPluginAvailable(slug: string): boolean {
  return pluginAvailableForIdentity(deploymentIdentity, slug)
}

/** Includes kind so skills/agents with the same slug are unaffected. */
export function isMarketplaceArtifactAvailable(kind: string, slug: string): boolean {
  return kind !== 'connector' || isPluginAvailable(slug)
}

export function assertPluginAvailable(slug: string): void {
  if (!isPluginAvailable(slug)) throw new ConnectorError('PLUGIN_UNAVAILABLE', 'Plugin is unavailable in this product')
}

/** Null preserves the unrestricted catalog in other deployments. */
export function availablePluginSlugs(): readonly string[] | null {
  return deploymentIdentity?.status === 'ok' && deploymentIdentity.flavor === 'selfhost'
    ? SELFHOST_PLUGIN_SLUGS : null
}
