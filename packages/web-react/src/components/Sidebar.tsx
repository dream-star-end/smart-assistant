import {
  Archive,
  BookOpen,
  Building2,
  ChevronDown,
  ChevronRight,
  Film,
  Globe,
  Kanban,
  KeyRound,
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
  X,
} from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { archivedExpandedStorageKey } from "../hooks/useChatProjects";
import { useProjectScope } from "../hooks/useProjectScope";
import type { Theme } from "../hooks/useTheme";
import { BRAND } from "../lib/brand";
import { PRODUCT_CAPABILITIES } from "../lib/productCapabilities";
import { isSidebarSessionRunning } from "../lib/sessionStatus";
import type {
  ChatProject,
  Session,
  SessionBatchAction,
  SessionSearchHit,
  User,
} from "../lib/types";
import { cn, formatCompactCount, formatCredits } from "../lib/utils";
import { ThemeToggle } from "./ThemeToggle";
import { BatchBar } from "./sidebar/BatchBar";
import { ProjectRow } from "./sidebar/ProjectRow";
import { SessionRow } from "./sidebar/SessionRow";
import { VirtualList } from "./sidebar/VirtualList";
import {
  DEFAULT_PROJECT_ID,
  PROJECT_DRAG_TYPE,
  SEARCH_DEBOUNCE_MS,
  SIDEBAR_DURATION_TICK_MS,
  VIRTUALIZE_THRESHOLD,
} from "./sidebar/constants";
import { type FlatItem, flattenSidebarItems } from "./sidebar/flattenItems";
import { HighlightedText } from "./sidebar/highlight";
import {
  compareByUpdatedDesc,
  compareSessionsRunningThenUpdated,
  partitionProjectsRunningFirst,
  sortSessionsRunningThenUpdated,
} from "./sidebar/runningOrder";
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

/** 空态提示行叠加「新建会话」CTA 后的行高(文字 + gap + 按钮 + 原 py-6 呼吸位)。 */
const EMPTY_HINT_CTA_HEIGHT = 108;
/** 底栏在此宽度以下进入紧凑态：隐藏「案例」文字只留图标，给昵称 / 余额让位（S-09）。 */
const FOOTER_COMPACT_WIDTH = 260;

function readArchivedExpanded(userId: string | undefined): boolean {
  if (!userId) return false;
  try {
    return localStorage.getItem(archivedExpandedStorageKey(userId)) === "1";
  } catch {
    return false;
  }
}

function writeArchivedExpanded(userId: string | undefined, expanded: boolean): void {
  if (!userId) return;
  try {
    localStorage.setItem(archivedExpandedStorageKey(userId), expanded ? "1" : "0");
  } catch {
    /* private mode / quota */
  }
}

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
  /** 在指定项目下直接新建会话（真实项目组专用，default 未分类走顶部 onNew）。 */
  onNewInProject?: (projectId: string) => void;
  /** 先选智能体再新建。传入时顶部「新建会话」改成 split（右侧打开 AgentPicker）。 */
  onNewWithAgent?: () => void;
  isSending?: (id: string) => boolean;
  liveTerminal?: (
    id: string,
  ) => { lastOutcome?: string | null; lastErrorCode?: string | null } | undefined;
  socketVersion?: number;
  onCollapse?: () => void;
  /**
   * 左上角折叠按钮的可访问名称。桌面默认「折叠侧栏」；App 在移动端抽屉里把同一按钮接成
   * 「关闭抽屉」时应传「关闭导航」，读屏用户听到的才与实际动作一致（S-06）。
   */
  collapseLabel?: string;
  onLogout?: () => void;
  onOpenAccount?: () => void;
  onOpenFeedback?: () => void;
  onOpenManage?: () => void;
  onOpenMarketplace?: () => void;
  onOpenTutorial?: () => void;
  onOpenOrg?: () => void;
  onOpenBoard?: () => void;
  onOpenMediaTasks?: () => void;
  /** 「ChatGPT 直连」面板入口:仅管理员 / 白名单用户且服务端已开启时由 App 传入。 */
  onOpenChatGptProxy?: () => void;
  /** 「API 接入」入口:管理员由 App 传入(admin-only rollout),直达设置 api-access 分区。 */
  onOpenApiAccess?: () => void;
  boardActive?: boolean;
  showAdmin?: boolean;
  theme?: Theme;
  onCycleTheme?: () => void;
  unreadIds?: Set<string>;
  onMarkRead?: (id: string) => void;
  onOpenProjectSettings?: (p: ChatProject) => void;
  /** 打开某项目的资产面板；default 组传 null。 */
  onOpenProjectAssets?: (projectId: string | null) => void;
  /** 返回 Promise 时，reject 会回滚侧栏本地的乐观排序（S-03）。 */
  onReorderProjects?: (orderedIds: string[]) => void | Promise<void>;
  width?: number;
  onResizeStart?: (e: ReactPointerEvent) => void;
  resizing?: boolean;
  onArchive?: (s: Session) => void;
  onBatch?: (ids: string[], action: SessionBatchAction, projectId?: string | null) => void;
  onLoadMore?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  /** 上一次「加载更早会话」失败：底部显示「加载失败，点击重试」，不再静默停止（S-08）。 */
  loadMoreError?: boolean;
  onLoadArchived?: () => void;
  loadingArchived?: boolean;
  onSearchMessages?: (
    q: string,
    signal: AbortSignal,
    projectId?: string | null,
  ) => Promise<SessionSearchHit[]>;
  searchProjectId?: string | null;
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
  onNewInProject,
  onNewWithAgent,
  isSending,
  liveTerminal,
  socketVersion,
  onCollapse,
  collapseLabel = "折叠侧栏",
  onLogout,
  onOpenAccount,
  onOpenFeedback,
  onOpenManage,
  onOpenMarketplace,
  onOpenTutorial,
  onOpenOrg,
  onOpenBoard,
  onOpenMediaTasks,
  onOpenChatGptProxy,
  onOpenApiAccess,
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
  loadMoreError,
  onLoadArchived,
  loadingArchived,
  onSearchMessages,
  searchProjectId,
  virtualizeThreshold = VIRTUALIZE_THRESHOLD,
}: SidebarProps) {
  const [q, setQ] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [dragOverProjectId, setDragOverProjectId] = useState<string | null>(null);
  const [archivedExpanded, setArchivedExpanded] = useState(() => readArchivedExpanded(user?.id));
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [multiSelect, setMultiSelect] = useState(false);
  const [orderOverride, setOrderOverride] = useState<string[] | null>(null);
  const [searchHits, setSearchHits] = useState<SessionSearchHit[]>([]);
  const [searchRemote, setSearchRemote] = useState<"idle" | "loading" | "empty" | "error">("idle");
  const coarse = useCoarsePointer();
  const userId = user?.id;
  useEffect(() => {
    setArchivedExpanded(readArchivedExpanded(userId));
  }, [userId]);
  useEffect(() => {
    writeArchivedExpanded(userId, archivedExpanded);
  }, [userId, archivedExpanded]);
  // 持久化的展开态恢复后自动拉一次归档列表。user 常晚于侧栏挂载到位（刷新页面等 /api/me），
  // 只在 mount 时判一次会出现「已展开 + 计数 0 + 假空态」（S-02）；这里跟随 archivedExpanded，
  // 点击展开路径自行调用并置位，避免重复请求。
  const archivedAutoLoadedRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: onLoadArchived 经闭包读最新值即可
  useEffect(() => {
    if (!archivedExpanded || archivedAutoLoadedRef.current) return;
    archivedAutoLoadedRef.current = true;
    onLoadArchived?.();
  }, [archivedExpanded]);
  const searching = q.trim().length > 0;
  const projectScope = useProjectScope();
  const activeSearchProjectId =
    searchProjectId !== undefined ? searchProjectId : projectScope.scope.chatProjectIdForFilter;
  const showProjects = Array.isArray(projects) && Boolean(onCreateProject);
  // 只有出现在项目列表里的 projectId 才算「有归属」。projectId 指向未知项目的会话
  // （项目列表请求失败 / 项目在他端被删）一律落回「未分类」，绝不从侧栏消失（S-12）。
  const knownProjectIds = useMemo(
    () => new Set(showProjects ? (projects ?? []).map((p) => p.id) : []),
    [showProjects, projects],
  );

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
    const pool = searching
      ? sessions.filter((s) => !s.archived || archivedExpanded)
      : activeSessions;
    if (!needle) return pool;
    return pool.filter((s) => (s.title || "新对话").toLowerCase().includes(needle));
  }, [activeSessions, sessions, q, searching, archivedExpanded]);

  const pinned = useMemo(
    () =>
      searching
        ? []
        : sortSessionsRunningThenUpdated(
            filtered.filter((s) => s.pinned),
            runningIds,
          ),
    [filtered, searching, runningIds],
  );
  const pinnedIds = useMemo(() => new Set(pinned.map((s) => s.id)), [pinned]);

  const projectSessions = useMemo(() => {
    const map = new Map<string, Session[]>();
    if (searching) return map;
    for (const s of filtered) {
      if (pinnedIds.has(s.id) || !s.projectId || !knownProjectIds.has(s.projectId)) continue;
      const list = map.get(s.projectId) || [];
      list.push(s);
      map.set(s.projectId, list);
    }
    for (const list of map.values())
      list.sort((a, b) => compareSessionsRunningThenUpdated(a, b, runningIds));
    return map;
  }, [filtered, pinnedIds, searching, runningIds, knownProjectIds]);

  const ungroupedGroups = useMemo(() => {
    if (searching) {
      const items = filtered.slice().sort((a, b) => {
        if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
        return compareSessionsRunningThenUpdated(a, b, runningIds);
      });
      return items.length ? ([["搜索结果", items]] as [string, Session[]][]) : [];
    }
    const list = sortSessionsRunningThenUpdated(
      filtered.filter(
        (s) => !pinnedIds.has(s.id) && (!s.projectId || !knownProjectIds.has(s.projectId)),
      ),
      runningIds,
    );
    return list.length ? ([["", list]] as [string, Session[]][]) : [];
  }, [filtered, pinnedIds, searching, runningIds, knownProjectIds]);

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
      void onSearchMessages(needle, ac.signal, activeSearchProjectId)
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
  }, [q, onSearchMessages, activeSearchProjectId]);

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
        coarsePointer: coarse,
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
      coarse,
    ],
  );

  // 只有「整个列表为空」的空态行叠加 CTA 按钮并加高(VirtualList 按 item.height 排 offsets)；
  // 空项目的提示保持普通行高,避免多个空项目把会话挤出视口(S-01)。
  // onNew 是 Sidebar 必传 prop,无需再判存在性。
  const listItems = useMemo(
    () =>
      flatItems.map((it) =>
        it.kind === "hint" && it.variant === "empty-list"
          ? { ...it, height: EMPTY_HINT_CTA_HEIGHT }
          : it,
      ),
    [flatItems],
  );

  // 数据层（useChatProjects）成功或失败后都会换一份 projects 引用：成功=新顺序、失败=回滚快照。
  // 无论哪种，本地乐观顺序都已完成使命，清掉即与数据层保持一致（S-03）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 有意以 projects 引用变化为触发条件
  useEffect(() => {
    setOrderOverride(null);
  }, [projects]);

  const emitReorder = (ids: string[]) => {
    setOrderOverride(ids);
    if (!onReorderProjects) return;
    // 回调同步调用（调用方立刻拿到新顺序）；返回 Promise 时接住 reject 回滚本地顺序，
    // 不再留下 Unhandled promise rejection（S-03）。
    try {
      void Promise.resolve(onReorderProjects(ids)).catch(() => {
        setOrderOverride(null);
      });
    } catch {
      setOrderOverride(null);
    }
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
      onOpenChatGptProxy ||
      onOpenApiAccess ||
      onOpenAccount ||
      onOpenFeedback ||
      onLogout,
  );

  // 底栏余额：默认 268px 下完整千分位数字已被截成「1,234,56…」（S-09），底栏一律用
  // 万 / 亿 缩写（formatCompactCount），精确值放 title 悬浮；账号菜单里空间充足仍显完整数字。
  const footerCompact = typeof width === "number" && width < FOOTER_COMPACT_WIDTH;
  const creditsExact = credits != null ? `${formatCredits(credits)} 积分` : null;
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
        <span
          className="block truncate text-caption text-faint"
          title={creditsExact ? `余额 ${creditsExact}` : undefined}
        >
          {credits != null ? `余额 ${formatCompactCount(credits)} 积分` : "多模型 · 计量计费"}
        </span>
      </span>
    </button>
  );

  const renderFlat = (item: FlatItem) => {
    if (item.kind === "header") {
      const withAction = item.label === "项目" && Boolean(onCreateProject);
      return (
        <h2
          className={cn(
            "m-0 flex h-full px-3 text-caption font-medium uppercase tracking-wide text-faint",
            // 触屏下带按钮的标题行升到 44px（拍平层同步加高），文字与 44px 按钮垂直居中对齐（S-04）。
            withAction && coarse ? "items-center" : "items-end pb-1",
          )}
        >
          {item.label}
          {withAction && (
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
        </h2>
      );
    }
    if (item.kind === "hint") {
      // 整个列表为空：居中大 CTA（新用户唯一出口）。空项目：普通一行 + 行内「新建会话」文字钮，
      // 保留直达 onNewInProject 的出口但不再占 108px（S-01）。空未分类而别处有会话：顶部按钮已覆盖，只留文字。
      const emptyList = item.variant === "empty-list";
      const emptyProject = item.variant === "empty-project";
      const emptyCenter = emptyList || item.text === "没有匹配的会话";
      const isSearchHint = item.key.startsWith("search-");
      const onNewHere =
        item.projectId && onNewInProject
          ? () => {
              const pid = item.projectId;
              if (pid) onNewInProject(pid);
            }
          : onNew;
      return (
        <div
          // 搜索三态（正在搜索 / 无匹配 / 失败）对读屏播报（S-07）。
          role={isSearchHint ? "status" : undefined}
          aria-live={isSearchHint ? "polite" : undefined}
          className={cn(
            "flex h-full items-center px-3 text-body text-faint",
            emptyCenter && "justify-center py-6",
            item.text === "消息搜索失败" && "text-danger",
            emptyList && "flex-col items-center gap-2",
            emptyProject && "gap-2 text-caption",
          )}
        >
          <span>{item.text}</span>
          {emptyList && (
            <Button variant="secondary" size="sm" onClick={onNewHere}>
              新建会话
            </Button>
          )}
          {emptyProject && item.projectId && (
            <button
              type="button"
              onClick={onNewHere}
              className="rounded-sm text-caption font-medium text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              新建会话
            </button>
          )}
        </div>
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
          highlightQuery={searching ? q : undefined}
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
          onOpenAssets={
            isDefault && onOpenProjectAssets ? () => onOpenProjectAssets(null) : undefined
          }
          onNewSession={!isDefault && onNewInProject ? () => onNewInProject(p.id) : undefined}
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
            {hit.projectId
              ? `${(projects ?? []).find((p) => p.id === hit.projectId)?.name ?? "项目"} · `
              : ""}
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
            if (next) {
              // 点击路径自行拉取并置位，恢复态 effect 不再重复请求。
              archivedAutoLoadedRef.current = true;
              onLoadArchived?.();
            }
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
      <div
        className="flex flex-col gap-1.5 px-2.5 pb-1.5 pt-2.5"
        data-product-entry-scope="sidebar-primary"
      >
        <div className="flex items-center justify-between px-1">
          <div className="flex items-center gap-2">
            <span className="flex size-7 items-center justify-center rounded-lg bg-grad-cta text-white">
              <Sparkles size={15} />
            </span>
            <span className="text-title font-semibold tracking-tight">{BRAND.name}</span>
          </div>
          {onCollapse && (
            <IconButton
              data-product-control
              onClick={onCollapse}
              aria-label={collapseLabel}
              title={collapseLabel}
              variant="muted"
              size="sm"
              shape="square"
            >
              <PanelLeftClose size={17} />
            </IconButton>
          )}
        </div>

        {onNewWithAgent ? (
          <div className="flex w-full">
            <Button
              data-product-feature={PRODUCT_CAPABILITIES.chatBasics.id}
              variant="secondary"
              onClick={onNew}
              className="h-9 min-w-0 flex-1 justify-start gap-2 rounded-l-lg rounded-r-none border-r-0 px-3 text-section font-medium"
            >
              <Plus size={16} />
              新建会话
            </Button>
            <IconButton
              data-product-feature={PRODUCT_CAPABILITIES.agents.id}
              variant="ghost"
              shape="square"
              size="md"
              aria-label="选择智能体后新建"
              title="选择智能体后新建"
              onClick={onNewWithAgent}
              className="rounded-l-none rounded-r-lg border border-border bg-surface text-fg hover:border-border-strong hover:bg-hover"
            >
              <ChevronDown size={16} />
            </IconButton>
          </div>
        ) : (
          <Button
            data-product-feature={PRODUCT_CAPABILITIES.chatBasics.id}
            variant="secondary"
            onClick={onNew}
            className="h-9 w-full justify-start gap-2 rounded-lg px-3 text-section font-medium"
          >
            <Plus size={16} />
            新建会话
          </Button>
        )}

        {onOpenBoard && (
          <button
            type="button"
            data-product-feature={PRODUCT_CAPABILITIES.taskboard.id}
            data-testid="taskboard-nav"
            onClick={onOpenBoard}
            aria-current={boardActive ? "true" : undefined}
            className={cn(
              "relative flex h-9 items-center gap-2 rounded-lg px-3 text-left text-section font-medium outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11",
              boardActive ? "bg-active text-fg" : "text-muted",
            )}
          >
            {boardActive && (
              <span
                aria-hidden
                className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-accent"
              />
            )}
            <Kanban size={16} className="text-faint" />
            任务
          </button>
        )}

        <div className="flex min-w-0 items-center gap-1">
          <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg bg-hover px-2.5 transition-shadow focus-within:ring-2 focus-within:ring-ring [@media(hover:none)]:min-h-11">
            <Search size={15} className="shrink-0 text-faint" />
            <input
              data-product-feature={PRODUCT_CAPABILITIES.sessions.id}
              data-sidebar-search
              aria-label="搜索标题或消息"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                // Escape 一键清空，不必手动全选删除才能回到列表（S-07）。
                if (e.key === "Escape" && q) {
                  e.preventDefault();
                  setQ("");
                }
              }}
              placeholder="搜索标题或消息"
              className="w-full min-w-0 bg-transparent text-base text-fg outline-none placeholder:text-faint md:text-sm"
            />
            {q && (
              <IconButton
                aria-label="清除搜索"
                title="清除搜索"
                variant="muted"
                size="xs"
                shape="round"
                className="-mr-1"
                onClick={() => setQ("")}
              >
                <X size={13} />
              </IconButton>
            )}
          </label>
          {onBatch && !multiSelect && (
            <button
              data-product-control
              type="button"
              onClick={() => setMultiSelect(true)}
              className="h-9 shrink-0 rounded-md px-2 text-caption font-medium text-faint outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11"
            >
              多选
            </button>
          )}
        </div>
      </div>

      {multiSelect && onBatch && (
        <BatchBar
          count={selectedIds.size}
          projects={orderedProjects}
          hasArchivedSelected={sessions.some((s) => s.archived && selectedIds.has(s.id))}
          onAction={(action, projectId) => {
            if (selectedIds.size === 0) return;
            onBatch([...selectedIds], action, projectId);
            clearMulti();
          }}
          onCancel={clearMulti}
        />
      )}

      {/* 会话列表导航语义:读屏用户按 landmark/region 快速跳到会话区(探针:工作区 nav=0)。 */}
      <nav aria-label="会话列表" className="flex min-h-0 flex-1 flex-col">
        <VirtualList
          items={listItems}
          threshold={virtualizeThreshold}
          onEndReached={hasMore && !searching ? onLoadMore : undefined}
          renderItem={renderFlat}
          className="no-scrollbar flex-1 overflow-y-auto px-2 pb-3"
        />
      </nav>
      {loadingMore ? (
        <p className="px-3 pb-2 text-center text-caption text-faint">加载更多…</p>
      ) : loadMoreError && onLoadMore && !searching ? (
        // 「加载更早会话」失败不再静默把 hasMore 置 false：给出可重试的出口（S-08）。
        <div className="px-3 pb-2 text-center">
          <button
            type="button"
            onClick={onLoadMore}
            className="rounded-md px-2 py-1 text-caption font-medium text-danger outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring"
          >
            加载更早会话失败，点击重试
          </button>
        </div>
      ) : null}

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
                <DropdownMenuItem asChild data-product-control>
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
              {onOpenChatGptProxy && (
                <DropdownMenuItem data-product-control onSelect={onOpenChatGptProxy}>
                  <Globe size={16} className="shrink-0 text-muted" />
                  ChatGPT 直连
                </DropdownMenuItem>
              )}
              {onOpenApiAccess && (
                <DropdownMenuItem data-product-control onSelect={onOpenApiAccess}>
                  <KeyRound size={16} className="shrink-0 text-muted" />
                  <span className="flex-1">API 接入</span>
                  <span className="text-caption text-faint">本地 Claude Code</span>
                </DropdownMenuItem>
              )}
              {(onOpenAccount || onOpenFeedback || onLogout) &&
                (onOpenManage ||
                  onOpenMarketplace ||
                  onOpenOrg ||
                  showAdmin ||
                  onOpenMediaTasks ||
                  onOpenChatGptProxy ||
                  onOpenApiAccess) && <DropdownMenuSeparator />}
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
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-product-control
            onClick={onOpenTutorial}
            aria-label="打开案例展厅"
            title="案例展厅"
            className="h-8 shrink-0 gap-1 px-2 text-faint hover:text-fg"
          >
            <BookOpen size={16} />
            {/* 窄于 260px 只留图标（原 `width < 220` 低于 SIDEBAR_WIDTH_MIN 恒为 false，S-09）。 */}
            {!footerCompact && <span className="text-caption font-medium">案例</span>}
          </Button>
        )}
        {theme && onCycleTheme && <ThemeToggle theme={theme} onCycle={onCycleTheme} />}
      </div>
    </aside>
  );
}
