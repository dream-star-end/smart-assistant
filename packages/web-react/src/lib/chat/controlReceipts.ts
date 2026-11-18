import type { StoredPendingControl } from "../persist";
import type { OutboundControlReceiptWire } from "./frames";
import type { ChatMessage, ChatSession } from "./model";

export const CONTROL_PERSIST_TIMEOUT_MS = 2_500;

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

/** `_controlPending` mirrors in-flight items in `controlQueue` and must never be
 *  written inline into best-effort session snapshots. */
export function stripTransientControlFlags(messages: ChatMessage[]): ChatMessage[] {
  if (!messages.some((m) => m != null && m._controlPending !== undefined)) return messages;
  return messages.map((m) => {
    if (!m || m._controlPending === undefined) return m;
    const clean = { ...m };
    delete clean._controlPending;
    return clean;
  });
}

/** Rehydrate durable `_pendingControls` onto either a freshly loaded or an
 *  already-present (REST-first) session without resurrecting settled prompts. */
export function hydrateStoredControls(
  sess: ChatSession,
  rawControls: unknown,
  isSettled: (sess: ChatSession, requestId: string | undefined) => boolean,
  enqueue: (item: PendingControlItem) => void,
): boolean {
  const storedControls = Array.isArray(rawControls)
    ? rawControls.filter((item): item is StoredPendingControl =>
        item?.kind === "control" &&
        item.sessId === sess.id &&
        typeof item.controlId === "string" &&
        item.payload?.controlId === item.controlId)
    : [];
  let hydrated = false;
  for (const control of storedControls) {
    if (control.controlKind === "permission" && control.requestId) {
      const permission = sess.messages.find((m) => m.requestId === control.requestId);
      if (permission?._resolved === true || isSettled(sess, control.requestId)) continue;
      if (permission) permission._controlPending = true;
      sess._recoveryStatus = { kind: "needs-confirmation" };
    } else if (control.controlKind === "stop" && control.fenceOnly === true) {
      // 围栏 stop 只需重放到 master;不代表在飞 turn,不进入停止态。
    } else if (control.controlKind === "stop") {
      sess._sendingInFlight = true;
      sess._activeClientMessageId = control.clientMessageId;
      sess._stopSettlement = {
        ...(control.clientMessageId ? { clientMessageId: control.clientMessageId } : {}),
        controlId: control.controlId,
        phase: "awaiting_receipt",
      };
      sess._recoveryStatus = { kind: "stopping" };
    }
    enqueue({ ...control, status: "queued" });
    hydrated = true;
  }
  return hydrated;
}

/** Clear orphan `_controlPending` flags (or restore missing ones) whenever
 *  authoritative pending permission state is reconciled against `controlQueue`. */
export function reconcileOrphanControlPending(
  sess: ChatSession,
  queue: readonly PendingControlItem[],
): boolean {
  const activeIds = new Set<string>();
  for (const item of queue) {
    if (item.sessId === sess.id && item.controlKind === "permission" && typeof item.requestId === "string") {
      activeIds.add(item.requestId);
    }
  }
  let changed = false;
  for (const m of sess.messages) {
    if (!m || m.role !== "permission") continue;
    const shouldBePending =
      m._resolved !== true && typeof m.requestId === "string" && activeIds.has(m.requestId);
    if (shouldBePending && m._controlPending !== true) {
      m._controlPending = true;
      changed = true;
    } else if (!shouldBePending && m._controlPending === true) {
      m._controlPending = false;
      changed = true;
    }
  }
  return changed;
}

function restoreRecoveryStatusAfterControlPersist(sess: ChatSession | undefined, item: PendingControlItem): boolean {
  if (!sess || sess._recoveryStatus?.kind !== "waiting-service") return false;
  if (item.controlKind === "stop") {
    sess._recoveryStatus = item.fenceOnly ? undefined : { kind: "stopping" };
  } else {
    sess._recoveryStatus = { kind: "needs-confirmation" };
  }
  return true;
}

/** Persist a control entry into IndexedDB before sending, but degrade to live
 *  in-memory delivery after one retry or a blocked-DB timeout instead of stranding
 *  the prompt in "正在提交…". */
export function persistControlWithFallback(
  item: PendingControlItem,
  ctx: {
    queue: PendingControlItem[];
    sessions: Map<string, ChatSession>;
    timers: Map<string, ReturnType<typeof setTimeout>>;
    persist?: (durable: StoredPendingControl) => Promise<void>;
    pump: () => void;
    retry: (item: PendingControlItem) => void;
    notify: () => void;
  },
): void {
  if (!ctx.queue.includes(item) || item.status === "persisting") return;
  item.status = "persisting";
  if (!ctx.persist) {
    // Test/SSR adapters without storage still use the rolling-compatible
    // in-memory path. Production always wires SessionStore.
    item.status = "queued";
    ctx.pump();
    return;
  }
  const durable: StoredPendingControl = { ...item, status: "queued" };
  const priorTimer = ctx.timers.get(item.controlId);
  if (priorTimer) clearTimeout(priorTimer);
  let settled = false;
  const finishPersist = (ok: boolean, timedOut: boolean): void => {
    if (settled) return;
    settled = true;
    clearTimeout(persistTimer);
    if (ctx.timers.get(item.controlId) === persistTimer) {
      ctx.timers.delete(item.controlId);
    }
    if (!ctx.queue.includes(item) || item.status !== "persisting") return;
    const sess = ctx.sessions.get(item.sessId);
    if (ok) {
      item.status = "queued";
      if (restoreRecoveryStatusAfterControlPersist(sess, item)) ctx.notify();
      ctx.pump();
      return;
    }
    if (!timedOut && item.attempt === 0) {
      item.status = "waiting_persist";
      item.attempt += 1;
      if (sess) {
        sess._recoveryStatus = {
          kind: "waiting-service",
          attempt: item.attempt,
          errorCode: "control_journal_unavailable",
        };
        ctx.notify();
      }
      const retryTimer = setTimeout(() => {
        if (ctx.timers.get(item.controlId) === retryTimer) {
          ctx.timers.delete(item.controlId);
        }
        ctx.retry(item);
      }, 1000);
      ctx.timers.set(item.controlId, retryTimer);
      return;
    }
    // Hung or persistently failing IndexedDB must not trap controls in waiting_persist:
    // keep FIFO order in `queue` and allow immediate WebSocket delivery.
    item.status = "queued";
    if (restoreRecoveryStatusAfterControlPersist(sess, item)) ctx.notify();
    ctx.pump();
  };
  const persistTimer = setTimeout(() => {
    finishPersist(false, true);
  }, CONTROL_PERSIST_TIMEOUT_MS);
  ctx.timers.set(item.controlId, persistTimer);
  let attemptPromise: Promise<void>;
  try {
    attemptPromise = Promise.resolve(ctx.persist(durable));
  } catch (err) {
    attemptPromise = Promise.reject(err);
  }
  void attemptPromise.then(
    () => finishPersist(true, false),
    () => finishPersist(false, false),
  );
}
