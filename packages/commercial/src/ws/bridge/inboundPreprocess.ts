import { WebSocket, type RawData } from "ws";
import {
  DEFAULT_CODEX_ENGINE_MODEL,
  isAntigravityEngineModel,
  isCc5TestModel,
  isCodexEngineModel,
  isCursorEngineModel,
  isGrokEngineModel,
  isZcodeEngineModel,
  newTraceId,
  parseTraceIdCandidate,
  type TraceIdIssue,
} from "@openclaude/protocol";
import { backfillDispatchTraceId } from "../../dispatch/turnDispatchStore.js";
import type { Logger } from "../../logging/logger.js";
import type { AgentModelResolver } from "../agentModelAuthority.js";
import { appendScanSciPaperIntentHintToFrame } from "../paperIntentHint.js";
import { applyTeamLeaderForwarding } from "../teamModeForwarding.js";
import { admittedTraceIdentity, recordTurnTrace, updateTurnTraceDispatch } from "../turnTraces.js";
import { sendErrorFrame } from "../userErrorFrames.js";
import { terminalizeEnrichmentDispatch } from "./connectionDispatch.js";
import {
  AGENT_AUTHZ_IMPLIED_MODEL,
  CLOSE_BRIDGE,
  HIDDEN_REVIEWER_AGENT_ID,
  MAX_TURN_GRACE_MS,
} from "./constants.js";
import {
  handleDurableControlFrame,
  handleInboundHelloFrame,
  handleSessionRepoControlFrame,
  stripBinaryPrivateFields,
  stripTextPrivateFields,
} from "./inboundControls.js";
import type {
  BridgeConnectionCtx,
  EnrichmentDispatchState,
  InboundTurnIdentity,
  TurnIngress,
} from "./types.js";
import {
  closeWsSafely,
  inboundTurnIdentityFromParsed,
  isValidatedAnnotatedImageInbound,
} from "./wireHelpers.js";

export type ExecutionAuthorityResult = Awaited<
  ReturnType<NonNullable<AgentModelResolver["authorizeExecution"]>>
> | null;

export interface InboundMessageClassification {
  effectiveModel: string | null;
  authorityModel: string | null;
  isCodex: boolean;
  isRemoteNative: boolean;
  isCursor: boolean;
  isZcode: boolean;
  isAntigravity: boolean;
  isAnnotatedImage: boolean;
  peerId: string | null;
  turnIdentity: InboundTurnIdentity;
  parsedFrame: Record<string, unknown>;
  agentId: string | null;
  traceId: string;
  turnLog: Logger | null;
}

export type PreprocessInboundResult =
  | { kind: "stop" }
  | { kind: "passthrough"; data: RawData; len: number }
  | { kind: "inbound_message"; classification: InboundMessageClassification };

const CLIENT_STRIP_INBOUND_KEYS = [
  "__oc_codex_route",
  "__oc_grok_route",
  "__oc_zcode_route",
  "__oc_antigravity_route",
  "_antigravitySwarmAllowedModels",
  "_workspaceMode",
] as const;

function sanitizeInboundMessageObject(
  ctx: BridgeConnectionCtx,
  parsed: Record<string, unknown>,
  rawClientTrace: unknown,
  clientHintOk: boolean,
  teamModeMain: boolean,
  effectiveModelForFrame: string | null,
  isCronOriginDispatch: boolean,
): Record<string, unknown> {
  const dropClientTrace = rawClientTrace !== undefined && !clientHintOk;
  const hasStripKey =
    Object.prototype.hasOwnProperty.call(parsed, "_creditBudget") ||
    CLIENT_STRIP_INBOUND_KEYS.some((k) => Object.prototype.hasOwnProperty.call(parsed, k));
  let sanitizedParsed = parsed;
  if (dropClientTrace || hasStripKey || teamModeMain) {
    sanitizedParsed = { ...parsed };
    if (dropClientTrace) Reflect.deleteProperty(sanitizedParsed, "clientTraceId");
    ctx.shared.adapters.stripClientCreditBudget(sanitizedParsed);
    if (Object.prototype.hasOwnProperty.call(sanitizedParsed, "__oc_antigravity_route")) {
      const { __oc_antigravity_route: _discard, ...withoutAntigravityRoute } = sanitizedParsed;
      void _discard;
      sanitizedParsed = withoutAntigravityRoute;
    }
    for (const k of CLIENT_STRIP_INBOUND_KEYS) {
      if (Object.prototype.hasOwnProperty.call(sanitizedParsed, k)) {
        Reflect.deleteProperty(sanitizedParsed, k);
      }
    }
    if (teamModeMain) {
      applyTeamLeaderForwarding(
        sanitizedParsed,
        effectiveModelForFrame ?? DEFAULT_CODEX_ENGINE_MODEL,
      );
    }
  }
  return isCronOriginDispatch
    ? sanitizedParsed
    : appendScanSciPaperIntentHintToFrame(sanitizedParsed);
}

function recordInboundTurnTelemetry(args: {
  ctx: BridgeConnectionCtx;
  parsed: Record<string, unknown>;
  effectiveFrameAgentId: string | null;
  effectiveModelForFrame: string | null;
  turnTraceIdForFrame: string;
  turnLogForFrame: Logger | null;
  ingress: TurnIngress;
  receivedAtMs: number;
  pretrackedEnrichment: EnrichmentDispatchState | undefined;
}): void {
  const { ctx, parsed, effectiveFrameAgentId, turnTraceIdForFrame, turnLogForFrame } = args;
  const peerObj = (parsed as { peer?: { id?: unknown } }).peer;
  const peerIdRaw = peerObj && typeof peerObj === "object" ? peerObj.id : undefined;
  const traceSessionKey =
    typeof peerIdRaw === "string" && peerIdRaw !== ""
      ? `agent:${effectiveFrameAgentId}:webchat:dm:${peerIdRaw.replace(/[^a-zA-Z0-9_-]/g, "_")}`
      : "(unknown-peer)";
  recordTurnTrace(
    ctx.shared.deps.pgPool,
    (msg, fields) => turnLogForFrame?.warn(msg, fields),
    {
      traceId: turnTraceIdForFrame,
      userId: ctx.uid,
      sessionKey: traceSessionKey,
      agentId: effectiveFrameAgentId,
      model: args.effectiveModelForFrame,
      bundleRev: ctx.endpoint.bundleRev ?? null,
      clientBuild: ctx.clientBuildForConnection,
    },
  );
  const cronTraceDispatch =
    args.ingress === "cron_origin" ? args.pretrackedEnrichment?.record : undefined;
  if (
    cronTraceDispatch !== undefined &&
    cronTraceDispatch.sessionId === peerIdRaw &&
    cronTraceDispatch.clientMessageId === parsed.clientMessageId
  ) {
    updateTurnTraceDispatch(
      ctx.shared.deps.pgPool,
      (msg, fields) => turnLogForFrame?.warn(msg, fields),
      {
        traceId: turnTraceIdForFrame,
        dispatchId: cronTraceDispatch.dispatchId,
        requestId: cronTraceDispatch.billingRequestId,
        identity: admittedTraceIdentity(cronTraceDispatch),
      },
    );
    if (ctx.shared.deps.pgPool) {
      const dispatchId = cronTraceDispatch.dispatchId;
      void backfillDispatchTraceId(ctx.shared.deps.pgPool, {
        dispatchId,
        traceId: turnTraceIdForFrame,
      }).catch((err) => {
        turnLogForFrame?.warn("user-chat-bridge: dispatch trace backfill failed", { dispatchId, err });
      });
    }
  }
  if (typeof peerIdRaw === "string" && peerIdRaw !== "") {
    ctx.responseMilestoneTracker.begin({
      traceId: turnTraceIdForFrame,
      sessionId: peerIdRaw,
      model: args.effectiveModelForFrame,
      userId: ctx.uid,
      startedAtMs: args.receivedAtMs,
      ...(args.ingress === "browser" ? {} : { browserFamily: null, deviceClass: null }),
    });
  }
}

function rejectInboundAgentPolicy(
  ctx: BridgeConnectionCtx,
  isCronOriginDispatch: boolean,
  pretrackedEnrichment: EnrichmentDispatchState | undefined,
  rejectPromptQueueDispatch: (code: string) => void,
  code: string,
  closeReason: string,
  message: string,
  turnIdentity: InboundTurnIdentity,
): null {
  rejectPromptQueueDispatch(code);
  if (isCronOriginDispatch) {
    if (pretrackedEnrichment) terminalizeEnrichmentDispatch(ctx, pretrackedEnrichment, closeReason);
    return null;
  }
  sendErrorFrame(ctx.userWs, code, message, turnIdentity);
  closeWsSafely(ctx.userWs, CLOSE_BRIDGE.PRODUCT_POLICY, closeReason);
  ctx.cleanup("client_close", true);
  return null;
}

function resolveEffectiveInboundModel(args: {
  ctx: BridgeConnectionCtx;
  teamModeMain: boolean;
  frameModelId: string | null;
  effectiveFrameAgentId: string | null;
  frameAgentId: string | null;
  frameAgentAuthorityModel: string | null;
}): {
  effectiveModel: string | null;
  source: "frame.model" | "agentId.implied" | "agentAuthority" | "teamMode.main" | "lastSeen" | null;
  unresolvedAgent: boolean;
} {
  const { ctx, teamModeMain, frameModelId, effectiveFrameAgentId } = args;
  const agentImpliedModel =
    effectiveFrameAgentId !== null ? AGENT_AUTHZ_IMPLIED_MODEL[effectiveFrameAgentId] : undefined;
  const agentAuthorityModel =
    effectiveFrameAgentId !== null && ctx.agentModelResolverHandle !== null
      ? effectiveFrameAgentId === args.frameAgentId
        ? args.frameAgentAuthorityModel
        : ctx.agentModelResolverHandle.resolve(effectiveFrameAgentId)
      : null;
  if (teamModeMain) {
    return {
      effectiveModel: ctx.shared.adapters.resolveTeamLeaderModel(
        ctx.shared.deps.pricing,
        ctx.modelCheckerHandle,
      ),
      source: "teamMode.main",
      unresolvedAgent: false,
    };
  }
  if (frameModelId !== null) return { effectiveModel: frameModelId, source: "frame.model", unresolvedAgent: false };
  if (agentImpliedModel !== undefined) return { effectiveModel: agentImpliedModel, source: "agentId.implied", unresolvedAgent: false };
  if (agentAuthorityModel !== null) return { effectiveModel: agentAuthorityModel, source: "agentAuthority", unresolvedAgent: false };
  if (effectiveFrameAgentId !== null && ctx.agentModelResolverHandle !== null) {
    return { effectiveModel: null, source: null, unresolvedAgent: true };
  }
  if (ctx.lastSeenModelId !== null) return { effectiveModel: ctx.lastSeenModelId, source: "lastSeen", unresolvedAgent: false };
  return { effectiveModel: null, source: null, unresolvedAgent: false };
}

function observeInboundContentReview(
  ctx: BridgeConnectionCtx,
  parsed: Record<string, unknown>,
  sessionKey: string,
): void {
  try {
    const content = parsed.content as { text?: unknown } | undefined;
    if (typeof content?.text === "string" && content.text.trim()) {
      ctx.shared.adapters.observeUserContentReview({
        text: content.text,
        userId: ctx.uid.toString(),
        sessionKey,
      });
    }
  } catch (err) {
    void err;
  }
}

function resolveInboundTeamModeAndSession(
  ctx: BridgeConnectionCtx,
  parsed: Record<string, unknown>,
  frameAgentId: string | null,
  frameAgentAuthorityModel: string | null,
): { teamModeMain: boolean; effectiveFrameAgentId: string | null; sessionKey: string } {
  const nonMainDemotes =
    parsed.teamMode === true &&
    frameAgentId !== null &&
    frameAgentId !== "main" &&
    (ctx.agentModelResolverHandle === null || frameAgentAuthorityModel === null);
  const teamModeMain =
    parsed.teamMode === true && (frameAgentId === "main" || frameAgentId === null || nonMainDemotes);
  const effectiveFrameAgentId = teamModeMain ? "main" : frameAgentId;
  const sessionKey = ctx.shared.adapters.inboundSessionKey({
    ...parsed,
    agentId: effectiveFrameAgentId ?? "main",
  });
  return { teamModeMain, effectiveFrameAgentId, sessionKey };
}

function resolveInboundAgentAndTeamMode(args: {
  ctx: BridgeConnectionCtx;
  parsed: Record<string, unknown>;
  executionAuthority: ExecutionAuthorityResult;
  isCronOriginDispatch: boolean;
  pretrackedEnrichment: EnrichmentDispatchState | undefined;
  rejectPromptQueueDispatch: (code: string) => void;
}): {
  turnIdentity: InboundTurnIdentity;
  peerId: string | null;
  frameModelId: string | null;
  frameAgentId: string | null;
  frameAgentAuthorityModel: string | null;
  teamModeMain: boolean;
  effectiveFrameAgentId: string | null;
} | null {
  const { ctx, parsed, executionAuthority, isCronOriginDispatch, pretrackedEnrichment, rejectPromptQueueDispatch } = args;
  const inboundTurnIdentityForFrame = inboundTurnIdentityFromParsed(parsed);
  const peerId = inboundTurnIdentityForFrame.peerId;
  if (peerId && !ctx.userDetached && ctx.userWs.readyState === WebSocket.OPEN) {
    ctx.shared.registerUserWsSession(ctx.userWs, ctx.uid.toString(), peerId);
  }
  const frameModelId = typeof parsed.model === "string" ? parsed.model : null;
  const frameAgentId = typeof parsed.agentId === "string" ? parsed.agentId : null;
  if (frameAgentId === HIDDEN_REVIEWER_AGENT_ID) {
    ctx.bridgeLog?.info("user-chat-bridge: hidden system agent direct frame rejected", { agentId: frameAgentId });
    return rejectInboundAgentPolicy(
      ctx, isCronOriginDispatch, pretrackedEnrichment, rejectPromptQueueDispatch,
      "AGENT_NOT_FOUND", "hidden_agent_direct_chat", "agent not found", inboundTurnIdentityForFrame,
    );
  }
  const resolver = ctx.agentModelResolverHandle;
  const frameAgentAuthorityModel = executionAuthority
    ? executionAuthority.model
    : frameAgentId
      ? (resolver?.resolve(frameAgentId) ?? null)
      : null;
  if (
    frameAgentId !== null &&
    resolver !== null &&
    executionAuthority?.identity.status !== "registered-ready" &&
    resolver.isRuntimeDenied(frameAgentId)
  ) {
    void resolver.refresh();
    ctx.bridgeLog?.info("user-chat-bridge: agent runtime not ready, frame rejected", { agentId: frameAgentId });
    return rejectInboundAgentPolicy(
      ctx, isCronOriginDispatch, pretrackedEnrichment, rejectPromptQueueDispatch,
      "UNRESOLVED_AGENT_MODEL", "agent_not_runtime_ready",
      `agent '${frameAgentId}' is not ready — repair its required capabilities and retry`,
      inboundTurnIdentityForFrame,
    );
  }
  const { teamModeMain, effectiveFrameAgentId, sessionKey } = resolveInboundTeamModeAndSession(
    ctx,
    parsed,
    frameAgentId,
    frameAgentAuthorityModel,
  );
  observeInboundContentReview(ctx, parsed, sessionKey);
  return {
    turnIdentity: { ...inboundTurnIdentityForFrame, sessionKey },
    peerId,
    frameModelId,
    frameAgentId,
    frameAgentAuthorityModel,
    teamModeMain,
    effectiveFrameAgentId,
  };
}

function classifyInboundEngineFlags(
  ctx: BridgeConnectionCtx,
  effectiveModel: string | null,
  peekedAuthorityModel: string | null,
): {
  isCodex: boolean;
  isRemoteNative: boolean;
  isCursor: boolean;
  isZcode: boolean;
  isAntigravity: boolean;
} {
  const catalogPeek =
    ctx.authorityOn && peekedAuthorityModel !== null ? ctx.authorityDeps?.catalog.peek() : null;
  const fallbackCodex = isCodexEngineModel(effectiveModel) || isGrokEngineModel(effectiveModel);
  if (!catalogPeek || peekedAuthorityModel === null) {
    return {
      isCodex: fallbackCodex,
      isRemoteNative: false,
      isCursor: isCursorEngineModel(effectiveModel),
      isZcode: isZcodeEngineModel(effectiveModel),
      isAntigravity: isAntigravityEngineModel(effectiveModel),
    };
  }
  return {
    isCodex: catalogPeek.isEngineReportedModel(peekedAuthorityModel) ?? fallbackCodex,
    isRemoteNative: catalogPeek.resolve(peekedAuthorityModel)?.placement === "remote_pool",
    isCursor: catalogPeek.isCursorModel(peekedAuthorityModel) ?? isCursorEngineModel(effectiveModel),
    isZcode: catalogPeek.isZcodeModel(peekedAuthorityModel) ?? isZcodeEngineModel(effectiveModel),
    isAntigravity:
      catalogPeek.isAntigravityModel(peekedAuthorityModel) ?? isAntigravityEngineModel(effectiveModel),
  };
}

function authorizeInboundModelAndFlags(args: {
  ctx: BridgeConnectionCtx;
  effectiveModel: string | null;
  source: string | null;
  turnIdentity: InboundTurnIdentity;
  rejectPromptQueueDispatch: (code: string) => void;
}): {
  peekedEffectiveModel: string | null;
  authorityModel: string | null;
  isCodex: boolean;
  isRemoteNative: boolean;
  isCursor: boolean;
  isZcode: boolean;
  isAntigravity: boolean;
} | null {
  const { ctx, effectiveModel, source, turnIdentity, rejectPromptQueueDispatch } = args;
  const { deps } = ctx.shared;
  const peekPool = (model: string | null): string | null => {
    if (model === null || !deps.peekLogicalModelPoolTarget) return model;
    return (
      deps.peekLogicalModelPoolTarget(
        model,
        ctx.authorityDeps?.catalog.peek() ?? null,
        ctx.modelCheckerHandle ? (m) => ctx.modelCheckerHandle!.isAllowed(m) : undefined,
        Number(ctx.uid),
        turnIdentity.sessionKey ?? null,
      ) ?? model
    );
  };
  const peekedEffectiveModel = peekPool(effectiveModel);
  const notAllowedByChecker =
    ctx.modelCheckerHandle !== null &&
    peekedEffectiveModel !== null &&
    !ctx.modelCheckerHandle.isAllowed(peekedEffectiveModel) &&
    (!deps.resolveLogicalModelPoolTarget ||
      ctx.authorityDeps?.catalog.peek()?.resolve(effectiveModel!) !== null);
  if (effectiveModel !== null && peekedEffectiveModel !== null && (isCc5TestModel(peekedEffectiveModel) || notAllowedByChecker)) {
    rejectPromptQueueDispatch("UNAUTHORIZED_MODEL");
    ctx.bridgeLog?.info("user-chat-bridge: model not authorized", { modelId: effectiveModel, source });
    sendErrorFrame(
      ctx.userWs,
      "UNAUTHORIZED_MODEL",
      `model not authorized for current user: ${effectiveModel}`,
      { peerId: turnIdentity.peerId, clientMessageId: turnIdentity.clientMessageId },
    );
    return null;
  }
  const authorityModel = effectiveModel ?? ctx.agentModelResolverHandle?.resolve("main") ?? null;
  return {
    peekedEffectiveModel,
    authorityModel,
    ...classifyInboundEngineFlags(ctx, effectiveModel, peekPool(authorityModel)),
  };
}

function classifyInboundMessage(args: {
  ctx: BridgeConnectionCtx;
  parsed: Record<string, unknown>;
  executionAuthority: ExecutionAuthorityResult;
  ingress: TurnIngress;
  receivedAtMs: number;
  pretrackedEnrichment: EnrichmentDispatchState | undefined;
  rejectPromptQueueDispatch: (code: string) => void;
}): InboundMessageClassification | null {
  const { ctx, parsed, executionAuthority, rejectPromptQueueDispatch } = args;
  const isCronOriginDispatch = args.ingress === "cron_origin";
  const agentInfo = resolveInboundAgentAndTeamMode({
    ctx,
    parsed,
    executionAuthority,
    isCronOriginDispatch,
    pretrackedEnrichment: args.pretrackedEnrichment,
    rejectPromptQueueDispatch,
  });
  if (agentInfo === null) return null;
  const resolved = resolveEffectiveInboundModel({
    ctx,
    teamModeMain: agentInfo.teamModeMain,
    frameModelId: agentInfo.frameModelId,
    effectiveFrameAgentId: agentInfo.effectiveFrameAgentId,
    frameAgentId: agentInfo.frameAgentId,
    frameAgentAuthorityModel: agentInfo.frameAgentAuthorityModel,
  });
  if (resolved.unresolvedAgent) {
    const inboundTurnIdentityForFrame = agentInfo.turnIdentity;
    void ctx.agentModelResolverHandle?.refresh();
    ctx.bridgeLog?.info("user-chat-bridge: agent model unresolved, frame rejected", {
      agentId: agentInfo.effectiveFrameAgentId,
    });
    return rejectInboundAgentPolicy(
      ctx, isCronOriginDispatch, args.pretrackedEnrichment, rejectPromptQueueDispatch,
      "UNRESOLVED_AGENT_MODEL", "unresolved_agent_model",
      `cannot resolve model for agent '${agentInfo.effectiveFrameAgentId}' — retry shortly or specify a model`,
      inboundTurnIdentityForFrame,
    );
  }
  if (resolved.source === "frame.model" || resolved.source === "agentId.implied") {
    ctx.lastSeenModelId = resolved.effectiveModel;
  }
  const authz = authorizeInboundModelAndFlags({
    ctx,
    effectiveModel: resolved.effectiveModel,
    source: resolved.source,
    turnIdentity: agentInfo.turnIdentity,
    rejectPromptQueueDispatch,
  });
  if (authz === null) return null;
  if (ctx.firstUserFrameAtMs === null) ctx.firstUserFrameAtMs = args.receivedAtMs;
  const traceId = newTraceId();
  const rawClientTrace = parsed.clientTraceId;
  const clientHint = parseTraceIdCandidate(rawClientTrace);
  const clientTraceFields: { clientTraceId?: string; clientTraceIdIssue?: TraceIdIssue } = {};
  if (clientHint.ok) clientTraceFields.clientTraceId = clientHint.traceId;
  else if (rawClientTrace !== undefined) clientTraceFields.clientTraceIdIssue = clientHint.issue;
  const parsedFrame = sanitizeInboundMessageObject(
    ctx,
    parsed,
    rawClientTrace,
    clientHint.ok,
    agentInfo.teamModeMain,
    authz.peekedEffectiveModel,
    isCronOriginDispatch,
  );
  const turnLog = ctx.bridgeLog?.child({ traceId }) ?? null;
  turnLog?.info("user-chat-bridge: inbound turn start", clientTraceFields);
  recordInboundTurnTelemetry({
    ctx,
    parsed,
    effectiveFrameAgentId: agentInfo.effectiveFrameAgentId,
    effectiveModelForFrame: authz.peekedEffectiveModel,
    turnTraceIdForFrame: traceId,
    turnLogForFrame: turnLog,
    ingress: args.ingress,
    receivedAtMs: args.receivedAtMs,
    pretrackedEnrichment: args.pretrackedEnrichment,
  });
  ctx.turnActiveUntil = Date.now() + MAX_TURN_GRACE_MS;
  const needsAgentId = authz.isCodex || authz.isCursor || authz.isZcode || authz.isAntigravity;
  return {
    effectiveModel: authz.peekedEffectiveModel,
    authorityModel: authz.authorityModel,
    isCodex: authz.isCodex,
    isRemoteNative: authz.isRemoteNative,
    isCursor: authz.isCursor,
    isZcode: authz.isZcode,
    isAntigravity: authz.isAntigravity,
    isAnnotatedImage: isValidatedAnnotatedImageInbound(parsedFrame),
    peerId: agentInfo.peerId,
    turnIdentity: agentInfo.turnIdentity,
    parsedFrame,
    agentId: needsAgentId ? agentInfo.effectiveFrameAgentId : null,
    traceId,
    turnLog,
  };
}

export function preprocessInboundFrame(args: {
  ctx: BridgeConnectionCtx;
  data: RawData;
  isBinary: boolean;
  len: number;
  ingress: TurnIngress;
  receivedAtMs: number;
  pretrackedEnrichment: EnrichmentDispatchState | undefined;
  executionAuthority: ExecutionAuthorityResult;
  rejectPromptQueueDispatch: (code: string) => void;
}): PreprocessInboundResult {
  const { ctx, isBinary, ingress } = args;
  if (isBinary) {
    const stripped = stripBinaryPrivateFields(args.data, args.len);
    return { kind: "passthrough", data: stripped.data, len: stripped.len };
  }
  const passthrough = { data: args.data, len: args.len };
  let frameStr: string | null = null;
  if (typeof args.data === "string") frameStr = args.data;
  else if (Buffer.isBuffer(args.data)) {
    try {
      frameStr = args.data.toString("utf8");
    } catch (err) {
      void err;
      frameStr = null;
    }
  }
  if (frameStr === null) return { kind: "passthrough", data: passthrough.data, len: passthrough.len };
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(frameStr);
  } catch (err) {
    void err;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "passthrough", data: passthrough.data, len: passthrough.len };
  }
  const parsedObj = parsed as Record<string, unknown>;
  const isPromptQueueDispatch = ingress === "prompt_queue";
  const isCronOriginDispatch = ingress === "cron_origin";
  const stripRes = stripTextPrivateFields(ctx, parsedObj, isPromptQueueDispatch, isCronOriginDispatch);
  if (stripRes.dropped) return { kind: "stop" };
  if (stripRes.rewritten) {
    const strippedStr = JSON.stringify(parsedObj);
    passthrough.data = Buffer.from(strippedStr, "utf8");
    passthrough.len = Buffer.byteLength(strippedStr);
  }
  if (!isPromptQueueDispatch && !isCronOriginDispatch && handleDurableControlFrame(ctx, parsedObj)) {
    return { kind: "stop" };
  }
  if (handleSessionRepoControlFrame(ctx, parsedObj)) return { kind: "stop" };
  if (parsedObj.type === "inbound.hello") {
    handleInboundHelloFrame(ctx, parsedObj, passthrough);
    return { kind: "passthrough", data: passthrough.data, len: passthrough.len };
  }
  if (parsedObj.type !== "inbound.message") {
    return { kind: "passthrough", data: passthrough.data, len: passthrough.len };
  }
  const classification = classifyInboundMessage({
    ctx,
    parsed: parsedObj,
    executionAuthority: args.executionAuthority,
    ingress,
    receivedAtMs: args.receivedAtMs,
    pretrackedEnrichment: args.pretrackedEnrichment,
    rejectPromptQueueDispatch: args.rejectPromptQueueDispatch,
  });
  if (classification === null) return { kind: "stop" };
  return { kind: "inbound_message", classification };
}
