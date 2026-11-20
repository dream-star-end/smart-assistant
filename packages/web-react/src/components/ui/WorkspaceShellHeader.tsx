import { Menu, PanelLeft } from "lucide-react";
import { type ReactNode, useRef } from "react";
import { cn } from "../../lib/utils";
import { IconButton } from "./IconButton";
import { useToastAnchor } from "./Toast";

/** 顶栏角标：站内信 danger、会话未读 accent。count 缺省或 ≤0 不占位。 */
export function HeaderCountBadge({
  count,
  testId,
  tone = "danger",
  ariaLabel,
}: {
  count?: number;
  testId?: string;
  tone?: "danger" | "accent";
  ariaLabel?: string;
}) {
  if (!count || count <= 0) return null;
  return (
    <span
      data-testid={testId}
      aria-label={ariaLabel}
      className={cn(
        "pointer-events-none absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-micro font-semibold leading-none tabular-nums",
        // 前景走 -fg token 而不是写死白字:深色主题 accent #9a8aff / danger #f0666e 都是浅色,
        // 白字只有 2.8 / 3.1:1;-fg 在深色下取近黑(≥5.9:1),浅色下仍是白(a11y 走查 shell#1/#11)。
        tone === "accent" ? "bg-accent text-accent-fg" : "bg-danger text-danger-fg",
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

/**
 * 主工作区统一壳层顶栏（ChatHeader / TaskboardView / ProjectHome / SitesWorkspaceView 共享）。
 * - 统一 min-h-14 + header-safe-t + 弱化底线与毛玻璃背景，消除四大主视图切换时的顶栏高度与描边跳动；
 * - 统一承载移动端抽屉入口、桌面折叠态展开入口与会话未读角标；
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

  return (
    <header
      ref={headerRef}
      data-product-entry-scope={productEntryScope}
      className={cn(
        "@container shrink-0 header-safe-t",
        backdrop ? "bg-bg/90 backdrop-blur-sm" : "bg-bg",
        border === "subtle" && "border-b border-border/60",
        className,
      )}
    >
      <div
        className={cn(
          "flex min-h-11 w-full items-center gap-x-1.5 gap-y-0.5 px-2.5 pb-1.5 sm:px-4 sm:pb-2",
          contentClassName,
        )}
      >
        {onOpenMobileNav && (
          <div className="relative shrink-0 md:hidden">
            <IconButton
              data-product-control
              onClick={onOpenMobileNav}
              aria-label={
                sessionUnreadCount && sessionUnreadCount > 0
                  ? `${mobileNavLabel},${sessionUnreadCount} 条未读会话`
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
              ariaLabel={sessionUnreadCount ? `${sessionUnreadCount} 条未读会话` : undefined}
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
                    sessionUnreadCount && sessionUnreadCount > 0
                      ? `展开侧栏,${sessionUnreadCount} 条未读会话`
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
                  ariaLabel={sessionUnreadCount ? `${sessionUnreadCount} 条未读会话` : undefined}
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
