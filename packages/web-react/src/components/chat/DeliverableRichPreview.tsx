/**
 * 全格式交付物富预览与带位置批注组件（OCV5-811，通过 React.lazy 懒加载，不进首屏主包）。
 *
 * 覆盖高频代码 / 科研 / 办公交付物：
 *   - 表格预览器（CSV / TSV）：搜索过滤、列排序、粘性表头、数值列快览、行列计数、一键复制 CSV 切片、按行批注；
 *   - 幻灯片逐页预览器（Marp / Markdown `---` 分页）：16:9 画布、左右翻页、缩略页码条、演讲备注、单页批注；
 *   - 二进制 Office 优雅卡（PPTX / XLSX / DOCX）：清晰元信息 + 下载 + 一键让 Agent 导出预览/转换大纲；
 *   - 长文档阅读器（Markdown）：可折叠 H1–H3 目录、字数/阅读时长统计、选中章节批注、可选切换幻灯片模式；
 *   - PDF 论文/文档预览：受限安全读取并内嵌浏览器 PDF 视图，失败或超限时优雅回退下载与让 Agent 提炼要点；
 *   - 顶部统一交付物操作条：类型徽章、路径、下载、复制路径、新窗打开、「批注让 Agent 修改」。
 */
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  BookOpen,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  FileSpreadsheet,
  FileText,
  ListTree,
  MessageSquarePlus,
  Presentation,
  Search,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { Markdown } from "../Markdown";
import {
  CODE_HIGHLIGHT_MAX_CHARS,
  MARKDOWN_RENDER_MAX_CHARS,
  PDF_PREVIEW_MAX_BYTES,
  codeLanguageOf,
  fenceCode,
  fetchSignedCapped,
  looksLikePdf,
} from "../project/outputPreview";
import { Badge, Button, IconButton, Skeleton, Spinner, useToast } from "../ui";
import {
  type AnnotationAnchor,
  type DeliverableMeta,
  type ParsedDeck,
  type ParsedTable,
  buildAnnotationPrompt,
  classifyDeliverable,
  extractMarkdownOutline,
  filterAndSortTableRows,
  formatAnchorLabel,
  parseDelimitedTable,
  parseMarkdownSlides,
  serializeCsvSlice,
} from "./deliverablePreview";
import { useFreshSignedUrl, useSignedDownload } from "./media";
import { CopyIconButton } from "./paneParts";
import { baseName, displayDir } from "./workbench";
import "./workbenchPreview.css";

export type DeliverableRichPreviewProps = {
  path: string;
  name?: string;
  /** 文本型交付物（CSV/TSV/Markdown/HTML/代码等）的内容；二进制 Office / PDF 可省略。 */
  text?: string | null;
  /** 外部明确指定的元信息（缺省自动按路径与正文分类）。 */
  meta?: DeliverableMeta;
  /** 可选回调：将生成的结构化批注修改指令直接注入左侧 Composer 输入框。 */
  onAnnotateToComposer?: (draft: string) => void;
  /** 是否显示顶部统一交付物操作条（默认 true）。 */
  showActionBar?: boolean;
};

type BadgeTone = "accent" | "info" | "success" | "warning" | "neutral";

function badgeToneFor(meta: DeliverableMeta): BadgeTone {
  switch (meta.category) {
    case "slides":
      return "accent";
    case "spreadsheet":
      return "success";
    case "document":
      return "info";
    case "pdf":
      return "warning";
    case "html":
      return "accent";
    default:
      return "neutral";
  }
}

function formatCompactNumber(n: number): string {
  if (!Number.isFinite(n)) return "-";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, "");
}

function usePromptDispatch(onAnnotateToComposer?: (draft: string) => void) {
  const toast = useToast();
  return useCallback(
    async (prompt: string, successLabel = "已填入输入框，可直接发送给助手") => {
      if (onAnnotateToComposer) {
        onAnnotateToComposer(prompt);
        toast(successLabel, "success");
        return true;
      }
      try {
        await navigator.clipboard.writeText(prompt);
        toast("已复制修改指令，粘贴到输入框即可让助手处理", "success");
        return true;
      } catch {
        toast("无法自动填入或复制，请手动复制指令", "error");
        return false;
      }
    },
    [onAnnotateToComposer, toast],
  );
}

// ── 顶部统一交付物操作条 + 内联批注回填面板 ─────────────────────────────

function UnifiedActionBar({
  path,
  name,
  meta,
  annotateOpen,
  onToggleAnnotate,
}: {
  path: string;
  name: string;
  meta: DeliverableMeta;
  annotateOpen: boolean;
  onToggleAnnotate: () => void;
}) {
  const isContainerFile = path.startsWith("/");
  const { state: dlState, start: startDownload } = useSignedDownload(isContainerFile ? path : null, name);
  const { get: getFreshUrl } = useFreshSignedUrl(isContainerFile ? path : null);
  const toast = useToast();
  const [opening, setOpening] = useState(false);

  const openInNewWindow = async () => {
    if (!isContainerFile) return;
    setOpening(true);
    try {
      const url = await getFreshUrl();
      if (!url) {
        toast("暂时无法获取文件访问链接，请稍后再试", "error");
        return;
      }
      window.open(url, "_blank", "noopener,noreferrer");
    } finally {
      setOpening(false);
    }
  };

  const dir = displayDir(path);
  const readablePath = dir ? `${dir}/${name}` : path;

  return (
    <div className="wb-action-bar" data-testid="deliverable-action-bar">
      <div className="wb-action-meta">
        <Badge tone={badgeToneFor(meta)} size="sm" data-testid="deliverable-type-badge">
          {meta.label} · {meta.shortBadge}
        </Badge>
        <span className="wb-action-path" title={path}>
          {readablePath}
        </span>
      </div>
      <div className="wb-action-controls">
        <Button
          type="button"
          size="sm"
          variant={annotateOpen ? "accent" : "secondary"}
          onClick={onToggleAnnotate}
          data-testid="deliverable-annotate-trigger"
          className="[@media(hover:none)]:min-h-11"
        >
          <MessageSquarePlus size={13} aria-hidden />
          批注让 Agent 修改
        </Button>
        <CopyIconButton getText={() => path} label="复制路径" doneText="已复制路径" />
        {isContainerFile && (
          <>
            <IconButton
              aria-label={`下载 ${name}`}
              title="下载"
              size="sm"
              shape="square"
              disabled={dlState.phase === "downloading"}
              onClick={() => void startDownload()}
            >
              {dlState.phase === "downloading" ? <Spinner size={13} /> : <Download size={15} />}
            </IconButton>
            <IconButton
              aria-label={`新窗口打开 ${name}`}
              title="新窗口打开"
              size="sm"
              shape="square"
              disabled={opening}
              onClick={() => void openInNewWindow()}
            >
              {opening ? <Spinner size={13} /> : <ExternalLink size={15} />}
            </IconButton>
          </>
        )}
      </div>
    </div>
  );
}

function AnnotationComposer({
  filePath,
  fileName,
  category,
  anchor,
  excerpt,
  hasComposerBridge,
  onClearAnchor,
  onClose,
  onSubmitPrompt,
}: {
  filePath: string;
  fileName: string;
  category: DeliverableMeta["category"];
  anchor: AnnotationAnchor;
  excerpt?: string;
  hasComposerBridge: boolean;
  onClearAnchor: () => void;
  onClose: () => void;
  onSubmitPrompt: (prompt: string) => Promise<boolean>;
}) {
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    const trimmed = comment.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      const prompt = buildAnnotationPrompt({
        filePath,
        fileName,
        category,
        anchor,
        comment: trimmed,
        excerpt,
      });
      const ok = await onSubmitPrompt(prompt);
      if (ok) {
        setComment("");
        onClose();
      }
    } finally {
      setSubmitting(false);
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void handleSubmit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="wb-annotate-box" data-testid="deliverable-annotate-box">
      <div className="wb-annotate-header">
        <span className="wb-anchor-chip" data-testid="deliverable-annotate-anchor">
          定位：{formatAnchorLabel(anchor)}
        </span>
        {anchor.kind !== "file" && (
          <button
            type="button"
            onClick={onClearAnchor}
            className="rounded px-1.5 py-0.5 text-caption text-muted outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
          >
            改为整份文件
          </button>
        )}
        <span className="flex-1" />
        <IconButton aria-label="关闭批注输入框" size="sm" shape="square" onClick={onClose}>
          <X size={14} />
        </IconButton>
      </div>
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="写下你的精修要求（例如：精简要点、修正该行数据、补充对比结论…）"
        aria-label="批注修改要求"
        data-testid="deliverable-annotate-input"
        className="wb-annotate-input text-base md:text-sm"
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-caption text-faint">⌘ / Ctrl + Enter 快捷提交</span>
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            type="button"
            size="sm"
            variant="accent"
            disabled={!comment.trim() || submitting}
            onClick={() => void handleSubmit()}
            data-testid="deliverable-annotate-submit"
          >
            <Send size={12} aria-hidden />
            {hasComposerBridge ? "回填到输入框" : "复制批注指令"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── 表格预览器（CSV / TSV） ─────────────────────────────────────────────

function SpreadsheetView({
  text,
  delimiter,
  onAnnotateRow,
}: {
  text: string;
  delimiter: "," | "\t";
  onAnnotateRow: (anchor: AnnotationAnchor, excerpt: string) => void;
}) {
  const toast = useToast();
  const table: ParsedTable = useMemo(() => parseDelimitedTable(text, { delimiter }), [text, delimiter]);
  const [query, setQuery] = useState("");
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const visibleRows = useMemo(
    () => filterAndSortTableRows(table, { query, sortCol, sortDir }),
    [table, query, sortCol, sortDir],
  );

  const numericCols = useMemo(
    () => table.columnStats.filter((c) => c.isNumeric && c.avg !== undefined).slice(0, 3),
    [table.columnStats],
  );

  const toggleSort = (colIdx: number) => {
    if (sortCol !== colIdx) {
      setSortCol(colIdx);
      setSortDir("asc");
    } else if (sortDir === "asc") {
      setSortDir("desc");
    } else {
      setSortCol(null);
    }
  };

  const copySlice = async () => {
    const csv = serializeCsvSlice(table.headers, visibleRows);
    try {
      await navigator.clipboard.writeText(csv);
      toast(`已复制 ${Math.min(visibleRows.length, 200)} 行 CSV 切片`, "success");
    } catch {
      toast("复制失败，请手动选中表格内容", "error");
    }
  };

  if (table.totalColumns === 0) {
    return (
      <div className="px-5 py-8 text-center text-meta text-muted" data-testid="spreadsheet-empty">
        表格为空，暂没有可展示的数据行。
      </div>
    );
  }

  return (
    <div data-testid="deliverable-spreadsheet">
      <div className="wb-table-toolbar">
        <label className="relative flex min-w-40 flex-1 items-center">
          <Search size={13} aria-hidden className="pointer-events-none absolute left-2.5 text-faint" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="筛选表格行…"
            aria-label="筛选表格内容"
            data-testid="spreadsheet-filter"
            className="h-8 w-full rounded-md border border-border-control bg-surface pr-2.5 pl-8 text-base text-fg outline-none placeholder:text-faint focus:border-accent focus:ring-2 focus:ring-ring/25 md:text-sm"
          />
        </label>
        <span className="text-caption tabular-nums text-muted" data-testid="spreadsheet-counts">
          {query.trim()
            ? `匹配 ${visibleRows.length} / ${table.rows.length} 行`
            : `共 ${table.totalRows} 行 · ${table.totalColumns} 列`}
          {table.truncated ? `（已安全渲染前 ${table.rows.length} 行）` : ""}
        </span>
        <Button type="button" size="sm" variant="secondary" onClick={() => void copySlice()} data-testid="spreadsheet-copy-csv">
          <Copy size={12} aria-hidden />
          复制 CSV 切片
        </Button>
      </div>

      {numericCols.length > 0 && (
        <div className="wb-table-stats" data-testid="spreadsheet-numeric-stats">
          {numericCols.map((c) => (
            <span key={c.index} className="wb-stat-pill">
              <strong className="font-medium text-fg">{c.name}</strong>
              <span className="tabular-nums">
                均值 {formatCompactNumber(c.avg ?? 0)} · 区间 {formatCompactNumber(c.min ?? 0)}–{formatCompactNumber(c.max ?? 0)}
              </span>
            </span>
          ))}
        </div>
      )}

      <div className="wb-table-scroll">
        <table className="wb-data-table">
          <thead>
            <tr>
              <th scope="col" className="wb-row-gutter px-2 py-2 text-caption font-medium">
                #
              </th>
              {table.headers.map((h, i) => {
                const sorted = sortCol === i;
                return (
                  <th
                    // biome-ignore lint/suspicious/noArrayIndexKey: 列位置与数据槽位严格对应
                    key={i}
                    scope="col"
                    aria-sort={sorted ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                  >
                    <button type="button" className="wb-th-btn" onClick={() => toggleSort(i)}>
                      <span className="truncate">{h}</span>
                      {sorted ? (
                        sortDir === "asc" ? (
                          <ArrowUp size={12} aria-hidden className="shrink-0 text-accent" />
                        ) : (
                          <ArrowDown size={12} aria-hidden className="shrink-0 text-accent" />
                        )
                      ) : (
                        <ArrowUpDown size={11} aria-hidden className="shrink-0 text-faint" />
                      )}
                    </button>
                  </th>
                );
              })}
              <th scope="col" className="wb-row-action-cell px-2 py-2 text-caption font-medium text-faint">
                批注
              </th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.length === 0 ? (
              <tr>
                <td colSpan={table.totalColumns + 2} className="py-6 text-center text-meta text-muted">
                  没有匹配「{query}」的数据行
                </td>
              </tr>
            ) : (
              visibleRows.map((row) => {
                const summary = row.cells
                  .map((v, idx) => (v.trim() ? `${table.headers[idx]}: ${v.trim()}` : ""))
                  .filter(Boolean)
                  .slice(0, 3)
                  .join("，");
                return (
                  <tr key={row.rowNumber} data-testid="spreadsheet-row">
                    <td className="wb-row-gutter">{row.rowNumber}</td>
                    {row.cells.map((cell, ci) => (
                      <td
                        // biome-ignore lint/suspicious/noArrayIndexKey: 单元格按列序排列
                        key={ci}
                        title={cell}
                        className={cn(table.columnStats[ci]?.isNumeric && "text-right tabular-nums")}
                      >
                        {cell}
                      </td>
                    ))}
                    <td className="wb-row-action-cell">
                      <IconButton
                        size="sm"
                        shape="square"
                        aria-label={`批注第 ${row.rowNumber} 行`}
                        title={`批注第 ${row.rowNumber} 行`}
                        onClick={() =>
                          onAnnotateRow(
                            {
                              kind: "table-row",
                              rowNumber: row.rowNumber,
                              columnsSummary: summary.slice(0, 60),
                            },
                            summary,
                          )
                        }
                      >
                        <MessageSquarePlus size={13} />
                      </IconButton>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── 幻灯片逐页预览器（Markdown Slides） ─────────────────────────────────

function SlideDeckView({
  deck,
  onSwitchToDoc,
  onAnnotateSlide,
}: {
  deck: ParsedDeck;
  onSwitchToDoc?: () => void;
  onAnnotateSlide: (anchor: AnnotationAnchor, excerpt: string) => void;
}) {
  const [pageIdx, setPageIdx] = useState(0);
  const [showNotes, setShowNotes] = useState(false);
  const total = deck.slides.length;
  const safeIdx = Math.max(0, Math.min(pageIdx, Math.max(0, total - 1)));
  const slide = deck.slides[safeIdx];

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft" && safeIdx > 0) {
      e.preventDefault();
      setPageIdx(safeIdx - 1);
    } else if (e.key === "ArrowRight" && safeIdx < total - 1) {
      e.preventDefault();
      setPageIdx(safeIdx + 1);
    }
  };

  if (!slide) {
    return <div className="px-5 py-8 text-center text-meta text-muted">未检测到可展示的幻灯片页面。</div>;
  }

  return (
    <div className="wb-slides-wrap" data-testid="deliverable-slides" onKeyDown={handleKeyDown}>
      <div className="wb-slide-controls">
        <div className="flex items-center gap-1">
          <IconButton
            size="sm"
            shape="square"
            aria-label="上一页"
            title="上一页 (←)"
            disabled={safeIdx <= 0}
            onClick={() => setPageIdx((i) => Math.max(0, i - 1))}
          >
            <ChevronLeft size={15} />
          </IconButton>
          <span className="px-1.5 text-meta font-medium tabular-nums text-fg" data-testid="slide-counter">
            第 {slide.index} / {total} 页
          </span>
          <IconButton
            size="sm"
            shape="square"
            aria-label="下一页"
            title="下一页 (→)"
            disabled={safeIdx >= total - 1}
            onClick={() => setPageIdx((i) => Math.min(total - 1, i + 1))}
          >
            <ChevronRight size={15} />
          </IconButton>
        </div>

        <span className="min-w-0 flex-1 truncate text-meta text-muted" title={slide.title}>
          {slide.title}
        </span>

        {onSwitchToDoc && (
          <Button type="button" size="sm" variant="ghost" onClick={onSwitchToDoc}>
            <BookOpen size={12} aria-hidden />
            文档模式
          </Button>
        )}

        <Button
          type="button"
          size="sm"
          variant="secondary"
          data-testid="slide-annotate-current"
          onClick={() =>
            onAnnotateSlide(
              { kind: "slide", page: slide.index, title: slide.title },
              slide.markdown.slice(0, 180),
            )
          }
        >
          <MessageSquarePlus size={12} aria-hidden />
          批注第 {slide.index} 页
        </Button>
      </div>

      {/* 16:9 精致画布 */}
      <div className="wb-slide-stage" data-testid="slide-stage">
        <div className="text-body">
          <Markdown readOnly signMedia autoDetectCode={false}>
            {slide.markdown}
          </Markdown>
        </div>
        <span className="wb-slide-page-badge">
          {slide.index} / {total}
        </span>
      </div>

      {slide.notes && (
        <div className="wb-slide-notes">
          <button
            type="button"
            aria-expanded={showNotes}
            onClick={() => setShowNotes((v) => !v)}
            className="flex w-full items-center gap-1.5 text-left text-caption font-medium text-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronDown size={13} className={cn("transition-transform", !showNotes && "-rotate-90")} aria-hidden />
            演讲者备注
          </button>
          {showNotes && <p className="mt-1.5 whitespace-pre-wrap text-meta text-fg">{slide.notes}</p>}
        </div>
      )}

      {/* 缩略页码条 */}
      <nav aria-label="幻灯片页码条" className="wb-slide-strip" data-testid="slide-strip">
        {deck.slides.map((item, idx) => {
          const active = idx === safeIdx;
          return (
            <button
              key={item.index}
              type="button"
              aria-current={active ? "true" : undefined}
              data-testid="slide-thumb"
              onClick={() => setPageIdx(idx)}
              className="wb-slide-thumb"
            >
              <span className="text-caption font-semibold tabular-nums text-accent">P{item.index}</span>
              <span className="w-full truncate text-caption text-fg">{item.title}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}

// ── 长文档阅读器（Markdown + 大纲目录 + 字数/时长） ─────────────────────

function normalizeHeadingText(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\s+/g, " ").trim();
}

function LongDocumentView({
  text,
  path,
  onAnnotateSection,
}: {
  text: string;
  path: string;
  onAnnotateSection: (anchor: AnnotationAnchor, excerpt: string) => void;
}) {
  const analysis = useMemo(() => extractMarkdownOutline(text), [text]);
  const deck = useMemo(() => parseMarkdownSlides(text, path), [text, path]);
  // 流式写入期间首段尚未出现 `---` 或第 2 个标题时，不提前锁死模式；仅在用户显式点击切换后记录覆盖态。
  const [slideModeOverride, setSlideModeOverride] = useState<boolean | null>(null);
  const [outlineOpenOverride, setOutlineOpenOverride] = useState<boolean | null>(null);
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null);
  const docBodyRef = useRef<HTMLDivElement>(null);

  const slideMode = slideModeOverride ?? deck.isSlideDeck;
  const outlineOpen = outlineOpenOverride ?? analysis.headings.length >= 2;

  // 为渲染后的 H1–H3 注入确定性 id，供大纲点击精准定位与无障碍关联。
  useEffect(() => {
    const body = docBodyRef.current;
    if (!body || analysis.headings.length === 0) return;
    const nodes = body.querySelectorAll<HTMLElement>("h1, h2, h3");
    nodes.forEach((node, i) => {
      const h = analysis.headings[i];
      if (h && !node.id) node.id = h.id;
    });
  }, [analysis.headings, text]);

  const scrollToHeading = useCallback(
    (h: { id: string; text: string }, index: number) => {
      setActiveHeadingId(h.id);
      const body = docBodyRef.current;
      if (!body) return;
      const nodes = Array.from(body.querySelectorAll<HTMLElement>("h1, h2, h3"));
      if (nodes.length === 0) return;
      const targetText = normalizeHeadingText(h.text);
      const byIndex = nodes[index];
      const target =
        (byIndex && normalizeHeadingText(byIndex.textContent) === targetText ? byIndex : null) ??
        nodes.find((el) => el.id === h.id) ??
        nodes.find((el) => normalizeHeadingText(el.textContent) === targetText) ??
        byIndex;
      if (!target) return;
      if (!target.id) target.id = h.id;

      // OCV5-95 滚动单 writer 约束：仅滚动 Workbench 自身正文容器，严禁触发聊天消息列表滚动。
      const workbenchScroller = target.closest<HTMLElement>(
        '[data-testid="outputs-hero-body"], [data-testid="output-viewer"], [data-testid="outputs-view"]',
      );
      if (workbenchScroller && workbenchScroller.scrollHeight > workbenchScroller.clientHeight) {
        const containerRect = workbenchScroller.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const nextTop = Math.max(0, workbenchScroller.scrollTop + (targetRect.top - containerRect.top) - 12);
        if (typeof workbenchScroller.scrollTo === "function") {
          workbenchScroller.scrollTo({ top: nextTop, behavior: "smooth" });
        } else {
          workbenchScroller.scrollTop = nextTop;
        }
      } else if (typeof target.scrollIntoView === "function") {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    },
    [],
  );

  if (slideMode && deck.slides.length >= 2) {
    return (
      <SlideDeckView
        deck={deck}
        onSwitchToDoc={() => setSlideModeOverride(false)}
        onAnnotateSlide={onAnnotateSection}
      />
    );
  }

  return (
    <div data-testid="deliverable-document">
      <div className="wb-doc-bar" data-testid="doc-stats-bar">
        {analysis.headings.length > 0 && (
          <Button
            type="button"
            size="sm"
            variant={outlineOpen ? "secondary" : "ghost"}
            aria-expanded={outlineOpen}
            onClick={() => setOutlineOpenOverride(!outlineOpen)}
            data-testid="doc-outline-toggle"
          >
            <ListTree size={13} aria-hidden />
            目录 ({analysis.headings.length})
          </Button>
        )}
        <span className="text-caption tabular-nums text-faint">
          约 {analysis.stats.wordCount.toLocaleString("zh-CN")} 字 · 阅读约 {analysis.stats.readingMinutes} 分钟
          {analysis.stats.tableCount > 0 ? ` · ${analysis.stats.tableCount} 表格` : ""}
          {analysis.stats.codeBlockCount > 0 ? ` · ${analysis.stats.codeBlockCount} 代码块` : ""}
        </span>
        <span className="flex-1" />
        {analysis.hasSlideDividers && deck.slides.length >= 2 && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setSlideModeOverride(true)}
            data-testid="doc-switch-slides"
          >
            <Presentation size={13} aria-hidden />
            幻灯片视图 ({deck.slides.length} 页)
          </Button>
        )}
      </div>

      {outlineOpen && analysis.headings.length > 0 && (
        <nav aria-label="文档大纲目录" className="wb-doc-outline" data-testid="doc-outline-list">
          <ol className="space-y-0.5">
            {analysis.headings.map((h, idx) => {
              const active = activeHeadingId === h.id;
              return (
                <li
                  key={h.id}
                  className={cn(
                    "wb-outline-item",
                    h.level === 2 && "pl-4",
                    h.level === 3 && "pl-7",
                    active && "bg-accent-soft/60",
                  )}
                >
                  <button
                    type="button"
                    aria-current={active ? "location" : undefined}
                    onClick={() => scrollToHeading(h, idx)}
                    className="min-w-0 flex-1 truncate text-left text-meta text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    title={`${h.text}（第 ${h.line} 行）`}
                  >
                    {h.text}
                  </button>
                  <span className="shrink-0 text-caption tabular-nums text-faint">L{h.line}</span>
                  <button
                    type="button"
                    aria-label={`批注章节 ${h.text}`}
                    title={`批注章节「${h.text}」`}
                    onClick={() => {
                      scrollToHeading(h, idx);
                      onAnnotateSection(
                        { kind: "section", heading: h.text, line: h.line },
                        `${"#".repeat(h.level)} ${h.text}`,
                      );
                    }}
                    className="shrink-0 rounded px-1.5 py-0.5 text-caption text-accent outline-none hover:bg-accent-soft focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    批注此节
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>
      )}

      {text.length <= MARKDOWN_RENDER_MAX_CHARS ? (
        <div ref={docBodyRef} className="px-5 py-4 text-body" data-testid="output-preview-markdown">
          <Markdown readOnly signMedia autoDetectCode={false}>
            {text}
          </Markdown>
        </div>
      ) : (
        <pre className="overflow-auto px-4 py-3 font-mono text-xs text-fg">{text}</pre>
      )}
    </div>
  );
}

// ── 二进制 Office 文档优雅呈现卡（PPTX / XLSX / DOCX） ──────────────────

function BinaryOfficeCard({
  path,
  name,
  meta,
  onDispatchPrompt,
  onOpenAnnotate,
}: {
  path: string;
  name: string;
  meta: DeliverableMeta;
  onDispatchPrompt: (prompt: string, label?: string) => Promise<boolean>;
  onOpenAnnotate: () => void;
}) {
  const isContainerFile = path.startsWith("/");
  const { state: dlState, start: startDownload } = useSignedDownload(isContainerFile ? path : null, name);
  const Icon =
    meta.format === "pptx" ? Presentation : meta.format === "excel" ? FileSpreadsheet : FileText;

  const ctaLabel =
    meta.format === "pptx"
      ? "让 Agent 导出预览图 / 转 Markdown 大纲"
      : meta.format === "excel"
        ? "让 Agent 导出 CSV 数据表在线查看"
        : "让 Agent 转为 Markdown 长文档阅读";

  const hintText =
    meta.format === "pptx"
      ? "二进制演示文稿（.pptx / .ppt）无法在纯前端直接保真渲染排版；可下载本地打开，或一键让助手导出逐页预览图 / Markdown 幻灯片大纲。"
      : meta.format === "excel"
        ? "二进制工作簿（.xlsx / .xls）可下载用 Excel 打开，或一键让助手导出关键工作表为 CSV，在右侧直接筛选、排序与逐行批注。"
        : "二进制 Word 文档（.docx / .doc）可下载本地编辑，或一键让助手转为结构化 Markdown，在右侧按大纲章节阅读与批注。";

  return (
    <div className="wb-office-card" data-testid="deliverable-binary-office">
      <span className="wb-office-icon" aria-hidden>
        <Icon size={24} />
      </span>
      <div className="max-w-md space-y-1">
        <div className="text-section font-semibold text-fg">{name}</div>
        <div className="text-caption text-faint">
          {meta.label} · {displayDir(path) || path}
        </div>
        <p className="pt-1 text-meta text-muted">{hintText}</p>
      </div>
      <div className="wb-office-actions">
        {meta.agentConvertPrompt && (
          <Button
            type="button"
            size="sm"
            variant="accent"
            data-testid="binary-office-convert"
            onClick={() => void onDispatchPrompt(meta.agentConvertPrompt as string, "已将导出预览指令填入输入框")}
          >
            <Sparkles size={14} aria-hidden />
            {ctaLabel}
          </Button>
        )}
        {isContainerFile && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={dlState.phase === "downloading"}
            onClick={() => void startDownload()}
          >
            {dlState.phase === "downloading" ? <Spinner size={13} /> : <Download size={14} aria-hidden />}
            下载原文件
          </Button>
        )}
        <Button type="button" size="sm" variant="ghost" onClick={onOpenAnnotate}>
          <MessageSquarePlus size={14} aria-hidden />
          批注修改
        </Button>
      </div>
    </div>
  );
}

// ── PDF 论文 / 文档预览 ─────────────────────────────────────────────────

function PdfPreviewView({
  path,
  name,
  onDispatchPrompt,
}: {
  path: string;
  name: string;
  onDispatchPrompt: (prompt: string, label?: string) => Promise<boolean>;
}) {
  const isContainerFile = path.startsWith("/");
  const { get } = useFreshSignedUrl(isContainerFile ? path : null);
  const { state: dlState, start: startDownload } = useSignedDownload(isContainerFile ? path : null, name);
  const [state, setState] = useState<
    | { phase: "loading" }
    | { phase: "ready"; url: string }
    | { phase: "fallback"; reason: string }
  >({ phase: "loading" });

  useEffect(() => {
    if (!isContainerFile) {
      setState({ phase: "fallback", reason: "当前路径无法在线拉取 PDF，请下载后查看。" });
      return;
    }
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setState({ phase: "loading" });
    fetchSignedCapped(get, PDF_PREVIEW_MAX_BYTES, { signal: controller.signal })
      .then((res) => {
        if (controller.signal.aborted) return;
        if (res.kind === "too-large") {
          setState({ phase: "fallback", reason: "PDF 超过 20 MB 在线预览上限，请下载查看或让助手提炼摘要。" });
          return;
        }
        if (!looksLikePdf(res.bytes)) {
          setState({ phase: "fallback", reason: "文件内容不是标准 PDF 格式，请下载核对。" });
          return;
        }
        objectUrl = URL.createObjectURL(new Blob([res.bytes as BlobPart], { type: "application/pdf" }));
        setState({ phase: "ready", url: objectUrl });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setState({ phase: "fallback", reason: "暂时无法在面板中加载 PDF 预览，可直接下载或让助手提炼核心要点。" });
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [get, isContainerFile]);

  if (state.phase === "loading") {
    return (
      <div className="space-y-2 px-5 py-6" data-testid="deliverable-pdf-loading">
        <Skeleton className="h-3 w-1/2" />
        <Skeleton className="h-40 w-full rounded-lg" />
      </div>
    );
  }

  if (state.phase === "ready") {
    return (
      <div data-testid="deliverable-pdf">
        <iframe title={`${name} PDF 预览`} src={state.url} className="wb-pdf-frame" />
      </div>
    );
  }

  return (
    <div className="wb-office-card" data-testid="deliverable-pdf-fallback">
      <span className="wb-office-icon" aria-hidden>
        <FileText size={24} />
      </span>
      <div className="max-w-md space-y-1">
        <div className="text-section font-semibold text-fg">{name}</div>
        <p className="text-meta text-muted">{state.reason}</p>
      </div>
      <div className="wb-office-actions">
        <Button
          type="button"
          size="sm"
          variant="accent"
          onClick={() =>
            void onDispatchPrompt(
              `请阅读 \`${path}\` 并整理一份结构化 Markdown 摘要（含核心结论、关键图表/数据与方法要点），方便我在右侧文档阅读器中审阅。`,
              "已填入 PDF 提炼指令",
            )
          }
        >
          <Sparkles size={14} aria-hidden />
          让 Agent 提炼摘要
        </Button>
        {isContainerFile && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={dlState.phase === "downloading"}
            onClick={() => void startDownload()}
          >
            {dlState.phase === "downloading" ? <Spinner size={13} /> : <Download size={14} aria-hidden />}
            下载 PDF
          </Button>
        )}
      </div>
    </div>
  );
}

// ── 主入口组件 ──────────────────────────────────────────────────────────

export function DeliverableRichPreview({
  path,
  name: nameProp,
  text,
  meta: metaProp,
  onAnnotateToComposer,
  showActionBar = true,
}: DeliverableRichPreviewProps) {
  const name = nameProp ?? baseName(path);
  const meta = useMemo(() => {
    if (metaProp) return metaProp;
    const byPath = classifyDeliverable(path, text);
    // 项目产出等走内容寻址 URL（如 /api/media/<sha256>）没有扩展名时，用展示文件名识别格式。
    if (byPath.ext === "" && nameProp) {
      return classifyDeliverable(nameProp, text);
    }
    return byPath;
  }, [metaProp, path, nameProp, text]);
  const dispatchPrompt = usePromptDispatch(onAnnotateToComposer);

  const [annotateOpen, setAnnotateOpen] = useState(false);
  const [anchor, setAnchor] = useState<AnnotationAnchor>({ kind: "file" });
  const [excerpt, setExcerpt] = useState<string | undefined>(undefined);

  const openAnchoredAnnotate = useCallback((nextAnchor: AnnotationAnchor, nextExcerpt?: string) => {
    setAnchor(nextAnchor);
    setExcerpt(nextExcerpt);
    setAnnotateOpen(true);
  }, []);

  const renderBody = () => {
    if (meta.isBinaryOffice) {
      return (
        <BinaryOfficeCard
          path={path}
          name={name}
          meta={meta}
          onDispatchPrompt={dispatchPrompt}
          onOpenAnnotate={() => openAnchoredAnnotate({ kind: "file" })}
        />
      );
    }

    if (meta.format === "pdf") {
      return <PdfPreviewView path={path} name={name} onDispatchPrompt={dispatchPrompt} />;
    }

    if (meta.format === "csv" || meta.format === "tsv") {
      return (
        <SpreadsheetView
          text={text ?? ""}
          delimiter={meta.format === "tsv" ? "\t" : ","}
          onAnnotateRow={openAnchoredAnnotate}
        />
      );
    }

    if (meta.format === "markdown-slides" || meta.format === "markdown") {
      return (
        <LongDocumentView
          text={text ?? ""}
          path={path}
          onAnnotateSection={openAnchoredAnnotate}
        />
      );
    }

    // 代码 / 纯文本兜底渲染
    const bodyText = text ?? "";
    if (bodyText.length > CODE_HIGHLIGHT_MAX_CHARS) {
      return <pre className="overflow-auto px-4 py-3 font-mono text-xs text-fg">{bodyText}</pre>;
    }
    const language = meta.format === "text" ? "text" : codeLanguageOf(name);
    return (
      <div className="px-3 py-1 [&_pre]:my-2" data-testid="output-preview-source">
        <Markdown readOnly autoDetectCode={false}>
          {fenceCode(bodyText, language)}
        </Markdown>
      </div>
    );
  };

  return (
    <div className="wb-preview-shell" data-testid="deliverable-rich-preview">
      {showActionBar && (
        <UnifiedActionBar
          path={path}
          name={name}
          meta={meta}
          annotateOpen={annotateOpen}
          onToggleAnnotate={() => {
            if (!annotateOpen) {
              setAnchor({ kind: "file" });
              setExcerpt(undefined);
            }
            setAnnotateOpen((v) => !v);
          }}
        />
      )}

      {annotateOpen && (
        <AnnotationComposer
          filePath={path}
          fileName={name}
          category={meta.category}
          anchor={anchor}
          excerpt={excerpt}
          hasComposerBridge={Boolean(onAnnotateToComposer)}
          onClearAnchor={() => {
            setAnchor({ kind: "file" });
            setExcerpt(undefined);
          }}
          onClose={() => setAnnotateOpen(false)}
          onSubmitPrompt={(prompt) => dispatchPrompt(prompt)}
        />
      )}

      {renderBody()}
    </div>
  );
}

export default DeliverableRichPreview;
