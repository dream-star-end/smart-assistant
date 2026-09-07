import { describe, expect, test } from "vitest";
import type { ChatMessage } from "./model";
import { repairPostFinalProcessOrder, sinkOpenPermissionPrompts } from "./order";

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

describe("sinkOpenPermissionPrompts (INC-20260904-EXITPLAN-PROMPT-BURIED)", () => {
  const NOW = 1_000_000;

  test("an open prompt buried under replayed process rows sinks to its turn tail", () => {
    const user = row("u1", "user");
    const prompt = row("p1", "permission", { _turnOwnerId: "u1", _resolved: false, ts: 10 });
    const t1 = row("t1", "thinking", { _clientMessageId: "u1", _source: "server", ts: 2 });
    const a1 = row("a1", "assistant", { _clientMessageId: "u1", _source: "server", ts: 3 });
    const tool = row("k1", "tool", { _clientMessageId: "u1", _source: "server", ts: 4 });
    const input = [user, prompt, t1, a1, tool];

    const out = sinkOpenPermissionPrompts(input, NOW);

    expect(out.map((m) => m.id)).toEqual(["u1", "t1", "a1", "k1", "p1"]);
    expect(input.map((m) => m.id)).toEqual(["u1", "p1", "t1", "a1", "k1"]);
    expect(sinkOpenPermissionPrompts(out, NOW)).toBe(out);
  });

  test("never crosses into the next user turn and keeps multi-prompt relative order", () => {
    const rows = [
      row("u1", "user"),
      row("p1", "permission", { _resolved: false, ts: 1 }),
      row("t1", "thinking", { ts: 2 }),
      row("p2", "permission", { _resolved: false, ts: 3 }),
      row("t2", "thinking", { ts: 4 }),
      row("u2", "user"),
      row("t3", "thinking", { ts: 5 }),
    ];
    expect(sinkOpenPermissionPrompts(rows, NOW).map((m) => m.id)).toEqual([
      "u1", "t1", "t2", "p1", "p2", "u2", "t3",
    ]);
  });

  test("resolved, expired or server-authored prompts stay put; clean input is zero-copy", () => {
    const rows = [
      row("u1", "user"),
      row("p-resolved", "permission", { _resolved: true }),
      row("p-expired", "permission", { _resolved: false, _askUserExpiresAt: NOW - 1 }),
      row("p-server", "permission", { _resolved: false, _source: "server" }),
      row("t1", "thinking"),
    ];
    expect(sinkOpenPermissionPrompts(rows, NOW)).toBe(rows);
    const tail = [row("u1", "user"), row("t1", "thinking"), row("p1", "permission", { _resolved: false })];
    expect(sinkOpenPermissionPrompts(tail, NOW)).toBe(tail);
  });

  test("repairPostFinalProcessOrder applies the sink on every rebuild path", () => {
    const rows = [
      row("u1", "user", { _orderSeq: 1, _source: "server" }),
      row("p1", "permission", { _turnOwnerId: "u1", _resolved: false, ts: 10 }),
      row("t1", "thinking", { _clientMessageId: "u1", _source: "server", _orderSeq: 2, ts: 2 }),
    ];
    expect(repairPostFinalProcessOrder(rows).map((m) => m.id)).toEqual(["u1", "t1", "p1"]);
  });

  test("owner-aware sink does not flush a leading owned prompt in front of the first user", () => {
    const rows = [
      row("q1", "permission", { _turnOwnerId: "u1", _resolved: false }),
      row("u1", "user"),
      row("a1", "assistant", { text: "答", _clientMessageId: "u1" }),
    ];
    expect(sinkOpenPermissionPrompts(rows, NOW).map((m) => m.id)).toEqual(["u1", "a1", "q1"]);
  });

  test("unowned leading prompt stays put instead of attaching to the first user", () => {
    const rows = [
      row("q-orphan", "permission", { _resolved: false }),
      row("u1", "user"),
      row("a1", "assistant", { text: "答" }),
    ];
    expect(sinkOpenPermissionPrompts(rows, NOW).map((m) => m.id)).toEqual([
      "q-orphan",
      "u1",
      "a1",
    ]);
  });
});

describe("repairPostFinalProcessOrder owner user bounds (INC-20260907-PROCESS-CARD-BEFORE-USER)", () => {
  test("stableSort-shaped poison [g,q,u,a] self-heals so cards are not before the owner user", () => {
    const g = row("g", "agent-group", { ts: 200, _turnOwnerId: "u" });
    const q = row("q", "permission", { ts: 300, _turnOwnerId: "u", _resolved: false });
    const u = row("u", "user", { ts: 100, _orderSeq: 1, _source: "server" });
    const a = row("a", "assistant", {
      ts: 400,
      _orderSeq: 2,
      _source: "server",
      _clientMessageId: "u",
      text: "答",
    });
    const poisoned = [g, q, u, a];
    const repaired = repairPostFinalProcessOrder(poisoned);
    expect(repaired.map((message) => message.id)).toEqual(["u", "g", "a", "q"]);
    expect(repaired.findIndex((message) => message.id === "g"))
      .toBeGreaterThan(repaired.findIndex((message) => message.id === "u"));
    expect(repairPostFinalProcessOrder(repaired)).toBe(repaired);
  });

  test("already-correct in-turn order is zero-copy", () => {
    const clean = [
      row("u1", "user"),
      row("g1", "agent-group", { _turnOwnerId: "u1" }),
      row("tool1", "tool", { _source: "server", _clientMessageId: "u1" }),
      row("a1", "assistant", { text: "完成", _clientMessageId: "u1" }),
    ];
    expect(repairPostFinalProcessOrder(clean)).toBe(clean);
  });

  test("m-recover owner cards move to that recovery user, not the first user", () => {
    const recoverId = "m-recover-3hev56n0kpyl1";
    const messages = [
      row("g-recover", "agent-group", { _turnOwnerId: recoverId, text: "审读回到底部按钮与几何影响" }),
      row("q-t2", "permission", { _turnOwnerId: recoverId, _resolved: false }),
      row("u-first", "user", { _orderSeq: 1, _source: "server" }),
      row(recoverId, "user", { _orderSeq: 3, _source: "server" }),
      row("a-recover", "assistant", { text: "恢复轮答复", _clientMessageId: recoverId, _orderSeq: 4 }),
    ];
    expect(repairPostFinalProcessOrder(messages).map((message) => message.id)).toEqual([
      "u-first",
      recoverId,
      "g-recover",
      "a-recover",
      "q-t2",
    ]);
  });

  test("missing owner user (pagination) is not guessed onto another turn", () => {
    const messages = [
      row("g-archived", "agent-group", { _turnOwnerId: "u-not-loaded" }),
      row("u2", "user", { _orderSeq: 9, _source: "server" }),
      row("a2", "assistant", { text: "后一轮", _clientMessageId: "u2", _orderSeq: 10 }),
    ];
    expect(repairPostFinalProcessOrder(messages).map((message) => message.id)).toEqual([
      "g-archived",
      "u2",
      "a2",
    ]);
  });

  test("server-authored tape relative order is never rewritten", () => {
    const tape = [
      row("g-server", "agent-group", { _source: "server", _turnOwnerId: "u1" }),
      row("u1", "user", { _orderSeq: 1, _source: "server" }),
      row("think1", "thinking", { _source: "server", _clientMessageId: "u1", _orderSeq: 2 }),
      row("tool1", "tool", { _source: "server", _clientMessageId: "u1", _orderSeq: 2, _turnTapeOrdinal: 1 }),
      row("a1", "assistant", { text: "完成", _source: "server", _clientMessageId: "u1", _orderSeq: 2, _turnTapeOrdinal: 2 }),
    ];
    expect(repairPostFinalProcessOrder(tape)).toBe(tape);
  });

  test("cards past the next user are pulled back before that user", () => {
    const messages = [
      row("u1", "user"),
      row("a1", "assistant", { text: "第一轮", _clientMessageId: "u1" }),
      row("u2", "user"),
      row("g1", "agent-group", { _turnOwnerId: "u1" }),
      row("p1", "permission", { _turnOwnerId: "u1", _resolved: true }),
    ];
    expect(repairPostFinalProcessOrder(messages).map((message) => message.id)).toEqual([
      "u1",
      "g1",
      "p1",
      "a1",
      "u2",
    ]);
  });

  test("resolved open-question mix keeps resolved card in-turn and sinks the open prompt", () => {
    const messages = [
      row("q-open", "permission", { _turnOwnerId: "u1", _resolved: false }),
      row("q-done", "permission", { _turnOwnerId: "u1", _resolved: true }),
      row("u1", "user"),
      row("a1", "assistant", { text: "完成", _clientMessageId: "u1" }),
    ];
    expect(repairPostFinalProcessOrder(messages).map((message) => message.id)).toEqual([
      "u1",
      "q-done",
      "a1",
      "q-open",
    ]);
  });

  test("legacy exact _clientMessageId only binds when that user exists", () => {
    const present = [
      row("g1", "agent-group", { _clientMessageId: "u1" }),
      row("u1", "user"),
      row("a1", "assistant", { text: "完成", _clientMessageId: "u1" }),
    ];
    expect(repairPostFinalProcessOrder(present).map((message) => message.id)).toEqual([
      "u1",
      "g1",
      "a1",
    ]);

    const absent = [
      row("g-ghost", "agent-group", { _clientMessageId: "u-missing" }),
      row("u2", "user"),
      row("a2", "assistant", { text: "后一轮", _clientMessageId: "u2" }),
    ];
    expect(repairPostFinalProcessOrder(absent).map((message) => message.id)).toEqual([
      "g-ghost",
      "u2",
      "a2",
    ]);
  });

  test("in-turn tool/assistant interleaving is preserved when only the prefix is illegal", () => {
    const tool = row("tool1", "tool", { _source: "server", _clientMessageId: "u1" });
    const mid = row("a-mid", "assistant", { text: "中段", _source: "server", _clientMessageId: "u1" });
    const messages = [
      row("g-early", "agent-group", { _turnOwnerId: "u1" }),
      row("u1", "user"),
      tool,
      mid,
      row("a-final", "assistant", { text: "终答", _clientMessageId: "u1" }),
    ];
    const repaired = repairPostFinalProcessOrder(messages);
    expect(repaired.map((message) => message.id)).toEqual([
      "u1",
      "g-early",
      "tool1",
      "a-mid",
      "a-final",
    ]);
    expect(repaired[2]).toBe(tool);
    expect(repaired[3]).toBe(mid);
  });
});
