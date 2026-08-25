/**
 * /api/admin/egress-proxies — Egress Proxy Pool admin 侧(决策 P/Q/R + migration 0052/0053)。
 *
 * 五个端点:
 *   GET    /api/admin/egress-proxies              list (status filter, pagination)
 *   POST   /api/admin/egress-proxies              create (label + url + status?, notes?)
 *   GET    /api/admin/egress-proxies/:id          get one (URL masked)
 *   PATCH  /api/admin/egress-proxies/:id          patch label/url/status/notes
 *   DELETE /api/admin/egress-proxies/:id          delete; 被绑账号 → 409 PROXY_IN_USE (0055)
 *
 * 鉴权:读 requireAdmin,写 requireAdminVerifyDb(同 accounts 模块)。
 * 返回 url_masked 而非明文/密文(决策 R 安全规约)。
 *
 * S3 拆分自 http/admin.ts。serializer/handler 函数体逐字节等价
 * (plan §1.2 + §4.5 mechanical byte-equal gate;inline 动态 import 的
 *  "../admin/egressProxies.js" 在新文件里改为 "../../admin/egressProxies.js"
 *  属允许的相对路径补偿)。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, sendJson, readJsonBody } from "../util.js";
import { requireAdmin, requireAdminVerifyDb } from "../../admin/requireAdmin.js";
import type { CommercialHttpDeps, RequestContext } from "../handlers.js";
import {
  parsePositiveInt,
  parseNonNegativeInt,
  translateRangeError,
  extractTailId,
} from "./_shared.js";

function serializeEgressProxy(r: import("../../admin/egressProxies.js").EgressProxyRow): Record<string, unknown> {
  return {
    id: r.id.toString(),
    label: r.label,
    status: r.status,
    notes: r.notes,
    region: r.region,
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
  const { listEgressProxies } = await import("../../admin/egressProxies.js");
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
  const { getEgressProxy } = await import("../../admin/egressProxies.js");
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
  const input: import("../../admin/egressProxies.js").CreateEgressProxyInput = {
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
  if (b.region !== undefined) {
    if (b.region !== null && typeof b.region !== "string") {
      throw new HttpError(400, "VALIDATION", "region must be string or null");
    }
    input.region = b.region;
  }
  const { createEgressProxy, EgressProxyLabelTakenError } = await import(
    "../../admin/egressProxies.js"
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
  const patch: import("../../admin/egressProxies.js").PatchEgressProxyInput = {};
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
  if (b.region !== undefined) {
    if (b.region !== null && typeof b.region !== "string") {
      throw new HttpError(400, "VALIDATION", "region must be string or null");
    }
    patch.region = b.region;
  }
  const { patchEgressProxy, EgressProxyNotFoundError, EgressProxyLabelTakenError } = await import(
    "../../admin/egressProxies.js"
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
  const { deleteEgressProxy, EgressProxyInUseError } = await import("../../admin/egressProxies.js");
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
