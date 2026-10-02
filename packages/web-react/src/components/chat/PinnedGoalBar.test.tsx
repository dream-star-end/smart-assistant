import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../lib/chat/model";
import { PinnedGoalBar } from "./PinnedGoalBar";

function goal(id: string, text: string, goalStatus = "active", extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: "goal", text, goalStatus, ts: 1_700_000_000_000,
    tokensUsed: 120, tokenBudget: 1_000, timeUsedSeconds: 8, ...extra };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("PinnedGoalBar 当前目标单一入口", () => {
  test.each([["active", "进行中"], ["paused", "已暂停"], ["blocked", "阻塞"]])("%s 在 dock 正向显示，不丢掉目标", (status, label) => {
    render(<PinnedGoalBar messages={[goal("g", "当前发布目标", status)]} />);
    const dock = screen.getByTestId("pinned-goal");
    expect(dock).toHaveTextContent(label);
    expect(dock).toHaveTextContent("当前发布目标");
    expect(dock).toHaveTextContent("120/1,000 · 8s");
    expect(within(dock).getAllByRole("button")).toHaveLength(1);
    expect(within(dock).getByRole("button")).toHaveAttribute("aria-expanded", "false");
  });

  test("最新目标优先，普通 assistant 句子不是目标", () => {
    render(<PinnedGoalBar messages={[
      goal("older", "旧目标"), goal("latest", "最新目标", "blocked"),
      { id: "a", role: "assistant", text: "目标已清除只是普通句子", ts: 1 },
    ]} />);
    expect(screen.getAllByTestId("pinned-goal")).toHaveLength(1);
    expect(screen.getByTestId("pinned-goal")).toHaveTextContent("最新目标");
    expect(screen.queryByText("旧目标")).not.toBeInTheDocument();
    expect(screen.queryByText("目标已清除只是普通句子")).not.toBeInTheDocument();
  });

  test.each([
    { cleared: true, goalStatus: "active" },
    { cleared: false, goalStatus: " Cleared " },
  ])("最新清除记录隐藏 dock，不回退旧目标 %j", (extra) => {
    const view = render(<PinnedGoalBar messages={[goal("old", "不该回退的目标")]} />);
    expect(screen.getByTestId("pinned-goal")).toHaveTextContent("不该回退的目标");
    view.rerender(<PinnedGoalBar messages={[goal("old", "不该回退的目标"), goal("new", "已清除目标", "active", extra)]} />);
    expect(screen.queryByTestId("pinned-goal")).not.toBeInTheDocument();
    expect(screen.queryByText("不该回退的目标")).not.toBeInTheDocument();
  });

  test("空消息和仅普通句子没有空 dock", () => {
    const view = render(<PinnedGoalBar messages={[]} />);
    expect(screen.queryByTestId("pinned-goal")).not.toBeInTheDocument();
    view.rerender(<PinnedGoalBar messages={[{ id: "a", role: "assistant", text: "目标", ts: 1 }]} />);
    expect(screen.queryByTestId("pinned-goal")).not.toBeInTheDocument();
  });

  test("真实点击展开全文，再点击收起", () => {
    const text = "完整目标 " + "逐项检查所有模型。".repeat(30) + " END_OF_OBJECTIVE";
    const { container } = render(<PinnedGoalBar messages={[goal("g", text)]} />);
    const toggle = screen.getByRole("button");
    expect(container.querySelector("p")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelector("p")?.textContent).toBe(text);
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector("p")).toBeNull();
  });

  test("离开指针时保留完整3秒，不提前折叠", () => {
    vi.useFakeTimers();
    render(<PinnedGoalBar messages={[goal("g", "自动折叠目标")]} />);
    const toggle = screen.getByRole("button");
    fireEvent.click(toggle);
    act(() => vi.advanceTimersByTime(2_999));
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    act(() => vi.advanceTimersByTime(1));
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  test("指针停留取消自动折叠，离开后重新计3秒", () => {
    vi.useFakeTimers();
    render(<PinnedGoalBar messages={[goal("g", "停留阅读目标")]} />);
    const dock = screen.getByTestId("pinned-goal");
    const toggle = screen.getByRole("button");
    fireEvent.click(toggle);
    act(() => vi.advanceTimersByTime(1_000));
    fireEvent.pointerEnter(dock);
    act(() => vi.advanceTimersByTime(10_000));
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.pointerLeave(dock);
    act(() => vi.advanceTimersByTime(2_999));
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    act(() => vi.advanceTimersByTime(1));
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  test("新目标身份切换收起全文，并显示新内容", () => {
    const { container, rerender } = render(<PinnedGoalBar messages={[goal("a", "旧目标全文")]} />);
    fireEvent.click(screen.getByRole("button"));
    expect(container.querySelector("p")?.textContent).toBe("旧目标全文");
    rerender(<PinnedGoalBar messages={[goal("a", "旧目标全文"), goal("b", "新目标全文")]} />);
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector("p")).toBeNull();
    expect(screen.getByTestId("pinned-goal")).toHaveTextContent("新目标全文");
    expect(screen.queryByText("旧目标全文")).not.toBeInTheDocument();
  });
});
