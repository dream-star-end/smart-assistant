import type { Pool, PoolClient } from "pg";
import { LOSSLESS_TURN_TAPE_SHA256_RE } from "@openclaude/protocol";
import type { ClientSessionReadOptions, MessageLike } from "@openclaude/storage";
import { precomputedTapePayloadBytesSql } from "../pgTimelinePerf.js";
import { expandHydratedRuntimeBatch, type HydratedRuntimeBatchDescriptor } from "../runtimeBatch.js";
import { recordsPublished, type VisibleHead } from "../visibleFinalize.js";
import { TAPE_RECORD_INLINE_QUANTUM_BYTES, userVisiblePhysicalPayload } from "./pgTapeSanitizeAndEncode.js";
import {
  attachFallbackSettlementUsage,
  deferredTapeRecord,
  hydrateTapeRecord,
  mergeBillingAnchorUsage,
  mergeExactUsage,
  mergeTapeFallbackSettlements,
  parseDelegateCosts,
} from "./pgTapeUsageAndRecordHydrate.js";
import { bigIntNum, sha256Bytes } from "./sqlHelpers.js";
import type {
  DirectTapeHeader,
  DirectTapePageHead,
  DirectTapeSourceRecord,
  DirectTapeVisibleHead,
  HydratedTapeRow,
} from "./types.js";

// ── Verified turn status rows ────────────────────────────────────────────────

type VerifiedTurnStatusRow = {
  dispatch_id: string; client_message_id: string; failure_code: string | null;
  anchor_seq: string; terminal_at: Date | null;
};

const READ_VERIFIED_TURN_STATUS_SQL = `SELECT dispatch_id, client_message_id, failure_code, anchor_seq::text, terminal_at
   FROM turn_dispatches
  WHERE user_id=$1 AND session_id=$2 AND status='terminal' AND client_notified=TRUE
    AND outcome IN ('not_accepted','executed_error')
    AND NOT EXISTS (SELECT 1 FROM turn_recovery_jobs j
      WHERE j.user_id=turn_dispatches.user_id AND j.session_id=turn_dispatches.session_id
        AND j.source_client_message_id=turn_dispatches.client_message_id
        AND j.status IN ('queued','leased','sent','forwarded','completed'))
    AND anchor_seq IS NOT NULL
  ORDER BY anchor_seq, dispatch_id`;

function findStatusInsertPosition(messages: MessageLike[], anchorSeq: number) {
  let insertAt = 0;
  let orderSeq: number | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const seq = messages[i]?._seq;
    if (typeof seq === "number" && Number.isFinite(seq) && seq <= anchorSeq) {
      insertAt = i + 1;
      if (seq === anchorSeq && typeof messages[i]?._orderSeq === "number") orderSeq = messages[i]!._orderSeq;
      break;
    }
  }
  return { insertAt, orderSeq };
}

function buildVerifiedTurnStatusMessage(
  row: VerifiedTurnStatusRow, id: string, anchorSeq: number, orderSeq: number | undefined,
): MessageLike {
  return {
    id, role: "system", text: "", ts: row.terminal_at?.getTime() ?? 0,
    _source: "server", _seq: anchorSeq,
    ...(orderSeq !== undefined ? { _orderSeq: orderSeq } : {}),
    _turnStatusRecord: true, _dispatchTerminal: true, _dispatchLost: true,
    _errorCode: row.failure_code ?? "DISPATCH_LOST", _clientMessageId: row.client_message_id,
  };
}

/** Read verified turn failures directly from the durable dispatch authority. */
export async function mergeVerifiedTurnStatusRows(
  pool: Pool,
  sessionUserId: string,
  sessionId: string,
  messages: MessageLike[],
  anchorRange?: { minInclusive: number; maxExclusive: number },
): Promise<MessageLike[]> {
  const uidMatch = /^c:([1-9][0-9]*)$/.exec(sessionUserId);
  if (!uidMatch) return messages;
  const rows = (await pool.query<VerifiedTurnStatusRow>(READ_VERIFIED_TURN_STATUS_SQL, [uidMatch[1], sessionId])).rows;
  if (rows.length === 0) return messages;
  const out = [...messages];
  for (const row of rows) {
    const anchorSeq = bigIntNum(row.anchor_seq, "turn dispatch anchor_seq");
    if (anchorRange && (anchorSeq < anchorRange.minInclusive || anchorSeq >= anchorRange.maxExclusive)) continue;
    const id = `turn-status:${row.dispatch_id}`;
    if (out.some((message) => message.id === id)) continue;
    const { insertAt, orderSeq } = findStatusInsertPosition(out, anchorSeq);
    out.splice(insertAt, 0, buildVerifiedTurnStatusMessage(row, id, anchorSeq, orderSeq));
  }
  return out;
}

// ── Direct tape header & row readers ─────────────────────────────────────────

type DirectTapeHeaderRow = {
  tape_id: string; tape_sha256: string; billing_anchor_id: string | null;
  payload_bytes: string; physical_count: string; logical_count: string;
  status: string; turn_key: string; client_message_id: string | null;
  continuation_of_turn_key: string | null; materialization_status: string | null;
  finalized_at: string | null; visible_at: string | null; visible_head: VisibleHead | null;
};

const READ_DIRECT_TAPE_HEADERS_SQL = `SELECT t.tape_id, t.tape_sha256, t.billing_anchor_id, t.status, t.turn_key,
        COALESCE(t.client_message_id, d.client_message_id) AS client_message_id,
        t.continuation_of_turn_key,
        t.record_payload_bytes::text AS payload_bytes,
        t.physical_record_count::text AS physical_count,
        t.logical_record_count::text AS logical_count,
        t.materialization_status, t.finalized_at::text, t.visible_at::text, t.visible_head
   FROM client_session_turn_tapes t
   LEFT JOIN turn_dispatches d ON d.dispatch_id=t.dispatch_id
  WHERE t.session_id=$1 AND t.user_id=$2 AND t.tape_id=ANY($3::text[])
    AND (t.visible_at IS NOT NULL OR t.finalized_at IS NOT NULL) AND t.billing_anchor_id IS NOT NULL`;

const BACKFILL_LEGACY_DIRECT_TAPE_TOTALS_SQL = `WITH totals AS (
   SELECT r.session_id, r.user_id, r.tape_id, COUNT(*)::integer AS physical_count,
          COALESCE(SUM(octet_length(r.payload)),0)::bigint AS payload_bytes,
          COALESCE(SUM(CASE WHEN r.role='runtime-event' AND r.msg_id LIKE '%-runtime-batch-%'
            THEN substring(convert_from(r.payload, 'UTF8') FROM '"logicalCount"[[:space:]]*:[[:space:]]*([0-9]+)')::integer
            ELSE 1 END),0)::integer AS logical_count
     FROM client_session_turn_tape_records r
    WHERE r.session_id=$1 AND r.user_id=$2 AND r.tape_id=ANY($3::text[])
    GROUP BY r.session_id, r.user_id, r.tape_id
 )
 UPDATE client_session_turn_tapes t
    SET physical_record_count=CASE WHEN t.physical_record_count=0 THEN totals.physical_count ELSE t.physical_record_count END,
        logical_record_count=CASE WHEN t.logical_record_count=0 THEN totals.logical_count ELSE t.logical_record_count END,
        record_payload_bytes=CASE WHEN t.record_payload_bytes=0 THEN totals.payload_bytes ELSE t.record_payload_bytes END
   FROM totals
  WHERE t.session_id=totals.session_id AND t.user_id=totals.user_id AND t.tape_id=totals.tape_id
  RETURNING t.tape_id, t.record_payload_bytes::text AS payload_bytes,
            t.physical_record_count::text AS physical_count, t.logical_record_count::text AS logical_count`;

async function backfillLegacyDirectTapeTotals(
  pool: Pool | PoolClient,
  sessionId: string,
  userId: string,
  rows: DirectTapeHeaderRow[],
): Promise<void> {
  const legacyTapeIds = rows
    .filter((row) => row.payload_bytes === "0" || row.physical_count === "0" || row.logical_count === "0")
    .map((row) => row.tape_id);
  if (legacyTapeIds.length === 0) return;
  const derived = (await pool.query<{
    tape_id: string; payload_bytes: string; physical_count: string; logical_count: string;
  }>(BACKFILL_LEGACY_DIRECT_TAPE_TOTALS_SQL, [sessionId, userId, legacyTapeIds])).rows;
  const byTape = new Map(derived.map((row) => [row.tape_id, row]));
  for (const row of rows) {
    const exact = byTape.get(row.tape_id);
    if (!exact) continue;
    row.payload_bytes = exact.payload_bytes;
    row.physical_count = exact.physical_count;
    row.logical_count = exact.logical_count;
  }
}

function mapDirectTapeHeaderRow(row: DirectTapeHeaderRow): DirectTapeHeader {
  return {
    tapeId: row.tape_id,
    tapeSha256: row.tape_sha256,
    billingAnchorId: row.billing_anchor_id!,
    totalBytes: bigIntNum(row.payload_bytes, "turn tape payload bytes"),
    physicalCount: bigIntNum(row.physical_count, "turn tape physical count"),
    logicalCount: bigIntNum(row.logical_count, "turn tape logical count"),
    status: row.status,
    turnKey: row.turn_key,
    clientMessageId: row.client_message_id,
    continuationOfTurnKey: row.continuation_of_turn_key,
    materializationStatus: row.materialization_status ?? null,
    finalizedAt: row.finalized_at ?? null,
    visibleAt: row.visible_at ?? null,
    visibleHead: row.visible_head ?? null,
  };
}

export async function readDirectTapeHeaders(
  pool: Pool | PoolClient,
  sessionId: string,
  userId: string,
  tapeIds: string[],
): Promise<Map<string, DirectTapeHeader>> {
  if (tapeIds.length === 0) return new Map();
  const rows = (await pool.query<DirectTapeHeaderRow>(READ_DIRECT_TAPE_HEADERS_SQL, [sessionId, userId, tapeIds])).rows;
  await backfillLegacyDirectTapeTotals(pool, sessionId, userId, rows);
  const headers = new Map(rows.map((row) => [row.tape_id, mapDirectTapeHeaderRow(row)]));
  await mergeTapeFallbackSettlements(pool, sessionId, userId, headers);
  return headers;
}

const COST_COMPONENT_MATCH_SQL = `c.user_id=r.user_id AND c.session_id=r.session_id AND (
  (recovery.source_tape_id IS NULL AND c.tape_id=r.tape_id AND c.billing_anchor_id=r.msg_id)
  OR (recovery.source_tape_id IS NOT NULL AND r.msg_id=t.billing_anchor_id
      AND c.tape_id=recovery.source_tape_id AND c.billing_anchor_id=source_tape.billing_anchor_id))`;

const PENDING_PATCH_MATCH_SQL = `p.user_id=r.user_id AND r.msg_id=t.billing_anchor_id
  AND (p.turn_key=t.turn_key OR p.parent_turn_key=t.turn_key)`;

const TAPE_RECORD_WAIVER_SQL = `EXISTS (SELECT 1 FROM turn_waivers w
  WHERE ('c:' || w.user_id::text)=t.user_id AND w.turn_key=t.turn_key AND w.status='applied') AS waiver_applied`;

const TAPE_RECORD_COST_AND_DELEGATES_SQL = `COALESCE((
  SELECT SUM(exact_cost.cost_credits)::text FROM (
    SELECT c.cost_credits::numeric AS cost_credits FROM turn_tape_cost_components c WHERE ${COST_COMPONENT_MATCH_SQL}
    UNION ALL
    SELECT p.cost_credits::numeric AS cost_credits FROM pending_usage_patches p WHERE ${PENDING_PATCH_MATCH_SQL}
  ) exact_cost
), '0') AS cost_credits,
COALESCE((
  SELECT jsonb_agg(jsonb_build_object('agentId', grouped.delegate_agent_id, 'costCredits', grouped.cost_credits)
           ORDER BY grouped.delegate_agent_id)
    FROM (
      SELECT exact_delegate.delegate_agent_id, SUM(exact_delegate.cost_credits)::text AS cost_credits
        FROM (
          SELECT c.delegate_agent_id, c.cost_credits::numeric AS cost_credits FROM turn_tape_cost_components c WHERE ${COST_COMPONENT_MATCH_SQL}
          UNION ALL
          SELECT p.delegate_agent_id, p.cost_credits::numeric AS cost_credits FROM pending_usage_patches p WHERE ${PENDING_PATCH_MATCH_SQL}
        ) exact_delegate
       WHERE exact_delegate.delegate_agent_id IS NOT NULL
       GROUP BY exact_delegate.delegate_agent_id
    ) grouped
), '[]'::jsonb) AS delegate_costs`;

const TAPE_RECORD_JOINS_SQL = `FROM client_session_turn_tape_records r
JOIN client_session_turn_tapes t ON t.session_id=r.session_id AND t.user_id=r.user_id AND t.tape_id=r.tape_id
LEFT JOIN turn_tape_recovery_links recovery ON recovery.session_id=r.session_id AND recovery.user_id=r.user_id AND recovery.recovery_tape_id=r.tape_id
LEFT JOIN client_session_turn_tapes source_tape ON source_tape.session_id=recovery.session_id AND source_tape.user_id=recovery.user_id AND source_tape.tape_id=recovery.source_tape_id`;

function buildReadHydratedTapeRowsSql(hasRoles: boolean, hasRecordRefs: boolean): string {
  let nextParam = 4;
  const roleClause = hasRoles ? `AND r.role=ANY($${nextParam++}::text[])` : "";
  const recordClause = hasRecordRefs
    ? `AND (r.tape_id, r.msg_id) IN (SELECT selected.tape_id, selected.msg_id FROM unnest($${nextParam++}::text[], $${nextParam++}::text[]) AS selected(tape_id, msg_id))`
    : "";
  return `SELECT r.tape_id, t.tape_sha256, t.waive_reason, ${TAPE_RECORD_WAIVER_SQL},
        r.msg_id, r.ordinal, r.role, r.content_sha256, r.payload, ${TAPE_RECORD_COST_AND_DELEGATES_SQL}
   ${TAPE_RECORD_JOINS_SQL}
  WHERE r.session_id=$1 AND r.user_id=$2 AND r.tape_id=ANY($3::text[]) ${roleClause} ${recordClause}
  ORDER BY r.tape_id, r.ordinal`;
}

export async function readHydratedTapeRows(
  pool: Pool | PoolClient,
  sessionId: string,
  userId: string,
  tapeIds: string[],
  roles?: string[],
  recordRefs?: Array<{ tapeId: string; msgId: string }>,
): Promise<HydratedTapeRow[]> {
  if (tapeIds.length === 0) return [];
  const hasRoles = !!roles && roles.length > 0;
  const hasRecordRefs = !!recordRefs && recordRefs.length > 0;
  const params: unknown[] = [sessionId, userId, tapeIds];
  if (hasRoles) params.push(roles);
  if (hasRecordRefs) params.push(recordRefs.map((ref) => ref.tapeId), recordRefs.map((ref) => ref.msgId));
  return (await pool.query<HydratedTapeRow>(buildReadHydratedTapeRowsSql(hasRoles, hasRecordRefs), params)).rows;
}

const READ_DIRECT_TAPE_VISIBLE_HEADS_SQL = `SELECT r.tape_id, r.msg_id, r.ordinal, r.role, r.ts::text,
        ${precomputedTapePayloadBytesSql("r")}::text AS payload_bytes,
        r.visible_content_sha256, t.billing_anchor_id,
        ${TAPE_RECORD_WAIVER_SQL}, ${TAPE_RECORD_COST_AND_DELEGATES_SQL}
   ${TAPE_RECORD_JOINS_SQL}
  WHERE r.session_id=$1 AND r.user_id=$2 AND r.tape_id=ANY($3::text[]) AND r.msg_id=t.billing_anchor_id
  ORDER BY r.tape_id, r.ordinal`;

/** Browser timeline hydration reads locator metadata only. */
export async function readDirectTapeVisibleHeads(
  pool: Pool | PoolClient,
  sessionId: string,
  userId: string,
  tapeIds: string[],
): Promise<DirectTapeVisibleHead[]> {
  if (tapeIds.length === 0) return [];
  return (await pool.query<DirectTapeVisibleHead>(READ_DIRECT_TAPE_VISIBLE_HEADS_SQL, [sessionId, userId, tapeIds])).rows;
}

export function directTapeProcessRow(anchor: MessageLike, header: DirectTapeHeader): MessageLike {
  return {
    id: `turn-process:${header.tapeId}`,
    role: "runtime-event",
    text: "",
    ts: typeof anchor.ts === "number" ? anchor.ts : 0,
    _source: "server",
    _turnTapeId: header.tapeId,
    _turnTapeSha256: header.tapeSha256,
    _turnTapeComplete: true,
    _turnTapeProcess: true,
    _turnTapeProcessCount: Math.max(0, header.logicalCount - 1),
    _turnTapeTotalBytes: header.totalBytes,
    _dispatchOutcome: header.status,
    ...(header.clientMessageId ? { _clientMessageId: header.clientMessageId } : {}),
    ...(typeof anchor._seq === "number" ? { _seq: anchor._seq } : {}),
    ...(typeof anchor._orderSeq === "number" ? { _orderSeq: anchor._orderSeq } : {}),
  };
}

/** Chunk tape hydration by tapeId so every statement stays bounded on fat sessions. */
export const HYDRATE_TAPE_ID_CHUNK = 64;

export async function runHydrationChunked<T>(
  ids: string[],
  fn: (chunk: string[]) => Promise<T[]>,
): Promise<T[]> {
  if (ids.length <= HYDRATE_TAPE_ID_CHUNK) return fn(ids);
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += HYDRATE_TAPE_ID_CHUNK) {
    out.push(...await fn(ids.slice(i, i + HYDRATE_TAPE_ID_CHUNK)));
  }
  return out;
}

// ── Turn tape hydration ──────────────────────────────────────────────────────

export type HydrateTurnTapeOptions = ClientSessionReadOptions & {
  deferTimelineNarrative?: boolean;
  engineContext?: boolean;
  uploadReferenceMaxBytes?: number;
};

type HydrationFlags = { exact: boolean; engineContext: boolean; deferTimelineNarrative: boolean };

type HydrationSources = {
  headers: Map<string, DirectTapeHeader>;
  byKey: Map<string, HydratedTapeRow>;
  byTape: Map<string, HydratedTapeRow[]>;
  headsByTape: Map<string, DirectTapeVisibleHead[]>;
};

function classifyTapeAnchors(refs: MessageLike[]) {
  const completeRefs = refs.filter((message) => message._turnTapeComplete === true);
  const rollingRefs = refs.filter((message) => message._turnTapeComplete !== true).map((message) => {
    if (typeof message._turnTapeMsgId !== "string") {
      throw new Error(`[pgSessions] lossless turn tape anchor malformed: ${message._turnTapeId}`);
    }
    return { tapeId: message._turnTapeId as string, msgId: message._turnTapeMsgId };
  });
  return {
    completeTapeIds: [...new Set(completeRefs.map((message) => message._turnTapeId as string))],
    rollingRefs,
    rollingTapeIds: [...new Set(rollingRefs.map((ref) => ref.tapeId))],
  };
}

function groupByKey<T>(items: T[], getKey: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = getKey(item);
    const list = map.get(key) ?? [];
    list.push(item);
    map.set(key, list);
  }
  return map;
}

async function fetchHydrationSources(
  pool: Pool | PoolClient,
  sessionId: string,
  userId: string,
  anchors: ReturnType<typeof classifyTapeAnchors>,
  flags: HydrationFlags,
): Promise<HydrationSources> {
  const timelineRoles = flags.engineContext
    ? ["assistant", "error", "tool", "plan", "goal", "agent-group", "runtime-event"]
    : ["assistant", "error"];
  const [headers, completeRows, timelineHeads, rollingRows] = await Promise.all([
    readDirectTapeHeaders(pool, sessionId, userId, anchors.completeTapeIds),
    flags.deferTimelineNarrative
      ? Promise.resolve([] as HydratedTapeRow[])
      : runHydrationChunked(anchors.completeTapeIds, (chunk) =>
          readHydratedTapeRows(pool, sessionId, userId, chunk, flags.exact ? undefined : timelineRoles)),
    flags.deferTimelineNarrative
      ? runHydrationChunked(anchors.completeTapeIds, (chunk) =>
          readDirectTapeVisibleHeads(pool, sessionId, userId, chunk))
      : Promise.resolve([] as DirectTapeVisibleHead[]),
    runHydrationChunked(anchors.rollingTapeIds, (chunk) => {
      const chunkSet = new Set(chunk);
      return readHydratedTapeRows(
        pool, sessionId, userId, chunk, undefined,
        anchors.rollingRefs.filter((ref) => chunkSet.has(ref.tapeId)),
      );
    }),
  ]);
  return {
    headers,
    byKey: new Map([...completeRows, ...rollingRows].map((row) => [`${row.tape_id}\0${row.msg_id}`, row])),
    byTape: groupByKey(completeRows, (row) => row.tape_id),
    headsByTape: groupByKey(timelineHeads, (head) => head.tape_id),
  };
}

function buildUnpublishedVisibleHeadMessage(anchor: MessageLike, header: DirectTapeHeader): MessageLike {
  const head = header.visibleHead;
  return attachFallbackSettlementUsage({
    id: head?.messageId ?? header.billingAnchorId,
    role: "assistant",
    text: typeof head?.text === "string" ? head.text : "",
    ts: typeof head?.ts === "number" ? head.ts : (typeof anchor.ts === "number" ? anchor.ts : 0),
    status: header.status,
    _source: "server",
    _turnTapeId: header.tapeId,
    _turnTapeSha256: header.tapeSha256,
    _turnTapeComplete: true,
    _turnKey: header.turnKey,
    ...(header.clientMessageId ? { _clientMessageId: header.clientMessageId } : {}),
    ...(typeof anchor._seq === "number" ? { _seq: anchor._seq } : {}),
    ...(typeof anchor._orderSeq === "number" ? { _orderSeq: anchor._orderSeq } : {}),
  }, header, anchor.usage);
}

function verifyExpandedExactTape(
  anchor: MessageLike,
  tapeId: string,
  expandedCount: number,
  batchDescriptors: HydratedRuntimeBatchDescriptor[],
): void {
  const expectedLogical = anchor._turnTapeLogicalRecordCount;
  if (typeof expectedLogical === "number" && Number.isSafeInteger(expectedLogical) && expectedLogical > 0 && expandedCount !== expectedLogical) {
    throw new Error(`[pgSessions] lossless turn tape logical count mismatch: ${tapeId}`);
  }
  const expectedManifestSha = anchor._turnTapeRuntimeManifestSha256;
  if (expectedManifestSha !== undefined) {
    const invalidManifest =
      typeof expectedManifestSha !== "string" ||
      !LOSSLESS_TURN_TAPE_SHA256_RE.test(expectedManifestSha) ||
      batchDescriptors.length === 0 ||
      sha256Bytes(Buffer.from(JSON.stringify(batchDescriptors), "utf8")) !== expectedManifestSha;
    if (invalidManifest) throw new Error(`[pgSessions] lossless turn tape runtime manifest mismatch: ${tapeId}`);
  } else if (batchDescriptors.length > 0) {
    throw new Error(`[pgSessions] lossless turn tape runtime manifest missing: ${tapeId}`);
  }
}

function expandExactTapeRows(
  anchor: MessageLike,
  header: DirectTapeHeader,
  tapeRows: HydratedTapeRow[],
  budget: { remaining: number | undefined },
): MessageLike[] {
  if (tapeRows.length !== header.physicalCount) {
    throw new Error(`[pgSessions] lossless turn tape records missing: ${header.tapeId}`);
  }
  const expanded: MessageLike[] = [];
  const batchDescriptors: HydratedRuntimeBatchDescriptor[] = [];
  for (const row of tapeRows) {
    const result = expandHydratedRuntimeBatch(
      hydrateTapeRecord(row, anchor, false, anchor._turnTapeComplete === true),
      row, anchor, budget.remaining,
    );
    if (budget.remaining !== undefined) {
      budget.remaining -= Buffer.byteLength(JSON.stringify(result.messages));
      if (budget.remaining <= 0) throw new Error("upload reference expanded tape exceeds budget");
    }
    expanded.push(...result.messages);
    if (result.descriptor) batchDescriptors.push(result.descriptor);
  }
  verifyExpandedExactTape(anchor, header.tapeId, expanded.length, batchDescriptors);
  return expanded;
}

function buildDeferredTimelineHead(
  anchor: MessageLike,
  header: DirectTapeHeader,
  head: DirectTapeVisibleHead,
): MessageLike {
  let deferred = deferredTapeRecord(
    header.tapeId,
    header.tapeSha256,
    {
      msg_id: head.msg_id,
      ordinal: head.ordinal,
      role: head.role,
      ts: head.ts,
      ...(head.visible_content_sha256 ? { content_sha256: head.visible_content_sha256 } : {}),
    },
    bigIntNum(head.payload_bytes, "turn tape timeline payload bytes"),
    { continuationOfTurnKey: header.continuationOfTurnKey },
  );
  if (typeof anchor._seq === "number") deferred._seq = anchor._seq;
  if (typeof anchor._orderSeq === "number") deferred._orderSeq = anchor._orderSeq;
  deferred.status = header.status;
  deferred._turnKey = header.turnKey;
  const isBillingAnchor = head.msg_id === head.billing_anchor_id;
  deferred = mergeBillingAnchorUsage(deferred, anchor, isBillingAnchor);
  return mergeExactUsage(deferred, {
    costCredits: head.cost_credits,
    waiverApplied: head.waiver_applied,
    delegates: parseDelegateCosts(head.delegate_costs),
  }, isBillingAnchor);
}

function hydrateTimelineCompleteTape(
  anchor: MessageLike,
  header: DirectTapeHeader,
  tapeRows: HydratedTapeRow[],
  heads: DirectTapeVisibleHead[],
  deferTimelineNarrative: boolean,
): MessageLike[] {
  const narrative = deferTimelineNarrative
    ? heads.map((head) => buildDeferredTimelineHead(anchor, header, head))
    : tapeRows.map((row) => hydrateTapeRecord(row, anchor, false, anchor._turnTapeComplete === true));
  narrative.sort((a, b) =>
    (typeof a._turnTapeOrdinal === "number" ? a._turnTapeOrdinal : 0) -
    (typeof b._turnTapeOrdinal === "number" ? b._turnTapeOrdinal : 0));
  const narrativeClientId = narrative.find((m) => typeof m._clientMessageId === "string")?._clientMessageId;
  const clientMessageId = header.clientMessageId ?? (typeof narrativeClientId === "string" ? narrativeClientId : null);
  if (clientMessageId) {
    for (const message of narrative) {
      if (typeof message._clientMessageId !== "string") message._clientMessageId = clientMessageId;
    }
  }
  const process = header.logicalCount > 1
    ? [directTapeProcessRow(anchor, { ...header, clientMessageId: clientMessageId ?? null })]
    : [];
  return [...process, ...narrative];
}

function hydrateSingleAnchor(
  anchor: MessageLike,
  sources: HydrationSources,
  flags: HydrationFlags,
  budget: { remaining: number | undefined },
): MessageLike[] {
  const tapeId = typeof anchor._turnTapeId === "string" ? anchor._turnTapeId : null;
  const tapeSha256 = typeof anchor._turnTapeSha256 === "string" ? anchor._turnTapeSha256 : null;
  if (!tapeId || !tapeSha256) return [anchor];
  if (anchor._turnTapeComplete !== true) {
    if (typeof anchor._turnTapeMsgId !== "string") {
      throw new Error(`[pgSessions] lossless turn tape anchor malformed: ${tapeId}`);
    }
    const key = `${tapeId}\0${anchor._turnTapeMsgId}`;
    const row = sources.byKey.get(key);
    if (!row) throw new Error(`[pgSessions] lossless turn tape record missing: ${key}`);
    return [hydrateTapeRecord(row, anchor, true)];
  }
  const header = sources.headers.get(tapeId);
  if (!header) throw new Error(`[pgSessions] finalized lossless turn tape missing: ${tapeId}`);
  if (header.tapeSha256 !== tapeSha256) {
    throw new Error(`[pgSessions] lossless turn tape aggregate hash mismatch: ${tapeId}`);
  }
  if (!recordsPublished({ materializationStatus: header.materializationStatus, finalizedAt: header.finalizedAt })) {
    return [buildUnpublishedVisibleHeadMessage(anchor, header)];
  }
  const expectedPhysical = anchor._turnTapePhysicalRecordCount ?? anchor._turnTapeRecordCount;
  if (typeof expectedPhysical === "number" && Number.isSafeInteger(expectedPhysical) && expectedPhysical > 0 && expectedPhysical !== header.physicalCount) {
    throw new Error(`[pgSessions] lossless turn tape physical count mismatch: ${tapeId}`);
  }
  const tapeRows = sources.byTape.get(tapeId) ?? [];
  if (flags.exact) return expandExactTapeRows(anchor, header, tapeRows, budget);
  return hydrateTimelineCompleteTape(anchor, header, tapeRows, sources.headsByTape.get(tapeId) ?? [], flags.deferTimelineNarrative);
}

function indexToolChildren(blocks: unknown, childTools: Map<string, Record<string, unknown>>): void {
  if (!Array.isArray(blocks)) return;
  for (const raw of blocks) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const block = raw as Record<string, unknown>;
    if (block.kind === "tool_use" && typeof block.blockId === "string") childTools.set(block.blockId, block);
    indexToolChildren(block.childBlocks, childTools);
  }
}

function extractBashTailEvent(message: MessageLike): {
  toolUseId: string;
  parentToolUseId: string;
  totalBytes: number;
  tail: string;
  truncatedHead: boolean;
} | null {
  if (message.role !== "runtime-event") return null;
  const event = message._runtimeEvent;
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const raw = event as Record<string, unknown>;
  if (raw.type !== "system" || raw.subtype !== "bash_output_tail") return null;
  if (typeof raw.tool_use_id !== "string" || raw.tool_use_id.length === 0) return null;
  return {
    toolUseId: raw.tool_use_id,
    parentToolUseId: typeof raw.parent_tool_use_id === "string" ? raw.parent_tool_use_id : "",
    totalBytes: typeof raw.total_bytes === "number" && Number.isFinite(raw.total_bytes) ? raw.total_bytes : 0,
    tail: typeof raw.tail === "string" ? raw.tail : "",
    truncatedHead: raw.truncated_head === true,
  };
}

function applySingleBashTail(
  message: MessageLike,
  topLevelTools: Map<string, MessageLike>,
  childTools: Map<string, Record<string, unknown>>,
): void {
  const parsed = extractBashTailEvent(message);
  if (!parsed) return;
  const target = parsed.parentToolUseId.length > 0
    ? childTools.get(parsed.toolUseId)
    : topLevelTools.get(parsed.toolUseId) ?? childTools.get(parsed.toolUseId);
  if (!target) return;
  const prev = target.bashTail;
  const prevBytes = prev && typeof prev === "object" && !Array.isArray(prev) && typeof (prev as Record<string, unknown>).totalBytes === "number"
    ? (prev as Record<string, unknown>).totalBytes as number
    : 0;
  if (parsed.totalBytes < prevBytes) return;
  target.bashTail = { tail: parsed.tail, totalBytes: parsed.totalBytes, truncatedHead: parsed.truncatedHead };
}

function applyContinuationBashTails(hydrated: MessageLike[]): void {
  const topLevelTools = new Map<string, MessageLike>();
  const childTools = new Map<string, Record<string, unknown>>();
  for (const message of hydrated) {
    if (message.role === "tool" && typeof message.blockId === "string") topLevelTools.set(message.blockId, message);
    indexToolChildren(message.childBlocks, childTools);
  }
  for (const message of hydrated) applySingleBashTail(message, topLevelTools, childTools);
}

/** Exact/admin reads hydrate every physical and logical record; browser chat reads return deferred locators. */
export async function hydrateTurnTapeMessages(
  pool: Pool | PoolClient,
  sessionId: string,
  userId: string,
  messages: MessageLike[],
  options: HydrateTurnTapeOptions = {},
): Promise<MessageLike[]> {
  const refs = messages.filter((m) => m && typeof m._turnTapeId === "string" && typeof m._turnTapeSha256 === "string");
  if (refs.length === 0) return messages;
  const anchors = classifyTapeAnchors(refs);
  const exact = options.view !== "timeline";
  const flags: HydrationFlags = {
    exact,
    engineContext: options.engineContext === true,
    deferTimelineNarrative: !exact && options.deferTimelineNarrative !== false,
  };
  const sources = await fetchHydrationSources(pool, sessionId, userId, anchors, flags);
  const budget = { remaining: options.uploadReferenceMaxBytes };
  const hydrated = messages.flatMap((anchor) => hydrateSingleAnchor(anchor, sources, flags, budget));
  if (flags.exact || flags.engineContext) applyContinuationBashTails(hydrated);
  return hydrated;
}

// ── Direct tape page hydration ───────────────────────────────────────────────

const READ_DIRECT_TAPE_PAYLOAD_ROWS_SQL = `SELECT msg_id, ordinal, role, content_sha256, payload, visible_payload, visible_content_sha256
   FROM client_session_turn_tape_records
  WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND ordinal=ANY($4::int[])
  ORDER BY ordinal`;

function toDirectSourceHydratedRow(
  source: DirectTapeSourceRecord, tapeId: string, tapeSha256: string, clonePayload: boolean,
): HydratedTapeRow {
  return {
    tape_id: tapeId, tape_sha256: tapeSha256, waive_reason: null, waiver_applied: false,
    msg_id: source.msg_id, ordinal: source.ordinal, role: source.role,
    content_sha256: source.content_sha256,
    payload: clonePayload ? Buffer.from(source.payload) : source.payload,
    cost_credits: "0", delegate_costs: [],
  };
}

function resolveDirectTapeVisibleBytes(
  source: DirectTapeSourceRecord, tapeId: string, tapeSha256: string, billingAnchorId: string,
): Buffer {
  if (source.visible_payload !== null) {
    const bytes = Buffer.from(source.visible_payload);
    if (sha256Bytes(bytes) !== source.visible_content_sha256) {
      throw new Error(`[pgSessions] visible tape payload hash mismatch: ${tapeId}\0${source.ordinal}`);
    }
    return bytes;
  }
  const visible = userVisiblePhysicalPayload(toDirectSourceHydratedRow(source, tapeId, tapeSha256, true), tapeSha256, billingAnchorId);
  if (!visible) throw new Error(`[pgSessions] direct tape record is not a JSON object: ${tapeId}\0${source.ordinal}`);
  return visible.bytes;
}

function expandDirectTapeSourceRecord(
  source: DirectTapeSourceRecord, headOrdinal: number, tapeId: string, tapeSha256: string, billingAnchorId: string,
): MessageLike[] {
  const bytes = resolveDirectTapeVisibleBytes(source, tapeId, tapeSha256, billingAnchorId);
  const message = JSON.parse(bytes.toString("utf8")) as MessageLike;
  const expanded = expandHydratedRuntimeBatch(
    message,
    toDirectSourceHydratedRow(source, tapeId, tapeSha256, false),
    { id: billingAnchorId, _turnTapeSha256: tapeSha256 },
  ).messages;
  for (const logical of expanded) logical._recordOrdinal = headOrdinal;
  return expanded;
}

/** Hydrate a selected physical page without changing its paging direction. */
export async function hydrateDirectTapePage(
  pool: Pool | PoolClient,
  sessionId: string,
  userId: string,
  tapeId: string,
  tapeSha256: string,
  billingAnchorId: string,
  heads: DirectTapePageHead[],
  extras?: { continuationOfTurnKey?: string | null },
): Promise<MessageLike[]> {
  const deferred = heads.filter((h) => bigIntNum(h.payload_bytes, "turn tape record payload bytes") > TAPE_RECORD_INLINE_QUANTUM_BYTES);
  const planned = heads.filter((h) => bigIntNum(h.payload_bytes, "turn tape record payload bytes") <= TAPE_RECORD_INLINE_QUANTUM_BYTES);
  const records: MessageLike[] = deferred.map((head) => deferredTapeRecord(
    tapeId,
    tapeSha256,
    { ...head, content_sha256: head.visible_content_sha256 ?? undefined },
    bigIntNum(head.payload_bytes, "turn tape record payload bytes"),
    { continuationOfTurnKey: extras?.continuationOfTurnKey },
  ));
  if (planned.length > 0) {
    const payloadRows = (await pool.query<DirectTapeSourceRecord>(
      READ_DIRECT_TAPE_PAYLOAD_ROWS_SQL,
      [sessionId, userId, tapeId, planned.map((head) => head.ordinal)],
    )).rows;
    const payloadByOrdinal = new Map(payloadRows.map((row) => [row.ordinal, row]));
    for (const head of planned) {
      const source = payloadByOrdinal.get(head.ordinal);
      if (!source) throw new Error(`[pgSessions] direct tape record missing: ${tapeId}\0${head.ordinal}`);
      records.push(...expandDirectTapeSourceRecord(source, head.ordinal, tapeId, tapeSha256, billingAnchorId));
    }
  }
  records.sort((a, b) =>
    (typeof a._recordOrdinal === "number" ? a._recordOrdinal : Number.MAX_SAFE_INTEGER) -
    (typeof b._recordOrdinal === "number" ? b._recordOrdinal : Number.MAX_SAFE_INTEGER));
  return records;
}
