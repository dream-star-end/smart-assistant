/**
 * T-60 — 超管积分流水查询(GET /api/admin/ledger)。
 *
 * credit_ledger 是 append-only,一切写入走 billing/ledger 的 adjust(含 adminAdjust,
 * 本身已在 tx 内写 admin_audit)。本文件只做读。
 *
 * ### 过滤
 * - user_id(可选):精确
 * - reason(可选):单值,限制在 schema 白名单内(见 0002 CHECK)
 * - before(可选):keyset 游标(上一次的最小 id)
 * - limit:默认 50,上限 500
 */

import { query } from "../db/queries.js";

export const LEDGER_REASONS = [
  "topup",
  "chat",
  "agent_chat",
  "agent_subscription",
  "refund",
  "admin_adjust",
  "promotion",
] as const;
export type LedgerReason = (typeof LEDGER_REASONS)[number];

export const LEDGER_DEFAULT_LIMIT = 50;
export const LEDGER_MAX_LIMIT = 500;

export interface LedgerRowView {
  id: string;
  user_id: string;
  delta: string;
  balance_after: string;
  reason: string;
  ref_type: string | null;
  ref_id: string | null;
  memo: string | null;
  created_at: Date;
}

export interface ListLedgerInput {
  userId?: string | number | bigint;
  reason?: LedgerReason;
  before?: string;
  limit?: number;
}

export interface ListLedgerResult {
  rows: LedgerRowView[];
  next_before: string | null;
}

const ID_RE = /^[1-9][0-9]{0,19}$/;

export async function listLedger(input: ListLedgerInput = {}): Promise<ListLedgerResult> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (input.userId !== undefined) {
    const s = String(input.userId);
    if (!ID_RE.test(s)) throw new RangeError("invalid_user_id");
    params.push(s);
    where.push(`user_id = $${params.length}::bigint`);
  }
  if (input.reason !== undefined) {
    if (!(LEDGER_REASONS as readonly string[]).includes(input.reason)) {
      throw new RangeError("invalid_reason");
    }
    params.push(input.reason);
    where.push(`reason = $${params.length}`);
  }
  if (input.before !== undefined) {
    if (!ID_RE.test(input.before)) throw new RangeError("invalid_before");
    params.push(input.before);
    where.push(`id < $${params.length}::bigint`);
  }

  let limit = input.limit ?? LEDGER_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) limit = LEDGER_DEFAULT_LIMIT;
  if (limit > LEDGER_MAX_LIMIT) limit = LEDGER_MAX_LIMIT;

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  params.push(limit);
  const r = await query<LedgerRowView>(
    `SELECT id::text            AS id,
            user_id::text       AS user_id,
            delta::text         AS delta,
            balance_after::text AS balance_after,
            reason,
            ref_type,
            ref_id,
            memo,
            created_at
     FROM credit_ledger ${whereClause}
     ORDER BY id DESC
     LIMIT $${params.length}`,
    params,
  );
  const rows = r.rows;
  const nextBefore = rows.length === limit ? rows[rows.length - 1].id : null;
  return { rows, next_before: nextBefore };
}
