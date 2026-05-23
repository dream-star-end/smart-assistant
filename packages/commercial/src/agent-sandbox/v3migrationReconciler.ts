/**
 * V3 R6.11 §14.2.6 — agent_migrations stale ledger reconciler(Phase 2.C MVP)。
 *
 * 设计参考 v3orphanReconcile.ts 的 scheduler 形态(setInterval 串行 + runOnStart
 * + stop awaits inflight + runOnce hook)。
 *
 * 范围(Phase 2.C):
 *   - **INV-10 兜底落地**:`phase='planned'` + updated_at 超 `staleSec` → markRolledBack
 *     +(pausedAt 非空时)unpause 旧容器。`agent_containers` 行 state/host_id 全程不动 —
 *     planned 阶段尚未 ⑥c PG flip,行原地仍属 old host。新 host 上可能残留一个
 *     `created-not-started` 容器(⑤ docker create 已落但 ⑤bis UPDATE 之前崩),交
 *     §3H docker orphan reconciler(`v3orphanReconcile.ts`)兜底,本文件**不**测也**不**调
 *     docker remove —— 两条 sweep 路径解耦是 R6.11 设计明确划分(02-DEVELOPMENT-PLAN.md:1935-1948)。
 *
 *   - **非 planned phase 静默 skip**(MVP 兜底,留 ledger 等下轮):
 *       `created`/`detached`/`attached_pre`/`attached_route`/`started` 这 5 个 phase 涉及
 *     跨 host docker 写、§14.2.4 ⑥c PG flip 反向、`pollHostAgentApplyVersion` re-fire ACK
 *     等复杂动作(详见 02-DEVELOPMENT-PLAN.md §14.2.6 1949-2040 行)。Phase 2.C MVP **不**
 *     实现这些 recovery,仅 `skippedPhases[phase]++` + warn-log,留 ledger 等 Phase 2.D。
 *
 *     **关键**:这条"静默 skip"路径不打破 INV-2"open migration 期间 docker start 单点
 *     归 reconciler" —— 因为 MVP 期间整条迁移 writer 路径(§14.2.4)也尚未落地,实际不可能
 *     有非 planned phase 的 stale 行进入 reconciler 视野;真正写入 created/detached/...
 *     的 writer 上线时,reconciler 的对应 case 必须同步实现。本文件 warn-log 是预防性兜底,
 *     不是设计契约。
 *
 *   - **单 host 守门**(MVP 必要简化):`oldHostId !== selfHostId`(且 selfHostId 注入)→
 *     `skippedRemote++` + 跳过。MVP 期间 reconciler 只处理本机 host 上的 unpause docker
 *     操作;跨 host 路由的 docker action 留待 Phase 2.D 引入 `containerService.unpause`
 *     / remote start API 时一并实现。
 *
 * 不在本文件管(Phase 2.D 起):
 *   - INV-7:`phase='attached_route'` 恢复必须 INCREMENT host_state_version → NOTIFY →
 *     pollHostAgentApplyVersion → docker start。MVP schema 没 `host_state_version` 列、
 *     `pollHostAgentApplyVersion` 实现也不存在,Phase 2.D 一并落。
 *   - `created`/`detached` 的 docker create 残留清理(02-DEVELOPMENT-PLAN.md:1949-1955)。
 *   - `attached_pre`/`started` 的旧 host paused 容器 force remove(02-DEVELOPMENT-PLAN.md:1981)。
 *
 * 调度契约:
 *   - **runOnStart 默认 true**(02-DEVELOPMENT-PLAN.md:2093 "supervisor 进程启动 immediate
 *     跑一次"硬约束) — 进程崩重启时立刻补一次,不等首个 60s tick。
 *   - 默认间隔 60s。
 *   - 单 tick 失败:catch + log,scheduler 不停摆。
 *   - 单行失败:catch + push errors[],不影响其他行(同 idleSweep / orphanReconcile)。
 */

import type Docker from "dockerode";

import {
  listStale,
  markRolledBack,
  MigrationGuardError,
  type MigrationPhase,
  type MigrationRow,
} from "./v3migrationLedger.js";
import type { V3SupervisorDeps } from "./v3supervisor.js";

// ───────────────────────────────────────────────────────────────────────
// 默认常量
// ───────────────────────────────────────────────────────────────────────

/** 默认 tick 间隔(60s)。 */
export const DEFAULT_MIGRATION_RECONCILE_INTERVAL_MS = 60_000;

/**
 * 默认 migration stale 阈值(秒)。
 *
 * 对齐 02-DEVELOPMENT-PLAN.md:2096 `supervisor_stale_migrate_threshold_sec` 默认 600s —
 * 覆盖 §14.2.4 完整迁移 ≤ 10min 的预期最大时长,超过即认定 supervisor 中途崩。
 */
export const DEFAULT_MIGRATION_STALE_SEC = 600;

/** docker unpause 单次超时(秒)。dockerode unpause 无 timeout 入参,这里只用于 log 标识。 */
const UNPAUSE_TIMEOUT_SEC = 5;

// ───────────────────────────────────────────────────────────────────────
// 公共类型
// ───────────────────────────────────────────────────────────────────────

export interface MigrationReconcileLogger {
  debug?(message: string, meta?: Record<string, unknown>): void;
  info?(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
  error?(message: string, meta?: Record<string, unknown>): void;
}

export interface MigrationReconcileTickOptions {
  /**
   * stale 阈值(秒)。MVP 默认 600(`supervisor_stale_migrate_threshold_sec`)。
   * 测试可注入小值快速触发。
   */
  staleSec?: number;
  /** logger */
  logger?: MigrationReconcileLogger;
}

export interface MigrationReconcileTickResult {
  /** 本次 tick `listStale` 返回的行数 */
  scanned: number;
  /** phase='planned' 成功 markRolledBack 的行数(含 paused 已 unpause 的) */
  recoveredPlanned: number;
  /** unpause 旧容器抛错的次数(best-effort,不影响 rolled_back) */
  unpauseFailures: number;
  /**
   * 非 planned phase 的静默 skip 计数(MVP 不动 ledger / docker)。
   * key=phase,value=count;Partial 是因为不一定每个 phase 都出现。
   */
  skippedPhases: Partial<Record<MigrationPhase, number>>;
  /** oldHostId !== selfHostId 被跳过的行数(MVP 跨 host docker 不动) */
  skippedRemote: number;
  /** 单行硬失败(markRolledBack 抛非 MigrationGuardError 之外的错)聚合 */
  errors: Array<{ migrationId: string; error: string }>;
  /** tick 总耗时 ms */
  durationMs: number;
}

export interface StartMigrationReconcileSchedulerOptions extends MigrationReconcileTickOptions {
  /** 两次 tick 间隔(ms),默认 60_000 */
  intervalMs?: number;
  /**
   * 启动时是否立刻跑。**默认 true** — 02-DEVELOPMENT-PLAN.md:2093 硬约束:
   * "supervisor 进程启动 immediate 跑一次(进程崩重启的主路径)"。
   */
  runOnStart?: boolean;
  /** 每次 tick 完成回调(metrics 接入点) */
  onTick?: (r: MigrationReconcileTickResult) => void;
}

export interface MigrationReconcileScheduler {
  stop: () => Promise<void>;
  runOnce: () => Promise<MigrationReconcileTickResult>;
}

// ───────────────────────────────────────────────────────────────────────
// 内部 helpers
// ───────────────────────────────────────────────────────────────────────

/**
 * best-effort unpause:dockerode 抛任何错都吞掉(容器可能已 missing / 已 unpaused),
 * 真正失败也不阻断 markRolledBack —— ledger 终态语义优先。
 *
 * 返回 true = unpause 调用未抛;false = 抛了(unpauseFailures++)。
 * dockerode `.unpause()` 不接 timeout 入参,UNPAUSE_TIMEOUT_SEC 只用于 log 标识。
 */
async function tryUnpause(
  docker: Docker,
  containerInternalId: string,
  log: MigrationReconcileLogger | undefined,
): Promise<boolean> {
  try {
    await docker.getContainer(containerInternalId).unpause();
    log?.debug?.("[v3/migrationReconciler] unpaused old container", {
      cid: containerInternalId,
    });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.warn?.("[v3/migrationReconciler] unpause failed (best-effort)", {
      cid: containerInternalId,
      err: msg,
      timeoutSec: UNPAUSE_TIMEOUT_SEC,
    });
    return false;
  }
}

/**
 * 处理单条 `phase='planned'` stale 行:
 *   1. pausedAt 非空 → tryUnpause(unpauseFailures 累加)
 *   2. markRolledBack(MigrationGuardError 静默吞 — 行已 terminal 是 OK 状态;
 *      其它错抛给上层进 errors[])
 *
 * agent_containers 行**不**触碰 — planned 阶段 ⑥c PG flip 还没发生,行
 * state/host_id 仍是 old,无须修(02-DEVELOPMENT-PLAN.md:1941)。
 */
async function recoverPlannedRow(
  deps: V3SupervisorDeps,
  row: MigrationRow,
  log: MigrationReconcileLogger | undefined,
  result: MigrationReconcileTickResult,
): Promise<void> {
  if (row.pausedAt !== null) {
    const ok = await tryUnpause(deps.docker, row.oldContainerInternalId, log);
    if (!ok) result.unpauseFailures++;
  }
  try {
    await markRolledBack(row.id);
    result.recoveredPlanned++;
    log?.info?.("[v3/migrationReconciler] recovered planned migration", {
      migrationId: row.id.toString(),
      agentContainerId: row.agentContainerId.toString(),
      pausedAtRecovered: row.pausedAt !== null,
    });
  } catch (err) {
    if (err instanceof MigrationGuardError) {
      // 终态守卫拦截 — 行已 committed/rolled_back(下个 tick 还会扫一次但
      // `listStale` 已过滤掉,实际不会触发)。debug 一下不抛。
      log?.debug?.("[v3/migrationReconciler] markRolledBack hit terminal guard", {
        migrationId: row.id.toString(),
      });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push({ migrationId: row.id.toString(), error: msg });
    log?.warn?.("[v3/migrationReconciler] markRolledBack failed", {
      migrationId: row.id.toString(),
      err: msg,
    });
  }
}

// ───────────────────────────────────────────────────────────────────────
// 单次 tick
// ───────────────────────────────────────────────────────────────────────

/**
 * 跑一轮 migration ledger reconcile。
 *
 * `listStale` 抛 → throw(scheduler 排下次);单行抛 → errors[] 不打断。
 */
export async function runMigrationReconcileTick(
  deps: V3SupervisorDeps,
  options: MigrationReconcileTickOptions = {},
): Promise<MigrationReconcileTickResult> {
  const staleSec = options.staleSec ?? DEFAULT_MIGRATION_STALE_SEC;
  const log = options.logger;
  const startedAt = Date.now();

  const result: MigrationReconcileTickResult = {
    scanned: 0,
    recoveredPlanned: 0,
    unpauseFailures: 0,
    skippedPhases: {},
    skippedRemote: 0,
    errors: [],
    durationMs: 0,
  };

  const stale = await listStale(staleSec);
  result.scanned = stale.length;
  log?.debug?.("[v3/migrationReconciler] scan", {
    scanned: stale.length,
    staleSec,
  });

  for (const row of stale) {
    // 单 host MVP 守门:跨 host 行的 docker 动作(unpause)留待 Phase 2.D
    // remote API 上线再处理。selfHostId 缺失时退回不区分(legacy 单机模式)。
    if (
      typeof deps.selfHostId === "string"
      && deps.selfHostId !== ""
      && row.oldHostId !== deps.selfHostId
    ) {
      result.skippedRemote++;
      log?.debug?.("[v3/migrationReconciler] skip remote oldHost", {
        migrationId: row.id.toString(),
        phase: row.phase,
        oldHostId: row.oldHostId,
        selfHostId: deps.selfHostId,
      });
      continue;
    }

    if (row.phase === "planned") {
      await recoverPlannedRow(deps, row, log, result);
      continue;
    }

    // Phase 2.C MVP:非 planned phase 静默 skip(留 ledger 等 Phase 2.D)。
    // warn-log 防 prod 真的进来时无声沉默。
    result.skippedPhases[row.phase] = (result.skippedPhases[row.phase] ?? 0) + 1;
    log?.warn?.(
      "[v3/migrationReconciler] phase recovery not yet implemented (Phase 2.D)",
      {
        migrationId: row.id.toString(),
        phase: row.phase,
        agentContainerId: row.agentContainerId.toString(),
      },
    );
  }

  result.durationMs = Date.now() - startedAt;
  if (
    result.scanned > 0
    || result.errors.length > 0
    || result.skippedRemote > 0
    || Object.keys(result.skippedPhases).length > 0
  ) {
    log?.info?.("[v3/migrationReconciler] tick done", {
      scanned: result.scanned,
      recoveredPlanned: result.recoveredPlanned,
      unpauseFailures: result.unpauseFailures,
      skippedRemote: result.skippedRemote,
      skippedPhases: result.skippedPhases,
      errors: result.errors.length,
      durationMs: result.durationMs,
    });
  }

  return result;
}

// ───────────────────────────────────────────────────────────────────────
// Scheduler — 完全镜像 v3orphanReconcile.startOrphanReconcileScheduler
// ───────────────────────────────────────────────────────────────────────

export function startMigrationReconcileScheduler(
  deps: V3SupervisorDeps,
  opts: StartMigrationReconcileSchedulerOptions = {},
): MigrationReconcileScheduler {
  const interval = opts.intervalMs ?? DEFAULT_MIGRATION_RECONCILE_INTERVAL_MS;
  const log = opts.logger;
  // §14.2.6 1093 硬约束:进程启动时立即跑一次。
  const runOnStart = opts.runOnStart ?? true;
  let stopped = false;
  let inflight: Promise<MigrationReconcileTickResult> | null = null;
  let timer: NodeJS.Timeout | null = null;

  async function tickLoop(): Promise<void> {
    if (stopped) return;
    try {
      inflight = runMigrationReconcileTick(deps, opts);
      const r = await inflight;
      try {
        opts.onTick?.(r);
      } catch (err) {
        log?.warn?.("[v3/migrationReconciler] onTick callback threw", {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    } catch (err) {
      log?.error?.("[v3/migrationReconciler] tick threw", {
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
        try {
          await inflight;
        } catch {
          /* tick 已经记日志 */
        }
      }
    },
    runOnce: async () => {
      if (inflight) {
        try {
          await inflight;
        } catch {
          /* */
        }
      }
      const p = runMigrationReconcileTick(deps, opts);
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
