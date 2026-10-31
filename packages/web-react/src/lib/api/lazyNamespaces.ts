type IntegrationsApi = typeof import("./integrationsApi").integrationsApi;
type MemorySkillsApi = typeof import("./memorySkillsApi").memorySkillsApi;

function bindLazy<T extends object>(
  load: () => Promise<T>,
  keys: readonly (keyof T & string)[],
): T {
  const facade = {} as T;
  for (const key of keys) {
    const call = (...args: unknown[]) =>
      load().then((mod) => {
        const fn = mod[key];
        if (typeof fn !== "function") throw new TypeError(`api.${key} is not a function`);
        return (fn as (...inner: unknown[]) => unknown).apply(mod, args);
      });
    facade[key] = call as T[typeof key];
  }
  return facade;
}

let integrationsPending: Promise<IntegrationsApi> | undefined;
function loadIntegrationsApi(): Promise<IntegrationsApi> {
  if (!integrationsPending) {
    integrationsPending = import("./integrationsApi")
      .then((mod) => mod.integrationsApi)
      .catch((error: unknown) => {
        integrationsPending = undefined;
        throw error;
      });
  }
  return integrationsPending;
}

let memoryPending: Promise<MemorySkillsApi> | undefined;
function loadMemorySkillsApi(): Promise<MemorySkillsApi> {
  if (!memoryPending) {
    memoryPending = import("./memorySkillsApi")
      .then((mod) => mod.memorySkillsApi)
      .catch((error: unknown) => {
        memoryPending = undefined;
        throw error;
      });
  }
  return memoryPending;
}

/** 首屏不静态拉市场、收件箱、连接器和记忆技能客户端。第一次调用再取，失败可重试。 */
export function prefetchDeferredApisOnIdle(): void {
  const run = () => {
    void loadIntegrationsApi().catch(() => undefined);
    void loadMemorySkillsApi().catch(() => undefined);
  };
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(run, { timeout: 8000 });
  } else {
    setTimeout(run, 3000);
  }
}

const INTEGRATION_KEYS: ReadonlyArray<keyof IntegrationsApi> = [
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
  "adminMarketplacePending",
  "adminMarketplaceAiReviews",
  "adminMarketplaceReview",
  "adminMarketplaceReviewBatch",
  "adminMarketplaceRevoke",
  "setMarketplaceFeatured",
  "listInboxMessages",
  "getInboxUnreadCount",
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
  "getConnectorConfirmation",
  "decideConnectorConfirmation",
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
];

const MEMORY_KEYS: ReadonlyArray<keyof MemorySkillsApi> = [
  "getMemory",
  "putMemory",
  "getMemoryIndex",
  "getMemoryUsage",
  "getMemoryContext",
  "getAutoDreamReport",
  "getAutoDreamOptimizer",
  "runAutoDreamOptimizer",
  "cancelAutoDreamOptimizer",
  "mutateAutoDreamProposal",
  "getMemoryFile",
  "putMemoryFile",
  "deleteMemoryFile",
  "listCron",
  "listCronChannels",
  "createCron",
  "updateCron",
  "deleteCron",
  "listResearchLibrary",
  "deleteResearchDoc",
  "uploadResearchDoc",
  "listSkills",
  "getSkill",
  "deleteSkill",
  "updateSkill",
  "createSkill",
  "getSkillFile",
  "putSkillFile",
  "deleteSkillFile",
  "getSkillHistory",
  "restoreSkillVersion",
  "getSkillEvals",
  "putSkillEvals",
  "startSkillEvalRun",
  "getSkillEvalRun",
  "generateSkillEvals",
  "getSkillEvalGen",
  "getReleaseJob",
  "startSkillTrain",
  "listSkillTrainRuns",
  "getSkillTrainRun",
  "discardSkillTrainRun",
  "listSkillDrafts",
  "getSkillDraft",
  "commentSkillDraft",
  "mergeSkillTrainRun",
  "listCommunityTutorials",
  "getCommunityTutorial",
  "submitCommunityTutorial",
  "submitTutorialSnapshot",
  "listMyCommunityTutorials",
  "precheckCommunityTutorial",
  "getMyCommunityTutorial",
  "uploadTutorialImage",
  "fetchTutorialImage",
  "reviseCommunityTutorial",
  "withdrawCommunityTutorial",
];

export const integrationsApi = bindLazy(loadIntegrationsApi, INTEGRATION_KEYS);
export const memorySkillsApi = bindLazy(loadMemorySkillsApi, MEMORY_KEYS);
