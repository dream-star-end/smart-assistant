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
  Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiErrorMessage } from "../../lib/api";
import { type SiteInvitePreview, sitesApi } from "../../lib/sitesApi";
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
  Modal,
  Skeleton,
  useToast,
} from "../ui";
import { SiteDetailView } from "./SiteDetailView";
import { SitePreviewThumb } from "./SitePreviewThumb";
import { sharingLabel } from "./SiteSettingsTab";
import { roleLabel } from "./SiteShareTab";

type SiteFilter = "all" | "shared" | UserSiteVisibility;
type ViewMode = "list" | "grid";

function readSiteInviteParam(): string | null {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("siteInvite")?.trim();
  return raw || null;
}

function clearSiteInviteParam(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has("siteInvite")) return;
  url.searchParams.delete("siteInvite");
  const nextSearch = url.searchParams.toString();
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${nextSearch ? `?${nextSearch}` : ""}${url.hash}`,
  );
}

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
  onApplyLiveEdit,
  onOpenMobileNav,
  sidebarCollapsed,
  onExpandSidebar,
}: {
  auth: AuthSession;
  activeSlug: string | null;
  onSelectSlug: (slug: string | null) => void;
  onCreateInChat: (prompt: string) => void;
  onEditSite: (site: UserSiteItem) => void;
  onApplyLiveEdit?: (site: UserSiteItem, prompt: string) => void;
  onOpenMobileNav?: () => void;
  sidebarCollapsed?: boolean;
  onExpandSidebar?: () => void;
}) {
  const toast = useToast();
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

  const [inviteToken, setInviteToken] = useState<string | null>(() => readSiteInviteParam());
  const [invitePreview, setInvitePreview] = useState<SiteInvitePreview | null>(null);
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteErr, setInviteErr] = useState<string | null>(null);
  const [acceptingInvite, setAcceptingInvite] = useState(false);

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

  useEffect(() => {
    if (!inviteToken) {
      setInvitePreview(null);
      setInviteErr(null);
      return;
    }
    let alive = true;
    setInviteLoading(true);
    setInviteErr(null);
    void sitesApi
      .previewSiteInvite(auth, inviteToken)
      .then((res) => {
        if (!alive) return;
        setInvitePreview(res.invite);
      })
      .catch((e) => {
        if (!alive) return;
        setInviteErr(apiErrorMessage(e, "邀请链接无效或已过期"));
      })
      .finally(() => {
        if (alive) setInviteLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [auth, inviteToken, authIdentityKey]);

  const dismissInvite = useCallback(() => {
    clearSiteInviteParam();
    setInviteToken(null);
    setInvitePreview(null);
    setInviteErr(null);
  }, []);

  const handleAcceptInvite = useCallback(async () => {
    if (!inviteToken || acceptingInvite) return;
    setAcceptingInvite(true);
    setInviteErr(null);
    try {
      const res = await sitesApi.acceptSiteInvite(auth, inviteToken);
      clearSiteInviteParam();
      setInviteToken(null);
      setInvitePreview(null);
      await loadSites();
      toast(
        res.alreadyMember
          ? `你已在站点「${res.site.title}」中（${roleLabel(res.role)}）`
          : `已加入协作站点「${res.site.title}」（${roleLabel(res.role)}）`,
        "success",
      );
      onSelectSlug(res.site.slug);
    } catch (e) {
      setInviteErr(apiErrorMessage(e, "接受协作邀请失败"));
    } finally {
      setAcceptingInvite(false);
    }
  }, [acceptingInvite, auth, inviteToken, loadSites, onSelectSlug, toast]);

  const baseDomain = summary?.baseDomain ?? "congjianai.com";
  const allSites = summary?.sites ?? [];
  const sharedCount = useMemo(
    () => allSites.filter((s) => (s.accessRole ?? "owner") !== "owner").length,
    [allSites],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allSites.filter((site) => {
      if (filter === "shared") {
        if ((site.accessRole ?? "owner") === "owner") return false;
      } else if (filter !== "all" && site.visibility !== filter) {
        return false;
      }
      if (!q) return true;
      return (
        site.title.toLowerCase().includes(q) ||
        site.slug.toLowerCase().includes(q) ||
        (site.customDomain ?? "").toLowerCase().includes(q) ||
        (site.ownerEmail ?? "").toLowerCase().includes(q)
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
          onApplyLiveEdit={onApplyLiveEdit}
          onSiteUpdated={(updated) => handleSiteUpdated(updated, authIdentityKey)}
          onSiteRenamed={(oldSlug, updated) => handleSiteRenamed(oldSlug, updated, authIdentityKey)}
          onSiteDeleted={(deletedSlug) => handleSiteDeleted(deletedSlug, authIdentityKey)}
          onLeftSite={(leftSlug) => handleSiteDeleted(leftSlug, authIdentityKey)}
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
                  {
                    id: "shared",
                    label: sharedCount > 0 ? `共享给我 (${sharedCount})` : "共享给我",
                  },
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
              icon={filter === "shared" ? Users : Globe}
              title={
                filter === "shared"
                  ? "还没有别人共享给你的站点"
                  : allSites.length === 0
                    ? "还没有发布过持久站点"
                    : "没有匹配的站点"
              }
              hint={
                filter === "shared"
                  ? "当其他人在站点的「共享」页签添加你的邮箱或发给你邀请链接后，协作站点会显示在这里。"
                  : allSites.length === 0
                    ? `在对话中让助手构建静态或全栈应用，或运行 oc-site publish，即可持久托管在 *.${baseDomain}。`
                    : "尝试更换搜索关键词或切换筛选条件。"
              }
              action={
                allSites.length === 0 && filter !== "shared" ? (
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
                    {(site.accessRole ?? "owner") !== "owner" && (
                      <p className="truncate text-[11px] font-medium text-sky-700 dark:text-sky-300">
                        共享 · {roleLabel(site.accessRole ?? "editor")}
                        {site.ownerEmail ? ` · ${site.ownerEmail}` : ""}
                      </p>
                    )}
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
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-body font-medium text-fg">{site.title}</p>
                        {(site.accessRole ?? "owner") !== "owner" && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium text-sky-700 dark:text-sky-300">
                            <Users size={11} aria-hidden="true" />
                            共享 · {roleLabel(site.accessRole ?? "editor")}
                          </span>
                        )}
                        {site.customDomain && (
                          <span className="hidden truncate rounded bg-bg-subtle px-1.5 py-0.5 font-mono text-[11px] text-muted sm:inline">
                            {site.customDomain}
                          </span>
                        )}
                      </div>
                      <p className="text-caption text-muted">
                        {formatMonthDay(site.updatedAt)} ·{" "}
                        <span className="font-mono">{site.slug}</span>
                        {(site.accessRole ?? "owner") !== "owner" && site.ownerEmail && (
                          <span> · 来自 {site.ownerEmail}</span>
                        )}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-0.5 text-body text-muted sm:items-start">
                    <span className="flex items-center gap-1.5">
                      <VisibilityIcon visibility={site.visibility} />
                      <span>{sharingLabel(site.visibility)}</span>
                    </span>
                    {(site.accessRole ?? "owner") === "owner" &&
                      (site.collaboratorCount ?? 0) > 0 && (
                        <span className="inline-flex items-center gap-1 text-caption text-faint">
                          <Users size={12} aria-hidden="true" />
                          协作 {site.collaboratorCount} 人
                        </span>
                      )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <Modal
        open={Boolean(inviteToken)}
        onOpenChange={(next) => !next && dismissInvite()}
        title="接受站点协作邀请"
        size="sm"
      >
        <div className="space-y-4">
          {inviteLoading ? (
            <Skeleton className="h-20 w-full rounded-xl" />
          ) : inviteErr ? (
            <Alert tone="danger">{inviteErr}</Alert>
          ) : invitePreview ? (
            <div className="space-y-2 rounded-xl border border-border bg-bg-subtle/60 p-4 text-body">
              <p className="font-semibold text-fg">{invitePreview.site.title}</p>
              <p className="font-mono text-caption text-muted">{invitePreview.site.url}</p>
              <p className="text-caption text-muted">
                邀请人：{invitePreview.ownerDisplayName || invitePreview.ownerEmail || "站点所有者"} ·
                授予角色：<strong className="text-fg">{roleLabel(invitePreview.role)}</strong>
              </p>
              {invitePreview.alreadyRole && (
                <p className="text-caption text-emerald-700 dark:text-emerald-300">
                  你当前已是该站点的「{roleLabel(invitePreview.alreadyRole)}」。
                </p>
              )}
            </div>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={dismissInvite}>
              取消
            </Button>
            {invitePreview && (
              <Button
                variant="primary"
                disabled={acceptingInvite}
                onClick={() => void handleAcceptInvite()}
              >
                {acceptingInvite ? "加入中…" : "加入协作"}
              </Button>
            )}
          </div>
        </div>
      </Modal>
    </div>
  );
}
