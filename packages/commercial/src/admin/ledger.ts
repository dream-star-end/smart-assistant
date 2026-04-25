/**
 * T-60 — 超管积分流水查询(GET /api/admin/ledger)。
 *
 * credit_ledger 是 append-only,一切写入走 billing/ledger 的 adjust(含 adminAdjust,
 * 本身已在 tx 内写 admin_audit)。本文件只做读。
 *
 * ### 过滤
 * - user_id(可选):精确
 * - reason(可选):单值,限制在 schema 白名单内(见 0002 CHECK)
 * - from / to(可选):created_at 时间范围(ISO timestamptz,后端只做 timestamptz 强转)
 * - before(可选):keyset 游标(上一次的最小 id)
 * - limit:默认 50,上限 500
 *
 * ### CSV 导出(P1-5)
 * `buildLedgerCsv(input)` 一次性查 ≤ LEDGER_CSV_MAX_ROWS 行内存生成 CSV 字符串。
 * 不做 PG cursor 流式 — 当前数据量 < 10k 行,内存 + 一次性 SELECT 简单且足够。
 * CSV 注入防护:每个单元格若以 `=`/`+`/`-`/`@`/`\t`/`\r` 开头加 `'` 前缀。
 */

import { query } from "../db/queries.js";
import { csvEscapeCell } from "./csvHelper.js";

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
/** CSV 导出单次最大行数。10k * ~200 byte ≈ 2MB,内存 OK。 */
export const LEDGER_CSV_MAX_ROWS = 50000;

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
  /** ISO timestamptz 字符串。Date.parse 不可解析时抛 invalid_from。 */
  from?: string;
  to?: string;
  before?: string;
  limit?: number;
}

export interface ListLedgerResult {
  rows: LedgerRowView[];
  next_before: string | null;
}

const ID_RE = /^[1-9][0-9]{0,19}$/;

/**
 * 构建 from/to/userId/reason/before 共用的 WHERE。
 * 抛 RangeError("invalid_X") 由 caller 翻 400。
 */
function buildLedgerWhere(input: ListLedgerInput): { where: string[]; params: unknown[] } {
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
  if (input.from !== undefined) {
    if (!Number.isFinite(Date.parse(input.from))) throw new RangeError("invalid_from");
    params.push(input.from);
    where.push(`created_at >= $${params.length}::timestamptz`);
  }
  if (input.to !== undefined) {
    if (!Number.isFinite(Date.parse(input.to))) throw new RangeError("invalid_to");
    params.push(input.to);
    where.push(`created_at <= $${params.length}::timestamptz`);
  }
  if (input.before !== undefined) {
    if (!ID_RE.test(input.before)) throw new RangeError("invalid_before");
    params.push(input.before);
    // 用 qualified `cl.id` 防 SELECT 列别名 `id::text AS id` 误把 cursor 比较拽
    // 进字符串域(详见 listLedger / buildLedgerCsv 的 ORDER BY 同模式注释)。
    where.push(`cl.id < $${params.length}::bigint`);
  }
  return { where, params };
}

export async function listLedger(input: ListLedgerInput = {}): Promise<ListLedgerResult> {
  const { where, params } = buildLedgerWhere(input);

  let limit = input.limit ?? LEDGER_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) limit = LEDGER_DEFAULT_LIMIT;
  if (limit > LEDGER_MAX_LIMIT) limit = LEDGER_MAX_LIMIT;

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  params.push(limit);
  // ORDER BY 用 qualified `cl.id` —— `SELECT id::text AS id` 让 PG 的 ORDER BY
  // 优先 SELECT alias(text 类型)做字典序排序("9" > "57" > "6"),线上能复现。
  // 用 `cl.id` 强制走 source 列(bigint),数值降序正确。
  const r = await query<LedgerRowView>(
    `SELECT cl.id::text            AS id,
            cl.user_id::text       AS user_id,
            cl.delta::text         AS delta,
            cl.balance_after::text AS balance_after,
            cl.reason,
            cl.ref_type,
            cl.ref_id,
            cl.memo,
            cl.created_at
     FROM credit_ledger cl ${whereClause}
     ORDER BY cl.id DESC
     LIMIT $${params.length}`,
    params,
  );
  const rows = r.rows;
  const nextBefore = rows.length === limit ? rows[rows.length - 1].id : null;
  return { rows, next_before: nextBefore };
}

// ─── CSV 导出(P1-5)──────────────────────────────────────────────
//
// csvEscapeCell 已抽到 ./csvHelper.ts(M8.4),与 users.csv / orders.csv 共用。

const CSV_HEADER = [
  "id",
  "user_id",
  "delta_cents",
  "balance_after_cents",
  "reason",
  "ref_type",
  "ref_id",
  "memo",
  "created_at",
];

export interface BuildLedgerCsvInput {
  userId?: string | number | bigint;
  reason?: LedgerReason;
  from?: string;
  to?: string;
}

export interface BuildLedgerCsvResult {
  csv: string;
  rowCount: number;
}

export async function buildLedgerCsv(input: BuildLedgerCsvInput = {}): Promise<BuildLedgerCsvResult> {
  // 不接 before/limit:CSV 永远从最新到最旧,LEDGER_CSV_MAX_ROWS 行硬上限。
  const { where, params } = buildLedgerWhere(input);
  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  params.push(LEDGER_CSV_MAX_ROWS);
  // 同 listLedger:qualified `cl.id` 防 SELECT alias 触发字典序排序。
  const r = await query<LedgerRowView>(
    `SELECT cl.id::text            AS id,
            cl.user_id::text       AS user_id,
            cl.delta::text         AS delta,
            cl.balance_after::text AS balance_after,
            cl.reason,
            cl.ref_type,
            cl.ref_id,
            cl.memo,
            cl.created_at
     FROM credit_ledger cl ${whereClause}
     ORDER BY cl.id DESC
     LIMIT $${params.length}`,
    params,
  );
  const lines: string[] = [CSV_HEADER.join(",")];
  for (const row of r.rows) {
    lines.push(
      [
        row.id,
        row.user_id,
        row.delta,
        row.balance_after,
        row.reason,
        row.ref_type,
        row.ref_id,
        row.memo,
        row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      ]
        .map(csvEscapeCell)
        .join(","),
    );
  }
  // RFC 4180 推荐 CRLF;Excel/Numbers/Sheets 都吃。末行也带 CRLF(end-of-record)。
  return { csv: `${lines.join("\r\n")}\r\n`, rowCount: r.rows.length };
}
