/**
 * durable turn dispatch(RFC-v5-durable-turn-dispatch)前端行为断言。
 * 覆盖:hello 在飞身份上报、turn_state_unknown 对账+保发送态、reconcile 归属 exact 匹配、
 * REST 终态收敛(清发送态+user 行终态)、durable status 渲染/抑制、重试 clientMessageId 分流。
 *
 * 构造风格照 lib/chat/chat.test.ts:sess() / msgFrame() / FakeWS / makeSocket()。
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { addMessage, createSession, type ChatMessage } from "./model";
import { applyOutboundMessage } from "./reducer";
import {
  collectResolvedDispatchTurnIds,
  errorPresentation,
  isDispatchLostCode,
  isDispatchTerminalRow,
  isTurnStatusSuppressedByTape,
} from "./render";
import { detectServerTerminalTurns } from "../persist";
import { ChatSocket, messageAttemptIdempotencyKey, type ChatSocketDeps } from "./socket";
import type { OutboundMessageWire } from "./frames";

// ─── helpers（照 chat.test.ts）────────────────────────────────────────
function sess(id = "s1", agentId = "main") {
  return createSession({ id, agentId });
}
type AnyFrame = Record<string, unknown>;
function msgFrame(over: AnyFrame): OutboundMessageWire {
  return {
    type: "outbound.message",
    sessionKey: "agent:main:webchat:dm:s1",
    channel: "webchat",
    peer: { id: "s1", kind: "dm" },
    blocks: [],
    isFinal: false,
    ...over,
  } as unknown as OutboundMessageWire;
}
function srvRow(over: Partial<ChatMessage>): ChatMessage {
  return { id: "x", role: "assistant", text: "", ts: 1, _source: "server", ...over } as ChatMessage;
}

class FakeWS {
  static instances: FakeWS[] = [];
  // autoPong：收到 keepalive ping 异步回 pong,使连接在快进期间保持「确认存活」(照 thinkingSafety.test.ts)。
  static autoPong = false;
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
function helloFrames(ws: FakeWS): Array<{
  peers: Array<Record<string, unknown>>;
  automaticRecoveryOwner?: string;
}> {
  return ws.sent
    .filter((raw) => raw.includes('"inbound.hello"'))
    .map((raw) => JSON.parse(raw) as {
      peers: Array<Record<string, unknown>>;
      automaticRecoveryOwner?: string;
    });
}

// ═══════════════ 1. hello 携带在飞 turn 身份 ═══════════════
describe("hello inFlightClientMessageId (RFC §4)", () => {
  afterEach(() => {
    FakeWS.instances = [];
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test("重连 hello 在 _sendingInFlight 时携带 _activeClientMessageId,收尾后不携带", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    const ws1 = FakeWS.instances.at(-1)!;
    ws1.open();
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "在飞问题" });
    const s = sock.sessions.get("s1")!;
    const userId = s.messages.find((m) => m.role === "user")!.id;
    expect(s._sendingInFlight).toBe(true);
    expect(s._activeClientMessageId).toBe(userId);
    ws1.onmessage?.({ data: JSON.stringify({
      type: "outbound.ack",
      admitted: true,
      peer: { id: "s1", kind: "dm" },
      clientMessageId: userId,
    }) });
    expect(s._sendingInFlight).toBe(true);

    // 断连 → 退避重连 → 新 ws onopen 发 hello(includeInFlight)。
    ws1.readyState = 3;
    ws1.onclose?.({ code: 1006, reason: "drop" });
    await vi.advanceTimersByTimeAsync(60_000);
    const ws2 = FakeWS.instances.at(-1)!;
    expect(ws2).not.toBe(ws1);
    ws2.open();
    const helloInflight = helloFrames(ws2).at(-1)!;
    expect(helloInflight.automaticRecoveryOwner).toBe("master-v1");
    expect(helloInflight.peers[0]).toMatchObject({ inFlight: true, inFlightClientMessageId: userId });

    // 收尾后再重连 → inFlight=false 且不带 inFlightClientMessageId。
    ws2.onmessage?.({ data: JSON.stringify(msgFrame({ frameSeq: 1, ts: Date.now(), blocks: [], isFinal: true })) });
    expect(s._sendingInFlight).toBe(false);
    ws2.readyState = 3;
    ws2.onclose?.({ code: 1006, reason: "drop" });
    await vi.advanceTimersByTimeAsync(60_000);
    const ws3 = FakeWS.instances.at(-1)!;
    ws3.open();
    const helloIdle = helloFrames(ws3).at(-1)!;
    expect(helloIdle.peers[0].inFlight).toBe(false);
    expect(helloIdle.peers[0].inFlightClientMessageId).toBeUndefined();
    sock.stop();
  });

  test("only an explicit master-v1 relay owner disables browser semantic recovery", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);

    const masterOwned = makeSocket();
    masterOwned.setGateReady(true);
    const masterWs = FakeWS.instances.at(-1)!;
    masterWs.open();
    masterWs.onmessage?.({ data: JSON.stringify({
      type: "sys.relay_ready",
      automaticRecoveryOwner: "master-v1",
    }) });
    const masterRecovery = vi.spyOn(masterOwned as any, "autoRecoverTerminalTurn");
    (masterOwned as any).effects().scheduleAutomaticRecovery("s-master", "u-master");
    await vi.advanceTimersByTimeAsync(0);
    expect(masterRecovery).not.toHaveBeenCalled();

    const legacy = makeSocket();
    legacy.setGateReady(true);
    FakeWS.instances.at(-1)!.open(); // relay_ready without an owner = rolling legacy peer
    const legacyRecovery = vi.spyOn(legacy as any, "autoRecoverTerminalTurn");
    (legacy as any).effects().scheduleAutomaticRecovery("s-legacy", "u-legacy");
    await vi.advanceTimersByTimeAsync(0);
    expect(legacyRecovery).toHaveBeenCalledWith("s-legacy", "u-legacy");

    masterOwned.stop();
    legacy.stop();
  });
});

// ═══════════════ 2. turn_state_unknown ═══════════════
describe("reconcile turn_state_unknown (RFC §4)", () => {
  test("非 final:保发送态 + forceSync(带 clientMessageId)+ onTurnStateUnknown", () => {
    const s = sess();
    const u = addMessage(s, "user", "问题", { status: "sent" });
    s._replyingToMsgId = u.id;
    s._sendingInFlight = true;
    s._activeClientMessageId = u.id;
    const forceSync = vi.fn();
    const onTurnStateUnknown = vi.fn();
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 1,
        ts: Date.now(),
        isFinal: false,
        blocks: [],
        clientMessageId: u.id,
        meta: { reconcile: "turn_state_unknown" },
      }),
      { forceSync, onTurnStateUnknown },
    );
    // **绝不清发送态**(turn 可能仍在执行,静默清态=丢 turn)。
    expect(s._sendingInFlight).toBe(true);
    expect(s._activeClientMessageId).toBe(u.id);
    expect(forceSync).toHaveBeenCalledWith("s1", { clientMessageId: u.id });
    expect(onTurnStateUnknown).toHaveBeenCalledWith("s1");
  });

  test("turn_state_unknown 把 thinking-safety 首窗降至 ~60s → 缩短生效(远早于默认 10min)", () => {
    vi.useFakeTimers();
    FakeWS.autoPong = true; // keepalive 有 pong → 连接确认存活,快进期间走 (b) 软提示分支
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const syncSession = vi.fn();
    const sock = makeSocket({ syncSession });
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "长任务" });
    const s = sock.sessions.get("s1")!;
    const userId = s.messages.find((m) => m.role === "user")!.id;
    ws.onmessage?.({
      data: JSON.stringify(
        msgFrame({
          frameSeq: 1,
          ts: Date.now(),
          isFinal: false,
          blocks: [],
          clientMessageId: userId,
          meta: { reconcile: "turn_state_unknown" },
        }),
      ),
    });
    expect(s._sendingInFlight).toBe(true);

    // ~60s 即触发 thinking-safety(b) → 挂 transient 软提示(缩短窗生效的可观测证据),且仍不清发送态。
    vi.advanceTimersByTime(61_000);
    expect(sock.getTransientNotice("s1")?.text).toContain("较长时间未收到新内容");
    expect(s._sendingInFlight).toBe(true);
    sock.stop();
    vi.useRealTimers();
    FakeWS.instances = [];
    FakeWS.autoPong = false;
    vi.unstubAllGlobals();
  });

  test("对照:无 turn_state_unknown 时 ~62s 内不触发 thinking-safety(默认 10min 窗未到)", () => {
    vi.useFakeTimers();
    FakeWS.autoPong = true;
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "长任务" });
    vi.advanceTimersByTime(62_000);
    expect(sock.getTransientNotice("s1")).toBeNull();
    sock.stop();
    vi.useRealTimers();
    FakeWS.instances = [];
    FakeWS.autoPong = false;
    vi.unstubAllGlobals();
  });
});

// ═══════════════ 3. reconcile 归属 exact clientMessageId ═══════════════
describe("reconcile turn_completed/interrupted 归属 exact 匹配 (RFC §4)", () => {
  test("exact 命中 active turn → 清发送态 + forceSync 带 id", () => {
    const s = sess();
    const u = addMessage(s, "user", "问题", { status: "sent" });
    s._replyingToMsgId = u.id;
    s._sendingInFlight = true;
    s._activeClientMessageId = u.id;
    const forceSync = vi.fn();
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 1,
        ts: Date.now(),
        isFinal: true,
        blocks: [],
        clientMessageId: u.id,
        meta: { reconcile: "turn_completed" },
      }),
      { forceSync },
    );
    expect(s._sendingInFlight).toBe(false);
    expect(s._activeClientMessageId).toBeUndefined();
    expect(forceSync).toHaveBeenCalledWith("s1", { clientMessageId: u.id });
  });

  test("旧轮 turn_completed reconcile 命中新轮 → **不清**新轮 sending,只对账旧轮", () => {
    const s = sess();
    const uNew = addMessage(s, "user", "新一轮", { status: "sent" });
    s._replyingToMsgId = uNew.id;
    s._sendingInFlight = true;
    s._activeClientMessageId = uNew.id;
    const forceSync = vi.fn();
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 1,
        ts: Date.now(),
        isFinal: true,
        blocks: [],
        clientMessageId: "cm-old-turn",
        meta: { reconcile: "turn_completed" },
      }),
      { forceSync },
    );
    // 旧轮 final 绝不误杀新轮发送态(R3 端上闭合)。
    expect(s._sendingInFlight).toBe(true);
    expect(s._activeClientMessageId).toBe(uNew.id);
    expect(forceSync).toHaveBeenCalledWith("s1", { clientMessageId: "cm-old-turn" });
  });

  test("interrupted reconcile 同样按 exact id 收口 active turn", () => {
    const s = sess();
    const u = addMessage(s, "user", "问题", { status: "sent" });
    s._sendingInFlight = true;
    s._activeClientMessageId = u.id;
    const forceSync = vi.fn();
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 1,
        ts: Date.now(),
        isFinal: true,
        blocks: [],
        clientMessageId: u.id,
        meta: { reconcile: "interrupted" },
      }),
      { forceSync },
    );
    expect(s._sendingInFlight).toBe(false);
    expect(forceSync).toHaveBeenCalledWith("s1", { clientMessageId: u.id });
  });
});

// ═══════════════ 4. detectServerTerminalTurns + REST 终态收敛 ═══════════════
describe("detectServerTerminalTurns (persist)", () => {
  test("typed durable status 单行 → error", () => {
    const m = detectServerTerminalTurns([
      srvRow({
        id: "turn-status:d1",
        role: "system",
        _turnStatusRecord: true,
        _dispatchTerminal: true,
        _errorCode: "dispatch_lost",
        _clientMessageId: "cm1",
      }),
    ]);
    expect(m.get("cm1")).toBe("error");
  });
  test("service_restart 终态 → interrupted，不伪装成发送失败", () => {
    const m = detectServerTerminalTurns([
      srvRow({
        id: "turn-status:d2",
        role: "system",
        _turnStatusRecord: true,
        _dispatchTerminal: true,
        _errorCode: "service_restart",
        _clientMessageId: "cm2",
      }),
    ]);
    expect(m.get("cm2")).toBe("interrupted");
  });
  test("server-authored 生成行 → completed", () => {
    const m = detectServerTerminalTurns([srvRow({ id: "srv-a-t1-s0", text: "答复", _clientMessageId: "cm1" })]);
    expect(m.get("cm1")).toBe("completed");
  });
  test("只有 plan/runtime-event 的 finalized tape 也能收敛丢失的 final WS", () => {
    const m = detectServerTerminalTurns([
      srvRow({
        id: "plan-only",
        role: "plan",
        text: "完成部署",
        _clientMessageId: "cm-plan",
        _turnTapeComplete: true,
        _dispatchOutcome: "completed",
      }),
      srvRow({
        id: "runtime-only",
        role: "runtime-event",
        text: "真实运行事件",
        _clientMessageId: "cm-interrupted",
        _turnTapeComplete: true,
        _dispatchOutcome: "interrupted",
      }),
    ]);
    expect(m.get("cm-plan")).toBe("completed");
    expect(m.get("cm-interrupted")).toBe("completed");
  });
  test("只有非正文角色的 crashed finalized tape 收敛为 error", () => {
    const m = detectServerTerminalTurns([
      srvRow({
        id: "goal-crashed",
        role: "goal",
        text: "目标状态",
        _clientMessageId: "cm-crashed",
        _turnTapeComplete: true,
        _dispatchOutcome: "crashed",
      }),
    ]);
    expect(m.get("cm-crashed")).toBe("error");
  });
  test("completed 覆盖 error(真 tape 胜过短暂残留状态)", () => {
    const m = detectServerTerminalTurns([
      srvRow({ id: "turn-status:d1", role: "system", _turnStatusRecord: true, _dispatchTerminal: true,
        _errorCode: "dispatch_lost", _clientMessageId: "cm1" }),
      srvRow({ id: "srv-a-t1-s0", text: "答复", _clientMessageId: "cm1" }),
    ]);
    expect(m.get("cm1")).toBe("completed");
  });
  test("无 _clientMessageId 的行不入证据", () => {
    const m = detectServerTerminalTurns([srvRow({ id: "srv-x", text: "答复" })]);
    expect(m.size).toBe(0);
  });
});

describe("REST sync 终态收敛 applyServerMessages (RFC §5 M5)", () => {
  afterEach(() => {
    FakeWS.instances = [];
    vi.unstubAllGlobals();
  });

  test("durable not_accepted status 到达 → 清发送态 + user 行置 error 以保留重试", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "会丢的消息" });
    const s = sock.sessions.get("s1")!;
    const cmid = s.messages.find((m) => m.role === "user")!.id;
    ws.onmessage?.({ data: JSON.stringify({
      type: "outbound.ack",
      admitted: true,
      peer: { id: "s1", kind: "dm" },
      clientMessageId: cmid,
    }) });
    expect(s._sendingInFlight).toBe(true);

    sock.applyServerMessages(
      "s1",
      "main",
      [srvRow({ id: "turn-status:d1", role: "system", _seq: 2, _turnStatusRecord: true,
        _dispatchTerminal: true, _errorCode: "dispatch_lost", _clientMessageId: cmid })],
      true,
      2,
      { serverUpdatedAt: 100 },
    );

    expect(s._sendingInFlight).toBe(false);
    expect(s._activeClientMessageId).toBeUndefined();
    const userRow = s.messages.find((m) => m.role === "user" && m.id === cmid)!;
    expect(userRow.status).toBe("error");
    sock.stop();
  });

  test("service_restart status 到达 → 清发送态 + 已成功送达的 user 行保持 sent", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    sock.sendMessage({ sessId: "s-restart", agentId: "main", text: "已经开始处理" });
    const s = sock.sessions.get("s-restart")!;
    const cmid = s.messages.find((m) => m.role === "user")!.id;
    ws.onmessage?.({ data: JSON.stringify({
      type: "outbound.ack",
      admitted: true,
      peer: { id: "s-restart", kind: "dm" },
      clientMessageId: cmid,
    }) });

    sock.applyServerMessages(
      "s-restart",
      "main",
      [srvRow({ id: "turn-status:d2", role: "system", _seq: 2, _turnStatusRecord: true,
        _dispatchTerminal: true, _errorCode: "service_restart", _clientMessageId: cmid })],
      true,
      2,
      { serverUpdatedAt: 100 },
    );

    expect(s._sendingInFlight).toBe(false);
    expect(s._activeClientMessageId).toBeUndefined();
    const userRow = s.messages.find((m) => m.role === "user" && m.id === cmid)!;
    expect(userRow.status).toBe("sent");
    sock.stop();
  });

  test("completed server 行到达 → 清发送态 + user 行置 replied", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "已完成但丢了 final" });
    const s = sock.sessions.get("s1")!;
    const cmid = s.messages.find((m) => m.role === "user")!.id;
    ws.onmessage?.({ data: JSON.stringify({
      type: "outbound.ack",
      admitted: true,
      peer: { id: "s1", kind: "dm" },
      clientMessageId: cmid,
    }) });

    sock.applyServerMessages(
      "s1",
      "main",
      [srvRow({ id: "srv-a-t1-s0", _seq: 2, text: "服务端已生成的答复", _clientMessageId: cmid })],
      true,
      2,
      { serverUpdatedAt: 100 },
    );

    expect(s._sendingInFlight).toBe(false);
    const userRow = s.messages.find((m) => m.role === "user" && m.id === cmid)!;
    expect(userRow.status).toBe("replied");
    sock.stop();
  });

  test("REST terminal authority also settles a Stop whose live final was lost", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const deletePendingControl = vi.fn().mockResolvedValue(undefined);
    const sock = makeSocket({ deletePendingControl });
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "stop then lose final" });
    const s = sock.sessions.get("s1")!;
    const cmid = s.messages.find((m) => m.role === "user")!.id;
    sock.stopTurn("s1");
    const controlId = s._stopSettlement!.controlId!;

    sock.applyServerMessages(
      "s1",
      "main",
      [srvRow({ id: "srv-stop-final", _seq: 2, text: "stopped", _clientMessageId: cmid })],
      true,
      2,
      { serverUpdatedAt: 100 },
    );

    expect(s._stopSettlement).toBeUndefined();
    expect(s._sendingInFlight).toBe(false);
    expect(deletePendingControl).toHaveBeenCalledWith("s1", controlId);
    sock.stop();
  });

  test("非活跃轮的终态证据不误清其他会话的发送态", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "在飞轮" });
    const s = sock.sessions.get("s1")!;
    const cmid = s.messages.find((m) => m.role === "user")!.id;
    ws.onmessage?.({ data: JSON.stringify({
      type: "outbound.ack",
      admitted: true,
      peer: { id: "s1", kind: "dm" },
      clientMessageId: cmid,
    }) });
    // 载荷只带一个**不同** clientMessageId 的终态行 → 不动当前活跃轮。
    sock.applyServerMessages(
      "s1",
      "main",
      [srvRow({ id: "turn-status:dz", role: "system", _seq: 2, _turnStatusRecord: true,
        _dispatchTerminal: true, _errorCode: "dispatch_lost", _clientMessageId: "cm-别的轮" })],
      true,
      2,
      { serverUpdatedAt: 100 },
    );
    expect(s._sendingInFlight).toBe(true);
    sock.stop();
  });
});

// ═══════════════ 5. durable status 渲染映射 + 抑制 ═══════════════
describe("durable failure status 渲染 (RFC §5)", () => {
  test("errorPresentation dispatch_lost → 免单 tone + 未计费文案", () => {
    const p = errorPresentation("dispatch_lost", "", undefined);
    expect(p.waived).toBe(true);
    expect(p.message).toContain("未能开始处理");
    expect(p.message).toContain("未计费");
  });
  test("errorPresentation SERVICE_RESTART(大小写归一)→ 免单 tone", () => {
    const p = errorPresentation("SERVICE_RESTART", "", undefined);
    expect(p.waived).toBe(true);
    expect(p.title).toBe("任务已中断");
    expect(p.message).toContain("此前已生成的过程已完整保留");
  });
  test("isDispatchLostCode", () => {
    expect(isDispatchLostCode("dispatch_lost")).toBe(true);
    expect(isDispatchLostCode("SERVICE_RESTART")).toBe(true);
    expect(isDispatchLostCode("dispatch_not_accepted")).toBe(true); // MIN2
    expect(isDispatchLostCode("engine_error")).toBe(false);
    expect(isDispatchLostCode(undefined)).toBe(false);
  });
  test("errorPresentation dispatch_not_accepted → 免单 tone(MIN2)", () => {
    const p = errorPresentation("DISPATCH_NOT_ACCEPTED", "", undefined);
    expect(p.waived).toBe(true);
    expect(p.message).toContain("未能开始处理");
    expect(p.message).toContain("未计费");
  });
  test("isDispatchTerminalRow 去枚举化重试判据(M5)", () => {
    // ① server 持久标记 _dispatchTerminal(code-agnostic)。
    expect(isDispatchTerminalRow({ id: "srv-x", _dispatchTerminal: true })).toBe(true);
    // ② 不可变 tape 稳定协议码(service_restart / dispatch_not_accepted)。
    expect(isDispatchTerminalRow({ id: "srv-y", _errorCode: "SERVICE_RESTART" })).toBe(true);
    expect(isDispatchTerminalRow({ id: "srv-z", _errorCode: "dispatch_not_accepted" })).toBe(true);
    // 普通错误 / 无标记 → 不命中(不误伤,复用旧 id 走 dedup 保护)。
    expect(isDispatchTerminalRow({ id: "srv-w", _errorCode: "engine_error" })).toBe(false);
    expect(isDispatchTerminalRow({ id: "srv-v" })).toBe(false);
    expect(isDispatchTerminalRow(null)).toBe(false);
  });
  test("同 _clientMessageId 存在真 tape 生成行 → 抑制 stale status(渲染层双保险)", () => {
    const status = srvRow({ id: "turn-status:d1", role: "system", _turnStatusRecord: true,
      _dispatchTerminal: true, _errorCode: "dispatch_lost", _clientMessageId: "cm1" });
    const completed = srvRow({ id: "srv-a-t1-s0", text: "答复", _clientMessageId: "cm1" });
    const resolved = collectResolvedDispatchTurnIds([status, completed]);
    expect(resolved.has("cm1")).toBe(true);
    expect(isTurnStatusSuppressedByTape(status, resolved)).toBe(true);
  });
  test("仅 durable status(无真 tape 行)→ 不抑制,状态卡正常渲染", () => {
    const status = srvRow({ id: "turn-status:d1", role: "system", _turnStatusRecord: true,
      _dispatchTerminal: true, _errorCode: "dispatch_lost", _clientMessageId: "cm1" });
    const resolved = collectResolvedDispatchTurnIds([status]);
    expect(isTurnStatusSuppressedByTape(status, resolved)).toBe(false);
  });
});

// ═══════════════ 6. 重试 clientMessageId 分流 ═══════════════
describe("retryMessage clientMessageId 分流 (RFC §5)", () => {
  afterEach(() => {
    FakeWS.instances = [];
    vi.unstubAllGlobals();
  });

  test("dispatch 终态失败 → 铸新 clientMessageId(新逻辑 turn)+ 清旧轮 status", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    const replyTo = {
      messageId: "assistant-before-retry",
      role: "assistant" as const,
      text: "必须随新 turn 原样保留的完整引用",
    };
    sock.sendMessage({
      sessId: "s1",
      agentId: "main",
      text: "会丢的消息",
      replyTo,
    });
    const s = sock.sessions.get("s1")!;
    const userMsg = s.messages.find((m) => m.role === "user")!;
    const oldId = userMsg.id;
    // 模拟 dispatch 终态:发送态清空、user 行 error、durable status 到位。
    sock.stopTurn("s1");
    const stopped = s._stopSettlement!;
    ws.onmessage?.({ data: JSON.stringify({
      type: "outbound.control.receipt",
      controlId: stopped.controlId,
      controlKind: "stop",
      status: "terminal",
      peer: { id: "s1", kind: "dm" },
      clientMessageId: oldId,
    }) });
    userMsg.status = "error";
    s.messages.push(
      srvRow({ id: "turn-status:d1", role: "system", _seq: 2, _turnStatusRecord: true,
        _dispatchTerminal: true, _errorCode: "dispatch_lost", _clientMessageId: oldId }),
    );
    ws.sent.length = 0;

    sock.retryMessage({ sessId: "s1", msgId: oldId, agentId: "main" });

    // user 行拿到**新** id = 新 clientMessageId。
    expect(userMsg.id).not.toBe(oldId);
    const inbound = ws.sent.map((raw) => JSON.parse(raw)).find((f) => f.type === "inbound.message");
    expect(inbound.clientMessageId).toBe(userMsg.id);
    expect(inbound.clientMessageId).not.toBe(oldId);
    expect(inbound.replyToId).toBe(replyTo.messageId);
    expect(inbound.content).toEqual({
      text: "会丢的消息",
      replyTo,
    });
    // 新逻辑 turn 从 attempt 0 起,幂等键绑新 id。
    expect(inbound.idempotencyKey).toBe(messageAttemptIdempotencyKey(userMsg.id, 0));
    expect(userMsg._sendAttempt).toBe(0);
    // 旧轮 status 被清。
    expect(s.messages.some((m) => m.id === "turn-status:d1")).toBe(false);
    sock.stop();
  });

  test("deferred + dispatch 终态 + offline 后 reload 仍保留旧 exact sidecar locator", () => {
    const sock = makeSocket();
    sock.ensureSession("s1", "main");
    const s = sock.sessions.get("s1")!;
    const staleId = "cm-deferred-terminal";
    const locator = addMessage(s, "user", "", {
      id: staleId,
      status: "error",
      _source: "server",
      _payloadDeferred: true,
      _userPayloadDeferred: true,
      _userPayloadId: staleId,
      _payloadBytes: 8_000_000,
      _payloadSha256: "a".repeat(64),
      _routing: { model: "gpt-5.6-terra", teamMode: false, effortLevel: "high" },
      _deferredRetryEligible: true,
    });
    s.messages.push(srvRow({
      id: "turn-status:deferred",
      role: "system",
      _turnStatusRecord: true,
      _dispatchTerminal: true,
      _clientMessageId: staleId,
    }));
    const exact = {
      ...locator,
      text: "旧 sidecar 中的完整超长提问",
      _payloadDeferred: undefined,
      _userPayloadDeferred: undefined,
    } satisfies ChatMessage;

    // No open WebSocket: the fresh dispatch cannot create its server sidecar.
    sock.retryMessage({ sessId: "s1", msgId: staleId, agentId: "main", sourceOverride: exact });
    expect(locator.id).not.toBe(staleId);
    expect(locator.status).toBe("queued");
    expect(locator._userPayloadId).toBe(staleId);

    const stored = sock.toStored("s1")!;
    const persisted = stored.messages.find((message) => message.id === locator.id)!;
    expect(persisted._userPayloadId).toBe(staleId);
    expect(persisted.text).toBe("");

    const reloaded = makeSocket();
    reloaded.loadStored(stored);
    const restored = reloaded.sessions.get("s1")!.messages.find((message) => message.id === locator.id)!;
    expect(restored._userPayloadDeferred).toBe(true);
    expect(restored._userPayloadId).toBe(staleId);
    expect(restored.text).toBe("");
    sock.stop();
    reloaded.stop();
  });

  test("resend-uncertain(普通发送失败)→ 复用旧 id + attempt 递增(dedup 保护)", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "网络抖动" });
    const s = sock.sessions.get("s1")!;
    const userMsg = s.messages.find((m) => m.role === "user")!;
    const oldId = userMsg.id;
    // 普通失败:无 dispatch 终态证据。
    sock.stopTurn("s1");
    const stopped = s._stopSettlement!;
    ws.onmessage?.({ data: JSON.stringify({
      type: "outbound.control.receipt",
      controlId: stopped.controlId,
      controlKind: "stop",
      status: "terminal",
      peer: { id: "s1", kind: "dm" },
      clientMessageId: oldId,
    }) });
    userMsg.status = "error";
    ws.sent.length = 0;

    sock.retryMessage({ sessId: "s1", msgId: oldId, agentId: "main" });

    // 复用旧 id,不铸新。
    expect(userMsg.id).toBe(oldId);
    const inbound = ws.sent.map((raw) => JSON.parse(raw)).find((f) => f.type === "inbound.message");
    expect(inbound.clientMessageId).toBe(oldId);
    expect(userMsg._sendAttempt).toBe(1);
    expect(inbound.idempotencyKey).toBe(messageAttemptIdempotencyKey(oldId, 1));
    sock.stop();
  });
});
