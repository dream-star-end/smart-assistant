import type { Pool } from "pg";
import type {
  scanUploadReferenceRows,
  hydrateUploadReferenceMessages,
  UPLOAD_REFERENCE_MAX_BYTES,
  UPLOAD_REFERENCE_MAX_MS,
  UPLOAD_REFERENCE_MAX_ROWS,
  ClientTimelineCursorStaleError,
  CHAT_PROJECT_COLOR_MAX,
  CHAT_PROJECT_INSTRUCTIONS_MAX,
  CHAT_PROJECT_PER_USER_LIMIT,
  PROJECT_ASSET_LIST_LIMIT_DEFAULT,
  PROJECT_ASSET_LIST_LIMIT_MAX,
  PROJECT_ASSET_SEARCH_LIMIT_DEFAULT,
  PROJECT_ASSET_SEARCH_LIMIT_MAX,
  PROJECT_ASSET_SEARCH_QUERY_MAX,
  PROJECT_ASSET_PER_PROJECT_LIMIT,
  PROJECT_ASSET_PINNED_INJECT_MAX,
  PROJECT_ASSET_VERSION_GROUP_SQL,
  compareMessagesByOrder,
  deriveArchivedOrderSeqsForRead,
  deriveOrderSeqsForRead,
  MAX_SESSION_BYTES,
  hasInvisibleHistoryMutation,
  hasInvisibleMessageRemoval,
  mapClientSessionLastOutcome,
  mergePreservingServerAuthored,
  normalizeAndAssignOrderSeqs,
  normalizeAndAssignSeqs,
  _warnSeqAnomaly,
  buildSearchSnippet,
  escapeLikePattern,
  normalizeChatProjectAssetSearch,
  parseBoardProjectId,
  assetsRevision,
  parseChatProjectName,
  parseChatProjectOptionalText,
  parseChatProjectSortOrder,
  parseChatProjectTemplate,
  parseDeletedManifest,
  CHAT_PROJECT_RESTORE_WINDOW_MS,
  parseProjectAssetCreateInput,
  parseProjectAssetName,
  parseProjectAssetProjectId,
  withVersionCount,
  parseSessionBatchInput,
  rankSessionSearchHits,
  sanitizeProjectInstructions,
  LAST_MESSAGE_PREVIEW_TAIL_MAX,
  CLIENT_SESSION_UNREAD_OUTCOMES,
  lastReadAtWatermarkMsSql,
  SESSION_BATCH_IDS_MAX,
  SESSION_LIST_LIMIT_MAX,
  SESSION_SEARCH_JSON_CANDIDATE_MAX,
  SESSION_SEARCH_JSON_EXPAND_MAX_BYTES,
  SESSION_SEARCH_LIMIT_DEFAULT,
  SESSION_SEARCH_LIMIT_MAX,
  toLastMessagePreview,
  planAppendServerAuthored,
  planAppendServerAuthoredBatch,
  planReplaceServerAuthoredKeepingOrderSlots,
  planCostPatch,
  planDelegateCostMerge,
  planSpillOverflow,
  selectEngineContextSuffix,
  _stripClientPutMessages,
  WechatAccountAlreadyBoundError,
} from "@openclaude/storage";
import type {
  canonicalPublishedAgentGroupRecordFingerprint,
  computeGoalTokensUsed,
  isLosslessRuntimeBatchingEnabled,
  materializeLosslessTurn,
  materializeRootDomainAgentGroupRecord,
  parseLosslessTurnPayload,
} from "../../http/losslessTurnTape.js";
import type { bumpGoalUsageSnapshotForTape } from "../../goal/goalStateService.js";
import type { ensurePendingTurnWaiverInTransaction } from "../../billing/refund.js";
import type {
  lockTurnBillingKeys,
  lockTurnPersistenceKeys,
  numericCommercialUserId,
} from "../../billing/turnLock.js";
import type {
  recoverAdmissionAfterRestart,
  reconcileAdmissionRestarts,
} from "../../dispatch/admissionRestartRecovery.js";
import type {
  admitDispatch,
  casToManualReconcile,
  casToTerminal,
  getDispatch,
} from "../../dispatch/turnDispatchStore.js";
import type {
  bindRecoveryJobDispatch,
  enqueueAutomaticRecoveryJob,
  lockRecoveryRoot,
  pauseSilentRecoveryLineage,
  settleRecoveryJobForTape,
} from "../../dispatch/turnRecoveryStore.js";
import type {
  cancelPendingPermissionPromptsForTurn,
  readPermissionPromptSnapshot,
  readPermissionPromptsByRequestIds,
  serializePermissionPromptEntry,
  settleStopControlsForTurn,
} from "../../dispatch/turnControlStore.js";
import type {
  LosslessTurnTapeFinalizeResult,
  PgSessionsBackendOptions,
} from "./types.js";

/**
 * Injected runtime dependencies owned by the top-level `pgSessionsBackend.ts`
 * facade. Keeping value imports of `@openclaude/storage`, `billing/*`,
 * `dispatch/*`, `goal/*`, and `http/losslessTurnTape` in the facade preserves
 * the L2 architecture boundary with zero cross-layer violations in
 * `db/sessions/*.ts`.
 */
export interface PgSessionsDeps {
  storage: {
    scanUploadReferenceRows: typeof scanUploadReferenceRows;
    hydrateUploadReferenceMessages: typeof hydrateUploadReferenceMessages;
    UPLOAD_REFERENCE_MAX_BYTES: typeof UPLOAD_REFERENCE_MAX_BYTES;
    UPLOAD_REFERENCE_MAX_MS: typeof UPLOAD_REFERENCE_MAX_MS;
    UPLOAD_REFERENCE_MAX_ROWS: typeof UPLOAD_REFERENCE_MAX_ROWS;
    ClientTimelineCursorStaleError: typeof ClientTimelineCursorStaleError;
    CHAT_PROJECT_COLOR_MAX: typeof CHAT_PROJECT_COLOR_MAX;
    CHAT_PROJECT_INSTRUCTIONS_MAX: typeof CHAT_PROJECT_INSTRUCTIONS_MAX;
    CHAT_PROJECT_PER_USER_LIMIT: typeof CHAT_PROJECT_PER_USER_LIMIT;
    PROJECT_ASSET_LIST_LIMIT_DEFAULT: typeof PROJECT_ASSET_LIST_LIMIT_DEFAULT;
    PROJECT_ASSET_LIST_LIMIT_MAX: typeof PROJECT_ASSET_LIST_LIMIT_MAX;
    PROJECT_ASSET_SEARCH_LIMIT_DEFAULT: typeof PROJECT_ASSET_SEARCH_LIMIT_DEFAULT;
    PROJECT_ASSET_SEARCH_LIMIT_MAX: typeof PROJECT_ASSET_SEARCH_LIMIT_MAX;
    PROJECT_ASSET_SEARCH_QUERY_MAX: typeof PROJECT_ASSET_SEARCH_QUERY_MAX;
    PROJECT_ASSET_PER_PROJECT_LIMIT: typeof PROJECT_ASSET_PER_PROJECT_LIMIT;
    PROJECT_ASSET_PINNED_INJECT_MAX: typeof PROJECT_ASSET_PINNED_INJECT_MAX;
    PROJECT_ASSET_VERSION_GROUP_SQL: typeof PROJECT_ASSET_VERSION_GROUP_SQL;
    compareMessagesByOrder: typeof compareMessagesByOrder;
    deriveArchivedOrderSeqsForRead: typeof deriveArchivedOrderSeqsForRead;
    deriveOrderSeqsForRead: typeof deriveOrderSeqsForRead;
    MAX_SESSION_BYTES: typeof MAX_SESSION_BYTES;
    hasInvisibleHistoryMutation: typeof hasInvisibleHistoryMutation;
    hasInvisibleMessageRemoval: typeof hasInvisibleMessageRemoval;
    mapClientSessionLastOutcome: typeof mapClientSessionLastOutcome;
    mergePreservingServerAuthored: typeof mergePreservingServerAuthored;
    normalizeAndAssignOrderSeqs: typeof normalizeAndAssignOrderSeqs;
    normalizeAndAssignSeqs: typeof normalizeAndAssignSeqs;
    _warnSeqAnomaly: typeof _warnSeqAnomaly;
    buildSearchSnippet: typeof buildSearchSnippet;
    escapeLikePattern: typeof escapeLikePattern;
    normalizeChatProjectAssetSearch: typeof normalizeChatProjectAssetSearch;
    parseBoardProjectId: typeof parseBoardProjectId;
    assetsRevision: typeof assetsRevision;
    parseChatProjectName: typeof parseChatProjectName;
    parseChatProjectOptionalText: typeof parseChatProjectOptionalText;
    parseChatProjectSortOrder: typeof parseChatProjectSortOrder;
    parseChatProjectTemplate: typeof parseChatProjectTemplate;
    parseDeletedManifest: typeof parseDeletedManifest;
    CHAT_PROJECT_RESTORE_WINDOW_MS: typeof CHAT_PROJECT_RESTORE_WINDOW_MS;
    parseProjectAssetCreateInput: typeof parseProjectAssetCreateInput;
    parseProjectAssetName: typeof parseProjectAssetName;
    parseProjectAssetProjectId: typeof parseProjectAssetProjectId;
    withVersionCount: typeof withVersionCount;
    parseSessionBatchInput: typeof parseSessionBatchInput;
    rankSessionSearchHits: typeof rankSessionSearchHits;
    sanitizeProjectInstructions: typeof sanitizeProjectInstructions;
    LAST_MESSAGE_PREVIEW_TAIL_MAX: typeof LAST_MESSAGE_PREVIEW_TAIL_MAX;
    CLIENT_SESSION_UNREAD_OUTCOMES: typeof CLIENT_SESSION_UNREAD_OUTCOMES;
    lastReadAtWatermarkMsSql: typeof lastReadAtWatermarkMsSql;
    SESSION_BATCH_IDS_MAX: typeof SESSION_BATCH_IDS_MAX;
    SESSION_LIST_LIMIT_MAX: typeof SESSION_LIST_LIMIT_MAX;
    SESSION_SEARCH_JSON_CANDIDATE_MAX: typeof SESSION_SEARCH_JSON_CANDIDATE_MAX;
    SESSION_SEARCH_JSON_EXPAND_MAX_BYTES: typeof SESSION_SEARCH_JSON_EXPAND_MAX_BYTES;
    SESSION_SEARCH_LIMIT_DEFAULT: typeof SESSION_SEARCH_LIMIT_DEFAULT;
    SESSION_SEARCH_LIMIT_MAX: typeof SESSION_SEARCH_LIMIT_MAX;
    toLastMessagePreview: typeof toLastMessagePreview;
    planAppendServerAuthored: typeof planAppendServerAuthored;
    planAppendServerAuthoredBatch: typeof planAppendServerAuthoredBatch;
    planReplaceServerAuthoredKeepingOrderSlots: typeof planReplaceServerAuthoredKeepingOrderSlots;
    planCostPatch: typeof planCostPatch;
    planDelegateCostMerge: typeof planDelegateCostMerge;
    planSpillOverflow: typeof planSpillOverflow;
    selectEngineContextSuffix: typeof selectEngineContextSuffix;
    _stripClientPutMessages: typeof _stripClientPutMessages;
    WechatAccountAlreadyBoundError: typeof WechatAccountAlreadyBoundError;
  };
  lossless: {
    canonicalPublishedAgentGroupRecordFingerprint: typeof canonicalPublishedAgentGroupRecordFingerprint;
    computeGoalTokensUsed: typeof computeGoalTokensUsed;
    isLosslessRuntimeBatchingEnabled: typeof isLosslessRuntimeBatchingEnabled;
    materializeLosslessTurn: typeof materializeLosslessTurn;
    materializeRootDomainAgentGroupRecord: typeof materializeRootDomainAgentGroupRecord;
    parseLosslessTurnPayload: typeof parseLosslessTurnPayload;
  };
  goal: {
    bumpGoalUsageSnapshotForTape: typeof bumpGoalUsageSnapshotForTape;
  };
  billing: {
    ensurePendingTurnWaiverInTransaction: typeof ensurePendingTurnWaiverInTransaction;
    lockTurnBillingKeys: typeof lockTurnBillingKeys;
    lockTurnPersistenceKeys: typeof lockTurnPersistenceKeys;
    numericCommercialUserId: typeof numericCommercialUserId;
  };
  dispatch: {
    recoverAdmissionAfterRestart: typeof recoverAdmissionAfterRestart;
    reconcileAdmissionRestarts: typeof reconcileAdmissionRestarts;
    admitDispatch: typeof admitDispatch;
    casToManualReconcile: typeof casToManualReconcile;
    casToTerminal: typeof casToTerminal;
    getDispatch: typeof getDispatch;
    bindRecoveryJobDispatch: typeof bindRecoveryJobDispatch;
    enqueueAutomaticRecoveryJob: typeof enqueueAutomaticRecoveryJob;
    lockRecoveryRoot: typeof lockRecoveryRoot;
    pauseSilentRecoveryLineage: typeof pauseSilentRecoveryLineage;
    settleRecoveryJobForTape: typeof settleRecoveryJobForTape;
    cancelPendingPermissionPromptsForTurn: typeof cancelPendingPermissionPromptsForTurn;
    readPermissionPromptSnapshot: typeof readPermissionPromptSnapshot;
    readPermissionPromptsByRequestIds: typeof readPermissionPromptsByRequestIds;
    serializePermissionPromptEntry: typeof serializePermissionPromptEntry;
    settleStopControlsForTurn: typeof settleStopControlsForTurn;
  };
  usesNativeFiniteContextEngine: (engine: string | undefined) => boolean;
  continuationOwnerSqlCol: string;
  headerContinuationExtras: (
    header: { continuationOfTurnKey: string | null },
  ) => { continuationOfTurnKey: string | null };
}

export interface PgSessionsCtx {
  pool: Pool;
  options: PgSessionsBackendOptions;
  expectedGeneration: number;
  finalizeSingleflight: (
    key: string,
    run: () => Promise<LosslessTurnTapeFinalizeResult>,
  ) => { promise: Promise<LosslessTurnTapeFinalizeResult>; shared: boolean };
  deps: PgSessionsDeps;
}
