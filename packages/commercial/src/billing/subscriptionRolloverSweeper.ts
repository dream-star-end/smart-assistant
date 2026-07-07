/**
 * 0096 / 0115 — 订阅周期轮转 sweeper（个人 + org 席位订阅,一套机制同 tick 跑）。
 *
 * 设计（镜像 payment/pendingOrdersExpirer 的 SweeperHandle 模式）：
 *   - 默认 5min interval setInterval，timer.unref() 不阻止进程退出
 *   - 每 tick 先排空**个人**订阅轮转 rolloverExpiredSubscriptions(),再排空 **org 席位订阅**
 *     轮转 rolloverExpiredOrgSubscriptions()。两者同为 v5-owned 订阅域、同 5min tick、同
 *     FOR UPDATE SKIP LOCKED 认领模式 —— **并入同一 sweeper 而非新建独立 sweeper**,避免第二个
 *     timer/scheduler 注册项/shutdown(不造第二套并行机制)。任一失败 console.warn 不抛。
 *   - 单进程：同 commercial 单部署假设，无需分布式锁（rollover 内部 FOR UPDATE SKIP LOCKED）
 *
 * 语义（boss 决策：手动续费 + 用完即止 + 到期处理）：
 *   - 个人:付费档到期未续 → 降级 free（period_credits=300）;free 档到期 → 月度续期 free。
 *   - org(0115,无 free 档):到期 → 清零 org 期内池 + status='expired',**不降档/不动 org
 *     钱包/不踢成员**(方案 §11)。
 *   钱包(users.credits / orgs.credits)不动（存量真金不受影响）。
 */

import { rolloverExpiredSubscriptions } from "./subscription.js";
import { rolloverExpiredOrgSubscriptions } from "../org/orgSubscriptions.js";

export const DEFAULT_INTERVAL_MS = 300_000; // 5min
export const MIN_INTERVAL_MS = 1000;
export const DEFAULT_BATCH = 200;

export interface SubscriptionRolloverHandle {
  stop(): void;
  /** 测试用：立即跑一次轮转（个人 + org），返回处理的行数合计。 */
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
  /** 测试用注入：覆盖默认 rolloverExpiredOrgSubscriptions（org 轮转,便于无 DB 单测）。 */
  orgRolloverFn?: (limit: number) => Promise<bigint[]>;
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
  const orgRolloverFn = opts.orgRolloverFn ?? rolloverExpiredOrgSubscriptions;
  const runOnStart = opts.runOnStart ?? true;
  let stopped = false;

  // 分批排空一类订阅轮转（每批最多 batch 行,避免一次锁太多行；空批即停/不足一批即停）。
  async function drain(fn: (limit: number) => Promise<bigint[]>): Promise<number> {
    let total = 0;
    for (;;) {
      if (stopped) break;
      const ids = await fn(batch);
      total += ids.length;
      if (ids.length < batch) break; // 不足一批 → 已排空
    }
    return total;
  }

  // 一次 tick：先排空个人订阅轮转,再排空 org 席位订阅轮转（一套机制,同 tick）。
  // **两域各自独立 try/catch**：一个域持续抛错不得饿死另一个域(否则个人轮转有 bug 会让 org
  // 到期池永不清零,反之亦然)。任一抛错 → onError 记录,该域本 tick 跳过,下一 tick 重试
  //（两域轮转均幂等 + FOR UPDATE SKIP LOCKED 认领,重试安全)。
  async function runOneTick(): Promise<number> {
    let total = 0;
    try {
      total += await drain(rolloverFn);
    } catch (err) {
      onError(err);
    }
    if (!stopped) {
      try {
        total += await drain(orgRolloverFn);
      } catch (err) {
        onError(err);
      }
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
