import type { CSSProperties } from "react";
import { PRODUCT_CAPABILITIES } from "../../lib/productCapabilities";
import { formatCredits } from "../../lib/utils";
import {
  Avatar,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "../ui";
import { AtelierLazyIcon } from "../ui/AtelierLazyIcons";

const staggerStyle = (i: number) => ({ "--stagger-i": i }) as CSSProperties;

export type AccountMenuContentProps = {
  displayName: string;
  email: string | null;
  showSecondaryEmail: boolean;
  credits?: string | null;
  showAdmin?: boolean;
  onOpenManage?: () => void;
  onOpenMarketplace?: () => void;
  onOpenOrg?: () => void;
  onOpenStudio?: () => void;
  onOpenMediaTasks?: () => void;
  onOpenChatGptProxy?: () => void;
  onOpenApiAccess?: () => void;
  onOpenAccount?: () => void;
  onOpenFeedback?: () => void;
  onLogout?: () => void;
};

export function AccountMenuContent({
  displayName,
  email,
  showSecondaryEmail,
  credits,
  showAdmin,
  onOpenManage,
  onOpenMarketplace,
  onOpenOrg,
  onOpenStudio,
  onOpenMediaTasks,
  onOpenChatGptProxy,
  onOpenApiAccess,
  onOpenAccount,
  onOpenFeedback,
  onLogout,
}: AccountMenuContentProps) {
  return (
    <DropdownMenuContent
      side="top"
      align="start"
      sideOffset={8}
      className="oc-surface-popover w-72 rounded-lg p-1.5"
      data-product-entry-scope="account-menu"
    >
      <div className="oc-surface-recessed mb-1.5 flex items-center gap-2.5 rounded-md px-2.5 py-2.5">
        <Avatar
          size="md"
          tone="neutral"
          className="oc-avatar-ring bg-accent-soft text-body font-semibold text-accent ring-1 ring-inset ring-accent/20"
        >
          {displayName.slice(0, 1).toUpperCase()}
        </Avatar>
        <div className="min-w-0 flex-1">
          <p
            className="truncate text-section font-semibold leading-snug text-fg"
            title={displayName}
          >
            {displayName}
          </p>
          {/* 当显示名与邮箱相同时只显示一行主标题，避免重复两遍邮箱；不同时保留登录邮箱副标题。 */}
          {showSecondaryEmail && (
            <p className="mt-0.5 truncate text-caption text-faint" title={email ?? undefined}>
              {email}
            </p>
          )}
          {credits != null && (
            <div className="mt-1.5 flex items-center">
              <span className="oc-badge-craft inline-flex max-w-full items-center truncate rounded-full bg-accent-soft px-2 py-0.5 text-caption font-semibold tabular-nums text-accent">
                {`${formatCredits(credits)} 积分`}
              </span>
            </div>
          )}
        </div>
      </div>
      <DropdownMenuSeparator />
      {onOpenManage && (
        <DropdownMenuItem
          data-product-feature={PRODUCT_CAPABILITIES.memory.id}
          onSelect={onOpenManage}
          style={staggerStyle(0)}
          className="oc-spring-press oc-stagger-in gap-2.5 rounded-md py-1.5"
        >
          <span className="oc-icon-badge oc-icon-badge-accent h-6 w-6 rounded-xs" aria-hidden>
            <AtelierLazyIcon name="manage" size={16} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-body font-medium leading-tight text-fg">管理中心</span>
            <span className="mt-0.5 block truncate text-caption leading-tight text-faint">
              记忆 · 技能 · 定时 · 插件
            </span>
          </span>
        </DropdownMenuItem>
      )}
      {onOpenMarketplace && (
        <DropdownMenuItem
          data-product-feature={PRODUCT_CAPABILITIES.marketplace.id}
          onSelect={onOpenMarketplace}
          style={staggerStyle(1)}
          className="oc-spring-press oc-stagger-in gap-2.5 rounded-md py-1.5"
        >
          <span className="oc-icon-badge oc-icon-badge-info h-6 w-6 rounded-xs" aria-hidden>
            <AtelierLazyIcon name="market" size={16} />
          </span>
          <span className="flex-1 font-medium">市场</span>
        </DropdownMenuItem>
      )}
      {onOpenOrg && (
        <DropdownMenuItem
          data-product-feature={PRODUCT_CAPABILITIES.organization.id}
          onSelect={onOpenOrg}
          style={staggerStyle(2)}
          className="oc-spring-press oc-stagger-in gap-2.5 rounded-md py-1.5"
        >
          <span className="oc-icon-badge h-6 w-6 rounded-xs" aria-hidden>
            <AtelierLazyIcon name="org" size={16} />
          </span>
          <span className="flex-1 font-medium">组织</span>
        </DropdownMenuItem>
      )}
      {showAdmin && (
        <DropdownMenuItem asChild data-product-control style={staggerStyle(3)} className="oc-spring-press oc-stagger-in gap-2.5 rounded-md py-1.5">
          <a data-product-control href="/admin.html">
            <span className="oc-icon-badge oc-icon-badge-warning h-6 w-6 rounded-xs" aria-hidden>
              <AtelierLazyIcon name="admin" size={16} />
            </span>
            <span className="flex-1 font-medium">管理后台</span>
          </a>
        </DropdownMenuItem>
      )}
      {onOpenStudio && (
        <DropdownMenuItem
          data-product-control
          onSelect={onOpenStudio}
          style={staggerStyle(4)}
          className="oc-spring-press oc-stagger-in gap-2.5 rounded-md py-1.5"
        >
          <span className="oc-icon-badge oc-icon-badge-accent h-6 w-6 rounded-xs" aria-hidden>
            <AtelierLazyIcon name="studio" size={16} />
          </span>
          <span className="flex-1 font-medium">媒体工作台</span>
        </DropdownMenuItem>
      )}
      {onOpenMediaTasks && (
        <DropdownMenuItem
          data-product-control
          onSelect={onOpenMediaTasks}
          style={staggerStyle(5)}
          className="oc-spring-press oc-stagger-in gap-2.5 rounded-md py-1.5"
        >
          <span className="oc-icon-badge oc-icon-badge-info h-6 w-6 rounded-xs" aria-hidden>
            <AtelierLazyIcon name="video" size={16} />
          </span>
          <span className="flex-1 font-medium">视频任务</span>
        </DropdownMenuItem>
      )}
      {(onOpenChatGptProxy || onOpenApiAccess) &&
        (onOpenManage ||
          onOpenMarketplace ||
          onOpenOrg ||
          showAdmin ||
          onOpenStudio ||
          onOpenMediaTasks) && <DropdownMenuSeparator />}
      {onOpenChatGptProxy && (
        <DropdownMenuItem
          data-product-control
          onSelect={onOpenChatGptProxy}
          style={staggerStyle(6)}
          className="oc-spring-press oc-stagger-in gap-2.5 rounded-md py-1.5"
        >
          <span className="oc-icon-badge oc-icon-badge-success h-6 w-6 rounded-xs" aria-hidden>
            <AtelierLazyIcon name="chatgpt" size={16} />
          </span>
          <span className="flex-1 font-medium">ChatGPT 直连</span>
        </DropdownMenuItem>
      )}
      {onOpenApiAccess && (
        <DropdownMenuItem
          data-product-control
          onSelect={onOpenApiAccess}
          style={staggerStyle(7)}
          className="oc-spring-press oc-stagger-in gap-2.5 rounded-md py-1.5"
        >
          <span className="oc-icon-badge oc-icon-badge-accent h-6 w-6 rounded-xs" aria-hidden>
            <AtelierLazyIcon name="api" size={16} />
          </span>
          <span className="flex-1 font-medium">API 接入</span>
          <span className="oc-badge-craft rounded-full bg-accent-soft px-1.5 py-0.5 text-caption font-medium text-accent">
            本地 Claude Code
          </span>
        </DropdownMenuItem>
      )}
      {(onOpenAccount || onOpenFeedback || onLogout) &&
        (onOpenManage ||
          onOpenMarketplace ||
          onOpenOrg ||
          showAdmin ||
          onOpenStudio ||
          onOpenMediaTasks ||
          onOpenChatGptProxy ||
          onOpenApiAccess) && <DropdownMenuSeparator />}
      {onOpenAccount && (
        <DropdownMenuItem
          data-product-feature={PRODUCT_CAPABILITIES.billing.id}
          onSelect={onOpenAccount}
          style={staggerStyle(8)}
          className="oc-spring-press oc-stagger-in gap-2.5 rounded-md py-1.5"
        >
          <span className="oc-icon-badge h-6 w-6 rounded-xs" aria-hidden>
            <AtelierLazyIcon name="settings" size={16} />
          </span>
          <span className="flex-1 font-medium">设置</span>
        </DropdownMenuItem>
      )}
      {onOpenFeedback && (
        <DropdownMenuItem
          data-product-feature={PRODUCT_CAPABILITIES.feedback.id}
          onSelect={onOpenFeedback}
          style={staggerStyle(9)}
          className="oc-spring-press oc-stagger-in gap-2.5 rounded-md py-1.5"
        >
          <span className="oc-icon-badge h-6 w-6 rounded-xs" aria-hidden>
            <AtelierLazyIcon name="feedback" size={16} />
          </span>
          <span className="flex-1 font-medium">意见反馈</span>
        </DropdownMenuItem>
      )}
      {onLogout && (onOpenAccount || onOpenFeedback) && <DropdownMenuSeparator />}
      {onLogout && (
        <DropdownMenuItem
          data-product-control
          destructive
          onSelect={onLogout}
          style={staggerStyle(10)}
          className="oc-spring-press oc-stagger-in gap-2.5 rounded-md py-1.5"
        >
          <span className="oc-icon-badge oc-icon-badge-danger h-6 w-6 rounded-xs" aria-hidden>
            <AtelierLazyIcon name="logout" size={16} />
          </span>
          <span className="flex-1 font-medium">退出登录</span>
        </DropdownMenuItem>
      )}
    </DropdownMenuContent>
  );
}
