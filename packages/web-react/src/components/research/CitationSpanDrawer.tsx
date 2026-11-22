/**
 * 原文权威引用溯源侧栏抽屉（OCV5-833 · Clarvy Atelier）。
 *
 * 按需经 React.lazy 加载，对接 `GET /api/me/research/library/:docId/span/:spanId`：
 *   - 展示权威 verbatim quote（逐字不改写）、页码来源（原文页码 / 章节 / PDF 分页 / 估算）、
 *     章节路径、字符偏移与前后文邻接片段；
 *   - 诚实区分 `verifiedSource` 出版背书（DOI / arXiv / OA / 撤稿警告）与用户上传文档；
 *   - 支持一键复制原文引文与前后 Span 连续阅读。
 */
import * as RD from "@radix-ui/react-dialog";
import {
  AlertTriangle,
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  FileText,
  Quote,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useNarrowViewport } from "../../hooks/useMdViewport";
import { useOptionalAuth } from "../../hooks/useProjectScope";
import { type LocatedSpan, type SpanPageSource, fetchResearchSpan } from "../../lib/api/wave4Api";
import type { AuthSession } from "../../lib/types";
import { cn } from "../../lib/utils";
import { Alert, Badge, Button, IconButton, Skeleton, useToast } from "../ui";

export type CitationSpanDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  docId: string | null;
  spanId: string | null;
  fallbackTitle?: string | null;
  fallbackQuote?: string | null;
  auth?: AuthSession | null;
  onNavigateSpan?: (nextSpanId: string) => void;
};

function pageSourceLabel(source: SpanPageSource): string {
  switch (source) {
    case "explicit":
      return "原文页码";
    case "section":
      return "章节页码";
    case "formfeed":
      return "PDF 分页";
    case "estimated":
      return "字符估算页";
  }
}

export function CitationSpanDrawer({
  open,
  onOpenChange,
  docId,
  spanId,
  fallbackTitle,
  fallbackQuote,
  auth: authProp,
  onNavigateSpan,
}: CitationSpanDrawerProps) {
  const ctxAuth = useOptionalAuth();
  const auth = authProp !== undefined ? authProp : ctxAuth;
  const toast = useToast();
  const narrow = useNarrowViewport();

  const [activeSpanId, setActiveSpanId] = useState<string | null>(spanId);
  const [attempt, setAttempt] = useState(0);
  const [copied, setCopied] = useState(false);
  const [state, setState] = useState<
    | { phase: "idle" }
    | { phase: "loading" }
    | { phase: "ready"; data: LocatedSpan }
    | { phase: "error"; message: string }
  >({ phase: "idle" });

  useEffect(() => {
    setActiveSpanId(spanId);
  }, [spanId, docId]);

  useEffect(() => {
    if (!open || !docId || !activeSpanId) return;
    if (!auth) {
      setState({ phase: "error", message: "当前为离线或演示模式，无法连接原文溯源服务。" });
      return;
    }
    const controller = new AbortController();
    setState({ phase: "loading" });

    fetchResearchSpan(auth, docId, activeSpanId, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        setState({ phase: "ready", data });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          phase: "error",
          message: err instanceof Error ? err.message : "未能加载该引用片段，请稍后重试。",
        });
      });

    return () => controller.abort();
  }, [open, auth, docId, activeSpanId, attempt]);

  const navigateTo = (nextSpanId: string) => {
    setActiveSpanId(nextSpanId);
    onNavigateSpan?.(nextSpanId);
  };

  const copyQuote = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast("已复制原文逐字引文", "success");
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast("复制失败，请手动选中复制", "error");
    }
  };

  const located = state.phase === "ready" ? state.data : null;
  const prevSpanId =
    located && located.beforeSpans.length > 0
      ? located.beforeSpans[located.beforeSpans.length - 1]!.spanId
      : located && located.spanIndex > 0
        ? `s${located.spanIndex - 1}`
        : null;
  const nextSpanId =
    located && located.afterSpans.length > 0
      ? located.afterSpans[0]!.spanId
      : located && located.spanIndex + 1 < located.totalSpans
        ? `s${located.spanIndex + 1}`
        : null;

  const headingTitle = located?.title || fallbackTitle || docId || "原文引用溯源";

  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-50 bg-black/35 backdrop-blur-sm data-[state=open]:oc-backdrop-in data-[state=closed]:oc-backdrop-out" />
        <RD.Content
          data-testid="citation-span-drawer"
          aria-describedby={undefined}
          className={cn(
            "oc-surface-popover fixed inset-x-0 bottom-0 top-auto z-50 flex h-[90dvh] max-h-[90dvh] w-full flex-col overflow-hidden rounded-t-2xl border-t border-border bg-surface text-fg shadow-float outline-none",
            "pt-[env(safe-area-inset-top,0px)] pb-[env(safe-area-inset-bottom,0px)]",
            "sm:inset-y-0 sm:left-auto sm:right-0 sm:top-0 sm:h-full sm:max-h-none sm:w-full sm:max-w-lg sm:rounded-none sm:border-l sm:border-t-0",
            narrow ? "oc-sheet-in-bottom" : "oc-sheet-in-right",
          )}
        >
          {/* 顶部装饰线 */}
          <div aria-hidden className="h-0.5 w-full shrink-0 bg-grad-cta" />

          {/* 移动端底部抽屉拖拽微条 */}
          <div aria-hidden className="flex justify-center bg-surface pt-2 pb-0.5 sm:hidden">
            <span className="h-1 w-9 rounded-full bg-border-strong/70" />
          </div>

          {/* Header */}
          <div className="flex items-start gap-3 border-b border-border px-4 py-3.5">
            <span className="oc-icon-badge oc-icon-badge-accent mt-0.5 size-9 shrink-0 rounded-xl" aria-hidden>
              <BookOpen size={17} strokeWidth={1.75} />
            </span>
            <div className="min-w-0 flex-1">
              <RD.Title className="line-clamp-2 text-section font-semibold leading-snug text-fg">
                {headingTitle}
              </RD.Title>
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-caption text-faint">
                {docId && <span className="font-mono">{docId}</span>}
                {activeSpanId && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="font-mono text-accent">{activeSpanId}</span>
                  </>
                )}
              </div>
            </div>
            <IconButton
              aria-label="关闭引用溯源抽屉"
              size="sm"
              shape="square"
              onClick={() => onOpenChange(false)}
              className="shrink-0"
            >
              <X size={16} />
            </IconButton>
          </div>

          {/* Body */}
          <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
            {state.phase === "loading" && (
              <div className="space-y-3" data-testid="citation-span-loading">
                <div className="flex gap-2">
                  <Skeleton className="h-6 w-20 rounded-full" />
                  <Skeleton className="h-6 w-28 rounded-full" />
                </div>
                <Skeleton className="h-16 w-full rounded-xl" />
                <Skeleton className="h-28 w-full rounded-xl" />
                <Skeleton className="h-16 w-full rounded-xl" />
              </div>
            )}

            {state.phase === "error" && (
              <div className="space-y-3" data-testid="citation-span-error">
                <Alert
                  tone="danger"
                  action={
                    auth ? (
                      <Button size="sm" variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
                        <RefreshCw size={12} aria-hidden />
                        重试
                      </Button>
                    ) : undefined
                  }
                >
                  {state.message}
                </Alert>
                {fallbackQuote && (
                  <div className="rounded-xl border border-border bg-bg p-3.5">
                    <div className="mb-1.5 text-caption font-medium text-muted">报告内已记录的引用片段</div>
                    <blockquote className="border-l-2 border-accent pl-3 text-body leading-relaxed text-fg">
                      “{fallbackQuote}”
                    </blockquote>
                  </div>
                )}
              </div>
            )}

            {located && (
              <div className="space-y-4" data-testid="citation-span-content">
                {/* 出版身份 / 背书状态 */}
                <div className="rounded-xl border border-border bg-bg p-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {located.verifiedSource ? (
                      <Badge tone="success" size="sm" data-testid="citation-verified-badge">
                        <ShieldCheck size={11} aria-hidden />
                        权威出版源已验证
                      </Badge>
                    ) : (
                      <Badge tone="neutral" size="sm" data-testid="citation-uploaded-badge">
                        <FileText size={11} aria-hidden />
                        用户上传文档
                      </Badge>
                    )}
                    <Badge tone="accent" size="sm" data-testid="citation-page-badge">
                      第 {located.page} 页 · {pageSourceLabel(located.pageSource)}
                    </Badge>
                    <Badge tone="neutral" size="sm" className="font-mono tabular-nums">
                      片段 {located.spanIndex + 1} / {located.totalSpans}
                    </Badge>
                  </div>

                  {located.verifiedSource && (
                    <div className="mt-2 space-y-1 text-caption text-muted">
                      {located.verifiedSource.authors.length > 0 && (
                        <div>
                          {located.verifiedSource.authors
                            .map((a) => a.name)
                            .slice(0, 5)
                            .join(", ")}
                          {located.verifiedSource.authors.length > 5 ? " 等" : ""}
                          {located.verifiedSource.year ? ` (${located.verifiedSource.year})` : ""}
                          {located.verifiedSource.venue ? ` · ${located.verifiedSource.venue}` : ""}
                        </div>
                      )}
                      <div className="flex flex-wrap items-center gap-2">
                        {located.verifiedSource.doi && (
                          <a
                            href={`https://doi.org/${encodeURIComponent(located.verifiedSource.doi)}`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 font-mono text-accent hover:underline"
                          >
                            DOI: {located.verifiedSource.doi}
                            <ExternalLink size={10} aria-hidden />
                          </a>
                        )}
                        {located.verifiedSource.arxivId && (
                          <a
                            href={`https://arxiv.org/abs/${encodeURIComponent(located.verifiedSource.arxivId)}`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 font-mono text-accent hover:underline"
                          >
                            arXiv: {located.verifiedSource.arxivId}
                            <ExternalLink size={10} aria-hidden />
                          </a>
                        )}
                        {located.verifiedSource.oa?.isOA && located.verifiedSource.oa.url && (
                          <a
                            href={located.verifiedSource.oa.url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-success hover:underline"
                          >
                            开放获取全文
                            <ExternalLink size={10} aria-hidden />
                          </a>
                        )}
                      </div>
                    </div>
                  )}

                  {located.verifiedSource?.retracted === true && (
                    <div className="mt-2">
                      <Alert tone="danger">
                        <span className="inline-flex items-center gap-1.5">
                          <AlertTriangle size={13} aria-hidden />
                          该文献已被撤稿，请谨慎核查其引用结论。
                        </span>
                      </Alert>
                    </div>
                  )}

                  {located.sectionPath.length > 0 && (
                    <div className="mt-2 text-caption text-faint">
                      章节路径：{located.sectionPath.join(" / ")}
                    </div>
                  )}
                </div>

                {/* 前文片段 */}
                {located.contextBefore && (
                  <section aria-label="前文片段" className="space-y-1.5" data-testid="citation-context-before">
                    <div className="text-caption font-medium text-faint">上文语境</div>
                    <p className="whitespace-pre-wrap rounded-xl border border-border bg-bg px-3.5 py-2.5 text-meta leading-relaxed text-muted">
                      {located.contextBefore}
                    </p>
                  </section>
                )}

                {/* 核心权威逐字引文 */}
                <section
                  aria-label="原文逐字引文"
                  data-testid="citation-verbatim-quote"
                  className="oc-surface-card rounded-2xl border border-accent bg-accent-soft p-4 shadow-soft"
                >
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 text-caption font-semibold text-accent">
                      <Quote size={13} aria-hidden />
                      原文权威逐字片段
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => void copyQuote(located.quote)}
                      className="h-7 px-2 text-caption"
                    >
                      {copied ? <Check size={12} className="oc-check-pop text-success" /> : <Copy size={12} />}
                      {copied ? "已复制" : "复制原文"}
                    </Button>
                  </div>
                  <blockquote className="whitespace-pre-wrap border-l-2 border-accent pl-3 text-body leading-relaxed text-fg">
                    {located.quote}
                  </blockquote>
                  <div className="mt-2 flex items-center justify-between text-micro font-mono text-faint tabular-nums">
                    <span>span: {located.spanId}</span>
                    <span>
                      chars [{located.charStart}–{located.charEnd}]
                    </span>
                  </div>
                </section>

                {/* 后文片段 */}
                {located.contextAfter && (
                  <section aria-label="后文片段" className="space-y-1.5" data-testid="citation-context-after">
                    <div className="text-caption font-medium text-faint">下文语境</div>
                    <p className="whitespace-pre-wrap rounded-xl border border-border bg-bg px-3.5 py-2.5 text-meta leading-relaxed text-muted">
                      {located.contextAfter}
                    </p>
                  </section>
                )}
              </div>
            )}
          </div>

          {/* 底部连续阅读导航栏 */}
          {located && (
            <div className="flex items-center justify-between gap-2 border-t border-border bg-surface px-4 py-2.5">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={!prevSpanId}
                data-testid="citation-span-prev"
                onClick={() => prevSpanId && navigateTo(prevSpanId)}
                className="oc-spring-press [@media(hover:none)]:min-h-11"
              >
                <ChevronLeft size={14} aria-hidden />
                上一段
              </Button>
              <span className="font-mono text-caption text-faint tabular-nums">
                {located.spanIndex + 1} / {located.totalSpans}
              </span>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={!nextSpanId}
                data-testid="citation-span-next"
                onClick={() => nextSpanId && navigateTo(nextSpanId)}
                className="oc-spring-press [@media(hover:none)]:min-h-11"
              >
                下一段
                <ChevronRight size={14} aria-hidden />
              </Button>
            </div>
          )}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

export default CitationSpanDrawer;
