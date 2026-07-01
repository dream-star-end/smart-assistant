import { LayoutGrid, LogOut, PanelLeftClose, Pencil, Plus, Search, Sparkles, Store, Trash2, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { BRAND } from "../lib/brand";
import type { Session, User } from "../lib/types";
import { cn, formatCredits, groupLabel } from "../lib/utils";
import { Avatar, Button, IconButton } from "./ui";

export function Sidebar({
  sessions,
  activeId,
  user,
  credits,
  onSelect,
  onNew,
  onRename,
  onDelete,
  onCollapse,
  onLogout,
  onOpenAccount,
  onOpenManage,
  onOpenTeam,
  onOpenMarketplace,
}: {
  sessions: Session[];
  activeId?: string;
  user: User | null;
  /** 账户余额（积分字符串大数，来自 /api/me）。null 时退化为通用文案。 */
  credits?: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (s: Session) => void;
  onDelete: (s: Session) => void;
  onCollapse?: () => void;
  onLogout?: () => void;
  onOpenAccount?: () => void;
  /** 打开管理中心（记忆/定时任务/技能）。省略则不渲染入口（demo）。 */
  onOpenManage?: () => void;
  /** 打开团队管理（多智能体协作）。省略则不渲染入口（demo）。 */
  onOpenTeam?: () => void;
  /** 打开 AI 市场（技能/智能体）。省略则不渲染入口（demo）。 */
  onOpenMarketplace?: () => void;
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

  return (
    <aside className="flex h-full w-[268px] shrink-0 flex-col bg-sidebar">
      <div className="flex flex-col gap-2 p-3">
        <div className="flex items-center justify-between px-1.5 pb-1">
          <div className="flex items-center gap-2">
            <span className="flex size-7 items-center justify-center rounded-lg bg-grad-cta text-white">
              <Sparkles size={15} />
            </span>
            <span className="text-[15px] font-semibold tracking-tight">{BRAND.name}</span>
          </div>
          {onCollapse && (
            <IconButton onClick={onCollapse} aria-label="折叠侧栏" variant="muted" size="sm" shape="square">
              <PanelLeftClose size={17} />
            </IconButton>
          )}
        </div>

        <Button
          variant="secondary"
          onClick={onNew}
          className="h-auto w-full justify-start gap-2.5 rounded-xl px-3 py-2.5 text-[14px] font-medium"
        >
          <Plus size={17} />
          新建会话
        </Button>

        <div className="flex items-center gap-2 rounded-xl bg-hover px-3 py-2 transition-shadow focus-within:ring-2 focus-within:ring-ring">
          <Search size={15} className="text-faint" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索会话"
            className="w-full bg-transparent text-[13.5px] text-fg outline-none placeholder:text-faint"
          />
        </div>

        {onOpenManage && (
          <button
            onClick={onOpenManage}
            className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13.5px] font-medium text-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
          >
            <LayoutGrid size={16} className="text-faint" />
            管理中心
            <span className="ml-auto text-[11px] text-faint">记忆 · 定时 · 技能</span>
          </button>
        )}

        {onOpenTeam && (
          <button
            onClick={onOpenTeam}
            className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13.5px] font-medium text-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Users size={16} className="text-faint" />
            团队
            <span className="ml-auto text-[11px] text-faint">多智能体协作</span>
          </button>
        )}

        {onOpenMarketplace && (
          <button
            onClick={onOpenMarketplace}
            className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13.5px] font-medium text-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Store size={16} className="text-faint" />
            市场
            <span className="ml-auto text-[11px] text-faint">技能 · 智能体</span>
          </button>
        )}
      </div>

      <div className="no-scrollbar flex-1 overflow-y-auto px-2 pb-3">
        {groups.length === 0 && (
          <p className="px-3 py-6 text-center text-[13px] text-faint">暂无会话</p>
        )}
        {groups.map(([label, items]) => (
          <div key={label} className="mb-1">
            <div className="px-3 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-faint">
              {label}
            </div>
            {items.map((s) => (
              <div
                key={s.id}
                onClick={() => onSelect(s.id)}
                className={cn(
                  "group flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-[14px] transition-colors",
                  s.id === activeId ? "bg-active text-fg" : "text-muted hover:bg-hover hover:text-fg",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{s.title || "新对话"}</span>
                <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
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

      <div className="flex items-center gap-1 border-t border-border px-2 pt-2 sidebar-foot-safe-b">
        <button
          onClick={onOpenAccount}
          disabled={!onOpenAccount}
          aria-label="设置"
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg enabled:hover:bg-hover"
        >
          <Avatar tone="ink" className="text-[13px]">
            {(user?.displayName || "U").slice(0, 1).toUpperCase()}
          </Avatar>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13.5px] font-medium text-fg">
              {user?.displayName || "未登录"}
            </span>
            <span className="block truncate text-[11.5px] text-faint">
              {credits != null ? `余额 ${formatCredits(credits)} 积分` : "多模型 · 计量计费"}
            </span>
          </span>
        </button>
        {onLogout && (
          <button
            onClick={onLogout}
            aria-label="退出登录"
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-faint outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          >
            <LogOut size={16} />
          </button>
        )}
      </div>
    </aside>
  );
}
