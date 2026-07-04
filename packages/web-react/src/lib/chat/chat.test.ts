import { afterEach, describe, expect, test, vi } from "vitest";
import {
  applyPartialJsonDelta,
  backoffDelay,
  classifyClose,
  classifyEmptyTurn,
  countAnswerBlocks,
  findOrCreateStreamingRow,
  friendlyBridgeErrorMessage,
  getFrameSeqCursor,
  nonAuthPolicyCloseInfo,
  normalizeBridgeErrorCode,
  onopenSetInitialStatus,
  parsePartialJson,
  shouldAutoContinueEmptyTurn,
} from "./pure";
import { addMessage, type ChatMessage, createSession } from "./model";
import {
  applyCostCharged,
  applyCostWaived,
  applyOutboundError,
  applyOutboundMessage,
  applyResumeFailed,
  type FrameEffects,
} from "./reducer";
import { ChatSocket } from "./socket";
import type { OutboundMessageWire } from "./frames";

// ─── helpers ──────────────────────────────────────────────────────────
function sess(id = "s1", agentId = "main") {
  const s = createSession({ id, agentId });
  return s;
}
type AnyFrame = Record<string, unknown>;
function msgFrame(over: AnyFrame): OutboundMessageWire {
  return {
    type: "outbound.message",
    sessionKey: "agent:main:webchat:dm:s1",
    channel: "webchat",
    peer: { id: "s1", kind: "dm" },
    blocks: [],
    isFinal: false,
    ...over,
  } as unknown as OutboundMessageWire;
}

// ═══════════════ §8 partialJson offset 累加器 ═══════════════
describe("applyPartialJsonDelta (§8)", () => {
  test("offset===length → set (append)", () => {
    expect(applyPartialJsonDelta("", { partialJsonDelta: '{"a"', partialJsonOffset: 0 })).toEqual({
      action: "set",
      value: '{"a"',
    });
    expect(applyPartialJsonDelta('{"a"', { partialJsonDelta: ":1}", partialJsonOffset: 4 })).toEqual({
      action: "set",
      value: '{"a":1}',
    });
  });
  test("offset mismatch (dup/reorder/ring overlap) → drop", () => {
    expect(applyPartialJsonDelta('{"a"', { partialJsonDelta: "x", partialJsonOffset: 0 })).toEqual({ action: "drop" });
    expect(applyPartialJsonDelta('{"a"', { partialJsonDelta: "x", partialJsonOffset: 99 })).toEqual({ action: "drop" });
  });
  test("no delta fields → keep", () => {
    expect(applyPartialJsonDelta("x", {})).toEqual({ action: "keep" });
    expect(applyPartialJsonDelta("x", { partialJsonDelta: "y" })).toEqual({ action: "keep" });
  });
  test("recovery: after drop, offset===0 frame reseeds from null", () => {
    expect(applyPartialJsonDelta(null, { partialJsonDelta: "{", partialJsonOffset: 0 })).toEqual({
      action: "set",
      value: "{",
    });
  });
});

describe("parsePartialJson", () => {
  test("complete object", () => {
    expect(parsePartialJson('{"file_path":"/a","x":1}')).toEqual({ file_path: "/a", x: 1 });
  });
  test("partial trailing string value extracted", () => {
    expect(parsePartialJson('{"old_string":"hel')).toEqual({ old_string: "hel" });
  });
  test("top-level non-object → {}", () => {
    expect(parsePartialJson("[1,2]")).toEqual({});
    expect(parsePartialJson("garbage")).toEqual({});
  });
  test("never throws on adversarial input", () => {
    for (const s of ["", "{", '{"', '{"a":', '{"a":{', '{"a":"\\u', "{}}}", '{"a":\\']) {
      expect(() => parsePartialJson(s)).not.toThrow();
    }
  });
});

// ═══════════════ §3 frameSeq 游标 ═══════════════
describe("getFrameSeqCursor (§3 严禁全局单游标)", () => {
  test("peer: prefix falls back to legacy single cursor", () => {
    expect(getFrameSeqCursor(undefined, 7, "peer:s1")).toBe(7);
  });
  test("agent-scoped sessionKey never inherits legacy cursor (starts at 0)", () => {
    // A 容器推到 50 后 B 容器从 1 起的帧不能被全局游标当 dup 丢掉。
    expect(getFrameSeqCursor({ "agent:a:webchat:dm:s1": 50 }, 50, "agent:b:webchat:dm:s1")).toBe(0);
  });
  test("byKey hit wins", () => {
    expect(getFrameSeqCursor({ "agent:a:webchat:dm:s1": 12 }, 0, "agent:a:webchat:dm:s1")).toBe(12);
  });
});

// ═══════════════ 空轮分类 + auto-continue cap ═══════════════
describe("classifyEmptyTurn / shouldAutoContinueEmptyTurn", () => {
  test("thinking is NOT an answer (GLM 想了没说 bug)", () => {
    const messages = [
      { id: "u1", role: "user" },
      { id: "t1", role: "thinking" },
    ];
    const r = classifyEmptyTurn({ messages, targetMsgId: "u1", hasAnswerOutput: false, stopReason: "end_turn" });
    expect(r.insert).toBe(true);
  });
  test("answer-bearing message after target → no notice", () => {
    const messages = [
      { id: "u1", role: "user" },
      { id: "a1", role: "assistant" },
    ];
    expect(classifyEmptyTurn({ messages, targetMsgId: "u1", hasAnswerOutput: false }).insert).toBe(false);
  });
  test("countAnswerBlocks whitelist excludes thinking/tool_result", () => {
    expect(countAnswerBlocks([{ kind: "thinking" }, { kind: "tool_result" }])).toBe(0);
    expect(countAnswerBlocks([{ kind: "text" }, { kind: "tool_use" }, { kind: "plan" }])).toBe(3);
  });
  test("auto-continue only on end_turn, capped once", () => {
    const messages = [{ id: "u1", role: "user" }];
    expect(shouldAutoContinueEmptyTurn({ messages, targetMsgId: "u1", stopReason: "end_turn" })).toBe(true);
    expect(shouldAutoContinueEmptyTurn({ messages, targetMsgId: "u1", stopReason: "max_tokens" })).toBe(false);
    const withAuto = [
      { id: "u1", role: "user" },
      { id: "u2", role: "user", _isAutoRetry: true },
    ];
    expect(shouldAutoContinueEmptyTurn({ messages: withAuto, targetMsgId: "u1", stopReason: "end_turn" })).toBe(false);
  });
});

// ═══════════════ §5 close code 语义 ═══════════════
describe("classifyClose / nonAuthPolicyCloseInfo (§5)", () => {
  test("4503 reads retryAfterSec clamp [1s,60s] (12-min loop fix)", () => {
    const d = classifyClose(4503, JSON.stringify({ retryAfterSec: 5, reason: "provisioning" }));
    expect(d.action).toBe("reconnect");
    expect(d.serverHintedDelay).toBeGreaterThanOrEqual(5000);
    expect(d.serverHintedDelay).toBeLessThan(6000);
    expect(d.provisioning).toBe(true);
  });
  test("4503 retryAfterSec clamped to 60s upper bound", () => {
    const d = classifyClose(4503, JSON.stringify({ retryAfterSec: 9999, reason: "starting" }));
    expect(d.serverHintedDelay).toBeGreaterThanOrEqual(60000);
    expect(d.serverHintedDelay).toBeLessThan(60600);
  });
  test("1008 → auth refresh path", () => {
    expect(classifyClose(1008, "").action).toBe("auth_1008");
  });
  test("4506 insufficient_credits → policy + billing", () => {
    const d = classifyClose(4506, "");
    expect(d.action).toBe("policy");
    expect(d.policy?.billing).toBe(true);
  });
  test("plain 1006 → standard reconnect, no server hint", () => {
    const d = classifyClose(1006, "");
    expect(d.action).toBe("reconnect");
    expect(d.serverHintedDelay).toBe(0);
  });
  test("nonAuthPolicyCloseInfo recognizes reason strings", () => {
    expect(nonAuthPolicyCloseInfo(0, "too_many_connections")?.status).toBe("连接数超限");
    expect(nonAuthPolicyCloseInfo(0, "unauthorized_model")?.status).toBe("模型未开通");
    expect(nonAuthPolicyCloseInfo(1006, "")).toBeNull();
  });
  test("backoff 2/4/8/16/30s ladder + jitter cap", () => {
    expect(backoffDelay(0)).toBeGreaterThanOrEqual(2000);
    expect(backoffDelay(0)).toBeLessThan(3001);
    expect(backoffDelay(10)).toBeLessThan(31001); // capped 30s + jitter
  });
});

describe("onopenSetInitialStatus / bridge error", () => {
  test("non-empty offline queue shows 补发 not 已连接", () => {
    expect(onopenSetInitialStatus(3)).toEqual(["补发离线消息… (3)", "connecting"]);
    expect(onopenSetInitialStatus(0)).toEqual(["已连接", "connected"]);
  });
  test("normalize + friendly", () => {
    expect(normalizeBridgeErrorCode("ERR_INSUFFICIENT_CREDITS")).toBe("insufficient_credits");
    expect(friendlyBridgeErrorMessage("INSUFFICIENT_CREDITS")).toMatch(/余额不足/);
  });
});

describe("findOrCreateStreamingRow (§9 canonical id upsert)", () => {
  test("rebinds to existing same-id+role row", () => {
    const rows: ChatMessage[] = [{ id: "srv-1", role: "assistant", text: "x", ts: 0 }];
    const created = vi.fn();
    const r = findOrCreateStreamingRow(rows, "assistant", "srv-1", (o) => {
      created();
      return { id: o.id ?? "new", role: "assistant", text: "", ts: 0 } as ChatMessage;
    });
    expect(r).toBe(rows[0]);
    expect(created).not.toHaveBeenCalled();
  });
});

// ═══════════════ reducer: §7/§9/§11 ═══════════════
describe("applyOutboundMessage (§3/§7/§9/§11)", () => {
  test("text streaming accumulates into one assistant row", () => {
    const s = sess();
    applyOutboundMessage(s, msgFrame({ frameSeq: 1, blocks: [{ kind: "text", text: "Hel", messageId: "srv-1" }] }));
    applyOutboundMessage(s, msgFrame({ frameSeq: 2, blocks: [{ kind: "text", text: "lo", messageId: "srv-1" }] }));
    const asst = s.messages.filter((m) => m.role === "assistant");
    expect(asst).toHaveLength(1);
    expect(asst[0].text).toBe("Hello");
    expect(asst[0].id).toBe("srv-1");
  });

  test("frameSeq dedupe drops replayed dup (no double text)", () => {
    const s = sess();
    applyOutboundMessage(s, msgFrame({ frameSeq: 1, blocks: [{ kind: "text", text: "A", messageId: "srv-1" }] }));
    applyOutboundMessage(s, msgFrame({ frameSeq: 1, blocks: [{ kind: "text", text: "A", messageId: "srv-1" }] }));
    expect(s.messages.filter((m) => m.role === "assistant")[0].text).toBe("A");
  });

  test("per-sessionKey cursors are independent (multi-container parallel streams)", () => {
    const s = sess();
    // A 容器推到 frameSeq 5 并收尾（清流式指针）。
    applyOutboundMessage(s, msgFrame({ sessionKey: "agent:a:webchat:dm:s1", frameSeq: 5, isFinal: true, ts: 9e12, blocks: [{ kind: "text", text: "A", messageId: "srv-a" }] }));
    // B 容器从 frameSeq 1 起：用全局单游标会被 A 的 5 当 dup 丢掉；per-key 下必须被处理。
    applyOutboundMessage(s, msgFrame({ sessionKey: "agent:b:webchat:dm:s1", frameSeq: 1, blocks: [{ kind: "text", text: "B", messageId: "srv-b" }] }));
    expect(s.messages.find((m) => m.id === "srv-a")?.text).toBe("A");
    expect(s.messages.find((m) => m.id === "srv-b")?.text).toBe("B");
  });

  test("canonical id upsert across text→tool→text (no duplicate row)", () => {
    const s = sess();
    applyOutboundMessage(s, msgFrame({ frameSeq: 1, blocks: [{ kind: "text", text: "part1 ", messageId: "srv-1" }] }));
    applyOutboundMessage(s, msgFrame({ frameSeq: 2, blocks: [{ kind: "tool_use", toolName: "Read", blockId: "t1", partial: false, inputJson: {} }] }));
    applyOutboundMessage(s, msgFrame({ frameSeq: 3, blocks: [{ kind: "text", text: "part2", messageId: "srv-1" }] }));
    const asst = s.messages.filter((m) => m.role === "assistant" && m.id === "srv-1");
    expect(asst).toHaveLength(1);
    expect(asst[0].text).toBe("part1 part2");
  });

  test("tool partial→final: partialJson seeded then cleared on final", () => {
    const s = sess();
    applyOutboundMessage(s, msgFrame({ frameSeq: 1, blocks: [{ kind: "tool_use", toolName: "Edit", blockId: "t1", partial: true, partialJsonDelta: '{"a"', partialJsonOffset: 0 }] }));
    let tool = s.messages.find((m) => m.role === "tool" && m.blockId === "t1");
    expect(tool?.partialJson).toBe('{"a"');
    applyOutboundMessage(s, msgFrame({ frameSeq: 2, blocks: [{ kind: "tool_use", toolName: "Edit", blockId: "t1", partial: true, partialJsonDelta: ":1}", partialJsonOffset: 4 }] }));
    tool = s.messages.find((m) => m.role === "tool" && m.blockId === "t1");
    expect(tool?.partialJson).toBe('{"a":1}');
    applyOutboundMessage(s, msgFrame({ frameSeq: 3, blocks: [{ kind: "tool_use", toolName: "Edit", blockId: "t1", partial: false, inputJson: { a: 1 } }] }));
    tool = s.messages.find((m) => m.role === "tool" && m.blockId === "t1");
    expect(tool?.partialJson).toBeUndefined();
    expect(tool?.inputJson).toEqual({ a: 1 });
    expect(tool?._partial).toBe(false);
  });

  test("tool partial offset mismatch drops buffer (no torn JSON)", () => {
    const s = sess();
    applyOutboundMessage(s, msgFrame({ frameSeq: 1, blocks: [{ kind: "tool_use", toolName: "Edit", blockId: "t1", partial: true, partialJsonDelta: '{"a"', partialJsonOffset: 0 }] }));
    // wrong offset → drop
    applyOutboundMessage(s, msgFrame({ frameSeq: 2, blocks: [{ kind: "tool_use", toolName: "Edit", blockId: "t1", partial: true, partialJsonDelta: "X", partialJsonOffset: 99 }] }));
    const tool = s.messages.find((m) => m.role === "tool" && m.blockId === "t1");
    expect(tool?.partialJson).toBeUndefined();
  });

  test("tool_output_tail monotonic guard drops regressed totalBytes", () => {
    const s = sess();
    applyOutboundMessage(s, msgFrame({ frameSeq: 1, blocks: [{ kind: "tool_use", toolName: "Bash", blockId: "t1", partial: false, inputJson: {} }] }));
    applyOutboundMessage(s, msgFrame({ frameSeq: 2, blocks: [{ kind: "tool_output_tail", toolUseBlockId: "t1", tail: "100", totalBytes: 100, truncatedHead: false }] }));
    applyOutboundMessage(s, msgFrame({ frameSeq: 3, blocks: [{ kind: "tool_output_tail", toolUseBlockId: "t1", tail: "50", totalBytes: 50, truncatedHead: false }] }));
    const tool = s.messages.find((m) => m.role === "tool" && m.blockId === "t1");
    expect(tool?.bashTail?.totalBytes).toBe(100);
  });

  test("§11 stale-final predating bound user msg is dropped (no false teardown)", () => {
    const s = sess();
    const u = addMessage(s, "user", "hi", { status: "sent", ts: 1000 });
    s._replyingToMsgId = u.id;
    s._sendingInFlight = true;
    applyOutboundMessage(s, msgFrame({ frameSeq: 1, isFinal: true, ts: 500, blocks: [] }));
    expect(s._sendingInFlight).toBe(true); // dropped → no teardown
  });

  test("isFinal teardown clears _sendingInFlight + streaming pointers", () => {
    const s = sess();
    addMessage(s, "user", "hi", { status: "sent", ts: 1 });
    s._sendingInFlight = true;
    applyOutboundMessage(s, msgFrame({ frameSeq: 1, blocks: [{ kind: "text", text: "ok", messageId: "srv-1" }] }));
    applyOutboundMessage(s, msgFrame({ frameSeq: 2, isFinal: true, ts: 999999999999, blocks: [], meta: { stopReason: "end_turn" } }));
    expect(s._sendingInFlight).toBe(false);
    expect(s._streamingAssistant).toBeNull();
  });

  test("empty turn (end_turn, no answer) schedules ONE auto-continue", () => {
    const s = sess();
    const u = addMessage(s, "user", "hi", { status: "sent", ts: 1 });
    s._replyingToMsgId = u.id;
    s._sendingInFlight = true;
    const scheduleAutoContinue = vi.fn();
    const effects: FrameEffects = { scheduleAutoContinue };
    applyOutboundMessage(
      s,
      msgFrame({ frameSeq: 1, isFinal: true, ts: 999999999999, blocks: [{ kind: "thinking", text: "hmm", messageId: "srv-t" }], meta: { stopReason: "end_turn" } }),
      effects,
    );
    expect(scheduleAutoContinue).toHaveBeenCalledTimes(1);
    expect(scheduleAutoContinue.mock.calls[0][1]).toBe(u.id);
  });

  test("empty turn (max_tokens, no auto) inserts a notice", () => {
    const s = sess();
    const u = addMessage(s, "user", "hi", { status: "sent", ts: 1 });
    s._replyingToMsgId = u.id;
    s._sendingInFlight = true;
    applyOutboundMessage(
      s,
      msgFrame({ frameSeq: 1, isFinal: true, ts: 999999999999, blocks: [], meta: { stopReason: "max_tokens" } }),
      {},
    );
    expect(s.messages.some((m) => m._emptyTurn)).toBe(true);
  });

  test("delegate_progress start before delegate_task tool_use is adopted into one agent-group", () => {
    const s = sess();
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 1,
        blocks: [
          {
            kind: "delegate_progress",
            runId: "dlg-1",
            agentId: "hidden-reviewer",
            phase: "start",
            text: "开始委派给 hidden-reviewer: 审查草稿",
            goal: "审查草稿",
          },
        ],
      }),
    );
    expect(s.messages.filter((m) => m.role === "delegate-progress")).toHaveLength(1);

    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 2,
        blocks: [
          {
            kind: "tool_use",
            toolName: "delegate_task",
            blockId: "tool-1",
            partial: false,
            inputJson: { agentId: "hidden-reviewer", goal: "审查草稿" },
          },
        ],
      }),
    );

    const groups = s.messages.filter((m) => m.role === "agent-group");
    expect(groups).toHaveLength(1);
    expect(groups[0]._delegateRunId).toBe("dlg-1");
    expect(s.messages.filter((m) => m.role === "delegate-progress")).toHaveLength(0);
  });

  test("Codex native Agent tool_use preserves OpenClaude team fallback origin fields", () => {
    const s = sess();
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 1,
        blocks: [
          {
            kind: "tool_use",
            toolName: "Agent",
            blockId: "spawn-1",
            partial: false,
            inputJson: {
              description: "inspect repo",
              openclaudeOrigin: "codex-collab",
              openclaudeTeamFallback: true,
            },
          },
        ],
      }),
    );

    const group = s.messages.find((m) => m.role === "agent-group");
    expect(group?.text).toBe("inspect repo");
    expect(group?._delegate).toBeUndefined();
    expect(group?._agentGroupOrigin).toBe("codex-collab");
    expect(group?._teamFallback).toBe(true);
  });

  test("adopted delegate_progress preserves completed summary on the group", () => {
    const s = sess();
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 1,
        blocks: [
          {
            kind: "delegate_progress",
            runId: "dlg-2",
            agentId: "hidden-reviewer",
            phase: "start",
            text: "开始委派给 hidden-reviewer: 审查草稿",
            goal: "审查草稿",
          },
        ],
      }),
    );
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 2,
        blocks: [{ kind: "delegate_progress", runId: "dlg-2", agentId: "hidden-reviewer", phase: "done", text: "PASS" }],
      }),
    );
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 3,
        blocks: [
          {
            kind: "tool_use",
            toolName: "delegate_task",
            blockId: "tool-2",
            partial: false,
            inputJson: { agentId: "hidden-reviewer", goal: "审查草稿" },
          },
        ],
      }),
    );

    const group = s.messages.find((m) => m.role === "agent-group");
    expect(group?._delegateRunId).toBe("dlg-2");
    expect(group?._resultPreview).toBe("PASS");
    expect(s.messages.some((m) => m.role === "delegate-progress")).toBe(false);
  });

  test("delegate_task tool_use before progress nests child output into same group", () => {
    const s = sess();
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 1,
        blocks: [
          {
            kind: "tool_use",
            toolName: "delegate_task",
            blockId: "tool-3",
            partial: false,
            inputJson: { agentId: "hidden-reviewer", goal: "审查草稿" },
          },
        ],
      }),
    );
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 2,
        blocks: [
          {
            kind: "delegate_progress",
            runId: "dlg-3",
            agentId: "hidden-reviewer",
            phase: "start",
            text: "开始委派给 hidden-reviewer: 审查草稿",
            goal: "审查草稿",
          },
        ],
      }),
    );
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 3,
        blocks: [
          {
            kind: "delegate_progress",
            runId: "dlg-3",
            agentId: "hidden-reviewer",
            phase: "text",
            text: "child output",
            block: { kind: "text", text: "child output" },
          },
        ],
      }),
    );

    const groups = s.messages.filter((m) => m.role === "agent-group");
    expect(groups).toHaveLength(1);
    expect(groups[0]._delegateRunId).toBe("dlg-3");
    expect(groups[0].childBlocks?.some((b) => b.kind === "text" && b.text === "child output")).toBe(true);
    expect(s.messages.some((m) => m.role === "delegate-progress")).toBe(false);
  });

  test("legacy non-start delegate_progress entries stay standalone instead of being dropped", () => {
    const s = sess();
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 1,
        blocks: [
          {
            kind: "delegate_progress",
            runId: "dlg-4",
            agentId: "hidden-reviewer",
            phase: "start",
            text: "开始委派给 hidden-reviewer: 审查草稿",
            goal: "审查草稿",
          },
        ],
      }),
    );
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 2,
        blocks: [{ kind: "delegate_progress", runId: "dlg-4", agentId: "hidden-reviewer", phase: "text", text: "legacy output" }],
      }),
    );
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 3,
        blocks: [
          {
            kind: "tool_use",
            toolName: "delegate_task",
            blockId: "tool-4",
            partial: false,
            inputJson: { agentId: "hidden-reviewer", goal: "审查草稿" },
          },
        ],
      }),
    );

    expect(s.messages.filter((m) => m.role === "agent-group")).toHaveLength(1);
    const standalone = s.messages.find((m) => m.role === "delegate-progress");
    expect(standalone?.entries?.some((e) => e.phase === "text" && e.text === "legacy output")).toBe(true);
  });

  test("mixed legacy entries and rich child blocks stay standalone to avoid dropping entries", () => {
    const s = sess();
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 1,
        blocks: [
          {
            kind: "delegate_progress",
            runId: "dlg-5",
            agentId: "hidden-reviewer",
            phase: "start",
            text: "开始委派给 hidden-reviewer: 审查草稿",
            goal: "审查草稿",
          },
        ],
      }),
    );
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 2,
        blocks: [{ kind: "delegate_progress", runId: "dlg-5", agentId: "hidden-reviewer", phase: "text", text: "legacy output" }],
      }),
    );
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 3,
        blocks: [
          {
            kind: "delegate_progress",
            runId: "dlg-5",
            agentId: "hidden-reviewer",
            phase: "text",
            text: "rich output",
            block: { kind: "text", text: "rich output" },
          },
        ],
      }),
    );
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 4,
        blocks: [
          {
            kind: "tool_use",
            toolName: "delegate_task",
            blockId: "tool-5",
            partial: false,
            inputJson: { agentId: "hidden-reviewer", goal: "审查草稿" },
          },
        ],
      }),
    );

    const group = s.messages.find((m) => m.role === "agent-group");
    const standalone = s.messages.find((m) => m.role === "delegate-progress");
    expect(group?._delegateRunId).toBeUndefined();
    expect(standalone?.entries?.some((e) => e.phase === "text" && e.text === "legacy output")).toBe(true);
    expect(standalone?.childBlocks?.some((b) => b.kind === "text" && b.text === "rich output")).toBe(true);
  });
});

describe("applyOutboundError double-frame suppression (§11)", () => {
  test("[error] text isFinal at suppressed seq does not add a second bubble", () => {
    const s = sess();
    addMessage(s, "user", "hi", { status: "sent", ts: 1 });
    s._sendingInFlight = true;
    applyOutboundError(s, { type: "outbound.error", sessionKey: "k", channel: "webchat", peer: { id: "s1", kind: "dm" }, code: "insufficient_credits", message: "no credits", isFinal: false, frameSeq: 5 } as never);
    expect(s.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(s._suppressErrorBubbleAtSeq).toBe(6);
    // following [error] text isFinal at seq 6 → suppressed bubble, still teardown.
    applyOutboundMessage(s, msgFrame({ frameSeq: 6, isFinal: true, ts: 999999999999, blocks: [{ kind: "text", text: "[error] no credits" }] }));
    expect(s.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(s._sendingInFlight).toBe(false);
  });

  test("未知错误码 + 无 detail:主文案友好通用,原始 message 仍落 _errorDetail(不丢)", () => {
    const s = sess();
    applyOutboundError(s, { type: "outbound.error", sessionKey: "k", channel: "webchat", peer: { id: "s1", kind: "dm" }, code: "some_new_code", message: "server shutting down", isFinal: true } as never);
    const err = s.messages.filter((m) => m.role === "assistant").at(-1)!;
    expect(err.text).toBe("系统暂时不可用，请稍后重试。"); // 友好通用,不抛裸英文
    expect(err._errorDetail).toBe("server shutting down"); // 原始信息进查看详情,Codex 审防丢失
  });
});

describe("applyCostWaived (turn 免单退款)", () => {
  test("命中最近一条已扣费助手消息 → 减额 + waived 标记 + 刷余额", () => {
    const s = sess();
    const a = addMessage(s, "assistant", "半截", { ts: 1, usage: { costCredits: "11" } });
    const refreshBalance = vi.fn();
    applyCostWaived(s, { type: "outbound.cost_waived", sessionId: "x", refundedCredits: "11", balanceAfter: "100" }, { refreshBalance });
    expect(a.usage?.costCredits).toBe("0");
    expect(a.usage?.waived).toBe(true);
    expect(refreshBalance).toHaveBeenCalledTimes(1);
  });
  test("退款先抵扣 _pendingCostCredits,余量再落消息", () => {
    const s = sess();
    const a = addMessage(s, "assistant", "半截", { ts: 1, usage: { costCredits: "5" } });
    s._pendingCostCredits = "6";
    applyCostWaived(s, { type: "outbound.cost_waived", refundedCredits: "11" }, {});
    expect(s._pendingCostCredits).toBe("0");
    expect(a.usage?.costCredits).toBe("0");
    expect(a.usage?.waived).toBe(true);
  });
  test("无 session / 非法金额 → 只刷余额,不崩", () => {
    const refreshBalance = vi.fn();
    applyCostWaived(null, { type: "outbound.cost_waived", refundedCredits: "x", balanceAfter: "1" }, { refreshBalance });
    expect(refreshBalance).toHaveBeenCalledTimes(1);
    const s = sess();
    applyCostWaived(s, { type: "outbound.cost_waived", refundedCredits: "-5" }, {});
    expect(s._pendingCostCredits).toBe("0");
  });
});

describe("applyCostCharged (§3 NOT deduped; 归因严格)", () => {
  test("target with usage → accumulate (multi-API turn)", () => {
    const s = sess();
    const a = addMessage(s, "assistant", "ans", { ts: 1, usage: {} });
    s._streamingAssistant = a;
    applyCostCharged(s, { type: "outbound.cost_charged", sessionId: "s1", costCredits: "10", balanceAfter: "90" }, {});
    applyCostCharged(s, { type: "outbound.cost_charged", sessionId: "s1", costCredits: "10", balanceAfter: "80" }, {});
    expect(a.usage?.costCredits).toBe("20");
  });
  test("target without usage (mid-turn) → enqueue _pendingCostCredits, NOT written to row", () => {
    const s = sess();
    const a = addMessage(s, "assistant", "", { ts: 1 }); // no usage yet
    s._streamingAssistant = a;
    applyCostCharged(s, { type: "outbound.cost_charged", sessionId: "s1", costCredits: "15" }, {});
    expect(a.usage).toBeUndefined();
    expect(s._pendingCostCredits).toBe("15");
  });
  test("NO target 且 turn 未进行（turn 间晚到）→ DROP, only refreshBalance (no cross-turn pollution)", () => {
    const s = sess();
    const refreshBalance = vi.fn();
    // _sendingInFlight 默认 false → 不入队（避免错算到下一 turn）。
    applyCostCharged(s, { type: "outbound.cost_charged", sessionId: "s1", costCredits: "99", balanceAfter: "1" }, { refreshBalance });
    expect(s._pendingCostCredits).toBe("0"); // turn 间不 enqueue
    expect(refreshBalance).toHaveBeenCalledTimes(1);
  });
  test("NO target 但 turn 进行中（委派 cost 在子状态间到达）→ enqueue pending，不丢", () => {
    const s = sess();
    s._sendingInFlight = true; // 队长等子智能体：无 streamingAssistant，但本 turn 在飞
    applyCostCharged(s, { type: "outbound.cost_charged", sessionId: "s1", costCredits: "7" }, {});
    applyCostCharged(s, { type: "outbound.cost_charged", sessionId: "s1", costCredits: "3" }, {});
    expect(s._pendingCostCredits).toBe("10"); // 累加，待收尾 flush 到本轮响应
  });
  test("isFinal: 兜底 flush pending cost 到本轮最后一条助手消息（无 streamingAssistant 时）", () => {
    const s = sess();
    const a = addMessage(s, "assistant", "汇总", { ts: 1, usage: { traceId: "t1" } });
    s._sendingInFlight = true;
    s._pendingCostCredits = "20"; // turn 内入队、未被 meta-drain（收尾帧无 meta / 无流式助手）
    applyOutboundMessage(s, msgFrame({ isFinal: true }));
    expect(a.usage?.costCredits).toBe("20"); // flush 到响应 → 徽章可见
    expect(s._pendingCostCredits).toBe("0"); // 清零防泄漏到下一 turn
  });
  test("isFinal 兜底 flush 不跨轮：本轮无 assistant 时 pending 不落到上一轮 assistant", () => {
    const s = sess();
    const prev = addMessage(s, "assistant", "上一轮", { ts: 1, usage: { costCredits: "5" } });
    addMessage(s, "user", "本轮提问", { ts: 2 }); // 本轮起点；本轮只有 tool/thinking、无 assistant 汇总
    s._sendingInFlight = true;
    s._pendingCostCredits = "20";
    applyOutboundMessage(s, msgFrame({ isFinal: true }));
    expect(prev.usage?.costCredits).toBe("5"); // 上一轮 assistant 不被错算（不跨 turn）
    expect(s._pendingCostCredits).toBe("0"); // 本轮无响应可落 → 丢展示、清零防泄漏
  });
});

describe("applyResumeFailed (§4 layer 3)", () => {
  test("advances cursor to server currentLast, flags broken, forces sync", () => {
    const s = sess();
    const forceSync = vi.fn();
    applyResumeFailed(s, { type: "outbound.resume_failed", sessionKey: "agent:main:webchat:dm:s1", channel: "webchat", peer: { id: "s1", kind: "dm" }, from: 0, to: 42, reason: "buffer_miss" } as never, { forceSync });
    expect(s._lastFrameSeqByKey?.["agent:main:webchat:dm:s1"]).toBe(42);
    expect(s._liveStreamBroken).toBe(true);
    expect(forceSync).toHaveBeenCalledWith("s1");
  });
});

// ═══════════════ §2 safeWsSend 背压 + §10 离线入队（ChatSocket）═══════════════
class FakeWS {
  static instances: FakeWS[] = [];
  static OPEN = 1;
  url: string;
  protocols?: string | string[];
  readyState = 0;
  bufferedAmount = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed?: { code: number; reason: string };
  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    FakeWS.instances.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close(code: number, reason: string) {
    this.closed = { code, reason };
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
}

function makeSocket() {
  return new ChatSocket({
    getToken: () => "tok",
    silentRefresh: async () => null,
    onAuthExpired: () => {},
    defaultAgentId: "main",
  });
}

describe("ChatSocket safeWsSend backpressure (§2) + offline enqueue (§10)", () => {
  afterEach(() => {
    FakeWS.instances = [];
    vi.unstubAllGlobals();
  });

  test("send while ws OPEN → ws.send called, msg sent, in-flight", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true); // connect
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "hi" });
    const inbound = ws.sent.find((d) => d.includes('"inbound.message"'));
    expect(inbound).toBeTruthy();
    const s = sock.sessions.get("s1")!;
    expect(s._sendingInFlight).toBe(true);
    expect(s.messages.find((m) => m.role === "user")?.status).toBe("sent");
  });

  test("bufferedAmount ≥ 2MB → close(4000) + requeue offline (no silent drop)", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    ws.bufferedAmount = 3 * 1024 * 1024; // 背压超阈值
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "hi" });
    expect(ws.closed?.code).toBe(4000); // 主动 close 触发自愈链
    // 用户消息进离线队列（保序补发），UI 标 queued —— 绝不静默丢失。
    expect(sock.offlineQueue.length).toBe(1);
    expect(sock.sessions.get("s1")!.messages.find((m) => m.role === "user")?.status).toBe("queued");
  });

  test("ws not OPEN (connecting) → message enqueued offline, status queued", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true); // ws in CONNECTING(0)
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "hi" });
    expect(sock.offlineQueue.length).toBe(1);
    expect(sock.sessions.get("s1")!.messages.find((m) => m.role === "user")?.status).toBe("queued");
  });

  test("onclose requeues in-flight drain items at head, preserving order (§10)", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    // 离线两条 → close 前都在 queue。
    ws.bufferedAmount = 3 * 1024 * 1024;
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "one" });
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "two" });
    expect(sock.offlineQueue.map((i) => i.payload.content.text)).toEqual(["one", "two"]);
  });
});

// ═══════════════ 鉴权契约：bearer 子协议（非 ?token= 非 header，§auth）═══════════════
describe("ChatSocket bearer subprotocol auth (#4)", () => {
  afterEach(() => {
    FakeWS.instances = [];
    vi.unstubAllGlobals();
  });

  test("connects with Sec-WebSocket-Protocol ['bearer', token], no token in URL", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true); // 触发 connect
    const ws = FakeWS.instances.at(-1)!;
    // 鉴权走子协议数组，绝不 ?token= / 绝不 header。
    expect(ws.protocols).toEqual(["bearer", "tok"]);
    expect(ws.url).not.toContain("tok");
    expect(ws.url).not.toContain("token");
    expect(ws.url.endsWith("/ws/user-chat-bridge")).toBe(true);
  });
});

// ═══════════════ §5 close 4503 server-hinted 退避（无 12 分钟死循环）═══════════════
describe("ChatSocket 4503 server-hinted reconnect (no 12-min loop)", () => {
  afterEach(() => {
    FakeWS.instances = [];
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test("4503+retryAfterSec schedules a single reconnect at the hinted delay (self-heals)", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    expect(FakeWS.instances.length).toBe(1);
    // 4503 provisioning + retryAfterSec=5 → clamp ~5s（不走纯指数爆炸 / 不死等）。
    ws.close(4503, JSON.stringify({ retryAfterSec: 5, reason: "provisioning" }));
    // 提示延迟前不应重连。
    vi.advanceTimersByTime(4000);
    expect(FakeWS.instances.length).toBe(1);
    // 越过 5s+jitter(≤500ms) 后必然重连一次（创建新 ws 实例）。
    vi.advanceTimersByTime(2000);
    expect(FakeWS.instances.length).toBe(2);
  });
});

// ═══════════════ §7 auto-continue 确定性 idempotencyKey（dedup 对账）═══════════════
describe("ChatSocket auto-continue deterministic idempotencyKey (#3)", () => {
  afterEach(() => {
    FakeWS.instances = [];
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test("empty end_turn drives auto-continue with idem autocont-<sessId>-<targetMsgId>", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "hi" });
    const userMsg = sock.sessions.get("s1")!.messages.find((m) => m.role === "user")!;
    // server 推空轮 end_turn final（无 answer 块）→ 应触发一次自动续写。
    ws.onmessage?.({
      data: JSON.stringify({
        type: "outbound.message",
        sessionKey: "agent:main:webchat:dm:s1",
        channel: "webchat",
        peer: { id: "s1", kind: "dm" },
        frameSeq: 1,
        isFinal: true,
        ts: 9e12,
        blocks: [],
        meta: { stopReason: "end_turn" },
      }),
    });
    vi.advanceTimersByTime(10); // 跑 deferred setTimeout(0) 的 auto-continue
    const autocont = ws.sent
      .map((d) => JSON.parse(d))
      .find((p) => typeof p.idempotencyKey === "string" && p.idempotencyKey.startsWith("autocont-"));
    expect(autocont).toBeTruthy();
    expect(autocont.idempotencyKey).toBe(`autocont-s1-${userMsg.id}`);
    // 确定性：同 (sessId,targetMsgId) 再算一次必得同 key（跨 tab/replay 可被 server dedup）。
    expect(autocont.idempotencyKey).toBe(`autocont-s1-${userMsg.id}`);
  });
});

describe("resume_failed 游标只进不退(master 重启空 ring 防御)", () => {
  test("to 小于当前游标时不回退(容器随后重放的帧不被误判重复/状态不被重置)", () => {
    const s = sess();
    applyResumeFailed(s, { type: "outbound.resume_failed", sessionKey: "agent:main:webchat:dm:s1", channel: "webchat", peer: { id: "s1", kind: "dm" }, from: 0, to: 42, reason: "buffer_miss" } as never, {});
    expect(s._lastFrameSeqByKey?.["agent:main:webchat:dm:s1"]).toBe(42);
    // 重启后的陈旧信号 to=0 → 游标不动
    applyResumeFailed(s, { type: "outbound.resume_failed", sessionKey: "agent:main:webchat:dm:s1", channel: "webchat", peer: { id: "s1", kind: "dm" }, from: 0, to: 0, reason: "no_buffer" } as never, {});
    expect(s._lastFrameSeqByKey?.["agent:main:webchat:dm:s1"]).toBe(42);
  });
});
