import {
  Bot,
  ChevronRight,
  Brain,
  Check,
  ChevronDown,
  Circle,
  FileText,
  ListChecks,
  ListTodo,
  type LucideIcon,
  MessageCircleQuestion,
  PanelRight,
  Pencil,
  Search,
  ShieldCheck,
  Target,
  Terminal,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../../lib/chat/model";
import { ProgressiveMarkdown, RecoveredStepContext } from "./cards";
import { normalizeToolForDisplay, parseCodexTypeName, stripShellWrapperForDisplay, type ToolInput } from "../tool/format";
import { detectOcCli, resolveToolMeta } from "../tool/meta";
import { resolveToolStatus } from "../tool/status";
import { ProcessStepContext } from "./processStep";
import { StepTimingContext } from "./stepDuration";
import { combineStepTimings, computeStepTimings, formatStepDuration, stepTimingsSignature } from "../../lib/chat/stepTiming";
import { safeArtifactSrc } from "../tool/artifactSrc";
import { useArtifactInspect } from "../tool/context";
import { cn } from "../../lib/utils";
import { toolChangedFileCount } from "./workPane";
import { timelineMessageKey } from "./findInSession";

/**
 * View-only fold for the main chat. Message ids, tape bytes, and scroll
 * ownership stay where they were; this only decides which rows share a
 * disclosure.
 *
 * Duration is never invented. Counts are the only summary when the transcript
 * has no trustworthy elapsed time.
 */

const WORK_ROLES = new Set<ChatMessage["role"]>([
  "tool",
  "thinking",
  "plan",
  "agent-group",
  "delegate-progress",
]);

const INTERACTIVE_TOOL_RE =
  /^(?:AskUserQuestion|ExitPlanMode)$|ask_user|request_user_input|present_options|present_task_approval|exit_plan_mode|exitplanmode/i;

export function isFoldableWorkRole(message: ChatMessage): boolean {
  return WORK_ROLES.has(message.role);
}

function goalStatusValue(message: ChatMessage): string {
  return (message.goalStatus ?? "").trim().toLowerCase();
}

/**
 * A real goal row whose normalized status is cleared. `cleared: true` is the
 * reducer flag; `goalStatus === "cleared"` covers history that only stored the
 * status. This is not a text match — an assistant sentence can still say the
 * words. Errored rows stay visible.
 */
export function isClearedGoalRecord(message: ChatMessage): boolean {
  if (message.role !== "goal") return false;
  if (message.error || message._isError || message._errorCode) return false;
  if (message.cleared === true) return true;
  return goalStatusValue(message) === "cleared";
}

/**
 * Completed goal rows are historical diagnostics. Cleared rows are omitted
 * entirely by the caller. Active, paused, and blocked goals stay on the top
 * level — they are still a current objective. Role is the goal card itself,
 * not a tool or sentence that happens to say "goal".
 */
export function isHistoricalGoalRecord(message: ChatMessage): boolean {
  if (message.role !== "goal") return false;
  if (message.error || message._isError || message._errorCode) return false;
  if (isClearedGoalRecord(message)) return true;
  return goalStatusValue(message) === "completed";
}

function commandText(message: ChatMessage): string {
  const input = message.inputJson;
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    if (typeof record.command === "string") return record.command;
    if (typeof record.cmd === "string") return record.cmd;
    if (typeof record.file_path === "string") return record.file_path;
    if (typeof record.path === "string") return record.path;
  }
  if (typeof message.inputPreview === "string") return message.inputPreview;
  return message.text ?? "";
}

const SHELL_TOOLS = new Set(["bash", "shell", "run_terminal_command", "run_terminal_cmd"]);

const MD_IMAGE_RE = /!\[[^\]]*\]\(([^)\s]+)\)/g;
const GENERATED_PREFIX = "/home/agent/.openclaude/generated/";
const GENERATED_PATH_RE = /\/home\/agent\/\.openclaude\/generated\/\S+/g;
/** Prose/markdown closers only. `+`, `=`, `@`, and interior dots stay — they occur in real names. */
const TRAILING_PATH_JUNK = /[),.;:，。；"'`\]}>]+$/u;
const ARTIFACT_CLIS = new Set(["oc-report", "oc-slides", "oc-poster"]);

function dedupe(keys: string[]): string[] {
  return [...new Set(keys)];
}

function stableTextId(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

/** Query/hash and trailing punctuation come off generated paths; the filename itself is kept. */
function normalizeGeneratedPath(raw: string): string {
  const start = raw.indexOf(GENERATED_PREFIX);
  if (start < 0) return "";
  let value = raw.slice(start).replace(TRAILING_PATH_JUNK, "");
  const cut = value.search(/[?#]/);
  if (cut >= 0) value = value.slice(0, cut);
  value = value.replace(TRAILING_PATH_JUNK, "");
  if (!value.startsWith(GENERATED_PREFIX) || value.length <= GENERATED_PREFIX.length) return "";
  return value;
}

function generatedFileKey(raw: string): string | null {
  const normalized = normalizeGeneratedPath(raw);
  return normalized ? `file:${normalized}` : null;
}

function htmlStableId(info: string, code: string): string | null {
  const idMatch = /(?:^|[\s,])id=(?:"([^"]+)"|'([^']+)'|([^\s]+))/i.exec(info);
  const explicit = (idMatch?.[1] ?? idMatch?.[2] ?? idMatch?.[3] ?? "").trim();
  if (explicit) return `id:${explicit}`;
  const body = code.trim();
  if (!body) return null;
  return `b:${stableTextId(body)}`;
}

/** One key per real preview. Same body or same explicit id collapses; different previews do not. */
function htmlEvidenceKeys(text: string): string[] {
  const keys: string[] = [];
  const openRe = /```(?:htmlpreview|html)\b([^\n]*)/gi;
  let match: RegExpExecArray | null;
  while ((match = openRe.exec(text))) {
    const info = match[1] ?? "";
    let codeStart = match.index + match[0].length;
    if (text[codeStart] === "\r") codeStart += 1;
    if (text[codeStart] === "\n") codeStart += 1;
    const rest = text.slice(codeStart);
    const close = /\r?\n```[ \t]*(?:\r?\n|$)/.exec(rest);
    const code = close ? rest.slice(0, close.index) : rest;
    const id = htmlStableId(info, code);
    if (id) keys.push(`html:${id}`);
    if (!close) break;
    openRe.lastIndex = codeStart + close.index + close[0].length;
  }
  return keys;
}

function evidenceKeyForLocator(raw: string): string | null {
  const generated = generatedFileKey(raw);
  if (generated) return generated;
  const cleaned = raw.trim().replace(TRAILING_PATH_JUNK, "");
  return cleaned ? `img:${cleaned}` : null;
}

/** Stable keys for a real preview, image, or generated file. Tool names are not keys. */
export function artifactEvidenceKeys(text: string): string[] {
  MD_IMAGE_RE.lastIndex = 0;
  GENERATED_PATH_RE.lastIndex = 0;
  const keys = htmlEvidenceKeys(text);
  for (const match of text.matchAll(MD_IMAGE_RE)) {
    const key = evidenceKeyForLocator(match[1] ?? "");
    if (key) keys.push(key);
  }
  for (const match of text.matchAll(GENERATED_PATH_RE)) {
    const key = generatedFileKey(match[0]);
    if (key) keys.push(key);
  }
  return dedupe(keys);
}

/** Preview, image, or generated-file assistant rows stay beside the answer. */
export function assistantCarriesDeliverable(message: ChatMessage): boolean {
  if (message.role !== "assistant" || message._hideUnpublishedFallback === true) return false;
  const text = message.text ?? "";
  if (!text.trim()) return false;
  return artifactEvidenceKeys(text).length > 0;
}

function toolSucceeded(message: ChatMessage): boolean {
  return message.role === "tool" && message._completed === true && !message.error && !message._isError;
}

function commandOf(input: ToolInput): string {
  if (!input) return "";
  if (typeof input.command === "string") return input.command;
  if (typeof input.cmd === "string") return input.cmd;
  return "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A path the existing card will actually sign and render, not a mention in a log line. */
function renderedLocatorKey(raw: string): string | null {
  const generated = generatedFileKey(raw);
  if (generated) return generated;
  const cleaned = raw.trim().replace(TRAILING_PATH_JUNK, "");
  if (!cleaned || !safeArtifactSrc(cleaned)) return null;
  if (/\.(?:png|jpe?g|gif|webp|mp3|wav|m4a|flac|mp4|mov|webm)$/i.test(cleaned)) return `img:${cleaned}`;
  return `file:${cleaned}`;
}

function isInspectionTool(name: string): boolean {
  if (parseCodexTypeName(name) === "imageView") return true;
  const head = name.toLowerCase();
  return head === "read" || head === "view" || head.endsWith(":read") || head.endsWith(":view");
}

function imageGenerationKeys(name: string, input: ToolInput, output: string): string[] {
  const type = typeof input?.type === "string" ? input.type : "";
  if (parseCodexTypeName(name) !== "imageGeneration" && type !== "imageGeneration") return [];
  const keys: string[] = [];
  const arrow = /imageGeneration\s*→\s*(\S+)/.exec(output);
  if (arrow?.[1]) {
    const key = renderedLocatorKey(arrow[1]);
    if (key) keys.push(key);
  }
  const imagePath = /((?:\/[\w. -]+)+\.(?:png|jpe?g|webp|gif))/i.exec(output);
  if (imagePath?.[1]) {
    const key = renderedLocatorKey(imagePath[1]);
    if (key) keys.push(key);
  }
  return keys;
}

function minimaxOutputKeys(command: string, output: string): string[] {
  const cli = detectOcCli(command);
  if (cli !== "oc-minimax" && cli !== "mmx") return [];
  const subMatch = /(?:oc-minimax|mmx)\s+([a-z]+)/i.exec(command);
  const sub = (subMatch?.[1] ?? "").toLowerCase();
  const kind = sub === "lyric" ? "lyrics" : sub;
  if (kind !== "image" && kind !== "speech" && kind !== "music" && kind !== "video") return [];
  const keys: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const token = line.trim();
    if (!token || /^(?:billing|status):/i.test(token) || /^task_id:/i.test(token)) continue;
    if (!/\.(?:png|jpe?g|webp|gif|mp3|wav|m4a|flac|mp4|mov|webm)$/i.test(token)) continue;
    const key = renderedLocatorKey(token);
    if (key) keys.push(key);
  }
  return keys;
}

function isScreenshotTool(name: string, command: string): boolean {
  if (/browser_take_screenshot/i.test(name)) return true;
  if (detectOcCli(command) !== "oc-browser") return false;
  for (const match of command.matchAll(/oc-browser\s+([a-z-]+)/gi)) {
    if ((match[1] ?? "").toLowerCase() === "screenshot") return true;
  }
  return false;
}

function screenshotOutputKeys(name: string, command: string, output: string): string[] {
  if (!isScreenshotTool(name, command)) return [];
  const match = /\/[^\s"'<>]+\.(?:png|jpe?g|webp)/i.exec(output);
  if (!match) return [];
  const key = renderedLocatorKey(match[0]);
  return key ? [key] : [];
}

function artifactRecord(output: string, outputJson: unknown): Record<string, unknown> | null {
  const fromJson = asRecord(outputJson);
  if (typeof fromJson?.output === "string" || typeof fromJson?.qmd === "string") return fromJson;
  return asRecord(output);
}

function artifactOutputKeys(command: string, output: string, outputJson: unknown): string[] {
  const cli = detectOcCli(command);
  if (!cli || !ARTIFACT_CLIS.has(cli)) return [];
  const data = artifactRecord(output, outputJson);
  if (!data) return [];
  const keys: string[] = [];
  for (const field of ["output", "qmd"]) {
    const value = data[field];
    if (typeof value !== "string") continue;
    const key = renderedLocatorKey(value);
    if (key) keys.push(key);
  }
  return keys;
}

function outputEvidence(message: ChatMessage, displayOutput: string, outputJson: unknown): string {
  const parts = [displayOutput];
  const tail = message.bashTail?.tail;
  if (typeof tail === "string" && tail.trim() && !displayOutput.includes(tail)) parts.push(tail);
  if (typeof outputJson === "string") parts.push(outputJson);
  else if (outputJson !== undefined && outputJson !== null) {
    try {
      parts.push(JSON.stringify(outputJson));
    } catch {
      /* non-json output is not media evidence */
    }
  }
  return parts.join("\n");
}

/**
 * Media the existing tool card renders from a successful output/outputJson.
 * Request paths are ignored. Office CLI cards guess a download from the
 * command, and Read/imageView only inspect a file — neither is a deliverable.
 * Image generation, minimax/mmx, screenshots, and oc-report/slides/poster
 * stay up only when that card has a returned file it can actually show.
 * An html/htmlpreview fence in tool output is not media: no tool body mounts
 * HtmlPreview. Bash shows that fence as terminal text. Assistant fences still
 * use artifactEvidenceKeys.
 */
function renderedToolMediaKeys(message: ChatMessage): string[] {
  if (!toolSucceeded(message)) return [];
  let name = message.toolName ?? "";
  let input: ToolInput = null;
  let output = typeof message.output === "string" ? message.output : "";
  let outputJson = message.outputJson;
  try {
    const display = normalizeToolForDisplay(message);
    name = display.name || name;
    input = display.input;
    if (typeof display.tool.output === "string") output = display.tool.output;
    if (display.tool.outputJson !== undefined) outputJson = display.tool.outputJson;
  } catch {
    /* fall back to the raw tool row */
  }
  if (isInspectionTool(name)) return [];
  const command = commandOf(input);
  const evidence = outputEvidence(message, output, outputJson);
  return dedupe([
    ...imageGenerationKeys(name, input, evidence),
    ...minimaxOutputKeys(command, evidence),
    ...screenshotOutputKeys(name, command, evidence),
    ...artifactOutputKeys(command, output, outputJson),
  ]);
}

/**
 * A successful tool stays on the result layer only when its card renders media
 * the assistant does not already show.
 */
export function toolShowsUniqueArtifact(
  message: ChatMessage,
  assistantArtifactKeys?: ReadonlySet<string>,
): boolean {
  const keys = renderedToolMediaKeys(message);
  if (keys.length === 0) return false;
  const owned = assistantArtifactKeys ?? new Set<string>();
  return keys.some((key) => !owned.has(key));
}

function interactiveTool(message: ChatMessage): boolean {
  return INTERACTIVE_TOOL_RE.test(message.toolName ?? "");
}

/** CCB tools whose prompt card (role=permission) fully replaces the tool row. */
const PROMPT_CARD_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

/**
 * A CCB question or plan review lands twice: the prompt card (用户问答 /
 * 退出计划模式, role=permission, bound to the engine tool_use by `toolUseId`)
 * and the tool row of that same call (its result is the raw engine echo —
 * "User has answered your questions: …", "User has approved your plan…",
 * "User rejected the plan"). The card already shows the question / plan and
 * the outcome, and owns the pending / answered state, so the tool row is a
 * duplicate. Left in place it is caught by `interactiveTool` and sits outside
 * 处理过程 under the answered card.
 *
 * Returns the ids of tool rows to drop. Only an exact pairing counts — same
 * tool name and same tool_use id; a tool row whose card is missing (paged out,
 * lost history) stays.
 */
export function promptShadowedToolIds(messages: readonly ChatMessage[]): Set<string> {
  const promptKeys = new Set<string>();
  for (const message of messages) {
    const toolName = message.toolName ?? "";
    if (message.role === "permission" && PROMPT_CARD_TOOLS.has(toolName) && message.toolUseId) {
      promptKeys.add(`${toolName}\u0000${message.toolUseId}`);
    }
  }
  const ids = new Set<string>();
  if (promptKeys.size === 0) return ids;
  for (const message of messages) {
    const toolName = message.toolName ?? "";
    if (message.role !== "tool" || !PROMPT_CARD_TOOLS.has(toolName)) continue;
    const toolUseId = message.toolUseId ?? message.blockId;
    if (toolUseId && promptKeys.has(`${toolName}\u0000${toolUseId}`)) ids.add(message.id);
  }
  return ids;
}

/**
 * OCV5-307: a question / approval the user has already answered (allow or
 * skip/deny). It no longer needs the user, so it reads as one more step of the
 * turn and sits on the process rail instead of poking out as a separate card.
 * Unanswered, submitting (`_controlPending`) and expired-unanswered prompts
 * still need attention and stay on the top level. A shell that would hold only
 * answered prompts (no real work) is unwrapped by the caller, so a lone
 * question asked after the final answer keeps its old place.
 */
export function isAnsweredPrompt(message: ChatMessage): boolean {
  return message.role === "permission" && message._resolved === true && message._controlPending !== true;
}

function hasErrorMark(message: ChatMessage): boolean {
  return Boolean(message.error || message._isError || message._errorCode);
}

/** An assistant row that carries a turn error (model unavailable, engine error…). */
export function isErroredAssistant(message: ChatMessage): boolean {
  return message.role === "assistant" && hasErrorMark(message);
}

/**
 * OCV5-307: rows that render as a full card *inside* the process rail, always
 * visible while the shell is open: answered prompts, and an errored assistant
 * the turn recovered from (the caller only folds it when later work follows).
 * The narrative renderer hides errored rows, so these must not be narrative.
 */
export function isProcessCardMessage(message: ChatMessage): boolean {
  return isAnsweredPrompt(message) || isErroredAssistant(message);
}

/**
 * A delegated child that reached a terminal state — including failed / timed
 * out / errored. Like an ordinary tool miss it is one step of the turn; the
 * failure stays visible on the card inside the process.
 */
function finishedSubtask(message: ChatMessage): boolean {
  return message.role === "agent-group" || message.role === "delegate-progress";
}

/** A background child that has not reached a terminal status must stay on the top level. */
function liveBackgroundSubtask(message: ChatMessage): boolean {
  if (message.role !== "agent-group" && message.role !== "delegate-progress") return false;
  if (message._source === "server") return false;
  if (message._completed === true || message._delegateStatus === "ok") return false;
  if (message._isError || message.error) return false;
  if (message._delegateStatus === "failed" || message._delegateStatus === "timeout") return false;
  return message._background === true;
}

/**
 * A finished tool, thought, or plan that merely missed (missing path, empty
 * probe, nonzero exit). It stays inside the disclosure. The error fact is
 * unchanged; only the standalone card is avoided.
 */
function ordinaryToolMiss(message: ChatMessage): boolean {
  if (message.role !== "tool" && message.role !== "thinking" && message.role !== "plan") return false;
  return Boolean(message.error || message._isError || message._errorCode);
}

/**
 * Fold quiet process rows, including an ordinary tool miss. Rows that need
 * the user, a failed or still-running subtask, and a turn-level failure stay
 * outside. `final` means this assistant is the turn's visible answer
 * (including a deferred locator that will become that answer).
 */
export function isProcessMessage(
  message: ChatMessage,
  final: boolean,
  assistantArtifactKeys?: ReadonlySet<string>,
  /** The turn did more work after this row (caller-computed). Only used for errored assistants. */
  continued = false,
): boolean {
  if (message._turnStatusRecord || message._genPlaceholder || message._turnTapeProcess) {
    return false;
  }
  // OCV5-307: an error only keeps a row on the top level when it is the turn's
  // outcome. Tool/thought/plan misses, finished (incl. failed) subtasks and an
  // assistant error the turn continued past are steps — they fold like the rest.
  if (
    hasErrorMark(message) &&
    !ordinaryToolMiss(message) &&
    !finishedSubtask(message) &&
    !(continued && message.role === "assistant")
  ) {
    return false;
  }
  if ((message._delegateStatus === "failed" || message._delegateStatus === "timeout") && !finishedSubtask(message)) {
    return false;
  }
  if (liveBackgroundSubtask(message)) return false;
  if (isAnsweredPrompt(message)) return true;
  if (interactiveTool(message)) return false;
  if (toolShowsUniqueArtifact(message, assistantArtifactKeys)) return false;
  if (isHistoricalGoalRecord(message)) return true;
  if (message.role === "assistant") {
    if (assistantCarriesDeliverable(message)) return false;
    return !final;
  }
  return isFoldableWorkRole(message);
}

function commandHead(message: ChatMessage): string {
  const command = commandText(message).trim();
  const token = command.split(/\s+/)[0] ?? "";
  const base = token.split("/").pop() ?? token;
  return base.replace(/^['"]|['"]$/g, "");
}

function countLabel(message: ChatMessage): string {
  if (message.role === "tool") {
    const tool = (message.toolName ?? "").toLowerCase();
    const head = commandHead(message).toLowerCase();
    const verb = SHELL_TOOLS.has(tool) ? head : tool || head;
    if (verb === "read" || verb === "view" || verb === "cat") return "读取";
    if (verb === "edit" || verb === "write" || verb === "patch" || verb === "multiedit") return "编辑";
    if (verb === "grep" || verb === "rg" || verb === "glob" || verb === "find" || verb === "search") return "搜索";
    if (SEARCH_TOOL_TOKENS.has(toolToken(message.toolName ?? ""))) return "搜索";
    if (SHELL_TOOLS.has(tool) || verb === "bash" || verb === "sh" || verb === "exec") return "命令";
    return "工具";
  }
  if (message.role === "thinking") return "思考";
  if (message.role === "plan") return "计划";
  if (message.role === "goal") return "目标";
  if (message.role === "agent-group" || message.role === "delegate-progress") return "子任务";
  if (message.role === "permission") {
    if (message.toolName === "AskUserQuestion") return "问答";
    return /^exitplanmode$|exit_plan_mode/i.test(message.toolName ?? "") ? "计划确认" : "授权";
  }
  return "";
}

export function operationSummary(messages: readonly ChatMessage[]): string {
  const counts = new Map<string, number>();
  for (const message of messages) {
    if (isClearedGoalRecord(message)) continue;
    const label = countLabel(message);
    if (!label) continue;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  if (counts.size === 0) return "执行记录";
  return [...counts].map(([label, count]) => `${label} ${count} 项`).join(" · ");
}

export type ProcessSection<T> = {
  key: string;
  narrative: boolean;
  goal: boolean;
  /** Full cards on the rail (answered prompts, recovered errors): always visible, never behind a count toggle. */
  card?: boolean;
  items: T[];
  messages: ChatMessage[];
};

export function processSections<T>(
  items: readonly T[],
  messagesOf: (item: T) => ChatMessage[],
  keyOf: (item: T) => string,
): ProcessSection<T>[] {
  const sections: ProcessSection<T>[] = [];
  for (const item of items) {
    const messages = messagesOf(item);
    const card = messages.length > 0 && messages.every(isProcessCardMessage);
    const narrative = !card && messages.length > 0 && messages.every((message) => message.role === "assistant");
    const goal = !narrative && !card && messages.length > 0 && messages.every((message) => isHistoricalGoalRecord(message));
    const previous = sections.at(-1);
    if (!narrative && !goal && !card && previous && !previous.narrative && !previous.goal && !previous.card) {
      previous.items.push(item);
      previous.messages.push(...messages);
    } else {
      sections.push({ key: keyOf(item), narrative, goal, card, items: [item], messages: [...messages] });
    }
  }
  return sections;
}

function toolStillRunning(message: ChatMessage): boolean {
  return message.role === "tool" && !message._completed && !message.error && !message._isError;
}

function skipHeadSpace(command: string, index: number): number {
  while (index < command.length && /[\t \n]/.test(command[index] ?? "")) index += 1;
  return index;
}

/**
 * One shell word at the head. Quoted text stays inside the word, so a semicolon
 * in an argument is not a new command. `$`, backticks, or an unfinished quote
 * make the head unreliable and return null.
 */
function readHeadWord(command: string, index: number): { word: string; next: number } | null {
  let i = skipHeadSpace(command, index);
  if (i >= command.length) return { word: "", next: i };
  let word = "";
  let started = false;
  while (i < command.length) {
    const ch = command[i] ?? "";
    if (started && /[\t \n]/.test(ch)) break;
    if (!started && /[;&|<>()]/.test(ch)) return null;
    if (started && /[;&|<>()]/.test(ch)) break;
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return null;
      word += command.slice(i + 1, end);
      i = end + 1;
      started = true;
      continue;
    }
    if (ch === '"') {
      i += 1;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === "\\" ) {
          word += command[i + 1] ?? "";
          i += 2;
          continue;
        }
        if (command[i] === "$" || command[i] === "`") return null;
        word += command[i] ?? "";
        i += 1;
      }
      if (command[i] !== '"') return null;
      i += 1;
      started = true;
      continue;
    }
    if (ch === "$" || ch === "`" || ch === "\\") return null;
    word += ch;
    i += 1;
    started = true;
  }
  return { word, next: i };
}

/** First command only. Later statements and quoted lookalikes are ignored. */
function reliableHeadCall(command: string): { bin: string; op: string } | null {
  let i = 0;
  for (;;) {
    const word = readHeadWord(command, i);
    if (!word) return null;
    if (!word.word) return null;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word.word)) {
      i = word.next;
      continue;
    }
    const bin = word.word.split("/").pop() ?? "";
    const opWord = readHeadWord(command, word.next);
    if (!opWord) return null;
    return { bin, op: opWord.word.toLowerCase() };
  }
}

function toolToken(name: string): string {
  let token = name.trim();
  const lower = token.toLowerCase();
  const mcpAt = lower.indexOf("mcp__");
  if (mcpAt >= 0) {
    const segs = token.slice(mcpAt + 5).split("__");
    token = (segs.length >= 2 ? segs[segs.length - 1] : segs[0]) ?? token;
  } else if (lower.startsWith("codex:")) {
    token = token.slice(token.indexOf(":") + 1);
  }
  return token.replace(/-/g, "_").toLowerCase();
}

const SEARCH_TOOL_TOKENS = new Set([
  "grep",
  "glob",
  "websearch",
  "web_search",
  "webfetch",
  "web_fetch",
  "search_tool",
  "semantic_search",
  "semanticsearch",
  "list_dir",
  "glob_file_search",
  "globfilesearch",
]);

/**
 * Default live status. Tool metadata and command-position CLI verbs only —
 * never a substring of the arguments, and never the raw command, path, or job id.
 */
function runningToolPhrase(message: ChatMessage): string {
  const name = message.toolName ?? "";
  const command = stripShellWrapperForDisplay(commandText(message));
  const head = reliableHeadCall(command);
  if (head?.bin === "oc-memory") {
    if (head.op === "delegate-wait") return "等待子任务完成";
    if (head.op === "core-search" || head.op === "session-search" || head.op === "archival-search") return "正在搜索资料";
  }
  if (head?.bin === "oc-vision" && head.op === "understand") return "正在识别图片";
  if (head?.bin === "oc-browser" && head.op === "screenshot") return "工具执行中";
  if (/browser_take_screenshot/i.test(name)) return "工具执行中";

  const codex = parseCodexTypeName(name);
  const input = message.inputJson;
  const inputType =
    input && typeof input === "object" && !Array.isArray(input) && typeof (input as { type?: unknown }).type === "string"
      ? (input as { type: string }).type
      : "";
  const token = toolToken(name);
  if (
    codex === "imageGeneration" ||
    inputType === "imageGeneration" ||
    token === "imagegen" ||
    token === "image_gen" ||
    token === "image_generation" ||
    token === "generate_image"
  ) {
    return "正在生成图片";
  }
  if (codex === "imageView" || token === "view_image") return "正在查看图片";
  if (token === "understand_image") return "正在识别图片";
  if (isInspectionTool(name) || token === "read" || token === "read_file") return "正在读取文件";
  if (SEARCH_TOOL_TOKENS.has(token)) return "正在搜索资料";

  if (SHELL_TOOLS.has(token) || token === "bash" || token === "sh") {
    const bin = (head?.bin ?? "").toLowerCase();
    if (bin === "rg" || bin === "grep" || bin === "find") return "正在搜索资料";
    if (bin === "cat" || bin === "view") return "正在读取文件";
  }
  return actionPhrase(message);
}

const VERB_LEAD = /^(?:读|编|写|搜|查|调|生|创|删|启|进|退|停|委|等|压|抓|识|解|排|导|上|下|发|打|运|执|分|检|更|安|保|提|拉|推|合|比|转|翻|整|浏)/;

/**
 * OCV5-310: the generic live phrase names the kind of action instead of a flat
 * 「工具执行中」. Shell commands read 「正在运行命令」 — their meta label can come
 * from scanning the arguments, so only the reliable head (handled above) may say
 * more. Other tools use their registered Chinese label (a verb label reads
 * 「正在<label>」, a noun label 「正在使用<label>」); an unregistered tool, whose
 * label would just be its raw name, keeps the neutral 「工具执行中」.
 */
function actionPhrase(message: ChatMessage): string {
  try {
    const display = normalizeToolForDisplay(message);
    if (SHELL_TOOLS.has(toolToken(display.name)) || toolToken(display.name) === "bash" || toolToken(display.name) === "sh") {
      return "正在运行命令";
    }
    const label = (resolveToolMeta(display.name, null).label.split(/[:：]/)[0] ?? "").trim();
    if (!label || label === display.name || /^[\x00-\x7F]+$/.test(label)) return "工具执行中";
    return VERB_LEAD.test(label) ? `正在${label}` : `正在使用${label}`;
  } catch {
    return "工具执行中";
  }
}

function rawAuditCommand(message: ChatMessage): string {
  if (message.role !== "tool") return "";
  const original = commandText(message).trim();
  if (!original) return "";
  // Classify the unwrapped head, but show the command the transcript actually stored.
  const head = reliableHeadCall(stripShellWrapperForDisplay(original).trim());
  if (head?.bin !== "oc-memory") return "";
  if (head.op !== "delegate" && head.op !== "delegate-wait" && head.op !== "request-review") return "";
  return original;
}

/** Name plus a one-line status. Never the raw tool JSON or the full thinking trace.
 * A later completed sibling must not hide a tool that is still running.
 * `pending` is only the still-running status phrase. Finished and failed lines stay still. */
function stepLiveStatus(messages: readonly ChatMessage[]): { text: string; pending: boolean } {
  const work = messages.filter((message) => message.role !== "assistant" && message.role !== "user");
  const runningTool = [...work].reverse().find(toolStillRunning);
  const latest = runningTool ?? work.at(-1);
  if (!latest) return { text: "", pending: false };
  if (latest.role === "thinking") return { text: "正在思考", pending: true };
  if (latest.role === "plan") {
    return { text: (latest.text || "计划").replace(/\s+/g, " ").trim().slice(0, 48), pending: false };
  }
  if (latest.role === "agent-group" || latest.role === "delegate-progress") {
    return { text: (latest.text || "子任务").replace(/\s+/g, " ").trim().slice(0, 48), pending: true };
  }
  if (latest.role === "tool") {
    if (latest.error || latest._isError || latest._errorCode) {
      // The raw miss stays in the expanded card. The live line only says the step did not succeed.
      return { text: "未成功", pending: false };
    }
    if (!latest._completed) return { text: runningToolPhrase(latest), pending: true };
    return { text: "工具执行完成", pending: false };
  }
  return { text: countLabel(latest), pending: false };
}

// ── OCV5-310 时间轴呈现 ──────────────────────────────────────────────────────
// 外壳:一行标题(运行中 = 环形动效 + 当前动作 + 计时;结束 = 步骤数 + 单色图标统计)。
// 展开:一条竖向时间轴。中途说明是正文;连续的工具步骤收成一行人话摘要(「运行 7 条命令，
// 读取 1 个文件」,同原生 Claude Code);默认不露命令、路径、任务号,点开摘要才逐条列出,每条再
// 点开才看输出。「正在做什么」由外壳标题(动作 + 计时)和当前段节点的运行光晕表达。
// 状态色只给运行中 / 未成功 / 受阻。

type NodeTone = "live" | "error" | "warning" | "idle";

const KIND_ICON: Record<string, LucideIcon> = {
  命令: Terminal,
  读取: FileText,
  编辑: Pencil,
  搜索: Search,
  工具: Wrench,
  思考: Brain,
  计划: ListTodo,
  目标: Target,
  子任务: Bot,
  问答: MessageCircleQuestion,
  授权: ShieldCheck,
  计划确认: ListChecks,
};

function firstCounted(messages: readonly ChatMessage[]): ChatMessage | undefined {
  return messages.find((message) => !isClearedGoalRecord(message) && countLabel(message));
}

/** 时间轴节点:图标跟着步骤种类走,颜色只跟状态走(运行中 / 未成功 / 受阻)。 */
function stepNode(messages: readonly ChatMessage[], live: boolean): { Icon: LucideIcon; tone: NodeTone } {
  const head = firstCounted(messages) ?? messages[0];
  if (!head) return { Icon: Circle, tone: "idle" };
  if (head.role === "tool") {
    try {
      const display = normalizeToolForDisplay(head);
      const meta = resolveToolMeta(display.name, display.input);
      const status = resolveToolStatus(display);
      // OCV5-313: 过程里的单步未成功 / 受阻是正常工作流的一部分,节点不染红/黄,与其他步骤同色。
      const tone: NodeTone = status.isRunning && live ? "live" : "idle";
      return { Icon: meta.icon, tone };
    } catch {
      return { Icon: Wrench, tone: "idle" };
    }
  }
  if (head.role === "permission") {
    return { Icon: head.toolName === "AskUserQuestion" ? MessageCircleQuestion : ShieldCheck, tone: "idle" };
  }
  if (isErroredAssistant(head)) return { Icon: TriangleAlert, tone: "warning" };
  if (head.role === "agent-group" || head.role === "delegate-progress") {
    const failed = hasErrorMark(head) || head._delegateStatus === "failed" || head._delegateStatus === "timeout";
    const done = head._completed === true || head._delegateStatus === "ok";
    return { Icon: Bot, tone: live && !done && !failed ? "live" : "idle" };
  }
  if (head.role === "thinking") return { Icon: Brain, tone: live ? "live" : "idle" };
  const Icon = KIND_ICON[countLabel(head)] ?? Circle;
  return { Icon, tone: "idle" };
}

const NODE_TONE: Record<NodeTone, string> = {
  live: "oc-step-node-live text-accent ring-accent/45",
  error: "text-danger ring-danger/35 bg-[color-mix(in_srgb,var(--danger)_9%,var(--bg))]",
  warning: "text-warning ring-warning/40 bg-[color-mix(in_srgb,var(--warning)_10%,var(--bg))]",
  idle: "text-faint ring-border",
};

function StepNode({ Icon, tone }: { Icon: LucideIcon; tone: NodeTone }) {
  return (
    <span
      aria-hidden
      data-testid="process-step-node"
      data-tone={tone}
      className={`relative z-[1] mt-1.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-bg ring-1 transition-colors duration-300 [@media(hover:none)]:mt-2.5 ${NODE_TONE[tone]}`}
    >
      <Icon size={12.5} strokeWidth={2} />
    </span>
  );
}

/** 运行中的外壳标志:一圈慢转的弧光 + 呼吸的中心点;结束后换成安静的对勾。 */
function ShellGlyph({ active }: { active: boolean }) {
  if (active) {
    return (
      <span aria-hidden data-testid="process-glyph-live" className="oc-orbit relative flex size-6 shrink-0 items-center justify-center">
        <span className="oc-orbit-core size-2 rounded-full bg-accent" />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      data-testid="process-glyph-done"
      className="flex size-6 shrink-0 items-center justify-center rounded-full bg-hover text-muted"
    >
      <Check size={13} strokeWidth={2.25} />
    </span>
  );
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} 分 ${String(total % 60).padStart(2, "0")} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

/** 只在本轮进行中、且有可信起点(本轮活动的 startedAt)时计时;没有就不显示,绝不编。 */
function useElapsed(startedAt: number | null | undefined, active: boolean): string {
  const valid = active && typeof startedAt === "number" && Number.isFinite(startedAt) && startedAt > 0;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!valid) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [valid]);
  if (!valid) return "";
  const ms = now - (startedAt as number);
  if (ms < 0 || ms > 24 * 3600_000) return "";
  return formatElapsed(ms);
}

/** 1s 一跳的「现在」。只在有可信时间源时开表,结束即停。 */
function useNowTicker(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [enabled]);
  return now;
}

/** 叙述段写完、下一步还没冒出来时,静默多久才在时间轴末尾挂「正在思考下一步」(避免步骤间闪一下)。 */
const QUIET_TAIL_MS = 3_000;
/** 当前步骤里的工具连续跑多久才在摘要行旁显示「已运行 N 秒」。 */
const RUNNING_META_MS = 5_000;

/** 当前段里仍在运行的工具中最早的开始时刻(行的 ts = 工具调用到达浏览器的时刻)。不早于本轮起点。 */
function earliestRunningSince(messages: readonly ChatMessage[], turnStartedAt: number | null | undefined): number | null {
  let since: number | null = null;
  for (const message of messages) {
    if (!toolStillRunning(message)) continue;
    const ts = message.ts;
    if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) continue;
    if (typeof turnStartedAt === "number" && Number.isFinite(turnStartedAt) && ts < turnStartedAt) continue;
    if (since === null || ts < since) since = ts;
  }
  return since;
}

function stepItemCount<T>(sections: readonly ProcessSection<T>[], messagesOf: (item: T) => ChatMessage[]): number {
  let count = 0;
  for (const section of sections) {
    if (section.narrative) continue;
    for (const item of section.items) if (firstCounted(messagesOf(item))) count += 1;
  }
  return count;
}

function kindTally<T>(sections: readonly ProcessSection<T>[], messagesOf: (item: T) => ChatMessage[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const section of sections) {
    if (section.narrative) continue;
    for (const item of section.items) {
      const head = firstCounted(messagesOf(item));
      if (!head) continue;
      const label = countLabel(head);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1]);
}

/** 外壳标题上的实时动作:当前那一段的最新动作;一步刚跑完、下一步还没来时是「正在思考下一步」。 */
function shellLivePhrase<T>(
  sections: readonly ProcessSection<T>[],
  currentIndex: number,
  narrativeSettled = false,
): { text: string; pending: boolean } {
  const current = sections[currentIndex];
  if (!current) return { text: "正在处理", pending: true };
  // 叙述段已经写完一阵、下一步还没来:模型在想下一步,不是还在写这段话。
  if (current.narrative) return { text: narrativeSettled ? "正在思考下一步" : "正在组织回复", pending: true };
  const status = stepLiveStatus(current.messages);
  if (!status.text) return { text: "正在处理", pending: true };
  if (status.pending) return status;
  return { text: "正在思考下一步", pending: true };
}

const KIND_PHRASE: Record<string, (n: number) => string> = {
  命令: (n) => `运行 ${n} 条命令`,
  读取: (n) => `读取 ${n} 个文件`,
  编辑: (n) => `编辑 ${n} 处`,
  搜索: (n) => `搜索 ${n} 次`,
  工具: (n) => `调用 ${n} 次工具`,
  思考: (n) => (n > 1 ? `思考 ${n} 次` : "思考"),
  计划: (n) => (n > 1 ? `更新 ${n} 次计划` : "更新计划"),
  目标: (n) => `${n} 条目标记录`,
  子任务: (n) => `${n} 个子任务`,
  问答: (n) => `${n} 次问答`,
  授权: (n) => `${n} 次授权`,
  计划确认: (n) => `${n} 次计划确认`,
};

/** 一段步骤的人话摘要:「运行 7 条命令，读取 1 个文件」。按出现先后排,同类合并。 */
export function naturalSummary(items: readonly (readonly ChatMessage[])[]): string {
  const counts = new Map<string, number>();
  for (const rows of items) {
    const head = firstCounted(rows);
    if (!head) continue;
    const label = countLabel(head);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  if (counts.size === 0) return "执行记录";
  return [...counts].map(([label, n]) => (KIND_PHRASE[label] ?? ((k: number) => `${label} ${k} 项`))(n)).join("，");
}

/** 一段的节点:段里有在跑的就是运行态;图标取段内最多的那类。未成功在摘要行右侧单独标出,不把整段染红。 */
function groupNode(messages: readonly ChatMessage[], current: boolean): { Icon: LucideIcon; tone: NodeTone } {
  const counts = new Map<string, number>();
  for (const message of messages) {
    if (isClearedGoalRecord(message)) continue;
    const label = countLabel(message);
    if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const top = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  const Icon = KIND_ICON[top] ?? Wrench;
  const last = messages.at(-1);
  const live = current && (messages.some(toolStillRunning) || last?.role === "thinking");
  return { Icon, tone: live ? "live" : "idle" };
}

const shellToggleClass =
  "group/shell -mx-1.5 flex min-h-10 w-[calc(100%+0.75rem)] items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left transition-colors duration-150 hover:bg-hover/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [@media(hover:none)]:min-h-11";

function StageText({ message, live = false }: { message: ChatMessage; live?: boolean }) {
  // Same suppression as AssistantCard: an unpublished fallback must not
  // reappear just because the row was grouped into the process. The body
  // itself is ProgressiveMarkdown, the final answer's renderer, with no
  // extra size or color on the wrapper. Only the current live stage keeps
  // the streaming tail; a finished or reopened stage uses the normal pager.
  if (message._payloadDeferred || message._hideUnpublishedFallback === true) return null;
  if (message.error || message._isError || message._errorCode) return null;
  const text = message.text ?? "";
  if (!text.trim()) return null;
  return (
    <div
      data-testid="process-stage"
      data-find-member={timelineMessageKey(message)}
      className="min-w-0"
    >
      <ProgressiveMarkdown text={text} live={live} />
    </div>
  );
}

/** 时间轴上的一行:左列节点,右列内容。内容列与节点中心对齐到同一条竖线。 */
function RailRow({
  node,
  children,
  enter,
  testId,
}: {
  node: ReactNode;
  children: ReactNode;
  enter: boolean;
  testId?: string;
}) {
  return (
    <div data-testid={testId} className={enter ? "oc-step-enter relative flex gap-3" : "relative flex gap-3"}>
      {node}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** 叙述段(中途的说明文字)在时间轴上只挂一颗小圆点,正文与步骤标题左缘对齐。 */
function NarrativeDot() {
  return (
    <span aria-hidden className="relative z-[1] flex w-6 shrink-0 justify-center pt-[9px]">
      <span className="size-1.5 rounded-full bg-border-strong ring-4 ring-bg" />
    </span>
  );
}

export function ProcessDisclosure<T>({
  sections,
  active,
  open,
  setOpen,
  detailOpen,
  setDetailOpen,
  renderItem,
  keyOf,
  messagesOf,
  eagerDeferred,
  olderSteps,
  startedAt,
  lastFrameAt,
  turnStartedAt,
  turnEndedAt,
}: {
  sections: ProcessSection<T>[];
  active: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
  detailOpen: (key: string) => boolean;
  setDetailOpen: (key: string, open: boolean) => void;
  renderItem: (item: T) => ReactNode;
  keyOf: (item: T) => string;
  messagesOf: (item: T) => ChatMessage[];
  /** Tail locators keep hydrating while the disclosure stays collapsed. */
  eagerDeferred: boolean;
  /** Unloaded earlier steps of this same turn. Stays inside the shell. */
  olderSteps?: ReactNode;
  /** 本轮活动起点(TurnActivity.startedAt)。只用于进行中的计时,缺省则不显示时长。 */
  startedAt?: number | null;
  /**
   * 本会话最近一帧到达浏览器的时刻(会话级 _lastFrameAt)。只用于进行中的「静默多久」判断:
   * 叙述段写完后迟迟没有下一步时,在时间轴末尾挂一行「正在思考下一步」;工具长时间运行时在
   * 摘要行旁显示已运行时长。缺省(历史轮、单测)则两者都不出现。
   */
  lastFrameAt?: number | null;
  /** OCV5-367: 本轮起点(进行中 = 本轮活动起点;历史 = 本轮用户消息时刻),首步耗时从这里算。 */
  turnStartedAt?: number | null;
  /** OCV5-367: 过程之后第一行(本轮回答)的到达时刻,末步没有自身终点时以它收尾。 */
  turnEndedAt?: number | null;
}) {
  const messages = sections.flatMap((section) => section.messages);
  // OCV5-367: 每一步的耗时(自上一步结束到本步结束)。按值签名缓存,数值不变时 Map 引用不变,
  // 步骤行(在 memo 边界之下读 context)不会被每一帧无谓重渲。
  const computedTimings = computeStepTimings(messages, { turnStartedAt, turnEndedAt, active });
  const timingsSig = stepTimingsSignature(computedTimings);
  const timingsRef = useRef<{ sig: string; map: typeof computedTimings } | null>(null);
  if (timingsRef.current?.sig !== timingsSig) timingsRef.current = { sig: timingsSig, map: computedTimings };
  const stepTimings = timingsRef.current.map;
  const summary = operationSummary(messages);
  // Cleared/completed goals are diagnostics, not a new step. They must not
  // take the current-stage identity from the work still in progress.
  let currentIndex = -1;
  for (let i = sections.length - 1; i >= 0; i -= 1) {
    if (!sections[i]?.goal && !sections[i]?.card) {
      currentIndex = i;
      break;
    }
  }
  const steps = stepItemCount(sections, messagesOf);
  const tally = kindTally(sections, messagesOf);
  // 详情面板入口(OCV5-370):本轮改过文件 → 常显「改动 N 个文件」,点开面板的改动页;
  // 只有其它步骤 → 一个安静的面板图标(桌面悬停 / 触屏常显),点开步骤页。
  const openPane = useArtifactInspect().openPane;
  const processRows = openPane ? sections.flatMap((section) => section.items.flatMap((item) => messagesOf(item))) : [];
  const changedFiles = openPane ? toolChangedFileCount(processRows) : 0;
  const hasToolRows = processRows.some((message) => message.role === "tool");
  const elapsed = useElapsed(startedAt, active);
  // 长步骤 / 步骤间隙的活性信号。当前段是叙述(中途说明)时原本不挂任何动效——流式文字本身就是信号;
  // 但文字写完后模型可能还要想很久、或下一条命令还没到,整屏就没有任何「还在干活」的迹象,
  // 用户只能看到一段静止的文字(外壳标题的计时在长过程里早已滚出视口)。
  const liveClock = active && typeof lastFrameAt === "number" && Number.isFinite(lastFrameAt) && lastFrameAt > 0;
  const now = useNowTicker(liveClock);
  const currentSection = currentIndex >= 0 ? sections[currentIndex] : undefined;
  const quietMs = liveClock ? Math.max(0, now - (lastFrameAt as number)) : 0;
  const narrativeSettled = liveClock && !!currentSection?.narrative && quietMs >= QUIET_TAIL_MS;
  const runningSince =
    liveClock && currentSection && !currentSection.narrative ? earliestRunningSince(currentSection.messages, startedAt) : null;
  const runningMs = runningSince === null ? 0 : now - runningSince;
  const runningFor = runningSince !== null && runningMs >= RUNNING_META_MS && runningMs <= 24 * 3600_000 ? formatElapsed(runningMs) : "";
  const live = active ? shellLivePhrase(sections, currentIndex, narrativeSettled) : null;
  const title = active ? "处理过程" : "工作过程";
  // 历史轮挂载时不播入场动画,只有进行中新冒出来的步骤才轻轻浮入。
  const lastSection = sections.at(-1);
  const lastItem = lastSection?.items.at(-1);
  const lastItemKey = lastItem === undefined ? "" : keyOf(lastItem);

  const clippedDeferred = (item: T) =>
    eagerDeferred && messagesOf(item).some((message) => message._payloadDeferred) ? (
      <div key={`deferred:${keyOf(item)}`} className="h-px overflow-hidden" data-testid="process-deferred-hydrate" aria-hidden>
        {renderItem(item)}
      </div>
    ) : null;

  const narrativeBody = (section: ProcessSection<T>, isLive: boolean) => (
    <div className="space-y-1">
      {section.items.map((item) => {
        const rows = messagesOf(item);
        if (rows.some((message) => message._payloadDeferred)) {
          return <div key={keyOf(item)}>{renderItem(item)}</div>;
        }
        return (
          <div key={keyOf(item)} className="space-y-1">
            {rows.map((message) => (
              <StageText key={message.id} message={message} live={isLive} />
            ))}
          </div>
        );
      })}
    </div>
  );

  const stepRow = (item: T, isLastOfProcess: boolean) => {
    const rows = messagesOf(item);
    const key = keyOf(item);
    const deferred = rows.some((message) => message._payloadDeferred);
    const node = stepNode(rows, active && isLastOfProcess);
    // 只有工具 / 思考行换成时间轴行样式;子任务、计划等仍用原卡(它们自带结构)。
    const inline = !deferred && rows.length > 0 && rows.every((message) => message.role === "tool" || message.role === "thinking");
    return (
      <RailRow key={key} testId="process-step" node={<StepNode Icon={node.Icon} tone={node.tone} />} enter={active && key === lastItemKey}>
        <div className={inline ? "" : "py-1"}>
          <ProcessStepContext.Provider value={inline}>{renderItem(item)}</ProcessStepContext.Provider>
        </div>
        {rows.map((message) => {
          const raw = rawAuditCommand(message);
          if (!raw) return null;
          return (
            <pre
              key={`${message.id}:raw`}
              data-testid="process-raw-command"
              className="mb-1 mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-hover/60 px-2 py-1 font-mono text-xs text-muted"
            >
              {raw}
            </pre>
          );
        })}
      </RailRow>
    );
  };

  return (
    <StepTimingContext.Provider value={stepTimings}>
    <section
      data-testid="process-disclosure"
      data-process-active={active ? "true" : "false"}
      className="min-w-0"
    >
      <div className="group/shellrow -mx-1.5 flex w-[calc(100%+0.75rem)] min-w-0 items-center gap-1">
      <button
        type="button"
        className={cn(shellToggleClass, "mx-0 w-auto min-w-0 flex-1")}
        aria-expanded={open}
        data-testid="process-toggle"
        onClick={() => setOpen(!open)}
      >
        <ShellGlyph active={active} />
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          {live ? (
            <span
              key={live.text}
              data-testid="process-step-live"
              data-live-pending={live.pending ? "true" : "false"}
              className={`oc-swap-in min-w-0 truncate text-body font-medium ${!open ? `text-muted ${live.pending ? "oc-live-status-shine" : ""}` : "text-faint"}`}
            >
              {live.text}
            </span>
          ) : (
            <span className="shrink-0 text-body font-medium text-faint" data-testid="process-title">
              {steps > 0 ? `已执行 ${steps} 个步骤` : title}
            </span>
          )}
          <span className="sr-only">{`${title} · ${summary}`}</span>
          {active ? (
            <span className="shrink-0 whitespace-nowrap text-meta tabular-nums text-faint" data-testid="process-meta">
              {[elapsed, steps > 0 ? `${steps} 步` : ""].filter(Boolean).join(" · ")}
            </span>
          ) : tally.length > 0 ? (
            <span aria-hidden className="flex min-w-0 items-center gap-2.5 overflow-hidden text-meta tabular-nums text-muted" data-testid="process-tally">
              {tally.slice(0, 5).map(([label, count], index) => {
                const Icon = KIND_ICON[label] ?? Wrench;
                return (
                  <span
                    key={label}
                    className={index >= 3 ? "hidden shrink-0 items-center gap-1 sm:inline-flex" : "inline-flex shrink-0 items-center gap-1"}
                    title={`${label} ${count}`}
                  >
                    <Icon size={12} strokeWidth={2} className="text-faint" />
                    {count}
                  </span>
                );
              })}
            </span>
          ) : null}
        </span>
        <ChevronDown
          size={15}
          aria-hidden
          className={`shrink-0 text-faint transition-transform duration-300 ease-[var(--ease-spring)] group-hover/shell:text-muted ${open ? "rotate-180" : ""}`}
        />
      </button>
      {openPane && changedFiles > 0 ? (
        <button
          type="button"
          data-testid="process-pane-changes"
          className="inline-flex min-h-8 shrink-0 items-center gap-1 rounded-full border border-border px-2.5 text-meta text-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11"
          title="在详情面板查看这一轮的产出"
          onClick={() => openPane("outputs", processRows[0])}
        >
          <Pencil size={12} aria-hidden className="text-faint" />
          {/* 手机上省掉「改动」二字,给左边的步骤统计留位置;读屏仍念全句。 */}
          <span className="sr-only sm:not-sr-only">改动 </span>
          {changedFiles} 个文件
        </button>
      ) : openPane && hasToolRows ? (
        <button
          type="button"
          data-testid="process-pane-steps"
          aria-label="在详情面板查看步骤"
          title="在详情面板查看步骤"
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-faint opacity-0 outline-none transition-opacity hover:bg-hover hover:text-fg focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/shellrow:opacity-100 [@media(hover:none)]:size-11 [@media(hover:none)]:opacity-100"
          onClick={() => openPane("steps")}
        >
          <PanelRight size={15} />
        </button>
      ) : null}
      </div>
      {!open
        ? sections.flatMap((section) => section.items.map((item) => clippedDeferred(item)))
        : null}
      {(olderSteps || open) ? (
          <div
            className={`oc-rail relative mt-1 space-y-0.5 pb-1 ${open ? "oc-reveal" : ""}`}
            data-testid={open ? "process-stages" : "process-older-steps"}
          >
            {olderSteps ? <div className="pl-9">{olderSteps}</div> : null}
            {open ? sections.map((section, index) => {
              const isLastSection = index === sections.length - 1;
              if (section.card) {
                // 过程里常显的整卡步骤:已回答的问答/审批(用户的选择是这轮的关键事实)、
                // 本轮已越过的中途错误(模型不可用等)。用原卡渲染,不藏在「N 项」后面。
                const node = stepNode(section.messages, false);
                return (
                  <RailRow key={section.key} testId="process-card" node={<StepNode Icon={node.Icon} tone={node.tone} />} enter={false}>
                    <div className="min-w-0 space-y-1.5 py-1">
                      {/* 能进过程的错误卡都已被本轮越过:不再给重试/切换模型/从断点继续(会重复开工)。 */}
                      <RecoveredStepContext.Provider value>
                        {section.items.map((item) => (
                          <div key={keyOf(item)}>{renderItem(item)}</div>
                        ))}
                      </RecoveredStepContext.Provider>
                    </div>
                  </RailRow>
                );
              }
              if (section.goal) {
                return (
                  <RailRow key={section.key} testId="process-goal" node={<StepNode Icon={Target} tone="idle" />} enter={false}>
                    <div className="py-1">
                      {section.items.map((item) => (
                        <div key={keyOf(item)}>{renderItem(item)}</div>
                      ))}
                    </div>
                  </RailRow>
                );
              }
              if (section.narrative) {
                const current = active && index === currentIndex;
                // Intermediate replies stay fully readable for the whole turn.
                // A one-line stage hid text the reader had already seen, then
                // showed it again only after the turn ended. Tool groups still
                // collapse. Only the current stage is live.
                return (
                  <RailRow key={section.key} node={<NarrativeDot />} enter={false}>
                    <div className="py-1">{narrativeBody(section, current)}</div>
                  </RailRow>
                );
              }
              const details = detailOpen(section.key);
              const current = active && index === currentIndex;
              const group = groupNode(section.messages, current);
              // OCV5-312: 流光挂在「正在干活」的这一段摘要行上(当前段、本轮仍在进行),表明 agent 此刻在做什么;
              // 其余过程文字一律 --faint,让下方 agent 的回复正文更突出。当前在写正文(叙述段)时不挂流光,流式文字本身就是信号。
              // 有意为之:干活行的回落色是 --muted(比完成行略实)。流光与节点光晕在 reduced-motion / 不支持
              // background-clip:text 时都不生效,这一档静态差异是那时唯一能指出「哪一行在干活」的线索;
              // 动效正常时流光静止色本就是 --faint,观感与其余过程行一致。
              const working = active && index === currentIndex;
              const groupTiming = working ? undefined : combineStepTimings(stepTimings, section.messages.map((message) => message.id));
              return (
                <div key={section.key} className="space-y-0.5" data-testid="process-step-group">
                  <RailRow node={<StepNode Icon={group.Icon} tone={group.tone} />} enter={false}>
                    <button
                      type="button"
                      className="group/sum -mx-2 flex min-h-9 w-[calc(100%+1rem)] items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-150 hover:bg-hover/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [@media(hover:none)]:min-h-11"
                      aria-expanded={details}
                      data-testid="process-detail-toggle"
                      onClick={() => setDetailOpen(section.key, !details)}
                    >
                      <span
                        data-testid="process-group-summary"
                        data-live-working={working ? "true" : "false"}
                        className={`min-w-0 truncate text-body ${working ? "oc-live-status-shine text-muted" : "text-faint"}`}
                      >
                        {naturalSummary(section.items.map(messagesOf))}
                      </span>
                      {working && runningFor ? (
                        // 长命令 / 长工具:流光之外再给一个每秒在走的数字,一眼看出「还在跑、跑了多久」。
                        // 读屏不播报每秒变化的时长。
                        <span
                          aria-hidden
                          data-testid="process-step-running-for"
                          className="shrink-0 whitespace-nowrap text-meta tabular-nums text-faint"
                        >
                          {`已运行 ${runningFor}`}
                        </span>
                      ) : groupTiming?.ms !== undefined ? (
                        // OCV5-367: 折叠的步骤组给出这一组合计用时(组内每一步都有可信时间才给)。
                        <span
                          data-testid="process-group-duration"
                          className="shrink-0 whitespace-nowrap text-meta tabular-nums text-faint"
                          title={`这一组步骤共用时 ${formatStepDuration(groupTiming.ms)}`}
                        >
                          {formatStepDuration(groupTiming.ms)}
                        </span>
                      ) : null}
                      <span className="sr-only">{operationSummary(section.messages)}</span>
                      {/* OCV5-313: 不在摘要行单独点出「N 步未成功」——中途个别步骤没成功是正常流程,
                          事实留在展开后的步骤行里(安静的灰字),整轮失败另有顶层错误卡。 */}
                      <ChevronRight
                        size={14}
                        aria-hidden
                        className={`ml-auto shrink-0 text-faint transition-transform duration-200 ease-[var(--ease-spring)] group-hover/sum:text-muted ${details ? "rotate-90" : ""}`}
                      />
                    </button>
                  </RailRow>
                  {details ? (
                    <div className="space-y-0.5" data-testid="process-details">
                      {section.items.map((item, i) => stepRow(item, isLastSection && i === section.items.length - 1))}
                    </div>
                  ) : (
                    section.items.map((item) => clippedDeferred(item))
                  )}
                </div>
              );
            }) : null}
            {open && narrativeSettled ? (
              // 叙述段写完、下一步还没到:在最新进展处挂一行活的「正在思考下一步」+ 静默时长。
              // 下一步一冒出来(新帧到达、当前段换成步骤组)这行就消失,流光随之落到那一段的摘要行上。
              <RailRow key="__live-tail" testId="process-live-tail" node={<StepNode Icon={Brain} tone="live" />} enter>
                <div className="flex min-h-9 items-center gap-2 py-1.5 [@media(hover:none)]:min-h-11">
                  <span className="oc-live-status-shine min-w-0 truncate text-body text-muted">正在思考下一步</span>
                  <span aria-hidden className="shrink-0 whitespace-nowrap text-meta tabular-nums text-faint">
                    {formatElapsed(quietMs)}
                  </span>
                </div>
              </RailRow>
            ) : null}
          </div>
        ) : null}
    </section>
    </StepTimingContext.Provider>
  );
}
