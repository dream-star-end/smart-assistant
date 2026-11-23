/**
 * api: chat projects and project assets, uploads and signed media, plans / orders / subscriptions.
 *
 * Boot/first-screen methods stay inline for zero startup latency; non-first-screen
 * project asset / payment / subscription mutations load on demand via `projectsLazyImpl`.
 */
import type {
  AuthSession,
  MediaSignResult,
  ChatProject,
  DeletedChatProject,
  ProjectAsset,
  MySubscription,
} from "../types";
import {
  callWithRefresh,
  AuthEpochStaleError,
  bearerHeaders,
  jsonOrThrow,
} from "./http";
import { createLazyApiDomain } from "./lazyDomain";

type ProjectsLazyImpl = typeof import("./projectsLazyImpl").projectsLazyImpl;

const projectsLazyProxy = createLazyApiDomain<ProjectsLazyImpl>(
  () => import("./projectsLazyImpl").then((m) => m.projectsLazyImpl),
  [
    "listProjectAssets",
    "createProjectAsset",
    "patchProjectAsset",
    "listProjectAssetVersions",
    "restoreProjectAssetVersion",
    "deleteProjectAsset",
    "fetchSignedMedia",
    "listPlans",
    "createHupiOrder",
    "getOrder",
    "listSubscriptionPlans",
    "listOrgPlansPublic",
    "subscribe",
    "upgradeSubscription",
    "buyPack",
  ],
);

export const projectsApi = {
  // ── 聊天项目（侧栏 facade；绑定看板走 boardProjectId）──

  listChatProjects: (a: AuthSession): Promise<ChatProject[]> =>
    jsonOrThrow<{ projects: ChatProject[] }>(
      callWithRefresh(a, (t) =>
        fetch("/api/chat-projects", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => b.projects || []),

  createChatProject: (
    a: AuthSession,
    input: { name: string; instructions?: string; color?: string },
  ): Promise<ChatProject> =>
    jsonOrThrow<{ project: ChatProject }>(
      callWithRefresh(a, (t) =>
        fetch("/api/chat-projects", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(input),
        }),
      ),
    ).then((b) => b.project),

  patchChatProject: (
    a: AuthSession,
    id: string,
    patch: {
      name?: string;
      instructions?: string | null;
      color?: string | null;
      sortOrder?: number;
      boardProjectId?: string | null;
      archived?: boolean;
      pinned?: boolean;
    },
  ): Promise<ChatProject> =>
    jsonOrThrow<{ project: ChatProject }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/chat-projects/${encodeURIComponent(id)}`, {
          method: "PATCH",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(patch),
        }),
      ),
    ).then((b) => b.project),

  /** pausedCronJobIds: jobs the client paused before deleting; kept for a restore. */
  deleteChatProject: (a: AuthSession, id: string, pausedCronJobIds?: string[]): Promise<void> =>
    jsonOrThrow<{ ok: true }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/chat-projects/${encodeURIComponent(id)}`, {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t, pausedCronJobIds !== undefined),
          ...(pausedCronJobIds !== undefined ? { body: JSON.stringify({ pausedCronJobIds }) } : {}),
        }),
      ),
    ).then(() => undefined),

  listDeletedChatProjects: (a: AuthSession): Promise<DeletedChatProject[]> =>
    jsonOrThrow<{ projects: DeletedChatProject[] }>(
      callWithRefresh(a, (t) =>
        fetch("/api/chat-projects?deleted=1", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => b.projects || []),

  restoreChatProject: (
    a: AuthSession,
    id: string,
  ): Promise<{ project: ChatProject; pausedCronJobIds: string[]; relinkedSessionIds: string[] }> =>
    jsonOrThrow<{ project: ChatProject; pausedCronJobIds?: string[]; relinkedSessionIds?: string[] }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/chat-projects/${encodeURIComponent(id)}/restore`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then((b) => ({
      project: b.project,
      pausedCronJobIds: b.pausedCronJobIds ?? [],
      relinkedSessionIds: b.relinkedSessionIds ?? [],
    })),

  /**
   * Ctrl/⌘K: search the caller's files and outputs across all projects (and
   * ungrouped) by name/excerpt, newest first. Server caps `limit` at 50.
   */
  searchProjectAssets: (
    a: AuthSession,
    q: string,
    opts?: { source?: "upload" | "output"; limit?: number; signal?: AbortSignal },
  ): Promise<ProjectAsset[]> => {
    const params = new URLSearchParams();
    params.set("q", q);
    if (opts?.source) params.set("source", opts.source);
    if (opts?.limit) params.set("limit", String(opts.limit));
    return jsonOrThrow<{ assets: ProjectAsset[] }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/project-assets?${params.toString()}`, {
          credentials: "include",
          headers: bearerHeaders(t),
          signal: opts?.signal,
        }),
      ),
    ).then((b) => b.assets || []);
  },

  async uploadFile(
    a: AuthSession,
    file: File,
    opts?: { maxRetries?: number; signal?: AbortSignal; onProgress?: (sent: number, total: number) => void },
  ): Promise<{ url: string; digest?: string; size?: number; mimeType?: string }> {
    // Loading the transport must not let this file cross an account switch.
    const startEpoch = a.snapshot().epoch;
    const { uploadFile } = await import("./uploadClient");
    if (a.snapshot().epoch !== startEpoch) throw new AuthEpochStaleError();
    return uploadFile(a, file, opts);
  },

  /**
   * 批量签名容器内媒体路径（POST /api/media-sign，Bearer + cookie dual-verify）。
   */
  mediaSign: (a: AuthSession, paths: string[]): Promise<MediaSignResult> =>
    jsonOrThrow<MediaSignResult>(
      callWithRefresh(a, (t) =>
        fetch("/api/media-sign", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ paths }),
        }),
      ),
    ),

  /** 当前订阅 + 双钱包余额明细（GET /api/subscription/me，Bearer）。 */
  getMySubscription: (a: AuthSession): Promise<MySubscription> =>
    jsonOrThrow<{
      ok: boolean;
      data: {
        subscription: {
          plan_code: string;
          plan_name: string;
          status: string;
          period_start: string;
          period_end: string;
          period_credits: string;
          monthly_credits: string;
          price_cents: string;
          tier: number;
          paid: boolean;
        };
        balance: { wallet: string; period: string; total: string };
      };
    }>(
      callWithRefresh(a, (t) =>
        fetch("/api/subscription/me", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => ({
      planCode: b.data.subscription.plan_code,
      planName: b.data.subscription.plan_name,
      status: b.data.subscription.status,
      periodStart: b.data.subscription.period_start,
      periodEnd: b.data.subscription.period_end,
      periodCredits: b.data.subscription.period_credits,
      monthlyCredits: b.data.subscription.monthly_credits,
      priceCents: b.data.subscription.price_cents,
      tier: b.data.subscription.tier,
      paid: b.data.subscription.paid,
      balance: {
        wallet: b.data.balance.wallet,
        period: b.data.balance.period,
        total: b.data.balance.total,
      },
    })),

  ...projectsLazyProxy,
};
