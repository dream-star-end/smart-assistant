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

  const r = await query<OrgRow & { member_count: string }>(
    `SELECT o.id::text AS id, o.name, o.status, o.credits::text AS credits, o.max_members,
            o.created_by::text AS created_by, o.created_at, o.updated_at,
            (SELECT COUNT(*) FROM org_memberships m
              WHERE m.org_id = o.id AND m.status = 'active')::text AS member_count
       FROM orgs o
      WHERE ($1::text IS NULL OR o.name ILIKE '%' || $1 || '%')
        AND ($2::text IS NULL OR o.status = $2)
        AND ($3::bigint IS NULL OR o.id < $3::bigint)
      ORDER BY o.id DESC
      LIMIT $4`,
    [q, status, cursor, limit + 1],
  );
  const hasMore = r.rows.length > limit;
  const page = hasMore ? r.rows.slice(0, limit) : r.rows;
  const rows: OrgWithStatsRow[] = page.map(({ member_count, ...org }) => ({
    ...org,
    member_count: Number(member_count),
  }));
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

/**
 * **批次 A 占位 —— 不放开无流水的资金变动面**(方案 §5 决策)。
 *
 * org 钱包变动必须带 ledger 流水(credit_ledger.org_id),该列在 0112(批次 B)才落地。
 * 在此之前调 org 余额只动 orgs.credits + admin_audit 会留下"资金变了但无流水"的审计缺口。
 * 宁可晚开功能,不留无流水资金变动面。
 *
 * 批次 B 打通 0112 后放开:tx 内 SELECT credits FROM orgs FOR UPDATE → UPDATE credits →
 * INSERT credit_ledger(org_id, bucket='org_wallet', ...) → writeAdminAudit(action='org.credits.adjust')。
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function adjustOrgCredits(_input: AdjustOrgCreditsInput): Promise<never> {
  throw new OrgError(
    501,
    "NOT_IMPLEMENTED",
    "org credit adjustment requires the billing batch (0112 org ledger); not enabled yet",
  );
}
