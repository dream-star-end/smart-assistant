import type {
  AdminBlogPost,
  AuthSession,
  BlogModerationRecord,
  BlogModerationStats,
  CommunityTutorialPage,
  CommunityTutorialPending,
  MarketplaceAiReview,
  MarketplacePending,
  MarketplaceReviewBatchResult,
  TutorialEvalCompassItem,
  TutorialEvalJob,
  TutorialEvalRecordInput,
  TutorialEvalSpec,
  TutorialEvalSpecDraft,
} from "../types";
import { bearerHeaders, callWithRefresh, jsonOrThrow } from "../api";

/**
 * admin 域 API(所有 `/api/admin/*` 路径)—— 从 api.ts 按域拆出的第一刀。
 *
 * why:api.ts 整体在用户端首屏静态依赖闭包里(曾经一个 46KB gzip 块就是它),而
 * admin 专属路径(社区教程审核 / 教程评测 / 市场审核)普通用户一个都不会调。
 * 拆出后由调用方静态 import(管理后台 admin.html 入口)或经 api.ts 上的同名
 * 惰性代理(`(...a) => import("./api/admin").then(...)`,市场审核面板等用户端
 * 组件走这条路)按需加载,不再占首屏体积。
 *
 * 基础设施(callWithRefresh / bearerHeaders / jsonOrThrow / ApiError)仍留在
 * api.ts,这里只引用不复制;后续再拆其他域时同理。
 */
export const adminApi = {
  // ── 社区教程审核（admin/tutorials；后端 requireAdminVerifyDb 二次把关） ──────

  adminPendingCommunityTutorials: (a: AuthSession, cursor?: string | null) =>
    jsonOrThrow<CommunityTutorialPage<CommunityTutorialPending>>(
      callWithRefresh(a, (token) =>
        fetch(`/api/admin/tutorials/pending${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, {
          credentials: "include",
          headers: bearerHeaders(token),
        }),
      ),
    ),

  adminReviewCommunityTutorial: (
    a: AuthSession,
    id: string,
    decision: "approve" | "reject",
    note?: string,
    /** 列表给的 reviewToken；作者中途改过服务端返回 409，避免审到旧内容。 */
    reviewToken?: string,
  ) =>
    jsonOrThrow<{ ok: boolean }>(
      callWithRefresh(a, (token) =>
        fetch(`/api/admin/tutorials/${encodeURIComponent(id)}/review`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(token, true),
          body: JSON.stringify({ decision, note, reviewToken }),
        }),
      ),
    ),

  // ── 经验分享（OCV5-577；markdown 投稿的按状态列表 / AI 审核 / 下架） ──────────

  adminListBlogPosts: (
    a: AuthSession,
    opts: { status: "pending" | "approved" | "rejected" | "takedown" | "withdrawn"; needsHuman?: boolean; cursor?: string | null },
  ) => {
    const qs = new URLSearchParams({ status: opts.status, kind: "markdown" });
    if (opts.needsHuman) qs.set("needsHuman", "1");
    if (opts.cursor) qs.set("cursor", opts.cursor);
    return jsonOrThrow<CommunityTutorialPage<AdminBlogPost>>(
      callWithRefresh(a, (token) =>
        fetch(`/api/admin/tutorials?${qs.toString()}`, {
          credentials: "include",
          headers: bearerHeaders(token),
        }),
      ),
    );
  },

  adminTakedownCommunityTutorial: (a: AuthSession, id: string, note: string) =>
    jsonOrThrow<{ ok: boolean }>(
      callWithRefresh(a, (token) =>
        fetch(`/api/admin/tutorials/${encodeURIComponent(id)}/takedown`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(token, true),
          body: JSON.stringify({ note }),
        }),
      ),
    ),

  /** PR-B 才有；旧后端 404 时调用方隐藏 AI 部分。 */
  adminBlogModerationStats: (a: AuthSession) =>
    jsonOrThrow<BlogModerationStats>(
      callWithRefresh(a, (token) =>
        fetch("/api/admin/tutorials/moderation-stats", {
          credentials: "include",
          headers: bearerHeaders(token),
        }),
      ),
    ),

  adminBlogModerations: (a: AuthSession, cursor?: string | null) =>
    jsonOrThrow<{ moderations: BlogModerationRecord[]; nextCursor: string | null }>(
      callWithRefresh(a, (token) =>
        fetch(
          `/api/admin/tutorials/moderations${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
          { credentials: "include", headers: bearerHeaders(token) },
        ),
      ),
    ),

  // ── 教程案例评测（admin/tutorials/case-specs · eval-jobs · compass） ────────

  listTutorialEvalSpecs: (a: AuthSession, cursor?: string | null) =>
    jsonOrThrow<{ specs: TutorialEvalSpec[]; nextCursor?: string | null }>(
      callWithRefresh(a, (token) =>
        fetch(
          `/api/admin/tutorials/case-specs${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
          { credentials: "include", headers: bearerHeaders(token) },
        ),
      ),
    ),

  createTutorialEvalSpec: (a: AuthSession, draft: TutorialEvalSpecDraft) =>
    jsonOrThrow<{ spec: TutorialEvalSpec }>(
      callWithRefresh(a, (token) =>
        fetch("/api/admin/tutorials/case-specs", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(token, true),
          body: JSON.stringify(draft),
        }),
      ),
    ).then((result) => result.spec),

  listTutorialEvalJobs: (a: AuthSession, cursor?: string | null) =>
    jsonOrThrow<{ jobs: TutorialEvalJob[]; nextCursor?: string | null }>(
      callWithRefresh(a, (token) =>
        fetch(
          `/api/admin/tutorials/eval-jobs${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
          { credentials: "include", headers: bearerHeaders(token) },
        ),
      ),
    ),

  enqueueTutorialEvalJob: (
    a: AuthSession,
    specId: string,
    extra?: { idempotencyKey?: string; publicationId?: string | null; evalUserId?: string | null },
  ) =>
    jsonOrThrow<{ job: TutorialEvalJob }>(
      callWithRefresh(a, (token) =>
        fetch("/api/admin/tutorials/eval-jobs", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(token, true),
          body: JSON.stringify({
            specId,
            idempotencyKey: extra?.idempotencyKey ?? `eval-${specId}-${Date.now()}`,
            publicationId: extra?.publicationId,
            evalUserId: extra?.evalUserId,
          }),
        }),
      ),
    ).then((result) => result.job),

  listTutorialEvalCompass: (a: AuthSession, cursor?: string | null) =>
    jsonOrThrow<{ items?: TutorialEvalCompassItem[]; notes?: TutorialEvalCompassItem[]; nextCursor?: string | null }>(
      callWithRefresh(a, (token) =>
        fetch(
          `/api/admin/tutorials/compass${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
          { credentials: "include", headers: bearerHeaders(token) },
        ),
      ),
    ).then((result) => ({
      items: result.items ?? result.notes ?? [],
      nextCursor: result.nextCursor ?? null,
    })),

  recordTutorialEvalResult: (a: AuthSession, input: TutorialEvalRecordInput) =>
    jsonOrThrow<{ ok?: boolean; job?: TutorialEvalJob }>(
      callWithRefresh(a, (token) =>
        fetch(`/api/admin/tutorials/eval-jobs/${encodeURIComponent(input.jobId)}/evidence`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(token, true),
          body: JSON.stringify({
            result: input.result ?? (input.status === "failed" ? "failed" : "passed"),
            evidence: input.evidence ?? { notes: input.notes, summary: input.summary },
          }),
        }),
      ),
    ),

  // ── 管理员市场审核（admin/marketplace；后端 requireAdminVerifyDb 二次把关） ──

  /** 待审版本列表（GET /api/admin/marketplace/pending）。 */
  adminMarketplacePending: (a: AuthSession) =>
    jsonOrThrow<{ pending: MarketplacePending[] }>(
      callWithRefresh(a, (t) =>
        fetch("/api/admin/marketplace/pending", {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then((b) => b.pending || []),

  /** AI 自动审批记录（GET /api/admin/marketplace/ai-reviews；review_source='ai'）。 */
  adminMarketplaceAiReviews: (a: AuthSession) =>
    jsonOrThrow<{ reviews: MarketplaceAiReview[] }>(
      callWithRefresh(a, (t) =>
        fetch("/api/admin/marketplace/ai-reviews", {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then((b) => b.reviews || []),

  /** 审核(批准/拒绝)一个版本（POST /api/admin/marketplace/:id/review）。 */
  adminMarketplaceReview: (
    a: AuthSession,
    versionId: string,
    decision: "approve" | "reject",
    note?: string,
    connectorReview?: {
      securityDecision: Record<string, unknown>;
      expectedSpecHash: string;
      functionalVerified: true;
    },
  ) =>
    jsonOrThrow<{ ok: boolean }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/admin/marketplace/${encodeURIComponent(versionId)}/review`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ decision, note, ...(connectorReview ?? {}) }),
        }),
      ),
    ),

  /** 批量审核(批准/拒绝)多个待审版本（POST /api/admin/marketplace/review-batch）。 */
  adminMarketplaceReviewBatch: (
    a: AuthSession,
    versionIds: string[],
    decision: "approve" | "reject",
    note?: string,
  ) =>
    jsonOrThrow<MarketplaceReviewBatchResult>(
      callWithRefresh(a, (t) =>
        fetch("/api/admin/marketplace/review-batch", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ versionIds, decision, note }),
        }),
      ),
    ),

  /** 下架(kill-switch)一个条目（POST /api/admin/marketplace/:slug/revoke）。 */
  adminMarketplaceRevoke: (a: AuthSession, slug: string, reason?: string) =>
    jsonOrThrow<{ ok: boolean; affectedInstalls: number; affectedUserIds: number[] }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/admin/marketplace/${encodeURIComponent(slug)}/revoke`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ reason }),
        }),
      ),
    ),

  /**
   * 设置/取消精选（POST /api/admin/marketplace/:slug/featured；requireAdminVerifyDb）。
   * featuredRank：1..9999 精选排序（越小越靠前）；null=取消精选。listing 不存在/非
   * active 时后端返 404/409，上层据此提示。服务端契约见批3简报（并行 agent 实现）。
   */
  setMarketplaceFeatured: (a: AuthSession, slug: string, featuredRank: number | null) =>
    jsonOrThrow<{ ok: boolean; slug: string; featuredRank: number | null }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/admin/marketplace/${encodeURIComponent(slug)}/featured`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ featuredRank }),
        }),
      ),
    ),
};
