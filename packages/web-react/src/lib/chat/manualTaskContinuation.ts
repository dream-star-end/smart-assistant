import type { ChatMessage } from "./model";
import { INTERRUPTED_CONTINUE_PROMPT } from "./pure";

/** An explicit Continue belongs to the latest source, including a turn that
 * never produced output. This grants no automatic-recovery or replay rights. */
export function manualTaskContinuationSource(
  messages: readonly ChatMessage[],
  error: ChatMessage,
): ChatMessage | undefined {
  const end = messages.findIndex((row) => row.id === error.id);
  if (end < 0 || messages.slice(end + 1).some((row) => row.role === "user")) return undefined;
  if (error.role === "user") return messages[end].role === "user" ? messages[end] : undefined;
  for (let index = end - 1; index >= 0; index--) {
    const row = messages[index];
    if (row.role !== "user") continue;
    return !error._clientMessageId || error._clientMessageId === row.id ? row : undefined;
  }
  return undefined;
}

/** A normal same-session user follow-up, never the original task replayed as
 * a new instruction. The original goal also covers pre-execution failures. */
export function taskContinuationPrompt(goal: string): string {
  return `${INTERRUPTED_CONTINUE_PROMPT}\n\n原任务目标（仅作为继续当前任务的背景，不要重新开始或重复已完成的操作）：\n${goal}`;
}
