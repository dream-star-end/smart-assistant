import { Bell, ChevronDown, Menu, PanelLeft, PenSquare, Users, Wallet } from "lucide-react";
import { useState } from "react";
import type { Theme } from "../hooks/useTheme";
import type { Agent } from "../lib/agents";
import { AgentAvatar } from "./AgentAvatar";
import type { PublicModel } from "../lib/types";
import { formatCredits } from "../lib/utils";
import { ModelSelector, teamEngineLabel } from "./ModelSelector";
import { ThemeToggle } from "./ThemeToggle";
import { Button, IconButton, Popover, PopoverContent, PopoverTrigger } from "./ui";

export function ChatHeader({
  agent,
  onAgentClick,
  models,
  selectedModelId,
  onSelectModel,
  modelsLoading,
  teamModeActive,
  onDisableTeamMode,
  credits,
  onOpenBilling,
  sidebarCollapsed,
  onExpandSidebar,
  onNew,
  onOpenMobileNav,
  onOpenInbox,
  unreadCount,
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
  /**
   * 团队模式已开启且当前会话是 main（队长引擎覆盖生效）。true 时 agent 名旁显示
   * 「团队模式」chip（点击弹说明 + 关闭入口），并让 ModelSelector 切换到如实的
   * 队长引擎显示态。条件由 App 的 teamMode 单一状态推导，此处不持第二份状态。
   */
  teamModeActive?: boolean;
  /** 关闭团队模式（直接翻转 App 的全局 flag；省略则 chip 弹层不渲染关闭按钮）。 */
  onDisableTeamMode?: () => void;
  /** 账户余额（积分字符串大数，来自 /api/me）。省略 / null 不渲染 pill。 */
  credits?: string | null;
  /** 点击 balance-pill 打开计费面板（省略则 pill 不可点）。 */
  onOpenBilling?: () => void;
  sidebarCollapsed?: boolean;
  onExpandSidebar?: () => void;
  onNew?: () => void;
  /** 移动端打开侧栏抽屉（窄屏侧栏不内联）。 */
  onOpenMobileNav?: () => void;
  /** 打开站内信面板（省略则不渲染铃铛，如 demo / 未登录）。 */
  onOpenInbox?: () => void;
  /** 站内信未读数（>0 显红点，>99 显 99+）。 */
  unreadCount?: number;
  theme: Theme;
  onCycleTheme: () => void;
}) {
  const low = credits != null && (credits.trim().startsWith("-") || /^-?0+$/.test(credits.trim()));
  // 团队模式说明弹层的受控开关：点「关闭团队模式」需要主动收起弹层（chip 随
  // teamModeActive 翻 false 一起卸载,不控 open 会留下无锚点的浮层）。
  const [teamPopoverOpen, setTeamPopoverOpen] = useState(false);
  const engineLabel = teamEngineLabel(models ?? []);
  return (
    <header className="flex h-14 shrink-0 items-center gap-1 px-3 pb-2.5 header-safe-t">
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
        className="flex min-w-0 items-center gap-2 rounded-xl px-2.5 py-1.5 outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg active:scale-[0.98]"
      >
        <AgentAvatar agent={agent} className="size-7 rounded-lg" iconSize={15} />
        {/* 窄屏不折行：截断而非换行（避免"全能/助手"难看的两行）。 */}
        <span className="max-w-[7.5rem] truncate whitespace-nowrap text-[15px] font-semibold text-fg sm:max-w-none">
          {agent.name}
        </span>
        <ChevronDown size={15} className="shrink-0 text-faint" />
      </button>
      {/* 团队模式可见指示:开启期间常驻 agent 名旁(弹窗外唯一的知情入口),
          点击弹说明 + 一键关闭。仅 main 会话(teamModeActive)显示。 */}
      {teamModeActive && (
        <Popover open={teamPopoverOpen} onOpenChange={setTeamPopoverOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="团队模式已开启"
              className="flex shrink-0 items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent outline-none transition-colors hover:bg-accent/15 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg active:scale-[0.98]"
            >
              <Users size={11} className="shrink-0" />
              团队模式
            </button>
          </PopoverTrigger>
          <PopoverContent>
            <p className="text-[12.5px] leading-relaxed text-muted">
              团队模式已开启：队长引擎为 {engineLabel}（计费高于默认模型），并会按需委派已安装智能体协作、按对应模型计费。
            </p>
            {onDisableTeamMode && (
              <Button
                size="sm"
                variant="secondary"
                className="mt-2.5 w-full"
                onClick={() => {
                  setTeamPopoverOpen(false);
                  onDisableTeamMode();
                }}
              >
                关闭团队模式
              </Button>
            )}
          </PopoverContent>
        </Popover>
      )}
      {models && onSelectModel && (
        <ModelSelector
          models={models}
          selectedId={selectedModelId}
          onSelect={onSelectModel}
          loading={modelsLoading}
          teamEngineActive={teamModeActive}
        />
      )}
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {onOpenInbox && (
          <div className="relative">
            <IconButton onClick={onOpenInbox} aria-label="站内信" shape="square">
              <Bell size={18} />
            </IconButton>
            {!!unreadCount && unreadCount > 0 && (
              <span className="pointer-events-none absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-none text-white tabular-nums">
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
          </div>
        )}
        {credits != null && (
          <button
            onClick={onOpenBilling}
            disabled={!onOpenBilling}
            aria-label="账户与计费"
            className={`flex items-center gap-1.5 rounded-full border px-2 py-1 text-[12.5px] font-medium tabular-nums outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg sm:px-2.5 ${
              low
                ? "border-danger/40 bg-danger-soft text-danger hover:bg-danger-soft"
                : "border-border text-muted enabled:hover:bg-hover enabled:hover:text-fg"
            } disabled:cursor-default`}
          >
            <Wallet size={13} className="shrink-0" />
            {/* 窄屏只留图标（点击进设置看余额），省出空间避免顶栏溢出/主题被裁。 */}
            <span className="hidden sm:inline">{formatCredits(credits)}</span>
          </button>
        )}
        <ThemeToggle theme={theme} onCycle={onCycleTheme} />
      </div>
    </header>
  );
}
