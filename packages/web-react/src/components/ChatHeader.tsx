import type { CursorContextTier, ServiceTier } from "@openclaude/protocol/browser";
import {
  ChevronDown,
  Crown,
  FolderOpen,
  Loader2,
  MessageCircleQuestion,
  MoreHorizontal,
  Search,
  Share2,
  Users,
} from "lucide-react";
import { useState } from "react";
import type { SubscriptionSummary } from "../hooks/useSubscriptionSummary";
import type { Agent } from "../lib/agents";
import type { PreferenceEffort } from "../lib/modelPreferences";
import { PRODUCT_CAPABILITIES } from "../lib/productCapabilities";
import type { LockedPublicModel, PublicModel } from "../lib/types";
import { cn } from "../lib/utils";
import { AgentAvatar } from "./AgentAvatar";
import { type LockedSelectInfo, ModelSelector, compactMobileModelLabel, teamEngineLabel } from "./ModelSelector";

export { compactMobileModelLabel };
import {
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
import { AtelierIcon } from "./ui/AtelierIcons";
import { WorkspaceShellHeader } from "./ui/WorkspaceShellHeader";

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

function formatSubscriptionExpiryDate(raw?: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const isoDate = /^(\d{4}-\d{2}-\d{2})/.exec(trimmed);
  if (isoDate) return isoDate[1]!;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function buildSubscriptionEntryMeta(summary?: SubscriptionSummary | null): {
  paid: boolean;
  chipText: string;
  detailLabel: string;
} {
  if (!summary?.paid) {
    return {
      paid: false,
      chipText: "订阅",
      detailLabel: "查看订阅套餐与积分",
    };
  }
  const plan = summary.planName?.trim() || summary.planCode?.trim() || "已订阅";
  const parts = [`当前订阅：${plan}`];
  const expiry = formatSubscriptionExpiryDate(summary.periodEnd);
  if (expiry) parts.push(`到期 ${expiry}`);
  if (typeof summary.periodCredits === "number" && Number.isFinite(summary.periodCredits)) {
    parts.push(`本期剩余 ${summary.periodCredits.toLocaleString("zh-CN")} 积分`);
  }
  return {
    paid: true,
    chipText: plan,
    detailLabel: parts.join(" · "),
  };
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
  swarmSupported,
  swarmMode,
  swarmRunning,
  onSelectSwarmMode,
  modelPickerOpen,
  onModelPickerOpenChange,
  teamModeActive,
  teamLeaderModelId,
  onDisableTeamMode,
  advisorModeActive,
  advisorModelLabel,
  onDisableAdvisorMode,
  sidebarCollapsed,
  onExpandSidebar,
  onOpenMobileNav,
  onOpenSubscription,
  subscriptionSummary,
  onOpenFind,
  onShare,
  onToggleQuickAsk,
  quickAskOpen = false,
  quickAskSending = false,
  onTogglePane,
  paneOpen = false,
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
  /** OCV5-843: 当前模型是否支持蜂群协作模式，透传给 ModelSelector。 */
  swarmSupported?: boolean;
  /** OCV5-843: 当前会话是否开启蜂群模式，透传给 ModelSelector。 */
  swarmMode?: boolean;
  /** OCV5-843: 当前会话是否有运行中的蜂群，透传给 ModelSelector。 */
  swarmRunning?: boolean;
  /** OCV5-843: 切换蜂群协作模式回调，透传给 ModelSelector。 */
  onSelectSwarmMode?: (enabled: boolean) => void;
  modelPickerOpen?: boolean;
  onModelPickerOpenChange?: (v: boolean) => void;
  /**
   * 团队模式已开启且当前会话是 main（队长引擎覆盖生效）。true 时模型旁显示
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
  /** @deprecated OCV5-843 已迁归侧栏左下角账号区，保留可选类型兼容旧调用方。 */
  credits?: string | null;
  /** @deprecated OCV5-843 已迁归侧栏左下角账号区，保留可选类型兼容旧调用方。 */
  onOpenBilling?: () => void;
  sidebarCollapsed?: boolean;
  onExpandSidebar?: () => void;
  /** @deprecated OCV5-844 顶栏不再渲染独立新建按钮，保留可选类型兼容旧调用方。 */
  onNew?: () => void;
  /** 移动端打开侧栏抽屉（窄屏侧栏不内联）。 */
  onOpenMobileNav?: () => void;
  /** OCV5-844: 点击顶栏右侧订阅入口回调；传入时渲染精致订阅入口。 */
  onOpenSubscription?: () => void;
  /** OCV5-844: 当前用户的订阅状态摘要（区分已付费套餐徽章与未付费订阅引导）。 */
  subscriptionSummary?: SubscriptionSummary | null;
  /** @deprecated OCV5-843 站内信已迁归侧栏左下角，保留可选类型兼容旧调用方。 */
  onOpenInbox?: () => void;
  /** 打开会话内查找条（省略则不渲染查找项，如 demo）。收敛在当前会话「更多操作」菜单中。 */
  onOpenFind?: () => void;
  /** 打开「分享会话」(长图 + 文字,OCV5-369;省略则不渲染,如 demo)。收敛在当前会话「更多操作」菜单中。 */
  onShare?: () => void;
  /** 开合同屏伴随「快问小窗」。省略则不渲染。 */
  onToggleQuickAsk?: () => void;
  quickAskOpen?: boolean;
  quickAskSending?: boolean;
  /** 开合详情面板(右侧第三栏 / 移动端 Workbench 入口)。省略则不渲染(demo / 空会话 / 任务看板)。 */
  onTogglePane?: () => void;
  paneOpen?: boolean;
  /** @deprecated OCV5-843 站内信已迁归侧栏左下角，保留可选类型兼容旧调用方。 */
  unreadCount?: number;
  /** 会话未读数（侧栏折叠/移动抽屉入口 6px 呼吸点）。 */
  sessionUnreadCount?: number;
  projectBreadcrumb?: { chatName?: string | null; workName?: string | null } | null;
  /** 未分类会话的项目建议（P5，开关控制）。只提示，移入由用户点。 */
  projectSuggestion?: { name: string; onAccept: () => void; onDismiss: () => void } | null;
  onOpenProjectScope?: () => void;
  /** 可选当前会话标题（桌面宽屏在模型区旁以安静层次展示，省略则不占空间）。 */
  sessionTitle?: string | null;
  /** 可选运行态标记：true 时在强模型选择器旁展示精简运行态徽章。 */
  running?: boolean;
  /** 服务端已是新前端(appUpdate.getPillVisible)。透传至 WorkspaceShellHeader 统一轻提示条。 */
  updateAvailable?: boolean;
  onReloadForUpdate?: () => void;
}) {
  const trimmedSessionTitle = typeof sessionTitle === "string" ? sessionTitle.trim() : "";
  const showSessionTitle = Boolean(trimmedSessionTitle && trimmedSessionTitle !== "新对话");
  const isNonDefaultAgent = agent.id !== "main";
  const hasWorkspaceToggles = Boolean(onToggleQuickAsk || onTogglePane);
  const hasDesktopOverflowTools = Boolean(onOpenFind || onShare);
  const hasAnyOverflowTools = Boolean(onToggleQuickAsk || hasDesktopOverflowTools);
  const subscriptionMeta = buildSubscriptionEntryMeta(subscriptionSummary);
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
      updateAvailable={updateAvailable}
      onReloadForUpdate={onReloadForUpdate}
      className="relative z-20 border-x-0 border-t-0 border-b border-border/80 bg-bg/95 backdrop-blur-md shadow-xs"
      contentClassName="min-h-12 flex-nowrap items-center gap-1 px-2 py-1 sm:min-h-[52px] sm:gap-1.5 sm:px-4 sm:py-1.5"
    >
      {/* 模型与运行态核心区：手机 <640px 居中紧凑胶囊（对称留白）；桌面 sm+ 左对齐且优先保障模型与蜂群态宽度。 */}
      {((models && onSelectModel) || advisorModeActive || teamModeActive || running) && (
        <div
          className="flex min-w-0 flex-1 items-center justify-center gap-0.5 sm:flex-initial sm:justify-start sm:gap-1.5"
          data-testid="chat-model-row"
        >
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
              swarmSupported={swarmSupported}
              swarmMode={swarmMode}
              swarmRunning={swarmRunning}
              onSelectSwarmMode={onSelectSwarmMode}
              open={modelPickerOpen}
              onOpenChange={onModelPickerOpenChange}
              onCancelSwitch={onCancelModelSwitch}
            />
          )}
          {advisorModeActive && (
            <Popover open={advisorPopoverOpen} onOpenChange={setAdvisorPopoverOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  data-product-feature={PRODUCT_CAPABILITIES.advisorMode.id}
                  aria-label="顾问模式已开启"
                  title="顾问模式已开启"
                  className="oc-btn-tactile oc-spring-press group flex min-h-10 min-w-9 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg sm:min-h-11 sm:min-w-11"
                >
                  <span className="oc-badge-craft flex items-center gap-1 rounded-full bg-accent-soft px-1.5 py-1 text-caption font-medium leading-none text-accent transition-colors group-hover:bg-accent/15 sm:px-2.5">
                    <AtelierIcon name="shield" size={12} className="shrink-0" />
                    <span className="sr-only min-[430px]:not-sr-only sm:hidden">顾问</span>
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
                    <AtelierIcon name="shield" size={14} />
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
                  title="团队模式已开启"
                  className="oc-btn-tactile oc-spring-press group flex min-h-10 min-w-9 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg sm:min-h-11 sm:min-w-11"
                >
                  <span className="oc-badge-craft flex items-center gap-1 rounded-full bg-accent-soft px-1.5 py-1 text-caption font-medium leading-none text-accent transition-colors group-hover:bg-accent/15 sm:px-2.5">
                    <Users size={12} strokeWidth={1.75} className="shrink-0" />
                    <span className="sr-only min-[430px]:not-sr-only sm:hidden">团队</span>
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
          {running && (
            <span
              role="status"
              data-testid="header-running-badge"
              aria-label="当前会话正在运行"
              className="oc-badge-craft oc-breathe-aura hidden shrink-0 items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-1 text-caption font-medium leading-none text-accent sm:inline-flex"
            >
              <Loader2 size={11} strokeWidth={2} aria-hidden className="shrink-0 animate-spin" />
              <span>运行中</span>
            </span>
          )}
        </div>
      )}

      {/* 次级上下文区（桌面 sm+）：非默认智能体紧凑芯片、会话标题、项目归属/建议；默认全能助手不抢占顶栏 C 位。 */}
      {isNonDefaultAgent && (
        <button
          type="button"
          data-product-feature={PRODUCT_CAPABILITIES.agents.id}
          data-testid="chat-agent-chip"
          onClick={onAgentClick}
          aria-label={`切换智能体，当前${agent.name}`}
          title={`当前智能体：${agent.name}（点击切换）`}
          className="oc-btn-tactile oc-spring-press hidden min-h-8 min-w-0 max-w-[10rem] shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-surface/75 px-2 py-1 text-caption font-medium text-fg outline-none transition-colors hover:border-border-strong hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg sm:inline-flex"
        >
          <AgentAvatar agent={agent} className="size-4 shrink-0 rounded-full" iconSize={10} />
          <span className="truncate whitespace-nowrap">{agent.name}</span>
          <ChevronDown size={12} strokeWidth={1.75} className="hidden shrink-0 text-faint lg:block" />
        </button>
      )}

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
          className="oc-btn-tactile hidden min-w-0 max-w-[11rem] shrink items-center gap-1.5 rounded-full border border-transparent px-2.5 py-1 text-caption font-medium text-faint outline-none hover:border-border hover:bg-surface/80 hover:text-fg focus-visible:ring-2 focus-visible:ring-ring @[720px]:inline-flex"
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

      {/* 右侧当前会话操作区：桌面 [订阅] + [快问] + [◫ 工作台] + [···]；移动 [订阅] + [◫ 工作台(对话态)] + [···]（零红点）。 */}
      <div className="ml-auto flex shrink-0 items-center gap-0.5 sm:gap-1">
        {onOpenSubscription && (
          <button
            type="button"
            data-product-feature={PRODUCT_CAPABILITIES.billing.id}
            data-testid="header-subscription-btn"
            data-paid={subscriptionMeta.paid ? "true" : "false"}
            onClick={onOpenSubscription}
            aria-label={subscriptionMeta.detailLabel}
            title={subscriptionMeta.detailLabel}
            className={cn(
              "oc-btn-tactile oc-spring-press oc-badge-craft inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border text-caption font-medium leading-none outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg [@media(hover:none)]:min-h-11 [@media(hover:none)]:min-w-11 sm:h-8 sm:w-auto sm:gap-1.5 sm:rounded-full sm:px-2.5",
              subscriptionMeta.paid
                ? "border-warning/30 bg-warning-soft/80 text-warning hover:border-warning/50 hover:bg-warning-soft"
                : "border-accent/25 bg-accent-soft/75 text-accent hover:border-accent/45 hover:bg-accent-soft",
            )}
          >
            <Crown size={15} strokeWidth={1.85} aria-hidden className="shrink-0" />
            <span className="hidden max-w-[5.5rem] truncate sm:inline">
              {subscriptionMeta.chipText}
            </span>
          </button>
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
                  "oc-btn-tactile oc-spring-press oc-icon-nudge hidden sm:flex",
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
                  "oc-btn-tactile oc-spring-press oc-icon-nudge",
                  paneOpen ? "oc-badge-craft bg-accent-soft text-accent" : "text-muted hover:text-fg",
                )}
              >
                <AtelierIcon name="workbench" size={17} />
              </IconButton>
            )}
          </div>
        )}

        <div className="relative">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton
                data-product-control
                data-testid="header-overflow-trigger"
                aria-label="更多操作"
                title="更多操作"
                shape="square"
                className="oc-btn-tactile oc-spring-press text-faint hover:text-fg"
              >
                <MoreHorizontal size={18} strokeWidth={1.75} />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[13.5rem]">
              <DropdownMenuItem
                data-product-feature={PRODUCT_CAPABILITIES.agents.id}
                data-testid="overflow-agent-item"
                onSelect={onAgentClick}
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
                >
                  <FolderOpen size={15} strokeWidth={1.75} className="shrink-0 text-muted" />
                  <span className="flex-1 truncate">项目：{projectBreadcrumb.chatName}</span>
                </DropdownMenuItem>
              )}
              {hasAnyOverflowTools && (
                <DropdownMenuSeparator className={hasDesktopOverflowTools ? undefined : "sm:hidden"} />
              )}
              {onToggleQuickAsk && (
                <DropdownMenuItem
                  data-product-control
                  data-testid="overflow-quick-ask-item"
                  onSelect={onToggleQuickAsk}
                  className="sm:hidden"
                >
                  {quickAskSending && !quickAskOpen ? (
                    <Loader2 size={15} strokeWidth={1.75} className="shrink-0 animate-spin text-accent" />
                  ) : (
                    <MessageCircleQuestion size={15} strokeWidth={1.75} className="shrink-0 text-muted" />
                  )}
                  <span className="flex-1">{quickAskOpen ? "收起快问小窗" : "快问小窗"}</span>
                  {quickAskSending && !quickAskOpen && (
                    <span
                      data-testid="overflow-quick-ask-sending"
                      className="text-caption font-medium text-accent"
                    >
                      回答中
                    </span>
                  )}
                </DropdownMenuItem>
              )}
              {onOpenFind && (
                <DropdownMenuItem
                  data-product-control
                  data-testid="overflow-find-item"
                  onSelect={onOpenFind}
                >
                  <Search size={15} strokeWidth={1.75} className="shrink-0 text-muted" />
                  <span className="flex-1">会话内查找</span>
                  <span
                    data-testid="overflow-find-shortcut"
                    className="hidden text-caption tabular-nums text-faint sm:inline"
                  >
                    {modKeyLabel()}F
                  </span>
                </DropdownMenuItem>
              )}
              {onShare && (
                <DropdownMenuItem
                  data-product-control
                  data-testid="overflow-share-item"
                  onSelect={onShare}
                >
                  <Share2 size={15} strokeWidth={1.75} className="shrink-0 text-muted" />
                  <span className="flex-1">分享会话</span>
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </WorkspaceShellHeader>
  );
}
