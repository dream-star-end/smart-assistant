// browser-tests 挂载壳:在真浏览器里 mount **真实 Composer**(非复刻结构),
// 由 run.mjs 用受信点击驱动断言。背景(2026-07-18 附件事故):jsdom 的 label
// 激活查找走 ownerDocument 而非 tree scope、fireEvent 非受信不触发同步 flush,
// "点击→选择器弹出"这类交互契约在 jsdom 里物理上测不出真实结果,必须真浏览器。
//
// stub 原则:只 stub 网络/宿主副作用(上传/发送/目标提交),不 stub 任何 UI 结构;
// onUpload 立即 resolve → 附件 chip 无后端也能走到 done 态,CI 零外部依赖。
import { StrictMode, useCallback, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Composer } from "../src/components/Composer";
import { MessageFeedbackDialog } from "../src/components/chat/MessageFeedbackDialog";
import { MessageList, MessageRenderer } from "../src/components/MessageRenderer";
import { ToolCard } from "../src/components/ToolCard";
import { TeamPanel } from "../src/components/chat/TeamPanel";
import {
  captureVisibleVirtualRowAnchor,
  restoreVisibleVirtualRowAnchor,
} from "../src/components/chat/archivePaging";
import { mergeTimelineHistoryPage } from "../src/lib/persist";
import type { ChatMessage } from "../src/lib/chat/model";
import type { MediaRef } from "../src/lib/chat/frames";
import { createMemoryAuthSession } from "../src/lib/authSession";

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
