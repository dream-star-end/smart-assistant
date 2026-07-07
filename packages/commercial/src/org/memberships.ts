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
import { mapOrgMonthSpendByMember } from "./orgBilling.js";
import { OrgError, type OrgRole, type MembershipStatus } from "./types.js";

export interface MembershipRow {
  org_id: string;
  user_id: string;
  org_role: OrgRole;
  status: MembershipStatus;
  billing_enabled: boolean;
  /** §17.3 财务委派伪角色。授予/回收 owner-only(updateMember 数据层判)。 */
  billing_delegate: boolean;
  /** §17.4 成员月度 org 预算(分/积分);null=不限。 */
  monthly_org_budget: bigint | null;
  invited_by: string | null;
  joined_at: Date;
}

export interface MemberView extends MembershipRow {
  email: string;
  display_name: string | null;
  user_status: string; // users.status(平台账号状态,便于 admin 面识别被封成员)
  /** §17.4 本自然月(Asia/Shanghai)该成员从 org 两桶花掉的额度(分/积分)。 */
  month_org_spent: bigint;
}

const MEMBERSHIP_COLUMNS = `org_id::text AS org_id, user_id::text AS user_id, org_role,
  status, billing_enabled, billing_delegate,
  monthly_org_budget::text AS monthly_org_budget,
  invited_by::text AS invited_by, joined_at`;

/** DB 原始行(monthly_org_budget 走 ::text,大数不失真;JS 侧再转 bigint)。 */
type RawMembershipRow = Omit<MembershipRow, "monthly_org_budget"> & {
  monthly_org_budget: string | null;
};

/** DB 行 → MembershipRow(monthly_org_budget ::text → bigint | null)。 */
function toMembershipRow(r: RawMembershipRow): MembershipRow {
  return {
    ...r,
    monthly_org_budget: r.monthly_org_budget === null ? null : BigInt(r.monthly_org_budget),
  };
}

/** 用户当前 active membership(uq_user_active_org 保证至多一行)。无 → null。 */
export async function getActiveMembership(
  userId: string | bigint,
  runner: QueryRunner = getPool() as unknown as QueryRunner,
): Promise<MembershipRow | null> {
  const r = await query<RawMembershipRow>(
    `SELECT ${MEMBERSHIP_COLUMNS} FROM org_memberships
      WHERE user_id = $1::bigint AND status = 'active' LIMIT 1`,
    [String(userId)],
    runner,
  );
  return r.rows[0] ? toMembershipRow(r.rows[0]) : null;
}

/** 某 org 内某用户的成员行(任意状态)。无 → null。 */
export async function getMembership(
  orgId: string | bigint,
  userId: string | bigint,
  runner: QueryRunner = getPool() as unknown as QueryRunner,
): Promise<MembershipRow | null> {
  const r = await query<RawMembershipRow>(
    `SELECT ${MEMBERSHIP_COLUMNS} FROM org_memberships
      WHERE org_id = $1::bigint AND user_id = $2::bigint`,
    [String(orgId), String(userId)],
    runner,
  );
  return r.rows[0] ? toMembershipRow(r.rows[0]) : null;
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

/**
 * 列出某 org 全体成员(JOIN users 出 email/display_name)。owner→admin→member,再按加入时间。
 *
 * month_org_spent(§17.4)不在成员行 JOIN 内聚合,而是走 orgBilling.mapOrgMonthSpendByMember
 * (与 spendTwoBucket 预算钳制**同一 SUM 口径**,单一权威防漂移)后在 JS 侧并入 —— 两处一个口径。
 */
export async function listMembers(orgId: string | bigint): Promise<MemberView[]> {
  const [r, spentByMember] = await Promise.all([
    query<Omit<MemberView, "monthly_org_budget" | "month_org_spent"> & { monthly_org_budget: string | null }>(
      `SELECT m.org_id::text AS org_id, m.user_id::text AS user_id, m.org_role,
              m.status, m.billing_enabled, m.billing_delegate,
              m.monthly_org_budget::text AS monthly_org_budget,
              m.invited_by::text AS invited_by, m.joined_at,
              u.email, u.display_name, u.status AS user_status
         FROM org_memberships m
         JOIN users u ON u.id = m.user_id
        WHERE m.org_id = $1::bigint
        ORDER BY CASE m.org_role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
                 m.joined_at ASC`,
      [String(orgId)],
    ),
    mapOrgMonthSpendByMember(orgId),
  ]);
  return r.rows.map((row) => ({
    ...row,
    monthly_org_budget: row.monthly_org_budget === null ? null : BigInt(row.monthly_org_budget),
    month_org_spent: spentByMember.get(row.user_id) ?? 0n,
  }));
}

export interface UpdateMemberPatch {
  orgRole?: OrgRole;
  billingEnabled?: boolean;
  status?: MembershipStatus;
  /** §17.3 财务委派:授予/回收 **owner-only**(数据层事务内判,同 org_role 纪律)。 */
  billingDelegate?: boolean;
  /**
   * §17.4 成员月度 org 预算(admin 可改,支出策略非动钱)。
   *   - bigint > 0 → 设上限;null → 清除(不限);undefined → 不改。
   */
  monthlyOrgBudget?: bigint | null;
}

/**
 * 授权矩阵(单一权威,在锁内行上判定):caller 能否管理(改/踢)目标成员。
 * owner 管 admin+member;admin 只管 member;owner 行不可被管理(只能 transfer-owner)。
 */
export function assertCanManage(callerRole: OrgRole, targetRole: OrgRole): void {
  if (targetRole === "owner") {
    throw new OrgError(403, "OWNER_IMMUTABLE", "cannot manage the organization owner");
  }
  if (callerRole === "owner") return; // owner 管 admin + member
  if (callerRole === "admin" && targetRole === "member") return; // admin 只管 member
  throw new OrgError(403, "FORBIDDEN", "insufficient role to manage this member");
}

/** 成员管理操作的执行者(授权矩阵在事务内按 FOR UPDATE 后的目标行判定,消 TOCTOU)。 */
export interface MemberActor {
  role: OrgRole;
  userId: string;
}

/**
 * 更新成员的 org_role / billing_enabled / status / billing_delegate / monthly_org_budget。
 *
 * 授权矩阵在**事务内、FOR UPDATE 之后**按目标行最新角色判定(Codex 审计 P1:
 * 若只在 HTTP 层事前判定,目标在窗口内被 owner 升为 admin 后,admin 仍可改/踢它):
 *   - assertCanManage(actor.role, 目标当前角色);
 *   - 改 org_role 仅 owner;
 *   - **改 billing_delegate 仅 owner**(§17.3 授予/回收 owner-only,与 org_role 同纪律);
 *   - monthly_org_budget:admin 可改(支出策略,已由 assertCanManage 门控);
 *   - 目标是 owner 行 → 一律拒绝(owner 变更只能走 transferOwner);
 *   - org_role 不允许被设为 'owner'(升 owner 只能 transfer)。
 *
 * 在调用方事务内执行(与 audit 同事务)。目标不存在 → 404。
 */
export async function updateMember(
  orgId: string | bigint,
  userId: string | bigint,
  patch: UpdateMemberPatch,
  client: PoolClient,
  actor: MemberActor,
): Promise<MembershipRow> {
  const cur = await client.query<RawMembershipRow>(
    `SELECT ${MEMBERSHIP_COLUMNS} FROM org_memberships
      WHERE org_id = $1::bigint AND user_id = $2::bigint FOR UPDATE`,
    [String(orgId), String(userId)],
  );
  if (cur.rows.length === 0) throw new OrgError(404, "NOT_FOUND", "member not found");
  if (cur.rows[0].org_role === "owner") {
    throw new OrgError(403, "OWNER_IMMUTABLE", "the organization owner row cannot be modified here");
  }
  assertCanManage(actor.role, cur.rows[0].org_role);
  if (patch.orgRole !== undefined && actor.role !== "owner") {
    throw new OrgError(403, "FORBIDDEN", "only the owner can change member roles");
  }
  if (patch.orgRole !== undefined && patch.orgRole === "owner") {
    throw new OrgError(400, "VALIDATION", "cannot promote to owner via member update; use transfer-owner");
  }
  // 财务委派授予/回收 owner-only(权威判定在数据层事务内,同 org_role 纪律)。
  if (patch.billingDelegate !== undefined && actor.role !== "owner") {
    throw new OrgError(403, "FORBIDDEN", "only the owner can grant or revoke billing delegation");
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
  if (patch.billingDelegate !== undefined) push("billing_delegate", patch.billingDelegate);
  if (patch.monthlyOrgBudget !== undefined) {
    if (patch.monthlyOrgBudget !== null && patch.monthlyOrgBudget <= 0n) {
      throw new OrgError(400, "VALIDATION", "monthly_org_budget must be a positive integer or null");
    }
    // bigint → 字符串参数(pg 大数不失真);null 直传清除限额。
    push("monthly_org_budget", patch.monthlyOrgBudget === null ? null : patch.monthlyOrgBudget.toString());
  }
  if (patch.status !== undefined) {
    if (!["active", "suspended"].includes(patch.status)) {
      throw new OrgError(400, "VALIDATION", "member status must be active or suspended");
    }
    push("status", patch.status);
  }
  if (sets.length === 0) return toMembershipRow(cur.rows[0]);

  params.push(String(orgId), String(userId));
  const r = await client.query<RawMembershipRow>(
    `UPDATE org_memberships SET ${sets.join(", ")}
      WHERE org_id = $${params.length - 1} AND user_id = $${params.length}
      RETURNING ${MEMBERSHIP_COLUMNS}`,
    params,
  );
  return toMembershipRow(r.rows[0]);
}

/**
 * 移除成员。授权矩阵在事务内 FOR UPDATE 后判定(同 updateMember,消 TOCTOU);
 * 自离(actor.userId == 目标)豁免矩阵(admin/member 都可自行退出,owner 除外)。
 * 结构防线:拒绝移除 owner(owner 必须先 transfer-owner)。
 * 在调用方事务内执行。返回被移除行(供审计/日志)。
 */
export async function removeMember(
  orgId: string | bigint,
  userId: string | bigint,
  client: PoolClient,
  actor: MemberActor,
): Promise<MembershipRow> {
  const cur = await client.query<RawMembershipRow>(
    `SELECT ${MEMBERSHIP_COLUMNS} FROM org_memberships
      WHERE org_id = $1::bigint AND user_id = $2::bigint FOR UPDATE`,
    [String(orgId), String(userId)],
  );
  if (cur.rows.length === 0) throw new OrgError(404, "NOT_FOUND", "member not found");
  if (actor.userId !== String(userId)) {
    assertCanManage(actor.role, cur.rows[0].org_role);
  }
  if (cur.rows[0].org_role === "owner") {
    throw new OrgError(403, "OWNER_IMMUTABLE", "cannot remove the organization owner; transfer ownership first");
  }
  await client.query(
    `DELETE FROM org_memberships WHERE org_id = $1::bigint AND user_id = $2::bigint`,
    [String(orgId), String(userId)],
  );
  return toMembershipRow(cur.rows[0]);
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
