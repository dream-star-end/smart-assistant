export function _codexMemoryTurnEnv(
  agentId: string,
  sessionKey: string,
  routing?: { gatewayPort?: number; contextFile?: string | null; systemHelpContextFile?: string },
): Record<string, string> {
  return {
    OC_AGENT_ID: agentId,
    OC_SESSION_KEY: sessionKey,
    ...(routing?.systemHelpContextFile ? { OPENCLAUDE_SYSTEM_HELP_CONTEXT_FILE: routing.systemHelpContextFile } : {}),
    ...(routing?.gatewayPort ? { OPENCLAUDE_GATEWAY_PORT: String(routing.gatewayPort) } : {}),
    ...(routing?.contextFile ? { OPENCLAUDE_DELEGATE_CONTEXT_FILE: routing.contextFile } : {}),
  }
}
