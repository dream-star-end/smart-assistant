/**
 * /api/admin/orgs — 平台超管 org 运维 HTTP handler。
 *
 *   GET   /api/admin/orgs            → 列表(成员数/credits/created_at,keyset 分页)
 *   POST  /api/admin/orgs            → 按 owner 邮箱建 org
 *   PATCH /api/admin/orgs/:id        → 改 name/status/max_members
 *   POST  /api/admin/orgs/:id/credits→ 调余额(**批次 A 返 501 占位**,待 0112 计费批次)
 *
 * 全部 /api/admin/* 已被 router.ts:1575 全局 admin gate(requireAdminVerifyDb)覆盖;
 * 写 handler 仍自行 requireAdminVerifyDb 以拿 admin 身份写审计(与既有 users handler 同构)。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, sendJson, readJsonBody } from "../util.js";
import { requireAdmin, requireAdminVerifyDb } from "../../admin/requireAdmin.js";
import type { CommercialHttpDeps, RequestContext } from "../handlers.js";
import { extractTailId, parsePositiveInt } from "./_shared.js";
import {
  listOrgs,
  createOrgByEmail,
  patchOrg,
  type OrgWithStatsRow,
  type PatchOrgInput,
} from "../../admin/orgs.js";
import { OrgError, type OrgStatus } from "../../org/types.js";
import type { OrgRow } from "../../org/orgs.js";

const ORG_STATUSES: readonly OrgStatus[] = ["active", "suspended", "deleting", "deleted"];

function throwOrg(err: unknown): never {
  if (err instanceof OrgError) throw new HttpError(err.status, err.code, err.message);
  throw err;
}

function serializeOrg(o: OrgRow & { member_count?: number }): Record<string, unknown> {
  return {
    id: o.id,
    name: o.name,
    status: o.status,
    credits: o.credits,
    max_members: o.max_members,
    created_by: o.created_by,
    created_at: o.created_at instanceof Date ? o.created_at.toISOString() : o.created_at,
    updated_at: o.updated_at instanceof Date ? o.updated_at.toISOString() : o.updated_at,
    ...(o.member_count !== undefined ? { member_count: o.member_count } : {}),
  };
}

// ─── GET /api/admin/orgs ────────────────────────────────────────────

export async function handleAdminListOrgs(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const sp = url.searchParams;
  const q = sp.get("q") ?? undefined;
  const statusRaw = sp.get("status");
  let status: OrgStatus | undefined;
  if (statusRaw !== null && statusRaw !== "") {
    if (!(ORG_STATUSES as readonly string[]).includes(statusRaw)) {
      throw new HttpError(400, "VALIDATION", "invalid status", {
        issues: [{ path: "status", message: statusRaw }],
      });
    }
    status = statusRaw as OrgStatus;
  }
  const limit = parsePositiveInt(sp.get("limit"), "limit", 200);
  const cursorRaw = sp.get("cursor");
  let cursor: string | undefined;
  if (cursorRaw !== null && cursorRaw !== "") {
    if (!/^[1-9][0-9]{0,19}$/.test(cursorRaw)) {
      throw new HttpError(400, "VALIDATION", "invalid cursor", {
        issues: [{ path: "cursor", message: cursorRaw }],
      });
    }
    cursor = cursorRaw;
  }
  const r = await listOrgs({ q: q === "" ? undefined : q, status, limit, cursor });
  sendJson(res, 200, {
    rows: r.rows.map((row: OrgWithStatsRow) => serializeOrg(row)),
    next_cursor: r.next_cursor,
  });
}

// ─── POST /api/admin/orgs ───────────────────────────────────────────

export async function handleAdminCreateOrg(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  // 建 org = 供给动作(建 owner membership),走 VerifyDb 拿 admin 身份写审计。
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const body = (await readJsonBody(req)) ?? {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "VALIDATION", "request body must be a JSON object");
  }
  const b = body as Record<string, unknown>;
  if (typeof b.name !== "string" || b.name.trim().length === 0) {
    throw new HttpError(400, "VALIDATION", "name is required");
  }
  if (typeof b.owner_email !== "string" || b.owner_email.trim().length === 0) {
    throw new HttpError(400, "VALIDATION", "owner_email is required");
  }
  let maxMembers: number | undefined;
  if (b.max_members !== undefined) {
    if (typeof b.max_members !== "number" || !Number.isInteger(b.max_members) || b.max_members <= 0) {
      throw new HttpError(400, "VALIDATION", "max_members must be a positive integer");
    }
    maxMembers = b.max_members;
  }
  try {
    const org = await createOrgByEmail({
      name: b.name,
      ownerEmail: b.owner_email,
      maxMembers,
      adminId: admin.id,
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
    });
    sendJson(res, 201, { org: serializeOrg(org) });
  } catch (err) {
    throwOrg(err);
  }
}

// ─── PATCH /api/admin/orgs/:id ──────────────────────────────────────

export async function handleAdminPatchOrg(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const id = extractTailId(url, "/api/admin/orgs/");
  const body = (await readJsonBody(req)) ?? {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "VALIDATION", "request body must be a JSON object");
  }
  const b = body as Record<string, unknown>;
  const patch: PatchOrgInput = {};
  if (b.name !== undefined) {
    if (typeof b.name !== "string" || b.name.trim().length === 0) {
      throw new HttpError(400, "VALIDATION", "name must be a non-empty string");
    }
    patch.name = b.name;
  }
  if (b.status !== undefined) {
    if (typeof b.status !== "string" || !(ORG_STATUSES as readonly string[]).includes(b.status)) {
      throw new HttpError(400, "VALIDATION", "invalid status", {
        issues: [{ path: "status", message: String(b.status) }],
      });
    }
    patch.status = b.status as OrgStatus;
  }
  if (b.max_members !== undefined) {
    if (typeof b.max_members !== "number" || !Number.isInteger(b.max_members) || b.max_members <= 0) {
      throw new HttpError(400, "VALIDATION", "max_members must be a positive integer");
    }
    patch.maxMembers = b.max_members;
  }
  try {
    const org = await patchOrg(id, patch, {
      adminId: admin.id,
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
    });
    sendJson(res, 200, { org: serializeOrg(org) });
  } catch (err) {
    throwOrg(err);
  }
}

// ─── POST /api/admin/orgs/:id/credits(批次 A 占位 → 501)────────────

export async function handleAdminAdjustOrgCredits(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  // 仍先过 admin gate(不向非 admin 泄露路由存在性),再返回 501。
  await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const prefix = "/api/admin/orgs/";
  const suffix = "/credits";
  if (!url.pathname.startsWith(prefix) || !url.pathname.endsWith(suffix)) {
    throw new HttpError(404, "NOT_FOUND", "route not found");
  }
  // 不放开无流水的资金变动面(方案 §5):org 钱包变动必须带 ledger 流水,
  // credit_ledger.org_id 列在 0112(批次 B)落地后再放开。
  throw new HttpError(
    501,
    "NOT_IMPLEMENTED",
    "org credit adjustment is enabled by the billing batch (0112 org ledger); not available yet",
  );
}
