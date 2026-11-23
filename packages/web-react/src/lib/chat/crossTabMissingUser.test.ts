import { afterEach, describe, expect, test, vi } from "vitest";
import { ChatSocket } from "./socket";
import type { ChatMessage } from "./model";

class FakeWS {
  static instances: FakeWS[] = [];
  static OPEN = 1;
  readyState = 0;
  bufferedAmount = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
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
    this.onmessage?.({ data: JSON.stringify({ type: "sys.relay_ready", automaticRecoveryOwner: "master-v1" }) });
  }
  push(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}

afterEach(() => {
  FakeWS.instances = [];
  vi.unstubAllGlobals();
});

describe("OCV5-868: 跨 tab 收到未知活跃 clientMessageId 实时帧时自动补拉缺失 user 气泡并归位", () => {
  test("收到新轮实时工具帧且本地缺对应 user 行时，自动认领 _activeClientMessageId、去重补拉历史并在合并后保持 Turn1 → u2 → Turn2 顺序", () => {
    vi.stubGlobal("WebSocket", FakeWS);
    const syncSession = vi.fn(async () => {});
    const sock = new ChatSocket({
      getToken: () => "tok",
      getAuthEpoch: () => 0,
      silentRefresh: async (epoch) => ({ kind: "transient", epoch, retryAfterMs: 500 }),
      onAuthExpired: () => {},
      defaultAgentId: "main",
      syncSession,
    });
    sock.setGateReady(true);
    sock.setLaneReady(true);
    sock.connect();
    const ws = FakeWS.instances[0]!;
    ws.open();

    const sessId = "webmwt0osksdxg7cw";
    const t1Final: ChatMessage = {
      id: "srv-t1-s0",
      role: "assistant",
      text: "要我现在直接建单修复并合入个人版上线吗？",
      ts: 1050,
      _source: "server",
      _timelineRecord: true,
      _orderSeq: 2,
      _turnTapeId: "tape-1",
      _turnTapeOrdinal: 173,
      _turnTapeComplete: true,
      _clientMessageId: "m-turn1",
    };
    sock.ensureSession(sessId, "main", "蜂群排查");
    sock.applyServerMessages(sessId, "main", [t1Final], true, 3, {
      serverUpdatedAt: 1050,
      historyRevision: 1,
      timelineGeneration: 2,
    });
    syncSession.mockClear();

    const turn2Cmid = "m-mwt1tun7-19-10xs";
    ws.push({
      type: "outbound.message",
      peer: { id: sessId, kind: "dm" },
      agentId: "main",
      sessionKey: `agent:main:webchat:dm:${sessId}`,
      clientMessageId: turn2Cmid,
      frameSeq: 650,
      ts: 2010,
      isFinal: false,
      blocks: [
        { kind: "tool_use", blockId: "blk-1", toolName: "oc_bash", inputJson: { command: "ls" } },
      ],
    });
    // 第二条同轮实时帧不再重复触发 syncSession
    ws.push({
      type: "outbound.message",
      peer: { id: sessId, kind: "dm" },
      agentId: "main",
      sessionKey: `agent:main:webchat:dm:${sessId}`,
      clientMessageId: turn2Cmid,
      frameSeq: 651,
      ts: 2020,
      isFinal: false,
      blocks: [
        { kind: "tool_use", blockId: "blk-2", toolName: "Read", inputJson: { file_path: "a.ts" } },
      ],
    });

    const sess = sock.sessions.get(sessId)!;
    expect(sess._sendingInFlight).toBe(true);
    expect(sess._activeClientMessageId).toBe(turn2Cmid);
    expect(syncSession).toHaveBeenCalledTimes(1);
    expect(syncSession).toHaveBeenCalledWith(sessId, { clientMessageId: turn2Cmid });

    // 历史补拉返回 Turn 1 终答 + Turn 2 user 气泡，合并后严格按 Turn 1 → u2 → Turn 2 实时工具排序
    const u2Server: ChatMessage = {
      id: turn2Cmid,
      role: "user",
      text: "要",
      ts: 2000,
      _source: "server",
      _timelineRecord: true,
      _orderSeq: 3,
    };
    sock.applyServerMessages(sessId, "main", [t1Final, u2Server], true, 4, {
      serverUpdatedAt: 2005,
      historyRevision: 2,
      timelineGeneration: 3,
      openDispatch: { dispatchId: "d-turn2", clientMessageId: turn2Cmid, status: "accepted", acceptedAt: 2001 },
    });

    expect(sess.messages.map((m) => m.id)).toEqual([
      "srv-t1-s0",
      turn2Cmid,
      sess.messages[2]!.id,
      sess.messages[3]!.id,
    ]);
    expect(sess.messages[0]!.role).toBe("assistant");
    expect(sess.messages[1]!.role).toBe("user");
    expect(sess.messages[2]!.role).toBe("tool");
    expect(sess.messages[3]!.role).toBe("tool");
    sock.stop();
  });
});
