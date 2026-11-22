import "@testing-library/jest-dom/vitest";
import { act, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { MessageList, MessageRenderer } from "../../components/MessageRenderer";
import { FirstTextPaintCommitProbe } from "../../components/chat/FirstTextPaintCommitProbe";
import type { CardCallbacks } from "../../components/chat/cards";
import { type ChatCardActionsInput, useChatCardActions } from "../../hooks/useChatCardActions";
import { createMemoryAuthSession } from "../authSession";
import { captureIdentityAttempt, resolveIdentity } from "../resolvedIdentity";
import {
  classifyFirstTextPaintVisibility,
  resetFirstTextPaintVisibilityForTests,
} from "./firstTextPaintVisibility";
import type { ChatMessage } from "./model";
import { ChatSocket, type ChatSocketDeps } from "./socket";
import { prefetchMarkdownImpl } from "../../components/Markdown";
import { loadBeforeAll } from "../../test/moduleLoad";
import { preloadProcessStages } from "../../components/chat/lazyProcessStages";
import { preloadToolBody } from "../../components/tool/lazyToolBody";

// 渲染工具卡展开体的断言要等懒加载的 tool bodies;先在用例窗口外取好(src/test/moduleLoad.ts)。
loadBeforeAll(preloadToolBody);
// 进行中的过程外壳默认展开,时间轴在独立 chunk 里。先取好,首帧才能看到 process-stage。
loadBeforeAll(preloadProcessStages);

// 断言渲染后的 Markdown 正文要等懒加载的 MarkdownImpl;先在用例窗口外取好(src/test/moduleLoad.ts)。
loadBeforeAll(prefetchMarkdownImpl);

class FakeWS {
  static instances: FakeWS[] = [];
  static OPEN = 1;
  readyState = 0;
  bufferedAmount = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string, public protocols?: string | string[]) {
    FakeWS.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code: number, reason: string): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
    this.emit({ type: "sys.relay_ready" });
  }

  emit(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

function makeSocket(overrides: Partial<ChatSocketDeps> = {}): ChatSocket {
  return new ChatSocket({
    getToken: () => "token",
    getAuthEpoch: () => 0,
    silentRefresh: async (epoch) => ({ kind: "transient", epoch, retryAfterMs: 500 }),
    onAuthExpired: () => {},
    defaultAgentId: "main",
    ...overrides,
  });
}

function beginTurn(socket: ChatSocket, ws: FakeWS, sessionId: string): string {
  socket.sendMessage({
    sessId: sessionId,
    agentId: "main",
    text: "hello",
    model: "gpt-5.6-sol-1m",
  });
  const clientMessageId = socket.sessions.get(sessionId)!.messages.find(
    (message) => message.role === "user",
  )!.id;
  ws.emit({
    type: "outbound.ack",
    admitted: true,
    peer: { id: sessionId, kind: "dm" },
    clientMessageId,
  });
  return clientMessageId;
}

function textFrame(input: {
  sessionId: string;
  clientMessageId?: string;
  traceId: string;
  frameSeq: number;
  isFinal: boolean;
}) {
  return {
    type: "outbound.message",
    sessionKey: `agent:main:webchat:dm:${input.sessionId}`,
    channel: "webchat",
    peer: { id: input.sessionId, kind: "dm" },
    ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
    blocks: [{ kind: "text", text: "answer", messageId: "assistant-1" }],
    isFinal: input.isFinal,
    traceId: input.traceId,
    ts: Date.now(),
    frameSeq: input.frameSeq,
  };
}

function setDocumentVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => {
  for (const ws of FakeWS.instances) {
    if (ws.readyState === 1) ws.close(1000, "test");
  }
  FakeWS.instances = [];
  resetFirstTextPaintVisibilityForTests();
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("browser first-text paint telemetry", () => {
  test("live exact final-only text attaches one transient probe; legacy missing id cannot", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);

    const exact = makeSocket();
    exact.setGateReady(true);
    const exactWs = FakeWS.instances.at(-1)!;
    exactWs.open();
    const exactCmid = beginTurn(exact, exactWs, "s1");
    exactWs.emit(textFrame({
      sessionId: "s1",
      clientMessageId: exactCmid,
      traceId: "a".repeat(32),
      frameSeq: 1,
      isFinal: true,
    }));
    const assistant = exact.sessions.get("s1")!.messages.find((message) => message.role === "assistant")!;
    expect(assistant._firstTextPaintProbe).toMatchObject({
      traceId: "a".repeat(32),
      sessionId: "s1",
      clientMessageId: exactCmid,
    });
    expect(exact.toStored("s1")!.messages.find((message) => message.role === "assistant"))
      .not.toHaveProperty("_firstTextPaintProbe");
    exact.stop();

    const legacy = makeSocket();
    legacy.setGateReady(true);
    const legacyWs = FakeWS.instances.at(-1)!;
    legacyWs.open();
    beginTurn(legacy, legacyWs, "s2");
    legacyWs.emit(textFrame({
      sessionId: "s2",
      traceId: "b".repeat(32),
      frameSeq: 1,
      isFinal: false,
    }));
    const legacyAssistant = legacy.sessions.get("s2")!.messages.find(
      (message) => message.role === "assistant",
    );
    expect(legacyAssistant?._firstTextPaintProbe).toBeUndefined();
    legacy.stop();
  });

  test("reports only after the committed assistant DOM survives two animation frames", () => {
    const callbacks = new Map<number, FrameRequestCallback>();
    let rafId = 0;
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      rafId += 1;
      callbacks.set(rafId, callback);
      return rafId;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => {
      callbacks.delete(id);
    }));
    vi.spyOn(Date, "now").mockReturnValue(31_000);

    const onFirstTextPaint = vi.fn();
    const cb: CardCallbacks = { onFirstTextPaint };
    const message: ChatMessage = {
      id: "assistant-1",
      role: "assistant",
      text: "answer",
      ts: 30_500,
      _clientMessageId: "user-1",
      _turnOwnerId: "user-1",
      _firstTextPaintProbe: {
        traceId: "c".repeat(32),
        sessionId: "s1",
        clientMessageId: "user-1",
        startedAt: 1_000,
        backgroundAtFrame: false,
      },
    };

    const view = render(
      <MessageRenderer
        message={message}
        sig="assistant|answer"
        isLast
        sending
        inActiveTurn
        cb={cb}
        onRespondPermission={() => {}}
      />,
    );
    expect(screen.getByText("answer")).toBeInTheDocument();
    expect(onFirstTextPaint).not.toHaveBeenCalled();

    const flushAnimationFrame = () => {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback(0);
    };
    act(flushAnimationFrame);
    expect(onFirstTextPaint).not.toHaveBeenCalled();
    act(flushAnimationFrame);
    expect(onFirstTextPaint).toHaveBeenCalledTimes(1);
    expect(onFirstTextPaint).toHaveBeenCalledWith({
      traceId: "c".repeat(32),
      sessionId: "s1",
      clientMessageId: "user-1",
      latencyMs: 30_000,
      backgroundAtFrame: false,
      visibilityState: "visible",
      wasHidden: false,
      hiddenDurationMs: 0,
      visibleLatencyMs: 30_000,
      visibilityPath: "visible",
      visibilityReason: "hidden_0s",
    });

    view.rerender(
      <MessageRenderer
        message={message}
        sig="assistant|answer"
        isLast
        sending
        inActiveTurn
        cb={cb}
        onRespondPermission={() => {}}
      />,
    );
    act(flushAnimationFrame);
    act(flushAnimationFrame);
    expect(onFirstTextPaint).toHaveBeenCalledTimes(1);
  });
});

function animationFrames() {
  let id = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { callbacks.set(++id, cb); return id; });
  vi.stubGlobal("cancelAnimationFrame", (key: number) => callbacks.delete(key));
  return () => act(() => {
    const pending = [...callbacks.values()]; callbacks.clear();
    for (const cb of pending) cb(0);
  });
}

function probedMessage(): ChatMessage {
  return { id: "body-probe", role: "assistant", text: "live process answer", ts: 2000,
    _clientMessageId: "u-probe", _turnOwnerId: "u-probe",
    _firstTextPaintProbe: { traceId: "d".repeat(32), sessionId: "s-probe",
      clientMessageId: "u-probe", startedAt: 1000, backgroundAtFrame: false } };
}

test("MessageList reports live process narrative before final completion, once across remount", () => {
  const flush = animationFrames();
  const message = probedMessage();
  const probe = message._firstTextPaintProbe!;
  const onFirstTextPaint = vi.fn();
  const prefix: ChatMessage[] = [
    { id: "u-probe", role: "user", text: "hello", ts: 1000 },
    { id: "thinking-probe", role: "thinking", text: "thinking", ts: 1500, _turnOwnerId: "u-probe" },
  ];
  const view = render(<MessageList processDisclosure messages={[...prefix, message]} sending
    sessionId="s-probe" cb={{ onFirstTextPaint }} onRespondPermission={() => {}} />);
  expect(screen.getByTestId("process-stage")).toHaveTextContent("live process answer");
  flush();
  expect(onFirstTextPaint).not.toHaveBeenCalled();
  flush();
  expect(onFirstTextPaint).toHaveBeenCalledTimes(1);
  view.unmount();
  render(<MessageRenderer message={{ ...message, _firstTextPaintProbe: probe }} sig="final"
    isLast sending={false} inActiveTurn cb={{ onFirstTextPaint }} onRespondPermission={() => {}} />);
  flush(); flush();
  expect(onFirstTextPaint).toHaveBeenCalledTimes(1);
});

test("cancelled first frame can be reported after remount, simultaneous owners deduplicate", () => {
  const flush = animationFrames();
  const message = probedMessage();
  const onFirstTextPaint = vi.fn();
  const view = render(<FirstTextPaintCommitProbe message={message} onFirstTextPaint={onFirstTextPaint} />);
  flush(); view.unmount();
  render(<><FirstTextPaintCommitProbe message={message} onFirstTextPaint={onFirstTextPaint} />
    <FirstTextPaintCommitProbe message={{ ...message }} onFirstTextPaint={onFirstTextPaint} /></>);
  flush(); flush();
  expect(onFirstTextPaint).toHaveBeenCalledTimes(1);
});

test("an old paint callback does not delete a replacement probe; empty/error bodies do not report", () => {
  const flush = animationFrames();
  const message = probedMessage();
  const replacement = { ...message._firstTextPaintProbe!, traceId: "e".repeat(32) };
  const onFirstTextPaint = vi.fn();
  render(<FirstTextPaintCommitProbe message={message} onFirstTextPaint={onFirstTextPaint} />);
  message._firstTextPaintProbe = replacement;
  flush(); flush();
  expect(message._firstTextPaintProbe).toBe(replacement);
  const empty = { ...probedMessage(), text: " " };
  const error = { ...probedMessage(), _isError: true };
  render(<><FirstTextPaintCommitProbe message={empty} onFirstTextPaint={onFirstTextPaint} />
    <FirstTextPaintCommitProbe message={error} onFirstTextPaint={onFirstTextPaint} /></>);
  flush(); flush();
  expect(onFirstTextPaint).toHaveBeenCalledTimes(1);
});

describe("OCV5-40 first-text paint visibility context", () => {
  test("nocturnal mobile lockscreen during rAF wait marks wasHidden=true and classifies hidden_during_paint", () => {
    let now = 31_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const flush = animationFrames();
    const onFirstTextPaint = vi.fn();

    const message: ChatMessage = {
      id: "assistant-night",
      role: "assistant",
      text: "engine replied quickly",
      ts: 31_000,
      _clientMessageId: "u-night",
      _turnOwnerId: "u-night",
      _firstTextPaintProbe: {
        traceId: "f".repeat(32),
        sessionId: "s-night",
        clientMessageId: "u-night",
        startedAt: 1_000,
        frameAt: 31_000,
        backgroundAtFrame: false,
        hiddenBeforeFrame: false,
      },
    };

    render(<FirstTextPaintCommitProbe message={message} onFirstTextPaint={onFirstTextPaint} />);
    // Frame arrived while visible, then user locked phone before 2nd rAF fired (53 minutes hidden).
    now = 31_010;
    setDocumentVisibility("hidden");
    flush();
    now = 3_211_010;
    setDocumentVisibility("visible");
    now = 3_211_020;
    flush();

    expect(onFirstTextPaint).toHaveBeenCalledTimes(1);
    expect(onFirstTextPaint).toHaveBeenCalledWith({
      traceId: "f".repeat(32),
      sessionId: "s-night",
      clientMessageId: "u-night",
      latencyMs: 3_210_020,
      backgroundAtFrame: false,
      visibilityState: "visible",
      wasHidden: true,
      hiddenDurationMs: 3_180_000,
      visibleLatencyMs: 30_020,
      visibilityPath: "hidden_during_paint",
      visibilityReason: "hidden_15m_60m_mostly_hidden",
    });
  });

  test("tab hidden during wait and returned visible before frame arrival still sets hiddenBeforeFrame and wasHidden", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const flush = animationFrames();

    const socket = makeSocket();
    socket.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();

    const cmid = beginTurn(socket, ws, "s-wait");
    // User switches tab 1s after submit and returns 3 minutes later before frame arrives.
    now = 2_000;
    setDocumentVisibility("hidden");
    now = 182_000;
    setDocumentVisibility("visible");
    now = 183_000;

    ws.emit(textFrame({
      sessionId: "s-wait",
      clientMessageId: cmid,
      traceId: "1".repeat(32),
      frameSeq: 1,
      isFinal: true,
    }));

    const assistant = socket.sessions.get("s-wait")!.messages.find((m) => m.role === "assistant")!;
    expect(assistant._firstTextPaintProbe).toMatchObject({
      backgroundAtFrame: false,
      hiddenBeforeFrame: true,
      frameAt: 183_000,
    });

    const onFirstTextPaint = vi.fn();
    now = 183_020;
    render(<FirstTextPaintCommitProbe message={assistant} onFirstTextPaint={onFirstTextPaint} />);
    flush();
    flush();

    expect(onFirstTextPaint).toHaveBeenCalledTimes(1);
    expect(onFirstTextPaint).toHaveBeenCalledWith({
      traceId: "1".repeat(32),
      sessionId: "s-wait",
      clientMessageId: cmid,
      latencyMs: 182_020,
      backgroundAtFrame: false,
      visibilityState: "visible",
      wasHidden: true,
      hiddenDurationMs: 180_000,
      visibleLatencyMs: 2_020,
      visibilityPath: "hidden_during_wait",
      visibilityReason: "hidden_2m_15m_mostly_hidden",
    });
    socket.stop();
  });

  test("distinguishes slow engine (mostly_visible) from user away (mostly_hidden) and hidden_at_paint", () => {
    const slowEngine = classifyFirstTextPaintVisibility({
      latencyMs: 90_000,
      backgroundAtFrame: false,
      hiddenBeforeFrame: true,
      hiddenDuringPaint: false,
      visibilityState: "visible",
      hiddenDurationMs: 8_000,
    });
    expect(slowEngine).toEqual({
      wasHidden: true,
      visibilityPath: "hidden_during_wait",
      visibilityReason: "hidden_5s_30s_mostly_visible",
    });

    const stillHidden = classifyFirstTextPaintVisibility({
      latencyMs: 299_000,
      backgroundAtFrame: true,
      hiddenBeforeFrame: true,
      hiddenDuringPaint: true,
      visibilityState: "hidden",
      hiddenDurationMs: 297_000,
    });
    expect(stillHidden).toEqual({
      wasHidden: true,
      visibilityPath: "hidden_at_paint",
      visibilityReason: "hidden_2m_15m_mostly_hidden",
    });

    // All emitted tokens must satisfy the 0278 server CHECK constraints.
    for (const sample of [slowEngine, stillHidden]) {
      expect(sample.visibilityPath).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(sample.visibilityReason).toMatch(/^[a-z0-9_]{1,48}$/);
    }
  });

  test("useChatCardActions routes wasHidden=true to FIRST_TEXT_PAINT_AFTER_BACKGROUND with visibility path/reason on the wire", () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));

    const auth = createMemoryAuthSession(() => {}, "tok-paint");
    const input = {
      authRef: { current: auth },
      identity: resolveIdentity(captureIdentityAttempt(auth, "tok-paint"), "alice"),
      demo: false,
      activeId: "s-wire",
      communityBlogEnabled: true,
      chat: {},
      agent: { id: "main" },
      loadExactUserMessage: vi.fn(),
      setComposerPrefill: vi.fn(),
      toast: vi.fn(),
      openManage: vi.fn(),
      openBlog: vi.fn(),
      openPane: vi.fn(),
      openSettings: vi.fn(),
      setCollapsed: vi.fn(),
      setBoardOpen: vi.fn(),
    } as unknown as ChatCardActionsInput;
    const { result } = renderHook(() => useChatCardActions(input));
    const onFirstTextPaint = result.current.cardCallbacks.onFirstTextPaint!;

    onFirstTextPaint({
      traceId: "a".repeat(32),
      sessionId: "s-wire",
      clientMessageId: "u-fg",
      latencyMs: 2_400,
      backgroundAtFrame: false,
      visibilityState: "visible",
      wasHidden: false,
      hiddenDurationMs: 0,
      visibleLatencyMs: 2_400,
      visibilityPath: "visible",
      visibilityReason: "hidden_0s",
    });
    onFirstTextPaint({
      traceId: "b".repeat(32),
      sessionId: "s-wire",
      clientMessageId: "u-bg",
      latencyMs: 3_210_020,
      backgroundAtFrame: false,
      visibilityState: "visible",
      wasHidden: true,
      hiddenDurationMs: 3_180_000,
      visibleLatencyMs: 30_020,
      visibilityPath: "hidden_during_paint",
      visibilityReason: "hidden_15m_60m_mostly_hidden",
    });

    const bodies = fetchMock.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)));
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({
      surface: "webchat",
      stage: "first_text_paint",
      code: "FIRST_TEXT_PAINT",
      outcome: "succeeded",
      latency_ms: 2_400,
      trace_id: "a".repeat(32),
      session_id: "s-wire",
      path: "visible",
      reason: "hidden_0s",
    });
    expect(bodies[1]).toMatchObject({
      surface: "webchat",
      stage: "first_text_paint",
      code: "FIRST_TEXT_PAINT_AFTER_BACKGROUND",
      outcome: "succeeded",
      latency_ms: 3_210_020,
      trace_id: "b".repeat(32),
      session_id: "s-wire",
      path: "hidden_during_paint",
      reason: "hidden_15m_60m_mostly_hidden",
    });
  });
});
