import {
  ArrowLeft,
  ExternalLink,
  Globe,
  Lock,
  Monitor,
  PauseCircle,
  Pencil,
  Users,
} from "lucide-react";
import { useEffect, useState } from "react";
import { apiErrorMessage } from "../../lib/api";
import { type SiteEnvVarItem, sitesApi } from "../../lib/sitesApi";
import type { AuthSession, UserSiteItem } from "../../lib/types";
import { cn } from "../../lib/utils";
import { Alert, Button, Skeleton } from "../ui";
import { SiteAnalyticsTab } from "./SiteAnalyticsTab";
import { SiteDatabaseTab } from "./SiteDatabaseTab";
import { SiteLiveEditModal } from "./SiteLiveEditModal";
import { SitePreviewThumb } from "./SitePreviewThumb";
import { SiteSettingsTab } from "./SiteSettingsTab";
import { SiteShareTab, roleLabel } from "./SiteShareTab";

export type SiteDetailTab = "settings" | "share" | "analytics" | "database";

export function SiteDetailView({
  auth,
  slug,
  initialSite,
  baseDomain,
  onBack,
  onEditSite,
  onApplyLiveEdit,
  onSiteUpdated,
  onSiteRenamed,
  onSiteDeleted,
  onLeftSite,
}: {
  auth: AuthSession;
  slug: string;
  initialSite: UserSiteItem | null;
  baseDomain: string;
  onBack: () => void;
  onEditSite: (site: UserSiteItem) => void;
  onApplyLiveEdit?: (site: UserSiteItem, prompt: string) => void;
  onSiteUpdated: (site: UserSiteItem) => void;
  onSiteRenamed: (oldSlug: string, updated: UserSiteItem) => void;
  onSiteDeleted: (slug: string) => void;
  onLeftSite?: (slug: string) => void;
}) {
  const [tab, setTab] = useState<SiteDetailTab>("settings");
  const [site, setSite] = useState<UserSiteItem | null>(initialSite);
  const [envVars, setEnvVars] = useState<SiteEnvVarItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [liveEditOpen, setLiveEditOpen] = useState(false);

  useEffect(() => {
    setLiveEditOpen(false);
    if (initialSite && initialSite.slug === slug) {
      setSite((cur) => cur ?? initialSite);
    } else {
      setSite((cur) => (cur && cur.slug === slug ? cur : null));
    }
  }, [initialSite, slug]);

  useEffect(() => {
    let alive = true;
    const reqSlug = slug;
    setLoading(true);
    setErr(null);
    sitesApi
      .getSiteDetail(auth, reqSlug)
      .then((res) => {
        if (!alive || res.site.slug !== reqSlug) return;
        setSite(res.site);
        setEnvVars(res.envVars);
      })
      .catch((e) => {
        if (!alive) return;
        setErr(apiErrorMessage(e, "加载站点详情失败"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [auth, slug]);

  const verifiedCustomDomain =
    site?.customDomain && site.customDomainStatus === "verified" ? site.customDomain : null;
  const activeHost = site ? verifiedCustomDomain || `${site.slug}.${baseDomain}` : `${slug}.${baseDomain}`;
  const visitHref = verifiedCustomDomain
    ? `https://${verifiedCustomDomain}`
    : (site?.url ?? `https://${slug}.${baseDomain}`);
  const detailReady = Boolean(site && site.slug === slug);
  const mutationsDisabled = !detailReady || loading;
  const accessRole = site?.accessRole ?? "owner";
  const canEdit = accessRole === "owner" || accessRole === "editor";

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6 sm:px-8 sm:py-8">
      <div className="oc-surface-glass sticky top-3 z-10 flex flex-wrap items-center justify-between gap-3 rounded-2xl px-3.5 py-2.5">
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="gap-1.5 text-muted hover:text-fg"
        >
          <ArrowLeft size={15} aria-hidden="true" />
          站点
        </Button>

        {site && (
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={visitHref}
              target="_blank"
              rel="noopener noreferrer"
              className="oc-btn-secondary-craft oc-btn-tactile inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-body font-medium text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ExternalLink size={14} aria-hidden="true" />
              访问
            </a>
            {canEdit && (
              <>
                <Button
                  variant="primary"
                  size="sm"
                  className="rounded-full"
                  disabled={!detailReady}
                  onClick={() => setLiveEditOpen(true)}
                >
                  <Monitor size={14} aria-hidden="true" />
                  实时编辑
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  className="rounded-full"
                  onClick={() => onEditSite(site)}
                >
                  <Pencil size={14} aria-hidden="true" />
                  编辑
                </Button>
              </>
            )}
          </div>
        )}
      </div>

      {err ? (
        <Alert tone="danger">
          <div className="flex items-center justify-between gap-3">
            <span>{err}</span>
            <Button size="sm" variant="secondary" onClick={onBack}>
              返回列表
            </Button>
          </div>
        </Alert>
      ) : !site && loading ? (
        <div className="space-y-4">
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      ) : site ? (
        <>
          <div className="oc-surface-card flex flex-col gap-4 rounded-2xl p-5 sm:flex-row sm:items-center sm:gap-5">
            <div className="w-32 shrink-0 sm:w-40">
              <SitePreviewThumb site={site} baseDomain={baseDomain} />
            </div>
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-2xl font-semibold tracking-tight text-fg sm:text-3xl">
                  {site.title}
                </h1>
                {site.hasServerApi && (
                  <span className="oc-badge-craft rounded-full bg-accent-soft px-2.5 py-0.5 text-caption font-medium text-accent">
                    全栈 API
                  </span>
                )}
                {accessRole !== "owner" && (
                  <span className="oc-badge-craft inline-flex items-center gap-1 rounded-full bg-info-soft px-2.5 py-0.5 text-caption font-medium text-info">
                    <Users size={12} aria-hidden="true" />
                    共享 · {roleLabel(accessRole)}
                  </span>
                )}
              </div>
              <p className="flex flex-wrap items-center gap-2 text-body text-muted">
                <span className="oc-surface-recessed inline-flex max-w-full items-center gap-1.5 rounded-full px-3 py-1 font-mono text-meta text-fg">
                  {site.visibility === "public" ? (
                    <Globe size={13} className="shrink-0 text-success" aria-hidden="true" />
                  ) : site.visibility === "password" ? (
                    <Lock size={13} className="shrink-0 text-warning" aria-hidden="true" />
                  ) : (
                    <PauseCircle size={13} className="shrink-0 text-faint" aria-hidden="true" />
                  )}
                  <span className="truncate">{activeHost}</span>
                </span>
                {accessRole !== "owner" && site.ownerEmail && (
                  <span className="text-caption text-faint">· 所有者 {site.ownerEmail}</span>
                )}
              </p>
            </div>
          </div>

          <div
            role="tablist"
            aria-label="站点详情标签页"
            className="oc-surface-recessed inline-flex w-fit flex-wrap items-center gap-1 rounded-full p-1"
          >
            {(
              [
                { id: "settings", label: "设置" },
                { id: "share", label: "共享" },
                { id: "analytics", label: "分析" },
                { id: "database", label: "数据库" },
              ] as const
            ).map((item) => {
              const selected = tab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => setTab(item.id)}
                  className={cn(
                    "oc-btn-tactile rounded-full px-4 py-1.5 text-body transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    selected
                      ? "oc-segmented-thumb font-medium text-fg"
                      : "text-muted hover:text-fg",
                  )}
                >
                  {item.label}
                </button>
              );
            })}
          </div>

          {tab === "settings" && (
            <SiteSettingsTab
              auth={auth}
              site={site}
              baseDomain={baseDomain}
              envVars={envVars}
              readOnly={mutationsDisabled}
              onSiteUpdated={(updated) => {
                if (updated.slug !== slug) return;
                setSite(updated);
                onSiteUpdated(updated);
              }}
              onSiteRenamed={(oldSlug, updated) => {
                if (oldSlug !== slug) return;
                setSite(updated);
                onSiteRenamed(oldSlug, updated);
              }}
              onEnvVarsChange={setEnvVars}
              onSiteDeleted={onSiteDeleted}
            />
          )}
          {tab === "share" && (
            <SiteShareTab
              auth={auth}
              site={site}
              readOnly={mutationsDisabled}
              onCollaboratorCountChange={(count) => {
                if (!site || site.collaboratorCount === count) return;
                const next = { ...site, collaboratorCount: count };
                setSite(next);
                onSiteUpdated(next);
              }}
              onLeftSite={(leftSlug) => {
                onLeftSite?.(leftSlug);
              }}
            />
          )}
          {tab === "analytics" && <SiteAnalyticsTab auth={auth} slug={site.slug} />}
          {tab === "database" && <SiteDatabaseTab auth={auth} slug={site.slug} />}

          {liveEditOpen && canEdit && (
            <SiteLiveEditModal
              open
              site={site}
              auth={auth}
              onClose={() => setLiveEditOpen(false)}
              onApplyPrompt={(prompt) => {
                setLiveEditOpen(false);
                if (onApplyLiveEdit) {
                  onApplyLiveEdit(site, prompt);
                } else {
                  onEditSite(site);
                }
              }}
            />
          )}
        </>
      ) : null}
    </div>
  );
}
