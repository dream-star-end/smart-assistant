import { withCardBusinessApi } from "./cardBusinessLoader";
import type { RequestExecutionGuard } from "./http";
import type { AuthSession } from "../types";
import { callWithRefresh, bearerHeaders, jsonOrThrow } from "./http";
import { createLazyApiDomain } from "./lazyDomain";

type IntegrationsLazyImpl = typeof import("./integrationsLazyImpl").integrationsLazyImpl;
type AdminMarketplaceApi = Pick<
  typeof import("./admin").adminApi,
  | "adminMarketplacePending"
  | "adminMarketplaceAiReviews"
  | "adminMarketplaceReview"
  | "adminMarketplaceReviewBatch"
  | "adminMarketplaceRevoke"
  | "setMarketplaceFeatured"
>;

const integrationsLazyProxy = createLazyApiDomain<IntegrationsLazyImpl>(
  () => import("./integrationsLazyImpl").then((m) => m.integrationsLazyImpl),
  [
    "getLiteratureSetupCapability",
    "startLiteratureSetup",
    "getLiteratureSetup",
    "getLiteratureSetupImage",
    "answerLiteratureSetup",
    "cancelLiteratureSetup",
    "downloadLiteratureArtifact",
    "literatureArtifactMeta",
    "searchMarketplace",
    "getMarketplaceRevision",
    "getMarketplaceDetail",
    "installMarketplace",
    "updateMarketplaceInstallAgents",
    "listMarketplaceInstalled",
    "uninstallMarketplace",
    "publishMarketplace",
    "publishMarketplaceAgent",
    "publishMarketplaceConnector",
    "listMarketplaceMyPublishes",
    "withdrawMarketplacePublish",
    "unlistMarketplaceListing",
    "listMyAgents",
    "listInboxMessages",
    "markInboxRead",
    "appealContentStrike",
    "markAllInboxRead",
    "startGithubOAuth",
    "getGithubLink",
    "unlinkGithub",
    "listGithubRepos",
    "listGithubBranches",
    "getRepoSelection",
    "putRepoSelection",
    "deleteRepoSelection",
    "getConnectors",
    "bindConnector",
    "startConnectorOAuth",
    "renameConnector",
    "deleteConnector",
    "getDeclarativeCatalog",
    "getDeclarativeConnections",
    "getDeclarativeManagement",
    "bindDeclarativeConnector",
    "startDeclarativeOauth",
    "unbindDeclarativeConnector",
    "getLocalPlugins",
    "getPluginManagement",
    "startKnowledgePlanetSetup",
    "getKnowledgePlanetSetup",
    "getKnowledgePlanetSetupQr",
    "cancelKnowledgePlanetSetup",
    "startWeiboSetup",
    "getWeiboSetup",
    "getWeiboSetupQr",
    "cancelWeiboSetup",
    "startZhihuSetup",
    "getZhihuSetup",
    "getZhihuSetupQr",
    "cancelZhihuSetup",
    "startBiliAccountSetup",
    "getBiliAccountSetup",
    "getBiliAccountSetupQr",
    "cancelBiliAccountSetup",
    "startDouyinSetup",
    "getDouyinSetup",
    "getDouyinSetupQr",
    "cancelDouyinSetup",
    "revokePluginAccount",
    "setPluginWriteAccess",
    "setPluginWritePreapproval",
    "getKnowledgePlanetAutomation",
    "setKnowledgePlanetAutomation",
    "listKnowledgePlanetAutomationGroups",
    "createKnowledgePlanetAutomationRulesBatch",
    "createKnowledgePlanetAutomationRule",
    "patchKnowledgePlanetAutomationRule",
    "deleteKnowledgePlanetAutomationRule",
  ],
);

const adminMarketplaceProxy = createLazyApiDomain<AdminMarketplaceApi>(
  () => import("./admin").then((m) => m.adminApi),
  [
    "adminMarketplacePending",
    "adminMarketplaceAiReviews",
    "adminMarketplaceReview",
    "adminMarketplaceReviewBatch",
    "adminMarketplaceRevoke",
    "setMarketplaceFeatured",
  ],
);

/**
 * api: marketplace, inbox, GitHub link and repo selection, connectors, local/managed
 * plugins, and Knowledge Planet automation.
 *
 * Only `getInboxUnreadCount` (boot polling) stays inline; all secondary center domains
 * forward via lazy dynamic imports to keep them out of the first-screen static closure.
 */
export const integrationsApi = {
  ...integrationsLazyProxy,
  ...adminMarketplaceProxy,

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

  /** 写操作确认完整详情（GET /api/connectors/confirmations/:id，服务端解密渲染）。 */
  getConnectorConfirmation: (a: AuthSession, id: string, guard?: RequestExecutionGuard) =>
    withCardBusinessApi(a, guard, (client) => client.getConnectorConfirmation(a, id, guard)),

  /** 批准 / 拒绝写操作（POST /api/connectors/confirmations/:id/approve|deny）。 */
  decideConnectorConfirmation: (
    a: AuthSession,
    id: string,
    decision: "approve" | "deny",
    guard?: RequestExecutionGuard,
  ) =>
    withCardBusinessApi(a, guard, (client) =>
      client.decideConnectorConfirmation(a, id, decision, guard),
    ),
};
