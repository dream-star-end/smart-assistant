/**
 * 轮次分段抽象单测:currentTurnStartIndex(活跃段起点)+ turnFinalAssistantFlags(每轮末条
 * assistant 正文 = 评价反馈行唯一可见位)+ currentTurnSettled(当前轮收口的消息层证据判据,
 * PinnedTaskTracker HUD 隐藏门)。三者共用「user 消息开启新轮」这一轮边界权威。
 */
import { describe, expect, test } from "vitest";
import type { ChatMessage } from "../../lib/chat/model";
import { currentTurnSettled, currentTurnStartIndex, splitStoppedNarration, turnFinalAssistantFlags } from "./turnSegment";

function mk(role: ChatMessage["role"], extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id: Math.random().toString(36), role, text: "", ts: 1000, ...extra };
}
/** 从布尔数组取被标记为「轮末条」的下标,便于断言。 */
const finals = (msgs: ChatMessage[]): number[] =>
  turnFinalAssistantFlags(msgs).flatMap((f, i) => (f ? [i] : []));

describe("currentTurnStartIndex", () => {
  test("最后一条 user 之后为活跃段起点;无 user → 0", () => {
    expect(currentTurnStartIndex([mk("user"), mk("assistant", { text: "a" })])).toBe(1);
    expect(currentTurnStartIndex([mk("assistant", { text: "a" }), mk("tool")])).toBe(0);
  });
});

describe("turnFinalAssistantFlags(评价行轮末条判定)", () => {
  test("错序数组仍按 _clientMessageId 分组，为每个真实 turn 各锚一条评分卡", () => {
    const u1 = mk("user", { id: "m-u1", text: "轮1", _orderSeq: 1 });
    const u2 = mk("user", { id: "m-u2", text: "轮2", _orderSeq: 3 });
    const a1 = mk("assistant", {
      id: "srv-a1",
      text: "答1",
      _clientMessageId: u1.id,
      _orderSeq: 2,
    });
    const a2 = mk("assistant", {
      id: "srv-a2",
      text: "答2",
      _clientMessageId: u2.id,
      _orderSeq: 4,
    });
    expect(finals([u1, u2, a1, a2])).toEqual([2, 3]);
  });

  test("同一 _clientMessageId 的多段正文按 _orderSeq 选择末段而非数组末项", () => {
    const msgs = [
      mk("user", { id: "m-u1", text: "问", _orderSeq: 1 }),
      mk("assistant", { text: "末段", _clientMessageId: "m-u1", _orderSeq: 3 }),
      mk("assistant", { text: "中段", _clientMessageId: "m-u1", _orderSeq: 2 }),
    ];
    expect(finals(msgs)).toEqual([1]);
  });

  test("一轮多段正文 + 穿插工具卡 → 只标最后一段正文,中间段不标", () => {
    const msgs = [
      mk("user", { text: "问" }),
      mk("assistant", { text: "第一段" }), // idx1 中间
      mk("tool", { toolName: "Bash", _completed: true }),
      mk("assistant", { text: "第二段" }), // idx3 末条
    ];
    expect(finals(msgs)).toEqual([3]);
  });

  test("历史多轮 → 每轮末条各自被标(不是全会话末条)", () => {
    const msgs = [
      mk("user", { text: "轮1" }),
      mk("assistant", { text: "轮1中间" }), // idx1
      mk("assistant", { text: "轮1末尾" }), // idx2 轮1末条
      mk("user", { text: "轮2" }),
      mk("assistant", { text: "轮2末尾" }), // idx4 轮2末条
    ];
    expect(finals(msgs)).toEqual([2, 4]);
  });

  test("团队模式:委派卡(agent-group)/思考卡不算正文,末条仍落在队长最后一段文本上", () => {
    const msgs = [
      mk("user", { text: "组队" }),
      mk("assistant", { text: "队长文本回答" }), // idx1 = 唯一正文 → 末条
      mk("thinking", { text: "思考" }),
      mk("agent-group", { text: "委派A", _delegate: true }),
      mk("agent-group", { text: "委派B", _delegate: true }),
    ];
    // 末条正文是队长文本(idx1),其后的思考/委派卡不影响判定。
    expect(finals(msgs)).toEqual([1]);
  });

  test("末条为 error 的轮 → error 不算正文,退回该轮上一条真正正文", () => {
    const msgs = [
      mk("user", { text: "问" }),
      mk("assistant", { text: "好的答复" }), // idx1
      mk("assistant", { text: "服务重启", _errorCode: "service_restart" }), // 非正文
    ];
    expect(finals(msgs)).toEqual([1]);
  });

  test("空正文 / 纯空白 assistant 不算正文", () => {
    const msgs = [
      mk("user", { text: "问" }),
      mk("assistant", { text: "   " }), // 纯空白 → 非正文
      mk("assistant", { text: "真答复" }), // idx2 末条
    ];
    expect(finals(msgs)).toEqual([2]);
  });

  test("无 user(如 cron 推送流)整体视为一段,仍标其末条正文", () => {
    const msgs = [
      mk("assistant", { text: "推送A" }), // idx0
      mk("tool", { _completed: true }),
      mk("assistant", { text: "推送B" }), // idx2 末条
    ];
    expect(finals(msgs)).toEqual([2]);
  });

  test("整轮无正文(只工具/委派)→ 无末条标记(无可评内容)", () => {
    const msgs = [
      mk("user", { text: "问" }),
      mk("tool", { _completed: true }),
      mk("agent-group", { text: "委派", _delegate: true }),
    ];
    expect(finals(msgs)).toEqual([]);
  });
});

describe("currentTurnSettled(HUD 收口判据,消息层证据)", () => {
  test("user 行 status=replied → 收口", () => {
    expect(
      currentTurnSettled([
        mk("user", { text: "问", status: "replied" }),
        mk("tool", { toolName: "TodoWrite" }),
      ]),
    ).toBe(true);
  });

  test("user 行 status=error → 收口", () => {
    expect(currentTurnSettled([mk("user", { text: "问", status: "error" })])).toBe(true);
  });

  test("段内 _turnTapeComplete=true → 收口", () => {
    expect(
      currentTurnSettled([
        mk("user", { text: "问", status: "sent" }),
        mk("assistant", { text: "答", _turnTapeComplete: true }),
      ]),
    ).toBe(true);
  });

  test("段内 _turnStatusRecord / _dispatchTerminal / 非空 _errorCode → 收口", () => {
    expect(
      currentTurnSettled([mk("user", { status: "sent" }), mk("assistant", { _turnStatusRecord: true })]),
    ).toBe(true);
    expect(
      currentTurnSettled([mk("user", { status: "sent" }), mk("assistant", { _dispatchTerminal: true })]),
    ).toBe(true);
    expect(
      currentTurnSettled([mk("user", { status: "sent" }), mk("assistant", { _errorCode: "service_restart" })]),
    ).toBe(true);
    // 空串 errorCode 不算证据
    expect(currentTurnSettled([mk("user", { status: "sent" }), mk("assistant", { _errorCode: "" })])).toBe(false);
  });

  test("段内过程控制折叠锚终态证据(_turnTapeProcess + 终态 outcome)→ 收口;非终态 outcome 不算", () => {
    expect(
      currentTurnSettled([
        mk("user", { status: "sent" }),
        mk("assistant", { _turnTapeProcess: true, _dispatchOutcome: "completed" }),
      ]),
    ).toBe(true);
    expect(
      currentTurnSettled([
        mk("user", { status: "sent" }),
        mk("assistant", { _turnTapeProcess: true, _dispatchOutcome: "working" }),
      ]),
    ).toBe(false);
  });

  test("无任何终态证据(user 行 sent、段内无标记)→ 未收口(刷新后仍在飞,HUD 继续钉住)", () => {
    expect(
      currentTurnSettled([
        mk("user", { text: "问", status: "sent" }),
        mk("tool", { toolName: "TodoWrite", _completed: true }),
        mk("assistant", { text: "部分产出" }),
      ]),
    ).toBe(false);
  });

  test("无 user 行(cron 推送流)→ 只看段内证据", () => {
    expect(currentTurnSettled([mk("assistant", { text: "推送", _turnTapeComplete: true })])).toBe(true);
    expect(currentTurnSettled([mk("assistant", { text: "推送" }), mk("tool", { _completed: true })])).toBe(false);
  });

  test("旧轮的终态证据不污染当前轮:上一轮 replied,当前轮无证据 → 未收口", () => {
    expect(
      currentTurnSettled([
        mk("user", { id: "u1", text: "旧问", status: "replied" }),
        mk("assistant", { text: "旧答", _turnTapeComplete: true }),
        mk("user", { id: "u2", text: "新问", status: "sent" }),
        mk("tool", { toolName: "TodoWrite", _completed: true }),
      ]),
    ).toBe(false);
  });
});

// OCV5-459: session webmvawsvz2zkzoxm (Grok, stopped after 86 steps). The tape stamped USER_CANCELLED on
// the last narration (s4); 29 tool/thinking rows ran after it. s3 became the "answer" with a timestamp and
// s4 sat below it with 已停止生成.
describe("stopped turn narration (OCV5-459)", () => {
  const tapeStop = (): ChatMessage[] => [
    mk("user", { id: "u", text: "问", _orderSeq: 1 }),
    mk("assistant", { id: "s3", text: "请求在平台说明处被截断了。", _clientMessageId: "u", _orderSeq: 2, ts: 2000 }),
    mk("tool", { id: "t1", toolName: "Bash", _completed: true, _clientMessageId: "u", _orderSeq: 3, ts: 3000 }),
    mk("assistant", {
      id: "s4",
      text: "原始提示还在临时文件里，我直接看结尾。",
      _clientMessageId: "u",
      _orderSeq: 4,
      ts: 4000,
      _errorCode: "USER_CANCELLED",
      _errorDetail: "本轮已由用户停止。",
      _timelineUnitKey: "unit-s4",
      usage: { traceId: "trace-s4" },
    }),
    mk("thinking", { id: "k1", text: "看结尾", _clientMessageId: "u", _orderSeq: 5, ts: 5000 }),
    mk("tool", { id: "t2", toolName: "Bash", _completed: true, cancelled: true, _clientMessageId: "u", _orderSeq: 6, ts: 6000 }),
  ];

  test("tape stamp on narration splits into a plain narration row and a trailing stop row", () => {
    const out = splitStoppedNarration(tapeStop());
    expect(out.map((m) => m.id)).toEqual(["u", "s3", "t1", "s4", "k1", "t2", "s4:stopped"]);
    const narration = out[3]!;
    expect(narration.text).toBe("原始提示还在临时文件里，我直接看结尾。");
    expect(narration._errorCode).toBeUndefined();
    expect(narration.usage).toBeUndefined();
    expect(narration._timelineUnitKey).toBe("unit-s4");
    const stop = out[6]!;
    expect(stop.text).toBe("");
    expect(stop._errorCode).toBe("USER_CANCELLED");
    expect(stop.usage?.traceId).toBe("trace-s4");
    expect(stop._timelineUnitKey).toBe("unit-s4:stopped");
    expect(stop.ts).toBe(6000);
    // r2: the stop row keeps copy / more; copy takes the stamped narration.
    expect(stop._stopCopyText).toBe("原始提示还在临时文件里，我直接看结尾。");
    expect(narration._stopCopyText).toBeUndefined();
  });

  test("after the split the stopped turn has no answer, so no narration leaves the steps", () => {
    expect(finals(splitStoppedNarration(tapeStop()))).toEqual([]);
    // Unsplit (useResponseRatings reads raw rows): s3 is not promoted either.
    expect(finals(tapeStop())).toEqual([]);
  });

  test("live stop row: the last narration followed by steps is not the answer", () => {
    const msgs = [
      mk("user", { id: "u", text: "问" }),
      mk("assistant", { id: "n1", text: "我先读请求", _clientMessageId: "u" }),
      mk("tool", { id: "t1", toolName: "Bash", _completed: true, _clientMessageId: "u" }),
      mk("assistant", { id: "n2", text: "再看结尾", _clientMessageId: "u" }),
      mk("tool", { id: "t2", toolName: "Bash", _completed: true, cancelled: true, _clientMessageId: "u" }),
      mk("assistant", { id: "stop", text: "本轮已取消。", _clientMessageId: "u", _errorCode: "user_cancelled" }),
    ];
    expect(finals(msgs)).toEqual([]);
  });

  test("live stop row keeps copy / more: copy takes the turn's last text, rows stay in place", () => {
    const msgs = [
      mk("user", { id: "u", text: "问" }),
      mk("assistant", { id: "n1", text: "我先读请求", _clientMessageId: "u" }),
      mk("tool", { id: "t1", toolName: "Bash", _completed: true, _clientMessageId: "u" }),
      mk("assistant", { id: "n2", text: "再看结尾", _clientMessageId: "u" }),
      mk("tool", { id: "t2", toolName: "Bash", _completed: true, cancelled: true, _clientMessageId: "u" }),
      mk("assistant", { id: "stop", text: "本轮已取消。", _clientMessageId: "u", _errorCode: "user_cancelled" }),
    ];
    const out = splitStoppedNarration(msgs);
    expect(out.map((m) => m.id)).toEqual(["u", "n1", "t1", "n2", "t2", "stop"]);
    expect(out[5]!._stopCopyText).toBe("再看结尾");
    expect(out[5]!.text).toBe("本轮已取消。");
    expect(msgs[5]!._stopCopyText).toBeUndefined();
  });

  test("a stop before any text has nothing to copy", () => {
    const msgs = [
      mk("user", { id: "u", text: "问" }),
      mk("tool", { id: "t1", toolName: "Bash", _completed: true, cancelled: true, _clientMessageId: "u" }),
      mk("assistant", { id: "stop", text: "本轮已取消。", _clientMessageId: "u", _errorCode: "user_cancelled" }),
    ];
    expect(splitStoppedNarration(msgs)).toBe(msgs);
  });

  test("stopped mid-answer: text with no step after it stays the answer, stamp is not split", () => {
    const tape = [
      mk("user", { id: "u", text: "问" }),
      mk("tool", { id: "t1", toolName: "Bash", _completed: true, _clientMessageId: "u" }),
      mk("assistant", { id: "a", text: "答案的前半段", _clientMessageId: "u", _errorCode: "USER_CANCELLED" }),
    ];
    expect(splitStoppedNarration(tape)).toBe(tape);
    const live = [
      mk("user", { id: "u", text: "问" }),
      mk("tool", { id: "t1", toolName: "Bash", _completed: true, _clientMessageId: "u" }),
      mk("assistant", { id: "a", text: "答案的前半段", _clientMessageId: "u" }),
      mk("assistant", { id: "stop", text: "本轮已取消。", _clientMessageId: "u", _errorCode: "user_cancelled" }),
    ];
    expect(finals(live)).toEqual([2]);
  });

  test("a turn that was not stopped keeps its last text as the answer even with a late step", () => {
    const msgs = [
      mk("user", { id: "u", text: "问" }),
      mk("assistant", { id: "a", text: "答", _clientMessageId: "u" }),
      mk("plan", { id: "p", _clientMessageId: "u" }),
    ];
    expect(finals(msgs)).toEqual([1]);
  });

  test("a stop in another turn does not touch this turn", () => {
    const msgs = [
      mk("user", { id: "u1", text: "问1" }),
      mk("assistant", { id: "a1", text: "答1", _clientMessageId: "u1" }),
      mk("plan", { id: "p1", _clientMessageId: "u1" }),
      mk("user", { id: "u2", text: "问2" }),
      mk("assistant", { id: "n2", text: "先看看", _clientMessageId: "u2" }),
      mk("tool", { id: "t2", toolName: "Bash", _completed: true, _clientMessageId: "u2" }),
      mk("assistant", { id: "stop", text: "", _clientMessageId: "u2", _errorCode: "user_cancelled" }),
    ];
    expect(finals(msgs)).toEqual([1]);
  });
});
