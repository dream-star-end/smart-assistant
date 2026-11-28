import type { PoolClient } from "pg";
import {
  isClientMessageId,
  type DurableCodexBilling,
  type LosslessTurnTapeFinalizeRequest,
} from "@openclaude/protocol";
import type { MessageLike } from "@openclaude/storage";
import type { RecoveryJobTerminalRow } from "../../dispatch/turnRecoveryStore.js";
import { reconcileLiveStreamWithFinalTape } from "../liveTurnFrames.js";
import { computeSessionLastPreviewRaw } from "../pgTimelinePerf.js";
import { releaseSettlementJobsAfterVerify } from "../turnTapeJobs.js";
import { sanitizeValueForPgJsonb } from "../visibleFinalize.js";
import { execPgSpillPlan } from "./appendCore.js";
import type { PgSessionsDeps } from "./deps.js";
import {
  scheduleAutomaticRecoveryForFinalizedTurn,
  settleFinalizedTurnControls,
} from "./pgAutoRecoveryStore.js";
import { tapeAnchor } from "./pgTapeUsageAndRecordHydrate.js";
import {
  handleAlreadyFinalizedTapeReplay,
  loadAndValidateFinalizeTapes,
  verifyCanonicalSettlementAuthority,
  verifyRecoveryContentOnlyPayload,
  verifyRecoveryLinkForFinalize,
  verifyStagedRecordsAndSidecars,
  type FinalizeTapeRow,
} from "./pgTurnTapeFinalizeVerify.js";
import { verifyPreparedPartManifest } from "./pgTurnTapePrepAndInspect.js";
import {
  CLOCK_MS_SQL,
  advanceClientTimelineIdentityInTransaction,
  bigIntNumOr,
  convergeDispatchOnFinalize,
  errorCodeFromVisibleHead,
  escapeNulInSessionMessagesJson,
} from "./sqlHelpers.js";
import type {
  AutomaticRecoveryDecision,
  LosslessTurnTapeFinalizeResult,
  PreparedLosslessTurnTape,
  SessionWriteRow,
  TurnTapeRecoveryLinkRow,
} from "./types.js";

const UPDATE_SESSION_PHASE_B_SQL = `UPDATE client_sessions SET
   messages=$1, message_count=$2, last_at=$3,
   updated_at=GREATEST(updated_at + 1, ${CLOCK_MS_SQL}),
   next_seq=$4, archived_through_seq=$5, archived_count=$6,
   history_revision=history_revision + $9,
   timeline_generation=timeline_generation + $10,
   last_preview=$11
 WHERE id=$7 AND user_id=$8 AND deleted_at IS NULL`;

type PendingTapeCost = {
  request_id: string;
  cost_credits: string;
  delegate_agent_id: string | null;
};

export type FinalizeTxInput = {
  userId: string;
  request: LosslessTurnTapeFinalizeRequest;
  billingUserId: bigint | null;
  recoveryLockHint: TurnTapeRecoveryLinkRow | null;
  phaseA: LosslessTurnTapeFinalizeResult | null;
  prepared: PreparedLosslessTurnTape | null;
  preparedModelRecordCount: number;
  deps: PgSessionsDeps;
};

export type FinalizeTxOutcome = {
  result: LosslessTurnTapeFinalizeResult;
  goalUsageChanged: boolean;
  recoveryDecision: AutomaticRecoveryDecision | null;
  recoveryJobTerminals: RecoveryJobTerminalRow[];
};

function emptyFinalizeOutcome(result: LosslessTurnTapeFinalizeResult): FinalizeTxOutcome {
  return {
    result,
    goalUsageChanged: false,
    recoveryDecision: null,
    recoveryJobTerminals: [],
  };
}

function parseFinalizeSessionMessages(raw: string): MessageLike[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("not array");
    return parsed as MessageLike[];
  } catch (err) {
    void err;
    throw new Error("lossless turn tape target session row malformed");
  }
}

async function upsertPendingTapeCostComponent(
  client: PoolClient,
  userId: string,
  request: LosslessTurnTapeFinalizeRequest,
  billingAnchorId: string,
  cost: PendingTapeCost,
): Promise<void> {
  const inserted = await client.query(
    `INSERT INTO turn_tape_cost_components
       (request_id,user_id,session_id,tape_id,billing_anchor_id,cost_credits,delegate_agent_id,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (request_id,user_id) DO NOTHING`,
    [
      cost.request_id,
      userId,
      request.sessionId,
      request.tapeId,
      billingAnchorId,
      cost.cost_credits,
      cost.delegate_agent_id,
      Date.now(),
    ],
  );
  if ((inserted.rowCount ?? 0) !== 0) return;
  const existing = (
    await client.query<{
      session_id: string;
      tape_id: string;
      billing_anchor_id: string;
      cost_credits: string;
      delegate_agent_id: string | null;
    }>(
      `SELECT session_id,tape_id,billing_anchor_id,cost_credits::text,delegate_agent_id
         FROM turn_tape_cost_components
        WHERE request_id=$1 AND user_id=$2 FOR UPDATE`,
      [cost.request_id, userId],
    )
  ).rows[0];
  if (
    !existing ||
    existing.session_id !== request.sessionId ||
    existing.tape_id !== request.tapeId ||
    existing.billing_anchor_id !== billingAnchorId ||
    BigInt(existing.cost_credits) !== BigInt(cost.cost_credits) ||
    existing.delegate_agent_id !== cost.delegate_agent_id
  ) {
    throw new Error("lossless turn tape cost component immutable conflict");
  }
}

async function consumePendingTapeCosts(
  client: PoolClient,
  userId: string,
  request: LosslessTurnTapeFinalizeRequest,
  recoveryLink: TurnTapeRecoveryLinkRow | null,
  turn: PreparedLosslessTurnTape["turn"],
): Promise<PendingTapeCost[]> {
  // Continuation tapes carry post-terminal runtime output only. They
  // share the chat session with the paid turn but must never consume a
  // legacy by-session pending cost intended for that original turn.
  const pending: PendingTapeCost[] = turn.payload.continuationOfTurnKey
    ? []
    : (
        await client.query<PendingTapeCost>(
          `SELECT request_id, cost_credits, delegate_agent_id
             FROM pending_usage_patches
            WHERE user_id = $1 AND (
                  turn_key = $2 OR parent_turn_key = $2
                  OR (turn_key IS NULL AND parent_turn_key IS NULL AND request_id = $3)
                  OR (turn_key IS NULL AND parent_turn_key IS NULL AND session_id = $4)
                  OR (turn_key IS NULL AND parent_turn_key IS NULL AND parent_session_id = $5)
                )
            ORDER BY request_id FOR UPDATE`,
          [
            userId,
            request.turnKey,
            turn.payload.requestId ?? "",
            turn.payload.agentSessionId ?? "",
            request.sessionId,
          ],
        )
      ).rows;
  if (recoveryLink && pending.length > 0) {
    throw new Error("turn tape recovery has pending financial rows");
  }
  for (const cost of pending) {
    await upsertPendingTapeCostComponent(client, userId, request, turn.billingAnchorId, cost);
  }
  return pending;
}

async function writePhaseBSessionUpdate(
  client: PoolClient,
  userId: string,
  request: LosslessTurnTapeFinalizeRequest,
  session: SessionWriteRow,
  plan: Extract<ReturnType<PgSessionsDeps["storage"]["planReplaceServerAuthoredKeepingOrderSlots"]>, { kind: "write" }>,
  preUpgradeMessages: MessageLike[],
  filteredMessages: MessageLike[],
  publishesVisiblePhaseARecords: boolean,
  deps: PgSessionsDeps,
): Promise<boolean> {
  const nowMs = Date.now();
  const archivedDelta = await execPgSpillPlan(
    client, request.sessionId, userId, plan.chunksToInsert, plan.idsToInsert, nowMs,
  );
  const archivedCount = bigIntNumOr(session.archived_count, 0) + archivedDelta;
  const removedInvisibleMessage = deps.storage.hasInvisibleMessageRemoval(
    preUpgradeMessages, filteredMessages,
  );
  const historyRevisionDelta =
    publishesVisiblePhaseARecords ||
    deps.storage.hasInvisibleMessageRemoval(preUpgradeMessages, plan.tail) ||
    archivedDelta > 0
      ? 1
      : 0;
  const timelineGenerationDelta = publishesVisiblePhaseARecords || removedInvisibleMessage ? 1 : 0;
  await client.query(UPDATE_SESSION_PHASE_B_SQL, [
    escapeNulInSessionMessagesJson(plan.finalJson),
    plan.tail.length + archivedCount,
    nowMs,
    plan.nextSeq,
    plan.archivedThroughSeq,
    archivedCount,
    request.sessionId,
    userId,
    historyRevisionDelta,
    timelineGenerationDelta,
    computeSessionLastPreviewRaw(plan.tail),
  ]);
  return publishesVisiblePhaseARecords;
}

async function publishHotAnchorToSession(
  client: PoolClient,
  userId: string,
  request: LosslessTurnTapeFinalizeRequest,
  session: SessionWriteRow,
  turn: PreparedLosslessTurnTape["turn"],
  existingMessages: MessageLike[],
  publishesVisiblePhaseARecords: boolean,
  deps: PgSessionsDeps,
): Promise<MessageLike[]> {
  const billingRecord = turn.records.find((item) => item.id === turn.billingAnchorId);
  if (!billingRecord) throw new Error("lossless turn tape billing record missing");
  const anchors = [
    tapeAnchor(
      billingRecord, request.tapeId, request.tapeSha256,
      turn.records.length, turn.logicalRecordCount, turn.runtimeBatchManifestSha256,
      [...new Set(turn.records.map((item) => item.role).filter((role) => role === "plan" || role === "goal"))],
    ),
  ];
  const allRecordIds = [...new Set([
    ...turn.logicalRecordIds,
    ...turn.records.map((item) => item.id),
  ])];
  const archived = await client.query<{ msg_id: string }>(
    `SELECT msg_id FROM client_session_archived_ids
      WHERE session_id=$1 AND msg_id = ANY($2::text[])`,
    [request.sessionId, allRecordIds],
  );
  if (archived.rows.length > 0) {
    throw new Error("lossless turn tape record id collides with archived row");
  }
  const preUpgradeMessages = existingMessages;
  const recordIds = new Set(allRecordIds);
  const removePhaseAOrLegacy = (message: MessageLike): boolean =>
    message?._turnTapeId === request.tapeId ||
    (typeof message?.id === "string" && recordIds.has(message.id));
  const filteredMessages = existingMessages.filter((message) => !removePhaseAOrLegacy(message));
  const plan = deps.storage.planReplaceServerAuthoredKeepingOrderSlots(
    preUpgradeMessages,
    anchors,
    removePhaseAOrLegacy,
    typeof session.next_seq === "number" && session.next_seq > 0 ? session.next_seq : 1,
    bigIntNumOr(session.archived_through_seq, 0),
  );
  if (plan.kind === "oversized") {
    throw new Error("lossless turn tape anchor tail unexpectedly oversized");
  }
  const phaseBIdentityAdvanced = plan.kind === "write"
    ? await writePhaseBSessionUpdate(
        client, userId, request, session, plan,
        preUpgradeMessages, filteredMessages, publishesVisiblePhaseARecords, deps,
      )
    : false;
  if (publishesVisiblePhaseARecords && !phaseBIdentityAdvanced) {
    await advanceClientTimelineIdentityInTransaction(client, request.sessionId, userId);
  }
  return filteredMessages;
}

async function persistTurnAndRequestMappings(
  client: PoolClient,
  userId: string,
  request: LosslessTurnTapeFinalizeRequest,
  turn: PreparedLosslessTurnTape["turn"],
  pending: ReadonlyArray<PendingTapeCost>,
): Promise<void> {
  if (!turn.payload.continuationOfTurnKey) {
    const mapInsert = await client.query(
      `INSERT INTO server_authored_turn_anchor_map
         (user_id,turn_key,session_id,tape_id,billing_anchor_id,written_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_id,turn_key) DO NOTHING`,
      [userId, request.turnKey, request.sessionId, request.tapeId, turn.billingAnchorId, Date.now()],
    );
    if ((mapInsert.rowCount ?? 0) === 0) {
      const map = (
        await client.query<{ session_id: string; tape_id: string; billing_anchor_id: string }>(
          `SELECT session_id,tape_id,billing_anchor_id FROM server_authored_turn_anchor_map
            WHERE user_id=$1 AND turn_key=$2 FOR UPDATE`,
          [userId, request.turnKey],
        )
      ).rows[0];
      if (
        !map ||
        map.session_id !== request.sessionId ||
        map.tape_id !== request.tapeId ||
        map.billing_anchor_id !== turn.billingAnchorId
      ) {
        throw new Error("lossless turn tape turnKey mapping conflict");
      }
    }
  }
  if (turn.payload.requestId) {
    const requestMap = await client.query(
      `INSERT INTO server_authored_request_map (request_id,user_id,session_id,msg_id)
       VALUES ($1,$2,$3,$4) ON CONFLICT (request_id,user_id) DO NOTHING`,
      [turn.payload.requestId, userId, request.sessionId, turn.billingAnchorId],
    );
    if ((requestMap.rowCount ?? 0) === 0) {
      const existing = (
        await client.query<{ session_id: string; msg_id: string }>(
          `SELECT session_id,msg_id FROM server_authored_request_map
            WHERE request_id=$1 AND user_id=$2 FOR UPDATE`,
          [turn.payload.requestId, userId],
        )
      ).rows[0];
      if (
        !existing ||
        existing.session_id !== request.sessionId ||
        existing.msg_id !== turn.billingAnchorId
      ) {
        throw new Error("lossless turn tape request mapping conflict");
      }
    }
  }
  if (pending.length > 0) {
    await client.query(
      "DELETE FROM pending_usage_patches WHERE user_id=$1 AND request_id = ANY($2::text[])",
      [userId, pending.map((c) => c.request_id)],
    );
  }
}

async function commitFinalTapeAndSettlement(
  client: PoolClient,
  input: {
    userId: string;
    request: LosslessTurnTapeFinalizeRequest;
    tape: FinalizeTapeRow;
    prepared: PreparedLosslessTurnTape;
    preparedModelRecordCount: number;
    canonicalSettlementHash: string;
    goalTokensUsed: number;
    clientMessageId: string | null;
    billingUserId: bigint | null;
    deps: PgSessionsDeps;
  },
): Promise<boolean> {
  const { userId, request, tape, prepared, deps } = input;
  const turn = prepared.turn;
  await client.query(
    `UPDATE client_session_turn_tapes
        SET billing_anchor_id=$1, usage=$2, parent_turn_key=$3,
            engine_billings=$4, finalized_at=$5,
            visible_at=COALESCE(visible_at,$5),
            materialization_status='complete',
            settlement_verified_at=COALESCE(settlement_verified_at, NOW()),
            materialization_error=NULL,
            record_storage_format=$6,
            goal_id=$7::uuid, goal_state_revision=$8, goal_tokens_used=$9,
            client_message_id=$10, continuation_of_turn_key=$11,
            physical_record_count=$12, logical_record_count=$13,
            record_payload_bytes=$14, model_record_count=$15,
            settlement_hash=CASE WHEN settlement_hash IS NULL THEN NULL ELSE $16 END
      WHERE session_id=$17 AND user_id=$18 AND tape_id=$19`,
    [
      turn.billingAnchorId,
      JSON.stringify(sanitizeValueForPgJsonb(turn.payload.usage ?? {})),
      turn.payload.parentTurnKey ?? null,
      JSON.stringify(sanitizeValueForPgJsonb(turn.engineBillings)),
      Date.now(),
      prepared.recordStorageFormat,
      turn.payload.goalId ?? null,
      turn.payload.goalStateRevision ?? null,
      input.goalTokensUsed,
      input.clientMessageId,
      turn.payload.continuationOfTurnKey ?? null,
      turn.records.length,
      turn.logicalRecordCount,
      prepared.recordPayloadBytes,
      input.preparedModelRecordCount,
      input.canonicalSettlementHash,
      request.sessionId,
      userId,
      request.tapeId,
    ],
  );
  // A header is only a waiver proposal. New long-task fences require
  // the fully verified canonical records and pending engine usage above.
  // This still shares the terminal transaction and exact billing lock:
  // zero-output fence and finalized tape become visible together.
  if (request.waiveReason !== undefined) {
    await deps.billing.ensurePendingTurnWaiverInTransaction(client, {
      userId: input.billingUserId!,
      turnKey: request.turnKey,
      reason: request.waiveReason,
    });
  }
  if (tape.settlement_hash !== null && tape.settlement_hash !== input.canonicalSettlementHash) {
    await client.query(
      `UPDATE turn_tape_settlement_jobs
          SET settlement_hash=$4, updated_at=NOW()
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
          AND settlement_hash IS DISTINCT FROM $4`,
      [request.sessionId, userId, request.tapeId, input.canonicalSettlementHash],
    );
  }
  const goalUsageChanged = await deps.goal.bumpGoalUsageSnapshotForTape(
    client,
    request.sessionId,
    userId,
    request.tapeId,
  );
  // 原始分片(parts)一律随 finalize 清除:records 才是脱敏后的持久权威,parts 保存
  // 的是脱敏前 payload,留下即隐私面偏差 + 双份存储(2026-07-16 巡检批)。
  await client.query(
    `DELETE FROM client_session_turn_tape_parts
      WHERE session_id=$1 AND user_id=$2 AND tape_id=$3`,
    [request.sessionId, userId, request.tapeId],
  );
  return goalUsageChanged;
}

async function convergeFinalizeDispatchAndSettlement(
  client: PoolClient,
  userId: string,
  request: LosslessTurnTapeFinalizeRequest,
  tape: FinalizeTapeRow,
  deps: PgSessionsDeps,
): Promise<boolean> {
  // dispatch 收敛(RFC §2.4):tape header 带 dispatch_id -> 非终态转 terminal(映射 status),
  // 或迟到 tape 转 manual_reconcile。浏览器直接读 tape/dispatch，不再写任何影子内容表。
  let dispatchLate = false;
  if (tape.dispatch_id !== null) {
    const convergence = await convergeDispatchOnFinalize(
      client,
      tape.dispatch_id,
      tape.status,
      deps,
      request.settlement?.errorCode ?? errorCodeFromVisibleHead(tape.visible_head),
    );
    dispatchLate = convergence.lateTape;
    await reconcileLiveStreamWithFinalTape(client, {
      dispatchId: tape.dispatch_id,
      status: tape.status,
      tapeId: request.tapeId,
      tapeSha256: request.tapeSha256,
    });
    if (convergence.removedVisibleStatus) {
      // 当前事务已持 session 锁；revision 让浏览器移除此前的 verified failure 状态。
      await advanceClientTimelineIdentityInTransaction(client, request.sessionId, userId);
    }
  }
  if (!dispatchLate) {
    await releaseSettlementJobsAfterVerify(client, {
      sessionId: request.sessionId,
      userId,
      tapeId: request.tapeId,
    });
  }
  return dispatchLate;
}

async function settleOrScheduleAutomaticRecovery(
  client: PoolClient,
  userId: string,
  request: LosslessTurnTapeFinalizeRequest,
  turn: PreparedLosslessTurnTape["turn"],
  clientMessageId: string | null,
  filteredMessages: MessageLike[],
  billingUserId: bigint | null,
  deps: PgSessionsDeps,
): Promise<{
  recoveryDecision: AutomaticRecoveryDecision | null;
  recoveryJobTerminals: RecoveryJobTerminalRow[];
}> {
  if (billingUserId === null) {
    return { recoveryDecision: null, recoveryJobTerminals: [] };
  }
  if (turn.payload.continuationOfTurnKey) {
    // Child recovery tape: settle the producing job, do not evaluate a
    // new recovery (Phase 1 does not change recovery policy).
    if (!clientMessageId || !isClientMessageId(clientMessageId)) {
      return { recoveryDecision: null, recoveryJobTerminals: [] };
    }
    const recoveryJobTerminals = await settleFinalizedTurnControls(
      client,
      {
        uid: billingUserId,
        sessionId: request.sessionId,
        clientMessageId,
        outcome: turn.payload.status,
      },
      deps,
    );
    return { recoveryDecision: null, recoveryJobTerminals };
  }
  const scheduled = await scheduleAutomaticRecoveryForFinalizedTurn(
    client,
    {
      uid: billingUserId,
      sessionUserId: userId,
      sessionId: request.sessionId,
      turn,
      clientMessageId,
      tapeSha256: request.tapeSha256,
      currentMessages: filteredMessages,
    },
    deps,
  );
  return {
    recoveryDecision: scheduled.decision,
    recoveryJobTerminals: scheduled.terminals,
  };
}

async function acquireFinalizeTxTarget(
  client: PoolClient,
  input: FinalizeTxInput,
): Promise<
  | { kind: "early"; outcome: FinalizeTxOutcome }
  | {
      kind: "ready";
      session: SessionWriteRow;
      recoveryLink: TurnTapeRecoveryLinkRow | null;
      tape: FinalizeTapeRow;
      recoverySourceTape: FinalizeTapeRow | undefined;
      prepared: PreparedLosslessTurnTape;
    }
> {
  const { userId, request, billingUserId, recoveryLockHint, phaseA, prepared, deps } = input;
  // Recovery publication must serialize both immutable logical turns in
  // the same lexical order as authorization and billing settlement.
  const lockKeys = recoveryLockHint
    ? [request.turnKey, recoveryLockHint.source_turn_key]
    : [request.turnKey];
  await deps.billing.lockTurnPersistenceKeys(client, userId, lockKeys);
  // Shared with rolling lease renewal and every settlement/refund path:
  // once a terminal anchor commits, no renewal can race past its check.
  if (billingUserId !== null) {
    await deps.billing.lockTurnBillingKeys(client, billingUserId, lockKeys);
  }
  const session = (
    await client.query<SessionWriteRow>(
      `SELECT messages, next_seq, deleted_at, archived_through_seq, archived_count
         FROM client_sessions WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [request.sessionId, userId],
    )
  ).rows[0];
  if (!session) return { kind: "early", outcome: emptyFinalizeOutcome({ applied: "session_not_found" }) };
  if (session.deleted_at !== null) {
    return { kind: "early", outcome: emptyFinalizeOutcome({ applied: "session_deleted" }) };
  }
  const recoveryLink = await verifyRecoveryLinkForFinalize(client, userId, request, recoveryLockHint);
  const loaded = await loadAndValidateFinalizeTapes(client, userId, request, recoveryLink, deps);
  if (!loaded) return { kind: "early", outcome: emptyFinalizeOutcome({ applied: "incomplete" }) };
  const { tape, recoverySourceTape } = loaded;
  if (tape.finalized_at !== null) {
    const replay = await handleAlreadyFinalizedTapeReplay(
      client,
      userId,
      request,
      tape,
      billingUserId,
      deps,
    );
    return { kind: "early", outcome: emptyFinalizeOutcome(replay) };
  }
  if (!prepared) {
    if (tape.visible_at !== null || (phaseA && phaseA.applied === "finalized")) {
      return {
        kind: "early",
        outcome: emptyFinalizeOutcome({
          applied: "finalized",
          recordCount: 0,
          engineBillings: Array.isArray(tape.engine_billings)
            ? structuredClone(tape.engine_billings) as DurableCodexBilling[]
            : [],
          settlementHandoff: true,
        }),
      };
    }
    return { kind: "early", outcome: emptyFinalizeOutcome({ applied: "incomplete" }) };
  }
  if (tape.record_storage_format !== prepared.recordStorageFormat) {
    throw new Error("lossless turn tape materialization format changed before publication");
  }
  return { kind: "ready", session, recoveryLink, tape, recoverySourceTape, prepared };
}

async function resolveFinalizedClientMessageId(
  client: PoolClient,
  turn: PreparedLosslessTurnTape["turn"],
  dispatchId: string | null,
): Promise<string | null> {
  if (turn.payload.clientMessageId !== undefined) return turn.payload.clientMessageId;
  if (dispatchId === null) return null;
  return (
    await client.query<{ client_message_id: string }>(
      "SELECT client_message_id FROM turn_dispatches WHERE dispatch_id=$1",
      [dispatchId],
    )
  ).rows[0]?.client_message_id ?? null;
}

export async function runFinalizeLosslessTurnTapeTx(
  client: PoolClient,
  input: FinalizeTxInput,
): Promise<FinalizeTxOutcome> {
  const target = await acquireFinalizeTxTarget(client, input);
  if (target.kind === "early") return target.outcome;
  const { userId, request, billingUserId, preparedModelRecordCount, deps } = input;
  const { session, recoveryLink, tape, recoverySourceTape, prepared } = target;
  const turn = prepared.turn;
  const publishesVisiblePhaseARecords =
    tape.visible_at !== null && tape.materialization_status !== "complete";

  const canonicalSettlementHash = verifyCanonicalSettlementAuthority(tape, request, turn);
  if (await verifyPreparedPartManifest(client, userId, request, prepared.partManifest) !== "complete") {
    return emptyFinalizeOutcome({ applied: "incomplete" });
  }
  await verifyStagedRecordsAndSidecars(client, userId, request, prepared);

  const existingMessages = parseFinalizeSessionMessages(session.messages);
  if (recoveryLink) {
    await verifyRecoveryContentOnlyPayload(
      client, userId, request, recoveryLink, tape, recoverySourceTape!, turn, existingMessages,
    );
  }
  const goalTokensUsed = deps.lossless.computeGoalTokensUsed(turn.payload);
  const pending = await consumePendingTapeCosts(client, userId, request, recoveryLink, turn);
  const filteredMessages = await publishHotAnchorToSession(
    client, userId, request, session, turn, existingMessages, publishesVisiblePhaseARecords, deps,
  );
  await persistTurnAndRequestMappings(client, userId, request, turn, pending);

  const clientMessageId = await resolveFinalizedClientMessageId(client, turn, tape.dispatch_id);
  const goalUsageChanged = await commitFinalTapeAndSettlement(client, {
    userId, request, tape, prepared, preparedModelRecordCount,
    canonicalSettlementHash, goalTokensUsed, clientMessageId, billingUserId, deps,
  });
  const dispatchLate = await convergeFinalizeDispatchAndSettlement(
    client, userId, request, tape, deps,
  );
  const { recoveryDecision, recoveryJobTerminals } = await settleOrScheduleAutomaticRecovery(
    client, userId, request, turn, clientMessageId, filteredMessages, billingUserId, deps,
  );
  return {
    result: {
      applied: "finalized",
      recordCount: turn.records.length,
      engineBillings: turn.engineBillings.map((billing) => structuredClone(billing)),
      ...(turn.engineBillings.length > 0 || request.waiveReason !== undefined
        ? { settlementHandoff: true }
        : {}),
      ...(dispatchLate ? { dispatchLateTape: true, settlementHeld: true } : {}),
    },
    goalUsageChanged,
    recoveryDecision,
    recoveryJobTerminals,
  };
}
