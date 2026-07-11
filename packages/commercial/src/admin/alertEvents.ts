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
  group: "account_pool" | "payment" | "container" | "risk" | "health" | "security" | "system" | "ops";
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

  // ── 安全(3)────────────────────────────────────────────────
  SECURITY_ADMIN_ROLE_CHANGED: "security.admin_role_changed",
  SECURITY_ADMIN_AUDIT_WRITE_FAILED: "security.admin_audit_write_failed",
  SECURITY_EVENT_WRITE_FAILED: "security.security_event_write_failed",

  // ── 健康(1)────────────────────────────────────────────────
  HEALTH_SMOKE_FAILED: "health.smoke_failed",

  // ── 系统(3)────────────────────────────────────────────────
  SYSTEM_MAINTENANCE_MODE_CHANGED: "system.maintenance_mode_changed",
  SYSTEM_PRICING_CHANGED: "system.pricing_changed",
  /** 会话行 oversized 拒写。热尾巴+归档(2026-07-10)后理论不可达,命中即 bug。 */
  SYSTEM_SESSION_OVERSIZED: "system.session_oversized",
  // ── 健康(新增 1)──────────────────────────────────────────
  COMPUTE_HOST_DISK_HIGH: "health.compute_host_disk_high",
  // ── 健康(P3.2 provider 健康度自动探测)────────────────────
  PROVIDER_DEGRADED: "health.provider_degraded",
  PROVIDER_RECOVERED: "health.provider_recovered",

  // ── 运维(4;由 shell 监控 systemd timer 周期写入 outbox,统一送达)──
  // 系统 A(v5-monitor.sh / v5-daily-check.sh / v5-alert-fail@.service)不经
  // TS enqueueAlert,而是 psql 直插 outbox(见 scripts/v5-alert-fanout.sql)。
  // 登记进目录让「事件目录/覆盖率」UI 能展示、能被通道订阅 / 静默匹配。
  OPS_MONITOR_CHECK_FAILED: "ops.monitor_check_failed",
  OPS_MONITOR_RECOVERED: "ops.monitor_recovered",
  OPS_DAILY_ANOMALY: "ops.daily_anomaly",
  OPS_DAILY_REPORT: "ops.daily_report",
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
  { event_type: EVENTS.SECURITY_EVENT_WRITE_FAILED, severity: "critical", group: "security",
    description: "security_events 写入失败(安全事件可能丢失,0129 整改批)", trigger: "passive" },

  // health
  { event_type: EVENTS.HEALTH_SMOKE_FAILED, severity: "critical", group: "health",
    description: "claudeai.chat /healthz 或 / 不可达(每 5 分钟独立 cron 探活,与 openclaude.service 解耦)", trigger: "passive" },

  // system
  { event_type: EVENTS.SYSTEM_MAINTENANCE_MODE_CHANGED, severity: "warning", group: "system",
    description: "维护模式切换", trigger: "passive" },
  { event_type: EVENTS.SYSTEM_PRICING_CHANGED, severity: "warning", group: "system",
    description: "模型定价 / 套餐被修改", trigger: "passive" },
  { event_type: EVENTS.SYSTEM_SESSION_OVERSIZED, severity: "critical", group: "system",
    description: "会话行 oversized 拒写(热尾巴+归档后理论不可达,命中=spill 失效/单条超大消息,回答正在被丢弃)", trigger: "passive" },
  { event_type: EVENTS.COMPUTE_HOST_DISK_HIGH, severity: "warning", group: "health",
    description: "远端 compute_host 磁盘使用率超阈值(默认 warn>=85% / critical>=95%,5min 轮询)", trigger: "polled" },
  { event_type: EVENTS.PROVIDER_DEGRADED, severity: "critical", group: "health",
    description: "上游服务商自动判定为降级(近窗口失败率/连续失败达阈值,60s 轮询;默认影子模式仅标注,OC_PROVIDER_HEALTH_ENFORCE=1 才 503 拦截)", trigger: "polled" },
  { event_type: EVENTS.PROVIDER_RECOVERED, severity: "info", group: "health",
    description: "上游服务商健康恢复(恢复窗口失败率回落且有成功样本)", trigger: "polled" },

  // ops(系统 A shell 监控周期写入;trigger=polled 表示"周期性外部监控",
  // 非 TS scheduler。severity 为目录默认值,monitor 按检查项覆盖传入实际等级)
  { event_type: EVENTS.OPS_MONITOR_CHECK_FAILED, severity: "critical", group: "ops",
    description: "v5 高频探活(每 2min)某检查项失败(标题含检查项名);severity 由 v5-monitor.sh 按项传入(服务/HTTP/池/镜像=critical,磁盘/内存=warning)", trigger: "polled" },
  { event_type: EVENTS.OPS_MONITOR_RECOVERED, severity: "info", group: "ops",
    description: "v5 高频探活某检查项从异常恢复", trigger: "polled" },
  { event_type: EVENTS.OPS_DAILY_ANOMALY, severity: "warning", group: "ops",
    description: "v5 日检异常(计费突增 / 免单率超标 / 取数失败),每日北京时间 09:00", trigger: "polled" },
  { event_type: EVENTS.OPS_DAILY_REPORT, severity: "info", group: "ops",
    description: "v5 每日运行日报(活跃度 / 计费量 / 错误日志),无异常也发", trigger: "polled" },
];

export const ALL_EVENT_TYPES: string[] = EVENT_META.map((e) => e.event_type);

export function eventMetaFor(event_type: string): EventMeta | undefined {
  return EVENT_META.find((e) => e.event_type === event_type);
}
