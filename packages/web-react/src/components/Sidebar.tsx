import {
  BookOpen,
  Building2,
  Film,
  Kanban,
  LayoutGrid,
  LogOut,
  MessageSquareText,
  PanelLeftClose,
  Pencil,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Store,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { Theme } from "../hooks/useTheme";
import { BRAND } from "../lib/brand";
import { PRODUCT_CAPABILITIES } from "../lib/productCapabilities";
import type { Session, User } from "../lib/types";
import { cn, formatCredits, groupLabel } from "../lib/utils";
import { ThemeToggle } from "./ThemeToggle";
import {
  Avatar,
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
} from "./ui";

export function Sidebar({
  sessions,
  activeId,
  user,
  credits,
  optimizerPending = 0,
  onSelect,
  onNew,
  onRename,
  onDelete,
  onCollapse,
  onLogout,
  onOpenAccount,
  onOpenFeedback,
  onOpenManage,
  onOpenMarketplace,
  onOpenTutorial,
  onOpenOrg,
  onOpenBoard,
  onOpenMediaTasks,
  boardActive,
  showAdmin,
  theme,
  onCycleTheme,
}: {
  sessions: Session[];
  activeId?: string;
  user: User | null;
  /** 账户余额（积分字符串大数，来自 /api/me）。null 时退化为通用文案。 */
  credits?: string | null;
  /**
   * Auto‑Dream 待确认建议数（与管理中心「优化」Tab 徽标同源）。>0 时管理中心入口右侧
   * 用徽章替换静态副标题 —— 这是全面优化在账号菜单里唯一的曝光位。
   */
  optimizerPending?: number;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (s: Session) => void;
  onDelete: (s: Session) => void;
  onCollapse?: () => void;
  onLogout?: () => void;
  onOpenAccount?: () => void;
  /** 打开设置中心的反馈分区。省略则不渲染入口（demo）。 */
  onOpenFeedback?: () => void;
  /** 打开管理中心（记忆/技能/定时/插件/文献/优化）。省略则不渲染入口（demo）。 */
  onOpenManage?: () => void;
  /** 打开 AI 市场（技能/智能体/插件）。省略则不渲染入口（demo）。 */
  onOpenMarketplace?: () => void;
  /** 打开使用教程。省略则不渲染入口（demo）。 */
  onOpenTutorial?: () => void;
  /** 打开组织中心（企业版）。仅 org owner/admin 提供，省略则不渲染入口。 */
  onOpenOrg?: () => void;
  /** 打开任务面板全屏工作区。省略则不渲染入口（demo）。 */
  onOpenBoard?: () => void;
  /** 打开账号级异步视频任务中心。 */
  onOpenMediaTasks?: () => void;
  /** 任务面板当前是否为工作区（选中态）。 */
  boardActive?: boolean;
  /** 平台超管入口。仅 user.role === 'admin' 时为 true，false/省略则不渲染。 */
  showAdmin?: boolean;
  theme?: Theme;
  onCycleTheme?: () => void;
}) {
  const [q, setQ] = useState("");

  const groups = useMemo(() => {
    const filtered = sessions.filter((s) => s.title.toLowerCase().includes(q.toLowerCase()));
    const map = new Map<string, Session[]>();
    for (const s of filtered) {
      const k = groupLabel(s.updatedAt);
      (map.get(k) || map.set(k, []).get(k)!).push(s);
    }
    return [...map.entries()];
  }, [sessions, q]);

  const hasAccountMenu = Boolean(
    onOpenManage ||
      onOpenMarketplace ||
      onOpenOrg ||
      showAdmin ||
      onOpenMediaTasks ||
      onOpenAccount ||
      onOpenFeedback ||
      onLogout,
  );

  const userChip = (
    <button
      type="button"
      data-product-feature={PRODUCT_CAPABILITIES.billing.id}
      disabled={!hasAccountMenu}
      aria-label={hasAccountMenu ? "账号菜单" : undefined}
      className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg enabled:hover:bg-hover"
    >
      <Avatar tone="ink" className="text-body">
        {(user?.displayName || "U").slice(0, 1).toUpperCase()}
      </Avatar>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-section font-medium text-fg">
          {user?.displayName || "未登录"}
        </span>
        <span className="block truncate text-caption text-faint">
          {credits != null ? `余额 ${formatCredits(credits)} 积分` : "多模型 · 计量计费"}
        </span>
      </span>
    </button>
  );

  return (
    <aside className="flex h-full w-[268px] shrink-0 flex-col bg-sidebar">
      <div className="flex flex-col gap-2 p-3" data-product-entry-scope="sidebar-primary">
        <div className="flex items-center justify-between px-1.5 pb-1">
          <div className="flex items-center gap-2">
            <span className="flex size-7 items-center justify-center rounded-lg bg-grad-cta text-white">
              <Sparkles size={15} />
            </span>
            <span className="text-title font-semibold tracking-tight">{BRAND.name}</span>
          </div>
          {onCollapse && (
            <IconButton data-product-control onClick={onCollapse} aria-label="折叠侧栏" variant="muted" size="sm" shape="square">
              <PanelLeftClose size={17} />
            </IconButton>
          )}
        </div>

        <Button
          data-product-feature={PRODUCT_CAPABILITIES.chatBasics.id}
          variant="secondary"
          onClick={onNew}
          className="h-auto w-full justify-start gap-2.5 rounded-xl px-3 py-2.5 text-section font-medium"
        >
          <Plus size={17} />
          新建会话
        </Button>

        {onOpenBoard && (
          <button
            type="button"
            data-product-control
            data-testid="taskboard-nav"
            onClick={onOpenBoard}
            aria-current={boardActive ? "true" : undefined}
            className={cn(
              "relative flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-body font-medium outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring",
              boardActive ? "bg-active text-fg" : "text-muted",
            )}
          >
            {boardActive && (
              <span aria-hidden className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-accent" />
            )}
            <Kanban size={16} className="text-faint" />
            任务面板
            <span className="ml-auto text-caption text-faint">看板 · 待确认</span>
          </button>
        )}

        <div className="flex items-center gap-2 rounded-xl bg-hover px-3 py-2 transition-shadow focus-within:ring-2 focus-within:ring-ring">
          <Search size={15} className="text-faint" />
          <input
            data-product-feature={PRODUCT_CAPABILITIES.sessions.id}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索会话"
            // 表单控件红线：窄屏必须 ≥16px。侧栏在移动端是抽屉，13.5px 的搜索框一聚焦
            // 就会被 iOS Safari 放大整页且不回弹；桌面段 md:text-sm 保持原视觉密度。
            className="w-full bg-transparent text-base text-fg outline-none placeholder:text-faint md:text-sm"
          />
        </div>
      </div>

      <div
        className="no-scrollbar flex-1 overflow-y-auto px-2 pb-3"
        data-product-feature={PRODUCT_CAPABILITIES.sessions.id}
      >
        {groups.length === 0 && (
          <p className="px-3 py-6 text-center text-body text-faint">暂无会话</p>
        )}
        {groups.map(([label, items]) => (
          <div key={label} className="mb-1">
            <div className="px-3 pb-1 pt-3 text-caption font-medium uppercase tracking-wide text-faint">
              {label}
            </div>
            {items.map((s) => (
              // 会话行键盘可达:选中区是真 <button>(Tab 聚焦 + Enter/Space 激活 + aria-current),
              // 操作区 group-focus-within 显形(此前 div onClick + 仅 hover 显形,键盘用户
              // 无法切换会话 —— 核心导航不可达)。嵌套按钮非法,故行容器保持 div。
              <div
                key={s.id}
                className={cn(
                  "group relative flex items-center gap-2 rounded-md pr-2 text-section transition-colors",
                  s.id === activeId ? "bg-active text-fg" : "text-muted hover:bg-hover hover:text-fg",
                )}
              >
                {s.id === activeId && (
                  <span aria-hidden className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-accent" />
                )}
                <button
                  type="button"
                  onClick={() => onSelect(s.id)}
                  aria-current={s.id === activeId ? "true" : undefined}
                  className="min-w-0 flex-1 truncate rounded-md px-3 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:py-2"
                >
                  {s.title || "新对话"}
                </button>
                <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
                  <IconButton
                    aria-label="重命名"
                    variant="muted"
                    size="xs"
                    shape="square"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRename(s);
                    }}
                  >
                    <Pencil size={13} />
                  </IconButton>
                  <IconButton
                    aria-label="删除"
                    variant="muted"
                    size="xs"
                    shape="square"
                    className="hover:text-danger"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(s);
                    }}
                  >
                    <Trash2 size={13} />
                  </IconButton>
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>

      <div
        className="flex items-center gap-1 border-t border-border px-2 pt-2 sidebar-foot-safe-b"
        data-product-entry-scope="sidebar-account"
      >
        {hasAccountMenu ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>{userChip}</DropdownMenuTrigger>
            <DropdownMenuContent
              side="top"
              align="start"
              sideOffset={8}
              className="w-64 p-1.5"
              data-product-entry-scope="account-menu"
            >
              <div className="flex items-center gap-2.5 px-2 py-2">
                <Avatar tone="ink" className="text-body">
                  {(user?.displayName || "U").slice(0, 1).toUpperCase()}
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-section font-medium text-fg">
                    {user?.displayName || "未登录"}
                  </p>
                  <p className="truncate text-caption text-faint">
                    {credits != null ? `${formatCredits(credits)} 积分` : "多模型 · 计量计费"}
                  </p>
                </div>
              </div>
              <DropdownMenuSeparator />
              {onOpenManage && (
                <DropdownMenuItem
                  data-product-feature={PRODUCT_CAPABILITIES.memory.id}
                  onSelect={onOpenManage}
                >
                  <LayoutGrid size={16} className="shrink-0 text-muted" />
                  <span className="flex-1">管理中心</span>
                  {optimizerPending > 0 ? (
                    <Badge tone="accent" size="sm">
                      {optimizerPending > 99 ? "99+" : optimizerPending} 项待确认
                    </Badge>
                  ) : (
                    <span className="text-caption text-faint">记忆 · 技能</span>
                  )}
                </DropdownMenuItem>
              )}
              {onOpenMarketplace && (
                <DropdownMenuItem
                  data-product-feature={PRODUCT_CAPABILITIES.marketplace.id}
                  onSelect={onOpenMarketplace}
                >
                  <Store size={16} className="shrink-0 text-muted" />
                  市场
                </DropdownMenuItem>
              )}
              {onOpenOrg && (
                <DropdownMenuItem
                  data-product-feature={PRODUCT_CAPABILITIES.organization.id}
                  onSelect={onOpenOrg}
                >
                  <Building2 size={16} className="shrink-0 text-muted" />
                  组织
                </DropdownMenuItem>
              )}
              {showAdmin && (
                <DropdownMenuItem asChild>
                  <a data-product-control href="/admin.html">
                    <ShieldCheck size={16} className="shrink-0 text-muted" />
                    管理后台
                  </a>
                </DropdownMenuItem>
              )}
              {onOpenMediaTasks && (
                <DropdownMenuItem data-product-control onSelect={onOpenMediaTasks}>
                  <Film size={16} className="shrink-0 text-muted" />
                  视频任务
                </DropdownMenuItem>
              )}
              {(onOpenAccount || onOpenFeedback || onLogout) &&
                (onOpenManage || onOpenMarketplace || onOpenOrg || showAdmin || onOpenMediaTasks) && (
                  <DropdownMenuSeparator />
                )}
              {onOpenAccount && (
                <DropdownMenuItem
                  data-product-feature={PRODUCT_CAPABILITIES.billing.id}
                  onSelect={onOpenAccount}
                >
                  <Settings size={16} className="shrink-0 text-muted" />
                  设置
                </DropdownMenuItem>
              )}
              {onOpenFeedback && (
                <DropdownMenuItem
                  data-product-feature={PRODUCT_CAPABILITIES.feedback.id}
                  onSelect={onOpenFeedback}
                >
                  <MessageSquareText size={16} className="shrink-0 text-muted" />
                  意见反馈
                </DropdownMenuItem>
              )}
              {onLogout && (
                <DropdownMenuItem data-product-control destructive onSelect={onLogout}>
                  <LogOut size={16} className="shrink-0" />
                  退出登录
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          userChip
        )}
        {onOpenTutorial && (
          <button
            type="button"
            data-product-control
            onClick={onOpenTutorial}
            aria-label="打开使用教程"
            title="使用教程"
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-faint outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          >
            <BookOpen size={16} />
          </button>
        )}
        {theme && onCycleTheme && <ThemeToggle theme={theme} onCycle={onCycleTheme} />}
      </div>
    </aside>
  );
}
