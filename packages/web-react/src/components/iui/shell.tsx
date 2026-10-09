/**
 * Intelligent UI(OCV5-361)—— 组件公共外壳:行内文字、正文 Markdown、外框(类型徽章 + 标题 + 副标题 +
 * 操作 + 页脚)、图片、图标、数字过渡、分段控件与骨架。
 *
 * 第二轮视觉:无灰框的浮起卡片(极淡描边 + 柔和阴影 + 圆角 16),标题区带类型徽章,关键数字大号并有过渡,
 * 分段控件是带滑块的轨道。所有颜色走主题 token(明暗自动),动效在「减弱动效」下关闭。
 */
import { Check, Copy, Icon, ImageOff } from "lucide-react";
import {
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../../lib/utils";
import { useSignedSrc } from "../chat/media";
import { iconFor, kindIcon } from "./icons";

const INLINE_RE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;

/** 短字段用的轻量行内 Markdown:只认 **粗体**、`代码`、[链接](https://…);其余按纯文本。 */
export function Inline({ text }: { text: string }) {
  const parts = text.split(INLINE_RE);
  return (
    <>
      {parts.map((p, i) => {
        if (!p) return null;
        const key = `${i}:${p.length}`;
        if (p.startsWith("**") && p.endsWith("**") && p.length > 4) return <strong key={key}>{p.slice(2, -2)}</strong>;
        if (p.startsWith("`") && p.endsWith("`") && p.length > 2) return <code key={key}>{p.slice(1, -1)}</code>;
        const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(p);
        if (link)
          return (
            <a key={key} href={link[2]} target="_blank" rel="noreferrer">
              {link[1]}
            </a>
          );
        return <Fragment key={key}>{p}</Fragment>;
      })}
    </>
  );
}

const BODY_COMPONENTS = {
  a: ({ href, children }: { href?: string; children?: ReactNode }) =>
    typeof href === "string" && /^https?:\/\//i.test(href) ? (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  // 正文 Markdown 里不加载图片;要放图用 cards / gallery(只认 https 与容器文件,且不带来源页信息)。
  img: ({ alt }: { alt?: string }) => <span className="text-faint">[{alt || "图片"}]</span>,
};

/** 较长的正文(提示框、分段标签内容):完整 GFM,无原始 HTML,无图片。 */
export function BodyMarkdown({ text }: { text: string }) {
  return (
    <div className="oc-iui-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={BODY_COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

// ── 图标 ──────────────────────────────────────────────────────────────

/** 图标或首字(模型写了未知图标名 / 没写图标时)。 */
export function Glyph({ icon, fallback, size = 18 }: { icon?: string; fallback: string; size?: number }) {
  const node = iconFor(icon);
  if (node) return <Icon iconNode={node} size={size} strokeWidth={1.75} aria-hidden />;
  const ch = Array.from(fallback.trim())[0] ?? "·";
  return (
    <span className="oc-iui-glyph-char" aria-hidden>
      {ch}
    </span>
  );
}

// ── 图片 ──────────────────────────────────────────────────────────────

/**
 * 组件里的图片:https 外链或容器文件(走与正文图片相同的签名管线)。外链不带来源页信息、懒加载;
 * 签不到 / 加载失败显示带图标的色块,不留破图。
 */
export function Media({
  src,
  alt,
  className,
  icon,
  fallbackText,
}: {
  src?: string;
  alt: string;
  className?: string;
  icon?: string;
  fallbackText?: string;
}) {
  const { url, onError } = useSignedSrc(src ?? null);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const errorsRef = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: src 变了就重置加载状态,src 只作触发条件
  useEffect(() => {
    setFailed(false);
    setLoaded(false);
    errorsRef.current = 0;
  }, [src]);
  if (!src || failed) {
    return (
      <span className={cn("oc-iui-media oc-iui-media-fallback", className)} role={src ? "img" : undefined} aria-label={src ? `${alt}(图片无法加载)` : undefined}>
        {src && !icon ? <ImageOff size={18} aria-hidden /> : <Glyph icon={icon} fallback={fallbackText ?? alt} size={22} />}
      </span>
    );
  }
  return (
    <span className={cn("oc-iui-media", !loaded && "is-loading", className)}>
      {url && (
        <img
          src={url}
          alt={alt}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onLoad={() => setLoaded(true)}
          onError={() => {
            // 容器文件的签名过期:先重签一次;再失败(或外链失败)就换成色块。
            errorsRef.current += 1;
            if (src.startsWith("/") && errorsRef.current === 1) onError();
            else setFailed(true);
          }}
        />
      )}
    </span>
  );
}

// ── 复制 ──────────────────────────────────────────────────────────────

export function CopyButton({ getText, label = "复制" }: { getText: () => string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="oc-iui-icon-btn"
      aria-label={done ? "已复制" : `${label}(Markdown)`}
      title={done ? "已复制" : `${label}为 Markdown`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(getText());
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* 剪贴板不可用(非安全上下文):静默 */
        }
      }}
    >
      {done ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
    </button>
  );
}

// ── 外框 ──────────────────────────────────────────────────────────────

export type FrameProps = {
  kind: string;
  title?: string;
  subtitle?: string;
  /** 标题行右侧的额外控件(如图表的「数据」切换)。 */
  actions?: ReactNode;
  source?: string;
  note?: string;
  notes?: string[];
  copyText?: () => string;
  streaming?: boolean;
  className?: string;
  children: ReactNode;
  /** 无卡片外观(提示框、建议按钮、对比卡自带外观)。 */
  bare?: boolean;
  /** 嵌在分段标签里:不再画外层卡片和类型徽章。 */
  nested?: boolean;
};

/** 组件外框:可选标题区(类型徽章 + 标题 + 副标题 + 操作)+ 内容 + 页脚(来源/说明/省略提示 + 复制)。 */
export function Frame({ kind, title, subtitle, actions, source, note, notes, copyText, streaming, className, children, bare, nested }: FrameProps) {
  const footText = source || note || (notes && notes.length > 0);
  // 有来源/说明时复制放在页脚;否则放到标题行,不为一个图标单独占一条空页脚。
  // 没有标题也没有页脚时不单独放复制按钮(不为一个图标占一行;整条消息的复制仍会带上它的 Markdown)。
  const copy = copyText && !streaming && !nested && (title || footText) ? <CopyButton getText={copyText} /> : null;
  const copyInHead = !footText && !!copy;
  const headActions = copyInHead ? (
    <>
      {actions}
      {copy}
    </>
  ) : (
    actions
  );
  const kindNode = kindIcon(kind);
  const showHead = !!(title || subtitle || headActions);
  return (
    <figure
      className={cn("oc-iui", nested ? "oc-iui-nested" : bare ? "oc-iui-bare" : "oc-iui-card", className)}
      data-iui={kind}
      data-streaming={streaming ? "true" : undefined}
      aria-busy={streaming || undefined}
    >
      {showHead && (
        <div className={cn("oc-iui-head", !title && !subtitle && "is-actions-only")}>
          {title || subtitle ? (
            <div className="oc-iui-head-main">
              {kindNode && title && !bare && !nested && (
                <span className="oc-iui-kind" aria-hidden>
                  <Icon iconNode={kindNode} size={14} strokeWidth={2} />
                </span>
              )}
              <div className="min-w-0">
                {title && (
                  <figcaption className="oc-iui-title">
                    <Inline text={title} />
                  </figcaption>
                )}
                {subtitle && (
                  <p className="oc-iui-subtitle">
                    <Inline text={subtitle} />
                  </p>
                )}
              </div>
            </div>
          ) : (
            <span />
          )}
          {headActions && <div className="oc-iui-actions">{headActions}</div>}
        </div>
      )}
      {children}
      {footText && (
        <div className="oc-iui-foot">
          <div className="oc-iui-foot-text">
            {note && (
              <p>
                <Inline text={note} />
              </p>
            )}
            {source && (
              <p>
                来源:<Inline text={source} />
              </p>
            )}
            {notes && notes.length > 0 && <p>部分内容已省略({notes.join(";")})</p>}
          </div>
          {copy}
        </div>
      )}
    </figure>
  );
}

// ── 数字过渡 ──────────────────────────────────────────────────────────

function reducedMotion(): boolean {
  try {
    return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  } catch {
    return false;
  }
}

/** 数值变化时 240ms 缓动到新值(减弱动效 / 非数字时直接跳)。首帧就是目标值,不从 0 滚上来。 */
export function useTweenedNumber(target: number | null): number | null {
  const [shown, setShown] = useState(target);
  const fromRef = useRef(target);
  useEffect(() => {
    const from = fromRef.current;
    if (target === null || from === null || from === target || reducedMotion() || typeof requestAnimationFrame === "undefined") {
      fromRef.current = target;
      setShown(target);
      return;
    }
    // 起点取第一帧的时间戳(rAF 时间戳与 performance.now 不保证同一时钟),进度夹在 0–1。
    let t0: number | null = null;
    let raf = 0;
    const tick = (now: number) => {
      if (t0 === null) t0 = now;
      const k = Math.max(0, Math.min(1, (now - t0) / 240));
      const e = 1 - (1 - k) ** 3;
      const v = from + (target - from) * e;
      fromRef.current = v;
      setShown(k >= 1 ? target : v);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return shown;
}

// ── 分段控件(滑块轨道) ──────────────────────────────────────────────

/**
 * 灰色轨道 + 滑动白色滑块。`role` 为 tablist 时按 WAI-ARIA tabs 键盘约定;radiogroup 时按单选组。
 * 滑块位置由按钮实测宽度决定,字长不同也对得齐。
 */
export function Segmented({
  items,
  value,
  onChange,
  label,
  role = "tablist",
  idBase,
  panelIdFor,
  className,
}: {
  items: string[];
  value: number;
  onChange: (i: number) => void;
  label: string;
  role?: "tablist" | "radiogroup";
  idBase?: string;
  /** 每个标签控制的面板 id(tablist 用)。 */
  panelIdFor?: (i: number) => string;
  className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const trackRef = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);
  const fallbackId = useId();
  const base = idBase ?? fallbackId;
  const n = items.length;

  // biome-ignore lint/correctness/useExhaustiveDependencies: items 变化(标签文字变长)要重新量滑块位置
  useLayoutEffect(() => {
    const measure = () => {
      const el = refs.current[value];
      if (!el) return;
      setThumb({ x: el.offsetLeft, w: el.offsetWidth });
    };
    measure();
    if (typeof ResizeObserver === "undefined" || !trackRef.current) return;
    const ro = new ResizeObserver(measure);
    ro.observe(trackRef.current);
    return () => ro.disconnect();
  }, [value, items]);

  useEffect(() => {
    // 选中项滚到可见(窄屏横向滚动时)。
    refs.current[value]?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [value]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (value + 1) % n;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (value - 1 + n) % n;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    if (next === null) return;
    e.preventDefault();
    onChange(next);
    refs.current[next]?.focus();
  };

  const isTabs = role === "tablist";
  return (
    <div ref={trackRef} role={role} aria-label={label} className={cn("oc-iui-seg", className)} onKeyDown={onKey}>
      {thumb && <span className="oc-iui-seg-thumb" style={{ transform: `translateX(${thumb.x}px)`, width: thumb.w }} aria-hidden />}
      {items.map((t, i) => (
        <button
          key={`${i}:${t}`}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role={isTabs ? "tab" : "radio"}
          id={`${base}-t${i}`}
          aria-selected={isTabs ? i === value : undefined}
          aria-checked={isTabs ? undefined : i === value}
          aria-controls={isTabs ? panelIdFor?.(i) : undefined}
          tabIndex={i === value ? 0 : -1}
          className="oc-iui-seg-btn"
          data-active={i === value || undefined}
          onClick={() => onChange(i)}
        >
          {t}
        </button>
      ))}
    </div>
  );
}

// ── 骨架 ──────────────────────────────────────────────────────────────

/** 每种组件骨架的最小高度(与最终外形接近,减少出现时的跳动)。 */
const SKELETON_HEIGHT: Record<string, number> = {
  table: 180,
  chart: 300,
  stats: 120,
  steps: 170,
  compare: 240,
  choice: 132,
  calculator: 320,
  callout: 76,
  tabs: 200,
  timeline: 170,
  suggestions: 44,
  cards: 220,
  gallery: 240,
  swatches: 120,
  tiles: 220,
  recipe: 300,
  quiz: 220,
  progress: 160,
  kv: 160,
  form: 240,
  route: 240,
};

export function Skeleton({ kind }: { kind?: string }) {
  const h = (kind && SKELETON_HEIGHT[kind]) || 96;
  const rows = Math.max(1, Math.round((h - 56) / 30));
  const bare = kind === "suggestions";
  return (
    <div
      className={cn("oc-iui", bare ? "oc-iui-bare" : "oc-iui-card", "oc-iui-skeleton")}
      style={{ minHeight: h }}
      // biome-ignore lint/a11y/useSemanticElements: 骨架是块级占位,<output> 的行内语义不合适
      role="status"
      aria-live="polite"
      aria-label="内容生成中"
      data-iui-skeleton={kind ?? "unknown"}
    >
      {!bare && (
        <span className="oc-iui-skeleton-head" aria-hidden>
          <span className="oc-iui-skeleton-dot" />
          <span className="oc-iui-skeleton-bar" style={{ width: "38%" }} />
        </span>
      )}
      {Array.from({ length: bare ? 3 : rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 静态占位条
        <span key={i} className="oc-iui-skeleton-bar" style={{ width: bare ? undefined : `${92 - ((i * 17) % 40)}%` }} />
      ))}
    </div>
  );
}
