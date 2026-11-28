import {
  _sqliteCreateChatProject,
  _sqliteCreateProjectAsset,
  _sqliteDeleteChatProject,
  _sqliteDeleteProjectAsset,
  _sqliteGetChatProjectBindByBoardProjectId,
  _sqliteGetChatProjectBindBySessionId,
  _sqliteGetSessionProjectInstructions,
  _sqliteListChatProjects,
  _sqliteListDeletedChatProjects,
  _sqliteListPinnedProjectAssetsForChatProject,
  _sqliteListPinnedProjectAssetsForSession,
  _sqliteListProjectAssets,
  _sqliteListProjectAssetVersions,
  _sqlitePatchClientSessionMeta,
  _sqliteRestoreChatProject,
  _sqliteSearchChatProjectAssets,
  _sqliteSearchProjectAssets,
  _sqliteUpdateChatProject,
  _sqliteUpdateProjectAsset,
} from '../sessionsDbProjects.js'
import {
  _sqliteBatchClientSessions,
  _sqliteMarkAllClientSessionsRead,
  _sqliteMarkClientSessionRead,
  _sqliteSearchClientSessions,
  _sqliteVerifyClientSessionOwnership,
} from '../sessionsDbSidebar.js'
import {
  _sqliteAllMasterWsessRows,
  _sqliteClassifyClientSessions,
  _sqliteGetClientSession,
  _sqliteGetClientSessionCollabParent,
  _sqliteGetClientSessionPartial,
  _sqliteListClientSessions,
  _sqliteListUnclaimedSessions,
  _sqliteScanRecentClientSessionMessages,
} from './clientSessionsRead.js'
import {
  _sqliteConvergeFinalizedTapeLiveStreams,
  _sqliteGetEngineContextMessages,
  _sqliteHasCompletedClientTurn,
  _sqliteListTurnTapeRecords,
  _sqliteReadArchivedMessages,
  _sqliteReadClientSessionLiveFrames,
  _sqliteReadClientSessionLiveUnits,
  _sqliteReadClientTimelinePage,
  _sqliteReadLiveOrTapeFramePayload,
  _sqliteReadTapeRecordPayload,
  _sqliteReadTapeRecordPayloadChunk,
  _sqliteReadUserMessagePayload,
} from './clientSessionsTimeline.js'
import {
  _sqliteAppendServerAuthoredMessage,
  _sqliteBumpClientSessionHistoryRevision,
  _sqliteClaimSession,
  _sqliteDeleteClientSession,
  _sqlitePatchServerAuthoredMessage,
  _sqliteRenameClientSession,
  _sqliteSetClientSessionModel,
  _sqliteSoftDeleteMasterSession,
  _sqliteUpsertClientSession,
  _sqliteUpsertMasterClientSession,
} from './clientSessionsWrite.js'
import { _sqliteProbeSessionsDb } from './sqliteHandle.js'
import {
  _sqliteAppendCostCredits,
  _sqliteAppendServerAuthoredMessageDrainByUser,
  _sqliteAppendServerAuthoredMessageForRequest,
  _sqliteDrainDelegateCostForClientSession,
  _sqliteSweepUsageAggregationGc,
} from './usageAggregation.js'
import {
  _sqliteDeleteWechatBinding,
  _sqliteGetWechatBindingByAccountId,
  _sqliteGetWechatBindingByUserId,
  _sqliteListActiveWechatBindings,
  _sqliteListAllWechatBindings,
  _sqliteUpdateWechatBindingCursor,
  _sqliteUpdateWechatBindingStatus,
  _sqliteUpsertWechatBinding,
} from './wechatBindingsSqlite.js'

export const sqliteBackend = {
  scanRecentClientSessionMessages: _sqliteScanRecentClientSessionMessages,
  probeSessionsDb: _sqliteProbeSessionsDb,
  upsertClientSession: _sqliteUpsertClientSession,
  appendServerAuthoredMessage: _sqliteAppendServerAuthoredMessage,
  patchServerAuthoredMessage: _sqlitePatchServerAuthoredMessage,
  appendServerAuthoredMessageForRequest: _sqliteAppendServerAuthoredMessageForRequest,
  appendServerAuthoredMessageDrainByUser: _sqliteAppendServerAuthoredMessageDrainByUser,
  appendCostCredits: _sqliteAppendCostCredits,
  drainDelegateCostForClientSession: _sqliteDrainDelegateCostForClientSession,
  sweepUsageAggregationGc: _sqliteSweepUsageAggregationGc,
  listClientSessions: _sqliteListClientSessions,
  getClientSession: _sqliteGetClientSession,
  getClientSessionCollabParent: _sqliteGetClientSessionCollabParent,
  classifyClientSessions: _sqliteClassifyClientSessions,
  verifyClientSessionOwnership: _sqliteVerifyClientSessionOwnership,
  getClientSessionPartial: _sqliteGetClientSessionPartial,
  readArchivedMessages: _sqliteReadArchivedMessages,
  readClientSessionLiveFrames: _sqliteReadClientSessionLiveFrames,
  readClientSessionLiveUnits: _sqliteReadClientSessionLiveUnits,
  readLiveOrTapeFramePayload: _sqliteReadLiveOrTapeFramePayload,
  convergeFinalizedTapeLiveStreams: _sqliteConvergeFinalizedTapeLiveStreams,
  readClientTimelinePage: _sqliteReadClientTimelinePage,
  getEngineContextMessages: _sqliteGetEngineContextMessages,
  hasCompletedClientTurn: _sqliteHasCompletedClientTurn,
  listTurnTapeRecords: _sqliteListTurnTapeRecords,
  readTapeRecordPayload: _sqliteReadTapeRecordPayload,
  readTapeRecordPayloadChunk: _sqliteReadTapeRecordPayloadChunk,
  readUserMessagePayload: _sqliteReadUserMessagePayload,
  deleteClientSession: _sqliteDeleteClientSession,
  renameClientSession: _sqliteRenameClientSession,
  setClientSessionModel: _sqliteSetClientSessionModel,
  patchClientSessionMeta: _sqlitePatchClientSessionMeta,
  searchClientSessions: _sqliteSearchClientSessions,
  batchClientSessions: _sqliteBatchClientSessions,
  markClientSessionRead: _sqliteMarkClientSessionRead,
  markAllClientSessionsRead: _sqliteMarkAllClientSessionsRead,
  getSessionProjectInstructions: _sqliteGetSessionProjectInstructions,
  getChatProjectBindBySessionId: _sqliteGetChatProjectBindBySessionId,
  getChatProjectBindByBoardProjectId: _sqliteGetChatProjectBindByBoardProjectId,
  listPinnedProjectAssetsForChatProject: _sqliteListPinnedProjectAssetsForChatProject,
  listChatProjects: _sqliteListChatProjects,
  createChatProject: _sqliteCreateChatProject,
  updateChatProject: _sqliteUpdateChatProject,
  deleteChatProject: _sqliteDeleteChatProject,
  listDeletedChatProjects: _sqliteListDeletedChatProjects,
  restoreChatProject: _sqliteRestoreChatProject,
  listProjectAssets: _sqliteListProjectAssets,
  searchProjectAssets: _sqliteSearchProjectAssets,
  listProjectAssetVersions: _sqliteListProjectAssetVersions,
  createProjectAsset: _sqliteCreateProjectAsset,
  updateProjectAsset: _sqliteUpdateProjectAsset,
  deleteProjectAsset: _sqliteDeleteProjectAsset,
  listPinnedProjectAssetsForSession: _sqliteListPinnedProjectAssetsForSession,
  searchChatProjectAssets: _sqliteSearchChatProjectAssets,
  bumpClientSessionHistoryRevision: _sqliteBumpClientSessionHistoryRevision,
  listUnclaimedSessions: _sqliteListUnclaimedSessions,
  allMasterWsessRows: _sqliteAllMasterWsessRows,
  upsertMasterClientSession: _sqliteUpsertMasterClientSession,
  softDeleteMasterSession: _sqliteSoftDeleteMasterSession,
  claimSession: _sqliteClaimSession,
  listActiveWechatBindings: _sqliteListActiveWechatBindings,
  listAllWechatBindings: _sqliteListAllWechatBindings,
  getWechatBindingByUserId: _sqliteGetWechatBindingByUserId,
  getWechatBindingByAccountId: _sqliteGetWechatBindingByAccountId,
  upsertWechatBinding: _sqliteUpsertWechatBinding,
  updateWechatBindingCursor: _sqliteUpdateWechatBindingCursor,
  updateWechatBindingStatus: _sqliteUpdateWechatBindingStatus,
  deleteWechatBinding: _sqliteDeleteWechatBinding,
}

export type ClientSessionsBackend = typeof sqliteBackend

let _activeBackend: ClientSessionsBackend = sqliteBackend
let _backendInjected = false

export function setClientSessionsBackend(b: ClientSessionsBackend): void {
  if (_backendInjected) {
    throw new Error('client sessions backend already injected — 一次性注入,禁止双跑')
  }
  _activeBackend = b
  _backendInjected = true
}

export function getActiveBackend(): ClientSessionsBackend {
  return _activeBackend
}
