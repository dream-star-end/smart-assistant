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
 *   - stopAndRemoveV3Container 走 `requireNoOpenMigration: true` 守卫 SELECT-then-UPDATE
 *     race(writer 在 SELECT 之后 INSERT ledger 行),guard 拦截时返 false → 累加
 *     `racedWithMigration` 计数,**不**计入 swept 也**不**计入 errors。
 *
 * 语义:
 *   每 60s 跑一次,扫 `state='active' AND last_ws_activity < NOW() - INTERVAL N min`,
 *   命中行调用 supervisor.stopAndRemoveV3Container(标 vanished + 删 docker)。
 *   单行失败不影响其他行(每行独立 try/catch),但聚合 errors[] 给 caller 上报。
 *
 * `last_ws_activity` 何时被刷:
 *   1. provision 时初始化为 NOW()(v3supervisor.allocateBoundIpAndInsertRow)
 *   2. ensureRunning(uid) 命中 'running' 分支 → markV3ContainerActivity 刷新
 *   3. (TODO P1)bridge 内传输每 N 秒 debounce 写一次,避免长 ws 一直在使用却被误杀
 *      — MVP 接受"长 ws 单连超 30min 会被误杀"的窗口(用户重连即重 provision,
 *      数据全在 volume 里不丢);P1 接 telemetry 屏障再补。
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

import type { Pool } from "pg";
import { getRuntimeChannel } from "../runtimeChannel.js";

import {
  stopAndRemoveV3Container,
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
   * `stopAndRemoveV3Container({ requireNoOpenMigration: true })` 返 false 时累加,
   * 不计入 `swept`(没真正 vanish)、不计入 `errors`(不是错,是合法让步)。
   *
   * 持续 > 0 表示有 migration writer 上线后 idle sweep 与 reconciler 在抢同一行,
   * 是 R6.11 设计预期的让步,不需告警;只在突刺时帮助定位是哪台 host 的 reconciler
   * 慢导致 sweeper 多轮空跑。
   */
  racedWithMigration: number;
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
 * 走 `stopAndRemoveV3Container(..., { requireNoOpenMigration: true })` 在 UPDATE 层
 * 用同一个 NOT EXISTS predicate 二次兜底,rowCount=0 → 返 false → racedWithMigration++。
 *
 * 用 `LIMIT batchLimit` 防一次扫太多;下一轮 60s 后还会跑,慢慢清空也无妨。
 */
async function selectStaleRows(
  pool: Pool,
  idleCutoffMin: number,
  batchLimit: number,
): Promise<StaleRow[]> {
  const r = await pool.query<{ id: string; container_internal_id: string | null }>(
    // P1a 隔离:只扫本 channel 容器 —— v3 idle sweep 不得碰 v5 行(反之亦然)。
    `SELECT id, container_internal_id
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
    container_internal_id: row.container_internal_id,
  }));
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

  const stale = await selectStaleRows(deps.pool, idleCutoffMin, batchLimit);
  log?.debug?.("[v3/idleSweep] scan", {
    scanned: stale.length,
    cutoffMin: idleCutoffMin,
    batchLimit,
  });

  for (const row of stale) {
    try {
      const ok = await stopAndRemoveV3Container(
        deps,
        { id: row.id, container_internal_id: row.container_internal_id },
        STOP_TIMEOUT_SEC,
        { requireNoOpenMigration: true },
      );
      if (ok) {
        swept++;
      } else {
        // SELECT 之后、UPDATE 之前 migration writer INSERT 了一条 open ledger,
        // sweep 让步给 reconciler 单点处理 — 不是错,也不算 swept,只累加 race 计数。
        racedWithMigration++;
        log?.debug?.("[v3/idleSweep] skipped: open migration ledger present", {
          containerId: row.id,
        });
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
  if (stale.length > 0 || errors.length > 0 || racedWithMigration > 0) {
    log?.info?.("[v3/idleSweep] tick done", {
      scanned: stale.length,
      swept,
      racedWithMigration,
      errors: errors.length,
      durationMs,
    });
  }
  return { scanned: stale.length, swept, racedWithMigration, errors, durationMs };
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
