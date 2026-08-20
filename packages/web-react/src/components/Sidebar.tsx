import {
  Archive,
  BookOpen,
  Building2,
  ChevronDown,
  ChevronRight,
  Film,
  Kanban,
  LayoutGrid,
  LogOut,
  MessageSquareText,
  PanelLeftClose,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Store,
} from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";
import type { Theme } from "../hooks/useTheme";
import { BRAND } from "../lib/brand";
import { PRODUCT_CAPABILITIES } from "../lib/productCapabilities";
import type {
  ChatProject,
  Session,
  SessionBatchAction,
  SessionSearchHit,
  User,
} from "../lib/types";
import { isSidebarSessionRunning } from "../lib/sessionStatus";
import { cn, formatCredits } from "../lib/utils";
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
import { BatchBar } from "./sidebar/BatchBar";
import {
  DEFAULT_PROJECT_ID,
  PROJECT_DRAG_TYPE,
  SEARCH_DEBOUNCE_MS,
  SIDEBAR_DURATION_TICK_MS,
  VIRTUALIZE_THRESHOLD,
} from "./sidebar/constants";
import { type FlatItem, flattenSidebarItems } from "./sidebar/flattenItems";
import { HighlightedText } from "./sidebar/highlight";
import { ProjectRow } from "./sidebar/ProjectRow";
import {
  compareByUpdatedDesc,
  compareSessionsRunningThenUpdated,
  partitionProjectsRunningFirst,
  sortSessionsRunningThenUpdated,
} from "./sidebar/runningOrder";
import { SessionRow } from "./sidebar/SessionRow";
import { VirtualList } from "./sidebar/VirtualList";

function useCoarsePointer(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== "function") return () => {};
      const mq = window.matchMedia("(hover: none)");
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => typeof window.matchMedia === "function" && window.matchMedia("(hover: none)").matches,
    () => false,
  );
}

export type SidebarProps = {
  sessions: Session[];
  activeId?: string;
  user: User | null;
  credits?: string | null;
  optimizerPending?: number;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (s: Session) => void;
  onDelete: (s: Session) => void;
  onTogglePin?: (s: Session) => void;
  onMoveToProject?: (s: Session, projectId: string | null) => void;
  projects?: ChatProject[];
  collapsedProjectIds?: Set<string>;
  onToggleProjectCollapsed?: (id: string) => void;
  onCreateProject?: () => void;
  onRenameProject?: (p: ChatProject) => void;
  onDeleteProject?: (p: ChatProject) => void;
  isSending?: (id: string) => boolean;
  liveTerminal?: (id: string) => { lastOutcome?: string | null; lastErrorCode?: string | null } | undefined;
  socketVersion?: number;
  onCollapse?: () => void;
  onLogout?: () => void;
  onOpenAccount?: () => void;
  onOpenFeedback?: () => void;
  onOpenManage?: () => void;
  onOpenMarketplace?: () => void;
  onOpenTutorial?: () => void;
  onOpenOrg?: () => void;
  onOpenBoard?: () => void;
  onOpenMediaTasks?: () => void;
  boardActive?: boolean;
  showAdmin?: boolean;
  theme?: Theme;
  onCycleTheme?: () => void;
  unreadIds?: Set<string>;
  onMarkRead?: (id: string) => void;
  onOpenProjectSettings?: (p: ChatProject) => void;
  /** 打开某项目的资产面板；default 组传 null。 */
  onOpenProjectAssets?: (projectId: string | null) => void;
  onReorderProjects?: (orderedIds: string[]) => void;
  width?: number;
  onResizeStart?: (e: ReactPointerEvent) => void;
  resizing?: boolean;
  onArchive?: (s: Session) => void;
  onBatch?: (ids: string[], action: SessionBatchAction, projectId?: string | null) => void;
  onLoadMore?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadArchived?: () => void;
  loadingArchived?: boolean;
  onSearchMessages?: (q: string, signal: AbortSignal) => Promise<SessionSearchHit[]>;
  virtualizeThreshold?: number;
};

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
  onTogglePin,
  onMoveToProject,
  projects,
  collapsedProjectIds,
  onToggleProjectCollapsed,
  onCreateProject,
  onRenameProject,
  onDeleteProject,
  isSending,
  liveTerminal,
  socketVersion,
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
  unreadIds,
  onMarkRead,
  onOpenProjectSettings,
  onOpenProjectAssets,
  onReorderProjects,
  width,
  onResizeStart,
  resizing,
  onArchive,
  onBatch,
  onLoadMore,
  hasMore,
  loadingMore,
  onLoadArchived,
  loadingArchived,
  onSearchMessages,
  virtualizeThreshold = VIRTUALIZE_THRESHOLD,
}: SidebarProps) {
  const [q, setQ] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [dragOverProjectId, setDragOverProjectId] = useState<string | null>(null);
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [multiSelect, setMultiSelect] = useState(false);
  const [orderOverride, setOrderOverride] = useState<string[] | null>(null);
  const [searchHits, setSearchHits] = useState<SessionSearchHit[]>([]);
  const [searchRemote, setSearchRemote] = useState<"idle" | "loading" | "empty" | "error">("idle");
  const coarse = useCoarsePointer();
  const searching = q.trim().length > 0;
  const showProjects = Array.isArray(projects) && Boolean(onCreateProject);

  const runningIds = useMemo(() => {
    void socketVersion;
    const ids = new Set<string>();
    for (const s of sessions) {
      if (s.archived) continue;
      if (isSidebarSessionRunning(s, { isSending, liveTerminal })) ids.add(s.id);
    }
    return ids;
  }, [sessions, isSending, liveTerminal, socketVersion]);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), SIDEBAR_DURATION_TICK_MS);
    return () => window.clearInterval(t);
  }, []);

  const orderedProjects = useMemo(() => {
    const list = projects ?? [];
    if (!orderOverride) return list;
    const map = new Map(list.map((p) => [p.id, p]));
    const out: ChatProject[] = [];
    for (const id of orderOverride) {
      const p = map.get(id);
      if (p) out.push(p);
    }
    for (const p of list) if (!orderOverride.includes(p.id)) out.push(p);
    return out;
  }, [projects, orderOverride]);

  const activeSessions = useMemo(() => sessions.filter((s) => !s.archived), [sessions]);
  const archivedSessions = useMemo(
    () => sessions.filter((s) => s.archived).sort(compareByUpdatedDesc),
    [sessions],
  );

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const pool = searching ? sessions.filter((s) => !s.archived || archivedExpanded) : activeSessions;
    if (!needle) return pool;
    return pool.filter((s) => (s.title || "新对话").toLowerCase().includes(needle));
  }, [activeSessions, sessions, q, searching, archivedExpanded]);

  const pinned = useMemo(
    () => (searching ? [] : sortSessionsRunningThenUpdated(filtered.filter((s) => s.pinned), runningIds)),
    [filtered, searching, runningIds],
  );
  const pinnedIds = useMemo(() => new Set(pinned.map((s) => s.id)), [pinned]);

  const projectSessions = useMemo(() => {
    const map = new Map<string, Session[]>();
    if (searching) return map;
    for (const s of filtered) {
      if (pinnedIds.has(s.id) || !s.projectId) continue;
      const list = map.get(s.projectId) || [];
      list.push(s);
      map.set(s.projectId, list);
    }
    for (const list of map.values()) list.sort((a, b) => compareSessionsRunningThenUpdated(a, b, runningIds));
    return map;
  }, [filtered, pinnedIds, searching, runningIds]);

  const ungroupedGroups = useMemo(() => {
    if (searching) {
      const items = filtered.slice().sort((a, b) => {
        if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
        return compareSessionsRunningThenUpdated(a, b, runningIds);
      });
      return items.length ? ([["搜索结果", items]] as [string, Session[]][]) : [];
    }
    const list = sortSessionsRunningThenUpdated(
      filtered.filter((s) => !pinnedIds.has(s.id) && !s.projectId),
      runningIds,
    );
    return list.length ? ([["", list]] as [string, Session[]][]) : [];
  }, [filtered, pinnedIds, searching, runningIds]);

  useEffect(() => {
    const needle = q.trim();
    if (!needle || !onSearchMessages) {
      setSearchHits([]);
      setSearchRemote("idle");
      return;
    }
    setSearchRemote("loading");
    const ac = new AbortController();
    const timer = window.setTimeout(() => {
      void onSearchMessages(needle, ac.signal)
        .then((hits) => {
          if (ac.signal.aborted) return;
          setSearchHits(hits);
          setSearchRemote(hits.length === 0 ? "empty" : "idle");
        })
        .catch((e: unknown) => {
          if (ac.signal.aborted) return;
          if (e instanceof DOMException && e.name === "AbortError") return;
          setSearchHits([]);
          setSearchRemote("error");
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      ac.abort();
    };
  }, [q, onSearchMessages]);

  const displayProjects = useMemo(
    () =>
      partitionProjectsRunningFirst(orderedProjects, (id) =>
        (projectSessions.get(id) ?? []).some((s) => runningIds.has(s.id)),
      ),
    [orderedProjects, projectSessions, runningIds],
  );

  const flatItems = useMemo(
    () =>
      flattenSidebarItems({
        searching,
        showProjects,
        pinned,
        projects: displayProjects,
        projectSessions,
        sessions: activeSessions,
        ungroupedGroups,
        collapsedProjectIds,
        archived: archivedSessions,
        archivedExpanded,
        archivedLoading: loadingArchived,
        searchHits,
        searchRemote,
        localEmpty: filtered.length === 0,
        isRunning: (s) => runningIds.has(s.id),
      }),
    [
      searching,
      showProjects,
      pinned,
      displayProjects,
      projectSessions,
      activeSessions,
      ungroupedGroups,
      collapsedProjectIds,
      archivedSessions,
      archivedExpanded,
      loadingArchived,
      searchHits,
      searchRemote,
      filtered.length,
      runningIds,
    ],
  );

  const emitReorder = (ids: string[]) => {
    setOrderOverride(ids);
    onReorderProjects?.(ids);
  };

  const moveProject = (id: string, dir: -1 | 1) => {
    const ids = orderedProjects.map((p) => p.id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    const next = ids.slice();
    const [row] = next.splice(i, 1);
    next.splice(j, 0, row);
    emitReorder(next);
  };

  const onToggleSelected = (id: string) => {
    setSelectedIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setMultiSelect(true);
  };

  const clearMulti = () => {
    setSelectedIds(new Set());
    setMultiSelect(false);
  };

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

  const renderFlat = (item: FlatItem) => {
    if (item.kind === "header") {
      return (
        <div className="flex h-full items-end px-3 pb-1 text-caption font-medium uppercase tracking-wide text-faint">
          {item.label}
          {item.label === "项目" && onCreateProject && (
            <IconButton
              aria-label="新建项目"
              variant="muted"
              size="xs"
              shape="square"
              className="ml-auto"
              onClick={onCreateProject}
            >
              <Plus size={13} />
            </IconButton>
          )}
        </div>
      );
    }
    if (item.kind === "hint") {
      const emptyCenter = item.text === "暂无会话" || item.text === "没有匹配的会话";
      return (
        <p
          className={cn(
            "flex h-full items-center px-3 text-body text-faint",
            emptyCenter && "justify-center py-6",
            item.text === "消息搜索失败" && "text-danger",
          )}
        >
          {item.text}
        </p>
      );
    }
    if (item.kind === "session") {
      const s = item.session;
      return (
        <SessionRow
          session={s}
          active={s.id === activeId}
          projects={orderedProjects}
          indent={item.indent}
          isSending={isSending}
          liveTerminal={liveTerminal}
          now={now}
          onSelect={onSelect}
          onRename={onRename}
          onDelete={onDelete}
          onTogglePin={onTogglePin}
          onMoveToProject={onMoveToProject}
          onArchive={onArchive}
          onMarkRead={onMarkRead}
          unread={unreadIds?.has(s.id)}
          multiSelect={multiSelect}
          selected={selectedIds.has(s.id)}
          onToggleSelected={onToggleSelected}
          onEnterMultiSelect={(id) => {
            setMultiSelect(true);
            setSelectedIds((cur) => new Set(cur).add(id));
          }}
          allowDrag={!coarse}
        />
      );
    }
    if (item.kind === "project") {
      const p = item.project;
      const isDefault = p.id === DEFAULT_PROJECT_ID;
      const idx = orderedProjects.findIndex((x) => x.id === p.id);
      return (
        <ProjectRow
          project={p}
          count={item.count}
          collapsed={item.collapsed}
          runningCount={item.runningCount}
          dropActive={dragOverProjectId === p.id}
          allowDrag={!isDefault && !coarse && Boolean(onReorderProjects)}
          showMoveInMenu={!isDefault && Boolean(onReorderProjects)}
          canMoveUp={!isDefault && idx > 0}
          canMoveDown={!isDefault && idx >= 0 && idx < orderedProjects.length - 1}
          immutable={isDefault}
          onToggle={onToggleProjectCollapsed}
          onRename={isDefault ? undefined : onRenameProject}
          onDelete={isDefault ? undefined : onDeleteProject}
          onOpenSettings={isDefault ? undefined : onOpenProjectSettings}
          onOpenAssets={isDefault && onOpenProjectAssets ? () => onOpenProjectAssets(null) : undefined}
          onMoveUp={() => moveProject(p.id, -1)}
          onMoveDown={() => moveProject(p.id, 1)}
          onDragOverSession={() => setDragOverProjectId(p.id)}
          onDragLeave={() => setDragOverProjectId((cur) => (cur === p.id ? null : cur))}
          onDropSessionId={(id) => {
            setDragOverProjectId(null);
            const sess = sessions.find((x) => x.id === id);
            if (sess && onMoveToProject) onMoveToProject(sess, isDefault ? null : p.id);
          }}
          onProjectDragStart={(e) => {
            e.dataTransfer.setData(PROJECT_DRAG_TYPE, p.id);
            e.dataTransfer.effectAllowed = "move";
          }}
          onProjectDrop={(e) => {
            const from = e.dataTransfer.getData(PROJECT_DRAG_TYPE);
            if (!from || from === p.id || from === DEFAULT_PROJECT_ID) return;
            const ids = orderedProjects.map((x) => x.id);
            const fromI = ids.indexOf(from);
            const toI = ids.indexOf(p.id);
            if (fromI < 0 || toI < 0) return;
            const next = ids.slice();
            const [row] = next.splice(fromI, 1);
            next.splice(toI, 0, row);
            emitReorder(next);
          }}
        />
      );
    }
    if (item.kind === "searchHit") {
      const hit = item.hit;
      return (
        <button
          type="button"
          onClick={() => {
            onMarkRead?.(hit.sessionId);
            onSelect(hit.sessionId);
          }}
          className={
            unreadIds?.has(hit.sessionId) || hit.unread
              ? "flex h-full w-full min-w-0 flex-col justify-center rounded-md px-3 text-left text-section text-fg outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring"
              : "flex h-full w-full min-w-0 flex-col justify-center rounded-md px-3 text-left text-section text-muted outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
          }
        >
          <span
            className={
              unreadIds?.has(hit.sessionId) || hit.unread ? "truncate font-semibold" : "truncate"
            }
          >
            {hit.title || "新对话"}
          </span>
          <span className="truncate text-caption text-faint">
            <HighlightedText text={hit.snippet} query={q} />
          </span>
        </button>
      );
    }
    if (item.kind === "archivedToggle") {
      return (
        <button
          type="button"
          aria-expanded={item.expanded}
          onClick={() => {
            const next = !archivedExpanded;
            setArchivedExpanded(next);
            if (next) onLoadArchived?.();
          }}
          className="flex h-full w-full items-center gap-1.5 rounded-md px-2 text-left text-section text-muted outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
        >
          {item.expanded ? (
            <ChevronDown size={14} className="shrink-0 text-faint" />
          ) : (
            <ChevronRight size={14} className="shrink-0 text-faint" />
          )}
          <Archive size={14} className="shrink-0 text-faint" />
          <span className="min-w-0 flex-1 truncate">已归档</span>
          <span className="shrink-0 text-caption text-faint">{item.count}</span>
        </button>
      );
    }
    return null;
  };

  return (
    <aside
      className={cn(
        "relative flex h-full shrink-0 flex-col bg-sidebar",
        width == null && "w-[268px]",
        resizing && "select-none",
      )}
      style={width != null ? { width } : undefined}
    >
      {onResizeStart && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="调整侧栏宽度"
          data-testid="sidebar-resize-handle"
          onPointerDown={onResizeStart}
          className={cn(
            "absolute inset-y-0 right-0 z-10 hidden w-1 cursor-col-resize touch-none md:block",
            resizing && "bg-accent/40",
          )}
        />
      )}
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
            任务
            <span className="ml-auto text-caption font-normal text-faint">看板</span>
          </button>
        )}

        <div className="flex items-center gap-2 px-1.5 pt-1 text-caption font-medium text-faint">
          <MessageSquareText size={14} className="shrink-0" />
          <span>会话</span>
          {onBatch && !multiSelect && (
            <button
              type="button"
              onClick={() => setMultiSelect(true)}
              className="ml-auto shrink-0 rounded-md px-1.5 py-1 text-caption font-normal text-faint outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11"
            >
              多选
            </button>
          )}
        </div>

        <div className="flex min-w-0 items-center gap-2 rounded-lg bg-hover px-3 py-2 transition-shadow focus-within:ring-2 focus-within:ring-ring">
          <Search size={15} className="shrink-0 text-faint" />
          <input
            data-product-feature={PRODUCT_CAPABILITIES.sessions.id}
            data-sidebar-search
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索会话"
            className="w-full min-w-0 bg-transparent text-base text-fg outline-none placeholder:text-faint md:text-sm"
          />
        </div>
      </div>

      {multiSelect && onBatch && (
        <BatchBar
          count={selectedIds.size}
          projects={orderedProjects}
          onAction={(action, projectId) => {
            if (selectedIds.size === 0) return;
            onBatch([...selectedIds], action, projectId);
            clearMulti();
          }}
          onCancel={clearMulti}
        />
      )}

      <VirtualList
        items={flatItems}
        threshold={virtualizeThreshold}
        onEndReached={hasMore && !searching ? onLoadMore : undefined}
        renderItem={renderFlat}
        className="no-scrollbar flex-1 overflow-y-auto px-2 pb-3"
      />
      {loadingMore && (
        <p className="px-3 pb-2 text-center text-caption text-faint">加载更多…</p>
      )}

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
