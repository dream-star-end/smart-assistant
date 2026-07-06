/**
 * 企业版(P3.1)批次 D — org 发票数据层(方案 §5)。
 *
 * 两张表(0114):
 *   org_invoice_profiles  — 每 org 一行抬头(upsert)。
 *   org_invoice_requests  — 按已付订单发起的开票申请,平台人工处理 V1。
 *
 * 校验红线(createInvoiceRequest):
 *   1. 抬头必须已维护(无 profile → 拒),申请落库快照冻结当时抬头。
 *   2. order_ids 全部属本 org(orders.org_id=本 org,批次 B 的 0112 列,SQL 直接写)。
 *   3. 全部 status='paid'。
 *   4. 未被其它「未拒绝」(pending/issued)申请占用(数组 `&&` 重叠检测)。
 *   5. amount_cents = 服务端合计所选订单,**绝不接受客户端金额**。
 *
 * 并发:创建申请在事务内先 `SELECT ... FROM orgs FOR UPDATE`(org active 校验 + 串行化
 * 同 org 并发申请,消除占用竞态),遵循全局锁序 orgs→users→…(方案 §3)。
 *
 * 平台处理(admin 域函数,收在本文件保持发票 DB 逻辑单一权威):列队 + issued/rejected
 * 状态机 + admin_audit。
 */

import type { PoolClient } from "pg";
import { query, tx, type QueryRunner } from "../db/queries.js";
import { getPool } from "../db/index.js";
import { writeAdminAudit } from "../admin/audit.js";
import { OrgError } from "./types.js";

// ─── 抬头 profile ───────────────────────────────────────────────────

export interface InvoiceProfile {
  org_id: string;
  title: string;
  tax_id: string | null;
  address: string | null;
  email: string | null;
  updated_by: string | null;
  updated_at: Date;
}

const PROFILE_COLUMNS = `org_id::text AS org_id, title, tax_id, address, email,
  updated_by::text AS updated_by, updated_at`;

export async function getInvoiceProfile(
  orgId: string,
  runner: QueryRunner = getPool() as unknown as QueryRunner,
): Promise<InvoiceProfile | null> {
  const r = await query<InvoiceProfile>(
    `SELECT ${PROFILE_COLUMNS} FROM org_invoice_profiles WHERE org_id = $1::bigint`,
    [orgId],
    runner,
  );
  return r.rows[0] ?? null;
}

export interface InvoiceProfileInput {
  title: string;
  taxId?: string | null;
  address?: string | null;
  email?: string | null;
}

/** 归一化可选文本:去空白,空串 → null,超长 → 截断保护由 CHECK/长度校验负责。 */
function optText(v: string | null | undefined, field: string, max: number): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw new OrgError(400, "VALIDATION", `${field} must be a string`);
  const t = v.trim();
  if (t.length === 0) return null;
  if (t.length > max) throw new OrgError(400, "VALIDATION", `${field} too long (max ${max})`);
  return t;
}

/** upsert 抬头(PK=org_id)。title 必填 1..200。 */
export async function upsertInvoiceProfile(
  orgId: string,
  input: InvoiceProfileInput,
  updatedBy: string,
): Promise<InvoiceProfile> {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (title.length === 0 || title.length > 200) {
    throw new OrgError(400, "VALIDATION", "invoice title must be 1..200 chars");
  }
  const taxId = optText(input.taxId, "tax_id", 100);
  const address = optText(input.address, "address", 500);
  const email = optText(input.email, "email", 200);
  if (email !== null && !email.includes("@")) {
    throw new OrgError(400, "VALIDATION", "invalid invoice email");
  }
  const r = await query<InvoiceProfile>(
    `INSERT INTO org_invoice_profiles (org_id, title, tax_id, address, email, updated_by, updated_at)
     VALUES ($1::bigint, $2, $3, $4, $5, $6::bigint, NOW())
     ON CONFLICT (org_id) DO UPDATE
       SET title = EXCLUDED.title, tax_id = EXCLUDED.tax_id, address = EXCLUDED.address,
           email = EXCLUDED.email, updated_by = EXCLUDED.updated_by, updated_at = NOW()
     RETURNING ${PROFILE_COLUMNS}`,
    [orgId, title, taxId, address, email, updatedBy],
  );
  return r.rows[0];
}

// ─── 开票申请 requests ──────────────────────────────────────────────

export type InvoiceStatus = "pending" | "issued" | "rejected";

export interface InvoiceRequestRow {
  id: string;
  org_id: string;
  order_ids: string[];
  amount_cents: string;
  profile_snapshot: unknown;
  status: InvoiceStatus;
  requested_by: string | null;
  admin_note: string | null;
  processed_by: string | null;
  processed_at: Date | null;
  created_at: Date;
}

/** 平台队列视图额外带 org_name。 */
export interface AdminInvoiceRequestRow extends InvoiceRequestRow {
  org_name: string;
}

const REQUEST_COLUMNS = `id::text AS id, org_id::text AS org_id,
  ARRAY(SELECT unnest(order_ids)::text) AS order_ids,
  amount_cents::text AS amount_cents, profile_snapshot, status,
  requested_by::text AS requested_by, admin_note,
  processed_by::text AS processed_by, processed_at, created_at`;

/** 某 org 的开票申请(按时间倒序)。 */
export async function listInvoiceRequests(orgId: string): Promise<InvoiceRequestRow[]> {
  const r = await query<InvoiceRequestRow>(
    `SELECT ${REQUEST_COLUMNS} FROM org_invoice_requests
      WHERE org_id = $1::bigint
      ORDER BY id DESC`,
    [orgId],
  );
  return r.rows;
}

/** order_ids 输入归一化:每项 BIGINT 文本、去重、非空、限量。 */
function normalizeOrderIds(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new OrgError(400, "VALIDATION", "order_ids must be a non-empty array");
  }
  if (raw.length > 200) {
    throw new OrgError(400, "VALIDATION", "too many orders in one request (max 200)");
  }
  const seen = new Set<string>();
  for (const v of raw) {
    const s = typeof v === "number" ? String(v) : v;
    if (typeof s !== "string" || !/^[1-9][0-9]{0,19}$/.test(s)) {
      throw new OrgError(400, "VALIDATION", `invalid order id: ${String(v)}`);
    }
    seen.add(s);
  }
  return [...seen];
}

/**
 * 发起开票申请。事务内:
 *   orgs FOR UPDATE(org active + 串行化)→ 抬头存在校验 → 订单归属/已付校验
 *   → 占用检测(`&&`)→ 合计金额 → 快照抬头 → INSERT pending。
 * 返回新建的申请行。
 */
export async function createInvoiceRequest(
  orgId: string,
  orderIdsRaw: unknown,
  requestedBy: string,
): Promise<InvoiceRequestRow> {
  const orderIds = normalizeOrderIds(orderIdsRaw);

  return tx(async (client: PoolClient) => {
    // org active + 串行化同 org 并发申请(消除占用竞态)。
    const orgRow = await client.query<{ status: string }>(
      `SELECT status FROM orgs WHERE id = $1::bigint FOR UPDATE`,
      [orgId],
    );
    if (orgRow.rows.length === 0) throw new OrgError(404, "NOT_FOUND", "org not found");
    if (orgRow.rows[0].status !== "active") {
      throw new OrgError(403, "ORG_NOT_ACTIVE", "organization is not active");
    }

    // 抬头必须已维护(快照冻结)。
    const profile = await getInvoiceProfile(orgId, client);
    if (!profile) {
      throw new OrgError(400, "PROFILE_REQUIRED", "invoice profile must be set before requesting");
    }

    // 订单归属 + 已付:命中数必须等于去重后的订单数,合计金额服务端算。
    const orderCheck = await client.query<{ n: string; total: string }>(
      `SELECT COUNT(*)::text AS n, COALESCE(SUM(amount_cents), 0)::text AS total
         FROM orders
        WHERE id = ANY($2::bigint[]) AND org_id = $1::bigint AND status = 'paid'`,
      [orgId, orderIds],
    );
    if (Number(orderCheck.rows[0].n) !== orderIds.length) {
      throw new OrgError(
        400,
        "INVALID_ORDERS",
        "some orders are not paid org orders (must belong to this org and be paid)",
      );
    }
    const amountCents = orderCheck.rows[0].total;

    // 占用检测:任一订单已在本 org 的 pending/issued 申请中 → 拒。
    const occupied = await client.query(
      `SELECT 1 FROM org_invoice_requests
        WHERE org_id = $1::bigint AND status IN ('pending', 'issued')
          AND order_ids && $2::bigint[]
        LIMIT 1`,
      [orgId, orderIds],
    );
    if (occupied.rows.length > 0) {
      throw new OrgError(409, "ORDER_ALREADY_REQUESTED", "one or more orders already have an active invoice request");
    }

    const snapshot = {
      title: profile.title,
      tax_id: profile.tax_id,
      address: profile.address,
      email: profile.email,
    };
    const r = await client.query<InvoiceRequestRow>(
      `INSERT INTO org_invoice_requests
         (org_id, order_ids, amount_cents, profile_snapshot, status, requested_by)
       VALUES ($1::bigint, $2::bigint[], $3::bigint, $4::jsonb, 'pending', $5::bigint)
       RETURNING ${REQUEST_COLUMNS}`,
      [orgId, orderIds, amountCents, JSON.stringify(snapshot), requestedBy],
    );
    return r.rows[0];
  });
}

// ─── 平台超管:队列 + 处理状态机 ────────────────────────────────────

export interface ListAdminInvoicesInput {
  status?: InvoiceStatus;
  limit?: number;
  /** keyset:取 id < cursor。 */
  cursor?: string;
}

export interface ListAdminInvoicesResult {
  rows: AdminInvoiceRequestRow[];
  next_cursor: string | null;
}

const ADMIN_INVOICE_DEFAULT_LIMIT = 50;
const ADMIN_INVOICE_MAX_LIMIT = 200;

/** 平台开票队列(全 org,可按 status 过滤,id DESC keyset)。 */
export async function listAdminInvoiceRequests(
  input: ListAdminInvoicesInput = {},
): Promise<ListAdminInvoicesResult> {
  const limit = Math.min(Math.max(input.limit ?? ADMIN_INVOICE_DEFAULT_LIMIT, 1), ADMIN_INVOICE_MAX_LIMIT);
  const status = input.status ?? null;
  const cursor = input.cursor && /^[1-9][0-9]{0,19}$/.test(input.cursor) ? input.cursor : null;
  const r = await query<AdminInvoiceRequestRow>(
    `SELECT r.id::text AS id, r.org_id::text AS org_id,
            ARRAY(SELECT unnest(r.order_ids)::text) AS order_ids,
            r.amount_cents::text AS amount_cents, r.profile_snapshot, r.status,
            r.requested_by::text AS requested_by, r.admin_note,
            r.processed_by::text AS processed_by, r.processed_at, r.created_at,
            o.name AS org_name
       FROM org_invoice_requests r
       JOIN orgs o ON o.id = r.org_id
      WHERE ($1::text IS NULL OR r.status = $1)
        AND ($2::bigint IS NULL OR r.id < $2::bigint)
      ORDER BY r.id DESC
      LIMIT $3`,
    [status, cursor, limit + 1],
  );
  const hasMore = r.rows.length > limit;
  const rows = hasMore ? r.rows.slice(0, limit) : r.rows;
  return { rows, next_cursor: hasMore ? rows[rows.length - 1].id : null };
}

export interface ProcessInvoiceCtx {
  adminId: string;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * 平台处理开票申请:pending → issued | rejected(+ admin_note),写 admin_audit。
 * 幂等防线:非 pending → 409(不重复处理已终态申请)。
 */
export async function processInvoiceRequest(
  id: string,
  status: "issued" | "rejected",
  adminNote: string | null,
  ctx: ProcessInvoiceCtx,
): Promise<InvoiceRequestRow> {
  if (status !== "issued" && status !== "rejected") {
    throw new OrgError(400, "VALIDATION", "status must be issued or rejected");
  }
  return tx(async (client: PoolClient) => {
    const cur = await client.query<{ status: InvoiceStatus; org_id: string }>(
      `SELECT status, org_id::text AS org_id FROM org_invoice_requests WHERE id = $1::bigint FOR UPDATE`,
      [id],
    );
    if (cur.rows.length === 0) throw new OrgError(404, "NOT_FOUND", "invoice request not found");
    if (cur.rows[0].status !== "pending") {
      throw new OrgError(409, "ALREADY_PROCESSED", `invoice request already ${cur.rows[0].status}`);
    }
    const r = await client.query<InvoiceRequestRow>(
      `UPDATE org_invoice_requests
          SET status = $2, admin_note = $3, processed_by = $4::bigint, processed_at = NOW()
        WHERE id = $1::bigint
        RETURNING ${REQUEST_COLUMNS}`,
      [id, status, adminNote, ctx.adminId],
    );
    await writeAdminAudit(client, {
      adminId: ctx.adminId,
      action: "org.invoice.process",
      target: `org_invoice:${id}`,
      before: { status: "pending" },
      after: { status, admin_note: adminNote, org_id: cur.rows[0].org_id },
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    });
    return r.rows[0];
  });
}
