/**
 * Pure projection of CCB availableMcpTools from configured servers + the
 * built-in openclaude-memory launch result.
 *
 * Eval/train hidden-name filtering applies only to the built-in platform
 * set (PLATFORM_MCP_TOOL_NAMES). User-configured MCP tools are kept as-is
 * even when they share a name with a hidden platform tool.
 *
 * Kept I/O-free so unit tests and the deploy-gate can execute the same
 * function subprocessRunner uses before buildPromptContext. Do not import
 * mcp-memory here: gateway tsconfig has no project ref to it, and a relative
 * `../../mcp-memory/src/` specifier would break container precompile.
 */
import { PLATFORM_MCP_TOOL_NAMES } from './promptSlots.js'

export type CcbMcpAvailabilityInput = {
  configuredTools: readonly string[]
  mcpLaunch: unknown | null
  skillEvalMode?: boolean
  skillTrainRunId?: string
}

/**
 * Platform MCP names that skill-eval ListTools hides (CallTool also hard-refuses).
 * Must stay in lockstep with mcp-memory `SKILL_EVAL_BLOCKED_TOOL_NAMES`; the
 * subprocessRunner availability test parses that source file and asserts equality.
 */
export const CCB_SKILL_EVAL_HIDDEN_PLATFORM_TOOLS = [
  'skill_save',
  'skill_delete',
  'create_reminder',
  'update_reminder',
  'delete_reminder',
  'send_to_agent',
  'delegate_task',
  'delegate_tasks',
  'delegate_wait',
  'request_review',
  'task_create',
  'task_update',
  'task_comment',
  'task_list',
  'task_get',
  'task_approve',
  'ask_user',
  'present_options',
] as const

const SKILL_TRAIN_HIDDEN_PLATFORM_TOOLS = ['skill_save', 'skill_delete'] as const

export function projectCcbMcpAvailability(input: CcbMcpAvailabilityInput): string[] {
  const platform = new Set<string>()
  if (input.mcpLaunch != null) {
    for (const name of PLATFORM_MCP_TOOL_NAMES) platform.add(name)
    if (input.skillEvalMode) {
      for (const name of CCB_SKILL_EVAL_HIDDEN_PLATFORM_TOOLS) platform.delete(name)
    }
    if (input.skillTrainRunId) {
      for (const name of SKILL_TRAIN_HIDDEN_PLATFORM_TOOLS) platform.delete(name)
    }
  }
  const names = new Set<string>(input.configuredTools)
  for (const name of platform) names.add(name)
  return [...names].sort()
}
