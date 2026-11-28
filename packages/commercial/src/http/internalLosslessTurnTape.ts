import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";
import { z } from "zod";
import {
  LOSSLESS_TURN_TAPE_PART_BYTES,
  LOSSLESS_TURN_TAPE_SHA256_RE,
  LOSSLESS_TURN_TAPE_VERSION,
  type DurableCodexBilling,
  type LosslessTurnTapeFinalizeRequest,
  type LosslessTurnTapePartRequest,
  type LosslessTurnTapeVisibleRequest,
  type TurnWaiveReason,
} from "@openclaude/protocol";
import type {
  LosslessTurnTapeFinalizeResult,
  LosslessTurnTapeStorage,
} from "../db/pgSessionsBackend.js";
import type { TurnWaiverInput, TurnWaiverResult } from "../billing/refund.js";
import type { Logger } from "../logging/logger.js";
import { enqueueAlert } from "../admin/alertOutbox.js";
import { EVENTS } from "../admin/alertEvents.js";
import { REQUEST_ID_HEADER } from "./util.js";
import type { V3SinkPersistOutcome, V3SinkPersistRole } from "../admin/metrics.js";

function isPlainRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

const LosslessTapeBaseSchema = z.object({
  protocolVersion: z.literal(LOSSLESS_TURN_TAPE_VERSION),
  sessionId: z.string().min(8).max(50),
  agentId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  turnIndex: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  status: z.enum(["completed", "interrupted", "crashed"]),
  waiveReason: z.enum([
    "idle_timeout",
    "no_response",
    "platform_authority_expired",
    "turn_limit",
  ] satisfies readonly TurnWaiveReason[]).optional(),
  model: z.string().min(1).max(256).optional(),
  turnKey: z.string().regex(LOSSLESS_TURN_TAPE_SHA256_RE),
  tapeId: z.string().regex(LOSSLESS_TURN_TAPE_SHA256_RE),
  tapeSha256: z.string().regex(LOSSLESS_TURN_TAPE_SHA256_RE),
  totalBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  partCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  createdAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  dispatchId: z.string().uuid().optional(),
  attemptNo: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});

const DurableBillingEntrySchema = z.custom<DurableCodexBilling>(isPlainRecord);

const LosslessTapeSettlementSchema = z.object({
  billingAnchorId: z.string().min(1).max(256),
  requestId: z.string().min(1).max(256).optional(),
  engineBillings: z.array(DurableBillingEntrySchema).default([]),
  text: z.string(),
  ts: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  truncated: z.boolean().optional(),
  errorCode: z.string().min(1).max(256).optional(),
}).strict();

const LosslessTapePartSchema = LosslessTapeBaseSchema.extend({
  action: z.literal("part"),
  partIndex: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  partSha256: z.string().regex(LOSSLESS_TURN_TAPE_SHA256_RE),
  data: z.string().min(1),
  // Rolling compatibility for gateways that copied settlement onto each part; discarded below.
  settlement: LosslessTapeSettlementSchema.optional(),
}).strict();

const LosslessTapeVisibleSchema = LosslessTapeBaseSchema.extend({
  action: z.literal("visible"),
  settlement: LosslessTapeSettlementSchema,
}).strict();

const LosslessTapeFinalizeSchema = LosslessTapeBaseSchema.extend({
  action: z.literal("finalize"),
  settlement: LosslessTapeSettlementSchema.optional(),
}).strict();

export function sendInternalJsonOk(
  res: ServerResponse,
  status: number,
  payload: Record<string, unknown>,
  requestId: string,
): void {
  if (res.headersSent) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body, "utf-8")),
    [REQUEST_ID_HEADER]: requestId,
  });
  res.end(body);
}

export function sendInternalJsonError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  requestId: string,
): void {
  if (res.headersSent) return;
  const body = JSON.stringify({
    error: { code, message },
    request_id: requestId,
  });
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body, "utf-8")),
    [REQUEST_ID_HEADER]: requestId,
  });
  res.end(body);
}

export function isLosslessTurnTapeWireBody(raw: unknown): boolean {
  return isPlainRecord(raw) && raw.protocolVersion === LOSSLESS_TURN_TAPE_VERSION;
}

/** Deterministic immutable conflict patterns (-> 409); everything else retries via 503. */
const IMMUTABLE_TURN_TAPE_CONFLICT_MESSAGE_RE =
  /immutable part (?:manifest )?conflict|finalize header conflict|immutable header conflict|dispatch identity conflict|settlement conflict|engineBillings mismatch|recovery (?:request|source) identity conflict|immutable record identity conflict|immutable model sidecar conflict|immutable lossless cost locator conflict|part hash mismatch|aggregate (?:hash|length) mismatch|envelope\/payload identity mismatch|canonical JSON invalid|storage format is invalid|materialization format changed|derived record write changed|source parts changed during record staging/i;

export function isImmutableTurnTapeConflict(err: unknown): boolean {
  if (isPlainRecord(err) && err.immutableConflict === true) {
    return true;
  }
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return msg !== "" && IMMUTABLE_TURN_TAPE_CONFLICT_MESSAGE_RE.test(msg);
}

export function isTransientTurnTapeStorageError(err: unknown): boolean {
  if (isPlainRecord(err) && err.retryable === true) {
    return true;
  }
  return !isImmutableTurnTapeConflict(err);
}

export interface LosslessTurnTapeRequestArgs {
  raw: unknown;
  userId: string;
  numericUserId: bigint;
  requestId: string;
  res: ServerResponse;
  storage?: LosslessTurnTapeStorage;
  settleCodexBilling?: (userId: bigint, billing: DurableCodexBilling) => Promise<void>;
  applyTurnWaiver?: (input: TurnWaiverInput) => Promise<TurnWaiverResult>;
  broadcastToUser?: (uid: bigint, payload: Record<string, unknown>) => void;
  recordProviderHealth?: (model: string, kind: "timeout") => void;
  onTapeFinalized?: (input: { userId: string; sessionId: string; tapeId: string }) => void;
  userLog: Logger;
  metric: (outcome: V3SinkPersistOutcome, role?: V3SinkPersistRole) => void;
}

type ResolvedTapeArgs = LosslessTurnTapeRequestArgs & { storage: LosslessTurnTapeStorage };

function isLayoutPartCountValid(totalBytes: number, partCount: number): boolean {
  return partCount === Math.ceil(totalBytes / LOSSLESS_TURN_TAPE_PART_BYTES);
}

function broadcastTapeVisibleProjection(
  args: ResolvedTapeArgs,
  body: { sessionId: string; agentId: string; status: string; tapeId: string },
  clientMessageId: string,
  logEvent: string,
): void {
  try {
    args.broadcastToUser?.(args.numericUserId, {
      type: "outbound.message",
      channel: "webchat",
      peer: { id: body.sessionId, kind: "dm" },
      agentId: body.agentId,
      clientMessageId,
      blocks: [],
      isFinal: true,
      meta: {
        reconcile: body.status === "completed" ? "turn_completed" : "interrupted",
        reconcileSource: "tape_commit",
        clientMessageId,
      },
      ts: Date.now(),
    });
  } catch (err) {
    args.userLog.warn(logEvent, {
      tapeId: body.tapeId,
      clientMessageId,
      err: err as Error,
    });
  }
}

function emitLateTapeAlert(sessionId: string, tapeId: string): void {
  void enqueueAlert({
    event_type: EVENTS.OPS_INCIDENT_OPENED,
    severity: "critical",
    title: "late turn tape 迟到(已告知失败却又产出计费内容)",
    body:
      `session \`${sessionId}\` tape \`${tapeId}\`:reconciler 已宣告该 turn ` +
      `not_accepted 并向用户展示终态 error 卡,tape 随后到达。内容已完整 materialize(钱安全 I5),` +
      `dispatch 已转 manual_reconcile、error 卡已撤销。请人工核对计费与用户告知一致性。`,
    payload: { source: "losslessTurnTapeFinalize", kind: "late_tape", session_id: sessionId, tape_id: tapeId },
    dedupe_key: `${EVENTS.OPS_INCIDENT_OPENED}:late_tape:${tapeId}`,
  }).catch(() => {});
}

async function handleLosslessVisibleAction(args: ResolvedTapeArgs): Promise<void> {
  const parsed = LosslessTapeVisibleSchema.safeParse(args.raw);
  if (!parsed.success) {
    args.metric("reject_bad_body");
    sendInternalJsonError(args.res, 400, "INVALID_TURN_TAPE_VISIBLE", "turn tape visible schema rejected", args.requestId);
    return;
  }
  if (!args.storage.commitVisibleLosslessTurnTape) {
    sendInternalJsonError(args.res, 503, "TURN_TAPE_VISIBLE_UNAVAILABLE", "visible commit store unavailable", args.requestId);
    return;
  }
  const body: LosslessTurnTapeVisibleRequest = parsed.data;
  if (!isLayoutPartCountValid(body.totalBytes, body.partCount)) {
    args.metric("reject_bad_body");
    sendInternalJsonError(args.res, 400, "INVALID_TURN_TAPE_LAYOUT", "turn tape visible layout rejected", args.requestId);
    return;
  }
  let result: LosslessTurnTapeFinalizeResult;
  try {
    result = await args.storage.commitVisibleLosslessTurnTape(args.userId, body);
  } catch (err) {
    const transient = isTransientTurnTapeStorageError(err);
    args.userLog.error("lossless_turn_tape_visible_failed", { tapeId: body.tapeId, transient, err: err as Error });
    sendInternalJsonError(
      args.res,
      transient ? 503 : 409,
      transient ? "TURN_TAPE_RETRYABLE" : "TURN_TAPE_CONFLICT",
      transient ? "turn tape visible storage transient failure" : "turn tape visible immutable conflict",
      args.requestId,
    );
    return;
  }
  if (result.applied === "session_not_found") {
    sendInternalJsonError(args.res, 404, "SESSION_NOT_FOUND", "no client_sessions row for sessionId+userId", args.requestId);
    return;
  }
  if (result.applied === "session_deleted") {
    sendInternalJsonError(args.res, 410, "SESSION_DELETED", "client_sessions row is soft-deleted", args.requestId);
    return;
  }
  if (result.applied !== "finalized" && result.applied !== "idempotent") {
    args.userLog.error("lossless_turn_tape_visible_failed", {
      tapeId: body.tapeId,
      transient: true,
      err: new Error("visible commit failed to create immutable tape header"),
    });
    sendInternalJsonError(args.res, 503, "TURN_TAPE_RETRYABLE", "visible commit failed to create immutable tape header", args.requestId);
    return;
  }
  if (result.newlyVisible && result.clientMessageId && !result.dispatchLateTape) {
    broadcastTapeVisibleProjection(args, body, result.clientMessageId, "lossless_turn_tape_visible_broadcast_failed");
  }
  args.metric(result.applied === "idempotent" ? "deduped" : "ok", "assistant");
  sendInternalJsonOk(args.res, 200, {
    ok: true,
    idempotent: result.applied === "idempotent",
    visible: true,
    settlementHandoff: true,
  }, args.requestId);
}

async function handleLosslessPartAction(args: ResolvedTapeArgs): Promise<void> {
  const parsed = LosslessTapePartSchema.safeParse(args.raw);
  if (!parsed.success) {
    args.metric("reject_bad_body");
    sendInternalJsonError(args.res, 400, "INVALID_TURN_TAPE_PART", "turn tape part schema rejected", args.requestId);
    return;
  }
  const { settlement: _ignoredFinalizeOnlySettlement, ...partData } = parsed.data;
  const body: LosslessTurnTapePartRequest = partData;
  if (!isLayoutPartCountValid(body.totalBytes, body.partCount) || body.partIndex >= body.partCount) {
    args.metric("reject_bad_body");
    sendInternalJsonError(args.res, 400, "INVALID_TURN_TAPE_LAYOUT", "turn tape part layout rejected", args.requestId);
    return;
  }
  const bytes = Buffer.from(body.data, "base64");
  const expectedBytes = body.partIndex === body.partCount - 1
    ? body.totalBytes - LOSSLESS_TURN_TAPE_PART_BYTES * (body.partCount - 1)
    : LOSSLESS_TURN_TAPE_PART_BYTES;
  const actualSha = createHash("sha256").update(bytes).digest("hex");
  if (bytes.toString("base64") !== body.data || bytes.length !== expectedBytes || actualSha !== body.partSha256) {
    args.metric("reject_bad_body");
    sendInternalJsonError(args.res, 400, "INVALID_TURN_TAPE_PART", "turn tape part bytes rejected", args.requestId);
    return;
  }
  const partDispatchIdentity = parsed.data.dispatchId !== undefined
    ? { dispatchId: parsed.data.dispatchId, attemptNo: parsed.data.attemptNo ?? 1 }
    : undefined;
  try {
    const result = await args.storage.stageLosslessTurnTapePart(args.userId, body, bytes, partDispatchIdentity);
    if (result.applied === "session_not_found") {
      sendInternalJsonError(args.res, 404, "SESSION_NOT_FOUND", "no client_sessions row for sessionId+userId", args.requestId);
      return;
    }
    if (result.applied === "session_deleted") {
      sendInternalJsonError(args.res, 410, "SESSION_DELETED", "client_sessions row is soft-deleted", args.requestId);
      return;
    }
    sendInternalJsonOk(args.res, 200, { ok: true, idempotent: result.applied === "idempotent" }, args.requestId);
  } catch (err) {
    const transient = isTransientTurnTapeStorageError(err);
    args.userLog.error("lossless_turn_tape_part_failed", {
      tapeId: body.tapeId,
      partIndex: body.partIndex,
      transient,
      err: err as Error,
    });
    sendInternalJsonError(
      args.res,
      transient ? 503 : 409,
      transient ? "TURN_TAPE_RETRYABLE" : "TURN_TAPE_CONFLICT",
      transient ? "turn tape part storage transient failure" : "turn tape immutable data conflict",
      args.requestId,
    );
  }
}

async function settleFinalizeBillings(
  args: ResolvedTapeArgs,
  tapeId: string,
  engineBillings: readonly DurableCodexBilling[],
  settlementHandoff: boolean,
): Promise<boolean> {
  if (engineBillings.length === 0) return true;
  if (!args.settleCodexBilling) {
    if (!settlementHandoff) {
      sendInternalJsonError(args.res, 503, "TURN_TAPE_BILLING_UNAVAILABLE", "durable codex billing settlement unavailable", args.requestId);
      return false;
    }
    return true;
  }
  try {
    for (const billing of engineBillings) {
      await args.settleCodexBilling(args.numericUserId, billing);
    }
    return true;
  } catch (err) {
    args.userLog.error("lossless_turn_tape_billing_settle_failed", { tapeId, err: err as Error });
    if (!settlementHandoff) {
      sendInternalJsonError(args.res, 503, "TURN_TAPE_BILLING_PENDING", "durable codex billing settlement pending", args.requestId);
      return false;
    }
    return true;
  }
}

async function applyFinalizeWaiver(
  args: ResolvedTapeArgs,
  body: LosslessTurnTapeFinalizeRequest,
  settlementHandoff: boolean,
): Promise<{ ok: boolean; waiverResult?: TurnWaiverResult }> {
  if (body.waiveReason === undefined) return { ok: true };
  if (!args.applyTurnWaiver) {
    if (!settlementHandoff) {
      sendInternalJsonError(args.res, 503, "TURN_WAIVER_UNAVAILABLE", "exact turn waiver unavailable", args.requestId);
      return { ok: false };
    }
    return { ok: true };
  }
  let waiverResult: TurnWaiverResult | undefined;
  try {
    waiverResult = await args.applyTurnWaiver({
      userId: args.numericUserId,
      turnKey: body.turnKey,
      reason: body.waiveReason,
      logger: args.userLog,
    });
    if (waiverResult.disposition === "deferred" && !settlementHandoff) {
      sendInternalJsonError(args.res, 503, "TURN_WAIVER_PENDING", "authoritative zero-output proof pending", args.requestId);
      return { ok: false };
    }
  } catch (err) {
    args.userLog.error("lossless_turn_waiver_apply_failed", {
      tapeId: body.tapeId,
      turnKey: body.turnKey,
      reason: body.waiveReason,
      err: err as Error,
    });
    if (!settlementHandoff) {
      sendInternalJsonError(args.res, 503, "TURN_WAIVER_PENDING", "exact refund and receipt pending", args.requestId);
      return { ok: false };
    }
  }
  if (waiverResult?.newlyApplied) {
    try {
      args.broadcastToUser?.(args.numericUserId, {
        type: "outbound.cost_waived",
        sessionId: body.sessionId,
        turnKey: body.turnKey,
        refundedCredits: waiverResult.refundedCredits.toString(),
        balanceAfter: waiverResult.totalAfter === null ? null : waiverResult.totalAfter.toString(),
        reason: body.waiveReason,
        inboxMessageId: waiverResult.inboxMessageId,
      });
    } catch (err) {
      args.userLog.warn("lossless_turn_waiver_broadcast_failed", { turnKey: body.turnKey, err: err as Error });
    }
  }
  return { ok: true, waiverResult };
}

type CommittedFinalizeResult = Extract<
  LosslessTurnTapeFinalizeResult,
  { applied: "finalized" | "idempotent" }
>;

function recordFinalizePostCommitSignals(
  args: ResolvedTapeArgs,
  body: LosslessTurnTapeFinalizeRequest,
  result: CommittedFinalizeResult,
): void {
  if (result.applied === "finalized" && body.waiveReason === "idle_timeout" && body.model) {
    args.recordProviderHealth?.(body.model, "timeout");
  }
  if (result.applied === "finalized") {
    try {
      args.onTapeFinalized?.({ userId: args.userId, sessionId: body.sessionId, tapeId: body.tapeId });
    } catch (err) {
      args.userLog.debug("lossless_turn_tape_nudge_failed", {
        tapeId: body.tapeId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (result.dispatchLateTape) {
    emitLateTapeAlert(body.sessionId, body.tapeId);
  }
}

function sendFinalizePreconditionError(
  args: ResolvedTapeArgs,
  applied: LosslessTurnTapeFinalizeResult["applied"],
): boolean {
  if (applied === "session_not_found") {
    sendInternalJsonError(args.res, 404, "SESSION_NOT_FOUND", "no client_sessions row for sessionId+userId", args.requestId);
    return true;
  }
  if (applied === "session_deleted") {
    sendInternalJsonError(args.res, 410, "SESSION_DELETED", "client_sessions row is soft-deleted", args.requestId);
    return true;
  }
  if (applied === "incomplete") {
    sendInternalJsonError(args.res, 503, "TURN_TAPE_RETRYABLE", "turn tape is not fully staged", args.requestId);
    return true;
  }
  return false;
}

function buildFinalizeSuccessPayload(
  result: CommittedFinalizeResult,
  settlementHandoff: boolean,
  waiverResult: TurnWaiverResult | undefined,
): Record<string, unknown> {
  const waivedFields =
    waiverResult && waiverResult.disposition !== "denied" && waiverResult.disposition !== "deferred"
      ? {
          waived: true,
          refundedCredits: waiverResult.refundedCredits.toString(),
          inboxMessageId: waiverResult.inboxMessageId,
        }
      : {};
  return {
    ok: true,
    idempotent: result.applied === "idempotent",
    recordCount: result.recordCount,
    ...(settlementHandoff ? { settlementHandoff: true } : {}),
    ...waivedFields,
  };
}

async function runFinalizeSettlementAndProjection(
  args: ResolvedTapeArgs,
  body: LosslessTurnTapeFinalizeRequest,
  result: CommittedFinalizeResult,
): Promise<void> {
  recordFinalizePostCommitSignals(args, body, result);
  const skipSyncSettle = result.settlementHandoff === true || result.settlementHeld === true;
  const settlementHandoff = skipSyncSettle || (result.engineBillings.length === 0 && body.waiveReason === undefined);
  if (!skipSyncSettle) {
    const settled = await settleFinalizeBillings(args, body.tapeId, result.engineBillings, settlementHandoff);
    if (!settled) return;
  }
  const waiverOutcome = skipSyncSettle
    ? { ok: true as const, waiverResult: undefined }
    : await applyFinalizeWaiver(args, body, settlementHandoff);
  if (!waiverOutcome.ok) return;
  if (result.newlyVisible && result.clientMessageId && !result.dispatchLateTape) {
    broadcastTapeVisibleProjection(args, body, result.clientMessageId, "lossless_turn_tape_finalize_broadcast_failed");
  }
  args.metric(result.applied === "idempotent" ? "deduped" : "ok", "assistant");
  sendInternalJsonOk(
    args.res,
    200,
    buildFinalizeSuccessPayload(result, settlementHandoff, waiverOutcome.waiverResult),
    args.requestId,
  );
}

async function handleLosslessFinalizeAction(args: ResolvedTapeArgs): Promise<void> {
  const parsed = LosslessTapeFinalizeSchema.safeParse(args.raw);
  if (!parsed.success) {
    args.metric("reject_bad_body");
    sendInternalJsonError(args.res, 400, "INVALID_TURN_TAPE_FINALIZE", "turn tape finalize schema rejected", args.requestId);
    return;
  }
  const body: LosslessTurnTapeFinalizeRequest = parsed.data;
  if (!isLayoutPartCountValid(body.totalBytes, body.partCount)) {
    args.metric("reject_bad_body");
    sendInternalJsonError(args.res, 400, "INVALID_TURN_TAPE_LAYOUT", "turn tape finalize layout rejected", args.requestId);
    return;
  }
  try {
    const result = await args.storage.finalizeLosslessTurnTape(args.userId, body, { materialize: false });
    if (sendFinalizePreconditionError(args, result.applied)) return;
    if (result.applied !== "finalized" && result.applied !== "idempotent") {
      throw new Error("unexpected lossless turn tape finalize result");
    }
    await runFinalizeSettlementAndProjection(args, body, result);
  } catch (err) {
    const transient = isTransientTurnTapeStorageError(err);
    args.userLog.error("lossless_turn_tape_finalize_failed", { tapeId: body.tapeId, transient, err: err as Error });
    sendInternalJsonError(
      args.res,
      transient ? 503 : 409,
      transient ? "TURN_TAPE_RETRYABLE" : "TURN_TAPE_CONFLICT",
      transient ? "turn tape finalize storage transient failure" : "turn tape verification or materialization failed",
      args.requestId,
    );
  }
}

export async function handleLosslessTurnTapeRequest(args: LosslessTurnTapeRequestArgs): Promise<void> {
  if (!args.storage) {
    sendInternalJsonError(args.res, 503, "TURN_TAPE_UNAVAILABLE", "lossless turn tape store unavailable", args.requestId);
    return;
  }
  const resolvedArgs: ResolvedTapeArgs = { ...args, storage: args.storage };
  const action = isPlainRecord(args.raw) ? args.raw.action : undefined;
  if (action === "visible") {
    await handleLosslessVisibleAction(resolvedArgs);
    return;
  }
  if (action === "part") {
    await handleLosslessPartAction(resolvedArgs);
    return;
  }
  if (action === "finalize") {
    await handleLosslessFinalizeAction(resolvedArgs);
    return;
  }
  args.metric("reject_bad_body");
  sendInternalJsonError(args.res, 400, "INVALID_TURN_TAPE_ACTION", "turn tape action rejected", args.requestId);
}
