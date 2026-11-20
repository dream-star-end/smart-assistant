import type { GoalStateSnapshot } from "@openclaude/protocol/goalState";
import { Plus, Target } from "lucide-react";
import { goalNearBudget } from "../lib/goalPresentation";
import { PRODUCT_CAPABILITIES } from "../lib/productCapabilities";
import type { RepoSelection } from "../lib/types";
import { cn } from "../lib/utils";
import { GithubMark } from "./github/RepoPill";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
} from "./ui";

export function ComposerPlusMenu({
  open,
  onOpenChange,
  disabled,
  canGoal,
  visibleGoal,
  onOpenGoal,
  onOpenRepo,
  repoSelection,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
  canGoal: boolean;
  visibleGoal: GoalStateSnapshot | null;
  onOpenGoal: () => void;
  onOpenRepo?: () => void;
  repoSelection?: RepoSelection | null;
}) {
  const hasBoundRepo = Boolean(onOpenRepo && repoSelection?.selected);
  const hasMenu = canGoal || Boolean(onOpenRepo);

  const goalDot = visibleGoal ? (
    <span
      aria-hidden
      data-testid="composer-goal-dot"
      className={cn(
        "absolute right-1 top-1 size-1.5 rounded-full",
        goalNearBudget(visibleGoal) ? "bg-warning" : "bg-accent",
      )}
    />
  ) : null;

  if (!hasMenu) {
    return (
      <IconButton
        data-product-feature={PRODUCT_CAPABILITIES.files.id}
        aria-label="更多选项"
        title="更多选项暂不可用"
        disabled
        className="relative"
      >
        <Plus size={20} />
        {goalDot}
      </IconButton>
    );
  }

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <IconButton
          data-product-feature={PRODUCT_CAPABILITIES.files.id}
          aria-label="更多选项"
          title="更多选项"
          disabled={disabled}
          className="relative"
        >
          <Plus size={20} />
          {goalDot}
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top">
        {canGoal && (
          <DropdownMenuItem
            data-product-feature={PRODUCT_CAPABILITIES.sessionGoal.id}
            onSelect={onOpenGoal}
          >
            <Target size={16} className="shrink-0 text-muted" />
            <span className="flex-1">{visibleGoal ? "目标" : "设定目标"}</span>
            {visibleGoal && (
              <span
                aria-hidden
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  goalNearBudget(visibleGoal) ? "bg-warning" : "bg-accent",
                )}
              />
            )}
          </DropdownMenuItem>
        )}
        {onOpenRepo && (
          <DropdownMenuItem
            data-product-feature={PRODUCT_CAPABILITIES.github.id}
            data-testid="composer-menu-repo"
            onSelect={onOpenRepo}
          >
            <GithubMark size={15} />
            <span className="min-w-0 flex-1 truncate">
              {hasBoundRepo && repoSelection?.selected
                ? `GitHub · ${repoSelection.repo}`
                : "关联 GitHub 仓库"}
            </span>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
