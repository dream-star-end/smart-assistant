/**
 * T-62 / T-63 — 告警调度器。
 *
 * 负责:
 *   1. 每 tickIntervalMs 跑一次 `runRulesOnce`(alertRules.ts 里定义的 5 条轮询规则)。
 *      翻转 firing / resolved 时把事件 enqueue 到 admin_alert_outbox。
 *   2. 启动 per-channel iLink long-poll + global dispatcher(ilinkAlertWorker.ts)。
 *      dispatcher 5s tick,扫 outbox 发 WeChat。
 *
 * 保留 T-62 的 Telegram/Snapshot API(SnapshotForAlerts)以兼容旧测试,但默认 scheduler
 * 不再直接推 Telegram;所有告警走 outbox → iLink → WeChat。Telegram 可在二期接回成
 * 一个额外 channel_type。
 *
 * env:
 *   - COMMERCIAL_ALERTS_DISABLED=1  → 整个 scheduler 不启动
 *   - COMMERCIAL_ALERT_TICK_MS      → scheduler 轮询间隔,默认 60_000ms,下限 1000ms
 *   - COMMERCIAL_ILINK_DISPATCH_MS  → dispatcher 间隔,默认 5000ms,下限 500ms
 *
 * scheduler / worker 各跑各的 interval,互不阻塞:rule tick 只写 DB;worker 从 DB 读
 * 并 iLink send。即便 WeChat 挂掉,outbox 会积压 + 指数退避,rule 继续工作。
 */

import { snapshotForAlerts, type CollectDeps } from "./metrics.js";
import { runRulesOnce, type RunRulesResult } from "./alertRules.js";
import {
  startIlinkAlertWorker,
  type IlinkWorkerHandle,
} from "./ilinkAlertWorker.js";
import {
  startComputeHostDiskMonitor,
  type DiskMonitorHandle,
} from "../compute-pool/computeHostsDiskMonitor.js";

// ─── 遗留类型(保留供旧测试 + snapshotForAlerts 消费)────────────────────

export interface AlertSender {
  send(text: string): Promise<void>;
}

export interface AlertRule {
  id: string;
  evaluate(snapshot: Snapshot): Promise<boolean> | boolean;
  firingMessage(snapshot: Snapshot): string;
  resolvedMessage(snapshot: Snapshot): string;
}

export interface Snapshot {
  accountHealth: Array<{ account_id: string; health_score: number; status: string }>;
  agentContainersRunning: number;
}

export interface AlertSchedulerOptions {
  /** rule tick 间隔,默认 60s。 */
  intervalMs?: number;
  /** 启动后是否立刻跑一次(默认 false,等 interval)。 */
  runOnStart?: boolean;
  /**
   * 测试:关闭 iLink worker(不起 long-poll / dispatcher)。生产必须 false。
   */
  disableIlinkWorker?: boolean;
  /** dispatcher 间隔(iLink worker),默认 5000ms。 */
  ilinkDispatchIntervalMs?: number;
  /**
   * 测试:关闭 compute_host 磁盘监控(不起 5min interval + SSH)。生产必须 false。
   */
  disableDiskMonitor?: boolean;
  /** 错误回调 */
  onError?: (scope: string, err: unknown) => void;
  /** 兼容旧测试:允许注入 collectDeps / rules / sender(当前忽略,MVP 不回落)。 */
  collectDeps?: CollectDeps;
  rules?: AlertRule[];
  sender?: AlertSender;
}

export interface AlertScheduler {
  stop(): Promise<void>;
  /** 手动跑一次 rule tick(集成测试用)。 */
  tickNow(): Promise<RunRulesResult>;
  /** 手动踢一次 dispatcher(测试用)。 */
  dispatchNow(): Promise<number>;
  /** 当前活跃 long-poll channel ids(测试可 assert)。 */
  activeChannels(): Set<string>;
}

function defaultOnError(scope: string, err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn(`[admin/alerts] ${scope} error:`, err);
}

// ─── Telegram sender(保留兼容)─────────────────────────────────────────

/** @deprecated T-63 后告警走 iLink WeChat,Telegram sender 保留兼容。 */
export function createTelegramSender(env: NodeJS.ProcessEnv = process.env): AlertSender {
  const token = env.ALERT_TG_BOT_TOKEN ?? "";
  const chat = env.ALERT_TG_CHAT ?? "";
  if (!token || !chat) {
    return {
      async send(text) {
        // eslint-disable-next-line no-console
        console.warn("[admin/alerts] Telegram not configured — would send:\n" + text);
      },
    };
  }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  return {
    async send(text) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: chat,
            text,
            parse_mode: "Markdown",
            disable_web_page_preview: true,
          }),
        });
        if (!res.ok) {
          // eslint-disable-next-line no-console
          console.warn(`[admin/alerts] Telegram send failed ${res.status}: ${await res.text().catch(() => "")}`);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[admin/alerts] Telegram send exception:", err);
      }
    },
  };
}

// ─── 遗留 rules 保留(兼容 snapshotForAlerts + 旧测试)──────────────────

/** @deprecated T-63 用 alertRules.ts 的 PolledRule 集合,这里只留类型签名。 */
export const ruleAccountPoolAllDown: AlertRule = {
  id: "account_pool_all_down",
  evaluate(s) {
    if (s.accountHealth.length === 0) return false;
    return !s.accountHealth.some((a) => a.status === "active" && a.health_score > 0);
  },
  firingMessage(s) {
    const summary = s.accountHealth
      .slice(0, 10)
      .map((a) => `- #${a.account_id} status=${a.status} health=${a.health_score}`)
      .join("\n");
    return `*[ALERT] 账号池全部失效*\n\n共 ${s.accountHealth.length} 个账号,无 active+healthy。\n\n${summary}`;
  },
  resolvedMessage(s) {
    const healthy = s.accountHealth.filter((a) => a.status === "active" && a.health_score > 0).length;
    return `*[RESOLVED] 账号池恢复* —— ${healthy}/${s.accountHealth.length} 账号重新 healthy。`;
  },
};

/** @deprecated 同上。 */
export const ruleNoAccountsConfigured: AlertRule = {
  id: "no_accounts_configured",
  evaluate(s) { return s.accountHealth.length === 0; },
  firingMessage() {
    return "*[ALERT] 账号池为空* —— 没有配置任何 Claude 账号,商业化聊天无法服务。";
  },
  resolvedMessage(s) {
    return `*[RESOLVED] 账号池已配置* —— 共 ${s.accountHealth.length} 个账号。`;
  },
};

/** @deprecated T-63 改用 alertRules.defaultPolledRules()。 */
export function defaultRules(): AlertRule[] {
  return [ruleAccountPoolAllDown, ruleNoAccountsConfigured];
}

// 兼容导出(旧测试从这里取 snapshot 类型)
export { snapshotForAlerts };

// ─── scheduler(T-63 新实现)──────────────────────────────────────────

export function startAlertScheduler(opts: AlertSchedulerOptions = {}): AlertScheduler {
  const interval = Math.max(1000, opts.intervalMs ?? 60_000);
  const onError = opts.onError ?? defaultOnError;
  let stopped = false;
  let inflight: Promise<RunRulesResult> | null = null;

  async function runOneTick(): Promise<RunRulesResult> {
    try {
      return await runRulesOnce();
    } catch (err) {
      onError("runRulesOnce", err);
      return { evaluated: [], firings: [], resolutions: [], errors: [{ rule_id: "__top__", err: String(err) }] };
    }
  }

  function scheduleTick(): Promise<RunRulesResult> {
    if (inflight) return inflight;
    inflight = runOneTick().finally(() => { inflight = null; });
    return inflight;
  }

  const timer = setInterval(() => {
    if (stopped) return;
    void scheduleTick();
  }, interval);
  if (typeof timer.unref === "function") timer.unref();

  if (opts.runOnStart) {
    void scheduleTick();
  }

  // iLink worker(生产必开;测试可通过 disableIlinkWorker 关)
  let ilinkWorker: IlinkWorkerHandle | null = null;
  if (!opts.disableIlinkWorker) {
    ilinkWorker = startIlinkAlertWorker({
      dispatchIntervalMs: opts.ilinkDispatchIntervalMs,
      onError: (scope, err) => onError(`ilink:${scope}`, err),
    });
  }

  // compute_host 磁盘监控(5min 独立 interval,生产必开;测试可关)
  let diskMonitor: DiskMonitorHandle | null = null;
  if (!opts.disableDiskMonitor) {
    diskMonitor = startComputeHostDiskMonitor({});
  }

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (inflight) {
        try { await inflight; } catch { /* */ }
      }
      if (ilinkWorker) {
        try { await ilinkWorker.stop(); } catch { /* */ }
      }
      if (diskMonitor) {
        try { await diskMonitor.stop(); } catch { /* */ }
      }
    },
    async tickNow() {
      if (inflight) {
        try { await inflight; } catch { /* */ }
      }
      return scheduleTick();
    },
    async dispatchNow() {
      return ilinkWorker?.dispatchNow() ?? 0;
    },
    activeChannels() {
      return ilinkWorker?.activeChannels() ?? new Set();
    },
  };
}
