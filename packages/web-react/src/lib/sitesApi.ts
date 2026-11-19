import { bearerHeaders, callWithRefresh, jsonOrThrow } from "./api";
import type {
  AuthSession,
  SitesSummaryResponse,
  UserSiteItem,
  UserSiteVisibility,
} from "./types";

export type SiteEnvVarItem = {
  key: string;
  value: string | null;
  isSecret: boolean;
  hasValue: boolean;
  updatedAt: string;
};

export type SiteAnalyticsPoint = {
  date: string;
  uniqueVisitors: number;
  requests: number;
  pageViews: number;
};

export type SiteAnalyticsData = {
  days: number;
  totals: {
    uniqueVisitors: number;
    requests: number;
    pageViews: number;
  };
  series: SiteAnalyticsPoint[];
};

export type SiteDbTableSummary = {
  name: string;
  rowCount: number;
};

export type SiteDbColumnInfo = {
  name: string;
  type: string;
  pk: boolean;
  notnull: boolean;
};

export type SiteDbInspectData = {
  connected: boolean;
  hasDatabaseFile: boolean;
  sizeBytes: number;
  tables: SiteDbTableSummary[];
  selectedTable: string | null;
  columns: SiteDbColumnInfo[];
  rows: Array<Record<string, unknown>>;
  truncated?: boolean;
};

export type SiteDetailResponse = {
  site: UserSiteItem;
  envVars: SiteEnvVarItem[];
};

export const sitesApi = {
  listSites: (a: AuthSession): Promise<SitesSummaryResponse> =>
    jsonOrThrow<SitesSummaryResponse>(
      callWithRefresh(a, (t) =>
        fetch("/api/sites", {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  getSiteDetail: (a: AuthSession, slug: string): Promise<SiteDetailResponse> =>
    jsonOrThrow<SiteDetailResponse>(
      callWithRefresh(a, (t) =>
        fetch(`/api/sites/${encodeURIComponent(slug)}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  updateSite: (
    a: AuthSession,
    slug: string,
    patch: {
      title?: string;
      visibility?: UserSiteVisibility;
      password?: string;
      spaMode?: boolean;
      customDomain?: string | null;
    },
  ): Promise<{ site: UserSiteItem }> =>
    jsonOrThrow<{ site: UserSiteItem }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/sites/${encodeURIComponent(slug)}`, {
          method: "PATCH",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(patch),
        }),
      ),
    ),

  renameSite: (
    a: AuthSession,
    slug: string,
    newSlug: string,
  ): Promise<{ site: UserSiteItem }> =>
    jsonOrThrow<{ site: UserSiteItem }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/sites/${encodeURIComponent(slug)}/rename`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ newSlug }),
        }),
      ),
    ),

  verifyCustomDomain: (a: AuthSession, slug: string): Promise<{ site: UserSiteItem }> =>
    jsonOrThrow<{ site: UserSiteItem }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/sites/${encodeURIComponent(slug)}/verify-domain`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: "{}",
        }),
      ),
    ),

  deleteSite: (a: AuthSession, slug: string): Promise<{ ok: boolean; slug: string }> =>
    jsonOrThrow<{ ok: boolean; slug: string }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/sites/${encodeURIComponent(slug)}`, {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  setSiteEnvVar: (
    a: AuthSession,
    slug: string,
    input: { key: string; value: string; isSecret: boolean },
  ): Promise<{ envVar: SiteEnvVarItem; envVars: SiteEnvVarItem[] }> =>
    jsonOrThrow<{ envVar: SiteEnvVarItem; envVars: SiteEnvVarItem[] }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/sites/${encodeURIComponent(slug)}/env`, {
          method: "PUT",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(input),
        }),
      ),
    ),

  deleteSiteEnvVar: (
    a: AuthSession,
    slug: string,
    key: string,
  ): Promise<{ ok: boolean; envVars: SiteEnvVarItem[] }> =>
    jsonOrThrow<{ ok: boolean; envVars: SiteEnvVarItem[] }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/sites/${encodeURIComponent(slug)}/env/${encodeURIComponent(key)}`, {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  getSiteAnalytics: (
    a: AuthSession,
    slug: string,
    days: 7 | 30 = 30,
  ): Promise<{ analytics: SiteAnalyticsData }> =>
    jsonOrThrow<{ analytics: SiteAnalyticsData }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/sites/${encodeURIComponent(slug)}/analytics?days=${days}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  getSiteDbInspect: (
    a: AuthSession,
    slug: string,
    opts?: { table?: string; limit?: number },
  ): Promise<{ db: SiteDbInspectData }> => {
    const qs = new URLSearchParams();
    if (opts?.table) qs.set("table", opts.table);
    if (opts?.limit) qs.set("limit", String(opts.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return jsonOrThrow<{ db: SiteDbInspectData }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/sites/${encodeURIComponent(slug)}/db${suffix}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    );
  },
};
