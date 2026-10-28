import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { BackgroundTurnBanner } from "../components/chat/BackgroundTurnBanner";
import { Composer } from "../components/Composer";
import { ToastProvider, useConfirm } from "../components/ui";
import {
  BACKGROUND_TURN_HOLD_MS,
  BACKGROUND_TURN_TEXT,
  BACKGROUND_TURN_TEXT_COMPACT,
  BACKGROUND_TURN_TICK_MS,
} from "../lib/chat/backgroundTurnNotice";
import type { ChatMessage, ChatSession } from "../lib/chat/model";
import type { ChatStatusClass } from "../lib/chat/pure";
import type { DispatchStatus } from "../lib/chat/socket";
import { type UseBackgroundTurnInput, useBackgroundTurn } from "./useBackgroundTurn";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const T0 = 1_800_000_000_000;

function makeSess(over: Partial<ChatSession> = {}): ChatSession {
  const now = Date.now();
  return {
    id: "s1",
    agentId: "main",
    title: "",
    messages: [{ id: "c1", role: "user", text: "帮我把日志整理成表格", ts: now } as ChatMessage],
    createdAt: now,
    lastAt: now,
    _sendingInFlight: true,
    _activeClientMessageId: "c1",
    _turnStartedAt: now,
    _lastFrameAt: now,
    ...over,
  } as ChatSession;
}

function makeChat(cls: ChatStatusClass = "connected", dispatch: DispatchStatus | null = null) {
  return {
    status: { cls } as UseBackgroundTurnInput["chat"]["status"],
    dispatchStatus: () => dispatch,
  };
}

type Props = Partial<Omit<UseBackgroundTurnInput, "chat">> & { cls?: ChatStatusClass; dispatch?: DispatchStatus | null };

function renderTurn(initial: Props) {
  const confirm = vi.fn(async () => true as const);
  const view = renderHook(
    ({ cls, dispatch, ...rest }: Props) =>
      useBackgroundTurn({
        chat: makeChat(cls, dispatch ?? null),
        sess: undefined,
        enabled: true,
        queuedCount: 0,
        compact: false,
        confirm,
        ...rest,
      }),
    { initialProps: initial },
  );
  return { ...view, confirm };
}

describe("useBackgroundTurn 提示条显隐(B4-SPEC §3.2)", () => {
  test("不在飞 → 不显示;在飞但帧新鲜、无排队 → 不显示", () => {
    vi.useFakeTimers({ now: T0 });
    const idle = makeSess({ _sendingInFlight: false });
    const { result, rerender } = renderTurn({ sess: idle });
    expect(result.current.notice).toBeNull();
    rerender({ sess: makeSess() });
    expect(result.current.notice).toBeNull();
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(result.current.notice).toBeNull();
  });

  test("hello 快照标了 detached、之后没有新帧 → 显示;桌面和窄屏文案不同", () => {
    vi.useFakeTimers({ now: T0 });
    const sess = makeSess({ _lastFrameAt: T0 - 1000, _turnDetachedAt: T0 });
    const { result, rerender } = renderTurn({ sess });
    expect(result.current.notice).toEqual({ text: BACKGROUND_TURN_TEXT, compact: false });
    rerender({ sess, compact: true });
    expect(result.current.notice).toEqual({ text: BACKGROUND_TURN_TEXT_COMPACT, compact: true });
  });

  test("静默跨过 30s 由自带节拍推进,不依赖 App 重渲", () => {
    vi.useFakeTimers({ now: T0 });
    const { result } = renderTurn({ sess: makeSess() });
    expect(result.current.notice).toBeNull();
    act(() => {
      vi.advanceTimersByTime(25_000);
    });
    expect(result.current.notice).toBeNull();
    act(() => {
      vi.advanceTimersByTime(30_000 - 25_000 + BACKGROUND_TURN_TICK_MS);
    });
    expect(result.current.notice?.text).toBe(BACKGROUND_TURN_TEXT);
  });

  test("有排队消息 → 显示;排队清空后保持 10 秒再消失", () => {
    vi.useFakeTimers({ now: T0 });
    const sess = makeSess();
    const { result, rerender } = renderTurn({ sess, queuedCount: 1 });
    expect(result.current.notice).not.toBeNull();
    // 有新帧、排队被泵出:触发全部消失,进入保持期。
    sess._lastFrameAt = Date.now();
    rerender({ sess, queuedCount: 0 });
    expect(result.current.notice).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(BACKGROUND_TURN_HOLD_MS - 1000);
    });
    sess._lastFrameAt = Date.now();
    rerender({ sess, queuedCount: 0 });
    expect(result.current.notice).not.toBeNull();
    // 节拍在 T0+10s 复检:保持期到点,无需 App 重渲就消失。
    act(() => {
      vi.advanceTimersByTime(BACKGROUND_TURN_TICK_MS);
    });
    expect(result.current.notice).toBeNull();
  });

  test("回合结束 / 开始停止结算 / 断线 / 受理前 → 立即消失,不走保持期", () => {
    vi.useFakeTimers({ now: T0 });
    for (const end of [
      { sess: makeSess({ _sendingInFlight: false }) },
      { sess: makeSess({ _stopSettlement: {} as ChatSession["_stopSettlement"] }) },
      { sess: makeSess(), cls: "disconnected" as const },
      { sess: makeSess(), cls: "connecting" as const },
      { sess: makeSess(), dispatch: { phase: "sending", queued: 1, serviceStarting: false } as DispatchStatus },
      { sess: makeSess(), enabled: false },
    ]) {
      const { result, rerender, unmount } = renderTurn({ sess: makeSess(), queuedCount: 1 });
      expect(result.current.notice).not.toBeNull();
      rerender({ queuedCount: 1, ...end });
      expect(result.current.notice).toBeNull();
      unmount();
    }
  });

  test("换了一轮(cmid 变)不继承上一轮的保持期", () => {
    vi.useFakeTimers({ now: T0 });
    const { result, rerender } = renderTurn({ sess: makeSess(), queuedCount: 1 });
    expect(result.current.notice).not.toBeNull();
    rerender({ sess: makeSess({ _activeClientMessageId: "c2" }), queuedCount: 0 });
    expect(result.current.notice).toBeNull();
  });

  test("断线后重连:保持期已被清掉,没有触发就不显示", () => {
    vi.useFakeTimers({ now: T0 });
    const sess = makeSess();
    const { result, rerender } = renderTurn({ sess, queuedCount: 1 });
    rerender({ sess, queuedCount: 0, cls: "disconnected" });
    expect(result.current.notice).toBeNull();
    rerender({ sess, queuedCount: 0, cls: "connected" });
    expect(result.current.notice).toBeNull();
  });
});

describe("BackgroundTurnBanner", () => {
  test("polite 读屏、不带动作按钮;桌面走横幅栈的居中容器,窄屏只留下边距", () => {
    const { rerender } = render(<BackgroundTurnBanner notice={{ text: BACKGROUND_TURN_TEXT, compact: false }} />);
    const banner = screen.getByTestId("background-turn-banner");
    expect(banner).toHaveAttribute("role", "status");
    expect(banner).toHaveTextContent(BACKGROUND_TURN_TEXT);
    expect(banner.parentElement).toHaveClass("mx-auto", "mb-2", "max-w-3xl", "px-4");
    expect(screen.queryByRole("button")).toBeNull();
    rerender(<BackgroundTurnBanner notice={{ text: BACKGROUND_TURN_TEXT_COMPACT, compact: true }} />);
    expect(screen.getByTestId("background-turn-banner").parentElement).toHaveClass("mb-2");
    expect(screen.getByTestId("background-turn-banner").parentElement).not.toHaveClass("max-w-3xl");
  });
});

/** Composer + useConfirm + guardSend:与 App 的接线同构。 */
function GuardHarness({
  sess,
  cls = "connected",
  send,
}: {
  sess: ChatSession;
  cls?: ChatStatusClass;
  send: (text: string) => Promise<boolean>;
}) {
  const [confirm, confirmEl] = useConfirm();
  const { guardSend } = useBackgroundTurn({
    chat: makeChat(cls),
    sess,
    enabled: true,
    queuedCount: 0,
    compact: false,
    confirm,
  });
  return (
    <ToastProvider>
      <Composer
        busy={!!sess._sendingInFlight}
        onStop={() => {}}
        onSend={(text, media) => guardSend(text, media, () => send(text))}
      />
      {confirmEl}
    </ToastProvider>
  );
}

async function queueText(text: string) {
  fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "排队发送" }));
  });
}

describe("「继续」软确认(B4-SPEC §3.5):只提示,不拦截", () => {
  test("本轮在跑时发「继续」→ 弹确认;选「先不发」→ 不发送、草稿还在、不提示已入队", async () => {
    const send = vi.fn(async () => true);
    render(<GuardHarness sess={makeSess()} send={send} />);
    await queueText("继续");
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("本轮还在运行，确定再发一条？");
    expect(dialog).toHaveTextContent("现在发送「继续」不会让它更快，只会在它结束后再开一轮，另行计费。");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "先不发" }));
    });
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveValue("继续");
    expect(screen.queryByText("已加入队列，本轮结束后发送")).toBeNull();
  });

  test("选「排队发送」→ 照常发送一次,草稿清空", async () => {
    const send = vi.fn(async () => true);
    render(<GuardHarness sess={makeSess()} send={send} />);
    await queueText("还在吗？");
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "排队发送" }));
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("还在吗？");
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(screen.getByText("已加入队列，本轮结束后发送")).toBeInTheDocument();
  });

  test("Esc 关闭等同「先不发」", async () => {
    const send = vi.fn(async () => true);
    render(<GuardHarness sess={makeSess()} send={send} />);
    await queueText("继续");
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveValue("继续");
  });

  test("实质性的新问题 → 不弹确认,直接进队列", async () => {
    const send = vi.fn(async () => true);
    render(<GuardHarness sess={makeSess()} send={send} />);
    await queueText("另外帮我查一下 X");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(send).toHaveBeenCalledWith("另外帮我查一下 X");
  });

  test("和正在运行的那条相同 → 弹「重复发送」确认", async () => {
    const send = vi.fn(async () => true);
    render(<GuardHarness sess={makeSess()} send={send} />);
    await queueText("帮我把日志整理成表格。");
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("这条和正在运行的那条相同");
    expect(dialog).toHaveTextContent("重复发送不会让它更快，只会在它结束后再跑一轮，另行计费。");
  });

  test("断线时标题改成「可能还在运行」(确认不要求已连接)", async () => {
    render(<GuardHarness sess={makeSess()} cls="disconnected" send={vi.fn(async () => true)} />);
    await queueText("继续");
    expect(screen.getByRole("dialog")).toHaveTextContent("本轮可能还在运行，确定再发一条？");
  });

  test("回合已结束 → 「继续」照常发送,不弹", async () => {
    const send = vi.fn(async () => true);
    render(<GuardHarness sess={makeSess({ _sendingInFlight: false })} send={send} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "继续" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "发送" }));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(send).toHaveBeenCalledWith("继续");
  });

  test("带附件、停止结算中、受理前 → 不弹", async () => {
    vi.useFakeTimers({ now: T0 });
    const cases: Props[] = [
      { sess: makeSess({ _stopSettlement: {} as ChatSession["_stopSettlement"] }) },
      { sess: makeSess(), dispatch: { phase: "sending", queued: 1, serviceStarting: false } },
      { sess: makeSess(), enabled: false },
    ];
    for (const props of cases) {
      const { result, confirm, unmount } = renderTurn(props);
      const run = vi.fn(() => "sent");
      await expect(result.current.guardSend("继续", undefined, run)).resolves.toBe("sent");
      expect(confirm).not.toHaveBeenCalled();
      unmount();
    }
    const { result, confirm } = renderTurn({ sess: makeSess() });
    const run = vi.fn(() => "sent");
    await expect(result.current.guardSend("继续", [{ kind: "image" }], run)).resolves.toBe("sent");
    expect(confirm).not.toHaveBeenCalled();
    await expect(result.current.guardSend("继续", [], run)).resolves.toBe("sent");
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});
