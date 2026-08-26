/**
 * V3 Phase 3F — idle 30min stop+remove ephemeral 容器(MVP 单轨,无 mode 字段)。
 *
 * 见 docs/v3/02-DEVELOPMENT-PLAN.md §9.3 Task 3F / §13.3 tickIdleSweep。
 *
 * MVP 简化:
 *   - 0012 schema 没引入 mode 字段(双模式推迟到 P1),所有 v3 容器都是 ephemeral。
 *   - 单 host 单进程,不跨 host_id,不并发跑。
 *
 * R6.11 Phase 2.C 改造:
 *   - SELECT 加 open-migration NOT EXISTS predicate(`agent_migrations_open_by_container_idx`
 *     partial index 命中,99% 0 行场景 sub-ms);
 *   - markV3ContainerVanished 走 `requireNoOpenMigration: true` 守卫 UPDATE
 *     (writer 在 SELECT 之后 INSERT ledger 行),hit=false → 累加
 *     `racedWithMigration` 计数,**不**计入 swept 也**不**计入 errors。
 *
 * v5-safe 偿还(per-uid lock + FOR UPDATE 重读 last_ws_activity + turn 屏障):
 *   - 每行 BEGIN → tryAcquireUserLifecycleLock(nowait) → 事务内 FOR UPDATE 重读
 *     last_ws_activity,不满足 idle → racedWithActivity++;
 *   - 仍 idle 则照抄 admin drainV3BeforeAdminMutation 的 turn 屏障
 *     (getV3ContainerStatus + requestRuntimeRecycleDrain),busy/failed fail-closed;
 *   - drain accepted 后**同一 client** 做守卫 UPDATE 翻 vanished → COMMIT →
 *     release → 事务外 docker stop/remove。破坏性 UPDATE 不得换连接,否则行锁
 *     被 account-pool 等 FOR UPDATE 抢走时可能排队超过 drain 10s TTL,把新 turn 杀掉。
 *   - docker 失败不回滚 DB(意图优先,残骸 orphanReconcile),记 errors。
 *
 * 语义:
 *   每 60s 跑一次,扫 `state='active' AND last_ws_activity < NOW() - INTERVAL N min`,
 *   命中行在持锁事务内 markV3ContainerVanished,COMMIT 后再 docker stop/remove。
 *   单行失败不影响其他行(每行独立 try/catch),但聚合 errors[] 给 caller 上报。
 *
 * `last_ws_activity` 何时被刷:
 *   1. provision 时初始化为 NOW()(v3supervisor.allocateBoundIpAndInsertRow)
 *   2. ensureRunning(uid) 命中 'running' 分支 → markV3ContainerActivity 刷新
 *   3. bridge 内 client→container 帧 60s debounce 写一次
 *   4. bridge 存活期间每 5 分钟刷一次(开着标签页的连接本身就算活跃:扫掉容器
 *      会被前端 ~2s 重连并重新 provision,换不来容量只产生 churn。
 *      container→user 下行帧和心跳**仍不刷**)
 *
 * 不在本文件管:
 *   - mode='persistent' 健康巡检(MVP 没 mode,推迟到 P1 tickPersistentHealth)
 *   - orphan 容器 reconcile(3H,每 1h 扫 docker ps -a vs PG 行)
 *   - volume GC(3G,banned 7d / no-login 90d)
 *
 * 调度模式参考 agent/lifecycle.ts startLifecycleScheduler:
 *   - 自家 setInterval,不引 node-cron(只一个 tick)
 *   - tick 之间 await 完再排下一个,避免并发扫描
 *   - stop() 等已在跑的 tick 结束,之后不再排
 *   - runOnce() 串行触发(测试用)
 */

import type { Pool, PoolClient } from "pg";
import { getRuntimeChannel } from "../runtimeChannel.js";

import { requestRuntimeRecycleDrain } from "./v3ensureRunning.js";
import {
  cleanupV3ContainerDocker,
  getV3ContainerStatus,
  markV3ContainerVanished,
  tryAcquireUserLifecycleLock,
  type V3SupervisorDeps,
} from "./v3supervisor.js";

// ───────────────────────────────────────────────────────────────────────
// 默认常量
// ───────────────────────────────────────────────────────────────────────

/** 默认调度间隔(60s) */
export const DEFAULT_IDLE_SWEEP_INTERVAL_MS = 60_000;

/** 默认 idle 阈值:30 分钟。boss R5c 拍板。 */
export const DEFAULT_IDLE_CUTOFF_MIN = 30;

/** 单次 tick 最多 stopAndRemove 多少行(防一次扫上千个把 docker daemon 打爆) */
export const DEFAULT_SWEEP_BATCH_LIMIT = 100;

/** 首轮上线限流:生产曾积 49 个 stale,20/轮 × 60s ≈ 两三轮清空,避免 docker 风暴。 */
export const INITIAL_SWEEP_BATCH_LIMIT = 20;

/** stopAndRemove 单行 docker stop 的超时(秒);默认 5s 跟 supervisor 一致 */
const STOP_TIMEOUT_SEC = 5;

// ───────────────────────────────────────────────────────────────────────
// 公共类型
// ───────────────────────────────────────────────────────────────────────

export interface IdleSweepLogger {
  debug?(message: string, meta?: Record<string, unknown>): void;
  info?(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
  error?(message: string, meta?: Record<string, unknown>): void;
}

export interface IdleSweepTickOptions {
  /** idle 阈值(分钟),默认 30 */
  idleCutoffMin?: number;
  /** 单 tick 处理上限,默认 100 */
  batchLimit?: number;
  /** logger,缺省静默 */
  logger?: IdleSweepLogger;
}

export interface IdleSweepTickResult {
  /** 本次 tick 扫到多少 stale 行 */
  scanned: number;
  /** 成功 stopAndRemove 的行数 */
  swept: number;
  /**
   * SELECT-then-UPDATE 之间被并发 INSERT migration ledger 抢占的行数。
   * `markV3ContainerVanished({ requireNoOpenMigration: true })` hit=false 时累加,
   * 不计入 `swept`(没真正 vanish)、不计入 `errors`(不是错,是合法让步)。
   *
   * 持续 > 0 表示有 migration writer 上线后 idle sweep 与 reconciler 在抢同一行,
   * 是 R6.11 设计预期的让步,不需告警;只在突刺时帮助定位是哪台 host 的 reconciler
   * 慢导致 sweeper 多轮空跑。
   */
  racedWithMigration: number;
  /**
   * FOR UPDATE 重读时 last_ws_activity 已不再满足 idle(用户在 SELECT 之后重连)。
   * 不计入 swept / errors。
   */
  racedWithActivity: number;
  /** per-uid lifecycle 锁 nowait 未拿到(provision/volumeGc 持有)。不计入 swept / errors。 */
  skippedLocked: number;
  /** drain 返回 busy(容器内有在飞 turn)。不计入 swept / errors。 */
  skippedBusy: number;
  /** drain 返回 failed。fail-closed,不 vanish。不计入 swept / errors。 */
  skippedDrainFailed: number;
  /**
   * getV3ContainerStatus 为空 / containerId 或 docker id 与行不一致 / provisioning。
   * 不计入 swept / errors。
   */
  skippedGeneration: number;
  /** 失败的行 + 原因(不抛,聚合返回) */
  errors: Array<{ containerId: number; error: string }>;
  /** tick 总耗时 ms(含 SELECT + 所有 stopAndRemove) */
  durationMs: number;
}

export interface StartIdleSweepSchedulerOptions extends IdleSweepTickOptions {
  /** 两次 tick 间隔(ms),默认 60000 */
  intervalMs?: number;
  /** 启动时是否立刻跑一次。默认 false,留余量给 gateway 启动 */
  runOnStart?: boolean;
  /** 每次 tick 完成的回调(metrics / observability 接入点) */
  onTick?: (r: IdleSweepTickResult) => void;
}

export interface IdleSweepScheduler {
  /** 立刻终止调度。已在跑的 tick 会跑完,但之后不再排下一次。 */
  stop: () => Promise<void>;
  /** 手动触发一次 tick(绕过定时器);若已有 tick 在跑会等它完再跑新的 */
  runOnce: () => Promise<IdleSweepTickResult>;
}

// ───────────────────────────────────────────────────────────────────────
// SELECT — 找出 stale active 行
// ───────────────────────────────────────────────────────────────────────

interface StaleRow {
  id: number;
  userId: number;
  container_internal_id: string | null;
}

/**
 * 扫 state='active' 且 last_ws_activity < cutoff 的行。
 *
 * R6.11 Phase 2.C 落地 reader 二选一硬约束(§9 3M):本文件虽在 RECONCILER_WHITELIST 内,
 * 但 docker start / stop 在 **open migration 期间**必须由 §14.2.6 migration reconciler
 * 单点持有 — idle sweep 看到 `agent_migrations` 有 open(non-terminal)行的 container
 * **必须**让步,避免与 reconciler 抢同一个容器的 docker stop+remove。
 *
 * 用 NOT EXISTS 而不是 LEFT JOIN:`agent_migrations_open_by_container_idx` 是
 * `WHERE phase NOT IN closed` 的 partial index,NOT EXISTS 形态能直接命中,99% 0 行
 * 场景 sub-ms;LEFT JOIN 强迫 PG 走 hash 或 nested loop,代价更高。
 *
 * SELECT-then-stopAndRemove 中间还可能有竞态(writer 在 SELECT 后 INSERT ledger):
 * 走 `markV3ContainerVanished(..., { requireNoOpenMigration: true })` 在 UPDATE 层
 * 用同一个 NOT EXISTS predicate 二次兜底,hit=false → racedWithMigration++。
 *
 * 用 `LIMIT batchLimit` 防一次扫太多;下一轮 60s 后还会跑,慢慢清空也无妨。
 */
async function selectStaleRows(
  pool: Pool,
  idleCutoffMin: number,
  batchLimit: number,
): Promise<StaleRow[]> {
  const r = await pool.query<{
    id: string;
    user_id: string;
    container_internal_id: string | null;
  }>(
    // P1a 隔离:只扫本 channel 容器 —— v3 idle sweep 不得碰 v5 行(反之亦然)。
    `SELECT id, container_internal_id, user_id
       FROM agent_containers c
      WHERE state = 'active'
        AND c.runtime_channel = $3::text
        AND last_ws_activity IS NOT NULL
        AND last_ws_activity < NOW() - ($1::int * interval '1 minute')
        AND NOT EXISTS (
              SELECT 1 FROM agent_migrations m
               WHERE m.agent_container_id = c.id
                 AND m.phase NOT IN ('committed', 'rolled_back')
            )
      ORDER BY last_ws_activity ASC
      LIMIT $2::int`,
    [idleCutoffMin, batchLimit, getRuntimeChannel()],
  );
  return r.rows.map((row) => ({
    id: Number.parseInt(row.id, 10),
    userId: Number.parseInt(row.user_id, 10),
    container_internal_id: row.container_internal_id,
  }));
}

type RowSkipReason =
  | "racedWithActivity"
  | "skippedLocked"
  | "skippedBusy"
  | "skippedDrainFailed"
  | "skippedGeneration"
  | "racedWithMigration";

type RowOutcome =
  | { kind: "swept" }
  | { kind: "skip"; reason: RowSkipReason };

async function stillIdleLocked(
  client: PoolClient,
  row: StaleRow,
  idleCutoffMin: number,
): Promise<boolean> {
  const r = await client.query<{ id: string }>(
    `SELECT id
       FROM agent_containers
      WHERE id = $1::bigint
        AND runtime_channel = $2::text
        AND state = 'active'
        AND last_ws_activity IS NOT NULL
        AND last_ws_activity < NOW() - ($3::int * interval '1 minute')
      FOR UPDATE`,
    [String(row.id), getRuntimeChannel(), idleCutoffMin],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * 照抄 admin/containers.ts drainV3BeforeAdminMutation 的 turn 屏障,
 * 但 skip 而不是 throw(sweep 不能因一行 busy 打断整轮)。
 *
 * 不套 isV5Channel():本调度器挂在商业/自用 v5 与 v3 channel 都会跑,
 * 单测默认 v3;turn 屏障对两套都成立。
 */
async function turnBarrierSkipReason(
  deps: V3SupervisorDeps,
  row: StaleRow,
): Promise<RowSkipReason | null> {
  const status = await getV3ContainerStatus(deps, row.userId);
  if (!status || status.containerId !== row.id) return "skippedGeneration";
  if (status.state === "provisioning") return "skippedGeneration";
  if (status.state !== "running") return null;
  if (status.dockerContainerId !== (row.container_internal_id ?? "")) {
    return "skippedGeneration";
  }
  const drained = deps.adminRuntimeRecycleDrain
    ? await deps.adminRuntimeRecycleDrain(status)
    : await requestRuntimeRecycleDrain(deps, status);
  if (drained === "accepted") return null;
  if (drained === "busy") return "skippedBusy";
  return "skippedDrainFailed";
}

/**
 * stopAndRemove 守卫 UPDATE 命中 0 行时的廉价分类。只走这条罕见分支。
 * 查询失败回退 racedWithMigration,不把整行打进 errors。
 */
async function classifyStopMiss(
  client: PoolClient,
  row: StaleRow,
  idleCutoffMin: number,
): Promise<RowSkipReason> {
  try {
    // 仍持行锁:同一 client 上读到的就是此刻确定答案,不必再走 deps.pool。
    const r = await client.query<{
      state: string;
      last_ws_activity: Date | null;
      container_internal_id: string | null;
      open_migration: boolean;
    }>(
      `SELECT c.state,
              c.last_ws_activity,
              c.container_internal_id,
              EXISTS (
                SELECT 1 FROM agent_migrations m
                 WHERE m.agent_container_id = c.id
                   AND m.phase NOT IN ('committed', 'rolled_back')
              ) AS open_migration
         FROM agent_containers c
        WHERE c.id = $1::bigint
          AND c.runtime_channel = $2::text`,
      [String(row.id), getRuntimeChannel()],
    );
    if ((r.rowCount ?? 0) === 0) return "skippedGeneration";
    const rec = r.rows[0]!;
    if (rec.state !== "active") return "skippedGeneration";
    const cidNow = rec.container_internal_id ?? null;
    const cidExpect = row.container_internal_id ?? null;
    if (cidNow !== cidExpect) return "skippedGeneration";
    const cutoff = Date.now() - idleCutoffMin * 60_000;
    const activityMs = rec.last_ws_activity == null
      ? null
      : new Date(rec.last_ws_activity).getTime();
    if (activityMs == null || activityMs >= cutoff) return "racedWithActivity";
    const openMig: unknown = rec.open_migration;
    if (openMig === true || openMig === "t") return "racedWithMigration";
    return "skippedGeneration";
  } catch {
    return "racedWithMigration";
  }
}

/**
 * 单行:BEGIN → try lock → FOR UPDATE 重读 → turn 屏障 → 同一 client 守卫 UPDATE
 * → COMMIT → **立刻 release** → 事务外 docker stop/remove。
 *
 * 破坏性 UPDATE 必须留在持锁事务内:换连接会跟 account-pool 等 FOR UPDATE 路径
 * 排队,可能超过 drain 10s TTL。idle 谓词由 requireIdleCutoffMin 在 UPDATE 上兜底。
 * docker 失败不回滚(DB 意图已 COMMIT),向上抛给 tick 记 errors。
 */
async function sweepOneRow(
  deps: V3SupervisorDeps,
  row: StaleRow,
  idleCutoffMin: number,
  log: IdleSweepLogger | undefined,
): Promise<RowOutcome> {
  const client = await deps.pool.connect();
  let txOpen = false;
  let released = false;
  const releaseNow = (): void => {
    if (released) return;
    released = true;
    client.release();
  };
  try {
    await client.query("BEGIN");
    txOpen = true;
    const locked = await tryAcquireUserLifecycleLock(client, row.userId);
    if (!locked) {
      await client.query("ROLLBACK");
      txOpen = false;
      return { kind: "skip", reason: "skippedLocked" };
    }
    const idle = await stillIdleLocked(client, row, idleCutoffMin);
    if (!idle) {
      await client.query("COMMIT");
      txOpen = false;
      return { kind: "skip", reason: "racedWithActivity" };
    }
    const barrier = await turnBarrierSkipReason(deps, row);
    if (barrier) {
      await client.query("COMMIT");
      txOpen = false;
      return { kind: "skip", reason: barrier };
    }
    // drain 成功只 arm 10s TTL —— 同一 client 立刻翻 vanished,再 COMMIT。
    const vanished = await markV3ContainerVanished(
      client,
      { id: row.id, container_internal_id: row.container_internal_id },
      { requireNoOpenMigration: true, requireIdleCutoffMin: idleCutoffMin },
    );
    if (!vanished.hit) {
      const reason = await classifyStopMiss(client, row, idleCutoffMin);
      await client.query("COMMIT");
      txOpen = false;
      log?.debug?.("[v3/idleSweep] skipped after guarded UPDATE miss", {
        containerId: row.id, reason,
      });
      return { kind: "skip", reason };
    }
    await client.query("COMMIT");
    txOpen = false;
    // COMMIT 后立刻还连接,禁止攥着空闲 pg client 直到 docker 结束。
    releaseNow();
    await cleanupV3ContainerDocker(
      deps,
      { id: row.id, container_internal_id: row.container_internal_id },
      STOP_TIMEOUT_SEC,
      vanished.hostUuid,
    );
    return { kind: "swept" };
  } catch (err) {
    if (txOpen) {
      try { await client.query("ROLLBACK"); } catch { /* swallow */ }
      txOpen = false;
    }
    throw err;
  } finally {
    releaseNow();
  }
}


// ───────────────────────────────────────────────────────────────────────
// 单次 tick:scan + stop+remove
// ───────────────────────────────────────────────────────────────────────

/**
 * 跑一轮 idle sweep:scan + 对每个 stale 行调 stopAndRemove。
 *
 * 单行失败:catch 后塞 errors[],继续下一行(不抛,不影响 scheduler)。
 * SELECT 失败:throw(scheduler 把它记 error 后排下一次)。
 */
export async function runIdleSweepTick(
  deps: V3SupervisorDeps,
  options: IdleSweepTickOptions = {},
): Promise<IdleSweepTickResult> {
  const idleCutoffMin = options.idleCutoffMin ?? DEFAULT_IDLE_CUTOFF_MIN;
  const batchLimit = options.batchLimit ?? DEFAULT_SWEEP_BATCH_LIMIT;
  const log = options.logger;

  const startedAt = Date.now();
  const errors: IdleSweepTickResult["errors"] = [];
  let swept = 0;
  let racedWithMigration = 0;
  let racedWithActivity = 0;
  let skippedLocked = 0;
  let skippedBusy = 0;
  let skippedDrainFailed = 0;
  let skippedGeneration = 0;

  const stale = await selectStaleRows(deps.pool, idleCutoffMin, batchLimit);
  log?.debug?.("[v3/idleSweep] scan", {
    scanned: stale.length,
    cutoffMin: idleCutoffMin,
    batchLimit,
  });

  for (const row of stale) {
    try {
      const outcome = await sweepOneRow(deps, row, idleCutoffMin, log);
      if (outcome.kind === "swept") {
        swept++;
        continue;
      }
      switch (outcome.reason) {
        case "racedWithMigration": racedWithMigration++; break;
        case "racedWithActivity": racedWithActivity++; break;
        case "skippedLocked": skippedLocked++; break;
        case "skippedBusy": skippedBusy++; break;
        case "skippedDrainFailed": skippedDrainFailed++; break;
        case "skippedGeneration": skippedGeneration++; break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ containerId: row.id, error: msg });
      log?.warn?.("[v3/idleSweep] stopAndRemove failed", {
        containerId: row.id, err: msg,
      });
    }
  }

  const durationMs = Date.now() - startedAt;
  const skipped =
    racedWithMigration + racedWithActivity + skippedLocked
    + skippedBusy + skippedDrainFailed + skippedGeneration;
  if (stale.length > 0 || errors.length > 0 || skipped > 0) {
    log?.info?.("[v3/idleSweep] tick done", {
      scanned: stale.length,
      swept,
      racedWithMigration,
      racedWithActivity,
      skippedLocked,
      skippedBusy,
      skippedDrainFailed,
      skippedGeneration,
      errors: errors.length,
      durationMs,
    });
  }
  return {
    scanned: stale.length,
    swept,
    racedWithMigration,
    racedWithActivity,
    skippedLocked,
    skippedBusy,
    skippedDrainFailed,
    skippedGeneration,
    errors,
    durationMs,
  };
}

// ───────────────────────────────────────────────────────────────────────
// Scheduler:setInterval 串行版,模仿 agent/lifecycle.ts startLifecycleScheduler
// ───────────────────────────────────────────────────────────────────────

export function startIdleSweepScheduler(
  deps: V3SupervisorDeps,
  opts: StartIdleSweepSchedulerOptions = {},
): IdleSweepScheduler {
  const interval = opts.intervalMs ?? DEFAULT_IDLE_SWEEP_INTERVAL_MS;
  const log = opts.logger;
  let stopped = false;
  let inflight: Promise<IdleSweepTickResult> | null = null;
  let timer: NodeJS.Timeout | null = null;

  async function tickLoop(): Promise<void> {
    if (stopped) return;
    try {
      inflight = runIdleSweepTick(deps, opts);
      const r = await inflight;
      try { opts.onTick?.(r); } catch (err) {
        log?.warn?.("[v3/idleSweep] onTick callback threw", {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    } catch (err) {
      // 整个 tick fail(SELECT 抛 / 其它)— 不让 scheduler 停摆,记日志后排下一次
      log?.error?.("[v3/idleSweep] tick threw", {
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

  if (opts.runOnStart) {
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
        // 已有 tick 在跑,等它完再跑新的(保持串行)
        try { await inflight; } catch { /* */ }
      }
      const p = runIdleSweepTick(deps, opts);
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
