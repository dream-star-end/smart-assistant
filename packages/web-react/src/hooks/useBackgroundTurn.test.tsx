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

describe("useBackgroundTurn 提示条退场（独立横幅并入 QueuedSendList，无 10 秒残影）", () => {
  test("无论是否排队、断线或实扣积分，均不再弹出独立横幅也不留 10 秒残影", () => {
    vi.useFakeTimers({ now: T0 });
    expect(BACKGROUND_TURN_HOLD_MS).toBe(0);
    const sess = makeSess();
    const { result, rerender } = renderTurn({ sess, queuedCount: 0 });
    expect(result.current.notice).toBeNull();

    rerender({ sess, queuedCount: 1 });
    expect(result.current.notice).toBeNull();

    rerender({
      sess: makeSess({
        _turnCredits: { clientMessageId: "c1", settled: "1520", requests: 3, asOf: T0, receivedAt: T0 },
      }),
      queuedCount: 1,
      compact: true,
    });
    expect(result.current.notice).toBeNull();

    rerender({ sess, queuedCount: 0 });
    act(() => {
      vi.advanceTimersByTime(BACKGROUND_TURN_TICK_MS);
    });
    expect(result.current.notice).toBeNull();
  });
});

describe("BackgroundTurnBanner", () => {
  test("独立横幅组件已退场返回 null（排队与计费提醒由 QueuedSendList 与 TurnCostReminder 承接）", () => {
    const { container, rerender } = render(
      <BackgroundTurnBanner notice={{ text: BACKGROUND_TURN_TEXT, compact: false }} />,
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("background-turn-banner")).toBeNull();
    rerender(<BackgroundTurnBanner notice={{ text: BACKGROUND_TURN_TEXT_COMPACT, compact: true }} />);
    expect(container.firstChild).toBeNull();
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
