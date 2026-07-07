/**
 * 企业版(P3.1)org 邀请数据层(token_hash 模式,仿 email_verifications)。
 *
 *   - createInvitation : 生成 32B token → sha256 存 hash,TTL 7d;同 org 同 email 的
 *                        pending 旧邀请先撤销(任意时刻至多一张 active 邀请)
 *   - acceptInvitation : 校验 token/未过期/未接受/受邀邮箱==当前账号邮箱/席位/单 org →
 *                        建 membership + 标记 accepted
 *   - revokeInvitation : 撤销 pending 邀请
 *   - listInvitations  : 某 org 邀请列表(派生 status:pending/accepted/revoked/expired)
 *
 * 明文 token 仅在 createInvitation 返回一次(进邀请链接/邮件),DB 只存 hash。
 */

import { randomBytes, createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { query, tx } from "../db/queries.js";
import { OrgError, type OrgRole } from "./types.js";
import { countActiveMembers } from "./memberships.js";

/** 邀请有效期:7 天。 */
export const INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60;

// ─── 席位闸(§14:只拦新进,不清存量、不拦续费降席)────────────────────

/**
 * 生效成员上限 = 有 active(未过期)订阅 → min(seats, max_members);无订阅 → max_members。
 * 纯函数;订阅席位与成员上限取较小者(闲置席位不放大可入组人数,超编不倒扣)。
 */
function seatCap(subSeats: number | null, maxMembers: number): number {
  return subSeats == null ? maxMembers : Math.min(subSeats, maxMembers);
}

/**
 * 读某 org 当前 active 且未过期(period_end>NOW())订阅的席位数;无 → null。
 * 谓词与 spend.ts / addOrgSeatsTx 一致:过期未轮转的订阅不再收紧席位闸(回退 max_members)。
 */
async function activeSubSeats(client: PoolClient, orgId: string): Promise<number | null> {
  const r = await client.query<{ seats: number }>(
    `SELECT seats FROM org_subscriptions
      WHERE org_id = $1::bigint AND status = 'active' AND period_end > NOW()`,
    [orgId],
  );
  return r.rows[0]?.seats ?? null;
}

/** 解析某 org 的生效席位上限(读 max_members + active 订阅席位)。org 不存在 → 404。 */
async function resolveSeatCap(client: PoolClient, orgId: string): Promise<number> {
  const o = await client.query<{ max_members: number }>(
    `SELECT max_members FROM orgs WHERE id = $1::bigint`,
    [orgId],
  );
  if (o.rows.length === 0) throw new OrgError(404, "NOT_FOUND", "org not found");
  return seatCap(await activeSubSeats(client, orgId), o.rows[0].max_members);
}

export type InvitationStatus = "pending" | "accepted" | "revoked" | "expired";

export interface InvitationRow {
  id: string;
  org_id: string;
  email: string;
  org_role: OrgRole;
  invited_by: string | null;
  expires_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}

export interface InvitationView extends InvitationRow {
  status: InvitationStatus;
}

export interface CreateInvitationInput {
  orgId: string | bigint;
  email: string;
  orgRole: Exclude<OrgRole, "owner">;
  invitedBy: string | bigint;
}

export interface CreateInvitationResult {
  id: string;
  /** 明文 token,只此一次返回(用于邀请链接)。 */
  rawToken: string;
  email: string;
  orgRole: OrgRole;
  expiresAt: Date;
}

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * 创建邀请。同 org 同 email 的 pending 旧邀请先撤销(同事务),再插入新行。
 * email 归一化为 trim + lowercase(与接受时比对口径一致)。
 */
export async function createInvitation(
  input: CreateInvitationInput,
): Promise<CreateInvitationResult> {
  const email = input.email.trim().toLowerCase();
  if (email.length === 0 || email.length > 320 || !email.includes("@")) {
    throw new OrgError(400, "VALIDATION", "invalid invitee email");
  }
  if (!["admin", "member"].includes(input.orgRole)) {
    throw new OrgError(400, "VALIDATION", "org_role must be admin or member");
  }
  const raw = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + INVITATION_TTL_SECONDS * 1000);

  return tx(async (client) => {
    // 席位软闸(§14 只拦新进):邀请创建时若已满员即明确拒绝,避免造出无法接受的邀请。
    // 权威闸在 acceptInvitation(接受时事务内再校验);此处仅提前给出结构化错误。
    const cap = await resolveSeatCap(client, String(input.orgId));
    const active = await countActiveMembers(String(input.orgId), client);
    if (active >= cap) {
      throw new OrgError(409, "SEATS_FULL", "organization has no available seats; add seats or raise the member cap");
    }

    // 撤销同 org 同 email 的所有 pending(未接受未撤销)邀请
    await client.query(
      `UPDATE org_invitations SET revoked_at = NOW()
        WHERE org_id = $1::bigint AND lower(email) = $2
          AND accepted_at IS NULL AND revoked_at IS NULL`,
      [String(input.orgId), email],
    );
    const r = await client.query<{ id: string }>(
      `INSERT INTO org_invitations (org_id, email, org_role, token_hash, invited_by, expires_at)
       VALUES ($1::bigint, $2, $3, $4, $5::bigint, $6::timestamptz)
       RETURNING id::text AS id`,
      [String(input.orgId), email, input.orgRole, tokenHash, String(input.invitedBy), expiresAt.toISOString()],
    );
    return { id: r.rows[0].id, rawToken: raw, email, orgRole: input.orgRole, expiresAt };
  });
}

export interface AcceptInvitationResult {
  orgId: string;
  orgRole: OrgRole;
}

/**
 * 接受邀请。校验链(全部在同一事务 + 行锁下):
 *   1. token_hash 命中且未接受未撤销(FOR UPDATE)
 *   2. 未过期(expires_at > NOW())
 *   3. 受邀邮箱 == 当前账号邮箱(lower 比对)—— 防转发链接被他人接受
 *   4. caller 无其他 active org(其 org 仍 active → ALREADY_IN_ORG;org 已停用/软删则不阻塞,
 *      并顺手挂起该 stale active 行以释放 uq_user_active_org,§3)
 *   5. 席位未满(countActiveMembers < org.max_members)
 *   6. org active
 * 通过 → INSERT membership(org_role 取自邀请,invited_by 取自邀请)+ 标记 accepted_at。
 */
export async function acceptInvitation(
  rawToken: string,
  userId: string | bigint,
): Promise<AcceptInvitationResult> {
  if (typeof rawToken !== "string" || rawToken.length === 0) {
    throw new OrgError(400, "VALIDATION", "token is required");
  }
  const tokenHash = hashToken(rawToken);

  return tx(async (client) => {
    const inv = await client.query<{
      id: string;
      org_id: string;
      email: string;
      org_role: OrgRole;
      invited_by: string | null;
      expired: boolean;
    }>(
      `SELECT id::text AS id, org_id::text AS org_id, email, org_role,
              invited_by::text AS invited_by, (expires_at <= NOW()) AS expired
         FROM org_invitations
        WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL
        FOR UPDATE`,
      [tokenHash],
    );
    if (inv.rows.length === 0) {
      throw new OrgError(404, "INVITATION_INVALID", "invitation not found, already used, or revoked");
    }
    const row = inv.rows[0];
    if (row.expired) {
      throw new OrgError(410, "INVITATION_EXPIRED", "invitation has expired");
    }

    // 当前账号邮箱(锁定用户行,避免与改邮箱并发)
    const u = await client.query<{ email: string; status: string }>(
      `SELECT email, status FROM users WHERE id = $1::bigint FOR UPDATE`,
      [String(userId)],
    );
    if (u.rows.length === 0 || u.rows[0].status !== "active") {
      throw new OrgError(403, "FORBIDDEN", "account is not active");
    }
    if (u.rows[0].email.trim().toLowerCase() !== row.email.trim().toLowerCase()) {
      throw new OrgError(403, "EMAIL_MISMATCH", "invitation was issued to a different email address");
    }

    // caller 无其他【active org 的】active membership(V1 单 org)。§3:JOIN orgs 过滤
    // ——uq_user_active_org 保证至多一行 active membership;若该行的 org 已非 active
    // (suspended/deleting/deleted,照 resolveOrgBillingContext 的 o.status='active' 口径),
    // 不算"已属 org",否则 org 软删后成员被 uq_user_active_org 永久锁死无法转投新 org。
    // 并发同一用户的 accept 已由上方 `users FOR UPDATE` 串行化,故此处无需再锁。
    const existing = await client.query<{ org_status: string }>(
      `SELECT o.status AS org_status
         FROM org_memberships m
         JOIN orgs o ON o.id = m.org_id
        WHERE m.user_id = $1::bigint AND m.status = 'active'`,
      [String(userId)],
    );
    if (existing.rows.length > 0) {
      if (existing.rows[0].org_status === "active") {
        throw new OrgError(409, "ALREADY_IN_ORG", "you already belong to an organization");
      }
      // stale active membership 指向已非 active 的 org:先挂起解锁 uq_user_active_org,
      // 否则下面 INSERT 新 membership 会撞该部分唯一索引。这也是 org.updateOrg 未级联到的
      // suspended/deleting 态的接受侧兜底(deleted 态 updateOrg 已在删除时挂起)。
      await client.query(
        `UPDATE org_memberships SET status = 'suspended'
          WHERE user_id = $1::bigint AND status = 'active'`,
        [String(userId)],
      );
    }

    // org 必须 active + 席位未满(锁 org 行串行化并发接受)
    const org = await client.query<{ status: string; max_members: number }>(
      `SELECT status, max_members FROM orgs WHERE id = $1::bigint FOR UPDATE`,
      [row.org_id],
    );
    if (org.rows.length === 0 || org.rows[0].status !== "active") {
      throw new OrgError(409, "ORG_UNAVAILABLE", "organization is not accepting members");
    }
    // 席位闸(§14 权威点,只拦新进):生效上限 = 有 active(未过期)订阅 ? min(seats, max_members) : max_members。
    // 无订阅(钱包型 / 超管代建)回退 max_members;存量超编不受影响(只在 active < cap 时才放新人)。
    const cap = seatCap(await activeSubSeats(client, row.org_id), org.rows[0].max_members);
    const active = await countActiveMembers(row.org_id, client);
    if (active >= cap) {
      throw new OrgError(409, "SEATS_FULL", "organization has no available seats; ask an owner to add seats");
    }

    await client.query(
      `INSERT INTO org_memberships (org_id, user_id, org_role, status, billing_enabled, invited_by)
       VALUES ($1::bigint, $2::bigint, $3, 'active', TRUE, $4::bigint)`,
      [row.org_id, String(userId), row.org_role, row.invited_by],
    );
    await client.query(
      `UPDATE org_invitations SET accepted_at = NOW() WHERE id = $1::bigint`,
      [row.id],
    );
    return { orgId: row.org_id, orgRole: row.org_role };
  });
}

/** 撤销 pending 邀请。目标不属于该 org / 已终结 → 404。 */
export async function revokeInvitation(
  orgId: string | bigint,
  invitationId: string | bigint,
): Promise<void> {
  const r = await query(
    `UPDATE org_invitations SET revoked_at = NOW()
      WHERE id = $1::bigint AND org_id = $2::bigint
        AND accepted_at IS NULL AND revoked_at IS NULL`,
    [String(invitationId), String(orgId)],
  );
  if (r.rowCount === 0) {
    throw new OrgError(404, "NOT_FOUND", "no pending invitation to revoke");
  }
}

/** 列出某 org 的邀请,派生 status。默认按创建时间倒序。 */
export async function listInvitations(orgId: string | bigint): Promise<InvitationView[]> {
  const r = await query<InvitationRow>(
    `SELECT id::text AS id, org_id::text AS org_id, email, org_role,
            invited_by::text AS invited_by, expires_at, accepted_at, revoked_at, created_at
       FROM org_invitations
      WHERE org_id = $1::bigint
      ORDER BY created_at DESC`,
    [String(orgId)],
  );
  const now = Date.now();
  return r.rows.map((row) => {
    let status: InvitationStatus;
    if (row.accepted_at) status = "accepted";
    else if (row.revoked_at) status = "revoked";
    else if (new Date(row.expires_at).getTime() <= now) status = "expired";
    else status = "pending";
    return { ...row, status };
  });
}
