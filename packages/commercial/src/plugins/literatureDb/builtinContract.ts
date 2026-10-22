import { canonicalSha256Hex } from '../../connectors/spec/canonical.js'
import { type ManagedBrowserPluginContractV1, compileRuntimePluginArtifact } from '../contracts.js'
import { LITERATURE_PLUGIN_ARTIFACT, LITERATURE_PLUGIN_ARTIFACT_HASH, LITERATURE_PLUGIN_SLUG } from './builtinArtifact.js'

export const COMPILED_LITERATURE_PLUGIN = compileRuntimePluginArtifact(LITERATURE_PLUGIN_ARTIFACT)
if (COMPILED_LITERATURE_PLUGIN.pluginType !== 'managed-browser')
  throw new Error('Literature Plugin subtype mismatch')
export const LITERATURE_PLUGIN_CONTRACT: ManagedBrowserPluginContractV1 =
  COMPILED_LITERATURE_PLUGIN.execContract
const EXEC_HASH = COMPILED_LITERATURE_PLUGIN.execContractHash
/** Rehash actual data, never trust the contract's self-reported identity fields. */
export function isLiteratureHttpContract(input: ManagedBrowserPluginContractV1): boolean {
  try {
    return (
      input.artifactHash === LITERATURE_PLUGIN_ARTIFACT_HASH &&
      canonicalSha256Hex(input) === EXEC_HASH
    )
  } catch {
    return false
  }
}
export function isLiteratureHttpIdentity(input: {
  slug: string
  artifactHash: string
  execContractHash: string
  contract: ManagedBrowserPluginContractV1
}): boolean {
  return (
    input.slug === LITERATURE_PLUGIN_CONTRACT.id &&
    input.artifactHash === LITERATURE_PLUGIN_ARTIFACT_HASH &&
    input.execContractHash === EXEC_HASH &&
    isLiteratureHttpContract(input.contract)
  )
}

export function isOfficialLiteraturePluginIdentity(input: {
  slug: string
  pluginType: string | null
  artifactHash: string
  execContractHash: string | null
  reviewSource: string | null
}): boolean {
  return (
    input.slug === LITERATURE_PLUGIN_SLUG &&
    input.pluginType === 'managed-browser' &&
    input.artifactHash === COMPILED_LITERATURE_PLUGIN.artifactHash &&
    input.execContractHash === EXEC_HASH &&
    input.reviewSource === 'platform'
  )
}
