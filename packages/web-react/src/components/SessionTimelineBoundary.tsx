import { AlertTriangle } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode; onRetry?: () => void };
type State = { failed: boolean };

/** Last-resort list boundary. Per-message MessageBoundary still owns single-row faults. */
export class SessionTimelineBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("[SessionTimelineBoundary] 会话时间线渲染失败", error, info.componentStack);
  }

  render() {
    if (this.state.failed) {
      return (
        <div
          className="mx-auto flex max-w-3xl flex-col items-center gap-3 px-5 py-12 text-center"
          data-testid="timeline-fatal-error"
        >
          <AlertTriangle size={18} className="text-warning" aria-hidden="true" />
          <p className="text-sm text-muted">会话内容渲染失败</p>
          {this.props.onRetry && (
            <button
              type="button"
              className="rounded-full bg-hover px-3 py-1.5 text-xs text-fg"
              onClick={() => {
                this.setState({ failed: false });
                this.props.onRetry?.();
              }}
            >
              重试
            </button>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}
