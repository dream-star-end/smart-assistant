import { PRODUCT_CAPABILITIES } from "../../lib/productCapabilities";
import type { RepoSelection } from "../../lib/types";
import { Button } from "../ui";

function shortSha(sha: string | undefined): string {
  if (!sha) return "—";
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}

/**
 * 右栏绑定仓库卡。只展示绑定时快照，禁止写成「当前分支」。
 * 未绑定由调用方不传入（模块 hasData=false）。
 */
export function BoundRepoCard({
  selection,
  onOpenRepo,
}: {
  selection: Extract<RepoSelection, { selected: true }>;
  onOpenRepo: () => void;
}) {
  return (
    <div
      data-testid="bound-repo-card"
      data-product-feature={PRODUCT_CAPABILITIES.github.id}
      className="rounded-lg border border-border bg-elevated p-3"
    >
      <dl className="flex flex-col gap-2 text-caption">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <dt className="shrink-0 text-faint">绑定仓库</dt>
          <dd className="min-w-0 truncate text-right text-fg">
            {selection.owner}/{selection.repo}
          </dd>
        </div>
        <div className="flex min-w-0 items-start justify-between gap-3">
          <dt className="shrink-0 text-faint">绑定分支</dt>
          <dd className="min-w-0 truncate text-right text-fg">{selection.branch}</dd>
        </div>
        <div className="flex min-w-0 items-start justify-between gap-3">
          <dt className="shrink-0 text-faint">绑定时 HEAD</dt>
          <dd className="min-w-0 truncate font-mono text-right text-fg">{shortSha(selection.head_sha)}</dd>
        </div>
      </dl>
      <Button size="sm" variant="secondary" className="mt-3 w-full" onClick={onOpenRepo}>
        绑定/更换仓库
      </Button>
    </div>
  );
}
