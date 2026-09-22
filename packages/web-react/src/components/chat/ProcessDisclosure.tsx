import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import type { ChatMessage } from "../../lib/chat/model";
import { Markdown } from "../Markdown";
import { normalizeToolForDisplay, parseCodexTypeName, type ToolInput } from "../tool/format";
import { detectOcCli } from "../tool/meta";
import { safeArtifactSrc } from "../tool/researchCards";
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

function commandText(message: ChatMessage): string {
  const input = message.inputJson;
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    if (typeof record.command === "string") return record.command;
    if (typeof record.cmd === "string") return record.cmd;
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
 * Fold only quiet process rows. `final` means this assistant is the turn's
 * visible answer (including a deferred locator that will become that answer).
 */
export function isProcessMessage(
  message: ChatMessage,
  final: boolean,
  assistantArtifactKeys?: ReadonlySet<string>,
): boolean {
  if (
    message.error ||
    message._isError ||
    message._errorCode ||
    message._turnStatusRecord ||
    message._genPlaceholder ||
    message._turnTapeProcess
  ) {
    return false;
  }
  if (message._delegateStatus === "failed" || message._delegateStatus === "timeout") return false;
  if (liveBackgroundSubtask(message)) return false;
  if (interactiveTool(message)) return false;
  if (toolShowsUniqueArtifact(message, assistantArtifactKeys)) return false;
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
    if (SHELL_TOOLS.has(tool) || verb === "bash" || verb === "sh" || verb === "exec") return "命令";
    return "工具";
  }
  if (message.role === "thinking") return "思考";
  if (message.role === "plan") return "计划";
  if (message.role === "agent-group" || message.role === "delegate-progress") return "子任务";
  return "";
}

export function operationSummary(messages: readonly ChatMessage[]): string {
  const counts = new Map<string, number>();
  for (const message of messages) {
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
    const narrative = messages.length > 0 && messages.every((message) => message.role === "assistant");
    const previous = sections.at(-1);
    if (!narrative && previous && !previous.narrative) {
      previous.items.push(item);
      previous.messages.push(...messages);
    } else {
      sections.push({ key: keyOf(item), narrative, items: [item], messages: [...messages] });
    }
  }
  return sections;
}

const toggleClass =
  "group flex min-h-10 w-full items-center gap-2 rounded-md py-1.5 text-left text-sm text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [@media(hover:none)]:min-h-11";

function StageText({ message }: { message: ChatMessage }) {
  // Same suppression as AssistantCard: an unpublished fallback must not
  // reappear just because the row was grouped into the process.
  if (message._payloadDeferred || message._hideUnpublishedFallback === true) return null;
  const text = message.text ?? "";
  if (!text.trim()) return null;
  return (
    <div
      data-testid="process-stage"
      data-find-member={timelineMessageKey(message)}
      className="min-w-0 text-sm leading-6 text-fg"
    >
      <Markdown signMedia>{text}</Markdown>
    </div>
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
}) {
  const messages = sections.flatMap((section) => section.messages);
  const latest = [...messages].reverse().find((message) => message.role === "assistant" && message.text.trim() && !message._payloadDeferred);
  const title = active ? "处理过程" : "工作过程";
  const summary = operationSummary(messages);

  const clippedDeferred = (item: T) =>
    eagerDeferred && messagesOf(item).some((message) => message._payloadDeferred) ? (
      <div key={`deferred:${keyOf(item)}`} className="h-px overflow-hidden" data-testid="process-deferred-hydrate" aria-hidden>
        {renderItem(item)}
      </div>
    ) : null;

  return (
    <section data-testid="process-disclosure" data-process-active={active ? "true" : "false"} className="min-w-0 sm:ml-[52px]">
      <button
        type="button"
        className={toggleClass}
        aria-expanded={open}
        data-testid="process-toggle"
        onClick={() => setOpen(!open)}
      >
        <ChevronRight size={14} className={open ? "shrink-0 rotate-90 transition-transform" : "shrink-0 transition-transform"} aria-hidden />
        <span className="shrink-0">{title}</span>
        <span className="min-w-0 truncate text-xs text-muted">{summary}</span>
      </button>
      {active && !open && latest ? (
        <p className="line-clamp-2 pl-6 text-sm leading-6 text-muted" data-testid="process-live-summary">
          {latest.text}
        </p>
      ) : null}
      {!open
        ? sections.flatMap((section) => section.items.map((item) => clippedDeferred(item)))
        : (
          <div className="space-y-3 border-l border-border pl-3" data-testid="process-stages">
            {sections.map((section) => {
              if (section.narrative) {
                return (
                  <div key={section.key} className="space-y-2">
                    {section.items.map((item) => {
                      const rows = messagesOf(item);
                      if (rows.some((message) => message._payloadDeferred)) {
                        return <div key={keyOf(item)}>{renderItem(item)}</div>;
                      }
                      return (
                        <div key={keyOf(item)} className="space-y-2">
                          {rows.map((message) => (
                            <StageText key={message.id} message={message} />
                          ))}
                        </div>
                      );
                    })}
                  </div>
                );
              }
              const details = detailOpen(section.key);
              return (
                <div key={section.key}>
                  <button
                    type="button"
                    className={toggleClass}
                    aria-expanded={details}
                    data-testid="process-detail-toggle"
                    onClick={() => setDetailOpen(section.key, !details)}
                  >
                    <ChevronRight
                      size={13}
                      aria-hidden
                      className={details ? "shrink-0 rotate-90 transition-transform" : "shrink-0 transition-transform"}
                    />
                    <span className="min-w-0 break-words">{operationSummary(section.messages)}</span>
                  </button>
                  {details ? (
                    <div className="space-y-3 pt-2" data-testid="process-details">
                      {section.items.map((item) => (
                        <div key={keyOf(item)}>{renderItem(item)}</div>
                      ))}
                    </div>
                  ) : (
                    section.items.map((item) => clippedDeferred(item))
                  )}
                </div>
              );
            })}
          </div>
        )}
    </section>
  );
}
