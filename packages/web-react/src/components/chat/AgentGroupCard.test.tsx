import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { ChatMessage } from "../../lib/chat/model";
import { AgentGroupCard } from "./AgentGroupCard";
import { prefetchMarkdownImpl } from "../Markdown";
import { loadBeforeAll } from "../../test/moduleLoad";
import { preloadToolBody } from "../tool/lazyToolBody";

// 渲染工具卡展开体的断言要等懒加载的 tool bodies;先在用例窗口外取好(src/test/moduleLoad.ts)。
loadBeforeAll(preloadToolBody);

// 断言渲染后的 Markdown 正文要等懒加载的 MarkdownImpl;先在用例窗口外取好(src/test/moduleLoad.ts)。
loadBeforeAll(prefetchMarkdownImpl);

afterEach(cleanup);

function agentRow(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "ag-1",
    role: "agent-group",
    text: "修复登录页",
    ts: 1,
    _completed: true,
    _resultPreview: "修复失败:依赖缺失",
    childBlocks: [],
    ...over,
  } as ChatMessage;
}

// M-07:折叠态结果摘要恒用绿色 ✓,即便徽记是「失败 / 超时」,终态语义自相矛盾。
describe("AgentGroupCard 折叠摘要图标跟终态 tone(M-07)", () => {
  test("TRUTH-10: 被中断的组卡显示已取消，无完成绿勾", () => {
    render(<AgentGroupCard msg={agentRow({ cancelled: true })} />);
    expect(screen.getByText("已取消")).toBeInTheDocument();
    expect(screen.queryByText("完成")).not.toBeInTheDocument();
    const icon = screen.getByTestId("agent-summary-icon");
    expect(icon).toHaveAttribute("data-tone", "neutral");
    expect(icon).toHaveClass("text-muted");
    expect(icon).not.toHaveClass("text-success");
  });

  test("失败 → 红 X;超时 → warning 时钟;完成 → 绿勾", () => {
    const { rerender } = render(<AgentGroupCard msg={agentRow({ _isError: true })} />);
    expect(screen.getByText("失败")).toBeInTheDocument();
    const failed = screen.getByTestId("agent-summary-icon");
    expect(failed).toHaveAttribute("data-tone", "danger");
    expect(failed).toHaveClass("text-danger");

    rerender(<AgentGroupCard msg={agentRow({ _delegateStatus: "timeout" })} />);
    expect(screen.getByText("超时")).toBeInTheDocument();
    expect(screen.getByTestId("agent-summary-icon")).toHaveAttribute("data-tone", "warning");

    rerender(<AgentGroupCard msg={agentRow()} />);
    expect(screen.getByText("完成")).toBeInTheDocument();
    const ok = screen.getByTestId("agent-summary-icon");
    expect(ok).toHaveAttribute("data-tone", "success");
    expect(ok).toHaveClass("text-success");
  });
});

// M-10:折叠开关此前无 aria-expanded(同文件 DelegateProgressCard / RuntimeEventCard 都有)。
describe("AgentGroupCard 折叠开关可访问性(M-10)", () => {
  test("头部按钮暴露 aria-expanded / aria-controls,触屏 44px", () => {
    render(<AgentGroupCard msg={agentRow()} />);
    const header = screen.getByRole("button", { name: /修复登录页/ });
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(header).not.toHaveAttribute("aria-controls");
    expect(header).toHaveClass("[@media(hover:none)]:min-h-11");
    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");
    const controls = header.getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    expect(document.getElementById(controls!)).toHaveTextContent("修复失败:依赖缺失");
  });
});
