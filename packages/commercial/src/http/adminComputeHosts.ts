/**
 * V3 D.3 — /api/admin/v3/compute-hosts/* HTTP handlers。
 *
 * 路由:
 *   GET  /api/admin/v3/compute-hosts                       列表
 *   POST /api/admin/v3/compute-hosts/add                   新增 + 异步 bootstrap
 *   GET  /api/admin/v3/compute-hosts/:id/bootstrap-log     bootstrap 进度
 *   POST /api/admin/v3/compute-hosts/:id/drain             进入 draining
 *   POST /api/admin/v3/compute-hosts/:id/remove            删除(仅 draining + active=0)
 *   POST /api/admin/v3/compute-hosts/:id/quarantine-clear  quarantined → ready
 *   POST /api/admin/v3/compute-hosts/:id/expires-at        更新 VPS 到期时间(0041)
 *   GET  /api/admin/v3/baseline-version                    master + 每 host baseline 版本
 *
 * 鉴权:全部 requireAdminVerifyDb(JWT + DB 双校验)。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  HttpError,
  clientIpOf,
  readJsonBody,
  sendJson,
  userAgentOf,
} from "./util.js";
import type { CommercialHttpDeps, RequestContext } from "./handlers.js";
import { requireAdminVerifyDb } from "../admin/requireAdmin.js";
import type { AdminAuditCtx } from "../admin/accounts.js";
import {
  listComputeHostsForAdmin,
  createComputeHost,
  getBootstrapLog,
  drainComputeHost,
  removeComputeHost,
  clearQuarantineForHost,
  updateComputeHostExpiresAt,
  getBaselineVersions,
  adminDistributeImageToAllHosts,
  adminDistributeImageToHost,
} from "../admin/computeHosts.js";
import { listContainers } from "../admin/containers.js";
import { serializeContainer } from "./admin.js";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** 从 prefix 后抽 :id(UUID)+ 剩余 suffix。非法 → 404。 */
function extractIdAndAction(path: string, prefix: string): { id: string; action: string } {
  if (!path.startsWith(prefix)) {
    throw new HttpError(404, "NOT_FOUND", "endpoint not found");
  }
  const rest = path.slice(prefix.length);
  const parts = rest.split("/");
  const id = parts[0] ?? "";
  if (!UUID_RE.test(id)) {
    throw new HttpError(404, "NOT_FOUND", "endpoint not found");
  }
  const action = parts.slice(1).join("/"); // 可能是 "drain" / "bootstrap-log" / ""
  return { id, action };
}

function auditCtxOf(
  req: IncomingMessage,
  ctx: RequestContext,
  adminId: bigint | number | string,
): AdminAuditCtx {
  return {
    adminId,
    ip: ctx.clientIp ?? clientIpOf(req),
    userAgent: userAgentOf(req),
  };
}

// ─── handlers ─────────────────────────────────────────────────────

export async function handleAdminListComputeHosts(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdminVerifyDb(req, deps.jwtSecret);
  const hosts = await listComputeHostsForAdmin();
  sendJson(res, 200, { hosts });
}

export async function handleAdminAddComputeHost(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const body = (await readJsonBody(req)) ?? {};
  const result = await createComputeHost(body, auditCtxOf(req, ctx, admin.id));
  sendJson(res, 201, result);
}

/**
 * GET prefix handler for `/api/admin/v3/compute-hosts/:id/<sub>`。
 * 因 router 走 prefix 一个 GET handler 接所有 /:id/* 路径,此处 switch action。
 *
 * 当前覆盖:
 *   - bootstrap-log → 进度日志
 *   - containers    → 该 host 上的 agent_containers 列表(deeplink 跳转用)
 *
 * 旧函数名 handleAdminComputeHostBootstrapLog 已重命名,router.ts 的引用同步更新。
 */
export async function handleAdminComputeHostGetSubresource(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const { id, action } = extractIdAndAction(url.pathname, "/api/admin/v3/compute-hosts/");
  switch (action) {
    case "bootstrap-log": {
      const log = await getBootstrapLog(id);
      sendJson(res, 200, log);
      return;
    }
    case "containers": {
      const rows = await listContainers({ host_uuid: id });
      sendJson(res, 200, { rows: rows.map(serializeContainer) });
      return;
    }
    default:
      throw new HttpError(404, "NOT_FOUND", "endpoint not found");
  }
}

export async function handleAdminComputeHostAction(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const { id, action } = extractIdAndAction(url.pathname, "/api/admin/v3/compute-hosts/");
  const auditCtx = auditCtxOf(req, ctx, admin.id);
  switch (action) {
    case "drain":
      await drainComputeHost(id, auditCtx);
      sendJson(res, 200, { id, status: "draining" });
      return;
    case "remove":
      await removeComputeHost(id, auditCtx);
      sendJson(res, 200, { id, removed: true });
      return;
    case "quarantine-clear":
      await clearQuarantineForHost(id, auditCtx);
      sendJson(res, 200, { id, status: "ready" });
      return;
    case "distribute-image": {
      // 同步等待 stream 完成。3.5GB 慢链路最长约 30 分钟,前端/反代 timeout 要够长。
      // 本处不做异步 task — 商用版当前规模 host 数 <10,sync 直接返回 per-host 结果
      // 比加 task queue 简单。
      const result = await adminDistributeImageToHost(id, auditCtx);
      sendJson(res, 200, { id, result });
      return;
    }
    case "expires-at": {
      // 0041:更新 VPS 租期。body { expires_at: ISO8601-tz | null }。
      // 成功返 204 No Content(前端拿到后直接 _loadHostsData 刷新)。
      const body = (await readJsonBody(req)) ?? {};
      await updateComputeHostExpiresAt(id, body, auditCtx);
      res.statusCode = 204;
      res.setHeader("Cache-Control", "no-store");
      res.end();
      return;
    }
    default:
      throw new HttpError(404, "NOT_FOUND", "endpoint not found");
  }
}

/**
 * POST /api/admin/v3/distribute-image — 把 OC_RUNTIME_IMAGE 推到所有 ready host。
 * 同步等待全部完成,返回 per-host 结果数组。
 *
 * 运维 build-image.sh 之后 curl 一次,把新 image 摊到全集群,避免靠用户调度时
 * docker auto-pull 失败再走 ImageNotFound 5min retry。
 *
 * 0 ready host → 200 + 空数组(明确告知 noop,而非 404 / 412)。
 */
export async function handleAdminDistributeImageToAllHosts(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const auditCtx = auditCtxOf(req, ctx, admin.id);
  const results = await adminDistributeImageToAllHosts(auditCtx);
  sendJson(res, 200, { results });
}

export async function handleAdminBaselineVersion(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdminVerifyDb(req, deps.jwtSecret);
  const view = await getBaselineVersions();
  sendJson(res, 200, view);
}
