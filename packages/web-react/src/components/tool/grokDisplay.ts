/**
 * Display-side Grok tool-card mapping. Keep in lockstep with
 * packages/gateway/src/engine/grokToolNormalize.ts — gateway owns new turns;
 * this file repairs historical tape rows that still carry Grok native names
 * and Vec<u8> JSON envelopes.
 */
import type { DisplayTool, ToolInput, ToolLike } from "./format";

const GROK_PRODUCT_NAMES: Record<string, string> = {
  run_terminal_command: "Bash",
  run_terminal_cmd: "Bash",
  bash: "Bash",
  powershell: "Bash",
  read_file: "Read",
  hashline_read: "Read",
  search_replace: "Edit",
  hashline_edit: "Edit",
  str_replace: "Edit",
  write_file: "Write",
  grep: "Grep",
  hashline_grep: "Grep",
  grep_search: "Grep",
  list_dir: "Glob",
  glob: "Glob",
  web_search: "WebSearch",
  web_fetch: "WebFetch",
  search_tool: "McpSearch",
  todo_write: "TodoWrite",
  ask_user_question: "AskUserQuestion",
  enter_plan_mode: "EnterPlanMode",
  exit_plan_mode: "ExitPlanMode",
  spawn_subagent: "Task",
  task: "Task",
  get_task_output: "TaskOutput",
  get_command_or_subagent_output: "TaskOutput",
  get_terminal_command_output: "TaskOutput",
  kill_command_or_subagent: "TaskStop",
  kill_terminal_command: "TaskStop",
  skill: "Skill",
  scheduler_create: "CronCreate",
  scheduler_delete: "CronDelete",
  scheduler_list: "CronList",
};

const MAX_BYTE_DECODE = 2 * 1024 * 1024;

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function grokNativeKey(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.startsWith("mcp__")) return trimmed.toLowerCase();
  const colon = trimmed.lastIndexOf(":");
  const bare = colon >= 0 ? trimmed.slice(colon + 1) : trimmed;
  return bare.replace(/-/g, "_").toLowerCase();
}

function pickString(input: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

export function decodeGrokUtf8Bytes(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  if (value.length === 0) return "";
  if (value.length > MAX_BYTE_DECODE) return null;
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i += 1) {
    const n = value[i];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 255) return null;
    bytes[i] = n;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function stringifyFallback(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function textField(value: unknown): string | null {
  if (typeof value === "string") return value;
  return decodeGrokUtf8Bytes(value);
}

function grokMcpOutputText(obj: Record<string, unknown>): string | null {
  const tagged = typeof obj.type === "string" && obj.type.toLowerCase() === "mcp";
  const inner = obj.output;
  const envelope = recordOf(inner);
  if (!tagged && !envelope) return null;
  if (envelope) {
    const ok = envelope.OkayOutput ?? envelope.okay_output ?? envelope.ErrorOutput ?? envelope.error_output;
    if (typeof ok === "string" && ok) return ok;
    const nested = textField(envelope.text) ?? textField(envelope.content);
    if (nested !== null) return nested;
  }
  if (typeof inner === "string" && inner) return inner;
  return tagged ? stringifyFallback(inner ?? obj) : null;
}

function unwrapUseTool(input: unknown): { name: string; input: unknown } | null {
  const obj = recordOf(input);
  if (!obj) return null;
  const qualified = pickString(obj, "tool_name", "name");
  if (!qualified || (!qualified.includes("__") && !qualified.startsWith("mcp__"))) return null;
  const inner = obj.tool_input ?? obj.arguments ?? obj.input ?? obj.toolInput;
  return { name: qualified, input: inner ?? {} };
}

export function grokProductToolOutput(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("{") && trimmed.length < 4_000_000) {
      try {
        return grokProductToolOutput(JSON.parse(trimmed) as unknown);
      } catch {
        return raw;
      }
    }
    return raw;
  }
  if (Array.isArray(raw)) return stringifyFallback(raw);
  const obj = recordOf(raw);
  if (!obj) return stringifyFallback(raw);

  const mcpOutput = grokMcpOutputText(obj);
  if (mcpOutput !== null) return mcpOutput;

  const stdout = textField(obj.output) ?? textField(obj.stdout);
  const stderr = textField(obj.stderr);
  if (stdout !== null || stderr !== null) {
    const parts = [stdout, stderr].filter((part): part is string => part !== null && part !== "");
    let text = parts.join(parts[0]?.endsWith("\n") ? "" : "\n");
    if (typeof obj.exit_code === "number" && obj.exit_code !== 0) {
      text = `${text}${text && !text.endsWith("\n") ? "\n" : ""}exit ${obj.exit_code}`;
    }
    return text;
  }

  for (const key of ["content", "text", "tool_output_for_prompt", "summary_for_prompt", "markdown", "body"] as const) {
    const text = textField(obj[key]);
    if (text) return text;
  }
  // Unknown extra JSON fields are not user-visible body. Commercial ToolCard
  // keeps them off the card; exact bytes stay on the tape / output string.
  return "";
}

export function grokProductToolName(nativeName: string, input?: unknown): string {
  const trimmed = nativeName.trim();
  if (trimmed.startsWith("mcp__")) return trimmed;
  const sep = trimmed.lastIndexOf("__");
  if (sep > 0) {
    const server = trimmed.slice(0, sep);
    const tool = trimmed.slice(sep + 2);
    if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(server) && /^[A-Za-z0-9_]+$/.test(tool)) {
      return `mcp__${server}__${tool}`;
    }
  }
  const key = grokNativeKey(nativeName);
  if (key.startsWith("mcp__")) return nativeName;
  if (key === "use_tool" || key === "call_mcp_tool" || key === "mcp") {
    const unwrapped = unwrapUseTool(input);
    if (unwrapped) return grokProductToolName(unwrapped.name, unwrapped.input);
    const obj = recordOf(input);
    const server = obj ? pickString(obj, "server", "server_name", "serverIdentifier") : "";
    const tool = obj ? pickString(obj, "tool_name", "tool", "name") : "";
    if (server && tool && !tool.includes("__")) return `mcp__${server}__${tool}`;
  }
  const mapped = GROK_PRODUCT_NAMES[key];
  if (!mapped) return nativeName;
  if (mapped === "Edit") {
    const obj = recordOf(input);
    const oldString = obj ? pickString(obj, "old_string", "oldString") : "";
    const newString = obj ? pickString(obj, "new_string", "newString", "content", "contents") : "";
    if (!oldString && newString) return "Write";
  }
  return mapped;
}

export function grokProductToolInput(nativeName: string, input: ToolInput): ToolInput {
  if (!input) return input;
  const key = grokNativeKey(nativeName);
  if (key === "use_tool" || key === "call_mcp_tool" || key === "mcp") {
    const unwrapped = unwrapUseTool(input);
    if (unwrapped) return grokProductToolInput(unwrapped.name, recordOf(unwrapped.input));
  }
  const product = grokProductToolName(nativeName, input);
  const filePath = pickString(input, "file_path", "path", "absolute_path", "target_file");
  switch (product) {
    case "Bash":
      return {
        ...input,
        command: pickString(input, "command", "cmd") || stringifyFallback(input.command),
        ...(pickString(input, "description") ? { description: pickString(input, "description") } : {}),
      };
    case "Read":
      return { ...input, ...(filePath ? { file_path: filePath } : {}) };
    case "Write":
      return {
        ...input,
        ...(filePath ? { file_path: filePath } : {}),
        content: pickString(input, "content", "contents", "new_string", "newString") || stringifyFallback(input.content),
      };
    case "Edit":
      return {
        ...input,
        ...(filePath ? { file_path: filePath } : {}),
        old_string: pickString(input, "old_string", "oldString"),
        new_string: pickString(input, "new_string", "newString"),
      };
    case "Grep":
      return {
        ...input,
        pattern: pickString(input, "pattern", "query", "search"),
        ...(pickString(input, "path", "file_path") ? { path: pickString(input, "path", "file_path") } : {}),
      };
    case "Glob":
      return {
        ...input,
        pattern: pickString(input, "glob_pattern", "pattern", "glob") || "*",
        ...(pickString(input, "path", "target_directory") ? { path: pickString(input, "path", "target_directory") } : {}),
      };
    case "WebSearch":
    case "McpSearch":
      return { ...input, query: pickString(input, "query", "search_term", "q") };
    case "WebFetch":
      return { ...input, url: pickString(input, "url", "href") };
    case "Task":
    case "TaskOutput":
    case "TaskStop":
      return {
        ...input,
        description: pickString(input, "description", "prompt", "goal", "title") || stringifyFallback(input.description),
      };
    default:
      return input;
  }
}

export function normalizeGrokToolForDisplay(
  name: string,
  input: ToolInput,
  message: ToolLike,
): DisplayTool {
  const product = grokProductToolName(name, input ?? undefined);
  const mappedInput = grokProductToolInput(name, input);
  // output==null/undefined 视为「还没有输出」。message.text 在 Cursor/reducer
  // 里是 toolName 占位（常为 "Bash"），绝不能当 stdout 兜底。
  const decoded = grokProductToolOutput(message.outputJson ?? message.output ?? null);
  const originalOutput =
    typeof message.output === "string" ? message.output : stringifyFallback(message.output);
  const outputChanged = decoded !== originalOutput;
  const tool = outputChanged && decoded ? { ...message, output: decoded } : message;
  return { name: product || name, input: mappedInput, tool };
}
