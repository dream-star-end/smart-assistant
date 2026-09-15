import {
  Archive,
  FolderInput,
  MoreHorizontal,
  Pencil,
  Pin,
  SquareCheck,
  Trash2,
} from "lucide-react";
import { useRef } from "react";
import { isSidebarSessionRunning } from "../../lib/sessionStatus";
import type { ChatProject, Session } from "../../lib/types";
import { cn } from "../../lib/utils";
import { SessionStatusDot } from "../SessionStatusDot";
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
import { formatDate } from "../ui/TimeAgo";
import { formatCompactDuration, sessionDurationWindow } from "./compactDuration";
import { SESSION_DRAG_TYPE } from "./constants";
import { HighlightedText } from "./highlight";

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
  highlightQuery,
}: {
  session: Session;
  active: boolean;
  projects: ChatProject[];
  indent?: boolean;
  isSending?: (id: string) => boolean;
  liveTerminal?: (
    id: string,
  ) => { lastOutcome?: string | null; lastErrorCode?: string | null } | undefined;
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
  /** 搜索态：标题里的命中词与消息命中一样用 <mark> 标出（S-11）。 */
  highlightQuery?: string;
}) {
  const live = liveTerminal?.(s.id);
  const running = isSidebarSessionRunning(s, { isSending, liveTerminal });
  const title = s.title || "新对话";
  // 「更多」菜单关闭后的焦点归还：鼠标关闭不把焦点拉回 hover 才可见的触发钮（原行为），
  // 键盘关闭则保留 Radix 默认把焦点还给触发钮，Tab 序列不再从 body 重头开始（SR-02）。
  const menuViaKeyboardRef = useRef(false);
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
        // 项目内会话缩进从 4px 提到 16px，层级在视觉上可辨（SR-04）。
        indent && "pl-4",
        active ? "bg-active text-fg" : "text-muted hover:bg-hover hover:text-fg",
      )}
    >
      {active && (
        <span aria-hidden className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-accent" />
      )}
      {/* 多选态复选框放在状态点左侧而不是替换它：勾选时仍能看到运行 / 出错 / 未读（SR-04）。 */}
      {multiSelect && (
        <label className="flex h-full min-h-11 min-w-8 shrink-0 items-center justify-center [@media(hover:none)]:min-w-11">
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelected(s.id)}
            aria-label={`选择 ${title}`}
            className="size-3.5 accent-accent"
          />
        </label>
      )}
      <span data-session-lead className="flex size-3.5 shrink-0 items-center justify-center">
        <SessionStatusDot
          running={running}
          lastOutcome={live?.lastOutcome ?? s.lastOutcome}
          lastErrorCode={live?.lastErrorCode ?? s.lastErrorCode}
          unread={unread}
        />
      </span>
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
        <span className={cn("truncate", unread && "font-semibold text-fg")}>
          {highlightQuery?.trim() ? <HighlightedText text={title} query={highlightQuery} /> : title}
        </span>
      </button>
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
        <DropdownMenuContent
          align="end"
          className="w-44"
          onKeyDown={() => {
            menuViaKeyboardRef.current = true;
          }}
          onPointerDown={() => {
            menuViaKeyboardRef.current = false;
          }}
          onCloseAutoFocus={(e) => {
            if (!menuViaKeyboardRef.current) e.preventDefault();
            menuViaKeyboardRef.current = false;
          }}
        >
          <DropdownMenuItem onSelect={() => onRename(s)}>
            <Pencil size={14} className="shrink-0 text-muted" />
            重命名
          </DropdownMenuItem>
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
              <DropdownMenuSubTrigger>
                <FolderInput size={14} className="shrink-0 text-muted" />
                移动到项目
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-44">
                {projects.length === 0 && <DropdownMenuItem disabled>还没有项目</DropdownMenuItem>}
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
          <DropdownMenuItem onSelect={() => onEnterMultiSelect(s.id)}>
            <SquareCheck size={14} className="shrink-0 text-muted" />
            多选
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive onSelect={() => onDelete(s)}>
            <Trash2 size={14} className="shrink-0" />
            删除
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
