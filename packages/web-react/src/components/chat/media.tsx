/**
 * 媒体签名的 React 接线层。
 *
 * 单一权威：渲染树顶层挂一个 MediaSignProvider，注入 `sign(paths)`（App 用 api.mediaSign，
 * demo 用空实现）。Provider 内置 **path→签名URL 缓存 + inflight 去重**，避免同一路径被
 * 多张卡 / 多次重渲反复签名。深层组件（用户卡媒体格、markdown 行内图）经 useSignedSrc /
 * <Media> 主动 effect 签名，替代"占位永停"。
 */
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { FileText } from "lucide-react";
import type { MediaRef } from "../../lib/chat/frames";
import { classifyMediaRef, isContainerPath, type ResolvedMedia } from "../../lib/chat/media";
import { cn } from "../../lib/utils";

type SignFn = (paths: string[]) => Promise<Record<string, string>>;

type MediaSignCtx = {
  /** 返回 path→签名URL（命中缓存直接回；未命中走 sign 并缓存）。被 ACL 拒的 path 缺失。 */
  resolve: (path: string) => Promise<string | null>;
};

const noop: MediaSignCtx = { resolve: async () => null };
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
  const cacheRef = useRef<Map<string, string>>(new Map());
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
      if (cache.has(path)) return cache.get(path)!;
      const inflight = inflightRef.current;
      const pending = inflight.get(path);
      if (pending) return pending;
      const fn = signRef.current;
      if (!fn) return null;
      const p = fn([path])
        .then((urls) => {
          const url = urls?.[path] ?? null;
          if (url) cache.set(path, url);
          return url;
        })
        .catch(() => null)
        .finally(() => inflight.delete(path));
      inflight.set(path, p);
      return p;
    },
  });

  return <Ctx.Provider value={ctxRef.current}>{children}</Ctx.Provider>;
}

/**
 * 把一个"待签名的容器路径"解析为可用 URL。direct（http/data/已签名）原样回；
 * 容器路径走 provider 主动签名。返回 null 时调用方渲染占位/降级。
 */
export function useSignedSrc(src: string | null | undefined): string | null {
  const { resolve } = useContext(Ctx);
  const [url, setUrl] = useState<string | null>(() =>
    src && !isContainerPath(src) ? src : null,
  );
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
  }, [src, resolve]);
  return url;
}

/** markdown 行内 <img>：容器路径主动签名后渲染，否则直渲。签不出时显示替代文本。 */
export function SignedImg(props: React.ImgHTMLAttributes<HTMLImageElement>) {
  const { src, alt, ...rest } = props;
  const resolved = useSignedSrc(typeof src === "string" ? src : null);
  if (!resolved) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-hover px-2 py-1 text-xs text-faint">
        <FileText size={12} /> {alt || "媒体加载中…"}
      </span>
    );
  }
  // biome-ignore lint/a11y/useAltText: alt 经 props 透传
  return <img src={resolved} alt={alt || ""} loading="lazy" {...rest} />;
}

/** 单个已分类媒体的实际元素（image/video/audio/file）。 */
function MediaItem({ item }: { item: ResolvedMedia }) {
  const path = item.mode === "sign" ? item.path : null;
  const direct = item.mode === "direct" ? item.src : null;
  const signed = useSignedSrc(path);
  const url = direct ?? signed;

  if (item.mode === "none") {
    return (
      <a className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-muted">
        <FileText size={15} /> {item.filename || "附件"}
      </a>
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
          className="max-h-72 max-w-full rounded-lg border border-border object-contain"
        />
      </a>
    );
  }
  if (item.kind === "video") {
    return (
      // biome-ignore lint/a11y/useMediaCaption: 用户/模型上传媒体无字幕轨
      <video src={url} controls className="max-h-72 max-w-full rounded-lg border border-border" />
    );
  }
  if (item.kind === "audio") {
    return <audio src={url} controls className="w-full max-w-sm" />;
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
