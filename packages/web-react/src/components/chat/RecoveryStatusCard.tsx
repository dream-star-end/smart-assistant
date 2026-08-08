import type { RecoveryStatusState } from "../../lib/chat/model";
import { Button } from "../ui/Button";

const PRIMARY_LABEL: Record<RecoveryStatusState["kind"], string> = {
  "waiting-service": "等待服务恢复",
  retrying: "自动重试中",
  resumed: "已从断点继续",
  "needs-confirmation": "需要确认",
  stopping: "正在停止",
  completed: "已完成",
};

export function RecoveryStatusCard({
  status,
  onStop,
}: {
  status: RecoveryStatusState;
  onStop?: () => void;
}) {
  const label = status.kind === "stopping" && status.masterPersisted
    ? "停止请求已收到，正在停止"
    : PRIMARY_LABEL[status.kind];
  const hasDetails = typeof status.attempt === "number" || !!status.errorCode;
  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-lg border border-info/30 bg-info-soft px-3 py-2 text-body text-fg"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium">{label}</span>
        {onStop && status.kind !== "completed" && (
          <Button size="sm" variant="secondary" onClick={onStop}>停止</Button>
        )}
      </div>
      {hasDetails && (
        <details className="mt-1 text-micro text-muted">
          <summary className="cursor-pointer select-none">查看详情</summary>
          <div className="mt-1 font-mono">
            {typeof status.attempt === "number" && <div>第 {status.attempt} 次</div>}
            {status.errorCode && <div>{status.errorCode}</div>}
          </div>
        </details>
      )}
    </div>
  );
}
