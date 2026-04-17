/**
 * T-53 — Agent 容器 provisioning + 生命周期(两部分 Docker-coupled 逻辑)。
 *
 * 1. `provisionContainer(docker, uid, opts)` —
 *    open API 成功写完 DB 之后 fire-and-forget 调这个。它去 docker 真正
 *    create + start 容器,回写 agent_containers.status = running 或 error。
 *    **不抛异常**(错误全部被 catch 后记到 DB,让状态 API 能读到),
 *    caller 用 `void provisionContainer(...)` 就好。
 *
 * 2. `runLifecycleTick(docker, opts)` — 每小时由 index.ts 的 setInterval 调用。
 *    两步:
 *    a. markExpiredSubscriptions → 对每条 stopContainer + markContainerStoppedAfterExpiry
 *    b. listVolumeGcCandidates   → 对每条 removeContainer + removeUserVolumes + markContainerRemoved
 *    步骤之间独立,b 失败不阻塞 a;单用户失败不影响别人。
 *
 * **不在本文件处理**:docker daemon 不可达。lifecycle tick 捕获 SupervisorError 后
 * 只记日志,下次 tick 继续。若真的 docker down 了,运维报警会先触发。
 */

import type Docker from "dockerode";
import {
  createContainer,
  stopContainer,
  removeContainer,
} from "../agent-sandbox/supervisor.js";
import { removeUserVolumes } from "../agent-sandbox/volumes.js";
import { SupervisorError, type ProvisionOptions } from "../agent-sandbox/types.js";
import {
  markContainerRunning,
  markContainerError,
  markExpiredSubscriptions,
  markContainerStoppedAfterExpiry,
  listVolumeGcCandidates,
  markContainerRemoved,
  DEFAULT_AGENT_VOLUME_GC_DAYS,
  type ExpiredSubscriptionRow,
  type GcCandidateRow,
} from "./subscriptions.js";

export interface LifecycleLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

const NOOP_LOGGER: LifecycleLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ============================================================
//  1) provisionContainer — 异步开机
// ============================================================

export interface ProvisionContainerOptions {
  /** supervisor.createContainer 需要的透明代理 URL(必须) */
  proxyUrl: string;
  /** supervisor.createContainer 需要的 seccomp profile JSON 字符串(必须) */
  seccompProfileJson: string;
  /** RPC socket 在 host 上的父目录;每用户 u{uid}/ 由 supervisor 建 */
  rpcSocketHostDir: string;
  /** docker 网络名 */
  network: string;
  /** 容器镜像(和 subscriptions.openAgentSubscription 传入一致) */
  image: string;
  /** 资源限制覆盖;未传走 supervisor 默认(05-SEC §13) */
  limits?: Pick<ProvisionOptions, "memoryMb" | "cpus" | "pidsLimit" | "tmpfsTmpMb">;
  /** 额外 env(extraEnv,禁止 OC_/proxy 保留前缀) */
  extraEnv?: Record<string, string>;
  logger?: LifecycleLogger;
}

/**
 * 为用户 uid 实际 create + start 容器;结果写回 agent_containers。
 *
 * 错误处理:
 *   - `NameConflict`(容器已存在):尝试 force remove 再 create 一次。这是唯一的
 *     重试路径,其他错误一律置 status=error。
 *   - 其他:写 last_error + status=error,让状态 API 透出错误给前端。
 *
 * 返回 void(Promise<void>),绝不 rethrow。caller 不 await 也安全。
 */
export async function provisionContainer(
  docker: Docker,
  uid: number,
  opts: ProvisionContainerOptions,
): Promise<void> {
  const logger = opts.logger ?? NOOP_LOGGER;
  try {
    await doProvision(docker, uid, opts, /* isRetry */ false, logger);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("[agent/lifecycle] provision failed", { uid, error: msg });
    try {
      await markContainerError(uid, msg);
    } catch (dbErr) {
      logger.error("[agent/lifecycle] markContainerError failed after provision fail", {
        uid,
        error: (dbErr as Error).message,
      });
    }
  }
}

async function doProvision(
  docker: Docker,
  uid: number,
  opts: ProvisionContainerOptions,
  isRetry: boolean,
  logger: LifecycleLogger,
): Promise<void> {
  try {
    const result = await createContainer(docker, uid, {
      image: opts.image,
      network: opts.network,
      proxyUrl: opts.proxyUrl,
      seccompProfileJson: opts.seccompProfileJson,
      rpcSocketHostDir: opts.rpcSocketHostDir,
      memoryMb: opts.limits?.memoryMb,
      cpus: opts.limits?.cpus,
      pidsLimit: opts.limits?.pidsLimit,
      tmpfsTmpMb: opts.limits?.tmpfsTmpMb,
      extraEnv: opts.extraEnv,
    });
    await markContainerRunning(uid, result.id);
    logger.info("[agent/lifecycle] provisioned", { uid, docker_id: result.id });
  } catch (err) {
    if (
      !isRetry &&
      err instanceof SupervisorError &&
      err.code === "NameConflict"
    ) {
      // 容器已经存在:可能是上一次 lifecycle GC 漏掉 / 手工 docker run 撞名了。
      // 先 force remove,再重试一次。不递归 try {} 是为了 dead-simple 一次重试。
      logger.warn("[agent/lifecycle] name conflict, force removing then retrying", { uid });
      try {
        await removeContainer(docker, uid);
      } catch (rmErr) {
        // 清理失败就别重试了,直接让上层记 error
        throw rmErr;
      }
      await doProvision(docker, uid, opts, true, logger);
      return;
    }
    throw err;
  }
}

// ============================================================
//  2) runLifecycleTick — 每小时一次的扫描
// ============================================================

export interface LifecycleTickOptions {
  /** volume 保留天数,默认 30(01-SPEC F-5) */
  volumeGcDays?: number;
  /** 单次 tick 最多扫多少条过期订阅,默认 100 */
  expireBatchSize?: number;
  /** 单次 tick 最多扫多少条 GC 候选,默认 100 */
  gcBatchSize?: number;
  logger?: LifecycleLogger;
}

export interface LifecycleTickResult {
  /** 被置为 expired 并成功 stop 的容器数 */
  expired: number;
  /** expired 扫描里 stop 失败(docker down / not found / etc)的条数 */
  expire_errors: number;
  /** 被 GC 的 volume 组数(一组 = workspace + home) */
  gc: number;
  /** GC 失败的条数 */
  gc_errors: number;
}

/**
 * 一次 lifecycle 扫描。返回每一步的成功/失败计数,供外部 metrics 上报。
 */
export async function runLifecycleTick(
  docker: Docker,
  opts: LifecycleTickOptions = {},
): Promise<LifecycleTickResult> {
  const logger = opts.logger ?? NOOP_LOGGER;
  const gcDays = opts.volumeGcDays ?? DEFAULT_AGENT_VOLUME_GC_DAYS;
  const expireBatch = opts.expireBatchSize ?? 100;
  const gcBatch = opts.gcBatchSize ?? 100;

  const result: LifecycleTickResult = {
    expired: 0,
    expire_errors: 0,
    gc: 0,
    gc_errors: 0,
  };

  // (a) 扫过期订阅 → stopContainer + markContainerStoppedAfterExpiry
  let expiredRows: ExpiredSubscriptionRow[];
  try {
    expiredRows = await markExpiredSubscriptions(expireBatch);
  } catch (err) {
    logger.error("[agent/lifecycle] markExpiredSubscriptions failed", {
      error: (err as Error).message,
    });
    expiredRows = [];
  }

  for (const row of expiredRows) {
    const uid = bigintToUidNum(row.user_id);
    try {
      await stopContainer(docker, uid);
      await markContainerStoppedAfterExpiry(row.user_id, gcDays);
      result.expired += 1;
      logger.info("[agent/lifecycle] subscription expired, container stopped", {
        uid,
        subscription_id: row.subscription_id.toString(),
      });
    } catch (err) {
      // 单用户失败不中断 batch
      result.expire_errors += 1;
      logger.error("[agent/lifecycle] expire-stop failed for user", {
        uid,
        error: (err as Error).message,
      });
      // 仍然尝试置 DB 的 stopped 状态(docker 层已经 stop 失败,但 DB 要推进状态,
      // 否则下次 tick 重复扫相同订阅)。即使再失败也吞掉。
      try {
        await markContainerStoppedAfterExpiry(row.user_id, gcDays);
      } catch { /* best-effort */ }
    }
  }

  // (b) 扫 volume GC 候选 → removeContainer + removeUserVolumes + markContainerRemoved
  let gcRows: GcCandidateRow[];
  try {
    gcRows = await listVolumeGcCandidates(gcBatch);
  } catch (err) {
    logger.error("[agent/lifecycle] listVolumeGcCandidates failed", {
      error: (err as Error).message,
    });
    gcRows = [];
  }

  for (const row of gcRows) {
    const uid = bigintToUidNum(row.user_id);
    try {
      // remove container 不存在也 ok(supervisor.removeContainer 已幂等)
      await removeContainer(docker, uid);
      await removeUserVolumes(docker, uid);
      await markContainerRemoved(row.user_id);
      result.gc += 1;
      logger.info("[agent/lifecycle] volumes gced", {
        uid,
        container_id: row.container_id.toString(),
      });
    } catch (err) {
      result.gc_errors += 1;
      logger.error("[agent/lifecycle] gc failed for user", {
        uid,
        error: (err as Error).message,
      });
      // 不置 removed —— 下次 tick 再试。agent_containers 保留 stopped 状态直到
      // docker 层真正清干净。
    }
  }

  return result;
}

// ============================================================
//  小工具
// ============================================================

function bigintToUidNum(uid: bigint): number {
  if (uid <= 0n || uid > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError(`user_id out of safe integer range: ${uid}`);
  }
  return Number(uid);
}

/**
 * 封装一个定时器。caller 只需拿 `stop()` 在 shutdown 时关掉。
 *
 * 为什么自己搞 setInterval,不引入 node-cron:
 *   - 只有一个 tick,不需要 cron 表达式
 *   - 启动时跑一次("快速生效"),然后按 intervalMs 定期跑
 *   - tick 之间 await 完再排下一个(unref+setTimeout 链),避免 tick 未完又被触发造成并发扫描
 */
export interface LifecycleScheduler {
  /** 立刻终止调度。已在跑的 tick 会跑完,但之后不再排下一次。 */
  stop: () => Promise<void>;
  /**
   * 手动触发一次 tick(绕过定时器),主要给测试。
   * 如果已有 tick 在跑会等它完再跑新的,保持串行。
   */
  runOnce: () => Promise<LifecycleTickResult>;
}

export interface StartLifecycleSchedulerOptions extends LifecycleTickOptions {
  /** 两次 tick 间隔(ms),默认 3600_000(1 小时) */
  intervalMs?: number;
  /** 启动时是否立刻跑一次。默认 false —— gateway 启动完再跑更稳妥 */
  runOnStart?: boolean;
}

export function startLifecycleScheduler(
  docker: Docker,
  opts: StartLifecycleSchedulerOptions = {},
): LifecycleScheduler {
  const logger = opts.logger ?? NOOP_LOGGER;
  const interval = opts.intervalMs ?? 3_600_000;
  let stopped = false;
  let inflight: Promise<LifecycleTickResult> | null = null;
  let timer: NodeJS.Timeout | null = null;

  async function tickLoop(): Promise<void> {
    if (stopped) return;
    try {
      inflight = runLifecycleTick(docker, opts);
      await inflight;
    } catch (err) {
      // runLifecycleTick 不应该 throw(内部已吞),但万一:
      logger.error("[agent/lifecycle] tick threw", { error: (err as Error).message });
    } finally {
      inflight = null;
    }
    if (!stopped) {
      timer = setTimeout(tickLoop, interval);
      // unref:定时器不阻止进程退出
      if (typeof timer.unref === "function") timer.unref();
    }
  }

  if (opts.runOnStart) {
    void tickLoop();
  } else {
    timer = setTimeout(tickLoop, interval);
    if (typeof timer.unref === "function") timer.unref();
  }

  return {
    async stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (inflight) {
        try { await inflight; } catch { /* already logged */ }
      }
    },
    async runOnce() {
      // 若正有 tick 在跑,等它完;避免并发扫描
      if (inflight) { try { await inflight; } catch { /* */ } }
      return runLifecycleTick(docker, opts);
    },
  };
}
