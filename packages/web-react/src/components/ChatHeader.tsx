import type { CursorContextTier, ServiceTier } from "@openclaude/protocol/browser";
import {
  Bell,
  ChevronDown,
  FolderOpen,
  Loader2,
  MessageCircleQuestion,
  MoreHorizontal,
  PanelRight,
  PanelRightClose,
  PenSquare,
  Plus,
  RefreshCw,
  Search,
  Share2,
  ShieldCheck,
  Users,
  Wallet,
} from "lucide-react";
import { useState } from "react";
import type { Agent } from "../lib/agents";
import type { PreferenceEffort } from "../lib/modelPreferences";
import { PRODUCT_CAPABILITIES } from "../lib/productCapabilities";
import type { LockedPublicModel, PublicModel } from "../lib/types";
import { cn, formatCredits } from "../lib/utils";
import { AgentAvatar } from "./AgentAvatar";
import { type LockedSelectInfo, ModelSelector, teamEngineLabel } from "./ModelSelector";
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./ui";
import { HeaderCountBadge, WorkspaceShellHeader } from "./ui/WorkspaceShellHeader";

/** 快捷键修饰键按平台显示:Mac 系 ⌘,其余 Ctrl(C-24:Windows/Linux 用户此前看到的是 Mac 符号)。 */
export function modKeyLabel(): string {
  if (typeof navigator === "undefined") return "Ctrl+";
  const platform = `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`;
  return /Mac|iPhone|iPad|iPod/i.test(platform) ? "⌘" : "Ctrl+";
}

export function altKeyLabel(): string {
  if (typeof navigator === "undefined") return "Alt+";
  const platform = `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`;
  return /Mac|iPhone|iPad|iPod/i.test(platform) ? "⌥" : "Alt+";
}

export function ChatHeader({
  agent,
  onAgentClick,
  models,
  lockedModels,
  selectedModelId,
  onSelectModel,
  onLockedSelect,
  modelsLoading,
  onCancelModelSwitch,
  effortSupported,
  effortActive,
  onSelectEffort,
  contextTier,
  onSelectContextTier,
  serviceTier,
  onSelectServiceTier,
  modelPickerOpen,
  onModelPickerOpenChange,
  teamModeActive,
  teamLeaderModelId,
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
  onShare,
  onToggleQuickAsk,
  quickAskOpen = false,
  quickAskSending = false,
  onTogglePane,
  paneOpen = false,
  unreadCount,
  sessionUnreadCount,
  projectBreadcrumb,
  projectSuggestion,
  onOpenProjectScope,
  sessionTitle,
  running = false,
  updateAvailable = false,
  onReloadForUpdate,
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
  /** 压缩切换进行中时提供，放弃等待并保留原模型。 */
  onCancelModelSwitch?: () => void;
  /** 当前执行模型支持的思考档位（空/省略 = 模型不暴露档位,菜单内不渲染档位区块）。 */
  effortSupported?: readonly string[];
  /** 当前生效思考档（null/undefined = 跟随模型默认）。 */
  effortActive?: PreferenceEffort | null;
  /** 选择思考档；null = 跟随模型默认。透传给模型菜单的二级档位区块。 */
  onSelectEffort?: (value: PreferenceEffort | null) => void;
  /** Cursor Opus/Fable 上下文档位(300k 默认 / 1M);透传给模型菜单的「上下文」区块。 */
  contextTier?: CursorContextTier | null;
  onSelectContextTier?: (tier: CursorContextTier) => void;
  /** OCV5-434 GPT Fast(会话级,默认关)。 */
  serviceTier?: ServiceTier | null;
  onSelectServiceTier?: (tier: ServiceTier | null) => void;
  modelPickerOpen?: boolean;
  onModelPickerOpenChange?: (v: boolean) => void;
  /**
   * 团队模式已开启且当前会话是 main（队长引擎覆盖生效）。true 时 agent 名旁显示
   * 「团队模式」chip（点击弹说明 + 关闭入口），并让 ModelSelector 切换到如实的
   * 队长引擎显示态。条件由 App 的 teamMode 单一状态推导，此处不持第二份状态。
   */
  teamModeActive?: boolean;
  /** 服务端 /api/public/models 下发的权威队长模型 id；省略时退回协议默认。 */
  teamLeaderModelId?: string;
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
  /** 打开「分享会话」(长图 + 文字,OCV5-369;省略则不渲染,如 demo)。窄屏收进「更多操作」菜单。 */
  onShare?: () => void;
  /** 开合同屏伴随「快问小窗」。省略则不渲染。 */
  onToggleQuickAsk?: () => void;
  quickAskOpen?: boolean;
  quickAskSending?: boolean;
  /** 开合详情面板(右侧第三栏 / 移动端 Workbench 入口)。省略则不渲染(demo / 空会话 / 任务看板)。 */
  onTogglePane?: () => void;
  paneOpen?: boolean;
  /** 站内信未读数（>0 显克制 6px 状态点，hover/溢出菜单显精准计数）。 */
  unreadCount?: number;
  /** 会话未读数（侧栏折叠/移动抽屉入口 6px 呼吸点）。与站内信 unreadCount 并存、语义不同。 */
  sessionUnreadCount?: number;
  projectBreadcrumb?: { chatName?: string | null; workName?: string | null } | null;
  /** 未分类会话的项目建议（P5，开关控制）。只提示，移入由用户点。 */
  projectSuggestion?: { name: string; onAccept: () => void; onDismiss: () => void } | null;
  onOpenProjectScope?: () => void;
  /** 可选当前会话标题（桌面宽屏在智能体名旁以安静层次展示，省略则不占空间）。 */
  sessionTitle?: string | null;
  /** 可选运行态标记：true 时在强模型选择器旁展示精简运行态徽章。 */
  running?: boolean;
  /** 服务端已是新前端(appUpdate.getPillVisible)。true 且给了 onReloadForUpdate 时模型行右端出「新版本」pill。 */
  updateAvailable?: boolean;
  onReloadForUpdate?: () => void;
}) {
  const low = credits != null && (credits.trim().startsWith("-") || /^-?0+$/.test(credits.trim()));
  const showUpdatePill = updateAvailable && !!onReloadForUpdate;
  const trimmedSessionTitle = typeof sessionTitle === "string" ? sessionTitle.trim() : "";
  const showSessionTitle = Boolean(trimmedSessionTitle && trimmedSessionTitle !== "新对话");
  const hasUnreadInbox = Boolean(unreadCount && unreadCount > 0);
  const hasSecondaryActions = Boolean(onOpenFind || onShare || onOpenInbox || credits != null);
  const hasDesktopOverflow = Boolean(onOpenFind || onShare);
  const hasMobileOnlyOverflow = Boolean(
    onOpenInbox ||
      credits != null ||
      onToggleQuickAsk ||
      (projectBreadcrumb?.chatName && onOpenProjectScope) ||
      showUpdatePill ||
      onAgentClick,
  );
  const hasOverflowMenu = hasDesktopOverflow || hasMobileOnlyOverflow;
  const hasWorkspaceToggles = Boolean(onToggleQuickAsk || onTogglePane);
  // 团队模式说明弹层的受控开关：点「关闭团队模式」需要主动收起弹层（chip 随
  // teamModeActive 翻 false 一起卸载,不控 open 会留下无锚点的浮层）。
  const [teamPopoverOpen, setTeamPopoverOpen] = useState(false);
  const [advisorPopoverOpen, setAdvisorPopoverOpen] = useState(false);
  const engineLabel = teamEngineLabel(models ?? [], teamLeaderModelId, lockedModels);

  return (
    <WorkspaceShellHeader
      data-product-entry-scope="chat-header"
      onOpenMobileNav={onOpenMobileNav}
      sidebarCollapsed={sidebarCollapsed}
      onExpandSidebar={onExpandSidebar}
      sessionUnreadCount={sessionUnreadCount}
      className="oc-surface-glass border-x-0 border-t-0 shadow-none"
      collapsedExtra={
        onNew ? (
          <IconButton
            data-product-feature={PRODUCT_CAPABILITIES.chatBasics.id}
            onClick={onNew}
            aria-label="新建会话"
            shape="square"
            className="oc-btn-tactile"
          >
            <PenSquare size={17} strokeWidth={1.75} />
          </IconButton>
        ) : undefined
      }
      contentClassName="min-h-12 flex-nowrap items-center gap-1 px-2 py-1 sm:min-h-[52px] sm:gap-1.5 sm:px-4 sm:py-1.5"
    >
      {/* 智能体切换：手机 <640px 收入「···」菜单以释放单行呼吸顶栏；sm+ 常驻且在平板 640-1023px 收束宽度防止挤压模型名。 */}
      <button
        type="button"
        data-product-feature={PRODUCT_CAPABILITIES.agents.id}
        onClick={onAgentClick}
        aria-label={`切换智能体，当前${agent.name}`}
        className="oc-btn-tactile hidden min-h-11 min-w-0 shrink-0 items-center gap-2 rounded-lg px-2 py-1.5 outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg sm:flex"
      >
        <AgentAvatar agent={agent} className="size-7 shrink-0 rounded-sm" iconSize={14} />
        <span className="max-w-[6.5rem] truncate whitespace-nowrap text-title font-semibold tracking-tight text-fg lg:max-w-[10rem]">
          {agent.name}
        </span>
        <ChevronDown size={14} strokeWidth={1.75} className="hidden shrink-0 text-faint lg:block" />
      </button>

      {showSessionTitle && (
        <span
          data-testid="chat-session-title"
          title={trimmedSessionTitle}
          className="hidden min-w-0 max-w-[12rem] shrink items-center gap-1.5 text-meta font-medium text-muted @[880px]:inline-flex"
        >
          <span aria-hidden className="text-border-strong">/</span>
          <span className="truncate">{trimmedSessionTitle}</span>
        </span>
      )}

      {projectBreadcrumb?.chatName ? (
        <button
          type="button"
          data-testid="chat-project-breadcrumb"
          data-product-control="project-breadcrumb"
          onClick={onOpenProjectScope}
          aria-label={`所在项目：${projectBreadcrumb.chatName}，点击打开项目`}
          className="oc-btn-tactile hidden min-w-0 max-w-[11rem] shrink items-center gap-1.5 rounded-full border border-transparent px-2.5 py-1 text-caption font-medium text-faint outline-none hover:border-border hover:bg-surface/80 hover:text-fg focus-visible:ring-2 focus-visible:ring-ring lg:inline-flex"
          title={`所在项目：${projectBreadcrumb.chatName}`}
        >
          <FolderOpen size={12.5} strokeWidth={1.75} aria-hidden className="shrink-0" />
          <span className="truncate">{projectBreadcrumb.chatName}</span>
        </button>
      ) : projectSuggestion ? (
        <span
          data-testid="chat-project-suggestion"
          className="oc-surface-recessed hidden min-w-0 max-w-[18rem] shrink items-center gap-0.5 rounded-full px-1 py-0.5 text-caption text-muted sm:inline-flex"
        >
          <button
            type="button"
            onClick={projectSuggestion.onAccept}
            data-product-control="project-suggestion-accept"
            aria-label={`移入项目「${projectSuggestion.name}」`}
            title={`这个会话可能属于「${projectSuggestion.name}」，点一下移入`}
            className="oc-btn-tactile inline-flex min-w-0 items-center gap-1 rounded-full px-2 py-0.5 font-medium outline-none hover:bg-surface hover:text-accent focus-visible:ring-2 focus-visible:ring-ring"
          >
            <FolderOpen size={12.5} strokeWidth={1.75} aria-hidden className="shrink-0 text-accent" />
            <span className="truncate">移入「{projectSuggestion.name}」?</span>
          </button>
          <button
            type="button"
            onClick={projectSuggestion.onDismiss}
            data-product-control="project-suggestion-dismiss"
            aria-label="不用移入"
            className="oc-btn-tactile inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-faint outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
          >
            不用
          </button>
        </span>
      ) : null}

      {/* 模型与运行态核心区：手机 <640px 居中紧凑胶囊（单行永不折行）；平板/桌面 sm+ 左对齐且优先保障模型全名宽度。 */}
      {(teamModeActive || advisorModeActive || (models && onSelectModel) || running || showUpdatePill) && (
        <div
          className="flex min-w-0 flex-1 items-center justify-center gap-1 sm:justify-start sm:gap-1.5"
          data-testid="chat-model-row"
        >
          <span aria-hidden className="hidden h-4 w-px shrink-0 bg-border/80 sm:block" />
          {advisorModeActive && (
            <Popover open={advisorPopoverOpen} onOpenChange={setAdvisorPopoverOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  data-product-feature={PRODUCT_CAPABILITIES.advisorMode.id}
                  aria-label="顾问模式已开启"
                  className="oc-btn-tactile group flex min-h-10 min-w-10 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg sm:min-h-11 sm:min-w-11"
                >
                  <span className="oc-badge-craft flex items-center gap-1 rounded-full bg-accent-soft px-2 py-1 text-caption font-medium leading-none text-accent transition-colors group-hover:bg-accent/15 sm:px-2.5">
                    <ShieldCheck size={12} strokeWidth={1.75} className="shrink-0" />
                    <span className="sm:hidden">顾问</span>
                    <span className="hidden sm:inline">顾问模式</span>
                    {advisorModelLabel ? (
                      <span className="hidden max-w-[8rem] truncate @[720px]:inline" title={advisorModelLabel}>
                        · {advisorModelLabel}
                      </span>
                    ) : null}
                  </span>
                </button>
              </PopoverTrigger>
              <PopoverContent>
                <div className="flex items-start gap-2.5">
                  <span aria-hidden className="oc-icon-badge oc-icon-badge-accent mt-0.5 size-7">
                    <ShieldCheck size={14} strokeWidth={1.75} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-body font-semibold text-fg">顾问模式已开启</p>
                    <p className="mt-1 text-meta leading-relaxed text-muted">
                      顾问模式已开启：主模型不切换
                      {advisorModelLabel ? `；本回合固定使用 ${advisorModelLabel}` : ""}
                      。主模型可以向顾问提问；建议必须自行验证，不能替代审批或正式审查。咨询按实际顾问型号计费，不承诺更省。
                    </p>
                  </div>
                </div>
                {onDisableAdvisorMode && (
                  <Button
                    data-product-control
                    size="sm"
                    variant="secondary"
                    className="mt-3 w-full"
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
                  className="oc-btn-tactile group flex min-h-10 min-w-10 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg sm:min-h-11 sm:min-w-11"
                >
                  <span className="oc-badge-craft flex items-center gap-1 rounded-full bg-accent-soft px-2 py-1 text-caption font-medium leading-none text-accent transition-colors group-hover:bg-accent/15 sm:px-2.5">
                    <Users size={12} strokeWidth={1.75} className="shrink-0" />
                    <span className="sm:hidden">团队</span>
                    <span className="hidden sm:inline">团队模式</span>
                  </span>
                </button>
              </PopoverTrigger>
              <PopoverContent>
                <div className="flex items-start gap-2.5">
                  <span aria-hidden className="oc-icon-badge oc-icon-badge-accent mt-0.5 size-7">
                    <Users size={14} strokeWidth={1.75} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-body font-semibold text-fg">团队模式已开启</p>
                    <p className="mt-1 text-meta leading-relaxed text-muted">
                      团队模式已开启：队长引擎为 {engineLabel}（计费高于默认模型），并会按需委派已安装智能体协作、按对应模型计费。
                    </p>
                  </div>
                </div>
                {onDisableTeamMode && (
                  <Button
                    data-product-control
                    size="sm"
                    variant="secondary"
                    className="mt-3 w-full"
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
              teamLeaderModelId={teamLeaderModelId}
              effortSupported={effortSupported}
              effortActive={effortActive}
              onSelectEffort={onSelectEffort}
              contextTier={contextTier}
              onSelectContextTier={onSelectContextTier}
              serviceTier={serviceTier}
              onSelectServiceTier={onSelectServiceTier}
              open={modelPickerOpen}
              onOpenChange={onModelPickerOpenChange}
              onCancelSwitch={onCancelModelSwitch}
            />
          )}
          {running && (
            <span
              role="status"
              data-testid="header-running-badge"
              aria-label="当前会话正在运行"
              className="oc-badge-craft hidden shrink-0 items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-1 text-caption font-medium leading-none text-accent sm:inline-flex"
            >
              <Loader2 size={11} strokeWidth={2} aria-hidden className="shrink-0 animate-spin" />
              <span>运行中</span>
            </span>
          )}
          {showUpdatePill && (
            <button
              type="button"
              data-product-control
              data-testid="update-pill"
              aria-label="有新版本，点击刷新页面"
              title="有新版本，点击刷新页面"
              onClick={onReloadForUpdate}
              className="oc-btn-tactile group ml-1 hidden min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg sm:flex"
            >
              <span className="oc-badge-craft flex items-center gap-1 rounded-full bg-accent-soft px-2.5 py-1 text-caption font-medium leading-none text-accent transition-colors group-hover:bg-accent/15">
                <RefreshCw size={11} strokeWidth={1.75} className="shrink-0" />
                <span className="@[720px]:hidden">新版本</span>
                <span className="hidden @[720px]:inline">有新版本 · 刷新</span>
              </span>
            </button>
          )}
        </div>
      )}

      {/* 右侧操作组：手机 <640px 仅展示 [◫ Workbench] + [＋ 新建] + [··· 溢出菜单]；sm+ 展示完整桌面操作。 */}
      <div className="ml-auto flex shrink-0 items-center gap-0.5 sm:gap-1">
        {hasSecondaryActions && (
          <div className="hidden items-center gap-0.5 sm:flex" data-testid="header-secondary-actions">
            {onOpenFind && (
              <IconButton
                data-product-control
                onClick={onOpenFind}
                aria-label="会话内查找"
                title={`会话内查找 (${modKeyLabel()}F)`}
                shape="square"
                className="oc-btn-tactile hidden text-faint hover:text-fg @[720px]:flex"
              >
                <Search size={17} strokeWidth={1.75} />
              </IconButton>
            )}
            {onShare && (
              <IconButton
                data-product-control
                onClick={onShare}
                aria-label="分享会话"
                title="分享会话"
                shape="square"
                className="oc-btn-tactile hidden text-faint hover:text-fg @[720px]:flex"
              >
                <Share2 size={17} strokeWidth={1.75} />
              </IconButton>
            )}
            {onOpenInbox && (
              <div className="relative">
                <IconButton
                  data-product-feature={PRODUCT_CAPABILITIES.inbox.id}
                  onClick={onOpenInbox}
                  aria-label={hasUnreadInbox ? `站内信，${unreadCount} 条未读` : "站内信"}
                  title={hasUnreadInbox ? `站内信（${unreadCount} 条未读）` : "站内信"}
                  shape="square"
                  className="oc-btn-tactile"
                >
                  <Bell size={17} strokeWidth={1.75} />
                </IconButton>
                <HeaderCountBadge
                  count={unreadCount}
                  testId="inbox-unread-badge"
                  tone="danger"
                  ariaLabel={hasUnreadInbox ? `${unreadCount} 条未读站内信` : undefined}
                />
              </div>
            )}
            {credits != null && (
              <button
                type="button"
                data-product-feature={PRODUCT_CAPABILITIES.billing.id}
                onClick={onOpenBilling}
                disabled={!onOpenBilling}
                aria-label="账户与计费"
                title={`账户余额：${formatCredits(credits)}`}
                className={cn(
                  "oc-btn-tactile flex min-h-9 min-w-9 items-center justify-center gap-1.5 rounded-full px-2.5 py-1 text-meta font-medium tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg lg:px-3",
                  low
                    ? "oc-badge-craft bg-danger-soft text-danger"
                    : "oc-btn-secondary-craft text-muted enabled:hover:text-fg",
                  "disabled:cursor-default",
                )}
              >
                <Wallet size={13.5} strokeWidth={1.75} className="shrink-0" />
                {/* 平板 640-1023px 仅留图标避免挤压模型名，lg+ 展开余额数字。 */}
                <span className="hidden lg:inline">{formatCredits(credits)}</span>
              </button>
            )}
          </div>
        )}

        {hasSecondaryActions && hasWorkspaceToggles && (
          <span aria-hidden className="mx-0.5 hidden h-4 w-px shrink-0 bg-border/80 sm:block" />
        )}

        {hasWorkspaceToggles && (
          <div className="flex items-center gap-0.5 sm:gap-1" data-testid="header-workspace-toggles">
            {onToggleQuickAsk && (
              <IconButton
                data-product-control="quick-ask"
                data-testid="quick-ask-toggle"
                onClick={onToggleQuickAsk}
                aria-label="快问小窗"
                aria-pressed={quickAskOpen}
                title={`${quickAskOpen ? "收起" : "打开"}快问小窗：并行问答不打断主线 (${altKeyLabel()}K)`}
                shape="square"
                className={cn(
                  "oc-btn-tactile hidden sm:flex",
                  quickAskOpen
                    ? "oc-badge-craft bg-accent-soft text-accent"
                    : "text-muted hover:text-fg",
                )}
              >
                {quickAskSending && !quickAskOpen ? (
                  <Loader2 size={17} strokeWidth={1.75} className="animate-spin text-accent" />
                ) : (
                  <MessageCircleQuestion size={17} strokeWidth={1.75} />
                )}
              </IconButton>
            )}
            {onTogglePane && (
              <IconButton
                data-product-control
                data-testid="detail-pane-toggle"
                onClick={onTogglePane}
                aria-label="详情面板"
                aria-pressed={paneOpen}
                title={`${paneOpen ? "收起" : "打开"}详情面板：步骤、改动、计划 (${modKeyLabel()}\\)`}
                shape="square"
                className={cn(
                  "oc-btn-tactile",
                  paneOpen ? "oc-badge-craft bg-accent-soft text-accent" : "text-muted hover:text-fg",
                )}
              >
                {paneOpen ? <PanelRightClose size={17} strokeWidth={1.75} /> : <PanelRight size={17} strokeWidth={1.75} />}
              </IconButton>
            )}
          </div>
        )}

        {onNew && (
          <IconButton
            data-product-feature={PRODUCT_CAPABILITIES.chatBasics.id}
            data-testid="mobile-new-chat-btn"
            onClick={onNew}
            aria-label="新建会话"
            title="新建会话"
            shape="square"
            className="oc-btn-tactile text-muted hover:text-fg sm:hidden"
          >
            <Plus size={18} strokeWidth={1.75} />
          </IconButton>
        )}

        {hasOverflowMenu && (
          <div className={cn("relative", hasDesktopOverflow ? "@[720px]:hidden" : "sm:hidden")}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton
                  data-product-control
                  data-testid="header-overflow-trigger"
                  aria-label="更多操作"
                  title="更多操作"
                  shape="square"
                  className="oc-btn-tactile text-faint hover:text-fg"
                >
                  <MoreHorizontal size={18} strokeWidth={1.75} />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[13.5rem]">
                {onOpenInbox && (
                  <DropdownMenuItem
                    data-product-control
                    data-testid="overflow-inbox-item"
                    onSelect={onOpenInbox}
                    className="sm:hidden"
                  >
                    <Bell size={15} strokeWidth={1.75} className="shrink-0 text-muted" />
                    <span className="flex-1">站内信</span>
                    {hasUnreadInbox && (
                      <Badge tone="danger" className="tabular-nums">
                        {unreadCount}
                      </Badge>
                    )}
                  </DropdownMenuItem>
                )}
                {credits != null && (
                  <DropdownMenuItem
                    data-product-control
                    data-testid="overflow-billing-item"
                    disabled={!onOpenBilling}
                    onSelect={onOpenBilling}
                    className="sm:hidden"
                  >
                    <Wallet size={15} strokeWidth={1.75} className="shrink-0 text-muted" />
                    <span className="flex-1">账户与计费</span>
                    <span
                      className={cn(
                        "text-caption font-medium tabular-nums",
                        low ? "text-danger" : "text-muted",
                      )}
                    >
                      {formatCredits(credits)}
                    </span>
                  </DropdownMenuItem>
                )}
                {onToggleQuickAsk && (
                  <DropdownMenuItem
                    data-product-control
                    data-testid="overflow-quick-ask-item"
                    onSelect={onToggleQuickAsk}
                    className="sm:hidden"
                  >
                    <MessageCircleQuestion size={15} strokeWidth={1.75} className="shrink-0 text-muted" />
                    <span className="flex-1">{quickAskOpen ? "收起快问小窗" : "快问小窗"}</span>
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  data-product-control
                  data-testid="overflow-agent-item"
                  onSelect={onAgentClick}
                  className="sm:hidden"
                >
                  <Users size={15} strokeWidth={1.75} className="shrink-0 text-muted" />
                  <span className="flex-1">切换智能体</span>
                  <span className="max-w-[6rem] truncate text-caption text-faint">{agent.name}</span>
                </DropdownMenuItem>
                {projectBreadcrumb?.chatName && onOpenProjectScope && (
                  <DropdownMenuItem
                    data-product-control
                    data-testid="overflow-project-item"
                    onSelect={onOpenProjectScope}
                    className="sm:hidden"
                  >
                    <FolderOpen size={15} strokeWidth={1.75} className="shrink-0 text-muted" />
                    <span className="flex-1 truncate">项目：{projectBreadcrumb.chatName}</span>
                  </DropdownMenuItem>
                )}
                {showUpdatePill && (
                  <DropdownMenuItem
                    data-product-control
                    data-testid="overflow-update-item"
                    onSelect={onReloadForUpdate}
                    className="text-accent sm:hidden"
                  >
                    <RefreshCw size={15} strokeWidth={1.75} className="shrink-0" />
                    <span className="flex-1">有新版本 · 刷新</span>
                  </DropdownMenuItem>
                )}
                {hasDesktopOverflow && <DropdownMenuSeparator className="sm:hidden" />}
                {onOpenFind && (
                  <DropdownMenuItem data-product-control onSelect={onOpenFind}>
                    <Search size={15} strokeWidth={1.75} className="shrink-0 text-muted" />
                    <span className="flex-1">会话内查找</span>
                  </DropdownMenuItem>
                )}
                {onShare && (
                  <DropdownMenuItem data-product-control onSelect={onShare}>
                    <Share2 size={15} strokeWidth={1.75} className="shrink-0 text-muted" />
                    <span className="flex-1">分享</span>
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            {onOpenInbox && hasUnreadInbox && (
              <HeaderCountBadge
                count={unreadCount}
                testId="overflow-inbox-dot"
                tone="danger"
                className="sm:hidden"
              />
            )}
          </div>
        )}
      </div>
    </WorkspaceShellHeader>
  );
}
