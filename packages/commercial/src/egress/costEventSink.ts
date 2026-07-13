/**
 * Egress → master 的 cost 回执发送队列。
 *
 * anthropicProxy 的两个 post-commit hook(appendCostCredits 持久化 /
 * broadcastToUser cost_charged 广播)在 split 模式下由本 sink 打包 POST 到
 * master 控制口 /internal/v5/cost-event(见 http/internalCostEvent.ts 头注)。
 *
 * 语义:
 *   - FIFO 单飞发送(保证同一请求 persist 先于 broadcast 到达 master —— 与原
 *     进程内 "persist first, broadcast second" 顺序一致)。
 *   - master 短暂不可达(正在重启 —— 这正是 split 要支撑的场景)→ 事件留队列,
 *     1s 起指数退避重试,单事件最多存活 EVENT_TTL_MS(120s,覆盖一次 master
 *     重启窗口)后丢弃并 warn。计费本身在 PG 早已落定,丢的只是徽章/气泡回执,
 *     且 persist 有 pending_usage_patches GC sweep 兜底路径。
 *   - 队列上限防内存失控;溢出丢最老(同 TTL 语义:回执尽力而为)。
 */

import { request as undiciRequest } from "undici";

import { rootLogger, type Logger } from "../logging/logger.js";
import { COST_EVENT_PATH, EGRESS_SECRET_HEADER, type CostEvent } from "../http/internalCostEvent.js";

const EVENT_TTL_MS = 120_000;
const MAX_QUEUE = 2_000;
const MAX_BATCH = 32;
const BASE_RETRY_MS = 1_000;
const MAX_RETRY_MS = 10_000;
const ATTEMPT_TIMEOUT_MS = 5_000;

interface QueuedEvent {
  ev: CostEvent;
  enqueuedAt: number;
}

export interface CostEventSinkOpts {
  /** master 控制口 base,如 http://127.0.0.1:18894 */
  controlBaseUrl: string;
  secret: string;
  logger?: Logger;
  fetcher?: typeof undiciRequest;
  now?: () => number;
}

/**
 * egress /healthz 暴露的单调计数器快照(RFC-v5-dual-master-cohort §4 D3④)。
 * finalize 门槛按"两次采样差分 + startId 未变"判断队列是否真排空(计数归零假绿被
 * startId 变化拦截)。全部单调递增,drop 分类计数;不改任何计费行为,纯观测。
 */
export interface CostSinkHealthCounters {
  /** 当前队列长度(= 尚未成功发送的回执数)。 */
  pendingCostEvents: number;
  /** 累计入队事件数(单调)。 */
  enqueuedTotal: number;
  /** 累计成功发送到 master 的事件数(单调)。 */
  sentTotal: number;
  /** 累计因 TTL 过期被丢弃的事件数(单调)。 */
  expiredDropsTotal: number;
  /** 累计因队列上限溢出被丢弃(丢最老)的事件数(单调)。 */
  overflowDropsTotal: number;
  /** 队首事件已等待的毫秒数(队列空 → 0);判断 backlog 老化。 */
  oldestPendingAgeMs: number;
}

export class CostEventSink {
  private readonly queue: QueuedEvent[] = [];
  private readonly log: Logger;
  private readonly fetcher: typeof undiciRequest;
  private readonly now: () => number;
  private sending = false;
  private inflightPump: Promise<void> | null = null;
  private retryMs = BASE_RETRY_MS;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  // ── 单调计数器(D3④ finalize 门槛差分用;纯观测,不影响计费/发送行为)──
  private enqueuedTotal = 0;
  private sentTotal = 0;
  private expiredDropsTotal = 0;
  private overflowDropsTotal = 0;

  constructor(private readonly opts: CostEventSinkOpts) {
    this.log = (opts.logger ?? rootLogger).child({ subsys: "costEventSink" });
    this.fetcher = opts.fetcher ?? undiciRequest;
    this.now = opts.now ?? Date.now;
  }

  enqueue(ev: CostEvent): void {
    if (this.stopped) return;
    this.queue.push({ ev, enqueuedAt: this.now() });
    this.enqueuedTotal += 1;
    if (this.queue.length > MAX_QUEUE) {
      const dropped = this.queue.shift();
      this.overflowDropsTotal += 1;
      this.log.warn("cost_event_queue_overflow_drop_oldest", { kind: dropped?.ev.kind });
    }
    void this.pump();
  }

  /** 进程退出前尽力清空(不保证;不阻塞超过几秒由调用方控制)。
   *  与 enqueue 触发的在飞 pump 汇合后再补一轮,保证"入队即 flush"不竞态漏发。 */
  async flush(): Promise<void> {
    if (this.inflightPump) await this.inflightPump;
    await this.pump();
    if (this.inflightPump) await this.inflightPump;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  get pending(): number {
    return this.queue.length;
  }

  /** D3④ finalize 门槛用的健康计数器快照(单调计数 + 队首老化 + 当前 pending)。 */
  healthCounters(): CostSinkHealthCounters {
    const oldestPendingAgeMs =
      this.queue.length > 0 ? this.now() - this.queue[0]!.enqueuedAt : 0;
    return {
      pendingCostEvents: this.queue.length,
      enqueuedTotal: this.enqueuedTotal,
      sentTotal: this.sentTotal,
      expiredDropsTotal: this.expiredDropsTotal,
      overflowDropsTotal: this.overflowDropsTotal,
      oldestPendingAgeMs,
    };
  }

  private scheduleRetry(): void {
    if (this.timer || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pump();
    }, this.retryMs);
    this.timer.unref?.();
    this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
  }

  private evictExpired(): void {
    const cutoff = this.now() - EVENT_TTL_MS;
    while (this.queue.length > 0 && this.queue[0]!.enqueuedAt < cutoff) {
      const dropped = this.queue.shift()!;
      this.expiredDropsTotal += 1;
      this.log.warn("cost_event_expired_dropped", {
        kind: dropped.ev.kind,
        ageMs: this.now() - dropped.enqueuedAt,
      });
    }
  }

  private pump(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inflightPump) return this.inflightPump;
    this.inflightPump = this.pumpLoop().finally(() => {
      this.inflightPump = null;
    });
    return this.inflightPump;
  }

  private async pumpLoop(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.queue.length > 0) {
        this.evictExpired();
        if (this.queue.length === 0) break;
        const batch = this.queue.slice(0, MAX_BATCH);
        try {
          const r = await this.fetcher(`${this.opts.controlBaseUrl}${COST_EVENT_PATH}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              [EGRESS_SECRET_HEADER]: this.opts.secret,
            },
            body: JSON.stringify({ events: batch.map((q) => q.ev) }),
            headersTimeout: ATTEMPT_TIMEOUT_MS,
            bodyTimeout: ATTEMPT_TIMEOUT_MS,
          });
          await r.body.text().catch(() => "");
          if (r.statusCode !== 200) throw new Error(`HTTP ${r.statusCode}`);
          this.queue.splice(0, batch.length);
          this.sentTotal += batch.length;
          this.retryMs = BASE_RETRY_MS;
        } catch (err) {
          this.log.warn("cost_event_send_failed_will_retry", {
            pending: this.queue.length,
            err: (err as Error).message,
          });
          this.scheduleRetry();
          return; // 保序:失败即停,等重试 timer
        }
      }
    } finally {
      this.sending = false;
    }
  }
}
