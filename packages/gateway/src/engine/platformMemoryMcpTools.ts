/**
 * Memory-MCP tools advertised in the prompt of the platform-hosted CLI engines
 * (Grok, Antigravity, ZCode). One list for all three: each engine used to keep
 * its own copy, and ZCode's missed `present_task_approval` when e87e3723a added
 * it to the others (OCV5-452).
 *
 * Every tool in mcp-memory's MEMORY_MCP_TOOL_NAMES belongs to exactly one of the
 * two lists below; platformMemoryMcpTools.test.ts fails when a new tool is in
 * neither, so adding a tool forces a decision here.
 */
export const PLATFORM_MEMORY_MCP_TOOLS = [
  'skill_search',
  'skill_list',
  'skill_view',
  'skill_save',
  'skill_delete',
  'create_reminder',
  'list_reminders',
  'update_reminder',
  'delete_reminder',
  'send_to_agent',
  'delegate_task',
  'delegate_tasks',
  'request_review',
  'consult_advisor',
  'task_create',
  'task_update',
  'task_comment',
  'task_list',
  'task_get',
  'task_approve',
  'present_task_approval',
] as const

/**
 * Regular-session memory-MCP tools these engines' prompts do not advertise
 * (unchanged by OCV5-452). Train-only tools (MEMORY_MCP_TRAIN_ONLY_TOOL_NAMES)
 * are outside this contract.
 *
 * oc_bash / oc_grep / oc_glob stay registered: Antigravity's CLI lists every
 * MCP tool itself, and its preamble tells the model to call them. Grok and
 * ZCode already have native shell and search, so their prompts do not advertise
 * these three.
 */
export const PLATFORM_MEMORY_MCP_TOOLS_NOT_ADVERTISED = [
  'delegate_wait',
  'ask_user',
  'present_options',
  'project_search',
  'oc_bash',
  'oc_grep',
  'oc_glob',
] as const
