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
    const proof = parseBoxTerminalProof(JSON.stringify(ctx.boxTerminalProof) + "\n", {
      runNonce: ctx.boxRunNonce, leaseEpoch: ctx.boxLeaseEpoch });
    if (proof.reason !== "keeper_stopped" && proof.reason !== "worker_failed") return false;
  } catch { return false; }
  const billing = parseBoxBillingContext(ctx.boxBillingContext);
  if (!billing?.dispatchId) return false;
  const dispatch = await query(
    `SELECT status FROM turn_dispatches WHERE user_id=$1 AND dispatch_id::text=$2`,
    [uid.toString(), billing.dispatchId]);
  return dispatch.rows[0]?.status === "terminal";
}
