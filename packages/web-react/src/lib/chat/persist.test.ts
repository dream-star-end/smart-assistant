import { afterEach, describe, expect, test, vi } from "vitest";
import { addMessage, type ChatMessage, createSession } from "./model";
import { applyResumeFailed, type FrameEffects } from "./reducer";
import { ChatSocket } from "./socket";
import type { OutboundResumeFailedWire } from "./frames";
import type { StoredSession } from "../persist";

// ---------------------------------------------------------------------------
// P6 socket 侧持久 / 历史装载：toStored / loadStored / applyServerMessages，
// 以及 resume_failed 的 dbPut 写点（effects.persistSession）。
// ---------------------------------------------------------------------------

function socket(persistSession?: (id: string) => void): ChatSocket {
  return new ChatSocket({
    getToken: () => "tok",
    getAuthEpoch: () => 0,
    silentRefresh: async (epoch) => ({ kind: "transient", epoch, retryAfterMs: 500 }),
    onAuthExpired: () => {},
    persistSession,
    defaultAgentId: "main",
  });
}

function msg(id: string, text = "", over: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: "assistant", text, ts: 1, ...over };
}

function storedFix(id: string, over: Partial<StoredSession> = {}): StoredSession {
  return { id, agentId: "main", title: id, messages: [], createdAt: 1, lastAt: 1, ...over };
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("socket — loadStored 注水（reload 不丢）", () => {
  test("注水消息 + 游标 + 重建 block 索引 + 无 pending 时 reset in-flight", () => {
    const s = socket();
    s.loadStored(
      storedFix("s1", {
        title: "续聊",
        messages: [msg("m1", "hi", { blockId: "blk-1", role: "tool", toolName: "Bash" })],
        _lastFrameSeq: 7,
        _lastFrameSeqByKey: { "agent:main:webchat:dm:s1": 7 },
        _maxSeq: 12,
        _trackerResetAt: 1000,
        _localTeardownAt: 1050,
        _agentSwitchedAt: 1100,
      }),
    );
    const sess = s.sessions.get("s1")!;
    expect(sess.title).toBe("续聊");
    expect(sess.messages.map((m) => m.id)).toEqual(["m1"]);
    expect(sess._lastFrameSeq).toBe(7);
    expect(sess._maxSeq).toBe(12);
    expect(sess._trackerResetAt).toBe(1000);
    expect(sess._localTeardownAt).toBe(1050);
    expect(sess._agentSwitchedAt).toBe(1100);
    // rebuildIndexes 重建 blockId→msgId（否则 subagent live 块会回退主流）。
    expect(sess._blockIdToMsgId?.get("blk-1")).toBe("m1");
    // 无 pending 标记的旧快照仍复位，避免 reload 后长期卡 loading。
    expect(sess._sendingInFlight).toBe(false);
  });

  test("注水近期 in-flight 标记：reload 后保留生成中状态供 hello 恢复", () => {
    const now = Date.now();
    const s = socket();
    s.loadStored(
      storedFix("s1", {
        messages: [msg("u1", "hi", { role: "user", status: "sent", ts: now - 2000 })],
        _sendingInFlight: true,
        _turnStartedAt: now - 2000,
        _lastFrameAt: now - 1000,
      }),
    );
    const sess = s.sessions.get("s1")!;
    expect(sess._sendingInFlight).toBe(true);
    expect(sess._turnStartedAt).toBe(now - 2000);
    expect(sess._lastFrameAt).toBe(now - 1000);
    s.stop();
  });

  test("注水过期 in-flight 标记：丢弃，避免 reload 后永久 loading", () => {
    const now = Date.now();
    const s = socket();
    s.loadStored(
      storedFix("s1", {
        messages: [msg("u1", "hi", { role: "user", status: "sent", ts: now - 20 * 60_000 })],
        _sendingInFlight: true,
        _turnStartedAt: now - 20 * 60_000,
        _lastFrameAt: now - 20 * 60_000,
      }),
    );
    const sess = s.sessions.get("s1")!;
    expect(sess._sendingInFlight).toBe(false);
    expect(sess._turnStartedAt).toBeUndefined();
    expect(sess._lastFrameAt).toBeUndefined();
  });

  test("已存在的 live 会话不被磁盘快照覆盖（live 优先）", () => {
    const s = socket();
    const live = s.ensureSession("s1", "main", "live");
    live.messages.push(msg("live1", "live-msg")); // 直接 push，避免 addMessage 改标题
    s.loadStored(storedFix("s1", { title: "disk", messages: [msg("d1")] }));
    const sess = s.sessions.get("s1")!;
    expect(sess.title).toBe("live"); // 未被磁盘 "disk" 覆盖
    expect(sess.messages.map((m) => m.text)).toEqual(["live-msg"]); // 未被磁盘 d1 覆盖
  });
});

describe("socket — toStored 序列化", () => {
  test("取稳定字段 + 游标，剥离流式指针", () => {
    const s = socket();
    const sess = s.ensureSession("s1", "main", "t");
    addMessage(sess, "user", "hello");
    sess._lastFrameSeq = 3;
    sess._maxSeq = 9;
    sess._trackerResetAt = 100;
    sess._localTeardownAt = 150;
    sess._agentSwitchedAt = 200;
    sess._sendingInFlight = true;
    sess._turnStartedAt = 111;
    sess._lastFrameAt = 222;
    sess._streamingAssistant = msg("stream"); // 瞬态：不应进 StoredSession
    const out = s.toStored("s1")!;
    expect(out.id).toBe("s1");
    expect(out.messages.map((m) => m.text)).toEqual(["hello"]);
    expect(out._lastFrameSeq).toBe(3);
    expect(out._maxSeq).toBe(9);
    expect(out._trackerResetAt).toBe(100);
    expect(out._localTeardownAt).toBe(150);
    expect(out._agentSwitchedAt).toBe(200);
    expect(out._sendingInFlight).toBe(true);
    expect(out._turnStartedAt).toBe(111);
    expect(out._lastFrameAt).toBe(222);
    expect(Object.keys(out)).not.toContain("_streamingAssistant");
  });

  test("序列化记录仍在响应的 turn（_sendingInFlight），用于 reload 恢复发送态", () => {
    const s = socket();
    const sess = s.ensureSession("s1", "main", "t");
    sess._sendingInFlight = true;
    sess._turnStartedAt = 1_700_000_000_000;
    const out = s.toStored("s1")!;
    expect(out._sendingInFlight).toBe(true);
    expect(out._turnStartedAt).toBe(1_700_000_000_000);
  });

  test("归档水位/计数随 toStored 落盘、loadStored 复原(reload 保住归档感知)", () => {
    const s = socket();
    const sess = s.ensureSession("s1", "main", "t");
    addMessage(sess, "user", "hi");
    sess._archivedThroughSeq = 42;
    sess._archivedCount = 7;
    const out = s.toStored("s1")!;
    expect(out._archivedThroughSeq).toBe(42);
    expect(out._archivedCount).toBe(7);
    // 复原到一个新 socket 实例。
    const s2 = socket();
    s2.loadStored(out);
    const restored = s2.sessions.get("s1")!;
    expect(restored._archivedThroughSeq).toBe(42);
    expect(restored._archivedCount).toBe(7);
  });

  test("未知会话 toStored → null", () => {
    expect(socket().toStored("nope")).toBeNull();
  });
});

describe("socket — applyServerMessages 合并 server canonical", () => {
  test("full：server-wins 重叠 + 保留本地未同步尾 + 推进 _maxSeq", () => {
    const s = socket();
    const sess = s.ensureSession("s1", "main");
    addMessage(sess, "user", "L-a"); // 本地 a（无 server id，作为本地尾保留）
    const localA = sess.messages[0];
    const server = [msg("srv1", "S-1"), msg("srv2", "S-2")];
    s.applyServerMessages("s1", "main", server, true, 20);
    const ids = sess.messages.map((m) => m.id);
    expect(ids).toEqual(["srv1", "srv2", localA.id]); // server 在前，本地尾追加
    expect(sess._maxSeq).toBe(20);
  });

  test("full：丢弃历史中段 local-only 陈旧消息（server-wins，不复活脏数据）", () => {
    const s = socket();
    const sess = s.ensureSession("s1", "main");
    // 本地：[stale(中段,server 不认识), srv1(server 认识)]，stale 不在尾部 → 应被丢弃。
    sess.messages.push(msg("stale", "脏"), msg("srv1", "L-1"));
    s.applyServerMessages("s1", "main", [msg("srv1", "S-1")], true, 9);
    expect(sess.messages.map((m) => m.id)).toEqual(["srv1"]); // stale 丢弃
    expect(sess.messages[0].text).toBe("S-1"); // server-wins
  });

  test("incremental：按 id 覆盖 + 追加新增", () => {
    const s = socket();
    const sess = s.ensureSession("s1", "main");
    sess.messages.push(msg("a", "L-a"), msg("b", "L-b"));
    s.applyServerMessages("s1", "main", [msg("b", "S-b"), msg("c", "S-c")], false, 5);
    expect(sess.messages.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(sess.messages.find((m) => m.id === "b")!.text).toBe("S-b");
  });

  test("_maxSeq 单调不回退", () => {
    const s = socket();
    s.ensureSession("s1", "main");
    s.applyServerMessages("s1", "main", [], false, 30);
    s.applyServerMessages("s1", "main", [], false, 10);
    expect(s.sessions.get("s1")!._maxSeq).toBe(30);
  });

  test("热尾巴：透传 archivedThroughSeq → 本地已归档旧行无条件保留 + 记录归档计数", () => {
    const s = socket();
    const sess = s.ensureSession("s1", "main");
    const srv = (id: string, seq: number, text = ""): ChatMessage =>
      ({ id, role: "assistant", text, ts: seq, _source: "server", _seq: seq }) as ChatMessage;
    // 本地缓存全量 [1..4];server 归档 1、2,full 只回热尾巴 [3,4]。
    sess.messages.push(srv("a1", 1), srv("a2", 2), srv("a3", 3), srv("a4", 4));
    s.applyServerMessages("s1", "main", [srv("a3", 3, "S-3"), srv("a4", 4, "S-4")], true, 4, {
      archivedThroughSeq: 2,
      archivedCount: 2,
    });
    expect(sess.messages.map((m) => m.id)).toEqual(["a1", "a2", "a3", "a4"]); // 旧归档行不丢
    expect(sess._archivedThroughSeq).toBe(2);
    expect(sess._archivedCount).toBe(2);
  });
});

describe("socket — 归档分页并入 / 游标", () => {
  const srv = (id: string, seq: number, text = ""): ChatMessage =>
    ({ id, role: "assistant", text, ts: seq, _source: "server", _seq: seq }) as ChatMessage;

  test("prependArchivedMessages：前插 + 按 id 去重 + _seq 归位", () => {
    const s = socket();
    const sess = s.ensureSession("s1", "main");
    sess.messages.push(srv("a5", 5), srv("a6", 6));
    s.prependArchivedMessages("s1", [srv("a3", 3), srv("a4", 4), srv("a5", 5)]); // a5 重叠去重
    expect(sess.messages.map((m) => m.id)).toEqual(["a3", "a4", "a5", "a6"]);
  });

  test("prependArchivedMessages：全部已存在 → 不改数组引用(零副作用)", () => {
    const s = socket();
    const sess = s.ensureSession("s1", "main");
    sess.messages.push(srv("a5", 5));
    const before = sess.messages;
    s.prependArchivedMessages("s1", [srv("a5", 5)]);
    expect(sess.messages).toBe(before);
  });

  test("archiveBeforeSeq：= 当前已加载的最老 server _seq(下一页 before 游标)", () => {
    const s = socket();
    const sess = s.ensureSession("s1", "main");
    sess.messages.push(srv("a3", 3), srv("a4", 4));
    expect(s.archiveBeforeSeq("s1")).toBe(3);
  });

  test("archiveBeforeSeq：优先冻结 _orderSeq，不受 patch 后高 _seq 干扰", () => {
    const s = socket();
    const sess = s.ensureSession("s1", "main");
    sess.messages.push(
      { ...srv("patched", 99), _orderSeq: 3 },
      { ...srv("later", 4), _orderSeq: 4 },
    );
    expect(s.archiveBeforeSeq("s1")).toBe(3);
  });

  test("archiveBeforeSeq：无任何 server _seq 行 → 回退 archivedThroughSeq+1(取最新归档页)", () => {
    const s = socket();
    const sess = s.ensureSession("s1", "main");
    addMessage(sess, "user", "乐观行无 _seq");
    sess._archivedThroughSeq = 10;
    expect(s.archiveBeforeSeq("s1")).toBe(11);
  });
});

describe("reducer — resume_failed 落地 dbPut 写点", () => {
  test("advance 游标后调用 effects.persistSession（防 reload 死循环）", () => {
    const sess = createSession({ id: "s1", agentId: "main" });
    const persistSession = vi.fn();
    const forceSync = vi.fn();
    const effects: FrameEffects = { persistSession, forceSync };
    const frame = {
      type: "outbound.resume_failed",
      peer: { id: "s1", kind: "dm" },
      sessionKey: "agent:main:webchat:dm:s1",
      to: 15,
    } as unknown as OutboundResumeFailedWire;
    applyResumeFailed(sess, frame, effects);
    // 游标推进到 server currentLast。
    expect(sess._lastFrameSeq).toBe(15);
    expect(sess._liveStreamBroken).toBe(true);
    // 关键：推进后立即落盘（否则 reload 后 hello 发旧游标 → server 反复 resume 失败）。
    expect(persistSession).toHaveBeenCalledWith("s1");
    expect(forceSync).toHaveBeenCalledWith("s1");
  });
});
