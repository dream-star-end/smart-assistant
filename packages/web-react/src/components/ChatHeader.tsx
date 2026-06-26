import { ChevronDown, Menu, PanelLeft, PenSquare, Wallet } from "lucide-react";
import type { Theme } from "../hooks/useTheme";
import type { Agent } from "../lib/agents";
import type { PublicModel } from "../lib/types";
import { formatCredits } from "../lib/utils";
import { ModelSelector } from "./ModelSelector";
import { ThemeToggle } from "./ThemeToggle";
import { IconButton } from "./ui";

export function ChatHeader({
  agent,
  onAgentClick,
  models,
  selectedModelId,
  onSelectModel,
  modelsLoading,
  credits,
  onOpenBilling,
  sidebarCollapsed,
  onExpandSidebar,
  onNew,
  onOpenMobileNav,
  theme,
  onCycleTheme,
}: {
  agent: Agent;
  onAgentClick: () => void;
  /** 对话模型列表（GET /api/public/models 驱动；省略则不渲染选择器）。 */
  models?: PublicModel[];
  selectedModelId?: string;
  onSelectModel?: (id: string) => void;
  modelsLoading?: boolean;
  /** 账户余额（积分字符串大数，来自 /api/me）。省略 / null 不渲染 pill。 */
  credits?: string | null;
  /** 点击 balance-pill 打开计费面板（省略则 pill 不可点）。 */
  onOpenBilling?: () => void;
  sidebarCollapsed?: boolean;
  onExpandSidebar?: () => void;
  onNew?: () => void;
  /** 移动端打开侧栏抽屉（窄屏侧栏不内联）。 */
  onOpenMobileNav?: () => void;
  theme: Theme;
  onCycleTheme: () => void;
}) {
  const low = credits != null && (credits.trim().startsWith("-") || /^-?0+$/.test(credits.trim()));
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
      {models && onSelectModel && (
        <ModelSelector
          models={models}
          selectedId={selectedModelId}
          onSelect={onSelectModel}
          loading={modelsLoading}
        />
      )}
      <div className="ml-auto flex items-center gap-1.5">
        {credits != null && (
          <button
            onClick={onOpenBilling}
            disabled={!onOpenBilling}
            aria-label="账户与计费"
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12.5px] font-medium tabular-nums outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg ${
              low
                ? "border-danger/40 bg-danger-soft text-danger hover:bg-danger-soft"
                : "border-border text-muted enabled:hover:bg-hover enabled:hover:text-fg"
            } disabled:cursor-default`}
          >
            <Wallet size={13} />
            <span>{formatCredits(credits)}</span>
          </button>
        )}
        <ThemeToggle theme={theme} onCycle={onCycleTheme} />
      </div>
    </header>
  );
}
