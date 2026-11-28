import type { Pool } from "pg";
import {
  MODEL_HISTORY_EXACT_SUFFIX_MARKER,
  estimateModelHistoryTokens,
  estimateModelHistoryUtf8Bytes,
  exactModelHistoryTextSuffix,
  modelHistoryReservedTokens,
  modelHistorySemanticRole,
  modelHistorySemanticText,
  resolveModelHistoryContextWindow,
  sanitizePersistedModelHistoryText,
} from "@openclaude/protocol";
import type { EngineContextReadOptions, MessageLike } from "@openclaude/storage";
import { recordsPublished } from "../visibleFinalize.js";
import type { PgSessionsDeps } from "./deps.js";
import { hydrateTurnTapeMessages } from "./pgTapeHydrateReader.js";
import { userVisiblePhysicalPayload } from "./pgTapeSanitizeAndEncode.js";
import { bigIntNum } from "./sqlHelpers.js";
import type {
  FiniteModelContextState,
  FiniteModelRecord,
  FiniteTapeModelRow,
  PredecessorPhysicalHead,
} from "./types.js";

const PREDECESSOR_MODEL_PHYSICAL_PAGE_ROWS = 512;
const PREDECESSOR_MODEL_RAW_PAGE_BYTES = 8 * 1024 * 1024;
const PREDECESSOR_MODEL_CANDIDATE_ROLES = new Set([
  "user", "assistant", "tool", "plan", "goal", "agent-group", "error", "runtime-event",
]);

type PredecessorModelSourceRow = {
  msg_id: string;
  ordinal: number;
  role: string;
  content_sha256: string;
  payload: Buffer;
};

type CompleteTapeModelMeta = {
  tape_sha256: string;
  billing_anchor_id: string | null;
  model_record_count: number;
  materialization_status: string | null;
  finalized_at: string | null;
};

type FiniteContextReader = {
  pool: Pool;
  sessionId: string;
  userId: string;
  options: EngineContextReadOptions;
  deps: PgSessionsDeps;
  state: FiniteModelContextState;
  processedCompleteTapes: Set<string>;
};

const READ_STORED_PHYSICAL_MODEL_ROWS_SQL = `SELECT physical_ordinal,logical_ordinal,msg_id,role,token_estimate,ts::text,client_message_id
   FROM client_session_turn_tape_model_records
  WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND physical_ordinal=ANY($4::integer[])
  ORDER BY physical_ordinal DESC,logical_ordinal DESC`;

const READ_UNBACKFILLED_MODEL_SOURCES_SQL = `SELECT msg_id,ordinal,role,content_sha256,payload
   FROM client_session_turn_tape_records
  WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND ordinal=ANY($4::integer[]) AND model_sidecar_complete=FALSE`;

const INSERT_MODEL_SIDECAR_ROWS_SQL = `INSERT INTO client_session_turn_tape_model_records
   (session_id,user_id,tape_id,physical_ordinal,logical_ordinal,msg_id,role,semantic_text,token_estimate,ts,client_message_id)
 SELECT $1,$2,$3,m.physical_ordinal,m.logical_ordinal,m.msg_id,m.role,m.semantic_text,m.token_estimate,m.ts,m.client_message_id
   FROM unnest($4::integer[],$5::integer[],$6::text[],$7::text[],$8::text[],$9::integer[],$10::bigint[],$11::text[])
     AS m(physical_ordinal,logical_ordinal,msg_id,role,semantic_text,token_estimate,ts,client_message_id)
 ON CONFLICT (session_id,user_id,tape_id,physical_ordinal,logical_ordinal) DO NOTHING`;

const READ_STORED_MODEL_SIDECARS_FOR_VERIFY_SQL = `SELECT physical_ordinal,logical_ordinal,msg_id,role,semantic_text,token_estimate,ts::text,client_message_id
   FROM client_session_turn_tape_model_records
  WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND physical_ordinal=ANY($4::integer[])
  ORDER BY physical_ordinal,logical_ordinal`;

const MARK_MODEL_SIDECAR_COMPLETE_SQL = `UPDATE client_session_turn_tape_records SET model_sidecar_complete=TRUE
  WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND ordinal=ANY($4::integer[])`;

const READ_COMPLETED_RACED_ORDINALS_SQL = `SELECT ordinal FROM client_session_turn_tape_records
  WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND ordinal=ANY($4::integer[]) AND model_sidecar_complete=TRUE`;

const READ_PREDECESSOR_PHYSICAL_HEADS_SQL = `SELECT ordinal,msg_id,role,content_sha256,octet_length(payload)::text AS payload_bytes,model_sidecar_complete
   FROM client_session_turn_tape_records
  WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND ($4::integer IS NULL OR ordinal < $4)
  ORDER BY ordinal DESC LIMIT ${PREDECESSOR_MODEL_PHYSICAL_PAGE_ROWS}`;

const MARK_EMPTY_MODEL_SIDECAR_COMPLETE_SQL = `UPDATE client_session_turn_tape_records SET model_sidecar_complete=TRUE
  WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND ordinal=ANY($4::integer[]) AND model_sidecar_complete=FALSE`;

const FINALIZE_PREDECESSOR_MODEL_COUNT_SQL = `UPDATE client_session_turn_tapes t
    SET model_record_count=(SELECT COUNT(*)::integer FROM client_session_turn_tape_model_records m
       WHERE m.session_id=t.session_id AND m.user_id=t.user_id AND m.tape_id=t.tape_id)
  WHERE t.session_id=$1 AND t.user_id=$2 AND t.tape_id=$3 AND t.model_record_count < 0
    AND NOT EXISTS (SELECT 1 FROM client_session_turn_tape_records r
       WHERE r.session_id=t.session_id AND r.user_id=t.user_id AND r.tape_id=t.tape_id AND r.model_sidecar_complete=FALSE)`;

const READ_INDEXED_TAPE_MODEL_PAGE_SQL = `SELECT physical_ordinal,logical_ordinal,msg_id,role,token_estimate,ts::text,client_message_id
   FROM client_session_turn_tape_model_records
  WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
    AND ($4::integer IS NULL OR (physical_ordinal,logical_ordinal) < ($4::integer,$5::integer))
  ORDER BY physical_ordinal DESC,logical_ordinal DESC LIMIT 128`;

const READ_FINITE_ARCHIVE_CHUNKS_SQL = `SELECT messages,last_seq FROM client_session_archive_chunks
  WHERE session_id=$1 AND user_id=$2 AND ($3::bigint IS NULL OR last_seq < $3)
  ORDER BY last_seq DESC LIMIT 4`;

const READ_COMPLETE_TAPE_MODEL_META_SQL = `SELECT tape_sha256,model_record_count,billing_anchor_id,materialization_status, finalized_at::text
   FROM client_session_turn_tapes
  WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
    AND (visible_at IS NOT NULL OR finalized_at IS NOT NULL) AND billing_anchor_id IS NOT NULL`;

// ── Pre-0176 physical model sidecar read & backfill ──────────────────────────

async function readStoredPhysicalModelRows(
  ctx: FiniteContextReader,
  tapeId: string,
  physicalOrdinals: number[],
): Promise<FiniteTapeModelRow[]> {
  if (physicalOrdinals.length === 0) return [];
  return (await ctx.pool.query<FiniteTapeModelRow>(
    READ_STORED_PHYSICAL_MODEL_ROWS_SQL,
    [ctx.sessionId, ctx.userId, tapeId, physicalOrdinals],
  )).rows;
}

function deriveModelRowsFromSources(
  tapeId: string,
  tapeSha256: string,
  billingAnchorId: string,
  sources: PredecessorModelSourceRow[],
  headsByOrdinal: Map<number, PredecessorPhysicalHead>,
): FiniteTapeModelRow[] {
  const derived: FiniteTapeModelRow[] = [];
  for (const source of sources) {
    const head = headsByOrdinal.get(source.ordinal);
    const metadataInvalid =
      !head || source.msg_id !== head.msg_id || source.role !== head.role ||
      source.content_sha256 !== head.content_sha256 ||
      Buffer.from(source.payload).length !== bigIntNum(head.payload_bytes, "model tape payload bytes");
    if (metadataInvalid) throw new Error(`[pgSessions] model tape metadata mismatch: ${tapeId}\0${source.ordinal}`);
    const visible = userVisiblePhysicalPayload({
      tape_id: tapeId, tape_sha256: tapeSha256, waive_reason: null, waiver_applied: false,
      msg_id: source.msg_id, ordinal: source.ordinal, role: source.role, content_sha256: source.content_sha256,
      payload: Buffer.from(source.payload), cost_credits: "0", delegate_costs: [],
    }, tapeSha256, billingAnchorId);
    if (!visible) throw new Error(`[pgSessions] model tape record is not a JSON object: ${tapeId}\0${source.ordinal}`);
    for (const record of visible.modelRecords) {
      derived.push({
        physical_ordinal: source.ordinal,
        logical_ordinal: record.logicalOrdinal,
        msg_id: record.msgId === `logical-${record.logicalOrdinal}`
          ? `${source.msg_id}:logical-${record.logicalOrdinal}` : record.msgId,
        role: record.role,
        token_estimate: record.tokenEstimate,
        ts: record.ts === null ? null : String(record.ts),
        client_message_id: record.clientMessageId,
        semantic_text: record.semanticText,
      });
    }
  }
  return derived;
}

async function persistAndVerifyDerivedModelRows(
  ctx: FiniteContextReader,
  tapeId: string,
  sourceOrdinals: number[],
  derived: FiniteTapeModelRow[],
): Promise<void> {
  if (derived.length > 0) {
    await ctx.pool.query(INSERT_MODEL_SIDECAR_ROWS_SQL, [
      ctx.sessionId, ctx.userId, tapeId,
      derived.map((r) => r.physical_ordinal), derived.map((r) => r.logical_ordinal),
      derived.map((r) => r.msg_id), derived.map((r) => r.role),
      derived.map((r) => r.semantic_text!), derived.map((r) => r.token_estimate),
      derived.map((r) => r.ts), derived.map((r) => r.client_message_id),
    ]);
  }
  const stored = (await ctx.pool.query<FiniteTapeModelRow & { semantic_text: string }>(
    READ_STORED_MODEL_SIDECARS_FOR_VERIFY_SQL, [ctx.sessionId, ctx.userId, tapeId, sourceOrdinals],
  )).rows;
  const expected = [...derived].sort((a, b) => a.physical_ordinal - b.physical_ordinal || a.logical_ordinal - b.logical_ordinal);
  const conflicted = stored.length !== expected.length || stored.some((actual, index) => {
    const wanted = expected[index]!;
    return actual.physical_ordinal !== wanted.physical_ordinal ||
      actual.logical_ordinal !== wanted.logical_ordinal ||
      actual.msg_id !== wanted.msg_id || actual.role !== wanted.role ||
      actual.semantic_text !== wanted.semantic_text || actual.token_estimate !== wanted.token_estimate ||
      actual.ts !== wanted.ts || actual.client_message_id !== wanted.client_message_id;
  });
  if (conflicted) throw new Error(`[pgSessions] immutable model sidecar conflict: ${tapeId}`);
  if (sourceOrdinals.length > 0) {
    await ctx.pool.query(MARK_MODEL_SIDECAR_COMPLETE_SQL, [ctx.sessionId, ctx.userId, tapeId, sourceOrdinals]);
  }
}

function groupModelRowsByPhysical(rows: FiniteTapeModelRow[]): Map<number, FiniteTapeModelRow[]> {
  const byPhysical = new Map<number, FiniteTapeModelRow[]>();
  for (const row of rows) {
    const list = byPhysical.get(row.physical_ordinal) ?? [];
    list.push(row);
    byPhysical.set(row.physical_ordinal, list);
  }
  return byPhysical;
}

/** Pre-0176 tapes have no model sidecar; materialize and persist one bounded raw-byte page. */
async function readOrBackfillPhysicalModelPage(
  ctx: FiniteContextReader,
  tapeId: string,
  meta: CompleteTapeModelMeta,
  heads: PredecessorPhysicalHead[],
): Promise<Map<number, FiniteTapeModelRow[]>> {
  if (heads.length === 0) return new Map();
  const requestedOrdinals = heads.map((head) => head.ordinal);
  const sources = (await ctx.pool.query<PredecessorModelSourceRow>(
    READ_UNBACKFILLED_MODEL_SOURCES_SQL, [ctx.sessionId, ctx.userId, tapeId, requestedOrdinals],
  )).rows;
  const headsByOrdinal = new Map(heads.map((head) => [head.ordinal, head]));
  const derived = deriveModelRowsFromSources(tapeId, meta.tape_sha256, meta.billing_anchor_id!, sources, headsByOrdinal);
  const sourceOrdinals = sources.map((source) => source.ordinal);
  await persistAndVerifyDerivedModelRows(ctx, tapeId, sourceOrdinals, derived);

  const racedOrdinals = requestedOrdinals.filter((ordinal) => !sourceOrdinals.includes(ordinal));
  if (racedOrdinals.length > 0) {
    const completed = (await ctx.pool.query<{ ordinal: number }>(
      READ_COMPLETED_RACED_ORDINALS_SQL, [ctx.sessionId, ctx.userId, tapeId, racedOrdinals],
    )).rows;
    if (completed.length !== racedOrdinals.length) {
      throw new Error(`[pgSessions] model tape record missing: ${tapeId}`);
    }
  }
  const racedRows = await readStoredPhysicalModelRows(ctx, tapeId, racedOrdinals);
  const rows = [...derived, ...racedRows].sort((a, b) =>
    b.physical_ordinal - a.physical_ordinal || b.logical_ordinal - a.logical_ordinal);
  return groupModelRowsByPhysical(rows);
}

// ── Budgeted record accumulator ──────────────────────────────────────────────

function pushFiniteRecordText(state: FiniteModelContextState, record: FiniteModelRecord, text: string): void {
  state.newestFirst.push({
    id: record.id,
    role: record.role,
    text,
    ...(record.ts !== undefined ? { ts: record.ts } : {}),
    ...(record.clientMessageId ? { _clientMessageId: record.clientMessageId } : {}),
    ...(record.seq !== undefined ? { _seq: record.seq } : {}),
    ...(record.orderSeq !== undefined ? { _orderSeq: record.orderSeq } : {}),
  });
}

function appendBoundedSuffixAndStop(
  state: FiniteModelContextState,
  record: FiniteModelRecord,
  text: string,
  suffixBudget: number,
): void {
  if (state.remainingTokens > 64 && suffixBudget > 0) {
    const suffix = exactModelHistoryTextSuffix(text, suffixBudget);
    if (suffix) pushFiniteRecordText(state, record, MODEL_HISTORY_EXACT_SUFFIX_MARKER + suffix);
  }
  state.stopped = true;
}

async function appendFiniteModelRecord(
  state: FiniteModelContextState,
  record: FiniteModelRecord,
  loadFullText: () => Promise<string>,
  loadSuffixText: (maxCharacters: number) => Promise<string>,
): Promise<void> {
  if (state.stopped) return;
  const suffixBudget = Math.max(
    0,
    state.remainingTokens - estimateModelHistoryTokens(MODEL_HISTORY_EXACT_SUFFIX_MARKER) - 5,
  );
  const rowTokens = record.tokenEstimate + 5;
  if (rowTokens <= state.remainingTokens) {
    const text = sanitizePersistedModelHistoryText(await loadFullText());
    const exactTokens = estimateModelHistoryTokens(text) + 5;
    if (exactTokens <= state.remainingTokens) {
      pushFiniteRecordText(state, record, text);
      state.remainingTokens -= exactTokens;
      return;
    }
    appendBoundedSuffixAndStop(state, record, text, suffixBudget);
    return;
  }
  if (state.remainingTokens > 64 && suffixBudget > 0) {
    const bounded = sanitizePersistedModelHistoryText(
      await loadSuffixText(Math.min(2_000_000_000, suffixBudget * 4)),
    );
    appendBoundedSuffixAndStop(state, record, bounded, suffixBudget);
    return;
  }
  state.stopped = true;
}

// ── Per-source finite context loaders ────────────────────────────────────────

function isExcludedFromFiniteContext(
  options: EngineContextReadOptions,
  id: string,
  clientMessageId?: string,
): boolean {
  return !!options.excludeClientMessageId &&
    (id === options.excludeClientMessageId || clientMessageId === options.excludeClientMessageId);
}

async function readDeferredUserPayloadText(
  ctx: FiniteContextReader,
  id: string,
  maxCharacters?: number,
): Promise<string> {
  const row = maxCharacters === undefined
    ? (await ctx.pool.query<{ text_payload: string }>(
        "SELECT text_payload FROM client_session_user_payloads WHERE session_id=$1 AND user_id=$2 AND msg_id=$3",
        [ctx.sessionId, ctx.userId, id],
      )).rows[0]
    : (await ctx.pool.query<{ text_payload: string }>(
        "SELECT right(text_payload,$4::integer) AS text_payload FROM client_session_user_payloads WHERE session_id=$1 AND user_id=$2 AND msg_id=$3",
        [ctx.sessionId, ctx.userId, id, maxCharacters],
      )).rows[0];
  if (!row) throw new Error(`[pgSessions] deferred user payload missing: ${ctx.sessionId}\0${id}`);
  return row.text_payload;
}

async function processDeferredUserMessage(ctx: FiniteContextReader, message: MessageLike): Promise<void> {
  const id = message.id as string;
  const clientMessageId = typeof message._clientMessageId === "string" ? message._clientMessageId : undefined;
  if (isExcludedFromFiniteContext(ctx.options, id, clientMessageId)) return;
  const meta = (await ctx.pool.query<{ model_token_estimate: number | null; character_count: string }>(
    "SELECT model_token_estimate, length(text_payload)::text AS character_count FROM client_session_user_payloads WHERE session_id=$1 AND user_id=$2 AND msg_id=$3",
    [ctx.sessionId, ctx.userId, id],
  )).rows[0];
  if (!meta) throw new Error(`[pgSessions] deferred user payload missing: ${ctx.sessionId}\0${id}`);
  const tokenEstimate = meta.model_token_estimate ?? bigIntNum(meta.character_count, "deferred user character count");
  await appendFiniteModelRecord(
    ctx.state,
    {
      id, role: "user", tokenEstimate,
      ...(typeof message.ts === "number" ? { ts: message.ts } : {}),
      ...(clientMessageId ? { clientMessageId } : {}),
      ...(typeof message._seq === "number" ? { seq: message._seq } : {}),
      ...(typeof message._orderSeq === "number" ? { orderSeq: message._orderSeq } : {}),
    },
    () => readDeferredUserPayloadText(ctx, id),
    (maxChars) => readDeferredUserPayloadText(ctx, id, maxChars),
  );
}

async function readTapeModelSemanticText(
  pool: Pool,
  tapeId: string,
  keyParams: [string, string, string, number, number],
  maxCharacters?: number,
): Promise<string> {
  const row = maxCharacters === undefined
    ? (await pool.query<{ semantic_text: string }>(
        "SELECT semantic_text FROM client_session_turn_tape_model_records WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND physical_ordinal=$4 AND logical_ordinal=$5",
        keyParams,
      )).rows[0]
    : (await pool.query<{ semantic_text: string }>(
        "SELECT right(semantic_text,$6::integer) AS semantic_text FROM client_session_turn_tape_model_records WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND physical_ordinal=$4 AND logical_ordinal=$5",
        [...keyParams, maxCharacters],
      )).rows[0];
  if (!row) throw new Error(`[pgSessions] model tape record missing: ${tapeId}`);
  return row.semantic_text;
}

async function appendTapeModelRow(
  ctx: FiniteContextReader,
  anchor: MessageLike,
  tapeId: string,
  row: FiniteTapeModelRow,
): Promise<void> {
  if (isExcludedFromFiniteContext(ctx.options, row.msg_id, row.client_message_id ?? undefined)) return;
  const keyParams: [string, string, string, number, number] = [
    ctx.sessionId, ctx.userId, tapeId, row.physical_ordinal, row.logical_ordinal,
  ];
  await appendFiniteModelRecord(
    ctx.state,
    {
      id: row.msg_id, role: row.role, tokenEstimate: row.token_estimate,
      ...(row.ts === null ? {} : { ts: bigIntNum(row.ts, "model record ts") }),
      ...(row.client_message_id ? { clientMessageId: row.client_message_id } : {}),
      ...(typeof anchor._seq === "number" ? { seq: anchor._seq } : {}),
      ...(typeof anchor._orderSeq === "number" ? { orderSeq: anchor._orderSeq } : {}),
    },
    async () => row.semantic_text ?? readTapeModelSemanticText(ctx.pool, tapeId, keyParams),
    async (maxChars) =>
      row.semantic_text !== undefined
        ? row.semantic_text.slice(-maxChars)
        : readTapeModelSemanticText(ctx.pool, tapeId, keyParams, maxChars),
  );
}

// ── Complete tape traversal (legacy + indexed) ───────────────────────────────

async function fetchPredecessorPhysicalPage(
  ctx: FiniteContextReader,
  tapeId: string,
  beforeOrdinal: number | null,
): Promise<PredecessorPhysicalHead[]> {
  return (await ctx.pool.query<PredecessorPhysicalHead>(
    READ_PREDECESSOR_PHYSICAL_HEADS_SQL, [ctx.sessionId, ctx.userId, tapeId, beforeOrdinal],
  )).rows;
}

async function markDeterministicEmptySidecarsComplete(
  ctx: FiniteContextReader,
  tapeId: string,
  ordinals: number[],
): Promise<void> {
  if (ordinals.length === 0) return;
  await ctx.pool.query(MARK_EMPTY_MODEL_SIDECAR_COMPLETE_SQL, [ctx.sessionId, ctx.userId, tapeId, ordinals]);
}

function collectRawBackfillSlice(
  physical: PredecessorPhysicalHead[],
  startIndex: number,
): { rawPage: PredecessorPhysicalHead[]; nextIndex: number } {
  const rawPage: PredecessorPhysicalHead[] = [];
  let rawBytes = 0;
  let scan = startIndex;
  while (scan < physical.length) {
    const candidate = physical[scan]!;
    if (!PREDECESSOR_MODEL_CANDIDATE_ROLES.has(candidate.role)) {
      scan += 1;
      continue;
    }
    if (candidate.model_sidecar_complete) break;
    const payloadBytes = bigIntNum(candidate.payload_bytes, "model tape payload bytes");
    if (rawPage.length > 0 && rawBytes + payloadBytes > PREDECESSOR_MODEL_RAW_PAGE_BYTES) break;
    rawPage.push(candidate);
    rawBytes += payloadBytes;
    scan += 1;
    if (rawBytes >= PREDECESSOR_MODEL_RAW_PAGE_BYTES) break;
  }
  return { rawPage, nextIndex: scan };
}

async function appendModelRowList(
  ctx: FiniteContextReader,
  anchor: MessageLike,
  tapeId: string,
  rows: FiniteTapeModelRow[],
): Promise<void> {
  for (const row of rows) {
    await appendTapeModelRow(ctx, anchor, tapeId, row);
    if (ctx.state.stopped) return;
  }
}

async function consumePredecessorPhysicalPage(
  ctx: FiniteContextReader,
  anchor: MessageLike,
  tapeId: string,
  meta: CompleteTapeModelMeta,
  physical: PredecessorPhysicalHead[],
  completedByPhysical: Map<number, FiniteTapeModelRow[]>,
): Promise<void> {
  let index = 0;
  while (index < physical.length && !ctx.state.stopped) {
    const head = physical[index]!;
    if (!PREDECESSOR_MODEL_CANDIDATE_ROLES.has(head.role)) {
      index += 1;
      continue;
    }
    if (head.model_sidecar_complete) {
      await appendModelRowList(ctx, anchor, tapeId, completedByPhysical.get(head.ordinal) ?? []);
      index += 1;
      continue;
    }
    const { rawPage, nextIndex } = collectRawBackfillSlice(physical, index);
    const backfilled = await readOrBackfillPhysicalModelPage(ctx, tapeId, meta, rawPage);
    for (const rawHead of rawPage) {
      await appendModelRowList(ctx, anchor, tapeId, backfilled.get(rawHead.ordinal) ?? []);
      if (ctx.state.stopped) break;
    }
    index = nextIndex;
  }
}

async function processLegacyModelTape(
  ctx: FiniteContextReader,
  anchor: MessageLike,
  tapeId: string,
  meta: CompleteTapeModelMeta,
): Promise<void> {
  let beforeOrdinal: number | null = null;
  let fullyVisited = false;
  while (!ctx.state.stopped) {
    const physical = await fetchPredecessorPhysicalPage(ctx, tapeId, beforeOrdinal);
    if (physical.length === 0) {
      fullyVisited = true;
      break;
    }
    const emptyOrdinals = physical
      .filter((h) => !h.model_sidecar_complete && !PREDECESSOR_MODEL_CANDIDATE_ROLES.has(h.role))
      .map((h) => h.ordinal);
    await markDeterministicEmptySidecarsComplete(ctx, tapeId, emptyOrdinals);
    const completedOrdinals = physical
      .filter((h) => h.model_sidecar_complete && PREDECESSOR_MODEL_CANDIDATE_ROLES.has(h.role))
      .map((h) => h.ordinal);
    const completedRows = await readStoredPhysicalModelRows(ctx, tapeId, completedOrdinals);
    await consumePredecessorPhysicalPage(ctx, anchor, tapeId, meta, physical, groupModelRowsByPhysical(completedRows));
    if (ctx.state.stopped) break;
    beforeOrdinal = physical.at(-1)!.ordinal;
    if (physical.length < PREDECESSOR_MODEL_PHYSICAL_PAGE_ROWS) {
      fullyVisited = true;
      break;
    }
  }
  if (fullyVisited) {
    await ctx.pool.query(FINALIZE_PREDECESSOR_MODEL_COUNT_SQL, [ctx.sessionId, ctx.userId, tapeId]);
  }
}

async function fetchIndexedTapeModelPage(
  ctx: FiniteContextReader,
  tapeId: string,
  beforePhysical: number | null,
  beforeLogical: number | null,
): Promise<FiniteTapeModelRow[]> {
  return (await ctx.pool.query<FiniteTapeModelRow>(
    READ_INDEXED_TAPE_MODEL_PAGE_SQL, [ctx.sessionId, ctx.userId, tapeId, beforePhysical, beforeLogical],
  )).rows;
}

async function processIndexedModelTape(
  ctx: FiniteContextReader,
  anchor: MessageLike,
  tapeId: string,
  expectedModelRecordCount: number,
): Promise<void> {
  let beforePhysical: number | null = null;
  let beforeLogical: number | null = null;
  let visited = 0;
  while (!ctx.state.stopped) {
    const page = await fetchIndexedTapeModelPage(ctx, tapeId, beforePhysical, beforeLogical);
    if (page.length === 0) break;
    for (const row of page) {
      visited += 1;
      beforePhysical = row.physical_ordinal;
      beforeLogical = row.logical_ordinal;
      await appendTapeModelRow(ctx, anchor, tapeId, row);
      if (ctx.state.stopped) return;
    }
    if (page.length < 128) break;
  }
  if (!ctx.state.stopped && visited !== expectedModelRecordCount) {
    throw new Error(`[pgSessions] model tape record count mismatch: ${tapeId}`);
  }
}

async function processCompleteTape(ctx: FiniteContextReader, anchor: MessageLike): Promise<boolean> {
  const tapeId = anchor._turnTapeId as string;
  if (ctx.processedCompleteTapes.has(tapeId)) return true;
  ctx.processedCompleteTapes.add(tapeId);
  const meta = (await ctx.pool.query<CompleteTapeModelMeta>(
    READ_COMPLETE_TAPE_MODEL_META_SQL, [ctx.sessionId, ctx.userId, tapeId],
  )).rows[0];
  if (!meta) throw new Error(`[pgSessions] finalized lossless turn tape missing: ${tapeId}`);
  if (!recordsPublished({ materializationStatus: meta.materialization_status, finalizedAt: meta.finalized_at })) {
    ctx.processedCompleteTapes.delete(tapeId);
    return false;
  }
  if (meta.tape_sha256 !== anchor._turnTapeSha256) {
    throw new Error(`[pgSessions] lossless turn tape aggregate hash mismatch: ${tapeId}`);
  }
  if (meta.model_record_count === 0) return true;
  if (meta.model_record_count < 0) await processLegacyModelTape(ctx, anchor, tapeId, meta);
  else await processIndexedModelTape(ctx, anchor, tapeId, meta.model_record_count);
  return true;
}

// ── Message & archive chunk walk ─────────────────────────────────────────────

async function processInlineModelMessage(ctx: FiniteContextReader, message: MessageLike, index: number): Promise<void> {
  const role = modelHistorySemanticRole(message);
  const text = modelHistorySemanticText(message);
  const id = typeof message.id === "string" ? message.id : `inline:${index}`;
  const clientMessageId = typeof message._clientMessageId === "string" ? message._clientMessageId : undefined;
  if (!role || message.system === true || !text.trim() || isExcludedFromFiniteContext(ctx.options, id, clientMessageId)) {
    return;
  }
  await appendFiniteModelRecord(
    ctx.state,
    {
      id, role, tokenEstimate: estimateModelHistoryTokens(text),
      ...(typeof message.ts === "number" ? { ts: message.ts } : {}),
      ...(clientMessageId ? { clientMessageId } : {}),
      ...(typeof message._seq === "number" ? { seq: message._seq } : {}),
      ...(typeof message._orderSeq === "number" ? { orderSeq: message._orderSeq } : {}),
    },
    async () => text,
    async (maxCharacters) => text.slice(-maxCharacters),
  );
}

async function processFiniteMessages(ctx: FiniteContextReader, messages: MessageLike[]): Promise<void> {
  for (let index = messages.length - 1; index >= 0 && !ctx.state.stopped; index--) {
    const message = messages[index]!;
    const hasTapeRef = typeof message._turnTapeId === "string" && typeof message._turnTapeSha256 === "string";
    if (message._turnTapeComplete === true && hasTapeRef && (await processCompleteTape(ctx, message))) continue;
    if (message._turnTapeComplete !== true && message._turnTapeExpanded !== true && hasTapeRef) {
      const rolling = await hydrateTurnTapeMessages(ctx.pool, ctx.sessionId, ctx.userId, [message], {
        view: "timeline", deferTimelineNarrative: false, engineContext: true,
      });
      await processFiniteMessages(ctx, rolling);
      continue;
    }
    if (message._userPayloadDeferred === true && typeof message.id === "string") {
      await processDeferredUserMessage(ctx, message);
      continue;
    }
    await processInlineModelMessage(ctx, message, index);
  }
}

async function fetchFiniteArchiveChunkPage(
  ctx: FiniteContextReader,
  beforeLastSeq: number | null,
): Promise<Array<{ messages: string; last_seq: string }>> {
  return (await ctx.pool.query<{ messages: string; last_seq: string }>(
    READ_FINITE_ARCHIVE_CHUNKS_SQL, [ctx.sessionId, ctx.userId, beforeLastSeq],
  )).rows;
}

function parseArchivedFiniteChunk(raw: string, deps: PgSessionsDeps): MessageLike[] | null {
  try {
    const parsed = JSON.parse(raw);
    const archived = Array.isArray(parsed)
      ? deps.storage.deriveArchivedOrderSeqsForRead(parsed as MessageLike[])
      : [];
    archived.sort(deps.storage.compareMessagesByOrder);
    return archived;
  } catch (err) {
    void err;
    return null;
  }
}

async function walkArchiveChunksForFiniteContext(ctx: FiniteContextReader): Promise<void> {
  let beforeLastSeq: number | null = null;
  while (!ctx.state.stopped) {
    const archiveRows = await fetchFiniteArchiveChunkPage(ctx, beforeLastSeq);
    if (archiveRows.length === 0) break;
    for (const archive of archiveRows) {
      beforeLastSeq = bigIntNum(archive.last_seq, "archive last_seq");
      const archived = parseArchivedFiniteChunk(archive.messages, ctx.deps);
      if (!archived) continue;
      await processFiniteMessages(ctx, archived);
      if (ctx.state.stopped) break;
    }
    if (archiveRows.length < 4) break;
  }
}

export async function computeFiniteEngineContextMessages(
  pool: Pool,
  sessionId: string,
  userId: string,
  messages: MessageLike[],
  options: EngineContextReadOptions,
  deps: PgSessionsDeps,
  resolvedContextWindow?: number,
): Promise<MessageLike[]> {
  const contextWindow = resolvedContextWindow
    ?? resolveModelHistoryContextWindow(options.contextWindow, options.engine)
    ?? 0;
  // Native finite-context engines rebuild history as one synthetic user message;
  // charge current user text by UTF-8 bytes and budget stored history at 4x worst case.
  const byteMultiplier = deps.usesNativeFiniteContextEngine(options.engine) ? 4 : 1;
  const remainingTokens = Math.floor(
    Math.max(
      0,
      contextWindow - modelHistoryReservedTokens(options.engine) -
        estimateModelHistoryUtf8Bytes(options.currentUserText ?? ""),
    ) / byteMultiplier,
  );
  const ctx: FiniteContextReader = {
    pool, sessionId, userId, options, deps,
    state: { remainingTokens, stopped: false, newestFirst: [] },
    processedCompleteTapes: new Set<string>(),
  };
  await processFiniteMessages(ctx, messages);
  await walkArchiveChunksForFiniteContext(ctx);
  return ctx.state.newestFirst.reverse();
}
