import { bearerHeaders, callWithRefresh, jsonOrThrow } from "./api";
import type {
  AuthSession,
  SitesSummaryResponse,
  UserSiteAccessRole,
  UserSiteCollaboratorRole,
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

export type SiteCollaboratorItem = {
  userId: number;
  email: string;
  displayName: string | null;
  role: UserSiteCollaboratorRole;
  createdAt: string;
  updatedAt: string;
};

export type SiteInviteItem = {
  id: string;
  role: UserSiteCollaboratorRole;
  maxUses: number | null;
  useCount: number;
  expiresAt: string | null;
  createdAt: string;
};

export type SiteSharingResponse = {
  site: UserSiteItem;
  collaborators: SiteCollaboratorItem[];
  invites: SiteInviteItem[];
};

export type SiteInvitePreview = {
  valid: boolean;
  site: {
    id: string;
    slug: string;
    title: string;
    url: string;
  };
  role: UserSiteCollaboratorRole;
  ownerEmail: string | null;
  ownerDisplayName: string | null;
  expiresAt: string | null;
  alreadyRole: UserSiteAccessRole | null;
};

export type SitePreviewSession = {
  bootstrapUrl: string;
  siteOrigin: string;
  siteUrl: string;
  expiresAt: string;
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

  getSiteSharing: (a: AuthSession, slug: string): Promise<SiteSharingResponse> =>
    jsonOrThrow<SiteSharingResponse>(
      callWithRefresh(a, (t) =>
        fetch(`/api/sites/${encodeURIComponent(slug)}/sharing`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  addSiteCollaborator: (
    a: AuthSession,
    slug: string,
    input: { email: string; role: UserSiteCollaboratorRole },
  ): Promise<{ collaborator: SiteCollaboratorItem; collaborators: SiteCollaboratorItem[] }> =>
    jsonOrThrow<{ collaborator: SiteCollaboratorItem; collaborators: SiteCollaboratorItem[] }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/sites/${encodeURIComponent(slug)}/collaborators`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(input),
        }),
      ),
    ),

  updateSiteCollaborator: (
    a: AuthSession,
    slug: string,
    targetUserId: number,
    role: UserSiteCollaboratorRole,
  ): Promise<{ collaborator: SiteCollaboratorItem; collaborators: SiteCollaboratorItem[] }> =>
    jsonOrThrow<{ collaborator: SiteCollaboratorItem; collaborators: SiteCollaboratorItem[] }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/sites/${encodeURIComponent(slug)}/collaborators/${targetUserId}`, {
          method: "PATCH",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ role }),
        }),
      ),
    ),

  removeSiteCollaborator: (
    a: AuthSession,
    slug: string,
    targetUserId: number,
  ): Promise<{ ok: boolean; collaborators: SiteCollaboratorItem[] }> =>
    jsonOrThrow<{ ok: boolean; collaborators: SiteCollaboratorItem[] }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/sites/${encodeURIComponent(slug)}/collaborators/${targetUserId}`, {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  leaveSite: (a: AuthSession, slug: string): Promise<{ ok: boolean; slug: string }> =>
    jsonOrThrow<{ ok: boolean; slug: string }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/sites/${encodeURIComponent(slug)}/leave`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: "{}",
        }),
      ),
    ),

  createSiteInvite: (
    a: AuthSession,
    slug: string,
    input: {
      role: UserSiteCollaboratorRole;
      expiresInHours: number | null;
      maxUses: number | null;
    },
  ): Promise<{ invite: SiteInviteItem; token: string; invites: SiteInviteItem[] }> =>
    jsonOrThrow<{ invite: SiteInviteItem; token: string; invites: SiteInviteItem[] }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/sites/${encodeURIComponent(slug)}/invites`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(input),
        }),
      ),
    ),

  revokeSiteInvite: (
    a: AuthSession,
    slug: string,
    inviteId: string,
  ): Promise<{ ok: boolean; invites: SiteInviteItem[] }> =>
    jsonOrThrow<{ ok: boolean; invites: SiteInviteItem[] }>(
      callWithRefresh(a, (t) =>
        fetch(
          `/api/sites/${encodeURIComponent(slug)}/invites/${encodeURIComponent(inviteId)}`,
          {
            method: "DELETE",
            credentials: "include",
            headers: bearerHeaders(t),
          },
        ),
      ),
    ),

  previewSiteInvite: (a: AuthSession, token: string): Promise<{ invite: SiteInvitePreview }> =>
    jsonOrThrow<{ invite: SiteInvitePreview }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/site-invites/${encodeURIComponent(token)}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  acceptSiteInvite: (
    a: AuthSession,
    token: string,
  ): Promise<{ site: UserSiteItem; role: UserSiteAccessRole; alreadyMember: boolean }> =>
    jsonOrThrow<{ site: UserSiteItem; role: UserSiteAccessRole; alreadyMember: boolean }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/site-invites/${encodeURIComponent(token)}/accept`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: "{}",
        }),
      ),
    ),

  createSitePreviewSession: (
    a: AuthSession,
    slug: string,
  ): Promise<{ preview: SitePreviewSession }> =>
    jsonOrThrow<{ preview: SitePreviewSession }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/sites/${encodeURIComponent(slug)}/preview-session`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: "{}",
        }),
      ),
    ),
};
