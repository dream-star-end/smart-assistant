import { describe, expect, test, vi } from "vitest";
import { activeBackgroundDelegateJobIds, backgroundDelegateReceiptIds, backgroundStopControl, projectBackgroundDelegateRows, visibleBackgroundDelegateItems } from "./backgroundDelegates";
import { applyOutboundMessage, applyPermissionSettled } from "./reducer";
import { createSession, type ChatMessage } from "./model";
import { mergeFullServerWins } from "../persist";
import { ChatSocket } from "./socket";
import type { InflightDelegateItem } from "./inflightDelegates";

const row = (patch: Partial<ChatMessage>): ChatMessage => ({ id: "bg-result", role: "agent-group", text: "校验", ts: 1,
  _backgroundDelegate: true, _completed: true, _resultPreview: "后台完整结果", ...patch });
const prompt = (patch: Partial<ChatMessage> = {}): ChatMessage => row({ id: "ask-user:question", role: "permission", text: "选择", _backgroundDelegate: undefined,
  requestId: "ask-user:question", toolName: "AskUserQuestion", _resolved: false, _askUserExpiresAt: Date.now() + 60_000, ...patch });
const item = (patch: Partial<InflightDelegateItem> = {}): InflightDelegateItem => ({ jobId: "dlgjob-1", runId: "dlg-1", agentId: "coding-assistant", goal: "校验",
  state: "running", background: true, liveHint: "", updatedAt: 1, parentSessionKey: "agent:main:webchat:dm:s1", ...patch });

describe("background confirmation presentation", () => {
  test.each([false, true])("result remains durable while an unresolved answer has controlPending=%s", (pending) => {
    const rows = [prompt({ _controlPending: pending }), row({})];
    const before = structuredClone(rows);
    expect(projectBackgroundDelegateRows(rows)).toEqual([rows[0]]);
    expect(rows).toEqual(before);
    const reload = mergeFullServerWins(structuredClone(rows), []);
    expect(reload).toHaveLength(2);
    expect(projectBackgroundDelegateRows(reload).map((message) => message.id)).toEqual([rows[0].id]);
    const sess = createSession({ id: "s1", agentId: "main" });
    sess.messages = reload;
    applyPermissionSettled(sess, { type: "outbound.permission_settled", requestId: rows[0].requestId!, behavior: "allow",
      sessionKey: "agent:main:webchat:dm:s1", channel: "webchat", peer: { id: "s1", kind: "dm" } });
    expect(projectBackgroundDelegateRows(sess.messages)).toBe(sess.messages);
    expect(sess.messages.filter((message) => message.id === "bg-result")).toHaveLength(1);
  });
  test("legacy results remain visible and no pending prompt preserves the original view", () => {
    const rows = [prompt(), row({ _backgroundDelegate: undefined })];
    expect(projectBackgroundDelegateRows(rows)).toBe(rows);
    const settled = [prompt({ _resolved: true }), row({})];
    expect(projectBackgroundDelegateRows(settled)).toBe(settled);
  });
  test("expired detached prompts release results; pending HUD results wait too", () => {
    const rows = [prompt({ _askUserExpiresAt: 1 }), row({})];
    expect(projectBackgroundDelegateRows(rows, 2)).toBe(rows);
    expect(visibleBackgroundDelegateItems([item({ state: "completed" }), item({ jobId: "dlgjob-2" })], [prompt()])).toEqual([item({ jobId: "dlgjob-2" })]);
  });
});

test("only explicit background receipts expose exact jobs, including mixed fanout wrappers", () => {
  const handle = { status: "queued", resultDelivery: "background", jobId: "dlgjob-queued" };
  const output = `已派发\n${JSON.stringify(handle)}`;
  expect(backgroundDelegateReceiptIds(JSON.stringify({ result: [{ type: "text", text: output }] }))).toEqual([handle.jobId]);
  expect(backgroundDelegateReceiptIds(JSON.stringify({ status: "running", jobId: "legacy" }))).toEqual([]);
  expect(activeBackgroundDelegateJobIds([item()], [row({ id: "tool", role: "tool", _backgroundDelegate: undefined, output })])).toEqual(["dlgjob-1", handle.jobId]);
  expect(activeBackgroundDelegateJobIds([item({ state: "completed" })], [row({ _delegateJobId: "dlgjob-1", _completed: false })])).toEqual([]);
});

test("old background progress updates its child while a new turn waits for confirmation", () => {
  const sess = createSession({ id: "s1", agentId: "main" });
  sess._sendingInFlight = true; sess._activeClientMessageId = "u-new";
  sess.messages = [row({ id: "u-old", role: "user", text: "原任务", _backgroundDelegate: undefined }),
    row({ id: "u-new", role: "user", text: "新消息", _backgroundDelegate: undefined }), prompt()];
  sess._turnStatus = "waiting_for_user";
  const before = { active: sess._activeClientMessageId, sending: sess._sendingInFlight, status: sess._turnStatus, assistant: sess._streamingAssistant };
  const onLiveFrame = vi.fn();
  const forceSync = vi.fn();
  applyOutboundMessage(sess, { type: "outbound.message", channel: "webchat", peer: { id: "s1", kind: "dm" },
    sessionKey: "agent:main:webchat:dm:s1", clientMessageId: "u-old", frameSeq: 1, isFinal: false,
    blocks: [{ kind: "delegate_progress", runId: "dlg-old", jobId: "dlgjob-old", agentId: "coding-assistant", phase: "done", background: true, text: "完整结果" }] },
    { onLiveFrame, forceSync });
  const result = sess.messages.find((message) => message._delegateRunId === "dlg-old")!;
  expect(result).toMatchObject({ _backgroundDelegate: true, _completed: true, _turnOwnerId: "u-old" });
  expect({ active: sess._activeClientMessageId, sending: sess._sendingInFlight, status: sess._turnStatus, assistant: sess._streamingAssistant }).toEqual(before);
  expect(onLiveFrame).not.toHaveBeenCalled(); expect(forceSync).not.toHaveBeenCalled();
  expect(projectBackgroundDelegateRows(sess.messages)).not.toContain(result);
});

test("background-only Stop persists before sending and its receipt cannot settle a newer parent", async () => {
  let commit!: () => void;
  const persistPendingControl = vi.fn(() => new Promise<void>((resolve) => { commit = resolve; }));
  const deletePendingControl = vi.fn(async () => {});
  const socket = new ChatSocket({ getToken: () => "tok", getAuthEpoch: () => 0,
    silentRefresh: async (epoch) => ({ kind: "transient", epoch, retryAfterMs: 500 }), onAuthExpired() {},
    defaultAgentId: "main", persistPendingControl, deletePendingControl });
  const sent: string[] = [];
  const internals = socket as unknown as { ws: { readyState: number; bufferedAmount: number; send(value: string): void }; relayReady: boolean;
    applyControlReceipt(frame: unknown): void };
  internals.ws = { readyState: 1, bufferedAmount: 0, send: (value) => { sent.push(value); } };
  internals.relayReady = true;
  const sess = socket.ensureSession("s1", "main");
  socket.stopBackgroundJobs("s1", ["dlgjob-b", "dlgjob-a"]);
  expect(persistPendingControl).toHaveBeenCalledTimes(1); expect(sent).toEqual([]);
  expect(sess._sendingInFlight).not.toBe(true); expect(sess._stopSettlement).toBeUndefined();
  commit(); await Promise.resolve(); await Promise.resolve();
  const stop = JSON.parse(sent[0]!);
  expect(stop.backgroundJobIds).toEqual(["dlgjob-a", "dlgjob-b"]); expect(stop.clientMessageId).toBeUndefined();
  sess._sendingInFlight = true; sess._activeClientMessageId = "u-new";
  internals.applyControlReceipt({ type: "outbound.control.receipt", controlId: stop.controlId, controlKind: "stop", status: "applied", peer: { id: "s1", kind: "dm" } });
  expect(deletePendingControl).toHaveBeenCalled(); expect(sess._sendingInFlight).toBe(true);
  expect(sess._activeClientMessageId).toBe("u-new"); expect(sess._stopSettlement).toBeUndefined();
});

test("reloaded background Stop replays exact IDs without restoring parent busy state", () => {
  const control = backgroundStopControl("s1", "main", ["dlgjob-old"])!;
  const socket = new ChatSocket({ getToken: () => "tok", getAuthEpoch: () => 0,
    silentRefresh: async (epoch) => ({ kind: "transient", epoch, retryAfterMs: 500 }), onAuthExpired() {}, defaultAgentId: "main" });
  socket.loadStored({ id: "s1", agentId: "main", title: "任务", messages: [], createdAt: 1, lastAt: 1, _pendingControls: [control] });
  const sess = socket.sessions.get("s1")!;
  expect(sess._sendingInFlight).not.toBe(true); expect(sess._stopSettlement).toBeUndefined();
  expect((socket as unknown as { controlQueue: { payload: unknown }[] }).controlQueue[0]?.payload).toMatchObject({ backgroundJobIds: ["dlgjob-old"] });
});

test("a dismissed/evicted terminal HUD cannot revive Stop from its old running receipt after reload", () => {
  const output = JSON.stringify({ status: "running", resultDelivery: "background", jobId: "dlgjob-1" });
  const receipt = row({ id: "old-tool", role: "tool", _backgroundDelegate: undefined, output });
  // The complete control snapshot still contains a terminal hidden by dismissal.
  expect(activeBackgroundDelegateJobIds([item({ state: "completed" })], [receipt])).toEqual([]);
  // After refresh/retention eviction, durable group identity disproves that receipt too.
  const reloaded = mergeFullServerWins([receipt, row({ _source: "server", _delegateRunId: "dlg-1", _delegateJobId: "dlgjob-1" })], []);
  expect(activeBackgroundDelegateJobIds([], reloaded)).toEqual([]);
  const deferred = row({ _source: "server", _completed: undefined, _payloadDeferred: true, _delegateJobId: "dlgjob-1" });
  expect(activeBackgroundDelegateJobIds([], [receipt, deferred])).toEqual([]);
  // Until authoritative cleanup completes, keep the exact running job stoppable.
  expect(activeBackgroundDelegateJobIds([item()], reloaded)).toEqual(["dlgjob-1"]);
});
