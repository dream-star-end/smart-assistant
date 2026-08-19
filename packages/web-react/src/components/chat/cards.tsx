/**
 * P5 非工具卡（Aurora 全新设计）。消费 lib/chat/model.ts 的 ChatMessage，复用
 * Markdown / ui 原语 / 设计 token。tool 卡委托 ToolCardSlot（另一 agent 实现），
 * agent-group / permission 在各自文件。
 */
import {
  AlertTriangle,
  Brain,
  ChevronRight,
  Check,
  Copy,
  Info,
  ListTodo,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  MessageSquare,
  Quote,
  Square,
  Target,
  Type,
  Volume2,
  Wallet,
} from "lucide-react";
import { normalizeTurnErrorCode, turnErrorSemantics } from "@openclaude/protocol";
import { memo, useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../../lib/chat/model";
import {
  CONTINUE_PROMPT,
  childSignature,
  defaultCollapsed,
  errorPresentation,
  isLive,
  stripMarkdown,
} from "../../lib/chat/render";
import { thinkingSegments, thinkingSummaryTitle } from "../../lib/thinkingText";
import { cn, groupDigits } from "../../lib/utils";
import { Markdown } from "../Markdown";
import { OptionsGroupFooter, OptionsGroupProvider } from "../optionsGroup";
import { Alert, Avatar, Badge, Button, IconButton } from "../ui";
import { ChildBlockView, ProgressivePlainText } from "./AgentGroupCard";
import { Media } from "./media";
import { ResponseRatingCard } from "./ResponseRating";
import { TurnActivity, type TurnActivityInfo } from "./TurnActivity";
import {
  delegateTokenUsage,
  TokenUsageBadge,
  type DisplayTokenUsage,
} from "./tokenUsage";

/** 渲染上下文。turnActivity=当前活跃会话本轮活动快照（流式空正文分支的阶段反馈源）。*/
export type RenderCtx = {
  isLast: boolean;
  sending: boolean;
  turnActivity?: TurnActivityInfo | null;
  /** 是否属于当前活跃段(最后一条 user 之后)。与 sending 联合门控 MetaRow:团队模式下
   *  队长引擎收笔后 gateway 还要跑审查编排,积分/请求ID 尾注若此刻就出现会制造"回合已
   *  结束"的错觉(2026-07-07 boss 反馈)——终态帧到达(sending=false)才渲染。 */
  inActiveTurn?: boolean;
  /** 该行是否为「所在轮末条 assistant 正文」(轮边界判定收口在 turnSegment.ts)。仅它渲染
   *  评价反馈行 —— 一轮里穿插的中间文本回复不再各自带"这条回复怎么样?"(boss 07-11)。
   *  缺省 false(非 assistant / 单条兜底路径不渲染评价行,与历史一致)。 */
  turnFinalAssistant?: boolean;
  /** MessageList 以稳定 footer 独占本轮活动提示，避免 assistant/tool/thinking
   *  角色切换时反复挂卸同一行。单卡调用方缺省仍保留原行为。 */
  activityInFooter?: boolean;
};

/** 逐条反馈上下文（请求ID + 关联键 + 可见短摘录），由消息反馈弹窗按白名单消费。 */
export type FeedbackContext = {
  traceId: string | null;
  messageId: string;
  role: string;
  errorCode: string | null;
  textPreview: string;
};

export type CardCallbacks = {
  onRegenerate?: () => void;
  onContinue?: () => void;
  onTopUp?: () => void;
  onFeedback?: (ctx: FeedbackContext) => void;
  /** 重试一条发送失败的用户消息（复用原 payload 走既有发送入口原地重发）。*/
  onRetrySend?: (msg: ChatMessage) => void;
  /** Resume an executed interrupted turn as one new, deduplicated user turn. */
  onContinueInterrupted?: (error: ChatMessage) => void;
  /** Truthful checkpoint gate: original routing + durable process evidence. */
  resolveInterruptedContinuation?: (error: ChatMessage) => ChatMessage | undefined;
  /** 把 user / assistant 消息的精确快照带回 Composer。 */
  onQuote?: (msg: ChatMessage) => void;
  /** 按需读取并验证一条超大 immutable record；可能展开为多个 runtime events。 */
  onFetchTapeRecordPayload?: (
    tapeId: string,
    recordOrdinal: number,
    expected: { recordId: string; role: string; contentSha256?: string },
    signal?: AbortSignal,
  ) => Promise<ChatMessage[] | null>;
  /** 同一页面内已校验 tape payload；虚拟行 remount 首帧直接复用。 */
  onPeekTapeRecordPayload?: (
    tapeId: string,
    recordOrdinal: number,
    expected: { recordId: string; role: string; contentSha256?: string },
  ) => ChatMessage[] | null;
  /** 按需读取并校验一条超长 user 消息；不要求 tape id/ordinal。 */
  onFetchUserMessagePayload?: (
    messageId: string,
    expected: { recordId: string; role: string; contentSha256?: string },
    signal?: AbortSignal,
  ) => Promise<ChatMessage[] | null>;
  /** 同一页面内已校验 user payload；虚拟行 remount 首帧直接复用。 */
  onPeekUserMessagePayload?: (
    messageId: string,
    expected: { recordId: string; role: string; contentSha256?: string },
  ) => ChatMessage[] | null;
  /** 精确重试目标解析(红卡 CTA 硬门):按 assistant 错误行的 _clientMessageId 定位可原样重发的
   *  user 行(存在且 status==='error',带完整 payload)。找不到返回 undefined → 红卡不显示「重试」,
   *  回退 onRegenerate「重新尝试」。App 侧读当前会话 messages 实现,不进 message sig。 */
  resolveRetryTarget?: (clientMessageId: string) => ChatMessage | undefined;
};

function buildFeedbackCtx(m: ChatMessage): FeedbackContext {
  return {
    traceId: m.usage?.traceId ?? null,
    messageId: m.id,
    role: m.role,
    errorCode: m._errorCode ?? null,
    textPreview: (m.text || "").slice(0, 120),
  };
}

// ─── 复制按钮（富文本 / 纯文本） ───────────────────────────────────────
function CopyIconButton({
  getText,
  label,
  icon,
}: {
  getText: () => string;
  label: string;
  icon: React.ReactNode;
}) {
  const [done, setDone] = useState(false);
  return (
    <IconButton
      aria-label={label}
      title={label}
      size="sm"
      shape="square"
      className="[@media(hover:none)]:size-11"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(getText());
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard 不可用：静默 */
        }
      }}
    >
      {done ? <Check size={15} /> : icon}
    </IconButton>
  );
}

// ─── 请求ID 芯片 + 计费 meta ───────────────────────────────────────────
function ReqIdChip({ traceId }: { traceId: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={`请求ID ${traceId}（点击复制，用于反馈/排查）`}
      aria-label={`复制请求ID ${traceId}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(traceId);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* ignore */
        }
      }}
      className="inline-flex items-center gap-1 rounded-full bg-hover px-2 py-0.5 font-mono text-[11px] text-faint transition-colors hover:text-muted"
    >
      {copied ? <Check size={11} /> : null}
      {copied ? "已复制" : `#${traceId.slice(0, 8)}`}
    </button>
  );
}

function MetaRow({ msg }: { msg: ChatMessage }) {
  const traceId = msg.usage?.traceId;
  const credits = msg.usage?.costCredits;
  const waived = msg.usage?.waived === true;
  // 计费仅在有正向扣费时展示（"0"/负数/缺省不展示）；免单轮改展示「已免单」。
  const showCredits = !waived && credits && /^\d+$/.test(credits) && credits !== "0";
  if (!traceId && !showCredits && !waived) return null;
  return (
    <div className="mt-1.5 flex items-center gap-2 text-faint">
      {waived && (
        <Badge tone="success" aria-label="本轮已免单">
          <Wallet size={11} /> 已免单
        </Badge>
      )}
      {showCredits && (
        <Badge tone="neutral" aria-label={`消耗 ${credits} 积分`}>
          <Wallet size={11} /> {groupDigits(credits!)} 积分
        </Badge>
      )}
      {traceId && <ReqIdChip traceId={traceId} />}
    </div>
  );
}

// ─── 朗读（浏览器原生 SpeechSynthesis，无后端 TTS 依赖；不支持的浏览器整按钮隐藏） ───
function SpeakButton({ getText }: { getText: () => string }) {
  const [speaking, setSpeaking] = useState(false);
  const speechRun = useRef(0);
  const supported = typeof window !== "undefined" && "speechSynthesis" in window;
  // 卸载时停掉本条朗读，避免离开后还在念。
  useEffect(() => {
    return () => {
      speechRun.current += 1;
      if (supported) window.speechSynthesis.cancel();
    };
  }, [supported]);
  if (!supported) return null;
  const toggle = () => {
    const synth = window.speechSynthesis;
    if (speaking) {
      speechRun.current += 1;
      synth.cancel();
      setSpeaking(false);
      return;
    }
    const text = getText().trim();
    if (!text) return;
    const run = speechRun.current + 1;
    speechRun.current = run;
    synth.cancel(); // 停掉其它正在念的消息（全局单例）
    setSpeaking(true);
    const speakFrom = (start: number) => {
      if (speechRun.current !== run) return;
      if (start >= text.length) {
        setSpeaking(false);
        return;
      }
      let end = Math.min(start + 1_500, text.length);
      // 不在 UTF-16 代理对中间切块。块长只是浏览器队列的传输量子，不是总量上限。
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end -= 1;
      const utterance = new SpeechSynthesisUtterance(text.slice(start, end));
      utterance.lang = "zh-CN";
      utterance.onend = () => speakFrom(end);
      utterance.onerror = () => {
        if (speechRun.current === run) setSpeaking(false);
      };
      synth.speak(utterance);
    };
    speakFrom(0);
  };
  return (
    <IconButton
      aria-label={speaking ? "停止朗读" : "朗读"}
      title={speaking ? "停止朗读" : "朗读"}
      size="sm"
      shape="square"
      className="[@media(hover:none)]:size-11"
      onClick={toggle}
    >
      {speaking ? <Square size={14} className="fill-current" /> : <Volume2 size={15} />}
    </IconButton>
  );
}

// ─── 动作条（copy 富/纯 + 朗读 + 重新生成 + 反馈） ─────────────────────────────
function MessageActions({
  msg,
  cb,
  showRegen,
}: {
  msg: ChatMessage;
  cb: CardCallbacks;
  showRegen: boolean;
}) {
  return (
    <div className="mt-1.5 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
      <CopyIconButton getText={() => msg.text || ""} label="复制" icon={<Copy size={15} />} />
      <CopyIconButton
        getText={() => stripMarkdown(msg.text || "")}
        label="复制纯文本"
        icon={<Type size={15} />}
      />
      <SpeakButton getText={() => stripMarkdown(msg.text || "")} />
      {cb.onQuote && (
        <IconButton
          aria-label="引用"
          title="引用"
          size="sm"
          shape="square"
          className="[@media(hover:none)]:size-11"
          onClick={() => cb.onQuote?.(msg)}
        >
          <Quote size={15} />
        </IconButton>
      )}
      {showRegen && cb.onRegenerate && (
        <IconButton
          aria-label="重新生成"
          title="重新生成"
          size="sm"
          shape="square"
          className="[@media(hover:none)]:size-11"
          onClick={cb.onRegenerate}
        >
          <RotateCcw size={15} />
        </IconButton>
      )}
      {cb.onFeedback && (
        <IconButton
          aria-label="反馈"
          title="反馈"
          size="sm"
          shape="square"
          className="[@media(hover:none)]:size-11"
          onClick={() => cb.onFeedback?.(buildFeedbackCtx(msg))}
        >
          <MessageSquare size={15} />
        </IconButton>
      )}
    </div>
  );
}

// ═══════════════ user ═══════════════
const USER_STATUS_LABEL: Record<string, string> = {
  sending: "发送中",
  queued: "排队中",
  sent: "已送达",
  read: "已读",
  replied: "已回复",
  error: "发送失败",
};

function ReplyQuoteBlock({
  role,
  text,
}: {
  role: "user" | "assistant";
  text: string;
}) {
  return (
    <div
      className="mb-2 border-l-2 border-fg/20 pl-2.5 text-left text-fg/70"
      data-testid="message-reply-quote"
    >
      <div className="mb-0.5 text-[11px] font-medium">
        {role === "assistant" ? "OpenClaude" : "你"}
      </div>
      <div className="line-clamp-2 whitespace-pre-wrap break-words text-[12.5px] leading-5">
        {text}
      </div>
    </div>
  );
}
// 叶子卡一律不 memo:重渲防抖的唯一权威是上层 MessageRenderer 的 messageSignature 比较层。
// reducer/socket 对 msg 就地 mutate(同引用),叶子层 {msg} 浅比较要么永不重渲(状态标签
// 卡死在首帧,如 user status),要么因 ctx 每帧新对象而形同虚设 —— 三种 memo 策略并存徒增
// 认知负担。sig 层已捕获全部渲染所读字段(render.ts messageSignature),叶子直接裸函数。
export function UserCard({
  msg,
  cb,
  failurePresentedBelow = false,
}: {
  msg: ChatMessage;
  cb?: CardCallbacks;
  /** 同一轮已有可见终态错误卡时，错误说明与重试出口由该卡独占。 */
  failurePresentedBelow?: boolean;
}) {
  const status = msg.status;
  const showStatus = status && !(status === "error" && failurePresentedBelow);
  return (
    <div className="group flex flex-col items-end animate-in" data-testid="user-row">
      <div
        className="max-w-[78%] whitespace-pre-wrap break-words rounded-[20px] bg-bubble px-4 py-2.5 text-[15.5px] leading-relaxed text-fg"
        data-testid="message-text"
      >
        {msg._replyTo && (
          <ReplyQuoteBlock role={msg._replyTo.role} text={msg._replyTo.text} />
        )}
        {msg.text}
      </div>
      {msg._media && msg._media.length > 0 && (
        <Media media={msg._media} className="justify-end" />
      )}
      {showStatus && (
        <div
          className={cn(
            "mt-1 flex items-center gap-2 text-[11px]",
            status === "error" ? "text-danger" : "text-faint",
          )}
        >
          <span>{USER_STATUS_LABEL[status] ?? status}</span>
          {/* 发送失败 → 「重试」：复用原消息 payload（含附件引用）走既有发送入口原地重发。 */}
          {status === "error" && cb?.onRetrySend && (
            <button
              type="button"
              onClick={() => cb.onRetrySend?.(msg)}
              className="inline-flex items-center gap-1 rounded-full bg-danger-soft px-2 py-0.5 font-medium text-danger transition-colors hover:brightness-95 [@media(hover:none)]:min-h-11"
            >
              <RotateCcw size={11} /> 重试
            </button>
          )}
        </div>
      )}
      {status !== "sending" && status !== "queued" && status !== "error" && cb?.onQuote && (
        <div className="mt-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
          <IconButton
            aria-label="引用"
            title="引用"
            size="sm"
            shape="square"
            className="[@media(hover:none)]:size-11"
            onClick={() => cb.onQuote?.(msg)}
          >
            <Quote size={15} />
          </IconButton>
        </div>
      )}
    </div>
  );
}

/** Durable dispatch failure rendered as status, never as Agent-authored text. */
export function TurnStatusCard({
  msg,
  cb,
  currentTurn,
}: {
  msg: ChatMessage;
  cb: CardCallbacks;
  currentTurn: boolean;
}) {
  const presented = errorPresentation(msg._errorCode, "", msg._errorDetail, true);
  const retryTarget = msg._clientMessageId
    ? cb.resolveRetryTarget?.(msg._clientMessageId)
    : undefined;
  return (
    <div className="rounded-lg border border-warning/30 bg-warning/5 px-3.5 py-3 animate-in" role="status">
      <div className="flex items-start gap-2.5">
        <ShieldCheck size={16} className="mt-0.5 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-fg">{presented.title}</div>
          <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted">{presented.message}</div>
        </div>
        {currentTurn && retryTarget && cb.onRetrySend && (
          <Button size="sm" variant="secondary" shape="pill" onClick={() => cb.onRetrySend?.(retryTarget)}>
            <RotateCcw size={12} /> 重试
          </Button>
        )}
        {currentTurn && !retryTarget && cb.onRegenerate && (
          <Button size="sm" variant="secondary" shape="pill" onClick={cb.onRegenerate}>
            <RotateCcw size={12} /> 重新尝试
          </Button>
        )}
      </div>
    </div>
  );
}

const LONG_MARKDOWN_STEP = 128 * 1024;
const LIVE_MARKDOWN_TAIL = 64 * 1024;

function ProgressiveMarkdown({ text, live = false }: { text: string; live?: boolean }) {
  const [visibleChars, setVisibleChars] = useState(LONG_MARKDOWN_STEP);
  const headEnd = Math.min(visibleChars, text.length);
  const hasLiveGap = live && text.length > headEnd + LIVE_MARKDOWN_TAIL;
  const liveTailStart = hasLiveGap ? text.length - LIVE_MARKDOWN_TAIL : text.length;
  const primaryEnd = live && !hasLiveGap ? text.length : headEnd;
  return (
    <>
      <Markdown signMedia live={live}>{text.slice(0, primaryEnd)}</Markdown>
      {(hasLiveGap || (!live && headEnd < text.length)) && (
        <button
          type="button"
          onClick={() => setVisibleChars((value) => value + LONG_MARKDOWN_STEP)}
          className="mt-2 rounded-full bg-hover px-3 py-1 text-xs text-muted hover:text-fg"
        >
          {hasLiveGap
            ? `继续显示中间正文（还有 ${(liveTailStart - headEnd).toLocaleString()} 个字符）`
            : "继续显示正文"}
        </button>
      )}
      {hasLiveGap && <Markdown signMedia live>{text.slice(liveTailStart)}</Markdown>}
    </>
  );
}

// ═══════════════ assistant ═══════════════
export function AssistantCard({
  msg,
  ctx,
  cb,
  tokenUsage,
}: {
  msg: ChatMessage;
  ctx: RenderCtx;
  cb: CardCallbacks;
  tokenUsage?: DisplayTokenUsage;
}) {
  const live = isLive(msg, ctx);
  const hasError = !!msg._errorCode;
  const presentedError = hasError
    ? errorPresentation(msg._errorCode, msg.text, msg._errorDetail, msg.usage?.waived === true)
    : null;

  // ── 红卡重试 CTA 硬门(任务④)────────────────────────────────────────────────────
  // 语义(retryable/cta)从 protocol taxonomy 派生,不在组件里手写码判断。
  const normalizedCode = normalizeTurnErrorCode(msg._errorCode);
  const sem = turnErrorSemantics(normalizedCode);
  const expectedError = sem.expected === true;
  const errorTone = presentedError?.waived || expectedError ? "warning" : "danger";
  const isUserCancelled = normalizedCode === "stopped" || normalizedCode === "user_cancelled";
  const isInsufficient = normalizedCode === "insufficient_credits";
  // 「精确重试」资格:非免单 + 该码可重试 + cta∈{retry,retry_or_switch} + 会话内能定位到带完整
  // payload 的原 user 行(_clientMessageId 命中且 status='error')。任一不满足 → 不显示精确「重试」,
  // 落回原有 onRegenerate「重新尝试」兜底(现状语义)。
  const retryEligible =
    !!presentedError &&
    !presentedError.waived &&
    sem.retryable &&
    (sem.cta === "retry" || sem.cta === "retry_or_switch");
  const retryTarget =
    retryEligible && msg._clientMessageId
      ? cb.resolveRetryTarget?.(msg._clientMessageId)
      : undefined;
  // cta==='retry_or_switch'(容量类:同模型稍后可用,换模型立即可用)→ 按钮旁附「切换模型」引导。
  // 模型选择器为非受控 DropdownMenu,无可编程打开入口(见报告),故只留文案不做次按钮。
  const showSwitchModelHint =
    !!presentedError && !presentedError.waived && sem.cta === "retry_or_switch";
  // ── 重发按钮末轮门控(Codex 审计 R5)────────────────────────────────────────────────
  // onRegenerate 兜底 = 重发**最后一条** user 消息;历史中间错误卡若显示任何重发按钮,一点就把
  // 无关的最新一轮内容重发出去(精确重发亦会把历史消息插到当前会话尾,乱序)。故裁定:错误卡上的
  // 一切重发按钮(精确「重试」+ 兜底「重新尝试」+「切换模型」引导)只在**该错误卡属于最后一轮**时
  // 显示。末轮判据复用 turnSegment 单一权威 inActiveTurn(= 该行位于最后一条 user 之后 = 当前轮
  // 尾部;错误卡恒追加在其归属 user 轮之后,故与"_clientMessageId 命中最后一条 user"等价),不另
  // 造第二套轮判定。历史中间错误卡:不显示任何重发按钮(标题/正文/详情照旧)。
  // 「去充值」是导航非重发,不受此门控。
  const isLastTurn = ctx.inActiveTurn === true;
  const interruptedContinuationTarget =
    isLastTurn && ctx.isLast
      ? cb.resolveInterruptedContinuation?.(msg)
      : undefined;
  const showInterruptedContinuation =
    !!interruptedContinuationTarget && !!cb.onContinueInterrupted;
  const showPreciseRetry = !isInsufficient && isLastTurn && !!retryTarget;
  const showRegenFallback =
    !isInsufficient &&
    isLastTurn &&
    !showInterruptedContinuation &&
    !retryTarget &&
    (sem.cta === "retry" || sem.cta === "retry_or_switch") &&
    !!cb.onRegenerate;
  const showTopUp = isInsufficient && !!cb.onTopUp;
  const showActionRow =
    showTopUp ||
    showInterruptedContinuation ||
    showPreciseRetry ||
    showRegenFallback ||
    (isLastTurn && showSwitchModelHint);
  // Finalized immutable tapes may contain a deferred runtime batch after the
  // canonical assistant row. That transport row must still mount and decode,
  // but it must not take the current turn's regenerate action away from the
  // genuine final assistant. Direct/single-card callers retain the old
  // `isLast` fallback when no turn-final annotation is available.
  const showRegenerate = isLastTurn && (ctx.turnFinalAssistant ?? ctx.isLast);

  return (
    <div className="group flex gap-4 animate-in" data-testid="assistant-row">
      {/* 移动端隐藏助手头像:窄屏下头像+间距挤占正文宽度(boss 反馈),≥sm 才显示。 */}
      <Avatar tone="brand" className="mt-0.5 hidden shadow-sm sm:inline-flex">
        <Sparkles size={16} />
      </Avatar>
      <div className="min-w-0 flex-1">
        {msg.cronPush && (
          <div className="mb-1.5">
            <Badge tone="accent">
              <Info size={11} /> {msg.cronLabel || "定时推送"}
            </Badge>
          </div>
        )}

        {/* 正文：
            - 正常回复(无 error)→ Markdown 渲染 msg.text;
            - 失败轮但模型已产出**合法部分回答**(R6:errorPresentation.bodyText,已剥离尾部终止器/
              内部串)→ 同样 Markdown 正常渲染,红卡在其下方(与 live 双卡形态一致);终止器/JSON
              内部串类正文不进这里(bodyText 为空),只由下方红卡按码文案承载;
            - 流式已起但正文尚空 → 本轮活动指示取代裸三点。 */}
        {msg.text && !hasError ? (
          <OptionsGroupProvider live={live}>
            <ProgressiveMarkdown text={msg.text} live={live} />
            <OptionsGroupFooter />
          </OptionsGroupProvider>
        ) : hasError && !isUserCancelled && presentedError?.bodyText ? (
          <OptionsGroupProvider>
            <ProgressiveMarkdown text={presentedError.bodyText} />
            <OptionsGroupFooter />
          </OptionsGroupProvider>
        ) : live && !hasError && !ctx.activityInFooter ? (
          ctx.turnActivity ? <TurnActivity info={ctx.turnActivity} /> : <TypingDots />
        ) : null}
        {live && msg.text && !hasError && (
          <span className="caret-blink ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-[3px] bg-fg" />
        )}

        {/* 截断续写 banner */}
        {msg._truncated && !live && (
          <Alert tone="warning" className="mt-2.5" icon={<AlertTriangle size={16} />}>
            <div className="flex flex-1 flex-wrap items-center justify-between gap-2">
              <span>
                {msg._truncated === "pause_turn"
                  ? "模型暂停了本轮（通常因长任务超时），可让它继续。"
                  : "回复达到长度上限被截断，可让模型继续写。"}
              </span>
              {cb.onContinue && (
                <Button size="sm" variant="secondary" shape="pill" onClick={cb.onContinue}>
                  继续
                </Button>
              )}
            </div>
          </Alert>
        )}

        {/* 空轮提示。_emptyTurnTimeout 仅存量落库消息会命中（新代码不再产生此类消息，改用
            非持久 transient 软提示）；文案改诚实版：不再断言"无响应"，而是提示内容可能已在
            服务端生成、刷新/同步后可见，避免与真实内容同屏矛盾。 */}
        {msg._emptyTurn && (
          <Alert tone="info" className="mt-2.5" icon={<Info size={16} />}>
            {msg._emptyTurnTimeout
              ? "当时与服务器的连接中断，内容可能已在服务端生成（刷新或同步后可见）。"
              : "模型本轮没有产生新内容。"}
          </Alert>
        )}

        {/* 终态错误卡：自动免单用温和提示，不把平台 JSON/英文堆栈甩给用户。 */}
        {isUserCancelled ? (
          <output
            className="mt-2.5 flex items-center gap-2 py-1 text-[13px] text-muted"
            aria-label="已停止生成"
          >
            <Square size={14} className="shrink-0" />
            <span>已停止生成</span>
          </output>
        ) : presentedError && (
          <Alert
            tone={errorTone}
            density={expectedError && !presentedError.waived ? "compact" : "comfortable"}
            className="mt-2.5 max-w-full overflow-hidden"
            icon={presentedError.waived ? <ShieldCheck size={17} /> : <AlertTriangle size={17} />}
            title={presentedError.title}
          >
            <div className="min-w-0">
              <p className="text-[13px] leading-5 text-fg/90 [overflow-wrap:anywhere]">
                {presentedError.message}
              </p>
              {presentedError.detail && (
                <details className="mt-1.5 max-w-full">
                  <summary className="w-fit cursor-pointer select-none text-xs text-muted hover:text-fg">
                    查看请求信息
                  </summary>
                  <pre className="mt-1.5 max-h-28 max-w-full overflow-auto whitespace-pre-wrap rounded-md bg-code px-2.5 py-2 text-[11px] text-muted [overflow-wrap:anywhere]">
                    {presentedError.detail}
                  </pre>
                </details>
              )}
              {showActionRow && (
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  {showTopUp ? (
                    // insufficient_credits「去充值」= 导航非重发,不受末轮门控。
                    <Button size="sm" variant="accent" shape="pill" onClick={cb.onTopUp}>
                      <Wallet size={14} /> 去充值
                    </Button>
                  ) : showInterruptedContinuation ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      shape="pill"
                      onClick={() => cb.onContinueInterrupted?.(msg)}
                    >
                      <RotateCcw size={14} /> 从断点继续
                    </Button>
                  ) : showPreciseRetry ? (
                    // 末轮 + 精确路径可用:优先精确重发原轮(复用原 payload 含附件),不走 onRegenerate。
                    <Button
                      size="sm"
                      variant="secondary"
                      shape="pill"
                      onClick={() => cb.onRetrySend?.(retryTarget!)}
                    >
                      <RotateCcw size={14} /> 重试
                    </Button>
                  ) : showRegenFallback ? (
                    // 末轮 + 精确路径不可用(找不到原 user 行 / 不可重试码)→ onRegenerate 兜底。
                    <Button size="sm" variant="secondary" shape="pill" onClick={cb.onRegenerate}>
                      <RotateCcw size={14} /> 重新尝试
                    </Button>
                  ) : null}
                  {isLastTurn && showSwitchModelHint && (
                    <span className="text-xs text-muted">或在上方切换模型后重试</span>
                  )}
                </div>
              )}
            </div>
          </Alert>
        )}

        {!isUserCancelled && tokenUsage && tokenUsage.totalTokens > 0 && (
          <div className="mt-2">
            <TokenUsageBadge usage={tokenUsage} />
          </div>
        )}
        {/* 动作条 + meta（流式中不显示动作条，避免抖动） */}
        {!live && !hasError && msg.text && (
          <MessageActions msg={msg} cb={cb} showRegen={showRegenerate && !hasError} />
        )}
        {!live && !isUserCancelled && !(ctx.sending && ctx.inActiveTurn) && <MetaRow msg={msg} />}
        {/* 逐条评价反馈行(极轻,常驻):仅对有正文、非 error 的 assistant 回复出现,且**只挂在
            所在轮的末条 assistant 正文上**(turnFinalAssistant,轮边界判定在 turnSegment.ts)——
            一轮里穿插工具卡/思考卡/委派的多段中间文本回复不再各自带"这条回复怎么样?"(boss 07-11)。
            其余门控与 MetaRow 一致(流式中 / 团队编排未终态时不出);历史各轮末条各自可评。
            未登录/demo 由卡内 Context 兜底隐藏。 */}
        {!live && !hasError && !!msg.text && ctx.turnFinalAssistant && !(ctx.sending && ctx.inActiveTurn) && (
          <ResponseRatingCard messageId={msg.id} traceId={msg.usage?.traceId ?? null} />
        )}
      </div>
    </div>
  );
}

function TypingDots() {
  return (
    <div className="flex items-center gap-1.5 py-1 text-muted" aria-label="生成中">
      <span className="size-2 animate-pulse rounded-full bg-muted" />
      <span className="size-2 animate-pulse rounded-full bg-muted [animation-delay:200ms]" />
      <span className="size-2 animate-pulse rounded-full bg-muted [animation-delay:400ms]" />
    </div>
  );
}
export { TypingDots };

// ═══════════════ thinking（💭 折叠，多段合并） ═══════════════
// **连续的 role=thinking 行由渲染层(MessageRenderer.coalesceTeam)合并成一组**传入 `msgs`：
// 每条消息一段，逐段 sanitize（剥 `<!-- -->` 噪音）、丢空段，正文走仓内 Markdown（`**标题**`
// 渲染为粗体而非裸星号，色/字号收敛到 muted）。折叠态标题取最新段首个粗体标题作摘要。
// memo 比较键 = sig（组内各成员签名拼接，编入文本 + 流式态），reducer 就地 mutate 下防漏渲/防闪。
export const ThinkingCard = memo(
  function ThinkingCard({
    msgs,
    ctx,
    tokenUsage,
  }: {
    msgs: ChatMessage[];
    ctx: RenderCtx;
    tokenUsage?: DisplayTokenUsage;
    /** 分组渲染签名(memo 比较键)。所有调用方必须传，否则 memo 会误判为无变化。*/
    sig?: string;
  }) {
    // 组内任一行流式中 → 整卡"思考中"。thinking 的 isLive 只看 isLast&&sending（末条 thinking
    // 才可能在流；被后续内容挤下末位的 thinking 自动转完成态），故取组末条判定即代表整组。
    const live = isLive(msgs[msgs.length - 1] ?? { role: "thinking" }, ctx);
    const [userCollapsed, setUserCollapsed] = useState<boolean | null>(null);
    // 默认折叠态权威仍走 render 层 defaultCollapsed（thinking：流式展开、完成折叠）；用户手动切换后本地锁定。
    const collapsed = userCollapsed ?? defaultCollapsed({ role: "thinking" }, ctx);
    const segments = thinkingSegments(msgs.map((m) => m.text));
    // 折叠态摘要：完成后取最新段首个粗体标题；流式中保持稳定的"思考过程"
    // （不随 delta/角色切换闪烁）。
    const summary = live ? null : thinkingSummaryTitle(segments);
    const headline = live ? "思考过程" : summary ? `已思考 · ${summary}` : "已思考";
    return (
      <div className="rounded-lg border border-border bg-surface/60 animate-in">
        <button
          type="button"
          onClick={() => setUserCollapsed(!collapsed)}
          className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-[13px] text-muted hover:bg-hover"
        >
          <Brain size={14} className="shrink-0 text-faint" />
          <span className="min-w-0 truncate font-medium" title={headline}>
            {headline}
          </span>
          <TokenUsageBadge usage={tokenUsage} />
          <ChevronRight
            size={14}
            className={cn("ml-auto shrink-0 text-faint transition-transform", !collapsed && "rotate-90")}
          />
        </button>
        {!collapsed && segments.length > 0 && (
          <div className="border-t border-border px-3.5 py-2.5">
            {segments.map((seg, i) => (
              <div
                key={i}
                className={cn(
                  // muted 色 + 13.5px 收敛 prose 到思考卡语境；段间轻分隔线。
                  // strong 压平(boss 07-11:黑粗体与思考卡低调气质不搭):codex 摘要通篇是
                  // `**标题**`,prose 默认 strong 近黑加粗喧宾夺主 → 收敛为 font-medium + 继承
                  // muted 色,只留轻微强调;标题信息已由折叠态摘要承载,正文不需要重锤。
                  "text-[13.5px] leading-relaxed text-muted [&_.prose]:text-[13.5px] [&_.prose]:leading-relaxed [&_.prose]:text-inherit [&_.prose_p]:mb-1.5 [&_.prose_p:last-child]:mb-0 [&_.prose_strong]:font-medium [&_.prose_strong]:text-inherit [&_.prose_h1]:text-[13.5px] [&_.prose_h2]:text-[13.5px] [&_.prose_h3]:text-[13.5px] [&_.prose_h1]:font-medium [&_.prose_h2]:font-medium [&_.prose_h3]:font-medium [&_.prose_h1]:text-inherit [&_.prose_h2]:text-inherit [&_.prose_h3]:text-inherit",
                  i > 0 && "mt-2.5 border-t border-border/60 pt-2.5",
                )}
              >
                <ProgressiveMarkdown text={seg} live={live} />
              </div>
            ))}
            {live && (
              <span className="caret-blink ml-0.5 inline-block h-[1em] w-[2px] translate-y-[2px] bg-muted" />
            )}
          </div>
        )}
      </div>
    );
  },
  (a, b) =>
    a.sig === b.sig &&
    a.tokenUsage?.totalTokens === b.tokenUsage?.totalTokens,
);

// ═══════════════ plan ═══════════════
const STEP_DOT: Record<string, string> = {
  completed: "bg-success",
  inProgress: "bg-accent animate-pulse",
  pending: "bg-faint",
};
// 不外包 memo:只收 {msg} + reducer 就地 mutate → 默认浅比较永不重渲(plan 步骤流式更新会丢)。
// 重渲由上层 MessageRenderer 的 messageSignature memo 把关。
export function PlanCard({
  msg,
  tokenUsage,
}: {
  msg: ChatMessage;
  tokenUsage?: DisplayTokenUsage;
}) {
  const steps = (msg.steps ?? []).filter(
    (s): s is { step: string; status: "pending" | "inProgress" | "completed" } =>
      !!s && typeof s === "object" && typeof s.step === "string" && typeof s.status === "string",
  );
  return (
    <div className="rounded-lg border border-border bg-surface animate-in">
      <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
        <span className="flex size-6 items-center justify-center rounded-md bg-accent-soft text-accent">
          <ListTodo size={14} />
        </span>
        <span
          className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg"
          title={msg.text || "执行计划"}
        >
          {msg.text || "执行计划"}
        </span>
        <TokenUsageBadge usage={tokenUsage} />
        {msg._partial && <Badge tone="accent">编制中</Badge>}
      </div>
      <div className="px-3.5 py-2.5">
        {msg.explanation && (
          <p className="mb-2 text-[13px] leading-relaxed text-muted">{msg.explanation}</p>
        )}
        <ol className="space-y-1.5">
          {steps.map((s, i) => (
            <li key={i} className="flex items-start gap-2.5 text-[13.5px] text-fg">
              <span className={cn("mt-[7px] size-2 shrink-0 rounded-full", STEP_DOT[s.status] ?? "bg-faint")} />
              <span className={cn("leading-relaxed", s.status === "completed" && "text-muted line-through")}>
                {s.step}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

// Engine diagnostic record. Platform controls and authoritative budgets
// live in the goal dialog opened from the composer "+" menu; this row simply
// makes native goal updates visible and updates in place through its stable block id.
export function GoalCard({ msg }: { msg: ChatMessage }) {
  const status = msg.cleared ? "已清除" : msg.goalStatus || "已同步";
  return (
    <div className="rounded-lg border border-border bg-surface px-3.5 py-3 animate-in">
      <div className="flex items-center gap-2">
        <span className="flex size-6 items-center justify-center rounded-md bg-accent-soft text-accent"><Target size={14} /></span>
        <span className="text-[13px] font-medium text-fg">{msg.text || "会话目标"}</span>
        <Badge tone={msg.cleared ? "neutral" : "accent"}>{status}</Badge>
      </div>
      {!msg.cleared && (
        <p className="mt-2 text-[11.5px] text-muted tabular-nums">
          Token {groupDigits(String(msg.tokensUsed ?? 0))}{msg.tokenBudget == null ? "" : ` / ${groupDigits(String(msg.tokenBudget))}`}
          {typeof msg.timeUsedSeconds === "number" ? ` · ${msg.timeUsedSeconds}s` : ""}
        </p>
      )}
    </div>
  );
}

// ═══════════════ delegate-progress（委派进度兜底卡） ═══════════════
// 不外包 memo(同 PlanCard:就地 mutate + {msg} 会永不重渲)。可折叠:进行中默认展开(看实时进度)、
// 完成默认折叠(收成一行摘要),与 AgentGroupCard 同款头部 chevron 交互;用户点击后本地锁定。
export function DelegateProgressCard({ msg }: { msg: ChatMessage }) {
  const entries = msg.entries ?? [];
  const children = msg.childBlocks ?? [];
  const done = !!msg._completed;
  const [userCollapsed, setUserCollapsed] = useState<boolean | null>(null);
  const [visibleChildren, setVisibleChildren] = useState(100);
  const [visibleEntries, setVisibleEntries] = useState(100);
  const collapsed = userCollapsed ?? done;
  const tokenUsage = delegateTokenUsage(msg);
  return (
    <div className="rounded-lg border border-border bg-surface animate-in">
      <button
        type="button"
        onClick={() => setUserCollapsed(!collapsed)}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left hover:bg-hover"
      >
        <span className="flex size-6 items-center justify-center rounded-md bg-accent-soft text-accent">
          <Sparkles size={13} />
        </span>
        <span className="min-w-0 truncate text-[13px] font-medium text-fg">{msg.text || "委派子任务"}</span>
        <span className="ml-auto flex items-center gap-2">
          <TokenUsageBadge usage={tokenUsage} label="子 Agent 合计" />
          {done ? (
            <Badge tone={msg._isError ? "danger" : "success"}>{msg._isError ? "失败" : "完成"}</Badge>
          ) : (
            <Badge tone="accent">进行中</Badge>
          )}
          <ChevronRight
            size={15}
            className={cn("text-faint transition-transform", !collapsed && "rotate-90")}
          />
        </span>
      </button>
      {!collapsed && children.length > 0 && (
        <div className="space-y-2 border-t border-border px-3.5 py-2.5">
          {children.slice(0, visibleChildren).map((ch, i) => (
            <ChildBlockView
              key={`${i}-${ch.blockId ?? ch.kind}`}
              child={ch}
              sig={childSignature(ch)}
              tokenUsage={tokenUsage}
            />
          ))}
          {visibleChildren < children.length && (
            <button
              type="button"
              onClick={() => setVisibleChildren((value) => value + 100)}
              className="mx-auto block rounded-full bg-hover px-3 py-1 text-xs text-muted hover:text-fg"
            >
              继续加载过程（还有 {children.length - visibleChildren} 条）
            </button>
          )}
        </div>
      )}
      {!collapsed && entries.length > 0 && (
        <ul className="border-t border-border px-3.5 py-2 text-[12.5px] text-muted">
          {entries.slice(0, visibleEntries).map((e, i) => (
            <li key={i} className="whitespace-pre-wrap break-words">
              <span className="text-faint">[{e.phase}]</span> {e.text}
            </li>
          ))}
          {visibleEntries < entries.length && (
            <li>
              <button
                type="button"
                onClick={() => setVisibleEntries((value) => value + 100)}
                className="mx-auto mt-2 block rounded-full bg-hover px-3 py-1 text-xs text-muted hover:text-fg"
              >
                继续加载委派记录（还有 {entries.length - visibleEntries} 条）
              </button>
            </li>
          )}
        </ul>
      )}
      {!collapsed && done && msg.summary && (
        <ProgressivePlainText
          text={msg.summary}
          className="border-t border-border px-3.5 py-2 text-[12.5px] text-muted"
        />
      )}
      {/* 折叠态展示结果摘要（完成后）——与 AgentGroupCard 折叠页脚一致。 */}
      {collapsed && done && msg.summary && (
        <div className="flex items-start gap-1.5 border-t border-border px-3.5 py-2 text-[12.5px] text-muted">
          <Check size={13} className="mt-0.5 shrink-0 text-success" />
          <span className="line-clamp-2">
            {msg.summary.slice(0, 500)}{msg.summary.length > 500 ? "…" : ""}
          </span>
        </div>
      )}
    </div>
  );
}

// ═══════════════ system ═══════════════
export function SystemCard({ msg }: { msg: ChatMessage }) {
  if (!msg.text) return null;
  return (
    <div className="flex justify-center animate-in">
      <div className="max-w-full whitespace-pre-wrap break-words rounded-xl bg-hover px-3 py-1.5 text-left text-[12px] leading-relaxed text-faint sm:max-w-[80%] sm:text-center">
        {msg.text}
      </div>
    </div>
  );
}
