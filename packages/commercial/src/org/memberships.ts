/**
 * 企业版(P3.1)org 成员归属数据层。
 *
 *   - getActiveMembership : 用户当前 active membership(V1 单 org,至多一行)
 *   - getMembership       : 某 org 内某用户的成员行(任意状态)
 *   - listMembers         : 某 org 全体成员 JOIN users(email/display_name)
 *   - countActiveMembers  : 席位计数
 *   - updateMember        : org_role / billing_enabled / status 变更
 *   - removeMember        : 移除成员(结构防线:拒绝移除 owner)
 *   - transferOwner       : owner 转让(先降后升,owner partial unique 下安全)
 *
 * 授权矩阵(谁能操作谁)由 HTTP 层用 OrgAuthContext 判定;本层做结构不变量兜底
 * (如"不能移除 owner 行"),防绕过 HTTP 直接调用数据层破坏 owner 唯一性。
 */

import type { PoolClient } from "pg";
import { query, tx, type QueryRunner } from "../db/queries.js";
import { getPool } from "../db/index.js";
import { OrgError, type OrgRole, type MembershipStatus } from "./types.js";

export interface MembershipRow {
  org_id: string;
  user_id: string;
  org_role: OrgRole;
  status: MembershipStatus;
  billing_enabled: boolean;
  invited_by: string | null;
  joined_at: Date;
}

export interface MemberView extends MembershipRow {
  email: string;
  display_name: string | null;
  user_status: string; // users.status(平台账号状态,便于 admin 面识别被封成员)
}

const MEMBERSHIP_COLUMNS = `org_id::text AS org_id, user_id::text AS user_id, org_role,
  status, billing_enabled, invited_by::text AS invited_by, joined_at`;

/** 用户当前 active membership(uq_user_active_org 保证至多一行)。无 → null。 */
export async function getActiveMembership(
  userId: string | bigint,
  runner: QueryRunner = getPool() as unknown as QueryRunner,
): Promise<MembershipRow | null> {
  const r = await query<MembershipRow>(
    `SELECT ${MEMBERSHIP_COLUMNS} FROM org_memberships
      WHERE user_id = $1::bigint AND status = 'active' LIMIT 1`,
    [String(userId)],
    runner,
  );
  return r.rows[0] ?? null;
}

/** 某 org 内某用户的成员行(任意状态)。无 → null。 */
export async function getMembership(
  orgId: string | bigint,
  userId: string | bigint,
  runner: QueryRunner = getPool() as unknown as QueryRunner,
): Promise<MembershipRow | null> {
  const r = await query<MembershipRow>(
    `SELECT ${MEMBERSHIP_COLUMNS} FROM org_memberships
      WHERE org_id = $1::bigint AND user_id = $2::bigint`,
    [String(orgId), String(userId)],
    runner,
  );
  return r.rows[0] ?? null;
}

/** 席位计数:某 org 的 active 成员数。 */
export async function countActiveMembers(
  orgId: string | bigint,
  runner: QueryRunner = getPool() as unknown as QueryRunner,
): Promise<number> {
  const r = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM org_memberships WHERE org_id = $1::bigint AND status = 'active'`,
    [String(orgId)],
    runner,
  );
  return Number(r.rows[0].n);
}

/** 列出某 org 全体成员(JOIN users 出 email/display_name)。owner→admin→member,再按加入时间。 */
export async function listMembers(orgId: string | bigint): Promise<MemberView[]> {
  const r = await query<MemberView>(
    `SELECT m.org_id::text AS org_id, m.user_id::text AS user_id, m.org_role,
            m.status, m.billing_enabled, m.invited_by::text AS invited_by, m.joined_at,
            u.email, u.display_name, u.status AS user_status
       FROM org_memberships m
       JOIN users u ON u.id = m.user_id
      WHERE m.org_id = $1::bigint
      ORDER BY CASE m.org_role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
               m.joined_at ASC`,
    [String(orgId)],
  );
  return r.rows;
}

export interface UpdateMemberPatch {
  orgRole?: OrgRole;
  billingEnabled?: boolean;
  status?: MembershipStatus;
}

/**
 * 更新成员的 org_role / billing_enabled / status。
 *
 * 结构不变量兜底(不替代 HTTP 层授权矩阵):
 *   - 目标是 owner 行 → 一律拒绝(owner 变更只能走 transferOwner)。
 *   - org_role 不允许被设为 'owner'(升 owner 只能 transfer);只接受 admin/member。
 *
 * 在调用方事务内执行(与 audit 同事务)。目标不存在 → 404。
 */
export async function updateMember(
  orgId: string | bigint,
  userId: string | bigint,
  patch: UpdateMemberPatch,
  client: PoolClient,
): Promise<MembershipRow> {
  const cur = await client.query<MembershipRow>(
    `SELECT ${MEMBERSHIP_COLUMNS} FROM org_memberships
      WHERE org_id = $1::bigint AND user_id = $2::bigint FOR UPDATE`,
    [String(orgId), String(userId)],
  );
  if (cur.rows.length === 0) throw new OrgError(404, "NOT_FOUND", "member not found");
  if (cur.rows[0].org_role === "owner") {
    throw new OrgError(403, "OWNER_IMMUTABLE", "the organization owner row cannot be modified here");
  }
  if (patch.orgRole !== undefined && patch.orgRole === "owner") {
    throw new OrgError(400, "VALIDATION", "cannot promote to owner via member update; use transfer-owner");
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (col: string, val: unknown): void => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.orgRole !== undefined) {
    if (!["admin", "member"].includes(patch.orgRole)) {
      throw new OrgError(400, "VALIDATION", "org_role must be admin or member");
    }
    push("org_role", patch.orgRole);
  }
  if (patch.billingEnabled !== undefined) push("billing_enabled", patch.billingEnabled);
  if (patch.status !== undefined) {
    if (!["active", "suspended"].includes(patch.status)) {
      throw new OrgError(400, "VALIDATION", "member status must be active or suspended");
    }
    push("status", patch.status);
  }
  if (sets.length === 0) return cur.rows[0];

  params.push(String(orgId), String(userId));
  const r = await client.query<MembershipRow>(
    `UPDATE org_memberships SET ${sets.join(", ")}
      WHERE org_id = $${params.length - 1} AND user_id = $${params.length}
      RETURNING ${MEMBERSHIP_COLUMNS}`,
    params,
  );
  return r.rows[0];
}

/**
 * 移除成员。结构防线:拒绝移除 owner(owner 必须先 transfer-owner)。
 * 在调用方事务内执行。返回被移除行(供审计/日志)。
 */
export async function removeMember(
  orgId: string | bigint,
  userId: string | bigint,
  client: PoolClient,
): Promise<MembershipRow> {
  const cur = await client.query<MembershipRow>(
    `SELECT ${MEMBERSHIP_COLUMNS} FROM org_memberships
      WHERE org_id = $1::bigint AND user_id = $2::bigint FOR UPDATE`,
    [String(orgId), String(userId)],
  );
  if (cur.rows.length === 0) throw new OrgError(404, "NOT_FOUND", "member not found");
  if (cur.rows[0].org_role === "owner") {
    throw new OrgError(403, "OWNER_IMMUTABLE", "cannot remove the organization owner; transfer ownership first");
  }
  await client.query(
    `DELETE FROM org_memberships WHERE org_id = $1::bigint AND user_id = $2::bigint`,
    [String(orgId), String(userId)],
  );
  return cur.rows[0];
}

/**
 * owner 转让:currentOwnerId → newOwnerId。两者必须是同 org 的活跃成员。
 *
 * owner partial unique(uq_org_owner)下的安全顺序 = 先把现 owner 降为 admin,
 * 再把新 owner 升为 owner。两条独立语句之间瞬时"零 owner"合法(partial unique
 * 不禁止零行),不会触发唯一冲突。自带事务。
 */
export async function transferOwner(
  orgId: string | bigint,
  currentOwnerId: string | bigint,
  newOwnerId: string | bigint,
): Promise<void> {
  if (String(currentOwnerId) === String(newOwnerId)) {
    throw new OrgError(400, "VALIDATION", "new owner must differ from current owner");
  }
  await tx(async (client) => {
    const cur = await client.query<{ org_role: OrgRole }>(
      `SELECT org_role FROM org_memberships
        WHERE org_id = $1::bigint AND user_id = $2::bigint FOR UPDATE`,
      [String(orgId), String(currentOwnerId)],
    );
    if (cur.rows.length === 0 || cur.rows[0].org_role !== "owner") {
      throw new OrgError(403, "FORBIDDEN", "caller is not the organization owner");
    }
    const next = await client.query<{ status: MembershipStatus }>(
      `SELECT status FROM org_memberships
        WHERE org_id = $1::bigint AND user_id = $2::bigint FOR UPDATE`,
      [String(orgId), String(newOwnerId)],
    );
    if (next.rows.length === 0) {
      throw new OrgError(404, "NOT_FOUND", "new owner is not a member of this org");
    }
    if (next.rows[0].status !== "active") {
      throw new OrgError(400, "MEMBER_NOT_ACTIVE", "new owner must be an active member");
    }
    // 先降后升:避免 uq_org_owner 唯一冲突(两语句间瞬时零 owner 合法)。
    await client.query(
      `UPDATE org_memberships SET org_role = 'admin'
        WHERE org_id = $1::bigint AND user_id = $2::bigint`,
      [String(orgId), String(currentOwnerId)],
    );
    await client.query(
      `UPDATE org_memberships SET org_role = 'owner'
        WHERE org_id = $1::bigint AND user_id = $2::bigint`,
      [String(orgId), String(newOwnerId)],
    );
  });
}
