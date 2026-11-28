import type { Pool, PoolClient } from "pg";
import type {
  AUTOMATIC_TURN_RETRY_MAX,
  AutomaticRetryStatus,
  DurableCodexBilling,
  LosslessTurnTapeFinalizeRequest,
  LosslessTurnTapePartRequest,
  LosslessTurnTapeVisibleRequest,
  SessionWorkspaceMode,
} from "@openclaude/protocol";
import type {
  ClientSessionsBackend,
  MessageLike,
  UsageAggregationGcStats,
} from "@openclaude/storage";
import type { AdmissionRestartRecoveryDeps } from "../../dispatch/admissionRestartRecovery.js";
import type { AdmitDispatchResult } from "../../dispatch/turnDispatchStore.js";
import type { materializeLosslessTurn } from "../../http/losslessTurnTape.js";
import type { TapeDisplayDegradeReason, VisibleHead } from "../visibleFinalize.js";

export interface SettledUsageAttribution {
  usageId: bigint;
  ledgerId: bigint | null;
  attributionCredits: bigint | null;
  /** usage_records.cost_credits as committed (0 for waived / sponsored rows). */
  costCredits: bigint;
}

export interface SessionWriteRow {
  messages: string;
  next_seq: number | null;
  deleted_at: string | null;
  archived_through_seq: number | null;
  archived_count: number | null;
  workspace_mode: string;
}

export type PgAppendCoreResult = {
  applied: boolean;
  reason?: string;
  seq?: number;
  workspaceMode?: SessionWorkspaceMode;
};

export type AutomaticRecoveryDecision = { retryStatus?: AutomaticRetryStatus } & (
  | {
      scheduled: true;
      sourceClientMessageId: string;
      rootClientMessageId: string;
      errorCode: string;
      mode: "checkpoint" | "replay";
      attempt: number;
      max: number;
      displayText: string;
      agentId: string;
      model?: string;
    }
  | {
      scheduled: false;
      sourceClientMessageId: string;
      errorCode: string;
      reason:
        | "not_recoverable"
        | "source_not_latest"
        | "no_routing"
        | "completed_without_checkpoint"
        | "checkpoint_unsafe"
        | "replay_not_proven"
        | "silent_no_progress"
        | "retry_exhausted"
        | "media_not_durable"
        | "enqueue_rejected";
    }
);

export interface PgSessionsBackendOptions {
  /** 启动时快照的权威 generation(RFC D5:probe 复核 marker 未漂移)。 */
  expectedGeneration: number;
  admissionRestartRecovery?: AdmissionRestartRecoveryDeps;
  /** Runs only after the owning tape/cost transaction commits. */
  onGoalUsageChanged?: (userId: string, sessionId: string) => void | Promise<void>;
  /** Runs only after the Phase B finalize tx that evaluated automatic recovery commits. */
  onAutomaticRecoveryDecision?: (
    userId: string,
    sessionId: string,
    decision: AutomaticRecoveryDecision,
  ) => void | Promise<void>;
  /** Runs only after the Phase B finalize tx that settled a recovery job commits. */
  onRecoveryJobTerminal?: (
    userId: string,
    sessionId: string,
    info: {
      rootClientMessageId: string;
      errorCode: string;
      semanticAttempt: number;
      terminalStatus: "completed" | "paused";
      pauseReason: string | null;
    },
  ) => void | Promise<void>;
  /** Runs after a delete tx commits, without waiting. */
  onClientSessionsDeleted?: (userId: string, sessionIds: readonly string[]) => void | Promise<void>;
}

export type GoalUsageChange = { userId: string; sessionId: string };

export type LosslessTurnTapeStageResult =
  | { applied: "stored" | "idempotent" }
  | { applied: "session_not_found" | "session_deleted" };

export type LosslessTurnTapeFinalizeResult =
  | {
      applied: "finalized" | "idempotent";
      recordCount: number;
      engineBillings: DurableCodexBilling[];
      dispatchLateTape?: boolean;
      settlementHandoff?: boolean;
      settlementHeld?: boolean;
      newlyVisible?: boolean;
      clientMessageId?: string;
    }
  | { applied: "session_not_found" | "session_deleted" | "incomplete" };

export interface LosslessTurnTapeStorage {
  commitVisibleLosslessTurnTape?(
    userId: string,
    request: LosslessTurnTapeVisibleRequest,
  ): Promise<LosslessTurnTapeFinalizeResult>;
  stageLosslessTurnTapePart(
    userId: string,
    request: LosslessTurnTapePartRequest,
    payload: Buffer,
    dispatchIdentity?: { dispatchId: string; attemptNo: number },
  ): Promise<LosslessTurnTapeStageResult>;
  finalizeLosslessTurnTape(
    userId: string,
    request: LosslessTurnTapeFinalizeRequest,
    options?: { materialize?: boolean },
  ): Promise<LosslessTurnTapeFinalizeResult>;
}

export interface AdmitUserTurnInput {
  uid: bigint;
  sessionUserId: string;
  sessionId: string;
  clientMessageId: string;
  agentId: string;
  model: string | null;
  requestHash: string;
  billingRequestId: string;
  dispatchId: string;
  ownerId: string;
  exclusiveSession?: boolean;
  message: MessageLike & { id: string };
  recovery?:
    | {
        sourceClientMessageId: string;
        mode: "checkpoint" | "replay";
        automatic: false;
      }
    | {
        sourceClientMessageId: string;
        mode: "checkpoint" | "replay";
        automatic: true;
        rootClientMessageId: string;
        attempt: number;
        max: typeof AUTOMATIC_TURN_RETRY_MAX;
      };
  recoveryJob?: {
    jobId: string;
    leaseOwner: string;
    leaseEpoch: number;
  };
  leaseTtlMs?: number;
  now?: number;
  agentContainerId?: number | null;
  runtimeKind?: string | null;
  traceId?: string | null;
}

export type AdmitUserTurnResult =
  | (AdmitDispatchResult & { workspaceMode: SessionWorkspaceMode })
  | { kind: "session_not_found" }
  | { kind: "session_deleted" }
  | { kind: "session_busy" }
  | { kind: "recovery_conflict"; reason: string }
  | { kind: "append_error"; reason: string };

export class RecoveryJobAdmissionConflict extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "RecoveryJobAdmissionConflict";
  }
}

export type TurnTapeDispatchState = "none" | "partial" | "finalized";

export interface TurnTapeStateResult {
  state: TurnTapeDispatchState;
  status: string | null;
  dispatchLeaseActive: boolean;
  gatewayShutdownEvidence: boolean;
  dispatchStatus?: "admitted" | "accepted" | "rejecting" | "terminal" | "manual_reconcile" | "absent";
  dispatchOutcome?: "completed" | "interrupted" | "crashed" | "executed_error" | "not_accepted" | null;
  producerFenced?: boolean;
}

export interface DispatchAdmissionBackend {
  admitUserTurn(input: AdmitUserTurnInput): Promise<AdmitUserTurnResult>;
  reconcileAutomaticRecoveryJobs(userId: bigint, limit?: number): Promise<number>;
  recoverInterruptedAdmission(dispatchId: string): Promise<boolean>;
  getClientSessionWorkspaceMode(
    sessionId: string,
    sessionUserId: string,
  ): Promise<SessionWorkspaceMode | null>;
  getTurnTapeStateByDispatch(
    userId: string,
    dispatchId: string,
    attemptNo: number,
  ): Promise<TurnTapeStateResult>;
}

export type PgSessionsBackend = ClientSessionsBackend &
  LosslessTurnTapeStorage &
  DispatchAdmissionBackend;

export type HydratedTapeRow = {
  tape_id: string;
  tape_sha256: string;
  waive_reason: string | null;
  waiver_applied: boolean;
  msg_id: string;
  ordinal: number;
  role: string;
  content_sha256: string;
  payload: Buffer;
  cost_credits: string;
  delegate_costs: unknown;
};

export type ExactUsageEnrichment = {
  costCredits: string;
  waiverApplied: boolean;
  delegates: Array<{ agentId: string; costCredits: string }>;
};

export type RecoverySourceUsage = {
  costCredits: string;
  delegates: Array<{ agentId: string; costCredits: string }>;
};

export type TapeFallbackSettlement = {
  usage?: unknown;
  requestId?: string | null;
  costCredits: string;
  waiverApplied: boolean;
  delegates: Array<{ agentId: string; costCredits: string }>;
};

export interface DirectTapeSourceRecord {
  msg_id: string;
  ordinal: number;
  role: string;
  content_sha256: string;
  payload: Buffer;
  visible_payload: Buffer | null;
  visible_content_sha256: string | null;
}

export interface DirectTapeVisibleHead {
  tape_id: string;
  msg_id: string;
  ordinal: number;
  role: string;
  ts: string;
  payload_bytes: string;
  visible_content_sha256: string | null;
  billing_anchor_id: string;
  waiver_applied: boolean;
  cost_credits: string;
  delegate_costs: unknown;
}

export interface DirectTapeHeader {
  tapeId: string;
  tapeSha256: string;
  billingAnchorId: string;
  totalBytes: number;
  physicalCount: number;
  logicalCount: number;
  status: string;
  turnKey: string;
  clientMessageId: string | null;
  continuationOfTurnKey: string | null;
  materializationStatus: string | null;
  finalizedAt: string | null;
  visibleAt: string | null;
  visibleHead: VisibleHead | null;
  usage?: unknown;
  requestId?: string | null;
  costCredits?: string;
  waiverApplied?: boolean;
  delegates?: Array<{ agentId: string; costCredits: string }>;
}

export type DirectTapePageHead = {
  msg_id: string;
  ordinal: number;
  role: string;
  ts: string;
  content_sha256: string;
  payload_bytes: string;
  visible_content_sha256: string | null;
};

export type UserVisiblePhysicalPayload = {
  bytes: Buffer;
  contentSha256: string;
  msgId: string;
  role: string;
  modelRecords: Array<{
    logicalOrdinal: number;
    msgId: string;
    role: string;
    semanticText: string;
    tokenEstimate: number;
    ts: number | null;
    clientMessageId: string | null;
  }>;
};

export type LosslessTurnTapeStorageFormat = 2 | 3;

export type PreparedLosslessTurnTape = {
  turn: ReturnType<typeof materializeLosslessTurn>;
  visible: UserVisiblePhysicalPayload[];
  partManifest: Array<{ partIndex: number; partSha256: string; payloadBytes: number }>;
  recordPayloadBytes: number;
  recordStorageFormat: LosslessTurnTapeStorageFormat;
};

export type LosslessTurnTapeHeaderRow = {
  agent_id: string;
  turn_index: number;
  status: string;
  turn_key: string;
  tape_sha256: string;
  total_bytes: string;
  part_count: number;
  created_at: string;
  waive_reason: string | null;
  finalized_at: string | null;
  record_storage_format: number;
};

export type TurnTapeRecoveryLinkRow = {
  source_tape_id: string;
  recovery_tape_id: string;
  source_tape_sha256: string;
  recovery_tape_sha256: string;
  source_turn_key: string;
  recovery_turn_key: string;
};

export class TurnTapeRecoveryLockUpgrade extends Error {
  constructor(readonly link: TurnTapeRecoveryLinkRow) {
    super("turn tape recovery requires dual turn locks");
    this.name = "TurnTapeRecoveryLockUpgrade";
  }
}

export type PreparedModelSidecar = {
  physicalOrdinal: number;
  logicalOrdinal: number;
  msgId: string;
  role: string;
  semanticText: string;
  tokenEstimate: number;
  ts: number | null;
  clientMessageId: string | null;
};

export type PhysicalFinalizeMemorySnapshot = {
  availableSystemBytes: number;
  heapAvailableBytes: number;
  heapLimitBytes: number;
};

export type LateDelegateRootDecision = "proceed" | "idempotent" | "retry";

export type StagedRecordRow = {
  msg_id: string;
  ordinal: number;
  role: string;
  ts: string;
  content_sha256: string;
  payload: Buffer;
  visible_payload: Buffer | null;
  visible_content_sha256: string | null;
  model_sidecar_complete: boolean;
};

export type FiniteModelContextState = {
  remainingTokens: number;
  stopped: boolean;
  newestFirst: MessageLike[];
};

export type FiniteModelRecord = {
  id: string;
  role: string;
  tokenEstimate: number;
  ts?: number;
  clientMessageId?: string;
  seq?: number;
  orderSeq?: number;
};

export type FiniteTapeModelRow = {
  physical_ordinal: number;
  logical_ordinal: number;
  msg_id: string;
  role: string;
  token_estimate: number;
  ts: string | null;
  client_message_id: string | null;
  semantic_text?: string;
};

export type PredecessorPhysicalHead = {
  ordinal: number;
  msg_id: string;
  role: string;
  content_sha256: string;
  payload_bytes: string;
  model_sidecar_complete: boolean;
};

export type UnifiedTimelineTapeHeader = {
  tapeId: string;
  tapeSha256: string;
  billingAnchorId: string;
  status: string;
  turnKey: string;
  clientMessageId: string | null;
  continuationOfTurnKey: string | null;
  materializationStatus: string | null;
  finalizedAt: string | null;
  visibleHead: VisibleHead | null;
  usage?: unknown;
  requestId?: string | null;
  costCredits?: string;
  waiverApplied?: boolean;
  delegates?: Array<{ agentId: string; costCredits: string }>;
};

export type UnifiedTimelineTapeHead = DirectTapePageHead & {
  tape_id: string;
};

export type UnifiedTimelineSelectedUnit =
  | {
      kind: "outer";
      anchor: MessageLike;
      orderSeq: number;
    }
  | {
      kind: "tape";
      anchor: MessageLike;
      orderSeq: number;
      header: UnifiedTimelineTapeHeader;
      head: UnifiedTimelineTapeHead;
    }
  | {
      kind: "tape-fallback";
      anchor: MessageLike;
      orderSeq: number;
      header: UnifiedTimelineTapeHeader | null;
      reason: TapeDisplayDegradeReason;
    };

export type UnifiedTimelineStatusRow = {
  dispatch_id: string;
  client_message_id: string;
  failure_code: string | null;
  anchor_seq: string;
  terminal_at: Date | null;
};

export type UnifiedTimelineTapeWindow = {
  anchor: MessageLike;
  orderSeq: number;
  header: UnifiedTimelineTapeHeader;
  lowerOrdinal: number;
  upperOrdinal: number;
  missingFinalRecord?: boolean;
};

export interface TapeRecordPayload {
  payload: Buffer;
  totalBytes: number;
  offset: number;
  msgId: string;
  role: string;
  contentSha256: string;
  tapeSha256: string;
}

export interface TapeRecordPayloadChunk {
  chunk: Buffer;
  nextOffset: number | null;
  totalBytes: number;
  start: number;
  endExclusive: number;
  msgId: string;
  role: string;
  contentSha256: string;
  tapeSha256: string;
}

export interface SessionsGcSweeperOptions {
  pool: Pool;
  /** sweep 周期(默认 1h)。 */
  intervalMs?: number;
  /** 竞锁失败/掉线后重试间隔(默认 60s)。 */
  recompeteMs?: number;
  now?: () => number;
  onStats?: (stats: UsageAggregationGcStats) => void;
  onGoalUsageChanged?: (userId: string, sessionId: string) => void | Promise<void>;
  onError?: (err: unknown) => void;
}

export type QueryRunner = Pick<Pool | PoolClient, "query">;
