import { normalizeTurnErrorCode } from "@openclaude/protocol/browser";
import { stoppedNarrationContinuationSource } from "./stoppedNarrationSource";
import type { ChatMessage } from "./model";
import { INTERRUPTED_CONTINUE_PROMPT } from "./pure";

/** Map a genuine render-only stop back to its exact raw source. A field,
 * suffix or serialized view cannot authorize a task. Current raw ownership is rechecked. */
export function canonicalTaskContinuationError(
  messages: readonly ChatMessage[],
  error: ChatMessage,
): ChatMessage | undefined {
  const linked = stoppedNarrationContinuationSource(error);
  const isProjectedStop = error._continuationSourceId !== undefined ||
    (error.id.endsWith(":stopped") && error._stopCopyText !== undefined);
  if (linked || isProjectedStop) {
    if (!linked || error._continuationSourceId !== linked.id ||
        error.id !== `${linked.id}:stopped` || error.role !== "assistant" || error.text !== "" ||
        !error._stopCopyText?.trim() || !linked._clientMessageId ||
        error._clientMessageId !== linked._clientMessageId) return undefined;
    const code = normalizeTurnErrorCode(linked._errorCode);
    if ((code !== "user_cancelled" && code !== "stopped") ||
        normalizeTurnErrorCode(error._errorCode) !== code) return undefined;
    const canonical = messages.find((row) => row.id === linked.id);
    // REST may replace an equivalent raw object without changing a memoized
    // view. Recheck its identity and stop state, not JavaScript reference equality.
    return canonical?.role === "assistant" && canonical._clientMessageId === linked._clientMessageId &&
      normalizeTurnErrorCode(canonical._errorCode) === code ? canonical : undefined;
  }
  return messages.find((row) => row.id === error.id);
}

/** An explicit Continue belongs to the latest source, including a turn that
 * never produced output. This grants no automatic-recovery or replay rights. */
export function manualTaskContinuationSource(
  messages: readonly ChatMessage[],
  error: ChatMessage,
): ChatMessage | undefined {
  const canonical = canonicalTaskContinuationError(messages, error);
  if (!canonical) return undefined;
  if (canonical._turnStatusRecord === true && !canonical._errorCode && !canonical._userError && canonical._dispatchTerminal !== true) return undefined;
  const end = messages.indexOf(canonical);
  if (end < 0 || messages.slice(end + 1).some((row) =>
    row.role === "user" ||
    (row.role === "assistant" && (!!row._errorCode ||
      (!row._turnStatusRecord && !row._payloadDeferred && !row._turnTapeProcess && (!!row._userError || !!row.text?.trim())))) ||
    (row._turnStatusRecord === true && !!row._errorCode))) return undefined;
  let sourceIndex = canonical.role === "user" ? end : end - 1;
  while (sourceIndex >= 0 && messages[sourceIndex].role !== "user") sourceIndex--;
  const nearestUserIndex = sourceIndex;
  let source = messages[sourceIndex];
  if (!source) return undefined;
  // Master give-up cards belong to the original human root, while the nearest
  // user can be a hidden recovery child. Accept owners only on its actual chain.
  const ancestors = new Set<string>();
  while (true) {
    if (ancestors.has(source.id)) return undefined;
    ancestors.add(source.id);
    const parent = source._recoveryOfClientMessageId;
    if (!parent) break;
    const index = messages.findIndex((row, index) => index < sourceIndex && row.role === "user" && row.id === parent);
    if (index < 0) return undefined;
    sourceIndex = index;
    source = messages[index];
  }
  if (canonical.role !== "user" && canonical._clientMessageId && !ancestors.has(canonical._clientMessageId)) return undefined;
  // Parallel retries may all point at the root. Every intervening user must
  // still be a recorded descendant; never jump across an unrelated human task.
  const related = new Set([source.id]);
  for (let index = sourceIndex + 1; index <= nearestUserIndex; index++) {
    const row = messages[index];
    if (row.role !== "user") continue;
    if (!row._recoveryOfClientMessageId || !related.has(row._recoveryOfClientMessageId) || related.has(row.id)) return undefined;
    related.add(row.id);
  }
  return source;
}

/** A normal same-session user follow-up, never the original task replayed as
 * a new instruction. The original goal also covers pre-execution failures. */
export function taskContinuationPrompt(goal: string): string {
  return `${INTERRUPTED_CONTINUE_PROMPT}\n\n原任务目标（仅作为继续当前任务的背景，不要重新开始或重复已完成的操作）：\n${goal}`;
}
