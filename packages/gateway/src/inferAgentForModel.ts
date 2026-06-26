import type { AgentDef } from '@openclaude/storage'
import { findRouteProviderForModel } from '@openclaude/protocol'

/**
 * Pure routing helper: given an inbound model id and requested agent id,
 * decide which agent should actually handle the request.
 *
 * v5 is a ccb-only deployment (Claude + domain static-key models
 * glm/deepseek/minimax). There is **no codex (gpt-*) backend** — gpt models
 * are rejected fail-closed here so a stray model-picker selection never reaches
 * the runner layer.
 *
 * Rules (fail-closed — never silently fall back):
 *
 *   (a) model starts with `gpt-` → error 'gpt_unsupported'. v5 has no
 *       codex-native runner; this is the authoritative rejection point.
 *   (b) claude-* / deepseek-* / minimax / ark(glm) model → route to the
 *       requested agent when it exists, otherwise to the default (or first)
 *       agent. All v5 agents are ccb, so any of them can serve these models.
 *   (c) Unknown model family or model undefined → pass through.
 */

export type InferAgentResult =
  | { agentId: string }
  | { error: 'gpt_unsupported' | 'no_compatible_agent'; reason: string }

function isGptModel(model: string): boolean {
  return /^gpt-/.test(model)
}

function isClaudeModel(model: string): boolean {
  return /^claude-/.test(model)
}

function isSupportedNonGptModel(model: string): boolean {
  // 静态 key 文本 provider(deepseek/minimax/ark[glm])一律走 claude-subscription
  // 类 agent。判定走 @openclaude/protocol 注册表 matchesRoute(deepseek 大小写敏感前缀、
  // minimax/ark 精确),新增 provider 零改本处。
  return isClaudeModel(model) || findRouteProviderForModel(model) !== undefined
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

  // (a) gpt-* / codex models are not supported on this ccb-only deployment.
  if (isGptModel(model)) {
    return {
      error: 'gpt_unsupported',
      reason: `gpt model '${model}' is not supported on this ccb-only deployment`,
    }
  }

  // (b) claude / deepseek / minimax / ark(glm) — route to the requested agent
  //     when it exists, else the default (or first) agent.
  if (isSupportedNonGptModel(model)) {
    const requestedAgent = agents.find((a) => a.id === requestedAgentId)
    if (requestedAgent) {
      return { agentId: requestedAgentId }
    }
    const fallback = agents.find((a) => a.id === defaultAgentId) ?? agents[0]
    if (!fallback) {
      return {
        error: 'no_compatible_agent',
        reason: `no agent configured for model '${model}'`,
      }
    }
    return { agentId: fallback.id }
  }

  // (c) Unknown model family — pass through. sessionManager / provider layer
  // will surface an error if the model id is genuinely invalid.
  return { agentId: requestedAgentId }
}
