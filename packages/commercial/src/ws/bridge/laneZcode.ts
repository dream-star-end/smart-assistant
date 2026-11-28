import { WebSocket } from "ws";
import { isZcodeEngineModel } from "@openclaude/protocol";
import { readTotalSpendableBalance } from "../../billing/preCheck.js";
import {
  abortInsertedZcodeAudit,
  insertPendingZcodeAudit,
  rememberZcodePending,
  zcodeAdmissionAbortTerminal,
} from "../../billing/zcodeExternalAudit.js";
import { sendErrorFrame } from "../userErrorFrames.js";
import {
  resolveAuthorityExecOrReject,
  sealAuthorityFieldsOrReject,
} from "./connectionAuthority.js";
import {
  dispatchAuthorityField,
  failDispatchPreForward as failDispatchPreForwardImpl,
  lookupAdmittedDispatch,
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

export interface ZcodeLaneArgs extends ExternalEngineLaneBaseArgs {
  zcodeTurnIdentity: InboundTurnIdentity;
}

async function abortZcodeAudit(
  ctx: BridgeConnectionCtx,
  insertedRequestId: string | null,
  step: "seal_rejected" | "frame_too_big" | "send_failed",
): Promise<void> {
  const { deps } = ctx.shared;
  if (insertedRequestId !== null) {
    const relay = ctx.pendingZcodeRelays.get(insertedRequestId);
    if (relay) {
      deps.expireZcodeRoute?.(relay.token);
      ctx.pendingZcodeRelays.delete(insertedRequestId);
    }
  }
  if (!deps.pgPool || insertedRequestId === null) return;
  const work = abortInsertedZcodeAudit(deps.pgPool, {
    requestId: insertedRequestId,
    userId: ctx.uid,
    pending: ctx.pendingZcodeRequestIds,
    terminalCode: zcodeAdmissionAbortTerminal(step),
  }).then(() => undefined);
  ctx.shared.trackZcodeAuditWork(work);
  await work;
}

async function resolveZcodeSpendable(
  args: ZcodeLaneArgs,
  dispatchRecord: AdmittedDispatch | undefined,
): Promise<bigint | null> {
  const { ctx, zcodeTurnIdentity, rejectPromptQueueDispatch } = args;
  const userWs = ctx.userWs;
  const uid = ctx.uid;
  const failDispatchPreForward = (rec: AdmittedDispatch | undefined, code: string) =>
    failDispatchPreForwardImpl(ctx, rec, code);
  let zcodeSpendable: bigint;
  try {
    zcodeSpendable = await readTotalSpendableBalance(uid);
  } catch (err) {
    args.logCapture?.error("user-chat-bridge: zcode spendable lookup failed", { err });
    rejectPromptQueueDispatch("ZCODE_UNAVAILABLE");
    failDispatchPreForward(dispatchRecord, 'zcode_spendable_unavailable');
    if (!ctx.cleaned && userWs.readyState === WebSocket.OPEN) {
      sendErrorFrame(userWs, "ZCODE_UNAVAILABLE", "ZCode billing is temporarily unavailable", zcodeTurnIdentity);
    }
    return null;
  }
  if (zcodeSpendable <= 0n) {
    rejectPromptQueueDispatch('ERR_INSUFFICIENT_CREDITS');
    failDispatchPreForward(dispatchRecord, 'insufficient_credits');
    if (!ctx.cleaned && userWs.readyState === WebSocket.OPEN) {
      sendErrorFrame(
        userWs,
        'ERR_INSUFFICIENT_CREDITS',
        `insufficient credits: balance=${zcodeSpendable} required=1`,
        zcodeTurnIdentity,
      );
    }
    return null;
  }
  return zcodeSpendable;
}

async function mintAuditSealAndForwardZcode(args: {
  lane: ZcodeLaneArgs;
  enriched: Record<string, unknown>;
  dispatchRecord: AdmittedDispatch | undefined;
  authorityExec: ResolvedTurnExecution | null;
  activeZcodeModel: string;
  canary: boolean;
  zcodeSpendable: bigint;
  setInsertedRequestId: (id: string) => void;
  abortInserted: (step: "seal_rejected" | "frame_too_big" | "send_failed") => Promise<void>;
}): Promise<void> {
  const { lane, enriched, dispatchRecord, authorityExec, activeZcodeModel, zcodeSpendable } = args;
  const { ctx, logCapture, zcodeTurnIdentity, rejectPromptQueueDispatch } = lane;
  const { deps } = ctx.shared;
  if (!deps.mintZcodeRoute) return;
  const requestId = dispatchRecord ? dispatchRecord.billingRequestId : ensureRequestIdServerSide();
  let minted: { token: string; baseUrl: string };
  try {
    minted = await deps.mintZcodeRoute({
      containerId: lane.cid,
      userId: ctx.uid,
      requestId,
      modelId: activeZcodeModel,
    });
  } catch (err) {
    logCapture?.error("user-chat-bridge: ZCode relay mint failed", { err });
    rejectPromptQueueDispatch("ZCODE_UNAVAILABLE");
    sendErrorFrame(ctx.userWs, "ZCODE_UNAVAILABLE", "ZCode is temporarily unavailable", zcodeTurnIdentity);
    return;
  }
  ctx.pendingZcodeRelays.set(requestId, {
    token: minted.token,
    modelId: activeZcodeModel,
    sessionId: lane.peerCapture,
    traceId: lane.traceCapture,
  });
  args.setInsertedRequestId(requestId);
  if (args.canary) {
    await insertPendingZcodeAudit(deps.pgPool!, {
      requestId,
      userId: ctx.uid,
      containerId: lane.cid,
      sessionId: lane.peerCapture,
      modelId: activeZcodeModel,
    });
    rememberZcodePending(ctx.pendingZcodeRequestIds, requestId);
    ctx.shared.ensureZcodeStaleReconcile();
  }
  let authorityFields: Record<string, unknown> = {};
  if (authorityExec !== null) {
    const sealed = await sealAuthorityFieldsOrReject(ctx, {
      exec: authorityExec,
      billingRequestId: requestId,
      inboundFrame: enriched,
      log: logCapture,
      onReject: rejectPromptQueueDispatch,
      turn: zcodeTurnIdentity,
    });
    if (sealed === null) {
      failDispatchPreForwardImpl(ctx, dispatchRecord, "zcode_authority_seal_rejected");
      deps.expireZcodeRoute?.(minted.token);
      ctx.pendingZcodeRelays.delete(requestId);
      await args.abortInserted("seal_rejected");
      return;
    }
    authorityFields = sealed;
  }
  const forwarded = {
    ...enriched,
    requestId,
    traceId: lane.traceCapture,
    _creditBudget: zcodeSpendable.toString(),
    __oc_zcode_route: { baseUrl: minted.baseUrl, routeToken: minted.token },
    ...authorityFields,
    ...dispatchAuthorityField(ctx, dispatchRecord),
  };
  const encoded = JSON.stringify(forwarded);
  const len = Buffer.byteLength(encoded);
  if (len > ctx.shared.config.maxFrameBytes) {
    failDispatchPreForwardImpl(ctx, dispatchRecord, "ERR_FRAME_TOO_BIG");
    rejectPromptQueueDispatch("ERR_FRAME_TOO_BIG");
    deps.expireZcodeRoute?.(minted.token);
    ctx.pendingZcodeRelays.delete(requestId);
    await args.abortInserted("frame_too_big");
    return;
  }
  await lane.forwardPreparedFrame(Buffer.from(encoded, "utf8"), false, len, dispatchRecord);
}

export async function executeZcodeTurnLane(args: ZcodeLaneArgs): Promise<void> {
  const { ctx, logCapture, zcodeTurnIdentity, rejectPromptQueueDispatch } = args;
  const { deps } = ctx.shared;
  let dispatchRecord: AdmittedDispatch | undefined;
  let insertedRequestId: string | null = null;
  const abortInserted = (step: "seal_rejected" | "frame_too_big" | "send_failed"): Promise<void> =>
    abortZcodeAudit(ctx, insertedRequestId, step);
  try {
    const modelCapture = args.modelCapture;
    const canary = typeof modelCapture === "string" && isZcodeEngineModel(modelCapture);
    const publicCanonical = modelCapture === "glm-5.3-zai";
    if (!deps.pgPool || typeof modelCapture !== "string" || (!canary && !publicCanonical)) {
      rejectPromptQueueDispatch("ZCODE_UNAVAILABLE");
      sendErrorFrame(ctx.userWs, "ZCODE_UNAVAILABLE", "ZCode is unavailable for this account", zcodeTurnIdentity);
      return;
    }
    const zcodeModelId = modelCapture;
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
        turn: zcodeTurnIdentity,
      });
      if (
        authorityExec === null ||
        !matchesAuthorityEngine(authorityExec.engine, "zcode") ||
        (!deps.resolveLogicalModelPoolTarget && authorityExec.canonicalModel !== zcodeModelId)
      ) {
        failDispatchPreForwardImpl(ctx, dispatchRecord, "zcode_authority_rejected");
        return;
      }
    }
    if (!deps.mintZcodeRoute) {
      rejectPromptQueueDispatch("ZCODE_UNAVAILABLE");
      sendErrorFrame(ctx.userWs, "ZCODE_UNAVAILABLE", "ZCode is unavailable for this account", zcodeTurnIdentity);
      return;
    }
    const zcodeSpendable = await resolveZcodeSpendable(args, dispatchRecord);
    if (zcodeSpendable === null) return;
    await mintAuditSealAndForwardZcode({
      lane: args,
      enriched,
      dispatchRecord,
      authorityExec,
      activeZcodeModel: authorityExec?.canonicalModel ?? zcodeModelId,
      canary,
      zcodeSpendable,
      setInsertedRequestId: (id) => {
        insertedRequestId = id;
      },
      abortInserted,
    });
  } catch (err) {
    logCapture?.error("user-chat-bridge: ZCode external admission failed", { err });
    failDispatchPreForwardImpl(ctx, dispatchRecord, "zcode_external_admission_failed");
    rejectPromptQueueDispatch("ZCODE_UNAVAILABLE");
    await abortInserted("send_failed");
    if (!ctx.cleaned && ctx.userWs.readyState === WebSocket.OPEN) {
      sendErrorFrame(ctx.userWs, "ZCODE_UNAVAILABLE", "ZCode is temporarily unavailable", zcodeTurnIdentity);
    }
  }
}
