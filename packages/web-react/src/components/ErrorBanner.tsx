import { AlertTriangle, RotateCcw, X } from "lucide-react";
import { ErrorTechDetails } from "./ErrorTechDetails";
import { Button, IconButton } from "./ui";

/** 一次失败的对话发送：错误文案、可选追踪号、用于重试的原文。 */
export type ChatError = { message: string; requestId?: string; retryText: string };

/**
 * 聊天错误卡片：清晰的失败提示 + 一键重试。追踪号（对应后端结构化日志 requestId，便于
 * 用户反馈与运维定位）收在「技术详情」里，展开后可复制，默认不显示（W3）。
 */
export function ErrorBanner({
  error,
  onRetry,
  onDismiss,
  onSwitchModel,
}: {
  error: ChatError;
  onRetry: () => void;
  onDismiss: () => void;
  onSwitchModel?: () => void;
}) {
  return (
    <div
      role="alert"
      aria-live="assertive"
      data-tone="danger"
      className="oc-callout oc-callout-danger mx-auto mb-2 flex max-w-3xl flex-wrap items-start gap-3 rounded-xl px-4 py-3 sm:flex-nowrap animate-in"
    >
      <span className="oc-icon-badge oc-icon-badge-danger mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg">
        <AlertTriangle size={14} strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1 basis-[calc(100%_-_2.5rem)] sm:basis-auto">
        <p className="text-body font-semibold text-fg">发送失败</p>
        <p className="mt-0.5 break-words text-body text-muted">{error.message}</p>
        {error.requestId && <ErrorTechDetails collapsible text={`追踪号：${error.requestId}`} />}
      </div>
      <div className="flex w-full shrink-0 items-center justify-end gap-1.5 sm:w-auto">
        <Button
          variant="secondary"
          size="sm"
          onClick={onRetry}
          aria-label="继续"
          className="oc-btn-tactile oc-btn-secondary-craft text-accent [@media(hover:none)]:h-11"
        >
          <RotateCcw size={13} strokeWidth={1.75} /> 继续
        </Button>
        {onSwitchModel && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onSwitchModel}
            aria-label="切换模型"
            className="oc-btn-tactile text-accent [@media(hover:none)]:h-11"
          >
            切换模型
          </Button>
        )}
        <IconButton
          variant="muted"
          size="sm"
          shape="square"
          onClick={onDismiss}
          aria-label="关闭错误提示"
          className="oc-btn-tactile [@media(hover:none)]:size-11"
        >
          <X size={15} strokeWidth={1.75} />
        </IconButton>
      </div>
    </div>
  );
}
