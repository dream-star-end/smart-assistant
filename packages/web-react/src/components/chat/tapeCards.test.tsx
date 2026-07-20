/** Direct timeline cards: process cursor, deferred exact record, runtime event. */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../lib/chat/model";
import { messageSignature } from "../../lib/chat/render";
import { MessageRenderer } from "../MessageRenderer";
import { TurnProcessCard, type CardCallbacks } from "./cards";
import { ResponseRatingProvider } from "./ResponseRating";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeAll(async () => {
  await import("../MarkdownImpl");
});

function renderMsg(message: ChatMessage, cb: CardCallbacks = {}) {
  return render(
    <MessageRenderer
      message={message}
      sig={messageSignature(message, { isLast: true, sending: false })}
      isLast
      sending={false}
      inActiveTurn
      cb={cb}
      onRespondPermission={() => {}}
    />,
  );
}

function processControl(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "turn-process:tape-1",
    role: "runtime-event",
    text: "",
    ts: 1000,
    _source: "server",
    _turnTapeProcess: true,
    _turnTapeProcessCount: 873,
    _turnTapeTotalBytes: 192 * 1024 * 1024,
    _dispatchOutcome: "completed",
    _turnTapeId: "tape-1",
    _turnTapeSha256: "sha-1",
    _clientMessageId: "cm-1",
    ...over,
  };
}

describe("TurnProcessCard", () => {
  test("process control automatically loads the true tail and never renders a folded Agent card", async () => {
    const onLoadOlderTape = vi.fn().mockResolvedValue({ ok: true, nextCursor: 200 });
    renderMsg(processControl(), { onLoadOlderTape });
    await waitFor(() => expect(onLoadOlderTape).toHaveBeenCalledWith(
      "turn-process:tape-1", "tape-1", null,
    ));
    expect(screen.queryByText(/Agent 调用过程|点击展开|收起/)).toBeNull();
  });

  test("without a read callback it reports unavailable without inventing Agent content", () => {
    renderMsg(processControl());
    expect(screen.getByText("真实记录暂时无法读取")).toBeInTheDocument();
    expect(screen.queryByText(/Agent 调用过程/)).toBeNull();
  });

  test("an initialized cursor requests the next older physical page without fold controls", async () => {
    const onLoadOlderTape = vi.fn().mockResolvedValue({ ok: true, nextCursor: 100 });
    renderMsg(processControl({ _turnTapeProcessExpanded: true, _turnTapeProcessCursor: 200 }), {
      onLoadOlderTape,
    });
    await waitFor(() => expect(onLoadOlderTape).toHaveBeenCalledWith(
      "turn-process:tape-1", "tape-1", 200,
    ));
    expect(screen.queryByText(/Agent 调用过程|继续加载更多|收起|截断|省略|替换/)).toBeNull();
  });

  test("cursor null removes the loader after every physical page is loaded", () => {
    renderMsg(processControl({ _turnTapeProcessExpanded: true, _turnTapeProcessCursor: null }), {
      onLoadOlderTape: vi.fn(),
    });
    expect(screen.queryByTestId("turn-process-loader")).toBeNull();
  });

  test("a history revision reset re-arms automatic tail loading on the same control", async () => {
    const observers: Array<{ trigger: (intersecting: boolean) => void }> = [];
    class FakeIntersectionObserver {
      constructor(private readonly callback: IntersectionObserverCallback) {
        observers.push({
          trigger: (intersecting) => this.callback(
            [{ isIntersecting: intersecting } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          ),
        });
      }
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords(): IntersectionObserverEntry[] { return []; }
      readonly root = null;
      readonly rootMargin = "0px";
      readonly thresholds = [0];
    }
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const onLoadOlderTape = vi.fn().mockResolvedValue({ ok: true, nextCursor: null });
    const cb = { onLoadOlderTape };
    const view = render(<TurnProcessCard msg={processControl()} cb={cb} />);

    act(() => observers.at(-1)!.trigger(true));
    await waitFor(() => expect(onLoadOlderTape).toHaveBeenCalledTimes(1));
    view.rerender(<TurnProcessCard msg={processControl({
      _turnTapeProcessExpanded: true,
      _turnTapeProcessCursor: null,
    })} cb={cb} />);
    view.rerender(<TurnProcessCard msg={processControl()} cb={cb} />);

    act(() => observers.at(-1)!.trigger(true));
    await waitFor(() => expect(onLoadOlderTape).toHaveBeenCalledTimes(2));
    expect(onLoadOlderTape).toHaveBeenNthCalledWith(2, "turn-process:tape-1", "tape-1", null);
  });
});

describe("deferred oversized immutable record", () => {
  const deferred: ChatMessage = {
    id: "srv-tool-large",
    role: "tool",
    text: "",
    ts: 1000,
    _source: "server",
    toolName: "Bash",
    _turnTapeId: "tape-1",
    _turnTapeSha256: "sha-1",
    _recordOrdinal: 7,
    _payloadDeferred: true,
    _payloadBytes: 52 * 1024 * 1024,
    _payloadSha256: "a".repeat(64),
  };

  test("loads and renders the exact record automatically near the viewport", async () => {
    const onFetchTapeRecordPayload = vi.fn().mockResolvedValue([{
      id: "srv-tool-large",
      role: "tool",
      text: "真实完整输出",
      output: "真实完整输出",
      ts: 1000,
      toolName: "Bash",
      _completed: true,
      futureField: { marker: "未来工具字段必须可见" },
    } as ChatMessage & { futureField: { marker: string } }]);
    renderMsg(deferred, { onFetchTapeRecordPayload });
    await waitFor(() => expect(onFetchTapeRecordPayload).toHaveBeenCalledWith(
      "tape-1",
      7,
      { recordId: "srv-tool-large", role: "tool", contentSha256: "a".repeat(64) },
      expect.any(AbortSignal),
    ));
    await waitFor(() => expect(screen.getByText("终端")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /终端/ }));
    expect(screen.getByText("真实完整输出")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看原始完整记录" }));
    expect(screen.getByText(/未来工具字段必须可见/)).toBeInTheDocument();
    expect(screen.queryByText(/前 4MB|内容过大|已截断/)).toBeNull();
  });

  test("loads an oversized user message without requiring tape identity", async () => {
    const userLocator: ChatMessage = {
      id: "cm:user:large",
      role: "user",
      text: "",
      ts: 1000,
      status: "replied",
      _source: "server",
      _payloadDeferred: true,
      _userPayloadDeferred: true,
      _payloadBytes: 12 * 1024 * 1024,
      _payloadSha256: "c".repeat(64),
    };
    const onFetchUserMessagePayload = vi.fn().mockResolvedValue([{
      id: "cm:user:large",
      role: "user",
      text: "这是用户真实提交的完整超长消息",
      ts: 1000,
      status: "sending",
    } satisfies ChatMessage]);
    renderMsg(userLocator, { onFetchUserMessagePayload });
    await waitFor(() => expect(onFetchUserMessagePayload).toHaveBeenCalledWith(
      "cm:user:large",
      { recordId: "cm:user:large", role: "user", contentSha256: "c".repeat(64) },
      expect.any(AbortSignal),
    ));
    expect(await screen.findByText("这是用户真实提交的完整超长消息")).toBeInTheDocument();
    expect(screen.queryByText(/Agent 记录/)).toBeNull();
  });

  test("fresh dispatch id hydrates the immutable pre-retry user sidecar after reload", async () => {
    const onRetrySend = vi.fn();
    const locator: ChatMessage = {
      id: "cm-fresh-dispatch",
      role: "user",
      text: "",
      ts: 1000,
      status: "error",
      _source: "server",
      _payloadDeferred: true,
      _userPayloadDeferred: true,
      _userPayloadId: "cm:old:sidecar",
      _payloadBytes: 12 * 1024 * 1024,
      _payloadSha256: "e".repeat(64),
    };
    const onFetchUserMessagePayload = vi.fn().mockResolvedValue([{
      id: "cm:old:sidecar",
      role: "user",
      text: "刷新后仍从旧 sidecar 水合的完整内容",
      ts: 1000,
    } satisfies ChatMessage]);
    renderMsg(locator, { onFetchUserMessagePayload, onRetrySend });
    await waitFor(() => expect(onFetchUserMessagePayload).toHaveBeenCalledWith(
      "cm:old:sidecar",
      { recordId: "cm:old:sidecar", role: "user", contentSha256: "e".repeat(64) },
      expect.any(AbortSignal),
    ));
    expect(await screen.findByText("刷新后仍从旧 sidecar 水合的完整内容")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetrySend).toHaveBeenCalledWith(expect.objectContaining({
      id: "cm-fresh-dispatch",
      _userPayloadId: "cm:old:sidecar",
      text: "刷新后仍从旧 sidecar 水合的完整内容",
    }));
  });

  test("deferred final keeps current billing overlays and the final-response rating", async () => {
    const locator: ChatMessage = {
      id: "srv-final-large",
      role: "assistant",
      text: "",
      ts: 1000,
      _source: "server",
      _turnTapeId: "tape-1",
      _turnTapeSha256: "sha-1",
      _recordOrdinal: 9,
      _payloadDeferred: true,
      _payloadSha256: "d".repeat(64),
      usage: { costCredits: "1234" },
    };
    const onFetchTapeRecordPayload = vi.fn().mockResolvedValue([{
      id: "srv-final-large",
      role: "assistant",
      text: "真实完整最终回答",
      ts: 1000,
      _completed: true,
      usage: { costCredits: "0", traceId: "trace-1" },
    } satisfies ChatMessage]);
    const callbacks = { onFetchTapeRecordPayload };
    const view = render(
      <ResponseRatingProvider value={{ ratings: new Map(), submit: () => {} }}>
        <MessageRenderer
          message={locator}
          sig={messageSignature(locator, { isLast: true, sending: false, turnFinalAssistant: true })}
          isLast
          sending={false}
          inActiveTurn
          turnFinalAssistant
          cb={callbacks}
          onRespondPermission={() => {}}
        />
      </ResponseRatingProvider>,
    );
    expect(await screen.findByText("真实完整最终回答")).toBeInTheDocument();
    expect(screen.getByLabelText("消耗 1234 积分")).toBeInTheDocument();
    expect(screen.getByText("这条回复怎么样?")).toBeInTheDocument();

    const waived = { ...locator, usage: { costCredits: "1234", waived: true } };
    view.rerender(
      <ResponseRatingProvider value={{ ratings: new Map(), submit: () => {} }}>
        <MessageRenderer
          message={waived}
          sig={messageSignature(waived, { isLast: true, sending: false, turnFinalAssistant: true })}
          isLast
          sending={false}
          inActiveTurn
          turnFinalAssistant
          cb={callbacks}
          onRespondPermission={() => {}}
        />
      </ResponseRatingProvider>,
    );
    expect(await screen.findByLabelText("本轮已免单")).toBeInTheDocument();
    expect(screen.queryByLabelText("消耗 1234 积分")).toBeNull();
  });

  test("transient failure offers retry instead of a permanent placeholder", async () => {
    const onFetchTapeRecordPayload = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce([{
        id: "srv-tool-large",
        role: "tool",
        text: "恢复后的真实输出",
        output: "恢复后的真实输出",
        ts: 1000,
        toolName: "Bash",
        _completed: true,
      } satisfies ChatMessage]);
    renderMsg(deferred, { onFetchTapeRecordPayload });
    const retry = await screen.findByRole("button", { name: "真实记录加载失败，点击重试" });
    fireEvent.click(retry);
    await waitFor(() => expect(onFetchTapeRecordPayload).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText("终端")).toBeInTheDocument());
  });

  test("unmount outside virtual-scroll overscan cancels its payload subscription", async () => {
    let signal: AbortSignal | undefined;
    const onFetchTapeRecordPayload = vi.fn((
      _tapeId: string,
      _ordinal: number,
      _expected: { recordId: string; role: string; contentSha256?: string },
      requestSignal?: AbortSignal,
    ) => {
      signal = requestSignal;
      return new Promise<ChatMessage[] | null>(() => {});
    });
    const view = renderMsg(deferred, { onFetchTapeRecordPayload });
    await vi.waitFor(() => expect(onFetchTapeRecordPayload).toHaveBeenCalledTimes(1));
    expect(signal?.aborted).toBe(false);

    view.unmount();
    expect(signal?.aborted).toBe(true);
  });

  test("legacy locator without a visible hash still starts the HEAD/range loader", async () => {
    const onFetchTapeRecordPayload = vi.fn().mockResolvedValue([{
      id: "srv-tool-large",
      role: "tool",
      text: "旧会话真实输出",
      output: "旧会话真实输出",
      ts: 1000,
      toolName: "Bash",
      _completed: true,
    } satisfies ChatMessage]);
    renderMsg({ ...deferred, _payloadSha256: undefined }, { onFetchTapeRecordPayload });
    await waitFor(() => expect(onFetchTapeRecordPayload).toHaveBeenCalledWith(
      "tape-1",
      7,
      { recordId: "srv-tool-large", role: "tool" },
      expect.any(AbortSignal),
    ));
  });
});

describe("runtime event", () => {
  test("raw persisted event is inspectable and never silently filtered", () => {
    renderMsg({
      id: "runtime-1",
      role: "runtime-event",
      text: "",
      ts: 1,
      _runtimeSource: "gateway",
      _runtimeEvent: { type: "progress", subtype: "tool_delta", exact: "原始事件" },
    });
    fireEvent.click(screen.getByRole("button", { name: /progress · tool_delta/ }));
    expect(screen.getByText(/原始事件/)).toBeInTheDocument();
  });
});
