import { CheckCircle2, GitBranch, Loader2, TriangleAlert, X } from "lucide-react";
import { repoStatusText } from "../../lib/github";
import type { RepoSelection } from "../../lib/types";
import { cn } from "../../lib/utils";
import { Progress } from "../ui";

/**
 * 会话顶部的仓库克隆状态条。pending/cloning 显进度（cloning 走本地估算曲线），
 * failed 显错误并可关闭，ready 由 useRepoBinding 在 3s 后收起（showBanner 转 false）。
 */
export function RepoStatusBanner({
  selection,
  progressPct,
  onDismiss,
}: {
  selection: RepoSelection;
  progressPct: number;
  onDismiss: () => void;
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
      <div className={cn("flex items-center gap-2.5 rounded-lg border px-3 py-2 text-[12.5px]", tone)}>
        <span className="shrink-0">
          {status === "ready" ? (
            <CheckCircle2 size={15} />
          ) : status === "failed" ? (
            <TriangleAlert size={15} />
          ) : (
            <Loader2 size={15} className="animate-spin" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <GitBranch size={12} className="shrink-0 opacity-70" />
            <span className="truncate font-medium">{repoLabel}</span>
            <span className="shrink-0 opacity-80">· {repoStatusText(status)}</span>
          </div>
          {(status === "pending" || status === "cloning") && (
            <Progress value={progressPct} className="mt-1.5 h-1.5" aria-label="仓库克隆进度" />
          )}
          {status === "failed" && selection.error_message && (
            <div className="mt-0.5 truncate opacity-80">{selection.error_message}</div>
          )}
        </div>
        {(status === "failed" || status === "ready") && (
          <button
            type="button"
            aria-label="关闭"
            onClick={onDismiss}
            className="-mr-1 shrink-0 rounded p-0.5 opacity-70 outline-none transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
