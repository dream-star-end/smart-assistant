import { WebSocket } from "ws";
import {
  CODEX_SPEED_TIERS_CAPABILITY,
  DURABLE_TURN_DISPATCH_CAPABILITY,
  isCc5TestModel,
  MODEL_AUTHORITY_CAPABILITY,
  projectContextWindowForCursorTier,
  SYSTEM_HELP_CAPABILITY,
  type AuthorityPoolMigrationGrant,
  type CursorContextTier,
  type ModelAuthorityBundle,
  type RemoteExecutionBackend,
} from "@openclaude/protocol";
import { projectContextWindowForRole } from "../../billing/modelRolePolicy.js";
import { releaseRecoveryForTransportWait } from "../../dispatch/turnRecoveryStore.js";
import type { Logger } from "../../logging/logger.js";
import { registerBridgeExecutors } from "../bridgeExecutorRegistration.js";
import { desktopAllowsEngine } from "../containerTransportKind.js";
import {
  resolveRemotePoolBackendAndSeal,
  type LocalFallbackCommittedHandle,
  type PreparedLocalFallbackTransport,
} from "../userChatBridgeRemotePoolSeal.js";
import { sendErrorFrame } from "../userErrorFrames.js";
import { resolveTurnExecution } from "./authorityCatalog.js";
import {
  beginCronOriginClaim,
  ensureDispatchHeartbeat,
  isEnriching,
  trackEnrichmentDispatch,
} from "./connectionDispatch.js";
import { CLOSE_BRIDGE, ModelNotAvailableError } from "./constants.js";
import { isNonCcbAuthorityEngine } from "./enginePolicy.js";
import type {
  AdmittedDispatch,
  BridgeConnectionCtx,
  CronOriginExecutor,
  InboundTurnIdentity,
  ResolvedTurnExecution,
} from "./types.js";
import { closeWsSafely } from "./wireHelpers.js";

export function failAttestation(ctx: BridgeConnectionCtx, reason: string): void {
  if (ctx.attestState === "failed") return;
  ctx.attestState = "failed";
  if (ctx.attestTimer !== null) {
    clearTimeout(ctx.attestTimer);
    ctx.attestTimer = null;
  }
  ctx.attestQueue.length = 0;
  ctx.attestQueuedBytes = 0;
  ctx.bridgeLog?.error("user-chat-bridge: model authority attestation failed", {
    reason,
    containerId: ctx.containerId,
  });
  if (ctx.containerId !== undefined && ctx.authorityDeps?.recycleContainer !== undefined) {
    try {
      ctx.authorityDeps.recycleContainer(ctx.containerId, reason);
    } catch (err) {
      ctx.bridgeLog?.warn("user-chat-bridge: recycle request failed", { err });
    }
  }
  if (!ctx.cleaned && ctx.userWs.readyState === WebSocket.OPEN) {
    sendErrorFrame(
      ctx.userWs,
      "CONTAINER_OUTDATED",
      ctx.endpoint.desktop
        ? "请更新本地运行时后重连"
        : "运行环境需要更新,已自动重建,请刷新页面后重发",
    );
    closeWsSafely(ctx.userWs, CLOSE_BRIDGE.ENV_RECYCLED, "model_authority_unsupported");
  }
}

function createAttestedCronOriginExecutor(ctx: BridgeConnectionCtx): CronOriginExecutor {
  const canAcceptCronOrigin = (): boolean => {
    if (!ctx.originAuthzReady || ctx.cleaned || ctx.shared.shuttingDown || ctx.cronOriginExecutor === null) {
      return false;
    }
    if (!ctx.userDetached) return true;
    const h = ctx.linkHandle;
    return (
      ctx.drainTimer === null &&
      h !== undefined &&
      h.active &&
      !h.disposed &&
      (h.hasOpenDispatches || h.keepAlive)
    );
  };
  const executor: CronOriginExecutor = async (payload) => {
    if (!canAcceptCronOrigin()) return { kind: "not_claimed" };
    const existing = ctx.admittedDispatches.get(payload.admitted.clientMessageId);
    if (existing !== undefined) {
      if (
        existing.dispatchId === payload.admitted.dispatchId &&
        existing.attemptNo === payload.admitted.attemptNo &&
        existing.leaseEpoch === payload.admitted.leaseEpoch
      ) {
        return ctx.cronOriginClaimWaiters.get(existing.dispatchId)?.promise ?? { kind: "delivery_unknown" };
      }
      return { kind: "delivery_unknown" };
    }
    const claimedAdmitted: AdmittedDispatch = {
      ...payload.admitted,
      admittedAtMs: Date.now(),
      wireSent: false,
    };
    ctx.admittedDispatches.set(claimedAdmitted.clientMessageId, claimedAdmitted);
    const receipt = beginCronOriginClaim(ctx, claimedAdmitted.dispatchId);
    const enrichment = trackEnrichmentDispatch(
      ctx,
      claimedAdmitted,
      "bridge_closed_before_cron_enrichment",
    );
    if (!isEnriching(enrichment)) return { kind: "delivery_unknown" };
    ensureDispatchHeartbeat(ctx);
    ctx.executeAdmittedTurn(
      payload.encoded,
      false,
      "cron_origin",
      undefined,
      undefined,
      Date.now(),
      enrichment,
    );
    return receipt;
  };
  executor.isAvailable = canAcceptCronOrigin;
  if (ctx.containerId !== undefined) {
    executor.agentContainerId = ctx.containerId;
    executor.runtimeKind = ctx.endpoint.desktop ? "desktop" : "docker";
  }
  return executor;
}

function registerAttestedExecutors(ctx: BridgeConnectionCtx): void {
  const { deps } = ctx.shared;
  if (ctx.containerHasDurableDispatch && deps.pgPool && ctx.recoveryExecutor === null) {
    const pool = deps.pgPool;
    ctx.recoveryExecutor = (job, epoch) => {
      if (epoch !== undefined) ctx.shared.recoveryJobEpochs.set(job, epoch);
      if (!ctx.shared.isRecoveryJobCurrent(job)) {
        ctx.shared.trackRecoveryPromise(releaseRecoveryForTransportWait(pool, job));
        return;
      }
      ctx.executeAdmittedTurn(Buffer.from(JSON.stringify(job.request), "utf8"), false, "recovery", undefined, job);
    };
  }
  if (ctx.containerHasDurableDispatch && deps.admitUserTurn && ctx.cronOriginExecutor === null) {
    ctx.cronOriginExecutor = createAttestedCronOriginExecutor(ctx);
  }
  if (ctx.unregisterExecutors === null && (ctx.recoveryExecutor || ctx.cronOriginExecutor)) {
    ctx.unregisterExecutors = registerBridgeExecutors(
      ctx.uid,
      ctx.containerWs,
      { recovery: ctx.recoveryExecutor, origin: ctx.cronOriginExecutor },
      { recovery: ctx.shared.uidToRecoveryExecutors, origin: ctx.shared.uidToCronOriginExecutors },
    );
    void ctx.shared.drainDurableRecoveryForUser(ctx.uid);
  }
}

export function onContainerAttest(
  ctx: BridgeConnectionCtx,
  frame: Record<string, unknown>,
): void {
  const caps = Array.isArray(frame.capabilities) ? frame.capabilities : [];
  if (!ctx.authorityOn) {
    if (!ctx.speedTierAttestSeen) {
      ctx.speedTierAttestSeen = true;
      ctx.containerHasCodexSpeedTiers = caps.includes(CODEX_SPEED_TIERS_CAPABILITY);
    }
    return;
  }
  if (ctx.attestState !== "pending") return;
  const challenge = typeof frame.connectionChallenge === "string" ? frame.connectionChallenge : "";
  if (!caps.includes(MODEL_AUTHORITY_CAPABILITY) || challenge === "") {
    failAttestation(ctx, "model_authority_capability_missing");
    return;
  }
  const keyIdsRaw = frame.keyIds;
  const keyIdsUnknown = !Array.isArray(keyIdsRaw);
  const attestedKeyIds = Array.isArray(keyIdsRaw)
    ? keyIdsRaw.filter((k): k is string => typeof k === "string")
    : [];
  if (!keyIdsUnknown && !attestedKeyIds.includes(ctx.authorityDeps!.signer.activeKeyId)) {
    failAttestation(ctx, "model_authority_active_key_missing");
    return;
  }
  ctx.containerChallenge = challenge;
  ctx.containerHasDurableDispatch = caps.includes(DURABLE_TURN_DISPATCH_CAPABILITY);
  ctx.containerHasSystemHelp = caps.includes(SYSTEM_HELP_CAPABILITY);
  ctx.containerHasCodexSpeedTiers = caps.includes(CODEX_SPEED_TIERS_CAPABILITY);
  ctx.attestState = "ok";
  registerAttestedExecutors(ctx);
  if (ctx.attestTimer !== null) {
    clearTimeout(ctx.attestTimer);
    ctx.attestTimer = null;
  }
  ctx.authorityCensus?.record(ctx.connId, {
    uid: Number(ctx.uid),
    containerId: ctx.containerId ?? null,
    keyIds: attestedKeyIds,
    fingerprint: typeof frame.keyringFingerprint === "string" ? frame.keyringFingerprint : "",
    keyIdsUnknown,
    attestedAt: Date.now(),
  });
  const queued = ctx.attestQueue.splice(0, ctx.attestQueue.length);
  ctx.attestQueuedBytes = 0;
  ctx.bridgeLog?.debug("user-chat-bridge: container attested model authority", {
    containerId: ctx.containerId,
    queuedFrames: queued.length,
    keyIds: attestedKeyIds,
    keyIdsUnknown,
  });
  for (const m of queued) {
    ctx.executeAdmittedTurn(m.data, m.isBinary, m.ingress, m.dispatchRequest, m.recoveryJob);
  }
}

export function signAuthorityBundle(
  ctx: BridgeConnectionCtx,
  exec: ResolvedTurnExecution,
  billingRequestId?: string,
  authorityTurnId?: string,
  executionBackend?: RemoteExecutionBackend,
  poolMigration?: AuthorityPoolMigrationGrant,
): ModelAuthorityBundle {
  if (
    ctx.authorityDeps === undefined ||
    ctx.containerChallenge === null ||
    ctx.containerId === undefined
  ) {
    throw new Error("[model-authority] sign called before attestation (challenge/containerId missing)");
  }
  return ctx.authorityDeps.signer.signBundle({
    uid: Number(ctx.uid),
    containerId: ctx.containerId,
    connectionChallenge: ctx.containerChallenge,
    canonicalModel: exec.canonicalModel,
    engine: exec.engine,
    executionDescriptor: exec.descriptor,
    auxModels: executionBackend ? [] : exec.auxModels,
    ...(executionBackend ? { executionBackend } : {}),
    ...(poolMigration ? { poolMigration } : {}),
    executionRevision: exec.executionRevision,
    securityEpoch: exec.securityEpoch,
    ...(authorityTurnId === undefined ? {} : { authorityTurnId }),
    ...(billingRequestId === undefined ? {} : { billingRequestId }),
  }).bundle;
}

export async function sealAuthorityFieldsOrReject(
  ctx: BridgeConnectionCtx,
  args: {
    exec: ResolvedTurnExecution;
    billingRequestId?: string;
    authorityTurnId?: string;
    log: Logger | null;
    onReject?: (code: string) => void;
    turn?: InboundTurnIdentity;
    compensate?: (reason: string) => Promise<void> | void;
    sessionId?: string;
    historicalMessages?: readonly unknown[];
    excludeClientMessageId?: string;
    enableCrossPoolCheckpoint?: boolean;
    prepareLocalFallbackTransport?: (p: {
      readonly localExec: ResolvedTurnExecution;
      readonly billingRequestId?: string;
      readonly authorityTurnId?: string;
    }) => Promise<PreparedLocalFallbackTransport | null>;
    onLocalFallbackCommitted?: (h: LocalFallbackCommittedHandle) => void;
  },
): Promise<Record<string, unknown> | null> {
  const userWs = ctx.userWs;
  const reject = async (code: string, message: string, reason: string): Promise<null> => {
    args.onReject?.(code);
    try {
      await args.compensate?.(reason);
    } catch (err) {
      args.log?.error("user-chat-bridge: authority sign-boundary compensation failed", {
        reason,
        err,
      });
    }
    if (!ctx.cleaned && userWs.readyState === WebSocket.OPEN) {
      sendErrorFrame(userWs, code, message, args.turn);
    }
    return null;
  };
  let dbEpoch: bigint;
  try {
    dbEpoch = await ctx.readEpochAtSign();
  } catch (err) {
    args.log?.error("user-chat-bridge: sign-boundary epoch read failed", { err });
    return await reject(
      "MODEL_AUTHORITY_UNAVAILABLE",
      "model catalog unavailable, retry shortly",
      "sign_boundary_epoch_read_failed",
    );
  }
  if (Number(dbEpoch) !== args.exec.securityEpoch) {
    args.log?.warn("user-chat-bridge: security epoch changed before signing — refusing turn", {
      fencedEpoch: args.exec.securityEpoch,
      dbEpoch: dbEpoch.toString(),
      model: args.exec.canonicalModel,
    });
    return await reject(
      "MODEL_CONFIG_CHANGED_RETRY_TURN",
      "model configuration changed, please resend",
      "sign_boundary_epoch_changed",
    );
  }
  const { deps } = ctx.shared;
  return await resolveRemotePoolBackendAndSeal({
    uid: Number(ctx.uid),
    containerId: ctx.containerId,
    sessionKey: args.turn?.sessionKey,
    sessionId: args.sessionId,
    historicalMessages: args.historicalMessages,
    hasLocalHistory: Array.isArray(args.historicalMessages) && args.historicalMessages.length > 0,
    excludeClientMessageId: args.excludeClientMessageId,
    enableCrossPoolCheckpoint: args.enableCrossPoolCheckpoint,
    exec: args.exec,
    billingRequestId: args.billingRequestId,
    authorityTurnId: args.authorityTurnId,
    log: args.log,
    cc5BackendSelector: deps.cc5BackendSelector,
    crossPoolFallbackSelector: deps.crossPoolFallbackSelector,
    returnToRemoteGrantResolver: deps.returnToRemoteGrantResolver,
    forcedLocalMigrationResolver: deps.forcedLocalMigrationResolver,
    recordRemotePlacement: deps.recordRemotePlacement,
    prepareLocalFallbackTransport: args.prepareLocalFallbackTransport,
    onLocalFallbackCommitted: args.onLocalFallbackCommitted,
    resolveLocalExec: ctx.authorityDeps
      ? (canonicalModel) => resolveTurnExecution(ctx.authorityDeps!.catalog, canonicalModel)
      : undefined,
    isModelAllowed: ctx.modelCheckerHandle
      ? (canonicalModel) => ctx.modelCheckerHandle!.isAllowed(canonicalModel)
      : undefined,
    readEpochAtSign: ctx.readEpochAtSign,
    signAuthorityBundle: (ex, brId, atId, eb, pm) =>
      signAuthorityBundle(ctx, ex, brId, atId, eb, pm),
    reject,
  });
}

async function resolveModelThroughPool(
  ctx: BridgeConnectionCtx,
  rawModel: string,
  sessionKey: string | null,
  reject: (code: string, message: string) => null,
): Promise<ResolvedTurnExecution | null> {
  const authorityDeps = ctx.authorityDeps!;
  const deps = ctx.shared.deps;
  let modelToResolve = rawModel;
  if (deps.resolveLogicalModelPoolTarget) {
    const snap = await authorityDeps.catalog.assertFresh();
    if (ctx.modelCheckerHandle !== null && ctx.modelCheckerHandle.epoch() < snap.securityEpoch) {
      await ctx.modelCheckerHandle.reloadAtLeast(snap.securityEpoch);
    }
    const poolRes = await deps.resolveLogicalModelPoolTarget({
      rawModelId: rawModel,
      catalogSnapshot: snap,
      isModelAllowed: ctx.modelCheckerHandle
        ? (m) => ctx.modelCheckerHandle!.isAllowed(m)
        : undefined,
      uid: Number(ctx.uid),
      sessionKey,
    });
    if (!poolRes.ok) {
      const code =
        poolRes.code === "MODEL_POOL_BINDING_READ_FAILED"
          ? "MODEL_AUTHORITY_UNAVAILABLE"
          : "MODEL_NOT_AVAILABLE";
      const msg =
        poolRes.code === "MODEL_POOL_BINDING_READ_FAILED"
          ? "model routing unavailable, retry shortly"
          : `model not available: ${rawModel}`;
      return reject(code, msg);
    }
    modelToResolve = poolRes.canonicalModelId;
  }
  return await resolveTurnExecution(authorityDeps.catalog, modelToResolve);
}

async function verifyGrantsAtEpoch(
  ctx: BridgeConnectionCtx,
  exec: ResolvedTurnExecution,
  log: Logger | null,
  reject: (code: string, message: string) => null,
): Promise<boolean> {
  if (ctx.modelCheckerHandle === null) return true;
  const wantEpoch = BigInt(exec.securityEpoch);
  if (ctx.modelCheckerHandle.epoch() < wantEpoch) {
    try {
      await ctx.modelCheckerHandle.reloadAtLeast(wantEpoch);
    } catch (err) {
      log?.error("user-chat-bridge: grants checker reload failed (fail-closed)", {
        wantEpoch: wantEpoch.toString(),
        err,
      });
      reject("MODEL_AUTHORITY_UNAVAILABLE", "authorization unavailable, retry shortly");
      return false;
    }
    if (ctx.cleaned) return false;
  }
  if (!ctx.modelCheckerHandle.isAllowed(exec.canonicalModel)) {
    log?.info("user-chat-bridge: model authorization revoked mid-connection", {
      model: exec.canonicalModel,
      epoch: wantEpoch.toString(),
    });
    reject("UNAUTHORIZED_MODEL", `model not authorized for current user: ${exec.canonicalModel}`);
    return false;
  }
  return true;
}

export const resolveAuthorityExecOrReject = async (
  ctx: BridgeConnectionCtx,
  args: {
    model: string | null;
    classifiedCodex: boolean;
    log: Logger | null;
    onReject?: (code: string) => void;
    turn?: InboundTurnIdentity;
    allowRemotePlacement?: boolean;
    classifiedRemoteNative?: boolean;
    contextTier?: CursorContextTier | null;
  },
): Promise<ResolvedTurnExecution | null> => {
  const userWs = ctx.userWs;
  const reject = (code: string, message: string): null => {
    args.onReject?.(code);
    if (!ctx.cleaned && userWs.readyState === WebSocket.OPEN) {
      sendErrorFrame(userWs, code, message, args.turn);
    }
    return null;
  };
  if (ctx.authorityDeps === undefined) return null;
  if (args.model === null) {
    args.log?.info("user-chat-bridge: model authority unresolved model");
    return reject(
      "UNRESOLVED_AGENT_MODEL",
      "cannot resolve execution model for this turn — retry shortly or specify a model",
    );
  }
  let exec: ResolvedTurnExecution | null;
  try {
    exec = await resolveModelThroughPool(ctx, args.model, args.turn?.sessionKey ?? null, reject);
    if (exec === null) return null;
  } catch (err) {
    if (err instanceof ModelNotAvailableError) {
      args.log?.info("user-chat-bridge: model not available", { model: args.model });
      return reject("MODEL_NOT_AVAILABLE", `model not available: ${args.model}`);
    }
    args.log?.error("user-chat-bridge: model authority fence failed", { err });
    return reject("MODEL_AUTHORITY_UNAVAILABLE", "model catalog unavailable, retry shortly");
  }
  if (ctx.cleaned) return null;
  if (isCc5TestModel(exec.canonicalModel)) {
    return reject("UNAUTHORIZED_MODEL", "model not authorized for current user");
  }
  if (!desktopAllowsEngine(!!ctx.endpoint.desktop, exec.engine)) {
    args.log?.info("user-chat-bridge: desktop rejects non-ccb engine", { engine: exec.engine });
    return reject("ENGINE_NOT_ENABLED", "desktop runtime only supports the CCB engine");
  }
  const execIsCodex = isNonCcbAuthorityEngine(exec.engine);
  const placementDrift =
    (exec.placement === "remote_pool" && !args.allowRemotePlacement) ||
    (exec.placement !== "remote_pool" && args.classifiedRemoteNative === true);
  if (execIsCodex !== args.classifiedCodex || placementDrift) {
    args.log?.warn("user-chat-bridge: engine reclassified mid-turn", {
      model: args.model,
      canonicalModel: exec.canonicalModel,
      engine: exec.engine,
      classifiedCodex: args.classifiedCodex,
    });
    return reject("MODEL_CONFIG_CHANGED_RETRY_TURN", "model configuration changed, please resend");
  }
  if (!(await verifyGrantsAtEpoch(ctx, exec, args.log, reject))) return null;
  const roleProjectedWindow = projectContextWindowForRole(
    exec.canonicalModel,
    exec.descriptor.contextWindow,
    ctx.userRole,
  );
  const projectedWindow = projectContextWindowForCursorTier(
    exec.canonicalModel,
    roleProjectedWindow,
    args.contextTier ?? null,
  );
  if (projectedWindow !== exec.descriptor.contextWindow) {
    exec = { ...exec, descriptor: { ...exec.descriptor, contextWindow: projectedWindow } };
  }
      return exec;
    };
