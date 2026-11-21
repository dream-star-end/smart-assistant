/**
 * Workbench Office 零轮次高保真预览组件（OCV5-833 · Clarvy Atelier）。
 *
 * 按需经 React.lazy 加载，不进首屏主包：
 *   - 调用 GET /api/file/office-preview?path=<encoded>（带认证 header）
 *   - PPTX / DOCX：左侧（宽屏）/ 底部（窄屏）精致页码缩略图条 + 主视口高清渲染图
 *     （带认证拉取 GET /api/file/office-preview/page?... 转 Blob URL 并自动释放）
 *     + 讲稿备注折叠区 + QA 问题角标 + 「批注此页」直通 AnnotationComposer（{ kind: 'slide', page }）
 *   - XLSX：多 Sheet 精致胶囊标签页 + 紧凑网格视图 + 「计算值 / 公式」切换
 *     + #DIV/0! / #REF! / #VALUE! 等报错单元格柔红高亮与定位条 + 截断提示
 *     + 点选单元格一键批注（{ kind: 'cell', sheet, ref }）
 *   - 任意错误、无预览或空内容时无缝回退原 BinaryOfficeCard，零白屏。
 */
import * as RD from "@radix-ui/react-dialog";
import {
  AlertTriangle,
  Calculator,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileSpreadsheet,
  FunctionSquare,
  Maximize2,
  MessageSquarePlus,
  PencilLine,
  RefreshCw,
  ShieldAlert,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type OfficePreviewPage,
  type OfficePreviewPayload,
  type OfficePreviewQaIssue,
  type OfficePreviewXlsxCell,
  type OfficePreviewXlsxErrorCell,
  type OfficePreviewXlsxSheet,
  fetchOfficePreview,
  fetchOfficePreviewPageBlob,
  formatXlsxCellDisplay,
  isXlsxCellError,
} from "../../lib/api/wave4Api";
import type { AuthSession } from "../../lib/types";
import { cn } from "../../lib/utils";
import { Badge, Button, IconButton, Skeleton, Spinner } from "../ui";
import { AtelierIcon } from "../ui/AtelierIcons";
import type { AnnotationAnchor } from "./deliverablePreview";

export type OfficeRichPreviewProps = {
  path: string;
  name: string;
  auth: AuthSession;
  compact?: boolean;
  onAnnotate: (anchor: AnnotationAnchor, excerpt?: string) => void;
  fallback: ReactNode;
  /** 原生高保真预览就绪态回调，供父容器合并重复顶栏。 */
  onNativeReady?: (ready: boolean) => void;
  /** 并入单行控制条右侧的文件溢出菜单。 */
  fileOverflow?: ReactNode;
  /** 整份文件批注切换（供 XLSX 单行顶栏复用）。 */
  annotateOpen?: boolean;
  onToggleFileAnnotate?: () => void;
};

/** 认证拉取单页预览图并管理 Blob URL 生命周期（组件卸载/切页自动 revoke，避免内存泄漏）。 */
function useAuthenticatedPageImage(auth: AuthSession, pageUrl?: string) {
  const [state, setState] = useState<
    | { phase: "idle" }
    | { phase: "loading" }
    | { phase: "ready"; url: string }
    | { phase: "error" }
  >(() => (pageUrl ? { phase: "loading" } : { phase: "idle" }));
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!pageUrl) {
      setState({ phase: "idle" });
      return;
    }
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setState({ phase: "loading" });

    fetchOfficePreviewPageBlob(auth, pageUrl, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ phase: "ready", url: objectUrl });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setState({ phase: "error" });
      });

    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [auth, pageUrl, attempt]);

  return { state, retry: () => setAttempt((n) => n + 1) };
}

function OfficePageThumb({
  auth,
  page,
  active,
  issueCount,
  hasError,
  onSelect,
  buttonRef,
}: {
  auth: AuthSession;
  page: OfficePreviewPage;
  active: boolean;
  issueCount: number;
  hasError: boolean;
  onSelect: () => void;
  buttonRef?: (el: HTMLButtonElement | null) => void;
}) {
  const { state } = useAuthenticatedPageImage(auth, page.pageUrl);
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onSelect}
      aria-current={active ? "true" : undefined}
      data-testid={`office-page-thumb-${page.index}`}
      className="wb-office-thumb oc-spring-press"
    >
      <div className="wb-office-thumb-frame">
        {state.phase === "ready" ? (
          <img
            src={state.url}
            alt={`第 ${page.index} 页缩略图`}
            loading="lazy"
            className="h-full w-full object-contain"
          />
        ) : state.phase === "loading" ? (
          <Skeleton className="h-full w-full rounded-sm" />
        ) : (
          <span className="text-micro font-mono text-faint">P{page.index}</span>
        )}
      </div>
      <div className="flex w-full items-center justify-between gap-1 px-0.5">
        <span className="text-caption font-semibold tabular-nums text-fg">P{page.index}</span>
        {issueCount > 0 && (
          <span
            className={cn(
              "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0 text-micro font-semibold tabular-nums",
              hasError ? "wb-office-qa-pill-error" : "bg-warning-soft text-warning",
            )}
            title={`本页有 ${issueCount} 项 QA 提示`}
          >
            <AlertTriangle size={9} aria-hidden />
            {issueCount}
          </span>
        )}
      </div>
    </button>
  );
}

function OfficePagesView({
  kind,
  name,
  auth,
  cached,
  pages,
  qaIssues,
  compact,
  fileOverflow,
  onAnnotate,
}: {
  kind: "pptx" | "docx";
  name: string;
  auth: AuthSession;
  cached: boolean;
  pages: OfficePreviewPage[];
  qaIssues: OfficePreviewQaIssue[];
  compact: boolean;
  fileOverflow?: ReactNode;
  onAnnotate: (anchor: AnnotationAnchor, excerpt?: string) => void;
}) {
  const [pageIdx, setPageIdx] = useState(0);
  const [notesOpen, setNotesOpen] = useState(false);
  const [qaOpen, setQaOpen] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const thumbRefs = useRef(new Map<number, HTMLButtonElement>());
  const didMountRef = useRef(false);
  const total = pages.length;
  const safeIdx = Math.max(0, Math.min(pageIdx, Math.max(0, total - 1)));
  const activePage = pages[safeIdx];

  const { state: mainImg, retry: retryMainImg } = useAuthenticatedPageImage(auth, activePage?.pageUrl);

  // 切页时自动将当前缩略图平滑滚入视口（首次挂载跳过，避免越界滚动父容器）
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    thumbRefs.current.get(safeIdx)?.scrollIntoView?.({
      behavior: "smooth",
      block: "nearest",
      inline: "center",
    });
  }, [safeIdx]);

  useEffect(() => {
    setZoomed(false);
  }, [safeIdx, lightboxOpen]);

  const issuesByPage = useMemo(() => {
    const map = new Map<number, OfficePreviewQaIssue[]>();
    for (const issue of qaIssues) {
      if (typeof issue.page === "number") {
        const list = map.get(issue.page) ?? [];
        list.push(issue);
        map.set(issue.page, list);
      }
    }
    return map;
  }, [qaIssues]);

  const currentPageIssues = activePage ? (issuesByPage.get(activePage.index) ?? []) : [];
  const totalErrors = qaIssues.filter((i) => i.severity === "error").length;

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (e.key === "ArrowLeft" && safeIdx > 0) {
      e.preventDefault();
      setPageIdx(safeIdx - 1);
    } else if (e.key === "ArrowRight" && safeIdx < total - 1) {
      e.preventDefault();
      setPageIdx(safeIdx + 1);
    }
  };

  if (!activePage) return null;

  return (
    <div
      tabIndex={0}
      className="wb-office-pages-shell outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      data-kind={kind}
      data-compact={compact ? "true" : undefined}
      data-testid="office-preview-pages"
      onKeyDown={handleKeyDown}
    >
      {/* 合并后的单行清爽控制条 */}
      <div className="wb-office-subbar">
        <div className="flex min-w-0 items-center gap-2">
          <Badge tone="accent" size="sm" className="shrink-0">
            <AtelierIcon name="sparkles" size={11} />
            {cached ? "零轮次缓存预览" : "原生保真预览"}
          </Badge>
          <span className="shrink-0 text-caption tabular-nums text-muted" data-testid="office-page-counter">
            第 {activePage.index} / {total} 页
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {qaIssues.length > 0 && (
            <button
              type="button"
              data-testid="office-qa-toggle"
              aria-expanded={qaOpen}
              onClick={() => setQaOpen((v) => !v)}
              className={cn(
                "oc-spring-press inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-caption font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-10",
                totalErrors > 0 ? "wb-office-qa-pill-error" : "bg-warning-soft text-warning",
              )}
            >
              <ShieldAlert size={12} aria-hidden />
              <span className="tabular-nums">QA {qaIssues.length}</span>
            </button>
          )}
          <div className="oc-surface-recessed flex items-center gap-0.5 rounded-lg p-0.5">
            <IconButton
              size="sm"
              shape="square"
              aria-label="上一页"
              disabled={safeIdx <= 0}
              onClick={() => setPageIdx((i) => Math.max(0, i - 1))}
            >
              <ChevronLeft size={14} />
            </IconButton>
            <IconButton
              size="sm"
              shape="square"
              aria-label="下一页"
              disabled={safeIdx >= total - 1}
              onClick={() => setPageIdx((i) => Math.min(total - 1, i + 1))}
            >
              <ChevronRight size={14} />
            </IconButton>
          </div>
          <Button
            type="button"
            size="sm"
            variant="accent"
            data-testid="office-annotate-page"
            className="oc-spring-press [@media(hover:none)]:min-h-10"
            onClick={() =>
              onAnnotate(
                { kind: "slide", page: activePage.index, title: `${name} 第 ${activePage.index} 页` },
                activePage.notes?.trim() || `${name} 第 ${activePage.index} 页`,
              )
            }
          >
            <PencilLine size={12} aria-hidden />
            批注此页
          </Button>
          {fileOverflow}
        </div>
      </div>

      {/* 可折叠 QA 问题定位抽屉 */}
      {qaOpen && qaIssues.length > 0 && (
        <div className="wb-office-qa-panel" data-testid="office-qa-panel">
          {qaIssues.map((issue, idx) => (
            <button
              key={`${issue.code}-${issue.page ?? "all"}-${idx}`}
              type="button"
              onClick={() => {
                if (typeof issue.page === "number") {
                  const found = pages.findIndex((p) => p.index === issue.page);
                  if (found >= 0) setPageIdx(found);
                }
              }}
              className="wb-office-qa-row"
            >
              <Badge tone={issue.severity === "error" ? "danger" : "warning"} size="sm">
                {issue.page ? `P${issue.page}` : issue.code}
              </Badge>
              <span className="min-w-0 flex-1 truncate text-left text-caption text-fg">{issue.message}</span>
            </button>
          ))}
        </div>
      )}

      {/* 主区域：宽屏左侧缩略图条 + 主高清视口；紧凑屏底部横条 */}
      <div className="wb-office-pages-body">
        <nav aria-label="页面缩略图" className="wb-office-thumb-rail" data-testid="office-thumb-rail">
          {pages.map((page, idx) => {
            const pIssues = issuesByPage.get(page.index) ?? [];
            return (
              <OfficePageThumb
                key={page.index}
                auth={auth}
                page={page}
                active={idx === safeIdx}
                issueCount={pIssues.length}
                hasError={pIssues.some((i) => i.severity === "error")}
                onSelect={() => setPageIdx(idx)}
                buttonRef={(el) => {
                  if (el) thumbRefs.current.set(idx, el);
                  else thumbRefs.current.delete(idx);
                }}
              />
            );
          })}
        </nav>

        <div className="wb-office-stage-col">
          <div className="wb-office-stage group" data-testid="office-preview-stage">
            {mainImg.phase === "ready" ? (
              <>
                <img
                  src={mainImg.url}
                  alt={`${name} 第 ${activePage.index} 页`}
                  data-testid="office-stage-image"
                  onClick={() => setLightboxOpen(true)}
                  title="点击全屏放大查看细节"
                  className="wb-office-stage-img cursor-zoom-in"
                />
                <IconButton
                  size="sm"
                  shape="square"
                  aria-label="全屏放大查看当前页"
                  title="全屏放大查看"
                  data-testid="office-stage-zoom-btn"
                  onClick={() => setLightboxOpen(true)}
                  className="oc-surface-glass oc-spring-press absolute right-2.5 top-2.5 opacity-80 transition-opacity hover:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
                >
                  <Maximize2 size={13} />
                </IconButton>
              </>
            ) : mainImg.phase === "loading" ? (
              <div className="flex flex-col items-center gap-2 py-12 text-muted">
                <Spinner size={18} />
                <span className="text-caption">正在加载第 {activePage.index} 页高清渲染图…</span>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 py-10 text-center text-muted">
                <span className="text-meta">第 {activePage.index} 页图像暂不可用</span>
                {activePage.pageUrl && (
                  <Button type="button" size="sm" variant="secondary" onClick={retryMainImg}>
                    <RefreshCw size={12} aria-hidden />
                    重试加载
                  </Button>
                )}
              </div>
            )}
            <span className="wb-slide-page-badge">
              {activePage.index} / {total}
            </span>
          </div>

          {currentPageIssues.length > 0 && (
            <div className="flex flex-wrap gap-1.5" data-testid="office-page-qa-badges">
              {currentPageIssues.map((issue, i) => (
                <Badge key={`${issue.code}-${i}`} tone={issue.severity === "error" ? "danger" : "warning"} size="sm">
                  <AlertTriangle size={10} aria-hidden />
                  {issue.message}
                </Badge>
              ))}
            </div>
          )}

          {activePage.notes && activePage.notes.trim().length > 0 && (
            <div className="wb-slide-notes" data-testid="office-page-notes">
              <button
                type="button"
                aria-expanded={notesOpen}
                onClick={() => setNotesOpen((v) => !v)}
                className="flex w-full items-center gap-1.5 text-left text-caption font-medium text-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ChevronDown size={13} className={cn("transition-transform", !notesOpen && "-rotate-90")} aria-hidden />
                讲稿备注
              </button>
              {notesOpen && <p className="mt-1.5 whitespace-pre-wrap text-meta text-fg">{activePage.notes}</p>}
            </div>
          )}
        </div>
      </div>

      {/* 全屏高清放大灯箱 */}
      {lightboxOpen && mainImg.phase === "ready" && (
        <RD.Root open onOpenChange={(o) => !o && setLightboxOpen(false)}>
          <RD.Portal>
            <RD.Overlay className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm data-[state=open]:oc-backdrop-in data-[state=closed]:oc-backdrop-out" />
            <RD.Content
              data-testid="office-stage-lightbox"
              aria-describedby={undefined}
              onKeyDown={handleKeyDown}
              className="fixed inset-0 z-50 flex flex-col items-center justify-center p-4 pt-[calc(1rem+env(safe-area-inset-top,0px))] pb-[calc(1rem+env(safe-area-inset-bottom,0px))] outline-none"
            >
              <RD.Title className="sr-only">
                {name} 第 {activePage.index} 页全屏预览
              </RD.Title>
              <div className="oc-surface-glass mb-3 flex items-center gap-1.5 rounded-full px-3 py-1.5 shadow-float">
                <IconButton
                  size="sm"
                  shape="square"
                  aria-label="上一页"
                  disabled={safeIdx <= 0}
                  onClick={() => setPageIdx((i) => Math.max(0, i - 1))}
                >
                  <ChevronLeft size={15} />
                </IconButton>
                <span className="px-1.5 text-caption font-semibold tabular-nums text-fg">
                  第 {activePage.index} / {total} 页
                </span>
                <IconButton
                  size="sm"
                  shape="square"
                  aria-label="下一页"
                  disabled={safeIdx >= total - 1}
                  onClick={() => setPageIdx((i) => Math.min(total - 1, i + 1))}
                >
                  <ChevronRight size={15} />
                </IconButton>
                <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
                <IconButton
                  size="sm"
                  shape="square"
                  aria-label={zoomed ? "还原适应屏幕" : "放大细节"}
                  title={zoomed ? "还原 (100%)" : "放大 (175%)"}
                  onClick={() => setZoomed((z) => !z)}
                >
                  {zoomed ? <ZoomOut size={15} /> : <ZoomIn size={15} />}
                </IconButton>
                <IconButton
                  size="sm"
                  shape="square"
                  aria-label="关闭全屏预览"
                  onClick={() => setLightboxOpen(false)}
                >
                  <X size={15} />
                </IconButton>
              </div>
              <div
                className="flex min-h-0 w-full flex-1 items-center justify-center overflow-auto"
                onClick={(e) => {
                  if (e.target === e.currentTarget) setLightboxOpen(false);
                }}
              >
                <img
                  src={mainImg.url}
                  alt={`${name} 第 ${activePage.index} 页高清大图`}
                  onClick={() => setZoomed((z) => !z)}
                  className={cn(
                    "rounded-xl object-contain shadow-float transition-transform duration-200",
                    zoomed ? "max-w-none w-[min(1400px,160vw)] cursor-zoom-out" : "max-h-[82dvh] max-w-[94vw] cursor-zoom-in",
                  )}
                />
              </div>
            </RD.Content>
          </RD.Portal>
        </RD.Root>
      )}
    </div>
  );
}

/** 从列索引（0-based）转 Excel 列标（A, B, ..., Z, AA...）。 */
function colLetter(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function OfficeXlsxView({
  sheets,
  errorCells,
  cached,
  fileOverflow,
  annotateOpen,
  onToggleFileAnnotate,
  onAnnotate,
}: {
  sheets: OfficePreviewXlsxSheet[];
  errorCells: OfficePreviewXlsxErrorCell[];
  cached: boolean;
  fileOverflow?: ReactNode;
  annotateOpen?: boolean;
  onToggleFileAnnotate?: () => void;
  onAnnotate: (anchor: AnnotationAnchor, excerpt?: string) => void;
}) {
  const [sheetIdx, setSheetIdx] = useState(0);
  const [mode, setMode] = useState<"values" | "formulas">("values");
  const [selectedCell, setSelectedCell] = useState<{ sheet: string; cell: OfficePreviewXlsxCell } | null>(null);
  const cellRefs = useRef(new Map<string, HTMLButtonElement>());

  const safeIdx = Math.max(0, Math.min(sheetIdx, Math.max(0, sheets.length - 1)));
  const activeSheet = sheets[safeIdx];

  const colCount = useMemo(() => {
    if (!activeSheet) return 0;
    const maxRowCols = activeSheet.rows.reduce((m, r) => Math.max(m, r.length), 0);
    return Math.max(maxRowCols, Math.min(activeSheet.totalCols, 50));
  }, [activeSheet]);

  const jumpToError = useCallback(
    (err: OfficePreviewXlsxErrorCell) => {
      const idx = sheets.findIndex((s) => s.name === err.sheet);
      const targetSheet = idx >= 0 ? sheets[idx]! : activeSheet;
      if (idx >= 0) setSheetIdx(idx);
      if (!targetSheet) return;
      for (const row of targetSheet.rows) {
        const hit = row.find((c) => c.cell === err.cell);
        if (hit) {
          setSelectedCell({ sheet: targetSheet.name, cell: hit });
          window.requestAnimationFrame(() => {
            cellRefs.current.get(`${targetSheet.name}!${hit.cell}`)?.scrollIntoView?.({
              behavior: "smooth",
              block: "center",
              inline: "center",
            });
          });
          return;
        }
      }
      setSelectedCell({
        sheet: targetSheet.name,
        cell: { cell: err.cell, value: err.error, error: err.error, formula: err.formula },
      });
    },
    [sheets, activeSheet],
  );

  if (!activeSheet) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="office-preview-xlsx">
      {/* 多 Sheet 胶囊条 + 值/公式切换 */}
      <div className="wb-office-subbar">
        <div role="tablist" aria-label="工作表切换" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {sheets.map((sheet, idx) => {
            const active = idx === safeIdx;
            const errCount = sheet.errorCells.length;
            return (
              <button
                key={sheet.name}
                type="button"
                role="tab"
                aria-selected={active}
                data-testid={`office-xlsx-sheet-tab-${idx}`}
                onClick={() => setSheetIdx(idx)}
                className={cn(
                  "wb-xlsx-sheet-tab oc-spring-press inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-caption font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active
                    ? "border-accent bg-accent-soft text-accent"
                    : "border-transparent text-muted hover:bg-hover hover:text-fg",
                )}
              >
                <FileSpreadsheet size={11} aria-hidden />
                <span className="max-w-32 truncate">{sheet.name}</span>
                <span className="font-mono text-micro opacity-75 tabular-nums">
                  {sheet.totalRows}×{sheet.totalCols}
                </span>
                {errCount > 0 && (
                  <span className="wb-office-qa-pill-error rounded-full px-1.5 font-mono text-micro font-semibold tabular-nums">
                    !{errCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <div className="oc-surface-recessed flex items-center rounded-lg border border-border p-0.5" role="group" aria-label="显示模式">
            <button
              type="button"
              data-testid="office-xlsx-mode-values"
              aria-pressed={mode === "values"}
              onClick={() => setMode("values")}
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-2 py-1 text-caption font-medium transition-colors",
                mode === "values" ? "oc-segmented-thumb text-fg" : "text-muted hover:text-fg",
              )}
            >
              <Calculator size={11} aria-hidden />
              计算值
            </button>
            <button
              type="button"
              data-testid="office-xlsx-mode-formulas"
              aria-pressed={mode === "formulas"}
              onClick={() => setMode("formulas")}
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-2 py-1 text-caption font-medium transition-colors",
                mode === "formulas" ? "oc-segmented-thumb text-fg" : "text-muted hover:text-fg",
              )}
            >
              <FunctionSquare size={11} aria-hidden />
              公式
              {activeSheet.formulas.length > 0 && (
                <span className="font-mono text-micro opacity-75 tabular-nums">({activeSheet.formulas.length})</span>
              )}
            </button>
          </div>
          {cached && (
            <Badge tone="neutral" size="sm" className="hidden sm:inline-flex">
              缓存
            </Badge>
          )}
          {onToggleFileAnnotate && (
            <Button
              type="button"
              size="sm"
              variant={annotateOpen ? "accent" : "secondary"}
              data-testid="deliverable-annotate-trigger"
              onClick={onToggleFileAnnotate}
              className="oc-spring-press h-7 gap-1 px-2 text-caption whitespace-nowrap [@media(hover:none)]:min-h-10"
            >
              <PencilLine size={12} aria-hidden />
              批注修改
            </Button>
          )}
          {fileOverflow}
        </div>
      </div>

      {/* 报错单元格定位条 */}
      {errorCells.length > 0 && (
        <div className="wb-xlsx-error-bar" data-testid="office-xlsx-error-bar">
          <span className="inline-flex shrink-0 items-center gap-1 text-caption font-medium text-danger">
            <AlertTriangle size={12} aria-hidden />
            公式异常 ({errorCells.length})
          </span>
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
            {errorCells.map((err, i) => (
              <button
                key={`${err.sheet}-${err.cell}-${i}`}
                type="button"
                data-testid={`office-xlsx-error-jump-${err.cell}`}
                onClick={() => jumpToError(err)}
                className="wb-xlsx-error-pill"
                title={err.formula ? `${err.sheet}!${err.cell}: ${err.formula}` : `${err.sheet}!${err.cell}`}
              >
                <span className="font-mono font-semibold">{err.sheet}!{err.cell}</span>
                <span className="font-mono">{err.error}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 选中单元格信息与一键批注条 */}
      {selectedCell && (
        <div className="wb-xlsx-selection-bar" data-testid="office-xlsx-selection-bar">
          <Badge tone={isXlsxCellError(selectedCell.cell) ? "danger" : "accent"} size="sm" className="font-mono">
            {selectedCell.sheet}!{selectedCell.cell.cell}
          </Badge>
          <span className="min-w-0 flex-1 truncate font-mono text-caption text-fg">
            {selectedCell.cell.formula
              ? `${selectedCell.cell.formula} → ${formatXlsxCellDisplay(selectedCell.cell, "values")}`
              : formatXlsxCellDisplay(selectedCell.cell, "values") || "（空单元格）"}
          </span>
          <Button
            type="button"
            size="sm"
            variant="accent"
            data-testid="office-annotate-cell"
            onClick={() => {
              const displayVal = formatXlsxCellDisplay(selectedCell.cell, "values");
              const excerpt = selectedCell.cell.formula
                ? `${selectedCell.sheet}!${selectedCell.cell.cell} 公式 ${selectedCell.cell.formula}，当前值 ${displayVal}`
                : `${selectedCell.sheet}!${selectedCell.cell.cell} = ${displayVal || "空"}`;
              onAnnotate(
                {
                  kind: "cell",
                  sheet: selectedCell.sheet,
                  ref: selectedCell.cell.cell,
                  value: displayVal,
                  formula: selectedCell.cell.formula,
                },
                excerpt,
              );
            }}
          >
            <MessageSquarePlus size={12} aria-hidden />
            批注此单元格
          </Button>
        </div>
      )}

      {/* 截断提示 */}
      {activeSheet.truncated && (
        <div className="border-b border-border bg-warning-soft px-3.5 py-1.5 text-caption text-warning" data-testid="office-xlsx-truncated">
          工作表「{activeSheet.name}」共 {activeSheet.totalRows} 行，为保障渲染流畅已展示前 {activeSheet.rows.length} 行。
        </div>
      )}

      {/* 紧凑表格网格 */}
      <div className="wb-table-scroll flex-1">
        <table className="wb-data-table wb-xlsx-table">
          <thead>
            <tr>
              <th scope="col" className="wb-row-gutter px-2 py-1.5 text-caption font-medium">
                #
              </th>
              {Array.from({ length: colCount }, (_, ci) => (
                <th key={colLetter(ci)} scope="col" className="px-2.5 py-1.5 text-center font-mono text-caption font-semibold text-muted">
                  {colLetter(ci)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {activeSheet.rows.map((row, ri) => (
              <tr key={row[0]?.cell ?? `row-${ri + 1}`}>
                <td className="wb-row-gutter px-2 py-1 font-mono text-caption">{ri + 1}</td>
                {Array.from({ length: colCount }, (_, ci) => {
                  const cell: OfficePreviewXlsxCell = row[ci] ?? {
                    cell: `${colLetter(ci)}${ri + 1}`,
                    value: null,
                  };
                  const err = isXlsxCellError(cell);
                  const isSelected =
                    selectedCell?.sheet === activeSheet.name && selectedCell.cell.cell === cell.cell;
                  const text = formatXlsxCellDisplay(cell, mode);
                  const isNum = mode === "values" && typeof cell.value === "number";
                  return (
                    <td
                      key={cell.cell}
                      className={cn(
                        "wb-xlsx-td",
                        err && "wb-xlsx-cell-error",
                        isSelected && "wb-xlsx-cell-selected",
                      )}
                    >
                      <button
                        ref={(el) => {
                          const key = `${activeSheet.name}!${cell.cell}`;
                          if (el) cellRefs.current.set(key, el);
                          else cellRefs.current.delete(key);
                        }}
                        type="button"
                        data-cell-ref={cell.cell}
                        data-cell-error={err ? "true" : undefined}
                        onClick={() => setSelectedCell({ sheet: activeSheet.name, cell })}
                        title={cell.formula ? `${cell.cell} · 公式: ${cell.formula}` : `${cell.cell}: ${text}`}
                        className={cn(
                          "wb-xlsx-cell-btn",
                          isNum && "justify-end font-mono tabular-nums",
                          mode === "formulas" && cell.formula && "font-mono text-accent",
                        )}
                      >
                        <span className="truncate">{text}</span>
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function OfficeRichPreview({
  path,
  name,
  auth,
  compact = false,
  onAnnotate,
  fallback,
  onNativeReady,
  fileOverflow,
  annotateOpen,
  onToggleFileAnnotate,
}: OfficeRichPreviewProps) {
  const [state, setState] = useState<
    | { phase: "loading" }
    | { phase: "ready"; payload: OfficePreviewPayload }
    | { phase: "fallback" }
  >({ phase: "loading" });

  useEffect(() => {
    onNativeReady?.(state.phase === "ready");
  }, [state.phase, onNativeReady]);

  useEffect(() => () => onNativeReady?.(false), [onNativeReady]);

  useEffect(() => {
    const controller = new AbortController();
    setState({ phase: "loading" });

    fetchOfficePreview(auth, path, { signal: controller.signal })
      .then((payload) => {
        if (controller.signal.aborted) return;
        const hasContent =
          payload.kind === "xlsx" ? payload.sheets.length > 0 : payload.pages.length > 0;
        if (!hasContent) {
          setState({ phase: "fallback" });
          return;
        }
        setState({ phase: "ready", payload });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setState({ phase: "fallback" });
      });

    return () => controller.abort();
  }, [auth, path]);

  if (state.phase === "loading") {
    return (
      <div className="space-y-3 px-5 py-6" data-testid="office-preview-loading">
        <div className="flex items-center gap-2 text-caption text-muted">
          <Spinner size={13} />
          <span>正在加载 {name} 保真预览…</span>
        </div>
        <Skeleton className="h-44 w-full rounded-xl" />
        <div className="flex gap-2">
          <Skeleton className="h-12 w-24 rounded-lg" />
          <Skeleton className="h-12 w-24 rounded-lg" />
          <Skeleton className="h-12 w-24 rounded-lg" />
        </div>
      </div>
    );
  }

  if (state.phase === "fallback") {
    return <>{fallback}</>;
  }

  if (state.payload.kind === "xlsx") {
    return (
      <OfficeXlsxView
        sheets={state.payload.sheets}
        errorCells={state.payload.errorCells}
        cached={state.payload.cached}
        fileOverflow={fileOverflow}
        annotateOpen={annotateOpen}
        onToggleFileAnnotate={onToggleFileAnnotate}
        onAnnotate={onAnnotate}
      />
    );
  }

  return (
    <OfficePagesView
      kind={state.payload.kind}
      name={name}
      auth={auth}
      cached={state.payload.cached}
      pages={state.payload.pages}
      qaIssues={state.payload.qaIssues}
      compact={compact}
      fileOverflow={fileOverflow}
      onAnnotate={onAnnotate}
    />
  );
}

export default OfficeRichPreview;
