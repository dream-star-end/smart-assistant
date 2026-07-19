// 自愈修复审计页响应形状 —— 对齐 commercial agent 提供的 admin API 契约
// （GET /selfheal/incidents、GET /selfheal/incidents/:id、POST …/resolve）。
// 字段名与后端 serializer 逐一对应；不新造字段。detail 经服务端 redaction（RFC §5 [解 M9]）。

export type Severity = "info" | "warning" | "critical";
export type IncidentStatus = "open" | "repairing" | "resolved";

/**
 * codex 修复状态机（RFC §5：pending → dispatched → acked → running → verifying →
 * succeeded | verification_failed | failed | timeout | cancelled；含 cancel 中间态）。
 * 用字符串联合 + 未知回落，兼容后端后续扩态。
 */
export type RepairStatus =
  | "pending"
  | "dispatched"
  | "acked"
  | "running"
  | "verifying"
  | "succeeded"
  | "verification_failed"
  | "verification_inconclusive"
  | "failed"
  | "timeout"
  | "cancel_requested"
  | "cancelling"
  | "cancelled"
  | "cancel_failed"
  | "orphaned"
  | (string & {});

/** GET /selfheal/incidents 列表行。 */
export interface IncidentRow {
  id: string;
  status: IncidentStatus;
  severity: Severity;
  surface: string;
  user_title: string;
  opened_at: string;
  updated_at: string;
}

export interface IncidentListResp {
  incidents: IncidentRow[];
  /** cursor 分页游标（缺省 = 无更多）。 */
  nextBeforeId?: string;
}

/**
 * GET /selfheal/incidents/:id 的 incident 全字段。列表字段为必有；其余为服务端可能返回的
 * 可回溯字段（已 redaction）。前端只挑已知字段经 KeyValue 展示，**不原样吐任意 JSON**。
 */
export interface IncidentFull extends IncidentRow {
  rev?: number;
  condition_key?: string | null;
  user_message?: string | null;
  audience?: string | null;
  resolved_at?: string | null;
  resolve_mode?: string | null;
  auto_repair?: boolean | null;
  created_at?: string;
}

/**
 * release request 状态机（批1b 契约 §1，v5 PG 权威）：
 *   queued → accepted → deploying → deployed | deploy_failed | deploy_unknown；
 * 另有终态 manual_required（分类器 fail-closed / 权威复核不符）与 cancelled（仅 queued/accepted 可达）。
 * 字符串联合 + 未知回落，兼容后端扩态。
 */
export type ReleaseRequestStatus =
  | "queued"
  | "accepted"
  | "deploying"
  | "deployed"
  | "deploy_failed"
  | "deploy_unknown"
  | "manual_required"
  | "cancelled"
  | (string & {});

/**
 * GET …/:id 的 repair 附带 release request 行（契约 §6.3，字段名逐字对齐 serializer）。
 * baseSha/deployPlanHash/failureReason 可为 null（后端列可空）。
 */
export interface ReleaseRequestRow {
  releaseRequestId: string;
  sourceEventId: string | null;
  status: ReleaseRequestStatus;
  approvedSha: string;
  baseSha: string | null;
  deployPlanHash: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** GET …/:id 关联 repair 行。批1b：附最新放行请求（缺省=无放行请求）。 */
export interface RepairRow {
  id: string;
  status: RepairStatus;
  attempt: number;
  summary: string | null;
  started_at: string | null;
  finished_at: string | null;
  /** 契约 §6.3：每 repair 附 release request 列表（按 createdAt 升序，缺省=无）。 */
  releaseRequests?: ReleaseRequestRow[];
}

/**
 * GET …/:id 的 repair_events 时间线条目（append-only 进度流）。
 * 批1b：detail 承载结构化上下文（经 redactOpsPayload）；pending_release 事件的 detail
 * 形如契约 §11（phase/sha/baseSha/changedFiles/classification/verification/deployPlanHash/manifestHash）。
 */
export interface RepairEventRow {
  id: string;
  repair_id: string;
  kind: string;
  message: string | null;
  created_at: string;
  detail?: Record<string, unknown> | null;
}

export interface IncidentDetailResp {
  incident: IncidentFull;
  repairs: RepairRow[];
  events: RepairEventRow[];
}

/**
 * GET /selfheal/release-fuse —— 全局 Tier2 部署熔断状态（契约 §6.3 / RFC §6「全局熔断」）。
 * engaged=true 时全站放行按钮禁用；清除走 POST /selfheal/release-fuse/clear {reason}。
 * 假设 serializer 输出 camelCase（对齐 SuppressedConditionRow 等既有 admin serializer）。
 */
export interface ReleaseFuseResp {
  engaged: boolean;
  reason?: string | null;
  releaseRequestId?: string | null;
  engagedAt?: string | null;
  engagedBy?: string | null;
}

export interface ReleaseFuseClearResp {
  cleared: boolean;
  outcome: "cleared" | "already_cleared";
  releaseRequestId?: string;
  clearedAt?: string;
  remainingReleaseRequestId?: string;
}

/** POST …/repairs/:id/release 的 202 异步回执（契约 §6.1）。 */
export interface ReleaseRequestAck {
  ok?: boolean;
  releaseRequestId?: string;
  status?: ReleaseRequestStatus;
}

/**
 * POST …/incidents/:id/resolve 的 mode-aware 判定结果(设计 H1b):
 *  - suppressed_until_clear:probe 类 condition 仍 firing → 压制投影直至真实恢复;
 *  - condition_closed:latched/spike 类 → 直接关 condition;
 *  - condition_already_clear:condition 不存在或已 !firing,仅 resolve incident。
 * 字符串联合 + 未知回落,兼容后端扩态。
 */
export type ResolveResolution =
  | "suppressed_until_clear"
  | "condition_closed"
  | "condition_already_clear"
  | (string & {});

export interface ResolveResp {
  resolved?: boolean;
  resolution?: ResolveResolution;
  rev?: number;
}

/** GET /selfheal/conditions?suppressed=1 行(camelCase,对齐后端 serializer 契约)。 */
export interface SuppressedConditionRow {
  conditionKey: string;
  suppressedAt: string | null;
  suppressedBy: string | null;
  level: Severity | null;
}

export interface SuppressedConditionsResp {
  items: SuppressedConditionRow[];
}

export interface UserNoticeProposalRow {
  id: string;
  incidentId: string;
  repairId: string;
  shortCode: string;
  status: string;
  recipientCount: number;
  sentRecipientCount: number | null;
  recipientsHash: string;
  expiresAt: string;
  createdAt: string;
}

export interface UserNoticeApprovalResp {
  binding: {
    channelId: string;
    bindingCode: string;
    active: boolean;
    boundIdentity: string | null;
    boundAt: string | null;
  } | null;
  proposals: UserNoticeProposalRow[];
}

/** repair 是否处于活跃（进行中）态——用于「正在修复」卡与 resolve 禁用判断。 */
export const ACTIVE_REPAIR_STATUSES: ReadonlySet<RepairStatus> = new Set<RepairStatus>([
  "pending",
  "dispatched",
  "acked",
  "running",
  "verifying",
  "cancel_requested",
  "cancelling",
]);
