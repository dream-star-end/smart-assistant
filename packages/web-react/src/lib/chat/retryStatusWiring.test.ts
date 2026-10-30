import { afterEach, describe, expect, test, vi } from "vitest";
import { ChatSocket } from "./socket";

/**
 * socket.ts 的实时接线(W3 FE-errors / FE-close):sys.recovery_status → 会话重试进度;
 * sys.context_rebuilt 按 noticeId 去重。纯函数行为见 retryStatus.test.ts / contextRebuilt.test.ts。
 */
class FakeWS {
  static instances: FakeWS[] = [];
  readyState = 0;
  bufferedAmount = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { FakeWS.instances.push(this); }
  send(d: string) { this.sent.push(d); }
  close(code: number, reason: string) { this.readyState = 3; this.onclose?.({ code, reason }); }
  open() {
    this.readyState = 1;
    this.onopen?.();
    this.onmessage?.({ data: JSON.stringify({ type: "sys.relay_ready" }) });
  }
  frame(f: object) { this.onmessage?.({ data: JSON.stringify(f) }); }
}

function open() {
  vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
  const sock = new ChatSocket({
    getToken: () => "tok",
    getAuthEpoch: () => 0,
    silentRefresh: async (epoch) => ({ kind: "transient", epoch, retryAfterMs: 500 }),
    onAuthExpired: () => {},
    defaultAgentId: "main",
  });
  sock.setGateReady(true);
  const ws = FakeWS.instances.at(-1)!;
  ws.open();
  sock.sendMessage({ sessId: "s1", agentId: "main", text: "hi" });
  const clientMessageId = sock.sessions.get("s1")!._activeClientMessageId!;
  ws.frame({ type: "outbound.ack", admitted: true, peer: { id: "s1", kind: "dm" }, clientMessageId });
  return { sock, ws, clientMessageId };
}

const running = (attempt: number) => ({
  state: "running", attempt, maxAttempts: 3, message: `正在自动重试（${attempt}/3）`, actions: [],
});

describe("socket 实时接线", () => {
  afterEach(() => {
    FakeWS.instances = [];
    vi.unstubAllGlobals();
  });

  test("sys.recovery_status 记下这一轮的真实进度,旧帧不回拨", () => {
    const { sock, ws, clientMessageId } = open();
    const status = (attempt: number, ts: number) => ({
      type: "sys.recovery_status", peer: { id: "s1", kind: "dm" },
      sourceClientMessageId: clientMessageId, rootClientMessageId: clientMessageId,
      clientMessageId: `m-recover-${attempt}`, retryStatus: running(attempt), ts,
    });
    ws.frame(status(2, 2000));
    ws.frame(status(1, 1000)); // 重放的旧帧
    expect(sock.sessions.get("s1")!._automaticRetryStatus).toMatchObject({
      rootClientMessageId: clientMessageId,
      status: { state: "running", attempt: 2, maxAttempts: 3 },
    });
    sock.stop();
  });

  test("sys.context_rebuilt 同一 noticeId 换了 frameSeq 也只提示一次", () => {
    const { sock, ws } = open();
    const rebuilt = (frameSeq: number) => ({
      type: "sys.context_rebuilt", peer: { id: "s1", kind: "dm" }, messageCount: 12,
      noticeId: "rebuild-1", reason: "engine-switch", frameSeq, ts: 9e12,
    });
    ws.frame(rebuilt(5));
    ws.frame(rebuilt(9));
    const rows = sock.sessions.get("s1")!.messages.filter((m) => m.role === "system");
    expect(rows).toHaveLength(1);
    expect(rows[0].id.startsWith("sys-ctxrebuild-")).toBe(true);
    sock.stop();
  });
});
