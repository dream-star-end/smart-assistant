/**
 * Pure parsing & inspection helpers for `delegate_task` / `send_to_agent` / `delegate_tasks` / `oc-memory`.
 */
import {
  isExecuteExtraToolName,
  parseExecuteExtraToolResult,
  unwrapExecuteExtraToolInput,
} from "../extraTool";
import type { OutboundContentBlock } from "../frames";
import type { ChatMessage, ChatSession, ChildBlock } from "../model";
import {
  isOcMemoryDelegateVerb,
  isOcMemoryDelegateWait,
  isShellToolName,
  parseOcMemoryCommand,
} from "../ocMemoryCli";
import type { DelegateProgressBlock, DelegateToolInfo } from "./types";

export function asPlainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || !value.trim().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function parseToolInputObject(
  inputJson: unknown,
  inputPreview?: string,
): Record<string, unknown> | null {
  return parseJsonObject(inputJson) ?? parseJsonObject(inputPreview);
}

function parseArgsObject(raw: unknown): Record<string, unknown> {
  return parseJsonObject(raw) ?? {};
}

function normalizeMcpServerName(raw: string): string {
  return raw.replace(/_/g, "-");
}

function parseCodexTypeName(name?: string): string {
  if (!name) return "";
  if (name.startsWith("codex:") || name.startsWith("Codex:")) return name.slice(6);
  return "";
}

function parseMcpToolName(name?: string): { server: string; op: string } | null {
  if (!name || !name.startsWith("mcp__")) return null;
  const rest = name.slice(5);
  const idx = rest.indexOf("__");
  if (idx < 0) return { server: normalizeMcpServerName(rest), op: "" };
  return { server: normalizeMcpServerName(rest.slice(0, idx)), op: rest.slice(idx + 2) };
}

export function isDelegateToolName(name?: string): boolean {
  return /(?:^|_)(delegate_task|send_to_agent)$/.test(name || "");
}

export function isSendToAgentToolName(name?: string): boolean {
  if (/(?:^|_)send_to_agent$/.test(name || "")) return true;
  const mcp = parseMcpToolName(name);
  return mcp?.server === "openclaude-memory" && mcp.op === "send_to_agent";
}

function extractMcpContentText(item: Record<string, unknown> | null): string {
  if (!item) return "";
  const result = asPlainObject(item.result);
  const content = Array.isArray(result?.content) ? result.content : [];
  const texts = content
    .map((part) => (part && typeof part === "object" ? str((part as Record<string, unknown>).text) : ""))
    .filter(Boolean);
  if (texts.length > 0) return texts.join("\n");
  const error = asPlainObject(item.error);
  return str(error?.message) || str(item.error) || str(item.result);
}

function collectBackgroundResultPayloads(output?: string, outputJson?: unknown): unknown[] {
  const payloads: unknown[] = [outputJson, output];
  for (const raw of [outputJson, output]) {
    const parsed = parseJsonObject(raw);
    if (!parsed) continue;
    if (parsed.isBackground === true) payloads.push({ status: "running", jobId: parsed.jobId });
    const extra = parseExecuteExtraToolResult(parsed);
    if (extra?.text) payloads.push(extra.text);
    const success = asPlainObject(parsed.success);
    if (typeof success?.stdout === "string" && success.stdout.trim()) payloads.push(success.stdout);
    if (typeof success?.stderr === "string" && success.stderr.trim()) payloads.push(success.stderr);
  }
  return payloads;
}

function isCliRunningStatusText(raw: unknown): boolean {
  return typeof raw === "string" && /(?:^|[\s,;])status=running(?:\s|$)/i.test(raw);
}

function jobIdFromLooseText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const match = /(?:^|[\s,;])jobId=([A-Za-z0-9._:-]+)/.exec(raw);
  return match?.[1] ?? null;
}

export function isRunningBackgroundToolResult(output?: string, outputJson?: unknown): boolean {
  if (typeof output === "string" && /process is still running|moved to background/i.test(output)) {
    return true;
  }
  for (const raw of collectBackgroundResultPayloads(output, outputJson)) {
    if (isCliRunningStatusText(raw)) return true;
    const parsed = parseJsonObject(raw);
    if (!parsed) continue;
    if (parsed.status === "running" || parsed.isBackground === true) return true;
    const wrapped = extractMcpContentText(parsed);
    const inner = parseJsonObject(wrapped);
    if (inner?.status === "running") return true;
  }
  return false;
}

export function backgroundDelegateJobId(output?: string, outputJson?: unknown): string | null {
  for (const raw of collectBackgroundResultPayloads(output, outputJson)) {
    const parsed = parseJsonObject(raw);
    const direct = typeof parsed?.jobId === "string" ? parsed.jobId : null;
    if (direct) return direct;
    const wrapped = parsed ? extractMcpContentText(parsed) : null;
    const inner = parseJsonObject(wrapped);
    if (typeof inner?.jobId === "string") return inner.jobId;
    const fromText = jobIdFromLooseText(raw);
    if (fromText) return fromText;
  }
  return null;
}

export function normalizeDelegateGoalKey(raw: unknown): string {
  return String(raw ?? "")
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, 1024);
}

/** heredoc 全文 vs 首行：任一侧是前缀即视为同一目标（仍要求唯一候选）。 */
export function delegateGoalsMatch(a: unknown, b: unknown): boolean {
  const ka = normalizeDelegateGoalKey(a);
  const kb = normalizeDelegateGoalKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  return ka.startsWith(kb) || kb.startsWith(ka);
}

function delegateInfoFromArgs(args: Record<string, unknown>, background = false): DelegateToolInfo {
  const goalRaw = str(args.goal) || str(args.message);
  return {
    agentId: str(args.agentId) || "main",
    goalRaw,
    goalKey: normalizeDelegateGoalKey(goalRaw),
    ...(background ? { background: true } : {}),
  };
}

function shellCommandFromInput(inputJson?: unknown, inputPreview?: string): string {
  const input = parseToolInputObject(inputJson, inputPreview) ?? {};
  return str(input.command);
}

function delegateInfoFromOcMemoryCommand(command: string): DelegateToolInfo | null {
  const parsed = parseOcMemoryCommand(command);
  if (!parsed || parsed.op !== "delegate") return null;
  const goalFull = parsed.goalFull || parsed.goalRaw;
  return {
    agentId: parsed.agentId || "main",
    goalRaw: parsed.goalRaw || goalFull,
    goalKey: normalizeDelegateGoalKey(goalFull || parsed.goalRaw),
    ...(parsed.model ? { model: parsed.model } : {}),
  };
}

export function parseDelegateWaitJobId(
  toolName?: string,
  inputJson?: unknown,
  inputPreview?: string,
): string | null {
  if (!isShellToolName(toolName)) return null;
  const command = shellCommandFromInput(inputJson, inputPreview);
  if (!isOcMemoryDelegateWait(command)) return null;
  const jobId = parseOcMemoryCommand(command)?.jobId?.trim() || "";
  return jobId || null;
}

/** CCB `ExecuteExtraTool {tool_name, params}` → 内层 (name, input);非包装原样返回。 */
function unwrapExtraToolCall(
  toolName: string,
  input: Record<string, unknown>,
): { name: string; input: Record<string, unknown> } {
  if (!isExecuteExtraToolName(toolName)) return { name: toolName, input };
  const call = unwrapExecuteExtraToolInput(input);
  return call ? { name: call.name, input: call.params } : { name: toolName, input };
}

export function parseDelegateToolInfo(
  toolName?: string,
  inputJson?: unknown,
  inputPreview?: string,
): DelegateToolInfo | null {
  const wrapped = unwrapExtraToolCall(toolName || "", parseToolInputObject(inputJson, inputPreview) ?? {});
  const name = wrapped.name;
  const input = wrapped.input;
  if (isShellToolName(name)) {
    const command = str(input.command);
    if (!isOcMemoryDelegateVerb(command)) return null;
    return delegateInfoFromOcMemoryCommand(command);
  }
  const mcp = parseMcpToolName(name);
  if (mcp?.server === "openclaude-memory" && (mcp.op === "delegate_task" || mcp.op === "send_to_agent")) {
    return delegateInfoFromArgs(input, mcp.op === "send_to_agent");
  }
  if (isDelegateToolName(name) && parseCodexTypeName(name) !== "mcpToolCall") {
    return delegateInfoFromArgs(input, isSendToAgentToolName(name));
  }
  if (parseCodexTypeName(name) !== "mcpToolCall") return null;
  const server = normalizeMcpServerName(str(input.server) || str(input.serverName));
  const op = str(input.tool) || str(input.toolName) || str(input.name);
  if (server !== "openclaude-memory" || (op !== "delegate_task" && op !== "send_to_agent")) {
    return null;
  }
  const rawArgs = input.arguments ?? input.args ?? input.params;
  return delegateInfoFromArgs(parseArgsObject(rawArgs), op === "send_to_agent");
}

function isFanoutDelegateToolRow(msg: ChatMessage): boolean {
  if (msg.role !== "tool") return false;
  const parsedInput = parseToolInputObject(msg.inputJson, msg.inputPreview) ?? {};
  const name = unwrapExtraToolCall(msg.toolName || "", parsedInput).name;
  const mcp = parseMcpToolName(name);
  if (mcp?.server === "openclaude-memory" && mcp.op === "delegate_tasks") return true;
  if (/(?:^|_)delegate_tasks$/.test(name) && parseCodexTypeName(name) !== "mcpToolCall") {
    return true;
  }
  if (parseCodexTypeName(name) === "mcpToolCall") {
    const server = normalizeMcpServerName(str(parsedInput.server) || str(parsedInput.serverName));
    const op = str(parsedInput.tool) || str(parsedInput.toolName) || str(parsedInput.name);
    return server === "openclaude-memory" && op === "delegate_tasks";
  }
  return false;
}

export function hasActiveFanoutDelegate(sess: ChatSession): boolean {
  for (let i = sess.messages.length - 1; i >= 0; i--) {
    const m = sess.messages[i];
    if (m.role === "user") return false;
    if (isFanoutDelegateToolRow(m)) return true;
  }
  return false;
}

// export: persist.mergeLocalClientFields 回填 server 工具行输出时复用同一预览语义。
export function friendlyDelegateResultPreview(raw: unknown): string {
  const text = typeof raw === "string" ? raw : "";
  const parsed = parseJsonObject(raw);
  if (!parsed) return text.trim().startsWith("{") ? "" : text;
  const extra = parseExecuteExtraToolResult(parsed);
  if (extra) return extra.text.trim().startsWith("{") ? "" : extra.text;
  const server = normalizeMcpServerName(str(parsed.server) || str(parsed.serverName));
  const op = str(parsed.tool) || str(parsed.toolName) || str(parsed.name);
  const content = extractMcpContentText(parsed);
  if (server === "openclaude-memory" && (op === "delegate_task" || op === "send_to_agent")) {
    return content;
  }
  return content || (text.trim().startsWith("{") ? "" : text);
}

export function isDelegateResultWrapper(raw: unknown): boolean {
  const parsed = parseJsonObject(raw);
  if (!parsed) return false;
  const extra = parseExecuteExtraToolResult(parsed);
  if (extra) return /(?:^|_)(delegate_task|send_to_agent)$/.test(extra.toolName);
  const server = normalizeMcpServerName(str(parsed.server) || str(parsed.serverName));
  const op = str(parsed.tool) || str(parsed.toolName) || str(parsed.name);
  return server === "openclaude-memory" && (op === "delegate_task" || op === "send_to_agent");
}

export function legacyDelegateTextToChildBlock(
  phase: string | undefined,
  text: string,
): ChildBlock | null {
  if (!text || phase === "start" || phase === "done") return null;
  if (phase === "thinking") return { kind: "thinking", text };
  if (phase === "text") return { kind: "text", text };
  return { kind: "text", text: `[${phase || "progress"}] ${text}` };
}

export function legacyDelegateEntriesToChildBlocks(entries: ChatMessage["entries"]): ChildBlock[] {
  if (!Array.isArray(entries)) return [];
  const out: ChildBlock[] = [];
  for (const entry of entries) {
    const text = typeof entry?.text === "string" ? entry.text : "";
    const child = legacyDelegateTextToChildBlock(entry.phase, text);
    if (child) out.push(child);
  }
  return out;
}

export function isDelegateProgressBlock(
  b: OutboundContentBlock,
): b is OutboundContentBlock & DelegateProgressBlock {
  return b.kind === "delegate_progress";
}
