import { ArrowRight, Check, ChevronRight, Copy, Download, ExternalLink, History, RotateCcw } from "lucide-react";
import { lazy, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatBytes, openInNewTab } from "../../lib/chat/download";
import { useProgressiveImage } from "../../lib/chat/useProgressiveImage";
import type { ProjectAsset } from "../../lib/types";
import { cn } from "../../lib/utils";
import { LazyBoundary } from "../ChunkErrorBoundary";
import { Markdown } from "../Markdown";
import { useFreshSignedUrl, useSignedDownload, useSignedSrc } from "../chat/media";
import { Button, DescriptionList, DescriptionRow, MetaLine, Modal, Spinner, TimeAgo, useToast } from "../ui";
import {
  CODE_HIGHLIGHT_MAX_CHARS,
  type PreviewKind,
  PDF_PREVIEW_MAX_BYTES,
  SNIPPET_FETCH_MAX_FILE_BYTES,
  SNIPPET_HEAD_BYTES,
  TEXT_PREVIEW_MAX_BYTES,
  codeLanguageOf,
  decodeText,
  extBadgeOf,
  fenceCode,
  fetchSignedCapped,
  isTextual,
  knownTooLarge,
  looksLikePdf,
  previewKindOf,
  snippetOf,
} from "./outputPreview";
import { OUTPUT_KIND_LABELS, outputKind } from "./projectHomeModel";

// 全屏图片查看器（缩放 / 下载）只在点开大图时才需要，和聊天里的缩略图同一个懒块。
const ImageViewer = lazy(() => import("../ImageViewer").then((m) => ({ default: m.ImageViewer })));

/** 产出的字节来源：优先这一版自己的不可变副本（url），没有副本的旧登记才取源路径。 */
export function outputSrc(a: Pick<ProjectAsset, "url" | "containerPath">): string | null {
  return a.url || a.containerPath || null;
}

// ── 卡片：首几行 / 缩略图 ────────────────────────────────────────────────

/** 进视口（含 200px 预取边距）后才为 true；一次为真就不再回落。无 IO 环境（jsdom）直接为真。 */
function useInView(ref: RefObject<Element | null>): boolean {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (seen) return;
    const node = ref.current;
    if (!node) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [ref, seen]);
  return seen;
}

/**
 * 首几行的会话级缓存（键 = 带账号命名空间的签名路径，换账号不串）。
 * 最多 120 条，按插入顺序淘汰；值是空串表示「取过但没有可显示的文本」，不再重取。
 */
const SNIPPET_CACHE_MAX = 120;
const snippetCache = new Map<string, string>();
function rememberSnippet(key: string, value: string) {
  snippetCache.delete(key);
  snippetCache.set(key, value);
  while (snippetCache.size > SNIPPET_CACHE_MAX) {
    const oldest = snippetCache.keys().next().value;
    if (oldest === undefined) break;
    snippetCache.delete(oldest);
  }
}

/** 首几行最多同时取 2 个：一页 49 张卡滚过去也不会把每用户的并发闸打满。 */
const SNIPPET_CONCURRENCY = 2;
let snippetActive = 0;
const snippetQueue: Array<() => void> = [];
function withSnippetSlot<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      snippetActive += 1;
      task()
        .then(resolve, reject)
        .finally(() => {
          snippetActive -= 1;
          snippetQueue.shift()?.();
        });
    };
    if (snippetActive < SNIPPET_CONCURRENCY) run();
    else snippetQueue.push(run);
  });
}

/** 测试用：清空首几行缓存与队列。 */
export function __resetOutputSnippetCache() {
  snippetCache.clear();
  snippetQueue.length = 0;
  snippetActive = 0;
}

/**
 * 卡片上的首几行。有服务端摘要（上传资料的 excerpt）就直接用，零请求；否则只对
 * 已知不大（≤256 KB）的文本类文件、进入视口后取头部 4 KB（带 Range），结果缓存。
 */
function useOutputSnippet(asset: ProjectAsset, enabled: boolean): string | null {
  const kind = previewKindOf(asset);
  const src = outputSrc(asset);
  const fromExcerpt = useMemo(
    () => (asset.excerpt && isTextual(kind) ? snippetOf(asset.excerpt, kind) : null),
    [asset.excerpt, kind],
  );
  const { get, cacheIdentity } = useFreshSignedUrl(src);
  const key = cacheIdentity;
  const size = asset.sizeBytes;
  const eligible =
    enabled &&
    !fromExcerpt &&
    isTextual(kind) &&
    Boolean(key) &&
    typeof size === "number" &&
    size > 0 &&
    size <= SNIPPET_FETCH_MAX_FILE_BYTES;
  const [fetched, setFetched] = useState<string | null>(() => (key ? snippetCache.get(key) ?? null : null));
  useEffect(() => {
    if (!eligible || !key) return;
    const hit = snippetCache.get(key);
    if (hit !== undefined) {
      setFetched(hit);
      return;
    }
    const controller = new AbortController();
    let alive = true;
    void withSnippetSlot(() =>
      fetchSignedCapped(get, SNIPPET_HEAD_BYTES, { signal: controller.signal, truncate: true }),
    )
      .then((r) => {
        const text = r.kind === "ok" ? decodeText(r.bytes) : null;
        const s = text ? snippetOf(text, kind) : "";
        rememberSnippet(key, s);
        if (alive) setFetched(s);
      })
      .catch(() => {
        /* 首几行是锦上添花：失败就只显示类型标记，不打扰 */
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [eligible, key, get, kind]);
  return fromExcerpt || fetched || null;
}

/** 缩略图（只在进视口后挂载：此时才签名、才取 640 档缩略）。 */
function ImageThumb({ src }: { src: string }) {
  const { url } = useSignedSrc(src);
  const { get, cacheIdentity } = useFreshSignedUrl(src);
  const { objectUrl, status } = useProgressiveImage({
    src: url,
    width: 640,
    cacheIdentity,
    resolveSrc: get,
    lazy: false,
  });
  if (!objectUrl || status !== "loaded") return null;
  return <img src={objectUrl} alt="" decoding="async" className="absolute inset-0 size-full object-cover" />;
}

function OutputThumb({ asset, visible, compact }: { asset: ProjectAsset; visible: boolean; compact: boolean }) {
  const src = outputSrc(asset);
  const isImage = previewKindOf(asset) === "image";
  return (
    <span
      aria-hidden
      data-testid="output-thumb"
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-hover",
        compact ? "size-9" : "size-11",
      )}
    >
      <span className="font-mono text-[10px] font-semibold leading-none tracking-wide text-muted">
        {extBadgeOf(asset.name)}
      </span>
      {isImage && src && visible && <ImageThumb src={src} />}
    </span>
  );
}

/**
 * 产出列表的一行（整行可点 → 打开查看器）。安静表面：左侧 44px 类型标记 / 真实缩略图，
 * 名称 14/500，下面是首几行（有就显示）和弱化元信息行，右侧 ›。
 * compact = 概览卡里的紧凑行：不取首几行、不显示大小。
 */
export function OutputRow({
  asset,
  sourceTitle,
  onOpen,
  compact = false,
}: {
  asset: ProjectAsset;
  sourceTitle?: string;
  onOpen: (asset: ProjectAsset) => void;
  compact?: boolean;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const visible = useInView(ref);
  const kind = previewKindOf(asset);
  const snippet = useOutputSnippet(asset, visible && !compact);
  const versions = asset.versionCount ?? 1;
  const size = formatBytes(asset.sizeBytes);
  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onOpen(asset)}
      aria-label={`查看 ${asset.name}`}
      data-testid="output-row"
      data-output-kind={outputKind(asset)}
      className={cn(
        "group flex w-full min-w-0 gap-3 text-left outline-none transition-colors duration-100 hover:bg-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        compact ? "min-h-11 items-center rounded-md px-2 py-2" : "min-h-12 items-start px-4 py-3",
      )}
    >
      <OutputThumb asset={asset} visible={visible} compact={compact} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[14px] font-medium leading-5 text-fg" title={asset.name}>
          {asset.name}
        </span>
        {snippet && (
          <span
            data-testid="output-snippet"
            className={cn(
              "line-clamp-2 whitespace-pre-line break-words text-muted",
              kind === "code" ? "font-mono text-caption" : "text-meta",
            )}
          >
            {snippet}
          </span>
        )}
        <MetaLine>
          {sourceTitle ? (
            <span className="min-w-0 max-w-full truncate">来自「{sourceTitle}」</span>
          ) : (
            <span>{OUTPUT_KIND_LABELS[outputKind(asset)]}</span>
          )}
          <TimeAgo value={asset.createdAt} tooltip={false} />
          {!compact && size && <span>{size}</span>}
          {versions > 1 && <span data-testid="output-version-badge">v{versions}</span>}
        </MetaLine>
      </span>
      <ChevronRight
        size={15}
        strokeWidth={1.75}
        aria-hidden="true"
        className="shrink-0 self-center text-faint transition-colors group-hover:text-muted"
      />
    </button>
  );
}

// ── 查看器 ─────────────────────────────────────────────────────────────

type BytesState =
  | { phase: "loading" }
  | { phase: "ok"; bytes: Uint8Array }
  | { phase: "too-large"; total: number | null }
  | { phase: "error" };

/** 经签名 URL 取整份字节（≤cap）。大小已知超限就不发请求。 */
function useCappedBytes(src: string | null, cap: number, sizeBytes: number | null): BytesState & { retry: () => void } {
  const { get } = useFreshSignedUrl(src);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<BytesState>(() =>
    knownTooLarge(sizeBytes, cap) ? { phase: "too-large", total: sizeBytes } : { phase: "loading" },
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt 是「重试」的触发器，变了就重取。
  useEffect(() => {
    if (knownTooLarge(sizeBytes, cap)) {
      setState({ phase: "too-large", total: sizeBytes });
      return;
    }
    if (!src) {
      setState({ phase: "error" });
      return;
    }
    const controller = new AbortController();
    let alive = true;
    setState({ phase: "loading" });
    fetchSignedCapped(get, cap, { signal: controller.signal })
      .then((r) => {
        if (!alive) return;
        setState(r.kind === "ok" ? { phase: "ok", bytes: r.bytes } : { phase: "too-large", total: r.total ?? sizeBytes });
      })
      .catch(() => {
        if (alive && !controller.signal.aborted) setState({ phase: "error" });
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [src, cap, sizeBytes, get, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, retry };
}

function PreviewLoading() {
  return (
    <output className="flex flex-1 items-center justify-center gap-2 py-16 text-meta text-muted">
      <Spinner size={14} />
      正在载入预览…
    </output>
  );
}

/** 不能预览时的统一落点：一句原因 + 下载（+ 可选重试）。 */
function PreviewFallback({
  title,
  hint,
  onDownload,
  onRetry,
}: {
  title: string;
  hint?: string;
  onDownload: () => void;
  onRetry?: () => void;
}) {
  return (
    <div data-testid="output-preview-fallback" className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <p className="text-body font-medium text-fg">{title}</p>
      {hint && <p className="max-w-[36ch] text-meta text-muted">{hint}</p>}
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button size="sm" variant="secondary" onClick={onDownload}>
          <Download size={14} aria-hidden />
          下载
        </Button>
        {onRetry && (
          <Button size="sm" variant="ghost" onClick={onRetry}>
            <RotateCcw size={13} aria-hidden />
            重试
          </Button>
        )}
      </div>
    </div>
  );
}

function tooLargeHint(total: number | null, cap: number): string {
  const size = formatBytes(total);
  return `${size ? `文件 ${size}，` : ""}超出在线预览上限（${formatBytes(cap)}），请下载后查看。`;
}

function TextPreview({
  kind,
  asset,
  onText,
  onDownload,
}: {
  kind: "markdown" | "code" | "text";
  asset: ProjectAsset;
  onText: (text: string | null) => void;
  onDownload: () => void;
}) {
  const state = useCappedBytes(outputSrc(asset), TEXT_PREVIEW_MAX_BYTES, asset.sizeBytes);
  const bytes = state.phase === "ok" ? state.bytes : null;
  const text = useMemo(() => (bytes ? decodeText(bytes) : null), [bytes]);
  useEffect(() => {
    onText(text);
  }, [text, onText]);
  if (state.phase === "loading") return <PreviewLoading />;
  if (state.phase === "too-large") {
    return <PreviewFallback title="文件较大" hint={tooLargeHint(state.total, TEXT_PREVIEW_MAX_BYTES)} onDownload={onDownload} />;
  }
  if (state.phase === "error") {
    return <PreviewFallback title="预览加载失败" hint="可以重试，或直接下载。" onDownload={onDownload} onRetry={state.retry} />;
  }
  if (text === null) {
    return <PreviewFallback title="这不是纯文本文件" hint="内容无法按文字显示，请下载后用合适的应用打开。" onDownload={onDownload} />;
  }
  // Markdown 走站内的渲染器（react-markdown，不开原始 HTML；readOnly 不执行 HTML 围栏、图片只走签名/外链只读）。
  if (kind === "markdown") {
    return (
      <div data-testid="output-preview-markdown" className="min-w-0">
        <Markdown readOnly signMedia>
          {text}
        </Markdown>
      </div>
    );
  }
  if (kind === "code" && text.length <= CODE_HIGHLIGHT_MAX_CHARS) {
    return (
      <div data-testid="output-preview-code" className="min-w-0 [&_.prose]:max-w-none">
        <Markdown readOnly>{fenceCode(text, codeLanguageOf(asset.name))}</Markdown>
      </div>
    );
  }
  return (
    <pre
      data-testid="output-preview-text"
      className="min-w-0 whitespace-pre-wrap break-words font-mono text-caption leading-relaxed text-fg"
    >
      {text}
    </pre>
  );
}

function PdfPreview({
  asset,
  onUrl,
  onDownload,
}: {
  asset: ProjectAsset;
  onUrl: (url: string | null) => void;
  onDownload: () => void;
}) {
  const state = useCappedBytes(outputSrc(asset), PDF_PREVIEW_MAX_BYTES, asset.sizeBytes);
  const bytes = state.phase === "ok" ? state.bytes : null;
  const isPdf = bytes ? looksLikePdf(bytes) : false;
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!bytes || !isPdf || typeof URL.createObjectURL !== "function") {
      setUrl(null);
      return;
    }
    // 类型由我们定死为 application/pdf（且已验魔数），浏览器只会交给 PDF 查看器，不会当网页解析。
    const u = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [bytes, isPdf]);
  useEffect(() => {
    onUrl(url);
  }, [url, onUrl]);
  if (state.phase === "loading") return <PreviewLoading />;
  if (state.phase === "too-large") {
    return <PreviewFallback title="文件较大" hint={tooLargeHint(state.total, PDF_PREVIEW_MAX_BYTES)} onDownload={onDownload} />;
  }
  if (state.phase === "error") {
    return <PreviewFallback title="预览加载失败" hint="可以重试，或直接下载。" onDownload={onDownload} onRetry={state.retry} />;
  }
  if (!isPdf) {
    return <PreviewFallback title="文件内容不是有效的 PDF" hint="请下载后查看。" onDownload={onDownload} />;
  }
  if (!url) return <PreviewLoading />;
  return (
    <iframe
      data-testid="output-preview-pdf"
      title={`${asset.name} 预览`}
      src={url}
      className="min-h-0 w-full flex-1 border-0 bg-hover"
    />
  );
}

function ImagePreview({ asset, onDownload }: { asset: ProjectAsset; onDownload: () => void }) {
  const src = outputSrc(asset);
  const { url } = useSignedSrc(src);
  const { get, peek, cacheIdentity } = useFreshSignedUrl(src);
  const { objectUrl, status, percent, reload } = useProgressiveImage({
    src: url,
    width: 1280,
    cacheIdentity,
    resolveSrc: get,
    lazy: false,
  });
  const [zoomOpen, setZoomOpen] = useState(false);
  const [zoomMounted, setZoomMounted] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);
  const openZoom = () => {
    setZoomMounted(true);
    setZoomOpen(true);
    // 点开那一刻重签：查看器挂着超过 5 分钟后再放大，旧签名已失效。
    void get().then((u) => u && setFresh(u));
  };
  if (status === "error") {
    return <PreviewFallback title="图片加载失败" hint="可以重试，或直接下载。" onDownload={onDownload} onRetry={reload} />;
  }
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-hover p-3">
      {objectUrl && status === "loaded" ? (
        <button
          type="button"
          onClick={openZoom}
          aria-label={`放大查看 ${asset.name}`}
          className="flex max-h-full max-w-full cursor-zoom-in items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <img
            data-testid="output-preview-image"
            src={objectUrl}
            alt={asset.name}
            className="max-h-[calc(100dvh-14rem)] max-w-full rounded-md object-contain md:max-h-[min(60dvh,32rem)]"
          />
        </button>
      ) : (
        <output className="flex items-center gap-2 text-meta tabular-nums text-muted">
          <Spinner size={14} />
          {percent != null ? `${percent}%` : "正在载入图片…"}
        </output>
      )}
      {zoomMounted && (fresh ?? url) && (
        <LazyBoundary fallback={null}>
          <ImageViewer
            open={zoomOpen}
            onOpenChange={setZoomOpen}
            src={(fresh ?? url) as string}
            alt={asset.name}
            signPath={src}
            cacheIdentity={cacheIdentity}
            get={get}
            peek={peek}
            initialMode="view"
            readOnly
          />
        </LazyBoundary>
      )}
    </div>
  );
}

function FileDetails({
  asset,
  sourceTitle,
  onOpenSession,
  onShowVersions,
}: {
  asset: ProjectAsset;
  sourceTitle?: string;
  onOpenSession?: () => void;
  onShowVersions?: () => void;
}) {
  const versions = asset.versionCount ?? 1;
  return (
    <div data-testid="output-details" className="flex flex-col gap-3">
      <p className="text-meta text-muted">这类文件不能在线预览，下载后用本地应用打开。</p>
      <DescriptionList divided>
        <DescriptionRow label="名称" value={asset.name} valueClassName="break-all" />
        <DescriptionRow label="类型" value={`${OUTPUT_KIND_LABELS[outputKind(asset)]} · ${extBadgeOf(asset.name)}`} />
        <DescriptionRow label="大小" value={formatBytes(asset.sizeBytes) || "未知"} />
        <DescriptionRow
          label="版本"
          value={
            versions > 1 && onShowVersions ? (
              <Button variant="link" size="sm" className="h-auto px-0 [@media(hover:none)]:-my-3" onClick={onShowVersions}>
                v{versions} · 版本历史
              </Button>
            ) : (
              `v${versions}`
            )
          }
        />
        <DescriptionRow
          label="来源会话"
          value={
            sourceTitle && onOpenSession ? (
              <Button variant="link" size="sm" className="h-auto max-w-full px-0 [@media(hover:none)]:-my-3" onClick={onOpenSession}>
                <span className="truncate">{sourceTitle}</span>
              </Button>
            ) : (
              "—"
            )
          }
        />
        <DescriptionRow label="生成于" value={<TimeAgo value={asset.createdAt} />} />
      </DescriptionList>
    </div>
  );
}

const KIND_LABEL: Record<PreviewKind, string> = {
  image: "图片",
  pdf: "PDF",
  markdown: "Markdown",
  code: "代码",
  text: "文本",
  file: "文件",
};

/**
 * 产出查看器：点产出卡就地打开。窄屏整屏（文件详情是贴底抽屉），桌面居中弹层；Esc / 遮罩 /
 * 关闭钮关闭，焦点由 Radix 收进弹层、关后回到触发的行。
 * 预览按类型：Markdown 渲染、代码高亮、文本按文字、图片（可放大到全屏查看器）、PDF 内嵌；
 * 压缩包 / Office / 未知类型给详情 + 下载。所有字节都走签名 URL，与下载同一条通道。
 * 「在会话中打开」保留为次要操作。
 */
export function OutputViewer({
  asset,
  sourceTitle,
  onClose,
  onOpenSession,
  onShowVersions,
}: {
  asset: ProjectAsset;
  sourceTitle?: string;
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
  onShowVersions: (asset: ProjectAsset) => void;
}) {
  const toast = useToast();
  const kind = previewKindOf(asset);
  const src = outputSrc(asset);
  const versions = asset.versionCount ?? 1;
  const canOpenSession = Boolean(asset.sessionId && sourceTitle);
  const { state: dl, start, cancel } = useSignedDownload(src, asset.name);
  const [text, setText] = useState<string | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const download = useCallback(() => void start(), [start]);

  const openSession = () => {
    if (!asset.sessionId) return;
    onClose();
    onOpenSession(asset.sessionId);
  };
  const showVersions = () => {
    onClose();
    onShowVersions(asset);
  };
  const copy = async () => {
    if (text === null) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast("复制失败，请手动选中文本复制", "error");
    }
  };

  const size = formatBytes(asset.sizeBytes);
  const toolbar = (
    <div className="flex min-w-0 flex-col gap-2">
      <MetaLine>
        <span>{KIND_LABEL[kind]}</span>
        {size && <span>{size}</span>}
        <TimeAgo value={asset.createdAt} tooltip={false} />
        {sourceTitle && <span className="min-w-0 max-w-full truncate">来自「{sourceTitle}」</span>}
      </MetaLine>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          variant="secondary"
          disabled={!src}
          onClick={() => (dl.phase === "downloading" ? cancel() : download())}
          aria-label={dl.phase === "downloading" ? "取消下载" : `下载 ${asset.name}`}
        >
          {dl.phase === "downloading" ? <Spinner size={13} /> : <Download size={14} aria-hidden />}
          {dl.phase === "error" ? "重新下载" : "下载"}
        </Button>
        {isTextual(kind) && text !== null && (
          <Button size="sm" variant="ghost" onClick={() => void copy()}>
            {copied ? <Check size={14} aria-hidden className="text-success" /> : <Copy size={14} aria-hidden />}
            {copied ? "已复制" : "复制"}
          </Button>
        )}
        {kind === "pdf" && pdfUrl && (
          <Button size="sm" variant="ghost" onClick={() => openInNewTab(pdfUrl)}>
            <ExternalLink size={14} aria-hidden />
            新标签页打开
          </Button>
        )}
        {versions > 1 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={showVersions}
            aria-label={`${asset.name} 共 ${versions} 个版本，查看版本历史`}
          >
            <History size={14} aria-hidden />v{versions}
          </Button>
        )}
        {canOpenSession && (
          <Button size="sm" variant="ghost" className="ml-auto text-muted" onClick={openSession}>
            在会话中打开
            <ArrowRight size={13} aria-hidden />
          </Button>
        )}
      </div>
    </div>
  );

  const fullBleed = kind === "image" || kind === "pdf";
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={
        <span className="block break-all" data-testid="output-viewer-title">
          {asset.name}
        </span>
      }
      toolbar={toolbar}
      size={kind === "file" ? "md" : "xl"}
      mobile={kind === "file" ? "sheet" : "fullscreen"}
      fixedHeight={kind !== "file"}
      bodyClassName={cn(fullBleed && "flex flex-col p-0")}
    >
      <div data-testid="output-viewer" data-preview-kind={kind} className={cn("flex min-h-full min-w-0 flex-col", fullBleed && "flex-1")}>
        {kind === "image" && <ImagePreview asset={asset} onDownload={download} />}
        {kind === "pdf" && <PdfPreview asset={asset} onUrl={setPdfUrl} onDownload={download} />}
        {(kind === "markdown" || kind === "code" || kind === "text") && (
          <TextPreview kind={kind} asset={asset} onText={setText} onDownload={download} />
        )}
        {kind === "file" && (
          <FileDetails
            asset={asset}
            sourceTitle={sourceTitle}
            onOpenSession={canOpenSession ? openSession : undefined}
            onShowVersions={versions > 1 ? showVersions : undefined}
          />
        )}
      </div>
    </Modal>
  );
}
