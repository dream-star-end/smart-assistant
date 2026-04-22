/**
 * V3 Phase 3G — volume GC for banned 7d / no-login 90d users.
 *
 * 见 docs/v3/02-DEVELOPMENT-PLAN.md §9.3 Task 3G + §1.0.2 K(volumeGc 1d)。
 *
 * MVP 简化(对齐 §13 R5c 单轨,无 mode / 无 subscription_tier):
 *   - 没有 banned_at 字段 → 用 users.updated_at 做"封禁时间"代理。
 *     假设:未来 admin 封禁端点会 SET status='banned', updated_at=NOW();
 *     MVP 没有任何生产代码写 status='banned'(仅 fixture),所以即使代理偏差大,
 *     7d 窗口也很难误删活用户。
 *   - 没有 users.last_login_at 列 → 用 MAX(refresh_tokens.created_at) 做"最近登录"代理。
 *     refresh_token 在 login + refresh 时都会 INSERT 新行(短期 access_token + 长期 refresh
 *     的标准 JWT 模式),所以"90d 内一次 token issuance 都没有"≈ 用户 90d 没活动。
 *     缺陷:长 ws 连接(刷不到 refresh)也会被算"未登录" — MVP 接受(volume 被删
 *     用户重连后重新 provision,数据丢失,但 90d 不动手是极端罕见 case)。
 *   - 没有 §1196 要求的"标 deleted → 7d 后 GC"两段语义:MVP 直接一步删 volume。
 *     P1 可以加 system_settings.volume_gc_after_days 双段。
 *   - 没有"标 users.status='deleting'"等附加状态变更,仅删 volume 本身。
 *     用户 row 保持 banned / active,下次 ensureRunning 走全新 provision。
 *
 * 安全护栏:
 *   - 删 volume 前必须验证 **该 uid 没有 active agent_containers 行**(否则
 *     docker 409 in-use,日志噪声)。idle 30min sweep + orphan reconcile 会清,
 *     volumeGc 等他们清完才动手。
 *   - 删 volume 走 supervisor.removeV3Volume(name = oc-v3-data-u<uid>);missing
 *     → noop。任何 docker 错(401/500)聚合 errors[],单行不影响其他。
 *
 * 调度:
 *   - 默认 1h 一跑(volume GC 不时敏);单次 tick 上限 batchLimit 行。
 *   - 调度模型与 v3idleSweep.ts 完全一致(setInterval 串行 + stop awaits inflight
 *     + runOnce 测试钩子),不要再造一个 scheduler 形状。
 *
 * 不在本文件管:
 *   - 用户主动注销账号(users.status='deleted', deleted_at IS NOT NULL):由
 *     注销 admin 端点同步 cascade,不需要 volume GC 巡(P1 加)。
 *   - 标 deleted → 7d 二段:MVP 单段直接删,P1 接 system_settings 后加。
 *   - 容器 stop+remove:idle sweep (3F) / orphan reconcile (3H) 各自负责;volumeGc
 *     仅删 volume,不动容器。
 */

import type { Pool } from "pg";

import {
  acquireUserLifecycleLock,
  removeV3Volume,
  v3ProjectsVolumeNameFor,
  v3VolumeNameFor,
} from "./v3supervisor.js";
import type { V3SupervisorDeps } from "./v3supervisor.js";

// ───────────────────────────────────────────────────────────────────────
// 默认常量
// ───────────────────────────────────────────────────────────────────────

/** 默认调度间隔(1h)。volume GC 不时敏,跑慢点节省 docker daemon 压力。 */
export const DEFAULT_VOLUME_GC_INTERVAL_MS = 60 * 60 * 1_000;

/** 默认 banned 用户 volume 留存(天)。boss 拍板 7d。 */
export const DEFAULT_BANNED_RETAIN_DAYS = 7;

/** 默认 no-login 用户 volume 留存(天)。boss 拍板 90d。 */
export const DEFAULT_NO_LOGIN_RETAIN_DAYS = 90;

/** 单次 tick 最多 GC 多少 volume(防一次扫上千把 docker daemon 打爆) */
export const DEFAULT_VOLUME_GC_BATCH_LIMIT = 100;

// ───────────────────────────────────────────────────────────────────────
// 公共类型
// ───────────────────────────────────────────────────────────────────────

export interface VolumeGcLogger {
  debug?(message: string, meta?: Record<string, unknown>): void;
  info?(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
  error?(message: string, meta?: Record<string, unknown>): void;
}

export interface VolumeGcTickOptions {
  /** banned 用户 volume 保留天数,默认 7 */
  bannedRetainDays?: number;
  /** active 用户但 90d 无登录 volume 保留天数,默认 90 */
  noLoginRetainDays?: number;
  /** 单 tick 处理上限(banned + no-login 合并),默认 100 */
  batchLimit?: number;
  /** logger,缺省静默 */
  logger?: VolumeGcLogger;
}

export type VolumeGcReason = "banned" | "no_login";

export interface VolumeGcTickResult {
  /** 本次 tick 扫到多少候选 uid(banned + no-login 合并去重) */
  scanned: number;
  /** 实际被 GC 的 user 数(每 user 一次性删 data + projects 两个 volume,计 1) */
  removed: number;
  /** 因有 active 容器行而 skip 的 uid 数 */
  skippedActiveContainer: number;
  /** 失败的 uid + 原因(不抛,聚合返回) */
  errors: Array<{ uid: number; reason: VolumeGcReason; error: string }>;
  /** tick 总耗时 ms */
  durationMs: number;
}

export interface StartVolumeGcSchedulerOptions extends VolumeGcTickOptions {
  /** 两次 tick 间隔(ms),默认 3_600_000(1h) */
  intervalMs?: number;
  /** 启动时是否立刻跑一次,默认 false */
  runOnStart?: boolean;
  /** 每次 tick 完成回调(metrics 接入点) */
  onTick?: (r: VolumeGcTickResult) => void;
}

export interface VolumeGcScheduler {
  /** 终止调度;已在跑的 tick 会跑完 */
  stop: () => Promise<void>;
  /** 手动触发一次 tick(测试 / 运维强制 GC 用) */
  runOnce: () => Promise<VolumeGcTickResult>;
}

// ───────────────────────────────────────────────────────────────────────
// SELECT — 找出 GC 候选 uid
// ───────────────────────────────────────────────────────────────────────

interface CandidateRow {
  uid: number;
  reason: VolumeGcReason;
}

/**
 * 找 banned 7d 候选:status='banned' 且 updated_at < NOW - N days。
 *
 * 注:依赖未来 admin 封禁端点同步 SET updated_at=NOW。MVP 无生产代码写 'banned',
 * 所以即便代理偏差也几乎无影响。
 */
async function selectBannedCandidates(
  pool: Pool,
  retainDays: number,
  limit: number,
): Promise<CandidateRow[]> {
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM users
      WHERE status = 'banned'
        AND updated_at < NOW() - ($1::int * interval '1 day')
      ORDER BY updated_at ASC
      LIMIT $2::int`,
    [retainDays, limit],
  );
  return r.rows.map((row) => ({
    uid: Number.parseInt(row.id, 10),
    reason: "banned" as const,
  }));
}

/**
 * 找 no-login 90d 候选:status='active' 且没有任何 90d 内的 refresh_token。
 *
 * NOT EXISTS 比 LEFT JOIN + IS NULL 更明确;PG 会用 idx_rt_user 扫(部分索引覆盖
 * revoked_at IS NULL 子集,但我们要看 issuance 时间,所以走 user_id seq 扫子集)。
 *
 * 注:MVP `users.created_at` 也算"最近一次 token 时间起点"的隐式回退 — 一个全新
 * 用户注册没 7d 就触发"无登录 90d"是不可能的(注册 < 7d ≪ 90d);只有注册即从未
 * 成功登录的用户(几乎不可能,因为登录端点会 INSERT refresh_token)才会卡。所以
 * 我们额外要求 users.created_at < NOW - retainDays,避免误删极早期注册流程异常。
 */
async function selectNoLoginCandidates(
  pool: Pool,
  retainDays: number,
  limit: number,
): Promise<CandidateRow[]> {
  const r = await pool.query<{ id: string }>(
    `SELECT u.id
       FROM users u
      WHERE u.status = 'active'
        AND u.created_at < NOW() - ($1::int * interval '1 day')
        AND NOT EXISTS (
          SELECT 1 FROM refresh_tokens r
           WHERE r.user_id = u.id
             AND r.created_at > NOW() - ($1::int * interval '1 day')
        )
      ORDER BY u.id ASC
      LIMIT $2::int`,
    [retainDays, limit],
  );
  return r.rows.map((row) => ({
    uid: Number.parseInt(row.id, 10),
    reason: "no_login" as const,
  }));
}

/**
 * 在已持 per-uid lock 的事务里检查 uid 是否还有 active agent_containers 行。
 *
 * R6.11 reader 二选一:本文件在 RECONCILER_WHITELIST 内(§9 3M),trivial 满足
 * — MVP 没 agent_migrations 表,无 open migration 概念。
 */
async function hasActiveContainerLocked(
  client: import("pg").PoolClient,
  uid: number,
): Promise<boolean> {
  const r = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM agent_containers
        WHERE user_id = $1::bigint
          AND state = 'active'
     ) AS exists`,
    [String(uid)],
  );
  return r.rows[0]?.exists === true;
}

/**
 * Codex round 1 FAIL #3 修复:GC 单 uid 处理事务化。
 *
 * 流程:
 *   1. BEGIN
 *   2. acquire per-uid lifecycle lock(USER_LIFECYCLE_LOCK_NS, uid)
 *      → 与 provisionV3Container 互斥,串行化同一 uid 的 lifecycle
 *   3. SELECT EXISTS active container
 *      - 有 → COMMIT, return 'skipped'(等 idle sweep / orphan reconcile 清掉容器)
 *      - 无 → removeV3Volume (docker call,在持锁期间执行)
 *   4. COMMIT(锁随事务释放)
 *
 * 为什么 docker call 也放事务里:
 *   持锁期间 docker rm volume,确保任何并发 provision 必须等本 GC 释放锁后才能
 *   ensureV3Volume(provision 同样在持 per-uid lock 期间 ensureV3Volume,见
 *   v3supervisor.ts:provisionV3Container)。否则 GC 删 volume vs provision create
 *   container 用旧 volume name 的 race 仍存在。
 *
 * docker call 失败:不 ROLLBACK(PG 没动,事务只是 lock holder),返回 'failed' +
 * error string。caller 把它聚合到 errors[]。
 *
 * 返回:
 *   - 'removed' = 真删了 volume
 *   - 'skipped' = 有 active 容器 skip
 *   - 'failed'  = removeV3Volume 抛错
 */
type GcUidOutcome =
  | { kind: "removed" }
  | { kind: "skipped" }
  | { kind: "failed"; error: string };

async function gcSingleUidLocked(
  deps: V3SupervisorDeps,
  uid: number,
): Promise<GcUidOutcome> {
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    try {
      await acquireUserLifecycleLock(client, uid);
      const active = await hasActiveContainerLocked(client, uid);
      if (active) {
        await client.query("COMMIT");
        return { kind: "skipped" };
      }
      try {
        await removeV3Volume(deps.docker, uid);
      } catch (err) {
        // docker 失败 — PG 没动,直接 COMMIT 释放 lock,把错往上抛聚合
        await client.query("COMMIT");
        return {
          kind: "failed",
          error: err instanceof Error ? err.message : String(err),
        };
      }
      await client.query("COMMIT");
      return { kind: "removed" };
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { /* swallow */ }
      throw err;
    }
  } finally {
    client.release();
  }
}

// ───────────────────────────────────────────────────────────────────────
// 单次 tick:scan + (active guard) + remove volume
// ───────────────────────────────────────────────────────────────────────

/**
 * 跑一轮 volume GC:扫 banned + no-login 候选,逐个 active-guard + removeV3Volume。
 *
 * 单 uid 失败:catch 后塞 errors[],继续下一 uid。SELECT 失败 → throw(scheduler 记日志后排下一次)。
 *
 * 顺序:banned 先扫(更紧急,7d 窗口短),no-login 后扫;两组合并去重(理论上
 * banned 用户不会同时 status='active',所以 union 不会重 — 但保险起见 dedup)。
 */
export async function runVolumeGcTick(
  deps: V3SupervisorDeps,
  options: VolumeGcTickOptions = {},
): Promise<VolumeGcTickResult> {
  const bannedDays = options.bannedRetainDays ?? DEFAULT_BANNED_RETAIN_DAYS;
  const noLoginDays = options.noLoginRetainDays ?? DEFAULT_NO_LOGIN_RETAIN_DAYS;
  const batchLimit = options.batchLimit ?? DEFAULT_VOLUME_GC_BATCH_LIMIT;
  const log = options.logger;

  const startedAt = Date.now();
  const errors: VolumeGcTickResult["errors"] = [];
  let removed = 0;
  let skippedActiveContainer = 0;

  // 拆 banned + no-login 各占 batch 的一半,公平分配;若 banned 不够 no-login 自动补满
  const halfLimit = Math.max(1, Math.floor(batchLimit / 2));
  const banned = await selectBannedCandidates(deps.pool, bannedDays, halfLimit);
  const noLoginLimit = Math.max(1, batchLimit - banned.length);
  const noLogin = await selectNoLoginCandidates(deps.pool, noLoginDays, noLoginLimit);

  // 去重(同 uid 只 GC 一次,banned 优先)
  const seen = new Set<number>();
  const candidates: CandidateRow[] = [];
  for (const c of [...banned, ...noLogin]) {
    if (seen.has(c.uid)) continue;
    seen.add(c.uid);
    candidates.push(c);
  }

  log?.debug?.("[v3/volumeGc] scan", {
    scanned: candidates.length,
    banned: banned.length,
    no_login: noLogin.length,
    bannedDays,
    noLoginDays,
    batchLimit,
  });

  for (const cand of candidates) {
    try {
      const outcome = await gcSingleUidLocked(deps, cand.uid);
      if (outcome.kind === "skipped") {
        skippedActiveContainer++;
        log?.debug?.("[v3/volumeGc] skip uid (active container)", {
          uid: cand.uid,
          reason: cand.reason,
        });
      } else if (outcome.kind === "removed") {
        removed++;
        log?.info?.("[v3/volumeGc] removed volumes", {
          uid: cand.uid,
          reason: cand.reason,
          // removeV3Volume 内部双删 data + projects;日志列两个名,便于事故定位
          volumes: [v3VolumeNameFor(cand.uid), v3ProjectsVolumeNameFor(cand.uid)],
        });
      } else {
        errors.push({ uid: cand.uid, reason: cand.reason, error: outcome.error });
        log?.warn?.("[v3/volumeGc] removeV3Volume failed", {
          uid: cand.uid, reason: cand.reason, err: outcome.error,
        });
      }
    } catch (err) {
      // gcSingleUidLocked throw 仅在 PG 错(BEGIN / advisory_lock / EXISTS / COMMIT 失败)
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ uid: cand.uid, reason: cand.reason, error: msg });
      log?.warn?.("[v3/volumeGc] gc transaction failed", {
        uid: cand.uid, reason: cand.reason, err: msg,
      });
    }
  }

  const durationMs = Date.now() - startedAt;
  if (candidates.length > 0 || errors.length > 0) {
    log?.info?.("[v3/volumeGc] tick done", {
      scanned: candidates.length,
      removed,
      skippedActiveContainer,
      errors: errors.length,
      durationMs,
    });
  }
  return {
    scanned: candidates.length,
    removed,
    skippedActiveContainer,
    errors,
    durationMs,
  };
}

// ───────────────────────────────────────────────────────────────────────
// Scheduler:setInterval 串行版,完全对齐 v3idleSweep
// ───────────────────────────────────────────────────────────────────────

export function startVolumeGcScheduler(
  deps: V3SupervisorDeps,
  opts: StartVolumeGcSchedulerOptions = {},
): VolumeGcScheduler {
  const interval = opts.intervalMs ?? DEFAULT_VOLUME_GC_INTERVAL_MS;
  const log = opts.logger;
  let stopped = false;
  let inflight: Promise<VolumeGcTickResult> | null = null;
  let timer: NodeJS.Timeout | null = null;

  async function tickLoop(): Promise<void> {
    if (stopped) return;
    try {
      inflight = runVolumeGcTick(deps, opts);
      const r = await inflight;
      try { opts.onTick?.(r); } catch (err) {
        log?.warn?.("[v3/volumeGc] onTick callback threw", {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    } catch (err) {
      log?.error?.("[v3/volumeGc] tick threw", {
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
        try { await inflight; } catch { /* */ }
      }
      const p = runVolumeGcTick(deps, opts);
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
