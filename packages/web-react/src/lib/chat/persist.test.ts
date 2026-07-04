import { describe, expect, test, vi } from "vitest";
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
    silentRefresh: async () => null,
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

describe("socket — loadStored 注水（reload 不丢）", () => {
  test("注水消息 + 游标 + 重建 block 索引 + reset in-flight", () => {
    const s = socket();
    s.loadStored(
      storedFix("s1", {
        title: "续聊",
        messages: [msg("m1", "hi", { blockId: "blk-1", role: "tool", toolName: "Bash" })],
        _lastFrameSeq: 7,
        _lastFrameSeqByKey: { "agent:main:webchat:dm:s1": 7 },
        _maxSeq: 12,
      }),
    );
    const sess = s.sessions.get("s1")!;
    expect(sess.title).toBe("续聊");
    expect(sess.messages.map((m) => m.id)).toEqual(["m1"]);
    expect(sess._lastFrameSeq).toBe(7);
    expect(sess._maxSeq).toBe(12);
    // rebuildIndexes 重建 blockId→msgId（否则 subagent live 块会回退主流）。
    expect(sess._blockIdToMsgId?.get("blk-1")).toBe("m1");
    // 注水后 in-flight 必须复位，避免 reload 后卡 loading。
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
    sess._sendingInFlight = true;
    sess._turnStartedAt = 111;
    sess._lastFrameAt = 222;
    sess._streamingAssistant = msg("stream"); // 瞬态：不应进 StoredSession
    const out = s.toStored("s1")!;
    expect(out.id).toBe("s1");
    expect(out.messages.map((m) => m.text)).toEqual(["hello"]);
    expect(out._lastFrameSeq).toBe(3);
    expect(out._maxSeq).toBe(9);
    expect(out._sendingInFlight).toBe(true);
    expect(out._turnStartedAt).toBe(111);
    expect(out._lastFrameAt).toBe(222);
    expect(Object.keys(out)).not.toContain("_streamingAssistant");
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
