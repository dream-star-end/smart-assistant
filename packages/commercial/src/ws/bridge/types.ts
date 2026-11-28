import type { Pool } from "pg";
import type { RawData, WebSocket, WebSocketServer } from "ws";
import type {
  ModelAuthorityEngine,
  ModelExecutionDescriptor,
} from "@openclaude/protocol";
import type { TokenUsage } from "../../billing/calculator.js";
import type { CodexFinalizeHandle } from "../../billing/codexFinalizer.js";
import type { ModelPricing, PricingCache } from "../../billing/pricing.js";
import type { BillingAuthorityStamp, JournalFailureCode } from "../../billing/proxyBilling.js";
import type { ClaimedRecoveryJob } from "../../dispatch/turnRecoveryStore.js";
import type { GithubSelectionRow } from "../../github/sessionWorkspaces.js";
import type { Logger } from "../../logging/logger.js";
import type { OutboundBrowserHandoffFrameObserver } from "../../pendingDecisions/pgBrowserHandoffStore.js";
import type { AgentModelResolver } from "../agentModelAuthority.js";
import type { AuthorityKeyCensus } from "../authorityKeyCensus.js";
import type { ConnectionRegistry } from "../connections.js";
import type { ContainerLinkHandle, ContainerLinkRegistry } from "../containerLink.js";
import type { ContainerLinkControls } from "../containerLinkControls.js";
import type { ContainerLinkRecovery } from "../containerLinkRecovery.js";
import type { PromptQueueDispatchRequest } from "../promptQueueDispatchTypes.js";
import type {
  ClientTelemetryContext,
  FirstVisiblePersistGate,
  TurnResponseMilestoneTracker,
} from "../turnPerformance.js";
import type { FallbackWireOutcomeHandler } from "../userChatBridgeLocalFallbackTransport.js";
import type { PendingMigrationInstallRecord } from "../userChatBridgeRemotePoolSeal.js";
import type {
  BridgeCloseCause,
  BridgeMetricSink,
  BridgeModelAuthorityDeps,
  ModelCheckerHandle,
} from "../userChatBridgeTypes.js";
import type { _OutboundPersistQueueCoordinator } from "./outboundPersistQueue.js";
import type {
  CodexApiRelayRoute,
  CodexBindingHandle,
  CodexOfficialOAuthRoute,
  CodexRouteDecision,
  CodexRouteUnavailable,
  CronOriginExecutor,
  CronOriginExecutorClaimResult,
  CronOriginInjectInput,
  CronOriginInjectResult,
  ResolveContainerEndpoint,
  TurnGoalResolution,
  UserChatBridgeDeps,
  UserChatBridgeHandler,
} from "./publicTypes.js";

export type {
  CodexApiRelayRoute,
  CodexBindingHandle,
  CodexOfficialOAuthRoute,
  CodexRouteDecision,
  CodexRouteUnavailable,
  CronOriginExecutor,
  CronOriginExecutorClaimResult,
  CronOriginInjectInput,
  CronOriginInjectResult,
  ResolveContainerEndpoint,
  TurnGoalResolution,
  UserChatBridgeDeps,
  UserChatBridgeHandler,
};

export interface ResolvedTurnExecution {
  canonicalModel: string;
  engine: ModelAuthorityEngine;
  descriptor: ModelExecutionDescriptor;
  pricing: ModelPricing;
  billingRevision: string;
  auxModels: string[];
  executionRevision: string;
  securityEpoch: number;
  placement: "local" | "remote_pool";
}

export interface CodexTurnSnapshot {
  requestId: string;
  model: string;
  accountId: bigint;
  traceId: string;
  codexRouteToken: string | null;
  releaseBridgeTurnState?: (reason: string) => boolean;
  authority: BillingAuthorityStamp | null;
  authorityTurnId: string | null;
  getFinalizer(engineSessionId: string): CodexFinalizeHandle | null;
  abandon(reason: string, failureCode?: JournalFailureCode): Promise<void>;
}

export type InboundTurnIdentity = {
  peerId: string | null;
  clientMessageId: string | null;
  sessionKey?: string;
};

export type AgentModelResolverHandle = {
  resolve: (agentId: string) => string | null;
  isRuntimeDenied: (agentId: string) => boolean;
  isIdentityRegistered: (agentId: string) => boolean;
  authorizeExecution: NonNullable<AgentModelResolver["authorizeExecution"]>;
  refresh: () => Promise<void>;
};

export type ActiveCodexTurnState = {
  readonly stateId: string;
  readonly peerKey: string;
  readonly peerId: string | null;
  readonly clientMessageId: string | null;
  readonly promptQueueGrantId: string | null;
  engine: "codex" | "grok";
  acquireInflight: boolean;
  acquiredAccountId: bigint | null;
  acquiredSlotId: string | null;
  apiRelayRouteToken: string | null;
  billingRequestId: string | null;
  turnForwarded: boolean;
  releaseTimer: ReturnType<typeof setTimeout> | null;
  slotHeartbeat: ReturnType<typeof setInterval> | null;
};

export type PendingGrokLeaseRelease = {
  accountId: bigint;
  slotId: string;
  reason: string;
  inFlight: Promise<void> | null;
  retryRequested: boolean;
};

export interface AdmittedDispatch {
  clientMessageId: string;
  sessionId: string;
  agentId: string;
  dispatchId: string;
  billingRequestId: string;
  attemptNo: number;
  leaseEpoch: number;
  leaseOwnerId: string;
  anchorSeq: bigint | null;
  requestHash: string;
  recoveryJob?: ClaimedRecoveryJob;
  pendingRecoveryAck?: Record<string, unknown>;
  engineSessionKey?: string;
  remoteLane?: boolean;
  admittedAtMs?: number;
  wireSent?: boolean;
  pendingMigrationInstall?: PendingMigrationInstallRecord;
}

export type EnrichmentDispatchPhase = "enriching" | "transferring" | "terminalizing" | "transferred";

export interface EnrichmentDispatchState {
  record: AdmittedDispatch;
  phase: EnrichmentDispatchPhase;
  closedFailureCode: string;
  deadlineAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export type PreForwardFailOpts = {
  abortNeverExecutedJournal?: boolean;
  fromStatuses?: Array<"admitted" | "accepted">;
  onTerminal?: () => void;
};

export type TurnIngress = "browser" | "prompt_queue" | "recovery" | "cron_origin";

export type EarlyMessage = {
  data: RawData;
  isBinary: boolean;
  receivedAtMs: number;
};

export type AttestQueuedMessage = {
  data: RawData;
  isBinary: boolean;
  ingress: TurnIngress;
  dispatchRequest?: PromptQueueDispatchRequest;
  recoveryJob?: ClaimedRecoveryJob;
};

export type PreopenQueuedMessage = {
  data: RawData;
  isBinary: boolean;
  len: number;
  dispatchRecord?: AdmittedDispatch;
  onWireOutcome?: FallbackWireOutcomeHandler;
};

export type PendingRelayMeta = {
  token: string;
  modelId: string;
  sessionId: string | null;
  traceId: string;
};

export type CronOriginClaimWaiter = {
  promise: Promise<CronOriginExecutorClaimResult>;
  resolve: (result: CronOriginExecutorClaimResult) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type PromptQueueCancellationEntry = {
  request: PromptQueueDispatchRequest;
  cancel(reasonCode: string): Promise<void>;
};

export type DurableStampedFrame = {
  storeKey: string;
  sessionId: string | null;
  clientMessageId: string | null;
  sessionKey: string;
  frameSeq: number;
  payload: string;
  isFinal: boolean;
};

export type ParsedCodexBillingFrame = {
  requestId: string;
  engineSid: string | null;
  engineSidRaw: unknown;
  codexStatus: "success" | "error";
  terminalCode: "USER_CANCELLED" | "CODEX_ERROR" | undefined;
  usage: TokenUsage;
  billingRl: unknown;
  turnKey: string | null;
  parentTurnKey: string | null;
  parentSessionId: string | null;
  delegateAgentId: string | null;
};

export type BridgeEndpointInfo = {
  host: string;
  port: number;
  coldStart?: boolean;
  bundleRev?: string;
  desktop?: { containerId: number };
};

export interface OutboundRingHandle {
  peekReplay(
    key: string,
    afterSeq: number,
  ): { ok: true; sent: Array<{ data: string }> } | { ok: false };
  storeStamped(key: string, frameSeq: number, ts: number, payload: string): void;
  pruneAll(nowMs: number): void;
}

export interface BridgeConfig {
  readonly maxPerUser: number;
  readonly maxFrameBytes: number;
  readonly maxBufferedBytes: number;
  readonly connectTimeoutMs: number;
  readonly heartbeatIntervalMs: number;
  readonly activityKeepaliveIntervalMs: number;
  readonly heartbeatTimeoutMs: number;
  readonly promptQueuePreparationTimeoutMs: number;
  readonly dispatchLeaseHeartbeatMs: number;
  readonly admittedRenewMaxAgeMs: number;
}

export type TrackedPreparationTask =
  | {
      lane: "cursorLane";
      recoveryJob?: ClaimedRecoveryJob;
      turnIdentity: InboundTurnIdentity;
      run: (cursorTurnIdentity: InboundTurnIdentity) => Promise<void>;
    }
  | {
      lane: "antigravityLane";
      recoveryJob?: ClaimedRecoveryJob;
      turnIdentity: InboundTurnIdentity;
      run: (antigravityTurnIdentity: InboundTurnIdentity) => Promise<void>;
    }
  | {
      lane: "zcodeLane";
      recoveryJob?: ClaimedRecoveryJob;
      turnIdentity: InboundTurnIdentity;
      run: (zcodeTurnIdentity: InboundTurnIdentity) => Promise<void>;
    }
  | {
      lane: "annotated";
      recoveryJob?: ClaimedRecoveryJob;
      run: () => Promise<AdmittedDispatch | undefined>;
    }
  | {
      lane: "codex";
      recoveryJob?: ClaimedRecoveryJob;
      run: () => Promise<AdmittedDispatch | undefined>;
    }
  | {
      lane: "ccb";
      recoveryJob?: ClaimedRecoveryJob;
      run: () => Promise<AdmittedDispatch | undefined>;
    }
  | {
      lane: "identity";
      recoveryJob?: ClaimedRecoveryJob;
      work: Promise<void>;
      len: number;
      peerKey: string;
    };

export type ForwardInboundFrameFn = (
  data: RawData,
  isBinary: boolean,
  len: number,
  dispatchRecord?: AdmittedDispatch,
  onWireOutcome?: FallbackWireOutcomeHandler,
) => boolean;

export interface ExternalEngineLaneBaseArgs {
  ctx: BridgeConnectionCtx;
  parsedCapture: Record<string, unknown>;
  traceCapture: string;
  logCapture: Logger | null;
  authorityModelCapture: string | null;
  modelCapture: string | null;
  peerCapture: string | null;
  cid: number;
  persistUserRow: boolean;
  recoveryJob: ClaimedRecoveryJob | undefined;
  pretrackedEnrichment: EnrichmentDispatchState | undefined;
  rejectPromptQueueDispatch: (code: string) => void;
  forwardPreparedFrame: (
    frameData: RawData,
    frameIsBinary: boolean,
    frameLength: number,
    dispatchRecord?: AdmittedDispatch,
    onWireOutcome?: FallbackWireOutcomeHandler,
  ) => boolean | Promise<boolean>;
}

export interface CursorExternalBillingArgs {
  ctx: BridgeConnectionCtx;
  requestId: string;
  status: "success" | "error" | "unavailable";
  terminalCode: "USER_CANCELLED" | "AUTH_UNAVAILABLE" | "QUOTA_UNAVAILABLE" | "ENGINE_ERROR" | null;
  durationMs: number;
  usage: Record<string, unknown> | null;
  external: Record<string, unknown>;
}

export interface BridgePlatformAdapters {
  inboundSessionKey(frame: Record<string, unknown>): string;
  observeUserContentReview(args: { text: string; userId: string; sessionKey: string }): void;
  createOutboundRing(): OutboundRingHandle;
  isInMaintenance(): Promise<boolean>;
  readCodexSessionMaxMs(): number;
  readDrainBillingMs(): number;
  readDispatchDrainMs(): number;
  reopenUnprovenAbortedJournal(pgPool: Pool, requestId: string, uidStr: string): Promise<boolean>;
  resolveTeamLeaderModel(
    pricing: PricingCache | undefined,
    checker: ModelCheckerHandle | null,
  ): string;
  handleTurnDispatchReceiptFromBridge(attestPeek: string, ctx: BridgeConnectionCtx): boolean;
  settleCursorExternalBilling(args: CursorExternalBillingArgs): void;
  stripClientCreditBudget(sanitizedParsed: Record<string, unknown>): void;
  runTrackedPreparation(ctx: BridgeConnectionCtx, task: TrackedPreparationTask): void;
  forwardPreparedToContainer(args: {
    frameData: RawData;
    frameIsBinary: boolean;
    frameLength: number;
    dispatchRecord?: AdmittedDispatch;
    onWireOutcome?: FallbackWireOutcomeHandler;
    forwardInboundFrame: ForwardInboundFrameFn;
  }): boolean;
}

export interface StartBridgeParams {
  userWs: WebSocket;
  uid: bigint;
  endpoint: BridgeEndpointInfo;
  earlyMessages: EarlyMessage[];
  containerId: number | undefined;
  containerWs: WebSocket;
  connectAbort: AbortController;
  modelCheckerHandle: ModelCheckerHandle | null;
  agentModelResolverHandle: AgentModelResolverHandle | null;
  connId: string;
  userRole?: "user" | "admin";
  originAuthzReady?: boolean;
  clientTelemetry?: ClientTelemetryContext;
}

export interface BridgeSharedState {
  readonly deps: UserChatBridgeDeps;
  readonly adapters: BridgePlatformAdapters;
  readonly config: BridgeConfig;
  readonly codexBillingEnabled: boolean;
  readonly log: Logger | undefined;
  readonly metrics: BridgeMetricSink;
  readonly browserHandoffObserver: OutboundBrowserHandoffFrameObserver;
  readonly registry: ConnectionRegistry;
  readonly wss: WebSocketServer;
  readonly outboundRing: OutboundRingHandle;
  readonly outboundPersistQueues: _OutboundPersistQueueCoordinator;
  readonly links: ContainerLinkRegistry | null;
  readonly recovery: ContainerLinkRecovery | null;
  readonly controls: ContainerLinkControls | null;
  readonly uidToUserWs: Map<string, Set<WebSocket>>;
  readonly sessionToUserWs: Map<string, Set<WebSocket>>;
  readonly userWsToSessionKeys: Map<WebSocket, Set<string>>;
  readonly uidToContainerWs: Map<string, Set<WebSocket>>;
  readonly uidToRecoveryExecutors: Map<string, Set<(job: ClaimedRecoveryJob, epoch?: number) => void>>;
  readonly uidToCronOriginExecutors: Map<string, Set<CronOriginExecutor>>;
  readonly drainingChecks: Set<() => void>;
  readonly pendingPromptQueueCompensations: Set<Promise<void>>;
  readonly pendingZcodeAuditWork: Set<Promise<void>>;
  readonly recoveryDrainInFlight: Map<string, Promise<void>>;
  readonly recoveryExecutionInFlight: Set<Promise<void>>;
  readonly recoveryJobEpochs: WeakMap<ClaimedRecoveryJob, number>;
  readonly recoveryDrainNeedsRerun: Set<string>;
  readonly recoveryLastScanAt: Map<string, number>;
  readonly recoveryLeaseOwner: string;
  shuttingDown: boolean;
  backgroundActive: boolean;
  backgroundEpoch: number;
  zcodeStaleReconcileStarted: boolean;
  recoveryPollInFlight: boolean;
  lastOnlineReconcileSweepAt: number;
  announcedFrontendBuild: string | null;
  broadcastToUser(uid: bigint, payload: unknown): number;
  syncGoalToContainers(uid: bigint, goal: unknown): number;
  broadcastAll(payload: unknown): number;
  broadcastToUsers(uids: string[], payload: unknown): number;
  onlineUserSubset(uids: string[]): string[];
  registerUserWsSession(ws: WebSocket, userId: string, sessionId: string): void;
  unregisterUserWsSessions(ws: WebSocket): void;
  openUserWsForSession(userId: string, sessionId: string | null): WebSocket[];
  drainDurableRecoveryForUser(uid: bigint): Promise<void>;
  drainDurableControlsForUser(uid: bigint): Promise<void>;
  isBackgroundCurrent(epoch: number): boolean;
  isRecoveryJobCurrent(job?: ClaimedRecoveryJob): boolean;
  trackRecoveryPromise(p: Promise<unknown>): void;
  trackPromptQueueCompensation(work: Promise<void>): void;
  trackZcodeAuditWork(work: Promise<void>): void;
  ensureZcodeStaleReconcile(): void;
  loadBridgeModelChecker(uid: bigint): Promise<ModelCheckerHandle | null>;
  loadBridgeAgentModelResolver(
    uid: bigint,
    bundleRev: string | undefined,
  ): Promise<AgentModelResolverHandle | null>;
  startBridge(params: StartBridgeParams): void;
}

export interface BridgeConnectionCtx {
  readonly shared: BridgeSharedState;
  readonly userWs: WebSocket;
  readonly uid: bigint;
  readonly endpoint: BridgeEndpointInfo;
  readonly containerId: number | undefined;
  readonly containerWs: WebSocket;
  readonly connectAbort: AbortController;
  readonly modelCheckerHandle: ModelCheckerHandle | null;
  readonly agentModelResolverHandle: AgentModelResolverHandle | null;
  readonly connId: string;
  readonly userRole: "user" | "admin";
  readonly originAuthzReady: boolean;
  readonly bridgeLog: Logger | null;
  readonly startedAt: number;
  readonly ttftKind: "cold" | "warm";
  readonly authorityDeps: BridgeModelAuthorityDeps | undefined;
  readonly authorityOn: boolean;
  readonly authorityCensus: AuthorityKeyCensus | null;
  readonly readEpochAtSign: () => Promise<bigint>;
  readonly linkHandle: ContainerLinkHandle | undefined;
  readonly firstVisiblePersist: FirstVisiblePersistGate;
  readonly responseMilestoneTracker: TurnResponseMilestoneTracker;
  readonly skippedRecoveryIds: Set<string>;
  readonly attestQueue: AttestQueuedMessage[];
  readonly preopenQueue: PreopenQueuedMessage[];
  readonly activeCodexTurnsByPeer: Map<string, ActiveCodexTurnState>;
  readonly promptQueueDispatchCancellations: Map<string, PromptQueueCancellationEntry>;
  readonly pendingGrokLeaseReleases: Map<string, PendingGrokLeaseRelease>;
  readonly pendingRebindMap: Map<string, GithubSelectionRow>;
  readonly inflightCodexTurns: Map<string, CodexTurnSnapshot>;
  readonly pendingZcodeRequestIds: Set<string>;
  readonly pendingZcodeRelays: Map<string, PendingRelayMeta>;
  readonly pendingAntigravityRelays: Map<string, PendingRelayMeta>;
  readonly pendingJournalSettles: Set<string>;
  readonly locallySettledCodexTurns: Set<string>;
  readonly retainedOutboundPersistQueueKeys: Set<string>;
  readonly admittedDispatches: Map<string, AdmittedDispatch>;
  readonly pendingMigrationInstalls: Map<string, AdmittedDispatch>;
  readonly enrichmentDispatches: Map<string, EnrichmentDispatchState>;
  readonly enrichmentDeadlineChecks: WeakMap<EnrichmentDispatchState, () => boolean>;
  readonly preparedEnrichmentFrames: WeakMap<Record<string, unknown>, EnrichmentDispatchState>;
  readonly cronOriginClaimWaiters: Map<string, CronOriginClaimWaiter>;
  readonly refusedRecoveryJobs: Map<string, string>;
  readonly identityPreparations: Map<string, Promise<void>>;
  unregister: () => void;
  connectTimer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  modelCheckerRefreshTimer: ReturnType<typeof setInterval> | null;
  activityKeepaliveTimer: ReturnType<typeof setInterval> | null;
  attestTimer: ReturnType<typeof setTimeout> | null;
  drainTimer: ReturnType<typeof setTimeout> | null;
  dispatchHeartbeatTimer: ReturnType<typeof setInterval> | null;
  lastActivityRefreshAt: number;
  bytesUC: number;
  bytesCU: number;
  bufferedUC: number;
  bufferedCU: number;
  cause: BridgeCloseCause;
  requestedCloseCause: BridgeCloseCause | null;
  cleaned: boolean;
  firstUserFrameAtMs: number | null;
  firstContainerFrameAtMs: number | null;
  lastSeenModelId: string | null;
  clientBuildForConnection: string | null;
  lastAliveAt: number;
  turnActiveUntil: number;
  containerChallenge: string | null;
  attestState: "pending" | "ok" | "failed";
  containerHasDurableDispatch: boolean;
  containerHasSystemHelp: boolean;
  containerHasCodexSpeedTiers: boolean;
  speedTierAttestSeen: boolean;
  recoveryExecutor: ((job: ClaimedRecoveryJob, epoch?: number) => void) | null;
  cronOriginExecutor: CronOriginExecutor | null;
  unregisterExecutors: (() => void) | null;
  attestQueuedBytes: number;
  lastHelloPeerIds: Set<string> | null;
  autoRebindFetchDone: boolean;
  autoRebindFlushInFlight: boolean;
  drainCause: BridgeCloseCause | null;
  userDetached: boolean;
  preparationInFlight: number;
  inFlightOutboundPersists: number;
  identityPreparationBytes: number;
  loggedRejectedContainerIncident: boolean;
  checkDrainComplete: () => void;
  cleanup: (triggerCause: BridgeCloseCause, force?: boolean) => void;
  forwardInboundFrame: ForwardInboundFrameFn;
  sendToContainer: (
    data: RawData,
    isBinary: boolean,
    len: number,
    transfer?: EnrichmentDispatchState | null,
    dispatchRecord?: AdmittedDispatch,
    onWireOutcome?: FallbackWireOutcomeHandler,
  ) => boolean;
  executeAdmittedTurn: (
    data: RawData,
    isBinary: boolean,
    ingress?: TurnIngress,
    dispatchRequest?: PromptQueueDispatchRequest,
    recoveryJob?: ClaimedRecoveryJob,
    receivedAtMs?: number,
    pretrackedEnrichment?: EnrichmentDispatchState,
  ) => void;
  onContainerMessage: (data: RawData, isBinary: boolean) => void;
  onContainerAttest: (frame: Record<string, unknown>) => void;
  failAttestation: (reason: string) => void;
}
