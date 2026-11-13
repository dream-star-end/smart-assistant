import { afterEach, describe, expect, test, vi } from "vitest";
import { turnCreditsLine } from "./backgroundTurnNotice";
import type { CostChargedWire, OutboundMessageWire, OutboundTurnStatusWire } from "./frames";
import { addMessage, clearTurnTiming, createSession } from "./model";
import { applyCostCharged, applyOutboundError, applyOutboundMessage, applyTurnStatus } from "./reducer";
import { ChatSocket } from "./socket";

afterEach(() => vi.useRealTimers());

function activeSession() {
  const sess = createSession({ id: "truth-session", agentId: "main" });
  addMessage(sess, "user", "继续处理", { id: "truth-user", status: "sent" });
  sess._sendingInFlight = true;
  sess._activeClientMessageId = "truth-user";
  return sess;
}

function message(over: Partial<OutboundMessageWire> = {}): OutboundMessageWire {
  return {
    type: "outbound.message", channel: "webchat", sessionKey: "agent:main:webchat:dm:truth-session",
    peer: { id: "truth-session", kind: "dm" }, clientMessageId: "truth-user", blocks: [], isFinal: false,
    ...over,
  };
}

function charged(over: Partial<CostChargedWire> = {}): CostChargedWire {
  return { type: "outbound.cost_charged", requestId: "request-1", costCredits: "100", debitedCredits: "35", ...over };
}

describe("TRUTH-07: 实扣展示按会话 requestId 去重", () => {
  test("重复广播只累加一次徽章、本轮实扣和请求数，余额仍刷新", () => {
    const sess = activeSession();
    const assistant = addMessage(sess, "assistant", "已开始处理", { usage: {} });
    sess._streamingAssistant = assistant;
    const refreshBalance = vi.fn();
    for (let i = 0; i < 2; i++) {
      applyCostCharged(sess, charged({ balanceAfter: "65" }), { refreshBalance });
    }
    expect(assistant.usage?.costCredits).toBe("35");
    expect(sess._turnCostCredits).toBe("35");
    expect(sess._turnCredits).toEqual({
      clientMessageId: "truth-user", settled: "35", requests: 1, asOf: expect.any(Number), receivedAt: expect.any(Number),
    });
    expect(refreshBalance).toHaveBeenCalledTimes(2);
  });

  test("跨轮迟到重复帧不计入新轮，新请求仍可累加", () => {
    const sess = activeSession();
    applyCostCharged(sess, charged());
    clearTurnTiming(sess);
    sess._turnCredits = { clientMessageId: "truth-user", settled: "0", requests: 0, asOf: Date.now(), receivedAt: Date.now() };
    const next = addMessage(sess, "assistant", "下一轮", { usage: {} });
    sess._streamingAssistant = next;
    applyCostCharged(sess, charged());
    expect(next.usage?.costCredits).toBeUndefined();
    expect(sess._turnCostCredits).toBe("0");
    applyCostCharged(sess, charged({ requestId: "request-2", debitedCredits: "15" }));
    expect(next.usage?.costCredits).toBe("15");
    expect(sess._turnCredits?.settled).toBe("15");
  });

  test("部分扣减在无助手消息时入队，终态徽章保持实扣值", () => {
    const sess = activeSession();
    applyCostCharged(sess, charged());
    applyOutboundMessage(sess, message({ blocks: [{ kind: "text", text: "处理完成", messageId: "answer" }] }));
    applyOutboundMessage(sess, message({ isFinal: true, meta: { stopReason: "end_turn" } }));
    expect(sess.messages.find((row) => row.id === "answer")?.usage?.costCredits).toBe("35");
    expect(sess._turnCredits?.settled).toBe("35");
    applyCostCharged(sess, charged());
    expect(sess.messages.find((row) => row.id === "answer")?.usage?.costCredits).toBe("35");
  });

  test("turn_status 权威积分快照与实时实扣使用同构字段", () => {
    const sess = activeSession();
    applyTurnStatus(sess, {
      type: "outbound.turn_status", channel: "webchat", peer: { id: sess.id, kind: "dm" },
      sessionKey: "agent:main:webchat:dm:truth-session", status: "working",
      meta: { detached: true, credits: { settled: "200", requests: 2, asOf: 1 } },
    } as OutboundTurnStatusWire);
    expect(sess._turnCredits).toEqual({
      clientMessageId: "truth-user", settled: "200", requests: 2, asOf: 1, receivedAt: expect.any(Number),
    });
    applyCostCharged(sess, charged());
    expect(sess._turnCredits).toEqual({
      clientMessageId: "truth-user", settled: "235", requests: 3, asOf: expect.any(Number), receivedAt: expect.any(Number),
    });
  });

  test("去重缓存有界且保留最近请求", () => {
    const sess = activeSession();
    for (let i = 0; i < 513; i++) applyCostCharged(sess, charged({ requestId: `bounded-${i}`, debitedCredits: "1" }));
    expect(sess._costChargedSeenRequestIds?.size).toBe(512);
    applyCostCharged(sess, charged({ requestId: "bounded-512", debitedCredits: "1" }));
    expect(sess._turnCostCredits).toBe("513");
    expect(sess._turnCredits?.requests).toBe(513);
  });
});

describe("TRUTH-09: 块流式截断属于本轮最后非空助手消息", () => {
  test.each(["max_tokens", "pause_turn"])("%s 在流式指针清空后仍保留原因", (stopReason) => {
    const sess = activeSession();
    applyOutboundMessage(sess, message({ blocks: [{ kind: "text", text: "半截回复", messageId: "answer" }] }));
    applyOutboundMessage(sess, message({ blocks: [{ kind: "tool_use", toolName: "Read", blockId: "read-1", inputJson: {} }] }));
    expect(sess._streamingAssistant).toBeNull();
    addMessage(sess, "assistant", "");
    applyOutboundMessage(sess, message({ isFinal: true, meta: { stopReason } }));
    expect(sess.messages.find((row) => row.id === "answer")?._truncated).toBe(stopReason);
  });

  test("本轮没有正文时不越过用户消息给上一轮打截断标记", () => {
    const sess = createSession({ id: "truth-session", agentId: "main" });
    const old = addMessage(sess, "assistant", "上一轮完整答案");
    addMessage(sess, "user", "新任务", { id: "truth-user", status: "sent" });
    sess._activeClientMessageId = "truth-user";
    sess._sendingInFlight = true;
    applyOutboundMessage(sess, message({ isFinal: true, meta: { stopReason: "pause_turn" } }));
    expect(old._truncated).toBeUndefined();
  });
});

describe("TRUTH-10: 异常收尾保留取消真相", () => {
  test.each([{ stopReason: "error" }, { interrupted: "user_cancelled" }])("%j 取消无结果工具和未完成委派，保留已完/后台任务", (meta) => {
    const sess = activeSession();
    const tool = addMessage(sess, "tool", "Read", { _completed: false });
    const output = addMessage(sess, "tool", "Read", { _completed: false, output: "已拿到结果" });
    const group = addMessage(sess, "agent-group", "子任务", { _completed: false });
    const progress = addMessage(sess, "delegate-progress", "旧版子任务", { _completed: false });
    const completed = addMessage(sess, "agent-group", "已完成任务", { _completed: true });
    const background = addMessage(sess, "agent-group", "后台任务", { _completed: false, _background: true });
    applyOutboundMessage(sess, message({ isFinal: true, meta }));
    for (const row of [tool, group, progress]) expect(row).toMatchObject({ _completed: true, cancelled: true });
    expect(output.cancelled).toBeUndefined();
    expect(completed.cancelled).toBeUndefined();
    expect(background).toMatchObject({ _completed: false });
    expect(background.cancelled).toBeUndefined();
  });

  test("没有兼容 final 的结构化终态错误也取消未完成委派", () => {
    const sess = activeSession();
    const group = addMessage(sess, "agent-group", "未完成子任务", { _completed: false, _turnOwnerId: "truth-user" });
    applyOutboundError(sess, {
      type: "outbound.error", channel: "webchat", peer: { id: sess.id, kind: "dm" },
      sessionKey: "agent:main:webchat:dm:truth-session", clientMessageId: "truth-user",
      code: "upstream_failed", message: "上游断开", isFinal: false,
    });
    expect(group).toMatchObject({ _completed: true, cancelled: true });
  });
});

describe("snapshot recovery integrates the actual-debit projection", () => {
  test("an accepted-only next turn starts its debit projection at zero after the previous final", () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    const sess = activeSession();
    const sock = new ChatSocket({
      getToken: () => "test", getAuthEpoch: () => 0,
      silentRefresh: async (epoch) => ({ kind: "transient", epoch, retryAfterMs: 500 }),
      onAuthExpired: () => {},
    });
    sock.sessions.set(sess.id, sess);
    try {
      applyCostCharged(sess, charged());
      applyOutboundMessage(sess, message({ blocks: [{ kind: "text", text: "首轮完成", messageId: "answer-first" }] }));
      applyOutboundMessage(sess, message({ isFinal: true, meta: { stopReason: "end_turn" } }));
      expect(sess._sendingInFlight).toBe(false);
      expect(sess._turnCredits).toEqual({
        clientMessageId: "truth-user", settled: "35", requests: 1, asOf: 20_000, receivedAt: 20_000,
      });
      expect(sess.messages.find((row) => row.id === "answer-first")?.usage?.costCredits).toBe("35");

      const nextUser = addMessage(sess, "user", "下一轮", { id: "truth-next", status: "sending" });
      sess._activeClientMessageId = nextUser.id;
      sess._sendingInFlight = true;
      (sock as any).dispatch({
        type: "outbound.ack", peer: { id: sess.id, kind: "dm" }, clientMessageId: nextUser.id, accepted: true,
      });
      expect(nextUser._deliveryState).toBe("accepted");
      // Admission ACK was lost: acceptance cannot reset already confirmed facts.
      expect(sess._turnCredits).toEqual({
        clientMessageId: "truth-user", settled: "35", requests: 1, asOf: 20_000, receivedAt: 20_000,
      });
      vi.setSystemTime(21_000);
      applyCostCharged(sess, charged({ requestId: "request-next", debitedCredits: "15" }));
      expect(sess._turnCredits).toEqual({
        clientMessageId: "truth-next", settled: "15", requests: 1, asOf: 21_000, receivedAt: 21_000,
      });
      expect(turnCreditsLine(sess, 21_000, false)).toBe("本轮已扣 15 积分");
      applyCostCharged(sess, charged());
      expect(sess._turnCredits).toEqual({
        clientMessageId: "truth-next", settled: "15", requests: 1, asOf: 21_000, receivedAt: 21_000,
      });
    } finally {
      sock.stop();
    }
  });

  test("an explicitly different turn_status cannot overwrite the current turn's credits", () => {
    const sess = activeSession();
    const current = { clientMessageId: "truth-user", settled: "35", requests: 1, asOf: 100, receivedAt: 101 };
    sess._turnCredits = current;
    applyTurnStatus(sess, {
      type: "outbound.turn_status", channel: "webchat", peer: { id: sess.id, kind: "dm" },
      sessionKey: "agent:main:webchat:dm:truth-session", clientMessageId: "other-turn", status: "working",
      meta: { detached: true, credits: { settled: "900", requests: 9, asOf: 200 } },
    } as OutboundTurnStatusWire);
    expect(sess._turnCredits).toBe(current);
    expect(sess._turnCredits).toEqual({ clientMessageId: "truth-user", settled: "35", requests: 1, asOf: 100, receivedAt: 101 });
    expect(turnCreditsLine(sess, 101, false)).toBe("本轮已扣 35 积分");
  });

  test("turn_status and live cost retain the metadata used by the background credit line", () => {
    vi.useFakeTimers();
    vi.setSystemTime(30_000);
    const sess = activeSession();
    applyTurnStatus(sess, {
      type: "outbound.turn_status", channel: "webchat", peer: { id: sess.id, kind: "dm" },
      sessionKey: "agent:main:webchat:dm:truth-session", clientMessageId: "truth-user", status: "working",
      meta: { detached: true, credits: { settled: "200", requests: 2, asOf: 1 } },
    } as OutboundTurnStatusWire);
    expect(sess._turnCredits).toEqual({
      clientMessageId: "truth-user", settled: "200", requests: 2, asOf: 1, receivedAt: 30_000,
    });
    expect(turnCreditsLine(sess, 30_000, false)).toBe("本轮已扣 200 积分");
    vi.setSystemTime(31_000);
    applyCostCharged(sess, charged());
    expect(sess._turnCredits).toEqual({
      clientMessageId: "truth-user", settled: "235", requests: 3, asOf: 31_000, receivedAt: 31_000,
    });
    expect(turnCreditsLine(sess, 31_000, false)).toBe("本轮已扣 235 积分");
    expect(turnCreditsLine(sess, 91_000, false)).toBe("本轮已扣 235 积分（截至 1 分钟前）");
  });
});
