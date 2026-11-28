/**
 * Permission prompt request / settled / snapshot reconciliation reducers (§3 去重).
 */
import type { PermissionPromptSnapshotPayload } from "../../types";
import type { OutboundPermissionRequestWire, OutboundPermissionSettledWire } from "../frames";
import { addMessage, type ChatMessage, type ChatSession } from "../model";
import {
  permissionSnapshotToRequestFrame,
  reconcilePermissionSnapshot,
} from "../permissionReconcile";
import { isImmutableTapeViewportRow, noteFrameSeqIfNewer } from "./frameSeqCursor";

function applyPermissionSettlementToCard(
  msg: ChatMessage,
  settlement: {
    behavior: "allow" | "deny";
    reason?: string | null;
    answers?: Record<string, string>;
  },
): void {
  msg._resolved = true;
  msg._behavior = settlement.behavior;
  msg._settledReason = settlement.reason || null;
  if (settlement.answers && typeof settlement.answers === "object") {
    msg._answers = settlement.answers;
  }
}

function consumePendingPermissionSettlement(sess: ChatSession, msg: ChatMessage): void {
  const requestId = msg.requestId;
  if (!requestId || !sess._pendingPermissionSettlements) return;
  const pending = sess._pendingPermissionSettlements[requestId];
  if (!pending) return;
  applyPermissionSettlementToCard(msg, pending);
  delete sess._pendingPermissionSettlements[requestId];
}

/** Bounded so a long-lived session cannot grow the persisted set forever. */
export const SETTLED_PERMISSION_REQUEST_IDS_MAX = 200;

/** Remember that `requestId` is settled from this browser's point of view. */
export function rememberSettledPermissionRequestId(
  sess: ChatSession,
  requestId: string | undefined,
): void {
  if (typeof requestId !== "string" || !requestId) return;
  const set = sess._settledPermissionRequestIds ?? {};
  if (set[requestId] === true) return;
  set[requestId] = true;
  const keys = Object.keys(set);
  for (let i = 0; i < keys.length - SETTLED_PERMISSION_REQUEST_IDS_MAX; i++) delete set[keys[i]];
  sess._settledPermissionRequestIds = set;
}

export function isSettledPermissionRequestId(
  sess: ChatSession,
  requestId: string | undefined,
): boolean {
  return typeof requestId === "string" && sess._settledPermissionRequestIds?.[requestId] === true;
}

function isAskUserRequestId(requestId: unknown): requestId is string {
  return typeof requestId === "string" && requestId.startsWith("ask-user:");
}

function updateExistingPermissionCard(
  sess: ChatSession,
  existing: ChatMessage,
  frame: OutboundPermissionRequestWire,
): ChatMessage {
  const incomingTruncated = (frame as { inputTruncated?: unknown }).inputTruncated === true;
  if (!incomingTruncated && frame.inputJson && typeof frame.inputJson === "object") {
    existing.inputJson = frame.inputJson as Record<string, unknown>;
    existing._inputTruncated = false;
    if (frame.inputPreview) existing.inputPreview = frame.inputPreview;
  }
  consumePendingPermissionSettlement(sess, existing);
  return existing;
}

function buildPermissionCardExtra(
  sess: ChatSession,
  frame: OutboundPermissionRequestWire,
): Partial<ChatMessage> {
  const requestId = frame.requestId;
  const askUser = isAskUserRequestId(requestId);
  const detachedAskUser = (frame as { detachedAskUser?: unknown }).detachedAskUser === true || askUser;
  const expiresAt = (frame as { expiresAt?: unknown }).expiresAt;
  const toolUseIdRaw = (frame as { toolUseId?: unknown }).toolUseId;
  const inputTruncated = (frame as { inputTruncated?: unknown }).inputTruncated === true;
  const turnOwnerId = frame.clientMessageId ?? sess._activeClientMessageId;
  return {
    ...(askUser ? { id: requestId } : {}),
    requestId,
    toolName: frame.toolName,
    inputPreview: frame.inputPreview || "",
    inputJson: frame.inputJson || null,
    ...(inputTruncated ? { _inputTruncated: true } : {}),
    ...(typeof toolUseIdRaw === "string" && toolUseIdRaw ? { toolUseId: toolUseIdRaw } : {}),
    _resolved: false,
    ...(detachedAskUser ? { _detachedAskUser: true } : {}),
    ...(typeof expiresAt === "number" ? { _askUserExpiresAt: expiresAt } : {}),
    ...(turnOwnerId ? { _turnOwnerId: turnOwnerId } : {}),
  };
}

export function applyPermissionRequest(
  sess: ChatSession,
  frame: OutboundPermissionRequestWire,
): ChatMessage | null {
  noteFrameSeqIfNewer(sess, frame);
  const requestId = frame.requestId;
  const existing = sess.messages.find(
    (m) =>
      m.role === "permission" &&
      !isImmutableTapeViewportRow(m) &&
      (m.requestId === requestId || m.id === requestId),
  );
  if (existing) return updateExistingPermissionCard(sess, existing, frame);

  const stashedSettlement = sess._pendingPermissionSettlements?.[requestId];
  if (!stashedSettlement && isSettledPermissionRequestId(sess, requestId) && !isAskUserRequestId(requestId)) {
    return null;
  }
  const card = addMessage(sess, "permission", frame.toolName, buildPermissionCardExtra(sess, frame));
  consumePendingPermissionSettlement(sess, card);
  return card;
}

export function applyPermissionSettled(
  sess: ChatSession,
  frame: OutboundPermissionSettledWire,
): void {
  noteFrameSeqIfNewer(sess, frame);
  const requestId = frame.requestId;
  const msg = sess.messages.find(
    (m) => (m.requestId === requestId || m.id === requestId) && !isImmutableTapeViewportRow(m),
  );
  const settlement = {
    behavior: frame.behavior,
    reason: frame.reason || null,
    ...(frame.answers && typeof frame.answers === "object" ? { answers: frame.answers } : {}),
  };
  rememberSettledPermissionRequestId(sess, requestId);
  if (!msg) {
    sess._pendingPermissionSettlements = sess._pendingPermissionSettlements ?? {};
    sess._pendingPermissionSettlements[requestId] = settlement;
    return;
  }
  applyPermissionSettlementToCard(msg, settlement);
}

/** Apply a session-GET permission snapshot. Settled rows converge cards;
 *  pending rows missing locally materialise. Absence is not expiry. */
export function applyPermissionSnapshot(
  sess: ChatSession,
  snapshot: PermissionPromptSnapshotPayload | null | undefined,
  nowMs: number = Date.now(),
): string[] {
  if (!snapshot) return [];
  const localCards = sess.messages
    .filter((m) => m.role === "permission" && typeof m.requestId === "string")
    .map((m) => ({
      requestId: m.requestId as string,
      updatedAt: m.ts,
      resolved: m._resolved === true,
      behavior: m._behavior ?? null,
    }));
  const plan = reconcilePermissionSnapshot({ localCards, snapshot, nowMs });
  for (const item of plan.materialize) {
    applyPermissionRequest(
      sess,
      permissionSnapshotToRequestFrame(item, sess.id, nowMs, sess.agentId || "main"),
    );
  }
  for (const settlement of plan.settle) {
    if (settlement.behavior === "allow" || settlement.behavior === "deny") {
      applyPermissionSettled(sess, {
        type: "outbound.permission_settled",
        sessionKey: `agent:${sess.agentId || "main"}:webchat:dm:${sess.id}`,
        channel: "webchat",
        peer: { id: sess.id, kind: "dm" },
        requestId: settlement.requestId,
        behavior: settlement.behavior,
        reason: settlement.reason ?? undefined,
        ...(settlement.answers ? { answers: settlement.answers } : {}),
      } as Parameters<typeof applyPermissionSettled>[1]);
    } else {
      rememberSettledPermissionRequestId(sess, settlement.requestId);
      const msg = sess.messages.find((m) => m.requestId === settlement.requestId);
      if (msg) {
        msg._resolved = true;
        msg._settledReason = settlement.reason || "accepted";
      }
    }
    if (settlement.status === "responded") {
      const msg = sess.messages.find((m) => m.requestId === settlement.requestId);
      if (msg && msg._settledReason == null) msg._settledReason = "accepted";
    }
  }
  return plan.lookupRequestIds;
}
