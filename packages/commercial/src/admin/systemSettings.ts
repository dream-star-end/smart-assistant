/**
 * V3 Phase 4H — `system_settings` 运营运行时设置(超管 only)。
 *
 * 与其它三类设置严格分离:
 *   - user_preferences  → 一人一行,前端 GET/PATCH /api/me/preferences
 *   - model_pricing     → 模型价目,GET/PATCH /api/admin/pricing/*
 *   - **system_settings** → 全局运营开关,GET/PUT /api/admin/settings/:key
 *
 * 安全护栏:
 *   - **Key allowlist**:KEY_SCHEMAS 之外的 key 一律 400(避免攻击者写垃圾 JSONB)。
 *   - **Per-key zod schema**:value 形态严格校验。失败 400。
 *   - **同事务 admin_audit**:每次 PUT 在同一 tx 内写 audit before/after 完整快照。
 *
 * 默认值:
 *   - DEFAULTS 表里给每个 key 一个 sensible 默认。GET 命中空行 → 返默认。
 *   - 应用代码读这些 key 时也走 `getSystemSetting(key)` → 自动 fallback 到默认。
 *
 * 不做的:
 *   - 不做 NOTIFY/listener 自动 reload(MVP:改完 key 后由相关订阅者自己轮询;
 *     例如 idle-sweep 任务每次 tick 重新读)。
 *   - 不做 etag/版本(单 admin 改后立即生效,冲突几率低)。
 */

import type { PoolClient } from "pg";
import { z } from "zod";
import { query, tx } from "../db/queries.js";
import { writeAdminAudit } from "./audit.js";
import { safeEnqueueAlert } from "./alertOutbox.js";
import { EVENTS } from "./alertEvents.js";

// ─── Allowlist + per-key schema ───────────────────────────────────────

/** 全部允许的 key + 对应 zod schema(value 形态 + 范围)。 */
export const KEY_SCHEMAS = {
  /** docker 容器空闲多少分钟后被 idle sweep 回收。整数,1..1440(24h)。 */
  idle_sweep_min: z.number().int().min(1).max(1440),
  /** 是否允许新用户注册。`false` → /api/auth/register 直接 403。 */
  allow_registration: z.boolean(),
  /** 注册新用户时的默认 effort(若用户未在 /api/me/preferences 显式设置)。 */
  default_effort: z.enum(["low", "medium", "high", "xhigh"]),
  /** 单用户每分钟 chat 请求上限。整数,1..1000。 */
  rate_limit_chat_per_min: z.number().int().min(1).max(1000),
  /** 维护模式;true → 非 admin 用户的所有 /api/* 返 503 SERVICE_UNAVAILABLE。 */
  maintenance_mode: z.boolean(),
  // ── T-63 admin 告警(WeChat 推送)总开关 + 规则阈值 ──
  /** 全局告警开关;false → 所有 polled rule tick 直接 return(passive 事件照发)。 */
  alerts_enabled: z.boolean(),
  /** risk.signup_spike 阈值:N 分钟内注册数 ≥ 此数触发。整数,1..10000。 */
  alerts_signup_spike_threshold: z.number().int().min(1).max(10_000),
  /** risk.signup_spike 时间窗口(分钟)。整数,1..240。 */
  alerts_signup_window_min: z.number().int().min(1).max(240),
  /** risk.rate_limit_spike 阈值:N 分钟内 rate_limit_events.blocked 数 ≥ 此数触发。整数,1..100000。 */
  alerts_rate_limit_spike_threshold: z.number().int().min(1).max(100_000),
  /** risk.rate_limit_spike 时间窗口(分钟)。整数,1..240。 */
  alerts_rate_limit_window_min: z.number().int().min(1).max(240),
  /** risk.login_failure_spike 阈值:N 分钟内 login 路由被限流次数 ≥ 此数触发。整数,1..10000。 */
  alerts_login_failure_spike_threshold: z.number().int().min(1).max(10_000),
  /** risk.login_failure_spike 时间窗口(分钟)。整数,1..240。 */
  alerts_login_failure_window_min: z.number().int().min(1).max(240),
} as const;

export type SystemSettingKey = keyof typeof KEY_SCHEMAS;
export type SystemSettingValue<K extends SystemSettingKey = SystemSettingKey> =
  z.infer<(typeof KEY_SCHEMAS)[K]>;

/** 默认值 —— 行不存在时 GET 返这里;应用代码读不到 row 也用这套默认。 */
export const DEFAULTS: { [K in SystemSettingKey]: SystemSettingValue<K> } = {
  idle_sweep_min: 30,
  allow_registration: true,
  default_effort: "medium",
  rate_limit_chat_per_min: 60,
  maintenance_mode: false,
  alerts_enabled: true,
  alerts_signup_spike_threshold: 20,
  alerts_signup_window_min: 10,
  alerts_rate_limit_spike_threshold: 200,
  alerts_rate_limit_window_min: 10,
  alerts_login_failure_spike_threshold: 30,
  alerts_login_failure_window_min: 10,
};

/** 给前端做 schema 自描述(admin UI 渲染表单用)。 */
export const KEY_META: Record<
  SystemSettingKey,
  { kind: "boolean" | "number" | "enum"; enumValues?: string[]; min?: number; max?: number; description: string }
> = {
  idle_sweep_min: { kind: "number", min: 1, max: 1440, description: "Docker 容器空闲多少分钟后被回收" },
  allow_registration: { kind: "boolean", description: "是否允许新用户注册" },
  default_effort: {
    kind: "enum",
    enumValues: ["low", "medium", "high", "xhigh"],
    description: "新用户默认 effort(用户未自定义时)",
  },
  rate_limit_chat_per_min: { kind: "number", min: 1, max: 1000, description: "单用户每分钟 chat 请求上限" },
  maintenance_mode: { kind: "boolean", description: "true=非 admin 全部 503(维护模式)" },
  alerts_enabled: { kind: "boolean", description: "全局告警总开关(passive 事件不受此影响)" },
  alerts_signup_spike_threshold: {
    kind: "number", min: 1, max: 10000,
    description: "risk.signup_spike 阈值:N 分钟内注册数 ≥ 此数触发",
  },
  alerts_signup_window_min: {
    kind: "number", min: 1, max: 240,
    description: "risk.signup_spike 时间窗口(分钟)",
  },
  alerts_rate_limit_spike_threshold: {
    kind: "number", min: 1, max: 100000,
    description: "risk.rate_limit_spike 阈值:N 分钟内 rate_limit_events.blocked 数 ≥ 此数触发",
  },
  alerts_rate_limit_window_min: {
    kind: "number", min: 1, max: 240,
    description: "risk.rate_limit_spike 时间窗口(分钟)",
  },
  alerts_login_failure_spike_threshold: {
    kind: "number", min: 1, max: 10000,
    description: "risk.login_failure_spike 阈值:N 分钟内 login 路由限流次数 ≥ 此数触发",
  },
  alerts_login_failure_window_min: {
    kind: "number", min: 1, max: 240,
    description: "risk.login_failure_spike 时间窗口(分钟)",
  },
};

export const ALLOWED_KEYS: SystemSettingKey[] =
  Object.keys(KEY_SCHEMAS) as SystemSettingKey[];

// ─── Errors ──────────────────────────────────────────────────────────

export class SystemSettingNotFoundError extends Error {
  constructor(key: string) {
    super(`system setting key not in allowlist: ${key}`);
    this.name = "SystemSettingNotFoundError";
  }
}

export class SystemSettingValidationError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(issues.join("; "));
    this.name = "SystemSettingValidationError";
    this.issues = issues;
  }
}

// ─── Public API ──────────────────────────────────────────────────────

export interface SystemSettingRow<K extends SystemSettingKey = SystemSettingKey> {
  key: K;
  value: SystemSettingValue<K>;
  description: string | null;
  updated_at: string; // ISO-8601
  updated_by: string | null; // bigint as string
  /** true ⇔ row 不存在,value 来自 DEFAULTS。 */
  is_default: boolean;
}

/** 列出全部 allowlist key 的当前值(行不存在 → DEFAULTS,is_default=true)。 */
export async function listSystemSettings(): Promise<SystemSettingRow[]> {
  const r = await query<{
    key: string;
    value: unknown;
    description: string | null;
    updated_at: Date;
    updated_by: string | null;
  }>(
    `SELECT key, value, description, updated_at, updated_by::text AS updated_by
       FROM system_settings`,
  );
  const byKey = new Map<string, (typeof r.rows)[number]>();
  for (const row of r.rows) byKey.set(row.key, row);
  const out: SystemSettingRow[] = [];
  for (const k of ALLOWED_KEYS) {
    const row = byKey.get(k);
    if (!row) {
      out.push({
        key: k,
        value: DEFAULTS[k],
        description: null,
        updated_at: new Date(0).toISOString(),
        updated_by: null,
        is_default: true,
      } as SystemSettingRow);
      continue;
    }
    // DB 里可能被外部直接 UPDATE 过 → 跑一次 schema 兜底,失败回退 default
    const parsed = KEY_SCHEMAS[k].safeParse(row.value);
    out.push({
      key: k,
      value: (parsed.success ? parsed.data : DEFAULTS[k]) as SystemSettingValue,
      description: row.description,
      updated_at: row.updated_at.toISOString(),
      updated_by: row.updated_by,
      is_default: false,
    } as SystemSettingRow);
  }
  return out;
}

/**
 * 读单个 key。允许 key 但行不存在 → 返默认 +`is_default=true`。
 * 不允许的 key → 抛 `SystemSettingNotFoundError`。
 *
 * 应用代码也走这条;**不要**直接 SELECT system_settings,
 * 否则会绕开 schema 兜底 + DEFAULTS。
 */
export async function getSystemSetting<K extends SystemSettingKey>(
  key: K,
): Promise<SystemSettingRow<K>> {
  if (!(key in KEY_SCHEMAS)) throw new SystemSettingNotFoundError(key);
  const r = await query<{
    value: unknown;
    description: string | null;
    updated_at: Date;
    updated_by: string | null;
  }>(
    `SELECT value, description, updated_at, updated_by::text AS updated_by
       FROM system_settings WHERE key = $1`,
    [key],
  );
  if (r.rows.length === 0) {
    return {
      key,
      value: DEFAULTS[key],
      description: null,
      updated_at: new Date(0).toISOString(),
      updated_by: null,
      is_default: true,
    } as SystemSettingRow<K>;
  }
  const row = r.rows[0];
  const parsed = KEY_SCHEMAS[key].safeParse(row.value);
  return {
    key,
    value: (parsed.success ? parsed.data : DEFAULTS[key]) as SystemSettingValue<K>,
    description: row.description,
    updated_at: row.updated_at.toISOString(),
    updated_by: row.updated_by,
    is_default: false,
  } as SystemSettingRow<K>;
}

export interface SetSystemSettingCtx {
  adminId: bigint | number | string;
  ip?: string | null;
  userAgent?: string | null;
  /** 可选自由文本,记录改动原因(写入 description 列)。 */
  description?: string | null;
}

/**
 * UPSERT 单个 key。同事务写 admin_audit('system_settings.set')。
 *
 * - key 不在 allowlist → 抛 `SystemSettingNotFoundError`(handler 翻译为 400)
 * - value 不通过 zod → 抛 `SystemSettingValidationError`(handler 翻译为 400)
 * - 没变化(value 与现行值 deep-equal)→ 跳过 UPSERT 与审计,直接返当前 row(幂等)
 */
export async function setSystemSetting<K extends SystemSettingKey>(
  key: K,
  rawValue: unknown,
  ctx: SetSystemSettingCtx,
): Promise<SystemSettingRow<K>> {
  if (!(key in KEY_SCHEMAS)) throw new SystemSettingNotFoundError(key);
  const parsed = KEY_SCHEMAS[key].safeParse(rawValue);
  if (!parsed.success) {
    throw new SystemSettingValidationError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`),
    );
  }
  const value = parsed.data as SystemSettingValue<K>;

  return tx(async (client: PoolClient) => {
    const before = await client.query<{
      value: unknown;
      description: string | null;
      updated_at: Date;
      updated_by: string | null;
    }>(
      `SELECT value, description, updated_at, updated_by::text AS updated_by
         FROM system_settings WHERE key = $1 FOR UPDATE`,
      [key],
    );
    const beforeValue = before.rows.length === 0 ? null : before.rows[0].value;
    const beforeDesc = before.rows.length === 0 ? null : before.rows[0].description;
    const newDesc = ctx.description === undefined ? beforeDesc : ctx.description;

    // 幂等:value 完全一样 + description 也没改 → 不写 DB / 不审计
    const isSameValue = JSON.stringify(beforeValue) === JSON.stringify(value);
    const isSameDesc = (beforeDesc ?? null) === (newDesc ?? null);
    if (before.rows.length > 0 && isSameValue && isSameDesc) {
      const r = before.rows[0];
      return {
        key,
        value,
        description: r.description,
        updated_at: r.updated_at.toISOString(),
        updated_by: r.updated_by,
        is_default: false,
      } as SystemSettingRow<K>;
    }

    const upsert = await client.query<{
      value: unknown;
      description: string | null;
      updated_at: Date;
      updated_by: string | null;
    }>(
      `INSERT INTO system_settings (key, value, description, updated_at, updated_by)
       VALUES ($1, $2::jsonb, $3, NOW(), $4::bigint)
       ON CONFLICT (key) DO UPDATE
         SET value       = EXCLUDED.value,
             description = EXCLUDED.description,
             updated_at  = NOW(),
             updated_by  = EXCLUDED.updated_by
       RETURNING value, description, updated_at, updated_by::text AS updated_by`,
      [key, JSON.stringify(value), newDesc, String(ctx.adminId)],
    );
    const row = upsert.rows[0];

    await writeAdminAudit(client, {
      adminId: ctx.adminId,
      action: "system_settings.set",
      target: `setting:${key}`,
      before: { value: beforeValue, description: beforeDesc },
      after: { value, description: newDesc },
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    });

    // T-63 告警:只在 value 实际变化时发(description 变化不发)。
    // tx 外发送容易漏审,tx 内发送又容易把 alert 捆进业务事务 — safeEnqueueAlert 是
    // fire-and-forget 且内部 try/catch,不会把 tx 拖失败。
    if (!isSameValue) {
      emitSystemSettingChangeAlert(key, beforeValue, value, ctx.adminId);
    }

    return {
      key,
      value,
      description: row.description,
      updated_at: row.updated_at.toISOString(),
      updated_by: row.updated_by,
      is_default: false,
    } as SystemSettingRow<K>;
  });
}

/**
 * 按 key 发对应告警:
 *   - maintenance_mode    → system.maintenance_mode_changed (warning)
 *   - 其余 alerts_* / rate_* / allow_registration 等 → 不发(太吵)
 *
 * model_pricing / topup_plans 的改动走 pricing.ts 自己的 setter,由那里发
 * system.pricing_changed。
 */
function emitSystemSettingChangeAlert(
  key: string,
  beforeValue: unknown,
  afterValue: unknown,
  adminId: bigint | number | string,
): void {
  if (key === "maintenance_mode") {
    const on = afterValue === true;
    safeEnqueueAlert({
      event_type: EVENTS.SYSTEM_MAINTENANCE_MODE_CHANGED,
      severity: "warning",
      title: on ? "维护模式已开启" : "维护模式已关闭",
      body: on
        ? `admin #${adminId} 开启了维护模式,所有非 admin 用户的 /api/* 将返 503。`
        : `admin #${adminId} 关闭了维护模式,服务恢复对外可用。`,
      payload: { key, before: beforeValue, after: afterValue, admin_id: String(adminId) },
      // dedupe 按分钟桶,避免 admin 快速开关刷屏
      dedupe_key: `system.maintenance_mode_changed:${new Date().toISOString().slice(0, 16)}`,
    });
  }
}
