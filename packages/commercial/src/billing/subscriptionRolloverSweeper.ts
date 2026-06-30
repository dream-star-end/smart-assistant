/**
 * 0096 — 订阅周期轮转 sweeper。
 *
 * 设计（镜像 payment/pendingOrdersExpirer 的 SweeperHandle 模式）：
 *   - 默认 5min interval setInterval，timer.unref() 不阻止进程退出
 *   - 每 tick 调 rolloverExpiredSubscriptions()：把 period_end < now 的 active 订阅
 *     降级/续期到 free（清零旧期内桶 + 重置 free 300 + 周期顺延）。失败 console.warn 不抛
 *   - 单进程：同 commercial 单部署假设，无需分布式锁（rollover 内部 FOR UPDATE SKIP LOCKED）
 *
 * 语义（boss 决策：手动续费 + 用完即止 + 到期降级免费版）：
 *   - 付费档到期未续 → 降级 free（period_credits=300）。
 *   - free 档到期 → 月度续期 free（重置 300）。
 *   钱包 users.credits 不动（存量真金不受影响）。
 */

import { rolloverExpiredSubscriptions } from "./subscription.js";

export const DEFAULT_INTERVAL_MS = 300_000; // 5min
export const MIN_INTERVAL_MS = 1000;
export const DEFAULT_BATCH = 200;

export interface SubscriptionRolloverHandle {
  stop(): void;
  /** 测试用：立即跑一次轮转，返回处理的用户数。 */
  runNow(): Promise<number>;
}

export interface SubscriptionRolloverOptions {
  intervalMs?: number;
  batchLimit?: number;
  /** 默认 true：boot 后立即跑一次（部署即结算已到期订阅）。 */
  runOnStart?: boolean;
  onError?: (err: unknown) => void;
  /** 测试用注入：覆盖默认 rolloverExpiredSubscriptions（便于无 DB 单测）。 */
  rolloverFn?: (limit: number) => Promise<bigint[]>;
}

function defaultOnError(err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn("[subscriptionRolloverSweeper] rollover failed:", err);
}

/** 启动订阅轮转 sweeper。返回 handle 可调 stop()。 */
export function startSubscriptionRolloverSweeper(
  opts: SubscriptionRolloverOptions = {},
): SubscriptionRolloverHandle {
  const interval = Math.max(MIN_INTERVAL_MS, opts.intervalMs ?? DEFAULT_INTERVAL_MS);
  const batch = opts.batchLimit ?? DEFAULT_BATCH;
  const onError = opts.onError ?? defaultOnError;
  const rolloverFn = opts.rolloverFn ?? rolloverExpiredSubscriptions;
  const runOnStart = opts.runOnStart ?? true;
  let stopped = false;

  // 一次 tick 内分批排空（每批最多 batch 行），避免一次锁太多行；空批即停。
  async function runOneTick(): Promise<number> {
    let total = 0;
    try {
      for (;;) {
        if (stopped) break;
        const ids = await rolloverFn(batch);
        total += ids.length;
        if (ids.length < batch) break; // 不足一批 → 已排空
      }
    } catch (err) {
      onError(err);
    }
    return total;
  }

  const timer = setInterval(() => {
    if (stopped) return;
    void runOneTick();
  }, interval);
  if (typeof timer.unref === "function") timer.unref();

  if (runOnStart) {
    void runOneTick();
  }

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    runNow: runOneTick,
  };
}
