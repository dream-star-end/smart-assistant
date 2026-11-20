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
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
  /** 开合详情面板(右侧第三栏)。省略则不渲染(demo / 空会话 / 任务看板)。手机上入口在过程摘要行。 */
  onTogglePane?: () => void;
  paneOpen?: boolean;
  /** 站内信未读数（>0 显红点，>99 显 99+）。 */
  unreadCount?: number;
  /** 会话未读数（侧栏折叠/移动抽屉入口角标）。与站内信 unreadCount 并存、语义不同。 */
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
  const hasSecondaryActions = Boolean(onOpenFind || onShare || onOpenInbox || credits != null);
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
      collapsedExtra={
        onNew ? (
          <IconButton
            data-product-feature={PRODUCT_CAPABILITIES.chatBasics.id}
            onClick={onNew}
            aria-label="新建会话"
            shape="square"
          >
            <PenSquare size={18} />
          </IconButton>
        ) : undefined
      }
      contentClassName="flex-wrap gap-x-1.5 gap-y-0 px-2.5 pb-1.5 @[560px]:flex-nowrap @[560px]:gap-1.5 sm:px-4 sm:pb-2"
    >
      <button
        type="button"
        data-product-feature={PRODUCT_CAPABILITIES.agents.id}
        onClick={onAgentClick}
        aria-label={`切换智能体，当前${agent.name}`}
        className="flex min-h-11 min-w-0 flex-1 items-center gap-1.5 rounded-xl px-1 py-1.5 @[560px]:flex-initial @[560px]:px-2.5 outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg active:scale-[0.98]"
      >
        <AgentAvatar agent={agent} className="size-7 shrink-0 rounded-lg" iconSize={15} />
        {/* 窄屏不折行：截断而非换行（避免"全能/助手"难看的两行）。 */}
        <span className="max-w-[7.5rem] truncate whitespace-nowrap text-title font-semibold text-fg @[560px]:max-w-none">
          {agent.name}
        </span>
        <ChevronDown size={15} className="hidden shrink-0 text-faint @[560px]:block" />
      </button>
      {showSessionTitle && (
        <span
          data-testid="chat-session-title"
          title={trimmedSessionTitle}
          className="hidden min-w-0 max-w-[13rem] shrink items-center gap-1.5 text-meta font-medium text-muted @[760px]:inline-flex"
        >
          <span aria-hidden className="text-border-strong">/</span>
          <span className="truncate">{trimmedSessionTitle}</span>
        </span>
      )}
      {projectBreadcrumb?.chatName ? (
        // 所在项目:窄容器落位到第二行模型行右侧空位，释放第一行让智能体名完整展开；宽容器紧跟智能体名。
        <button
          type="button"
          data-testid="chat-project-breadcrumb"
          data-product-control="project-breadcrumb"
          onClick={onOpenProjectScope}
          aria-label={`所在项目：${projectBreadcrumb.chatName}，点击打开项目`}
          className="order-3 -my-1 ml-auto inline-flex min-h-11 min-w-0 max-w-[7.5rem] shrink-0 items-center gap-1 rounded-full px-1.5 text-caption text-faint outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring @[560px]:order-none @[560px]:my-0 @[560px]:ml-0 @[560px]:min-h-0 @[560px]:max-w-[13rem] @[560px]:shrink @[560px]:px-2 @[560px]:py-1"
          title={`所在项目：${projectBreadcrumb.chatName}`}
        >
          <FolderOpen size={12.5} aria-hidden className="shrink-0" />
          <span className="truncate">{projectBreadcrumb.chatName}</span>
        </button>
      ) : projectSuggestion ? (
        <span
          data-testid="chat-project-suggestion"
          className="order-3 basis-full inline-flex min-w-0 max-w-full shrink items-center gap-0.5 rounded-lg border border-dashed border-border text-caption text-muted sm:order-none sm:basis-auto @[560px]:order-none @[560px]:basis-auto @[560px]:max-w-[18rem]"
        >
          <button
            type="button"
            onClick={projectSuggestion.onAccept}
            data-product-control="project-suggestion-accept"
            aria-label={`移入项目「${projectSuggestion.name}」`}
            title={`这个会话可能属于「${projectSuggestion.name}」，点一下移入`}
            className="inline-flex min-h-11 min-w-0 flex-1 items-center gap-1 rounded-lg px-1.5 outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring @[560px]:min-h-0 @[560px]:flex-initial @[560px]:py-1"
          >
            <FolderOpen size={13} aria-hidden className="shrink-0" />
            <span className="truncate">移入「{projectSuggestion.name}」?</span>
          </button>
          <button
            type="button"
            onClick={projectSuggestion.onDismiss}
            data-product-control="project-suggestion-dismiss"
            aria-label="不用移入"
            className="inline-flex min-h-11 shrink-0 items-center rounded-lg px-1.5 outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring @[560px]:min-h-0 @[560px]:py-1"
          >
            不用
          </button>
        </span>
      ) : null}
      {(teamModeActive || advisorModeActive || (models && onSelectModel) || running || showUpdatePill) && (
        <>
        <span aria-hidden className="order-1 h-0 basis-full border-t border-border/50 @[560px]:hidden" />
        <div
          className="order-2 -my-1 flex min-w-0 flex-1 items-center gap-1.5 @[560px]:order-none @[560px]:my-0 @[560px]:basis-auto"
          data-testid="chat-model-row"
        >
          <span aria-hidden className="hidden h-4 w-px shrink-0 bg-border @[560px]:block" />
          {/* OCV5-295:窄屏模型行不再铺整宽灰底(像主 CTA);触发器自带 44px 命中与截断,模型名/倍率直接可读。 */}
          {/* 团队模式可见指示:开启期间常驻 agent 名旁(弹窗外唯一的知情入口),
              点击弹说明 + 一键关闭。仅 main 会话(teamModeActive)显示。 */}
          {advisorModeActive && (
            <Popover open={advisorPopoverOpen} onOpenChange={setAdvisorPopoverOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  data-product-feature={PRODUCT_CAPABILITIES.advisorMode.id}
                  aria-label="顾问模式已开启"
                  className="group flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg active:scale-[0.98]"
                >
                  {/* OCV5-307:44px 命中区留在透明 button 上,可见的是内层细胶囊 —— 原先整颗 44px 高的色块显得笨重。 */}
                  <span className="flex items-center gap-1 rounded-full bg-accent-soft px-2.5 py-1 text-caption font-medium leading-none text-accent transition-colors group-hover:bg-accent/15">
                    <ShieldCheck size={11} className="shrink-0" />
                    <span className="@[560px]:hidden">顾问</span>
                    <span className="hidden @[560px]:inline">顾问模式</span>
                    {advisorModelLabel ? (
                      <span className="hidden max-w-[8rem] truncate @[720px]:inline" title={advisorModelLabel}>
                        · {advisorModelLabel}
                      </span>
                    ) : null}
                  </span>
                </button>
              </PopoverTrigger>
              <PopoverContent>
                <p className="text-body leading-relaxed text-muted">
                  顾问模式已开启：主模型不切换
                  {advisorModelLabel ? `；本回合固定使用 ${advisorModelLabel}` : ""}
                  。主模型可以向顾问提问；建议必须自行验证，不能替代审批或正式审查。咨询按实际顾问型号计费，不承诺更省。
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
                  className="group flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg active:scale-[0.98]"
                >
                  <span className="flex items-center gap-1 rounded-full bg-accent-soft px-2.5 py-1 text-caption font-medium leading-none text-accent transition-colors group-hover:bg-accent/15">
                    <Users size={11} className="shrink-0" />
                    {/* 窄容器给「团队」二字；宽容器用全称。 */}
                    <span className="@[560px]:hidden">团队</span>
                    <span className="hidden @[560px]:inline">团队模式</span>
                  </span>
                </button>
              </PopoverTrigger>
              <PopoverContent>
                <p className="text-body leading-relaxed text-muted">
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
              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-caption font-medium leading-none text-accent"
            >
              <Loader2 size={11} aria-hidden className="animate-spin shrink-0" />
              <span>运行中</span>
            </span>
          )}
          {/* OCV5-626:版本不一致即亮,不等安全点 / 5 分钟横幅。放模型行右端:窄屏这一行整宽且右侧
              本就空着,不挤顶栏图标;宽容器紧跟模型选择器。点一下走 governor.reloadNow()。 */}
          {showUpdatePill && (
            <button
              type="button"
              data-product-control
              data-testid="update-pill"
              aria-label="有新版本，点击刷新页面"
              title="有新版本，点击刷新页面"
              onClick={onReloadForUpdate}
              className="group ml-auto flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg active:scale-[0.98] @[560px]:ml-1"
            >
              <span className="flex items-center gap-1 rounded-full bg-accent-soft px-2.5 py-1 text-caption font-medium leading-none text-accent transition-colors group-hover:bg-accent/15">
                <RefreshCw size={11} className="shrink-0" />
                <span className="@[720px]:hidden">新版本</span>
                <span className="hidden @[720px]:inline">有新版本 · 刷新</span>
              </span>
            </button>
          )}
        </div>
        </>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-0.5 @[560px]:gap-1">
        {hasSecondaryActions && (
          <div className="flex items-center gap-0 @[560px]:gap-0.5" data-testid="header-secondary-actions">
            {onOpenFind && (
              <IconButton
                data-product-control
                onClick={onOpenFind}
                aria-label="会话内查找"
                title={`会话内查找 (${modKeyLabel()}F)`}
                shape="square"
                className="hidden text-faint hover:text-fg @[720px]:flex"
              >
                <Search size={17} />
              </IconButton>
            )}
            {onShare && (
              <IconButton
                data-product-control
                onClick={onShare}
                aria-label="分享会话"
                title="分享会话"
                shape="square"
                className="hidden text-faint hover:text-fg @[720px]:flex"
              >
                <Share2 size={17} />
              </IconButton>
            )}
            {/* 窄屏或桌面三栏态（容器 <720px）将查找与分享并入「更多操作」菜单，防止顶栏挤压溢出。 */}
            {(onShare || onOpenFind) && (
              <div className="@[720px]:hidden">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <IconButton
                      data-product-control
                      aria-label="更多操作"
                      title="更多操作"
                      shape="square"
                      className="text-faint hover:text-fg"
                    >
                      <MoreHorizontal size={18} />
                    </IconButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {onOpenFind && (
                      <DropdownMenuItem data-product-control onSelect={onOpenFind}>
                        <Search size={16} className="shrink-0 text-muted" />
                        <span className="flex-1">会话内查找</span>
                      </DropdownMenuItem>
                    )}
                    {onShare && (
                      <DropdownMenuItem data-product-control onSelect={onShare}>
                        <Share2 size={16} className="shrink-0 text-muted" />
                        <span className="flex-1">分享</span>
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
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
                type="button"
                data-product-feature={PRODUCT_CAPABILITIES.billing.id}
                onClick={onOpenBilling}
                disabled={!onOpenBilling}
                aria-label="账户与计费"
                className={`flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-full border px-2 py-1 text-meta font-medium tabular-nums outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg @[560px]:px-2.5 ${
                  low
                    ? "border-danger/40 bg-danger-soft text-danger hover:bg-danger-soft"
                    : "border-border text-muted enabled:hover:bg-hover enabled:hover:text-fg"
                } disabled:cursor-default`}
              >
                <Wallet size={13} className="shrink-0" />
                {/* 窄容器只留图标（点击进设置看余额），省出空间避免三栏或手机顶栏溢出。 */}
                <span className="hidden @[560px]:inline">{formatCredits(credits)}</span>
              </button>
            )}
          </div>
        )}
        {hasSecondaryActions && hasWorkspaceToggles && (
          <span aria-hidden className="mx-0.5 hidden h-4 w-px shrink-0 bg-border @[560px]:block" />
        )}
        {hasWorkspaceToggles && (
          <div className="flex items-center gap-0.5 @[560px]:gap-1" data-testid="header-workspace-toggles">
            {onToggleQuickAsk && (
              <IconButton
                data-product-control="quick-ask"
                data-testid="quick-ask-toggle"
                onClick={onToggleQuickAsk}
                aria-label="快问小窗"
                aria-pressed={quickAskOpen}
                title={`${quickAskOpen ? "收起" : "打开"}快问小窗：并行问答不打断主线 (${altKeyLabel()}K)`}
                shape="square"
                className={quickAskOpen ? "bg-accent-soft text-accent" : "text-muted hover:text-fg"}
              >
                {quickAskSending && !quickAskOpen ? (
                  <Loader2 size={18} className="animate-spin text-accent" />
                ) : (
                  <MessageCircleQuestion size={18} />
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
                className={cn("hidden sm:flex", paneOpen ? "bg-accent-soft text-accent" : "text-muted hover:text-fg")}
              >
                {paneOpen ? <PanelRightClose size={18} /> : <PanelRight size={18} />}
              </IconButton>
            )}
          </div>
        )}
      </div>
    </WorkspaceShellHeader>
  );
}
