/**
 * 工具卡格式化与输入解析的纯函数集（无 React，可单测）。
 * 端口自现网 messages.js 的 `_safeInput` / `_shortPath` / `_formatValue` 语义。
 */
import type { BashTail } from "../../lib/chat/model";
import { parsePartialJson } from "./partialJson";

/**
 * 工具卡消费的最小 tool 形态。`tool` ChatMessage（role==='tool'）与 agent-group 的
 * ChildBlock 都**结构兼容**此类型——ToolCard 因此能同时服务主流 tool 行与子块 tool。
 * 这是 ToolCard 对外的唯一数据契约入口（见 ToolCard.tsx props 约定）。
 */
export type ToolLike = {
  toolName?: string;
  inputJson?: unknown;
  partialJson?: string;
  inputPreview?: string;
  _partial?: boolean;
  _completed?: boolean;
  output?: string | null;
  text?: string | null;
  error?: boolean;
  bashTail?: BashTail;
  durationMs?: number | null;
};

export type ToolInput = Record<string, unknown> | null;
export type DisplayTool = { name: string; input: ToolInput; tool: ToolLike };

/**
 * 解析工具输入。优先级与现网 `_safeInput` 一致：
 *   1. 最终 inputJson（对象，非数组）
 *   2. 容错解析的 partialJson（流式累加器，驱动 Edit/Write 边流边渲）
 *   3. legacy inputPreview 的 JSON.parse 兜底
 */
export function resolveToolInput(tool: ToolLike): ToolInput {
  const j = tool.inputJson;
  if (j && typeof j === "object" && !Array.isArray(j)) return j as Record<string, unknown>;
  if (typeof tool.partialJson === "string" && tool.partialJson.length > 0) {
    return parsePartialJson(tool.partialJson);
  }
  if (tool.inputPreview) {
    try {
      const p = JSON.parse(tool.inputPreview);
      return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value.trim().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Parse `codex:<itemType>` / legacy `Codex:<itemType>` tool names. */
export function parseCodexTypeName(name: string | undefined | null): string | null {
  if (!name) return null;
  if (name.startsWith("codex:")) return name.slice(6);
  if (name.startsWith("Codex:")) return name.slice(6);
  return null;
}

function asPlainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function argsFromRaw(raw: unknown): { args: Record<string, unknown>; rawArgs: unknown } {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return { args: raw as Record<string, unknown>, rawArgs: raw };
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { args: parsed as Record<string, unknown>, rawArgs: raw };
      }
    } catch {
      /* show the raw value via fallback below */
    }
  }
  return { args: {}, rawArgs: raw };
}

function rawArgsDisplay(rawArgs: unknown): string {
  if (rawArgs == null) return "";
  if (typeof rawArgs === "string") return rawArgs;
  if (typeof rawArgs === "number" || typeof rawArgs === "boolean") return String(rawArgs);
  try {
    const text = JSON.stringify(rawArgs);
    return text && text !== "{}" && text !== "[]" ? text : "";
  } catch {
    return "";
  }
}

function resolveCodexCall(input: Record<string, unknown> | null): {
  server: string;
  tool: string;
  args: Record<string, unknown>;
  rawArgs: unknown;
} {
  if (!input) return { server: "", tool: "", args: {}, rawArgs: undefined };
  const server = asStr(input.server) || asStr(input.serverName);
  const tool = asStr(input.tool) || asStr(input.toolName) || asStr(input.name);
  let rawArgs = input.arguments;
  if (rawArgs === undefined) rawArgs = input.args;
  if (rawArgs === undefined) rawArgs = input.params;
  const { args, rawArgs: originalRawArgs } = argsFromRaw(rawArgs);
  return { server, tool, args, rawArgs: originalRawArgs };
}

function normalizeMcpServerName(server: string): string {
  const map: Record<string, string> = {
    openclaude_memory: "openclaude-memory",
    openclaude_vision: "openclaude-vision",
    minimax_media: "minimax-media",
    minimax_vision: "minimax-vision",
    scansci_pdf: "scansci-pdf",
    web_context: "web-context",
    quant_system: "quant-system",
  };
  return map[server] ?? server;
}

function pickCodexItem(tool: ToolLike): { inputItem: Record<string, unknown> | null; finalItem: Record<string, unknown> | null } {
  const inputItem = parseJsonObject(tool.inputJson) ?? parseJsonObject(tool.inputPreview);
  const finalItem = parseJsonObject(tool.output) ?? parseJsonObject(tool.text) ?? inputItem;
  return { inputItem, finalItem };
}

function extractCodexOutput(item: Record<string, unknown> | null): string | null {
  if (!item) return null;
  const error = item.error;
  const result = item.result;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const content = (result as Record<string, unknown>).content;
    if (Array.isArray(content)) {
      const texts = content
        .map((part) => (part && typeof part === "object" ? asStr((part as Record<string, unknown>).text) : ""))
        .filter(Boolean);
      if (texts.length > 0) return texts.join("\n");
    }
    const structured = (result as Record<string, unknown>).structuredContent;
    if (structured != null) {
      try {
        return JSON.stringify(structured);
      } catch {
        return String(structured);
      }
    }
    const usefulResultKeys = Object.keys(result).filter((k) => !["content", "structuredContent", "_meta"].includes(k));
    if (usefulResultKeys.length > 0) {
      try {
        return JSON.stringify(result);
      } catch {
        return null;
      }
    }
  }
  if (typeof result === "string") return result;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const message = asStr((error as Record<string, unknown>).message);
    if (message) return message;
  }
  if (typeof error === "string") return error;
  return null;
}

function fallbackNonJsonOutput(tool: ToolLike): string | null {
  if (typeof tool.output !== "string") return null;
  const out = tool.output.trim();
  if (!out || /^codex:/i.test(out)) return null;
  if (parseJsonObject(out)) return null;
  return tool.output;
}

function codexFailed(item: Record<string, unknown> | null): boolean {
  if (!item) return false;
  const status = asStr(item.status).toLowerCase();
  return status === "failed" || status === "error" || status === "cancelled" || item.error != null;
}

function compactArgs(args: Record<string, unknown>, rawArgs: unknown): Record<string, unknown> {
  if (Object.keys(args).length > 0) return args;
  const display = rawArgsDisplay(rawArgs);
  return display ? { args: display } : {};
}

function normalizeCodexPlan(input: Record<string, unknown>): Record<string, unknown> {
  const rawSteps = Array.isArray(input.steps) ? input.steps : Array.isArray(input.items) ? input.items : [];
  const todos = rawSteps
    .filter((step): step is Record<string, unknown> => !!step && typeof step === "object" && !Array.isArray(step))
    .map((step) => {
      const content = asStr(step.text) || asStr(step.description);
      const status = asStr(step.status) || (step.completed === true ? "completed" : "pending");
      return { content, status };
    });
  return { todos };
}

function normalizeCodexTool(message: ToolLike, codexType: string): DisplayTool | null {
  const { inputItem, finalItem } = pickCodexItem(message);
  const mergedItem = inputItem && finalItem ? { ...inputItem, ...finalItem } : (inputItem ?? finalItem);
  const callItem = inputItem ?? finalItem;
  const outputText = extractCodexOutput(finalItem) ?? fallbackNonJsonOutput(message);
  const baseTool: ToolLike = {
    ...message,
    output: outputText,
    error: !!message.error || codexFailed(finalItem),
    durationMs:
      typeof finalItem?.durationMs === "number" ? (finalItem.durationMs as number) : message.durationMs,
  };

  if (codexType === "mcpToolCall") {
    const inputCall = resolveCodexCall(callItem);
    const finalCall = resolveCodexCall(finalItem);
    const server = normalizeMcpServerName(inputCall.server || finalCall.server);
    const op = inputCall.tool || finalCall.tool;
    const args = Object.keys(inputCall.args).length > 0 ? inputCall.args : finalCall.args;
    const rawArgs = inputCall.rawArgs !== undefined ? inputCall.rawArgs : finalCall.rawArgs;
    const input = compactArgs(args, rawArgs);
    if (server && op) {
      return {
        name: `mcp__${server}__${op}`,
        input,
        tool: { ...baseTool, toolName: `mcp__${server}__${op}`, inputJson: input },
      };
    }
    return { name: "codex:mcpToolCall", input, tool: { ...baseTool, inputJson: input } };
  }

  if (codexType === "dynamicToolCall") {
    const inputCall = resolveCodexCall(callItem);
    const finalCall = resolveCodexCall(finalItem);
    const innerName = inputCall.tool || finalCall.tool;
    const args = Object.keys(inputCall.args).length > 0 ? inputCall.args : finalCall.args;
    const rawArgs = inputCall.rawArgs !== undefined ? inputCall.rawArgs : finalCall.rawArgs;
    const input = compactArgs(args, rawArgs);
    const name = innerName || "codex:dynamicToolCall";
    return { name, input, tool: { ...baseTool, toolName: name, inputJson: input } };
  }

  if (codexType === "webSearch") {
    const item = asPlainObject(mergedItem);
    const input = { query: asStr(item.query), results: item.results };
    return { name: "WebSearch", input, tool: { ...baseTool, toolName: "WebSearch", inputJson: input } };
  }

  if (codexType === "plan" || codexType === "todo_list") {
    const finalPlan =
      finalItem && (Array.isArray(finalItem.steps) || Array.isArray(finalItem.items)) ? finalItem : mergedItem;
    const input = normalizeCodexPlan(asPlainObject(finalPlan));
    return { name: "TodoWrite", input, tool: { ...baseTool, toolName: "TodoWrite", inputJson: input } };
  }

  const compactInput = mergedItem ? { ...mergedItem } : resolveToolInput(message);
  return {
    name: message.toolName || `codex:${codexType}`,
    input: compactInput,
    tool: { ...baseTool, inputJson: compactInput },
  };
}

/** Normalize Codex/v3 wrapper tools into the same display contract as native v5 tools. */
export function normalizeToolForDisplay(message: ToolLike): DisplayTool {
  const originalName = message.toolName || "unknown";
  const codexType = parseCodexTypeName(originalName);
  if (codexType) {
    const normalized = normalizeCodexTool(message, codexType);
    if (normalized) return normalized;
  }
  const input = resolveToolInput(message);
  return { name: originalName, input, tool: message };
}

/** 取末 2-3 段路径（过长时 `…/a/b/c`）。 */
export function shortPath(p: unknown): string {
  if (!p || typeof p !== "string") return "";
  const parts = p.replace(/\\/g, "/").split("/");
  return parts.length > 3 ? "…/" + parts.slice(-3).join("/") : p;
}

/** 安全字符串取值（非字符串 → ""）。*/
export function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** 安全数组取值（非数组 → []）。*/
export function asArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function isSafeHttpUrl(s: unknown): s is string {
  return typeof s === "string" && /^https?:\/\//i.test(s);
}

/**
 * 紧凑值格式化。数组/对象做摘要而非全量序列化，避免流式工具块多次重建时的二次方
 * stringify 成本。端口自 `_formatValue`。
 */
export function formatValue(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    if (v.length <= 3 && v.every((x) => x == null || typeof x !== "object")) {
      try {
        return JSON.stringify(v);
      } catch {
        return `Array(${v.length})`;
      }
    }
    return `Array(${v.length})`;
  }
  if (typeof v === "object") {
    const keys = Object.keys(v as object);
    if (keys.length === 0) return "{}";
    if (keys.length <= 3 && keys.every((k) => (v as Record<string, unknown>)[k] == null || typeof (v as Record<string, unknown>)[k] !== "object")) {
      try {
        return JSON.stringify(v);
      } catch {
        return `{${keys.length} 字段}`;
      }
    }
    const head = keys.slice(0, 3).join(", ");
    return keys.length > 3 ? `{${head}, …+${keys.length - 3}}` : `{${head}}`;
  }
  return String(v);
}

/** 字符串夹断（超出 max 加省略号）。*/
export function clampStr(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}
