/**
 * provider 健康度 —— 纯判定/派生层(roadmap P3.2)。
 *
 * 本模块**无副作用**:只做 model→provider 归属、样本窗口判定数学、生效健康派生、
 * 阈值读取。DB 读写在 scheduler(judgement 层)/ egress sink(信号层)/ admin
 * modelOps(状态列)/ gate(读缓存)各自完成 —— 判定逻辑单元测试无需 DB。
 *
 * 三条红线对齐:
 * ① 不做隐式换模型:本模块产出的只是「健康状态」标注,动作层(注解 / 503 / badge)
 *    永远显式,用户自己换。
 * ② 不碰 pricing.enabled / visibility:健康是独立权威(provider_ops 健康列)。
 * ③ 默认影子:判定/写状态默认开;拦截(503)由 OC_PROVIDER_HEALTH_ENFORCE 另控。
 */

// 说明:model→provider 归属在各消费者处直接用 protocol 的 findRouteProviderForModel(model)?.id
// (健康系统只治理**静态 provider**:命中 spec → provider id;undefined(claude OAuth)→
// 归 account-pool 健康体系管,本系统不重复追踪,亦规避最热路径的写放大)。故本纯模块不承担
// 归属映射,只做阈值 / 判定数学 / 生效派生。含 gpt→codex/oauth 的全量 chip 归属仍在
// http/admin/modelOps.ts,那是 admin 展示语义,与健康治理集正交。

// ─── 阈值(env 可调,给缺省)────────────────────────────────────────────

export interface HealthThresholds {
  /** 判定窗口(分钟):近 N min 样本参与降级判定。 */
  windowMin: number;
  /** 恢复窗口(分钟):近 M min 样本参与恢复判定。 */
  recoverWindowMin: number;
  /** 降级最小样本量:窗口内(排除 aborted)样本 < 此值不判降级(防小样本误判)。 */
  minSamples: number;
  /** 降级失败率阈值(0..1)。 */
  degradeRate: number;
  /** 连续失败阈值:近端连续失败 ≥ 此值直接降级(无视失败率)。 */
  consecutiveFails: number;
  /** 恢复失败率阈值(0..1):恢复窗口失败率 < 此值且有成功样本 → 恢复。 */
  recoverRate: number;
  /** latency 辅助:latencyProber 近端连续 fail ≥ 此值时,把降级失败率阈值降到 degradeRateAux。 */
  latencyAuxConsecutive: number;
  /** latency 辅助生效时的降级失败率阈值(0..1),仍受 minSamples 约束,绝不单独触发。 */
  degradeRateAux: number;
}

function envNum(name: string, def: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return def;
  return Math.min(Math.max(raw, min), max);
}

export function loadHealthThresholds(): HealthThresholds {
  return {
    windowMin: envNum("OC_PROVIDER_HEALTH_WINDOW_MIN", 10, 1, 120),
    recoverWindowMin: envNum("OC_PROVIDER_HEALTH_RECOVER_WINDOW_MIN", 5, 1, 120),
    minSamples: envNum("OC_PROVIDER_HEALTH_MIN_SAMPLES", 5, 1, 10_000),
    degradeRate: envNum("OC_PROVIDER_HEALTH_DEGRADE_RATE", 0.6, 0, 1),
    consecutiveFails: envNum("OC_PROVIDER_HEALTH_CONSEC_FAILS", 8, 1, 10_000),
    recoverRate: envNum("OC_PROVIDER_HEALTH_RECOVER_RATE", 0.2, 0, 1),
    latencyAuxConsecutive: envNum("OC_PROVIDER_HEALTH_LATENCY_AUX_CONSEC", 3, 1, 10_000),
    degradeRateAux: envNum("OC_PROVIDER_HEALTH_DEGRADE_RATE_AUX", 0.5, 0, 1),
  };
}

// ─── 判定数学(纯函数)─────────────────────────────────────────────────

/** 判定输入的单条样本(judgement 只关心 ok / kind / 时刻)。 */
export interface HealthSample {
  ok: boolean;
  kind: string;
  /** epoch ms。 */
  at: number;
}

export type HealthStatus = "healthy" | "degraded";

/** scheduler 观测判定结果:是否发生状态转移 + 人读理由 + 观测快照(供日志)。 */
export interface HealthEvaluation {
  transition: "to_degraded" | "to_healthy" | "none";
  /** to_degraded 时给降级理由;to_healthy 时给恢复理由。 */
  reason: string | null;
  snapshot: {
    windowTotal: number;
    windowFailures: number;
    failRate: number;
    consecutiveFailures: number;
    recoverTotal: number;
    recoverFailures: number;
    recoverSuccesses: number;
    latencyAuxApplied: boolean;
  };
}

/**
 * 评估一个 provider 的健康转移(纯函数,单元可测)。
 *
 * @param samples  近 windowMin 内该 provider 的样本(**已排除 aborted**由调用方在 SQL
 *                 里做,或本函数内按 kind 排除),顺序不限(内部按 at 处理)。
 * @param currentStatus 当前 provider_ops.health_status('healthy' | 'degraded' | null(视作 healthy))
 * @param latencyConsecutiveFails latencyProber 近端连续 fail 数(辅助信号,仅加权)
 * @param now epoch ms
 */
export function evaluateProviderHealth(args: {
  samples: readonly HealthSample[];
  currentStatus: HealthStatus | null;
  latencyConsecutiveFails: number;
  now: number;
  thresholds: HealthThresholds;
}): HealthEvaluation {
  const { currentStatus, latencyConsecutiveFails, now, thresholds: t } = args;

  // aborted(客户端主动断开)既非成功也非 provider 失败 → 判定完全排除(防误判红线)。
  const judged = args.samples.filter((s) => s.kind !== "aborted");
  // 近端优先:按 at 降序,便于连续失败从最新往回数。
  const desc = [...judged].sort((a, b) => b.at - a.at);

  const windowTotal = desc.length;
  const windowFailures = desc.reduce((n, s) => n + (s.ok ? 0 : 1), 0);
  const failRate = windowTotal > 0 ? windowFailures / windowTotal : 0;

  let consecutiveFailures = 0;
  for (const s of desc) {
    if (s.ok) break;
    consecutiveFailures++;
  }

  const recoverCutoff = now - t.recoverWindowMin * 60_000;
  const recoverSet = desc.filter((s) => s.at >= recoverCutoff);
  const recoverTotal = recoverSet.length;
  const recoverFailures = recoverSet.reduce((n, s) => n + (s.ok ? 0 : 1), 0);
  const recoverSuccesses = recoverTotal - recoverFailures;
  const recoverRate = recoverTotal > 0 ? recoverFailures / recoverTotal : 0;

  // latency 辅助:仅在 request 样本已达 minSamples 时才生效(绝不单独触发降级);
  // 生效时把失败率阈值从 degradeRate 降到 degradeRateAux(更易判降级)。
  const latencyAuxApplied =
    latencyConsecutiveFails >= t.latencyAuxConsecutive && windowTotal >= t.minSamples;
  const effectiveDegradeRate = latencyAuxApplied ? t.degradeRateAux : t.degradeRate;

  const snapshot = {
    windowTotal,
    windowFailures,
    failRate,
    consecutiveFailures,
    recoverTotal,
    recoverFailures,
    recoverSuccesses,
    latencyAuxApplied,
  };

  const isDegradedNow = currentStatus === "degraded";

  if (!isDegradedNow) {
    // 降级判定:(样本足量 且 失败率达阈值)或 连续失败达阈值。
    const byRate = windowTotal >= t.minSamples && failRate >= effectiveDegradeRate;
    const byConsecutive = consecutiveFailures >= t.consecutiveFails;
    if (byRate || byConsecutive) {
      const pct = Math.round(failRate * 100);
      const reason = byConsecutive
        ? `连续失败 ${consecutiveFailures} 次`
        : `近 ${t.windowMin} 分钟失败率 ${pct}%(${windowFailures}/${windowTotal} 样本)` +
          (latencyAuxApplied ? " + 延迟探测连续失败" : "");
      return { transition: "to_degraded", reason, snapshot };
    }
    return { transition: "none", reason: null, snapshot };
  }

  // 已 degraded:恢复判定 —— 恢复窗口有成功样本 且 失败率低于恢复阈值。
  if (recoverSuccesses > 0 && recoverRate < t.recoverRate) {
    const pct = Math.round(recoverRate * 100);
    const reason = `近 ${t.recoverWindowMin} 分钟失败率 ${pct}%(${recoverSuccesses} 成功样本),已恢复`;
    return { transition: "to_healthy", reason, snapshot };
  }
  return { transition: "none", reason: null, snapshot };
}

// ─── 生效健康派生(动作层/展示层唯一口径)──────────────────────────────
//
// 生效降级 = forced_degraded,或 auto 模式下观测判定为 degraded;forced_healthy 恒健康。
// /api/models 注解、proxy 503 闸、admin badge 全用此派生,不各自解释三态。

export type HealthMode = "auto" | "forced_degraded" | "forced_healthy";

export interface ProviderHealthRow {
  health_status: HealthStatus | null;
  health_mode: HealthMode;
  degraded_since: Date | string | null;
  degrade_reason: string | null;
  /** forced 模式下 since 的兜底展示锚点(admin 设置 mode 的时刻)。 */
  ops_updated_at?: Date | string | null;
}

export interface EffectiveHealth {
  degraded: boolean;
  mode: HealthMode;
  /** 观测判定(与 mode 分离,forced 时供 admin 看「真相 vs 强制」)。 */
  observed: HealthStatus;
  since: string | null;
  reason: string | null;
}

function iso(d: Date | string | null | undefined): string | null {
  if (d == null) return null;
  return typeof d === "string" ? d : d.toISOString();
}

export function effectiveHealth(row: ProviderHealthRow): EffectiveHealth {
  const observed: HealthStatus = row.health_status === "degraded" ? "degraded" : "healthy";
  if (row.health_mode === "forced_degraded") {
    return {
      degraded: true,
      mode: "forced_degraded",
      observed,
      since: iso(row.degraded_since) ?? iso(row.ops_updated_at),
      reason: row.degrade_reason ?? "管理员强制降级",
    };
  }
  if (row.health_mode === "forced_healthy") {
    return { degraded: false, mode: "forced_healthy", observed, since: null, reason: null };
  }
  // auto
  return {
    degraded: observed === "degraded",
    mode: "auto",
    observed,
    since: observed === "degraded" ? iso(row.degraded_since) : null,
    reason: observed === "degraded" ? row.degrade_reason : null,
  };
}
