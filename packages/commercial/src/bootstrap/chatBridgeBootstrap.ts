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
  createSelfhostReturnToRemoteGrantResolver,
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
import type { PgTransactionPool } from "../db/threeLayerStateStore.js";
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
}): Pick<UserChatBridgeDeps, "crossPoolFallbackSelector" | "returnToRemoteGrantResolver"> {
  if (!input.isSelfhostV5 || !input.modelCatalogCache) return {};
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

  const isSelfhostV5 =
    getRuntimeChannel() === "v5" &&
    deps.flavorIdentity.status === "ok" &&
    deps.flavorIdentity.flavor === "selfhost";

  const userChatBridge: UserChatBridgeHandler = createUserChatBridge({
    cc5BackendSelector: (input) =>
      selectMasterCc5Backend(deps.cc5Runtime, input, isSelfhostV5, deps.env),
    ...buildSelfhostCrossPoolBridgeHooks({
      isSelfhostV5,
      pool: getPool(),
      modelCatalogCache: deps.modelCatalogCache,
    }),
    containerLinkEnabled: deps.containerLinkOn,
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
