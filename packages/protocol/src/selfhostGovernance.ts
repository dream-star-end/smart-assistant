/**
 * OCV5-914 — Shared DTO contracts for the Selfhost Visual Governance Control Plane.
 *
 * Consumed by both `@openclaude/commercial` (backend service/HTTP) and `web-react`
 * (governance admin console & chat IUI card) to keep one authoritative schema with
 * zero cross-package duplication.
 */

export const GOVERNANCE_APPROVAL_ID_RE = /^gov-[a-z0-9_-]{4,80}$/;

export type GovernanceMode = "autonomous" | "debt_first" | "emergency_stop";
export type GovernanceEffectiveMode = GovernanceMode | "unknown";
export type SafetyLightLevel = "green" | "yellow" | "red" | "unknown";
export type GovernanceApprovalKind = "blast_voucher" | "a0_approval" | "breaker_unlock";
export type GovernanceApprovalClassification =
  | "absolute_reject"
  | "human_review_required"
  | "auto_pass";
export type GovernanceApprovalStatus =
  | "pending"
  | "approving"
  | "approved"
  | "rejected"
  | "expired"
  | "reconcile_required";
export type GovernanceSafetyLightKey =
  | "commercialIsolation"
  | "billingFormulaSafety"
  | "dataIntegrity"
  | "rollbackSafety";
export type GovernanceResumeStatus =
  | "not_started"
  | "starting"
  | "started"
  | "running"
  | "not_started_busy"
  | "head_moved"
  | "completed"
  | "failed"
  | "skipped"
  | "not_applicable";

export interface GovernanceSafetyLight {
  key: GovernanceSafetyLightKey;
  label: string;
  level: SafetyLightLevel;
  detail: string;
}

export interface GovernanceStewardVerdict {
  present: boolean;
  verdict: "approve" | "veto" | "missing" | "invalid";
  authorFamily?: string;
  stewardFamily?: string;
  stewardModel?: string;
  hmacVerified?: boolean;
  summary?: string;
  recordedAt?: string;
}

export interface GovernanceApprovalDecision {
  action: "approve" | "reject";
  decidedBy: string;
  decidedAt: string;
  note?: string;
  issuedArtifactId?: string;
  resumeStatus?: GovernanceResumeStatus;
  resumeUnit?: string;
  resumeDetail?: string;
  resumeClaimExpiresAt?: string;
}

export interface PendingGovernanceApproval {
  id: string;
  kind: GovernanceApprovalKind;
  status: GovernanceApprovalStatus;
  code: string;
  scope?: string;
  branch: string;
  sha?: string;
  trainId?: string;
  ticketId?: string;
  title: string;
  plainSummary: string;
  approveEffect: string;
  rejectEffect: string;
  files: string[];
  totalChangedFiles?: number;
  safetyLights: GovernanceSafetyLight[];
  stewardVerdict: GovernanceStewardVerdict;
  createdAt: string;
  expiresAt: string;
  version?: number;
  sha256?: string;
  classification?: GovernanceApprovalClassification;
  allowWholeCommit?: boolean;
  lastError?: string;
  decision?: GovernanceApprovalDecision;
}

export interface DecideGovernanceApprovalRequest {
  decision: "approve" | "reject";
  note?: string;
  autoResumeTrain?: boolean;
  expectedVersion?: number;
  expectedSha256?: string;
  allowWholeCommit?: boolean;
}

export interface GovernanceCockpitGauge {
  id: string;
  title: string;
  light: SafetyLightLevel;
  summary: string;
  metrics: Array<{ label: string; value: string }>;
}

export interface GovernanceAuditItem {
  ts: string;
  action: string;
  label: string;
  actor: string;
  outcome: string;
  detail: string;
}

export interface GovernanceModeState {
  mode: GovernanceMode;
  effectiveMode?: GovernanceEffectiveMode;
  corrupt?: boolean;
  uninitialized?: boolean;
  autoMergeFrozen: boolean;
  reason: string;
  updatedAt: string;
  updatedBy: string;
}

export interface GovernanceBreakerState {
  tripped: boolean;
  reason?: string;
  train?: string;
  triggeredAt?: string;
  cardLines: string[];
  costTripped: boolean;
  costReason?: string;
  recentRollbacks: number;
  readError?: boolean;
  readErrorMessage?: string;
}

export interface GovernanceCockpitSummary {
  available: boolean;
  generatedAt?: string;
  overallLight: SafetyLightLevel;
  gauges: GovernanceCockpitGauge[];
}

export interface GovernanceOverviewResponse {
  enabled: true;
  mode: GovernanceModeState;
  breaker: GovernanceBreakerState;
  pendingApprovals: PendingGovernanceApproval[];
  recentDecisions: PendingGovernanceApproval[];
  cockpit: GovernanceCockpitSummary;
  auditTrail: GovernanceAuditItem[];
}
