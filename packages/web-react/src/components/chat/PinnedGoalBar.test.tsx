import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { ChatMessage } from "../../lib/chat/model";
import { latestVisibleGoal, PinnedGoalBar } from "./PinnedGoalBar";

function goal(id: string, text: string, goalStatus = "active", extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    role: "goal",
    text,
    goalStatus,
    ts: 1_700_000_000_000,
    tokensUsed: 120,
    tokenBudget: 1_000,
    timeUsedSeconds: 8,
    ...extra,
  };
}

afterEach(cleanup);

describe("PinnedGoalBar 已收敛至 Composer 单入口", () => {
  test("不再在 HUD 渲染重复目标条，也不暴露裸 token 预算", () => {
    const { container } = render(<PinnedGoalBar messages={[goal("g", "当前发布目标", "active")]} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("pinned-goal")).toBeNull();
    expect(screen.queryByText(/120\/1,000/)).toBeNull();
  });

  test("latestVisibleGoal 仍正确识别最新未清除目标", () => {
    expect(latestVisibleGoal([])).toBeNull();
    expect(
      latestVisibleGoal([
        goal("older", "旧目标"),
        goal("latest", "最新目标", "blocked"),
        { id: "a", role: "assistant", text: "普通句子", ts: 1 },
      ])?.id,
    ).toBe("latest");
    expect(
      latestVisibleGoal([
        goal("old", "旧目标"),
        goal("cleared", "已清除", "active", { cleared: true }),
      ]),
    ).toBeNull();
    expect(
      latestVisibleGoal([
        goal("old", "旧目标"),
        goal("cleared", "已清除", " Cleared "),
      ]),
    ).toBeNull();
  });
});
