/**
 * 媒体签名的 React 接线层。
 *
 * 单一权威：渲染树顶层挂一个 MediaSignProvider，注入 `sign(paths)`（App 用 api.mediaSign，
 * demo 用空实现）。Provider 内置 **path→签名URL 缓存 + inflight 去重**，避免同一路径被
 * 多张卡 / 多次重渲反复签名。深层组件（用户卡媒体格、markdown 行内图）经 useSignedSrc /
 * <Media> 主动 effect 签名，替代"占位永停"。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Download, FileText, Pencil, RotateCcw, X } from "lucide-react";
import type { MediaRef } from "../../lib/chat/frames";
import { classifyMediaRef, needsSignedSrc, type ResolvedMedia } from "../../lib/chat/media";
import { useImageEditActions } from "./imageEditActions";
import {
  downloadPercent,
  formatBytes,
  nativeDownload,
  pickDownloadStrategy,
  saveBlob,
} from "../../lib/chat/download";
import { cn } from "../../lib/utils";
import { authScopedImageIdentity, pickThumbnailWidth } from "../../lib/chat/imageBytes";
import { useProgressiveImage } from "../../lib/chat/useProgressiveImage";
import { ImageViewer } from "../ImageViewer";

/** 气泡缩略默认按 dpr 选档:标屏 640,retina 1280(与服务端白名单一致)。 */
function defaultThumbWidth(): 640 | 1280 {
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  return pickThumbnailWidth(640, dpr);
}

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
  /** 同步读缓存:有未过期条目回 URL,否则 null(不触发签名)。点击手势内的快路径用 —— 锚点原生导航前校正 href。 */
  peek: (path: string) => string | null;
  /** 图片字节缓存的租户命名空间；与签名 URL 缓存共用同一 authKey 边界。 */
  authKey: string | number | null;
};

const noop: MediaSignCtx = {
  resolve: async () => null,
  invalidate: () => {},
  peek: () => null,
  authKey: null,
};
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
  const mountedRef = useRef(false);
  useEffect(() => {
    signRef.current = sign;
    // 只在 sign/authKey **变化**时重置,首挂载跳过 —— 子组件 effect 先于本 effect 跑,
    // 首挂载也换 Map 会把首批 resolve 的缓存写进被丢弃的旧 Map(首批媒体点击时被迫重签)。
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
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
    peek: (path: string) => {
      const hit = cacheRef.current.get(path);
      return hit && hit.expiresAt > Date.now() ? hit.url : null;
    },
    authKey: authKey ?? null,
  });

  // resolve/invalidate/peek 跨重渲稳定；authKey 变时换 context value，让子树在同一 render
  // 立即得到新字节缓存命名空间。旧异步闭包则保留旧 identity，只能写旧账号 key。
  const value = useMemo<MediaSignCtx>(
    () => ({ ...ctxRef.current, authKey: authKey ?? null }),
    [authKey],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
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
    src && !needsSignedSrc(src) ? src : null,
  );
  const [attempt, setAttempt] = useState(0);
  const retriedRef = useRef(false);
  useEffect(() => {
    let alive = true;
    if (!src) {
      setUrl(null);
      return;
    }
    if (!needsSignedSrc(src)) {
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
    if (retriedRef.current || !src || !needsSignedSrc(src)) return;
    retriedRef.current = true;
    invalidate(src);
    setAttempt((n) => n + 1); // 触发重签 effect
  };
  return { url, onError };
}

/**
 * 点击时签名权威:交互(下载/开原图)发生的**那一刻**解析签名 URL,而不是复用组件
 * 挂载时签的旧 URL。签名 URL 服务端 TTL 仅 5min,而"看完回复过几分钟再点下载"是
 * 常态路径 —— 挂载时签名在这类交互上必然过期(2026-07-10 用户 175 "下载不了文件"
 * 410 死循环根因)。所有"用户手势触发的取媒体"都必须经此 helper,禁止直接冻结
 * useSignedSrc 的挂载态 URL。
 *
 * - get():provider 缓存未过期(≤4min,留 1min 服务端余量)直接命中,过期自动重签;
 *   forceResign 先删缓存强制重签(fetch 已拿到 410/403 的场景 —— 本地钟认为没过期
 *   但服务端裁决已死,以服务端为准)。
 * - peek():同步读缓存,点击手势内校正锚点 href 用(异步 get 会脱离手势激活窗口,
 *   Safari 弹窗拦截风险,能同步就同步)。
 * - 非容器路径(http/data:)原样返回,无过期概念。
 */
function useFreshSignedUrl(src: string | null | undefined): {
  get: (opts?: { forceResign?: boolean }) => Promise<string | null>;
  peek: () => string | null;
  cacheIdentity: string | null;
} {
  const { resolve, invalidate, peek, authKey } = useContext(Ctx);
  const get = useCallback(
    async (opts?: { forceResign?: boolean }) => {
      if (!src) return null;
      if (!needsSignedSrc(src)) return src;
      if (opts?.forceResign) invalidate(src);
      return resolve(src);
    },
    [src, resolve, invalidate],
  );
  const peekFresh = useCallback(
    () => (src ? (needsSignedSrc(src) ? peek(src) : src) : null),
    [src, peek],
  );
  const cacheIdentity = authScopedImageIdentity(authKey, src && needsSignedSrc(src) ? src : null);
  return { get, peek: peekFresh, cacheIdentity };
}

/**
 * 可放大图片(共享灯箱 + 编辑入口):点击开全屏查看器(2026-07-07 boss 反馈"agent 响应的
 * 图表不支持放大")。覆盖 assistant 响应里图片的两条渲染路径 —— markdown 行内 <img>
 * (SignedImg)与媒体附件卡(MediaItem image)。左下角常驻「编辑」胶囊(需求 §3):点击=
 * **直接开全屏查看器并进入圈选编辑器**(不是先进查看器再点),桌面 hover 现、移动端常显;
 * 仅在当前可编辑(image2 门控:ImageEditActionsContext.submitImageEdit 存在)时出现,不再
 * 与右下角浮钮双入口并存。加载中亮深色 shimmer 骨架(禁纯白/白闪,需求 §2)。
 * Composer 的附件灯箱是上传预览语义,独立保留。
 */
export function ZoomableImage({
  src,
  alt,
  imgClassName,
  onError,
  signPath,
  thumbWidth,
}: {
  src: string;
  alt: string;
  /** 缩略态 <img> 的样式(灯箱内恒全尺寸 object-contain)。 */
  imgClassName?: string;
  onError?: React.ReactEventHandler<HTMLImageElement>;
  /** 原始容器路径(src 是签名 URL 时传)。传了才有"开灯箱/开原图时点击时重签"能力,也作字节缓存身份。 */
  signPath?: string | null;
  /** 缩略请求宽度(640/1280);缺省按 dpr 自选。null = 直接取原图(不缩)。 */
  thumbWidth?: number | null;
}) {
  const [open, setOpen] = useState(false);
  // 「当前可编辑图片」的唯一判定 = ImageEditActionsContext.submitImageEdit 是否注入
  // (image2 开放 + GPT 引擎模型)。收敛到单一权威,不再各自平行判定。
  const canEdit = !!useImageEditActions().submitImageEdit;
  const { get, peek, cacheIdentity } = useFreshSignedUrl(signPath ?? null);

  // 缩略分级 + 流式进度 + 字节复用(单一 hook 收口)。签名 URL 请求 ?w=<640|1280>;
  // 直链/本地 blob 零网络透传。懒加载:进视口才拉,避免长会话多图打爆 per-uid 6 并发闸。
  const width = thumbWidth === undefined ? defaultThumbWidth() : thumbWidth;
  const { containerRef, objectUrl, percent, status, reload } = useProgressiveImage({
    src,
    width,
    cacheIdentity,
    resolveSrc: get,
    lazy: true,
  });

  // 灯箱内用的最新签名 URL:开灯箱那一刻刷新(挂载 >5min 后再看大图,旧 URL 已死)。
  const [freshSrc, setFreshSrc] = useState<string | null>(null);
  const display = freshSrc ?? src;
  const signFresh = () => {
    if (signPath) void get().then((u) => u && setFreshSrc(u));
  };
  // 缩略图与左下角「编辑」胶囊都开**查看器 view 模式**(image r4 §5a):进去先看大图,
  // 再从底部动作条三选 编辑/评论/调整大小。编辑可用性由查看器内动作条据 ImageEditActionsContext
  // 门控(单一权威),此处不再各自判定。
  const openViewer = () => {
    setOpen(true);
    signFresh();
  };
  const handleOpenChange = (o: boolean) => {
    setOpen(o);
    if (o) signFresh();
  };
  return (
    <>
      <span ref={containerRef} className="group relative inline-block max-w-full">
        <button
          type="button"
          // 失败态复用同一钮做「点击重试」(避免 button 内嵌 button 的非法 DOM);
          // 就绪/加载态点击开查看器。
          aria-label={
            status === "error"
              ? `重试加载${alt ? ` ${alt}` : "图片"}`
              : `放大查看${alt ? ` ${alt}` : "图片"}`
          }
          onClick={() => (status === "error" ? reload() : openViewer())}
          className="relative block max-w-full cursor-zoom-in overflow-hidden rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          {objectUrl && (
            <img
              src={objectUrl}
              alt={alt}
              decoding="async"
              onError={(e) => onError?.(e)}
              className={cn(imgClassName, status !== "loaded" && "absolute inset-0 h-full w-full opacity-0")}
            />
          )}
          {/* 加载中/未就绪:深色 shimmer 骨架 + 居中百分比(禁纯白;reduced-motion 由 CSS 处理)。
              失败:同骨架底 +「加载失败 · 点击重试」文案。加载完由 <img> 接管尺寸。 */}
          {status !== "loaded" && (
            <span
              className="oc-img-skeleton flex h-40 w-64 max-w-full items-center justify-center rounded-lg"
              {...(status === "error" ? { role: "alert" } : { "aria-hidden": true })}
            >
              <span className="flex items-center gap-1 text-center text-xs font-medium tabular-nums text-white/85 drop-shadow">
                {status === "error" ? (
                  <>
                    <RotateCcw size={12} /> 加载失败 · 点击重试
                  </>
                ) : percent != null ? (
                  `${percent}%`
                ) : (
                  "加载中…"
                )}
              </span>
            </span>
          )}
        </button>
        {canEdit && (
          <button
            type="button"
            aria-label="编辑图片"
            title="编辑 · Image 2"
            onClick={() => openViewer()}
            // 桌面**常显**(此前 sm:opacity-0 仅 hover 才现 → 鼠标用户发现不了编辑入口,是
            // 「电脑端用不了」的主因之一);移动端本就常显。hover 只做底色加深的强调,不再靠它
            // 决定"有没有入口"。cursor-pointer 显式声明(不依赖全局兜底,这是关键交互点)。
            className="absolute bottom-2 left-2 flex min-h-11 cursor-pointer items-center gap-1.5 rounded-full bg-black/65 px-3 text-xs font-medium text-white shadow-float backdrop-blur transition-colors hover:bg-black/85 sm:min-h-9"
          >
            <Pencil size={15} />编辑
          </button>
        )}
      </span>
      {/* 全屏沉浸查看器(替代旧内联灯箱):三模式 编辑/评论/调整大小。签名不在此复制,
          下传 get/peek(点击时签名权威);submit 由 App 经 ImageEditActionsContext 供给。
          display=开灯箱时现签的最新 URL;initialMode 恒 'view'(胶囊改开 view 模式,§5a)。 */}
      <ImageViewer
        open={open}
        onOpenChange={handleOpenChange}
        src={display}
        alt={alt}
        signPath={signPath ?? null}
        cacheIdentity={cacheIdentity}
        get={get}
        peek={peek}
        initialMode="view"
      />
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
      signPath={typeof src === "string" && needsSignedSrc(src) ? src : null}
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
 * 大文件下载接线：点击 idle 卡 → **点击时**经 useFreshSignedUrl 解析签名 URL → fetch →
 * 按 Content-Length 决策（见 pickDownloadStrategy）。仅 3MB~100MB 走 body.getReader()
 * 流读 + Blob 存盘并渲染进度；小/超大/未知一律回落原生 `<a download>`（nativeDownload）。
 * fetch 拿到 410(过期)/403(签名失效) → 强制重签一次再试(服务端裁决优先于本地缓存钟)。
 * 其余异常 → error 态（重试 + 直接下载兜底,两者同样走点击时签名）。
 */
function useSignedDownload(src: string | null, name: string) {
  const { get } = useFreshSignedUrl(src);
  const [state, setState] = useState<DownloadState>({ phase: "idle" });
  const abortRef = useRef<AbortController | null>(null);
  const cancelledRef = useRef(false);
  // 卸载即中止在途下载，防 setState-after-unmount。
  useEffect(() => () => abortRef.current?.abort(), []);

  const start = useCallback(async () => {
    if (!src) return;
    cancelledRef.current = false;
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ phase: "downloading", loaded: 0, total: null });
    try {
      let url = await get();
      if (!url) throw new Error("sign failed");
      let res = await fetch(url, { signal: controller.signal });
      if (res.status === 410 || res.status === 403) {
        const resigned = await get({ forceResign: true });
        if (resigned) {
          url = resigned;
          res = await fetch(url, { signal: controller.signal });
        }
      }
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
  }, [src, get, name]);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    abortRef.current?.abort();
  }, []);

  /** 「直接下载」逃生门(iOS blob 异常等不可检测场景):同样点击时签名后交原生下载。 */
  const direct = useCallback(async () => {
    const url = await get();
    if (url) nativeDownload(url, name);
  }, [get, name]);

  return { state, start, cancel, direct };
}

/** markdown 行内/正文里的容器文件路径 → 可下载文件卡(doc-card)。非媒体文件(txt/docx/pdf/zip…)。
 * 经 /api/media-sign 把容器路径换成同源签名 URL；小文件原生 <a download>，大文件 fetch 流式带进度。 */
export function SignedFileCard({ src, filename }: { src?: string; filename?: string }) {
  // resolved 只做占位门(容器冷启签不出→不可点)与锚点 href 装饰;真正的下载 URL 由
  // useSignedDownload 在**点击时**解析(挂载时 URL 5min 即过期,冻结它=410 死循环)。
  const { url: resolved } = useSignedSrc(typeof src === "string" ? src : null);
  const name = (filename || (typeof src === "string" ? src.split("/").pop() : "") || "文件").trim();
  const { state, start, cancel, direct } = useSignedDownload(typeof src === "string" ? src : null, name);

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
            onClick={(e) => {
              // 点击时重签后交原生下载;href 仅留给"右键/长按另存"语义。
              e.preventDefault();
              void direct();
            }}
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
  if (item.mode === "sign" && item.kind === "file") {
    // 容器内非媒体文件:收口到 SignedFileCard(点击时签名 + 410/403 重签 + 流式进度)。
    // 此前这里是一条冻结挂载时签名 URL 的裸 <a>,消息渲染 >5min 后点击即 410 死链。
    return <SignedFileCard src={item.path} filename={item.filename} />;
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
        signPath={path}
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
