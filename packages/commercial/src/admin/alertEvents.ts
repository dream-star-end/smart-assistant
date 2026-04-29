/**
 * T-63 — 事件类型常量 + metadata。
 *
 * 这是唯一的事件类型真理源:前端(event_type 多选)、后端(enqueue 校验)、
 * 审计(分类)都从这里读。
 *
 * 增加新事件类型的流程:
 *   1. 在下方对应分组加一行;
 *   2. 如果是被动事件 → 在触发点调 `enqueueAlert({ event_type: EVENTS.xxx, ... })`;
 *   3. 如果是轮询规则 → 在 alertRules.ts 加一条 PolledRule;
 *   4. 前端 admin.js 的订阅 UI 会自动按分组渲染(它读 /api/admin/alerts/events)。
 */

export type Severity = "info" | "warning" | "critical";

export interface EventMeta {
  event_type: string;
  /** 事件默认严重度(enqueue 时一般用这个,个别场景可覆盖) */
  severity: Severity;
  /** 人类可读分组,前端按此排列 */
  group: "account_pool" | "payment" | "container" | "risk" | "health" | "security" | "system";
  /** 简短描述,UI tooltip */
  description: string;
  /** 触发方式:polled=轮询 scheduler;passive=代码路径被动 enqueue;both=两者都有 */
  trigger: "polled" | "passive" | "both";
}

/**
 * 事件目录 —— 单一真理源。
 *
 * **只列已真正 wire 的事件**。让 UI 能订阅但代码永远不会 enqueue 的"僵尸"事件
 * 是最糟糕的误导,所以只保留实际触发的事件。仍在 backlog 的:
 *   - payment.refund(等退款产品流程)
 *   - container.cleanup_partial(需要 v3 cleanup 路径先写)
 *   - health.5xx_spike / health.ttft_high(需要从 Prometheus histograms 聚合)
 * 都记在 docs/commercial-admin-backlog.md。
 */
export const EVENTS = {
  // ── 账号池(4)──────────────────────────────────────────────
  ACCOUNT_POOL_ALL_DOWN: "account_pool.all_down",
  ACCOUNT_POOL_NOT_CONFIGURED: "account_pool.not_configured",
  ACCOUNT_POOL_LOW_CAPACITY: "account_pool.low_capacity",
  ACCOUNT_POOL_TOKEN_REFRESH_FAILED: "account_pool.token_refresh_failed",

  // ── 支付(5 个已 wire)──────────────────────────────────────
  PAYMENT_FIRST_TOPUP: "payment.first_topup",
  PAYMENT_LARGE_TOPUP: "payment.large_topup",
  PAYMENT_FAILED: "payment.failed",
  PAYMENT_CALLBACK_SIGNATURE_INVALID: "payment.callback_signature_invalid",
  PAYMENT_CALLBACK_CONFLICT: "payment.callback_conflict",
  PAYMENT_CALLBACK_TAMPERED: "payment.callback_tampered",

  // ── 容器(2 个已 wire)──────────────────────────────────────
  CONTAINER_PROVISION_FAILED: "container.provision_failed",
  CONTAINER_OOM_EXITED: "container.oom_exited",

  // ── 风控(4 个已 wire)──────────────────────────────────────
  RISK_SIGNUP_SPIKE: "risk.signup_spike",
  RISK_RATE_LIMIT_SPIKE: "risk.rate_limit_spike",
  RISK_LOGIN_FAILURE_SPIKE: "risk.login_failure_spike",
  RISK_SILENT_NEW_USER_COHORT: "risk.silent_new_user_cohort",

  // ── 安全(2)────────────────────────────────────────────────
  SECURITY_ADMIN_ROLE_CHANGED: "security.admin_role_changed",
  SECURITY_ADMIN_AUDIT_WRITE_FAILED: "security.admin_audit_write_failed",

  // ── 健康(1)────────────────────────────────────────────────
  HEALTH_SMOKE_FAILED: "health.smoke_failed",

  // ── 系统(2)────────────────────────────────────────────────
  SYSTEM_MAINTENANCE_MODE_CHANGED: "system.maintenance_mode_changed",
  SYSTEM_PRICING_CHANGED: "system.pricing_changed",
  // ── 健康(新增 1)──────────────────────────────────────────
  COMPUTE_HOST_DISK_HIGH: "health.compute_host_disk_high",
} as const;

export const EVENT_META: EventMeta[] = [
  // account_pool
  { event_type: EVENTS.ACCOUNT_POOL_ALL_DOWN, severity: "critical", group: "account_pool",
    description: "所有 Claude 账号 health_score=0 或非 active,聊天全量不可用", trigger: "polled" },
  { event_type: EVENTS.ACCOUNT_POOL_NOT_CONFIGURED, severity: "critical", group: "account_pool",
    description: "账号池为空", trigger: "polled" },
  { event_type: EVENTS.ACCOUNT_POOL_LOW_CAPACITY, severity: "warning", group: "account_pool",
    description: "健康账号数低于阈值", trigger: "polled" },
  { event_type: EVENTS.ACCOUNT_POOL_TOKEN_REFRESH_FAILED, severity: "warning", group: "account_pool",
    description: "账号 OAuth refresh 连续失败 / 被自动降级", trigger: "passive" },

  // payment
  { event_type: EVENTS.PAYMENT_FIRST_TOPUP, severity: "info", group: "payment",
    description: "用户完成首次充值", trigger: "passive" },
  { event_type: EVENTS.PAYMENT_LARGE_TOPUP, severity: "info", group: "payment",
    description: "单笔充值达到大额阈值", trigger: "passive" },
  { event_type: EVENTS.PAYMENT_FAILED, severity: "warning", group: "payment",
    description: "虎皮椒回调 status=NF(用户侧支付失败 / 取消)", trigger: "passive" },
  { event_type: EVENTS.PAYMENT_CALLBACK_SIGNATURE_INVALID, severity: "critical", group: "payment",
    description: "虎皮椒回调签名校验失败", trigger: "passive" },
  { event_type: EVENTS.PAYMENT_CALLBACK_CONFLICT, severity: "critical", group: "payment",
    description: "回调状态与订单冲突(重复支付 / 过期订单被标 paid 等)", trigger: "passive" },
  { event_type: EVENTS.PAYMENT_CALLBACK_TAMPERED, severity: "critical", group: "payment",
    description: "回调 payload 字段与订单不匹配(total_fee / appid 被篡改)", trigger: "passive" },

  // container
  { event_type: EVENTS.CONTAINER_PROVISION_FAILED, severity: "critical", group: "container",
    description: "v3 容器开启失败(bridge / supervisor / 镜像问题)", trigger: "passive" },
  { event_type: EVENTS.CONTAINER_OOM_EXITED, severity: "warning", group: "container",
    description: "v3 容器 OOM 被 kernel 杀(exitCode=137 或 OOMKilled)", trigger: "passive" },

  // risk
  { event_type: EVENTS.RISK_SIGNUP_SPIKE, severity: "warning", group: "risk",
    description: "N 分钟内注册数超过阈值", trigger: "polled" },
  { event_type: EVENTS.RISK_RATE_LIMIT_SPIKE, severity: "warning", group: "risk",
    description: "rate_limit_events.blocked 激增", trigger: "polled" },
  { event_type: EVENTS.RISK_LOGIN_FAILURE_SPIKE, severity: "warning", group: "risk",
    description: "登录限流触发数激增(疑似撞库 / 暴力破解)", trigger: "polled" },
  { event_type: EVENTS.RISK_SILENT_NEW_USER_COHORT, severity: "info", group: "risk",
    description: "过去 24h 注册的用户中沉默(无任何 usage_records)的人数超阈值 — 转化漏斗预警", trigger: "polled" },

  // security
  { event_type: EVENTS.SECURITY_ADMIN_ROLE_CHANGED, severity: "critical", group: "security",
    description: "admin 角色被提权或降权", trigger: "passive" },
  { event_type: EVENTS.SECURITY_ADMIN_AUDIT_WRITE_FAILED, severity: "critical", group: "security",
    description: "admin_audit 写入失败(可能审计缺漏)", trigger: "passive" },

  // health
  { event_type: EVENTS.HEALTH_SMOKE_FAILED, severity: "critical", group: "health",
    description: "claudeai.chat /healthz 或 / 不可达(每 5 分钟独立 cron 探活,与 openclaude.service 解耦)", trigger: "passive" },

  // system
  { event_type: EVENTS.SYSTEM_MAINTENANCE_MODE_CHANGED, severity: "warning", group: "system",
    description: "维护模式切换", trigger: "passive" },
  { event_type: EVENTS.SYSTEM_PRICING_CHANGED, severity: "warning", group: "system",
    description: "模型定价 / 套餐被修改", trigger: "passive" },
  { event_type: EVENTS.COMPUTE_HOST_DISK_HIGH, severity: "warning", group: "health",
    description: "远端 compute_host 磁盘使用率超阈值(默认 warn>=85% / critical>=95%,5min 轮询)", trigger: "polled" },
];

export const ALL_EVENT_TYPES: string[] = EVENT_META.map((e) => e.event_type);

export function eventMetaFor(event_type: string): EventMeta | undefined {
  return EVENT_META.find((e) => e.event_type === event_type);
}
