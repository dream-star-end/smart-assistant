import type { AgentDef } from '@openclaude/storage'

/**
 * Pure routing helper: given an inbound model id and requested agent id,
 * decide which agent should actually handle the request.
 *
 * Two cases drive the rerouting:
 *   1) Model family demands a specific provider. `gpt-*` requires a
 *      codex-native agent; `claude-*` and `deepseek-*` require a non-codex
 *      agent.
 *   2) Frontend picks the model independently of the agent (modelPicker
 *      lives outside the agent menu). When the user changes model without
 *      explicitly switching agents, requestedAgentId equals defaultAgentId,
 *      and the gateway has to pick the right backend.
 *
 * Rules (fail-closed — never silently fall back):
 *
 *   (a) model starts with `gpt-` → MUST use the agent with the canonical
 *       id `codex` (not "first agent with provider=codex-native" — fixed
 *       id keeps user-visible attribution stable and prevents agents.yaml
 *       drift from breaking routing).
 *   (b) Explicit non-codex agent picked + gpt-* model → error 'mismatch'.
 *   (c) Default agent picked + gpt-* model → route to id='codex'. If that
 *       agent is absent or not codex-native → error 'no_codex_agent'.
 *   (d) claude-* / deepseek-* model + any codex-native/unknown requested agent → route
 *       back to a compatible non-codex agent. This covers the model-picker
 *       flow where the browser session remains on agentId='codex' after a
 *       previous GPT turn, but the user now selected Claude/DeepSeek/MiniMax.
 *   (e) Unknown model family or model undefined → pass through.
 *
 * NOTE: an unknown requestedAgentId (not in agents[]) is treated as
 * pass-through only for model families that do not need a provider override.
 * For known cross-provider families (`gpt-*`, `claude-*`, `deepseek-*`, `MiniMax-M3`) the
 * model picker is authoritative and this helper routes to the compatible
 * backend.
 */

export type InferAgentResult =
  | { agentId: string }
  | { error: 'no_codex_agent' | 'no_compatible_agent' | 'mismatch'; reason: string }

function isGptModel(model: string): boolean {
  return /^gpt-/.test(model)
}

function isClaudeModel(model: string): boolean {
  return /^claude-/.test(model)
}

function isDeepseekModel(model: string): boolean {
  return /^deepseek-/.test(model)
}

function isMiniMaxModel(model: string): boolean {
  return model.toLowerCase() === 'minimax-m3'
}

function isNonCodexModel(model: string): boolean {
  return isClaudeModel(model) || isDeepseekModel(model) || isMiniMaxModel(model)
}

function isCodexNative(agent: AgentDef | undefined): boolean {
  return agent?.provider === 'codex-native'
}

function findNonCodexAgent(args: {
  agents: AgentDef[]
  defaultAgentId: string
}): AgentDef | undefined {
  const defaultAgent = args.agents.find((a) => a.id === args.defaultAgentId)
  if (defaultAgent && !isCodexNative(defaultAgent)) return defaultAgent
  return args.agents.find((a) => !isCodexNative(a))
}

export function inferAgentForModel(args: {
  model: string | undefined
  requestedAgentId: string
  defaultAgentId: string
  agents: AgentDef[]
}): InferAgentResult {
  const { model, requestedAgentId, defaultAgentId, agents } = args

  if (!model) {
    return { agentId: requestedAgentId }
  }

  const requestedAgent = agents.find((a) => a.id === requestedAgentId)
  const requestedIsCodexNative = isCodexNative(requestedAgent)
  const isExplicitAgent = requestedAgentId !== defaultAgentId

  if (isGptModel(model)) {
    // (b) explicit non-codex agent + gpt model → mismatch
    // Only reportable when the agent is resolvable; unknown agentId falls
    // through (downstream will reject the unknown id anyway).
    if (isExplicitAgent && requestedAgent && !requestedIsCodexNative) {
      return {
        error: 'mismatch',
        reason: `agent '${requestedAgentId}' provider='${requestedAgent.provider ?? '<unset>'}' cannot serve gpt-* model '${model}'`,
      }
    }
    // (a) + (c) need agent id='codex' with provider=codex-native
    const codexAgent = agents.find((a) => a.id === 'codex')
    if (!codexAgent || codexAgent.provider !== 'codex-native') {
      return {
        error: 'no_codex_agent',
        reason: codexAgent
          ? `agent 'codex' has provider='${codexAgent.provider ?? '<unset>'}' (expected codex-native)`
          : `no agent with id='codex' configured`,
      }
    }
    return { agentId: 'codex' }
  }

  if (isNonCodexModel(model)) {
    if (requestedAgent && !requestedIsCodexNative) {
      return { agentId: requestedAgentId }
    }
    const compatibleAgent = findNonCodexAgent({ agents, defaultAgentId })
    if (!compatibleAgent) {
      return {
        error: 'no_compatible_agent',
        reason: `no non-codex agent configured for model '${model}'`,
      }
    }
    return { agentId: compatibleAgent.id }
  }

  // Unknown model family — pass through. sessionManager / provider layer
  // will surface an error if the model id is genuinely invalid.
  return { agentId: requestedAgentId }
}
