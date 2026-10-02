/**
 * Browser-only transcript order repair.
 *
 * Older IndexedDB snapshots can contain client-owned process cards after the
 * durable terminal assistant row of the same turn, or before the owner user
 * they belong to.  Both shapes are stable under an empty incremental sync, so
 * repair them from turn identity rather than wall-clock timestamps or a
 * global "all cards follow user" rule.
 * INC-20260907-PROCESS-CARD-BEFORE-USER
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

function isLocalClientOwnedCard(message: ChatMessage): boolean {
  return PROCESS_ROLES.has(message.role) && message._source !== "server";
}

function isLocalProcessRow(message: ChatMessage, nowMs: number): boolean {
  return isLocalClientOwnedCard(message) && !isOpenPermissionPrompt(message, nowMs);
}

/**
 * Prefer an explicit `_turnOwnerId` that names a user in this snapshot.
 * Legacy exact `_clientMessageId` is accepted only when that user is present.
 * A stamped owner whose user is not paged in is not rewritten onto another
 * turn — the card stays put until its owner row is loaded.
 */
function presentOwnerId(message: ChatMessage, userIds: Set<string>): string | undefined {
  if (nonEmptyString(message._turnOwnerId)) {
    return userIds.has(message._turnOwnerId) ? message._turnOwnerId : undefined;
  }
  if (nonEmptyString(message._clientMessageId) && userIds.has(message._clientMessageId)) {
    return message._clientMessageId;
  }
  return undefined;
}

function isTurnTerminalCandidate(message: ChatMessage): boolean {
  if (
    message.role !== "assistant" ||
    (message as unknown as { _historyProjection?: unknown })._historyProjection
  ) return false;
  const body =
    !message._turnTapeProcess &&
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
 * A prompt the engine is still blocked on. Restricted to cards the reducer
 * materialised from `outbound.permission_request` (`_resolved === false`);
 * legacy rows without the flag keep the classic process-card rules.
 */
function isOpenPermissionPrompt(message: ChatMessage, nowMs: number): boolean {
  if (message.role !== "permission" || message._resolved !== false) return false;
  if (message._source === "server") return false;
  const expiresAt = (message as ChatMessage & { _askUserExpiresAt?: unknown })._askUserExpiresAt;
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt <= nowMs) return false;
  return true;
}

/**
 * An open prompt is the last thing the runtime did in its turn: the engine is
 * blocked on it, so no later row of that turn can exist yet. It must therefore
 * never be treated as a mid-turn process card. Two things used to bury it:
 *  - `repairPostFinalProcessOrder` moved it in front of the latest assistant
 *    row with a body, but CCB narrates mid-turn ("我先看一下…") — after a
 *    reconnect rebuild the ExitPlanMode card ended up above ~45 minutes of
 *    tool rows, far from the tail the paint window and auto-open follow;
 *  - owner resets keep the card but drop its neighbours, and the journal /
 *    live-unit replay then appends below it.
 * Sink every open prompt to the end of its owner turn (just before the next
 * user row, or the end of the transcript), preserving relative order of
 * multiple prompts. Pure and idempotent; returns the original array when
 * nothing moves. INC-20260904-EXITPLAN-PROMPT-BURIED
 */
export function sinkOpenPermissionPrompts(
  messages: ChatMessage[],
  nowMs: number = Date.now(),
): ChatMessage[] {
  if (messages.length < 2) return messages;
  const ownerEnd = new Map<string, number>();
  let currentUserId: string | undefined;
  for (let index = 0; index < messages.length; index++) {
    const m = messages[index];
    if (m?.role === "user" && nonEmptyString(m.id)) {
      if (currentUserId) ownerEnd.set(currentUserId, index);
      currentUserId = m.id;
    }
  }
  if (currentUserId) ownerEnd.set(currentUserId, messages.length);
  const userIds = new Set(ownerEnd.keys());
  const pendingAt = new Map<number, ChatMessage[]>();
  const moved = new Set<ChatMessage>();
  currentUserId = undefined;
  // Collect before emitting: a late prompt can belong to a turn whose end
  // was already passed. A one-pass flush silently loses such prompts.
  for (const m of messages) {
    if (m?.role === "user" && nonEmptyString(m.id)) {
      currentUserId = m.id;
      continue;
    }
    if (!m || !isOpenPermissionPrompt(m, nowMs)) continue;
    let ownerId = presentOwnerId(m, userIds);
    if (!ownerId) {
      // A known but absent owner is a paged-out turn, not an unowned prompt.
      if (nonEmptyString(m._turnOwnerId) || nonEmptyString(m._clientMessageId)) continue;
      ownerId = currentUserId;
    }
    if (!ownerId) continue;
    const end = ownerEnd.get(ownerId);
    if (end === undefined) continue;
    const pending = pendingAt.get(end) ?? [];
    pending.push(m);
    pendingAt.set(end, pending);
    moved.add(m);
  }
  if (moved.size === 0) return messages;
  const out: ChatMessage[] = [];
  for (let index = 0; index <= messages.length; index++) {
    const pending = pendingAt.get(index);
    if (pending) out.push(...pending);
    if (index < messages.length && !moved.has(messages[index])) out.push(messages[index]);
  }
  return out.length === messages.length && out.every((m, index) => m === messages[index]) ? messages : out;
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
 * Open (unresolved, unexpired) engine prompts are not process cards: they are
 * the blocking tail of their turn and are sunk there afterwards by
 * `sinkOpenPermissionPrompts`.
 *
 * This function is pure and idempotent.  It returns the original array when
 * neither metadata nor order needs repair, preserving zero-copy fast paths.
 */
export function repairPostFinalProcessOrder(
  messages: ChatMessage[],
  nowMs: number = Date.now(),
): ChatMessage[] {
  if (messages.length === 0) return messages;
  return sinkOpenPermissionPrompts(
    repairProcessCardsBeforeTerminal(
      clampProcessCardsToOwnerUserBounds(messages),
      nowMs,
    ),
    nowMs,
  );
}

/**
 * Local client-owned agent-group / delegate-progress / permission cards may
 * not sit before their present owner user, or past the next user after that
 * owner.  Only out-of-bounds cards move; in-turn tool/assistant interleaving
 * and server-authored tape rows stay.  Missing owners (pagination) are left
 * alone.  INC-20260907-PROCESS-CARD-BEFORE-USER
 */
function clampProcessCardsToOwnerUserBounds(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length < 2) return messages;

  const userIndex = new Map<string, number>();
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message?.role === "user" && nonEmptyString(message.id) && !userIndex.has(message.id)) {
      userIndex.set(message.id, index);
    }
  }
  if (userIndex.size === 0) return messages;

  const userIds = new Set(userIndex.keys());
  const userIndices = [...userIndex.values()];
  const nextUserIndex = new Map(userIndices.map((lo, index) =>
    [lo, userIndices[index + 1] ?? messages.length] as const));
  const hiFor = (lo: number): number => nextUserIndex.get(lo) ?? messages.length;

  const tooEarly = new Map<string, ChatMessage[]>();
  const tooLate = new Map<string, ChatMessage[]>();
  const moved = new Set<ChatMessage>();
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!message || !isLocalClientOwnedCard(message)) continue;
    const ownerId = presentOwnerId(message, userIds);
    if (!ownerId) continue;
    const lo = userIndex.get(ownerId);
    if (lo === undefined) continue;
    const hi = hiFor(lo);
    if (index < lo) {
      moved.add(message);
      const cards = tooEarly.get(ownerId) ?? [];
      cards.push(message);
      tooEarly.set(ownerId, cards);
    } else if (index >= hi) {
      moved.add(message);
      const cards = tooLate.get(ownerId) ?? [];
      cards.push(message);
      tooLate.set(ownerId, cards);
    }
  }
  if (moved.size === 0) return messages;

  const lateByHi = new Map<number, string[]>();
  for (const ownerId of tooLate.keys()) {
    const hi = hiFor(userIndex.get(ownerId)!);
    const owners = lateByHi.get(hi) ?? [];
    owners.push(ownerId);
    lateByHi.set(hi, owners);
  }

  const emitLate = (hi: number, out: ChatMessage[]): void => {
    const owners = lateByHi.get(hi);
    if (!owners) return;
    for (const ownerId of owners) {
      const cards = tooLate.get(ownerId);
      if (cards) out.push(...cards);
    }
  };

  const repaired: ChatMessage[] = [];
  for (let index = 0; index < messages.length; index++) {
    emitLate(index, repaired);
    const message = messages[index];
    if (moved.has(message)) continue;
    repaired.push(message);
    if (message?.role === "user" && nonEmptyString(message.id)) {
      const cards = tooEarly.get(message.id);
      if (cards) repaired.push(...cards);
    }
  }
  emitLate(messages.length, repaired);
  return repaired;
}

function repairProcessCardsBeforeTerminal(messages: ChatMessage[], nowMs: number): ChatMessage[] {
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
    if (!message || !isLocalProcessRow(message, nowMs)) continue;
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

/** A card cannot predate the user message of its own turn; allow this much browser/server clock skew. */
const STRAY_TS_MARGIN_MS = 60_000;

function finiteTs(message: ChatMessage | undefined): number | undefined {
  const ts = message?.ts;
  return typeof ts === "number" && Number.isFinite(ts) && ts > 0 ? ts : undefined;
}

/**
 * OCV5-313: rows of an earlier, already-finished turn that ended up under a
 * later user row go back to the end of their own turn.
 *
 * After a refresh the browser merges its kept copy with the server snapshot;
 * rows that the merge could not place land at the tail — under the newest
 * user — and the process view then folds them into that turn's 处理过程
 * (an earlier turn's tools and even its final answer inside the newest shell),
 * or shows long-answered 用户问答 cards after the latest answer.
 *
 * Evidence, strongest first:
 *  - an explicit owner (`_turnOwnerId`, else `_clientMessageId`) naming a user
 *    present here that comes BEFORE the turn the row currently sits in; tape
 *    rows always carry their dispatch's user id;
 *  - for answered (resolved) permission cards only: a card cannot predate the
 *    user message of its own turn, so a card whose ts is more than a minute
 *    before the user it sits under belongs to the last user sent before it
 *    (covers cards rebuilt from owner-less legacy journal frames, and a wrong
 *    owner stamped at replay time).
 *
 * Never moved: rows of the turn they sit in, rows whose owner is not present
 * (paged out / hidden recovery id), open prompts, rows before the first user.
 * Moved rows keep their relative order and go just before the next user after
 * their owner. View-only and pure: returns the original array when nothing
 * moves, so the active turn's live order (OCV5-272) is untouched.
 */
export function returnStrayRowsToOwnerTurn(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length < 3) return messages;
  const userIds: string[] = [];
  const userTs: Array<number | undefined> = [];
  const turnIndexById = new Map<string, number>();
  const turnOf: number[] = new Array(messages.length);
  let turn = -1;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message?.role === "user" && nonEmptyString(message.id) && !turnIndexById.has(message.id)) {
      turn += 1;
      userIds.push(message.id);
      userTs.push(finiteTs(message));
      turnIndexById.set(message.id, turn);
    }
    turnOf[index] = turn;
  }
  if (userIds.length < 2) return messages;

  const turnByTs = (ts: number): number | undefined => {
    let found: number | undefined;
    for (let index = 0; index < userTs.length; index++) {
      const userAt = userTs[index];
      if (userAt === undefined) continue;
      if (userAt <= ts) found = index;
      else break;
    }
    return found;
  };

  const strays = new Map<number, ChatMessage[]>();
  const moved = new Set<ChatMessage>();
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!message || message.role === "user") continue;
    const current = turnOf[index] ?? -1;
    if (current <= 0) continue;
    if (message.role === "permission" && message._resolved !== true) continue;

    let owner: number | undefined;
    const explicit = nonEmptyString(message._turnOwnerId)
      ? message._turnOwnerId
      : nonEmptyString(message._clientMessageId)
        ? message._clientMessageId
        : undefined;
    if (explicit) owner = turnIndexById.get(explicit);

    if (message.role === "permission") {
      const ts = finiteTs(message);
      const sitsUnder = userTs[owner ?? current];
      if (ts !== undefined && sitsUnder !== undefined && ts < sitsUnder - STRAY_TS_MARGIN_MS) {
        owner = turnByTs(ts);
      } else if (!explicit) {
        continue;
      }
    } else if (!explicit) {
      continue;
    }
    if (owner === undefined || owner >= current) continue;
    moved.add(message);
    const rows = strays.get(owner) ?? [];
    rows.push(message);
    strays.set(owner, rows);
  }
  if (moved.size === 0) return messages;

  const out: ChatMessage[] = [];
  let seenTurn = -1;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message?.role === "user" && nonEmptyString(message.id) && turnIndexById.get(message.id) === seenTurn + 1) {
      const rows = strays.get(seenTurn);
      if (rows) out.push(...rows);
      seenTurn += 1;
    }
    if (moved.has(message)) continue;
    out.push(message);
  }
  return out;
}
