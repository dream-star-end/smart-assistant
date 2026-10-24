/** Explicit subprocess/MCP routing after each engine applies its credential scrub. */
export function systemHelpEnvironment(contextFile: string | undefined, gatewayPort: number | undefined): Record<string, string> {
  if (!contextFile || !gatewayPort) return {}
  return { OPENCLAUDE_SYSTEM_HELP_CONTEXT_FILE: contextFile, OPENCLAUDE_GATEWAY_PORT: String(gatewayPort) }
}
