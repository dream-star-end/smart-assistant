import type { Pool } from "pg";
import { DEFAULT_CODEX_ENGINE_MODEL, type DurableCodexBilling } from "@openclaude/protocol";
import { inboundSessionKey, observeUserContentReview } from '@openclaude/gateway';
import { OutboundRingBuffer, DEFAULT_RING_CONFIG } from "@openclaude/gateway";
import {
  applyLearnedCursorQuota,
  fingerprintCursorKey,
  resolveUsedCursorAccountId,
} from "../account-pool/cursorMaterializer.js";
import { getCursorTokenSnapshot } from "../account-pool/store.js";
import { settleDurableCursorBilling } from "../billing/durableCursorBilling.js";
import type { PricingCache } from "../billing/pricing.js";
import type { Logger } from "../logging/logger.js";
import { isInMaintenance } from "../middleware/maintenanceMode.js";
import { availableExecutors } from "./bridgeExecutorRegistration.js";
import {
  executeCronOriginInject,
  lookupCronOriginSessionModel,
  resolveCronOriginAdmitModel,
} from "./cronOriginInject.js";
import { resolveBridgeTeamLeaderModel } from "./teamModeForwarding.js";
import { handleTurnDispatchReceipt } from './turnDispatchReceipt.js';
import { tryMarkLegacyColdInstallFromReceipt } from "./userChatBridgeRemotePoolSeal.js";
import type { ModelCheckerHandle } from "./userChatBridgeTypes.js";
import {
  createBridgeSharedState,
  shutdownBridge,
  validateAndBuildBridgeConfig,
} from "./bridge/bridgeBootstrap.js";
import { startFrontendBuildReannounceTimer } from "./bridge/broadcastAndSessions.js";
import {
  acceptEnrichmentReceipt as acceptEnrichmentReceiptFn,
  claimEnrichmentTerminalization as claimEnrichmentTerminalizationFn,
  dropAdmittedDispatch as dropAdmittedDispatchFn,
  noteDispatchStreamFrame as noteDispatchStreamFrameFn,
  settleCronOriginClaim as settleCronOriginClaimFn,
  trackBridgePreparation,
} from "./bridge/connectionDispatch.js";
import {
  BRIDGE_WS_PATH,
  CLOSE_BRIDGE,
  ContainerUnreadyError,
  DEFAULT_CODEX_SESSION_MAX_MS,
  DEFAULT_DISPATCH_DRAIN_MS,
  DEFAULT_DRAIN_BILLING_MS,
  DEFAULT_MAX_FRAME_BYTES,
  MAX_DISPATCH_DRAIN_MS,
} from "./bridge/constants.js";
import { engineUsesAnthropicAuxModels } from "./bridge/enginePolicy.js";
import { _OutboundPersistQueueCoordinator } from "./bridge/outboundPersistQueue.js";
import { setBackgroundRoleActive, startRecoveryDrainTimer } from "./bridge/recoveryScheduler.js";
import type {
  AdmittedDispatch,
  BridgeConnectionCtx,
  BridgePlatformAdapters,
  CodexApiRelayRoute,
  CodexBindingHandle,
  CodexOfficialOAuthRoute,
  CodexRouteDecision,
  CodexRouteUnavailable,
  CronOriginExecutor,
  CronOriginExecutorClaimResult,
  CronOriginInjectInput,
  CronOriginInjectResult,
  CursorExternalBillingArgs,
  EnrichmentDispatchState,
  ResolveContainerEndpoint,
  TrackedPreparationTask,
  TurnGoalResolution,
  UserChatBridgeDeps,
  UserChatBridgeHandler,
} from "./bridge/types.js";
import { createHandleUpgrade } from "./bridge/upgradeHandshake.js";
import {
  _isAuthorizedRecoveryNativeReset,
  _sanitizeMasterHistoricalMessagesForFrame,
  codexAbandonFailureCode,
  encode4503Reason,
  isCursorContainerOnSelfHost,
  isLeftoverHotWsFrame,
  isValidatedAnnotatedImageInbound,
  parsePromptQueueDispatchActivated,
  parsePromptQueueDispatchCancel,
  parsePromptQueueDispatchRequest,
  rawDataLen,
  resolveTurnGoalState,
} from "./bridge/wireHelpers.js";

export const DEFAULT_PROMPT_QUEUE_PREPARATION_TIMEOUT_MS = 35_000;

export { classifyTurnDispatchReceipt } from './turnDispatchReceipt.js';
export { _recoveryRefusalAction, shouldRejectCodexTurnForG7 } from './modelSwitchCostGuard.js';
export {
  PROMPT_QUEUE_DISPATCH_REQUEST_TYPE,
  PROMPT_QUEUE_DISPATCH_RESULT_TYPE,
  PROMPT_QUEUE_DISPATCH_CANCEL_TYPE,
  PROMPT_QUEUE_DISPATCH_ACTIVATED_TYPE,
  PROMPT_QUEUE_GRANT_FIELD,
} from "./promptQueueDispatchTypes.js";
export type {
  PromptQueueDispatchRequest,
  PromptQueueDispatchResult,
  PromptQueueDispatchCancel,
  PromptQueueDispatchActivated,
} from "./promptQueueDispatchTypes.js";
export type {
  BridgeMetricSink,
  BridgeCloseCause,
  BridgeModelAuthorityDeps,
  ModelCheckerHandle,
} from "./userChatBridgeTypes.js";
export { CONTAINER_ATTEST_FRAME_TYPE } from "./userChatBridgeTypes.js";
export {
  BRIDGE_WS_PATH, CLOSE_BRIDGE, DEFAULT_MAX_FRAME_BYTES, ContainerUnreadyError,
  engineUsesAnthropicAuxModels, _isAuthorizedRecoveryNativeReset, isLeftoverHotWsFrame,
  isValidatedAnnotatedImageInbound, parsePromptQueueDispatchRequest, parsePromptQueueDispatchCancel,
  parsePromptQueueDispatchActivated, codexAbandonFailureCode, executeCronOriginInject,
  lookupCronOriginSessionModel, resolveCronOriginAdmitModel, _sanitizeMasterHistoricalMessagesForFrame,
  resolveTurnGoalState, isCursorContainerOnSelfHost, _OutboundPersistQueueCoordinator,
};
export type {
  ResolveContainerEndpoint, UserChatBridgeDeps, CodexBindingHandle, CodexApiRelayRoute,
  CodexOfficialOAuthRoute, CodexRouteUnavailable, CodexRouteDecision, CronOriginExecutorClaimResult,
  CronOriginExecutor, UserChatBridgeHandler, CronOriginInjectInput, CronOriginInjectResult,
  TurnGoalResolution,
};

function readCodexSessionMaxMs(): number {
  const raw = process.env.CODEX_SESSION_MAX_MS;
  if (!raw) return DEFAULT_CODEX_SESSION_MAX_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1000 ? n : DEFAULT_CODEX_SESSION_MAX_MS;
}

function readDrainBillingMs(): number {
  const raw = process.env.DRAIN_BILLING_MS;
  if (!raw) return DEFAULT_DRAIN_BILLING_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 50 ? n : DEFAULT_DRAIN_BILLING_MS;
}

function readDispatchDrainMs(): number {
  const raw = process.env.OC_DISPATCH_DRAIN_MS;
  let n = DEFAULT_DISPATCH_DRAIN_MS;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 50) n = parsed;
  }
  return Math.min(n, MAX_DISPATCH_DRAIN_MS);
}

async function reopenUnprovenAbortedJournal(
  pgPool: Pool,
  requestId: string,
  uidStr: string,
): Promise<boolean> {
  const reopened = await pgPool.query(
    `UPDATE request_finalize_journal
        SET state='inflight', error_msg=NULL, failure_code=NULL,
            final_credits=NULL, updated_at=NOW()
      WHERE request_id=$1 AND user_id=$2 AND state='aborted'
        AND NOT EXISTS (
          SELECT 1 FROM usage_records ur
           WHERE ur.user_id=$2 AND ur.request_id=$1
        )`,
    [requestId, uidStr],
  );
  return reopened.rowCount === 1;
}

function resolveTeamLeaderModel(
  pricing: PricingCache | undefined,
  checker: ModelCheckerHandle | null,
): string {
  let effectiveModel = DEFAULT_CODEX_ENGINE_MODEL;
  effectiveModel = resolveBridgeTeamLeaderModel(pricing, checker);
  return effectiveModel;
}

function handleTurnDispatchReceiptFromBridge(
  attestPeek: string,
  ctx: BridgeConnectionCtx,
): boolean {
  const deps = ctx.shared.deps;
  const {
    uid, containerId, endpoint, admittedDispatches, enrichmentDispatches,
    cronOriginClaimWaiters, pendingMigrationInstalls, bridgeLog,
  } = ctx;
  const claimEnrichmentTerminalization = (state: EnrichmentDispatchState): boolean =>
    claimEnrichmentTerminalizationFn(ctx, state);
  const acceptEnrichmentReceipt = (record: AdmittedDispatch): boolean =>
    acceptEnrichmentReceiptFn(ctx, record);
  const dropAdmittedDispatch = (cmid: string): void => dropAdmittedDispatchFn(ctx, cmid);
  const settleCronOriginClaim = (
    dispatchId: string,
    result: CronOriginExecutorClaimResult,
  ): void => settleCronOriginClaimFn(ctx, dispatchId, result);
  const noteDispatchStreamFrame = (
    sessionId: string,
    clientMessageId: string,
    final: boolean,
  ): void => noteDispatchStreamFrameFn(ctx, sessionId, clientMessageId, final);
  const broadcastToUser = (targetUid: bigint, frame: unknown): number =>
    ctx.shared.broadcastToUser(targetUid, frame);
  if (handleTurnDispatchReceipt(attestPeek, {
    pool: deps.pgPool, uid, admittedDispatches, enrichmentDispatches,
    ...(containerId !== undefined ? {
      agentContainerId: containerId,
      runtimeKind: endpoint.desktop ? "desktop" : "docker",
    } : {}),
    claimEnrichmentTerminalization, acceptEnrichmentReceipt, dropAdmittedDispatch,
    settleCronOriginClaim, noteDispatchStreamFrame,
    onDispatchAccepted: (rec, state) => tryMarkLegacyColdInstallFromReceipt(
      { ...rec, state },
      { uid, pendingMigrationInstalls, markPlacementMigrationInstalled: deps.markPlacementMigrationInstalled, warn: (m, meta) => bridgeLog?.warn(m, meta) },
    ),
    onFollowupActiveReceipt: (r) => tryMarkLegacyColdInstallFromReceipt(
      r,
      { uid, pendingMigrationInstalls, markPlacementMigrationInstalled: deps.markPlacementMigrationInstalled, warn: (m, meta) => bridgeLog?.warn(m, meta) },
    ),
    hasCronOriginClaim: (dispatchId) => cronOriginClaimWaiters.has(dispatchId),
    broadcast: (frame) => { broadcastToUser(uid, frame); },
    warn: (message, meta) => bridgeLog?.warn(message, meta),
  })) return true;
  return false;
}

async function verifyStableCursorAccountId(
  pool: Pool,
  external: Record<string, unknown>,
  requestId: string,
  bridgeLog: Logger | null,
): Promise<bigint | null> {
  const stable = await pool.query<{ id: string }>(
    `SELECT id::text AS id FROM claude_accounts WHERE id=$1 AND provider='cursor'`,
    [external.cursorAccountId],
  );
  let cursorAccountId = stable.rows[0]?.id ? BigInt(stable.rows[0].id) : null;
  if (cursorAccountId !== null) {
    const snapshot = await getCursorTokenSnapshot(cursorAccountId);
    try {
      const currentFingerprint = snapshot?.token
        ? fingerprintCursorKey(snapshot.token.toString("utf8"))
        : null;
      if (currentFingerprint !== external.cursorKeyFingerprint) {
        cursorAccountId = null;
        bridgeLog?.warn("user-chat-bridge: stable Cursor account fingerprint mismatch", {
          requestId,
          poolGeneration: external.cursorPoolGeneration ?? null,
        });
      }
    } finally {
      snapshot?.token.fill(0);
      snapshot?.refresh?.fill(0);
    }
  }
  if (cursorAccountId === null) {
    bridgeLog?.warn("user-chat-bridge: stable Cursor account identity no longer exists", {
      requestId,
      cursorAccountId: external.cursorAccountId,
      poolGeneration: external.cursorPoolGeneration ?? null,
    });
  }
  return cursorAccountId;
}

async function resolveCursorExternalAccountId(
  pool: Pool,
  external: Record<string, unknown>,
  requestId: string,
  bridgeLog: Logger | null,
): Promise<{ cursorAccountId: bigint | null; stableIdentityProvided: boolean }> {
  let cursorAccountId: bigint | null = null;
  const stableIdentityParts = [
    external.cursorAccountId,
    external.cursorPoolGeneration,
    external.cursorKeyFingerprint,
  ];
  const stableIdentityCount = stableIdentityParts.filter((value) => value !== undefined).length;
  const stableIdentityProvided = stableIdentityCount > 0;
  const stableIdentityComplete = stableIdentityCount === stableIdentityParts.length;
  try {
    if (stableIdentityProvided && !stableIdentityComplete) {
      bridgeLog?.warn("user-chat-bridge: partial Cursor stable identity rejected", { requestId });
    } else if (
      external.cursorAccountId &&
      external.cursorPoolGeneration &&
      external.cursorKeyFingerprint
    ) {
      cursorAccountId = await verifyStableCursorAccountId(pool, external, requestId, bridgeLog);
    } else if (!stableIdentityProvided) {
      cursorAccountId = await resolveUsedCursorAccountId(external.cursorSlotResults);
    }
  } catch (resolveErr) {
    bridgeLog?.warn("user-chat-bridge: Cursor account attribution failed", {
      requestId,
      err: resolveErr,
    });
  }
  return { cursorAccountId, stableIdentityProvided };
}

function settleCursorExternalBilling(args: CursorExternalBillingArgs): void {
  const { ctx, requestId, status, terminalCode, durationMs, usage, external } = args;
  const { deps } = ctx.shared;
  const pool = deps.pgPool!;
  const pricing = deps.pricing;
  void (async () => {
    try {
      const audit = await pool.query<{ model_id: string; session_id: string | null }>(
        `SELECT model_id, session_id FROM cursor_external_usage_audit
          WHERE request_id=$1 AND user_id=$2`,
        [requestId, ctx.uid],
      );
      const modelId = audit.rows[0]?.model_id ?? null;
      const sessionId = audit.rows[0]?.session_id ?? null;
      const { cursorAccountId, stableIdentityProvided } = await resolveCursorExternalAccountId(
        pool, external, requestId, ctx.bridgeLog,
      );
      if (modelId !== null) {
        try {
          await applyLearnedCursorQuota({
            modelId, terminalCode, slotResults: external.cursorSlotResults,
            stableAccountId: stableIdentityProvided ? cursorAccountId : undefined,
          });
        } catch (learnErr) {
          ctx.bridgeLog?.warn("user-chat-bridge: Cursor quota-class learn failed", { requestId, err: learnErr });
        }
      }
      if (modelId === null) {
        ctx.bridgeLog?.warn("user-chat-bridge: Cursor settle skipped, audit model_id missing", { requestId });
      } else if (!pricing) {
        ctx.bridgeLog?.warn("user-chat-bridge: Cursor settle skipped, pricing cache missing", { requestId, modelId });
      } else {
        await settleDurableCursorBilling(
          { pgPool: pool, pricing, appendCostCredits: deps.appendCostCredits },
          ctx.uid,
          {
            requestId, engine: "cursor", engineSessionId: sessionId ?? "",
            status: status === "success" ? "success" : "error", durationMs,
            usage: (usage ?? undefined) as DurableCodexBilling["usage"],
          },
          { engineStatus: status, terminalCode, accountId: cursorAccountId },
        );
      }
    } catch (err) {
      ctx.bridgeLog?.warn("user-chat-bridge: Cursor platform settle failed", { requestId, err });
    }
  })();
}

function runTrackedPreparation(ctx: BridgeConnectionCtx, task: TrackedPreparationTask): void {
  const trackPreparation = (work: () => Promise<void>): void =>
    trackBridgePreparation(ctx, work, task.recoveryJob);
  switch (task.lane) {
    case "cursorLane": {
      const cursorTurnIdentity = task.turnIdentity;
      trackPreparation(async () => { await task.run(cursorTurnIdentity); });
      return;
    }
    case "zcodeLane": {
      const zcodeTurnIdentity = task.turnIdentity;
      trackPreparation(async () => { await task.run(zcodeTurnIdentity); });
      return;
    }
    case "antigravityLane": {
      const antigravityTurnIdentity = task.turnIdentity;
      trackPreparation(async () => { await task.run(antigravityTurnIdentity); });
      return;
    }
    case "annotated": {
      trackPreparation(async () => { const dispatchRecordA = await task.run(); void dispatchRecordA; });
      return;
    }
    case "codex": {
      trackPreparation(async () => { const dispatchRecordB = await task.run(); void dispatchRecordB; });
      return;
    }
    case "ccb": {
      trackPreparation(async () => { const dispatchRecordC = await task.run(); void dispatchRecordC; });
      return;
    }
    case "identity": {
      const { work, len, peerKey } = task;
      const identityPreparations = ctx.identityPreparations;
      trackPreparation(async () => {
        try {
          await work;
        } finally {
          let identityPreparationBytes = ctx.identityPreparationBytes;
          identityPreparationBytes -= len;
          ctx.identityPreparationBytes = identityPreparationBytes;
          if (identityPreparations.get(peerKey) === work) identityPreparations.delete(peerKey);
        }
      });
      return;
    }
  }
}

function stripClientCreditBudget(sanitizedParsed: Record<string, unknown>): void {
  const hasClientCreditBudget = Object.prototype.hasOwnProperty.call(
    sanitizedParsed,
    "_creditBudget",
  );
  if (hasClientCreditBudget) {
    delete sanitizedParsed._creditBudget;
  }
}

function forwardPreparedToContainer(
  args: Parameters<BridgePlatformAdapters["forwardPreparedToContainer"]>[0],
): boolean {
  const { frameData, frameIsBinary, frameLength, dispatchRecord, onWireOutcome, forwardInboundFrame } = args;
  return forwardInboundFrame(frameData, frameIsBinary, frameLength, dispatchRecord, onWireOutcome);
}

function createBridgeAdapters(): BridgePlatformAdapters {
  return {
    inboundSessionKey,
    observeUserContentReview,
    createOutboundRing: () => new OutboundRingBuffer(DEFAULT_RING_CONFIG),
    isInMaintenance,
    readCodexSessionMaxMs,
    readDrainBillingMs,
    readDispatchDrainMs,
    reopenUnprovenAbortedJournal,
    resolveTeamLeaderModel,
    handleTurnDispatchReceiptFromBridge,
    settleCursorExternalBilling,
    stripClientCreditBudget,
    runTrackedPreparation,
    forwardPreparedToContainer,
  };
}

export function createUserChatBridge(deps: UserChatBridgeDeps): UserChatBridgeHandler {
  const { codexBillingEnabled, config } = validateAndBuildBridgeConfig(
    deps,
    DEFAULT_PROMPT_QUEUE_PREPARATION_TIMEOUT_MS,
  );
  const shared = createBridgeSharedState(deps, createBridgeAdapters(), codexBillingEnabled, config);
  const ringPruneTimer: NodeJS.Timeout = setInterval(() => {
    shared.outboundRing.pruneAll(Date.now());
  }, 60_000);
  ringPruneTimer.unref?.();
  const frontendBuildTimer = startFrontendBuildReannounceTimer(shared);
  const recoveryDrainTimer = startRecoveryDrainTimer(shared);
  const handleUpgrade = createHandleUpgrade(shared);
  const uidToCronOriginExecutors = shared.uidToCronOriginExecutors;
  const setRoleActive = (active: boolean): Promise<void> => setBackgroundRoleActive(shared, active);
  return {
    handleUpgrade,
    shutdown: (reason) => shutdownBridge(shared, { ringPruneTimer, frontendBuildTimer, recoveryDrainTimer }, reason),
    registry: shared.registry,
    containerLinkEnabled: shared.links !== null,
    containerLinkSnapshots: () => shared.links?.snapshots() ?? [],
    rebuildContainerLinks: async () => {
      await Promise.all([shared.recovery?.start(), shared.controls?.scan()]);
    },
    createBrokerFrameLinkOpener: () =>
      shared.links?.toolBrokerEnabled ? shared.links.createBrokerFrameLinkOpener() : null,
    setBackgroundRoleActive: setRoleActive,
    setActiveLeader: setRoleActive,
    drainBrowserWebSockets: () => shared.registry.closeAll("server_restart"),
    broadcastToUser: shared.broadcastToUser,
    syncGoalToContainers: shared.syncGoalToContainers,
    drainRecoveryForUser: shared.drainDurableRecoveryForUser,
    drainControlsForUser: shared.drainDurableControlsForUser,
    broadcastAll: shared.broadcastAll,
    broadcastToUsers: shared.broadcastToUsers,
    onlineUserSubset: shared.onlineUserSubset,
    injectCronOriginTurn: async (input: CronOriginInjectInput): Promise<CronOriginInjectResult> => {
      const executors = availableExecutors(uidToCronOriginExecutors.get(input.uid.toString()));
      if (executors.length === 0 || !deps.admitUserTurn) return { kind: "no_transport" };
      return executeCronOriginInject({
        modelSwitchCost: deps.modelSwitchCost,
        input,
        pgPool: deps.pgPool,
        admitUserTurn: deps.admitUserTurn,
        getExecutors: () => availableExecutors(uidToCronOriginExecutors.get(input.uid.toString())),
        broadcast: (frame) => { shared.broadcastToUser(input.uid, frame); },
        log: shared.log,
      });
    },
    _testRegisterCronOriginExecutor: (uid: string, executor: CronOriginExecutor): void => {
      let set = uidToCronOriginExecutors.get(uid);
      if (!set) {
        set = new Set();
        uidToCronOriginExecutors.set(uid, set);
      }
      set.add(executor);
    },
    _testGetCronOriginExecutor: (uid: string): CronOriginExecutor | null => {
      const set = uidToCronOriginExecutors.get(uid);
      return set ? [...set][0] ?? null : null;
    },
  };
}

export {
  rawDataLen as _rawDataLen,
  encode4503Reason as _encode4503Reason,
  readDispatchDrainMs as _readDispatchDrainMs,
  readDrainBillingMs as _readDrainBillingMs,
};
