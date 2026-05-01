/**
 * T-60 — /api/admin/* HTTP handlers。
 *
 * 统一约定:
 *   - **读**路由用 `requireAdmin`(只校验 JWT 里的 role='admin',24h TTL)
 *   - **写**路由用 `requireAdminVerifyDb`(JWT + DB 双校验 role/status)
 *     — 防止已被降权/封禁的 admin 在 JWT TTL 内继续用旧 token 改后台状态
 *       (2026-04-21 安全审计 Medium#5)。写路由包含:
 *         PatchUser / AdjustCredits / PatchPricing / PatchPlan /
 *         CreateAccount / PatchAccount / DeleteAccount / OAuthExchange /
 *         AgentContainerAction / PutSetting
 *   - 写操作的 before/after 写 admin_audit,在同一事务内(见各 ops 模块)
 *   - URL 动态段(/users/:id / /accounts/:id / /pricing/:model_id)
 *     从 url.pathname 抽取,不让 router 做正则 —— 保持 router 简单
 *   - 所有错误经 HttpError 冒泡给 router 翻译成标准 error body
 *
 * 本文件只做"参数解析 + 调 ops + 序列化",业务逻辑都在 admin/* 下。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, sendJson, readJsonBody } from "./util.js";
import { requireAdmin, requireAdminVerifyDb } from "../admin/requireAdmin.js";
import {
  listUsers,
  listUsersWithStats,
  getUser,
  getUserDetail,
  patchUser,
  buildUsersCsv,
  UserNotFoundError,
  type PatchUserInput,
  type AdminUserRowView,
  type AdminUserWithStatsRowView,
  type AdminUserDetailResult,
  type UserStatus,
  type RegisteredWithin,
  type FunnelState,
  USER_STATUSES,
  USER_ROLES,
  REGISTERED_WITHIN_VALUES,
  FUNNEL_STATES,
} from "../admin/users.js";
import { getUsersStats } from "../admin/usersStats.js";
import {
  listAdminAudit,
  writeAdminAudit,
  ADMIN_AUDIT_MAX_LIMIT,
  type AdminAuditRowView,
} from "../admin/audit.js";
import { getPool } from "../db/index.js";
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
  adminResetCooldown,
  getAccountRecentUsers,
  maskEgressProxy,
  AccountHasActiveCodexBindingsError,
  type AdminCreateAccountInput,
  type AdminPatchAccountInput,
} from "../admin/accounts.js";
import {
  getAccountsPoolStats,
  getAccountsTodayStats,
} from "../admin/accountsStats.js";
import {
  startAccountOAuth,
  exchangeAccountOAuth,
  OAuthExchangeError,
  type OAuthProvider,
} from "../admin/oauth.js";
import {
  listContainers,
  adminRestartContainer,
  adminStopContainer,
  adminRemoveContainer,
  adminContainerLogs,
  LOGS_MAX_LINES,
  ContainerNotFoundError,
  V3SupervisorMissingError,
  type AdminContainerRowView,
} from "../admin/containers.js";
import { getContainersPoolStats } from "../admin/containersStats.js";
import { SupervisorError } from "../agent-sandbox/types.js";
import {
  listLedger,
  buildLedgerCsv,
  LEDGER_MAX_LIMIT,
  LEDGER_REASONS,
  type LedgerRowView,
  type LedgerReason,
} from "../admin/ledger.js";
import { tx } from "../db/queries.js";
import { AccountNotFoundError, type AccountRow } from "../account-pool/store.js";
import {
  listRefreshEvents,
  MAX_LIST_LIMIT as REFRESH_EVENTS_MAX_LIMIT,
  DEFAULT_LIST_LIMIT as REFRESH_EVENTS_DEFAULT_LIMIT,
} from "../account-pool/refreshEvents.js";
import { adminAdjust, InsufficientCreditsError } from "../billing/ledger.js";
import { renderPrometheus } from "../admin/metrics.js";
import {
  listSystemSettings,
  getSystemSetting,
  setSystemSetting,
  ALLOWED_KEYS,
  KEY_META,
  SystemSettingNotFoundError,
  SystemSettingValidationError,
  type SystemSettingKey,
  type SystemSettingRow,
} from "../admin/systemSettings.js";
import {
  listOrders,
  getOrderDetail,
  getOrdersKpi,
  buildOrdersCsv,
  ORDER_STATUSES,
  type OrderRowView,
  type OrderDetailView,
  type OrdersKpiView,
  type OrderStatus,
} from "../admin/orders.js";
import { csvFilename } from "../admin/csvHelper.js";
import {
  listFeedback,
  ackFeedback,
  FeedbackNotFoundError,
  type FeedbackRowView,
} from "../admin/feedback.js";
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

/**
 * Phase B:Users 列表 + CSV 共用 — 解析 registered_within / funnel_state。
 * 提到 helper 是因为这两参 List 接口 + CSV 接口都要传,把校验逻辑收一处避免漂移。
 */
function parseUserFunnelFilters(sp: URLSearchParams): {
  registered_within?: RegisteredWithin;
  funnel_state?: FunnelState;
} {
  const out: { registered_within?: RegisteredWithin; funnel_state?: FunnelState } = {};
  const rw = sp.get("registered_within");
  if (rw !== null && rw !== "") {
    if (!(REGISTERED_WITHIN_VALUES as readonly string[]).includes(rw)) {
      throw new HttpError(400, "VALIDATION", "invalid registered_within", {
        issues: [{ path: "registered_within", message: rw }],
      });
    }
    out.registered_within = rw as RegisteredWithin;
  }
  const fs = sp.get("funnel_state");
  if (fs !== null && fs !== "") {
    if (!(FUNNEL_STATES as readonly string[]).includes(fs)) {
      throw new HttpError(400, "VALIDATION", "invalid funnel_state", {
        issues: [{ path: "funnel_state", message: fs }],
      });
    }
    out.funnel_state = fs as FunnelState;
  }
  return out;
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

/** R2 增强版:serializeUser + 运营 stats。 */
function serializeUserWithStats(u: AdminUserWithStatsRowView): Record<string, unknown> {
  return {
    ...serializeUser(u),
    today_requests: u.today_requests,
    today_errors: u.today_errors,
    total_topup_cents: u.total_topup_cents,
    last_active_at: u.last_active_at,
    containers_active: u.containers_active,
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

// ─── GET /api/admin/users?q=&status=&limit=&cursor=&with_stats=1 ────

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
  // R2:cursor 分页(id 数字字符串)。与 offset 互斥 —— 同时传时 users.ts
  // 侧优先用 cursor,offset 归零。
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
  // with_stats=1 → listUsersWithStats(追加 today/topup/last_active);默认不追,
  // 保持老调用者(如集成测试)读到的 shape 不变。
  const withStats = sp.get("with_stats") === "1";
  // Phase B:新过滤维度,与 q/status/cursor 可叠加。
  const funnelFilters = parseUserFunnelFilters(sp);

  try {
    if (withStats) {
      const r = await listUsersWithStats({
        q: q === "" ? undefined : q, status, limit, offset, cursor, ...funnelFilters,
      });
      sendJson(res, 200, {
        rows: r.rows.map(serializeUserWithStats),
        next_cursor: r.next_cursor,
      });
      return;
    }
    const r = await listUsers({
      q: q === "" ? undefined : q, status, limit, offset, cursor, ...funnelFilters,
    });
    sendJson(res, 200, {
      rows: r.rows.map(serializeUser),
      next_cursor: r.next_cursor,
    });
  } catch (err) { translateRangeError(err); }
}

// ─── GET /api/admin/users/stats (R2 新增 KPI 面板) ──────────────────
//
// 响应:{ total_users, active_users, banned_users, deleted_users,
//         new_7d, active_7d, paying_7d, avg_credits_cents, total_credits_cents }
// 所有字段定义见 admin/usersStats.ts。

export async function handleAdminUsersStats(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const out = await getUsersStats();
  sendJson(res, 200, out);
}

// ─── GET /api/admin/users/:id 或 /api/admin/users/:id/detail ───────
//
// router 同 method+pathPrefix 只挂一个 handler(matchRoute 找到第一个就 dispatch),
// 所以 detail 子路径必须由本 handler 内部分流。规则:
//   - /api/admin/users/:id/detail  → 返回 admin 详情聚合(getUserDetail)
//   - /api/admin/users/:id         → 返回单行 user(getUser)
// 严格正则,不允许任何尾段;否则 404。其它子路径(如 :id/credits)走 POST,
// 不在本 GET 路径上。

const USER_DETAIL_RE = /^\/api\/admin\/users\/([1-9][0-9]{0,19})\/detail$/;

export async function handleAdminGetUser(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  // 0049:/api/admin/users/:id/model-grants — 0049 模型授权列表(独立 handler)。
  // 这条优先于其他子路径匹配,避免被 detail / extractTailId 截。
  if (matchUserModelGrantsList(url)) {
    await handleAdminListUserModelGrants(req, res, ctx, deps);
    return;
  }
  await requireAdmin(req, deps.jwtSecret);

  // detail 子路径优先匹配
  const detailMatch = USER_DETAIL_RE.exec(url.pathname);
  if (detailMatch) {
    const id = detailMatch[1];
    // id 已被正则保证为合法 bigint 字符串,getUserDetail 不会抛 RangeError;
    // DB 错误正常冒泡到 router。
    const detail = await getUserDetail(id);
    if (!detail) throw new HttpError(404, "NOT_FOUND", "user not found");
    sendJson(res, 200, serializeUserDetail(detail));
    return;
  }

  // 否则要求严格 /api/admin/users/:id(extractTailId 会拒绝任何非 bigint 尾段)
  const id = extractTailId(url, "/api/admin/users/");
  const u = await getUser(id);
  if (!u) throw new HttpError(404, "NOT_FOUND", "user not found");
  sendJson(res, 200, { user: serializeUser(u) });
}

function serializeUserDetail(d: AdminUserDetailResult): Record<string, unknown> {
  return {
    user: serializeUser(d.user),
    lifecycle: d.lifecycle,
    topups: d.topups,
    recent_requests: d.recent_requests,
    recent_sessions: d.recent_sessions,
  };
}

// ─── PATCH /api/admin/users/:id ────────────────────────────────────

export async function handleAdminPatchUser(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
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
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  // 同 prefix 下其它 POST 子资源 —— 按 path 分发,避开"借 prefix 路由名义跑成 adjustCredits"
  // 误派发。0049 model-grants 走这里:
  //   POST /api/admin/users/:id/model-grants → handleAdminAddUserModelGrant
  if (matchUserModelGrantsList(url)) {
    await handleAdminAddUserModelGrant(req, res, ctx, deps);
    return;
  }
  // adjustCredits 能凭空发积分(= 钱),金额硬 cap ¥100 万 —— 写路由统一走
  // requireAdminVerifyDb,见文件头注释。
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
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
  // 2026-04-21 codex round 1 finding #6 修复:服务端硬 cap delta 绝对值 ≤
  // ¥100 万(= 1 亿 cents)。前端 UI 已按 ¥X.XX 收并转 cents,但前端可被
  // 绕过/Number 精度损失;服务端必须独立守住,不能把安全押在前端。
  // 100 万 ¥ 远超任何合法 admin 手动调整场景;真要更大金额走 dev 直改 DB。
  const MAX_ADMIN_DELTA_CENTS = 100_000_000n; // ¥1,000,000 = 100,000,000 cents
  const absDelta = delta < 0n ? -delta : delta;
  if (absDelta > MAX_ADMIN_DELTA_CENTS) {
    throw new HttpError(400, "VALIDATION", "delta exceeds ±100,000,000 cents (¥1,000,000) cap", {
      issues: [{ path: "delta", message: delta.toString() }],
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
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
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
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
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

function serializeAccount(
  a: AccountRow,
  poolLabels?: Map<string, string>,
): Record<string, unknown> {
  const epid = a.egress_proxy_id !== null ? a.egress_proxy_id.toString() : null;
  return {
    id: a.id.toString(),
    /** V3 provider:'claude' | 'codex'(0051)。决定 admin UI tab + 容器内 auth 路径。 */
    provider: a.provider,
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
    /** M9 配额可见性 — 由 anthropicProxy 上游响应头被动写入。pct 是 0-100 的 number|null。 */
    quota_5h_pct: a.quota_5h_pct,
    quota_5h_resets_at: a.quota_5h_resets_at?.toISOString() ?? null,
    quota_7d_pct: a.quota_7d_pct,
    quota_7d_resets_at: a.quota_7d_resets_at?.toISOString() ?? null,
    quota_updated_at: a.quota_updated_at?.toISOString() ?? null,
    /** 已 mask 密码,UI 安全显示;明文绝不出库 */
    egress_proxy: maskEgressProxy(a.egress_proxy),
    has_egress_proxy: a.egress_proxy !== null,
    /** 0053 代理池 entry id(NULL = 走 raw egress_proxy 或本机出口)。 */
    egress_proxy_id: epid,
    /** JOIN egress_proxies 查到的池条目 label;前端 UI 直接显示这一行的"代理池"列。 */
    egress_proxy_pool_label: epid !== null ? (poolLabels?.get(epid) ?? null) : null,
    /** 0038 — 自动分配的 compute_host id;UI 显示绑定状态 + 触发重分配。 */
    egress_host_uuid: a.egress_host_uuid,
    /** UI 区分 oauth 过期"可自愈(待 lazy refresh)"vs"需人工"的依据。 */
    has_refresh_token: a.has_refresh_token,
    created_at: a.created_at.toISOString(),
    updated_at: a.updated_at.toISOString(),
  };
}

/**
 * 批量解析 egress_proxy_id → label。给 list/get accounts 路径用。
 * 走 IN clause,limit ≤ 500(adminListAccounts limit 上限),不会爆 SQL。
 */
async function fetchEgressProxyLabels(
  rows: AccountRow[],
): Promise<Map<string, string>> {
  const ids = new Set<string>();
  for (const r of rows) {
    if (r.egress_proxy_id !== null) ids.add(r.egress_proxy_id.toString());
  }
  if (ids.size === 0) return new Map();
  const idArr = [...ids];
  const r = await getPool().query<{ id: string; label: string }>(
    `SELECT id::text AS id, label
     FROM egress_proxies
     WHERE id = ANY($1::bigint[])`,
    [idArr],
  );
  const m = new Map<string, string>();
  for (const row of r.rows) m.set(row.id, row.label);
  return m;
}

export function serializeContainer(r: AdminContainerRowView): Record<string, unknown> {
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
    // R3 finding 加固:R1#4 SQL 算出来的 v3 状态字段没在这里输出 → 前端
    // admin.js 取 c.row_kind/c.lifecycle 拿到 undefined,UI 显示 '?' / '—'。
    state: r.state,
    lifecycle: r.lifecycle,
    row_kind: r.row_kind,
    last_started_at: r.last_started_at?.toISOString() ?? null,
    last_stopped_at: r.last_stopped_at?.toISOString() ?? null,
    volume_gc_at: r.volume_gc_at?.toISOString() ?? null,
    last_error: r.last_error,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
    host_uuid: r.host_uuid,
    host_name: r.host_name,
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
  const providerRaw = sp.get("provider");
  // V3 admin tab "Claude / Codex" 切换 — UI 显式传 provider=claude 或 codex 来过滤。
  // 不传/空字符串/"all" = 不过滤(向后兼容老调用者)。前端 G 节会显式传值,因此
  // 该兼容路径仅用于:外部脚本 / curl 调试 / 历史调用点。
  let providerFilter: OAuthProvider | undefined;
  if (providerRaw === null || providerRaw === "" || providerRaw === "all") {
    providerFilter = undefined;
  } else if (providerRaw === "claude" || providerRaw === "codex") {
    providerFilter = providerRaw;
  } else {
    throw new HttpError(400, "VALIDATION", "provider must be claude/codex/all");
  }
  const limit = parsePositiveInt(sp.get("limit"), "limit", 500);
  const offset = parseNonNegativeInt(sp.get("offset"), "offset");
  // R3:with_stats=1 → 追加每账号今日请求/错误数。用 scoped LATERAL-free 聚合,
  // scope 到本页 id[],≤500 id 受限不退化。默认不追,保持老调用者 shape。
  const withStats = sp.get("with_stats") === "1";
  try {
    const rows = await adminListAccounts({
      status: status === undefined || status === "" ? undefined : (status as never),
      provider: providerFilter,
      limit,
      offset,
    });
    const poolLabels = await fetchEgressProxyLabels(rows);
    if (!withStats) {
      sendJson(res, 200, { rows: rows.map((r) => serializeAccount(r, poolLabels)) });
      return;
    }
    const ids = rows.map((r) => r.id);
    const stats = await getAccountsTodayStats(ids);
    const byId = new Map(stats.map((s) => [s.account_id, s]));
    sendJson(res, 200, {
      rows: rows.map((r) => {
        const s = byId.get(r.id.toString());
        return {
          ...serializeAccount(r, poolLabels),
          today_requests: s?.today_requests ?? 0,
          today_errors: s?.today_errors ?? 0,
        };
      }),
    });
  } catch (err) { translateRangeError(err); }
}

// ─── GET /api/admin/accounts/stats (R3 新增 KPI 面板) ──────────────
export async function handleAdminAccountsStats(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const out = await getAccountsPoolStats();
  sendJson(res, 200, out);
}

export async function handleAdminGetAccount(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  // accounts 走 router 的 pathPrefix `/api/admin/accounts/`,所有 GET 都走这一个
  // 入口。子资源(/recent-users)在这里 dispatch — 不能为子路径单独注册 route
  // (会被 prefix 吞)。参考 R3 reset-cooldown 的同模式(router.ts:445-452)。
  //
  // 不用 split limit=2:那样 /123/recent-users/extra 会让 action="recent-users"
  // 通过 → 行为不该的子路径被静默接受。slice(1).join("/") 让 extra 段把
  // action 撑成 "recent-users/extra",落到下方的 action !== "" 404 分支。
  const tail = url.pathname.slice("/api/admin/accounts/".length);
  const parts = tail.split("/");
  const idRaw = parts[0] ?? "";
  const action = parts.slice(1).join("/");
  if (!/^[1-9][0-9]{0,19}$/.test(idRaw)) {
    throw new HttpError(400, "VALIDATION", "invalid id in URL", {
      issues: [{ path: "id", message: idRaw }],
    });
  }
  if (action === "recent-users") {
    return handleAccountRecentUsers(idRaw, url, res);
  }
  if (action !== "") {
    throw new HttpError(404, "NOT_FOUND", "endpoint not found");
  }
  const a = await adminGetAccount(idRaw);
  if (!a) throw new HttpError(404, "NOT_FOUND", "account not found");
  const poolLabels = await fetchEgressProxyLabels([a]);
  sendJson(res, 200, { account: serializeAccount(a, poolLabels) });
}

/**
 * GET /api/admin/accounts/:id/recent-users?hours=24&limit=20
 * 列出最近 N 小时使用过这个账号的用户(按请求量倒序)。
 *
 * caller 是 handleAdminGetAccount 的 sub-dispatcher,id 已校验过 bigint 形态;
 * requireAdmin 也已通过。
 */
async function handleAccountRecentUsers(
  id: string,
  url: URL,
  res: ServerResponse,
): Promise<void> {
  const hoursRaw = url.searchParams.get("hours");
  const limitRaw = url.searchParams.get("limit");
  const hours =
    hoursRaw !== null && hoursRaw !== ""
      ? parsePositiveInt(hoursRaw, "hours", 24 * 30) ?? 24
      : 24;
  const limit =
    limitRaw !== null && limitRaw !== ""
      ? parsePositiveInt(limitRaw, "limit", 100) ?? 20
      : 20;
  // 账号存在校验 → 否则 404(避免静默返空)
  const a = await adminGetAccount(id);
  if (!a) throw new HttpError(404, "NOT_FOUND", "account not found");
  try {
    const rows = await getAccountRecentUsers(id, hours, limit);
    sendJson(res, 200, { rows });
  } catch (err) { translateRangeError(err); }
}

/**
 * M6/P1-9 — GET /api/admin/accounts/refresh-events?account_id=N&limit=50
 *
 * 返回该账号最近 N 次 OAuth refresh 事件,倒序。limit 默认 50,上限 500。
 *
 * 注意:用 query string 而非 :id path 参数 —— router 不支持 path-param,
 * 走 pathPrefix 会被 handleAdminGetAccount 吞掉。用 exact path 注册在
 * `/api/admin/accounts/` prefix 之前优先匹配(同 `/api/admin/accounts/stats` 模式)。
 */
export async function handleAdminListRefreshEvents(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const accountIdRaw = url.searchParams.get("account_id");
  if (!accountIdRaw || !/^[1-9][0-9]{0,19}$/.test(accountIdRaw)) {
    throw new HttpError(400, "VALIDATION", "account_id query param required (positive integer)", {
      issues: [{ path: "account_id", message: accountIdRaw ?? "(missing)" }],
    });
  }
  const limit =
    parsePositiveInt(url.searchParams.get("limit"), "limit", REFRESH_EVENTS_MAX_LIMIT) ??
    REFRESH_EVENTS_DEFAULT_LIMIT;
  // 校验账号存在(给 admin 一个清晰 404,而不是返空数组)
  const a = await adminGetAccount(accountIdRaw);
  if (!a) throw new HttpError(404, "NOT_FOUND", "account not found");
  const events = await listRefreshEvents(accountIdRaw, limit);
  sendJson(res, 200, {
    events: events.map((e) => ({
      id: e.id.toString(),
      account_id: e.account_id.toString(),
      ts: e.ts.toISOString(),
      ok: e.ok,
      err_code: e.err_code,
      err_msg: e.err_msg,
    })),
  });
}

export async function handleAdminCreateAccount(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
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
  // V3 — provider 默认 'claude' 与历史行为一致;传 'codex' 时 admin 层会同时
  // 强制要求 oauth_refresh_token(refresh actor 60s tick 依赖)。
  let provider: OAuthProvider | undefined;
  if (b.provider !== undefined) {
    if (b.provider === "claude" || b.provider === "codex") provider = b.provider;
    else throw new HttpError(400, "VALIDATION", "provider must be 'claude' or 'codex'");
  }
  // 0055: 拒绝 legacy raw egress_proxy 字段。所有出口必须通过 egress_proxies 池
  // (egress_proxy_id),raw text 列已 CHECK NULL 锁死。
  if (b.egress_proxy !== undefined) {
    throw new HttpError(400, "VALIDATION", "legacy_egress_proxy_not_allowed");
  }
  // egress_proxy_id 创建时必填,具体存在性由 admin 层兜底校验
  if (b.egress_proxy_id === undefined || b.egress_proxy_id === null || b.egress_proxy_id === "") {
    throw new HttpError(400, "VALIDATION", "egress_proxy_id is required");
  }
  if (typeof b.egress_proxy_id !== "string" && typeof b.egress_proxy_id !== "number") {
    throw new HttpError(400, "VALIDATION", "egress_proxy_id must be string or number");
  }

  const input: AdminCreateAccountInput = {
    label: b.label,
    plan: b.plan as AdminCreateAccountInput["plan"],
    oauth_token: b.oauth_token,
    egress_proxy_id: String(b.egress_proxy_id),
    ...(provider !== undefined ? { provider } : {}),
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
    const poolLabels = await fetchEgressProxyLabels([a]);
    sendJson(res, 201, { account: serializeAccount(a, poolLabels) });
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
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const id = extractTailId(url, "/api/admin/accounts/");
  const body = (await readJsonBody(req)) ?? {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "VALIDATION", "request body must be JSON object");
  }
  const b = body as Record<string, unknown>;
  // V3 — provider 创建后不可改(决策 R)。前端早就知道这点,挡在 HTTP 层显式 reject
  // 防降权 admin 误传 provider 把 codex 账号回退到 claude(再去走 claude OAuth 路径)。
  if (b.provider !== undefined) {
    throw new HttpError(400, "VALIDATION", "provider cannot be changed after creation");
  }
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
  // 0055: 拒绝 legacy raw egress_proxy 字段。
  if (b.egress_proxy !== undefined) {
    throw new HttpError(400, "VALIDATION", "legacy_egress_proxy_not_allowed");
  }
  // egress_proxy_id 不允许 null / 空串(账号必须始终绑定池条目)
  if (b.egress_proxy_id !== undefined) {
    if (b.egress_proxy_id === null || b.egress_proxy_id === "") {
      throw new HttpError(400, "VALIDATION", "egress_proxy_id cannot be null");
    }
    if (typeof b.egress_proxy_id !== "string" && typeof b.egress_proxy_id !== "number") {
      throw new HttpError(400, "VALIDATION", "egress_proxy_id must be string or number");
    }
    patch.egress_proxy_id = String(b.egress_proxy_id);
  }
  if (b.egress_host_uuid !== undefined) {
    if (b.egress_host_uuid !== null && typeof b.egress_host_uuid !== "string") {
      throw new HttpError(400, "VALIDATION", "egress_host_uuid must be string or null");
    }
    patch.egress_host_uuid =
      typeof b.egress_host_uuid === "string" && b.egress_host_uuid.trim().length === 0
        ? null
        : (b.egress_host_uuid as string | null);
  }

  try {
    const a = await adminPatchAccount(id, patch, {
      adminId: admin.id, ip: ctx.clientIp, userAgent: ctx.userAgent,
    });
    const poolLabels = await fetchEgressProxyLabels([a]);
    sendJson(res, 200, { account: serializeAccount(a, poolLabels) });
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
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const id = extractTailId(url, "/api/admin/accounts/");
  // codex 账号若被 stopped/vanished 容器持有 FK,需要 ?force=1 让 admin 层先把
  // 那些非 active row 的 codex_account_id 置 NULL,再 DELETE(决策 B + 0054 RESTRICT)。
  // active 容器仍引用 → 任何 force 值都会抛 AccountHasActiveCodexBindingsError → 409。
  const force = url.searchParams.get("force") === "1";
  try {
    const ok = await adminDeleteAccount(
      id,
      { adminId: admin.id, ip: ctx.clientIp, userAgent: ctx.userAgent },
      { force },
    );
    if (!ok) throw new HttpError(404, "NOT_FOUND", "account not found");
    sendJson(res, 200, { deleted: true });
  } catch (err) {
    if (err instanceof AccountHasActiveCodexBindingsError) {
      throw new HttpError(409, err.code, err.message, {
        // 标准 error.issues 数组用 path/message 编码 active_binding_count,
        // 前端 admin.js 看到 code=ACCOUNT_HAS_ACTIVE_CODEX_BINDINGS 时
        // 解析 issues 拿 count 显示"X 个活跃容器仍绑此账号"。
        issues: [
          { path: "active_binding_count", message: String(err.active_binding_count) },
        ],
      });
    }
    throw err;
  }
}

// ─── POST /api/admin/accounts/:id/reset-cooldown (R3) ─────────────
// 清空 cooldown_until + last_error;status 不动(见 accounts.ts 说明)。
export async function handleAdminResetAccountCooldown(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  // URL 形如 /api/admin/accounts/:id/reset-cooldown;把 ":id" 抠出来
  const m = url.pathname.match(/^\/api\/admin\/accounts\/([1-9][0-9]{0,19})\/reset-cooldown$/);
  if (!m) throw new HttpError(400, "VALIDATION", "invalid account id");
  const id = m[1];
  try {
    const a = await adminResetCooldown(id, {
      adminId: admin.id, ip: ctx.clientIp, userAgent: ctx.userAgent,
    });
    const poolLabels = await fetchEgressProxyLabels([a]);
    sendJson(res, 200, { account: serializeAccount(a, poolLabels) });
  } catch (err) {
    if (err instanceof RangeError) translateRangeError(err);
    if (err instanceof Error && err.name === "AccountNotFoundError") {
      throw new HttpError(404, "NOT_FOUND", "account not found");
    }
    throw err;
  }
}

// ─── account-pool OAuth(管理员"新建账号"流程)──────────────────────
//
// 流程:
//   1. POST /api/admin/accounts/oauth/start     → { authUrl, state }
//   2. admin 浏览器打开 authUrl,授权后从回调 URL 复制 code
//   3. POST /api/admin/accounts/oauth/exchange  body: { code, state }
//                                               → { access_token, refresh_token, expires_at, scope }
//   4. 前端把 token 自动填进"新建账号"表单,POST /api/admin/accounts 走标准入库
//
// 这两个接口不写库 —— 落库由后续的 adminCreateAccount 完成,审计自然落在那里。

export async function handleAdminOAuthStart(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  // POST body 可选 { provider: "claude" | "codex" },默认 claude。
  // 走 try/catch 因为 readJsonBody 对空 body 返回 null,不要让它把 GET 客户端打挂。
  let provider: OAuthProvider = "claude";
  try {
    const body = await readJsonBody(req);
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const p = (body as Record<string, unknown>).provider;
      if (p === "claude" || p === "codex") provider = p;
      else if (p !== undefined) {
        throw new HttpError(400, "VALIDATION", "provider must be 'claude' or 'codex'");
      }
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    // body parse 失败 → 当作无 body,沿用默认 provider
  }
  try {
    const r = startAccountOAuth(provider);
    sendJson(res, 200, r);
  } catch (err) {
    if (err instanceof OAuthExchangeError) {
      throw new HttpError(err.status, "OAUTH_FAILED", err.message);
    }
    throw err;
  }
}

export async function handleAdminOAuthExchange(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  // 写路径:返回可落库的 anthropic OAuth token,后续 adminCreateAccount 真正入库。
  // 虽然 exchange 本身不写 DB,但它是账号创建链路里必经的"换 token"动作,保持
  // 与写族一致的 requireAdminVerifyDb 鉴权防降权 admin 重用旧 JWT 建账号。
  await requireAdminVerifyDb(req, deps.jwtSecret);
  const body = (await readJsonBody(req)) ?? {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "VALIDATION", "request body must be JSON object");
  }
  const b = body as Record<string, unknown>;
  if (typeof b.code !== "string" || !b.code) {
    throw new HttpError(400, "VALIDATION", "code is required");
  }
  if (typeof b.state !== "string" || !b.state) {
    throw new HttpError(400, "VALIDATION", "state is required");
  }
  try {
    const r = await exchangeAccountOAuth(b.code, b.state);
    sendJson(res, 200, r);
  } catch (err) {
    if (err instanceof OAuthExchangeError) {
      throw new HttpError(err.status, "OAUTH_FAILED", err.message);
    }
    throw err;
  }
}

// ─── agent containers ──────────────────────────────────────────────

const HOST_UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

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
  const hostUuidRaw = sp.get("host_uuid");
  let hostUuid: string | undefined;
  if (hostUuidRaw !== null && hostUuidRaw !== "") {
    if (!HOST_UUID_RE.test(hostUuidRaw)) {
      throw new HttpError(400, "INVALID_HOST_UUID", "host_uuid must be UUID");
    }
    hostUuid = hostUuidRaw;
  }
  try {
    const rows = await listContainers({
      status: status === undefined || status === "" ? undefined : status,
      limit,
      offset,
      host_uuid: hostUuid,
    });
    sendJson(res, 200, { rows: rows.map(serializeContainer) });
  } catch (err) { translateRangeError(err); }
}

// ─── GET /api/admin/agent-containers/stats (R4 新增 KPI 面板) ──────
//
// 响应 ContainersPoolStats: { total, running, provisioning, stopped, error,
//         gone, v2, v3, expiring_7d, with_last_error }
// 定义见 admin/containersStats.ts。

export async function handleAdminContainersStats(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const out = await getContainersPoolStats();
  sendJson(res, 200, out);
}

// ─── GET /api/admin/agent-containers/:id/logs?lines=N ──────────────
//
// admin 读 docker tail logs(只读 + requireAdmin JWT 够)。
// 容器已不存在 → { stdout:"", stderr:"", combined:"", missing:true };
// 不抛 404(admin UI 在容器 vanished 后还想看 DB 记录,保留入口更友好)。

export async function handleAdminContainerLogs(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  // Codex MEDIUM#2:日志比 stats/list 敏感(可能含用户 prompt / 调试输出 / 环境
  // 信息),拉到 DB 双校验 —— 降权/封禁的 admin 24h JWT 内不能再读日志。
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  // 匹配 `/api/admin/agent-containers/:id/logs`。其它 GET prefix 一律 404,
  // 避免 future /api/admin/agent-containers/:id/inspect 等新路径误走到这里。
  const m = url.pathname.match(/^\/api\/admin\/agent-containers\/([1-9][0-9]{0,19})\/logs$/);
  if (!m) {
    throw new HttpError(404, "NOT_FOUND", "expected /agent-containers/:id/logs");
  }
  const id = m[1]!;
  const linesRaw = url.searchParams.get("lines");
  let lines = 200;
  if (linesRaw !== null && linesRaw !== "") {
    const n = Number(linesRaw);
    if (!Number.isInteger(n) || n <= 0 || n > LOGS_MAX_LINES) {
      throw new HttpError(400, "VALIDATION", `lines must be 1..${LOGS_MAX_LINES}`, {
        issues: [{ path: "lines", message: linesRaw }],
      });
    }
    lines = n;
  }
  const agent = deps.agentRuntime;
  if (!agent) {
    throw new HttpError(503, "AGENT_NOT_READY", "agent runtime is not configured");
  }
  try {
    const logs = await adminContainerLogs(id, agent.docker, lines, deps.v3Supervisor);
    // Codex MEDIUM#2 补:敏感读 best-effort audit(同 accounts/containers.ts 语义,
    // 写 admin_audit 失败不阻塞响应)
    try {
      await writeAdminAudit(getPool(), {
        adminId: admin.id,
        action: "agent_container.logs",
        target: `agent_container:${id}`,
        before: null,
        after: {
          lines,
          docker_ref: logs.docker_ref,
          missing: logs.missing,
          bytes: logs.combined.length,
          partial: logs.partial,
        },
        ip: ctx.clientIp ?? null,
        userAgent: ctx.userAgent ?? null,
      });
    } catch { /* best-effort */ }
    sendJson(res, 200, {
      id,
      lines,
      stdout: logs.stdout,
      stderr: logs.stderr,
      combined: logs.combined,
      docker_ref: logs.docker_ref,
      missing: logs.missing,
      partial: logs.partial,
    });
  } catch (err) {
    if (err instanceof ContainerNotFoundError) throw new HttpError(404, "NOT_FOUND", err.message);
    if (err instanceof V3SupervisorMissingError) {
      throw new HttpError(503, "V3_SUPERVISOR_NOT_READY", err.message);
    }
    if (err instanceof RangeError) translateRangeError(err);
    // Codex LOW#4:非 404 docker 错(daemon down / network / 500)翻 502 DOCKER_LOGS_FAILED
    // —— 不走默认 500 INTERNAL,让 admin 知道是上游 docker 挂了而不是 gateway bug
    const e = err as { statusCode?: number; code?: string; message?: string };
    const msg = typeof e?.message === "string" ? e.message : String(err);
    if (
      e?.statusCode === 500 ||
      e?.code === "ECONNREFUSED" ||
      e?.code === "ENOTFOUND" ||
      /docker/i.test(msg)
    ) {
      throw new HttpError(502, "DOCKER_LOGS_FAILED", msg, {
        issues: [{ path: "container_id", message: id }],
      });
    }
    throw err;
  }
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
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const { id, action } = parseContainerActionUrl(url);
  const agent = deps.agentRuntime;
  if (!agent) {
    throw new HttpError(503, "AGENT_NOT_READY", "agent runtime is not configured");
  }
  const auditCtx = { adminId: admin.id, ip: ctx.clientIp, userAgent: ctx.userAgent };
  // HIGH#6:v3 行(docker_name=NULL)经 v3Supervisor dispatch;v2 行走老路径。
  // v3Supervisor 未注入(OC_RUNTIME_IMAGE 没配)且行是 v3 → 抛 V3SupervisorMissingError → 503。
  const v3Supervisor = deps.v3Supervisor;
  try {
    if (action === "restart") await adminRestartContainer(id, agent.docker, auditCtx, v3Supervisor);
    else if (action === "stop") await adminStopContainer(id, agent.docker, auditCtx, v3Supervisor);
    else await adminRemoveContainer(id, agent.docker, auditCtx, v3Supervisor);
  } catch (err) {
    if (err instanceof ContainerNotFoundError) throw new HttpError(404, "NOT_FOUND", err.message);
    // 0017 后 v2 admin 操作路径碰到 v3 行,但 gateway 没装配 v3 supervisor(OC_RUNTIME_IMAGE
    // 缺失 / 启动跳过)→ 503,告诉 admin 配置缺,而不是 dockerode 抛 "No such container: undefined"。
    if (err instanceof V3SupervisorMissingError) {
      throw new HttpError(503, "V3_SUPERVISOR_NOT_READY", err.message);
    }
    // R2 finding 加固:v3 已 DB 翻 vanished 但 docker 清理失败 → 502 + 明确文案。
    // admin UI 拿到 V3_CLEANUP_PARTIAL 知道 row 已 vanished,容器残骸 reconciler
    // 后台兜底(orphan reconcile 1h tick 内会扫掉),不要再点重试。
    if (err instanceof SupervisorError && err.code === "PartialV3Cleanup") {
      throw new HttpError(502, "V3_CLEANUP_PARTIAL", err.message, {
        issues: [
          { path: "container_id", message: id },
          { path: "next", message: "row already marked vanished; orphan reconciler will retry docker cleanup" },
        ],
      });
    }
    // R3 finding 加固:lookupContainer 对 v2 行缺 docker_name 抛 RangeError —
    // 这是 DB 数据不变量被破坏的信号(v2 INSERT 必填 docker_name),不是用户
    // 操作错误。翻成 500 SCHEMA_INVARIANT 让运维 grep 出来人工查。
    if (err instanceof RangeError) {
      throw new HttpError(500, "SCHEMA_INVARIANT", err.message, {
        issues: [{ path: "container_id", message: id }],
      });
    }
    throw err;
  }
  sendJson(res, 200, { ok: true, action });
}

// ─── ledger ────────────────────────────────────────────────────────

/** 从 sp 提取 ledger 共用过滤参数(user_id / reason / from / to)。 */
function parseLedgerFilter(sp: URLSearchParams): {
  userId: string | undefined;
  reason: LedgerReason | undefined;
  from: string | undefined;
  to: string | undefined;
} {
  const userIdRaw = sp.get("user_id");
  const reasonRaw = sp.get("reason");
  const fromRaw = sp.get("from");
  const toRaw = sp.get("to");
  let reason: LedgerReason | undefined;
  if (reasonRaw !== null && reasonRaw !== "") {
    if (!(LEDGER_REASONS as readonly string[]).includes(reasonRaw)) {
      throw new HttpError(400, "VALIDATION", "invalid reason", {
        issues: [{ path: "reason", message: reasonRaw }],
      });
    }
    reason = reasonRaw as LedgerReason;
  }
  return {
    userId: userIdRaw === null || userIdRaw === "" ? undefined : userIdRaw,
    reason,
    from: fromRaw === null || fromRaw === "" ? undefined : fromRaw,
    to: toRaw === null || toRaw === "" ? undefined : toRaw,
  };
}

export async function handleAdminListLedger(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const sp = url.searchParams;
  const filter = parseLedgerFilter(sp);
  const beforeRaw = sp.get("before");
  const limit = parsePositiveInt(sp.get("limit"), "limit", LEDGER_MAX_LIMIT);

  try {
    const r = await listLedger({
      ...filter,
      before: beforeRaw === null || beforeRaw === "" ? undefined : beforeRaw,
      limit,
    });
    sendJson(res, 200, {
      rows: r.rows.map(serializeLedger),
      next_before: r.next_before,
    });
  } catch (err) { translateRangeError(err); }
}

// ─── GET /api/admin/ledger.csv?user_id&reason&from&to (P1-5) ────────
//
// 写路由 — 用 requireAdminVerifyDb,审计 'ledger.export_csv'。
// CSV 内存构建,审计成功后再 writeHead(避免 header/body 顺序 bug)。

export async function handleAdminExportLedgerCsv(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const filter = parseLedgerFilter(url.searchParams);

  let csv: string;
  let rowCount: number;
  try {
    const r = await buildLedgerCsv(filter);
    csv = r.csv;
    rowCount = r.rowCount;
  } catch (err) { translateRangeError(err); }

  // 审计先写,失败抛 → 不下发 body。
  await tx(async (client) => {
    await writeAdminAudit(client, {
      adminId: admin.id,
      action: "ledger.export_csv",
      target: filter.userId ? `user:${filter.userId}` : "all",
      after: {
        rows: rowCount,
        filter: {
          user_id: filter.userId ?? null,
          reason: filter.reason ?? null,
          from: filter.from ?? null,
          to: filter.to ?? null,
        },
      },
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
    });
  });

  // YYYYMMDDTHHmm(UTC,文件名不掺时区差异)
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
  const filename = `ledger-${stamp}.csv`;

  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Content-Length": Buffer.byteLength(csv, "utf-8"),
    "Cache-Control": "no-store",
  });
  res.end(csv);
}

// ─── GET /api/admin/users.csv?q&status (M8.4 / P2-20) ──────────────
//
// 写路由级保护:requireAdminVerifyDb + admin_audit('users.export_csv')。
// 内存构建,审计先于 writeHead — 失败抛 → 不下发 body。

export async function handleAdminExportUsersCsv(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const sp = url.searchParams;

  const qRaw = sp.get("q");
  const q = qRaw === null || qRaw === "" ? undefined : qRaw;

  // status 参数:repeat ?status=active&status=banned 或单值;统一传给 buildUsersCsv。
  const statusList = sp.getAll("status").filter(Boolean);
  for (const s of statusList) {
    if (!(USER_STATUSES as readonly string[]).includes(s)) {
      throw new HttpError(400, "VALIDATION", `invalid status: ${s}`, {
        issues: [{ path: "status", message: s }],
      });
    }
  }
  const status: UserStatus | UserStatus[] | undefined =
    statusList.length === 0
      ? undefined
      : statusList.length === 1
        ? (statusList[0] as UserStatus)
        : (statusList as UserStatus[]);

  // Phase B:CSV 导出与列表使用同一组过滤维度,避免运营看见的列表 ≠ 导出集
  const funnelFilters = parseUserFunnelFilters(sp);

  let csv: string;
  let rowCount: number;
  try {
    const r = await buildUsersCsv({ q, status, ...funnelFilters });
    csv = r.csv;
    rowCount = r.rowCount;
  } catch (err) {
    translateRangeError(err);
  }

  await tx(async (client) => {
    await writeAdminAudit(client, {
      adminId: admin.id,
      action: "users.export_csv",
      target: q ? `q:${q}` : "all",
      after: {
        rows: rowCount,
        filter: {
          q: q ?? null,
          status: status ?? null,
          registered_within: funnelFilters.registered_within ?? null,
          funnel_state: funnelFilters.funnel_state ?? null,
        },
      },
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
    });
  });

  const filename = csvFilename("users");
  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Content-Length": Buffer.byteLength(csv, "utf-8"),
    "Cache-Control": "no-store",
  });
  res.end(csv);
}

// ─── GET /api/admin/orders.csv?status&user_id&from&to (M8.4) ───────

export async function handleAdminExportOrdersCsv(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const sp = url.searchParams;

  const statusRaw = sp.get("status");
  let status: OrderStatus | undefined;
  if (statusRaw !== null && statusRaw !== "") {
    if (!(ORDER_STATUSES as readonly string[]).includes(statusRaw)) {
      throw new HttpError(400, "VALIDATION", "invalid status", {
        issues: [{ path: "status", message: statusRaw }],
      });
    }
    status = statusRaw as OrderStatus;
  }
  const userId = parseUserId(sp.get("user_id"));
  const from = parseIsoTimestamp(sp.get("from"), "from");
  const to = parseIsoTimestamp(sp.get("to"), "to");

  let csv: string;
  let rowCount: number;
  try {
    const r = await buildOrdersCsv({ status, user_id: userId, from, to });
    csv = r.csv;
    rowCount = r.rowCount;
  } catch (err) {
    translateRangeError(err);
  }

  await tx(async (client) => {
    await writeAdminAudit(client, {
      adminId: admin.id,
      action: "orders.export_csv",
      target: userId ? `user:${userId}` : status ? `status:${status}` : "all",
      after: {
        rows: rowCount,
        filter: {
          status: status ?? null,
          user_id: userId ?? null,
          from: from ?? null,
          to: to ?? null,
        },
      },
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
    });
  });

  const filename = csvFilename("orders");
  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Content-Length": Buffer.byteLength(csv, "utf-8"),
    "Cache-Control": "no-store",
  });
  res.end(csv);
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

// ════════════════════════════════════════════════════════════════════
// V3 Phase 4H — system_settings(超管运行时开关)
// ════════════════════════════════════════════════════════════════════

function serializeSetting(row: SystemSettingRow): Record<string, unknown> {
  return {
    key: row.key,
    value: row.value,
    description: row.description,
    updated_at: row.updated_at,
    updated_by: row.updated_by,
    is_default: row.is_default,
    meta: KEY_META[row.key],
  };
}

function extractTailKey(url: URL, prefix: string): SystemSettingKey {
  // 路径段可能被前端编码,先 decode 再过 allowlist;decodeURIComponent 在
  // malformed % 序列时会抛 URIError → 当 400 处理。
  const rawTail = url.pathname.slice(prefix.length);
  let tail: string;
  try {
    tail = decodeURIComponent(rawTail);
  } catch {
    throw new HttpError(400, "VALIDATION", `malformed setting key: ${rawTail || "<empty>"}`, {
      issues: [{ path: "key", message: "malformed_uri_component" }],
    });
  }
  if (!(ALLOWED_KEYS as readonly string[]).includes(tail)) {
    // 未知 key 当输入校验失败处理,与 systemSettings.ts 模块文档一致("一律 400")。
    throw new HttpError(400, "VALIDATION", `unknown setting key: ${tail || "<empty>"}`, {
      issues: [{ path: "key", message: "not_in_allowlist" }],
    });
  }
  return tail as SystemSettingKey;
}

// ─── GET /api/admin/settings ──────────────────────────────────────
//
// 列全部 allowlist key 的当前值(行不存在 → DEFAULTS,is_default=true)。
export async function handleAdminListSettings(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const rows = await listSystemSettings();
  sendJson(res, 200, { rows: rows.map(serializeSetting) });
}

// ─── GET /api/admin/settings/:key ─────────────────────────────────

export async function handleAdminGetSetting(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const key = extractTailKey(url, "/api/admin/settings/");
  try {
    const row = await getSystemSetting(key);
    sendJson(res, 200, { setting: serializeSetting(row) });
  } catch (err) {
    if (err instanceof SystemSettingNotFoundError) {
      // 理论上 extractTailKey 已挡住未知 key,这里兜底:与 allowlist 失败一致 400。
      throw new HttpError(400, "VALIDATION", err.message, {
        issues: [{ path: "key", message: "not_in_allowlist" }],
      });
    }
    throw err;
  }
}

// ─── PUT /api/admin/settings/:key ─────────────────────────────────
//
// body: { value: <type-by-key>, description?: string | null }
export async function handleAdminPutSetting(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const key = extractTailKey(url, "/api/admin/settings/");

  const body = (await readJsonBody(req)) ?? {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "VALIDATION", "request body must be JSON object");
  }
  const b = body as Record<string, unknown>;
  if (!("value" in b)) {
    throw new HttpError(400, "VALIDATION", "value is required", {
      issues: [{ path: "value", message: "missing" }],
    });
  }
  let description: string | null | undefined;
  if (b.description !== undefined) {
    if (b.description !== null && typeof b.description !== "string") {
      throw new HttpError(400, "VALIDATION", "description must be string or null", {
        issues: [{ path: "description", message: String(b.description) }],
      });
    }
    description = b.description;
  }

  try {
    const row = await setSystemSetting(key, b.value, {
      adminId: admin.id,
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
      description,
    });
    sendJson(res, 200, { setting: serializeSetting(row) });
  } catch (err) {
    if (err instanceof SystemSettingNotFoundError) {
      // 理论上 extractTailKey 已挡住未知 key,这里兜底:与 allowlist 失败一致 400。
      throw new HttpError(400, "VALIDATION", err.message, {
        issues: [{ path: "key", message: "not_in_allowlist" }],
      });
    }
    if (err instanceof SystemSettingValidationError) {
      throw new HttpError(400, "VALIDATION", err.message, {
        issues: err.issues.map((m) => ({ path: "value", message: m })),
      });
    }
    throw err;
  }
}

// ─── /api/admin/orders (P0-3 订单管理) ────────────────────────────

const ORDERS_MAX_LIMIT = 200;

function parseOrderStatus(raw: string | null): OrderStatus | undefined {
  if (raw === null || raw === "") return undefined;
  if (!(ORDER_STATUSES as readonly string[]).includes(raw)) {
    throw new HttpError(400, "VALIDATION", "invalid status", {
      issues: [{ path: "status", message: raw }],
    });
  }
  return raw as OrderStatus;
}

// PG BIGINT 上限 = 9223372036854775807 (19 digits)。正则放到 20 位,溢出靠 BigInt 比较拦截。
const BIGINT_MAX = 9223372036854775807n;
function parseBigintIdParam(raw: string | null, name: string): string | undefined {
  if (raw === null || raw === "") return undefined;
  if (!/^[1-9][0-9]{0,19}$/.test(raw)) {
    throw new HttpError(400, "VALIDATION", `invalid ${name}`, {
      issues: [{ path: name, message: raw }],
    });
  }
  if (BigInt(raw) > BIGINT_MAX) {
    throw new HttpError(400, "VALIDATION", `${name} out of range`, {
      issues: [{ path: name, message: raw }],
    });
  }
  return raw;
}

function parseUserId(raw: string | null): string | undefined {
  return parseBigintIdParam(raw, "user_id");
}

function parseIsoTimestamp(raw: string | null, name: string): string | undefined {
  if (raw === null || raw === "") return undefined;
  // 简单校验:Date 解析得出来即可。多余格式由 PG ::timestamptz 兜底。
  if (Number.isNaN(Date.parse(raw))) {
    throw new HttpError(400, "VALIDATION", `${name} must be ISO timestamp`, {
      issues: [{ path: name, message: raw }],
    });
  }
  return raw;
}

function serializeOrderRow(row: OrderRowView): Record<string, unknown> {
  return {
    id: row.id,
    order_no: row.order_no,
    user_id: row.user_id,
    username: row.username,
    provider: row.provider,
    provider_order: row.provider_order,
    amount_cents: row.amount_cents,
    credits: row.credits,
    status: row.status,
    paid_at: row.paid_at?.toISOString() ?? null,
    expires_at: row.expires_at.toISOString(),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function serializeOrderDetail(row: OrderDetailView): Record<string, unknown> {
  return {
    ...serializeOrderRow(row),
    callback_payload: row.callback_payload,
    ledger_id: row.ledger_id,
    refunded_ledger_id: row.refunded_ledger_id,
  };
}

function serializeOrdersKpi(k: OrdersKpiView): Record<string, unknown> {
  return {
    pending_overdue: k.pending_overdue,
    pending_overdue_24h: k.pending_overdue_24h,
    callback_conflicts_24h: k.callback_conflicts_24h,
    paid_24h_count: k.paid_24h_count,
    paid_24h_amount_cents: k.paid_24h_amount_cents,
  };
}

export async function handleAdminListOrders(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const status = parseOrderStatus(url.searchParams.get("status"));
  const userId = parseUserId(url.searchParams.get("user_id"));
  const from = parseIsoTimestamp(url.searchParams.get("from"), "from");
  const to = parseIsoTimestamp(url.searchParams.get("to"), "to");
  const beforeCreatedAt = parseIsoTimestamp(url.searchParams.get("before_created_at"), "before_created_at");
  const beforeId = parseBigintIdParam(url.searchParams.get("before_id"), "before_id");
  const limit = parsePositiveInt(url.searchParams.get("limit"), "limit", ORDERS_MAX_LIMIT);
  const r = await listOrders({
    status,
    user_id: userId,
    from,
    to,
    before_created_at: beforeCreatedAt,
    before_id: beforeId,
    limit,
  });
  sendJson(res, 200, {
    rows: r.rows.map(serializeOrderRow),
    next_before_created_at: r.next_before_created_at,
    next_before_id: r.next_before_id,
  });
}

export async function handleAdminOrdersKpi(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const k = await getOrdersKpi();
  sendJson(res, 200, { kpi: serializeOrdersKpi(k) });
}

export async function handleAdminGetOrder(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const tail = url.pathname.slice("/api/admin/orders/".length);
  // order_no 是 hupijiao 拼出来的字符串;现行实现是 yyyymmdd-uid-uuid 风格,
  // 但 hupijiao 也能传来自定义。这里宽松校验:非空、长度 ≤ 64、ASCII 安全字符。
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(tail)) {
    throw new HttpError(400, "VALIDATION", "invalid order_no", {
      issues: [{ path: "order_no", message: tail }],
    });
  }
  const row = await getOrderDetail(tail);
  if (!row) {
    throw new HttpError(404, "ORDER_NOT_FOUND", "order not found");
  }
  sendJson(res, 200, { order: serializeOrderDetail(row) });
}

// ─── /api/admin/feedback (P1-2 反馈管理) ──────────────────────────

const FEEDBACK_MAX_LIMIT = 200;
const FEEDBACK_STATUSES = ["open", "acked", "closed"] as const;
type FeedbackStatusFilter = (typeof FEEDBACK_STATUSES)[number];

function parseFeedbackStatus(raw: string | null): FeedbackStatusFilter | undefined {
  if (raw === null || raw === "") return undefined;
  if (!(FEEDBACK_STATUSES as readonly string[]).includes(raw)) {
    throw new HttpError(400, "VALIDATION", "invalid status", {
      issues: [{ path: "status", message: raw }],
    });
  }
  return raw as FeedbackStatusFilter;
}

function serializeFeedbackRow(row: FeedbackRowView): Record<string, unknown> {
  return {
    id: row.id,
    user_id: row.user_id,
    username: row.username,
    category: row.category,
    description: row.description,
    request_id: row.request_id,
    version: row.version,
    session_id: row.session_id,
    user_agent: row.user_agent,
    meta: row.meta,
    status: row.status,
    handled_by: row.handled_by,
    handled_at: row.handled_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
  };
}

export async function handleAdminListFeedback(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const status = parseFeedbackStatus(url.searchParams.get("status"));
  const userId = parseUserId(url.searchParams.get("user_id"));
  const beforeCreatedAt = parseIsoTimestamp(url.searchParams.get("before_created_at"), "before_created_at");
  const beforeId = parseBigintIdParam(url.searchParams.get("before_id"), "before_id");
  const limit = parsePositiveInt(url.searchParams.get("limit"), "limit", FEEDBACK_MAX_LIMIT);
  const r = await listFeedback({
    status,
    user_id: userId,
    before_created_at: beforeCreatedAt,
    before_id: beforeId,
    limit,
  });
  sendJson(res, 200, {
    rows: r.rows.map(serializeFeedbackRow),
    next_before_created_at: r.next_before_created_at,
    next_before_id: r.next_before_id,
  });
}

export async function handleAdminAckFeedback(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  // 写操作 + 改 status + 写 audit:用 DB double-check
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  // /api/admin/feedback/:id/ack → 抠 :id
  const m = url.pathname.match(/^\/api\/admin\/feedback\/([^/]+)\/ack$/);
  if (!m) {
    throw new HttpError(400, "VALIDATION", "invalid feedback id in URL", {
      issues: [{ path: "id", message: url.pathname }],
    });
  }
  // 走统一的 BIGINT 范围校验,超 9223372036854775807 直接 400 而非 DB 500
  const id = parseBigintIdParam(m[1], "id");
  if (!id) {
    throw new HttpError(400, "VALIDATION", "invalid feedback id in URL", {
      issues: [{ path: "id", message: m[1] }],
    });
  }
  try {
    const row = await ackFeedback(id, {
      adminId: admin.id,
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
    });
    sendJson(res, 200, { feedback: serializeFeedbackRow(row) });
  } catch (err) {
    if (err instanceof FeedbackNotFoundError) {
      throw new HttpError(404, "FEEDBACK_NOT_FOUND", err.message);
    }
    throw err;
  }
}

// ─── /api/admin/messages — 站内信(in-app inbox)admin 侧 ──────────────
//
// 鉴权:
//   GET  /api/admin/messages          → requireAdmin   (只读 JWT-only)
//   POST /api/admin/messages          → requireAdminVerifyDb(写,DB 双校验)
//   DELETE /api/admin/messages/:id    → requireAdminVerifyDb(写,DB 双校验)
//
// 审计:create / delete 成功后 best-effort writeAdminAudit
//   action='inbox.create' / 'inbox.delete';target=`message:${id}`;
//   before/after 含消息 snapshot(audience/title/level/user_id/expires_at)。
//   audit 失败不阻断响应,与 accounts.ts / agent-containers.logs 同语义。

function serializeAdminInboxMessage(
  m: import("../inbox/inbox.js").InboxMessage,
): Record<string, unknown> {
  return {
    id: m.id,
    audience: m.audience,
    user_id: m.user_id,
    title: m.title,
    body_md: m.body_md,
    level: m.level,
    created_by: m.created_by,
    created_at: m.created_at,
    expires_at: m.expires_at,
  };
}

/** audit 用的精简 snapshot —— 不写 body_md(可能 16KB)。 */
function inboxAuditSnapshot(
  m: import("../inbox/inbox.js").InboxMessage,
): Record<string, unknown> {
  return {
    id: m.id,
    audience: m.audience,
    user_id: m.user_id,
    title: m.title,
    level: m.level,
    expires_at: m.expires_at,
    created_at: m.created_at,
  };
}

export async function handleAdminCreateInbox(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const body = (await readJsonBody(req)) ?? {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "VALIDATION", "request body must be JSON object");
  }
  const { createInboxMessage, InboxError } = await import("../inbox/inbox.js");
  let created: import("../inbox/inbox.js").InboxMessage;
  try {
    created = await createInboxMessage(admin.id, body);
  } catch (err) {
    if (err instanceof InboxError) {
      if (err.code === "VALIDATION") {
        // 把 zod issues 拍平成 HttpError issues({ path, message })
        const det = err.details as { issues?: Array<{ path?: unknown; message?: unknown }> } | undefined;
        const issues = (det?.issues ?? []).map((i) => ({
          path: Array.isArray(i.path) ? i.path.join(".") : String(i.path ?? ""),
          message: typeof i.message === "string" ? i.message : String(i.message ?? ""),
        }));
        throw new HttpError(400, "VALIDATION", err.message, { issues });
      }
      if (err.code === "USER_NOT_FOUND") {
        throw new HttpError(404, "USER_NOT_FOUND", err.message);
      }
    }
    throw err;
  }
  // best-effort audit
  try {
    await writeAdminAudit(getPool(), {
      adminId: admin.id,
      action: "inbox.create",
      target: `message:${created.id}`,
      before: null,
      after: inboxAuditSnapshot(created),
      ip: ctx.clientIp ?? null,
      userAgent: ctx.userAgent ?? null,
    });
  } catch { /* best-effort */ }
  sendJson(res, 201, { message: serializeAdminInboxMessage(created) });
}

export async function handleAdminListInbox(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const sp = url.searchParams;
  const limit = parsePositiveInt(sp.get("limit"), "limit", 100);
  const offset = parseNonNegativeInt(sp.get("offset"), "offset");
  const { adminListInbox } = await import("../inbox/inbox.js");
  const r = await adminListInbox({ limit, offset });
  sendJson(res, 200, {
    messages: r.messages.map((m) => ({
      ...serializeAdminInboxMessage(m),
      read_count: m.read_count,
      recipients: m.recipients,
    })),
    total: r.total,
  });
}

export async function handleAdminDeleteInbox(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const id = extractTailId(url, "/api/admin/messages/");
  const { adminDeleteInbox, InboxError } = await import("../inbox/inbox.js");
  let deleted: import("../inbox/inbox.js").InboxMessage;
  try {
    deleted = await adminDeleteInbox(id);
  } catch (err) {
    if (err instanceof InboxError && err.code === "NOT_FOUND") {
      throw new HttpError(404, "NOT_FOUND", err.message);
    }
    throw err;
  }
  try {
    await writeAdminAudit(getPool(), {
      adminId: admin.id,
      action: "inbox.delete",
      target: `message:${deleted.id}`,
      before: inboxAuditSnapshot(deleted),
      after: null,
      ip: ctx.clientIp ?? null,
      userAgent: ctx.userAgent ?? null,
    });
  } catch { /* best-effort */ }
  sendJson(res, 200, { deleted: true });
}

// ─── /api/admin/users/:id/model-grants —— per-user 模型授权 (0049) ──────
//
// 路径分发同 /api/admin/users/:id/credits 的风格(共用 /api/admin/users/ prefix
// 在 router.ts dispatch,这里 handler 自抽 :id 与可选 :model_id 子段)。
// 三个动作:
//   GET    /api/admin/users/:id/model-grants            → 列出该 user 已授权列表
//   POST   /api/admin/users/:id/model-grants            → body { model_id } 添加
//   DELETE /api/admin/users/:id/model-grants/:model_id  → 撤销
//
// 全部走 requireAdminVerifyDb(写路径 + GET 也强 DB 校验,grants 信息能间接暴露
// 哪些用户被开通了内部模型,Read-too 走严格路线避免被降权 admin 用 24h 旧 token 偷看)。

const USER_MODEL_GRANTS_LIST_RE =
  /^\/api\/admin\/users\/([1-9][0-9]{0,19})\/model-grants$/;
const USER_MODEL_GRANTS_ITEM_RE =
  /^\/api\/admin\/users\/([1-9][0-9]{0,19})\/model-grants\/([A-Za-z0-9._-]{1,64})$/;

function matchUserModelGrantsList(url: URL): { userId: string } | null {
  const m = USER_MODEL_GRANTS_LIST_RE.exec(url.pathname);
  return m ? { userId: m[1] } : null;
}

function matchUserModelGrantsItem(url: URL): { userId: string; modelId: string } | null {
  const m = USER_MODEL_GRANTS_ITEM_RE.exec(url.pathname);
  return m ? { userId: m[1], modelId: m[2] } : null;
}

export async function handleAdminListUserModelGrants(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const m = matchUserModelGrantsList(url);
  if (!m) throw new HttpError(404, "NOT_FOUND", "endpoint not found");
  const { listGrantsForUser } = await import("../admin/modelGrants.js");
  const rows = await listGrantsForUser(m.userId);
  sendJson(res, 200, {
    rows: rows.map((r) => ({
      user_id: r.user_id,
      model_id: r.model_id,
      granted_at: r.granted_at.toISOString(),
      granted_by: r.granted_by,
    })),
  });
}

export async function handleAdminAddUserModelGrant(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const m = matchUserModelGrantsList(url);
  if (!m) throw new HttpError(404, "NOT_FOUND", "endpoint not found");

  const body = (await readJsonBody(req)) ?? {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "VALIDATION", "request body must be JSON object");
  }
  const b = body as Record<string, unknown>;
  if (typeof b.model_id !== "string") {
    throw new HttpError(400, "VALIDATION", "model_id must be string");
  }

  const {
    addGrant,
    GrantInvalidInputError,
    GrantUserNotFoundError,
    GrantModelNotFoundError,
  } = await import("../admin/modelGrants.js");
  try {
    const out = await addGrant(m.userId, b.model_id, {
      adminId: admin.id,
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
    });
    sendJson(res, out.inserted ? 201 : 200, {
      inserted: out.inserted,
      grant: {
        user_id: out.row.user_id,
        model_id: out.row.model_id,
        granted_at: out.row.granted_at.toISOString(),
        granted_by: out.row.granted_by,
      },
    });
  } catch (err) {
    if (err instanceof GrantInvalidInputError) {
      throw new HttpError(400, "VALIDATION", `invalid ${err.message.replace(/^invalid_/, "")}`, {
        issues: [{ path: err.message.replace(/^invalid_/, ""), message: err.message }],
      });
    }
    if (err instanceof GrantUserNotFoundError) {
      throw new HttpError(404, "NOT_FOUND", "user not found");
    }
    if (err instanceof GrantModelNotFoundError) {
      throw new HttpError(404, "NOT_FOUND", "model not found");
    }
    throw err;
  }
}

export async function handleAdminRemoveUserModelGrant(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const m = matchUserModelGrantsItem(url);
  if (!m) throw new HttpError(404, "NOT_FOUND", "endpoint not found");

  const { removeGrant, GrantInvalidInputError } = await import(
    "../admin/modelGrants.js"
  );
  try {
    const out = await removeGrant(m.userId, m.modelId, {
      adminId: admin.id,
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
    });
    sendJson(res, 200, { deleted: out.deleted });
  } catch (err) {
    if (err instanceof GrantInvalidInputError) {
      throw new HttpError(400, "VALIDATION", `invalid ${err.message.replace(/^invalid_/, "")}`, {
        issues: [{ path: err.message.replace(/^invalid_/, ""), message: err.message }],
      });
    }
    throw err;
  }
}

// ════════════════════════════════════════════════════════════════════
// V3 — Egress Proxy Pool(决策 P/Q/R + migration 0052/0053)
// ════════════════════════════════════════════════════════════════════
//
// 五个端点:
//   GET    /api/admin/egress-proxies              list (status filter, pagination)
//   POST   /api/admin/egress-proxies              create (label + url + status?, notes?)
//   GET    /api/admin/egress-proxies/:id          get one (URL masked)
//   PATCH  /api/admin/egress-proxies/:id          patch label/url/status/notes
//   DELETE /api/admin/egress-proxies/:id          delete; 被绑账号 → 409 PROXY_IN_USE (0055)
//
// 鉴权:读 requireAdmin,写 requireAdminVerifyDb(同 accounts 模块)。
// 返回 url_masked 而非明文/密文(决策 R 安全规约)。

function serializeEgressProxy(r: import("../admin/egressProxies.js").EgressProxyRow): Record<string, unknown> {
  return {
    id: r.id.toString(),
    label: r.label,
    status: r.status,
    notes: r.notes,
    url_masked: r.url_masked,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  };
}

export async function handleAdminListEgressProxies(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const sp = url.searchParams;
  const statusRaw = sp.get("status");
  let status: "active" | "disabled" | undefined;
  if (statusRaw === null || statusRaw === "" || statusRaw === "all") status = undefined;
  else if (statusRaw === "active" || statusRaw === "disabled") status = statusRaw;
  else throw new HttpError(400, "VALIDATION", "status must be active/disabled/all");
  const limit = parsePositiveInt(sp.get("limit"), "limit", 500);
  const offset = parseNonNegativeInt(sp.get("offset"), "offset");
  const { listEgressProxies } = await import("../admin/egressProxies.js");
  try {
    const rows = await listEgressProxies({ status, limit, offset });
    sendJson(res, 200, { rows: rows.map(serializeEgressProxy) });
  } catch (err) { translateRangeError(err); }
}

export async function handleAdminGetEgressProxy(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const id = extractTailId(url, "/api/admin/egress-proxies/");
  const { getEgressProxy } = await import("../admin/egressProxies.js");
  const r = await getEgressProxy(id);
  if (!r) throw new HttpError(404, "NOT_FOUND", "egress proxy not found");
  sendJson(res, 200, { row: serializeEgressProxy(r) });
}

export async function handleAdminCreateEgressProxy(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const body = (await readJsonBody(req)) ?? {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "VALIDATION", "request body must be JSON object");
  }
  const b = body as Record<string, unknown>;
  if (typeof b.label !== "string") throw new HttpError(400, "VALIDATION", "label is required");
  if (typeof b.url !== "string") throw new HttpError(400, "VALIDATION", "url is required");
  const input: import("../admin/egressProxies.js").CreateEgressProxyInput = {
    label: b.label,
    url: b.url,
  };
  if (b.status !== undefined) {
    if (b.status !== "active" && b.status !== "disabled") {
      throw new HttpError(400, "VALIDATION", "status must be active or disabled");
    }
    input.status = b.status;
  }
  if (b.notes !== undefined) {
    if (b.notes !== null && typeof b.notes !== "string") {
      throw new HttpError(400, "VALIDATION", "notes must be string or null");
    }
    input.notes = b.notes;
  }
  const { createEgressProxy, EgressProxyLabelTakenError } = await import(
    "../admin/egressProxies.js"
  );
  try {
    const r = await createEgressProxy(input, {
      adminId: admin.id, ip: ctx.clientIp, userAgent: ctx.userAgent,
    });
    sendJson(res, 201, { row: serializeEgressProxy(r) });
  } catch (err) {
    if (err instanceof EgressProxyLabelTakenError) {
      throw new HttpError(409, err.code, err.message);
    }
    if (err instanceof RangeError) translateRangeError(err);
    throw err;
  }
}

export async function handleAdminPatchEgressProxy(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const id = extractTailId(url, "/api/admin/egress-proxies/");
  const body = (await readJsonBody(req)) ?? {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "VALIDATION", "request body must be JSON object");
  }
  const b = body as Record<string, unknown>;
  const patch: import("../admin/egressProxies.js").PatchEgressProxyInput = {};
  if (b.label !== undefined) {
    if (typeof b.label !== "string") throw new HttpError(400, "VALIDATION", "label must be string");
    patch.label = b.label;
  }
  if (b.url !== undefined) {
    if (typeof b.url !== "string") throw new HttpError(400, "VALIDATION", "url must be string");
    patch.url = b.url;
  }
  if (b.status !== undefined) {
    if (b.status !== "active" && b.status !== "disabled") {
      throw new HttpError(400, "VALIDATION", "status must be active or disabled");
    }
    patch.status = b.status;
  }
  if (b.notes !== undefined) {
    if (b.notes !== null && typeof b.notes !== "string") {
      throw new HttpError(400, "VALIDATION", "notes must be string or null");
    }
    patch.notes = b.notes;
  }
  const { patchEgressProxy, EgressProxyNotFoundError, EgressProxyLabelTakenError } = await import(
    "../admin/egressProxies.js"
  );
  try {
    const r = await patchEgressProxy(id, patch, {
      adminId: admin.id, ip: ctx.clientIp, userAgent: ctx.userAgent,
    });
    sendJson(res, 200, { row: serializeEgressProxy(r) });
  } catch (err) {
    if (err instanceof EgressProxyNotFoundError) throw new HttpError(404, "NOT_FOUND", err.message);
    if (err instanceof EgressProxyLabelTakenError) throw new HttpError(409, err.code, err.message);
    if (err instanceof RangeError) translateRangeError(err);
    throw err;
  }
}

export async function handleAdminDeleteEgressProxy(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const id = extractTailId(url, "/api/admin/egress-proxies/");
  const { deleteEgressProxy, EgressProxyInUseError } = await import("../admin/egressProxies.js");
  try {
    const out = await deleteEgressProxy(id, {
      adminId: admin.id, ip: ctx.clientIp, userAgent: ctx.userAgent,
    });
    if (!out.deleted) throw new HttpError(404, "NOT_FOUND", "egress proxy not found");
    sendJson(res, 200, { deleted: true });
  } catch (err) {
    if (err instanceof EgressProxyInUseError) {
      // 0055 — admin 必须先把绑定的账号迁到其他池条目再删。
      // issues 字段把绑定数 surface 到前端 toast,避免 admin 盲目重试。
      throw new HttpError(409, err.code, err.message, {
        issues: [{ path: "bound_account_count", message: String(err.boundAccountCount) }],
      });
    }
    throw err;
  }
}
