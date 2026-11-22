import { Menu, PanelLeft, RefreshCw } from "lucide-react";
import { type ReactNode, useRef } from "react";
import { cn } from "../../lib/utils";
import { IconButton } from "./IconButton";
import { useToastAnchor } from "./Toast";

/**
 * 顶栏未读状态点（OCV5-820）：
 * - 站内信使用克制 6px danger 实心点；会话未读使用克制 6px accent 实心呼吸点；
 * - 彻底消灭高饱和 `99+` / `40` 焦虑数字泡泡，精准计数保留在父按钮 `aria-label` 与 `title` 中；
 * - count 缺省或 ≤0 时不占位。
 */
export function HeaderCountBadge({
  count,
  testId,
  tone = "danger",
  ariaLabel,
  className,
}: {
  count?: number;
  testId?: string;
  tone?: "danger" | "accent";
  ariaLabel?: string;
  className?: string;
}) {
  if (!count || count <= 0) return null;
  return (
    <span
      data-testid={testId}
      data-unread-count={count}
      aria-label={ariaLabel}
      className={cn(
        "pointer-events-none absolute right-1.5 top-1.5 size-1.5 rounded-full ring-2 ring-bg",
        tone === "accent" ? "bg-accent oc-alive-dot" : "bg-danger",
        className,
      )}
    />
  );
}

/**
 * 主工作区统一壳层顶栏（ChatHeader / TaskboardView / ProjectHome / SitesWorkspaceView 共享）。
 * - 统一 header-safe-t + 弱化底线与毛玻璃背景，消除四大主视图切换时的顶栏高度与描边跳动；
 * - 统一承载移动端抽屉入口、桌面折叠态展开入口与克制的会话未读 6px 呼吸点；
 * - 统一向 ToastProvider 登记实测下沿（useToastAnchor），保证提示始终落在顶栏下方；
 * - 开启 CSS `@container`，允许子元素按实际 `<main>` 宽度（而非视口宽度）在三栏态下渐进收纳。
 */
export function WorkspaceShellHeader({
  onOpenMobileNav,
  mobileNavLabel = "打开菜单",
  mobileLeftExtra,
  sidebarCollapsed = false,
  onExpandSidebar,
  sessionUnreadCount,
  collapsedExtra,
  updateAvailable = false,
  onReloadForUpdate,
  border = "subtle",
  backdrop = true,
  className,
  contentClassName,
  "data-product-entry-scope": productEntryScope,
  children,
}: {
  onOpenMobileNav?: () => void;
  mobileNavLabel?: string;
  /** 移动端（<md）汉堡菜单钮紧右侧的附加控件（如 ChatHeader 对话态的新建会话钮，与桌面折叠态对齐）。 */
  mobileLeftExtra?: ReactNode;
  sidebarCollapsed?: boolean;
  onExpandSidebar?: () => void;
  sessionUnreadCount?: number;
  /** 桌面侧栏折叠态展开钮右侧的附加控件（如 ChatHeader 的新建会话钮）。 */
  collapsedExtra?: ReactNode;
  /** 服务端已是新前端（appUpdate.getPillVisible）。true 且提供 onReloadForUpdate 时在壳层统一渲染轻刷新条。 */
  updateAvailable?: boolean;
  onReloadForUpdate?: () => void;
  border?: "subtle" | "none";
  backdrop?: boolean;
  className?: string;
  contentClassName?: string;
  "data-product-entry-scope"?: string;
  children?: ReactNode;
}) {
  const headerRef = useRef<HTMLElement>(null);
  useToastAnchor(headerRef);
  const hasUnreadSessions = Boolean(sessionUnreadCount && sessionUnreadCount > 0);
  const showUpdateBanner = Boolean(updateAvailable && onReloadForUpdate);

  return (
    <header
      ref={headerRef}
      data-product-entry-scope={productEntryScope}
      className={cn(
        "@container shrink-0 header-safe-t transition-colors duration-150",
        backdrop ? "bg-bg/85 backdrop-blur-md saturate-125" : "bg-bg",
        border === "subtle" && "border-b border-border/70",
        className,
      )}
    >
      <div
        className={cn(
          "flex min-h-12 w-full items-center gap-x-1.5 gap-y-0.5 px-2.5 py-1 sm:px-4 sm:py-1.5",
          contentClassName,
        )}
      >
        {(onOpenMobileNav || mobileLeftExtra) && (
          <div className="flex shrink-0 items-center gap-0.5 md:hidden" data-testid="shell-mobile-left">
            {onOpenMobileNav && (
              <div className="relative shrink-0">
                <IconButton
                  data-product-control
                  onClick={onOpenMobileNav}
                  aria-label={
                    hasUnreadSessions
                      ? `${mobileNavLabel},${sessionUnreadCount} 条未读会话`
                      : mobileNavLabel
                  }
                  title={
                    hasUnreadSessions
                      ? `${mobileNavLabel}（${sessionUnreadCount} 条未读会话）`
                      : mobileNavLabel
                  }
                  shape="square"
                >
                  <Menu size={18} />
                </IconButton>
                <HeaderCountBadge
                  count={sessionUnreadCount}
                  testId="session-unread-badge"
                  tone="accent"
                  ariaLabel={hasUnreadSessions ? `${sessionUnreadCount} 条未读会话` : undefined}
                />
              </div>
            )}
            {mobileLeftExtra}
          </div>
        )}
        {sidebarCollapsed && (onExpandSidebar || collapsedExtra) && (
          <div className="hidden shrink-0 items-center gap-1 md:flex" data-testid="shell-collapsed-left">
            {onExpandSidebar && (
              <div className="relative">
                <IconButton
                  data-product-control
                  onClick={onExpandSidebar}
                  aria-label={
                    hasUnreadSessions
                      ? `展开侧栏,${sessionUnreadCount} 条未读会话`
                      : "展开侧栏"
                  }
                  title={
                    hasUnreadSessions
                      ? `展开侧栏（${sessionUnreadCount} 条未读会话）`
                      : "展开侧栏"
                  }
                  shape="square"
                >
                  <PanelLeft size={18} />
                </IconButton>
                <HeaderCountBadge
                  count={sessionUnreadCount}
                  testId="session-unread-badge"
                  tone="accent"
                  ariaLabel={hasUnreadSessions ? `${sessionUnreadCount} 条未读会话` : undefined}
                />
              </div>
            )}
            {collapsedExtra}
          </div>
        )}
        {children}
      </div>
      {showUpdateBanner && (
        <div
          data-testid="shell-update-banner"
          role="status"
          className="flex items-center justify-center border-t border-accent/15 bg-accent-soft/65 px-3 py-1"
        >
          <button
            type="button"
            data-product-control
            data-testid="update-pill"
            aria-label="有新版本，点击刷新页面"
            title="有新版本，点击刷新页面"
            onClick={onReloadForUpdate}
            className="oc-btn-tactile oc-spring-press inline-flex min-h-7 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-caption font-medium text-accent outline-none transition-colors hover:bg-accent/12 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-bg"
          >
            <RefreshCw size={12} strokeWidth={1.75} aria-hidden className="shrink-0" />
            <span>发现新版本 · 立即刷新</span>
          </button>
        </div>
      )}
    </header>
  );
}
