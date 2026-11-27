/**
 * UserChatBridge and Codex container-binding assembly for @openclaude/commercial.
 *
 * Extracted from packages/commercial/src/index.ts (OCV5-830).
 */
import { normalizeTurnErrorCode } from "@openclaude/protocol";
import {
  appendServerAuthoredMessage,
  getEngineContextMessages,
  hasCompletedClientTurn,
} from "@openclaude/storage";
import {
  commitCodexRebindInTx,
  fetchSnapshotAndWriteContainerAuth,
  type WriteAuthDeps,
} from "../account-pool/codexLazyMigrate.js";
import {
  expireCodexRouteContext,
  expireGrokRouteContext,
  expireGrokRouteContextByLease,
} from "../account-pool/groups.js";
import { activePoolWhere } from "../account-pool/poolCandidates.js";
import {
  ContainerStaleBindingError,
  pickCodexAccountForBindingInTx,
  type AccountScheduler,
} from "../account-pool/scheduler.js";
import {
  createSelfhostCrossPoolFallbackSelector,
  createSelfhostForcedLocalMigrationResolver,
  createSelfhostReturnToRemoteGrantResolver,
  resolveSelfhostLogicalModelPoolTarget,
  selectPeekBindingCandidate,
} from "../account-pool/remotePool/index.js";
import {
  observeWsBridgeBuffered,
  observeWsBridgeSessionDuration,
  observeWsBridgeTtft,
} from "../admin/metrics.js";
import { selectMasterCc5Backend, type createMasterCc5Runtime } from "../agent-sandbox/cc5Runtime.js";
import { V3_AGENT_GID, V3_AGENT_UID } from "../agent-sandbox/constants.js";
import {
  DEFAULT_PLATFORM_ROOT,
  markV3ContainerActivity,
  type V3SupervisorDeps,
} from "../agent-sandbox/index.js";
import { RUNTIME_BUNDLE_REV_LABEL_KEY } from "../agent-sandbox/platformBundle.js";
import {
  DEFAULT_V3_CODEX_CONTAINER_DIR,
  V3_CONTAINER_PORT,
  getV3ContainerStatus,
  stopAndRemoveV3Container,
} from "../agent-sandbox/v3supervisor.js";
import type { makeLoadUserModelAuthz } from "../auth/userModelAuthz.js";
import type { ModelCatalogCache } from "../billing/modelCatalog.js";
import type { makeModelSwitchCostService } from "../billing/modelSwitchCostTarget.js";
import type { PreCheckRedis } from "../billing/preCheck.js";
import type { PricingCache } from "../billing/pricing.js";
import { expireZcodeRelayRoute, mintZcodeRelayRoute } from "../billing/zcodeRouteContext.js";
import type { CommercialConfig } from "../config.js";
import { getPool } from "../db/index.js";
import type { LogicalModelPoolBinding } from "@openclaude/protocol";
import {
  PgLogicalModelBindingStore,
  PgSessionAuthorityStateStore,
  type PgTransactionPool,
} from "../db/threeLayerStateStore.js";
import { persistGatewayLiveFrame } from "../db/liveTurnFrames.js";
import type {
  AutomaticRecoveryDecision,
  DispatchAdmissionBackend,
} from "../db/pgSessionsBackend.js";
import { tx } from "../db/queries.js";
import type { createSlotRelayClient } from "../deploy/slotRelay.js";
import type { assertFlavorIdentity } from "../flavor/assertFlavor.js";
import type { GoalStateService } from "../goal/goalStateService.js";
import { createAntigravityBridgeHooks } from "../http/antigravityRouteRuntime.js";
import { isPromptQueueV1Enabled } from "../http/internalPromptQueue.js";
import { rootLogger } from "../logging/logger.js";
import { recordProductFrictionEvent } from "../productFriction/events.js";
import { getRuntimeChannel } from "../runtimeChannel.js";
import type { assembleSystemActions } from "../system-assistant/assemble.js";
import { MASTER_USER_PREFIX } from "../wechat/userIds.js";
import type { AuthoritySigner } from "../ws/authoritySigner.js";
import { resolveContainerLinkEndpoint } from "../ws/containerLinkEndpoint.js";
import { createFrontendBuildProbe } from "../ws/frontendBuild.js";
import { recoveryDecisionFrame } from "../ws/recoveryPresentation.js";
import { createUnattestedContainerRecycler } from "../ws/recycleUnattestedContainer.js";
import { createTunnelContainerSocket } from "../ws/tunnelContainerSocket.js";
import {
  DEFAULT_MAX_FRAME_BYTES,
  createUserChatBridge,
  type BridgeMetricSink,
  type CodexBindingHandle,
  type ResolveContainerEndpoint,
  type UserChatBridgeDeps,
  type UserChatBridgeHandler,
} from "../ws/userChatBridge.js";

/**
 * Selfhost V5 implicit cross-pool routing hooks (N01/B06/B01):
 * wires ONLY the authoritative PG `pool` (implicit `PgLogicalModelBindingStore`,
 * `PgSessionAuthorityStateStore`, and PG pending-billing query) plus `modelCatalogCache`.
 */
export function buildSelfhostCrossPoolBridgeHooks(input: {
  readonly isSelfhostV5: boolean;
  readonly pool: PgTransactionPool;
  readonly modelCatalogCache: Pick<ModelCatalogCache, "assertFresh"> | undefined;
}): Pick<
  UserChatBridgeDeps,
  | "crossPoolFallbackSelector"
  | "returnToRemoteGrantResolver"
  | "forcedLocalMigrationResolver"
  | "recordRemotePlacement"
  | "markPlacementMigrationInstalled"
  | "peekLogicalModelPoolTarget"
  | "resolveLogicalModelPoolTarget"
> {
  if (!input.isSelfhostV5 || !input.modelCatalogCache) return {};
  const authorityStore = new PgSessionAuthorityStateStore(input.pool);
  const bindingStore = new PgLogicalModelBindingStore(input.pool);
  // W1: Store ONLY global PG priority-sorted bindings; never mutate global order with per-user authz.
  const globalBindingsByLogical = new Map<string, readonly LogicalModelPoolBinding[]>();
  const sessionPoolHints = new Map<string, { poolKind: "local_pool" | "remote_pool"; updatedAtMs: number }>();
  const PEEK_TTL_MS = 5_000;
  const SESSION_HINT_MAX = 2_048;
  let globalCacheUpdatedAtMs = 0;
  let lastListRefreshAtMs = 0;
  let listRefreshInFlight: Promise<void> | null = null;

  const setSessionPoolHint = (uid: number, sessionKey: string, poolKind: "local_pool" | "remote_pool") => {
    const key = `${uid}:${sessionKey}`;
    if (sessionPoolHints.size >= SESSION_HINT_MAX && !sessionPoolHints.has(key)) {
      const oldest = sessionPoolHints.keys().next().value;
      if (oldest !== undefined) sessionPoolHints.delete(oldest);
    }
    sessionPoolHints.set(key, { poolKind, updatedAtMs: Date.now() });
  };

  const refreshGlobalPeekCache = (): void => {
    const now = Date.now();
    if (listRefreshInFlight || now - lastListRefreshAtMs < PEEK_TTL_MS) return;
    lastListRefreshAtMs = now;
    listRefreshInFlight = bindingStore
      .listAllEnabledBindings()
      .then((rows) => {
        const grouped = new Map<string, LogicalModelPoolBinding[]>();
        for (const row of rows) {
          const list = grouped.get(row.logicalModelId) ?? [];
          list.push(row);
          grouped.set(row.logicalModelId, list);
        }
        globalBindingsByLogical.clear();
        for (const [logicalModelId, list] of grouped) {
          list.sort((a, b) => a.priority - b.priority || a.driverId.localeCompare(b.driverId));
          globalBindingsByLogical.set(logicalModelId, Object.freeze(list));
        }
        globalCacheUpdatedAtMs = Date.now();
      })
      .catch(() => {})
      .finally(() => {
        listRefreshInFlight = null;
      });
  };
  refreshGlobalPeekCache();

  return {
    crossPoolFallbackSelector: createSelfhostCrossPoolFallbackSelector({
      pool: input.pool,
      catalogCache: input.modelCatalogCache,
      selfhost: input.isSelfhostV5,
    }),
    returnToRemoteGrantResolver: createSelfhostReturnToRemoteGrantResolver({
      pool: input.pool,
      selfhost: input.isSelfhostV5,
    }),
    forcedLocalMigrationResolver: createSelfhostForcedLocalMigrationResolver({
      pool: input.pool,
      selfhost: input.isSelfhostV5,
    }),
    recordRemotePlacement: async (args) => {
      await input.pool.query(
        `INSERT INTO session_engine_pointers (
           user_id, session_key, placement_epoch, pool_kind, engine,
           operation_id, profile_id, migration_state
         ) VALUES ($1, $2, 1, 'remote_pool', $3, $4, $5, 'active')
         ON CONFLICT (user_id, session_key) DO NOTHING`,
        [args.uid, args.sessionKey, args.engine, args.operationId, args.profileId ?? null],
      );
      setSessionPoolHint(args.uid, args.sessionKey, "remote_pool");
    },
    markPlacementMigrationInstalled: (args) =>
      authorityStore.markPlacementMigrationInstalled(
        args.uid,
        args.sessionKey,
        args.placementEpoch,
        args.migrationId,
        {
          ...(args.checkpointGeneration !== undefined
            ? { checkpointGeneration: args.checkpointGeneration }
            : {}),
          ...(args.consumedByTurnKey !== undefined
            ? { consumedByTurnKey: args.consumedByTurnKey }
            : {}),
          ...(args.requireWarmCheckpointMatch !== undefined
            ? { requireWarmCheckpointMatch: args.requireWarmCheckpointMatch }
            : {}),
        },
      ),
    peekLogicalModelPoolTarget: (rawModelId, catalogSnapshot, isModelAllowed, uid, sessionKey) => {
      refreshGlobalPeekCache();
      if (globalCacheUpdatedAtMs === 0 || Date.now() - globalCacheUpdatedAtMs > PEEK_TTL_MS * 6) {
        return null;
      }
      const hint =
        typeof uid === "number" && typeof sessionKey === "string" && sessionKey.length > 0
          ? sessionPoolHints.get(`${uid}:${sessionKey}`)?.poolKind ?? null
          : null;
      return selectPeekBindingCandidate({
        rawModelId,
        cachedBindingsByLogical: globalBindingsByLogical,
        ...(catalogSnapshot ? { catalogSnapshot } : {}),
        ...(isModelAllowed ? { isModelAllowed } : {}),
        ...(hint ? { activeSessionPoolKind: hint } : {}),
      });
    },
    resolveLogicalModelPoolTarget: async (args) => {
      let activeSessionPoolKind: "local_pool" | "remote_pool" | null = null;
      if (
        typeof args.uid === "number" &&
        Number.isSafeInteger(args.uid) &&
        args.uid > 0 &&
        typeof args.sessionKey === "string" &&
        args.sessionKey.trim().length > 0
      ) {
        try {
          const ptr = await authorityStore.getEnginePointer(args.uid, args.sessionKey);
          if (ptr?.poolKind === "remote_pool") {
            activeSessionPoolKind = "remote_pool";
          } else if (ptr?.poolKind === "local_container") {
            activeSessionPoolKind = "local_pool";
          }
        } catch {
          return { ok: false as const, code: "MODEL_POOL_BINDING_READ_FAILED" };
        }
      }
      const res = await resolveSelfhostLogicalModelPoolTarget({
        rawModelId: args.rawModelId,
        bindingStore,
        catalogSnapshot: args.catalogSnapshot,
        ...(args.isModelAllowed ? { isModelAllowed: args.isModelAllowed } : {}),
        ...(activeSessionPoolKind ? { activeSessionPoolKind } : {}),
      });
      if (
        res.ok &&
        typeof args.uid === "number" &&
        typeof args.sessionKey === "string" &&
        args.sessionKey.trim().length > 0 &&
        (res.poolKind === "local_pool" || res.poolKind === "remote_pool")
      ) {
        setSessionPoolHint(args.uid, args.sessionKey, res.poolKind);
      }
      return res;
    },
  };
}

export function createCodexBindingHandle(deps: {
  env: NodeJS.ProcessEnv;
  v3Deps: V3SupervisorDeps | undefined;
  scheduler: AccountScheduler;
}): CodexBindingHandle | undefined {
  const v3DepsForCodex = deps.v3Deps;
  if (!v3DepsForCodex) return undefined;
  return {
    async acquire(containerId: number, groupId?: string | null) {
      type AcquireResult =
        | { kind: "active"; account_id: bigint }
        | { kind: "stale"; containerInternalId: string | null; hostUuid: string | null }
        | null;
      const desiredGroupId = groupId ?? null;
      const result: AcquireResult = await tx<AcquireResult>(async (client) => {
        const lookup = await client.query<{
          account_id: string | null;
          account_status: string | null;
          account_group_id: string | null;
          state: string;
          container_internal_id: string | null;
          host_uuid: string | null;
          age_seconds: string;
        }>(
          `SELECT ac.codex_account_id::text AS account_id,
                  ca.status AS account_status,
                  ca.group_id::text AS account_group_id,
                  ac.state AS state,
                  ac.container_internal_id AS container_internal_id,
                  ac.host_uuid AS host_uuid,
                  EXTRACT(EPOCH FROM (NOW() - ac.created_at))::text AS age_seconds
           FROM agent_containers ac
           LEFT JOIN claude_accounts ca ON ca.id = ac.codex_account_id
           WHERE ac.id = $1 AND ac.runtime_channel = $2 AND ac.runtime_kind = 'docker'
           FOR UPDATE OF ac`,
          [containerId, getRuntimeChannel()],
        );
        if (lookup.rows.length === 0) return null;
        const row = lookup.rows[0];
        if (row.state !== "active") return null;
        if (row.account_id === null) {
          const poolPredicate = activePoolWhere({ provider: "codex", groupId: desiredGroupId });
          const poolCount = await client.query<{ cnt: string }>(
            `SELECT count(*)::text AS cnt
               FROM claude_accounts
              WHERE ${poolPredicate.clauses.join(" AND ")}`,
            poolPredicate.params,
          );
          if (Number(poolCount.rows[0]?.cnt ?? "0") === 0) return null;
          const ageSec = Number(row.age_seconds ?? "0");
          if (Number.isFinite(ageSec) && ageSec < 60) {
            // eslint-disable-next-line no-console
            console.warn(
              "[codex acquire] skip stale recycle: row too young (likely upstream codex bind failed last provision)",
              { containerId, ageSec, hostUuid: row.host_uuid },
            );
            return null;
          }
          const upd = await client.query(
            `UPDATE agent_containers
                SET state = 'vanished', updated_at = NOW()
              WHERE id = $1 AND state = 'active' AND runtime_channel = $2
                AND runtime_kind = 'docker'`,
            [containerId, getRuntimeChannel()],
          );
          if ((upd.rowCount ?? 0) === 0) {
            throw new Error(
              `codex stale recycle: UPDATE state=vanished rowCount=0 for container ${containerId} (invariant: FOR UPDATE row was active)`,
            );
          }
          return {
            kind: "stale",
            containerInternalId: row.container_internal_id,
            hostUuid: row.host_uuid,
          };
        }
        if (
          row.account_status === "active" &&
          (desiredGroupId === null || row.account_group_id === desiredGroupId)
        ) {
          return { kind: "active", account_id: BigInt(row.account_id) };
        }
        const picked = await pickCodexAccountForBindingInTx(client, String(containerId), {
          groupId: desiredGroupId,
        });
        if (!picked) {
          throw new Error(`codex pool empty during lazy migrate for container ${containerId}`);
        }
        const codexContainerDir =
          deps.env.OC_V3_CODEX_CONTAINER_DIR?.trim() || DEFAULT_V3_CODEX_CONTAINER_DIR;
        const writeAuthDeps: WriteAuthDeps = {
          selfHostId: v3DepsForCodex.selfHostId ?? null,
          containerUid: V3_AGENT_UID,
          containerGid: V3_AGENT_GID,
          codexContainerDir,
          putRemoteCodexAuth: v3DepsForCodex.putRemoteCodexAuth,
        };
        await fetchSnapshotAndWriteContainerAuth({
          accountId: picked.account_id,
          containerId,
          hostUuidUnderLock: row.host_uuid,
          deps: writeAuthDeps,
          client,
        });
        await commitCodexRebindInTx(client, containerId, picked.account_id);
        return { kind: "active", account_id: picked.account_id };
      });
      if (result === null) return null;
      if (result.kind === "stale") {
        try {
          await stopAndRemoveV3Container(v3DepsForCodex, {
            id: containerId,
            container_internal_id: result.containerInternalId,
            host_uuid: result.hostUuid,
          });
        } catch (err) {
          rootLogger.warn(
            "[commercial] codex stale recycle: stopAndRemoveV3Container failed (continuing — ensureRunning will retry on next message)",
            {
              containerId,
              err: (err as Error)?.message ?? String(err),
            },
          );
        }
        throw new ContainerStaleBindingError(containerId);
      }
      const slotId = deps.scheduler.acquireCodexSlot(result.account_id);
      return { account_id: result.account_id, slotId };
    },
    release(account_id: bigint, slotId: string): void {
      try {
        deps.scheduler.releaseCodexSlot(account_id, slotId);
      } catch {
        /* */
      }
    },
    renew(account_id: bigint, slotId: string): boolean {
      try {
        return deps.scheduler.renewCodexSlot(account_id, slotId);
      } catch {
        return false;
      }
    },
  };
}

function isSelfhostV5Flavor(flavorIdentity: ReturnType<typeof assertFlavorIdentity>): boolean {
  return (
    getRuntimeChannel() === "v5" &&
    flavorIdentity.status === "ok" &&
    flavorIdentity.flavor === "selfhost"
  );
}

function bindSelfhostToolBrokerOpener(
  isSelfhostV5: boolean,
  v3Deps: V3SupervisorDeps | undefined,
  userChatBridge: UserChatBridgeHandler,
): void {
  if (!isSelfhostV5 || !v3Deps?.containerService) return;
  const brokerOpener = userChatBridge.createBrokerFrameLinkOpener?.();
  if (brokerOpener) v3Deps.containerService.bindBrokerFrameLinkOpener?.(brokerOpener);
}

export function createCommercialUserChatBridge(deps: {
  env: NodeJS.ProcessEnv;
  cfg: CommercialConfig;
  runtimeChannel: string;
  dualMasterEnabled: boolean;
  flavorIdentity: ReturnType<typeof assertFlavorIdentity>;
  v3Deps: V3SupervisorDeps | undefined;
  cc5Runtime: ReturnType<typeof createMasterCc5Runtime>;
  containerLinkOn: boolean;
  modelSwitchCost: ReturnType<typeof makeModelSwitchCostService>;
  jwtSecret: string | Uint8Array;
  systemActions: ReturnType<typeof assembleSystemActions> | undefined;
  resolveContainerEndpoint: ResolveContainerEndpoint;
  modelAuthoritySigner: AuthoritySigner | undefined;
  modelCatalogCache: ModelCatalogCache | undefined;
  webDistDir: string | undefined;
  loadUserModelAuthz: ReturnType<typeof makeLoadUserModelAuthz>;
  pricing: PricingCache;
  goalStateService: GoalStateService;
  dispatchAdmissionBackend: DispatchAdmissionBackend | undefined;
  codexBinding: CodexBindingHandle | undefined;
  createCommercialCodexRoute: Parameters<typeof createUserChatBridge>[0]["createCodexRoute"];
  scheduler: AccountScheduler;
  preCheckRedis: PreCheckRedis;
  selfHostUuid: string | undefined;
  appendCostCreditsForUser: Parameters<typeof createUserChatBridge>[0]["appendCostCredits"];
  slotRelayClient: ReturnType<typeof createSlotRelayClient>;
}): {
  userChatBridge: UserChatBridgeHandler;
  recoveryDecisionBroadcast: (
    userId: string,
    sessionId: string,
    verdict: AutomaticRecoveryDecision,
  ) => void;
} {
  const bridgeMetrics: BridgeMetricSink = {
    onBufferedBytes: (_uid, side, bytes) => observeWsBridgeBuffered(side, bytes),
    onClose: (stats) => observeWsBridgeSessionDuration(stats.cause, stats.durationMs / 1000),
    onTtft: (_uid, kind, seconds) => observeWsBridgeTtft(kind, seconds),
  };
  const markActivityForBridge = deps.v3Deps
    ? (cid: number) => {
        void markV3ContainerActivity(deps.v3Deps!, cid);
      }
    : undefined;
  const recycleUnattestedContainer = createUnattestedContainerRecycler(() => deps.v3Deps);

  const isSelfhostV5 = isSelfhostV5Flavor(deps.flavorIdentity);

  const userChatBridge: UserChatBridgeHandler = createUserChatBridge({
    cc5BackendSelector: (input) =>
      selectMasterCc5Backend(deps.cc5Runtime, input, isSelfhostV5, deps.env),
    ...buildSelfhostCrossPoolBridgeHooks({
      isSelfhostV5,
      pool: getPool(),
      modelCatalogCache: deps.modelCatalogCache,
    }),
    containerLinkEnabled: deps.containerLinkOn,
    containerLinkToolBrokerEnabled: isSelfhostV5,
    resolveContainerLinkEndpoint: async (uid, cid) => {
      const ep = await resolveContainerLinkEndpoint(getPool(), deps.runtimeChannel, uid, cid);
      if (!ep || ep === "pending" || ep.desktop || ep.bundleRev || !deps.v3Deps) return ep;
      const status = await getV3ContainerStatus(deps.v3Deps, Number(uid)).catch(() => null);
      const rev =
        status?.containerId === cid ? status.labels?.[RUNTIME_BUNDLE_REV_LABEL_KEY] : undefined;
      return typeof rev === "string" && rev !== "" ? { ...ep, bundleRev: rev } : ep;
    },
    containerLinkRecovery: { channel: deps.runtimeChannel },
    deferBackgroundActivation: deps.dualMasterEnabled,
    modelSwitchCost: deps.modelSwitchCost,
    jwtSecret: deps.jwtSecret,
    issueSystemHelpBootstrap: deps.systemActions
      ? (scope) => deps.systemActions!.runtime.issueBootstrap(scope)
      : undefined,
    promptQueueEnabled: isPromptQueueV1Enabled(),
    resolveContainerEndpoint: deps.resolveContainerEndpoint,
    ...(deps.modelAuthoritySigner && deps.modelCatalogCache
      ? {
          modelAuthority: {
            signer: deps.modelAuthoritySigner,
            catalog: deps.modelCatalogCache,
            recycleContainer: recycleUnattestedContainer,
          },
        }
      : {}),
    metrics: bridgeMetrics,
    markContainerActivity: markActivityForBridge,
    ...(Number(deps.env.OC_WS_MAX_PER_USER) > 0
      ? { maxPerUser: Number(deps.env.OC_WS_MAX_PER_USER) }
      : {}),
    getFrontendBuildId: deps.webDistDir ? createFrontendBuildProbe(deps.webDistDir) : undefined,
    createTunnelContainerSocket: (tunnel, port, signal, connectionTraceId) =>
      createTunnelContainerSocket(tunnel.nodeAgent, tunnel.containerInternalId, port, signal, {
        maxFrameBytes: DEFAULT_MAX_FRAME_BYTES,
        connectionTraceId,
      }),
    logger: rootLogger.child({ subsys: "commercial", module: "userChatBridge" }),
    loadAllowedModelChecker: async (uid, requiredEpoch) => {
      if (deps.modelCatalogCache) {
        const snapshot = await deps.modelCatalogCache.assertFresh();
        if (requiredEpoch !== undefined && snapshot.securityEpoch < requiredEpoch) {
          throw new Error(
            `catalog snapshot epoch ${snapshot.securityEpoch} < required ${requiredEpoch}`,
          );
        }
        const authz = await deps.loadUserModelAuthz(uid, snapshot.securityEpoch);
        return (modelId: string) =>
          snapshot.canUseModel(
            {
              uid: uid.toString(),
              role: authz.role,
              grantedModelIds: authz.grantedModelIds,
              deniedModelIds: authz.deniedModelIds,
              userPlanTier: authz.userPlanTier ?? null,
              orgPlanCode: authz.orgPlanCode ?? null,
            },
            modelId,
          );
      }
      const { canUseModel } = await import("../billing/authzModels.js");
      const authz = await deps.loadUserModelAuthz(uid);
      return (modelId: string) => canUseModel({ pricing: deps.pricing }, { uid, ...authz, modelId });
    },
    loadAgentModelResolver: async (uid, opts) => {
      const { loadAgentModelResolverForUser } = await import("../ws/agentModelAuthority.js");
      return loadAgentModelResolverForUser(uid, {
        bundleRev: opts.bundleRev ?? null,
        flavor: deps.flavorIdentity.status === "ok" ? deps.flavorIdentity.flavor : undefined,
        flavorIdentity: deps.flavorIdentity,
        platformRoot: deps.cfg.OC_PLATFORM_ROOT ?? DEFAULT_PLATFORM_ROOT,
      });
    },
    loadMasterSessionMessages: async (uid, sessionId, context) =>
      getEngineContextMessages(sessionId, MASTER_USER_PREFIX + uid.toString(), context),
    hasCompletedClientTurn: async (uid, sessionId, clientMessageId) =>
      hasCompletedClientTurn(sessionId, MASTER_USER_PREFIX + uid.toString(), clientMessageId),
    loadGoalState: (uid, sessionId) => deps.goalStateService.get(uid, sessionId),
    updateGoalEngineMetrics: (args) => deps.goalStateService.updateEngineMetrics(args),
    persistMasterUserMessage: async (uid, sessionId, message) =>
      appendServerAuthoredMessage(sessionId, MASTER_USER_PREFIX + uid.toString(), message),
    persistOutboundFrame: (input) => persistGatewayLiveFrame(getPool(), input),
    admitUserTurn: deps.dispatchAdmissionBackend
      ? (input) => deps.dispatchAdmissionBackend!.admitUserTurn(input)
      : undefined,
    reconcileAutomaticRecoveryJobs: deps.dispatchAdmissionBackend
      ? (uid, limit) => deps.dispatchAdmissionBackend!.reconcileAutomaticRecoveryJobs(uid, limit)
      : undefined,
    loadSessionWorkspaceMode: deps.dispatchAdmissionBackend
      ? (uid, sessionId) =>
          deps.dispatchAdmissionBackend!.getClientSessionWorkspaceMode(
            sessionId,
            MASTER_USER_PREFIX + uid.toString(),
          )
      : undefined,
    codexBinding: deps.codexBinding,
    createCodexRoute: deps.createCommercialCodexRoute,
    expireCodexRoute: async (token) => {
      await Promise.all([expireCodexRouteContext(token), expireGrokRouteContext(token)]);
    },
    mintZcodeRoute: ({ containerId, userId, requestId, modelId }) =>
      mintZcodeRelayRoute({
        containerId,
        userId,
        requestId,
        modelId,
        relayPort: V3_CONTAINER_PORT,
      }),
    expireZcodeRoute: async (token) => {
      await expireZcodeRelayRoute(token);
    },
    ...createAntigravityBridgeHooks({
      relayPort: V3_CONTAINER_PORT,
      clientSecret: deps.cfg.OC_ANTIGRAVITY_OAUTH_CLIENT_SECRET ?? "",
    }),
    releaseGrokRouteLease: async (accountId, slotId) => {
      await expireGrokRouteContextByLease(accountId, slotId);
      deps.scheduler.releaseCodexSlot(accountId, slotId);
    },
    pgPool: getPool(),
    preCheckRedis: deps.preCheckRedis,
    pricing: deps.pricing,
    selfHostId: deps.selfHostUuid ?? null,
    appendCostCredits: deps.appendCostCreditsForUser,
  });

  bindSelfhostToolBrokerOpener(isSelfhostV5, deps.v3Deps, userChatBridge);

  const recoveryDecisionBroadcast = (
    userId: string,
    sessionId: string,
    verdict: AutomaticRecoveryDecision,
  ): void => {
    const uidMatch = /^c:([1-9][0-9]*)$/.exec(userId);
    if (!uidMatch) return;
    const uid = uidMatch[1]!;
    const code = normalizeTurnErrorCode(verdict.errorCode);
    if (/^[A-Za-z0-9_]{1,64}$/.test(code)) {
      void recordProductFrictionEvent({
        correlation: `${sessionId}:${verdict.sourceClientMessageId}`,
        userId: BigInt(uid),
        surface: "recovery",
        stage: "recovery_decision",
        code,
        outcome: verdict.scheduled ? "pending" : "failed",
        attempts: verdict.scheduled ? verdict.attempt : undefined,
        path: "decision",
        reason: verdict.scheduled ? undefined : verdict.reason,
        sessionId,
      }).catch((err: unknown) => {
        rootLogger.warn("recovery_decision_friction_failed", {
          sessionId,
          errorClass: err instanceof Error ? err.constructor.name : typeof err,
        });
      });
    }
    const payload = recoveryDecisionFrame(sessionId, verdict);
    if (deps.dualMasterEnabled) {
      void deps.slotRelayClient.broadcastToUsers([uid], payload).catch(() => undefined);
      return;
    }
    userChatBridge.broadcastToUser(BigInt(uid), payload);
    if (verdict.scheduled) {
      void userChatBridge.drainRecoveryForUser?.(BigInt(uid));
    }
  };

  return { userChatBridge, recoveryDecisionBroadcast };
}
