import type { PoolClient } from "pg";
import {
  losslessBillingAnchorId,
  type DurableCodexBilling,
  type LosslessTurnTapeFinalizeRequest,
} from "@openclaude/protocol";
import type { MessageLike } from "@openclaude/storage";
import { reconcileLiveStreamWithFinalTape } from "../liveTurnFrames.js";
import {
  assertSettlementMatchesCanonical,
  settlementEngineBillings,
  settlementPayloadEqual,
} from "../visibleFinalize.js";
import type { PgSessionsDeps } from "./deps.js";
import {
  assertRecoveryUsageFallback,
  readRecoverySourceUsage,
} from "./pgTapeUsageAndRecordHydrate.js";
import {
  preparedModelSidecarManifest,
  readTurnTapeRecoveryLink,
  sameLosslessTurnTapeHeader,
  sameTurnTapeRecoveryLink,
} from "./pgTurnTapePrepAndInspect.js";
import {
  advanceClientTimelineIdentityInTransaction,
  bigIntNum,
  convergeDispatchOnFinalize,
  errorCodeFromVisibleHead,
} from "./sqlHelpers.js";
import {
  TurnTapeRecoveryLockUpgrade,
  type LosslessTurnTapeFinalizeResult,
  type PreparedLosslessTurnTape,
  type PreparedModelSidecar,
  type TurnTapeRecoveryLinkRow,
  type UserVisiblePhysicalPayload,
} from "./types.js";

export type FinalizeTapeRow = {
  tape_id: string;
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
  record_storage_format: number;
  engine_billings: unknown;
  billing_anchor_id: string | null;
  dispatch_id: string | null;
  attempt_no: number | null;
  client_message_id: string | null;
  visible_at: string | null;
  materialization_status: string;
  settlement_hash: string | null;
  visible_head: unknown;
};

export async function verifyRecoveryLinkForFinalize(
  client: PoolClient,
  userId: string,
  request: LosslessTurnTapeFinalizeRequest,
  recoveryLockHint: TurnTapeRecoveryLinkRow | null,
): Promise<TurnTapeRecoveryLinkRow | null> {
  const recoveryLink = await readTurnTapeRecoveryLink(
    client,
    request.sessionId,
    userId,
    request.tapeId,
    true,
  );
  if (!recoveryLockHint && recoveryLink) {
    throw new TurnTapeRecoveryLockUpgrade(recoveryLink);
  }
  if (
    recoveryLockHint &&
    (!recoveryLink || !sameTurnTapeRecoveryLink(recoveryLockHint, recoveryLink))
  ) {
    throw new Error("turn tape recovery authorization changed during finalize");
  }
  if (
    recoveryLink && (
      recoveryLink.recovery_turn_key !== request.turnKey ||
      recoveryLink.recovery_tape_sha256 !== request.tapeSha256
    )
  ) {
    throw new Error("turn tape recovery request identity conflict");
  }
  return recoveryLink;
}

function assertRecoverySourceIdentityMatches(
  recoveryLink: TurnTapeRecoveryLinkRow,
  tape: FinalizeTapeRow,
  source: FinalizeTapeRow | undefined,
): FinalizeTapeRow {
  const validCore = !!source &&
    source.finalized_at !== null &&
    source.status === "crashed" &&
    tape.status === "completed" &&
    source.tape_sha256 === recoveryLink.source_tape_sha256 &&
    source.turn_key === recoveryLink.source_turn_key;
  const validAnchor = !!source &&
    source.billing_anchor_id !== null &&
    source.dispatch_id !== null &&
    source.agent_id === tape.agent_id &&
    source.turn_index === tape.turn_index &&
    source.created_at === tape.created_at;
  if (!validCore || !validAnchor) {
    throw new Error("turn tape recovery source identity conflict");
  }
  return source;
}

async function verifyRecoverySourceAndHeader(
  client: PoolClient,
  userId: string,
  request: LosslessTurnTapeFinalizeRequest,
  recoveryLink: TurnTapeRecoveryLinkRow,
  tape: FinalizeTapeRow,
  recoverySourceTape: FinalizeTapeRow | undefined,
  deps: PgSessionsDeps,
): Promise<FinalizeTapeRow> {
  const source = assertRecoverySourceIdentityMatches(recoveryLink, tape, recoverySourceTape);
  const sourceDispatch = await client.query(
    `SELECT 1 FROM turn_dispatches
      WHERE dispatch_id=$1 AND user_id=$2 AND session_id=$3 AND agent_id=$4
        AND status='terminal' AND outcome='crashed'
      LIMIT 1 FOR UPDATE`,
    [
      source.dispatch_id,
      deps.billing.numericCommercialUserId(userId),
      request.sessionId,
      source.agent_id,
    ],
  );
  if ((sourceDispatch.rowCount ?? 0) !== 1) {
    throw new Error("turn tape recovery source dispatch is no longer an authoritative crash");
  }
  if (
    request.waiveReason !== undefined ||
    request.dispatchId !== undefined ||
    request.attemptNo !== undefined ||
    tape.waive_reason !== null ||
    tape.dispatch_id !== null ||
    tape.attempt_no !== null
  ) {
    throw new Error("turn tape recovery header is not content-only");
  }
  return source;
}

export async function loadAndValidateFinalizeTapes(
  client: PoolClient,
  userId: string,
  request: LosslessTurnTapeFinalizeRequest,
  recoveryLink: TurnTapeRecoveryLinkRow | null,
  deps: PgSessionsDeps,
): Promise<{ tape: FinalizeTapeRow; recoverySourceTape: FinalizeTapeRow | undefined } | null> {
  const tapeRows = (
    await client.query<FinalizeTapeRow>(
      `SELECT tape_id,agent_id,turn_index,status,turn_key,tape_sha256,
              total_bytes, part_count, created_at, waive_reason, finalized_at,
              record_storage_format,engine_billings,
              billing_anchor_id,dispatch_id,attempt_no,client_message_id,
              visible_at::text, materialization_status, settlement_hash, visible_head
         FROM client_session_turn_tapes
        WHERE session_id=$1 AND user_id=$2 AND tape_id=ANY($3::text[])
        ORDER BY tape_id FOR UPDATE`,
      [
        request.sessionId,
        userId,
        recoveryLink ? [request.tapeId, recoveryLink.source_tape_id] : [request.tapeId],
      ],
    )
  ).rows;
  const tapeById = new Map(tapeRows.map((row) => [row.tape_id, row]));
  const tape = tapeById.get(request.tapeId);
  if (!tape) return null;
  if (!sameLosslessTurnTapeHeader(tape, request)) {
    throw new Error("lossless turn tape finalize header conflict");
  }
  if (!recoveryLink) return { tape, recoverySourceTape: undefined };
  const recoverySourceTape = await verifyRecoverySourceAndHeader(
    client,
    userId,
    request,
    recoveryLink,
    tape,
    tapeById.get(recoveryLink.source_tape_id),
    deps,
  );
  return { tape, recoverySourceTape };
}

export async function handleAlreadyFinalizedTapeReplay(
  client: PoolClient,
  userId: string,
  request: LosslessTurnTapeFinalizeRequest,
  tape: FinalizeTapeRow,
  billingUserId: bigint | null,
  deps: PgSessionsDeps,
): Promise<LosslessTurnTapeFinalizeResult> {
  // Rolling-upgrade/ACK-loss replay: the terminal anchor may already
  // exist, but the exact-turn waiver fence still must be present
  // before the master can ACK this finalizer.
  if (request.waiveReason !== undefined) {
    await deps.billing.ensurePendingTurnWaiverInTransaction(client, {
      userId: billingUserId!,
      turnKey: request.turnKey,
      reason: request.waiveReason,
    });
  }
  const count = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM client_session_turn_tape_records
      WHERE session_id = $1 AND user_id = $2 AND tape_id = $3`,
    [request.sessionId, userId, request.tapeId],
  );
  if (!Array.isArray(tape.engine_billings)) {
    throw new Error("lossless turn tape finalized engine billings malformed");
  }
  // 幂等 replay 分支同样收敛 dispatch(不依赖 parts):首轮 finalize 若已收敛,CAS no-op。
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
    await reconcileLiveStreamWithFinalTape(client, {
      dispatchId: tape.dispatch_id,
      status: tape.status,
      tapeId: request.tapeId,
      tapeSha256: request.tapeSha256,
    });
    if (convergence.removedVisibleStatus) {
      // 直接状态读以 dispatch.status 为准。late tape 改成 manual_reconcile 后 bump
      // revision，在线客户端会立刻重读并移除旧失败状态。
      await advanceClientTimelineIdentityInTransaction(client, request.sessionId, userId);
    }
  }
  return {
    applied: "idempotent",
    recordCount: Number(count.rows[0]?.count ?? 0),
    engineBillings: structuredClone(tape.engine_billings) as DurableCodexBilling[],
    ...(request.waiveReason !== undefined ||
      (Array.isArray(tape.engine_billings) && tape.engine_billings.length > 0)
      ? { settlementHandoff: true }
      : {}),
    ...(replayLate ? { dispatchLateTape: true } : {}),
  };
}

function buildAcceptedPersistedAuthorities(
  tape: FinalizeTapeRow,
  turn: PreparedLosslessTurnTape["turn"],
  canonicalRequestId: string | null,
  persistedBillings: unknown[],
): Array<{ billingAnchorId: string; requestId?: string | null; engineBillings: unknown }> {
  const anchorInput = {
    sessionId: turn.payload.sessionId,
    agentId: turn.payload.agentId,
    turnIndex: turn.payload.turnIndex,
    status: turn.payload.status,
    createdAt: turn.payload.createdAt,
    clientMessageId: turn.payload.clientMessageId,
    continuationOfTurnKey: turn.payload.continuationOfTurnKey,
    assistantSegments: turn.payload.assistantSegments,
    text: turn.payload.text,
    errorCode: turn.payload.errorCode,
    thinkingText: turn.payload.thinkingText,
    thinkingSegments: turn.payload.thinkingSegments,
    tools: turn.payload.tools,
    agentGroups: turn.payload.agentGroups,
    structuredBlocks: turn.payload.structuredBlocks,
    runtimeEvents: turn.payload.runtimeEvents,
  };
  // Rolling enable/rollback can temporarily pair a format-2 writer with
  // a format-3 reader (or the reverse). Accept only the exact authority
  // derived from the same immutable payload under the opposite physical
  // batching mode; Phase B atomically publishes/upgrades the canonical one.
  const alternateBillingAnchorId = losslessBillingAnchorId({
    ...anchorInput,
    runtimeBatching: tape.record_storage_format !== 3,
  });
  const accepted: Array<{
    billingAnchorId: string;
    requestId?: string | null;
    engineBillings: unknown;
  }> = alternateBillingAnchorId === turn.billingAnchorId
    ? []
    : [{
        billingAnchorId: alternateBillingAnchorId,
        requestId: canonicalRequestId,
        engineBillings: turn.engineBillings,
      }];
  if (
    turn.payload.continuationOfTurnKey &&
    canonicalRequestId === null &&
    turn.engineBillings.length === 0 &&
    persistedBillings.length === 0
  ) {
    accepted.push({
      billingAnchorId: losslessBillingAnchorId({
        sessionId: turn.payload.sessionId,
        agentId: turn.payload.agentId,
        turnIndex: turn.payload.turnIndex,
      }),
      requestId: null,
      engineBillings: [],
    });
  }
  return accepted;
}

export function verifyCanonicalSettlementAuthority(
  tape: FinalizeTapeRow,
  request: LosslessTurnTapeFinalizeRequest,
  turn: PreparedLosslessTurnTape["turn"],
): string {
  const persistedBillings = Array.isArray(tape.engine_billings) ? tape.engine_billings : [];
  const canonicalRequestId = turn.engineBillings[0]?.requestId ?? turn.payload.requestId ?? null;
  const persistedRequestId = (persistedBillings as DurableCodexBilling[])[0]?.requestId
    ?? turn.payload.requestId
    ?? null;
  const acceptedPersistedAuthorities = buildAcceptedPersistedAuthorities(
    tape,
    turn,
    canonicalRequestId,
    persistedBillings,
  );
  const canonicalSettlementHash = assertSettlementMatchesCanonical({
    canonicalAnchorId: turn.billingAnchorId,
    canonicalRequestId,
    canonicalBillings: turn.engineBillings,
    envelope: request.settlement
      ? {
          billingAnchorId: request.settlement.billingAnchorId,
          requestId: request.settlement.requestId,
          engineBillings: settlementEngineBillings(request.settlement),
        }
      : null,
    persistedHash: tape.settlement_hash,
    persistedAuthority: tape.settlement_hash && tape.billing_anchor_id
      ? {
          billingAnchorId: tape.billing_anchor_id,
          requestId: persistedRequestId,
          engineBillings: persistedBillings,
        }
      : null,
    acceptedPersistedAuthorities,
  });
  if (
    persistedBillings.length > 0 &&
    !settlementPayloadEqual(persistedBillings, turn.engineBillings)
  ) {
    throw new Error("lossless turn tape engineBillings mismatch");
  }
  return canonicalSettlementHash;
}

type StagedRecordHashRow = {
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

type StagedModelSidecarRow = {
  physical_ordinal: number;
  logical_ordinal: number;
  msg_id: string;
  role: string;
  semantic_text: string;
  token_estimate: number;
  ts: string | null;
  client_message_id: string | null;
};

function assertStagedRecordMatches(
  actual: StagedRecordHashRow,
  expected: PreparedLosslessTurnTape["turn"]["records"][number],
  expectedVisible: UserVisiblePhysicalPayload,
  ordinal: number,
): void {
  if (
    actual.ordinal !== ordinal ||
    actual.msg_id !== expected.id ||
    actual.role !== expected.role ||
    bigIntNum(actual.ts, "staged turn tape record ts") !== expected.ts ||
    actual.content_sha256 !== expected.payloadSha256 ||
    actual.payload_sha256 !== expected.payloadSha256 ||
    actual.visible_content_sha256 !== expectedVisible.contentSha256 ||
    actual.visible_payload_sha256 !== expectedVisible.contentSha256 ||
    actual.model_sidecar_complete !== true
  ) {
    throw new Error("lossless turn tape staged record manifest conflict");
  }
}

function assertStagedModelSidecarMatches(
  actual: StagedModelSidecarRow,
  expected: PreparedModelSidecar,
): void {
  if (
    actual.physical_ordinal !== expected.physicalOrdinal ||
    actual.logical_ordinal !== expected.logicalOrdinal ||
    actual.msg_id !== expected.msgId ||
    actual.role !== expected.role ||
    actual.semantic_text !== expected.semanticText ||
    actual.token_estimate !== expected.tokenEstimate ||
    (actual.ts === null ? null : bigIntNum(actual.ts, "staged model record ts")) !== expected.ts ||
    actual.client_message_id !== expected.clientMessageId
  ) {
    throw new Error("lossless turn tape staged model record manifest conflict");
  }
}

export async function verifyStagedRecordsAndSidecars(
  client: PoolClient,
  userId: string,
  request: LosslessTurnTapeFinalizeRequest,
  prepared: PreparedLosslessTurnTape,
): Promise<void> {
  // The unlocked summaries above are only a staging optimization. Rehash
  // both derived byte copies under the header lock so a row changed
  // between summary and publication can never be finalized on the
  // strength of stale declared hashes.
  const stagedRecords = (
    await client.query<StagedRecordHashRow>(
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
  if (stagedRecords.length !== prepared.turn.records.length) {
    throw new Error("lossless turn tape staged record count mismatch");
  }
  for (let ordinal = 0; ordinal < stagedRecords.length; ordinal++) {
    assertStagedRecordMatches(
      stagedRecords[ordinal]!,
      prepared.turn.records[ordinal]!,
      prepared.visible[ordinal]!,
      ordinal,
    );
  }
  const expectedModelSidecars = preparedModelSidecarManifest(prepared);
  const stagedModelSidecars = (
    await client.query<StagedModelSidecarRow>(
      `SELECT physical_ordinal,logical_ordinal,msg_id,role,semantic_text,
              token_estimate,ts::text,client_message_id
         FROM client_session_turn_tape_model_records
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
        ORDER BY physical_ordinal,logical_ordinal`,
      [request.sessionId, userId, request.tapeId],
    )
  ).rows;
  if (stagedModelSidecars.length !== expectedModelSidecars.length) {
    throw new Error("lossless turn tape staged model record count mismatch");
  }
  for (let index = 0; index < stagedModelSidecars.length; index++) {
    assertStagedModelSidecarMatches(stagedModelSidecars[index]!, expectedModelSidecars[index]!);
  }
}

function hasNonContentOnlyRecoveryHeader(
  request: LosslessTurnTapeFinalizeRequest,
  tape: FinalizeTapeRow,
): boolean {
  return request.waiveReason !== undefined ||
    request.dispatchId !== undefined ||
    request.attemptNo !== undefined ||
    tape.waive_reason !== null ||
    tape.dispatch_id !== null ||
    tape.attempt_no !== null ||
    tape.client_message_id !== null;
}

function hasNonContentOnlyRecoveryTurn(turn: PreparedLosslessTurnTape["turn"]): boolean {
  return turn.payload.waiveReason !== undefined ||
    turn.payload.clientMessageId !== undefined ||
    turn.payload.requestId !== undefined ||
    turn.payload.goalId !== undefined ||
    turn.payload.goalStateRevision !== undefined ||
    turn.engineBillings.length !== 0;
}

export async function verifyRecoveryContentOnlyPayload(
  client: PoolClient,
  userId: string,
  request: LosslessTurnTapeFinalizeRequest,
  recoveryLink: TurnTapeRecoveryLinkRow,
  tape: FinalizeTapeRow,
  source: FinalizeTapeRow,
  turn: PreparedLosslessTurnTape["turn"],
  existingMessages: ReadonlyArray<MessageLike>,
): Promise<void> {
  if (hasNonContentOnlyRecoveryHeader(request, tape) || hasNonContentOnlyRecoveryTurn(turn)) {
    throw new Error("turn tape recovery payload is not content-only");
  }
  if (turn.billingAnchorId !== source.billing_anchor_id) {
    throw new Error("turn tape recovery billing anchor does not match source");
  }
  const sourceAnchors = existingMessages.filter(
    (message) => message?._turnTapeId === recoveryLink.source_tape_id,
  );
  if (
    sourceAnchors.length !== 1 ||
    sourceAnchors[0]?._turnTapeComplete !== true ||
    sourceAnchors[0]?.id !== source.billing_anchor_id
  ) {
    throw new Error("turn tape recovery source no longer owns one complete hot anchor");
  }
  const sourceUsage = await readRecoverySourceUsage(
    client,
    request.sessionId,
    userId,
    recoveryLink.source_tape_id,
    source.billing_anchor_id!,
  );
  assertRecoveryUsageFallback(turn.payload.usage, sourceUsage);
}
