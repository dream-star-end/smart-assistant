/**
 * Direct immutable timeline frontend contracts.
 * The final answer is a genuine tape record shown immediately. Process rows
 * are fetched lazily, merged by immutable id/ordinal, and never persisted as
 * a second content copy.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { createSession, type ChatMessage } from "./model";
import {
  collapsedAnchorTerminalKind,
  collectResolvedDispatchTurnIds,
  formatTapeBytes,
  isCollapsedAnchorTerminalEvidence,
  isTurnStatusSuppressedByTape,
  isTurnTapeProcessControl,
  turnTapeProcessKey,
} from "./render";
import { detectServerTerminalTurns } from "../persist";
import { turnFinalAssistantFlags } from "../../components/chat/turnSegment";
import { ChatSocket, type ChatSocketDeps } from "./socket";
import { applyOutboundMessage } from "./reducer";
import type { OutboundMessageWire } from "./frames";

function srvRow(over: Partial<ChatMessage>): ChatMessage {
  return { id: "x", role: "assistant", text: "", ts: 1, _source: "server", ...over } as ChatMessage;
}

function liveFrame(over: Record<string, unknown>): OutboundMessageWire {
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

function processControl(over: Partial<ChatMessage> = {}): ChatMessage {
  return srvRow({
    id: "turn-process:tape-1",
    role: "runtime-event",
    text: "",
    _seq: 5,
    _orderSeq: 5,
    _turnTapeProcess: true,
    _turnTapeProcessCount: 3,
    _turnTapeTotalBytes: 192 * 1024 * 1024,
    _dispatchOutcome: "completed",
    _turnTapeId: "tape-1",
    _turnTapeSha256: "sha-1",
    _clientMessageId: "cm-1",
    ...over,
  });
}

function finalAnswer(over: Partial<ChatMessage> = {}): ChatMessage {
  return srvRow({
    id: "srv-a-t1",
    role: "assistant",
    text: "真实最终回答",
    _seq: 5,
    _orderSeq: 5,
    _turnTapeId: "tape-1",
    _turnTapeSha256: "sha-1",
    _turnTapeOrdinal: 3,
    _turnTapeComplete: true,
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

describe("direct timeline process control", () => {
  test("typed process control is not Agent-authored content", () => {
    expect(isTurnTapeProcessControl(processControl())).toBe(true);
    expect(isTurnTapeProcessControl(finalAnswer())).toBe(false);
    expect(turnTapeProcessKey(processControl())).toBe(
      "tape-1::sha-1::turn-process:tape-1",
    );
  });

  test("terminal outcome is completion evidence without pretending the control is the final answer", () => {
    expect(collapsedAnchorTerminalKind("completed")).toBe("completed");
    expect(collapsedAnchorTerminalKind("interrupted")).toBe("completed");
    expect(collapsedAnchorTerminalKind("crashed")).toBe("error");
    expect(isCollapsedAnchorTerminalEvidence(processControl())).toBe(true);
    expect(isCollapsedAnchorTerminalEvidence(finalAnswer())).toBe(false);
  });

  test("only the genuine final assistant record receives the rating slot", () => {
    const rows = [
      srvRow({ id: "cm-1", role: "user", text: "问题" }),
      processControl(),
      finalAnswer(),
    ];
    expect(turnFinalAssistantFlags(rows)).toEqual([false, false, true]);
  });

  test("byte formatting is metadata only", () => {
    expect(formatTapeBytes(2 * 1024 * 1024)).toBe("2.0 MB");
    expect(formatTapeBytes(64 * 1024)).toBe("64 KB");
    expect(formatTapeBytes(500)).toBe("500 B");
    expect(formatTapeBytes(0)).toBe("");
  });
});

describe("durable status versus true tape", () => {
  test("same-turn tape suppresses a stale typed failure status", () => {
    const status = srvRow({
      id: "turn-status:d1",
      role: "system",
      _turnStatusRecord: true,
      _dispatchTerminal: true,
      _errorCode: "dispatch_lost",
      _clientMessageId: "cm-1",
    });
    const resolved = collectResolvedDispatchTurnIds([status, processControl(), finalAnswer()]);
    expect(resolved.has("cm-1")).toBe(true);
    expect(isTurnStatusSuppressedByTape(status, resolved)).toBe(true);
    expect(isTurnStatusSuppressedByTape(status, collectResolvedDispatchTurnIds([status]))).toBe(false);
  });

  test("terminal detection distinguishes status, process outcome, and real final content", () => {
    const status = srvRow({
      id: "turn-status:d1",
      role: "system",
      _turnStatusRecord: true,
      _dispatchTerminal: true,
      _clientMessageId: "cm-status",
    });
    expect(detectServerTerminalTurns([status]).get("cm-status")).toBe("error");
    expect(detectServerTerminalTurns([processControl()]).get("cm-1")).toBe("completed");
    expect(detectServerTerminalTurns([finalAnswer()]).get("cm-1")).toBe("completed");
  });
});

describe("lazy immutable process merge", () => {
  afterEach(() => vi.restoreAllMocks());

  function seed(): { sock: ChatSocket; session: ReturnType<typeof createSession> } {
    const sock = makeSocket();
    sock.applyServerMessages(
      "s1",
      "main",
      [
        srvRow({ id: "cm-1", role: "user", text: "问题", _seq: 4, _orderSeq: 4 }),
        processControl(),
        finalAnswer(),
      ],
      true,
      5,
      { serverUpdatedAt: 100 },
    );
    return { sock, session: sock.sessions.get("s1")! };
  }

  test("page rows merge by true ordinal and do not duplicate the already-visible final answer", () => {
    const { sock, session } = seed();
    const maxSeqBefore = session._maxSeq;
    sock.applyTapeRecordsPage(
      "s1",
      "turn-process:tape-1",
      [
        srvRow({
          id: "runtime-0",
          role: "runtime-event",
          _runtimeEvent: { type: "progress", exact: true },
          _turnTapeOrdinal: 0,
        }),
        srvRow({ id: "thinking-1", role: "thinking", text: "真实思考", _turnTapeOrdinal: 1 }),
        srvRow({ id: "tool-2", role: "tool", toolName: "Bash", text: "真实工具输出", _turnTapeOrdinal: 2 }),
        finalAnswer({ text: "page copy must not replace timeline truth" }),
      ],
      null,
    );

    const section = session.messages.filter((message) => message._turnTapeId === "tape-1");
    expect(section.map((message) => message.id)).toEqual([
      "turn-process:tape-1",
      "runtime-0",
      "thinking-1",
      "tool-2",
      "srv-a-t1",
    ]);
    expect(section.filter((message) => message.id === "srv-a-t1")).toHaveLength(1);
    expect(section.at(-1)?.text).toBe("真实最终回答");
    expect(session._maxSeq).toBe(maxSeqBefore);
    expect(session.messages.find((message) => message.id === "runtime-0")?._seq).toBe(5);
  });

  test("subsequent pages insert by ordinal instead of append order", () => {
    const { sock, session } = seed();
    sock.applyTapeRecordsPage(
      "s1",
      "turn-process:tape-1",
      [srvRow({ id: "tool-2", role: "tool", text: "二", _turnTapeOrdinal: 2 })],
      1,
    );
    sock.applyTapeRecordsPage(
      "s1",
      "turn-process:tape-1",
      [
        srvRow({ id: "thinking-1", role: "thinking", text: "一", _turnTapeOrdinal: 1 }),
        srvRow({ id: "tool-2", role: "tool", text: "duplicate", _turnTapeOrdinal: 2 }),
      ],
      null,
    );
    expect(session.messages.filter((message) => message._turnTapeId === "tape-1")
      .map((message) => message.id)).toEqual([
      "turn-process:tape-1", "thinking-1", "tool-2", "srv-a-t1",
    ]);
    expect(session.messages.find((message) => message.id === "tool-2")?.text).toBe("二");
  });

  test("each fetched page keeps a lightweight render-page identity and duplicate merges are inert", () => {
    const persistSession = vi.fn();
    const sock = makeSocket({ persistSession });
    sock.applyServerMessages(
      "s1",
      "main",
      [
        srvRow({ id: "cm-1", role: "user", text: "问题", _seq: 4, _orderSeq: 4 }),
        processControl(),
        finalAnswer(),
      ],
      true,
      5,
      { historyRevision: 7, serverUpdatedAt: 100 },
    );
    persistSession.mockClear();

    const tail = srvRow({ id: "tool-tail", role: "tool", text: "尾页", _turnTapeOrdinal: 2 });
    sock.applyTapeRecordsPage("s1", "turn-process:tape-1", [tail], 2);
    const session = sock.sessions.get("s1")!;
    const tailPageKey = session.messages.find((message) => message.id === "tool-tail")
      ?._turnTapeProcessPageKey;
    expect(tailPageKey).toContain("tail");

    persistSession.mockClear();
    sock.applyTapeRecordsPage("s1", "turn-process:tape-1", [tail], 2);
    expect(persistSession).not.toHaveBeenCalled();

    const older = srvRow({ id: "thinking-old", role: "thinking", text: "更早", _turnTapeOrdinal: 1 });
    sock.applyTapeRecordsPage("s1", "turn-process:tape-1", [older], null);
    const olderPageKey = session.messages.find((message) => message.id === "thinking-old")
      ?._turnTapeProcessPageKey;
    expect(olderPageKey).toContain("before:2");
    expect(olderPageKey).not.toBe(tailPageKey);
  });

  test("CCB Bash tail continuation updates loaded tool cards without mutating immutable rows", () => {
    const { sock, session } = seed();
    session.messages.push(processControl({
      id: "turn-process:tape-tail",
      _turnTapeId: "tape-tail",
      _turnTapeSha256: "sha-tail",
      _seq: 6,
      _orderSeq: 6,
    }));
    sock.applyTapeRecordsPage(
      "s1",
      "turn-process:tape-1",
      [
        srvRow({
          id: "tool-bg",
          role: "tool",
          toolName: "Bash",
          blockId: "tool-bg",
          output: "Command running in background with ID: bg-1",
          _turnTapeOrdinal: 1,
        }),
        srvRow({
          id: "agent-bg",
          role: "agent-group",
          childBlocks: [{
            kind: "tool_use",
            blockId: "child-bg",
            toolName: "Bash",
            output: "Command running in background with ID: bg-2",
          }],
          _turnTapeOrdinal: 2,
        }),
      ],
      null,
    );
    const originalTool = session.messages.find((message) => message.id === "tool-bg")!;
    const originalGroup = session.messages.find((message) => message.id === "agent-bg")!;

    const oldTail = srvRow({
      id: "tail-old",
      role: "runtime-event",
      _runtimeSource: "ccb",
      _runtimeEvent: {
        type: "system",
        subtype: "bash_output_tail",
        tool_use_id: "tool-bg",
        tail: "旧快照",
        total_bytes: 42,
      },
      _turnTapeOrdinal: 1,
    });
    const latestTail = srvRow({
      id: "tail-latest",
      role: "runtime-event",
      _runtimeSource: "ccb",
      _runtimeEvent: {
        type: "system",
        subtype: "bash_output_tail",
        tool_use_id: "tool-bg",
        tail: "同字节数但更晚的真实快照",
        total_bytes: 42,
        truncated_head: true,
      },
      _turnTapeOrdinal: 2,
    });
    const childTail = srvRow({
      id: "tail-child",
      role: "runtime-event",
      _runtimeSource: "ccb",
      _runtimeEvent: {
        type: "system",
        subtype: "bash_output_tail",
        tool_use_id: "child-bg",
        parent_tool_use_id: "agent-bg",
        tail: "子 Agent 的真实后台输出",
        total_bytes: 31,
      },
      _turnTapeOrdinal: 3,
    });
    sock.applyTapeRecordsPage(
      "s1",
      "turn-process:tape-tail",
      [latestTail, oldTail, childTail],
      null,
    );

    expect(originalTool.bashTail).toBeUndefined();
    expect(originalGroup.childBlocks?.[0]?.bashTail).toBeUndefined();
    expect(session.messages.find((message) => message.id === "tool-bg")).not.toBe(originalTool);
    expect(session.messages.find((message) => message.id === "tool-bg")?.bashTail).toEqual({
      tail: "同字节数但更晚的真实快照",
      totalBytes: 42,
      truncatedHead: true,
    });
    expect(session.messages.find((message) => message.id === "agent-bg")?.childBlocks?.[0]?.bashTail)
      .toEqual({ tail: "子 Agent 的真实后台输出", totalBytes: 31, truncatedHead: false });
    expect(session.messages.find((message) => message.id === "agent-bg")?._runtimeBashTailRevision)
      .toBe(1);
    expect(session.messages.find((message) => message.id === "tail-latest")?._runtimeEvent)
      .toEqual(latestTail._runtimeEvent);
  });

  test("reverse lazy load reconciles a Bash tail that arrives before its owning tool row", () => {
    const { sock, session } = seed();
    const tail = srvRow({
      id: "tail-first",
      role: "runtime-event",
      _runtimeSource: "ccb",
      _runtimeEvent: {
        type: "system",
        subtype: "bash_output_tail",
        tool_use_id: "tool-later",
        tail: "先加载的真实尾部",
        total_bytes: 24,
      },
      _turnTapeOrdinal: 2,
    });
    sock.applyTapeRecordsPage("s1", "turn-process:tape-1", [tail], 1);
    expect(session.messages.find((message) => message.id === "tail-first")).toBeDefined();

    const tool = srvRow({
      id: "tool-later",
      role: "tool",
      toolName: "Bash",
      blockId: "tool-later",
      _turnTapeOrdinal: 1,
    });
    sock.applyTapeRecordsPage("s1", "turn-process:tape-1", [tool], null);

    expect(tool.bashTail).toBeUndefined();
    expect(session.messages.find((message) => message.id === "tool-later")?.bashTail).toEqual({
      tail: "先加载的真实尾部",
      totalBytes: 24,
      truncatedHead: false,
    });
  });

  test("lazy page merge keeps a local permission card before its real terminal answer", () => {
    const { sock, session } = seed();
    const finalIndex = session.messages.findIndex((message) => message.id === "srv-a-t1");
    session.messages.splice(finalIndex, 0, {
      id: "permission-local",
      role: "permission",
      text: "",
      ts: 2,
      _turnOwnerId: "cm-1",
      _resolved: true,
    });

    sock.applyTapeRecordsPage(
      "s1",
      "turn-process:tape-1",
      [srvRow({ id: "thinking-1", role: "thinking", text: "真实思考", _turnTapeOrdinal: 1 })],
      null,
    );

    const ids = session.messages.map((message) => message.id);
    expect(ids.indexOf("thinking-1")).toBeLessThan(ids.indexOf("permission-local"));
    expect(ids.indexOf("permission-local")).toBeLessThan(ids.indexOf("srv-a-t1"));
  });

  test("lazy pages preserve immutable delegate and repeated goal records without display folding", () => {
    const { sock, session } = seed();
    const finalIndex = session.messages.findIndex((message) => message.id === "srv-a-t1");
    session.messages.splice(finalIndex, 0, {
      id: "local-group",
      role: "agent-group",
      text: "local live card",
      ts: 2,
      _delegate: true,
      _delegateRunId: "run-shared",
      _turnOwnerId: "cm-1",
      childBlocks: [],
    });

    sock.applyTapeRecordsPage(
      "s1",
      "turn-process:tape-1",
      [
        srvRow({
          id: "server-group",
          role: "agent-group",
          text: "immutable group transcript",
          _delegateRunId: "run-shared",
          summary: "immutable summary",
          _turnTapeOrdinal: 0,
        }),
        srvRow({
          id: "server-delegate-tool",
          role: "tool",
          text: "immutable delegate tool",
          toolName: "delegate_task",
          blockId: "delegate-block",
          inputJson: { agentId: "coder", goal: "raw delegated task" },
          output: "raw delegated result",
          _turnTapeOrdinal: 1,
        }),
        srvRow({ id: "goal-first", role: "goal", text: "first goal event", blockId: "engine-goal", _turnTapeOrdinal: 1 }),
        srvRow({ id: "goal-second", role: "goal", text: "second goal event", blockId: "engine-goal", _turnTapeOrdinal: 2 }),
      ],
      null,
    );

    const expectExactRows = () => {
      expect(session.messages.find((message) => message.id === "server-group")).toMatchObject({
        role: "agent-group",
        text: "immutable group transcript",
        summary: "immutable summary",
        _source: "server",
      });
      expect(session.messages.find((message) => message.id === "server-delegate-tool")).toMatchObject({
        role: "tool",
        text: "immutable delegate tool",
        output: "raw delegated result",
        _source: "server",
      });
      expect(session.messages.filter((message) =>
        message.id === "goal-first" || message.id === "goal-second"))
        .toHaveLength(2);
      expect(session._blockIdToMsgId?.get("delegate-block")).toBeUndefined();
      expect(session._blockIdToMsgId?.get("engine-goal")).toBeUndefined();
    };
    expect(session.messages.find((message) => message.id === "local-group")).toBeDefined();
    expectExactRows();

    sock.applyServerMessages(
      "s1",
      "main",
      [
        srvRow({ id: "cm-1", role: "user", text: "问题", _seq: 4, _orderSeq: 4 }),
        processControl(),
        finalAnswer(),
      ],
      true,
      5,
      { serverUpdatedAt: 101 },
    );
    expectExactRows();

    sock.prependArchivedMessages("s1", [
      srvRow({ id: "archived-before", role: "assistant", text: "更早的真实记录", _seq: 1, _orderSeq: 1 }),
    ]);
    expectExactRows();
  });

  test("later live turns cannot adopt, finalize, or stream into immutable lazy rows", () => {
    const { sock, session } = seed();
    sock.applyTapeRecordsPage(
      "s1",
      "turn-process:tape-1",
      [
        srvRow({ id: "exact-plan", role: "plan", text: "partial historical plan", _partial: true, _turnTapeOrdinal: 0 }),
        srvRow({ id: "exact-tool", role: "tool", text: "historical tool", _completed: false, _turnTapeOrdinal: 1 }),
        srvRow({
          id: "exact-progress",
          role: "delegate-progress",
          text: "",
          runId: "run-history",
          agentId: "coder",
          goal: "same goal",
          _delegateGoal: "same goal",
          entries: [{ phase: "text", text: "immutable progress entry", ts: 1 }],
          _completed: false,
          _turnTapeOrdinal: 2,
        }),
        srvRow({ id: "exact-assistant", role: "assistant", text: "immutable assistant", _turnTapeOrdinal: 3 }),
        srvRow({ id: "exact-thinking", role: "thinking", text: "immutable thinking", _turnTapeOrdinal: 4 }),
      ],
      null,
    );
    session.messages.push(srvRow({ id: "cm-2", role: "user", text: "later turn", _seq: 6, _orderSeq: 6 }));
    session._activeClientMessageId = "cm-2";
    session._sendingInFlight = true;

    applyOutboundMessage(session, liveFrame({
      frameSeq: 1,
      clientMessageId: "cm-2",
      blocks: [{
        kind: "tool_use",
        toolName: "delegate_task",
        blockId: "later-delegate",
        inputJson: { agentId: "coder", goal: "same goal" },
      }],
    }));
    applyOutboundMessage(session, liveFrame({
      frameSeq: 2,
      clientMessageId: "cm-2",
      blocks: [{
        kind: "delegate_progress",
        runId: "run-history",
        agentId: "coder",
        goal: "same goal",
        phase: "text",
        text: "later live progress",
      }],
    }));
    applyOutboundMessage(session, liveFrame({
      frameSeq: 3,
      clientMessageId: "cm-2",
      blocks: [
        { kind: "text", messageId: "exact-assistant", text: "must not append" },
        { kind: "thinking", messageId: "exact-thinking", text: "must not append" },
      ],
    }));
    applyOutboundMessage(session, liveFrame({
      frameSeq: 4,
      clientMessageId: "cm-2",
      blocks: [],
      isFinal: true,
    }));

    expect(session.messages.find((message) => message.id === "exact-plan"))
      .toMatchObject({ text: "partial historical plan", _partial: true });
    expect(session.messages.find((message) => message.id === "exact-tool"))
      .toMatchObject({ text: "historical tool", _completed: false });
    expect(session.messages.find((message) => message.id === "exact-progress")).toMatchObject({
      runId: "run-history",
      entries: [{ phase: "text", text: "immutable progress entry", ts: 1 }],
      _completed: false,
    });
    expect(session.messages.filter((message) => message.id === "exact-assistant"))
      .toEqual([expect.objectContaining({ text: "immutable assistant" })]);
    expect(session.messages.filter((message) => message.id === "exact-thinking"))
      .toEqual([expect.objectContaining({ text: "immutable thinking" })]);
  });

  test("history revision invalidates fetched rows and their cursor as one atomic view state", () => {
    const { sock, session } = seed();
    sock.applyTapeRecordsPage(
      "s1",
      "turn-process:tape-1",
      [srvRow({ id: "thinking-1", role: "thinking", text: "第一页", _turnTapeOrdinal: 1 })],
      200,
    );
    expect(session.messages.find((message) => message.id === "thinking-1")).toBeDefined();
    expect(session.messages.find((message) => message.id === "turn-process:tape-1"))
      .toMatchObject({ _turnTapeProcessExpanded: true, _turnTapeProcessCursor: 200 });

    sock.applyServerMessages(
      "s1",
      "main",
      [
        srvRow({ id: "cm-1", role: "user", text: "问题", _seq: 4, _orderSeq: 4 }),
        processControl(),
        finalAnswer(),
      ],
      true,
      5,
      { historyRevision: 1, serverUpdatedAt: 101 },
    );

    expect(session.messages.find((message) => message.id === "thinking-1")).toBeUndefined();
    const control = session.messages.find((message) => message.id === "turn-process:tape-1")!;
    expect(control._turnTapeProcessExpanded).toBeUndefined();
    expect(control._turnTapeProcessCursor).toBeUndefined();
  });

  test("IndexedDB snapshot stores only the small control and genuine narrative, never fetched process copies", () => {
    const { sock } = seed();
    sock.applyTapeRecordsPage(
      "s1",
      "turn-process:tape-1",
      [srvRow({ id: "thinking-1", role: "thinking", text: "一", _turnTapeOrdinal: 1 })],
      2,
    );
    const stored = sock.toStored("s1")!;
    expect(stored.messages.some((message) => message.id === "thinking-1")).toBe(false);
    expect(stored.messages.find((message) => message.id === "srv-a-t1")?.text).toBe("真实最终回答");
    const control = stored.messages.find((message) => message.id === "turn-process:tape-1")!;
    expect(control._turnTapeProcess).toBe(true);
    expect(control._turnTapeProcessExpanded).toBeUndefined();
    expect(control._turnTapeProcessCursor).toBeUndefined();
  });
});
