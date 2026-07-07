/**
 * 0096 / 0115 / 0118 — 订阅轮转 + org 低水位预警 sweeper（个人订阅 + org 席位订阅 + org
 * 低水位预警,三域一套机制同 tick 跑)。
 *
 * 设计（镜像 payment/pendingOrdersExpirer 的 SweeperHandle 模式）：
 *   - 默认 5min interval setInterval，timer.unref() 不阻止进程退出
 *   - 每 tick 依次排空:①**个人**订阅轮转 rolloverExpiredSubscriptions() → ②**org 席位订阅**
 *     轮转 rolloverExpiredOrgSubscriptions() → ③**org 低水位预警** sweepOrgLowBalance()。
 *     三者同为 v5-owned 订阅/计费域、同 5min tick —— **并入同一 sweeper 而非新建独立 sweeper**,
 *     避免第二/三个 timer/scheduler 注册项/shutdown(不造第二套并行机制)。
 *   - **三域各自独立 try/catch**:一个域持续抛错不得饿死另两个域(§17.2 fail-open:预警失败绝不
 *     影响订阅轮转,更不影响计费)。任一抛错 → onError 记录,该域本 tick 跳过,下一 tick 重试。
 *   - 单进程：同 commercial 单部署假设，无需分布式锁（rollover 内部 FOR UPDATE SKIP LOCKED,
 *     低水位靠 low_balance_notified_at 去重）
 *
 * 语义（boss 决策：手动续费 + 用完即止 + 到期处理）：
 *   - 个人:付费档到期未续 → 降级 free（period_credits=300）;free 档到期 → 月度续期 free。
 *   - org(0115,无 free 档):到期 → 清零 org 期内池 + status='expired',**不降档/不动 org
 *     钱包/不踢成员**(方案 §11)。
 *   - org 低水位(0118):总可用 < max(2000,10%×池满) → owner 站内信+邮件(§17.2),去重打戳。
 *   钱包(users.credits / orgs.credits)不动（存量真金不受影响）。
 */

import { rolloverExpiredSubscriptions } from "./subscription.js";
import { rolloverExpiredOrgSubscriptions } from "../org/orgSubscriptions.js";
import { sweepOrgLowBalance } from "../org/orgLowBalance.js";

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
  /** 测试用注入：覆盖默认 sweepOrgLowBalance（org 低水位预警,便于无 DB / 注入 mailer 单测）。 */
  lowBalanceFn?: () => Promise<number>;
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
  const lowBalanceFn = opts.lowBalanceFn ?? (() => sweepOrgLowBalance());
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

  // 一次 tick：依次排空个人订阅轮转 → org 席位订阅轮转 → org 低水位预警(一套机制,同 tick)。
  // **三域各自独立 try/catch**:一个域持续抛错不得饿死另两个域(个人轮转 bug 不得让 org 到期池
  // 永不清零 / org 低水位不得让订阅轮转停摆,反之亦然)。任一抛错 → onError 记录,该域本 tick
  // 跳过,下一 tick 重试(轮转幂等 + FOR UPDATE SKIP LOCKED;低水位靠 low_balance_notified_at
  // 去重,均重试安全)。返回值合计轮转行数 + 预警 org 数(仅测试可观测,不对外语义化)。
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
    if (!stopped) {
      try {
        // 低水位预警是"每 org 至多一次"的通知(去重靠打戳),非批量认领 —— 单次调用即可,
        // 内部自带 batch drain。§17.2 fail-open:失败被本 try/catch 吞,绝不影响上面两域/计费。
        total += await lowBalanceFn();
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
