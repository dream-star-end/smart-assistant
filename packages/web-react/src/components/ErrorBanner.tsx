import { AlertTriangle, RotateCcw, X } from "lucide-react";
import { Button, IconButton } from "./ui";

/** 一次失败的对话发送：错误文案、可选追踪号、用于重试的原文。 */
export type ChatError = { message: string; requestId?: string; retryText: string };

/**
 * 聊天错误卡片：清晰的失败提示 + 追踪号（对应后端结构化日志 requestId，便于
 * 用户反馈与运维定位）+ 一键重试。比把错误塞进 assistant 气泡更现代、可操作。
 */
export function ErrorBanner({
  error,
  onRetry,
  onDismiss,
}: {
  error: ChatError;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      role="alert"
      aria-live="assertive"
      className="mx-auto mb-2 flex max-w-3xl flex-wrap items-start gap-3 rounded-lg border border-danger/30 bg-danger-soft px-4 py-3 sm:flex-nowrap"
    >
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-danger-soft text-danger">
        <AlertTriangle size={14} />
      </span>
      <div className="min-w-0 flex-1 basis-[calc(100%_-_2.25rem)] sm:basis-auto">
        <p className="text-[13px] font-medium text-fg">发送失败</p>
        <p className="mt-0.5 break-words text-[13px] text-muted">{error.message}</p>
        {error.requestId && (
          <p className="mt-1 select-all font-mono text-[11px] text-faint">追踪号 {error.requestId}</p>
        )}
      </div>
      <div className="flex w-full shrink-0 items-center justify-end gap-1 sm:w-auto">
        <Button
          variant="ghost"
          size="sm"
          onClick={onRetry}
          aria-label="重试发送"
          className="text-accent [@media(hover:none)]:h-11"
        >
          <RotateCcw size={13} /> 重试
        </Button>
        <IconButton
          variant="muted"
          size="sm"
          shape="square"
          onClick={onDismiss}
          aria-label="关闭错误提示"
          className="[@media(hover:none)]:size-11"
        >
          <X size={15} />
        </IconButton>
      </div>
    </div>
  );
}
