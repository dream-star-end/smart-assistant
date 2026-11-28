import type { Pool, PoolClient } from "pg";
import {
  losslessBillingAnchorId,
  type DurableCodexBilling,
  type LosslessTurnTapeFinalizeRequest,
  type LosslessTurnTapeVisibleRequest,
} from "@openclaude/protocol";
import type { MessageLike } from "@openclaude/storage";
import type { LosslessTurnRecord } from "../../http/losslessTurnTape.js";
import { computeSessionLastPreviewRaw } from "../pgTimelinePerf.js";
import { enqueueMaterializationJob, enqueueSettlementJob } from "../turnTapeJobs.js";
import {
  clipVisibleText,
  phaseAVisibleHeadText,
  settlementAuthorityHash,
  settlementEngineBillings,
  visibleHeadFallback,
  visibleHeadFromSettlement,
  type VisibleHead,
} from "../visibleFinalize.js";
import { execPgSpillPlan } from "./appendCore.js";
import type { PgSessionsCtx, PgSessionsDeps } from "./deps.js";
import { tapeAnchor } from "./pgTapeUsageAndRecordHydrate.js";
import {
  readTurnTapeRecoveryLink,
  sameLosslessTurnTapeHeader,
} from "./pgTurnTapePrepAndInspect.js";
import { getPhaseASqlObserver } from "./pgTurnTapeStageStore.js";
import {
  CLOCK_MS_SQL,
  bigIntNumOr,
  convergeDispatchOnFinalize,
  errorCodeFromVisibleHead,
  escapeNulInSessionMessagesJson,
  pgModelSidecarText,
  withTx,
} from "./sqlHelpers.js";
import type {
  LosslessTurnTapeFinalizeResult,
  PreparedLosslessTurnTape,
  SessionWriteRow,
} from "./types.js";

const PHASE_A_LIVE_FRAME_LIMIT = 16;
const PHASE_A_LIVE_FRAME_MAX_BYTES = 64 * 1024;

const UPDATE_SESSION_PHASE_A_SQL = `UPDATE client_sessions SET
   messages=$1, message_count=$2, last_at=$3,
   updated_at=GREATEST(updated_at + 1, ${CLOCK_MS_SQL}),
   next_seq=$4, archived_through_seq=$5, archived_count=$6,
   history_revision=history_revision + 1,
   timeline_generation=timeline_generation + 1,
   last_preview=$9
 WHERE id=$7 AND user_id=$8 AND deleted_at IS NULL`;

function extractTextFromLiveFrame(payload: Buffer, chunks: string[]): void {
  try {
    const parsed = JSON.parse(payload.toString("utf8")) as {
      type?: string;
      blocks?: Array<{ kind?: string; text?: string }>;
      text?: string;
    };
    if (parsed.type && parsed.type !== "outbound.message") return;
    if (typeof parsed.text === "string" && parsed.text) chunks.push(parsed.text);
    for (const block of parsed.blocks ?? []) {
      if (block.kind === "text" && typeof block.text === "string") chunks.push(block.text);
    }
  } catch (err) {
    // ignore malformed frame
    void err;
  }
}

async function readBoundedLiveFrameText(
  queryable: Pool | PoolClient,
  dispatchId: string | null,
): Promise<string> {
  if (!dispatchId) return "";
  try {
    const frames = await queryable.query<{ payload: Buffer }>(
      `SELECT payload FROM (
         SELECT f.payload, f.created_at
           FROM client_session_live_streams s
           JOIN client_session_live_frames f ON f.stream_key=s.stream_key
          WHERE s.dispatch_id=$1::uuid
            AND octet_length(f.payload) <= $2
          ORDER BY f.created_at DESC
          LIMIT $3
       ) q ORDER BY created_at ASC`,
      [dispatchId, PHASE_A_LIVE_FRAME_MAX_BYTES, PHASE_A_LIVE_FRAME_LIMIT],
    );
    const chunks: string[] = [];
    for (const row of frames.rows) {
      extractTextFromLiveFrame(row.payload, chunks);
    }
    return chunks.join("");
  } catch (err) {
    void err;
    return "";
  }
}

function recoveredAssistantTextFromPrepared(prepared: PreparedLosslessTurnTape): string {
  for (let i = prepared.turn.records.length - 1; i >= 0; i--) {
    const rec = prepared.turn.records[i]!;
    if (rec.role !== "assistant") continue;
    const text = typeof rec.payload.text === "string" ? rec.payload.text : "";
    if (text.trim().length === 0) continue;
    const errorCode = typeof rec.payload._errorCode === "string" ? rec.payload._errorCode : "";
    if (rec.payload._isError === true && (text === errorCode || text === "USER_CANCELLED")) {
      continue;
    }
    return text;
  }
  return "";
}

export async function backfillEmptyVisibleHeadFromPrepared(
  pool: Pool,
  userId: string,
  request: LosslessTurnTapeFinalizeRequest,
  prepared: PreparedLosslessTurnTape,
): Promise<void> {
  const recovered = recoveredAssistantTextFromPrepared(prepared);
  if (recovered.length === 0) return;
  const current = (
    await pool.query<{ visible_head: VisibleHead | null }>(
      `SELECT visible_head
         FROM client_session_turn_tapes
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3`,
      [request.sessionId, userId, request.tapeId],
    )
  ).rows[0]?.visible_head;
  const existingText = typeof current?.text === "string" ? current.text : "";
  if (existingText.length > 0) return;
  const clipped = clipVisibleText(recovered);
  const next: VisibleHead = {
    role: "assistant",
    text: pgModelSidecarText(clipped.text),
    ts: typeof current?.ts === "number" ? current.ts : request.createdAt,
    messageId: typeof current?.messageId === "string" && current.messageId.length > 0
      ? current.messageId
      : prepared.turn.billingAnchorId,
    ...(current?.clientMessageId ? { clientMessageId: current.clientMessageId } : {}),
    ...(current?.errorCode !== undefined ? { errorCode: current.errorCode } : {}),
    ...(current?.truncated || clipped.truncated ? { truncated: true } : {}),
    partial: true,
  };
  // read-then-write 竞态守卫:SELECT 后并发 Phase A 可能已写入(空文本 +)errorCode,
  // 本次 UPDATE 携带的是 SELECT 快照里的 errorCode,盲写会把并发写入的 errorCode 冲掉。
  // WHERE 再校验 errorCode 未变;变了就放弃 backfill(该头已有更权威的写者)。
  const snapshotErrorCode = typeof current?.errorCode === "string" ? current.errorCode : "";
  await pool.query(
    `UPDATE client_session_turn_tapes
        SET visible_head=$4::jsonb
      WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
        AND COALESCE(visible_head->>'text', '') = ''
        AND COALESCE(visible_head->>'errorCode', '') = $5`,
    [request.sessionId, userId, request.tapeId, JSON.stringify(next), snapshotErrorCode],
  );
}

type PhaseATapeRow = {
  agent_id: string;
  turn_index: number;
  status: string;
  turn_key: string;
  tape_sha256: string;
  total_bytes: string;
  part_count: number;
  created_at: string;
  waive_reason: string | null;
  visible_at: string | null;
  finalized_at: string | null;
  engine_billings: unknown;
  billing_anchor_id: string | null;
  settlement_hash: string | null;
  dispatch_id: string | null;
  attempt_no: number | null;
  visible_head: unknown;
};

type PhaseASettlementCtx = {
  engineBillings: DurableCodexBilling[];
  billingAnchorId: string;
  incomingHash: string | null;
};

function wrapPhaseAClient(rawClient: PoolClient): PoolClient {
  return new Proxy<PoolClient>(rawClient, {
    get(target, prop, receiver) {
      if (prop === "query") {
        return (sql: unknown, ...rest: unknown[]) => {
          if (typeof sql === "string") getPhaseASqlObserver()?.(sql);
          return target.query(sql as never, ...(rest as never[]));
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

async function ensureAndLoadPhaseATape(
  client: PoolClient,
  userId: string,
  request: LosslessTurnTapeFinalizeRequest | LosslessTurnTapeVisibleRequest,
): Promise<PhaseATapeRow | null> {
  if ((request.dispatchId === undefined) !== (request.attemptNo === undefined)) {
    throw new Error("lossless turn tape dispatch identity is incomplete");
  }
  // A small visibility header is durable before the first multipart part.
  // ON CONFLICT is followed by a full immutable-header comparison below.
  await client.query(
    `INSERT INTO client_session_turn_tapes
       (session_id,user_id,tape_id,agent_id,turn_index,status,turn_key,tape_sha256,
        total_bytes,part_count,created_at,waive_reason,dispatch_id,attempt_no)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (session_id,user_id,tape_id) DO NOTHING`,
    [
      request.sessionId,
      userId,
      request.tapeId,
      request.agentId,
      request.turnIndex,
      request.status,
      request.turnKey,
      request.tapeSha256,
      request.totalBytes,
      request.partCount,
      request.createdAt,
      request.waiveReason ?? null,
      request.dispatchId ?? null,
      request.attemptNo ?? null,
    ],
  );
  const tape = (
    await client.query<PhaseATapeRow>(
      `SELECT agent_id,turn_index,status,turn_key,tape_sha256,total_bytes,part_count,created_at,
              waive_reason,visible_at::text,finalized_at::text,engine_billings,billing_anchor_id,
              settlement_hash,dispatch_id,attempt_no,visible_head
         FROM client_session_turn_tapes
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
        FOR UPDATE`,
      [request.sessionId, userId, request.tapeId],
    )
  ).rows[0];
  if (!tape) return null;
  if (!sameLosslessTurnTapeHeader(tape, request)) {
    throw new Error("lossless turn tape finalize header conflict");
  }
  if (
    request.dispatchId !== undefined && (
      tape.dispatch_id !== request.dispatchId || tape.attempt_no !== request.attemptNo
    )
  ) {
    throw new Error("lossless turn tape dispatch identity conflict");
  }
  return tape;
}

function resolvePhaseASettlementContext(
  tape: PhaseATapeRow,
  request: LosslessTurnTapeFinalizeRequest | LosslessTurnTapeVisibleRequest,
): PhaseASettlementCtx {
  const settlement = request.settlement;
  const engineBillings = settlement
    ? settlementEngineBillings(settlement)
    : (Array.isArray(tape.engine_billings)
      ? structuredClone(tape.engine_billings) as DurableCodexBilling[]
      : []);
  const billingAnchorId = settlement?.billingAnchorId
    ?? tape.billing_anchor_id
    ?? losslessBillingAnchorId({
      sessionId: request.sessionId,
      agentId: request.agentId,
      turnIndex: request.turnIndex,
      text: settlement?.text,
      errorCode: settlement?.errorCode,
    });
  const incomingHash = settlement
    ? settlementAuthorityHash({
        billingAnchorId,
        requestId: settlement.requestId,
        engineBillings,
      })
    : tape.settlement_hash;
  if (tape.settlement_hash && incomingHash && tape.settlement_hash !== incomingHash) {
    throw new Error("lossless turn tape settlement conflict");
  }
  return { engineBillings, billingAnchorId, incomingHash };
}

async function loadPhaseADispatchMeta(
  client: PoolClient,
  dispatchId: string | null,
): Promise<{ clientMessageId: string | null; fenced: Date | null }> {
  if (dispatchId === null) return { clientMessageId: null, fenced: null };
  const clientMessageId = (
    await client.query<{ client_message_id: string }>(
      "SELECT client_message_id FROM turn_dispatches WHERE dispatch_id=$1",
      [dispatchId],
    )
  ).rows[0]?.client_message_id ?? null;
  const fenced = (
    await client.query<{ producer_fenced_at: Date | null }>(
      "SELECT producer_fenced_at FROM turn_dispatches WHERE dispatch_id=$1::uuid",
      [dispatchId],
    )
  ).rows[0]?.producer_fenced_at ?? null;
  return { clientMessageId, fenced };
}

async function handleAlreadyVisiblePhaseA(
  client: PoolClient,
  userId: string,
  request: LosslessTurnTapeFinalizeRequest | LosslessTurnTapeVisibleRequest,
  tape: PhaseATapeRow,
  engineBillings: DurableCodexBilling[],
  billingUserId: bigint | null,
  clientMessageId: string | null,
  deps: PgSessionsDeps,
  options: { enqueueMaterialization?: boolean },
): Promise<LosslessTurnTapeFinalizeResult> {
  if (request.waiveReason !== undefined && billingUserId !== null) {
    await deps.billing.ensurePendingTurnWaiverInTransaction(client, {
      userId: billingUserId,
      turnKey: request.turnKey,
      reason: request.waiveReason,
    });
  }
  let replayLate = false;
  if (tape.dispatch_id !== null) {
    const convergence = await convergeDispatchOnFinalize(
      client,
      tape.dispatch_id,
      tape.status,
      deps,
      request.settlement?.errorCode ?? errorCodeFromVisibleHead(tape.visible_head),
    );
    replayLate = convergence.lateTape;
  }
  if (options.enqueueMaterialization !== false && tape.finalized_at === null) {
    await enqueueMaterializationJob(client, {
      sessionId: request.sessionId,
      userId,
      tapeId: request.tapeId,
      dispatchId: tape.dispatch_id,
    });
  }
  return {
    applied: tape.finalized_at !== null ? "idempotent" : "finalized",
    recordCount: 0,
    engineBillings,
    settlementHandoff: true,
    ...(clientMessageId ? { clientMessageId } : {}),
    ...(replayLate ? { dispatchLateTape: true, settlementHeld: true } : {}),
  };
}

async function buildPhaseAVisibleHead(
  client: PoolClient,
  request: LosslessTurnTapeFinalizeRequest | LosslessTurnTapeVisibleRequest,
  tape: PhaseATapeRow,
  engineBillings: DurableCodexBilling[],
  clientMessageId: string | null,
): Promise<{ head: VisibleHead; visibleUsage: { traceId: string } | null }> {
  const settlement = request.settlement;
  const settlementText = settlement?.text ?? "";
  const liveFrameText = settlementText.length > 0
    ? ""
    : await readBoundedLiveFrameText(client, tape.dispatch_id);
  const visibleText = phaseAVisibleHeadText({
    hasSettlement: Boolean(settlement) && settlementText.length > 0,
    settlementText,
    liveFrameText,
  });
  const head = settlement
    ? visibleHeadFromSettlement(request, {
        ...settlement,
        text: settlementText.length > 0 ? settlementText : visibleText,
      }, clientMessageId)
    : visibleHeadFallback(request, visibleText, clientMessageId);
  if (settlement && settlementText.length === 0 && visibleText.length > 0) {
    head.partial = true;
  }
  const visibleRequestId = settlement?.requestId
    ?? (engineBillings[0] && typeof engineBillings[0].requestId === "string"
      ? engineBillings[0].requestId
      : undefined);
  return {
    head,
    visibleUsage: visibleRequestId ? { traceId: visibleRequestId } : null,
  };
}

function parseSessionMessagesStrict(raw: string): MessageLike[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("not array");
    return parsed as MessageLike[];
  } catch (err) {
    void err;
    throw new Error("lossless turn tape target session row malformed");
  }
}

async function appendPhaseAVisibleAnchor(
  client: PoolClient,
  userId: string,
  request: LosslessTurnTapeFinalizeRequest | LosslessTurnTapeVisibleRequest,
  session: SessionWriteRow,
  billingAnchorId: string,
  head: VisibleHead,
  visibleUsage: { traceId: string } | null,
  deps: PgSessionsDeps,
): Promise<void> {
  let existingMessages = parseSessionMessagesStrict(session.messages);
  const conflictingAnchor = existingMessages.find(
    (message) =>
      message?.id === billingAnchorId &&
      typeof message._turnTapeId === "string" &&
      message._turnTapeId !== request.tapeId,
  );
  let anchors: (MessageLike & { id: string })[];
  if (conflictingAnchor) {
    // A content-only recovery deliberately reuses the crashed source billing
    // anchor. Phase A must not delete that source before Phase B verifies the
    // recovery link and transfers its billing ownership atomically.
    const recoveryLink = await readTurnTapeRecoveryLink(
      client,
      request.sessionId,
      userId,
      request.tapeId,
      true,
    );
    if (!recoveryLink || recoveryLink.source_tape_id !== conflictingAnchor._turnTapeId) {
      throw new Error("lossless turn tape visible anchor is owned by another tape");
    }
    anchors = [];
  } else {
    const stubRecord: LosslessTurnRecord = {
      id: billingAnchorId,
      role: "assistant",
      ts: head.ts,
      payload: { id: billingAnchorId, role: "assistant", ts: head.ts, text: head.text },
      payloadBytes: Buffer.alloc(0),
      payloadSha256: "",
    };
    anchors = [{
      ...tapeAnchor(stubRecord, request.tapeId, request.tapeSha256, 1, 1, undefined, []),
      text: head.text,
      ...(visibleUsage ? { usage: visibleUsage } : {}),
    }];
    const recordIds = new Set([billingAnchorId]);
    existingMessages = existingMessages.filter(
      (message) => typeof message?.id !== "string" || !recordIds.has(message.id),
    );
  }
  const plan = deps.storage.planAppendServerAuthoredBatch(
    existingMessages,
    anchors,
    typeof session.next_seq === "number" && session.next_seq > 0 ? session.next_seq : 1,
    bigIntNumOr(session.archived_through_seq, 0),
  );
  if (plan.kind !== "write") return;
  const nowMs = Date.now();
  const archivedDelta = await execPgSpillPlan(
    client,
    request.sessionId,
    userId,
    plan.chunksToInsert,
    plan.idsToInsert,
    nowMs,
  );
  const archivedCount = bigIntNumOr(session.archived_count, 0) + archivedDelta;
  await client.query(UPDATE_SESSION_PHASE_A_SQL, [
    escapeNulInSessionMessagesJson(plan.finalJson),
    plan.tail.length + archivedCount,
    nowMs,
    plan.nextSeq,
    plan.archivedThroughSeq,
    archivedCount,
    request.sessionId,
    userId,
    computeSessionLastPreviewRaw(plan.tail),
  ]);
}

async function enqueuePhaseAJobsAndConverge(
  client: PoolClient,
  userId: string,
  request: LosslessTurnTapeFinalizeRequest | LosslessTurnTapeVisibleRequest,
  tape: PhaseATapeRow,
  settlementCtx: PhaseASettlementCtx,
  head: VisibleHead,
  billingUserId: bigint | null,
  fenced: Date | null,
  deps: PgSessionsDeps,
  options: { enqueueMaterialization?: boolean },
): Promise<boolean> {
  if (options.enqueueMaterialization !== false) {
    await enqueueMaterializationJob(client, {
      sessionId: request.sessionId,
      userId,
      tapeId: request.tapeId,
      dispatchId: tape.dispatch_id,
    });
  }
  const holdReason = fenced ? "late_tape_after_fence" : "awaiting_materialization";
  if (settlementCtx.engineBillings.length > 0) {
    await enqueueSettlementJob(client, {
      sessionId: request.sessionId,
      userId,
      tapeId: request.tapeId,
      dispatchId: tape.dispatch_id,
      kind: "billing",
      payload: { engineBillings: settlementCtx.engineBillings },
      billingAnchorId: settlementCtx.billingAnchorId,
      requestId: request.settlement?.requestId ?? settlementCtx.engineBillings[0]?.requestId,
      settlementHash: settlementCtx.incomingHash,
      held: true,
      holdReason,
    });
  }
  if (request.waiveReason !== undefined && billingUserId !== null) {
    await deps.billing.ensurePendingTurnWaiverInTransaction(client, {
      userId: billingUserId,
      turnKey: request.turnKey,
      reason: request.waiveReason,
    });
    await enqueueSettlementJob(client, {
      sessionId: request.sessionId,
      userId,
      tapeId: request.tapeId,
      dispatchId: tape.dispatch_id,
      kind: "waiver",
      payload: { reason: request.waiveReason, turnKey: request.turnKey },
      billingAnchorId: settlementCtx.billingAnchorId,
      settlementHash: settlementCtx.incomingHash,
      held: true,
      holdReason,
    });
  }
  if (tape.dispatch_id === null) return false;
  const convergence = await convergeDispatchOnFinalize(
    client,
    tape.dispatch_id,
    tape.status,
    deps,
    request.settlement?.errorCode ?? head.errorCode,
  );
  return convergence.lateTape;
}

async function persistPhaseATapeVisibility(
  client: PoolClient,
  userId: string,
  request: LosslessTurnTapeFinalizeRequest | LosslessTurnTapeVisibleRequest,
  settlementCtx: PhaseASettlementCtx,
  head: VisibleHead,
  clientMessageId: string | null,
  visibleUsage: { traceId: string } | null,
): Promise<void> {
  await client.query(
    `UPDATE client_session_turn_tapes
        SET visible_at=$1, visible_head=$2::jsonb,
            billing_anchor_id=COALESCE(billing_anchor_id,$3),
            engine_billings=CASE WHEN $4::jsonb <> '[]'::jsonb THEN $4::jsonb ELSE engine_billings END,
            settlement_hash=COALESCE(settlement_hash,$6),
            client_message_id=COALESCE(client_message_id,$5),
            usage=CASE
              WHEN $10::jsonb IS NULL THEN usage
              WHEN usage IS NULL OR usage = '{}'::jsonb THEN $10::jsonb
              ELSE usage
            END
      WHERE session_id=$7 AND user_id=$8 AND tape_id=$9`,
    [
      Date.now(), JSON.stringify(head), settlementCtx.billingAnchorId,
      JSON.stringify(settlementCtx.engineBillings), clientMessageId, settlementCtx.incomingHash,
      request.sessionId, userId, request.tapeId, visibleUsage ? JSON.stringify(visibleUsage) : null,
    ],
  );
}

async function runPhaseATx(
  rawClient: PoolClient,
  userId: string,
  request: LosslessTurnTapeFinalizeRequest | LosslessTurnTapeVisibleRequest,
  billingUserId: bigint | null,
  deps: PgSessionsDeps,
  options: { enqueueMaterialization?: boolean },
): Promise<LosslessTurnTapeFinalizeResult> {
  const client = wrapPhaseAClient(rawClient);
  await deps.billing.lockTurnPersistenceKeys(client, userId, [request.turnKey]);
  if (billingUserId !== null) {
    await deps.billing.lockTurnBillingKeys(client, billingUserId, [request.turnKey]);
  }
  const session = (
    await client.query<SessionWriteRow>(
      `SELECT messages, next_seq, deleted_at, archived_through_seq, archived_count
         FROM client_sessions WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [request.sessionId, userId],
    )
  ).rows[0];
  if (!session) return { applied: "session_not_found" };
  if (session.deleted_at !== null) return { applied: "session_deleted" };

  const tape = await ensureAndLoadPhaseATape(client, userId, request);
  if (!tape) return { applied: "incomplete" };
  const settlementCtx = resolvePhaseASettlementContext(tape, request);
  const { clientMessageId, fenced } = await loadPhaseADispatchMeta(client, tape.dispatch_id);
  if (tape.visible_at !== null) {
    return handleAlreadyVisiblePhaseA(
      client, userId, request, tape, settlementCtx.engineBillings,
      billingUserId, clientMessageId, deps, options,
    );
  }
  const { head, visibleUsage } = await buildPhaseAVisibleHead(
    client, request, tape, settlementCtx.engineBillings, clientMessageId,
  );
  await persistPhaseATapeVisibility(
    client, userId, request, settlementCtx, head, clientMessageId, visibleUsage,
  );
  await appendPhaseAVisibleAnchor(
    client, userId, request, session, settlementCtx.billingAnchorId, head, visibleUsage, deps,
  );
  const lateTape = await enqueuePhaseAJobsAndConverge(
    client, userId, request, tape, settlementCtx, head, billingUserId, fenced, deps, options,
  );
  return {
    applied: "finalized",
    recordCount: 0,
    engineBillings: settlementCtx.engineBillings,
    settlementHandoff: true,
    newlyVisible: true,
    ...(clientMessageId ? { clientMessageId } : {}),
    ...(lateTape || fenced ? { settlementHeld: true } : {}),
    ...(lateTape ? { dispatchLateTape: true } : {}),
  };
}

export async function commitVisibleLosslessTurnPhaseA(
  pool: Pool,
  userId: string,
  request: LosslessTurnTapeFinalizeRequest | LosslessTurnTapeVisibleRequest,
  deps: PgSessionsDeps,
  options: { enqueueMaterialization?: boolean } = {},
): Promise<LosslessTurnTapeFinalizeResult> {
  const billingUserId = /^c:[1-9][0-9]*$/.test(userId)
    ? deps.billing.numericCommercialUserId(userId)
    : null;
  return withTx(pool, (rawClient) =>
    runPhaseATx(rawClient, userId, request, billingUserId, deps, options));
}

export function createPgTurnTapePhaseAStore(ctx: PgSessionsCtx): {
  commitVisibleLosslessTurnTape(
    userId: string,
    request: LosslessTurnTapeVisibleRequest,
  ): Promise<LosslessTurnTapeFinalizeResult>;
} {
  return {
    async commitVisibleLosslessTurnTape(userId, request) {
      return commitVisibleLosslessTurnPhaseA(ctx.pool, userId, request, ctx.deps, {
        enqueueMaterialization: false,
      });
    },
  };
}
