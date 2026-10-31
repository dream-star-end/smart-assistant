/**
 * OCV5-704 daily check. Read-only: chat ledger debits in a window must equal
 * turn labels plus charges explicitly left off a turn.
 *
 * gap = ledgerChatDebit - labeled - knownNonTurn.
 * A non-zero gap is an alarm. This module never writes a balance or a ledger row.
 *
 * Pre-fix vision and delegate rows have neither a turn label nor an
 * openTurnAttribution stamp. A window that still contains them alarms until
 * they age out. There is no backfill.
 */

export interface TurnLabelLedgerTotals {
  ledgerChatDebit: bigint;
  labeled: bigint;
  knownNonTurn: bigint;
}

export function turnLabelLedgerGap(totals: TurnLabelLedgerTotals): bigint {
  return totals.ledgerChatDebit - totals.labeled - totals.knownNonTurn;
}

export function redactDbUrl(text: string): string {
  return text.replace(/postgres(?:ql)?:\/\/\S+/gi, "postgres://redacted");
}

/** One read. Bounds are timestamptz. Labels join through usage_records.created_at
 * because component updated_at is epoch milliseconds. Known skips are journal
 * stamps none|many|unkeyed, and container-less (studio) journals. */
export const TURN_LABEL_LEDGER_RECONCILE_SQL = `WITH bounds AS (
  SELECT $1::timestamptz AS since, $2::timestamptz AS until
),
ledger AS (
  SELECT COALESCE(SUM(-cl.delta), 0)::bigint AS debit
    FROM credit_ledger cl, bounds b
   WHERE cl.reason = 'chat'
     AND cl.delta < 0
     AND cl.created_at >= b.since
     AND cl.created_at < b.until
),
labeled AS (
  SELECT COALESCE(SUM(part.cost_credits), 0)::bigint AS credits
    FROM (
      SELECT c.cost_credits::bigint AS cost_credits
        FROM turn_tape_cost_components c
        JOIN usage_records ur
          ON ur.request_id = c.request_id
         AND ('c:' || ur.user_id::text) = c.user_id
        JOIN bounds b ON ur.created_at >= b.since AND ur.created_at < b.until
      UNION ALL
      SELECT p.cost_credits::bigint
        FROM pending_usage_patches p
        JOIN usage_records ur
          ON ur.request_id = p.request_id
         AND ('c:' || ur.user_id::text) = p.user_id
        JOIN bounds b ON ur.created_at >= b.since AND ur.created_at < b.until
       WHERE (p.turn_key IS NOT NULL OR p.parent_turn_key IS NOT NULL)
         AND NOT EXISTS (
           SELECT 1 FROM turn_tape_cost_components c
            WHERE c.request_id = p.request_id AND c.user_id = p.user_id
         )
    ) part
),
known AS (
  SELECT COALESCE(SUM(-cl.delta), 0)::bigint AS credits
    FROM credit_ledger cl
    JOIN bounds b ON cl.created_at >= b.since AND cl.created_at < b.until
    JOIN usage_records ur
      ON cl.ref_type = 'usage_record' AND cl.ref_id = ur.id::text
    JOIN request_finalize_journal j
      ON j.request_id = ur.request_id AND j.user_id = ur.user_id
   WHERE cl.reason = 'chat'
     AND cl.delta < 0
     AND (
       j.ctx->>'openTurnAttribution' IN ('none', 'many', 'unkeyed')
       OR j.container_id IS NULL
     )
     AND NOT EXISTS (
       SELECT 1 FROM turn_tape_cost_components c
        WHERE c.request_id = ur.request_id AND c.user_id = 'c:' || ur.user_id::text
     )
     AND NOT EXISTS (
       SELECT 1 FROM pending_usage_patches p
        WHERE p.request_id = ur.request_id
          AND p.user_id = 'c:' || ur.user_id::text
          AND (p.turn_key IS NOT NULL OR p.parent_turn_key IS NOT NULL)
     )
)
SELECT ledger.debit::text AS ledger_chat_debit,
       labeled.credits::text AS labeled,
       known.credits::text AS known_non_turn
  FROM ledger, labeled, known`;

/** Per-user gaps for the alarm line. Same predicate as the total, grouped. */
export const TURN_LABEL_LEDGER_RECONCILE_USERS_SQL = `WITH bounds AS (
  SELECT $1::timestamptz AS since, $2::timestamptz AS until
),
ledger AS (
  SELECT cl.user_id, COALESCE(SUM(-cl.delta), 0)::bigint AS debit
    FROM credit_ledger cl, bounds b
   WHERE cl.reason = 'chat'
     AND cl.delta < 0
     AND cl.created_at >= b.since
     AND cl.created_at < b.until
   GROUP BY cl.user_id
),
labeled AS (
  SELECT part.user_id, COALESCE(SUM(part.cost_credits), 0)::bigint AS credits
    FROM (
      SELECT ur.user_id, c.cost_credits::bigint AS cost_credits
        FROM turn_tape_cost_components c
        JOIN usage_records ur
          ON ur.request_id = c.request_id
         AND ('c:' || ur.user_id::text) = c.user_id
        JOIN bounds b ON ur.created_at >= b.since AND ur.created_at < b.until
      UNION ALL
      SELECT ur.user_id, p.cost_credits::bigint
        FROM pending_usage_patches p
        JOIN usage_records ur
          ON ur.request_id = p.request_id
         AND ('c:' || ur.user_id::text) = p.user_id
        JOIN bounds b ON ur.created_at >= b.since AND ur.created_at < b.until
       WHERE (p.turn_key IS NOT NULL OR p.parent_turn_key IS NOT NULL)
         AND NOT EXISTS (
           SELECT 1 FROM turn_tape_cost_components c
            WHERE c.request_id = p.request_id AND c.user_id = p.user_id
         )
    ) part
   GROUP BY part.user_id
),
known AS (
  SELECT ur.user_id, COALESCE(SUM(-cl.delta), 0)::bigint AS credits
    FROM credit_ledger cl
    JOIN bounds b ON cl.created_at >= b.since AND cl.created_at < b.until
    JOIN usage_records ur
      ON cl.ref_type = 'usage_record' AND cl.ref_id = ur.id::text
    JOIN request_finalize_journal j
      ON j.request_id = ur.request_id AND j.user_id = ur.user_id
   WHERE cl.reason = 'chat'
     AND cl.delta < 0
     AND (
       j.ctx->>'openTurnAttribution' IN ('none', 'many', 'unkeyed')
       OR j.container_id IS NULL
     )
     AND NOT EXISTS (
       SELECT 1 FROM turn_tape_cost_components c
        WHERE c.request_id = ur.request_id AND c.user_id = 'c:' || ur.user_id::text
     )
     AND NOT EXISTS (
       SELECT 1 FROM pending_usage_patches p
        WHERE p.request_id = ur.request_id
          AND p.user_id = 'c:' || ur.user_id::text
          AND (p.turn_key IS NOT NULL OR p.parent_turn_key IS NOT NULL)
     )
   GROUP BY ur.user_id
)
SELECT ledger.user_id::text AS user_id,
       (ledger.debit - COALESCE(labeled.credits, 0) - COALESCE(known.credits, 0))::text AS gap
  FROM ledger
  LEFT JOIN labeled ON labeled.user_id = ledger.user_id
  LEFT JOIN known ON known.user_id = ledger.user_id
 WHERE ledger.debit <> COALESCE(labeled.credits, 0) + COALESCE(known.credits, 0)
 ORDER BY ledger.user_id
 LIMIT 50`;

const DML = /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|GRANT|COPY)\b/i;

export function reconcileSqlIsReadOnly(sql: string): boolean {
  return !DML.test(sql);
}
