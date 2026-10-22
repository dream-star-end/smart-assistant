/**
 * api: marketplace, inbox, GitHub link and repo selection, connectors (OAuth, declarative catalog), local plugins and managed plugin setups, Knowledge Planet automation.
 *
 * Moved verbatim out of `api` in api.ts — FINDINGS §8 (cc2), OCV5-475. `api`
 * spreads this object at the same position, so its keys, order and values are unchanged.
 */
import type {
  AuthSession,
  GithubBranch,
  GithubLink,
  GithubRepo,
  InboxMessage,
  RepoSelection,
  MarketplaceDetail,
  MarketplaceInstalled,
  MarketplaceAgentPublishInput,
  MarketplaceConnectorPublishInput,
  MarketplaceMyAgent,
  MarketplaceInstallResult,
  MarketplaceMyPublish,
  MarketplacePublishInput,
  MarketplacePublishResult,
  MarketplaceSearchResult,
} from "../types";
import type {
  ConnectorBindResult,
  ConnectorConfirmationDetail,
  ConnectorDecisionResult,
  ConnectorOAuthStartResult,
  ConnectorsResponse,
  DeclarativeBindResult,
  DeclarativeCatalogResponse,
  DeclarativeConnectionsResponse,
  DeclarativeManagementResponse,
  DeclarativeOauthStartResult,
  KnowledgePlanetSetupView,
  LiteratureSetupCapability,
  LiteratureSetupView,
  LocalPlugin,
  PluginManagementResponse,
  KnowledgePlanetAutomationControl,
  KnowledgePlanetAutomationGroup,
  KnowledgePlanetAutomationRule,
  KnowledgePlanetAutomationView,
  RuntimePluginAccount,
} from "../connectors";
import {
  callWithRefresh,
  assertAuthResponseCurrent,
  bearerHeaders,
  throwApi,
  jsonOrThrow,
} from "./http";

export const integrationsApi = {
  getLiteratureSetupCapability: (a: AuthSession): Promise<LiteratureSetupCapability> =>
    jsonOrThrow<LiteratureSetupCapability>(callWithRefresh(a, (t) => fetch('/api/plugins/literature-db/setup', {
      credentials: 'include', headers: bearerHeaders(t),
    }))),
  startLiteratureSetup: (a: AuthSession, input: { username: string; password: string; acceptTerms: boolean; accountId?: string }): Promise<LiteratureSetupView> =>
    jsonOrThrow<LiteratureSetupView>(callWithRefresh(a, (t) => fetch('/api/plugins/literature-db/setup', {
      method: 'POST', credentials: 'include', headers: bearerHeaders(t, true), body: JSON.stringify(input),
    }))),
  getLiteratureSetup: (a: AuthSession, operationId: string): Promise<LiteratureSetupView> =>
    jsonOrThrow<LiteratureSetupView>(callWithRefresh(a, (t) => fetch(`/api/plugins/literature-db/setup/${encodeURIComponent(operationId)}`, {
      credentials: 'include', headers: bearerHeaders(t),
    }))),
  async getLiteratureSetupImage(a: AuthSession, operationId: string, challengeId: string): Promise<Blob> {
    const res = await callWithRefresh(a, (t) => fetch(`/api/plugins/literature-db/setup/${encodeURIComponent(operationId)}/challenges/${encodeURIComponent(challengeId)}/image`, {
      credentials: 'include', headers: { ...bearerHeaders(t), Accept: 'image/png' },
    }));
    assertAuthResponseCurrent(res);
    if (!res.ok) await throwApi(res);
    const image = await res.blob();
    assertAuthResponseCurrent(res);
    return image;
  },
  answerLiteratureSetup: (a: AuthSession, operationId: string, challengeId: string, answer: string): Promise<LiteratureSetupView> =>
    jsonOrThrow<LiteratureSetupView>(callWithRefresh(a, (t) => fetch(`/api/plugins/literature-db/setup/${encodeURIComponent(operationId)}/answer`, {
      method: 'POST', credentials: 'include', headers: bearerHeaders(t, true), body: JSON.stringify({ challengeId, answer }),
    }))),
  cancelLiteratureSetup: (a: AuthSession, operationId: string): Promise<LiteratureSetupView> =>
    jsonOrThrow<LiteratureSetupView>(callWithRefresh(a, (t) => fetch(`/api/plugins/literature-db/setup/${encodeURIComponent(operationId)}`, {
      method: 'DELETE', credentials: 'include', headers: bearerHeaders(t),
    }))),
  async downloadLiteratureArtifact(a: AuthSession, artifactId: string): Promise<Blob> {
    const res = await callWithRefresh(a, (t) => fetch(`/api/plugins/literature-db/artifacts/${encodeURIComponent(artifactId)}`, {
      credentials: 'include', headers: { ...bearerHeaders(t), Accept: 'application/pdf' },
    }));
    assertAuthResponseCurrent(res);
    if (!res.ok) await throwApi(res);
    const pdf = await res.blob();
    assertAuthResponseCurrent(res);
    return pdf;
  },
  /** 文献 PDF 保存卡元数据（OCV5-585）：到期时间；已过期或已被清理（404）返回 null。 */
  async literatureArtifactMeta(
    a: AuthSession,
    artifactId: string,
  ): Promise<{ expiresAt: string; bytes: number; saved: boolean } | null> {
    const res = await callWithRefresh(a, (t) => fetch(`/api/plugins/literature-db/artifacts/${encodeURIComponent(artifactId)}/meta`, {
      credentials: 'include', headers: bearerHeaders(t),
    }));
    assertAuthResponseCurrent(res);
    if (res.status === 404) return null;
    if (!res.ok) await throwApi(res);
    return (await res.json()) as { expiresAt: string; bytes: number; saved: boolean };
  },

  // 社区教程 admin 审核 + 教程评测(/api/admin/tutorials/*)已整体迁往 lib/api/admin.ts
  // (adminApi),管理后台页直接 import;用户端无调用点,故此处不再保留代理。

  // ── AI 市场（marketplace，见 packages/commercial/src/marketplace） ─────────

  /** 市场检索/浏览（GET /api/marketplace/search?q=&limit=&kind=，空 q 返该 kind 全部目录）。 */
  searchMarketplace: (a: AuthSession, q = "", kind?: "skill" | "agent" | "connector", limit = 50) =>
    jsonOrThrow<MarketplaceSearchResult>(
      callWithRefresh(a, (t) =>
        fetch(
          `/api/marketplace/search?q=${encodeURIComponent(q)}&limit=${limit}${kind ? `&kind=${kind}` : ""}`,
          { credentials: "include", headers: bearerHeaders(t) },
        ),
      ),
    ),

  /** Opaque market invalidation token; compare equality only. */
  getMarketplaceRevision: (a: AuthSession) =>
    jsonOrThrow<{ revision: string }>(
      callWithRefresh(a, (t) =>
        fetch("/api/marketplace/revision", {
          credentials: "include",
          cache: "no-store",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** 市场条目详情（GET /api/marketplace/:slug，含完整 SKILL.md 供安装确认）。 */
  getMarketplaceDetail: (a: AuthSession, slug: string) =>
    jsonOrThrow<{ detail: MarketplaceDetail }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/marketplace/${encodeURIComponent(slug)}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then((b) => b.detail),

  /** 安装一个已批准版本（POST /api/marketplace/install）。 */
  installMarketplace: (
    a: AuthSession,
    versionId: string,
    agentIds?: string[],
    preserveManualScope = false,
  ) => {
    if (preserveManualScope && agentIds === undefined) {
      throw new Error("preserveManualScope requires the current compatibility scope");
    }
    return jsonOrThrow<MarketplaceInstallResult>(
      callWithRefresh(a, (t) =>
        fetch("/api/marketplace/install", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({
            versionId,
            ...(agentIds !== undefined
              ? {
                  agentIds,
                  // Normal edits are explicitly manual. Version updates instead send the
                  // legacy union without this flag: old servers preserve that union, while
                  // new servers subtract dependency-owned bindings before writing provenance.
                  ...(!preserveManualScope ? { manualAgentScope: true } : {}),
                }
              : {}),
          }),
        }),
      ),
    ).then((result) => ({
      ...result,
      // A tab may outlive a server rollback. The previous response shape omitted
      // composition outcomes, so normalize once at the API boundary for all callers.
      installedCapabilities: result.installedCapabilities ?? [],
      skippedOptional: result.skippedOptional ?? [],
      needsAuthorization: result.needsAuthorization ?? [],
      ready: result.ready ?? true,
      installedDeps: result.installedDeps ?? 0,
    }));
  },

  /** 修改已安装市场技能归属（PATCH /api/marketplace/installed/:slug）。 */
  updateMarketplaceInstallAgents: (a: AuthSession, slug: string, agentIds: string[]) =>
    jsonOrThrow<{ ok: boolean; agentIds: string[] }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/marketplace/installed/${encodeURIComponent(slug)}`, {
          method: "PATCH",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ agentIds }),
        }),
      ),
    ),

  /** 我的已安装（GET /api/marketplace/installed）。 */
  listMarketplaceInstalled: (a: AuthSession) =>
    jsonOrThrow<{ installed: MarketplaceInstalled[] }>(
      callWithRefresh(a, (t) =>
        fetch("/api/marketplace/installed", {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then((b) => b.installed || []),

  /** 卸载（DELETE /api/marketplace/installed/:slug）。 */
  uninstallMarketplace: (
    a: AuthSession,
    slug: string,
    reason:
      | "not_needed"
      | "poor_quality"
      | "missing_capability"
      | "install_error"
      | "other"
      | "prefer_not_say" = "prefer_not_say",
  ) =>
    jsonOrThrow<{ ok: boolean }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/marketplace/installed/${encodeURIComponent(slug)}`, {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ reason }),
        }),
      ),
    ),

  /**
   * 发布（POST /api/marketplace/publish）。整个 input 原样序列化为请求体,
   * 含 storefront 元数据 category/useCases/outcomeExamples/humanMd（后端在 SKILL.md
   * 工件之外单独入库）。被静态扫描拦截时抛 ApiError(status 422, code SCAN_BLOCKED,
   * body 含 riskFlags)，人向元数据校验失败时 400(code BAD_CATEGORY/BAD_USE_CASES 等)，
   * 上层据此做友好提示。
   */
  publishMarketplace: (a: AuthSession, input: MarketplacePublishInput) =>
    jsonOrThrow<MarketplacePublishResult>(
      callWithRefresh(a, (t) =>
        fetch("/api/marketplace/publish", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(input),
        }),
      ),
    ),

  /**
   * 发布智能体（POST /api/marketplace/agent/publish）。manifest 走后端严格白名单
   * 校验(模型∈公开目录/工具集∈vetted/skillDeps 须已上架),422 带 errors/riskFlags;
   * storefront 元数据 category/useCases/outcomeExamples/humanMd 随 input 原样上传,
   * 后端在 manifest 校验前剔除、单独入库(与 skill 发布同规则),校验失败 400。
   */
  publishMarketplaceAgent: (a: AuthSession, input: MarketplaceAgentPublishInput) =>
    jsonOrThrow<MarketplacePublishResult>(
      callWithRefresh(a, (t) =>
        fetch("/api/marketplace/agent/publish", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(input),
        }),
      ),
    ),

  /** 发布声明式连接器（进入 AI 自动审核；不确定或高风险项转人工复核）。 */
  publishMarketplaceConnector: (a: AuthSession, input: MarketplaceConnectorPublishInput) =>
    jsonOrThrow<MarketplacePublishResult>(
      callWithRefresh(a, (t) =>
        fetch("/api/marketplace/connector/publish", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(input),
        }),
      ),
    ),

  /** 我的发布记录（GET /api/marketplace/my-publishes：状态 + 审核理由，发布闭环）。 */
  listMarketplaceMyPublishes: (a: AuthSession) =>
    jsonOrThrow<{ publishes: MarketplaceMyPublish[] }>(
      callWithRefresh(a, (t) =>
        fetch("/api/marketplace/my-publishes", {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then((b) => b.publishes || []),

  /** 撤销自己的待审发布（POST /api/marketplace/my-publishes/:id/withdraw）。 */
  withdrawMarketplacePublish: (a: AuthSession, versionId: string) =>
    jsonOrThrow<{ ok: boolean }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/marketplace/my-publishes/${encodeURIComponent(versionId)}/withdraw`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({}),
        }),
      ),
    ),

  /** 发布者自助下架自己的当前上架条目（POST /api/marketplace/:slug/unlist）。 */
  unlistMarketplaceListing: (a: AuthSession, slug: string, reason?: string) =>
    jsonOrThrow<{ ok: boolean; affectedInstalls: number; affectedUserIds: number[] }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/marketplace/${encodeURIComponent(slug)}/unlist`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ reason }),
        }),
      ),
    ),

  /** 我的智能体（GET /api/marketplace/my-agents：默认全能助手 + 已安装市场智能体）。 */
  listMyAgents: (a: AuthSession) =>
    jsonOrThrow<{ agents: MarketplaceMyAgent[] }>(
      callWithRefresh(a, (t) =>
        fetch("/api/marketplace/my-agents", {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then((b) => b.agents || []),

  // ── 管理员审核（admin；实现已迁 lib/api/admin.ts 的 adminApi） ─────────────
  // why 惰性代理:市场审核面板(ReviewPanel)与精选管理(FeaturedPanel)是嵌在用户端
  // 市场中心的 admin-only 组件,调用点保留 `api.*` 不动;真正的实现(含全部
  // /api/admin/marketplace/* 路径字符串)进 lib/api/admin.ts 按需动态加载,不再
  // 占用户端首屏 chunk 体积。签名与迁出前一致,仅首跳多一次已缓存模块的 import()。

  /** 待审版本列表（GET /api/admin/marketplace/pending）。 */
  adminMarketplacePending: (
    ...a: Parameters<typeof import("./admin").adminApi.adminMarketplacePending>
  ) => import("./admin").then((m) => m.adminApi.adminMarketplacePending(...a)),

  /** AI 自动审批记录（GET /api/admin/marketplace/ai-reviews；review_source='ai'）。 */
  adminMarketplaceAiReviews: (
    ...a: Parameters<typeof import("./admin").adminApi.adminMarketplaceAiReviews>
  ) => import("./admin").then((m) => m.adminApi.adminMarketplaceAiReviews(...a)),

  /** 审核(批准/拒绝)一个版本（POST /api/admin/marketplace/:id/review）。 */
  adminMarketplaceReview: (
    ...a: Parameters<typeof import("./admin").adminApi.adminMarketplaceReview>
  ) => import("./admin").then((m) => m.adminApi.adminMarketplaceReview(...a)),

  /** 批量审核(批准/拒绝)多个待审版本（POST /api/admin/marketplace/review-batch）。 */
  adminMarketplaceReviewBatch: (
    ...a: Parameters<typeof import("./admin").adminApi.adminMarketplaceReviewBatch>
  ) => import("./admin").then((m) => m.adminApi.adminMarketplaceReviewBatch(...a)),

  /** 下架(kill-switch)一个条目（POST /api/admin/marketplace/:slug/revoke）。 */
  adminMarketplaceRevoke: (
    ...a: Parameters<typeof import("./admin").adminApi.adminMarketplaceRevoke>
  ) => import("./admin").then((m) => m.adminApi.adminMarketplaceRevoke(...a)),

  /**
   * 设置/取消精选（POST /api/admin/marketplace/:slug/featured；requireAdminVerifyDb）。
   * featuredRank：1..9999 精选排序（越小越靠前）；null=取消精选。
   */
  setMarketplaceFeatured: (
    ...a: Parameters<typeof import("./admin").adminApi.setMarketplaceFeatured>
  ) => import("./admin").then((m) => m.adminApi.setMarketplaceFeatured(...a)),

  // ── 站内信（inbox，用户侧） ───────────────────────────────────────────

  /** 拉站内信列表 + 未读数（GET /api/me/messages，Bearer）。unreadOnly 仅返未读。 */
  listInboxMessages: (
    a: AuthSession,
    opts?: { unreadOnly?: boolean; limit?: number; offset?: number },
  ): Promise<{ messages: InboxMessage[]; unread_count: number }> => {
    const qs = new URLSearchParams();
    if (opts?.unreadOnly) qs.set("unread_only", "1");
    if (opts?.limit != null) qs.set("limit", String(opts.limit));
    if (opts?.offset != null) qs.set("offset", String(opts.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return jsonOrThrow<{ messages: InboxMessage[]; unread_count: number }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/me/messages${suffix}`, { credentials: "include", headers: bearerHeaders(t) }),
      ),
    );
  },

  /** 仅未读数（GET /api/me/messages/unread_count，Bearer）。铃铛红点轮询用，轻量。 */
  getInboxUnreadCount: (a: AuthSession): Promise<number> =>
    jsonOrThrow<{ unread_count: number }>(
      callWithRefresh(a, (t) =>
        fetch("/api/me/messages/unread_count", {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then((b) => b.unread_count),

  /** 标记单条已读（POST /api/me/messages/:id/read，Bearer，幂等）。 */
  markInboxRead: (a: AuthSession, id: string): Promise<{ ok: boolean; already: boolean }> =>
    jsonOrThrow<{ ok: boolean; already: boolean }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/me/messages/${encodeURIComponent(id)}/read`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** 对一条违规记录申诉（POST /api/me/content-appeals）。 */
  appealContentStrike: (
    a: AuthSession,
    strikeId: string,
    statement: string,
  ): Promise<{ ok: boolean; appealId: string }> =>
    jsonOrThrow(
      callWithRefresh(a, (t) =>
        fetch("/api/me/content-appeals", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ strikeId, statement }),
        }),
      ),
    ),

  /** 全部标记已读（POST /api/me/messages/read_all，Bearer）。返插入行数。 */
  markAllInboxRead: (a: AuthSession): Promise<{ ok: boolean; inserted: number }> =>
    jsonOrThrow<{ ok: boolean; inserted: number }>(
      callWithRefresh(a, (t) =>
        fetch("/api/me/messages/read_all", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  // ── GitHub 仓库绑定 ──────────────────────────────────────────────────

  /**
   * 启动 GitHub 账号关联 OAuth（POST /api/auth/github/start，Bearer）。
   * 返回 authorizeUrl + state（同时 Set-Cookie state 做双因素校验），调用方
   * `location.href = authorizeUrl` 跳转 GitHub 授权页；授权后后端 302 回
   * `/?github_linked=1` 或 `/?github_error=<code>`。未配 OAuth 时后端 503。
   */
  startGithubOAuth: (a: AuthSession): Promise<{ authorizeUrl: string; state: string }> =>
    jsonOrThrow<{ authorizeUrl: string; state: string }>(
      callWithRefresh(a, (t) =>
        fetch("/api/auth/github/start", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: "{}",
        }),
      ),
    ),

  /** 读 GitHub 账号关联状态（GET /api/me/github，Bearer）。 */
  getGithubLink: (a: AuthSession): Promise<GithubLink> =>
    jsonOrThrow<GithubLink>(
      callWithRefresh(a, (t) =>
        fetch("/api/me/github", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ),

  /** 解绑 GitHub 账号（DELETE /api/me/github，Bearer）。级联清所有会话选择。 */
  unlinkGithub: (a: AuthSession): Promise<{ revoked: boolean; sessionsCleared: number }> =>
    jsonOrThrow<{ revoked: boolean; sessionsCleared: number }>(
      callWithRefresh(a, (t) =>
        fetch("/api/me/github", {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** 列我的 GitHub 仓库（GET /api/me/github/repos，Bearer）。默认按 pushed 倒序、owner 类型。 */
  listGithubRepos: (a: AuthSession): Promise<GithubRepo[]> =>
    jsonOrThrow<{ items: GithubRepo[] }>(
      callWithRefresh(a, (t) =>
        fetch("/api/me/github/repos?per_page=100&sort=pushed&type=owner", {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then((b) => b.items ?? []),

  /** 列某仓库分支（GET /api/me/github/repos/:owner/:repo/branches，Bearer）。 */
  listGithubBranches: (a: AuthSession, owner: string, repo: string): Promise<GithubBranch[]> =>
    jsonOrThrow<{ items: GithubBranch[] }>(
      callWithRefresh(a, (t) =>
        fetch(
          `/api/me/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100`,
          { credentials: "include", headers: bearerHeaders(t) },
        ),
      ),
    ).then((b) => b.items ?? []),

  /** 读某会话的仓库选择（GET /api/me/sessions/:sid/github-selection，Bearer）。 */
  getRepoSelection: (a: AuthSession, sid: string): Promise<RepoSelection> =>
    jsonOrThrow<RepoSelection>(
      callWithRefresh(a, (t) =>
        fetch(`/api/me/sessions/${encodeURIComponent(sid)}/github-selection`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /**
   * 设置某会话的仓库选择（PUT /api/me/sessions/:sid/github-selection，Bearer）。
   * 后端校验写权限/分支存在，返回权威 selection_version + status:'pending'。
   * 调用方拿到版本后经 WS 发 inbound.control.session_repo_bind 触发容器克隆。
   */
  putRepoSelection: (
    a: AuthSession,
    sid: string,
    body: { owner: string; repo: string; branch: string },
  ): Promise<RepoSelection> =>
    jsonOrThrow<RepoSelection>(
      callWithRefresh(a, (t) =>
        fetch(`/api/me/sessions/${encodeURIComponent(sid)}/github-selection`, {
          method: "PUT",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(body),
        }),
      ),
    ),

  /** 清某会话的仓库选择（DELETE /api/me/sessions/:sid/github-selection，Bearer）。不返新版本号。 */
  deleteRepoSelection: (a: AuthSession, sid: string): Promise<{ cleared: boolean }> =>
    jsonOrThrow<{ cleared: boolean }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/me/sessions/${encodeURIComponent(sid)}/github-selection`, {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  // ── 应用连接器（App Connectors） ─────────────────────────────────────
  // 契约与后端钉死（类型权威在 lib/connectors.ts）；错误码经 ApiError.code 上抛，
  // 由调用方走 connectorErrorText 映射中文，本层不做文案。

  /** 目录 + 已绑合并视图（GET /api/connectors，Bearer）。 */
  getConnectors: (a: AuthSession): Promise<ConnectorsResponse> =>
    jsonOrThrow<ConnectorsResponse>(
      callWithRefresh(a, (t) =>
        fetch("/api/connectors", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ),

  /** 表单绑定（token/basic_form；POST /api/connectors/:provider，Bearer）。 */
  bindConnector: (
    a: AuthSession,
    provider: string,
    body: { fields: Record<string, string>; displayName?: string },
  ): Promise<ConnectorBindResult> =>
    jsonOrThrow<ConnectorBindResult>(
      callWithRefresh(a, (t) =>
        fetch(`/api/connectors/${encodeURIComponent(provider)}`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(body),
        }),
      ),
    ),

  /**
   * BYOA OAuth 发起（POST /api/connectors/:provider/oauth/start，Bearer）。
   * 返回 authorizeUrl，调用方整页跳转（window.location.href）；授权后后端 302 回
   * `/?connector_linked=<provider>` 或 `/?connector_error=<code>`（照 GitHub 范式）。
   */
  startConnectorOAuth: (
    a: AuthSession,
    provider: string,
    body: { clientId: string; clientSecret: string; displayName?: string },
  ): Promise<ConnectorOAuthStartResult> =>
    jsonOrThrow<ConnectorOAuthStartResult>(
      callWithRefresh(a, (t) =>
        fetch(`/api/connectors/${encodeURIComponent(provider)}/oauth/start`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(body),
        }),
      ),
    ),

  /** 写操作确认完整详情（GET /api/connectors/confirmations/:id，服务端解密渲染）。 */
  getConnectorConfirmation: (a: AuthSession, id: string): Promise<ConnectorConfirmationDetail> =>
    jsonOrThrow<ConnectorConfirmationDetail>(
      callWithRefresh(a, (t) =>
        fetch(`/api/connectors/confirmations/${encodeURIComponent(id)}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** 批准 / 拒绝写操作（POST /api/connectors/confirmations/:id/approve|deny）。 */
  decideConnectorConfirmation: (
    a: AuthSession,
    id: string,
    decision: "approve" | "deny",
  ): Promise<ConnectorDecisionResult> =>
    jsonOrThrow<ConnectorDecisionResult>(
      callWithRefresh(a, (t) =>
        fetch(`/api/connectors/confirmations/${encodeURIComponent(id)}/${decision}`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: "{}",
        }),
      ),
    ),

  /** 重命名连接（PATCH /api/connectors/:id）。 */
  renameConnector: (a: AuthSession, id: string, displayName: string): Promise<void> =>
    jsonOrThrow<unknown>(
      callWithRefresh(a, (t) =>
        fetch(`/api/connectors/${encodeURIComponent(id)}`, {
          method: "PATCH",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ displayName }),
        }),
      ),
    ).then(() => undefined),

  /** 解绑连接（DELETE /api/connectors/:id，解绑 saga 由后端执行）。 */
  deleteConnector: (a: AuthSession, id: string): Promise<void> =>
    jsonOrThrow<unknown>(
      callWithRefresh(a, (t) =>
        fetch(`/api/connectors/${encodeURIComponent(id)}`, {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then(() => undefined),

  // ── 声明式连接器引擎（未来单一权威；REST 前缀 /api/connectors/declarative/*） ──
  // 契约与后端钉死（类型权威在 lib/connectors.ts）；错误码经 ApiError.code 上抛，
  // 由调用方走 connectorErrorText 映射中文，本层不做文案。

  /** 声明式目录（GET /api/connectors/declarative/catalog，Bearer）。 */
  getDeclarativeCatalog: (a: AuthSession): Promise<DeclarativeCatalogResponse> =>
    jsonOrThrow<DeclarativeCatalogResponse>(
      callWithRefresh(a, (t) =>
        fetch("/api/connectors/declarative/catalog", {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** 已绑声明式连接（GET /api/connectors/declarative/connections，Bearer）。 */
  getDeclarativeConnections: (a: AuthSession): Promise<DeclarativeConnectionsResponse> =>
    jsonOrThrow<DeclarativeConnectionsResponse>(
      callWithRefresh(a, (t) =>
        fetch("/api/connectors/declarative/connections", {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** 管理中心统一读模型（官方默认 + 市场安装 + 历史绑定 fallback）。 */
  getDeclarativeManagement: (a: AuthSession): Promise<DeclarativeManagementResponse> =>
    jsonOrThrow<DeclarativeManagementResponse>(
      callWithRefresh(a, (t) =>
        fetch("/api/connectors/declarative/management", {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** 绑定声明式连接器（POST /api/connectors/declarative/bind，Bearer）。 */
  bindDeclarativeConnector: (
    a: AuthSession,
    body: { versionId: number; secrets: Record<string, string>; displayName?: string },
  ): Promise<DeclarativeBindResult> =>
    jsonOrThrow<DeclarativeBindResult>(
      callWithRefresh(a, (t) =>
        fetch("/api/connectors/declarative/bind", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(body),
        }),
      ),
    ),

  /**
   * oauth2-auth-code 授权流起点（POST /api/connectors/declarative/oauth/start，Bearer）。
   * body 带用户 BYOA 自建应用的 client 凭据（clientSecret 只进服务端 AEAD 加密的 pending
   * draft，绝不进 authorize URL）。返回 authorizeUrl，调用方**整页跳转**；授权后后端 302 回
   * `/?connector_linked=<slug>` 或 `/?connector_error=<code>`（App 层统一 toast）。
   * 注：oauth2-auth-code 连接器走直填 bind 会被后端硬拒，必须走本端点。
   */
  startDeclarativeOauth: (
    a: AuthSession,
    body: { versionId: number; clientId: string; clientSecret: string; displayName?: string },
  ): Promise<DeclarativeOauthStartResult> =>
    jsonOrThrow<DeclarativeOauthStartResult>(
      callWithRefresh(a, (t) =>
        fetch("/api/connectors/declarative/oauth/start", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(body),
        }),
      ),
    ),

  /** 解绑声明式连接（DELETE /api/connectors/declarative/connections/:id，Bearer）。 */
  unbindDeclarativeConnector: (a: AuthSession, id: string): Promise<void> =>
    jsonOrThrow<unknown>(
      callWithRefresh(a, (t) =>
        fetch(`/api/connectors/declarative/connections/${encodeURIComponent(id)}`, {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then(() => undefined),

  // ── 通用 Plugin 运行时（账号授权与隔离执行）────────────────────────────

  /** 本机插件（随平台基线下发、在你的容器里运行，如同花顺行情）+ 启用状态（OCV5-383）。 */
  getLocalPlugins: (a: AuthSession): Promise<{ plugins: LocalPlugin[] }> =>
    jsonOrThrow<{ plugins: LocalPlugin[] }>(
      callWithRefresh(a, (t) =>
        fetch("/api/plugins/local", {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  getPluginManagement: (a: AuthSession): Promise<PluginManagementResponse> =>
    jsonOrThrow<PluginManagementResponse>(
      callWithRefresh(a, (t) =>
        fetch("/api/plugins/management", {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  startKnowledgePlanetSetup: (a: AuthSession): Promise<KnowledgePlanetSetupView> =>
    jsonOrThrow<KnowledgePlanetSetupView>(
      callWithRefresh(a, (t) =>
        fetch("/api/plugins/knowledge-planet/setup", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ acceptTerms: true }),
        }),
      ),
    ),

  getKnowledgePlanetSetup: (a: AuthSession, sessionId: string): Promise<KnowledgePlanetSetupView> =>
    jsonOrThrow<KnowledgePlanetSetupView>(
      callWithRefresh(a, (t) =>
        fetch(`/api/plugins/knowledge-planet/setup/${encodeURIComponent(sessionId)}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  async getKnowledgePlanetSetupQr(a: AuthSession, sessionId: string): Promise<Blob> {
    const res = await callWithRefresh(a, (t) =>
      fetch(`/api/plugins/knowledge-planet/setup/${encodeURIComponent(sessionId)}/qr`, {
        credentials: "include",
        headers: { ...bearerHeaders(t), Accept: "image/png" },
      }),
    );
    assertAuthResponseCurrent(res);
    if (!res.ok) await throwApi(res);
    const blob = await res.blob();
    assertAuthResponseCurrent(res);
    return blob;
  },

  cancelKnowledgePlanetSetup: (
    a: AuthSession,
    sessionId: string,
  ): Promise<KnowledgePlanetSetupView> =>
    jsonOrThrow<KnowledgePlanetSetupView>(
      callWithRefresh(a, (t) =>
        fetch(`/api/plugins/knowledge-planet/setup/${encodeURIComponent(sessionId)}`, {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  startWeiboSetup: (a: AuthSession, accountId?: string): Promise<KnowledgePlanetSetupView> =>
    jsonOrThrow<KnowledgePlanetSetupView>(
      callWithRefresh(a, (t) =>
        fetch("/api/plugins/weibo/setup", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ acceptTerms: true, ...(accountId ? { accountId } : {}) }),
        }),
      ),
    ),

  getWeiboSetup: (a: AuthSession, sessionId: string): Promise<KnowledgePlanetSetupView> =>
    jsonOrThrow<KnowledgePlanetSetupView>(
      callWithRefresh(a, (t) =>
        fetch(`/api/plugins/weibo/setup/${encodeURIComponent(sessionId)}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  async getWeiboSetupQr(a: AuthSession, sessionId: string): Promise<Blob> {
    const res = await callWithRefresh(a, (t) =>
      fetch(`/api/plugins/weibo/setup/${encodeURIComponent(sessionId)}/qr`, {
        credentials: "include",
        headers: { ...bearerHeaders(t), Accept: "image/png" },
      }),
    );
    assertAuthResponseCurrent(res);
    if (!res.ok) await throwApi(res);
    const blob = await res.blob();
    assertAuthResponseCurrent(res);
    return blob;
  },

  cancelWeiboSetup: (a: AuthSession, sessionId: string): Promise<KnowledgePlanetSetupView> =>
    jsonOrThrow<KnowledgePlanetSetupView>(
      callWithRefresh(a, (t) =>
        fetch(`/api/plugins/weibo/setup/${encodeURIComponent(sessionId)}`, {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  startZhihuSetup: (a: AuthSession, accountId?: string): Promise<KnowledgePlanetSetupView> =>
    jsonOrThrow<KnowledgePlanetSetupView>(
      callWithRefresh(a, (t) =>
        fetch("/api/plugins/zhihu/setup", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ acceptTerms: true, ...(accountId ? { accountId } : {}) }),
        }),
      ),
    ),

  getZhihuSetup: (a: AuthSession, sessionId: string): Promise<KnowledgePlanetSetupView> =>
    jsonOrThrow<KnowledgePlanetSetupView>(
      callWithRefresh(a, (t) =>
        fetch(`/api/plugins/zhihu/setup/${encodeURIComponent(sessionId)}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  async getZhihuSetupQr(a: AuthSession, sessionId: string): Promise<Blob> {
    const res = await callWithRefresh(a, (t) =>
      fetch(`/api/plugins/zhihu/setup/${encodeURIComponent(sessionId)}/qr`, {
        credentials: "include",
        headers: { ...bearerHeaders(t), Accept: "image/png" },
      }),
    );
    assertAuthResponseCurrent(res);
    if (!res.ok) await throwApi(res);
    const blob = await res.blob();
    assertAuthResponseCurrent(res);
    return blob;
  },

  cancelZhihuSetup: (a: AuthSession, sessionId: string): Promise<KnowledgePlanetSetupView> =>
    jsonOrThrow<KnowledgePlanetSetupView>(
      callWithRefresh(a, (t) =>
        fetch(`/api/plugins/zhihu/setup/${encodeURIComponent(sessionId)}`, {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  // OCV5-402: 哔哩哔哩账号插件(只读,扫码登录)。与知乎同一组接口形状。
  startBiliAccountSetup: (a: AuthSession, accountId?: string): Promise<KnowledgePlanetSetupView> =>
    jsonOrThrow<KnowledgePlanetSetupView>(
      callWithRefresh(a, (t) =>
        fetch("/api/plugins/bili-account/setup", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ acceptTerms: true, ...(accountId ? { accountId } : {}) }),
        }),
      ),
    ),

  getBiliAccountSetup: (a: AuthSession, sessionId: string): Promise<KnowledgePlanetSetupView> =>
    jsonOrThrow<KnowledgePlanetSetupView>(
      callWithRefresh(a, (t) =>
        fetch(`/api/plugins/bili-account/setup/${encodeURIComponent(sessionId)}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  async getBiliAccountSetupQr(a: AuthSession, sessionId: string): Promise<Blob> {
    const res = await callWithRefresh(a, (t) =>
      fetch(`/api/plugins/bili-account/setup/${encodeURIComponent(sessionId)}/qr`, {
        credentials: "include",
        headers: { ...bearerHeaders(t), Accept: "image/png" },
      }),
    );
    assertAuthResponseCurrent(res);
    if (!res.ok) await throwApi(res);
    const blob = await res.blob();
    assertAuthResponseCurrent(res);
    return blob;
  },

  cancelBiliAccountSetup: (a: AuthSession, sessionId: string): Promise<KnowledgePlanetSetupView> =>
    jsonOrThrow<KnowledgePlanetSetupView>(
      callWithRefresh(a, (t) =>
        fetch(`/api/plugins/bili-account/setup/${encodeURIComponent(sessionId)}`, {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  // OCV5-553: 抖音插件(个人号扫码登录)。与 B 站账号同一组接口形状。
  startDouyinSetup: (a: AuthSession, accountId?: string): Promise<KnowledgePlanetSetupView> =>
    jsonOrThrow<KnowledgePlanetSetupView>(
      callWithRefresh(a, (t) =>
        fetch("/api/plugins/douyin/setup", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ acceptTerms: true, ...(accountId ? { accountId } : {}) }),
        }),
      ),
    ),

  getDouyinSetup: (a: AuthSession, sessionId: string): Promise<KnowledgePlanetSetupView> =>
    jsonOrThrow<KnowledgePlanetSetupView>(
      callWithRefresh(a, (t) =>
        fetch(`/api/plugins/douyin/setup/${encodeURIComponent(sessionId)}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  async getDouyinSetupQr(a: AuthSession, sessionId: string): Promise<Blob> {
    const res = await callWithRefresh(a, (t) =>
      fetch(`/api/plugins/douyin/setup/${encodeURIComponent(sessionId)}/qr`, {
        credentials: "include",
        headers: { ...bearerHeaders(t), Accept: "image/png" },
      }),
    );
    assertAuthResponseCurrent(res);
    if (!res.ok) await throwApi(res);
    const blob = await res.blob();
    assertAuthResponseCurrent(res);
    return blob;
  },

  cancelDouyinSetup: (a: AuthSession, sessionId: string): Promise<KnowledgePlanetSetupView> =>
    jsonOrThrow<KnowledgePlanetSetupView>(
      callWithRefresh(a, (t) =>
        fetch(`/api/plugins/douyin/setup/${encodeURIComponent(sessionId)}`, {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  revokePluginAccount: (a: AuthSession, id: string): Promise<void> =>
    jsonOrThrow<unknown>(
      callWithRefresh(a, (t) =>
        fetch(`/api/plugins/accounts/${encodeURIComponent(id)}`, {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then(() => undefined),

  setPluginWriteAccess: (
    a: AuthSession,
    id: string,
    input: { enabled: false } | { enabled: true; accepted: true; disclaimerVersion: number },
  ): Promise<RuntimePluginAccount["writeControl"]> =>
    jsonOrThrow<{ writeControl: RuntimePluginAccount["writeControl"] }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/plugins/accounts/${encodeURIComponent(id)}/write-access`, {
          method: "PATCH",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(input),
        }),
      ),
    ).then((result) => result.writeControl),

  setPluginWritePreapproval: (
    a: AuthSession,
    id: string,
    input: { enabled: false } | { enabled: true; accepted: true; disclaimerVersion: number },
  ): Promise<RuntimePluginAccount["writeControl"]> =>
    jsonOrThrow<{ writeControl: RuntimePluginAccount["writeControl"] }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/plugins/accounts/${encodeURIComponent(id)}/write-preapproval`, {
          method: "PATCH",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(input),
        }),
      ),
    ).then((result) => result.writeControl),

  getKnowledgePlanetAutomation: (
    a: AuthSession,
    id: string,
  ): Promise<KnowledgePlanetAutomationView> =>
    jsonOrThrow<KnowledgePlanetAutomationView>(
      callWithRefresh(a, (t) =>
        fetch(`/api/plugins/accounts/${encodeURIComponent(id)}/automation`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  setKnowledgePlanetAutomation: (
    a: AuthSession,
    id: string,
    input:
      | { enabled: false; accountDailyLimit?: number }
      | {
          enabled: true;
          accepted: true;
          disclaimerVersion: number;
          accountDailyLimit?: number;
        },
  ): Promise<KnowledgePlanetAutomationControl> =>
    jsonOrThrow<{ control: KnowledgePlanetAutomationControl }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/plugins/accounts/${encodeURIComponent(id)}/automation`, {
          method: "PATCH",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(input),
        }),
      ),
    ).then((result) => result.control),

  listKnowledgePlanetAutomationGroups: (
    a: AuthSession,
    id: string,
  ): Promise<KnowledgePlanetAutomationGroup[]> =>
    jsonOrThrow<{ groups: KnowledgePlanetAutomationGroup[] }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/plugins/accounts/${encodeURIComponent(id)}/automation/groups`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then((result) => result.groups),

  createKnowledgePlanetAutomationRulesBatch: (
    a: AuthSession,
    id: string,
    input: {
      groupIds: string[];
      name: string;
      instructions: string;
      triggerKind: "new_topic" | "new_question";
      dailyLimit: number;
      cooldownMinutes: number;
      maxReplyChars: number;
    },
  ): Promise<KnowledgePlanetAutomationRule[]> =>
    jsonOrThrow<{ rules: KnowledgePlanetAutomationRule[] }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/plugins/accounts/${encodeURIComponent(id)}/automation/rules/batch`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(input),
        }),
      ),
    ).then((result) => result.rules),

  createKnowledgePlanetAutomationRule: (
    a: AuthSession,
    id: string,
    input: {
      groupId: string;
      name: string;
      instructions: string;
      triggerKind: "new_topic" | "new_question";
      dailyLimit: number;
      cooldownMinutes: number;
      maxReplyChars: number;
    },
  ): Promise<KnowledgePlanetAutomationRule> =>
    jsonOrThrow<{ rule: KnowledgePlanetAutomationRule }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/plugins/accounts/${encodeURIComponent(id)}/automation/rules`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(input),
        }),
      ),
    ).then((result) => result.rule),

  patchKnowledgePlanetAutomationRule: (
    a: AuthSession,
    id: string,
    ruleId: string,
    patch: Partial<{
      name: string;
      instructions: string;
      triggerKind: "new_topic" | "new_question";
      enabled: boolean;
      dailyLimit: number;
      cooldownMinutes: number;
      maxReplyChars: number;
    }>,
  ): Promise<KnowledgePlanetAutomationRule> =>
    jsonOrThrow<{ rule: KnowledgePlanetAutomationRule }>(
      callWithRefresh(a, (t) =>
        fetch(
          `/api/plugins/accounts/${encodeURIComponent(id)}/automation/rules/${encodeURIComponent(ruleId)}`,
          {
            method: "PATCH",
            credentials: "include",
            headers: bearerHeaders(t, true),
            body: JSON.stringify(patch),
          },
        ),
      ),
    ).then((result) => result.rule),

  deleteKnowledgePlanetAutomationRule: (
    a: AuthSession,
    id: string,
    ruleId: string,
  ): Promise<void> =>
    jsonOrThrow<unknown>(
      callWithRefresh(a, (t) =>
        fetch(
          `/api/plugins/accounts/${encodeURIComponent(id)}/automation/rules/${encodeURIComponent(ruleId)}`,
          {
            method: "DELETE",
            credentials: "include",
            headers: bearerHeaders(t),
          },
        ),
      ),
    ).then(() => undefined),
}
