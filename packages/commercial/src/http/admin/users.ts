/**
 * /api/admin/users — Users 资源 HTTP handler。
 *
 * S3 拆分自 http/admin.ts。承载内容:
 *   - parseUserFunnelFilters — Users 列表 + CSV 共用 funnel/registered_within 过滤
 *   - serializeUser / serializeUserWithStats / serializeUserDetail(私有)
 *   - USER_DETAIL_RE(私有)
 *   - handleAdminListUsers / handleAdminUsersStats / handleAdminGetUser /
 *     handleAdminPatchUser / handleAdminAdjustCredits(5 个 export handler)
 *
 * 内部 dispatch 耦合(plan §3.2):
 *   handleAdminGetUser     → matchUserModelGrantsList + handleAdminListUserModelGrants
 *   handleAdminAdjustCredits → matchUserModelGrantsList + handleAdminAddUserModelGrant
 * 这两 handler 把 /api/admin/users/:id/model-grants 子路径优先派发到
 * modelGrants.ts。users → modelGrants 单向依赖,不形成 ESM cycle。
 *
 * 函数体 / 正则字面量逐字节等价(plan §1.2 + §4.5 mechanical byte-equal):
 *   - parseUserFunnelFilters / serializeUser / serializeUserWithStats /
 *     serializeUserDetail / handleAdminListUsers / handleAdminUsersStats /
 *     handleAdminGetUser / handleAdminPatchUser / handleAdminAdjustCredits
 *     函数体相对 HEAD admin.ts 完全一致
 *   - 路径 substitution:`../admin/...` → `../../admin/...`,`../billing/...`
 *     → `../../billing/...`(本文件深一层)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, sendJson, readJsonBody } from "../util.js";
import { requireAdmin, requireAdminVerifyDb } from "../../admin/requireAdmin.js";
import type { CommercialHttpDeps, RequestContext } from "../handlers.js";
import {
  listUsers,
  listUsersWithStats,
  getUser,
  getUserDetail,
  patchUser,
  UserNotFoundError,
  type PatchUserInput,
  type AdminUserRowView,
  type AdminUserWithStatsRowView,
  type AdminUserDetailResult,
  type RegisteredWithin,
  type FunnelState,
  USER_STATUSES,
  USER_ROLES,
  REGISTERED_WITHIN_VALUES,
  FUNNEL_STATES,
} from "../../admin/users.js";
import { getUsersStats } from "../../admin/usersStats.js";
import { adminAdjust, InsufficientCreditsError } from "../../billing/ledger.js";
import {
  parsePositiveInt,
  parseNonNegativeInt,
  extractTailId,
  translateRangeError,
} from "./_shared.js";
import {
  matchUserModelGrantsList,
  handleAdminListUserModelGrants,
  handleAdminAddUserModelGrant,
} from "./modelGrants.js";

/**
 * Phase B:Users 列表 + CSV 共用 — 解析 registered_within / funnel_state。
 * 提到 helper 是因为这两参 List 接口 + CSV 接口都要传,把校验逻辑收一处避免漂移。
 */
export function parseUserFunnelFilters(sp: URLSearchParams): {
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
