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
import {
  collectFileChanges,
  collectPaneSteps,
  type FileChange,
  type FileChangeEntry,
  type PaneTurn,
} from "./chat/workPane";
import { ToolBody } from "./tool/lazyToolBody";
import { ToolBodyFullContext, ToolHeaderLabelContext } from "./tool/context";
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
import { Badge, EmptyState, IconButton, Spinner, Tabs, useToast } from "./ui";

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

function CopyIconButton({
  getText,
  label = "复制全文",
  doneText = "已复制全文",
}: {
  getText: () => string;
  label?: string;
  doneText?: string;
}) {
  const toast = useToast();
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
          toast(doneText, "success");
          setTimeout(() => setDone(false), 1500);
        } catch {
          // 剪贴板不可用(非安全上下文 / 权限拒绝):不能再静默,给用户一个出口(T-19)。
          toast("复制失败，请手动选中文本复制", "error");
        }
      }}
    >
      {done ? <Check size={15} /> : <Copy size={15} />}
    </IconButton>
  );
}

function isEditableTarget(node: EventTarget | null): boolean {
  if (!(node instanceof HTMLElement)) return false;
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || node.isContentEditable;
}

export type PaneTab = "steps" | "changes" | "plan";

/**
 * 从面板外打开 / 定位面板的请求(工具卡入口、过程摘要上的「改动 N 个文件」、顶栏开关)。
 * nonce 每次请求都换:同一条消息连点两次也会重新定位并把焦点移进面板。
 * tab 缺省 = 只开面板(停在上次的分区)。
 */
export type PaneRequest = { tab?: PaneTab; message?: ToolLike | null; nonce: number };

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

function readStoredTab(): PaneTab {
  try {
    const v = localStorage.getItem(PANE_TAB_STORAGE_KEY);
    if (v === "steps" || v === "changes" || v === "plan") return v;
  } catch {
    /* private mode */
  }
  return "steps";
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

function FullToolBody({ display }: { display: DisplayTool }) {
  const meta = resolveToolMeta(display.name, display.input);
  return (
    <ToolBodyFullContext.Provider value={true}>
      <ToolHeaderLabelContext.Provider value={meta.label}>
        <ToolBody name={display.name} input={display.input} tool={display.tool} />
      </ToolHeaderLabelContext.Provider>
    </ToolBodyFullContext.Provider>
  );
}

function StepDetail({
  message,
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
        <FullToolBody display={normalizeToolForDisplay(message)} />
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
                      active={active === step.message}
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

function LineCounts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="tabular-nums">
      <span className="text-success">+{added}</span> <span className="text-danger">−{removed}</span>
    </span>
  );
}

function ChangesList({ changes, onPick }: { changes: FileChange[]; onPick: (path: string) => void }) {
  if (changes.length === 0) {
    return (
      <EmptyState
        icon={FileDiff}
        title="还没有改动文件"
        hint="助手编辑或写入文件后，这里按文件汇总每一次改动和增删行数。"
      />
    );
  }
  const added = changes.reduce((n, f) => n + f.added, 0);
  const removed = changes.reduce((n, f) => n + f.removed, 0);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto pb-2" data-testid="pane-change-list">
      <p className="px-3 py-2 text-meta text-muted">
        {changes.length} 个文件 · <LineCounts added={added} removed={removed} />
      </p>
      <ul>
        {changes.map((file) => {
          const dir = dirName(file.path);
          return (
            <li key={file.path}>
              <button type="button" data-testid="pane-file" className={rowButtonClass} onClick={() => onPick(file.path)}>
                <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-success-soft text-success">
                  <FilePen size={13} />
                </span>
                <span className="min-w-0 flex-1" title={file.path}>
                  <span className="block truncate text-body text-fg">{baseName(file.path)}</span>
                  {dir && <span className="block truncate font-mono text-[12px] text-faint">{dir}</span>}
                </span>
                <span className="flex shrink-0 items-center gap-2 text-meta">
                  {file.running && <Spinner size={13} className="text-accent" />}
                  {file.hasError && (
                    <Badge tone="danger" size="sm">
                      有失败
                    </Badge>
                  )}
                  <LineCounts added={file.added} removed={file.removed} />
                  <span className="tabular-nums text-faint">{file.entries.length} 次</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const CHANGE_KIND_LABEL: Record<FileChangeEntry["kind"], string> = {
  edit: "编辑",
  write: "写入",
  patch: "补丁",
  shell: "命令写入",
};

/** 再次 Write 同一文件:按与上次写入全文的 diff 展示(合成一条 Edit 交给同一套 diff 渲染)。 */
function entryDisplay(entry: FileChangeEntry): DisplayTool {
  const display = normalizeToolForDisplay(entry.message);
  if (entry.previousContent === undefined) return display;
  const input = {
    file_path: asStr(display.input?.file_path),
    old_string: entry.previousContent,
    new_string: asStr(display.input?.content),
  };
  return { name: "Edit", input, tool: { ...display.tool, toolName: "Edit", inputJson: input } };
}

function FileChangeEntryView({
  entry,
  n,
  onOpenStep,
}: {
  entry: FileChangeEntry;
  n: number;
  onOpenStep: (message: ToolLike) => void;
}) {
  const status = resolveToolStatus(normalizeToolForDisplay(entry.message));
  const kind =
    entry.previousContent !== undefined ? "覆盖写入（与上次写入对比）" : CHANGE_KIND_LABEL[entry.kind];
  return (
    <section data-testid="pane-file-change" className="min-w-0">
      <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-muted">
        <span className="font-medium text-fg">第 {n} 次</span>
        <span>{kind}</span>
        {entry.added !== null && entry.removed !== null && status.kind !== "error" && (
          <LineCounts added={entry.added} removed={entry.removed} />
        )}
        {status.isRunning ? (
          <Spinner size={12} className="text-accent" />
        ) : status.kind !== "done" ? (
          <Badge tone={status.tone} size="sm">
            {status.label}
          </Badge>
        ) : null}
        <button
          type="button"
          className="ml-auto rounded text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => onOpenStep(entry.message)}
        >
          查看这一步
        </button>
      </div>
      <FullToolBody display={entryDisplay(entry)} />
    </section>
  );
}

function FileDetail({
  file,
  onBack,
  onOpenStep,
}: {
  file: FileChange;
  onBack: () => void;
  onOpenStep: (message: ToolLike) => void;
}) {
  return (
    <>
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
        <button type="button" className={navButtonClass} onClick={onBack}>
          <ChevronLeft size={14} aria-hidden />
          全部改动
        </button>
        <span className="flex-1" />
        <CopyIconButton getText={() => file.path} label="复制路径" doneText="已复制路径" />
      </div>
      <div className="shrink-0 border-b border-border px-4 py-3">
        <h3 className="truncate font-mono text-body font-semibold text-fg" title={file.path}>
          {baseName(file.path)}
        </h3>
        <div className="mt-0.5 truncate font-mono text-xs text-muted" title={file.path}>
          {file.path}
        </div>
        <div className="mt-1 text-meta text-muted">
          {file.entries.length} 次改动 · <LineCounts added={file.added} removed={file.removed} />
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-3 [overflow-wrap:anywhere]" data-testid="pane-file-body">
        {file.entries.map((entry, i) => (
          <FileChangeEntryView
            key={`${entry.message.id}:${i}`}
            entry={entry}
            n={i + 1}
            onOpenStep={onOpenStep}
          />
        ))}
      </div>
    </>
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
  onClose: () => void;
  /** 当前在详情里查看的那一步 → 源卡片选中态(T-18)。 */
  onActiveChange?: (message: ToolLike | null) => void;
  titleId?: string;
}) {
  const [tab, setTabState] = useState<PaneTab>(() => request?.tab ?? readStoredTab());
  const [selected, setSelected] = useState<ToolLike | null>(() => request?.message ?? null);
  const [follow, setFollow] = useState(false);
  const [filePath, setFilePath] = useState<string | null>(null);
  const fallbackTitleId = useId();
  const headingId = titleId ?? fallbackTitleId;
  const idBase = useId();

  const setTab = (next: PaneTab) => {
    setTabState(next);
    setFilePath(null);
    writeStoredTab(next);
  };

  const handledNonce = useRef(request?.nonce);
  useEffect(() => {
    if (!request || request.nonce === handledNonce.current) return;
    handledNonce.current = request.nonce;
    if (!request.tab) return;
    setTabState(request.tab);
    setFilePath(null);
    if (request.tab === "steps") {
      setSelected(request.message ?? null);
      setFollow(false);
    }
  }, [request]);

  const { turns, steps } = collectPaneSteps(messages);
  // biome-ignore lint/correctness/useExhaustiveDependencies: version 是就地 mutate 消息的变更信号
  const changes = useMemo(() => collectFileChanges(messages), [messages, version]);
  const todos = extractLatestTodos(messages, 0);

  const view: PaneTab = tab === "plan" && todos.length === 0 ? "steps" : tab;
  const latest = steps.at(-1)?.message ?? null;
  const shown: ToolLike | null = view === "steps" ? (follow ? latest : selected) : null;
  const index = shown ? steps.findIndex((s) => s.message === shown) : -1;
  const following = follow && running && !!latest;
  const file = view === "changes" && filePath ? (changes.find((f) => f.path === filePath) ?? null) : null;

  useEffect(() => {
    onActiveChange?.(shown);
  }, [shown, onActiveChange]);
  useEffect(() => () => onActiveChange?.(null), [onActiveChange]);

  const pick = (message: ToolLike) => {
    setSelected(message);
    setFollow(message === latest && running);
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
    { value: "steps", label: <span>步骤{count(steps.length)}</span> },
    { value: "changes", label: <span>改动{count(changes.length)}</span> },
    ...(todos.length > 0 ? [{ value: "plan", label: <span>计划</span> }] : []),
  ];

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 面板内 K/J、←/→ 翻步骤;按键来自内部可聚焦控件冒泡
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
              index={index}
              total={steps.length}
              following={following}
              showLatest={!!latest && shown !== latest}
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
        ) : view === "changes" ? (
          file ? (
            <FileDetail file={file} onBack={() => setFilePath(null)} onOpenStep={openStep} />
          ) : (
            <ChangesList changes={changes} onPick={setFilePath} />
          )
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
