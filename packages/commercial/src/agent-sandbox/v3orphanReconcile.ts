/**
 * V3 Phase 3H — orphan reconcile(gateway 启动 + 每 1h 跑一次)。
 *
 * 见 docs/v3/02-DEVELOPMENT-PLAN.md §9.3 Task 3H + §1.0.2 I3 hostAgentReconcile。
 *
 * 双向对账:
 *
 *   Direction A — docker → DB orphan(本机 v3 标签容器 不在 DB active 集合)
 *     - listContainers({all:true, filters:{label:'com.openclaude.v3.managed=1'}})
 *     - SELECT container_internal_id, host_uuid FROM agent_containers WHERE state='active'
 *     - dbActiveCids 只取 (host_uuid IS NULL OR = selfHostId) 的行;selfHostId 缺失
 *       时退回原全集,避免误排除本机带 host_uuid 的真实容器
 *     - diff: docker 有但 DB 不在 → docker 孤儿(supervisor 崩 / 老进程残留)
 *     - 安全护栏:跳过 Created < SAFETY_RACE_WINDOW_SEC(默认 300s)的容器,
 *       避免撞 provision 中 INSERT-then-create-then-UPDATE 之间的窗口
 *     - 命中 → docker stop + remove --force(missing → noop)
 *
 *   Direction B — DB → docker orphan(DB active 行 inspect 404)
 *     - SELECT id, container_internal_id, host_uuid FROM agent_containers
 *         WHERE state='active' AND container_internal_id IS NOT NULL
 *     - 多机路由(2026-04-27 修复):
 *       · host_uuid NULL/空 或 === selfHostId → 走本机 deps.docker.inspect
 *       · host_uuid !== selfHostId 且 containerService + selfHostId 都注入
 *         → 走 deps.containerService.inspect(host_uuid, cid) (mTLS 到 node-agent)
 *       · 其他(selfHostId 缺失 / 跨 host 但 containerService 没注入)→ skip,
 *         debug 日志,绝不 vanish (无法确认死活时不做破坏性动作)
 *     - inspect 404 → 标 vanished;非 404 错误(网络/mTLS 临时失败)→ errors[],
 *       绝不 vanish — 控制面不可达不证明容器消失
 *     - 复用 stopAndRemoveV3Container(它内部按 host_uuid 路由 stop/remove)
 *
 * 关于 NULL 行:
 *   - container_internal_id IS NULL 的行 不参与 direction B(provision 中间窗口
 *     INSERT 已落但 UPDATE 还没跑;完整 BEGIN/COMMIT 兜住该窗口,实际不会出现)
 *   - host_uuid IS NULL 视为 legacy/单机 行,Direction B 走本机 inspect
 *
 * 不在本文件管:
 *   - volume orphan reconcile(volume 没绑容器但 PG 没标记):3G 已扫 banned/no-login,
 *     额外的 unmanaged volume 走运维 manual `docker volume prune --filter label=...`
 *   - host-agent / ipset 双向对账:P1 多 host 才有 host-agent,MVP 不存在
 *
 * 调度:
 *   - 默认 1h 一跑(orphan 不时敏);runOnStart=true(启动时立刻跑一次,§3H 明确要求)
 *   - 串行 tick + stop awaits inflight + runOnce 钩子(完全镜像 v3idleSweep / volumeGc)
 */

import type Docker from "dockerode";
import type { Pool } from "pg";

import {
  stopAndRemoveV3Container,
  type V3SupervisorDeps,
} from "./v3supervisor.js";

// ───────────────────────────────────────────────────────────────────────
// 默认常量
// ───────────────────────────────────────────────────────────────────────

/** 默认调度间隔(1h)。 */
export const DEFAULT_ORPHAN_RECONCILE_INTERVAL_MS = 60 * 60 * 1_000;

/**
 * docker → DB direction 的安全窗口(秒):跳过 Created < 此值的容器。
 * 防撞 provision 中 INSERT(state='active', cid IS NULL)→ docker create →
 * UPDATE container_internal_id 之间的窗口(实际窗口 < 5s,300s 给足余量)。
 */
export const SAFETY_RACE_WINDOW_SEC = 300;

/** 单 tick 处理上限(direction A + B 各自上限),防一次扫太多 */
export const DEFAULT_RECONCILE_BATCH_LIMIT = 200;

const V3_MANAGED_LABEL_KEY = "com.openclaude.v3.managed";

// ───────────────────────────────────────────────────────────────────────
// 公共类型
// ───────────────────────────────────────────────────────────────────────

export interface OrphanReconcileLogger {
  debug?(message: string, meta?: Record<string, unknown>): void;
  info?(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
  error?(message: string, meta?: Record<string, unknown>): void;
}

export interface OrphanReconcileTickOptions {
  /** docker → DB direction 安全窗口(秒),默认 300 */
  safetyRaceWindowSec?: number;
  /** 单 tick 上限,默认 200 */
  batchLimit?: number;
  /** logger */
  logger?: OrphanReconcileLogger;
  /** docker stop 超时(秒),默认 5 */
  stopTimeoutSec?: number;
}

export interface OrphanReconcileTickResult {
  scanned: {
    /** docker 标签容器总数(filter 后) */
    dockerContainers: number;
    /** PG state='active' 行数 */
    dbActiveRows: number;
  };
  /** docker → DB 方向:被 stop+rm 的 docker 孤儿数 */
  dockerOrphansRemoved: number;
  /** DB → docker 方向:被标 vanished 的 PG 行数 */
  dbOrphansVanished: number;
  /** 因 SAFETY_RACE_WINDOW 被跳过的容器数 */
  skippedRecent: number;
  errors: Array<{ kind: "docker" | "db"; id: string; error: string }>;
  durationMs: number;
}

export interface StartOrphanReconcileSchedulerOptions extends OrphanReconcileTickOptions {
  /** 两次 tick 间隔(ms),默认 3_600_000(1h) */
  intervalMs?: number;
  /** 启动时是否立刻跑。**默认 true** — §3H 明确要求 gateway 启动时 reconcile */
  runOnStart?: boolean;
  /** 每次 tick 完成回调(metrics 接入点) */
  onTick?: (r: OrphanReconcileTickResult) => void;
}

export interface OrphanReconcileScheduler {
  stop: () => Promise<void>;
  runOnce: () => Promise<OrphanReconcileTickResult>;
}

// ───────────────────────────────────────────────────────────────────────
// 内部 helpers
// ───────────────────────────────────────────────────────────────────────

function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  // dockerode 抛 `{ statusCode: 404 }`;远端 RemoteNodeAgentBackend 走
  // nodeAgentClient 抛 `AgentAppError { httpStatus: 404 }`(见
  // compute-pool/nodeAgentClient.ts:344)。两者都视作"容器在该 host 已不存在"。
  const e = err as { statusCode?: unknown; httpStatus?: unknown };
  return e.statusCode === 404 || e.httpStatus === 404;
}

interface DockerContainerInfo {
  id: string;
  /** Unix epoch seconds(dockerode listContainers 返 number) */
  createdSec: number;
}

/**
 * 列本机所有 v3 managed 容器(all=true 含 stopped),按 SAFETY 窗过滤。
 *
 * 注:dockerode `listContainers` 返回的 `Created` 是 Unix epoch seconds,与
 * `inspect()` 返回的 `Created` ISO 8601 不同 —— 这里只读 list,不会混。
 */
async function listManagedContainers(
  docker: Docker,
  safetySec: number,
  batchLimit: number,
): Promise<{ all: DockerContainerInfo[]; recentSkipped: number }> {
  const list = await docker.listContainers({
    all: true,
    filters: { label: [`${V3_MANAGED_LABEL_KEY}=1`] },
  });
  const cutoffSec = Math.floor(Date.now() / 1000) - safetySec;
  const all: DockerContainerInfo[] = [];
  let recentSkipped = 0;
  for (const c of list) {
    const created = typeof c.Created === "number" ? c.Created : 0;
    if (created > cutoffSec) {
      recentSkipped++;
      continue;
    }
    all.push({ id: c.Id, createdSec: created });
    if (all.length >= batchLimit) break;
  }
  return { all, recentSkipped };
}

interface DbActiveRow {
  id: number;
  container_internal_id: string | null;
  /**
   * 调度到的 host_uuid。NULL = 单机 MVP 遗留行(视为本机);非空且 ≠ selfHostId
   * 时 Direction B 必须走 `containerService.inspect(host_uuid, cid)` 路由,
   * 否则本机 docker inspect 必 404 → 误标 vanished(已修复)。
   */
  host_uuid: string | null;
}

/**
 * 列所有 state='active' 行(含 container_internal_id IS NULL 的中间窗口行)。
 *
 * R6.11 reader 二选一:本文件在 RECONCILER_WHITELIST 内,trivial 满足。
 */
async function listActiveRows(pool: Pool, batchLimit: number): Promise<DbActiveRow[]> {
  const r = await pool.query<{
    id: string;
    container_internal_id: string | null;
    host_uuid: string | null;
  }>(
    `SELECT id, container_internal_id, host_uuid
       FROM agent_containers
      WHERE state = 'active'
      ORDER BY id ASC
      LIMIT $1::int`,
    [batchLimit],
  );
  return r.rows.map((row) => ({
    id: Number.parseInt(row.id, 10),
    container_internal_id: row.container_internal_id,
    host_uuid: row.host_uuid,
  }));
}

/**
 * Direction A — 删 docker 孤儿(本机有但 DB 没在 active 集合)。
 *
 * 单容器失败:catch 后塞 errors[],继续下一个。
 */
async function reconcileDockerOrphans(
  docker: Docker,
  dockerList: DockerContainerInfo[],
  dbActiveCids: Set<string>,
  stopTimeoutSec: number,
  errors: OrphanReconcileTickResult["errors"],
  log: OrphanReconcileLogger | undefined,
): Promise<number> {
  let removed = 0;
  for (const c of dockerList) {
    if (dbActiveCids.has(c.id)) continue;
    try {
      const handle = docker.getContainer(c.id);
      try {
        await handle.stop({ t: stopTimeoutSec });
      } catch (err) {
        // 已经 stopped → 304 Not Modified;missing → 404
        if (!isNotFound(err) && (err as { statusCode?: number }).statusCode !== 304) throw err;
      }
      try {
        await handle.remove({ force: true });
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
      removed++;
      log?.info?.("[v3/orphanReconcile] removed docker orphan", { containerId: c.id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ kind: "docker", id: c.id, error: msg });
      log?.warn?.("[v3/orphanReconcile] docker orphan rm failed", {
        containerId: c.id, err: msg,
      });
    }
  }
  return removed;
}

/**
 * Direction B — 把 docker inspect 404 的 active 行标 vanished。
 *
 * 复用 stopAndRemoveV3Container(它内部 missing → noop + UPDATE state='vanished',
 * 并按 host_uuid 路由 stop/remove)。
 *
 * 多机路由(2026-04-27 修复):row.host_uuid 非空且 ≠ selfHostId 时必须走
 * `containerService.inspect(host_uuid, cid)`,不能直打本机 docker socket
 * (跨 host 容器在本机 docker 必 404 → 误标 vanished;hshi/user33 案,见 1185)。
 *
 * Fail-safe:`selfHostId` 或 `containerService` 任一缺失,且 row 是跨 host 行,
 * 则 skip 该行 — 无法确认容器死活时绝不做破坏性动作。
 */
async function reconcileDbOrphans(
  deps: V3SupervisorDeps,
  rows: DbActiveRow[],
  stopTimeoutSec: number,
  errors: OrphanReconcileTickResult["errors"],
  log: OrphanReconcileLogger | undefined,
): Promise<number> {
  let vanished = 0;
  for (const row of rows) {
    if (!row.container_internal_id) continue; // skip NULL — 见文件头注释
    const cid = row.container_internal_id;
    // host 路由判定:row 有 host_uuid 且 ≠ selfHostId → remote
    const isRemoteRow =
      typeof row.host_uuid === "string"
      && row.host_uuid !== ""
      && typeof deps.selfHostId === "string"
      && row.host_uuid !== deps.selfHostId;
    // selfHostId 缺失但 row 显式带 host_uuid → 无法判定本机/远端,skip 不破坏
    if (
      typeof row.host_uuid === "string"
      && row.host_uuid !== ""
      && typeof deps.selfHostId !== "string"
    ) {
      log?.debug?.("[v3/orphanReconcile] skip row: selfHostId missing", {
        containerId: row.id, host_uuid: row.host_uuid,
      });
      continue;
    }
    // remote row 但 containerService 没注入 → skip
    if (isRemoteRow && !deps.containerService) {
      log?.debug?.("[v3/orphanReconcile] skip remote row: containerService missing", {
        containerId: row.id, host_uuid: row.host_uuid,
      });
      continue;
    }
    try {
      const info = isRemoteRow
        ? await deps.containerService!.inspect(row.host_uuid!, cid)
        : await deps.docker.getContainer(cid).inspect();
      // inspect ok → 容器仍存在,direction B 不动它(不管 running 与否,
      // running 由 idle sweep 管;stopped 等 ensureRunning 触发 missing 路径)
      if (info.State) {
        log?.debug?.("[v3/orphanReconcile] db row alive", {
          containerId: row.id,
          docker: cid,
          host_uuid: row.host_uuid,
          running: Boolean(info.State.Running),
        });
      }
    } catch (err) {
      if (isNotFound(err)) {
        // 对应 host 上的容器确实消失 → 标 vanished
        try {
          await stopAndRemoveV3Container(
            deps,
            {
              id: row.id,
              container_internal_id: cid,
              host_uuid: row.host_uuid,
            },
            stopTimeoutSec,
          );
          vanished++;
          log?.info?.("[v3/orphanReconcile] vanished db orphan", {
            containerId: row.id,
            docker: cid,
            host_uuid: row.host_uuid,
          });
        } catch (innerErr) {
          const msg = innerErr instanceof Error ? innerErr.message : String(innerErr);
          errors.push({ kind: "db", id: String(row.id), error: msg });
          log?.warn?.("[v3/orphanReconcile] db vanish failed", {
            containerId: row.id, err: msg,
          });
        }
      } else {
        // 网络 / mTLS / docker daemon 临时错 → 不能证明容器消失,绝不 vanish
        const msg = err instanceof Error ? err.message : String(err);
        errors.push({ kind: "db", id: String(row.id), error: msg });
        log?.warn?.("[v3/orphanReconcile] db row inspect failed", {
          containerId: row.id, host_uuid: row.host_uuid, err: msg,
        });
      }
    }
  }
  return vanished;
}

// ───────────────────────────────────────────────────────────────────────
// 单次 tick:scan + 双向对账
// ───────────────────────────────────────────────────────────────────────

/**
 * 跑一轮 orphan reconcile:list docker + list DB → 双向 diff → 单容器失败聚合。
 *
 * 单 docker / DB 失败 → errors[] 不打断;list 抛 → throw(scheduler 排下次)。
 */
export async function runOrphanReconcileTick(
  deps: V3SupervisorDeps,
  options: OrphanReconcileTickOptions = {},
): Promise<OrphanReconcileTickResult> {
  const safetySec = options.safetyRaceWindowSec ?? SAFETY_RACE_WINDOW_SEC;
  const batchLimit = options.batchLimit ?? DEFAULT_RECONCILE_BATCH_LIMIT;
  const stopTimeoutSec = options.stopTimeoutSec ?? 5;
  const log = options.logger;

  const startedAt = Date.now();
  const errors: OrphanReconcileTickResult["errors"] = [];

  // 列两侧
  const { all: dockerList, recentSkipped } = await listManagedContainers(
    deps.docker, safetySec, batchLimit,
  );
  const dbRows = await listActiveRows(deps.pool, batchLimit);
  // Direction A 的 dbActiveCids 只能用"本机应该有的" cid:host_uuid IS NULL
  // (legacy 单机行)或 host_uuid === selfHostId。跨 host 行的 cid 不会出现在
  // 本机 docker.listContainers 里,纳入集合无害但语义不干净;真正的风险是
  // selfHostId 缺失时,如果还按 host_uuid 过滤,本机带 host_uuid 的 active row
  // 会被误排除 → 它们的 docker 容器被误判为本机孤儿删掉。selfHostId 缺失时
  // 退回原全集行为(包含所有 cid),不做 host-aware 缩集。
  const selfId = deps.selfHostId;
  const dbActiveCids = new Set(
    dbRows
      .filter((r) => {
        if (typeof selfId !== "string") return true; // selfHostId 缺失:全集兜底
        return r.host_uuid === null || r.host_uuid === "" || r.host_uuid === selfId;
      })
      .map((r) => r.container_internal_id)
      .filter((cid): cid is string => cid !== null && cid !== ""),
  );

  log?.debug?.("[v3/orphanReconcile] scan", {
    dockerContainers: dockerList.length,
    dbActiveRows: dbRows.length,
    dbActiveCids: dbActiveCids.size,
    skippedRecent: recentSkipped,
  });

  // direction A:删 docker 孤儿
  const dockerOrphansRemoved = await reconcileDockerOrphans(
    deps.docker, dockerList, dbActiveCids, stopTimeoutSec, errors, log,
  );

  // direction B:DB inspect → vanished
  const dbOrphansVanished = await reconcileDbOrphans(
    deps, dbRows, stopTimeoutSec, errors, log,
  );

  const durationMs = Date.now() - startedAt;
  if (
    dockerOrphansRemoved > 0 ||
    dbOrphansVanished > 0 ||
    errors.length > 0 ||
    recentSkipped > 0
  ) {
    log?.info?.("[v3/orphanReconcile] tick done", {
      dockerContainers: dockerList.length,
      dbActiveRows: dbRows.length,
      dockerOrphansRemoved,
      dbOrphansVanished,
      skippedRecent: recentSkipped,
      errors: errors.length,
      durationMs,
    });
  }

  return {
    scanned: {
      dockerContainers: dockerList.length,
      dbActiveRows: dbRows.length,
    },
    dockerOrphansRemoved,
    dbOrphansVanished,
    skippedRecent: recentSkipped,
    errors,
    durationMs,
  };
}

// ───────────────────────────────────────────────────────────────────────
// Scheduler:setInterval 串行版,完全对齐 v3idleSweep / v3volumeGc
// ───────────────────────────────────────────────────────────────────────

export function startOrphanReconcileScheduler(
  deps: V3SupervisorDeps,
  opts: StartOrphanReconcileSchedulerOptions = {},
): OrphanReconcileScheduler {
  const interval = opts.intervalMs ?? DEFAULT_ORPHAN_RECONCILE_INTERVAL_MS;
  const log = opts.logger;
  // §3H 默认 runOnStart=true(其他 sweeper 默认 false)
  const runOnStart = opts.runOnStart ?? true;
  let stopped = false;
  let inflight: Promise<OrphanReconcileTickResult> | null = null;
  let timer: NodeJS.Timeout | null = null;

  async function tickLoop(): Promise<void> {
    if (stopped) return;
    try {
      inflight = runOrphanReconcileTick(deps, opts);
      const r = await inflight;
      try { opts.onTick?.(r); } catch (err) {
        log?.warn?.("[v3/orphanReconcile] onTick callback threw", {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    } catch (err) {
      log?.error?.("[v3/orphanReconcile] tick threw", {
        err: err instanceof Error ? err.message : String(err),
      });
    } finally {
      inflight = null;
      if (!stopped) {
        timer = setTimeout(tickLoop, interval);
        if (typeof timer.unref === "function") timer.unref();
      }
    }
  }

  if (runOnStart) {
    void tickLoop();
  } else {
    timer = setTimeout(tickLoop, interval);
    if (typeof timer.unref === "function") timer.unref();
  }

  return {
    stop: async () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (inflight) {
        try { await inflight; } catch { /* tick 已经记日志 */ }
      }
    },
    runOnce: async () => {
      if (inflight) {
        try { await inflight; } catch { /* */ }
      }
      const p = runOrphanReconcileTick(deps, opts);
      inflight = p;
      try {
        const r = await p;
        return r;
      } finally {
        inflight = null;
      }
    },
  };
}
