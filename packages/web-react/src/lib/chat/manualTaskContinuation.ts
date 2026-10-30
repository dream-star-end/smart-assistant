import type { ChatMessage } from "./model";
import { INTERRUPTED_CONTINUE_PROMPT } from "./pure";

/** An explicit Continue belongs to the latest source, including a turn that
 * never produced output. This grants no automatic-recovery or replay rights. */
export function manualTaskContinuationSource(
  messages: readonly ChatMessage[],
  error: ChatMessage,
): ChatMessage | undefined {
  const end = messages.findIndex((row) => row.id === error.id);
  if (end < 0 || messages.slice(end + 1).some((row) =>
    row.role === "user" ||
    (row.role === "assistant" && (!!row._errorCode ||
      (!row._turnStatusRecord && !row._payloadDeferred && !row._turnTapeProcess && (!!row._userError || !!row.text?.trim())))) ||
    (row._turnStatusRecord === true && !!row._errorCode))) return undefined;
  let sourceIndex = error.role === "user" ? end : end - 1;
  while (sourceIndex >= 0 && messages[sourceIndex].role !== "user") sourceIndex--;
  let source = messages[sourceIndex];
  if (!source || (error.role !== "user" && error._clientMessageId && error._clientMessageId !== source.id)) return undefined;
  // A hidden recovery row is transport control, not the user's original goal.
  // Walk only backwards through the recorded lineage; missing/cyclic ancestry
  // cannot fall back to replaying an internal recovery instruction.
  const seen = new Set<string>();
  while (source._recoveryOfClientMessageId) {
    if (seen.has(source.id)) return undefined;
    seen.add(source.id);
    const parent = source._recoveryOfClientMessageId;
    const index = messages.findIndex((row, index) => index < sourceIndex && row.role === "user" && row.id === parent);
    if (index < 0) return undefined;
    sourceIndex = index;
    source = messages[index];
  }
  return source;
}

/** A normal same-session user follow-up, never the original task replayed as
 * a new instruction. The original goal also covers pre-execution failures. */
export function taskContinuationPrompt(goal: string): string {
  return `${INTERRUPTED_CONTINUE_PROMPT}\n\n原任务目标（仅作为继续当前任务的背景，不要重新开始或重复已完成的操作）：\n${goal}`;
}
