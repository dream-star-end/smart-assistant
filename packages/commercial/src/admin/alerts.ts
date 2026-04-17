/**
 * T-62 — 告警器。
 *
 * ### 策略
 *   - 每 tickIntervalMs 轮询一次,取 metrics snapshot(不复用 /metrics 渲染,
 *     直接调 `snapshotForAlerts` 以便测试注入)
 *   - 对每条 rule 执行 evaluate:返 true = firing。
 *   - firing 状态从 false → true 时发"告警触发"消息;true → false 时发"恢复"消息。
 *   - 维持 firing 不重复发(避免 N 分钟轮一次 = N 条告警)。
 *
 * ### Telegram
 *   - env `ALERT_TG_BOT_TOKEN` / `ALERT_TG_CHAT` 两者任一缺失 → scheduler 仍 tick,
 *     但 sender 走 stdout(测试 / 干跑场景)
 *   - 发送用 fetch;失败仅 warn,不阻塞下一 tick
 *
 * ### 规则集(最小)
 *   - `account_pool_all_down`:没有任何账号处于 status=active 且 health_score>0
 *   - `no_accounts_configured`:账号池完全为空(部署新机器常见误报源头,所以单独 rule)
 *
 * 更细粒度的 rate-based rules(debit error spike 等)按需追加 —— 这里先打基础。
 */

import { snapshotForAlerts, type CollectDeps } from "./metrics.js";

export interface AlertSender {
  /** 发送告警文本(Markdown / 纯文本皆可 —— 调用方和 sender 约定)。 */
  send(text: string): Promise<void>;
}

export interface AlertRule {
  /** 唯一 id,供 state map / 日志使用。 */
  id: string;
  /**
   * @returns `true` 表示"当前应该告警";`false` 表示健康。
   *          不抛:evaluate 内部应 swallow 自己造出的异常。
   */
  evaluate(snapshot: Snapshot): Promise<boolean> | boolean;
  /** 触发时的文本(返回 markdown,带换行)。 */
  firingMessage(snapshot: Snapshot): string;
  /** 恢复时的文本。 */
  resolvedMessage(snapshot: Snapshot): string;
}

export interface Snapshot {
  accountHealth: Array<{ account_id: string; health_score: number; status: string }>;
  agentContainersRunning: number;
}

export interface AlertSchedulerOptions {
  /** tick 间隔,默认 60s。 */
  intervalMs?: number;
  /** 规则集。缺省用 defaultRules()。 */
  rules?: AlertRule[];
  /** 告警 sender。缺省根据 env 选 Telegram / stdout。 */
  sender?: AlertSender;
  /** 采样 snapshot 的依赖 —— 测试注入 override。 */
  collectDeps?: CollectDeps;
  /** 启动后立即跑一次(默认 false:等到第一个 interval)。 */
  runOnStart?: boolean;
  /**
   * 自定义错误回调 —— 默认 stderr。scheduler 自己不 throw。
   * evaluate / sender 抛任何异常都走这里,不影响下一 tick。
   */
  onError?: (ruleId: string, err: unknown) => void;
}

export interface AlertScheduler {
  stop(): Promise<void>;
  /** 手动触发一次 tick(集成测试用)。 */
  tickNow(): Promise<void>;
  /** 当前 firing 中的 rule id 集合(测试可 assert)。 */
  firingRules(): Set<string>;
}

function defaultOnError(ruleId: string, err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn(`[admin/alerts] rule ${ruleId} tick error:`, err);
}

// ─── sender 实现 ──────────────────────────────────────────────────────

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

// ─── 默认规则 ─────────────────────────────────────────────────────────

/**
 * account_pool_all_down:
 *   触发:accounts 非空,但 **无** 任何账号满足 status=active 且 health_score>0
 *   含义:线上聊天会全部打不出去
 */
export const ruleAccountPoolAllDown: AlertRule = {
  id: "account_pool_all_down",
  evaluate(s) {
    if (s.accountHealth.length === 0) return false; // 由 no_accounts_configured 管
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

/**
 * no_accounts_configured:
 *   触发:accounts 表完全为空
 *   含义:要么部署刚上来还没配账号,要么管理员全删了 —— 二者都要人工干预
 */
export const ruleNoAccountsConfigured: AlertRule = {
  id: "no_accounts_configured",
  evaluate(s) {
    return s.accountHealth.length === 0;
  },
  firingMessage() {
    return "*[ALERT] 账号池为空* —— 没有配置任何 Claude 账号,商业化聊天无法服务。";
  },
  resolvedMessage(s) {
    return `*[RESOLVED] 账号池已配置* —— 共 ${s.accountHealth.length} 个账号。`;
  },
};

export function defaultRules(): AlertRule[] {
  return [ruleAccountPoolAllDown, ruleNoAccountsConfigured];
}

// ─── scheduler ────────────────────────────────────────────────────────

export function startAlertScheduler(opts: AlertSchedulerOptions = {}): AlertScheduler {
  const interval = opts.intervalMs ?? 60_000;
  const rules = opts.rules ?? defaultRules();
  const sender = opts.sender ?? createTelegramSender();
  const onError = opts.onError ?? defaultOnError;
  const firing = new Set<string>();
  let stopped = false;
  let inflight: Promise<void> | null = null;

  async function runOneTick(): Promise<void> {
    let snapshot: Snapshot;
    try {
      snapshot = await snapshotForAlerts(opts.collectDeps ?? {});
    } catch (err) {
      onError("__snapshot__", err);
      return;
    }
    for (const rule of rules) {
      try {
        const current = await rule.evaluate(snapshot);
        const wasFiring = firing.has(rule.id);
        if (current && !wasFiring) {
          firing.add(rule.id);
          await sender.send(rule.firingMessage(snapshot));
        } else if (!current && wasFiring) {
          firing.delete(rule.id);
          await sender.send(rule.resolvedMessage(snapshot));
        }
      } catch (err) {
        onError(rule.id, err);
      }
    }
  }

  /**
   * 串行化 tick:统一跑一条 "pending tick" 队列:
   *   - 正在跑 → 把新请求合并到 pending(tickNow/interval 来几次都算一次 pending)
   *   - 不在跑 → 立刻启动
   * 这样 setInterval 和 tickNow 共享 lane,绝不并跑,resolve/fire state 不会错乱。
   */
  function scheduleTick(): Promise<void> {
    if (inflight) return inflight;
    inflight = runOneTick().finally(() => { inflight = null; });
    return inflight;
  }

  const timer = setInterval(() => {
    if (stopped) return;
    // 不 await:interval 只负责踢,不背压。scheduleTick 自己会去重。
    void scheduleTick();
  }, interval);
  // 不阻塞进程退出
  if (typeof timer.unref === "function") timer.unref();

  if (opts.runOnStart) {
    void scheduleTick();
  }

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (inflight) {
        try { await inflight; } catch { /* */ }
      }
    },
    async tickNow() {
      // 若当前已有 tick 在跑 → 等它,再跑一次保证观察最新状态。
      // 若无 → 直接启一次。两路都走 scheduleTick,和 interval 共享 lane。
      if (inflight) {
        try { await inflight; } catch { /* */ }
      }
      await scheduleTick();
    },
    firingRules() {
      return new Set(firing);
    },
  };
}
