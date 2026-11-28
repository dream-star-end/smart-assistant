import type { Pool } from "pg";
import { WebSocket } from "ws";
import {
  BOX_GPT_WEB_BUSY_MESSAGE,
  isBoxGptWebModel,
  isCc5TestModel,
  isCursorContextTier,
  isCursorEngineModel,
} from "@openclaude/protocol";
import { readTotalSpendableBalance } from "../../billing/preCheck.js";
import { bindAuthorityTurnDispatch } from "../../billing/verificationSponsorship.js";
import { isBoxGptWebAllowedUser, isCursorCredentialMember } from "../../cursor/access.js";
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
import { CLOSE_BRIDGE } from "./constants.js";
import { matchesAuthorityEngine } from "./enginePolicy.js";
import { attachMasterTurnState } from "./masterTurnState.js";
import type {
  AdmittedDispatch,
  ExternalEngineLaneBaseArgs,
  InboundTurnIdentity,
  ResolvedTurnExecution,
} from "./types.js";
import {
  closeWsSafely,
  ensureRequestIdServerSide,
  isCursorContainerOnSelfHost,
} from "./wireHelpers.js";

export interface CursorLaneArgs extends ExternalEngineLaneBaseArgs {
  cursorTurnIdentity: InboundTurnIdentity;
}

async function preflightCursorGates(args: CursorLaneArgs): Promise<boolean> {
  const { ctx, modelCapture, cursorTurnIdentity, rejectPromptQueueDispatch } = args;
  const { deps } = ctx.shared;
  const userWs = ctx.userWs;
  const uid = ctx.uid;
  if (!deps.pgPool || !isCursorEngineModel(modelCapture)) {
    rejectPromptQueueDispatch("CURSOR_UNAVAILABLE");
    sendErrorFrame(userWs, "CURSOR_UNAVAILABLE", "Cursor is unavailable for this account", cursorTurnIdentity);
    return false;
  }
  if (isCc5TestModel(modelCapture) || !isCursorCredentialMember(uid)) {
    rejectPromptQueueDispatch("UNAUTHORIZED_MODEL");
    sendErrorFrame(userWs, 'UNAUTHORIZED_MODEL', 'Cursor is not enabled for this account', cursorTurnIdentity);
    return false;
  }
  if (isBoxGptWebModel(modelCapture) && !isBoxGptWebAllowedUser(uid)) {
    rejectPromptQueueDispatch("UNAUTHORIZED_MODEL");
    sendErrorFrame(
      userWs,
      "UNAUTHORIZED_MODEL",
      "gpt-6-astra-pro is not enabled for this account",
      cursorTurnIdentity,
    );
    return false;
  }
  const eligible = await isCursorContainerOnSelfHost(deps.pgPool, args.cid, uid, deps.selfHostId);
  if (!eligible) {
    rejectPromptQueueDispatch("CURSOR_UNAVAILABLE");
    sendErrorFrame(userWs, 'CURSOR_UNAVAILABLE', 'Cursor requires the account-owned local runtime', cursorTurnIdentity);
    return false;
  }
  if (isBoxGptWebModel(modelCapture)) {
    const busyPre = await deps.pgPool.query<{ dispatch_id: string }>(
      `SELECT dispatch_id
         FROM turn_dispatches
        WHERE (model = $1 OR ($3::text IS NOT NULL AND model = $3))
          AND status IN ('admitted', 'accepted')
          AND (lease_until IS NULL OR lease_until > NOW())
          AND ($2::text IS NULL OR client_message_id <> $2)
        LIMIT 1`,
      [modelCapture, cursorTurnIdentity.clientMessageId, args.authorityModelCapture],
    );
    if (busyPre.rows.length > 0) {
      rejectPromptQueueDispatch("CURSOR_UNAVAILABLE");
      sendErrorFrame(userWs, "CURSOR_UNAVAILABLE", BOX_GPT_WEB_BUSY_MESSAGE, cursorTurnIdentity);
      return false;
    }
  }
  return true;
}

async function checkBoxGptWebPostAdmitBusy(
  pool: Pool,
  args: CursorLaneArgs,
  dispatchRecord: AdmittedDispatch | undefined,
): Promise<boolean> {
  if (!isBoxGptWebModel(args.modelCapture) || dispatchRecord === undefined) return false;
  const busyPost = await pool.query<{ dispatch_id: string }>(
    `SELECT dispatch_id
       FROM turn_dispatches
      WHERE (model = $1 OR ($3::text IS NOT NULL AND model = $3))
        AND status IN ('admitted', 'accepted')
        AND (lease_until IS NULL OR lease_until > NOW())
        AND dispatch_id <> $2
      LIMIT 1`,
    [args.modelCapture, dispatchRecord.dispatchId, args.authorityModelCapture],
  );
  if (busyPost.rows.length === 0) return false;
  args.rejectPromptQueueDispatch("CURSOR_UNAVAILABLE");
  failDispatchPreForwardImpl(args.ctx, dispatchRecord, "box_gpt_web_busy");
  if (!args.ctx.cleaned && args.ctx.userWs.readyState === WebSocket.OPEN) {
    sendErrorFrame(args.ctx.userWs, "CURSOR_UNAVAILABLE", BOX_GPT_WEB_BUSY_MESSAGE, args.cursorTurnIdentity);
  }
  return true;
}

async function checkCursorBalanceAndInsertAudit(
  args: CursorLaneArgs,
  activeCursorModel: string,
  requestId: string,
  dispatchRecord: AdmittedDispatch | undefined,
): Promise<{ ok: true; cursorSpendable: bigint | null } | { ok: false }> {
  const { ctx, cursorTurnIdentity, peerCapture, cid, rejectPromptQueueDispatch } = args;
  const { deps } = ctx.shared;
  const uid = ctx.uid;
  const cursorBilled = !isBoxGptWebModel(activeCursorModel);
  let cursorSpendable: bigint | null = null;
  try {
    if (cursorBilled) cursorSpendable = await readTotalSpendableBalance(uid);
  } catch (err) {
    args.logCapture?.error("user-chat-bridge: cursor spendable lookup failed", { err });
    rejectPromptQueueDispatch("CURSOR_UNAVAILABLE");
    failDispatchPreForwardImpl(ctx, dispatchRecord, "cursor_spendable_unavailable");
    if (!ctx.cleaned && ctx.userWs.readyState === WebSocket.OPEN) {
      sendErrorFrame(ctx.userWs, "CURSOR_UNAVAILABLE", "Cursor billing is temporarily unavailable", cursorTurnIdentity);
    }
    return { ok: false };
  }
  if (cursorSpendable !== null && cursorSpendable <= 0n) {
    rejectPromptQueueDispatch("ERR_INSUFFICIENT_CREDITS");
    failDispatchPreForwardImpl(ctx, dispatchRecord, "insufficient_credits");
    if (!ctx.cleaned && ctx.userWs.readyState === WebSocket.OPEN) {
      sendErrorFrame(
        ctx.userWs,
        "ERR_INSUFFICIENT_CREDITS",
        `insufficient credits: balance=${cursorSpendable} required=1`,
        cursorTurnIdentity,
      );
      closeWsSafely(ctx.userWs, CLOSE_BRIDGE.BILLING_POLICY, "insufficient_credits");
    }
    return { ok: false };
  }
  if (!deps.pgPool) return { ok: false };
  if (!isBoxGptWebModel(activeCursorModel)) {
    await deps.pgPool.query(
      `INSERT INTO cursor_external_usage_audit(request_id,user_id,container_id,session_id,model_id,status)
       VALUES($1,$2,$3,$4,$5,'pending') ON CONFLICT (request_id) DO NOTHING`,
      [requestId, uid, cid, peerCapture, activeCursorModel],
    );
  }
  return { ok: true, cursorSpendable };
}

function isCursorAuthorityMismatch(
  args: CursorLaneArgs,
  authorityExec: ResolvedTurnExecution | null,
): boolean {
  const { ctx, modelCapture } = args;
  if (!ctx.authorityOn) return false;
  if (authorityExec === null || !matchesAuthorityEngine(authorityExec.engine, "cursor")) return true;
  if (authorityExec.canonicalModel !== modelCapture) {
    return (
      !ctx.shared.deps.resolveLogicalModelPoolTarget ||
      isBoxGptWebModel(authorityExec.canonicalModel) !== isBoxGptWebModel(modelCapture)
    );
  }
  return false;
}

async function bindAndSealCursorTurn(
  args: CursorLaneArgs,
  enriched: Record<string, unknown>,
  dispatchRecord: AdmittedDispatch | undefined,
  authorityExec: ResolvedTurnExecution | null,
): Promise<{ requestId: string; cursorSpendable: bigint | null; authorityFields: Record<string, unknown> } | null> {
  const { ctx } = args;
  const signer = ctx.authorityDeps?.signer;
  const failDispatchPreForward = (rec: AdmittedDispatch | undefined, code: string) =>
    failDispatchPreForwardImpl(ctx, rec, code);
  if (isCursorAuthorityMismatch(args, authorityExec)) {
    failDispatchPreForward(dispatchRecord, 'cursor_authority_rejected');
    return null;
  }
  const activeCursorModel = authorityExec?.canonicalModel ?? (args.modelCapture as string);
  const cursorAuthorityTurnId =
    authorityExec === null || !signer ? undefined : signer.mintAuthorityTurnId();
  if (cursorAuthorityTurnId !== undefined && dispatchRecord !== undefined && authorityExec !== null) {
    const bound = await bindCursorTurnDispatch(
      args, enriched, dispatchRecord, authorityExec, cursorAuthorityTurnId,
    );
    if (!bound) return null;
  }
  const requestId = dispatchRecord ? dispatchRecord.billingRequestId : ensureRequestIdServerSide();
  const bal = await checkCursorBalanceAndInsertAudit(args, activeCursorModel, requestId, dispatchRecord);
  if (!bal.ok) return null;
  const authorityFields = await sealCursorAuthorityFields(
    args, dispatchRecord, authorityExec, requestId, cursorAuthorityTurnId,
  );
  if (authorityFields === null) return null;
  return { requestId, cursorSpendable: bal.cursorSpendable, authorityFields };
}

async function bindCursorTurnDispatch(
  args: CursorLaneArgs,
  enriched: Record<string, unknown>,
  dispatchRecord: AdmittedDispatch,
  authorityExec: ResolvedTurnExecution,
  cursorAuthorityTurnId: string,
): Promise<boolean> {
  const { ctx, cursorTurnIdentity, logCapture, rejectPromptQueueDispatch } = args;
  try {
    await bindAuthorityTurnDispatch(ctx.shared.deps.pgPool!, {
      authorityTurnId: cursorAuthorityTurnId,
      dispatchId: dispatchRecord.dispatchId,
      userId: ctx.uid,
      sessionId: dispatchRecord.sessionId,
      dispatchModel: typeof enriched.model === "string" ? enriched.model : null,
      canonicalModel: authorityExec.canonicalModel,
      attemptNo: dispatchRecord.attemptNo,
      ownerId: dispatchRecord.leaseOwnerId,
      leaseEpoch: dispatchRecord.leaseEpoch,
      ...(ctx.containerId !== undefined
        ? { agentContainerId: ctx.containerId, runtimeKind: ctx.endpoint.desktop ? "desktop" : "docker" }
        : {}),
    });
    return true;
  } catch (err) {
    logCapture?.error("user-chat-bridge: cursor authority turn dispatch binding failed", {
      err, dispatchId: dispatchRecord.dispatchId,
    });
    rejectPromptQueueDispatch('DURABLE_DISPATCH_UNAVAILABLE');
    failDispatchPreForwardImpl(ctx, dispatchRecord, "authority_turn_dispatch_unavailable");
    if (!ctx.cleaned && ctx.userWs.readyState === WebSocket.OPEN) {
      sendErrorFrame(
        ctx.userWs, "DURABLE_DISPATCH_UNAVAILABLE",
        "durable dispatch attribution unavailable, retry this turn shortly", cursorTurnIdentity,
      );
    }
    return false;
  }
}

async function sealCursorAuthorityFields(
  args: CursorLaneArgs,
  dispatchRecord: AdmittedDispatch | undefined,
  authorityExec: ResolvedTurnExecution | null,
  requestId: string,
  cursorAuthorityTurnId: string | undefined,
): Promise<Record<string, unknown> | null> {
  if (authorityExec === null) return {};
  const { ctx, cursorTurnIdentity, logCapture, rejectPromptQueueDispatch } = args;
  const sealed = await sealAuthorityFieldsOrReject(ctx, {
    exec: authorityExec,
    billingRequestId: requestId,
    ...(cursorAuthorityTurnId === undefined ? {} : { authorityTurnId: cursorAuthorityTurnId }),
    log: logCapture,
    onReject: rejectPromptQueueDispatch,
    turn: cursorTurnIdentity,
  });
  if (sealed === null) {
    failDispatchPreForwardImpl(ctx, dispatchRecord, "cursor_authority_seal_rejected");
    return null;
  }
  return sealed;
}

export async function executeCursorTurnLane(args: CursorLaneArgs): Promise<void> {
  const { ctx, cursorTurnIdentity, logCapture, rejectPromptQueueDispatch } = args;
  let dispatchRecord: AdmittedDispatch | undefined;
  try {
    if (!(await preflightCursorGates(args))) return;
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
    if (await checkBoxGptWebPostAdmitBusy(ctx.shared.deps.pgPool!, args, dispatchRecord)) return;
    let authorityExec: ResolvedTurnExecution | null = null;
    if (ctx.authorityOn) {
      authorityExec = await resolveAuthorityExecOrReject(ctx, {
        model: args.authorityModelCapture,
        classifiedCodex: true,
        log: logCapture,
        onReject: rejectPromptQueueDispatch,
        turn: cursorTurnIdentity,
        contextTier: isCursorContextTier(enriched.contextTier) ? enriched.contextTier : null,
      });
    }
    const sealed = await bindAndSealCursorTurn(args, enriched, dispatchRecord, authorityExec);
    if (sealed === null) return;
    const { requestId, cursorSpendable, authorityFields } = sealed;
    const forwarded = {
      ...enriched,
      requestId,
      traceId: args.traceCapture,
      _creditBudget: cursorSpendable === null ? undefined : cursorSpendable.toString(),
      ...authorityFields,
      ...dispatchAuthorityField(ctx, dispatchRecord),
    };
    const encoded = JSON.stringify(forwarded);
    const len = Buffer.byteLength(encoded);
    if (len > ctx.shared.config.maxFrameBytes) {
      failDispatchPreForwardImpl(ctx, dispatchRecord, "ERR_FRAME_TOO_BIG");
      rejectPromptQueueDispatch("ERR_FRAME_TOO_BIG");
      return;
    }
    await args.forwardPreparedFrame(Buffer.from(encoded, "utf8"), false, len, dispatchRecord);
  } catch (err) {
    logCapture?.error("user-chat-bridge: Cursor external admission failed", { err });
    failDispatchPreForwardImpl(ctx, dispatchRecord, "cursor_external_admission_failed");
    rejectPromptQueueDispatch("CURSOR_UNAVAILABLE");
    if (!ctx.cleaned && ctx.userWs.readyState === WebSocket.OPEN) {
      sendErrorFrame(ctx.userWs, "CURSOR_UNAVAILABLE", "Cursor is temporarily unavailable", cursorTurnIdentity);
    }
  }
}
