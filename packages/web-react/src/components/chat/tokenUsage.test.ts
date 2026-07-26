import { describe, expect, test } from "vitest";
import {
  formatCompactTokenCount,
  groupedCallTokenUsage,
} from "./tokenUsage";

describe("tokenUsage 紧凑展示", () => {
  test.each([
    [986, "986"],
    [1_234, "1.23k"],
    [12_345, "12.3k"],
    [123_456, "123k"],
    [1_440_728, "1.44m"],
  ])("%i token → %s", (tokens, expected) => {
    expect(formatCompactTokenCount(tokens)).toBe(expected);
  });

  test("同一调用映射到多张思考卡时只聚合一次并标记共享", () => {
    const call = {
      callId: "ccb-1",
      targetIds: ["thinking-1", "thinking-2"],
      usage: { totalTokens: 123_456 },
    };
    expect(groupedCallTokenUsage([call, call])).toEqual({
      callId: "ccb-1",
      shared: true,
      totalTokens: 123_456,
    });
  });
});
