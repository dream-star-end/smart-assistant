/**
 * 详情面板「产出」页(OCV5-372 / OCV5-834):
 * 参考 OpenAI Codex 重构为「清晰文件目录总览 ↔ 单文件精读 / Diff」两级体验：
 *   - 多产物轮次默认展示清爽的 Codex 文件清单总览（顶部汇总 `文件与产出 · N 项` + 总 `+add −del`），
 *     点击列表项平滑进入全出血精读 / Diff 预览，顶栏展示 `← 文件列表 (N)` + 文件名 + `‹ ›`；
 *   - 单产物轮次直接进入精读视图（零多点一次），移动端保持 2-Bar 全出血沉浸阅读；
 *   - 文件读取失败时展示优雅的人话提示（「重试读取」+「返回文件列表」），并自动隐藏底部「批注修改」。
 */
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileText,
  Globe,
  ImageIcon,
  Inbox,
  MessageSquarePlus,
  MonitorPlay,
} from "lucide-react";
import { type ReactNode, Suspense, lazy, useEffect, useState } from "react";
import { useViewportClass } from "../../hooks/useMdViewport";
import type { ChatMessage } from "../../lib/chat/model";
import { cn } from "../../lib/utils";
import type { ToolLike } from "../tool/format";
import { SegmentedControl, Skeleton, Spinner } from "../ui";
import type { TargetOutputRequest } from "./inspectorState";
import { useSignedSrc } from "./media";
import type { FilePreviewStatus } from "./OutputPreview";
import { DownloadButton, QuickAnnotateDrawer, WorkbenchEvidenceCard } from "./OutputsAuxParts";
import { type CompactHeroView, OutputsCompactBar } from "./OutputsCompactBar";
import { CopyIconButton, FileChangeEntryView, LineCounts } from "./paneParts";
import { FileOverflowMenu, WorkbenchBottomBar, useWorkbenchSheet } from "./WorkbenchBottomBar";
import {
  type DeliverableCategory,
  type HeroRef,
  type OutputFile,
  type OutputKind,
  type OutputMedia,
  type TurnOutputs,
  baseName,
  classifyDeliverable,
  collectTurnOutputs,
  displayDir,
  extOf,
  fileSnapshot,
  fileTouchFingerprint,
  formatDuration,
  matchesOutputPath,
  outputKindOf,
  pickHero,
  summarizeDeliverableCategories,
  turnSummary,
  turnTotalLineCounts,
} from "./workbench";
import type { WorkTurn } from "./workTurns";
import "./workbenchPreview.css";

const FilePreview = lazy(() => import("./OutputPreview").then((m) => ({ default: m.FilePreview })));
const MediaPreview = lazy(() => import("./OutputPreview").then((m) => ({ default: m.MediaPreview })));

type HeroView = "preview" | "source" | "changes";

/** 参考来源默认只列前几条,其余收在「显示全部」里:一次搜索常带回十来条,全列会把面板拉得很长。 */
const SOURCES_PREVIEW = 5;

const sectionLabel = "mb-2 flex items-center gap-1.5 text-caption font-medium text-faint";
const quietRow =
  "group flex w-full min-w-0 items-center gap-3 rounded-lg px-2.5 py-2 text-left outline-none transition-colors hover:bg-hover/80 focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11";

function ExtTile({ path, kind, className }: { path: string; kind: OutputKind; className?: string }) {
  const ext = extOf(path).slice(0, 4).toUpperCase() || "FILE";
  const badgeTone =
    kind === "html"
      ? "oc-icon-badge-accent"
      : kind === "markdown"
        ? "oc-icon-badge-info"
        : ext === "CSV" || ext === "TSV" || ext === "XLSX"
          ? "oc-icon-badge-success"
          : ext === "PDF"
            ? "oc-icon-badge-warning"
            : "oc-icon-badge";
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-md font-mono text-micro font-semibold tracking-tight",
        badgeTone,
        className,
      )}
    >
      {ext}
    </span>
  );
}

/** 本轮标题 + 翻轮 + 一行摘要(浏览器视图也用)。 */
export function TurnBar({
  turn,
  index,
  total,
  running,
  fileCount,
  onPrev,
  onNext,
}: {
  turn: WorkTurn;
  index: number;
  total: number;
  running: boolean;
  fileCount: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  const s = turnSummary(turn, running);
  const parts: ReactNode[] = [];
  if (s.durationMs !== null && !running) parts.push(`用时 ${formatDuration(s.durationMs)}`);
  if (s.steps > 0) parts.push(`${s.steps} 步${s.failedSteps > 0 ? `（${s.failedSteps} 步失败）` : ""}`);
  if (fileCount > 0) parts.push(`${fileCount} 个文件`);
  return (
    <div className="border-b border-border/60 px-4 pt-3 pb-2.5" data-testid="outputs-turn">
      <div className="mb-1.5 flex items-center gap-1.5 text-caption text-faint">
        <div className="oc-surface-recessed inline-flex items-center gap-0.5 rounded-full p-0.5">
          <button
            type="button"
            aria-label="上一轮"
            disabled={index <= 0}
            onClick={onPrev}
            className="oc-btn-tactile inline-flex size-5 items-center justify-center rounded-full outline-none transition-colors hover:bg-surface hover:text-fg focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-30"
          >
            <ChevronLeft size={13} />
          </button>
          <span className="px-1.5 font-medium tabular-nums text-muted" data-testid="outputs-turn-counter">
            第 {index + 1} / {total} 轮
          </span>
          <button
            type="button"
            aria-label="下一轮"
            disabled={index >= total - 1}
            onClick={onNext}
            className="oc-btn-tactile inline-flex size-5 items-center justify-center rounded-full outline-none transition-colors hover:bg-surface hover:text-fg focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-30"
          >
            <ChevronRight size={13} />
          </button>
        </div>
        <span className="flex-1" />
        {s.status === "running" ? (
          <span className="oc-badge-craft inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-0.5 font-medium text-accent">
            <Spinner size={11} />
            进行中
          </span>
        ) : s.status === "error" ? (
          <span className="oc-badge-craft rounded-full px-2.5 py-0.5 font-medium text-danger">出错</span>
        ) : null}
      </div>
      <h3 className="line-clamp-2 text-body font-semibold leading-snug tracking-tight text-fg" title={turn.title}>
        {turn.title}
      </h3>
      <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-caption text-faint" data-testid="outputs-summary">
        {parts.map((p, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 摘要片段按位置
          <span key={i} className="inline-flex items-center gap-1.5">
            {i > 0 && <span aria-hidden>·</span>}
            {p}
          </span>
        ))}
      </p>
    </div>
  );
}

function PreviewFallback() {
  return (
    <div className="space-y-2 px-5 py-5">
      <Skeleton className="h-3 w-2/3" />
      <Skeleton className="h-3 w-5/6" />
    </div>
  );
}

function computeHeroMeta(
  file: OutputFile,
  messages: readonly ChatMessage[],
  turnEnd: ChatMessage | undefined,
) {
  const replayed = fileSnapshot(messages, file.path, turnEnd);
  const meta = classifyDeliverable(file.path, replayed);
  const richPreview =
    meta.format === "csv" ||
    meta.format === "tsv" ||
    meta.format === "markdown" ||
    meta.format === "markdown-slides" ||
    meta.format === "pdf" ||
    meta.isBinaryOffice;
  const previewable = file.kind === "html" || richPreview;
  const textual = file.kind !== "file";
  const change = file.change;
  const options: { value: HeroView; label: string }[] = [
    ...(previewable ? [{ value: "preview" as const, label: "预览" }] : []),
    ...(textual ? [{ value: "source" as const, label: previewable ? "源码" : "内容" }] : []),
    ...(change ? [{ value: "changes" as const, label: `改动 ${change.entries.length}` }] : []),
  ];
  return { replayed, meta, richPreview, textual, change, options };
}

/** 主卡片:文件。移动端紧凑态全出血单滚动直出正文，读取失败时自动隐藏底部「批注修改」。 */
function FileHero({
  file,
  messages,
  turnEnd,
  compact = false,
  singleFileDesktop = false,
  controlledView,
  onControlledViewChange,
  showCompactViewInBar = false,
  onBackToList,
  onOpenStep,
  onAnnotateToComposer,
}: {
  file: OutputFile;
  messages: readonly ChatMessage[];
  turnEnd: ChatMessage | undefined;
  compact?: boolean;
  /** 桌面端单文件直达模式：头部附带文件改动摘要标识，免于下方重复列单文件卡片。 */
  singleFileDesktop?: boolean;
  controlledView?: HeroView | null;
  onControlledViewChange?: (v: HeroView) => void;
  showCompactViewInBar?: boolean;
  onBackToList?: () => void;
  onOpenStep: (message: ToolLike) => void;
  onAnnotateToComposer?: (draft: string) => void;
}) {
  // 不按 messages 引用记忆:流式期间消息就地增长,数组引用不变(同 collectPaneSteps,每次渲染重算)。
  const { replayed, meta, richPreview, textual, change, options } = computeHeroMeta(file, messages, turnEnd);
  const [chosen, setChosen] = useState<HeroView | null>(null);
  const [quickAnnotateOpen, setQuickAnnotateOpen] = useState(false);
  const [previewStatus, setPreviewStatus] = useState<FilePreviewStatus>(() =>
    replayed !== null ? "ready" : "loading",
  );
  const activeChosen = controlledView !== undefined ? controlledView : chosen;
  const setView = onControlledViewChange ?? setChosen;
  const view: HeroView =
    activeChosen && options.some((o) => o.value === activeChosen) ? activeChosen : (options[0]?.value ?? "changes");
  const usesRichBar = view === "preview" && richPreview;
  const isPreviewError = view !== "changes" && previewStatus === "error";
  const canAnnotate = !isPreviewError;
  const dir = displayDir(file.path);

  useEffect(() => {
    if (isPreviewError && quickAnnotateOpen) {
      setQuickAnnotateOpen(false);
    }
  }, [isPreviewError, quickAnnotateOpen]);

  const body = (
    <div
      className={cn(
        "[overflow-wrap:anywhere]",
        compact ? "flex min-h-0 flex-1 flex-col" : "min-h-24 overflow-x-auto",
      )}
      data-testid="outputs-hero-body"
    >
      {view === "changes" && change ? (
        <div className="space-y-5 px-4 py-3">
          {change.entries.map((entry, i) => (
            <FileChangeEntryView key={`${entry.message.id}:${i}`} entry={entry} n={i + 1} onOpenStep={onOpenStep} />
          ))}
        </div>
      ) : textual || richPreview ? (
        <Suspense fallback={<PreviewFallback />}>
          <FilePreview
            path={file.path}
            name={file.name}
            kind={file.kind}
            replayed={replayed}
            refreshKey={fileTouchFingerprint(messages, file.path)}
            view={view === "preview" ? "preview" : "source"}
            onAnnotateToComposer={onAnnotateToComposer}
            onBackToList={onBackToList}
            onStatusChange={setPreviewStatus}
          />
        </Suspense>
      ) : (
        <div className="px-5 py-8 text-center text-meta text-muted">这类文件不在面板里预览，可以下载查看。</div>
      )}
    </div>
  );

  if (compact) {
    const showCompactDock =
      !usesRichBar && (!isPreviewError || (showCompactViewInBar && options.length > 1));
    return (
      <article
        className="flex min-h-0 flex-1 flex-col bg-surface"
        data-testid="outputs-hero"
        data-compact="true"
        aria-label={`${meta.label} ${file.name}`}
      >
        {body}
        {showCompactDock && (
          <div className="wb-bottom-dock">
            {quickAnnotateOpen && canAnnotate && (
              <QuickAnnotateDrawer
                filePath={file.path}
                fileName={file.name}
                category={meta.category}
                onAnnotateToComposer={onAnnotateToComposer}
                onClose={() => setQuickAnnotateOpen(false)}
              />
            )}
            <WorkbenchBottomBar
              leading={
                showCompactViewInBar && options.length > 1 ? (
                  <div className="flex items-center gap-0.5" role="group" aria-label="查看方式">
                    {options.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        aria-pressed={opt.value === view}
                        onClick={() => setView(opt.value)}
                        className={cn(
                          "h-7 rounded-md px-2 text-caption font-medium transition-colors",
                          opt.value === view ? "bg-accent-soft text-accent" : "text-muted hover:bg-hover hover:text-fg",
                        )}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                ) : undefined
              }
              trailing={!isPreviewError ? <FileOverflowMenu path={file.path} name={file.name} /> : undefined}
              annotate={
                canAnnotate
                  ? {
                      label: "批注修改",
                      active: quickAnnotateOpen,
                      testId: "hero-quick-annotate",
                      onClick: () => setQuickAnnotateOpen((v) => !v),
                    }
                  : undefined
              }
            />
          </div>
        )}
      </article>
    );
  }

  return (
    <article
      className="flex min-h-0 flex-1 flex-col bg-surface"
      data-testid="outputs-hero"
      aria-label={`${meta.label} ${file.name}`}
    >
      <header
        className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/70 px-4 py-2.5"
        data-testid={singleFileDesktop ? "outputs-file" : undefined}
      >
        <ExtTile path={file.path} kind={file.kind} />
        <div className="min-w-32 flex-1" title={file.path}>
          <div className="flex items-center gap-2">
            <span className="truncate text-body font-semibold text-fg" data-testid="outputs-hero-name">
              {file.name}
            </span>
            {change?.hasError && <span className="shrink-0 text-caption font-medium text-danger">有失败</span>}
            {change && (change.hasCounts !== false || change.hasError) && (
              <LineCounts added={change.added} removed={change.removed} />
            )}
          </div>
          <div className="truncate text-caption text-faint">
            {[
              dir,
              change ? `${change.entries.length} 次改动` : meta.label,
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </div>
        {options.length > 1 && (
          <SegmentedControl
            className="ml-auto"
            size="sm"
            value={view}
            onValueChange={(v) => setView(v)}
            options={options}
            aria-label="查看方式"
          />
        )}
      </header>
      {body}
      {quickAnnotateOpen && !usesRichBar && canAnnotate && (
        <QuickAnnotateDrawer
          filePath={file.path}
          fileName={file.name}
          category={meta.category}
          onAnnotateToComposer={onAnnotateToComposer}
          onClose={() => setQuickAnnotateOpen(false)}
        />
      )}
      <footer className="flex items-center gap-2 border-t border-border/70 bg-hover/15 px-4 py-2 text-caption text-faint">
        <span className="min-w-0 flex-1 truncate" data-testid="outputs-hero-origin">
          {view === "changes"
            ? `${change?.entries.length ?? 0} 次改动`
            : !textual
              ? meta.label
              : replayed !== null
                ? "内容来自会话记录"
                : "容器里的当前文件"}
        </span>
        {!usesRichBar && canAnnotate && (
          <button
            type="button"
            data-testid="hero-quick-annotate"
            onClick={() => setQuickAnnotateOpen((v) => !v)}
            className="oc-btn-tactile inline-flex min-h-7 items-center gap-1 rounded-md px-2 text-caption font-medium text-accent outline-none transition-colors hover:bg-accent-soft focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11"
          >
            <MessageSquarePlus size={12} aria-hidden />
            批注修改
          </button>
        )}
        <CopyIconButton getText={() => file.path} label="复制路径" doneText="已复制路径" />
        {!isPreviewError && file.path.startsWith("/") && <DownloadButton path={file.path} name={file.name} />}
      </footer>
    </article>
  );
}

function MediaHero({
  media,
  compact = false,
  onAnnotateToComposer,
}: {
  media: OutputMedia;
  compact?: boolean;
  onAnnotateToComposer?: (draft: string) => void;
}) {
  const [annotateOpen, setAnnotateOpen] = useState(false);
  if (compact) {
    return (
      <article className="flex min-h-0 flex-1 flex-col bg-surface" data-testid="outputs-hero" data-compact="true" aria-label={`图片 ${media.name}`}>
        <div className="flex-1">
          <Suspense fallback={<PreviewFallback />}>
            <MediaPreview src={media.src} kind={media.kind} name={media.name} />
          </Suspense>
        </div>
        <div className="wb-bottom-dock">
          {annotateOpen && (
            <QuickAnnotateDrawer
              filePath={media.src}
              fileName={media.name}
              category="media"
              onAnnotateToComposer={onAnnotateToComposer}
              onClose={() => setAnnotateOpen(false)}
            />
          )}
          <WorkbenchBottomBar
            trailing={<FileOverflowMenu path={media.src} name={media.name} showOpenInNewWindow={false} />}
            annotate={{
              label: "批注修改",
              active: annotateOpen,
              testId: "hero-quick-annotate",
              onClick: () => setAnnotateOpen((v) => !v),
            }}
          />
        </div>
      </article>
    );
  }
  return (
    <article className="flex min-h-0 flex-1 flex-col bg-surface" data-testid="outputs-hero" aria-label={`图片 ${media.name}`}>
      <Suspense fallback={<PreviewFallback />}>
        <MediaPreview src={media.src} kind={media.kind} name={media.name} />
      </Suspense>
      {annotateOpen && (
        <QuickAnnotateDrawer
          filePath={media.src}
          fileName={media.name}
          category="media"
          onAnnotateToComposer={onAnnotateToComposer}
          onClose={() => setAnnotateOpen(false)}
        />
      )}
      <footer className="flex items-center gap-2 border-t border-border/70 bg-hover/15 px-4 py-2 text-caption text-faint">
        <span className="min-w-0 flex-1 truncate font-medium text-fg" data-testid="outputs-hero-name" title={media.src}>
          {media.name}
        </span>
        <button
          type="button"
          data-testid="hero-quick-annotate"
          onClick={() => setAnnotateOpen((v) => !v)}
          className="oc-btn-tactile inline-flex min-h-7 items-center gap-1 rounded-md px-2 text-caption font-medium text-accent outline-none transition-colors hover:bg-accent-soft focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11"
        >
          <MessageSquarePlus size={12} aria-hidden />
          批注修改
        </button>
        <CopyIconButton getText={() => media.src} label="复制路径" doneText="已复制路径" />
        {media.src.startsWith("/") && <DownloadButton path={media.src} name={media.name} />}
      </footer>
    </article>
  );
}

function Thumb({ media, active, onPick }: { media: OutputMedia; active: boolean; onPick: () => void }) {
  const { url, onError } = useSignedSrc(media.kind === "image" ? media.src : null);
  return (
    <button
      type="button"
      onClick={onPick}
      aria-label={`查看 ${media.name}`}
      aria-pressed={active}
      data-testid="outputs-media"
      className={cn(
        "relative aspect-square overflow-hidden rounded-lg border bg-hover outline-none transition focus-visible:ring-2 focus-visible:ring-ring",
        active ? "border-accent ring-2 ring-accent/25" : "border-border/70 hover:border-border-strong",
      )}
    >
      {url ? (
        <img src={url} alt="" onError={onError} className="size-full object-cover" loading="lazy" />
      ) : (
        <span className="flex size-full items-center justify-center text-faint">
          <ImageIcon size={16} />
        </span>
      )}
    </button>
  );
}

function Section({
  icon: Icon,
  title,
  count,
  children,
  testId,
  flush = false,
}: {
  icon: typeof Globe;
  title: string;
  count: number;
  children: ReactNode;
  testId: string;
  flush?: boolean;
}) {
  return (
    <section data-testid={testId} className={cn(!flush && "px-4")}>
      <h4 className={cn(sectionLabel, flush && "px-4")}>
        <Icon size={12} aria-hidden />
        {title}
        <span className="tabular-nums font-normal">{count}</span>
      </h4>
      {children}
    </section>
  );
}

function DeliverableSummaryStrip({
  outputs,
  activeCategory,
  onSelectCategory,
}: {
  outputs: TurnOutputs;
  activeCategory: DeliverableCategory | "all";
  onSelectCategory: (cat: DeliverableCategory | "all") => void;
}) {
  const counts = summarizeDeliverableCategories(outputs.files, outputs.media.length);
  const total = outputs.files.length + outputs.media.length;
  // 只有至少 2 种不同类型的交付物时才展示筛选条，避免单文件出现「全部 1 / 文件 1」冗余噪音。
  if (total === 0 || counts.length < 2) return null;

  return (
    <div
      className="flex flex-nowrap items-center gap-1 overflow-x-auto border-b border-border/60 px-4 py-2 [scrollbar-width:none]"
      role="group"
      aria-label="交付物按类型汇总与筛选"
      data-testid="outputs-summary-strip"
    >
      <div className="oc-surface-recessed inline-flex items-center gap-0.5 rounded-lg p-0.5">
        <button
          type="button"
          aria-pressed={activeCategory === "all"}
          data-testid="outputs-filter-all"
          onClick={() => onSelectCategory("all")}
          className={cn(
            "oc-btn-tactile inline-flex h-7 shrink-0 items-center gap-1 rounded-sm px-2.5 text-caption font-medium whitespace-nowrap outline-none transition-all focus-visible:ring-2 focus-visible:ring-ring",
            activeCategory === "all"
              ? "oc-segmented-thumb text-accent"
              : "text-muted hover:text-fg",
          )}
        >
          全部
          <span className="tabular-nums opacity-80">{total}</span>
        </button>
        {counts.map((c) => {
          const active = activeCategory === c.category;
          return (
            <button
              key={c.category}
              type="button"
              aria-pressed={active}
              data-testid={`outputs-filter-${c.category}`}
              onClick={() => onSelectCategory(active ? "all" : c.category)}
              className={cn(
                "oc-btn-tactile inline-flex h-7 shrink-0 items-center gap-1 rounded-sm px-2.5 text-caption font-medium whitespace-nowrap outline-none transition-all focus-visible:ring-2 focus-visible:ring-ring",
                active
                  ? "oc-segmented-thumb text-accent"
                  : "text-muted hover:text-fg",
              )}
            >
              {c.label}
              <span className="tabular-nums opacity-80">{c.count}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Codex 风格清爽文件目录总览：顶行汇总 `文件与产出 · N 项` + `+add −del`，发丝分隔文件行 + 媒体/链接/来源。 */
function DirectoryOverview({
  outputs,
  hero,
  activeCategory,
  compact,
  turnIndex,
  turnTotal,
  onPrevTurn,
  onNextTurn,
  onSelectCategory,
  onPick,
  includeFilesAndMedia = true,
}: {
  outputs: TurnOutputs;
  hero: HeroRef | null;
  activeCategory: DeliverableCategory | "all";
  compact: boolean;
  turnIndex: number;
  turnTotal: number;
  onPrevTurn: () => void;
  onNextTurn: () => void;
  onSelectCategory: (cat: DeliverableCategory | "all") => void;
  onPick: (ref: HeroRef) => void;
  includeFilesAndMedia?: boolean;
}) {
  const { files, media, links, sources } = outputs;
  const [allSources, setAllSources] = useState(false);
  const shownSources = allSources ? sources : sources.slice(0, SOURCES_PREVIEW);
  const deliverableTotal = files.length + media.length;
  const totals = turnTotalLineCounts(files);

  const filteredFiles =
    activeCategory === "all"
      ? files
      : activeCategory === "media"
        ? []
        : files.filter((f) => classifyDeliverable(f.path).category === activeCategory);
  const showMedia = activeCategory === "all" || activeCategory === "media";

  return (
    <div className="flex flex-1 flex-col" data-testid={includeFilesAndMedia ? "outputs-directory" : undefined}>
      {includeFilesAndMedia && deliverableTotal > 0 && (
        <>
          <div
            className="flex min-h-10 shrink-0 items-center gap-2 border-b border-border/60 bg-bg/35 px-4 py-2 text-caption"
            data-testid="outputs-directory-header"
          >
            <span className="font-medium text-fg">
              文件与产出 · <span className="tabular-nums">{deliverableTotal}</span> 项
            </span>
            {totals.hasCounts && (
              <LineCounts added={totals.added} removed={totals.removed} />
            )}
            <span className="flex-1" />
            {compact && turnTotal > 1 && (
              <div className="oc-surface-recessed inline-flex shrink-0 items-center gap-0.5 rounded-md p-0.5">
                <button
                  type="button"
                  aria-label="上一轮"
                  disabled={turnIndex <= 0}
                  onClick={onPrevTurn}
                  className="oc-btn-tactile inline-flex size-5 items-center justify-center rounded-xs text-muted outline-none hover:bg-surface hover:text-fg focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-30"
                >
                  <ChevronLeft size={12} />
                </button>
                <span className="px-1.5 font-medium tabular-nums text-fg" data-testid="outputs-turn-counter">
                  第 {turnIndex + 1}/{turnTotal} 轮
                </span>
                <button
                  type="button"
                  aria-label="下一轮"
                  disabled={turnIndex >= turnTotal - 1}
                  onClick={onNextTurn}
                  className="oc-btn-tactile inline-flex size-5 items-center justify-center rounded-xs text-muted outline-none hover:bg-surface hover:text-fg focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-30"
                >
                  <ChevronRight size={12} />
                </button>
              </div>
            )}
          </div>
          <DeliverableSummaryStrip
            outputs={outputs}
            activeCategory={activeCategory}
            onSelectCategory={onSelectCategory}
          />
        </>
      )}

      <div className="space-y-5 pb-6">
        {includeFilesAndMedia && filteredFiles.length > 0 && (
          <section data-testid="outputs-files">
            <ul className="divide-y divide-border/55 border-b border-border/60">
              {filteredFiles.map((f) => {
                const active = hero?.type === "file" && hero.path === f.path;
                const meta = classifyDeliverable(f.path);
                const dir = displayDir(f.path);
                const subline = [
                  dir,
                  f.change ? `${f.change.entries.length} 次改动` : meta.label,
                ]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <li key={f.path}>
                    <button
                      type="button"
                      data-testid="outputs-file"
                      aria-current={active ? "true" : undefined}
                      className={cn(
                        "wb-dir-row group",
                        active && "bg-accent-soft/50",
                      )}
                      onClick={() => onPick({ type: "file", path: f.path })}
                      title={f.path}
                    >
                      <ExtTile path={f.path} kind={f.kind} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-body font-medium text-fg">{f.name}</span>
                        <span className="block truncate text-caption text-faint">{subline}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2 text-caption">
                        {f.change?.running && <Spinner size={12} className="text-accent" />}
                        {f.change?.hasError && <span className="font-medium text-danger">有失败</span>}
                        {f.change && (f.change.hasCounts !== false || f.change.hasError) ? (
                          <LineCounts added={f.change.added} removed={f.change.removed} />
                        ) : (
                          <span className="wb-type-pill">{meta.shortBadge}</span>
                        )}
                        <ChevronRight
                          size={14}
                          aria-hidden
                          className="text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-muted"
                        />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {includeFilesAndMedia && showMedia && media.length > 0 && (
          <div className="pt-3">
            <Section icon={ImageIcon} title="图片与媒体" count={media.length} testId="outputs-media-grid">
              <div className="grid grid-cols-3 gap-2">
                {media.map((m) => (
                  <Thumb
                    key={m.src}
                    media={m}
                    active={hero?.type === "media" && hero.src === m.src}
                    onPick={() => onPick({ type: "media", src: m.src })}
                  />
                ))}
              </div>
            </Section>
          </div>
        )}

        {links.length > 0 && (
          <div className="pt-3">
            <Section icon={MonitorPlay} title="本机预览" count={links.length} testId="outputs-links">
              <ul className="divide-y divide-border/55 overflow-hidden rounded-lg border border-border/70">
                {links.map((l) => (
                  <li key={l.url}>
                    {/* 普通链接:App 的全局点击监听会把容器回环地址交给「容器预览」打开。 */}
                    <a
                      href={l.url}
                      className="group flex w-full min-w-0 items-center gap-3 px-3 py-2.5 text-left outline-none transition-colors hover:bg-hover/70 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [@media(hover:none)]:min-h-11"
                      data-testid="outputs-link"
                    >
                      <span className="oc-icon-badge-accent flex size-7 shrink-0 items-center justify-center rounded-md">
                        <MonitorPlay size={14} strokeWidth={1.75} />
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-meta font-medium text-fg">{l.label}</span>
                      <span className="shrink-0 text-caption font-medium text-accent">打开预览</span>
                    </a>
                  </li>
                ))}
              </ul>
            </Section>
          </div>
        )}

        {sources.length > 0 && (
          <div className="pt-3">
            <Section icon={Globe} title="参考来源" count={sources.length} testId="outputs-sources">
              <ul className="divide-y divide-border/55 overflow-hidden rounded-lg border border-border/70 p-0.5">
                {shownSources.map((s) => (
                  <li key={s.url} data-container-preview-ignore="">
                    <a href={s.url} target="_blank" rel="noopener noreferrer" className={quietRow} data-testid="outputs-source" title={s.url}>
                      <span
                        aria-hidden
                        className="oc-icon-badge flex size-6 shrink-0 items-center justify-center rounded-full text-caption font-semibold uppercase text-muted"
                      >
                        {s.domain.slice(0, 1)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-body font-medium text-fg">{s.title}</span>
                        <span className="block truncate text-caption text-faint">{s.domain}</span>
                      </span>
                      <ExternalLink size={13} className="shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
                    </a>
                  </li>
                ))}
              </ul>
              {sources.length > SOURCES_PREVIEW && (
                <button
                  type="button"
                  onClick={() => setAllSources((v) => !v)}
                  aria-expanded={allSources}
                  data-testid="outputs-sources-more"
                  className="oc-btn-tactile mt-2 rounded-full px-2.5 py-1 text-meta font-medium text-muted outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {allSources ? "收起" : `显示全部 ${sources.length} 条`}
                </button>
              )}
            </Section>
          </div>
        )}
      </div>
    </div>
  );
}

function buildAdHocTarget(target: TargetOutputRequest): { file?: OutputFile; media?: OutputMedia } {
  const rawPath = target.path?.trim();
  if (!rawPath) return {};
  const name = target.title?.trim() || baseName(rawPath);
  const ext = extOf(rawPath);
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"].includes(ext)) {
    return { media: { src: rawPath, kind: "image", name } };
  }
  if (["mp4", "webm", "mov", "mkv"].includes(ext)) {
    return { media: { src: rawPath, kind: "video", name } };
  }
  if (["mp3", "wav", "ogg", "m4a", "flac", "aac"].includes(ext)) {
    return { media: { src: rawPath, kind: "audio", name } };
  }
  return {
    file: {
      path: rawPath,
      name,
      kind: outputKindOf(rawPath),
    },
  };
}

export function OutputsView({
  messages,
  turns,
  index,
  running,
  targetOutput,
  onSelectTurn,
  onOpenStep,
  onAnnotateToComposer,
}: {
  messages: readonly ChatMessage[];
  turns: readonly WorkTurn[];
  /** 正在看的那一轮(下标)。 */
  index: number;
  /** 正在看的这一轮是否仍在进行。 */
  running: boolean;
  /** 从对话文件卡 / 科研报告 / 智能 UI 交付物卡外部直达的目标产物定位请求。 */
  targetOutput?: TargetOutputRequest | null;
  onSelectTurn: (index: number) => void;
  onOpenStep: (message: ToolLike) => void;
  /** 可选：批注回填至 Composer 输入框的回调。 */
  onAnnotateToComposer?: (draft: string) => void;
}) {
  const isCompact = useWorkbenchSheet() || useViewportClass() === "compact";
  const turn = turns[index];
  if (!turn) {
    if (targetOutput?.path || targetOutput?.manifestSrc) {
      const adHoc = buildAdHocTarget(targetOutput);
      return (
        <div
          className="flex min-h-0 flex-1 flex-col overflow-y-auto"
          data-testid="outputs-view"
        >
          {adHoc.file && (
            <div className="flex min-h-0 flex-1 flex-col">
              <FileHero
                key={adHoc.file.path}
                file={adHoc.file}
                messages={messages}
                turnEnd={undefined}
                compact={isCompact}
                showCompactViewInBar={isCompact}
                onOpenStep={onOpenStep}
                onAnnotateToComposer={onAnnotateToComposer}
              />
            </div>
          )}
          {adHoc.media && (
            <div className="flex min-h-0 flex-1 flex-col">
              <MediaHero media={adHoc.media} compact={isCompact} onAnnotateToComposer={onAnnotateToComposer} />
            </div>
          )}
          {targetOutput.manifestSrc && <WorkbenchEvidenceCard manifestSrc={targetOutput.manifestSrc} />}
        </div>
      );
    }
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 text-center" data-testid="outputs-empty">
        <div className="flex max-w-xs flex-col items-center gap-2.5 px-4 py-6">
          <span className="oc-icon-badge flex size-10 items-center justify-center rounded-xl text-faint" aria-hidden>
            <Inbox size={19} strokeWidth={1.75} />
          </span>
          <p className="text-body font-semibold text-fg">还没有产出</p>
          <p className="text-meta leading-relaxed text-muted">助手写的文件、生成的图片、查过的网页会按轮汇总在这里。</p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="outputs-view">
      {/* key:换轮时主卡片的视图选择从头来。 */}
      <TurnOutputsBody
        key={turn.key}
        messages={messages}
        turn={turn}
        index={index}
        total={turns.length}
        running={running}
        compact={isCompact}
        targetOutput={targetOutput}
        onSelectTurn={onSelectTurn}
        onOpenStep={onOpenStep}
        onAnnotateToComposer={onAnnotateToComposer}
      />
    </div>
  );
}

function TurnOutputsBody({
  messages,
  turn,
  index,
  total,
  running,
  compact,
  targetOutput,
  onSelectTurn,
  onOpenStep,
  onAnnotateToComposer,
}: {
  messages: readonly ChatMessage[];
  turn: WorkTurn;
  index: number;
  total: number;
  running: boolean;
  compact: boolean;
  targetOutput?: TargetOutputRequest | null;
  onSelectTurn: (index: number) => void;
  onOpenStep: (message: ToolLike) => void;
  onAnnotateToComposer?: (draft: string) => void;
}) {
  const outputs = collectTurnOutputs(turn);
  const [picked, setPicked] = useState<HeroRef | null>(null);
  const [adHocTarget, setAdHocTarget] = useState<TargetOutputRequest | null>(null);
  const [activeCategory, setActiveCategory] = useState<DeliverableCategory | "all">("all");
  const [compactView, setCompactView] = useState<{ path: string; view: CompactHeroView } | null>(null);

  // 响应从主对话文件卡 / 科研报告 / 智能 UI 交付物卡点进来的精确定位请求。
  useEffect(() => {
    if (!targetOutput) return;
    setActiveCategory("all");
    const targetPath = targetOutput.path?.trim();
    if (targetPath) {
      const matchedFile = outputs.files.find((f) => matchesOutputPath(f.path, targetPath));
      if (matchedFile) {
        setPicked({ type: "file", path: matchedFile.path });
        setAdHocTarget(targetOutput.manifestSrc ? targetOutput : null);
        return;
      }
      const matchedMedia = outputs.media.find((m) => matchesOutputPath(m.src, targetPath));
      if (matchedMedia) {
        setPicked({ type: "media", src: matchedMedia.src });
        setAdHocTarget(targetOutput.manifestSrc ? targetOutput : null);
        return;
      }
      setPicked(null);
      setAdHocTarget(targetOutput);
    } else if (targetOutput.manifestSrc) {
      setAdHocTarget(targetOutput);
    }
    // biome-ignore lint/correctness/useExhaustiveDependencies: 仅响应新的定位请求 nonce，避免流式重渲覆盖用户手选
  }, [targetOutput?.nonce]);

  const deliverableCount = outputs.files.length + outputs.media.length;
  const multiDeliverable = deliverableCount > 1;
  const valid =
    picked &&
    (picked.type === "file"
      ? outputs.files.some((f) => f.path === picked.path)
      : outputs.media.some((m) => m.src === picked.src));
  const adHoc = !valid && adHocTarget?.path ? buildAdHocTarget(adHocTarget) : {};

  // 两级体验核心：多产物默认停在 Codex 文件目录总览（不盲翻）；单产物或显式选中直接进精读视图。
  const inDetail = !multiDeliverable || Boolean(valid) || Boolean(adHoc.file || adHoc.media);
  const hero = inDetail ? (valid ? picked : adHoc.file || adHoc.media ? null : pickHero(outputs)) : null;
  const heroFile =
    hero?.type === "file"
      ? outputs.files.find((f) => f.path === hero.path)
      : adHoc.file;
  const heroMedia =
    hero?.type === "media"
      ? outputs.media.find((m) => m.src === hero.src)
      : adHoc.media;
  const turnEnd = turn.rows.at(-1);
  const empty = deliverableCount + outputs.links.length + outputs.sources.length === 0;
  const fileCount = outputs.files.filter((f) => f.change).length;
  const activeManifestSrc = adHocTarget?.manifestSrc ?? null;

  const compactHeroMeta = compact && heroFile ? computeHeroMeta(heroFile, messages, turnEnd) : null;
  const activeCompactView =
    compactHeroMeta && heroFile
      ? compactView?.path === heroFile.path && compactHeroMeta.options.some((o) => o.value === compactView.view)
        ? compactView.view
        : (compactHeroMeta.options[0]?.value ?? "changes")
      : undefined;

  const backToList = multiDeliverable
    ? () => {
        setPicked(null);
        setAdHocTarget(null);
      }
    : undefined;

  const showDetailNavBar =
    (inDetail && Boolean(heroFile || heroMedia) && (Boolean(backToList) || (compact && total > 1))) ||
    (compact && total > 1 && empty && !activeManifestSrc);

  // 单产物 + 存在本机预览链接/参考来源时，在精读视图下方展示非重复的链接与来源
  const showAuxLinksOrSources =
    inDetail && !multiDeliverable && (outputs.links.length > 0 || outputs.sources.length > 0);

  return (
    <>
      {!compact && (
        <TurnBar
          turn={turn}
          index={index}
          total={total}
          running={running}
          fileCount={fileCount}
          onPrev={() => onSelectTurn(index - 1)}
          onNext={() => onSelectTurn(index + 1)}
        />
      )}

      {showDetailNavBar && (
        <OutputsCompactBar
          turnIndex={index}
          turnTotal={total}
          onPrevTurn={() => onSelectTurn(index - 1)}
          onNextTurn={() => onSelectTurn(index + 1)}
          outputs={outputs}
          hero={hero}
          heroName={heroFile?.name ?? heroMedia?.name}
          showFileName={compact}
          onBackToList={backToList}
          onPick={(ref) => {
            setAdHocTarget(null);
            setPicked(ref);
          }}
          view={compact ? activeCompactView : undefined}
          viewOptions={compact ? compactHeroMeta?.options : undefined}
          onChangeView={compact && heroFile ? (v) => setCompactView({ path: heroFile.path, view: v }) : undefined}
        />
      )}

      {inDetail && (heroFile || heroMedia) ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {heroFile ? (
            <FileHero
              key={heroFile.path}
              file={heroFile}
              messages={messages}
              turnEnd={turnEnd}
              compact={compact}
              singleFileDesktop={!compact && !multiDeliverable}
              controlledView={compact ? (activeCompactView ?? null) : undefined}
              onControlledViewChange={compact ? (v) => setCompactView({ path: heroFile.path, view: v }) : undefined}
              showCompactViewInBar={compact && !showDetailNavBar}
              onBackToList={backToList}
              onOpenStep={onOpenStep}
              onAnnotateToComposer={onAnnotateToComposer}
            />
          ) : heroMedia ? (
            <MediaHero media={heroMedia} compact={compact} onAnnotateToComposer={onAnnotateToComposer} />
          ) : null}
          {showAuxLinksOrSources && (
            <DirectoryOverview
              outputs={outputs}
              hero={hero}
              activeCategory="all"
              compact={compact}
              turnIndex={index}
              turnTotal={total}
              onPrevTurn={() => onSelectTurn(index - 1)}
              onNextTurn={() => onSelectTurn(index + 1)}
              onSelectCategory={setActiveCategory}
              onPick={(ref) => {
                setAdHocTarget(null);
                setPicked(ref);
              }}
              includeFilesAndMedia={false}
            />
          )}
        </div>
      ) : !empty ? (
        <DirectoryOverview
          outputs={outputs}
          hero={hero}
          activeCategory={activeCategory}
          compact={compact}
          turnIndex={index}
          turnTotal={total}
          onPrevTurn={() => onSelectTurn(index - 1)}
          onNextTurn={() => onSelectTurn(index + 1)}
          onSelectCategory={setActiveCategory}
          onPick={(ref) => {
            setAdHocTarget(null);
            setPicked(ref);
          }}
        />
      ) : !activeManifestSrc ? (
        <div
          className="flex flex-1 flex-col items-center justify-center gap-2.5 px-6 py-12 text-center"
          data-testid="outputs-none"
        >
          <span
            className={cn(
              "flex size-10 items-center justify-center rounded-xl",
              running ? "oc-icon-badge-accent" : "oc-icon-badge text-faint",
            )}
            aria-hidden
          >
            {running ? <Spinner size={18} className="text-accent" /> : <FileText size={19} strokeWidth={1.75} />}
          </span>
          <p className="text-body font-semibold text-fg">{running ? "这一轮还在进行" : "这一轮没有产出文件"}</p>
          <p className="max-w-xs text-meta leading-relaxed text-muted">
            {running ? "写出的文件、生成的图片和查过的网页会出现在这里。" : "回答在左侧对话里；展开左侧完成摘要即可查看本轮执行过程。"}
          </p>
        </div>
      ) : null}

      {activeManifestSrc && <WorkbenchEvidenceCard manifestSrc={activeManifestSrc} />}
    </>
  );
}
