/**
 * Browser-only transcript order repair.
 *
 * Older IndexedDB snapshots can contain client-owned process cards after the
 * durable terminal assistant row of the same turn.  That shape is stable
 * under an empty incremental sync, so repair it from turn identity rather
 * than wall-clock timestamps or a global "all cards follow user" rule.
 */
import type { ChatMessage } from "./model";
import {
  isCollapsedAnchorTerminalEvidence,
  isDispatchTerminalRow,
} from "./render";

const PROCESS_ROLES = new Set<ChatMessage["role"]>([
  "agent-group",
  "delegate-progress",
  "permission",
]);

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isLocalProcessRow(message: ChatMessage): boolean {
  return PROCESS_ROLES.has(message.role) && message._source !== "server";
}

function isTurnTerminalCandidate(message: ChatMessage): boolean {
  if (message.role !== "assistant" || message._historyProjection) return false;
  const body =
    !message._tapeCollapsed &&
    !message._errorCode &&
    typeof message.text === "string" &&
    message.text.trim().length > 0;
  const error = nonEmptyString(message._errorCode) || isDispatchTerminalRow(message);
  return body || error || isCollapsedAnchorTerminalEvidence(message);
}

type TerminalCandidate = {
  message: ChatMessage;
  index: number;
  orderSeq: number;
  tapeOrdinal: number;
};

function terminalCandidate(message: ChatMessage, index: number): TerminalCandidate {
  return {
    message,
    index,
    orderSeq:
      typeof message._orderSeq === "number" &&
      Number.isSafeInteger(message._orderSeq) &&
      message._orderSeq > 0
        ? message._orderSeq
        : 0,
    tapeOrdinal:
      typeof message._turnTapeOrdinal === "number" &&
      Number.isSafeInteger(message._turnTapeOrdinal) &&
      message._turnTapeOrdinal >= 0
        ? message._turnTapeOrdinal
        : -1,
  };
}

function isLaterTerminal(candidate: TerminalCandidate, current: TerminalCandidate): boolean {
  return (
    candidate.orderSeq > current.orderSeq ||
    (candidate.orderSeq === current.orderSeq &&
      (candidate.tapeOrdinal > current.tapeOrdinal ||
        (candidate.tapeOrdinal === current.tapeOrdinal && candidate.index > current.index)))
  );
}

/**
 * Restore the invariant that local process cards owned by a turn cannot sit
 * after that turn's terminal assistant row.
 *
 * New rows carry `_turnOwnerId`.  Legacy rows are migrated conservatively:
 * an exact `_clientMessageId` is accepted only when it names a user row in
 * this snapshot; otherwise the nearest preceding user boundary owns the row.
 * The fallback never reaches across a later user row.  Server-authored
 * process rows are immutable and are never moved or stamped.
 *
 * Only cards already after the selected terminal are moved, immediately in
 * front of it and in their original relative order.  Legitimate mid-turn
 * cards stay in place.  The selected terminal uses durable order axes
 * (`_orderSeq`, `_turnTapeOrdinal`, original index), never `ts`.
 *
 * This function is pure and idempotent.  It returns the original array when
 * neither metadata nor order needs repair, preserving zero-copy fast paths.
 */
export function repairPostFinalProcessOrder(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length === 0) return messages;

  const userIds = new Set<string>();
  for (const message of messages) {
    if (message?.role === "user" && nonEmptyString(message.id)) userIds.add(message.id);
  }

  const nearestUser: Array<string | undefined> = new Array(messages.length);
  let userBoundary: string | undefined;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message?.role === "user" && nonEmptyString(message.id)) userBoundary = message.id;
    nearestUser[index] = userBoundary;
  }

  const terminals = new Map<string, TerminalCandidate>();
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!message || !isTurnTerminalCandidate(message)) continue;
    const ownerId = nonEmptyString(message._clientMessageId)
      ? message._clientMessageId
      : nearestUser[index];
    if (!ownerId) continue;
    const candidate = terminalCandidate(message, index);
    const current = terminals.get(ownerId);
    if (!current || isLaterTerminal(candidate, current)) terminals.set(ownerId, candidate);
  }

  const replacement = new Map<ChatMessage, ChatMessage>();
  const ownerByProcess = new Map<ChatMessage, string>();
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!message || !isLocalProcessRow(message)) continue;
    const explicitOwner = nonEmptyString(message._turnOwnerId)
      ? message._turnOwnerId
      : undefined;
    const legacyExactOwner =
      !explicitOwner &&
      nonEmptyString(message._clientMessageId) &&
      userIds.has(message._clientMessageId)
        ? message._clientMessageId
        : undefined;
    const ownerId = explicitOwner ?? legacyExactOwner ?? nearestUser[index];
    if (!ownerId) continue;
    ownerByProcess.set(message, ownerId);
    if (!explicitOwner) replacement.set(message, { ...message, _turnOwnerId: ownerId });
  }

  const moved = new Set<ChatMessage>();
  const movedBeforeTerminal = new Map<ChatMessage, ChatMessage[]>();
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    const ownerId = ownerByProcess.get(message);
    if (!ownerId) continue;
    const terminal = terminals.get(ownerId);
    if (!terminal || index <= terminal.index) continue;
    moved.add(message);
    const cards = movedBeforeTerminal.get(terminal.message) ?? [];
    cards.push(replacement.get(message) ?? message);
    movedBeforeTerminal.set(terminal.message, cards);
  }

  if (moved.size === 0) {
    if (replacement.size === 0) return messages;
    return messages.map((message) => replacement.get(message) ?? message);
  }

  const repaired: ChatMessage[] = [];
  for (const message of messages) {
    const cards = movedBeforeTerminal.get(message);
    if (cards) repaired.push(...cards);
    if (moved.has(message)) continue;
    repaired.push(replacement.get(message) ?? message);
  }
  return repaired;
}
