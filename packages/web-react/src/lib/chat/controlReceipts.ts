import type { StoredPendingControl } from "../persist";
import type { OutboundControlReceiptWire } from "./frames";
import type { ChatSession } from "./model";

export type PendingControlItem = Omit<StoredPendingControl, "status"> & {
  status: "persisting" | "waiting_persist" | "queued" | "awaiting_receipt" | "persisted";
};

type ReceiptContext = {
  queue: PendingControlItem[];
  sessions: Map<string, ChatSession>;
  settle(controlId: string, status: "applied" | "terminal"): void;
  persist?(sessId: string): unknown;
  notify(): void;
  notice(sessId: string, text: string): void;
  sync?(sessId: string, context: { clientMessageId: string }): unknown;
};

/** A runtime miss is not proof that a turn ended. Only Master's exact PG
 * terminal evidence may show the ended notice; REST supplies the outcome. */
export function applyControlReceipt(frame: OutboundControlReceiptWire, context: ReceiptContext): void {
  const item = context.queue.find((candidate) => candidate.controlId === frame.controlId);
  if (!item || item.controlKind !== frame.controlKind) return;
  if (frame.peer?.id && frame.peer.id !== item.sessId) return;
  if (item.clientMessageId && frame.clientMessageId && frame.clientMessageId !== item.clientMessageId) return;
  if (item.requestId && frame.requestId && frame.requestId !== item.requestId) return;
  const sess = context.sessions.get(item.sessId);
  if (frame.status === "persisted" || (frame.status === "applied" && item.controlKind === "stop")) {
    item.status = "persisted";
    if (item.controlKind === "stop" && item.fenceOnly === true) return;
    const stopSettlement = sess?._stopSettlement;
    if (sess && stopSettlement?.controlId === frame.controlId) {
      stopSettlement.phase = "persisted";
      sess._recoveryStatus = {
        kind: "stopping",
        masterPersisted: true,
        attempt: frame.attempt ?? item.attempt,
        ...(frame.errorCode ? { errorCode: frame.errorCode } : {}),
      };
    } else if (sess) {
      sess._recoveryStatus = {
        kind: "needs-confirmation",
        attempt: frame.attempt ?? item.attempt,
        ...(frame.errorCode ? { errorCode: frame.errorCode } : {}),
      };
    }
    context.persist?.(item.sessId);
    context.notify();
    return;
  }
  const exactStop = item.controlKind === "stop" && item.fenceOnly !== true && sess &&
    frame.peer?.id === item.sessId && !!item.clientMessageId && frame.clientMessageId === item.clientMessageId;
  context.settle(frame.controlId, frame.status);
  if (exactStop && (frame.errorCode === "TURN_ALREADY_ENDED" || frame.errorCode === "TURN_NOT_ACTIVE")) {
    if (frame.errorCode === "TURN_ALREADY_ENDED") context.notice(item.sessId, "该回合已结束");
    void Promise.resolve(context.sync?.(item.sessId, { clientMessageId: item.clientMessageId! })).catch(() => {});
  }
}

/** Settle a session's active `_stopSettlement` when terminal turn evidence arrives
 *  (either `isFinal` message or post-Stop cancel-fenced `outbound.error`). Returns
 *  `true` when a `controlId`-less settlement transitioned to `phase: "sync"`. */
export function settleTurnStopSettlement(
  sess: ChatSession,
  clientMessageId: string | undefined,
  settle: (controlId: string, status: "applied" | "terminal") => void,
): boolean {
  const settlement = sess._stopSettlement;
  if (!settlement) return false;
  if (settlement.clientMessageId && clientMessageId !== settlement.clientMessageId) return false;
  if (settlement.controlId) {
    settle(settlement.controlId, "terminal");
    if (sess._stopSettlement === settlement) {
      sess._stopSettlement = undefined;
      if (sess._recoveryStatus?.kind === "stopping") sess._recoveryStatus = { kind: "completed" };
    }
    return false;
  }
  sess._stopSettlement = {
    ...(settlement.clientMessageId ? { clientMessageId: settlement.clientMessageId } : {}),
    phase: "sync",
  };
  return true;
}
