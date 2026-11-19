/**
 * 详情面板「产出」页(OCV5-372):一轮对话的工作成果 —— 主产物直接渲染在卡片里,其余产出
 * (文件 / 图片 / 本机预览链接 / 参考来源)列在下面,步骤退到一行摘要后的「查看步骤」。
 * 数据全部来自 workbench.ts 的纯函数;正文渲染在懒加载块 OutputPreview 里,不进首屏。
 */
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileCode2,
  FileText,
  Globe,
  ImageIcon,
  Inbox,
  MessageSquarePlus,
  MonitorPlay,
  Send,
  X,
} from "lucide-react";
import { type ReactNode, Suspense, lazy, useState } from "react";
import type { ChatMessage } from "../../lib/chat/model";
import { cn } from "../../lib/utils";
import type { ToolLike } from "../tool/format";
import { Button, IconButton, SegmentedControl, Skeleton, Spinner, useToast } from "../ui";
import { buildAnnotationPrompt } from "./deliverablePreview";
import { useSignedDownload, useSignedSrc } from "./media";
import { CopyIconButton, FileChangeEntryView, LineCounts } from "./paneParts";
import {
  type DeliverableCategory,
  type HeroRef,
  type OutputFile,
  type OutputKind,
  type OutputMedia,
  type TurnOutputs,
  classifyDeliverable,
  collectTurnOutputs,
  displayDir,
  extOf,
  fileSnapshot,
  fileTouchFingerprint,
  formatDuration,
  pickHero,
  summarizeDeliverableCategories,
  turnSummary,
} from "./workbench";
import type { WorkTurn } from "./workTurns";

const FilePreview = lazy(() => import("./OutputPreview").then((m) => ({ default: m.FilePreview })));
const MediaPreview = lazy(() => import("./OutputPreview").then((m) => ({ default: m.MediaPreview })));

type HeroView = "preview" | "source" | "changes";

/** 参考来源默认只列前几条,其余收在「显示全部」里:一次搜索常带回十来条,全列会把面板拉得很长。 */
const SOURCES_PREVIEW = 5;

const sectionLabel = "mb-2 flex items-center gap-1.5 text-caption font-medium uppercase tracking-wide text-faint";
const quietRow =
  "group flex w-full min-w-0 items-center gap-3 rounded-lg px-2 py-2 text-left outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11";

function ExtTile({ path, kind, className }: { path: string; kind: OutputKind; className?: string }) {
  const ext = extOf(path).slice(0, 4).toUpperCase() || "FILE";
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-md border border-border/70 bg-surface font-mono text-[9.5px] font-semibold tracking-tight",
        kind === "html" ? "text-accent" : kind === "markdown" ? "text-info" : "text-muted",
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
  onOpenSteps,
}: {
  turn: WorkTurn;
  index: number;
  total: number;
  running: boolean;
  fileCount: number;
  onPrev: () => void;
  onNext: () => void;
  onOpenSteps: () => void;
}) {
  const s = turnSummary(turn, running);
  const parts: ReactNode[] = [];
  if (s.durationMs !== null && !running) parts.push(`用时 ${formatDuration(s.durationMs)}`);
  if (s.steps > 0) parts.push(`${s.steps} 步${s.failedSteps > 0 ? `（${s.failedSteps} 步失败）` : ""}`);
  if (fileCount > 0) parts.push(`${fileCount} 个文件`);
  return (
    <div className="px-4 pt-4 pb-3" data-testid="outputs-turn">
      <div className="mb-1.5 flex items-center gap-1 text-caption text-faint">
        <button
          type="button"
          aria-label="上一轮"
          disabled={index <= 0}
          onClick={onPrev}
          className="rounded-full p-1 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-30"
        >
          <ChevronLeft size={14} />
        </button>
        <span className="tabular-nums" data-testid="outputs-turn-counter">
          第 {index + 1} / {total} 轮
        </span>
        <button
          type="button"
          aria-label="下一轮"
          disabled={index >= total - 1}
          onClick={onNext}
          className="rounded-full p-1 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-30"
        >
          <ChevronRight size={14} />
        </button>
        <span className="flex-1" />
        {s.status === "running" ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-2 py-0.5 text-accent">
            <Spinner size={11} />
            进行中
          </span>
        ) : s.status === "error" ? (
          <span className="rounded-full bg-danger-soft px-2 py-0.5 text-danger">出错</span>
        ) : null}
      </div>
      <h3 className="line-clamp-2 text-section font-semibold leading-snug text-fg" title={turn.title}>
        {turn.title}
      </h3>
      <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-meta text-faint" data-testid="outputs-summary">
        {parts.map((p, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 摘要片段按位置
          <span key={i} className="inline-flex items-center gap-1.5">
            {i > 0 && <span aria-hidden>·</span>}
            {p}
          </span>
        ))}
        {s.steps > 0 && (
          <button
            type="button"
            onClick={onOpenSteps}
            data-testid="outputs-open-steps"
            className={cn(
              "inline-flex items-center rounded text-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-ring",
              parts.length > 0 && "ml-1",
            )}
          >
            查看步骤
            <ChevronRight size={13} aria-hidden />
          </button>
        )}
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

function DownloadButton({ path, name }: { path: string; name: string }) {
  const { state, start } = useSignedDownload(path, name);
  const busy = state.phase === "downloading";
  return (
    <button
      type="button"
      aria-label={`下载 ${name}`}
      title="下载"
      onClick={() => void start()}
      disabled={busy}
      className="inline-flex size-7 items-center justify-center rounded-md text-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
    >
      {busy ? <Spinner size={13} /> : <Download size={15} />}
    </button>
  );
}

/** 非富预览视图（HTML / 代码 / 改动 / 媒体）的快捷批注回填条。 */
function QuickAnnotateDrawer({
  filePath,
  fileName,
  category,
  onAnnotateToComposer,
  onClose,
}: {
  filePath: string;
  fileName: string;
  category: DeliverableCategory;
  onAnnotateToComposer?: (draft: string) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const [comment, setComment] = useState("");
  const [lineRef, setLineRef] = useState("");

  const submit = async () => {
    const trimmed = comment.trim();
    if (!trimmed) return;
    const parsedLine = Number.parseInt(lineRef.trim(), 10);
    const prompt = buildAnnotationPrompt({
      filePath,
      fileName,
      category,
      anchor:
        category === "code" && Number.isFinite(parsedLine) && parsedLine > 0
          ? { kind: "code-line", lineStart: parsedLine }
          : { kind: "file" },
      comment: trimmed,
    });
    if (onAnnotateToComposer) {
      onAnnotateToComposer(prompt);
      toast("已填入输入框，可直接发送给助手", "success");
      setComment("");
      onClose();
      return;
    }
    try {
      await navigator.clipboard.writeText(prompt);
      toast("已复制批注修改指令，粘贴到输入框即可发送", "success");
      setComment("");
      onClose();
    } catch {
      toast("复制失败，请手动复制修改说明", "error");
    }
  };

  return (
    <div className="space-y-2 border-t border-border/70 bg-accent-soft/40 px-3.5 py-2.5" data-testid="hero-quick-annotate-box">
      <div className="flex items-center gap-2">
        <span className="text-caption font-medium text-accent">批注精修 · {fileName}</span>
        {category === "code" && (
          <input
            type="text"
            inputMode="numeric"
            value={lineRef}
            onChange={(e) => setLineRef(e.target.value)}
            placeholder="行号(可选)"
            aria-label="代码行号"
            className="h-7 w-24 rounded-md border border-border-control bg-surface px-2 text-base text-fg outline-none placeholder:text-faint focus:border-accent md:text-xs"
          />
        )}
        <span className="flex-1" />
        <IconButton size="sm" shape="square" aria-label="关闭批注" onClick={onClose}>
          <X size={13} />
        </IconButton>
      </div>
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="输入要让助手修改的具体要求…"
        aria-label="修改要求"
        className="min-h-14 w-full resize-y rounded-md border border-border-control bg-surface px-2.5 py-1.5 text-base text-fg outline-none placeholder:text-faint focus:border-accent md:text-sm"
      />
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          取消
        </Button>
        <Button type="button" size="sm" variant="accent" disabled={!comment.trim()} onClick={() => void submit()}>
          <Send size={12} aria-hidden />
          {onAnnotateToComposer ? "回填到输入框" : "复制批注指令"}
        </Button>
      </div>
    </div>
  );
}

/** 主卡片:文件。 */
function FileHero({
  file,
  messages,
  turnEnd,
  onOpenStep,
  onAnnotateToComposer,
}: {
  file: OutputFile;
  messages: readonly ChatMessage[];
  turnEnd: ChatMessage | undefined;
  onOpenStep: (message: ToolLike) => void;
  onAnnotateToComposer?: (draft: string) => void;
}) {
  // 不按 messages 引用记忆:流式期间消息就地增长,数组引用不变(同 collectPaneSteps,每次渲染重算)。
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
  const options = [
    ...(previewable ? [{ value: "preview" as const, label: "预览" }] : []),
    ...(textual ? [{ value: "source" as const, label: previewable ? "源码" : "内容" }] : []),
    ...(change ? [{ value: "changes" as const, label: `改动 ${change.entries.length}` }] : []),
  ];
  const [chosen, setChosen] = useState<HeroView | null>(null);
  const [quickAnnotateOpen, setQuickAnnotateOpen] = useState(false);
  const view: HeroView = chosen && options.some((o) => o.value === chosen) ? chosen : (options[0]?.value ?? "changes");
  const usesRichBar = view === "preview" && richPreview;
  const dir = displayDir(file.path);
  return (
    <article
      className="overflow-hidden rounded-xl border border-border/70 bg-surface shadow-soft"
      data-testid="outputs-hero"
      aria-label={`${meta.label} ${file.name}`}
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/60 px-3.5 py-2.5">
        <ExtTile path={file.path} kind={file.kind} />
        <div className="min-w-32 flex-1" title={file.path}>
          <div className="truncate text-body font-medium text-fg" data-testid="outputs-hero-name">
            {file.name}
          </div>
          {dir && <div className="truncate text-caption text-faint">{dir}</div>}
        </div>
        {options.length > 1 && (
          <SegmentedControl
            className="ml-auto"
            size="sm"
            value={view}
            onValueChange={(v) => setChosen(v)}
            options={options}
            aria-label="查看方式"
          />
        )}
      </header>
      <div className="max-h-[68vh] min-h-24 overflow-auto [overflow-wrap:anywhere]" data-testid="outputs-hero-body">
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
            />
          </Suspense>
        ) : (
          <div className="px-5 py-8 text-center text-meta text-muted">这类文件不在面板里预览，可以下载查看。</div>
        )}
      </div>
      {quickAnnotateOpen && !usesRichBar && (
        <QuickAnnotateDrawer
          filePath={file.path}
          fileName={file.name}
          category={meta.category}
          onAnnotateToComposer={onAnnotateToComposer}
          onClose={() => setQuickAnnotateOpen(false)}
        />
      )}
      <footer className="flex items-center gap-2 border-t border-border/60 px-3.5 py-1.5 text-caption text-faint">
        <span className="min-w-0 flex-1 truncate" data-testid="outputs-hero-origin">
          {view === "changes"
            ? `${change?.entries.length ?? 0} 次改动`
            : !textual
              ? meta.label
              : replayed !== null
                ? "内容来自会话记录"
                : "容器里的当前文件"}
        </span>
        {change && !change.hasError && <LineCounts added={change.added} removed={change.removed} />}
        {!usesRichBar && (
          <button
            type="button"
            data-testid="hero-quick-annotate"
            onClick={() => setQuickAnnotateOpen((v) => !v)}
            className="inline-flex min-h-7 items-center gap-1 rounded-md px-2 text-caption font-medium text-accent outline-none transition-colors hover:bg-accent-soft focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11"
          >
            <MessageSquarePlus size={12} aria-hidden />
            批注修改
          </button>
        )}
        <CopyIconButton getText={() => file.path} label="复制路径" doneText="已复制路径" />
        {file.path.startsWith("/") && <DownloadButton path={file.path} name={file.name} />}
      </footer>
    </article>
  );
}

function MediaHero({
  media,
  onAnnotateToComposer,
}: {
  media: OutputMedia;
  onAnnotateToComposer?: (draft: string) => void;
}) {
  const [annotateOpen, setAnnotateOpen] = useState(false);
  return (
    <article className="overflow-hidden rounded-xl border border-border/70 bg-surface shadow-soft" data-testid="outputs-hero" aria-label={`图片 ${media.name}`}>
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
      <footer className="flex items-center gap-2 border-t border-border/60 px-3.5 py-1.5 text-caption text-faint">
        <span className="min-w-0 flex-1 truncate" data-testid="outputs-hero-name" title={media.src}>
          {media.name}
        </span>
        <button
          type="button"
          data-testid="hero-quick-annotate"
          onClick={() => setAnnotateOpen((v) => !v)}
          className="inline-flex min-h-7 items-center gap-1 rounded-md px-2 text-caption font-medium text-accent outline-none transition-colors hover:bg-accent-soft focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11"
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

function Section({ icon: Icon, title, count, children, testId }: { icon: typeof Globe; title: string; count: number; children: ReactNode; testId: string }) {
  return (
    <section data-testid={testId}>
      <h4 className={sectionLabel}>
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
  if (total === 0) return null;

  return (
    <div
      className="flex flex-wrap items-center gap-1.5 px-4 pb-3"
      role="group"
      aria-label="交付物按类型汇总与筛选"
      data-testid="outputs-summary-strip"
    >
      <button
        type="button"
        aria-pressed={activeCategory === "all"}
        data-testid="outputs-filter-all"
        onClick={() => onSelectCategory("all")}
        className={cn(
          "inline-flex min-h-7 items-center gap-1 rounded-full border px-2.5 text-caption font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11",
          activeCategory === "all"
            ? "border-accent bg-accent-soft text-accent"
            : "border-border bg-surface text-muted hover:bg-hover hover:text-fg",
        )}
      >
        全部
        <span className="tabular-nums">{total}</span>
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
              "inline-flex min-h-7 items-center gap-1 rounded-full border px-2.5 text-caption font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11",
              active
                ? "border-accent bg-accent-soft text-accent"
                : "border-border bg-surface text-muted hover:bg-hover hover:text-fg",
            )}
          >
            {c.label}
            <span className="tabular-nums">{c.count}</span>
          </button>
        );
      })}
    </div>
  );
}

function OtherOutputs({
  outputs,
  hero,
  activeCategory,
  onPick,
}: {
  outputs: TurnOutputs;
  hero: HeroRef | null;
  activeCategory: DeliverableCategory | "all";
  onPick: (ref: HeroRef) => void;
}) {
  const { files, media, links, sources } = outputs;
  const [allSources, setAllSources] = useState(false);
  const shownSources = allSources ? sources : sources.slice(0, SOURCES_PREVIEW);
  const filteredFiles =
    activeCategory === "all"
      ? files
      : activeCategory === "media"
        ? []
        : files.filter((f) => classifyDeliverable(f.path).category === activeCategory);
  const showMedia = activeCategory === "all" || activeCategory === "media";

  return (
    <div className="space-y-5 px-4 pt-5 pb-6">
      {filteredFiles.length > 0 && (
        <Section icon={FileCode2} title="文件" count={filteredFiles.length} testId="outputs-files">
          <ul className="-mx-2">
            {filteredFiles.map((f) => {
              const active = hero?.type === "file" && hero.path === f.path;
              const meta = classifyDeliverable(f.path);
              return (
                <li key={f.path}>
                  <button
                    type="button"
                    data-testid="outputs-file"
                    aria-current={active ? "true" : undefined}
                    className={cn(quietRow, active && "bg-accent-soft hover:bg-accent-soft")}
                    onClick={() => onPick({ type: "file", path: f.path })}
                    title={f.path}
                  >
                    <ExtTile path={f.path} kind={f.kind} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body text-fg">{f.name}</span>
                      <span className="block truncate text-caption text-faint">
                        {f.change
                          ? `${meta.label} · ${f.change.entries.length} 次改动`
                          : `${meta.label} · 回答里提到`}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2 text-meta">
                      {f.change?.running && <Spinner size={12} className="text-accent" />}
                      {f.change?.hasError && <span className="text-danger">有失败</span>}
                      {f.change && <LineCounts added={f.change.added} removed={f.change.removed} />}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Section>
      )}
      {showMedia && media.length > 0 && (
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
      )}
      {links.length > 0 && (
        <Section icon={MonitorPlay} title="本机预览" count={links.length} testId="outputs-links">
          <ul className="-mx-2">
            {links.map((l) => (
              <li key={l.url}>
                {/* 普通链接:App 的全局点击监听会把容器回环地址交给「容器预览」打开。 */}
                <a href={l.url} className={quietRow} data-testid="outputs-link">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
                    <MonitorPlay size={15} />
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-meta text-fg">{l.label}</span>
                  <span className="shrink-0 text-caption text-faint">打开预览</span>
                </a>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {sources.length > 0 && (
        <Section icon={Globe} title="参考来源" count={sources.length} testId="outputs-sources">
          <ul className="-mx-2">
            {shownSources.map((s) => (
              <li key={s.url} data-container-preview-ignore="">
                <a href={s.url} target="_blank" rel="noopener noreferrer" className={quietRow} data-testid="outputs-source" title={s.url}>
                  <span
                    aria-hidden
                    className="flex size-6 shrink-0 items-center justify-center rounded-full bg-hover text-caption font-semibold uppercase text-muted"
                  >
                    {s.domain.slice(0, 1)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body text-fg">{s.title}</span>
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
              className="mt-1 rounded-full px-2 py-1 text-meta text-muted outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
            >
              {allSources ? "收起" : `显示全部 ${sources.length} 条`}
            </button>
          )}
        </Section>
      )}
    </div>
  );
}

export function OutputsView({
  messages,
  turns,
  index,
  running,
  onSelectTurn,
  onOpenSteps,
  onOpenStep,
  onAnnotateToComposer,
}: {
  messages: readonly ChatMessage[];
  turns: readonly WorkTurn[];
  /** 正在看的那一轮(下标)。 */
  index: number;
  /** 正在看的这一轮是否仍在进行。 */
  running: boolean;
  onSelectTurn: (index: number) => void;
  onOpenSteps: () => void;
  onOpenStep: (message: ToolLike) => void;
  /** 可选：批注回填至 Composer 输入框的回调。 */
  onAnnotateToComposer?: (draft: string) => void;
}) {
  const turn = turns[index];
  if (!turn) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center" data-testid="outputs-empty">
        <Inbox size={22} className="text-faint" aria-hidden />
        <p className="text-body font-medium text-fg">还没有产出</p>
        <p className="text-meta text-muted">助手写的文件、生成的图片、查过的网页会按轮汇总在这里。</p>
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="outputs-view">
      {/* key:换轮时主卡片的视图选择从头来。 */}
      <TurnOutputsBody
        key={turn.key}
        messages={messages}
        turn={turn}
        index={index}
        total={turns.length}
        running={running}
        onSelectTurn={onSelectTurn}
        onOpenSteps={onOpenSteps}
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
  onSelectTurn,
  onOpenSteps,
  onOpenStep,
  onAnnotateToComposer,
}: {
  messages: readonly ChatMessage[];
  turn: WorkTurn;
  index: number;
  total: number;
  running: boolean;
  onSelectTurn: (index: number) => void;
  onOpenSteps: () => void;
  onOpenStep: (message: ToolLike) => void;
  onAnnotateToComposer?: (draft: string) => void;
}) {
  const outputs = collectTurnOutputs(turn);
  const [picked, setPicked] = useState<HeroRef | null>(null);
  const [activeCategory, setActiveCategory] = useState<DeliverableCategory | "all">("all");
  const valid =
    picked &&
    (picked.type === "file" ? outputs.files.some((f) => f.path === picked.path) : outputs.media.some((m) => m.src === picked.src));
  const hero = valid ? picked : pickHero(outputs);
  const heroFile = hero?.type === "file" ? outputs.files.find((f) => f.path === hero.path) : undefined;
  const heroMedia = hero?.type === "media" ? outputs.media.find((m) => m.src === hero.src) : undefined;
  const turnEnd = turn.rows.at(-1);
  const empty = outputs.files.length + outputs.media.length + outputs.links.length + outputs.sources.length === 0;
  const fileCount = outputs.files.filter((f) => f.change).length;

  return (
    <>
      <TurnBar
        turn={turn}
        index={index}
        total={total}
        running={running}
        fileCount={fileCount}
        onPrev={() => onSelectTurn(index - 1)}
        onNext={() => onSelectTurn(index + 1)}
        onOpenSteps={onOpenSteps}
      />
      {!empty && (
        <DeliverableSummaryStrip
          outputs={outputs}
          activeCategory={activeCategory}
          onSelectCategory={setActiveCategory}
        />
      )}
      {heroFile || heroMedia ? (
        <div className="px-4">
          {heroFile ? (
            <FileHero
              key={heroFile.path}
              file={heroFile}
              messages={messages}
              turnEnd={turnEnd}
              onOpenStep={onOpenStep}
              onAnnotateToComposer={onAnnotateToComposer}
            />
          ) : heroMedia ? (
            <MediaHero media={heroMedia} onAnnotateToComposer={onAnnotateToComposer} />
          ) : null}
        </div>
      ) : empty ? (
        <div className="mx-4 flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-6 py-10 text-center" data-testid="outputs-none">
          {running ? <Spinner size={18} className="text-accent" /> : <FileText size={20} className="text-faint" aria-hidden />}
          <p className="text-body font-medium text-fg">{running ? "这一轮还在进行" : "这一轮没有产出文件"}</p>
          <p className="text-meta text-muted">
            {running ? "写出的文件、生成的图片和查过的网页会出现在这里。" : "回答在左侧对话里；想看助手做了什么，可以查看步骤。"}
          </p>
        </div>
      ) : null}
      {!empty && (
        <OtherOutputs
          outputs={outputs}
          hero={hero}
          activeCategory={activeCategory}
          onPick={setPicked}
        />
      )}
    </>
  );
}
