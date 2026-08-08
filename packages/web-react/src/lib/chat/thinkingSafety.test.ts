import { afterEach, describe, expect, test, vi } from "vitest";
import { ChatSocket, messageAttemptIdempotencyKey, type ChatSocketDeps } from "./socket";
import { THINKING_SAFETY_MS } from "./pure";

/**
 * S3 thinking-safety 重构 + transient 软提示 + 发送失败重试的行为测试。
 *
 * 覆盖（对应任务红线要求）：
 *  - liveness 分流：连接死链 → 强制重连、不误报/不插消息；连接活 + 超帧 → transient 软提示；
 *  - transient 不入 messages、不落 IndexedDB（toStored 不含它）；
 *  - transient 清除时机（用户手动停止）；
 *  - retryMessage 复用原 payload 原地重发（不新增气泡、保留附件）。
 */

// FakeWS：可选 autoPong —— 收到 keepalive ping 后异步回 pong，使连接在快进 10min 期间
// 保持"确认存活"（真实死链场景 autoPong=false，keepalive 探活超时即 close→reconnect）。
class FakeWS {
  static instances: FakeWS[] = [];
  static autoPong = true;
  static OPEN = 1;
  url: string;
  protocols?: string | string[];
  readyState = 0;
  bufferedAmount = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed?: { code: number; reason: string };
  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    FakeWS.instances.push(this);
  }
  send(d: string) {
    this.sent.push(d);
    if (!FakeWS.autoPong) return;
    try {
      const f = JSON.parse(d) as { type?: string; id?: number };
      // 注意异步回 pong：pendingPing 在 safeWsSend 返回后才 set，同步回会错过匹配。
      if (f && f.type === "ping") {
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: "pong", id: f.id }) }), 0);
      }
    } catch {
      /* ignore */
    }
  }
  close(code: number, reason: string) {
    this.closed = { code, reason };
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
    this.onmessage?.({ data: JSON.stringify({ type: "sys.relay_ready" }) });
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

function anySent(pred: (d: string) => boolean): boolean {
  return FakeWS.instances.some((w) => w.sent.some(pred));
}

function admitLatest(sock: ChatSocket, ws: FakeWS, sessId = "s1"): void {
  const clientMessageId = [...sock.sessions.get(sessId)!.messages]
    .reverse()
    .find((message) => message.role === "user")!.id;
  ws.onmessage?.({ data: JSON.stringify({
    type: "outbound.ack",
    admitted: true,
    peer: { id: sessId, kind: "dm" },
    clientMessageId,
  }) });
}

describe("thinking-safety liveness 分流（S3）", () => {
  afterEach(() => {
    FakeWS.instances = [];
    FakeWS.autoPong = true;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test("连接活 + 10min 无帧 → transient 软提示（不发 stop、不插消息、不清 in-flight）", () => {
    vi.useFakeTimers();
    FakeWS.autoPong = true; // keepalive 有 pong → 连接确认存活
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const persistSession = vi.fn();
    const sock = makeSocket({ persistSession });
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "hi" });
    admitLatest(sock, ws);
    const s = sock.sessions.get("s1")!;
    const msgCountBefore = s.messages.length;

    vi.advanceTimersByTime(THINKING_SAFETY_MS + 2000);

    const notice = sock.getTransientNotice("s1");
    expect(notice?.text).toContain("较长时间未收到新内容");
    expect(s._sendingInFlight).toBe(true); // in-flight 未被清（turn 生死交给 server）
    expect(s.messages.length).toBe(msgCountBefore); // 没有插入任何消息
    expect(s.messages.some((m) => m._emptyTurn)).toBe(false);
    expect(anySent((d) => d.includes("inbound.control.stop"))).toBe(false); // 未自动 stop
    sock.stop();
  });

  test("连接死链 → 强制重连并把未受理 turn 安全回队列（无 stop / 无空轮消息 / 无 transient）", () => {
    vi.useFakeTimers();
    FakeWS.autoPong = false; // keepalive 无 pong → 链路未确认存活（死链）
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    FakeWS.instances.at(-1)!.open();
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "hi" });
    const s = sock.sessions.get("s1")!;

    vi.advanceTimersByTime(THINKING_SAFETY_MS + 5000);

    // 死链下：绝不产生"本轮无响应/超时"这类误报；未收到 durable admission 的
    // exact payload 回到 journal 队列，待新连接 relay-ready 后重放。
    expect(s.messages.some((m) => m._emptyTurn)).toBe(false);
    expect(anySent((d) => d.includes("inbound.control.stop"))).toBe(false);
    expect(sock.getTransientNotice("s1")).toBeNull();
    expect(s._sendingInFlight).toBeFalsy();
    expect(s.messages.find((message) => message.role === "user")?.status).toBe("queued");
    expect(sock.offlineQueue.filter((item) => item.sessId === "s1")).toHaveLength(1);
    expect(FakeWS.instances.length).toBeGreaterThan(1); // 死链已触发 close→reconnect
    sock.stop();
  });
});

describe("transient 软提示：不落 IndexedDB / 清除时机", () => {
  afterEach(() => {
    FakeWS.instances = [];
    FakeWS.autoPong = true;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test("transient 不进 messages、不进 toStored（不落盘）", () => {
    vi.useFakeTimers();
    FakeWS.autoPong = true;
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "hi" });
    admitLatest(sock, ws);

    vi.advanceTimersByTime(THINKING_SAFETY_MS + 2000);
    expect(sock.getTransientNotice("s1")).not.toBeNull(); // 已设置

    const stored = sock.toStored("s1")!;
    expect(JSON.stringify(stored)).not.toContain("较长时间未收到新内容"); // 序列化不含它
    expect((stored as Record<string, unknown>)._transientNotice).toBeUndefined();
    expect(stored.messages.some((m) => m._emptyTurn)).toBe(false);
    sock.stop();
  });

  test("用户手动停止 → 清除 transient 软提示", () => {
    vi.useFakeTimers();
    FakeWS.autoPong = true;
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "hi" });
    admitLatest(sock, ws);
    vi.advanceTimersByTime(THINKING_SAFETY_MS + 2000);
    expect(sock.getTransientNotice("s1")).not.toBeNull();

    sock.stopTurn("s1");
    expect(sock.getTransientNotice("s1")).toBeNull();
    expect(sock.sessions.get("s1")!._sendingInFlight).toBe(false);
  });
});

describe("retryMessage：发送失败原地重发", () => {
  afterEach(() => {
    FakeWS.instances = [];
    FakeWS.autoPong = true;
    vi.unstubAllGlobals();
  });

  test("复用原 payload（保留附件/保真文本），不新增气泡，状态回到 sent", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "带图问题", displayText: "看这张图", media: [{ path: "/x.png", kind: "image" } as never] });
    const s = sock.sessions.get("s1")!;
    const userMsg = s.messages.find((m) => m.role === "user")!;
    // 模拟先前发送失败：Stop 控制帧未进入传输，故不存在等待服务端终态的 settlement。
    ws.readyState = 0;
    sock.stopTurn("s1");
    ws.readyState = 1;
    userMsg.status = "error";
    ws.sent.length = 0;

    const userCountBefore = s.messages.filter((m) => m.role === "user").length;
    sock.retryMessage({ sessId: "s1", msgId: userMsg.id, agentId: "main" });

    // 不新增气泡（原地复用同一条）；物理 send 后仍等待 durable admission。
    expect(s.messages.filter((m) => m.role === "user").length).toBe(userCountBefore);
    expect(userMsg.status).toBe("sending");
    expect(s._sendingInFlight).toBeFalsy();
    // 重发帧复用 clientMessageId，只把持久化 attempt 从 0 精确推进到 1。
    const inbound = ws.sent.find((d) => d.includes('"inbound.message"'))!;
    expect(inbound).toBeTruthy();
    const frame = JSON.parse(inbound);
    expect(frame.idempotencyKey).toBe(messageAttemptIdempotencyKey(userMsg.id, 1));
    expect(userMsg._sendAttempt).toBe(1);
    expect(frame.content.text).toBe("带图问题"); // _modelText（含附件的完整模型可见文本）
    expect(Array.isArray(frame.content.media)).toBe(true);
    ws.onmessage?.({ data: JSON.stringify({
      type: "outbound.ack",
      admitted: true,
      peer: { id: "s1", kind: "dm" },
      clientMessageId: userMsg.id,
    }) });
    expect(userMsg.status).toBe("sent");
    expect(s._sendingInFlight).toBe(true);
  });

  test("非 error 消息 → no-op", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "hi" });
    const s = sock.sessions.get("s1")!;
    const userMsg = s.messages.find((m) => m.role === "user")!; // status = sent
    ws.sent.length = 0;
    sock.retryMessage({ sessId: "s1", msgId: userMsg.id, agentId: "main" });
    expect(ws.sent.some((d) => d.includes('"inbound.message"'))).toBe(false); // 未重发
  });
});
