/**
 * 企业版(P3.1)org 主表数据层。
 *
 * 职责:orgs 行的 CRUD 原语 + 单 org 概要聚合。
 *   - createOrg    : 在调用方事务内原子建 org + owner membership(owner 唯一权威)
 *   - getOrgById   : 单行点查
 *   - getOrgSummary: GET /api/org 概要(org + 活跃成员数)
 *   - updateOrg    : 受控字段更新(name/status/max_members)
 *
 * 跨 org 的平台超管列表(listOrgs)不在这里 —— 那是 admin 域,收在 admin/orgs.ts,
 * 避免"org 成员操作"与"平台跨 org 运维"两套语义混在一个文件。
 *
 * 调额(adjustOrgCredits)不在本批次实现:org 钱包变动必须带 ledger 流水,
 * ledger.org_id 列在 0112(批次 B)才落地。见 admin/orgs.ts 的 501 占位。
 */

import type { PoolClient } from "pg";
import { query, type QueryRunner } from "../db/queries.js";
import { getPool } from "../db/index.js";
import { OrgError, type OrgStatus } from "./types.js";

export interface OrgRow {
  id: string;
  name: string;
  status: OrgStatus;
  credits: string; // BIGINT cents → ::text
  max_members: number;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface OrgSummary extends OrgRow {
  member_count: number;
}

const ORG_COLUMNS = `id::text AS id, name, status, credits::text AS credits,
  max_members, created_by::text AS created_by, created_at, updated_at`;

export interface CreateOrgInput {
  name: string;
  /** 该 org 的 owner(写入 owner membership)。 */
  ownerUserId: string | bigint;
  /** 审计:创建操作者(admin id)。orgs.created_by,仅审计。 */
  createdBy?: string | bigint | null;
  /** 席位上限,默认 100。 */
  maxMembers?: number;
}

/**
 * 原子建 org + owner membership。**必须在调用方事务内执行**(传入 client),
 * 以便与 admin_audit 等写操作同一事务提交/回滚。
 *
 * owner membership 直接写 org_role='owner';uq_org_owner partial unique 保证唯一。
 * 若 ownerUserId 已在别的 active org(uq_user_active_org 冲突)→ 抛 23505,
 * 调用方(createOrgByEmail)在事务前已校验,这里作为最后一道结构防线。
 */
export async function createOrg(input: CreateOrgInput, client: PoolClient): Promise<OrgRow> {
  const name = input.name.trim();
  if (name.length === 0 || name.length > 200) {
    throw new OrgError(400, "VALIDATION", "org name must be 1..200 chars");
  }
  const maxMembers = input.maxMembers ?? 100;
  if (!Number.isInteger(maxMembers) || maxMembers <= 0) {
    throw new OrgError(400, "VALIDATION", "max_members must be a positive integer");
  }

  const orgRes = await client.query<OrgRow>(
    `INSERT INTO orgs (name, max_members, created_by)
     VALUES ($1, $2, $3::bigint)
     RETURNING ${ORG_COLUMNS}`,
    [name, maxMembers, input.createdBy != null ? String(input.createdBy) : null],
  );
  const org = orgRes.rows[0];

  await client.query(
    `INSERT INTO org_memberships (org_id, user_id, org_role, status, billing_enabled)
     VALUES ($1::bigint, $2::bigint, 'owner', 'active', TRUE)`,
    [org.id, String(input.ownerUserId)],
  );

  return org;
}

export async function getOrgById(
  orgId: string | bigint,
  runner: QueryRunner = getPool() as unknown as QueryRunner,
): Promise<OrgRow | null> {
  const r = await query<OrgRow>(
    `SELECT ${ORG_COLUMNS} FROM orgs WHERE id = $1::bigint`,
    [String(orgId)],
    runner,
  );
  return r.rows[0] ?? null;
}

/** GET /api/org 概要:org 行 + 活跃成员数。org 不存在 → null。 */
export async function getOrgSummary(orgId: string | bigint): Promise<OrgSummary | null> {
  const r = await query<OrgRow & { member_count: string }>(
    `SELECT ${ORG_COLUMNS},
            (SELECT COUNT(*) FROM org_memberships m
              WHERE m.org_id = o.id AND m.status = 'active')::text AS member_count
       FROM orgs o
      WHERE o.id = $1::bigint`,
    [String(orgId)],
  );
  const row = r.rows[0];
  if (!row) return null;
  const { member_count, ...org } = row;
  return { ...org, member_count: Number(member_count) };
}

export interface UpdateOrgPatch {
  name?: string;
  status?: OrgStatus;
  maxMembers?: number;
}

/**
 * 受控更新 org 的 name/status/max_members。**在调用方事务内执行**(与 audit 同事务)。
 * 空 patch → 返回当前行(FOR UPDATE 锁定)。降 max_members 低于当前活跃成员数 → 400。
 */
export async function updateOrg(
  orgId: string | bigint,
  patch: UpdateOrgPatch,
  client: PoolClient,
): Promise<OrgRow> {
  const cur = await client.query<OrgRow>(
    `SELECT ${ORG_COLUMNS} FROM orgs WHERE id = $1::bigint FOR UPDATE`,
    [String(orgId)],
  );
  if (cur.rows.length === 0) throw new OrgError(404, "NOT_FOUND", "org not found");

  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (col: string, val: unknown): void => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };

  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (name.length === 0 || name.length > 200) {
      throw new OrgError(400, "VALIDATION", "org name must be 1..200 chars");
    }
    push("name", name);
  }
  if (patch.status !== undefined) {
    if (!["active", "suspended", "deleting", "deleted"].includes(patch.status)) {
      throw new OrgError(400, "VALIDATION", "invalid org status");
    }
    push("status", patch.status);
  }
  if (patch.maxMembers !== undefined) {
    if (!Number.isInteger(patch.maxMembers) || patch.maxMembers <= 0) {
      throw new OrgError(400, "VALIDATION", "max_members must be a positive integer");
    }
    const activeCount = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM org_memberships WHERE org_id = $1::bigint AND status = 'active'`,
      [String(orgId)],
    );
    if (patch.maxMembers < Number(activeCount.rows[0].n)) {
      throw new OrgError(
        400,
        "SEAT_BELOW_ACTIVE",
        `max_members (${patch.maxMembers}) below current active member count (${activeCount.rows[0].n})`,
      );
    }
    push("max_members", patch.maxMembers);
  }

  if (sets.length === 0) return cur.rows[0];

  sets.push("updated_at = NOW()");
  params.push(String(orgId));
  const r = await client.query<OrgRow>(
    `UPDATE orgs SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING ${ORG_COLUMNS}`,
    params,
  );
  return r.rows[0];
}
