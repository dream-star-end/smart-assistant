import type { PoolClient } from "pg";
import type { ClientTimelineCursor, MessageLike } from "@openclaude/storage";
import { precomputedTapePayloadBytesSql } from "../pgTimelinePerf.js";
import {
  classifyUnifiedTimelineIntegrityError,
  pickTapeDisplayFallbackText,
  warnTapeDisplayDegrade,
  type TapeDisplayDegradeReason,
  type VisibleHead,
} from "../visibleFinalize.js";
import type { PgSessionsDeps } from "./deps.js";
import { hydrateDirectTapePage } from "./pgTapeHydrateReader.js";
import {
  TAPE_RECORD_INLINE_QUANTUM_BYTES,
  TAPE_RECORD_PAGE_MAX_ROWS,
  TAPE_RECORD_PAGE_RAW_QUANTUM_BYTES,
} from "./pgTapeSanitizeAndEncode.js";
import {
  attachFallbackSettlementUsage,
  deferredTapeRecord,
  mergeTapeFallbackSettlements,
  stampTapeLifecycle,
} from "./pgTapeUsageAndRecordHydrate.js";
import { bigIntNum } from "./sqlHelpers.js";
import type {
  DirectTapePageHead,
  UnifiedTimelineStatusRow,
  UnifiedTimelineTapeHead,
  UnifiedTimelineTapeHeader,
  UnifiedTimelineTapeWindow,
} from "./types.js";

// ── Unit keys & outer candidate discovery ────────────────────────────────────

export function timelineOuterKey(message: MessageLike, orderSeq: number): string {
  return `outer:${orderSeq}:${typeof message.id === "string" ? message.id : "anonymous"}`;
}

export function timelineTapeKey(tapeId: string, ordinal: number, logicalIndex: number, id: unknown): string {
  return `tape:${tapeId}:${ordinal}:${logicalIndex}:${typeof id === "string" ? id : "anonymous"}`;
}

const READ_TIMELINE_ARCHIVE_CHUNKS_SQL = `SELECT messages,last_seq::text FROM client_session_archive_chunks
  WHERE session_id=$1 AND user_id=$2 AND first_seq < $3::bigint AND ($4::bigint IS NULL OR last_seq < $4)
  ORDER BY last_seq DESC LIMIT 4`;

async function fetchTimelineArchiveChunkBatch(
  client: PoolClient,
  sessionId: string,
  userId: string,
  archiveBefore: number,
  beforeLastSeq: number | null,
): Promise<Array<{ messages: string; last_seq: string }>> {
  return (await client.query<{ messages: string; last_seq: string }>(
    READ_TIMELINE_ARCHIVE_CHUNKS_SQL, [sessionId, userId, archiveBefore, beforeLastSeq],
  )).rows;
}

function parseTimelineArchiveChunk(raw: string, deps: PgSessionsDeps): MessageLike[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? deps.storage.deriveArchivedOrderSeqsForRead(parsed as MessageLike[]) : [];
  } catch (err) {
    // Match the existing archive contract: skip malformed chunks without fabrication.
    void err;
    return [];
  }
}

function isEligibleOuterCandidate(message: MessageLike, beforeOrderSeq: number, resumeTape: boolean): boolean {
  const orderSeq = message._orderSeq;
  if (typeof orderSeq !== "number" || !Number.isSafeInteger(orderSeq) || orderSeq < 1 || message._turnTapeProcess === true) {
    return false;
  }
  return orderSeq < beforeOrderSeq || (resumeTape && orderSeq === beforeOrderSeq);
}

/** Read enough durable outer anchors to cover one logical browser page. */
export async function readUnifiedTimelineOuterCandidates(
  client: PoolClient,
  sessionId: string,
  userId: string,
  hotMessages: MessageLike[],
  snapshotMaxSeq: number,
  archivedThroughSeq: number,
  cursor: ClientTimelineCursor | null,
  maxCandidates: number,
  deps: PgSessionsDeps,
): Promise<{ messages: MessageLike[]; snapshotMaxSeq: number; hasOlderCandidates: boolean }> {
  const beforeOrderSeq = cursor?.beforeOrderSeq ?? Number.MAX_SAFE_INTEGER;
  const resumeTape = typeof cursor?.tapeId === "string";
  const deduped = new Map<string, MessageLike>();
  const addEligible = (message: MessageLike): void => {
    if (!isEligibleOuterCandidate(message, beforeOrderSeq, resumeTape)) return;
    const key = timelineOuterKey(message, message._orderSeq as number);
    if (!deduped.has(key)) deduped.set(key, message);
  };
  for (const message of hotMessages) addEligible(message);

  let beforeLastSeq: number | null = null;
  let archiveExhausted = archivedThroughSeq <= 0;
  const archiveBefore = Math.min(Number.MAX_SAFE_INTEGER, beforeOrderSeq + (resumeTape ? 1 : 0));
  while (deduped.size <= maxCandidates && !archiveExhausted) {
    const chunks = await fetchTimelineArchiveChunkBatch(client, sessionId, userId, archiveBefore, beforeLastSeq);
    if (chunks.length === 0) {
      archiveExhausted = true;
      break;
    }
    for (const chunk of chunks) {
      beforeLastSeq = bigIntNum(chunk.last_seq, "archive last_seq");
      for (const message of parseTimelineArchiveChunk(chunk.messages, deps)) addEligible(message);
      if (deduped.size > maxCandidates) break;
    }
    if (chunks.length < 4) archiveExhausted = true;
  }

  const ordered = [...deduped.values()].sort(deps.storage.compareMessagesByOrder);
  return {
    messages: ordered.slice(-maxCandidates).reverse(),
    snapshotMaxSeq,
    hasOlderCandidates: deduped.size > maxCandidates || !archiveExhausted,
  };
}

// ── Tape header & semantic head readers ──────────────────────────────────────

type UnifiedTimelineTapeHeaderRow = {
  tape_id: string;
  tape_sha256: string;
  billing_anchor_id: string;
  status: string;
  turn_key: string;
  client_message_id: string | null;
  continuation_of_turn_key: string | null;
  materialization_status: string | null;
  finalized_at: string | null;
  visible_head: VisibleHead | null;
};

const READ_UNIFIED_TIMELINE_TAPE_HEADERS_SQL = `SELECT t.tape_id,t.tape_sha256,t.billing_anchor_id,t.status,t.turn_key,
        COALESCE(t.client_message_id,d.client_message_id) AS client_message_id,
        t.continuation_of_turn_key, t.materialization_status, t.finalized_at::text, t.visible_head
   FROM client_session_turn_tapes t LEFT JOIN turn_dispatches d ON d.dispatch_id=t.dispatch_id
  WHERE t.session_id=$1 AND t.user_id=$2 AND t.tape_id=ANY($3::text[])
    AND (t.visible_at IS NOT NULL OR t.finalized_at IS NOT NULL) AND t.billing_anchor_id IS NOT NULL`;

export async function readUnifiedTimelineTapeHeaders(
  client: PoolClient,
  sessionId: string,
  userId: string,
  tapeIds: string[],
): Promise<Map<string, UnifiedTimelineTapeHeader>> {
  if (tapeIds.length === 0) return new Map();
  const rows = (await client.query<UnifiedTimelineTapeHeaderRow>(
    READ_UNIFIED_TIMELINE_TAPE_HEADERS_SQL, [sessionId, userId, tapeIds],
  )).rows;
  const headers = new Map<string, UnifiedTimelineTapeHeader>(rows.map((row) => [row.tape_id, {
    tapeId: row.tape_id,
    tapeSha256: row.tape_sha256,
    billingAnchorId: row.billing_anchor_id,
    status: row.status,
    turnKey: row.turn_key,
    clientMessageId: row.client_message_id,
    continuationOfTurnKey: row.continuation_of_turn_key,
    materializationStatus: row.materialization_status ?? null,
    finalizedAt: row.finalized_at ?? null,
    visibleHead: row.visible_head ?? null,
  }]));
  await mergeTapeFallbackSettlements(client, sessionId, userId, headers);
  return headers;
}

const READ_UNIFIED_TIMELINE_TAPE_HEADS_SQL = `WITH requested(tape_id,before_ordinal) AS (SELECT * FROM unnest($3::text[],$4::integer[]))
 SELECT requested.tape_id,r.msg_id,r.ordinal,r.role,r.ts::text,r.content_sha256,r.payload_bytes,r.visible_content_sha256
   FROM requested
   JOIN LATERAL (
     SELECT msg_id,ordinal,role,ts,content_sha256,${precomputedTapePayloadBytesSql("r")}::text AS payload_bytes,visible_content_sha256
       FROM client_session_turn_tape_records r
      WHERE r.session_id=$1 AND r.user_id=$2 AND r.tape_id=requested.tape_id
        AND r.ordinal < requested.before_ordinal AND r.role <> 'runtime-event'
        AND COALESCE(r.is_superseded_api_error, FALSE) = FALSE
        AND NOT (r.is_superseded_api_error IS NULL AND r.role='assistant'
          AND EXISTS (SELECT 1 FROM client_session_turn_tape_model_records failed
             WHERE failed.session_id=r.session_id AND failed.user_id=r.user_id AND failed.tape_id=r.tape_id
               AND failed.physical_ordinal=r.ordinal AND failed.role='assistant' AND failed.semantic_text LIKE 'API Error:%')
          AND EXISTS (SELECT 1 FROM client_session_turn_tape_model_records recovered
             WHERE recovered.session_id=r.session_id AND recovered.user_id=r.user_id AND recovered.tape_id=r.tape_id
               AND recovered.physical_ordinal > r.ordinal AND recovered.role='assistant'))
      ORDER BY ordinal DESC LIMIT $5
   ) r ON TRUE
  ORDER BY requested.tape_id,r.ordinal DESC`;

export async function readUnifiedTimelineTapeHeads(
  client: PoolClient,
  sessionId: string,
  userId: string,
  requests: Array<{ tapeId: string; beforeOrdinal: number }>,
  perTapeLimit: number,
): Promise<Map<string, UnifiedTimelineTapeHead[]>> {
  if (requests.length === 0) return new Map();
  const rows = (await client.query<UnifiedTimelineTapeHead>(READ_UNIFIED_TIMELINE_TAPE_HEADS_SQL, [
    sessionId, userId, requests.map((r) => r.tapeId), requests.map((r) => r.beforeOrdinal), perTapeLimit,
  ])).rows;
  const byTape = new Map<string, UnifiedTimelineTapeHead[]>();
  for (const row of rows) {
    const list = byTape.get(row.tape_id) ?? [];
    list.push(row);
    byTape.set(row.tape_id, list);
  }
  return byTape;
}

// ── Bash-tail auxiliary reader ───────────────────────────────────────────────

type BashTailProbeRow = DirectTapePageHead & { tape_id: string; probe_bytes: Buffer | null };

type BashTailCandidate = {
  message: MessageLike;
  head: DirectTapePageHead;
  window: UnifiedTimelineTapeWindow;
  ownerTurnKey: string;
  parentToolUseId: string;
  toolUseId: string;
  totalBytes: number;
  ordinal: number;
};

const READ_BASH_TAIL_INDEXED_HEADS_SQL = `WITH requested(tape_id,lower_ordinal,upper_ordinal) AS (
   SELECT * FROM unnest($3::text[],$4::integer[],$5::integer[])
 )
 SELECT requested.tape_id,r.msg_id,r.ordinal,r.role,r.ts::text,r.content_sha256,
        ${precomputedTapePayloadBytesSql("r")}::text AS payload_bytes,r.visible_content_sha256
   FROM requested
   JOIN client_session_turn_tape_records r ON r.session_id=$1 AND r.user_id=$2 AND r.tape_id=requested.tape_id
    AND r.ordinal >= requested.lower_ordinal AND r.ordinal < requested.upper_ordinal
  WHERE r.role='runtime-event'
    AND EXISTS (SELECT 1 FROM client_session_turn_tape_model_records m
       WHERE m.session_id=r.session_id AND m.user_id=r.user_id AND m.tape_id=r.tape_id
         AND m.physical_ordinal=r.ordinal AND m.role='tool')
  ORDER BY requested.tape_id,r.ordinal`;

const READ_BASH_TAIL_PROBE_ROWS_SQL = `WITH requested(tape_id,lower_ordinal,upper_ordinal) AS (
   SELECT * FROM unnest($3::text[],$4::integer[],$5::integer[])
 )
 SELECT requested.tape_id,r.msg_id,r.ordinal,r.role,r.ts::text,r.content_sha256,
        ${precomputedTapePayloadBytesSql("r")}::text AS payload_bytes,r.visible_content_sha256,
        COALESCE(r.visible_payload,r.payload) AS probe_bytes
   FROM requested
   JOIN client_session_turn_tape_records r ON r.session_id=$1 AND r.user_id=$2 AND r.tape_id=requested.tape_id
    AND r.ordinal >= requested.lower_ordinal AND r.ordinal < requested.upper_ordinal
  WHERE r.role='runtime-event' AND r.model_sidecar_complete=FALSE
    AND position(convert_to('bash_output_tail','UTF8') IN COALESCE(r.visible_payload,r.payload)) > 0
  ORDER BY requested.tape_id,r.ordinal`;

function collectProbeMatchedHeads(
  sessionId: string,
  probeRows: BashTailProbeRow[],
): Array<DirectTapePageHead & { tape_id: string }> {
  const probesByTape = new Map<string, BashTailProbeRow[]>();
  for (const row of probeRows) {
    const list = probesByTape.get(row.tape_id) ?? [];
    list.push(row);
    probesByTape.set(row.tape_id, list);
  }
  const matched: Array<DirectTapePageHead & { tape_id: string }> = [];
  for (const [tapeId, tapeProbeRows] of probesByTape) {
    try {
      for (const row of tapeProbeRows) {
        if (row.probe_bytes === null) continue;
        if (!Buffer.from(row.probe_bytes).toString("utf8").includes("bash_output_tail")) continue;
        matched.push({
          tape_id: row.tape_id, msg_id: row.msg_id, ordinal: row.ordinal, role: row.role, ts: row.ts,
          content_sha256: row.content_sha256, payload_bytes: row.payload_bytes,
          visible_content_sha256: row.visible_content_sha256,
        });
      }
    } catch (error) {
      warnTapeDisplayDegrade({
        sessionId, tapeId,
        reason: classifyUnifiedTimelineIntegrityError(error),
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return matched;
}

async function loadBashTailHeadsByTape(
  client: PoolClient,
  sessionId: string,
  userId: string,
  windows: UnifiedTimelineTapeWindow[],
): Promise<Map<string, DirectTapePageHead[]>> {
  const windowParams = [
    sessionId, userId,
    windows.map((w) => w.header.tapeId), windows.map((w) => w.lowerOrdinal), windows.map((w) => w.upperOrdinal),
  ];
  const indexedHeads = (await client.query<DirectTapePageHead & { tape_id: string }>(
    READ_BASH_TAIL_INDEXED_HEADS_SQL, windowParams,
  )).rows;
  const probeRows = (await client.query<BashTailProbeRow>(READ_BASH_TAIL_PROBE_ROWS_SQL, windowParams)).rows;
  const matchedHeads = [...indexedHeads, ...collectProbeMatchedHeads(sessionId, probeRows)];
  matchedHeads.sort((a, b) => a.tape_id.localeCompare(b.tape_id) || a.ordinal - b.ordinal);
  const headsByTape = new Map<string, DirectTapePageHead[]>();
  for (const head of matchedHeads) {
    const list = headsByTape.get(head.tape_id) ?? [];
    list.push(head);
    headsByTape.set(head.tape_id, list);
  }
  return headsByTape;
}

function enrichBashTailMessage(
  message: MessageLike,
  head: DirectTapePageHead,
  window: UnifiedTimelineTapeWindow,
): MessageLike {
  return {
    ...message,
    _source: "server",
    _orderSeq: window.orderSeq,
    ...(typeof window.anchor._seq === "number" ? { _seq: window.anchor._seq } : {}),
    _turnTapeId: window.header.tapeId,
    _turnTapeOrdinal: head.ordinal,
    _recordOrdinal: head.ordinal,
    _turnTapeSha256: window.header.tapeSha256,
    _turnTapeComplete: true,
    _turnKey: window.header.turnKey,
    _dispatchOutcome: window.header.status,
    ...(window.header.clientMessageId && typeof message._clientMessageId !== "string"
      ? { _clientMessageId: window.header.clientMessageId } : {}),
    _timelineRecord: true,
    _timelineAuxiliary: "bash-tail",
    _timelineUnitKey: `aux:tail:${window.header.tapeId}:${head.ordinal}`,
  };
}

function buildBashTailLocator(head: DirectTapePageHead, window: UnifiedTimelineTapeWindow): MessageLike {
  return enrichBashTailMessage(
    deferredTapeRecord(
      window.header.tapeId,
      window.header.tapeSha256,
      { ...head, content_sha256: head.visible_content_sha256 ?? undefined },
      bigIntNum(head.payload_bytes, "turn tape timeline bash-tail payload bytes"),
      { continuationOfTurnKey: window.header.continuationOfTurnKey },
    ),
    head,
    window,
  );
}

function doesBashTailCandidateWin(candidate: BashTailCandidate, previous: BashTailCandidate): boolean {
  if (candidate.totalBytes !== previous.totalBytes) return candidate.totalBytes > previous.totalBytes;
  if (candidate.window.orderSeq !== previous.window.orderSeq) {
    return candidate.window.orderSeq > previous.window.orderSeq;
  }
  const tapeOrder = candidate.window.header.tapeId.localeCompare(previous.window.header.tapeId);
  return tapeOrder !== 0 ? tapeOrder > 0 : candidate.ordinal > previous.ordinal;
}

function extractBashTailCandidate(
  message: MessageLike,
  headByOrdinal: Map<number, DirectTapePageHead>,
  window: UnifiedTimelineTapeWindow,
): BashTailCandidate | null {
  const ordinal = typeof message._recordOrdinal === "number" ? message._recordOrdinal : -1;
  const head = headByOrdinal.get(ordinal);
  if (!head || message._payloadDeferred === true) return null;
  const event = message._runtimeEvent;
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const raw = event as Record<string, unknown>;
  if (raw.type !== "system" || raw.subtype !== "bash_output_tail" || typeof raw.tool_use_id !== "string" || raw.tool_use_id.length === 0) {
    return null;
  }
  const ownerTurnKey = typeof message._continuationOfTurnKey === "string" && message._continuationOfTurnKey.length > 0
    ? message._continuationOfTurnKey : window.header.turnKey;
  const parentToolUseId = typeof raw.parent_tool_use_id === "string" ? raw.parent_tool_use_id : "";
  const totalBytes = typeof raw.total_bytes === "number" && Number.isFinite(raw.total_bytes)
    ? Math.max(0, raw.total_bytes) : 0;
  return {
    message: enrichBashTailMessage(message, head, window),
    head, window, ownerTurnKey, parentToolUseId, toolUseId: raw.tool_use_id, totalBytes, ordinal,
  };
}

async function flushBashTailInlineBatch(
  client: PoolClient,
  sessionId: string,
  userId: string,
  window: UnifiedTimelineTapeWindow,
  selectedHeads: DirectTapePageHead[],
  winners: Map<string, BashTailCandidate>,
): Promise<void> {
  if (selectedHeads.length === 0) return;
  const hydrated = await hydrateDirectTapePage(
    client, sessionId, userId, window.header.tapeId, window.header.tapeSha256,
    window.header.billingAnchorId, selectedHeads,
    { continuationOfTurnKey: window.header.continuationOfTurnKey },
  ).catch((error: unknown) => {
    warnTapeDisplayDegrade({
      sessionId, tapeId: window.header.tapeId,
      reason: classifyUnifiedTimelineIntegrityError(error),
      detail: error instanceof Error ? error.message : String(error),
    });
    return [] as MessageLike[];
  });
  const headByOrdinal = new Map(selectedHeads.map((head) => [head.ordinal, head]));
  for (const message of hydrated) {
    const candidate = extractBashTailCandidate(message, headByOrdinal, window);
    if (!candidate) continue;
    const key = `${candidate.ownerTurnKey}\0${candidate.parentToolUseId ? "child" : "top"}\0${candidate.toolUseId}`;
    const previous = winners.get(key);
    if (!previous || doesBashTailCandidateWin(candidate, previous)) winners.set(key, candidate);
  }
}

async function scanWindowBashTails(
  client: PoolClient,
  sessionId: string,
  userId: string,
  window: UnifiedTimelineTapeWindow,
  tapeHeads: DirectTapePageHead[],
  winners: Map<string, BashTailCandidate>,
  deferred: MessageLike[],
): Promise<void> {
  const inlineHeads: DirectTapePageHead[] = [];
  let inlineBytes = 0;
  for (const head of tapeHeads) {
    const payloadBytes = bigIntNum(head.payload_bytes, "turn tape timeline bash-tail payload bytes");
    if (payloadBytes > TAPE_RECORD_INLINE_QUANTUM_BYTES) {
      await flushBashTailInlineBatch(client, sessionId, userId, window, inlineHeads.splice(0), winners);
      inlineBytes = 0;
      deferred.push(buildBashTailLocator(head, window));
      continue;
    }
    const batchFull = inlineHeads.length >= TAPE_RECORD_PAGE_MAX_ROWS ||
      (inlineHeads.length > 0 && inlineBytes + payloadBytes > TAPE_RECORD_PAGE_RAW_QUANTUM_BYTES);
    if (batchFull) {
      await flushBashTailInlineBatch(client, sessionId, userId, window, inlineHeads.splice(0), winners);
      inlineBytes = 0;
    }
    inlineHeads.push(head);
    inlineBytes += payloadBytes;
  }
  await flushBashTailInlineBatch(client, sessionId, userId, window, inlineHeads.splice(0), winners);
}

function finalizeBashTailAuxiliaries(
  winners: Map<string, BashTailCandidate>,
  deferred: MessageLike[],
  inlineBudgetBytes: number,
): MessageLike[] {
  let budget = Math.max(0, inlineBudgetBytes);
  const orderedWinners = [...winners.values()].sort((a, b) =>
    (a.window.orderSeq - b.window.orderSeq) ||
    a.window.header.tapeId.localeCompare(b.window.header.tapeId) ||
    (a.ordinal - b.ordinal));
  const auxiliaries = [...deferred];
  for (const winner of orderedWinners) {
    const bytes = Buffer.byteLength(JSON.stringify(winner.message), "utf8");
    if (bytes <= budget) {
      auxiliaries.push(winner.message);
      budget -= bytes;
    } else {
      auxiliaries.push(buildBashTailLocator(winner.head, winner.window));
    }
  }
  return auxiliaries;
}

/** Bash stdout tails travel as hidden exact evidence to update their owning ToolCard. */
export async function readUnifiedTimelineBashTailAuxiliaries(
  client: PoolClient,
  sessionId: string,
  userId: string,
  windows: UnifiedTimelineTapeWindow[],
  inlineBudgetBytes: number,
): Promise<MessageLike[]> {
  if (windows.length === 0) return [];
  const headsByTape = await loadBashTailHeadsByTape(client, sessionId, userId, windows);
  const winners = new Map<string, BashTailCandidate>();
  const deferred: MessageLike[] = [];
  for (const window of windows) {
    const tapeHeads = headsByTape.get(window.header.tapeId) ?? [];
    if (tapeHeads.length === 0) continue;
    await scanWindowBashTails(client, sessionId, userId, window, tapeHeads, winners, deferred);
  }
  return finalizeBashTailAuxiliaries(winners, deferred, inlineBudgetBytes);
}

// ── Fallback & terminal auxiliaries ──────────────────────────────────────────

export function unifiedTimelineTapeMissingFinalRecord(input: {
  heads: UnifiedTimelineTapeHead[];
  beforeOrdinal: number;
}): boolean {
  if (input.beforeOrdinal < 2_147_483_647) return false;
  return input.heads.length === 0 || !input.heads.some((head) => head.role === "assistant");
}

export function unifiedTimelineFinalFallbackText(input: {
  header: UnifiedTimelineTapeHeader;
  anchor: MessageLike;
}): string {
  if (typeof input.header.visibleHead?.text === "string" && input.header.visibleHead.text.length > 0) {
    return input.header.visibleHead.text;
  }
  return typeof input.anchor.text === "string" ? input.anchor.text : "";
}

export function unifiedTimelineTerminalAuxiliary(window: UnifiedTimelineTapeWindow): MessageLike {
  return {
    id: `timeline-terminal:${window.header.tapeId}`,
    role: "system",
    text: "",
    ts: typeof window.anchor.ts === "number" ? window.anchor.ts : 0,
    _source: "server",
    ...(typeof window.anchor._seq === "number" ? { _seq: window.anchor._seq } : {}),
    _orderSeq: window.orderSeq,
    _turnTapeId: window.header.tapeId,
    _turnTapeSha256: window.header.tapeSha256,
    _turnTapeComplete: true,
    _turnKey: window.header.turnKey,
    _dispatchOutcome: window.header.status,
    ...(window.header.clientMessageId ? { _clientMessageId: window.header.clientMessageId } : {}),
    _timelineRecord: true,
    _timelineAuxiliary: "terminal",
    _timelineUnitKey: `aux:terminal:${window.header.tapeId}`,
  };
}

type TimelineFallbackUnit = {
  tapeId: string;
  orderSeq: number;
  reason: TapeDisplayDegradeReason;
  header: UnifiedTimelineTapeHeader | null;
  anchor: MessageLike;
  detail?: string;
};

function resolveTapeFallbackReason(
  header: UnifiedTimelineTapeHeader | null,
  requestedReason: TapeDisplayDegradeReason,
  pickedSource: "visible_head" | "anchor" | "placeholder",
): TapeDisplayDegradeReason {
  if (!header) return requestedReason === "finalized_tape_missing" ? "header_missing" : requestedReason;
  if (pickedSource === "placeholder" && !header.visibleHead && requestedReason !== "records_unpublished") {
    return "visible_head_missing";
  }
  return requestedReason;
}

function resolveTapeFallbackIdentity(unit: TimelineFallbackUnit) {
  const head = unit.header?.visibleHead;
  const headId = typeof head?.messageId === "string" && head.messageId.length > 0 ? head.messageId : null;
  const id = headId ?? unit.header?.billingAnchorId ?? (typeof unit.anchor.id === "string" ? unit.anchor.id : `tape-degraded:${unit.tapeId}`);
  const ts = typeof head?.ts === "number" && Number.isFinite(head.ts)
    ? head.ts : (typeof unit.anchor.ts === "number" && Number.isFinite(unit.anchor.ts) ? unit.anchor.ts : 0);
  const status = unit.header?.status ?? (typeof unit.anchor.status === "string" ? unit.anchor.status : "completed");
  const clientMessageId = unit.header?.clientMessageId
    ?? (typeof unit.anchor._clientMessageId === "string" ? unit.anchor._clientMessageId : undefined);
  return { id, ts, status, clientMessageId };
}

function buildTapeFallbackBaseMessage(
  unit: TimelineFallbackUnit,
  text: string,
  reason: TapeDisplayDegradeReason,
): MessageLike {
  const { id, ts, status, clientMessageId } = resolveTapeFallbackIdentity(unit);
  const head = unit.header?.visibleHead;
  return {
    id, role: "assistant", text, ts, status, _source: "server",
    _turnTapeId: unit.tapeId,
    _turnTapeSha256: unit.header?.tapeSha256 ?? (typeof unit.anchor._turnTapeSha256 === "string" ? unit.anchor._turnTapeSha256 : undefined),
    _turnTapeComplete: true,
    _turnKey: unit.header?.turnKey ?? (typeof unit.anchor._turnKey === "string" ? unit.anchor._turnKey : undefined),
    _orderSeq: unit.orderSeq,
    _timelineRecord: true,
    _timelineUnitKey: `tape-fallback:${unit.tapeId}`,
    _automaticRecoveryDecisionPending: unit.header?.finalizedAt === null,
    _displayDegraded: true,
    _displayDegradeReason: reason,
    _dispatchOutcome: unit.header?.status,
    ...(typeof unit.anchor._seq === "number" ? { _seq: unit.anchor._seq } : {}),
    ...(clientMessageId ? { _clientMessageId: clientMessageId } : {}),
    ...(typeof head?.errorCode === "string" ? { _errorCode: head.errorCode } : {}),
    ...(reason === "records_unpublished" ? { _recordsPending: true } : {}),
    ...(head?.partial === true ? { _visibleHeadPartial: true } : {}),
  };
}

export function unifiedTimelineTapeFallbackMessages(sessionId: string, unit: TimelineFallbackUnit): MessageLike[] {
  const picked = pickTapeDisplayFallbackText({
    visibleHead: unit.header?.visibleHead, anchorText: unit.anchor.text, reason: unit.reason,
  });
  const reason = resolveTapeFallbackReason(unit.header, unit.reason, picked.source);
  warnTapeDisplayDegrade({ sessionId, tapeId: unit.tapeId, reason, detail: unit.detail });
  const base = buildTapeFallbackBaseMessage(unit, picked.text, reason);
  return [stampTapeLifecycle(attachFallbackSettlementUsage(base, unit.header, unit.anchor.usage), "phase_a", {
    processKey: "", historyRevision: unit.orderSeq, exactBit: 0,
  })];
}

// ── Verified status overlay reader ───────────────────────────────────────────

const READ_UNIFIED_TIMELINE_STATUSES_SQL = `SELECT dispatch_id,client_message_id,failure_code,anchor_seq::text,terminal_at
   FROM turn_dispatches
  WHERE user_id=$1 AND session_id=$2 AND status='terminal' AND client_notified=TRUE
    AND outcome IN ('not_accepted','executed_error')
    AND NOT EXISTS (SELECT 1 FROM turn_recovery_jobs j
      WHERE j.user_id=turn_dispatches.user_id AND j.session_id=turn_dispatches.session_id
        AND j.source_client_message_id=turn_dispatches.client_message_id
        AND j.status IN ('queued','leased','sent','forwarded','completed'))
    AND anchor_seq=ANY($3::bigint[])
  ORDER BY anchor_seq,dispatch_id`;

export async function readUnifiedTimelineStatuses(
  client: PoolClient,
  sessionUserId: string,
  sessionId: string,
  anchorSeqs: number[],
): Promise<Map<number, MessageLike[]>> {
  const uidMatch = /^c:([1-9][0-9]*)$/.exec(sessionUserId);
  if (!uidMatch || anchorSeqs.length === 0) return new Map();
  const rows = (await client.query<UnifiedTimelineStatusRow>(
    READ_UNIFIED_TIMELINE_STATUSES_SQL, [uidMatch[1], sessionId, anchorSeqs],
  )).rows;
  const byAnchor = new Map<number, MessageLike[]>();
  for (const row of rows) {
    const anchorSeq = bigIntNum(row.anchor_seq, "turn dispatch anchor_seq");
    const list = byAnchor.get(anchorSeq) ?? [];
    list.push({
      id: `turn-status:${row.dispatch_id}`,
      role: "system",
      text: "",
      ts: row.terminal_at?.getTime() ?? 0,
      _source: "server",
      _seq: anchorSeq,
      _turnStatusRecord: true,
      _dispatchTerminal: true,
      _dispatchLost: true,
      _errorCode: row.failure_code ?? "DISPATCH_LOST",
      _clientMessageId: row.client_message_id,
      _timelineRecord: true,
      _timelineUnitKey: `status:${row.dispatch_id}`,
    });
    byAnchor.set(anchorSeq, list);
  }
  return byAnchor;
}
