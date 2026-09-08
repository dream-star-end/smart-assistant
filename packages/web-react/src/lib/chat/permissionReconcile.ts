/**
 * Pure permission-prompt reconcile (OCV5-185).
 *
 * Server pending missing locally → materialise.
 * Server settled → converge local unresolved cards.
 * A newer local settlement is never resurrected by an older pending snapshot.
 * Absence from the page is not expiry; local clock cannot forge a server cancel.
 * Truncated pages emit lookupRequestIds for cards outside the recent window.
 * Unavailable pages must not auto-settle anything from absence.
 * `responded` is acceptance, not tool-execution success.
 */
import type {
  PermissionPromptSnapshotItem,
  PermissionPromptSnapshotPayload,
} from "../types";

export type LocalPermissionCard = {
  requestId: string;
  updatedAt?: number;
  resolved: boolean;
  behavior?: "allow" | "deny" | null;
};

export type PermissionReconcileResult = {
  materialize: PermissionPromptSnapshotItem[];
  settle: Array<{
    requestId: string;
    behavior: "allow" | "deny" | null;
    reason: string | null;
    answers: Record<string, string> | null;
    status: PermissionPromptSnapshotItem["status"];
  }>;
  lookupRequestIds: string[];
};

const TERMINAL: ReadonlySet<PermissionPromptSnapshotItem["status"]> = new Set([
  "responded",
  "cancelled",
  "expired",
]);

export function reconcilePermissionSnapshot(input: {
  localCards: LocalPermissionCard[];
  snapshot: PermissionPromptSnapshotPayload | null | undefined;
  nowMs?: number;
}): PermissionReconcileResult {
  const localCards = input.localCards;
  const snapshot = input.snapshot;
  const result: PermissionReconcileResult = {
    materialize: [],
    settle: [],
    lookupRequestIds: [],
  };
  if (!snapshot) return result;

  const byId = new Map<string, PermissionPromptSnapshotItem>();
  for (const item of snapshot.items) {
    if (typeof item.requestId === "string" && item.requestId) byId.set(item.requestId, item);
  }
  for (const item of snapshot.lookups ?? []) {
    if (typeof item.requestId === "string" && item.requestId) byId.set(item.requestId, item);
  }

  const localById = new Map<string, LocalPermissionCard>();
  for (const card of localCards) {
    if (card.requestId) localById.set(card.requestId, card);
  }

  for (const item of byId.values()) {
    const local = localById.get(item.requestId);
    if (item.status === "pending") {
      if (local?.resolved) {
        const localUpdated = local.updatedAt ?? 0;
        if (localUpdated >= item.updatedAt) continue;
      }
      if (!local || !item.inputTruncated) result.materialize.push(item);
      if (item.inputTruncated) result.lookupRequestIds.push(item.requestId);
      continue;
    }
    if (!TERMINAL.has(item.status)) continue;
    if (local?.resolved) continue;
    const behavior: "allow" | "deny" | null =
      item.behavior === "allow" || item.behavior === "deny"
        ? item.behavior
        : item.status === "responded"
          ? null
          : "deny";
    result.settle.push({
      requestId: item.requestId,
      behavior,
      reason: item.reason,
      answers: item.answers,
      status: item.status,
    });
  }

  if (snapshot.completeness !== "unavailable") {
    for (const card of localCards) {
      if (card.resolved) continue;
      if (!byId.has(card.requestId)) result.lookupRequestIds.push(card.requestId);
    }
  }

  return result;
}

export function permissionSnapshotToRequestFrame(
  item: PermissionPromptSnapshotItem,
  sessId: string,
  nowMs: number = Date.now(),
  agentId: string = "main",
): {
  type: "outbound.permission_request";
  sessionKey: string;
  channel: "webchat";
  peer: { id: string; kind: "dm" };
  requestId: string;
  toolName: string;
  toolUseId?: string;
  clientMessageId?: string;
  inputPreview: string;
  inputJson?: Record<string, unknown>;
  inputTruncated?: true;
  expiresAt: number;
  detachedAskUser?: true;
  ts: number;
} {
  return {
    type: "outbound.permission_request",
    sessionKey: `agent:${agentId}:webchat:dm:${sessId}`,
    channel: "webchat",
    peer: { id: sessId, kind: "dm" },
    requestId: item.requestId,
    toolName: item.toolName,
    ...(item.toolUseId ? { toolUseId: item.toolUseId } : {}),
    ...(item.clientMessageId ? { clientMessageId: item.clientMessageId } : {}),
    inputPreview: JSON.stringify(item.inputJson).slice(0, 400),
    ...(item.inputTruncated ? { inputTruncated: true as const } : { inputJson: item.inputJson }),
    expiresAt: item.expiresAt,
    ...(item.requestId.startsWith("ask-user:") ? { detachedAskUser: true as const } : {}),
    ts: nowMs,
  };
}
