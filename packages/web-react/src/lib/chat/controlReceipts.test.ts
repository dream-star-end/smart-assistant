import { afterEach, expect, test, vi } from "vitest";
import { applyControlReceipt, DegradedJournalRetryTracker, type PendingControlItem } from "./controlReceipts";
import type { OutboundControlReceiptWire } from "./frames";
import { addMessage, createSession } from "./model";
import { DEGRADED_JOURNAL_RETRY_DELAYS_MS } from "./pure";

afterEach(() => {
  vi.useRealTimers();
});

function fixture() {
  const session = createSession({ id: "web-own", agentId: "main" });
  const item: PendingControlItem = {
    kind: "control", sessId: session.id, controlId: "control:stop:m-own", controlKind: "stop",
    clientMessageId: "m-own", agentId: "main", enqueuedAt: 1, attempt: 2, status: "awaiting_receipt",
    payload: { type: "inbound.control.stop", controlId: "control:stop:m-own", channel: "webchat", peer: { id: session.id, kind: "dm" }, clientMessageId: "m-own" },
  };
  const frame: OutboundControlReceiptWire = {
    type: "outbound.control.receipt", controlId: item.controlId, controlKind: "stop", status: "terminal",
    peer: { id: session.id, kind: "dm" }, clientMessageId: item.clientMessageId, errorCode: "TURN_ALREADY_ENDED",
  };
  const context = { queue: [item], sessions: new Map([[session.id, session]]), settle: vi.fn(), persist: vi.fn(), notify: vi.fn(), notice: vi.fn(), sync: vi.fn() };
  return { session, item, frame, context };
}

test("confirmed ended receipt silently reconciles the exact authoritative turn without transient notice", () => {
  const { session, frame, context } = fixture();
  const completed = addMessage(session, "assistant", "completed answer", { _clientMessageId: "m-own", _dispatchOutcome: "completed" });
  const crashed = addMessage(session, "system", "crash evidence", { _clientMessageId: "m-other", _dispatchOutcome: "crashed", _errorCode: "engine_error" });
  const before = structuredClone(session.messages);
  applyControlReceipt(frame, context);
  expect(context.settle).toHaveBeenCalledWith(frame.controlId, "terminal");
  expect(context.notice).not.toHaveBeenCalled();
  expect(context.sync).toHaveBeenCalledWith(session.id, { clientMessageId: "m-own" });
  expect(session.messages).toEqual(before);
  expect(completed._dispatchOutcome).toBe("completed");
  expect(crashed._dispatchOutcome).toBe("crashed");
});

test.each([
  { controlId: "control:stop:m-foreign" },
  { controlKind: "permission" as const },
  { peer: { id: "web-foreign", kind: "dm" as const } },
  { clientMessageId: "m-foreign" },
])("mismatched control identity has no effect: %j", (change) => {
  const { frame, context } = fixture();
  applyControlReceipt({ ...frame, ...change }, context);
  expect(context.settle).not.toHaveBeenCalled();
  expect(context.notice).not.toHaveBeenCalled();
  expect(context.sync).not.toHaveBeenCalled();
});

test.each([{ peer: undefined }, { clientMessageId: undefined }])("legacy incomplete receipt retains settlement but cannot claim ended: %j", (change) => {
  const { frame, context } = fixture();
  applyControlReceipt({ ...frame, ...change }, context);
  expect(context.settle).toHaveBeenCalledWith(frame.controlId, "terminal");
  expect(context.notice).not.toHaveBeenCalled();
  expect(context.sync).not.toHaveBeenCalled();
});

test("runtime TURN_NOT_ACTIVE retains existing settlement and syncs without asserting an ended result", () => {
  const { frame, context } = fixture();
  applyControlReceipt({ ...frame, errorCode: "TURN_NOT_ACTIVE" }, context);
  expect(context.settle).toHaveBeenCalledWith(frame.controlId, "terminal");
  expect(context.notice).not.toHaveBeenCalled();
  expect(context.sync).toHaveBeenCalledWith("web-own", { clientMessageId: "m-own" });
});

test("a recovery fence receipt cannot announce or reconcile an active user turn", () => {
  const { frame, item, context } = fixture();
  item.fenceOnly = true;
  applyControlReceipt(frame, context);
  expect(context.settle).toHaveBeenCalledWith(frame.controlId, "terminal");
  expect(context.notice).not.toHaveBeenCalled();
  expect(context.sync).not.toHaveBeenCalled();
});

test.each(["persisted", "applied"] as const)("Stop %s receipt keeps the journal and stopping state", (status) => {
  const { session, item, frame, context } = fixture();
  session._stopSettlement = { controlId: item.controlId, clientMessageId: item.clientMessageId, phase: "awaiting_receipt" };
  applyControlReceipt({ ...frame, status, errorCode: undefined }, context);
  expect(item.status).toBe("persisted");
  expect(session._stopSettlement.phase).toBe("persisted");
  expect(session._recoveryStatus).toEqual({ kind: "stopping", masterPersisted: true, attempt: 2 });
  expect(context.settle).not.toHaveBeenCalled();
  expect(context.notice).not.toHaveBeenCalled();
  expect(context.sync).not.toHaveBeenCalled();
});

test("DegradedJournalRetryTracker retries bounded times with backoff and stops on permanent error or clearAll", async () => {
  vi.useFakeTimers();
  const tracker = new DegradedJournalRetryTracker();
  const sess = createSession({ id: "s-deg", agentId: "main" });
  sess._liveJournalDegraded = true;
  const syncSession = vi.fn().mockResolvedValue(false);
  const ctx = { getSession: (id: string) => (id === sess.id ? sess : undefined), getEpoch: () => 1, syncSession };

  tracker.schedule(sess.id, ctx);
  for (let i = 0; i < DEGRADED_JOURNAL_RETRY_DELAYS_MS.length; i++) {
    await vi.advanceTimersByTimeAsync(DEGRADED_JOURNAL_RETRY_DELAYS_MS[i]!);
    expect(syncSession).toHaveBeenCalledTimes(i + 1);
  }
  // Exhausted: further time or repeated schedule calls do not storm
  tracker.schedule(sess.id, ctx);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(syncSession).toHaveBeenCalledTimes(DEGRADED_JOURNAL_RETRY_DELAYS_MS.length);

  // Permanent error (401/404) stops immediately after first failure
  const tracker2 = new DegradedJournalRetryTracker();
  const permSync = vi.fn().mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }));
  tracker2.schedule(sess.id, { ...ctx, syncSession: permSync });
  await vi.advanceTimersByTimeAsync(DEGRADED_JOURNAL_RETRY_DELAYS_MS[0]!);
  expect(permSync).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(permSync).toHaveBeenCalledTimes(1);

  // clearAll cancels pending timer on unmount/stop
  const tracker3 = new DegradedJournalRetryTracker();
  const cancelledSync = vi.fn().mockResolvedValue(true);
  tracker3.schedule(sess.id, { ...ctx, syncSession: cancelledSync });
  tracker3.clearAll();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(cancelledSync).not.toHaveBeenCalled();
});
