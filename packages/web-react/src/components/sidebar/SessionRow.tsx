import { Archive, Pin } from "lucide-react";
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
  const duration = sessionDurationWindow(s, running, now);
  const durationText = duration ? formatCompactDuration(duration.endAt - duration.startAt) : "";
  const durationTitle = duration
    ? `${formatDate(duration.startAt, "datetime")} → ${running ? "现在" : formatDate(duration.endAt, "datetime")}`
    : undefined;

  return (
    <div
      draggable={allowDrag && Boolean(onMoveToProject)}
      onDragStart={(e) => {
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
          onMarkRead?.(s.id);
          onSelect(s.id);
        }}
        aria-current={active ? "true" : undefined}
        aria-label={title}
        className="flex h-full min-w-0 flex-1 items-center rounded-md px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className={cn("truncate", unread && "font-semibold text-fg")}>{title}</span>
      </button>
      {durationText && (
        <span
          title={durationTitle}
          data-session-duration
          className="shrink-0 tabular-nums text-[11px] text-faint"
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
                    <DropdownMenuItem onSelect={() => onMoveToProject(s, null)}>移出项目</DropdownMenuItem>
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
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
