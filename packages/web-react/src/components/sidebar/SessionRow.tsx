import { Archive, Pin, RotateCcw, Trash2 } from "lucide-react";
import type { ChatProject, Session } from "../../lib/types";
import { isSidebarSessionRunning } from "../../lib/sessionStatus";
import { cn } from "../../lib/utils";
import { SessionStatusDot } from "../SessionStatusDot";
import { formatDate } from "../ui/TimeAgo";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  IconButton,
} from "../ui";
import { MoreHorizontal } from "lucide-react";
import { SESSION_DRAG_TYPE } from "./constants";
import { formatCompactDuration, sessionDurationWindow } from "./compactDuration";

/** 回收站保留期：3 天（与后端 purge 调度一致）。 */
const TRASH_RETENTION_MS = 3 * 24 * 3600 * 1000;

/** 回收站行右侧「{n} 天后清理」：n 至少 1（删除当天显示 3，次日 2……到期当天 1）。 */
export function trashDaysLeft(deletedAt: number, now: number): number {
  return Math.max(1, Math.ceil((deletedAt + TRASH_RETENTION_MS - now) / (24 * 3600 * 1000)));
}

export function SessionRow({
  session: s,
  active,
  projects,
  indent,
  isSending,
  liveTerminal,
  now,
  onSelect,
  onRename,
  onDelete,
  onTogglePin,
  onMoveToProject,
  onArchive,
  onRestore,
  onPurge,
  onMarkRead,
  unread,
  multiSelect,
  selected,
  onToggleSelected,
  onEnterMultiSelect,
  allowDrag,
}: {
  session: Session;
  active: boolean;
  projects: ChatProject[];
  indent?: boolean;
  isSending?: (id: string) => boolean;
  liveTerminal?: (id: string) => { lastOutcome?: string | null; lastErrorCode?: string | null } | undefined;
  now: number;
  onSelect: (id: string) => void;
  onRename: (s: Session) => void;
  onDelete: (s: Session) => void;
  onTogglePin?: (s: Session) => void;
  onMoveToProject?: (s: Session, projectId: string | null) => void;
  onArchive?: (s: Session) => void;
  /** 回收站行专用：还原 / 彻底删除（deletedAt 非空时菜单只余这两项）。 */
  onRestore?: (s: Session) => void;
  onPurge?: (s: Session) => void;
  onMarkRead?: (id: string) => void;
  unread?: boolean;
  multiSelect: boolean;
  selected: boolean;
  onToggleSelected: (id: string) => void;
  onEnterMultiSelect: (id: string) => void;
  allowDrag: boolean;
}) {
  const live = liveTerminal?.(s.id);
  const running = isSidebarSessionRunning(s, { isSending, liveTerminal });
  const title = s.title || "新对话";
  // 回收站行：不可打开、不可拖拽；菜单只剩 还原/彻底删除。
  const trashed = s.deletedAt != null;
  const cleanupIn = trashed && s.deletedAt != null ? trashDaysLeft(s.deletedAt, now) : null;
  const duration = trashed ? null : sessionDurationWindow(s, running, now);
  const durationText = duration ? formatCompactDuration(duration.endAt - duration.startAt) : "";
  const durationTitle = duration
    ? `${formatDate(duration.startAt, "datetime")} → ${running ? "现在" : formatDate(duration.endAt, "datetime")}`
    : undefined;

  return (
    <div
      draggable={allowDrag && Boolean(onMoveToProject) && !trashed}
      onDragStart={(e) => {
        if (trashed) {
          e.preventDefault();
          return;
        }
        e.dataTransfer.setData(SESSION_DRAG_TYPE, s.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      style={{ height: "100%" }}
      className={cn(
        "group relative flex items-center gap-1 rounded-md pr-1 text-section transition-colors",
        indent && "pl-1",
        active ? "bg-active text-fg" : "text-muted hover:bg-hover hover:text-fg",
      )}
    >
      {active && (
        <span aria-hidden className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-accent" />
      )}
      {multiSelect ? (
        <label className="flex h-full min-h-11 min-w-11 shrink-0 items-center justify-center">
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelected(s.id)}
            aria-label={`选择 ${title}`}
            className="size-3.5 accent-accent"
          />
        </label>
      ) : (
        <span data-session-lead className="flex size-3.5 shrink-0 items-center justify-center">
          <SessionStatusDot
            running={running}
            lastOutcome={live?.lastOutcome ?? s.lastOutcome}
            lastErrorCode={live?.lastErrorCode ?? s.lastErrorCode}
            unread={unread}
          />
        </span>
      )}
      <button
        type="button"
        onClick={() => {
          // 回收站行不可打开为活动会话（也无需标已读）。
          if (trashed) return;
          onMarkRead?.(s.id);
          onSelect(s.id);
        }}
        aria-current={active ? "true" : undefined}
        aria-label={title}
        aria-disabled={trashed ? "true" : undefined}
        className="flex h-full min-w-0 flex-1 items-center rounded-md px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className={cn("truncate", unread && "font-semibold text-fg")}>{title}</span>
      </button>
      {cleanupIn != null && (
        <span data-session-cleanup className="shrink-0 tabular-nums text-caption text-faint">
          {cleanupIn} 天后清理
        </span>
      )}
      {durationText && (
        <span
          title={durationTitle}
          data-session-duration
          className="shrink-0 tabular-nums text-caption text-faint"
        >
          {durationText}
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton
            aria-label="更多"
            variant="muted"
            size="xs"
            shape="square"
            className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
          >
            <MoreHorizontal size={13} />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44" onCloseAutoFocus={(e) => e.preventDefault()}>
          {trashed ? (
            <>
              {onRestore && (
                <DropdownMenuItem onSelect={() => onRestore(s)}>
                  <RotateCcw size={14} className="shrink-0 text-muted" />
                  还原
                </DropdownMenuItem>
              )}
              {onPurge && (
                <DropdownMenuItem destructive onSelect={() => onPurge(s)}>
                  <Trash2 size={14} className="shrink-0" />
                  彻底删除
                </DropdownMenuItem>
              )}
            </>
          ) : (
            <>
              <DropdownMenuItem onSelect={() => onRename(s)}>重命名</DropdownMenuItem>
              {onTogglePin && (
                <DropdownMenuItem onSelect={() => onTogglePin(s)}>
                  <Pin size={14} className="shrink-0 text-muted" />
                  {s.pinned ? "取消置顶" : "置顶"}
                </DropdownMenuItem>
              )}
              {onArchive && (
                <DropdownMenuItem onSelect={() => onArchive(s)}>
                  <Archive size={14} className="shrink-0 text-muted" />
                  {s.archived ? "取消归档" : "归档"}
                </DropdownMenuItem>
              )}
              {onMoveToProject && (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>移动到项目</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-44">
                    {projects.length === 0 && (
                      <DropdownMenuItem disabled>还没有项目</DropdownMenuItem>
                    )}
                    {projects.map((p) => (
                      <DropdownMenuItem
                        key={p.id}
                        disabled={s.projectId === p.id}
                        onSelect={() => onMoveToProject(s, p.id)}
                      >
                        {p.name}
                      </DropdownMenuItem>
                    ))}
                    {s.projectId && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => onMoveToProject(s, null)}>
                          移出项目
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              )}
              <DropdownMenuItem onSelect={() => onEnterMultiSelect(s.id)}>多选</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onSelect={() => onDelete(s)}>
                删除
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
