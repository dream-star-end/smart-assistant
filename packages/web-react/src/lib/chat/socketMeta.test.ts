import { afterEach, describe, expect, test, vi } from "vitest";
import type { ChatSession } from "./model";
import { SocketMetaTracker, STOP_SETTLEMENT_TIMEOUT_MS } from "./socketMeta";

function makeSession(id: string, over: Partial<ChatSession> = {}): ChatSession {
  return {
    id,
    title: "新对话",
    agentId: "main",
    createdAt: 1000,
    lastAt: 1000,
    messages: [],
    ...over,
  } as ChatSession;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SocketMetaTracker", () => {
  test("plain streaming text deltas do NOT bump metaVersion, while busy/needs_you/title changes DO", () => {
    const tracker = new SocketMetaTracker();
    const s1 = makeSession("s1", {
      _sendingInFlight: true,
      messages: [
        { id: "u1", role: "user", text: "hi", ts: 1000 },
        { id: "a1", role: "assistant", text: "Hello", ts: 1001 },
      ],
    });
    const s2 = makeSession("s2", {
      title: "Idle",
      messages: [{ id: "u2", role: "user", text: "old", ts: 500 }],
    });
    const sessions = new Map<string, ChatSession>([
      ["s1", s1],
      ["s2", s2],
    ]);

    tracker.onFlush({ sessions, offlineQueue: [], statusCls: "connected", provisioning: false, browserOnline: true });
    const v1 = tracker.metaVersion;
    expect(v1).toBe(1);
    expect(tracker.consumeDirtyPersistIds().sort()).toEqual(["s1", "s2"]);

    // Plain streaming text deltas on s1
    s1.messages[1]!.text = "Hello world, streaming more tokens...";
    tracker.onFlush({ sessions, offlineQueue: [], statusCls: "connected", provisioning: false, browserOnline: true });
    expect(tracker.metaVersion).toBe(v1); // MUST NOT bump!
    // Only s1 is dirty for persistence (s2 untouched!)
    expect(tracker.consumeDirtyPersistIds()).toEqual(["s1"]);

    // Permission prompt arrives (needs_you rising edge) -> MUST bump metaVersion!
    s1.messages.push({ id: "p1", role: "permission", text: "", toolName: "Bash", requestId: "req-1", ts: 1002 });
    tracker.onFlush({ sessions, offlineQueue: [], statusCls: "connected", provisioning: false, browserOnline: true });
    expect(tracker.metaVersion).toBe(v1 + 1);

    // Turn finishes -> MUST bump metaVersion!
    s1._sendingInFlight = false;
    s1.messages[2]!._resolved = true;
    s1.messages[1]!._dispatchOutcome = "completed";
    tracker.onFlush({ sessions, offlineQueue: [], statusCls: "connected", provisioning: false, browserOnline: true });
    expect(tracker.metaVersion).toBe(v1 + 2);
  });

  test("stop settlement timeout fires after STOP_SETTLEMENT_TIMEOUT_MS and cancels cleanly when cleared", () => {
    vi.useFakeTimers();
    const tracker = new SocketMetaTracker();
    const onExpire = vi.fn();
    tracker.armStopTimeout("s1", onExpire);
    vi.advanceTimersByTime(STOP_SETTLEMENT_TIMEOUT_MS - 1);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);

    const onExpire2 = vi.fn();
    tracker.armStopTimeout("s2", onExpire2);
    tracker.clearStopTimeout("s2");
    vi.advanceTimersByTime(STOP_SETTLEMENT_TIMEOUT_MS * 2);
    expect(onExpire2).not.toHaveBeenCalled();
  });
});
