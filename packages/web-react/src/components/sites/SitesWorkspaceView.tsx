import {
  ChevronDown,
  Globe,
  LayoutGrid,
  List,
  Lock,
  Menu,
  PanelLeftOpen,
  PauseCircle,
  Search,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiErrorMessage } from "../../lib/api";
import { sitesApi } from "../../lib/sitesApi";
import type { AuthSession, SitesSummaryResponse, UserSiteItem, UserSiteVisibility } from "../../lib/types";
import { cn } from "../../lib/utils";
import {
  Alert,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  IconButton,
  Skeleton,
} from "../ui";
import { SiteDetailView } from "./SiteDetailView";
import { SitePreviewThumb } from "./SitePreviewThumb";
import { sharingLabel } from "./SiteSettingsTab";

type SiteFilter = "all" | UserSiteVisibility;
type ViewMode = "list" | "grid";

function formatMonthDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function VisibilityIcon({ visibility }: { visibility: UserSiteVisibility }) {
  if (visibility === "public") return <Globe size={14} className="text-muted" aria-hidden="true" />;
  if (visibility === "password") return <Lock size={14} className="text-muted" aria-hidden="true" />;
  return <PauseCircle size={14} className="text-muted" aria-hidden="true" />;
}

export function SitesWorkspaceView({
  auth,
  activeSlug,
  onSelectSlug,
  onCreateInChat,
  onEditSite,
  onOpenMobileNav,
  sidebarCollapsed,
  onExpandSidebar,
}: {
  auth: AuthSession;
  activeSlug: string | null;
  onSelectSlug: (slug: string | null) => void;
  onCreateInChat: (prompt: string) => void;
  onEditSite: (site: UserSiteItem) => void;
  onOpenMobileNav?: () => void;
  sidebarCollapsed?: boolean;
  onExpandSidebar?: () => void;
}) {
  const [accessGen, setAccessGen] = useState(() => auth.getAccessGeneration());
  useEffect(() => auth.subscribeAccessGeneration(() => setAccessGen(auth.getAccessGeneration())), [auth]);
  const authIdentityKey = `${accessGen}:${auth.snapshot().epoch}`;

  const authIdentityRef = useRef(authIdentityKey);
  authIdentityRef.current = authIdentityKey;
  const activeSlugRef = useRef(activeSlug);
  activeSlugRef.current = activeSlug;

  const [summary, setSummary] = useState<SitesSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SiteFilter>("all");
  const [viewMode, setViewMode] = useState<ViewMode>("list");

  const loadSites = useCallback(async () => {
    const reqIdentity = authIdentityRef.current;
    setLoading(true);
    setErr(null);
    try {
      const res = await sitesApi.listSites(auth);
      if (authIdentityRef.current !== reqIdentity) return;
      setSummary(res);
    } catch (e) {
      if (authIdentityRef.current !== reqIdentity) return;
      setErr(apiErrorMessage(e, "加载站点列表失败"));
    } finally {
      if (authIdentityRef.current === reqIdentity) {
        setLoading(false);
      }
    }
  }, [auth]);

  useEffect(() => {
    setSummary(null);
    void loadSites();
  }, [loadSites, authIdentityKey]);

  const baseDomain = summary?.baseDomain ?? "congjianai.com";
  const allSites = summary?.sites ?? [];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allSites.filter((site) => {
      if (filter !== "all" && site.visibility !== filter) return false;
      if (!q) return true;
      return (
        site.title.toLowerCase().includes(q) ||
        site.slug.toLowerCase().includes(q) ||
        (site.customDomain ?? "").toLowerCase().includes(q)
      );
    });
  }, [allSites, filter, query]);

  const activeInitialSite = useMemo(
    () => (activeSlug ? (allSites.find((s) => s.slug === activeSlug) ?? null) : null),
    [allSites, activeSlug],
  );

  const handleSiteUpdated = useCallback((updated: UserSiteItem, originIdentity: string) => {
    if (authIdentityRef.current !== originIdentity) return;
    setSummary((cur) =>
      cur
        ? { ...cur, sites: cur.sites.map((s) => (s.id === updated.id ? updated : s)) }
        : cur,
    );
  }, []);

  const handleSiteRenamed = useCallback(
    (oldSlug: string, updated: UserSiteItem, originIdentity: string) => {
      if (authIdentityRef.current !== originIdentity) return;
      setSummary((cur) =>
        cur
          ? {
              ...cur,
              sites: cur.sites.map((s) => (s.slug === oldSlug || s.id === updated.id ? updated : s)),
            }
          : cur,
      );
      if (activeSlugRef.current === oldSlug) {
        onSelectSlug(updated.slug);
      }
    },
    [onSelectSlug],
  );

  const handleSiteDeleted = useCallback(
    (deletedSlug: string, originIdentity: string) => {
      if (authIdentityRef.current !== originIdentity) return;
      setSummary((cur) =>
        cur ? { ...cur, sites: cur.sites.filter((s) => s.slug !== deletedSlug) } : cur,
      );
      if (activeSlugRef.current === deletedSlug) {
        onSelectSlug(null);
      }
    },
    [onSelectSlug],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-bg">
      {(onOpenMobileNav || (sidebarCollapsed && onExpandSidebar)) && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-4 py-2 md:hidden">
          {onOpenMobileNav && (
            <IconButton
              variant="ghost"
              size="sm"
              aria-label="打开导航"
              onClick={onOpenMobileNav}
            >
              <Menu size={18} />
            </IconButton>
          )}
          <span className="text-section font-semibold text-fg">站点</span>
        </div>
      )}

      {sidebarCollapsed && onExpandSidebar && (
        <div className="hidden items-center px-4 pt-3 md:flex">
          <IconButton
            variant="ghost"
            size="sm"
            aria-label="展开侧栏"
            onClick={onExpandSidebar}
          >
            <PanelLeftOpen size={17} />
          </IconButton>
        </div>
      )}

      {activeSlug ? (
        <SiteDetailView
          key={`${authIdentityKey}:${activeSlug}`}
          auth={auth}
          slug={activeSlug}
          initialSite={activeInitialSite}
          baseDomain={baseDomain}
          onBack={() => onSelectSlug(null)}
          onEditSite={onEditSite}
          onSiteUpdated={(updated) => handleSiteUpdated(updated, authIdentityKey)}
          onSiteRenamed={(oldSlug, updated) => handleSiteRenamed(oldSlug, updated, authIdentityKey)}
          onSiteDeleted={(deletedSlug) => handleSiteDeleted(deletedSlug, authIdentityKey)}
        />
      ) : (
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6 sm:px-8 sm:py-8">
          <h1 className="text-2xl font-semibold text-fg sm:text-[28px]">站点</h1>

          <div className="flex flex-wrap items-center gap-3">
            <label className="relative min-w-[200px] flex-1">
              <Search
                size={15}
                className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-faint"
                aria-hidden="true"
              />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索站点"
                aria-label="搜索站点"
                className="h-10 w-full rounded-full border border-border bg-surface pl-9 pr-4 text-body text-fg placeholder:text-faint outline-none transition-colors focus:border-accent"
              />
            </label>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full bg-fg px-4 text-body font-medium text-bg transition-opacity hover:opacity-90 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  创建
                  <ChevronDown size={14} aria-hidden="true" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuItem
                  onSelect={() =>
                    onCreateInChat(
                      "请帮我创建一个现代化网站，构建静态资源后使用 `oc-site publish` 发布到持久域名。",
                    )
                  }
                >
                  用 AI 创建静态 / 展示站点
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() =>
                    onCreateInChat(
                      "请帮我创建一个全栈 Web 应用，包含前端页面和 `/api/*` 后端接口（使用内置 SQLite `ctx.db` 与安全环境变量 `ctx.env`），并使用 `oc-site publish --api` 发布上线。",
                    )
                  }
                >
                  创建带内置数据库的全栈站点
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() =>
                    onCreateInChat(
                      "请查看当前工作区的前端项目，构建后发布到持久子域名，并帮我配置好 SPA 路由。",
                    )
                  }
                >
                  发布当前工作区项目
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-1.5">
              {(
                [
                  { id: "all", label: "全部" },
                  { id: "public", label: "公开" },
                  { id: "password", label: "口令保护" },
                  { id: "disabled", label: "已下线" },
                ] as const
              ).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setFilter(item.id)}
                  className={cn(
                    "rounded-full px-3.5 py-1.5 text-body transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    filter === item.id
                      ? "bg-hover font-medium text-fg"
                      : "text-muted hover:bg-hover/60 hover:text-fg",
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <div className="inline-flex items-center gap-1 rounded-full bg-bg-subtle p-1">
              <IconButton
                variant={viewMode === "grid" ? "subtle" : "ghost"}
                size="sm"
                shape="round"
                aria-label="网格视图"
                aria-pressed={viewMode === "grid"}
                onClick={() => setViewMode("grid")}
              >
                <LayoutGrid size={15} />
              </IconButton>
              <IconButton
                variant={viewMode === "list" ? "subtle" : "ghost"}
                size="sm"
                shape="round"
                aria-label="列表视图"
                aria-pressed={viewMode === "list"}
                onClick={() => setViewMode("list")}
              >
                <List size={15} />
              </IconButton>
            </div>
          </div>

          {err && (
            <Alert tone="danger">
              <div className="flex items-center justify-between gap-3">
                <span>{err}</span>
                <Button size="sm" variant="secondary" onClick={() => void loadSites()}>
                  重试
                </Button>
              </div>
            </Alert>
          )}

          {summary && !summary.enabled ? (
            <EmptyState
              icon={Globe}
              title="持久化站点托管尚未开启"
              hint="请联系管理员配置站点边缘节点后即可一键将作品发布到独立公网域名。"
            />
          ) : loading && !summary ? (
            <div className="space-y-3">
              <Skeleton className="h-20 w-full rounded-xl" />
              <Skeleton className="h-20 w-full rounded-xl" />
              <Skeleton className="h-20 w-full rounded-xl" />
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={Globe}
              title={allSites.length === 0 ? "还没有发布过持久站点" : "没有匹配的站点"}
              hint={
                allSites.length === 0
                  ? `在对话中让助手构建静态或全栈应用，或运行 oc-site publish，即可持久托管在 *.${baseDomain}。`
                  : "尝试更换搜索关键词或切换筛选条件。"
              }
              action={
                allSites.length === 0 ? (
                  <Button
                    variant="primary"
                    onClick={() =>
                      onCreateInChat(
                        "帮我创建一个现代化的个人展示网页，完成后用 oc-site 发布上线。",
                      )
                    }
                  >
                    用 AI 创建第一个站点
                  </Button>
                ) : undefined
              }
            />
          ) : viewMode === "grid" ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map((site) => (
                <button
                  key={site.id}
                  type="button"
                  onClick={() => onSelectSlug(site.slug)}
                  className="group flex flex-col overflow-hidden rounded-xl border border-border bg-surface text-left transition-colors hover:border-border-strong hover:bg-hover/30 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <SitePreviewThumb
                    site={site}
                    baseDomain={baseDomain}
                    className="rounded-none border-0 border-b border-border/60"
                  />
                  <div className="space-y-1 p-3.5">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-body font-medium text-fg">{site.title}</p>
                      <VisibilityIcon visibility={site.visibility} />
                    </div>
                    <p className="truncate font-mono text-caption text-muted">
                      {site.customDomain || `${site.slug}.${baseDomain}`}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="divide-y divide-border/70">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 px-1 pb-2.5 text-caption text-muted sm:grid-cols-[minmax(0,1fr)_180px]">
                <span>站点</span>
                <span>共享对象</span>
              </div>
              {filtered.map((site) => (
                <button
                  key={site.id}
                  type="button"
                  onClick={() => onSelectSlug(site.slug)}
                  className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-1 py-3.5 text-left transition-colors hover:bg-hover/40 outline-none focus-visible:ring-2 focus-visible:ring-ring sm:grid-cols-[minmax(0,1fr)_180px]"
                >
                  <div className="flex min-w-0 items-center gap-3.5">
                    <div className="w-20 shrink-0 sm:w-24">
                      <SitePreviewThumb site={site} baseDomain={baseDomain} />
                    </div>
                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-body font-medium text-fg">{site.title}</p>
                        {site.customDomain && (
                          <span className="hidden truncate rounded bg-bg-subtle px-1.5 py-0.5 font-mono text-[11px] text-muted sm:inline">
                            {site.customDomain}
                          </span>
                        )}
                      </div>
                      <p className="text-caption text-muted">
                        {formatMonthDay(site.updatedAt)} ·{" "}
                        <span className="font-mono">{site.slug}</span>
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 text-body text-muted">
                    <VisibilityIcon visibility={site.visibility} />
                    <span>{sharingLabel(site.visibility)}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
