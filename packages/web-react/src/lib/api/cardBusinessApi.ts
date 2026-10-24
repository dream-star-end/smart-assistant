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
}
