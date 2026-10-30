import { expect, test, vi } from "vitest";
import { applyControlReceipt, type PendingControlItem } from "./controlReceipts";
import type { OutboundControlReceiptWire } from "./frames";
import { addMessage, createSession } from "./model";

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

test("confirmed ended receipt displays a notice and reads the exact authoritative turn without changing its outcome", () => {
  const { session, frame, context } = fixture();
  const completed = addMessage(session, "assistant", "completed answer", { _clientMessageId: "m-own", _dispatchOutcome: "completed" });
  const crashed = addMessage(session, "system", "crash evidence", { _clientMessageId: "m-other", _dispatchOutcome: "crashed", _errorCode: "engine_error" });
  const before = structuredClone(session.messages);
  applyControlReceipt(frame, context);
  expect(context.settle).toHaveBeenCalledWith(frame.controlId, "terminal");
  expect(context.notice).toHaveBeenCalledWith(session.id, "该回合已结束");
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
