/**
 * v5 WS 对话引擎 —— ChatSocket。**渲染树之外的单例 service**（ref-based manager）：
 * 持有 ws + 全部连接/重连/游标/离线队列/计费归因可变状态；React 侧通过 subscribe +
 * 批量 notify（version 单调递增）订阅派生快照。
 *
 * 子职责已模块化拆解至 `./socket/*.ts`（OCV5-928），本文件作为门面保持全部原有导出签名与运行时不变量。
 */
import type { LiveUnit } from "@openclaude/protocol";
import { isClientMessageId } from "@openclaude/protocol/browser";
import { appUpdate } from "../appUpdate";
import {
  mergeTimelineHistoryPage,
  reconcileLateDelegateAgentGroups,
  reconcileTimelineBashTailAuxiliaries,
  type StoredSession,
} from "../persist";
import type {
  DurableLiveFrame,
  DurableLiveFramePage,
  PermissionPromptSnapshotPayload,
} from "../types";
import { applyAutomaticRecoverySnapshot } from "./automaticRecoverySnapshot";
import {
  DegradedJournalRetryTracker,
  type PendingControlItem,
  reconcileOrphanControlPending,
} from "./controlReceipts";
import { confirmDispatchDelivery } from "./deliveryConfirm";
import type { OutboundSessionCompactResultWire, OutboundWire } from "./frames";
import {
  type ChatMessage,
  type ChatSession,
  clearTurnTiming,
  createSession,
  rebuildIndexes,
  resetReplyTracker,
  shouldApplyGoalSnapshot,
} from "./model";
import {
  type ChatStatusClass,
  type EmptyTurnDecision,
  frameSeqKey,
  isSystemCallbackClientMessageId,
  onopenSetInitialStatus,
  SYNC_DEBOUNCE_MS,
} from "./pure";
import {
  applyPermissionSnapshot,
  type DeferredTerminalErrorPaint,
  type FrameEffects,
  type ProblemCardMaterializeCause,
} from "./reducer";
import {
  hasPositiveAgentFrameSeqCursor,
  reconcileSessionRelayContainer,
  SNAPSHOT_ACK_TIMEOUT_MS,
  type SessionSnapshot,
} from "./sessionSnapshot";
import {
  cancelWsAuthRecoveryInSocket,
  notifyNetworkOfflineFlow,
  notifyNetworkOnlineFlow,
  notifyTabVisibleFlow,
  openSocketConnection,
  retryConnectNowFlow,
  safeWsSendOnSocket,
  setGateReadyOnSocket,
  teardownSocketOnStop,
} from "./socket/connectionTransport";
import {
  enqueueControlItem,
  flushAllRepoBindsOnSocket,
  kickControlPumpFlow,
  kickDispatchPumpFlow,
  maybeClearPendingRepoBindOnSocket,
  resetControlsForReplayInSocket,
  resetUnadmittedDispatchesForReplayInSocket,
  respondPermissionFlow,
  sendRepoBindControl,
  sendRepoUnbindControl,
  settleControlItem,
  stopTurnFlow,
} from "./socket/controlAndOfflineQueue";
import {
  hydrateDurableLiveFrameJournalFlow,
  runDurableLiveFrameHydrationSerial,
} from "./socket/journalHydration";
import {
  applyDurableLiveFramesToSession,
  applyLiveUnitsToSession,
  clearUnpublishedTapeRetryForSession,
  prependLiveUnitsToSession,
  reconcileUnpublishedTapeRetryForSession,
  resetOwnerLocalRowsInSession,
  resyncSwarmUnitsForSession,
} from "./socket/liveUnitsHydration";
import {
  createSocketFrameEffects,
  dispatchOutboundFrame,
} from "./socket/outboundFramePump";
import {
  dispatchInboundPayload,
  editQueuedMessageInSession,
  ensureGenPlaceholderRow,
  ensureServerSessionOnceFlow,
  retryUserMessageFlow,
  type SendMessageParams,
  sendQueuedMessageNow,
  sendUserMessageFlow,
} from "./socket/outboundSendAndRetry";
import {
  discardDeferredTerminalErrorInSocket,
  materializePendingRecoveryErrorInSocket,
  settlePendingRecoveryErrorInSocket,
  stashProblemCardSourceCodeInSocket,
  verifyDeferredRecoveryTimeout,
} from "./socket/problemCardAndDeferredError";
import {
  automaticTurnRecoveryTarget,
  exactUserReplayPayload,
  interruptedContinuationIdentity,
  interruptedContinuationTarget,
  messageAttemptIdempotencyKey,
  nextStreamRenderCostMs,
  preciseRetryEligible,
  streamNotifyWindowMs,
} from "./socket/pureHelpers";
import {
  adoptPendingAutomaticRecoveryFromHistory,
  autoContinueEmptyTurnFlow,
  autoRecoverTerminalTurnFlow,
  clearAutoContinueInFlightByIdem,
  continueInterruptedTurnFlow,
  dispatchTurnRecoveryMessage,
} from "./socket/recoveryController";
import {
  computeArchiveBeforeSeq,
  finalizeServerMessagesTail,
  mergeServerHistoryPreliminary,
  prependArchivedMessagesToSession,
  resolveTimelineAuxiliaryInSession,
} from "./socket/serverHistoryMerge";
import {
  buildStoredSessionPostDecisionFields,
  buildStoredSessionPreDecisionFields,
  loadStoredSessionIntoSocket,
  prepareMessagesForStoredSession,
  removeSessionState,
  resetAllSessionsState,
} from "./socket/sessionPersistence";
import {
  applySessionSnapshotToSocket,
  armSnapshotWatchdogTimer,
  fetchSessionSnapshotHttp,
  sendHelloFrameOnSocket,
} from "./socket/snapshotSync";
import {
  type ChatSnapshot,
  type ChatSocketDeps,
  type ClearSendingOptions,
  type DispatchStatus,
  type DurableFrameSeqCheckpointEntry,
  type DurableJournalCheckpoint,
  type InterruptedContinuationTarget,
  LIVE_JOURNAL_MAX_MS,
  LIVE_JOURNAL_MAX_PAGES,
  LIVE_JOURNAL_OPEN_CURSOR,
  NOTIFY_FALLBACK_MS,
  type OfflineItem,
  type PendingPingState,
  type PendingRecoveryErrorEntry,
  RECOVERY_ADOPTION_GRACE_MS,
  RECOVERY_DECISION_GRACE_MS,
  type ServerMessagesArchive,
  type SnapshotApplyContext,
  type SocketCtx,
  TAPE_COMMIT_FINAL_GRACE_MS,
  UNPUBLISHED_TAPE_RETRY_DELAYS_MS,
  UNPUBLISHED_TAPE_RETRY_MAX_MS,
  type UnpublishedTapeRetryState,
} from "./socket/types";
import { SocketContextCompactManager } from "./socketContextCompact";
import { SocketMetaTracker } from "./socketMeta";

export { recoverySkippedNotice } from "./recoveryNotices.js";
export {
  automaticTurnRecoveryTarget,
  exactUserReplayPayload,
  interruptedContinuationIdentity,
  interruptedContinuationTarget,
  LIVE_JOURNAL_MAX_MS,
  LIVE_JOURNAL_MAX_PAGES,
  LIVE_JOURNAL_OPEN_CURSOR,
  messageAttemptIdempotencyKey,
  nextStreamRenderCostMs,
  preciseRetryEligible,
  RECOVERY_ADOPTION_GRACE_MS,
  RECOVERY_DECISION_GRACE_MS,
  streamNotifyWindowMs,
  TAPE_COMMIT_FINAL_GRACE_MS,
  UNPUBLISHED_TAPE_RETRY_DELAYS_MS,
  UNPUBLISHED_TAPE_RETRY_MAX_MS,
};
export type {
  ChatSnapshot,
  ChatSocketDeps,
  ChatStatusClass,
  DispatchStatus,
  InterruptedContinuationTarget,
  OfflineItem,
};

export class ChatSocket implements SocketCtx {
  readonly deps: ChatSocketDeps;
  readonly sessions = new Map<string, ChatSession>();
  readonly serverSessionEnsured = new Set<string>();
  readonly serverSessionInflight = new Map<string, Promise<boolean>>();
  readonly automaticRecoveryPending = new Set<string>();

  private listeners = new Set<() => void>();
  private version = 0;
  private notifyScheduled = false;
  private lastNotifyAt = 0;
  private notifyRaf: number | null = null;
  private notifyFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private notifyThrottled = false;
  streamRenderCostMs = 0;
  private snapshot: ChatSnapshot;

  ws: WebSocket | null = null;
  statusLabel = "未连接";
  statusCls: ChatStatusClass = "disconnected";
  provisioning = false;
  private started = false;
  gateReady = false;
  laneReady = true;

  reconnectAttempts = 0;
  isBrowserOnline = true;
  pendingBrowserOfflineAt = 0;
  lastVisibilityReconnectAt = 0;
  everOpened = false;
  lastOpenAtMs = 0;
  reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  reconnectCountdown: ReturnType<typeof setInterval> | null = null;
  backoffResetTimer: ReturnType<typeof setTimeout> | null = null;

  wsAuthRefreshInFlight = false;
  wsAuthRetryTimer: ReturnType<typeof setTimeout> | null = null;
  authEpoch = 0;
  lifecycleEpoch = 0;

  pingNonce = 0;
  pendingPing: PendingPingState | null = null;
  policyReconnectUntilMs = 0;
  keepAliveTimer: ReturnType<typeof setInterval> | null = null;

  readonly transientNotices = new Map<string, { text: string; ts: number }>();
  readonly firstTextPaintTraceIds = new Set<string>();
  readonly lastSyncAt = new Map<string, number>();
  readonly tapeCommitFinalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly durableHydrationStates = new Map<string, { buffered: OutboundWire[] }>();
  readonly durableHydrationTails = new Map<string, Promise<void>>();
  readonly authoritativeFrameSeqResetEpochBySessionKey = new Map<string, number>();
  readonly durableLiveJournalCheckpoints = new Map<string, DurableJournalCheckpoint>();
  readonly unpublishedTapeRetries = new Map<string, UnpublishedTapeRetryState>();
  readonly degradedJournalRetries = new DegradedJournalRetryTracker();
  readonly subscribedSessions = new Set<string>();
  readonly snapshotAckAt = new Map<string, number>();
  readonly wsSnapshotAt = new Map<string, number>();
  readonly helloAskedCmid = new Map<string, string>();
  readonly helloSentAt = new Map<string, { at: number; order: number }>();
  relayContainerId: number | undefined;
  relayContainerBoundOrder = 0;
  readonly snapshotHttpInFlight = new Set<string>();
  readonly swarmResyncInFlight = new Set<string>();
  snapshotWatchTimer: ReturnType<typeof setTimeout> | null = null;
  activeSessionId: string | undefined;

  reconnectInFlightSet: Set<string> | null = null;
  reconnectInFlightTimer: ReturnType<typeof setTimeout> | null = null;
  restoreBannerOwners: Set<string> | null = null;

  offlineQueue: OfflineItem[] = [];
  readonly dispatchSlots = new Map<string, string>();
  dispatchPumpScheduled = false;
  relayReady = false;
  masterOwnsAutomaticRecovery = false;
  readonly pendingRecoveryErrors = new Map<string, PendingRecoveryErrorEntry>();
  readonly reportedProblemCards = new Set<string>();
  readonly problemCardSourceCodes = new Map<string, string>();
  controlQueue: PendingControlItem[] = [];
  controlPumpScheduled = false;
  readonly controlPersistRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly contextCompact: SocketContextCompactManager;
  readonly pendingRepoBind = new Map<string, { agentId: string; version: number }>();
  readonly metaTracker = new SocketMetaTracker();

  private boundOnline?: () => void;
  private boundOffline?: () => void;
  private boundVisible?: () => void;
  private boundFocus?: () => void;
  private boundBillingPaid?: () => void;
  private boundModelFixed?: () => void;

  constructor(deps: ChatSocketDeps) {
    this.deps = deps;
    this.contextCompact = new SocketContextCompactManager({
      getSession: (id) => this.sessions.get(id),
      safeWsSend: (raw) => this.safeWsSend(raw),
      scheduleNotify: () => this.scheduleNotify(),
      persistSession: (id) => this.deps.persistSession?.(id),
    });
    this.snapshot = {
      version: 0,
      metaVersion: 0,
      status: { label: this.statusLabel, cls: this.statusCls },
      provisioning: this.provisioning,
      browserOnline: this.isBrowserOnline,
      sessions: this.sessions,
    };
    appUpdate.registerBusyProbe(
      () =>
        this.offlineQueue.length > 0 ||
        [...this.sessions.values()].some((session) => session._sendingInFlight),
    );
  }

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  getSnapshot = (): ChatSnapshot => this.snapshot;

  getActiveSessionId(): string | undefined {
    return this.activeSessionId;
  }

  isSessionBusy(sessId: string): boolean {
    const sess = this.sessions.get(sessId);
    return (
      Boolean(sess?._sendingInFlight) ||
      Boolean(sess?._stopSettlement) ||
      this.offlineQueue.some((item) => item.sessId === sessId)
    );
  }

  getDispatchStatus(sessId: string): DispatchStatus | null {
    const sess = this.sessions.get(sessId);
    if (!sess || sess._stopSettlement) return null;
    const pending = this.offlineQueue.filter((item) => item.sessId === sessId);
    if (pending.length === 0) return null;
    if (
      sess._sendingInFlight &&
      !pending.some((item) => item.msgId === sess._activeClientMessageId)
    ) {
      return null;
    }
    const transportReady = Boolean(this.ws && this.ws.readyState === 1 && this.relayReady);
    if (!transportReady) {
      return { phase: "connecting", queued: pending.length, serviceStarting: this.provisioning };
    }
    if (sess._dispatchPaused && !sess._sendingInFlight) {
      return { phase: "paused", queued: pending.length, serviceStarting: false };
    }
    return { phase: "sending", queued: pending.length, serviceStarting: false };
  }

  consumeDirtyPersistIds(): string[] {
    return this.metaTracker.consumeDirtyPersistIds();
  }

  markPersisted(sessId: string): void {
    this.metaTracker.markPersisted(sessId, this.sessions.get(sessId));
  }

  private rebuildSnapshot(): void {
    this.snapshot = {
      version: this.version,
      metaVersion: this.metaTracker.metaVersion,
      status: { label: this.statusLabel, cls: this.statusCls },
      provisioning: this.provisioning,
      browserOnline: this.isBrowserOnline,
      sessions: this.sessions,
    };
  }

  scheduleNotify(): void {
    const turnActive = this.anyTurnInFlight();
    if (this.notifyScheduled) {
      if (!turnActive && this.notifyThrottled) {
        this.clearNotifyTimers();
        this.requestNotifyFrame();
      }
      return;
    }
    this.notifyScheduled = true;
    if (turnActive) {
      const since = Date.now() - this.lastNotifyAt;
      const gap = streamNotifyWindowMs(this.streamRenderCostMs);
      if (since < gap) {
        this.notifyThrottled = true;
        this.notifyFallbackTimer = setTimeout(this.flushNotify, gap - since);
        return;
      }
    }
    this.requestNotifyFrame();
  }

  private requestNotifyFrame(): void {
    this.notifyThrottled = false;
    if (typeof requestAnimationFrame === "function") {
      this.notifyRaf = requestAnimationFrame(this.flushNotify);
      this.notifyFallbackTimer = setTimeout(this.flushNotify, NOTIFY_FALLBACK_MS);
    } else if (typeof queueMicrotask === "function") {
      queueMicrotask(this.flushNotify);
    } else {
      void Promise.resolve().then(this.flushNotify);
    }
  }

  clearNotifyTimers(): void {
    if (this.notifyRaf !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.notifyRaf);
    }
    this.notifyRaf = null;
    if (this.notifyFallbackTimer !== null) {
      clearTimeout(this.notifyFallbackTimer);
      this.notifyFallbackTimer = null;
    }
  }

  resetNotifyFlags(): void {
    this.notifyScheduled = false;
    this.notifyThrottled = false;
  }

  private anyTurnInFlight(): boolean {
    for (const s of this.sessions.values()) {
      if (s._sendingInFlight) return true;
    }
    return false;
  }

  private readonly flushNotify = (): void => {
    if (!this.notifyScheduled) return;
    this.notifyScheduled = false;
    this.notifyThrottled = false;
    this.clearNotifyTimers();
    this.version += 1;
    this.lastNotifyAt = Date.now();
    this.metaTracker.onFlush({
      sessions: this.sessions,
      offlineQueue: this.offlineQueue,
      statusCls: this.statusCls,
      provisioning: this.provisioning,
      browserOnline: this.isBrowserOnline,
    });
    this.rebuildSnapshot();
    const measure =
      this.anyTurnInFlight() &&
      typeof performance !== "undefined" &&
      typeof queueMicrotask === "function";
    const started = measure ? performance.now() : 0;
    for (const cb of this.listeners) cb();
    if (measure) {
      queueMicrotask(() => {
        this.streamRenderCostMs = nextStreamRenderCostMs(
          this.streamRenderCostMs,
          performance.now() - started,
        );
      });
    }
  };

  setStatus(label: string, cls: ChatStatusClass): void {
    if (this.statusLabel === label && this.statusCls === cls) return;
    this.statusLabel = label;
    this.statusCls = cls;
    this.scheduleNotify();
  }

  setProvisioningBanner(visible: boolean): void {
    if (this.provisioning === visible) return;
    this.provisioning = visible;
    this.scheduleNotify();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.boundOnline = () => this.notifyNetworkOnline();
    this.boundOffline = () => this.notifyNetworkOffline();
    this.boundVisible = () => {
      if (document.visibilityState === "visible") this.notifyTabVisible();
    };
    this.boundFocus = () => this.notifyTabVisible();
    this.boundBillingPaid = () => {
      this.retryConnectNow("充值成功，正在重新连接…");
    };
    this.boundModelFixed = () => {
      this.retryConnectNow("模型已切换，正在重新连接…");
    };
    window.addEventListener("online", this.boundOnline);
    window.addEventListener("offline", this.boundOffline);
    document.addEventListener("visibilitychange", this.boundVisible);
    window.addEventListener("pageshow", this.boundFocus);
    window.addEventListener("focus", this.boundFocus);
    window.addEventListener("openclaude:billing-paid", this.boundBillingPaid);
    window.addEventListener("openclaude:model-policy-fixed", this.boundModelFixed);
  }

  stop(): void {
    this.started = false;
    if (this.boundOnline) window.removeEventListener("online", this.boundOnline);
    if (this.boundOffline) window.removeEventListener("offline", this.boundOffline);
    if (this.boundVisible) document.removeEventListener("visibilitychange", this.boundVisible);
    if (this.boundFocus) {
      window.removeEventListener("pageshow", this.boundFocus);
      window.removeEventListener("focus", this.boundFocus);
    }
    if (this.boundBillingPaid) {
      window.removeEventListener("openclaude:billing-paid", this.boundBillingPaid);
    }
    if (this.boundModelFixed) {
      window.removeEventListener("openclaude:model-policy-fixed", this.boundModelFixed);
    }
    teardownSocketOnStop(this);
  }

  setGateReady(ready: boolean): void {
    setGateReadyOnSocket(this, ready);
  }

  setLaneReady(ready: boolean): void {
    const was = this.laneReady;
    this.laneReady = ready;
    if (ready && !was) this.connect();
  }

  safeWsSend(data: string): boolean {
    return safeWsSendOnSocket(this, data);
  }

  setTransientNotice(sessId: string, text: string): void {
    const s = this.sessions.get(sessId);
    if (!s) return;
    if (!s._sendingInFlight && !this.offlineQueue.some((item) => item.sessId === sessId)) return;
    const prev = this.transientNotices.get(sessId);
    if (prev && prev.text === text) {
      prev.ts = Date.now();
      return;
    }
    this.transientNotices.set(sessId, { text, ts: Date.now() });
    this.scheduleNotify();
  }

  clearTransientNotice(sessId: string): void {
    if (this.transientNotices.delete(sessId)) this.scheduleNotify();
  }

  getTransientNotice(sessId: string): { text: string; ts: number } | null {
    return this.transientNotices.get(sessId) ?? null;
  }

  setActiveSession(sessId: string | undefined): void {
    this.activeSessionId = sessId;
  }

  setGoalState(sessId: string, goal: ChatSession["goalState"]): void {
    const sess = this.sessions.get(sessId);
    if (!sess || !shouldApplyGoalSnapshot(sess.goalState, goal ?? null)) return;
    sess.goalState = goal ? structuredClone(goal) : null;
    this.scheduleNotify();
  }

  reconcileSession(sessId: string): void {
    if (!this.deps.syncSession) return;
    const now = Date.now();
    const last = this.lastSyncAt.get(sessId) || 0;
    if (now - last < SYNC_DEBOUNCE_MS) return;
    this.lastSyncAt.set(sessId, now);
    if (this.sessions.get(sessId)?._stopSettlement?.phase === "sync") {
      this.syncSessionAndSettleStop(sessId);
      return;
    }
    void this.deps.syncSession(sessId);
  }

  syncHistory(sessId: string, context?: { clientMessageId?: string }, retry = true): void {
    const sync = this.deps.syncSession;
    if (!sync) return;
    const lifecycle = this.lifecycleEpoch;
    let read: ReturnType<typeof sync>;
    try {
      read = sync(sessId, context);
    } catch {
      read = false;
    }
    void Promise.resolve(read)
      .then(
        (ok) => ok !== false,
        () => false,
      )
      .then((ok) => {
        if (ok || !retry || lifecycle !== this.lifecycleEpoch) return;
        setTimeout(() => {
          if (lifecycle === this.lifecycleEpoch) this.syncHistory(sessId, context, false);
        }, SNAPSHOT_ACK_TIMEOUT_MS);
      });
  }

  syncSessionAndSettleStop(sessId: string, context?: { clientMessageId?: string }): void {
    const settlement = this.sessions.get(sessId)?._stopSettlement;
    if (!settlement || settlement.phase !== "sync") {
      void this.deps.syncSession?.(sessId, context);
      return;
    }
    const syncSession = this.deps.syncSession;
    if (!syncSession) return;
    void Promise.resolve(syncSession(sessId, context)).then(
      (synced) => {
        const sess = this.sessions.get(sessId);
        if (synced !== true || sess?._stopSettlement !== settlement) return;
        this.metaTracker.clearStopTimeout(sessId);
        sess._stopSettlement = undefined;
        this.deps.persistSession?.(sessId);
        this.scheduleNotify();
      },
      (err) => {
        void err;
      },
    );
  }

  resetUnadmittedDispatchesForReplay(): void {
    resetUnadmittedDispatchesForReplayInSocket(this);
  }

  maybePromoteToConnected(): void {
    if (!this.ws || this.ws.readyState !== 1 || !this.relayReady) return;
    if (this.offlineQueue.length > 0) return;
    this.setStatus("已连接", "connected");
  }

  dismissStaleRestoreBanner(): void {
    if (this.statusLabel !== "正在恢复上一轮…") return;
    const owners = this.restoreBannerOwners;
    if (owners) {
      for (const sessId of [...owners]) {
        if (!this.sessions.get(sessId)?._sendingInFlight) owners.delete(sessId);
      }
      if (owners.size > 0) return;
      this.restoreBannerOwners = null;
    }
    if (this.ws?.readyState === 1) {
      const [label, cls] = onopenSetInitialStatus(this.offlineQueue.length);
      this.setStatus(label, cls);
      return;
    }
    if (this.statusCls === "connecting") this.setStatus("连接中…", "connecting");
  }

  clearPendingDispatch(sessId: string, clientMessageId: string): boolean {
    const index = this.offlineQueue.findIndex(
      (item) => item.sessId === sessId && item.msgId === clientMessageId,
    );
    if (index < 0) return false;
    this.offlineQueue.splice(index, 1);
    this.maybePromoteToConnected();
    const durableClear = this.deps.deletePendingDispatch?.(sessId, clientMessageId);
    if (durableClear) {
      void durableClear.catch((err) => {
        void err;
      });
    }
    this.deps.persistSession?.(sessId);
    return true;
  }

  beginTurn(
    sess: ChatSession,
    clientMessageId: string,
    agentId?: string,
    startedAt = Date.now(),
  ): void {
    if (sess._activeClientMessageId !== clientMessageId) {
      sess._turnStatus = null;
      sess._turnStatusSince = sess._turnProgressHint = undefined;
    }
    sess._streamingAssistant = sess._streamingThinking = sess._agentSwitchedAt = null;
    sess._blockIdToMsgId = new Map();
    sess._localTeardownAt = undefined;
    sess._sendingInFlight = true;
    sess._activeClientMessageId = clientMessageId;
    sess._activeAgentId = agentId || sess.agentId;
    sess._turnStartedAt = startedAt;
    sess._pendingCostCredits = "0";
    sess._lastFinaledAssistantId = null;
    sess._lastFinaledAt = 0;
  }

  confirmDispatchAdmission(sessId: string, clientMessageId: string, accepted = true): boolean {
    const sess = this.sessions.get(sessId);
    if (!sess) return false;
    const pending = this.offlineQueue.find(
      (item) => item.sessId === sessId && item.msgId === clientMessageId,
    );
    const systemCallback =
      !sess._sendingInFlight && isSystemCallbackClientMessageId(clientMessageId);
    const ownsTurn =
      sess._activeClientMessageId === clientMessageId || pending !== undefined || systemCallback;
    if (!ownsTurn) return false;
    if (sess._stopSettlement?.clientMessageId === clientMessageId) return true;
    if (sess._deferredTerminalErrorClientMessageId === clientMessageId) return true;

    let changed = pending !== undefined || this.dispatchSlots.get(sessId) !== clientMessageId;
    this.clearPendingDispatch(sessId, clientMessageId);
    this.dispatchSlots.set(sessId, clientMessageId);
    const user = sess.messages.find(
      (message) => message.role === "user" && message.id === clientMessageId,
    );
    changed = confirmDispatchDelivery(sess, clientMessageId, accepted) || changed;
    if (
      user?._routing?.modelSwitchId &&
      sess._preparedModelSwitch?.id === user._routing.modelSwitchId
    ) {
      sess._preparedModelSwitch = undefined;
      changed = true;
    }
    if (!sess._sendingInFlight) {
      changed = true;
      this.beginTurn(sess, clientMessageId, pending?.payload.agentId);
    }
    this.clearTransientNotice(sess.id);
    if (changed) this.scheduleNotify();
    return true;
  }

  finishDispatch(sessId: string, clientMessageId: string | undefined): void {
    if (!clientMessageId) return;
    this.clearPendingDispatch(sessId, clientMessageId);
    if (this.dispatchSlots.get(sessId) === clientMessageId) this.dispatchSlots.delete(sessId);
    this.kickDispatchPump();
  }

  clearLiveJournalDegraded(sess: ChatSession): void {
    if (sess._liveJournalDegraded) sess._liveJournalDegraded = false;
    this.degradedJournalRetries.clear(sess.id);
  }

  scheduleDegradedJournalRetry(sessId: string): void {
    this.degradedJournalRetries.schedule(sessId, {
      getSession: (id) => this.sessions.get(id),
      getEpoch: () => this.lifecycleEpoch,
      syncSession: this.deps.syncSession,
    });
  }

  clearSendingState(sess: ChatSession, opts: ClearSendingOptions = {}): void {
    sess._sendingInFlight = false;
    sess._activeClientMessageId = undefined;
    sess._activeAgentId = undefined;
    this.clearLiveJournalDegraded(sess);
    if (opts.clearTiming !== false) clearTurnTiming(sess);
    if (opts.resetTracker !== false) resetReplyTracker(sess);
    sess._localTeardownAt =
      typeof sess._trackerResetAt === "number" ? sess._trackerResetAt : Date.now();
    if (opts.persist !== false) this.deps.persistSession?.(sess.id);
    this.kickQueuedDrainIfIdle();
    this.dismissStaleRestoreBanner();
  }

  effects(): FrameEffects {
    return createSocketFrameEffects(this);
  }

  connect(): void {
    openSocketConnection(this);
  }

  dispatch(f: OutboundWire): void {
    dispatchOutboundFrame(this, f);
  }

  noteAuthoritativeFrameSeqReset(sess: ChatSession, frame: { sessionKey?: string }): void {
    const key = frameSeqKey(frame, sess.id);
    this.authoritativeFrameSeqResetEpochBySessionKey.set(
      key,
      (this.authoritativeFrameSeqResetEpochBySessionKey.get(key) ?? 0) + 1,
    );
  }

  reconcileContainerForSession(sess: ChatSession): void {
    const opts = {
      keepAcceptedAfterOrder: this.relayContainerBoundOrder,
      onResetKey: (sessionKey: string) =>
        this.noteAuthoritativeFrameSeqReset(sess, { sessionKey }),
    };
    if (reconcileSessionRelayContainer(sess, this.relayContainerId, opts).changed) {
      this.deps.persistSession?.(sess.id);
    } else if (
      this.relayContainerId &&
      sess._frameSeqContainerId === undefined &&
      hasPositiveAgentFrameSeqCursor(sess)
    ) {
      this.armSnapshotWatchdog();
    }
  }

  sendHelloFrame(includeInFlight = true, onlySessionId?: string): boolean {
    return sendHelloFrameOnSocket(this, includeInFlight, onlySessionId);
  }

  subscribeSession(sessId: string): void {
    if (this.subscribedSessions.has(sessId) || this.ws?.readyState !== 1) return;
    this.sendHelloFrame(false, sessId);
  }

  applySessionSnapshot(
    sessId: string,
    snap: SessionSnapshot,
    snapCtx: SnapshotApplyContext,
  ): Promise<void> {
    return applySessionSnapshotToSocket(this, sessId, snap, snapCtx);
  }

  armSnapshotWatchdog(): void {
    armSnapshotWatchdogTimer(this);
  }

  fetchSessionSnapshot(
    sessId: string,
    opts?: { retry?: boolean; verifyOnly?: boolean },
  ): Promise<SessionSnapshot | null | undefined> {
    return fetchSessionSnapshotHttp(this, sessId, opts);
  }

  deferTerminalErrorForRecovery(
    sessId: string,
    paint: DeferredTerminalErrorPaint,
    masterOwned = this.masterOwnsAutomaticRecovery,
  ): boolean {
    if (!masterOwned && !this.deps.syncSession) return false;
    const sess = this.sessions.get(sessId);
    if (!sess) return false;
    const clientMessageId = paint.clientMessageId ?? sess._activeClientMessageId;
    if (!isClientMessageId(clientMessageId)) return false;
    if (clientMessageId && sess._cancelledAutomaticRecoveryIds?.[clientMessageId] === true) {
      return false;
    }
    if (clientMessageId && sess._automaticRecoveryDecisions?.[clientMessageId] === true) {
      return false;
    }
    const previous = this.pendingRecoveryErrors.get(sessId);
    if (previous) {
      if (previous.clientMessageId === clientMessageId) {
        clearTimeout(previous.timer);
        this.pendingRecoveryErrors.delete(sessId);
      } else {
        this.materializePendingRecoveryError(sessId, "decision_timeout");
      }
    }
    const timer = setTimeout(
      () => this.verifyDeferredRecovery(sessId, "decision_timeout"),
      RECOVERY_DECISION_GRACE_MS,
    );
    this.pendingRecoveryErrors.set(sessId, {
      paint,
      clientMessageId,
      timer,
      decided: false,
      masterOwned,
    });
    stashProblemCardSourceCodeInSocket(this, sessId, clientMessageId, paint.normalized);
    if (!masterOwned) {
      setTimeout(() => void this.autoRecoverTerminalTurn(sessId, clientMessageId), 0);
    }
    return true;
  }

  settlePendingRecoveryError(
    sessId: string,
    sourceClientMessageId: string | undefined,
    outcome: "adopted" | "declined",
    cause?: ProblemCardMaterializeCause,
    reason?: string,
  ): void {
    settlePendingRecoveryErrorInSocket(this, sessId, sourceClientMessageId, outcome, cause, reason);
  }

  discardDeferredTerminalError(sessId: string, clientMessageId?: string): void {
    discardDeferredTerminalErrorInSocket(this, sessId, clientMessageId);
  }

  verifyDeferredRecovery(sessId: string, cause: "decision_timeout" | "adoption_timeout"): void {
    verifyDeferredRecoveryTimeout(this, sessId, cause);
  }

  materializePendingRecoveryError(
    sessId: string,
    cause: ProblemCardMaterializeCause,
    reason?: string,
  ): void {
    materializePendingRecoveryErrorInSocket(this, sessId, cause, reason);
  }

  retryConnectNow(label = "重新连接中…"): boolean {
    return retryConnectNowFlow(this, label);
  }

  notifyNetworkOffline(): void {
    notifyNetworkOfflineFlow(this);
  }

  notifyNetworkOnline(): void {
    notifyNetworkOnlineFlow(this);
  }

  notifyTabVisible(): void {
    notifyTabVisibleFlow(this);
  }

  bumpAuthEpoch(): void {
    this.authEpoch += 1;
    cancelWsAuthRecoveryInSocket(this);
  }

  ensureSession(sessId: string, agentId: string, title?: string): ChatSession {
    let s = this.sessions.get(sessId);
    if (!s) {
      s = createSession({ id: sessId, agentId, title });
      this.sessions.set(sessId, s);
      this.reconcileContainerForSession(s);
      this.scheduleNotify();
    }
    return s;
  }

  ensureServerSession(sessId: string, agentId: string, title?: string): Promise<boolean> {
    const sess = this.ensureSession(sessId, agentId, title);
    return this.ensureServerSessionOnce(sess, agentId);
  }

  ensureServerSessionOnce(sess: ChatSession, agentId: string): Promise<boolean> {
    return ensureServerSessionOnceFlow(this, sess, agentId);
  }

  renameSession(sessId: string, title: string): void {
    const s = this.sessions.get(sessId);
    if (!s || s.title === title) return;
    s.title = title;
    this.scheduleNotify();
  }

  setSessionModel(sessId: string, modelId: string, modelSwitchId?: string): void {
    const s = this.sessions.get(sessId);
    if (!s) return;
    const changed = s._selectedModelId !== modelId;
    s._selectedModelId = modelId;
    s._preparedModelSwitch = modelSwitchId ? { id: modelSwitchId, targetModel: modelId } : undefined;
    if (changed || modelSwitchId) this.scheduleNotify();
  }

  cancelPendingModelSwitches(sessId: string): void {
    this.contextCompact.cancelPendingModelSwitches(sessId);
  }

  prepareModelSwitch(sessId: string, sourceModel: string, targetModel: string): Promise<string> {
    return this.contextCompact.prepareModelSwitch(sessId, sourceModel, targetModel);
  }

  compactSession(sessId: string, instructions?: string): Promise<OutboundSessionCompactResultWire> {
    return this.contextCompact.compactSession(sessId, instructions);
  }

  removeSession(sessId: string): void {
    removeSessionState(this, sessId);
  }

  resetSessions(): void {
    resetAllSessionsState(this);
  }

  toStored(sessId: string): StoredSession | null {
    const s = this.sessions.get(sessId);
    if (!s) return null;
    const messages = prepareMessagesForStoredSession(s.messages);
    return {
      id: s.id,
      agentId: s.agentId,
      title: s.title,
      messages,
      createdAt: s.createdAt,
      lastAt: s.lastAt,
      updatedAt: s.updatedAt,
      ...buildStoredSessionPreDecisionFields(s),
      ...(s._automaticRecoveryDecisions
        ? { _automaticRecoveryDecisions: { ...s._automaticRecoveryDecisions } }
        : {}),
      ...buildStoredSessionPostDecisionFields(s, this.pendingRecoveryErrors.get(s.id)),
    };
  }

  loadStored(stored: StoredSession): void {
    loadStoredSessionIntoSocket(this, stored);
  }

  applyServerMessages(
    sessId: string,
    agentId: string,
    rawMsgs: ChatMessage[],
    full: boolean,
    maxSeq?: number,
    archive?: ServerMessagesArchive,
  ): void {
    const merged = mergeServerHistoryPreliminary(
      this,
      sessId,
      agentId,
      rawMsgs,
      full,
      maxSeq,
      archive,
    );
    if (!merged) return;
    const { session: s, acceptedMsgs: msgs, terminalTurns } = merged;
    applyAutomaticRecoverySnapshot(s, msgs, archive?.automaticRecoveries, {
      defer: (paint) => this.deferTerminalErrorForRecovery(s.id, paint, true),
      settle: (cmid, outcome) =>
        this.settlePendingRecoveryError(s.id, cmid, outcome, "decision_declined"),
    });
    finalizeServerMessagesTail(
      this,
      s,
      archive,
      terminalTurns,
      adoptPendingAutomaticRecoveryFromHistory,
    );
  }

  applyPermissionPromptSnapshot(
    sessId: string,
    snapshot: PermissionPromptSnapshotPayload | null | undefined,
  ): string[] {
    const sess = this.sessions.get(sessId);
    if (!sess || !snapshot) return [];
    const lookupIds = applyPermissionSnapshot(sess, snapshot);
    reconcileOrphanControlPending(sess, this.controlQueue);
    this.deps.persistSession?.(sess.id);
    this.scheduleNotify();
    if (lookupIds.length > 0) this.deps.lookupPermissionPrompts?.(sess.id, lookupIds);
    return lookupIds;
  }

  hydrateDurableLiveFrameJournal(
    sessId: string,
    fetchPage: (after: string) => Promise<DurableLiveFramePage>,
    applyTapeProjection: () => Promise<void>,
    fetchUnits?: (query?: { before?: string | null }) => Promise<unknown>,
  ): Promise<void> {
    return hydrateDurableLiveFrameJournalFlow(
      this,
      sessId,
      fetchPage,
      applyTapeProjection,
      fetchUnits,
    );
  }

  clearUnpublishedTapeRetry(sessId: string): void {
    clearUnpublishedTapeRetryForSession(this, sessId);
  }

  reconcileUnpublishedTapeRetry(sessId: string): void {
    reconcileUnpublishedTapeRetryForSession(this, sessId);
  }

  runDurableLiveFrameHydration(sessId: string, hydrate: () => Promise<void>): Promise<void> {
    return runDurableLiveFrameHydrationSerial(this, sessId, hydrate);
  }

  resetOwnerLocalRows(
    sess: ChatSession,
    resetClientMessageIds: string[],
    incomingProcessOwners: ReadonlySet<string>,
  ): void {
    resetOwnerLocalRowsInSession(sess, resetClientMessageIds, incomingProcessOwners);
  }

  applyLiveUnits(
    sessId: string,
    units: LiveUnit[],
    resetClientMessageIds: string[] = [],
    resume?: { sessionKey: string; frameSeq: number; recordId: string; streamKey?: string },
    streamGeneration = 0,
  ): void {
    applyLiveUnitsToSession(
      this,
      sessId,
      units,
      resetClientMessageIds,
      resume,
      streamGeneration,
    );
  }

  prependLiveUnits(sessId: string, units: LiveUnit[]): void {
    prependLiveUnitsToSession(this, sessId, units);
  }

  resyncSwarmUnits(sessId: string, expectedClientMessageId?: string): void {
    resyncSwarmUnitsForSession(this, sessId, expectedClientMessageId);
  }

  applyDurableLiveFrames(
    sessId: string,
    frames: DurableLiveFrame[],
    resetClientMessageIds: string[] = [],
    lastDurableFrameSeqBySessionKey?: Map<string, DurableFrameSeqCheckpointEntry>,
  ): void {
    applyDurableLiveFramesToSession(
      this,
      sessId,
      frames,
      resetClientMessageIds,
      lastDurableFrameSeqBySessionKey,
    );
  }

  prependArchivedMessages(sessId: string, msgs: ChatMessage[]): void {
    prependArchivedMessagesToSession(this, sessId, msgs);
  }

  prependTimelinePage(
    sessId: string,
    msgs: ChatMessage[],
    loadedFrom: string,
    nextCursor: string | null,
    hasMore: boolean,
    timelineGeneration: number,
  ): void {
    const s = this.sessions.get(sessId);
    if (
      !s ||
      s._timelineGeneration !== timelineGeneration ||
      s._timelineCursor !== loadedFrom
    ) {
      return;
    }
    const serial = (s._historyPageSerial ?? 0) + 1;
    const pageKey = `history-page:${timelineGeneration}:${serial}`;
    const page = msgs.map((message) => ({
      ...message,
      _source: "server" as const,
      _timelineRecord: true,
      _historyPageLoadedFrom: loadedFrom,
      _historyPageKey: pageKey,
    }));
    s.messages = mergeTimelineHistoryPage(s.messages, page);
    s.messages = reconcileTimelineBashTailAuxiliaries(s.messages);
    s.messages = reconcileLateDelegateAgentGroups(s.messages);
    s._historyPageSerial = serial;
    s._timelineCursor = nextCursor;
    s._timelineHasMore = hasMore && typeof nextCursor === "string" && nextCursor.length > 0;
    s._blockIdToMsgId = new Map();
    s._agentGroups = new Map();
    rebuildIndexes(s);
    this.scheduleNotify();
  }

  resolveTimelineAuxiliary(sessId: string, unitKey: string, records: ChatMessage[]): void {
    resolveTimelineAuxiliaryInSession(this, sessId, unitKey, records);
  }

  syncHistoryNow(sessId: string): void {
    void this.deps.syncSession?.(sessId);
  }

  archiveBeforeSeq(sessId: string): number {
    return computeArchiveBeforeSeq(this.sessions, sessId);
  }

  switchAgent(sessId: string, agentId: string): void {
    const sess = this.sessions.get(sessId);
    if (!sess || !agentId || sess.agentId === agentId) return;
    if (sess._sendingInFlight || this.offlineQueue.some((item) => item.sessId === sessId)) {
      this.stopTurn(sessId);
    }
    sess.agentId = agentId;
    sess._agentSwitchedAt = Date.now();
    resetReplyTracker(sess);
    sess._localTeardownAt = sess._trackerResetAt;
    this.clearTransientNotice(sess.id);
    this.scheduleNotify();
  }

  sendRepoBind(sessId: string, agentId: string, version: number): void {
    sendRepoBindControl(this, sessId, agentId, version);
  }

  sendRepoUnbind(sessId: string, version: number): void {
    sendRepoUnbindControl(this, sessId, version);
  }

  flushAllRepoBinds(): void {
    flushAllRepoBindsOnSocket(this);
  }

  maybeClearPendingRepoBind(sessId: string | undefined, version: number | undefined): void {
    maybeClearPendingRepoBindOnSocket(this, sessId, version);
  }

  sendMessage(p: SendMessageParams): Promise<boolean> {
    return sendUserMessageFlow(this, p);
  }

  kickQueuedDrainIfIdle(): void {
    if (this.offlineQueue.length === 0) return;
    this.kickDispatchPump();
  }

  kickDispatchPump(): void {
    kickDispatchPumpFlow(this);
  }

  kickControlPump(): void {
    kickControlPumpFlow(this);
  }

  enqueueControl(item: PendingControlItem, alreadyPersisted = false): void {
    enqueueControlItem(this, item, alreadyPersisted);
  }

  settleControl(controlId: string, status: "applied" | "terminal"): void {
    settleControlItem(this, controlId, status);
  }

  resetControlsForReplay(): void {
    resetControlsForReplayInSocket(this);
  }

  autoRecoverTerminalTurn(sessId: string, clientMessageId?: string): Promise<void> {
    return autoRecoverTerminalTurnFlow(this, sessId, clientMessageId, (s, target, agent, auto) =>
      dispatchTurnRecoveryMessage(
        this,
        s,
        target,
        agent,
        auto,
        (sess, msg, payload) => dispatchInboundPayload(this, sess, msg, payload),
        ensureGenPlaceholderRow,
      ),
    );
  }

  continueInterruptedTurn(p: { sessId: string; errorMessageId: string; agentId: string }): void {
    continueInterruptedTurnFlow(this, p, (s, target, agent, auto) =>
      dispatchTurnRecoveryMessage(
        this,
        s,
        target,
        agent,
        auto,
        (sess, msg, payload) => dispatchInboundPayload(this, sess, msg, payload),
        ensureGenPlaceholderRow,
      ),
    );
  }

  retryMessage(p: {
    sessId: string;
    msgId: string;
    agentId: string;
    sourceOverride?: ChatMessage;
  }): Promise<void> {
    return retryUserMessageFlow(this, p);
  }

  editQueuedMessage(sessId: string, msgId: string): string | undefined {
    return editQueuedMessageInSession(this, sessId, msgId);
  }

  discardQueuedMessage(sessId: string, msgId: string): boolean {
    return this.editQueuedMessage(sessId, msgId) !== undefined;
  }

  sendQueuedNow(sessId: string, msgId: string): void {
    sendQueuedMessageNow(this, sessId, msgId);
  }

  stopTurn(sessId: string, expectedClientMessageId?: string): void {
    stopTurnFlow(this, sessId, expectedClientMessageId);
  }

  respondPermission(p: {
    sessId: string;
    requestId: string;
    behavior: "allow" | "deny";
    message?: string;
    updatedInput?: Record<string, unknown>;
  }): void {
    respondPermissionFlow(this, p);
  }

  autoContinueEmptyTurn(sessId: string, targetMsgId: string, cls: EmptyTurnDecision): void {
    autoContinueEmptyTurnFlow(this, sessId, targetMsgId, cls, (sess, msg, payload) =>
      dispatchInboundPayload(this, sess, msg, payload),
    );
  }

  clearAutoContinueInFlight(idem: string): void {
    clearAutoContinueInFlightByIdem(this, idem);
  }
}
