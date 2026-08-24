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
import { PLATFORM_REASONING_EFFORTS } from "@openclaude/protocol";
import { z } from "zod";
import { query, tx } from "../db/queries.js";
import { writeAdminAudit } from "./audit.js";
import { SENSITIVE_KEY_RE } from "./auditRedact.js";
import { safeEnqueueAlert } from "./alertOutbox.js";
import { EVENTS } from "./alertEvents.js";
import { writeCondition } from "../selfheal/conditions.js";
import { SYSTEM_MAINTENANCE_ON } from "../selfheal/conditionKeys.js";
import { rootLogger } from "../logging/logger.js";
import {
  DEFAULT_AUTO_DREAM_MODEL,
  assertAutoDreamModelSelectable,
} from "../billing/autoDreamModels.js";

// ─── Allowlist + per-key schema ───────────────────────────────────────

/** 全部允许的 key + 对应 zod schema(value 形态 + 范围)。 */
export const KEY_SCHEMAS = {
  /** docker 容器空闲多少分钟后被 idle sweep 回收。整数,1..1440(24h)。 */
  idle_sweep_min: z.number().int().min(1).max(1440),
  /** 是否允许新用户注册。`false` → /api/auth/register 直接 403。 */
  allow_registration: z.boolean(),
  /** 注册新用户时的默认 effort(若用户未在 /api/me/preferences 显式设置)。 */
  default_effort: z.enum(PLATFORM_REASONING_EFFORTS),
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
  /**
   * risk.silent_new_user_cohort 阈值:过去 24h 注册但从未发过请求的人数 ≥ 此数触发。
   * 整数,1..10000。窗口固定 24h(无对应 *_window_min)。
   */
  alerts_silent_new_user_threshold: z.number().int().min(1).max(10_000),
  // ── Onboarding inbox 自动触达(R1..R6;详见 inbox/onboarding.ts)──
  /** 总开关;false → onboarding 调度器 tick 立即返回,不写任何 inbox。 */
  onboarding_enabled: z.boolean(),
  /** dry-run;true → 走完整 SELECT 但事务回滚,不写 inbox(用来观察会触达多少人)。 */
  onboarding_dry_run: z.boolean(),
  // ── 邮箱域名黑名单(反薅羊毛 — 2026-05-22) ──
  /**
   * 注册/邮箱验证拒收的域名列表(精确根域 + 边界 suffix 匹配)。
   *
   * 每项必须是合法 ASCII 域名(全小写,无前后空白,无 wildcard);上限 500 项。
   * 命中规则见 `auth/register.ts:isEmailDomainBlocked`:
   *   - `domain === rule` 或 `domain.endsWith("." + rule)` 视为命中
   *   - 注册路径(POST /api/auth/register)命中 → 400 EMAIL_DOMAIN_BLOCKED
   *   - 邮箱验证路径(POST /api/auth/verify-email)在验证码校验通过后再查一次,
   *     用于挡掉上线**前**已注册未验证的 disposable 邮箱存量(避免他们仍然
   *     完成验证拿赠金)。
   *
   * 不在此规则内 — LDC SSO 合成域 `users.claudeai.chat` 走 socialLogin.ts,
   * 不经过 register/verifyEmail 路径,天然不受此规则约束。
   */
  register_email_domain_blocklist: z
    .array(
      z
        .string()
        .trim()
        .toLowerCase()
        .min(3)
        .max(253)
        .regex(
          /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/,
          "invalid domain",
        ),
    )
    .max(500),
  // ── v3 反关联根治 — 灰度型 feature flag(从 env-only 迁过来,v1.0.207) ──
  /**
   * Phase 6 account_uuid 锚定执行模式(0070 plan §3.0)。
   *
   *   - `off`(默认):applyUpstreamAuth account_uuid 分支早退,builder HMAC 占位透出
   *   - `fail_open`:hook 重写非 null;null 时跳过(HMAC 占位)
   *   - `fail_closed`:scheduler 过滤 account_uuid IS NULL 候选;hook 强制重写
   *
   * pickUpstream 入口读一次冻结到局部常量,scheduler.pick + makeOAuthPoolUpstream
   * 同值消费,避免热改时两处读不一致(plan §5.5.4 + Codex round 2 MINOR 1)。
   */
  phase6_account_uuid_enforce: z.enum(["off", "fail_open", "fail_closed"]),
  /**
   * v3 反关联根治 — chat_session_account_pin 三态调度模式。
   *
   *   - `off`(默认):scheduler 走旧 WRH-only 路径,不查/不写 csap
   *   - `observe`:WRH 主导 pick + 同步读 csap 比对,console.log 出
   *     `evt:'session_pin_observe'` 计数 outcome ∈ {pin_miss, pin_unbound, consistent, divergent}
   *   - `enforce`:csap pin 命中 sticky;unbound 抛 SessionPinUnboundError(409)
   *     让客户端透明 x-force-repin:1 重试;pin miss 走"既往足迹优先"+ race-safe INSERT
   *
   * 灰度路线 off → observe(收集 1~3 天 outcome,divergent / (consistent + divergent)
   * < 0.5% 安全)→ enforce。
   */
  session_pin_mode: z.enum(["off", "observe", "enforce"]),
  /** V5 Auto-Dream background consolidator model; validated against the live catalog on write. */
  auto_dream_model: z.string().min(1).max(64),
} as const;

export type SystemSettingKey = keyof typeof KEY_SCHEMAS;
export type SystemSettingValue<K extends SystemSettingKey = SystemSettingKey> =
  z.infer<(typeof KEY_SCHEMAS)[K]>;

/** 默认值 —— 行不存在时 GET 返这里;应用代码读不到 row 也用这套默认。 */
export const DEFAULTS: { [K in SystemSettingKey]: SystemSettingValue<K> } = {
  idle_sweep_min: 30,
  // 2026-05-25 boss 决策:关闭新用户注册(含 LDC SSO 新建账号路径)。
  // 默认 false → 部署即生效,无需 DB 操作。重开走 admin PUT /api/admin/settings/allow_registration
  // 写 true,system_settings 行存在即覆盖默认。
  allow_registration: false,
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
  alerts_silent_new_user_threshold: 5,
  onboarding_enabled: false,
  onboarding_dry_run: false,
  // 一次性邮箱常见域名 seed(2026-05-22)。policy:concrete domains only,无
  // wildcard / forwarding service(如 33mail / anonaddy 不收录,避免误伤);
  // 后续运营调整走 admin UI,不需要发版。
  register_email_domain_blocklist: [
    "10minutemail.com",
    "10minutemail.net",
    "guerrillamail.com",
    "guerrillamail.net",
    "guerrillamail.org",
    "guerrillamail.de",
    "guerrillamail.biz",
    "sharklasers.com",
    "mailinator.com",
    "temp-mail.org",
    "tempmail.com",
    "yopmail.com",
    "maildrop.cc",
    "trashmail.com",
    "mintemail.com",
    "mohmal.com",
    "emailondeck.com",
    "fakeinbox.com",
    "getairmail.com",
    "spambox.us",
    "dropmail.me",
    "mailcatch.com",
    "nada.email",
    "mailnesia.com",
    "discard.email",
    "fakermail.com",
    "throwawaymail.com",
    "dispostable.com",
    "fakemailgenerator.com",
    "tmpmail.org",
  ],
  // v3 反关联根治 — 默认 off,与原 env-only 字段默认一致(零迁移)
  phase6_account_uuid_enforce: "off",
  // 反封复盘 2026-08 — 默认 enforce:同一 chat session 粘同一订阅号,消除
  // "一个用户在 Anthropic 侧叉到多个 account_uuid"的关联信号(这是切号/多号
  // 规避限额的画像)。enforce 的唯一"硬"行为是绑定账号被封后抛 409
  // SESSION_PIN_UNBOUND —— 已有 force_repin / reset_session 客户端处理路径
  // (见 http/proxy/index.ts),正是反封想要的"不在会话中途静默切号"。
  // 如需回退观察:admin PUT /api/admin/settings/session_pin_mode = "observe"|"off"。
  session_pin_mode: "enforce",
  auto_dream_model: DEFAULT_AUTO_DREAM_MODEL,
};

/**
 * 给前端做 schema 自描述(admin UI 渲染表单用)。
 *
 * kind 取值约束 — 与 `packages/web/public/modules/admin.js` 的渲染分支一一对应:
 *   - `boolean` → `<select>` (true/false)
 *   - `number`  → `<input type=number>`,根据 min/max 提示范围
 *   - `enum`    → `<select>`,选项来自 enumValues
 *   - `string_array` → `<textarea>`,一行一个;save 时按 `\n`/`,` split + trim + lowercase
 */
export const KEY_META: Record<
  SystemSettingKey,
  {
    kind: "boolean" | "number" | "enum" | "string_array" | "model";
    enumValues?: string[];
    min?: number;
    max?: number;
    description: string;
  }
> = {
  idle_sweep_min: { kind: "number", min: 1, max: 1440, description: "Docker 容器空闲多少分钟后被回收" },
  allow_registration: { kind: "boolean", description: "是否允许新用户注册" },
  default_effort: {
    kind: "enum",
    enumValues: [...PLATFORM_REASONING_EFFORTS],
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
  alerts_silent_new_user_threshold: {
    kind: "number", min: 1, max: 10000,
    description: "risk.silent_new_user_cohort 阈值:过去 24h 注册但从未发请求的人数 ≥ 此数触发(窗口固定 24h)",
  },
  onboarding_enabled: { kind: "boolean", description: "用户激活/留存自动 inbox 触达(R1..R6)总开关" },
  onboarding_dry_run: { kind: "boolean", description: "Onboarding dry-run:走完 SELECT 但事务回滚,不写 inbox" },
  register_email_domain_blocklist: {
    kind: "string_array",
    max: 500,
    description:
      "邮箱域名黑名单(一行一个;边界 suffix 匹配 — rule `foo.com` 自动覆盖 `*.foo.com`;LDC 合成域 users.claudeai.chat 不受此约束)",
  },
  phase6_account_uuid_enforce: {
    kind: "enum",
    enumValues: ["off", "fail_open", "fail_closed"],
    description:
      "Phase 6 account_uuid 锚定执行模式。灰度 off → fail_open(hook 重写非 null)→ fail_closed(scheduler 过滤 NULL 候选)",
  },
  session_pin_mode: {
    kind: "enum",
    enumValues: ["off", "observe", "enforce"],
    description:
      "csap chat_session_account_pin 三态调度。灰度 off → observe(只观测打点)→ enforce(锁 sticky;409 让客户端 x-force-repin 重试)",
  },
  auto_dream_model: {
    kind: "model",
    description: "Auto-Dream 整理与全面优化模型（统一使用 active/public 的 MiniMax M3）",
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
  if (key === "auto_dream_model") {
    try {
      await assertAutoDreamModelSelectable(String(value));
    } catch (err) {
      throw new SystemSettingValidationError([
        err instanceof Error ? err.message : "auto-dream model is unavailable",
      ]);
    }
  }

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

    // 整改批脱敏:setting key 本身命中敏感模式(如 *_api_key)→ 整值以元信息入审计
    // (中央钩子只认得对象内的敏感字段名,认不出"这个 setting 的值整个是密钥")。
    // 嵌套在 value 对象里的敏感字段由 writeAdminAudit 的 redactSensitive 兜底。
    const wholeValueSensitive = SENSITIVE_KEY_RE.test(key);
    const auditValue = (v: unknown): unknown =>
      wholeValueSensitive && v !== null && v !== undefined
        ? { __redacted: true, ...(typeof v === "string" ? { len: v.length } : {}) }
        : v;
    await writeAdminAudit(client, {
      adminId: ctx.adminId,
      action: "system_settings.set",
      target: `setting:${key}`,
      before: { value: auditValue(beforeValue), description: beforeDesc },
      after: { value: auditValue(value), description: newDesc },
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
    // selfheal 检测桥(收尾批 B1):维护开关 → condition 单写权威。开维护 firing=true
    // → reconciler 投影全站 banner incident;关维护 firing=false → 自动 resolve
    // (policy resolve_mode='manual' 不冲突:reconciler 只看 firing)。若 admin 在
    // 维护期间 resolve 该 incident,判定表按 mode='probe' 走 suppression:banner 压制、
    // 维护继续,关维护翻转时压制自动清,语义自洽。失败只警告(告警不拖垮设置写主链)。
    void writeCondition(SYSTEM_MAINTENANCE_ON, {
      mode: "probe",
      firing: on,
      level: "warning",
      snapshot: { key, admin_id: String(adminId) },
      // observedAt 缺省 → PG NOW()(单一时钟权威,免 0134 乱序守卫误伤)。
      observedAt: null,
    }).catch((err) => {
      rootLogger.warn("selfheal_maintenance_condition_write_failed", {
        subsys: "systemSettings",
        err: (err as Error)?.message ?? String(err),
      });
    });
  }
}
