import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Pool } from "pg";
import { WebSocket, type RawData } from "ws";
import {
  isClientMessageId,
  isCursorContextTier,
  isServiceTier,
  modelHistorySemanticRole,
  modelHistorySemanticText,
  type GoalStateSnapshot,
} from "@openclaude/protocol";
import type { AccessClaims } from "../../auth/jwt.js";
import type { JournalFailureCode } from "../../billing/proxyBilling.js";
import { GoalStateError } from "../../goal/goalStateService.js";
import { hasOnlyKeys, isPlainRecord } from "../bridgeInputGuards.js";
import {
  PROMPT_QUEUE_DISPATCH_ACTIVATED_TYPE,
  PROMPT_QUEUE_DISPATCH_CANCEL_TYPE,
  PROMPT_QUEUE_DISPATCH_REQUEST_TYPE,
  type PromptQueueDispatchActivated,
  type PromptQueueDispatchCancel,
  type PromptQueueDispatchRequest,
} from "../promptQueueDispatchTypes.js";
import { sendErrorFrame } from "../userErrorFrames.js";
import {
  CLOSE_BRIDGE,
  OUTPAINT_ASPECTS,
  SESSION_DELETED_WIRE_MESSAGE,
} from "./constants.js";
import type {
  InboundTurnIdentity,
  TurnGoalResolution,
  UserChatBridgeDeps,
} from "./types.js";

export function _isAuthorizedRecoveryNativeReset(input: {
  automatic: unknown;
  legacyAutomatic: boolean;
  resetNativeSession: unknown;
  hasRecoveryJob: boolean;
}): boolean {
  return (
    input.automatic === true &&
    !input.legacyAutomatic &&
    input.hasRecoveryJob &&
    input.resetNativeSession === true
  );
}

/** Leftover live-journal frames (no cmid) stay durable but never ride the hot WS. */
export function isLeftoverHotWsFrame(wire: {
  type?: unknown;
  clientMessageId?: unknown;
}): boolean {
  if (isClientMessageId(wire.clientMessageId)) return false;
  return wire.type === "outbound.message" || wire.type === "outbound.error";
}

export function parseLeftoverHotWsPayload(data: string): boolean {
  try {
    const parsed = JSON.parse(data) as { type?: unknown; clientMessageId?: unknown };
    return isLeftoverHotWsFrame(parsed);
  } catch (err) {
    void err;
    return false;
  }
}

function hasValidImageEditDimensions(value: Record<string, unknown>): boolean {
  if (typeof value.clientJobId !== "string" || !/^[0-9a-f]{32}$/.test(value.clientJobId)) {
    return false;
  }
  const w = value.width;
  const h = value.height;
  if (!Number.isInteger(w) || Number(w) < 1 || Number(w) > 8192) return false;
  if (!Number.isInteger(h) || Number(h) < 1 || Number(h) > 8192) return false;
  return Number(w) * Number(h) <= 16_777_216;
}

function hasValidImageEditIndices(media: unknown[], value: Record<string, unknown>): boolean {
  const isOutpaint = value.mode === "outpaint";
  if (isOutpaint && !OUTPAINT_ASPECTS.has(value.targetAspect as string)) return false;
  const indices = isOutpaint
    ? [value.sourceIndex, value.guideIndex]
    : [value.sourceIndex, value.maskIndex, value.guideIndex];
  const wantDistinct = isOutpaint ? 2 : 3;
  const inRange = indices.every(
    (idx) => Number.isInteger(idx) && Number(idx) >= 0 && Number(idx) < media.length,
  );
  if (!inRange || new Set(indices).size !== wantDistinct) return false;
  return indices.every((idx) => {
    const item = media[Number(idx)];
    return !!item && typeof item === "object" && (item as { kind?: unknown }).kind === "image";
  });
}

export function isValidatedAnnotatedImageInbound(frame: Record<string, unknown>): boolean {
  if (frame.type !== "inbound.message") return false;
  const content = frame.content;
  if (!content || typeof content !== "object") return false;
  const typed = content as { text?: unknown; media?: unknown; imageEdit?: unknown };
  if (typeof typed.text !== "string" || typed.text.trim().length === 0) return false;
  if (!Array.isArray(typed.media)) return false;
  if (!typed.imageEdit || typeof typed.imageEdit !== "object") return false;
  const edit = typed.imageEdit as Record<string, unknown>;
  return hasValidImageEditDimensions(edit) && hasValidImageEditIndices(typed.media, edit);
}

const PQ_EXECUTION_KEYS = [
  "agentId", "model", "modelSwitchId", "modelSwitchConsent", "effortLevel", "teamMode",
  "swarmMode", "collabMode", "advisorModel", "collabConfigVersion", "contextTier", "serviceTier",
];

function parsePromptQueueOwner(owner: unknown): PromptQueueDispatchRequest["owner"] | null {
  if (!isPlainRecord(owner) || !hasOnlyKeys(owner, ["sessionKey", "clientSessionId", "agentId", "peer"])) {
    return null;
  }
  const { sessionKey, clientSessionId, agentId, peer } = owner;
  if (
    typeof sessionKey !== "string" || sessionKey.length < 1 || sessionKey.length > 512 ||
    typeof clientSessionId !== "string" || clientSessionId.length < 1 || clientSessionId.length > 256 ||
    typeof agentId !== "string" || agentId.length < 1 || agentId.length > 64
  ) {
    return null;
  }
  if (!isPlainRecord(peer) || !hasOnlyKeys(peer, ["id", "kind"]) || peer.kind !== "dm" || peer.id !== clientSessionId) {
    return null;
  }
  const canonical = `agent:${agentId}:webchat:dm:${peer.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  if (sessionKey !== canonical) return null;
  return { sessionKey, clientSessionId, agentId, peer: { id: peer.id, kind: "dm" } };
}

function parsePromptQueueClaim(claim: unknown): PromptQueueDispatchRequest["claim"] | null {
  if (!isPlainRecord(claim) || !hasOnlyKeys(claim, ["epoch", "claimToken"])) return null;
  if (typeof claim.epoch !== "string" || !/^(0|[1-9][0-9]*)$/.test(claim.epoch)) return null;
  if (typeof claim.claimToken !== "string" || !/^[0-9a-f]{64}$/.test(claim.claimToken)) return null;
  return { epoch: claim.epoch, claimToken: claim.claimToken };
}

function validatePromptQueueExecutionFields(
  exec: Record<string, unknown>,
  expectedAgentId: string,
): boolean {
  if (!hasOnlyKeys(exec, PQ_EXECUTION_KEYS) || exec.agentId !== expectedAgentId) return false;
  if (exec.model !== undefined && typeof exec.model !== "string") return false;
  if (
    exec.modelSwitchId !== undefined &&
    (typeof exec.modelSwitchId !== "string" || !/^[A-Za-z0-9:_-]{8,128}$/.test(exec.modelSwitchId))
  ) {
    return false;
  }
  if (
    exec.modelSwitchConsent !== undefined &&
    (typeof exec.modelSwitchConsent !== "string" || exec.modelSwitchConsent.length > 4096)
  ) {
    return false;
  }
  if (exec.effortLevel !== undefined && exec.effortLevel !== null && typeof exec.effortLevel !== "string") {
    return false;
  }
  return true;
}

function validatePromptQueueExecutionOptions(raw: Record<string, unknown>): boolean {
  if (raw.teamMode !== undefined && typeof raw.teamMode !== "boolean") return false;
  if (raw.swarmMode !== undefined && typeof raw.swarmMode !== "boolean") return false;
  const cm = raw.collabMode;
  if (cm !== undefined && cm !== "solo" && cm !== "advisor" && cm !== "team") return false;
  if (raw.advisorModel !== undefined && typeof raw.advisorModel !== "string") return false;
  if (raw.collabConfigVersion !== undefined && typeof raw.collabConfigVersion !== "string") return false;
  if (raw.contextTier !== undefined && !isCursorContextTier(raw.contextTier)) return false;
  if (raw.serviceTier !== undefined && raw.serviceTier !== null && !isServiceTier(raw.serviceTier)) {
    return false;
  }
  return true;
}

function buildPromptQueueExecution(
  raw: Record<string, unknown>,
  expectedAgentId: string,
): PromptQueueDispatchRequest["item"]["requestedExecution"] {
  const out: PromptQueueDispatchRequest["item"]["requestedExecution"] = { agentId: expectedAgentId };
  if (typeof raw.model === "string") out.model = raw.model;
  if (typeof raw.modelSwitchId === "string") out.modelSwitchId = raw.modelSwitchId;
  if (typeof raw.modelSwitchConsent === "string") out.modelSwitchConsent = raw.modelSwitchConsent;
  if (raw.effortLevel !== undefined) out.effortLevel = raw.effortLevel as string | null;
  if (typeof raw.teamMode === "boolean") out.teamMode = raw.teamMode;
  if (typeof raw.swarmMode === "boolean") out.swarmMode = raw.swarmMode;
  if (raw.collabMode === "solo" || raw.collabMode === "advisor" || raw.collabMode === "team") {
    out.collabMode = raw.collabMode;
  }
  if (typeof raw.advisorModel === "string") out.advisorModel = raw.advisorModel;
  if (typeof raw.collabConfigVersion === "string") out.collabConfigVersion = raw.collabConfigVersion;
  if (isCursorContextTier(raw.contextTier)) out.contextTier = raw.contextTier;
  if (raw.serviceTier === null || isServiceTier(raw.serviceTier)) out.serviceTier = raw.serviceTier;
  return out;
}

function parsePromptQueueExecution(
  raw: unknown,
  expectedAgentId: string,
): PromptQueueDispatchRequest["item"]["requestedExecution"] | null {
  if (!isPlainRecord(raw) || !validatePromptQueueExecutionFields(raw, expectedAgentId)) return null;
  if (!validatePromptQueueExecutionOptions(raw)) return null;
  return buildPromptQueueExecution(raw, expectedAgentId);
}

export function parsePromptQueueDispatchRequest(value: unknown): PromptQueueDispatchRequest | null {
  if (!isPlainRecord(value) || value.type !== PROMPT_QUEUE_DISPATCH_REQUEST_TYPE) return null;
  if (!hasOnlyKeys(value, ["type", "grantId", "owner", "claim", "item"])) return null;
  if (typeof value.grantId !== "string" || !/^[0-9a-f-]{36}$/.test(value.grantId)) return null;
  const owner = parsePromptQueueOwner(value.owner);
  const claim = parsePromptQueueClaim(value.claim);
  if (!owner || !claim) return null;
  const rawItem = value.item;
  if (
    !isPlainRecord(rawItem) ||
    !hasOnlyKeys(rawItem, ["itemId", "clientMessageId", "contentHash", "content", "requestedExecution"])
  ) {
    return null;
  }
  if (
    !isClientMessageId(rawItem.itemId) ||
    !isClientMessageId(rawItem.clientMessageId) ||
    typeof rawItem.contentHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(rawItem.contentHash) ||
    !isPlainRecord(rawItem.content)
  ) {
    return null;
  }
  const requestedExecution = parsePromptQueueExecution(rawItem.requestedExecution, owner.agentId);
  if (!requestedExecution) return null;
  return {
    type: PROMPT_QUEUE_DISPATCH_REQUEST_TYPE,
    grantId: value.grantId,
    owner,
    claim,
    item: {
      itemId: rawItem.itemId,
      clientMessageId: rawItem.clientMessageId,
      contentHash: rawItem.contentHash,
      content: rawItem.content,
      requestedExecution,
    },
  };
}

function validatePromptQueueControlEnvelope(
  value: Record<string, unknown>,
): PromptQueueDispatchRequest | null {
  return parsePromptQueueDispatchRequest({
    type: PROMPT_QUEUE_DISPATCH_REQUEST_TYPE,
    grantId: value.grantId,
    owner: value.owner,
    claim: { epoch: value.epoch, claimToken: value.claimToken },
    item: {
      itemId: value.itemId,
      clientMessageId: value.itemId,
      contentHash: value.contentHash,
      content: {},
      requestedExecution: {
        agentId: isPlainRecord(value.owner) ? value.owner.agentId : undefined,
      },
    },
  });
}

export function parsePromptQueueDispatchCancel(value: unknown): PromptQueueDispatchCancel | null {
  if (!isPlainRecord(value) || value.type !== PROMPT_QUEUE_DISPATCH_CANCEL_TYPE) return null;
  if (
    !hasOnlyKeys(value, [
      "type",
      "grantId",
      "owner",
      "itemId",
      "contentHash",
      "epoch",
      "claimToken",
      "reasonCode",
    ])
  ) {
    return null;
  }
  const request = validatePromptQueueControlEnvelope(value);
  if (
    request === null ||
    typeof value.reasonCode !== "string" ||
    !/^[A-Z0-9_]{1,64}$/.test(value.reasonCode)
  ) {
    return null;
  }
  return {
    type: PROMPT_QUEUE_DISPATCH_CANCEL_TYPE,
    grantId: request.grantId,
    owner: request.owner,
    itemId: request.item.itemId,
    contentHash: request.item.contentHash,
    epoch: request.claim.epoch,
    claimToken: request.claim.claimToken,
    reasonCode: value.reasonCode,
  };
}

export function parsePromptQueueDispatchActivated(
  value: unknown,
): PromptQueueDispatchActivated | null {
  if (!isPlainRecord(value) || value.type !== PROMPT_QUEUE_DISPATCH_ACTIVATED_TYPE) return null;
  if (
    !hasOnlyKeys(value, [
      "type",
      "grantId",
      "owner",
      "itemId",
      "contentHash",
      "epoch",
      "claimToken",
    ])
  ) {
    return null;
  }
  const request = validatePromptQueueControlEnvelope(value);
  if (request === null) return null;
  return {
    type: PROMPT_QUEUE_DISPATCH_ACTIVATED_TYPE,
    grantId: request.grantId,
    owner: request.owner,
    itemId: request.item.itemId,
    contentHash: request.item.contentHash,
    epoch: request.claim.epoch,
    claimToken: request.claim.claimToken,
  };
}

function samePromptQueueOwner(
  a: PromptQueueDispatchRequest["owner"],
  b: PromptQueueDispatchRequest["owner"],
): boolean {
  return (
    a.sessionKey === b.sessionKey &&
    a.clientSessionId === b.clientSessionId &&
    a.agentId === b.agentId &&
    a.peer.id === b.peer.id &&
    a.peer.kind === b.peer.kind
  );
}

export function samePromptQueueDispatch(
  control: PromptQueueDispatchCancel | PromptQueueDispatchActivated,
  request: PromptQueueDispatchRequest,
): boolean {
  return (
    control.grantId === request.grantId &&
    samePromptQueueOwner(control.owner, request.owner) &&
    control.itemId === request.item.itemId &&
    control.contentHash === request.item.contentHash &&
    control.epoch === request.claim.epoch &&
    control.claimToken === request.claim.claimToken
  );
}

export function codexAbandonFailureCode(reason: string): JournalFailureCode {
  if (reason.startsWith("bridge_disconnect_")) return "CLIENT_ABORT";
  if (
    reason === "rewritten_frame_too_big" ||
    reason === "codex_billing_engine_session_id_invalid"
  ) {
    return "INVALID_REQUEST";
  }
  if (reason === "container_forward_rejected") return "UPSTREAM_UNAVAILABLE";
  if (reason.startsWith("sign_boundary_")) return "INTERNAL_ERROR";
  return "INTERNAL_ERROR";
}

export function ensureRequestIdServerSide(): string {
  return randomBytes(16).toString("hex");
}

export function parseWsUrl(req: IncomingMessage): URL | null {
  const raw = req.url ?? "/";
  try {
    return new URL(raw, "http://placeholder");
  } catch (err) {
    void err;
    return null;
  }
}

export function rejectHttp(socket: Duplex, status: number, body: string): void {
  if (socket.destroyed) return;
  const reasonPhrase = status === 400 ? "Bad Request" : status === 401 ? "Unauthorized" : "Error";
  const headers = [
    `HTTP/1.1 ${status} ${reasonPhrase}`,
    "Content-Type: application/json; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "Connection: close",
  ];
  try {
    socket.end(`${headers.join("\r\n")}\r\n\r\n${body}`);
  } catch (err) {
    void err;
    try {
      socket.destroy();
    } catch (destroyErr) {
      void destroyErr;
    }
  }
}

export function uidFromClaims(claims: AccessClaims): bigint {
  if (!/^[1-9][0-9]{0,19}$/.test(claims.sub)) {
    throw new TypeError(`bad uid in claims.sub: ${claims.sub}`);
  }
  return BigInt(claims.sub);
}

export function rawDataLen(data: RawData): number {
  if (typeof data === "string") return Buffer.byteLength(data);
  if (Buffer.isBuffer(data)) return data.length;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (Array.isArray(data)) return data.reduce((acc, b) => acc + b.length, 0);
  return 0;
}

export function _sanitizeMasterHistoricalMessagesForFrame(
  rawMessages: unknown[],
  opts: { excludeClientMessageId?: string } = {},
): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const raw of rawMessages) {
    if (!raw || typeof raw !== "object") continue;
    const msg = raw as Record<string, unknown>;
    if (
      opts.excludeClientMessageId &&
      (msg.id === opts.excludeClientMessageId ||
        msg._clientMessageId === opts.excludeClientMessageId)
    ) {
      continue;
    }
    const role = modelHistorySemanticRole(msg);
    if (!role || msg.system === true) continue;
    const text = modelHistorySemanticText(msg);
    if (!text.trim()) continue;
    const out: Record<string, unknown> = { role, text };
    if (typeof msg.id === "string") out.id = msg.id;
    if (typeof msg.status === "string") out.status = msg.status;
    if (typeof msg.ts === "number") out.ts = msg.ts;
    rows.push(out);
  }
  return rows;
}

export function inboundTurnIdentityFromParsed(parsed: unknown): InboundTurnIdentity {
  if (parsed === null || typeof parsed !== "object") {
    return { peerId: null, clientMessageId: null };
  }
  const peerObj = (parsed as { peer?: { id?: unknown } }).peer;
  const peerIdRaw =
    peerObj && typeof peerObj === "object" ? (peerObj as { id?: unknown }).id : undefined;
  const peerId = typeof peerIdRaw === "string" && peerIdRaw !== "" ? peerIdRaw : null;
  const cmidRaw = (parsed as { clientMessageId?: unknown }).clientMessageId;
  const clientMessageId = isClientMessageId(cmidRaw) ? cmidRaw : null;
  return { peerId, clientMessageId };
}

export function sendSessionDeletedFrame(
  ws: WebSocket,
  turn: { peerId?: string | null; clientMessageId?: string | null },
): void {
  sendErrorFrame(ws, "SESSION_DELETED", SESSION_DELETED_WIRE_MESSAGE, {
    ...turn,
    retryable: false,
    action: "new_session",
  });
}

export function encode4503Reason(retryAfterSec: number, reason: string): string {
  const safeReason = reason.slice(0, 64);
  return JSON.stringify({ retryAfterSec, reason: safeReason });
}

export function sanitizeCloseCode(code: number): number {
  if (code === 1005 || code === 1006 || code === 1015) return CLOSE_BRIDGE.NORMAL;
  if (code >= 1000 && code <= 4999) return code;
  return CLOSE_BRIDGE.NORMAL;
}

export async function resolveTurnGoalState(
  loadGoalState: (uid: bigint, sessionId: string) => Promise<GoalStateSnapshot | null>,
  uid: bigint,
  sessionId: string,
): Promise<TurnGoalResolution> {
  try {
    return { kind: "ok", goalState: await loadGoalState(uid, sessionId) };
  } catch (err) {
    if (err instanceof GoalStateError && err.code === "NOT_FOUND") {
      return { kind: "ok", goalState: null };
    }
    return { kind: "unavailable", err };
  }
}

export async function isCursorContainerOnSelfHost(
  pgPool: Pool,
  containerId: number,
  uid: bigint,
  selfHostId: string | null | undefined,
): Promise<boolean> {
  const trustedHostId = selfHostId?.trim();
  if (!trustedHostId) return false;
  const eligible = await pgPool.query<{ ok: number }>(
    `SELECT 1 AS ok FROM agent_containers
      WHERE id=$1 AND user_id=$2 AND state='active' AND host_uuid=$3::uuid
        AND runtime_kind = 'docker'`,
    [containerId, uid, trustedHostId],
  );
  return eligible.rowCount === 1;
}

export function resolveContainerLinkBrokerRuntimeChannel(
  deps: UserChatBridgeDeps,
): string | undefined {
  return deps.containerLinkToolBrokerEnabled ? "v5" : deps.containerLinkRecovery?.channel;
}

export function codexPeerKey(peerId: string | null): string {
  return peerId === null ? "__missing_peer__" : `peer:${peerId}`;
}

export function safeTokenBigInt(v: unknown): bigint {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return 0n;
  return BigInt(Math.trunc(v));
}

export function closeWsSafely(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch (err) {
    void err;
  }
}

export function terminateWsSafely(ws: WebSocket): void {
  try {
    ws.terminate();
  } catch (err) {
    void err;
  }
}

export function sendJsonSafely(ws: WebSocket, payload: unknown): boolean {
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch (err) {
    void err;
    return false;
  }
}

export function readWsCloseMeta(ws: WebSocket): { closeCode: number; closeReason: string } {
  if (ws.readyState !== WebSocket.CLOSED) {
    return { closeCode: CLOSE_BRIDGE.NORMAL, closeReason: "" };
  }
  const rawCode = Reflect.get(ws, "_closeCode");
  const rawMessage = Reflect.get(ws, "_closeMessage");
  return {
    closeCode: typeof rawCode === "number" ? rawCode : CLOSE_BRIDGE.NORMAL,
    closeReason: rawMessage !== undefined && rawMessage !== null ? String(rawMessage) : "",
  };
}
