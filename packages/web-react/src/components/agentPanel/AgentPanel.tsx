/**
 * AgentPanelContent —— 「Agent 电脑」面板内容（PRD_MANUS_A F1.2 / F1.3 / F2.2；DESIGN §4）。
 *
 * 头部三栏：
 *   A 面板栏  面板名 · 动作类型标签 · 模式徽标（实时 / 已固定）｜ 回到最新 · 复制全文 · 折叠 · 关闭
 *   B 动作栏  工具图标砖 · h2 工具标签 · 状态｜ ‹ 步骤 k/n ›
 *   C 进度行  「进度 c/n · 当前步骤」可展开的只读任务列表（无 todos 不渲染，F2.5）
 * 正文复用 InspectorPanel 的全文模式 ToolBody；目标可解析出容器 loopback URL 时顶部多一条
 * 「打开预览」工具条。桌面 aside 与窄屏 Sheet 共用本组件（variant 控制哪些按钮渲染）。
 *
 * 数据契约同 InspectorPanel：target 持 ChatSocket 就地 mutate 的消息对象引用，随宿主重渲读到最新。
 */
import { normalizeContainerPreviewUrl } from "@openclaude/protocol/containerPreview";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronsRight,
  Circle,
  Copy,
  ExternalLink,
  Globe,
  ListChecks,
  LoaderCircle,
  PanelRightClose,
  X,
} from "lucide-react";
import { type KeyboardEvent, type ReactNode, useId, useState } from "react";
import { cn } from "../../lib/utils";
import { inspectorCopyText } from "../InspectorPanel";
import { HUD_LIST_CLS, type TodoItem } from "../chat/PinnedTaskTracker";
import { ToolBody } from "../tool/bodies";
import { ToolBodyFullContext, ToolHeaderLabelContext } from "../tool/context";
import { type DisplayTool, type ToolLike, asStr, normalizeToolForDisplay } from "../tool/format";
import { resolveToolMeta, toolSummary } from "../tool/meta";
import { resolveToolStatus } from "../tool/status";
import { toneTileClass } from "../tool/tone";
import { Badge, Button, IconButton, Spinner, Tabs, useToast } from "../ui";
import { resolveActionKind } from "./actionKind";
import { AGENT_PANEL_STRINGS as S, progressLabel, stepLabel } from "./strings";

const LOOPBACK_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?[^\s"'<>)\]]*/i;

/** 从工具输入 / 输出里找容器 loopback 预览地址（归一化后的 URL；找不到 → null）。 */
export function findContainerPreviewUrl(display: DisplayTool): string | null {
  const candidates = [
    asStr(display.input?.url),
    asStr(display.input?.command),
    typeof display.tool.output === "string" ? display.tool.output : "",
    asStr(display.tool.bashTail?.tail),
  ];
  for (const text of candidates) {
    const m = text ? LOOPBACK_URL_RE.exec(text) : null;
    if (!m) continue;
    try {
      return normalizeContainerPreviewUrl(m[0]).url;
    } catch {
      /* 非法 / 非容器地址：继续找下一处 */
    }
  }
  return null;
}

function CopyButton({ getText }: { getText: () => string }) {
  const toast = useToast();
  const [done, setDone] = useState(false);
  return (
    <IconButton
      aria-label="复制全文"
      title="复制全文"
      size="sm"
      shape="square"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(getText());
          setDone(true);
          toast("已复制全文", "success");
          setTimeout(() => setDone(false), 1500);
        } catch {
          toast("复制失败，请手动选中文本复制", "error");
        }
      }}
    >
      {done ? <Check size={15} /> : <Copy size={15} />}
    </IconButton>
  );
}

/** 当前步骤文案：in_progress 的 activeForm（无则 content）；否则首个未完成项 content。与 HUD 同口径。 */
export function currentStepText(todos: TodoItem[]): string {
  const active = todos.find((t) => t.status === "in_progress");
  if (active) return active.activeForm || active.content;
  const next = todos.find((t) => t.status !== "completed");
  return next?.content ?? "";
}

/** C 进度行的只读任务行（视觉与 PinnedTaskTracker 同源；TodoRow 未导出且归 M3-2，此处为最小实现）。 */
function ProgressRow({ t }: { t: TodoItem }) {
  const done = t.status === "completed";
  const active = t.status === "in_progress";
  return (
    <li className="flex items-start gap-2 text-body">
      {done ? (
        <Check size={14} className="mt-0.5 shrink-0 text-success" aria-hidden />
      ) : active ? (
        <LoaderCircle size={14} className="mt-0.5 shrink-0 animate-spin text-accent motion-reduce:animate-none" aria-hidden />
      ) : (
        <Circle size={14} className="mt-0.5 shrink-0 text-faint" aria-hidden />
      )}
      <span className={cn("min-w-0 flex-1", done ? "text-muted line-through" : active ? "text-fg" : "text-muted")}>
        {(active && t.activeForm) || t.content}
      </span>
    </li>
  );
}

export type AgentPanelContentProps = {
  target: ToolLike;
  mode: "follow" | "pinned";
  /** 本 turn 仍在进行（sending）：follow 模式显示「实时」。 */
  turnActive: boolean;
  k: number;
  n: number;
  /** 当前 turn 的任务源（extractLatestTodos）；空数组不渲染进度行。 */
  todos: TodoItem[];
  onPrev: () => void;
  onNext: () => void;
  onFollow: () => void;
  /** aside 形态才渲染折叠 / 关闭钮；Sheet 形态由 Sheet 自己的 X 关闭。 */
  variant: "aside" | "sheet";
  onClose?: () => void;
  onCollapse?: () => void;
  onOpenPreview?: (url: string) => void;
  /** 面板名 span 的 id，供 aside aria-labelledby。 */
  titleId?: string;
  /** M3-3 注入的「文件」页签内容；未注入不渲染 Tabs。 */
  filesTab?: ReactNode;
  /** 宿主写入的 aria-live 播报文本（仅 follow 目标切换时变化）。 */
  liveText?: string;
  /** 步进快捷键（←/→）由宿主决定是否挂；这里只在 aside 形态处理 */
  onArrowKey?: (delta: 1 | -1) => void;
  /** 目标身份键（宿主给 `${turnStart}:${targetIndex}`）：换目标时正文滚动归零。 */
  targetKey?: string;
};

function isEditable(node: EventTarget | null): boolean {
  if (!(node instanceof HTMLElement)) return false;
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || node.isContentEditable;
}

export function AgentPanelContent({
  target,
  mode,
  turnActive,
  k,
  n,
  todos,
  onPrev,
  onNext,
  onFollow,
  variant,
  onClose,
  onCollapse,
  onOpenPreview,
  titleId,
  filesTab,
  liveText,
  onArrowKey,
  targetKey,
}: AgentPanelContentProps) {
  const display = normalizeToolForDisplay(target);
  const meta = resolveToolMeta(display.name, display.input);
  const Icon = meta.icon;
  const summary = toolSummary(display.name, display.input);
  const status = resolveToolStatus(display);
  const kind = resolveActionKind(display.name, display.input);
  const previewUrl = onOpenPreview ? findContainerPreviewUrl(display) : null;
  const fallbackTitleId = useId();
  const nameId = titleId ?? fallbackTitleId;
  const progressId = useId();
  const [progressOpen, setProgressOpen] = useState(false);
  const [tab, setTab] = useState<"process" | "files">("process");
  const done = todos.filter((t) => t.status === "completed").length;
  const hasSteps = n > 0 && k > 0;
  const showLive = mode === "follow" && turnActive;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!onArrowKey || isEditable(e.target)) return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      onArrowKey(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      onArrowKey(1);
    }
  };

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-surface"
      data-agent-panel={variant === "aside" ? "desktop" : "sheet"}
      data-agent-panel-mode={mode}
      onKeyDown={onKeyDown}
    >
      {/* A 面板栏 */}
      <div
        className={cn(
          "flex h-9 shrink-0 items-center gap-2 border-b border-border px-3 header-safe-t",
          variant === "sheet" && "pr-12",
        )}
      >
        <span id={nameId} className="shrink-0 text-meta font-semibold text-muted">
          {S.panelName}
        </span>
        <Badge size="sm" tone={kind.tone} data-action-kind={kind.kind}>
          {kind.label}
        </Badge>
        {showLive && (
          <Badge size="sm" tone="accent">
            <span className="size-1.5 rounded-full bg-accent animate-pulse motion-reduce:animate-none" aria-hidden />
            {S.live}
          </Badge>
        )}
        {mode === "pinned" && (
          <Badge size="sm" tone="neutral">
            {S.pinned}
          </Badge>
        )}
        <div className="min-w-0 flex-1" />
        {mode === "pinned" && (
          <Button variant="ghost" size="sm" onClick={onFollow} data-agent-panel-follow="">
            <ChevronsRight size={14} />
            {S.backToLatest}
          </Button>
        )}
        <CopyButton getText={() => inspectorCopyText(normalizeToolForDisplay(target))} />
        {variant === "aside" && onCollapse && (
          <IconButton aria-label={S.collapse} title={S.collapse} size="sm" shape="square" onClick={onCollapse}>
            <PanelRightClose size={16} />
          </IconButton>
        )}
        {variant === "aside" && onClose && (
          <IconButton aria-label={S.close} title={S.close} size="sm" shape="square" data-inspector-close="" onClick={onClose}>
            <X size={16} />
          </IconButton>
        )}
      </div>

      {/* B 动作栏 */}
      <div className="flex min-h-11 shrink-0 items-center gap-2.5 border-b border-border px-4 py-2">
        <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-lg", toneTileClass(meta.tone))}>
          <Icon size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-body font-semibold text-fg">{meta.label}</h2>
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
            <div className="mt-0.5 truncate font-mono text-caption text-muted" title={summary}>
              {summary}
            </div>
          )}
        </div>
        {hasSteps && (
          <div className="flex shrink-0 items-center gap-0.5">
            <IconButton aria-label={S.prev} title={S.prev} size="sm" shape="square" disabled={k <= 1} onClick={onPrev}>
              <ChevronLeft size={16} />
            </IconButton>
            <span className="min-w-[3.5rem] text-center text-meta font-medium tabular-nums text-muted" data-agent-panel-step={`${k}/${n}`}>
              {stepLabel(k, n)}
            </span>
            <IconButton aria-label={S.next} title={S.next} size="sm" shape="square" disabled={k >= n} onClick={onNext}>
              <ChevronRight size={16} />
            </IconButton>
          </div>
        )}
      </div>

      {/* C 进度行（F2.2；无 todos 不渲染，F2.5） */}
      {todos.length > 0 && (
        <div className="shrink-0 border-b border-border">
          <button
            type="button"
            className="flex h-9 w-full items-center gap-2 px-3 text-left outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            aria-expanded={progressOpen}
            aria-controls={progressOpen ? progressId : undefined}
            aria-label={S.progressToggle}
            data-agent-panel-progress=""
            onClick={() => setProgressOpen((v) => !v)}
          >
            <ListChecks size={14} className="shrink-0 text-accent" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-body text-fg">
              <span className="text-meta text-muted tabular-nums">{progressLabel(done, todos.length, "")}</span>
              {currentStepText(todos) && <span className="text-fg"> · {currentStepText(todos)}</span>}
            </span>
            {progressOpen ? (
              <ChevronUp size={14} className="shrink-0 text-faint" aria-hidden />
            ) : (
              <ChevronDown size={14} className="shrink-0 text-faint" aria-hidden />
            )}
          </button>
          {progressOpen && (
            <ol id={progressId} className={HUD_LIST_CLS}>
              {todos.map((t, i) => (
                <ProgressRow key={`${i}-${t.content}`} t={t} />
              ))}
            </ol>
          )}
        </div>
      )}

      {/* Tabs（F3.3，M3-3 注入 filesTab 后出现） */}
      {filesTab != null && (
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v === "files" ? "files" : "process")}
          items={[
            { value: "process", label: S.tabProcess },
            { value: "files", label: S.tabFiles },
          ]}
          idBase="agent-panel"
          aria-label={S.tabsLabel}
          className="shrink-0 border-b border-border px-2"
        />
      )}

      {tab === "files" && filesTab != null ? (
        <div id="agent-panel-panel-files" role="tabpanel" className="min-h-0 flex-1 overflow-y-auto">
          {filesTab}
        </div>
      ) : (
        <>
          {previewUrl && (
            <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-elevated px-4">
              <Globe size={14} className="shrink-0 text-info" aria-hidden />
              <span className="min-w-0 flex-1 truncate font-mono text-caption text-muted" title={previewUrl}>
                {previewUrl}
              </span>
              <Button variant="subtle" size="sm" onClick={() => onOpenPreview?.(previewUrl)}>
                <ExternalLink size={14} />
                {S.openPreview}
              </Button>
            </div>
          )}
          <div
            key={targetKey ?? `${k}/${n}`}
            id={filesTab != null ? "agent-panel-panel-process" : undefined}
            role={filesTab != null ? "tabpanel" : undefined}
            className="min-h-0 flex-1 overflow-y-auto px-4 py-3 [&>*:first-child]:mt-0"
          >
            <ToolBodyFullContext.Provider value={true}>
              <ToolHeaderLabelContext.Provider value={meta.label}>
                <ToolBody name={display.name} input={display.input} tool={display.tool} />
              </ToolHeaderLabelContext.Provider>
            </ToolBodyFullContext.Provider>
          </div>
        </>
      )}

      <div className="sr-only" aria-live="polite" aria-atomic="true" data-agent-panel-live="">
        {liveText ?? ""}
      </div>
    </div>
  );
}
