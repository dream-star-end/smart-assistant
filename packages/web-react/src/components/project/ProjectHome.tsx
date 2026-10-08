import {
  ArrowRight,
  ArrowUp,
  CalendarDays,
  File as FileIcon,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  Menu,
  MessageSquare,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Pin,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  Upload,
  type LucideIcon,
} from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ProjectTab } from "../../hooks/useAppRoute";
import { useProjectAssets } from "../../hooks/useProjectAssets";
import { useProjectScope } from "../../hooks/useProjectScope";
import { PROJECT_COLORS } from "../../lib/projectColors";
import type { AuthSession, ChatProject, ProjectAsset, Session } from "../../lib/types";
import { cn } from "../../lib/utils";
import { ProjectAssetsPanel } from "../ProjectAssetsPanel";
import {
  Alert,
  Badge,
  Button,
  Card,
  Chip,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  IconButton,
  Input,
  Skeleton,
  Spinner,
  Tabs,
  TimeAgo,
  useConfirm,
  usePrompt,
  useToast,
} from "../ui";
import {
  OUTPUT_KIND_LABELS,
  type OutputKind,
  PROJECT_RECIPES,
  filterSessionsByTitle,
  outputKind,
  outputsOf,
  pinnedOf,
  projectSessionsOf,
  projectSummary,
} from "./projectHomeModel";

export type ProjectHomeProps = {
  project: ChatProject;
  tab: ProjectTab;
  onTabChange: (tab: ProjectTab) => void;
  /** App 的会话列表（全部）；主页自己按 projectId 过滤。 */
  sessions: Session[];
  demo: boolean;
  auth: AuthSession | null;
  authSession: AuthSession;
  /** 在本项目开新会话并把 text 作为第一条消息发送。 */
  onStart: (text: string) => void;
  /** 在本项目开一个空白新会话（不发送）。 */
  onNewSession: () => void;
  onOpenSession: (sessionId: string) => void;
  onOpenSettings: () => void;
  onRename: () => void;
  onDelete: () => void;
  onOpenMobileNav: () => void;
  /**
   * 拉取已归档会话（与侧栏「已归档」展开同一个加载，幂等）。默认列表不含归档，
   * 「会话」页签与产出的来源会话要用到它们。
   */
  onLoadArchived?: () => void;
  loadingArchived?: boolean;
  sidebarCollapsed?: boolean;
  onExpandSidebar?: () => void;
  /**
   * 项目的看板/记忆/技能/定时任务在各自的页面里,按本项目的范围打开。
   * onPrepareBoard 确保本项目的看板已在容器里建好(首次用时创建);成功后本组件把
   * 项目范围切到这块看板,再由 onShowSurface 打开对应页面。不传则不显示入口。
   */
  onPrepareBoard?: () => Promise<boolean>;
  onShowSurface?: (surface: ProjectSurface) => void;
};

export type ProjectSurface = "board" | "memory" | "skills" | "cron";
const SURFACES: Array<{ id: ProjectSurface; label: string }> = [
  { id: "board", label: "看板" },
  { id: "memory", label: "记忆" },
  { id: "skills", label: "技能" },
  { id: "cron", label: "定时任务" },
];

const OVERVIEW_SESSION_LIMIT = 5;
const OVERVIEW_OUTPUT_LIMIT = 6;

const KIND_ICON: Record<OutputKind, LucideIcon> = {
  doc: FileText,
  image: FileImage,
  table: FileSpreadsheet,
  code: FileCode,
  other: FileIcon,
};

/**
 * 项目主页（`/p/<id>[/<tab>]`）：一个项目的所有东西在一处 —— 开始新会话、最近会话、
 * 项目指令、常用文件、产出。只用已有接口（会话列表来自 App、资产来自 useProjectAssets）。
 * App 懒加载本组件（首屏预算），demo 模式下资产为空、上传走本地。
 */
export function ProjectHome(props: ProjectHomeProps) {
  const {
    project,
    tab,
    onTabChange,
    sessions,
    demo,
    auth,
    authSession,
    onStart,
    onNewSession,
    onOpenSession,
    onOpenSettings,
    onRename,
    onDelete,
    onOpenMobileNav,
    onLoadArchived,
    loadingArchived = false,
    sidebarCollapsed,
    onPrepareBoard,
    onShowSurface,
    onExpandSidebar,
  } = props;

  const [confirmDialog, confirmEl] = useConfirm();
  const [promptText, promptEl] = usePrompt();
  const assetsState = useProjectAssets({
    projectId: project.id,
    demo,
    auth,
    authSession,
    confirmDialog,
    promptText,
    // 「文件」页签由 ProjectAssetsPanel 自带一份；这里只为概览 / 产出拉。
    enabled: tab !== "files",
  });
  const { assets, loading: assetsLoading, error: assetsError, reload: reloadAssets } = assetsState;
  const assetsReady = !assetsLoading && !assetsError;

  // 从「文件」页签回来时重拉：那边的上传 / 设为常用不经过本实例。
  const prevTabRef = useRef(tab);
  useEffect(() => {
    if (prevTabRef.current === "files" && tab !== "files") reloadAssets();
    prevTabRef.current = tab;
  }, [tab, reloadAssets]);

  const projectSessions = useMemo(
    () => projectSessionsOf(sessions, project.id),
    [sessions, project.id],
  );
  const allProjectSessions = useMemo(
    () => projectSessionsOf(sessions, project.id, true),
    [sessions, project.id],
  );
  const titleById = useMemo(
    () => new Map(sessions.map((s) => [s.id, s.title || "新对话"])),
    [sessions],
  );
  const outputs = useMemo(() => outputsOf(assets), [assets]);

  // 「会话」页签要列全（含归档），产出要能找到来源会话：需要时触发已归档会话加载。
  const outputsMissSource = outputs.some((a) => a.sessionId && !titleById.has(a.sessionId));
  const needsArchived = tab === "chats" || outputsMissSource;
  const loadArchivedRef = useRef(onLoadArchived);
  loadArchivedRef.current = onLoadArchived;
  useEffect(() => {
    if (needsArchived) loadArchivedRef.current?.();
  }, [needsArchived]);
  const pinned = useMemo(() => pinnedOf(assets), [assets]);
  const lastSession = projectSessions[0];
  const swatch = PROJECT_COLORS.find((c) => c.key === project.color);
  const instructions = project.instructions?.trim() ?? "";

  const summary = projectSummary({
    hasInstructions: instructions.length > 0,
    pinnedCount: assetsReady ? pinned.length : null,
    sessionCount: projectSessions.length,
  });

  const tabItems = [
    { value: "overview", label: "概览" },
    {
      value: "chats",
      label: (
        <>
          会话
          {projectSessions.length > 0 && (
            <span className="ml-1 tabular-nums text-faint">{projectSessions.length}</span>
          )}
        </>
      ),
    },
    { value: "files", label: "文件" },
    {
      value: "outputs",
      label: (
        <>
          产出
          {assetsReady && outputs.length > 0 && (
            <span className="ml-1 tabular-nums text-faint">{outputs.length}</span>
          )}
        </>
      ),
    },
  ];

  return (
    <div data-testid="project-home" className="flex h-full min-h-0 flex-col bg-bg">
      {confirmEl}
      {promptEl}
      <header className="flex shrink-0 items-center gap-2 px-3 pb-2 header-safe-t md:h-14 md:px-4 md:pb-0">
        <IconButton
          onClick={onOpenMobileNav}
          aria-label="打开菜单"
          shape="square"
          className="md:hidden"
        >
          <Menu size={18} />
        </IconButton>
        {sidebarCollapsed && onExpandSidebar && (
          <IconButton
            onClick={onExpandSidebar}
            aria-label="展开侧栏"
            shape="square"
            className="hidden md:inline-flex"
          >
            <PanelLeft size={18} />
          </IconButton>
        )}
        <span className="text-meta text-muted">项目</span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="@container mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 pb-10 pt-1 md:px-5 md:pt-4">
          {/* 标题行：颜色点 · 名称 · ⋯ */}
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex min-w-0 items-center gap-2">
              {swatch ? (
                <span aria-hidden className={cn("size-3 shrink-0 rounded-full", swatch.dotClass)} />
              ) : (
                <FolderOpen size={18} aria-hidden className="shrink-0 text-faint" />
              )}
              <h1 className="min-w-0 truncate text-title font-semibold md:text-xl">{project.name}</h1>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton aria-label={`项目 ${project.name} 更多`} size="sm" shape="square">
                    <MoreHorizontal size={16} />
                  </IconButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-44">
                  <DropdownMenuItem onSelect={onOpenSettings}>
                    <Settings2 size={14} className="shrink-0 text-muted" />
                    项目设置
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={onRename}>
                    <Pencil size={14} className="shrink-0 text-muted" />
                    重命名
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem destructive onSelect={onDelete}>
                    <Trash2 size={14} className="shrink-0" />
                    删除
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <p data-testid="project-home-summary" className="text-meta text-muted">
              {summary}
            </p>
          </div>

          <StartBox projectName={project.name} onStart={onStart} />

          <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:px-0">
            {PROJECT_RECIPES.map((r) => (
              <Chip key={r.key} onClick={() => onStart(r.prompt)}>
                {r.key === "progress" ? (
                  <Sparkles size={13} aria-hidden />
                ) : (
                  <CalendarDays size={13} aria-hidden />
                )}
                {r.label}
              </Chip>
            ))}
            {lastSession && (
              <Chip
                onClick={() => onOpenSession(lastSession.id)}
                title={lastSession.title || "新对话"}
                className="max-w-[18rem]"
              >
                <RotateCcw size={13} aria-hidden />
                <span className="min-w-0 truncate">继续上次：{lastSession.title || "新对话"}</span>
              </Chip>
            )}
          </div>

          {project.boardProjectId && onPrepareBoard && onShowSurface && (
            <ProjectSurfaceLinks
              boardProjectId={project.boardProjectId}
              onPrepareBoard={onPrepareBoard}
              onShowSurface={onShowSurface}
            />
          )}

          <div className="flex min-w-0 items-center gap-2 border-b border-border pb-2">
            <div className="min-w-0 flex-1">
              <Tabs
                aria-label="项目页签"
                value={tab}
                onValueChange={(v) => onTabChange(v as ProjectTab)}
                items={tabItems}
                idBase="project-home"
              />
            </div>
            <Button variant="ghost" size="sm" onClick={onOpenSettings} className="shrink-0">
              <Settings2 size={14} aria-hidden />
              设置
            </Button>
          </div>

          <div id={`project-home-panel-${tab}`} role="tabpanel" aria-labelledby={`project-home-tab-${tab}`}>
            {tab === "overview" && (
              <OverviewTab
                sessions={projectSessions}
                instructions={instructions}
                pinned={pinned}
                outputs={outputs}
                assetsLoading={assetsLoading}
                assetsError={assetsError}
                onReloadAssets={reloadAssets}
                titleById={titleById}
                onOpenSession={onOpenSession}
                onOpenSettings={onOpenSettings}
                onTabChange={onTabChange}
              />
            )}
            {tab === "chats" && (
              <ChatsTab
                sessions={allProjectSessions}
                loadingArchived={loadingArchived}
                onOpenSession={onOpenSession}
                onNewSession={onNewSession}
              />
            )}
            {tab === "files" && (
              <ProjectAssetsPanel
                projectId={project.id}
                demo={demo}
                auth={auth}
                authSession={authSession}
                sessions={sessions}
                onOpenSession={onOpenSession}
              />
            )}
            {tab === "outputs" && (
              <OutputsTab
                outputs={outputs}
                loading={assetsLoading}
                error={assetsError}
                onReload={reloadAssets}
                titleById={titleById}
                onOpenSession={onOpenSession}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 「在「项目」里开始…」：Enter 发送（Shift+Enter 换行，输入法组字中不发）。 */
function StartBox({ projectName, onStart }: { projectName: string; onStart: (text: string) => void }) {
  const [text, setText] = useState("");
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onStart(t);
    setText("");
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    submit();
  };
  return (
    <form
      className="flex items-end gap-2 rounded-2xl border border-border bg-surface p-3 shadow-soft focus-within:border-border-strong"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <textarea
        aria-label={`在「${projectName}」里开始`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        rows={2}
        placeholder={`在「${projectName}」里开始…`}
        className="min-h-12 flex-1 resize-none bg-transparent text-base leading-relaxed text-fg outline-none placeholder:text-faint md:text-sm"
      />
      <IconButton
        type="submit"
        aria-label="开始新会话"
        variant="solid"
        disabled={!text.trim()}
        className="shrink-0"
      >
        <ArrowUp size={18} />
      </IconButton>
    </form>
  );
}

function SectionCard({
  title,
  action,
  children,
  testId,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <Card padding="md" className="flex min-w-0 flex-col gap-3" data-testid={testId}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-section font-semibold text-fg">{title}</h2>
        {action}
      </div>
      {children}
    </Card>
  );
}

function LinkAction({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <Button variant="link" size="sm" onClick={onClick} className="h-auto px-0 [@media(hover:none)]:min-h-11">
      {children}
    </Button>
  );
}

function SessionLine({
  session,
  onOpen,
  showPreview = false,
}: {
  session: Session;
  onOpen: (id: string) => void;
  showPreview?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(session.id)}
      className="flex w-full min-w-0 items-center gap-3 rounded-md px-2 py-2 text-left outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11"
    >
      <MessageSquare size={14} aria-hidden className="shrink-0 text-faint" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-body text-fg">{session.title || "新对话"}</span>
        {showPreview && session.lastMessagePreview && (
          <span className="truncate text-caption text-muted">{session.lastMessagePreview}</span>
        )}
      </span>
      {session.archived && <Badge size="sm">已归档</Badge>}
      <TimeAgo
        value={session.lastAt ?? session.updatedAt}
        className="shrink-0 text-caption text-faint"
      />
    </button>
  );
}

function AssetsError({ error, onReload }: { error: string; onReload: () => void }) {
  return (
    <Alert
      tone="danger"
      action={
        <Button size="sm" variant="secondary" onClick={onReload}>
          重试
        </Button>
      }
    >
      {error}
    </Alert>
  );
}

function OverviewTab({
  sessions,
  instructions,
  pinned,
  outputs,
  assetsLoading,
  assetsError,
  onReloadAssets,
  titleById,
  onOpenSession,
  onOpenSettings,
  onTabChange,
}: {
  sessions: Session[];
  instructions: string;
  pinned: ProjectAsset[];
  outputs: ProjectAsset[];
  assetsLoading: boolean;
  assetsError: string | null;
  onReloadAssets: () => void;
  titleById: Map<string, string>;
  onOpenSession: (id: string) => void;
  onOpenSettings: () => void;
  onTabChange: (tab: ProjectTab) => void;
}) {
  const recent = sessions.slice(0, OVERVIEW_SESSION_LIMIT);
  const latestOutputs = outputs.slice(0, OVERVIEW_OUTPUT_LIMIT);
  return (
    <div className="grid min-w-0 gap-4 @2xl:grid-cols-2">
      <SectionCard
        title="最近会话"
        testId="project-home-recent"
        action={
          sessions.length > OVERVIEW_SESSION_LIMIT ? (
            <LinkAction onClick={() => onTabChange("chats")}>
              全部 {sessions.length}
              <ArrowRight size={13} aria-hidden />
            </LinkAction>
          ) : undefined
        }
      >
        {recent.length === 0 ? (
          <p className="text-meta text-muted">
            还没有会话。在上面的输入框说点什么，或点一个快捷开始。
          </p>
        ) : (
          <div className="-mx-2 flex flex-col">
            {recent.map((s) => (
              <SessionLine key={s.id} session={s} onOpen={onOpenSession} />
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="项目指令"
        testId="project-home-instructions"
        action={<LinkAction onClick={onOpenSettings}>{instructions ? "编辑" : "添加"}</LinkAction>}
      >
        {instructions ? (
          <>
            <p className="line-clamp-4 whitespace-pre-wrap rounded-lg bg-hover px-3 py-2 text-body text-fg">
              {instructions}
            </p>
            <p className="text-caption text-faint">这个项目里的所有会话都会遵守这些指令。</p>
          </>
        ) : (
          <p className="text-meta text-muted">
            还没有项目指令。写下这个项目的背景、偏好和要求，项目里的所有会话都会遵守。
          </p>
        )}
      </SectionCard>

      <SectionCard
        title="常用文件"
        testId="project-home-pinned"
        action={
          <LinkAction onClick={() => onTabChange("files")}>
            管理
            <ArrowRight size={13} aria-hidden />
          </LinkAction>
        }
      >
        {assetsError ? (
          <AssetsError error={assetsError} onReload={onReloadAssets} />
        ) : assetsLoading ? (
          <Skeleton className="h-8 w-2/3" />
        ) : pinned.length === 0 ? (
          <div className="flex flex-col items-start gap-2">
            <p className="text-meta text-muted">
              还没有常用文件。在「文件」里上传资料并设为常用，项目里的所有会话都会参考它们。
            </p>
            <Button size="sm" variant="secondary" onClick={() => onTabChange("files")}>
              <Upload size={14} aria-hidden />
              上传文件
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {pinned.map((a) => (
              <span
                key={a.id}
                title={a.name}
                className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-meta text-fg"
              >
                <Pin size={12} aria-hidden className="shrink-0 text-warning" />
                <span className="min-w-0 truncate">{a.name}</span>
              </span>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="最新产出"
        testId="project-home-outputs"
        action={
          outputs.length > 0 ? (
            <LinkAction onClick={() => onTabChange("outputs")}>
              全部 {outputs.length}
              <ArrowRight size={13} aria-hidden />
            </LinkAction>
          ) : undefined
        }
      >
        {assetsError ? (
          <AssetsError error={assetsError} onReload={onReloadAssets} />
        ) : assetsLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : latestOutputs.length === 0 ? (
          <p className="text-meta text-muted">
            还没有产出。智能体在这个项目的会话里生成的文件会出现在这里。
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {latestOutputs.map((a) => (
              <OutputTile
                key={a.id}
                asset={a}
                sourceTitle={a.sessionId ? titleById.get(a.sessionId) : undefined}
                onOpenSession={onOpenSession}
                compact
              />
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

function OutputTile({
  asset,
  sourceTitle,
  onOpenSession,
  compact = false,
}: {
  asset: ProjectAsset;
  sourceTitle?: string;
  onOpenSession: (id: string) => void;
  compact?: boolean;
}) {
  const kind = outputKind(asset);
  const Icon = KIND_ICON[kind];
  const canOpen = Boolean(asset.sessionId && sourceTitle);
  const body = (
    <>
      <span
        aria-hidden
        className={cn(
          "flex shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent",
          compact ? "size-9" : "h-20 w-full",
        )}
      >
        <Icon size={compact ? 16 : 24} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-body font-medium text-fg" title={asset.name}>
          {asset.name}
        </span>
        <span className="truncate text-caption text-muted">
          {sourceTitle ? `来自「${sourceTitle}」` : OUTPUT_KIND_LABELS[kind]}
          {" · "}
          <TimeAgo value={asset.createdAt} tooltip={false} />
        </span>
      </span>
    </>
  );
  const cls = cn(
    "flex min-w-0 rounded-lg border border-border bg-surface p-2 text-left",
    compact ? "items-center gap-2" : "flex-col gap-2",
  );
  if (compact && canOpen) {
    return (
      <button
        type="button"
        onClick={() => onOpenSession(asset.sessionId!)}
        title="在会话中打开"
        className={cn(
          cls,
          "outline-none transition-colors hover:border-border-strong hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11",
        )}
      >
        {body}
      </button>
    );
  }
  return (
    <div className={cls} data-output-kind={kind}>
      {body}
      {!compact && canOpen && (
        <Button
          size="sm"
          variant="ghost"
          className="self-start px-2"
          onClick={() => onOpenSession(asset.sessionId!)}
        >
          在会话中打开
          <ArrowRight size={13} aria-hidden />
        </Button>
      )}
    </div>
  );
}

function ChatsTab({
  sessions,
  loadingArchived,
  onOpenSession,
  onNewSession,
}: {
  sessions: Session[];
  loadingArchived: boolean;
  onOpenSession: (id: string) => void;
  onNewSession: () => void;
}) {
  const [query, setQuery] = useState("");
  const shown = useMemo(() => filterSessionsByTitle(sessions, query), [sessions, query]);
  if (sessions.length === 0 && loadingArchived) {
    return (
      <div data-testid="project-chats-loading" className="flex items-center justify-center gap-2 py-12 text-meta text-muted">
        <Spinner size={14} />
        正在加载会话…
      </div>
    );
  }
  if (sessions.length === 0) {
    return (
      <EmptyState
        icon={MessageSquare}
        title="这个项目还没有会话"
        hint="在上面的输入框开始第一个会话，项目指令和常用文件会自动带上。"
        action={
          <Button size="sm" variant="secondary" onClick={onNewSession}>
            <Plus size={14} aria-hidden />
            新建会话
          </Button>
        }
      />
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search
            size={14}
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
          />
          <Input
            type="search"
            aria-label="按标题筛选会话"
            placeholder="按标题筛选"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-8"
          />
        </div>
        <Button size="sm" variant="secondary" onClick={onNewSession} className="shrink-0">
          <Plus size={14} aria-hidden />
          新建会话
        </Button>
      </div>
      {loadingArchived && (
        <p className="flex items-center gap-2 px-2 text-caption text-muted">
          <Spinner size={12} />
          正在加载已归档会话…
        </p>
      )}
      {shown.length === 0 ? (
        <p className="px-2 py-6 text-center text-meta text-muted">没有标题匹配「{query.trim()}」的会话</p>
      ) : (
        <div className="-mx-2 flex flex-col">
          {shown.map((s) => (
            <SessionLine key={s.id} session={s} onOpen={onOpenSession} showPreview />
          ))}
        </div>
      )}
    </div>
  );
}

const KIND_ORDER: OutputKind[] = ["doc", "image", "table", "code", "other"];

function OutputsTab({
  outputs,
  loading,
  error,
  onReload,
  titleById,
  onOpenSession,
}: {
  outputs: ProjectAsset[];
  loading: boolean;
  error: string | null;
  onReload: () => void;
  titleById: Map<string, string>;
  onOpenSession: (id: string) => void;
}) {
  const [kind, setKind] = useState<OutputKind | "all">("all");
  const counts = useMemo(() => {
    const c: Record<OutputKind, number> = { doc: 0, image: 0, table: 0, code: 0, other: 0 };
    for (const a of outputs) c[outputKind(a)] += 1;
    return c;
  }, [outputs]);
  const shown = useMemo(
    () => (kind === "all" ? outputs : outputs.filter((a) => outputKind(a) === kind)),
    [outputs, kind],
  );
  if (error) return <AssetsError error={error} onReload={onReload} />;
  if (loading) {
    return (
      <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-36 w-full" />
        ))}
      </div>
    );
  }
  if (outputs.length === 0) {
    return (
      <EmptyState
        icon={Sparkles}
        title="还没有产出"
        hint="在这个项目的会话里让智能体写文档、做表格或生成图片，产出的文件会自动收在这里。"
      />
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <div
        role="group"
        aria-label="按类型筛选产出"
        className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:px-0"
      >
        <Chip selected={kind === "all"} onClick={() => setKind("all")}>
          全部 {outputs.length}
        </Chip>
        {KIND_ORDER.filter((k) => counts[k] > 0).map((k) => (
          <Chip key={k} selected={kind === k} onClick={() => setKind(k)}>
            {OUTPUT_KIND_LABELS[k]} {counts[k]}
          </Chip>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className="px-2 py-6 text-center text-meta text-muted">没有这类产出</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-3">
          {shown.map((a) => (
            <OutputTile
              key={a.id}
              asset={a}
              sourceTitle={a.sessionId ? titleById.get(a.sessionId) : undefined}
              onOpenSession={onOpenSession}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectSurfaceLinks({
  boardProjectId,
  onPrepareBoard,
  onShowSurface,
}: {
  boardProjectId: string;
  onPrepareBoard: () => Promise<boolean>;
  onShowSurface: (surface: ProjectSurface) => void;
}) {
  const scope = useProjectScope();
  const toast = useToast();
  const [opening, setOpening] = useState<ProjectSurface | null>(null);
  const open = async (surface: ProjectSurface) => {
    setOpening(surface);
    try {
      if (!(await onPrepareBoard())) return;
      // Only switch scope once the refreshed list really has this board; otherwise the
      // token would resolve to 全部项目 and the page would show other projects' data.
      const boards = await scope.refreshWorkProjects();
      if (!boards.some((b) => b.id === boardProjectId)) {
        toast("项目看板暂时没有加载出来，请稍后再试", "error");
        return;
      }
      scope.setToken(boardProjectId);
      onShowSurface(surface);
    } finally {
      setOpening(null);
    }
  };
  return (
    <nav aria-label="项目里的更多" className="flex flex-wrap items-center gap-2" data-testid="project-surface-links">
      <span className="text-caption text-faint">项目里的</span>
      {SURFACES.map((s) => (
        <Chip key={s.id} onClick={() => void open(s.id)} aria-busy={opening === s.id || undefined}>
          {s.label}
        </Chip>
      ))}
    </nav>
  );
}
