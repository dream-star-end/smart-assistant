import type { CursorContextTier } from "@openclaude/protocol";
import {
  Bell,
  ChevronDown,
  FolderOpen,
  Menu,
  MoreHorizontal,
  PanelLeft,
  PenSquare,
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

/** 快捷键修饰键按平台显示:Mac 系 ⌘,其余 Ctrl(C-24:Windows/Linux 用户此前看到的是 Mac 符号)。 */
export function modKeyLabel(): string {
  if (typeof navigator === "undefined") return "Ctrl+";
  const platform = `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`;
  return /Mac|iPhone|iPad|iPod/i.test(platform) ? "⌘" : "Ctrl+";
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
  onShare,
  unreadCount,
  sessionUnreadCount,
  projectBreadcrumb,
  projectSuggestion,
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
  /** 打开「分享会话」(长图 + 文字,OCV5-369;省略则不渲染,如 demo)。窄屏收进「更多操作」菜单。 */
  onShare?: () => void;
  /** 站内信未读数（>0 显红点，>99 显 99+）。 */
  unreadCount?: number;
  /** 会话未读数（侧栏折叠/移动抽屉入口角标）。与站内信 unreadCount 并存、语义不同。 */
  sessionUnreadCount?: number;
  projectBreadcrumb?: { chatName?: string | null; workName?: string | null } | null;
  /** 未分类会话的项目建议（P5，开关控制）。只提示，移入由用户点。 */
  projectSuggestion?: { name: string; onAccept: () => void; onDismiss: () => void } | null;
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
        type="button"
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
      {projectBreadcrumb?.chatName ? (
        // 所在项目:窄屏也显示(截断),点开项目本身,而不是管理中心。
        <button
          type="button"
          data-testid="chat-project-breadcrumb"
          data-product-control="project-breadcrumb"
          onClick={onOpenProjectScope}
          aria-label={`所在项目：${projectBreadcrumb.chatName}，点击打开项目`}
          className="inline-flex min-h-11 min-w-0 max-w-[7rem] shrink items-center gap-1 rounded-lg px-1.5 text-caption text-muted outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0 sm:max-w-[14rem] sm:px-2 sm:py-1"
          title={`所在项目：${projectBreadcrumb.chatName}`}
        >
          <FolderOpen size={13} aria-hidden className="shrink-0" />
          <span className="truncate">{projectBreadcrumb.chatName}</span>
        </button>
      ) : projectSuggestion ? (
        <span
          data-testid="chat-project-suggestion"
          className="inline-flex min-w-0 max-w-[11rem] shrink items-center gap-0.5 rounded-lg border border-dashed border-border text-caption text-muted sm:max-w-[18rem]"
        >
          <button
            type="button"
            onClick={projectSuggestion.onAccept}
            aria-label={`移入项目「${projectSuggestion.name}」`}
            title={`这个会话可能属于「${projectSuggestion.name}」，点一下移入`}
            className="inline-flex min-h-11 min-w-0 items-center gap-1 rounded-lg px-1.5 outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0 sm:py-1"
          >
            <FolderOpen size={13} aria-hidden className="shrink-0" />
            <span className="truncate">移入「{projectSuggestion.name}」?</span>
          </button>
          <button
            type="button"
            onClick={projectSuggestion.onDismiss}
            aria-label="不用移入"
            className="inline-flex min-h-11 shrink-0 items-center rounded-lg px-1.5 outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0 sm:py-1"
          >
            不用
          </button>
        </span>
      ) : null}
      {(teamModeActive || advisorModeActive || (models && onSelectModel)) && (
        <div className="order-last flex min-w-0 basis-full items-center gap-1 sm:order-none sm:flex-1 sm:basis-auto" data-testid="chat-model-row">
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
                    <span className="sm:hidden">顾问</span>
                    <span className="hidden sm:inline">顾问模式</span>
                    {advisorModelLabel ? (
                      <span className="hidden max-w-[8rem] truncate sm:inline" title={advisorModelLabel}>
                        · {advisorModelLabel}
                      </span>
                    ) : null}
                  </span>
                </button>
              </PopoverTrigger>
              <PopoverContent>
                <p className="text-[12.5px] leading-relaxed text-muted">
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
                    {/* 窄屏给「团队」二字；sm+ 仍用全称，桌面既有断言不红。 */}
                    <span className="sm:hidden">团队</span>
                    <span className="hidden sm:inline">团队模式</span>
                  </span>
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
            title={`会话内查找 (${modKeyLabel()}F)`}
            shape="square"
          >
            <Search size={18} />
          </IconButton>
        )}
        {onShare && (
          <IconButton
            data-product-control
            onClick={onShare}
            aria-label="分享会话"
            title="分享会话"
            shape="square"
            className="hidden sm:flex"
          >
            <Share2 size={18} />
          </IconButton>
        )}
        {/* 窄屏没有位置放独立分享键:并入「更多」菜单承接,功能按视口降级而不是消失(C-12)。 */}
        {onShare && (
          <div className="sm:hidden">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton data-product-control aria-label="更多操作" title="更多操作" shape="square">
                  <MoreHorizontal size={18} />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem data-product-control onSelect={onShare}>
                  <Share2 size={16} className="shrink-0 text-muted" />
                  <span className="flex-1">分享</span>
                </DropdownMenuItem>
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
        "pointer-events-none absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none tabular-nums",
        // 前景走 -fg token 而不是写死白字:深色主题 accent #9a8aff / danger #f0666e 都是浅色,
        // 白字只有 2.8 / 3.1:1;-fg 在深色下取近黑(≥5.9:1),浅色下仍是白(a11y 走查 shell#1/#11)。
        tone === "accent" ? "bg-accent text-accent-fg" : "bg-danger text-danger-fg",
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
