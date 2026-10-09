/**
 * Intelligent UI(OCV5-361)—— 组件公共外壳:行内文字、正文 Markdown、外框、页脚(来源 / 说明 /
 * 复制)与骨架。外观克制:1px 边框、圆角、正文字号,只用主题 token(明暗自动)。
 */
import { Check, Copy } from "lucide-react";
import { Fragment, type ReactNode, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../../lib/utils";

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
  // 正文里不加载图片:组件内容来自模型,远程图片可能是追踪像素。
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

export type FrameProps = {
  kind: string;
  title?: string;
  /** 标题行右侧的额外控件(如图表的「数据」切换)。 */
  actions?: ReactNode;
  source?: string;
  note?: string;
  notes?: string[];
  copyText?: () => string;
  streaming?: boolean;
  className?: string;
  children: ReactNode;
  /** 无边框外观(提示框、建议按钮自带外观)。 */
  bare?: boolean;
};

/** 组件外框:可选标题行 + 内容 + 页脚(来源/说明/省略提示 + 复制)。 */
export function Frame({ kind, title, actions, source, note, notes, copyText, streaming, className, children, bare }: FrameProps) {
  const footText = source || note || (notes && notes.length > 0);
  // 有来源/说明时复制放在页脚;否则放到标题行,不为一个图标单独占一条空页脚。
  const copy = copyText && !streaming ? <CopyButton getText={copyText} /> : null;
  const copyInHead = !footText && !!copy;
  const headActions = copyInHead ? (
    <>
      {actions}
      {copy}
    </>
  ) : (
    actions
  );
  return (
    <figure
      className={cn("oc-iui", bare ? "oc-iui-bare" : "oc-iui-card", className)}
      data-iui={kind}
      data-streaming={streaming ? "true" : undefined}
      aria-busy={streaming || undefined}
    >
      {(title || headActions) && (
        <div className="oc-iui-head">
          {title ? (
            <figcaption className="oc-iui-title">
              <Inline text={title} />
            </figcaption>
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

/** 每种组件骨架的最小高度(与最终外形接近,减少出现时的跳动)。 */
const SKELETON_HEIGHT: Record<string, number> = {
  table: 168,
  chart: 280,
  stats: 104,
  steps: 156,
  compare: 220,
  choice: 132,
  calculator: 280,
  callout: 72,
  tabs: 168,
  timeline: 156,
  suggestions: 44,
};

export function Skeleton({ kind }: { kind?: string }) {
  const h = (kind && SKELETON_HEIGHT[kind]) || 96;
  const rows = Math.max(1, Math.round((h - 40) / 28));
  return (
    <div
      className={cn("oc-iui", kind === "suggestions" ? "oc-iui-bare" : "oc-iui-card", "oc-iui-skeleton")}
      style={{ minHeight: h }}
      // biome-ignore lint/a11y/useSemanticElements: 骨架是块级占位,<output> 的行内语义不合适
      role="status"
      aria-live="polite"
      aria-label="内容生成中"
      data-iui-skeleton={kind ?? "unknown"}
    >
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 静态占位条
        <span key={i} className="oc-iui-skeleton-bar" style={{ width: `${88 - ((i * 17) % 40)}%` }} />
      ))}
    </div>
  );
}
