import { describe, expect, test } from "vitest";
import type { ChatMessage } from "./model";
import { repairPostFinalProcessOrder } from "./order";

function row(id: string, role: ChatMessage["role"], over: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role, text: id, ts: 1, ...over };
}

describe("repairPostFinalProcessOrder", () => {
  test("repairs the production poison shape and migrates legacy process ownership", () => {
    const user = row("u1", "user", { _orderSeq: 1, _source: "server" });
    const final = row("a1", "assistant", {
      text: "最终答复",
      ts: 500,
      _orderSeq: 2,
      _source: "server",
      _clientMessageId: "u1",
    });
    const group = row("g1", "agent-group", { ts: 200 });
    const permission = row("p1", "permission", { ts: 300, _resolved: true });
    const poisoned = [user, final, group, permission];

    const repaired = repairPostFinalProcessOrder(poisoned);

    expect(repaired.map((message) => message.id)).toEqual(["u1", "g1", "p1", "a1"]);
    expect(repaired[1]._turnOwnerId).toBe("u1");
    expect(repaired[2]._turnOwnerId).toBe("u1");
    expect(poisoned.map((message) => message.id)).toEqual(["u1", "a1", "g1", "p1"]);
    expect(group._turnOwnerId).toBeUndefined();
  });

  test("clean stamped order is zero-copy and repeated repair is idempotent", () => {
    const clean = [
      row("u1", "user"),
      row("g1", "agent-group", { _turnOwnerId: "u1" }),
      row("p1", "permission", { _turnOwnerId: "u1" }),
      row("a1", "assistant", { text: "完成", _clientMessageId: "u1" }),
    ];

    expect(repairPostFinalProcessOrder(clean)).toBe(clean);
    const once = repairPostFinalProcessOrder([
      clean[0],
      clean[3],
      clean[1],
      clean[2],
    ]);
    expect(repairPostFinalProcessOrder(once)).toBe(once);
  });

  test("legacy fallback stops at the next user boundary", () => {
    const messages = [
      row("u1", "user"),
      row("a1", "assistant", { text: "第一轮", _clientMessageId: "u1" }),
      row("u2", "user"),
      row("a2", "assistant", { text: "第二轮", _clientMessageId: "u2" }),
      row("p2", "permission"),
    ];

    const repaired = repairPostFinalProcessOrder(messages);
    expect(repaired.map((message) => message.id)).toEqual(["u1", "a1", "u2", "p2", "a2"]);
    expect(repaired.find((message) => message.id === "p2")?._turnOwnerId).toBe("u2");
  });

  test("explicit ownership repairs a queued/out-of-array-order prior turn", () => {
    const messages = [
      row("u1", "user"),
      row("a1", "assistant", { text: "第一轮", _clientMessageId: "u1" }),
      row("u2", "user"),
      row("a2", "assistant", { text: "第二轮", _clientMessageId: "u2" }),
      row("g1", "agent-group", { _turnOwnerId: "u1" }),
    ];

    expect(repairPostFinalProcessOrder(messages).map((message) => message.id)).toEqual([
      "u1",
      "g1",
      "a1",
      "u2",
      "a2",
    ]);
  });

  test("durable order and tape ordinal select the terminal without using ts", () => {
    const messages = [
      row("u1", "user"),
      row("a-final", "assistant", {
        text: "durable final",
        ts: 1,
        _clientMessageId: "u1",
        _orderSeq: 9,
        _turnTapeOrdinal: 8,
      }),
      row("g1", "agent-group", { ts: 999_999, _turnOwnerId: "u1" }),
      row("a-earlier", "assistant", {
        text: "earlier segment",
        ts: 999_999,
        _clientMessageId: "u1",
        _orderSeq: 9,
        _turnTapeOrdinal: 2,
      }),
    ];

    expect(repairPostFinalProcessOrder(messages).map((message) => message.id)).toEqual([
      "u1",
      "g1",
      "a-final",
      "a-earlier",
    ]);
  });

  test("terminal collapsed anchors and assistant errors both repair their process tail", () => {
    const collapsed = [
      row("u1", "user"),
      row("c1", "assistant", {
        text: "",
        _clientMessageId: "u1",
        _turnTapeProcess: true,
        _dispatchOutcome: "completed",
      }),
      row("g1", "agent-group", { _turnOwnerId: "u1" }),
    ];
    expect(repairPostFinalProcessOrder(collapsed).map((message) => message.id)).toEqual([
      "u1",
      "g1",
      "c1",
    ]);

    const errored = [
      row("u2", "user"),
      row("e2", "assistant", {
        text: "连接失败",
        _clientMessageId: "u2",
        _errorCode: "service_restart",
      }),
      row("p2", "permission", { _turnOwnerId: "u2" }),
    ];
    expect(repairPostFinalProcessOrder(errored).map((message) => message.id)).toEqual([
      "u2",
      "p2",
      "e2",
    ]);
  });

  test("server-authored process rows and owners without terminals are never moved", () => {
    const serverProcess = [
      row("u1", "user"),
      row("a1", "assistant", { text: "完成", _clientMessageId: "u1" }),
      row("srv-g1", "agent-group", { _source: "server" }),
    ];
    expect(repairPostFinalProcessOrder(serverProcess)).toBe(serverProcess);

    const noTerminal = [row("u2", "user"), row("p2", "permission")];
    const migrated = repairPostFinalProcessOrder(noTerminal);
    expect(migrated.map((message) => message.id)).toEqual(["u2", "p2"]);
    expect(migrated[1]._turnOwnerId).toBe("u2");
  });

  test("mixed legal-before and poisoned-after cards move only the poisoned suffix", () => {
    const before = row("g-before", "agent-group", { _turnOwnerId: "u1" });
    const after = row("p-after", "permission", { _turnOwnerId: "u1" });
    const messages = [
      row("u1", "user"),
      before,
      row("a1", "assistant", { text: "完成", _clientMessageId: "u1" }),
      after,
    ];
    const repaired = repairPostFinalProcessOrder(messages);
    expect(repaired.map((message) => message.id)).toEqual(["u1", "g-before", "p-after", "a1"]);
    expect(repaired[1]).toBe(before);
    expect(repaired[2]).toBe(after);
  });
});
