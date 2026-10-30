/** Fully bound journal continuation claim; its transaction precedes every remote write. */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { BoxDurableJournalError, lock, type BoxToolResumeClaim } from "./boxDurableJournal.js";
import { deriveBoxImageIdentity } from "./boxImageIdentity.js";
import { consumePrepared, PreparedConsumptionError, trustedIdentitiesBind, authorityFromJournalCtx,
  type AuthorityProjection, type PreparedContinuation, type PreparedConsumption } from "./boxPreparedContinuation.js";
import { parseBoxStoredToolHandoff } from "./boxStoredToolHandoff.js";
import { BOX_PROMPT_LAYOUT_STATIC_FIRST } from "./boxNativePointer.js";
import { boxCatalogMatching } from "./boxToolCatalog.js";
import { comparableAssistantContent } from "./boxToolInputEcho.js";
import { incomingAssistantAccepted } from "./boxCallFingerprint.js";
import { matchPreparedToolResults, type BoxMatchedToolResult } from "./boxToolResultMatcher.js";
import { normalizeBoxResultImagesForCli } from "./boxToolResultImages.js";
import { parseBoxBillingContext } from "./boxBillingContext.js";
import { parseBillingPricing } from "../../billing/persistedBillingPricing.js";
import type { ProxyBody } from "./shared.js";
import { claimToolRollover, BoxToolRolloverRequired } from "./boxToolRollover.js";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export interface BoxToolResumeInput { requestId: string; uid: bigint; canonicalModel: string;
  canonicalBody: ProxyBody; trustedAuthority?: AuthorityProjection; prepared?: PreparedContinuation }
export async function claimBoundBoxToolResume(pool: Pick<Pool,"connect"|"query">,
  input: BoxToolResumeInput, resumeLookupBarrier: (() => Promise<void>) | null): Promise<BoxToolResumeClaim> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.requestId)
      || input.uid <= 0n || input.canonicalBody.model !== input.canonicalModel) {
      throw new BoxDurableJournalError("BOX_TOOL_RESUME_IDENTITY_INVALID");
    }
    let view: PreparedConsumption;
    try {
      view = consumePrepared({
        uid: input.uid, canonicalModel: input.canonicalModel,
        canonicalBody: input.canonicalBody, prepared: input.prepared,
        trustedAuthority: input.trustedAuthority,
        allowPrepareOnce: input.prepared === undefined,
      });
    } catch (error) {
      if (error instanceof PreparedConsumptionError) {
        throw new BoxDurableJournalError(error.code === "BOX_PREPARED_REJECT"
          ? "BOX_TOOL_RESUME_IDENTITY_INVALID" : error.code);
      }
      throw new BoxDurableJournalError("BOX_TOOL_RESUME_IDENTITY_INVALID");
    }
    if (view.prepared.classification === "reject") {
      throw new BoxDurableJournalError(view.prepared.rejectCode ?? "BOX_PREPARED_REJECT");
    }
    if (view.prepared.classification !== "continuation_candidate" || !view.catalog
      || view.assistantContent == null || !view.priorContextHash || !view.nextContextHash
      || !view.effectiveBody) {
      throw new BoxDurableJournalError("BOX_PREPARED_REJECT");
    }
    const fingerprint = view.fingerprint;
    const fallbackAlias = view.fallbackAlias;
    const priorContextHash = view.priorContextHash;
    const nextContextHash = view.nextContextHash;
    const imageIdentity = deriveBoxImageIdentity(view.effectiveBody);
    // Rolling compatibility (OCV5-300): a chain handed off on the opaque-alias
    // release keeps resolving against that exact catalog variant.
    let boundCatalog = view.catalog;
    const assistantContent = view.assistantContent;
    const client = await pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      await lock(client, [`box:fingerprint:${fingerprint.replayFingerprint}`,
        `box:session:${input.uid}:${fingerprint.sessionId}`]);
      const duplicate = await client.query(
        `SELECT 1 FROM request_finalize_journal
          WHERE ctx->>'boxReplayFingerprint'=$1
             OR ctx->>'boxFallbackAlias'=$2 LIMIT 1`,
        [fingerprint.replayFingerprint, fallbackAlias]);
      if (duplicate.rowCount) throw new BoxDurableJournalError("BOX_CALL_AMBIGUOUS");
      if (resumeLookupBarrier) await resumeLookupBarrier();
      const owners = await client.query<{ request_id: string; ctx: Record<string, unknown> }>(
        `SELECT request_id,ctx FROM request_finalize_journal
          WHERE user_id=$1 AND ctx->>'boxSessionId'=$2 AND ctx->>'boxTurnKey'=$3
            AND ctx->>'boxState'='handoff' AND NOT (ctx ? 'boxCancelIntent')
            AND NOT (ctx ? 'boxRecoveredBy')
            AND state IN ('inflight','finalizing','committed') FOR UPDATE`,
        [input.uid.toString(), fingerprint.sessionId, fingerprint.turnKey]);
      if (owners.rows.length !== 1) {
        const consumed = await client.query(
          `SELECT 1 FROM request_finalize_journal
            WHERE user_id=$1 AND ctx->>'boxSessionId'=$2 AND ctx->>'boxTurnKey'=$3
              AND ctx->>'model'=$4
              AND ctx->>'boxState' IN ('resuming','unknown','linked')
              AND NOT (ctx ? 'boxCancelIntent')
            LIMIT 1`,
          [input.uid.toString(), fingerprint.sessionId, fingerprint.turnKey,
            input.canonicalModel]);
        // A cancelled chain has no live resume: its rounds must not read as one
        // in progress, or the orphan release (BOX_TOOL_OWNER_UNKNOWN) is never tried.
        if (consumed.rowCount) throw new BoxDurableJournalError("BOX_RESUME_IN_PROGRESS");
        throw new BoxDurableJournalError("BOX_TOOL_OWNER_UNKNOWN");
      }
      const owner = owners.rows[0]!, ctx = owner.ctx;
      const nativeSessionId = ctx.boxNativeSessionId;
      const nativeCliCwd = ctx.boxNativeCliCwd;
      const nativeCliVersion = typeof ctx.boxNativeCliVersion === "string"
        && /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/.test(ctx.boxNativeCliVersion)
        ? ctx.boxNativeCliVersion : undefined;
      const nativePromptLayout = ctx.boxNativePromptLayout === BOX_PROMPT_LAYOUT_STATIC_FIRST
        ? BOX_PROMPT_LAYOUT_STATIC_FIRST : undefined;
      if (ctx.model !== input.canonicalModel
        || ctx.boxInvocationMode !== "detached_tool"
        || typeof ctx.boxAccountId !== "string" || !/^[1-9][0-9]{0,19}$/.test(ctx.boxAccountId)
        || typeof ctx.boxRunNonce !== "string" || !/^[a-f0-9]{24}$/.test(ctx.boxRunNonce)
        || typeof ctx.boxLeaseEpoch !== "string" || !/^[a-f0-9]{32}$/.test(ctx.boxLeaseEpoch)
        || typeof ctx.boxContextHash !== "string"
        || !/^[a-f0-9]{64}$/.test(ctx.boxContextHash)
        || typeof ctx.boxHandoffRevision !== "string" || ctx.boxHandoffRevision.length > 128
        || !ctx.boxToolHandoff || typeof ctx.boxToolHandoff !== "object"
        || Array.isArray(ctx.boxToolHandoff)
        || (nativeSessionId === undefined) !== (nativeCliCwd === undefined)
        || (nativeSessionId !== undefined &&
          (typeof nativeSessionId !== "string" || !UUID_V4.test(nativeSessionId)
            || typeof nativeCliCwd !== "string"
            || !/^\/tmp\/ocv5-289-run-[a-f0-9]{24}$/.test(nativeCliCwd)))) {
        throw new BoxDurableJournalError("BOX_TOOL_OWNER_INVALID");
      }
      const handoff = parseBoxStoredToolHandoff(ctx.boxToolHandoff);
      if (!handoff) throw new BoxDurableJournalError("BOX_TOOL_OWNER_INVALID");
      const priorIds = ctx.boxPriorMessageIds === undefined ? [] : ctx.boxPriorMessageIds;
      if (!Array.isArray(priorIds) || priorIds.length !== handoff.roundNo - 1
        || new Set(priorIds).size !== priorIds.length
        || priorIds.some((id) => typeof id !== "string" || id.length < 1 || id.length > 128)
        || Array.from({ length: priorIds.length }, (_, i) => i)
          .some((i) => !Object.hasOwn(priorIds, i))
        || priorIds.includes(handoff.messageId)) {
        throw new BoxDurableJournalError("BOX_TOOL_OWNER_INVALID");
      }
      const matchedCatalog = boxCatalogMatching(boundCatalog, handoff.catalogHash);
      if (!matchedCatalog) {
        throw new BoxDurableJournalError("BOX_TOOL_CATALOG_CHANGED");
      }
      boundCatalog = matchedCatalog;
      if (ctx.boxContextHash !== priorContextHash) {
        throw new BoxDurableJournalError("BOX_TOOL_CONTEXT_CHANGED");
      }
      const effectiveBody = view.effectiveBody!;
      const digests = handoff.toolUses;
      let results: readonly BoxMatchedToolResult[];
      try { results = matchPreparedToolResults({ effectiveBody },
        digests, boundCatalog); }
      catch { throw new BoxDurableJournalError("BOX_TOOL_RESULT_MISMATCH"); }
      // OCV5-302: publish (and hash) images the way the Box CLI keeps them, so
      // its echo is byte-identical on the live and every recovery path.
      results = await normalizeBoxResultImagesForCli(results);
      try {
        const compared = comparableAssistantContent(assistantContent, digests, boundCatalog);
        if (!incomingAssistantAccepted(compared, handoff)) {
          throw new Error("assistant message changed");
        }
      } catch {
        throw new BoxDurableJournalError("BOX_TOOL_ASSISTANT_CHANGED");
      }
      const child = await client.query<{ ctx: Record<string, unknown>; state: string }>(
        `SELECT ctx,state FROM request_finalize_journal
          WHERE request_id=$1 AND user_id=$2 FOR UPDATE`,
        [input.requestId, input.uid.toString()]);
      const childCtx = child.rows[0]?.ctx;
      if (child.rowCount !== 1 || !childCtx) {
        throw new BoxDurableJournalError("BOX_TOOL_RESUME_JOURNAL_INVALID");
      }
      const preparedIdentity = {
        uid: view.prepared.uid, sessionId: fingerprint.sessionId,
        canonicalModel: view.prepared.canonicalModel, turnKey: fingerprint.turnKey,
        authority: view.prepared.authority,
      };
      const ownerBound = trustedIdentitiesBind(preparedIdentity, {
        uid: input.uid, sessionId: String(ctx.boxSessionId ?? ""),
        canonicalModel: String(ctx.model ?? ""), turnKey: String(ctx.boxTurnKey ?? ""),
        authority: authorityFromJournalCtx(ctx),
      });
      if (!ownerBound.ok) throw new BoxDurableJournalError(ownerBound.code);
      const ownerBilling = parseBoxBillingContext(ctx.boxBillingContext);
      const childBilling = parseBoxBillingContext(childCtx.boxBillingContext);
      if (!ownerBilling?.sessionId || !ownerBilling.turnKey
        || !childBilling?.sessionId || !childBilling.turnKey) {
        throw new BoxDurableJournalError("BOX_TOOL_RESUME_JOURNAL_INVALID");
      }
      // The prepared/owner session above is the native CLI identity. Billing
      // is frozen from the server dispatch and may use a different UI session.
      // Bind each namespace independently; null dispatches are exact, not wildcards.
      if (ownerBilling.turnKey !== preparedIdentity.turnKey
        || ownerBilling.dispatchId !== childBilling.dispatchId
        || ownerBilling.attemptNo !== childBilling.attemptNo) {
        throw new BoxDurableJournalError("BOX_AUTHORITY_REJECTED");
      }
      const childBound = trustedIdentitiesBind({ ...preparedIdentity,
        sessionId: ownerBilling.sessionId }, {
        uid: input.uid, sessionId: childBilling.sessionId,
        canonicalModel: String(childCtx.model ?? ""), turnKey: childBilling.turnKey,
        authority: authorityFromJournalCtx(childCtx),
      });
      if (!childBound.ok) throw new BoxDurableJournalError(childBound.code);
      // These were formerly enforced by the normal linked UPDATE and its returned
      // price parser. Both resume and rollover must pass them before any claim.
      if (child.rows[0]!.state !== "inflight" || childCtx.boxState !== undefined
        || childCtx.boxInvocationRecovery !== "v1"
        || !parseBillingPricing(childCtx.billingPricing,input.canonicalModel)) {
        throw new BoxDurableJournalError("BOX_TOOL_RESUME_JOURNAL_INVALID");
      }
      const resultHashes = results.map((result) => ({
        modelToolUseId: result.modelToolUseId, contentHash: result.contentHash,
        isError: result.isError }));
      const rollover = await claimToolRollover(client, { uid: input.uid,requestId: input.requestId,
        ownerRequestId: owner.request_id,ctx,childCtx,handoff,nextContextHash,resultHashes,
        lastUserMessage: effectiveBody.messages.at(-1) });
      if (rollover) {
        await client.query("COMMIT"); committed = true;
        throw new BoxToolRolloverRequired(rollover);
      }
      const durableRevision = randomUUID();
      const claimedOwner = await client.query(
        `UPDATE request_finalize_journal
            SET ctx=ctx || $4::jsonb, updated_at=NOW()
          WHERE request_id=$1 AND user_id=$2
            AND ctx->>'boxState'='handoff' AND NOT (ctx ? 'boxCancelIntent')
            AND state IN ('inflight','finalizing','committed')
            AND ctx->>'boxHandoffRevision'=$3`,
        [owner.request_id, input.uid.toString(), ctx.boxHandoffRevision,
          JSON.stringify({ boxState: "resuming", boxResumeRequestId: input.requestId,
            boxResumeRevision: durableRevision, boxResumeResultHashes: resultHashes })]);
      if (claimedOwner.rowCount !== 1) throw new BoxDurableJournalError("BOX_TOOL_RESUME_FENCE_LOST");
      const linked = await client.query<{ ctx: Record<string, unknown> }>(
        `UPDATE request_finalize_journal
            SET ctx=ctx || $4::jsonb, updated_at=NOW()
          WHERE request_id=$1 AND user_id=$2 AND state='inflight'
            AND ctx->>'model'=$3 AND ctx->>'boxInvocationRecovery'='v1'
            AND ctx ? 'billingPricing' AND ctx ? 'boxBillingContext'
            AND NOT (ctx ? 'boxState') RETURNING ctx`,
        [input.requestId, input.uid.toString(), input.canonicalModel,
          JSON.stringify({ boxState: "linked", boxOwnerRequestId: owner.request_id,
            boxInvocationMode: "detached_tool",
            boxAccountId: ctx.boxAccountId, boxRunNonce: ctx.boxRunNonce,
            boxLeaseEpoch: ctx.boxLeaseEpoch, boxTurnKey: fingerprint.turnKey,
            boxResumeSpoolOffset: handoff.spoolOffset,
            boxRoundNo: handoff.roundNo + 1,
            boxPriorMessageIds: [...priorIds, handoff.messageId],
            boxDetachedRunnerHash: handoff.detachedRunnerHash,
            boxCatalogHash: handoff.catalogHash,
            boxSessionId: fingerprint.sessionId,
             boxReplayFingerprint: fingerprint.replayFingerprint,
             boxFallbackAlias: fallbackAlias,
             ...(ctx.boxReplayRequired === true ? { boxReplayRequired: true } : {}),
             boxRequestHash: fingerprint.requestHash,
             boxContextHash: nextContextHash,
             boxImageIdentity: imageIdentity,
             boxParentResumeRevision: durableRevision,
             ...(nativeSessionId === undefined ? {} : {
               boxNativeSessionId: nativeSessionId,
               boxNativeCliCwd: nativeCliCwd,
               ...(nativeCliVersion ? { boxNativeCliVersion: nativeCliVersion } : {}),
               ...(nativePromptLayout ? { boxNativePromptLayout: nativePromptLayout } : {}) }) })]);
      const linkedCtx = linked.rows[0]?.ctx;
      const basis = parseBoxBillingContext(linkedCtx?.boxBillingContext);
      if (linked.rowCount !== 1 || !basis || basis.turnKey !== fingerprint.turnKey
        || !parseBillingPricing(linkedCtx?.billingPricing, input.canonicalModel)) {
        throw new BoxDurableJournalError("BOX_TOOL_RESUME_JOURNAL_INVALID");
      }
      await client.query("COMMIT");
      committed = true;
      return { ownerRequestId: owner.request_id, accountId: BigInt(ctx.boxAccountId),
        runNonce: ctx.boxRunNonce, leaseEpoch: ctx.boxLeaseEpoch,
        spoolOffset: handoff.spoolOffset, roundNo: handoff.roundNo + 1,
        durableRevision, results,
        detachedRunnerHash: handoff.detachedRunnerHash,
         catalogHash: handoff.catalogHash,
         toolUses: digests,
         ...(handoff.rejectedToolUses ? { rejectedToolUses: handoff.rejectedToolUses } : {}),
         ...(nativeSessionId === undefined ? {} : {
           nativeSessionId: nativeSessionId as string,
           nativeCliCwd: nativeCliCwd as string,
           ...(nativeCliVersion ? { nativeCliVersion } : {}),
           ...(nativePromptLayout ? { nativePromptLayout } : {}) }) };
    } finally {
      if (!committed) await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
}
