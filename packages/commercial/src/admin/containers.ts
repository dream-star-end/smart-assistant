/**
 * T-60 — 超管 agent_containers 管理。
 *
 * ### 查询
 * listContainers:纯 DB 读(含用户 email + 订阅状态),用于 admin 面板观察。
 *   - 不去 inspect docker(昂贵且可能阻塞)—— DB 的 status 已经由 lifecycle 维护
 *   - 如果要看 docker 实时状态,管 admin 自己点 "restart" 之类触发一次 lifecycle
 *
 * ### 写操作 — 2026-04-21 安全审计 HIGH#6
 * 行有两套来源:
 *   - **v2 行**(老 agent-runtime,长期订阅):docker_name 非空,走
 *     `supervisor.stopContainer / removeContainer / docker.restart`
 *   - **v3 行**(0012 起 ephemeral per-user openclaude-runtime):docker_name=NULL,
 *     使用 container_internal_id 走 `stopAndRemoveV3Container`(stop+remove,
 *     row 标 vanished;volume 由 GC 单独管,见 v3volumeGc)
 *
 * v3 ephemeral 模型 → restart/stop/remove 三个 admin 动作语义合并为同一个
 * "stop+remove":
 *   - **restart**:vanish 当前容器,下次用户 ws 连接 ensureRunning 自动 reprovision
 *     新容器(volume 数据保留)。一次切换 + 一次冷启代价
 *   - **stop / remove**:vanish 当前容器(volume 保留)
 * 三者在 v3 行为一致是有意为之 —— v3 没有"stopped 持久态",ephemeral 模型
 * 里 stop = remove,admin UI 给三个按钮也无所谓,我们都接住。
 *
 * v3 dispatch 需要 V3SupervisorDeps 注入(`v3Supervisor` 字段);未注入时
 * 对 v3 行会抛 `V3SupervisorMissingError` → http 层翻 503 给 admin,
 * 文案明确(env OC_RUNTIME_IMAGE 没配 / gateway 启动时 v3 路径关闭)。
 *
 * ### 不更新 status 字段
 * - 不更新 agent_containers.status —— v2 lifecycle tick / v3 idle sweep 会
 *   把 DB 状态 reconcile 回来(避免 admin 面板和 lifecycle 同时写同一字段引起抖动)
 * - 都写 admin_audit(best-effort,同 accounts.ts 的策略)
 *
 * ### 幂等
 * supervisor.stop / remove 都已幂等(未找到 → noop),所以 admin 多次点不会报错。
 * v3 stopAndRemoveV3Container 同样幂等(missing 容器吞掉,落 vanished)。
 * v2 restart 若容器不存在 → 透传 dockerode 404(管理员应该用"重新 provision"流程)。
 */

import type Docker from "dockerode";
import { getPool } from "../db/index.js";
import { query } from "../db/queries.js";
import {
  containerNameFor,
  removeContainer as supRemove,
  stopContainer as supStop,
} from "../agent-sandbox/supervisor.js";
import {
  stopAndRemoveV3Container,
  type V3SupervisorDeps,
} from "../agent-sandbox/v3supervisor.js";
import { writeAdminAudit } from "./audit.js";
import type { AdminAuditCtx } from "./accounts.js";
import { incrAdminAuditWriteFailure } from "./metrics.js";

export interface AdminContainerRowView {
  id: string;
  user_id: string;
  user_email: string | null;
  subscription_id: string;
  subscription_status: string | null;
  subscription_end_at: Date | null;
  docker_id: string | null;
  docker_name: string;
  workspace_volume: string;
  home_volume: string;
  image: string;
  /**
   * v2 lifecycle 字段;v3 行不维护这个,看 `state` / `lifecycle`。
   * 历史 v2 值:provisioning/running/stopped/removed/error。
   */
  status: string | null;
  /**
   * v3 lifecycle 字段(0012 起);v2 行不写这个。
   * 值:active/vanished。NULL 表示这是 v2 行。
   * codex round 1 finding #4 修复:之前 admin UI 只看 `status`,
   * 看不到 v3 行真状态。
   */
  state: string | null;
  /**
   * UI 渲染用的统一 lifecycle 字段:
   *   - v2 行(docker_name 非空) → 取 status
   *   - v3 行(docker_name=NULL) → 取 state
   * 由 SQL 直接 COALESCE 出来,前端无需再判类型。
   */
  lifecycle: string | null;
  /** 行类型,显式给 UI 区分 v2/v3 用。 */
  row_kind: "v2" | "v3";
  last_started_at: Date | null;
  last_stopped_at: Date | null;
  volume_gc_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

const CONTAINER_COLS = `
  c.id::text              AS id,
  c.user_id::text         AS user_id,
  u.email                 AS user_email,
  c.subscription_id::text AS subscription_id,
  s.status                AS subscription_status,
  s.end_at                AS subscription_end_at,
  c.docker_id,
  c.docker_name,
  c.workspace_volume,
  c.home_volume,
  c.image,
  c.status,
  c.state,
  -- v2 行用 status,v3 行用 state,UI 拿一个字段就够
  CASE
    WHEN COALESCE(NULLIF(c.docker_name, ''), '') = '' THEN c.state
    ELSE c.status
  END AS lifecycle,
  CASE
    WHEN COALESCE(NULLIF(c.docker_name, ''), '') = '' THEN 'v3'
    ELSE 'v2'
  END AS row_kind,
  c.last_started_at,
  c.last_stopped_at,
  c.volume_gc_at,
  c.last_error,
  c.created_at,
  c.updated_at
`;

export interface ListContainersInput {
  /** 可选:单值或数组 status(provisioning/running/stopped/removed/error) */
  status?: string | string[];
  limit?: number;
  offset?: number;
}

const CONTAINER_STATUSES = ["provisioning", "running", "stopped", "removed", "error"] as const;

export async function listContainers(input: ListContainersInput = {}): Promise<AdminContainerRowView[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (input.status !== undefined) {
    const arr = Array.isArray(input.status) ? input.status : [input.status];
    for (const s of arr) {
      if (!(CONTAINER_STATUSES as readonly string[]).includes(s)) {
        throw new RangeError("invalid_status");
      }
    }
    params.push(arr);
    where.push(`c.status = ANY($${params.length}::text[])`);
  }
  let limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit <= 0) limit = 50;
  if (limit > 500) limit = 500;
  let offset = input.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) offset = 0;
  params.push(limit);
  const limitIdx = params.length;
  params.push(offset);
  const offsetIdx = params.length;

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const r = await query<AdminContainerRowView>(
    `SELECT ${CONTAINER_COLS}
     FROM agent_containers c
     JOIN users u ON u.id = c.user_id
     LEFT JOIN agent_subscriptions s ON s.id = c.subscription_id
     ${whereClause}
     ORDER BY c.id DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params,
  );
  return r.rows;
}

export class ContainerNotFoundError extends Error {
  constructor(id: bigint | string) { super(`agent_container not found: ${String(id)}`); this.name = "ContainerNotFoundError"; }
}

/**
 * v3 行(docker_name=NULL)需要 V3SupervisorDeps 才能 stop+remove。caller 没注入
 * (生产 OC_RUNTIME_IMAGE 没配 / gateway 启动时跳过 v3 路径) → 抛此错。
 * http 层应翻 503 SUPERVISOR_NOT_READY,文案告诉 admin "确认 OC_RUNTIME_IMAGE 已配"。
 */
export class V3SupervisorMissingError extends Error {
  constructor(id: bigint | string) {
    super(`agent_container ${String(id)} is a v3 row but V3SupervisorDeps not wired (check OC_RUNTIME_IMAGE)`);
    this.name = "V3SupervisorMissingError";
  }
}

/**
 * 行类型 dispatch:
 *   - v2:docker_name 非空,直接走 supervisor 系列
 *   - v3:docker_name=NULL,走 v3supervisor.stopAndRemoveV3Container
 *
 * 两类共享 user_id(可能用 NULL? user_id 在 v3 也是 INSERT 时填的,正常非空)
 */
type ContainerLookup =
  | { kind: "v2"; userId: number; dockerName: string }
  | { kind: "v3"; rowId: number; containerInternalId: string | null };

/** 由 id 查 user_id(num)+ docker_name + container_internal_id。 */
async function lookupContainer(id: bigint | string): Promise<ContainerLookup | null> {
  const r = await query<{
    id: string;
    user_id: string;
    docker_name: string | null;
    container_internal_id: string | null;
  }>(
    `SELECT id::text AS id,
            user_id::text AS user_id,
            docker_name,
            container_internal_id
       FROM agent_containers
      WHERE id = $1`,
    [String(id)],
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0]!;
  // v2 行:docker_name 非空。v2 admin 用 user_id 调 supervisor。
  if (row.docker_name) {
    const n = Number(row.user_id);
    if (!Number.isInteger(n) || n <= 0) throw new RangeError("invalid_user_id_in_row");
    return { kind: "v2", userId: n, dockerName: row.docker_name };
  }
  // v3 行:docker_name=NULL。container_internal_id 由 provisionV3Container UPDATE 填,
  // 极短窗口可能仍是 NULL(provision 跑 docker create 之间 / failed mid-flight),
  // stopAndRemoveV3Container 兼容 NULL 路径(不调 docker,只 UPDATE state='vanished')。
  const rowIdNum = Number(row.id);
  if (!Number.isInteger(rowIdNum) || rowIdNum <= 0) throw new RangeError("invalid_container_id_in_row");
  return { kind: "v3", rowId: rowIdNum, containerInternalId: row.container_internal_id };
}

async function auditBestEffort(
  ctx: AdminAuditCtx,
  action: string,
  id: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  try {
    await writeAdminAudit(getPool(), {
      adminId: ctx.adminId,
      action,
      target: `agent_container:${id}`,
      before: extra ?? null,
      after: null,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    });
  } catch (err) {
    // 同 accounts.bestEffortAudit:Prometheus counter + onAuditError(或 stderr)双报
    incrAdminAuditWriteFailure(action);
    (ctx.onAuditError ?? ((e) => {
      // eslint-disable-next-line no-console
      console.error("[admin/containers] admin_audit write failed:", e);
    }))(err);
  }
}

// ─── restart ──────────────────────────────────────────────────────

/**
 * 重启容器:
 *   - v2:docker.restart({ t: 5 })。容器不存在 → dockerode 404 透传(原信息利于排障)
 *   - v3:stopAndRemoveV3Container —— ephemeral 模型下"重启"=vanish,
 *     下次用户 ws 连接 ensureRunning 会自动重 provision(volume 保留)
 *
 * 行不存在 → ContainerNotFoundError。
 */
export async function adminRestartContainer(
  id: bigint | string,
  docker: Docker,
  ctx: AdminAuditCtx,
  v3Deps?: V3SupervisorDeps,
): Promise<void> {
  const info = await lookupContainer(id);
  if (!info) throw new ContainerNotFoundError(id);
  if (info.kind === "v2") {
    await docker.getContainer(info.dockerName).restart({ t: 5 });
    await auditBestEffort(ctx, "agent_container.restart", String(id), {
      kind: "v2",
      docker_name: info.dockerName,
    });
    return;
  }
  // v3:restart = stop+remove,触发下一次 ensureRunning 自动 reprovision
  if (!v3Deps) throw new V3SupervisorMissingError(id);
  await stopAndRemoveV3Container(v3Deps, {
    id: info.rowId,
    container_internal_id: info.containerInternalId,
  }, 5);
  await auditBestEffort(ctx, "agent_container.restart", String(id), {
    kind: "v3",
    container_internal_id: info.containerInternalId,
    semantic: "stop_remove_then_reprovision",
  });
}

// ─── stop ─────────────────────────────────────────────────────────

export async function adminStopContainer(
  id: bigint | string,
  docker: Docker,
  ctx: AdminAuditCtx,
  v3Deps?: V3SupervisorDeps,
): Promise<void> {
  const info = await lookupContainer(id);
  if (!info) throw new ContainerNotFoundError(id);
  if (info.kind === "v2") {
    await supStop(docker, info.userId, 5);
    await auditBestEffort(ctx, "agent_container.stop", String(id), {
      kind: "v2",
      docker_name: info.dockerName,
    });
    // 名称一致性断言(防御):supervisor 的 containerNameFor(uid) 应该 == DB 的 docker_name
    // 不符说明数据或命名规则漂移,记日志不抛错。
    const expectedName = containerNameFor(info.userId);
    if (expectedName !== info.dockerName) {
      // eslint-disable-next-line no-console
      console.warn(`[admin/containers] docker_name mismatch id=${id}: db=${info.dockerName} expected=${expectedName}`);
    }
    return;
  }
  // v3:stop = stop+remove(ephemeral 没有持久 stopped 态)
  if (!v3Deps) throw new V3SupervisorMissingError(id);
  await stopAndRemoveV3Container(v3Deps, {
    id: info.rowId,
    container_internal_id: info.containerInternalId,
  }, 5);
  await auditBestEffort(ctx, "agent_container.stop", String(id), {
    kind: "v3",
    container_internal_id: info.containerInternalId,
  });
}

// ─── remove ───────────────────────────────────────────────────────

export async function adminRemoveContainer(
  id: bigint | string,
  docker: Docker,
  ctx: AdminAuditCtx,
  v3Deps?: V3SupervisorDeps,
): Promise<void> {
  const info = await lookupContainer(id);
  if (!info) throw new ContainerNotFoundError(id);
  if (info.kind === "v2") {
    await supRemove(docker, info.userId);
    await auditBestEffort(ctx, "agent_container.remove", String(id), {
      kind: "v2",
      docker_name: info.dockerName,
    });
    return;
  }
  // v3:remove = stop+remove,与 stop 等价(ephemeral 模型语义合并)
  if (!v3Deps) throw new V3SupervisorMissingError(id);
  await stopAndRemoveV3Container(v3Deps, {
    id: info.rowId,
    container_internal_id: info.containerInternalId,
  }, 5);
  await auditBestEffort(ctx, "agent_container.remove", String(id), {
    kind: "v3",
    container_internal_id: info.containerInternalId,
  });
}
