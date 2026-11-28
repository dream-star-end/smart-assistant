import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { reconcileStaleZcodeAudits } from "../../billing/zcodeExternalAudit.js";
import { DISPATCH_LEASE_HEARTBEAT_MS } from "../../dispatch/turnDispatchStore.js";
import { OutboundBrowserHandoffFrameObserver } from "../../pendingDecisions/pgBrowserHandoffStore.js";
import { resolveBridgeMaxFrameBytes } from "../bridgeFrameBudget.js";
import { ConnectionRegistry } from "../connections.js";
import {
  CONTAINER_LINK_ADMITTED_RENEW_MAX_AGE_MS,
  ContainerLinkRegistry,
} from "../containerLink.js";
import { ContainerLinkControls } from "../containerLinkControls.js";
import { containerLinkEnabled } from "../containerLinkPolicy.js";
import { rebuildContainerLink } from "../containerLinkRebuild.js";
import { ContainerLinkRecovery } from "../containerLinkRecovery.js";
import type { ModelCheckerHandle } from "../userChatBridgeTypes.js";
import { loadBridgeAgentModelResolver, loadBridgeModelChecker } from "./authorityCatalog.js";
import {
  broadcastAll,
  broadcastToUser,
  broadcastToUsers,
  onlineUserSubset,
  openUserWsForSession,
  registerUserWsSession,
  syncGoalToContainers,
  unregisterUserWsSessions,
} from "./broadcastAndSessions.js";
import {
  ACTIVITY_KEEPALIVE_INTERVAL_MS,
  DEFAULT_CONTAINER_CONNECT_TIMEOUT_MS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_MAX_BUFFERED_BYTES,
  DEFAULT_MAX_PER_USER,
} from "./constants.js";
import { _OutboundPersistQueueCoordinator } from "./outboundPersistQueue.js";
import { drainDurableRecoveryForUser } from "./recoveryScheduler.js";
import { startBridgeConnection } from "./startBridge.js";
import type {
  AgentModelResolverHandle,
  BridgeConfig,
  BridgePlatformAdapters,
  BridgeSharedState,
  UserChatBridgeDeps,
} from "./types.js";
import { resolveContainerLinkBrokerRuntimeChannel } from "./wireHelpers.js";

function positiveSafeInt(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

export function validateAndBuildBridgeConfig(
  deps: UserChatBridgeDeps,
  defaultPrepTimeoutMs: number,
): { codexBillingEnabled: boolean; config: BridgeConfig } {
  const codexBillingDepsCount = [deps.pgPool, deps.preCheckRedis, deps.pricing]
    .filter((x) => x !== undefined).length;
  if (codexBillingDepsCount !== 0 && codexBillingDepsCount !== 3) {
    throw new TypeError(
      "createUserChatBridge: pgPool/preCheckRedis/pricing must be all set or all unset " +
      "(partial wiring suggests deployment misconfig that would silently disable codex billing)",
    );
  }
  if (deps.codexBinding !== undefined && codexBillingDepsCount === 0) {
    throw new TypeError(
      "createUserChatBridge: codexBinding requires pgPool+preCheckRedis+pricing " +
      "(otherwise codex turns acquire slots but never settle billing — silent free codex)",
    );
  }
  return {
    codexBillingEnabled: codexBillingDepsCount === 3,
    config: {
      maxPerUser: deps.maxPerUser ?? DEFAULT_MAX_PER_USER,
      maxFrameBytes: deps.maxFrameBytes ?? resolveBridgeMaxFrameBytes(),
      maxBufferedBytes: deps.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES,
      connectTimeoutMs: deps.containerConnectTimeoutMs ?? DEFAULT_CONTAINER_CONNECT_TIMEOUT_MS,
      heartbeatIntervalMs: deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      activityKeepaliveIntervalMs: deps.activityKeepaliveIntervalMs ?? ACTIVITY_KEEPALIVE_INTERVAL_MS,
      heartbeatTimeoutMs: deps.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS,
      promptQueuePreparationTimeoutMs: positiveSafeInt(
        deps.promptQueuePreparationTimeoutMs,
        defaultPrepTimeoutMs,
      ),
      dispatchLeaseHeartbeatMs: positiveSafeInt(
        deps.dispatchLeaseHeartbeatMs,
        DISPATCH_LEASE_HEARTBEAT_MS,
      ),
      admittedRenewMaxAgeMs: positiveSafeInt(
        deps.admittedRenewMaxAgeMs,
        CONTAINER_LINK_ADMITTED_RENEW_MAX_AGE_MS,
      ),
    },
  };
}

function buildContainerLinkRecovery(
  deps: UserChatBridgeDeps,
  links: ContainerLinkRegistry | null,
  outboundPersistQueues: _OutboundPersistQueueCoordinator,
  maxFrameBytes: number,
  getShared: () => BridgeSharedState,
): ContainerLinkRecovery | null {
  if (!links || !deps.resolveContainerLinkEndpoint || !deps.pgPool) return null;
  const log = deps.logger;
  return new ContainerLinkRecovery({
    pool: deps.pgPool,
    channel: deps.containerLinkRecovery?.channel ?? "v5",
    log,
    ...deps.containerLinkRecovery,
    paused: Boolean(deps.deferBackgroundActivation),
    drain: async () => {
      await links.drain();
      await outboundPersistQueues.drain();
    },
    attach: (carrier, rows, signal, keepAlive) =>
      rebuildContainerLink({
        carrier, rows, signal, keepAlive, links, deps, maxFrameBytes,
        start: async (userWs, uid, endpoint, containerWs, connectAbort, connId) => {
          const shared = getShared();
          let modelCheckerHandle: ModelCheckerHandle | null = null;
          let agentModelResolverHandle: AgentModelResolverHandle | null = null;
          let originAuthzReady = true;
          try {
            modelCheckerHandle = await shared.loadBridgeModelChecker(uid);
            agentModelResolverHandle = await shared.loadBridgeAgentModelResolver(uid, endpoint.bundleRev);
          } catch (err) {
            modelCheckerHandle = null;
            agentModelResolverHandle = null;
            originAuthzReady = false;
            log?.warn("user-chat-bridge: rebuilt container-link authz unavailable; restricting to recovery only", {
              uid: uid.toString(),
              containerId: endpoint.containerId ?? null,
              bundleRev: endpoint.bundleRev ?? null,
              err,
            });
          }
          shared.startBridge({
            userWs, uid, endpoint, earlyMessages: [], containerId: endpoint.containerId,
            containerWs, connectAbort, modelCheckerHandle, agentModelResolverHandle,
            connId, userRole: "user", originAuthzReady,
          });
        },
      }),
  });
}

function createContainerLinkInfra(
  deps: UserChatBridgeDeps,
  config: BridgeConfig,
  outboundPersistQueues: _OutboundPersistQueueCoordinator,
  uidToContainerWs: Map<string, Set<WebSocket>>,
  getShared: () => BridgeSharedState,
): {
  links: ContainerLinkRegistry | null;
  recovery: ContainerLinkRecovery | null;
  controls: ContainerLinkControls | null;
} {
  const log = deps.logger;
  const links = deps.pgPool && (deps.containerLinkEnabled ?? containerLinkEnabled())
    ? new ContainerLinkRegistry(deps.pgPool, log, {
        heartbeatMs: deps.containerLinkHeartbeatMs,
        maxBufferedBytes: config.maxBufferedBytes,
        dialTimeoutMs: config.connectTimeoutMs,
        admittedRenewMaxAgeMs: config.admittedRenewMaxAgeMs,
        toolBrokerEnabled: deps.containerLinkToolBrokerEnabled,
        runtimeChannel: resolveContainerLinkBrokerRuntimeChannel(deps),
      })
    : null;
  if (links) {
    links.beforeReplay = (scope) => {
      if (!scope || scope.sessionKeys.length === 0) return outboundPersistQueues.drain();
      const prefix = `${scope.uid.toString()}:${scope.containerId.toString()}:`;
      return outboundPersistQueues.drain(scope.sessionKeys.map((sk) => `${prefix}${sk}`));
    };
  }
  const recovery = buildContainerLinkRecovery(
    deps, links, outboundPersistQueues, config.maxFrameBytes, getShared,
  );
  if (links && recovery) {
    links.onTransportLost = (uid, cid) => {
      if (getShared().backgroundActive) recovery.lost(uid, cid);
    };
  }
  const controls = deps.pgPool
    ? new ContainerLinkControls({
        pool: deps.pgPool,
        channel: deps.containerLinkRecovery?.channel ?? "v5",
        links,
        legacy: uidToContainerWs,
        wake: (carrier) => recovery?.wake(carrier) ?? Promise.resolve(),
        log,
        paused: Boolean(deps.deferBackgroundActivation),
      })
    : null;
  return { links, recovery, controls };
}

function buildSharedStateMethods(
  getShared: () => BridgeSharedState,
  deps: UserChatBridgeDeps,
): Pick<
  BridgeSharedState,
  | "broadcastToUser"
  | "syncGoalToContainers"
  | "broadcastAll"
  | "broadcastToUsers"
  | "onlineUserSubset"
  | "registerUserWsSession"
  | "unregisterUserWsSessions"
  | "openUserWsForSession"
  | "drainDurableRecoveryForUser"
  | "drainDurableControlsForUser"
  | "isBackgroundCurrent"
  | "isRecoveryJobCurrent"
  | "trackRecoveryPromise"
  | "trackPromptQueueCompensation"
  | "trackZcodeAuditWork"
  | "ensureZcodeStaleReconcile"
  | "loadBridgeModelChecker"
  | "loadBridgeAgentModelResolver"
  | "startBridge"
> {
  const log = deps.logger;
  return {
    broadcastToUser: (uid, payload) => broadcastToUser(getShared(), uid, payload),
    syncGoalToContainers: (uid, goal) => syncGoalToContainers(getShared(), uid, goal),
    broadcastAll: (payload) => broadcastAll(getShared(), payload),
    broadcastToUsers: (uids, payload) => broadcastToUsers(getShared(), uids, payload),
    onlineUserSubset: (uids) => onlineUserSubset(getShared(), uids),
    registerUserWsSession: (ws, userId, sessionId) => registerUserWsSession(getShared(), ws, userId, sessionId),
    unregisterUserWsSessions: (ws) => unregisterUserWsSessions(getShared(), ws),
    openUserWsForSession: (userId, sessionId) => openUserWsForSession(getShared(), userId, sessionId),
    drainDurableRecoveryForUser: (uid) => drainDurableRecoveryForUser(getShared(), uid),
    drainDurableControlsForUser: (uid) => getShared().controls?.drain(uid) ?? Promise.resolve(),
    isBackgroundCurrent: (epoch) => {
      const s = getShared();
      return !s.shuttingDown && s.backgroundActive && s.backgroundEpoch === epoch;
    },
    isRecoveryJobCurrent: (job) => {
      const s = getShared();
      const ep = job ? s.recoveryJobEpochs.get(job) : undefined;
      return ep === undefined || s.isBackgroundCurrent(ep);
    },
    trackRecoveryPromise: (p) => {
      const s = getShared();
      const w = p.then(() => undefined, () => undefined);
      s.recoveryExecutionInFlight.add(w);
      void w.finally(() => s.recoveryExecutionInFlight.delete(w));
    },
    trackPromptQueueCompensation: (work) => {
      const s = getShared();
      s.pendingPromptQueueCompensations.add(work);
      void work.catch((err) => {
        log?.error("user-chat-bridge: prompt queue compensation failed", { err });
      }).finally(() => s.pendingPromptQueueCompensations.delete(work));
    },
    trackZcodeAuditWork: (work) => {
      const s = getShared();
      s.pendingZcodeAuditWork.add(work);
      void work.catch((err) => {
        log?.warn("user-chat-bridge: ZCode audit work failed", { err });
      }).finally(() => s.pendingZcodeAuditWork.delete(work));
    },
    ensureZcodeStaleReconcile: () => {
      const s = getShared();
      if (s.zcodeStaleReconcileStarted || !deps.pgPool) return;
      s.zcodeStaleReconcileStarted = true;
      s.trackZcodeAuditWork(reconcileStaleZcodeAudits(deps.pgPool).then(() => undefined));
    },
    loadBridgeModelChecker: (uid) => loadBridgeModelChecker(getShared(), uid),
    loadBridgeAgentModelResolver: (uid, bundleRev) => loadBridgeAgentModelResolver(getShared(), uid, bundleRev),
    startBridge: (params) => startBridgeConnection(getShared(), params),
  };
}

export function createBridgeSharedState(
  deps: UserChatBridgeDeps,
  adapters: BridgePlatformAdapters,
  codexBillingEnabled: boolean,
  config: BridgeConfig,
): BridgeSharedState {
  const outboundPersistQueues = new _OutboundPersistQueueCoordinator();
  const uidToContainerWs = new Map<string, Set<WebSocket>>();
  const sharedRef: { current: BridgeSharedState | null } = { current: null };
  const getShared = (): BridgeSharedState => sharedRef.current!;
  const infra = createContainerLinkInfra(
    deps, config, outboundPersistQueues, uidToContainerWs, getShared,
  );
  const shared: BridgeSharedState = {
    deps, adapters, config, codexBillingEnabled, log: deps.logger, metrics: deps.metrics ?? {},
    browserHandoffObserver: new OutboundBrowserHandoffFrameObserver(),
    registry: new ConnectionRegistry({ maxPerUser: config.maxPerUser }),
    wss: new WebSocketServer({ noServer: true, maxPayload: config.maxFrameBytes }),
    outboundRing: adapters.createOutboundRing(),
    outboundPersistQueues,
    ...infra,
    uidToUserWs: new Map(),
    sessionToUserWs: new Map(),
    userWsToSessionKeys: new Map(),
    uidToContainerWs,
    uidToRecoveryExecutors: new Map(),
    uidToCronOriginExecutors: new Map(),
    drainingChecks: new Set(),
    pendingPromptQueueCompensations: new Set(),
    pendingZcodeAuditWork: new Set(),
    recoveryDrainInFlight: new Map(),
    recoveryExecutionInFlight: new Set(),
    recoveryJobEpochs: new WeakMap(),
    recoveryDrainNeedsRerun: new Set(),
    recoveryLastScanAt: new Map(),
    recoveryLeaseOwner: `master-recovery:${randomUUID()}`,
    shuttingDown: false,
    backgroundActive: !deps.deferBackgroundActivation,
    backgroundEpoch: 0,
    zcodeStaleReconcileStarted: false,
    recoveryPollInFlight: false,
    lastOnlineReconcileSweepAt: 0,
    announcedFrontendBuild: null,
    ...buildSharedStateMethods(getShared, deps),
  };
  sharedRef.current = shared;
  return shared;
}

export async function shutdownBridge(
  shared: BridgeSharedState,
  timers: {
    ringPruneTimer: NodeJS.Timeout;
    frontendBuildTimer: NodeJS.Timeout | null;
    recoveryDrainTimer: NodeJS.Timeout;
  },
  reason = "server shutting down",
): Promise<void> {
  clearInterval(timers.ringPruneTimer);
  if (timers.frontendBuildTimer) clearInterval(timers.frontendBuildTimer);
  const controlsStopped = shared.controls?.stop();
  clearInterval(timers.recoveryDrainTimer);
  shared.shuttingDown = true;
  shared.recovery?.stop();
  if (shared.links) shared.links.stopping = true;
  shared.registry.closeAll(reason);
  for (const check of [...shared.drainingChecks]) check();
  await shared.links?.shutdown();
  await shared.recovery?.drain();
  await controlsStopped;
  await shared.outboundPersistQueues.drain();
  await new Promise<void>((resolve) => {
    try {
      shared.wss.close(() => resolve());
    } catch (err) {
      void err;
      resolve();
    }
  });
  while (
    shared.pendingPromptQueueCompensations.size > 0 ||
    shared.pendingZcodeAuditWork.size > 0
  ) {
    await Promise.allSettled([
      ...shared.pendingPromptQueueCompensations,
      ...shared.pendingZcodeAuditWork,
    ]);
  }
}
