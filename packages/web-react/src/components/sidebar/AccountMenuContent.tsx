import { ArrowUpRight, BookOpen, ChevronRight, Monitor, Moon, Sun } from "lucide-react";
import type { CSSProperties } from "react";
import type { Theme } from "../../hooks/useTheme";
import { PRODUCT_CAPABILITIES } from "../../lib/productCapabilities";
import { cn, formatCredits } from "../../lib/utils";
import {
  Avatar,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "../ui";
import { AtelierLazyIcon } from "../ui/AtelierLazyIcons";

const staggerStyle = (i: number) => ({ "--stagger-i": i }) as CSSProperties;

const THEME_OPTIONS: ReadonlyArray<{
  value: Theme;
  label: string;
  icon: typeof Sun;
}> = [
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
  { value: "system", label: "系统", icon: Monitor },
];

export type AccountMenuContentProps = {
  displayName: string;
  email: string | null;
  showSecondaryEmail: boolean;
  credits?: string | null;
  theme?: Theme;
  onSetTheme?: (theme: Theme) => void;
  onCycleTheme?: () => void;
  showAdmin?: boolean;
  onOpenOrg?: () => void;
  onOpenStudio?: () => void;
  onOpenMediaTasks?: () => void;
  onOpenChatGptProxy?: () => void;
  onOpenAccount?: () => void;
  onOpenPreferences?: () => void;
  onOpenTutorial?: () => void;
  onOpenFeedback?: () => void;
  onLogout?: () => void;
};

export function AccountMenuContent({
  displayName,
  email,
  showSecondaryEmail,
  credits,
  theme,
  onSetTheme,
  onCycleTheme,
  showAdmin,
  onOpenOrg,
  onOpenStudio,
  onOpenMediaTasks,
  onOpenChatGptProxy,
  onOpenAccount,
  onOpenPreferences,
  onOpenTutorial,
  onOpenFeedback,
  onLogout,
}: AccountMenuContentProps) {
  const showThemeControl = Boolean(theme && (onSetTheme || onCycleTheme));
  const settingsAction = onOpenPreferences ?? onOpenAccount;
  const hasPersonalGroup = Boolean(settingsAction || onOpenTutorial || onOpenFeedback);
  const hasCreationGroup = Boolean(onOpenStudio || onOpenMediaTasks);
  const hasAdminAccessGroup = Boolean(onOpenOrg || showAdmin || onOpenChatGptProxy);
  const hasBodyGroups = hasPersonalGroup || hasCreationGroup || hasAdminAccessGroup || Boolean(onLogout);

  const handleSelectTheme = (next: Theme) => {
    if (onSetTheme) {
      onSetTheme(next);
    } else if (onCycleTheme && next !== theme) {
      onCycleTheme();
    }
  };

  let staggerIndex = 0;
  const nextStagger = () => staggerStyle(staggerIndex++);

  const billingCardInner = (
    <>
      <Avatar
        size="md"
        tone="neutral"
        className="oc-avatar-ring bg-accent-soft text-body font-semibold text-accent ring-1 ring-inset ring-accent/20"
      >
        {displayName.slice(0, 1).toUpperCase()}
      </Avatar>
      <div className="min-w-0 flex-1 text-left">
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
      {onOpenAccount && (
        <ChevronRight
          size={15}
          strokeWidth={1.75}
          aria-hidden
          className="shrink-0 text-faint transition-transform duration-150 group-hover/billing:translate-x-0.5 group-hover/billing:text-fg"
        />
      )}
    </>
  );

  return (
    <DropdownMenuContent
      side="top"
      align="start"
      sideOffset={8}
      className="oc-surface-popover w-72 rounded-lg p-1.5"
      data-product-entry-scope="account-menu"
    >
      {onOpenAccount ? (
        <DropdownMenuItem
          asChild
          data-product-feature={PRODUCT_CAPABILITIES.billing.id}
          onSelect={onOpenAccount}
          className="group/billing oc-surface-recessed oc-spring-press mb-1.5 w-full rounded-md px-2.5 py-2.5 text-left transition-colors duration-150 hover:bg-hover/90 data-[highlighted]:bg-hover/90"
        >
          <button
            type="button"
            data-testid="account-menu-billing-card"
            data-product-feature={PRODUCT_CAPABILITIES.billing.id}
            aria-label={`${displayName}，打开账户与计费`}
            title="账户与计费"
          >
            {billingCardInner}
          </button>
        </DropdownMenuItem>
      ) : (
        <div
          data-testid="account-menu-billing-card"
          className="oc-surface-recessed mb-1.5 flex items-center gap-2.5 rounded-md px-2.5 py-2.5"
        >
          {billingCardInner}
        </div>
      )}

      {showThemeControl && (
        <div className="mb-1 px-0.5">
          <div
            role="radiogroup"
            aria-label="外观主题"
            data-testid="account-menu-theme-control"
            className="oc-surface-recessed grid grid-cols-3 gap-0.5 rounded-md p-0.5"
          >
            {THEME_OPTIONS.map((opt) => {
              const Icon = opt.icon;
              const active = theme === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  data-product-feature={PRODUCT_CAPABILITIES.preferences.id}
                  onClick={() => handleSelectTheme(opt.value)}
                  className={cn(
                    "oc-spring-press flex h-7 items-center justify-center gap-1 rounded-sm text-caption font-medium outline-none transition-[background-color,color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:h-9",
                    active
                      ? "bg-surface text-fg shadow-xs ring-1 ring-inset ring-border/70"
                      : "text-faint hover:text-fg",
                  )}
                >
                  <Icon size={13} strokeWidth={1.75} aria-hidden className="shrink-0" />
                  <span>{opt.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {hasBodyGroups && <DropdownMenuSeparator />}

      {settingsAction && (
        <DropdownMenuItem
          data-product-feature={PRODUCT_CAPABILITIES.preferences.id}
          onSelect={settingsAction}
          style={nextStagger()}
          className="oc-spring-press oc-stagger-in gap-2.5 rounded-md py-1.5"
        >
          <span className="oc-icon-badge h-6 w-6 rounded-xs" aria-hidden>
            <AtelierLazyIcon name="settings" size={16} />
          </span>
          <span className="flex-1 font-medium">设置</span>
        </DropdownMenuItem>
      )}
      {onOpenTutorial && (
        <DropdownMenuItem
          data-product-control
          onSelect={onOpenTutorial}
          style={nextStagger()}
          className="oc-spring-press oc-stagger-in gap-2.5 rounded-md py-1.5"
        >
          <span className="oc-icon-badge h-6 w-6 rounded-xs" aria-hidden>
            <BookOpen size={15} strokeWidth={1.75} />
          </span>
          <span className="flex-1 font-medium">帮助与案例</span>
        </DropdownMenuItem>
      )}
      {onOpenFeedback && (
        <DropdownMenuItem
          data-product-feature={PRODUCT_CAPABILITIES.feedback.id}
          onSelect={onOpenFeedback}
          style={nextStagger()}
          className="oc-spring-press oc-stagger-in gap-2.5 rounded-md py-1.5"
        >
          <span className="oc-icon-badge h-6 w-6 rounded-xs" aria-hidden>
            <AtelierLazyIcon name="feedback" size={16} />
          </span>
          <span className="flex-1 font-medium">意见反馈</span>
        </DropdownMenuItem>
      )}

      {hasCreationGroup && hasPersonalGroup && <DropdownMenuSeparator />}
      {onOpenStudio && (
        <DropdownMenuItem
          data-product-control
          onSelect={onOpenStudio}
          style={nextStagger()}
          className="oc-spring-press oc-stagger-in gap-2.5 rounded-md py-1.5"
        >
          <span className="oc-icon-badge oc-icon-badge-accent h-6 w-6 rounded-xs" aria-hidden>
            <AtelierLazyIcon name="studio" size={16} />
          </span>
          <span className="flex-1 font-medium">媒体工作台</span>
          <ArrowUpRight size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-faint" />
        </DropdownMenuItem>
      )}
      {onOpenMediaTasks && (
        <DropdownMenuItem
          data-product-control
          onSelect={onOpenMediaTasks}
          style={nextStagger()}
          className="oc-spring-press oc-stagger-in gap-2.5 rounded-md py-1.5"
        >
          <span className="oc-icon-badge oc-icon-badge-info h-6 w-6 rounded-xs" aria-hidden>
            <AtelierLazyIcon name="video" size={16} />
          </span>
          <span className="flex-1 font-medium">视频任务</span>
        </DropdownMenuItem>
      )}

      {hasAdminAccessGroup && (hasPersonalGroup || hasCreationGroup) && <DropdownMenuSeparator />}
      {hasAdminAccessGroup && (
        <DropdownMenuLabel className="py-1 text-micro font-medium tracking-wide text-faint">
          管理与接入
        </DropdownMenuLabel>
      )}
      {onOpenOrg && (
        <DropdownMenuItem
          data-product-feature={PRODUCT_CAPABILITIES.organization.id}
          onSelect={onOpenOrg}
          style={nextStagger()}
          className="oc-spring-press oc-stagger-in gap-2.5 rounded-md py-1.5"
        >
          <span className="oc-icon-badge h-6 w-6 rounded-xs" aria-hidden>
            <AtelierLazyIcon name="org" size={16} />
          </span>
          <span className="flex-1 font-medium">组织</span>
        </DropdownMenuItem>
      )}
      {showAdmin && (
        <DropdownMenuItem
          asChild
          data-product-control
          style={nextStagger()}
          className="oc-spring-press oc-stagger-in gap-2.5 rounded-md py-1.5"
        >
          <a data-product-control href="/admin.html">
            <span className="oc-icon-badge oc-icon-badge-warning h-6 w-6 rounded-xs" aria-hidden>
              <AtelierLazyIcon name="admin" size={16} />
            </span>
            <span className="flex-1 font-medium">管理后台</span>
            <ArrowUpRight size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-faint" />
          </a>
        </DropdownMenuItem>
      )}
      {onOpenChatGptProxy && (
        <DropdownMenuItem
          data-product-control
          onSelect={onOpenChatGptProxy}
          style={nextStagger()}
          className="oc-spring-press oc-stagger-in gap-2.5 rounded-md py-1.5"
        >
          <span className="oc-icon-badge oc-icon-badge-success h-6 w-6 rounded-xs" aria-hidden>
            <AtelierLazyIcon name="chatgpt" size={16} />
          </span>
          <span className="flex-1 font-medium">ChatGPT 直连</span>
        </DropdownMenuItem>
      )}

      {onLogout && (hasPersonalGroup || hasCreationGroup || hasAdminAccessGroup) && (
        <DropdownMenuSeparator />
      )}
      {onLogout && (
        <DropdownMenuItem
          data-product-control
          destructive
          onSelect={onLogout}
          style={nextStagger()}
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
