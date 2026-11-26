/**
 * Plugins runtime, Grok relay route allocation, V3 container supervisor wiring,
 * remote sshMux/media/preheat helpers, direct preview, and ChatGPT proxy bootstrap.
 *
 * Extracted from packages/commercial/src/index.ts (OCV5-830).
 */
import { homedir } from "node:os";
import * as path from "node:path";
import Docker from "dockerode";
import type IORedis from "ioredis";
import { createResendMailer, stubMailer } from "../auth/mail.js";
import { DEFAULT_BRIDGE_SECRET_PATH, loadOrCreateBridgeSecret } from "../bridgeSecret.js";
import { deriveMediaSignKey } from "../http/mediaSign.js";
import { ThumbnailDiskCache } from "../http/mediaThumbnail.js";
import { deriveWechatLiveLinkKey } from "../wechat/liveShare.js";
import { assertModelCatalogAdminPoolConfigured } from "../db/modelCatalogAdmin.js";
import {
  MAX_DELEGATE_GROK_LEASES_PER_CONTAINER,
  createGrokRouteContextForModel,
  expireSettledGrokRouteLeases,
  hasActiveOfficialOAuthAccountInGroup,
  listActiveGrokRouteLeases,
  listEnabledGroupsForModel,
} from "../account-pool/groups.js";
import {
  AccountPoolBusyError,
  AccountPoolUnavailableError,
  type AccountScheduler,
} from "../account-pool/scheduler.js";
import { syncLogicalModelPoolBindingsFromCatalog } from "../account-pool/remotePool/logicalModelBindingsSync.js";
import { bootstrapLegacyRetirementGate, type LegacyTrackRetirementGate } from "../account-pool/remotePool/legacyRetirementRuntime.js";
import type { LocalCasArtifactBlobStore } from "../agent-sandbox/artifactBlobStore.js";
import { createMasterArtifactBlobStore } from "../agent-sandbox/artifactBlobRuntime.js";
import { createMasterCc5Runtime } from "../agent-sandbox/cc5Runtime.js";
import {
  makeDraftPreparation,
  makePreparationReady,
  type DraftPreparationHint,
} from "../agent-sandbox/draftPreparation.js";
import {
  DEFAULT_PLATFORM_ROOT,
  DEFAULT_RUNTIME_RELEASES_ROOT,
  DEFAULT_V3_CCB_BASELINE_DIR,
  createSyntheticEvalOverlayRuntime,
  createUserMediaResolver,
  makePrewarmContainer,
  makeUidSingleflight,
  makeV3EnsureRunning,
  readSyntheticEvalReleaseSourceCommit,
  resolveCcbBaselineMounts,
  resolvePlatformBundleMount,
  resolveRuntimeReleaseMount,
  type UserMediaLocation,
  type V3RuntimeTuple,
  type V3SupervisorDeps,
} from "../agent-sandbox/index.js";
import { V3_CONTAINER_PORT } from "../agent-sandbox/v3supervisor.js";
import { makeWorkspacePreparation } from "../agent-sandbox/workspacePreparation.js";
import { scopeFromAuthz, type makeLoadUserModelAuthz } from "../auth/userModelAuthz.js";
import { isModelAvailable } from "../billing/modelAvailability.js";
import { PLATFORM_AUX_MODEL_IDS, type ModelCatalogCache } from "../billing/modelCatalog.js";
import { getModelCatalogCache, peekModelCatalogCache } from "../billing/modelCatalogRuntime.js";
import type { PreCheckRedis } from "../billing/preCheck.js";
import { createRemoteNativeTurnFinance } from "../billing/remoteNativeTurnBilling.js";
import { ChatGptProxyCredentialStore } from "../chatgptProxy/credentials.js";
import { getChatGptProxyFlagSnapshot, readChatGptProxyEnv } from "../chatgptProxy/flags.js";
import { createChatGptProxyServer, type ChatGptProxyServer } from "../chatgptProxy/server.js";
import {
  deleteRemoteCodexContainerAuth,
  putRemoteCodexContainerAuth,
} from "../codex-auth/remoteCodexAuth.js";
import { createContainerService } from "../compute-pool/containerService.js";
import {
  deleteFile as nodeAgentDeleteFile,
  getFile as nodeAgentGetFile,
  hostRowToTarget,
  putFile as nodeAgentPutFile,
  resolveServiceableHostTarget,
  startSshControlMaster,
  stopSshControlMaster,
} from "../compute-pool/nodeAgentClient.js";
import * as computeQueries from "../compute-pool/queries.js";
import type { CommercialConfig } from "../config.js";
import { defaultCutoverInFlightTracker } from "../deploy/cutoverReadiness.js";
import { getPool } from "../db/index.js";
import type { DispatchAdmissionBackend } from "../db/pgSessionsBackend.js";
import { tx } from "../db/queries.js";
import { makeEnginePreheatClient } from "../dispatch/enginePreheatClient.js";
import {
  makeDraftEnginePreparation,
  makeEnginePreheatPreparation,
} from "../dispatch/enginePreheatPreparation.js";
import type { assertFlavorIdentity } from "../flavor/assertFlavor.js";
import type { ChatGptProxyHttpDeps } from "../http/chatgptProxy.js";
import { HttpError } from "../http/util.js";
import { rootLogger } from "../logging/logger.js";
import { isInMaintenance } from "../middleware/maintenanceMode.js";
import {
  BILI_ACCOUNT_BROKER_ROOT,
  BILI_ACCOUNT_WORKER_ROOT,
  BiliAccountDockerService,
  createBiliAccountRuntimeRegistries,
} from "../plugins/biliAccount.js";
import { BiliAccountSetupManager } from "../plugins/biliAccountSetup.js";
import { ManagedBrowserRuntime } from "../plugins/browserRuntime.js";
import {
  DOUYIN_BROKER_ROOT,
  DOUYIN_WORKER_ROOT,
  DouyinDockerService,
  createDouyinRuntimeRegistries,
} from "../plugins/douyin.js";
import { DouyinSetupManager } from "../plugins/douyinSetup.js";
import { PREFS_PLUGIN_ENABLEMENT } from "../plugins/enablement.js";
import {
  KnowledgePlanetDockerService,
  createKnowledgePlanetRuntimeRegistries,
} from "../plugins/knowledgePlanet.js";
import { KnowledgePlanetAutomationService } from "../plugins/knowledgePlanetAutomation.js";
import { KnowledgePlanetSetupManager } from "../plugins/knowledgePlanetSetup.js";
import { createCommercialLiteratureRuntime } from "../plugins/literatureDb/jieyouLoginSession.js";
import { PluginRuntimeFacade } from "../plugins/runtime.js";
import { WeiboDockerService, createWeiboRuntimeRegistries } from "../plugins/weibo.js";
import { WeiboSetupManager } from "../plugins/weiboSetup.js";
import { ZhihuDockerService, createZhihuRuntimeRegistries } from "../plugins/zhihu.js";
import { ZhihuSetupManager } from "../plugins/zhihuSetup.js";
import { recordProductFrictionEvent } from "../productFriction/events.js";
import { RemoteHostError } from "../remoteHosts/service.js";
import { setRemoteMuxDeps } from "../remoteHosts/sshMux.js";
import { getRuntimeChannel } from "../runtimeChannel.js";
import { makeNodeHttpContainerTransport } from "../wechat/nodeHttpContainerTransport.js";
import { AuthoritySigner } from "../ws/authoritySigner.js";
import {
  CONTAINER_PREVIEW_MAX_FRAME_BYTES,
  createContainerPreviewBridge,
  type ContainerPreviewBridgeHandler,
} from "../ws/containerPreviewBridge.js";
import { ContainerPreviewTicketStore } from "../ws/containerPreviewTickets.js";
import {
  createDirectContainerPreviewService,
  type DirectContainerPreviewService,
} from "../ws/directContainerPreview.js";
import {
  LIVE_BROWSER_MAX_FRAME_BYTES,
  claimUnavailableLiveBrowserUpgrade,
  createLiveBrowserBridge,
  type LiveBrowserBridgeHandler,
} from "../ws/liveBrowserBridge.js";
export { claimUnavailableLiveBrowserUpgrade };
import { LiveBrowserTicketStore } from "../ws/liveBrowserTickets.js";
import { createTunnelContainerSocket } from "../ws/tunnelContainerSocket.js";
import type { ResolveContainerEndpoint } from "../ws/userChatBridge.js";

export function bootstrapPluginsRuntime(deps: {
  cfg: CommercialConfig;
  runtimeChannel: string;
  redis: IORedis;
  knowledgePlanetMediaResolverRef: {
    current: ((userId: string) => Promise<UserMediaLocation>) | undefined;
  };
}) {
  const knowledgePlanetMediaDeps = {
    resolveUserMediaDirs: async (userId: string): Promise<UserMediaLocation> => {
      if (!deps.knowledgePlanetMediaResolverRef.current)
        throw new Error("Knowledge Planet media resolver unavailable");
      return deps.knowledgePlanetMediaResolverRef.current(userId);
    },
    pullRemoteHostMedia: async (args: { hostUuid: string; remotePath: string }) => {
      const target = await resolveServiceableHostTarget(args.hostUuid);
      try {
        return await nodeAgentGetFile(target, args.remotePath);
      } finally {
        target.psk?.fill(0);
      }
    },
    stagingRoot: "/var/lib/openclaude-v5/plugin-media-staging",
    expectedOwnerUid: 0,
  };

  let knowledgePlanetService: KnowledgePlanetDockerService | undefined;
  let knowledgePlanetSetup: KnowledgePlanetSetupManager | undefined;
  let weiboService: WeiboDockerService | undefined;
  let weiboSetup: WeiboSetupManager | undefined;
  let zhihuService: ZhihuDockerService | undefined;
  let zhihuSetup: ZhihuSetupManager | undefined;
  let biliAccountService: BiliAccountDockerService | undefined;
  let biliAccountSetup: BiliAccountSetupManager | undefined;
  let douyinService: DouyinDockerService | undefined;
  let douyinSetup: DouyinSetupManager | undefined;
  let knowledgePlanetAutomation: KnowledgePlanetAutomationService | undefined;
  const {
    literatureSetup,
    literatureArtifacts,
    literatureHttp,
    literatureRelogin,
    literatureObserver,
  } = createCommercialLiteratureRuntime({
    runtimeChannel: deps.runtimeChannel,
    redis: deps.redis,
    logger: rootLogger,
  });

  let pluginFacade: PluginRuntimeFacade;
  if (deps.runtimeChannel === "v5" && deps.cfg.OC_RUNTIME_IMAGE_ID) {
    const pluginDocker = deps.cfg.AGENT_DOCKER_SOCKET
      ? new Docker({ socketPath: deps.cfg.AGENT_DOCKER_SOCKET })
      : new Docker();
    knowledgePlanetService = new KnowledgePlanetDockerService(pluginDocker, {
      imageId: deps.cfg.OC_RUNTIME_IMAGE_ID,
      workerRoot: "/var/lib/openclaude-v5/plugin-workers",
      brokerRoot: "/run/openclaude-v5/plugin-browser-brokers",
      expectedOwnerUid: 0,
      socketUid: 1000,
      socketGid: 1000,
    });
    weiboService = new WeiboDockerService(pluginDocker, {
      imageId: deps.cfg.OC_RUNTIME_IMAGE_ID,
      workerRoot: "/var/lib/openclaude-v5/plugin-workers-weibo",
      brokerRoot: "/run/openclaude-v5/plugin-browser-brokers-weibo",
      expectedOwnerUid: 0,
      socketUid: 1000,
      socketGid: 1000,
    });
    zhihuService = new ZhihuDockerService(pluginDocker, {
      imageId: deps.cfg.OC_RUNTIME_IMAGE_ID,
      workerRoot: "/var/lib/openclaude-v5/plugin-workers-zhihu",
      brokerRoot: "/run/openclaude-v5/plugin-browser-brokers-zhihu",
      expectedOwnerUid: 0,
      socketUid: 1000,
      socketGid: 1000,
    });
    biliAccountService = new BiliAccountDockerService(pluginDocker, {
      imageId: deps.cfg.OC_RUNTIME_IMAGE_ID,
      workerRoot: BILI_ACCOUNT_WORKER_ROOT,
      brokerRoot: BILI_ACCOUNT_BROKER_ROOT,
      expectedOwnerUid: 0,
      socketUid: 1000,
      socketGid: 1000,
    });
    douyinService = new DouyinDockerService(pluginDocker, {
      imageId: deps.cfg.OC_RUNTIME_IMAGE_ID,
      workerRoot: DOUYIN_WORKER_ROOT,
      brokerRoot: DOUYIN_BROKER_ROOT,
      expectedOwnerUid: 0,
      socketUid: 1000,
      socketGid: 1000,
    });
    const knowledgePlanetRegistries = createKnowledgePlanetRuntimeRegistries(knowledgePlanetService);
    const weiboRegistries = createWeiboRuntimeRegistries(weiboService);
    const zhihuRegistries = createZhihuRuntimeRegistries(zhihuService);
    const biliAccountRegistries = createBiliAccountRuntimeRegistries(biliAccountService);
    const douyinRegistries = createDouyinRuntimeRegistries(douyinService);
    const browserRuntime = new ManagedBrowserRuntime({
      drivers: new Map([
        ...knowledgePlanetRegistries.drivers,
        ...weiboRegistries.drivers,
        ...zhihuRegistries.drivers,
        ...biliAccountRegistries.drivers,
        ...douyinRegistries.drivers,
      ]),
      launchers: new Map([
        ...knowledgePlanetRegistries.launchers,
        ...weiboRegistries.launchers,
        ...zhihuRegistries.launchers,
        ...biliAccountRegistries.launchers,
        ...douyinRegistries.launchers,
      ]),
      profileRoot: "/var/lib/openclaude-v5/plugin-browser-profiles",
      expectedOwnerUid: 0,
    });
    pluginFacade = new PluginRuntimeFacade({
      redis: deps.redis,
      browserRuntime,
      knowledgePlanetMedia: knowledgePlanetMediaDeps,
      literatureHttp,
      literatureRelogin,
      literatureObserver,
      pluginEnablement: PREFS_PLUGIN_ENABLEMENT,
    });
    knowledgePlanetSetup = new KnowledgePlanetSetupManager(knowledgePlanetService, {
      isAgentReady: (contract) => browserRuntime.supportsContract(contract),
    });
    weiboSetup = new WeiboSetupManager(weiboService, {
      redis: deps.redis,
      isAgentReady: (contract) => browserRuntime.supportsContract(contract),
    });
    zhihuSetup = new ZhihuSetupManager(zhihuService, {
      redis: deps.redis,
      isAgentReady: (contract) => browserRuntime.supportsContract(contract),
    });
    biliAccountSetup = new BiliAccountSetupManager(biliAccountService, {
      redis: deps.redis,
      isAgentReady: (contract) => browserRuntime.supportsContract(contract),
    });
    douyinSetup = new DouyinSetupManager(douyinService, {
      redis: deps.redis,
      isAgentReady: (contract) => browserRuntime.supportsContract(contract),
    });
    knowledgePlanetAutomation = new KnowledgePlanetAutomationService(pluginFacade);
  } else {
    pluginFacade = new PluginRuntimeFacade({
      redis: deps.redis,
      literatureHttp,
      literatureRelogin,
      literatureObserver,
      pluginEnablement: PREFS_PLUGIN_ENABLEMENT,
    });
  }

  return {
    pluginFacade,
    knowledgePlanetSetup,
    weiboSetup,
    zhihuSetup,
    biliAccountSetup,
    douyinSetup,
    knowledgePlanetAutomation,
    literatureSetup,
    literatureArtifacts,
  };
}

export function createGrokRelayRouteAllocator(scheduler: AccountScheduler) {
  return async ({
    containerId,
    userId,
    modelId,
    sessionId,
    origin,
  }: {
    containerId: number;
    userId: bigint;
    modelId: string;
    sessionId?: string;
    origin?: "bridge" | "delegate";
  }) => {
    if (!isModelAvailable(modelId)) {
      return { kind: "unavailable" as const, reason: "model temporarily unavailable" };
    }
    await expireSettledGrokRouteLeases();
    for (const lease of await listActiveGrokRouteLeases()) {
      scheduler.restoreCodexSlot(lease.accountId, lease.slotId);
    }
    const groups = await listEnabledGroupsForModel({ modelId, provider: "grok" });
    let busy: AccountPoolBusyError | null = null;
    for (const group of groups) {
      let picked;
      try {
        picked = await scheduler.pick({
          mode: "agent",
          provider: "grok",
          groupId: group.id,
          sessionId: sessionId ?? `container:${containerId}`,
          userId,
        });
      } catch (err) {
        if (err instanceof AccountPoolBusyError) {
          busy = err;
          continue;
        }
        if (err instanceof AccountPoolUnavailableError) continue;
        throw err;
      }
      picked.token.fill(0);
      picked.refresh?.fill(0);
      let route;
      try {
        route = await tx((client) =>
          createGrokRouteContextForModel({
            containerId,
            userId,
            modelId,
            accountId: picked.account_id,
            slotId: picked.slotId,
            groupId: group.id,
            runner: client,
            maxConcurrent: scheduler.maxConcurrent,
            kind: origin ?? "bridge",
            ...(origin === "delegate"
              ? { maxDelegatePerContainer: MAX_DELEGATE_GROK_LEASES_PER_CONTAINER }
              : {}),
          }),
        );
      } catch (err) {
        scheduler.releaseCodexSlot(picked.account_id, picked.slotId);
        throw err;
      }
      if (!route) {
        scheduler.releaseCodexSlot(picked.account_id, picked.slotId);
        continue;
      }
      return {
        kind: "api_relay" as const,
        engine: "grok" as const,
        token: route.token,
        baseUrl: `http://127.0.0.1:${V3_CONTAINER_PORT}/internal/v5/grok-relay/route/${route.token}/v1`,
        modelProvider: "grok",
        providerName: "xAI Grok subscription",
        wireApi: "chat" as const,
        preferredAuthMethod: "apikey" as const,
        disableResponseStorage: true,
        groupId: route.group.id.toString(),
        credentialId: route.accountId.toString(),
        accountId: route.accountId.toString(),
        slotId: picked.slotId,
      };
    }
    if (busy) throw busy;
    return { kind: "unavailable" as const, reason: "no usable Grok subscription account" };
  };
}

export function assembleV3SupervisorCore(deps: {
  env: NodeJS.ProcessEnv;
  cfg: CommercialConfig;
  flavorIdentity: ReturnType<typeof assertFlavorIdentity>;
  bridgeSecret: string | undefined;
  modelAuthoritySigner: AuthoritySigner | undefined;
  modelAuthorityProvisionRequired: boolean;
  modelCatalogCache: ModelCatalogCache | undefined;
  preCheckRedis: PreCheckRedis;
  loadUserModelAuthz: ReturnType<typeof makeLoadUserModelAuthz>;
  selfHostUuid: string | undefined;
  sessionsDeletedRef: { current: (userId: string, sessionIds: readonly string[]) => void };
}): {
  v3Docker: Docker;
  v3Deps: V3SupervisorDeps;
  cc5Runtime: ReturnType<typeof createMasterCc5Runtime>;
  legacyRetirementGate: LegacyTrackRetirementGate;
} {
  const v3Docker = deps.cfg.AGENT_DOCKER_SOCKET
    ? new Docker({ socketPath: deps.cfg.AGENT_DOCKER_SOCKET })
    : new Docker();

  let runtimeTuple: V3RuntimeTuple | undefined;
  if (deps.cfg.OC_RUNTIME_IMAGE_ID || deps.cfg.OC_PLATFORM_BUNDLE || deps.cfg.OC_RUNTIME_RELEASE) {
    const platformRoot = deps.cfg.OC_PLATFORM_ROOT ?? DEFAULT_PLATFORM_ROOT;
    const releasesRoot = deps.cfg.OC_RUNTIME_RELEASES_ROOT ?? DEFAULT_RUNTIME_RELEASES_ROOT;
    const t: V3RuntimeTuple = {
      imageId: deps.cfg.OC_RUNTIME_IMAGE_ID,
      bundlePath: deps.cfg.OC_PLATFORM_BUNDLE,
      releasePath: deps.cfg.OC_RUNTIME_RELEASE,
      platformRoot,
      releasesRoot,
    };
    if (deps.cfg.OC_PLATFORM_BUNDLE) {
      try {
        const resolved = resolvePlatformBundleMount(deps.cfg.OC_PLATFORM_BUNDLE, {
          ancestorRoot: platformRoot,
          platformRoot,
        });
        t.bundleResolvedPath = resolved.resolvedPath;
        t.bundleRev = resolved.bundleRev;
        t.bootHash = resolved.bootHash;
        // eslint-disable-next-line no-console
        console.log("[commercial] v5 platform bundle validated", {
          bundlePath: deps.cfg.OC_PLATFORM_BUNDLE,
          bundleRev: resolved.bundleRev,
          bootHash: resolved.bootHash,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          "[commercial] v5 platform bundle validation FAILED — provision will fail-closed (or skip with OC_PLATFORM_BUNDLE_OPTIONAL=1)",
          { bundlePath: deps.cfg.OC_PLATFORM_BUNDLE, error: (err as Error).message },
        );
      }
    }
    if (deps.cfg.OC_RUNTIME_RELEASE) {
      try {
        t.releaseResolvedPath = resolveRuntimeReleaseMount(deps.cfg.OC_RUNTIME_RELEASE, releasesRoot);
        // eslint-disable-next-line no-console
        console.log("[commercial] v5 runtime release validated", {
          releasePath: deps.cfg.OC_RUNTIME_RELEASE,
          resolved: t.releaseResolvedPath,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          "[commercial] v5 runtime release validation FAILED — provision will fail-closed",
          { releasePath: deps.cfg.OC_RUNTIME_RELEASE, error: (err as Error).message },
        );
      }
    }
    runtimeTuple = t;
  }

  const isSelfhostV5 =
    getRuntimeChannel() === "v5" &&
    deps.flavorIdentity.status === "ok" &&
    deps.flavorIdentity.flavor === "selfhost";

  if (isSelfhostV5 && deps.modelCatalogCache) {
    const catalogCache = deps.modelCatalogCache;
    void syncLogicalModelPoolBindingsFromCatalog(
      getPool(),
      async () => (await catalogCache.assertFresh()).entries,
      { overwriteAdminOverrides: false },
    )
      .then((stats) => {
        rootLogger.info("[commercial] selfhost logical model pool bindings synced", {
          synced: stats.synced,
          enabled: stats.enabled,
          disabled: stats.disabled,
          skipped: stats.skipped,
        });
      })
      .catch((err: unknown) => {
        rootLogger.warn(
          "[commercial] selfhost logical model pool bindings startup sync failed (fail-open)",
          { error: err instanceof Error ? err.message : String(err) },
        );
      });
  }

  const legacyRetirementGate = bootstrapLegacyRetirementGate({ queryable: getPool(), rawFlag: deps.env.OC_LEGACY_REMOTE_TRACKS_RETIRED, isSelfhostV5, log: rootLogger });
  const cc5Runtime = createMasterCc5Runtime({
    selfhost: isSelfhostV5,
    authorityReady: Boolean(deps.modelAuthoritySigner) && deps.modelAuthorityProvisionRequired,
    env: deps.env, egressSecret: deps.cfg.OC_EGRESS_SECRET, legacyRetirementGate,
    ...(deps.modelAuthoritySigner && deps.modelCatalogCache
      ? {
          financeFactory: (_binding, lane) =>
            createRemoteNativeTurnFinance({
              pool: getPool(), preCheckRedis: deps.preCheckRedis, catalog: deps.modelCatalogCache!,
              keyring: () => deps.modelAuthoritySigner!.publicKeyring(),
              loadUserModelAuthz: deps.loadUserModelAuthz,
              log: rootLogger.child({ subsys: "remoteNativeBilling" }),
              upstreamModel: lane.upstreamModel, legacyRetirementGate,
            }),
        }
      : {}),
  });
  if (cc5Runtime) {
    deps.sessionsDeletedRef.current = (userId, sessionIds) => {
      const uid = /^c:(\d+)$/.exec(userId)?.[1];
      if (!uid) return;
      for (const id of sessionIds) {
        cc5Runtime.releaseChat(Number(uid), id).catch((error: unknown) =>
          rootLogger.warn("[selfhost] remote lane release on delete failed", {
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    };
  }

  const v3Deps: V3SupervisorDeps = {
    ...(cc5Runtime ? { cc5: cc5Runtime } : {}),
    docker: v3Docker,
    pool: getPool(),
    image: deps.cfg.OC_RUNTIME_IMAGE!,
    bridgeSecret: deps.bridgeSecret,
    ...(deps.modelAuthoritySigner
      ? {
          modelAuthority: {
            keyringEnvAssignment: () => deps.modelAuthoritySigner!.publicKeyringEnvAssignment(),
            required: deps.modelAuthorityProvisionRequired,
            auxModels: PLATFORM_AUX_MODEL_IDS,
          },
        }
      : {}),
    ...(runtimeTuple ? { runtimeTuple } : {}),
    ...(getRuntimeChannel() === "v5"
      ? {
          syntheticEvalOverlay: createSyntheticEvalOverlayRuntime({
            expectedBaseCommit: readSyntheticEvalReleaseSourceCommit(
              runtimeTuple?.releaseResolvedPath ? process.cwd() : undefined,
            ),
          }),
        }
      : {}),
    ...(deps.selfHostUuid
      ? {
          containerService: createContainerService(v3Docker),
          selfHostId: deps.selfHostUuid,
          putRemoteCodexAuth: async (
            hostUuid: string,
            containerId: string,
            accessToken: string,
            lastRefreshIso: string,
          ) => {
            const target = await resolveServiceableHostTarget(hostUuid);
            try {
              await putRemoteCodexContainerAuth(target, containerId, accessToken, lastRefreshIso);
            } finally {
              target.psk?.fill(0);
            }
          },
          deleteRemoteCodexAuth: async (hostUuid: string, containerId: string) => {
            const target = await resolveServiceableHostTarget(hostUuid);
            try {
              await deleteRemoteCodexContainerAuth(target, containerId);
            } finally {
              target.psk?.fill(0);
            }
          },
        }
      : {}),
  };

  // eslint-disable-next-line no-console
  console.log("[commercial] v3 supervisor wired", {
    image: deps.cfg.OC_RUNTIME_IMAGE,
    multiHost: Boolean(deps.selfHostUuid),
    selfHostId: deps.selfHostUuid ?? null,
  });

  const baselineDir = deps.env.OC_V3_CCB_BASELINE_DIR?.trim() || DEFAULT_V3_CCB_BASELINE_DIR;
  const resolved = resolveCcbBaselineMounts(baselineDir);
  const optional = deps.env.OC_V3_CCB_BASELINE_OPTIONAL?.trim().toLowerCase();
  const optionalFlagOn = optional === "1" || optional === "true" || optional === "yes";
  if (resolved) {
    // eslint-disable-next-line no-console
    console.log("[commercial] v3 ccb baseline ready", {
      baselineDir,
      claudeMd: resolved.claudeMdHostPath,
      skillsDir: resolved.skillsDirHostPath,
      optional: optionalFlagOn,
    });
  } else if (optionalFlagOn) {
    // eslint-disable-next-line no-console
    console.warn(
      "[commercial] v3 ccb baseline missing (OPTIONAL=1) — new containers will spawn WITHOUT platform guardrails",
      { baselineDir },
    );
  } else {
    // eslint-disable-next-line no-console
    console.error(
      "[commercial] v3 ccb baseline MISSING — next provisionV3Container will FAIL (fail-closed). Fix baseline rsync or set OC_V3_CCB_BASELINE_OPTIONAL=1 for dev only.",
      { baselineDir },
    );
  }

  return { v3Docker, v3Deps, cc5Runtime, legacyRetirementGate };
}

export function wireRemoteMuxDeps(): void {
  setRemoteMuxDeps({
    async resolvePlacement(userId, hostId) {
      const uidInt = Number.parseInt(userId, 10);
      if (!Number.isFinite(uidInt) || uidInt <= 0 || String(uidInt) !== userId) {
        throw new RemoteHostError("INTERNAL", `resolvePlacement: userId not positive integer: ${userId}`);
      }
      const sticky = await computeQueries.findUserStickyHost(uidInt);
      if (!sticky) {
        throw new RemoteHostError(
          "INTERNAL",
          `NO_CONTAINER: user ${userId} has no active container (hostId=${hostId})`,
        );
      }
      const hostRow = await computeQueries.getHostById(sticky.hostUuid);
      if (!hostRow) {
        throw new RemoteHostError(
          "INTERNAL",
          `compute_host ${sticky.hostUuid} not found (userId=${userId} hostId=${hostId})`,
        );
      }
      rootLogger.debug("sshMux resolvePlacement", {
        subsys: "remote-ssh",
        userId,
        hostId,
        resolvedHostUuid: hostRow.id,
        resolvedName: hostRow.name,
      });
      if (hostRow.name === "self") return { kind: "self" };
      if (hostRow.status === "revoked") {
        throw new RemoteHostError(
          "INTERNAL",
          `compute_host ${sticky.hostUuid} revoked (userId=${userId} hostId=${hostId})`,
        );
      }
      const target = hostRowToTarget(hostRow);
      target.requireFingerprint = true;
      return { kind: "remote", target };
    },
    startSshControlMaster,
    stopSshControlMaster,
    putRemoteFile: nodeAgentPutFile,
    deleteRemoteFile: nodeAgentDeleteFile,
  });
  // eslint-disable-next-line no-console
  console.log("[commercial] sshMux remote deps wired");
}

export function buildContainerHelpersAndPreview(deps: {
  env: NodeJS.ProcessEnv;
  runtimeChannel: string;
  v3Deps: V3SupervisorDeps | undefined;
  agentRuntimeDocker: Docker | undefined;
  bridgeSecret: string | undefined;
  loadUserModelAuthz: ReturnType<typeof makeLoadUserModelAuthz>;
  dispatchAdmissionBackend: DispatchAdmissionBackend | undefined;
  modelAuthoritySigner: AuthoritySigner | undefined;
  gatewayPort: number | undefined;
  containerPreviewTickets: ContainerPreviewTicketStore | undefined;
  containerPreviewBaseUrl: string | undefined;
}) {
  const clearResolvedEndpointSecret = (
    endpoint: Awaited<ReturnType<ResolveContainerEndpoint>>,
  ): void => {
    try {
      endpoint.tunnel?.nodeAgent.psk?.fill(0);
    } catch {
      /* best-effort secret cleanup */
    }
  };
  const cloneResolvedEndpoint = (
    endpoint: Awaited<ReturnType<ResolveContainerEndpoint>>,
  ): Awaited<ReturnType<ResolveContainerEndpoint>> => ({
    ...endpoint,
    ...(endpoint.tunnel
      ? {
          tunnel: {
            ...endpoint.tunnel,
            nodeAgent: {
              ...endpoint.tunnel.nodeAgent,
              psk: endpoint.tunnel.nodeAgent.psk
                ? Buffer.from(endpoint.tunnel.nodeAgent.psk)
                : null,
            },
          },
        }
      : {}),
  });
  const sharedEnsureRunning: ResolveContainerEndpoint | undefined = deps.v3Deps
    ? makeUidSingleflight(makeV3EnsureRunning(deps.v3Deps), {
        cloneResult: cloneResolvedEndpoint,
        disposeSharedResult: clearResolvedEndpointSecret,
      })
    : undefined;

  const ensureContainerEndpointReady: ((uid: bigint) => Promise<void>) | undefined =
    sharedEnsureRunning
      ? async (uid) => {
          const endpoint = await sharedEnsureRunning(uid);
          clearResolvedEndpointSecret(endpoint);
        }
      : undefined;

  const preheatUserContainer = deps.bridgeSecret
    ? makeEnginePreheatClient({
        transport: makeNodeHttpContainerTransport(),
        bridgeSecret: deps.bridgeSecret,
        resolvePreparation: makeEnginePreheatPreparation({
          resolveAllowedModel: async (uid, modelId) => {
            const active = (
              await getPool().query<{ status: string }>("SELECT status FROM users WHERE id = $1", [
                uid.toString(),
              ])
            ).rows[0];
            if (active?.status !== "active") return null;
            const cache = peekModelCatalogCache();
            if (!cache) return null;
            const snapshot = await cache.assertFresh();
            const canonical = snapshot.aliasToCanonical(modelId);
            const authz = await deps.loadUserModelAuthz(uid, snapshot.securityEpoch);
            if (!snapshot.canUseModel(scopeFromAuthz(uid, authz), canonical)) return null;
            const descriptor = snapshot.resolve(canonical);
            return descriptor
              ? { engine: descriptor.engine, canonicalModel: descriptor.canonicalModel }
              : null;
          },
          listGroups: (modelId) => listEnabledGroupsForModel({ modelId, provider: "codex" }),
          hasOfficial: (groupId) => hasActiveOfficialOAuthAccountInGroup(groupId, "codex"),
        }),
        resolveRunningEndpoint: async (uid) => {
          const r = await getPool().query<{
            id: string;
            bound_ip: string | null;
            port: number | null;
            host_name: string | null;
          }>(
            `SELECT ac.id::text AS id, host(ac.bound_ip) AS bound_ip, ac.port,
                    ch.name AS host_name
               FROM agent_containers ac
               LEFT JOIN compute_hosts ch ON ch.id = ac.host_uuid
              WHERE ac.user_id = $1 AND ac.state = 'active' AND ac.runtime_channel = $2
                AND ac.runtime_kind = 'docker'
                AND ac.bound_ip IS NOT NULL AND ac.port IS NOT NULL
              ORDER BY ac.updated_at DESC LIMIT 1`,
            [uid.toString(), getRuntimeChannel()],
          );
          const row = r.rows[0];
          if (!row || !row.bound_ip || row.port === null) return null;
          const isRemoteHost = row.host_name !== null && row.host_name !== "self";
          return {
            host: row.bound_ip,
            port: Number(row.port),
            containerId: Number(row.id),
            ...(isRemoteHost ? { tunnel: { kind: "remote-host" as const } } : {}),
          };
        },
      })
    : undefined;

  const authorizePreparation = async (uid: bigint): Promise<void> => {
    const row = (
      await getPool().query<{ status: string; role: string }>(
        "SELECT status, role FROM users WHERE id = $1",
        [uid.toString()],
      )
    ).rows[0];
    if (!row || row.status !== "active")
      throw new HttpError(403, "FORBIDDEN", "account is not active");
    if (row.role !== "admin" && (await isInMaintenance())) {
      throw new HttpError(503, "MAINTENANCE", "service is in maintenance");
    }
    const catalog = peekModelCatalogCache();
    const snapshot = catalog ? await catalog.assertFresh() : null;
    await deps.loadUserModelAuthz(uid, snapshot?.securityEpoch);
  };
  const preparationReady = ensureContainerEndpointReady
    ? makePreparationReady(ensureContainerEndpointReady)
    : undefined;
  const prepareContainer = preparationReady
    ? makeWorkspacePreparation({
        authorize: authorizePreparation,
        ensureReady: preparationReady,
        warn: (fields) => rootLogger.warn("workspace_prepare", fields),
      })
    : undefined;
  const prepareDraft = preparationReady
    ? makeDraftPreparation({
        enabled: () => deps.env.OC_ENGINE_PREHEAT === "1",
        authorize: authorizePreparation,
        ensureReady: preparationReady,
        prepareEngine:
          preheatUserContainer && deps.dispatchAdmissionBackend
            ? makeDraftEnginePreparation({
                loadWorkspaceMode: (uid, sessionId) =>
                  deps.dispatchAdmissionBackend!.getClientSessionWorkspaceMode(
                    sessionId,
                    "c:".concat(uid.toString()),
                  ),
                preheat: preheatUserContainer,
              })
            : async () => {},
        observe: (fields) => rootLogger.info("draft_prepare", fields),
      })
    : undefined;
  const prepareWorkspaceContainer = prepareContainer
    ? (uid: bigint, draft?: DraftPreparationHint) =>
        draft ? prepareDraft!(uid, draft) : prepareContainer(uid)
    : undefined;

  const prewarmContainer: ((uid: bigint) => void) | undefined = sharedEnsureRunning
    ? makePrewarmContainer(
        sharedEnsureRunning,
        rootLogger.child({ subsys: "v3/prewarm" }),
        ({ userId, correlation, latencyMs }) => {
          void recordProductFrictionEvent(
            {
              correlation,
              userId,
              surface: "container",
              stage: "prewarm",
              code: "PREWARM_FAILED",
              outcome: "failed",
              latencyMs,
            },
            getPool(),
          ).catch(() => {});
        },
      )
    : undefined;

  const mediaResolverDocker = deps.agentRuntimeDocker ?? deps.v3Deps?.docker;
  const userMediaResolver = mediaResolverDocker
    ? createUserMediaResolver({ pool: getPool(), docker: mediaResolverDocker })
    : undefined;

  const pushRemoteHostUpload = async (args: {
    hostUuid: string;
    remotePath: string;
    content: Buffer;
  }) => {
    const target = await resolveServiceableHostTarget(args.hostUuid);
    try {
      await nodeAgentPutFile(target, args.remotePath, args.content, 0o644, 1000, 1000);
    } finally {
      target.psk?.fill(0);
    }
  };

  let chatgptProxyServer: ChatGptProxyServer | undefined;
  let chatgptProxyHttp: ChatGptProxyHttpDeps | undefined;
  {
    const cgpEnv = readChatGptProxyEnv();
    if (cgpEnv.enabled && deps.runtimeChannel === "v5" && deps.v3Deps) {
      if (cgpEnv.configError || !cgpEnv.upstream) {
        rootLogger.error("[commercial] chatgpt proxy disabled: bad config", {
          error: cgpEnv.configError ?? "no upstream",
        });
      } else {
        try {
          const cgpLogger = rootLogger.child({ subsys: "commercial", module: "chatgptProxy" });
          const credentials = new ChatGptProxyCredentialStore(deps.v3Deps.pool);
          const pool = deps.v3Deps.pool;
          chatgptProxyServer = createChatGptProxyServer({
            publicHost: cgpEnv.publicHost,
            port: cgpEnv.port,
            tlsCertPath: cgpEnv.tlsCertPath,
            tlsKeyPath: cgpEnv.tlsKeyPath,
            upstream: cgpEnv.upstream,
            verifyCredential: (uid, secret) => credentials.verify(uid, secret),
            resolveUserRole: async (uid) => {
              const r = await pool.query<{ role: string }>(
                `SELECT role FROM users WHERE id = $1::bigint AND status = 'active' LIMIT 1`,
                [uid],
              );
              const role = r.rows[0]?.role;
              return role === "admin" || role === "user" ? role : null;
            },
            getEntitlement: async () => {
              const snap = await getChatGptProxyFlagSnapshot();
              return { assembled: snap.assembled, allowlist: snap.allowlist };
            },
            onTunnelUsed: (uid) => credentials.touchLastUsed(uid),
            logger: cgpLogger,
          });
          chatgptProxyHttp = {
            publicHost: cgpEnv.publicHost,
            port: cgpEnv.port,
            credentials,
            getFlags: () => getChatGptProxyFlagSnapshot(),
          };
          chatgptProxyServer.listenWithRetry();
          const cgpSrv = chatgptProxyServer;
          defaultCutoverInFlightTracker.setChatgptProxyTunnelsGetter(() => cgpSrv.activeTunnels());
          // eslint-disable-next-line no-console
          console.log(
            `[commercial] ChatGPT direct-connect proxy ENABLED on ${cgpEnv.publicHost}:${cgpEnv.port}`,
          );
        } catch (err) {
          chatgptProxyServer = undefined;
          chatgptProxyHttp = undefined;
          rootLogger.error("[commercial] chatgpt proxy disabled: init failed", {
            error: (err as Error)?.message ?? String(err),
          });
        }
      }
    }
  }

  return {
    sharedEnsureRunning,
    ensureContainerEndpointReady,
    preheatUserContainer,
    prepareWorkspaceContainer,
    prewarmContainer,
    userMediaResolver,
    pushRemoteHostUpload,
    chatgptProxyServer,
    chatgptProxyHttp,
  };
}

export function createOptionalDirectContainerPreview(deps: {
  env: NodeJS.ProcessEnv;
  containerPreviewTickets: ContainerPreviewTicketStore | undefined;
  modelAuthoritySigner: AuthoritySigner | undefined;
  containerPreviewBaseUrl: string | undefined;
  dockerEnsureRunning: ResolveContainerEndpoint;
  gatewayPort: number | undefined;
}): DirectContainerPreviewService | undefined {
  if (
    deps.env.OC_CONTAINER_DIRECT_PREVIEW_ENABLED !== "1" ||
    !deps.containerPreviewTickets ||
    !deps.modelAuthoritySigner ||
    !deps.containerPreviewBaseUrl
  ) {
    return undefined;
  }
  try {
    const svc = createDirectContainerPreviewService({
      signer: deps.modelAuthoritySigner,
      resolveContainerEndpoint: deps.dockerEnsureRunning,
      parentOrigin: deps.containerPreviewBaseUrl,
      tunnelOrigin: `http://127.0.0.1:${deps.gatewayPort}`,
      cloudflaredBinary: deps.env.OC_CONTAINER_PREVIEW_CLOUDFLARED_BIN,
      maxSessions: Number(deps.env.OC_CONTAINER_PREVIEW_MAX_SESSIONS),
      warmTunnels: Number(deps.env.OC_CONTAINER_PREVIEW_WARM_TUNNELS || 2),
      logger: rootLogger.child({ subsys: "commercial", module: "directContainerPreview" }),
    });
    // eslint-disable-next-line no-console
    console.log("[commercial] V5 native iframe preview ENABLED (temporary Quick Tunnel beta)");
    return svc;
  } catch (err) {
    rootLogger.error("[commercial] native iframe preview disabled", {
      error: (err as Error)?.message ?? String(err),
    });
    return undefined;
  }
}

export function createPreviewAndLiveBrowserTickets(deps: {
  runtimeChannel: string;
  modelAuthoritySigner: AuthoritySigner | undefined;
  v3Deps: V3SupervisorDeps | undefined;
  baseUrl: string | undefined;
}): {
  containerPreviewTickets: ContainerPreviewTicketStore | undefined;
  liveBrowserTickets: LiveBrowserTicketStore | undefined;
} {
  const ready =
    deps.runtimeChannel === "v5" &&
    Boolean(deps.modelAuthoritySigner) &&
    Boolean(deps.v3Deps) &&
    Boolean(deps.baseUrl);
  return {
    containerPreviewTickets: ready ? new ContainerPreviewTicketStore() : undefined,
    liveBrowserTickets: ready ? new LiveBrowserTicketStore() : undefined,
  };
}

export function createOptionalContainerPreviewBridge(deps: {
  env: NodeJS.ProcessEnv;
  containerPreviewTickets: ContainerPreviewTicketStore | undefined;
  liveBrowserTickets?: LiveBrowserTicketStore | undefined;
  modelAuthoritySigner: AuthoritySigner | undefined;
  containerPreviewBaseUrl: string | undefined;
  dockerEnsureRunning: ResolveContainerEndpoint;
}): ContainerPreviewBridgeHandler | undefined {
  if (!deps.modelAuthoritySigner || !deps.containerPreviewBaseUrl) {
    return undefined;
  }
  let previewBridge: ContainerPreviewBridgeHandler | undefined;
  if (deps.containerPreviewTickets) {
    try {
      previewBridge = createContainerPreviewBridge({
        tickets: deps.containerPreviewTickets,
        signer: deps.modelAuthoritySigner,
        resolveContainerEndpoint: deps.dockerEnsureRunning,
        allowedOrigin: deps.containerPreviewBaseUrl,
        maxGlobalSessions: Number(deps.env.OC_CONTAINER_PREVIEW_MAX_SESSIONS),
        createTunnelContainerSocket: (tunnel, port, assertion, connectionTraceId, signal) =>
          createTunnelContainerSocket(tunnel.nodeAgent, tunnel.containerInternalId, port, signal, {
            maxFrameBytes: CONTAINER_PREVIEW_MAX_FRAME_BYTES,
            connectionTraceId,
            containerWsPath: "/ws/container-preview",
            previewAssertion: assertion,
          }),
        logger: rootLogger.child({ subsys: "commercial", module: "containerPreviewBridge" }),
      });
      // eslint-disable-next-line no-console
      console.log("[commercial] V5 container web preview ENABLED");
    } catch (err) {
      rootLogger.error("[commercial] container web preview disabled", {
        error: (err as Error)?.message ?? String(err),
      });
    }
  }
  let liveBrowserBridge: LiveBrowserBridgeHandler | undefined;
  if (deps.liveBrowserTickets) {
    try {
      liveBrowserBridge = createLiveBrowserBridge({
        tickets: deps.liveBrowserTickets,
        signer: deps.modelAuthoritySigner,
        resolveContainerEndpoint: deps.dockerEnsureRunning,
        allowedOrigin: deps.containerPreviewBaseUrl,
        maxGlobalSessions: Number(deps.env.OC_LIVE_BROWSER_MAX_SESSIONS || 8),
        createTunnelContainerSocket: (tunnel, port, assertion, connectionTraceId, signal) =>
          createTunnelContainerSocket(tunnel.nodeAgent, tunnel.containerInternalId, port, signal, {
            maxFrameBytes: LIVE_BROWSER_MAX_FRAME_BYTES,
            connectionTraceId,
            containerWsPath: "/ws/live-browser",
            liveBrowserAssertion: assertion,
          }),
        logger: rootLogger.child({ subsys: "commercial", module: "liveBrowserBridge" }),
      });
      // eslint-disable-next-line no-console
      console.log("[commercial] V5 live cloud browser WS stream ENABLED");
    } catch (err) {
      rootLogger.error("[commercial] live cloud browser WS stream disabled", {
        error: (err as Error)?.message ?? String(err),
      });
    }
  }
  if (!previewBridge && !liveBrowserBridge) return undefined;
  return {
    handleUpgrade(req, socket, head): boolean {
      if (previewBridge?.handleUpgrade(req, socket, head)) return true;
      if (liveBrowserBridge?.handleUpgrade(req, socket, head)) return true;
      return false;
    },
    async shutdown(): Promise<void> {
      await Promise.allSettled([
        previewBridge?.shutdown(),
        liveBrowserBridge?.shutdown(),
      ]);
    },
    activeCount(): number {
      return (previewBridge?.activeCount() ?? 0) + (liveBrowserBridge?.activeCount() ?? 0);
    },
  };
}

export async function bootstrapMailerBridgeAndAuthority(deps: {
  env: NodeJS.ProcessEnv;
}) {
  const resendKey = deps.env.RESEND_API_KEY?.trim();
  const mailFrom = deps.env.MAIL_FROM?.trim() || "auth@claudeai.chat";
  const mailer = resendKey ? createResendMailer({ apiKey: resendKey, from: mailFrom }) : stubMailer;
  if (resendKey) {
    console.log(`[commercial] mailer = resend (from=${mailFrom})`);
  } else {
    console.log("[commercial] mailer = stub (RESEND_API_KEY 未设置, 验证邮件只打日志)");
  }

  let bridgeSecret: string | undefined;
  try {
    bridgeSecret = loadOrCreateBridgeSecret();
    // eslint-disable-next-line no-console
    console.log("[commercial] v3 bridge secret loaded", { path: DEFAULT_BRIDGE_SECRET_PATH });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      "[commercial] v3 bridge secret load/create failed; file proxy will be DISABLED",
      { path: DEFAULT_BRIDGE_SECRET_PATH, error: (err as Error)?.message ?? String(err) },
    );
    bridgeSecret = undefined;
  }

  let mediaSignKey: Buffer | undefined;
  let wechatLiveLinkKey: Buffer | undefined;
  if (bridgeSecret) {
    try {
      mediaSignKey = deriveMediaSignKey(bridgeSecret);
      // eslint-disable-next-line no-console
      console.log("[commercial] v3 media signing key derived");
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[commercial] media sign key derivation failed; signed URL DISABLED", {
        error: (err as Error)?.message ?? String(err),
      });
      mediaSignKey = undefined;
    }
    try {
      wechatLiveLinkKey = deriveWechatLiveLinkKey(bridgeSecret);
      // eslint-disable-next-line no-console
      console.log("[commercial] v3 wechat live link key derived");
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[commercial] wechat live key derivation failed; live links DISABLED", {
        error: (err as Error)?.message ?? String(err),
      });
      wechatLiveLinkKey = undefined;
    }
  }

  let thumbnailCache: ThumbnailDiskCache | undefined;
  if (mediaSignKey) {
    try {
      const home = deps.env.OPENCLAUDE_HOME ?? path.join(homedir(), ".openclaude");
      const cache = new ThumbnailDiskCache(path.join(home, "media-thumb-cache"));
      await cache.init();
      thumbnailCache = cache;
      // eslint-disable-next-line no-console
      console.log("[commercial] media thumbnail cache ready (startup-cleared)");
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[commercial] thumbnail cache init failed; thumbnails DISABLED", {
        error: (err as Error)?.message ?? String(err),
      });
      thumbnailCache = undefined;
    }
  }

  const modelAuthorityFlag = deps.env.OC_MODEL_AUTHORITY === "1";
  const modelAuthorityProvisionRequired =
    modelAuthorityFlag && deps.env.OC_MODEL_AUTHORITY_PROVISION_REQUIRED !== "0";
  let modelAuthoritySigner: AuthoritySigner | undefined;
  let modelCatalogCache: ModelCatalogCache | undefined;
  if (modelAuthorityFlag) {
    await assertModelCatalogAdminPoolConfigured();
    modelAuthoritySigner = AuthoritySigner.loadOrCreate();
    modelCatalogCache = await getModelCatalogCache();
    // eslint-disable-next-line no-console
    console.log("[commercial] model authority ENABLED", {
      activeKeyId: modelAuthoritySigner.activeKeyId,
      keyIds: modelAuthoritySigner.keyIds.length,
      securityEpoch: modelCatalogCache.current().securityEpoch.toString(),
      executionRevision: modelCatalogCache.current().executionRevision.slice(0, 12),
    });
  }

  let artifactBlobStore: LocalCasArtifactBlobStore | undefined;
  try {
    const home = deps.env.OPENCLAUDE_HOME ?? path.join(homedir(), ".openclaude");
    const created = createMasterArtifactBlobStore({
      openClaudeHome: home,
      casRootDir: deps.env.OC_ARTIFACT_CAS_ROOT,
      pgPool: getPool(),
      bridgeSecret,
    });
    artifactBlobStore = created.store;
    // eslint-disable-next-line no-console
    console.log("[commercial] artifact CAS blob store ready", {
      rootDir: created.rootDir,
      ticketSigning: Boolean(bridgeSecret),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[commercial] artifact CAS blob store init failed; blob RPC DISABLED", {
      error: (err as Error)?.message ?? String(err),
    });
    artifactBlobStore = undefined;
  }

  return {
    mailer,
    bridgeSecret,
    mediaSignKey,
    wechatLiveLinkKey,
    thumbnailCache,
    artifactBlobStore,
    modelAuthorityProvisionRequired,
    modelAuthoritySigner,
    modelCatalogCache,
  };
}
