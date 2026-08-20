import { ChevronDown, ChevronRight, Folder, MoreHorizontal } from "lucide-react";
import type { DragEvent } from "react";
import type { ChatProject } from "../../lib/types";
import { cn } from "../../lib/utils";
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
  dropActive,
  allowDrag,
  showMoveInMenu,
  canMoveUp,
  canMoveDown,
  onToggle,
  onRename,
  onDelete,
  onOpenSettings,
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
  dropActive: boolean;
  allowDrag: boolean;
  showMoveInMenu: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onToggle?: (id: string) => void;
  onRename?: (p: ChatProject) => void;
  onDelete?: (p: ChatProject) => void;
  onOpenSettings?: (p: ChatProject) => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onDragOverSession: (e: DragEvent) => void;
  onDragLeave: () => void;
  onDropSessionId: (sessionId: string) => void;
  onProjectDragStart?: (e: DragEvent) => void;
  onProjectDragOver?: (e: DragEvent) => void;
  onProjectDrop?: (e: DragEvent) => void;
}) {
  return (
    <div
      draggable={allowDrag}
      onDragStart={onProjectDragStart}
      onDragOver={(e) => {
        const types = [...e.dataTransfer.types];
        if (types.includes(SESSION_DRAG_TYPE)) {
          e.preventDefault();
          onDragOverSession(e);
          return;
        }
        if (allowDrag && types.includes(PROJECT_DRAG_TYPE)) {
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
        onProjectDrop?.(e);
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
          const swatch = PROJECT_COLORS.find((c) => c.key === p.color);
          return swatch ? (
            <span aria-hidden className={cn("size-2.5 shrink-0 rounded-full", swatch.dotClass)} />
          ) : (
            <Folder size={14} className="shrink-0 text-faint" />
          );
        })()}
        <span className="min-w-0 flex-1 truncate">{p.name}</span>
        <span className="shrink-0 text-caption text-faint">{count}</span>
      </button>
      {(onRename || onDelete || onOpenSettings || showMoveInMenu) && (
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
