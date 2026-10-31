import { afterEach, expect, test, vi } from "vitest";
import { ChatSocket, type ChatSocketDeps } from "./socket";
import type { SessionSnapshot } from "./sessionSnapshot";

class FakeWS {
  static instances: FakeWS[] = [];
  static OPEN = 1;
  readyState = 0; bufferedAmount = 0; sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { FakeWS.instances.push(this); }
  send(data: string) { this.sent.push(data); }
  close(code = 1000, reason = "") { this.readyState = 3; this.onclose?.({ code, reason }); }
  open() { this.readyState = 1; this.onopen?.(); }
  push(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}
const cmid = "m-original";
function snapshot(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return { v: 1, sessionId: "s1", dispatch: {
    id: "d1", clientMessageId: cmid, agentId: "main", status: "accepted", outcome: null,
    attempt: 1, since: 1, acceptedAt: 2, terminalAt: null,
  }, streamKey: "dispatch:d1:1", lastFrameSeq: 0, lastFrameAt: null, engineReady: true,
    turnStatus: null, reconcile: null, pendingPermissions: { items: [], completeness: "complete" },
    usage: null, credits: null, frames: [], nextAfterSeq: 0, hasMore: false, gap: null,
    asOf: Date.now(), ...over };
}
function boot(deps: Partial<ChatSocketDeps> = {}) {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeWS);
  const sock = new ChatSocket({ getToken: () => "tok", getAuthEpoch: () => 0,
    silentRefresh: async (epoch) => ({ kind: "transient", epoch, retryAfterMs: 500 }),
    onAuthExpired: () => {}, defaultAgentId: "main", ...deps });
  sock.ensureSession("s1", "main"); sock.setActiveSession("s1"); sock.setGateReady(true);
  const ws = FakeWS.instances.at(-1)!; ws.open();
  const s = sock.sessions.get("s1")!;
  s.messages.push({ id: cmid, role: "user", text: "原任务", ts: 1 });
  s._activeClientMessageId = cmid; s._sendingInFlight = true;
  return { sock, ws, s };
}
async function flush() {
  for (let i = 0; i < 60; i++) await Promise.resolve();
  await vi.dynamicImportSettled();
  for (let i = 0; i < 60; i++) await Promise.resolve();
}
function error(code: string, over: Record<string, unknown> = {}) {
  return { type: "error", code, peer: { id: "s1", kind: "dm" }, clientMessageId: cmid, ...over };
}
afterEach(() => { FakeWS.instances = []; vi.unstubAllGlobals(); vi.useRealTimers(); });

test.each(["conflict", "bad_sequence", "turn_changed", "turn_finalized", "turn_in_flight", "turn_not_active", "active_turn"])(
  "%s reads #1216 snapshot, retains running truth and only adds a quiet record", async (code) => {
    const read = vi.fn(async () => snapshot());
    const { sock, ws, s } = boot({ readSessionSnapshot: read });
    const sent = ws.sent.length;
    ws.push(error(code)); await flush();
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith("s1", expect.objectContaining({ dispatch: cmid }));
    expect(s._sendingInFlight).toBe(true);
    expect(s.messages.some((row) => row._errorCode === code)).toBe(false);
    expect(s.messages.filter((row) => row.id === `sys-state-readback-${cmid}-${code}`)).toHaveLength(1);
    expect(ws.sent.slice(sent).some((raw) => raw.includes("inbound.message"))).toBe(false);
    sock.stop();
  });

test.each(["session_persist_unavailable", "history_enrichment_unavailable", "turn_tape_state_error",
  "turn_tape_state_unavailable", "turn_tape_unavailable", "turn_tape_visible_unavailable", "tape_not_acked", "turn_tape_retryable"])(
  "%s requires exact completed authority, HTTP success alone is insufficient", async (code) => {
    const read = vi.fn(async () => snapshot());
    const { sock, ws, s } = boot({ readSessionSnapshot: read });
    ws.push(error(code)); await flush();
    expect(read).toHaveBeenCalledTimes(1);
    expect(s.messages.some((row) => row.id.startsWith("sys-state-readback"))).toBe(false);
    expect(s.messages.some((row) => row._errorCode === code)).toBe(true);
    sock.stop();
  });

test("an unreadable snapshot applies the original error once without a read loop", async () => {
  const read = vi.fn(async () => { throw new Error("offline"); });
  const { sock, ws, s } = boot({ readSessionSnapshot: read });
  ws.push(error("bad_sequence")); await flush();
  expect(read).toHaveBeenCalledTimes(1);
  expect(s.messages.some((row) => row._errorCode === "bad_sequence")).toBe(true);
  sock.stop();
});

test.each(["session_deleted", "session_not_found", "not_found", "forbidden", "unauthorized", "insufficient_credits", "model_switch_stale", "turn_changed_extra", "turn_tape_retryable_extra"])(
  "%s keeps its existing user/permission/resource path", async (code) => {
    const read = vi.fn(async () => snapshot());
    const { sock, ws } = boot({ readSessionSnapshot: read });
    ws.push(error(code)); await flush();
    expect(read).not.toHaveBeenCalled();
    sock.stop();
  });

test("session switch/new intent while reading does not clear errors or add a success record to another turn", async () => {
  let resolve!: (snap: SessionSnapshot) => void;
  const read = vi.fn(() => new Promise<SessionSnapshot>((r) => { resolve = r; }));
  const { sock, ws, s } = boot({ readSessionSnapshot: read });
  ws.push(error("conflict")); await flush();
  s.messages.push({ id: "m-next", role: "user", text: "下一任务", ts: 2 });
  s._activeClientMessageId = "m-next";
  resolve(snapshot()); await flush();
  expect(s._activeClientMessageId).toBe("m-next");
  expect(s.messages.some((row) => row.id.startsWith("sys-state-readback"))).toBe(false);
  sock.stop();
});

test.each(["stop", "lifecycle", "new intent"])("%s before the evaluator loads never starts a stale read", async (fence) => {
  const read = vi.fn(async () => snapshot());
  const { sock, ws, s } = boot({ readSessionSnapshot: read });
  ws.push(error("conflict"));
  if (fence === "stop") s._stopSettlement = { clientMessageId: cmid, phase: "awaiting_receipt" };
  else if (fence === "lifecycle") sock.stop();
  else s._activeClientMessageId = "m-next";
  await flush();
  expect(read).not.toHaveBeenCalled();
  expect(s.messages.some((row) => row.id.startsWith("sys-state-readback"))).toBe(false);
  expect(s.messages.some((row) => row._errorCode === "conflict")).toBe(false);
  sock.stop();
});

test.each(["stop", "lifecycle"])("%s while reading never paints a late success record", async (fence) => {
  let resolve!: (snap: SessionSnapshot) => void;
  const { sock, ws, s } = boot({ readSessionSnapshot: () => new Promise((r) => { resolve = r; }) });
  ws.push(error("conflict")); await flush();
  if (fence === "stop") s._stopSettlement = { clientMessageId: cmid, phase: "awaiting_receipt" };
  else sock.stop();
  resolve(snapshot()); await flush();
  expect(s.messages.some((row) => row.id.startsWith("sys-state-readback"))).toBe(false);
  expect(s.messages.some((row) => row._errorCode === "conflict")).toBe(false);
  sock.stop();
});

test("timeline cursor recovery reads the same snapshot before explicit history reconciliation", async () => {
  const order: string[] = [];
  const { sock } = boot({ readSessionSnapshot: async () => { order.push("snapshot"); return snapshot(); },
    syncSession: async () => { order.push("history"); return true; } });
  expect(await sock.syncHistoryNow("s1")).toBe(true);
  expect(order).toEqual(["snapshot", "history"]);
  sock.stop();
});

test.each([null, undefined])("timeline snapshot %s remains a visible failure without reading history", async (snap) => {
  const sync = vi.fn(async () => true);
  const { sock } = boot({ readSessionSnapshot: async () => snap, syncSession: sync });
  expect(await sock.syncHistoryNow("s1")).toBe(false);
  expect(sync).not.toHaveBeenCalled();
  sock.stop();
});

test("timeline history synchronization failure is never reported as recovered", async () => {
  const sync = vi.fn(async () => false);
  const { sock } = boot({ readSessionSnapshot: async () => snapshot(), syncSession: sync });
  expect(await sock.syncHistoryNow("s1")).toBe(false);
  expect(sync).toHaveBeenCalledTimes(1);
  sock.stop();
});

test.each(["session_persist_unavailable", "history_enrichment_unavailable", "turn_tape_state_error",
  "turn_tape_state_unavailable", "turn_tape_unavailable", "turn_tape_visible_unavailable", "tape_not_acked", "turn_tape_retryable"])(
  "%s with exact completed durable authority produces only the quiet record", async (code) => {
    const complete = snapshot();
    complete.dispatch = { ...complete.dispatch!, status: "terminal", outcome: "completed", terminalAt: 3 };
    complete.reconcile = "turn_completed";
    const { sock, ws, s } = boot({ readSessionSnapshot: async () => complete, syncSession: async () => true });
    ws.push(error(code)); await flush();
    expect(s.messages.some((row) => row._errorCode === code)).toBe(false);
    expect(s.messages.filter((row) => row.id.startsWith("sys-state-readback"))).toHaveLength(1);
    expect(s._sendingInFlight).toBe(false);
    sock.stop();
  });

test("same-state duplicate while reading shares one request; a foreign snapshot never clears the error", async () => {
  let resolve!: (snap: SessionSnapshot) => void;
  const read = vi.fn(() => new Promise<SessionSnapshot>((r) => { resolve = r; }));
  const { sock, ws, s } = boot({ readSessionSnapshot: read });
  ws.push(error("bad_sequence")); ws.push(error("bad_sequence")); await flush();
  expect(read).toHaveBeenCalledTimes(1);
  resolve(snapshot({ sessionId: "s-foreign" })); await flush();
  expect(s.messages.some((row) => row.id.startsWith("sys-state-readback"))).toBe(false);
  expect(s.messages.some((row) => row._errorCode === "bad_sequence")).toBe(true);
  sock.stop();
});

test.each([false, true])("structured error plus adjacent compatibility final retains the held error (read success=%s)", async (success) => {
  let resolve!: (snap: SessionSnapshot | undefined) => void;
  const read = vi.fn(() => new Promise<SessionSnapshot | undefined>((r) => { resolve = r; }));
  const { sock, ws, s } = boot({ readSessionSnapshot: read });
  const sessionKey = "agent:main:webchat:dm:s1";
  ws.push(error("session_persist_unavailable", { type: "outbound.error", frameSeq: 1, sessionKey }));
  ws.push({ type: "outbound.message", peer: { id: "s1", kind: "dm" }, sessionKey,
    clientMessageId: cmid, frameSeq: 2, blocks: [{ kind: "text", text: "[error] could not persist" }], isFinal: true });
  await flush();
  expect(s._sendingInFlight).toBe(true);
  resolve(success ? snapshot() : undefined); await flush();
  // accepted alone cannot prove a persist failure was repaired.
  expect(s.messages.some((row) => row._errorCode === "session_persist_unavailable")).toBe(true);
  expect(s.messages.some((row) => row.text.includes("[error]"))).toBe(false);
  expect(s._sendingInFlight).toBe(false);
  expect(read).toHaveBeenCalledTimes(1);
  sock.stop();
});

test("queued user intent does not swallow the current error; asynchronous replay notifies subscribers", async () => {
  let resolve!: (snap: undefined) => void;
  const { sock, ws, s } = boot({ readSessionSnapshot: () => new Promise<undefined>((r) => { resolve = r; }) });
  s.messages.push({ id: "m-queued", role: "user", text: "稍后处理", ts: 2, status: "queued" });
  const changed = vi.fn(); sock.subscribe(changed);
  ws.push(error("bad_sequence")); await flush();
  await vi.advanceTimersByTimeAsync(100);
  changed.mockClear();
  resolve(undefined); await flush();
  await vi.advanceTimersByTimeAsync(100);
  expect(s.messages.some((row) => row._errorCode === "bad_sequence")).toBe(true);
  expect(s._sendingInFlight).toBe(false);
  expect(changed).toHaveBeenCalled();
  sock.stop();
});

test("a late adjacent compatibility final cannot end a dispatch the snapshot proved still running", async () => {
  const { sock, ws, s } = boot({ readSessionSnapshot: async () => snapshot({ lastFrameSeq: 2 }) });
  const sessionKey = "agent:main:webchat:dm:s1";
  ws.push(error("bad_sequence", { type: "outbound.error", frameSeq: 1, sessionKey }));
  await flush();
  ws.push({ type: "outbound.message", peer: { id: "s1", kind: "dm" }, sessionKey,
    clientMessageId: cmid, frameSeq: 2, blocks: [{ kind: "text", text: "[error] old sequence" }], isFinal: true });
  await flush();
  expect(s._sendingInFlight).toBe(true);
  expect(s.messages.some((row) => row._errorCode)).toBe(false);
  sock.stop();
});

test("an old sequenced error never bypasses the original cursor gate through asynchronous replay", async () => {
  const read = vi.fn(async () => undefined);
  const { sock, ws, s } = boot({ readSessionSnapshot: read });
  const sessionKey = "agent:main:webchat:dm:s1";
  s._lastFrameSeq = 10; s._lastFrameSeqByKey = { [sessionKey]: 10 };
  ws.push(error("bad_sequence", { type: "outbound.error", frameSeq: 1, sessionKey }));
  await flush();
  expect(read).not.toHaveBeenCalled();
  expect(s._lastFrameSeqByKey[sessionKey]).toBe(10);
  expect(s._sendingInFlight).toBe(true);
  expect(s.messages.some((row) => row._errorCode)).toBe(false);
  sock.stop();
});

test("two newer errors share the read but each adjacent compatibility final stays fenced", async () => {
  let resolve!: (snap: SessionSnapshot) => void;
  const read = vi.fn(() => new Promise<SessionSnapshot>((r) => { resolve = r; }));
  const { sock, ws, s } = boot({ readSessionSnapshot: read });
  const sessionKey = "agent:main:webchat:dm:s1";
  const final = (frameSeq: number) => ({ type: "outbound.message", peer: { id: "s1", kind: "dm" },
    sessionKey, clientMessageId: cmid, frameSeq, blocks: [{ kind: "text", text: "[error] old sequence" }], isFinal: true });
  ws.push(error("bad_sequence", { type: "outbound.error", frameSeq: 1, sessionKey })); ws.push(final(2));
  ws.push(error("bad_sequence", { type: "outbound.error", frameSeq: 3, sessionKey })); ws.push(final(4));
  await flush();
  expect(read).toHaveBeenCalledTimes(1);
  expect(s._sendingInFlight).toBe(true);
  resolve(snapshot({ lastFrameSeq: 4 })); await flush();
  expect(s._sendingInFlight).toBe(true);
  expect(s.messages.some((row) => row._errorCode || row.text.includes("[error]"))).toBe(false);
  sock.stop();
});
