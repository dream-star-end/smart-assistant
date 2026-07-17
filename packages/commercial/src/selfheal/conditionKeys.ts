/**
 * v5 自愈体系收尾批(B1)— condition key 单一注册表。
 *
 * 所有 condition 生产者(TS 检测器/写点)与 incident_policies seed、测试,统一从这里
 * 取 key/构造器,消除"每个写点手写字符串"导致的 key 域漂移(此前 providerHealthScheduler
 * 写 `provider_health:<id>` 而 policy seed 是 `health.provider_degraded`,永不命中)。
 *
 * ── bash ⇄ TS 契约(跨语言同源,改一侧必同步另一侧)─────────────────────
 *   scripts/v5-monitor.sh 每轮对 serving-lane + 宿主检查直接 `SELECT write_alert_condition(...)`,
 *   其 condition key 派生规则 = `ops.monitor:<check_name>`(check_name ∈ svc_v5/svc_egress/
 *   svc_candidate_v5/http_v5/http_candidate_v5/http_egress/public_route/disk_root/disk_var/
 *   mem/pool/image/mail[,http_v3])。
 *   本文件的 OPS_MONITOR_PREFIX / opsMonitorKey 是该规则的 TS 侧权威;monitor.sh 文件头
 *   有对应登记。policy seed(0133/0135)的 `ops.monitor:*` prefix 行依赖此规则。
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
