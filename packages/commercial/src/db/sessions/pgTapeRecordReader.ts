import type { Pool, PoolClient } from "pg";
import type { ClientSessionsBackend, MessageLike } from "@openclaude/storage";
import {
  precomputedTapePayloadBytesSql,
  precomputedTapeVisibleBytesSql,
} from "../pgTimelinePerf.js";
import type { PgSessionsCtx } from "./deps.js";
import { hydrateDirectTapePage } from "./pgTapeHydrateReader.js";
import {
  TAPE_RECORD_INLINE_QUANTUM_BYTES,
  TAPE_RECORD_PAGE_MAX_ROWS,
  TAPE_RECORD_PAGE_RAW_QUANTUM_BYTES,
  userVisiblePhysicalPayload,
} from "./pgTapeSanitizeAndEncode.js";
import { bigIntNum } from "./sqlHelpers.js";
import type {
  DirectTapePageHead,
  TapeRecordPayload,
  TapeRecordPayloadChunk,
} from "./types.js";

type TapeListHeader = {
  tape_sha256: string;
  billing_anchor_id: string;
  physical_record_count: string;
  logical_record_count: string;
  continuation_of_turn_key: string | null;
};

type VisiblePayloadHead = {
  tape_sha256: string;
  billing_anchor_id: string;
  msg_id: string;
  role: string;
  content_sha256: string;
  visible_content_sha256: string | null;
  visible_bytes: string | null;
};

const READ_TAPE_LIST_HEADER_SQL = `SELECT t.tape_sha256, t.billing_anchor_id, t.continuation_of_turn_key,
        CASE WHEN t.physical_record_count=0 THEN
          (SELECT COUNT(*)::text FROM client_session_turn_tape_records r
            WHERE r.session_id=t.session_id AND r.user_id=t.user_id AND r.tape_id=t.tape_id)
        ELSE t.physical_record_count::text END AS physical_record_count,
        CASE WHEN t.logical_record_count=0 THEN
          (SELECT COUNT(*)::text FROM client_session_turn_tape_records r
            WHERE r.session_id=t.session_id AND r.user_id=t.user_id AND r.tape_id=t.tape_id)
        ELSE t.logical_record_count::text END AS logical_record_count
   FROM client_session_turn_tapes t
  WHERE t.session_id=$1 AND t.user_id=$2 AND t.tape_id=$3
    AND t.finalized_at IS NOT NULL AND t.billing_anchor_id IS NOT NULL`;

const READ_TAPE_HEADS_BEFORE_SQL = `SELECT msg_id, ordinal, role, ts::text, content_sha256,
        ${precomputedTapePayloadBytesSql("")}::text AS payload_bytes,
        visible_content_sha256
   FROM client_session_turn_tape_records
  WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
    AND ($4::integer IS NULL OR ordinal < $4)
    AND msg_id<>$5
  ORDER BY ordinal DESC
  LIMIT $6`;

const READ_TAPE_HEADS_FORWARD_SQL = `SELECT msg_id, ordinal, role, ts::text, content_sha256,
        ${precomputedTapePayloadBytesSql("")}::text AS payload_bytes,
        visible_content_sha256
   FROM client_session_turn_tape_records
  WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND ordinal >= $4
    AND msg_id<>$5
  ORDER BY ordinal
  LIMIT $6`;

const READ_VISIBLE_PAYLOAD_HEAD_SQL = `SELECT t.tape_sha256, t.billing_anchor_id, r.msg_id, r.role, r.content_sha256,
        r.visible_content_sha256,
        ${precomputedTapeVisibleBytesSql("r")}::text AS visible_bytes
   FROM client_session_turn_tapes t
   JOIN client_session_turn_tape_records r
     ON r.session_id=t.session_id AND r.user_id=t.user_id AND r.tape_id=t.tape_id
  WHERE t.session_id=$1 AND t.user_id=$2 AND t.tape_id=$3
    AND t.finalized_at IS NOT NULL AND t.billing_anchor_id IS NOT NULL
    AND r.ordinal=$4`;

async function listTurnTapeRecordsBefore(
  pool: Pool,
  sessionId: string,
  userId: string,
  tapeId: string,
  header: TapeListHeader,
  before: number | null,
  cappedLimit: number,
  total: number,
): Promise<{ records: MessageLike[]; nextCursor: number | null; total: number }> {
  const upper = Number.isSafeInteger(before) && (before ?? 0) > 0 ? before : null;
  const heads = (
    await pool.query<DirectTapePageHead>(READ_TAPE_HEADS_BEFORE_SQL, [
      sessionId,
      userId,
      tapeId,
      upper,
      header.billing_anchor_id,
      cappedLimit + 1,
    ])
  ).rows;
  const selected: DirectTapePageHead[] = [];
  let pageRawBytes = 0;
  let hasMore = false;
  for (const head of heads) {
    if (selected.length >= cappedLimit) {
      hasMore = true;
      break;
    }
    const payloadBytes = bigIntNum(head.payload_bytes, "turn tape record payload bytes");
    const inlineBytes = payloadBytes > TAPE_RECORD_INLINE_QUANTUM_BYTES ? 0 : payloadBytes;
    if (selected.length > 0 && pageRawBytes + inlineBytes > TAPE_RECORD_PAGE_RAW_QUANTUM_BYTES) {
      hasMore = true;
      break;
    }
    selected.push(head);
    pageRawBytes += inlineBytes;
  }
  const records = await hydrateDirectTapePage(
    pool,
    sessionId,
    userId,
    tapeId,
    header.tape_sha256,
    header.billing_anchor_id,
    selected,
    { continuationOfTurnKey: header.continuation_of_turn_key },
  );
  return {
    records,
    nextCursor: hasMore && selected.length > 0
      ? Math.min(...selected.map((head) => head.ordinal))
      : null,
    total,
  };
}

async function fetchForwardTapeHeads(
  pool: Pool,
  sessionId: string,
  userId: string,
  tapeId: string,
  scanCursor: number,
  billingAnchorId: string,
  limitPlusOne: number,
): Promise<DirectTapePageHead[]> {
  return (
    await pool.query<DirectTapePageHead>(READ_TAPE_HEADS_FORWARD_SQL, [
      sessionId,
      userId,
      tapeId,
      scanCursor,
      billingAnchorId,
      limitPlusOne,
    ])
  ).rows;
}

function selectForwardHeadBatch(
  heads: DirectTapePageHead[],
  existingCount: number,
  cappedLimit: number,
  rawBytes: number,
  scanCursor: number,
): { selected: DirectTapePageHead[]; rawBytes: number; scanCursor: number; nextCursor: number | null } {
  const selected: DirectTapePageHead[] = [];
  let bytes = rawBytes;
  let cursor = scanCursor;
  let nextCursor: number | null = null;
  for (const head of heads) {
    if (existingCount + selected.length >= cappedLimit) {
      nextCursor = head.ordinal;
      break;
    }
    const payloadBytes = bigIntNum(head.payload_bytes, "turn tape record payload bytes");
    if (payloadBytes > TAPE_RECORD_INLINE_QUANTUM_BYTES) {
      selected.push(head);
      cursor = head.ordinal + 1;
      continue;
    }
    if (existingCount + selected.length > 0 && bytes + payloadBytes > TAPE_RECORD_PAGE_RAW_QUANTUM_BYTES) {
      nextCursor = head.ordinal;
      break;
    }
    selected.push(head);
    bytes += payloadBytes;
    cursor = head.ordinal + 1;
  }
  return { selected, rawBytes: bytes, scanCursor: cursor, nextCursor };
}

export async function listTurnTapeRecordsImpl(
  pool: Pool,
  sessionId: string,
  userId: string,
  tapeId: string,
  cursor: number,
  limit: number,
  before?: number | null,
): Promise<{ records: MessageLike[]; nextCursor: number | null; total: number } | null> {
  const header = (
    await pool.query<TapeListHeader>(READ_TAPE_LIST_HEADER_SQL, [sessionId, userId, tapeId])
  ).rows[0];
  if (!header) return null;
  const start = Number.isSafeInteger(cursor) && cursor > 0 ? cursor : 0;
  const cappedLimit = Math.max(1, Math.min(
    TAPE_RECORD_PAGE_MAX_ROWS,
    Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : TAPE_RECORD_PAGE_MAX_ROWS,
  ));
  const total = Math.max(0, bigIntNum(header.logical_record_count, "turn tape record total") - 1);

  if (before !== undefined) {
    return listTurnTapeRecordsBefore(pool, sessionId, userId, tapeId, header, before, cappedLimit, total);
  }

  let rawBytes = 0;
  let nextCursor: number | null = null;
  const records: MessageLike[] = [];
  let scanCursor = start;
  let exhausted = false;
  while (records.length < cappedLimit && !exhausted && nextCursor === null) {
    const heads = await fetchForwardTapeHeads(
      pool,
      sessionId,
      userId,
      tapeId,
      scanCursor,
      header.billing_anchor_id,
      cappedLimit + 1,
    );
    if (heads.length === 0) break;
    const batch = selectForwardHeadBatch(heads, records.length, cappedLimit, rawBytes, scanCursor);
    rawBytes = batch.rawBytes;
    scanCursor = batch.scanCursor;
    nextCursor = batch.nextCursor;
    records.push(...await hydrateDirectTapePage(
      pool,
      sessionId,
      userId,
      tapeId,
      header.tape_sha256,
      header.billing_anchor_id,
      batch.selected,
      { continuationOfTurnKey: header.continuation_of_turn_key },
    ));
    if (nextCursor !== null || heads.length <= cappedLimit) exhausted = true;
  }
  return { records, nextCursor, total };
}

async function backfillLegacyVisiblePayload(
  pool: Pool,
  sessionId: string,
  userId: string,
  tapeId: string,
  recordOrdinal: number,
  row: VisiblePayloadHead,
): Promise<{ head: VisiblePayloadHead; bytes: Buffer } | null> {
  const legacy = (
    await pool.query<{ payload: Buffer }>(
      `SELECT payload FROM client_session_turn_tape_records
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND ordinal=$4`,
      [sessionId, userId, tapeId, recordOrdinal],
    )
  ).rows[0];
  if (!legacy) return null;
  const visible = userVisiblePhysicalPayload({
    tape_id: tapeId,
    tape_sha256: row.tape_sha256,
    waive_reason: null,
    waiver_applied: false,
    msg_id: row.msg_id,
    ordinal: recordOrdinal,
    role: row.role,
    content_sha256: row.content_sha256,
    payload: Buffer.from(legacy.payload),
    cost_credits: "0",
    delegate_costs: [],
  }, row.tape_sha256, row.billing_anchor_id);
  if (!visible) return null;
  await pool.query(
    `UPDATE client_session_turn_tape_records
        SET visible_payload=COALESCE(visible_payload,$5),
            visible_content_sha256=COALESCE(visible_content_sha256,$6),
            visible_payload_bytes=COALESCE(visible_payload_bytes,$7)
      WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND ordinal=$4`,
    [sessionId, userId, tapeId, recordOrdinal, visible.bytes, visible.contentSha256, visible.bytes.length],
  );
  return {
    bytes: visible.bytes,
    head: {
      ...row,
      visible_bytes: String(visible.bytes.length),
      visible_content_sha256: visible.contentSha256,
    },
  };
}

function isValidRangeArgs(
  recordOrdinal: number,
  requestedOffset: number,
  requestedLength: number | undefined,
): boolean {
  if (!Number.isSafeInteger(recordOrdinal) || recordOrdinal < 0) return false;
  if (!Number.isSafeInteger(requestedOffset) || requestedOffset < 0) return false;
  return requestedLength === undefined || (Number.isSafeInteger(requestedLength) && requestedLength >= 0);
}

export async function readTapeRecordPayloadImpl(
  pool: Pool,
  sessionId: string,
  userId: string,
  tapeId: string,
  recordOrdinal: number,
  requestedOffset = 0,
  requestedLength?: number,
): Promise<TapeRecordPayload | null> {
  if (!isValidRangeArgs(recordOrdinal, requestedOffset, requestedLength)) return null;
  const row = (
    await pool.query<VisiblePayloadHead>(READ_VISIBLE_PAYLOAD_HEAD_SQL, [
      sessionId,
      userId,
      tapeId,
      recordOrdinal,
    ])
  ).rows[0];
  if (!row) return null;

  let visibleHead = row;
  let freshlyMaterialized: Buffer | null = null;
  if (visibleHead.visible_bytes === null || visibleHead.visible_content_sha256 === null) {
    const backfilled = await backfillLegacyVisiblePayload(pool, sessionId, userId, tapeId, recordOrdinal, row);
    if (!backfilled) return null;
    visibleHead = backfilled.head;
    freshlyMaterialized = backfilled.bytes;
  }

  const totalBytes = bigIntNum(visibleHead.visible_bytes!, "visible tape record payload bytes");
  if (requestedOffset > totalBytes) return null;
  const length = requestedLength === undefined
    ? totalBytes - requestedOffset
    : Math.min(requestedLength, totalBytes - requestedOffset);

  let chunk: Buffer;
  if (length === 0) {
    chunk = Buffer.alloc(0);
  } else if (freshlyMaterialized !== null) {
    chunk = freshlyMaterialized.subarray(requestedOffset, requestedOffset + length);
  } else {
    const chunkRow = (
      await pool.query<{ chunk: Buffer }>(
        `SELECT substring(visible_payload FROM $5::integer + 1 FOR $6::integer) AS chunk
           FROM client_session_turn_tape_records
          WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND ordinal=$4`,
        [sessionId, userId, tapeId, recordOrdinal, requestedOffset, length],
      )
    ).rows[0];
    if (!chunkRow) return null;
    chunk = Buffer.from(chunkRow.chunk ?? Buffer.alloc(0));
  }
  return {
    payload: chunk,
    totalBytes,
    offset: requestedOffset,
    msgId: row.msg_id,
    role: row.role,
    contentSha256: visibleHead.visible_content_sha256!,
    tapeSha256: row.tape_sha256,
  };
}

export async function readTapeRecordPayloadChunkImpl(
  pool: Pool,
  sessionId: string,
  userId: string,
  tapeId: string,
  recordOrdinal: number,
  offset: number,
  requestedBytes?: number,
): Promise<TapeRecordPayloadChunk | null> {
  const record = await readTapeRecordPayloadImpl(
    pool,
    sessionId,
    userId,
    tapeId,
    recordOrdinal,
    offset,
    requestedBytes,
  );
  if (!record) return null;
  const endExclusive = record.offset + record.payload.length;
  return {
    chunk: record.payload,
    nextOffset: endExclusive < record.totalBytes ? endExclusive : null,
    totalBytes: record.totalBytes,
    start: record.offset,
    endExclusive,
    msgId: record.msgId,
    role: record.role,
    contentSha256: record.contentSha256,
    tapeSha256: record.tapeSha256,
  };
}

export async function readUserMessagePayloadImpl(
  pool: Pool | PoolClient,
  sessionId: string,
  userId: string,
  msgId: string,
  offset = 0,
  requestedLength?: number,
): Promise<{
  payload: Buffer;
  totalBytes: number;
  offset: number;
  msgId: string;
  role: "user";
  contentSha256: string;
} | null> {
  const requestedOffset = Number.isSafeInteger(offset) && offset >= 0 ? offset : -1;
  if (requestedOffset < 0) return null;
  if (
    requestedLength !== undefined &&
    (!Number.isSafeInteger(requestedLength) || requestedLength < 0)
  ) return null;
  const row = (
    await pool.query<{ content_sha256: string; payload_bytes: string }>(
      `SELECT p.content_sha256,p.payload_bytes::text AS payload_bytes
         FROM client_session_user_payloads p
         JOIN client_sessions s ON s.id=p.session_id AND s.user_id=p.user_id
        WHERE p.session_id=$1 AND p.user_id=$2 AND p.msg_id=$3 AND s.deleted_at IS NULL`,
      [sessionId, userId, msgId],
    )
  ).rows[0];
  if (!row) return null;
  const totalBytes = bigIntNum(row.payload_bytes, "user payload bytes");
  if (requestedOffset > totalBytes) return null;
  const length = requestedLength === undefined
    ? totalBytes - requestedOffset
    : Math.min(requestedLength, totalBytes - requestedOffset);
  const payload = length === 0
    ? Buffer.alloc(0)
    : Buffer.from((
        await pool.query<{ chunk: Buffer }>(
          `SELECT substring(payload FROM $4::integer + 1 FOR $5::integer) AS chunk
             FROM client_session_user_payloads
            WHERE session_id=$1 AND user_id=$2 AND msg_id=$3`,
          [sessionId, userId, msgId, requestedOffset, length],
        )
      ).rows[0]?.chunk ?? Buffer.alloc(0));
  return {
    payload,
    totalBytes,
    offset: requestedOffset,
    msgId,
    role: "user",
    contentSha256: row.content_sha256,
  };
}

export function createPgTapeRecordReader(
  ctx: PgSessionsCtx,
): Pick<
  ClientSessionsBackend,
  | "listTurnTapeRecords"
  | "readTapeRecordPayload"
  | "readTapeRecordPayloadChunk"
  | "readUserMessagePayload"
> {
  const { pool } = ctx;
  return {
    listTurnTapeRecords(sessionId, userId, tapeId, cursor, limit, before) {
      return listTurnTapeRecordsImpl(
        pool, sessionId, userId, tapeId, cursor ?? 0, limit ?? TAPE_RECORD_PAGE_MAX_ROWS, before,
      );
    },
    readTapeRecordPayload(sessionId, userId, tapeId, recordOrdinal, offset, length) {
      return readTapeRecordPayloadImpl(pool, sessionId, userId, tapeId, recordOrdinal, offset ?? 0, length);
    },
    readTapeRecordPayloadChunk(sessionId, userId, tapeId, recordOrdinal, offset, bytes) {
      return readTapeRecordPayloadChunkImpl(pool, sessionId, userId, tapeId, recordOrdinal, offset ?? 0, bytes);
    },
    readUserMessagePayload(sessionId, userId, msgId, offset, length) {
      return readUserMessagePayloadImpl(pool, sessionId, userId, msgId, offset ?? 0, length);
    },
  };
}
