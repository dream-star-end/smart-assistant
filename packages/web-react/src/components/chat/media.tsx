/**
 * 媒体签名的 React 接线层。
 *
 * 单一权威：渲染树顶层挂一个 MediaSignProvider，注入 `sign(paths)`（App 用 api.mediaSign，
 * demo 用空实现）。Provider 内置 **path→签名URL 缓存 + inflight 去重**，避免同一路径被
 * 多张卡 / 多次重渲反复签名。深层组件（用户卡媒体格、markdown 行内图）经 useSignedSrc /
 * <Media> 主动 effect 签名，替代"占位永停"。
 */
import * as Dialog from "@radix-ui/react-dialog";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { AlertCircle, Download, ExternalLink, FileText, RotateCcw, X } from "lucide-react";
import type { MediaRef } from "../../lib/chat/frames";
import { classifyMediaRef, isContainerPath, type ResolvedMedia } from "../../lib/chat/media";
import {
  downloadPercent,
  formatBytes,
  nativeDownload,
  pickDownloadStrategy,
  saveBlob,
} from "../../lib/chat/download";
import { cn } from "../../lib/utils";

type SignFn = (paths: string[]) => Promise<Record<string, string>>;

// 签名 URL 服务端有效期 5min(bearerless)。缓存按 4min 过期 —— 留 1min 余量,避免把
// "还差几秒就失效"的 URL 交给刚挂载的 <img>(挂载+网络请求期间过期 → 403 裂图)。
const SIGN_TTL_MS = 4 * 60_000;

type CacheEntry = { url: string; expiresAt: number };

type MediaSignCtx = {
  /** 返回 path→签名URL（命中未过期缓存直接回；未命中/已过期走 sign 并缓存）。被 ACL 拒的 path 缺失。 */
  resolve: (path: string) => Promise<string | null>;
  /** 主动失效(媒体元素 onerror 重签用):删缓存条目,下次 resolve 重签。 */
  invalidate: (path: string) => void;
};

const noop: MediaSignCtx = { resolve: async () => null, invalidate: () => {} };
const Ctx = createContext<MediaSignCtx>(noop);

export function MediaSignProvider({
  sign,
  authKey,
  children,
}: {
  sign: SignFn | null;
  // P5 fix(Codex):商业签名 URL 是 5min bearerless、token 内含 user/path。同浏览器换账号后
  // 旧账号 signed URL 不能命中(隐私)。authKey 随登录用户变化(登出→null),变即清缓存。
  authKey?: string | number | null;
  children: React.ReactNode;
}) {
  // 缓存与 inflight 跨重渲存活；sign 或 authKey 变化（登录态/账号切换）时重置。
  const cacheRef = useRef<Map<string, CacheEntry>>(new Map());
  const inflightRef = useRef<Map<string, Promise<string | null>>>(new Map());
  const signRef = useRef<SignFn | null>(sign);
  useEffect(() => {
    signRef.current = sign;
    // P5 fix(Codex R2):换 Map 实例,**非** .clear()。resolve() 在 .then 里用调用时捕获的 cache
    // 引用 cache.set(url);若只 clear() 同一 Map,账号切换期间旧 inflight 晚返回会把旧账号
    // bearerless signed URL 重新写回当前 cache → 隐私泄漏。换实例后旧 inflight 只写进已弃用的旧
    // Map(被 GC),新 resolve() 读到的是干净的新 Map,同 path 走新账号 token 重签。
    cacheRef.current = new Map();
    inflightRef.current = new Map();
  }, [sign, authKey]);

  const ctxRef = useRef<MediaSignCtx>({
    resolve: async (path: string) => {
      const cache = cacheRef.current;
      const hit = cache.get(path);
      // TTL:过期条目视为 miss(此前缓存永不过期 → 长会话 >5min 后重挂载的媒体拿到
      // 过期 URL,403 永久裂图且无重签路径)。
      if (hit && hit.expiresAt > Date.now()) return hit.url;
      if (hit) cache.delete(path);
      const inflight = inflightRef.current;
      const pending = inflight.get(path);
      if (pending) return pending;
      const fn = signRef.current;
      if (!fn) return null;
      const p = fn([path])
        .then((urls) => {
          const url = urls?.[path] ?? null;
          if (url) cache.set(path, { url, expiresAt: Date.now() + SIGN_TTL_MS });
          return url;
        })
        .catch(() => null)
        .finally(() => inflight.delete(path));
      inflight.set(path, p);
      return p;
    },
    invalidate: (path: string) => {
      cacheRef.current.delete(path);
    },
  });

  return <Ctx.Provider value={ctxRef.current}>{children}</Ctx.Provider>;
}

/**
 * 把一个"待签名的容器路径"解析为可用 URL。direct（http/data/已签名）原样回；
 * 容器路径走 provider 主动签名。url 为 null 时调用方渲染占位/降级。
 * onError:接到媒体元素的 onError —— 签名 URL 过期(403)时失效缓存并重签**一次**
 * (retriedRef 防 403 循环;真 ACL 拒绝重签一次后停在占位)。
 */
export function useSignedSrc(src: string | null | undefined): {
  url: string | null;
  onError: () => void;
} {
  const { resolve, invalidate } = useContext(Ctx);
  const [url, setUrl] = useState<string | null>(() =>
    src && !isContainerPath(src) ? src : null,
  );
  const [attempt, setAttempt] = useState(0);
  const retriedRef = useRef(false);
  useEffect(() => {
    let alive = true;
    if (!src) {
      setUrl(null);
      return;
    }
    if (!isContainerPath(src)) {
      setUrl(src);
      return;
    }
    setUrl(null);
    void resolve(src).then((u) => {
      if (alive) setUrl(u);
    });
    return () => {
      alive = false;
    };
  }, [src, resolve, attempt]);
  // src 变化重置一次性重试额度。
  useEffect(() => {
    retriedRef.current = false;
  }, [src]);
  const onError = () => {
    if (retriedRef.current || !src || !isContainerPath(src)) return;
    retriedRef.current = true;
    invalidate(src);
    setAttempt((n) => n + 1); // 触发重签 effect
  };
  return { url, onError };
}

/**
 * 可放大图片(共享灯箱):点击开全屏预览(2026-07-07 boss 反馈"agent 响应的图表
 * 不支持放大")。覆盖 assistant 响应里图片的两条渲染路径 —— markdown 行内 <img>
 * (SignedImg)与媒体附件卡(MediaItem image)。灯箱内提供"新标签打开原图"
 * (移动端可借浏览器原生缩放细看图表)。Composer 的附件灯箱是上传预览语义,独立保留。
 */
export function ZoomableImage({
  src,
  alt,
  imgClassName,
  onError,
}: {
  src: string;
  alt: string;
  /** 缩略态 <img> 的样式(灯箱内恒全尺寸 object-contain)。 */
  imgClassName?: string;
  onError?: React.ReactEventHandler<HTMLImageElement>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-label={`放大查看${alt ? ` ${alt}` : "图片"}`}
        onClick={() => setOpen(true)}
        className="block max-w-full cursor-zoom-in rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      >
        <img src={src} alt={alt} loading="lazy" onError={onError} className={imgClassName} />
      </button>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm data-[state=open]:animate-fade" />
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed left-1/2 top-1/2 z-50 max-h-[92vh] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 focus:outline-none"
          >
            <Dialog.Title className="sr-only">{alt || "图片预览"}</Dialog.Title>
            <img src={src} alt={alt} className="max-h-[88vh] max-w-[94vw] rounded-lg object-contain shadow-float" />
            <div className="mt-2 flex items-center justify-center gap-3">
              <a
                href={src}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 rounded-full bg-surface px-3 py-1 text-xs font-medium text-fg no-underline shadow-float transition-colors hover:bg-hover"
              >
                <ExternalLink size={12} /> 新标签打开原图
              </a>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="关闭预览"
                className="absolute -right-2 -top-2 flex size-8 items-center justify-center rounded-full bg-surface text-fg shadow-float outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X size={16} />
              </button>
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

/** markdown 行内 <img>：容器路径主动签名后渲染，否则直渲。签不出时显示替代文本。 */
export function SignedImg(props: React.ImgHTMLAttributes<HTMLImageElement>) {
  const { src, alt, ...rest } = props;
  const { url: resolved, onError } = useSignedSrc(typeof src === "string" ? src : null);
  if (!resolved) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-hover px-2 py-1 text-xs text-faint">
        <FileText size={12} /> {alt || "媒体加载中…"}
      </span>
    );
  }
  return (
    <ZoomableImage
      src={resolved}
      alt={typeof alt === "string" ? alt : ""}
      onError={onError}
      imgClassName={typeof rest.className === "string" ? rest.className : undefined}
    />
  );
}

/** markdown 行内 <video>：容器路径签名后渲染（rehypeEmbedMedia 把媒体路径行内码转成 video 节点用）。 */
export function SignedVideo(props: React.VideoHTMLAttributes<HTMLVideoElement> & { src?: string }) {
  const { src, ...rest } = props;
  const { url: resolved, onError } = useSignedSrc(typeof src === "string" ? src : null);
  if (!resolved) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-hover px-2 py-1 text-xs text-faint">
        <FileText size={12} /> 视频加载中…
      </span>
    );
  }
  // biome-ignore lint/a11y/useMediaCaption: 模型生成媒体无字幕轨
  return <video src={resolved} controls onError={onError} className="my-2 max-h-72 max-w-full rounded-lg border border-border" {...rest} />;
}

/** markdown 行内 <audio>：容器路径签名后渲染。 */
export function SignedAudio(props: React.AudioHTMLAttributes<HTMLAudioElement> & { src?: string }) {
  const { src, ...rest } = props;
  const { url: resolved, onError } = useSignedSrc(typeof src === "string" ? src : null);
  if (!resolved) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-hover px-2 py-1 text-xs text-faint">
        <FileText size={12} /> 音频加载中…
      </span>
    );
  }
  return <audio src={resolved} controls onError={onError} className="my-2 w-full max-w-sm" {...rest} />;
}

/** 下载态机（SignedFileCard 用）：idle=可点；downloading=流式进度；error=失败(留重试+直接下载)。*/
type DownloadState =
  | { phase: "idle" }
  | { phase: "downloading"; loaded: number; total: number | null }
  | { phase: "error" };

/**
 * 大文件下载接线：点击 idle 卡 → fetch 同一签名 URL → 按 Content-Length 决策
 * （见 pickDownloadStrategy）。仅 3MB~100MB 走 body.getReader() 流读 + Blob 存盘并渲染进度；
 * 小/超大/未知一律回落原生 `<a download>`（nativeDownload）。任何异常 → error 态（重试 + 直接下载兜底）。
 */
function useSignedDownload(url: string | null, name: string) {
  const [state, setState] = useState<DownloadState>({ phase: "idle" });
  const abortRef = useRef<AbortController | null>(null);
  const cancelledRef = useRef(false);
  // 卸载即中止在途下载，防 setState-after-unmount。
  useEffect(() => () => abortRef.current?.abort(), []);

  const start = useCallback(async () => {
    if (!url) return;
    cancelledRef.current = false;
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ phase: "downloading", loaded: 0, total: null });
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get("content-length")) || null;
      // 尺寸决策：仅 3MB~100MB 走流式；其余(小/超大/未知/无流)交原生 <a download>。
      if (pickDownloadStrategy(total) === "native" || !res.body) {
        controller.abort(); // 放弃流式：小文件几乎未下正文；超大文件不入 JS 内存
        setState({ phase: "idle" });
        nativeDownload(url, name);
        return;
      }
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let loaded = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          loaded += value.length;
          setState({ phase: "downloading", loaded, total });
        }
      }
      const type = res.headers.get("content-type") || "application/octet-stream";
      saveBlob(new Blob(chunks as BlobPart[], { type }), name);
      setState({ phase: "idle" });
    } catch {
      // 用户取消 → 回 idle；真失败(网络/中断/blob 异常)→ error（重试 + 直接下载兜底）。
      setState(cancelledRef.current ? { phase: "idle" } : { phase: "error" });
    } finally {
      abortRef.current = null;
    }
  }, [url, name]);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    abortRef.current?.abort();
  }, []);

  return { state, start, cancel };
}

/** markdown 行内/正文里的容器文件路径 → 可下载文件卡(doc-card)。非媒体文件(txt/docx/pdf/zip…)。
 * 经 /api/media-sign 把容器路径换成同源签名 URL；小文件原生 <a download>，大文件 fetch 流式带进度。 */
export function SignedFileCard({ src, filename }: { src?: string; filename?: string }) {
  // 文件卡无媒体加载事件可挂 onError；点击 403 由 TTL 缓存过期重签兜底。
  const { url: resolved } = useSignedSrc(typeof src === "string" ? src : null);
  const name = (filename || (typeof src === "string" ? src.split("/").pop() : "") || "文件").trim();
  const { state, start, cancel } = useSignedDownload(resolved ?? null, name);

  const fileIcon = (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
      <FileText size={16} />
    </span>
  );
  const nameLabel = <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{name}</span>;

  // 未签名(容器冷启)：占位，不可点。
  if (!resolved) {
    return (
      <span
        className="my-1.5 inline-flex max-w-full items-center gap-2.5 rounded-lg border border-border bg-surface px-3 py-2"
        title="文件准备中…(容器冷启时稍候)"
      >
        {fileIcon}
        {nameLabel}
        <Download size={15} className="shrink-0 text-faint" />
      </span>
    );
  }

  // 下载中：细进度条 + 百分比 + 取消（移动端 h-1.5 条 + ≥h-7 取消目标，进度可见）。
  if (state.phase === "downloading") {
    const pct = downloadPercent(state.loaded, state.total);
    return (
      <span className="my-1.5 inline-flex w-full max-w-[320px] flex-col gap-1.5 rounded-lg border border-border bg-surface px-3 py-2">
        <span className="flex items-center gap-2.5">
          {fileIcon}
          {nameLabel}
          <button
            type="button"
            onClick={cancel}
            aria-label="取消下载"
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-faint hover:text-danger"
          >
            <X size={15} />
          </button>
        </span>
        <span className="flex items-center gap-2">
          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-hover" role="progressbar">
            {/* total 未知时不确定态(1/3 宽脉冲)；已知则按百分比推进 */}
            <span
              className={cn(
                "block h-full rounded-full bg-accent transition-[width] duration-150",
                pct == null && "w-1/3 animate-pulse",
              )}
              style={pct != null ? { width: `${pct}%` } : undefined}
            />
          </span>
          <span className="shrink-0 text-[11px] tabular-nums text-muted">
            {pct != null ? `${pct}%` : formatBytes(state.loaded)}
          </span>
        </span>
      </span>
    );
  }

  // 失败：下载失败 + 重试 + 直接下载（原生兜底：iOS blob 异常等不可检测场景的逃生门）。
  if (state.phase === "error") {
    return (
      <span className="my-1.5 inline-flex max-w-full flex-col gap-1.5 rounded-lg border border-danger/40 bg-surface px-3 py-2">
        <span className="flex items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-danger/10 text-danger">
            <AlertCircle size={16} />
          </span>
          {nameLabel}
        </span>
        <span className="flex items-center gap-3 pl-[42px] text-[12px]">
          <span className="text-danger">下载失败</span>
          <button
            type="button"
            onClick={() => void start()}
            className="flex h-6 items-center gap-1 font-medium text-accent hover:underline"
          >
            <RotateCcw size={12} /> 重试
          </button>
          <a
            href={resolved}
            download={name}
            target="_blank"
            rel="noreferrer"
            className="flex h-6 items-center font-medium text-muted no-underline hover:text-fg hover:underline"
          >
            直接下载
          </a>
        </span>
      </span>
    );
  }

  // idle：拦截点击 → start()（内部按尺寸决定流式或原生兜底）。
  return (
    <a
      href={resolved}
      download={name}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        e.preventDefault();
        void start();
      }}
      className="my-1.5 inline-flex max-w-full items-center gap-2.5 rounded-lg border border-border bg-surface px-3 py-2 no-underline transition-colors hover:border-border-strong hover:bg-hover"
    >
      {fileIcon}
      {nameLabel}
      <Download size={15} className="shrink-0 text-muted" />
    </a>
  );
}

/** 单个已分类媒体的实际元素（image/video/audio/file）。 */
function MediaItem({ item }: { item: ResolvedMedia }) {
  const path = item.mode === "sign" ? item.path : null;
  const direct = item.mode === "direct" ? item.src : null;
  const { url: signed, onError } = useSignedSrc(path);
  const url = direct ?? signed;

  if (item.mode === "none") {
    // 不可下载(无 URL 也无可签路径):纯展示,用 span 而非无 href 的 <a>(a11y:假链接)。
    return (
      <span className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-muted">
        <FileText size={15} /> {item.filename || "附件"}
      </span>
    );
  }
  if (!url) {
    return (
      <div className="flex h-24 w-32 items-center justify-center rounded-lg border border-border bg-hover text-xs text-faint">
        加载中…
      </div>
    );
  }
  if (item.kind === "image") {
    return (
      <ZoomableImage
        src={url}
        alt={item.filename || "图片"}
        onError={onError}
        imgClassName="max-h-72 max-w-full rounded-lg border border-border object-contain"
      />
    );
  }
  if (item.kind === "video") {
    return (
      // biome-ignore lint/a11y/useMediaCaption: 用户/模型上传媒体无字幕轨
      <video src={url} controls onError={onError} className="max-h-72 max-w-full rounded-lg border border-border" />
    );
  }
  if (item.kind === "audio") {
    return <audio src={url} controls onError={onError} className="w-full max-w-sm" />;
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg hover:bg-hover"
    >
      <FileText size={15} /> {item.filename || "下载附件"}
    </a>
  );
}

/** 一组 MediaRef 的渲染（用户消息附件、模型回带媒体）。 */
export function Media({ media, className }: { media: MediaRef[]; className?: string }) {
  if (!media || media.length === 0) return null;
  return (
    <div className={cn("mt-2 flex flex-wrap gap-2", className)}>
      {media.map((m, i) => (
        <MediaItem key={i} item={classifyMediaRef(m)} />
      ))}
    </div>
  );
}
