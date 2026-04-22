/**
 * T-60 — 超管用户管理 DB 层。
 *
 * 仅管"用户元信息修改";积分变更走 billing/ledger.adminAdjust(它已经自己在 tx
 * 内写 admin_audit)。
 *
 * ### 允许改哪些字段
 * - `status`  → active / banned / deleting / deleted(match 0001 CHECK)
 * - `role`    → user / admin
 * - `email_verified` → boolean
 *
 * 其它字段(email/password_hash/credits/display_name/avatar_url)**不在超管 patch 范围**:
 *   - email/password 改起来涉及隐私和认证流程,走用户自助
 *   - credits 走专门的 /api/admin/users/:id/credits
 *   - display_name/avatar_url 不需要超管干预
 *
 * ### 为什么 patch 要进 tx
 * 两件事必须原子:UPDATE users + INSERT admin_audit。否则"改了但审计丢失"就是
 * 合规红线事故。不走 tx 就永远不写 audit。
 */

import type { PoolClient } from "pg";
import { query, tx } from "../db/queries.js";
import { writeAdminAudit } from "./audit.js";
import { safeEnqueueAlert } from "./alertOutbox.js";
import { EVENTS } from "./alertEvents.js";

export const USER_STATUSES = ["active", "banned", "deleting", "deleted"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];
export const USER_ROLES = ["user", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export interface AdminUserRowView {
  id: string;
  email: string;
  email_verified: boolean;
  display_name: string | null;
  avatar_url: string | null;
  role: UserRole;
  credits: string;
  status: UserStatus;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const USER_COLUMNS = `
  id::text        AS id,
  email,
  email_verified,
  display_name,
  avatar_url,
  role,
  credits::text   AS credits,
  status,
  deleted_at,
  created_at,
  updated_at
`;

// ─── 列表 ──────────────────────────────────────────────────────────

export interface ListUsersInput {
  /** 可选:ILIKE 匹配 email(添加 `%` 前后)。 */
  q?: string;
  /** 可选:单值或数组。 */
  status?: UserStatus | UserStatus[];
  /** 默认 50,上限 200 */
  limit?: number;
  /** offset 分页(用户表相对小,OFFSET 可接受) */
  offset?: number;
}

export interface ListUsersResult {
  rows: AdminUserRowView[];
  /** 调用者若 rows.length === limit 可继续翻页。此处不强制返 total(COUNT(*) 昂贵)。 */
}

/** 允许的 status 值白名单,避免任意字符串被发进 SQL。 */
function assertStatus(s: string): asserts s is UserStatus {
  if (!(USER_STATUSES as readonly string[]).includes(s)) {
    throw new RangeError("invalid_status");
  }
}

export async function listUsers(input: ListUsersInput = {}): Promise<ListUsersResult> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (input.q !== undefined && input.q !== "") {
    if (input.q.length > 120) throw new RangeError("invalid_q");
    // 纯数字:按 id 精确匹配(id 是 BIGSERIAL,常见场景"我想搜 #123")
    const trimmed = input.q.trim();
    if (/^[1-9][0-9]{0,19}$/.test(trimmed)) {
      params.push(trimmed);
      where.push(`id = $${params.length}::bigint`);
    } else {
      // 其余按 email / display_name 做 ILIKE(转义 backslash/%/_ 以防 LIKE 注入)
      params.push("%" + trimmed.replace(/[\\%_]/g, "\\$&") + "%");
      where.push(
        `(email ILIKE $${params.length} OR display_name ILIKE $${params.length})`,
      );
    }
  }
  if (input.status !== undefined) {
    const arr = Array.isArray(input.status) ? input.status : [input.status];
    for (const s of arr) assertStatus(s);
    params.push(arr);
    where.push(`status = ANY($${params.length}::text[])`);
  }
  let limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit <= 0) limit = 50;
  if (limit > 200) limit = 200;
  let offset = input.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) offset = 0;

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  params.push(limit);
  const limitIdx = params.length;
  params.push(offset);
  const offsetIdx = params.length;
  const r = await query<AdminUserRowView>(
    `SELECT ${USER_COLUMNS} FROM users ${whereClause}
     ORDER BY id DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params,
  );
  return { rows: r.rows };
}

// ─── 单条 ──────────────────────────────────────────────────────────

export async function getUser(id: bigint | string): Promise<AdminUserRowView | null> {
  if (!/^[1-9][0-9]{0,19}$/.test(String(id))) throw new RangeError("invalid_user_id");
  const r = await query<AdminUserRowView>(
    `SELECT ${USER_COLUMNS} FROM users WHERE id = $1`,
    [String(id)],
  );
  return r.rows[0] ?? null;
}

// ─── Patch ─────────────────────────────────────────────────────────

export interface PatchUserInput {
  status?: UserStatus;
  role?: UserRole;
  email_verified?: boolean;
}

export interface PatchUserAdminCtx {
  adminId: bigint | number | string;
  ip?: string | null;
  userAgent?: string | null;
}

export class UserNotFoundError extends Error {
  constructor(id: bigint | string) { super(`user not found: ${String(id)}`); this.name = "UserNotFoundError"; }
}

/**
 * 原子修改 + 审计。patch 为空 → 无操作返当前行(也不写 audit)。
 * target 写成 `user:<id>`;before/after 只存 patch 涉及的那几个字段。
 */
export async function patchUser(
  id: bigint | string,
  patch: PatchUserInput,
  ctx: PatchUserAdminCtx,
): Promise<AdminUserRowView> {
  if (!/^[1-9][0-9]{0,19}$/.test(String(id))) throw new RangeError("invalid_user_id");
  const idStr = String(id);

  // 空 patch 快速返当前行,不写审计
  const touched = (patch.status !== undefined) || (patch.role !== undefined) || (patch.email_verified !== undefined);
  if (!touched) {
    const cur = await getUser(id);
    if (!cur) throw new UserNotFoundError(id);
    return cur;
  }

  if (patch.status !== undefined) assertStatus(patch.status);
  if (patch.role !== undefined && !(USER_ROLES as readonly string[]).includes(patch.role)) {
    throw new RangeError("invalid_role");
  }

  return tx(async (client: PoolClient) => {
    const before = await client.query<AdminUserRowView>(
      `SELECT ${USER_COLUMNS} FROM users WHERE id = $1 FOR UPDATE`,
      [idStr],
    );
    if (before.rows.length === 0) throw new UserNotFoundError(id);

    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, val: unknown): void => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    };
    if (patch.status !== undefined) push("status", patch.status);
    if (patch.role !== undefined) push("role", patch.role);
    if (patch.email_verified !== undefined) push("email_verified", patch.email_verified);
    sets.push("updated_at = NOW()");

    params.push(idStr);
    const after = await client.query<AdminUserRowView>(
      `UPDATE users SET ${sets.join(", ")} WHERE id = $${params.length}
       RETURNING ${USER_COLUMNS}`,
      params,
    );
    // before/after 只记变化字段 —— audit 的目的是"变了什么",不是"所有字段"
    const changedBefore: Record<string, unknown> = {};
    const changedAfter: Record<string, unknown> = {};
    const b = before.rows[0];
    const a = after.rows[0];
    if (patch.status !== undefined) { changedBefore.status = b.status; changedAfter.status = a.status; }
    if (patch.role !== undefined) { changedBefore.role = b.role; changedAfter.role = a.role; }
    if (patch.email_verified !== undefined) {
      changedBefore.email_verified = b.email_verified;
      changedAfter.email_verified = a.email_verified;
    }

    await writeAdminAudit(client, {
      adminId: ctx.adminId,
      action: "user.patch",
      target: `user:${idStr}`,
      before: changedBefore,
      after: changedAfter,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    });

    // T-63 告警:只有 role 真实变化才发 security.admin_role_changed —— critical
    if (patch.role !== undefined && b.role !== a.role) {
      const promoted = a.role === "admin";
      safeEnqueueAlert({
        event_type: EVENTS.SECURITY_ADMIN_ROLE_CHANGED,
        severity: "critical",
        title: promoted ? "用户被提升为 admin" : "admin 被降级",
        body: `用户 #${idStr}(${a.email})的 role 从 \`${b.role}\` 改为 \`${a.role}\`,操作者 admin #${ctx.adminId}。`,
        payload: {
          target_user_id: idStr,
          target_email: a.email,
          before_role: b.role,
          after_role: a.role,
          admin_id: String(ctx.adminId),
        },
        // dedupe 按 (目标, 新角色) —— 同一次变更只发一次;角色再变会有新 key
        dedupe_key: `security.admin_role_changed:${idStr}:${a.role}`,
      });
    }

    return a;
  });
}
