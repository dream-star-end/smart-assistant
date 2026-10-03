import { getAuthorityModelCapabilities } from './staticKeyModels.js'

const MODEL_EXECUTION_DESCRIPTOR_ENV = 'OC_MODEL_EXECUTION_DESCRIPTOR'

/** Persistent deferred-tool announcement for a signed exact Box model.
 *  Fresh turns must announce too, so this does not consult live-history ownership. */
export function isTrustedBoxDeferredAnnouncement(
  model: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!model) return false
  return getAuthorityModelCapabilities(model, env)?.contextOwner === 'box-native-v1'
}

/** Record has no per-message model. Trust only this process's signed descriptor,
 *  asked back through the same exact-model authority check. */
export function processTrustsBoxDeferredAnnouncement(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[MODEL_EXECUTION_DESCRIPTOR_ENV]
  if (!raw) return false
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    getAuthorityModelCapabilities('\0', env)
    return false
  }
  const canonical =
    value && typeof value === 'object'
      ? (value as { canonicalModel?: unknown }).canonicalModel
      : undefined
  if (typeof canonical !== 'string') {
    getAuthorityModelCapabilities('\0', env)
    return false
  }
  return isTrustedBoxDeferredAnnouncement(canonical, env)
}
