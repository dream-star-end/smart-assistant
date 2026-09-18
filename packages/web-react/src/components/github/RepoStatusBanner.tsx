import { CheckCircle2, GitBranch, Loader2, TriangleAlert, X } from "lucide-react";
import { repoStatusText } from "../../lib/github";
import type { RepoSelection } from "../../lib/types";
import { cn } from "../../lib/utils";
import { Button, IconButton, Progress } from "../ui";

/**
 * 会话顶部的仓库克隆状态条。pending/cloning 显进度（cloning 走本地估算曲线），
 * failed 显错误并可关闭，ready 由 useRepoBinding 在 3s 后收起（showBanner 转 false）。
 *
 * 布局（RB-01）：仓库标签与状态文案分两行，窄屏不再把标签截成「dream-star-…」；
 * 失败信息 line-clamp-2 + title 悬浮全文，关键原因不再被单行 truncate 吃掉。
 * 容器为 aria-live 区域让状态变化对读屏播报（RB-03）；关闭按钮换 IconButton 拿到触屏 44px 靶（RB-02）。
 */
export function RepoStatusBanner({
  selection,
  progressPct,
  onDismiss,
  onRetry,
}: {
  selection: RepoSelection;
  progressPct: number;
  onDismiss: () => void;
  onRetry?: () => void;
}) {
  if (!selection.selected) return null;
  const status = selection.status;
  const repoLabel = `${selection.owner}/${selection.repo} @ ${selection.branch}`;
  const tone =
    status === "failed"
      ? "border-danger/30 bg-danger-soft text-danger"
      : status === "ready"
        ? "border-success/30 bg-success-soft text-success"
        : "border-border bg-hover/60 text-muted";

  return (
    <div className={cn("mx-auto mt-2 w-full max-w-3xl px-4")}>
      <div
        data-testid="repo-status-banner"
        aria-live={status === "failed" ? "assertive" : "polite"}
        aria-atomic="true"
        className={cn("flex items-start gap-2.5 rounded-lg border px-3 py-2 text-meta", tone)}
      >
        <span className="mt-0.5 shrink-0" aria-hidden>
          {status === "ready" ? (
            <CheckCircle2 size={15} />
          ) : status === "failed" ? (
            <TriangleAlert size={15} />
          ) : (
            <Loader2 size={15} className="animate-spin" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <GitBranch size={12} className="shrink-0 opacity-70" aria-hidden />
            <span className="min-w-0 truncate font-medium" title={repoLabel}>
              {repoLabel}
            </span>
            {/* 状态词与 git 错误原文此前 opacity-80:语义色压在同色 soft 底上只剩浅色 3.13–3.43
                (t-762 sidebar#2)。去掉透明度,全部用容器的实色;层级靠仓库标签的 font-medium 表达。 */}
            <span className="shrink-0">· {repoStatusText(status)}</span>
          </div>
          {(status === "pending" || status === "cloning") && (
            <Progress value={progressPct} className="mt-1.5 h-1.5" aria-label="仓库克隆进度" />
          )}
          {status === "failed" && selection.error_message && (
            <div className="mt-0.5 line-clamp-2 break-words" title={selection.error_message}>
              {selection.error_message}
            </div>
          )}
        </div>
        {status === "failed" && onRetry && (
          <Button type="button" size="sm" variant="secondary" onClick={onRetry}>
            重试
          </Button>
        )}
        {(status === "failed" || status === "ready") && (
          <IconButton
            aria-label="关闭"
            title="关闭"
            variant="ghost"
            size="xs"
            shape="square"
            onClick={onDismiss}
            className="-mr-1 text-current opacity-70 hover:bg-transparent hover:text-current hover:opacity-100"
          >
            <X size={14} />
          </IconButton>
        )}
      </div>
    </div>
  );
}
