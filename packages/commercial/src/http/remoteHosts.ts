/**
 * /api/remote-hosts 路由 handlers —— FEATURE_REMOTE_SSH 灰度。
 *
 * 端点:
 *   GET    /api/remote-hosts
 *   POST   /api/remote-hosts
 *   GET    /api/remote-hosts/:id
 *   PATCH  /api/remote-hosts/:id
 *   DELETE /api/remote-hosts/:id
 *   POST   /api/remote-hosts/:id/test
 *   POST   /api/remote-hosts/:id/reset-fingerprint
 *
 * 所有端点 require user auth(requireAuth → 401),并且 user-scoped:
 * 不可能访问到别人的 host(queries.ts 层在 SQL 里也兜底 user_id = $1)。
 *
 * feature flag OFF 时所有端点返 503 FEATURE_DISABLED,与 agent_runtime 缺失时
 * `/api/agent/open` 返 503 的模式对齐。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, readJsonBody, sendJson } from "./util.js";
import { requireAuth } from "./auth.js";
import type { CommercialHttpDeps, RequestContext } from "./handlers.js";
import {
  createHostForUser,
  deleteHostForUser,
  getHostForUser,
  listHostsForUser,
  resetFingerprintForUser,
  testHostForUser,
  updateHostForUser,
  RemoteHostError,
  type RemoteHostTester,
} from "../remoteHosts/service.js";

/**
 * gateway 装配时传进来 —— `remoteSshEnabled` 是 feature flag,`remoteHostTester`
 * 是真正做 SSH 探测的回调(由 ControlMaster 模块提供,见 task #3)。
 */
export interface RemoteHostsHttpDeps {
  remoteSshEnabled?: boolean;
  remoteHostTester?: RemoteHostTester;
}

export type CommercialHttpDepsWithRemoteHosts = CommercialHttpDeps & RemoteHostsHttpDeps;

// ─── helpers ───────────────────────────────────────────────────────────────

function assertEnabled(deps: RemoteHostsHttpDeps): void {
  if (!deps.remoteSshEnabled) {
    throw new HttpError(503, "FEATURE_DISABLED", "remote ssh feature is disabled");
  }
}

/** 映射业务错 → HTTP。供所有 handler 共用。 */
function mapServiceError(err: unknown): never {
  if (err instanceof RemoteHostError) {
    const statusMap: Record<string, number> = {
      VALIDATION: 400,
      NOT_FOUND: 404,
      CONFLICT: 409,
      INTERNAL: 500,
    };
    const status = statusMap[err.code] ?? 500;
    throw new HttpError(status, err.code, err.message, { issues: err.issues });
  }
  throw err;
}

/**
 * 从 path 抽 UUID host id。同时做 shape 校验(uuid v4/v7 都匹配 36 char + 分隔)。
 * 非法格式 → 404(不是 400:我们不对外暴露"这条路由有 :id 参数"的语义)。
 */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
function extractHostId(path: string, prefix: string): string {
  const rest = path.slice(prefix.length);
  // rest 形如 "<uuid>" 或 "<uuid>/subresource"
  const id = rest.split("/")[0] ?? "";
  if (!UUID_RE.test(id)) {
    throw new HttpError(404, "NOT_FOUND", "endpoint not found");
  }
  return id;
}

// ─── handlers ──────────────────────────────────────────────────────────────

export async function handleListRemoteHosts(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDepsWithRemoteHosts,
): Promise<void> {
  assertEnabled(deps);
  const user = await requireAuth(req, deps.jwtSecret);
  const hosts = await listHostsForUser(user.id);
  sendJson(res, 200, { hosts });
}

export async function handleCreateRemoteHost(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDepsWithRemoteHosts,
): Promise<void> {
  assertEnabled(deps);
  const user = await requireAuth(req, deps.jwtSecret);
  const body = await readJsonBody(req);
  try {
    const host = await createHostForUser(user.id, body);
    sendJson(res, 201, { host });
  } catch (err) {
    mapServiceError(err);
  }
}

/**
 * GET /api/remote-hosts/:id —— 同时也是 PATCH/DELETE/POST 的 prefix fallback
 * entrypoint。由 router 按 method 派发,handler 自己只处理 GET。
 */
export async function handleGetRemoteHost(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDepsWithRemoteHosts,
): Promise<void> {
  assertEnabled(deps);
  const user = await requireAuth(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const hostId = extractHostId(url.pathname, "/api/remote-hosts/");
  try {
    const host = await getHostForUser(user.id, hostId);
    sendJson(res, 200, { host });
  } catch (err) {
    mapServiceError(err);
  }
}

export async function handlePatchRemoteHost(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDepsWithRemoteHosts,
): Promise<void> {
  assertEnabled(deps);
  const user = await requireAuth(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const hostId = extractHostId(url.pathname, "/api/remote-hosts/");
  const body = await readJsonBody(req);
  try {
    const host = await updateHostForUser(user.id, hostId, body);
    sendJson(res, 200, { host });
  } catch (err) {
    mapServiceError(err);
  }
}

export async function handleDeleteRemoteHost(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDepsWithRemoteHosts,
): Promise<void> {
  assertEnabled(deps);
  const user = await requireAuth(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const hostId = extractHostId(url.pathname, "/api/remote-hosts/");
  try {
    await deleteHostForUser(user.id, hostId);
    sendJson(res, 200, { deleted: true });
  } catch (err) {
    mapServiceError(err);
  }
}

/**
 * POST /api/remote-hosts/:id/test
 * POST /api/remote-hosts/:id/reset-fingerprint
 *
 * 同一 prefix 下 POST,handler 自己用 suffix 区分。router 只注册一个
 * `POST pathPrefix: /api/remote-hosts/`。
 */
export async function handleRemoteHostAction(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDepsWithRemoteHosts,
): Promise<void> {
  assertEnabled(deps);
  const user = await requireAuth(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const hostId = extractHostId(url.pathname, "/api/remote-hosts/");

  const rest = url.pathname.slice("/api/remote-hosts/".length);
  const parts = rest.split("/");
  const action = parts[1] ?? "";

  if (action === "test") {
    if (!deps.remoteHostTester) {
      throw new HttpError(503, "TESTER_NOT_CONFIGURED", "ssh tester not available");
    }
    try {
      const { host, result } = await testHostForUser(user.id, hostId, deps.remoteHostTester);
      sendJson(res, 200, {
        host,
        test: { ok: result.ok, error: result.error ?? null },
      });
      return;
    } catch (err) {
      mapServiceError(err);
    }
  }

  if (action === "reset-fingerprint") {
    try {
      const host = await resetFingerprintForUser(user.id, hostId);
      sendJson(res, 200, { host });
      return;
    } catch (err) {
      mapServiceError(err);
    }
  }

  throw new HttpError(404, "NOT_FOUND", "endpoint not found");
}
