/** Independent content oracle for one matched tool result.
 * Annotation bytes come from pinned literals, never from the normalizer. */
import { createHash } from "node:crypto";

export const B1_BASH_HOOK = "PreToolUse:Bash hook additional context: 本容器内文件请用原生 Read/Grep/Glob,不要 `sed -n` 隔空读。host 读宿主文件可以保留。 替代: 用原生 Read/Grep/Glob 读容器内文件;宿主文件才用 `host cat/rg`";
export const PROGRESS_SENTENCE = "The user hasn't heard from you in a while. As you continue, keep them updated when there's something to tell \u2014 a finding, a change of plan.";
const BUDGET = /^<total_tokens>(?:0|[1-9][0-9]{0,15}|Infinite) tokens left<\/total_tokens>$/;
const SUPPORTED = {
  "b1-bash-hook": B1_BASH_HOOK,
  "ccb-silent-turn-progress": PROGRESS_SENTENCE,
} as const;
export type AnnotationSource = keyof typeof SUPPORTED;
export type ExpectedAnnotation = { source: AnnotationSource; index: number };
type Block = { type?: string; text?: string };

/** Classify one raw system text. Unknown text is not treated as telemetry. */
export function classifySystemText(text: string):
  { kind: "budget" } | { kind: "annotation"; source: AnnotationSource } | { kind: "unknown" } {
  if (BUDGET.test(text)) return { kind: "budget" };
  const at = text.lastIndexOf("\n\n");
  if (at <= 0 || !BUDGET.test(text.slice(at + 2))) return { kind: "unknown" };
  const head = text.slice(0, at);
  if (head === B1_BASH_HOOK) return { kind: "annotation", source: "b1-bash-hook" };
  if (head === PROGRESS_SENTENCE) return { kind: "annotation", source: "ccb-silent-turn-progress" };
  return { kind: "unknown" };
}

type Message = { role?: string; content?: unknown };

function systemText(message: Message | undefined): string | null {
  if (!message || message.role !== "system") return null;
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.length !== 1) return null;
  const block = content[0];
  if (!block || typeof block !== "object" || (block as { type?: string }).type !== "text") return null;
  const text = (block as { text?: unknown }).text;
  return typeof text === "string" ? text : null;
}

/** Annotation expectation for the last handoff only, read from the raw body. */
export function annotationsForLastHandoff(messages: readonly Message[]): {
  annotations: ExpectedAnnotation[];
  unknown: boolean;
} {
  let last = -1;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message?.role === "user" && Array.isArray(message.content)
      && message.content.some((block) => block && typeof block === "object"
        && (block as { type?: string }).type === "tool_result")) last = i;
  }
  const text = systemText(messages[last + 1]);
  if (text === null) return { annotations: [], unknown: false };
  const kind = classifySystemText(text);
  if (kind.kind === "budget") return { annotations: [], unknown: false };
  if (kind.kind === "annotation") return { annotations: [{ source: kind.source, index: 1 }], unknown: false };
  return { annotations: [], unknown: true };
}

export function checkMatchedContent(input: {
  content: readonly Block[];
  isError: boolean;
  contentHash: string;
  mcpSha256: string;
  toolIndexes: readonly number[];
  annotations: readonly ExpectedAnnotation[];
}): string | null {
  if (input.isError) return "IS_ERROR";
  const seen = new Map<AnnotationSource, number>();
  for (const item of input.annotations) {
    seen.set(item.source, (seen.get(item.source) ?? 0) + 1);
    if (item.index < 0 || item.index >= input.content.length) return "ANNOTATION_POSITION";
  }
  if ([...seen.values()].some((count) => count !== 1)) return "ANNOTATION_COUNT";
  const claimed = new Set<number>([
    ...input.toolIndexes,
    ...input.annotations.map((item) => item.index),
  ]);
  if (claimed.size !== input.toolIndexes.length + input.annotations.length) return "ANNOTATION_POSITION";
  if (input.content.some((_, index) => !claimed.has(index))) return "ANNOTATION_UNKNOWN";
  const toolText = input.toolIndexes.map((index) => {
    const block = input.content[index];
    if (!block || block.type !== "text" || typeof block.text !== "string") return null;
    return block.text;
  });
  if (toolText.some((item) => item === null)) return "MCP_BODY";
  if (createHash("sha256").update(toolText.join("")).digest("hex") !== input.mcpSha256) return "MCP_BODY";
  const expected = input.content.map((block, index) => {
    const annotation = input.annotations.find((item) => item.index === index);
    if (annotation) return { type: "text", text: SUPPORTED[annotation.source] };
    return { type: "text", text: block?.text ?? "" };
  });
  const actual = input.content.map((block) => ({ type: block?.type, text: block?.text }));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) return "ANNOTATION_MISMATCH";
  const hash = createHash("sha256").update(JSON.stringify({
    content: expected, isError: false })).digest("hex");
  if (hash !== input.contentHash) return "CONTENT_HASH";
  return null;
}
