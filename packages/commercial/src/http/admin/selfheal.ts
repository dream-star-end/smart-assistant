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
  getReleaseRequest,
  getReleaseFuse,
  clearReleaseFuse,
  getUserNoticeApprovalState,
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
    if (r.outcome === "deploy_in_progress") {
      // 批1b F8:release 部署在途,禁手动 resolve(与 deployed/deploy_failed receipt 竞态)。
      throw new HttpError(409, "DEPLOY_IN_PROGRESS", "release deploy in progress; cannot resolve now");
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

// ─── POST /api/admin/selfheal/repairs/:id/release(批1b:202 异步)────────

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
    const raw = (await readJsonBody(req)) as { expectedPendingReleaseEventId?: unknown };
    if (typeof raw?.expectedPendingReleaseEventId !== "string") {
      throw new HttpError(400, "VALIDATION", "expectedPendingReleaseEventId is required");
    }
    const r = await adminReleaseRepair(m[1], {
      adminId: admin.id,
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
      expectedPendingReleaseEventId: raw.expectedPendingReleaseEventId,
    });
    if (r.outcome === "not_found") throw new HttpError(404, "NOT_FOUND", "repair not found");
    if (r.outcome === "malformed") {
      throw new HttpError(
        400,
        "PENDING_RELEASE_MALFORMED",
        r.reason ?? "pending_release event detail malformed",
      );
    }
    if (r.outcome === "conflict") {
      throw new HttpError(409, "CONFLICT", r.reason ?? "repair is not pending release");
    }
    if (r.outcome === "fuse_engaged") {
      throw new HttpError(423, "RELEASE_FUSE_ENGAGED", r.reason ?? "release fuse engaged");
    }
    // New request is 202; an exact source-event retry recovers the one existing
    // logical request (including a terminal one) with 200.
    sendJson(
      res,
      r.outcome === "existing" ? 200 : 202,
      { ok: true, releaseRequestId: r.releaseRequestId, status: r.status ?? "queued" },
      { Location: `/api/admin/selfheal/release-requests/${r.releaseRequestId}` },
    );
  } catch (err) {
    translateRangeError(err);
  }
}

/** router prefix 派发(POST /api/admin/selfheal/repairs/:id/release)。 */
export const SELFHEAL_REPAIRS_ADMIN_PREFIX = "/api/admin/selfheal/repairs/";

// ─── GET /api/admin/selfheal/release-requests/:rrid(批1b)────────────────

const RELEASE_REQUEST_RE = /^\/api\/admin\/selfheal\/release-requests\/([A-Za-z0-9_-]{1,128})$/;

export async function handleAdminGetReleaseRequest(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  _deps: CommercialHttpDeps,
): Promise<void> {
  const m = RELEASE_REQUEST_RE.exec(pathOf(req));
  if (!m) throw new HttpError(400, "VALIDATION", "invalid releaseRequestId in URL");
  try {
    const detail = await getReleaseRequest(m[1]);
    if (!detail) throw new HttpError(404, "NOT_FOUND", "release request not found");
    sendJson(res, 200, detail);
  } catch (err) {
    translateRangeError(err);
  }
}

/** router prefix 派发(GET /api/admin/selfheal/release-requests/:rrid)。 */
export const SELFHEAL_RELEASE_REQUESTS_PREFIX = "/api/admin/selfheal/release-requests/";

// ─── GET /api/admin/selfheal/release-fuse ; POST …/release-fuse/clear(批1b)──

export async function handleAdminGetReleaseFuse(
  _req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  _deps: CommercialHttpDeps,
): Promise<void> {
  sendJson(res, 200, await getReleaseFuse());
}

export async function handleAdminClearReleaseFuse(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdmin(req, deps.jwtSecret);
  const raw = (await readJsonBody(req).catch(() => ({}))) as {
    reason?: unknown;
    expectedReleaseRequestId?: unknown;
  };
  if (typeof raw.expectedReleaseRequestId !== "string") {
    throw new HttpError(400, "VALIDATION", "expectedReleaseRequestId is required");
  }
  const reason =
    typeof raw?.reason === "string" && raw.reason.trim().length > 0
      ? raw.reason.trim().slice(0, 500)
      : null;
  const r = await clearReleaseFuse({
    adminId: admin.id,
    ip: ctx.clientIp,
    userAgent: ctx.userAgent,
    reason,
    expectedReleaseRequestId: raw.expectedReleaseRequestId,
  });
  if (r.outcome === "not_engaged") {
    throw new HttpError(409, "NOT_ENGAGED", "release fuse is not engaged");
  }
  if (r.outcome === "generation_mismatch") {
    throw new HttpError(409, "FUSE_GENERATION_MISMATCH", "release fuse generation changed");
  }
  sendJson(res, 200, {
    cleared: true,
    outcome: r.outcome,
    releaseRequestId: r.releaseRequestId,
    clearedAt: r.clearedAt,
    remainingReleaseRequestId: r.remainingReleaseRequestId,
  });
}


// ─── GET /api/admin/selfheal/user-notices ──────────────────────────

export async function handleAdminGetSelfhealUserNotices(
  _req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  _deps: CommercialHttpDeps,
): Promise<void> {
  sendJson(res, 200, await getUserNoticeApprovalState());
}
