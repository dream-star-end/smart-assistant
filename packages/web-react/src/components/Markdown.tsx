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
};

const MarkdownImpl = lazy(() => import("./MarkdownImpl"));

/** 重 chunk 加载中 / 加载失败时的轻量占位：纯文本（pre-wrap 保留换行），无任何重依赖。 */
function MarkdownFallback({ children }: { children: string }) {
  return (
    <div className="prose">
      <div className="whitespace-pre-wrap break-words">{children}</div>
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

export const Markdown = memo(function Markdown({ children, signMedia }: MarkdownProps) {
  const fallback = <MarkdownFallback>{children}</MarkdownFallback>;
  return (
    <MarkdownBoundary fallback={fallback}>
      <Suspense fallback={fallback}>
        <MarkdownImpl signMedia={signMedia}>{children}</MarkdownImpl>
      </Suspense>
    </MarkdownBoundary>
  );
});
