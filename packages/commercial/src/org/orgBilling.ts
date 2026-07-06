/**
 * 企业版(P3.1)批次 B — org 计费辅助层。
 *
 * 职责(单一收口,避免各计费模块复制 SQL):
 *   - resolveOrgBillingContext : settle 侧解析成员的 org 归属上下文(org_id + billing_enabled)。
 *     **计费链(proxyBilling.settleUsageAndLedger / minimax.mediaBilling)唯一 org 解析入口**——
 *     不在两处复制 `org_memberships JOIN orgs` 查询,防口径漂移。
 *   - listOrgLedger  : GET /api/org/ledger —— org 桶流水 keyset 分页(bucket='org_wallet')。
 *   - listOrgOrders  : GET /api/org/orders —— org 充值单 keyset 分页。
 *   - getOrgBalance  : GET /api/org/balance —— orgs.credits 只读。
 *
 * 权威源纪律:org 归属对计费的权威是**写时打戳**(usage_records.org_id / credit_ledger.org_id),
 * 本 resolve 只在 settle 那一刻解析"成员当前是否在某 active org"。解析与扣费之间 org 可能被停用,
 * spendTwoBucket 的 orgs FOR UPDATE(status='active')会 fail-open 降级个人桶——但用量归属(org_id)
 * 仍打戳(成员在 org 语境),二者解耦(方案 §3)。
 *
 * BIGINT/字符串贯穿,禁止 Number 化(cursor/id/credits 一律 ::text)。
 */

import type { QueryRunner } from "../db/queries.js";
import { query } from "../db/queries.js";

/** settle 解析出的 org 计费上下文。null = 成员不在任何 active org(纯个人计费)。 */
export interface OrgBillingContext {
  /** 成员当前 active org 的 id(BIGINT ::text)。 */
  orgId: string;
  /**
   * 该成员是否花 org 钱包(org_memberships.billing_enabled)。
   *   - true  → spendTwoBucket 传 orgId,org 钱包为第 0 优先桶
   *   - false → 仍打戳 usage_records.org_id(org 语境),但个人桶付费(不传 orgId)
   */
  billingEnabled: boolean;
}

/**
 * 解析成员在 settle 那一刻的 org 归属上下文。**tx 内、锁前**一次索引点查
 * (idx_org_memberships_user + orgs PK)。成员非 active / org 非 active → null(纯个人计费)。
 *
 * 已知并接受的竞态语义:本读不加行锁,settle 期间管理员并发改 billing_enabled/移除成员,
 * 该 turn 仍按解析时刻的归属计费(turn 边界内的毫秒窗口)。锁 membership 行会给
 * 扣费热路径引入与成员管理事务的锁交叉,收益(一个 turn 的归属精度)不值代价——
 * 权威裁决记录于方案文档 + Codex 审计 P1b。
 *
 * @param runner tx 内的 PoolClient(settle 收口传自己的事务 client),或 Pool(独立解析)。
 */
export async function resolveOrgBillingContext(
  runner: QueryRunner,
  userId: bigint | number | string,
): Promise<OrgBillingContext | null> {
  const r = await query<{ org_id: string; billing_enabled: boolean }>(
    `SELECT m.org_id::text AS org_id, m.billing_enabled
       FROM org_memberships m
       JOIN orgs o ON o.id = m.org_id
      WHERE m.user_id = $1::bigint AND m.status = 'active' AND o.status = 'active'
      LIMIT 1`,
    [String(userId)],
    runner,
  );
  const row = r.rows[0];
  if (!row) return null;
  return { orgId: row.org_id, billingEnabled: row.billing_enabled };
}

/**
 * 成员可动用的 org 钱包余额(preCheck 预检门用,poolside 只读)。
 *
 * 语义与 resolveOrgBillingContext + spendTwoBucket 的 org 桶参与条件严格一致:
 * 成员 active + billing_enabled + org active,否则 0n(org 钱包不参与该成员付费)。
 * 若不同步此条件,会出现"预检放行但扣费落不到 org 桶"或反向的 402 误拒
 * (企业核心场景 = 公司付费、成员个人余额为 0)。
 */
export async function getOrgSpendableForUser(userId: bigint | number | string): Promise<bigint> {
  const r = await query<{ credits: string }>(
    `SELECT o.credits::text AS credits
       FROM org_memberships m
       JOIN orgs o ON o.id = m.org_id
      WHERE m.user_id = $1::bigint AND m.status = 'active' AND m.billing_enabled
        AND o.status = 'active'
      LIMIT 1`,
    [String(userId)],
  );
  const row = r.rows[0];
  return row ? BigInt(row.credits) : 0n;
}

// ─── 只读读路径(GET /api/org/*)────────────────────────────────────────

/** org 钱包当前余额(orgs.credits,BIGINT)。org 不存在 → null。 */
export async function getOrgBalance(orgId: string | bigint): Promise<bigint | null> {
  const r = await query<{ credits: string }>(
    `SELECT credits::text AS credits FROM orgs WHERE id = $1::bigint`,
    [String(orgId)],
  );
  const row = r.rows[0];
  return row ? BigInt(row.credits) : null;
}

export interface OrgLedgerRow {
  id: string;
  org_id: string;
  user_id: string;
  delta: string;
  balance_after: string;
  reason: string;
  ref_type: string | null;
  ref_id: string | null;
  memo: string | null;
  created_at: Date;
}

export interface KeysetOpts {
  limit?: number;
  /** keyset 游标:上一页最后一行 id,取 id < cursor(BIGINT 数字串)。 */
  cursor?: string;
}

const LEDGER_DEFAULT_LIMIT = 50;
const LEDGER_MAX_LIMIT = 200;

/**
 * org 钱包流水 keyset 分页(充值 topup / 消耗 chat / 调整 admin_adjust,统一 bucket='org_wallet')。
 * ORDER BY id DESC(BIGSERIAL 单调,keyset 稳定;created_at=tx 时间不适合排序,同 listLedger)。
 */
export async function listOrgLedger(
  orgId: string | bigint,
  opts: KeysetOpts = {},
): Promise<{ rows: OrgLedgerRow[]; next_cursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? LEDGER_DEFAULT_LIMIT, 1), LEDGER_MAX_LIMIT);
  const cursor = opts.cursor && /^[1-9][0-9]{0,19}$/.test(opts.cursor) ? opts.cursor : null;
  const r = await query<OrgLedgerRow>(
    `SELECT cl.id::text AS id, cl.org_id::text AS org_id, cl.user_id::text AS user_id,
            cl.delta::text AS delta, cl.balance_after::text AS balance_after,
            cl.reason, cl.ref_type, cl.ref_id, cl.memo, cl.created_at
       FROM credit_ledger cl
      WHERE cl.org_id = $1::bigint AND cl.bucket = 'org_wallet'
        AND ($2::bigint IS NULL OR cl.id < $2::bigint)
      ORDER BY cl.id DESC
      LIMIT $3`,
    [String(orgId), cursor, limit + 1],
  );
  const hasMore = r.rows.length > limit;
  const page = hasMore ? r.rows.slice(0, limit) : r.rows;
  return { rows: page, next_cursor: hasMore ? page[page.length - 1]!.id : null };
}

export interface OrgOrderRow {
  id: string;
  order_no: string;
  user_id: string;
  amount_cents: string;
  credits: string;
  status: string;
  kind: string;
  paid_at: Date | null;
  expires_at: Date;
  created_at: Date;
}

/** org 充值单列表 keyset 分页(ORDER BY id DESC)。 */
export async function listOrgOrders(
  orgId: string | bigint,
  opts: KeysetOpts = {},
): Promise<{ rows: OrgOrderRow[]; next_cursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? LEDGER_DEFAULT_LIMIT, 1), LEDGER_MAX_LIMIT);
  const cursor = opts.cursor && /^[1-9][0-9]{0,19}$/.test(opts.cursor) ? opts.cursor : null;
  const r = await query<OrgOrderRow>(
    `SELECT o.id::text AS id, o.order_no, o.user_id::text AS user_id,
            o.amount_cents::text AS amount_cents, o.credits::text AS credits,
            o.status, o.kind, o.paid_at, o.expires_at, o.created_at
       FROM orders o
      WHERE o.org_id = $1::bigint
        AND ($2::bigint IS NULL OR o.id < $2::bigint)
      ORDER BY o.id DESC
      LIMIT $3`,
    [String(orgId), cursor, limit + 1],
  );
  const hasMore = r.rows.length > limit;
  const page = hasMore ? r.rows.slice(0, limit) : r.rows;
  return { rows: page, next_cursor: hasMore ? page[page.length - 1]!.id : null };
}
