/**
 * htmlpreview 无缝嵌入(OCV5-361 G361f)。模型写的单文件 HTML 直接长在回答里:没有标题栏、
 * 高度随内容、跟随明暗主题;操作(源码 / 下载 / 全屏)收在下方一行,桌面悬停时出现,触屏常显。
 *
 * 安全边界不变:iframe 只有 `sandbox="allow-scripts"`(不同源)。注入内容见 ./embedDoc.ts。
 * 父页只接受来自本 iframe、且带本次挂载 token 的消息;iframe 被导航到别的页面时停止运行。
 */
import * as Dialog from "@radix-ui/react-dialog";
import { Code2, Download, Eye, Maximize2, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SignedFileCard, useMediaSigner, useSignedSrc } from "./chat/media";
import {
  EMBED_FILE_MAX_BYTES,
  embedFileName,
  isBridgeablePath,
  isHeavyEmbed,
  looksComplete,
  readThemeVars,
  usesFileBridge,
  wrapEmbedHtml,
} from "./embedDoc";

const MIN_H = 120;
const DEFAULT_H = 360;
/** 流式中片段停止变化多久后当作写完(没有 </html> 收尾的片段)。 */
const SETTLE_MS = 1500;
/** 生成目录里的 .html 文件:超过这个大小只给下载卡。 */
export const HTML_FILE_MAX_BYTES = 2 * 1024 * 1024;

function maxHeight(): number {
  return Math.max(320, Math.min(Math.round((window.innerHeight || 900) * 0.8), 900));
}

function useIsDarkNow(): boolean {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    const mo = new MutationObserver(() => setDark(document.documentElement.classList.contains("dark")));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);
  return dark;
}

function newToken(): string {
  const a = new Uint8Array(12);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(a);
  else for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 进入视口附近才挂载(长会话里很多嵌入不会一打开就全部跑起来);挂载后不再卸载。
 * 曾试过滚远后卸载带 WebGL 的嵌入,但视口被临时改写时(整页截图、打印)观察器会误报离开视口,
 * 把正在看的内容清空 —— 不值得。WebGL 上下文过多时浏览器会回收最早的,用户点「重新运行」即可。
 */
function useNearViewport(): [React.RefObject<HTMLSpanElement | null>, boolean] {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const el = ref.current;
    if (near || !el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      },
      { rootMargin: "600px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [near]);
  return [ref, near];
}

/** 内容指纹(只用来决定要不要换新 iframe)。 */
function hashText(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function triggerDownload(href: string, name: string) {
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

const actionBtn =
  "inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-faint outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11 [@media(hover:none)]:min-w-11 [@media(hover:none)]:justify-center";

export function HtmlPreview({ code, live, fileSrc }: { code: string; live?: boolean; fileSrc?: string }) {
  const [view, setView] = useState<"preview" | "source">("preview");
  const [full, setFull] = useState(false);
  const [committed, setCommitted] = useState<string | null>(() => (!live || looksComplete(code) ? code : null));
  const [height, setHeight] = useState(DEFAULT_H);
  const [blocked, setBlocked] = useState(false);
  const [run, setRun] = useState(0);
  const [active, setActive] = useState(false);
  const token = useMemo(() => newToken(), []);
  const dark = useIsDarkNow();
  const darkRef = useRef(dark);
  darkRef.current = dark;
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const fullRef = useRef<HTMLIFrameElement | null>(null);
  const loads = useRef(0);
  const fullLoads = useRef(0);
  const { resolve, invalidate } = useMediaSigner();

  // 写完才挂载,之后不随流式逐段重载(旧实现每 800ms 整帧重载,白屏闪)。
  useEffect(() => {
    if (!live || looksComplete(code)) {
      setCommitted((prev) => (prev === code ? prev : code));
      return;
    }
    if (!code.trim()) return;
    const t = window.setTimeout(() => setCommitted((prev) => prev ?? code), SETTLE_MS);
    return () => window.clearTimeout(t);
  }, [code, live]);

  const heavy = isHeavyEmbed(committed ?? code);
  const bridge = usesFileBridge(committed ?? "");
  const [hostRef, near] = useNearViewport();
  const coarse = typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches;

  // 主题变化走 postMessage,不重建 srcDoc(重建 = 重载 = 交互状态丢失)。
  const srcDoc = useMemo(
    () => (committed === null ? "" : wrapEmbedHtml(committed, { token, dark: darkRef.current, vars: readThemeVars() })),
    [committed, token],
  );
  // 换内容 / 重新运行 / 滚回视口都换一个新 iframe(key 变),load 计数随新元素从零开始。
  const frameKey = `${run}-${hashText(srcDoc)}`;

  const postTheme = useCallback(
    (win: Window | null | undefined, isDark: boolean) => {
      win?.postMessage({ oc: "host", token, type: "theme", dark: isDark, vars: readThemeVars() }, "*");
    },
    [token],
  );
  useEffect(() => {
    postTheme(frameRef.current?.contentWindow, dark);
    postTheme(fullRef.current?.contentWindow, dark);
  }, [dark, postTheme]);

  useEffect(() => {
    const onMessage = async (e: MessageEvent) => {
      const wins = [frameRef.current?.contentWindow, fullRef.current?.contentWindow].filter(Boolean);
      if (!e.source || !wins.includes(e.source as Window)) return;
      const m = e.data as { oc?: string; token?: string; type?: string; h?: number; id?: number; path?: unknown; name?: unknown };
      if (!m || m.oc !== "embed" || m.token !== token) return;
      const from = e.source as Window;
      if (m.type === "ready") postTheme(from, darkRef.current);
      else if (m.type === "size" && from === frameRef.current?.contentWindow && typeof m.h === "number" && Number.isFinite(m.h)) {
        setHeight(Math.max(MIN_H, Math.min(Math.ceil(m.h), maxHeight())));
      } else if (m.type === "file" && bridge && typeof m.id === "number") {
        const reply = (msg: Record<string, unknown>, transfer?: Transferable[]) =>
          from.postMessage({ oc: "host", token, type: "file", id: m.id, ...msg }, "*", transfer ?? []);
        if (!isBridgeablePath(m.path)) return reply({ ok: false, error: "只能读取生成目录里的文件" });
        try {
          let url = await resolve(m.path);
          let res = url ? await fetch(url) : null;
          if (res && (res.status === 403 || res.status === 410)) {
            invalidate(m.path);
            url = await resolve(m.path);
            res = url ? await fetch(url) : null;
          }
          if (!res?.ok) return reply({ ok: false, error: "文件不可用" });
          const len = Number(res.headers.get("content-length") || 0);
          if (len > EMBED_FILE_MAX_BYTES) return reply({ ok: false, error: "文件太大,请下载后查看" });
          const buf = await res.arrayBuffer();
          if (buf.byteLength > EMBED_FILE_MAX_BYTES) return reply({ ok: false, error: "文件太大,请下载后查看" });
          reply({ ok: true, buf, mime: res.headers.get("content-type") || "" }, [buf]);
        } catch {
          reply({ ok: false, error: "文件不可用" });
        }
      } else if (m.type === "download" && bridge && isBridgeablePath(m.path)) {
        const url = await resolve(m.path);
        const name = (typeof m.name === "string" && m.name.trim()) || m.path.split("/").pop() || "file";
        if (url) triggerDownload(url, name);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [token, bridge, resolve, invalidate, postTheme]);

  // 同一个 iframe 元素第二次 load = 被导航到了别处(换内容时 key 变,是新元素)。
  const setFrame = useCallback((el: HTMLIFrameElement | null) => {
    frameRef.current = el;
    loads.current = 0;
  }, []);
  const onLoad = () => {
    loads.current += 1;
    if (loads.current > 1) setBlocked(true);
  };
  useEffect(() => {
    if (full) fullLoads.current = 0;
  }, [full]);
  const onFullLoad = () => {
    fullLoads.current += 1;
    if (fullLoads.current > 1) {
      setFull(false);
      setBlocked(true);
    }
  };

  const downloadHtml = () => {
    const url = URL.createObjectURL(new Blob([committed ?? code], { type: "text/html;charset=utf-8" }));
    triggerDownload(url, fileSrc?.split("/").pop() || embedFileName(committed ?? code));
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  const rerun = () => {
    setBlocked(false);
    setRun((n) => n + 1);
  };

  const pending = committed === null;
  const showFrame = view === "preview" && !pending && !blocked;
  const kb = Math.max(1, Math.round(new TextEncoder().encode(code).length / 1024));

  return (
    <span ref={hostRef} className="oc-embed not-prose group/embed my-3 block">
      {view === "source" ? (
        <span className="block max-h-96 overflow-auto whitespace-pre rounded-xl bg-code px-3 py-2 font-mono text-xs text-fg">
          {code}
        </span>
      ) : pending ? (
        <output className="oc-embed-skeleton block" aria-live="polite">
          <span className="oc-embed-skeleton-label">正在生成交互内容… {kb} KB</span>
        </output>
      ) : blocked ? (
        <output className="oc-embed-blocked block">
          这段交互内容尝试打开其它页面,已停止运行。
          <button type="button" onClick={rerun} className={actionBtn}>
            <RotateCcw size={13} /> 重新运行
          </button>
        </output>
      ) : (
        <span className="oc-embed-frame block" style={{ height }}>
          {near && showFrame ? (
            <iframe
              key={frameKey}
              ref={setFrame}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              srcDoc={srcDoc}
              title="交互内容"
              onLoad={onLoad}
              className="block h-full w-full border-0 bg-transparent"
            />
          ) : null}
          {coarse && heavy && !active && near ? (
            <button type="button" className="oc-embed-touch" onClick={() => setActive(true)}>
              点按开始操作
            </button>
          ) : null}
        </span>
      )}
      <span className="oc-embed-bar flex items-center justify-between gap-2 text-meta">
        <span className="text-faint">交互内容 · 沙盒运行</span>
        <span className="oc-embed-actions flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => setView((v) => (v === "preview" ? "source" : "preview"))}
            className={actionBtn}
            aria-label={view === "preview" ? "看源码" : "看预览"}
          >
            {view === "preview" ? <Code2 size={13} /> : <Eye size={13} />}
            <span className="hidden sm:inline">{view === "preview" ? "看源码" : "预览"}</span>
          </button>
          {!pending ? (
            <button type="button" onClick={downloadHtml} className={actionBtn} aria-label="下载 HTML 文件" title="下载 HTML 文件">
              <Download size={13} />
            </button>
          ) : null}
          {!pending && !blocked ? (
            <button type="button" onClick={rerun} className={actionBtn} aria-label="重新运行" title="重新运行">
              <RotateCcw size={13} />
            </button>
          ) : null}
          {showFrame ? (
            <button type="button" onClick={() => setFull(true)} className={actionBtn} aria-label="全屏放大预览" title="全屏放大">
              <Maximize2 size={13} />
            </button>
          ) : null}
        </span>
      </span>
      <Dialog.Root open={full} onOpenChange={setFull}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[60] bg-bg/80 backdrop-blur-sm animate-in" />
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed inset-2 z-[61] flex flex-col overflow-hidden rounded-2xl border border-border bg-bg shadow-2xl outline-none sm:inset-6"
          >
            <Dialog.Title className="sr-only">交互内容全屏</Dialog.Title>
            <iframe
              ref={fullRef}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              srcDoc={srcDoc}
              title="交互内容(全屏)"
              onLoad={onFullLoad}
              className="min-h-0 w-full flex-1 border-0 bg-transparent"
            />
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="关闭全屏"
                className="absolute right-3 top-3 flex size-9 items-center justify-center rounded-full border border-border bg-surface/90 text-muted shadow-sm outline-none backdrop-blur hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X size={16} />
              </button>
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </span>
  );
}

/** 页面里引用了相对路径资源(./app.js、img/a.png)的 HTML 文件,单独嵌进来会缺东西 —— 只给下载卡。 */
export function isSelfContainedHtml(text: string): boolean {
  return !/\s(?:src|href)\s*=\s*["'](?!https?:|data:|blob:|#|mailto:|tel:|javascript:)[^"']+["']/i.test(
    text.replace(/<a\s[^>]*>/gi, ""),
  );
}

/** 回答里写出的生成目录 .html 文件:自包含的直接嵌入,下面保留下载卡。 */
export function HtmlFileEmbed({ src, filename }: { src: string; filename?: string }) {
  const { url } = useSignedSrc(src);
  const [code, setCode] = useState<string | null>(null);
  useEffect(() => {
    if (!url) return;
    const ac = new AbortController();
    void (async () => {
      try {
        const res = await fetch(url, { signal: ac.signal });
        if (!res.ok) return;
        if (Number(res.headers.get("content-length") || 0) > HTML_FILE_MAX_BYTES) return;
        const text = await res.text();
        if (text.length <= HTML_FILE_MAX_BYTES && isSelfContainedHtml(text)) setCode(text);
      } catch {
        /* 取不到就只显示下载卡 */
      }
    })();
    return () => ac.abort();
  }, [url]);
  return (
    <span className="block">
      {code !== null ? <HtmlPreview code={code} fileSrc={src} /> : null}
      <SignedFileCard src={src} filename={filename} />
    </span>
  );
}
