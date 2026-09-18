import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import {
  formatCompactTokenCount,
  groupedCallTokenUsage,
  TokenUsageBadge,
} from "./tokenUsage";

afterEach(cleanup);

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

  // M-08:徽章此前只是一个无单位的裸数字(5.98k),仅 title 可解释。
  test("徽章可见文案带单位,数字节点自身仍是纯数字,估算/共享前缀保留", () => {
    const { rerender } = render(TokenUsageBadge({ usage: { totalTokens: 5_980 } }));
    const badge = screen.getByLabelText("本轮 5,980 token");
    expect(badge).toHaveTextContent("5.98k token");
    expect(screen.getByText("5.98k")).toBeInTheDocument();
    rerender(TokenUsageBadge({ usage: { totalTokens: 128, estimated: true } }));
    expect(screen.getByLabelText("本轮估算约 128 token")).toHaveTextContent("约128 token");
    rerender(TokenUsageBadge({ usage: { totalTokens: 64, shared: true, callId: "c1" }, label: "子 Agent 合计" }));
    expect(screen.getByText("共64")).toBeInTheDocument();
  });
});
