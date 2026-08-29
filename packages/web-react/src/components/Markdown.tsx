/**
 * Markdown 首屏代码分割边界。
 *
 * 真正的渲染实现（react-markdown + highlight.js + unified 生态，约 600KB）放在
 * ./MarkdownImpl，通过 React.lazy 动态 import 进按需异步 chunk —— 首屏 bundle 不含
 * 这些重库。chunk 未到达前用纯文本占位（保持版式、原文可读、零额外依赖），到达后
 * 静默替换为富文本。组件契约与历史一致（{ children: string; signMedia?: boolean }），
 * 所有调用方（Message / chat/cards / chat/AgentGroupCard）无需改动。
 */
import { Component, lazy, memo, Suspense, type ReactNode } from "react";

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
  /** 站内信/后台预览等只读上下文：仅渲染站内资产/外链图，禁 HTML 执行与聊天交互。 */
  readOnly?: boolean;
  /** 完全禁用正文图片加载；用于公开投稿等不可信内容，避免远程像素追踪。 */
  blockImages?: boolean;
};

const MarkdownImpl = lazy(() => import("./MarkdownImpl"));

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
  return (
    <div className="not-prose my-3 overflow-hidden rounded-lg border border-border bg-background shadow-sm">
      <div className="border-b border-border bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
        HTML {live ? "预览(生成中)" : "预览"}
      </div>
      {live ? (
        <div className="flex h-28 items-center justify-center bg-surface px-3 text-xs text-muted">
          生成完成后显示 HTML 预览
        </div>
      ) : (
        <iframe
          title="HTML 沙盒预览"
          className="h-72 w-full bg-white"
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={code}
        />
      )}
    </div>
  );
}

/** 重 chunk 加载中 / 加载失败时的轻量占位；只读站内信绝不执行 HTML 预览脚本。 */
function MarkdownFallback({
  children,
  live,
  readOnly,
}: { children: string; live?: boolean; readOnly?: boolean }) {
  const html = readOnly ? null : extractHtmlFenceFallback(children);
  if (html) {
    return (
      <div className="prose">
        <PlainFallbackText>{html.before}</PlainFallbackText>
        <HtmlPreviewFallback code={html.code} live={live} />
        <PlainFallbackText>{html.after}</PlainFallbackText>
      </div>
    );
  }
  return (
    <div className="prose">
      <PlainFallbackText>{children}</PlainFallbackText>
    </div>
  );
}

/**
 * 懒加载边界的错误兜底：一刀切 React、无 vanilla 兜底，若 markdown chunk 拉取失败
 * （典型场景=发版后旧客户端持有 stale index.html，请求到已被新哈希取代的旧 chunk → 404），
 * 不能让整棵子树白屏。降级为纯文本占位，正文仍可读。
 */
class MarkdownBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export const Markdown = memo(function Markdown({
  children,
  signMedia,
  live,
  readOnly,
  blockImages,
}: MarkdownProps) {
  const fallback = <MarkdownFallback live={live} readOnly={readOnly}>{children}</MarkdownFallback>;
  return (
    <MarkdownBoundary fallback={fallback}>
      <Suspense fallback={fallback}>
        <MarkdownImpl
          signMedia={signMedia}
          live={live}
          readOnly={readOnly}
          blockImages={blockImages}
        >
          {children}
        </MarkdownImpl>
      </Suspense>
    </MarkdownBoundary>
  );
});
