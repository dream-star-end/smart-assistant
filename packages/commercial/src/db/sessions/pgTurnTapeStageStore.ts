import type { Pool, PoolClient } from "pg";
import type {
  LosslessTurnTapeFinalizeRequest,
  LosslessTurnTapePartRequest,
} from "@openclaude/protocol";
import { computeSupersededApiErrorFlags } from "../pgTimelinePerf.js";
import type { PgSessionsCtx } from "./deps.js";
import {
  preparedModelSidecarsForOrdinal,
  sameLosslessTurnTapeHeader,
  verifyPreparedPartManifest,
  yieldLosslessTapeWork,
} from "./pgTurnTapePrepAndInspect.js";
import { bigIntNum, sha256Bytes, withTx } from "./sqlHelpers.js";
import type {
  LosslessTurnTapeHeaderRow,
  LosslessTurnTapeStageResult,
  PreparedLosslessTurnTape,
  PreparedModelSidecar,
  StagedRecordRow,
  UserVisiblePhysicalPayload,
} from "./types.js";

export const LOSSLESS_TURN_RECORD_STAGE_BATCH_SIZE = 128;
export const LOSSLESS_TURN_RECORD_STAGE_BATCH_BYTES = 512 * 1024;

let afterLosslessStageBatch: (() => Promise<void> | void) | null = null;
export function _setAfterLosslessStageBatch(hook: (() => Promise<void> | void) | null): void {
  afterLosslessStageBatch = hook;
}

let phaseASqlObserver: ((sql: string) => void) | null = null;
export function _setPhaseASqlObserver(observer: ((sql: string) => void) | null): void {
  phaseASqlObserver = observer;
}

export function getPhaseASqlObserver(): ((sql: string) => void) | null {
  return phaseASqlObserver;
}

export function _losslessTurnRecordStageBatches(
  recordCount: number,
  exactOrdinals: ReadonlySet<number>,
): number[][] {
  const pending = Array.from({ length: recordCount }, (_value, ordinal) => ordinal)
    .filter((ordinal) => !exactOrdinals.has(ordinal));
  const batches: number[][] = [];
  for (let start = 0; start < pending.length; start += LOSSLESS_TURN_RECORD_STAGE_BATCH_SIZE) {
    batches.push(pending.slice(start, start + LOSSLESS_TURN_RECORD_STAGE_BATCH_SIZE));
  }
  return batches;
}

export function _losslessTurnRecordWriteChunks(
  items: ReadonlyArray<{ ordinal: number; bytes: number }>,
  maxBytes: number = LOSSLESS_TURN_RECORD_STAGE_BATCH_BYTES,
): number[][] {
  const chunks: number[][] = [];
  let current: number[] = [];
  let currentBytes = 0;
  for (const item of items) {
    const size = Math.max(1, item.bytes);
    if (current.length > 0 && currentBytes + size > maxBytes) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(item.ordinal);
    currentBytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export function assertWrittenRecordMatches(
  written: StagedRecordRow,
  item: PreparedLosslessTurnTape["turn"]["records"][number],
  ordinal: number,
  visible: UserVisiblePhysicalPayload,
): void {
  if (
    written.msg_id !== item.id ||
    written.ordinal !== ordinal ||
    written.role !== item.role ||
    bigIntNum(written.ts, "written turn tape record ts") !== item.ts ||
    written.content_sha256 !== item.payloadSha256 ||
    !written.payload.equals(item.payloadBytes) ||
    written.visible_payload === null ||
    !written.visible_payload.equals(visible.bytes) ||
    written.visible_content_sha256 !== visible.contentSha256
  ) {
    throw new Error("lossless turn tape derived record write changed at database boundary");
  }
}

type StagedModelRow = {
  physical_ordinal: number;
  logical_ordinal: number;
  msg_id: string;
  role: string;
  semantic_text: string;
  token_estimate: number;
  ts: string | null;
  client_message_id: string | null;
};

type PendingRecordWrite = {
  ordinal: number;
  item: PreparedLosslessTurnTape["turn"]["records"][number];
  visible: UserVisiblePhysicalPayload;
  expectedModels: PreparedModelSidecar[];
  kind: "insert" | "rewrite" | "fill-visible";
};

function verifyWrittenChunkRows(
  written: ReadonlyArray<StagedRecordRow>,
  rows: ReadonlyArray<PendingRecordWrite>,
): void {
  const writtenById = new Map(written.map((row) => [row.msg_id, row]));
  if (writtenById.size !== rows.length) {
    throw new Error("lossless turn tape derived record write changed at database boundary");
  }
  for (const row of rows) {
    const got = writtenById.get(row.item.id);
    if (!got) throw new Error("lossless turn tape derived record write changed at database boundary");
    assertWrittenRecordMatches(got, row.item, row.ordinal, row.visible);
  }
}

function buildRecordWriteParams(
  request: LosslessTurnTapeFinalizeRequest,
  userId: string,
  rows: ReadonlyArray<PendingRecordWrite>,
  supersededFlags: ReadonlyArray<boolean>,
): unknown[] {
  return [
    request.sessionId, userId, request.tapeId,
    rows.map((r) => r.item.id), rows.map((r) => r.ordinal),
    rows.map((r) => r.item.role), rows.map((r) => r.item.ts),
    rows.map((r) => r.item.payloadSha256), rows.map((r) => r.item.payloadBytes),
    rows.map((r) => r.visible.bytes), rows.map((r) => r.visible.contentSha256),
    rows.map((r) => r.item.payloadBytes.length), rows.map((r) => r.visible.bytes.length),
    rows.map((r) => supersededFlags[r.ordinal] ?? false),
  ];
}

async function insertStagedRecordChunk(
  client: PoolClient,
  request: LosslessTurnTapeFinalizeRequest,
  userId: string,
  rows: ReadonlyArray<PendingRecordWrite>,
  supersededFlags: ReadonlyArray<boolean>,
): Promise<void> {
  await yieldLosslessTapeWork();
  const written = (
    await client.query<StagedRecordRow>(
      `INSERT INTO client_session_turn_tape_records
         (session_id,user_id,tape_id,msg_id,ordinal,role,ts,content_sha256,payload,
          visible_payload,visible_content_sha256,model_sidecar_complete,
          payload_bytes,visible_payload_bytes,is_superseded_api_error)
       SELECT $1,$2,$3,t.msg_id,t.ordinal,t.role,t.ts,t.content_sha256,t.payload,
              t.visible_payload,t.visible_content_sha256,FALSE,
              t.payload_bytes,t.visible_payload_bytes,t.is_superseded_api_error
         FROM unnest(
                $4::text[], $5::int[], $6::text[], $7::bigint[], $8::text[],
                $9::bytea[], $10::bytea[], $11::text[],
                $12::int[], $13::int[], $14::boolean[]
              ) AS t(msg_id,ordinal,role,ts,content_sha256,payload,
                     visible_payload,visible_content_sha256,
                     payload_bytes,visible_payload_bytes,is_superseded_api_error)
       RETURNING msg_id,ordinal,role,ts::text,content_sha256,payload,
                 visible_payload,visible_content_sha256,model_sidecar_complete`,
      buildRecordWriteParams(request, userId, rows, supersededFlags),
    )
  ).rows;
  verifyWrittenChunkRows(written, rows);
}

async function rewriteStagedRecordChunk(
  client: PoolClient,
  request: LosslessTurnTapeFinalizeRequest,
  userId: string,
  rows: ReadonlyArray<PendingRecordWrite>,
  supersededFlags: ReadonlyArray<boolean>,
): Promise<void> {
  await yieldLosslessTapeWork();
  const written = (
    await client.query<StagedRecordRow>(
      `UPDATE client_session_turn_tape_records AS r
          SET ordinal=t.ordinal, role=t.role, ts=t.ts, content_sha256=t.content_sha256,
              payload=t.payload, visible_payload=t.visible_payload,
              visible_content_sha256=t.visible_content_sha256,
              payload_bytes=t.payload_bytes, visible_payload_bytes=t.visible_payload_bytes,
              is_superseded_api_error=t.is_superseded_api_error,
              model_sidecar_complete=FALSE
         FROM unnest(
                $4::text[], $5::int[], $6::text[], $7::bigint[], $8::text[],
                $9::bytea[], $10::bytea[], $11::text[],
                $12::int[], $13::int[], $14::boolean[]
              ) AS t(msg_id,ordinal,role,ts,content_sha256,payload,
                     visible_payload,visible_content_sha256,
                     payload_bytes,visible_payload_bytes,is_superseded_api_error)
        WHERE r.session_id=$1 AND r.user_id=$2 AND r.tape_id=$3 AND r.msg_id=t.msg_id
        RETURNING r.msg_id,r.ordinal,r.role,r.ts::text,r.content_sha256,r.payload,
                  r.visible_payload,r.visible_content_sha256,r.model_sidecar_complete`,
      buildRecordWriteParams(request, userId, rows, supersededFlags),
    )
  ).rows;
  verifyWrittenChunkRows(written, rows);
}

async function fillVisibleRecordPayloads(
  client: PoolClient,
  request: LosslessTurnTapeFinalizeRequest,
  userId: string,
  fillVisible: ReadonlyArray<PendingRecordWrite>,
  supersededFlags: ReadonlyArray<boolean>,
): Promise<void> {
  if (fillVisible.length === 0) return;
  await client.query(
    `UPDATE client_session_turn_tape_records AS r
        SET visible_payload=COALESCE(r.visible_payload, t.visible_payload),
            visible_content_sha256=COALESCE(r.visible_content_sha256, t.visible_content_sha256),
            payload_bytes=COALESCE(r.payload_bytes, t.payload_bytes),
            visible_payload_bytes=COALESCE(r.visible_payload_bytes, t.visible_payload_bytes),
            is_superseded_api_error=COALESCE(r.is_superseded_api_error, t.is_superseded_api_error)
       FROM unnest($4::text[], $5::bytea[], $6::text[], $7::int[], $8::int[], $9::boolean[])
         AS t(msg_id, visible_payload, visible_content_sha256, payload_bytes, visible_payload_bytes, is_superseded_api_error)
      WHERE r.session_id=$1 AND r.user_id=$2 AND r.tape_id=$3 AND r.msg_id=t.msg_id`,
    [
      request.sessionId, userId, request.tapeId,
      fillVisible.map((r) => r.item.id), fillVisible.map((r) => r.visible.bytes),
      fillVisible.map((r) => r.visible.contentSha256),
      fillVisible.map((r) => r.item.payloadBytes.length), fillVisible.map((r) => r.visible.bytes.length),
      fillVisible.map((r) => supersededFlags[r.ordinal] ?? false),
    ],
  );
}

async function replaceBatchModelSidecars(
  client: PoolClient,
  request: LosslessTurnTapeFinalizeRequest,
  userId: string,
  sidecarList: number[],
  writeByOrdinal: ReadonlyMap<number, PendingRecordWrite>,
  prepared: PreparedLosslessTurnTape,
): Promise<void> {
  if (sidecarList.length === 0) return;
  await client.query(
    `UPDATE client_session_turn_tape_records SET model_sidecar_complete=FALSE
      WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND ordinal = ANY($4::int[])`,
    [request.sessionId, userId, request.tapeId, sidecarList],
  );
  await client.query(
    `DELETE FROM client_session_turn_tape_model_records
      WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND physical_ordinal = ANY($4::int[])`,
    [request.sessionId, userId, request.tapeId, sidecarList],
  );
  const modelInserts = sidecarList.flatMap((ordinal) =>
    writeByOrdinal.get(ordinal)?.expectedModels ?? preparedModelSidecarsForOrdinal(
      ordinal, prepared.turn.records[ordinal]!.id, prepared.visible[ordinal]!,
    ));
  if (modelInserts.length === 0) return;
  await client.query(
    `INSERT INTO client_session_turn_tape_model_records
       (session_id,user_id,tape_id,physical_ordinal,logical_ordinal,msg_id,role,
        semantic_text,token_estimate,ts,client_message_id)
     SELECT $1,$2,$3,t.physical_ordinal,t.logical_ordinal,t.msg_id,t.role,
            t.semantic_text,t.token_estimate,t.ts,t.client_message_id
       FROM unnest(
              $4::int[], $5::int[], $6::text[], $7::text[], $8::text[],
              $9::int[], $10::bigint[], $11::text[]
            ) AS t(physical_ordinal,logical_ordinal,msg_id,role,semantic_text,
                   token_estimate,ts,client_message_id)`,
    [
      request.sessionId, userId, request.tapeId,
      modelInserts.map((r) => r.physicalOrdinal), modelInserts.map((r) => r.logicalOrdinal),
      modelInserts.map((r) => r.msgId), modelInserts.map((r) => r.role),
      modelInserts.map((r) => r.semanticText), modelInserts.map((r) => r.tokenEstimate),
      modelInserts.map((r) => r.ts), modelInserts.map((r) => r.clientMessageId),
    ],
  );
}

async function loadBatchExistingState(
  client: PoolClient,
  request: LosslessTurnTapeFinalizeRequest,
  userId: string,
  batch: number[],
  prepared: PreparedLosslessTurnTape,
): Promise<{
  existingByOrdinal: Map<number, StagedRecordRow>;
  existingByMsgId: Map<string, StagedRecordRow>;
  modelsByOrdinal: Map<number, StagedModelRow[]>;
}> {
  const msgIds = batch.map((ordinal) => prepared.turn.records[ordinal]!.id);
  const identityRows = (
    await client.query<StagedRecordRow>(
      `SELECT msg_id,ordinal,role,ts::text,content_sha256,payload,
              visible_payload,visible_content_sha256,model_sidecar_complete
         FROM client_session_turn_tape_records
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
          AND (msg_id = ANY($4::text[]) OR ordinal = ANY($5::int[]))
        FOR UPDATE`,
      [request.sessionId, userId, request.tapeId, msgIds, batch],
    )
  ).rows;
  const existingByOrdinal = new Map<number, StagedRecordRow>();
  const existingByMsgId = new Map<string, StagedRecordRow>();
  for (const row of identityRows) {
    const priorOrdinal = existingByOrdinal.get(row.ordinal);
    const priorMsg = existingByMsgId.get(row.msg_id);
    if ((priorOrdinal !== undefined && priorOrdinal !== row) || (priorMsg !== undefined && priorMsg !== row)) {
      throw new Error("lossless turn tape immutable record identity conflict");
    }
    existingByOrdinal.set(row.ordinal, row);
    existingByMsgId.set(row.msg_id, row);
  }
  const modelRows = (
    await client.query<StagedModelRow>(
      `SELECT physical_ordinal,logical_ordinal,msg_id,role,semantic_text,
              token_estimate,ts::text,client_message_id
         FROM client_session_turn_tape_model_records
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
          AND physical_ordinal = ANY($4::int[])
        ORDER BY physical_ordinal, logical_ordinal`,
      [request.sessionId, userId, request.tapeId, batch],
    )
  ).rows;
  const modelsByOrdinal = new Map<number, StagedModelRow[]>();
  for (const row of modelRows) {
    const rows = modelsByOrdinal.get(row.physical_ordinal);
    if (rows) rows.push(row);
    else modelsByOrdinal.set(row.physical_ordinal, [row]);
  }
  return { existingByOrdinal, existingByMsgId, modelsByOrdinal };
}

function stagedModelRowsMatch(
  existingModels: ReadonlyArray<StagedModelRow>,
  expectedModels: ReadonlyArray<PreparedModelSidecar>,
): boolean {
  if (existingModels.length !== expectedModels.length) return false;
  return existingModels.every((actual, index) => {
    const expected = expectedModels[index]!;
    return actual.physical_ordinal === expected.physicalOrdinal &&
      actual.logical_ordinal === expected.logicalOrdinal &&
      actual.msg_id === expected.msgId &&
      actual.role === expected.role &&
      actual.semantic_text === expected.semanticText &&
      actual.token_estimate === expected.tokenEstimate &&
      (actual.ts === null ? null : bigIntNum(actual.ts, "model record ts")) === expected.ts &&
      actual.client_message_id === expected.clientMessageId;
  });
}

function existingRecordNeedsRewrite(
  existing: StagedRecordRow,
  item: PreparedLosslessTurnTape["turn"]["records"][number],
  visible: UserVisiblePhysicalPayload,
): boolean {
  const rawMatches = existing.role === item.role &&
    bigIntNum(existing.ts, "turn tape record ts") === item.ts &&
    existing.content_sha256 === item.payloadSha256 &&
    existing.payload.equals(item.payloadBytes);
  const visibleConflicts =
    (existing.visible_payload !== null && !existing.visible_payload.equals(visible.bytes)) ||
    (existing.visible_content_sha256 !== null &&
      existing.visible_content_sha256 !== visible.contentSha256);
  return !rawMatches || visibleConflicts;
}

function planBatchRecordWrites(
  batch: ReadonlyArray<number>,
  prepared: PreparedLosslessTurnTape,
  existingByOrdinal: ReadonlyMap<number, StagedRecordRow>,
  existingByMsgId: ReadonlyMap<string, StagedRecordRow>,
  modelsByOrdinal: ReadonlyMap<number, StagedModelRow[]>,
): { writes: PendingRecordWrite[]; sidecarOrdinals: Set<number>; wroteAgentGroup: boolean } {
  const writes: PendingRecordWrite[] = [];
  const sidecarOrdinals = new Set<number>();
  let wroteAgentGroup = false;
  for (const ordinal of batch) {
    const item = prepared.turn.records[ordinal]!;
    const visible = prepared.visible[ordinal]!;
    const expectedModels = preparedModelSidecarsForOrdinal(ordinal, item.id, visible);
    const byOrdinal = existingByOrdinal.get(ordinal);
    const byMsg = existingByMsgId.get(item.id);
    if (
      (byOrdinal !== undefined && byOrdinal.msg_id !== item.id) ||
      (byMsg !== undefined && byMsg.ordinal !== ordinal) ||
      (byOrdinal !== undefined && byMsg !== undefined && byOrdinal !== byMsg)
    ) {
      throw new Error("lossless turn tape immutable record identity conflict");
    }
    const existing = byOrdinal ?? byMsg;
    const rewriteRecord = existing === undefined || existingRecordNeedsRewrite(existing, item, visible);
    const modelSidecarsMatch = stagedModelRowsMatch(modelsByOrdinal.get(ordinal) ?? [], expectedModels);
    if (existing === undefined) {
      writes.push({ ordinal, item, visible, expectedModels, kind: "insert" });
      sidecarOrdinals.add(ordinal);
      if (item.role === "agent-group") wroteAgentGroup = true;
    } else if (rewriteRecord) {
      writes.push({ ordinal, item, visible, expectedModels, kind: "rewrite" });
      sidecarOrdinals.add(ordinal);
      if (item.role === "agent-group") wroteAgentGroup = true;
    } else if (existing.visible_payload === null || existing.visible_content_sha256 === null) {
      writes.push({ ordinal, item, visible, expectedModels, kind: "fill-visible" });
    }
    if (rewriteRecord || !modelSidecarsMatch) sidecarOrdinals.add(ordinal);
  }
  return { writes, sidecarOrdinals, wroteAgentGroup };
}

async function stageSingleBatchTx(
  client: PoolClient,
  userId: string,
  request: LosslessTurnTapeFinalizeRequest,
  prepared: PreparedLosslessTurnTape,
  batch: number[],
  supersededFlags: ReadonlyArray<boolean>,
): Promise<"staged" | "finalized" | "missing"> {
  const tape = (
    await client.query<LosslessTurnTapeHeaderRow>(
      `SELECT agent_id,turn_index,status,turn_key,tape_sha256,total_bytes,
              part_count,created_at,waive_reason,finalized_at,record_storage_format
         FROM client_session_turn_tapes
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 FOR UPDATE`,
      [request.sessionId, userId, request.tapeId],
    )
  ).rows[0];
  if (!tape) return "missing";
  if (!sameLosslessTurnTapeHeader(tape, request)) {
    throw new Error("lossless turn tape finalize header conflict");
  }
  if (tape.finalized_at !== null) return "finalized";
  await client.query("SET LOCAL statement_timeout = '120s'");
  if (tape.record_storage_format !== prepared.recordStorageFormat) {
    throw new Error("lossless turn tape materialization format changed during staging");
  }

  await yieldLosslessTapeWork();
  const existing = await loadBatchExistingState(client, request, userId, batch, prepared);
  const { writes, sidecarOrdinals, wroteAgentGroup } = planBatchRecordWrites(
    batch, prepared, existing.existingByOrdinal, existing.existingByMsgId, existing.modelsByOrdinal,
  );
  const writeByOrdinal = new Map(writes.map((row) => [row.ordinal, row]));
  const toChunkInput = (kind: "insert" | "rewrite") =>
    writes.filter((row) => row.kind === kind).map((row) => ({
      ordinal: row.ordinal,
      bytes: row.item.payloadBytes.length + row.visible.bytes.length,
    }));
  for (const chunk of _losslessTurnRecordWriteChunks(toChunkInput("insert"))) {
    const rows = chunk.map((ordinal) => writeByOrdinal.get(ordinal)!);
    await insertStagedRecordChunk(client, request, userId, rows, supersededFlags);
  }
  for (const chunk of _losslessTurnRecordWriteChunks(toChunkInput("rewrite"))) {
    const rows = chunk.map((ordinal) => writeByOrdinal.get(ordinal)!);
    await rewriteStagedRecordChunk(client, request, userId, rows, supersededFlags);
  }
  await fillVisibleRecordPayloads(
    client, request, userId, writes.filter((row) => row.kind === "fill-visible"), supersededFlags,
  );
  await replaceBatchModelSidecars(
    client, request, userId, [...sidecarOrdinals].sort((a, b) => a - b), writeByOrdinal, prepared,
  );
  if (wroteAgentGroup) {
    const partState = await verifyPreparedPartManifest(client, userId, request, prepared.partManifest);
    if (partState !== "complete") {
      throw new Error("lossless turn tape source parts changed during record staging");
    }
  }
  await client.query(
    `UPDATE client_session_turn_tape_records SET model_sidecar_complete=TRUE
      WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND ordinal = ANY($4::int[])`,
    [request.sessionId, userId, request.tapeId, batch],
  );
  return "staged";
}

export async function _stagePreparedLosslessTurnRecords(
  pool: Pool,
  userId: string,
  request: LosslessTurnTapeFinalizeRequest,
  prepared: PreparedLosslessTurnTape,
): Promise<void> {
  const exactOrdinals = await readExactPreparedLosslessTurnOrdinals(pool, userId, request, prepared);
  const allSidecars = prepared.turn.records.map((rec, ordinal) =>
    preparedModelSidecarsForOrdinal(ordinal, rec.id, prepared.visible[ordinal]!));
  const supersededFlags = computeSupersededApiErrorFlags(prepared.turn.records, allSidecars);
  for (const batch of _losslessTurnRecordStageBatches(prepared.turn.records.length, exactOrdinals)) {
    const staged = await withTx(pool, (client) =>
      stageSingleBatchTx(client, userId, request, prepared, batch, supersededFlags));
    if (staged !== "staged") return;
    if (afterLosslessStageBatch) await afterLosslessStageBatch();
  }
}

type RecordSummaryRow = {
  msg_id: string;
  ordinal: number;
  role: string;
  ts: string;
  content_sha256: string;
  payload_sha256: string;
  visible_content_sha256: string | null;
  visible_payload_sha256: string | null;
  model_sidecar_complete: boolean;
};

type ModelSummaryRow = {
  physical_ordinal: number;
  logical_ordinal: number;
  msg_id: string;
  role: string;
  semantic_text_sha256: string;
  token_estimate: number;
  ts: string | null;
  client_message_id: string | null;
};

function recordSummaryMatchesPrepared(
  record: RecordSummaryRow | undefined,
  item: PreparedLosslessTurnTape["turn"]["records"][number],
  visible: UserVisiblePhysicalPayload,
): boolean {
  return !!record &&
    record.msg_id === item.id &&
    record.role === item.role &&
    bigIntNum(record.ts, "summarized turn tape record ts") === item.ts &&
    record.content_sha256 === item.payloadSha256 &&
    record.payload_sha256 === item.payloadSha256 &&
    record.visible_content_sha256 === visible.contentSha256 &&
    record.visible_payload_sha256 === visible.contentSha256 &&
    record.model_sidecar_complete === true;
}

function modelSummaryRowsMatchExpected(
  actualModels: ReadonlyArray<ModelSummaryRow>,
  expectedModels: ReadonlyArray<PreparedModelSidecar>,
): boolean {
  if (actualModels.length !== expectedModels.length) return false;
  return actualModels.every((actual, index) => {
    const expected = expectedModels[index]!;
    return actual.physical_ordinal === expected.physicalOrdinal &&
      actual.logical_ordinal === expected.logicalOrdinal &&
      actual.msg_id === expected.msgId &&
      actual.role === expected.role &&
      actual.semantic_text_sha256 === sha256Bytes(Buffer.from(expected.semanticText, "utf8")) &&
      actual.token_estimate === expected.tokenEstimate &&
      (actual.ts === null ? null : bigIntNum(actual.ts, "summarized model record ts")) === expected.ts &&
      actual.client_message_id === expected.clientMessageId;
  });
}

export async function readExactPreparedLosslessTurnOrdinals(
  pool: Pool,
  userId: string,
  request: LosslessTurnTapeFinalizeRequest,
  prepared: PreparedLosslessTurnTape,
): Promise<Set<number>> {
  const records = (
    await pool.query<RecordSummaryRow>(
      `SELECT msg_id,ordinal,role,ts::text,content_sha256,
              encode(public.digest(payload,'sha256'),'hex') AS payload_sha256,
              visible_content_sha256,
              CASE WHEN visible_payload IS NULL THEN NULL
                   ELSE encode(public.digest(visible_payload,'sha256'),'hex') END
                AS visible_payload_sha256,
              model_sidecar_complete
         FROM client_session_turn_tape_records
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
        ORDER BY ordinal`,
      [request.sessionId, userId, request.tapeId],
    )
  ).rows;
  const modelRows = (
    await pool.query<ModelSummaryRow>(
      `SELECT physical_ordinal,logical_ordinal,msg_id,role,
              encode(public.digest(convert_to(semantic_text,'UTF8'),'sha256'),'hex')
                AS semantic_text_sha256,
              token_estimate,ts::text,client_message_id
         FROM client_session_turn_tape_model_records
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
        ORDER BY physical_ordinal,logical_ordinal`,
      [request.sessionId, userId, request.tapeId],
    )
  ).rows;

  const recordsByOrdinal = new Map(records.map((row) => [row.ordinal, row]));
  const modelsByOrdinal = new Map<number, ModelSummaryRow[]>();
  for (const row of modelRows) {
    const rows = modelsByOrdinal.get(row.physical_ordinal);
    if (rows) rows.push(row);
    else modelsByOrdinal.set(row.physical_ordinal, [row]);
  }

  const exact = new Set<number>();
  for (let ordinal = 0; ordinal < prepared.turn.records.length; ordinal++) {
    await yieldLosslessTapeWork();
    const item = prepared.turn.records[ordinal]!;
    const visible = prepared.visible[ordinal]!;
    if (!recordSummaryMatchesPrepared(recordsByOrdinal.get(ordinal), item, visible)) continue;
    const expectedModels = preparedModelSidecarsForOrdinal(ordinal, item.id, visible);
    if (!modelSummaryRowsMatchExpected(modelsByOrdinal.get(ordinal) ?? [], expectedModels)) continue;
    exact.add(ordinal);
  }
  return exact;
}

type StageTapeHeaderRow = {
  agent_id: string;
  turn_index: number;
  status: string;
  turn_key: string;
  tape_sha256: string;
  total_bytes: string;
  part_count: number;
  created_at: string;
  waive_reason: string | null;
  finalized_at: string | null;
  dispatch_id: string | null;
  attempt_no: number | null;
};

function sameStageTapeHeader(
  existingTape: StageTapeHeaderRow,
  request: LosslessTurnTapePartRequest,
  dispatchIdentity?: { dispatchId: string; attemptNo: number },
): boolean {
  return existingTape.agent_id === request.agentId &&
    existingTape.turn_index === request.turnIndex &&
    existingTape.status === request.status &&
    existingTape.turn_key === request.turnKey &&
    existingTape.tape_sha256 === request.tapeSha256 &&
    bigIntNum(existingTape.total_bytes, "turn_tape.total_bytes") === request.totalBytes &&
    existingTape.part_count === request.partCount &&
    bigIntNum(existingTape.created_at, "turn_tape.created_at") === request.createdAt &&
    existingTape.waive_reason === (request.waiveReason ?? null) &&
    existingTape.dispatch_id === (dispatchIdentity?.dispatchId ?? null) &&
    existingTape.attempt_no === (dispatchIdentity?.attemptNo ?? null);
}

async function ensureStageTapeHeader(
  client: PoolClient,
  userId: string,
  request: LosslessTurnTapePartRequest,
  dispatchIdentity?: { dispatchId: string; attemptNo: number },
): Promise<"ready" | "idempotent"> {
  const existingTape = (
    await client.query<StageTapeHeaderRow>(
      `SELECT agent_id, turn_index, status, turn_key, tape_sha256,
              total_bytes, part_count, created_at, waive_reason, finalized_at,
              dispatch_id, attempt_no
         FROM client_session_turn_tapes
        WHERE session_id = $1 AND user_id = $2 AND tape_id = $3 FOR UPDATE`,
      [request.sessionId, userId, request.tapeId],
    )
  ).rows[0];
  if (existingTape) {
    if (!sameStageTapeHeader(existingTape, request, dispatchIdentity)) {
      throw new Error("lossless turn tape immutable header conflict");
    }
    return existingTape.finalized_at !== null ? "idempotent" : "ready";
  }
  await client.query(
    `INSERT INTO client_session_turn_tapes
       (session_id, user_id, tape_id, agent_id, turn_index, status,
        turn_key, tape_sha256, total_bytes, part_count, created_at, waive_reason,
        dispatch_id, attempt_no)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      request.sessionId, userId, request.tapeId, request.agentId, request.turnIndex,
      request.status, request.turnKey, request.tapeSha256, request.totalBytes,
      request.partCount, request.createdAt, request.waiveReason ?? null,
      dispatchIdentity?.dispatchId ?? null, dispatchIdentity?.attemptNo ?? null,
    ],
  );
  return "ready";
}

async function stageLosslessTurnTapePartTx(
  client: PoolClient,
  userId: string,
  request: LosslessTurnTapePartRequest,
  payload: Buffer,
  dispatchIdentity?: { dispatchId: string; attemptNo: number },
): Promise<LosslessTurnTapeStageResult> {
  const session = (
    await client.query<{ deleted_at: string | null }>(
      "SELECT deleted_at FROM client_sessions WHERE id = $1 AND user_id = $2",
      [request.sessionId, userId],
    )
  ).rows[0];
  if (!session) return { applied: "session_not_found" };
  if (session.deleted_at !== null) return { applied: "session_deleted" };

  const headerState = await ensureStageTapeHeader(client, userId, request, dispatchIdentity);
  if (headerState === "idempotent") return { applied: "idempotent" };

  const existingPart = (
    await client.query<{ part_sha256: string; payload: Buffer }>(
      `SELECT part_sha256, payload FROM client_session_turn_tape_parts
        WHERE session_id = $1 AND user_id = $2 AND tape_id = $3 AND part_index = $4 FOR UPDATE`,
      [request.sessionId, userId, request.tapeId, request.partIndex],
    )
  ).rows[0];
  if (existingPart) {
    const same =
      existingPart.part_sha256 === request.partSha256 &&
      Buffer.from(existingPart.payload).equals(payload);
    if (!same) throw new Error("lossless turn tape immutable part conflict");
    return { applied: "idempotent" };
  }
  await client.query(
    `INSERT INTO client_session_turn_tape_parts
       (session_id, user_id, tape_id, part_index, part_sha256, payload, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [request.sessionId, userId, request.tapeId, request.partIndex, request.partSha256, payload, Date.now()],
  );
  return { applied: "stored" };
}

export function createPgTurnTapeStageStore(ctx: PgSessionsCtx): {
  stageLosslessTurnTapePart(
    userId: string,
    request: LosslessTurnTapePartRequest,
    payload: Buffer,
    dispatchIdentity?: { dispatchId: string; attemptNo: number },
  ): Promise<LosslessTurnTapeStageResult>;
} {
  return {
    async stageLosslessTurnTapePart(userId, request, payload, dispatchIdentity) {
      return withTx(ctx.pool, (client) =>
        stageLosslessTurnTapePartTx(client, userId, request, payload, dispatchIdentity));
    },
  };
}
