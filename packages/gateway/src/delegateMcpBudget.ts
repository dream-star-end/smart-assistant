/** Keep delegate polling inside the engine's tools/call window. The budget
 * includes job start and HTTP polling; leave time to hand off and return. */
export const DELEGATE_MCP_REPLY_MARGIN_MS = 15_000
export const GROK_MCP_TOOL_TIMEOUT_SEC = 600
const TURN_MAX_MS = 12 * 60 * 60_000
const UNKNOWN_MCP_TOOL_TIMEOUT_MS = 60_000

export function delegateMcpBudgetEnvironment(
  toolTimeoutMs = UNKNOWN_MCP_TOOL_TIMEOUT_MS,
): Record<string, string> {
  return {
    OPENCLAUDE_DELEGATE_MCP_BUDGET_MS: String(
      Math.max(1, Math.min(TURN_MAX_MS, toolTimeoutMs) - DELEGATE_MCP_REPLY_MARGIN_MS),
    ),
  }
}

/** Match CCB getMcpToolTimeoutMs; this changes only the delegate budget. */
export function ccbDelegateMcpBudgetEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const toolTimeoutMs = Number.parseInt(env.MCP_TOOL_TIMEOUT || '', 10) || 100_000_000
  return delegateMcpBudgetEnvironment(toolTimeoutMs)
}
