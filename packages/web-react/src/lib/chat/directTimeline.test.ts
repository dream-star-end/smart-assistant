/** Unified real-history frontend contracts. */
import { describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "./model";
import { rebuildIndexes } from "./model";
import { ChatSocket, type ChatSocketDeps } from "./socket";
import { stableSortByTs } from "../persist";

function row(over: Partial<ChatMessage>): ChatMessage {
  return {
    id: "row",
    role: "assistant",
    text: "",
    ts: 1,
    _source: "server",
    _timelineRecord: true,
    ...over,
  } as ChatMessage;
}

function socket(overrides: Partial<ChatSocketDeps> = {}): ChatSocket {
  return new ChatSocket({
    getToken: () => "tok",
    getAuthEpoch: () => 0,
    silentRefresh: async (epoch) => ({ kind: "transient", epoch, retryAfterMs: 500 }),
    onAuthExpired: () => {},
    defaultAgentId: "main",
    ...overrides,
  });
}

const latestPage = (): ChatMessage[] => [
  row({
    id: "user-latest",
    role: "user",
    text: "最新问题",
    _orderSeq: 10,
    _timelineUnitKey: "outer:10:user-latest",
  }),
  row({
    id: "thinking-latest",
    role: "thinking",
    text: "最新真实思考",
    _orderSeq: 11,
    _turnTapeId: "tape-latest",
    _turnTapeComplete: true,
    _turnTapeOrdinal: 0,
    _timelineLogicalOrdinal: 0,
    _timelineUnitKey: "tape:tape-latest:0:0:thinking-latest",
  }),
  row({
    id: "tool-latest",
    role: "tool",
    text: "最新真实工具输出",
    toolName: "Bash",
    _orderSeq: 11,
    _turnTapeId: "tape-latest",
    _turnTapeComplete: true,
    _turnTapeOrdinal: 1,
    _timelineLogicalOrdinal: 0,
    _timelineUnitKey: "tape:tape-latest:1:0:tool-latest",
  }),
  row({
    id: "answer-latest",
    role: "assistant",
    text: "最新真实回答",
    _orderSeq: 11,
    _turnTapeId: "tape-latest",
    _turnTapeComplete: true,
    _turnTapeOrdinal: 2,
    _timelineLogicalOrdinal: 0,
    _timelineUnitKey: "tape:tape-latest:2:0:answer-latest",
  }),
];

const olderPage = (): ChatMessage[] => [
  row({
    id: "user-older",
    role: "user",
    text: "更早问题",
    _orderSeq: 5,
    _timelineUnitKey: "outer:5:user-older",
  }),
  row({
    id: "thinking-older",
    role: "thinking",
    text: "更早真实思考",
    _orderSeq: 6,
    _turnTapeId: "tape-older",
    _turnTapeComplete: true,
    _turnTapeOrdinal: 0,
    _timelineLogicalOrdinal: 0,
    _timelineUnitKey: "tape:tape-older:0:0:thinking-older",
  }),
  row({
    id: "answer-older",
    role: "assistant",
    text: "更早真实回答",
    _orderSeq: 6,
    _turnTapeId: "tape-older",
    _turnTapeComplete: true,
    _turnTapeOrdinal: 1,
    _timelineLogicalOrdinal: 0,
    _timelineUnitKey: "tape:tape-older:1:0:answer-older",
  }),
];

describe("unified real timeline", () => {
  test("latest page keeps user, thinking, tool and answer as equal chronological records", () => {
    const s = socket();
    s.applyServerMessages("s1", "main", [
      ...latestPage(),
      row({ id: "turn-process:stale", role: "runtime-event", _turnTapeProcess: true }),
      row({ id: "projection-old", role: "system", text: "projection" }),
    ], true, 11, {
      timelineGeneration: 1,
      timelineCursor: "cursor-1",
      timelineHasMore: true,
      timelineSnapshotMaxSeq: 11,
      serverUpdatedAt: 1,
    });

    const session = s.sessions.get("s1")!;
    expect(session.messages.map((message) => message.id)).toEqual([
      "user-latest", "thinking-latest", "tool-latest", "answer-latest",
    ]);
    expect(session.messages.map((message) => message.role)).toEqual([
      "user", "thinking", "tool", "assistant",
    ]);
    expect(session._timelineCursor).toBe("cursor-1");
    expect(session._timelineHasMore).toBe(true);
  });

  test("predecessor process-control payload cannot replace a resident unified timeline", () => {
    const s = socket();
    s.applyServerMessages("s1", "main", latestPage(), true, 11, {
      timelineGeneration: 1,
      timelineCursor: null,
      timelineHasMore: false,
      serverUpdatedAt: 1,
    });
    const before = s.sessions.get("s1")!.messages;

    s.applyServerMessages("s1", "main", [
      row({
        id: "turn-process:legacy",
        role: "runtime-event",
        _timelineRecord: false,
        _turnTapeProcess: true,
      }),
      row({
        id: "legacy-final-locator",
        role: "assistant",
        text: "旧版最终定位行",
        _timelineRecord: false,
      }),
    ], true, 12, { historyRevision: 2, serverUpdatedAt: 2 });

    expect(s.sessions.get("s1")!.messages).toBe(before);
    expect(s.sessions.get("s1")!.messages.some((message) => message.id === "legacy-final-locator")).toBe(false);
  });

  test("first unified generation purges predecessor cached process cards before adopting exact rows", () => {
    const s = socket();
    s.loadStored({
      id: "s1",
      agentId: "main",
      title: "legacy cache",
      createdAt: 1,
      lastAt: 9,
      messages: [
        { id: "user-latest", role: "user", text: "最新问题", ts: 1 },
        { id: "legacy-plan", role: "plan", text: "旧缓存计划卡", ts: 2 },
        { id: "legacy-goal", role: "goal", text: "旧缓存目标卡", ts: 3 },
        { id: "legacy-group", role: "agent-group", text: "旧缓存团队富卡", ts: 4, _delegateRunId: "old-run" },
        { id: "legacy-progress", role: "delegate-progress", text: "旧缓存委派进度", ts: 5 },
        { id: "legacy-answer", role: "assistant", text: "旧缓存回答替身", ts: 6 },
      ],
    });

    s.applyServerMessages("s1", "main", latestPage(), true, 11, {
      timelineGeneration: 1,
      timelineCursor: null,
      timelineHasMore: false,
      serverUpdatedAt: 10,
    });

    expect(s.sessions.get("s1")!.messages.map((message) => message.id)).toEqual([
      "user-latest", "thinking-latest", "tool-latest", "answer-latest",
    ]);
    expect(s.sessions.get("s1")!.messages.some((message) => message.text.includes("旧缓存"))).toBe(false);
  });

  test("predecessor active cards survive first adoption with an owner, then exact terminal tape removes all of them", () => {
    const s = socket();
    const session = s.ensureSession("s1", "main");
    const owner = "legacy-active-user";
    session._sendingInFlight = true;
    session._activeClientMessageId = owner;
    session.messages = [
      { id: owner, role: "user", text: "旧 bundle 正在执行", ts: 10, status: "read" },
      { id: "legacy-active-plan", role: "plan", text: "活跃计划", ts: 11 },
      { id: "legacy-active-goal", role: "goal", text: "活跃目标", ts: 12 },
      { id: "legacy-active-group", role: "agent-group", text: "活跃协作", ts: 13 },
      { id: "legacy-active-progress", role: "delegate-progress", text: "活跃进度", ts: 14 },
    ];
    rebuildIndexes(session);

    s.applyServerMessages("s1", "main", [row({
      id: "older-server-user",
      role: "user",
      text: "已完成旧轮",
      ts: 1,
      _orderSeq: 1,
      _timelineUnitKey: "outer:1:older-server-user",
    })], true, 1, {
      timelineGeneration: 1,
      timelineCursor: null,
      timelineHasMore: false,
      serverUpdatedAt: 20,
    });

    const adopted = session.messages.filter((message) => message.id.startsWith("legacy-active-"));
    expect(adopted.map((message) => message.id)).toEqual([
      "legacy-active-user", "legacy-active-plan", "legacy-active-goal",
      "legacy-active-group", "legacy-active-progress",
    ]);
    expect(adopted.filter((message) => message.role !== "user").every(
      (message) => message._turnOwnerId === owner,
    )).toBe(true);

    const exact = (["plan", "goal", "agent-group", "delegate-progress"] as const)
      .map((role, index) => row({
        id: `exact-adopted-${role}`,
        role,
        text: `真实 ${role}`,
        ts: 30 + index,
        _orderSeq: 2,
        _turnTapeId: "adopted-terminal-tape",
        _turnTapeComplete: true,
        _turnTapeOrdinal: index,
        _timelineLogicalOrdinal: 0,
        _timelineUnitKey: `tape:adopted-terminal-tape:${index}:0:exact-adopted-${role}`,
        _clientMessageId: owner,
        _dispatchOutcome: "completed",
      }));
    s.applyServerMessages("s1", "main", [
      row({
        id: owner,
        role: "user",
        text: "旧 bundle 正在执行",
        ts: 10,
        _orderSeq: 2,
        _timelineUnitKey: `outer:2:${owner}`,
      }),
      ...exact,
    ], true, 2, {
      timelineGeneration: 1,
      timelineCursor: null,
      timelineHasMore: false,
      serverUpdatedAt: 30,
    });

    expect(session.messages.some((message) => message.id.startsWith("legacy-active-") && message.role !== "user")).toBe(false);
    expect(session.messages.filter((message) => message.id.startsWith("exact-adopted-")).map((message) => message.id)).toEqual([
      "exact-adopted-plan", "exact-adopted-goal", "exact-adopted-agent-group",
      "exact-adopted-delegate-progress",
    ]);
    expect(session._sendingInFlight).toBe(false);
  });

  test("finalized exact tape removes every owned live process substitute but preserves user and permission", () => {
    const s = socket();
    const session = s.ensureSession("s1", "main");
    const owner = "cm-live-process";
    session._sendingInFlight = true;
    session._activeClientMessageId = owner;
    session.messages = [
      { id: owner, role: "user", text: "执行完整过程", ts: 1, status: "read" },
      ...(["assistant", "thinking", "tool", "plan", "goal", "agent-group", "delegate-progress", "runtime-event"] as const)
        .map((role, index) => ({
          id: `live-${role}`,
          role,
          text: `本地替身 ${role}`,
          ts: 2 + index,
          _turnOwnerId: owner,
          ...(role === "agent-group" ? { _delegateRunId: "live-run" } : {}),
        } as ChatMessage)),
      {
        id: "live-permission",
        role: "permission",
        text: "Bash",
        ts: 20,
        _turnOwnerId: owner,
      },
    ];
    rebuildIndexes(session);

    const exact = (["plan", "goal", "agent-group", "runtime-event"] as const).map((role, index) => row({
      id: `exact-${role}`,
      role,
      text: `真实 ${role}`,
      ts: 30 + index,
      _orderSeq: 2,
      _turnTapeId: "exact-process-tape",
      _turnTapeComplete: true,
      _turnTapeOrdinal: index,
      _timelineLogicalOrdinal: 0,
      _timelineUnitKey: `tape:exact-process-tape:${index}:0:exact-${role}`,
      _clientMessageId: owner,
      _dispatchOutcome: "completed",
      ...(role === "agent-group" ? { _delegateRunId: "exact-run" } : {}),
    }));
    s.applyServerMessages("s1", "main", [
      row({
        id: owner,
        role: "user",
        text: "执行完整过程",
        ts: 1,
        _orderSeq: 1,
        _timelineUnitKey: `outer:1:${owner}`,
      }),
      ...exact,
    ], true, 2, {
      timelineGeneration: 1,
      timelineCursor: null,
      timelineHasMore: false,
      serverUpdatedAt: 30,
    });

    expect(session.messages.filter((message) => message.id.startsWith("live-")).map((message) => message.id)).toEqual([
      "live-permission",
    ]);
    expect(session.messages.filter((message) => message.id.startsWith("exact-")).map((message) => message.id)).toEqual([
      "exact-plan", "exact-goal", "exact-agent-group", "exact-runtime-event",
    ]);
    expect(session._sendingInFlight).toBe(false);
    expect(session.messages.find((message) => message.id === owner)?.status).toBe("replied");
  });

  test("exact timeline agent/tool rows replace live delegate cards instead of being skeleton-merged", () => {
    const s = socket();
    const session = s.ensureSession("s1", "main");
    session.messages = [
      {
        id: "live-group-different-id",
        role: "agent-group",
        text: "客户端富卡替身",
        ts: 1,
        _delegate: true,
        _delegateRunId: "run-exact",
        childBlocks: [{ kind: "text", text: "只存在于客户端的拼装过程" }],
      },
      {
        id: "delegate-tool-same-id",
        role: "agent-group",
        text: "客户端转换后的工具卡",
        ts: 2,
        _delegate: true,
        _delegateRunId: "run-tool",
        childBlocks: [{ kind: "text", text: "客户端工具替身" }],
      },
    ];
    rebuildIndexes(session);

    const exactGroup = row({
      id: "exact-group",
      role: "agent-group",
      text: "Agent 持久化的真实协作记录",
      ts: 3,
      _orderSeq: 10,
      _delegateRunId: "run-exact",
      _timelineUnitKey: "tape:exact:0:0:exact-group",
    });
    const exactTool = row({
      id: "delegate-tool-same-id",
      role: "tool",
      text: "Agent 持久化的真实工具记录",
      output: "exact tool output",
      ts: 4,
      _orderSeq: 10,
      _turnTapeOrdinal: 1,
      _timelineUnitKey: "tape:exact:1:0:delegate-tool-same-id",
    });
    const exactGoals = [
      row({
        id: "exact-goal-1",
        role: "goal",
        text: "真实目标记录一",
        blockId: "engine-goal",
        ts: 5,
        _orderSeq: 11,
        _timelineUnitKey: "outer:11:exact-goal-1",
      }),
      row({
        id: "exact-goal-2",
        role: "goal",
        text: "真实目标记录二",
        blockId: "engine-goal",
        ts: 6,
        _orderSeq: 12,
        _timelineUnitKey: "outer:12:exact-goal-2",
      }),
    ];
    s.applyServerMessages("s1", "main", [exactGroup, exactTool, ...exactGoals], true, 12, {
      timelineGeneration: 1,
      timelineCursor: null,
      timelineHasMore: false,
      serverUpdatedAt: 10,
    });

    expect(session.messages).toHaveLength(4);
    expect(session.messages.map((message) => message.id)).toEqual([
      "exact-group", "delegate-tool-same-id", "exact-goal-1", "exact-goal-2",
    ]);
    expect(session.messages.map((message) => message.role)).toEqual([
      "agent-group", "tool", "goal", "goal",
    ]);
    expect(session.messages[0]).toBe(exactGroup);
    expect(session.messages[1]).toBe(exactTool);
    expect(session.messages.every((message) => message._timelineRecord === true)).toBe(true);
    expect(session.messages.some((message) => message.text.includes("替身"))).toBe(false);
    expect(session._blockIdToMsgId?.has("engine-goal")).toBe(false);
  });

  test("one explicit older page remains resident, advances once, and is never persisted", () => {
    const persistSession = vi.fn();
    const s = socket({ persistSession });
    s.applyServerMessages("s1", "main", latestPage(), true, 11, {
      timelineGeneration: 1,
      timelineCursor: "cursor-1",
      timelineHasMore: true,
      serverUpdatedAt: 1,
    });
    persistSession.mockClear();

    s.prependTimelinePage("s1", olderPage(), "cursor-1", "cursor-2", true, 1);
    const session = s.sessions.get("s1")!;
    expect(session.messages.map((message) => message.id)).toEqual([
      "user-older", "thinking-older", "answer-older",
      "user-latest", "thinking-latest", "tool-latest", "answer-latest",
    ]);
    expect(session.messages.slice(0, 3).every((message) =>
      message._historyPageLoadedFrom === "cursor-1" &&
      typeof message._historyPageKey === "string"
    )).toBe(true);
    expect(session._timelineCursor).toBe("cursor-2");
    expect(session._timelineHasMore).toBe(true);
    expect(persistSession).not.toHaveBeenCalled();

    const before = session.messages;
    s.prependTimelinePage("s1", olderPage(), "cursor-1", null, false, 1);
    expect(session.messages).toBe(before);
    expect(session._timelineCursor).toBe("cursor-2");

    const stored = s.toStored("s1")!;
    expect(stored.messages).toEqual([]);
  });

  test("reload discards every cached timeline row before a newer generation takes authority", () => {
    const original = socket();
    original.applyServerMessages("s1", "main", latestPage(), true, 11, {
      timelineGeneration: 1,
      timelineCursor: "cursor-1",
      timelineHasMore: true,
      serverUpdatedAt: 1,
    });
    const stored = original.toStored("s1")!;
    expect(stored.messages).toEqual([]);

    // Rolling clients may already have written unified rows before this fix.
    // The new reader must purge that cache even though old StoredSession has
    // no timeline-generation field.
    stored.messages = latestPage();
    const reloaded = socket();
    reloaded.loadStored(stored);
    expect(reloaded.sessions.get("s1")!.messages).toEqual([]);

    const replacement = [row({
      id: "replacement-after-reload",
      role: "assistant",
      text: "刷新后的服务端真相",
      _orderSeq: 20,
      _timelineUnitKey: "outer:20:replacement-after-reload",
    })];
    reloaded.applyServerMessages("s1", "main", replacement, true, 20, {
      timelineGeneration: 2,
      timelineCursor: null,
      timelineHasMore: false,
      serverUpdatedAt: 2,
    });
    expect(reloaded.sessions.get("s1")!.messages.map((message) => message.id)).toEqual([
      "replacement-after-reload",
    ]);
  });

  test("same-generation latest refresh updates matching rows without evicting older pages or rewinding cursor", () => {
    const s = socket();
    s.applyServerMessages("s1", "main", latestPage(), true, 11, {
      timelineGeneration: 1,
      timelineCursor: "cursor-1",
      timelineHasMore: true,
      serverUpdatedAt: 1,
    });
    s.prependTimelinePage("s1", olderPage(), "cursor-1", "cursor-2", true, 1);

    const refreshed = latestPage().map((message) => message.id === "answer-latest"
      ? { ...message, text: "更新后的真实回答", usage: { costCredits: "7" } }
      : message);
    s.applyServerMessages("s1", "main", refreshed, true, 12, {
      timelineGeneration: 1,
      timelineCursor: "latest-cursor-must-not-rewind",
      timelineHasMore: true,
      historyRevision: 9,
      serverUpdatedAt: 2,
    });

    const session = s.sessions.get("s1")!;
    expect(session.messages.some((message) => message.id === "thinking-older")).toBe(true);
    expect(session.messages.find((message) => message.id === "answer-latest")).toMatchObject({
      text: "更新后的真实回答",
      usage: { costCredits: "7" },
    });
    expect(session._timelineCursor).toBe("cursor-2");
    expect(session._historyRevision).toBe(9);
  });

  test("a true timeline-generation change atomically replaces all loaded pages", () => {
    const s = socket();
    s.applyServerMessages("s1", "main", latestPage(), true, 11, {
      timelineGeneration: 1,
      timelineCursor: "cursor-1",
      timelineHasMore: true,
      serverUpdatedAt: 1,
    });
    s.prependTimelinePage("s1", olderPage(), "cursor-1", null, false, 1);

    const replacement = [row({
      id: "replacement",
      role: "assistant",
      text: "新代次真实记录",
      _orderSeq: 20,
      _timelineUnitKey: "outer:20:replacement",
    })];
    s.applyServerMessages("s1", "main", replacement, true, 20, {
      timelineGeneration: 2,
      timelineCursor: null,
      timelineHasMore: false,
      serverUpdatedAt: 2,
    });

    const session = s.sessions.get("s1")!;
    expect(session.messages.map((message) => message.id)).toEqual(["replacement"]);
    expect(session._timelineGeneration).toBe(2);
    expect(session._historyPageSerial).toBe(0);
  });

  test("physical ordinal and logical ordinal win over skewed timestamps", () => {
    const records = [
      row({ id: "p2", _orderSeq: 4, _turnTapeId: "t", _turnTapeOrdinal: 2, _timelineLogicalOrdinal: 0, ts: 1 }),
      row({ id: "p1-l1", _orderSeq: 4, _turnTapeId: "t", _turnTapeOrdinal: 1, _timelineLogicalOrdinal: 1, ts: 1 }),
      row({ id: "p1-l0", _orderSeq: 4, _turnTapeId: "t", _turnTapeOrdinal: 1, _timelineLogicalOrdinal: 0, ts: 999 }),
      row({ id: "p0", _orderSeq: 4, _turnTapeId: "t", _turnTapeOrdinal: 0, _timelineLogicalOrdinal: 0, ts: 500 }),
    ];
    expect(stableSortByTs(records).map((message) => message.id)).toEqual([
      "p0", "p1-l0", "p1-l1", "p2",
    ]);
  });

  test("finalized timeline records never become live block mutation targets", () => {
    const s = socket();
    const session = s.ensureSession("s1", "main");
    session.messages = [row({
      id: "historical-tool",
      role: "tool",
      blockId: "reused-block",
      _turnTapeComplete: true,
      _turnTapeId: "tape-old",
    })];
    session._blockIdToMsgId = new Map();
    session._agentGroups = new Map();
    rebuildIndexes(session);
    expect(session._blockIdToMsgId.has("reused-block")).toBe(false);
  });
});
