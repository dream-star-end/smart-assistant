/**
 * T-60 — /api/admin/* HTTP handlers。
 *
 * 统一约定:
 *   - 所有路由先走 `requireAdmin`(403 FORBIDDEN 非 admin;401 UNAUTHORIZED 无 token)
 *   - 写操作的 before/after 写 admin_audit,在同一事务内(见各 ops 模块)
 *   - URL 动态段(/users/:id / /accounts/:id / /pricing/:model_id)
 *     从 url.pathname 抽取,不让 router 做正则 —— 保持 router 简单
 *   - 所有错误经 HttpError 冒泡给 router 翻译成标准 error body
 *
 * 本文件只做"参数解析 + 调 ops + 序列化",业务逻辑都在 admin/* 下。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, sendJson, readJsonBody } from "./util.js";
import { requireAdmin } from "../admin/requireAdmin.js";
import {
  listUsers,
  getUser,
  patchUser,
  UserNotFoundError,
  type PatchUserInput,
  type AdminUserRowView,
  USER_STATUSES,
  USER_ROLES,
} from "../admin/users.js";
import {
  listAdminAudit,
  ADMIN_AUDIT_MAX_LIMIT,
  type AdminAuditRowView,
} from "../admin/audit.js";
import { adminAdjust, InsufficientCreditsError } from "../billing/ledger.js";
import type { CommercialHttpDeps, RequestContext } from "./handlers.js";

// ─── shared helpers ──────────────────────────────────────────────────

/** 解析 `/api/admin/users/:id` → `id` */
function extractTailId(url: URL, prefix: string): string {
  const tail = url.pathname.slice(prefix.length);
  if (!/^[1-9][0-9]{0,19}$/.test(tail)) {
    throw new HttpError(400, "VALIDATION", "invalid id in URL", {
      issues: [{ path: "id", message: tail }],
    });
  }
  return tail;
}

/** 同一通用 limit 校验 */
function parsePositiveInt(raw: string | null, name: string, max: number): number | undefined {
  if (raw === null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > max) {
    throw new HttpError(400, "VALIDATION", `${name} must be 1..${max}`, {
      issues: [{ path: name, message: raw }],
    });
  }
  return n;
}

function parseNonNegativeInt(raw: string | null, name: string): number | undefined {
  if (raw === null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new HttpError(400, "VALIDATION", `${name} must be >= 0`, {
      issues: [{ path: name, message: raw }],
    });
  }
  return n;
}

/** RangeError(来自 ops 层)统一翻译成 400 VALIDATION。 */
function translateRangeError(err: unknown): never {
  if (!(err instanceof RangeError)) throw err;
  const path = err.message.replace(/^invalid_/, "");
  throw new HttpError(400, "VALIDATION", `invalid ${path}`, {
    issues: [{ path, message: err.message }],
  });
}

function serializeUser(u: AdminUserRowView): Record<string, unknown> {
  return {
    id: u.id,
    email: u.email,
    email_verified: u.email_verified,
    display_name: u.display_name,
    avatar_url: u.avatar_url,
    role: u.role,
    credits: u.credits,
    status: u.status,
    deleted_at: u.deleted_at?.toISOString() ?? null,
    created_at: u.created_at.toISOString(),
    updated_at: u.updated_at.toISOString(),
  };
}

function serializeAudit(r: AdminAuditRowView): Record<string, unknown> {
  return {
    id: r.id,
    admin_id: r.admin_id,
    action: r.action,
    target: r.target,
    before: r.before,
    after: r.after,
    ip: r.ip,
    user_agent: r.user_agent,
    created_at: r.created_at.toISOString(),
  };
}

// ─── GET /api/admin/users?q=&status=&limit=&offset= ────────────────

export async function handleAdminListUsers(
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
  let status: "active" | "banned" | "deleting" | "deleted" | undefined;
  if (statusRaw !== null && statusRaw !== "") {
    if (!(USER_STATUSES as readonly string[]).includes(statusRaw)) {
      throw new HttpError(400, "VALIDATION", "invalid status", {
        issues: [{ path: "status", message: statusRaw }],
      });
    }
    status = statusRaw as "active" | "banned" | "deleting" | "deleted";
  }
  const limit = parsePositiveInt(sp.get("limit"), "limit", 200);
  const offset = parseNonNegativeInt(sp.get("offset"), "offset");

  try {
    const r = await listUsers({ q: q === "" ? undefined : q, status, limit, offset });
    sendJson(res, 200, { rows: r.rows.map(serializeUser) });
  } catch (err) { translateRangeError(err); }
}

// ─── GET /api/admin/users/:id ──────────────────────────────────────

export async function handleAdminGetUser(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const id = extractTailId(url, "/api/admin/users/");
  const u = await getUser(id);
  if (!u) throw new HttpError(404, "NOT_FOUND", "user not found");
  sendJson(res, 200, { user: serializeUser(u) });
}

// ─── PATCH /api/admin/users/:id ────────────────────────────────────

export async function handleAdminPatchUser(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdmin(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const id = extractTailId(url, "/api/admin/users/");

  const body = (await readJsonBody(req)) ?? {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "VALIDATION", "request body must be JSON object");
  }
  const b = body as Record<string, unknown>;
  const patch: PatchUserInput = {};
  if (b.status !== undefined) {
    if (typeof b.status !== "string" || !(USER_STATUSES as readonly string[]).includes(b.status)) {
      throw new HttpError(400, "VALIDATION", "invalid status", {
        issues: [{ path: "status", message: String(b.status) }],
      });
    }
    patch.status = b.status as PatchUserInput["status"];
  }
  if (b.role !== undefined) {
    if (typeof b.role !== "string" || !(USER_ROLES as readonly string[]).includes(b.role)) {
      throw new HttpError(400, "VALIDATION", "invalid role", {
        issues: [{ path: "role", message: String(b.role) }],
      });
    }
    patch.role = b.role as PatchUserInput["role"];
  }
  if (b.email_verified !== undefined) {
    if (typeof b.email_verified !== "boolean") {
      throw new HttpError(400, "VALIDATION", "email_verified must be boolean");
    }
    patch.email_verified = b.email_verified;
  }

  try {
    const u = await patchUser(id, patch, {
      adminId: admin.id,
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
    });
    sendJson(res, 200, { user: serializeUser(u) });
  } catch (err) {
    if (err instanceof UserNotFoundError) throw new HttpError(404, "NOT_FOUND", err.message);
    if (err instanceof RangeError) translateRangeError(err);
    throw err;
  }
}

// ─── POST /api/admin/users/:id/credits ─────────────────────────────

export async function handleAdminAdjustCredits(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdmin(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  // /api/admin/users/:id/credits → 提取 :id
  const prefix = "/api/admin/users/";
  const suffix = "/credits";
  if (!url.pathname.startsWith(prefix) || !url.pathname.endsWith(suffix)) {
    throw new HttpError(404, "NOT_FOUND", "route not found");
  }
  const idPart = url.pathname.slice(prefix.length, url.pathname.length - suffix.length);
  if (!/^[1-9][0-9]{0,19}$/.test(idPart)) {
    throw new HttpError(400, "VALIDATION", "invalid user id");
  }
  const body = (await readJsonBody(req)) ?? {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "VALIDATION", "request body must be JSON object");
  }
  const b = body as Record<string, unknown>;
  // delta 可以是数字(小额)或字符串(大额 → bigint);都走 BigInt
  let delta: bigint;
  try {
    if (typeof b.delta === "number") {
      if (!Number.isInteger(b.delta)) throw new TypeError("delta must be integer");
      delta = BigInt(b.delta);
    } else if (typeof b.delta === "string") {
      if (!/^-?[0-9]+$/.test(b.delta)) throw new TypeError("delta must be integer string");
      delta = BigInt(b.delta);
    } else {
      throw new TypeError("delta is required");
    }
  } catch (err) {
    throw new HttpError(400, "VALIDATION", (err as Error).message, {
      issues: [{ path: "delta", message: String(b.delta) }],
    });
  }
  if (delta === 0n) {
    throw new HttpError(400, "VALIDATION", "delta must be non-zero", {
      issues: [{ path: "delta", message: "0" }],
    });
  }
  if (typeof b.memo !== "string" || b.memo.trim().length === 0) {
    throw new HttpError(400, "VALIDATION", "memo is required", {
      issues: [{ path: "memo", message: "" }],
    });
  }
  if (b.memo.length > 500) {
    throw new HttpError(400, "VALIDATION", "memo too long (max 500 chars)");
  }

  try {
    const r = await adminAdjust(idPart, delta, b.memo, admin.id, {}, ctx.clientIp, ctx.userAgent);
    sendJson(res, 200, {
      ledger_id: r.ledger_id.toString(),
      balance_after: r.balance_after.toString(),
      audit_id: r.audit_id.toString(),
    });
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      throw new HttpError(402, "INSUFFICIENT_CREDITS", err.message, {
        issues: [{ path: "shortfall", message: err.shortfall.toString() }],
      });
    }
    if (err instanceof TypeError && err.message.startsWith("user not found")) {
      throw new HttpError(404, "NOT_FOUND", err.message);
    }
    throw err;
  }
}

// ─── GET /api/admin/audit?admin_id=&action=&limit=&before= ─────────

export async function handleAdminListAudit(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const sp = url.searchParams;
  const adminIdRaw = sp.get("admin_id");
  const actionRaw = sp.get("action");
  const beforeRaw = sp.get("before");
  const limit = parsePositiveInt(sp.get("limit"), "limit", ADMIN_AUDIT_MAX_LIMIT);

  try {
    const r = await listAdminAudit({
      adminId: adminIdRaw === null || adminIdRaw === "" ? undefined : adminIdRaw,
      action: actionRaw === null || actionRaw === "" ? undefined : actionRaw,
      before: beforeRaw === null || beforeRaw === "" ? undefined : beforeRaw,
      limit,
    });
    sendJson(res, 200, {
      rows: r.rows.map(serializeAudit),
      next_before: r.next_before,
    });
  } catch (err) { translateRangeError(err); }
}
