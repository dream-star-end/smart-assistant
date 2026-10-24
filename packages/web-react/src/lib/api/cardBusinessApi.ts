import type { CommunityTutorialCategory, CommunityTutorialDetail, CommunityTutorialPage, CommunityTutorialReviseResult, CommunityTutorialSummary, TutorialKind, TutorialSnapshotDraft, TutorialSnapshotSubmitResult } from '../types'
import type { AuthSession, CommunityBlogPrecheck, CommunityTutorialDraft, CommunityTutorialMine, TutorialImageUpload } from '../types'
import type { ConnectorConfirmationDetail, ConnectorDecisionResult } from '../connectors'
import { bearerHeaders, callWithRefresh, fetchWithExecutionGuard, jsonOrThrow, type RequestExecutionGuard } from './http'

/** Fixed legacy card endpoints. Human pages keep their default client semantics. */
export const cardBusinessApi = {
  getConnectorConfirmation: (a: AuthSession, id: string, guard?: RequestExecutionGuard): Promise<ConnectorConfirmationDetail> =>
    jsonOrThrow<ConnectorConfirmationDetail>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard(`/api/connectors/confirmations/${encodeURIComponent(id)}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }, guard),
      ),
    ),
  decideConnectorConfirmation: (
    a: AuthSession,
    id: string,
    decision: "approve" | "deny",
    guard?: RequestExecutionGuard,
  ): Promise<ConnectorDecisionResult> =>
    jsonOrThrow<ConnectorDecisionResult>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard(`/api/connectors/confirmations/${encodeURIComponent(id)}/${decision}`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: "{}",
        }, guard),
      ),
    ),
  submitCommunityTutorial: (a: AuthSession, draft: CommunityTutorialDraft, guard?: RequestExecutionGuard) =>
    jsonOrThrow<{ tutorial: { id: string; status: "pending"; createdAt: string } }>(
      callWithRefresh(a, (token) =>
        fetchWithExecutionGuard("/api/tutorials", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(token, true),
          body: JSON.stringify(draft),
        }, guard),
      ),
    ).then((result) => result.tutorial),
  precheckCommunityTutorial: (a: AuthSession, draft: CommunityTutorialDraft, guard?: RequestExecutionGuard) =>
    jsonOrThrow<CommunityBlogPrecheck>(
      callWithRefresh(a, (token) =>
        fetchWithExecutionGuard("/api/tutorials/precheck", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(token, true),
          body: JSON.stringify(draft),
        }, guard),
      ),
    ),
  getMyCommunityTutorial: (a: AuthSession, id: string, guard?: RequestExecutionGuard) =>
    jsonOrThrow<{ tutorial: CommunityTutorialMine }>(
      callWithRefresh(a, (token) =>
        fetchWithExecutionGuard(`/api/tutorials/mine/${encodeURIComponent(id)}`, {
          credentials: "include",
          headers: bearerHeaders(token),
        }, guard),
      ),
    ).then((result) => result.tutorial),
  uploadTutorialImage: (a: AuthSession, file: Blob, guard?: RequestExecutionGuard) =>
    jsonOrThrow<{ image: TutorialImageUpload }>(
      callWithRefresh(a, (token) =>
        fetchWithExecutionGuard("/api/tutorials/images", {
          method: "POST",
          credentials: "include",
          headers: { ...bearerHeaders(token), "Content-Type": file.type || "image/webp" },
          body: file,
        }, guard),
      ),
    ).then((result) => result.image),
  listCommunityTutorials: (opts?: {
    cursor?: string | null;
    query?: string;
    category?: CommunityTutorialCategory | null;
    limit?: number;
    /** 经验分享只列 markdown 投稿。 */
    kind?: TutorialKind | null;
  }) => {
    const qs = new URLSearchParams();
    if (opts?.cursor) qs.set("cursor", opts.cursor);
    if (opts?.query) qs.set("q", opts.query);
    if (opts?.category) qs.set("category", opts.category);
    if (opts?.kind) qs.set("kind", opts.kind);
    if (opts?.limit) qs.set("limit", String(opts.limit));
    const suffix = qs.size > 0 ? `?${qs.toString()}` : "";
    return jsonOrThrow<CommunityTutorialPage<CommunityTutorialSummary>>(
      fetch(`/api/tutorials${suffix}`),
    );
  },
  getCommunityTutorial: (id: string) =>
    jsonOrThrow<{ tutorial: CommunityTutorialDetail }>(
      fetch(`/api/tutorials/${encodeURIComponent(id)}`),
    ).then((result) => result.tutorial),
  submitTutorialSnapshot: (a: AuthSession, draft: TutorialSnapshotDraft) =>
    jsonOrThrow<TutorialSnapshotSubmitResult>(
      callWithRefresh(a, (token) =>
        fetch("/api/tutorials/snapshots", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(token, true),
          body: JSON.stringify(draft),
        }),
      ),
    ).then((result) => ({
      tutorial: { ...result.tutorial, kind: result.tutorial.kind ?? "snapshot" },
      leakReport: result.leakReport ?? null,
    })),
  listMyCommunityTutorials: (a: AuthSession, cursor?: string | null) =>
    jsonOrThrow<CommunityTutorialPage<CommunityTutorialMine>>(
      callWithRefresh(a, (token) =>
        fetch(`/api/tutorials/mine${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, {
          credentials: "include",
          headers: bearerHeaders(token),
        }),
      ),
    ),
  fetchTutorialImage: async (a: AuthSession, sha256: string): Promise<Blob> => {
    const res = await callWithRefresh(a, (token) =>
      fetch(`/api/tutorials/images/${encodeURIComponent(sha256)}`, {
        credentials: "include",
        headers: bearerHeaders(token),
      }),
    );
    if (!res.ok) throw new Error(`读取图片失败（${res.status}）`);
    return res.blob();
  },
  reviseCommunityTutorial: (a: AuthSession, id: string, draft: CommunityTutorialDraft) =>
    jsonOrThrow<{ tutorial: CommunityTutorialReviseResult }>(
      callWithRefresh(a, (token) =>
        fetch(`/api/tutorials/${encodeURIComponent(id)}/revise`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(token, true),
          body: JSON.stringify(draft),
        }),
      ),
    ).then((result) => result.tutorial),
  withdrawCommunityTutorial: (a: AuthSession, id: string) =>
    jsonOrThrow<{ ok: boolean }>(
      callWithRefresh(a, (token) =>
        fetch(`/api/tutorials/${encodeURIComponent(id)}/withdraw`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(token, true),
          body: JSON.stringify({}),
        }),
      ),
    ),
}
