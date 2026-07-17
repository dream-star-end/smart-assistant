/**
 * 轮次分段抽象单测:currentTurnStartIndex(活跃段起点)+ turnFinalAssistantFlags(每轮末条
 * assistant 正文 = 评价反馈行唯一可见位)。两者共用「user 消息开启新轮」这一轮边界权威。
 */
import { describe, expect, test } from "vitest";
import type { ChatMessage } from "../../lib/chat/model";
import { currentTurnStartIndex, turnFinalAssistantFlags } from "./turnSegment";

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
