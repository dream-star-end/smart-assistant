/**
 * Non-first-screen settings / usage / API keys / QQ binding / feedback /
 * container preview / ChatGPT proxy / desktop enroll REST implementations.
 * Loaded on demand via `createLazyApiDomain` so these endpoints stay out of
 * the first-screen static closure.
 */
import type { ContainerPreviewViewport } from "@openclaude/protocol/containerPreview";
import type {
  ApiKeyPatch,
  ApiKeySummary,
  ApiKeyUsageReport,
  AuthSession,
  CreatedApiKey,
  UsageQuery,
  UsageReport,
  UsageReportWindow,
  UsageResponse,
} from "../types";
import type {
  ChatGptProxyAccess,
  ChatGptProxyCredential,
  ContainerPreviewTicketResponse,
  FeedbackSubmitInput,
  FeedbackSubmitResult,
  QqBindingStart,
  QqBindingStatus,
} from "../api";
import { bearerHeaders, callWithRefresh, jsonOrThrow , fetchWithExecutionGuard } from "./http";

/** /api/me/api-keys 线上形状（snake_case）；list / PATCH 共用。 */
type ApiKeyWire = {
  id: string;
  label: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
  disabled_at?: string | null;
  credit_limit?: string | null;
  spent_credits?: string;
};

function apiKeyFromWire(k: ApiKeyWire): ApiKeySummary {
  return {
    id: k.id,
    label: k.label,
    keyPrefix: k.key_prefix,
    createdAt: k.created_at,
    lastUsedAt: k.last_used_at,
    disabledAt: k.disabled_at ?? null,
    creditLimit: k.credit_limit ?? null,
    spentCredits: k.spent_credits ?? "0",
  };
}

export const secondaryAccountApiImpl = {
  getQqBinding: (a: AuthSession) =>
    jsonOrThrow<QqBindingStatus>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard("/api/me/qq-binding", {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  startQqBinding: (a: AuthSession) =>
    jsonOrThrow<QqBindingStart>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard("/api/me/qq-binding/start", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: "{}",
        }),
      ),
    ),

  deleteQqBinding: (a: AuthSession) =>
    jsonOrThrow<{ ok: boolean; unbound: boolean }>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard("/api/me/qq-binding", {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /**
   * 自由文本反馈（POST /api/feedback）。缺 Bearer 的公共调用仍可匿名；浏览器登录态提供
   * 无效 Bearer 时后端返回 401，callWithRefresh 刷新重放，避免把登录用户静默记成匿名。
   * 两种 source 分支分别重建 payload，消息上下文不会意外泄漏到设置反馈，反之亦然。
   */
  submitFeedback: (a: AuthSession, input: FeedbackSubmitInput): Promise<FeedbackSubmitResult> =>
    jsonOrThrow<FeedbackSubmitResult>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard("/api/feedback", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(
            input.category !== "response"
              ? {
                  category: input.category,
                  description: input.description,
                  ...(input.version ? { version: input.version } : {}),
                  ...(input.requestId ? { request_id: input.requestId } : {}),
                  ...(input.sessionId ? { session_id: input.sessionId } : {}),
                  meta: {
                    source: "settings",
                    ...(input.meta.locale ? { locale: input.meta.locale } : {}),
                    ...(input.meta.timezone ? { timezone: input.meta.timezone } : {}),
                  },
                }
              : {
                  category: "response",
                  description: input.description,
                  ...(input.requestId ? { request_id: input.requestId } : {}),
                  ...(input.sessionId ? { session_id: input.sessionId } : {}),
                  meta: {
                    source: "message",
                    message_id: input.meta.messageId,
                    role: input.meta.role,
                    ...(input.meta.errorCode ? { error_code: input.meta.errorCode } : {}),
                    ...(input.meta.reason ? { reason: input.meta.reason } : {}),
                    ...(input.meta.responseExcerpt
                      ? { response_excerpt: input.meta.responseExcerpt }
                      : {}),
                  },
                },
          ),
        }),
      ),
    ),

  /**
   * 用量统计（GET /api/me/usage，Bearer）。summary + 分页 sessions（offset）+
   * keyset ledger（before）+ savings。**所有大数字段为字符串，勿数值化。**
   * 抛 ApiError（含 400 INVALID_USAGE_QUERY）—— 调用方自行兜底，不再吞成 null。
   */
  getUsage: (a: AuthSession, q?: UsageQuery): Promise<UsageResponse> => {
    const qs = new URLSearchParams();
    if (q?.sessionsLimit != null) qs.set("sessions_limit", String(q.sessionsLimit));
    if (q?.sessionsOffset != null) qs.set("sessions_offset", String(q.sessionsOffset));
    if (q?.ledgerLimit != null) qs.set("ledger_limit", String(q.ledgerLimit));
    if (q?.ledgerBefore) qs.set("ledger_before", q.ledgerBefore);
    if (q?.boardProjectId) qs.set("boardProjectId", q.boardProjectId);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return jsonOrThrow<UsageResponse>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard(`/api/me/usage${suffix}`, { credentials: "include", headers: bearerHeaders(t) }),
      ),
    );
  },

  /**
   * 用量报表（GET /api/me/usage/report，Bearer，图表化窗口口径）。summary + 趋势 +
   * 按模型 + 账本（收支趋势 / 支出构成），window 默认由后端取 7d。trend 已补零升序。
   * **所有数字字段为字符串大数，勿数值化后当权威。** 抛 ApiError 由调用方兜底。
   */
  getMyUsageReport: (
    a: AuthSession,
    window: UsageReportWindow,
    q?: { boardProjectId?: string },
  ): Promise<UsageReport> => {
    const qs = new URLSearchParams({ window });
    if (q?.boardProjectId) qs.set("boardProjectId", q.boardProjectId);
    return jsonOrThrow<UsageReport>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard(`/api/me/usage/report?${qs.toString()}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    );
  },

  // ── API Keys（注意：当前后端 admin-only rollout，普通用户调用返 403） ─────────

  /** 列出我的 API key（GET /api/me/api-keys，Bearer）。不含明文。 */
  listApiKeys: (a: AuthSession): Promise<ApiKeySummary[]> =>
    jsonOrThrow<{ keys: ApiKeyWire[] }>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard("/api/me/api-keys", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => b.keys.map(apiKeyFromWire)),

  /**
   * 0277：改名 / 临时禁用 / 单 key 上限（PATCH /api/me/api-keys/:id，Bearer）。
   * 400 INVALID_LABEL / INVALID_LIMIT / INVALID_BODY，404 不存在或非本人，经 ApiError 抛。
   */
  updateApiKey: (a: AuthSession, id: string, patch: ApiKeyPatch): Promise<ApiKeySummary> => {
    const body: Record<string, unknown> = {};
    if (patch.label !== undefined) body.label = patch.label;
    if (patch.disabled !== undefined) body.disabled = patch.disabled;
    if (patch.creditLimit !== undefined) body.credit_limit = patch.creditLimit;
    return jsonOrThrow<ApiKeyWire>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard(`/api/me/api-keys/${encodeURIComponent(id)}`, {
          method: "PATCH",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(body),
        }),
      ),
    ).then(apiKeyFromWire);
  },

  /**
   * 0277：经 API key 的消耗报表（GET /api/me/api-keys/usage，Bearer）。
   * summary + 趋势 + 按 key + 按模型 + 最近明细；keyId 可选钉单 key。
   * **所有数字字段为字符串大数。**
   */
  getApiKeyUsage: (
    a: AuthSession,
    window: UsageReportWindow,
    keyId?: string | null,
  ): Promise<ApiKeyUsageReport> => {
    const qs = new URLSearchParams({ window });
    if (keyId) qs.set("key_id", keyId);
    return jsonOrThrow<ApiKeyUsageReport>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard(`/api/me/api-keys/usage?${qs.toString()}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    );
  },

  /**
   * 新建 API key（POST /api/me/api-keys，201，Bearer）。返完整明文 plaintext **仅一次**，
   * 必须立即引导用户复制保存；后端永远无法重新生成。400 INVALID_LABEL 经 ApiError 抛。
   */
  createApiKey: (a: AuthSession, label: string): Promise<CreatedApiKey> =>
    jsonOrThrow<{
      id: string;
      label: string;
      key_prefix: string;
      plaintext: string;
      created_at: string;
    }>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard("/api/me/api-keys", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ label }),
        }),
      ),
    ).then((b) => ({
      id: b.id,
      label: b.label,
      keyPrefix: b.key_prefix,
      plaintext: b.plaintext,
      createdAt: b.created_at,
    })),

  /**
   * 撤销 API key（DELETE /api/me/api-keys/:id，Bearer）。软撤销，幂等。
   * 不存在 / 已撤销 / 非本人一律 404（不暴露存在性），经 ApiError 抛。
   */
  deleteApiKey: (a: AuthSession, id: string): Promise<void> =>
    jsonOrThrow<{ ok: true }>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard(`/api/me/api-keys/${encodeURIComponent(id)}`, {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then(() => undefined),

  /** Mint a 30-second, single-use ticket for a container-local Chromium preview. */
  createContainerPreviewTicket: (
    a: AuthSession,
    url: string,
    viewport: ContainerPreviewViewport,
    options?: { direct?: boolean },
  ): Promise<ContainerPreviewTicketResponse> =>
    jsonOrThrow<ContainerPreviewTicketResponse>(
      callWithRefresh(a, (token) =>
        fetchWithExecutionGuard("/api/container-preview/ticket", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(token, true),
          body: JSON.stringify({ url, viewport, ...options }),
        }),
      ),
    ),

  heartbeatContainerPreview: (a: AuthSession, sessionId: string): Promise<void> =>
    jsonOrThrow<{ ok: true }>(
      callWithRefresh(a, (token) =>
        fetchWithExecutionGuard("/api/container-preview/heartbeat", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(token, true),
          body: JSON.stringify({ sessionId }),
        }),
      ),
    ).then(() => undefined),

  revokeContainerPreview: (a: AuthSession, sessionId: string): Promise<void> =>
    jsonOrThrow<{ ok: true }>(
      callWithRefresh(a, (token) =>
        fetchWithExecutionGuard("/api/container-preview/revoke", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(token, true),
          body: JSON.stringify({ sessionId }),
          keepalive: true,
        }),
      ),
    ).then(() => undefined),

  // ── ChatGPT 直连代理（仅管理员 + system_settings 白名单用户） ───────────────

  /** GET /api/chatgpt-proxy/access：授权状态 + 连接信息。未授权 → `{ enabled: false }`。 */
  getChatGptProxyAccess: (a: AuthSession): Promise<ChatGptProxyAccess> =>
    jsonOrThrow<ChatGptProxyAccess>(
      callWithRefresh(a, (token) =>
        fetchWithExecutionGuard("/api/chatgpt-proxy/access", {
          credentials: "include",
          headers: bearerHeaders(token),
        }),
      ),
    ),

  /** POST /api/chatgpt-proxy/credential：生成 / 轮换代理凭据，明文密码只返回这一次。 */
  createChatGptProxyCredential: (a: AuthSession): Promise<ChatGptProxyCredential> =>
    jsonOrThrow<ChatGptProxyCredential>(
      callWithRefresh(a, (token) =>
        fetchWithExecutionGuard("/api/chatgpt-proxy/credential", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(token),
        }),
      ),
    ),

  /** DELETE /api/chatgpt-proxy/credential：吊销当前凭据。 */
  revokeChatGptProxyCredential: (a: AuthSession): Promise<void> =>
    jsonOrThrow<{ ok: true }>(
      callWithRefresh(a, (token) =>
        fetchWithExecutionGuard("/api/chatgpt-proxy/credential", {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(token),
        }),
      ),
    ).then(() => undefined),

  /**
   * 确认桌面 enrollment（POST /api/desktop/enroll/confirm，Bearer）。
   * 成功 200 `{enrollment_id, code, deep_link}`；sim 平台 `deep_link` 为 null。
   * `code` 只用于服务端拼深链，本 helper **不**把 code 交给调用方，以免误渲染。
   * 失败经 ApiError 抛（401 / 403 DESKTOP_NOT_ENTITLED / 409 DEVICE_LIMIT|ENROLL_INVALID / 404 / 429）。
   */
  confirmDesktopEnroll: (
    a: AuthSession,
    enrollmentId: string,
  ): Promise<{ enrollmentId: string; deepLink: string | null }> =>
    jsonOrThrow<{ enrollment_id: string; code?: string; deep_link?: string | null }>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard("/api/desktop/enroll/confirm", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ enrollment_id: enrollmentId }),
        }),
      ),
    ).then((b) => ({
      enrollmentId: b.enrollment_id,
      deepLink: typeof b.deep_link === "string" && b.deep_link ? b.deep_link : null,
    })),
};
