import type { Pool } from "pg";

import { spendTwoBucket } from "../billing/spend.js";
import type { MiniMaxMediaCostResult } from "./mediaPricing.js";

export interface MiniMaxMediaSettleInput {
  userId: bigint;
  containerId: bigint | null;
  requestId: string;
  cost: MiniMaxMediaCostResult;
  upstreamTraceId?: string | null;
  upstreamTaskId?: string | null;
  upstreamFileId?: string | null;
  outputMeta?: Record<string, unknown>;
}

export interface MiniMaxMediaSettleResult {
  usageId: bigint;
  ledgerId: bigint | null;
  costCredits: bigint;
  debitedCredits: bigint | null;
  balanceAfter: bigint | null;
  clamped: boolean;
  replayed: boolean;
}

function isUniqueViolation(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: unknown }).code === "23505");
}

/**
 * Persist a successfully delivered MiniMax media call and debit the user once.
 *
 * Idempotency is keyed by (user_id, request_id) through
 * minimax_media_usage_records.UNIQUE. On replay we return the existing ids and
 * do not write another ledger row. This mirrors usage_records semantics for
 * chat while keeping media's non-token units separate.
 */
export async function settleMiniMaxMediaSuccess(
  pool: Pool,
  input: MiniMaxMediaSettleInput,
): Promise<MiniMaxMediaSettleResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let usageId: bigint;
    let ledgerId: bigint | null = null;
    let clamped = false;
    let balanceAfter: bigint | null = null;
    let debitedCredits: bigint | null = null;

    try {
      const ins = await client.query<{ id: string }>(
        `INSERT INTO minimax_media_usage_records
           (user_id, container_id, request_id, operation, model,
            units, price_snapshot, cost_credits,
            upstream_trace_id, upstream_task_id, upstream_file_id,
            output_meta, status)
         VALUES ($1, $2, $3, $4, $5,
                 $6::jsonb, $7::jsonb, $8,
                 $9, $10, $11,
                 $12::jsonb, 'success')
         RETURNING id::text AS id`,
        [
          input.userId.toString(),
          input.containerId === null ? null : input.containerId.toString(),
          input.requestId,
          input.cost.operation,
          input.cost.model,
          JSON.stringify(input.cost.units),
          JSON.stringify(input.cost.snapshot),
          input.cost.costCredits.toString(),
          input.upstreamTraceId ?? null,
          input.upstreamTaskId ?? null,
          input.upstreamFileId ?? null,
          JSON.stringify(input.outputMeta ?? {}),
        ],
      );
      usageId = BigInt(ins.rows[0]!.id);
    } catch (err) {
      if (isUniqueViolation(err)) {
        await client.query("ROLLBACK");
        const sel = await pool.query<{
          id: string;
          ledger_id: string | null;
          cost_credits: string;
        }>(
          `SELECT id::text AS id, ledger_id::text AS ledger_id,
                  cost_credits::text AS cost_credits
             FROM minimax_media_usage_records
            WHERE user_id=$1 AND request_id=$2`,
          [input.userId.toString(), input.requestId],
        );
        if (sel.rowCount === 0) throw err;
        const row = sel.rows[0]!;
        return {
          usageId: BigInt(row.id),
          ledgerId: row.ledger_id === null ? null : BigInt(row.ledger_id),
          costCredits: BigInt(row.cost_credits),
          debitedCredits: null,
          balanceAfter: null,
          clamped: false,
          replayed: true,
        };
      }
      throw err;
    }

    if (input.cost.costCredits > 0n) {
      // 双钱包扣费收口（0096）：先扣 period_credits 期内桶再扣 users.credits 持久钱包。
      const spend = await spendTwoBucket(client, {
        userId: input.userId,
        amount: input.cost.costCredits,
        reason: "minimax_media",
        ref: { type: "minimax_media_usage_record", id: usageId.toString() },
        memo: `cost=${input.cost.costCredits}`,
      });
      clamped = spend.clamped;
      balanceAfter = spend.totalAfter;
      debitedCredits = spend.debited;
      ledgerId = spend.primaryLedgerId;
      if (ledgerId !== null) {
        await client.query(
          "UPDATE minimax_media_usage_records SET ledger_id=$1 WHERE id=$2",
          [ledgerId.toString(), usageId.toString()],
        );
      }
    }

    await client.query("COMMIT");
    return {
      usageId,
      ledgerId,
      costCredits: input.cost.costCredits,
      debitedCredits,
      balanceAfter,
      clamped,
      replayed: false,
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}
