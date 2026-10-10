/**
 * InspectorPanel —— 详情面板(右侧第三栏,OCV5-370 改版)。
 *
 * 一个面板三个分区,数据全部来自会话自己的消息(不打后端):
 *   - 步骤:会话里每一次工具调用,按轮分组(最近一轮在上)。点一步进入全文详情
 *     (ToolBodyFullContext=true:diff / 终端输出 / 读文件全文),带「全部步骤」返回、`3 / 9`
 *     计数、上一步 / 下一步(按钮 + 面板内 K/J、←/→)。正在运行的那一轮里停在最新一步时
 *     「跟随中」:新步骤到来自动切过去;翻回旧步骤后给「回到最新」。
 *   - 改动:会话里改过的文件,一个文件一行(改动次数、+/− 行数),点进去按顺序看这份文件的
 *     每一次改动;同会话里对同一文件的再次 Write 按与上次写入的 diff 展示。
 *   - 计划:会话里最近一份 TodoWrite / plan(只读;没有计划时不出这个分区)。
 *
 * 布局接入(App.tsx):宽屏(≥1100px)是与 Sidebar | main 并列的内联 <aside>,可拖宽、
 * 宽度与开合记住;更窄的视口不挤三列,复用 Sheet 贴底抽屉呈现同一 InspectorPanelContent。
 *
 * 数据:消息对象由 ChatSocket 就地 mutate,App 随 version 重渲时面板自然读到最新流式内容。
 * 状态徽标与卡片共用 {@link resolveToolStatus}(T-05):卡片「受阻/未成功」面板就不会是「完成/已结束」。
 */
import {
  ArrowDownToLine,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Circle,
  Copy,
  FileDiff,
  FilePen,
  ListChecks,
  LoaderCircle,
  Route,
  X,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  Suspense,
  lazy,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ChatMessage } from "../lib/chat/model";
import { computeStepTimings, formatStepDuration } from "../lib/chat/stepTiming";
import { cn } from "../lib/utils";
import { extractLatestTodos, type TodoItem } from "./chat/PinnedTaskTracker";
import { CopyIconButton, FullToolBody } from "./chat/paneParts";
import { collectWorkTurns, turnIndexOf } from "./chat/workTurns";
import { collectPaneSteps, type PaneTurn } from "./chat/workPane";
import {
  type DisplayTool,
  type ToolLike,
  asArr,
  asStr,
  normalizeToolForDisplay,
  stripShellWrapperForDisplay,
} from "./tool/format";
import { diffLines } from "./tool/lineDiff";
import { resolveToolMeta, toolSummary } from "./tool/meta";
import { parseShellEnvelope } from "./tool/shellEnvelope";
import { resolveToolStatus } from "./tool/status";
import { toneTileClass } from "./tool/tone";
import { Badge, EmptyState, IconButton, Skeleton, Spinner, Tabs, useToast } from "./ui";

// 产出页(含主产物渲染)只在面板打开且停在产出时才需要:懒加载,不进首屏(first-screen-budget)。
const OutputsView = lazy(() => import("./chat/OutputsView").then((m) => ({ default: m.OutputsView })));

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
 * 之前一律优先复制 output:Edit/Write 完成后 output 是 "The file has been updated." 这类状态串,
 * 面板展示的是 diff,复制到的却是一句废话。
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

function isEditableTarget(node: EventTarget | null): boolean {
  if (!(node instanceof HTMLElement)) return false;
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || node.isContentEditable;
}

export type PaneTab = "outputs" | "steps" | "plan";

/**
 * 从面板外打开 / 定位面板的请求(工具卡入口、过程摘要上的「改动 N 个文件」、顶栏开关)。
 * nonce 每次请求都换:同一条消息连点两次也会重新定位并把焦点移进面板。
 * tab 缺省 = 只开面板(停在上次的分区)。
 */
export type PaneRequest = {
  /** "changes" 是 r1 的改动页:改动并进了产出页,旧入口 / 旧记忆按产出处理。 */
  tab?: PaneTab | "changes";
  /** steps:要打开的那一步;outputs:这一轮里的任意一行(定位到它所在的那一轮)。 */
  message?: ToolLike | null;
  nonce: number;
  /** 发起请求时的会话;App 只把属于当前会话的请求交给面板(切会话后旧请求作废)。 */
  sessionId?: string | null;
};

/**
 * 大记录(>1 MiB)在历史里只是定位桩(`_payloadDeferred`),正文按需取。面板复用聊天区同一套
 * 取数(App 的 cardCallbacks:页面内缓存 + 校验),不另起请求通道。
 */
export type DeferredPayloadLoader = {
  peek?: (
    tapeId: string,
    recordOrdinal: number,
    expected: { recordId: string; role: string; contentSha256?: string },
  ) => ChatMessage[] | null;
  fetch?: (
    tapeId: string,
    recordOrdinal: number,
    expected: { recordId: string; role: string; contentSha256?: string },
    signal?: AbortSignal,
  ) => Promise<ChatMessage[] | null>;
};

/** 只把属于当前会话的请求交给面板:请求在切会话前发出、面板在切会话后挂载时,旧请求作废。 */
export function paneRequestForSession(request: PaneRequest | null, sessionId: string | null | undefined): PaneRequest | null {
  return request && (request.sessionId ?? null) === (sessionId ?? null) ? request : null;
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

function pickRecord(records: ChatMessage[] | null, locator: ChatMessage): ChatMessage | null {
  if (!records || records.length === 0) return null;
  return records.find((r) => r.id === locator.id) ?? records.find((r) => r.role === "tool") ?? null;
}

/** 定位桩 → 完整工具消息(先 peek 页面缓存,没有再取);不是定位桩原样返回。 */
function useHydratedTool(message: ToolLike, loader?: DeferredPayloadLoader): Hydrated {
  const m = message as ChatMessage;
  const deferred = m._payloadDeferred === true;
  const tapeId = m._turnTapeId;
  const ordinal = m._recordOrdinal;
  const expected =
    deferred && m.id
      ? { recordId: m.id, role: m.role, ...(m._payloadSha256 ? { contentSha256: m._payloadSha256 } : {}) }
      : null;
  const canLoad = !!expected && typeof tapeId === "string" && typeof ordinal === "number";
  const [loaded, setLoaded] = useState<{ key: string; record: ChatMessage | null } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = canLoad ? `${tapeId}:${ordinal}:${m.id}` : "";
  const peeked = canLoad && loader?.peek && expected ? pickRecord(loader.peek(tapeId, ordinal, expected), m) : null;
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
        重试
      </button>
    </div>
  );
}

export const PANE_TAB_STORAGE_KEY = "oc_v5_detail_pane_tab";
export const PANE_OPEN_STORAGE_KEY = "oc_v5_detail_pane_open";

/** 宽屏内联面板的宽度范围与记忆键(useResizableWidth;把手在面板左缘)。 */
export const DETAIL_PANE_WIDTH = {
  storageKey: "oc_v5_detail_pane_width",
  defaultWidth: 440,
  min: 320,
  max: 720,
  edge: "left",
} as const;

/** 宽屏面板是否展开(用户偏好,跨会话、跨刷新)。读不到存储 → 收起(与改版前一致)。 */
export function readDetailPaneOpen(): boolean {
  try {
    return localStorage.getItem(PANE_OPEN_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeDetailPaneOpen(open: boolean): void {
  try {
    localStorage.setItem(PANE_OPEN_STORAGE_KEY, open ? "1" : "0");
  } catch {
    /* private mode / quota */
  }
}

function requestTab(tab: PaneTab | "changes"): PaneTab {
  return tab === "changes" ? "outputs" : tab;
}

function readStoredTab(): PaneTab {
  try {
    const v = localStorage.getItem(PANE_TAB_STORAGE_KEY);
    if (v === "steps" || v === "plan" || v === "outputs") return v;
  } catch {
    /* private mode */
  }
  // 没记过 / r1 记的「改动」:产出页(改动已并进去)。
  return "outputs";
}

function writeStoredTab(tab: PaneTab): void {
  try {
    localStorage.setItem(PANE_TAB_STORAGE_KEY, tab);
  } catch {
    /* private mode / quota */
  }
}

const navButtonClass =
  "inline-flex min-h-8 items-center gap-1 rounded-md px-2 text-meta text-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11";

const rowButtonClass =
  "flex w-full min-w-0 items-center gap-2.5 px-3 py-1.5 text-left outline-none transition-colors hover:bg-hover/70 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [@media(hover:none)]:min-h-11";

function baseName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}

function dirName(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i > 0 ? norm.slice(0, i) : "";
}


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

function OutputsFallback() {
  return (
    <div className="space-y-3 px-4 py-4" data-testid="outputs-loading">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-48 w-full rounded-xl" />
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

/** 面板内容(分区 + 当前视图)。桌面 aside 与窄屏 Sheet 共用。`titleId` 供外层容器 aria-labelledby。 */
export function InspectorPanelContent({
  messages,
  version,
  running = false,
  request,
  deferredLoader,
  onClose,
  onActiveChange,
  titleId,
}: {
  messages: readonly ChatMessage[];
  /** 会话消息就地 mutate 的版本号;只用来让改动汇总随流式内容重算。 */
  version?: number;
  /** 本会话这一轮是否仍在进行(决定「跟随中」)。 */
  running?: boolean;
  request?: PaneRequest | null;
  /** 大记录定位桩的正文取数(聊天区同一套缓存);不传则定位桩显示「没能加载」。 */
  deferredLoader?: DeferredPayloadLoader;
  onClose: () => void;
  /** 当前在详情里查看的那一步 → 源卡片选中态(T-18)。 */
  onActiveChange?: (message: ToolLike | null) => void;
  titleId?: string;
}) {
  const [tab, setTabState] = useState<PaneTab>(() => (request?.tab ? requestTab(request.tab) : readStoredTab()));
  const [selected, setSelected] = useState<ToolLike | null>(() => (request?.tab === "steps" ? (request.message ?? null) : null));
  const fallbackTitleId = useId();
  const headingId = titleId ?? fallbackTitleId;
  const idBase = useId();

  const setTab = (next: PaneTab) => {
    setTabState(next);
    writeStoredTab(next);
  };

  const { turns, steps } = collectPaneSteps(messages);
  // biome-ignore lint/correctness/useExhaustiveDependencies: version 是就地 mutate 消息的变更信号
  const workTurns = useMemo(() => collectWorkTurns(messages), [messages, version]);
  const todos = extractLatestTodos(messages, 0);
  const lastTurn = workTurns.length - 1;
  // 产出页看的那一轮:null = 最新一轮(新一轮开始时自动跟过去);翻到旧轮时记它的 key。
  const turnKeyFor = (message: ToolLike | null | undefined): string | null => {
    const i = turnIndexOf(workTurns, message as { id?: string } | null | undefined);
    return i < 0 || i === lastTurn ? null : (workTurns[i]?.key ?? null);
  };
  const [turnKey, setTurnKey] = useState<string | null>(() =>
    request && request.tab !== undefined && requestTab(request.tab) === "outputs" ? turnKeyFor(request.message) : null,
  );
  const keyedTurn = turnKey === null ? -1 : workTurns.findIndex((t) => t.key === turnKey);
  const outputsIndex = keyedTurn >= 0 ? keyedTurn : lastTurn;

  const view: PaneTab = tab === "plan" && todos.length === 0 ? "outputs" : tab;
  const latest = steps.at(-1)?.message ?? null;
  // 首次挂载带着请求(面板 / 底部抽屉刚打开)时和后续请求一样:运行中点开最新那张卡就跟随。
  const [follow, setFollow] = useState(
    () => request?.tab === "steps" && !!request.message && running && sameMessage(request.message, latest),
  );
  // 选中按消息 id 记:历史重载 / 同步会用同 id 的新对象替换旧行,按引用记会停在旧正文上。
  // 不在顶层步骤里的消息(团队子任务 / demo)按原对象显示。
  const resolveSelected = (m: ToolLike | null): ToolLike | null => {
    if (!m) return null;
    const id = idOf(m);
    return (id ? steps.find((s) => s.message.id === id)?.message : undefined) ?? m;
  };
  const shown: ToolLike | null = view === "steps" ? (follow ? latest : resolveSelected(selected)) : null;
  const index = shown ? steps.findIndex((s) => sameMessage(s.message, shown)) : -1;
  const following = follow && running && !!latest;

  const handledNonce = useRef(request?.nonce);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只响应新请求(nonce);latest / running 取请求到来那一刻
  useEffect(() => {
    if (!request || request.nonce === handledNonce.current) return;
    handledNonce.current = request.nonce;
    if (!request.tab) return;
    const next = requestTab(request.tab);
    setTabState(next);
    if (next === "outputs") setTurnKey(turnKeyFor(request.message));
    if (next === "steps") {
      setSelected(request.message ?? null);
      // 运行中从最新那张卡点开 = 想看它往下走:直接跟随。
      setFollow(!!request.message && running && sameMessage(request.message, latest));
    }
  }, [request]);

  useEffect(() => {
    onActiveChange?.(shown);
  }, [shown, onActiveChange]);
  useEffect(() => () => onActiveChange?.(null), [onActiveChange]);

  const pick = (message: ToolLike) => {
    setSelected(message);
    setFollow(running && sameMessage(message, latest));
  };
  const goTo = (i: number) => {
    const target = steps[i]?.message;
    if (target) pick(target);
  };
  const openStep = (message: ToolLike) => {
    setTab("steps");
    setSelected(message);
    setFollow(false);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (view !== "steps" || !shown || index < 0) return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented) return;
    if (isEditableTarget(e.target)) return;
    const el = e.target instanceof HTMLElement ? e.target : null;
    if (el?.closest('[role="tablist"],[role="separator"]')) return;
    const key = e.key.toLowerCase();
    if ((key === "arrowleft" || key === "k") && index > 0) {
      e.preventDefault();
      goTo(index - 1);
    } else if ((key === "arrowright" || key === "j") && index < steps.length - 1) {
      e.preventDefault();
      goTo(index + 1);
    }
  };

  const count = (n: number) => (n > 0 ? <span className="ml-1 tabular-nums text-faint">{n}</span> : null);
  const tabItems = [
    { value: "outputs", label: <span>产出</span> },
    { value: "steps", label: <span>步骤{count(steps.length)}</span> },
    ...(todos.length > 0 ? [{ value: "plan", label: <span>计划</span> }] : []),
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface" onKeyDown={onKeyDown} data-testid="detail-pane">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 header-safe-t">
        <h2 id={headingId} className="sr-only">
          详情面板
        </h2>
        <div className="min-w-0 flex-1">
          <Tabs
            value={view}
            onValueChange={(v) => setTab(v as PaneTab)}
            items={tabItems}
            idBase={idBase}
            aria-label="详情面板分区"
          />
        </div>
        <IconButton aria-label="关闭详情面板" size="sm" shape="square" data-inspector-close="" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </header>
      <div
        id={`${idBase}-panel-${view}`}
        role="tabpanel"
        aria-labelledby={`${idBase}-tab-${view}`}
        className="flex min-h-0 flex-1 flex-col"
      >
        {view === "steps" ? (
          shown ? (
            <StepDetail
              message={shown}
              loader={deferredLoader}
              index={index}
              total={steps.length}
              following={following}
              showLatest={!!latest && !sameMessage(shown, latest)}
              onBack={() => {
                setSelected(null);
                setFollow(false);
              }}
              onPrev={() => goTo(index - 1)}
              onNext={() => goTo(index + 1)}
              onLatest={() => setFollow(true)}
            />
          ) : (
            <StepList turns={turns} total={steps.length} active={selected} onPick={pick} />
          )
        ) : view === "outputs" ? (
          <Suspense fallback={<OutputsFallback />}>
          <OutputsView
            messages={messages}
            turns={workTurns}
            index={outputsIndex}
            running={running && outputsIndex === lastTurn}
            onSelectTurn={(i) => {
              const t = workTurns[i];
              if (t) setTurnKey(i === lastTurn ? null : t.key);
            }}
            onOpenSteps={() => {
              setTab("steps");
              setSelected(null);
              setFollow(false);
            }}
            onOpenStep={openStep}
          />
          </Suspense>
        ) : (
          <PlanView todos={todos} />
        )}
      </div>
    </div>
  );
}

/**
 * 宽屏第三列:内联 aside(与 Sidebar/main 并列),左缘拖宽把手(键盘 ← → / Home / End,双击复位)。
 * 焦点管理(T-24):从外面点开(focusNonce 变化)时焦点进面板(关闭按钮),卸载时归还到打开它的那个入口;
 * 页面加载时按记忆直接展开的面板不抢焦点。Escape 只在焦点在面板里时关闭面板 —— 面板现在可以常开,
 * 在别处按 Esc(取消输入法、关弹层、停止生成)不该顺手把它关掉。
 */
export function InspectorPanel({
  width,
  resizing = false,
  widthMin,
  widthMax,
  onResizeStart,
  onResizeKeyDown,
  focusNonce,
  onClose,
  ...content
}: Omit<Parameters<typeof InspectorPanelContent>[0], "titleId"> & {
  width?: number;
  resizing?: boolean;
  widthMin?: number;
  widthMax?: number;
  onResizeStart?: (e: ReactPointerEvent) => void;
  onResizeKeyDown?: (e: ReactKeyboardEvent) => void;
  focusNonce?: number;
}) {
  const asideRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Radix 弹层(Dialog/Sheet/Popover)处理过的 Escape 会 preventDefault,不抢。
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (!(e.target instanceof Node) || !asideRef.current?.contains(e.target)) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 每次从外面点开(换了一步 / 点了顶栏开关)都记下当时的焦点元素并把焦点移进面板;
  // 面板整体卸载时把焦点还给最后那个入口。
  useEffect(() => {
    if (focusNonce === undefined) return;
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      active !== document.body &&
      !asideRef.current?.contains(active)
    ) {
      returnFocusRef.current = active;
    }
    const raf = requestAnimationFrame(() => {
      asideRef.current?.querySelector<HTMLElement>("[data-inspector-close]")?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [focusNonce]);

  useEffect(
    () => () => {
      const el = returnFocusRef.current;
      if (el?.isConnected) el.focus();
    },
    [],
  );

  return (
    <aside
      ref={asideRef}
      aria-labelledby={titleId}
      style={width !== undefined ? { width } : undefined}
      className={cn(
        "relative flex min-h-0 max-w-[45vw] shrink-0 flex-col border-l border-border",
        width === undefined && "w-[clamp(20rem,36vw,34rem)]",
        resizing && "select-none",
      )}
    >
      {onResizeStart && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="调整详情面板宽度"
          aria-valuenow={width}
          aria-valuemin={widthMin}
          aria-valuemax={widthMax}
          title="拖动调整宽度，双击复位默认宽度"
          tabIndex={onResizeKeyDown ? 0 : undefined}
          onKeyDown={onResizeKeyDown}
          onPointerDown={onResizeStart}
          data-testid="pane-resize-handle"
          className={cn(
            "absolute inset-y-0 left-0 z-10 w-1 -translate-x-1/2 cursor-col-resize touch-none outline-none hover:bg-accent/40 focus-visible:bg-accent/60",
            resizing && "bg-accent/40",
          )}
        />
      )}
      <InspectorPanelContent {...content} onClose={onClose} titleId={titleId} />
    </aside>
  );
}
