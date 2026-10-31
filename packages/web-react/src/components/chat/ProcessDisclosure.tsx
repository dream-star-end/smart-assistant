import { ChevronDown, PanelRight, Pencil } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { type ChatMessage, isRetryingTurnStatus, isServerAuthoredRow } from "../../lib/chat/model";
import { agentTerminalStatus } from "../../lib/chat/render";
import { agentDisplayName } from "./agentNames";
import { STATUS } from "../../lib/ui/statusTone";
import { ProgressiveMarkdown, RecoveredStepContext, type CardCallbacks } from "./cards";
import { normalizeToolForDisplay, parseCodexTypeName, stripShellWrapperForDisplay, type ToolInput } from "../tool/format";
import { detectOcCli, humanStepTitle, resolveToolMeta } from "../tool/meta";
import { resolveToolStatus } from "../tool/status";
import { FirstTextPaintCommitProbe } from "./FirstTextPaintCommitProbe";
import { timelineMessageKey } from "./findInSession";
import { ProcessStepContext } from "./processStep";
import { StepMetaBadge, StepTimingContext } from "./stepDuration";
import type { DisplayTokenUsage } from "./tokenUsage";
import type { TurnActivityInfo } from "./TurnActivity";
import { combineStepTimings, computeStepTimings, formatStepDuration, stepTimingsSignature } from "../../lib/chat/stepTiming";
import { safeArtifactSrc } from "../tool/artifactSrc";
import { useArtifactInspect } from "../tool/context";
import { cn } from "../../lib/utils";
import { toolChangedFileCount } from "./workPane";
import { ProcessStages } from "./lazyProcessStages";

// 展开时间轴只从外壳拿这些符号。懒块若直接 import cards / meta / status,
// rolldown 会把它们和 api+protocol 重新并进首屏 styles 块。
export {
  FirstTextPaintCommitProbe,
  ProcessStepContext,
  ProgressiveMarkdown,
  RecoveredStepContext,
  StepMetaBadge,
  StepTimingContext,
  combineStepTimings,
  formatStepDuration,
  humanStepTitle,
  normalizeToolForDisplay,
  resolveToolMeta,
  resolveToolStatus,
  timelineMessageKey,
};
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
  /ask_user|request_user_input|present_options|present_task_approval|exit_plan_mode|exitplanmode/i;

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
/** `cat > f <<'EOF'`、`cat a >> b`:首词是 cat,其实是写文件(`2>`、`>&2` 不算)。 */
const CAT_WRITE_RE = /(?:^|[^0-9&<>])>>?\s*[^\s&|>]/;

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

/**
 * OCV5-422: the timeline asks for every assistant row's keys on each streamed notify (fold decisions,
 * deliverable rows). The result only depends on the text, so it is cached by text; finished rows hit.
 * A streaming row's text is new on every delta, so the cache is simply dropped when it grows past the cap.
 */
const ARTIFACT_KEYS_CACHE_MAX = 2000;
const artifactKeysCache = new Map<string, readonly string[]>();

/** Stable keys for a real preview, image, or generated file. Tool names are not keys. */
export function artifactEvidenceKeys(text: string): readonly string[] {
  const cached = artifactKeysCache.get(text);
  if (cached) return cached;
  const keys = computeArtifactEvidenceKeys(text);
  if (artifactKeysCache.size >= ARTIFACT_KEYS_CACHE_MAX) artifactKeysCache.clear();
  artifactKeysCache.set(text, keys);
  return keys;
}

function computeArtifactEvidenceKeys(text: string): readonly string[] {
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
  return Object.freeze(dedupe(keys));
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
 * Image generation, minimax/mmx, and oc-report/slides/poster stay up only
 * when that card has a returned file it can actually show. Browser steps
 * (oc-browser / MCP browser_*) never do (OCV5-374): a screenshot is the agent
 * checking its own work even when it lands in generated/ — the step folds, the
 * shot shows on its card inside 处理过程 and in the detail pane (产出 / 浏览器).
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

/** CCB tools whose prompt card (role=permission) fully replaces the tool row. */
const PROMPT_CARD_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

/**
 * A tool row the user acts on. AskUserQuestion / ExitPlanMode rows never are:
 * the question / plan is answered on the prompt card, the row only carries the
 * engine echo. That card is local to this browser — another device, a refresh,
 * a durable-replay owner reset (drops answered cards) or a Cursor detached card
 * (no toolUseId) leaves the row unpaired, and it used to stay outside 处理过程.
 * Whether a question still needs the user is the card's call (isAnsweredPrompt).
 */
function interactiveTool(message: ChatMessage): boolean {
  const name = message.toolName ?? "";
  return !PROMPT_CARD_TOOLS.has(name) && INTERACTIVE_TOOL_RE.test(name);
}

/**
 * A CCB question or plan review lands twice: the prompt card (用户问答 /
 * 退出计划模式, role=permission, bound to the engine tool_use by `toolUseId`)
 * and the tool row of that same call (its result is the raw engine echo —
 * "User has answered your questions: …", "User has approved your plan…",
 * "User rejected the plan"). The card already shows the question / plan and
 * the outcome, and owns the pending / answered state, so the tool row is a
 * duplicate.
 *
 * Returns the ids of tool rows to drop. Only an exact pairing counts — same
 * tool name and same tool_use id; a tool row whose card is missing (paged out,
 * lost history) stays, as one step inside 处理过程.
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

export function hasErrorMark(message: ChatMessage): boolean {
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

export function countLabel(message: ChatMessage): string {
  if (message.role === "tool") {
    const tool = (message.toolName ?? "").toLowerCase();
    const head = commandHead(message).toLowerCase();
    const verb = SHELL_TOOLS.has(tool) ? head : tool || head;
    if (verb === "cat" && CAT_WRITE_RE.test(commandText(message))) return "编辑";
    if (verb === "read" || verb === "view" || verb === "cat") return "读取";
    if (verb === "edit" || verb === "write" || verb === "patch" || verb === "multiedit") return "编辑";
    if (verb === "grep" || verb === "rg" || verb === "glob" || verb === "find" || verb === "search") return "搜索";
    if (SEARCH_TOOL_TOKENS.has(toolToken(message.toolName ?? ""))) return "搜索";
    if (SHELL_TOOLS.has(tool) || verb === "bash" || verb === "sh" || verb === "exec") return "命令";
    if (tool === "askuserquestion") return "问答";
    if (tool === "exitplanmode") return "计划确认";
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

// ── UI-3 人话摘要 ────────────────────────────────────────────────────────────
// 摘要只说用户关心的几类事(读 / 写 / 命令 / 搜索 / 子任务 / 附件),按次数取前三类;思考、问答和
// 「准备工作」(查技能、查工具、记忆、任务列表、平台自检、--help、读技能说明)不进摘要。

const PREP_LABELS = new Set([
  "查看技能", "技能列表", "技能检索", "启用技能", "查找工具", "任务列表", "记忆", "核心记忆", "记忆检索", "记忆更新",
  "历史检索", "归档检索", "MCP 资源列表", "MCP 资源模板",
]);

const COUNT_KIND: Record<string, string> = { 读取: "read", 编辑: "write", 搜索: "search", 命令: "cmd", 工具: "other" };

const KIND_PHRASE: Record<string, (n: number) => string> = {
  read: (n) => `读了 ${n} 个文件`,
  attach: (n) => `读了 ${n} 个附件`,
  write: (n) => `写了 ${n} 个文件`,
  cmd: (n) => `运行了 ${n} 条命令`,
  search: (n) => `搜索了 ${n} 次`,
  sub: (n) => `派出 ${n} 个子任务`,
  other: (n) => `调用了 ${n} 次工具`,
};

export function workKind(message: ChatMessage): string {
  if (message.role === "agent-group" || message.role === "delegate-progress") return "sub";
  if (message.role === "thinking") return "think";
  if (message.role !== "tool" || PROMPT_CARD_TOOLS.has(message.toolName ?? "")) return "";
  try {
    const display = normalizeToolForDisplay(message);
    const label = resolveToolMeta(display.name, display.input).label;
    const head = reliableHeadCall(stripShellWrapperForDisplay(commandOf(display.input)));
    // 读工具给 file_path,shell 的 `cat …` 只有命令文本:两处都看。
    const target = String(display.input?.file_path ?? "") || commandOf(display.input);
    if (PREP_LABELS.has(label) || head?.bin === "oc-system" || /^(?:-h|--help|help)$/.test(head?.op ?? "") || /\/skills\/[^\s'"]*SKILL\.md\b/i.test(target)) {
      return "prep";
    }
    // 等子任务是委派的一部分,不是又一条命令;不进摘要。
    if (label === "等待委派") return "wait";
    if (/^(?:委[派托]|并行委派|子任务$)/.test(label)) return "call";
    if (label === "写入文件") return "write";
    // 其余按工具名或命令首词归类(cat 是读、cat > f 是写、rg 是搜),不扫参数。
    const kind = COUNT_KIND[countLabel(message)] ?? "";
    // 用户上传的附件单独说:没发附件时,「读了 1 个文件」不能被读成读了附件。
    return kind === "read" && target.includes("/.openclaude/uploads/") ? "attach" : kind;
  } catch {
    return "other";
  }
}

function delegateCallCount(message: ChatMessage): number {
  try {
    const tasks = normalizeToolForDisplay(message).input?.tasks;
    if (Array.isArray(tasks) && tasks.length > 0) return tasks.length;
  } catch {
    // malformed inputJson falls back to output header or 1
  }
  const hit = /并行委派\s*(\d+)\s*个子任务/.exec(String(message.output ?? ""));
  const parsed = hit ? Number(hit[1]) : 0;
  return parsed > 0 ? parsed : 1;
}

/** 「读了 6 个文件、派出 1 个子任务、写了 1 个文件」。没有可说的事返回空串。 */
export function workSummary(messages: readonly ChatMessage[]): string {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const kind = workKind(message);
    if (!kind) continue;
    const step = kind === "call" ? delegateCallCount(message) : 1;
    counts.set(kind, (counts.get(kind) ?? 0) + step);
  }
  // 委派调用和子任务卡常是同一件事:取两者较大的那个,不重复数。
  const calls = counts.get("call") ?? 0;
  if (calls > (counts.get("sub") ?? 0)) counts.set("sub", calls);
  return [...counts]
    .filter(([kind]) => KIND_PHRASE[kind])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([kind, n]) => KIND_PHRASE[kind]!(n))
    .join("、");
}


/**
 * 重试、停止、引擎启动、压缩、等你确认、队长步骤:这些阶段由 TurnActivity 说(B4-SPEC §3.4 唯一的
 * 阶段来源),时间线底部单独一行。那时过程外壳不再挂自己的「正在…」,同一时刻只有一行运行状态。
 */
export function keepDistinctActivity(info: TurnActivityInfo | null | undefined): boolean {
  if (!info) return false;
  if (info.recoveryStatus?.kind === "stopping") return true;
  if (isRetryingTurnStatus(info.turnStatus)) return true;
  const status = info.turnStatus;
  if (status === "compacting" || status === "engine_starting" || status === "engine_resuming" || status === "waiting_for_user") {
    return true;
  }
  return !!info.leaderStep;
}

/**
 * 本轮怎么收的尾。过程外壳之后、下一条用户消息之前,以最后一条助手消息为终态行:
 * 它是停止 / 错误时外壳不能写「完成」。只看外壳正后方第一行会让普通回答盖住同轮稍后的终态错误。
 */
export function turnOutcome(following: readonly ChatMessage[] | undefined): "done" | "stopped" | "failed" {
  let terminal: ChatMessage | undefined;
  for (const message of following ?? []) {
    if (message.role === "user") break;
    if (message.role === "assistant") terminal = message;
  }
  if (!terminal || !hasErrorMark(terminal)) return "done";
  const code = String(terminal._errorCode ?? "").toLowerCase();
  return code === "stopped" || code === "user_cancelled" ? "stopped" : "failed";
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

export function toolStillRunning(message: ChatMessage): boolean {
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
  // A question / plan review still open is waiting on the user, not running a tool.
  if (name === "AskUserQuestion") return "等待你回答";
  if (name === "ExitPlanMode") return "等待你确认计划";
  const command = stripShellWrapperForDisplay(commandText(message));
  const head = reliableHeadCall(command);
  if (head?.bin === "oc-memory") {
    if (head.op === "delegate-wait") return "等待子任务完成";
    if (head.op === "core-search" || head.op === "session-search" || head.op === "archival-search") return "正在搜索资料";
  }
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
    if (bin === "cat" && CAT_WRITE_RE.test(command)) return "正在写入文件";
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

export function rawAuditCommand(message: ChatMessage): string {
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
export function isDelegateRow(message: ChatMessage): boolean {
  return message.role === "agent-group" || message.role === "delegate-progress";
}

/** 「委派给 质量审查员：检查报告格式」;并行委派列出各自接手的子代理与子任务数。 */
export function delegateTitle(rows: readonly ChatMessage[]): string {
  const names = [...new Set(rows.map((message) => agentDisplayName(message._delegateAgentId) || "子代理"))];
  if (rows.length > 1) return `委派给 ${names.join("、")}（${rows.length} 个子任务）`;
  const goal = (rows[0]?._delegateGoal || rows[0]?.text || "").replace(/\s+/g, " ").trim();
  return goal ? `委派给 ${names[0]}：${goal}` : `委派给 ${names[0]}`;
}

/** 委派步骤右侧的状态:有一个还在跑就是「进行中」,否则取最差的终态(超时 / 失败 / 完成)。 */
export function delegateState(rows: readonly ChatMessage[]): { label: string; running: boolean } {
  if (rows.some((message) => !message._completed && !isServerAuthoredRow(message))) return { label: "进行中", running: true };
  const states = rows.map((message) => agentTerminalStatus(message));
  return { label: (states.find((state) => state.tone === "danger") ?? states.find((state) => state.tone === "warning") ?? states[0])?.label ?? "完成", running: false };
}

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
    return { text: delegateTitle([latest]).slice(0, 48), pending: true };
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

/** 运行中的外壳标志:一圈慢转的弧光 + 呼吸的中心点;结束后是状态表里这一结局的安静图标(勾 / 停止块 / 叹号)。 */
function ShellGlyph({ active, outcome }: { active: boolean; outcome: "done" | "stopped" | "failed" }) {
  if (active) {
    return (
      <span aria-hidden data-testid="process-glyph-live" className="oc-orbit relative flex size-6 shrink-0 items-center justify-center">
        <span className="oc-orbit-core size-2 rounded-full bg-accent" />
      </span>
    );
  }
  const { icon: Icon, filled } = STATUS[outcome];
  return (
    <span
      aria-hidden
      data-testid="process-glyph-done"
      data-outcome={outcome}
      className="flex size-6 shrink-0 items-center justify-center rounded-full bg-hover text-muted"
    >
      {Icon ? <Icon size={13} strokeWidth={2.25} fill={filled ? "currentColor" : "none"} /> : null}
    </span>
  );
}


export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} 分 ${String(total % 60).padStart(2, "0")} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

/** 1s 一跳的「现在」(统一驱动外壳已耗时与静默/运行计时)。只在有可信时间源时开表,结束即停。 */
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

/** 可见进展结束后,静默多久才显示模型生成中/等待模型响应(避免步骤间闪一下)。 */
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

/** A completed tool's result is the wait boundary, not a later heartbeat.
 * Do not infer a wait while another tool/thinking/delegate row is active. */
function completedToolsSince(messages: readonly ChatMessage[]): number | null {
  if (messages.at(-1)?.role !== "tool" || messages.some((message) =>
    (message.role !== "tool" && message.role !== "thinking") || toolStillRunning(message))) return null;
  let latest: number | null = null;
  for (const message of messages) {
    if (message.role !== "tool") continue;
    if (message._liveUnit || !Number.isFinite(message.ts) || message.ts <= 0) return null;
    const end = message.completedAt ?? (typeof message.durationMs === "number" && Number.isFinite(message.durationMs) && message.durationMs >= 0
      ? message.ts + message.durationMs : undefined);
    if (typeof end !== "number" || !Number.isFinite(end) || end < message.ts) return null;
    latest = Math.max(latest ?? end, end);
  }
  return latest;
}

/** 上游排队 / 自动重试(#1206 retryStatus)/ 引擎冷启动 / 等待服务或用户确认时,保留原「等待模型响应」。 */
function isWaitingForUpstream(activity: TurnActivityInfo | null | undefined): boolean {
  if (!activity) return false;
  if (activity.dispatch) return true;
  const status = activity.turnStatus;
  if (
    isRetryingTurnStatus(status) ||
    status === "engine_starting" ||
    status === "engine_resuming" ||
    status === "waiting_for_user"
  ) {
    return true;
  }
  const recovery = activity.recoveryStatus?.kind;
  return recovery === "waiting-service" || recovery === "retrying" || recovery === "needs-confirmation";
}

/** Only a thinking row proves thinking; once a model request is in flight without deltas, show model generating unless waiting on upstream. */
function shellLivePhrase<T>(
  sections: readonly ProcessSection<T>[],
  currentIndex: number,
  narrativeSettled = false,
  idlePhrase = "模型生成中",
): { text: string; pending: boolean } {
  const current = sections[currentIndex];
  if (!current) return { text: "正在处理", pending: true };
  if (current.narrative) return { text: narrativeSettled ? idlePhrase : "正在组织回复", pending: true };
  const status = stepLiveStatus(current.messages);
  if (!status.text) return { text: "正在处理", pending: true };
  if (status.pending) return status;
  return { text: idlePhrase, pending: true };
}


const shellToggleClass =
  "group/shell -mx-1.5 flex min-h-10 w-[calc(100%+0.75rem)] items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left transition-colors duration-150 hover:bg-hover/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [@media(hover:none)]:min-h-11";


export function ProcessDisclosure<T>({
  sections,
  onFirstTextPaint,
  active,
  open,
  setOpen,
  detailOpen,
  setDetailOpen,
  renderItem,
  keyOf,
  messagesOf,
  olderSteps,
  activity,
  bounds,
  tokenUsageOf,
}: {
  sections: ProcessSection<T>[];
  onFirstTextPaint?: CardCallbacks["onFirstTextPaint"];
  active: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
  detailOpen: (key: string) => boolean;
  setDetailOpen: (key: string, open: boolean) => void;
  renderItem: (item: T) => ReactNode;
  keyOf: (item: T) => string;
  messagesOf: (item: T) => ChatMessage[];
  /** Unloaded earlier steps of this same turn. Stays inside the shell. */
  olderSteps?: ReactNode;
  /**
   * 进行中这一轮的活动快照(只在 active 时给)。startedAt 用于计时;lastFrameAt(最近一帧到达浏览器)
   * 只用于「静默多久」:叙述段写完后迟迟没有下一步时挂「模型生成中」(等上游时为「等待模型响应」),工具长时间运行时在摘要行旁
   * 显示已运行时长。缺省(历史轮、单测)则都不出现。
   */
  activity?: TurnActivityInfo | null;
  /**
   * OCV5-367 本轮的时间边界:startedAt = 本轮用户消息时刻(首步耗时从这里算),endedAt = 过程之后第一行
   * (本轮回答)的到达时刻(末步没有自身终点时以它收尾);next = 那一行本身。
   * following = 过程之后、下一条用户消息之前的行。结局看其中的终态行,不看 next 单独一行。
   */
  bounds?: { startedAt: number | null; endedAt: number | null; next?: ChatMessage; following?: readonly ChatMessage[] };
  /** 一步所在模型调用的 token 用量,只进耗时的悬停说明。 */
  tokenUsageOf?: (item: T) => DisplayTokenUsage | undefined;
}) {
  const startedAt = activity?.startedAt ?? null;
  const lastFrameAt = activity?.lastFrameAt ?? null;
  const turnStartedAt = startedAt ?? bounds?.startedAt ?? null;
  const turnEndedAt = bounds?.endedAt ?? null;
  const messages = sections.flatMap((section) => section.messages);
  // OCV5-367: 每一步的耗时(自上一步结束到本步结束)。按值签名缓存,数值不变时 Map 引用不变,
  // 步骤行(在 memo 边界之下读 context)不会被每一帧无谓重渲。
  const computedTimings = computeStepTimings(messages, { turnStartedAt, turnEndedAt, active });
  const timingsSig = stepTimingsSignature(computedTimings);
  const timingsRef = useRef<{ sig: string; map: typeof computedTimings } | null>(null);
  if (timingsRef.current?.sig !== timingsSig) timingsRef.current = { sig: timingsSig, map: computedTimings };
  const stepTimings = timingsRef.current.map;
  // Cleared/completed goals are diagnostics, not a new step. They must not
  // take the current-stage identity from the work still in progress.
  let currentIndex = -1;
  for (let i = sections.length - 1; i >= 0; i -= 1) {
    if (!sections[i]?.goal && !sections[i]?.card) {
      currentIndex = i;
      break;
    }
  }
  // 详情面板入口(OCV5-370):本轮改过文件 → 常显「改动 N 个文件」,点开面板的改动页;
  // 只有其它步骤 → 一个安静的面板图标(桌面悬停 / 触屏常显),点开步骤页。
  const openPane = useArtifactInspect().openPane;
  const processRows = openPane ? sections.flatMap((section) => section.items.flatMap((item) => messagesOf(item))) : [];
  const changedFiles = openPane ? toolChangedFileCount(processRows) : 0;
  const hasToolRows = processRows.some((message) => message.role === "tool");
  const elapsedValid = active && typeof startedAt === "number" && Number.isFinite(startedAt) && startedAt > 0;
  // 长步骤 / 步骤间隙的活性信号。当前段是叙述(中途说明)时原本不挂任何动效——流式文字本身就是信号;
  // 但文字写完后模型可能还要想很久、或下一条命令还没到,整屏就没有任何「还在干活」的迹象,
  // 用户只能看到一段静止的文字(外壳标题的计时在长过程里早已滚出视口)。
  const currentSection = currentIndex >= 0 ? sections[currentIndex] : undefined;
  const completedSince = currentSection && !currentSection.narrative ? completedToolsSince(currentSection.messages) : null;
  const liveClock = active && typeof lastFrameAt === "number" && Number.isFinite(lastFrameAt) && lastFrameAt > 0;
  const now = useNowTicker(elapsedValid || liveClock || (active && completedSince !== null));
  const elapsedMs = elapsedValid ? now - (startedAt as number) : -1;
  const elapsed = elapsedMs >= 0 && elapsedMs <= 24 * 3600_000 ? formatElapsed(elapsedMs) : "";
  const quietMs = liveClock ? Math.max(0, now - (lastFrameAt as number)) : 0;
  const narrativeSettled = liveClock && !!currentSection?.narrative && quietMs >= QUIET_TAIL_MS;
  const toolWaitMs = completedSince === null ? 0 : now - completedSince;
  const toolsSettled = active && completedSince !== null && toolWaitMs >= QUIET_TAIL_MS && toolWaitMs <= 24 * 3600_000;
  const waiting = narrativeSettled || toolsSettled;
  const waitingMs = toolsSettled ? toolWaitMs : quietMs;
  const runningSince =
    liveClock && currentSection && !currentSection.narrative ? earliestRunningSince(currentSection.messages, startedAt) : null;
  const runningMs = runningSince === null ? 0 : now - runningSince;
  const runningFor = runningSince !== null && runningMs >= RUNNING_META_MS && runningMs <= 24 * 3600_000 ? formatElapsed(runningMs) : "";
  // 同一时刻只有一行运行状态:阶段归 TurnActivity 时外壳不说「正在…」;展开时那一行落在时间轴里
  // 在干活的段(或「模型生成中 / 等待模型响应」尾行),外壳只留标题和计时(OCV5-308)。
  // 真正在等上游时保留「等待模型响应」;模型请求已发出、还没有 delta 时写「模型生成中」。
  const idlePhrase = isWaitingForUpstream(activity) ? "等待模型响应" : "模型生成中";
  let live: { text: string; pending: boolean } | null = null;
  if (active) {
    if (keepDistinctActivity(activity)) {
      // 重试、引擎启动等已由 TurnActivity 说。外壳再挂一行会变成第二行状态。
      live = null;
    } else {
      live = shellLivePhrase(sections, currentIndex, narrativeSettled, idlePhrase);
    }
  }
  const liveInRail = !!live && open && (waiting || (!!currentSection && !currentSection.narrative));
  const title = active ? "处理过程" : "工作过程";
  const outcome = turnOutcome(bounds?.following);
  const tookMs = turnEndedAt !== null && turnStartedAt !== null ? turnEndedAt - turnStartedAt : -1;
  const meta = active ? elapsed : tookMs > 0 && tookMs <= 24 * 3600_000 ? formatElapsed(tookMs) : "";
  const said = active ? "" : workSummary(messages);
  // 历史轮挂载时不播入场动画,只有进行中新冒出来的步骤才轻轻浮入。
  const lastSection = sections.at(-1);
  const lastItem = lastSection?.items.at(-1);
  const lastItemKey = lastItem === undefined ? "" : keyOf(lastItem);


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
        <ShellGlyph active={active} outcome={outcome} />
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="sr-only">{title}</span>
          {live && !liveInRail ? (
            <span
              key={live.text}
              data-testid="process-step-live"
              data-live-pending={live.pending ? "true" : "false"}
              className={`oc-swap-in min-w-0 truncate text-body font-medium ${!open ? `text-muted ${live.pending ? "oc-live-status-shine" : ""}` : "text-faint"}`}
            >
              {live.text}
            </span>
          ) : (
            // UI-3 TurnSummary:「完成 · 读了 6 个文件、派出 1 个子任务、写了 1 个文件」+ 用时;进行中只写「处理中」。
            <span className="min-w-0 truncate text-body font-medium text-faint" data-testid="process-title">
              {active ? "处理中" : said ? `${STATUS[outcome].label} · ${said}` : STATUS[outcome].label}
            </span>
          )}
          {meta ? (
            <span className="shrink-0 whitespace-nowrap text-meta tabular-nums text-faint" data-testid="process-meta">
              {meta}
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
      {/* 收起时不挂任何隐藏水合节点:>1 MiB 定位桩的正文只在展开(本层或阶段详情)后按原规则
          取——尾部直接取,其余进视口 600px 再取。此前收起态也会把首屏尾部的定位桩塞进 1px
          隐藏容器立即下载并整段渲染,看不见却付全部流量与解析成本。 */}
      {(olderSteps || open) ? (
          <div
            className={`oc-rail relative mt-1 space-y-0.5 pb-1 ${open ? "oc-reveal" : ""}`}
            data-testid={open ? "process-stages" : "process-older-steps"}
          >
            {olderSteps ? <div className="pl-9">{olderSteps}</div> : null}
            {open ? (
              <ProcessStages
                sections={sections}
                active={active}
                currentIndex={currentIndex}
                live={live}
                toolsSettled={toolsSettled}
                runningFor={runningFor}
                waiting={waiting}
                waitingMs={waitingMs}
                stepTimings={stepTimings}
                lastItemKey={lastItemKey}
                detailOpen={detailOpen}
                setDetailOpen={setDetailOpen}
                renderItem={renderItem}
                keyOf={keyOf}
                messagesOf={messagesOf}
                onFirstTextPaint={onFirstTextPaint}
                tokenUsageOf={tokenUsageOf}
              />
            ) : null}
          </div>
        ) : null}
    </section>
    </StepTimingContext.Provider>
  );
}
