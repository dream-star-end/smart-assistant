/**
 * cronWake —— master 侧「cron 触发权威上移」唤醒调度器 + 派生索引读写 + 兜底 rescan。
 *
 * 方案权威源:docs/plans/v5-cron-master-wake-2026-07-07.md §3。
 *
 * 职责收敛为一件事:**到点确保容器活着**。cron.yaml(容器卷)仍是任务定义唯一权威;
 * 本模块只维护 cron_wake_index(0119)这份派生索引,并在到点时 fire-and-forget 唤醒容器。
 * 执行与送达判定留在容器,master 不做 cron 执行、不做送达。
 *
 * 双层保鲜:
 *   ①push:容器 gateway 经 POST /internal/v3/cron-index 上报绝对 next_fire_at(权威路径,
 *     时区正确 —— 容器在自己 TZ 算好绝对瞬时再上报)。见 http/internalCronIndex.ts。
 *   ②rescan(本模块 runCronWakeRescan,每 30min):本机读各 v5 用户卷 cron.yaml 重算对账,
 *     补 push 丢失。**self-host 假设**(v5 现状全本机卷);多机化时改走 node-agent 读卷。
 *
 * 时区语义(rescan 专属):容器进程 TZ=Asia/Shanghai,push 的绝对时刻天然正确;master 的
 * rescan 重算**不依赖进程时区**——nextRunAfter 用显式的上海挂钟视图(shanghaiWallView,
 * 固定 UTC+8 算术换算)喂 cronMatches,故 master 跑 UTC(现网形态)结果也与容器严格一致。
 */

import { promises as fsp } from "node:fs";
import { join } from "node:path";

import { cronMatches, validateCronSchedule, type CronFile, type CronJob } from "@openclaude/gateway";
import { parse as parseYaml } from "yaml";

import { rootLogger, type Logger } from "../logging/logger.js";
import { getRuntimeChannel, type RuntimeChannel } from "../runtimeChannel.js";

// ─── 最小 PG runner 契约 ─────────────────────────────────────────────
// 只用 .rows/.rowCount,刻意比 pg QueryResult 宽松,便于单测注入 fake(同
// http/internalToolFailureAudit.ts 的 QueryRunner 取舍)。getPool() 结构上可赋值。

export interface CronWakeQueryResult<Row = Record<string, unknown>> {
  rows: Row[];
  rowCount: number | null;
}
export interface CronWakeRunner {
  query<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<CronWakeQueryResult<Row>>;
}

// ─── 常量 / env 默认 ─────────────────────────────────────────────────

/** tick 周期:方案定 60s。允许 env 覆盖(测试/调参),下限 5s 防打爆。 */
export const DEFAULT_INTERVAL_MS = 60_000;
export const MIN_INTERVAL_MS = 5_000;
/** 每 tick 实际唤醒上限(防唤醒风暴打爆宿主机)。env COMMERCIAL_CRON_WAKE_MAX_PER_TICK。 */
export const DEFAULT_MAX_PER_TICK = 10;
/** per-uid 唤醒冷却分钟(防 provision 失败 spin)。env COMMERCIAL_CRON_WAKE_COOLDOWN_MIN。 */
export const DEFAULT_COOLDOWN_MIN = 10;
/** due 认领提前量:覆盖冷启 5-8s + boot tick ~10s。到点前 90s 就把容器叫醒。 */
export const DUE_HORIZON_SEC = 90;
/** rescan 周期(tick 计数):30 ticks × 60s = 30min。 */
export const DEFAULT_RESCAN_EVERY_TICKS = 30;

/** cron.yaml 所在卷本地路径(v5 全 self-host)。与 platform/volumeContextReader.volumeRoot 同款拼法。 */
const DEFAULT_VOLUME_BASE_DIR = "/var/lib/docker/volumes";

// ─── 派生索引读写(cron_wake_index)──────────────────────────────────

/**
 * upsert 一个用户的唤醒索引行(runtime_channel 维度)。push 端点与 rescan 共用同一收口。
 * nextFireAt=null → 该用户无 enabled 任务,永不 due。
 */
export async function upsertCronWakeIndex(
  runner: CronWakeRunner,
  input: {
    userId: bigint | number | string;
    runtimeChannel: RuntimeChannel;
    nextFireAt: Date | null;
    jobsEnabled: number;
  },
): Promise<void> {
  await runner.query(
    `INSERT INTO cron_wake_index (user_id, runtime_channel, next_fire_at, jobs_enabled, updated_at)
     VALUES ($1::bigint, $2, $3::timestamptz, $4::int, NOW())
     ON CONFLICT (user_id, runtime_channel)
     DO UPDATE SET next_fire_at = EXCLUDED.next_fire_at,
                   jobs_enabled = EXCLUDED.jobs_enabled,
                   updated_at   = NOW()`,
    [
      String(input.userId),
      input.runtimeChannel,
      input.nextFireAt ? input.nextFireAt.toISOString() : null,
      Math.max(0, Math.trunc(input.jobsEnabled)),
    ],
  );
}

export interface DueCronWakeUser {
  userId: bigint;
  nextFireAt: Date;
}

/**
 * 查 due 用户:runtime_channel=当前 && next_fire_at IS NOT NULL && next_fire_at <= NOW()+horizon。
 * ORDER BY next_fire_at ASC(最紧迫先醒),LIMIT scanLimit(调用方在内存里再按冷却/active
 * 过滤并限 maxPerTick)。scanLimit 略大于 maxPerTick,给「已 active / 冷却中但仍 due」的行让位,
 * 避免它们挤占真正需要唤醒的名额(此类僵留行由 rescan 每 30min 推进 next_fire_at 自愈)。
 */
export async function findDueCronWakeUsers(
  runner: CronWakeRunner,
  input: { runtimeChannel: RuntimeChannel; horizonSec: number; scanLimit: number },
): Promise<DueCronWakeUser[]> {
  const r = await runner.query<{ user_id: string; next_fire_at: Date }>(
    `SELECT user_id::text AS user_id, next_fire_at
       FROM cron_wake_index
      WHERE runtime_channel = $1
        AND next_fire_at IS NOT NULL
        AND next_fire_at <= NOW() + make_interval(secs => $2)
      ORDER BY next_fire_at ASC
      LIMIT $3`,
    [input.runtimeChannel, Math.max(0, Math.trunc(input.horizonSec)), Math.max(1, Math.trunc(input.scanLimit))],
  );
  return r.rows.map((row) => ({
    userId: BigInt(row.user_id),
    nextFireAt: row.next_fire_at,
  }));
}

/** 枚举本实例 channel 的 v5 用户 id(权威判据 users.v5_migrated_at IS NOT NULL,见 0099 + register.ts)。 */
export async function listV5UserIds(runner: CronWakeRunner): Promise<bigint[]> {
  const r = await runner.query<{ id: string }>(
    `SELECT id::text AS id
       FROM users
      WHERE v5_migrated_at IS NOT NULL
        AND status = 'active'
      ORDER BY id ASC`,
  );
  return r.rows.map((row) => BigInt(row.id));
}

// ─── cron.yaml → 最早 next_fire_at(rescan 核心,纯函数)────────────────

/** 卷内 cron.yaml 本地路径。与 platform/volumeContextReader.ts volumeRoot 同款单一拼法。 */
export function cronYamlPathForUser(
  userId: bigint | number,
  channel: RuntimeChannel,
  baseDir: string = DEFAULT_VOLUME_BASE_DIR,
): string {
  return join(baseDir, `oc-${channel}-data-u${userId.toString()}`, "_data", "cron.yaml");
}

/**
 * 上海挂钟视图。Asia/Shanghai 自 1991 年起固定 UTC+8、无夏令时,可精确算术换算:
 * 把 epoch 平移 +8h 后用 getUTC* 读取,得到的字段即上海挂钟字段,与进程时区无关。
 * cronMatches 只读 getMinutes/getHours/getDate/getMonth/getDay 五个 getter
 * (见 gateway cron.ts matchPart 调用点),故鸭子类型对象喂它是安全的。
 *
 * 这也是**不能直接 import gateway computeNextRun** 的原因:它按进程本地时区解释
 * 挂钟字段,容器(TZ=Asia/Shanghai)下正确,master(现网 UTC)上会偏 8 小时——
 * rescan 复算必须与容器语义严格一致,所以在这里显式固定租户 cron 时区。
 */
const SHANGHAI_OFFSET_MS = 8 * 3600_000;
function shanghaiWallView(epochMs: number): Date {
  const shifted = new Date(epochMs + SHANGHAI_OFFSET_MS);
  return {
    getMinutes: () => shifted.getUTCMinutes(),
    getHours: () => shifted.getUTCHours(),
    getDate: () => shifted.getUTCDate(),
    getMonth: () => shifted.getUTCMonth(),
    getDay: () => shifted.getUTCDay(),
  } as unknown as Date;
}

/**
 * 复用 gateway cronMatches 求某 schedule 下一次触发(严格晚于 from,按上海挂钟解释)。
 * 从下一整分钟边界起最多向前扫 1440 分钟找首个命中。**这不是第二套 cron 解析器**——
 * 解析权威仍是 cronMatches;这里只是它上面一层分钟迭代 glue + 显式时区视图。
 */
function nextRunAfter(schedule: string, from: Date): Date | null {
  let epoch = Math.floor(from.getTime() / 60_000) * 60_000 + 60_000;
  for (let i = 0; i < 1440; i++, epoch += 60_000) {
    if (cronMatches(schedule, shanghaiWallView(epoch))) return new Date(epoch);
  }
  return null;
}

/** enabled 判定与 CronScheduler 一致:job.enabled === false 才算停用,缺省视为启用。 */
function isJobEnabled(job: CronJob): boolean {
  return job.enabled !== false;
}

export interface MinNextFire {
  nextFireAt: Date | null;
  jobsEnabled: number;
}

/**
 * 解析 cron.yaml 文本,对所有 enabled 任务用 nextRunAfter 求最早的下一次触发。
 * 返回 { nextFireAt, jobsEnabled }。无 enabled 任务 / 全无合法 schedule → nextFireAt=null。
 * 解析失败(坏 yaml)→ 保守当作无任务(null, 0),由 caller 落 next_fire_at=NULL。
 */
export function computeMinNextFire(cronYamlText: string, from: Date): MinNextFire {
  let file: CronFile;
  try {
    const parsed = parseYaml(cronYamlText) as unknown;
    const jobs = (parsed as { jobs?: unknown })?.jobs;
    file = { jobs: Array.isArray(jobs) ? (jobs as CronJob[]) : [] };
  } catch {
    return { nextFireAt: null, jobsEnabled: 0 };
  }

  let jobsEnabled = 0;
  let min: Date | null = null;
  for (const job of file.jobs) {
    if (!job || typeof job.schedule !== "string" || !isJobEnabled(job)) continue;
    jobsEnabled++;
    // 非法 schedule(AI 幻觉出的 `60 25 * * *` 等)cronMatches 永不命中 → nextRunAfter 返 null,
    // 跳过(不拉低 min);validateCronSchedule 提前短路省 1440 次迭代。
    if (validateCronSchedule(job.schedule) !== null) continue;
    const next = nextRunAfter(job.schedule, from);
    if (next && (min === null || next.getTime() < min.getTime())) min = next;
  }
  return { nextFireAt: min, jobsEnabled };
}

// ─── 兜底 rescan(枚举 v5 用户 + 本机读卷 + 对账 upsert)────────────────

export interface RescanDeps {
  runner: CronWakeRunner;
  now?: () => number;
  baseDir?: string;
  logger?: Logger;
}

export interface RescanResult {
  scanned: number;
  upserted: number;
  errors: number;
}

/**
 * 跑一轮兜底 rescan:枚举 v5 用户 → 本机读各卷 cron.yaml → 重算 min next_fire_at → upsert 对账。
 * 卷缺(ENOENT)/无 enabled 任务 → next_fire_at=NULL。**单用户失败隔离,不拖垮整轮**。
 */
export async function runCronWakeRescan(deps: RescanDeps): Promise<RescanResult> {
  const log = (deps.logger ?? rootLogger).child({ subsys: "cronWake", phase: "rescan" });
  const now = deps.now ?? (() => Date.now());
  const baseDir = deps.baseDir ?? DEFAULT_VOLUME_BASE_DIR;
  const channel = getRuntimeChannel();

  let scanned = 0;
  let upserted = 0;
  let errors = 0;

  let userIds: bigint[];
  try {
    userIds = await listV5UserIds(deps.runner);
  } catch (err) {
    log.error("list_v5_users_failed", { err: err as Error });
    return { scanned: 0, upserted: 0, errors: 1 };
  }

  for (const uid of userIds) {
    scanned++;
    try {
      const path = cronYamlPathForUser(uid, channel, baseDir);
      let text: string | null = null;
      try {
        text = await fsp.readFile(path, "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
          text = null; // 卷/文件不存在 → 无任务
        } else {
          throw e;
        }
      }
      const { nextFireAt, jobsEnabled } =
        text === null ? { nextFireAt: null, jobsEnabled: 0 } : computeMinNextFire(text, new Date(now()));
      await upsertCronWakeIndex(deps.runner, {
        userId: uid,
        runtimeChannel: channel,
        nextFireAt,
        jobsEnabled,
      });
      upserted++;
    } catch (err) {
      errors++;
      log.warn("rescan_user_failed", { uid: uid.toString(), err: err as Error });
    }
  }

  log.info("rescan_done", { channel, scanned, upserted, errors });
  return { scanned, upserted, errors };
}

// ─── scheduler ───────────────────────────────────────────────────────

export interface CronWakeSchedulerHandle {
  stop(): void;
  /** 测试/触发用:立即跑一次 due 认领 tick(不含 rescan 计数推进逻辑外的副作用)。 */
  runNow(): Promise<CronWakeTickResult>;
  /** 测试/触发用:立即跑一次 rescan。 */
  rescanNow(): Promise<RescanResult>;
}

export interface CronWakeTickResult {
  due: number;
  woken: number;
  skippedActive: number;
  skippedCooldown: number;
  ran: boolean;
  skipReason?: "busy";
}

export interface CronWakeSchedulerDeps {
  /** 查 due 用户。默认走 findDueCronWakeUsers(runner)。 */
  findDueUsers: (scanLimit: number, horizonSec: number) => Promise<DueCronWakeUser[]>;
  /** 容器是否 active(active → 跳过唤醒,无需叫醒)。 */
  isContainerActive: (userId: bigint) => Promise<boolean>;
  /** fire-and-forget 唤醒容器(幂等 singleflight)。 */
  wakeContainer: (userId: bigint) => Promise<void>;
  /** 跑一轮兜底 rescan。默认 runCronWakeRescan(runner)。 */
  runRescan: () => Promise<unknown>;
  now?: () => number;
  logger?: Logger;
  // 调参(index.ts 从 env 解析后注入)
  intervalMs?: number;
  maxPerTick?: number;
  cooldownMs?: number;
  rescanEveryTicks?: number;
  /** 启动即跑一轮 rescan(bootstrap 索引)。默认 true。 */
  runRescanOnStart?: boolean;
  horizonSec?: number;
}

/**
 * 启动 cronWake scheduler。**只应在 (controlPlaneEnabled || channel==='v5') 且
 * COMMERCIAL_CRON_WAKE_DISABLED!=1 且 ensureContainerReady 可用时由 index.ts 调用。**
 */
export function startCronWakeScheduler(deps: CronWakeSchedulerDeps): CronWakeSchedulerHandle {
  const log = (deps.logger ?? rootLogger).child({ subsys: "cronWake" });
  const now = deps.now ?? (() => Date.now());
  const interval = Math.max(MIN_INTERVAL_MS, deps.intervalMs ?? DEFAULT_INTERVAL_MS);
  const maxPerTick = Math.max(1, deps.maxPerTick ?? DEFAULT_MAX_PER_TICK);
  const cooldownMs = Math.max(0, deps.cooldownMs ?? DEFAULT_COOLDOWN_MIN * 60_000);
  const rescanEveryTicks = Math.max(1, deps.rescanEveryTicks ?? DEFAULT_RESCAN_EVERY_TICKS);
  const horizonSec = Math.max(0, deps.horizonSec ?? DUE_HORIZON_SEC);
  const runRescanOnStart = deps.runRescanOnStart !== false;
  // scan 比 wake 多留头寸,给 active/冷却中但仍 due 的行让位(见 findDueCronWakeUsers 注释)。
  const scanLimit = Math.min(Math.max(maxPerTick * 3, maxPerTick + 8), 100);

  let stopped = false;
  let inflight = false;
  let rescanInflight = false;
  let tickCount = 0;
  /** per-uid 最近一次唤醒尝试时刻(ms);冷却窗口内不重复叫醒。 */
  const lastWakeAt = new Map<string, number>();

  async function tickOnce(): Promise<CronWakeTickResult> {
    if (inflight) return { due: 0, woken: 0, skippedActive: 0, skippedCooldown: 0, ran: false, skipReason: "busy" };
    inflight = true;
    const t = now();
    // 冷却 Map 定期清理:超过冷却窗的条目删除,防无界增长。
    for (const [k, ts] of lastWakeAt) {
      if (t - ts > cooldownMs) lastWakeAt.delete(k);
    }
    let woken = 0;
    let skippedActive = 0;
    let skippedCooldown = 0;
    let due = 0;
    try {
      const dueUsers = await deps.findDueUsers(scanLimit, horizonSec);
      due = dueUsers.length;
      for (const u of dueUsers) {
        if (woken >= maxPerTick) break;
        const key = u.userId.toString();
        const last = lastWakeAt.get(key);
        if (last !== undefined && t - last < cooldownMs) {
          skippedCooldown++;
          continue;
        }
        // active 判定失败(DB 抖动)→ 保守跳过本轮(不盲目群体唤醒),下轮重试。
        let active: boolean;
        try {
          active = await deps.isContainerActive(u.userId);
        } catch (err) {
          log.warn("is_active_failed_skip", { uid: key, err: err as Error });
          continue;
        }
        if (active) {
          skippedActive++;
          continue;
        }
        // 先落冷却戳再 fire —— 即便 wake 慢/失败,下轮也不会立刻重复叫醒(spin 防护)。
        lastWakeAt.set(key, t);
        woken++;
        void deps.wakeContainer(u.userId).catch((err) => {
          log.warn("wake_failed", { uid: key, err: err as Error });
        });
      }
    } catch (err) {
      log.error("due_tick_failed", { err: err as Error });
    } finally {
      inflight = false;
    }
    if (woken > 0 || skippedActive > 0 || skippedCooldown > 0) {
      log.info("due_tick", { due, woken, skippedActive, skippedCooldown });
    }
    return { due, woken, skippedActive, skippedCooldown, ran: true };
  }

  async function rescanTick(): Promise<RescanResult> {
    if (rescanInflight || stopped) return { scanned: 0, upserted: 0, errors: 0 };
    rescanInflight = true;
    try {
      const r = await deps.runRescan();
      return (r as RescanResult) ?? { scanned: 0, upserted: 0, errors: 0 };
    } catch (err) {
      log.error("rescan_failed", { err: err as Error });
      return { scanned: 0, upserted: 0, errors: 1 };
    } finally {
      rescanInflight = false;
    }
  }

  // 启动即跑一轮 rescan(bootstrap 索引:首部署 / 重启后索引可能为空,纯靠 push 要等下次
  // 容器 tick 才刷新,dormant 用户永远轮不到)。fire-and-forget。
  if (runRescanOnStart) {
    void rescanTick();
  }

  const timer = setInterval(() => {
    if (stopped) return;
    tickCount++;
    void tickOnce();
    if (tickCount % rescanEveryTicks === 0) void rescanTick();
  }, interval);
  if (typeof timer.unref === "function") timer.unref();

  log.info("cron_wake_started", {
    intervalMs: interval,
    maxPerTick,
    cooldownMs,
    rescanEveryTicks,
    horizonSec,
    scanLimit,
  });

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    runNow: tickOnce,
    rescanNow: rescanTick,
  };
}
