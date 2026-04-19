/**
 * T-60 — 超管 agent_containers 管理。
 *
 * ### 查询
 * listContainers:纯 DB 读(含用户 email + 订阅状态),用于 admin 面板观察。
 *   - 不去 inspect docker(昂贵且可能阻塞)—— DB 的 status 已经由 lifecycle 维护
 *   - 如果要看 docker 实时状态,管 admin 自己点 "restart" 之类触发一次 lifecycle
 *
 * ### 写操作
 * restart / stop / remove 三个方向:
 *   - 只调 docker 层(supervisor.stopContainer / removeContainer / 原生 restart)
 *   - 不更新 agent_containers.status —— lifecycle tick 会把 DB 状态 reconcile 回来
 *     (避免 admin 面板和 lifecycle 同时写同一字段引起抖动)
 *   - 都写 admin_audit(best-effort,同 accounts.ts 的策略)
 *
 * ### 幂等
 * supervisor.stop / remove 都已幂等(未找到 → noop),所以 admin 多次点不会报错。
 * restart 若容器不存在 → 返 404(管理员应该用 "重新 provision" 流程,本 API 不建)。
 */

import type Docker from "dockerode";
import { getPool } from "../db/index.js";
import { query } from "../db/queries.js";
import {
  containerNameFor,
  removeContainer as supRemove,
  stopContainer as supStop,
} from "../agent-sandbox/supervisor.js";
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
  status: string;
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

/** 由 id 查 user_id(num)+ docker_name,用于操作 docker。 */
async function lookupContainer(id: bigint | string): Promise<{ userId: number; dockerName: string } | null> {
  const r = await query<{ user_id: string; docker_name: string }>(
    `SELECT user_id::text AS user_id, docker_name FROM agent_containers WHERE id = $1`,
    [String(id)],
  );
  if (r.rows.length === 0) return null;
  const n = Number(r.rows[0].user_id);
  if (!Number.isInteger(n) || n <= 0) throw new RangeError("invalid_user_id_in_row");
  return { userId: n, dockerName: r.rows[0].docker_name };
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
 * 重启容器。不存在 → ContainerNotFoundError。docker 层未找到 → 透传 dockerode 错误。
 */
export async function adminRestartContainer(
  id: bigint | string,
  docker: Docker,
  ctx: AdminAuditCtx,
): Promise<void> {
  const info = await lookupContainer(id);
  if (!info) throw new ContainerNotFoundError(id);
  // 直接用 dockerode 原生 restart(supervisor 没有导出专门封装);
  // 如果容器不存在 docker 会抛 404,保留原信息利于排障。
  await docker.getContainer(info.dockerName).restart({ t: 5 });
  await auditBestEffort(ctx, "agent_container.restart", String(id), {
    docker_name: info.dockerName,
  });
}

// ─── stop ─────────────────────────────────────────────────────────

export async function adminStopContainer(
  id: bigint | string,
  docker: Docker,
  ctx: AdminAuditCtx,
): Promise<void> {
  const info = await lookupContainer(id);
  if (!info) throw new ContainerNotFoundError(id);
  await supStop(docker, info.userId, 5);
  await auditBestEffort(ctx, "agent_container.stop", String(id), {
    docker_name: info.dockerName,
  });
  // 名称一致性断言(防御):supervisor 的 containerNameFor(uid) 应该 == DB 的 docker_name
  // 不符说明数据或命名规则漂移,记日志不抛错。
  const expectedName = containerNameFor(info.userId);
  if (expectedName !== info.dockerName) {
    // eslint-disable-next-line no-console
    console.warn(`[admin/containers] docker_name mismatch id=${id}: db=${info.dockerName} expected=${expectedName}`);
  }
}

// ─── remove ───────────────────────────────────────────────────────

export async function adminRemoveContainer(
  id: bigint | string,
  docker: Docker,
  ctx: AdminAuditCtx,
): Promise<void> {
  const info = await lookupContainer(id);
  if (!info) throw new ContainerNotFoundError(id);
  await supRemove(docker, info.userId);
  await auditBestEffort(ctx, "agent_container.remove", String(id), {
    docker_name: info.dockerName,
  });
}
