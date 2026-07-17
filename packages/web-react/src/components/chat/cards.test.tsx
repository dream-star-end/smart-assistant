import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../lib/chat/model";
import { UserCard } from "./cards";

afterEach(cleanup);

function userMsg(over: Partial<ChatMessage> = {}): ChatMessage {
  return { id: "u1", role: "user", text: "你好", ts: 1, ...over } as ChatMessage;
}

describe("F3 UserCard 发送失败重试命中区", () => {
  test("error 态 + onRetrySend → 重试按钮补 44px 触控命中区并可点回调", () => {
    const onRetrySend = vi.fn();
    render(<UserCard msg={userMsg({ status: "error" })} cb={{ onRetrySend }} />);
    const btn = screen.getByRole("button", { name: /重试/ });
    // 对齐同批其它命中区写法（MessageRenderer 续轮按钮）：粗指针下 ≥44px。
    expect(btn).toHaveClass("[@media(hover:none)]:min-h-11");
    fireEvent.click(btn);
    expect(onRetrySend).toHaveBeenCalledTimes(1);
  });

  test("非 error 态不渲染重试按钮", () => {
    render(<UserCard msg={userMsg({ status: "sent" })} cb={{ onRetrySend: () => {} }} />);
    expect(screen.queryByRole("button", { name: /重试/ })).toBeNull();
  });
});
