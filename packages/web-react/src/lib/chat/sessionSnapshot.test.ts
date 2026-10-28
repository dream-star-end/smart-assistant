/**
 * 唯一恢复入口：权威快照 + afterSeq 增量（FE-recovery，GOAL W1）。
 * WS hello 的 outbound.session_snapshot 与 HTTP live-frames 的 snapshot 走同一个应用入口；
 * 覆盖快照对齐、续页 / 超大帧 / cursor_reset / tape、B3 的 8s HTTP 兜底、新设备、
 * 「待发送 1」不闪、恢复宽限到点按快照收口（OD1）。
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import type { SessionSnapshot } from "./sessionSnapshot";
import { snapshotQuery, SNAPSHOT_ACK_TIMEOUT_MS } from "./sessionSnapshot";
import { isTurnDetached, type ChatMessage } from "./model";
import { ChatSocket, RECOVERY_ADOPTION_GRACE_MS, RECOVERY_DECISION_GRACE_MS, type ChatSocketDeps } from "./socket";

class FakeWS {
  static instances: FakeWS[] = [];
  static OPEN = 1;
  readyState = 0;
  bufferedAmount = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeWS.instances.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close(code = 1000, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
    this.onmessage?.({ data: JSON.stringify({ type: "sys.relay_ready", automaticRecoveryOwner: "master-v1" }) });
  }
  push(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

const SK = "agent:main:webchat:dm:s1";
const CMID = "m-run-1";
const STREAM = "dispatch:11111111-1111-1111-1111-111111111111:1";
const peer = { id: "s1", kind: "dm" as const };

function makeSocket(overrides: Partial<ChatSocketDeps> = {}) {
  return new ChatSocket({
    getToken: () => "tok",
    getAuthEpoch: () => 0,
    silentRefresh: async (epoch) => ({ kind: "transient", epoch, retryAfterMs: 500 }),
    onAuthExpired: () => {},
    defaultAgentId: "main",
    ...overrides,
  });
}

function dispatchRow(over: Partial<NonNullable<SessionSnapshot["dispatch"]>> = {}): NonNullable<SessionSnapshot["dispatch"]> {
  return {
    id: "11111111-1111-1111-1111-111111111111", clientMessageId: CMID, agentId: "main", status: "accepted",
    outcome: null, attempt: 1, since: 500, acceptedAt: 600, terminalAt: null, ...over,
  };
}

function snapshot(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    v: 1, sessionId: "s1", dispatch: null, streamKey: null, lastFrameSeq: null, lastFrameAt: null,
    engineReady: null, turnStatus: null, reconcile: null,
    pendingPermissions: { items: [], completeness: "complete" }, usage: null, credits: null,
    frames: [], nextAfterSeq: 0, hasMore: false, gap: null, asOf: 1_000, ...over,
  };
}

function textFrame(frameSeq: number, text: string, clientMessageId = CMID) {
  return {
    type: "outbound.message", sessionKey: SK, channel: "webchat", peer, clientMessageId,
    blocks: [{ kind: "text", text }], isFinal: false, frameSeq, ts: 10_000 + frameSeq,
  };
}

function record(frameSeq: number, text: string) {
  return { recordId: String(frameSeq), frameSeq, payload: textFrame(frameSeq, text) };
}

function detachedStatus(status: string | null = null) {
  return {
    type: "outbound.turn_status", sessionKey: SK, channel: "webchat", peer, clientMessageId: CMID,
    status, meta: { detached: true, since: 500 },
  };
}

function openSnapshot(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return snapshot({ dispatch: dispatchRow(), streamKey: STREAM, lastFrameSeq: 2, turnStatus: detachedStatus(), ...over });
}

function pushSnapshot(ws: FakeWS, snap: SessionSnapshot) {
  ws.push({ type: "outbound.session_snapshot", channel: "webchat", peer: { id: snap.sessionId, kind: "dm" }, snapshot: snap });
}

async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

function hellos(ws: FakeWS) {
  return ws.sent.filter((raw) => raw.includes('"inbound.hello"')).map((raw) => JSON.parse(raw) as {
    peers: Array<Record<string, unknown>>;
  });
}

function assistantText(messages: ChatMessage[], cmid = CMID) {
  return messages.filter((m) => m.role === "assistant" && (m._clientMessageId === cmid || m._turnOwnerId === cmid))
    .map((m) => m.text).join("");
}

function boot(deps: Partial<ChatSocketDeps> = {}, open = true) {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
  const sock = makeSocket(deps);
  sock.ensureSession("s1", "main");
  sock.setActiveSession("s1");
  sock.setGateReady(true);
  const ws = FakeWS.instances.at(-1)!;
  if (open) ws.open();
  return { sock, ws, s: sock.sessions.get("s1")! };
}

afterEach(() => {
  FakeWS.instances = [];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("hello = 订阅；快照对齐状态", () => {
  test("hello carries no exact-turn replay hints; a snapshot claims the open dispatch and aligns state", async () => {
    const { sock, ws, s } = boot();
    const [hello] = hellos(ws);
    expect(hello!.peers[0]).toEqual({ peerId: "s1", agentId: "main", inFlight: false, lastFrameSeq: 0 });

    pushSnapshot(ws, openSnapshot({
      frames: [record(1, "hello"), record(2, " world")], nextAfterSeq: 2,
      credits: { settled: "1520", requests: 3, asOf: 900 },
      usage: { frameSeq: 2, usage: { inputTokens: 7 } as never },
    }));
    await flush();

    expect(s._sendingInFlight).toBe(true);
    expect(s._activeClientMessageId).toBe(CMID);
    expect(s._turnStartedAt).toBe(500);
    expect(isTurnDetached(s)).toBe(true);
    expect(s._turnCredits).toMatchObject({ clientMessageId: CMID, settled: "1520", requests: 3, asOf: 900 });
    expect(s._liveTurnUsage).toMatchObject({ clientMessageId: CMID, usage: { inputTokens: 7 } });
    expect(assistantText(s.messages)).toBe("hello world");
    expect(s._snapshotStream).toEqual({ streamKey: STREAM, agentId: "main" });
    expect(sock.toStored("s1")?._snapshotStream).toEqual({ streamKey: STREAM, agentId: "main" });

    // Reconnect: the hello reports the stream and the cursor of the same sessionKey.
    ws.close(1006, "");
    await vi.advanceTimersByTimeAsync(60_000);
    const next = FakeWS.instances.at(-1)!;
    next.open();
    expect(hellos(next)[0]!.peers[0]).toEqual({
      peerId: "s1", agentId: "main", inFlight: true, lastFrameSeq: 2,
      inFlightClientMessageId: CMID, lastStreamKey: STREAM,
    });
    sock.stop();
  });

  test("terminal dispatch of the local in-flight turn settles it through the reconcile final", async () => {
    const syncSession = vi.fn(async () => true);
    const { sock, ws, s } = boot({ syncSession });
    pushSnapshot(ws, openSnapshot());
    await flush();
    expect(s._sendingInFlight).toBe(true);

    pushSnapshot(ws, openSnapshot({
      dispatch: dispatchRow({ status: "terminal", outcome: "completed", terminalAt: 2_000 }),
      reconcile: "turn_completed", turnStatus: null,
    }));
    await flush();
    expect(s._sendingInFlight).toBe(false);
    expect(syncSession).toHaveBeenCalledWith("s1", expect.objectContaining({ clientMessageId: CMID }));
    sock.stop();
  });

  test("not_accepted / executed_error terminal reads history for the fail-visible card", async () => {
    const syncSession = vi.fn(async () => true);
    const { sock, ws } = boot({ syncSession });
    pushSnapshot(ws, openSnapshot());
    await flush();
    syncSession.mockClear();
    pushSnapshot(ws, openSnapshot({ dispatch: dispatchRow({ status: "terminal", outcome: "not_accepted" }), turnStatus: null }));
    await flush();
    expect(syncSession).toHaveBeenCalledWith("s1", { clientMessageId: CMID });
    sock.stop();
  });

  test("a late open snapshot never resurrects a turn this tab already finished", async () => {
    const { sock, ws, s } = boot();
    s.messages.push({ id: CMID, role: "user", text: "q", ts: 1, status: "replied" } as ChatMessage);
    pushSnapshot(ws, openSnapshot());
    await flush();
    expect(s._sendingInFlight).toBeFalsy();
    sock.stop();
  });

  test("snapshot permissions materialize pending prompts; an incomplete page reads history", async () => {
    const syncSession = vi.fn(async () => true);
    const { sock, ws, s } = boot({ syncSession });
    pushSnapshot(ws, snapshot({
      pendingPermissions: {
        items: [{
          type: "outbound.permission_request", sessionKey: SK, channel: "webchat", peer,
          requestId: "perm-1", toolName: "Bash", inputPreview: "{}", ts: 1,
        }],
        completeness: "truncated",
      },
    }));
    await flush();
    expect(s.messages.some((m) => m.role === "permission" && m.requestId === "perm-1")).toBe(true);
    expect(syncSession).toHaveBeenCalledWith("s1", undefined);
    sock.stop();
  });
});

describe("afterSeq 续页与缺口", () => {
  test("hasMore pages over HTTP from nextAfterSeq on the same stream", async () => {
    const readSessionSnapshot = vi.fn(async () => openSnapshot({ frames: [record(2, " world")], nextAfterSeq: 2 }));
    const { sock, ws, s } = boot({ readSessionSnapshot });
    pushSnapshot(ws, openSnapshot({ frames: [record(1, "hello")], nextAfterSeq: 1, hasMore: true, gap: { reason: "page_limit" } }));
    await flush();
    expect(readSessionSnapshot).toHaveBeenCalledWith("s1", { afterSeq: 1, streamKey: STREAM, limit: 500, dispatch: CMID });
    expect(assistantText(s.messages)).toBe("hello world");
    sock.stop();
  });

  test("byte_limit reads the exact oversized frame, then continues after it", async () => {
    const readLiveFramePayload = vi.fn(async () => ({ payload: textFrame(2, " big") }));
    const readSessionSnapshot = vi.fn(async () => openSnapshot({ frames: [record(3, " tail")], nextAfterSeq: 3 }));
    const { sock, ws, s } = boot({ readLiveFramePayload, readSessionSnapshot });
    pushSnapshot(ws, openSnapshot({
      frames: [record(1, "hello")], nextAfterSeq: 1, hasMore: true,
      gap: { reason: "byte_limit", recordId: "2", sha256: "abc", frameSeq: 2 },
    }));
    await flush();
    expect(readLiveFramePayload).toHaveBeenCalledWith("s1", { recordId: "2", sha256: "abc" });
    expect(readSessionSnapshot).toHaveBeenCalledWith("s1", expect.objectContaining({ afterSeq: 2, streamKey: STREAM }));
    expect(assistantText(s.messages)).toBe("hello big tail");
    sock.stop();
  });

  test("cursor_reset rebuilds the turn from the stream instead of trusting a stale cursor", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.loadStored({
      id: "s1", agentId: "main", title: "", createdAt: 1, lastAt: 1,
      messages: [
        { id: CMID, role: "user", text: "q", ts: 1, status: "sent" },
        { id: "m-local", role: "assistant", text: "stale partial", ts: 2, _clientMessageId: CMID } as ChatMessage,
      ],
      _lastFrameSeqByKey: { [SK]: 50 },
      _sendingInFlight: true,
      _activeClientMessageId: CMID,
    });
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    pushSnapshot(ws, openSnapshot({ frames: [record(1, "fresh")], nextAfterSeq: 1, gap: { reason: "cursor_reset" }, lastFrameSeq: 1 }));
    await flush();
    const s = sock.sessions.get("s1")!;
    expect(assistantText(s.messages)).toBe("fresh");
    expect(s._lastFrameSeqByKey?.[SK]).toBe(1);
    sock.stop();
  });

  test("a tape gap hands the content to the history read", async () => {
    const syncSession = vi.fn(async () => true);
    const { sock, ws } = boot({ syncSession });
    pushSnapshot(ws, snapshot({
      dispatch: dispatchRow({ status: "terminal", outcome: "completed" }), streamKey: STREAM, gap: { reason: "tape" },
    }));
    await flush();
    expect(syncSession).toHaveBeenCalledWith("s1", { clientMessageId: CMID });
    sock.stop();
  });
});

describe("B3：hello 没完成时 8s 内走 HTTP 快照", () => {
  test("WS stuck connecting: visible → 8s → HTTP snapshot for the selected and every in-flight session", async () => {
    let resolve!: (snap: SessionSnapshot) => void;
    const readSessionSnapshot = vi.fn((sessId: string) => sessId === "s1"
      ? new Promise<SessionSnapshot>((r) => { resolve = r; })
      : Promise.resolve(snapshot({ sessionId: sessId })));
    const { sock, s } = boot({ readSessionSnapshot }, false);
    const other = sock.ensureSession("s2", "main");
    other._sendingInFlight = true;
    other._activeClientMessageId = "m-run-2";
    sock.notifyTabVisible();
    await vi.advanceTimersByTimeAsync(SNAPSHOT_ACK_TIMEOUT_MS - 1);
    await flush();
    expect(readSessionSnapshot).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(readSessionSnapshot).toHaveBeenCalledWith("s1", snapshotQuery(s, "main"));
    expect(readSessionSnapshot).toHaveBeenCalledWith("s2", { afterSeq: 0, dispatch: "m-run-2" });
    resolve(openSnapshot({ frames: [record(1, "seen over http")], nextAfterSeq: 1 }));
    await flush();
    expect(s._sendingInFlight).toBe(true);
    expect(s._turnStartedAt).toBe(500);
    expect(isTurnDetached(s)).toBe(true);
    expect(assistantText(s.messages)).toBe("seen over http");
    sock.stop();
  });

  test("a snapshot or stamped frame within 8s is the ack: no HTTP fallback", async () => {
    const readSessionSnapshot = vi.fn(async () => snapshot());
    const { sock, ws } = boot({ readSessionSnapshot });
    sock.notifyTabVisible();
    await vi.advanceTimersByTimeAsync(3_000);
    ws.push(textFrame(1, "live"));
    await vi.advanceTimersByTimeAsync(SNAPSHOT_ACK_TIMEOUT_MS);
    expect(readSessionSnapshot).not.toHaveBeenCalled();
    sock.stop();
  });

  test("online arms the same fallback; a failed read retries once after 8s; one request per session", async () => {
    const readSessionSnapshot = vi.fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockReturnValue(new Promise(() => {}));
    const { sock } = boot({ readSessionSnapshot }, false);
    sock.notifyNetworkOnline();
    await vi.advanceTimersByTimeAsync(SNAPSHOT_ACK_TIMEOUT_MS);
    await flush();
    expect(readSessionSnapshot).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SNAPSHOT_ACK_TIMEOUT_MS);
    await flush();
    expect(readSessionSnapshot).toHaveBeenCalledTimes(2);
    sock.notifyTabVisible();
    await vi.advanceTimersByTimeAsync(SNAPSHOT_ACK_TIMEOUT_MS * 3);
    await flush();
    expect(readSessionSnapshot).toHaveBeenCalledTimes(2);
    sock.stop();
  });

  test("an HTTP answer older than live WS evidence merges frames but not its state head", async () => {
    let resolve!: (snap: SessionSnapshot) => void;
    const readSessionSnapshot = vi.fn(() => new Promise<SessionSnapshot>((r) => { resolve = r; }));
    const { sock, ws, s } = boot({ readSessionSnapshot });
    pushSnapshot(ws, openSnapshot({ turnStatus: detachedStatus(null) }));
    await flush();
    await vi.advanceTimersByTimeAsync(10);
    sock.notifyTabVisible();
    await vi.advanceTimersByTimeAsync(SNAPSHOT_ACK_TIMEOUT_MS);
    await flush();
    expect(readSessionSnapshot).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10);
    ws.push({ type: "outbound.turn_status", sessionKey: SK, channel: "webchat", peer, clientMessageId: CMID, status: "compacting", frameSeq: 3 });
    // Watermark above the local cursor: only R2 (newer live evidence) can reject this head.
    resolve(openSnapshot({ turnStatus: detachedStatus("engine_starting"), lastFrameSeq: 5 }));
    await flush();
    expect(s._turnStatus).toBe("compacting");
    sock.stop();
  });
});

describe("新设备首次打开会话", () => {
  test("a session loaded after the hello subscribes once and is aligned by its snapshot", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    ws.sent.length = 0;
    sock.applyServerMessages("s1", "main", [
      { id: CMID, role: "user", text: "q", ts: 1, status: "sent", _source: "server" } as ChatMessage,
    ], true);
    sock.applyServerMessages("s1", "main", [], true);
    expect(hellos(ws).map((h) => h.peers)).toEqual([[{ peerId: "s1", agentId: "main", inFlight: false, lastFrameSeq: 0 }]]);
    pushSnapshot(ws, openSnapshot());
    await flush();
    const s = sock.sessions.get("s1")!;
    expect(s._sendingInFlight).toBe(true);
    expect(isTurnDetached(s)).toBe(true);
    sock.stop();
  });

  test("the live-frames page read on open carries the same snapshot head", async () => {
    const sock = makeSocket();
    sock.applyServerMessages("s1", "main", [
      { id: CMID, role: "user", text: "q", ts: 1, status: "sent", _source: "server" } as ChatMessage,
    ], true, undefined, { openDispatch: { dispatchId: "d", clientMessageId: CMID, status: "accepted" } });
    await sock.hydrateDurableLiveFrameJournal("s1", async () => ({
      frames: [], nextCursor: null, hasMore: false, streamClientMessageIds: [CMID], hasTapeProjection: false,
      snapshot: openSnapshot({ credits: { settled: "8", requests: 1, asOf: 9 } }),
    }), async () => {});
    const s = sock.sessions.get("s1")!;
    expect(s._turnStartedAt).toBe(500);
    expect(isTurnDetached(s)).toBe(true);
    expect(s._turnCredits?.settled).toBe("8");
    sock.stop();
  });
});

describe("「待发送 1」不闪", () => {
  test("an idle send is never 待发送 while its journal write is in flight", async () => {
    let commit: () => void = () => {};
    const { sock, s } = boot({ persistPendingDispatch: () => new Promise<void>((r) => { commit = r; }) });
    await sock.sendMessage({ sessId: "s1", agentId: "main", text: "你好" });
    const user = s.messages.find((m) => m.role === "user")!;
    expect(user.status).toBe("sending");
    commit();
    await flush();
    expect(user.status).toBe("sending");
    sock.stop();
  });

  test("a send with a model is never 待发送 while the queued cost authorization is in flight", async () => {
    let calls = 0;
    const { sock, s } = boot({
      authorizeSwitch: (input) => {
        calls += 1;
        if (calls === 1) return Promise.resolve({ requestId: input.requestId ?? "r", choice: true });
        return new Promise(() => {});
      },
    });
    await sock.sendMessage({ sessId: "s1", agentId: "main", text: "你好", model: "gpt-6.1-sol" });
    expect(s.messages.find((m) => m.role === "user")!.status).toBe("sending");
    sock.stop();
  });

  test("cost authorization unavailable puts it back to 待发送", async () => {
    let calls = 0;
    const { sock, s } = boot({
      authorizeSwitch: (input) => {
        calls += 1;
        if (calls === 1) return Promise.resolve({ requestId: input.requestId ?? "r", choice: true });
        return Promise.reject(new Error("offline"));
      },
    });
    await sock.sendMessage({ sessId: "s1", agentId: "main", text: "你好", model: "gpt-6.1-sol" });
    await flush();
    expect(s.messages.find((m) => m.role === "user")!.status).toBe("queued");
    sock.stop();
  });

  test("a sent turn whose WS drops before the admission ACK stays 发送中, not 待发送", async () => {
    const { sock, ws, s } = boot();
    await sock.sendMessage({ sessId: "s1", agentId: "main", text: "你好" });
    await flush();
    const user = s.messages.find((m) => m.role === "user")!;
    expect(ws.sent.some((raw) => raw.includes('"inbound.message"'))).toBe(true);
    ws.close(1006, "");
    expect(user.status).toBe("sending");
    expect(sock.offlineQueue[0]?.state).toBe("queued");
    sock.stop();
  });
});

describe("恢复宽限到点按快照收口（OD1）", () => {
  function deferred(deps: Partial<ChatSocketDeps>) {
    const { sock, ws, s } = boot({ syncSession: async () => true, ...deps });
    void sock.sendMessage({ sessId: "s1", agentId: "main", text: "long task", model: "kimi-k3-ark" });
    const user = s.messages.find((m) => m.role === "user")!;
    ws.push({ type: "outbound.ack", admitted: true, peer, clientMessageId: user.id });
    ws.push({
      type: "outbound.error", peer, clientMessageId: user.id, code: "model_capacity",
      message: "at capacity", frameSeq: 1, ts: Date.now(),
    });
    return { sock, ws, s, user };
  }
  const cards = (messages: ChatMessage[]) => messages.filter((m) => m.role === "assistant" && !!m._errorCode);

  test("no recovery running on the server → the card is painted, 重试中 ends", async () => {
    const readSessionSnapshot = vi.fn(async () => snapshot());
    const { sock, s } = deferred({ readSessionSnapshot });
    expect(s._sendingInFlight).toBe(true);
    expect(cards(s.messages)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(RECOVERY_DECISION_GRACE_MS);
    await flush();
    expect(readSessionSnapshot).toHaveBeenCalledWith("s1", { afterSeq: 0, limit: 1 });
    expect(cards(s.messages)).toHaveLength(1);
    expect(s._sendingInFlight).toBe(false);
    sock.stop();
  });

  test("the recovery child is open on the server → soft state is true, re-checked later", async () => {
    const readSessionSnapshot = vi.fn(async () => snapshot({ dispatch: dispatchRow({ clientMessageId: "m-recover-x" }) }));
    const { sock, ws, s } = deferred({ readSessionSnapshot });
    ws.push({ type: "sys.recovery_decision", peer, sourceClientMessageId: s._activeClientMessageId, scheduled: true, attempt: 1, max: 10 });
    await vi.advanceTimersByTimeAsync(RECOVERY_ADOPTION_GRACE_MS);
    await flush();
    expect(cards(s.messages)).toHaveLength(0);
    expect(s._sendingInFlight).toBe(true);
    readSessionSnapshot.mockResolvedValue(snapshot());
    await vi.advanceTimersByTimeAsync(RECOVERY_ADOPTION_GRACE_MS);
    await flush();
    expect(readSessionSnapshot).toHaveBeenCalledTimes(2);
    expect(cards(s.messages)).toHaveLength(1);
    expect(s._sendingInFlight).toBe(false);
    sock.stop();
  });

  test("snapshot unreadable (offline) → waits another grace instead of guessing", async () => {
    const readSessionSnapshot = vi.fn(async () => { throw new Error("offline"); });
    const { sock, s } = deferred({ readSessionSnapshot });
    await vi.advanceTimersByTimeAsync(RECOVERY_DECISION_GRACE_MS);
    await flush();
    expect(cards(s.messages)).toHaveLength(0);
    expect(s._sendingInFlight).toBe(true);
    await vi.advanceTimersByTimeAsync(RECOVERY_ADOPTION_GRACE_MS);
    await flush();
    expect(readSessionSnapshot).toHaveBeenCalledTimes(2);
    sock.stop();
  });
});

describe("snapshot recovery preserves container delivery truth", () => {
  function deliverySession(status: "sending" | "replied" = "sending") {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const sock = makeSocket();
    sock.ensureSession("s1", "main");
    const s = sock.sessions.get("s1")!;
    const user: ChatMessage = { id: CMID, role: "user", text: "q", ts: 1, status };
    s.messages.push(user);
    return { sock, s, user };
  }

  function applyDeliverySnapshot(sock: ChatSocket, snap: SessionSnapshot, via: "ws" | "http") {
    return (sock as unknown as {
      applySessionSnapshot(
        sessId: string, snapshot: SessionSnapshot, ctx: { via: "ws" | "http"; requestedAt: number },
      ): Promise<void>;
    }).applySessionSnapshot("s1", snap, { via, requestedAt: Date.now() });
  }

  test("an admitted snapshot with no acceptedAt does not claim container acceptance", async () => {
    const { sock, s, user } = deliverySession();
    try {
      await applyDeliverySnapshot(sock, openSnapshot({
        dispatch: dispatchRow({ status: "admitted", acceptedAt: null }), lastFrameSeq: null, turnStatus: null,
      }), "ws");
      expect(user._deliveryState).toBe("admitted");
      expect(s._sendingInFlight).toBe(true);
      expect(s._activeClientMessageId).toBe(CMID);
      expect(s._turnStartedAt).toBe(500);
      expect(s._turnCredits).toEqual({
        clientMessageId: CMID, settled: "0", requests: 0, asOf: 10_000, receivedAt: 10_000,
      });
    } finally {
      sock.stop();
    }
  });

  test.each(["ws", "http"] as const)("%s acceptedAt updates delivery through the same entry without clearing debits", async (via) => {
    const { sock, s, user } = deliverySession();
    try {
      user._deliveryState = "admitted";
      s._sendingInFlight = true;
      s._activeClientMessageId = CMID;
      s._turnStartedAt = 50;
      s._turnCostCredits = "71";
      s._turnCostSeenRequestIds = new Set(["already-charged"]);
      s._turnCredits = { clientMessageId: CMID, settled: "71", requests: 2, asOf: 90, receivedAt: 91 };
      await applyDeliverySnapshot(sock, openSnapshot({ lastFrameSeq: null, turnStatus: null }), via);
      expect(user._deliveryState).toBe("accepted");
      expect(s._sendingInFlight).toBe(true);
      expect(s._activeClientMessageId).toBe(CMID);
      expect(s._turnStartedAt).toBe(500);
      expect(s._turnCostCredits).toBe("71");
      expect(s._turnCostSeenRequestIds).toEqual(new Set(["already-charged"]));
      expect(s._turnCredits).toEqual({ clientMessageId: CMID, settled: "71", requests: 2, asOf: 90, receivedAt: 91 });
    } finally {
      sock.stop();
    }
  });

  test.each(["ws", "http"] as const)("%s delivery-only confirmation cannot revive a Stop settlement", async (via) => {
    const { sock, s, user } = deliverySession();
    try {
      const settlement = { clientMessageId: CMID, phase: "awaiting_receipt" as const };
      s._stopSettlement = settlement;
      s._sendingInFlight = false;
      s._activeClientMessageId = CMID;
      s._localTeardownAt = 42;
      s._turnCostCredits = "71";
      s._turnCredits = { clientMessageId: CMID, settled: "71", requests: 2, asOf: 90, receivedAt: 91 };
      await applyDeliverySnapshot(sock, openSnapshot({ lastFrameSeq: null, turnStatus: null }), via);
      expect(user._deliveryState).toBe("accepted");
      expect(s._sendingInFlight).toBe(false);
      expect(s._activeClientMessageId).toBe(CMID);
      expect(s._stopSettlement).toBe(settlement);
      expect(s._localTeardownAt).toBe(42);
      expect((sock as any).dispatchSlots.has("s1")).toBe(false);
      expect(s._turnCostCredits).toBe("71");
      expect(s._turnCredits).toEqual({ clientMessageId: CMID, settled: "71", requests: 2, asOf: 90, receivedAt: 91 });
    } finally {
      sock.stop();
    }
  });

  test.each(["ws", "http"] as const)("%s delivery-only confirmation cannot revive a completed user turn", async (via) => {
    const { sock, s, user } = deliverySession("replied");
    try {
      s._sendingInFlight = false;
      s._turnCostCredits = "71";
      s._turnCredits = { clientMessageId: CMID, settled: "71", requests: 2, asOf: 90, receivedAt: 91 };
      await applyDeliverySnapshot(sock, openSnapshot({ lastFrameSeq: null, turnStatus: null }), via);
      expect(user._deliveryState).toBe("accepted");
      expect(user.status).toBe("replied");
      expect(s._sendingInFlight).toBe(false);
      expect(s._activeClientMessageId).toBeUndefined();
      expect((sock as any).dispatchSlots.has("s1")).toBe(false);
      expect(s._turnCostCredits).toBe("71");
      expect(s._turnCredits).toEqual({ clientMessageId: CMID, settled: "71", requests: 2, asOf: 90, receivedAt: 91 });
    } finally {
      sock.stop();
    }
  });
});

describe("没有本地猜测：在飞回合只由快照裁定", () => {
  test("an IndexedDB-restored in-flight turn is decided by HTTP when no hello snapshot arrives in 8s", async () => {
    vi.useFakeTimers();
    const readSessionSnapshot = vi.fn(async () => openSnapshot({
      dispatch: dispatchRow({ status: "terminal", outcome: "completed" }), reconcile: "turn_completed", turnStatus: null,
    }));
    const syncSession = vi.fn(async () => true);
    const sock = makeSocket({ readSessionSnapshot, syncSession });
    sock.loadStored({
      id: "s1", agentId: "main", title: "", createdAt: 1, lastAt: 1,
      messages: [{ id: CMID, role: "user", text: "q", ts: 1, status: "sent" }],
      _sendingInFlight: true, _activeClientMessageId: CMID,
    });
    expect(syncSession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SNAPSHOT_ACK_TIMEOUT_MS);
    await flush();
    expect(readSessionSnapshot).toHaveBeenCalledWith("s1", { afterSeq: 0, dispatch: CMID });
    expect(sock.sessions.get("s1")!._sendingInFlight).toBe(false);
    sock.stop();
  });

  test("the server has no dispatch for the turn the hello named: it is not running", async () => {
    const syncSession = vi.fn(async () => true);
    const { sock, s } = boot({ syncSession });
    pushSnapshot(FakeWS.instances.at(-1)!, openSnapshot());
    await flush();
    expect(s._sendingInFlight).toBe(true);
    // Reconnect with the turn in flight; the snapshot answers with no dispatch for it.
    FakeWS.instances.at(-1)!.close(1006, "");
    await vi.advanceTimersByTimeAsync(60_000);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    expect(hellos(ws)[0]!.peers[0]).toMatchObject({ inFlightClientMessageId: CMID });
    syncSession.mockClear();
    pushSnapshot(ws, snapshot());
    await flush();
    expect(s._sendingInFlight).toBe(false);
    expect(syncSession).toHaveBeenCalledWith("s1", { clientMessageId: CMID });
    sock.stop();
  });

  test("forceSync reads history once and retries a failed read once", async () => {
    const syncSession = vi.fn(async () => false);
    const { sock, ws } = boot({ syncSession });
    ws.push({ type: "outbound.resume_failed", sessionKey: SK, channel: "webchat", peer, from: 9, to: 0, reason: "no_buffer" });
    await flush();
    expect(syncSession).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SNAPSHOT_ACK_TIMEOUT_MS);
    await flush();
    expect(syncSession).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(syncSession).toHaveBeenCalledTimes(2);
    sock.stop();
  });
});
