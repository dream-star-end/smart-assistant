import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../lib/chat/model";
import { AssistantCard, type CardCallbacks, type RenderCtx, UserCard } from "./cards";

afterEach(cleanup);

function userMsg(over: Partial<ChatMessage> = {}): ChatMessage {
  return { id: "u1", role: "user", text: "你好", ts: 1, ...over } as ChatMessage;
}

// 终态错误助手行(非流式:isLast+!sending → isLive=false → 渲染红卡)。
function errMsg(over: Partial<ChatMessage> = {}): ChatMessage {
  return { id: "a1", role: "assistant", text: "", ts: 1, _errorCode: "upstream_failed", ...over } as ChatMessage;
}
const ERR_CTX: RenderCtx = { isLast: true, sending: false };
const retryableUser: ChatMessage = {
  id: "u1",
  role: "user",
  text: "原始问题",
  ts: 0,
  status: "error",
} as ChatMessage;

function renderErr(msg: ChatMessage, cb: CardCallbacks) {
  render(<AssistantCard msg={msg} ctx={ERR_CTX} cb={cb} />);
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

describe("AssistantCard 红卡重试 CTA 硬门(任务④)", () => {
  test("可重试码 + _clientMessageId 命中原 user 行 → 显示精确「重试」(不显「重新尝试」)", () => {
    const onRetrySend = vi.fn();
    const onRegenerate = vi.fn();
    renderErr(errMsg({ _clientMessageId: "u1" }), {
      onRetrySend,
      onRegenerate,
      resolveRetryTarget: () => retryableUser,
    });
    const btn = screen.getByRole("button", { name: "重试" });
    expect(screen.queryByRole("button", { name: "重新尝试" })).toBeNull();
    fireEvent.click(btn);
    expect(onRetrySend).toHaveBeenCalledWith(retryableUser);
    expect(onRegenerate).not.toHaveBeenCalled();
  });

  test("找不到原 user 行(resolveRetryTarget→undefined)→ 不显精确「重试」,落回「重新尝试」", () => {
    const onRegenerate = vi.fn();
    renderErr(errMsg({ _clientMessageId: "u1" }), {
      onRetrySend: vi.fn(),
      onRegenerate,
      resolveRetryTarget: () => undefined,
    });
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
    const regen = screen.getByRole("button", { name: "重新尝试" });
    fireEvent.click(regen);
    expect(onRegenerate).toHaveBeenCalledTimes(1);
  });

  test("无 _clientMessageId → 即便 resolver 有值也不走精确路径(落回「重新尝试」)", () => {
    renderErr(errMsg({}), {
      onRetrySend: vi.fn(),
      onRegenerate: vi.fn(),
      resolveRetryTarget: () => retryableUser,
    });
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
    expect(screen.getByRole("button", { name: "重新尝试" })).toBeInTheDocument();
  });

  test("cta=retry_or_switch(model_capacity)→ 精确「重试」+「切换模型」引导文案", () => {
    renderErr(errMsg({ _errorCode: "model_capacity", _clientMessageId: "u1" }), {
      onRetrySend: vi.fn(),
      resolveRetryTarget: () => retryableUser,
    });
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(screen.getByText(/切换模型/)).toBeInTheDocument();
  });

  test("insufficient_credits → 「去充值」现状不动(无重试/重新尝试)", () => {
    const onTopUp = vi.fn();
    renderErr(errMsg({ _errorCode: "insufficient_credits", _clientMessageId: "u1" }), {
      onTopUp,
      onRetrySend: vi.fn(),
      onRegenerate: vi.fn(),
      resolveRetryTarget: () => retryableUser,
    });
    expect(screen.getByRole("button", { name: "去充值" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
    expect(screen.queryByRole("button", { name: "重新尝试" })).toBeNull();
  });

  test("免单码(no_response)非可重试红卡 → 不显精确「重试」(保留 onRegenerate 兜底)", () => {
    // waived=true 分支:presentedError.waived 为真 → retryEligible false。
    renderErr(errMsg({ _errorCode: "no_response", _clientMessageId: "u1", usage: { waived: true } }), {
      onRegenerate: vi.fn(),
      resolveRetryTarget: () => retryableUser,
    });
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
  });
});
