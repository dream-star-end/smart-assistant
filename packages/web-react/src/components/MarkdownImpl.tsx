/**
 * Markdown 渲染重实现（react-markdown + remark-gfm + rehype-highlight + highlight.js）。
 *
 * 本模块是首屏代码分割的「重依赖边界」：被 components/Markdown.tsx 以 React.lazy()
 * 动态加载，故 react-markdown / highlight.js / unified 生态（约 600KB）全部落在按需
 * 异步 chunk，不进首屏 bundle。新增 markdown 重渲染相关依赖请加在本文件，勿回灌到
 * 同步路径。default export 为 React.lazy 约定。
 */
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import { Children, isValidElement, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { isContainerPreviewUrl } from "@openclaude/protocol/containerPreview";
import { PRODUCT_CAPABILITIES } from "../lib/productCapabilities";
import { SignedAudio, SignedFileCard, SignedImg, SignedVideo, ZoomableImage } from "./chat/media";
import { CodeBlock } from "./CodeBlock";
import { OptionsBlock, ChartBlock, HtmlPreview, MermaidBlock } from "./RichBlocks";
import type { MarkdownProps } from "./Markdown";
import { normalizeMathDelimiters } from "./mathDelimiters";

/** 从(可能被 highlight 包成 span 的)code children 递归还原纯源码文本 —— mermaid/html 富块要原文。 */
function nodeText(node: ReactNode): string {
  if (node == null || node === false || node === true) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  const props = (node as { props?: { children?: ReactNode } }).props;
  return props?.children != null ? nodeText(props.children) : "";
}

// ── 媒体/文件内联嵌入（对齐现网 embedMediaUrls）────────────────────────────────
// 技能/工具常把生成或上传的文件写到容器 /home/agent/.openclaude/...，然后在正文里以
// **行内码**或**裸文本**写出绝对路径(如 `/home/agent/.openclaude/generated/x.jpeg` 或
// .../hello.txt)。默认 react-markdown 只当文本渲染 → 用户看到一串路径:图看不到、文件
// 没法下载。这里加 rehype 插件:把路径改写成媒体元素(img/video/audio)或可下载文件卡
// (filecard)，再交给 Signed* 组件经 /api/media-sign 签名(容器路径浏览器才取得到)。
// 两种来源都扫:① 行内 code(更明确,放宽到任意容器路径);② 纯文本(只认 openclaude
// 生成/上传目录 + /api/media,避免句子里普通 "/x" 误判)。
const IMG_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);
const VIDEO_EXT = new Set(["mp4", "webm", "mov", "mkv"]);
const AUDIO_EXT = new Set(["mp3", "wav", "ogg", "m4a", "flac", "aac"]);

type EmbedTag = "img" | "video" | "audio" | "filecard";

/** 候选引用归类。媒体扩展名(容器路径/http/URL)→ 媒体标签;非媒体的容器文件路径 → 文件下载卡;否则 null。 */
function classifyEmbed(raw: string): EmbedTag | null {
  const s = raw.trim();
  if (!s || /\s/.test(s)) return null;
  const isContainerPath = s.startsWith("/") && !s.startsWith("//") && !s.startsWith("/api/");
  const isApiMedia = s.startsWith("/api/media");
  const isUrl = /^https?:\/\//i.test(s);
  const m = /\.([a-z0-9]+)(?:\?.*)?$/i.exec(s);
  if (!m) return null;
  const e = m[1].toLowerCase();
  const media = IMG_EXT.has(e) ? "img" : VIDEO_EXT.has(e) ? "video" : AUDIO_EXT.has(e) ? "audio" : null;
  if (media) return isContainerPath || isApiMedia || isUrl ? media : null;
  // 非媒体:仅容器文件路径(生成/上传)→ 可下载文件卡(http 普通链接不碰,保持普通超链接)。
  return isContainerPath ? "filecard" : null;
}

type HastNode = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

function hastText(node: HastNode): string {
  if (node.type === "text") return node.value || "";
  return (node.children || []).map(hastText).join("");
}

function isInlineCode(node: HastNode): boolean {
  const cls = node.properties?.className;
  const arr = Array.isArray(cls) ? cls : typeof cls === "string" ? [cls] : [];
  return !arr.some((c) => typeof c === "string" && c.startsWith("language-"));
}

function embedEl(tag: EmbedTag, src: string): HastNode {
  if (tag === "filecard")
    return { type: "element", tagName: "filecard", properties: { src, filename: src.split("/").pop() || "" }, children: [] };
  return {
    type: "element",
    tagName: tag,
    properties: tag === "img" ? { src, alt: "" } : { src, controls: true },
    children: [],
  };
}

// 纯文本只认 openclaude 生成/上传目录 + /api/media(收口,避免误判普通 "/path")。
const TEXT_PATH_RE = /(?:\/(?:home\/agent|root)\/\.openclaude|\/api\/media)\/[^\s"'`<>，。、；：）)】」]+\.[A-Za-z0-9]{1,10}/g;

function rehypeEmbedMedia() {
  return (tree: HastNode) => visit(tree);
  function visit(node: HastNode) {
    const kids = node.children;
    if (!Array.isArray(kids)) return;
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i];
      // ① 行内 code(块级 ``` 在 <pre> 里、带 language- class 的不碰)。
      if (child.type === "element" && child.tagName === "code") {
        if (node.tagName !== "pre" && isInlineCode(child)) {
          const tag = classifyEmbed(hastText(child));
          if (tag) kids[i] = embedEl(tag, hastText(child).trim());
        }
        continue;
      }
      // 代码块/已有链接不下钻。
      if (child.type === "element" && (child.tagName === "pre" || child.tagName === "a")) continue;
      // ② 纯文本:扫容器路径并切分插入媒体/文件元素。
      if (child.type === "text" && typeof child.value === "string") {
        const parts = splitText(child.value);
        if (parts) {
          kids.splice(i, 1, ...parts);
          i += parts.length - 1;
        }
        continue;
      }
      if (child.type === "element") visit(child);
    }
  }
  function splitText(value: string): HastNode[] | null {
    TEXT_PATH_RE.lastIndex = 0;
    if (!TEXT_PATH_RE.test(value)) return null;
    TEXT_PATH_RE.lastIndex = 0;
    const out: HastNode[] = [];
    let last = 0;
    let m: RegExpExecArray | null = TEXT_PATH_RE.exec(value);
    while (m !== null) {
      const tag = classifyEmbed(m[0]);
      if (tag) {
        if (m.index > last) out.push({ type: "text", value: value.slice(last, m.index) });
        out.push(embedEl(tag, m[0]));
        last = m.index + m[0].length;
      }
      m = TEXT_PATH_RE.exec(value);
    }
    if (out.length === 0) return null;
    if (last < value.length) out.push({ type: "text", value: value.slice(last) });
    return out;
  }
}

function MarkdownTable({ children, ...props }: ComponentPropsWithoutRef<"table">) {
  const [showHint, setShowHint] = useState(true);
  const dismissHint = () => setShowHint(false);

  return (
    <div className="markdown-table-wrap">
      {showHint && <p className="markdown-table-hint sm:hidden">表格可左右滑动查看更多</p>}
      <section
        aria-label="Markdown 表格，可横向滚动"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: 横向滚动区必须可由键盘聚焦和滚动。
        tabIndex={0}
        className="markdown-table-region"
        onPointerDown={dismissHint}
        onScroll={dismissHint}
        onKeyDown={(event) => {
          if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) dismissHint();
        }}
      >
        <table {...props}>{children}</table>
      </section>
    </div>
  );
}

function hasMarkdownImage(children: ReactNode): boolean {
  return Children.toArray(children).some((child) => {
    if (!isValidElement<{ node?: { tagName?: string }; children?: ReactNode }>(child)) return false;
    return child.props.node?.tagName === "img" || hasMarkdownImage(child.props.children);
  });
}

export default function MarkdownImpl({ children, signMedia, live, readOnly }: MarkdownProps) {
  return (
    <div className="prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          [rehypeHighlight, { detect: true, ignoreMissing: true }],
          // 数学公式：$..$ / $$..$$ → KaTeX 渲染(remarkMath 解析 + rehypeKatex 出 HTML)。
          [rehypeKatex, { strict: false, throwOnError: false }],
          // 仅在 signMedia(助手正文)启用：把媒体路径行内码转成可签名媒体节点。
          ...(signMedia && !readOnly ? [rehypeEmbedMedia] : []),
        ]}
        components={{
          pre: ({ children }) => <>{children}</>,
          table: ({ node: _node, ...props }) => <MarkdownTable {...props} />,
          ...(signMedia
            ? {
                img: ({ node: _node, ...props }) => {
                  const src = typeof props.src === "string" ? props.src : "";
                  if (readOnly && /^(?:https?:)?\/\//i.test(src)) {
                    return (
                      <ZoomableImage
                        src={src}
                        alt={props.alt ?? ""}
                        title={props.title}
                        imgClassName="max-w-full rounded-lg border border-border"
                        referrerPolicy="no-referrer"
                        loading="lazy"
                        readOnly
                      />
                    );
                  }
                  if (readOnly && !src.startsWith("/api/inbox-assets/")) {
                    return <span className="text-faint">[{props.alt || "不支持的图片来源"}]</span>;
                  }
                  return <SignedImg {...props} readOnly={readOnly} />;
                },
                video: ({ node: _node, ...props }) => <SignedVideo {...props} />,
                audio: ({ node: _node, ...props }) => <SignedAudio {...props} />,
                // 自定义 filecard 元素(rehypeEmbedMedia 产出)→ 可下载文件卡。
                filecard: ({ src, filename }: { src?: string; filename?: string }) => (
                  <SignedFileCard src={src} filename={filename} />
                ),
              }
            : {}),
          code({ className, children, ...props }) {
            const lang = /language-(\w+)/.exec(className || "")?.[1];
            const isBlock = className?.includes("language-") || String(children).includes("\n");
            if (isBlock) {
              // 富块:mermaid 流程图 / html 沙盒预览(取原文,绕开 highlight 的 span 包裹)。
              if (lang === "mermaid") return <MermaidBlock code={nodeText(children).replace(/\n$/, "")} />;
              if (lang === "chart") return <ChartBlock code={nodeText(children).replace(/\n$/, "")} />;
              if (lang === "options")
                return <OptionsBlock code={nodeText(children).replace(/\n$/, "")} readOnly={readOnly} />;
              if (!readOnly && (lang === "html" || lang === "htmlpreview"))
                return <HtmlPreview code={nodeText(children).replace(/\n$/, "")} live={live} />;
              return (
                <CodeBlock language={lang}>
                  <span className={className} {...props}>
                    {children}
                  </span>
                </CodeBlock>
              );
            }
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
          a: ({ children, href, ...props }) => {
            const containerLocal = typeof href === "string" && isContainerPreviewUrl(href);
            // 只读站内信中的链接图片把灯箱与原链接拆成两个同级动作，避免格式包装下仍出现
            // <a><button /></a> 非法嵌套和一次点击双重导航，同时不丢原链接功能。
            if (readOnly && hasMarkdownImage(children)) {
              return (
                <span className="inline-flex max-w-full flex-col items-start gap-1">
                  {children}
                  {containerLocal ? (
                    <a
                      {...props}
                      href={href}
                      data-container-local-preview="true"
                      data-product-feature={PRODUCT_CAPABILITIES.containerPreview.id}
                      title="在容器内安全预览"
                      className="text-xs"
                    >
                      打开关联链接 · 容器预览
                    </a>
                  ) : (
                    <a {...props} href={href} target="_blank" rel="noreferrer" className="text-xs">
                      打开关联链接
                    </a>
                  )}
                </span>
              );
            }
            if (containerLocal) {
              return (
                <a
                  {...props}
                  href={href}
                  data-container-local-preview="true"
                  data-product-feature={PRODUCT_CAPABILITIES.containerPreview.id}
                  title="在容器内安全预览"
                >
                  {children}
                  <span className="ml-1 inline-flex rounded-full bg-accent-soft px-1.5 py-0.5 align-middle text-[10px] font-medium text-accent">
                    容器预览
                  </span>
                </a>
              );
            }
            return (
              <a {...props} href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            );
          },
        }}
      >
        {typeof children === "string" ? normalizeMathDelimiters(children) : children}
      </ReactMarkdown>
    </div>
  );
}
