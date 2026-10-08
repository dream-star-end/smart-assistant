import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Folder,
  FolderOpen,
  Inbox,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Plus,
  Settings2,
  Trash2,
} from "lucide-react";
import type { DragEvent } from "react";
import { PROJECT_COLORS } from "../../lib/projectColors";
import type { ChatProject } from "../../lib/types";
import { cn } from "../../lib/utils";
import { SessionStatusDot } from "../SessionStatusDot";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
} from "../ui";
import { PROJECT_DRAG_TYPE, SESSION_DRAG_TYPE } from "./constants";

export function ProjectRow({
  project: p,
  count,
  collapsed,
  runningCount = 0,
  dropActive,
  allowDrag,
  showMoveInMenu,
  canMoveUp,
  canMoveDown,
  immutable,
  onToggle,
  onRename,
  onDelete,
  onOpenSettings,
  onOpenAssets,
  /** 在该项目下直接新建会话（非 default 组才由 Sidebar 传入）。 */
  onNewSession,
  onMoveUp,
  onMoveDown,
  onDragOverSession,
  onDragLeave,
  onDropSessionId,
  onProjectDragStart,
  onProjectDragOver,
  onProjectDrop,
}: {
  project: ChatProject;
  count: number;
  collapsed: boolean;
  /** 折叠时组内运行中数量；展开不展示，避免与会话行蓝点重复。 */
  runningCount?: number;
  dropActive: boolean;
  allowDrag: boolean;
  showMoveInMenu: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  /** 虚拟 default 分组：可折叠、可接收会话，不可改名/删除/改色/拖拽排序。 */
  immutable?: boolean;
  onToggle?: (id: string) => void;
  onRename?: (p: ChatProject) => void;
  onDelete?: (p: ChatProject) => void;
  onOpenSettings?: (p: ChatProject) => void;
  /** 虚拟 default 组专用：菜单只含「未分类的文件」。 */
  onOpenAssets?: (p: ChatProject) => void;
  /** 在该项目下直接新建会话；default 组不传（顶部「新建会话」已覆盖未分类）。 */
  onNewSession?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onDragOverSession: (e: DragEvent) => void;
  onDragLeave: () => void;
  onDropSessionId: (sessionId: string) => void;
  onProjectDragStart?: (e: DragEvent) => void;
  onProjectDragOver?: (e: DragEvent) => void;
  onProjectDrop?: (e: DragEvent) => void;
}) {
  const canMutate = !immutable;
  const showMutateMenu =
    canMutate && Boolean(onRename || onDelete || onOpenSettings || showMoveInMenu);
  const showAssetsOnlyMenu = Boolean(immutable && onOpenAssets);
  const showMenu = showMutateMenu || showAssetsOnlyMenu;
  return (
    <div
      draggable={canMutate && allowDrag}
      onDragStart={canMutate ? onProjectDragStart : undefined}
      onDragOver={(e) => {
        const types = [...e.dataTransfer.types];
        if (types.includes(SESSION_DRAG_TYPE)) {
          e.preventDefault();
          onDragOverSession(e);
          return;
        }
        if (canMutate && allowDrag && types.includes(PROJECT_DRAG_TYPE)) {
          e.preventDefault();
          onProjectDragOver?.(e);
        }
      }}
      onDragLeave={onDragLeave}
      onDrop={(e) => {
        e.preventDefault();
        const sid = e.dataTransfer.getData(SESSION_DRAG_TYPE);
        if (sid) {
          onDropSessionId(sid);
          return;
        }
        if (canMutate) onProjectDrop?.(e);
      }}
      style={{ height: "100%" }}
      data-project-row
      className="relative py-px"
    >
      <div
        className={cn(
          "group relative flex h-full items-center rounded-sm text-section transition-[background-color,box-shadow] duration-150 ease-standard",
          dropActive ? "bg-accent-soft text-fg ring-1 ring-accent/40" : "text-fg hover:bg-hover",
        )}
      >
        <button
          type="button"
          onClick={() => onToggle?.(p.id)}
          aria-expanded={!collapsed}
          className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-sm pl-2 pr-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {/* 图标列与子会话的层级引导线同一中轴（SessionRow left-[15px]）：树形结构一眼可读。 */}
          <span className="flex size-3.5 shrink-0 items-center justify-center text-faint">
            {(() => {
              const swatch = !immutable && PROJECT_COLORS.find((c) => c.key === p.color);
              if (swatch)
                return (
                  <span aria-hidden className={cn("size-2.5 rounded-full", swatch.dotClass)} />
                );
              if (immutable) return <Inbox size={14} aria-hidden />;
              return collapsed ? (
                <Folder size={14} aria-hidden />
              ) : (
                <FolderOpen size={14} aria-hidden />
              );
            })()}
          </span>
          <span className="min-w-0 truncate font-medium">{p.name}</span>
          {/* 展开/折叠指示跟在名字后面、随状态旋转，左侧图标列留给项目身份（颜色 / 文件夹）。 */}
          <ChevronRight
            size={12}
            aria-hidden
            className={cn(
              "shrink-0 text-faint transition-transform duration-200 ease-standard",
              !collapsed && "rotate-90",
            )}
          />
          <span className="min-w-0 flex-1" />
          <span
            className={cn(
              "flex shrink-0 items-center gap-1.5 transition-opacity duration-150",
              // 桌面悬停 / 聚焦时让位给右侧操作钮（叠放，不再常年占宽）。
              (onNewSession || showMenu) &&
                "[@media(hover:hover)]:group-hover:opacity-0 [@media(hover:hover)]:group-focus-within:opacity-0",
            )}
          >
            {collapsed && runningCount > 0 && (
              // 运行中数做成独立 pill，与右侧总数分开，不再被读成「12」（PR-01）。
              <span
                data-project-running={runningCount}
                title={`${runningCount} 个运行中`}
                aria-label={`${runningCount} 个运行中`}
                className="flex shrink-0 items-center gap-1 rounded-full bg-info-soft px-1.5 py-px"
              >
                <SessionStatusDot running />
                <span className="tabular-nums text-caption text-info">{runningCount}</span>
              </span>
            )}
            <span className="tabular-nums text-caption text-faint">{count}</span>
          </span>
        </button>
        <div
          className={cn(
            "absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity duration-150",
            "[@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100 has-[[data-state=open]]:opacity-100",
            // 触屏没有悬停：「…」常显并回到文档流（「+」在触屏隐藏，菜单第一项就是新建会话）。
            "[@media(hover:none)]:static [@media(hover:none)]:translate-y-0 [@media(hover:none)]:opacity-100",
          )}
        >
          {onNewSession && (
            // 触屏下「+」「…」两个 44px 常显按钮会把 268px 抽屉里的项目名挤到只剩 4 个字（PR-02）：
            // 触屏只留「…」菜单（菜单第一项就是「新建会话」），桌面 hover 仍直达。
            <IconButton
              aria-label={`在 ${p.name} 新建会话`}
              title="新建会话"
              variant="muted"
              size="xs"
              shape="square"
              className="shrink-0 rounded-xs [@media(hover:none)]:hidden"
              onClick={onNewSession}
            >
              <Plus size={14} />
            </IconButton>
          )}
          {showMenu && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton
                  aria-label={`项目 ${p.name} 更多`}
                  variant="muted"
                  size="xs"
                  shape="square"
                  className="rounded-xs"
                >
                  <MoreHorizontal size={14} />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                {onNewSession && (
                  <DropdownMenuItem
                    className="[@media(hover:none)]:min-h-11"
                    onSelect={() => onNewSession()}
                  >
                    <Plus size={14} className="shrink-0 text-muted" />
                    新建会话
                  </DropdownMenuItem>
                )}
                {onNewSession && (onOpenSettings || onRename || showMoveInMenu || onDelete) && (
                  <DropdownMenuSeparator />
                )}
                {showAssetsOnlyMenu && (
                  <DropdownMenuItem
                    className="[@media(hover:none)]:min-h-11"
                    onSelect={() => onOpenAssets?.(p)}
                  >
                    <Paperclip size={14} className="shrink-0 text-muted" />
                    未分类的文件
                  </DropdownMenuItem>
                )}
                {onOpenSettings && (
                  <DropdownMenuItem onSelect={() => onOpenSettings(p)}>
                    <Settings2 size={14} className="shrink-0 text-muted" />
                    项目设置
                  </DropdownMenuItem>
                )}
                {onRename && (
                  <DropdownMenuItem onSelect={() => onRename(p)}>
                    <Pencil size={14} className="shrink-0 text-muted" />
                    重命名
                  </DropdownMenuItem>
                )}
                {showMoveInMenu && (
                  <>
                    <DropdownMenuItem disabled={!canMoveUp} onSelect={() => onMoveUp?.()}>
                      <ArrowUp size={14} className="shrink-0 text-muted" />
                      上移
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={!canMoveDown} onSelect={() => onMoveDown?.()}>
                      <ArrowDown size={14} className="shrink-0 text-muted" />
                      下移
                    </DropdownMenuItem>
                  </>
                )}
                {(onRename || onOpenSettings || showMoveInMenu) && onDelete && (
                  <DropdownMenuSeparator />
                )}
                {onDelete && (
                  <DropdownMenuItem destructive onSelect={() => onDelete(p)}>
                    <Trash2 size={14} className="shrink-0" />
                    删除
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
    </div>
  );
}
