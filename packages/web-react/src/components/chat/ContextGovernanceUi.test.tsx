import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../Composer";
import { TooltipProvider } from "../ui";
import { ContextHealthPopover } from "./ContextHealthPopover";
import { SystemCard } from "./cards";
import { errorNoticeActions } from "./errorNoticeActions";
import type { ChatMessage } from "../../lib/chat/model";
import type { UserError } from "../../lib/chat/userErrorView";

afterEach(() => {
  cleanup();
});

describe("Composer silent context care (OCV5-841)", () => {
  it("never renders 80% nag banner or persistent watermark pill, while keeping /compact and /context commands", () => {
    const onSend = vi.fn();
    const onCompactCommand = vi.fn();
    const onOpenContextHealth = vi.fn();

    render(
      <TooltipProvider>
        <Composer
          onSend={onSend}
          hasActiveSession
          contextPressure={{
            engine: "ccb",
            scope: "native_context",
            dimension: "tokens",
            level: "critical",
            usedRatio: 0.96,
            usedTokens: 192_000,
            windowTokens: 200_000,
            updatedAt: Date.now(),
          }}
          onCompactCommand={onCompactCommand}
          onOpenContextHealth={onOpenContextHealth}
        />
      </TooltipProvider>,
    );

    expect(screen.queryByTestId("composer-context-pressure-banner")).toBeNull();
    expect(screen.queryByTestId("composer-context-pill")).toBeNull();

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "/compact 保留最新结论" } });
    fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
    expect(onCompactCommand).toHaveBeenCalledWith("保留最新结论");
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.change(textarea, { target: { value: "/context" } });
    fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
    expect(onOpenContextHealth).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe("ContextHealthPopover plain-language view (OCV5-841)", () => {
  it("renders jargon-free auto-care notice, breakdown bar, and actions", () => {
    const onCompact = vi.fn();
    const onStartNewSession = vi.fn();
    const onOpenManageMemory = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <ContextHealthPopover
        open
        onOpenChange={onOpenChange}
        pressure={{
          engine: "ccb",
          scope: "native_context",
          dimension: "tokens",
          level: "warning",
          usedRatio: 0.85,
          usedTokens: 170_000,
          windowTokens: 200_000,
          breakdown: {
            systemBytes: 10_240,
            memoryBytes: 6_144,
            skillsBytes: 4_096,
            historyBytes: 40_960,
            toolsBytes: 20_480,
          },
          updatedAt: Date.now(),
        }}
        onCompact={onCompact}
        onStartNewSession={onStartNewSession}
        onOpenManageMemory={onOpenManageMemory}
      />,
    );

    const popover = screen.getByTestId("context-health-popover");
    expect(screen.getByText(/系统已开启自动整理，聊久了会自动帮你处理，无需手动操作/)).toBeTruthy();
    expect(screen.getByText("85%")).toBeTruthy();
    expect(screen.getByTestId("context-breakdown-bar")).toBeTruthy();
    expect(screen.getByText("助手设定")).toBeTruthy();
    expect(screen.getByText("聊天记录")).toBeTruthy();
    expect(popover.textContent).not.toMatch(/常驻底噪|tokens|KB|ccb/i);

    fireEvent.click(screen.getByRole("button", { name: /立即整理较早对话/ }));
    expect(onCompact).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /开启新会话/ }));
    expect(onStartNewSession).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /查看长期记忆与已收纳记录/ }));
    expect(onOpenManageMemory).toHaveBeenCalledTimes(1);
  });
});

describe("context_too_long fallback & SystemCard receipt (OCV5-841)", () => {
  const userError: UserError = {
    code: "context_too_long",
    category: "context",
    message: "本会话内容已超过模型上限。",
    retryable: false,
    userMessageKey: "errors.context_too_long",
    actions: ["switch_model", "edit_message"],
  };
  const msg = { id: "e1", role: "assistant", text: "", _errorCode: "context_too_long" } as ChatMessage;

  it("uses plain-Chinese primary CTA for context_too_long fallback", () => {
    const onCompactSession = vi.fn();
    const onStartNewSession = vi.fn();
    const actions = errorNoticeActions({
      msg,
      cb: { onCompactSession, onStartNewSession, onOpenModelPicker: vi.fn() },
      userError,
      isLastTurn: true,
      waived: false,
    });
    expect(actions.map((a) => a.label)).toEqual(["整理上下文并继续", "开启新会话"]);
    actions[0]?.onClick();
    actions[1]?.onClick();
    expect(onCompactSession).toHaveBeenCalledTimes(1);
    expect(onStartNewSession).toHaveBeenCalledTimes(1);
  });

  it("renders jargon-free compaction receipt divider inside SystemCard", () => {
    const receiptMsg: ChatMessage = {
      id: "sys-ctxcompact-s1-r1",
      role: "system",
      text: "已自动整理较早对话，可继续无缝聊下去",
      ts: 1_700_000_000_000,
      _contextCompaction: {
        engine: "ccb",
        strategy: "checkpoint_reset",
        beforeTokens: 150_000,
        afterTokens: 60_000,
        beforeBytes: 240_000,
        afterBytes: 40_000,
        droppedEntries: 9,
        summaryPreview: "已保留当前架构决策与待办清单",
      },
    };
    render(<SystemCard msg={receiptMsg} />);
    const receipt = screen.getByTestId("context-compacted-receipt");
    const toggle = screen.getByRole("button", { name: /已自动整理较早对话，可继续无缝聊下去/ });
    expect(screen.queryByText(/系统已自动保留近期对话与关键决策/)).toBeNull();
    expect(receipt.textContent).not.toMatch(/checkpoint_reset|native_summary|beforeBytes|afterBytes|droppedEntries|Token/i);

    fireEvent.click(toggle);
    expect(screen.getByText(/系统已自动保留近期对话与关键决策，完整聊天记录仍在上方可见/)).toBeTruthy();
    expect(screen.getByText(/已保留当前架构决策与待办清单/)).toBeTruthy();
    expect(receipt.textContent).not.toMatch(/checkpoint_reset|native_summary|beforeBytes|afterBytes|droppedEntries|Token/i);
  });
});
