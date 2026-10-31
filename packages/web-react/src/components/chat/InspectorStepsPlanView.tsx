/**
 * 详情面板「步骤」与「计划」视图(按需懒加载块,与 OutputsView / BrowserView 同级)。
 *
 * 默认分区是「产出」,面板关闭或停在「产出 / 浏览器」时无需把单步详情、行级 diff 复制、
 * 步骤时间轴与计划清单打入首屏(first-screen-budget)。空闲时由 InspectorPanel 预取;
 * 已就绪后经同步 thenable 立即渲染,零闪烁。
 */
import {
  ArrowDownToLine,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Circle,
  LoaderCircle,
  Route,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { ChatMessage } from "../../lib/chat/model";
import { computeStepTimings, formatStepDuration } from "../../lib/chat/stepTiming";
import { cn } from "../../lib/utils";
import type { DeferredPayloadLoader } from "../InspectorPanel";
import {
  type DisplayTool,
  type ToolLike,
  asArr,
  asStr,
  normalizeToolForDisplay,
  stripShellWrapperForDisplay,
} from "../tool/format";
import { diffLines } from "../tool/lineDiff";
import { resolveToolMeta, toolSummary } from "../tool/meta";
import { parseShellEnvelope } from "../tool/shellEnvelope";
import { resolveToolStatus } from "../tool/status";
import { toneTileClass } from "../tool/tone";
import { Badge, EmptyState, IconButton, Spinner } from "../ui";
import type { TodoItem } from "./PinnedTaskTracker";
import { CopyIconButton, FullToolBody } from "./paneParts";
import type { PaneTurn } from "./workPane";

function codexChangesText(input: Record<string, unknown> | null): string {
  return asArr(input?.changes)
    .map((c) => (c && typeof c === "object" ? asStr((c as Record<string, unknown>).diff) : ""))
    .filter(Boolean)
    .join("\n");
}

function formattedInput(input: Record<string, unknown> | null): string {
  if (!input) return "";
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return "";
  }
}

/**
 * 「复制全文」按工具类型取**面板里实际展示的正文**(T-04):
 *   - Edit → 行级 diff 文本(与面板 DiffView 同源 diffLines);codex apply_patch 形状取 changes[].diff;
 *   - Write → 文件内容;
 *   - Bash → `$ 命令` + 输出(Cursor 信封先解成 stdout/stderr,不复制 JSON 外壳);
 *   - 其余 → output,没有 output 才回退格式化的 input。
 */
export function inspectorCopyText(display: DisplayTool): string {
  const { name, input, tool } = display;
  const output = typeof tool.output === "string" ? tool.output : "";
  switch (name) {
    case "Edit": {
      const oldStr = asStr(input?.old_string);
      const newStr = asStr(input?.new_string);
      if (oldStr || newStr) {
        return diffLines(oldStr, newStr)
          .map((row) => `${row.sign}${row.text}`)
          .join("\n");
      }
      return codexChangesText(input) || output || formattedInput(input);
    }
    case "Write":
      return asStr(input?.content) || codexChangesText(input) || output || formattedInput(input);
    case "Bash": {
      const command = stripShellWrapperForDisplay(asStr(input?.command));
      const env = parseShellEnvelope(output);
      const streams = env
        ? [env.stdout, env.stderr].filter(Boolean).join(env.stdout && !env.stdout.endsWith("\n") ? "\n" : "")
        : output || asStr(tool.bashTail?.tail);
      return [command ? `$ ${command}` : "", streams].filter(Boolean).join("\n");
    }
    default:
      return output.trim() ? output : formattedInput(input);
  }
}

function idOf(message: ToolLike | null | undefined): string | undefined {
  const id = (message as { id?: unknown } | null | undefined)?.id;
  return typeof id === "string" && id ? id : undefined;
}

function sameMessage(a: ToolLike | null | undefined, b: ToolLike | null | undefined): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const ia = idOf(a);
  return ia !== undefined && ia === idOf(b);
}

type Hydrated = { message: ToolLike; state: "ready" | "loading" | "failed"; retry: () => void };

function expectedOf(m: ChatMessage) {
  return { recordId: m.id, role: m.role, ...(m._payloadSha256 ? { contentSha256: m._payloadSha256 } : {}) };
}

function pickRecord(records: ChatMessage[] | null, locator: ChatMessage): ChatMessage | null {
  if (!records || records.length === 0) return null;
  return records.find((r) => r.id === locator.id) ?? records.find((r) => r.role === "tool") ?? null;
}

function peekRecord(m: ChatMessage, loader?: DeferredPayloadLoader): ChatMessage | null {
  const tapeId = m._turnTapeId;
  const ordinal = m._recordOrdinal;
  if (!m.id || !loader?.peek || typeof tapeId !== "string" || typeof ordinal !== "number") return null;
  return pickRecord(loader.peek(tapeId, ordinal, expectedOf(m)), m);
}

/** 定位桩 → 完整工具消息(先 peek 页面缓存,没有再取);不是定位桩原样返回。 */
function useHydratedTool(message: ToolLike, loader?: DeferredPayloadLoader): Hydrated {
  const m = message as ChatMessage;
  const deferred = m._payloadDeferred === true;
  const tapeId = m._turnTapeId;
  const ordinal = m._recordOrdinal;
  const expected = deferred && m.id ? expectedOf(m) : null;
  const canLoad = !!expected && typeof tapeId === "string" && typeof ordinal === "number";
  const [loaded, setLoaded] = useState<{ key: string; record: ChatMessage | null } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = canLoad ? `${tapeId}:${ordinal}:${m.id}` : "";
  const peeked = deferred ? peekRecord(m, loader) : null;
  const hasPeek = !!peeked;
  // biome-ignore lint/correctness/useExhaustiveDependencies: key 已覆盖 tapeId / ordinal / id;attempt 是「重试」信号
  useEffect(() => {
    if (!canLoad || hasPeek || !loader?.fetch || !expected) return;
    const controller = new AbortController();
    loader
      .fetch(tapeId, ordinal, expected, controller.signal)
      .then((records) => {
        if (!controller.signal.aborted) setLoaded({ key, record: pickRecord(records, m) });
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoaded({ key, record: null });
      });
    return () => controller.abort();
  }, [key, attempt, hasPeek]);
  const retry = () => {
    setLoaded(null);
    setAttempt((n) => n + 1);
  };
  if (!deferred) return { message, state: "ready", retry };
  const record = peeked ?? (loaded?.key === key ? loaded.record : undefined);
  if (record) return { message: record, state: "ready", retry };
  if (!canLoad || !loader?.fetch || record === null) return { message, state: "failed", retry };
  return { message, state: "loading", retry };
}

function DeferredNotice({ hydrated }: { hydrated: Hydrated }) {
  if (hydrated.state === "loading") {
    return (
      <div className="flex items-center gap-2 py-2 text-meta text-muted" data-testid="pane-deferred-loading">
        <Spinner size={13} className="text-accent" />
        正在加载这一步的完整内容…
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 py-2 text-meta text-muted" data-testid="pane-deferred-failed">
      这一步的内容较大，没能加载出来。
      <button
        type="button"
        className="rounded text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        onClick={hydrated.retry}
      >
        继续
      </button>
    </div>
  );
}

const navButtonClass =
  "inline-flex min-h-8 items-center gap-1 rounded-md px-2 text-meta text-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11";

const rowButtonClass =
  "flex w-full min-w-0 items-center gap-2.5 px-3 py-1.5 text-left outline-none transition-colors hover:bg-hover/70 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [@media(hover:none)]:min-h-11";

/** 一步的头部:类型图标 + 标签 + 状态 + 摘要 + 复制全文。 */
function StepHeader({ message }: { message: ToolLike }) {
  const display = normalizeToolForDisplay(message);
  const meta = resolveToolMeta(display.name, display.input);
  const Icon = meta.icon;
  const summary = toolSummary(display.name, display.input);
  const status = resolveToolStatus(display);
  return (
    <div className="flex shrink-0 items-center gap-2.5 border-b border-border px-4 py-3">
      <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-lg", toneTileClass(meta.tone))}>
        <Icon size={14} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="text-body font-semibold text-fg">{meta.label}</h3>
          {status.isRunning ? (
            <>
              <span className="sr-only">{status.label}</span>
              <Spinner size={13} className="text-accent" />
            </>
          ) : (
            <Badge tone={status.tone}>{status.label}</Badge>
          )}
        </div>
        {summary && (
          <div className="mt-0.5 truncate font-mono text-xs text-muted" title={summary}>
            {summary}
          </div>
        )}
      </div>
      <CopyIconButton getText={() => inspectorCopyText(normalizeToolForDisplay(message))} />
    </div>
  );
}

function StepDetail({
  message: rawMessage,
  loader,
  index,
  total,
  following,
  showLatest,
  onBack,
  onPrev,
  onNext,
  onLatest,
}: {
  message: ToolLike;
  loader?: DeferredPayloadLoader;
  index: number;
  total: number;
  following: boolean;
  showLatest: boolean;
  onBack: () => void;
  onPrev: () => void;
  onNext: () => void;
  onLatest: () => void;
}) {
  const inList = index >= 0;
  const hydrated = useHydratedTool(rawMessage, loader);
  const message = hydrated.message;
  return (
    <>
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1" data-testid="pane-stepper">
        <button type="button" className={navButtonClass} onClick={onBack}>
          <ChevronLeft size={14} aria-hidden />
          全部步骤
        </button>
        <span className="flex-1" />
        {following ? (
          <span
            data-testid="pane-following"
            className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-2 py-0.5 text-meta text-accent"
          >
            <span aria-hidden className="size-1.5 rounded-full bg-accent motion-safe:animate-pulse" />
            跟随中
          </span>
        ) : showLatest ? (
          <button type="button" className={navButtonClass} onClick={onLatest} data-testid="pane-latest">
            <ArrowDownToLine size={13} aria-hidden />
            回到最新
          </button>
        ) : null}
        {inList && (
          <>
            <span className="px-1 text-meta tabular-nums text-muted" data-testid="pane-step-counter">
              {index + 1} / {total}
            </span>
            <IconButton
              size="sm"
              shape="square"
              aria-label="上一步"
              title="上一步 (K / ←)"
              disabled={index <= 0}
              onClick={onPrev}
            >
              <ChevronUp size={15} />
            </IconButton>
            <IconButton
              size="sm"
              shape="square"
              aria-label="下一步"
              title="下一步 (J / →)"
              disabled={index >= total - 1}
              onClick={onNext}
            >
              <ChevronDown size={15} />
            </IconButton>
          </>
        )}
      </div>
      <StepHeader message={message} />
      <div
        className="min-h-0 flex-1 overflow-y-auto px-4 py-3 [overflow-wrap:anywhere] [&>*:first-child]:mt-0"
        data-testid="pane-step-body"
      >
        {hydrated.state === "ready" ? (
          <FullToolBody display={normalizeToolForDisplay(message)} />
        ) : (
          <DeferredNotice hydrated={hydrated} />
        )}
      </div>
    </>
  );
}

function StepRow({
  message,
  active,
  durationMs,
  onPick,
}: {
  message: ToolLike;
  active: boolean;
  /** 与过程时间轴同口径(computeStepTimings):从上一步结束到这一步结束,含模型写这一步的时间。 */
  durationMs?: number;
  onPick: () => void;
}) {
  const display = normalizeToolForDisplay(message);
  const meta = resolveToolMeta(display.name, display.input);
  const Icon = meta.icon;
  const summary = toolSummary(display.name, display.input);
  const status = resolveToolStatus(display);
  const duration = durationMs === undefined ? null : formatStepDuration(durationMs);
  return (
    <button
      type="button"
      data-testid="pane-step"
      data-tool-status={status.kind}
      aria-current={active ? "true" : undefined}
      className={cn(rowButtonClass, active && "bg-accent-soft/60")}
      onClick={onPick}
    >
      <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-md", toneTileClass(meta.tone))}>
        <Icon size={13} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body text-fg">{meta.label}</span>
        {summary && <span className="block truncate font-mono text-[12px] text-faint">{summary}</span>}
      </span>
      <span className="flex shrink-0 items-center text-meta tabular-nums text-faint">
        {status.isRunning ? (
          <>
            <span className="sr-only">{status.label}</span>
            <Spinner size={13} className="text-accent" />
          </>
        ) : status.kind === "done" ? (
          (duration ?? <span className="sr-only">{status.label}</span>)
        ) : (
          <Badge tone={status.tone} size="sm">
            {status.label}
          </Badge>
        )}
      </span>
    </button>
  );
}

function StepList({
  turns,
  total,
  active,
  onPick,
}: {
  turns: PaneTurn[];
  total: number;
  active: ToolLike | null;
  onPick: (message: ToolLike) => void;
}) {
  // 最近一轮默认展开,更早的轮默认收起;用户点过的以用户为准。
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  if (total === 0) {
    return (
      <EmptyState
        icon={Route}
        title="还没有执行步骤"
        hint="助手运行命令、读写文件、搜索网页时，每一步都会出现在这里。"
      />
    );
  }
  const ordered = [...turns].reverse();
  const newestKey = ordered[0]?.key;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto py-1" data-testid="pane-step-list">
      {ordered.map((turn) => {
        const open = toggled[turn.key] ?? turn.key === newestKey;
        const timings = open ? computeStepTimings(turn.rows, { turnStartedAt: turn.startedAt, active: false }) : null;
        return (
          <section key={turn.key} data-testid="pane-turn" className="pb-1">
            <button
              type="button"
              aria-expanded={open}
              className={cn(rowButtonClass, "gap-1.5 py-2")}
              onClick={() => setToggled((t) => ({ ...t, [turn.key]: !open }))}
            >
              <ChevronRight
                size={14}
                aria-hidden
                className={cn("shrink-0 text-faint transition-transform", open && "rotate-90")}
              />
              <span className="min-w-0 flex-1 truncate text-body font-medium text-fg" title={turn.title}>
                {turn.title}
              </span>
              <span className="shrink-0 text-meta tabular-nums text-faint">{turn.steps.length} 步</span>
            </button>
            {open && (
              <ol className="pl-3">
                {turn.steps.map((step) => (
                  <li key={step.message.id}>
                    <StepRow
                      message={step.message}
                      active={sameMessage(active, step.message)}
                      durationMs={timings?.get(step.message.id)?.ms}
                      onPick={() => onPick(step.message)}
                    />
                  </li>
                ))}
              </ol>
            )}
          </section>
        );
      })}
    </div>
  );
}

function PlanView({ todos }: { todos: TodoItem[] }) {
  const done = todos.filter((t) => t.status === "completed").length;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3" data-testid="pane-plan">
      <p className="mb-2 text-meta text-muted">
        已完成 {done} / {todos.length}
      </p>
      <ol className="space-y-2">
        {todos.map((t, i) => {
          const isDone = t.status === "completed";
          const active = t.status === "in_progress";
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: 计划条目没有稳定 id,同一份列表按位置替换
            <li key={i} className="flex items-start gap-2 text-body">
              <span className="mt-0.5 shrink-0">
                {isDone ? (
                  <Check className="size-3.5 text-success" />
                ) : active ? (
                  <LoaderCircle className="size-3.5 animate-spin text-accent" />
                ) : (
                  <Circle className="size-3.5 text-faint" />
                )}
              </span>
              <span className={cn("min-w-0 break-words", isDone ? "text-faint line-through" : active ? "text-fg" : "text-muted")}>
                {active && t.activeForm ? t.activeForm : t.content}
                <span className="sr-only">{isDone ? "(已完成)" : active ? "(进行中)" : "(待办)"}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export type InspectorStepsPlanProps =
  | {
      mode: "plan";
      todos: TodoItem[];
    }
  | {
      mode: "steps";
      shown: ToolLike | null;
      loader?: DeferredPayloadLoader;
      index: number;
      total: number;
      following: boolean;
      showLatest: boolean;
      onBack: () => void;
      onPrev: () => void;
      onNext: () => void;
      onLatest: () => void;
      turns: PaneTurn[];
      active: ToolLike | null;
      onPick: (message: ToolLike) => void;
    };

export function InspectorStepsPlanView(props: InspectorStepsPlanProps) {
  if (props.mode === "plan") {
    return <PlanView todos={props.todos} />;
  }
  if (props.shown) {
    return (
      <StepDetail
        message={props.shown}
        loader={props.loader}
        index={props.index}
        total={props.total}
        following={props.following}
        showLatest={props.showLatest}
        onBack={props.onBack}
        onPrev={props.onPrev}
        onNext={props.onNext}
        onLatest={props.onLatest}
      />
    );
  }
  return <StepList turns={props.turns} total={props.total} active={props.active} onPick={props.onPick} />;
}
