import { getAuthorityModelCapabilities } from './staticKeyModels.js'

export const BOX_NATIVE_CONTEXT_OWNER = 'box-native-v1'
export const BOX_NATIVE_CONTEXT_MODEL = 'box-api-claude-opus-5-5'

/**
 * The signed descriptor says the Box inner CLI owns model context for this
 * main-loop turn. Aux, idle/compact, and any other query source do not inherit.
 * A missing or non-matching descriptor keeps the caller's original policy.
 */
export function boxNativeRemoteContextOwnsHistory(input: {
  model: string | undefined
  querySource: string | undefined
}): boolean {
  const source = input.querySource ?? ''
  if (
    source === 'compact' ||
    source === 'session_memory' ||
    source.startsWith('agent:') ||
    source.includes('idle')
  ) {
    return false
  }
  if (source !== 'sdk' && !source.startsWith('repl_main_thread')) return false
  if (!input.model || input.model.trim().toLowerCase() !== BOX_NATIVE_CONTEXT_MODEL) {
    return false
  }
  const authority = getAuthorityModelCapabilities(input.model)
  if (!authority || authority.canonicalModel !== BOX_NATIVE_CONTEXT_MODEL) return false
  return authority.contextOwner === BOX_NATIVE_CONTEXT_OWNER
}
