/** Recover only already-proven Box text rounds from the existing journal.
 * This never invokes Box, restarts Claude, replays a tool, or guesses usage. */
import type { Pool } from "pg";
import { parseBillingPricing } from "./persistedBillingPricing.js";
import { computeCost, type TokenUsage } from "./calculator.js";
import { claimInflightJournalForSettlement, finalizeInflightJournal,
  settleUsageAndLedger } from "./proxyBilling.js";
import { parseBoxBillingContext } from "../http/proxy/boxBillingContext.js";
import { parseBoxTerminalProof } from "../http/proxy/boxTerminalProof.js";

const STALE_CLAIM_MS = 5 * 60_000;
const LIVE_FINALIZER_GRACE_MS = 5 * 60_000;
type RecoveryResult = "settled" | "already_committed" | "pending" | "manual";
interface JournalRow {
  request_id: string;
  user_id: string;
  state: string;
  ctx: Record<string, unknown>;
  updated_at: Date;
}

function evidence(row: JournalRow): { usage: TokenUsage;
  pricing: NonNullable<ReturnType<typeof parseBillingPricing>>;
  context: NonNullable<ReturnType<typeof parseBoxBillingContext>> } | null {
  const ctx = row.ctx;
  if (ctx.boxInvocationRecovery !== "v1" || ctx.boxState !== "terminal"
    || typeof ctx.model !== "string" || typeof ctx.boxRunNonce !== "string"
    || typeof ctx.boxLeaseEpoch !== "string" || !ctx.boxTerminalProof
    || typeof ctx.boxAccountId !== "string" || !/^[1-9][0-9]{0,19}$/.test(ctx.boxAccountId)
    || typeof ctx.boxReplayFingerprint !== "string"
    || !/^[a-f0-9]{64}$/.test(ctx.boxReplayFingerprint)
    || typeof ctx.boxTurnKey !== "string" || !/^[a-f0-9]{64}$/.test(ctx.boxTurnKey)
    || !ctx.boxUsage || typeof ctx.boxUsage !== "object" || Array.isArray(ctx.boxUsage)) return null;
  const pricing = parseBillingPricing(ctx.billingPricing, ctx.model);
  const context = parseBoxBillingContext(ctx.boxBillingContext);
  let proof: ReturnType<typeof parseBoxTerminalProof>;
  try { proof = parseBoxTerminalProof(JSON.stringify(ctx.boxTerminalProof) + "\n",
    { runNonce: ctx.boxRunNonce, leaseEpoch: ctx.boxLeaseEpoch }); }
  catch { return null; }
  if (!pricing || !context || context.turnKey !== ctx.boxTurnKey
    || proof.reason !== "worker_complete") return null;
  const u = ctx.boxUsage as Record<string, unknown>;
  const counts = [u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens];
  if (Object.keys(u).sort().join(",") !==
      "cacheReadTokens,cacheWriteTokens,inputTokens,outputTokens"
    || counts.some((n) => !Number.isSafeInteger(n) || (n as number) < 0)) return null;
  return { pricing, context, usage: {
    input_tokens: BigInt(u.inputTokens as number),
    output_tokens: BigInt(u.outputTokens as number),
    cache_read_tokens: BigInt(u.cacheReadTokens as number),
    cache_write_tokens: BigInt(u.cacheWriteTokens as number),
  } };
}

async function repairFromUsage(pool: Pool, row: JournalRow): Promise<boolean> {
  const repaired = await pool.query(
    `UPDATE request_finalize_journal rfj
        SET state='committed', usage_id=ur.id, ledger_id=ur.ledger_id,
            final_credits=ur.cost_credits, failure_code=NULL,
            ctx=rfj.ctx - 'settlementClaimId', updated_at=NOW()
       FROM usage_records ur
      WHERE rfj.request_id=$1 AND rfj.user_id=$2
        AND ur.request_id=rfj.request_id AND ur.user_id=rfj.user_id
        AND rfj.ctx->>'boxInvocationRecovery'='v1'
        AND rfj.state IN ('inflight','finalizing')`,
    [row.request_id, row.user_id]);
  return repaired.rowCount === 1;
}

export async function recoverBoxBillingRequest(pool: Pool, requestId: string,
  userId: bigint): Promise<RecoveryResult> {
  const found = await pool.query<JournalRow>(
    `SELECT request_id,user_id::text,state,ctx,updated_at FROM request_finalize_journal
      WHERE request_id=$1 AND user_id=$2`, [requestId, userId.toString()]);
  const row = found.rows[0];
  if (!row || row.ctx?.boxInvocationRecovery !== "v1") return "manual";
  if (row.state === "committed") {
    const usage = await pool.query<{ present: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM usage_records
        WHERE request_id=$1 AND user_id=$2) AS present`, [requestId, userId.toString()]);
    return usage.rows[0]?.present === true ? "already_committed" : "manual";
  }
  if (await repairFromUsage(pool, row)) return "already_committed";
  const validated = evidence(row);
  if (!validated || row.state === "aborted") return "manual";
  if (!(row.updated_at instanceof Date) || !Number.isFinite(row.updated_at.getTime())) return "manual";
  if (row.state === "inflight"
    && Date.now() - row.updated_at.getTime() < LIVE_FINALIZER_GRACE_MS) return "pending";
  if (row.state === "finalizing") {
    const reopened = await pool.query(
      `UPDATE request_finalize_journal rfj
          SET state='inflight', ctx=rfj.ctx - 'settlementClaimId',
              error_msg=NULL, failure_code=NULL, final_credits=NULL, updated_at=NOW()
        WHERE rfj.request_id=$1 AND rfj.user_id=$2
          AND rfj.state='finalizing' AND rfj.ctx->>'boxInvocationRecovery'='v1'
          AND rfj.ctx->>'boxState'='terminal'
          AND rfj.updated_at < NOW() - ($3::bigint * INTERVAL '1 millisecond')
          AND NOT EXISTS (SELECT 1 FROM usage_records ur
            WHERE ur.request_id=rfj.request_id AND ur.user_id=rfj.user_id)`,
      [requestId, userId.toString(), String(STALE_CLAIM_MS)]);
    if (reopened.rowCount !== 1) return "pending";
  } else if (row.state !== "inflight") return "manual";
  const claim = await claimInflightJournalForSettlement(pool, requestId);
  if (!claim) return "pending";
  const { cost_credits, snapshot } = computeCost(validated.usage, validated.pricing);
  const noOutput = validated.usage.output_tokens === 0n && cost_credits > 0n;
  const effectiveCost = noOutput ? 0n : cost_credits;
  const settled = await settleUsageAndLedger(pool, {
    userId, accountId: null, requestId, model: validated.pricing.model_id,
    usage: validated.usage,
    snapshotJson: JSON.stringify({ ...snapshot,
      ...(noOutput ? { waived: "no_output", wouldHaveCharged: cost_credits.toString() } : {}) }),
    costCredits: effectiveCost, status: "success", ...validated.context,
  });
  try { await finalizeInflightJournal(pool, { requestId, finalCredits: effectiveCost,
    ledgerId: settled.ledgerId, usageId: settled.usageId, settlementClaimId: claim }); }
  catch { return "pending"; } // usage_records is durable truth; next pass repairs.
  return "settled";
}

/** Bounded operator/scheduler entry. Unknown outcomes are never promoted. */
export async function reconcileBoxBillingBatch(pool: Pool, limit = 20): Promise<{
  settled: number; pending: number; manual: number }> {
  const rows = await pool.query<{ request_id: string; user_id: string }>(
    `SELECT request_id,user_id::text FROM request_finalize_journal
      WHERE ctx->>'boxInvocationRecovery'='v1' AND ctx->>'boxState'='terminal'
        AND state IN ('inflight','finalizing')
        AND updated_at < NOW() - ($2::bigint * INTERVAL '1 millisecond')
      ORDER BY updated_at ASC LIMIT $1`,
    [Math.max(1, Math.min(limit, 100)), String(LIVE_FINALIZER_GRACE_MS)]);
  const counts = { settled: 0, pending: 0, manual: 0 };
  for (const row of rows.rows) {
    try {
      const result = await recoverBoxBillingRequest(pool, row.request_id, BigInt(row.user_id));
      if (result === "settled" || result === "already_committed") counts.settled++;
      else counts[result]++;
    } catch { counts.pending++; } // Leave journal/evidence for the next pass.
  }
  return counts;
}
