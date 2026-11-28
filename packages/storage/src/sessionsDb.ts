/**
 * Sessions storage facade (OCV5-928).
 *
 * Modularized into ./sessions/*.ts with zero circular dependencies. This facade
 * preserves 100% of the historical named export surface for callers and tests.
 */
import {
  type ClientSessionsBackend,
  getActiveBackend,
  setClientSessionsBackend,
  sqliteBackend,
} from './sessions/backendRegistry.js'
import type { AppendForRequestResult, MessageLike } from './sessions/types.js'

export { getActiveBackend, setClientSessionsBackend, type ClientSessionsBackend }
export type { UploadReferenceOptions } from './sessionUploadReferences.js'
export { closeSessionsDb, getSessionsDb } from './sessions/sqliteHandle.js'
export { listAutoDreamAuditSessions, listAutoDreamSuccessfulSessionsBetween, pruneAutoDreamSuccessEvents, recordAutoDreamSuccessfulSession, scanAutoDreamSuccessfulSessions } from './sessions/autoDreamStore.js'
export { cancelQueuedTurnDispatchExact, casTurnDispatchState, countRuntimeRecycleUnsafeTurnDispatches, getTurnDispatchByDispatchId, getTurnDispatchByLogicalKey, insertQueuedTurnDispatch, insertRejectedTombstoneIfAbsent, recordTurnDispatchRunning, scanOpenTurnDispatches, turnDispatchInboxStats } from './sessions/turnDispatchInbox.js'
export { getMaxTurnIdx, getUsageSummary, hasPersistedTurnActivity, indexTurn, insertEvent, insertUsageLog, loadSessionEvents, loadSessionTurns, loadSessionUsage, loadSessionUsageModels, pruneLocalObservability, pruneOrphanedSessionsFts, queryEvents, reserveTurnIndex, searchSessions, upsertSessionMeta } from './sessions/sidecarLogs.js'
export { _messageContentEqualForSeq, _warnSeqAnomaly, compareMessagesByOrder, deriveArchivedOrderSeqsForRead, deriveOrderSeqsForRead, hasInvisibleHistoryMutation, hasInvisibleMessageRemoval, normalizeAndAssignOrderSeqs, normalizeAndAssignSeqs } from './sessions/orderAndSeq.js'
export { _resetClientPutBlockedFieldCountsForTest, _stripClientPutMessage, _stripClientPutMessages, appendServerAuthoredPure, getClientPutBlockedFieldCounts, mergePreservingServerAuthored } from './sessions/mergeAndStrip.js'
export { _spillOverflowCore } from './sessions/clientSessionsWrite.js'
export { selectEngineContextSuffix } from './sessions/clientSessionsTimeline.js'
export { appendServerAuthoredMessageDurable, parseQueuedMessageLine, queueMessageToOutbox, queuedMessageToLine, replayMsgOutbox } from './sessions/msgOutbox.js'
export { ARCHIVE_CHUNK_MAX_BYTES, ARCHIVE_CHUNK_MAX_MSGS, CLIENT_SESSION_UNREAD_OUTCOMES, ClientTimelineCursorStaleError, LAST_D_TERMINAL_MS_SQL, LAST_MESSAGE_PREVIEW_MAX, LAST_MESSAGE_PREVIEW_TAIL_MAX, LAST_READ_AT_EPOCH_MS_FLOOR, LAST_READ_AT_MS_SQL, MAX_SESSION_BYTES, SESSION_LIST_LIMIT_MAX, SESSION_SEARCH_JSON_EXPAND_MAX_BYTES, SESSION_SEARCH_Q_MAX, SESSION_SOFT_TRIM_BYTES, SESSION_TAIL_MIN_MSGS, SESSION_TAIL_TARGET_BYTES, UNREAD_OUTCOME_SQL, decodeClientTimelineCursor, encodeClientTimelineCursor, escapeLikePattern, lastReadAtWatermarkMsSql, mapClientSessionLastOutcome, parseChatProjectCronJobIds, parseIncludeArchivedFlag, parseOptionalPositiveInt, toLastMessagePreview, toPlainSessionText } from './sessions/types.js'
export type { AppendCostCreditsResult, AppendForRequestResult, AutoDreamSuccessfulSession, ClientSession, ClientSessionCollabParent, ClientSessionLastOutcome, ClientSessionLifecycle, ClientSessionLifecycleRef, ClientSessionLifecycleState, ClientSessionLiveFramePage, ClientSessionMeta, ClientSessionPartial, ClientSessionReadOptions, ClientSessionRunState, ClientTimelineCursor, ClientTimelinePage, DrainDelegateCostResult, EngineContextReadOptions, EventLogEntry, ExactTurnDispatchIdentity, InsertUsageLogResult, ListClientSessionsOpts, ListClientSessionsResult, MessageLike, PatchServerAuthoredResult, QueuedMessage, ReadArchivedMessagesResult, SearchHit, ServerAuthoredAppendResult, SessionMeta, SpillOverflowResult, TurnDispatchInboxOutcome, TurnDispatchInboxRow, TurnDispatchInboxState, UpsertClientSessionResult, UsageAggregationGcStats, UsageLogEntry, UsageSummary, UsageTerminalStatus } from './sessions/types.js'
export { SEARCH_SNIPPET_MAX, SEARCH_SNIPPET_RADIUS, SESSION_BATCH_IDS_MAX, SESSION_SEARCH_JSON_CANDIDATE_MAX, SESSION_SEARCH_LIMIT_DEFAULT, SESSION_SEARCH_LIMIT_MAX, buildSearchSnippet, parseSessionBatchInput, rankSessionSearchHits, sqlProjectFilter } from './sessionsDbSidebar.js'
export type { BatchClientSessionsAction, BatchClientSessionsInput, BatchClientSessionsResult, BatchSessionCasRow, ClientSessionOwnership, MarkClientSessionReadResult, SearchClientSessionsOpts, SearchClientSessionsResult, SessionSearchHit, SessionSearchKind } from './sessionsDbSidebar.js'
export { CHAT_PROJECT_COLOR_MAX, CHAT_PROJECT_INSTRUCTIONS_MAX, CHAT_PROJECT_NAME_MAX, CHAT_PROJECT_PER_USER_LIMIT, CHAT_PROJECT_RESTORE_WINDOW_MS, CHAT_PROJECT_TEMPLATES, PROJECT_ASSET_CONTAINER_PREFIXES, PROJECT_ASSET_CONTROL_CHARS, PROJECT_ASSET_EXCERPT_MAX, PROJECT_ASSET_LIST_LIMIT_DEFAULT, PROJECT_ASSET_LIST_LIMIT_MAX, PROJECT_ASSET_MIME_MAX, PROJECT_ASSET_NAME_MAX, PROJECT_ASSET_PER_PROJECT_LIMIT, PROJECT_ASSET_PINNED_INJECT_MAX, PROJECT_ASSET_PROJECT_SEARCH_LIMIT_DEFAULT, PROJECT_ASSET_PROJECT_SEARCH_LIMIT_MAX, PROJECT_ASSET_PROJECT_SEARCH_QUERY_MAX, PROJECT_ASSET_SEARCH_LIMIT_DEFAULT, PROJECT_ASSET_SEARCH_LIMIT_MAX, PROJECT_ASSET_SEARCH_QUERY_MAX, PROJECT_ASSET_SESSION_ID_MAX, PROJECT_ASSET_URL_RE, PROJECT_ASSET_VERSION_GROUP_SQL, PROJECT_INSTRUCTIONS_INJECT_MAX, digestFromProjectAssetUrl, normalizeChatProjectAssetSearch, parseChatProjectName, parseChatProjectOptionalText, parseChatProjectSortOrder, parseChatProjectTemplate, parseDeletedManifest, parseProjectAssetCapturedAt, parseProjectAssetContainerPath, parseProjectAssetCreateInput, parseProjectAssetDigest, parseProjectAssetExcerpt, parseProjectAssetMime, parseProjectAssetName, parseProjectAssetOptionalContainerPath, parseProjectAssetProjectId, parseProjectAssetSessionId, parseProjectAssetSize, parseProjectAssetSource, parseProjectAssetUrl, sanitizeProjectInstructions, stripProjectAssetControlChars, withVersionCount } from './sessionsDbProjects.js'
export type { ChatProject, ChatProjectCreateError, ChatProjectCreateResult, ChatProjectDeleteError, ChatProjectDeleteResult, ChatProjectDeletedManifest, ChatProjectRestoreError, ChatProjectRestoreResult, ChatProjectRuntimeBind, ChatProjectTemplate, ChatProjectUpdateError, ChatProjectUpdateResult, ClientSessionMetaPatch, DeletedChatProject, ListProjectAssetsOpts, ParsedProjectAssetCreate, PatchClientSessionMetaResult, PinnedAssetsPage, ProjectAsset, ProjectAssetCreateError, ProjectAssetCreateInput, ProjectAssetCreateResult, ProjectAssetDeleteError, ProjectAssetDeleteResult, ProjectAssetSource, ProjectAssetUpdateError, ProjectAssetUpdateInput, ProjectAssetUpdateResult, SearchChatProjectAssetsOpts, SearchProjectAssetsOpts } from './sessionsDbProjects.js'
export { getLocalSkillUsageMap, recordLocalSkillSearchHits, recordLocalSkillView } from './skillUsageLocal.js'

// ── Public API: thin delegates to active backend (RFC D1) ──────────────────

export const scanRecentClientSessionMessages: ClientSessionsBackend['scanRecentClientSessionMessages'] =
  async (...args) => {
    if (
      process.env.OC_SESSIONS_STORE?.trim().toLowerCase() === 'pg' &&
      getActiveBackend() === sqliteBackend
    ) {
      return false
    }
    try {
      return await getActiveBackend().scanRecentClientSessionMessages(...args)
    } catch {
      return false
    }
  }

export const probeSessionsDb: ClientSessionsBackend['probeSessionsDb'] = () =>
  getActiveBackend().probeSessionsDb()
export const upsertClientSession: ClientSessionsBackend['upsertClientSession'] = (...args) =>
  getActiveBackend().upsertClientSession(...args)
export const appendServerAuthoredMessage: ClientSessionsBackend['appendServerAuthoredMessage'] = (
  ...args
) => getActiveBackend().appendServerAuthoredMessage(...args)
export const patchServerAuthoredMessage: ClientSessionsBackend['patchServerAuthoredMessage'] = (
  ...args
) => getActiveBackend().patchServerAuthoredMessage(...args)
export const appendServerAuthoredMessageForRequest: ClientSessionsBackend['appendServerAuthoredMessageForRequest'] =
  (...args) => getActiveBackend().appendServerAuthoredMessageForRequest(...args)

export async function appendServerAuthoredMessageDrainByUser<
  T extends MessageLike & { id: string },
>(
  sessId: string,
  userId: string,
  message: T,
  agentSessionId?: string | null,
): Promise<AppendForRequestResult> {
  return getActiveBackend().appendServerAuthoredMessageDrainByUser(
    sessId,
    userId,
    message,
    agentSessionId,
  )
}

export const appendCostCredits: ClientSessionsBackend['appendCostCredits'] = (...args) =>
  getActiveBackend().appendCostCredits(...args)
export const drainDelegateCostForClientSession: ClientSessionsBackend['drainDelegateCostForClientSession'] =
  (...args) => getActiveBackend().drainDelegateCostForClientSession(...args)
export const sweepUsageAggregationGc: ClientSessionsBackend['sweepUsageAggregationGc'] = (
  ...args
) => getActiveBackend().sweepUsageAggregationGc(...args)
export const listClientSessions: ClientSessionsBackend['listClientSessions'] = (...args) =>
  getActiveBackend().listClientSessions(...args)
export const getClientSession: ClientSessionsBackend['getClientSession'] = (...args) =>
  getActiveBackend().getClientSession(...args)
export const getClientSessionCollabParent: ClientSessionsBackend['getClientSessionCollabParent'] = (
  ...args
) => getActiveBackend().getClientSessionCollabParent(...args)
export const classifyClientSessions: ClientSessionsBackend['classifyClientSessions'] = (...args) =>
  getActiveBackend().classifyClientSessions(...args)
export const verifyClientSessionOwnership: ClientSessionsBackend['verifyClientSessionOwnership'] = (
  ...args
) => getActiveBackend().verifyClientSessionOwnership(...args)
export const getClientSessionPartial: ClientSessionsBackend['getClientSessionPartial'] = (
  ...args
) => getActiveBackend().getClientSessionPartial(...args)
export const readArchivedMessages: ClientSessionsBackend['readArchivedMessages'] = (...args) =>
  getActiveBackend().readArchivedMessages(...args)
export const readClientSessionLiveFrames: ClientSessionsBackend['readClientSessionLiveFrames'] = (
  ...args
) => getActiveBackend().readClientSessionLiveFrames(...args)
export const readClientSessionLiveUnits: ClientSessionsBackend['readClientSessionLiveUnits'] = (
  ...args
) => getActiveBackend().readClientSessionLiveUnits(...args)
export const readLiveOrTapeFramePayload: ClientSessionsBackend['readLiveOrTapeFramePayload'] = (
  ...args
) => getActiveBackend().readLiveOrTapeFramePayload(...args)
export const convergeFinalizedTapeLiveStreams: ClientSessionsBackend['convergeFinalizedTapeLiveStreams'] =
  (...args) => getActiveBackend().convergeFinalizedTapeLiveStreams(...args)
export const readClientTimelinePage: ClientSessionsBackend['readClientTimelinePage'] = (...args) =>
  getActiveBackend().readClientTimelinePage(...args)
export const getEngineContextMessages: ClientSessionsBackend['getEngineContextMessages'] = (
  ...args
) => getActiveBackend().getEngineContextMessages(...args)
export const hasCompletedClientTurn: ClientSessionsBackend['hasCompletedClientTurn'] = (...args) =>
  getActiveBackend().hasCompletedClientTurn(...args)
export const listTurnTapeRecords: ClientSessionsBackend['listTurnTapeRecords'] = (...args) =>
  getActiveBackend().listTurnTapeRecords(...args)
export const readTapeRecordPayload: ClientSessionsBackend['readTapeRecordPayload'] = (...args) =>
  getActiveBackend().readTapeRecordPayload(...args)
export const readTapeRecordPayloadChunk: ClientSessionsBackend['readTapeRecordPayloadChunk'] = (
  ...args
) => getActiveBackend().readTapeRecordPayloadChunk(...args)
export const readUserMessagePayload: ClientSessionsBackend['readUserMessagePayload'] = (...args) =>
  getActiveBackend().readUserMessagePayload(...args)
export const deleteClientSession: ClientSessionsBackend['deleteClientSession'] = (...args) =>
  getActiveBackend().deleteClientSession(...args)
export const renameClientSession: ClientSessionsBackend['renameClientSession'] = (...args) =>
  getActiveBackend().renameClientSession(...args)
export const setClientSessionModel: ClientSessionsBackend['setClientSessionModel'] = (...args) =>
  getActiveBackend().setClientSessionModel(...args)
export const patchClientSessionMeta: ClientSessionsBackend['patchClientSessionMeta'] = (...args) =>
  getActiveBackend().patchClientSessionMeta(...args)
export const searchClientSessions: ClientSessionsBackend['searchClientSessions'] = (...args) =>
  getActiveBackend().searchClientSessions(...args)
export const batchClientSessions: ClientSessionsBackend['batchClientSessions'] = (...args) =>
  getActiveBackend().batchClientSessions(...args)
export const markClientSessionRead: ClientSessionsBackend['markClientSessionRead'] = (...args) =>
  getActiveBackend().markClientSessionRead(...args)
export const markAllClientSessionsRead: ClientSessionsBackend['markAllClientSessionsRead'] = (
  ...args
) => getActiveBackend().markAllClientSessionsRead(...args)
export const getSessionProjectInstructions: ClientSessionsBackend['getSessionProjectInstructions'] =
  (...args) => getActiveBackend().getSessionProjectInstructions(...args)
export const getChatProjectBindBySessionId: ClientSessionsBackend['getChatProjectBindBySessionId'] =
  (...args) => getActiveBackend().getChatProjectBindBySessionId(...args)
export const getChatProjectBindByBoardProjectId: ClientSessionsBackend['getChatProjectBindByBoardProjectId'] =
  (...args) => getActiveBackend().getChatProjectBindByBoardProjectId(...args)
export const listPinnedProjectAssetsForChatProject: ClientSessionsBackend['listPinnedProjectAssetsForChatProject'] =
  (...args) => getActiveBackend().listPinnedProjectAssetsForChatProject(...args)
export const listChatProjects: ClientSessionsBackend['listChatProjects'] = (...args) =>
  getActiveBackend().listChatProjects(...args)
export const createChatProject: ClientSessionsBackend['createChatProject'] = (...args) =>
  getActiveBackend().createChatProject(...args)
export const updateChatProject: ClientSessionsBackend['updateChatProject'] = (...args) =>
  getActiveBackend().updateChatProject(...args)
export const deleteChatProject: ClientSessionsBackend['deleteChatProject'] = (...args) =>
  getActiveBackend().deleteChatProject(...args)
export const listDeletedChatProjects: ClientSessionsBackend['listDeletedChatProjects'] = (
  ...args
) => getActiveBackend().listDeletedChatProjects(...args)
export const restoreChatProject: ClientSessionsBackend['restoreChatProject'] = (...args) =>
  getActiveBackend().restoreChatProject(...args)
export const listProjectAssets: ClientSessionsBackend['listProjectAssets'] = (...args) =>
  getActiveBackend().listProjectAssets(...args)
export const searchProjectAssets: ClientSessionsBackend['searchProjectAssets'] = (...args) =>
  getActiveBackend().searchProjectAssets(...args)
export const listProjectAssetVersions: ClientSessionsBackend['listProjectAssetVersions'] = (
  ...args
) => getActiveBackend().listProjectAssetVersions(...args)
export const createProjectAsset: ClientSessionsBackend['createProjectAsset'] = (...args) =>
  getActiveBackend().createProjectAsset(...args)
export const updateProjectAsset: ClientSessionsBackend['updateProjectAsset'] = (...args) =>
  getActiveBackend().updateProjectAsset(...args)
export const deleteProjectAsset: ClientSessionsBackend['deleteProjectAsset'] = (...args) =>
  getActiveBackend().deleteProjectAsset(...args)
export const listPinnedProjectAssetsForSession: ClientSessionsBackend['listPinnedProjectAssetsForSession'] =
  (...args) => getActiveBackend().listPinnedProjectAssetsForSession(...args)
export const searchChatProjectAssets: ClientSessionsBackend['searchChatProjectAssets'] = (
  ...args
) => getActiveBackend().searchChatProjectAssets(...args)
export const bumpClientSessionHistoryRevision: ClientSessionsBackend['bumpClientSessionHistoryRevision'] =
  (...args) => getActiveBackend().bumpClientSessionHistoryRevision(...args)
export const listUnclaimedSessions: ClientSessionsBackend['listUnclaimedSessions'] = () =>
  getActiveBackend().listUnclaimedSessions()
export const allMasterWsessRows: ClientSessionsBackend['allMasterWsessRows'] = () =>
  getActiveBackend().allMasterWsessRows()
export const upsertMasterClientSession: ClientSessionsBackend['upsertMasterClientSession'] = (
  ...args
) => getActiveBackend().upsertMasterClientSession(...args)
export const softDeleteMasterSession: ClientSessionsBackend['softDeleteMasterSession'] = (
  ...args
) => getActiveBackend().softDeleteMasterSession(...args)
export const claimSession: ClientSessionsBackend['claimSession'] = (...args) =>
  getActiveBackend().claimSession(...args)
