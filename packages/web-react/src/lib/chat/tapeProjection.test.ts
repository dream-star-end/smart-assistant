/**
 * §9 会话读物化投影(RFC-v5-durable-turn-dispatch §9)前端行为断言。
 * 覆盖:折叠 anchor 谓词/终态映射、collectResolvedDispatchTurnIds 抑制、turnFinalAssistantFlags 折叠行排除、
 * detectServerTerminalTurns outcome-aware、socket 展开定位替换/分页续拉/口径不变/收起、merge 保展开、
 * 截断记录判据 + 字节格式化。
 *
 * 构造风格照 durableTurnDispatch.test.ts。
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { createSession, type ChatMessage } from "./model";
import {
  collapsedAnchorTerminalKind,
  collectResolvedDispatchTurnIds,
  formatTapeBytes,
  isCollapsedAnchorTerminalEvidence,
  isCollapsedTapeAnchor,
  isProjectionSuppressedByTerminal,
  isRecordTruncated,
  tapeAnchorKey,
} from "./render";
import { detectServerTerminalTurns, mergeFullServerWins } from "../persist";
import { turnFinalAssistantFlags } from "../../components/chat/turnSegment";
import { ChatSocket, type ChatSocketDeps } from "./socket";

function srvRow(over: Partial<ChatMessage>): ChatMessage {
  return { id: "x", role: "assistant", text: "", ts: 1, _source: "server", ...over } as ChatMessage;
}
/** 折叠 anchor 行工厂(server-authored)。 */
function anchor(over: Partial<ChatMessage> = {}): ChatMessage {
  return srvRow({
    id: "srv-a-t1-s0",
    role: "assistant",
    text: "",
    _seq: 5,
    _orderSeq: 5,
    _tapeCollapsed: true,
    _tapeTotalBytes: 192 * 1024 * 1024,
    _dispatchOutcome: "completed",
    _turnTapeId: "tape-1",
    _turnTapeSha256: "sha-1",
    _clientMessageId: "cm-1",
    ...over,
  });
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

// ═══════════════ 1. 折叠 anchor 谓词 + 终态映射 ═══════════════
describe("折叠 anchor 谓词 (RFC §9-B1)", () => {
  test("isCollapsedTapeAnchor", () => {
    expect(isCollapsedTapeAnchor(anchor())).toBe(true);
    expect(isCollapsedTapeAnchor(srvRow({ text: "正文" }))).toBe(false);
    expect(isCollapsedTapeAnchor(null)).toBe(false);
  });
  test("tapeAnchorKey = _turnTapeId::_turnTapeSha256::id(不含 _seq,防同序误伤)", () => {
    expect(tapeAnchorKey(anchor())).toBe("tape-1::sha-1::srv-a-t1-s0");
    // sha 缺省仍以 id 保唯一。
    expect(tapeAnchorKey(anchor({ _turnTapeSha256: undefined }))).toBe("tape-1::::srv-a-t1-s0");
  });
  test("collapsedAnchorTerminalKind:completed/interrupted→completed;crashed/executed_error/not_accepted→error", () => {
    expect(collapsedAnchorTerminalKind("completed")).toBe("completed");
    expect(collapsedAnchorTerminalKind("interrupted")).toBe("completed");
    expect(collapsedAnchorTerminalKind("crashed")).toBe("error");
    expect(collapsedAnchorTerminalKind("executed_error")).toBe("error");
    expect(collapsedAnchorTerminalKind("not_accepted")).toBe("error");
    expect(collapsedAnchorTerminalKind("running")).toBeNull();
    expect(collapsedAnchorTerminalKind(undefined)).toBeNull();
  });
  test("isCollapsedAnchorTerminalEvidence:折叠 + 终态 outcome 才成立", () => {
    expect(isCollapsedAnchorTerminalEvidence(anchor({ _dispatchOutcome: "completed" }))).toBe(true);
    expect(isCollapsedAnchorTerminalEvidence(anchor({ _dispatchOutcome: "running" }))).toBe(false);
    expect(isCollapsedAnchorTerminalEvidence(srvRow({ text: "正文", _dispatchOutcome: "completed" }))).toBe(false);
  });
});

// ═══════════════ 2. 截断记录判据 + 字节格式化 ═══════════════
describe("截断记录 (RFC §9.1)", () => {
  test("isRecordTruncated 以 _fullBytes 为判据(不读 _truncated,避同名歧义)", () => {
    expect(isRecordTruncated(srvRow({ _fullBytes: 5_000_000 }))).toBe(true);
    expect(isRecordTruncated(srvRow({ _fullBytes: 0 }))).toBe(false);
    expect(isRecordTruncated(srvRow({}))).toBe(false);
    // assistant 续写标记 _truncated:string 不触发截断判据。
    expect(isRecordTruncated(srvRow({ _truncated: "max_tokens" }))).toBe(false);
  });
  test("formatTapeBytes", () => {
    expect(formatTapeBytes(2 * 1024 * 1024)).toBe("2.0 MB");
    expect(formatTapeBytes(64 * 1024)).toBe("64 KB");
    expect(formatTapeBytes(500)).toBe("500 B");
    expect(formatTapeBytes(0)).toBe("");
    expect(formatTapeBytes(undefined)).toBe("");
  });
});

// ═══════════════ 3. collectResolvedDispatchTurnIds 抑制(折叠 anchor = tape 权威) ═══════════════
describe("折叠 anchor 抑制同轮 dispatch error projection", () => {
  test("同 _clientMessageId 存在折叠 anchor → 抑制 projection", () => {
    const projection = srvRow({ id: "oc-dispatch-err:d1", _errorCode: "dispatch_lost", _clientMessageId: "cm-1" });
    const resolved = collectResolvedDispatchTurnIds([projection, anchor()]);
    expect(resolved.has("cm-1")).toBe(true);
    expect(isProjectionSuppressedByTerminal(projection, resolved)).toBe(true);
  });
  test("仅 projection(无折叠 anchor)→ 不抑制", () => {
    const projection = srvRow({ id: "oc-dispatch-err:d1", _errorCode: "dispatch_lost", _clientMessageId: "cm-9" });
    const resolved = collectResolvedDispatchTurnIds([projection]);
    expect(isProjectionSuppressedByTerminal(projection, resolved)).toBe(false);
  });
});

// ═══════════════ 4. turnFinalAssistantFlags:折叠行非"末条 assistant 正文" ═══════════════
describe("turnFinalAssistantFlags 显式排除折叠行 (RFC §9-B1)", () => {
  test("折叠 anchor(即便带正文)绝不作末条评分落点;真展开正文行才承接", () => {
    const u = srvRow({ id: "u1", role: "user", text: "问", _clientMessageId: undefined });
    // 折叠 anchor 显式给正文,验证 !_tapeCollapsed 守卫(不靠"空正文"巧合)。
    const collapsed = anchor({ id: "srv-a-t1-s0", text: "本轮完整输出摘要", _clientMessageId: "cm-1" });
    const body = srvRow({ id: "rec-0", role: "assistant", text: "真展开正文", _clientMessageId: "cm-1", _tapeExpandedFrom: "tape-1::sha-1::srv-a-t1-s0" });
    const flags = turnFinalAssistantFlags([u, collapsed, body]);
    expect(flags[1]).toBe(false); // 折叠 anchor 不是末条正文
    expect(flags[2]).toBe(true); // 真展开正文行是末条
  });
});

// ═══════════════ 5. detectServerTerminalTurns outcome-aware ═══════════════
describe("detectServerTerminalTurns 折叠 anchor outcome-aware", () => {
  test("completed 折叠 anchor → completed", () => {
    expect(detectServerTerminalTurns([anchor({ _dispatchOutcome: "completed" })]).get("cm-1")).toBe("completed");
  });
  test("interrupted 折叠 anchor → completed(有内容)", () => {
    expect(detectServerTerminalTurns([anchor({ _dispatchOutcome: "interrupted" })]).get("cm-1")).toBe("completed");
  });
  test("crashed 折叠 anchor → error(不被泛化 assistant 分支误判 completed)", () => {
    expect(detectServerTerminalTurns([anchor({ _dispatchOutcome: "crashed" })]).get("cm-1")).toBe("error");
  });
  test("非终态 outcome 折叠 anchor → 不入证据", () => {
    expect(detectServerTerminalTurns([anchor({ _dispatchOutcome: "running" })]).has("cm-1")).toBe(false);
  });
});

// ═══════════════ 6. socket 展开:定位替换 / 分页续拉 / 口径不变 / 收起 ═══════════════
describe("applyExpandedTapeRecords + collapseTape (RFC §9.1)", () => {
  afterEach(() => vi.restoreAllMocks());

  function seed(): { sock: ChatSocket; s: ReturnType<typeof createSession> } {
    const sock = makeSocket();
    // 经 applyServerMessages 播种含折叠 anchor 的会话(ensureSession 建行)。
    sock.applyServerMessages(
      "s1",
      "main",
      [srvRow({ id: "u1", role: "user", text: "问", _seq: 4, _orderSeq: 4 }), anchor()],
      true,
      5,
      { serverUpdatedAt: 100 },
    );
    return { sock, s: sock.sessions.get("s1")! };
  }

  test("首页展开:按 anchor id 定位标记 + 展开行共享 anchor _seq/_orderSeq + _maxSeq 口径不变", () => {
    const { sock, s } = seed();
    const maxSeqBefore = s._maxSeq;
    sock.applyExpandedTapeRecords(
      "s1",
      "srv-a-t1-s0",
      [srvRow({ id: "rec-0", role: "assistant", text: "第1段" }), srvRow({ id: "rec-1", role: "tool", toolName: "Bash" })],
      2,
    );
    const a = s.messages.find((m) => m.id === "srv-a-t1-s0")!;
    expect(a._tapeExpanded).toBe(true);
    expect(a._tapeExpandCursor).toBe(2);
    const exp0 = s.messages.find((m) => m.id === "rec-0")!;
    expect(exp0._tapeExpandedFrom).toBe("tape-1::sha-1::srv-a-t1-s0");
    expect(exp0._seq).toBe(5); // 共享 anchor _seq → 不新增 distinct _seq
    expect(exp0._orderSeq).toBe(5);
    expect(exp0._source).toBe("server");
    expect(exp0._clientMessageId).toBe("cm-1"); // 记录缺省 cmid 时从 anchor 继承
    // 展开行紧跟 anchor 之后。
    const ai = s.messages.findIndex((m) => m.id === "srv-a-t1-s0");
    expect(s.messages[ai + 1].id).toBe("rec-0");
    expect(s.messages[ai + 2].id).toBe("rec-1");
    // 口径:_maxSeq 不被展开推进。
    expect(s._maxSeq).toBe(maxSeqBefore);
  });

  test("分页续拉:第二页追加 + 按 id 去重 + 游标推进到 null(已拉全)", () => {
    const { sock, s } = seed();
    sock.applyExpandedTapeRecords("s1", "srv-a-t1-s0", [srvRow({ id: "rec-0", text: "第1段" })], 2);
    sock.applyExpandedTapeRecords(
      "s1",
      "srv-a-t1-s0",
      [srvRow({ id: "rec-0", text: "第1段(重复页)" }), srvRow({ id: "rec-1", text: "第2段" })],
      null,
    );
    const expanded = s.messages.filter((m) => m._tapeExpandedFrom === "tape-1::sha-1::srv-a-t1-s0");
    expect(expanded.map((m) => m.id)).toEqual(["rec-0", "rec-1"]); // rec-0 去重,不重复插
    expect(s.messages.find((m) => m.id === "srv-a-t1-s0")!._tapeExpandCursor).toBe(null);
  });

  test("anchor 不存在 → 静默放弃(不误伤别的行)", () => {
    const { sock, s } = seed();
    const before = s.messages.length;
    sock.applyExpandedTapeRecords("s1", "不存在的anchor", [srvRow({ id: "rec-0" })], null);
    expect(s.messages.length).toBe(before);
  });

  test("collapseTape:抹展开行 + 还原折叠态(游标清空)", () => {
    const { sock, s } = seed();
    sock.applyExpandedTapeRecords("s1", "srv-a-t1-s0", [srvRow({ id: "rec-0" }), srvRow({ id: "rec-1" })], 3);
    expect(s.messages.some((m) => m._tapeExpandedFrom)).toBe(true);
    sock.collapseTape("s1", "srv-a-t1-s0");
    const a = s.messages.find((m) => m.id === "srv-a-t1-s0")!;
    expect(a._tapeExpanded).toBe(false);
    expect(a._tapeExpandCursor).toBeUndefined();
    expect(s.messages.some((m) => m._tapeExpandedFrom)).toBe(false);
  });

  test("persist 往返(toStored→loadStored):折叠行/展开行标记不丢(RFC §9.1 持久化语义)", () => {
    const { sock } = seed();
    sock.applyExpandedTapeRecords("s1", "srv-a-t1-s0", [srvRow({ id: "rec-0", text: "展开内容" })], 2);
    const stored = sock.toStored("s1")!;
    const sock2 = makeSocket();
    sock2.loadStored(stored);
    const s2 = sock2.sessions.get("s1")!;
    const a2 = s2.messages.find((m) => m.id === "srv-a-t1-s0")!;
    expect(a2._tapeCollapsed).toBe(true);
    expect(a2._tapeExpanded).toBe(true);
    expect(a2._tapeExpandCursor).toBe(2);
    expect(a2._tapeTotalBytes).toBe(192 * 1024 * 1024);
    expect(a2._dispatchOutcome).toBe("completed");
    const exp = s2.messages.find((m) => m.id === "rec-0")!;
    expect(exp._tapeExpandedFrom).toBe("tape-1::sha-1::srv-a-t1-s0");
    expect(exp._seq).toBe(5);
  });
});

// ═══════════════ 6b. 折叠 anchor 终态证据端到端:清发送态 + user 行终态 ═══════════════
describe("折叠 anchor 作终态存在证据(applyServerMessages 收敛)", () => {
  test("completed 折叠 anchor 到达 → 清 _sendingInFlight + user 行 replied", () => {
    const sock = makeSocket();
    // 播种含 user 行的会话 + 挂发送态(模拟该轮已发出、等待中)。
    sock.applyServerMessages(
      "s1",
      "main",
      [srvRow({ id: "cm-1", role: "user", text: "生成巨型输出", _seq: 1, _orderSeq: 1, status: "sent" })],
      true,
      1,
      { serverUpdatedAt: 50 },
    );
    const s = sock.sessions.get("s1")!;
    s._sendingInFlight = true;
    s._activeClientMessageId = "cm-1";
    // server full 回该轮 completed 折叠 anchor(巨型输出已落 tape、被折叠)。
    sock.applyServerMessages(
      "s1",
      "main",
      [
        srvRow({ id: "cm-1", role: "user", text: "生成巨型输出", _seq: 1, _orderSeq: 1, status: "sent" }),
        anchor({ id: "srv-a-t1-s0", _seq: 2, _orderSeq: 2, _clientMessageId: "cm-1" }),
      ],
      true,
      2,
      { serverUpdatedAt: 100 },
    );
    expect(s._sendingInFlight).toBe(false);
    expect(s.messages.find((m) => m.role === "user" && m.id === "cm-1")!.status).toBe("replied");
  });
});

// ═══════════════ 7. merge 保留本地展开(server 重发折叠 anchor 不回退) ═══════════════
describe("merge 保展开 (RFC §9.1 持久化语义)", () => {
  test("mergeFullServerWins:本地已展开、server 又来折叠 anchor → 保留展开行 + anchor 保 _tapeExpanded", () => {
    const key = "tape-1::sha-1::srv-a-t1-s0";
    // 展开行落在**中段**(anchor 后、turn2 前),同时验证 P1 缺席豁免 + preservedMid 保留两条路径。
    const local: ChatMessage[] = [
      srvRow({ id: "u1", role: "user", text: "问1", _seq: 4, _orderSeq: 4 }),
      anchor({ _tapeExpanded: true, _tapeExpandCursor: null }),
      srvRow({ id: "rec-0", role: "assistant", text: "展开内容", _seq: 5, _orderSeq: 5, _tapeExpandedFrom: key, _clientMessageId: "cm-1" }),
      srvRow({ id: "u2", role: "user", text: "问2", _seq: 6, _orderSeq: 6 }),
      srvRow({ id: "srv-a2", role: "assistant", text: "答2", _seq: 7, _orderSeq: 7, _clientMessageId: "cm-2" }),
    ];
    // server full 只回折叠 anchor(无展开标记、无 rec-0)。
    const server: ChatMessage[] = [
      srvRow({ id: "u1", role: "user", text: "问1", _seq: 4, _orderSeq: 4 }),
      anchor(),
      srvRow({ id: "u2", role: "user", text: "问2", _seq: 6, _orderSeq: 6 }),
      srvRow({ id: "srv-a2", role: "assistant", text: "答2", _seq: 7, _orderSeq: 7, _clientMessageId: "cm-2" }),
    ];
    const merged = mergeFullServerWins(server, local, 0, undefined, { deletionAuthority: true });
    // 展开行保留(未被 P1 缺席删,未被 preservedMid 丢)。
    expect(merged.some((m) => m.id === "rec-0" && m._tapeExpandedFrom === key)).toBe(true);
    // anchor 保 _tapeExpanded(mergeLocalClientFields 单调保留)。
    expect(merged.find((m) => m.id === "srv-a-t1-s0")!._tapeExpanded).toBe(true);
  });

  test("对照:非展开的孤儿 server 行(无 _tapeExpandedFrom)缺席 + deletionAuthority → 照删", () => {
    const local: ChatMessage[] = [
      srvRow({ id: "u1", role: "user", text: "问", _seq: 4, _orderSeq: 4 }),
      srvRow({ id: "orphan", role: "assistant", text: "已被服务端删除", _seq: 8, _orderSeq: 8 }),
    ];
    const server: ChatMessage[] = [srvRow({ id: "u1", role: "user", text: "问", _seq: 4, _orderSeq: 4 })];
    const merged = mergeFullServerWins(server, local, 0, undefined, { deletionAuthority: true });
    expect(merged.some((m) => m.id === "orphan")).toBe(false); // 展开豁免不误保护普通孤儿行
  });
});
