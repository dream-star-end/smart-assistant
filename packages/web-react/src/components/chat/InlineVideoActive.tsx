import { Download, Film, LoaderCircle, Play, RotateCcw } from "lucide-react";
import {
  type SyntheticEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
  type VideoHTMLAttributes,
} from "react";
import { nativeDownload } from "../../lib/chat/download";
import { needsSignedSrc } from "../../lib/chat/media";
import { cn } from "../../lib/utils";
import { claimInlineVideoSlot, releaseInlineVideoSlot, teardownVideoElement } from "./inlineVideoSlot";

type InlineVideoActiveProps = {
  rawSrc: string;
  displayName: string;
  initialAction: "play" | "download";
  get: (opts?: { forceResign?: boolean }) => Promise<string | null>;
  videoProps: VideoHTMLAttributes<HTMLVideoElement>;
};

/**
 * 懒加载的页内视频会话（首次点击播放或下载后按需加载并挂载）：
 * 拥有单实例槽位互斥、点击时签名与 1 次 forceResign、鸿蒙 ArkWeb 防遮挡 observer、
 * 断点续播与同步拆毁原生播放层，兼顾首屏体积预算（OCV5-765）。
 */
export default function InlineVideoActive({
  rawSrc,
  displayName,
  initialAction,
  get,
  videoProps,
}: InlineVideoActiveProps) {
  const {
    autoPlay: _autoPlay,
    playsInline: _playsInline,
    preload: _preload,
    className,
    onEnded: userOnEnded,
    onError: userOnError,
    onLoadedMetadata: userOnLoadedMetadata,
    onTimeUpdate: userOnTimeUpdate,
    ...rest
  } = videoProps;

  const needsSign = needsSignedSrc(rawSrc);
  const [phase, setPhase] = useState<"idle" | "loading" | "playing" | "error">("idle");
  const [activeUrl, setActiveUrl] = useState<string | null>(null);
  const [endedOnce, setEndedOnce] = useState(false);
  const [resumeHint, setResumeHint] = useState(false);

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const slotIdRef = useRef<symbol>(Symbol("inline-video"));
  const epochRef = useRef(0);
  const mountedRef = useRef(true);
  const resumeTimeRef = useRef(0);
  const shouldPlayOnLoadRef = useRef(false);
  const resignedRef = useRef(false);
  const didAutoDownloadRef = useRef(false);
  const collapseRef = useRef<() => void>(() => {});

  const setVideoRef = useCallback((node: HTMLVideoElement | null) => {
    if (!node && videoElRef.current) teardownVideoElement(videoElRef.current);
    videoElRef.current = node;
  }, []);

  const collapseTo = useCallback((nextPhase: "idle" | "error") => {
    const el = videoElRef.current;
    if (el && el.currentTime > 0) {
      resumeTimeRef.current = el.currentTime;
      setResumeHint(true);
    }
    epochRef.current += 1;
    teardownVideoElement(el);
    releaseInlineVideoSlot(slotIdRef.current);
    shouldPlayOnLoadRef.current = false;
    resignedRef.current = false;
    setActiveUrl(null);
    setPhase(nextPhase);
  }, []);

  collapseRef.current = () => collapseTo("idle");

  const activate = useCallback(async () => {
    claimInlineVideoSlot(slotIdRef.current, () => collapseRef.current());
    const myEpoch = ++epochRef.current;
    resignedRef.current = false;
    shouldPlayOnLoadRef.current = true;
    setEndedOnce(false);

    if (!needsSign) {
      setActiveUrl(rawSrc);
      setPhase("playing");
      return;
    }

    setPhase("loading");
    const signed = await get();
    if (!mountedRef.current || epochRef.current !== myEpoch) return;
    if (!signed) {
      releaseInlineVideoSlot(slotIdRef.current);
      shouldPlayOnLoadRef.current = false;
      setPhase("error");
      return;
    }
    setActiveUrl(signed);
    setPhase("playing");
  }, [get, needsSign, rawSrc]);

  const triggerDownload = useCallback(async () => {
    if (!needsSign) {
      nativeDownload(rawSrc, displayName);
      return;
    }
    const url = await get();
    if (!mountedRef.current || !url) return;
    nativeDownload(url, displayName);
  }, [displayName, get, needsSign, rawSrc]);

  const activateRef = useRef(activate);
  activateRef.current = activate;
  const triggerDownloadRef = useRef(triggerDownload);
  triggerDownloadRef.current = triggerDownload;

  // 组件挂载时执行触发懒加载的首个动作；卸载时同步拆毁原生解码器并释放单实例槽位。
  useEffect(() => {
    mountedRef.current = true;
    if (initialAction === "play") {
      void activateRef.current();
    } else if (!didAutoDownloadRef.current) {
      didAutoDownloadRef.current = true;
      void triggerDownloadRef.current();
    }
    return () => {
      mountedRef.current = false;
      epochRef.current += 1;
      teardownVideoElement(videoElRef.current);
      videoElRef.current = null;
      releaseInlineVideoSlot(slotIdRef.current);
    };
  }, [initialAction]);

  // 打开抽屉/弹窗/菜单（Radix 将背景层置 aria-hidden/inert）或滑出视口时自动收起原生视频层，
  // 防止鸿蒙 ArkWeb 原生播放层压住侧栏或抢走页面触摸事件。
  useEffect(() => {
    if (phase !== "playing") return;
    const el = wrapperRef.current;
    if (!el) return;

    const checkOverlayCollision = () => {
      if (el.closest('[aria-hidden="true"], [inert]')) {
        collapseRef.current();
        return;
      }
      const openMenu = document.querySelector(
        '[role="menu"][data-state="open"], [role="listbox"][data-state="open"]',
      );
      if (openMenu && !el.contains(openMenu)) {
        collapseRef.current();
      }
    };

    let mo: MutationObserver | null = null;
    if (typeof MutationObserver !== "undefined" && document.body) {
      mo = new MutationObserver(checkOverlayCollision);
      mo.observe(document.body, {
        attributes: true,
        attributeFilter: ["aria-hidden", "inert", "data-state"],
        childList: true,
        subtree: true,
      });
    }
    checkOverlayCollision();

    let io: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== "undefined") {
      let seenVisible = false;
      io = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              seenVisible = true;
            } else if (seenVisible) {
              collapseRef.current();
              break;
            }
          }
        },
        { threshold: 0.05 },
      );
      io.observe(el);
    }

    return () => {
      mo?.disconnect();
      io?.disconnect();
    };
  }, [phase]);

  const downloadButton = (
    <button
      type="button"
      aria-label={`下载 ${displayName}`}
      onClick={() => void triggerDownload()}
      className="inline-flex min-h-[36px] shrink-0 items-center gap-1 rounded-md px-2.5 text-xs font-medium text-muted hover:bg-hover hover:text-fg"
    >
      <Download size={13} />
      下载
    </button>
  );

  if (phase === "playing" && activeUrl) {
    return (
      <div
        ref={wrapperRef}
        className="my-2 w-full max-w-md overflow-hidden rounded-lg border border-border bg-surface"
      >
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5 text-xs">
          <span className="flex min-w-0 items-center gap-1.5 truncate text-muted">
            <Film size={13} className="shrink-0" />
            <span className="truncate">{displayName}</span>
          </span>
          <div className="flex shrink-0 items-center gap-1">
            {downloadButton}
            <button
              type="button"
              onClick={() => collapseTo("idle")}
              className="min-h-[32px] rounded-md px-2 text-xs font-medium text-muted hover:bg-hover hover:text-fg"
            >
              收起视频
            </button>
          </div>
        </div>
        <video
          ref={setVideoRef}
          src={activeUrl}
          controls
          preload="metadata"
          className={cn("block max-h-72 w-full bg-black", className)}
          {...rest}
          playsInline
          {...({ "webkit-playsinline": "true", "x5-playsinline": "true" } as Record<string, string>)}
          onTimeUpdate={(e) => {
            if (e.currentTarget.currentTime > 0) {
              resumeTimeRef.current = e.currentTarget.currentTime;
            }
            userOnTimeUpdate?.(e);
          }}
          onLoadedMetadata={(e) => {
            const el = e.currentTarget;
            if (resumeTimeRef.current > 0) {
              try {
                el.currentTime = resumeTimeRef.current;
              } catch {
                // jsdom / unseekable stream
              }
            }
            userOnLoadedMetadata?.(e);
            if (shouldPlayOnLoadRef.current) {
              shouldPlayOnLoadRef.current = false;
              try {
                const p = el.play?.();
                if (p && typeof p.catch === "function") p.catch(() => {});
              } catch {
                // jsdom does not implement HTMLMediaElement.play
              }
            }
          }}
          onEnded={(e: SyntheticEvent<HTMLVideoElement>) => {
            resumeTimeRef.current = 0;
            setResumeHint(false);
            setEndedOnce(true);
            userOnEnded?.(e);
            epochRef.current += 1;
            teardownVideoElement(e.currentTarget);
            releaseInlineVideoSlot(slotIdRef.current);
            shouldPlayOnLoadRef.current = false;
            resignedRef.current = false;
            setActiveUrl(null);
            setPhase("idle");
          }}
          onError={(e: SyntheticEvent<HTMLVideoElement>) => {
            if (needsSign && !resignedRef.current) {
              resignedRef.current = true;
              if (e.currentTarget.currentTime > 0) {
                resumeTimeRef.current = e.currentTarget.currentTime;
                setResumeHint(true);
              }
              const myEpoch = epochRef.current;
              void get({ forceResign: true }).then((fresh) => {
                if (!mountedRef.current || epochRef.current !== myEpoch) return;
                if (!fresh || fresh === activeUrl) {
                  collapseTo("error");
                  return;
                }
                shouldPlayOnLoadRef.current = true;
                setActiveUrl(fresh);
              });
              return;
            }
            userOnError?.(e);
            collapseTo("error");
          }}
        />
      </div>
    );
  }

  const coverTitle =
    phase === "loading"
      ? "正在加载视频…"
      : phase === "error"
        ? "视频加载失败"
        : resumeHint
          ? "继续播放视频"
          : endedOnce
            ? "重新播放视频"
            : "播放视频";

  return (
    <div
      ref={wrapperRef}
      className="my-2 flex w-full max-w-md items-center gap-2 rounded-lg border border-border bg-surface p-2"
    >
      <button
        type="button"
        disabled={phase === "loading"}
        onClick={() => void activate()}
        aria-label={`${coverTitle} ${displayName}`}
        className="flex min-h-[44px] min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-hover disabled:opacity-60"
      >
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-full",
            phase === "error" ? "bg-hover text-danger" : "bg-accent-soft text-accent",
          )}
        >
          {phase === "loading" ? (
            <LoaderCircle size={16} className="animate-spin" />
          ) : phase === "error" ? (
            <RotateCcw size={16} />
          ) : (
            <Play size={16} className="translate-x-[1px]" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block truncate text-sm font-medium",
              phase === "error" ? "text-danger" : "text-fg",
            )}
          >
            {coverTitle}
          </span>
          <span className="block truncate text-xs text-muted">{displayName} · 页内播放</span>
        </span>
      </button>
      {downloadButton}
    </div>
  );
}
