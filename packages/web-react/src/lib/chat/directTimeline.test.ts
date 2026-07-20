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

function srvRow(over: Partial<ChatMessage>): ChatMessage {
  return { id: "x", role: "assistant", text: "", ts: 1, _source: "server", ...over } as ChatMessage;
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
    sock.applyExpandedTapeRecords(
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
    sock.applyExpandedTapeRecords(
      "s1",
      "turn-process:tape-1",
      [srvRow({ id: "tool-2", role: "tool", text: "二", _turnTapeOrdinal: 2 })],
      1,
    );
    sock.applyExpandedTapeRecords(
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

  test("history revision invalidates fetched rows and their cursor as one atomic view state", () => {
    const { sock, session } = seed();
    sock.applyExpandedTapeRecords(
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

  test("collapse removes fetched process rows but keeps the genuine final answer", () => {
    const { sock, session } = seed();
    sock.applyExpandedTapeRecords(
      "s1",
      "turn-process:tape-1",
      [srvRow({ id: "thinking-1", role: "thinking", text: "一", _turnTapeOrdinal: 1 })],
      null,
    );
    sock.collapseTurnProcess("s1", "turn-process:tape-1");
    expect(session.messages.some((message) => message.id === "thinking-1")).toBe(false);
    expect(session.messages.find((message) => message.id === "srv-a-t1")?.text).toBe("真实最终回答");
    expect(session.messages.find((message) => message.id === "turn-process:tape-1")?._turnTapeProcessExpanded)
      .toBe(false);
  });

  test("IndexedDB snapshot stores only the small control and genuine narrative, never fetched process copies", () => {
    const { sock } = seed();
    sock.applyExpandedTapeRecords(
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
