/**
 * Markdown 首屏代码分割边界。
 *
 * 真正的渲染实现（react-markdown + highlight.js + unified 生态，约 600KB）放在
 * ./MarkdownImpl，通过 React.lazy 动态 import 进按需异步 chunk —— 首屏 bundle 不含
 * 这些重库。chunk 未到达前用纯文本占位（保持版式、原文可读、零额外依赖），到达后
 * 静默替换为富文本。组件契约与历史一致（{ children: string; signMedia?: boolean }），
 * 所有调用方（Message / chat/cards / chat/AgentGroupCard）无需改动。
 */
import { Component, lazy, memo, Suspense, type ReactNode, useState } from "react";
import { wrapWithCspOnly } from "./embedCsp";

export type MarkdownProps = {
  children: string;
  /** 富文本里的行内 <img>（含容器路径）经 /api/media-sign 主动签名后渲染（assistant/
   *  tool 正文用）。缺省 false 保持原生 img 行为（demo / 无媒体场景零改动）。 */
  signMedia?: boolean;
  /**
   * 本条消息是否仍在流式生成中。传给重型富块（HTML 沙盒预览）：流式期间正文每个 delta
   * 都会重建 srcDoc → iframe 整帧重载 → 白屏闪烁,且此时 HTML 常是半截。true 时富块只给
   * 稳定占位,生成结束（false）再一次性挂载渲染。缺省 false（历史/静态消息立即渲染）。
   */
  live?: boolean;
  /**
   * 流式光标:在正文**最后一个文本块末尾**内联渲染一枚闪烁光标(rehype 注入,随当前文字色),
   * 「正在输入」的落点与文字同一行;最后一块是代码块/表格等非文本块时回退到块后单独一行。
   * 由调用方按「本条消息正在流式」传入;缺省 false。
   */
  caret?: boolean;
  /** 站内信/后台预览等只读上下文：仅渲染站内资产/外链图，禁 HTML 执行与聊天交互。 */
  readOnly?: boolean;
  /** 完全禁用正文图片加载；用于公开投稿等不可信内容，避免远程像素追踪。 */
  blockImages?: boolean;
  /**
   * 没标语言的代码块是否自动探测语言再高亮（缺省 true，聊天正文行为不变）。
   * 探测是同步跑全部语法的，对几百 KB 的无语言围栏 / 缩进代码块会卡死主线程；
   * 渲染外来文件（项目产出预览）时传 false：无语言的块只按纯文本显示。
   */
  autoDetectCode?: boolean;
  /**
   * 不包 `.prose` 外壳(OCV5-421):流式长回答按顶层块分段渲染时,各段共用调用方的同一个
   * `.prose`,DOM 与整段一次渲染完全一致(react-markdown 本身不加包裹元素)。
   */
  bare?: boolean;
  /**
   * 经验分享正文(OCV5-577):只渲染 `![](tutorial-blob:<sha256>)` 图片,交给调用方决定取图方式
   * (公开 embed / 作者预览的鉴权读取);其它任何图片来源一律不加载。调用方需保持函数引用稳定。
   */
  tutorialImage?: (sha256: string, image: { alt: string; title?: string }) => ReactNode;
};

let markdownImplLoader: Promise<typeof import("./MarkdownImpl")> | null = null;
// chunk 到达后的模块本体。React.lazy 首次渲染必然挂起一次（它只经 .then 得知结果，哪怕
// promise 早已兑现），于是 chunk 已在手时每个 lazy 首帧仍先出纯文本占位、再整块换成富文本
// （OCV5-373）。有了它，之后挂载的 Markdown 直接渲染实现，不再走这一次占位。
let markdownImplModule: typeof import("./MarkdownImpl") | null = null;

/** Kick the lazy chunk as soon as a session mounts, before the first Suspense. */
export function prefetchMarkdownImpl(): Promise<typeof import("./MarkdownImpl")> {
  markdownImplLoader ??= import("./MarkdownImpl").then((mod) => {
    markdownImplModule = mod;
    return mod;
  });
  return markdownImplLoader;
}

const LazyMarkdownImpl = lazy(() => prefetchMarkdownImpl());

type HtmlFenceFallback = {
  before: string;
  code: string;
  after: string;
};

function extractHtmlFenceFallback(source: string): HtmlFenceFallback | null {
  const open = /(^|\r?\n)```(htmlpreview|html)[^\r\n]*(?:\r?\n|$)/i.exec(source);
  if (!open) return null;
  const fenceStart = open.index + open[1].length;
  const codeStart = open.index + open[0].length;
  const rest = source.slice(codeStart);
  const close = /\r?\n```[ \t]*(?:\r?\n|$)/.exec(rest);
  if (!close) {
    return { before: source.slice(0, fenceStart), code: rest, after: "" };
  }
  return {
    before: source.slice(0, fenceStart),
    code: rest.slice(0, close.index),
    after: rest.slice(close.index + close[0].length),
  };
}

function PlainFallbackText({ children }: { children: string }) {
  if (!children) return null;
  return <div className="whitespace-pre-wrap break-words">{children}</div>;
}

function HtmlPreviewFallback({ code, live }: { code: string; live?: boolean }) {
  // 与 HtmlEmbed 同一外观(无标题栏);只用本仓 @theme 里存在的 token。兜底也带 CSP(chunk 加载失败时它就是唯一的预览)。
  return (
    <div className="oc-embed not-prose my-3">
      {live ? (
        <output className="oc-embed-skeleton">
          <span className="oc-embed-skeleton-label">正在生成交互内容…</span>
        </output>
      ) : (
        <iframe
          title="交互内容"
          className="block h-72 w-full rounded-xl border-0 bg-transparent"
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={wrapWithCspOnly(code)}
        />
      )}
      <div className="oc-embed-bar text-meta text-faint">交互内容 · 沙盒运行</div>
    </div>
  );
}

/** 重 chunk 加载中 / 加载失败时的轻量占位；只读站内信绝不执行 HTML 预览脚本。 */
function MarkdownFallback({
  children,
  live,
  readOnly,
  bare,
}: { children: string; live?: boolean; readOnly?: boolean; bare?: boolean }) {
  const html = readOnly ? null : extractHtmlFenceFallback(children);
  const body = html ? (
    <>
      <PlainFallbackText>{html.before}</PlainFallbackText>
      <HtmlPreviewFallback code={html.code} live={live} />
      <PlainFallbackText>{html.after}</PlainFallbackText>
    </>
  ) : (
    <PlainFallbackText>{children}</PlainFallbackText>
  );
  return bare ? body : <div className="prose">{body}</div>;
}

/**
 * 懒加载边界的错误兜底：一刀切 React、无 vanilla 兜底，若 markdown chunk 拉取失败
 * （典型场景=发版后旧客户端持有 stale index.html，请求到已被新哈希取代的旧 chunk → 404），
 * 不能让整棵子树白屏。降级为纯文本占位，正文仍可读。
 */
class MarkdownBoundary extends Component<
  { fallback: ReactNode; children: ReactNode; resetKey: string },
  { failed: boolean; failedKey: string | null }
> {
  state = { failed: false, failedKey: null as string | null };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  // OCV5-421: 流式中某个半截块让渲染抛错时,只降级这一版正文;内容再变(下一个 delta /
  // 生成结束)就重新尝试正常渲染,而不是整条消息永久停在纯文本。
  static getDerivedStateFromProps(
    props: { resetKey: string },
    state: { failed: boolean; failedKey: string | null },
  ) {
    if (!state.failed) return null;
    if (state.failedKey === null) return { failedKey: props.resetKey };
    return state.failedKey === props.resetKey ? null : { failed: false, failedKey: null };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export const Markdown = memo(function Markdown({
  children,
  signMedia,
  live,
  caret,
  readOnly,
  blockImages,
  autoDetectCode,
  bare,
  tutorialImage,
}: MarkdownProps) {
  // 组件类型按实例在挂载时定一次：chunk 到达前挂载的实例（如正在流式的消息）保持 lazy，
  // 不会在 chunk 到达后因类型变化再被整块重挂（HTML 预览 iframe 会因此重载）。
  const [MarkdownImpl] = useState(() => markdownImplModule?.default ?? LazyMarkdownImpl);
  const fallback = <MarkdownFallback live={live} readOnly={readOnly} bare={bare}>{children}</MarkdownFallback>;
  return (
    <MarkdownBoundary fallback={fallback} resetKey={children}>
      <Suspense fallback={fallback}>
        <MarkdownImpl
          signMedia={signMedia}
          live={live}
          caret={caret}
          readOnly={readOnly}
          blockImages={blockImages}
          autoDetectCode={autoDetectCode}
          bare={bare}
          tutorialImage={tutorialImage}
        >
          {children}
        </MarkdownImpl>
      </Suspense>
    </MarkdownBoundary>
  );
});
