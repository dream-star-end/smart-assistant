import { LogOut, Menu, MessageSquare } from "lucide-react";
import { useState } from "react";
import { LazyBoundary } from "../components/ChunkErrorBoundary";
import { ThemeToggle } from "../components/ThemeToggle";
import { Avatar, IconButton, Sheet, Skeleton } from "../components/ui";
import { type Theme, useTheme } from "../hooks/useTheme";
import { cn } from "../lib/utils";
import type { User } from "../lib/types";
import { adminGroups, getAdminPage } from "./registry";
import { useAdminRoute } from "./router";

/** 懒块下载期的页面骨架（LazyBoundary fallback）。 */
function PageSkeleton() {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-64" />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-64 rounded-xl" />
    </div>
  );
}

/** 分组导航列表（桌面 sidebar 与移动 Sheet 抽屉共用）。 */
function NavList({
  activeTab,
  onNavigate,
}: {
  activeTab: string;
  onNavigate: (tab: string) => void;
}) {
  return (
    <nav className="flex flex-col gap-5 px-3 py-4">
      {adminGroups.map(({ group, pages }) => (
        <div key={group} className="flex flex-col gap-0.5">
          <p className="px-2.5 pb-1 text-[11px] font-medium uppercase tracking-wide text-faint">
            {group}
          </p>
          {pages.map((p) => {
            const Icon = p.icon;
            const active = p.key === activeTab;
            return (
              <button
                key={p.key}
                type="button"
                onClick={() => onNavigate(p.key)}
                aria-current={active ? "page" : undefined}
                title={p.desc}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  active
                    ? "bg-accent-soft text-accent"
                    : "text-muted hover:bg-hover hover:text-fg",
                )}
              >
                <Icon size={16} className="shrink-0" />
                <span className="truncate">{p.title}</span>
              </button>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

/** 侧栏底部：用户 chip + 回到对话 + 主题 + 登出。主题为受控（唯一权威在 AdminShell）。 */
function SidebarFooter({
  user,
  onLogout,
  theme,
  onCycleTheme,
}: {
  user: User | null;
  onLogout: () => void;
  theme: Theme;
  onCycleTheme: () => void;
}) {
  const name = user?.displayName || user?.email || "管理员";
  const initial = name.slice(0, 1).toUpperCase();
  return (
    <div className="border-t border-border px-3 py-3">
      <div className="flex items-center gap-2.5 px-1">
        <Avatar size="sm" src={user?.avatarUrl ?? undefined} fallback={initial} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-fg">{name}</p>
          <p className="truncate text-[11px] text-faint">{user?.email ?? "管理员"}</p>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-1">
        <a
          href="/"
          title="回到对话"
          className="flex flex-1 items-center gap-2 rounded-lg px-2.5 py-2 text-[12.5px] font-medium text-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
        >
          <MessageSquare size={15} className="shrink-0" />
          <span className="truncate">回到对话</span>
        </a>
        <ThemeToggle theme={theme} onCycle={onCycleTheme} />
        <IconButton onClick={onLogout} title="登出" aria-label="登出" variant="danger" shape="square">
          <LogOut size={17} />
        </IconButton>
      </div>
    </div>
  );
}

/**
 * 管理后台外壳。
 *  - 桌面(md+)：左侧固定 sidebar（分组导航 + active 态 + 底部用户/主题/登出）。
 *  - 移动(<768px)：顶栏（汉堡 + 当前页标题）+ Sheet 抽屉导航。
 * 内容区 max-w 约束 + 独立纵向滚动；页面懒块经 LazyBoundary（Suspense + chunk 失败兜底）。
 */
export function AdminShell({ user, onLogout }: { user: User | null; onLogout: () => void }) {
  const { tab, navigate } = useAdminRoute();
  // 主题唯一权威源:本处调一次 useTheme,下传给桌面/移动两处 footer,避免两套并行镜像。
  const { theme, cycle } = useTheme();
  const [navOpen, setNavOpen] = useState(false);
  const page = getAdminPage(tab);
  const PageComponent = page.Component;

  const go = (next: string) => {
    navigate(next);
    setNavOpen(false);
  };

  return (
    <div className="flex h-dvh overflow-hidden bg-bg text-fg">
      {/* 桌面 sidebar */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-sidebar md:flex">
        <div className="flex h-14 items-center gap-2 px-4">
          <span className="flex size-7 items-center justify-center rounded-lg bg-grad-cta text-[13px] font-bold text-white">
            OC
          </span>
          <span className="text-[13px] font-semibold text-fg">管理后台</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <NavList activeTab={tab} onNavigate={go} />
        </div>
        <SidebarFooter user={user} onLogout={onLogout} theme={theme} onCycleTheme={cycle} />
      </aside>

      {/* 移动抽屉 */}
      <Sheet open={navOpen} onOpenChange={setNavOpen} side="left" srTitle="管理导航" overlayClassName="md:hidden">
        <div className="flex h-14 items-center gap-2 px-4">
          <span className="flex size-7 items-center justify-center rounded-lg bg-grad-cta text-[13px] font-bold text-white">
            OC
          </span>
          <span className="text-[13px] font-semibold text-fg">管理后台</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <NavList activeTab={tab} onNavigate={go} />
        </div>
        <SidebarFooter user={user} onLogout={onLogout} theme={theme} onCycleTheme={cycle} />
      </Sheet>

      {/* 内容区 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 移动顶栏 */}
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3 md:hidden">
          <IconButton onClick={() => setNavOpen(true)} title="导航" aria-label="打开导航" shape="square">
            <Menu size={18} />
          </IconButton>
          <span className="truncate text-[14px] font-semibold text-fg">{page.title}</span>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[1440px] px-4 py-6 md:px-8">
            <LazyBoundary fallback={<PageSkeleton />}>
              {/* key=tab：切页强制重挂载，页面各自的 useAdminPoll/图表得到干净生命周期。 */}
              <PageComponent key={tab} />
            </LazyBoundary>
          </div>
        </main>
      </div>
    </div>
  );
}
