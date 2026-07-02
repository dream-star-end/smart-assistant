import type { AgentDef } from '@openclaude/storage'
import { findRouteProviderForModel } from '@openclaude/protocol'

/**
 * Pure routing helper: given an inbound model id and requested agent id,
 * decide which agent should actually handle the request.
 *
 * M1a(codex 复活 + engine registry):底座选择不再由 agent 承载 —— engine 由
 * `engine/registry.ts` 的 resolveEngine 按 **model** 判定(gpt-5.5 → 'codex',
 * 其余 → 'ccb'),在 sessionManager.getOrCreate 单点收口。因此本 helper 不再
 * 把 gpt-* 路由到固定 id='codex' 的专属 agent(旧 v3 设计:provider 决定
 * runner → 必须换 agent),也不再 fail-closed 拒绝 gpt-*:任何 agent 都能以
 * gpt-5.5 跑 codex 底座,persona/skills/记忆随 agent 保持不变。
 *
 * Rules:
 *
 *   (a) 已知模型家族(gpt-5.5 / claude-* / deepseek-* / minimax / ark[glm])→
 *       requested agent 存在则用之,否则回落 default(或首个)agent。
 *   (b) Unknown model family or model undefined → pass through.
 *
 * 入站模型合法性(白名单)由 server.ts ALLOWED_INBOUND_MODELS 在调用前收口;
 * agent.model 绕过入站白名单的口子由 resolveExecutionModel 收口 —— 本 helper
 * 只回答"哪个 agent",不做模型准入。
 */

export type InferAgentResult =
  | { agentId: string }
  | { error: 'no_compatible_agent'; reason: string }

function isGptModel(model: string): boolean {
  return /^gpt-/.test(model)
}

function isClaudeModel(model: string): boolean {
  return /^claude-/.test(model)
}

function isKnownFamilyModel(model: string): boolean {
  // 静态 key 文本 provider(deepseek/minimax/ark[glm])判定走 @openclaude/protocol
  // 注册表 matchesRoute(deepseek 大小写敏感前缀、minimax/ark 精确),新增 provider
  // 零改本处。gpt-* 自 M1a 起同为一等公民(engine 判定在 registry,不在这里)。
  return isGptModel(model) || isClaudeModel(model) || findRouteProviderForModel(model) !== undefined
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

  // (a) known families — route to the requested agent when it exists, else the
  //     default (or first) agent. Engine 选择在 sessionManager.getOrCreate 经
  //     resolveEngine 按 model 判定,与 agent 无关。
  if (isKnownFamilyModel(model)) {
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

  // (b) Unknown model family — pass through. sessionManager / provider layer
  // will surface an error if the model id is genuinely invalid.
  return { agentId: requestedAgentId }
}
