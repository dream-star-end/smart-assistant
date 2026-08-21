/**
 * live journal 帧表维护调度器:周期 prune 已投影帧 + retire 死流。
 *
 * 背景:
 *   `client_session_live_frames` 在流投影成 tape 后永远不会再被读路径取到,但此前
 *   没有任何删除机制。selfhost 手工清理前 597,164 行 / 664MB,清理后 12,230 行 /
 *   12MB,要命的 live-frames 查询从 2599ms 降到 0.355ms。手工清理挡不住再长回去。
 *
 * 本调度器只接线,不改维护函数语义:
 *   - pruneProjectedLiveFrames:删「已投影成 tape 且 tape records 确有记录」的流的帧。
 *     没有 tape 记录的流(库里实测有 18 条)是唯一副本,函数本身就不会删。
 *   - retireDeadLiveStreams:给不可能再产帧的 live 流打 provenance.retired_at。
 *     退休 = 不再是在飞 owner,不等于内容不可见 —— 帧照常返回,只从
 *     streamClientMessageIds 剔除。
 *
 * 挂 leaderBundle shared,双 master 只 leader 跑。失败只记日志,不抛、不挡启动。
 * 运维开关:COMMERCIAL_LIVE_FRAME_MAINTENANCE_DISABLED=1。
 */

import type { Pool } from "pg";
import {
  pruneProjectedLiveFrames,
  retireDeadLiveStreams,
} from "./liveTurnFrames.js";

/** 默认 1h:帧持续增长但不是秒级爆发;小时级足够把表钉在清理后的体量。 */
export const DEFAULT_INTERVAL_MS = 3_600_000;
/** 下限 1min:允许运维加速排空积压,但挡住 0/NaN 把 DELETE 打成忙等。 */
export const MIN_INTERVAL_MS = 60_000;
/**
 * 单轮最多 20 批 × 函数默认 5000 行 = 10 万帧。597k 积压约 6 个小时 tick 排空,
 * 避免一轮吃满整张表把 DB 拖住。
 */
export const DEFAULT_PRUNE_MAX_BATCHES = 20;
export const MAX_PRUNE_MAX_BATCHES = 200;
/** 与 pruneProjectedLiveFrames 默认一致;调度器显式传入,避免函数默认 Infinity。 */
export const DEFAULT_PRUNE_BATCH_SIZE = 5000;
/** 与 retireDeadLiveStreams 默认一致(2h);env 只允许更保守。 */
export const DEFAULT_RETIRE_MIN_AGE_MS = 2 * 60 * 60 * 1000;
export const MAX_RETIRE_MIN_AGE_MS = 365 * 24 * 60 * 60 * 1000;

export interface LiveFrameMaintenanceCounts {
  deletedFrames: number;
  prunedStreams: number;
  retired: number;
}

export interface LiveFrameMaintenanceHandle {
  stop(): void;
  /** 测试/运维:立即跑一轮(prune + retire)。与 interval tick 共用 running 守卫。 */
  runNow(): Promise<LiveFrameMaintenanceCounts>;
}

export interface LiveFrameMaintenanceOptions {
  pool: Pool;
  intervalMs?: number;
  pruneBatchSize?: number;
  pruneMaxBatches?: number;
  retireMinAgeMs?: number;
  disabled?: boolean;
  runOnStart?: boolean;
  onError?: (err: unknown) => void;
  pruneFn?: (
    pool: Pool,
    options?: { batchSize?: number; maxBatches?: number },
  ) => Promise<{ deletedFrames: number; prunedStreams: number }>;
  retireFn?: (
    pool: Pool,
    options?: { minAgeMs?: number },
  ) => Promise<{ retired: number }>;
}

const EMPTY_COUNTS: LiveFrameMaintenanceCounts = {
  deletedFrames: 0,
  prunedStreams: 0,
  retired: 0,
};

export function resolveLiveFrameMaintenanceDisabled(
  envValue: string | undefined = process.env.COMMERCIAL_LIVE_FRAME_MAINTENANCE_DISABLED,
): boolean {
  return envValue === "1";
}

export function resolveLiveFrameMaintenanceIntervalMs(
  envValue: string | number | undefined,
): number {
  const raw = Number(envValue);
  if (Number.isSafeInteger(raw) && raw >= MIN_INTERVAL_MS) return raw;
  return DEFAULT_INTERVAL_MS;
}

export function resolvePruneMaxBatches(envValue: string | number | undefined): number {
  const raw = Number(envValue);
  if (!Number.isSafeInteger(raw) || raw < 1) return DEFAULT_PRUNE_MAX_BATCHES;
  return Math.min(raw, MAX_PRUNE_MAX_BATCHES);
}

export function resolveRetireMinAgeMs(envValue: string | number | undefined): number {
  const raw = Number(envValue);
  if (!Number.isSafeInteger(raw) || raw < DEFAULT_RETIRE_MIN_AGE_MS) {
    return DEFAULT_RETIRE_MIN_AGE_MS;
  }
  return Math.min(raw, MAX_RETIRE_MIN_AGE_MS);
}

function defaultOnError(err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn("[liveFrameMaintenance] tick failed:", err);
}

export function startLiveFrameMaintenanceScheduler(
  opts: LiveFrameMaintenanceOptions,
): LiveFrameMaintenanceHandle {
  const disabled = opts.disabled ?? resolveLiveFrameMaintenanceDisabled();
  if (disabled) {
    return {
      stop() {},
      runNow: async () => EMPTY_COUNTS,
    };
  }

  const interval = Math.max(MIN_INTERVAL_MS, opts.intervalMs ?? DEFAULT_INTERVAL_MS);
  const pruneBatchSize = opts.pruneBatchSize ?? DEFAULT_PRUNE_BATCH_SIZE;
  const pruneMaxBatches = Math.max(
    1,
    Math.min(MAX_PRUNE_MAX_BATCHES, opts.pruneMaxBatches ?? DEFAULT_PRUNE_MAX_BATCHES),
  );
  const retireMinAgeMs = resolveRetireMinAgeMs(opts.retireMinAgeMs);
  const pruneFn = opts.pruneFn ?? pruneProjectedLiveFrames;
  const retireFn = opts.retireFn ?? retireDeadLiveStreams;
  const onError = opts.onError ?? defaultOnError;
  const runOnStart = opts.runOnStart ?? true;
  const pool = opts.pool;

  let stopped = false;
  let running = false;

  async function runOneTick(): Promise<LiveFrameMaintenanceCounts> {
    if (running) return { ...EMPTY_COUNTS };
    running = true;
    try {
      let deletedFrames = 0;
      let prunedStreams = 0;
      let retired = 0;
      try {
        const pruned = await pruneFn(pool, {
          batchSize: pruneBatchSize,
          maxBatches: pruneMaxBatches,
        });
        deletedFrames = pruned.deletedFrames;
        prunedStreams = pruned.prunedStreams;
      } catch (err) {
        onError(err);
      }
      try {
        const retiredResult = await retireFn(pool, { minAgeMs: retireMinAgeMs });
        retired = retiredResult.retired;
      } catch (err) {
        onError(err);
      }
      return { deletedFrames, prunedStreams, retired };
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => {
    if (!stopped) void runOneTick();
  }, interval);
  if (typeof timer.unref === "function") timer.unref();

  if (runOnStart) void runOneTick();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    runNow: runOneTick,
  };
}
