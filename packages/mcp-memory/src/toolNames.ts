// openclaude-memory MCP server 对模型暴露的工具名单一权威表。
// 零依赖纯数据:index.ts 的 TOOLS 声明与 web-react 的 MCP_OP_META 锁步测试都从这里取名,
// 新增工具漏改任何一侧都会被测试拦下(前端漏登记会渲染成「记忆: <英文>」兜底标签)。

/** 常规会话注册的工具(index.ts TOOLS 声明顺序)。 */
export const MEMORY_MCP_TOOL_NAMES = [
  'skill_list',
  'skill_search',
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
] as const;

/** 技能训练会话(OPENCLAUDE_SKILL_TRAIN_RUN_ID)条件注册,替换 skill_save/skill_delete。 */
export const MEMORY_MCP_TRAIN_ONLY_TOOL_NAMES = ['skill_propose'] as const;

export type MemoryMcpToolName =
  | (typeof MEMORY_MCP_TOOL_NAMES)[number]
  | (typeof MEMORY_MCP_TRAIN_ONLY_TOOL_NAMES)[number];
