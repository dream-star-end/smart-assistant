/**
 * 课题文献库页签（OCV5-833 · Clarvy Atelier）。
 *
 * 挂载于 ProjectHome「文献」页签（按需 React.lazy 加载，不进首屏主包）：
 *   - 顶部批量导入卡片：对接 `POST /api/me/research/library/import-ids`，支持粘贴 DOI / arXiv ID / BibTeX
 *     一键批量入库，清晰展示成功 / 重复 / 失败明细与 `verifiedSource` 权威验证徽章；
 *   - 支持直接上传本地 PDF / Markdown / 文本论文入库（`POST /api/me/research/library`）；
 *   - 下方课题文献列表：复用 `GET /api/me/research/library?projectId=`，支持检索、删除与点击任意条目
 *     打开 `CitationSpanDrawer` 进行原文 Span 溯源阅读。
 */
import {
  AlertTriangle,
  BookMarked,
  BookOpen,
  CheckCircle2,
  ChevronRight,
  CopyCheck,
  FileUp,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { type ChangeEvent, Component, type ReactNode, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type BatchImportOutcome,
  buildResearchImportPayload,
  deleteResearchLibraryDoc,
  importResearchIds,
  listProjectResearchLibrary,
  uploadProjectResearchDoc,
} from "../../lib/api/wave4Api";
import type { AuthSession, ResearchLibraryDoc } from "../../lib/types";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  IconButton,
  Skeleton,
  Spinner,
  TimeAgo,
  useConfirm,
  useToast,
} from "../ui";
import { AtelierIcon } from "../ui/AtelierIcons";

function createLazyCitationSpanDrawer() {
  return lazy(() =>
    import("../research/CitationSpanDrawer").catch((err) => {
      LazyCitationSpanDrawer = createLazyCitationSpanDrawer();
      throw err;
    }),
  );
}
let LazyCitationSpanDrawer = createLazyCitationSpanDrawer();

class SpanDrawerErrorBoundary extends Component<
  { onClose: () => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return (
        <Alert
          tone="danger"
          action={
            <Button size="sm" variant="secondary" onClick={this.props.onClose}>
              关闭
            </Button>
          }
        >
          原文溯源抽屉加载失败，请稍后重试。
        </Alert>
      );
    }
    return this.props.children;
  }
}

export type ProjectResearchTabProps = {
  projectId: string;
  projectName: string;
  demo: boolean;
  authSession: AuthSession;
};

function langLabel(lang: string): string {
  if (lang === "zh") return "中文";
  if (lang === "en") return "EN";
  return lang.toUpperCase();
}

export function ProjectResearchTab({
  projectId,
  projectName,
  demo,
  authSession,
}: ProjectResearchTabProps) {
  const toast = useToast();
  const [confirmDialog, confirmEl] = useConfirm();

  const [docs, setDocs] = useState<ResearchLibraryDoc[]>([]);
  const [loading, setLoading] = useState(!demo);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  // 批量导入态
  const [importText, setImportText] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importOutcome, setImportOutcome] = useState<BatchImportOutcome | null>(null);
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 原文 Span 溯源抽屉态
  const [spanTarget, setSpanTarget] = useState<{
    docId: string;
    spanId: string;
    title?: string | null;
  } | null>(null);

  const loadLibrary = useCallback(
    async (signal?: AbortSignal) => {
      if (demo) {
        setDocs([]);
        setLoading(false);
        setError(null);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const list = await listProjectResearchLibrary(authSession, projectId, signal);
        if (!signal?.aborted) setDocs(list);
      } catch (err: unknown) {
        if (signal?.aborted) return;
        setError(err instanceof Error ? err.message : "加载课题文献库失败");
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [authSession, demo, projectId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadLibrary(controller.signal);
    return () => controller.abort();
  }, [loadLibrary]);

  const filteredDocs = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return docs;
    return docs.filter(
      (d) => (d.title ?? "").toLowerCase().includes(q) || d.docId.toLowerCase().includes(q),
    );
  }, [docs, query]);

  const handleBatchImport = async () => {
    const trimmed = importText.trim();
    if (!trimmed || importing || demo) return;
    setImporting(true);
    setImportError(null);
    try {
      const payload = buildResearchImportPayload(trimmed, projectId);
      const outcome = await importResearchIds(authSession, payload);
      setImportOutcome(outcome);
      if (outcome.imported.length > 0) {
        setImportText("");
        toast(`成功入库 ${outcome.imported.length} 篇文献`, "success");
        void loadLibrary();
      } else if (outcome.duplicates.length > 0 && outcome.failed.length === 0) {
        toast(`提交的 ${outcome.duplicates.length} 篇文献均已在库中`, "info");
      }
    } catch (err: unknown) {
      setImportError(err instanceof Error ? err.message : "批量导入失败，请检查输入格式后重试");
    } finally {
      setImporting(false);
    }
  };

  const handleFileUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || demo) return;
    setUploading(true);
    try {
      const res = await uploadProjectResearchDoc(authSession, file, projectId);
      if (res.needsOcr) {
        toast(res.reason || "该 PDF 为扫描件且暂无文字层，请开启 OCR 后重试", "error");
        return;
      }
      toast(`已解析并入库「${res.title || file.name}」`, "success");
      void loadLibrary();
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : "上传入库失败", "error");
    } finally {
      setUploading(false);
    }
  };

  const handleDeleteDoc = async (doc: ResearchLibraryDoc) => {
    const ok = await confirmDialog({
      title: "移出文献库",
      body: `确认删除「${doc.title || doc.docId}」？历史报告已铸造的引用记录不受影响，但后续将无法继续定位该文档原文。`,
      confirmText: "删除",
      danger: true,
    });
    if (ok !== true) return;
    setDeletingId(doc.docId);
    try {
      await deleteResearchLibraryDoc(authSession, doc.docId);
      setDocs((prev) => prev.filter((d) => d.docId !== doc.docId));
      toast("已从文献库删除", "success");
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : "删除失败", "error");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="project-research-tab">
      {confirmEl}

      {/* 批量导入卡片 */}
      <Card padding="md" className="flex min-w-0 flex-col gap-3" data-testid="research-batch-import-card">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <span className="oc-icon-badge oc-icon-badge-accent size-8 shrink-0 rounded-xl" aria-hidden>
              <BookMarked size={15} strokeWidth={1.75} />
            </span>
            <div>
              <h2 className="text-section font-semibold text-fg">批量导入文献</h2>
              <p className="text-caption text-muted">
                粘贴 DOI、arXiv ID（每行一条）或完整 BibTeX，自动解析元数据并挂入「{projectName}」
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.txt,.md,.markdown"
              onChange={(e) => void handleFileUpload(e)}
              className="hidden"
              aria-label="上传论文原文件"
            />
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={demo || uploading}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploading ? <Spinner size={12} /> : <FileUp size={13} aria-hidden />}
              上传全文 PDF/MD
            </Button>
          </div>
        </div>

        <textarea
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          disabled={demo || importing}
          rows={3}
          aria-label="粘贴 DOI、arXiv ID 或 BibTeX"
          data-testid="research-import-input"
          placeholder={"例如：\n10.1038/s41586-023-06291-2\narXiv:2307.09288\n或直接粘贴 @article{...} BibTeX 条目"}
          className="oc-field-control w-full resize-y rounded-xl border border-border-control bg-surface px-3 py-2 text-base leading-relaxed text-fg outline-none placeholder:text-faint focus:border-accent focus-visible:ring-2 focus-visible:ring-ring md:text-sm"
        />

        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-caption text-faint">
            单批最多 50 篇，系统自动按 DOI / arXiv / 键名去重并核验出版源权威性
          </span>
          <Button
            type="button"
            size="sm"
            variant="accent"
            disabled={demo || importing || !importText.trim()}
            data-testid="research-import-submit"
            onClick={() => void handleBatchImport()}
          >
            {importing ? <Spinner size={12} /> : <AtelierIcon name="sparkles" size={13} />}
            {importing ? "解析入库中…" : "批量解析并入库"}
          </Button>
        </div>

        {importError && <Alert tone="danger">{importError}</Alert>}

        {/* 导入结果明细 */}
        {importOutcome && (
          <div
            className="space-y-2.5 rounded-xl border border-border bg-bg p-3"
            data-testid="research-import-result"
          >
            <div className="flex flex-wrap items-center gap-2 text-caption">
              <span className="font-medium text-fg">本次共提交 {importOutcome.totalSubmitted} 条：</span>
              <Badge tone="success" size="sm" data-testid="import-count-success">
                <CheckCircle2 size={11} aria-hidden />
                成功 {importOutcome.imported.length}
              </Badge>
              <Badge tone="neutral" size="sm" data-testid="import-count-duplicate">
                <CopyCheck size={11} aria-hidden />
                重复 {importOutcome.duplicates.length}
              </Badge>
              {importOutcome.failed.length > 0 && (
                <Badge tone="danger" size="sm" data-testid="import-count-failed">
                  <AlertTriangle size={11} aria-hidden />
                  失败 {importOutcome.failed.length}
                </Badge>
              )}
            </div>

            {importOutcome.imported.length > 0 && (
              <ul className="divide-y divide-border">
                {importOutcome.imported.map((item) => (
                  <li key={item.docId} className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-meta">
                    <button
                      type="button"
                      onClick={() => setSpanTarget({ docId: item.docId, spanId: "s0", title: item.title })}
                      className="min-w-0 flex-1 truncate text-left font-medium text-fg hover:text-accent hover:underline"
                    >
                      {item.title || item.raw}
                    </button>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {item.fulltextVerified || item.verified ? (
                        <Badge tone="success" size="sm" data-testid="import-verified-badge">
                          <ShieldCheck size={10} aria-hidden />
                          权威源已验
                        </Badge>
                      ) : item.bibliographicResolved ? (
                        <Badge tone="warning" size="sm">
                          书目已匹配 · 正文未背书
                        </Badge>
                      ) : (
                        <Badge tone="neutral" size="sm">
                          用户题录
                        </Badge>
                      )}
                      <span className="font-mono text-caption text-faint tabular-nums">{item.spanCount} 段</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {importOutcome.duplicates.length > 0 && (
              <div className="space-y-1 text-caption text-muted">
                {importOutcome.duplicates.map((dup, idx) => (
                  <div key={`${dup.dedupeKey}-${idx}`} className="flex items-center justify-between gap-2">
                    <span className="truncate">{dup.raw}</span>
                    <span className="shrink-0 text-faint">
                      {dup.reason === "already_in_library" ? "已在文献库中" : "批内重复"}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {importOutcome.failed.length > 0 && (
              <div className="space-y-1 text-caption text-danger">
                {importOutcome.failed.map((fail, idx) => (
                  <div key={`${fail.dedupeKey}-${idx}`} className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono">{fail.raw}</span>
                    <span className="shrink-0">{fail.reason}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Card>

      {/* 课题文献列表 */}
      <Card padding="md" className="flex min-w-0 flex-col gap-3" data-testid="research-library-list">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-section font-semibold text-fg">课题文献库</h2>
            <Badge tone="neutral" size="sm" className="tabular-nums">
              {docs.length} 篇
            </Badge>
          </div>
          <div className="flex w-full items-center gap-1.5 sm:w-auto">
            <label className="relative flex min-w-0 flex-1 items-center sm:flex-initial">
              <Search size={13} aria-hidden className="pointer-events-none absolute left-2.5 text-faint" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="筛选标题或 docId…"
                aria-label="筛选文献库"
                className="oc-field-control h-8 w-full flex-1 rounded-lg border border-border-control bg-surface pl-8 pr-2.5 text-base text-fg outline-none placeholder:text-faint focus:border-accent sm:w-56 md:text-sm"
              />
            </label>
            <IconButton
              size="sm"
              shape="square"
              aria-label="刷新文献库"
              title="刷新"
              disabled={loading || demo}
              onClick={() => void loadLibrary()}
            >
              <RefreshCw size={14} className={loading ? "animate-spin" : undefined} />
            </IconButton>
          </div>
        </div>

        {error && (
          <Alert
            tone="danger"
            action={
              <Button size="sm" variant="secondary" onClick={() => void loadLibrary()}>
                重试
              </Button>
            }
          >
            {error}
          </Alert>
        )}

        {loading ? (
          <div className="space-y-2 py-2">
            <Skeleton className="h-12 w-full rounded-xl" />
            <Skeleton className="h-12 w-full rounded-xl" />
          </div>
        ) : filteredDocs.length === 0 ? (
          <EmptyState
            icon={BookOpen}
            title={docs.length === 0 ? "本课题还没有入库文献" : "没有匹配的文献"}
            hint={
              docs.length === 0
                ? "在上方粘贴 DOI / arXiv ID / BibTeX 或上传论文 PDF，即可为本课题的对话与报告建立可溯源证据库。"
                : "尝试清空搜索词或切换其他关键词。"
            }
          />
        ) : (
          <ul className="divide-y divide-border">
            {filteredDocs.map((doc) => (
              <li
                key={doc.docId}
                data-testid="research-library-row"
                className="flex items-center gap-3 py-2.5 first:pt-1 last:pb-1"
              >
                <button
                  type="button"
                  onClick={() => setSpanTarget({ docId: doc.docId, spanId: "s0", title: doc.title })}
                  data-testid={`research-doc-open-${doc.docId}`}
                  className="group flex min-w-0 flex-1 flex-col gap-0.5 rounded-lg px-1.5 py-1 text-left outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="truncate text-body font-medium text-fg group-hover:text-accent">
                    {doc.title || doc.docId}
                  </span>
                  <span className="flex flex-wrap items-center gap-1.5 text-caption text-faint">
                    <span className="rounded bg-hover px-1.5 py-0 text-micro font-medium text-muted">
                      {langLabel(doc.lang)}
                    </span>
                    <span className="tabular-nums">{doc.spanCount} 段可溯源</span>
                    <span aria-hidden>·</span>
                    <span className="font-mono">{doc.docId}</span>
                    <span aria-hidden>·</span>
                    <TimeAgo value={doc.createdAt} />
                  </span>
                </button>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setSpanTarget({ docId: doc.docId, spanId: "s0", title: doc.title })}
                    className="oc-spring-press hidden sm:inline-flex"
                  >
                    <BookOpen size={12} aria-hidden />
                    溯源
                  </Button>
                  <ChevronRight size={15} aria-hidden className="shrink-0 text-faint sm:hidden" />
                  <IconButton
                    size="sm"
                    shape="square"
                    aria-label={`删除文献 ${doc.title || doc.docId}`}
                    title="删除"
                    disabled={deletingId === doc.docId}
                    onClick={() => void handleDeleteDoc(doc)}
                    className="oc-spring-press"
                  >
                    {deletingId === doc.docId ? <Spinner size={12} /> : <Trash2 size={14} />}
                  </IconButton>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* 原文 Span 溯源侧栏抽屉 */}
      {spanTarget && (
        <SpanDrawerErrorBoundary onClose={() => setSpanTarget(null)}>
          <Suspense fallback={null}>
            <LazyCitationSpanDrawer
              open
              onOpenChange={(open) => !open && setSpanTarget(null)}
              docId={spanTarget.docId}
              spanId={spanTarget.spanId}
              fallbackTitle={spanTarget.title}
              auth={demo ? null : authSession}
              onNavigateSpan={(nextSpanId) =>
                setSpanTarget((prev) => (prev ? { ...prev, spanId: nextSpanId } : null))
              }
            />
          </Suspense>
        </SpanDrawerErrorBoundary>
      )}
    </div>
  );
}

export default ProjectResearchTab;
