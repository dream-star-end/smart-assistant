import "@testing-library/jest-dom/vitest";
import { USER_ERROR_CATALOG } from "@openclaude/protocol/browser";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../lib/chat/model";
import { AssistantCard, type CardCallbacks, type RenderCtx, TurnStatusCard } from "./cards";

vi.mock("../../lib/clientFriction", () => ({
  reportClientFriction: vi.fn(() => "eid"),
  reportClientFrictionOnce: vi.fn(() => "eid"),
  resetClientFrictionOnceForTests: vi.fn(),
}));

afterEach(cleanup);

const LAST: RenderCtx = { isLast: true, sending: false, inActiveTurn: true };
const TRACE = "0123456789abcdef0123456789abcdef";

function errorRow(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "a1",
    role: "assistant",
    text: "",
    ts: 1,
    _errorCode: "UPSTREAM_TIMEOUT",
    _clientMessageId: "m-client-1",
    _errorDetail: `[turn failed: ECONNRESET] 请求 ID：${TRACE}`,
    usage: { traceId: TRACE },
    ...over,
  } as ChatMessage;
}

function renderCard(msg: ChatMessage, cb: CardCallbacks = {}, ctx: RenderCtx = LAST) {
  render(<AssistantCard msg={msg} ctx={ctx} cb={cb} />);
  return screen.getByRole("alert");
}

/** 默认视图里看得到的文字(收起的技术详情不算)。 */
function visibleText(el: HTMLElement): string {
  const clone = el.cloneNode(true) as HTMLElement;
  for (const hidden of clone.querySelectorAll("[hidden]")) hidden.remove();
  return clone.textContent ?? "";
}

describe("终态错误卡说人话", () => {
  test("正文用错误目录的人话;错误码、请求 ID、消息 ID 不在默认视图里", () => {
    const card = renderCard(errorRow());
    expect(card).toHaveAttribute("data-notice-tone");
    expect(card).toHaveTextContent(USER_ERROR_CATALOG.upstream_timeout!.message);
    const shown = visibleText(card);
    for (const leak of ["UPSTREAM_TIMEOUT", "upstream_timeout", TRACE, "m-client-1", "ECONNRESET", "turn failed"]) {
      expect(shown).not.toContain(leak);
    }
  });

  test("技术详情展开后才有原始码和请求 ID,可复制", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const card = renderCard(errorRow());
    const details = within(card).getByTestId("error-tech-details");
    expect(details).not.toBeVisible();
    fireEvent.click(within(card).getByRole("button", { name: /技术详情/ }));
    expect(details).toBeVisible();
    expect(details).toHaveTextContent("错误码：UPSTREAM_TIMEOUT");
    expect(details).toHaveTextContent(`请求 ID：${TRACE}`);
    expect(details).toHaveTextContent("消息 ID：m-client-1");
    fireEvent.click(within(card).getByRole("button", { name: "复制" }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining(`请求 ID：${TRACE}`));
    expect(await within(card).findByRole("button", { name: "已复制" })).toBeInTheDocument();
  });

  test("回包带的 userError 优先于按码查目录", () => {
    const card = renderCard(errorRow({
      _userError: { ...USER_ERROR_CATALOG.upstream_timeout!, message: "服务端的新文案。" },
    }));
    expect(card).toHaveTextContent("服务端的新文案。");
  });

  test("旧回包的未知码:通用人话,不出原始码", () => {
    const card = renderCard(errorRow({ _errorCode: "CURSOR_SAND_SESSION_EXPIRED", _errorDetail: undefined, usage: undefined }));
    expect(card).toHaveTextContent(USER_ERROR_CATALOG.unexpected_error!.message);
    expect(visibleText(card)).not.toContain("CURSOR_SAND");
  });

  test("建议动作:目录给的重试 / 换模型,执行时走原来的入口", () => {
    const onRetrySend = vi.fn();
    const onOpenModelPicker = vi.fn();
    const source = { id: "m-client-1", role: "user", text: "原问题", ts: 0, status: "error" } as ChatMessage;
    const card = renderCard(errorRow({ _errorCode: "model_capacity" }), {
      onRetrySend,
      onOpenModelPicker,
      resolveRetryTarget: () => source,
    });
    const buttons = within(card).getAllByRole("button").map((b) => b.textContent);
    expect(buttons.slice(0, 2)).toEqual(["重试", "切换模型"]);
    fireEvent.click(within(card).getByRole("button", { name: "重试" }));
    expect(onRetrySend).toHaveBeenCalledWith(source);
    fireEvent.click(within(card).getByRole("button", { name: "切换模型" }));
    expect(onOpenModelPicker).toHaveBeenCalledTimes(1);
  });

  test("「联系管理员」走反馈入口并带上这条消息的追踪信息", () => {
    const onFeedback = vi.fn();
    // 未知码的目录建议是「联系管理员」;它是导航,历史卡上也给。
    const card = renderCard(errorRow({ _errorCode: "some_new_code" }), { onFeedback }, { ...LAST, inActiveTurn: false });
    fireEvent.click(within(card).getByRole("button", { name: "联系管理员" }));
    expect(onFeedback).toHaveBeenCalledWith(expect.objectContaining({ traceId: TRACE, errorCode: "some_new_code" }));
  });

  test("历史卡(不在最后一轮)不出重发类按钮", () => {
    const card = renderCard(errorRow({ _errorCode: "model_capacity" }), {
      onRegenerate: vi.fn(),
      onOpenModelPicker: vi.fn(),
    }, { isLast: false, sending: false, inActiveTurn: false });
    expect(within(card).queryByRole("button", { name: /重试|重新尝试/ })).toBeNull();
    expect(within(card).queryByRole("button", { name: "切换模型" })).toBeNull();
  });
});

describe("自动重试耗尽 / 暂停的终态卡", () => {
  const giveUp = (code: "automatic_retry_exhausted" | "automatic_retry_paused"): ChatMessage => ({
    id: "m-recovery-giveup-root",
    role: "assistant",
    text: "自动恢复已停止：已达到自动恢复次数上限。请直接再发一条消息继续，或新开一个会话。",
    ts: 2,
    _source: "server",
    _clientMessageId: "root",
    _userError: USER_ERROR_CATALOG[code],
  } as ChatMessage);

  test.each(["automatic_retry_exhausted", "automatic_retry_paused"] as const)("%s:人话 + 明确的出口动作", (code) => {
    const onOpenModelPicker = vi.fn();
    const onRegenerate = vi.fn();
    const card = renderCard(giveUp(code), { onOpenModelPicker, onRegenerate, onFeedback: vi.fn() });
    expect(card).toHaveTextContent("自动重试已停止");
    expect(card).toHaveTextContent(USER_ERROR_CATALOG[code]!.message);
    expect(within(card).getAllByRole("button").slice(0, 2).map((b) => b.textContent)).toEqual(["切换模型", "重新尝试"]);
    fireEvent.click(within(card).getByRole("button", { name: "重新尝试" }));
    expect(onRegenerate).toHaveBeenCalledTimes(1);
    // 服务端兼容正文不再另画一遍,也不挂复制 / 评价这类回答动作。
    expect(screen.queryByText(/自动恢复已停止：/)).toBeNull();
    expect(screen.queryByRole("button", { name: "复制" })).toBeNull();
    expect(visibleText(card)).not.toContain(code);
  });
});

describe("派发失败状态卡", () => {
  test("用 Notice,码只在技术详情", () => {
    render(
      <TurnStatusCard
        msg={{ id: "t1", role: "assistant", text: "", ts: 1, _errorCode: "dispatch_lost", _clientMessageId: "m1", _turnStatusRecord: true } as ChatMessage}
        cb={{ onRegenerate: vi.fn() }}
        currentTurn
      />,
    );
    const card = screen.getByRole("status");
    expect(card).toHaveTextContent("消息未能开始处理，已确认未计费，请重试。");
    expect(within(card).getByRole("button", { name: "重新尝试" })).toBeInTheDocument();
    expect(visibleText(card)).not.toContain("dispatch_lost");
  });

  test("附件合计超限状态卡说明 330MB 且没有继续按钮", () => {
    render(
      <TurnStatusCard
        msg={{ id: "t2", role: "assistant", text: "", ts: 1, _errorCode: "ATTACHMENT_TOTAL_EXCEEDED:345649213", _clientMessageId: "m2", _turnStatusRecord: true } as ChatMessage}
        cb={{
          onContinueInterrupted: vi.fn(),
          resolveInterruptedContinuation: () => ({ id: "m2", role: "user", text: "目标", ts: 0 } as ChatMessage),
          onRetrySend: vi.fn(),
          resolveRetryTarget: () => ({ id: "m2", role: "user", text: "目标", ts: 0 } as ChatMessage),
          onRegenerate: vi.fn(),
        }}
        currentTurn
      />,
    );
    const card = screen.getByRole("status");
    expect(card).toHaveTextContent("附件合计 330MB，超过 300MB 上限，请分两条发送");
    expect(card).not.toHaveTextContent("请重试");
    expect(within(card).queryByRole("button", { name: "继续" })).toBeNull();
    expect(within(card).queryByRole("button", { name: "重试" })).toBeNull();
    expect(within(card).queryByRole("button", { name: "重新尝试" })).toBeNull();
  });
});
