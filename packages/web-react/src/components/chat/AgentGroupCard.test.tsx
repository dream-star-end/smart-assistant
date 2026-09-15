import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { ChatMessage } from "../../lib/chat/model";
import { AgentGroupCard } from "./AgentGroupCard";

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
