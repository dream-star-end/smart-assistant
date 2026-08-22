/**
 * Live turn activity row: map engine working-detail (raw tool name + path /
 * command / args) to a short, stable Chinese action label.
 *
 * Cursor keepalive emits details like `StrReplace /abs/path` and
 * `Bash npx tsc`. Those must not appear in the conversation body. Tool result
 * cards keep their own headers/bodies; this mapper is display-only for the
 * typing/activity line.
 */

export const LIVE_ACTIVITY_FALLBACK = "执行操作";

export const LIVE_ACTIVITY_LABELS = [
  "执行 Shell",
  "更新任务",
  "读取文件",
  "写入文件",
  "搜索代码",
  "运行子任务",
  LIVE_ACTIVITY_FALLBACK,
] as const;

export type LiveActivityLabel = (typeof LIVE_ACTIVITY_LABELS)[number];

const LABEL_SET = new Set<string>(LIVE_ACTIVITY_LABELS);

/** Tool-name token (normalized) → category label. Unknown names fall back. */
const TOOL_ACTIVITY_LABEL: Record<string, LiveActivityLabel> = {
  bash: "执行 Shell",
  shell: "执行 Shell",
  awaitshell: "执行 Shell",
  await_shell: "执行 Shell",
  exec_command: "执行 Shell",
  powershell: "执行 Shell",
  run_terminal_command: "执行 Shell",
  run_terminal_cmd: "执行 Shell",

  todowrite: "更新任务",
  todo_write: "更新任务",
  taskupdate: "更新任务",
  task_update: "更新任务",
  task_comment: "更新任务",
  task_create: "更新任务",
  task_list: "更新任务",
  task_get: "更新任务",
  enterplanmode: "更新任务",
  enter_plan_mode: "更新任务",
  exitplanmode: "更新任务",
  exit_plan_mode: "更新任务",
  croncreate: "更新任务",
  cronlist: "更新任务",
  crondelete: "更新任务",

  read: "读取文件",
  read_file: "读取文件",
  hashline_read: "读取文件",
  readlints: "读取文件",
  read_lints: "读取文件",

  write: "写入文件",
  write_file: "写入文件",
  strreplace: "写入文件",
  str_replace: "写入文件",
  search_replace: "写入文件",
  hashline_edit: "写入文件",
  edit: "写入文件",
  delete: "写入文件",
  notebookedit: "写入文件",
  notebook_edit: "写入文件",
  editnotebook: "写入文件",
  edit_notebook: "写入文件",

  grep: "搜索代码",
  hashline_grep: "搜索代码",
  list_dir: "搜索代码",
  glob: "搜索代码",
  websearch: "搜索代码",
  web_search: "搜索代码",
  web_fetch: "搜索代码",
  search_tool: "搜索代码",
  mcpsearch: "搜索代码",
  skill_search: "搜索代码",
  skill_view: "搜索代码",
  skill_list: "搜索代码",
  semanticsearch: "搜索代码",
  semantic_search: "搜索代码",
  globfilesearch: "搜索代码",
  glob_file_search: "搜索代码",

  task: "运行子任务",
  spawn_subagent: "运行子任务",
  get_task_output: "运行子任务",
  get_command_or_subagent_output: "运行子任务",
  get_terminal_command_output: "运行子任务",
  kill_command_or_subagent: "运行子任务",
  kill_terminal_command: "运行子任务",
  agent: "运行子任务",
  delegate_task: "运行子任务",
  delegate_tasks: "运行子任务",
  send_to_agent: "运行子任务",
  taskoutput: "运行子任务",
  task_output: "运行子任务",
  taskstop: "运行子任务",
  task_stop: "运行子任务",
};

function normalizeToolToken(raw: string): string {
  let token = raw.trim();
  if (!token) return "";
  const mcpAt = token.toLowerCase().indexOf("mcp__");
  if (mcpAt >= 0) {
    const segs = token.slice(mcpAt + 5).split("__");
    token = segs.length >= 2 ? (segs[segs.length - 1] ?? token) : (segs[0] ?? token);
  } else if (/^codex:/i.test(token)) {
    token = token.slice(token.indexOf(":") + 1);
  }
  return token.replace(/-/g, "_").toLowerCase();
}

function labelForToken(token: string): LiveActivityLabel | null {
  const key = normalizeToolToken(token);
  if (!key) return null;
  return TOOL_ACTIVITY_LABEL[key] ?? null;
}

/** Map a bare tool name to a category label. Unknown names return null (unlike formatLiveActivityAction). */
export function mappedLiveActivityLabel(toolName: string): LiveActivityLabel | null {
  return labelForToken(toolName);
}

/**
 * Collapse a working-detail / progress hint to a category action label.
 * Empty input stays empty so the typing row can fall through to 「思考中」.
 */
export function formatLiveActivityAction(hint: string | undefined | null): string {
  const raw = String(hint ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) return "";

  for (const label of LIVE_ACTIVITY_LABELS) {
    if (raw === label || raw.startsWith(`${label} `)) return label;
  }
  if (LABEL_SET.has(raw)) return raw;
  if (raw.startsWith("子任务")) return "运行子任务";

  const parts = raw.split(" ");
  const first = parts[0] ?? "";
  const mapped = labelForToken(first);
  if (mapped) return mapped;

  // Cursor CallMcpTool / similar wrappers: try the next token as the real op.
  const wrapper = normalizeToolToken(first);
  if (
    (wrapper === "callmcptool" || wrapper === "call_mcp_tool" || wrapper === "getmcptools" || wrapper === "use_tool") &&
    parts.length > 1
  ) {
    return labelForToken(parts[1] ?? "") ?? LIVE_ACTIVITY_FALLBACK;
  }

  return LIVE_ACTIVITY_FALLBACK;
}
