import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { MessageList } from "../../components/MessageRenderer";
import { ChatSocket, type ChatSocketDeps } from "./socket";
import type { ChatMessage, ChatSession } from "./model";

class FakeWS {
  static instances: FakeWS[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string, public protocols?: string | string[]) {
    FakeWS.instances.push(this);
  }
  send(data: string) { this.sent.push(data); }
  close(code = 1000, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
    this.onmessage?.({ data: JSON.stringify({ type: "sys.relay_ready" }) });
  }
}

function makeSocket(): ChatSocket {
  const deps: ChatSocketDeps = {
    getToken: () => "tok",
    getAuthEpoch: () => 0,
    silentRefresh: async (epoch) => ({ kind: "transient", epoch, retryAfterMs: 500 }),
    onAuthExpired: () => {},
    defaultAgentId: "main",
  };
  return new ChatSocket(deps);
}

function alerts(session: ChatSession): number {
  const view = render(
    <MessageList
      sessionId={session.id}
      messages={session.messages}
      sending={!!session._sendingInFlight}
      cb={{}}
      onRespondPermission={() => {}}
    />,
  );
  const count = screen.queryAllByRole("alert").length;
  view.unmount();
  return count;
}

function pending(sock: ChatSocket, sessionId: string): boolean {
  return (sock as unknown as { pendingRecoveryErrors: Map<string, unknown> })
    .pendingRecoveryErrors.has(sessionId);
}

function tape(session: ChatSession, fullText = ""): ChatMessage[] {
  const user = session.messages.find((message) => message.role === "user" && message.id === "m-user260");
  return [
    { ...user!, _source: "server" },
    {
      id: "srv-audit260-t1-s0",
      role: "assistant",
      text: fullText,
      ts: 3,
      _source: "server",
      _turnTapeId: "tape260",
      _turnTapeComplete: true,
      _clientMessageId: "m-user260",
      _errorCode: "model_capacity",
    } as ChatMessage,
  ];
}

function boot(id: string): { sock: ChatSocket; ws: FakeWS; session: ChatSession } {
  FakeWS.instances = [];
  vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
  const sock = makeSocket();
  sock.setGateReady(true);
  const ws = FakeWS.instances.at(-1)!;
  ws.open();
  ws.onmessage?.({
    data: JSON.stringify({ type: "sys.relay_ready", automaticRecoveryOwner: "master-v1" }),
  });
  const session = sock.ensureSession(id, "main");
  session.messages.push({
    id: "m-user260",
    role: "user",
    text: "test",
    ts: 1,
    status: "sent",
  });
  session._sendingInFlight = true;
  session._activeClientMessageId = "m-user260";
  return { sock, ws, session };
}

function sendError(ws: FakeWS, sessionId: string, frameSeq = 1, type: "outbound.error" | "error" = "outbound.error") {
  ws.onmessage?.({
    data: JSON.stringify({
      type,
      peer: { id: sessionId, kind: "dm" },
      clientMessageId: "m-user260",
      code: "model_capacity",
      message: "busy",
      ts: 2,
      frameSeq,
    }),
  });
}

afterEach(() => {
  cleanup();
  FakeWS.instances = [];
  vi.unstubAllGlobals();
});

describe("error card fence", () => {
  test("reload keeps an undecided source error from becoming a card", () => {
    for (const full of [true, false]) {
      const { sock, ws, session } = boot(`reload-${full}`);
      sendError(ws, session.id);
      (sock as unknown as { materializePendingRecoveryError(id: string, cause: string): void })
        .materializePendingRecoveryError(session.id, "decision_timeout");
      sock.applyServerMessages(session.id, "main", tape(session), full);
      expect(alerts(session)).toBe(0);
      expect(pending(sock, session.id)).toBe(true);
      expect(session._sendingInFlight).toBe(true);
      const stored = structuredClone(sock.toStored(session.id));
      expect(stored?._deferredTerminalErrorClientMessageId).toBe("m-user260");
      sock.stop();

      const fresh = makeSocket();
      fresh.loadStored(stored!);
      const restored = fresh.ensureSession(session.id, "main");
      fresh.applyServerMessages(restored.id, "main", tape(restored), full);
      expect(alerts(restored)).toBe(0);
      expect(pending(fresh, restored.id)).toBe(true);
      expect(restored._sendingInFlight).toBe(true);

      (fresh as unknown as { dispatch(frame: unknown): void }).dispatch({
        type: "sys.recovery_decision",
        peer: { id: restored.id, kind: "dm" },
        sourceClientMessageId: "m-user260",
        errorCode: "model_capacity",
        scheduled: false,
        reason: "exhausted",
        ts: 9,
      });
      expect(alerts(restored)).toBe(1);
      expect(restored._sendingInFlight).toBe(false);
      const card = restored.messages.find((message) => message._errorCardSnapshot?.disposition === "card");
      const frozen = card?._errorCardSnapshot;
      fresh.applyServerMessages(restored.id, "main", tape(restored, "later text"), full);
      expect(alerts(restored)).toBe(1);
      expect(card?._errorCardSnapshot).toEqual(frozen);
      fresh.stop();
    }
  });

  test("a stop before the first error does not paint that late error", () => {
    for (const type of ["outbound.error", "error"] as const) {
      for (const full of [true, false]) {
        const { sock, ws, session } = boot(`stop-${type}-${full}`);
        sock.stopTurn(session.id);
        expect(session._cancelledAutomaticRecoveryIds?.["m-user260"]).toBe(true);
        expect(alerts(session)).toBe(0);
        sendError(ws, session.id, 1, type);
        expect(alerts(session)).toBe(0);
        expect(session.messages.some((message) => message._errorCardSnapshot?.disposition === "card")).toBe(false);
        sock.applyServerMessages(session.id, "main", tape(session), full);
        expect(alerts(session)).toBe(0);
        expect(session.messages.some((message) => message._errorCardSnapshot?.disposition === "card")).toBe(false);
        sock.stop();
      }
    }
  });

  test("a card committed before stop stays put when a later error arrives", () => {
    const { sock, ws, session } = boot("keep-card");
    sendError(ws, session.id, 1);
    (sock as unknown as { dispatch(frame: unknown): void }).dispatch({
      type: "sys.recovery_decision",
      peer: { id: session.id, kind: "dm" },
      sourceClientMessageId: "m-user260",
      errorCode: "model_capacity",
      scheduled: false,
      reason: "exhausted",
      ts: 4,
    });
    expect(alerts(session)).toBe(1);
    const card = session.messages.find((message) => message._errorCardSnapshot?.disposition === "card");
    const frozen = structuredClone(card?._errorCardSnapshot);
    session._cancelledAutomaticRecoveryIds = { "m-user260": true };
    sendError(ws, session.id, 2);
    sock.applyServerMessages(session.id, "main", tape(session, "changed"), true);
    expect(card?._errorCardSnapshot).toEqual(frozen);
    expect(alerts(session)).toBe(1);
    sock.stop();
  });
});
