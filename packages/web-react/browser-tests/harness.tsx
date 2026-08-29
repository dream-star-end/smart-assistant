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
import { SettingsCenter } from "../src/components/SettingsCenter";
import { Sidebar } from "../src/components/Sidebar";
import { BoundRepoCard } from "../src/components/contextRail/BoundRepoCard";
import { ContextRail } from "../src/components/contextRail/ContextRail";
import { RepoPill } from "../src/components/github/RepoPill";
import { PinnedTaskTracker } from "../src/components/chat/PinnedTaskTracker";
import { useContextRailHidden } from "../src/hooks/useContextRailHidden";
import { useXlViewport } from "../src/hooks/useXlViewport";
import type { RepoSelection } from "../src/lib/types";
import { CommunityTutorials } from "../src/components/tutorials/CommunityTutorials";
import { MessageFeedbackDialog } from "../src/components/chat/MessageFeedbackDialog";
import { TurnCostReminder } from "../src/components/chat/TurnCostReminder";
import { MemoryPanel } from "../src/components/manage/MemoryPanel";
import { MediaTaskCenter } from "../src/components/MediaTaskCenter";
import { Markdown } from "../src/components/Markdown";
import { MessageList, MessageRenderer } from "../src/components/MessageRenderer";
import { ModelSelector } from "../src/components/ModelSelector";
import { ToolCard } from "../src/components/ToolCard";
import { TeamPanel } from "../src/components/chat/TeamPanel";
import { ConnectorsTab } from "../src/components/settings/ConnectorsTab";
import { ToastProvider, TooltipProvider } from "../src/components/ui";
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
import type { User } from "../src/lib/types";
import type { MediaGenerationJob } from "@openclaude/protocol/mediaGeneration";
import { createMemoryAuthSession } from "../src/lib/authSession";
import { ChatSocket } from "../src/lib/chat/socket";
import { useSessionList } from "../src/hooks/useSessionList";
import type { UseChatSocket } from "../src/hooks/useChatSocket";
import {
  admittedAckFrame,
  EXPECTED_TIMELINE_ROLES,
  relayReadyFrame,
  REPLAY_AGENT_ID,
  REPLAY_MARKERS,
  REPLAY_SESSION_ID,
  legacyRetryStatusFrame,
  replayTurnFrames,
} from "./fixtures/turnReplay";

declare global {
  interface Window {
    __sends: Array<{ text: string; mediaCount: number }>;
    __uploads: string[];
    __composerStops: number;
    __setComposerState: (busy: boolean, stopping: boolean) => void;
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
    __errorUxRetries: number;
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
      /** Push the real retry-status frame for the current in-flight turn. */
      pushRetryStatus: () => void;
      /** Complete the same turn with a live text block plus final terminator. */
      pushRetrySuccess: () => void;
      /** Reproduce page1 → WS N → page2(N) during durable journal hydration. */
      runDurableOverlap: () => Promise<{
        markers: { thinking: string; toolCommand: string; toolOutput: string; answer: string };
        thinkingCount: number;
        toolCount: number;
        answerCount: number;
        cursor: number;
        requests: string[];
      }>;
      /** Replay a cold refresh spanning two container frameSeq generations. */
      runDurableGenerationReset: () => Promise<{
        markers: { oldProcess: string; currentProcess: string; currentAnswer: string };
        oldProcessCount: number;
        currentProcessCount: number;
        currentAnswerCount: number;
        cursor: number;
        requests: string[];
      }>;
      /** Replay the two production error shapes through durable hydration. */
      runDurableErrorReplay: () => Promise<{
        stopErrorCode?: string;
        stopErrorText?: string;
        stopReports: number;
        stopSyncs: number;
        stopStatusCount: number;
        stopAlertCount: number;
        stopRetryCount: number;
        stopCancelledCopyCount: number;
        historicalReports: number;
        historicalSyncs: number;
        historicalDecision: boolean;
      }>;
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
    __pushMediaJob: (job: MediaGenerationJob) => void;
    __openMediaTask: (open: boolean) => void;
  }
}
window.__sends = [];
window.__uploads = [];
window.__composerStops = 0;
window.__setComposerState = () => {};
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
window.__errorUxRetries = 0;
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
  pushRetryStatus: () => {},
  pushRetrySuccess: () => {},
  runDurableOverlap: async () => {
    throw new Error("durable overlap probe 未挂载");
  },
  runDurableGenerationReset: async () => {
    throw new Error("durable generation-reset probe 未挂载");
  },
  runDurableErrorReplay: async () => {
    throw new Error("durable error replay probe 未挂载");
  },
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

const mediaTaskAuth = createMemoryAuthSession(() => {}, "browser-media-token");
const connectorsAuth = createMemoryAuthSession(() => {}, "browser-connectors-token");
const memoryAuth = createMemoryAuthSession(() => {}, "browser-memory-token");
const communityTutorialAuth = createMemoryAuthSession(() => {}, "browser-community-token");

createRoot(document.getElementById("community-tutorial-root")!).render(
  <StrictMode>
    <TooltipProvider>
      <ToastProvider>
        <CommunityTutorials auth={communityTutorialAuth} />
      </ToastProvider>
    </TooltipProvider>
  </StrictMode>,
);

createRoot(document.getElementById("memory-report-root")!).render(
  <StrictMode>
    <TooltipProvider>
      <ToastProvider>
        <MemoryPanel
          auth={memoryAuth}
          agentId="main"
          agents={[{ id: "main", name: "全能助手" }]}
        />
      </ToastProvider>
    </TooltipProvider>
  </StrictMode>,
);

createRoot(document.getElementById("connectors-root")!).render(
  <StrictMode><ConnectorsTab auth={connectorsAuth} /></StrictMode>,
);

function MediaTaskProbe() {
  const [liveJob, setLiveJob] = useState<MediaGenerationJob | null>(null);
  const [open, setOpen] = useState(false);
  window.__pushMediaJob = setLiveJob;
  window.__openMediaTask = setOpen;
  return (
    <MediaTaskCenter
      open={open}
      auth={mediaTaskAuth}
      liveJob={liveJob}
      onOpenChange={setOpen}
    />
  );
}

createRoot(document.getElementById("media-task-root")!).render(
  <StrictMode><MediaTaskProbe /></StrictMode>,
);

const uploadStub = async (file: File): Promise<MediaRef> => {
  window.__uploads.push(file.name);
  return { kind: "file", url: "https://stub.invalid/browser-test", filename: file.name };
};

function ComposerProbe() {
  const [state, setState] = useState({ busy: false, stopping: false });
  window.__setComposerState = (busy, stopping) => setState({ busy, stopping });
  return (
    <>
      {state.busy && <TurnCostReminder credits="731" />}
      <Composer
        onSend={(text, media) => {
          window.__sends.push({ text, mediaCount: media?.length ?? 0 });
        }}
        busy={state.busy}
        stopping={state.stopping}
        onStop={() => { window.__composerStops += 1; }}
        onUpload={uploadStub}
        onSetGoal={async () => {}}
        onGoalAction={async () => {}}
      />
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><ComposerProbe /></StrictMode>,
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

const errorUxUser: ChatMessage = {
  id: "browser-error-ux-user",
  role: "user",
  text: "你是什么模型",
  ts: 1,
  status: "error",
};
const errorUxAssistant: ChatMessage = {
  id: "browser-error-ux-assistant",
  role: "assistant",
  text: "",
  ts: 2,
  _errorCode: "codex_route_unavailable",
  _clientMessageId: errorUxUser.id,
};

createRoot(document.getElementById("error-ux-root")!).render(
  <StrictMode>
    <MessageList
      messages={[errorUxUser, errorUxAssistant]}
      sending={false}
      cb={{
        onRetrySend: () => { window.__errorUxRetries += 1; },
        resolveRetryTarget: (id) => id === errorUxUser.id ? errorUxUser : undefined,
      }}
      onRespondPermission={() => {}}
    />
  </StrictMode>,
);

const activeAskQuestion: ChatMessage = {
  id: "active-ask-question",
  role: "permission",
  text: "AskUserQuestion",
  // 待审批 permission 卡的自动弹框有存活上界(PermissionCard 的 PENDING_PERMISSION_TTL_MS:
  // 超过服务端 TTL 的未决卡按孤儿处理、不再自动弹),故这里必须给新鲜时间戳,
  // 否则测的就不是「活动 turn 中的待答问答」这个真实场景。
  ts: Date.now(),
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

createRoot(document.getElementById("interrupted-tool-status-root")!).render(
  <StrictMode>
    <div>
      <div id="interrupted-historical-tool">
        <ToolCard
          message={{
            toolName: "Agent",
            inputJson: { description: "中断的历史子任务" },
            _completed: false,
            _timelineRecord: true,
            _dispatchOutcome: "interrupted",
          }}
        />
      </div>
      <div id="live-incomplete-tool">
        <ToolCard
          message={{ toolName: "Agent", inputJson: { description: "仍在执行的实时子任务" }, _completed: false }}
        />
      </div>
      <div id="completed-interrupted-tool">
        <ToolCard
          message={{
            toolName: "Agent",
            inputJson: { description: "中断前已完成的子任务" },
            _completed: true,
            _timelineRecord: true,
            _dispatchOutcome: "interrupted",
          }}
        />
      </div>
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

let replayReportedErrors = 0;
let replaySyncCalls = 0;
const replaySocket = new ChatSocket({
  getToken: () => "harness-replay-token",
  getAuthEpoch: () => 0,
  silentRefresh: async (epoch) => ({ kind: "transient", epoch, retryAfterMs: 1000 }),
  onAuthExpired: () => {},
  defaultAgentId: REPLAY_AGENT_ID,
  reportClientError: () => { replayReportedErrors += 1; },
  syncSession: () => { replaySyncCalls += 1; },
});
replaySocket.ensureSession(REPLAY_SESSION_ID, REPLAY_AGENT_ID, "replay 会话");

function ReplayTimelineProbe() {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const snap = useSyncExternalStore(replaySocket.subscribe, replaySocket.getSnapshot);
  void snap.version;
  const session = snap.sessions.get(REPLAY_SESSION_ID);
  const messages = session?.messages ?? [];
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
        turnActivity={sending ? {
          startedAt: session?._turnStartedAt ?? null,
          lastFrameAt: session?._lastFrameAt,
          turnStatus: session?._turnStatus ?? null,
          agentName: "助手",
        } : null}
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

const chatEntryUxAuth = createMemoryAuthSession(() => {}, "browser-chat-entry-ux-token");
const chatEntryUxUser: User = {
  id: "browser-chat-entry-user",
  displayName: "Browser User",
  roles: ["user"],
};

function ChatEntryUxProbe() {
  const socketRef = useRef<UseChatSocket | null>(null);
  const { sessions, activeId, newSession, onHydrated } = useSessionList({
    demo: false,
    auth: null,
    authSession: chatEntryUxAuth,
    user: chatEntryUxUser,
    agentId: "main",
    sockRef: socketRef,
    confirmDialog: async () => true,
    promptText: async () => null,
    clearChatError: () => {},
    onNewSessionReset: () => {},
    onActiveSessionDeleted: () => {},
  });
  useLayoutEffect(() => {
    onHydrated([{
      id: "browser-existing-session",
      agentId: "main",
      title: "已有会话",
      messages: [],
      createdAt: 1,
      lastAt: 1,
    }]);
  }, [onHydrated]);

  return (
    <div>
      <section data-testid="new-session-probe">
        <button type="button" onClick={newSession}>新建会话测试</button>
        <span data-testid="new-session-active-state">{activeId ?? "blank"}</span>
        <div data-testid="new-session-count">{sessions.length}</div>
        {sessions.map((session) => (
          <div key={session.id} data-testid="new-session-row">{session.title}</div>
        ))}
      </section>
      <section data-testid="partial-history-probe">
        <MessageList
          messages={[{
            id: "partial-history-visible",
            role: "user",
            text: "PARTIAL_HISTORY_VISIBLE_MESSAGE",
            ts: 1,
            status: "sent",
          }]}
          sending={false}
          historyLoading
          cb={{}}
          onRespondPermission={() => {}}
        />
      </section>
    </div>
  );
}

createRoot(document.getElementById("chat-entry-ux-root")!).render(
  <StrictMode><ChatEntryUxProbe /></StrictMode>,
);

{
  let pushed = 0;
  let frames: ReturnType<typeof replayTurnFrames> = [];
  let activeClientMessageId: string | undefined;
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
      const sentBefore = window.__replay.sent.length;
      replaySocket.sendMessage({
        sessId: REPLAY_SESSION_ID,
        agentId: REPLAY_AGENT_ID,
        text: REPLAY_MARKERS.userText,
        model: "glm-5.2",
      });
      // 从**真实发出的帧**里取 clientMessageId,而不是回读内部状态:证明发送侧也走通了。
      let cmid: string | undefined;
      for (let i = 0; i < 100 && !cmid; i++) {
        for (const raw of window.__replay.sent.slice(sentBefore)) {
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
      activeClientMessageId = cmid;
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
    pushRetryStatus: () => {
      const session = replaySocket.sessions.get(REPLAY_SESSION_ID);
      if (!session || !session._sendingInFlight) {
        throw new Error("retry status 注入前没有真实在途 turn");
      }
      // 真 wire → HarnessWebSocket → ChatSocket.dispatch → reducer → MessageList footer。
      live().deliver(legacyRetryStatusFrame(Date.now() + 1_000));
    },
    pushRetrySuccess: () => {
      if (!activeClientMessageId) throw new Error("retry success 注入前缺 clientMessageId");
      const base = {
        type: "outbound.message",
        sessionKey: `agent:${REPLAY_AGENT_ID}:webchat:dm:${REPLAY_SESSION_ID}`,
        channel: "webchat",
        peer: { id: REPLAY_SESSION_ID, kind: "dm" },
        clientMessageId: activeClientMessageId,
      };
      live().deliver({
        ...base,
        frameSeq: 7,
        blocks: [{
          kind: "text",
          text: REPLAY_MARKERS.retrySuccess,
          messageId: "srv-browser-retry-success",
        }],
        isFinal: false,
      });
      live().deliver({ ...base, frameSeq: 8, blocks: [], isFinal: true });
    },
    runDurableOverlap: async () => {
      replaySocket.removeSession(REPLAY_SESSION_ID);
      const session = replaySocket.ensureSession(REPLAY_SESSION_ID, REPLAY_AGENT_ID, "durable overlap");
      const clientMessageId = "m-browser-durable-overlap";
      const sessionKey = `agent:${REPLAY_AGENT_ID}:webchat:dm:${REPLAY_SESSION_ID}`;
      const markers = {
        thinking: "BROWSER_DURABLE_THOUGHT_ONCE",
        toolCommand: "printf BROWSER_DURABLE_TOOL_ONCE",
        toolOutput: "BROWSER_DURABLE_OUTPUT_ONCE",
        answer: "BROWSER_DURABLE_ANSWER_ONCE",
      };
      session.messages.push({
        id: clientMessageId,
        role: "user",
        text: "BROWSER_DURABLE_USER",
        ts: 1,
        status: "sent",
      });
      session._lastFrameSeqByKey = { [sessionKey]: 99 };
      session._lastFrameSeq = 99;
      const payload = (frameSeq: number, blocks: unknown[]) => ({
        type: "outbound.message",
        sessionKey,
        frameSeq,
        channel: "webchat",
        peer: { id: REPLAY_SESSION_ID, kind: "dm" },
        clientMessageId,
        blocks,
        isFinal: false,
        ts: frameSeq + 10,
      });
      const record = (recordId: string, frameSeq: number, blocks: unknown[]) => ({
        recordId,
        streamKey: "dispatch:33333333-3333-4333-8333-333333333333:1",
        source: "gateway" as const,
        clientMessageId,
        payload: payload(frameSeq, blocks),
      });
      const overlapBlocks = [
        { kind: "thinking", text: markers.thinking },
        {
          kind: "tool_use",
          blockId: "browser-durable-call",
          toolName: "exec_command",
          inputJson: { cmd: markers.toolCommand },
          partial: false,
        },
        {
          kind: "tool_result",
          blockId: "browser-durable-result",
          toolUseBlockId: "browser-durable-call",
          toolName: "exec_command",
          isError: false,
          output: markers.toolOutput,
        },
        { kind: "text", text: markers.answer },
      ];
      const requests: string[] = [];
      const page1 = record("1", 1, [{ kind: "thinking", text: "BROWSER_DURABLE_PAGE1" }]);
      const page2 = record("2", 2, overlapBlocks);
      await replaySocket.hydrateDurableLiveFrameJournal(
        REPLAY_SESSION_ID,
        async (after) => {
          requests.push(after);
          if (after === "0") {
            // This live frame is persisted between journal pages and overlaps page2.
            live().deliver(payload(2, overlapBlocks));
            return {
              frames: [page1], nextCursor: "1", hasMore: true,
              streamClientMessageIds: [clientMessageId], hasTapeProjection: false,
            };
          }
          if (after === "1") {
            return {
              frames: [page2], nextCursor: "2", hasMore: false,
              streamClientMessageIds: [clientMessageId], hasTapeProjection: false,
            };
          }
          return {
            frames: [], nextCursor: null, hasMore: false,
            streamClientMessageIds: [clientMessageId], hasTapeProjection: false,
          };
        },
        async () => {},
      );
      // A later reconcile must start at the shared record cursor and preserve
      // every already-visible process row instead of replaying from zero.
      await replaySocket.hydrateDurableLiveFrameJournal(
        REPLAY_SESSION_ID,
        async (after) => {
          requests.push(after);
          return {
            frames: [], nextCursor: null, hasMore: false,
            streamClientMessageIds: [clientMessageId], hasTapeProjection: false,
          };
        },
        async () => {},
      );
      return {
        markers,
        thinkingCount: session.messages
          .filter((m) => m.role === "thinking")
          .reduce((count, m) => count + (m.text.split(markers.thinking).length - 1), 0),
        toolCount: session.messages.filter((m) =>
          m.role === "tool" && m.output === markers.toolOutput).length,
        answerCount: session.messages.filter((m) =>
          m.role === "assistant" && m.text === markers.answer).length,
        cursor: session._lastFrameSeqByKey?.[sessionKey] ?? -1,
        requests,
      };
    },
    runDurableGenerationReset: async () => {
      replaySocket.removeSession(REPLAY_SESSION_ID);
      const session = replaySocket.ensureSession(
        REPLAY_SESSION_ID,
        REPLAY_AGENT_ID,
        "durable container generations",
      );
      const oldClientMessageId = "m-browser-old-container";
      const currentClientMessageId = "m-browser-current-container";
      const sessionKey = `agent:${REPLAY_AGENT_ID}:webchat:dm:${REPLAY_SESSION_ID}`;
      const markers = {
        oldProcess: "BROWSER_OLD_CONTAINER_PROCESS",
        currentProcess: "BROWSER_CURRENT_CONTAINER_PROCESS",
        currentAnswer: "BROWSER_CURRENT_CONTAINER_ANSWER",
      };
      session.messages.push(
        {
          id: oldClientMessageId,
          role: "user",
          text: "BROWSER_OLD_CONTAINER_USER",
          ts: 1,
          status: "sent",
        },
        {
          id: "browser-old-durable-process",
          role: "thinking",
          text: markers.oldProcess,
          ts: 1_000,
          _source: "server",
          _turnOwnerId: oldClientMessageId,
        },
        {
          id: currentClientMessageId,
          role: "user",
          text: "BROWSER_CURRENT_CONTAINER_USER",
          ts: 2,
          status: "sent",
        },
      );
      // IndexedDB persisted this cursor before the running turn moved to a
      // replacement container whose outbound ring starts again at one.
      session._lastFrameSeqByKey = { [sessionKey]: 1_914 };
      session._lastFrameSeq = 1_914;
      session._sendingInFlight = true;
      session._activeClientMessageId = currentClientMessageId;
      const record = (
        recordId: string,
        streamKey: string,
        clientMessageId: string,
        frameSeq: number,
        blocks: unknown[],
        isFinal = false,
      ) => ({
        recordId,
        streamKey,
        source: "gateway" as const,
        clientMessageId,
        payload: {
          type: "outbound.message",
          sessionKey,
          frameSeq,
          channel: "webchat",
          peer: { id: REPLAY_SESSION_ID, kind: "dm" },
          clientMessageId,
          blocks,
          isFinal,
          ts: Number(recordId) * 1_000,
        },
      });
      const oldStream = "dispatch:77777777-7777-4777-8777-777777777777:1";
      const currentStream = "dispatch:88888888-8888-4888-8888-888888888888:1";
      const requests: string[] = [];
      await replaySocket.hydrateDurableLiveFrameJournal(
        REPLAY_SESSION_ID,
        async (after) => {
          requests.push(after);
          if (after === "0") {
            return {
              frames: [
                record("1", oldStream, oldClientMessageId, 998, [{
                  kind: "thinking", text: markers.oldProcess,
                }]),
                record("2", oldStream, oldClientMessageId, 1_914, [], true),
                record("3", currentStream, currentClientMessageId, 1, [{
                  kind: "thinking", text: markers.currentProcess,
                }]),
                record("4", currentStream, currentClientMessageId, 2, [{
                  kind: "text", text: markers.currentAnswer,
                }]),
              ],
              nextCursor: "4",
              hasMore: false,
              streamClientMessageIds: [oldClientMessageId, currentClientMessageId],
              hasTapeProjection: false,
            };
          }
          return {
            frames: [], nextCursor: null, hasMore: false,
            streamClientMessageIds: [oldClientMessageId, currentClientMessageId],
            hasTapeProjection: false,
          };
        },
        async () => {},
      );
      return {
        markers,
        oldProcessCount: session.messages.filter((message) =>
          message.role === "thinking" && message.text === markers.oldProcess
        ).length,
        currentProcessCount: session.messages.filter((message) =>
          message.role === "thinking" && message.text === markers.currentProcess
        ).length,
        currentAnswerCount: session.messages.filter((message) =>
          message.role === "assistant" && message.text === markers.currentAnswer
        ).length,
        cursor: session._lastFrameSeqByKey?.[sessionKey] ?? -1,
        requests,
      };
    },
    runDurableErrorReplay: async () => {
      const sessionKey = `agent:${REPLAY_AGENT_ID}:webchat:dm:${REPLAY_SESSION_ID}`;
      const record = (
        recordId: string,
        clientMessageId: string,
        detail: string,
      ) => ({
        recordId,
        streamKey: "dispatch:44444444-4444-4444-8444-444444444444:1",
        source: "gateway" as const,
        clientMessageId,
        payload: {
          type: "outbound.error",
          sessionKey,
          frameSeq: 1,
          channel: "webchat",
          peer: { id: REPLAY_SESSION_ID, kind: "dm" },
          clientMessageId,
          code: "upstream_failed",
          message: "任务执行暂时中断，请直接重试本条消息",
          detail,
          isFinal: false,
          ts: 2,
        },
      });
      const seed = (clientMessageId: string) => {
        replaySocket.removeSession(REPLAY_SESSION_ID);
        const session = replaySocket.ensureSession(REPLAY_SESSION_ID, REPLAY_AGENT_ID, "durable error");
        session.messages.push(
          {
            id: clientMessageId,
            role: "user",
            text: "old task",
            ts: 1,
            status: "error",
            _source: "server",
            _routing: { model: "glm-5.2", teamMode: false, effortLevel: null },
          },
          {
            id: `${clientMessageId}-newer`,
            role: "user",
            text: "new task",
            ts: 3,
            status: "sent",
            _source: "server",
          },
        );
        session._lastFrameSeqByKey = { [sessionKey]: 99 };
        session._lastFrameSeq = 99;
        return session;
      };

      replayReportedErrors = 0;
      replaySyncCalls = 0;
      const stoppedId = "m-browser-durable-stop";
      const stopped = seed(stoppedId);
      replaySocket.applyDurableLiveFrames(
        REPLAY_SESSION_ID,
        [record("stop", stoppedId, "本轮已由用户停止。")],
        [stoppedId],
      );
      for (let i = 0; i < 100; i++) {
        if (document.querySelector('#timeline-replay-root output[aria-label="已停止生成"]')) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const stoppedError = [...stopped.messages].reverse().find((message) => message.role === "assistant");
      const stopReports = replayReportedErrors;
      const stopSyncs = replaySyncCalls;
      const stopRoot = document.querySelector("#timeline-replay-root");
      const stopStatusCount = stopRoot?.querySelectorAll('output[aria-label="已停止生成"]').length ?? 0;
      const stopAlertCount = stopRoot?.querySelectorAll('[role="alert"]').length ?? 0;
      const stopRetryCount = [...(stopRoot?.querySelectorAll("button") ?? [])]
        .filter((button) => /重试|重新尝试/.test(button.textContent ?? "")).length;
      const stopCancelledCopyCount = (stopRoot?.textContent?.match(/本轮已取消。/g) ?? []).length;

      replayReportedErrors = 0;
      replaySyncCalls = 0;
      const historicalId = "m-browser-durable-historical";
      const historical = seed(historicalId);
      replaySocket.applyDurableLiveFrames(
        REPLAY_SESSION_ID,
        [record("historical", historicalId, "raw provider detail")],
        [historicalId],
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      return {
        stopErrorCode: stoppedError?._errorCode,
        stopErrorText: stoppedError?.text,
        stopReports,
        stopSyncs,
        stopStatusCount,
        stopAlertCount,
        stopRetryCount,
        stopCancelledCopyCount,
        historicalReports: replayReportedErrors,
        historicalSyncs: replaySyncCalls,
        historicalDecision: historical._automaticRecoveryDecisions?.[historicalId] === true,
      };
    },
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

// ── T24 markdown 富块(mermaid)────────────────────────────────────────────────
//
// 助手回复 99% 经 markdown,而 MarkdownImpl 里 ```mermaid 走的是完全独立的分支
// (dynamic import → parse → render → dangerouslySetInnerHTML)。它此前**零测试**:
// jsdom 没有 SVG 布局,mermaid 在那里既画不出图也量不了,只能在真浏览器里证明。
// 两个用户可见事实:①语法有效 → 真出图;②流式半截/语法错 → 回退可读源码,
// 既不白屏、也不留"渲染中"占位、更不把 mermaid 的错误图注入 <body>。
const MERMAID_OK = ["```mermaid", "graph TD; MERMAIDOKSTART-->MERMAIDOKEND;", "```"].join("\n");
const MERMAID_BROKEN = ["```mermaid", "MERMAIDBROKENSOURCE {{{ not a diagram", "```"].join("\n");

createRoot(document.getElementById("markdown-rich-root")!).render(
  <StrictMode>
    <div data-testid="mermaid-ok"><Markdown>{MERMAID_OK}</Markdown></div>
    <div data-testid="mermaid-broken"><Markdown>{MERMAID_BROKEN}</Markdown></div>
  </StrictMode>,
);

// PR1 Codex 密度门：真实 Sidebar（活跃竖条 / 顶栏入口权重），与 #root Composer、
// #tool-card-polish-root ToolCard 一起由 T41 在 1440/390 明暗主题下锁 class 契约。
const DENSITY_USER: User = {
  id: "density-user",
  displayName: "密度验收",
  roles: ["user"],
  role: "admin",
};
createRoot(document.getElementById("codex-density-root")!).render(
  <StrictMode>
    <div style={{ height: 640 }}>
      <Sidebar
        sessions={[
          {
            id: "density-active",
            title: "密度验收活跃会话",
            ownerUserId: DENSITY_USER.id,
            updatedAt: new Date().toISOString(),
            messageCount: 3,
          },
          {
            id: "density-idle",
            title: "密度验收空闲会话",
            ownerUserId: DENSITY_USER.id,
            updatedAt: new Date().toISOString(),
            messageCount: 1,
          },
        ]}
        activeId="density-active"
        user={DENSITY_USER}
        onSelect={() => {}}
        onNew={() => {}}
        onRename={() => {}}
        onDelete={() => {}}
        onOpenManage={() => {}}
        onOpenMarketplace={() => {}}
        onOpenTutorial={() => {}}
        onOpenOrg={() => {}}
        showAdmin
      />
    </div>
  </StrictMode>,
);

// PR2 设置壳：默认关闭，避免 Dialog 盖住其余 harness。T42 用受信点击打开后
// 锁 390 单列不横溢 / 五分区可切 / 1440 竖导航 168px。
function SettingsShellProbe() {
  const [open, setOpen] = useState(false);
  return (
    <TooltipProvider>
      <button type="button" onClick={() => setOpen(true)}>
        打开设置壳
      </button>
      <SettingsCenter
        open={open}
        auth={createMemoryAuthSession(() => {}, "settings-shell-token")}
        user={DENSITY_USER}
        theme="light"
        onClose={() => setOpen(false)}
        onSetTheme={() => {}}
        onOpenMemory={() => {}}
        onOpenManage={() => {}}
        onOpenRepo={() => {}}
        initialSection="about"
      />
    </TooltipProvider>
  );
}
createRoot(document.getElementById("settings-shell-root")!).render(
  <StrictMode>
    <SettingsShellProbe />
  </StrictMode>,
);

const RAIL_SELECTION: Extract<RepoSelection, { selected: true }> = {
  selected: true,
  owner: "acme",
  repo: "aurora",
  branch: "feat/rail",
  status: "ready",
  head_sha: "abcdef1234567890",
  selection_version: 1,
};
const RAIL_TODOS = [{ content: "修右栏单实例", status: "in_progress", activeForm: "正在修右栏" }];

/** PR3 右栏：默认挂着即可。T43 用视口切换证明 390 回中栏、1440 单实例、隐藏接回、无数据不占宽。 */
function ContextRailDataProbe() {
  const isXl = useXlViewport();
  const [railHidden, setRailHidden] = useContextRailHidden();
  const showRail = isXl && !railHidden;
  return (
    <div data-testid="context-rail-data-shell" className="flex h-[420px] w-full overflow-x-hidden bg-bg text-fg">
      <main data-testid="center-column" className="flex min-w-0 flex-1 flex-col gap-2 p-3">
        {isXl && railHidden && (
          <button type="button" onClick={() => setRailHidden(false)}>
            显示上下文
          </button>
        )}
        {!showRail && <RepoPill selection={RAIL_SELECTION} onClick={() => {}} />}
        {!showRail && <PinnedTaskTracker todos={RAIL_TODOS} active />}
        <p>中栏对照正文 https://example.com/very/long/path/for/overflow-check</p>
      </main>
      {showRail && (
        <ContextRail
          renderers={{
            "bound-repo": <BoundRepoCard selection={RAIL_SELECTION} onOpenRepo={() => {}} />,
            "pinned-tasks": <PinnedTaskTracker todos={RAIL_TODOS} active compact />,
          }}
          onHide={() => setRailHidden(true)}
        />
      )}
    </div>
  );
}

function ContextRailUnboundProbe() {
  const isXl = useXlViewport();
  return (
    <div data-testid="context-rail-unbound-shell" className="flex h-[200px] w-full overflow-x-hidden bg-bg text-fg">
      <main data-testid="unbound-center" className="flex min-w-0 flex-1 flex-col gap-2 p-3">
        <RepoPill selection={{ selected: false }} onClick={() => {}} />
        {isXl ? null : <PinnedTaskTracker todos={RAIL_TODOS} active />}
      </main>
      {isXl && (
        <ContextRail
          renderers={{
            "bound-repo": null,
            "pinned-tasks": <PinnedTaskTracker todos={RAIL_TODOS} active compact />,
          }}
          onHide={() => {}}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById("context-rail-root")!).render(
  <StrictMode>
    <TooltipProvider>
      <ContextRailDataProbe />
      <div data-testid="context-rail-empty-shell">
        <ContextRail renderers={{ "bound-repo": null, "pinned-tasks": null }} onHide={() => {}} />
      </div>
      <ContextRailUnboundProbe />
    </TooltipProvider>
  </StrictMode>,
);

