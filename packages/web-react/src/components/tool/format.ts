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
  outputJson?: unknown;
  text?: string | null;
  error?: boolean;
  /** 取消态(如 Codex item status 'cancelled'):中性终态,≠ 失败,卡片显示「已取消」。 */
  cancelled?: boolean;
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
  if (typeof result === "string") return result || null;
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
  return status === "failed" || status === "error" || item.error != null;
}

/** cancelled ≠ failed:用户/系统中止是中性终态,单独归类(卡片显示「已取消」而非红色失败)。 */
function codexCancelled(item: Record<string, unknown> | null): boolean {
  if (!item) return false;
  const status = asStr(item.status).toLowerCase();
  return status === "cancelled" || status === "canceled";
}

function compactArgs(args: Record<string, unknown>, rawArgs: unknown): Record<string, unknown> {
  if (Object.keys(args).length > 0) return args;
  const display = rawArgsDisplay(rawArgs);
  return display ? { args: display } : {};
}

function normalizeCodexPlan(input: Record<string, unknown>): Record<string, unknown> {
  // 后端结构化 plan 的权威字段是 {step, status}(见 gateway engine codexAppServerRunner
  // turn/plan/updated 的归一化);item 形态还可能把数组挂在 `plan` 键下({plan:[{step,…}]}),
  // 与 steps/items 一并兜底,否则这两种形态会渲染成空列表。
  const rawSteps = Array.isArray(input.steps)
    ? input.steps
    : Array.isArray(input.items)
      ? input.items
      : Array.isArray(input.plan)
        ? input.plan
        : [];
  const todos = rawSteps
    .filter((step): step is Record<string, unknown> => !!step && typeof step === "object" && !Array.isArray(step))
    .map((step) => {
      const content = asStr(step.step) || asStr(step.text) || asStr(step.description);
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
    cancelled: !!message.cancelled || codexCancelled(finalItem),
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
      finalItem && (Array.isArray(finalItem.steps) || Array.isArray(finalItem.items) || Array.isArray(finalItem.plan))
        ? finalItem
        : mergedItem;
    const input = normalizeCodexPlan(asPlainObject(finalPlan));
    return { name: "TodoWrite", input, tool: { ...baseTool, toolName: "TodoWrite", inputJson: input } };
  }

  const compactInput = mergedItem ? { ...mergedItem } : resolveToolInput(message);
  // 保留原始 codex:/Codex: 前缀名;孤儿兜底(toolName 'unknown'/空)则以推断出的 type 重命名,
  // 否则 meta/body 分派拿到的还是 'unknown',归一化等于白做。
  const name = parseCodexTypeName(message.toolName) ? (message.toolName as string) : `codex:${codexType}`;
  return {
    name,
    input: compactInput,
    tool: { ...baseTool, toolName: name, inputJson: compactInput },
  };
}

/** Normalize Codex/v3 wrapper tools into the same display contract as native v5 tools. */
export function normalizeToolForDisplay(message: ToolLike): DisplayTool {
  const originalName = message.toolName || "unknown";
  let codexType = parseCodexTypeName(originalName);
  // 存量孤儿兜底:后端配对失败的历史消息 toolName 丢成 'unknown'(inputJson 空),codex item
  // JSON 整段留在 output/text 里({type:"subAgentActivity",…})。从中解析出 type → 按
  // codex:<type> 归一化,让存量丑消息也有语义卡(后端另修配对,但历史消息永远是孤儿形状)。
  if (!codexType && originalName === "unknown") {
    const { inputItem, finalItem } = pickCodexItem(message);
    const orphanType = asStr(finalItem?.type) || asStr(inputItem?.type);
    if (/^[A-Za-z][\w-]*$/.test(orphanType)) codexType = orphanType;
  }
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

export type ShellFileWriteSummary = {
  /** 目标文件路径（按命令顺序去重）。*/
  paths: string[];
  /** 原始 Bash 命令，展开体仍展示用于审计。*/
  rawCommand: string;
  /** 识别到的 cat heredoc 写入次数。*/
  writeCount: number;
};

const SHELL_PATH_TOKEN = `(?:"[^"\\n]+"|'[^'\\n]+'|[^\\s<>|;&]+)`;
const SHELL_DELIM_TOKEN = `(?:"[^"\\n]+"|'[^'\\n]+'|[A-Za-z_][A-Za-z0-9_.-]*)`;
const HEREDOC_OUT_FIRST_RE = new RegExp(
  `^cat\\s+>\\s*(${SHELL_PATH_TOKEN})\\s+<<(\\-?)\\s*(${SHELL_DELIM_TOKEN})\\s*\\n`,
);
const HEREDOC_DELIM_FIRST_RE = new RegExp(
  `^cat\\s+<<(\\-?)\\s*(${SHELL_DELIM_TOKEN})\\s+>\\s*(${SHELL_PATH_TOKEN})\\s*\\n`,
);

function stripShellTokenQuotes(token: string): string {
  if (
    token.length >= 2 &&
    ((token.startsWith("'") && token.endsWith("'")) || (token.startsWith('"') && token.endsWith('"')))
  ) {
    return token.slice(1, -1);
  }
  return token;
}

function isStaticShellPath(path: string): boolean {
  return !!path && !path.startsWith("-") && !/[`$*?\[\]{}]/.test(path);
}

function splitSimpleShellTokens(segment: string): string[] | null {
  const tokens: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        tokens.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (quote) return null;
  if (cur) tokens.push(cur);
  return tokens;
}

function findStatementEnd(src: string, start: number): number {
  let quote: "'" | '"' | null = null;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "\n" || ch === ";") return i;
    if (src.startsWith("&&", i) || src.startsWith("||", i)) return i;
  }
  return src.length;
}

function skipShellSeparators(src: string, pos: number): number {
  let i = pos;
  for (;;) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src.startsWith("&&", i)) {
      i += 2;
      continue;
    }
    if (src[i] === ";") {
      i += 1;
      continue;
    }
    return i;
  }
}

function consumeMkdirP(src: string, pos: number): number | null {
  const m = /^mkdir\s+-p\s+/.exec(src.slice(pos));
  if (!m) return null;
  const argStart = pos + m[0].length;
  const end = findStatementEnd(src, argStart);
  const segment = src.slice(argStart, end).trim();
  if (!segment || /[<>|`$()]/.test(segment)) return null;
  const tokens = splitSimpleShellTokens(segment);
  if (!tokens?.length || tokens.some((t) => !isStaticShellPath(t))) return null;
  return end;
}

function findHeredocClose(src: string, start: number, delimiter: string, allowTabs: boolean): number | null {
  let lineStart = start;
  while (lineStart <= src.length) {
    const lineEnd = src.indexOf("\n", lineStart);
    const rawLine = lineEnd === -1 ? src.slice(lineStart) : src.slice(lineStart, lineEnd);
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const comparable = allowTabs ? line.replace(/^\t+/, "") : line;
    if (comparable === delimiter) return lineEnd === -1 ? src.length : lineEnd + 1;
    if (lineEnd === -1) return null;
    lineStart = lineEnd + 1;
  }
  return null;
}

function consumeCatHeredoc(src: string, pos: number): { end: number; path: string } | null {
  const rest = src.slice(pos);
  let pathToken = "";
  let delimToken = "";
  let allowTabs = false;
  let headerLength = 0;

  const outFirst = HEREDOC_OUT_FIRST_RE.exec(rest);
  if (outFirst) {
    pathToken = outFirst[1];
    allowTabs = outFirst[2] === "-";
    delimToken = outFirst[3];
    headerLength = outFirst[0].length;
  } else {
    const delimFirst = HEREDOC_DELIM_FIRST_RE.exec(rest);
    if (!delimFirst) return null;
    allowTabs = delimFirst[1] === "-";
    delimToken = delimFirst[2];
    pathToken = delimFirst[3];
    headerLength = delimFirst[0].length;
  }

  const path = stripShellTokenQuotes(pathToken);
  const delimiter = stripShellTokenQuotes(delimToken);
  if (!isStaticShellPath(path) || !delimiter || /\s/.test(delimiter)) return null;
  const end = findHeredocClose(src, pos + headerLength, delimiter, allowTabs);
  return end == null ? null : { end, path };
}

/**
 * 识别 Codex 偶尔用 Bash heredoc 做的「纯写文件」命令：
 *   mkdir -p dir && cat > file <<'EOF'
 *   ...
 *   EOF
 *
 * 只接受 `mkdir -p` + 一个或多个 `cat ... <<EOF` 的组合；任何管道、变量路径、
 * trailing command（如 npm test/chmod）都会返回 null，避免把真正的终端操作误包装成写文件。
 */
export function detectShellFileWrites(command: string | undefined | null): ShellFileWriteSummary | null {
  const rawCommand = asStr(command);
  const src = rawCommand.replace(/\r\n/g, "\n").trim();
  if (!src) return null;

  const paths: string[] = [];
  let writes = 0;
  let pos = 0;
  while (pos < src.length) {
    pos = skipShellSeparators(src, pos);
    if (pos >= src.length) break;

    const mkdirEnd = consumeMkdirP(src, pos);
    if (mkdirEnd != null) {
      pos = mkdirEnd;
      continue;
    }

    const heredoc = consumeCatHeredoc(src, pos);
    if (heredoc) {
      writes += 1;
      paths.push(heredoc.path);
      pos = heredoc.end;
      continue;
    }

    return null;
  }

  if (writes === 0) return null;
  return { paths: Array.from(new Set(paths)), rawCommand, writeCount: writes };
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

// ── legacy Bash 包装剥离(展示层兜底)─────────────────────────────────────────
//
// 权威剥壳在后端 runner 的发射时刻(gateway codexAppServerRunner.stripShellWrapper,
// 2026-07-10 起新帧的 command 已剥好)。但历史消息落库时带着 `/bin/bash -lc '…'`
// 包装,落库数据不可变,只能在展示层兜底 —— 与 normalizeToolForDisplay 的孤儿
// 'unknown' 兜底同一定位:后端修发射,前端救历史。语义与后端保持同一份
// (最小 POSIX 引号分词);改任何一边必须同步另一边。

/** 识别 `/bin/(ba)?sh -l?c <arg>` 包装:恰好一个 shell word → 返回解包命令;
 *  解析失败/多 word → 保守只剥前缀;非包装 → 原样。 */
export function stripShellWrapperForDisplay(cmd: string): string {
  const m = cmd.match(/^\/bin\/(?:ba)?sh\s+-l?c\s+([\s\S]*)$/);
  if (!m) return cmd;
  const rest = m[1];
  const words = tokenizeShellWords(rest);
  if (words && words.length === 1) return words[0];
  return rest;
}

/** 最小 POSIX shell 单词分词器(与 gateway 同语义):单引号全字面;双引号内
 *  反斜杠仅对 `\ " $ \``/续行生效;裸段反斜杠转义;相邻段拼接;未闭合引号返 null。 */
function tokenizeShellWords(input: string): string[] | null {
  const words: string[] = [];
  let buf = "";
  let inWord = false;
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i];
    if (ch === " " || ch === "\t" || ch === "\n") {
      if (inWord) {
        words.push(buf);
        buf = "";
        inWord = false;
      }
      i++;
      continue;
    }
    if (ch === "'") {
      inWord = true;
      i++;
      let closed = false;
      while (i < n) {
        if (input[i] === "'") {
          closed = true;
          i++;
          break;
        }
        buf += input[i];
        i++;
      }
      if (!closed) return null;
      continue;
    }
    if (ch === '"') {
      inWord = true;
      i++;
      let closed = false;
      while (i < n) {
        const c = input[i];
        if (c === '"') {
          closed = true;
          i++;
          break;
        }
        if (c === "\\" && i + 1 < n) {
          const nx = input[i + 1];
          if (nx === "\\" || nx === '"' || nx === "$" || nx === "`") {
            buf += nx;
            i += 2;
            continue;
          }
          if (nx === "\n") {
            i += 2;
            continue;
          }
        }
        buf += c;
        i++;
      }
      if (!closed) return null;
      continue;
    }
    if (ch === "\\") {
      inWord = true;
      if (i + 1 < n) {
        const nx = input[i + 1];
        if (nx === "\n") {
          i += 2;
          continue;
        }
        buf += nx;
        i += 2;
        continue;
      }
      buf += ch;
      i++;
      continue;
    }
    inWord = true;
    buf += ch;
    i++;
  }
  if (inWord) words.push(buf);
  return words;
}
