/**
 * A1 — pending 订单 expirer sweeper。
 *
 * 设计:
 *   - 60s interval setInterval,默认 runOnStart=true(部署即清历史脏单)
 *   - timer.unref() — 不阻止进程退出
 *   - 每 tick 调 expirePendingOrders(),失败 console.warn 不抛
 *   - 单进程:同 v3 单 commercial 部署假设,不需要分布式锁
 *
 * 修复对象:
 *   payment/orders.ts:expirePendingOrders 已实现且 export,但全 commercial 代码
 *   内没有任何调度器调用它,导致 pending 订单永远不会被推到 expired。
 *
 * 与 markOrderPaid 的关系:
 *   markOrderPaid 不在事务内对 expires_at 做硬防线(避免用户超时几秒扫码就硬失败
 *   的体验回归);过期单的清理由本 sweeper 负责,订单被推 expired 后 markOrderPaid
 *   走 status!=='pending' 分支自然拒付。这等价于"60s 宽容尾巴",兼顾价格冻结漏
 *   洞修复 + 用户超时体验。详见 markOrderPaid 内的注释。
 */

import { expirePendingOrders } from "./orders.js";

export const DEFAULT_INTERVAL_MS = 60_000;
export const MIN_INTERVAL_MS = 1000;

export interface SweeperHandle {
  stop(): void;
  /** 测试用:立即跑一次 expire,返回受影响行数。 */
  runNow(): Promise<number>;
}

export interface SweeperOptions {
  intervalMs?: number;
  /** 默认 true:boot 后立即清一次历史脏单(部署修复立即生效)。 */
  runOnStart?: boolean;
  onError?: (err: unknown) => void;
  /** 测试用注入:覆盖默认 expirePendingOrders 调用(便于无 DB 单元测试)。 */
  expireFn?: () => Promise<number>;
}

function defaultOnError(err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn("[pendingOrdersExpirer] expire failed:", err);
}

/**
 * 启动 sweeper。返回 handle 可调 stop()。
 */
export function startPendingOrdersExpirer(opts: SweeperOptions = {}): SweeperHandle {
  const interval = Math.max(MIN_INTERVAL_MS, opts.intervalMs ?? DEFAULT_INTERVAL_MS);
  const onError = opts.onError ?? defaultOnError;
  const expireFn = opts.expireFn ?? expirePendingOrders;
  const runOnStart = opts.runOnStart ?? true;
  let stopped = false;

  async function runOneTick(): Promise<number> {
    try {
      return await expireFn();
    } catch (err) {
      onError(err);
      return 0;
    }
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
