/**
 * OCV5-428: a message that the server has not admitted yet must never be shown as
 * 「思考中」. Incident 2026-10-15 12:13: u3 container cold start (idle sweep), the
 * phone message sat in the local queue for ~90s while the footer said 「助手 思考中」.
 *
 * Harness copied from durableTurnDispatch.test.ts (FakeWS / makeSocket).
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { ChatSocket, type ChatSocketDeps } from "./socket";

class FakeWS {
  static instances: FakeWS[] = [];
  static OPEN = 1;
  url: string;
  readyState = 0;
  bufferedAmount = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeWS.instances.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close(code: number, reason: string) {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  /** Handshake only: the bridge has not confirmed the container relay yet. */
  handshake() {
    this.readyState = 1;
    this.onopen?.();
  }
  relayReady() {
    this.onmessage?.({ data: JSON.stringify({ type: "sys.relay_ready" }) });
  }
  serverClose(code: number, reason: string) {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

function makeSocket(overrides: Partial<ChatSocketDeps> = {}) {
  return new ChatSocket({
    getToken: () => "tok",
    getAuthEpoch: () => 0,
    silentRefresh: async (epoch) => ({ kind: "transient", epoch, retryAfterMs: 500 }),
    onAuthExpired: () => {},
    defaultAgentId: "main",
    ...overrides,
  });
}

function admit(ws: FakeWS, clientMessageId: string) {
  ws.onmessage?.({
    data: JSON.stringify({
      type: "outbound.ack",
      admitted: true,
      peer: { id: "s1", kind: "dm" },
      clientMessageId,
    }),
  });
}

function userIds(sock: ChatSocket): string[] {
  return sock.sessions.get("s1")!.messages.filter((m) => m.role === "user").map((m) => m.id);
}

describe("OCV5-428 dispatch status (pre-admission activity)", () => {
  afterEach(() => {
    FakeWS.instances = [];
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test("container still starting: queued message is `connecting`, never in-flight", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.handshake(); // bridge accepted the socket, ensureRunning still waiting
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "在吗" });
    const s = sock.sessions.get("s1")!;
    expect(s._sendingInFlight).toBeFalsy();
    expect(sock.isSessionBusy("s1")).toBe(true);
    expect(sock.getDispatchStatus("s1")).toEqual({ phase: "connecting", queued: 1, serviceStarting: false });

    // master gives up for now: 4503 starting → the provisioning signal is surfaced.
    ws.serverClose(4503, JSON.stringify({ retryAfterSec: 5, reason: "starting" }));
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "还有一条" });
    expect(sock.getDispatchStatus("s1")).toEqual({ phase: "connecting", queued: 2, serviceStarting: true });
  });

  test("on the wire without admission ACK is `sending`; the ACK clears it", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.handshake();
    ws.relayReady();
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "问题" });
    const s = sock.sessions.get("s1")!;
    const [id] = userIds(sock);
    // The composer keeps its stop affordance from the submit on (existing contract)…
    expect(s._sendingInFlight).toBe(true);
    // …but the activity row must not claim the model is thinking yet.
    expect(sock.getDispatchStatus("s1")).toEqual({ phase: "sending", queued: 1, serviceStarting: false });
    admit(ws, id!);
    expect(sock.getDispatchStatus("s1")).toBeNull();
    expect(s._sendingInFlight).toBe(true);
  });

  test("transport drops before the ACK: back to `connecting`", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.handshake();
    ws.relayReady();
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "问题" });
    expect(sock.getDispatchStatus("s1")?.phase).toBe("sending");
    ws.serverClose(1006, "drop");
    expect(sock.getDispatchStatus("s1")).toEqual({ phase: "connecting", queued: 1, serviceStarting: false });
    expect(sock.sessions.get("s1")!._sendingInFlight).toBeFalsy();
  });

  test("relay_ready after the cold start sends the queue and only the ACK yields 「思考中」", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.handshake();
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "排队的消息" });
    expect(ws.sent.some((raw) => raw.includes('"inbound.message"'))).toBe(false);
    ws.relayReady();
    expect(ws.sent.some((raw) => raw.includes('"inbound.message"'))).toBe(true);
    expect(sock.getDispatchStatus("s1")?.phase).toBe("sending");
    admit(ws, userIds(sock)[0]!);
    expect(sock.getDispatchStatus("s1")).toBeNull();
  });

  test("an admitted turn keeps its normal row while a follow-up waits in FIFO", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.handshake();
    ws.relayReady();
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "第一条" });
    admit(ws, userIds(sock)[0]!);
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "第二条" });
    expect(sock.isSessionBusy("s1")).toBe(true);
    expect(sock.getDispatchStatus("s1")).toBeNull();
  });

  test("idle session: no status", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.ensureSession("s1", "main");
    expect(sock.getDispatchStatus("s1")).toBeNull();
    expect(sock.getDispatchStatus("missing")).toBeNull();
  });

  test("resume_failed no_buffer (container recreated) backfills from history", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const syncSession = vi.fn(async () => true);
    const sock = makeSocket({ syncSession });
    sock.setGateReady(true);
    sock.ensureSession("s1", "main");
    const ws = FakeWS.instances.at(-1)!;
    ws.handshake();
    ws.relayReady();
    ws.onmessage?.({
      data: JSON.stringify({
        type: "outbound.resume_failed",
        sessionKey: "agent:main:webchat:dm:s1",
        channel: "webchat",
        peer: { id: "s1", kind: "dm" },
        from: 3500,
        to: 0,
        reason: "no_buffer",
      }),
    });
    expect(syncSession).toHaveBeenCalledWith("s1", undefined);
  });
});
