// pgSessionsBackend — master 会话权威六表的 PostgreSQL 实现门面(RFC-v5-sessions-pg)。
// 具体子域存储拆分至 ./sessions/*.ts;本门面负责聚合跨层依赖(PgSessionsDeps)、装配
// PgSessionsBackend 并保持原有全部具名导出与契约零变更。

import type { Pool, PoolClient } from "pg";
import type {
  LosslessTurnTapeFinalizeRequest,
  LosslessTurnTapeVisibleRequest,
} from "@openclaude/protocol";
import {
  scanUploadReferenceRows, hydrateUploadReferenceMessages,
  UPLOAD_REFERENCE_MAX_BYTES, UPLOAD_REFERENCE_MAX_MS, UPLOAD_REFERENCE_MAX_ROWS,
} from "@openclaude/storage";
import {
  ClientTimelineCursorStaleError, CHAT_PROJECT_COLOR_MAX, CHAT_PROJECT_INSTRUCTIONS_MAX,
  CHAT_PROJECT_PER_USER_LIMIT, PROJECT_ASSET_LIST_LIMIT_DEFAULT, PROJECT_ASSET_LIST_LIMIT_MAX,
  PROJECT_ASSET_SEARCH_LIMIT_DEFAULT, PROJECT_ASSET_SEARCH_LIMIT_MAX, PROJECT_ASSET_SEARCH_QUERY_MAX,
  PROJECT_ASSET_PER_PROJECT_LIMIT, PROJECT_ASSET_PINNED_INJECT_MAX, PROJECT_ASSET_VERSION_GROUP_SQL,
  compareMessagesByOrder, deriveArchivedOrderSeqsForRead, deriveOrderSeqsForRead, MAX_SESSION_BYTES,
  hasInvisibleHistoryMutation, hasInvisibleMessageRemoval, mapClientSessionLastOutcome,
  mergePreservingServerAuthored, normalizeAndAssignOrderSeqs, normalizeAndAssignSeqs,
  _warnSeqAnomaly, buildSearchSnippet, escapeLikePattern, normalizeChatProjectAssetSearch,
  parseBoardProjectId, assetsRevision, parseChatProjectName, parseChatProjectOptionalText,
  parseChatProjectSortOrder, parseChatProjectTemplate, parseDeletedManifest,
  CHAT_PROJECT_RESTORE_WINDOW_MS, parseProjectAssetCreateInput, parseProjectAssetName,
  parseProjectAssetProjectId, withVersionCount, parseSessionBatchInput, rankSessionSearchHits,
  sanitizeProjectInstructions, LAST_MESSAGE_PREVIEW_TAIL_MAX, CLIENT_SESSION_UNREAD_OUTCOMES,
  lastReadAtWatermarkMsSql, SESSION_BATCH_IDS_MAX, SESSION_LIST_LIMIT_MAX,
  SESSION_SEARCH_JSON_CANDIDATE_MAX, SESSION_SEARCH_JSON_EXPAND_MAX_BYTES,
  SESSION_SEARCH_LIMIT_DEFAULT, SESSION_SEARCH_LIMIT_MAX, toLastMessagePreview,
  planAppendServerAuthored, planAppendServerAuthoredBatch, planReplaceServerAuthoredKeepingOrderSlots,
  planCostPatch, planDelegateCostMerge, planSpillOverflow, selectEngineContextSuffix,
  _stripClientPutMessages, WechatAccountAlreadyBoundError,
  type ChatProject, type MessageLike, type ServerAuthoredAppendResult,
} from "@openclaude/storage";
import {
  canonicalPublishedAgentGroupRecordFingerprint, computeGoalTokensUsed,
  isLosslessRuntimeBatchingEnabled, materializeLosslessTurn,
  materializeRootDomainAgentGroupRecord, parseLosslessTurnPayload,
  type LosslessTurnPayload,
} from "../http/losslessTurnTape.js";
import { bumpGoalUsageSnapshotForTape } from "../goal/goalStateService.js";
import { ensurePendingTurnWaiverInTransaction } from "../billing/refund.js";
import {
  lockTurnBillingKeys, lockTurnPersistenceKeys, numericCommercialUserId,
} from "../billing/turnLock.js";
import {
  recoverAdmissionAfterRestart, reconcileAdmissionRestarts,
} from "../dispatch/admissionRestartRecovery.js";
import {
  admitDispatch, casToManualReconcile, casToTerminal, getDispatch,
} from "../dispatch/turnDispatchStore.js";
import {
  bindRecoveryJobDispatch, enqueueAutomaticRecoveryJob, lockRecoveryRoot,
  pauseSilentRecoveryLineage, settleRecoveryJobForTape,
} from "../dispatch/turnRecoveryStore.js";
import {
  cancelPendingPermissionPromptsForTurn, readPermissionPromptSnapshot,
  readPermissionPromptsByRequestIds, serializePermissionPromptEntry, settleStopControlsForTurn,
} from "../dispatch/turnControlStore.js";

import type { PgSessionsCtx, PgSessionsDeps } from "./sessions/deps.js";
import type {
  DirectTapePageHead, LateDelegateRootDecision, LosslessTurnTapeFinalizeResult,
  LosslessTurnTapeStorageFormat, PgSessionsBackend, PgSessionsBackendOptions,
  PreparedLosslessTurnTape, QueryRunner,
} from "./sessions/types.js";
import {
  _createFinalizeSingleflight, _losslessFinalizeSingleflightKey,
  advanceClientTimelineIdentityInTransaction, escapeNulInSessionMessagesJson,
  lookupLeaseCallbackSession, notifyRecoveryJobTerminals, probeSessionsDb,
  readClientSessionModelId, withTx,
} from "./sessions/sqlHelpers.js";
import {
  appendPromptQueueUserMessageInTransaction as appendPromptQueueUserMessageInTxImpl,
  appendRecoveryGiveUpTerminalCard as appendRecoveryGiveUpTerminalCardImpl,
} from "./sessions/appendCore.js";
import { readCcbNativeRestoreArchive } from "./sessions/pgTapeUsageAndRecordHydrate.js";
import { userVisibleTapeRecord } from "./sessions/pgTapeSanitizeAndEncode.js";
import {
  createPgChatProjectsStore, readPgChatProject as readPgChatProjectImpl,
} from "./sessions/pgChatProjectsStore.js";
import { createPgProjectAssetsStore } from "./sessions/pgProjectAssetsStore.js";
import { createPgWechatBindingsStore } from "./sessions/pgWechatBindingsStore.js";
import { createPgSessionClaimAndMetaStore } from "./sessions/pgSessionClaimAndMetaStore.js";
import { createPgSessionSearchAndBatchStore } from "./sessions/pgSessionSearchAndBatchStore.js";
import {
  loadSettledUsageAttribution, loadUsageAttributionCredits,
  stageUsageCostLocatorInBillingTransaction,
} from "./sessions/pgUsageAttributionReader.js";
import { createPgUsageAggregationStore } from "./sessions/pgUsageAggregationStore.js";
import {
  createPgSessionsGcStore, startSessionsGcSweeper,
} from "./sessions/pgSessionsGcStore.js";
import {
  _resetAutomaticRecoveryReconcileSkipsForTest, createPgAutoRecoveryStore,
} from "./sessions/pgAutoRecoveryStore.js";
import { createPgDispatchAdmissionStore } from "./sessions/pgDispatchAdmissionStore.js";
import {
  _createPhysicalFinalizeAdmission,
  _prepareLosslessTurnTapeOutsideLocks as prepareLosslessTurnTapeOutsideLocksImpl,
  inspectLateDelegateContinuationAgainstRoot as inspectLateDelegateContinuationImpl,
} from "./sessions/pgTurnTapePrepAndInspect.js";
import {
  LOSSLESS_TURN_RECORD_STAGE_BATCH_BYTES, LOSSLESS_TURN_RECORD_STAGE_BATCH_SIZE,
  _losslessTurnRecordStageBatches, _losslessTurnRecordWriteChunks,
  _setAfterLosslessStageBatch, _setPhaseASqlObserver, _stagePreparedLosslessTurnRecords,
  createPgTurnTapeStageStore,
} from "./sessions/pgTurnTapeStageStore.js";
import {
  commitVisibleLosslessTurnPhaseA as commitVisibleLosslessTurnPhaseAImpl,
  createPgTurnTapePhaseAStore,
} from "./sessions/pgTurnTapePhaseAStore.js";
import { createPgTurnTapeFinalizeStore } from "./sessions/pgTurnTapeFinalizeStore.js";
import {
  hydrateDirectTapePage as hydrateDirectTapePageImpl,
} from "./sessions/pgTapeHydrateReader.js";
import { createPgEngineContextReader } from "./sessions/pgEngineContextReader.js";
import { createPgTimelinePageReader } from "./sessions/pgTimelinePageReader.js";
import {
  createPgTapeRecordReader, listTurnTapeRecordsImpl,
} from "./sessions/pgTapeRecordReader.js";
import { createPgSessionReadAndArchiveStore } from "./sessions/pgSessionReadAndArchiveStore.js";

function usesNativeFiniteContextEngine(engine: string | undefined): boolean {
  return engine === "ccb" || engine === "codex" || engine === "grok";
}

function directTapeHeaderContinuation(
  header: { continuationOfTurnKey: string | null },
): { continuationOfTurnKey: string | null } {
  return { continuationOfTurnKey: header.continuationOfTurnKey };
}

const PG_SESSIONS_DEPS: PgSessionsDeps = {
  storage: {
    scanUploadReferenceRows, hydrateUploadReferenceMessages,
    UPLOAD_REFERENCE_MAX_BYTES, UPLOAD_REFERENCE_MAX_MS, UPLOAD_REFERENCE_MAX_ROWS,
    ClientTimelineCursorStaleError, CHAT_PROJECT_COLOR_MAX, CHAT_PROJECT_INSTRUCTIONS_MAX,
    CHAT_PROJECT_PER_USER_LIMIT, PROJECT_ASSET_LIST_LIMIT_DEFAULT, PROJECT_ASSET_LIST_LIMIT_MAX,
    PROJECT_ASSET_SEARCH_LIMIT_DEFAULT, PROJECT_ASSET_SEARCH_LIMIT_MAX, PROJECT_ASSET_SEARCH_QUERY_MAX,
    PROJECT_ASSET_PER_PROJECT_LIMIT, PROJECT_ASSET_PINNED_INJECT_MAX, PROJECT_ASSET_VERSION_GROUP_SQL,
    compareMessagesByOrder, deriveArchivedOrderSeqsForRead, deriveOrderSeqsForRead, MAX_SESSION_BYTES,
    hasInvisibleHistoryMutation, hasInvisibleMessageRemoval, mapClientSessionLastOutcome,
    mergePreservingServerAuthored, normalizeAndAssignOrderSeqs, normalizeAndAssignSeqs,
    _warnSeqAnomaly, buildSearchSnippet, escapeLikePattern, normalizeChatProjectAssetSearch,
    parseBoardProjectId, assetsRevision, parseChatProjectName, parseChatProjectOptionalText,
    parseChatProjectSortOrder, parseChatProjectTemplate, parseDeletedManifest,
    CHAT_PROJECT_RESTORE_WINDOW_MS, parseProjectAssetCreateInput, parseProjectAssetName,
    parseProjectAssetProjectId, withVersionCount, parseSessionBatchInput, rankSessionSearchHits,
    sanitizeProjectInstructions, LAST_MESSAGE_PREVIEW_TAIL_MAX, CLIENT_SESSION_UNREAD_OUTCOMES,
    lastReadAtWatermarkMsSql, SESSION_BATCH_IDS_MAX, SESSION_LIST_LIMIT_MAX,
    SESSION_SEARCH_JSON_CANDIDATE_MAX, SESSION_SEARCH_JSON_EXPAND_MAX_BYTES,
    SESSION_SEARCH_LIMIT_DEFAULT, SESSION_SEARCH_LIMIT_MAX, toLastMessagePreview,
    planAppendServerAuthored, planAppendServerAuthoredBatch, planReplaceServerAuthoredKeepingOrderSlots,
    planCostPatch, planDelegateCostMerge, planSpillOverflow, selectEngineContextSuffix,
    _stripClientPutMessages, WechatAccountAlreadyBoundError,
  },
  lossless: {
    canonicalPublishedAgentGroupRecordFingerprint, computeGoalTokensUsed,
    isLosslessRuntimeBatchingEnabled, materializeLosslessTurn,
    materializeRootDomainAgentGroupRecord, parseLosslessTurnPayload,
  },
  goal: { bumpGoalUsageSnapshotForTape },
  billing: {
    ensurePendingTurnWaiverInTransaction,
    lockTurnBillingKeys, lockTurnPersistenceKeys, numericCommercialUserId,
  },
  dispatch: {
    recoverAdmissionAfterRestart, reconcileAdmissionRestarts,
    admitDispatch, casToManualReconcile, casToTerminal, getDispatch,
    bindRecoveryJobDispatch, enqueueAutomaticRecoveryJob, lockRecoveryRoot,
    pauseSilentRecoveryLineage, settleRecoveryJobForTape,
    cancelPendingPermissionPromptsForTurn, readPermissionPromptSnapshot,
    readPermissionPromptsByRequestIds, serializePermissionPromptEntry, settleStopControlsForTurn,
  },
  usesNativeFiniteContextEngine,
  continuationOwnerSqlCol: "t.continuation_of_turn_key",
  headerContinuationExtras: directTapeHeaderContinuation,
};

export function readPgChatProject(
  queryable: QueryRunner,
  userId: string,
  id: string,
): Promise<ChatProject | null> {
  return readPgChatProjectImpl(queryable, userId, id, PG_SESSIONS_DEPS);
}

export function appendPromptQueueUserMessageInTransaction(
  client: PoolClient,
  sessionId: string,
  userId: string,
  message: MessageLike & { id: string; role: "user" },
): Promise<ServerAuthoredAppendResult> {
  return appendPromptQueueUserMessageInTxImpl(client, sessionId, userId, message, PG_SESSIONS_DEPS);
}

export function appendRecoveryGiveUpTerminalCard(
  client: PoolClient,
  input: {
    sessionId: string;
    sessionUserId: string;
    rootClientMessageId: string;
    reason: "silent_no_progress" | "retry_exhausted" | "recovery_refused";
  },
): Promise<boolean> {
  return appendRecoveryGiveUpTerminalCardImpl(client, input, PG_SESSIONS_DEPS);
}

export function inspectLateDelegateContinuationAgainstRoot(
  pool: Pool | PoolClient,
  userId: string,
  request: LosslessTurnTapeFinalizeRequest,
  continuationPayload?: LosslessTurnPayload,
): Promise<LateDelegateRootDecision> {
  return inspectLateDelegateContinuationImpl(pool, userId, request, PG_SESSIONS_DEPS, continuationPayload);
}

export function _prepareLosslessTurnTapeOutsideLocks(
  pool: Pool,
  userId: string,
  request: LosslessTurnTapeFinalizeRequest,
  recordStorageFormat: LosslessTurnTapeStorageFormat,
): Promise<PreparedLosslessTurnTape | null> {
  return prepareLosslessTurnTapeOutsideLocksImpl(
    pool, userId, request, recordStorageFormat, PG_SESSIONS_DEPS,
  );
}

export function hydrateDirectTapePage(
  pool: Pool | PoolClient,
  sessionId: string,
  userId: string,
  tapeId: string,
  tapeSha256: string,
  billingAnchorId: string,
  heads: DirectTapePageHead[],
  extras?: { continuationOfTurnKey?: string | null },
): Promise<MessageLike[]> {
  return hydrateDirectTapePageImpl(
    pool, sessionId, userId, tapeId, tapeSha256, billingAnchorId, heads,
    { continuationOfTurnKey: extras?.continuationOfTurnKey },
  );
}

export function commitVisibleLosslessTurnPhaseA(
  pool: Pool,
  userId: string,
  request: LosslessTurnTapeFinalizeRequest | LosslessTurnTapeVisibleRequest,
  options: { enqueueMaterialization?: boolean } = {},
): Promise<LosslessTurnTapeFinalizeResult> {
  return commitVisibleLosslessTurnPhaseAImpl(pool, userId, request, PG_SESSIONS_DEPS, options);
}

export function createPgSessionsBackend(
  pool: Pool,
  options: PgSessionsBackendOptions,
): PgSessionsBackend {
  const ctx: PgSessionsCtx = {
    pool,
    options,
    expectedGeneration: options.expectedGeneration,
    finalizeSingleflight: _createFinalizeSingleflight<LosslessTurnTapeFinalizeResult>(),
    deps: PG_SESSIONS_DEPS,
  };
  const backend: PgSessionsBackend = {
    probeSessionsDb: () => probeSessionsDb(pool, ctx.expectedGeneration),
    ...createPgChatProjectsStore(ctx),
    ...createPgProjectAssetsStore(ctx),
    ...createPgWechatBindingsStore(ctx),
    ...createPgSessionClaimAndMetaStore(ctx),
    ...createPgSessionSearchAndBatchStore(ctx),
    ...createPgUsageAggregationStore(ctx),
    ...createPgSessionsGcStore(ctx),
    ...createPgAutoRecoveryStore(ctx),
    ...createPgDispatchAdmissionStore(ctx),
    ...createPgTurnTapeStageStore(ctx),
    ...createPgTurnTapePhaseAStore(ctx),
    ...createPgTurnTapeFinalizeStore(ctx),
    ...createPgEngineContextReader(ctx),
    ...createPgTimelinePageReader(ctx),
    ...createPgTapeRecordReader(ctx),
    ...createPgSessionReadAndArchiveStore(ctx),
  };
  return backend;
}

export { leftoverFramesToRecoveryRecords } from "./sessionRecoveryEvidence.js";
export type { HydratedRuntimeBatchDescriptor } from "./runtimeBatch.js";
export {
  _resetAutomaticRecoveryReconcileSkipsForTest,
  withTx,
  stageUsageCostLocatorInBillingTransaction,
  loadSettledUsageAttribution,
  loadUsageAttributionCredits,
  advanceClientTimelineIdentityInTransaction,
  escapeNulInSessionMessagesJson,
  notifyRecoveryJobTerminals,
  _createFinalizeSingleflight,
  _losslessFinalizeSingleflightKey,
  readCcbNativeRestoreArchive,
  userVisibleTapeRecord,
  _createPhysicalFinalizeAdmission,
  LOSSLESS_TURN_RECORD_STAGE_BATCH_SIZE,
  LOSSLESS_TURN_RECORD_STAGE_BATCH_BYTES,
  _setAfterLosslessStageBatch,
  _setPhaseASqlObserver,
  _losslessTurnRecordStageBatches,
  _losslessTurnRecordWriteChunks,
  _stagePreparedLosslessTurnRecords,
  listTurnTapeRecordsImpl,
  startSessionsGcSweeper,
  readClientSessionModelId,
  lookupLeaseCallbackSession,
};
export type {
  SettledUsageAttribution,
  AutomaticRecoveryDecision,
  PgSessionsBackendOptions,
  LosslessTurnTapeStageResult,
  LosslessTurnTapeFinalizeResult,
  LosslessTurnTapeStorage,
  AdmitUserTurnInput,
  AdmitUserTurnResult,
  TurnTapeDispatchState,
  TurnTapeStateResult,
  DispatchAdmissionBackend,
  PgSessionsBackend,
  HydratedTapeRow,
  LateDelegateRootDecision,
  TapeRecordPayload,
  TapeRecordPayloadChunk,
  SessionsGcSweeperOptions,
} from "./sessions/types.js";
export type { MessageLike };
