import {
  ChevronRight,
  LogOut,
  Menu,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Shield,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { LazyBoundary } from "../components/ChunkErrorBoundary";
import { ThemeToggle } from "../components/ThemeToggle";
import { Avatar, Badge, IconButton, Sheet, Skeleton } from "../components/ui";
import { type Theme, useTheme } from "../hooks/useTheme";
import { getGovernanceOverview } from "../lib/api/governanceApi";
import { ApiError } from "../lib/api/http";
import { cn } from "../lib/utils";
import type { User } from "../lib/types";
import { adminSession } from "./auth";
import { getVisibleAdminGroups, getVisibleAdminPage } from "./registry";
import { useAdminRoute } from "./router";

/** 懒块下载期的页面骨架（LazyBoundary fallback）。 */
function PageSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3 border-b border-border/80 pb-4">
        <Skeleton className="size-10 shrink-0 rounded-xl" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-5 w-44" />
          <Skeleton className="h-3.5 w-64" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="oc-surface-card flex flex-col gap-3 rounded-xl p-4">
            <Skeleton className="h-3.5 w-20" />
            <Skeleton className="h-7 w-28" />
            <Skeleton className="h-3 w-16" />
          </div>
        ))}
      </div>
      <div className="oc-surface-card rounded-xl p-4">
        <Skeleton className="h-64 w-full rounded-lg" />
      </div>
    </div>
  );
}

/** 品牌标头（桌面侧栏与移动抽屉共用）。 */
function BrandMarkHeader({
  collapsed = false,
  action,
}: {
  collapsed?: boolean;
  action?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex h-14 shrink-0 items-center border-b border-border/70",
        collapsed ? "justify-center px-2" : "gap-2.5 px-4",
      )}
    >
      <span
        className="oc-btn-accent-craft flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-fg"
        aria-hidden="true"
      >
        <Shield size={16} strokeWidth={2.1} />
      </span>
      {!collapsed && (
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-section font-semibold tracking-tight text-fg">
              管理后台
            </span>
            <span className="oc-badge-craft rounded-full bg-accent-soft px-1.5 py-0.5 text-micro font-semibold uppercase tracking-wider text-accent">
              Admin
            </span>
          </div>
        </div>
      )}
      {action}
    </div>
  );
}

function useGovernanceNavProbe(user: User | null): { enabled: boolean; pendingCount: number } {
  const [enabled, setEnabled] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const userId = user?.id != null ? String(user.id) : "";
  useEffect(() => {
    // B8: 仅对个人版管理员 uid=3 在会话挂载后探测一次，非 uid3 零探测请求；切 tab 不重复探测。
    if (userId !== "3") {
      setEnabled(false);
      setPendingCount(0);
      return undefined;
    }
    const controller = new AbortController();
    void getGovernanceOverview(adminSession, controller.signal)
      .then((overview) => {
        if (controller.signal.aborted) return;
        const ok = Boolean(overview?.enabled);
        setEnabled(ok);
        setPendingCount(ok && Array.isArray(overview?.pendingApprovals) ? overview.pendingApprovals.length : 0);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (err instanceof ApiError && (err.status === 404 || err.status === 403)) {
          setEnabled(false);
          setPendingCount(0);
        }
      });
    return () => controller.abort();
  }, [userId]);
  return { enabled, pendingCount };
}

function NavItem({
  page: p,
  active,
  collapsed,
  pendingBadge,
  onNavigate,
}: {
  page: ReturnType<typeof getVisibleAdminGroups>[number]["pages"][number];
  active: boolean;
  collapsed: boolean;
  pendingBadge: number;
  onNavigate: (tab: string) => void;
}) {
  const Icon = p.icon;
  const badgeText = pendingBadge > 99 ? "99+" : String(pendingBadge);
  const tooltip = pendingBadge > 0
    ? `${p.title}（${pendingBadge} 项待拍板）${p.desc ? ` · ${p.desc}` : ""}`
    : collapsed
      ? `${p.title}${p.desc ? ` · ${p.desc}` : ""}`
      : p.desc;
  return (
    <button
      type="button"
      onClick={() => onNavigate(p.key)}
      aria-current={active ? "page" : undefined}
      title={tooltip}
      className={cn(
        "oc-btn-tactile group relative flex items-center rounded-lg text-left text-body outline-none transition-all focus-visible:ring-2 focus-visible:ring-ring",
        collapsed ? "justify-center p-1.5" : "gap-2.5 px-2 py-1.5",
        active ? "bg-sidebar-active font-semibold text-fg shadow-sidebar-active" : "font-medium text-muted hover:bg-hover hover:text-fg",
      )}
    >
      {active && !collapsed && (
        <span aria-hidden="true" className="absolute inset-y-1.5 left-0 w-[3px] rounded-r-full bg-accent" />
      )}
      <span
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-md transition-colors",
          active ? "oc-icon-badge oc-icon-badge-accent" : "text-muted group-hover:bg-hover/80 group-hover:text-fg",
        )}
      >
        <Icon size={15} strokeWidth={active ? 2.1 : 1.85} className="shrink-0" />
      </span>
      {!collapsed && <span className="min-w-0 flex-1 truncate">{p.title}</span>}
      {pendingBadge > 0 &&
        (collapsed ? (
          <span aria-label={`${pendingBadge} 项待拍板`} className="absolute right-1 top-1 size-2 rounded-full bg-danger" />
        ) : (
          <Badge tone="danger" size="sm" aria-label={`${pendingBadge} 项待拍板`} className="ml-auto shrink-0 tabular-nums">
            {badgeText}
          </Badge>
        ))}
    </button>
  );
}

/** 分组导航列表（桌面 sidebar 与移动 Sheet 抽屉共用）。 */
function NavList({
  activeTab,
  onNavigate,
  collapsed = false,
  governanceEnabled = false,
  governancePendingCount = 0,
}: {
  activeTab: string;
  onNavigate: (tab: string) => void;
  collapsed?: boolean;
  governanceEnabled?: boolean;
  governancePendingCount?: number;
}) {
  const visibleGroups = getVisibleAdminGroups({ selfhostGovernance: governanceEnabled })
    .filter(({ pages }) => pages.length > 0);

  return (
    <nav aria-label="管理导航" className={cn("flex flex-col", collapsed ? "gap-3 px-2 py-3" : "gap-4 px-2.5 py-3.5")}>
      {visibleGroups.map(({ group, pages }, groupIndex) => (
        <div key={group} className="flex flex-col gap-0.5">
          {collapsed ? (
            groupIndex > 0 && <div className="mx-2 my-1 h-px bg-border/80" aria-hidden="true" />
          ) : (
            <p className="px-2.5 pb-1 pt-0.5 text-caption font-semibold uppercase tracking-wider text-faint">{group}</p>
          )}
          {pages.map((p) => (
            <NavItem
              key={p.key}
              page={p}
              active={p.key === activeTab}
              collapsed={collapsed}
              pendingBadge={p.key === "governance" ? governancePendingCount : 0}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      ))}
    </nav>
  );
}

/** 侧栏底部：用户卡片 + 回到对话 + 主题 + 登出。主题为受控（唯一权威在 AdminShell）。 */
function SidebarFooter({
  user,
  onLogout,
  theme,
  onCycleTheme,
  collapsed = false,
}: {
  user: User | null;
  onLogout: () => void;
  theme: Theme;
  onCycleTheme: () => void;
  collapsed?: boolean;
}) {
  const displayName = user?.displayName?.trim() || "";
  const email = user?.email?.trim() || "";
  const name = displayName || email || "管理员";
  const subtitle =
    displayName && email && displayName.toLowerCase() !== email.toLowerCase()
      ? email
      : "系统管理员";
  const initial = name.slice(0, 1).toUpperCase();

  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-1.5 border-t border-border/70 px-2 py-3">
        <span className="oc-avatar-ring rounded-full" title={`${name} (${subtitle})`}>
          <Avatar size="sm" src={user?.avatarUrl ?? undefined} fallback={initial} />
        </span>
        <a
          href="/"
          title="回到对话"
          aria-label="回到对话"
          className="oc-icon-btn-tactile flex size-8 items-center justify-center rounded-lg text-muted outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
        >
          <MessageSquare size={16} />
        </a>
        <ThemeToggle theme={theme} onCycle={onCycleTheme} />
        <IconButton onClick={onLogout} title="登出" aria-label="登出" variant="danger" shape="square">
          <LogOut size={16} />
        </IconButton>
      </div>
    );
  }

  return (
    <div className="border-t border-border/70 p-2.5">
      <div className="oc-surface-card rounded-xl p-2.5">
        <div className="flex items-center gap-2.5">
          <span className="oc-avatar-ring shrink-0 rounded-full">
            <Avatar size="sm" src={user?.avatarUrl ?? undefined} fallback={initial} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-body font-semibold text-fg">{name}</p>
            <p className="truncate text-caption text-faint">{subtitle}</p>
          </div>
        </div>
        <div className="mt-2.5 flex items-center gap-1.5 border-t border-border/60 pt-2">
          <a
            href="/"
            title="回到对话"
            className="oc-btn-tactile oc-btn-secondary-craft flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg px-2.5 text-meta font-medium text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <MessageSquare size={14} className="shrink-0 text-accent" />
            <span className="truncate">回到对话</span>
          </a>
          <ThemeToggle theme={theme} onCycle={onCycleTheme} />
          <IconButton onClick={onLogout} title="登出" aria-label="登出" variant="danger" shape="square">
            <LogOut size={16} />
          </IconButton>
        </div>
      </div>
    </div>
  );
}

/**
 * 管理后台外壳。
 *  - 桌面(md+)：左侧可折叠 sidebar（品牌标头 + 分组导航 + 浮起选中卡与陶土饰条 + 底部用户卡）+ 顶部磨砂上下文条。
 *  - 移动(<768px)：顶部磨砂栏（汉堡 + 当前页图标与标题）+ Sheet 抽屉导航。
 * 内容区 max-w 约束 + 独立纵向滚动；页面懒块经 LazyBoundary（Suspense + chunk 失败兜底）。
 */
export function AdminShell({ user, onLogout }: { user: User | null; onLogout: () => void }) {
  const gov = useGovernanceNavProbe(user);
  const { tab, navigate } = useAdminRoute({ selfhostGovernance: gov.enabled });
  // 主题唯一权威源:本处调一次 useTheme,下传给桌面/移动两处 footer,避免两套并行镜像。
  const { theme, cycle } = useTheme();
  const [navOpen, setNavOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const page = getVisibleAdminPage(tab, { selfhostGovernance: gov.enabled });
  const PageComponent = page.Component;
  const PageIcon = page.icon;

  const go = (next: string) => { navigate(next); setNavOpen(false); };

  return (
    <div className="flex h-dvh overflow-hidden bg-bg text-fg">
      {/* 桌面 sidebar */}
      <aside
        className={cn(
          "hidden shrink-0 flex-col border-r border-border bg-sidebar transition-[width] duration-200 ease-out md:flex",
          collapsed ? "w-[68px]" : "w-64",
        )}
      >
        <BrandMarkHeader
          collapsed={collapsed}
          action={
            !collapsed ? (
              <IconButton
                onClick={() => setCollapsed(true)}
                title="收起导航栏"
                aria-label="收起导航栏"
                shape="square"
                className="oc-icon-btn-tactile size-7 text-muted hover:text-fg"
              >
                <PanelLeftClose size={15} />
              </IconButton>
            ) : undefined
          }
        />
        {collapsed && (
          <div className="flex justify-center border-b border-border/60 py-1.5">
            <IconButton
              onClick={() => setCollapsed(false)}
              title="展开导航栏"
              aria-label="展开导航栏"
              shape="square"
              className="oc-icon-btn-tactile size-8 text-muted hover:text-fg"
            >
              <PanelLeftOpen size={15} />
            </IconButton>
          </div>
        )}
        <div className="sidebar-scroll-fade min-h-0 flex-1 overflow-y-auto">
          <NavList activeTab={tab} onNavigate={go} collapsed={collapsed} governanceEnabled={gov.enabled} governancePendingCount={gov.pendingCount} />
        </div>
        <SidebarFooter
          user={user}
          onLogout={onLogout}
          theme={theme}
          onCycleTheme={cycle}
          collapsed={collapsed}
        />
      </aside>

      {/* 移动抽屉 */}
      <Sheet open={navOpen} onOpenChange={setNavOpen} side="left" srTitle="管理导航" overlayClassName="md:hidden">
        <BrandMarkHeader
          action={
            <IconButton
              onClick={() => setNavOpen(false)}
              title="关闭导航"
              aria-label="关闭导航"
              shape="square"
              className="ml-auto size-11"
            >
              <X size={18} />
            </IconButton>
          }
        />
        <div className="sidebar-scroll-fade min-h-0 flex-1 overflow-y-auto">
          <NavList activeTab={tab} onNavigate={go} governanceEnabled={gov.enabled} governancePendingCount={gov.pendingCount} />
        </div>
        <SidebarFooter user={user} onLogout={onLogout} theme={theme} onCycleTheme={cycle} />
      </Sheet>

      {/* 内容区 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 顶部磨砂操作条（桌面 + 移动统一材质语言） */}
        <header className="oc-surface-glass sticky top-0 z-20 flex h-14 shrink-0 items-center justify-between gap-3 border-x-0 border-t-0 px-3 md:px-8">
          <div className="flex min-w-0 items-center gap-2.5">
            <IconButton
              onClick={() => setNavOpen(true)}
              title="导航"
              aria-label="打开导航"
              shape="square"
              className="md:hidden"
            >
              <Menu size={18} />
            </IconButton>
            {PageIcon && (
              <span className="oc-icon-badge oc-icon-badge-accent hidden size-7 rounded-md sm:inline-flex">
                <PageIcon size={14} strokeWidth={2} />
              </span>
            )}
            <div className="flex min-w-0 items-center gap-1.5">
              {page.group && (
                <>
                  <span className="hidden text-meta font-medium text-faint lg:inline">
                    {page.group}
                  </span>
                  <ChevronRight size={13} className="hidden shrink-0 text-faint/70 lg:inline" />
                </>
              )}
              <span className="truncate text-title font-semibold tracking-tight text-fg">
                {page.title}
              </span>
              {page.desc && (
                <span className="hidden truncate border-l border-border pl-2.5 text-meta text-muted xl:inline">
                  {page.desc}
                </span>
              )}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <a
              href="/"
              className="oc-btn-tactile oc-btn-secondary-craft hidden h-8 items-center gap-1.5 rounded-lg px-2.5 text-meta font-medium text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring md:inline-flex"
            >
              <MessageSquare size={13.5} className="text-accent" />
              <span>返回工作台</span>
            </a>
            <div className="md:hidden">
              <ThemeToggle theme={theme} onCycle={cycle} />
            </div>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[1440px] px-4 py-6 md:px-8 md:py-7">
            {/* key=tab 同时给边界：某页渲染崩溃只拦住该页，切到别的 tab 时边界随之重置。 */}
            <LazyBoundary key={tab} fallback={<PageSkeleton />}>
              {/* key=tab：切页强制重挂载，页面各自的 useAdminPoll/图表得到干净生命周期。 */}
              <PageComponent key={tab} />
            </LazyBoundary>
          </div>
        </main>
      </div>
    </div>
  );
}
