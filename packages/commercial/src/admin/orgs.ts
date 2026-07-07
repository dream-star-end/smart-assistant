/**
 * 平台超管(admin)org 数据层。
 *
 * 与 org/*(org 成员自助操作)分域:这里是**跨 org 的平台运维**:
 *   - listOrgs         : 全 org 列表(成员数 + credits + created_at,keyset 分页)
 *   - createOrgByEmail : 按 owner 邮箱建 org(找 user → 校验 → 建 org + owner membership + 审计)
 *   - patchOrg         : name/status/max_members 更新 + 审计
 *   - adjustOrgCredits : **本批次占位**(org 钱包变动必须带 ledger 流水,0112 批次 B 才落地)
 *
 * 单一列表机制:org/orgs.ts 不再重复实现 listOrgs —— 跨 org 列表是 admin 域,收在这里
 * (避免"org 成员操作"与"平台跨 org 运维"两套并行列表机制)。org/orgs.ts 只留单 org 原语。
 */

import type { PoolClient } from "pg";
import { query, tx } from "../db/queries.js";
import { writeAdminAudit } from "./audit.js";
import { createOrg, updateOrg, getOrgById, type OrgRow } from "../org/orgs.js";
import { OrgError, type OrgStatus } from "../org/types.js";

export interface OrgWithStatsRow extends OrgRow {
  member_count: number;
  /** 订阅摘要(0115;无订阅 → null)。运营可视:档位/席位/到期/状态。 */
  subscription: { plan_code: string; seats: number; period_end: string; status: string } | null;
}

export interface ListOrgsInput {
  q?: string;
  status?: OrgStatus;
  limit?: number;
  /** keyset 游标:上一页最后一行 id,取 id < cursor。 */
  cursor?: string;
}

export interface ListOrgsResult {
  rows: OrgWithStatsRow[];
  next_cursor: string | null;
}

const ORG_LIST_DEFAULT_LIMIT = 50;
const ORG_LIST_MAX_LIMIT = 200;

/** 全 org 列表(id DESC keyset 分页)。q → name ILIKE;status → 精确过滤。 */
export async function listOrgs(input: ListOrgsInput = {}): Promise<ListOrgsResult> {
  const limit = Math.min(Math.max(input.limit ?? ORG_LIST_DEFAULT_LIMIT, 1), ORG_LIST_MAX_LIMIT);
  const q = input.q && input.q.trim() !== "" ? input.q.trim() : null;
  const status = input.status ?? null;
  const cursor = input.cursor && /^[1-9][0-9]{0,19}$/.test(input.cursor) ? input.cursor : null;

  const r = await query<
    OrgRow & {
      member_count: string;
      sub_plan_code: string | null;
      sub_seats: number | null;
      sub_period_end: Date | string | null;
      sub_status: string | null;
    }
  >(
    `SELECT o.id::text AS id, o.name, o.status, o.credits::text AS credits, o.max_members,
            o.created_by::text AS created_by, o.created_at, o.updated_at,
            (SELECT COUNT(*) FROM org_memberships m
              WHERE m.org_id = o.id AND m.status = 'active')::text AS member_count,
            os.plan_code AS sub_plan_code, os.seats AS sub_seats,
            os.period_end AS sub_period_end, os.status AS sub_status
       FROM orgs o
       LEFT JOIN org_subscriptions os ON os.org_id = o.id
      WHERE ($1::text IS NULL OR o.name ILIKE '%' || $1 || '%')
        AND ($2::text IS NULL OR o.status = $2)
        AND ($3::bigint IS NULL OR o.id < $3::bigint)
      ORDER BY o.id DESC
      LIMIT $4`,
    [q, status, cursor, limit + 1],
  );
  const hasMore = r.rows.length > limit;
  const page = hasMore ? r.rows.slice(0, limit) : r.rows;
  const rows: OrgWithStatsRow[] = page.map(
    ({ member_count, sub_plan_code, sub_seats, sub_period_end, sub_status, ...org }) => ({
      ...org,
      member_count: Number(member_count),
      subscription:
        sub_plan_code !== null && sub_seats !== null && sub_period_end !== null && sub_status !== null
          ? {
              plan_code: sub_plan_code,
              seats: sub_seats,
              period_end:
                sub_period_end instanceof Date ? sub_period_end.toISOString() : String(sub_period_end),
              status: sub_status,
            }
          : null,
    }),
  );
  return { rows, next_cursor: hasMore ? rows[rows.length - 1].id : null };
}

export interface CreateOrgByEmailInput {
  name: string;
  ownerEmail: string;
  maxMembers?: number;
  adminId: string | bigint;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * 按 owner 邮箱建 org。owner user 必须:存在、active、无 active org。
 * tx:建 org + owner membership(createOrg)+ 写 admin_audit,原子提交。
 */
export async function createOrgByEmail(input: CreateOrgByEmailInput): Promise<OrgRow> {
  const email = input.ownerEmail.trim().toLowerCase();
  if (email.length === 0 || !email.includes("@")) {
    throw new OrgError(400, "VALIDATION", "invalid owner_email");
  }
  return tx(async (client: PoolClient) => {
    const owner = await client.query<{ id: string; status: string }>(
      `SELECT id::text AS id, status FROM users WHERE lower(email) = $1 LIMIT 1`,
      [email],
    );
    if (owner.rows.length === 0) {
      throw new OrgError(404, "OWNER_NOT_FOUND", "no user with that email");
    }
    if (owner.rows[0].status !== "active") {
      throw new OrgError(400, "OWNER_NOT_ACTIVE", `owner account is not active: ${owner.rows[0].status}`);
    }
    const existing = await client.query(
      `SELECT 1 FROM org_memberships WHERE user_id = $1::bigint AND status = 'active' LIMIT 1`,
      [owner.rows[0].id],
    );
    if (existing.rows.length > 0) {
      throw new OrgError(409, "OWNER_ALREADY_IN_ORG", "owner already belongs to an organization");
    }

    const org = await createOrg(
      { name: input.name, ownerUserId: owner.rows[0].id, createdBy: input.adminId, maxMembers: input.maxMembers },
      client,
    );

    await writeAdminAudit(client, {
      adminId: input.adminId,
      action: "org.create",
      target: `org:${org.id}`,
      before: null,
      after: { name: org.name, owner_user_id: owner.rows[0].id, max_members: org.max_members },
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    });
    return org;
  });
}

export interface PatchOrgInput {
  name?: string;
  status?: OrgStatus;
  maxMembers?: number;
}

export interface PatchOrgCtx {
  adminId: string | bigint;
  ip?: string | null;
  userAgent?: string | null;
}

/** 更新 org name/status/max_members + 审计(同事务)。空 patch → 返回当前行不写审计。 */
export async function patchOrg(
  orgId: string | bigint,
  patch: PatchOrgInput,
  ctx: PatchOrgCtx,
): Promise<OrgRow> {
  const touched =
    patch.name !== undefined || patch.status !== undefined || patch.maxMembers !== undefined;
  if (!touched) {
    const cur = await getOrgById(orgId);
    if (!cur) throw new OrgError(404, "NOT_FOUND", "org not found");
    return cur;
  }
  return tx(async (client: PoolClient) => {
    const before = await getOrgById(orgId, client);
    if (!before) throw new OrgError(404, "NOT_FOUND", "org not found");
    const after = await updateOrg(orgId, patch, client);

    const beforeChanged: Record<string, unknown> = {};
    const afterChanged: Record<string, unknown> = {};
    if (patch.name !== undefined) { beforeChanged.name = before.name; afterChanged.name = after.name; }
    if (patch.status !== undefined) { beforeChanged.status = before.status; afterChanged.status = after.status; }
    if (patch.maxMembers !== undefined) {
      beforeChanged.max_members = before.max_members;
      afterChanged.max_members = after.max_members;
    }
    await writeAdminAudit(client, {
      adminId: ctx.adminId,
      action: "org.patch",
      target: `org:${String(orgId)}`,
      before: beforeChanged,
      after: afterChanged,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    });
    return after;
  });
}

export interface AdjustOrgCreditsInput {
  orgId: string | bigint;
  delta: bigint;
  memo: string;
  adminId: string | bigint;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AdjustOrgCreditsResult {
  ledger_id: bigint;
  /** 调整后 orgs.credits(= org_wallet 流水 balance_after)。 */
  balance_after: bigint;
  audit_id: bigint;
}

/**
 * 平台超管手工调整 org 钱包(可正可负,0112 放开)。tx 内锁 orgs FOR UPDATE → credits += delta
 * → INSERT credit_ledger(bucket='org_wallet', org_id, user_id=操作 admin) → writeAdminAudit
 * (action='org.credits.adjust'),原子提交。
 *
 * 规则(镜像 users 的 adminAdjust,billing/ledger.ts):
 *   - delta != 0、memo 非空(审计合规)
 *   - delta < 0 且会打到负 → 拒(org 钱包不可负,等同"余额不足以扣")
 *   - 金额上限(±¥100 万)由 HTTP 层守(handleAdminAdjustOrgCredits),与 users 同 cap 处
 */
export async function adjustOrgCredits(input: AdjustOrgCreditsInput): Promise<AdjustOrgCreditsResult> {
  if (input.delta === 0n) throw new OrgError(400, "VALIDATION", "delta must be non-zero");
  if (!input.memo || input.memo.trim().length === 0) {
    throw new OrgError(400, "VALIDATION", "memo is required (non-empty)");
  }
  const orgId = String(input.orgId);
  return tx(async (client: PoolClient) => {
    const before = await client.query<{ credits: string }>(
      `SELECT credits::text AS credits FROM orgs WHERE id = $1::bigint FOR UPDATE`,
      [orgId],
    );
    if (before.rows.length === 0) throw new OrgError(404, "NOT_FOUND", "org not found");
    const balance = BigInt(before.rows[0].credits);
    const newBalance = balance + input.delta;
    if (newBalance < 0n) {
      throw new OrgError(
        400,
        "INSUFFICIENT_ORG_CREDITS",
        `adjustment would drive org credits below zero (balance=${balance}, delta=${input.delta})`,
      );
    }
    // 正向调额抬高可用额 → 清低水位预警去重戳(§17.2),允许再次触发;负调不清(可能仍低)。
    await client.query(
      input.delta > 0n
        ? `UPDATE orgs SET credits = $1, low_balance_notified_at = NULL, updated_at = NOW() WHERE id = $2::bigint`
        : `UPDATE orgs SET credits = $1, updated_at = NOW() WHERE id = $2::bigint`,
      [newBalance.toString(), orgId],
    );
    const ledgerRow = await client.query<{ id: string }>(
      `INSERT INTO credit_ledger
          (user_id, org_id, delta, balance_after, reason, bucket, ref_type, ref_id, memo)
       VALUES ($1, $2::bigint, $3, $4, 'admin_adjust', 'org_wallet', 'org', $5, $6)
       RETURNING id::text AS id`,
      [String(input.adminId), orgId, input.delta.toString(), newBalance.toString(), orgId, input.memo],
    );
    const ledgerId = BigInt(ledgerRow.rows[0].id);
    const auditId = await writeAdminAudit(client, {
      adminId: input.adminId,
      action: "org.credits.adjust",
      target: `org:${orgId}`,
      before: { credits: balance.toString() },
      after: {
        credits: newBalance.toString(),
        delta: input.delta.toString(),
        memo: input.memo,
        ledger_id: ledgerId.toString(),
      },
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    });
    return { ledger_id: ledgerId, balance_after: newBalance, audit_id: auditId };
  });
}
