import { afterEach, describe, expect, test, vi } from "vitest";
import { confirmSnapshotDelivery } from "./deliveryConfirm";
import { mergeFullServerWins, applyServerIncremental } from "../persist";
import { createSession } from "./model";
import { messageSignature, agentTerminalStatus } from "./render";
import { ChatSocket } from "./socket";

const sockets: ChatSocket[] = [];
afterEach(() => {
  for (const sock of sockets.splice(0)) sock.stop();
  vi.useRealTimers();
});
function setup() {
  const sock = new ChatSocket({
    getToken: () => "test", getAuthEpoch: () => 0,
    silentRefresh: async (epoch) => ({ kind: "transient", epoch, retryAfterMs: 500 }),
    onAuthExpired: () => {},
  });
  sockets.push(sock);
  const sess = createSession({ id: "s1", agentId: "main" });
  const user = { id: "u1", role: "user" as const, text: "hello", ts: 1, status: "sending" as const };
  sess.messages.push(user);
  sess._activeClientMessageId = user.id;
  sess._sendingInFlight = true;
  sock.sessions.set(sess.id, sess);
  const frame = (data: Record<string, unknown>) => (sock as any).dispatch({
    peer: { id: "s1", kind: "dm" }, clientMessageId: user.id,
    channel: "webchat", sessionKey: "agent:main:webchat:dm:s1", ...data,
  });
  return { sock, sess, user: sess.messages[0]!, frame };
}

describe("container-confirmed delivery", () => {
  test("master admission calibrates the clock; late accepted and replayed admission preserve debits", () => {
    vi.useFakeTimers();
    vi.setSystemTime(90_000);
    const { sess, user, frame } = setup();
    sess._turnStartedAt = 1;
    frame({ type: "outbound.ack", admitted: true });
    expect(user).toMatchObject({ status: "sent", _deliveryState: "admitted" });
    expect(sess._turnStartedAt).toBe(90_000);
    const before = messageSignature(user, { isLast: true, sending: true });
    sess._turnCostCredits = "23";
    sess._turnCostSeenRequestIds = new Set(["charge-1"]);
    sess._turnCredits = { settled: "23", requests: 1, asOf: 90_001 };
    frame({ type: "outbound.ack", accepted: true });
    frame({ type: "outbound.ack", admitted: true });
    expect(user._deliveryState).toBe("accepted");
    expect(messageSignature(user, { isLast: true, sending: true })).not.toBe(before);
    expect(sess._turnCostCredits).toBe("23");
    expect(sess._turnCostSeenRequestIds).toEqual(new Set(["charge-1"]));
    expect(sess._turnCredits?.settled).toBe("23");
  });

  test.each([
    { type: "outbound.turn_status", status: "working" },
    { type: "outbound.message", blocks: [], isFinal: false },
    { type: "outbound.turn_usage", usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 } },
    { type: "outbound.call_usage", usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 } },
  ])("$type confirms only the correlated user row", (data) => {
    const { user, frame } = setup();
    frame({ type: "outbound.ack", admitted: true });
    frame({ ...data, clientMessageId: "other" });
    expect(user._deliveryState).toBe("admitted");
    frame(data);
    expect(user._deliveryState).toBe("accepted");
  });

  test("master-only detached status cannot claim container delivery", () => {
    const { user, frame } = setup();
    frame({ type: "outbound.turn_status", status: "engine_starting", meta: { detached: true, since: 1 } });
    expect(user._deliveryState).toBe("admitted");
    frame({ type: "outbound.ack", accepted: true });
    expect(user._deliveryState).toBe("accepted");
  });

  test("history and hello snapshot acceptedAt mark delivery without starting a cost window", () => {
    const { sess, user, frame } = setup();
    sess._turnCostCredits = "71";
    confirmSnapshotDelivery(sess, { clientMessageId: user.id, acceptedAt: null });
    expect(user._deliveryState).toBeUndefined();
    frame({ type: "outbound.session_snapshot", snapshot: { dispatch: { clientMessageId: user.id, acceptedAt: 100 } } });
    expect(user._deliveryState).toBe("accepted");
    expect(sess._turnCostCredits).toBe("71");
  });

  test.each([false, true])("late history preserves confirmed delivery (timeline=%s)", (timeline) => {
    const { user, frame } = setup();
    frame({ type: "outbound.ack", accepted: true });
    const older = { ...user, _deliveryState: undefined, _timelineRecord: timeline };
    expect(mergeFullServerWins([older], [user])[0]._deliveryState).toBe("accepted");
    expect(applyServerIncremental([user], [older])[0]._deliveryState).toBe("accepted");
  });

  test("cancelled delegate terminal status is neutral", () => {
    expect(agentTerminalStatus({ cancelled: true })).toEqual({ label: "已取消", tone: "neutral" });
  });
});
