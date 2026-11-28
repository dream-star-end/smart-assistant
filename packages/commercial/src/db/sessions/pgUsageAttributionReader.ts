import type { Pool, PoolClient } from "pg";
import type { SettledUsageAttribution } from "./types.js";

interface PendingUsageLocatorRow {
  session_id: string | null;
  parent_session_id: string | null;
  delegate_agent_id: string | null;
  turn_key: string | null;
  parent_turn_key: string | null;
  cost_credits: string;
}

/**
 * Stage an exact turn-cost locator on the caller's existing billing
 * transaction. Keeping the SQL here preserves the sessions-backend ownership
 * boundary while allowing the ledger debit and its refresh-visible locator to
 * commit atomically.
 */
export async function stageUsageCostLocatorInBillingTransaction(
  client: PoolClient,
  args: {
    requestId: string;
    userId: string;
    sessionId: string | null;
    parentSessionId: string | null;
    delegateAgentId: string | null;
    turnKey: string | null;
    parentTurnKey: string | null;
    costCredits: bigint;
  },
): Promise<void> {
  const targetTurnKey = args.parentTurnKey ?? args.turnKey;
  if (targetTurnKey === null || !/^[0-9a-f]{64}$/.test(targetTurnKey)) {
    throw new Error("stageUsageCostLocator: invalid lossless turn key");
  }
  if (args.turnKey !== null && !/^[0-9a-f]{64}$/.test(args.turnKey)) {
    throw new Error("stageUsageCostLocator: invalid turnKey");
  }
  if (args.parentTurnKey !== null && !/^[0-9a-f]{64}$/.test(args.parentTurnKey)) {
    throw new Error("stageUsageCostLocator: invalid parentTurnKey");
  }
  const inserted = await client.query(
    `INSERT INTO pending_usage_patches
       (request_id,user_id,session_id,parent_session_id,delegate_agent_id,
        turn_key,parent_turn_key,cost_credits)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (request_id,user_id) DO NOTHING`,
    [
      args.requestId,
      args.userId,
      args.sessionId,
      args.parentSessionId,
      args.delegateAgentId,
      args.turnKey,
      args.parentTurnKey,
      args.costCredits.toString(),
    ],
  );
  if ((inserted.rowCount ?? 0) !== 0) return;

  const existing = (
    await client.query<PendingUsageLocatorRow>(
      `SELECT session_id,parent_session_id,delegate_agent_id,turn_key,
              parent_turn_key,cost_credits
         FROM pending_usage_patches
        WHERE request_id=$1 AND user_id=$2 FOR UPDATE`,
      [args.requestId, args.userId],
    )
  ).rows[0];
  if (
    !existing ||
    existing.session_id !== args.sessionId ||
    existing.parent_session_id !== args.parentSessionId ||
    existing.delegate_agent_id !== args.delegateAgentId ||
    existing.turn_key !== args.turnKey ||
    existing.parent_turn_key !== args.parentTurnKey ||
    BigInt(existing.cost_credits) !== args.costCredits
  ) {
    throw new Error("stageUsageCostLocator: immutable lossless cost locator conflict");
  }
}

/**
 * Read the immutable settlement proof together with its lossless-turn cost
 * locator. This query belongs to the PG sessions backend because the locator
 * can be in either pending_usage_patches or its folded tape component.
 *
 * The runner may be the caller's PoolClient after a 23505 rollback, or a fresh
 * Pool checkout used to prove an indeterminate COMMIT. The outer usage_records
 * table intentionally stays unaliased: besides keeping the query simple, this
 * preserves the long-standing fault-injection matcher used by finalizer tests.
 */
export async function loadSettledUsageAttribution(
  runner: Pool | PoolClient,
  userId: bigint,
  requestId: string,
): Promise<SettledUsageAttribution | null> {
  const storageUserId = `c:${userId.toString()}`;
  const row = (
    await runner.query<{
      id: string;
      ledger_id: string | null;
      attribution_credits: string | null;
      cost_credits: string;
    }>(
      `SELECT usage_records.id::text AS id,
              usage_records.ledger_id::text AS ledger_id,
              usage_records.cost_credits::text AS cost_credits,
              COALESCE(
                (SELECT p.cost_credits FROM pending_usage_patches p
                  WHERE p.user_id=$3 AND p.request_id=usage_records.request_id),
                (SELECT c.cost_credits::text FROM turn_tape_cost_components c
                  WHERE c.user_id=$3 AND c.request_id=usage_records.request_id)
              ) AS attribution_credits
         FROM usage_records WHERE user_id=$1 AND request_id=$2`,
      [userId.toString(), requestId, storageUserId],
    )
  ).rows[0];
  if (!row) return null;
  return {
    usageId: BigInt(row.id),
    ledgerId: row.ledger_id === null ? null : BigInt(row.ledger_id),
    attributionCredits:
      row.attribution_credits == null ? null : BigInt(row.attribution_credits),
    costCredits: BigInt(row.cost_credits),
  };
}

/** Read only the exact debit attribution used by durable bridge repair. */
export async function loadUsageAttributionCredits(
  runner: Pool | PoolClient,
  userId: bigint,
  requestId: string,
): Promise<bigint | null> {
  return (await loadSettledUsageAttribution(runner, userId, requestId))
    ?.attributionCredits ?? null;
}
