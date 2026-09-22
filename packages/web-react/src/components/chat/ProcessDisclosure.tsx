import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import type { ChatMessage } from "../../lib/chat/model";
import { Markdown } from "../Markdown";
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

const HTML_FENCE_RE = /```(?:htmlpreview|html)\b/i;
const MD_IMAGE_RE = /!\[[^\]]*\]\(([^)\s]+)\)/g;
const GENERATED_PATH_RE = /\/home\/agent\/\.openclaude\/generated\/\S+/g;
const TRAILING_PATH_JUNK = /[),.;:，。；"'`\]}>]+$/u;

function cleanEvidenceToken(value: string): string {
  return value.replace(TRAILING_PATH_JUNK, "");
}

/** Stable keys for a real preview, image, or generated file. Tool names are not keys. */
export function artifactEvidenceKeys(text: string): string[] {
  MD_IMAGE_RE.lastIndex = 0;
  GENERATED_PATH_RE.lastIndex = 0;
  const keys: string[] = [];
  if (HTML_FENCE_RE.test(text)) keys.push("html");
  for (const match of text.matchAll(MD_IMAGE_RE)) {
    if (match[1]) keys.push(`img:${cleanEvidenceToken(match[1])}`);
  }
  for (const match of text.matchAll(GENERATED_PATH_RE)) {
    keys.push(`file:${cleanEvidenceToken(match[0])}`);
  }
  return keys;
}

function messageEvidenceText(message: ChatMessage): string {
  const parts = [message.text ?? "", message.output ?? "", message.inputPreview ?? ""];
  const input = message.inputJson;
  if (input && typeof input === "object") {
    try {
      parts.push(JSON.stringify(input));
    } catch {
      /* non-json input is not artifact evidence */
    }
  }
  return parts.join("\n");
}

/** Preview, image, or generated-file assistant rows stay beside the answer. */
export function assistantCarriesDeliverable(message: ChatMessage): boolean {
  if (message.role !== "assistant" || message._hideUnpublishedFallback === true) return false;
  const text = message.text ?? "";
  if (!text.trim()) return false;
  return artifactEvidenceKeys(text).length > 0;
}

/**
 * A successful tool stays on the result layer only when its payload contains
 * artifact evidence the assistant does not already show. CLI and imageGeneration
 * names are execution logs, not evidence.
 */
export function toolShowsUniqueArtifact(
  message: ChatMessage,
  assistantArtifactKeys?: ReadonlySet<string>,
): boolean {
  if (message.role !== "tool" || message.error || message._isError) return false;
  const keys = artifactEvidenceKeys(messageEvidenceText(message));
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
