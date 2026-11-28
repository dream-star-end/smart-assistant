import { WebSocket } from "ws";
import { isAntigravityEngineModel, parseSwarmSlashCommand } from "@openclaude/protocol";
import { resolveLocalSwarmAllowedAntigravityModels } from "../../billing/antigravityRouteContext.js";
import {
  abandonAntigravityTurn,
  reconcileStaleAntigravityTurns,
  recordAntigravityTurn,
} from "../../billing/antigravitySettle.js";
import { readTotalSpendableBalance } from "../../billing/preCheck.js";
import { publishZcodeCatalogSettle } from "../../billing/zcodeCatalogSettle.js";
import type { ClaimedRecoveryJob } from "../../dispatch/turnRecoveryStore.js";
import { sendErrorFrame } from "../userErrorFrames.js";
import {
  resolveAuthorityExecOrReject,
  sealAuthorityFieldsOrReject,
} from "./connectionAuthority.js";
import {
  dispatchAuthorityField,
  failDispatchPreForward,
  lookupAdmittedDispatch,
  trackSealedMigration,
} from "./connectionDispatch.js";
import { matchesAuthorityEngine } from "./enginePolicy.js";
import { attachMasterTurnState } from "./masterTurnState.js";
import type {
  AdmittedDispatch,
  BridgeConnectionCtx,
  ExternalEngineLaneBaseArgs,
  InboundTurnIdentity,
  ResolvedTurnExecution,
} from "./types.js";
import { ensureRequestIdServerSide } from "./wireHelpers.js";

export interface AntigravityLaneArgs extends ExternalEngineLaneBaseArgs {
  antigravityTurnIdentity: InboundTurnIdentity;
}

async function preflightAntigravityGate(
  args: AntigravityLaneArgs,
  unavailable: (msg: string) => void,
): Promise<string | null> {
  const { ctx, modelCapture } = args;
  const { deps } = ctx.shared;
  if (
    !deps.pgPool ||
    typeof modelCapture !== "string" ||
    !isAntigravityEngineModel(modelCapture) ||
    !deps.admitAntigravityTurn
  ) {
    unavailable("Antigravity is unavailable for this account");
    return null;
  }
  triggerBestEffortAntigravityReconcile(ctx);
  return modelCapture;
}

function triggerBestEffortAntigravityReconcile(ctx: BridgeConnectionCtx): void {
  const { deps } = ctx.shared;
  if (!deps.pgPool || !deps.pricing) return;
  const pool = deps.pgPool;
  const pricing = deps.pricing;
  void reconcileStaleAntigravityTurns({ pool, pricing, userId: ctx.uid })
    .then(async (done) => {
      for (const { settled, turn } of done) {
        await publishZcodeCatalogSettle({
          settled,
          requestId: turn.requestId,
          userId: ctx.uid.toString(),
          modelId: turn.modelId,
          sessionId: turn.sessionId,
          traceId: turn.traceId,
          turnKey: turn.turnKey ?? null,
          parentTurnKey: turn.parentTurnKey ?? null,
          persist: deps.appendCostCredits,
          publish: (event) => {
            ctx.shared.broadcastToUser(ctx.uid, event);
          },
        });
      }
    })
    .catch((err) => {
      ctx.bridgeLog?.warn("user-chat-bridge: antigravity reconcile failed", { err });
    });
}

function resolveAntigravitySwarmConfig(
  ctx: BridgeConnectionCtx,
  parsedCapture: Record<string, unknown>,
  activeAgyModel: string,
  recoveryJob: ClaimedRecoveryJob | undefined,
): {
  allowSwarmMemberModels: boolean;
  forwardedSwarmMode: boolean | undefined;
  swarmAllowedModelIds: readonly string[] | undefined;
} {
  const rawSwarmText =
    parsedCapture.content &&
    typeof parsedCapture.content === "object" &&
    typeof (parsedCapture.content as { text?: unknown }).text === "string"
      ? (parsedCapture.content as { text: string }).text
      : "";
  const explicitSlashSwarm = Boolean(parseSwarmSlashCommand(rawSwarmText)?.matched);
  const isExplicitSwarmTurn = parsedCapture.swarmMode === true || explicitSlashSwarm;
  const isLegacyUnknownCheckpointRecovery =
    typeof parsedCapture.swarmMode !== "boolean" &&
    !explicitSlashSwarm &&
    recoveryJob?.recoveryMode === "checkpoint";
  const allowSwarmMemberModels = isExplicitSwarmTurn || isLegacyUnknownCheckpointRecovery;
  const forwardedSwarmMode: boolean | undefined = isExplicitSwarmTurn
    ? true
    : parsedCapture.swarmMode === false
      ? false
      : recoveryJob
        ? undefined
        : false;
  const catalogSnapshot = ctx.authorityDeps?.catalog.peek() ?? null;
  const { deps } = ctx.shared;
  const swarmAllowedModelIds = allowSwarmMemberModels
    ? resolveLocalSwarmAllowedAntigravityModels({
        primaryModelId: activeAgyModel,
        isAllowedForUser: ctx.modelCheckerHandle
          ? (id) => ctx.modelCheckerHandle!.isAllowed(id)
          : null,
        isCatalogRoutableLocal: catalogSnapshot
          ? (id) => {
              if (!catalogSnapshot.isRoutable(id) || !catalogSnapshot.isAntigravityModel(id)) {
                return false;
              }
              const desc = catalogSnapshot.resolve(id);
              return desc !== null && desc.canonicalModel === id && desc.placement !== "remote_pool";
            }
          : null,
        hasPricing: deps.pricing ? (id) => deps.pricing!.get(id) !== null : null,
      })
    : undefined;
  return { allowSwarmMemberModels, forwardedSwarmMode, swarmAllowedModelIds };
}

async function resolveAntigravitySpendable(
  args: AntigravityLaneArgs,
  dispatchRecord: AdmittedDispatch | undefined,
  unavailable: (msg: string) => void,
): Promise<bigint | null> {
  const { ctx } = args;
  let spendable: bigint;
  try {
    spendable = await readTotalSpendableBalance(ctx.uid);
  } catch (err) {
    args.logCapture?.error("user-chat-bridge: antigravity spendable lookup failed", { err });
    failDispatchPreForward(ctx, dispatchRecord, "antigravity_spendable_unavailable");
    unavailable("Antigravity billing is temporarily unavailable");
    return null;
  }
  if (spendable <= 0n) {
    args.rejectPromptQueueDispatch("ERR_INSUFFICIENT_CREDITS");
    failDispatchPreForward(ctx, dispatchRecord, "insufficient_credits");
    if (!ctx.cleaned && ctx.userWs.readyState === WebSocket.OPEN) {
      sendErrorFrame(
        ctx.userWs,
        "ERR_INSUFFICIENT_CREDITS",
        `insufficient credits: balance=${spendable} required=1`,
        args.antigravityTurnIdentity,
      );
    }
    return null;
  }
  return spendable;
}

async function mintAndForwardAntigravityTurn(args: {
  lane: AntigravityLaneArgs;
  enriched: Record<string, unknown>;
  dispatchRecord: AdmittedDispatch | undefined;
  authorityExec: ResolvedTurnExecution | null;
  antigravityModelId: string;
  activeAgyModel: string;
  spendable: bigint;
  onMinted: (token: string, requestId: string) => void;
  dropMinted: () => void;
  unavailable: (msg: string) => void;
}): Promise<void> {
  const { lane, enriched, dispatchRecord, authorityExec, activeAgyModel, spendable } = args;
  const { ctx, logCapture, peerCapture } = lane;
  const { deps } = ctx.shared;
  if (!deps.admitAntigravityTurn || !deps.pgPool) return;
  const requestId = dispatchRecord ? dispatchRecord.billingRequestId : ensureRequestIdServerSide();
  const swarmCfg = resolveAntigravitySwarmConfig(ctx, lane.parsedCapture, activeAgyModel, lane.recoveryJob);
  let minted: Awaited<ReturnType<NonNullable<typeof deps.admitAntigravityTurn>>>;
  try {
    minted = await deps.admitAntigravityTurn({
      containerId: lane.cid,
      userId: ctx.uid,
      requestId,
      modelId: activeAgyModel,
      budgetCredits: spendable,
      ...(swarmCfg.swarmAllowedModelIds ? { allowedModelIds: swarmCfg.swarmAllowedModelIds } : {}),
    });
  } catch (err) {
    logCapture?.error("user-chat-bridge: Antigravity admission failed", {
      code: err instanceof Error ? err.message : "unknown",
    });
    failDispatchPreForward(ctx, dispatchRecord, "antigravity_admission_failed");
    args.unavailable(
      err instanceof Error && err.message === "ANTIGRAVITY_MODEL_COOLING_DOWN"
        ? "This Antigravity model has no upstream capacity right now; retry in a few minutes or pick another model"
        : "Antigravity is temporarily unavailable",
    );
    return;
  }
  args.onMinted(minted.token, requestId);
  await recordAntigravityTurn(deps.pgPool, {
    requestId, userId: ctx.uid, modelId: activeAgyModel, sessionId: peerCapture, traceId: lane.traceCapture,
  });
  ctx.pendingAntigravityRelays.set(requestId, {
    token: minted.token, modelId: activeAgyModel, sessionId: peerCapture, traceId: lane.traceCapture,
  });
  await sealAndForwardAntigravityFrame({
    lane, enriched, dispatchRecord, authorityExec,
    antigravityModelId: args.antigravityModelId,
    requestId, spendable, minted, swarmCfg, dropMinted: args.dropMinted,
  });
}

async function sealAndForwardAntigravityFrame(args: {
  lane: AntigravityLaneArgs;
  enriched: Record<string, unknown>;
  dispatchRecord: AdmittedDispatch | undefined;
  authorityExec: ResolvedTurnExecution | null;
  antigravityModelId: string;
  requestId: string;
  spendable: bigint;
  minted: Awaited<ReturnType<NonNullable<BridgeConnectionCtx["shared"]["deps"]["admitAntigravityTurn"]>>>;
  swarmCfg: ReturnType<typeof resolveAntigravitySwarmConfig>;
  dropMinted: () => void;
}): Promise<void> {
  const { lane, enriched, dispatchRecord, authorityExec, requestId, spendable, minted, swarmCfg } = args;
  const { ctx, logCapture, antigravityTurnIdentity, peerCapture, rejectPromptQueueDispatch } = lane;
  let authorityFields: Record<string, unknown> = {};
  if (authorityExec !== null) {
    const sealed = await sealAuthorityFieldsOrReject(ctx, {
      exec: authorityExec,
      billingRequestId: requestId,
      log: logCapture,
      onReject: rejectPromptQueueDispatch,
      turn: antigravityTurnIdentity,
      ...(peerCapture ? { sessionId: peerCapture } : {}),
      historicalMessages: Array.isArray(enriched._masterHistoricalMessages)
        ? (enriched._masterHistoricalMessages as readonly unknown[])
        : undefined,
      ...(antigravityTurnIdentity.clientMessageId
        ? { excludeClientMessageId: antigravityTurnIdentity.clientMessageId }
        : {}),
      enableCrossPoolCheckpoint: true,
    });
    if (sealed === null) {
      failDispatchPreForward(ctx, dispatchRecord, "antigravity_authority_seal_rejected");
      args.dropMinted();
      return;
    }
    authorityFields = sealed;
    trackSealedMigration(ctx, dispatchRecord, antigravityTurnIdentity.sessionKey, sealed);
  }
  const { swarmMode: _droppedSwarmMode, ...enrichedForAntigravity } = enriched;
  void _droppedSwarmMode;
  const forwarded = {
    ...enrichedForAntigravity,
    requestId,
    traceId: lane.traceCapture,
    _creditBudget: spendable.toString(),
    __oc_antigravity_route: {
      baseUrl: minted.baseUrl,
      routeToken: minted.token,
      accessToken: minted.accessToken,
      accessTokenExpiresAt: minted.accessTokenExpiresAt,
      ...(minted.idToken ? { idToken: minted.idToken } : {}),
    },
    ...(swarmCfg.forwardedSwarmMode !== undefined ? { swarmMode: swarmCfg.forwardedSwarmMode } : {}),
    ...(swarmCfg.allowSwarmMemberModels
      ? { _antigravitySwarmAllowedModels: minted.allowedModelIds ?? [args.antigravityModelId] }
      : {}),
    ...authorityFields,
    ...dispatchAuthorityField(ctx, dispatchRecord),
  };
  const encoded = JSON.stringify(forwarded);
  const len = Buffer.byteLength(encoded);
  if (len > ctx.shared.config.maxFrameBytes) {
    failDispatchPreForward(ctx, dispatchRecord, "ERR_FRAME_TOO_BIG");
    rejectPromptQueueDispatch("ERR_FRAME_TOO_BIG");
    args.dropMinted();
    return;
  }
  await lane.forwardPreparedFrame(Buffer.from(encoded, "utf8"), false, len, dispatchRecord);
}

export async function executeAntigravityTurnLane(args: AntigravityLaneArgs): Promise<void> {
  const { ctx, logCapture, antigravityTurnIdentity, rejectPromptQueueDispatch } = args;
  const { deps } = ctx.shared;
  let dispatchRecord: AdmittedDispatch | undefined;
  let mintedToken: string | null = null;
  let mintedRequestId: string | null = null;
  const dropMinted = (): void => {
    if (mintedToken !== null) {
      void Promise.resolve(deps.expireAntigravityRoute?.(mintedToken)).catch((err) => {
        void err;
      });
    }
    if (mintedRequestId !== null) {
      ctx.pendingAntigravityRelays.delete(mintedRequestId);
      if (deps.pgPool) {
        void abandonAntigravityTurn(deps.pgPool, mintedRequestId, ctx.uid).catch((err) => {
          void err;
        });
      }
    }
    mintedToken = null;
    mintedRequestId = null;
  };
  const unavailable = (message: string): void => {
    rejectPromptQueueDispatch("ANTIGRAVITY_UNAVAILABLE");
    if (!ctx.cleaned && ctx.userWs.readyState === WebSocket.OPEN) {
      sendErrorFrame(ctx.userWs, "ANTIGRAVITY_UNAVAILABLE", message, antigravityTurnIdentity);
    }
  };
  try {
    const antigravityModelId = await preflightAntigravityGate(args, unavailable);
    if (antigravityModelId === null) return;
    const enriched = await attachMasterTurnState(
      ctx,
      args.parsedCapture,
      logCapture,
      args.traceCapture,
      args.persistUserRow,
      rejectPromptQueueDispatch,
      args.authorityModelCapture,
      args.recoveryJob,
      args.pretrackedEnrichment,
    );
    if (enriched === null) return;
    dispatchRecord = lookupAdmittedDispatch(ctx, enriched);
    let authorityExec: ResolvedTurnExecution | null = null;
    if (ctx.authorityOn) {
      authorityExec = await resolveAuthorityExecOrReject(ctx, {
        model: args.authorityModelCapture,
        classifiedCodex: true,
        log: logCapture,
        onReject: rejectPromptQueueDispatch,
        turn: antigravityTurnIdentity,
      });
      if (
        authorityExec === null ||
        !matchesAuthorityEngine(authorityExec.engine, "antigravity") ||
        (!deps.resolveLogicalModelPoolTarget && authorityExec.canonicalModel !== antigravityModelId)
      ) {
        failDispatchPreForward(ctx, dispatchRecord, "antigravity_authority_rejected");
        return;
      }
    }
    const activeAgyModel = authorityExec?.canonicalModel ?? antigravityModelId;
    const spendable = await resolveAntigravitySpendable(args, dispatchRecord, unavailable);
    if (spendable === null) return;
    await mintAndForwardAntigravityTurn({
      lane: args,
      enriched,
      dispatchRecord,
      authorityExec,
      antigravityModelId,
      activeAgyModel,
      spendable,
      onMinted: (token, requestId) => {
        mintedToken = token;
        mintedRequestId = requestId;
      },
      dropMinted,
      unavailable,
    });
  } catch (err) {
    logCapture?.error("user-chat-bridge: Antigravity admission threw", { err });
    failDispatchPreForward(ctx, dispatchRecord, "antigravity_admission_failed");
    dropMinted();
    unavailable("Antigravity is temporarily unavailable");
  }
}
