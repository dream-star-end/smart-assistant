/**
 * P5 非工具卡（Aurora 全新设计）。消费 lib/chat/model.ts 的 ChatMessage，复用
 * Markdown / ui 原语 / 设计 token。tool 卡委托 ToolCardSlot（另一 agent 实现），
 * agent-group / permission 在各自文件。
 */
import {
  AlertTriangle,
  Brain,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Check,
  Copy,
  FileText,
  Info,
  ListTodo,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  MessageSquare,
  Square,
  Target,
  Type,
  Volume2,
  Wallet,
} from "lucide-react";
import { memo, useEffect, useState } from "react";
import type { ChatMessage } from "../../lib/chat/model";
import {
  CONTINUE_PROMPT,
  childSignature,
  defaultCollapsed,
  errorPresentation,
  formatTapeBytes,
  isLive,
  stripMarkdown,
} from "../../lib/chat/render";
import { thinkingSegments, thinkingSummaryTitle } from "../../lib/thinkingText";
import { cn, groupDigits } from "../../lib/utils";
import { Markdown } from "../Markdown";
import { Alert, Avatar, Badge, Button, IconButton, Spinner } from "../ui";
import { ChildBlockView } from "./AgentGroupCard";
import { Media } from "./media";
import { ResponseRatingCard } from "./ResponseRating";
import { TurnActivity, type TurnActivityInfo } from "./TurnActivity";

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
};

/** 逐条反馈上下文（请求ID + 关联键）。P6 反馈弹窗消费；本期由 App 兜底。 */
export type FeedbackContext = {
  traceId: string | null;
  messageId: string;
  role: string;
  errorCode: string | null;
  textPreview: string;
};

export type TapeRecordsResult = {
  records: ChatMessage[];
  nextCursor: number | null;
  total: number;
} | null;

export type CardCallbacks = {
  onRegenerate?: () => void;
  onContinue?: () => void;
  onTopUp?: () => void;
  onFeedback?: (ctx: FeedbackContext) => void;
  /** 重试一条发送失败的用户消息（复用原 payload 走既有发送入口原地重发）。*/
  onRetrySend?: (msg: ChatMessage) => void;
  /**
   * §9 展开折叠卷:拉一页投影记录并就地展开(cursor=null 首页,续拉传上次 nextCursor)。返回结果
   * 供折叠卡管理 loading/error 局部态。缺省(demo/只读/未接线)→ 折叠卡为静态摘要,不可展开。
   */
  onExpandTape?: (
    anchorId: string,
    tapeId: string,
    cursor: number | null,
  ) => Promise<{ ok: boolean; nextCursor?: number | null; error?: boolean; busy?: boolean }>;
  /** §9 收起折叠卷(纯本地,抹展开行还原折叠态)。 */
  onCollapseTape?: (anchorId: string) => void;
  /** §9 截断记录"查看完整":原样拉一页 tape 记录供内联抽屉显示更完整版本(不改会话内存)。 */
  onFetchTapeRecords?: (tapeId: string, cursor: number | null) => Promise<TapeRecordsResult>;
  /** §9(M-§9-1)单条超大记录分块读(ToolCard 查看完整真通路)。 */
  onFetchTapeRecordChunk?: (
    tapeId: string,
    recordOrdinal: number,
    offset: number,
  ) => Promise<{ chunk: string; nextOffset: number | null; totalBytes: number } | null>;
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
  const supported = typeof window !== "undefined" && "speechSynthesis" in window;
  // 卸载时停掉本条朗读，避免离开后还在念。
  useEffect(() => {
    return () => {
      if (supported && speaking) window.speechSynthesis.cancel();
    };
  }, [supported, speaking]);
  if (!supported) return null;
  const toggle = () => {
    const synth = window.speechSynthesis;
    if (speaking) {
      synth.cancel();
      setSpeaking(false);
      return;
    }
    const text = getText().slice(0, 4000).trim();
    if (!text) return;
    synth.cancel(); // 停掉其它正在念的消息（全局单例）
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "zh-CN";
    u.onend = () => setSpeaking(false);
    u.onerror = () => setSpeaking(false);
    setSpeaking(true);
    synth.speak(u);
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
// 叶子卡一律不 memo:重渲防抖的唯一权威是上层 MessageRenderer 的 messageSignature 比较层。
// reducer/socket 对 msg 就地 mutate(同引用),叶子层 {msg} 浅比较要么永不重渲(状态标签
// 卡死在首帧,如 user status),要么因 ctx 每帧新对象而形同虚设 —— 三种 memo 策略并存徒增
// 认知负担。sig 层已捕获全部渲染所读字段(render.ts messageSignature),叶子直接裸函数。
export function UserCard({ msg, cb }: { msg: ChatMessage; cb?: CardCallbacks }) {
  const status = msg.status;
  return (
    <div className="flex flex-col items-end animate-in" data-testid="user-row">
      <div
        className="max-w-[78%] whitespace-pre-wrap break-words rounded-[20px] bg-bubble px-4 py-2.5 text-[15.5px] leading-relaxed text-fg"
        data-testid="message-text"
      >
        {msg.text}
      </div>
      {msg._media && msg._media.length > 0 && (
        <Media media={msg._media} className="justify-end" />
      )}
      {status && (
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
    </div>
  );
}

// ═══════════════ §9 折叠卷卡(CollapseCard)═══════════════
/**
 * 折叠 anchor 行渲染(RFC §9.1)。大 tape 投影超上限时 server 只回一条折叠 anchor;本卡是该轮内容的
 * **入口**而非正文——折叠态显示"本轮完整输出 N MB，点击加载",点击经 cb.onExpandTape 拉取投影记录
 * 就地展开(展开行由 MessageList 作为独立卡渲染在本卡之后)。展开后本卡收缩成**分节头**:承载"收起"
 * 与"继续加载更多"(分页游标 `_tapeExpandCursor` 非 null 时)。
 *
 * 终态存在证据(_dispatchOutcome 终态)只影响清发送态/抑制 error projection(见 render/persist),
 * 与本卡渲染正交;本卡不挂评分卡/MetaRow(折叠行非"末条 assistant 正文")。
 */
export function CollapseCard({ msg, cb }: { msg: ChatMessage; cb: CardCallbacks }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const expanded = msg._tapeExpanded === true;
  const hasMore = typeof msg._tapeExpandCursor === "number"; // number 游标=还有下一页;null/undefined=已拉全
  const sizeLabel = formatTapeBytes(msg._tapeTotalBytes) || "较大内容";
  const tapeId = msg._turnTapeId;
  const canExpand = !!cb.onExpandTape && typeof tapeId === "string" && tapeId.length > 0;

  const doExpand = async (cursor: number | null) => {
    if (!cb.onExpandTape || !tapeId || loading) return;
    setLoading(true);
    setError(false);
    try {
      const res = await cb.onExpandTape(msg.id, tapeId, cursor);
      if (!res.ok && res.error) setError(true);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  if (!expanded) {
    return (
      <div className="animate-in" data-testid="collapse-card">
        <button
          type="button"
          onClick={() => void doExpand(null)}
          disabled={loading || !canExpand}
          aria-busy={loading}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-lg border border-border bg-surface px-3.5 py-2.5 text-left text-[13px] transition-colors",
            canExpand && !loading ? "cursor-pointer hover:bg-hover" : "cursor-default",
          )}
        >
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-hover text-muted">
            {loading ? <Spinner size={13} /> : <FileText size={13} />}
          </span>
          <span className="min-w-0 flex-1 text-fg/90">
            {loading
              ? "正在加载完整输出…"
              : error
                ? "加载失败，点击重试"
                : `本轮完整输出 ${sizeLabel}${canExpand ? "，点击加载" : ""}`}
          </span>
          {!loading && canExpand && <ChevronDown size={15} className="shrink-0 text-faint" />}
        </button>
      </div>
    );
  }

  // 展开态:分节头(收起 / 继续加载 / 卷级截断提示)。展开行由 MessageList 渲染在本卡之后。
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border bg-hover/40 px-3.5 py-2 text-xs text-muted">
      <FileText size={13} className="shrink-0" />
      <span className="min-w-0">本轮完整输出 {sizeLabel} · 已展开</span>
      {hasMore && (
        <Button
          size="sm"
          variant="secondary"
          shape="pill"
          onClick={() => void doExpand(msg._tapeExpandCursor ?? null)}
          disabled={loading}
        >
          {loading ? <Spinner size={12} /> : "继续加载更多"}
        </Button>
      )}
      {cb.onCollapseTape && (
        <button
          type="button"
          onClick={() => cb.onCollapseTape?.(msg.id)}
          className="ml-auto rounded-full px-2 py-0.5 text-muted hover:text-fg [@media(hover:none)]:min-h-9 [@media(hover:none)]:py-2"
        >
          收起
        </button>
      )}
      {msg._projectionTruncated && (
        <span className="basis-full text-[11px] text-faint">内容较多，部分记录已省略（仅展示投影上限内的记录）。</span>
      )}
      {error && <span className="basis-full text-[11px] text-danger">加载失败，请重试。</span>}
    </div>
  );
}

// ═══════════════ assistant ═══════════════
export function AssistantCard({
  msg,
  ctx,
  cb,
}: {
  msg: ChatMessage;
  ctx: RenderCtx;
  cb: CardCallbacks;
}) {
  const live = isLive(msg, ctx);
  const hasError = !!msg._errorCode;
  const presentedError = hasError
    ? errorPresentation(msg._errorCode, msg.text, msg._errorDetail, msg.usage?.waived === true)
    : null;

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

        {/* 正文：错误时不在卡外渲染裸正文(友好文案并入下方红卡),避免"server shutting down"式裸文本 */}
        {msg.text && !hasError ? (
          <Markdown signMedia live={live}>
            {msg.text}
          </Markdown>
        ) : live && !hasError ? (
          // 流式已起但正文尚空：用本轮活动指示（阶段反馈）取代裸三个点；无活动快照时回退三点。
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
        {presentedError && (
          <Alert
            tone={presentedError.waived ? "warning" : "danger"}
            className="mt-2.5 max-w-full overflow-hidden px-3.5 py-3 sm:px-4"
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
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                {msg._errorCode?.toLowerCase() === "insufficient_credits" && cb.onTopUp && (
                  <Button size="sm" variant="accent" shape="pill" onClick={cb.onTopUp}>
                    <Wallet size={14} /> 去充值
                  </Button>
                )}
                {msg._errorCode?.toLowerCase() !== "insufficient_credits" && cb.onRegenerate && (
                  <Button size="sm" variant="secondary" shape="pill" onClick={cb.onRegenerate}>
                    <RotateCcw size={14} /> 重新尝试
                  </Button>
                )}
              </div>
            </div>
          </Alert>
        )}

        {/* 动作条 + meta（流式中不显示动作条，避免抖动） */}
        {!live && !hasError && msg.text && (
          <MessageActions msg={msg} cb={cb} showRegen={ctx.isLast && !hasError} />
        )}
        {!live && !(ctx.sending && ctx.inActiveTurn) && <MetaRow msg={msg} />}
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
  }: {
    msgs: ChatMessage[];
    ctx: RenderCtx;
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
    // 折叠态摘要：完成后取最新段首个粗体标题；流式中保持"思考中…"（避免摘要随 delta 抖动）。
    const summary = live ? null : thinkingSummaryTitle(segments);
    const headline = live ? "思考中…" : summary ? `已思考 · ${summary}` : "已思考";
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
                <Markdown>{seg}</Markdown>
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
  (a, b) => a.sig === b.sig,
);

// ═══════════════ plan ═══════════════
const STEP_DOT: Record<string, string> = {
  completed: "bg-success",
  inProgress: "bg-accent animate-pulse",
  pending: "bg-faint",
};
// 不外包 memo:只收 {msg} + reducer 就地 mutate → 默认浅比较永不重渲(plan 步骤流式更新会丢)。
// 重渲由上层 MessageRenderer 的 messageSignature memo 把关。
export function PlanCard({ msg }: { msg: ChatMessage }) {
  const steps = msg.steps ?? [];
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

// Engine diagnostic projection. Platform controls and authoritative budgets
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
  const collapsed = userCollapsed ?? done;
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
          {children.map((ch, i) => (
            <ChildBlockView key={`${i}-${ch.blockId ?? ch.kind}`} child={ch} sig={childSignature(ch)} />
          ))}
        </div>
      )}
      {!collapsed && entries.length > 0 && (
        <ul className="border-t border-border px-3.5 py-2 text-[12.5px] text-muted">
          {entries.slice(-6).map((e, i) => (
            <li key={i} className="line-clamp-2 break-words" title={`[${e.phase}] ${e.text}`}>
              <span className="text-faint">[{e.phase}]</span> {e.text}
            </li>
          ))}
        </ul>
      )}
      {!collapsed && done && msg.summary && (
        <div className="border-t border-border px-3.5 py-2 text-[12.5px] text-muted">{msg.summary}</div>
      )}
      {/* 折叠态展示结果摘要（完成后）——与 AgentGroupCard 折叠页脚一致。 */}
      {collapsed && done && msg.summary && (
        <div className="flex items-start gap-1.5 border-t border-border px-3.5 py-2 text-[12.5px] text-muted">
          <Check size={13} className="mt-0.5 shrink-0 text-success" />
          <span className="line-clamp-2">{msg.summary}</span>
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
