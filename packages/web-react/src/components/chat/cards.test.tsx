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
// 末轮错误卡(inActiveTurn:true = 位于最后一条 user 之后)。重发按钮的末轮门控(R5)据此放行。
const ERR_CTX: RenderCtx = { isLast: true, sending: false, inActiveTurn: true };
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
    // 末轮 + 兜底可用 → 「重新尝试」保留。
    expect(screen.getByRole("button", { name: "重新尝试" })).toBeInTheDocument();
  });
});

describe("AssistantCard 重发按钮末轮门控(Codex 审计 R5)", () => {
  // 历史中间错误卡:inActiveTurn=false(不在最后一条 user 之后)。
  const HIST_CTX: RenderCtx = { isLast: false, sending: false, inActiveTurn: false };

  test("历史中间错误卡(非末轮)→ 精确「重试」也不显(避免乱序重发历史消息)", () => {
    render(
      <AssistantCard
        msg={errMsg({ _clientMessageId: "u1" })}
        ctx={HIST_CTX}
        cb={{ onRetrySend: vi.fn(), onRegenerate: vi.fn(), resolveRetryTarget: () => retryableUser }}
      />,
    );
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
    expect(screen.queryByRole("button", { name: "重新尝试" })).toBeNull();
  });

  test("历史中间错误卡(非末轮)→ 「重新尝试」兜底也不显(onRegenerate 会重发最新一轮,无关内容)", () => {
    render(
      <AssistantCard
        msg={errMsg({ _clientMessageId: "u1" })}
        ctx={HIST_CTX}
        cb={{ onRetrySend: vi.fn(), onRegenerate: vi.fn(), resolveRetryTarget: () => undefined }}
      />,
    );
    expect(screen.queryByRole("button", { name: "重新尝试" })).toBeNull();
    // 标题/正文照旧:红卡仍在(标题可见),仅无重发按钮。
    expect(screen.getByText("模型服务暂时中断")).toBeInTheDocument();
  });

  test("历史中间错误卡的 model_capacity → 不显「切换模型」引导(引导只在末轮伴随重试按钮出现)", () => {
    render(
      <AssistantCard
        msg={errMsg({ _errorCode: "model_capacity", _clientMessageId: "u1" })}
        ctx={HIST_CTX}
        cb={{ onRetrySend: vi.fn(), onRegenerate: vi.fn(), resolveRetryTarget: () => retryableUser }}
      />,
    );
    expect(screen.queryByText(/切换模型/)).toBeNull();
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
  });

  test("历史 insufficient_credits 错误卡 → 「去充值」仍显(导航非重发,不受门控)", () => {
    render(
      <AssistantCard
        msg={errMsg({ _errorCode: "insufficient_credits", _clientMessageId: "u1" })}
        ctx={HIST_CTX}
        cb={{ onTopUp: vi.fn() }}
      />,
    );
    expect(screen.getByRole("button", { name: "去充值" })).toBeInTheDocument();
  });
});

describe("AssistantCard 失败轮部分正文(Codex 审计 R6)", () => {
  test("legacy tape 水合行:合法部分回答 + 尾部终止器 → 正文可见 + 红卡在下方,detail 无 JSON", () => {
    const raw =
      "第一步已经完成,以下是初步结果。\n\n[turn failed: Selected model is at capacity. Please try a different model.]\n";
    render(
      <AssistantCard
        msg={errMsg({
          _source: "server",
          _errorCode: "ENGINE_ERROR",
          text: raw,
        } as Partial<ChatMessage>)}
        ctx={ERR_CTX}
        cb={{ onRegenerate: vi.fn(), resolveRetryTarget: () => undefined }}
      />,
    );
    // R6:部分回答正文可见(Markdown 渲染)。
    expect(screen.getByText(/第一步已经完成/)).toBeInTheDocument();
    // 红卡标题非「出错了」(ENGINE_ERROR → 任务执行失败)。
    expect(screen.getByText("任务执行失败")).toBeInTheDocument();
    expect(screen.queryByText("出错了")).toBeNull();
    // detail 无 JSON 泄漏。
    expect(document.body.textContent ?? "").not.toMatch(/\{"|"error":|"status":/);
  });

  test("NO_RESPONSE(免单)水合行 → 免单文案,不误当部分正文渲染(waived 回归)", () => {
    render(
      <AssistantCard
        msg={errMsg({
          _source: "server",
          _errorCode: "NO_RESPONSE",
          text: "",
          usage: { waived: true },
        } as Partial<ChatMessage>)}
        ctx={ERR_CTX}
        cb={{ onRegenerate: vi.fn() }}
      />,
    );
    expect(screen.getByText("本轮已自动免单")).toBeInTheDocument();
    // 免单红卡:精确「重试」不显(waived → 非可重试)。
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
  });
});
