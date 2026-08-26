import { ChevronDown, ChevronRight, Folder, MoreHorizontal, Plus } from "lucide-react";
import type { DragEvent } from "react";
import type { ChatProject } from "../../lib/types";
import { cn } from "../../lib/utils";
import { SessionStatusDot } from "../SessionStatusDot";
import { PROJECT_COLORS } from "../ProjectSettingsDialog";
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
  /** 虚拟 default 组专用：菜单只含「项目资产」。 */
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
  const showMutateMenu = canMutate && Boolean(onRename || onDelete || onOpenSettings || showMoveInMenu);
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
      className={cn(
        "group relative flex items-center gap-0.5 rounded-md pr-1 text-section transition-colors",
        dropActive ? "bg-accent-soft text-fg ring-1 ring-accent/40" : "text-muted hover:bg-hover hover:text-fg",
      )}
    >
      <button
        type="button"
        onClick={() => onToggle?.(p.id)}
        aria-expanded={!collapsed}
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {collapsed ? (
          <ChevronRight size={14} className="shrink-0 text-faint" />
        ) : (
          <ChevronDown size={14} className="shrink-0 text-faint" />
        )}
        {(() => {
          const swatch = !immutable && PROJECT_COLORS.find((c) => c.key === p.color);
          return swatch ? (
            <span aria-hidden className={cn("size-2.5 shrink-0 rounded-full", swatch.dotClass)} />
          ) : (
            <Folder size={14} className="shrink-0 text-faint" />
          );
        })()}
        <span className="min-w-0 flex-1 truncate">{p.name}</span>
        {collapsed && runningCount > 0 && (
          <span
            data-project-running={runningCount}
            title={`${runningCount} 个运行中`}
            aria-label={`${runningCount} 个运行中`}
            className="flex shrink-0 items-center gap-1"
          >
            <SessionStatusDot running />
            <span className="tabular-nums text-caption text-fg">{runningCount}</span>
          </span>
        )}
        <span className="shrink-0 text-caption text-faint">{count}</span>
      </button>
      {onNewSession && (
        <IconButton
          aria-label={`在 ${p.name} 新建会话`}
          title="新建会话"
          variant="muted"
          size="xs"
          shape="square"
          className="shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
          onClick={onNewSession}
        >
          <Plus size={13} />
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
              className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
            >
              <MoreHorizontal size={13} />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            {onNewSession && (
              <DropdownMenuItem
                className="[@media(hover:none)]:min-h-11"
                onSelect={() => onNewSession()}
              >
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
                项目资产
              </DropdownMenuItem>
            )}
            {onOpenSettings && (
              <DropdownMenuItem onSelect={() => onOpenSettings(p)}>项目设置</DropdownMenuItem>
            )}
            {onRename && <DropdownMenuItem onSelect={() => onRename(p)}>重命名</DropdownMenuItem>}
            {showMoveInMenu && (
              <>
                <DropdownMenuItem disabled={!canMoveUp} onSelect={() => onMoveUp?.()}>
                  上移
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!canMoveDown} onSelect={() => onMoveDown?.()}>
                  下移
                </DropdownMenuItem>
              </>
            )}
            {(onRename || onOpenSettings || showMoveInMenu) && onDelete && <DropdownMenuSeparator />}
            {onDelete && (
              <DropdownMenuItem destructive onSelect={() => onDelete(p)}>
                删除
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
