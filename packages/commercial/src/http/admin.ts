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
import {
  listPricing,
  patchPricing,
  PricingNotFoundError,
  type ModelPricingRowView,
  type PatchPricingInput,
} from "../admin/pricing.js";
import {
  listPlans,
  patchPlan,
  PlanNotFoundError,
  type TopupPlanRowView,
  type PatchPlanInput,
} from "../admin/plans.js";
import {
  adminListAccounts,
  adminGetAccount,
  adminCreateAccount,
  adminPatchAccount,
  adminDeleteAccount,
  type AdminCreateAccountInput,
  type AdminPatchAccountInput,
} from "../admin/accounts.js";
import {
  listContainers,
  adminRestartContainer,
  adminStopContainer,
  adminRemoveContainer,
  ContainerNotFoundError,
  type AdminContainerRowView,
} from "../admin/containers.js";
import {
  listLedger,
  LEDGER_MAX_LIMIT,
  LEDGER_REASONS,
  type LedgerRowView,
  type LedgerReason,
} from "../admin/ledger.js";
import { AccountNotFoundError, type AccountRow } from "../account-pool/store.js";
import { adminAdjust, InsufficientCreditsError } from "../billing/ledger.js";
import { renderPrometheus } from "../admin/metrics.js";
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

// ─── pricing / plans serializers ────────────────────────────────────

function serializePricing(r: ModelPricingRowView): Record<string, unknown> {
  return {
    model_id: r.model_id,
    display_name: r.display_name,
    input_per_mtok: r.input_per_mtok,
    output_per_mtok: r.output_per_mtok,
    cache_read_per_mtok: r.cache_read_per_mtok,
    cache_write_per_mtok: r.cache_write_per_mtok,
    multiplier: r.multiplier,
    enabled: r.enabled,
    sort_order: r.sort_order,
    updated_at: r.updated_at.toISOString(),
    updated_by: r.updated_by,
  };
}

function serializePlan(r: TopupPlanRowView): Record<string, unknown> {
  return {
    id: r.id,
    code: r.code,
    label: r.label,
    amount_cents: r.amount_cents,
    credits: r.credits,
    sort_order: r.sort_order,
    enabled: r.enabled,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  };
}

/** 从 `/api/admin/{pricing,plans}/<slug>` 抽 slug,用配套的正则验。 */
function extractTailSlug(url: URL, prefix: string, re: RegExp): string {
  const tail = url.pathname.slice(prefix.length);
  if (!re.test(tail)) {
    throw new HttpError(400, "VALIDATION", "invalid slug in URL", {
      issues: [{ path: "slug", message: tail }],
    });
  }
  return tail;
}

// ─── GET /api/admin/pricing ────────────────────────────────────────

export async function handleAdminListPricing(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const rows = await listPricing();
  sendJson(res, 200, { rows: rows.map(serializePricing) });
}

// ─── PATCH /api/admin/pricing/:model_id ─────────────────────────────

export async function handleAdminPatchPricing(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdmin(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const modelId = extractTailSlug(url, "/api/admin/pricing/", /^[A-Za-z0-9._-]{1,64}$/);

  const body = (await readJsonBody(req)) ?? {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "VALIDATION", "request body must be JSON object");
  }
  const b = body as Record<string, unknown>;
  const patch: PatchPricingInput = {};
  if (b.multiplier !== undefined) {
    if (typeof b.multiplier !== "string" && typeof b.multiplier !== "number") {
      throw new HttpError(400, "VALIDATION", "multiplier must be string or number", {
        issues: [{ path: "multiplier", message: String(b.multiplier) }],
      });
    }
    patch.multiplier = b.multiplier;
  }
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== "boolean") {
      throw new HttpError(400, "VALIDATION", "enabled must be boolean");
    }
    patch.enabled = b.enabled;
  }

  try {
    const r = await patchPricing(modelId, patch, {
      adminId: admin.id,
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
    });
    sendJson(res, 200, { pricing: serializePricing(r) });
  } catch (err) {
    if (err instanceof PricingNotFoundError) throw new HttpError(404, "NOT_FOUND", err.message);
    if (err instanceof RangeError) translateRangeError(err);
    throw err;
  }
}

// ─── GET /api/admin/plans ──────────────────────────────────────────

export async function handleAdminListPlans(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const rows = await listPlans();
  sendJson(res, 200, { rows: rows.map(serializePlan) });
}

// ─── PATCH /api/admin/plans/:code ──────────────────────────────────

export async function handleAdminPatchPlan(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdmin(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const code = extractTailSlug(url, "/api/admin/plans/", /^[A-Za-z0-9_-]{1,64}$/);

  const body = (await readJsonBody(req)) ?? {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "VALIDATION", "request body must be JSON object");
  }
  const b = body as Record<string, unknown>;
  const patch: PatchPlanInput = {};
  if (b.label !== undefined) {
    if (typeof b.label !== "string") {
      throw new HttpError(400, "VALIDATION", "label must be string", {
        issues: [{ path: "label", message: String(b.label) }],
      });
    }
    patch.label = b.label;
  }
  if (b.amount_cents !== undefined) {
    if (typeof b.amount_cents !== "string" && typeof b.amount_cents !== "number") {
      throw new HttpError(400, "VALIDATION", "amount_cents must be string or number");
    }
    patch.amount_cents = b.amount_cents;
  }
  if (b.credits !== undefined) {
    if (typeof b.credits !== "string" && typeof b.credits !== "number") {
      throw new HttpError(400, "VALIDATION", "credits must be string or number");
    }
    patch.credits = b.credits;
  }
  if (b.sort_order !== undefined) {
    if (typeof b.sort_order !== "number" || !Number.isInteger(b.sort_order)) {
      throw new HttpError(400, "VALIDATION", "sort_order must be integer");
    }
    patch.sort_order = b.sort_order;
  }
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== "boolean") {
      throw new HttpError(400, "VALIDATION", "enabled must be boolean");
    }
    patch.enabled = b.enabled;
  }

  try {
    const r = await patchPlan(code, patch, {
      adminId: admin.id,
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
    });
    sendJson(res, 200, { plan: serializePlan(r) });
  } catch (err) {
    if (err instanceof PlanNotFoundError) throw new HttpError(404, "NOT_FOUND", err.message);
    if (err instanceof RangeError) translateRangeError(err);
    throw err;
  }
}

// ════════════════════════════════════════════════════════════════════
// T-60(3/3): accounts / agent-containers / ledger
// ════════════════════════════════════════════════════════════════════

function serializeAccount(a: AccountRow): Record<string, unknown> {
  return {
    id: a.id.toString(),
    label: a.label,
    plan: a.plan,
    status: a.status,
    health_score: a.health_score,
    cooldown_until: a.cooldown_until?.toISOString() ?? null,
    oauth_expires_at: a.oauth_expires_at?.toISOString() ?? null,
    last_used_at: a.last_used_at?.toISOString() ?? null,
    last_error: a.last_error,
    success_count: a.success_count.toString(),
    fail_count: a.fail_count.toString(),
    quota_remaining: a.quota_remaining,
    created_at: a.created_at.toISOString(),
    updated_at: a.updated_at.toISOString(),
  };
}

function serializeContainer(r: AdminContainerRowView): Record<string, unknown> {
  return {
    id: r.id,
    user_id: r.user_id,
    user_email: r.user_email,
    subscription_id: r.subscription_id,
    subscription_status: r.subscription_status,
    subscription_end_at: r.subscription_end_at?.toISOString() ?? null,
    docker_id: r.docker_id,
    docker_name: r.docker_name,
    workspace_volume: r.workspace_volume,
    home_volume: r.home_volume,
    image: r.image,
    status: r.status,
    last_started_at: r.last_started_at?.toISOString() ?? null,
    last_stopped_at: r.last_stopped_at?.toISOString() ?? null,
    volume_gc_at: r.volume_gc_at?.toISOString() ?? null,
    last_error: r.last_error,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  };
}

function serializeLedger(r: LedgerRowView): Record<string, unknown> {
  return {
    id: r.id,
    user_id: r.user_id,
    delta: r.delta,
    balance_after: r.balance_after,
    reason: r.reason,
    ref_type: r.ref_type,
    ref_id: r.ref_id,
    memo: r.memo,
    created_at: r.created_at.toISOString(),
  };
}

// ─── accounts ──────────────────────────────────────────────────────

export async function handleAdminListAccounts(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const sp = url.searchParams;
  const status = sp.get("status") ?? undefined;
  const limit = parsePositiveInt(sp.get("limit"), "limit", 500);
  const offset = parseNonNegativeInt(sp.get("offset"), "offset");
  try {
    const rows = await adminListAccounts({
      status: status === undefined || status === "" ? undefined : (status as never),
      limit,
      offset,
    });
    sendJson(res, 200, { rows: rows.map(serializeAccount) });
  } catch (err) { translateRangeError(err); }
}

export async function handleAdminGetAccount(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const id = extractTailId(url, "/api/admin/accounts/");
  const a = await adminGetAccount(id);
  if (!a) throw new HttpError(404, "NOT_FOUND", "account not found");
  sendJson(res, 200, { account: serializeAccount(a) });
}

export async function handleAdminCreateAccount(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdmin(req, deps.jwtSecret);
  const body = (await readJsonBody(req)) ?? {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "VALIDATION", "request body must be JSON object");
  }
  const b = body as Record<string, unknown>;
  if (typeof b.label !== "string") throw new HttpError(400, "VALIDATION", "label is required");
  if (typeof b.plan !== "string") throw new HttpError(400, "VALIDATION", "plan is required");
  if (typeof b.oauth_token !== "string" || b.oauth_token.length === 0) {
    throw new HttpError(400, "VALIDATION", "oauth_token is required");
  }
  const input: AdminCreateAccountInput = {
    label: b.label,
    plan: b.plan as AdminCreateAccountInput["plan"],
    oauth_token: b.oauth_token,
  };
  if (b.oauth_refresh_token !== undefined) {
    if (b.oauth_refresh_token !== null && typeof b.oauth_refresh_token !== "string") {
      throw new HttpError(400, "VALIDATION", "oauth_refresh_token must be string or null");
    }
    input.oauth_refresh_token = b.oauth_refresh_token;
  }
  if (b.oauth_expires_at !== undefined) {
    if (b.oauth_expires_at !== null && typeof b.oauth_expires_at !== "string") {
      throw new HttpError(400, "VALIDATION", "oauth_expires_at must be ISO string or null");
    }
    input.oauth_expires_at = b.oauth_expires_at as string | null;
  }

  try {
    const a = await adminCreateAccount(input, {
      adminId: admin.id, ip: ctx.clientIp, userAgent: ctx.userAgent,
    });
    sendJson(res, 201, { account: serializeAccount(a) });
  } catch (err) {
    if (err instanceof RangeError) translateRangeError(err);
    throw err;
  }
}

export async function handleAdminPatchAccount(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdmin(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const id = extractTailId(url, "/api/admin/accounts/");
  const body = (await readJsonBody(req)) ?? {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "VALIDATION", "request body must be JSON object");
  }
  const b = body as Record<string, unknown>;
  const patch: AdminPatchAccountInput = {};
  if (b.label !== undefined) {
    if (typeof b.label !== "string") throw new HttpError(400, "VALIDATION", "label must be string");
    patch.label = b.label;
  }
  if (b.plan !== undefined) {
    if (typeof b.plan !== "string") throw new HttpError(400, "VALIDATION", "plan must be string");
    patch.plan = b.plan as AdminPatchAccountInput["plan"];
  }
  if (b.status !== undefined) {
    if (typeof b.status !== "string") throw new HttpError(400, "VALIDATION", "status must be string");
    patch.status = b.status as AdminPatchAccountInput["status"];
  }
  if (b.health_score !== undefined) {
    if (typeof b.health_score !== "number") throw new HttpError(400, "VALIDATION", "health_score must be number");
    patch.health_score = b.health_score;
  }
  if (b.oauth_token !== undefined) {
    if (typeof b.oauth_token !== "string") throw new HttpError(400, "VALIDATION", "oauth_token must be string");
    patch.oauth_token = b.oauth_token;
  }
  if (b.oauth_refresh_token !== undefined) {
    if (b.oauth_refresh_token !== null && typeof b.oauth_refresh_token !== "string") {
      throw new HttpError(400, "VALIDATION", "oauth_refresh_token must be string or null");
    }
    patch.oauth_refresh_token = b.oauth_refresh_token;
  }
  if (b.oauth_expires_at !== undefined) {
    if (b.oauth_expires_at !== null && typeof b.oauth_expires_at !== "string") {
      throw new HttpError(400, "VALIDATION", "oauth_expires_at must be ISO string or null");
    }
    patch.oauth_expires_at = b.oauth_expires_at as string | null;
  }

  try {
    const a = await adminPatchAccount(id, patch, {
      adminId: admin.id, ip: ctx.clientIp, userAgent: ctx.userAgent,
    });
    sendJson(res, 200, { account: serializeAccount(a) });
  } catch (err) {
    if (err instanceof AccountNotFoundError) throw new HttpError(404, "NOT_FOUND", err.message);
    if (err instanceof RangeError) translateRangeError(err);
    throw err;
  }
}

export async function handleAdminDeleteAccount(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdmin(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const id = extractTailId(url, "/api/admin/accounts/");
  const ok = await adminDeleteAccount(id, {
    adminId: admin.id, ip: ctx.clientIp, userAgent: ctx.userAgent,
  });
  if (!ok) throw new HttpError(404, "NOT_FOUND", "account not found");
  sendJson(res, 200, { deleted: true });
}

// ─── agent containers ──────────────────────────────────────────────

export async function handleAdminListAgentContainers(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const sp = url.searchParams;
  const status = sp.get("status") ?? undefined;
  const limit = parsePositiveInt(sp.get("limit"), "limit", 500);
  const offset = parseNonNegativeInt(sp.get("offset"), "offset");
  try {
    const rows = await listContainers({
      status: status === undefined || status === "" ? undefined : status,
      limit,
      offset,
    });
    sendJson(res, 200, { rows: rows.map(serializeContainer) });
  } catch (err) { translateRangeError(err); }
}

type ContainerAction = "restart" | "stop" | "remove";

function parseContainerActionUrl(url: URL): { id: string; action: ContainerAction } {
  const prefix = "/api/admin/agent-containers/";
  if (!url.pathname.startsWith(prefix)) {
    throw new HttpError(404, "NOT_FOUND", "route not found");
  }
  const tail = url.pathname.slice(prefix.length);
  const parts = tail.split("/");
  if (parts.length !== 2) {
    throw new HttpError(404, "NOT_FOUND", "expected /:id/{restart,stop,remove}");
  }
  const [id, action] = parts;
  if (!/^[1-9][0-9]{0,19}$/.test(id)) {
    throw new HttpError(400, "VALIDATION", "invalid id in URL");
  }
  if (action !== "restart" && action !== "stop" && action !== "remove") {
    throw new HttpError(404, "NOT_FOUND", `unknown action: ${action}`);
  }
  return { id, action };
}

export async function handleAdminAgentContainerAction(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdmin(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const { id, action } = parseContainerActionUrl(url);
  const agent = deps.agentRuntime;
  if (!agent) {
    throw new HttpError(503, "AGENT_NOT_READY", "agent runtime is not configured");
  }
  const auditCtx = { adminId: admin.id, ip: ctx.clientIp, userAgent: ctx.userAgent };
  try {
    if (action === "restart") await adminRestartContainer(id, agent.docker, auditCtx);
    else if (action === "stop") await adminStopContainer(id, agent.docker, auditCtx);
    else await adminRemoveContainer(id, agent.docker, auditCtx);
  } catch (err) {
    if (err instanceof ContainerNotFoundError) throw new HttpError(404, "NOT_FOUND", err.message);
    throw err;
  }
  sendJson(res, 200, { ok: true, action });
}

// ─── ledger ────────────────────────────────────────────────────────

export async function handleAdminListLedger(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const sp = url.searchParams;
  const userIdRaw = sp.get("user_id");
  const reasonRaw = sp.get("reason");
  const beforeRaw = sp.get("before");
  const limit = parsePositiveInt(sp.get("limit"), "limit", LEDGER_MAX_LIMIT);

  let reason: LedgerReason | undefined;
  if (reasonRaw !== null && reasonRaw !== "") {
    if (!(LEDGER_REASONS as readonly string[]).includes(reasonRaw)) {
      throw new HttpError(400, "VALIDATION", "invalid reason", {
        issues: [{ path: "reason", message: reasonRaw }],
      });
    }
    reason = reasonRaw as LedgerReason;
  }

  try {
    const r = await listLedger({
      userId: userIdRaw === null || userIdRaw === "" ? undefined : userIdRaw,
      reason,
      before: beforeRaw === null || beforeRaw === "" ? undefined : beforeRaw,
      limit,
    });
    sendJson(res, 200, {
      rows: r.rows.map(serializeLedger),
      next_before: r.next_before,
    });
  } catch (err) { translateRangeError(err); }
}

// ─── metrics(T-62)──────────────────────────────────────────────────

/**
 * 常时比较:常数时间判等,防 timing 攻击(token 长度泄漏除外)。
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * GET /api/admin/metrics → Prometheus text exposition。
 *
 * 认证两选一:
 *   1. `COMMERCIAL_METRICS_BEARER` env 设了 → Authorization: Bearer <该 token>
 *      长寿命 machine credential,给 Prometheus scraper 用。长度必须 ≥ 32。
 *   2. 否则回落到 admin JWT(短 TTL,15min 内手工 curl 调试用)
 *
 * 为什么不开 /metrics 无 auth:account_pool_health 会泄漏 Claude 账号池哪些
 * 活/哪些挂,对外是有价值的侦察情报(02-ARCH §7.2 "超管后台拉取展示")。
 */
export async function handleAdminMetrics(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const scrapeBearer = process.env.COMMERCIAL_METRICS_BEARER ?? "";
  let authorized = false;
  if (scrapeBearer.length >= 32) {
    const h = req.headers["authorization"];
    if (typeof h === "string" && h.startsWith("Bearer ")) {
      const token = h.slice("Bearer ".length).trim();
      if (constantTimeEqual(token, scrapeBearer)) authorized = true;
    }
  }
  if (!authorized) {
    // 回落 admin JWT:失败会抛 HttpError(401/403),由 router 统一翻译
    await requireAdmin(req, deps.jwtSecret);
  }
  const body = await renderPrometheus();
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}
