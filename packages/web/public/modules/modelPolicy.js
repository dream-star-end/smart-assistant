// OpenClaude — frontend model/agent compatibility policy

function findAgent(agentsList, agentId) {
  if (!agentId) return null
  return (agentsList || []).find((a) => a?.id === agentId) || null
}

/**
 * Decide whether the user's global default_model should be sent as an explicit
 * frame.model for the current single-agent turn.
 *
 * v5 ccb-only: gpt-* models are no longer offered (codex backend removed), so
 * the prior "explicit non-codex agent + stale gpt pref → drop" special-case is
 * gone. The user's default model (if any) is sent as-is.
 */
export function getSingleAgentModelOverride({ userPrefs } = {}) {
  const prefModel = userPrefs?.default_model
  if (typeof prefModel !== 'string' || !prefModel) return undefined
  return prefModel
}

export function getEffectiveSingleAgentModel({ userPrefs, agentId, agentsList } = {}) {
  const override = getSingleAgentModelOverride({ userPrefs })
  if (override) return override
  return findAgent(agentsList, agentId)?.model || ''
}
