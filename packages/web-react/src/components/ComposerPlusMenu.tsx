import type { GoalStateSnapshot } from "@openclaude/protocol/goalState";
import { Plus, Target } from "lucide-react";
import { useRef, useState } from "react";
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
import { AtelierIcon } from "./ui/AtelierIcons";

export function ComposerPlusMenu({
  open,
  onOpenChange,
  disabled,
  canGoal,
  visibleGoal,
  onOpenGoal,
  onOpenRepo,
  repoSelection,
  hasSwarmPlaybooks = false,
  onOpenSwarmPlaybooks,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
  canGoal: boolean;
  visibleGoal: GoalStateSnapshot | null;
  onOpenGoal: () => void;
  onOpenRepo?: () => void;
  repoSelection?: RepoSelection | null;
  /** OCV5-843: 桌面与移动端统一将蜂群剧本模板收敛进「+」菜单，仅支持蜂群的模型显示。 */
  hasSwarmPlaybooks?: boolean;
  onOpenSwarmPlaybooks?: () => void;
}) {
  const hasBoundRepo = Boolean(onOpenRepo && repoSelection?.selected);
  const showSwarmPlaybooks = Boolean(hasSwarmPlaybooks && onOpenSwarmPlaybooks);
  const hasMenu = canGoal || Boolean(onOpenRepo) || showSwarmPlaybooks;
  // 选中会接管焦点的菜单项（剧本弹层 / 目标 / 仓库弹窗）时：
  // 1) 阻止菜单关闭把焦点抢回「+」按钮；
  // 2) 跳过 120ms 退场动画让菜单立刻卸载，避免退场期残留的 FocusScope 抢走新弹层焦点并触发 focusOutside 秒关（OCV5-861）。
  const suppressCloseFocusRef = useRef(false);
  const [instantClose, setInstantClose] = useState(false);

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
        className="oc-btn-tactile relative"
      >
        <Plus size={18} strokeWidth={1.75} />
        {goalDot}
      </IconButton>
    );
  }

  const handoffToOverlay = (action: () => void) => {
    suppressCloseFocusRef.current = true;
    setInstantClose(true);
    action();
  };

  return (
    <DropdownMenu
      open={open}
      modal={false}
      onOpenChange={(next) => {
        if (next) {
          suppressCloseFocusRef.current = false;
          setInstantClose(false);
        }
        onOpenChange(next);
      }}
    >
      <DropdownMenuTrigger asChild>
        <IconButton
          data-product-feature={PRODUCT_CAPABILITIES.files.id}
          aria-label="更多选项"
          title="更多选项"
          disabled={disabled}
          className={cn(
            "oc-btn-tactile relative",
            open && "bg-accent-soft text-accent",
          )}
        >
          <Plus
            size={18}
            strokeWidth={1.75}
            className={cn("transition-transform duration-200 ease-spring", open && "rotate-45")}
          />
          {goalDot}
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        className={cn("min-w-[13rem]", instantClose && "data-[state=closed]:animate-none")}
        onCloseAutoFocus={(event) => {
          if (suppressCloseFocusRef.current) {
            suppressCloseFocusRef.current = false;
            event.preventDefault();
          }
        }}
      >
        {canGoal && (
          <DropdownMenuItem
            data-product-feature={PRODUCT_CAPABILITIES.sessionGoal.id}
            onSelect={() => handoffToOverlay(onOpenGoal)}
            className="gap-2.5"
          >
            <span
              aria-hidden
              className={cn(
                "oc-icon-badge size-6 rounded-xs",
                visibleGoal
                  ? goalNearBudget(visibleGoal)
                    ? "oc-icon-badge-warning"
                    : "oc-icon-badge-accent"
                  : "oc-icon-badge-accent",
              )}
            >
              <Target size={13} strokeWidth={1.75} />
            </span>
            <span className="flex-1 font-medium">{visibleGoal ? "目标" : "设定目标"}</span>
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
            onSelect={() => handoffToOverlay(onOpenRepo)}
            className="gap-2.5"
          >
            <span
              aria-hidden
              className={cn(
                "oc-icon-badge size-6 rounded-xs",
                hasBoundRepo && "oc-icon-badge-info",
              )}
            >
              <GithubMark size={13} />
            </span>
            <span className="min-w-0 flex-1 truncate font-medium">
              {hasBoundRepo && repoSelection?.selected
                ? `GitHub · ${repoSelection.repo}`
                : "关联 GitHub 仓库"}
            </span>
          </DropdownMenuItem>
        )}
        {showSwarmPlaybooks && (
          <DropdownMenuItem
            data-product-control
            data-testid="composer-menu-swarm-playbooks"
            onSelect={() => handoffToOverlay(() => onOpenSwarmPlaybooks?.())}
            className="gap-2.5"
          >
            <span
              aria-hidden
              className="oc-icon-badge oc-icon-badge-accent size-6 rounded-xs"
            >
              <AtelierIcon name="swarm" size={13} />
            </span>
            <span className="flex-1 font-medium">蜂群剧本模板</span>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
