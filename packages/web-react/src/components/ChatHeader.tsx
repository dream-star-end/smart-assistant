import type { CursorContextTier } from "@openclaude/protocol";
import { Bell, ChevronDown, Download, Menu, PanelLeft, PenSquare, Search, ShieldCheck, Users, Wallet } from "lucide-react";
import { useState } from "react";
import type { Agent } from "../lib/agents";
import type { PreferenceEffort } from "../lib/modelPreferences";
import { PRODUCT_CAPABILITIES } from "../lib/productCapabilities";
import type { LockedPublicModel, PublicModel } from "../lib/types";
import { cn, formatCredits } from "../lib/utils";
import { AgentAvatar } from "./AgentAvatar";
import { type LockedSelectInfo, ModelSelector, teamEngineLabel } from "./ModelSelector";
import { Button, IconButton, Popover, PopoverContent, PopoverTrigger } from "./ui";

export function ChatHeader({
  agent,
  onAgentClick,
  models,
  lockedModels,
  selectedModelId,
  onSelectModel,
  onLockedSelect,
  modelsLoading,
  effortSupported,
  effortActive,
  onSelectEffort,
  contextTier,
  onSelectContextTier,
  modelPickerOpen,
  onModelPickerOpenChange,
  teamModeActive,
  onDisableTeamMode,
  advisorModeActive,
  advisorModelLabel,
  onDisableAdvisorMode,
  credits,
  onOpenBilling,
  sidebarCollapsed,
  onExpandSidebar,
  onNew,
  onOpenMobileNav,
  onOpenInbox,
  onOpenFind,
  onExport,
  unreadCount,
  sessionUnreadCount,
  projectBreadcrumb,
  onOpenProjectScope,
}: {
  agent: Agent;
  onAgentClick: () => void;
  /** 对话模型列表（GET /api/public/models 驱动；省略则不渲染选择器）。 */
  models?: PublicModel[];
  /** 订阅门槛锁定行；永不并入 models。 */
  lockedModels?: LockedPublicModel[];
  selectedModelId?: string;
  onSelectModel?: (id: string) => void;
  onLockedSelect?: (info: LockedSelectInfo) => void;
  modelsLoading?: boolean;
  /** 当前执行模型支持的思考档位（空/省略 = 模型不暴露档位,菜单内不渲染档位区块）。 */
  effortSupported?: readonly string[];
  /** 当前生效思考档（null/undefined = 跟随模型默认）。 */
  effortActive?: PreferenceEffort | null;
  /** 选择思考档；null = 跟随模型默认。透传给模型菜单的二级档位区块。 */
  onSelectEffort?: (value: PreferenceEffort | null) => void;
  /** Cursor Opus/Fable 上下文档位(300k 默认 / 1M);透传给模型菜单的「上下文」区块。 */
  contextTier?: CursorContextTier | null;
  onSelectContextTier?: (tier: CursorContextTier) => void;
  modelPickerOpen?: boolean;
  onModelPickerOpenChange?: (v: boolean) => void;
  /**
   * 团队模式已开启且当前会话是 main（队长引擎覆盖生效）。true 时 agent 名旁显示
   * 「团队模式」chip（点击弹说明 + 关闭入口），并让 ModelSelector 切换到如实的
   * 队长引擎显示态。条件由 App 的 teamMode 单一状态推导，此处不持第二份状态。
   */
  teamModeActive?: boolean;
  /** 关闭团队模式（直接翻转 App 的全局 flag；省略则 chip 弹层不渲染关闭按钮）。 */
  onDisableTeamMode?: () => void;
  advisorModeActive?: boolean;
  /** Frozen advisor model id from server config, not the chat model selector. */
  advisorModelLabel?: string | null;
  onDisableAdvisorMode?: () => void;
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
  /** 打开会话内查找条（省略则不渲染查找键，如 demo）。按钮常驻，不随查找条开关挂卸载。 */
  onOpenFind?: () => void;
  /** 导出会话为 Markdown（省略则不渲染，如 demo）。窄屏隐藏以免挤顶栏。 */
  onExport?: () => void;
  /** 站内信未读数（>0 显红点，>99 显 99+）。 */
  unreadCount?: number;
  /** 会话未读数（侧栏折叠/移动抽屉入口角标）。与站内信 unreadCount 并存、语义不同。 */
  sessionUnreadCount?: number;
  projectBreadcrumb?: { chatName?: string | null; workName?: string | null } | null;
  onOpenProjectScope?: () => void;
}) {
  const low = credits != null && (credits.trim().startsWith("-") || /^-?0+$/.test(credits.trim()));
  // 团队模式说明弹层的受控开关：点「关闭团队模式」需要主动收起弹层（chip 随
  // teamModeActive 翻 false 一起卸载,不控 open 会留下无锚点的浮层）。
  const [teamPopoverOpen, setTeamPopoverOpen] = useState(false);
  const [advisorPopoverOpen, setAdvisorPopoverOpen] = useState(false);
  const engineLabel = teamEngineLabel(models ?? []);
  return (
    <header
      className="flex min-h-14 shrink-0 flex-wrap items-center gap-1 px-2 pb-2 header-safe-t sm:flex-nowrap sm:px-3 sm:pb-2.5"
      data-product-entry-scope="chat-header"
    >
      {/* 移动端汉堡：窄屏始终可见，打开侧栏抽屉。 */}
      {onOpenMobileNav && (
        <div className="relative shrink-0 md:hidden">
          <IconButton
            data-product-control
            onClick={onOpenMobileNav}
            aria-label={
              sessionUnreadCount && sessionUnreadCount > 0
                ? `打开菜单,${sessionUnreadCount} 条未读会话`
                : "打开菜单"
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
      {/* 桌面折叠态：展开 + 新建（仅 md+，移动端用抽屉）。 */}
      {sidebarCollapsed && (
        <div className="hidden items-center gap-1 md:flex">
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
          <IconButton data-product-feature={PRODUCT_CAPABILITIES.chatBasics.id} onClick={onNew} aria-label="新建会话" shape="square">
            <PenSquare size={18} />
          </IconButton>
        </div>
      )}
      <button
        data-product-feature={PRODUCT_CAPABILITIES.agents.id}
        onClick={onAgentClick}
        aria-label={`切换智能体，当前${agent.name}`}
        className="flex min-h-11 min-w-0 flex-1 items-center gap-1.5 rounded-xl px-1 py-1.5 sm:flex-initial sm:px-2.5 outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg active:scale-[0.98]"
      >
        <AgentAvatar agent={agent} className="size-7 shrink-0 rounded-lg" iconSize={15} />
        {/* 窄屏不折行：截断而非换行（避免"全能/助手"难看的两行）。 */}
        <span className="max-w-[7.5rem] truncate whitespace-nowrap text-title font-semibold text-fg sm:max-w-none">
          {agent.name}
        </span>
        <ChevronDown size={15} className="hidden shrink-0 text-faint sm:block" />
      </button>
      {projectBreadcrumb && (projectBreadcrumb.chatName || projectBreadcrumb.workName) ? (
        <button
          type="button"
          data-testid="chat-project-breadcrumb"
          data-product-control="project-breadcrumb"
          onClick={onOpenProjectScope}
          className="hidden min-w-0 max-w-[14rem] truncate rounded-lg px-2 py-1 text-caption text-muted outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring sm:inline-block"
          title={[projectBreadcrumb.workName, projectBreadcrumb.chatName].filter(Boolean).join(" / ")}
        >
          {[projectBreadcrumb.workName, projectBreadcrumb.chatName].filter(Boolean).join(" / ")}
        </button>
      ) : null}
      {(teamModeActive || advisorModeActive || (models && onSelectModel)) && (
        <div className="order-last flex min-w-0 basis-full items-center gap-1 rounded-xl bg-hover/50 sm:order-none sm:flex-1 sm:basis-auto sm:bg-transparent" data-testid="chat-model-row">
          {/* 团队模式可见指示:开启期间常驻 agent 名旁(弹窗外唯一的知情入口),
              点击弹说明 + 一键关闭。仅 main 会话(teamModeActive)显示。 */}
          {advisorModeActive && (
            <Popover open={advisorPopoverOpen} onOpenChange={setAdvisorPopoverOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  data-product-feature={PRODUCT_CAPABILITIES.advisorMode.id}
                  aria-label="顾问模式已开启"
                  className="flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-caption font-medium text-accent outline-none transition-colors hover:bg-accent/15 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg active:scale-[0.98]"
                >
                  <ShieldCheck size={11} className="shrink-0" />
                  <span className="sm:hidden">顾问</span>
                  <span className="hidden sm:inline">顾问模式</span>
                  {advisorModelLabel ? (
                    <span className="hidden max-w-[8rem] truncate sm:inline" title={advisorModelLabel}>
                      · {advisorModelLabel}
                    </span>
                  ) : null}
                </button>
              </PopoverTrigger>
              <PopoverContent>
                <p className="text-[12.5px] leading-relaxed text-muted">
                  顾问模式已开启：主模型不切换
                  {advisorModelLabel ? `；本回合冻结顾问 ${advisorModelLabel}` : ""}
                  。主模型可通过 consult_advisor 向无工具顾问提问；建议必须自行验证，不能替代审批或正式审查员。咨询按实际顾问型号计费，不承诺更省。
                </p>
                {onDisableAdvisorMode && (
                  <Button
                    data-product-control
                    size="sm"
                    variant="secondary"
                    className="mt-2.5 w-full"
                    onClick={() => {
                      setAdvisorPopoverOpen(false);
                      onDisableAdvisorMode();
                    }}
                  >
                    关闭顾问模式
                  </Button>
                )}
              </PopoverContent>
            </Popover>
          )}
          {teamModeActive && (
            <Popover open={teamPopoverOpen} onOpenChange={setTeamPopoverOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  data-product-feature={PRODUCT_CAPABILITIES.teamMode.id}
                  aria-label="团队模式已开启"
                  className="flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-caption font-medium text-accent outline-none transition-colors hover:bg-accent/15 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg active:scale-[0.98]"
                >
                  <Users size={11} className="shrink-0" />
                  {/* 窄屏给「团队」二字；sm+ 仍用全称，桌面既有断言不红。 */}
                  <span className="sm:hidden">团队</span>
                  <span className="hidden sm:inline">团队模式</span>
                </button>
              </PopoverTrigger>
              <PopoverContent>
                <p className="text-[12.5px] leading-relaxed text-muted">
                  团队模式已开启：队长引擎为 {engineLabel}（计费高于默认模型），并会按需委派已安装智能体协作、按对应模型计费。
                </p>
                {onDisableTeamMode && (
                  <Button
                    data-product-control
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
              lockedModels={lockedModels}
              selectedId={selectedModelId}
              onSelect={onSelectModel}
              onLockedSelect={onLockedSelect}
              loading={modelsLoading}
              teamEngineActive={teamModeActive}
              effortSupported={effortSupported}
              effortActive={effortActive}
              onSelectEffort={onSelectEffort}
              contextTier={contextTier}
              onSelectContextTier={onSelectContextTier}
              open={modelPickerOpen}
              onOpenChange={onModelPickerOpenChange}
            />
          )}
        </div>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-0 sm:gap-1.5">
        {onOpenFind && (
          <IconButton
            data-product-control
            onClick={onOpenFind}
            aria-label="会话内查找"
            title="会话内查找 (⌘F)"
            shape="square"
          >
            <Search size={18} />
          </IconButton>
        )}
        {onExport && (
          <IconButton
            data-product-control
            onClick={onExport}
            aria-label="导出会话"
            title="导出会话"
            shape="square"
            className="hidden sm:flex"
          >
            <Download size={18} />
          </IconButton>
        )}
        {onOpenInbox && (
          <div className="relative">
            <IconButton data-product-feature={PRODUCT_CAPABILITIES.inbox.id} onClick={onOpenInbox} aria-label="站内信" shape="square">
              <Bell size={18} />
            </IconButton>
            <HeaderCountBadge count={unreadCount} tone="danger" />
          </div>
        )}
        {credits != null && (
          <button
            data-product-feature={PRODUCT_CAPABILITIES.billing.id}
            onClick={onOpenBilling}
            disabled={!onOpenBilling}
            aria-label="账户与计费"
            className={`flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-full border px-2 py-1 text-meta font-medium tabular-nums outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg sm:px-2.5 ${
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
      </div>
    </header>
  );
}

/** 顶栏角标：站内信 danger、会话未读 accent。count 缺省或 ≤0 不占位。 */
function HeaderCountBadge({
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
        "pointer-events-none absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none text-white tabular-nums",
        tone === "accent" ? "bg-accent" : "bg-danger",
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
