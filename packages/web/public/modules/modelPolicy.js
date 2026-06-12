// OpenClaude — frontend model/agent compatibility policy

export function isGptModel(modelId) {
  return /^gpt-/i.test(modelId || '')
}

export function isCodexNativeAgent(agent) {
  return agent?.provider === 'codex-native' || agent?.id === 'codex'
}

function findAgent(agentsList, agentId) {
  if (!agentId) return null
  return (agentsList || []).find((a) => a?.id === agentId) || null
}

/**
 * Decide whether the user's global default_model should be sent as an explicit
 * frame.model for the current single-agent turn.
 *
 * Backend routing intentionally rejects explicit non-codex agent + gpt-*:
 * silently rerouting `scientist + gpt-5.5` to Codex would drop the scientist
 * persona/skills. When a user selects an explicit non-codex specialist, ignore
 * a stale GPT global preference and let the agent run with its configured model.
 */
export function getSingleAgentModelOverride({
  userPrefs,
  agentId,
  defaultAgentId,
  agentsList,
} = {}) {
  const prefModel = userPrefs?.default_model
  if (typeof prefModel !== 'string' || !prefModel) return undefined

  const agent = findAgent(agentsList, agentId)
  const isExplicitAgent = Boolean(agentId && defaultAgentId && agentId !== defaultAgentId)
  if (isExplicitAgent && agent && !isCodexNativeAgent(agent) && isGptModel(prefModel)) {
    return undefined
  }
  return prefModel
}

export function getEffectiveSingleAgentModel({
  userPrefs,
  agentId,
  defaultAgentId,
  agentsList,
} = {}) {
  const override = getSingleAgentModelOverride({
    userPrefs,
    agentId,
    defaultAgentId,
    agentsList,
  })
  if (override) return override
  return findAgent(agentsList, agentId)?.model || ''
}
