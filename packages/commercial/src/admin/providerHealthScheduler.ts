/**
 * provider 健康度 —— 判定层 scheduler(master,roadmap P3.2)。
 *
 * 每 tick(默认 60s)对每个静态 provider:读近窗口健康样本 + latencyProber 辅助信号
 * → evaluateProviderHealth 判定 → 仅 health_mode='auto' 时写 provider_ops 健康列并在
 * 状态转移时告警(transitionRuleState firing-once:PROVIDER_DEGRADED critical /
 * PROVIDER_RECOVERED info)。forced_degraded / forced_healthy 尊重管理员,不自动转移。
 *
 * 域归属 **v5-owned**:provider_ops / provider_health_samples 是 v5 引入的表,样本由 v5
 * egress 写入,v3 树无对应代码。gate 公式照 marketplaceAiReview(runtimeChannel==='v5')。
 * 判定/写状态默认开(影子);拦截(503)另由 OC_PROVIDER_HEALTH_ENFORCE 控。
 *
 * 任何 tick 失败只 warn 不冒泡(对齐 latencyProber / computeHostsDiskMonitor 纪律)。
 */

import { STATIC_KEY_PROVIDERS } from "@openclaude/protocol";
import { query as _query } from "../db/queries.js";
import { enqueueAlert as _enqueueAlert, transitionRuleState as _transitionRuleState } from "./alertOutbox.js";
import { EVENTS } from "./alertEvents.js";
import {
  evaluateProviderHealth,
  loadHealthThresholds,
  type HealthSample,
  type HealthStatus,
  type HealthThresholds,
} from "./providerHealth.js";
import { rootLogger, type Logger } from "../logging/logger.js";

const DEFAULT_INTERVAL_MS = 60_000;
/** 样本保留:judgement 只看近 windowMin(默认 10min),留 30min 供 admin 观察。 */
const RETENTION_MIN = 30;
/** latencyProber 辅助信号回看的样本数。 */
const LATENCY_LOOKBACK = 10;
/** 单 provider 窗口样本上限(防极端流量下判定 tick 拉爆内存)。 */
const SAMPLE_SCAN_LIMIT = 5_000;

export interface ProviderHealthSchedulerHandle {
  stop(): void;
  /** 手动跑一轮(测试/运维用)。 */
  runNow(): Promise<void>;
}

interface SchedulerDeps {
  query?: typeof _query;
  enqueueAlert?: typeof _enqueueAlert;
  transitionRuleState?: typeof _transitionRuleState;
  now?: () => number;
  logger?: Logger;
  /** 测试:覆盖被评估的 provider 集(默认 STATIC_KEY_PROVIDERS 的 id)。 */
  providerIds?: string[];
}

export function startProviderHealthScheduler(
  opts: { intervalMs?: number; _deps?: SchedulerDeps } = {},
): ProviderHealthSchedulerHandle {
  const interval = Math.max(10_000, opts.intervalMs ?? DEFAULT_INTERVAL_MS);
  const q = opts._deps?.query ?? _query;
  const enqueue = opts._deps?.enqueueAlert ?? _enqueueAlert;
  const transition = opts._deps?.transitionRuleState ?? _transitionRuleState;
  const now = opts._deps?.now ?? (() => Date.now());
  const log = opts._deps?.logger ?? rootLogger.child({ subsys: "providerHealth" });
  const providerIds = opts._deps?.providerIds ?? STATIC_KEY_PROVIDERS.map((p) => p.id);

  let stopped = false;
  let inflight: Promise<void> | null = null;

  async function evalOne(providerId: string, thresholds: HealthThresholds): Promise<void> {
    const opsR = await q<{ health_status: string | null; health_mode: string }>(
      `SELECT health_status, health_mode FROM provider_ops WHERE provider_id = $1`,
      [providerId],
    );
    const opsRow = opsR.rows[0];
    const mode = opsRow?.health_mode ?? "auto";
    // forced_degraded / forced_healthy 尊重管理员 → 不自动转移、不告警。
    if (mode !== "auto") return;
    const currentStatus: HealthStatus | null =
      opsRow?.health_status === "degraded"
        ? "degraded"
        : opsRow?.health_status === "healthy"
          ? "healthy"
          : null;

    const sinceIso = new Date(now() - thresholds.windowMin * 60_000).toISOString();
    const sampR = await q<{ ok: boolean; kind: string; at: Date }>(
      `SELECT ok, kind, at FROM provider_health_samples
         WHERE provider_id = $1 AND at >= $2
         ORDER BY at DESC LIMIT $3`,
      [providerId, sinceIso, SAMPLE_SCAN_LIMIT],
    );
    const samples: HealthSample[] = sampR.rows.map((r) => ({
      ok: r.ok,
      kind: r.kind,
      at: r.at.getTime(),
    }));

    // latencyProber 辅助信号:近端连续 fail 数(仅加权,绝不单独触发)。
    const latR = await q<{ ok: boolean }>(
      `SELECT ok FROM provider_latency_samples
         WHERE provider_id = $1 ORDER BY probed_at DESC LIMIT $2`,
      [providerId, LATENCY_LOOKBACK],
    );
    let latencyConsecutiveFails = 0;
    for (const r of latR.rows) {
      if (r.ok) break;
      latencyConsecutiveFails++;
    }

    const evaln = evaluateProviderHealth({
      samples,
      currentStatus,
      latencyConsecutiveFails,
      now: now(),
      thresholds,
    });
    if (evaln.transition === "none") return;

    const ruleId = `provider_health:${providerId}`;

    if (evaln.transition === "to_degraded") {
      // 稀疏 upsert;ON CONFLICT WHERE 再次守 health_mode='auto'(防 read→write 间 admin 强制的 TOCTOU)。
      const w = await q(
        `INSERT INTO provider_ops (provider_id, health_status, degraded_since, degrade_reason, health_mode)
           VALUES ($1, 'degraded', NOW(), $2, 'auto')
         ON CONFLICT (provider_id) DO UPDATE SET
           health_status = 'degraded', degraded_since = NOW(), degrade_reason = EXCLUDED.degrade_reason
           WHERE provider_ops.health_mode = 'auto'`,
        [providerId, evaln.reason],
      );
      if ((w.rowCount ?? 0) === 0) return; // 被强制模式抢先 → 不告警
      log.warn("provider_health_degraded", { provider: providerId, reason: evaln.reason, ...evaln.snapshot });
      const trans = await transition(ruleId, true, `${EVENTS.PROVIDER_DEGRADED}:${providerId}`, {
        provider_id: providerId,
        reason: evaln.reason,
        ...evaln.snapshot,
      });
      if (trans.transitioned) {
        await enqueue(
          {
            event_type: EVENTS.PROVIDER_DEGRADED,
            severity: "critical",
            title: `服务商降级 — ${providerId}`,
            body:
              `上游服务商 \`${providerId}\` 被自动判定为**降级**:${evaln.reason}。\n\n` +
              `影响:该服务商下的模型在模型选择器标注「暂不可用」并禁选;` +
              `OC_PROVIDER_HEALTH_ENFORCE=1 时 proxy 对这些模型返回 503(默认影子模式仅标注不拦截)。\n\n` +
              `排查:admin「模型与服务商」页看该 provider 延迟/样本;确认后可在卡片手动「强制恢复」压误判,或「强制降级」锁定。`,
            payload: { provider_id: providerId, reason: evaln.reason, ...evaln.snapshot },
            dedupe_key: `${EVENTS.PROVIDER_DEGRADED}:${providerId}`,
          },
          ruleId,
        );
      }
    } else {
      // to_healthy
      const w = await q(
        `UPDATE provider_ops SET health_status = 'healthy', degraded_since = NULL, degrade_reason = NULL
           WHERE provider_id = $1 AND health_mode = 'auto'`,
        [providerId],
      );
      if ((w.rowCount ?? 0) === 0) return;
      log.info?.("provider_health_recovered", { provider: providerId, reason: evaln.reason });
      const trans = await transition(ruleId, false, null, { provider_id: providerId });
      if (trans.transitioned) {
        await enqueue(
          {
            event_type: EVENTS.PROVIDER_RECOVERED,
            severity: "info",
            title: `服务商恢复 — ${providerId}`,
            body: `上游服务商 \`${providerId}\` 健康已恢复:${evaln.reason}。相关模型恢复可选。`,
            payload: { resolved: true, provider_id: providerId },
            dedupe_key: null,
          },
          ruleId,
        );
      }
    }
  }

  async function runOnce(): Promise<void> {
    const thresholds = loadHealthThresholds();
    for (const id of providerIds) {
      if (stopped) return;
      try {
        await evalOne(id, thresholds);
      } catch (err) {
        log.warn("provider_health_eval_failed", {
          provider: id,
          err: String((err as Error)?.message ?? err),
        });
      }
    }
    // 样本保留清理(judgement 只看近 windowMin,留 RETENTION_MIN 供 admin 观察)。
    try {
      await q(
        `DELETE FROM provider_health_samples WHERE at < NOW() - make_interval(mins => $1)`,
        [RETENTION_MIN],
      );
    } catch (err) {
      log.warn("provider_health_retention_failed", {
        err: String((err as Error)?.message ?? err),
      });
    }
  }

  function scheduleTick(): Promise<void> {
    if (inflight) return inflight; // inflight guard:上轮没结束就跳过
    inflight = runOnce()
      .catch((err) => {
        log.warn("provider_health_tick_failed", { err: String((err as Error)?.message ?? err) });
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  const timer = setInterval(() => {
    if (!stopped) void scheduleTick();
  }, interval);
  timer.unref?.();
  setImmediate(() => {
    if (!stopped) void scheduleTick();
  });

  log.info("provider_health_scheduler_started", { intervalMs: interval, providers: providerIds.length });
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    runNow: scheduleTick,
  };
}
