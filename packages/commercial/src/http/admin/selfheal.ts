/**
 * /api/admin/selfheal/* — v5 自愈事故/修复审计只读 + admin 手动 resolve/压制运维/一键放行。
 *
 * 薄壳(照 http/admin/audit.ts 模式):鉴权由 router 全局 admin gate(requireAdminVerifyDb)
 * 自动施加;handler 只解析入参 + 调 admin/selfhealOps.ts + 序列化。detail 经 redaction。
 *
 *   GET  /api/admin/selfheal/incidents            列表(keyset:status/limit/before)
 *   GET  /api/admin/selfheal/incidents/:id        详情(incident + repairs + repair_events,脱敏)
 *   POST /api/admin/selfheal/incidents/:id/resolve 手动 resolve(tx:mode-aware 处置 condition
 *        + resolve + audit;响应带 resolution ∈ suppressed_until_clear/condition_closed/
 *        condition_already_clear,前端据此区分 toast)
 *   GET  /api/admin/selfheal/conditions[?suppressed=1]  condition 当前值(压制区块)
 *   POST /api/admin/selfheal/conditions/unsuppress {conditionKey}  解除误压(audit tx)
 *   POST /api/admin/selfheal/repairs/:id/release  一键放行 pending_release 部署(audit tx)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson, readJsonBody, HttpError } from "../util.js";
import { requireAdmin } from "../../admin/requireAdmin.js";
import type { CommercialHttpDeps, RequestContext } from "../handlers.js";
import { parsePositiveInt, translateRangeError } from "./_shared.js";
import {
  listIncidents,
  getIncidentDetail,
  adminResolveIncident,
  listConditions,
  adminUnsuppressCondition,
  adminReleaseRepair,
  INCIDENTS_MAX_LIMIT,
} from "../../admin/selfhealOps.js";

function sp(req: IncomingMessage): URLSearchParams {
  return new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`).searchParams;
}
function optional(v: string | null): string | undefined {
  return v === null || v === "" ? undefined : v;
}
function pathOf(req: IncomingMessage): string {
  return new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`).pathname;
}

const PREFIX = "/api/admin/selfheal/incidents/";
const RESOLVE_RE = /^\/api\/admin\/selfheal\/incidents\/([1-9][0-9]{0,19})\/resolve$/;
const DETAIL_RE = /^\/api\/admin\/selfheal\/incidents\/([1-9][0-9]{0,19})$/;

// ─── GET /api/admin/selfheal/incidents ─────────────────────────────

export async function handleAdminListIncidents(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  _deps: CommercialHttpDeps,
): Promise<void> {
  const p = sp(req);
  const limit = parsePositiveInt(p.get("limit"), "limit", INCIDENTS_MAX_LIMIT);
  try {
    const r = await listIncidents({
      status: optional(p.get("status")),
      before: optional(p.get("before")),
      limit,
    });
    sendJson(res, 200, { rows: r.rows, next_before: r.next_before });
  } catch (err) {
    translateRangeError(err);
  }
}

// ─── GET /api/admin/selfheal/incidents/:id ─────────────────────────

export async function handleAdminGetIncident(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  _deps: CommercialHttpDeps,
): Promise<void> {
  const m = DETAIL_RE.exec(pathOf(req));
  if (!m) throw new HttpError(400, "VALIDATION", "invalid incident id in URL");
  try {
    const detail = await getIncidentDetail(m[1]);
    if (!detail) throw new HttpError(404, "NOT_FOUND", "incident not found");
    sendJson(res, 200, detail);
  } catch (err) {
    translateRangeError(err);
  }
}

// ─── POST /api/admin/selfheal/incidents/:id/resolve ────────────────

export async function handleAdminResolveIncident(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const path = pathOf(req);
  const m = RESOLVE_RE.exec(path);
  if (!m) {
    // /api/admin/selfheal/incidents/ 下的其他 POST 形态 → 404,不向非法路径泄露语义。
    throw new HttpError(404, "NOT_FOUND", "endpoint not found");
  }
  // 全局 gate 已过 requireAdminVerifyDb;此处 requireAdmin 只为取 admin 身份(JWT,无额外 DB)。
  const admin = await requireAdmin(req, deps.jwtSecret);
  try {
    const r = await adminResolveIncident(m[1], {
      adminId: admin.id,
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
    });
    if (r.outcome === "not_found") throw new HttpError(404, "NOT_FOUND", "incident not found");
    if (r.outcome === "already_resolved") {
      throw new HttpError(409, "ALREADY_RESOLVED", "incident already resolved");
    }
    sendJson(res, 200, { resolved: true, rev: r.rev, resolution: r.resolution });
  } catch (err) {
    translateRangeError(err);
  }
}

/** router prefix 派发:GET → 详情;POST → resolve。exact list 由独立 exact route 命中。 */
export const SELFHEAL_INCIDENTS_PREFIX = PREFIX;

// ─── GET /api/admin/selfheal/conditions[?suppressed=1] ─────────────

export async function handleAdminListSelfhealConditions(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  _deps: CommercialHttpDeps,
): Promise<void> {
  const p = sp(req);
  const suppressedOnly = p.get("suppressed") === "1" || p.get("suppressed") === "true";
  const r = await listConditions({ suppressedOnly });
  sendJson(res, 200, { rows: r.rows });
}

// ─── POST /api/admin/selfheal/conditions/unsuppress {conditionKey} ──

export async function handleAdminUnsuppressCondition(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdmin(req, deps.jwtSecret);
  const raw = (await readJsonBody(req)) as { conditionKey?: unknown };
  const conditionKey = typeof raw?.conditionKey === "string" ? raw.conditionKey.trim() : "";
  if (conditionKey.length === 0 || conditionKey.length > 512) {
    throw new HttpError(400, "VALIDATION", "conditionKey required (string, ≤512 chars)");
  }
  try {
    const r = await adminUnsuppressCondition(conditionKey, {
      adminId: admin.id,
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
    });
    if (r.outcome === "not_found") throw new HttpError(404, "NOT_FOUND", "condition not found");
    if (r.outcome === "not_suppressed") {
      throw new HttpError(409, "NOT_SUPPRESSED", "condition is not suppressed");
    }
    sendJson(res, 200, { unsuppressed: true, conditionKey });
  } catch (err) {
    translateRangeError(err);
  }
}

// ─── POST /api/admin/selfheal/repairs/:id/release ───────────────────

const RELEASE_RE = /^\/api\/admin\/selfheal\/repairs\/([1-9][0-9]{0,19})\/release$/;

export async function handleAdminReleaseRepair(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const m = RELEASE_RE.exec(pathOf(req));
  if (!m) {
    // /api/admin/selfheal/repairs/ 下其他 POST 形态 → 404,不向非法路径泄露语义。
    throw new HttpError(404, "NOT_FOUND", "endpoint not found");
  }
  const admin = await requireAdmin(req, deps.jwtSecret);
  try {
    const r = await adminReleaseRepair(m[1], {
      adminId: admin.id,
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
    });
    if (r.outcome === "not_found") throw new HttpError(404, "NOT_FOUND", "repair not found");
    if (r.outcome === "conflict") {
      throw new HttpError(409, "CONFLICT", r.reason ?? "repair is not pending release");
    }
    if (r.outcome === "failed") {
      // BLOCKER1:含"个人版 2xx 但部署未完成/被拒/失败"——reason 带个人版 status/detail,
      // 如实透传给 admin UI;claim 已清,可重试。
      throw new HttpError(
        502,
        "RELEASE_FAILED",
        r.reason ?? "personal-side release failed; retry later",
      );
    }
    sendJson(res, 200, { released: true, repairId: m[1] });
  } catch (err) {
    translateRangeError(err);
  }
}

/** router prefix 派发(POST /api/admin/selfheal/repairs/:id/release)。 */
export const SELFHEAL_REPAIRS_ADMIN_PREFIX = "/api/admin/selfheal/repairs/";
