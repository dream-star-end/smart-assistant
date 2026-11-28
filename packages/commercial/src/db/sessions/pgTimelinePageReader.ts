import type { Pool, PoolClient } from "pg";
import type {
  ClientSessionsBackend,
  ClientTimelineCursor,
  ClientTimelinePage,
  MessageLike,
} from "@openclaude/storage";
import {
  parseHotTimelineMessages,
  summarizeHotTimelineMessages,
  type ParsedHotTimelineMessages,
  type PreloadedTimelineSession,
} from "../pgTimelinePerf.js";
import {
  classifyUnifiedTimelineIntegrityError,
  recordsPublished,
  type TapeDisplayDegradeReason,
} from "../visibleFinalize.js";
import type { PgSessionsCtx, PgSessionsDeps } from "./deps.js";
import { hydrateTurnTapeMessages } from "./pgTapeHydrateReader.js";
import {
  TAPE_RECORD_PAGE_MAX_ROWS,
  TAPE_RECORD_PAGE_RAW_QUANTUM_BYTES,
  deferUnifiedTimelinePayload,
} from "./pgTapeSanitizeAndEncode.js";
import {
  readUnifiedTimelineBashTailAuxiliaries,
  readUnifiedTimelineOuterCandidates,
  readUnifiedTimelineStatuses,
  readUnifiedTimelineTapeHeaders,
  readUnifiedTimelineTapeHeads,
  timelineOuterKey,
  unifiedTimelineFinalFallbackText,
  unifiedTimelineTapeFallbackMessages,
  unifiedTimelineTapeMissingFinalRecord,
  unifiedTimelineTerminalAuxiliary,
} from "./pgTimelineAuxReader.js";
import {
  hydrateUnifiedTimelineTapeUnits,
  type SelectedTapeUnit,
} from "./pgTimelineUnitHydrator.js";
import { bigIntNum, bigIntNumOr, withTimelineSnapshot } from "./sqlHelpers.js";
import type {
  UnifiedTimelineSelectedUnit,
  UnifiedTimelineTapeHead,
  UnifiedTimelineTapeHeader,
  UnifiedTimelineTapeWindow,
} from "./types.js";

// ── Page selection & candidate expansion ─────────────────────────────────────

type SelectedOuterUnit = Extract<UnifiedTimelineSelectedUnit, { kind: "outer" }>;

type TimelineContinuation = {
  anchor: MessageLike;
  header: UnifiedTimelineTapeHeader;
  beforeOrdinal: number;
};

type TimelinePageSelection = {
  selected: UnifiedTimelineSelectedUnit[];
  windows: UnifiedTimelineTapeWindow[];
  inlineBytes: number;
  hasMore: boolean;
  foundNextVisible: boolean;
  continuation: TimelineContinuation | null;
};

const READ_TIMELINE_SESSION_SQL = `SELECT messages,archived_through_seq,history_revision,timeline_generation
   FROM client_sessions
  WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`;

function canFitOnTimelinePage(
  state: TimelinePageSelection,
  cappedLimit: number,
  itemBytes: number,
): boolean {
  if (state.selected.length >= cappedLimit) return false;
  return state.selected.length === 0 ||
    state.inlineBytes + itemBytes <= TAPE_RECORD_PAGE_RAW_QUANTUM_BYTES;
}

function trySelectTapeFallbackUnit(
  state: TimelinePageSelection,
  cappedLimit: number,
  anchor: MessageLike,
  orderSeq: number,
  header: UnifiedTimelineTapeHeader | null,
  reason: TapeDisplayDegradeReason,
  upperOrdinal: number,
): boolean {
  const fallbackText = header
    ? (header.visibleHead?.text ?? String(anchor.text ?? ""))
    : String(anchor.text ?? "");
  const fallbackBytes = Buffer.byteLength(fallbackText, "utf8");
  if (!canFitOnTimelinePage(state, cappedLimit, fallbackBytes)) {
    state.foundNextVisible = true;
    state.hasMore = true;
    return false;
  }
  state.selected.push({ kind: "tape-fallback", anchor, orderSeq, header, reason });
  if (header) state.windows.push({ anchor, orderSeq, header, lowerOrdinal: 0, upperOrdinal });
  state.inlineBytes += fallbackBytes;
  return true;
}

function selectPublishedTapeHeads(
  state: TimelinePageSelection,
  cappedLimit: number,
  anchor: MessageLike,
  orderSeq: number,
  header: UnifiedTimelineTapeHeader,
  heads: UnifiedTimelineTapeHead[],
  upperOrdinal: number,
): boolean {
  let oldestSelectedOrdinal: number | null = null;
  for (const head of heads) {
    const payloadBytes = bigIntNum(head.payload_bytes, "turn tape timeline payload bytes");
    const pageBytes = deferUnifiedTimelinePayload(head.role, payloadBytes) ? 0 : payloadBytes;
    if (!canFitOnTimelinePage(state, cappedLimit, pageBytes)) {
      state.foundNextVisible = true;
      state.hasMore = true;
      if (oldestSelectedOrdinal !== null) {
        state.windows.push({
          anchor, orderSeq, header, lowerOrdinal: oldestSelectedOrdinal, upperOrdinal,
        });
        state.continuation = { anchor, header, beforeOrdinal: oldestSelectedOrdinal };
      }
      return false;
    }
    state.selected.push({ kind: "tape", anchor, orderSeq, header, head });
    state.inlineBytes += pageBytes;
    oldestSelectedOrdinal = head.ordinal;
  }
  const missingFinalRecord =
    unifiedTimelineTapeMissingFinalRecord({ heads, beforeOrdinal: upperOrdinal }) &&
    unifiedTimelineFinalFallbackText({ header, anchor }).length > 0;
  state.windows.push({
    anchor, orderSeq, header, lowerOrdinal: 0, upperOrdinal,
    ...(missingFinalRecord ? { missingFinalRecord: true } : {}),
  });
  return true;
}

function selectCompleteTapeAnchor(
  state: TimelinePageSelection,
  cappedLimit: number,
  anchor: MessageLike,
  orderSeq: number,
  headers: Map<string, UnifiedTimelineTapeHeader>,
  beforeByTape: Map<string, number>,
  headsByTape: Map<string, UnifiedTimelineTapeHead[]>,
): boolean {
  const header = headers.get(anchor._turnTapeId as string);
  if (!header) {
    return trySelectTapeFallbackUnit(
      state, cappedLimit, anchor, orderSeq, null, "finalized_tape_missing", 2_147_483_647,
    );
  }
  const upperOrdinal = beforeByTape.get(header.tapeId) ?? 2_147_483_647;
  if (header.tapeSha256 !== anchor._turnTapeSha256) {
    return trySelectTapeFallbackUnit(
      state, cappedLimit, anchor, orderSeq, header, "tape_hash_mismatch", upperOrdinal,
    );
  }
  if (!recordsPublished({
    materializationStatus: header.materializationStatus,
    finalizedAt: header.finalizedAt,
  })) {
    const reason: TapeDisplayDegradeReason = header.materializationStatus === "failed"
      ? "records_failed"
      : "records_unpublished";
    return trySelectTapeFallbackUnit(state, cappedLimit, anchor, orderSeq, header, reason, upperOrdinal);
  }
  return selectPublishedTapeHeads(
    state, cappedLimit, anchor, orderSeq, header, headsByTape.get(header.tapeId) ?? [], upperOrdinal,
  );
}

function selectTimelinePageUnits(
  outerMessages: MessageLike[],
  cappedLimit: number,
  headers: Map<string, UnifiedTimelineTapeHeader>,
  beforeByTape: Map<string, number>,
  headsByTape: Map<string, UnifiedTimelineTapeHead[]>,
): TimelinePageSelection {
  const state: TimelinePageSelection = {
    selected: [],
    windows: [],
    inlineBytes: 0,
    hasMore: false,
    foundNextVisible: false,
    continuation: null,
  };
  for (const anchor of outerMessages) {
    const orderSeq = anchor._orderSeq;
    if (typeof orderSeq !== "number" || !Number.isSafeInteger(orderSeq) || orderSeq < 1) continue;
    const isCompleteTape =
      anchor._turnTapeComplete === true &&
      typeof anchor._turnTapeId === "string" &&
      typeof anchor._turnTapeSha256 === "string";
    if (isCompleteTape) {
      if (!selectCompleteTapeAnchor(state, cappedLimit, anchor, orderSeq, headers, beforeByTape, headsByTape)) {
        break;
      }
      continue;
    }
    if (anchor.role === "runtime-event") continue;
    const pageBytes = Buffer.byteLength(JSON.stringify(anchor), "utf8");
    if (!canFitOnTimelinePage(state, cappedLimit, pageBytes)) {
      state.foundNextVisible = true;
      state.hasMore = true;
      break;
    }
    state.selected.push({ kind: "outer", anchor, orderSeq });
    state.inlineBytes += pageBytes;
  }
  return state;
}

function validateResumeTapeCursor(
  cursor: ClientTimelineCursor | null,
  tapeAnchors: MessageLike[],
  headers: Map<string, UnifiedTimelineTapeHeader>,
  deps: PgSessionsDeps,
): void {
  if (!cursor?.tapeId) return;
  const resumeAnchor = tapeAnchors.find((anchor) =>
    anchor._orderSeq === cursor.beforeOrderSeq && anchor._turnTapeId === cursor.tapeId);
  const header = headers.get(cursor.tapeId);
  if (
    !resumeAnchor || !header ||
    resumeAnchor._turnTapeSha256 !== cursor.tapeSha256 ||
    header.tapeSha256 !== cursor.tapeSha256
  ) {
    throw new deps.storage.ClientTimelineCursorStaleError();
  }
}

async function expandTimelineCandidateWindow(
  client: PoolClient,
  sessionId: string,
  userId: string,
  parsedHot: ParsedHotTimelineMessages,
  archivedThroughSeq: number,
  cursor: ClientTimelineCursor | null,
  cappedLimit: number,
  deps: PgSessionsDeps,
): Promise<{ snapshotMaxSeq: number; selection: TimelinePageSelection }> {
  let candidateLimit = cappedLimit + 1;
  for (;;) {
    const outer = await readUnifiedTimelineOuterCandidates(
      client, sessionId, userId, parsedHot.hot, parsedHot.snapshotMaxSeq,
      archivedThroughSeq, cursor, candidateLimit, deps,
    );
    const tapeAnchors = outer.messages.filter((message) =>
      message._turnTapeComplete === true &&
      typeof message._turnTapeId === "string" &&
      typeof message._turnTapeSha256 === "string");
    const tapeIds = [...new Set(tapeAnchors.map((message) => message._turnTapeId as string))];
    const headers = await readUnifiedTimelineTapeHeaders(client, sessionId, userId, tapeIds);
    const beforeByTape = new Map<string, number>();
    for (const anchor of tapeAnchors) {
      const tapeId = anchor._turnTapeId as string;
      beforeByTape.set(tapeId, cursor?.tapeId === tapeId ? (cursor.beforeOrdinal ?? 0) : 2_147_483_647);
    }
    const headRequests = [...beforeByTape].map(([tapeId, beforeOrdinal]) => ({ tapeId, beforeOrdinal }));
    const headsByTape = await readUnifiedTimelineTapeHeads(client, sessionId, userId, headRequests, cappedLimit + 1);
    validateResumeTapeCursor(cursor, tapeAnchors, headers, deps);
    const selection = selectTimelinePageUnits(outer.messages, cappedLimit, headers, beforeByTape, headsByTape);
    if (selection.foundNextVisible || !outer.hasOlderCandidates) {
      return { snapshotMaxSeq: outer.snapshotMaxSeq, selection };
    }
    candidateLimit = Math.max(candidateLimit + 1, candidateLimit * 2);
  }
}

// ── Chronological assembly, sorting & cursor construction ────────────────────

async function resolveOuterTimelineMessages(
  client: PoolClient,
  sessionId: string,
  userId: string,
  unit: SelectedOuterUnit,
): Promise<MessageLike[]> {
  if (
    unit.anchor._turnTapeComplete === true ||
    typeof unit.anchor._turnTapeId !== "string" ||
    typeof unit.anchor._turnTapeSha256 !== "string"
  ) {
    return [unit.anchor];
  }
  try {
    return await hydrateTurnTapeMessages(client, sessionId, userId, [unit.anchor], { view: "exact" });
  } catch (error) {
    return unifiedTimelineTapeFallbackMessages(sessionId, {
      tapeId: String(unit.anchor._turnTapeId),
      orderSeq: unit.orderSeq,
      reason: classifyUnifiedTimelineIntegrityError(error),
      header: null,
      anchor: unit.anchor,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

function appendOuterAndStatusMessages(
  chronological: MessageLike[],
  unit: SelectedOuterUnit,
  outerMessages: MessageLike[],
  statuses: Map<number, MessageLike[]>,
): void {
  const outerKey = timelineOuterKey(unit.anchor, unit.orderSeq);
  for (let index = 0; index < outerMessages.length; index++) {
    const message = outerMessages[index]!;
    chronological.push({
      ...message,
      _timelineRecord: true,
      _timelineLogicalOrdinal: index,
      _timelineUnitKey: outerMessages.length === 1
        ? outerKey
        : `${outerKey}:${index}:${String(message.id ?? "anonymous")}`,
    });
  }
  if (unit.anchor.role !== "user" || typeof unit.anchor._seq !== "number") return;
  const unitStatuses = statuses.get(unit.anchor._seq) ?? [];
  for (let statusIndex = 0; statusIndex < unitStatuses.length; statusIndex++) {
    chronological.push({
      ...unitStatuses[statusIndex]!,
      _orderSeq: unit.orderSeq,
      _timelineLogicalOrdinal: outerMessages.length + statusIndex,
    });
  }
}

async function assembleChronologicalTimeline(
  client: PoolClient,
  sessionId: string,
  userId: string,
  selected: UnifiedTimelineSelectedUnit[],
  tapeMessages: Map<string, MessageLike[]>,
  statuses: Map<number, MessageLike[]>,
): Promise<MessageLike[]> {
  const chronological: MessageLike[] = [];
  for (const unit of [...selected].reverse()) {
    if (unit.kind === "tape-fallback") {
      chronological.push(...unifiedTimelineTapeFallbackMessages(sessionId, {
        tapeId: unit.header?.tapeId ?? String(unit.anchor._turnTapeId),
        orderSeq: unit.orderSeq, reason: unit.reason, header: unit.header, anchor: unit.anchor,
      }));
      continue;
    }
    if (unit.kind === "tape") {
      const records = tapeMessages.get(`${unit.header.tapeId}\0${unit.head.ordinal}`);
      chronological.push(...(records ?? unifiedTimelineTapeFallbackMessages(sessionId, {
        tapeId: unit.header.tapeId, orderSeq: unit.orderSeq, reason: "hydrated_group_missing",
        header: unit.header, anchor: unit.anchor,
      })));
      continue;
    }
    const outerMessages = await resolveOuterTimelineMessages(client, sessionId, userId, unit);
    appendOuterAndStatusMessages(chronological, unit, outerMessages, statuses);
  }
  return chronological;
}

function timelineMessageOrderSeq(message: MessageLike): number {
  return typeof message._orderSeq === "number" && Number.isSafeInteger(message._orderSeq)
    ? message._orderSeq
    : Number.MAX_SAFE_INTEGER;
}

function timelineMessageTapeOrdinal(message: MessageLike): number | null {
  return typeof message._turnTapeId === "string" &&
    message._turnTapeId.length > 0 &&
    typeof message._turnTapeOrdinal === "number" &&
    Number.isSafeInteger(message._turnTapeOrdinal)
    ? message._turnTapeOrdinal
    : null;
}

function compareChronologicalTimelineMessages(
  a: MessageLike,
  b: MessageLike,
  deps: PgSessionsDeps,
): number {
  const aTape = timelineMessageTapeOrdinal(a);
  const bTape = timelineMessageTapeOrdinal(b);
  const aRank = a._turnTapeProcess === true ? 0 : aTape !== null ? 1 : 2;
  const bRank = b._turnTapeProcess === true ? 0 : bTape !== null ? 1 : 2;
  if (timelineMessageOrderSeq(a) === timelineMessageOrderSeq(b) && aRank === bRank && aTape === bTape) {
    const aLogical = typeof a._timelineLogicalOrdinal === "number" ? a._timelineLogicalOrdinal : 0;
    const bLogical = typeof b._timelineLogicalOrdinal === "number" ? b._timelineLogicalOrdinal : 0;
    if (aLogical !== bLogical) return aLogical - bLogical;
  }
  const ordered = deps.storage.compareMessagesByOrder(a, b);
  if (ordered !== 0) return ordered;
  return String(a._timelineUnitKey ?? a.id ?? "").localeCompare(String(b._timelineUnitKey ?? b.id ?? ""));
}

function buildNextTimelineCursor(
  selection: TimelinePageSelection,
  timelineGeneration: number,
): ClientTimelineCursor | null {
  if (!selection.hasMore || selection.selected.length === 0) return null;
  const oldest = selection.selected.at(-1)!;
  const continuation = selection.continuation;
  if (continuation && oldest.kind === "tape" && oldest.header.tapeId === continuation.header.tapeId) {
    return {
      version: 1,
      timelineGeneration,
      beforeOrderSeq: continuation.anchor._orderSeq as number,
      tapeId: continuation.header.tapeId,
      tapeSha256: continuation.header.tapeSha256,
      beforeOrdinal: continuation.beforeOrdinal,
    };
  }
  return { version: 1, timelineGeneration, beforeOrderSeq: oldest.orderSeq };
}

async function readClientTimelineSnapshot(
  client: PoolClient,
  sessionId: string,
  userId: string,
  cursor: ClientTimelineCursor | null,
  cappedLimit: number,
  deps: PgSessionsDeps,
  preloadedSession?: PreloadedTimelineSession,
): Promise<ClientTimelinePage | null> {
  const session = preloadedSession ?? (
    await client.query<PreloadedTimelineSession>(READ_TIMELINE_SESSION_SQL, [sessionId, userId])
  ).rows[0];
  if (!session) return null;
  const timelineGeneration = bigIntNum(session.timeline_generation, "timeline_generation");
  if (cursor && cursor.timelineGeneration !== timelineGeneration) {
    throw new deps.storage.ClientTimelineCursorStaleError();
  }
  const archivedThroughSeq = bigIntNumOr(session.archived_through_seq, 0);
  const parsedHot = preloadedSession?.parsedHotMessages
    ? summarizeHotTimelineMessages(preloadedSession.parsedHotMessages, archivedThroughSeq)
    : parseHotTimelineMessages(session.messages, archivedThroughSeq, sessionId);
  const { snapshotMaxSeq, selection } = await expandTimelineCandidateWindow(
    client, sessionId, userId, parsedHot, archivedThroughSeq, cursor, cappedLimit, deps,
  );
  const selectedTapeUnits = selection.selected.filter((unit): unit is SelectedTapeUnit => unit.kind === "tape");
  const tapeMessages = await hydrateUnifiedTimelineTapeUnits(client, sessionId, userId, selectedTapeUnits);
  const bashTailAuxiliaries = await readUnifiedTimelineBashTailAuxiliaries(
    client, sessionId, userId, selection.windows, TAPE_RECORD_PAGE_RAW_QUANTUM_BYTES - selection.inlineBytes,
  );
  const finalFallbackAuxiliaries = selection.windows.flatMap((window) =>
    window.missingFinalRecord === true
      ? unifiedTimelineTapeFallbackMessages(sessionId, {
          tapeId: window.header.tapeId, orderSeq: window.orderSeq, reason: "final_record_missing",
          header: window.header, anchor: window.anchor,
        })
      : []);
  const terminalAuxiliaries = selection.windows.map(unifiedTimelineTerminalAuxiliary);
  const selectedUserSeqs = selection.selected.flatMap((unit) =>
    unit.kind === "outer" && unit.anchor.role === "user" &&
    typeof unit.anchor._seq === "number" && Number.isSafeInteger(unit.anchor._seq)
      ? [unit.anchor._seq] : []);
  const statuses = await readUnifiedTimelineStatuses(client, userId, sessionId, selectedUserSeqs);
  const chronological = await assembleChronologicalTimeline(
    client, sessionId, userId, selection.selected, tapeMessages, statuses,
  );
  chronological.push(...bashTailAuxiliaries, ...finalFallbackAuxiliaries, ...terminalAuxiliaries);
  chronological.sort((a, b) => compareChronologicalTimelineMessages(a, b, deps));
  return {
    messages: chronological,
    nextCursor: buildNextTimelineCursor(selection, timelineGeneration),
    hasMore: selection.hasMore,
    timelineGeneration,
    historyRevision: bigIntNum(session.history_revision, "history_revision"),
    snapshotMaxSeq,
  };
}

/** The browser's sole historical read path: one exact chronological stream
 * across ordinary rows and immutable tape physical records. */
export async function readClientTimelinePageImpl(
  pool: Pool,
  sessionId: string,
  userId: string,
  cursor: ClientTimelineCursor | null,
  limit: number,
  deps: PgSessionsDeps,
  existingClient?: PoolClient,
  preloadedSession?: PreloadedTimelineSession,
): Promise<ClientTimelinePage | null> {
  const cappedLimit = Math.max(1, Math.min(
    TAPE_RECORD_PAGE_MAX_ROWS,
    Number.isFinite(limit) ? Math.floor(limit) : 100,
  ));
  const run = (client: PoolClient) =>
    readClientTimelineSnapshot(client, sessionId, userId, cursor, cappedLimit, deps, preloadedSession);
  return existingClient ? run(existingClient) : withTimelineSnapshot(pool, run);
}

export function createPgTimelinePageReader(
  ctx: PgSessionsCtx,
): Pick<ClientSessionsBackend, "readClientTimelinePage"> {
  return {
    readClientTimelinePage(sessionId, userId, cursor = null, limit = 100) {
      return readClientTimelinePageImpl(ctx.pool, sessionId, userId, cursor, limit, ctx.deps);
    },
  };
}
