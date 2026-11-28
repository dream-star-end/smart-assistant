import { formatMessageReplyPrompt, type MessageReplyQuote } from "@openclaude/protocol/browser";
import type { SwitchAuthorization } from "../../../hooks/useModelSwitchCost";
import { ensureFirstTextPaintVisibilityTracking } from "../firstTextPaintVisibility";
import type { InboundMessage } from "../frames";
import {
  addMessage,
  type ChatMessage,
  type ChatRoutingSnapshot,
  type ChatSession,
  mintMsgId,
} from "../model";
import { isDispatchLostCode, isDispatchTerminalRow } from "../render";
import {
  exactUserReplayPayload,
  messageAttemptIdempotencyKey,
  normalizeRetiredRouting,
  routingWireFields,
} from "./pureHelpers";
import { tryEnqueueOfflineItem } from "./controlAndOfflineQueue";
import type { SocketCtx } from "./types";

export type SendMessageParams = {
  switchAuthorization?: SwitchAuthorization;
  sessId: string;
  agentId: string;
  text: string;
  displayText?: string;
  media?: InboundMessage["content"]["media"];
  imageEdit?: NonNullable<InboundMessage["content"]>["imageEdit"];
  replyTo?: MessageReplyQuote;
  model?: string;
  effortLevel?: InboundMessage["effortLevel"];
  teamMode?: boolean;
  swarmMode?: boolean;
  collabMode?: "solo" | "advisor" | "team";
  advisorModel?: string;
  collabConfigVersion?: string;
  contextTier?: InboundMessage["contextTier"];
  serviceTier?: InboundMessage["serviceTier"];
};

export function ensureServerSessionOnceFlow(
  ctx: SocketCtx,
  sess: ChatSession,
  agentId: string,
): Promise<boolean> {
  if (ctx.serverSessionEnsured.has(sess.id)) return Promise.resolve(true);
  const existing = ctx.serverSessionInflight.get(sess.id);
  if (existing) return existing;
  const sid = sess.id;
  const pending = Promise.resolve()
    .then(() => ctx.deps.ensureServerSession?.(sid, agentId, sess.title, sess._selectedModelId))
    .then((ok) => {
      ctx.serverSessionInflight.delete(sid);
      if (ok && ctx.sessions.has(sid)) {
        ctx.serverSessionEnsured.add(sid);
        const chosen = ctx.sessions.get(sid)?._selectedModelId;
        if (chosen) void ctx.deps.persistSessionModel?.(sid, chosen);
      }
      return Boolean(ok);
    })
    .catch(() => {
      ctx.serverSessionInflight.delete(sid);
      return false;
    });
  ctx.serverSessionInflight.set(sid, pending);
  return pending;
}

export function ensureGenPlaceholderRow(
  sess: ChatSession,
  imageEdit: NonNullable<InboundMessage["content"]>["imageEdit"] | undefined,
  reuse: boolean,
  anchorUserMsgId?: string,
): void {
  if (!imageEdit) return;
  const aspect: number | string =
    imageEdit.targetAspect ??
    (imageEdit.width > 0 && imageEdit.height > 0 ? imageEdit.width / imageEdit.height : 1);
  const gp = {
    jobId: imageEdit.clientJobId,
    aspect,
    status: "running" as const,
    startedAt: Date.now(),
    ...(anchorUserMsgId ? { afterUserMsgId: anchorUserMsgId } : {}),
  };
  if (reuse) {
    const existing = sess.messages.find((m) => m._genPlaceholder?.jobId === imageEdit.clientJobId);
    if (existing) {
      existing._genPlaceholder = gp;
      return;
    }
  }
  addMessage(sess, "system", "", { _genPlaceholder: gp });
}

export function dispatchInboundPayload(
  ctx: SocketCtx,
  sess: ChatSession,
  userMsg: ChatMessage,
  payload: InboundMessage,
): void {
  tryEnqueueOfflineItem(ctx, {
    sessId: sess.id,
    payload,
    msgId: userMsg.id,
    enqueuedAt: payload.ts,
    state: "queued",
  });
  userMsg.status = "queued";
  ctx.scheduleNotify();
  ctx.kickDispatchPump();
}

async function authorizeSendSwitchIfNeeded(
  ctx: SocketCtx,
  p: SendMessageParams,
): Promise<SwitchAuthorization | null> {
  if (p.switchAuthorization) return p.switchAuthorization;
  if (!ctx.deps.authorizeSwitch || !p.model || p.imageEdit) return null;
  const result = await ctx.deps.authorizeSwitch(
    {
      sessionId: p.sessId,
      requestId: mintMsgId(),
      targetModel: p.model,
      agentId: p.agentId,
      text: formatMessageReplyPrompt(p.text, p.replyTo),
      mediaCount: p.media?.length ?? 0,
      teamMode: p.teamMode,
      ...(p.collabMode ? { collabMode: p.collabMode } : {}),
      ...(p.advisorModel ? { advisorModel: p.advisorModel } : {}),
      ...(p.contextTier ? { contextTier: p.contextTier } : {}),
      ...(p.serviceTier ? { serviceTier: p.serviceTier } : {}),
    },
    { useCachedRequestId: true, allowOfflineQueue: true },
  );
  return result ?? null;
}

function buildSendRoutingSnapshot(
  p: SendMessageParams,
  authorization: SwitchAuthorization | undefined,
  preparedSwitchId: string | undefined,
): ChatRoutingSnapshot {
  return {
    model: p.model,
    ...(authorization?.consent ? { modelSwitchConsent: authorization.consent } : {}),
    ...(preparedSwitchId ? { modelSwitchId: preparedSwitchId } : {}),
    teamMode: Boolean(p.teamMode),
    ...(p.swarmMode ? { swarmMode: true } : {}),
    ...(p.collabMode ? { collabMode: p.collabMode } : {}),
    ...(p.advisorModel ? { advisorModel: p.advisorModel } : {}),
    ...(p.collabConfigVersion ? { collabConfigVersion: p.collabConfigVersion } : {}),
    effortLevel: p.effortLevel ?? null,
    ...(p.contextTier ? { contextTier: p.contextTier } : {}),
    ...(p.serviceTier ? { serviceTier: p.serviceTier } : {}),
  };
}

function stripLocalSrcFromOutboundMedia(
  media: InboundMessage["content"]["media"],
): InboundMessage["content"]["media"] {
  if (!media || media.length === 0) return undefined;
  return media.map((m) => {
    if (!m.localSrc) return m;
    const { localSrc: _localSrc, ...rest } = m;
    void _localSrc;
    return rest;
  });
}

function buildSendInboundPayload(
  sessId: string,
  p: SendMessageParams,
  routing: ChatRoutingSnapshot,
  outboundMedia: InboundMessage["content"]["media"],
): InboundMessage {
  const hasDistinctDisplay = p.displayText !== undefined && p.displayText !== p.text;
  const rawWire = routingWireFields(routing, true);
  const { effortLevel: _droppedEffort, ...wireWithoutEffort } = rawWire;
  void _droppedEffort;
  const wireFields = p.effortLevel === undefined ? wireWithoutEffort : rawWire;
  return {
    type: "inbound.message",
    idempotencyKey: "web:pending:0",
    channel: "webchat",
    peer: { id: sessId, kind: "dm" },
    agentId: p.agentId,
    content: {
      text: p.text,
      ...(hasDistinctDisplay ? { displayText: p.displayText } : {}),
      ...(outboundMedia ? { media: outboundMedia } : {}),
      ...(p.imageEdit ? { imageEdit: p.imageEdit } : {}),
      ...(p.replyTo ? { replyTo: p.replyTo } : {}),
    },
    ...(p.replyTo ? { replyToId: p.replyTo.messageId } : {}),
    ...wireFields,
    ts: Date.now(),
  };
}

export async function sendUserMessageFlow(
  ctx: SocketCtx,
  p: SendMessageParams,
): Promise<boolean> {
  const authorizationEpoch = ctx.deps.getAuthEpoch();
  let authorization = p.switchAuthorization;
  if (!authorization && ctx.deps.authorizeSwitch && p.model && !p.imageEdit) {
    authorization = (await authorizeSendSwitchIfNeeded(ctx, p)) ?? undefined;
    if (!authorization) return false;
  }
  if (ctx.deps.getAuthEpoch() !== authorizationEpoch) return false;

  const sess = ctx.ensureSession(p.sessId, p.agentId);
  if (sess._recoveryStatus?.kind === "completed" || sess._recoveryStatus?.kind === "resumed") {
    sess._recoveryStatus = undefined;
  }
  sess._dispatchPaused = false;
  if (p.model) sess._selectedModelId = p.model;
  void ctx.ensureServerSessionOnce(sess, p.agentId);

  const preparedSwitch =
    p.model && sess._preparedModelSwitch?.targetModel === p.model
      ? sess._preparedModelSwitch
      : undefined;
  const routing = buildSendRoutingSnapshot(p, authorization, preparedSwitch?.id);
  sess._lastRouting = routing;

  const media = p.media && p.media.length > 0 ? p.media : undefined;
  const outboundMedia = stripLocalSrcFromOutboundMedia(media);
  const payload = buildSendInboundPayload(sess.id, p, routing, outboundMedia);
  const hasDistinctDisplay = p.displayText !== undefined && p.displayText !== p.text;
  const userMsg = addMessage(sess, "user", p.displayText ?? p.text, {
    ...(authorization ? { id: authorization.requestId } : {}),
    status: "sending",
    _media: media?.filter((m) => m.hidden !== true),
    _retryMedia: p.imageEdit ? outboundMedia : undefined,
    _imageEdit: p.imageEdit,
    _modelText: hasDistinctDisplay ? p.text : undefined,
    _replyTo: p.replyTo,
    _routing: { ...routing },
    _sendAttempt: 0,
  });
  ensureFirstTextPaintVisibilityTracking(userMsg.ts);
  payload.clientMessageId = userMsg.id;
  payload.idempotencyKey = messageAttemptIdempotencyKey(userMsg.id, 0);
  ensureGenPlaceholderRow(sess, p.imageEdit, false, userMsg.id);
  dispatchInboundPayload(ctx, sess, userMsg, payload);
  return true;
}

function isDispatchTerminalFailure(sess: ChatSession, userMsg: ChatMessage): boolean {
  if (userMsg._dispatchTerminal === true || isDispatchLostCode(userMsg._errorCode)) return true;
  const cmid = userMsg.id;
  return sess.messages.some(
    (m) => m != null && m._clientMessageId === cmid && isDispatchTerminalRow(m),
  );
}

function needsRetrySwitchAuth(
  ctx: SocketCtx,
  routing: ChatRoutingSnapshot | undefined,
  replay: ReturnType<typeof exactUserReplayPayload>,
): boolean {
  return Boolean(ctx.deps.authorizeSwitch && routing?.model && !replay.imageEdit);
}

async function authorizeRetrySwitchIfNeeded(
  ctx: SocketCtx,
  sess: ChatSession,
  userMsg: ChatMessage,
  replay: ReturnType<typeof exactUserReplayPayload>,
  routing: ChatRoutingSnapshot | undefined,
  nextId: string,
  agentId: string,
): Promise<boolean> {
  if (!ctx.deps.authorizeSwitch || !routing?.model || replay.imageEdit) return true;
  const permit = await ctx.deps.authorizeSwitch(
    {
      sessionId: sess.id,
      requestId: nextId,
      targetModel: routing.model,
      agentId,
      text: formatMessageReplyPrompt(replay.text, replay.replyTo),
      mediaCount: replay.media?.length ?? 0,
      teamMode: routing.teamMode,
      ...(routing.collabMode ? { collabMode: routing.collabMode } : {}),
      ...(routing.advisorModel ? { advisorModel: routing.advisorModel } : {}),
      ...(routing.contextTier ? { contextTier: routing.contextTier } : {}),
      ...(routing.serviceTier ? { serviceTier: routing.serviceTier } : {}),
    },
    { consent: routing.modelSwitchConsent },
  );
  if (!permit || ctx.sessions.get(sess.id) !== sess || userMsg.status !== "error") return false;
  routing.modelSwitchConsent = permit.consent;
  return true;
}

function buildRetryInboundPayload(
  sessId: string,
  agentId: string,
  replay: ReturnType<typeof exactUserReplayPayload>,
  routing: ChatRoutingSnapshot | undefined,
): InboundMessage {
  return {
    type: "inbound.message",
    idempotencyKey: "web:pending:retry",
    channel: "webchat",
    peer: { id: sessId, kind: "dm" },
    agentId,
    content: {
      text: replay.text,
      ...(replay.displayText !== undefined ? { displayText: replay.displayText } : {}),
      ...(replay.media ? { media: replay.media } : {}),
      ...(replay.imageEdit ? { imageEdit: replay.imageEdit } : {}),
      ...(replay.replyTo ? { replyTo: replay.replyTo } : {}),
    },
    ...(replay.replyTo ? { replyToId: replay.replyTo.messageId } : {}),
    ...routingWireFields(routing, true),
    ts: Date.now(),
  };
}

function applyRetryIdentityAndIdempotency(
  sess: ChatSession,
  userMsg: ChatMessage,
  payload: InboundMessage,
  terminal: boolean,
  nextId: string,
): void {
  if (terminal) {
    const staleCmid = userMsg.id;
    sess.messages = sess.messages.filter(
      (m) => !(m && m._clientMessageId === staleCmid && isDispatchTerminalRow(m)),
    );
    if (userMsg._userPayloadDeferred === true && !userMsg._userPayloadId) {
      userMsg._userPayloadId = staleCmid;
    }
    userMsg.id = nextId;
    userMsg._errorCode = undefined;
    userMsg._errorDetail = undefined;
    userMsg._sendAttempt = 0;
    payload.clientMessageId = nextId;
    payload.idempotencyKey = messageAttemptIdempotencyKey(nextId, 0);
    return;
  }
  payload.clientMessageId = userMsg.id;
  const validPrev =
    Number.isSafeInteger(userMsg._sendAttempt) && (userMsg._sendAttempt ?? 0) >= 0;
  const nextAttempt = (validPrev ? userMsg._sendAttempt! : 0) + 1;
  userMsg._sendAttempt = nextAttempt;
  payload.idempotencyKey = messageAttemptIdempotencyKey(userMsg.id, nextAttempt);
}

export async function retryUserMessageFlow(
  ctx: SocketCtx,
  p: {
    sessId: string;
    msgId: string;
    agentId: string;
    sourceOverride?: ChatMessage;
  },
): Promise<void> {
  const sess = ctx.sessions.get(p.sessId);
  if (!sess) return;
  const userMsg = sess.messages.find((m) => m.id === p.msgId && m.role === "user");
  if (!userMsg || userMsg.status !== "error") return;
  const source =
    p.sourceOverride?.id === userMsg.id && p.sourceOverride.role === "user"
      ? p.sourceOverride
      : userMsg;
  const agentId = sess.agentId || p.agentId;
  const replay = exactUserReplayPayload(source);
  const routing = normalizeRetiredRouting(source._routing ?? userMsg._routing ?? sess._lastRouting);
  const terminal = isDispatchTerminalFailure(sess, userMsg);
  const nextId = terminal ? mintMsgId() : userMsg.id;

  if (needsRetrySwitchAuth(ctx, routing, replay)) {
    const authorized = await authorizeRetrySwitchIfNeeded(
      ctx,
      sess,
      userMsg,
      replay,
      routing,
      nextId,
      agentId,
    );
    if (!authorized) return;
  }

  sess._dispatchPaused = false;
  void ctx.ensureServerSessionOnce(sess, agentId);
  if (routing) {
    userMsg._routing = { ...routing };
    sess._lastRouting = { ...routing };
  }
  const payload = buildRetryInboundPayload(sess.id, agentId, replay, routing);
  applyRetryIdentityAndIdempotency(sess, userMsg, payload, terminal, nextId);
  userMsg.status = "sending";
  ensureGenPlaceholderRow(sess, replay.imageEdit, true, userMsg.id);
  dispatchInboundPayload(ctx, sess, userMsg, payload);
}

export function editQueuedMessageInSession(
  ctx: SocketCtx,
  sessId: string,
  msgId: string,
): string | undefined {
  const sess = ctx.sessions.get(sessId);
  if (!sess) return undefined;
  const user = sess.messages.find((message) => message.role === "user" && message.id === msgId);
  if (!user || user.status !== "queued") return undefined;
  const text = user._modelText || user.text || "";
  ctx.clearPendingDispatch(sessId, msgId);
  sess.messages = sess.messages.filter((message) => message.id !== msgId);
  const stillQueued = ctx.offlineQueue.some(
    (item) => item.sessId === sessId && item.state === "queued",
  );
  if (!stillQueued) sess._dispatchPaused = false;
  ctx.deps.persistSession?.(sessId);
  ctx.scheduleNotify();
  return text;
}

export function sendQueuedMessageNow(ctx: SocketCtx, sessId: string, msgId: string): void {
  const sess = ctx.sessions.get(sessId);
  if (!sess) return;
  const queued = ctx.offlineQueue.some(
    (item) => item.sessId === sessId && item.msgId === msgId && item.state === "queued",
  );
  const user = sess.messages.find((message) => message.role === "user" && message.id === msgId);
  if (!queued || !user || user.status !== "queued") return;
  if (sess._sendingInFlight && sess._activeClientMessageId !== msgId) {
    ctx.stopTurn(sessId);
  }
  sess._dispatchPaused = false;
  ctx.scheduleNotify();
  ctx.kickDispatchPump();
}
