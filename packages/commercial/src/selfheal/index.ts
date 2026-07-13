/**
 * v5 自愈体系切片① — 模块 barrel。
 *
 * 分层:
 *   conditions.ts — 检测状态单写权威 adapter(writeCondition → PG write_alert_condition)
 *   policy.ts     — incident_policies 加载 + condition_key → policy 匹配(exact/longest-prefix)
 *   incidents.ts  — incident 生命周期(open/update/resolve,CAS 幂等，仅内部运维账本)
 *   reconciler.ts — level-triggered 投影(condition 当前值 → incidents)
 *   sweeper.ts    — 自愈状态机推进 + legacy 用户 delivery 永久封存
 *   userNoticeApproval.ts — 唯一用户通知出口(真实影响 + 自动修复 + 企微审批 + 在线定向)
 *
 * 集成边界(index.ts 装配):
 *   - reconciler + sweeper scheduler gate = runtimeChannel==='v5'(v5-owned),tick 10s。
 *   - incident 生命周期不注入 bridge，也不做鉴权后补发。
 */

export {
  writeCondition,
  suppressCondition,
  unsuppressCondition,
  coerceConditionLevel,
  type WriteConditionInput,
  type WriteConditionResult,
  type ConditionMode,
  type ConditionLevel,
} from "./conditions.js";

export {
  opsMonitorKey,
  providerDegradedKey,
  sessionOversizedKey,
  OPS_MONITOR_PREFIX,
  PROVIDER_DEGRADED_PREFIX,
  SESSION_OVERSIZED_PREFIX,
  SYSTEM_MAINTENANCE_ON,
} from "./conditionKeys.js";

export {
  assertSelfhealConfig,
  validateDispatchUrl,
  selfhealTickMs,
  repairCooldownMs,
  ackBudgetMs,
  totalBudgetMs,
  verifyBudgetMs,
  MIN_SECRET_LENGTH,
} from "./config.js";

export { redactOpsPayload, scrubSecretsInString } from "./redact.js";

export {
  matchPolicy,
  matchPolicyIn,
  reloadPolicies,
  _resetPolicyCacheForTest,
  type IncidentPolicy,
  type PolicyAudience,
  type PolicyResolveMode,
  type PolicySeverity,
} from "./policy.js";

export {
  openIncident,
  updateIncident,
  resolveIncident,
  maxSeverity,
  type IncidentSeverity,
  type IncidentStatus,
  type ResolveSource,
  type OpenIncidentResult,
  type ResolveIncidentResult,
} from "./incidents.js";

export {
  reconcileOnce,
  startIncidentReconciler,
  type IncidentReconcilerHandle,
  type ReconcileResult,
} from "./reconciler.js";

export {
  sweepOnce,
  startIncidentSweeper,
  isSelfhealDispatchDisabled,
  type SweepResult,
  type SweeperDeps,
  type IncidentSweeperHandle,
} from "./sweeper.js";
