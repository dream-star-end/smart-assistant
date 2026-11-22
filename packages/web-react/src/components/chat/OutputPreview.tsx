/**
 * 产出页主卡片的正文(懒加载块,OCV5-372 / OCV5-811):把一个文件 / 图片按它本来的样子渲染出来。
 *
 *  - 正文来源:优先用会话里回放出的全文(fileSnapshot,零请求、容器回收后也在);回放不出来时
 *    经现有的媒体签名通道读容器里的当前文件(≤1 MB,与项目产出预览同一套上限与重签)。
 *  - 表格(CSV/TSV)、幻灯片(Marp/Markdown/PPTX)、长文档(Markdown+大纲)、Word/Excel、PDF:
 *    按需懒加载 DeliverableRichPreview，支持筛选排序、16:9 逐页预览、目录阅读与带位置批注回填。
 *  - HTML:沙盒 iframe(allow-scripts、无 same-origin)+ 与聊天里的 HTML 嵌入同一份 CSP(网络只认固定 CDN、禁表单)。
 *  - 源码 / 代码 / 文本:高亮渲染，走只读 Markdown,不执行内嵌 HTML、不自动探测语言。
 */
import { AlertCircle, ChevronLeft, RotateCw } from "lucide-react";
import { Suspense, lazy, useEffect, useState } from "react";
import { Markdown } from "../Markdown";
import { wrapWithCspOnly } from "../embedCsp";
import {
  CODE_HIGHLIGHT_MAX_CHARS,
  TEXT_PREVIEW_MAX_BYTES,
  codeLanguageOf,
  decodeText,
  fenceCode,
  fetchSignedCapped,
} from "../project/outputPreview";
import { Skeleton } from "../ui";
import { classifyDeliverable } from "./deliverablePreview";
import { SignedAudio, SignedImg, SignedVideo, useFreshSignedUrl } from "./media";
import type { OutputKind } from "./workbench";

const DeliverableRichPreview = lazy(() =>
  import("./DeliverableRichPreview").then((m) => ({ default: m.DeliverableRichPreview })),
);

export type PreviewView = "preview" | "source";
export type FilePreviewStatus = "loading" | "ready" | "error" | "unavailable";

type TextState =
  | { phase: "ready"; text: string; origin: "session" | "file"; truncated?: boolean }
  | { phase: "loading" }
  | { phase: "too-large" }
  | { phase: "binary" }
  | { phase: "failed"; message: string };

/** 文件正文:会话回放优先,否则读容器里的当前文件。skip=true 时跳过网络拉取（如二进制 Office / PDF）。 */
function useFileText(
  path: string,
  replayed: string | null,
  refreshKey: string,
  skip: boolean,
  onStatusChange?: (status: FilePreviewStatus) => void,
): { state: TextState; retry: () => void } {
  const { get } = useFreshSignedUrl(!skip && replayed === null ? path : null);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<TextState>(() =>
    skip
      ? { phase: "binary" }
      : replayed !== null
        ? { phase: "ready", text: replayed, origin: "session" }
        : { phase: "loading" },
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt 是「重试」、refreshKey 是「又有工具动过这个文件」的重读信号
  useEffect(() => {
    if (skip) {
      setState({ phase: "binary" });
      onStatusChange?.("ready");
      return;
    }
    if (replayed !== null) {
      setState({ phase: "ready", text: replayed, origin: "session" });
      onStatusChange?.("ready");
      return;
    }
    const controller = new AbortController();
    setState({ phase: "loading" });
    onStatusChange?.("loading");
    fetchSignedCapped(get, TEXT_PREVIEW_MAX_BYTES, { signal: controller.signal })
      .then((r) => {
        if (controller.signal.aborted) return;
        if (r.kind === "too-large") {
          setState({ phase: "too-large" });
          onStatusChange?.("unavailable");
          return;
        }
        const text = decodeText(r.bytes);
        if (text === null) {
          setState({ phase: "binary" });
          onStatusChange?.("unavailable");
        } else {
          setState({ phase: "ready", text, origin: "file" });
          onStatusChange?.("ready");
        }
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setState({ phase: "failed", message: e instanceof Error ? e.message : String(e) });
        onStatusChange?.("error");
      });
    return () => controller.abort();
  }, [replayed, get, attempt, refreshKey, skip, onStatusChange]);
  return { state, retry: () => setAttempt((n) => n + 1) };
}

function PreviewSkeleton() {
  return (
    <div className="space-y-2 px-5 py-5" data-testid="output-preview-loading">
      <Skeleton className="h-3 w-2/3" />
      <Skeleton className="h-3 w-5/6" />
      <Skeleton className="h-3 w-1/2" />
    </div>
  );
}

function Notice({
  title,
  hint,
  onRetry,
  onBackToList,
}: {
  title: string;
  hint?: string;
  onRetry?: () => void;
  onBackToList?: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center text-meta text-muted" data-testid="output-preview-notice">
      <span className="oc-icon-badge flex size-10 items-center justify-center rounded-xl text-faint" aria-hidden>
        <AlertCircle size={18} strokeWidth={1.75} />
      </span>
      <div className="max-w-sm space-y-1">
        <p className="text-body font-medium text-fg">{title}</p>
        {hint && <p className="text-caption leading-relaxed text-muted">{hint}</p>}
      </div>
      {(onRetry || onBackToList) && (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="oc-btn-tactile oc-btn-secondary-craft inline-flex min-h-8 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-caption font-medium text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11"
            >
              <RotateCw size={12} aria-hidden />
              重试读取
            </button>
          )}
          {onBackToList && (
            <button
              type="button"
              onClick={onBackToList}
              className="oc-btn-tactile inline-flex min-h-8 items-center gap-1 rounded-full px-3.5 py-1.5 text-caption font-medium text-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11"
            >
              <ChevronLeft size={13} aria-hidden />
              返回文件列表
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const FRAME_CLASS = "block h-[min(68vh,640px)] w-full border-0 bg-white";

function TextBody({
  path,
  text,
  kind,
  name,
  view,
  onAnnotateToComposer,
}: {
  path: string;
  text: string;
  kind: OutputKind;
  name: string;
  view: PreviewView;
  onAnnotateToComposer?: (draft: string) => void;
}) {
  if (view === "preview" && kind === "html") {
    // sandbox 不含 allow-same-origin:取不到父页 cookie / storage;CSP 放在第 0 个字节,模型的代码改不掉。
    return (
      <iframe
        sandbox="allow-scripts"
        srcDoc={wrapWithCspOnly(text)}
        title={`${name} 预览`}
        className={FRAME_CLASS}
        data-testid="output-preview-frame"
      />
    );
  }
  const meta = classifyDeliverable(path, text);
  if (
    view === "preview" &&
    (meta.format === "csv" ||
      meta.format === "tsv" ||
      meta.format === "markdown" ||
      meta.format === "markdown-slides")
  ) {
    return (
      <Suspense fallback={<PreviewSkeleton />}>
        <DeliverableRichPreview
          path={path}
          name={name}
          text={text}
          meta={meta}
          onAnnotateToComposer={onAnnotateToComposer}
        />
      </Suspense>
    );
  }
  if (text.length > CODE_HIGHLIGHT_MAX_CHARS) {
    return <pre className="overflow-auto px-4 py-3 font-mono text-xs text-fg">{text}</pre>;
  }
  const language =
    kind === "html" ? "html" : kind === "markdown" ? "markdown" : kind === "text" ? "text" : codeLanguageOf(name);
  return (
    <div className="px-3 py-1 [&_pre]:my-2" data-testid="output-preview-source">
      <Markdown readOnly autoDetectCode={false}>
        {fenceCode(text, language)}
      </Markdown>
    </div>
  );
}

export function FilePreview({
  path,
  name,
  kind,
  replayed,
  refreshKey = "",
  view,
  onAnnotateToComposer,
  onBackToList,
  onStatusChange,
}: {
  path: string;
  name: string;
  kind: OutputKind;
  /** 会话回放出的全文;null = 回放不出来,读容器文件。 */
  replayed: string | null;
  /** 动过这个文件的工具行的指纹;变了就重读容器文件(只在回放不出来、走读文件时有意义)。 */
  refreshKey?: string;
  view: PreviewView;
  /** 可选：批注回填至 Composer 输入框的回调。 */
  onAnnotateToComposer?: (draft: string) => void;
  /** 可选：多文件模式下，读取失败时提供「返回文件列表」快捷入口。 */
  onBackToList?: () => void;
  /** 可选：向外同步读取状态，读取失败时自动隐藏底部「批注修改」。 */
  onStatusChange?: (status: FilePreviewStatus) => void;
}) {
  const staticMeta = classifyDeliverable(path, replayed);
  const directRich = view === "preview" && (staticMeta.isBinaryOffice || staticMeta.format === "pdf");
  const { state, retry } = useFileText(path, replayed, refreshKey, directRich, onStatusChange);

  if (directRich) {
    return (
      <Suspense fallback={<PreviewSkeleton />}>
        <DeliverableRichPreview
          path={path}
          name={name}
          meta={staticMeta}
          onAnnotateToComposer={onAnnotateToComposer}
          onBackToList={onBackToList}
          onPreviewError={onStatusChange ? (failed) => onStatusChange(failed ? "error" : "ready") : undefined}
        />
      </Suspense>
    );
  }

  if (state.phase === "loading") {
    return <PreviewSkeleton />;
  }
  if (state.phase === "too-large") {
    return <Notice title="文件超过 1 MB，暂不支持在线预览" hint="可以下载到本地查看完整内容。" onBackToList={onBackToList} />;
  }
  if (state.phase === "binary") {
    return <Notice title="这不是文本文件，暂不支持在线预览" hint="可以下载到本地打开查看。" onBackToList={onBackToList} />;
  }
  if (state.phase === "failed") {
    return (
      <Notice
        title="没能读取这个文件"
        hint="文件可能已被移动、删除，或不在当前容器工作区内。"
        onRetry={retry}
        onBackToList={onBackToList}
      />
    );
  }
  return (
    <TextBody
      path={path}
      text={state.text}
      kind={kind}
      name={name}
      view={view}
      onAnnotateToComposer={onAnnotateToComposer}
    />
  );
}

export function MediaPreview({ src, kind, name }: { src: string; kind: "image" | "video" | "audio"; name: string }) {
  if (kind === "video") return <SignedVideo src={src} controls className="block max-h-[68vh] w-full bg-black" />;
  if (kind === "audio") {
    return (
      <div className="px-5 py-6">
        <SignedAudio src={src} controls className="w-full" />
      </div>
    );
  }
  return (
    <div
      className="oc-surface-recessed flex justify-center p-4 [&_img]:max-h-[64vh] [&_img]:rounded-lg [&_img]:object-contain [&_img]:shadow-soft"
      data-testid="output-preview-image"
    >
      <SignedImg src={src} alt={name} className="max-h-[64vh] w-auto rounded-lg object-contain shadow-soft" />
    </div>
  );
}
