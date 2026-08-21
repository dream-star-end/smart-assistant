import type { ChatMessage } from "./model";

const VALID_ROLES: ReadonlySet<ChatMessage["role"]> = new Set([
  "user",
  "assistant",
  "thinking",
  "tool",
  "agent-group",
  "plan",
  "goal",
  "permission",
  "delegate-progress",
  "runtime-event",
  "system",
]);

function stableCorruptId(sessionId: string | undefined, index: number, raw: unknown): string {
  const candidate = raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string"
    ? (raw as { id: string }).id
    : "";
  const ts = raw && typeof raw === "object" && typeof (raw as { ts?: unknown }).ts === "number"
    ? String((raw as { ts: number }).ts)
    : "0";
  const basis = candidate.length > 0 ? candidate : `idx:${index}:ts:${ts}`;
  return `corrupt:${sessionId ?? "unknown"}:${basis}`;
}

function asCorruptPlaceholder(
  sessionId: string | undefined,
  index: number,
  raw: unknown,
  reason: "missing-id" | "malformed",
): ChatMessage {
  const ts = raw && typeof raw === "object" && typeof (raw as { ts?: unknown }).ts === "number"
    && Number.isFinite((raw as { ts: number }).ts)
    ? (raw as { ts: number }).ts
    : 0;
  return {
    id: stableCorruptId(sessionId, index, raw),
    role: "system",
    text: reason === "missing-id"
      ? "此条消息缺少 id，已跳过渲染"
      : "此条消息数据结构异常，已跳过渲染",
    ts,
    _source: "server",
    _corruptPlaceholder: true,
    _corruptReason: reason,
  } as ChatMessage;
}

export function isRenderableChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<ChatMessage>;
  return typeof message.id === "string"
    && message.id.length > 0
    && typeof message.role === "string"
    && VALID_ROLES.has(message.role)
    && typeof message.ts === "number"
    && Number.isFinite(message.ts);
}

function isPlanStep(value: unknown): value is { step: string; status: string } {
  return !!value
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof (value as { step?: unknown }).step === "string"
    && typeof (value as { status?: unknown }).status === "string";
}

function nestedFieldsRenderable(message: ChatMessage): boolean {
  switch (message.role) {
    case "plan":
      return message.steps === undefined || (Array.isArray(message.steps) && message.steps.every(isPlanStep));
    case "delegate-progress":
      return message.entries === undefined
        || (Array.isArray(message.entries) && message.entries.every((entry) => !!entry && typeof entry === "object"));
    case "agent-group":
      return message.childBlocks === undefined
        || (Array.isArray(message.childBlocks)
          && message.childBlocks.every((block) => !!block && typeof block === "object"));
    default:
      return true;
  }
}

/** Normalize one history/socket batch before filter/aggregate/signature work.
 * Bad items become stable-id error placeholders so neighbors still render. */
export function sanitizeChatMessages(
  messages: unknown,
  sessionId?: string,
): ChatMessage[] {
  if (!Array.isArray(messages)) return [];
  return messages.map((raw, index) => {
    if (isRenderableChatMessage(raw)) {
      if (!nestedFieldsRenderable(raw)) {
        return asCorruptPlaceholder(sessionId, index, raw, "malformed");
      }
      return raw;
    }
    if (raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string"
      && ((raw as { id: string }).id.length > 0)) {
      const message = raw as ChatMessage;
      if (typeof message.role !== "string" || !VALID_ROLES.has(message.role)) {
        return asCorruptPlaceholder(sessionId, index, raw, "malformed");
      }
      if (typeof message.ts !== "number" || !Number.isFinite(message.ts)) {
        return { ...message, ts: 0 };
      }
      if (!nestedFieldsRenderable(message)) {
        return asCorruptPlaceholder(sessionId, index, raw, "malformed");
      }
      return message;
    }
    const reason = raw && typeof raw === "object" && (typeof (raw as { id?: unknown }).id !== "string"
      || (raw as { id: string }).id.length === 0)
      ? "missing-id"
      : "malformed";
    return asCorruptPlaceholder(sessionId, index, raw, reason);
  });
}
