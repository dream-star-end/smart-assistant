import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GoalStateSnapshot } from "@openclaude/protocol/goalState";
import { GoalDialog } from "./GoalDialog";

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

describe("GoalDialog", () => {
  it("sets objective and both optional budgets", async () => {
    const onSet = vi.fn().mockResolvedValue(undefined);
    render(<GoalDialog open onOpenChange={() => {}} goal={null} onSet={onSet} onAction={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("这次会话要达成什么？"), { target: { value: "完成迁移" } });
    const optional = screen.getAllByPlaceholderText("可选");
    fireEvent.change(optional[0]!, { target: { value: "1200" } });
    fireEvent.change(optional[1]!, { target: { value: "500" } });
    fireEvent.click(screen.getByRole("button", { name: "设置并开始" }));
    await waitFor(() => expect(onSet).toHaveBeenCalledWith({
      objective: "完成迁移",
      tokenBudget: 1200,
      creditBudget: "500",
      expectedStateRevision: 0,
    }));
  });

  it("shows a soft warning near budget and exposes unified state actions", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(<GoalDialog open onOpenChange={() => {}} goal={goal} onSet={vi.fn()} onAction={onAction} />);
    expect(screen.getByText(/预算已接近或达到；这是软提醒/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /暂停/ }));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith("pause"));
  });

  it("ticks active runtime locally between authoritative snapshots", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T00:00:00.000Z"));
    render(<GoalDialog open onOpenChange={() => {}} goal={goal} onSet={vi.fn()} onAction={vi.fn()} />);
    expect(screen.getByText("累计运行：1分 5秒")).toBeTruthy();
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(screen.getByText("累计运行：1分 7秒")).toBeTruthy();
  });
});

// C-05:「清除」此前与「完成」并排、点一下目标即清,无确认、无 danger 视觉。
describe("GoalDialog 清除需二次确认", () => {
  it("点「清除」先弹确认;取消不调 onAction,确认才调 clear", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(<GoalDialog open onOpenChange={() => {}} goal={goal} onSet={vi.fn()} onAction={onAction} />);
    const clearBtn = screen.getByRole("button", { name: /清除/ });
    expect(clearBtn.className).toContain("text-danger");
    fireEvent.click(clearBtn);
    await screen.findByText("清除会话目标？");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByText("清除会话目标？")).toBeNull());
    expect(onAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /清除/ }));
    await screen.findByText("清除会话目标？");
    fireEvent.click(screen.getByRole("button", { name: "清除目标" }));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith("clear"));
  });

  it("受阻状态用 warning 徽记而不是 accent", () => {
    render(
      <GoalDialog
        open
        onOpenChange={() => {}}
        goal={{ ...goal, status: "blocked", tokensUsed: 1, tokenBudget: 100, creditsUsed: "0", creditBudget: null }}
        onSet={vi.fn()}
        onAction={vi.fn()}
      />,
    );
    const badge = screen.getByText("受阻");
    expect(badge.className).toMatch(/warning/);
  });
});

it("closes after success but keeps errors visible for retry", async () => {
  const onSet = vi.fn().mockRejectedValueOnce(new Error("目标已保存，但未能启动")).mockResolvedValue(undefined);
  const onOpenChange = vi.fn();
  render(<GoalDialog open onOpenChange={onOpenChange} goal={goal} onSet={onSet} onAction={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await screen.findByRole("alert");
  expect(onOpenChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  expect(onSet).toHaveBeenCalledTimes(2);
});
