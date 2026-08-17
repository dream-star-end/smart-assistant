/**
 * P5 会话渲染入口。
 *
 * MessageRenderer：按 role 分派单条 ChatMessage 到对应 Aurora 卡（tool 委托 ToolCardSlot）。
 * 经 messageSignature 做 memo —— reducer 就地 mutation（同对象引用）下，React.memo 浅比较
 * 会漏渲，故以「内容签名」为比较键：变才渲、不变则稳定（复刻现网 keyed-reconcile 防闪）。
 *
 * MessageList：把会话消息流渲成虚拟卡片列表 + 流式 typing 指示 + 向上历史分页。
 * 上层（App）只需把 WS 引擎产出的 ChatMessage[] 与回调传进来。
 */
import { Info, Sparkles } from "lucide-react";
import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Virtuoso, VirtuosoMockContext, type Components } from "react-virtuoso";
import type {
  ChatMessage,
  LiveTurnTokenUsageSnapshot,
} from "../lib/chat/model";
import { UserUpwardPagingController } from "../lib/chat/tapePaging";
import {
  collectResolvedDispatchTurnIds,
  HIDDEN_REVIEWER_AGENT_ID,
  isRedundantRuntimeEnvelope,
  isTurnStatusSuppressedByTape,
  messageKind,
  messageSignature,
} from "../lib/chat/render";
import {
  AssistantCard,
  type CardCallbacks,
  DelegateProgressCard,
  GoalCard,
  PlanCard,
  SystemCard,
  ThinkingCard,
  TurnStatusCard,
  UserCard,
} from "./chat/cards";
import { AgentGroupCard } from "./chat/AgentGroupCard";
import { GeneratingPlaceholderCard } from "./chat/GeneratingPlaceholderCard";
import { TeamPanel } from "./chat/TeamPanel";
import { PermissionCard, type PermissionRespond } from "./chat/PermissionCard";
import { ToolCardSlot } from "./chat/toolCardSlot";
import { TurnActivity, type TurnActivityInfo } from "./chat/TurnActivity";
import { currentTurnStartIndex, turnFinalAssistantFlags } from "./chat/turnSegment";
import { loadedArchivedMetrics } from "./chat/archivePaging";
import { JournalHydrationRetry, PartialHistorySkeleton } from "./chat/HistorySkeleton";
import { MessageBoundary } from "./MessageBoundary";
import { asStr, resolveToolInput } from "./tool/format";
import { Alert, Avatar, Spinner } from "./ui";
import {
  delegateTokenUsage,
  displayCallTokenUsage,
  type DisplayTokenUsage,
  groupedCallTokenUsage,
  tokenUsageSignature,
  tokenUsageSnapshot,
} from "./chat/tokenUsage";

type RendererProps = {
  message: ChatMessage;
  /** 渲染签名（变更触发重渲；不变则 memo 跳过——防闪核心）。*/
  sig: string;
  isLast: boolean;
  sending: boolean;
  /** 是否属于「当前活跃段」(最后一条 user 消息之后)。判定收口在 chat/turnSegment.ts,
   *  与 PinnedTaskTracker 的任务源提取共用同一函数——决定 TodoWrite/plan 抑制还是渲染只读卡。*/
  inActiveTurn: boolean;
  /** 当前活跃会话的本轮活动快照（AssistantCard 流式空正文分支据此渲染阶段反馈）。透传，
   *  不进 memo 比较键——TurnActivity 自带 1s tick，无需靠父级重渲驱动秒数。 */
  turnActivity?: TurnActivityInfo | null;
  /** 本轮活动状态由稳定的 MessageList footer 独占，避免行类型切换时重复挂卸。 */
  activityInFooter?: boolean;
  /** 服务端历史代次；隔离旧请求与同 id 的新时间线。 */
  historyGeneration?: number | string;
  /** 生命周期归 MessageList，而不是可卸载的虚拟行。 */
  processPaging?: UserUpwardPagingController;
  /** Exact call usage for this card, or the final assistant's turn fallback. */
  tokenUsage?: DisplayTokenUsage;
  /** 债D:agent-group 单卡(未成团的退化委派)本 turn 的委派成本(十进制大数字符串)。
   *  来自队长助手行 usage.delegates,按 _delegateAgentId 匹配;非 agent-group 行恒 undefined。
   *  值来自**别的行**(助手行)故不在 message sig 内,单列进 memo 比较器,成本后到时正常重渲。*/
  delegateCost?: string;
  /** 该行是否为「所在轮末条 assistant 正文」(评价反馈行只挂末条,轮内中间回复不出)。
   *  值随后续消息追加而翻转,**已编进 sig head**(messageSignature 的 turnFinalAssistant)→
   *  由 a.sig===b.sig 覆盖翻转重渲,无需单列进 memo 比较器。*/
  turnFinalAssistant?: boolean;
  cb: CardCallbacks;
  onRespondPermission: PermissionRespond;
  /** 只读会话查看：禁止权限/问答卡触发任何写动作。 */
  readOnly?: boolean;
  /** 同一可见轮已有错误卡/状态卡，用户行不再重复展示失败标签和重试。 */
  failurePresentedBelow?: boolean;
};

export const MessageRenderer = memo(
  function MessageRenderer({
    message,
    sig,
    isLast,
    sending,
    inActiveTurn,
    turnActivity,
    activityInFooter,
    historyGeneration,
    processPaging,
    tokenUsage,
    delegateCost,
    turnFinalAssistant,
    cb,
    onRespondPermission,
    readOnly = false,
    failurePresentedBelow = false,
  }: RendererProps) {
    const ctx = {
      isLast,
      sending,
      turnActivity,
      inActiveTurn,
      turnFinalAssistant,
      activityInFooter,
    };
    // Runtime envelopes and hidden reconciliation evidence are audit/transport
    // data, not conversation cards. Their genuine thinking/tool/assistant
    // counterparts are separate equal-rank timeline records.
    if (message._timelineAuxiliary || message.role === "runtime-event") return null;
    if (isRedundantRuntimeEnvelope(message)) return null;
    if (message._payloadDeferred) {
      return (
        <DeferredTapeRecordCard
          message={message}
          isLast={isLast}
          sending={sending}
          inActiveTurn={inActiveTurn}
          turnActivity={turnActivity}
          activityInFooter={activityInFooter}
          historyGeneration={historyGeneration}
          processPaging={processPaging}
          tokenUsage={tokenUsage}
          turnFinalAssistant={turnFinalAssistant}
          cb={cb}
          onRespondPermission={onRespondPermission}
          readOnly={readOnly}
          failurePresentedBelow={failurePresentedBelow}
        />
      );
    }
    // 过程控制不是 Agent 内容，只负责真实记录的惰性分页。
    if (message._turnTapeProcess) {
      return null;
    }
    if (message._turnStatusRecord) {
      return <TurnStatusCard msg={message} cb={cb} currentTurn={inActiveTurn} />;
    }
    switch (messageKind(message)) {
      case "user":
        return <UserCard msg={message} cb={cb} failurePresentedBelow={failurePresentedBelow} />;
      case "assistant":
        return <AssistantCard msg={message} ctx={ctx} cb={cb} tokenUsage={tokenUsage} />;
      case "thinking":
        // 单条兜底路径(直接经 MessageRenderer,如测试/非列表场景)。列表内的连续 thinking
        // 由 MessageList/coalesceTeam 合并成单张多段卡,不走这里。
        return (
          <TapeBackedCard>
            <ThinkingCard
              msgs={[message]}
              sig={sig}
              ctx={ctx}
              tokenUsage={tokenUsage}
            />
          </TapeBackedCard>
        );
      case "tool": {
        // 模型原生 imagegen(codex:imageGeneration)running → 生成占位卡(需求 C，粒子特效框);
        // 完成/失败回落 ToolCardSlot。running 判定语义与 bodies.tsx 一致(按 tool._completed/error
        // + input.status,不 import bodies 内部),保证两处对同一态的判断不漂移。
        if (message.toolName === "codex:imageGeneration") {
          const input = resolveToolInput(message);
          const failedStatus = /^(failed|error)$/i.test(asStr(input?.status)) || !!message.error;
          const running = !message._completed && !message.error && !failedStatus;
          if (running) {
            // native imagegen 不带目标比例 → 默认 1:1(规格 §36);startedAt = 工具行 mint 时刻。
            return <GeneratingPlaceholderCard aspect={1} status="running" startedAt={message.ts} />;
          }
        }
        // 任务列表(TodoWrite):当前活跃段且本轮进行中 → 由钉在输入框上方的 PinnedTaskTracker
        // (HUD)接管,inline 卡抑制避免上下重复;历史段(或 turn 已结束、HUD 隐藏后)渲染
        // 既有 TodoWrite 只读紧凑卡(含步骤与完成状态),翻旧会话仍能看到当时的计划。
        if (message.toolName === "TodoWrite") {
          if (inActiveTurn && sending) return null;
          return <ToolCardSlot message={message} tokenUsage={tokenUsage} />;
        }
        return <ToolCardSlot message={message} tokenUsage={tokenUsage} />;
      }
      case "plan":
        // structured plan steps:当前活跃段且本轮进行中 → 统一进 composer 上方的
        // PinnedTaskTracker,inline 抑制防同一计划上下重复两张卡;历史段渲染 PlanCard
        // 只读卡(含步骤与状态)。text-only plan(无 steps)恒走 inline 兜底。
        if ((message.steps?.length ?? 0) > 0 && inActiveTurn && sending) return null;
        return (
          <TapeBackedCard>
            <PlanCard msg={message} tokenUsage={tokenUsage} />
            <ExactTapeRecordDisclosure messages={[message]} label="计划" />
          </TapeBackedCard>
        );
      case "goal":
        return (
          <TapeBackedCard>
            <GoalCard msg={message} />
            <ExactTapeRecordDisclosure messages={[message]} label="目标" />
          </TapeBackedCard>
        );
      case "permission":
        return (
          <PermissionCard
            msg={message}
            onRespond={onRespondPermission}
            readOnly={readOnly}
            livePrompt={!readOnly && inActiveTurn && sending}
          />
        );
      case "agent-group":
        return <AgentGroupCard msg={message} delegateCost={delegateCost} />;
      case "delegate-progress":
        return <DelegateProgressCard msg={message} />;
      case "system":
        return <SystemCard msg={message} />;
      default:
        // Immutable tape rows must remain visible even when a newer engine
        // introduces a role this web build does not yet understand. Render
        // the exact raw record instead of silently dropping the event.
        return message._timelineRecord === true || message._turnTapeId
          ? <RuntimeEventCard message={message} />
          : null;
    }
  },
  (a, b) =>
    a.sig === b.sig &&
    // 段归属变化(新 user 消息推进边界)不体现在 sig 里,必须单独参与比较,
    // 否则上一轮的 TodoWrite/plan 卡在跨轮时不会从"抑制"切到"只读卡"。
    a.inActiveTurn === b.inActiveTurn &&
    a.tokenUsage?.totalTokens === b.tokenUsage?.totalTokens &&
    // 债D 委派成本来自别的行(助手行 usage.delegates),不进 message sig,单列比较,
    // 否则成本在 agent-group 完成后才到达时 memo 会跳过重渲、单卡不显示「N 积分」。
    a.delegateCost === b.delegateCost &&
    a.activityInFooter === b.activityInFooter &&
    a.historyGeneration === b.historyGeneration &&
    a.processPaging === b.processPaging &&
    a.readOnly === b.readOnly &&
    a.failurePresentedBelow === b.failurePresentedBelow &&
    a.cb === b.cb &&
    a.onRespondPermission === b.onRespondPermission,
);

const RUNTIME_TEXT_STEP = 32 * 1024;

function TapeBackedCard({ children }: { children: ReactNode }) {
  return <div className="space-y-1">{children}</div>;
}

/** Readable cards retain their pre-direct-timeline UX, while the immutable
 * source remains reachable byte-for-byte instead of being replaced by the
 * formatted view. Serialization and mounting happen only after the click. */
function ExactTapeRecordDisclosure({
  messages,
  label,
}: {
  messages: ChatMessage[];
  label: string;
}) {
  const exactMessages = messages.filter((message) => !!message._turnTapeId);
  const [open, setOpen] = useState(false);
  const [visibleChars, setVisibleChars] = useState(RUNTIME_TEXT_STEP);
  if (exactMessages.length === 0) return null;

  const raw = exactMessages.length === 1
    ? exactMessages[0]._eventHistory ?? exactMessages[0]
    : exactMessages.map((message) => message._eventHistory ?? message);
  const serialized = open ? JSON.stringify(raw, null, 2) ?? String(raw) : "";

  return (
    <div className="px-1">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="text-[11px] text-faint hover:text-muted"
      >
        {open ? `收起原始${label}记录` : `查看原始${label}记录`}
      </button>
      {open && (
        <div className="mt-1 rounded-md border border-border bg-surface px-3 py-2">
          <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed text-muted">
            {serialized.slice(0, visibleChars)}
          </pre>
          {visibleChars < serialized.length && (
            <button
              type="button"
              onClick={() => setVisibleChars((value) => value + RUNTIME_TEXT_STEP)}
              className="mt-2 rounded-full bg-hover px-2.5 py-1 text-[11px] text-muted hover:text-fg"
            >
              继续显示原始记录
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Every persisted runtime event remains inspectable. The JSON body is
 * progressively mounted so a multi-megabyte event never blocks a frame. */
function RuntimeEventCard({ message }: { message: ChatMessage }) {
  const raw = message._runtimeEvent ?? message;
  const event = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const eventLabel = [event.type, event.subtype].filter((part) => typeof part === "string").join(" · ");
  const label = eventLabel || (message.role === "runtime-event"
    ? "运行事件"
    : `原始 Agent 记录 · ${message.role || "unknown"}`);
  const [open, setOpen] = useState(false);
  const [visibleChars, setVisibleChars] = useState(RUNTIME_TEXT_STEP);
  const serialized = open ? JSON.stringify(raw, null, 2) : "";
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface animate-in">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-[12.5px] hover:bg-hover"
      >
        <span className="size-1.5 shrink-0 rounded-full bg-faint" />
        <span className="min-w-0 flex-1 truncate text-muted">{label}</span>
        {message._runtimeSource && <span className="shrink-0 text-[11px] text-faint">{message._runtimeSource}</span>}
        <span className="text-faint">{open ? "收起" : "查看原始记录"}</span>
      </button>
      {open && (
        <div className="border-t border-border px-3.5 py-2.5">
          <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed text-muted">
            {serialized.slice(0, visibleChars)}
          </pre>
          {visibleChars < serialized.length && (
            <button
              type="button"
              onClick={() => setVisibleChars((value) => value + RUNTIME_TEXT_STEP)}
              className="mt-2 rounded-full bg-hover px-2.5 py-1 text-[11px] text-muted hover:text-fg"
            >
              继续显示原始记录
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function DeferredTapeRecordCard({
  message,
  isLast,
  sending,
  inActiveTurn,
  turnActivity,
  activityInFooter,
  historyGeneration,
  processPaging,
  tokenUsage,
  cb,
  onRespondPermission,
  readOnly,
  turnFinalAssistant,
  failurePresentedBelow,
}: Omit<RendererProps, "sig" | "delegateCost">) {
  const ref = useRef<HTMLDivElement>(null);
  const isUserPayload = message._userPayloadDeferred === true;
  const payloadId = isUserPayload ? message._userPayloadId ?? message.id : message.id;
  const payloadSha256 = message._payloadSha256;
  const tapeId = message._turnTapeId;
  const recordOrdinal = message._recordOrdinal;
  const initialExpectation = {
    recordId: payloadId,
    role: message.role,
    ...(payloadSha256 ? { contentSha256: payloadSha256 } : {}),
  };
  const [records, setRecords] = useState<ChatMessage[] | null>(() => {
    if (isUserPayload) {
      return cb.onPeekUserMessagePayload?.(payloadId, initialExpectation) ?? null;
    }
    if (tapeId && typeof recordOrdinal === "number") {
      return cb.onPeekTapeRecordPayload?.(tapeId, recordOrdinal, initialExpectation) ?? null;
    }
    return null;
  });
  const started = useRef(records !== null);
  const requestAbortRef = useRef<AbortController | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    if (started.current) return;
    const expected = {
      recordId: payloadId,
      role: message.role,
      ...(payloadSha256 ? { contentSha256: payloadSha256 } : {}),
    };
    const controller = new AbortController();
    let request: Promise<ChatMessage[] | null> | null = null;
    if (isUserPayload) {
      if (cb.onFetchUserMessagePayload) {
        request = cb.onFetchUserMessagePayload(payloadId, expected, controller.signal);
      }
    } else {
      if (cb.onFetchTapeRecordPayload && tapeId && typeof recordOrdinal === "number") {
        request = cb.onFetchTapeRecordPayload(tapeId, recordOrdinal, expected, controller.signal);
      }
    }
    if (!request) {
      setFailed(true);
      return;
    }
    started.current = true;
    requestAbortRef.current = controller;
    setFailed(false);
    let loaded: ChatMessage[] | null = null;
    try {
      loaded = await request;
    } catch {
      loaded = null;
    }
    if (requestAbortRef.current === controller) requestAbortRef.current = null;
    if (controller.signal.aborted) return;
    if (!loaded) {
      started.current = false;
      setFailed(true);
      return;
    }
    setRecords(loaded);
  }, [
    cb.onFetchTapeRecordPayload,
    cb.onFetchUserMessagePayload,
    isUserPayload,
    message.role,
    payloadId,
    payloadSha256,
    recordOrdinal,
    tapeId,
  ]);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const cancel = () => {
      const controller = requestAbortRef.current;
      if (!controller) return;
      requestAbortRef.current = null;
      started.current = false;
      controller.abort();
    };
    if (typeof IntersectionObserver === "undefined") {
      void load();
      return cancel;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          void load();
        }
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      cancel();
    };
  }, [load]);

  if (records) {
    return (
      <div className="space-y-3">
        {records.map((record, index) => {
          // Payload bytes are immutable, but billing/status overlays on the
          // small locator can advance after the first viewport load. Re-merge
          // them on every locator render so late cost/waiver/reply state stays
          // visible without downloading the immutable body again.
          const currentUsage = record.id === message.id && message.usage
            ? { ...(record.usage ?? {}), ...message.usage }
            : record.usage;
          const hydratedRecord: ChatMessage = isUserPayload
            ? {
                ...record,
                // Keep UI actions bound to the current dispatch row; the
                // immutable fetch key remains explicit and survives reload.
                id: message.id,
                _userPayloadId: message._userPayloadId ?? message.id,
                _source: "server",
                status: message.status ?? record.status,
                ...(currentUsage ? { usage: currentUsage } : {}),
                _payloadDeferred: undefined,
                _userPayloadDeferred: undefined,
                _payloadBytes: undefined,
                _payloadSha256: undefined,
                _seq: message._seq,
                _orderSeq: message._orderSeq,
                _timelineRecord: message._timelineRecord,
                _timelineUnitKey: message._timelineUnitKey,
                _timelineLogicalOrdinal: message._timelineLogicalOrdinal,
                _historyPageLoadedFrom: message._historyPageLoadedFrom,
                _historyPageKey: message._historyPageKey,
                _clientMessageId: record._clientMessageId ?? message._clientMessageId,
                _routing: record._routing ?? message._routing,
                _sendAttempt: message._sendAttempt ?? record._sendAttempt,
                _deferredRetryEligible: undefined,
              }
            : {
                ...record,
                ...(currentUsage ? { usage: currentUsage } : {}),
                _turnTapeId: message._turnTapeId,
                _turnTapeSha256: message._turnTapeSha256,
                _turnTapeOrdinal: message._recordOrdinal,
                _recordOrdinal: message._recordOrdinal,
                _turnTapeComplete: true,
                _turnTapeProcessLoadedFrom: message._turnTapeProcessLoadedFrom,
                _seq: message._seq,
                _orderSeq: message._orderSeq,
                _timelineRecord: message._timelineRecord,
                _timelineUnitKey: `${message._timelineUnitKey ?? message.id}:logical:${index}`,
                _timelineLogicalOrdinal: index,
                _historyPageLoadedFrom: message._historyPageLoadedFrom,
                _historyPageKey: message._historyPageKey,
                _clientMessageId: record._clientMessageId ?? message._clientMessageId,
              };
          const final = isLast && index === records.length - 1;
          const recordIsFinalAssistant = turnFinalAssistant === true &&
            hydratedRecord.role === "assistant" && index === records.length - 1;
          const recordSig = messageSignature(hydratedRecord, {
            isLast: final,
            sending,
            turnFinalAssistant: recordIsFinalAssistant,
          });
          return (
            <MessageRenderer
              key={hydratedRecord.id}
              message={hydratedRecord}
              sig={recordSig}
              isLast={final}
              sending={sending}
              inActiveTurn={inActiveTurn}
              turnActivity={turnActivity}
              activityInFooter={activityInFooter}
              historyGeneration={historyGeneration}
              processPaging={processPaging}
              tokenUsage={tokenUsage}
              turnFinalAssistant={recordIsFinalAssistant}
              cb={cb}
              onRespondPermission={onRespondPermission}
              readOnly={readOnly}
              failurePresentedBelow={failurePresentedBelow}
            />
          );
        })}
      </div>
    );
  }
  return (
    <div ref={ref} className="rounded-lg border border-dashed border-border bg-surface px-3.5 py-3 text-xs text-muted">
      {failed ? (
        <button type="button" onClick={() => void load()} className="text-danger hover:underline">
          {isUserPayload ? "完整用户消息加载失败，点击重试" : "真实记录加载失败，点击重试"}
        </button>
      ) : (
        <span>{isUserPayload ? "正在读取完整用户消息…" : "正在读取真实 Agent 记录…"}</span>
      )}
    </div>
  );
}

/** 渲染项:普通单条消息(idx 为全局下标,供活跃段归属判定),或"连续多个委派智能体聚成的团队",
 *  或"连续多个 role=thinking 行合并成的单张多段思考卡"。
 *  delegateCost / delegateCosts = 债D per-delegate 成本(见 coalesceTeam)。 */
type RenderItem =
  | {
      kind: "single";
      m: ChatMessage;
      isLast: boolean;
      idx: number;
      delegateCost?: string;
      tokenUsage?: DisplayTokenUsage;
    }
  | { kind: "team"; members: ChatMessage[]; sig: string; delegateCosts?: Record<string, string> }
  | {
      kind: "thinking";
      members: ChatMessage[];
      sig: string;
      isLast: boolean;
      idx: number;
      tokenUsage?: DisplayTokenUsage;
    };

function tapeRenderPageKey(message: ChatMessage | undefined): string {
  if (!message) return "";
  if (message._historyPageKey) return message._historyPageKey;
  if (message._turnTapeProcessPageKey) return message._turnTapeProcessPageKey;
  // Rows cached by the immediately preceding build do not yet carry a cursor
  // page key. Derive a stable physical-ordinal bucket so an already-open long
  // session becomes virtualized immediately after upgrade; this is only a UI
  // render identity and does not alter, summarize or discard any record.
  if (message._turnTapeProcessLoadedFrom) {
    const ordinal = typeof message._turnTapeOrdinal === "number"
      ? message._turnTapeOrdinal
      : message._recordOrdinal;
    if (typeof ordinal === "number" && Number.isFinite(ordinal)) {
      return `${message._turnTapeProcessLoadedFrom}::legacy-bucket:${Math.floor(ordinal / 200)}`;
    }
  }
  return "";
}

/**
 * 把「队长**同一并行批次**委派的多个 agent-group」聚成一个团队项(≥2 → TeamPanel;单个
 * 退化回 AgentGroupCard)。团队 sig = 各成员 messageSignature 拼接(任一成员变 → 面板重渲,防闪)。
 *
 * **按 (turn 锚点, 叙事阶段) 归组**(2026-07-07,boss 时序反直觉反馈):
 *   - turn 锚点 = 其前最近一条 user 消息下标(与 turnSegment 同一"轮"定义,user 行客户端
 *     权威、server 从不重写/重排,最稳定)。
 *   - 叙事阶段 = 同 turn 内被**队长 assistant 叙事文本行**(非空 text)切开的段序号。聚天线
 *     只允许"同时并行"的委派共面板;队长叙事之后才启动的阶段(如 hidden-reviewer 审查)
 *     属于新阶段 → **按时间顺序独立出现在叙事之后**,绝不吸回上方旧面板(旧行为把审查卡
 *     塞回面板,造成"上面又动了/会话早就结束了"的错觉)。
 *   - 隐藏审查员(hidden-reviewer)卡**永不入面板**:它语义上是编排阶段而非并行队员,恒走
 *     单卡按时序渲染。
 *   - 只有 assistant 叙事行断组;工具行/thinking/server-authored 骨架混排**不隔断**——保留
 *     turn 锚点方案修掉的"混排劈裂面板"抗性(这是当年放弃纯相邻启发式的原因,勿回退)。
 *
 * 锚点/阶段用**完整 messages**(非仅渲染切片)计算:切片起点可能落在某轮中段,靠全量数组
 * 才能找到该轮真正的边界。面板渲染在该批次**首个** agent-group 的位置,后续同批成员被吸收;
 * 夹在成员之间的非 agent-group 行仍按各自位置渲染(可能落到面板之后,属可接受的次序取舍)。
 */
function coalesceTeam(
  messages: ChatMessage[],
  start: number,
  sending: boolean,
  liveTurnUsage?: { clientMessageId: string; usage: LiveTurnTokenUsageSnapshot },
): RenderItem[] {
  const total = messages.length;
  const slice = messages.slice(start);
  // 全量前缀扫描:anchorOf[i] = 第 i 行之前(含自身若为 user)最近的 user 下标,无则 -1;
  // stageOf[i] = 该行在本 turn 内的叙事阶段序号(assistant 非空文本行使**后续**行阶段 +1,
  // user 行重置为 0)。
  const anchorOf: number[] = new Array(total);
  const stageOf: number[] = new Array(total);
  let lastUser = -1;
  let stage = 0;
  for (let i = 0; i < total; i++) {
    const row = messages[i];
    if (row?.role === "user") {
      lastUser = i;
      stage = 0;
    }
    anchorOf[i] = lastUser;
    stageOf[i] = stage;
    if (row?.role === "assistant" && typeof row.text === "string" && row.text.trim().length > 0) {
      stage++;
    }
  }
  // A card only displays the model call that actually produced it. The
  // turn-wide snapshot remains a fallback for the final assistant row; it is
  // never projected onto every tool/thinking card.
  let liveFallbackIdx = -1;
  if (liveTurnUsage) {
    const liveAnchor = messages.findIndex(
      (message) => message.role === "user" && message.id === liveTurnUsage.clientMessageId,
    );
    if (liveAnchor >= 0) {
      for (let i = liveAnchor + 1; i < total && messages[i]?.role !== "user"; i++) {
        if (messages[i]?.role === "assistant") liveFallbackIdx = i;
      }
    }
  }
  const tokenUsageFor = (
    absIdx: number,
    message: ChatMessage,
  ): DisplayTokenUsage | undefined =>
    displayCallTokenUsage(message._callUsage) ??
    tokenUsageSnapshot(message.usage) ??
    (absIdx === liveFallbackIdx && liveTurnUsage
      ? { ...liveTurnUsage.usage }
      : undefined);
  // 面板成员资格:agent-group 且非隐藏审查员(审查卡恒单卡,按时序独立渲染)。
  const isPanelMember = (m: ChatMessage | undefined): boolean =>
    !!m && m._timelineRecord !== true && messageKind(m) === "agent-group" &&
    m._delegateAgentId !== HIDDEN_REVIEWER_AGENT_ID;
  // Loaded immutable pages are independent render quanta. Never merge a team
  // or thinking card across their boundary: doing so would change an existing
  // virtual item's height/key when an older page arrives.
  const tapePageKeyOf = tapeRenderPageKey;
  const batchKeyOf = (absIdx: number): string =>
    `${anchorOf[absIdx]}:${stageOf[absIdx]}:${tapePageKeyOf(messages[absIdx])}`;
  // 债D per-delegate 成本:队长**助手行**(role 'assistant',同一 turn 的最终答复)的
  // usage.delegates 已由 master 按 agentId 分组求和。按 turn 锚点归拢成 anchor → {agentId:
  // costCredits},供该轮团队卡/委派卡按 `_delegateAgentId` 匹配显示「· N 积分」。同一 agentId
  // 一轮被多次委派(如审查跑 2 轮)时是合计值 → 多张同名卡显示相同合计,已知可接受粒度。
  const delegateCostByAnchor = new Map<number, Record<string, string>>();
  for (let i = 0; i < total; i++) {
    const mm = messages[i];
    if (mm?.role !== "assistant" || !mm.usage?.delegates?.length) continue;
    const rec = delegateCostByAnchor.get(anchorOf[i]) ?? {};
    for (const d of mm.usage.delegates) {
      // 同 turn 若多条助手行都带 delegates,后者(最终答复行)胜。
      if (d && typeof d.agentId === "string" && typeof d.costCredits === "string") {
        rec[d.agentId] = d.costCredits;
      }
    }
    delegateCostByAnchor.set(anchorOf[i], rec);
  }
  const costFor = (absIdx: number, m: ChatMessage): string | undefined =>
    delegateCostByAnchor.get(anchorOf[absIdx])?.[m._delegateAgentId ?? ""];
  // 每个批次键在**渲染切片内**的可入面板 agent-group 计数(≥2 才成团;切片外成员不计入本屏面板)。
  const teamCount = new Map<string, number>();
  for (let i = 0; i < slice.length; i++) {
    if (isPanelMember(slice[i])) {
      const k = batchKeyOf(start + i);
      teamCount.set(k, (teamCount.get(k) ?? 0) + 1);
    }
  }
  const items: RenderItem[] = [];
  const emittedTeam = new Set<string>();
  // 连续 thinking 行合并:被吸收进某组的 thinking 行(首条除外)记入此集,外层循环跳过它们。
  const consumedThinking = new Set<number>();
  for (let i = 0; i < slice.length; i++) {
    const m = slice[i];
    const absIdx = start + i;
    if (consumedThinking.has(absIdx)) continue; // 已并入上方某思考卡 → 吸收跳过
    // Persisted historical records are already the Agent's exact ordered
    // logical stream. Never regroup, reorder or fold one record into another.
    if (m._timelineRecord === true) {
      items.push({
        kind: "single",
        m,
        isLast: absIdx === total - 1,
        idx: absIdx,
        tokenUsage: tokenUsageFor(absIdx, m),
      });
      continue;
    }
    if (isPanelMember(m)) {
      const batchKey = batchKeyOf(absIdx);
      if ((teamCount.get(batchKey) ?? 0) >= 2) {
        if (emittedTeam.has(batchKey)) continue; // 已并入该批次面板 → 吸收跳过
        emittedTeam.add(batchKey);
        const members: ChatMessage[] = [];
        const memberIdx: number[] = [];
        for (let j = 0; j < slice.length; j++) {
          if (isPanelMember(slice[j]) && batchKeyOf(start + j) === batchKey) {
            members.push(slice[j]);
            memberIdx.push(start + j);
          }
        }
        const delegateCosts = delegateCostByAnchor.get(anchorOf[absIdx]);
        items.push({
          kind: "team",
          members,
          // 成本值取自别的行(助手行),不在成员 message sig 内 → 折进团队 sig(每成员 cost 拼入),
          // 否则成本后到时 TeamPanel 的 sig-only memo 会跳过重渲(见 TeamPanel 尾 memo 注释)。
          sig: members
            .map(
              (mm, k) =>
                `${messageSignature(mm, { isLast: false, sending })}|c:${costFor(memberIdx[k], mm) ?? ""}|du:${tokenUsageSignature(delegateTokenUsage(mm))}`,
            )
            .join("||"),
          delegateCosts,
        });
        continue;
      }
      items.push({
        kind: "single",
        m,
        isLast: absIdx === total - 1,
        idx: absIdx,
        delegateCost: costFor(absIdx, m),
        tokenUsage: tokenUsageFor(absIdx, m),
      });
      continue;
    }
    if (messageKind(m) === "agent-group") {
      // 面板外的 agent-group(隐藏审查员卡/独居成员):单卡按时序渲染,委派成本徽记照常。
      items.push({
        kind: "single",
        m,
        isLast: absIdx === total - 1,
        idx: absIdx,
        delegateCost: costFor(absIdx, m),
        tokenUsage: tokenUsageFor(absIdx, m),
      });
      continue;
    }
    if (messageKind(m) === "thinking") {
      // 连续 thinking 行合并成单张多段卡(codex 一轮产十几条空正文标题卡)。中间夹**被跳过/
      // 不渲染的行**(messageKind==='unknown',渲染层本就静默)透明跳过不断组;任何会渲染的
      // 非 thinking 行(assistant/tool/agent-group 等)断组。参考 render.ts unknown 跳过 + 上方
      // coalesceTeam 混排不劈裂先例。
      const members: ChatMessage[] = [];
      const tapePageKey = tapePageKeyOf(m);
      let lastAbs = absIdx;
      for (let j = i; j < slice.length; j++) {
        const kj = messageKind(slice[j]);
        if (tapePageKeyOf(slice[j]) !== tapePageKey) break;
        if (kj === "thinking") {
          members.push(slice[j]);
          consumedThinking.add(start + j);
          lastAbs = start + j;
        } else if (kj === "unknown") {
          continue; // 透明跳过(不打断连续性;该行仍会被外层循环按原位渲染成 null)
        } else {
          break;
        }
      }
      // 组"live"取决于末条 thinking 是否为全列表末行且本轮在流(thinking isLive 语义)。
      const groupIsLast = lastAbs === total - 1;
      // 组 sig = 各成员签名拼接(仅末条按 groupIsLast 参与 isLast;文本 + 流式态都编进,
      // 后到成员/流式完成时 memo 正常重渲防漏渲)。key 用首条成员 id → 流式追加成员时稳定不重挂。
      const sig = members
        .map((mm, k) => messageSignature(mm, { isLast: groupIsLast && k === members.length - 1, sending }))
        .join("||");
      const thinkingUsage = groupedCallTokenUsage(members.map((member) => member._callUsage));
      items.push({
        kind: "thinking",
        members,
        sig: `${sig}|tu:${tokenUsageSignature(thinkingUsage)}`,
        isLast: groupIsLast,
        idx: absIdx,
        tokenUsage: thinkingUsage,
      });
      continue;
    }
    items.push({
      kind: "single",
      m,
      isLast: absIdx === total - 1,
      idx: absIdx,
      tokenUsage: tokenUsageFor(absIdx, m),
    });
  }
  return items;
}

// React Virtuoso uses firstItemIndex as a coordinate when items are prepended.
// Keep a very large internal origin so every older page can move left without
// imposing a user-visible history limit.
const TIMELINE_VIRTUAL_INDEX_ORIGIN = Math.floor(Number.MAX_SAFE_INTEGER / 4);

type VirtualItem = RenderItem;

type TimelineVirtuosoContext = {
  header: ReactNode;
  footer: ReactNode;
};

function TimelineVirtuosoHeader({ context }: { context: TimelineVirtuosoContext }) {
  return <>{context.header}</>;
}

function TimelineVirtuosoFooter({ context }: { context: TimelineVirtuosoContext }) {
  return <>{context.footer}</>;
}

// Component identities must stay constant. Inline Header/Footer functions make
// react-virtuoso remount the footer on every stream delta, which was one source
// of the user-visible "思考中" flash even when the row markup itself was stable.
const TIMELINE_VIRTUOSO_COMPONENTS: Components<VirtualItem, TimelineVirtuosoContext> = {
  Header: TimelineVirtuosoHeader,
  Footer: TimelineVirtuosoFooter,
};

function renderItemKey(item: RenderItem): string {
  return item.kind === "single"
    ? (item.m._timelineUnitKey ?? item.m.id)
    : item.members[0]?._timelineUnitKey ?? item.members[0]?.id ?? item.kind;
}

function renderItemMessages(item: RenderItem): ChatMessage[] {
  return item.kind === "single" ? [item.m] : item.members;
}

/**
 * Unified timeline paging context. Loading is an explicit-button action;
 * scrolling only navigates already resident records.
 */
export type MessageListArchive = {
  /** Unified server cursor reports an older exact page. */
  hasMore?: boolean;
  /** Rolling-test/old-caller compatibility only. */
  archivedCount?: number;
  archivedThroughSeq?: number;
  /** 云端加载进行中(按钮转 loading 态、禁用)。 */
  loading: boolean;
  /** 上次云端加载失败(按钮转「加载失败，点击重试」,点击即重试)。 */
  error: boolean;
  /** 拉更早一页归档(App 接线 loadOlderHistory + 前插后视口保持)。 */
  onLoadOlder: () => void | Promise<void>;
};

export function MessageList({
  messages,
  sending,
  liveTurnUsage,
  turnActivity,
  transientNotice,
  historyLoading = false,
  journalDegraded = false,
  onRetryJournal,
  archive,
  cb,
  onRespondPermission,
  readOnly = false,
  scrollParent,
  historyGeneration = "legacy",
}: {
  messages: ChatMessage[];
  sending: boolean;
  /** Active browser turn's live token display; estimates are explicitly marked. */
  liveTurnUsage?: { clientMessageId: string; usage: LiveTurnTokenUsageSnapshot };
  /** 本轮活动快照（TurnActivity 阶段反馈）；null=无活跃轮。*/
  turnActivity?: TurnActivityInfo | null;
  /** 会话级 transient 软提示（"较长时间未收到新内容…"，非消息卡片，末尾 info 条渲染）。*/
  transientNotice?: { text: string } | null;
  /** 已有部分消息可见，但 canonical history 仍在加载。Journal 水合不再占用此位。 */
  historyLoading?: boolean;
  /** Background live-journal hydrate degraded; show an explicit retry. */
  journalDegraded?: boolean;
  onRetryJournal?: () => void;
  /** 归档分页上下文；缺省=无归档(仅本地翻页)。*/
  archive?: MessageListArchive | null;
  cb: CardCallbacks;
  onRespondPermission: PermissionRespond;
  /** 管理端等只读 surface；默认 false，用户端行为不变。 */
  readOnly?: boolean;
  /** Existing chat scroller. When present, only viewport-adjacent rows mount. */
  scrollParent?: HTMLElement | null;
  /** Server history revision. A new revision gets a fresh paging intent owner. */
  historyGeneration?: number | string;
}) {
  const pagingOwnerRef = useRef<{
    generation: string;
    controller: UserUpwardPagingController;
  } | null>(null);
  const pagingGeneration = String(historyGeneration);
  if (!pagingOwnerRef.current || pagingOwnerRef.current.generation !== pagingGeneration) {
    pagingOwnerRef.current = {
      generation: pagingGeneration,
      controller: new UserUpwardPagingController(),
    };
  }
  const processPaging = pagingOwnerRef.current.controller;
  const [archiveQueued, setArchiveQueued] = useState(false);
  const archiveQueuedRef = useRef(false);
  const archiveQueueTokenRef = useRef(0);

  useEffect(() => {
    archiveQueueTokenRef.current += 1;
    archiveQueuedRef.current = false;
    setArchiveQueued(false);
  }, [processPaging]);

  // User input is observed only to invalidate an older click's viewport
  // correction. It never admits a history request: scrolling, touch momentum,
  // keyboard navigation and scrollbar dragging are navigation, not pagination.
  useEffect(() => {
    const scroller = scrollParent;
    if (!scroller) return;
    let touchMomentum = false;
    let touchIdleTimer: number | null = null;
    let scrollbarPointerId: number | null = null;
    const onWheel = () => processPaging.signalUserInteraction();
    const onTouchStart = () => {
      processPaging.signalUserInteraction();
      touchMomentum = true;
      if (touchIdleTimer !== null) {
        window.clearTimeout(touchIdleTimer);
        touchIdleTimer = null;
      }
    };
    const onTouchMove = () => {
      touchMomentum = true;
      processPaging.signalUserInteraction();
    };
    const endTouch = () => {
      processPaging.signalUserInteraction();
      touchMomentum = true;
      if (touchIdleTimer !== null) window.clearTimeout(touchIdleTimer);
      touchIdleTimer = window.setTimeout(() => {
        touchIdleTimer = null;
        touchMomentum = false;
      }, 240);
    };
    const cancelTouch = () => {
      processPaging.signalUserInteraction();
      touchMomentum = false;
      if (touchIdleTimer !== null) {
        window.clearTimeout(touchIdleTimer);
        touchIdleTimer = null;
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const upward = event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home" ||
        (event.key === " " && event.shiftKey);
      const navigates = upward || event.key === "ArrowDown" || event.key === "PageDown" ||
        event.key === "End" || event.key === " ";
      if (navigates) processPaging.signalUserInteraction();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" || scrollbarPointerId !== null) return;
      const gutter = scroller.offsetWidth - scroller.clientWidth;
      if (gutter <= 0) return;
      const rect = scroller.getBoundingClientRect();
      const inScrollbarGutter =
        event.clientX >= rect.right - gutter - 1 ||
        event.clientX <= rect.left + gutter + 1;
      if (!inScrollbarGutter) return;
      scrollbarPointerId = event.pointerId;
      processPaging.signalUserInteraction();
    };
    const endPointer = (event?: PointerEvent) => {
      if (
        scrollbarPointerId === null ||
        (event && event.pointerId !== scrollbarPointerId)
      ) return;
      scrollbarPointerId = null;
      processPaging.signalUserInteraction();
    };
    const onWindowBlur = () => endPointer();
    const onScroll = () => {
      if (scrollbarPointerId !== null) {
        processPaging.signalUserInteraction();
      } else if (touchMomentum) {
        processPaging.signalUserInteraction();
        if (touchIdleTimer !== null) window.clearTimeout(touchIdleTimer);
        touchIdleTimer = window.setTimeout(() => {
          touchIdleTimer = null;
          touchMomentum = false;
        }, 240);
      }
    };
    scroller.addEventListener("wheel", onWheel, { passive: true });
    scroller.addEventListener("touchstart", onTouchStart, { passive: true });
    scroller.addEventListener("touchmove", onTouchMove, { passive: true });
    scroller.addEventListener("touchend", endTouch, { passive: true });
    scroller.addEventListener("touchcancel", cancelTouch, { passive: true });
    scroller.addEventListener("keydown", onKeyDown);
    scroller.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", endPointer);
    window.addEventListener("pointercancel", endPointer);
    window.addEventListener("blur", onWindowBlur);
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (touchIdleTimer !== null) window.clearTimeout(touchIdleTimer);
      scroller.removeEventListener("wheel", onWheel);
      scroller.removeEventListener("touchstart", onTouchStart);
      scroller.removeEventListener("touchmove", onTouchMove);
      scroller.removeEventListener("touchend", endTouch);
      scroller.removeEventListener("touchcancel", cancelTouch);
      scroller.removeEventListener("keydown", onKeyDown);
      scroller.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", endPointer);
      window.removeEventListener("pointercancel", endPointer);
      window.removeEventListener("blur", onWindowBlur);
      scroller.removeEventListener("scroll", onScroll);
    };
  }, [processPaging, scrollParent]);

  // Drop legacy substitute rows from an old IndexedDB cache and duplicate
  // engine transport envelopes. The latter remain byte-complete in the tape;
  // their canonical immutable Agent blocks are the user-facing timeline.
  const resolvedDispatchTurnIds = collectResolvedDispatchTurnIds(messages);
  // Automatic recovery rows remain in memory/IndexedDB/PG as exact lineage,
  // but are transport controls rather than another user utterance. While a
  // child exists, its source terminal card is likewise an intermediate state;
  // only the final exhausted/unsafe error remains visible.
  const automaticallyRecoveredSourceIds = new Set(
    messages
      .filter((message) => message.role === "user" && message._automaticRecovery === true)
      .map((message) => message._recoveryOfClientMessageId)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );
  const renderableMessages = messages.filter(
    (m) =>
      !(m as ChatMessage & { _historyProjection?: unknown })._historyProjection &&
      !m.id.startsWith("projection-") &&
      !m.id.startsWith("oc-dispatch-err:") &&
      m._turnTapeProcess !== true &&
      m._timelineAuxiliary === undefined &&
      m.role !== "runtime-event" &&
      !(m.role === "user" && m._isAutoRetry === true && m._automaticRecovery === true) &&
      !(
        m.role === "assistant" &&
        !!m._errorCode &&
        typeof m._clientMessageId === "string" &&
        automaticallyRecoveredSourceIds.has(m._clientMessageId)
      ) &&
      !isRedundantRuntimeEnvelope(m) &&
      !isTurnStatusSuppressedByTape(m, resolvedDispatchTurnIds),
  );
  const visibleUserIds = new Set(
    renderableMessages
      .filter((message) => message.role === "user")
      .map((message) => message.id),
  );
  const automaticRecoveryParents = new Map(
    messages
      .filter(
        (message) =>
          message.role === "user" &&
          message._automaticRecovery === true &&
          typeof message._recoveryOfClientMessageId === "string" &&
          message._recoveryOfClientMessageId.length > 0,
      )
      .map((message) => [message.id, message._recoveryOfClientMessageId as string]),
  );
  const visibleErrorTurnId = (clientMessageId: string) => {
    let current = clientMessageId;
    const visited = new Set<string>();
    while (!visibleUserIds.has(current) && !visited.has(current)) {
      visited.add(current);
      const parent = automaticRecoveryParents.get(current);
      if (!parent) break;
      current = parent;
    }
    return current;
  };
  const presentedErrorTurnIds = new Set(
    renderableMessages
      .filter(
        (message) =>
          typeof message._clientMessageId === "string" &&
          message._clientMessageId.length > 0 &&
          (message._turnStatusRecord === true ||
            (message.role === "assistant" && !!message._errorCode)),
      )
      .map((message) => visibleErrorTurnId(message._clientMessageId as string)),
  );
  const legacyArchivedRemaining = archive?.hasMore === undefined
    ? Math.max(
        0,
        (archive?.archivedCount ?? 0) - loadedArchivedMetrics(
          messages,
          archive?.archivedThroughSeq ?? 0,
        ).anchors,
      )
    : 0;
  const hasOlderHistory = archive?.hasMore ?? (legacyArchivedRemaining > 0);
  const requestOlderArchive = useCallback(() => {
    if (
      !archive || !hasOlderHistory || archive.loading ||
      archiveQueuedRef.current
    ) return;
    archiveQueuedRef.current = true;
    setArchiveQueued(true);
    const token = ++archiveQueueTokenRef.current;
    const requestKey = `timeline::${pagingGeneration}`;
    // The new explicit navigation cancels any older tape anchor correction
    // immediately; its network task still finishes before this FIFO slot.
    processPaging.signalUserInteraction();
    void processPaging.runExplicit(requestKey, async () => {
      await archive.onLoadOlder();
    }).finally(() => {
      if (archiveQueueTokenRef.current !== token) return;
      archiveQueuedRef.current = false;
      setArchiveQueued(false);
    });
  }, [archive, hasOlderHistory, pagingGeneration, processPaging]);
  // 当前活跃段起点(最后一条 user 消息之后)——TodoWrite/plan 的 HUD 抑制只作用于该段,
  // 与 PinnedTaskTracker 的任务源提取共用 turnSegment.ts 同一判定。
  const turnStart = currentTurnStartIndex(renderableMessages);
  // 每条消息是否为「所在轮末条 assistant 正文」(评价反馈行唯一可见位)。按全量 messages 下标对齐,
  // 单一权威在 turnSegment.ts(与 turnStart / coalesceTeam 同源的 user=轮边界判定,不另造第二套)。
  const ratingFinal = turnFinalAssistantFlags(renderableMessages);
  const renderItems = coalesceTeam(renderableMessages, 0, sending, liveTurnUsage);
  // One genuine timeline record is one Virtuoso item. Grouping a whole server
  // page into a tall virtual row makes prepend measurements unstable: the old
  // anchor row changes height and the viewport jumps. Virtuoso itself limits
  // mounted DOM to the viewport, so keeping records separate adds no content
  // cap and preserves exact per-record identity while paging backwards.
  const virtualItems: VirtualItem[] = renderItems;
  const itemKey = renderItemKey;
  // Give every already-loaded archive item a stable virtual coordinate. When
  // another archive page is prepended, firstItemIndex decreases by exactly the
  // number of new virtual items, so Virtuoso keeps the old viewport mounted.
  // A mixed boundary item is deliberately excluded: it replaces the previous
  // first tail item rather than adding another virtual row.
  let archivedVirtualPrefixItems = 0;
  if (archive) {
    for (const item of virtualItems) {
      const itemMessages = renderItemMessages(item);
      if (
        itemMessages.length === 0 ||
        !itemMessages.every((message) => typeof message._historyPageLoadedFrom === "string")
      ) break;
      archivedVirtualPrefixItems += 1;
    }
  }
  const firstItemIndex = TIMELINE_VIRTUAL_INDEX_ORIGIN - archivedVirtualPrefixItems;
  const showHistoryBoundary = hasOlderHistory || renderableMessages.some(
    (message) => typeof message._historyPageLoadedFrom === "string",
  );
  const renderItem = (it: RenderItem) => {
    if (it.kind === "single" && it.m._genPlaceholder) {
      const gp = it.m._genPlaceholder;
      const placeholderSig = `genph|${it.m.id}|${gp.status}|${gp.startedAt}|${gp.aspect}`;
      return (
        <MessageBoundary messageId={it.m.id} sig={placeholderSig}>
          <GeneratingPlaceholderCard
            aspect={gp.aspect}
            status={gp.status}
            startedAt={gp.startedAt}
            reason={gp.reason}
          />
        </MessageBoundary>
      );
    }
    if (it.kind === "team") {
      return (
        <MessageBoundary messageId={it.members[0].id} sig={it.sig}>
          <TeamPanel members={it.members} sig={it.sig} delegateCosts={it.delegateCosts} />
        </MessageBoundary>
      );
    }
    if (it.kind === "thinking") {
      return (
        <MessageBoundary messageId={it.members[0].id} sig={it.sig}>
          <TapeBackedCard>
            <ThinkingCard
              msgs={it.members}
              sig={it.sig}
              ctx={{ isLast: it.isLast, sending, activityInFooter: sending }}
              tokenUsage={it.tokenUsage}
            />
          </TapeBackedCard>
        </MessageBoundary>
      );
    }
    const turnFinalAssistant = ratingFinal[it.idx] ?? false;
    const failurePresentedBelow =
      it.m.role === "user" && presentedErrorTurnIds.has(it.m.id);
    const rowSig = `${messageSignature(it.m, {
      isLast: it.isLast,
      sending,
      turnFinalAssistant,
    })}|tu:${tokenUsageSignature(it.tokenUsage)}|du:${tokenUsageSignature(delegateTokenUsage(it.m))}|pe:${failurePresentedBelow ? 1 : 0}`;
    return (
      <MessageBoundary messageId={it.m._timelineUnitKey ?? it.m.id} sig={rowSig}>
        <MessageRenderer
          message={it.m}
          sig={rowSig}
          isLast={it.isLast}
          sending={sending}
          inActiveTurn={it.idx >= turnStart}
          turnActivity={turnActivity}
          activityInFooter={sending}
          historyGeneration={historyGeneration}
          processPaging={processPaging}
          tokenUsage={it.tokenUsage}
          delegateCost={it.delegateCost}
          turnFinalAssistant={turnFinalAssistant}
          cb={cb}
          onRespondPermission={onRespondPermission}
          readOnly={readOnly}
          failurePresentedBelow={failurePresentedBelow}
        />
      </MessageBoundary>
    );
  };
  const renderVirtualItem = renderItem;
  const historyControl = archive && showHistoryBoundary ? (
    <div
      className="mx-auto flex max-w-3xl justify-center px-5 pb-4 pt-8"
      data-testid="history-page-loader"
    >
      <button
        type="button"
        onClick={hasOlderHistory ? requestOlderArchive : undefined}
        disabled={!hasOlderHistory || archive.loading || archiveQueued}
        aria-busy={hasOlderHistory && (archive.loading || archiveQueued)}
        className="mx-auto inline-flex items-center gap-1.5 rounded-full bg-hover px-3 py-1 text-xs text-muted transition-colors hover:text-fg disabled:cursor-default disabled:opacity-60 [@media(hover:none)]:min-h-11 [@media(hover:none)]:py-2.5"
      >
        {!hasOlderHistory
          ? "已到最早记录"
          : archive.loading || archiveQueued
          ? <><Spinner size={12} /> 加载中…</>
          : archive.error
            ? <span className="text-danger">加载失败，点击重试</span>
            : legacyArchivedRemaining > 0
              ? `查看更早历史记录（还有 ${legacyArchivedRemaining} 条）`
              : "查看更早历史记录"}
      </button>
    </div>
  ) : null;
  const footer = (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-5 pb-8 pt-4">
      <div data-testid="turn-activity-footer">
        {sending && (
          <div className="flex gap-4">
            {/* 与 AssistantCard 一致:移动端隐藏头像,窄屏正文占满宽度。 */}
            <Avatar tone="brand" className="mt-0.5 hidden shadow-sm sm:inline-flex">
              <Sparkles size={16} />
            </Avatar>
            <div className="min-w-0 flex-1">
              <TurnActivity info={turnActivity ?? { startedAt: null, agentName: "助手" }} />
            </div>
          </div>
        )}
      </div>
      {/* 会话级 transient 软提示（超时软提示等，非消息卡片、不落库；刷新即消失，不与真内容矛盾）。 */}
      {transientNotice && (
        <Alert tone="info" icon={<Info size={16} />}>
          {transientNotice.text}
        </Alert>
      )}
      {historyLoading && <PartialHistorySkeleton />}
      {journalDegraded && !historyLoading && onRetryJournal && (
        <JournalHydrationRetry onRetry={onRetryJournal} />
      )}
    </div>
  );

  // App/admin pass an explicit null during the callback-ref's first commit.
  // Mounting the non-virtual fallback in that one frame would still build the
  // entire long transcript before Virtuoso can take over. Omitted/undefined
  // remains the lightweight test/non-scroll surface contract.
  if (scrollParent === null) {
    return (
      <div className="mx-auto flex max-w-3xl items-center justify-center px-5 py-8 text-muted" role="status">
        <Spinner size={14} />
        <span className="ml-2 text-xs">正在准备会话…</span>
      </div>
    );
  }

  if (scrollParent) {
    const virtualList = (
      <Virtuoso
        customScrollParent={scrollParent}
        data={virtualItems}
        firstItemIndex={firstItemIndex}
        context={{ header: historyControl, footer }}
        computeItemKey={(_index, item) => itemKey(item)}
        itemContent={(_index, item) => (
          <div
            className="chat-virtual-item mx-auto max-w-3xl px-5 pb-4"
            data-chat-virtual-key={itemKey(item)}
          >
            {renderVirtualItem(item)}
          </div>
        )}
        initialTopMostItemIndex={Math.max(0, virtualItems.length - 1)}
        increaseViewportBy={{ top: 800, bottom: 1200 }}
        overscan={400}
        followOutput={false}
        components={TIMELINE_VIRTUOSO_COMPONENTS}
      />
    );
    // jsdom has no layout engine, so Virtuoso cannot infer a viewport from the
    // real scroll parent during App integration tests. Its official mock
    // context supplies dimensions while preserving the same virtualized data,
    // keying and initial-tail behavior. Vite removes this branch from builds.
    return import.meta.env.MODE === "test" ? (
      <VirtuosoMockContext.Provider value={{ viewportHeight: 768, itemHeight: 96 }}>
        {virtualList}
      </VirtuosoMockContext.Provider>
    ) : virtualList;
  }

  // Tests/non-scroll surfaces keep a simple tree; production chat uses the
  // virtualized branch above.
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-5 py-8">
      {historyControl}
      {virtualItems.map((item) => (
        <div key={itemKey(item)} data-chat-virtual-key={itemKey(item)}>
          {renderVirtualItem(item)}
        </div>
      ))}
      {footer}
    </div>
  );
}
