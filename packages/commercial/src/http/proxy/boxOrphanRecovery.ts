/** A failed recovery may give an orphaned exchange back only after its own
 * invocation is proven stopped. HTTP failure or cleanup alone is not proof. */
import { isBoxApiModel } from "@openclaude/protocol";
import { parseBoxBillingContext } from "./boxBillingContext.js";
import { parseBoxTerminalProof } from "./boxTerminalProof.js";

export interface BoxRecoveryHolder {
  state: string;
  ctx: Record<string, unknown>;
}

type Query = (sql: string, params: unknown[]) => Promise<{
  rows: { status: string }[];
}>;

export async function orphanRecoveryHolderIsStale(query: Query, uid: bigint,
  parent: Record<string, unknown>, holder: BoxRecoveryHolder | undefined): Promise<boolean> {
  if (!holder || holder.state !== "aborted") return false;
  const ctx = holder.ctx;
  // Existing planning-failure case: no Box invocation was ever admitted.
  if (ctx.boxState === undefined) return true;
  if (ctx.boxState !== "failed_stopped" || ctx.boxStopOutcome !== "failed"
    || ctx.boxInvocationRecovery !== "v1" || ctx.boxInvocationMode !== "detached_tool"
    || !isBoxApiModel(ctx.model) || ctx.model !== parent.model
    || typeof ctx.boxSessionId !== "string" || ctx.boxSessionId !== parent.boxSessionId
    || typeof ctx.boxRunNonce !== "string" || !/^[a-f0-9]{24}$/.test(ctx.boxRunNonce)
    || typeof ctx.boxLeaseEpoch !== "string" || !/^[a-f0-9]{32}$/.test(ctx.boxLeaseEpoch)
    || ["boxToolHandoff", "boxReplayMessage", "boxOwnerRequestId", "boxResumeRequestId",
      "boxRecoveredBy"].some((key) => ctx[key] !== undefined)) return false;
  try {
    const proof = parseBoxTerminalProof(`${JSON.stringify(ctx.boxTerminalProof)}
`, {
      runNonce: ctx.boxRunNonce, leaseEpoch: ctx.boxLeaseEpoch });
    if (proof.reason !== "keeper_stopped" && proof.reason !== "worker_failed") return false;
  } catch { return false; }
  const billing = parseBoxBillingContext(ctx.boxBillingContext);
  if (!billing?.dispatchId) return false;
  const dispatch = await query(
    "SELECT status FROM turn_dispatches WHERE user_id=$1 AND dispatch_id::text=$2",
    [uid.toString(), billing.dispatchId]);
  return dispatch.rows[0]?.status === "terminal";
}

/** A resume child whose claim committed in PG before any Box target was reached
 * (`boxUnknownPhase = "resume_publish_unsent"`). Zero bytes reached the remote
 * run, so its parent handoff is still parked waiting for the tool results. */
export function unsentResumeChildFenceSql(alias = "resume_child"): string {
  return `${alias}.state='inflight'
    AND ${alias}.ctx->>'boxState'='unknown'
    AND ${alias}.ctx->>'boxUnknownPhase'='resume_publish_unsent'
    AND NOT (${alias}.ctx ? 'boxToolHandoff')
    AND NOT (${alias}.ctx ? 'boxReplayMessage')
    AND NOT (${alias}.ctx ? 'boxTerminalProof')
    AND NOT (${alias}.ctx ? 'boxResumeRequestId')`;
}

export function unsentResumeChildClaimSql(alias = "resume_child"): string {
  return `${unsentResumeChildFenceSql(alias)}
    AND NOT (${alias}.ctx ? 'boxCancelIntent')
    AND NOT (${alias}.ctx ? 'boxStaleResumeStop')`;
}

export function resumingParentWithUnsentChildSql(parentAlias = "handoff_row",
  childSql = unsentResumeChildFenceSql("resume_child")): string {
  return `(${parentAlias}.ctx->>'boxState'='resuming'
    AND EXISTS (SELECT 1 FROM request_finalize_journal resume_child
      WHERE resume_child.request_id=${parentAlias}.ctx->>'boxResumeRequestId'
        AND resume_child.user_id=${parentAlias}.user_id
        AND resume_child.ctx->>'boxOwnerRequestId'=${parentAlias}.request_id
        AND resume_child.ctx->>'boxParentResumeRevision'=${parentAlias}.ctx->>'boxResumeRevision'
        AND ${childSql}))`;
}

export function unsentChildStopInflightSql(parentAlias = "handoff_row"): string {
  return `(${parentAlias}.ctx->>'boxState'='resuming'
    AND EXISTS (SELECT 1 FROM request_finalize_journal resume_child
      WHERE resume_child.request_id=${parentAlias}.ctx->>'boxResumeRequestId'
        AND resume_child.user_id=${parentAlias}.user_id
        AND (resume_child.ctx ? 'boxCancelIntent' OR resume_child.ctx ? 'boxStaleResumeStop')))`;
}

export function stoppedUnsentChildCtxSql(parentAlias = "handoff_row"): string {
  return `(SELECT resume_child.ctx FROM request_finalize_journal resume_child
    WHERE resume_child.request_id=${parentAlias}.ctx->>'boxResumeRequestId'
      AND resume_child.user_id=${parentAlias}.user_id
      AND resume_child.state='aborted'
      AND resume_child.ctx->>'boxOwnerRequestId'=${parentAlias}.request_id
      AND resume_child.ctx->>'boxParentResumeRevision'=${parentAlias}.ctx->>'boxResumeRevision'
      AND resume_child.ctx->>'boxState'='failed_stopped'
      AND resume_child.ctx->>'boxUnknownPhase'='resume_publish_unsent'
      AND NOT (resume_child.ctx ? 'boxToolHandoff')
      AND NOT (resume_child.ctx ? 'boxReplayMessage')
      AND NOT (resume_child.ctx ? 'boxCancelIntent')
      AND NOT (resume_child.ctx ? 'boxResumeRequestId')
    LIMIT 1)`;
}

export function sameTurnOrphanStoppedProofValid(ctx: Record<string, unknown>,
  stoppedUnsentChildCtx?: Record<string, unknown> | null): boolean {
  if (ctx.boxState !== "failed_stopped" || ctx.boxStopOutcome !== "failed"
    || ctx.boxCancelIntent !== undefined || typeof ctx.boxRunNonce !== "string"
    || typeof ctx.boxLeaseEpoch !== "string") return false;
  let rawProof: unknown = ctx.boxTerminalProof;
  if (ctx.boxResumeRequestId !== undefined) {
    if (!stoppedUnsentChildCtx || stoppedUnsentChildCtx.boxStopOutcome !== "failed") return false;
    rawProof = stoppedUnsentChildCtx.boxTerminalProof;
  }
  try {
    const proof = parseBoxTerminalProof(`${JSON.stringify(rawProof)}
`, {
      runNonce: ctx.boxRunNonce, leaseEpoch: ctx.boxLeaseEpoch });
    return proof.reason === "keeper_stopped" || proof.reason === "worker_failed";
  } catch { return false; }
}

export function supersededUnsentResumeSql(alias = "current_row"): string {
  const c = `${alias}.ctx`;
  return `(${alias}.state='aborted' AND COALESCE(${alias}.final_credits,0)=0
    AND ${c}->>'boxState'='prestart_stopped'
    AND NOT (${c} ? 'boxLaunchPermit')
    AND NOT (${c} ? 'boxOwnerRequestId')
    AND NOT (${c} ? 'boxResumeRequestId')
    AND NOT (${c} ? 'boxRunNonce')
    AND jsonb_typeof(${c}->'boxUnsentSupersededBy')='string'
    AND EXISTS (SELECT 1 FROM request_finalize_journal successor
      WHERE successor.user_id=${alias}.user_id
        AND successor.request_id<>${alias}.request_id
        AND successor.request_id=${c}->>'boxUnsentSupersededBy'
        AND successor.ctx->>'boxSessionId'=${c}->>'boxSessionId'
        AND successor.ctx->>'boxTurnKey'=${c}->>'boxTurnKey'
        AND successor.ctx->>'model'=${c}->>'model'))`;
}
