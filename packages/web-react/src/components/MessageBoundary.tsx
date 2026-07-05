/**
 * per-message 错误边界。
 *
 * web-react 此前唯一的 boundary 是 Markdown 的 lazy-chunk 兜底,消息树裸挂——任何一条
 * 消息/工具卡渲染抛异常都会让 React 卸载整棵树(整页白屏)。工具卡归一化引入了大量
 * 解析面,这里给**每条消息**包一层:坏消息降级为一行紧凑占位,相邻消息不受影响。
 *
 * 自愈:componentDidCatch 记录出错时刻的渲染签名(sig),之后签名变化(新数据到达,
 * 常见于流式坏中间态被补全)时自动重试子树;签名不变(真正的坏数据)则维持占位,
 * 不反复抛错刷屏。
 *
 * 放置层级:MessageList 的 map 循环里、MessageRenderer(memo)的**外层**——boundary
 * 每帧重渲只是透传 children 元素,memo 的 sig 比较仍在 MessageRenderer 上生效,不破坏
 * 既有防闪/性能结构。
 */
import { AlertTriangle } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { messageId: string; sig: string; children: ReactNode };
type State = { failed: boolean; failedSig: string | null };

export class MessageBoundary extends Component<Props, State> {
  state: State = { failed: false, failedSig: null };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    // 出错后内容签名变化 → 清除失败态重试渲染(流式中间态自愈);未变则维持占位。
    if (state.failed && state.failedSig !== null && state.failedSig !== props.sig) {
      return { failed: false, failedSig: null };
    }
    return null;
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(
      `[MessageBoundary] 消息渲染失败 id=${this.props.messageId}`,
      error,
      info.componentStack,
    );
    this.setState({ failedSig: this.props.sig });
  }

  render() {
    if (this.state.failed) {
      // 紧凑占位行:沿用消息卡的 border/surface token(暗色主题自适配),不打断消息流节奏。
      return (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3.5 py-2 text-[12.5px] text-muted">
          <AlertTriangle size={13} className="shrink-0 text-warning" aria-hidden="true" />
          <span>此条消息渲染失败</span>
          <span className="font-mono text-[11px] text-faint" title={this.props.messageId}>
            #{this.props.messageId.slice(0, 8)}
          </span>
        </div>
      );
    }
    return this.props.children;
  }
}
