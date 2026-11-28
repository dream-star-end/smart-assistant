import { WebSocket } from "ws";
import {
  formatMessageReplyPrompt,
  isClientMessageId,
  isCodexEngineModel,
  isCursorContextTier,
  normalizeMessageReplyQuote,
  projectContextWindowForCursorTier,
  type MessageReplyQuote,
  type SessionWorkspaceMode,
} from "@openclaude/protocol";
import { projectContextWindowForRole } from "../../billing/modelRolePolicy.js";
import type { AdmitUserTurnInput } from "../../db/pgSessionsBackend.js";
import { backfillDispatchTraceId } from "../../dispatch/turnDispatchStore.js";
import type { ClaimedRecoveryJob } from "../../dispatch/turnRecoveryStore.js";
import { defaultCutoverInFlightTracker } from "../../logging/cutoverInFlight.js";
import type { Logger } from "../../logging/logger.js";
import { checkModelSwitchFrame } from "../modelSwitchCostGuard.js";
import { admittedTraceIdentity, updateTurnTraceDispatch } from "../turnTraces.js";
import { CROSS_POOL_CHECKPOINT_FIELD } from "../userChatBridgeRemotePoolSeal.js";
import { sendErrorFrame } from "../userErrorFrames.js";
import { resolveTurnExecution } from "./authorityCatalog.js";
import {
  ensureDispatchHeartbeat,
  isEnriching,
  terminalizeEnrichmentDispatch,
  trackEnrichmentDispatch,
} from "./connectionDispatch.js";
import { CLOSE_BRIDGE } from "./constants.js";
import {
  admitOrPersistUserMessage,
  fenceAdmissionCanonicalModel,
  sendRecoverySkippedAck,
  validateRecoveryMetadata,
} from "./masterTurnAdmission.js";
import type { BridgeConnectionCtx, EnrichmentDispatchState } from "./types.js";
import {
  _sanitizeMasterHistoricalMessagesForFrame,
  closeWsSafely,
  resolveTurnGoalState,
  sendJsonSafely,
} from "./wireHelpers.js";

async function loadHistoryForTurn(
  ctx: BridgeConnectionCtx,
  frameObj: Record<string, unknown>,
  peerId: string,
  clientMessageId: string | null,
  historyModel: string | null,
  currentUserText: string,
  turnLog: Logger | null,
): Promise<{ ok: boolean; rawHistory: unknown[] | null }> {
  const { deps } = ctx.shared;
  if (!deps.loadMasterSessionMessages) return { ok: true, rawHistory: null };
  try {
    let contextWindow: number | null = null;
    let engine = historyModel && isCodexEngineModel(historyModel) ? "codex" : "ccb";
    if (ctx.authorityDeps !== undefined) {
      if (historyModel === null) return { ok: false, rawHistory: null };
      let historyTarget = historyModel;
      if (deps.resolveLogicalModelPoolTarget) {
        const snap = await ctx.authorityDeps.catalog.assertFresh();
        const hAgentId =
          typeof frameObj.agentId === "string" && frameObj.agentId.trim()
            ? frameObj.agentId.trim()
            : "main";
        const pr = await deps.resolveLogicalModelPoolTarget({
          rawModelId: historyModel,
          catalogSnapshot: snap,
          isModelAllowed: ctx.modelCheckerHandle
            ? (m) => ctx.modelCheckerHandle!.isAllowed(m)
            : undefined,
          uid: Number(ctx.uid),
          sessionKey: `agent:${hAgentId}:webchat:dm:${peerId.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
        });
        if (pr.ok) historyTarget = pr.canonicalModelId;
      }
      const execution = await resolveTurnExecution(ctx.authorityDeps.catalog, historyTarget);
      contextWindow = projectContextWindowForCursorTier(
        execution.canonicalModel,
        projectContextWindowForRole(
          execution.canonicalModel,
          execution.descriptor.contextWindow,
          ctx.userRole,
        ),
        isCursorContextTier(frameObj.contextTier) ? frameObj.contextTier : null,
      );
      engine = execution.engine;
    }
    const raw = await deps.loadMasterSessionMessages(ctx.uid, peerId, {
      contextWindow,
      engine,
      currentUserText,
      ...(clientMessageId ? { excludeClientMessageId: clientMessageId } : {}),
    });
    if (!Array.isArray(raw)) return { ok: false, rawHistory: null };
    return { ok: true, rawHistory: raw };
  } catch (err) {
    turnLog?.warn("user-chat-bridge: load master history failed", { sessionId: peerId, err });
    return { ok: false, rawHistory: null };
  }
}

async function tryDedupCompletedTurn(
  ctx: BridgeConnectionCtx,
  frameObj: Record<string, unknown>,
  peerId: string,
  clientMessageId: string | null,
  rawHistory: unknown[] | null,
  turnLog: Logger | null,
): Promise<boolean> {
  if (clientMessageId === null) return false;
  let alreadyCompleted = false;
  if (ctx.shared.deps.hasCompletedClientTurn) {
    try {
      alreadyCompleted = await ctx.shared.deps.hasCompletedClientTurn(
        ctx.uid,
        peerId,
        clientMessageId,
      );
    } catch (err) {
      turnLog?.warn("user-chat-bridge: completed-turn lookup failed", {
        sessionId: peerId,
        clientMessageId,
        err,
      });
    }
  } else if (rawHistory !== null) {
    alreadyCompleted = rawHistory.some((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const row = value as Record<string, unknown>;
      return (
        row.role === "assistant" &&
        row._clientMessageId === clientMessageId &&
        row.status === "completed" &&
        row._errorCode === undefined &&
        row._isError !== true
      );
    });
  }
  if (!alreadyCompleted) return false;
  const idempotencyKey =
    typeof frameObj.idempotencyKey === "string" ? frameObj.idempotencyKey : undefined;
  sendJsonSafely(ctx.userWs, {
    type: "outbound.ack",
    deduplicated: true,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    peer: { id: peerId, kind: "dm" },
    clientMessageId,
  });
  turnLog?.info("user-chat-bridge: completed client turn deduplicated", {
    sessionId: peerId,
    clientMessageId,
  });
  return true;
}

async function resolveSessionWorkspaceMode(
  ctx: BridgeConnectionCtx,
  existing: SessionWorkspaceMode | null,
  peerId: string,
  clientMessageId: string | null,
  admittedThisFrame: EnrichmentDispatchState | null,
  turnLog: Logger | null,
  onReject?: (code: string) => void,
): Promise<SessionWorkspaceMode | null> {
  if (existing !== null) return existing;
  if (!ctx.shared.deps.loadSessionWorkspaceMode) return "legacy";
  let mode: SessionWorkspaceMode | null = null;
  try {
    mode = await ctx.shared.deps.loadSessionWorkspaceMode(ctx.uid, peerId);
    if (admittedThisFrame !== null && !isEnriching(admittedThisFrame)) return null;
  } catch (err) {
    turnLog?.error("user-chat-bridge: load session workspace mode failed", { sessionId: peerId, err });
  }
  if (mode === null) {
    onReject?.("SESSION_WORKSPACE_UNAVAILABLE");
    sendErrorFrame(
      ctx.userWs,
      "SESSION_WORKSPACE_UNAVAILABLE",
      "session workspace unavailable; retry this turn shortly",
      { peerId, clientMessageId },
    );
  }
  return mode;
}

function attachSanitizedHistory(
  enriched: Record<string, unknown>,
  rawHistory: unknown[] | null,
  peerId: string,
  clientMessageId: string | null,
  turnLog: Logger | null,
): Record<string, unknown> {
  if (rawHistory === null) return enriched;
  const historical = _sanitizeMasterHistoricalMessagesForFrame(rawHistory, {
    ...(clientMessageId ? { excludeClientMessageId: clientMessageId } : {}),
  });
  if (historical.length === 0) return enriched;
  turnLog?.info("user-chat-bridge: attached master history", {
    sessionId: peerId,
    messageCount: historical.length,
  });
  return { ...enriched, _masterHistoricalMessages: historical };
}

async function loadAndAttachGoalState(args: {
  ctx: BridgeConnectionCtx;
  enriched: Record<string, unknown>;
  peerId: string;
  clientMessageId: string | null;
  admittedRef: { current: EnrichmentDispatchState | null };
  turnLog: Logger | null;
  onReject?: (code: string) => void;
}): Promise<Record<string, unknown> | null> {
  const { ctx, enriched, peerId, clientMessageId, admittedRef, turnLog, onReject } = args;
  if (!ctx.shared.deps.loadGoalState) return enriched;
  const resolved = await resolveTurnGoalState(ctx.shared.deps.loadGoalState, ctx.uid, peerId);
  if (admittedRef.current !== null && !isEnriching(admittedRef.current)) return null;
  if (resolved.kind === "unavailable") {
    onReject?.("GOAL_STATE_UNAVAILABLE");
    turnLog?.error("user-chat-bridge: load platform goal failed; turn rejected", {
      sessionId: peerId,
      err: resolved.err,
    });
    if (!ctx.cleaned && ctx.userWs.readyState === WebSocket.OPEN) {
      sendErrorFrame(
        ctx.userWs,
        "GOAL_STATE_UNAVAILABLE",
        "goal state unavailable, retry this turn shortly",
        { peerId, clientMessageId },
      );
    }
    if (admittedRef.current !== null) {
      const state = admittedRef.current;
      admittedRef.current = null;
      terminalizeEnrichmentDispatch(ctx, state, "goal_state_unavailable");
    }
    return null;
  }
  return { ...enriched, _goalState: resolved.goalState };
}

async function enrichWorkspaceHistoryAndGoal(args: {
  ctx: BridgeConnectionCtx;
  frameObj: Record<string, unknown>;
  peerId: string;
  clientMessageId: string | null;
  historyModel: string | null;
  currentUserText: string;
  useDispatchAdmission: boolean;
  sessionWorkspaceMode: SessionWorkspaceMode | null;
  admittedState: EnrichmentDispatchState | null;
  turnLog: Logger | null;
  onReject?: (code: string) => void;
}): Promise<Record<string, unknown> | null> {
  const { ctx, frameObj, peerId, clientMessageId, turnLog, onReject } = args;
  const admittedRef: { current: EnrichmentDispatchState | null } = { current: args.admittedState };
  try {
    const wsMode = await resolveSessionWorkspaceMode(
      ctx, args.sessionWorkspaceMode, peerId, clientMessageId, admittedRef.current, turnLog, onReject,
    );
    if (wsMode === null) return null;
    const hist = await loadHistoryForTurn(
      ctx, frameObj, peerId, clientMessageId, args.historyModel, args.currentUserText, turnLog,
    );
    if (admittedRef.current !== null && !isEnriching(admittedRef.current)) return null;
    if (!hist.ok && admittedRef.current !== null) {
      onReject?.("HISTORY_ENRICHMENT_UNAVAILABLE");
      const state = admittedRef.current;
      admittedRef.current = null;
      if (
        terminalizeEnrichmentDispatch(ctx, state, "history_enrichment_unavailable") &&
        !ctx.cleaned &&
        ctx.userWs.readyState === WebSocket.OPEN
      ) {
        sendErrorFrame(
          ctx.userWs,
          "HISTORY_ENRICHMENT_UNAVAILABLE",
          "session context is temporarily unavailable; retry this turn",
          { peerId, clientMessageId },
        );
      }
      return null;
    }
    if (
      !args.useDispatchAdmission &&
      (await tryDedupCompletedTurn(ctx, frameObj, peerId, clientMessageId, hist.rawHistory, turnLog))
    ) {
      return null;
    }
    let enriched: Record<string, unknown> = { ...frameObj, _workspaceMode: wsMode };
    Reflect.deleteProperty(enriched, "_masterHistoricalMessages");
    Reflect.deleteProperty(enriched, CROSS_POOL_CHECKPOINT_FIELD);
    enriched = attachSanitizedHistory(enriched, hist.rawHistory, peerId, clientMessageId, turnLog);
    const withGoal = await loadAndAttachGoalState({
      ctx, enriched, peerId, clientMessageId, admittedRef, turnLog, onReject,
    });
    if (withGoal === null) return null;
    if (admittedRef.current !== null) {
      if (!isEnriching(admittedRef.current)) return null;
      ctx.preparedEnrichmentFrames.set(withGoal, admittedRef.current);
    }
    admittedRef.current = null;
    return withGoal;
  } finally {
    if (admittedRef.current !== null) {
      terminalizeEnrichmentDispatch(ctx, admittedRef.current, "history_injection_failed");
    }
  }
}

function parseInboundTurnContent(frameObj: Record<string, unknown>): {
  frameContent: { text?: unknown; displayText?: unknown; replyTo?: unknown; recovery?: unknown } | null;
  rawRecovery: unknown;
  recovery: Record<string, unknown> | null;
  replyTo: MessageReplyQuote | undefined;
  currentUserText: string;
} {
  const frameContent =
    frameObj.content && typeof frameObj.content === "object"
      ? (frameObj.content as { text?: unknown; displayText?: unknown; replyTo?: unknown; recovery?: unknown })
      : null;
  const rawRecovery = frameContent?.recovery;
  const recovery =
    rawRecovery && typeof rawRecovery === "object" && !Array.isArray(rawRecovery)
      ? (rawRecovery as Record<string, unknown>)
      : null;
  const replyTo = normalizeMessageReplyQuote(frameContent?.replyTo);
  const currentUserText = formatMessageReplyPrompt(
    typeof frameObj.content === "string"
      ? frameObj.content
      : typeof frameContent?.text === "string"
        ? frameContent.text
        : "",
    replyTo,
  );
  return { frameContent, rawRecovery, recovery, replyTo, currentUserText };
}

function adoptPreAdmittedEnrichment(args: {
  ctx: BridgeConnectionCtx;
  peerId: string;
  clientMessageId: string | null;
  persistUserRow: boolean;
  traceId: string | null;
  pretrackedEnrichment: EnrichmentDispatchState | undefined;
  turnLog: Logger | null;
}): { ok: boolean; state: EnrichmentDispatchState | null } {
  const { ctx, peerId, clientMessageId, persistUserRow, traceId, pretrackedEnrichment, turnLog } = args;
  let state: EnrichmentDispatchState | null = pretrackedEnrichment ?? null;
  if (state !== null && !isEnriching(state)) return { ok: false, state: null };
  if (clientMessageId !== null && state === null) {
    const preAdmitted = ctx.admittedDispatches.get(clientMessageId);
    if (preAdmitted !== undefined) {
      state = trackEnrichmentDispatch(ctx, preAdmitted);
      if (!isEnriching(state)) return { ok: false, state: null };
      ensureDispatchHeartbeat(ctx);
    }
  }
  if (
    !persistUserRow &&
    pretrackedEnrichment === undefined &&
    state !== null &&
    traceId !== null &&
    state.record.sessionId === peerId
  ) {
    updateTurnTraceDispatch(ctx.shared.deps.pgPool, (msg, fields) => turnLog?.warn(msg, fields), {
      traceId,
      dispatchId: state.record.dispatchId,
      requestId: state.record.billingRequestId,
      identity: admittedTraceIdentity(state.record),
    });
    if (ctx.shared.deps.pgPool) {
      const dispatchId = state.record.dispatchId;
      void backfillDispatchTraceId(ctx.shared.deps.pgPool, { dispatchId, traceId }).catch((err) => {
        turnLog?.warn("user-chat-bridge: dispatch trace backfill failed", { dispatchId, err });
      });
    }
  }
  return { ok: true, state };
}

async function verifyTurnAdmissionGuards(args: {
  ctx: BridgeConnectionCtx;
  frameObj: Record<string, unknown>;
  peerId: string;
  clientMessageId: string | null;
  historyModel: string | null;
  currentUserText: string;
  persistUserRow: boolean;
  useDispatchAdmission: boolean;
  recoveryJob: ClaimedRecoveryJob | undefined;
  pretrackedEnrichment: EnrichmentDispatchState | undefined;
  temporaryImageFeature: boolean;
  turnLog: Logger | null;
  onReject?: (code: string) => void;
}): Promise<boolean> {
  const { ctx, frameObj, peerId, clientMessageId, pretrackedEnrichment, onReject } = args;
  const costRefusal = await checkModelSwitchFrame(
    ctx.shared.deps.modelSwitchCost,
    ctx.uid.toString(),
    frameObj,
    {
      sessionId: peerId,
      requestId: clientMessageId,
      targetModel: args.historyModel,
      text: args.currentUserText,
      temporaryImageFeature: args.temporaryImageFeature,
    },
  );
  if (costRefusal) {
    if (pretrackedEnrichment) terminalizeEnrichmentDispatch(ctx, pretrackedEnrichment, costRefusal.code);
    onReject?.(costRefusal.code);
    sendErrorFrame(ctx.userWs, costRefusal.code, costRefusal.message, {
      peerId,
      clientMessageId: clientMessageId ?? undefined,
      retryable: false,
      action: "retry",
    });
    return false;
  }
  if (args.persistUserRow && args.useDispatchAdmission && clientMessageId !== null) {
    if (ctx.cleaned) return false;
    if (await tryDedupCompletedTurn(ctx, frameObj, peerId, clientMessageId, null, args.turnLog)) {
      return false;
    }
  }
  if (args.recoveryJob && !ctx.shared.isRecoveryJobCurrent(args.recoveryJob)) {
    onReject?.("SERVER_RESTART");
    return false;
  }
  if (args.persistUserRow && defaultCutoverInFlightTracker.isFencing()) {
    onReject?.("SERVER_RESTART");
    if (!args.recoveryJob && pretrackedEnrichment === undefined) {
      sendErrorFrame(ctx.userWs, "SESSION_PERSIST_UNAVAILABLE", "master cutover fencing; retry on new slot", {
        peerId,
        ...(clientMessageId !== null ? { clientMessageId } : {}),
      });
      closeWsSafely(ctx.userWs, CLOSE_BRIDGE.SERVER_RESTART, "server_restart");
    }
    return false;
  }
  return true;
}

export async function attachMasterTurnState(
  ctx: BridgeConnectionCtx,
  frameObj: Record<string, unknown>,
  turnLog: Logger | null,
  traceId: string | null = null,
  persistUserRow = true,
  onReject?: (code: string) => void,
  historyModel: string | null = typeof frameObj.model === "string" ? frameObj.model : null,
  recoveryJob?: ClaimedRecoveryJob,
  pretrackedEnrichment?: EnrichmentDispatchState,
  temporaryImageFeature = false,
): Promise<Record<string, unknown> | null> {
  const peer = frameObj.peer;
  const peerId = peer && typeof peer === "object" ? (peer as { id?: unknown }).id : undefined;
  const clientMessageId = isClientMessageId(frameObj.clientMessageId) ? frameObj.clientMessageId : null;
  if (!(await fenceAdmissionCanonicalModel(ctx, historyModel, peerId, clientMessageId, pretrackedEnrichment, onReject))) {
    return null;
  }
  if (typeof peerId !== "string" || peerId.length === 0) return frameObj;
  const { frameContent, rawRecovery, recovery, replyTo, currentUserText } = parseInboundTurnContent(frameObj);
  const useDispatchAdmission =
    ctx.containerHasDurableDispatch && ctx.shared.deps.admitUserTurn !== undefined;
  let validatedRecovery: AdmitUserTurnInput["recovery"];
  if (rawRecovery !== undefined) {
    const check = validateRecoveryMetadata(frameObj, recovery, peerId, clientMessageId, recoveryJob);
    if (!check.ok) {
      turnLog?.warn("user-chat-bridge: invalid recovery lineage", { sessionId: peerId, clientMessageId });
      sendRecoverySkippedAck(ctx, frameObj, recovery, peerId, clientMessageId, recoveryJob, turnLog, "invalid_lineage");
      return null;
    }
    validatedRecovery = check.value;
    if (!useDispatchAdmission) {
      sendRecoverySkippedAck(ctx, frameObj, recovery, peerId, clientMessageId, recoveryJob, turnLog, "capability_unavailable");
      return null;
    }
  }
  const adopted = adoptPreAdmittedEnrichment({
    ctx, peerId, clientMessageId, persistUserRow, traceId, pretrackedEnrichment, turnLog,
  });
  if (!adopted.ok) return null;
  if (
    !(await verifyTurnAdmissionGuards({
      ctx, frameObj, peerId, clientMessageId, historyModel, currentUserText,
      persistUserRow, useDispatchAdmission, recoveryJob, pretrackedEnrichment,
      temporaryImageFeature, turnLog, onReject,
    }))
  ) {
    return null;
  }
  let admittedThisFrame = adopted.state;
  let sessionWorkspaceMode: SessionWorkspaceMode | null = null;
  if (persistUserRow && clientMessageId !== null && (useDispatchAdmission || ctx.shared.deps.persistMasterUserMessage)) {
    const admitRes = await admitOrPersistUserMessage({
      ctx, frameObj, frameContent, recovery, replyTo, peerId, clientMessageId,
      traceId, useDispatchAdmission, validatedRecovery, recoveryJob, turnLog, onReject,
    });
    if (!admitRes.ok) return null;
    if (admitRes.admittedState !== null) admittedThisFrame = admitRes.admittedState;
    sessionWorkspaceMode = admitRes.workspaceMode;
  }
  return await enrichWorkspaceHistoryAndGoal({
    ctx, frameObj, peerId, clientMessageId, historyModel, currentUserText,
    useDispatchAdmission, sessionWorkspaceMode, admittedState: admittedThisFrame,
    turnLog, onReject,
  });
}
