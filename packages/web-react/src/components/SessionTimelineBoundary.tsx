import { AlertTriangle } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode; onRetry?: () => void; resetKey?: string };
type State = { failed: boolean; autoRetryUsed: boolean };

function isUpdateDepthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("Minified React error #185") || message.includes("Maximum update depth");
}

/** Last-resort list boundary. Per-message MessageBoundary still owns single-row faults. */
export class SessionTimelineBoundary extends Component<Props, State> {
  state: State = { failed: false, autoRetryUsed: false };
  private autoRetryTimer: number | null = null;

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("[SessionTimelineBoundary] 会话时间线渲染失败", error, info.componentStack);
    // Virtuoso #185 is a renderer lifecycle loop, not corrupt conversation data. Once the
    // offending tree is unmounted by this boundary, one deferred remount is safe and avoids
    // leaving the user on a permanent fatal card after background/foreground restoration.
    // Persistent faults stop after this single attempt and keep the ordinary manual Retry.
    if (!isUpdateDepthError(error) || this.state.autoRetryUsed) return;
    this.setState({ autoRetryUsed: true });
    this.autoRetryTimer = window.setTimeout(() => {
      this.autoRetryTimer = null;
      this.props.onRetry?.();
      this.setState({ failed: false });
    }, 0);
  }

  componentDidUpdate(prevProps: Props) {
    if (this.props.resetKey !== prevProps.resetKey && (this.state.failed || this.state.autoRetryUsed)) {
      this.setState({ failed: false, autoRetryUsed: false });
    }
  }

  componentWillUnmount() {
    if (this.autoRetryTimer !== null) window.clearTimeout(this.autoRetryTimer);
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
