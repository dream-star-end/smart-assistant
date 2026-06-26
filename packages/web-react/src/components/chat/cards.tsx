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
  Sparkles,
  MessageSquare,
  Type,
  Wallet,
} from "lucide-react";
import { memo, useState } from "react";
import type { ChatMessage } from "../../lib/chat/model";
import {
  CONTINUE_PROMPT,
  defaultCollapsed,
  errorLabel,
  isLive,
  stripMarkdown,
} from "../../lib/chat/render";
import { cn, groupDigits } from "../../lib/utils";
import { Markdown } from "../Markdown";
import { Alert, Avatar, Badge, Button, IconButton } from "../ui";
import { Media } from "./media";

export type RenderCtx = { isLast: boolean; sending: boolean };

/** 逐条反馈上下文（请求ID + 关联键）。P6 反馈弹窗消费；本期由 App 兜底。 */
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
  // 计费仅在有正向扣费时展示（"0"/负数/缺省不展示）。
  const showCredits = credits && /^\d+$/.test(credits) && credits !== "0";
  if (!traceId && !showCredits) return null;
  return (
    <div className="mt-1.5 flex items-center gap-2 text-faint">
      {showCredits && (
        <Badge tone="neutral" aria-label={`消耗 ${credits} 积分`}>
          <Wallet size={11} /> {groupDigits(credits!)} 积分
        </Badge>
      )}
      {traceId && <ReqIdChip traceId={traceId} />}
    </div>
  );
}

// ─── 动作条（copy 富/纯 + 重新生成 + 反馈） ─────────────────────────────
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
    <div className="mt-1.5 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
      <CopyIconButton getText={() => msg.text || ""} label="复制" icon={<Copy size={15} />} />
      <CopyIconButton
        getText={() => stripMarkdown(msg.text || "")}
        label="复制纯文本"
        icon={<Type size={15} />}
      />
      {showRegen && cb.onRegenerate && (
        <IconButton aria-label="重新生成" title="重新生成" size="sm" shape="square" onClick={cb.onRegenerate}>
          <RotateCcw size={15} />
        </IconButton>
      )}
      {cb.onFeedback && (
        <IconButton
          aria-label="反馈"
          title="反馈"
          size="sm"
          shape="square"
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
export const UserCard = memo(function UserCard({ msg }: { msg: ChatMessage }) {
  const status = msg.status;
  return (
    <div className="flex flex-col items-end animate-in">
      <div className="max-w-[78%] whitespace-pre-wrap break-words rounded-[20px] bg-bubble px-4 py-2.5 text-[15.5px] leading-relaxed text-fg">
        {msg.text}
      </div>
      {msg._media && msg._media.length > 0 && (
        <Media media={msg._media} className="justify-end" />
      )}
      {status && (
        <div
          className={cn(
            "mt-1 text-[11px]",
            status === "error" ? "text-danger" : "text-faint",
          )}
        >
          {USER_STATUS_LABEL[status] ?? status}
        </div>
      )}
    </div>
  );
});

// ═══════════════ assistant ═══════════════
export const AssistantCard = memo(function AssistantCard({
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

  return (
    <div className="group flex gap-4 animate-in">
      <Avatar tone="brand" className="mt-0.5 shadow-sm">
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

        {/* 正文（错误卡时不渲染空正文） */}
        {msg.text ? (
          <Markdown signMedia>{msg.text}</Markdown>
        ) : live && !hasError ? (
          <TypingDots />
        ) : null}
        {live && msg.text && (
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

        {/* 空轮提示 */}
        {msg._emptyTurn && (
          <Alert tone="info" className="mt-2.5" icon={<Info size={16} />}>
            {msg._emptyTurnTimeout
              ? "本轮模型无响应（超时），可重试。"
              : "模型本轮没有产生新内容。"}
          </Alert>
        )}

        {/* 错误红卡 */}
        {hasError && (
          <Alert tone="danger" className="mt-2.5" icon={<AlertTriangle size={16} />}>
            <div className="min-w-0 flex-1">
              <div className="font-medium">{errorLabel(msg._errorCode)}</div>
              {msg._errorDetail && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs text-muted">查看详情</summary>
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-code px-2 py-1.5 text-[11px] text-muted">
                    {msg._errorDetail}
                  </pre>
                </details>
              )}
              {msg._errorCode === "insufficient_credits" && cb.onTopUp && (
                <Button size="sm" variant="accent" shape="pill" className="mt-2" onClick={cb.onTopUp}>
                  <Wallet size={14} /> 去充值
                </Button>
              )}
            </div>
          </Alert>
        )}

        {/* 动作条 + meta（流式中不显示动作条，避免抖动） */}
        {!live && (msg.text || hasError) && (
          <MessageActions msg={msg} cb={cb} showRegen={ctx.isLast && !hasError} />
        )}
        {!live && <MetaRow msg={msg} />}
      </div>
    </div>
  );
});

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

// ═══════════════ thinking（💭 折叠） ═══════════════
export const ThinkingCard = memo(function ThinkingCard({
  msg,
  ctx,
}: {
  msg: ChatMessage;
  ctx: RenderCtx;
}) {
  const live = isLive(msg, ctx);
  const [userCollapsed, setUserCollapsed] = useState<boolean | null>(null);
  const collapsed = userCollapsed ?? defaultCollapsed(msg, ctx);
  return (
    <div className="rounded-lg border border-border bg-surface/60 animate-in">
      <button
        type="button"
        onClick={() => setUserCollapsed(!collapsed)}
        className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-[13px] text-muted hover:bg-hover"
      >
        <Brain size={14} className="text-faint" />
        <span className="font-medium">{live ? "思考中…" : "已思考"}</span>
        <ChevronRight
          size={14}
          className={cn("ml-auto text-faint transition-transform", !collapsed && "rotate-90")}
        />
      </button>
      {!collapsed && msg.text && (
        <div className="border-t border-border px-3.5 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap break-words text-muted">
          {msg.text}
          {live && (
            <span className="caret-blink ml-0.5 inline-block h-[1em] w-[2px] translate-y-[2px] bg-muted" />
          )}
        </div>
      )}
    </div>
  );
});

// ═══════════════ plan ═══════════════
const STEP_DOT: Record<string, string> = {
  completed: "bg-success",
  inProgress: "bg-accent animate-pulse",
  pending: "bg-faint",
};
export const PlanCard = memo(function PlanCard({ msg }: { msg: ChatMessage }) {
  const steps = msg.steps ?? [];
  return (
    <div className="rounded-lg border border-border bg-surface animate-in">
      <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
        <span className="flex size-6 items-center justify-center rounded-md bg-accent-soft text-accent">
          <ListTodo size={14} />
        </span>
        <span className="text-[13px] font-medium text-fg">{msg.text || "执行计划"}</span>
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
});

// ═══════════════ delegate-progress（委派进度兜底卡） ═══════════════
export const DelegateProgressCard = memo(function DelegateProgressCard({ msg }: { msg: ChatMessage }) {
  const entries = msg.entries ?? [];
  const done = !!msg._completed;
  return (
    <div className="rounded-lg border border-border bg-surface animate-in">
      <div className="flex items-center gap-2 px-3.5 py-2.5">
        <span className="flex size-6 items-center justify-center rounded-md bg-accent-soft text-accent">
          <Sparkles size={13} />
        </span>
        <span className="text-[13px] font-medium text-fg">{msg.text || "委派子任务"}</span>
        <span className="ml-auto">
          {done ? (
            <Badge tone={msg._isError ? "danger" : "success"}>{msg._isError ? "失败" : "完成"}</Badge>
          ) : (
            <Badge tone="accent">进行中</Badge>
          )}
        </span>
      </div>
      {entries.length > 0 && (
        <ul className="border-t border-border px-3.5 py-2 text-[12.5px] text-muted">
          {entries.slice(-6).map((e, i) => (
            <li key={i} className="truncate">
              <span className="text-faint">[{e.phase}]</span> {e.text}
            </li>
          ))}
        </ul>
      )}
      {done && msg.summary && (
        <div className="border-t border-border px-3.5 py-2 text-[12.5px] text-muted">{msg.summary}</div>
      )}
    </div>
  );
});

// ═══════════════ system ═══════════════
export const SystemCard = memo(function SystemCard({ msg }: { msg: ChatMessage }) {
  if (!msg.text) return null;
  return (
    <div className="flex justify-center animate-in">
      <div className="max-w-[80%] rounded-full bg-hover px-3 py-1 text-center text-[12px] text-faint">
        {msg.text}
      </div>
    </div>
  );
});
