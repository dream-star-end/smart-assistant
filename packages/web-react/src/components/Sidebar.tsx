import {
  Archive,
  Bell,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Command,
  LayoutGrid,
  ListChecks,
  PanelLeftClose,
  Plus,
  Search,
  Store,
  X,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  Suspense,
  lazy,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { archivedExpandedStorageKey } from "../hooks/useChatProjects";
import { useOptionalAuth, useProjectScope } from "../hooks/useProjectScope";
import { SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN } from "../hooks/useSidebarWidth";
import type { Theme } from "../hooks/useTheme";
import { BRAND } from "../lib/brand";
import { PRODUCT_CAPABILITIES } from "../lib/productCapabilities";
import { type SessionNeedsYouKind, isSidebarSessionRunning } from "../lib/sessionStatus";
import type {
  ChatProject,
  Session,
  SessionBatchAction,
  SessionSearchHit,
  User,
} from "../lib/types";
import { cn, formatCompactCount, formatCredits } from "../lib/utils";
import { BrandMark } from "./BrandMark";
import { ProjectRow } from "./sidebar/ProjectRow";
import { SessionRow } from "./sidebar/SessionRow";
import { VirtualList } from "./sidebar/VirtualList";
import {
  DEFAULT_PROJECT_ID,
  PROJECT_DRAG_TYPE,
  PROJECT_SESSION_LIMIT,
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
  Button,
  DropdownMenu,
  DropdownMenuTrigger,
  IconButton,
  StatusPill,
} from "./ui";
import { AtelierIcon } from "./ui/AtelierIcons";

/** 多选批量条只在进入多选后出现，懒加载，不进首屏（UI-1 用它抵掉本片首屏增量）。 */
const BatchBar = lazy(() => import("./sidebar/BatchBar").then((m) => ({ default: m.BatchBar })));
/** 活态指挥条（含统一「待拍板」聚合区）按需懒加载，不进首屏静态闭包。 */
const SidebarLiveActivityStrip = lazy(() =>
  import("./sidebar/LiveActivityStrip").then((m) => ({ default: m.SidebarLiveActivityStrip })),
);

type AccountMenuModule = typeof import("./sidebar/AccountMenuContent");
let loadedAccountMenu: AccountMenuModule | null = null;
let pendingAccountMenu: Promise<AccountMenuModule> | null = null;

/** 账号下拉菜单懒块预热：移出首屏同步入口闭包，就绪后同步解析零闪烁。 */
export function preloadAccountMenu(): Promise<AccountMenuModule> {
  if (!pendingAccountMenu) {
    pendingAccountMenu = import("./sidebar/AccountMenuContent").then(
      (mod) => {
        loadedAccountMenu = mod;
        return mod;
      },
      (err: unknown) => {
        pendingAccountMenu = null;
        throw err;
      },
    );
  }
  return pendingAccountMenu;
}

const LazyAccountMenuContent = lazy(() => {
  const ready = loadedAccountMenu;
  if (ready) {
    const sync = {
      // biome-ignore lint/suspicious/noThenProperty: synchronous thenable for React.lazy once preloaded
      then(resolve: (value: { default: AccountMenuModule["AccountMenuContent"] }) => void) {
        resolve({ default: ready.AccountMenuContent });
      },
    };
    return sync as unknown as Promise<{ default: AccountMenuModule["AccountMenuContent"] }>;
  }
  return preloadAccountMenu().then((mod) => ({ default: mod.AccountMenuContent }));
});

if (typeof window !== "undefined") {
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => number })
    .requestIdleCallback;
  if (idle) idle(() => { void preloadAccountMenu().catch(() => {}); });
  else window.setTimeout(() => { void preloadAccountMenu().catch(() => {}); }, 10);
}

/** 空态提示行叠加「新建会话」CTA 后的行高(文字 + gap + 按钮 + 原 py-6 呼吸位)。 */
const EMPTY_HINT_CTA_HEIGHT = 108;
/** 零会话零项目的引导空态（图标 + 标题 + 两行说明 + 两个按钮，S-13）。 */
const EMPTY_ALL_HEIGHT = 200;
const NAV_ITEM_BASE =
  "oc-spring-press oc-icon-nudge group relative flex h-8 items-center gap-2.5 rounded-sm px-2.5 text-left text-section outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:h-9";
const NAV_ITEM_ACTIVE = "bg-sidebar-active font-medium text-fg shadow-sidebar-active";
const NAV_ITEM_IDLE = "text-muted hover:bg-hover/80 hover:text-fg";

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
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (s: Session) => void;
  onDelete: (s: Session) => void;
  onTogglePin?: (s: Session) => void;
  onMoveToProject?: (s: Session, projectId: string | null) => void;
  /** 会话菜单「新建项目并移入…」:打开新建项目对话框,创建后该会话移进新项目。 */
  onCreateProjectFromSession?: (s: Session) => void;
  onToggleProjectPin?: (p: ChatProject) => void;
  onArchiveProject?: (p: ChatProject) => void;
  /** 「已归档 / 最近删除的项目」入口(项目标题行)。 */
  onOpenProjectArchive?: () => void;
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
  sessionNeedsYou?: (id: string) => SessionNeedsYouKind | null | undefined;
  socketVersion?: number;
  onCollapse?: () => void;
  /**
   * 左上角折叠按钮的可访问名称。桌面默认「折叠侧栏」；App 在移动端抽屉里把同一按钮接成
   * 「关闭抽屉」时应传「关闭导航」，读屏用户听到的才与实际动作一致（S-06）。
   */
  collapseLabel?: string;
  onLogout?: () => void;
  onOpenAccount?: () => void;
  /** 点账号菜单「设置」直达偏好页；未传时回退 onOpenAccount。 */
  onOpenPreferences?: () => void;
  onOpenFeedback?: () => void;
  onOpenManage?: () => void;
  onOpenMarketplace?: () => void;
  onOpenTutorial?: () => void;
  /** @deprecated OCV5-843 已并入账号菜单「帮助与案例」，保留可选以向后兼容。 */
  onOpenBlog?: () => void;
  onOpenOrg?: () => void;
  onOpenBoard?: (ticketRef?: string) => void;
  onOpenSites?: () => void;
  onOpenMediaTasks?: () => void;
  /** OCV5-593: shown only when /api/studio/providers answers 200 for this account. */
  onOpenStudio?: () => void;
  /** 「ChatGPT 直连」面板入口:仅管理员 / 白名单用户且服务端已开启时由 App 传入。 */
  onOpenChatGptProxy?: () => void;
  /** @deprecated OCV5-843 已收敛进设置中心「API 接入」分区，保留可选以向后兼容。 */
  onOpenApiAccess?: () => void;
  boardActive?: boolean;
  sitesActive?: boolean;
  showAdmin?: boolean;
  theme?: Theme;
  /** 直接切换主题（供账号菜单内联三段控件使用）。 */
  onSetTheme?: (theme: Theme) => void;
  onCycleTheme?: () => void;
  /** 站内信未读数（侧栏左下角全局铃铛按钮 6px 状态点 + aria-label/title 精确计数）。 */
  unreadCount?: number;
  /** 打开全局站内信抽屉。 */
  onOpenInbox?: () => void;
  unreadIds?: Set<string>;
  onMarkRead?: (id: string) => void;
  onOpenProjectSettings?: (p: ChatProject) => void;
  /** 打开项目主页（点项目名）。不传则项目行整行只负责展开/折叠（旧行为）。 */
  onOpenProject?: (projectId: string) => void;
  /** 主区正在显示主页的项目（行高亮）；不在项目主页时为 null。 */
  activeProjectId?: string | null;
  /** 打开某项目的资产面板；default 组传 null。 */
  onOpenProjectAssets?: (projectId: string | null) => void;
  /** 返回 Promise 时，reject 会回滚侧栏本地的乐观排序（S-03）。 */
  onReorderProjects?: (orderedIds: string[]) => void | Promise<void>;
  width?: number;
  onResizeStart?: (e: ReactPointerEvent) => void;
  /** 拖宽把手的键盘处理（useSidebarWidth.onResizeKeyDown）；传入后把手可 Tab 聚焦（S-05）。 */
  onResizeKeyDown?: (e: ReactKeyboardEvent) => void;
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
  /** 第 4 参 `includeArchived` = 「已归档」是否展开：与标题本地过滤的范围保持一致（S-10）。 */
  onSearchMessages?: (
    q: string,
    signal: AbortSignal,
    projectId?: string | null,
    includeArchived?: boolean,
  ) => Promise<SessionSearchHit[]>;
  searchProjectId?: string | null;
  virtualizeThreshold?: number;
  /** Ctrl/⌘K palette (projects, chats, files, actions). Omit to hide the hint button. */
  onOpenPalette?: () => void;
  /** 可选：多代理/蜂群协作运行中的会话 id 集合（供顶部活态指挥区识别协作态）。 */
  swarmSessionIds?: ReadonlySet<string>;
  /** 可选：是否展示侧栏顶部活态指挥区；默认 true（无活态项时自动零占位折叠）。 */
  showLiveActivityStrip?: boolean;
  /** 可选：从待拍板聚合区一键直达实时浏览器接管视口。 */
  onOpenLiveBrowser?: (opts?: { url?: string; sessionId?: string | null }) => void;
};

export function Sidebar({
  sessions: incomingSessions,
  activeId,
  user,
  credits,
  onSelect,
  onNew,
  onRename,
  onDelete,
  onTogglePin,
  onMoveToProject,
  onCreateProjectFromSession,
  onToggleProjectPin,
  onArchiveProject,
  onOpenProjectArchive,
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
  sessionNeedsYou,
  socketVersion,
  onCollapse,
  collapseLabel = "折叠侧栏",
  onLogout,
  onOpenAccount,
  onOpenPreferences,
  onOpenFeedback,
  onOpenManage,
  onOpenMarketplace,
  onOpenTutorial,
  onOpenOrg,
  onOpenBoard,
  onOpenSites,
  onOpenMediaTasks,
  onOpenStudio,
  onOpenChatGptProxy,
  boardActive,
  sitesActive,
  showAdmin,
  theme,
  onSetTheme,
  onCycleTheme,
  unreadCount,
  onOpenInbox,
  unreadIds,
  onMarkRead,
  onOpenProjectSettings,
  onOpenProject,
  activeProjectId = null,
  onOpenProjectAssets,
  onReorderProjects,
  width,
  onResizeStart,
  onResizeKeyDown,
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
  onOpenPalette,
  swarmSessionIds,
  showLiveActivityStrip = true,
  onOpenLiveBrowser,
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
  const [accountMenuOpened, setAccountMenuOpened] = useState(false);
  const coarse = useCoarsePointer();
  const userId = user?.id;
  const sessions = useMemo(
    () => userId ? incomingSessions.filter(session => session.ownerUserId === userId) : [],
    [incomingSessions, userId],
  );
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
  const optionalAuth = useOptionalAuth();
  // 全局项目范围(在看板/管理中心选的)也会收窄侧栏搜索:必须看得见,也能一键放开。
  // 放开只对本侧栏搜索生效,范围本身一变就恢复跟随。
  const [ignoreScopeForSearch, setIgnoreScopeForSearch] = useState(false);
  const scopeToken = projectScope.scope.token;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 范围 token 变化即恢复跟随
  useEffect(() => setIgnoreScopeForSearch(false), [scopeToken]);
  const scopeFilterForSearch =
    searchProjectId === undefined && !ignoreScopeForSearch
      ? projectScope.scope.chatProjectIdForFilter
      : undefined;
  const activeSearchProjectId =
    searchProjectId !== undefined ? searchProjectId : scopeFilterForSearch;
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
    // 归档的项目不在主列表;置顶的排在最前(各自保持原有顺序)。
    const live = (projects ?? []).filter((p) => !p.archivedAt);
    const list = [...live.filter((p) => p.pinnedAt), ...live.filter((p) => !p.pinnedAt)];
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
    // 标题命中与消息命中同一个项目范围,不再一边过滤一边不过滤。
    return pool.filter(
      (s) =>
        (s.title || "新对话").toLowerCase().includes(needle) &&
        (activeSearchProjectId === undefined || (s.projectId ?? null) === activeSearchProjectId),
    );
  }, [activeSessions, sessions, q, searching, archivedExpanded, activeSearchProjectId]);

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

  // onSearchMessages 每次 App 重渲都是新函数(流式回合里每帧一次):不进依赖,否则每帧都重跑本 effect——
  // 清空命中触发整栏二次重渲,且防抖计时被反复重置,回合进行中消息搜索迟迟不出(#1240)。
  const searchMessagesRef = useRef(onSearchMessages);
  searchMessagesRef.current = onSearchMessages;
  const canSearchMessages = Boolean(onSearchMessages);
  useEffect(() => {
    const needle = q.trim();
    const search = searchMessagesRef.current;
    if (!needle || !canSearchMessages || !search) {
      setSearchHits((cur) => (cur.length === 0 ? cur : []));
      setSearchRemote("idle");
      return;
    }
    setSearchRemote("loading");
    const ac = new AbortController();
    const timer = window.setTimeout(() => {
      void search(needle, ac.signal, activeSearchProjectId, archivedExpanded)
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
  }, [q, canSearchMessages, activeSearchProjectId, archivedExpanded]);

  const displayProjects = useMemo(
    () =>
      partitionProjectsRunningFirst(orderedProjects, (id) =>
        (projectSessions.get(id) ?? []).some((s) => runningIds.has(s.id)),
      ),
    [orderedProjects, projectSessions, runningIds],
  );

  const hasLiveCandidate = useMemo(() => {
    void socketVersion;
    if (!showLiveActivityStrip || searching || multiSelect) return false;
    if (runningIds.size > 0 || (swarmSessionIds?.size ?? 0) > 0) return true;
    for (const s of activeSessions) {
      if (sessionNeedsYou?.(s.id)) return true;
    }
    return false;
  }, [
    showLiveActivityStrip,
    searching,
    multiSelect,
    runningIds,
    swarmSessionIds,
    activeSessions,
    sessionNeedsYou,
    socketVersion,
  ]);

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
        projectLimit: onOpenProject ? PROJECT_SESSION_LIMIT : undefined,
        activeId,
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
      onOpenProject,
      activeId,
    ],
  );

  // 只有「整个列表为空」的空态行叠加 CTA 按钮并加高(VirtualList 按 item.height 排 offsets)；
  // 空项目的提示保持普通行高,避免多个空项目把会话挤出视口(S-01)。
  // onNew 是 Sidebar 必传 prop,无需再判存在性。
  const listItems = useMemo(
    () =>
      flatItems.map((it) => {
        if (it.kind !== "hint") return it;
        if (it.variant === "empty-list") return { ...it, height: EMPTY_HINT_CTA_HEIGHT };
        if (it.variant === "empty-all") return { ...it, height: EMPTY_ALL_HEIGHT };
        return it;
      }),
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

  const clearMulti = () => {
    setSelectedIds(new Set());
    setMultiSelect(false);
  };

  // 会话行(memo)拿到的回调必须是稳定引用:App 每帧都给新函数，直接透传会让每一行跟着每帧重渲(#1240)。
  // 经 ref 调到最新的回调;有无某个回调(决定菜单项显隐)仍由调用处按原 prop 判断。
  const rowCallbacksRef = useRef({
    onSelect, onRename, onDelete, onTogglePin, onMoveToProject, onCreateProjectFromSession, onArchive, onMarkRead,
  });
  rowCallbacksRef.current = {
    onSelect, onRename, onDelete, onTogglePin, onMoveToProject, onCreateProjectFromSession, onArchive, onMarkRead,
  };
  const rowActions = useMemo(() => {
    const cb = () => rowCallbacksRef.current;
    return {
      select: (id: string) => cb().onSelect(id),
      rename: (s: Session) => cb().onRename(s),
      remove: (s: Session) => cb().onDelete(s),
      togglePin: (s: Session) => cb().onTogglePin?.(s),
      moveToProject: (s: Session, projectId: string | null) => cb().onMoveToProject?.(s, projectId),
      createProjectFromSession: (s: Session) => cb().onCreateProjectFromSession?.(s),
      archive: (s: Session) => cb().onArchive?.(s),
      markRead: (id: string) => cb().onMarkRead?.(id),
      toggleSelected: (id: string) => {
        setSelectedIds((cur) => {
          const next = new Set(cur);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
        setMultiSelect(true);
      },
      enterMultiSelect: (id: string) => {
        setMultiSelect(true);
        setSelectedIds((cur) => new Set(cur).add(id));
      },
    };
  }, []);

  const hasAccountMenu = Boolean(
    onOpenOrg ||
      showAdmin ||
      onOpenMediaTasks ||
      onOpenStudio ||
      onOpenChatGptProxy ||
      onOpenAccount ||
      onOpenPreferences ||
      onOpenTutorial ||
      onOpenFeedback ||
      onLogout ||
      (theme && (onSetTheme || onCycleTheme)),
  );

  // 底栏余额：默认 268px 下完整千分位数字已被截成「1,234,56…」（S-09），底栏一律用
  // 万 / 亿 缩写（formatCompactCount），精确值放 title 悬浮；账号菜单里空间充足仍显完整数字。
  const hasUnreadInbox = Boolean(unreadCount && unreadCount > 0);
  const creditsExact = credits != null ? `${formatCredits(credits)} 积分` : null;
  // 无余额（个人版 / 自托管未接计费、demo、未登录）时副标题此前写死「多模型 · 计量计费」——
  // 商业化营销文案出现在不计费的部署形态里（S-14）。改为有邮箱显邮箱、没有就不占这一行；
  // 最小改动、可回退、不引入新的能力开关判断，计费形态下仍显示余额。
  const email = user?.email?.trim() || null;
  const displayName = user?.displayName?.trim() || "未登录";
  const showSecondaryEmail = Boolean(email && email.toLowerCase() !== displayName.toLowerCase());
  const accountSubtitle = credits != null ? null : showSecondaryEmail ? email : null;
  const warmAccountMenu = hasAccountMenu ? () => { void preloadAccountMenu().catch(() => {}); } : undefined;
  const userChip = (
    <button
      type="button"
      data-product-feature={PRODUCT_CAPABILITIES.billing.id}
      disabled={!hasAccountMenu}
      aria-label={hasAccountMenu ? "账号菜单" : undefined}
      onPointerEnter={warmAccountMenu}
      onFocus={warmAccountMenu}
      className="oc-btn-tactile oc-spring-press group flex min-w-0 flex-1 items-center gap-2 rounded-sm py-1.5 pl-1.5 pr-2 text-left outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring enabled:hover:bg-hover/80 data-[state=open]:bg-sidebar-active data-[state=open]:shadow-sidebar-active [@media(hover:none)]:min-h-10"
    >
      <Avatar
        size="sm"
        tone="neutral"
        className="oc-avatar-ring bg-accent-soft text-meta font-semibold text-accent ring-1 ring-inset ring-accent/20"
      >
        {displayName.slice(0, 1).toUpperCase()}
      </Avatar>
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate text-body font-medium text-fg">
          {displayName}
        </span>
        {credits != null ? (
          <span
            className="mt-0.5 block truncate text-caption font-medium tabular-nums text-faint"
            title={creditsExact ? `余额 ${creditsExact}` : undefined}
          >
            {`余额 ${formatCompactCount(credits)} 积分`}
          </span>
        ) : accountSubtitle ? (
          <span className="mt-0.5 block truncate text-caption text-faint" title={accountSubtitle}>
            {accountSubtitle}
          </span>
        ) : null}
      </span>
      {hasAccountMenu && (
        // 触屏两侧各有 44px 图标钮，省掉这枚纯装饰箭头把宽度还给余额。
        <ChevronsUpDown
          size={14}
          strokeWidth={1.75}
          aria-hidden
          className="shrink-0 text-faint transition-colors group-hover:text-muted [@media(hover:none)]:hidden"
        />
      )}
    </button>
  );

  const renderFlat = (item: FlatItem) => {
    if (item.kind === "header") {
      const withAction = item.label === "项目" && Boolean(onCreateProject);
      return (
        <h2
          className={cn(
            "m-0 flex h-full items-center pl-2.5 pr-1 text-caption font-semibold tracking-[0.06em] text-faint",
            // 桌面 32px 行：文字压在下部、贴近其所属分组；触屏带按钮的标题行升到 44px（拍平层同步加高），
            // 文字与 44px 按钮垂直居中对齐（S-04）。
            !(withAction && coarse) && "pt-2.5",
          )}
        >
          {item.label}
          {withAction && (
            <IconButton
              aria-label="新建项目"
              title="新建项目"
              variant="muted"
              size="xs"
              shape="square"
              className="oc-btn-tactile ml-auto rounded-xs"
              onClick={onCreateProject}
            >
              <Plus size={14} strokeWidth={1.75} />
            </IconButton>
          )}
          {withAction && onOpenProjectArchive && (
            <IconButton
              aria-label="已归档和最近删除的项目"
              title="已归档和最近删除的项目"
              variant="muted"
              size="xs"
              shape="square"
              className="oc-btn-tactile rounded-xs"
              onClick={onOpenProjectArchive}
            >
              <Archive size={14} strokeWidth={1.75} />
            </IconButton>
          )}
        </h2>
      );
    }
    if (item.kind === "hint") {
      // 零会话零项目：一块引导（说明 + 新建会话 + 新建项目），不再摆「项目 +」「未分类 0」骨架（S-13）。
      if (item.variant === "empty-all") {
        return (
          <div
            data-testid="sidebar-empty-all"
            className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center"
          >
            <span className="oc-icon-badge oc-icon-badge-accent size-10 rounded-md">
              <AtelierIcon name="newChat" size={18} />
            </span>
            <div className="flex flex-col gap-1">
              <span className="text-body font-semibold text-fg">{item.text}</span>
              <span className="text-caption leading-relaxed text-faint">
                新建一个会话开始聊天；相关会话多了，可以建项目归到一起。
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={onNew}>
                新建会话
              </Button>
              {onCreateProject && (
                <Button variant="ghost" size="sm" onClick={onCreateProject}>
                  新建项目
                </Button>
              )}
            </div>
          </div>
        );
      }
      // 整个列表为空：居中大 CTA（新用户唯一出口）。空项目不再占行（UI-1）。
      const emptyList = item.variant === "empty-list";
      const emptyCenter = emptyList || item.text === "没有匹配的会话";
      const isSearchHint = item.key.startsWith("search-");
      return (
        <div
          // 搜索三态（正在搜索 / 无匹配 / 失败）对读屏播报（S-07）。
          role={isSearchHint ? "status" : undefined}
          aria-live={isSearchHint ? "polite" : undefined}
          className={cn(
            "relative flex h-full items-center px-3 text-body text-faint",
            emptyCenter && "justify-center py-6",
            item.text === "消息搜索失败" && "text-danger",
            emptyList && "flex-col items-center gap-2",
          )}
        >
          <span>{item.text}</span>
          {emptyList && (
            <Button variant="secondary" size="sm" onClick={onNew}>
              新建会话
            </Button>
          )}
        </div>
      );
    }
    if (item.kind === "more") {
      // 与项目下缩进会话标题同一左对齐基线（pl-2 + pl-7 = 36px）。
      return (
        <div className="relative h-full py-px pl-2">
          <button
            type="button"
            onClick={() => onOpenProject?.(item.projectId)}
            className="flex h-full w-full items-center gap-1 rounded-sm pl-7 text-left text-caption text-faint outline-none transition-colors hover:bg-hover/80 hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
          >
            查看全部 {item.count} 条
            <ChevronRight size={12} aria-hidden />
          </button>
        </div>
      );
    }
    if (item.kind === "session") {
      const s = item.session;
      const live = liveTerminal?.(s.id);
      const running = isSidebarSessionRunning(s, { isSending, liveTerminal });
      return (
        <SessionRow
          session={s}
          active={s.id === activeId}
          projects={orderedProjects}
          indent={item.indent}
          running={running}
          lastOutcome={live?.lastOutcome ?? s.lastOutcome}
          lastErrorCode={live?.lastErrorCode ?? s.lastErrorCode}
          needsYou={sessionNeedsYou?.(s.id) ?? null}
          now={running ? now : 0}
          onSelect={rowActions.select}
          onRename={rowActions.rename}
          onDelete={rowActions.remove}
          onTogglePin={onTogglePin ? rowActions.togglePin : undefined}
          onMoveToProject={onMoveToProject ? rowActions.moveToProject : undefined}
          onCreateProjectFromSession={
            onCreateProjectFromSession ? rowActions.createProjectFromSession : undefined
          }
          onArchive={onArchive ? rowActions.archive : undefined}
          onMarkRead={onMarkRead ? rowActions.markRead : undefined}
          unread={unreadIds?.has(s.id)}
          multiSelect={multiSelect}
          selected={selectedIds.has(s.id)}
          onToggleSelected={rowActions.toggleSelected}
          onEnterMultiSelect={rowActions.enterMultiSelect}
          allowDrag={!coarse}
          highlightQuery={searching ? q : undefined}
          projectHint={
            searching && s.projectId
              ? (projects ?? []).find((p) => p.id === s.projectId)?.name
              : undefined
          }
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
          active={!isDefault && activeProjectId === p.id}
          onToggle={onToggleProjectCollapsed}
          onOpen={isDefault ? undefined : onOpenProject}
          onRename={isDefault ? undefined : onRenameProject}
          onDelete={isDefault ? undefined : onDeleteProject}
          onOpenSettings={isDefault ? undefined : onOpenProjectSettings}
          onOpenAssets={
            isDefault && onOpenProjectAssets ? () => onOpenProjectAssets(null) : undefined
          }
          onNewSession={!isDefault && onNewInProject ? () => onNewInProject(p.id) : undefined}
          onMoveUp={() => moveProject(p.id, -1)}
          onMoveDown={() => moveProject(p.id, 1)}
          onTogglePin={isDefault ? undefined : onToggleProjectPin}
          onArchive={isDefault ? undefined : onArchiveProject}
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
          className="flex h-full w-full min-w-0 flex-col justify-center gap-0.5 rounded-sm px-2.5 text-left text-section text-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
        >
          {/* 未读只用点表示，不加粗（UI-SPEC §4.3）。 */}
          <span className="flex min-w-0 items-center gap-1.5">
            {(unreadIds?.has(hit.sessionId) || hit.unread) && <StatusPill status="unread" size="md" />}
            <span className="truncate">{hit.title || "新对话"}</span>
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
          // 与项目行同一骨架（16px 图标列 / 名称 / 旋转箭头 / 计数），整行取 faint：归档是次要入口。
          className="mt-1 flex h-[calc(100%-0.25rem)] w-full items-center gap-2.5 rounded-sm px-2.5 text-left text-section text-faint outline-none transition-colors duration-150 hover:bg-hover/80 hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex size-4 shrink-0 items-center justify-center">
            <Archive size={14} strokeWidth={1.75} aria-hidden />
          </span>
          <span className="min-w-0 truncate">已归档</span>
          <ChevronRight
            size={12}
            aria-hidden
            className={cn(
              "shrink-0 transition-transform duration-200 ease-standard",
              item.expanded && "rotate-90",
            )}
          />
          <span className="min-w-0 flex-1" />
          <span className="shrink-0 tabular-nums text-caption">{item.count}</span>
        </button>
      );
    }
    return null;
  };

  return (
    <aside
      className={cn(
        // 桌面加一道发丝分隔线与主区切开（移动抽屉自带遮罩，不需要）。
        "relative flex h-full min-h-0 shrink-0 flex-col bg-sidebar md:border-r md:border-border/70",
        width == null && "w-[268px]",
        resizing && "select-none",
      )}
      style={width != null ? { width } : undefined}
    >
      {onResizeStart && (
        // WAI-ARIA separator（可聚焦变体）：暴露 valuenow/min/max，键盘 ← → / Home / End 调宽，
        // title 说明双击复位（S-05）。
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="调整侧栏宽度"
          aria-valuenow={typeof width === "number" ? width : undefined}
          aria-valuemin={SIDEBAR_WIDTH_MIN}
          aria-valuemax={SIDEBAR_WIDTH_MAX}
          title="拖动调整宽度，双击复位默认宽度"
          tabIndex={onResizeKeyDown ? 0 : undefined}
          onKeyDown={onResizeKeyDown}
          data-testid="sidebar-resize-handle"
          onPointerDown={onResizeStart}
          className={cn(
            "absolute inset-y-0 right-0 z-10 hidden w-1 cursor-col-resize touch-none outline-none md:block focus-visible:bg-accent/60",
            resizing && "bg-accent/40",
          )}
        />
      )}
      <div
        className="flex shrink-0 flex-col border-b border-border/60 px-2 pb-2 sidebar-head-safe-t"
        data-product-entry-scope="sidebar-primary"
      >
        <div className="mb-2 flex h-8 items-center justify-between pl-1.5 pr-0.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <BrandMark
              className="size-[26px]"
              rounded="rounded-sm"
              fontSize="text-section"
              flat
            />
            <span className="truncate text-title font-semibold tracking-tight text-fg">
              {BRAND.name}
            </span>
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
              className="oc-btn-tactile rounded-sm"
            >
              <PanelLeftClose size={16} strokeWidth={1.75} />
            </IconButton>
          )}
        </div>

        {/* 主操作：干练克制的 Codex/Linear 比例，去厚重白砖阴影；有智能体选择时右侧细线切出下拉。 */}
        <div
          data-sidebar-new
          className="group/new oc-btn-tactile oc-spring-press mb-2 flex h-9 w-full items-stretch rounded-sm border border-border/80 bg-surface/90 text-section shadow-2xs transition-colors duration-150 ease-standard hover:border-border-strong hover:bg-surface [@media(hover:none)]:h-10"
        >
          <button
            type="button"
            data-product-feature={PRODUCT_CAPABILITIES.chatBasics.id}
            onClick={onNew}
            className={cn(
              "oc-icon-nudge flex min-w-0 flex-1 items-center gap-2.5 px-2.5 text-left font-medium text-fg outline-none transition-colors duration-150 hover:bg-hover/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              onNewWithAgent ? "rounded-l-sm" : "rounded-sm",
            )}
          >
            <AtelierIcon
              name="newChat"
              size={16}
              className="shrink-0 text-accent"
            />
            <span className="truncate">新建会话</span>
          </button>
          {onNewWithAgent && (
            <>
              <span aria-hidden className="my-2 w-px shrink-0 bg-border/80" />
              <button
                type="button"
                data-product-feature={PRODUCT_CAPABILITIES.agents.id}
                aria-label="选择智能体后新建"
                title="选择智能体后新建"
                onClick={onNewWithAgent}
                className="flex w-8 shrink-0 items-center justify-center rounded-r-sm text-faint outline-none transition-colors duration-150 hover:bg-hover/60 hover:text-fg focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [@media(hover:none)]:w-10"
              >
                <ChevronDown size={14} strokeWidth={1.75} />
              </button>
            </>
          )}
        </div>

        {/* 搜索条：轻柔微凹槽，图标与快捷键轻盈协调。 */}
        <label className="group/search flex h-8 min-w-0 items-center gap-2.5 rounded-sm border border-transparent bg-hover/65 pl-2.5 pr-1 text-muted transition-colors duration-150 hover:border-border/70 focus-within:border-border-strong focus-within:bg-sidebar-active focus-within:shadow-sidebar-active [@media(hover:none)]:min-h-10">
          <Search
            size={15}
            strokeWidth={1.75}
            aria-hidden
            className="size-4 shrink-0 text-faint transition-colors group-focus-within/search:text-fg"
          />
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
            // 输入字号移动端保持 16px（iOS 输入框 <16px 聚焦会整页放大）；占位符单独取导航行字号，
            // 静息态与下方「任务」同一视觉重量（iOS 缩放只看输入框本身字号，不看 placeholder）。
            className="h-full w-full min-w-0 bg-transparent text-base text-fg outline-none placeholder:text-body placeholder:text-faint md:text-body"
          />
          {q && (
            <IconButton
              data-product-control
              aria-label="清除搜索"
              title="清除搜索"
              variant="muted"
              size="xs"
              shape="round"
              onClick={() => setQ("")}
            >
              <X size={13} strokeWidth={1.75} />
            </IconButton>
          )}
          {onOpenPalette && !q && (
            <button
              type="button"
              data-product-control
              data-sidebar-palette
              aria-label="搜索与跳转（项目、会话、文件）"
              title={`搜索与跳转 (${paletteKeyLabel()})`}
              onClick={(e) => {
                e.preventDefault();
                onOpenPalette();
              }}
              className="oc-btn-tactile flex h-6 shrink-0 items-center justify-center rounded-xs px-0.5 text-faint outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:size-10 [@media(hover:none)]:px-0"
            >
              <kbd className="oc-kbd [@media(hover:none)]:hidden">{paletteKeyLabel()}</kbd>
              <Command size={15} strokeWidth={1.75} aria-hidden className="hidden [@media(hover:none)]:block" />
            </button>
          )}
          {onBatch && !multiSelect && (
            <IconButton
              data-product-control
              data-sidebar-multiselect
              aria-label="多选"
              title="多选（批量归档 / 移动 / 删除）"
              variant="muted"
              size="xs"
              shape="square"
              className="oc-btn-tactile rounded-xs"
              onClick={() => setMultiSelect(true)}
            >
              <ListChecks size={15} strokeWidth={1.75} />
            </IconButton>
          )}
        </label>
        {searching && scopeFilterForSearch !== undefined && (
          <div
            data-testid="sidebar-search-scope"
            className="mt-1.5 flex min-w-0 items-center gap-1 rounded-sm bg-accent-soft py-0.5 pl-2.5 pr-1 text-caption font-medium text-accent ring-1 ring-inset ring-accent/20"
          >
            <span className="min-w-0 flex-1 truncate">
              仅在「
              {scopeFilterForSearch === null
                ? "未分类"
                : ((projects ?? []).find((p) => p.id === scopeFilterForSearch)?.name ?? "当前项目")}
              」中搜索
            </span>
            <IconButton
              data-product-control
              aria-label="搜索全部项目"
              title="搜索全部项目"
              variant="muted"
              size="xs"
              shape="round"
              onClick={() => setIgnoreScopeForSearch(true)}
            >
              <X size={12} strokeWidth={1.75} />
            </IconButton>
          </div>
        )}

        {(onOpenBoard || onOpenSites || onOpenManage || onOpenMarketplace) && (
          <div className="mt-1.5 flex flex-col gap-0.5">
            {onOpenBoard && (
              <button
                type="button"
                data-product-feature={PRODUCT_CAPABILITIES.taskboard.id}
                data-testid="taskboard-nav"
                onClick={() => onOpenBoard()}
                aria-current={boardActive ? "true" : undefined}
                className={cn(NAV_ITEM_BASE, boardActive ? NAV_ITEM_ACTIVE : NAV_ITEM_IDLE)}
              >
                <AtelierIcon
                  name="tasks"
                  size={16}
                  className={cn("shrink-0 transition-colors", boardActive ? "text-accent" : "text-faint group-hover:text-fg")}
                />
                任务
              </button>
            )}
            {onOpenSites && (
              <button
                type="button"
                data-product-control
                data-testid="sites-nav"
                onClick={onOpenSites}
                aria-current={sitesActive ? "true" : undefined}
                className={cn(NAV_ITEM_BASE, sitesActive ? NAV_ITEM_ACTIVE : NAV_ITEM_IDLE)}
              >
                <AtelierIcon
                  name="sites"
                  size={16}
                  className={cn("shrink-0 transition-colors", sitesActive ? "text-accent" : "text-faint group-hover:text-fg")}
                />
                站点
              </button>
            )}
            {onOpenManage && (
              <button
                type="button"
                data-product-feature={PRODUCT_CAPABILITIES.memory.id}
                data-testid="manage-nav"
                title="管理中心：记忆 · 技能 · 定时 · 插件"
                onClick={onOpenManage}
                className={cn(NAV_ITEM_BASE, NAV_ITEM_IDLE)}
              >
                <LayoutGrid
                  size={16}
                  strokeWidth={1.75}
                  aria-hidden
                  className="shrink-0 text-faint transition-colors group-hover:text-fg"
                />
                管理中心
              </button>
            )}
            {onOpenMarketplace && (
              <button
                type="button"
                data-product-feature={PRODUCT_CAPABILITIES.marketplace.id}
                data-testid="marketplace-nav"
                onClick={onOpenMarketplace}
                className={cn(NAV_ITEM_BASE, NAV_ITEM_IDLE)}
              >
                <Store
                  size={16}
                  strokeWidth={1.75}
                  aria-hidden
                  className="shrink-0 text-faint transition-colors group-hover:text-fg"
                />
                市场
              </button>
            )}
          </div>
        )}
      </div>

      {showLiveActivityStrip && !searching && !multiSelect && (hasLiveCandidate || Boolean(optionalAuth)) && (
        <Suspense fallback={null}>
          <SidebarLiveActivityStrip
            sessions={activeSessions}
            projects={orderedProjects}
            isSending={isSending}
            liveTerminal={liveTerminal}
            sessionNeedsYou={sessionNeedsYou}
            unreadIds={unreadIds}
            swarmSessionIds={swarmSessionIds}
            socketVersion={socketVersion}
            activeId={activeId}
            auth={optionalAuth}
            onSelect={rowActions.select}
            onMarkRead={onMarkRead ? rowActions.markRead : undefined}
            onOpenBoard={onOpenBoard}
            onOpenLiveBrowser={onOpenLiveBrowser}
          />
        </Suspense>
      )}

      {multiSelect && onBatch && (
        <Suspense fallback={null}>
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
        </Suspense>
      )}

      {/* 会话列表导航语义:读屏用户按 landmark/region 快速跳到会话区(探针:工作区 nav=0)。 */}
      <nav aria-label="会话列表" className="flex min-h-0 flex-1 flex-col">
        <VirtualList
          items={listItems}
          threshold={virtualizeThreshold}
          onEndReached={hasMore && !searching ? onLoadMore : undefined}
          renderItem={renderFlat}
          className="no-scrollbar sidebar-scroll-fade flex-1 overflow-y-auto px-2 pb-3"
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

      {/* 底栏：克制发丝边界，账号胶囊 + 全局站内信铃铛光学对齐。 */}
      <div className="shrink-0 border-t border-border/60 px-2 pt-1.5 sidebar-foot-safe-b">
        <div className="flex items-center gap-0.5" data-product-entry-scope="sidebar-account">
          {hasAccountMenu ? (
            <DropdownMenu
              onOpenChange={(open) => {
                if (open) {
                  void preloadAccountMenu().catch(() => {});
                  setAccountMenuOpened(true);
                }
              }}
            >
              <DropdownMenuTrigger asChild>{userChip}</DropdownMenuTrigger>
              {accountMenuOpened && (() => {
                const AccountMenuComp = loadedAccountMenu?.AccountMenuContent ?? LazyAccountMenuContent;
                return (
                  <Suspense fallback={null}>
                    <AccountMenuComp
                      displayName={displayName}
                      email={email}
                      showSecondaryEmail={showSecondaryEmail}
                      credits={credits}
                      theme={theme}
                      onSetTheme={onSetTheme}
                      onCycleTheme={onCycleTheme}
                      showAdmin={showAdmin}
                      onOpenOrg={onOpenOrg}
                      onOpenStudio={onOpenStudio}
                      onOpenMediaTasks={onOpenMediaTasks}
                      onOpenChatGptProxy={onOpenChatGptProxy}
                      onOpenAccount={onOpenAccount}
                      onOpenPreferences={onOpenPreferences}
                      onOpenTutorial={onOpenTutorial}
                      onOpenFeedback={onOpenFeedback}
                      onLogout={onLogout}
                    />
                  </Suspense>
                );
              })()}
            </DropdownMenu>
          ) : (
            userChip
          )}
          {onOpenInbox && (
            <div className="relative shrink-0">
              <IconButton
                type="button"
                variant="muted"
                size="sm"
                shape="square"
                data-product-feature={PRODUCT_CAPABILITIES.inbox.id}
                data-testid="sidebar-inbox-btn"
                onClick={onOpenInbox}
                aria-label={hasUnreadInbox ? `站内信（${unreadCount} 条未读）` : "站内信"}
                title={hasUnreadInbox ? `站内信（${unreadCount} 条未读）` : "站内信"}
                className="oc-btn-tactile oc-spring-press rounded-sm hover:text-fg"
              >
                <Bell size={16} strokeWidth={1.75} />
              </IconButton>
              {hasUnreadInbox && (
                <span
                  data-testid="sidebar-inbox-badge"
                  data-unread-count={unreadCount}
                  aria-hidden="true"
                  className="pointer-events-none absolute right-1 top-1 size-1.5 rounded-full bg-accent ring-2 ring-sidebar [@media(hover:none)]:right-2.5 [@media(hover:none)]:top-2.5"
                />
              )}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

/** 「Ctrl K」/「⌘K」 hint for the palette button (Mac-family shows ⌘). */
function paletteKeyLabel(): string {
  const platform =
    typeof navigator === "undefined" ? "" : `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`;
  return /Mac|iPhone|iPad|iPod/i.test(platform) ? "⌘K" : "Ctrl K";
}
