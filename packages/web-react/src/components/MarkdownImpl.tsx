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
import type { ReactNode } from "react";
import { SignedAudio, SignedImg, SignedVideo } from "./chat/media";
import { CodeBlock } from "./CodeBlock";
import { HtmlPreview, MermaidBlock } from "./RichBlocks";
import type { MarkdownProps } from "./Markdown";

/** 从(可能被 highlight 包成 span 的)code children 递归还原纯源码文本 —— mermaid/html 富块要原文。 */
function nodeText(node: ReactNode): string {
  if (node == null || node === false || node === true) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  const props = (node as { props?: { children?: ReactNode } }).props;
  return props?.children != null ? nodeText(props.children) : "";
}

// ── 媒体内联嵌入（对齐现网 embedMediaUrls）──────────────────────────────────
// 技能/工具常把生成或上传的文件写到容器 /home/agent/.openclaude/... 然后在正文里以
// **行内码**或裸路径写出绝对路径(如 `/home/agent/.openclaude/generated/x.jpeg`)。
// 默认 react-markdown 只把它当行内码渲染 → 用户看到一串路径、看不到图。这里加一个
// rehype 插件：把"整段就是一个媒体路径/URL"的行内 code 节点改写成 img/video/audio
// 元素，再交给下方 Signed* 组件经 /api/media-sign 签名渲染(容器路径浏览器才取得到)。
const IMG_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);
const VIDEO_EXT = new Set(["mp4", "webm", "mov", "mkv"]);
const AUDIO_EXT = new Set(["mp3", "wav", "ogg", "m4a", "flac", "aac"]);

/** 整段是单个媒体引用(容器绝对路径或 http(s) URL)→ 返回对应媒体标签；否则 null。 */
function embedTag(raw: string): "img" | "video" | "audio" | null {
  const s = raw.trim();
  if (!s || /\s/.test(s)) return null; // 必须是单一引用，含空格的句子不碰
  const isPath = s.startsWith("/") && !s.startsWith("//");
  const isUrl = /^https?:\/\//i.test(s);
  if (!isPath && !isUrl) return null;
  const m = /\.([a-z0-9]+)(?:\?.*)?$/i.exec(s);
  if (!m) return null;
  const e = m[1].toLowerCase();
  if (IMG_EXT.has(e)) return "img";
  if (VIDEO_EXT.has(e)) return "video";
  if (AUDIO_EXT.has(e)) return "audio";
  return null;
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

function rehypeEmbedMedia() {
  return (tree: HastNode) => visit(tree);
  function visit(node: HastNode) {
    const kids = node.children;
    if (!Array.isArray(kids)) return;
    for (const child of kids) {
      if (child.type === "element" && child.tagName === "code") {
        // 块级代码(```)在 <pre> 里、或带 language- class → 不碰；只看行内 code。
        if (node.tagName !== "pre" && isInlineCode(child)) {
          const tag = embedTag(hastText(child));
          if (tag) {
            child.tagName = tag;
            child.properties =
              tag === "img"
                ? { src: hastText(child).trim(), alt: "" }
                : { src: hastText(child).trim(), controls: true };
            child.children = [];
          }
        }
        continue; // 不下钻 code
      }
      if (child.type === "element" && child.tagName === "pre") continue; // 跳过代码块
      if (child.type === "element") visit(child);
    }
  }
}

export default function MarkdownImpl({ children, signMedia }: MarkdownProps) {
  return (
    <div className="prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          [rehypeHighlight, { detect: true, ignoreMissing: true }],
          // 数学公式：$..$ / $$..$$ → KaTeX 渲染(remarkMath 解析 + rehypeKatex 出 HTML)。
          [rehypeKatex, { strict: false, throwOnError: false }],
          // 仅在 signMedia(助手正文)启用：把媒体路径行内码转成可签名媒体节点。
          ...(signMedia ? [rehypeEmbedMedia] : []),
        ]}
        components={{
          pre: ({ children }) => <>{children}</>,
          ...(signMedia
            ? {
                img: ({ node: _node, ...props }) => <SignedImg {...props} />,
                video: ({ node: _node, ...props }) => <SignedVideo {...props} />,
                audio: ({ node: _node, ...props }) => <SignedAudio {...props} />,
              }
            : {}),
          code({ className, children, ...props }) {
            const lang = /language-(\w+)/.exec(className || "")?.[1];
            const isBlock = className?.includes("language-") || String(children).includes("\n");
            if (isBlock) {
              // 富块:mermaid 流程图 / html 沙盒预览(取原文,绕开 highlight 的 span 包裹)。
              if (lang === "mermaid") return <MermaidBlock code={nodeText(children).replace(/\n$/, "")} />;
              if (lang === "html" || lang === "htmlpreview")
                return <HtmlPreview code={nodeText(children).replace(/\n$/, "")} />;
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
          a: ({ children, ...props }) => (
            <a target="_blank" rel="noreferrer" {...props}>
              {children}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
