import { describe, expect, test } from "vitest";
import type { ChatMessage } from "../../lib/chat/model";
import { findMatches, locateFindMatch, stepMatch, timelineMessageKey } from "./findInSession";

function mk(over: Partial<ChatMessage> & Pick<ChatMessage, "id" | "role">): ChatMessage {
  return { text: "", ts: 1, ...over };
}

describe("timelineMessageKey", () => {
  test("优先 _timelineUnitKey，否则 id，空则 single-missing", () => {
    expect(timelineMessageKey({ id: "m1", _timelineUnitKey: "unit:1" })).toBe("unit:1");
    expect(timelineMessageKey({ id: "m1" })).toBe("m1");
    expect(timelineMessageKey({ id: "" })).toBe("single-missing");
    expect(timelineMessageKey(undefined)).toBe("single-missing");
  });
});

describe("findMatches", () => {
  const messages: ChatMessage[] = [
    mk({ id: "u1", role: "user", text: "Hello World" }),
    mk({ id: "a1", role: "assistant", text: "hello there", _timelineUnitKey: "unit:a1" }),
    mk({ id: "t1", role: "tool", text: "hello from tool" }),
    mk({ id: "u2", role: "user", text: "其他内容" }),
    mk({ id: "th1", role: "thinking", text: "hello thinking" }),
  ];

  test("空 query 无命中", () => {
    expect(findMatches(messages, "")).toEqual([]);
    expect(findMatches(messages, "   ")).toEqual([]);
  });

  test("只搜 user/assistant，大小写不敏感，key 走 timelineMessageKey", () => {
    expect(findMatches(messages, "HELLO")).toEqual([
      { index: 0, key: "u1" },
      { index: 1, key: "unit:a1" },
    ]);
  });

  test("不匹配 tool/thinking 即使正文包含 query", () => {
    expect(findMatches(messages, "tool")).toEqual([]);
    expect(findMatches(messages, "thinking")).toEqual([]);
  });

  test("无命中返回空数组", () => {
    expect(findMatches(messages, "zzz")).toEqual([]);
  });
});

describe("stepMatch", () => {
  const matches = [
    { index: 0, key: "a" },
    { index: 2, key: "b" },
    { index: 5, key: "c" },
  ];

  test("空列表返回 -1", () => {
    expect(stepMatch([], 0, 1)).toBe(-1);
    expect(stepMatch([], 0, -1)).toBe(-1);
  });

  test("越界 current 时下一从 0、上一从末项", () => {
    expect(stepMatch(matches, -1, 1)).toBe(0);
    expect(stepMatch(matches, 99, 1)).toBe(0);
    expect(stepMatch(matches, -1, -1)).toBe(2);
  });

  test("环形步进", () => {
    expect(stepMatch(matches, 0, 1)).toBe(1);
    expect(stepMatch(matches, 2, 1)).toBe(0);
    expect(stepMatch(matches, 0, -1)).toBe(2);
    expect(stepMatch(matches, 1, -1)).toBe(0);
  });

  test("输入后游标在第一项时第一次下一处走向第二项", () => {
    expect(stepMatch(matches, 0, 1)).toBe(1);
  });
});

describe("locateFindMatch", () => {
  const items = [
    { key: "team-a", memberKeys: ["g1", "g2"] },
    { key: "u-needle", memberKeys: ["u-needle"] },
    { key: "u-tail", memberKeys: ["u-tail"] },
  ];

  test("按 key 映射到 coalesce 后的 renderIndex，不用原始下标", () => {
    const match = { index: 3, key: "u-needle" };
    expect(locateFindMatch(items, match)).toEqual({
      renderIndex: 1,
      renderKey: "u-needle",
      memberKey: "u-needle",
    });
  });

  test("团队卡之后的可搜消息落到合并后的下一项，而不是原始 messages 下标", () => {
    expect(locateFindMatch(items, { index: 2, key: "u-needle" })?.renderIndex).toBe(1);
    expect(locateFindMatch(items, { index: 2, key: "u-needle" })?.renderIndex).not.toBe(2);
  });

  test("映射失败取消，不猜原始 index 指向的另一行", () => {
    expect(locateFindMatch(items, { index: 0, key: "filtered-out" })).toBeNull();
    expect(locateFindMatch(items, { index: 1, key: "u-missing" })).toBeNull();
    expect(locateFindMatch(items, null)).toBeNull();
  });
});
