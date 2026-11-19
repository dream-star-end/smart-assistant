import type { ChatMessage } from "../../lib/chat/model";
import { asArr, asStr, resolveToolInput } from "../tool/format";
import { currentTurnStartIndex } from "./turnSegment";

export type TodoItem = { content: string; status: string; activeForm?: string };

function normalizePlanStatus(status: string): string {
  if (status === "completed") return "completed";
  if (status === "inProgress" || status === "in_progress") return "in_progress";
  return "pending";
}

function normalizePlanSteps(steps: unknown): TodoItem[] {
  const raw = asArr(steps);
  return raw
    .filter((s): s is Record<string, unknown> => !!s && typeof s === "object" && !Array.isArray(s))
    .map((s) => ({
      content: asStr(s.step) || asStr(s.text) || asStr(s.description),
      status: normalizePlanStatus(asStr(s.status)),
      activeForm: asStr(s.activeForm),
    }))
    .filter((t) => t.content || t.activeForm);
}

function normalizeTodoItems(todos: unknown): TodoItem[] {
  const raw = asArr(todos);
  return raw
    .filter((t): t is Record<string, unknown> => !!t && typeof t === "object" && !Array.isArray(t))
    .map((t) => ({ content: asStr(t.content), status: asStr(t.status) || "pending", activeForm: asStr(t.activeForm) }))
    .filter((t) => t.content || t.activeForm);
}

export function extractLatestTodos(
  messages: readonly ChatMessage[],
  turnStart: number = currentTurnStartIndex(messages),
): TodoItem[] {
  for (let i = messages.length - 1; i >= turnStart; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === "plan" && Array.isArray(m.steps)) {
      return normalizePlanSteps(m.steps);
    }
    if (m.role !== "tool" || m.toolName !== "TodoWrite") continue;
    const input = resolveToolInput(m);
    return normalizeTodoItems(input?.todos);
  }
  return [];
}
