import "@testing-library/jest-dom/vitest";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { MessageRenderer } from "../../components/MessageRenderer";
import type { CardCallbacks } from "../../components/chat/cards";
import type { ChatMessage } from "./model";
import { ChatSocket, type ChatSocketDeps } from "./socket";

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

afterEach(() => {
  for (const ws of FakeWS.instances) {
    if (ws.readyState === 1) ws.close(1000, "test");
  }
  FakeWS.instances = [];
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
