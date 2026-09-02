import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { InflightDelegateItem } from "../../lib/chat/inflightDelegates";
import { PinnedDelegateTracker } from "./PinnedDelegateTracker";

afterEach(cleanup);

function item(over: Partial<InflightDelegateItem> = {}): InflightDelegateItem {
  return {
    jobId: "dlgjob-1",
    runId: "dlg-1",
    agentId: "coding-assistant",
    goal: "核验 inflight HUD\n第二行不应出现在截断首行",
    state: "running",
    liveHint: "Read PinnedDelegateTracker.tsx",
    updatedAt: 1_000,
    parentSessionKey: "agent:main:webchat:dm:web-1",
    ...over,
  };
}

describe("PinnedDelegateTracker", () => {
  test("无项 → 不渲染", () => {
    const { container } = render(<PinnedDelegateTracker items={[]} onDismiss={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  test("running 项渲染 goal 首行", () => {
    render(<PinnedDelegateTracker items={[item()]} onDismiss={() => {}} />);
    expect(screen.getByText("核验 inflight HUD")).toBeInTheDocument();
    expect(screen.getByText("后台任务 1/1")).toBeInTheDocument();
    expect(screen.queryByText("第二行不应出现在截断首行")).toBeNull();
    expect(screen.getByText("Read PinnedDelegateTracker.tsx")).toBeInTheDocument();
  });

  test("终态项 dismiss 调用 onDismiss", () => {
    const onDismiss = vi.fn();
    render(
      <PinnedDelegateTracker
        items={[item({ state: "completed", resultSummary: "已完成摘要第一行\n其余" })]}
        onDismiss={onDismiss}
      />,
    );
    expect(screen.getByText("已完成摘要第一行")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith("dlgjob-1");
  });

  test("父 turn 结束时仍渲染（无 wsSending/active 隐藏条件）", () => {
    const { container } = render(<PinnedDelegateTracker items={[item()]} onDismiss={() => {}} />);
    expect(container.firstChild).not.toBeNull();
    expect(screen.getByText("核验 inflight HUD")).toBeInTheDocument();
    expect(screen.getByText("coding-assistant")).toBeInTheDocument();
  });
});
