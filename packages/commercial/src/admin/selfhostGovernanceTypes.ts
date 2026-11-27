/**
 * OCV5-914 — Shared types, validators, and error model for the Selfhost Visual
 * Governance Control Plane (L3 admin-ops).
 */
import {
  GOVERNANCE_APPROVAL_ID_RE, type DecideGovernanceApprovalRequest, type GovernanceApprovalClassification,
  type GovernanceApprovalDecision, type GovernanceApprovalKind, type GovernanceApprovalStatus, type GovernanceAuditItem,
  type GovernanceBreakerState, type GovernanceCockpitGauge, type GovernanceCockpitSummary, type GovernanceEffectiveMode,
  type GovernanceMode, type GovernanceModeState, type GovernanceOverviewResponse, type GovernanceResumeStatus,
  type GovernanceSafetyLight, type GovernanceSafetyLightKey, type GovernanceStewardVerdict, type PendingGovernanceApproval, type SafetyLightLevel,
} from "@openclaude/protocol/selfhostGovernance";

export {
  GOVERNANCE_APPROVAL_ID_RE, type DecideGovernanceApprovalRequest, type GovernanceApprovalClassification,
  type GovernanceApprovalDecision, type GovernanceApprovalKind, type GovernanceApprovalStatus, type GovernanceAuditItem,
  type GovernanceBreakerState, type GovernanceCockpitGauge, type GovernanceCockpitSummary, type GovernanceEffectiveMode,
  type GovernanceMode, type GovernanceModeState, type GovernanceOverviewResponse, type GovernanceResumeStatus,
  type GovernanceSafetyLight, type GovernanceSafetyLightKey, type GovernanceStewardVerdict, type PendingGovernanceApproval, type SafetyLightLevel,
};

export type DecideGovernanceApprovalInput = DecideGovernanceApprovalRequest;

export interface ExecFileOptions {
  timeout: number;
  env?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  maxBuffer?: number;
}
export interface ExecFileResult { stdout: string; stderr: string; }
export type ExecFileFn = (file: string, args: readonly string[], options: ExecFileOptions) => Promise<ExecFileResult>;
export type CheckDeployBusyFn = (lockPath: string) => Promise<{ busy: boolean; detail?: string }>;
export type ReadRepoHeadShaFn = (repoRoot: string) => Promise<string | null>;
export interface ProbeUnitStatusResult {
  status: "running" | "completed" | "failed" | "unknown";
  detail?: string;
}
export type ProbeUnitStatusFn = (unitName: string) => Promise<ProbeUnitStatusResult>;

export interface SpawnDetachedDeployInput {
  unitName: string;
  deployScriptPath: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  cwd?: string;
  approvalId?: string;
  targetSha?: string;
  governorBin?: string;
  governorRoot?: string;
}
export interface SpawnDetachedDeployResult { started: boolean; unitName: string; detail?: string; }
export type SpawnDetachedDeployFn = (input: SpawnDetachedDeployInput) => Promise<SpawnDetachedDeployResult>;

export interface SelfhostGovernanceConfig {
  governorRoot: string;
  governorBin: string;
  cockpitDir?: string;
  deployScriptPath?: string;
  repoRoot?: string;
  deployLockPath?: string;
  systemdRunBin?: string;
  systemctlBin?: string;
  commandTimeoutMs?: number;
  commandPath?: string;
  commandEnv?: Readonly<Record<string, string>>;
  githubRepo?: string;
  execFileFn?: ExecFileFn;
  checkDeployBusyFn?: CheckDeployBusyFn;
  readRepoHeadShaFn?: ReadRepoHeadShaFn;
  probeUnitStatusFn?: ProbeUnitStatusFn;
  spawnDetachedDeployFn?: SpawnDetachedDeployFn;
  now?: () => Date;
}

export interface SelfhostGovernanceService {
  getOverview(): Promise<GovernanceOverviewResponse>;
  getApproval(id: string): Promise<PendingGovernanceApproval>;
  setMode(mode: GovernanceMode, reason: string, actor: string): Promise<GovernanceModeState>;
  unlockBreaker(reason: string, actor: string): Promise<GovernanceBreakerState>;
  decideApproval(id: string, input: DecideGovernanceApprovalInput, actor: string): Promise<PendingGovernanceApproval>;
  resumeApproval(id: string, actor: string): Promise<PendingGovernanceApproval>;
}

export type GovernanceErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "CONFLICT_ALREADY_RESOLVED"
  | "RESUME_ALREADY_CLAIMED"
  | "COMMERCIAL_BRANCH_FORBIDDEN"
  | "BREAKER_TRIPPED_USE_UNLOCK"
  | "GOVERNOR_FAILED"
  | "INVALID_APPROVAL_FILE";

export class GovernanceServiceError extends Error {
  readonly status: number;
  readonly code: GovernanceErrorCode;
  readonly approval?: PendingGovernanceApproval;
  constructor(
    status: number,
    code: GovernanceErrorCode,
    message: string,
    options?: { approval?: PendingGovernanceApproval },
  ) {
    super(message);
    this.name = "GovernanceServiceError";
    this.status = status;
    this.code = code;
    this.approval = options?.approval;
  }
}

const VALID_MODES: ReadonlySet<string> = new Set<GovernanceMode>(["autonomous", "debt_first", "emergency_stop"]);

export function isValidGovernanceApprovalId(id: string): boolean { return GOVERNANCE_APPROVAL_ID_RE.test(id); }
export function isValidGovernanceMode(value: string): value is GovernanceMode { return VALID_MODES.has(value); }
export function isCommercialGovernanceBranch(branch: string): boolean {
  const norm = branch.trim().replace(/^(?:refs\/heads\/|origin\/)/, "");
  return norm === "feat/v5-aurora-rewrite" || norm.includes("v5-aurora-rewrite");
}
