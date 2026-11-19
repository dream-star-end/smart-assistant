import * as RD from "@radix-ui/react-dialog";
import {
  ArrowLeft,
  Brain,
  Check,
  Clock,
  Cpu,
  FolderInput,
  Globe,
  House,
  MessageSquarePlus,
  Plug,
  Plus,
  Search,
  Sparkles,
  SquareKanban,
  Wrench,
} from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ProjectTab } from "../hooks/useAppRoute";
import type { ManageTab } from "../lib/manageTabs";
import { readPaletteRecents } from "../lib/paletteRecents";
import { PROJECT_COLORS } from "../lib/projectColors";
import type { SessionNeedsYouKind } from "../lib/sessionStatus";
import type {
  ChatProject,
  ProjectAsset,
  PublicModel,
  Session,
  SessionSearchHit,
} from "../lib/types";
import { cn, relativeTime } from "../lib/utils";
import {
  PALETTE_FILTERS,
  type PaletteActionId,
  type PaletteFilter,
  type PaletteGroup,
  type PaletteItem,
  type PaletteSiteItem,
  buildMoveTargets,
  buildPaletteGroups,
  flattenPalette,
  nextPaletteFilter,
  paletteActions,
  paletteLiveLabel,
} from "./palette/paletteModel";
import "./palette/paletteUpgrade.css";
import { HighlightedText } from "./sidebar/highlight";
import { Badge, StatusPill } from "./ui";

export const PALETTE_SEARCH_DEBOUNCE_MS = 200;
const ASSET_SEARCH_LIMIT = 20;

export type CommandPaletteProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string | null | undefined;
  projects: readonly ChatProject[];
  sessions: readonly Session[];
  /** Project the user is in (its home page, or the open chat's project). */
  currentProjectId: string | null;
  /** On the current project's home page already (hides 打开项目主页). */
  onProjectHome?: boolean;
  /** The open chat, when 移动当前会话到… makes sense. */
  activeSession?: Session | null;
  searchMessages?: (q: string, signal: AbortSignal) => Promise<SessionSearchHit[]>;
  searchAssets?: (q: string, signal: AbortSignal, limit: number) => Promise<ProjectAsset[]>;
  onOpenProject: (projectId: string, tab?: ProjectTab) => void;
  onOpenSession: (sessionId: string) => void;
  /** Ungrouped file without a known source chat. */
  onOpenUngroupedAssets?: () => void;
  onNewSession: () => void;
  onNewSessionInProject?: (projectId: string) => void;
  onCreateProject: (name?: string) => void;
  onMoveSession?: (session: Session, projectId: string | null) => void;
  onOpenBoard?: () => void;
  onOpenSites?: () => void;
  /** 可选：活态会话状态（与 Sidebar LiveActivityStrip 同源）。 */
  isSending?: (id: string) => boolean;
  liveTerminal?: (
    id: string,
  ) => { lastOutcome?: string | null; lastErrorCode?: string | null } | undefined;
  sessionNeedsYou?: (id: string) => SessionNeedsYouKind | null | undefined;
  unreadIds?: ReadonlySet<string>;
  swarmSessionIds?: ReadonlySet<string>;
  onMarkRead?: (id: string) => void;
  /** 可选：站点列表与按 slug 直达回调。 */
  sites?: readonly PaletteSiteItem[];
  onOpenSite?: (slug: string) => void;
  /** 可选：显式模型切换（绝不隐藏强模型、不做黑盒降级）。 */
  models?: readonly PublicModel[];
  activeModelId?: string | null;
  onSelectModel?: (modelId: string) => void;
  /** 可选：工作区常用入口（记忆 / 技能 / 定时任务 / 插件 + 快问小窗）。 */
  onOpenManage?: (tab: ManageTab) => void;
  onOpenQuickAsk?: () => void;
};

type RemoteResults = { q: string; hits: SessionSearchHit[]; assets: ProjectAsset[] };

/**
 * Ctrl/⌘K: jump to a live chat, project, site, file, model switch, or workspace entry.
 * Lazy chunk (App mounts it on first open). Desktop: a top-anchored panel; under md: a
 * full-screen sheet with 44px rows.
 */
export function CommandPalette(props: CommandPaletteProps) {
  const {
    open,
    onOpenChange,
    userId,
    projects,
    sessions,
    currentProjectId,
    activeSession,
    searchMessages,
    searchAssets,
  } = props;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PaletteFilter>("all");
  const [mode, setMode] = useState<"list" | "move">("list");
  // Radix may hold an older onEscapeKeyDown closure; read the step from a ref.
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const [active, setActive] = useState(0);
  const [remote, setRemote] = useState<RemoteResults | null>(null);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const activatedRef = useRef(false);
  const listId = useId();

  const recents = useMemo(() => (open ? readPaletteRecents(userId) : []), [open, userId]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setFilter("all");
    setMode("list");
    setActive(0);
    setRemote(null);
    activatedRef.current = false;
  }, [open]);

  const q = query.trim();

  // Message and file search are server side: debounce, abort the previous one.
  // Both always run (the type filter is applied locally, so Tab never refetches).
  useEffect(() => {
    if (!open || mode !== "list" || !q || (!searchMessages && !searchAssets)) {
      setSearching(false);
      return;
    }
    const ac = new AbortController();
    setSearching(true);
    const timer = window.setTimeout(() => {
      void Promise.allSettled([
        searchMessages ? searchMessages(q, ac.signal) : Promise.resolve([]),
        searchAssets ? searchAssets(q, ac.signal, ASSET_SEARCH_LIMIT) : Promise.resolve([]),
      ]).then(([hits, assets]) => {
        if (ac.signal.aborted) return;
        setRemote({
          q,
          hits: hits.status === "fulfilled" ? hits.value : [],
          assets: assets.status === "fulfilled" ? assets.value : [],
        });
        setSearching(false);
      });
    }, PALETTE_SEARCH_DEBOUNCE_MS);
    return () => {
      ac.abort();
      window.clearTimeout(timer);
    };
  }, [open, mode, q, searchMessages, searchAssets]);

  const currentProject = currentProjectId
    ? (projects.find((p) => p.id === currentProjectId) ?? null)
    : null;
  const movable = activeSession && props.onMoveSession ? activeSession : null;

  const groups: PaletteGroup[] = useMemo(() => {
    if (mode === "move" && movable) return buildMoveTargets(projects, movable, query);
    const fresh = remote && remote.q === q ? remote : null;
    return buildPaletteGroups({
      query,
      filter,
      projects,
      sessions,
      messageHits: fresh?.hits,
      assets: fresh?.assets,
      currentProjectId: currentProject?.id ?? null,
      recents,
      isSending: props.isSending,
      liveTerminal: props.liveTerminal,
      sessionNeedsYou: props.sessionNeedsYou,
      unreadIds: props.unreadIds,
      swarmSessionIds: props.swarmSessionIds,
      sites: props.sites,
      models: props.models,
      activeModelId: props.activeModelId,
      canSelectModel: Boolean(props.onSelectModel),
      actions: paletteActions({
        query,
        currentProject,
        canNewInProject: !!props.onNewSessionInProject,
        canMoveSession: !!movable,
        canOpenHome: !props.onProjectHome,
        canOpenBoard: !!props.onOpenBoard,
        canOpenSites: !!props.onOpenSites,
        canOpenManage: !!props.onOpenManage,
        canOpenQuickAsk: !!props.onOpenQuickAsk,
      }),
    });
  }, [
    mode,
    movable,
    projects,
    sessions,
    query,
    q,
    filter,
    remote,
    currentProject,
    recents,
    props.isSending,
    props.liveTerminal,
    props.sessionNeedsYou,
    props.unreadIds,
    props.swarmSessionIds,
    props.sites,
    props.models,
    props.activeModelId,
    props.onSelectModel,
    props.onNewSessionInProject,
    props.onProjectHome,
    props.onOpenBoard,
    props.onOpenSites,
    props.onOpenManage,
    props.onOpenQuickAsk,
  ]);
  const flat = useMemo(() => flattenPalette(groups), [groups]);

  useEffect(() => {
    setActive(0);
  }, [query, filter, mode]);
  const activeIndex = flat.length === 0 ? -1 : Math.min(active, flat.length - 1);
  const activeKey = activeIndex >= 0 ? flat[activeIndex]!.key : null;

  useEffect(() => {
    if (!activeKey) return;
    const rows = listRef.current?.querySelectorAll<HTMLElement>("[data-palette-key]") ?? [];
    const el = Array.from(rows).find((r) => r.dataset.paletteKey === activeKey);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [activeKey]);

  const projectName = (id: string | null | undefined) =>
    id ? (projects.find((p) => p.id === id)?.name ?? null) : null;

  const close = () => {
    activatedRef.current = true;
    onOpenChange(false);
  };

  const runAction = (id: PaletteActionId) => {
    switch (id) {
      case "move-session":
        setMode("move");
        setQuery("");
        inputRef.current?.focus();
        return;
      case "new-in-project":
        close();
        if (currentProject) props.onNewSessionInProject?.(currentProject.id);
        return;
      case "new-session":
        close();
        props.onNewSession();
        return;
      case "new-project":
        close();
        props.onCreateProject(q || undefined);
        return;
      case "open-home":
        close();
        if (currentProject) props.onOpenProject(currentProject.id);
        return;
      case "open-board":
        close();
        props.onOpenBoard?.();
        return;
      case "open-sites":
        close();
        props.onOpenSites?.();
        return;
      case "open-memory":
        close();
        props.onOpenManage?.("memory");
        return;
      case "open-skills":
        close();
        props.onOpenManage?.("skills");
        return;
      case "open-cron":
        close();
        props.onOpenManage?.("cron");
        return;
      case "open-connectors":
        close();
        props.onOpenManage?.("connectors");
        return;
      case "open-quick-ask":
        close();
        props.onOpenQuickAsk?.();
        return;
    }
  };

  const activate = (item: PaletteItem) => {
    switch (item.kind) {
      case "project":
        close();
        props.onOpenProject(item.project.id);
        return;
      case "session":
        if (item.liveBucket === "unread_done") props.onMarkRead?.(item.sessionId);
        close();
        props.onOpenSession(item.sessionId);
        return;
      case "asset": {
        const a = item.asset;
        close();
        if (a.projectId && projects.some((p) => p.id === a.projectId)) {
          props.onOpenProject(a.projectId, a.source === "output" ? "outputs" : "files");
        } else if (a.sessionId) {
          props.onOpenSession(a.sessionId);
        } else {
          props.onOpenUngroupedAssets?.();
        }
        return;
      }
      case "site":
        close();
        if (props.onOpenSite) props.onOpenSite(item.site.slug);
        else props.onOpenSites?.();
        return;
      case "model":
        if (item.disabled) return;
        close();
        props.onSelectModel?.(item.model.id);
        return;
      case "action":
        runAction(item.action.id);
        return;
      case "move-target":
        close();
        if (movable) props.onMoveSession?.(movable, item.projectId);
        return;
    }
  };

  const backToList = () => {
    setMode("list");
    setQuery("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // IME composition (pinyin): Enter/arrows belong to the candidate window.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (flat.length === 0) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive(((Math.max(activeIndex, 0) + step) % flat.length + flat.length) % flat.length);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const item = activeIndex >= 0 ? flat[activeIndex] : undefined;
      if (item) activate(item);
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      if (mode === "list") setFilter((f) => nextPaletteFilter(f, e.shiftKey ? -1 : 1));
      return;
    }
    if (e.key === "Backspace" && mode === "move" && query === "") {
      e.preventDefault();
      backToList();
    }
  };

  const placeholder =
    mode === "move"
      ? "选择要移入的项目"
      : "搜索活态会话、项目、站点、模型、文件或工作区入口";

  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-50 bg-black/30 data-[state=open]:animate-fade" />
        <RD.Content
          aria-describedby={undefined}
          data-testid="command-palette"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            inputRef.current?.focus();
          }}
          onCloseAutoFocus={(e) => {
            // A result moved the user elsewhere (or opened another dialog): don't
            // yank focus back to whatever had it before the palette.
            if (activatedRef.current) e.preventDefault();
          }}
          onEscapeKeyDown={(e) => {
            // Esc while an input method is composing only cancels the candidate.
            if (e.isComposing || e.keyCode === 229) {
              e.preventDefault();
              return;
            }
            if (modeRef.current === "move") {
              e.preventDefault();
              backToList();
            }
          }}
          className={cn(
            "oc-palette-shell fixed inset-0 z-50 flex flex-col overflow-hidden bg-elevated outline-none pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] data-[state=open]:animate-in",
            "md:inset-auto md:left-1/2 md:top-[12vh] md:max-h-[min(74vh,38rem)] md:w-[min(42rem,calc(100vw-2rem))] md:-translate-x-1/2 md:rounded-xl md:border md:border-border md:pb-0 md:pt-0 md:shadow-float",
          )}
        >
          <RD.Title className="sr-only">快速跳转</RD.Title>
          <div className="oc-palette-header">
            {mode === "move" ? (
              <button
                type="button"
                aria-label="返回"
                onClick={backToList}
                className="flex h-11 w-9 shrink-0 items-center justify-center rounded-sm text-muted hover:text-fg focus-visible:ring-2 focus-visible:ring-ring md:h-8"
              >
                <ArrowLeft size={16} />
              </button>
            ) : (
              <Search size={16} aria-hidden className="shrink-0 text-faint" />
            )}
            <input
              ref={inputRef}
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={activeKey ? paletteOptionId(listId, activeKey) : undefined}
              aria-label={mode === "move" ? "选择要移入的项目" : "搜索与跳转"}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={placeholder}
              autoComplete="off"
              spellCheck={false}
              className="h-14 min-w-0 flex-1 bg-transparent text-base text-fg outline-none placeholder:text-faint md:h-12"
            />
            <RD.Close asChild>
              <button
                type="button"
                className="flex h-11 shrink-0 items-center rounded-sm px-2 text-sm text-muted hover:text-fg focus-visible:ring-2 focus-visible:ring-ring md:hidden"
              >
                取消
              </button>
            </RD.Close>
          </div>
          {mode === "list" && (
            <div
              role="group"
              aria-label="结果类型"
              className="oc-palette-filter-bar"
            >
              {PALETTE_FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  tabIndex={-1}
                  aria-pressed={filter === f.id}
                  onClick={() => {
                    setFilter(f.id);
                    inputRef.current?.focus();
                  }}
                  className={cn(
                    "min-h-9 shrink-0 rounded-full px-3 text-meta transition-colors md:min-h-7 md:px-2.5",
                    filter === f.id ? "bg-accent-soft text-accent" : "text-muted hover:bg-hover hover:text-fg",
                  )}
                >
                  {f.label}
                </button>
              ))}
              {searching && <span className="ml-auto shrink-0 text-caption text-faint">正在搜索消息与文件…</span>}
            </div>
          )}
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label="结果"
            className="min-h-0 flex-1 overflow-y-auto px-2 py-2"
          >
            {groups.map((g) => (
              <div key={g.id} role="group" aria-label={g.label} className="mb-1">
                <div className="oc-palette-group-head">
                  <span>{g.label}</span>
                  {g.items.length > 1 && (
                    <span aria-hidden className="oc-palette-group-count">
                      {g.items.length}
                    </span>
                  )}
                </div>
                {g.items.map((item) => {
                  const idx = flat.indexOf(item);
                  return (
                    <PaletteRow
                      key={item.key}
                      id={paletteOptionId(listId, item.key)}
                      item={item}
                      selected={idx === activeIndex}
                      query={mode === "list" ? q : ""}
                      inCurrentGroup={g.id === "current"}
                      projectName={projectName}
                      onHover={() => setActive(idx)}
                      onClick={() => activate(item)}
                    />
                  );
                })}
              </div>
            ))}
            {flat.length === 0 && (
              <div className="px-3 py-8 text-center text-sm text-muted">
                {searching ? "正在搜索…" : mode === "move" ? "没有可移入的项目" : "没有找到匹配的结果"}
              </div>
            )}
          </div>
          <div className="oc-palette-footer">
            <span>
              <kbd className="oc-palette-kbd">↑↓</kbd> 选择 ·{" "}
              <kbd className="oc-palette-kbd">Enter</kbd> 执行 ·{" "}
              <kbd className="oc-palette-kbd">Tab</kbd> 限定类型 ·{" "}
              <kbd className="oc-palette-kbd">Esc</kbd> {mode === "move" ? "返回" : "关闭"}
            </span>
          </div>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

function paletteOptionId(listId: string, key: string): string {
  return `${listId}-${key.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

function ProjectDot({ color }: { color?: string | null }) {
  const cls = PROJECT_COLORS.find((c) => c.key === color)?.dotClass ?? "bg-muted";
  return <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", cls)} />;
}

function when(at: number | undefined): string {
  return typeof at === "number" && Number.isFinite(at) && at > 0 ? relativeTime(new Date(at).toISOString()) : "";
}

function actionIcon(id: PaletteActionId) {
  switch (id) {
    case "new-project":
      return Plus;
    case "move-session":
      return FolderInput;
    case "open-home":
      return House;
    case "open-board":
      return SquareKanban;
    case "open-sites":
      return Globe;
    case "open-memory":
      return Brain;
    case "open-skills":
      return Wrench;
    case "open-cron":
      return Clock;
    case "open-connectors":
      return Plug;
    case "open-quick-ask":
      return Sparkles;
    default:
      return MessageSquarePlus;
  }
}

function liveIndicator(bucket: "needs_you" | "running" | "unread_done") {
  if (bucket === "needs_you") {
    return <StatusPill status="needs_you" variant="dot" size="sm" mark="question" decorative />;
  }
  if (bucket === "running") {
    return <StatusPill status="running" variant="dot" size="sm" mark="ring" decorative />;
  }
  return <StatusPill status="done" variant="dot" size="sm" decorative />;
}

function PaletteRow({
  id,
  item,
  selected,
  query,
  inCurrentGroup,
  projectName,
  onHover,
  onClick,
}: {
  id: string;
  item: PaletteItem;
  selected: boolean;
  query: string;
  inCurrentGroup: boolean;
  projectName: (id: string | null | undefined) => string | null;
  onHover: () => void;
  onClick: () => void;
}) {
  let lead: ReactNode = null;
  let body: ReactNode = null;
  let sub: ReactNode = null;
  let trail: ReactNode = null;
  const disabled = item.kind === "model" && Boolean(item.disabled);
  const prefix = (pid: string | null | undefined) => {
    if (inCurrentGroup) return null;
    const name = pid ? projectName(pid) : "未分类";
    return name ? <span className="text-muted">{name} › </span> : null;
  };
  switch (item.kind) {
    case "project":
      lead = <Badge size="sm" tone="neutral">项目</Badge>;
      body = (
        <span className="flex min-w-0 items-center gap-2">
          <ProjectDot color={item.project.color} />
          <span className="truncate">
            <HighlightedText text={item.project.name} query={query} />
          </span>
          {item.project.archivedAt ? <Badge size="sm" tone="warning">已归档</Badge> : null}
        </span>
      );
      trail = `${item.project.sessionCount} 个会话`;
      break;
    case "session": {
      const liveText = paletteLiveLabel(item);
      lead = item.liveBucket ? (
        <span data-bucket={item.liveBucket} className="oc-palette-live-pill">
          {liveIndicator(item.liveBucket)}
          <span>{liveText}</span>
        </span>
      ) : (
        <Badge size="sm" tone="accent">会话</Badge>
      );
      body = (
        <span className="truncate">
          {prefix(item.projectId)}
          <HighlightedText text={item.title} query={query} />
        </span>
      );
      if (item.snippet) {
        sub = (
          <span className="block truncate text-caption text-muted">
            <HighlightedText text={item.snippet} query={query} />
          </span>
        );
      }
      trail = when(item.at);
      break;
    }
    case "asset":
      lead = (
        <Badge size="sm" tone={item.asset.source === "output" ? "info" : "neutral"}>
          {item.asset.source === "output" ? "产出" : "文件"}
        </Badge>
      );
      body = (
        <span className="truncate">
          {prefix(item.asset.projectId)}
          <HighlightedText text={item.asset.name} query={query} />
        </span>
      );
      if (item.asset.excerpt && query && !item.asset.name.toLowerCase().includes(query.toLowerCase())) {
        sub = (
          <span className="block truncate text-caption text-muted">
            <HighlightedText text={excerptAround(item.asset.excerpt, query)} query={query} />
          </span>
        );
      }
      trail = when(item.asset.createdAt);
      break;
    case "site":
      lead = <Badge size="sm" tone="info">站点</Badge>;
      body = (
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">
            <HighlightedText text={item.site.title || item.site.slug} query={query} />
          </span>
          {item.site.hasServerApi ? <Badge size="sm" tone="neutral">全栈</Badge> : null}
        </span>
      );
      sub = (
        <span className="block truncate text-caption text-muted">
          <HighlightedText text={item.site.customDomain || item.site.slug} query={query} />
        </span>
      );
      trail = item.site.visibility === "password" ? "密码保护" : item.site.visibility === "disabled" ? "已停用" : "在线";
      break;
    case "model":
      lead = <Cpu size={15} aria-hidden className="shrink-0 text-muted" />;
      body = (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-medium">
            <HighlightedText text={item.meta.label} query={query} />
          </span>
          {item.meta.isFlagship && (
            <span data-testid="palette-model-flagship" className="oc-palette-model-flagship">
              旗舰
            </span>
          )}
          {item.meta.isCurrent && (
            <span data-testid="palette-model-current" className="oc-palette-model-current">
              <Check size={11} aria-hidden />
              当前
            </span>
          )}
          {item.meta.isDegraded && (
            <span className="oc-palette-model-degraded">暂不可用</span>
          )}
          {item.meta.promoLabel && !item.meta.isDegraded && (
            <Badge size="sm" tone="warning">{item.meta.promoLabel}</Badge>
          )}
        </span>
      );
      if (item.meta.label !== item.model.id) {
        sub = <span className="block truncate text-caption text-faint">{item.model.id}</span>;
      }
      trail = item.meta.costLabel ?? "";
      break;
    case "action": {
      const Icon = actionIcon(item.action.id);
      lead = <Icon size={15} aria-hidden className="shrink-0 text-muted" />;
      body = <span className="truncate">{item.action.label}</span>;
      trail = item.action.hint ?? null;
      break;
    }
    case "move-target":
      lead = item.projectId ? (
        <ProjectDot color={item.color} />
      ) : (
        <span aria-hidden className="size-2 shrink-0 rounded-full border border-border" />
      );
      body = (
        <span className="truncate">
          <HighlightedText text={item.label} query={query} />
        </span>
      );
      break;
  }
  const enterHint =
    item.kind === "action" && item.action.id === "move-session"
      ? "Enter 选择"
      : item.kind === "model"
        ? item.disabled
          ? "暂不可选"
          : "Enter 切换"
        : "Enter 打开";
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      aria-disabled={disabled || undefined}
      data-palette-key={item.key}
      data-palette-kind={item.kind}
      onMouseMove={selected ? undefined : onHover}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "oc-palette-row flex min-h-11 cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-fg md:min-h-9",
        selected && "bg-hover",
      )}
    >
      {lead}
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center">{body}</span>
        {sub}
      </span>
      {selected ? (
        <span aria-hidden className="hidden shrink-0 text-caption text-muted md:inline">
          {enterHint}
        </span>
      ) : trail ? (
        <span
          aria-hidden={item.kind === "action" ? true : undefined}
          className="shrink-0 text-caption text-faint"
        >
          {trail}
        </span>
      ) : null}
    </div>
  );
}

/** A short window of the excerpt around the first hit. */
export function excerptAround(text: string, query: string, radius = 30): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const at = flat.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return flat.slice(0, radius * 2);
  const start = Math.max(0, at - radius);
  const end = Math.min(flat.length, at + query.length + radius);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}
