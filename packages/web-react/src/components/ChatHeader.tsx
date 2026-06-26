import { ChevronDown, Menu, PanelLeft, PenSquare } from "lucide-react";
import type { Theme } from "../hooks/useTheme";
import type { Agent } from "../lib/agents";
import { ThemeToggle } from "./ThemeToggle";
import { IconButton } from "./ui";

export function ChatHeader({
  agent,
  onAgentClick,
  sidebarCollapsed,
  onExpandSidebar,
  onNew,
  onOpenMobileNav,
  theme,
  onCycleTheme,
}: {
  agent: Agent;
  onAgentClick: () => void;
  sidebarCollapsed?: boolean;
  onExpandSidebar?: () => void;
  onNew?: () => void;
  /** 移动端打开侧栏抽屉（窄屏侧栏不内联）。 */
  onOpenMobileNav?: () => void;
  theme: Theme;
  onCycleTheme: () => void;
}) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-1 px-3 py-2.5">
      {/* 移动端汉堡：窄屏始终可见，打开侧栏抽屉。 */}
      {onOpenMobileNav && (
        <IconButton onClick={onOpenMobileNav} aria-label="打开菜单" shape="square" className="md:hidden">
          <Menu size={18} />
        </IconButton>
      )}
      {/* 桌面折叠态：展开 + 新建（仅 md+，移动端用抽屉）。 */}
      {sidebarCollapsed && (
        <div className="hidden items-center gap-1 md:flex">
          <IconButton onClick={onExpandSidebar} aria-label="展开侧栏" shape="square">
            <PanelLeft size={18} />
          </IconButton>
          <IconButton onClick={onNew} aria-label="新建会话" shape="square">
            <PenSquare size={18} />
          </IconButton>
        </div>
      )}
      <button
        onClick={onAgentClick}
        className="flex items-center gap-2 rounded-xl px-2.5 py-1.5 outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg active:scale-[0.98]"
      >
        <span
          className={`flex size-7 items-center justify-center rounded-lg bg-gradient-to-br ${agent.grad} text-white`}
        >
          <agent.icon size={15} />
        </span>
        <span className="text-[15px] font-semibold text-fg">{agent.name}</span>
        <ChevronDown size={15} className="text-faint" />
      </button>
      <div className="ml-auto flex items-center gap-0.5">
        <ThemeToggle theme={theme} onCycle={onCycleTheme} />
      </div>
    </header>
  );
}
