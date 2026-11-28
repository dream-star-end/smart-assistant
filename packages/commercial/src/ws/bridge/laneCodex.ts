import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  isClientMessageId,
  isGrokEngineModel,
  resolveEffectiveTurnServiceTier,
} from "@openclaude/protocol";
import {
  applyAdmittedServiceTierToFrame,
  extractInboundPromptText,
} from "../../billing/codexServiceTierPricing.js";
import type { Logger } from "../../logging/logger.js";
import { shouldRejectCodexTurnForG7 } from "../modelSwitchCostGuard.js";
import type { PromptQueueDispatchRequest } from "../promptQueueDispatchTypes.js";
import { sendErrorFrame } from "../userErrorFrames.js";
import {
  resolveAuthorityExecOrReject,
  sealAuthorityFieldsOrReject,
} from "./connectionAuthority.js";
import {
  expireCodexRouteToken,
  isCurrentCodexTurnState,
  releaseCodexTurnState,
} from "./connectionCodexState.js";
import {
  dispatchAuthorityField,
  failDispatchPreForward,
  lookupAdmittedDispatch,
  trackSealedMigration,
} from "./connectionDispatch.js";
import { CLOSE_BRIDGE } from "./constants.js";
import { isGrokEngineKind } from "./enginePolicy.js";
import {
  createCodexTurnSnapshot,
  prepareCodexBillingAndPreCheck,
  sealAndForwardBilledCodexTurn,
  startOrReuseCodexInflightJournal,
  type CodexLaneArgs,
  type ResolvedCodexRouteResult,
} from "./laneCodexBilling.js";
import { attachMasterTurnState } from "./masterTurnState.js";
import type {
  ActiveCodexTurnState,
  AdmittedDispatch,
  BridgeConnectionCtx,
  CodexApiRelayRoute,
  ResolvedTurnExecution,
} from "./types.js";
import { closeWsSafely, codexPeerKey } from "./wireHelpers.js";

export type { CodexLaneArgs };

export function reserveCodexTurnSlotOrReject(args: {
  ctx: BridgeConnectionCtx;
  peerId: string | null;
  parsedFrame: Record<string, unknown> | null;
  turnLog: Logger | null;
  isPromptQueueDispatch: boolean;
  dispatchRequest: PromptQueueDispatchRequest | undefined;
  rejectPromptQueueDispatch: (code: string) => void;
}): { state: ActiveCodexTurnState; clientMessageId: string | null } | null {
  const { ctx, peerId, parsedFrame, turnLog, isPromptQueueDispatch } = args;
  const clientMessageId =
    parsedFrame !== null && isClientMessageId(parsedFrame.clientMessageId)
      ? parsedFrame.clientMessageId
      : null;
  const peerKey = codexPeerKey(peerId);
  if (shouldRejectCodexTurnForG7(ctx.activeCodexTurnsByPeer.has(peerKey), isPromptQueueDispatch)) {
    turnLog?.info("user-chat-bridge: codex turn busy, rejecting frame");
    sendErrorFrame(
      ctx.userWs,
      "CODEX_TURN_BUSY",
      "previous codex turn still in progress, wait for completion",
      { peerId, clientMessageId },
    );
    return null;
  }
  if (isPromptQueueDispatch && ctx.activeCodexTurnsByPeer.has(peerKey)) {
    turnLog?.info("user-chat-bridge: queue dispatch waiting for live codex owner", { peerId });
    args.rejectPromptQueueDispatch("EXECUTION_OWNER_BUSY");
    return null;
  }
  const state: ActiveCodexTurnState = {
    stateId: randomUUID(),
    peerKey,
    peerId,
    clientMessageId,
    promptQueueGrantId: args.dispatchRequest?.grantId ?? null,
    engine: "codex",
    acquireInflight: true,
    acquiredAccountId: null,
    acquiredSlotId: null,
    apiRelayRouteToken: null,
    billingRequestId: null,
    turnForwarded: false,
    releaseTimer: null,
    slotHeartbeat: null,
  };
  ctx.activeCodexTurnsByPeer.set(peerKey, state);
  return { state, clientMessageId };
}

function releaseSlotQuietly(
  codexBinding: BridgeConnectionCtx["shared"]["deps"]["codexBinding"],
  accountId: bigint,
  slotId: string,
): void {
  try {
    codexBinding?.release(accountId, slotId);
  } catch (err) {
    void err;
  }
}

async function resolveCodexRouteDecision(
  args: CodexLaneArgs,
  authorityExec: ResolvedTurnExecution | null,
): Promise<{ ok: true; codexRoute: CodexApiRelayRoute | null; officialOAuthGroupId: string | null } | { ok: false }> {
  const { ctx, codexTurnState, cid } = args;
  const { codexBinding, createCodexRoute } = ctx.shared.deps;
  if (createCodexRoute === undefined) {
    return { ok: true, codexRoute: null, officialOAuthGroupId: null };
  }
  if (args.effectiveModelCapture === null) {
    throw new Error("codex route requested without effective model");
  }
  const decision = await createCodexRoute({
    containerId: cid,
    userId: ctx.uid,
    modelId: authorityExec?.canonicalModel ?? args.effectiveModelCapture,
    ...(args.peerIdForAcquire ? { sessionId: args.peerIdForAcquire } : {}),
  });
  if (!isCurrentCodexTurnState(ctx, codexTurnState)) {
    if (decision !== null && decision.kind !== "official_oauth" && decision.kind !== "unavailable") {
      expireCodexRouteToken(ctx, decision.token, "stale_route_creation");
      if (isGrokEngineKind(decision.engine) && decision.accountId && decision.slotId) {
        releaseSlotQuietly(codexBinding, BigInt(decision.accountId), decision.slotId);
      }
    }
    return { ok: false };
  }
  if (decision === null) return { ok: true, codexRoute: null, officialOAuthGroupId: null };
  if (decision.kind === "official_oauth") {
    return { ok: true, codexRoute: null, officialOAuthGroupId: decision.groupId };
  }
  if (decision.kind === "unavailable") {
    throw Object.assign(new Error(decision.reason), { name: "CodexRouteUnavailable" });
  }
  codexTurnState.engine = decision.engine ?? "codex";
  codexTurnState.apiRelayRouteToken = decision.token;
  return { ok: true, codexRoute: decision, officialOAuthGroupId: null };
}

function armCodexSlotTimersAndBuildRouteFrames(
  ctx: BridgeConnectionCtx,
  codexTurnState: ActiveCodexTurnState,
  codexRoute: CodexApiRelayRoute | null,
  officialOAuthGroupId: string | null,
  acquired: { account_id: bigint; slotId: string } | null,
  routeIsGrok: boolean,
): ResolvedCodexRouteResult {
  if (acquired !== null) {
    codexTurnState.acquiredAccountId = acquired.account_id;
    codexTurnState.acquiredSlotId = acquired.slotId;
  }
  codexTurnState.acquireInflight = false;
  if (routeIsGrok) {
    codexTurnState.slotHeartbeat = setInterval(() => {
      const accountId = codexTurnState.acquiredAccountId;
      const slotId = codexTurnState.acquiredSlotId;
      if (accountId !== null && slotId !== null) ctx.shared.deps.codexBinding?.renew?.(accountId, slotId);
    }, 60_000);
    codexTurnState.slotHeartbeat.unref?.();
  } else {
    const sessionMaxMs = ctx.shared.adapters.readCodexSessionMaxMs();
    codexTurnState.releaseTimer = setTimeout(() => {
      releaseCodexTurnState(ctx, codexTurnState, "timeout");
    }, sessionMaxMs);
    codexTurnState.releaseTimer.unref?.();
  }
  const codexRouteFrame =
    codexRoute !== null && !routeIsGrok
      ? {
          baseUrl: codexRoute.baseUrl,
          modelProvider: codexRoute.modelProvider,
          providerName: codexRoute.providerName ?? null,
          wireApi: codexRoute.wireApi ?? "responses",
          preferredAuthMethod: codexRoute.preferredAuthMethod ?? "apikey",
          disableResponseStorage: codexRoute.disableResponseStorage ?? true,
        }
      : officialOAuthGroupId !== null
        ? { kind: "official_oauth" as const }
        : null;
  const grokRouteFrame =
    codexRoute !== null && routeIsGrok
      ? { baseUrl: codexRoute.baseUrl, routeToken: codexRoute.token }
      : null;
  return { codexRoute, officialOAuthGroupId, acquired, codexRouteFrame, grokRouteFrame };
}

async function acquireCodexRouteAndSlot(
  args: CodexLaneArgs,
  authorityExec: ResolvedTurnExecution | null,
): Promise<ResolvedCodexRouteResult | null> {
  const { ctx, codexTurnState, cid } = args;
  const { codexBinding } = ctx.shared.deps;
  const routeChoice = await resolveCodexRouteDecision(args, authorityExec);
  if (!routeChoice.ok) return null;
  const { codexRoute, officialOAuthGroupId } = routeChoice;
  const routeIsGrok = isGrokEngineKind(codexRoute?.engine);
  let acquired: { account_id: bigint; slotId: string } | null =
    routeIsGrok && codexRoute?.accountId && codexRoute?.slotId
      ? { account_id: BigInt(codexRoute.accountId), slotId: codexRoute.slotId }
      : null;
  if (codexRoute === null) {
    if (codexBinding === undefined) {
      throw Object.assign(new Error("no enabled Codex API relay group"), { name: "CodexRouteUnavailable" });
    }
    acquired = await codexBinding.acquire(cid, officialOAuthGroupId);
    if (!isCurrentCodexTurnState(ctx, codexTurnState)) {
      if (acquired !== null) releaseSlotQuietly(codexBinding, acquired.account_id, acquired.slotId);
      return null;
    }
    if (officialOAuthGroupId !== null && acquired === null) {
      throw Object.assign(new Error("selected Codex OAuth group unavailable"), { name: "CodexRouteUnavailable" });
    }
  }
  if (!isCurrentCodexTurnState(ctx, codexTurnState)) {
    if (codexRoute !== null) expireCodexRouteToken(ctx, codexRoute.token, "cleanup_during_route_creation");
    if (acquired !== null) releaseSlotQuietly(codexBinding, acquired.account_id, acquired.slotId);
    return null;
  }
  return armCodexSlotTimersAndBuildRouteFrames(
    ctx, codexTurnState, codexRoute, officialOAuthGroupId, acquired, routeIsGrok,
  );
}

async function sealAndForwardUnbilledCodexTurn(args: {
  lane: CodexLaneArgs;
  preparedInbound: Record<string, unknown>;
  authorityExec: ResolvedTurnExecution | null;
  dispatchRecordB: AdmittedDispatch | undefined;
  routeRes: ResolvedCodexRouteResult;
  sendTurnErrorFrame: (code: string, message: string) => void;
  releaseOnFailure: () => void;
}): Promise<boolean> {
  const { lane, preparedInbound, authorityExec, dispatchRecordB, routeRes } = args;
  const { ctx, codexTurnState, turnLogCapture, turnIdentity } = lane;
  let authorityFields: Record<string, unknown> = {};
  if (authorityExec !== null) {
    const sealed = await sealAuthorityFieldsOrReject(ctx, {
      exec: authorityExec,
      inboundFrame: preparedInbound,
      log: turnLogCapture,
      onReject: lane.rejectPromptQueueDispatch,
      turn: turnIdentity,
      ...(turnIdentity.peerId ? { sessionId: turnIdentity.peerId } : {}),
      historicalMessages: Array.isArray(preparedInbound._masterHistoricalMessages)
        ? (preparedInbound._masterHistoricalMessages as readonly unknown[])
        : undefined,
      ...(turnIdentity.clientMessageId ? { excludeClientMessageId: turnIdentity.clientMessageId } : {}),
      enableCrossPoolCheckpoint: true,
      compensate: () => args.releaseOnFailure(),
    });
    if (sealed === null) return false;
    authorityFields = sealed;
    trackSealedMigration(ctx, dispatchRecordB, turnIdentity.sessionKey, sealed);
  }
  if (!isCurrentCodexTurnState(ctx, codexTurnState)) {
    args.releaseOnFailure();
    return false;
  }
  const legacyTier = ctx.containerHasCodexSpeedTiers
    ? resolveEffectiveTurnServiceTier({
        model: authorityExec?.canonicalModel ?? lane.effectiveModelCapture,
        serviceTier: preparedInbound.serviceTier,
        agentId: lane.inboundAgentIdCapture ?? "main",
        collabMode: preparedInbound.collabMode,
        advisorModel: preparedInbound.advisorModel,
        text: extractInboundPromptText(preparedInbound),
      })
    : null;
  const rewrittenObj = applyAdmittedServiceTierToFrame(
    {
      ...preparedInbound,
      traceId: lane.turnTraceIdCapture!,
      ...(routeRes.codexRouteFrame !== null ? { __oc_codex_route: routeRes.codexRouteFrame } : {}),
      ...(routeRes.grokRouteFrame !== null ? { __oc_grok_route: routeRes.grokRouteFrame } : {}),
      ...authorityFields,
      ...dispatchAuthorityField(ctx, dispatchRecordB),
    },
    legacyTier,
  );
  const rewrittenStr = JSON.stringify(rewrittenObj);
  const rewrittenLen = Buffer.byteLength(rewrittenStr);
  const maxFrameBytes = ctx.shared.config.maxFrameBytes;
  if (rewrittenLen > maxFrameBytes) {
    turnLogCapture?.error("user-chat-bridge: rewritten codex frame too big (no billing)", {
      rewrittenLen,
      max: maxFrameBytes,
    });
    if (!ctx.cleaned && ctx.userWs.readyState === WebSocket.OPEN) {
      args.sendTurnErrorFrame("ERR_FRAME_TOO_BIG", `rewritten frame ${rewrittenLen} > max ${maxFrameBytes}`);
      closeWsSafely(ctx.userWs, CLOSE_BRIDGE.TOO_BIG, "frame too big");
    }
    args.releaseOnFailure();
    return false;
  }
  const forwarded = await lane.forwardPreparedFrame(
    Buffer.from(rewrittenStr, "utf8"),
    false,
    rewrittenLen,
    dispatchRecordB,
  );
  codexTurnState.turnForwarded = forwarded;
  if (forwarded && lane.dispatchRequest) {
    ctx.promptQueueDispatchCancellations.set(lane.dispatchRequest.grantId, {
      request: lane.dispatchRequest,
      cancel: async (reasonCode) => {
        releaseCodexTurnState(ctx, codexTurnState, `prompt_queue_${reasonCode}`);
      },
    });
  }
  return forwarded;
}

function handleCodexLaneException(
  ctx: BridgeConnectionCtx,
  turnLogCapture: Logger | null,
  engineDisplayName: string,
  err: unknown,
  sendTurnErrorFrame: (code: string, message: string) => void,
): void {
  const errName = (err as { name?: string } | null | undefined)?.name ?? "";
  if (errName === "ContainerStaleBindingError") {
    turnLogCapture?.info("user-chat-bridge: codex container stale, recycled", {
      err: (err as Error)?.message,
    });
    if (!ctx.cleaned && ctx.userWs.readyState === WebSocket.OPEN) {
      sendTurnErrorFrame(
        "CODEX_CONTAINER_RECYCLED",
        "GPT 账号配置已变更,容器已自动重建,请刷新页面后重发",
      );
      closeWsSafely(ctx.userWs, CLOSE_BRIDGE.ENV_RECYCLED, "codex_container_recycled");
    }
    return;
  }
  if (errName === "CodexRouteUnavailable") {
    turnLogCapture?.info("user-chat-bridge: codex api relay route unavailable");
    if (!ctx.cleaned && ctx.userWs.readyState === WebSocket.OPEN) {
      sendTurnErrorFrame("CODEX_ROUTE_UNAVAILABLE", `${engineDisplayName} 服务暂时不可用，请稍后重试。`);
    }
    return;
  }
  if (errName === "AccountPoolBusyError") {
    turnLogCapture?.info("user-chat-bridge: codex pool busy, fast-fail");
    if (!ctx.cleaned && ctx.userWs.readyState === WebSocket.OPEN) {
      sendTurnErrorFrame("CODEX_POOL_BUSY", "当前请求较多，请稍后重试。");
    }
    return;
  }
  turnLogCapture?.warn("user-chat-bridge: codex acquire failed", { err });
  if (!ctx.cleaned && ctx.userWs.readyState === WebSocket.OPEN) {
    sendTurnErrorFrame("CODEX_UNAVAILABLE", `${engineDisplayName} 服务暂时不可用，请稍后重试。`);
  }
}

async function runBilledCodexTurn(args: {
  lane: CodexLaneArgs;
  preparedInbound: Record<string, unknown>;
  authorityExec: ResolvedTurnExecution | null;
  dispatchRecordB: AdmittedDispatch | undefined;
  routeRes: ResolvedCodexRouteResult;
  sendTurnErrorFrame: (code: string, message: string) => void;
  releaseOnFailure: () => void;
}): Promise<boolean> {
  const { lane, preparedInbound, authorityExec, dispatchRecordB, routeRes } = args;
  const billing = await prepareCodexBillingAndPreCheck(
    lane, preparedInbound, authorityExec, dispatchRecordB, args.sendTurnErrorFrame, args.releaseOnFailure,
  );
  if (billing === null) return false;
  const journal = await startOrReuseCodexInflightJournal(
    lane, billing, routeRes, authorityExec, dispatchRecordB, args.sendTurnErrorFrame, args.releaseOnFailure,
  );
  if (journal === null) return false;
  const snap = createCodexTurnSnapshot({
    ctx: lane.ctx,
    codexTurnState: lane.codexTurnState,
    requestId: billing.requestId,
    effectiveModel: billing.effectiveModel,
    accountIdForQuota: journal.accountIdForQuota,
    traceId: lane.turnTraceIdCapture!,
    codexRouteToken: routeRes.codexRoute?.token ?? null,
    authorityExec,
    authorityTurnId: billing.authorityTurnId,
    derivedPricing: journal.derivedPricing,
    reservation: billing.preCheckResult.reservation,
    dispatchRecordB,
    verificationSponsorship: billing.verificationSponsorship,
  });
  return sealAndForwardBilledCodexTurn({
    lane, preparedInbound, authorityExec, dispatchRecordB, routeRes, billing,
    turnServiceTier: journal.turnServiceTier, snap,
    sendTurnErrorFrame: args.sendTurnErrorFrame, releaseOnFailure: args.releaseOnFailure,
  });
}

export async function executeCodexTurnLane(
  args: CodexLaneArgs,
): Promise<AdmittedDispatch | undefined> {
  const { ctx, codexTurnState, turnLogCapture, turnIdentity } = args;
  const sendTurnErrorFrame = (code: string, message: string): void => {
    args.rejectPromptQueueDispatch(code);
    sendErrorFrame(ctx.userWs, code, message, turnIdentity);
  };
  const releaseOnFailure = (): void => {
    releaseCodexTurnState(ctx, codexTurnState, "failure");
  };
  const engineDisplayName = isGrokEngineModel(args.effectiveModelCapture) ? "Grok Build" : "GPT";
  let turnForwarded = false;
  let dispatchRecordB: AdmittedDispatch | undefined;
  try {
    if (args.turnTraceIdCapture === null || args.inboundParsedCapture === null) {
      ctx.bridgeLog?.error("user-chat-bridge: codex frame missing trace invariant");
      if (!ctx.cleaned && ctx.userWs.readyState === WebSocket.OPEN) {
        sendTurnErrorFrame("ERR_INTERNAL", "trace invariant violated");
        closeWsSafely(ctx.userWs, CLOSE_BRIDGE.INTERNAL, "trace invariant");
      }
      return undefined;
    }
    const preparedInbound = await attachMasterTurnState(
      ctx, args.inboundParsedCapture, turnLogCapture, args.turnTraceIdCapture,
      args.persistUserRow, args.rejectPromptQueueDispatch, args.authorityModelCapture,
      args.recoveryJob, args.pretrackedEnrichment,
    );
    if (preparedInbound === null || !isCurrentCodexTurnState(ctx, codexTurnState)) return undefined;
    dispatchRecordB = lookupAdmittedDispatch(ctx, preparedInbound);
    let authorityExec: ResolvedTurnExecution | null = null;
    if (ctx.authorityOn) {
      authorityExec = await resolveAuthorityExecOrReject(ctx, {
        model: args.authorityModelCapture, classifiedCodex: true,
        log: turnLogCapture, onReject: args.rejectPromptQueueDispatch, turn: turnIdentity,
      });
      if (authorityExec === null || !isCurrentCodexTurnState(ctx, codexTurnState)) {
        return dispatchRecordB;
      }
    }
    const routeRes = await acquireCodexRouteAndSlot(args, authorityExec);
    if (routeRes === null) return dispatchRecordB;
    turnForwarded = ctx.shared.codexBillingEnabled
      ? await runBilledCodexTurn({
          lane: args, preparedInbound, authorityExec, dispatchRecordB, routeRes,
          sendTurnErrorFrame, releaseOnFailure,
        })
      : await sealAndForwardUnbilledCodexTurn({
          lane: args, preparedInbound, authorityExec, dispatchRecordB, routeRes,
          sendTurnErrorFrame, releaseOnFailure,
        });
    return dispatchRecordB;
  } catch (err) {
    handleCodexLaneException(ctx, turnLogCapture, engineDisplayName, err, sendTurnErrorFrame);
    return dispatchRecordB;
  } finally {
    codexTurnState.acquireInflight = false;
    if (!turnForwarded) {
      releaseCodexTurnState(ctx, codexTurnState, "not_forwarded");
      failDispatchPreForward(ctx, dispatchRecordB, "codex_pre_forward_abandoned");
    }
  }
}
