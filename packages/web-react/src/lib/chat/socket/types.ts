import type { AuthorizeSwitch } from "../../../hooks/useModelSwitchCost";
import type { AutomaticTurnRecoverySnapshot } from "@openclaude/protocol/browser";
import type { LiveUnit } from "@openclaude/protocol";
import type { StoredPendingControl, StoredPendingDispatch, StoredSession } from "../../persist";
import type {
  DurableLiveFrame,
  DurableLiveFramePage,
  PermissionPromptSnapshotPayload,
  RefreshOutcome,
} from "../../types";
import type { DegradedJournalRetryTracker, PendingControlItem } from "../controlReceipts";
import type {
  InboundMessage,
  MediaJobWire,
  OutboundWire,
  RepoBindErrorWire,
  RepoStatusWire,
} from "../frames";
import type { ChatMessage, ChatSession } from "../model";
import type { ChatStatusClass, EmptyTurnDecision } from "../pure";
import type {
  DeferredTerminalErrorPaint,
  FrameEffects,
  ProblemCardMaterializeCause,
  ProblemCardReport,
} from "../reducer";
import type { SessionSnapshot, SnapshotQuery } from "../sessionSnapshot";
import type { SocketContextCompactManager } from "../socketContextCompact";
import type { SocketMetaTracker } from "../socketMeta";

/** Background journal rebuild bounds. 24 pages × 500 frames = 12k frames;
 * 30s wall clock covers a slow first page without silent infinite paging. */
export const LIVE_JOURNAL_MAX_PAGES = 24;
export const LIVE_JOURNAL_MAX_MS = 30_000;
/** First-screen hydrate pages the current dispatch forward from after=0.
 * Do not seek tail: a raw tail page is not a renderable snapshot. */
export const LIVE_JOURNAL_OPEN_CURSOR = "0";
/** A Phase-A tape can expose only its final-answer fallback while Phase B is
 * still materializing exact records. Poll quickly first, then sparsely; the
 * hard lifetime covers the server's full recoverable materialization backoff. */
export const UNPUBLISHED_TAPE_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16_000, 30_000] as const;
export const UNPUBLISHED_TAPE_RETRY_MAX_MS = 15 * 60_000;
/** Master automatic recovery decision grace before materializing terminal error card. */
export const RECOVERY_DECISION_GRACE_MS = 20_000;
/** Grace waiting for `outbound.ack{recovery}` adoption after `scheduled:true`. */
export const RECOVERY_ADOPTION_GRACE_MS = 30_000;
/** OCV5-424: grace waiting for real final when synthetic tape_commit arrives ahead of live tail. */
export const TAPE_COMMIT_FINAL_GRACE_MS = 5_000;

export const WS_PATH = "/ws/user-chat-bridge";
export const NOTIFY_FALLBACK_MS = 250;
export const STREAM_NOTIFY_MS = 120;
export const STREAM_NOTIFY_COST_FACTOR = 3;
export const STREAM_NOTIFY_MAX_MS = 1000;

export const QUIET_REPLAY_FRAME_KEYS: ReadonlySet<string> = new Set([
  "type", "sessionKey", "channel", "peer", "clientMessageId", "frameSeq", "blocks", "isFinal", "ts",
]);
export const QUIET_REPLAY_BLOCK_KEYS: ReadonlySet<string> = new Set(["kind", "text", "messageId"]);

export type ChatSocketDeps = {
  authorizeSwitch?: AuthorizeSwitch;
  /** 当前内存态 access JWT（WS 子协议鉴权用）。*/
  getToken: () => string;
  /** AuthSession epoch；与 socket 自身生命周期 epoch 双重隔离。 */
  getAuthEpoch: () => number;
  /** 1008 续期统一走 REST/boot 共用的 epoch-bound coordinator。 */
  silentRefresh: (expectedEpoch: number) => Promise<RefreshOutcome>;
  /** 仅明确 invalid 时按 expectedEpoch 幂等失效。*/
  onAuthExpired: (expectedEpoch: number) => void;
  /** 商业版余额刷新（cost_charged / 4506 / insufficient_credits）。*/
  refreshBalance?: () => void;
  /** 自动免单回执已落站内信后，立即刷新未读角标。 */
  refreshInbox?: () => void;
  /** 真 turn 失败自动上报（跳过预期业务态）。*/
  reportClientError?: (p: { type: string; code: string; traceId?: string; sessionId?: string }) => void;
  /** 问题卡闭环上报（surface=chat / stage=problem_card）。历史水合绝不调用。*/
  reportProblemCard?: (p: ProblemCardReport & { sessionId: string }) => void;
  /** resume_failed / 重连 reconcile：强制 REST 全量 sync（最终权威源）。*/
  syncSession?: (
    sessId: string,
    context?: {
      clientMessageId?: string;
      isCurrent?: () => boolean;
      tapeProjectionOnly?: boolean;
      onPermanentError?: () => void;
    },
  ) => Promise<boolean | undefined> | Promise<void> | boolean | void;
  /** Refresh selected and in-flight sessions from PG GoalState REST authority on WS open. */
  syncGoalState?: (sessId: string) => Promise<void> | void;
  /** Idempotent platform-owned client_sessions row creation before first turn / goal set. */
  ensureServerSession?: (
    sessId: string,
    agentId: string,
    title?: string,
    modelId?: string,
  ) => Promise<boolean> | boolean;
  /** Best-effort session model convergence PATCH after row creation. */
  persistSessionModel?: (sessId: string, modelId: string) => Promise<void> | void;
  /** Persist session snapshot to IndexedDB immediately. */
  persistSession?: (sessId: string) => void;
  /** HTTP face of the session snapshot (`live-frames` snapshot). */
  readSessionSnapshot?: (sessId: string, query: SnapshotQuery) => Promise<SessionSnapshot | null | undefined>;
  /** Bounded `view=units` tail pack for degraded snapshot-rebuild fallback (OCV5-837). */
  readLiveUnits?: (sessId: string) => Promise<unknown>;
  /** Exact bytes of one oversized journal frame (snapshot gap `byte_limit`). */
  readLiveFramePayload?: (sessId: string, ref: { recordId: string; sha256?: string }) => Promise<{ payload: unknown }>;
  /** Bounded requestId lookup when a permission snapshot page is truncated. */
  lookupPermissionPrompts?: (sessId: string, requestIds: string[]) => void;
  /** Exact outbound journal commit/delete hooks. */
  persistPendingDispatch?: (sessId: string, item: StoredPendingDispatch) => Promise<void>;
  deletePendingDispatch?: (sessId: string, msgId: string) => Promise<void>;
  /** Exact Stop/permission control journal commit/delete hooks. */
  persistPendingControl?: (item: StoredPendingControl) => Promise<void>;
  deletePendingControl?: (sessId: string, controlId: string) => Promise<void>;
  /** GitHub repo binding status / error callbacks. */
  onRepoStatus?: (frame: RepoStatusWire) => void;
  onRepoBindError?: (frame: RepoBindErrorWire) => void;
  onMediaJob?: (frame: MediaJobWire) => void;
  defaultAgentId?: string;
};

export type DispatchStatus = {
  phase: "connecting" | "sending" | "paused";
  queued: number;
  serviceStarting: boolean;
};

export type OfflineItem = {
  sessId: string;
  payload: InboundMessage;
  msgId: string;
  enqueuedAt: number;
  state: "queued" | "persisting" | "awaiting_admission";
};

export type InterruptedContinuationTarget = {
  user: ChatMessage;
  error: ChatMessage;
  mode: "checkpoint" | "replay";
  clientMessageId: string;
  idempotencyKey: string;
  rootClientMessageId?: string;
  attempt?: number;
  max?: number;
};

export type ChatSnapshot = {
  version: number;
  metaVersion: number;
  status: { label: string; cls: ChatStatusClass };
  provisioning: boolean;
  browserOnline: boolean;
  sessions: Map<string, ChatSession>;
};

export type ServerMessagesArchive = {
  archivedThroughSeq?: number;
  archivedCount?: number;
  completedClientMessageId?: string;
  serverUpdatedAt?: number;
  modelId?: string;
  historyRevision?: number;
  timelineGeneration?: number;
  timelineCursor?: string | null;
  timelineHasMore?: boolean;
  timelineSnapshotMaxSeq?: number;
  invalidateHistoryCache?: boolean;
  openDispatch?: {
    dispatchId: string;
    clientMessageId: string;
    status: string;
    acceptedAt?: number | null;
  };
  permissionPrompts?: PermissionPromptSnapshotPayload;
  automaticRecoveries?: AutomaticTurnRecoverySnapshot[];
};

export type PendingRecoveryErrorEntry = {
  paint: DeferredTerminalErrorPaint;
  clientMessageId?: string;
  timer: ReturnType<typeof setTimeout>;
  decided: boolean;
  masterOwned?: boolean;
};

export type DurableFrameSeqCheckpointEntry = {
  frameSeq: number;
  consumedAuthoritativeResetEpoch: number;
};

export type DurableJournalCheckpoint = {
  cursor: string;
  sawTapeProjection?: boolean;
  tapeProjectionVersion?: number;
  liveClientMessageIds: Set<string>;
  lastDurableFrameSeqBySessionKey: Map<string, DurableFrameSeqCheckpointEntry>;
};

export type UnpublishedTapeRetryState = {
  session: ChatSession;
  lifecycleEpoch: number;
  token: symbol;
  startedAt: number;
  attempt: number;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
};

export type PendingPingState = {
  id: number;
  ws: WebSocket;
  timeoutId: ReturnType<typeof setTimeout>;
  label: string;
};

export type ClearSendingOptions = {
  clearTiming?: boolean;
  resetTracker?: boolean;
  persist?: boolean;
};

export type SnapshotApplyContext = {
  via: "ws" | "http";
  requestedAt: number;
  requestedOrder?: number;
  asked?: string;
};

export interface SocketCtx {
  readonly deps: ChatSocketDeps;
  readonly sessions: Map<string, ChatSession>;
  readonly serverSessionEnsured: Set<string>;
  readonly serverSessionInflight: Map<string, Promise<boolean>>;
  readonly automaticRecoveryPending: Set<string>;
  readonly transientNotices: Map<string, { text: string; ts: number }>;
  readonly firstTextPaintTraceIds: Set<string>;
  readonly lastSyncAt: Map<string, number>;
  readonly tapeCommitFinalTimers: Map<string, ReturnType<typeof setTimeout>>;
  readonly durableHydrationStates: Map<string, { buffered: OutboundWire[] }>;
  readonly durableHydrationTails: Map<string, Promise<void>>;
  readonly authoritativeFrameSeqResetEpochBySessionKey: Map<string, number>;
  readonly durableLiveJournalCheckpoints: Map<string, DurableJournalCheckpoint>;
  readonly unpublishedTapeRetries: Map<string, UnpublishedTapeRetryState>;
  readonly degradedJournalRetries: DegradedJournalRetryTracker;
  readonly subscribedSessions: Set<string>;
  readonly snapshotAckAt: Map<string, number>;
  readonly wsSnapshotAt: Map<string, number>;
  readonly helloAskedCmid: Map<string, string>;
  readonly helloSentAt: Map<string, { at: number; order: number }>;
  readonly snapshotHttpInFlight: Set<string>;
  readonly swarmResyncInFlight: Set<string>;
  readonly dispatchSlots: Map<string, string>;
  readonly pendingRecoveryErrors: Map<string, PendingRecoveryErrorEntry>;
  readonly reportedProblemCards: Set<string>;
  readonly problemCardSourceCodes: Map<string, string>;
  readonly controlPersistRetryTimers: Map<string, ReturnType<typeof setTimeout>>;
  readonly pendingRepoBind: Map<string, { agentId: string; version: number }>;
  readonly contextCompact: SocketContextCompactManager;
  readonly metaTracker: SocketMetaTracker;

  ws: WebSocket | null;
  statusLabel: string;
  statusCls: ChatStatusClass;
  provisioning: boolean;
  gateReady: boolean;
  laneReady: boolean;
  reconnectAttempts: number;
  isBrowserOnline: boolean;
  pendingBrowserOfflineAt: number;
  lastVisibilityReconnectAt: number;
  everOpened: boolean;
  lastOpenAtMs: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectCountdown: ReturnType<typeof setInterval> | null;
  backoffResetTimer: ReturnType<typeof setTimeout> | null;
  wsAuthRefreshInFlight: boolean;
  wsAuthRetryTimer: ReturnType<typeof setTimeout> | null;
  authEpoch: number;
  lifecycleEpoch: number;
  pingNonce: number;
  pendingPing: PendingPingState | null;
  policyReconnectUntilMs: number;
  keepAliveTimer: ReturnType<typeof setInterval> | null;
  activeSessionId: string | undefined;
  reconnectInFlightSet: Set<string> | null;
  reconnectInFlightTimer: ReturnType<typeof setTimeout> | null;
  restoreBannerOwners: Set<string> | null;
  offlineQueue: OfflineItem[];
  dispatchPumpScheduled: boolean;
  relayReady: boolean;
  masterOwnsAutomaticRecovery: boolean;
  controlQueue: PendingControlItem[];
  controlPumpScheduled: boolean;
  relayContainerId: number | undefined;
  relayContainerBoundOrder: number;
  snapshotWatchTimer: ReturnType<typeof setTimeout> | null;

  scheduleNotify: () => void;
  clearNotifyTimers: () => void;
  resetNotifyFlags: () => void;
  setStatus: (label: string, cls: ChatStatusClass) => void;
  setProvisioningBanner: (visible: boolean) => void;
  safeWsSend: (data: string) => boolean;
  connect: () => void;
  dispatch: (f: OutboundWire) => void;
  effects: () => FrameEffects;
  ensureSession: (sessId: string, agentId: string, title?: string) => ChatSession;
  setGoalState: (sessId: string, goal: ChatSession["goalState"]) => void;
  setTransientNotice: (sessId: string, text: string) => void;
  clearTransientNotice: (sessId: string) => void;
  reconcileSession: (sessId: string) => void;
  syncHistory: (sessId: string, context?: { clientMessageId?: string }, retry?: boolean) => void;
  syncSessionAndSettleStop: (sessId: string, context?: { clientMessageId?: string }) => void;
  maybePromoteToConnected: () => void;
  dismissStaleRestoreBanner: () => void;
  clearPendingDispatch: (sessId: string, clientMessageId: string) => boolean;
  beginTurn: (sess: ChatSession, clientMessageId: string, agentId?: string, startedAt?: number) => void;
  confirmDispatchAdmission: (sessId: string, clientMessageId: string, accepted?: boolean) => boolean;
  finishDispatch: (sessId: string, clientMessageId: string | undefined) => void;
  clearLiveJournalDegraded: (sess: ChatSession) => void;
  scheduleDegradedJournalRetry: (sessId: string) => void;
  clearSendingState: (sess: ChatSession, opts?: ClearSendingOptions) => void;
  noteAuthoritativeFrameSeqReset: (sess: ChatSession, frame: { sessionKey?: string }) => void;
  reconcileContainerForSession: (sess: ChatSession) => void;
  sendHelloFrame: (includeInFlight?: boolean, onlySessionId?: string) => boolean;
  subscribeSession: (sessId: string) => void;
  armSnapshotWatchdog: () => void;
  fetchSessionSnapshot: (
    sessId: string,
    opts?: { retry?: boolean; verifyOnly?: boolean },
  ) => Promise<SessionSnapshot | null | undefined>;
  applySessionSnapshot: (sessId: string, snap: SessionSnapshot, snapCtx: SnapshotApplyContext) => Promise<void>;
  runDurableLiveFrameHydration: (sessId: string, hydrate: () => Promise<void>) => Promise<void>;
  applyDurableLiveFrames: (
    sessId: string,
    frames: DurableLiveFrame[],
    resetClientMessageIds?: string[],
    lastDurableFrameSeqBySessionKey?: Map<string, DurableFrameSeqCheckpointEntry>,
  ) => void;
  applyLiveUnits: (
    sessId: string,
    units: LiveUnit[],
    resetClientMessageIds?: string[],
    resume?: { sessionKey: string; frameSeq: number; recordId: string; streamKey?: string },
    streamGeneration?: number,
  ) => void;
  resetOwnerLocalRows: (
    sess: ChatSession,
    resetClientMessageIds: string[],
    incomingProcessOwners: ReadonlySet<string>,
  ) => void;
  resyncSwarmUnits: (sessId: string, expectedClientMessageId?: string) => void;
  clearUnpublishedTapeRetry: (sessId: string) => void;
  reconcileUnpublishedTapeRetry: (sessId: string) => void;
  hydrateDurableLiveFrameJournal: (
    sessId: string,
    fetchPage: (after: string) => Promise<DurableLiveFramePage>,
    applyTapeProjection: () => Promise<void>,
    fetchUnits?: (query?: { before?: string | null }) => Promise<unknown>,
  ) => Promise<void>;
  deferTerminalErrorForRecovery: (
    sessId: string,
    paint: DeferredTerminalErrorPaint,
    masterOwned?: boolean,
  ) => boolean;
  settlePendingRecoveryError: (
    sessId: string,
    sourceClientMessageId: string | undefined,
    outcome: "adopted" | "declined",
    cause?: ProblemCardMaterializeCause,
    reason?: string,
  ) => void;
  discardDeferredTerminalError: (sessId: string, clientMessageId?: string) => void;
  verifyDeferredRecovery: (sessId: string, cause: "decision_timeout" | "adoption_timeout") => void;
  materializePendingRecoveryError: (
    sessId: string,
    cause: ProblemCardMaterializeCause,
    reason?: string,
  ) => void;
  autoRecoverTerminalTurn: (sessId: string, clientMessageId?: string) => Promise<void>;
  autoContinueEmptyTurn: (sessId: string, targetMsgId: string, cls: EmptyTurnDecision) => void;
  clearAutoContinueInFlight: (idem: string) => void;
  ensureServerSessionOnce: (sess: ChatSession, agentId: string) => Promise<boolean>;
  kickDispatchPump: () => void;
  kickQueuedDrainIfIdle: () => void;
  kickControlPump: () => void;
  enqueueControl: (item: PendingControlItem, alreadyPersisted?: boolean) => void;
  settleControl: (controlId: string, status: "applied" | "terminal") => void;
  resetControlsForReplay: () => void;
  resetUnadmittedDispatchesForReplay: () => void;
  stopTurn: (sessId: string, expectedClientMessageId?: string) => void;
  flushAllRepoBinds: () => void;
  maybeClearPendingRepoBind: (sessId: string | undefined, version: number | undefined) => void;
  loadStored: (stored: StoredSession) => void;
}
