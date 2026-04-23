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
  -- v2 行用 status,v3 行用 state,UI 拿一个字段就够。
  -- R2 finding 加固:row_kind 判据加 subscription_id IS NULL 兜底。
  -- 0017 把 docker_name 改 nullable 后,单看 docker_name 空判 v3 不稳:
  -- 万一 v2 legacy row 出现 docker_name=NULL,会被错判 v3 → admin 走错
  -- 操作路径(v3 dispatcher 调用 stopAndRemoveV3Container 在 v2 行上)。
  -- v3 INSERT 不指定 subscription_id (NULL),v2 INSERT 必填 subscription_id;
  -- subscription_id IS NULL ⟹ v3 (强 invariant,迁移 0001+0012 保证)。
  CASE
    WHEN c.subscription_id IS NULL THEN c.state
    ELSE c.status
  END AS lifecycle,
  CASE
    WHEN c.subscription_id IS NULL THEN 'v3'
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
  /**
   * 可选:单值或数组 lifecycle。
   *
   * Codex R4 MEDIUM#3 修复:过去这里直接下推 `c.status = ANY(...)`,v3 行
   * status=NULL(0017 drop NOT NULL 后 v3 只写 state),过滤 "running" 时
   * v3 active 容器全被隐藏 → admin UI 看不到 v3 侧 running 行,影响排障。
   *
   * 改成 lifecycle 语义,与 `row_kind`/`lifecycle` 列 + containersStats 对齐:
   *   - running      = v2 status='running'       OR v3 state='active'
   *   - provisioning = v2 status='provisioning'  (v3 无此态)
   *   - stopped      = v2 status='stopped'       (v3 无此态)
   *   - error        = v2 status='error'         (v3 CHECK 只有 active/vanished)
   *   - removed      = v2 status='removed'       OR v3 state='vanished'
   */
  status?: string | string[];
  limit?: number;
  offset?: number;
}

const CONTAINER_STATUSES = ["provisioning", "running", "stopped", "removed", "error"] as const;

/** 把 lifecycle 过滤值翻成 SQL 条件(已防 SQL 注入 —— 白名单映射,无参数)。 */
function lifecycleWhereSql(lifecycle: string): string {
  switch (lifecycle) {
    case "running":
      return "((c.subscription_id IS NOT NULL AND c.status = 'running') OR (c.subscription_id IS NULL AND c.state = 'active'))";
    case "provisioning":
      return "(c.subscription_id IS NOT NULL AND c.status = 'provisioning')";
    case "stopped":
      return "(c.subscription_id IS NOT NULL AND c.status = 'stopped')";
    case "error":
      return "(c.subscription_id IS NOT NULL AND c.status = 'error')";
    case "removed":
      return "((c.subscription_id IS NOT NULL AND c.status = 'removed') OR (c.subscription_id IS NULL AND c.state = 'vanished'))";
    default:
      throw new RangeError("invalid_status");
  }
}

export async function listContainers(input: ListContainersInput = {}): Promise<AdminContainerRowView[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (input.status !== undefined) {
    const arr = Array.isArray(input.status) ? input.status : [input.status];
    // 白名单校验 + 翻成 lifecycle-aware SQL(v2 status / v3 state 统一)
    const parts = arr.map((s) => {
      if (!(CONTAINER_STATUSES as readonly string[]).includes(s)) {
        throw new RangeError("invalid_status");
      }
      return lifecycleWhereSql(s);
    });
    where.push(parts.length === 1 ? parts[0]! : `(${parts.join(" OR ")})`);
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
    subscription_id: string | null;
    docker_name: string | null;
    container_internal_id: string | null;
  }>(
    `SELECT id::text AS id,
            user_id::text AS user_id,
            subscription_id::text AS subscription_id,
            docker_name,
            container_internal_id
       FROM agent_containers
      WHERE id = $1`,
    [String(id)],
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0]!;
  // R2 finding 加固:v2/v3 dispatch 判据从"docker_name 是否空"换成
  // "subscription_id 是否 NULL"。后者是稳的 invariant:v2 INSERT 必填
  // subscription_id;v3 INSERT 不指定 → NULL。和 admin/containers.ts 的
  // CONTAINER_COLS row_kind 字段保持一致语义,避免 list 显示一种但 dispatch
  // 走另一种。
  if (row.subscription_id !== null) {
    // v2 行:走 supervisor restart/stop/remove(用 user_id)
    const n = Number(row.user_id);
    if (!Number.isInteger(n) || n <= 0) throw new RangeError("invalid_user_id_in_row");
    if (!row.docker_name) {
      // 几乎不可能(v2 INSERT 必填),但兜底:防止 docker.getContainer('') 拉炸
      throw new RangeError("v2_row_missing_docker_name");
    }
    return { kind: "v2", userId: n, dockerName: row.docker_name };
  }
  // v3 行:subscription_id IS NULL。container_internal_id 由 provisionV3Container UPDATE 填,
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

// ─── logs ─────────────────────────────────────────────────────────

/**
 * R4 — admin 读取容器 tail 日志。
 *
 * dockerode 底层调 `GET /containers/:id/logs?stdout=1&stderr=1&tail=N`。
 * Tty=false(supervisor.ts:385 / v3supervisor.ts:964 都是 false)→ 响应体是
 * docker 的多路复用帧格式:
 *   [uint8 stream][3 bytes padding][uint32 be payload_len][payload ...]
 *   stream: 1=stdout, 2=stderr(0=stdin,通常看不到)
 *
 * 本函数返回 `{stdout, stderr, combined}`:
 *   - combined = 原文流顺序拼接(admin 想像 `docker logs` 一样看)
 *   - stdout/stderr = 只是按流拆开,前端可以选显示
 *
 * 错误语义:
 *   - 行不存在 → ContainerNotFoundError
 *   - v2 行但 docker 容器 404(legacy removed) → 返回空内容,不抛
 *   - v3 行但 container_internal_id=NULL(vanished 或 provision 失败) → 返回空
 *   - v3 行但 docker 404 → 返回空
 *   - 其它 docker 错误(500 / network) → 透传给 caller,http 层翻 502
 */
export interface AdminContainerLogs {
  stdout: string;
  stderr: string;
  combined: string;
  /** 参考信息:调用时拿到的 docker identifier(name for v2, internal id for v3)。
   *  admin UI 显示,便于直接去宿主机 `docker logs` 复查。 */
  docker_ref: string | null;
  /** 容器在宿主机上不存在(v2 removed / v3 vanished / provision 失败)。 */
  missing: boolean;
  /**
   * 部分输出:被字节上限截断,或 mid-stream 出错。
   *   - bytes_truncated:tail 累加到 LOGS_MAX_BYTES 后主动 destroy 流
   *   - stream_error:docker 返回 200 后 socket 异常(ECONNRESET 之类),
   *     partial logs 能返多少返多少,UI 需知悉不完整
   */
  partial: "bytes_truncated" | "stream_error" | null;
}

/** docker tail,默认 200 行,上限 500(再多 UI 也看不动)。 */
export const LOGS_MAX_LINES = 500;

/** 响应字节上限。Docker `tail` 按行截断,但单行若是 base64/dump 可能上 MB 级别,
 *  走一次 tail=500 可能意外拖 GB 内存到 gateway。2MiB 足够 admin 扫错误栈。 */
export const LOGS_MAX_BYTES = 2 * 1024 * 1024;

function decodeDockerLogFrames(buf: Buffer): { stdout: string; stderr: string; combined: string } {
  let stdout = "";
  let stderr = "";
  let combined = "";
  let off = 0;
  while (off + 8 <= buf.length) {
    const stream = buf[off]!;
    const len = buf.readUInt32BE(off + 4);
    // Codex R4-2 MEDIUM#2:被裁剪到 LOGS_MAX_BYTES 时,最后一帧可能 header 完整
    // 但 payload 被截。之前 `break` 会让整帧输出丢失 —— 即"单行巨帧"直接变空
    // modal。改成 emit 能拿到的 partial payload,让 admin 至少能看到开头。
    const frameEnd = off + 8 + len;
    const avail = Math.min(frameEnd, buf.length);
    const payload = buf.slice(off + 8, avail).toString("utf8");
    if (stream === 2) stderr += payload;
    else stdout += payload; // stream=1 或异常值都归 stdout
    combined += payload;
    if (frameEnd > buf.length) break; // 最后一帧被截,已消费完剩余 bytes
    off = frameEnd;
  }
  return { stdout, stderr, combined };
}

export async function adminContainerLogs(
  id: bigint | string,
  docker: Docker,
  tail: number,
  v3Deps?: V3SupervisorDeps,
): Promise<AdminContainerLogs> {
  if (!Number.isInteger(tail) || tail <= 0) throw new RangeError("invalid_tail");
  if (tail > LOGS_MAX_LINES) tail = LOGS_MAX_LINES;
  const info = await lookupContainer(id);
  if (!info) throw new ContainerNotFoundError(id);

  // 选 docker identifier
  let ref: string | null = null;
  if (info.kind === "v2") {
    ref = info.dockerName;
  } else {
    if (!v3Deps) throw new V3SupervisorMissingError(id);
    ref = info.containerInternalId; // 可能 NULL(provision 中 / vanished)
  }
  if (!ref) {
    return { stdout: "", stderr: "", combined: "", docker_ref: null, missing: true, partial: null };
  }

  try {
    // Codex R4 HIGH#1 + R4-2 MEDIUM#1 修复:
    //
    // dockerode 的 `container.logs({follow:false})` 走 modem buffered 分支
    // (modem.js:339-345 先 Buffer.concat 全响应),单行 GB 级日志会先把
    // gateway 内存打爆。`follow:true` 能拿 stream,但 docker 会保持 socket
    // 等新日志,只能用 idle-timeout 启发式判断 tail 发完 —— 不是协议保证。
    //
    // 正确做法:绕过 dockerode,直接 modem.dial `follow=0` + `isStream:true`。
    //   - follow=0 让 docker flush tail N 行后主动关 socket → `end` 是真的边界
    //   - isStream:true 让 modem 透传 res stream(不 buffer)→ 我们 incrementally
    //     read,超 LOGS_MAX_BYTES 主动 destroy 挡 OOM
    //   - mid-stream error(ECONNRESET 等)设 partial='stream_error',返回
    //     已 accumulate 的部分 + 明确标记,admin UI 不会误以为是完整日志
    //
    // Codex R4-3 LOW#1:path 必须以裸 `?` 结尾,query 放 `options.options`,
    // 不能手拼完整 query 进 path —— docker-modem modem.js:160-165 的逻辑是
    // "path 含 `?` 但没 opts 时,substring(0, len-1) 砍掉尾字符",手拼 query
    // 的最后一个字符(这里是 timestamps=1 的 1)会被吞掉,变成 timestamps=
    // → docker 400 拒。让 modem.buildQuerystring 基于 options.options 自己拼,
    // 才能正确保留完整 query。
    const docker_any = docker as unknown as {
      modem: {
        dial(
          opts: Record<string, unknown>,
          cb: (err: unknown, streamOrBody: unknown) => void,
        ): void;
      };
    };
    const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => {
      docker_any.modem.dial(
        {
          path: `/containers/${encodeURIComponent(ref)}/logs?`,
          method: "GET",
          options: {
            stdout: true,
            stderr: true,
            tail,
            follow: false,
            timestamps: true,
          },
          isStream: true,
          statusCodes: { 200: true, 404: "no such container", 500: "server error" },
        },
        (err, s) => {
          if (err) reject(err);
          else resolve(s as NodeJS.ReadableStream);
        },
      );
    });

    const chunks: Buffer[] = [];
    let total = 0;
    let partial: "bytes_truncated" | "stream_error" | null = null;

    await new Promise<void>((resolve) => {
      let resolved = false;
      const finish = () => {
        if (resolved) return;
        resolved = true;
        try {
          (stream as unknown as { destroy?: () => void }).destroy?.();
        } catch { /* ignore */ }
        resolve();
      };
      stream.on("data", (chunkIn: Buffer | string) => {
        if (resolved) return;
        const chunk = Buffer.isBuffer(chunkIn) ? chunkIn : Buffer.from(chunkIn);
        if (total + chunk.length > LOGS_MAX_BYTES) {
          const take = Math.max(0, LOGS_MAX_BYTES - total);
          if (take > 0) chunks.push(chunk.slice(0, take));
          total += take;
          partial = "bytes_truncated";
          finish();
          return;
        }
        chunks.push(chunk);
        total += chunk.length;
      });
      stream.on("end", finish);
      stream.on("close", finish);
      // Codex R4-2 LOW#3:mid-stream error 标 partial,不再静默吞掉
      stream.on("error", () => {
        if (resolved) return;
        if (partial == null) partial = "stream_error";
        finish();
      });
    });

    const buf = Buffer.concat(chunks);
    const decoded = decodeDockerLogFrames(buf);
    if (partial === "bytes_truncated") {
      decoded.combined += `\n[admin/container-logs] 已裁剪到 ${LOGS_MAX_BYTES} 字节,尾部输出被丢弃\n`;
    } else if (partial === "stream_error") {
      decoded.combined += `\n[admin/container-logs] docker socket 读取中断,输出可能不完整\n`;
    }
    return { ...decoded, docker_ref: ref, missing: false, partial };
  } catch (err) {
    // 404 → 容器不存在,返回空(不抛,admin UI 就显示"容器已不存在")
    const e = err as { statusCode?: number; reason?: string };
    if (e?.statusCode === 404 || (typeof e?.reason === "string" && e.reason.includes("no such container"))) {
      return { stdout: "", stderr: "", combined: "", docker_ref: ref, missing: true, partial: null };
    }
    throw err;
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
