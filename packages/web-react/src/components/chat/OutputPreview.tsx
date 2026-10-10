/**
 * 产出页主卡片的正文(懒加载块,OCV5-372):把一个文件 / 图片按它本来的样子渲染出来。
 *
 *  - 正文来源:优先用会话里回放出的全文(fileSnapshot,零请求、容器回收后也在);回放不出来时
 *    经现有的媒体签名通道读容器里的当前文件(≤1 MB,与项目产出预览同一套上限与重签)。
 *  - HTML:沙盒 iframe(allow-scripts、无 same-origin,与聊天里的 HTML 预览同一策略)。
 *  - Markdown:渲染;代码 / 文本:高亮。都走只读 Markdown,不执行内嵌 HTML、不自动探测语言。
 */
import { AlertCircle, RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Markdown } from "../Markdown";
import {
  CODE_HIGHLIGHT_MAX_CHARS,
  MARKDOWN_RENDER_MAX_CHARS,
  TEXT_PREVIEW_MAX_BYTES,
  codeLanguageOf,
  decodeText,
  fenceCode,
  fetchSignedCapped,
} from "../project/outputPreview";
import { Skeleton } from "../ui";
import { SignedImg, SignedVideo, SignedAudio, useFreshSignedUrl } from "./media";
import type { OutputKind } from "./workbench";

export type PreviewView = "preview" | "source";

type TextState =
  | { phase: "ready"; text: string; origin: "session" | "file"; truncated?: boolean }
  | { phase: "loading" }
  | { phase: "too-large" }
  | { phase: "binary" }
  | { phase: "failed"; message: string };

/** 文件正文:会话回放优先,否则读容器里的当前文件。 */
function useFileText(path: string, replayed: string | null, refreshKey: string): { state: TextState; retry: () => void } {
  const { get } = useFreshSignedUrl(replayed === null ? path : null);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<TextState>(() =>
    replayed !== null ? { phase: "ready", text: replayed, origin: "session" } : { phase: "loading" },
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt 是「重试」、refreshKey 是「又有工具动过这个文件」的重读信号
  useEffect(() => {
    if (replayed !== null) {
      setState({ phase: "ready", text: replayed, origin: "session" });
      return;
    }
    const controller = new AbortController();
    setState({ phase: "loading" });
    fetchSignedCapped(get, TEXT_PREVIEW_MAX_BYTES, { signal: controller.signal })
      .then((r) => {
        if (controller.signal.aborted) return;
        if (r.kind === "too-large") return setState({ phase: "too-large" });
        const text = decodeText(r.bytes);
        setState(text === null ? { phase: "binary" } : { phase: "ready", text, origin: "file" });
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setState({ phase: "failed", message: e instanceof Error ? e.message : String(e) });
      });
    return () => controller.abort();
  }, [replayed, get, attempt, refreshKey]);
  return { state, retry: () => setAttempt((n) => n + 1) };
}

function Notice({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center text-meta text-muted" data-testid="output-preview-notice">
      <AlertCircle size={18} className="text-faint" aria-hidden />
      <p>{text}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-accent outline-none hover:bg-accent-soft focus-visible:ring-2 focus-visible:ring-ring"
        >
          <RotateCw size={12} aria-hidden />
          重试
        </button>
      )}
    </div>
  );
}

const FRAME_CLASS = "block h-[min(68vh,640px)] w-full border-0 bg-white";

function TextBody({ text, kind, name, view }: { text: string; kind: OutputKind; name: string; view: PreviewView }) {
  if (view === "preview" && kind === "html") {
    // sandbox 不含 allow-same-origin:取不到父页 cookie / storage;只允许脚本跑演示。
    return <iframe sandbox="allow-scripts" srcDoc={text} title={`${name} 预览`} className={FRAME_CLASS} data-testid="output-preview-frame" />;
  }
  if (view === "preview" && kind === "markdown" && text.length <= MARKDOWN_RENDER_MAX_CHARS) {
    return (
      <div className="px-5 py-4 text-body" data-testid="output-preview-markdown">
        <Markdown readOnly signMedia autoDetectCode={false}>
          {text}
        </Markdown>
      </div>
    );
  }
  if (text.length > CODE_HIGHLIGHT_MAX_CHARS) {
    return <pre className="overflow-auto px-4 py-3 font-mono text-xs text-fg">{text}</pre>;
  }
  const language = kind === "html" ? "html" : kind === "markdown" ? "markdown" : kind === "text" ? "text" : codeLanguageOf(name);
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
}: {
  path: string;
  name: string;
  kind: OutputKind;
  /** 会话回放出的全文;null = 回放不出来,读容器文件。 */
  replayed: string | null;
  /** 动过这个文件的工具行的指纹;变了就重读容器文件(只在回放不出来、走读文件时有意义)。 */
  refreshKey?: string;
  view: PreviewView;
}) {
  const { state, retry } = useFileText(path, replayed, refreshKey);
  if (state.phase === "loading") {
    return (
      <div className="space-y-2 px-5 py-5" data-testid="output-preview-loading">
        <Skeleton className="h-3 w-2/3" />
        <Skeleton className="h-3 w-5/6" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    );
  }
  if (state.phase === "too-large") return <Notice text="文件超过 1 MB，不在面板里预览；可以下载查看。" />;
  if (state.phase === "binary") return <Notice text="这不是文本文件，不在面板里预览；可以下载查看。" />;
  if (state.phase === "failed") return <Notice text="没能读取这个文件（可能已被移动或删除）。" onRetry={retry} />;
  return <TextBody text={state.text} kind={kind} name={name} view={view} />;
}

export function MediaPreview({ src, kind, name }: { src: string; kind: "image" | "video" | "audio"; name: string }) {
  if (kind === "video") return <SignedVideo src={src} controls className="block max-h-[68vh] w-full bg-black" />;
  if (kind === "audio") return <div className="px-5 py-6"><SignedAudio src={src} controls className="w-full" /></div>;
  return (
    <div className="flex justify-center bg-hover/40 p-4 [&_img]:max-h-[64vh] [&_img]:rounded-md [&_img]:object-contain" data-testid="output-preview-image">
      <SignedImg src={src} alt={name} className="max-h-[64vh] w-auto rounded-md object-contain" />
    </div>
  );
}
