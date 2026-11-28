import type { Pool } from "pg";
import { isClientMessageId } from "@openclaude/protocol";
import {
  persistPermissionAuthority,
  resolvePermissionExpiresAt,
  settlePermissionPromptFromRuntime,
} from "../../dispatch/turnControlStore.js";
import { isPlainRecord } from "../bridgeInputGuards.js";
import type { OutboundFrameAccessor } from "../outboundFrameDecode.js";
import { applyStatusFrame, parseStatusFrame } from "../sessionRepoBindBridge.js";
import {
  extractFirstVisibleAttribution,
  recordTurnFirstVisible,
} from "../turnPerformance.js";
import { releaseCodexTurnState } from "./connectionCodexState.js";
import { POST_FINAL_GRACE_MS } from "./constants.js";
import type { BridgeConnectionCtx, DurableStampedFrame } from "./types.js";
import { codexPeerKey } from "./wireHelpers.js";

function buildPermissionRequestCommit(
  ctx: BridgeConnectionCtx,
  pool: Pool,
  parsed: Record<string, unknown>,
): (() => Promise<void>) | null {
  if (
    parsed.type !== "outbound.permission_request" ||
    typeof parsed.requestId !== "string" ||
    typeof parsed.toolName !== "string" ||
    !isPlainRecord(parsed.peer) ||
    typeof parsed.peer.id !== "string" ||
    !isPlainRecord(parsed.inputJson)
  ) {
    return null;
  }
  const input = {
    userId: ctx.uid,
    requestId: parsed.requestId,
    sessionId: parsed.peer.id,
    clientMessageId: isClientMessageId(parsed.clientMessageId) ? parsed.clientMessageId : null,
    toolUseId: typeof parsed.toolUseId === "string" ? parsed.toolUseId : null,
    toolName: parsed.toolName,
    input: parsed.inputJson,
    askPayload: parsed.toolName === "AskUserQuestion" ? parsed.inputJson : null,
    expiresAt: resolvePermissionExpiresAt(parsed.expiresAt),
  };
  return () => persistPermissionAuthority(pool, input).then(() => {});
}

function handlePermissionSettledFrame(
  ctx: BridgeConnectionCtx,
  pool: Pool,
  parsed: Record<string, unknown>,
): void {
  if (
    parsed.type !== "outbound.permission_settled" ||
    typeof parsed.requestId !== "string" ||
    (parsed.behavior !== "allow" && parsed.behavior !== "deny") ||
    !isPlainRecord(parsed.peer) ||
    typeof parsed.peer.id !== "string"
  ) {
    return;
  }
  const settledRequestId = parsed.requestId;
  const settledSessionId = parsed.peer.id;
  const settledBehavior = parsed.behavior;
  const settledReason = typeof parsed.reason === "string" ? parsed.reason : "unknown";
  const settledAnswers = isPlainRecord(parsed.answers)
    ? Object.fromEntries(
        Object.entries(parsed.answers).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : null;
  void settlePermissionPromptFromRuntime(pool, {
    userId: ctx.uid,
    sessionId: settledSessionId,
    requestId: settledRequestId,
    behavior: settledBehavior,
    reason: settledReason,
    answers: settledAnswers,
  })
    .then((closed) => {
      if (closed) {
        ctx.bridgeLog?.info("user-chat-bridge: runtime settlement closed durable permission prompt", {
          sessionId: settledSessionId,
          requestId: settledRequestId,
          behavior: settledBehavior,
          reason: settledReason,
        });
      }
    })
    .catch((error) => {
      ctx.bridgeLog?.warn("user-chat-bridge: durable permission settlement failed", {
        sessionId: settledSessionId,
        requestId: settledRequestId,
        err: (error as Error)?.message ?? String(error),
      });
    });
}

export function handlePermissionOutboundFrames(
  ctx: BridgeConnectionCtx,
  frameText: string,
  frame: OutboundFrameAccessor,
): (() => Promise<void>) | null {
  const pool = ctx.shared.deps.pgPool;
  if (!pool) return null;
  if (frameText.includes('"outbound.permission_request"')) {
    const parsed = frame.getParsedTextFrame();
    return isPlainRecord(parsed) ? buildPermissionRequestCommit(ctx, pool, parsed) : null;
  }
  if (frameText.includes('"outbound.permission_settled"')) {
    const parsed = frame.getParsedTextFrame();
    if (isPlainRecord(parsed)) handlePermissionSettledFrame(ctx, pool, parsed);
  }
  return null;
}

function observeRepoStatusAndGrace(
  ctx: BridgeConnectionCtx,
  frameText: string,
  frame: OutboundFrameAccessor,
): void {
  if (ctx.turnActiveUntil > 0 && frameText.includes('"isFinal":true')) {
    ctx.turnActiveUntil = Math.min(ctx.turnActiveUntil, Date.now() + POST_FINAL_GRACE_MS);
  }
  if (!frameText.includes('"outbound.control.session_repo_status"') || !ctx.shared.deps.pgPool) {
    return;
  }
  const parsedStatus = frame.getParsedTextFrame();
  const statusFrame =
    parsedStatus !== null && typeof parsedStatus === "object" ? parseStatusFrame(parsedStatus) : null;
  if (statusFrame === null) return;
  const pool = ctx.shared.deps.pgPool;
  void applyStatusFrame(pool, Number(ctx.uid), statusFrame)
    .then((r) => {
      ctx.bridgeLog?.info("user-chat-bridge: repo_status_forwarded", {
        sessionId: statusFrame.sessionId,
        selectionVersion: statusFrame.selectionVersion,
        status: statusFrame.status,
        errorCode: statusFrame.errorCode,
        dbUpdated: r.dbUpdated,
        revoked: r.revoked,
      });
    })
    .catch((err) => {
      ctx.bridgeLog?.warn("user-chat-bridge: applyStatusFrame failed", {
        sessionId: statusFrame.sessionId,
        err,
      });
    });
}

function observeFirstVisibleMetrics(
  ctx: BridgeConnectionCtx,
  parsedMasterFrameCandidate: unknown,
): void {
  const firstVisible = extractFirstVisibleAttribution(parsedMasterFrameCandidate);
  if (!firstVisible) return;
  if (ctx.firstContainerFrameAtMs === null && ctx.firstUserFrameAtMs !== null) {
    ctx.firstContainerFrameAtMs = Date.now();
    ctx.shared.metrics.onTtft?.(
      ctx.uid,
      ctx.ttftKind,
      (ctx.firstContainerFrameAtMs - ctx.firstUserFrameAtMs) / 1000,
    );
  }
  if (!ctx.shared.deps.pgPool || !ctx.firstVisiblePersist.begin(firstVisible.traceId)) return;
  const cmid =
    parsedMasterFrameCandidate && typeof parsedMasterFrameCandidate === "object"
      ? (parsedMasterFrameCandidate as { clientMessageId?: unknown }).clientMessageId
      : undefined;
  const firstVisibleDispatchId = isClientMessageId(cmid)
    ? (ctx.admittedDispatches.get(cmid)?.dispatchId ??
        ctx.enrichmentDispatches.get(cmid)?.record.dispatchId ??
        null)
    : null;
  recordTurnFirstVisible(
    ctx.shared.deps.pgPool,
    (message, fields) => ctx.bridgeLog?.warn(message, fields),
    { ...firstVisible, dispatchId: firstVisibleDispatchId },
    (ok) => ctx.firstVisiblePersist.settle(firstVisible.traceId, ok),
  );
}

function observeGoalEngineMetrics(ctx: BridgeConnectionCtx, frame: OutboundFrameAccessor): void {
  try {
    const parsedGoal = frame.getParsedTextFrame();
    if (parsedGoal === null || typeof parsedGoal !== "object") return;
    const goalFrame = parsedGoal as {
      type?: unknown;
      peer?: { id?: unknown };
      blocks?: Array<Record<string, unknown>>;
    };
    const sessionId = goalFrame.peer?.id;
    if (goalFrame.type !== "outbound.message" || typeof sessionId !== "string") return;
    for (const block of goalFrame.blocks ?? []) {
      if (
        block.kind !== "goal" ||
        typeof block.platformGoalId !== "string" ||
        typeof block.platformStateRevision !== "number"
      ) {
        continue;
      }
      const rawDt =
        typeof block.updatedAt === "number" && Number.isFinite(block.updatedAt)
          ? new Date(block.updatedAt * 1000)
          : null;
      const engineUpdatedAt =
        rawDt && !Number.isNaN(rawDt.getTime()) ? rawDt.toISOString() : undefined;
      void ctx.shared.deps
        .updateGoalEngineMetrics!({
          uid: ctx.uid,
          sessionId,
          goalId: block.platformGoalId,
          stateRevision: block.platformStateRevision,
          ...(typeof block.status === "string" ? { engineStatus: block.status } : {}),
          ...(typeof block.tokensUsed === "number" ? { tokensUsed: block.tokensUsed } : {}),
          ...(typeof block.timeUsedSeconds === "number"
            ? { timeUsedSeconds: block.timeUsedSeconds }
            : {}),
          ...(engineUpdatedAt ? { engineUpdatedAt } : {}),
        })
        .catch((err) => {
          ctx.bridgeLog?.warn("user-chat-bridge: goal engine metrics update failed", { err });
        });
    }
  } catch (err) {
    ctx.bridgeLog?.warn("user-chat-bridge: goal engine metrics parse failed", { err });
  }
}

function releaseCodexTurnOnTerminalOutbound(
  ctx: BridgeConnectionCtx,
  frame: OutboundFrameAccessor,
): void {
  const parsedOut = frame.getParsedTextFrame();
  if (parsedOut === null || typeof parsedOut !== "object") return;
  const obj = parsedOut as {
    type?: unknown;
    isFinal?: unknown;
    peer?: { id?: unknown };
    clientMessageId?: unknown;
  };
  const peerId =
    obj.peer && typeof obj.peer === "object" && typeof obj.peer.id === "string"
      ? obj.peer.id
      : null;
  const isFinalMsg = obj.type === "outbound.message" && obj.isFinal === true;
  const isErr = obj.type === "outbound.error";
  if ((!isFinalMsg && !isErr) || peerId === null) return;
  const state = ctx.activeCodexTurnsByPeer.get(codexPeerKey(peerId));
  if (state === undefined) return;
  const terminalCmid = isClientMessageId(obj.clientMessageId) ? obj.clientMessageId : null;
  const exactMatch = terminalCmid !== null && state.clientMessageId === terminalCmid;
  const legacyMatch = terminalCmid === null && state.clientMessageId === null;
  if (exactMatch || legacyMatch) {
    releaseCodexTurnState(ctx, state, isFinalMsg ? "turn_final" : "turn_error");
  }
}

function extractDurableStampedFrame(
  ctx: BridgeConnectionCtx,
  frameText: string | null,
  frame: OutboundFrameAccessor,
): DurableStampedFrame | null {
  if (ctx.containerId === undefined || frameText === null) return null;
  const parsedOut = frame.getParsedTextFrame();
  if (parsedOut === null || typeof parsedOut !== "object") return null;
  const wire = parsedOut as {
    type?: unknown;
    isFinal?: unknown;
    sessionKey?: unknown;
    frameSeq?: unknown;
    clientMessageId?: unknown;
    peer?: { id?: unknown };
  };
  if (
    typeof wire.sessionKey !== "string" ||
    typeof wire.frameSeq !== "number" ||
    !Number.isSafeInteger(wire.frameSeq) ||
    wire.frameSeq <= 0
  ) {
    return null;
  }
  return {
    storeKey: `${ctx.uid.toString()}:${ctx.containerId.toString()}:${wire.sessionKey}`,
    sessionId:
      wire.peer && typeof wire.peer === "object" && typeof wire.peer.id === "string"
        ? wire.peer.id
        : null,
    clientMessageId: isClientMessageId(wire.clientMessageId) ? wire.clientMessageId : null,
    sessionKey: wire.sessionKey,
    frameSeq: wire.frameSeq,
    payload: frameText,
    isFinal: wire.type === "outbound.message" && wire.isFinal === true,
  };
}

export function observeOutboundSideChannels(
  ctx: BridgeConnectionCtx,
  frameText: string | null,
  frame: OutboundFrameAccessor,
  parsedMasterFrameCandidate: unknown,
): DurableStampedFrame | null {
  if (frameText !== null) observeRepoStatusAndGrace(ctx, frameText, frame);
  observeFirstVisibleMetrics(ctx, parsedMasterFrameCandidate);
  ctx.responseMilestoneTracker.observe(
    parsedMasterFrameCandidate,
    ctx.shared.deps.pgPool,
    (message, fields) => ctx.bridgeLog?.warn(message, fields),
  );
  if (frameText !== null) {
    if (ctx.shared.deps.updateGoalEngineMetrics && frameText.includes('"kind":"goal"')) {
      observeGoalEngineMetrics(ctx, frame);
    }
    const parsedHandoff = frame.getParsedTextFrame();
    if (parsedHandoff !== null && typeof parsedHandoff === "object") {
      ctx.shared.browserHandoffObserver.observeOutboundFrame(ctx.uid.toString(), parsedHandoff);
    }
    if (
      ctx.activeCodexTurnsByPeer.size > 0 &&
      (frameText.includes('"isFinal":true') || frameText.includes('"outbound.error"'))
    ) {
      releaseCodexTurnOnTerminalOutbound(ctx, frame);
    }
  }
  return extractDurableStampedFrame(ctx, frameText, frame);
}
