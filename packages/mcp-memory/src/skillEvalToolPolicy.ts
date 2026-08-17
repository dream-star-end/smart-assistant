import type { MemoryMcpToolName } from './toolNames.js'

/**
 * Skill-eval turns may inspect platform state, but must not persist control-plane
 * changes or escape into another agent session that lacks the eval fence.
 */
export const SKILL_EVAL_BLOCKED_TOOL_NAMES = [
  'skill_save',
  'skill_delete',
  'create_reminder',
  'update_reminder',
  'delete_reminder',
  'send_to_agent',
  'delegate_task',
  'delegate_tasks',
  'request_review',
  'ask_user',
] as const satisfies readonly MemoryMcpToolName[]

const blocked = new Set<string>(SKILL_EVAL_BLOCKED_TOOL_NAMES)

export function isSkillEvalBlockedTool(name: string): boolean {
  return blocked.has(name)
}

export function filterSkillEvalTools<T extends { name: string }>(
  tools: readonly T[],
  skillEvalMode: boolean,
): T[] {
  return skillEvalMode ? tools.filter((tool) => !isSkillEvalBlockedTool(tool.name)) : [...tools]
}
