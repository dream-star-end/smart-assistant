import type { LiveChildBlock, LiveUnit, LiveUnitsPage } from "@openclaude/protocol";
import type { ChatMessage, ChildBlock } from "./model";

export function isLiveUnitsPage(value: unknown): value is LiveUnitsPage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  return rec.view === "units" && Array.isArray(rec.units);
}

export function isDurableFramesPage(value: unknown): value is {
  frames: unknown[];
  nextCursor: string | null;
  hasMore: boolean;
  streamClientMessageIds: string[];
  hasTapeProjection: boolean;
  tapeProjectionVersion?: number;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  return Array.isArray(rec.frames) && rec.view !== "units";
}

function roleFor(kind: LiveUnit["kind"]): ChatMessage["role"] {
  if (kind === "agent_group") return "agent-group";
  if (kind === "text") return "assistant";
  return kind;
}

function mapChild(child: LiveChildBlock): ChildBlock {
  return {
    kind: (child.kind as ChildBlock["kind"]) || "text",
    blockId: child.blockId,
    toolUseBlockId: child.toolUseBlockId,
    text: child.text,
    toolName: child.toolName,
    inputPreview: child.inputPreview,
    inputJson: child.inputJson,
    preview: child.preview,
    _partial: child._partial,
    _completed: child._completed,
    output: child.output,
    outputJson: child.outputJson,
    error: child.error,
    ...(child.payloadRef ? { payloadRef: child.payloadRef } : {}),
  };
}

function engineMessageId(unit: LiveUnit): string | undefined {
  const extra = unit as LiveUnit & { messageId?: string };
  return typeof extra.messageId === "string" && extra.messageId ? extra.messageId : undefined;
}

export function liveUnitToMessage(unit: LiveUnit): ChatMessage {
  const role = roleFor(unit.kind);
  const text = unit.kind === "tool"
    ? (unit.toolName || "")
    : (unit.text || unit.goal || "");
  return {
    id: engineMessageId(unit) || unit.id,
    role,
    text,
    ts: Date.now(),
    _liveUnit: true,
    ...(unit.clientMessageId ? {
      _clientMessageId: unit.clientMessageId,
      _turnOwnerId: unit.clientMessageId,
    } : {}),
    ...(unit.blockId ? { blockId: unit.blockId } : {}),
    ...(unit.toolName ? { toolName: unit.toolName } : {}),
    ...(unit.inputJson !== undefined ? { inputJson: unit.inputJson } : {}),
    ...(unit.output !== undefined ? { output: unit.output } : {}),
    ...(unit.outputJson !== undefined ? { outputJson: unit.outputJson } : {}),
    ...(unit.preview ? { preview: unit.preview } : {}),
    ...(unit.error ? { error: true } : {}),
    ...(unit.runId ? { _delegateRunId: unit.runId, runId: unit.runId } : {}),
    ...(unit.agentId ? { _delegateAgentId: unit.agentId, agentId: unit.agentId } : {}),
    ...(unit.goal ? { goal: unit.goal, _delegate: true, _delegateGoal: unit.goal } : {}),
    ...(unit.kind === "agent_group" ? {
      childBlocks: (unit.children ?? []).map(mapChild),
      _completed: !!unit.completed,
      startTime: Date.now(),
    } : {}),
    ...(unit.kind === "tool" ? { _completed: !unit.open } : {}),
    ...(unit.payloadRef ? { _payloadRef: unit.payloadRef } : {}),
  };
}

export function prependLiveUnitMessages(
  messages: ChatMessage[],
  incoming: ChatMessage[],
): ChatMessage[] {
  const seen = new Set(messages.map((m) => m.id));
  const fresh = incoming.filter((m) => !seen.has(m.id));
  if (fresh.length === 0) return messages;
  const insertAt = messages.findIndex((m) => m._liveUnit === true);
  if (insertAt < 0) return [...messages, ...fresh];
  return [...messages.slice(0, insertAt), ...fresh, ...messages.slice(insertAt)];
}

/** Restore WS continuation pointers so the next delta appends the hydrated row. */
export function restoreLiveUnitStreamingState(
  sess: {
    messages: ChatMessage[];
    _streamingThinking?: ChatMessage | null;
    _streamingAssistant?: ChatMessage | null;
  },
  units: LiveUnit[],
): void {
  for (const unit of units) {
    if (!unit.open) continue;
    if (unit.kind !== "thinking" && unit.kind !== "text") continue;
    const id = engineMessageId(unit) || unit.id;
    const row = sess.messages.find((m) => m.id === id);
    if (!row) continue;
    if (unit.kind === "thinking") sess._streamingThinking = row;
    if (unit.kind === "text") sess._streamingAssistant = row;
  }
}
