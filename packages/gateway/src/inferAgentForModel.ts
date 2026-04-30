import type { AgentDef } from '@openclaude/storage'

/**
 * Pure routing helper: given an inbound model id and requested agent id,
 * decide which agent should actually handle the request.
 *
 * Two cases drive the rerouting:
 *   1) Model family demands a specific provider. `gpt-*` requires a
 *      codex-native agent; `claude-*` requires a non-codex agent.
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
 *   (b) Explicit agent picked AND model family doesn't match the agent's
 *       provider (e.g. claude-* model + codex agent, or gpt-* model +
 *       claude agent) → error 'mismatch'.
 *   (c) Default agent picked + gpt-* model → route to id='codex'. If that
 *       agent is absent or not codex-native → error 'no_codex_agent'.
 *   (d) Default agent picked + claude-* model → use requested as-is.
 *   (e) Unknown model family or model undefined → pass through.
 *
 * NOTE: an unknown requestedAgentId (not in agents[]) is treated as
 * pass-through here — sessionManager.submit() validates agent existence
 * downstream and produces its own error. This helper's job is family
 * compatibility, not existence.
 */

export type InferAgentResult =
  | { agentId: string }
  | { error: 'no_codex_agent' | 'mismatch'; reason: string }

function isGptModel(model: string): boolean {
  return /^gpt-/.test(model)
}

function isClaudeModel(model: string): boolean {
  return /^claude-/.test(model)
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
  const requestedIsCodexNative = requestedAgent?.provider === 'codex-native'
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

  if (isClaudeModel(model)) {
    // explicit codex agent + claude model → mismatch
    if (isExplicitAgent && requestedIsCodexNative) {
      return {
        error: 'mismatch',
        reason: `agent '${requestedAgentId}' is codex-native; cannot serve claude-* model '${model}'`,
      }
    }
    return { agentId: requestedAgentId }
  }

  // Unknown model family — pass through. sessionManager / provider layer
  // will surface an error if the model id is genuinely invalid.
  return { agentId: requestedAgentId }
}
