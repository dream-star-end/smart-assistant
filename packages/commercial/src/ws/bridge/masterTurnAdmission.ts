import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  AUTOMATIC_TURN_RETRY_MAX,
  computeDispatchRequestHash,
  isCc5TestModel,
  isClientMessageId,
  parseSessionWorkspaceMode,
  parseSwarmSlashCommand,
  turnRecoveryAttemptIdentity,
  turnRecoveryIdentity,
  type DispatchRequestContent,
  type MessageReplyQuote,
  type SessionWorkspaceMode,
} from "@openclaude/protocol";
import type { AdmitUserTurnInput, AdmitUserTurnResult } from "../../db/pgSessionsBackend.js";
import { snapshotAdmissionRequest } from "../../dispatch/admissionRestartRecovery.js";
import { casToTerminal } from "../../dispatch/turnDispatchStore.js";
import { pauseRecoveryForRefusal, type ClaimedRecoveryJob } from "../../dispatch/turnRecoveryStore.js";
import type { Logger } from "../../logging/logger.js";
import { boundedSetAdd } from "../outboundFrameDecode.js";
import { recoveryJobStatus } from "../recoveryPresentation.js";
import { admittedTraceIdentity, updateTurnTraceDispatch } from "../turnTraces.js";
import { sendErrorFrame } from "../userErrorFrames.js";
import {
  ensureDispatchHeartbeat,
  isEnriching,
  terminalizeEnrichmentDispatch,
  trackEnrichmentDispatch,
} from "./connectionDispatch.js";
import type {
  AdmittedDispatch,
  BridgeConnectionCtx,
  EnrichmentDispatchState,
} from "./types.js";
import {
  _isAuthorizedRecoveryNativeReset,
  ensureRequestIdServerSide,
  sendJsonSafely,
  sendSessionDeletedFrame,
} from "./wireHelpers.js";

const NON_ADMITTED_ERROR_MAP: Readonly<Record<string, [string, string]>> = {
  previously_failed: ["TURN_PREVIOUSLY_FAILED", "this message previously failed; resend to retry"],
  manual_hold: ["TURN_MANUAL_HOLD", "正在人工核对，请稍后"],
  immutable_conflict: ["TURN_IMMUTABLE_CONFLICT", "message content changed for the same id"],
  session_busy: ["TURN_IN_FLIGHT", "another turn is already running in this session"],
};

export function sendAdmissionAck(
  ctx: BridgeConnectionCtx,
  frameObj: Record<string, unknown>,
  peerId: string,
  clientMessageId: string | null,
): void {
  if (clientMessageId === null) return;
  const idempotencyKey =
    typeof frameObj.idempotencyKey === "string" ? frameObj.idempotencyKey : undefined;
  sendJsonSafely(ctx.userWs, {
    type: "outbound.ack",
    admitted: true,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    peer: { id: peerId, kind: "dm" },
    clientMessageId,
  });
}

export function sendRecoverySkippedAck(
  ctx: BridgeConnectionCtx,
  frameObj: Record<string, unknown>,
  recovery: Record<string, unknown> | null,
  peerId: string,
  clientMessageId: string | null,
  recoveryJob: ClaimedRecoveryJob | undefined,
  turnLog: Logger | null,
  reason: string,
): void {
  if (clientMessageId === null) return;
  const idempotencyKey =
    typeof frameObj.idempotencyKey === "string" ? frameObj.idempotencyKey : undefined;
  try {
    if (ctx.skippedRecoveryIds.has(clientMessageId)) {
      turnLog?.info("user-chat-bridge: stopped legacy rejected-recovery retry loop", {
        sessionId: peerId,
        clientMessageId,
      });
    }
    boundedSetAdd(ctx.skippedRecoveryIds, clientMessageId, 512);
    const payload = {
      type: "outbound.ack",
      recoverySkipped: true,
      recoverySkippedReason: reason,
      ...(isClientMessageId(recovery?.sourceClientMessageId)
        ? { sourceClientMessageId: recovery.sourceClientMessageId }
        : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      peer: { id: peerId, kind: "dm" },
      clientMessageId,
    };
    if (recoveryJob) ctx.shared.broadcastToUser(ctx.uid, payload);
    else ctx.userWs.send(JSON.stringify(payload));
    const feBuild = ctx.shared.deps.getFrontendBuildId?.();
    if (feBuild) ctx.userWs.send(JSON.stringify({ type: "sys.frontend_build", build: feBuild }));
  } catch (err) {
    void err;
  }
}

export async function fenceAdmissionCanonicalModel(
  ctx: BridgeConnectionCtx,
  historyModel: string | null,
  peerId: unknown,
  clientMessageId: string | null,
  pretrackedEnrichment: EnrichmentDispatchState | undefined,
  onReject?: (code: string) => void,
): Promise<boolean> {
  let admissionCanonical = historyModel;
  let cc5AdmissionError: string | null = null;
  if (ctx.authorityDeps !== undefined && historyModel !== null) {
    try {
      admissionCanonical = (await ctx.authorityDeps.catalog.assertFresh()).aliasToCanonical(
        historyModel,
      );
    } catch (err) {
      void err;
      cc5AdmissionError = "MODEL_AUTHORITY_UNAVAILABLE";
    }
  }
  if (cc5AdmissionError === null && isCc5TestModel(admissionCanonical)) {
    cc5AdmissionError = "UNAUTHORIZED_MODEL";
  }
  if (cc5AdmissionError === null) return !ctx.cleaned;
  if (pretrackedEnrichment) {
    terminalizeEnrichmentDispatch(ctx, pretrackedEnrichment, cc5AdmissionError);
  }
  onReject?.(cc5AdmissionError);
  if (!ctx.cleaned && ctx.userWs.readyState === WebSocket.OPEN) {
    sendErrorFrame(ctx.userWs, cc5AdmissionError, "model authorization unavailable", {
      ...(typeof peerId === "string" ? { peerId } : {}),
      ...(clientMessageId !== null ? { clientMessageId } : {}),
    });
  }
  return false;
}

function computeRecoveryAllowedKeys(
  automatic: unknown,
  legacyAutomatic: boolean,
  hasRecoveryJob: boolean,
): string[] {
  if (automatic !== true || legacyAutomatic) {
    return ["sourceClientMessageId", "mode", "automatic"];
  }
  return [
    "sourceClientMessageId",
    "mode",
    "automatic",
    "rootClientMessageId",
    "attempt",
    "max",
    ...(hasRecoveryJob ? ["resetNativeSession"] : []),
  ];
}

function isAutoRecoveryFieldsInvalid(
  automatic: unknown,
  legacyAutomatic: boolean,
  normalizedRoot: unknown,
  normalizedAttempt: unknown,
  max: unknown,
): boolean {
  if (automatic !== true || legacyAutomatic) return false;
  return (
    !isClientMessageId(normalizedRoot) ||
    !Number.isSafeInteger(normalizedAttempt) ||
    Number(normalizedAttempt) < 1 ||
    Number(normalizedAttempt) > AUTOMATIC_TURN_RETRY_MAX ||
    max !== AUTOMATIC_TURN_RETRY_MAX
  );
}

function computeExpectedRecoveryIdentity(
  peerId: string,
  automatic: unknown,
  normalizedRoot: unknown,
  normalizedAttempt: unknown,
  sourceClientMessageId: unknown,
): { clientMessageId: string; idempotencyKey: string } | null {
  if (automatic === true && typeof normalizedRoot === "string" && typeof normalizedAttempt === "number") {
    return turnRecoveryAttemptIdentity(peerId, normalizedRoot, normalizedAttempt);
  }
  if (typeof sourceClientMessageId === "string") {
    return turnRecoveryIdentity(peerId, sourceClientMessageId);
  }
  return null;
}

export function validateRecoveryMetadata(
  frameObj: Record<string, unknown>,
  recovery: Record<string, unknown> | null,
  peerId: string,
  clientMessageId: string | null,
  recoveryJob: ClaimedRecoveryJob | undefined,
): { ok: true; value: AdmitUserTurnInput["recovery"] } | { ok: false } {
  if (!recovery || clientMessageId === null) return { ok: false };
  const { sourceClientMessageId, mode, automatic, resetNativeSession } = recovery;
  const legacyAutomatic =
    automatic === true &&
    recovery.rootClientMessageId === undefined &&
    recovery.attempt === undefined &&
    recovery.max === undefined;
  const normalizedRoot = legacyAutomatic ? sourceClientMessageId : recovery.rootClientMessageId;
  const normalizedAttempt = legacyAutomatic ? 1 : recovery.attempt;
  const identity = computeExpectedRecoveryIdentity(
    peerId, automatic, normalizedRoot, normalizedAttempt, sourceClientMessageId,
  );
  const masterScheduledReset = _isAuthorizedRecoveryNativeReset({
    automatic, legacyAutomatic, resetNativeSession, hasRecoveryJob: recoveryJob !== undefined,
  });
  const allowedKeys = computeRecoveryAllowedKeys(automatic, legacyAutomatic, recoveryJob !== undefined);
  const autoInvalid = isAutoRecoveryFieldsInvalid(
    automatic, legacyAutomatic, normalizedRoot, normalizedAttempt, recovery.max,
  );
  const basicInvalid =
    !isClientMessageId(sourceClientMessageId) ||
    (mode !== "checkpoint" && mode !== "replay") ||
    typeof automatic !== "boolean";
  if (
    basicInvalid ||
    autoInvalid ||
    (resetNativeSession !== undefined && !masterScheduledReset) ||
    Object.keys(recovery).some((key) => !allowedKeys.includes(key)) ||
    identity?.clientMessageId !== clientMessageId ||
    identity?.idempotencyKey !== frameObj.idempotencyKey
  ) {
    return { ok: false };
  }
  const value: AdmitUserTurnInput["recovery"] = automatic
    ? {
        sourceClientMessageId,
        mode,
        automatic: true,
        rootClientMessageId: normalizedRoot as string,
        attempt: normalizedAttempt as number,
        max: AUTOMATIC_TURN_RETRY_MAX,
        ...(masterScheduledReset ? { resetNativeSession: true } : {}),
      }
    : { sourceClientMessageId, mode, automatic: false };
  return { ok: true, value };
}

function buildMasterUserRouting(
  frameObj: Record<string, unknown>,
  persistedSwarmMode: boolean | undefined,
): {
  model?: string;
  modelSwitchConsent?: string;
  modelSwitchId?: string;
  teamMode: boolean;
  swarmMode?: boolean;
  effortLevel: string | null;
} {
  return {
    ...(typeof frameObj.model === "string" && frameObj.model !== "" ? { model: frameObj.model } : {}),
    ...(typeof frameObj.modelSwitchConsent === "string"
      ? { modelSwitchConsent: frameObj.modelSwitchConsent }
      : {}),
    ...(typeof frameObj.modelSwitchId === "string" ? { modelSwitchId: frameObj.modelSwitchId } : {}),
    teamMode: frameObj.teamMode === true,
    ...(persistedSwarmMode !== undefined ? { swarmMode: persistedSwarmMode } : {}),
    effortLevel:
      typeof frameObj.effortLevel === "string" || frameObj.effortLevel === null
        ? frameObj.effortLevel
        : null,
  };
}

function extractMasterMessageContent(frameObj: Record<string, unknown>) {
  const content =
    frameObj.content && typeof frameObj.content === "object"
      ? (frameObj.content as {
          text?: unknown;
          displayText?: unknown;
          media?: unknown;
          imageEdit?: unknown;
        })
      : {};
  const rawMedia = Array.isArray(content.media) ? content.media : [];
  const persistedMedia = rawMedia.filter(
    (item) => !item || typeof item !== "object" || (item as { hidden?: unknown }).hidden !== true,
  );
  const modelText =
    typeof frameObj.content === "string"
      ? frameObj.content
      : typeof content.text === "string"
        ? content.text
        : "";
  const displayText = typeof content.displayText === "string" ? content.displayText : modelText;
  const rawImageEdit =
    content.imageEdit && typeof content.imageEdit === "object" && !Array.isArray(content.imageEdit)
      ? (content.imageEdit as Record<string, unknown>)
      : undefined;
  return { rawMedia, persistedMedia, modelText, displayText, rawImageEdit };
}

function buildMasterUserMessage(
  frameObj: Record<string, unknown>,
  clientMessageId: string,
  replyTo: MessageReplyQuote | undefined,
  recoveryJob: ClaimedRecoveryJob | undefined,
) {
  const { rawMedia, persistedMedia, modelText, displayText, rawImageEdit } =
    extractMasterMessageContent(frameObj);
  const slashSwarmMatched = Boolean(parseSwarmSlashCommand(modelText)?.matched);
  const persistedSwarmMode: boolean | undefined = slashSwarmMatched
    ? true
    : typeof frameObj.swarmMode === "boolean"
      ? frameObj.swarmMode
      : recoveryJob
        ? undefined
        : false;
  let snapshotFrame: Record<string, unknown>;
  if (persistedSwarmMode !== undefined) {
    snapshotFrame = { ...frameObj, swarmMode: persistedSwarmMode };
  } else {
    const { swarmMode: _omittedSwarmMode, ...rest } = frameObj;
    void _omittedSwarmMode;
    snapshotFrame = rest;
  }
  return {
    id: clientMessageId,
    role: "user" as const,
    text: displayText,
    ts: typeof frameObj.ts === "number" && Number.isFinite(frameObj.ts) ? frameObj.ts : Date.now(),
    ...(persistedMedia.length > 0 ? { _media: persistedMedia } : {}),
    ...(rawImageEdit && rawMedia.length > 0 ? { _retryMedia: rawMedia } : {}),
    ...(rawImageEdit ? { _imageEdit: rawImageEdit } : {}),
    ...(displayText !== modelText ? { _modelText: modelText } : {}),
    ...(replyTo ? { _replyTo: replyTo } : {}),
    _routing: buildMasterUserRouting(frameObj, persistedSwarmMode),
    _admissionRestartRequest: snapshotAdmissionRequest(snapshotFrame),
  };
}

function attachPendingRecoveryAck(
  record: AdmittedDispatch,
  frameObj: Record<string, unknown>,
  frameContent: { displayText?: unknown } | null,
  peerId: string,
  clientMessageId: string,
  admitAgentId: string,
  admitModel: string | null,
  recoveryJob: ClaimedRecoveryJob | undefined,
  validatedRecovery: AdmitUserTurnInput["recovery"],
): void {
  if (!recoveryJob || validatedRecovery?.automatic !== true) return;
  const idempotencyKey =
    typeof frameObj.idempotencyKey === "string" ? frameObj.idempotencyKey : undefined;
  const displayText = typeof frameContent?.displayText === "string" ? frameContent.displayText : undefined;
  record.pendingRecoveryAck = {
    type: "outbound.ack",
    admitted: true,
    retryStatus: recoveryJobStatus(recoveryJob, "scheduled"),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    peer: { id: peerId, kind: "dm" },
    clientMessageId,
    recovery: {
      automatic: true,
      mode: validatedRecovery.mode,
      sourceClientMessageId: validatedRecovery.sourceClientMessageId,
      rootClientMessageId: validatedRecovery.rootClientMessageId,
      attempt: validatedRecovery.attempt,
      max: validatedRecovery.max,
      agentId: admitAgentId,
      ...(admitModel ? { model: admitModel } : {}),
      ...(displayText ? { displayText } : {}),
    },
  };
}

function handleAdmittedDispatchResult(args: {
  ctx: BridgeConnectionCtx;
  admit: Extract<AdmitUserTurnResult, { kind: "admitted" }>;
  frameObj: Record<string, unknown>;
  frameContent: { displayText?: unknown } | null;
  peerId: string;
  clientMessageId: string;
  admitAgentId: string;
  admitModel: string | null;
  requestHash: string;
  traceId: string | null;
  recoveryJob: ClaimedRecoveryJob | undefined;
  validatedRecovery: AdmitUserTurnInput["recovery"];
  turnLog: Logger | null;
  onReject?: (code: string) => void;
}): EnrichmentDispatchState | null {
  const { ctx, admit, peerId, clientMessageId } = args;
  const d = admit.dispatch;
  if (typeof d.ownerId !== "string" || d.ownerId.length === 0) {
    args.onReject?.("DURABLE_DISPATCH_UNAVAILABLE");
    if (ctx.shared.deps.pgPool) {
      void casToTerminal(ctx.shared.deps.pgPool, {
        dispatchId: d.dispatchId,
        outcome: "executed_error",
        failureCode: "dispatch_lease_owner_missing",
        clientNotified: false,
        fromStatuses: ["admitted"],
        expectedEpoch: d.leaseEpoch,
      }).catch((err) => {
        void err;
      });
    }
    return null;
  }
  const admittedRecord: AdmittedDispatch = {
    clientMessageId,
    sessionId: peerId,
    agentId: d.agentId,
    dispatchId: d.dispatchId,
    billingRequestId: d.billingRequestId,
    attemptNo: d.attemptNo,
    leaseEpoch: d.leaseEpoch,
    leaseOwnerId: d.ownerId,
    anchorSeq: d.anchorSeq,
    requestHash: args.requestHash,
    admittedAtMs: Date.now(),
    wireSent: false,
    ...(args.recoveryJob ? { recoveryJob: args.recoveryJob } : {}),
  };
  ctx.admittedDispatches.set(clientMessageId, admittedRecord);
  const state = trackEnrichmentDispatch(ctx, admittedRecord);
  if (args.traceId !== null) {
    updateTurnTraceDispatch(ctx.shared.deps.pgPool, (msg, fields) => args.turnLog?.warn(msg, fields), {
      traceId: args.traceId,
      dispatchId: d.dispatchId,
      requestId: d.billingRequestId,
      identity: admittedTraceIdentity(d),
    });
  }
  if (!isEnriching(state)) return null;
  sendAdmissionAck(ctx, args.frameObj, peerId, clientMessageId);
  attachPendingRecoveryAck(
    admittedRecord,
    args.frameObj,
    args.frameContent,
    peerId,
    clientMessageId,
    args.admitAgentId,
    args.admitModel,
    args.recoveryJob,
    args.validatedRecovery,
  );
  ensureDispatchHeartbeat(ctx);
  return state;
}

function handleNonAdmittedDispatchResult(args: {
  ctx: BridgeConnectionCtx;
  admit: Exclude<AdmitUserTurnResult, { kind: "admitted" }>;
  frameObj: Record<string, unknown>;
  recovery: Record<string, unknown> | null;
  peerId: string;
  clientMessageId: string;
  recoveryJob: ClaimedRecoveryJob | undefined;
  turnLog: Logger | null;
}): void {
  const { ctx, admit, frameObj, peerId, clientMessageId, turnLog } = args;
  const mapped = NON_ADMITTED_ERROR_MAP[admit.kind];
  if (mapped) {
    sendErrorFrame(ctx.userWs, mapped[0], mapped[1], { peerId, clientMessageId });
    return;
  }
  if (admit.kind === "deduplicated") {
    const idempotencyKey =
      typeof frameObj.idempotencyKey === "string" ? frameObj.idempotencyKey : undefined;
    sendJsonSafely(ctx.userWs, {
      type: "outbound.ack",
      deduplicated: true,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      peer: { id: peerId, kind: "dm" },
      clientMessageId,
    });
    turnLog?.info("user-chat-bridge: dispatch deduplicated", { sessionId: peerId, clientMessageId });
    return;
  }
  if (admit.kind === "already_owned" || admit.kind === "in_flight") {
    sendAdmissionAck(ctx, frameObj, peerId, clientMessageId);
    return;
  }
  if (admit.kind === "recovery_conflict") {
    turnLog?.info("user-chat-bridge: recovery skipped after atomic lineage check", {
      sessionId: peerId,
      clientMessageId,
      reason: admit.reason,
    });
    if (args.recoveryJob && ctx.shared.deps.pgPool) {
      void pauseRecoveryForRefusal(
        ctx.shared.deps.pgPool,
        args.recoveryJob,
        `recovery_conflict:${admit.reason}`,
      ).catch((err) => {
        void err;
      });
    }
    sendRecoverySkippedAck(
      ctx, frameObj, args.recovery, peerId, clientMessageId, args.recoveryJob, turnLog, admit.reason,
    );
    return;
  }
  if (admit.kind === "session_deleted") {
    turnLog?.warn("user-chat-bridge: dispatch admission session deleted", {
      sessionId: peerId,
      clientMessageId,
      kind: admit.kind,
    });
    sendSessionDeletedFrame(ctx.userWs, { peerId, clientMessageId });
    return;
  }
  turnLog?.warn("user-chat-bridge: dispatch admission unavailable", {
    sessionId: peerId,
    clientMessageId,
    kind: admit.kind,
  });
  sendErrorFrame(
    ctx.userWs,
    "SESSION_PERSIST_UNAVAILABLE",
    "user message could not be durably admitted; retry safely",
    { peerId, clientMessageId, retryable: true },
  );
}

async function persistLegacyUserMessage(
  ctx: BridgeConnectionCtx,
  peerId: string,
  clientMessageId: string,
  message: ReturnType<typeof buildMasterUserMessage>,
  turnLog: Logger | null,
  onReject?: (code: string) => void,
): Promise<{ ok: true; workspaceMode: SessionWorkspaceMode | null } | { ok: false }> {
  const persist = ctx.shared.deps.persistMasterUserMessage!;
  let persisted = false;
  let lastReason: string | undefined;
  let workspaceMode: SessionWorkspaceMode | null = null;
  for (const delayMs of [0, 50, 150]) {
    if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    if (ctx.cleaned) return { ok: false };
    try {
      const result = await persist(ctx.uid, peerId, message);
      if (result.applied || result.reason === "already_exists") {
        workspaceMode = parseSessionWorkspaceMode(result.workspaceMode);
        persisted = true;
        break;
      }
      lastReason = result.reason;
      if (result.reason !== "session_not_found") break;
    } catch (err) {
      lastReason = (err as Error)?.message ?? String(err);
      break;
    }
  }
  if (!persisted) {
    const deleted = lastReason === "session_deleted";
    onReject?.(deleted ? "SESSION_DELETED" : "SESSION_PERSIST_UNAVAILABLE");
    turnLog?.warn("user-chat-bridge: persist user row before forward failed", {
      sessionId: peerId,
      clientMessageId,
      reason: lastReason,
    });
    if (deleted) sendSessionDeletedFrame(ctx.userWs, { peerId, clientMessageId });
    else {
      sendErrorFrame(
        ctx.userWs,
        "SESSION_PERSIST_UNAVAILABLE",
        "user message could not be durably admitted; retry safely",
        { peerId, clientMessageId, retryable: true },
      );
    }
    return { ok: false };
  }
  return { ok: true, workspaceMode };
}

async function admitDurableUserTurn(args: {
  ctx: BridgeConnectionCtx;
  frameObj: Record<string, unknown>;
  frameContent: { displayText?: unknown } | null;
  recovery: Record<string, unknown> | null;
  message: AdmitUserTurnInput["message"];
  peerId: string;
  clientMessageId: string;
  traceId: string | null;
  validatedRecovery: AdmitUserTurnInput["recovery"];
  recoveryJob: ClaimedRecoveryJob | undefined;
  turnLog: Logger | null;
  onReject?: (code: string) => void;
}): Promise<{
  ok: boolean;
  admittedState: EnrichmentDispatchState | null;
  workspaceMode: SessionWorkspaceMode | null;
}> {
  const { ctx, frameObj, peerId, clientMessageId } = args;
  const admitModel =
    typeof frameObj.model === "string" && frameObj.model !== "" ? frameObj.model : null;
  const admitAgentId =
    typeof frameObj.agentId === "string" && frameObj.agentId !== "" ? frameObj.agentId : "main";
  const requestHash = computeDispatchRequestHash(
    frameObj.content as DispatchRequestContent | null | undefined,
  );
  let admit: AdmitUserTurnResult;
  try {
    admit = await ctx.shared.deps.admitUserTurn!({
      uid: ctx.uid,
      sessionUserId: `c:${ctx.uid.toString()}`,
      sessionId: peerId,
      clientMessageId,
      agentId: admitAgentId,
      model: admitModel,
      requestHash,
      billingRequestId: ensureRequestIdServerSide(),
      dispatchId: randomUUID(),
      ownerId: ctx.connId,
      agentContainerId: ctx.containerId ?? null,
      runtimeKind: ctx.endpoint.desktop ? "desktop" : "docker",
      ...(args.traceId !== null ? { traceId: args.traceId } : {}),
      message: args.message,
      ...(args.validatedRecovery ? { recovery: args.validatedRecovery } : {}),
      ...(args.recoveryJob
        ? {
            recoveryJob: {
              jobId: args.recoveryJob.jobId,
              leaseOwner: args.recoveryJob.leaseOwner,
              leaseEpoch: args.recoveryJob.leaseEpoch,
            },
          }
        : {}),
    });
  } catch (err) {
    args.turnLog?.error("user-chat-bridge: dispatch admission threw", {
      sessionId: peerId,
      clientMessageId,
      err,
    });
    sendErrorFrame(
      ctx.userWs,
      "SESSION_PERSIST_UNAVAILABLE",
      "user message could not be durably admitted; retry safely",
      { peerId, clientMessageId },
    );
    return { ok: false, admittedState: null, workspaceMode: null };
  }
  const workspaceMode =
    "workspaceMode" in admit ? parseSessionWorkspaceMode(admit.workspaceMode) : null;
  if (admit.kind === "admitted") {
    const admittedState = handleAdmittedDispatchResult({
      ctx, admit, frameObj, frameContent: args.frameContent, peerId, clientMessageId,
      admitAgentId, admitModel, requestHash, traceId: args.traceId,
      recoveryJob: args.recoveryJob, validatedRecovery: args.validatedRecovery,
      turnLog: args.turnLog, onReject: args.onReject,
    });
    return { ok: admittedState !== null, admittedState, workspaceMode };
  }
  handleNonAdmittedDispatchResult({
    ctx, admit, frameObj, recovery: args.recovery, peerId, clientMessageId,
    recoveryJob: args.recoveryJob, turnLog: args.turnLog,
  });
  return { ok: false, admittedState: null, workspaceMode };
}

export async function admitOrPersistUserMessage(args: {
  ctx: BridgeConnectionCtx;
  frameObj: Record<string, unknown>;
  frameContent: { displayText?: unknown } | null;
  recovery: Record<string, unknown> | null;
  replyTo: MessageReplyQuote | undefined;
  peerId: string;
  clientMessageId: string;
  traceId: string | null;
  useDispatchAdmission: boolean;
  validatedRecovery: AdmitUserTurnInput["recovery"];
  recoveryJob: ClaimedRecoveryJob | undefined;
  turnLog: Logger | null;
  onReject?: (code: string) => void;
}): Promise<{
  ok: boolean;
  admittedState: EnrichmentDispatchState | null;
  workspaceMode: SessionWorkspaceMode | null;
}> {
  const message = buildMasterUserMessage(
    args.frameObj,
    args.clientMessageId,
    args.replyTo,
    args.recoveryJob,
  );
  if (args.useDispatchAdmission && args.ctx.shared.deps.admitUserTurn) {
    return admitDurableUserTurn({ ...args, message });
  }
  if (args.ctx.shared.deps.persistMasterUserMessage) {
    const res = await persistLegacyUserMessage(
      args.ctx,
      args.peerId,
      args.clientMessageId,
      message,
      args.turnLog,
      args.onReject,
    );
    return res.ok
      ? { ok: true, admittedState: null, workspaceMode: res.workspaceMode }
      : { ok: false, admittedState: null, workspaceMode: null };
  }
  return { ok: true, admittedState: null, workspaceMode: null };
}
