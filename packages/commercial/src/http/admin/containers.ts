/**
 * /api/admin/agent-containers — 容器池管理(P0 admin 容器面板)。
 *
 * 4 个 handler:
 *   GET  /api/admin/agent-containers                 list (status/limit/offset/host_uuid)
 *   GET  /api/admin/agent-containers/stats           KPI(R4 pool stats)
 *   GET  /api/admin/agent-containers/:id/logs?lines=N
 *   POST /api/admin/agent-containers/:id/{restart,stop,remove}
 *
 * 鉴权:list/stats requireAdmin;logs/action requireAdminVerifyDb
 * (敏感读 + 写,需 DB 双校验防降权 admin 在 JWT TTL 内继续操作)。
 *
 * S3 拆分自 http/admin.ts。serializer/helper/handler 函数体逐字节等价
 * (plan §1.2 + §4.5 mechanical byte-equal gate)。
 *
 * 出口约定:
 *   - serializeContainer:**export**(adminComputeHosts.ts host-pinned containers
 *     list 也用这个 shape;过渡期通过 admin.ts 的 barrel re-export 保持
 *     adminComputeHosts.ts 不动,终局 §6.2 改 import 直指本文件)
 *   - 4 handler:export(router 调用)
 *   - HOST_UUID_RE / ContainerAction / parseContainerActionUrl:私有
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type Docker from "dockerode";
import { HttpError, sendJson } from "../util.js";
import { requireAdmin, requireAdminVerifyDb } from "../../admin/requireAdmin.js";
import { writeAdminAudit } from "../../admin/audit.js";
import { getPool } from "../../db/index.js";
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
} from "../../admin/containers.js";
import { getContainersPoolStats } from "../../admin/containersStats.js";
import { SupervisorError } from "../../agent-sandbox/types.js";
import type { CommercialHttpDeps, RequestContext } from "../handlers.js";
import { parsePositiveInt, parseNonNegativeInt, translateRangeError } from "./_shared.js";

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

const HOST_UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * admin 容器操作(logs/restart/stop/remove)的 docker 句柄解析 —— v5 收口(2026-07-10)。
 *
 * 历史 bug:handler 把 `deps.agentRuntime` 当硬门(只为拿 dockerode 句柄),v3 master 上
 * 它恒存在所以从未暴露;v5 master 有意不装配 agentRuntime(healthz agentRuntime:disabled,
 * 容器面走 v3Supervisor),导致 v5 管理后台 重启/停止/删除/日志 全部 503 AGENT_NOT_READY。
 * 门槛设错了对象:v3/v5 行的实际执行路径只走 v3Supervisor dispatch,agent.docker 仅
 * v2 老行使用,而两套运行时的 docker 指向同一个 dockerd。
 *
 * 解析序:agentRuntime.docker(v2 遗留,存在则优先,保持 v3 master 行为不变)??
 * v3Supervisor.docker(v5 按需容器面)。两者皆缺 → null,调用方 503。
 */
export function resolveAdminDockerHandle(
  deps: Pick<CommercialHttpDeps, "agentRuntime" | "v3Supervisor">,
): Docker | null {
  return deps.agentRuntime?.docker ?? deps.v3Supervisor?.docker ?? null;
}

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
  const docker = resolveAdminDockerHandle(deps);
  if (!docker) {
    throw new HttpError(503, "AGENT_NOT_READY", "container runtime is not configured");
  }
  try {
    const logs = await adminContainerLogs(id, docker, lines, deps.v3Supervisor);
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
  const docker = resolveAdminDockerHandle(deps);
  if (!docker) {
    throw new HttpError(503, "AGENT_NOT_READY", "container runtime is not configured");
  }
  const auditCtx = { adminId: admin.id, ip: ctx.clientIp, userAgent: ctx.userAgent };
  // HIGH#6:v3 行(docker_name=NULL)经 v3Supervisor dispatch;v2 行走老路径。
  // v3Supervisor 未注入(OC_RUNTIME_IMAGE 没配)且行是 v3 → 抛 V3SupervisorMissingError → 503。
  const v3Supervisor = deps.v3Supervisor;
  try {
    if (action === "restart") await adminRestartContainer(id, docker, auditCtx, v3Supervisor);
    else if (action === "stop") await adminStopContainer(id, docker, auditCtx, v3Supervisor);
    else await adminRemoveContainer(id, docker, auditCtx, v3Supervisor);
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
