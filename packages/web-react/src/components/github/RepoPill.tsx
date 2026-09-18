import { formatRepoLabel, type RepoDot } from "../../lib/github";
import { PRODUCT_CAPABILITIES } from "../../lib/productCapabilities";
import type { RepoSelection } from "../../lib/types";
import { cn } from "../../lib/utils";

const DOT_CLASS: Record<RepoDot, string> = {
  none: "bg-transparent",
  pending: "bg-warning",
  cloning: "bg-warning animate-pulse",
  ready: "bg-success",
  failed: "bg-danger",
};

const STATUS_TEXT: Partial<Record<RepoDot, string>> = {
  pending: "准备中",
  cloning: "克隆中",
  failed: "失败",
};

/** 官方 GitHub 标志（lucide 无此品牌图标 → 内联）。 */
function GithubMark({ size = 14 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      className="shrink-0"
    >
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

/**
 * 输入框底部「GitHub 仓库」入口。未绑：GitHub 标志 + 「关联 GitHub 仓库」文字（始终可见,
 * 一眼知道是啥、明显可点）；已绑：标志 + owner/repo + 分支 + 状态点，accent 高亮。
 * 点击开 GitHub 仓库 modal（账号关联 + 选仓 + 绑定）。
 */
export function RepoPill({
  selection,
  onClick,
}: {
  selection: RepoSelection | null;
  onClick: () => void;
}) {
  const { dot } = formatRepoLabel(selection);
  const sel = selection?.selected ? selection : null;
  const statusText = STATUS_TEXT[dot];
  return (
    <button
      type="button"
      data-product-feature={PRODUCT_CAPABILITIES.github.id}
      onClick={onClick}
      aria-label={sel ? `代码仓库 ${sel.owner}/${sel.repo}，点击管理` : "关联 GitHub 仓库"}
      title={sel ? `${sel.owner}/${sel.repo} @ ${sel.branch}` : "关联 GitHub 仓库"}
      className={cn(
        "inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-meta font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg active:scale-[0.98]",
        sel
          ? "border-accent/40 bg-accent-soft text-accent hover:border-accent/60"
          : "border-border text-muted hover:border-border-strong hover:bg-hover hover:text-fg",
      )}
    >
      <GithubMark size={14} />
      {sel ? (
        <>
          {/* owner / 分支 / 状态此前用 opacity-70/80 压暗:accent 文字在 accent-soft 底上被压到
              浅色 2.70、深色 3.62,不达 AA(t-762 sidebar#1)。改用 text-muted 实色分层:
              仓库名保持 accent 加粗,其余段落用实色灰,层级还在、对比度回到 ≥4.5。 */}
          <span className="min-w-0 truncate">
            <span className="text-muted">{sel.owner}/</span>
            <span className="font-semibold">{sel.repo}</span>
          </span>
          <span className="hidden shrink-0 items-center gap-1 border-l border-accent/25 pl-1.5 text-caption text-muted sm:inline-flex">
            {sel.branch}
          </span>
          {statusText ? (
            <span className="shrink-0 text-caption text-muted">· {statusText}</span>
          ) : (
            dot !== "none" && (
              <span className={cn("size-1.5 shrink-0 rounded-full", DOT_CLASS[dot])} />
            )
          )}
        </>
      ) : (
        // 未绑定态文案此前只有 nowrap、不能收缩：放进 Composer 工具行等紧凑容器时会把兄弟元素挤出去
        // （composer 审计 §9 接线项）。改 min-w-0 + truncate，空间不足时省略号收尾，完整文案在 title。
        <span className="min-w-0 truncate">关联 GitHub 仓库</span>
      )}
    </button>
  );
}
