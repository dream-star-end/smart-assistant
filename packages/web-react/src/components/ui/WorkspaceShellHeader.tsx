import { Menu, PanelLeft } from "lucide-react";
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
        tone === "accent" ? "bg-accent motion-safe:animate-pulse" : "bg-danger",
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
  sidebarCollapsed = false,
  onExpandSidebar,
  sessionUnreadCount,
  collapsedExtra,
  border = "subtle",
  backdrop = true,
  className,
  contentClassName,
  "data-product-entry-scope": productEntryScope,
  children,
}: {
  onOpenMobileNav?: () => void;
  mobileNavLabel?: string;
  sidebarCollapsed?: boolean;
  onExpandSidebar?: () => void;
  sessionUnreadCount?: number;
  /** 桌面侧栏折叠态展开钮右侧的附加控件（如 ChatHeader 的新建会话钮）。 */
  collapsedExtra?: ReactNode;
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
        {onOpenMobileNav && (
          <div className="relative shrink-0 md:hidden">
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
        {sidebarCollapsed && (onExpandSidebar || collapsedExtra) && (
          <div className="hidden shrink-0 items-center gap-1 md:flex">
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
    </header>
  );
}
