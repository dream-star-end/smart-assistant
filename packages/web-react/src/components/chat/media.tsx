/**
 * 媒体签名的 React 接线层。
 *
 * 单一权威：渲染树顶层挂一个 MediaSignProvider，注入 `sign(paths)`（App 用 api.mediaSign，
 * demo 用空实现）。Provider 内置 **path→签名URL 缓存 + inflight 去重**，避免同一路径被
 * 多张卡 / 多次重渲反复签名。深层组件（用户卡媒体格、markdown 行内图）经 useSignedSrc /
 * <Media> 主动 effect 签名，替代"占位永停"。
 */
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Download, FileText } from "lucide-react";
import type { MediaRef } from "../../lib/chat/frames";
import { classifyMediaRef, isContainerPath, type ResolvedMedia } from "../../lib/chat/media";
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
  // biome-ignore lint/a11y/useAltText: alt 经 props 透传
  return <img src={resolved} alt={alt || ""} loading="lazy" onError={onError} {...rest} />;
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

/** markdown 行内/正文里的容器文件路径 → 可下载文件卡(doc-card)。非媒体文件(txt/docx/pdf/zip…)。
 * 经 /api/media-sign 把容器路径换成同源签名 URL,再用 <a download> 真下载(同源 download 生效)。 */
export function SignedFileCard({ src, filename }: { src?: string; filename?: string }) {
  // 文件卡是 <a download>,无媒体加载事件可挂 onError;点击 403 由 TTL 缓存过期重签兜底。
  const { url: resolved } = useSignedSrc(typeof src === "string" ? src : null);
  const name = (filename || (typeof src === "string" ? src.split("/").pop() : "") || "文件").trim();
  const inner = (
    <>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
        <FileText size={16} />
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{name}</span>
      <Download size={15} className={resolved ? "shrink-0 text-muted" : "shrink-0 text-faint"} />
    </>
  );
  if (!resolved) {
    return (
      <span
        className="my-1.5 inline-flex max-w-full items-center gap-2.5 rounded-lg border border-border bg-surface px-3 py-2"
        title="文件准备中…(容器冷启时稍候)"
      >
        {inner}
      </span>
    );
  }
  return (
    <a
      href={resolved}
      download={name}
      target="_blank"
      rel="noreferrer"
      className="my-1.5 inline-flex max-w-full items-center gap-2.5 rounded-lg border border-border bg-surface px-3 py-2 no-underline transition-colors hover:border-border-strong hover:bg-hover"
    >
      {inner}
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
      <a href={url} target="_blank" rel="noreferrer" className="block">
        <img
          src={url}
          alt={item.filename || "图片"}
          loading="lazy"
          onError={onError}
          className="max-h-72 max-w-full rounded-lg border border-border object-contain"
        />
      </a>
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
