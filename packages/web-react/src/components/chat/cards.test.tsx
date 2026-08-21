import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../lib/chat/model";
import { ChatInteractionContext } from "../tool/context";
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

function renderErr(msg: ChatMessage, cb: CardCallbacks, tokenUsage?: { totalTokens: number }) {
  render(<AssistantCard msg={msg} ctx={ERR_CTX} cb={cb} tokenUsage={tokenUsage} />);
}

describe("F3 UserCard 发送失败重试命中区", () => {
  test("仅有 transport error 时保留发送失败与 44px 重试出口", () => {
    const onRetrySend = vi.fn();
    render(<UserCard msg={userMsg({ status: "error" })} cb={{ onRetrySend }} />);
    expect(screen.getByText("发送失败")).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: /重试/ });
    // 对齐同批其它命中区写法（MessageRenderer 续轮按钮）：粗指针下 ≥44px。
    expect(btn).toHaveClass("[@media(hover:none)]:min-h-11");
    fireEvent.click(btn);
    expect(onRetrySend).toHaveBeenCalledTimes(1);
  });

  test("同一轮已有可见错误卡时隐藏重复的发送失败与重试", () => {
    render(
      <UserCard
        msg={userMsg({ status: "error" })}
        cb={{ onRetrySend: vi.fn() }}
        failurePresentedBelow
      />,
    );
    expect(screen.getByTestId("message-text")).toHaveTextContent("你好");
    expect(screen.queryByText("发送失败")).toBeNull();
    expect(screen.queryByRole("button", { name: /重试/ })).toBeNull();
  });

  test("非 error 态不渲染重试按钮", () => {
    render(<UserCard msg={userMsg({ status: "sent" })} cb={{ onRetrySend: () => {} }} />);
    expect(screen.queryByRole("button", { name: /重试/ })).toBeNull();
  });
});

describe("AssistantCard 预期错误视觉语义", () => {
  test("route unavailable 使用紧凑 warning 卡且无 trace 时不渲染详情", () => {
    renderErr(errMsg({
      _errorCode: "codex_route_unavailable",
      _clientMessageId: "u1",
      _errorDetail: "",
    }), {});

    const alert = screen.getByRole("alert");
    expect(alert).toHaveClass("border-warning/30", "px-3", "py-2");
    expect(alert).not.toHaveClass("border-danger/30");
    expect(alert).toHaveTextContent("模型服务暂时不可用");
    expect(alert).not.toHaveTextContent("GPT");
    expect(screen.queryByText("查看请求信息")).toBeNull();
  });
});

describe("消息引用动作与已发送引用块", () => {
  test("助手消息提供 44px 触控引用动作并回传原消息", () => {
    const onQuote = vi.fn();
    const message = { id: "a-quote", role: "assistant", text: "完整回答", ts: 1 } as ChatMessage;
    render(
      <AssistantCard
        msg={message}
        ctx={{ isLast: true, sending: false, inActiveTurn: true }}
        cb={{ onQuote }}
      />,
    );
    const button = screen.getByRole("button", { name: "引用" });
    expect(button).toHaveClass("[@media(hover:none)]:size-11");
    fireEvent.click(button);
    expect(onQuote).toHaveBeenCalledWith(message);
  });

  test("用户气泡展示完整引用快照的两行视觉块，并可继续被引用", () => {
    const onQuote = vi.fn();
    const message = userMsg({
      status: "sent",
      text: "请解释这一段",
      _replyTo: {
        messageId: "a-old",
        role: "assistant",
        text: "不会在数据层截断的完整历史回答",
      },
    });
    render(<UserCard msg={message} cb={{ onQuote }} />);
    expect(screen.getByText("从简")).toBeInTheDocument();
    const quoteText = screen.getByText("不会在数据层截断的完整历史回答");
    expect(quoteText).toHaveClass("line-clamp-2");
    fireEvent.click(screen.getByRole("button", { name: "引用" }));
    expect(onQuote).toHaveBeenCalledWith(message);
  });
});

describe("AssistantCard 红卡重试 CTA 硬门(任务④)", () => {
  test.each(["stopped", "user_cancelled"])(
    "%s 是用户主动终止：只显示中性状态，不显示红卡、详情或重试",
    (code) => {
      renderErr(errMsg({
        _errorCode: code,
        text: "本轮已取消。",
        _errorDetail: "本轮已取消。",
        usage: { traceId: "trace-stop" },
      }), {
        onRegenerate: vi.fn(),
      }, { totalTokens: 42 });

      expect(screen.getByRole("status", { name: "已停止生成" })).toBeInTheDocument();
      expect(screen.queryByText("本轮已取消。")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByRole("button", { name: /重试|重新尝试/ })).toBeNull();
      expect(screen.getByTestId("assistant-row").textContent?.trim()).toBe("已停止生成");
      expect(document.body.textContent).not.toContain("trace-stop");
      expect(document.body.textContent).not.toContain("42");
    },
  );

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

  test("cta=none 的非重试错误找不到精确目标时也不显示「重新尝试」", () => {
    renderErr(errMsg({ _errorCode: "bad_request" }), { onRegenerate: vi.fn() });
    expect(screen.queryByRole("button", { name: "重新尝试" })).toBeNull();
  });

  test("末轮 idle timeout 且有 durable 断点 → 优先显示「从断点继续」", () => {
    const onContinueInterrupted = vi.fn();
    const error = errMsg({
      _errorCode: "LIVENESS_TIMEOUT",
      _clientMessageId: "u1",
      usage: { waived: true },
    });
    renderErr(error, {
      onRegenerate: vi.fn(),
      onContinueInterrupted,
      resolveInterruptedContinuation: () => retryableUser,
    });
    fireEvent.click(screen.getByRole("button", { name: "从断点继续" }));
    expect(onContinueInterrupted).toHaveBeenCalledWith(error);
    expect(screen.queryByRole("button", { name: "重新尝试" })).toBeNull();
  });

  test("early terminal 后还有同轮过程（非页面尾行）→ marker 不取得续跑 CTA", () => {
    render(
      <AssistantCard
        msg={errMsg({ _errorCode: "idle_timeout", _clientMessageId: "u1" })}
        ctx={{ isLast: false, sending: false, inActiveTurn: true }}
        cb={{
          onRegenerate: vi.fn(),
          onContinueInterrupted: vi.fn(),
          resolveInterruptedContinuation: () => retryableUser,
        }}
      />,
    );
    expect(screen.queryByRole("button", { name: "从断点继续" })).toBeNull();
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


describe("AssistantCard options 多题聚合", () => {
  const idleCtx: RenderCtx = { isLast: true, sending: false, inActiveTurn: true };

  function fence(payload: object): string {
    return "```options\n" + JSON.stringify(payload) + "\n```";
  }

  test("流式正文尚无 options 块时不渲染空页脚", async () => {
    const sendUserText = vi.fn();
    render(
      <ChatInteractionContext.Provider value={{ sendUserText, busy: true }}>
        <AssistantCard
          msg={{ id: "a-opt-empty-live", role: "assistant", text: "正在分析部署顺序…", ts: 1 } as ChatMessage}
          ctx={{ isLast: true, sending: true, inActiveTurn: true }}
          cb={{}}
        />
      </ChatInteractionContext.Provider>,
    );
    expect(await screen.findByText("正在分析部署顺序…")).toBeTruthy();
    expect(screen.queryByText("发送选择")).toBeNull();
    expect(screen.queryByText(/已作答/)).toBeNull();
    expect(sendUserText).not.toHaveBeenCalled();
  });

  test("单块保持点击即发,不出现组页脚", async () => {
    const sendUserText = vi.fn();
    const text = fence({
      question: "选一个部署方式?",
      options: [
        { label: "灰度发布", desc: "先小流量" },
        { label: "全量发布" },
      ],
    });
    render(
      <ChatInteractionContext.Provider value={{ sendUserText }}>
        <AssistantCard
          msg={{ id: "a-opt-1", role: "assistant", text, ts: 1 } as ChatMessage}
          ctx={idleCtx}
          cb={{}}
        />
      </ChatInteractionContext.Provider>,
    );
    fireEvent.click(await screen.findByText("灰度发布"));
    expect(sendUserText).toHaveBeenCalledWith("我选择:灰度发布");
    expect(sendUserText).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("发送选择")).toBeNull();
    expect(screen.queryByText(/已作答/)).toBeNull();
  });

  test("多块点第一题不发送,答完后由页脚聚合成一条消息", async () => {
    const sendUserText = vi.fn();
    const text = [
      fence({ question: "风格?", options: [{ label: "正式" }, { label: "轻松" }] }),
      fence({
        question: "输出?",
        multi: true,
        options: [{ label: "要点" }, { label: "全文" }],
      }),
    ].join("\n\n");
    render(
      <ChatInteractionContext.Provider value={{ sendUserText }}>
        <AssistantCard
          msg={{ id: "a-opt-2", role: "assistant", text, ts: 1 } as ChatMessage}
          ctx={idleCtx}
          cb={{}}
        />
      </ChatInteractionContext.Provider>,
    );
    fireEvent.click(await screen.findByText("正式"));
    expect(sendUserText).not.toHaveBeenCalled();
    const sendBtn = await screen.findByRole("button", { name: "发送选择" });
    expect(sendBtn).toBeEnabled();
    fireEvent.click(screen.getByText("要点"));
    expect(sendBtn).toBeEnabled();
    fireEvent.click(sendBtn);
    expect(sendUserText).toHaveBeenCalledTimes(1);
    const sent = sendUserText.mock.calls[0][0] as string;
    expect(sent).toContain("我的选择:");
    expect(sent).toContain("风格?:正式");
    expect(sent).toContain("输出?:要点");
  });

  test("流式单块可点但不隐式发送,页脚聚合提交后锁定", async () => {
    const sendUserText = vi.fn();
    const text = fence({
      question: "选一个部署方式?",
      options: [
        { label: "灰度发布", desc: "先小流量" },
        { label: "全量发布" },
      ],
    });
    const msg = { id: "a-opt-live", role: "assistant", text, ts: 1 } as ChatMessage;
    render(
      <ChatInteractionContext.Provider value={{ sendUserText, busy: true }}>
        <AssistantCard
          msg={msg}
          ctx={{ isLast: true, sending: true, inActiveTurn: true }}
          cb={{}}
        />
      </ChatInteractionContext.Provider>,
    );
    const liveBtn = (await screen.findByText("灰度发布")).closest("button") as HTMLButtonElement;
    expect(liveBtn.disabled).toBe(false);
    expect(liveBtn.getAttribute("title")).toBeNull();
    expect(screen.queryByText("生成中")).toBeNull();
    fireEvent.click(liveBtn);
    expect(sendUserText).not.toHaveBeenCalled();
    expect(liveBtn.className).toContain("bg-accent-soft");
    const sendBtn = await screen.findByRole("button", { name: "发送选择" });
    expect(sendBtn).toBeEnabled();
    fireEvent.click(sendBtn);
    expect(sendUserText).toHaveBeenCalledTimes(1);
    const sent = sendUserText.mock.calls[0][0] as string;
    expect(sent).toContain("我的选择:");
    expect(sent).toContain("选一个部署方式?:灰度发布");
    expect(screen.getByText(/已发送全部选择/)).toBeTruthy();
    fireEvent.click(screen.getByText("全量发布"));
    expect(sendUserText).toHaveBeenCalledTimes(1);
  });

  test("流式多块至少答 1 题可提交,未答标 (未答)", async () => {
    const sendUserText = vi.fn();
    const text = [
      fence({ question: "风格?", options: [{ label: "正式" }, { label: "轻松" }] }),
      fence({
        question: "输出?",
        multi: true,
        options: [{ label: "要点" }, { label: "全文" }],
      }),
    ].join("\n\n");
    render(
      <ChatInteractionContext.Provider value={{ sendUserText, busy: true }}>
        <AssistantCard
          msg={{ id: "a-opt-live-multi", role: "assistant", text, ts: 1 } as ChatMessage}
          ctx={{ isLast: true, sending: true, inActiveTurn: true }}
          cb={{}}
        />
      </ChatInteractionContext.Provider>,
    );
    const liveBtn = (await screen.findByText("正式")).closest("button") as HTMLButtonElement;
    expect(liveBtn.disabled).toBe(false);
    fireEvent.click(liveBtn);
    expect(sendUserText).not.toHaveBeenCalled();
    const answered = (await screen.findByText(/已作答/)).textContent ?? "";
    expect(answered).toContain("1");
    expect(answered).toContain("2");
    const sendBtn = await screen.findByRole("button", { name: "发送选择" });
    expect(sendBtn).toBeEnabled();
    fireEvent.click(sendBtn);
    expect(sendUserText).toHaveBeenCalledTimes(1);
    const sent = sendUserText.mock.calls[0][0] as string;
    expect(sent).toContain("我的选择:");
    expect(sent).toContain("风格?:正式");
    expect(sent).toContain("输出?:(未答)");
    expect(screen.getByText(/已发送全部选择/)).toBeTruthy();
    fireEvent.click(screen.getByText("轻松"));
    fireEvent.click(screen.getByText("要点"));
    expect(sendUserText).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "发送选择" })).toBeNull();
  });

  test("多块部分作答可提交,聚合含未答,提交后锁定", async () => {
    const sendUserText = vi.fn();
    const text = [
      fence({ question: "风格?", options: [{ label: "正式" }, { label: "轻松" }] }),
      fence({
        question: "输出?",
        multi: true,
        options: [{ label: "要点" }, { label: "全文" }],
      }),
    ].join("\n\n");
    render(
      <ChatInteractionContext.Provider value={{ sendUserText }}>
        <AssistantCard
          msg={{ id: "a-opt-partial", role: "assistant", text, ts: 1 } as ChatMessage}
          ctx={idleCtx}
          cb={{}}
        />
      </ChatInteractionContext.Provider>,
    );
    fireEvent.click(await screen.findByText("正式"));
    expect(sendUserText).not.toHaveBeenCalled();
    const answered = (await screen.findByText(/已作答/)).textContent ?? "";
    expect(answered).toContain("1");
    expect(answered).toContain("2");
    const sendBtn = await screen.findByRole("button", { name: "发送选择" });
    expect(sendBtn).toBeEnabled();
    fireEvent.click(sendBtn);
    expect(sendUserText).toHaveBeenCalledTimes(1);
    const sent = sendUserText.mock.calls[0][0] as string;
    expect(sent).toContain("我的选择:");
    expect(sent).toContain("风格?:正式");
    expect(sent).toContain("输出?:(未答)");
    expect(screen.getByText(/已发送全部选择/)).toBeTruthy();
    fireEvent.click(screen.getByText("轻松"));
    fireEvent.click(screen.getByText("要点"));
    expect(sendUserText).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "发送选择" })).toBeNull();
  });
});
