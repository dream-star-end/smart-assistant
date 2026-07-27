/**
 * Daily billing reconciliation. All four probes are read-only aggregates and
 * return bounded numeric identifiers only; no user email or conversation
 * content enters an alert.
 */

import { EVENTS } from "../admin/alertEvents.js";
import { safeEnqueueAlert, type AlertEventInput } from "../admin/alertOutbox.js";
import { getPool } from "../db/index.js";
import { query, type QueryRunner } from "../db/queries.js";

export const BILLING_RECONCILIATION_INTERVAL_MS = 24 * 60 * 60_000;
export const BILLING_RECONCILIATION_WINDOW_MS = 24 * 60 * 60_000;
export const BILLING_RECONCILIATION_SAMPLE_LIMIT = 10;
export const BILLING_CLAMP_COUNT_THRESHOLD = 5n;
export const BILLING_CLAMP_UNCOLLECTED_THRESHOLD = 500n;

type DriftProbeRow = {
  count: string;
  absolute_credits: string;
  ids: unknown;
};

type UsageProbeRow = {
  usage_gap_count: string;
  usage_gap_credits: string;
  usage_ids: unknown;
  tape_gap_count: string;
  tape_user_ids: unknown;
};

type ClampProbeRow = {
  count: string;
  uncollected_credits: string;
  usage_ids: unknown;
};

export interface BillingReconciliationSnapshot {
  wallet: { count: string; absoluteCredits: string; userIds: string[] };
  period: { count: string; absoluteCredits: string; userIds: string[] };
  usage: {
    count: string;
    absoluteCredits: string;
    usageIds: string[];
    tapeGapCount: string;
    tapeUserIds: string[];
  };
  clamp: { count: string; uncollectedCredits: string; usageIds: string[] };
}

export interface BillingReconciliationOptions {
  runner?: QueryRunner;
  nowMs?: number;
  enqueue?: (event: AlertEventInput) => void;
}

function ids(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((id): id is string | number => typeof id === "string" || typeof id === "number")
    .map(String)
    .slice(0, BILLING_RECONCILIATION_SAMPLE_LIMIT);
}

function positive(value: string): boolean {
  try {
    return BigInt(value) > 0n;
  } catch {
    return false;
  }
}

export async function scanBillingReconciliation(
  runner: QueryRunner,
  nowMs: number,
): Promise<BillingReconciliationSnapshot> {
  const sampleLimit = BILLING_RECONCILIATION_SAMPLE_LIMIT;
  const cutoffMs = nowMs - BILLING_RECONCILIATION_WINDOW_MS;

  const wallet = await query<DriftProbeRow>(
    `/* billing_reconciliation:wallet */
     WITH ledger AS (
       SELECT user_id, SUM(delta)::bigint AS ledger_sum
         FROM credit_ledger
        WHERE bucket = 'wallet'
        GROUP BY user_id
     ), drift AS (
       SELECT u.id AS user_id,
              ABS(u.credits - COALESCE(l.ledger_sum, 0))::bigint AS abs_drift
         FROM users u
         LEFT JOIN ledger l ON l.user_id = u.id
        WHERE u.credits <> COALESCE(l.ledger_sum, 0)
     ), top_ids AS (
       SELECT user_id, abs_drift
         FROM drift
        ORDER BY abs_drift DESC, user_id
        LIMIT $1
     )
     SELECT COUNT(*)::text AS count,
            COALESCE(SUM(abs_drift), 0)::text AS absolute_credits,
            COALESCE(
              (SELECT jsonb_agg(user_id::text ORDER BY abs_drift DESC, user_id) FROM top_ids),
              '[]'::jsonb
            ) AS ids
       FROM drift`,
    [sampleLimit],
    runner,
  );

  const period = await query<DriftProbeRow>(
    `/* billing_reconciliation:period */
     WITH ledger AS (
       SELECT user_id, SUM(delta)::bigint AS ledger_sum
         FROM credit_ledger
        WHERE bucket = 'period'
        GROUP BY user_id
     ), drift AS (
       SELECT us.user_id,
              ABS(us.period_credits - COALESCE(l.ledger_sum, 0))::bigint AS abs_drift
         FROM user_subscriptions us
         LEFT JOIN ledger l ON l.user_id = us.user_id
        WHERE us.status = 'active'
          AND us.period_credits <> COALESCE(l.ledger_sum, 0)
     ), top_ids AS (
       SELECT user_id, abs_drift
         FROM drift
        ORDER BY abs_drift DESC, user_id
        LIMIT $1
     )
     SELECT COUNT(*)::text AS count,
            COALESCE(SUM(abs_drift), 0)::text AS absolute_credits,
            COALESCE(
              (SELECT jsonb_agg(user_id::text ORDER BY abs_drift DESC, user_id) FROM top_ids),
              '[]'::jsonb
            ) AS ids
       FROM drift`,
    [sampleLimit],
    runner,
  );

  const usage = await query<UsageProbeRow>(
    `/* billing_reconciliation:usage_and_tapes */
     WITH debit_by_usage AS (
       SELECT cl.user_id,
              cl.ref_id AS usage_id,
              (-SUM(cl.delta))::bigint AS actual_debit,
              BOOL_OR(COALESCE(cl.memo, '') LIKE '%clamped%') AS explicitly_clamped
         FROM credit_ledger cl
        WHERE cl.ref_type = 'usage_record'
          AND cl.ref_id ~ '^[1-9][0-9]*$'
          AND cl.reason IN ('chat', 'agent_chat')
          AND cl.delta < 0
        GROUP BY cl.user_id, cl.ref_id
     ), usage_gap AS (
       SELECT ur.id AS usage_id,
              ABS(ur.cost_credits - COALESCE(d.actual_debit, 0))::bigint AS abs_gap
         FROM usage_records ur
         LEFT JOIN debit_by_usage d
           ON d.user_id = ur.user_id AND d.usage_id = ur.id::text
        WHERE ur.status = 'success'
          AND ur.cost_credits > 0
          AND NOT COALESCE(d.explicitly_clamped, FALSE)
          AND ur.cost_credits <> COALESCE(d.actual_debit, 0)
     ), usage_top AS (
       SELECT usage_id, abs_gap
         FROM usage_gap
        ORDER BY abs_gap DESC, usage_id
        LIMIT $1
     ), tape_gap AS (
       SELECT substring(t.user_id FROM 3)::bigint AS user_id
         FROM client_session_turn_tapes t
        WHERE t.status = 'completed'
          AND t.created_at >= $2::bigint
          AND COALESCE(t.usage->>'outputTokens', '') ~ '^[0-9]+$'
          AND (t.usage->>'outputTokens')::bigint > 0
          AND t.user_id ~ '^c:[1-9][0-9]*$'
          AND NOT EXISTS (
            SELECT 1
              FROM usage_records ur
             WHERE ur.user_id = substring(t.user_id FROM 3)::bigint
               AND (ur.turn_key = t.turn_key OR ur.parent_turn_key = t.turn_key)
          )
     ), tape_top AS (
       SELECT DISTINCT user_id
         FROM tape_gap
        ORDER BY user_id
        LIMIT $1
     )
     SELECT (SELECT COUNT(*) FROM usage_gap)::text AS usage_gap_count,
            COALESCE((SELECT SUM(abs_gap) FROM usage_gap), 0)::text AS usage_gap_credits,
            COALESCE(
              (SELECT jsonb_agg(usage_id::text ORDER BY abs_gap DESC, usage_id) FROM usage_top),
              '[]'::jsonb
            ) AS usage_ids,
            (SELECT COUNT(*) FROM tape_gap)::text AS tape_gap_count,
            COALESCE(
              (SELECT jsonb_agg(user_id::text ORDER BY user_id) FROM tape_top),
              '[]'::jsonb
            ) AS tape_user_ids`,
    [sampleLimit, cutoffMs.toString()],
    runner,
  );

  const clamp = await query<ClampProbeRow>(
    `/* billing_reconciliation:clamp */
     WITH recent_usage AS (
       SELECT id, user_id, cost_credits
         FROM usage_records
        WHERE status = 'success'
          AND cost_credits > 0
          AND created_at >= to_timestamp($2::double precision / 1000.0)
     ), debit_by_usage AS (
       SELECT cl.user_id,
              cl.ref_id AS usage_id,
              (-SUM(cl.delta))::bigint AS actual_debit,
              BOOL_OR(COALESCE(cl.memo, '') LIKE '%clamped%') AS explicitly_clamped
         FROM credit_ledger cl
         JOIN recent_usage ur
           ON cl.user_id = ur.user_id
          AND cl.ref_type = 'usage_record'
          AND cl.ref_id = ur.id::text
        WHERE cl.reason IN ('chat', 'agent_chat')
          AND cl.delta < 0
        GROUP BY cl.user_id, cl.ref_id
     ), clamps AS (
       SELECT ur.id AS usage_id,
              GREATEST(ur.cost_credits - d.actual_debit, 0)::bigint AS uncollected
         FROM recent_usage ur
         JOIN debit_by_usage d
           ON d.user_id = ur.user_id AND d.usage_id = ur.id::text
        WHERE d.explicitly_clamped
     ), top_ids AS (
       SELECT usage_id, uncollected
         FROM clamps
        ORDER BY uncollected DESC, usage_id
        LIMIT $1
     )
     SELECT COUNT(*)::text AS count,
            COALESCE(SUM(uncollected), 0)::text AS uncollected_credits,
            COALESCE(
              (SELECT jsonb_agg(usage_id::text ORDER BY uncollected DESC, usage_id) FROM top_ids),
              '[]'::jsonb
            ) AS usage_ids
       FROM clamps`,
    [sampleLimit, cutoffMs.toString()],
    runner,
  );

  const w = wallet.rows[0]!;
  const p = period.rows[0]!;
  const u = usage.rows[0]!;
  const c = clamp.rows[0]!;
  return {
    wallet: { count: w.count, absoluteCredits: w.absolute_credits, userIds: ids(w.ids) },
    period: { count: p.count, absoluteCredits: p.absolute_credits, userIds: ids(p.ids) },
    usage: {
      count: u.usage_gap_count,
      absoluteCredits: u.usage_gap_credits,
      usageIds: ids(u.usage_ids),
      tapeGapCount: u.tape_gap_count,
      tapeUserIds: ids(u.tape_user_ids),
    },
    clamp: {
      count: c.count,
      uncollectedCredits: c.uncollected_credits,
      usageIds: ids(c.usage_ids),
    },
  };
}

export async function runBillingReconciliation(
  opts: BillingReconciliationOptions = {},
): Promise<number> {
  const nowMs = opts.nowMs ?? Date.now();
  const runner = opts.runner ?? getPool();
  const enqueue = opts.enqueue ?? safeEnqueueAlert;
  const snapshot = await scanBillingReconciliation(runner, nowMs);
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const observedAt = new Date(nowMs).toISOString();
  let alerted = 0;

  if (positive(snapshot.wallet.count)) {
    enqueue({
      event_type: EVENTS.BILLING_WALLET_DRIFT,
      severity: "critical",
      title: "钱包余额与流水发生漂移",
      body: `每日对账发现 ${snapshot.wallet.count} 个钱包不一致，绝对差额合计 ${snapshot.wallet.absoluteCredits} 积分。`,
      payload: { source: "billingReconciliation", observed_at: observedAt, ...snapshot.wallet },
      dedupe_key: `${EVENTS.BILLING_WALLET_DRIFT}:${day}`,
      dedupe_all_statuses: true,
    });
    alerted += 1;
  }
  if (positive(snapshot.period.count)) {
    enqueue({
      event_type: EVENTS.BILLING_PERIOD_DRIFT,
      severity: "critical",
      title: "期内余额与流水发生漂移",
      body: `每日对账发现 ${snapshot.period.count} 个 active 期内桶不一致，绝对差额合计 ${snapshot.period.absoluteCredits} 积分。`,
      payload: { source: "billingReconciliation", observed_at: observedAt, ...snapshot.period },
      dedupe_key: `${EVENTS.BILLING_PERIOD_DRIFT}:${day}`,
      dedupe_all_statuses: true,
    });
    alerted += 1;
  }
  if (positive(snapshot.usage.count) || positive(snapshot.usage.tapeGapCount)) {
    enqueue({
      event_type: EVENTS.BILLING_USAGE_LEDGER_GAP,
      severity: "critical",
      title: "用量、流水或完成卷缺少对应记录",
      body:
        `每日对账发现 ${snapshot.usage.count} 条非 clamp 成功用量与扣费流水不一致` +
        `（绝对差额 ${snapshot.usage.absoluteCredits} 积分），另有 ${snapshot.usage.tapeGapCount} 条近 24 小时有输出完成卷缺少用量记录。`,
      payload: { source: "billingReconciliation", observed_at: observedAt, ...snapshot.usage },
      dedupe_key: `${EVENTS.BILLING_USAGE_LEDGER_GAP}:${day}`,
      dedupe_all_statuses: true,
    });
    alerted += 1;
  }
  if (
    BigInt(snapshot.clamp.count) >= BILLING_CLAMP_COUNT_THRESHOLD ||
    BigInt(snapshot.clamp.uncollectedCredits) >= BILLING_CLAMP_UNCOLLECTED_THRESHOLD
  ) {
    enqueue({
      event_type: EVENTS.BILLING_CLAMP_SPIKE,
      severity: "warning",
      title: "余额不足 clamp 超过日常阈值",
      body: `过去 24 小时发生 ${snapshot.clamp.count} 笔 clamp，未收积分合计 ${snapshot.clamp.uncollectedCredits}。`,
      payload: { source: "billingReconciliation", observed_at: observedAt, ...snapshot.clamp },
      dedupe_key: `${EVENTS.BILLING_CLAMP_SPIKE}:${day}`,
      dedupe_all_statuses: true,
    });
    alerted += 1;
  }

  return alerted;
}
