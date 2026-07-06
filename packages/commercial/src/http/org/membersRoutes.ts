/**
 * `/api/org/*` 成员管理路由(批次 A)。
 *
 * 所有 gated 路由的鉴权由 routes.ts 分发器统一先跑 requireOrgRole(minRole),
 * 本文件 handler 只拿 OrgRouteAuth(userId/orgId/orgRole/billingEnabled)做业务。
 * org 由 auth.orgId 推导,handler **不接受**客户端传 org_id(防 IDOR)。
 *
 * 授权矩阵(谁能操作谁):owner 可管理 admin+member;admin 只能管理 member;
 * owner 行不可被"成员管理"路径改动(只能 transfer-owner)。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, sendJson, readJsonBody } from "../util.js";
import { query, tx } from "../../db/queries.js";
import type { CommercialHttpDeps, RequestContext } from "../handlers.js";
import { OrgError, type OrgRole } from "../../org/types.js";
import { getOrgById, getOrgSummary } from "../../org/orgs.js";
import {
  listMembers,
  updateMember,
  removeMember,
  transferOwner,
  type MemberView,
} from "../../org/memberships.js";
import {
  createInvitation,
  acceptInvitation,
  revokeInvitation,
  listInvitations,
  type InvitationView,
} from "../../org/invitations.js";
import { createInboxMessage } from "../../inbox/inbox.js";
import type { OrgRoute, OrgRouteAuth } from "./routeTypes.js";

// ─── 小工具 ────────────────────────────────────────────────────────

/**
 * 从 OrgRouteAuth 收窄出必有 org 上下文的 gated 视图。
 * gated 路由的 minRole != null,分发器保证这些字段非空;这里做 fail-closed 兜底,
 * 万一漏配(minRole 写成 null)也不会裸奔进业务。
 */
function gated(auth: OrgRouteAuth): { userId: string; orgId: string; orgRole: OrgRole; billingEnabled: boolean } {
  if (auth.orgId === undefined || auth.orgRole === undefined || auth.billingEnabled === undefined) {
    throw new HttpError(500, "INTERNAL", "missing org auth context");
  }
  return { userId: auth.userId, orgId: auth.orgId, orgRole: auth.orgRole, billingEnabled: auth.billingEnabled };
}

function requireBigintId(raw: string | undefined, field: string): string {
  if (!raw || !/^[1-9][0-9]{0,19}$/.test(raw)) {
    throw new HttpError(400, "VALIDATION", `invalid ${field}`, { issues: [{ path: field, message: raw ?? "" }] });
  }
  return raw;
}

function asObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "VALIDATION", "request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

/** OrgError → HttpError 统一映射(携带 status/code)。 */
function throwOrg(err: unknown): never {
  if (err instanceof OrgError) throw new HttpError(err.status, err.code, err.message);
  throw err;
}

function serializeMember(m: MemberView): Record<string, unknown> {
  return {
    user_id: m.user_id,
    email: m.email,
    display_name: m.display_name,
    org_role: m.org_role,
    status: m.status,
    billing_enabled: m.billing_enabled,
    user_status: m.user_status,
    invited_by: m.invited_by,
    joined_at: m.joined_at instanceof Date ? m.joined_at.toISOString() : m.joined_at,
  };
}

function serializeInvitation(i: InvitationView): Record<string, unknown> {
  return {
    id: i.id,
    email: i.email,
    org_role: i.org_role,
    status: i.status,
    invited_by: i.invited_by,
    expires_at: i.expires_at instanceof Date ? i.expires_at.toISOString() : i.expires_at,
    accepted_at: i.accepted_at ? new Date(i.accepted_at).toISOString() : null,
    revoked_at: i.revoked_at ? new Date(i.revoked_at).toISOString() : null,
    created_at: i.created_at instanceof Date ? i.created_at.toISOString() : i.created_at,
  };
}

// ─── GET /api/org(member)—— 组织概要 ───────────────────────────────

async function handleOrgSummary(
  _req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  _deps: CommercialHttpDeps,
  auth: OrgRouteAuth,
): Promise<void> {
  const { orgId, orgRole, billingEnabled } = gated(auth);
  const summary = await getOrgSummary(orgId);
  if (!summary) throw new HttpError(404, "NOT_FOUND", "org not found");
  sendJson(res, 200, {
    org: {
      id: summary.id,
      name: summary.name,
      status: summary.status,
      role: orgRole,
      billing_enabled: billingEnabled,
      member_count: summary.member_count,
      max_members: summary.max_members,
      credits: summary.credits, // 只读余额(BIGINT ::text)
    },
  });
}

// ─── GET /api/org/members(admin)────────────────────────────────────

async function handleListMembers(
  _req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  _deps: CommercialHttpDeps,
  auth: OrgRouteAuth,
): Promise<void> {
  const { orgId } = gated(auth);
  const members = await listMembers(orgId);
  sendJson(res, 200, { members: members.map(serializeMember) });
}

// ─── PATCH /api/org/members/:uid(admin)─────────────────────────────

async function handlePatchMember(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  _deps: CommercialHttpDeps,
  auth: OrgRouteAuth,
  params: Record<string, string>,
): Promise<void> {
  const { orgId, orgRole } = gated(auth);
  const uid = requireBigintId(params.uid, "uid");
  const b = asObject(await readJsonBody(req));

  const patch: { orgRole?: OrgRole; billingEnabled?: boolean; status?: "active" | "suspended" } = {};
  if (b.org_role !== undefined) {
    if (b.org_role !== "admin" && b.org_role !== "member") {
      throw new HttpError(400, "VALIDATION", "org_role must be admin or member");
    }
    // 「仅 owner 可改角色」与管理矩阵的权威判定在数据层事务内(updateMember,
    // FOR UPDATE 后按目标行最新角色判,消 TOCTOU)——HTTP 层不重复判定。
    patch.orgRole = b.org_role;
  }
  if (b.billing_enabled !== undefined) {
    if (typeof b.billing_enabled !== "boolean") {
      throw new HttpError(400, "VALIDATION", "billing_enabled must be boolean");
    }
    patch.billingEnabled = b.billing_enabled;
  }
  if (b.status !== undefined) {
    if (b.status !== "active" && b.status !== "suspended") {
      throw new HttpError(400, "VALIDATION", "status must be active or suspended");
    }
    patch.status = b.status;
  }
  if (patch.orgRole === undefined && patch.billingEnabled === undefined && patch.status === undefined) {
    throw new HttpError(400, "VALIDATION", "no updatable fields provided");
  }

  try {
    const updated = await tx((client) =>
      updateMember(orgId, uid, patch, client, { role: orgRole, userId: auth.userId }),
    );
    sendJson(res, 200, {
      member: {
        user_id: updated.user_id,
        org_role: updated.org_role,
        status: updated.status,
        billing_enabled: updated.billing_enabled,
      },
    });
  } catch (err) {
    throwOrg(err);
  }
}

// ─── DELETE /api/org/members/:uid(admin)────────────────────────────

async function handleRemoveMember(
  _req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  _deps: CommercialHttpDeps,
  auth: OrgRouteAuth,
  params: Record<string, string>,
): Promise<void> {
  const { orgId, orgRole } = gated(auth);
  const uid = requireBigintId(params.uid, "uid");
  try {
    await tx((client) => removeMember(orgId, uid, client, { role: orgRole, userId: auth.userId }));
    sendJson(res, 200, { removed: true, user_id: uid });
  } catch (err) {
    throwOrg(err);
  }
}

// ─── POST /api/org/leave(member)────────────────────────────────────

async function handleLeave(
  _req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  _deps: CommercialHttpDeps,
  auth: OrgRouteAuth,
): Promise<void> {
  const { orgId, orgRole, userId } = gated(auth);
  if (orgRole === "owner") {
    throw new HttpError(403, "OWNER_MUST_TRANSFER", "owner must transfer ownership before leaving");
  }
  try {
    // 自离:actor==目标,removeMember 豁免管理矩阵(owner 已在上方拦截)。
    await tx((client) => removeMember(orgId, userId, client, { role: orgRole, userId }));
    sendJson(res, 200, { left: true });
  } catch (err) {
    throwOrg(err);
  }
}

// ─── POST /api/org/transfer-owner(owner)────────────────────────────

async function handleTransferOwner(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  _deps: CommercialHttpDeps,
  auth: OrgRouteAuth,
): Promise<void> {
  const { orgId, userId } = gated(auth);
  const b = asObject(await readJsonBody(req));
  const newOwnerId = requireBigintId(typeof b.user_id === "string" ? b.user_id : String(b.user_id ?? ""), "user_id");
  try {
    await transferOwner(orgId, userId, newOwnerId);
    sendJson(res, 200, { transferred: true, new_owner: newOwnerId });
  } catch (err) {
    throwOrg(err);
  }
}

// ─── POST /api/org/invitations(admin)───────────────────────────────

async function handleCreateInvitation(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
  auth: OrgRouteAuth,
): Promise<void> {
  const { orgId, userId, orgRole: callerRole } = gated(auth);
  const b = asObject(await readJsonBody(req));
  if (typeof b.email !== "string" || b.email.trim().length === 0) {
    throw new HttpError(400, "VALIDATION", "email is required");
  }
  const orgRole = b.org_role === undefined ? "member" : b.org_role;
  if (orgRole !== "admin" && orgRole !== "member") {
    throw new HttpError(400, "VALIDATION", "org_role must be admin or member");
  }
  // 邀请 admin = 造 admin,与"仅 owner 可改角色"同级权限:admin 若能邀 admin,
  // 就绕过了 owner-only 角色矩阵(Codex 审计 P0)。
  if (orgRole === "admin" && callerRole !== "owner") {
    throw new HttpError(403, "FORBIDDEN", "only the owner can invite admins");
  }

  let result;
  try {
    result = await createInvitation({ orgId, email: b.email, orgRole, invitedBy: userId });
  } catch (err) {
    throwOrg(err);
  }

  // 邀请链接:base url 取既有邮件模板同一权威源(deps.verifyEmailUrlBase = COMMERCIAL_BASE_URL)
  const baseUrl = (deps.verifyEmailUrlBase ?? "").replace(/\/$/, "");
  const link = `${baseUrl}/?orgInvite=${encodeURIComponent(result.rawToken)}`;
  const org = await getOrgById(orgId);
  const orgName = org?.name ?? "组织";

  // 发邀请邮件(best-effort,失败不回滚邀请:受邀人可让管理员重发)
  try {
    await deps.mailer.send({
      to: result.email,
      subject: `[OpenClaude] 邀请你加入组织「${orgName}」`,
      text:
        `你好,\n\n` +
        `${orgName} 邀请你加入其 OpenClaude 组织(角色:${orgRole === "admin" ? "管理员" : "成员"})。\n\n` +
        `请点击以下链接接受邀请(需用被邀请的邮箱 ${result.email} 登录):\n\n` +
        `    ${link}\n\n` +
        `邀请 7 天内有效。若这不是你预期的邀请,忽略此邮件即可。`,
    });
  } catch {
    /* best-effort */
  }

  // 受邀人已注册 → 同时发站内信(复用 inbox 后端;created_by = 邀请人)
  try {
    const u = await query<{ id: string; status: string }>(
      `SELECT id::text AS id, status FROM users WHERE lower(email) = lower($1) LIMIT 1`,
      [result.email],
    );
    const row = u.rows[0];
    if (row && row.status === "active") {
      await createInboxMessage(userId, {
        audience: "user",
        user_id: row.id,
        title: `邀请加入组织「${orgName}」`,
        body_md: `${orgName} 邀请你加入其组织(角色:${orgRole === "admin" ? "管理员" : "成员"})。请在设置中打开组织邀请以接受。`,
        level: "notice",
      });
    }
  } catch {
    /* best-effort */
  }

  sendJson(res, 201, {
    invitation: {
      id: result.id,
      email: result.email,
      org_role: result.orgRole,
      expires_at: result.expiresAt.toISOString(),
    },
  });
}

// ─── GET /api/org/invitations(admin)────────────────────────────────

async function handleListInvitations(
  _req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  _deps: CommercialHttpDeps,
  auth: OrgRouteAuth,
): Promise<void> {
  const { orgId } = gated(auth);
  const rows = await listInvitations(orgId);
  sendJson(res, 200, { invitations: rows.map(serializeInvitation) });
}

// ─── DELETE /api/org/invitations/:id(admin)─────────────────────────

async function handleRevokeInvitation(
  _req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  _deps: CommercialHttpDeps,
  auth: OrgRouteAuth,
  params: Record<string, string>,
): Promise<void> {
  const { orgId } = gated(auth);
  const id = requireBigintId(params.id, "id");
  try {
    await revokeInvitation(orgId, id);
    sendJson(res, 200, { revoked: true, id });
  } catch (err) {
    throwOrg(err);
  }
}

// ─── POST /api/org/invitations/accept(null — 受邀者尚非成员)─────────

async function handleAcceptInvitation(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  _deps: CommercialHttpDeps,
  auth: OrgRouteAuth,
): Promise<void> {
  const b = asObject(await readJsonBody(req));
  if (typeof b.token !== "string" || b.token.length === 0) {
    throw new HttpError(400, "VALIDATION", "token is required");
  }
  try {
    const r = await acceptInvitation(b.token, auth.userId);
    sendJson(res, 200, { joined: true, org_id: r.orgId, org_role: r.orgRole });
  } catch (err) {
    throwOrg(err);
  }
}

// ─── 路由表 ────────────────────────────────────────────────────────

export const memberRoutes: OrgRoute[] = [
  { method: "GET", pattern: "/api/org", minRole: "member", handler: handleOrgSummary },
  { method: "GET", pattern: "/api/org/members", minRole: "admin", handler: handleListMembers },
  { method: "PATCH", pattern: "/api/org/members/:uid", minRole: "admin", handler: handlePatchMember },
  { method: "DELETE", pattern: "/api/org/members/:uid", minRole: "admin", handler: handleRemoveMember },
  { method: "POST", pattern: "/api/org/leave", minRole: "member", handler: handleLeave },
  { method: "POST", pattern: "/api/org/transfer-owner", minRole: "owner", handler: handleTransferOwner },
  { method: "POST", pattern: "/api/org/invitations", minRole: "admin", handler: handleCreateInvitation },
  { method: "GET", pattern: "/api/org/invitations", minRole: "admin", handler: handleListInvitations },
  { method: "DELETE", pattern: "/api/org/invitations/:id", minRole: "admin", handler: handleRevokeInvitation },
  // 受邀者接受邀请时还不是成员 → minRole=null(只 requireAuth)。必须排在 :id 之前无所谓
  // (method 不同:POST vs DELETE),分发器按 method+pattern 精确匹配。
  { method: "POST", pattern: "/api/org/invitations/accept", minRole: null, handler: handleAcceptInvitation },
];
