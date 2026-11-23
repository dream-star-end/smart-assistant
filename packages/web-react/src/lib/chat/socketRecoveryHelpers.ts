import { isClientMessageId, normalizeTurnErrorCode } from "@openclaude/protocol/browser";
import type { ChatMessage, ChatSession } from "./model";
import type { DeferredTerminalErrorPaint } from "./reducer";
import type { StoredSession } from "../persist";

export type RecoveryRejectedNotices = NonNullable<ChatSession["_recoveryRejectedNotices"]>;

export function validRecoveryRejectedNotices(raw: unknown): RecoveryRejectedNotices {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: RecoveryRejectedNotices = {};
  for (const [source, value] of Object.entries(raw)) {
    if (!isClientMessageId(source) || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const item = value as { code?: unknown; notice?: unknown };
    if (typeof item.code !== "string" || !item.code.trim() || typeof item.notice !== "string" || !item.notice.trim()) continue;
    result[source] = { code: normalizeTurnErrorCode(item.code), notice: item.notice };
  }
  return result;
}

export function rejectionNoticesFromRows(rows: readonly ChatMessage[]): RecoveryRejectedNotices {
  const result: RecoveryRejectedNotices = {};
  for (const row of rows) {
    if (
      row?.role !== "assistant" ||
      !isClientMessageId(row._clientMessageId) ||
      typeof row._errorCode !== "string" ||
      !row._errorCode.trim() ||
      typeof row._recoverySkippedNotice !== "string" ||
      !row._recoverySkippedNotice.trim()
    ) continue;
    result[row._clientMessageId] = {
      code: normalizeTurnErrorCode(row._errorCode),
      notice: row._recoverySkippedNotice,
    };
  }
  return result;
}

export function restoreRejectedNoticeMetadata(session: ChatSession, stored: StoredSession): boolean {
  const before = session._recoveryRejectedNotices;
  const notices = {
    ...rejectionNoticesFromRows(Array.isArray(stored.messages) ? stored.messages : []),
    ...validRecoveryRejectedNotices(stored._recoveryRejectedNotices),
    ...validRecoveryRejectedNotices(before),
    ...rejectionNoticesFromRows(session.messages),
  };
  // A live explicit clear wins over late disk feedback.
  for (const row of session.messages) {
    if (
      row.role === "assistant" &&
      isClientMessageId(row._clientMessageId) &&
      Object.prototype.hasOwnProperty.call(row, "_recoverySkippedNotice") &&
      (typeof row._recoverySkippedNotice !== "string" || !row._recoverySkippedNotice.trim())
    ) {
      delete notices[row._clientMessageId];
    }
  }
  const next = Object.keys(notices).length ? notices : undefined;
  if (JSON.stringify(before) === JSON.stringify(next)) return false;
  session._recoveryRejectedNotices = next;
  return true;
}

/** Inspect raw accepted server rows BEFORE local merge, so an explicit clear
 * cannot be confused with feedback transplanted by the local cache. */
export function applyRejectedNoticeMetadata(session: ChatSession, serverRows: ChatMessage[]): ChatMessage[] {
  const notices = validRecoveryRejectedNotices(session._recoveryRejectedNotices);
  const rows = serverRows.map((row) => {
    if (
      row?.role !== "assistant" ||
      !isClientMessageId(row._clientMessageId) ||
      typeof row._errorCode !== "string" ||
      !row._errorCode.trim()
    ) return row;
    const source = row._clientMessageId;
    const code = normalizeTurnErrorCode(row._errorCode);
    if (Object.prototype.hasOwnProperty.call(row, "_recoverySkippedNotice")) {
      if (typeof row._recoverySkippedNotice === "string" && row._recoverySkippedNotice.trim()) {
        notices[source] = { code, notice: row._recoverySkippedNotice };
      } else {
        delete notices[source];
      }
      return row;
    }
    const feedback = notices[source];
    return feedback?.code === code ? { ...row, _recoverySkippedNotice: feedback.notice } : row;
  });
  session._recoveryRejectedNotices = Object.keys(notices).length ? notices : undefined;
  return rows;
}

export function deferredTerminalErrorPaintForStore(
  paint: DeferredTerminalErrorPaint | undefined,
): StoredSession["_deferredTerminalErrorPaint"] | undefined {
  if (!paint) return undefined;
  const normalized = typeof paint.normalized === "string" ? paint.normalized.slice(0, 64) : "";
  const text = typeof paint.text === "string" ? paint.text.slice(0, 4000) : "";
  if (!normalized || !text) return undefined;
  return {
    normalized,
    text,
    ...(typeof paint.detail === "string" && paint.detail ? { detail: paint.detail.slice(0, 2000) } : {}),
    ...(typeof paint.displayMessage === "string" && paint.displayMessage
      ? { displayMessage: paint.displayMessage.slice(0, 4000) }
      : {}),
    ...(isClientMessageId(paint.clientMessageId) ? { clientMessageId: paint.clientMessageId } : {}),
    ...(typeof paint.traceId === "string" && paint.traceId ? { traceId: paint.traceId.slice(0, 128) } : {}),
  };
}

export function messageHasVisibleBody(message: ChatMessage): boolean {
  if (typeof message.text === "string" && message.text.trim().length > 0) return true;
  const blocks = (message as ChatMessage & { blocks?: unknown[] }).blocks;
  return Array.isArray(blocks) && blocks.length > 0;
}

export function isLiveJournalAbort(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === "AbortError" || error.name === "TimeoutError";
  }
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

const LIVE_PROCESS_UNIT_KINDS = new Set([
  "thinking", "tool", "plan", "goal", "agent_group", "delegate_progress", "text",
]);
const LIVE_PROCESS_FRAME_KINDS = new Set([
  "thinking", "tool_use", "plan", "goal", "agent_group", "delegate_progress", "text",
]);

function liveProcessRoleForUnitKind(kind: string | undefined): ChatMessage["role"] | undefined {
  if (kind === "agent_group") return "agent-group";
  if (kind === "delegate_progress") return "delegate-progress";
  if (kind === "text") return "assistant";
  if (kind === "thinking" || kind === "tool" || kind === "plan" || kind === "goal") return kind;
  return undefined;
}

function liveProcessRoleForFrameKind(kind: string | undefined): ChatMessage["role"] | undefined {
  if (kind === "tool_use") return "tool";
  return liveProcessRoleForUnitKind(kind);
}

export function liveProcessOwnersFromUnits(
  units: Array<{
    kind?: string;
    clientMessageId?: string | null;
    text?: string | null;
    _payloadDeferred?: boolean;
    payloadDeferred?: boolean;
  }>,
): Set<string> {
  const owners = new Set<string>();
  for (const unit of units) {
    if (typeof unit.clientMessageId !== "string" || !unit.clientMessageId) continue;
    if (!LIVE_PROCESS_UNIT_KINDS.has(unit.kind ?? "")) continue;
    if (unit._payloadDeferred === true || unit.payloadDeferred === true) continue;
    const role = liveProcessRoleForUnitKind(unit.kind);
    if (role) owners.add(`${unit.clientMessageId}\0${role}`);
  }
  return owners;
}

export function liveProcessOwnersFromFrames(
  frames: Array<{ clientMessageId?: string | null; payload?: unknown }>,
): Set<string> {
  const owners = new Set<string>();
  for (const record of frames) {
    const payload = record.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
    const raw = payload as {
      clientMessageId?: unknown;
      blocks?: unknown;
      _payloadDeferred?: unknown;
    };
    if (raw._payloadDeferred === true) continue;
    const clientMessageId =
      typeof record.clientMessageId === "string" && record.clientMessageId
        ? record.clientMessageId
        : typeof raw.clientMessageId === "string" && raw.clientMessageId
          ? raw.clientMessageId
          : undefined;
    if (!clientMessageId || !Array.isArray(raw.blocks)) continue;
    for (const block of raw.blocks) {
      const kind = block && typeof block === "object"
        ? (block as { kind?: unknown }).kind
        : undefined;
      if (typeof kind !== "string" || !LIVE_PROCESS_FRAME_KINDS.has(kind)) continue;
      if (block && typeof block === "object" && (block as { _payloadDeferred?: unknown })._payloadDeferred === true) {
        continue;
      }
      const role = liveProcessRoleForFrameKind(kind);
      if (role) owners.add(`${clientMessageId}\0${role}`);
    }
  }
  return owners;
}
