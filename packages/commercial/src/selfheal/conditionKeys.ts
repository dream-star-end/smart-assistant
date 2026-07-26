/**
 * v5 自愈体系收尾批(B1)— condition key 单一注册表。
 *
 * 所有 condition 生产者(TS 检测器/写点)与 incident_policies seed、测试,统一从这里
 * 取 key/构造器,消除"每个写点手写字符串"导致的 key 域漂移(此前 providerHealthScheduler
 * 写 `provider_health:<id>` 而 policy seed 是 `health.provider_degraded`,永不命中)。
 *
 * ── bash ⇄ TS 契约(跨语言同源,改一侧必同步另一侧)─────────────────────
 *   scripts/v5-monitor.sh 每轮对 serving-lane + 宿主检查直接 `SELECT write_alert_condition(...)`,
 *   其 condition key 派生规则 = `ops.monitor:<check_name>`。
 *   本文件的 OPS_MONITOR_PREFIX / opsMonitorKey / OPS_MONITOR_CHECKS 是该规则的 TS 侧权威;
 *   monitor.sh 文件头有对应登记。policy seed(0133/0135)的 `ops.monitor:*` prefix 行依赖此规则。
 *
 *   2026-07-26:此前 check 名单只写在**注释**里,于是它悄悄漂了 4 个
 *   (turn_failures / kp_plugin / client_4xx_storm / deploy_state 在 TS 侧从未登记),
 *   而 http_v3 在 v3 于 2026-07-08 下线后仍留在两侧。注释不是契约 —— 现在名单是
 *   导出常量 OPS_MONITOR_CHECKS,并由
 *   packages/commercial/src/__tests__/opsMonitorConditionContract.test.ts
 *   直接解析 v5-monitor.sh 的 check_severity 分支做集合相等断言,漂一个就红。
 *
 * ── key 域一览(与 incident_policies seed 对齐)───────────────────────────
 *   ops.monitor:<check>                — shell 探测(probe;0133+0135 seed prefix)
 *   health.provider_degraded:<id>      — provider 健康判定(probe;0135 seed 改 prefix)
 *   system.session_oversized:<uid>     — 会话 oversized 拒写(latched,per-user;0135 seed 改 prefix)
 *   system.maintenance_on              — 维护模式开关(probe;exact)
 *   account_pool.all_down / account_pool.low_capacity — 账号池(既有 exact seed,写点在池监控)
 */

/** shell 监控项 key 前缀(v5-monitor.sh 同源契约,见文件头)。 */
export const OPS_MONITOR_PREFIX = "ops.monitor:";

/** `ops.monitor:<check_name>` — v5-monitor.sh 检查项 condition key。 */
export function opsMonitorKey(check: string): string {
  return `${OPS_MONITOR_PREFIX}${check}`;
}

/**
 * v5-monitor.sh 的检查项全集(bash 侧权威 = 该脚本 check_severity 的 case 分支)。
 *
 * 加/删一个检查项 = 改 monitor.sh 的 check_severity + 改这里,两处同步;
 * opsMonitorConditionContract 测试会做集合相等断言,漏改一侧当场红。
 * 这个名单同时告诉自愈侧"哪些 ops.monitor:* key 是合法的",避免 policy seed
 * 写了一个永远不会被点亮的 key(providerHealthScheduler 就踩过同类坑)。
 */
export const OPS_MONITOR_CHECKS: readonly string[] = [
  "backup_fresh",
  // canonical 分支 CI 变红(2026-07-26 关 strict 后的配套告警出口:
  // 语义冲突进 base 后,靠这条探针发现"下一次发布的源是坏的")。
  "ci_base_red",
  "client_4xx_storm",
  "deploy_state",
  "disk_root",
  "disk_var",
  "failed_units",
  // 门禁豁免债务(deploy-v5.sh 的 record_gate_waiver 写 marker,monitor 常驻可见):
  // 已上线版本有未验证面 + 下次普通发布被阻断,不是全站故障但必须有人看见。
  "gate_waivers",
  "http_candidate_v5",
  "http_egress",
  "http_v5",
  "image",
  "kp_plugin",
  "mail",
  "mem",
  "mem_oversubscribe",
  "pool",
  "public_route",
  "svc_candidate_v5",
  "svc_egress",
  "svc_v5",
  "turn_failures",
];

/** provider 降级 key 前缀(0135 seed:`health.provider_degraded:` prefix policy)。 */
export const PROVIDER_DEGRADED_PREFIX = "health.provider_degraded:";

/** `health.provider_degraded:<providerId>` — providerHealthScheduler 判定写点。 */
export function providerDegradedKey(providerId: string): string {
  return `${PROVIDER_DEGRADED_PREFIX}${providerId}`;
}

/** 会话 oversized key 前缀(0135 seed:`system.session_oversized:` prefix policy)。 */
export const SESSION_OVERSIZED_PREFIX = "system.session_oversized:";

/**
 * `system.session_oversized:<uid>` — per-user latched condition(R2 HIGH3:
 * per-user key 使每个受影响用户有独立 incident 生命周期;snapshot.user_id 驱动
 * incidents.materializeRecipients 的定向投递)。
 */
export function sessionOversizedKey(uid: string | number): string {
  return `${SESSION_OVERSIZED_PREFIX}${uid}`;
}

/** 维护模式 condition(exact;systemSettings maintenance_mode 写点)。 */
export const SYSTEM_MAINTENANCE_ON = "system.maintenance_on";

/**
 * 合成 transport 演练 condition(exact;0155 seed;写点=演练脚本
 * scripts/v5-selfheal-drill.ts 经 write_alert_condition)。
 *
 * ── 跨仓契约(改动必须两侧同步)──
 * 个人版 broker 以同一字面量(packages/gateway/src/selfheal/broker.ts
 * SELFHEAL_DRILL_TRANSPORT_KEY)对冻结 conditionKey === 本值的 repair 做
 * context/report 白名单强制(verify/cutover/Tier1 服务端拒绝)。
 * dispatcher 的冷却豁免同样只认本精确常量。未来新增 drill 类型 = 新常量 +
 * 两侧显式扩表,严禁改成前缀匹配。
 */
export const SELFHEAL_DRILL_TRANSPORT = "selfheal.drill:transport_v1";

/**
 * 合成 release 演练 condition(exact;0162 seed;写点=演练脚本
 * scripts/v5-selfheal-drill.ts --release 经 write_alert_condition)。
 *
 * ── 跨仓契约(改动必须两侧同步)──
 * 个人版 broker 以同一字面量对冻结 conditionKey === 本值的 repair 做 release drill
 * 分级白名单强制:放行 context/report/**verify/cutover**(区别于 transport drill 仅
 * context/report);Tier1 host opcode 对一切 drill 拒绝。
 * dispatcher 的冷却豁免同样只认本精确常量。未来新增 drill 类型 = 新常量 + 两侧显式
 * 扩表,严禁改成前缀匹配。
 */
export const SELFHEAL_DRILL_RELEASE = "selfheal.drill:release_v1";
