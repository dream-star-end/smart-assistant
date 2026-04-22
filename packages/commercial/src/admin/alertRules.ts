/**
 * T-63 — 轮询告警规则。
 *
 * scheduler 每 60s 跑一次。每条规则 evaluate 一个 DB snapshot,判断 firing/resolved,
 * 翻转时 enqueue。规则状态用 admin_alert_rule_state 持久化,重启不误喷。
 *
 * 被动事件(支付 / 容器 / 审计 / 安全)不在这里,在各自代码路径里直接 enqueueAlert。
 *
 * 本版实现 5 条:
 *   - account_pool.not_configured   (critical)
 *   - account_pool.all_down         (critical)
 *   - account_pool.low_capacity     (warning)
 *   - risk.signup_spike             (warning)
 *   - risk.rate_limit_spike         (warning)
 *
 * health.5xx_spike / health.ttft_high / risk.login_failure_spike 依赖
 * metrics histogram snapshot API,放二期。
 */

import { query } from "../db/queries.js";
import { EVENTS } from "./alertEvents.js";
import { enqueueAlert, transitionRuleState } from "./alertOutbox.js";
import { getSystemSetting } from "./systemSettings.js";

export interface RuleSnapshot {
  accountHealth: Array<{ account_id: string; health_score: number; status: string }>;
  signupCountLastWindowMin: number;
  signupWindowMin: number;
  rateLimitBlockedLastWindowMin: number;
  rateLimitWindowMin: number;
}

export interface SnapshotDeps {
  /** 测试注入:直接返 snapshot */
  override?: Partial<RuleSnapshot>;
}

/**
 * 收集所有规则所需的 DB snapshot。每条规则只读 snapshot 不再查 DB,
 * 便于测试 + 一次 tick DB 压力可控。
 */
export async function collectRuleSnapshot(deps: SnapshotDeps = {}): Promise<RuleSnapshot> {
  const signupWindowMin = await readSettingNumber("alerts_signup_window_min", 10);
  const rateLimitWindowMin = await readSettingNumber("alerts_rate_limit_window_min", 10);

  let accountHealth: RuleSnapshot["accountHealth"] = [];
  let signupCountLastWindowMin = 0;
  let rateLimitBlockedLastWindowMin = 0;

  try {
    const r = await query<{ id: string; health_score: number; status: string }>(
      "SELECT id::text AS id, health_score, status FROM claude_accounts ORDER BY id",
    );
    accountHealth = r.rows.map((row) => ({
      account_id: row.id,
      health_score: Number(row.health_score ?? 0),
      status: row.status,
    }));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[admin/alertRules] accountHealth snapshot failed:", err);
  }

  try {
    const r = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM users
        WHERE created_at >= NOW() - make_interval(mins => $1)`,
      [signupWindowMin],
    );
    signupCountLastWindowMin = Number(r.rows[0]?.n ?? "0");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[admin/alertRules] signup snapshot failed:", err);
  }

  try {
    const r = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM rate_limit_events
        WHERE blocked = TRUE AND created_at >= NOW() - make_interval(mins => $1)`,
      [rateLimitWindowMin],
    );
    rateLimitBlockedLastWindowMin = Number(r.rows[0]?.n ?? "0");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[admin/alertRules] rate_limit snapshot failed:", err);
  }

  return {
    accountHealth,
    signupCountLastWindowMin,
    signupWindowMin,
    rateLimitBlockedLastWindowMin,
    rateLimitWindowMin,
    ...deps.override,
  };
}

async function readSettingNumber(key: string, fallback: number): Promise<number> {
  try {
    // 动态读以避免 allowlist 变更时测试打挂;下方 systemSettings 会在 T-63 补 allowlist。
    const r = await query<{ value: unknown }>(
      `SELECT value FROM system_settings WHERE key = $1`,
      [key],
    );
    if (r.rows.length === 0) return fallback;
    const v = r.rows[0].value;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

async function readSettingBool(key: string, fallback: boolean): Promise<boolean> {
  try {
    const r = await query<{ value: unknown }>(`SELECT value FROM system_settings WHERE key = $1`, [key]);
    if (r.rows.length === 0) return fallback;
    const v = r.rows[0].value;
    return typeof v === "boolean" ? v : fallback;
  } catch {
    return fallback;
  }
}

// ─── rule 接口 ────────────────────────────────────────────────────────

export interface PolledRule {
  /** 必须与 event_type 1:1(per-rule state row 的 key)。 */
  id: string;
  event_type: string;
  evaluate(snap: RuleSnapshot): PolledRuleOutcome;
}

export type PolledRuleOutcome =
  | {
      firing: true;
      dedupe_key: string;
      severity?: "info" | "warning" | "critical"; // 可覆盖 EVENT_META 默认
      title: string;
      body: string;
      payload: Record<string, unknown>;
    }
  | { firing: false; resolvedTitle?: string; resolvedBody?: string };

// ─── 账号池规则 ───────────────────────────────────────────────────────

export const ruleAccountPoolNotConfigured: PolledRule = {
  id: EVENTS.ACCOUNT_POOL_NOT_CONFIGURED,
  event_type: EVENTS.ACCOUNT_POOL_NOT_CONFIGURED,
  evaluate(s) {
    if (s.accountHealth.length === 0) {
      return {
        firing: true,
        dedupe_key: `${EVENTS.ACCOUNT_POOL_NOT_CONFIGURED}:global`,
        title: "[CRITICAL] 账号池未配置",
        body: "`claude_accounts` 表为空。任何聊天请求都会失败,先在 admin → 账号池 配至少一个账号。",
        payload: { accounts_count: 0 },
      };
    }
    return { firing: false, resolvedTitle: "[RESOLVED] 账号池已配置", resolvedBody: `现有账号数:${s.accountHealth.length}` };
  },
};

export const ruleAccountPoolAllDown: PolledRule = {
  id: EVENTS.ACCOUNT_POOL_ALL_DOWN,
  event_type: EVENTS.ACCOUNT_POOL_ALL_DOWN,
  evaluate(s) {
    if (s.accountHealth.length === 0) return { firing: false }; // 让 not_configured 负责
    const healthy = s.accountHealth.filter((a) => a.status === "active" && a.health_score > 0);
    if (healthy.length === 0) {
      const summary = s.accountHealth
        .slice(0, 10)
        .map((a) => `- #${a.account_id} status=\`${a.status}\` health=${a.health_score}`)
        .join("\n");
      return {
        firing: true,
        dedupe_key: `${EVENTS.ACCOUNT_POOL_ALL_DOWN}:global`,
        title: "[CRITICAL] 账号池全部不可用",
        body: `总账号数 ${s.accountHealth.length},**无任何** active+healthy。\n\n${summary}`,
        payload: { total: s.accountHealth.length, healthy: 0 },
      };
    }
    return {
      firing: false,
      resolvedTitle: "[RESOLVED] 账号池已恢复",
      resolvedBody: `${healthy.length}/${s.accountHealth.length} 账号重新 healthy。`,
    };
  },
};

export const ruleAccountPoolLowCapacity: PolledRule = {
  id: EVENTS.ACCOUNT_POOL_LOW_CAPACITY,
  event_type: EVENTS.ACCOUNT_POOL_LOW_CAPACITY,
  evaluate(s) {
    const total = s.accountHealth.length;
    if (total === 0) return { firing: false };
    const healthy = s.accountHealth.filter((a) => a.status === "active" && a.health_score > 0).length;
    // 阈值:healthy < max(1, ceil(total * 0.3))。低于 30% 或全部账号 <= 2 时触发
    const threshold = Math.max(1, Math.ceil(total * 0.3));
    if (healthy > 0 && healthy < threshold) {
      return {
        firing: true,
        dedupe_key: `${EVENTS.ACCOUNT_POOL_LOW_CAPACITY}:global`,
        title: "[WARN] 账号池容量告急",
        body: `只有 **${healthy}/${total}** 账号 healthy(阈值 ${threshold})。剩余账号可能很快耗尽,建议扩容或排障。`,
        payload: { total, healthy, threshold },
      };
    }
    return {
      firing: false,
      resolvedTitle: "[RESOLVED] 账号池容量恢复",
      resolvedBody: `${healthy}/${total} healthy,已跨过阈值。`,
    };
  },
};

// ─── 风控规则 ─────────────────────────────────────────────────────────

export const ruleSignupSpike: PolledRule = {
  id: EVENTS.RISK_SIGNUP_SPIKE,
  event_type: EVENTS.RISK_SIGNUP_SPIKE,
  evaluate(s) {
    // 阈值由 system_settings.alerts_signup_spike_threshold 控,默认 20
    // scheduler 会把 snapshot 填好后让 rule 做纯数值判断;这里从 snapshot 直接拿
    const threshold = (s as unknown as { _signupThreshold?: number })._signupThreshold ?? 20;
    if (s.signupCountLastWindowMin >= threshold) {
      // 桶化 dedupe_key 避免同一峰值每 tick 都 enqueue:按 10min 桶
      const bucketMs = 10 * 60 * 1000;
      const bucket = Math.floor(Date.now() / bucketMs) * bucketMs;
      return {
        firing: true,
        dedupe_key: `${EVENTS.RISK_SIGNUP_SPIKE}:${bucket}`,
        title: "[WARN] 注册峰值异常",
        body: `过去 ${s.signupWindowMin} 分钟新增 **${s.signupCountLastWindowMin}** 个注册(阈值 ${threshold})。若非营销活动,检查是否被羊毛党。`,
        payload: {
          count: s.signupCountLastWindowMin,
          window_min: s.signupWindowMin,
          threshold,
        },
      };
    }
    return {
      firing: false,
      resolvedTitle: "[RESOLVED] 注册峰值回落",
      resolvedBody: `过去 ${s.signupWindowMin} 分钟注册数 ${s.signupCountLastWindowMin},已低于阈值 ${threshold}。`,
    };
  },
};

export const ruleRateLimitSpike: PolledRule = {
  id: EVENTS.RISK_RATE_LIMIT_SPIKE,
  event_type: EVENTS.RISK_RATE_LIMIT_SPIKE,
  evaluate(s) {
    const threshold = (s as unknown as { _rateLimitThreshold?: number })._rateLimitThreshold ?? 200;
    if (s.rateLimitBlockedLastWindowMin >= threshold) {
      const bucketMs = 10 * 60 * 1000;
      const bucket = Math.floor(Date.now() / bucketMs) * bucketMs;
      return {
        firing: true,
        dedupe_key: `${EVENTS.RISK_RATE_LIMIT_SPIKE}:${bucket}`,
        title: "[WARN] 限流触发激增",
        body: `过去 ${s.rateLimitWindowMin} 分钟 rate_limit_events blocked **${s.rateLimitBlockedLastWindowMin}** 次(阈值 ${threshold})。可能是一个用户在跑爬虫,或配置过严。`,
        payload: {
          count: s.rateLimitBlockedLastWindowMin,
          window_min: s.rateLimitWindowMin,
          threshold,
        },
      };
    }
    return {
      firing: false,
      resolvedTitle: "[RESOLVED] 限流触发回落",
      resolvedBody: `过去 ${s.rateLimitWindowMin} 分钟 blocked ${s.rateLimitBlockedLastWindowMin},低于阈值 ${threshold}。`,
    };
  },
};

export function defaultPolledRules(): PolledRule[] {
  return [
    ruleAccountPoolNotConfigured,
    ruleAccountPoolAllDown,
    ruleAccountPoolLowCapacity,
    ruleSignupSpike,
    ruleRateLimitSpike,
  ];
}

// ─── scheduler tick ─────────────────────────────────────────────────

export interface RunRulesDeps {
  rules?: PolledRule[];
  snapshotDeps?: SnapshotDeps;
  /** 测试可注入 thresholds 绕过 DB 读 */
  thresholds?: { signup?: number; rateLimit?: number };
  /** alerts 总开关 override(默认从 system_settings 读) */
  alertsEnabledOverride?: boolean;
}

export interface RunRulesResult {
  evaluated: string[];
  firings: string[];
  resolutions: string[];
  errors: Array<{ rule_id: string; err: string }>;
}

/**
 * 一次 tick:采 snapshot → 逐条 evaluate → 翻转时 enqueue。
 * 绝不抛;吃掉异常只在结果里回报。
 */
export async function runRulesOnce(deps: RunRulesDeps = {}): Promise<RunRulesResult> {
  const result: RunRulesResult = { evaluated: [], firings: [], resolutions: [], errors: [] };

  // 总开关
  const enabled = deps.alertsEnabledOverride ?? (await readSettingBool("alerts_enabled", true));
  if (!enabled) return result;

  let snap: RuleSnapshot;
  try {
    snap = await collectRuleSnapshot(deps.snapshotDeps ?? {});
  } catch (err) {
    result.errors.push({ rule_id: "__snapshot__", err: (err as Error)?.message ?? String(err) });
    return result;
  }
  // 把阈值贴上 snapshot(规则从这里读,测试可通过 deps.thresholds 覆盖)
  const signupThreshold =
    deps.thresholds?.signup ?? (await readSettingNumber("alerts_signup_spike_threshold", 20));
  const rateLimitThreshold =
    deps.thresholds?.rateLimit ?? (await readSettingNumber("alerts_rate_limit_spike_threshold", 200));
  (snap as unknown as Record<string, number>)._signupThreshold = signupThreshold;
  (snap as unknown as Record<string, number>)._rateLimitThreshold = rateLimitThreshold;

  const rules = deps.rules ?? defaultPolledRules();
  for (const rule of rules) {
    result.evaluated.push(rule.id);
    let outcome: PolledRuleOutcome;
    try {
      outcome = rule.evaluate(snap);
    } catch (err) {
      result.errors.push({ rule_id: rule.id, err: (err as Error)?.message ?? String(err) });
      continue;
    }
    try {
      const firing = outcome.firing;
      const payload = firing ? outcome.payload : {};
      const dedupe_key = firing ? outcome.dedupe_key : null;
      const trans = await transitionRuleState(rule.id, firing, dedupe_key, payload);
      if (!trans.transitioned) continue;

      if (firing) {
        result.firings.push(rule.id);
        await enqueueAlert(
          {
            event_type: rule.event_type,
            severity: outcome.severity ?? inferSeverity(rule.event_type),
            title: outcome.title,
            body: outcome.body,
            payload: outcome.payload,
            dedupe_key: outcome.dedupe_key,
          },
          rule.id,
        );
      } else {
        result.resolutions.push(rule.id);
        const title = outcome.resolvedTitle ?? `[RESOLVED] ${rule.event_type}`;
        const body = outcome.resolvedBody ?? "Condition no longer holds.";
        await enqueueAlert(
          {
            event_type: rule.event_type,
            severity: "info", // resolved 降级到 info
            title,
            body,
            payload: { resolved: true, rule_id: rule.id },
            // resolved 不去重(每次 resolved 发一次就 OK,也不高频)
            dedupe_key: null,
          },
          rule.id,
        );
      }
    } catch (err) {
      result.errors.push({ rule_id: rule.id, err: (err as Error)?.message ?? String(err) });
    }
  }
  return result;
}

function inferSeverity(eventType: string): "info" | "warning" | "critical" {
  // 为了避免循环 import,这里根据 prefix 简单推断;与 alertEvents EVENT_META 保持一致
  if (eventType === EVENTS.ACCOUNT_POOL_ALL_DOWN || eventType === EVENTS.ACCOUNT_POOL_NOT_CONFIGURED) {
    return "critical";
  }
  return "warning";
}
