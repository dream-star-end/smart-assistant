import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GoalStateSnapshot } from "@openclaude/protocol/goalState";
import { GoalControl } from "./GoalControl";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const goal: GoalStateSnapshot = {
  sessionId: "web-goal-1",
  goalId: "11111111-1111-4111-8111-111111111111",
  objective: "发布 GoalState",
  status: "active",
  tokenBudget: 100,
  creditBudget: "50",
  tokensUsed: 80,
  creditsUsed: "12",
  timeUsedSeconds: 65,
  stateRevision: 3,
  snapshotRevision: 4,
  createdAt: "2026-07-16T00:00:00.000Z",
  updatedAt: "2026-07-16T00:00:00.000Z",
  statusChangedAt: "2026-07-16T00:00:00.000Z",
};

describe("GoalControl", () => {
  it("sets objective and both optional budgets", async () => {
    const onSet = vi.fn().mockResolvedValue(undefined);
    render(<GoalControl goal={null} onSet={onSet} onAction={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "会话目标" }));
    fireEvent.change(screen.getByPlaceholderText("这次会话要达成什么？"), { target: { value: "完成迁移" } });
    const optional = screen.getAllByPlaceholderText("可选");
    fireEvent.change(optional[0]!, { target: { value: "1200" } });
    fireEvent.change(optional[1]!, { target: { value: "500" } });
    fireEvent.click(screen.getByRole("button", { name: "开始目标" }));
    await waitFor(() => expect(onSet).toHaveBeenCalledWith({
      objective: "完成迁移",
      tokenBudget: 1200,
      creditBudget: "500",
      expectedStateRevision: 0,
    }));
  });

  it("shows a soft warning near budget and exposes unified state actions", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(<GoalControl goal={goal} onSet={vi.fn()} onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: "会话目标" }));
    expect(screen.getByText(/预算已接近或达到；这是软提醒/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /暂停/ }));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith("pause"));
  });

  it("ticks active runtime locally between authoritative snapshots", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T00:00:00.000Z"));
    render(<GoalControl goal={goal} onSet={vi.fn()} onAction={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "会话目标" }));
    expect(screen.getByText("累计运行：1分 5秒")).toBeTruthy();
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(screen.getByText("累计运行：1分 7秒")).toBeTruthy();
  });
});
