import { WebSocket } from "ws";
import { readSecurityEpoch } from "../../billing/modelCatalog.js";
import { authorityKeyCensus } from "../authorityKeyCensus.js";
import type { Conn } from "../connections.js";
import { getContainerLinkHandle } from "../containerLink.js";
import {
  FirstVisiblePersistGate,
  TurnResponseMilestoneTracker,
} from "../turnPerformance.js";
import { sendErrorFrame } from "../userErrorFrames.js";
import { failAttestation, onContainerAttest } from "./connectionAuthority.js";
import {
  attachContainerSocketLifecycle,
  attachUserSocketLifecycle,
  checkDrainComplete,
  cleanup,
  forwardInboundFrame,
  sendToContainer,
} from "./connectionLifecycle.js";
import { CLOSE_BRIDGE } from "./constants.js";
import { onContainerMessage } from "./outboundMessage.js";
import { executeAdmittedTurn } from "./turnExecution.js";
import type {
  BridgeConnectionCtx,
  BridgeSharedState,
  StartBridgeParams,
} from "./types.js";
import { closeWsSafely, terminateWsSafely } from "./wireHelpers.js";

function createConnectionCollections(params: StartBridgeParams) {
  return {
    firstVisiblePersist: new FirstVisiblePersistGate(),
    responseMilestoneTracker: new TurnResponseMilestoneTracker(512, params.clientTelemetry),
    skippedRecoveryIds: new Set<string>(),
    attestQueue: [],
    preopenQueue: [],
    activeCodexTurnsByPeer: new Map(),
    promptQueueDispatchCancellations: new Map(),
    pendingGrokLeaseReleases: new Map(),
    pendingRebindMap: new Map(),
    inflightCodexTurns: new Map(),
    pendingZcodeRequestIds: new Set<string>(),
    pendingZcodeRelays: new Map(),
    pendingAntigravityRelays: new Map(),
    pendingJournalSettles: new Set<string>(),
    locallySettledCodexTurns: new Set<string>(),
    retainedOutboundPersistQueueKeys: new Set<string>(),
    admittedDispatches: new Map(),
    pendingMigrationInstalls: new Map(),
    enrichmentDispatches: new Map(),
    enrichmentDeadlineChecks: new WeakMap(),
    preparedEnrichmentFrames: new WeakMap(),
    cronOriginClaimWaiters: new Map(),
    refusedRecoveryJobs: new Map(),
    identityPreparations: new Map(),
  };
}

function createConnectionCtx(
  shared: BridgeSharedState,
  params: StartBridgeParams,
): BridgeConnectionCtx {
  const { userWs, uid, endpoint, containerId, containerWs, connectAbort, connId } = params;
  const authorityDeps = shared.deps.modelAuthority;
  const authorityOn = authorityDeps !== undefined;
  const startedAt = Date.now();
  const ctx: BridgeConnectionCtx = {
    shared, userWs, uid, endpoint, containerId, containerWs, connectAbort,
    modelCheckerHandle: params.modelCheckerHandle,
    agentModelResolverHandle: params.agentModelResolverHandle,
    connId,
    userRole: params.userRole ?? "user",
    originAuthzReady: params.originAuthzReady ?? true,
    bridgeLog: shared.log?.child({ uid: uid.toString(), connId, connectionTraceId: connId }) ?? null,
    startedAt,
    ttftKind: endpoint.coldStart === true ? "cold" : "warm",
    authorityDeps,
    authorityOn,
    authorityCensus: authorityOn ? (authorityDeps.census ?? authorityKeyCensus) : null,
    readEpochAtSign: authorityDeps?.readSecurityEpoch ?? readSecurityEpoch,
    linkHandle: getContainerLinkHandle(containerWs),
    ...createConnectionCollections(params),
    unregister: () => {},
    connectTimer: null, heartbeatTimer: null, modelCheckerRefreshTimer: null,
    activityKeepaliveTimer: null, attestTimer: null, drainTimer: null, dispatchHeartbeatTimer: null,
    lastActivityRefreshAt: 0, bytesUC: 0, bytesCU: 0, bufferedUC: 0, bufferedCU: 0,
    cause: "internal_error", requestedCloseCause: null, cleaned: false,
    firstUserFrameAtMs: null, firstContainerFrameAtMs: null,
    lastSeenModelId: null, clientBuildForConnection: null,
    lastAliveAt: startedAt, turnActiveUntil: 0,
    containerChallenge: null, attestState: authorityOn ? "pending" : "ok",
    containerHasDurableDispatch: false, containerHasSystemHelp: false,
    containerHasCodexSpeedTiers: false, speedTierAttestSeen: false,
    recoveryExecutor: null, cronOriginExecutor: null, unregisterExecutors: null,
    attestQueuedBytes: 0, lastHelloPeerIds: null,
    autoRebindFetchDone: false, autoRebindFlushInFlight: false,
    drainCause: null, userDetached: false, preparationInFlight: 0,
    inFlightOutboundPersists: 0, identityPreparationBytes: 0, loggedRejectedContainerIncident: false,
    checkDrainComplete: () => checkDrainComplete(ctx),
    cleanup: (triggerCause, force) => cleanup(ctx, triggerCause, force),
    forwardInboundFrame: (data, isBinary, len, dispatchRecord, onWireOutcome) =>
      forwardInboundFrame(ctx, data, isBinary, len, dispatchRecord, onWireOutcome),
    sendToContainer: (data, isBinary, len, transfer, dispatchRecord, onWireOutcome) =>
      sendToContainer(ctx, data, isBinary, len, transfer, dispatchRecord, onWireOutcome),
    executeAdmittedTurn: (data, isBinary, ingress, dispatchRequest, recoveryJob, receivedAtMs, pretrackedEnrichment) =>
      executeAdmittedTurn(ctx, data, isBinary, ingress, dispatchRequest, recoveryJob, receivedAtMs, pretrackedEnrichment),
    onContainerMessage: (data, isBinary) => onContainerMessage(ctx, data, isBinary),
    onContainerAttest: (frame) => onContainerAttest(ctx, frame),
    failAttestation: (reason) => failAttestation(ctx, reason),
  };
  return ctx;
}

export function startBridgeConnection(
  shared: BridgeSharedState,
  params: StartBridgeParams,
): void {
  const ctx = createConnectionCtx(shared, params);
  if (ctx.linkHandle) ctx.linkHandle.onStreamsChanged = () => ctx.checkDrainComplete();
  const conn: Conn = {
    id: ctx.connId,
    user_id: ctx.uid.toString(),
    opened_at: ctx.startedAt,
    close: (_reason, cause) => {
      if (cause === "shutdown") {
        ctx.requestedCloseCause = "shutdown";
        closeWsSafely(ctx.userWs, CLOSE_BRIDGE.SERVER_RESTART, "server_restart");
      } else {
        closeWsSafely(ctx.userWs, CLOSE_BRIDGE.TOO_MANY_CONNECTIONS, "too_many_connections");
      }
    },
  };
  const { unregister, evicted } = ctx.linkHandle?.recoveryOnly
    ? { unregister: () => {}, evicted: [] }
    : shared.registry.register(conn);
  ctx.unregister = unregister;
  for (const victim of evicted) {
    ctx.bridgeLog?.warn("user-chat-bridge: kicked oldest connection (per-user limit)", {
      uid: ctx.uid.toString(),
      connId: ctx.connId,
      victimConnId: victim.id,
      maxPerUser: shared.config.maxPerUser,
    });
  }
  const uidKey = ctx.uid.toString();
  let set = shared.uidToUserWs.get(uidKey);
  if (!set) {
    set = new Set();
    shared.uidToUserWs.set(uidKey, set);
  }
  set.add(ctx.userWs);
  ctx.connectTimer = setTimeout(() => {
    if (ctx.containerWs.readyState !== WebSocket.OPEN) {
      ctx.bridgeLog?.warn("user-chat-bridge: container connect timeout", {
        host: ctx.endpoint.host,
        port: ctx.endpoint.port,
      });
      try {
        ctx.connectAbort.abort();
      } catch (err) {
        void err;
      }
      terminateWsSafely(ctx.containerWs);
      sendErrorFrame(ctx.userWs, "ERR_CONTAINER_TIMEOUT", "agent connect timeout");
      closeWsSafely(ctx.userWs, CLOSE_BRIDGE.INTERNAL, "agent timeout");
      ctx.cleanup("container_error", true);
    }
  }, shared.config.connectTimeoutMs);
  attachContainerSocketLifecycle(ctx);
  attachUserSocketLifecycle(ctx);
  for (const m of params.earlyMessages) {
    ctx.executeAdmittedTurn(m.data, m.isBinary, "browser", undefined, undefined, m.receivedAtMs);
  }
}
