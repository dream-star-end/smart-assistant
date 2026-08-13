/**
 * /api/admin/accounts/* — 账号池管理(列表/详情/创建/修改/删除/cooldown 重置/
 * OAuth 双步 / refresh-events / recent-users)。10 个 export handler,1 个
 * 私有 helper handler(handleAccountRecentUsers,由 handleAdminGetAccount 子
 * dispatch),2 个私有序列化/查询 helper(serializeAccount + fetchEgressProxyLabels)。
 *
 * 鉴权约定(同 admin.ts 顶部统一规则):
 *   - **读**(List/Stats/Get/RefreshEvents):requireAdmin(JWT-only)
 *   - **写**(Create/Patch/Delete/ResetCooldown/OAuthExchange):requireAdminVerifyDb
 *     — 防降权 admin 用 24h 旧 token 改账号池状态(2026-04-21 安全审计 Medium#5)
 *   - OAuthStart 是读路径(只生成 authUrl/state,不写库),requireAdmin
 *
 * S3 拆分自 http/admin.ts。serializer/handler 函数体逐字节等价
 * (plan §1.2 + §4.5 mechanical byte-equal gate)。
 *
 * 跨文件依赖:
 *   - serializeAccount / fetchEgressProxyLabels 私有,仅本文件 4 个 handler 使用
 *   - handleAccountRecentUsers 私有,作为 handleAdminGetAccount 的子 dispatcher
 *   - 10 个 handler 全部 router.ts 直挂(过渡期通过 admin.ts barrel re-export,
 *     §6.2 终局 router.ts 改 import 直指本文件)
 *
 * 路径替换(plan §4.5 path 规则):本文件比 admin.ts 深一层,所有相对路径
 * 加一层 `../`(./util.js → ../util.js,../admin/X → ../../admin/X)。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, sendJson, readJsonBody } from "../util.js";
import { requireAdmin, requireAdminVerifyDb } from "../../admin/requireAdmin.js";
import { writeAdminAuditBestEffort } from "../../admin/audit.js";
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
} from "../../admin/accounts.js";
import {
  getAccountsPoolStats,
  getAccountsTodayStats,
} from "../../admin/accountsStats.js";
import {
  startAccountOAuth,
  exchangeAccountOAuth,
  OAuthExchangeError,
  type OAuthProvider,
} from "../../admin/oauth.js";
import { AccountNotFoundError, type AccountRow } from "../../account-pool/store.js";
import { getEgressProxyUrlPlaintext } from "../../admin/egressProxies.js";
import {
  cancelGrokDeviceAuth,
  getGrokDeviceAuthStatus,
  startGrokDeviceAuth,
} from "../../admin/grokDeviceAuth.js";
import {
  listRefreshEvents,
  MAX_LIST_LIMIT as REFRESH_EVENTS_MAX_LIMIT,
  DEFAULT_LIST_LIMIT as REFRESH_EVENTS_DEFAULT_LIMIT,
} from "../../account-pool/refreshEvents.js";
import { getPool } from "../../db/index.js";
import type { CommercialHttpDeps, RequestContext } from "../handlers.js";
import {
  parsePositiveInt,
  parseNonNegativeInt,
  translateRangeError,
  extractTailId,
} from "./_shared.js";

function serializeAccount(
  a: AccountRow,
  poolLabels?: Map<string, string>,
): Record<string, unknown> {
  const epid = a.egress_proxy_id !== null ? a.egress_proxy_id.toString() : null;
  return {
    id: a.id.toString(),
    /** V3 provider:'claude' | 'codex'(0051)。决定 admin UI tab + 容器内 auth 路径。 */
    provider: a.provider,
    group_id: a.group_id !== null ? a.group_id.toString() : null,
    label: a.label,
    plan: a.plan,
    status: a.status,
    health_score: a.health_score,
    cooldown_until: a.cooldown_until?.toISOString() ?? null,
    oauth_expires_at: a.oauth_expires_at?.toISOString() ?? null,
    /** 0064 — 管理员手填的订阅周期到期日;scheduler WRH 权重因子之一。NULL 中性。 */
    subscription_end_at: a.subscription_end_at?.toISOString() ?? null,
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
  let providerFilter: AccountRow["provider"] | undefined;
  if (providerRaw === null || providerRaw === "" || providerRaw === "all") {
    providerFilter = undefined;
  } else if (providerRaw === "claude" || providerRaw === "codex" || providerRaw === "grok") {
    providerFilter = providerRaw;
  } else {
    throw new HttpError(400, "VALIDATION", "provider must be claude/codex/grok/all");
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
  let provider: AdminCreateAccountInput["provider"];
  if (b.provider !== undefined) {
    if (b.provider === "claude" || b.provider === "codex" || b.provider === "grok") provider = b.provider;
    else throw new HttpError(400, "VALIDATION", "provider must be 'claude', 'codex', or 'grok'");
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
  if (b.group_id !== undefined) {
    if (b.group_id !== null && typeof b.group_id !== "string" && typeof b.group_id !== "number") {
      throw new HttpError(400, "VALIDATION", "group_id must be string, number, or null");
    }
    input.group_id = b.group_id === null ? null : String(b.group_id);
  }
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
  if (b.oauth_principal_type !== undefined || b.oauth_principal_id !== undefined) {
    if (
      (b.oauth_principal_type !== null && typeof b.oauth_principal_type !== "string") ||
      (b.oauth_principal_id !== null && typeof b.oauth_principal_id !== "string")
    ) {
      throw new HttpError(400, "VALIDATION", "oauth principal fields must be strings or null");
    }
    input.oauth_principal_type = b.oauth_principal_type as string | null | undefined;
    input.oauth_principal_id = b.oauth_principal_id as string | null | undefined;
  }
  if (b.subscription_end_at !== undefined) {
    if (b.subscription_end_at !== null && typeof b.subscription_end_at !== "string") {
      throw new HttpError(400, "VALIDATION", "subscription_end_at must be ISO string or null");
    }
    input.subscription_end_at = b.subscription_end_at as string | null;
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
  if (b.subscription_end_at !== undefined) {
    if (b.subscription_end_at !== null && typeof b.subscription_end_at !== "string") {
      throw new HttpError(400, "VALIDATION", "subscription_end_at must be ISO string or null");
    }
    patch.subscription_end_at = b.subscription_end_at as string | null;
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
  if (b.group_id !== undefined) {
    if (b.group_id !== null && typeof b.group_id !== "string" && typeof b.group_id !== "number") {
      throw new HttpError(400, "VALIDATION", "group_id must be string, number, or null");
    }
    patch.group_id = b.group_id === null ? null : String(b.group_id);
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
      adminId: admin.id,
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
      // v1.0.120 feat/codex-disable-rebind:codex provider 从 active 转为
      // disabled 时,主动 fanout rebind 仍绑该账号的活跃容器。adminPatchAccount
      // 内部按 (provider==='codex' && before.active && patch.disabled) 严格筛。
      triggerCodexDisableFanout: deps.triggerCodexDisableFanout,
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
// status='cooldown' 时把账号恢复到 active+health=50,清 cooldown_until +
// last_error;其他 status 只清 cooldown_until + last_error(详见 accounts.ts)。
export async function handleAdminResetAccountCooldown(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  if (!deps.accountHealth) {
    throw new HttpError(503, "ACCOUNT_HEALTH_NOT_CONFIGURED", "accountHealth not injected");
  }
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  // URL 形如 /api/admin/accounts/:id/reset-cooldown;把 ":id" 抠出来
  const m = url.pathname.match(/^\/api\/admin\/accounts\/([1-9][0-9]{0,19})\/reset-cooldown$/);
  if (!m) throw new HttpError(400, "VALIDATION", "invalid account id");
  const id = m[1];
  try {
    const a = await adminResetCooldown(id, {
      adminId: admin.id, ip: ctx.clientIp, userAgent: ctx.userAgent,
    }, deps.accountHealth);
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
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  // 写路径:返回可落库的 anthropic OAuth token,后续 adminCreateAccount 真正入库。
  // 虽然 exchange 本身不写 DB,但它是账号创建链路里必经的"换 token"动作,保持
  // 与写族一致的 requireAdminVerifyDb 鉴权防降权 admin 重用旧 JWT 建账号。
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
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
    // 换 token 成功留痕:严禁写入 code/state/access_token/refresh_token,只记元信息
    // (哪个 provider、拿到什么 scope、到期时间),满足账号绑定链路的可审计要求。
    await writeAdminAuditBestEffort(
      { adminId: admin.id, ip: ctx.clientIp, userAgent: ctx.userAgent },
      "oauth.exchange",
      `oauth:${r.provider}`,
      undefined,
      { provider: r.provider, scope: r.scope, expires_at: r.expires_at },
    );
    sendJson(res, 200, r);
  } catch (err) {
    if (err instanceof OAuthExchangeError) {
      throw new HttpError(err.status, "OAUTH_FAILED", err.message);
    }
    throw err;
  }
}

function grokDeviceSessionId(req: IncomingMessage): string {
  const parsed = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const prefix = "/api/admin/accounts/grok-device/";
  const id = parsed.pathname.startsWith(prefix) ? parsed.pathname.slice(prefix.length) : "";
  if (!/^[0-9a-f]{32}$/.test(id)) throw new HttpError(400, "VALIDATION", "invalid Grok device session id");
  return id;
}

export async function handleAdminGrokDeviceStart(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdminVerifyDb(req, deps.jwtSecret);
  const body = (await readJsonBody(req)) ?? {};
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "VALIDATION", "request body must be JSON object");
  }
  const proxyId = (body as Record<string, unknown>).egress_proxy_id;
  if ((typeof proxyId !== "string" && typeof proxyId !== "number") || !/^[1-9][0-9]{0,19}$/.test(String(proxyId))) {
    throw new HttpError(400, "VALIDATION", "egress_proxy_id is required");
  }
  const proxyUrl = await getEgressProxyUrlPlaintext(String(proxyId));
  if (!proxyUrl) throw new HttpError(400, "VALIDATION", "egress proxy must exist and be active");
  try {
    sendJson(res, 200, await startGrokDeviceAuth({ proxyUrl }));
  } catch (err) {
    const code = err instanceof Error ? err.message : "GROK_DEVICE_AUTH_FAILED";
    throw new HttpError(503, "OAUTH_FAILED", code);
  }
}

export async function handleAdminGrokDeviceStatus(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdminVerifyDb(req, deps.jwtSecret);
  const status = getGrokDeviceAuthStatus(grokDeviceSessionId(req));
  if (!status) throw new HttpError(404, "NOT_FOUND", "Grok device session not found");
  sendJson(res, 200, status);
}

export async function handleAdminGrokDeviceCancel(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdminVerifyDb(req, deps.jwtSecret);
  const removed = cancelGrokDeviceAuth(grokDeviceSessionId(req));
  if (!removed) throw new HttpError(404, "NOT_FOUND", "Grok device session not found");
  sendJson(res, 200, { ok: true });
}
