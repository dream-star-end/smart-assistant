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
 * R6.11 Phase 2.C 改造:
 *   - `listActiveRows` SELECT 加 open-migration NOT EXISTS predicate(同 idleSweep) —
 *     mid-migration 行从 Direction B 视野排出去,让 §14.2.6 reconciler 单点持有。
 *   - Direction A 需要"补偿":listActiveRows 排掉了 mid-migration 行后,旧/新 host 上
 *     migration 中的 docker 容器会"漏出"dbActiveCids 集合,Direction A 会当它们 docker
 *     孤儿误删 — `listMidMigrationCids` 拉回 open ledger 两侧 cid 并入 dbActiveCids,
 *     按 host 维度过滤(selfHostId 注入时只关心本机 host 上的 cid)。
 *   - Direction B `stopAndRemoveV3Container` 走 `requireNoOpenMigration: true` 守卫
 *     SELECT-then-UPDATE 中间窗口(罕见:listActiveRows 之后才有 writer INSERT ledger),
 *     guard 拦截时不计入 vanished 也不计入 errors。
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
 * R6.11 Phase 2.C reader 二选一硬约束(§9 3M):本文件虽在 RECONCILER_WHITELIST 内,
 * 但 Direction B 的 stopAndRemoveV3Container 会把行翻 vanished + 跨 host docker stop+remove —
 * 在 **open migration 期间**这个动作必须让步给 §14.2.6 migration reconciler 单点持有,
 * 避免 orphan reconciler 把 migration 进行中的旧/新 host 容器误 stop。NOT EXISTS 命中
 * `agent_migrations_open_by_container_idx` partial index,99% 0 行场景 sub-ms。
 *
 * Direction A 保护见 `listMidMigrationCids` —— 这里 listActiveRows 把 mid-migration 行
 * 排出去之后,docker→DB 方向的 dbActiveCids 集合会"漏掉"mid-migration cid,如果不补,
 * Direction A 会把它们当 docker 孤儿 force-remove。
 */
async function listActiveRows(pool: Pool, batchLimit: number): Promise<DbActiveRow[]> {
  const r = await pool.query<{
    id: string;
    container_internal_id: string | null;
    host_uuid: string | null;
  }>(
    `SELECT id, container_internal_id, host_uuid
       FROM agent_containers c
      WHERE state = 'active'
        AND NOT EXISTS (
              SELECT 1 FROM agent_migrations m
               WHERE m.agent_container_id = c.id
                 AND m.phase NOT IN ('committed', 'rolled_back')
            )
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
 * 列所有 open migration(`phase NOT IN closed`)涉及的 docker container_internal_id
 * (新旧两侧 cid 都计入,过滤 NULL)。Direction A 用 — 防把 mid-migration 期间的旧/新
 * host 容器当 docker 孤儿误删。
 *
 * Host 路由:`selfHostId` 注入时按 host 维度过滤(只关心本机 host 上的 cid);
 * `selfHostId` 缺失时返全集 — 与 Direction A 的"selfId 缺失则不做 host-aware 缩集"
 * 兜底语义对齐(v3orphanReconcile.runOrphanReconcileTick 的 dbActiveCids 注释)。
 */
async function listMidMigrationCids(
  pool: Pool,
  selfHostId: string | undefined,
): Promise<Set<string>> {
  const params: unknown[] = [];
  let hostFilterSql = "";
  if (typeof selfHostId === "string" && selfHostId !== "") {
    params.push(selfHostId);
    hostFilterSql = `
        AND ( (old_container_internal_id IS NOT NULL AND old_host_id = $1)
           OR (new_container_internal_id IS NOT NULL AND new_host_id = $1) )`;
  }
  const r = await pool.query<{
    old_container_internal_id: string | null;
    new_container_internal_id: string | null;
    old_host_id: string;
    new_host_id: string;
  }>(
    `SELECT old_container_internal_id, new_container_internal_id, old_host_id, new_host_id
       FROM agent_migrations
      WHERE phase NOT IN ('committed', 'rolled_back')${hostFilterSql}`,
    params,
  );
  const out = new Set<string>();
  const selfId = typeof selfHostId === "string" && selfHostId !== "" ? selfHostId : null;
  for (const row of r.rows) {
    // selfHostId 注入时只把"本机 host 上"的 cid 入集 — 旧/新 host 各自判断
    if (row.old_container_internal_id && (selfId === null || row.old_host_id === selfId)) {
      out.add(row.old_container_internal_id);
    }
    if (row.new_container_internal_id && (selfId === null || row.new_host_id === selfId)) {
      out.add(row.new_container_internal_id);
    }
  }
  return out;
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
      // info 是 ContainerInspectInfo (docker, 大写 .State) 或 AgentContainerInspect (remote, 小写 .state) 联合
      if ("State" in info && info.State) {
        log?.debug?.("[v3/orphanReconcile] db row alive", {
          containerId: row.id,
          docker: cid,
          host_uuid: row.host_uuid,
          running: Boolean(info.State.Running),
        });
      } else if ("state" in info) {
        log?.debug?.("[v3/orphanReconcile] db row alive", {
          containerId: row.id,
          docker: cid,
          host_uuid: row.host_uuid,
          running: info.state === "running",
        });
      }
    } catch (err) {
      if (isNotFound(err)) {
        // 对应 host 上的容器确实消失 → 标 vanished。
        //
        // R6.11 Phase 2.C:listActiveRows 已用 NOT EXISTS 过滤了 mid-migration 行,
        // 但 SELECT 之后到此 inspect+vanish 之间仍可能有 writer INSERT ledger
        // (典型场景:user 触发 lazy migrate 期间,旧 host 容器已 docker rm 但新 host
        // 还没就绪)。requireNoOpenMigration 在 UPDATE 层兜底,返 false 时静默 skip
        // 不计入 vanished、不计入 errors — 让 reconciler 单点权威收敛。
        try {
          const ok = await stopAndRemoveV3Container(
            deps,
            {
              id: row.id,
              container_internal_id: cid,
              host_uuid: row.host_uuid,
            },
            stopTimeoutSec,
            { requireNoOpenMigration: true },
          );
          if (!ok) {
            log?.debug?.("[v3/orphanReconcile] db vanish skipped: open migration", {
              containerId: row.id,
              docker: cid,
              host_uuid: row.host_uuid,
            });
            continue;
          }
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

  // R6.11 Phase 2.C Direction A 保护:listActiveRows 用 NOT EXISTS 把 mid-migration
  // 行排掉了,如果不补,旧/新 host 上 migration 中的 docker 容器会被 Direction A
  // 当 docker 孤儿 force-remove(灾难性 — 旧容器 paused 中 / 新容器 created-not-started)。
  // 这里把 open migration 的两侧 cid 都加入 dbActiveCids 集合,Direction A `dbActiveCids.has(c.id)`
  // 检查就会跳过它们。listMidMigrationCids 内部按 host 维度过滤,只把本机 host 上
  // 的 cid 入集 — selfHostId 缺失时返全集,与 dbActiveCids 的 fallback 语义对齐。
  const midMigrationCids = await listMidMigrationCids(deps.pool, deps.selfHostId);
  for (const cid of midMigrationCids) dbActiveCids.add(cid);

  log?.debug?.("[v3/orphanReconcile] scan", {
    dockerContainers: dockerList.length,
    dbActiveRows: dbRows.length,
    dbActiveCids: dbActiveCids.size,
    midMigrationCids: midMigrationCids.size,
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
