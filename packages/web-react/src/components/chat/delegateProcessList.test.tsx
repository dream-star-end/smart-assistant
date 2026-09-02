import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ChildBlock } from "../../lib/chat/model";
import {
  DELEGATE_PROCESS_TAIL_SIZE,
  DelegateProcessList,
  anchoredScrollTop,
  expandWindowStart,
  windowStartForTail,
} from "./delegateProcessList";
import { AgentGroupCard } from "./AgentGroupCard";
import type { ChatMessage } from "../../lib/chat/model";

afterEach(cleanup);

function child(i: number): ChildBlock {
  return {
    kind: "tool_use",
    blockId: `call-${i}`,
    toolName: "Bash",
    inputJson: { command: `echo ${i}` },
    _completed: true,
    output: `out-${i}`,
  };
}

function mockScroller(el: HTMLElement, dims: { clientHeight: number; scrollHeight: number }) {
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => dims.clientHeight });
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => dims.scrollHeight });
}

describe("delegateProcessList 窗口计算", () => {
  test("尾部窗口默认最近 30 条", () => {
    expect(windowStartForTail(300)).toBe(300 - DELEGATE_PROCESS_TAIL_SIZE);
    expect(windowStartForTail(10)).toBe(0);
    expect(expandWindowStart(270)).toBe(260);
    expect(expandWindowStart(5)).toBe(0);
    expect(anchoredScrollTop(800, 1100, 10)).toBe(310);
  });
});

describe("DelegateProcessList", () => {
  test("300 个 child 只挂窗口内节点，容器高度有上限", () => {
    const children = Array.from({ length: 300 }, (_, i) => child(i));
    const { container } = render(<DelegateProcessList childBlocks={children} />);
    const mounted = container.querySelectorAll("[data-testid=delegate-process-child]");
    expect(mounted.length).toBeLessThan(300);
    expect(mounted.length).toBe(DELEGATE_PROCESS_TAIL_SIZE);
    const scroller = screen.getByTestId("delegate-process-scroller");
    expect(scroller.className).toMatch(/h-\[min\(420px,50vh\)\]/);
    expect(screen.getByText(/已加载 30 \/ 300 步/)).toBeInTheDocument();
  });

  test("贴底时追加 child 后仍贴底", () => {
    const initial = Array.from({ length: 8 }, (_, i) => child(i));
    const view = render(<DelegateProcessList childBlocks={initial} />);
    const scroller = screen.getByTestId("delegate-process-scroller");
    mockScroller(scroller, { clientHeight: 200, scrollHeight: 400 });
    scroller.scrollTop = 200;
    const more = [...initial, child(8), child(9)];
    mockScroller(scroller, { clientHeight: 200, scrollHeight: 500 });
    view.rerender(<DelegateProcessList childBlocks={more} />);
    expect(scroller.scrollTop).toBe(scroller.scrollHeight);
  });

  test("贴底时末条输出增长仍钉在底部", () => {
    const initial = Array.from({ length: 4 }, (_, i) => child(i));
    const view = render(<DelegateProcessList childBlocks={initial} />);
    const scroller = screen.getByTestId("delegate-process-scroller");
    mockScroller(scroller, { clientHeight: 200, scrollHeight: 360 });
    scroller.scrollTop = 160;
    const grown = initial.map((item, i) =>
      i === initial.length - 1 ? { ...item, output: `${item.output}\nmore-log` } : item,
    );
    mockScroller(scroller, { clientHeight: 200, scrollHeight: 420 });
    view.rerender(<DelegateProcessList childBlocks={grown} />);
    expect(scroller.scrollTop).toBe(scroller.scrollHeight);
  });

  test("贴底增量到达时仍只挂尾部窗口", () => {
    const view = render(
      <DelegateProcessList childBlocks={Array.from({ length: 30 }, (_, i) => child(i))} />,
    );
    expect(screen.getAllByTestId("delegate-process-child")).toHaveLength(30);
    view.rerender(
      <DelegateProcessList childBlocks={Array.from({ length: 300 }, (_, i) => child(i))} />,
    );
    expect(screen.getAllByTestId("delegate-process-child")).toHaveLength(DELEGATE_PROCESS_TAIL_SIZE);
    expect(screen.getByText(/已加载 30 \/ 300 步/)).toBeInTheDocument();
  });

  test("上滑扩窗后视口锚定：scrollTop 增量约等于新增高度", () => {
    const children = Array.from({ length: 40 }, (_, i) => child(i));
    render(<DelegateProcessList childBlocks={children} />);
    const scroller = screen.getByTestId("delegate-process-scroller");
    mockScroller(scroller, { clientHeight: 200, scrollHeight: 800 });
    Object.defineProperty(scroller, "scrollHeight", {
      configurable: true,
      get: () => {
        const n = document.querySelectorAll("[data-testid=delegate-process-child]").length;
        return 800 + Math.max(0, n - DELEGATE_PROCESS_TAIL_SIZE) * 30;
      },
    });
    scroller.scrollTop = 10;
    const heightBefore = scroller.scrollHeight;
    fireEvent.scroll(scroller);
    const heightAfter = scroller.scrollHeight;
    expect(heightAfter).toBeGreaterThan(heightBefore);
    expect(scroller.scrollTop).toBe(anchoredScrollTop(heightBefore, heightAfter, 10));
    expect(document.querySelectorAll("[data-testid=delegate-process-child]").length).toBeGreaterThan(
      DELEGATE_PROCESS_TAIL_SIZE,
    );
  });

  test("卡内滚动在 scrollTop>0 时阻止冒泡", () => {
    const children = Array.from({ length: 5 }, (_, i) => child(i));
    render(<DelegateProcessList childBlocks={children} />);
    const scroller = screen.getByTestId("delegate-process-scroller");
    mockScroller(scroller, { clientHeight: 200, scrollHeight: 800 });
    scroller.scrollTop = 40;
    const parent = scroller.parentElement!;
    const spy = vi.fn();
    parent.addEventListener("scroll", spy);
    fireEvent.scroll(scroller);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("AgentGroupCard 子卡不渲染父 tokenUsage", () => {
  test("组头有用量徽记，子 ToolCard 没有", () => {
    const msg = {
      id: "g1",
      role: "agent-group",
      text: "修卡片",
      ts: 1,
      _delegate: true,
      _completed: false,
      _delegateUsageByRun: { "run-1": { totalTokens: 169_000 } },
      childBlocks: [
        {
          kind: "tool_use",
          blockId: "call-a",
          toolName: "TaskOutput",
          inputJson: { task_ids: ["call-wait"], description: "" },
          _completed: false,
        },
      ],
    } as ChatMessage;
    render(<AgentGroupCard msg={msg} />);
    expect(screen.getByLabelText(/子 Agent 合计 169,000 token/)).toBeInTheDocument();
    expect(screen.getAllByLabelText(/token/).length).toBe(1);
    expect(screen.getByText("等待输出")).toBeInTheDocument();
  });
});
