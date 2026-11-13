/** Safe platform tools for a user-requested no-write advisor turn. Unknown tools
 * stay unavailable; this list is shared by native engines and the MCP handler. */
export const ADVISOR_READ_ONLY_MCP_TOOLS = [
  'skill_list', 'skill_search', 'skill_view', 'list_reminders',
  'task_list', 'task_get', 'project_search', 'consult_advisor',
  'oc_grep', 'oc_glob', 'present_options',
] as const

export function isAdvisorReadOnlyMcpTool(name: string): boolean {
  return (ADVISOR_READ_ONLY_MCP_TOOLS as readonly string[]).includes(name)
}

export function filterAdvisorReadOnlyMcpTools<T extends { name: string }>(
  tools: readonly T[], readOnly: boolean,
): T[] {
  return tools.filter((tool) => !readOnly || isAdvisorReadOnlyMcpTool(tool.name))
}
