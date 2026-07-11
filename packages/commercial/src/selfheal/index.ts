/**
 * v5 自愈体系切片① — 模块 barrel。
 *
 * 分层:
 *   conditions.ts — 检测状态单写权威 adapter(writeCondition → PG write_alert_condition)
 *   policy.ts     — incident_policies 加载 + condition_key → policy 匹配(exact/longest-prefix)
 *   incidents.ts  — incident 生命周期(open/update/resolve,CAS 幂等 + 收件人快照 + delivery)
 *   reconciler.ts — level-triggered 投影(condition 当前值 → incidents)
 *   sweeper.ts    — durable 投递(WS broadcast 注入 + 同事务 inbox + activeIncidents 快照)
 *
 * 集成边界(index.ts 装配):
 *   - reconciler + sweeper scheduler gate = runtimeChannel==='v5'(v5-owned),tick 10s。
 *   - sweeper 注入 broadcastAll / broadcastToUsers(bridge handler,forward-ref 装配)。
 *   - sweeper.getActiveIncidents() 供 bridge 鉴权后补发。
 */

export {
  writeCondition,
  coerceConditionLevel,
  type WriteConditionInput,
  type WriteConditionResult,
  type ConditionMode,
  type ConditionLevel,
} from "./conditions.js";

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
  type IncidentPayload,
  type SweepResult,
  type SweeperDeps,
  type BroadcastAllFn,
  type BroadcastToUsersFn,
  type IncidentReconcilerSnapshotHandle,
} from "./sweeper.js";
