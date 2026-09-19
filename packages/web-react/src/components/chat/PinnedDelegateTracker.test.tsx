import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { InflightDelegateItem } from "../../lib/chat/inflightDelegates";
import { PinnedDelegateTracker } from "./PinnedDelegateTracker";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

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

  test("running 项渲染 goal 首行;头部计数写「N 进行中」(H-03)", () => {
    render(<PinnedDelegateTracker items={[item()]} onDismiss={() => {}} />);
    expect(screen.getByText("核验 inflight HUD")).toBeInTheDocument();
    expect(screen.getByText("后台任务 1 进行中")).toBeInTheDocument();
    expect(screen.queryByText("第二行不应出现在截断首行")).toBeNull();
    expect(screen.getByText("Read PinnedDelegateTracker.tsx")).toBeInTheDocument();
  });

  test("H-01 失败 / 取消 / 被终止的终态同样显示原因(resultSummary),且为 danger 色", () => {
    render(
      <PinnedDelegateTracker
        items={[
          item({ jobId: "f", runId: "rf", state: "failed", resultSummary: "SSH 22 端口不可达\n第二行" }),
          item({ jobId: "c", runId: "rc", state: "cancelled", resultSummary: "用户取消" }),
          item({ jobId: "k", runId: "rk", state: "killed_by_cutover", resultSummary: "切换时被终止" }),
        ]}
        onDismiss={() => {}}
      />,
    );
    const reason = screen.getByText("SSH 22 端口不可达");
    expect(reason).toBeInTheDocument();
    expect(reason.className).toContain("text-danger");
    expect(screen.queryByText("第二行")).toBeNull();
    expect(screen.getByText("用户取消")).toBeInTheDocument();
    expect(screen.getByText("切换时被终止")).toBeInTheDocument();
  });

  test("H-07 排队中不转圈、有状态可读名;暂停用 warning 标", () => {
    render(
      <PinnedDelegateTracker
        items={[
          item({ jobId: "q", runId: "rq", state: "queued" }),
          item({ jobId: "p", runId: "rp", state: "paused_for_cutover" }),
        ]}
        onDismiss={() => {}}
      />,
    );
    const queued = screen.getByRole("img", { name: "排队中" });
    expect(queued.getAttribute("class") ?? "").not.toContain("animate-spin");
    const paused = screen.getByRole("img", { name: "已暂停（等待切换）" });
    expect(paused.getAttribute("class") ?? "").toContain("text-warning");
    // 没有 running 项 → 头部不给「停止本轮」
    expect(screen.queryByRole("button", { name: "停止本轮" })).toBeNull();
  });

  test("H-03 全部结束后折叠:头部计数「N 已结束」+ 摘要回退到最近结束的一条", () => {
    render(
      <PinnedDelegateTracker
        items={[
          item({ jobId: "a", runId: "ra", state: "completed", goal: "旧的成功任务", updatedAt: 1_000 }),
          item({ jobId: "b", runId: "rb", state: "failed", goal: "最近失败的任务", updatedAt: 5_000, resultSummary: "原因" }),
        ]}
        onDismiss={() => {}}
        onStop={() => {}}
      />,
    );
    expect(screen.getByText("后台任务 2 已结束")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /折叠后台任务列表/ }));
    // 折叠态:摘要是最近结束的那条,而不是空头部
    expect(screen.getByText("最近失败的任务")).toBeInTheDocument();
    expect(screen.queryByText("旧的成功任务")).toBeNull();
    expect(screen.queryByText("原因")).toBeNull();
  });

  test("H-13 全部结束且 ≥2 条 → 「全部知道了」逐条调用 onDismiss;有运行项时不出现", () => {
    const onDismiss = vi.fn();
    const view = render(
      <PinnedDelegateTracker
        items={[
          item({ jobId: "a", runId: "ra", state: "completed" }),
          item({ jobId: "b", runId: "rb", state: "failed" }),
        ]}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "全部知道了" }));
    expect(onDismiss).toHaveBeenCalledTimes(2);
    expect(onDismiss.mock.calls.map((c) => c[0]).sort()).toEqual(["a", "b"]);
    view.rerender(
      <PinnedDelegateTracker
        items={[item({ jobId: "a", runId: "ra", state: "completed" }), item({ jobId: "r", runId: "rr" })]}
        onDismiss={onDismiss}
      />,
    );
    expect(screen.queryByRole("button", { name: "全部知道了" })).toBeNull();
  });

  test("H-04/H-05/H-08/H-09 头部只有一个切换按钮:无 aria-hidden 假按钮、inset 焦点环、aria-controls 折叠时不悬空", () => {
    render(<PinnedDelegateTracker items={[item()]} onDismiss={() => {}} onStop={() => {}} />);
    expect(document.querySelectorAll("button[aria-hidden]")).toHaveLength(0);
    const toggles = screen.getAllByRole("button", { expanded: true });
    expect(toggles).toHaveLength(1);
    const btn = screen.getByRole("button", { name: /折叠后台任务列表/ });
    expect(btn.className).toContain("focus-visible:ring-inset");
    const listId = btn.getAttribute("aria-controls");
    expect(listId).toBeTruthy();
    expect(document.getElementById(listId!)).not.toBeNull();
    fireEvent.click(btn);
    const collapsed = screen.getByRole("button", { name: /展开后台任务列表/ });
    expect(collapsed).not.toHaveAttribute("aria-controls");
    // 折叠摘要里目标文本可见(H-02:目标是唯一可收缩项,不再被名字/计时挤没)
    expect(screen.getByText("核验 inflight HUD")).toBeInTheDocument();
  });

  test("H-12 计时起点取 min(首次观察, updatedAt):刷新后不从 00:00 重来", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    render(<PinnedDelegateTracker items={[item({ updatedAt: 100_000 - 65_000 })]} onDismiss={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /折叠后台任务列表/ }));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    // 65s 前最后更新 + 1s 心跳 → 01:06(而不是 00:01)
    expect(screen.getByText("01:06")).toBeInTheDocument();
    vi.useRealTimers();
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

  test("运行中且传入 onStop 时 header 有停止本轮，点击只停轮不 dismiss", () => {
    const onStop = vi.fn();
    const onDismiss = vi.fn();
    render(<PinnedDelegateTracker items={[item()]} onDismiss={onDismiss} onStop={onStop} />);
    fireEvent.click(screen.getByRole("button", { name: "停止本轮" }));
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  test("无 onStop 时不渲染停止本轮假按钮", () => {
    render(<PinnedDelegateTracker items={[item()]} onDismiss={() => {}} />);
    expect(screen.queryByRole("button", { name: "停止本轮" })).toBeNull();
  });

  test("运行中不在 3s 后自动收起", () => {
    vi.useFakeTimers();
    render(<PinnedDelegateTracker items={[item()]} onDismiss={() => {}} />);
    expect(screen.getByText("核验 inflight HUD")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(3100);
    });
    expect(screen.getByText("核验 inflight HUD")).toBeInTheDocument();
    vi.useRealTimers();
  });

  test("无 running 终态 3s 后自动收起", () => {
    vi.useFakeTimers();
    render(
      <PinnedDelegateTracker
        items={[item({ state: "completed", resultSummary: "已完成摘要第一行\n其余" })]}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByText("已完成摘要第一行")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(3100);
    });
    expect(screen.queryByText("已完成摘要第一行")).toBeNull();
    vi.useRealTimers();
  });
});
