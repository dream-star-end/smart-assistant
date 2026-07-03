import { GitBranch } from "lucide-react";
import { formatRepoLabel, type RepoDot } from "../../lib/github";
import type { RepoSelection } from "../../lib/types";
import { cn } from "../../lib/utils";

const DOT_CLASS: Record<RepoDot, string> = {
  none: "bg-transparent",
  pending: "bg-warning",
  cloning: "bg-warning animate-pulse",
  ready: "bg-success",
  failed: "bg-danger",
};

/**
 * 输入框底部仓库入口 pill：未绑显"仓库"，已绑显 owner/repo@branch + 状态点。点击开
 * GitHub 仓库 modal（账号关联 + 选仓 + 绑定）。
 */
export function RepoPill({
  selection,
  onClick,
}: {
  selection: RepoSelection | null;
  onClick: () => void;
}) {
  const { label, dot } = formatRepoLabel(selection);
  const bound = !!selection && selection.selected;
  return (
    <button
      onClick={onClick}
      aria-label="仓库绑定"
      title={bound ? label : "绑定 GitHub 仓库"}
      className={cn(
        "flex min-w-0 items-center gap-1.5 rounded-xl px-2 py-1.5 text-[13px] outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg active:scale-[0.98]",
        bound ? "text-fg" : "text-faint",
      )}
    >
      <GitBranch size={15} className="shrink-0" />
      <span className="hidden max-w-[10rem] truncate sm:inline">{label}</span>
      {dot !== "none" && <span className={cn("size-1.5 shrink-0 rounded-full", DOT_CLASS[dot])} />}
    </button>
  );
}
