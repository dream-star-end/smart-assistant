// browser-tests 挂载壳:在真浏览器里 mount **真实 Composer**(非复刻结构),
// 由 run.mjs 用受信点击驱动断言。背景(2026-07-18 附件事故):jsdom 的 label
// 激活查找走 ownerDocument 而非 tree scope、fireEvent 非受信不触发同步 flush,
// "点击→选择器弹出"这类交互契约在 jsdom 里物理上测不出真实结果,必须真浏览器。
//
// stub 原则:只 stub 网络/宿主副作用(上传/发送/目标提交),不 stub 任何 UI 结构;
// onUpload 立即 resolve → 附件 chip 无后端也能走到 done 态,CI 零外部依赖。
import {
  StrictMode,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createRoot } from "react-dom/client";
import { Composer } from "../src/components/Composer";
import { MessageFeedbackDialog } from "../src/components/chat/MessageFeedbackDialog";
import { MessageList, MessageRenderer } from "../src/components/MessageRenderer";
import { ModelSelector } from "../src/components/ModelSelector";
import { ToolCard } from "../src/components/ToolCard";
import { TeamPanel } from "../src/components/chat/TeamPanel";
import {
  captureVisibleVirtualRowAnchor,
  restoreVisibleVirtualRowAnchor,
} from "../src/components/chat/archivePaging";
import {
  mergeTimelineHistoryPage,
  SessionStore,
  type StoredPendingDispatch,
  type StoredSession,
} from "../src/lib/persist";
import type { ChatMessage } from "../src/lib/chat/model";
import type { MediaRef } from "../src/lib/chat/frames";
import { createMemoryAuthSession } from "../src/lib/authSession";
import { ChatSocket } from "../src/lib/chat/socket";
import {
  admittedAckFrame,
  EXPECTED_TIMELINE_ROLES,
  relayReadyFrame,
  REPLAY_AGENT_ID,
  REPLAY_MARKERS,
  REPLAY_SESSION_ID,
  replayTurnFrames,
} from "./fixtures/turnReplay";

declare global {
  interface Window {
    __sends: Array<{ text: string; mediaCount: number }>;
    __uploads: string[];
    __lazyTimeline: {
      userFetches: number;
      tapeFetches: number;
      userRetry: null | {
        id: string;
        text: string;
        modelText?: string;
        retryFilename?: string;
      };
      tapeFetch: null | { tapeId: string; ordinal: number; recordId: string; role: string };
    };
    __scrollTimeline: {
      calls: string[];
      mergedPages: number;
      messageCount: number;
      loading: boolean;
      anchor: null | {
        key: string;
        top: number;
        dataIndex: string | null;
        scrollTop: number;
        scrollHeight: number;
      };
    };
    __archiveTimeline: {
      calls: number;
      mergedPages: number;
      messageCount: number;
    };
    __askQuestion: { responses: unknown[] };
    __messageQuote: {
      sends: Array<{
        text: string;
        replyTo?: { messageId: string; role: "user" | "assistant"; text: string };
      }>;
    };
    __mountAskQuestion: () => void;
    __completeTimelineThinking: () => void;
    /** fixture 的精确文本标记与期望顺序,供 run.mjs 读取 —— 断言常量不在两处各写一份。 */
    __replayFixture: {
      markers: Record<string, string>;
      expectedRoles: readonly string[];
    };
    /** T21 真 WS 帧 replay 驱动面(见文件末尾 ReplayTimelineProbe)。 */
    __replay: {
      /** 客户端经真 socket 实际发出的 wire 帧原文(含 hello / inbound.message)。 */
      sent: string[];
      /** socket 判定的会话忙态(sending),即 MessageList 收到的 sending prop。 */
      sending: boolean;
      /** 已渲染的时间线条目(顺序即虚拟列表顺序)。 */
      rows: Array<{ role: string; id: string }>;
    };
    __replayDrive: {
      /** relay 就绪 → 排空离线队列 → 真发 inbound.message。返回该次发送的 clientMessageId。 */
      openTurn: () => Promise<string>;
      /** 推入下一帧 outbound.message;返回已推入的帧数。 */
      pushNextFrame: () => number;
      /** 剩余帧一次推完。 */
      pushRemainingFrames: () => number;
      frameCount: () => number;
    };
    /** T23 会话内切模型:候选项展示名与 id 的单一权威(run.mjs 从页面读回)。 */
    __modelFixture: {
      markers: Record<string, string>;
      ids: Record<string, string>;
    };
    /** T23 ModelSelector.onSelect 真实收到的 model id(顺序即点击顺序)。 */
    __modelPicks: string[];
    __runPendingDispatchJournalProbe: () => Promise<{
      survivedStaleWrite: boolean;
      resistedResurrection: boolean;
    }>;
  }
}
window.__sends = [];
window.__uploads = [];
window.__lazyTimeline = { userFetches: 0, tapeFetches: 0, userRetry: null, tapeFetch: null };
window.__scrollTimeline = {
  calls: [],
  mergedPages: 0,
  messageCount: 0,
  loading: false,
  anchor: null,
};
window.__archiveTimeline = { calls: 0, mergedPages: 0, messageCount: 0 };
window.__askQuestion = { responses: [] };
window.__messageQuote = { sends: [] };
window.__mountAskQuestion = () => {};
window.__completeTimelineThinking = () => {};
window.__replayFixture = {
  markers: { ...REPLAY_MARKERS },
  expectedRoles: EXPECTED_TIMELINE_ROLES,
};
window.__replay = { sent: [], sending: false, rows: [] };
window.__modelPicks = [];
window.__replayDrive = {
  openTurn: async () => {
    throw new Error("replay probe 未挂载");
  },
  pushNextFrame: () => 0,
  pushRemainingFrames: () => 0,
  frameCount: () => 0,
};
window.__runPendingDispatchJournalProbe = async () => {
  const userId = `browser-journal-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const first = new SessionStore(userId);
  const stale = new SessionStore(userId);
  const session: StoredSession = {
    id: "browser-journal-session",
    agentId: "main",
    title: "fresh",
    messages: [],
    createdAt: 1,
    lastAt: 1,
  };
  const pending: StoredPendingDispatch = {
    msgId: "browser-journal-message",
    enqueuedAt: 2,
    payload: {
      type: "inbound.message",
      idempotencyKey: "web:browser-journal-message:0",
      channel: "webchat",
      peer: { id: session.id, kind: "dm" },
      agentId: "main",
      clientMessageId: "browser-journal-message",
      content: { text: "EXACT_BROWSER_JOURNAL_PAYLOAD" },
      ts: 2,
    },
  };

  await first.putSessionDurably(session);
  await first.putPendingDispatch(session.id, pending);
  await stale.putSessionDurably({ ...session, title: "stale-without-journal" });
  const survivedStaleWrite =
    (await first.getAllForHydration())[0]?._pendingDispatches?.[0]?.msgId === pending.msgId;

  await first.deletePendingDispatch(session.id, pending.msgId);
  await stale.putSessionDurably({ ...session, _pendingDispatches: [pending] });
  const resistedResurrection =
    (await first.getAllForHydration())[0]?._pendingDispatches === undefined;

  await first.wipe();
  stale.close();
  return { survivedStaleWrite, resistedResurrection };
};

const uploadStub = async (file: File): Promise<MediaRef> => {
  window.__uploads.push(file.name);
  return { kind: "file", url: "https://stub.invalid/browser-test", filename: file.name };
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Composer
      onSend={(text, media) => {
        window.__sends.push({ text, mediaCount: media?.length ?? 0 });
      }}
      onUpload={uploadStub}
      onSetGoal={async () => {}}
      onGoalAction={async () => {}}
    />
  </StrictMode>,
);

const feedbackAuth = createMemoryAuthSession(() => {}, "browser-feedback-token");
function FeedbackProbe() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          triggerRef.current = event.currentTarget;
          setOpen(true);
        }}
      >
        打开消息反馈
      </button>
      <MessageFeedbackDialog
        open={open}
        onOpenChange={setOpen}
        auth={feedbackAuth}
        sessionId="browser-session"
        context={{
          traceId: "browser-trace",
          messageId: "browser-message",
          role: "assistant",
          errorCode: null,
          textPreview: "BROWSER_FEEDBACK_EXCERPT",
        }}
        returnFocus={triggerRef.current}
      />
    </>
  );
}

createRoot(document.getElementById("feedback-root")!).render(
  <StrictMode><FeedbackProbe /></StrictMode>,
);

type QuoteProbe = {
  messageId: string;
  role: "user" | "assistant";
  text: string;
};

const quoteAssistant: ChatMessage = {
  id: "assistant-quote-probe",
  role: "assistant",
  text: "这是需要被引用的完整回答",
  ts: 1,
};

function MessageQuoteProbe() {
  const [replyTo, setReplyTo] = useState<QuoteProbe | null>(null);
  return (
    <>
      <MessageRenderer
        message={quoteAssistant}
        sig="assistant-quote-probe"
        isLast
        sending={false}
        inActiveTurn
        turnFinalAssistant
        cb={{
          onQuote: (message: ChatMessage) => setReplyTo({
            messageId: message.id,
            role: message.role as "user" | "assistant",
            text: message.text,
          }),
        } as never}
        onRespondPermission={() => {}}
      />
      <Composer
        {...({
          onSend: (text: string, _media?: MediaRef[], quote?: QuoteProbe) => {
            window.__messageQuote.sends.push({
              text,
              ...(quote ? { replyTo: quote } : {}),
            });
          },
          replyTo,
          onCancelReply: () => setReplyTo(null),
        } as React.ComponentProps<typeof Composer>)}
      />
    </>
  );
}

createRoot(document.getElementById("message-quote-root")!).render(
  <StrictMode><MessageQuoteProbe /></StrictMode>,
);

const activeAskQuestion: ChatMessage = {
  id: "active-ask-question",
  role: "permission",
  text: "AskUserQuestion",
  ts: 5,
  toolName: "AskUserQuestion",
  requestId: "ask-active-r1",
  inputJson: {
    questions: [
      {
        header: "画面风格",
        question: "画面风格选哪种?",
        multiSelect: false,
        options: [
          { label: "仿古画卷2.5D", description: "推荐，接近原画美感" },
          { label: "全3D低多边形", description: "偏现代游戏风格" },
        ],
      },
    ],
  },
  _resolved: false,
};

window.__mountAskQuestion = () => {
  createRoot(document.getElementById("ask-question-root")!).render(
    <StrictMode>
      <MessageRenderer
        message={activeAskQuestion}
        sig="active-ask-question"
        isLast
        sending
        inActiveTurn
        cb={{}}
        onRespondPermission={(response) => window.__askQuestion.responses.push(response)}
      />
    </StrictMode>,
  );
};

const deferredUser: ChatMessage = {
  id: "deferred-user-probe",
  role: "user",
  text: "",
  ts: 1,
  status: "error",
  _payloadDeferred: true,
  _userPayloadDeferred: true,
  _payloadBytes: 5_000_000,
  _payloadSha256: "a".repeat(64),
  _deferredRetryEligible: true,
};
const exactUser: ChatMessage = {
  id: deferredUser.id,
  role: "user",
  text: "EXACT_DEFERRED_USER_MARKER",
  ts: 1,
  _modelText: "EXACT_MODEL_VISIBLE_PROMPT",
  _retryMedia: [{ kind: "file", url: "https://stub.invalid/exact", filename: "exact-retry.txt" }],
};

createRoot(document.getElementById("timeline-user-root")!).render(
  <StrictMode>
    <MessageRenderer
      message={deferredUser}
      sig="deferred-user-probe"
      isLast
      sending={false}
      inActiveTurn
      cb={{
        onFetchUserMessagePayload: async () => {
          window.__lazyTimeline.userFetches += 1;
          return [exactUser];
        },
        onRetrySend: (message) => {
          window.__lazyTimeline.userRetry = {
            id: message.id,
            text: message.text,
            modelText: message._modelText,
            retryFilename: message._retryMedia?.[0]?.filename,
          };
        },
      }}
      onRespondPermission={() => {}}
    />
  </StrictMode>,
);

const deferredAgentRecord: ChatMessage = {
  id: "deferred-tool-probe",
  role: "tool",
  text: "",
  ts: 2,
  _payloadDeferred: true,
  _payloadBytes: 5_000_000,
  _payloadSha256: "b".repeat(64),
  _turnTapeId: "tape-browser-probe",
  _recordOrdinal: 7,
};
const exactAgentRecord: ChatMessage = {
  id: deferredAgentRecord.id,
  role: "tool",
  text: "",
  ts: 2,
  toolName: "Bash",
  inputJson: { command: "printf exact" },
  output: "EXACT_AGENT_PROCESS_MARKER",
  _completed: true,
};

createRoot(document.getElementById("timeline-agent-root")!).render(
  <StrictMode>
    <MessageRenderer
      message={deferredAgentRecord}
      sig="deferred-tool-probe"
      isLast
      sending={false}
      inActiveTurn
      cb={{
        onFetchTapeRecordPayload: async (tapeId, ordinal, expected) => {
          window.__lazyTimeline.tapeFetches += 1;
          window.__lazyTimeline.tapeFetch = {
            tapeId,
            ordinal,
            recordId: expected.recordId,
            role: expected.role,
          };
          return [exactAgentRecord];
        },
      }}
      onRespondPermission={() => {}}
    />
  </StrictMode>,
);

const singleAgentCard: ChatMessage = {
  id: "single-agent-card-probe",
  role: "agent-group",
  text: "SINGLE_AGENT_CARD",
  ts: 3,
  _completed: true,
  childBlocks: [{ kind: "text", text: "SINGLE_AGENT_PROCESS_MARKER" }],
};

createRoot(document.getElementById("single-agent-card-root")!).render(
  <StrictMode>
    <MessageRenderer
      message={singleAgentCard}
      sig="single-agent-card-probe"
      isLast
      sending={false}
      inActiveTurn
      cb={{}}
      onRespondPermission={() => {}}
    />
  </StrictMode>,
);

const teamAgentCard: ChatMessage = {
  id: "team-agent-card-probe",
  role: "agent-group",
  text: "TEAM_AGENT_GOAL",
  ts: 4,
  _delegate: true,
  _delegateAgentId: "TEAM_AGENT_CARD",
  _completed: true,
  childBlocks: [{ kind: "text", text: "TEAM_AGENT_PROCESS_MARKER" }],
};

createRoot(document.getElementById("team-agent-card-root")!).render(
  <StrictMode>
    <TeamPanel members={[teamAgentCard]} sig="team-agent-card-probe" />
  </StrictMode>,
);

const marketItems = Array.from({ length: 10 }, (_, index) => ({
  slug: `browser-skill-${index + 1}`,
  name: `浏览器能力 ${index + 1}`,
  kind: "skill",
  description: `适合场景 ${index + 1}`,
}));
createRoot(document.getElementById("tool-card-polish-root")!).render(
  <StrictMode>
    <div style={{ width: 360, maxWidth: "100%" }}>
      <ToolCard
        message={{
          toolName: "Bash",
          inputJson: { command: "oc-market search browser" },
          output: JSON.stringify(marketItems),
          _completed: true,
        }}
      />
    </div>
  </StrictMode>,
);

const timelineThinking: ChatMessage = {
  id: "timeline-thinking-live",
  role: "thinking",
  text: "EXACT_LIVE_TIMELINE_THINKING",
  ts: 3,
  _source: "server",
  _orderSeq: 3,
  _timelineRecord: true,
  _timelineUnitKey: "outer:3:timeline-thinking-live",
};

function TimelineThinkingProbe() {
  const [sending, setSending] = useState(true);
  useLayoutEffect(() => {
    window.__completeTimelineThinking = () => setSending(false);
    return () => { window.__completeTimelineThinking = () => {}; };
  }, []);
  return (
    <MessageList
      messages={[timelineThinking]}
      sending={sending}
      cb={{}}
      onRespondPermission={() => {}}
    />
  );
}

createRoot(document.getElementById("timeline-thinking-root")!).render(
  <StrictMode>
    <TimelineThinkingProbe />
  </StrictMode>,
);

const initialTail: ChatMessage[] = Array.from({ length: 96 }, (_, index) => ({
  id: `scroll-tail-${index}`,
  role: "user",
  text: `SCROLL_TAIL_${index}`,
  ts: 10 + index,
  _source: "server",
  _orderSeq: 200 + index,
  _timelineRecord: true,
  _timelineUnitKey: `outer:${200 + index}:scroll-tail-${index}`,
}));

function olderPage(cursor: string): ChatMessage[] {
  // The opaque cursor contract is strict prepend: every returned logical
  // ordinal precedes the oldest resident tail record.
  const start = cursor === "cursor-200" ? 134 : 70;
  return Array.from({ length: 64 }, (_, index) => ({
    id: `scroll-old-${cursor}-${index}`,
    role: index % 3 === 0 ? "thinking" : index % 3 === 1 ? "tool" : "assistant",
    text: `SCROLL_OLDER_${cursor}_${index}`,
    ts: start + index,
    _source: "server",
    _orderSeq: start + index,
    _timelineRecord: true,
    _timelineUnitKey: `outer:${start + index}:scroll-old-${cursor}-${index}`,
    _historyPageLoadedFrom: cursor,
    _historyPageKey: `history:${cursor}`,
  } as ChatMessage));
}

function ScrollTimelineProbe() {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [cursor, setCursor] = useState<string | null>("cursor-200");
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "scroll-user",
      role: "user",
      text: "SCROLL_USER_QUESTION",
      ts: 1,
      status: "replied",
      _source: "server",
      _orderSeq: 198,
      _timelineRecord: true,
      _timelineUnitKey: "outer:198:scroll-user",
    },
    {
      id: "scroll-thinking",
      role: "thinking",
      text: "SCROLL_REAL_THINKING",
      ts: 2,
      _source: "server",
      _orderSeq: 199,
      _timelineRecord: true,
      _timelineUnitKey: "outer:199:scroll-thinking",
    },
    ...initialTail,
    {
      id: "scroll-answer",
      role: "assistant",
      text: "SCROLL_FINAL_ANSWER",
      ts: 500,
      _source: "server",
      _orderSeq: 500,
      _timelineRecord: true,
      _timelineUnitKey: "outer:500:scroll-answer",
    },
  ]);
  const pendingRestoreRef = useRef<{
    anchor: NonNullable<ReturnType<typeof captureVisibleVirtualRowAnchor>>;
    resolve: () => void;
  } | null>(null);
  useLayoutEffect(() => {
    const pending = pendingRestoreRef.current;
    if (!pending || !scroller) return;
    pendingRestoreRef.current = null;
    void restoreVisibleVirtualRowAnchor(scroller, pending.anchor, () => false)
      .finally(pending.resolve);
  }, [messages, scroller]);
  const loadOlder = useCallback(async () => {
    if (loading || !cursor) return;
    const requestedCursor = cursor;
    const anchor = scroller ? captureVisibleVirtualRowAnchor(scroller) : null;
    window.__scrollTimeline.anchor = anchor ? {
      key: anchor.key,
      top: anchor.top,
      dataIndex: anchor.dataIndex,
      scrollTop: anchor.scrollTop,
      scrollHeight: anchor.scrollHeight,
    } : null;
    setLoading(true);
    window.__scrollTimeline.calls.push(requestedCursor);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const nextCursor = requestedCursor === "cursor-200" ? "cursor-100" : null;
    const anchored = scroller && anchor
      ? new Promise<void>((resolve) => {
        pendingRestoreRef.current = { anchor, resolve };
      })
      : Promise.resolve();
    setMessages((current) => {
      const merged = mergeTimelineHistoryPage(current, olderPage(requestedCursor));
      if (merged !== current) window.__scrollTimeline.mergedPages += 1;
      return merged;
    });
    setCursor(nextCursor);
    await anchored;
    setLoading(false);
  }, [cursor, loading, scroller]);
  window.__scrollTimeline.messageCount = messages.length;
  window.__scrollTimeline.loading = loading;
  return (
    <div
      ref={setScroller}
      className="chat-scroll-area timeline-scroll-probe"
      data-testid="timeline-scroll-probe"
      tabIndex={0}
    >
      <MessageList
        messages={messages}
        sending={false}
        archive={{
          hasMore: cursor !== null,
          loading,
          error: false,
          onLoadOlder: loadOlder,
        }}
        cb={{}}
        onRespondPermission={() => {}}
        scrollParent={scroller}
        historyGeneration={7}
      />
    </div>
  );
}

createRoot(document.getElementById("timeline-scroll-root")!).render(
  <StrictMode><ScrollTimelineProbe /></StrictMode>,
);

const archiveTail: ChatMessage[] = Array.from({ length: 120 }, (_, index) => ({
  id: `archive-tail-${index}`,
  role: "user",
  text: `ARCHIVE_TAIL_${index}`,
  ts: 300 + index,
  _seq: 300 + index,
  _source: "server",
  _timelineRecord: true,
  _timelineUnitKey: `outer:${300 + index}:archive-tail-${index}`,
}));
const archiveOlder: ChatMessage[] = Array.from({ length: 80 }, (_, index) => ({
  id: `archive-older-${index}`,
  role: "user",
  text: `ARCHIVE_OLDER_${index}`,
  ts: 121 + index,
  _seq: 121 + index,
  _source: "server",
  _timelineRecord: true,
  _timelineUnitKey: `outer:${121 + index}:archive-older-${index}`,
  _historyPageLoadedFrom: "archive-cursor",
  _historyPageKey: "history:archive-cursor",
}));

function ArchiveTimelineProbe() {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>(archiveTail);
  const pendingRestoreRef = useRef<{
    anchor: NonNullable<ReturnType<typeof captureVisibleVirtualRowAnchor>>;
    resolve: () => void;
  } | null>(null);
  useLayoutEffect(() => {
    const pending = pendingRestoreRef.current;
    if (!pending || !scroller) return;
    pendingRestoreRef.current = null;
    void restoreVisibleVirtualRowAnchor(scroller, pending.anchor, () => false)
      .finally(pending.resolve);
  }, [messages, scroller]);
  const loadOlder = useCallback(async () => {
    const anchor = scroller ? captureVisibleVirtualRowAnchor(scroller) : null;
    window.__archiveTimeline.calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 40));
    const anchored = scroller && anchor
      ? new Promise<void>((resolve) => {
        pendingRestoreRef.current = { anchor, resolve };
      })
      : Promise.resolve();
    setMessages((current) => {
      if (current[0]?.id === archiveOlder[0]?.id) return current;
      window.__archiveTimeline.mergedPages += 1;
      return mergeTimelineHistoryPage(current, archiveOlder);
    });
    await anchored;
  }, [scroller]);
  window.__archiveTimeline.messageCount = messages.length;
  return (
    <div
      ref={setScroller}
      className="chat-scroll-area timeline-scroll-probe"
      data-testid="archive-timeline-scroll-probe"
      tabIndex={0}
    >
      <MessageList
        messages={messages}
        sending={false}
        archive={{
          hasMore: messages.length < 200,
          loading: false,
          error: false,
          onLoadOlder: loadOlder,
        }}
        cb={{}}
        onRespondPermission={() => {}}
        scrollParent={scroller}
        historyGeneration="archive-one-page"
      />
    </div>
  );
}

createRoot(document.getElementById("timeline-archive-root")!).render(
  <StrictMode><ArchiveTimelineProbe /></StrictMode>,
);

// ── T21 真 WS 帧 → 真 ChatSocket → 真 MessageList ────────────────────────────
//
// 补的是"帧 → reducer → 虚拟列表 → 卡片"这条链的中段:jsdom 单测只喂 reducer 已经
// 消化过的 ChatMessage 行,其他 browser 用例直接把手写 stub 行挂 MessageRenderer;
// 真实 wire 帧被 ChatSocket 消化后到底渲成什么,过去两侧都没有人守(#147→#158 十一连修
// 全落在这段上)。
//
// stub 只替换**传输**(WebSocket),ChatSocket / reducer / MessageList / 各卡片全部是
// 生产实现;帧来自单一权威 fixture,且由 replayFrames.contract.test.ts 对 protocol
// typebox schema 逐帧校验,不是"看起来像"的手写 JSON。
type HarnessSocketEvent = { data: string };

class HarnessWebSocket {
  static latest: HarnessWebSocket | null = null;
  readyState = 0;
  bufferedAmount = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: HarnessSocketEvent) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(_url: string, _protocols?: string[]) {
    HarnessWebSocket.latest = this;
    // 真握手是异步的;同步 open 会把"连接前入队、就绪后排空"这条真实路径抹掉。
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.({});
    }, 0);
  }

  send(data: string): void {
    window.__replay.sent.push(data);
    // keepalive ping 必须有 pong,否则 10s 后 socket 自判死链主动重连,给用例引入噪声。
    let parsed: { type?: string; id?: number } | null = null;
    try {
      parsed = JSON.parse(data) as { type?: string; id?: number };
    } catch {
      parsed = null;
    }
    if (parsed?.type === "ping") {
      setTimeout(() => this.deliver({ type: "pong", id: parsed?.id }), 0);
    }
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  /** 把一帧 server → client 的 wire 帧交给真实 onmessage handler。 */
  deliver(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

const replaySocket = new ChatSocket({
  getToken: () => "harness-replay-token",
  getAuthEpoch: () => 0,
  silentRefresh: async (epoch) => ({ kind: "transient", epoch, retryAfterMs: 1000 }),
  onAuthExpired: () => {},
  defaultAgentId: REPLAY_AGENT_ID,
});
replaySocket.ensureSession(REPLAY_SESSION_ID, REPLAY_AGENT_ID, "replay 会话");

function ReplayTimelineProbe() {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const snap = useSyncExternalStore(replaySocket.subscribe, replaySocket.getSnapshot);
  void snap.version;
  const messages = snap.sessions.get(REPLAY_SESSION_ID)?.messages ?? [];
  const sending = replaySocket.isSessionBusy(REPLAY_SESSION_ID);
  window.__replay.sending = sending;
  window.__replay.rows = messages.map((m) => ({ role: m.role, id: m.id }));
  return (
    <div
      ref={setScroller}
      className="chat-scroll-area timeline-scroll-probe"
      data-testid="replay-timeline-probe"
      tabIndex={0}
    >
      <MessageList
        messages={messages}
        sending={sending}
        cb={{}}
        onRespondPermission={() => {}}
        scrollParent={scroller}
        historyGeneration={`replay::${REPLAY_SESSION_ID}`}
      />
    </div>
  );
}

createRoot(document.getElementById("timeline-replay-root")!).render(
  <StrictMode><ReplayTimelineProbe /></StrictMode>,
);

{
  let pushed = 0;
  let frames: ReturnType<typeof replayTurnFrames> = [];
  const live = (): HarnessWebSocket => {
    const ws = HarnessWebSocket.latest;
    if (!ws || ws.readyState !== 1) throw new Error("replay 传输未就绪");
    return ws;
  };
  window.__replayDrive = {
    openTurn: async () => {
      const original = window.WebSocket;
      (window as unknown as { WebSocket: unknown }).WebSocket = HarnessWebSocket;
      try {
        replaySocket.setGateReady(true);
        replaySocket.start();
        // 等真实握手完成(onopen → hello 已发)。
        for (let i = 0; i < 100 && HarnessWebSocket.latest?.readyState !== 1; i++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } finally {
        (window as unknown as { WebSocket: unknown }).WebSocket = original;
      }
      const ws = live();
      // relay 就绪是投递前置:没有它,消息只会停在离线队列里。
      ws.deliver(relayReadyFrame);
      replaySocket.sendMessage({
        sessId: REPLAY_SESSION_ID,
        agentId: REPLAY_AGENT_ID,
        text: REPLAY_MARKERS.userText,
        model: "glm-5.2",
      });
      // 从**真实发出的帧**里取 clientMessageId,而不是回读内部状态:证明发送侧也走通了。
      let cmid: string | undefined;
      for (let i = 0; i < 100 && !cmid; i++) {
        for (const raw of window.__replay.sent) {
          try {
            const frame = JSON.parse(raw) as { type?: string; clientMessageId?: string };
            if (frame.type === "inbound.message" && frame.clientMessageId) {
              cmid = frame.clientMessageId;
            }
          } catch {
            /* 非 JSON 帧忽略 */
          }
        }
        if (!cmid) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (!cmid) throw new Error("真实发送未产生 inbound.message 帧");
      ws.deliver(admittedAckFrame(cmid));
      frames = replayTurnFrames(cmid);
      pushed = 0;
      return cmid;
    },
    pushNextFrame: () => {
      if (pushed >= frames.length) throw new Error("replay 帧已推完");
      live().deliver(frames[pushed]);
      pushed += 1;
      return pushed;
    },
    pushRemainingFrames: () => {
      const ws = live();
      while (pushed < frames.length) {
        ws.deliver(frames[pushed]);
        pushed += 1;
      }
      return pushed;
    },
    frameCount: () => frames.length,
  };
}

// ── T23 会话内切模型(唯一入口)──────────────────────────────────────────────
//
// ModelSelector 是会话内换模型的唯一入口,候选项是 Radix DropdownMenuItem —— 而
// 2026-07-18 附件事故的根因类别正是"菜单项在受信点击派发过程中被同步卸载,杀死
// post-dispatch 副作用",对**任何** DropdownMenuItem 内的副作用都成立。jsdom 的
// fireEvent 不走 Radix 的 pointerdown→pointerup→select 真实序列,这一类物理上测不出。
//
// 这里 mount 的是生产组件本体;onSelect 回填 selectedId 与线上 App 的 selectModel
// 同构(用户可见事实 = 点完之后顶栏显示的就是新模型)。
const MODEL_MARKERS = {
  current: "MODEL_CURRENT_ALPHA",
  target: "MODEL_TARGET_BETA",
  degraded: "MODEL_DEGRADED_GAMMA",
} as const;
const MODEL_IDS = { current: "m-alpha", target: "m-beta", degraded: "m-gamma" } as const;
window.__modelFixture = { markers: { ...MODEL_MARKERS }, ids: { ...MODEL_IDS } };

function ModelSelectorProbe() {
  const [selectedId, setSelectedId] = useState<string>(MODEL_IDS.current);
  return (
    <ModelSelector
      models={[
        { id: MODEL_IDS.current, display_name: MODEL_MARKERS.current },
        { id: MODEL_IDS.target, display_name: MODEL_MARKERS.target },
        { id: MODEL_IDS.degraded, display_name: MODEL_MARKERS.degraded, degraded: true },
      ]}
      selectedId={selectedId}
      onSelect={(id) => {
        window.__modelPicks.push(id);
        setSelectedId(id);
      }}
    />
  );
}

createRoot(document.getElementById("model-selector-root")!).render(
  <StrictMode><ModelSelectorProbe /></StrictMode>,
);
