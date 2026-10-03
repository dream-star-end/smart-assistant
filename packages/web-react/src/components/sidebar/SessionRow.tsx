import {
  Archive,
  FolderInput,
  MoreHorizontal,
  Pencil,
  Pin,
  SquareCheck,
  Trash2,
} from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useRef, useState } from "react";
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

/** 触屏长按呼出行菜单的阈值（与 iOS 系统长按手感接近）。 */
const LONG_PRESS_MS = 450;
/** 长按期间手指位移超过此值视为滚动，取消长按。 */
const LONG_PRESS_SLOP_PX = 8;

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
  const [menuOpen, setMenuOpen] = useState(false);
  // 触屏长按：iOS Safari 不派发 contextmenu，自己计时；长按成功后吞掉随后的那次 click，
  // 避免「呼出菜单 + 顺带切会话」。每次按下先复位，残留标记不会吞掉下一次正常点按。
  const pressRef = useRef<{ timer: number; x: number; y: number } | null>(null);
  const swallowClickRef = useRef(false);
  const cancelPress = () => {
    if (!pressRef.current) return;
    window.clearTimeout(pressRef.current.timer);
    pressRef.current = null;
  };
  const onRowPointerDown = (e: ReactPointerEvent) => {
    swallowClickRef.current = false;
    if (e.pointerType !== "touch" || multiSelect) return;
    cancelPress();
    const { clientX: x, clientY: y } = e;
    pressRef.current = {
      x,
      y,
      timer: window.setTimeout(() => {
        pressRef.current = null;
        swallowClickRef.current = true;
        navigator.vibrate?.(8);
        setMenuOpen(true);
      }, LONG_PRESS_MS),
    };
  };
  const onRowPointerMove = (e: ReactPointerEvent) => {
    const p = pressRef.current;
    if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > LONG_PRESS_SLOP_PX) cancelPress();
  };

  const duration = sessionDurationWindow(s, running, now);
  const durationText = duration ? formatCompactDuration(duration.endAt - duration.startAt) : "";
  const durationTitle = duration
    ? `${formatDate(duration.startAt, "datetime")} → ${running ? "现在" : formatDate(duration.endAt, "datetime")}`
    : undefined;

  return (
    // 外层只负责行高、缩进与层级引导线；可见的「药丸」是内层，选中/悬停态都画在内层上，
    // 引导线因此不会被选中卡片盖住（SIDEBAR-R1）。
    <div
      draggable={allowDrag && Boolean(onMoveToProject)}
      onDragStart={(e) => {
        e.dataTransfer.setData(SESSION_DRAG_TYPE, s.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      style={{ height: "100%" }}
      data-session-row
      className={cn("relative py-px", indent && "pl-[22px]")}
    >
      {indent && (
        <span
          aria-hidden
          data-session-guide
          className="pointer-events-none absolute inset-y-0 left-[15px] w-px bg-border"
        />
      )}
      <div
        onPointerDown={onRowPointerDown}
        onPointerMove={onRowPointerMove}
        onPointerUp={cancelPress}
        onPointerCancel={cancelPress}
        onPointerLeave={cancelPress}
        onContextMenu={(e) => {
          // 桌面右键 / Android 长按：直接呼出同一份行菜单。多选态下保持系统默认。
          if (multiSelect) return;
          e.preventDefault();
          cancelPress();
          setMenuOpen(true);
        }}
        data-active={active ? "true" : undefined}
        className={cn(
          "group relative flex h-full items-center gap-2 rounded-sm pl-2.5 pr-1 text-section transition-[background-color,color,box-shadow] duration-150 ease-standard",
          "[-webkit-touch-callout:none] [@media(hover:none)]:select-none",
          active
            ? "bg-sidebar-active text-fg shadow-sidebar-active"
            : selected
              ? "bg-accent-soft text-fg"
              : "text-muted hover:bg-hover hover:text-fg",
          menuOpen && !active && "bg-hover text-fg",
        )}
      >
        {/* 多选态复选框放在状态点左侧而不是替换它：勾选时仍能看到运行 / 出错 / 未读（SR-04）。 */}
        {multiSelect && (
          <label className="relative z-[1] -ml-1 flex h-full min-w-6 shrink-0 items-center justify-center [@media(hover:none)]:min-h-11 [@media(hover:none)]:min-w-11">
            <input
              type="checkbox"
              checked={selected}
              onChange={() => onToggleSelected(s.id)}
              aria-label={`选择 ${title}`}
              className="size-3.5 accent-accent"
            />
          </label>
        )}
        <span
          data-session-lead
          className="relative z-[1] flex size-3 shrink-0 items-center justify-center"
        >
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
            if (swallowClickRef.current) {
              swallowClickRef.current = false;
              return;
            }
            onMarkRead?.(s.id);
            onSelect(s.id);
          }}
          aria-current={active ? "true" : undefined}
          aria-label={title}
          // 命中区铺满整行：点状态点 / 用时区也能切会话（原先只有标题文字可点）。
          className="flex h-full min-w-0 flex-1 items-center rounded-sm text-left outline-none after:absolute after:inset-0 after:rounded-sm after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-ring"
        >
          <span
            className={cn(
              "truncate",
              active && "font-medium",
              unread && !active && "font-semibold text-fg",
            )}
          >
            {highlightQuery?.trim() ? (
              <HighlightedText text={title} query={highlightQuery} />
            ) : (
              title
            )}
          </span>
        </button>
        {/* 尾部槽：用时与「更多」叠放在同一位置。桌面悬停 / 键盘聚焦 / 菜单打开时用时淡出、「更多」淡入，
            标题不再常年被一个隐形的 24px 按钮挤掉宽度。触屏只在当前会话常显「更多」，
            其余行长按呼出同一菜单 —— 268px 抽屉里每行标题因此多出 44px（SIDEBAR-R1）。 */}
        <div
          className={cn(
            "relative z-[1] flex h-full shrink-0 items-center justify-end",
            active ? "min-w-6" : "min-w-6 [@media(hover:none)]:min-w-0",
          )}
        >
          {durationText && (
            <span
              title={durationTitle}
              data-session-duration
              className={cn(
                "pointer-events-none pr-1 tabular-nums text-caption text-faint transition-opacity duration-150",
                "[@media(hover:hover)]:group-hover:opacity-0 [@media(hover:hover)]:group-focus-within:opacity-0",
                menuOpen && "opacity-0",
                active && "[@media(hover:none)]:hidden",
              )}
            >
              {durationText}
            </span>
          )}
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <IconButton
                aria-label="更多"
                variant="muted"
                size="xs"
                shape="square"
                className={cn(
                  "absolute right-0 top-1/2 -translate-y-1/2 rounded-xs opacity-0 transition-opacity duration-150 data-[state=open]:opacity-100",
                  "[@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100",
                  active
                    ? "[@media(hover:none)]:static [@media(hover:none)]:translate-y-0 [@media(hover:none)]:opacity-100"
                    : "[@media(hover:none)]:invisible",
                )}
              >
                <MoreHorizontal size={14} />
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
      </div>
    </div>
  );
}
