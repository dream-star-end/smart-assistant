export { IdleRecoveryCorrupt, filterAbandonedIdleRows, idleSyntheticUuid, readIdleRollbacks, writeIdleRollback } from './idleRollback.js'
export type { IdleRollback } from './idleRollback.js'
export { withIdleNativeLock } from './idleNativeLock.js'
export { HOME, paths } from './paths.js'
export { isMarketplacePersonaTarget, readAgentsConfig, readConfig, updateAgentsConfig, updateConfig, writeAgentsConfig, writeConfig } from './config.js'
export type { AgentDef, AgentsConfig, McpServerConfig, OpenClaudeConfig, RouteRule, ToolsetDefs, ToolsetName, UserEntry } from './config.js'
export { IDENTITY_COMPAT_SOUL_END, IDENTITY_COMPAT_SOUL_START, IdentityAssetsError, assertIdentityCompatExecution, isIdentityAssetsError, resolveIdentityCompatAssets } from './identityCompatAssets.js'
export type { IdentityAssetsErrorCode, IdentityCompatAssets, IdentityCompatSoul, IdentityCompatSoulSegments, IdentityPermissionMode } from './identityCompatAssets.js'
export { JsonlLog } from './jsonl.js'
export { readCredential, saveCredential } from './credentials.js'
export { acquireFileLock, acquireUserLock, scanMemoryContent } from './memoryShared.js'
export type { ScanResult } from './memoryShared.js'
export { acquireKernelFileLock } from './kernelFileLock.js'
export type { KernelFileLock, KernelFileLockDeps, KernelFileLockMode } from './kernelFileLock.js'
export { AUTO_MEMORY_SOURCE, AUTO_MEMORY_TTL_DAYS, MEMORY_EXPIRES_RE, PROJECT_AUTO_MEMORY_TTL_DAYS, addCalendarDays, defaultAutoExpires, defaultProjectAutoExpires, isMemoryExpired, memoryCalendarDate, parseMemoryExpires } from './memoryTtl.js'
export type { MemoryTtlWarn } from './memoryTtl.js'
export { CORE_COVERAGE_NUMERATOR, coreQueryTerms, coverageAtLeastHalf, isStrongLexicalDocument, tokenizeCoreMemory } from './memoryLexical.js'
export { FORBIDDEN_AUTO_MEMORY_BASENAMES, assertValidAutoMemoryFile, collectIndexContentLines, existingIndexLinesPreserved, isForbiddenAutoMemoryTarget, stampAutoMemoryFrontmatter } from './autoMemoryWrite.js'
export type { AutoMemoryCreate, AutoMemorySkip, AutoMemorySkipReason, StampAutoMemoryOptions } from './autoMemoryWrite.js'
export { findStrongLexicalMemory } from './memoryDedup.js'
export type { StrongLexicalHit, StrongLexicalProbe } from './memoryDedup.js'
export { MEMDIR_INDEX_MARKER, MEMORY_FILE_RE, MEMORY_HARD_LIMIT_BYTES, MEMORY_SOFT_WARN_BYTES, MemoryBarrierTimeoutError, MemoryBoundaryError, MemoryDir, createMemoryDirForAgentDir, parseMemoryFrontmatter } from './memoryDir.js'
export type { CompactMemoryIndexOptions, CompactMemoryIndexResult, CoreMemoryPaths, ExclusiveMemoryLockOptions, MemoryAutoAddResult, MemoryBatchDelete, MemoryBatchResult, MemoryBatchUpsert, MemoryFileMeta, MemorySharedBarrierOptions, MemoryType, MemoryWriteOptions, RemoveIfVersionResult, WriteResult } from './memoryDir.js'
export { CURSOR_EPHEMERAL_HOME_RE, DEFAULT_MEMORY_SEARCH_POLICY, MANAGED_AGENT_OPENCLAUDE_HOME, MEMORY_TURN_POLICY_REFRESH_MS, MEMORY_TURN_POLICY_TTL_MS, classifyMemoryTurnPolicy, clearMemoryTurnPolicy, inheritMemoryTurnPolicy, isManagedAgentRuntime, readMemoryTurnPolicy, resolveMemoryTurnPolicyRoot, writeMemoryTurnPolicy } from './memoryTurnPolicy.js'
export type { MemoryTurnPolicyDecision, MemoryTurnPolicyReason } from './memoryTurnPolicy.js'
export { profileSnapshot, readUserProfile, writeUserProfile, writeUserProfileAt } from './userProfile.js'
export type { UserProfileSnapshot } from './userProfile.js'
export { ARCHIVE_CHUNK_MAX_BYTES, ARCHIVE_CHUNK_MAX_MSGS, CHAT_PROJECT_COLOR_MAX, CHAT_PROJECT_INSTRUCTIONS_MAX, CHAT_PROJECT_NAME_MAX, CHAT_PROJECT_PER_USER_LIMIT, CHAT_PROJECT_RESTORE_WINDOW_MS, CHAT_PROJECT_TEMPLATES, CLIENT_SESSION_UNREAD_OUTCOMES, ClientTimelineCursorStaleError, LAST_D_TERMINAL_MS_SQL, LAST_MESSAGE_PREVIEW_MAX, LAST_MESSAGE_PREVIEW_TAIL_MAX, LAST_READ_AT_EPOCH_MS_FLOOR, LAST_READ_AT_MS_SQL, MAX_SESSION_BYTES, PROJECT_ASSET_CONTAINER_PREFIXES, PROJECT_ASSET_CONTROL_CHARS, PROJECT_ASSET_EXCERPT_MAX, PROJECT_ASSET_LIST_LIMIT_DEFAULT, PROJECT_ASSET_LIST_LIMIT_MAX, PROJECT_ASSET_MIME_MAX, PROJECT_ASSET_NAME_MAX, PROJECT_ASSET_PER_PROJECT_LIMIT, PROJECT_ASSET_PINNED_INJECT_MAX, PROJECT_ASSET_PROJECT_SEARCH_LIMIT_DEFAULT, PROJECT_ASSET_PROJECT_SEARCH_LIMIT_MAX, PROJECT_ASSET_PROJECT_SEARCH_QUERY_MAX, PROJECT_ASSET_SEARCH_LIMIT_DEFAULT, PROJECT_ASSET_SEARCH_LIMIT_MAX, PROJECT_ASSET_SEARCH_QUERY_MAX, PROJECT_ASSET_SESSION_ID_MAX, PROJECT_ASSET_URL_RE, PROJECT_ASSET_VERSION_GROUP_SQL, PROJECT_INSTRUCTIONS_INJECT_MAX, SEARCH_SNIPPET_MAX, SEARCH_SNIPPET_RADIUS, SESSION_BATCH_IDS_MAX, SESSION_LIST_LIMIT_MAX, SESSION_SEARCH_JSON_CANDIDATE_MAX, SESSION_SEARCH_JSON_EXPAND_MAX_BYTES, SESSION_SEARCH_LIMIT_DEFAULT, SESSION_SEARCH_LIMIT_MAX, SESSION_SEARCH_Q_MAX, SESSION_SOFT_TRIM_BYTES, SESSION_TAIL_MIN_MSGS, SESSION_TAIL_TARGET_BYTES, UNREAD_OUTCOME_SQL, _messageContentEqualForSeq, _resetClientPutBlockedFieldCountsForTest, _spillOverflowCore, _stripClientPutMessage, _stripClientPutMessages, _warnSeqAnomaly, allMasterWsessRows, appendCostCredits, appendServerAuthoredMessage, appendServerAuthoredMessageDrainByUser, appendServerAuthoredMessageDurable, appendServerAuthoredMessageForRequest, appendServerAuthoredPure, batchClientSessions, buildSearchSnippet, bumpClientSessionHistoryRevision, cancelQueuedTurnDispatchExact, casTurnDispatchState, claimSession, classifyClientSessions, closeSessionsDb, compareMessagesByOrder, convergeFinalizedTapeLiveStreams, countRuntimeRecycleUnsafeTurnDispatches, createChatProject, createProjectAsset, decodeClientTimelineCursor, deleteChatProject, deleteClientSession, deleteProjectAsset, deriveArchivedOrderSeqsForRead, deriveOrderSeqsForRead, digestFromProjectAssetUrl, drainDelegateCostForClientSession, encodeClientTimelineCursor, escapeLikePattern, getActiveBackend, getChatProjectBindByBoardProjectId, getChatProjectBindBySessionId, getClientPutBlockedFieldCounts, getClientSession, getClientSessionCollabParent, getClientSessionPartial, getEngineContextMessages, getLocalSkillUsageMap, getMaxTurnIdx, getSessionProjectInstructions, getSessionsDb, getTurnDispatchByDispatchId, getTurnDispatchByLogicalKey, getUsageSummary, hasCompletedClientTurn, hasInvisibleHistoryMutation, hasInvisibleMessageRemoval, hasPersistedTurnActivity, indexTurn, insertEvent, insertQueuedTurnDispatch, insertRejectedTombstoneIfAbsent, insertUsageLog, lastReadAtWatermarkMsSql, listAutoDreamAuditSessions, listAutoDreamSuccessfulSessionsBetween, listChatProjects, listClientSessions, listDeletedChatProjects, listPinnedProjectAssetsForChatProject, listPinnedProjectAssetsForSession, listProjectAssetVersions, listProjectAssets, listTurnTapeRecords, listUnclaimedSessions, loadSessionEvents, loadSessionTurns, loadSessionUsage, loadSessionUsageModels, mapClientSessionLastOutcome, markAllClientSessionsRead, markClientSessionRead, mergePreservingServerAuthored, normalizeAndAssignOrderSeqs, normalizeAndAssignSeqs, normalizeChatProjectAssetSearch, parseChatProjectCronJobIds, parseChatProjectName, parseChatProjectOptionalText, parseChatProjectSortOrder, parseChatProjectTemplate, parseDeletedManifest, parseIncludeArchivedFlag, parseOptionalPositiveInt, parseProjectAssetCapturedAt, parseProjectAssetContainerPath, parseProjectAssetCreateInput, parseProjectAssetDigest, parseProjectAssetExcerpt, parseProjectAssetMime, parseProjectAssetName, parseProjectAssetOptionalContainerPath, parseProjectAssetProjectId, parseProjectAssetSessionId, parseProjectAssetSize, parseProjectAssetSource, parseProjectAssetUrl, parseQueuedMessageLine, parseSessionBatchInput, patchClientSessionMeta, patchServerAuthoredMessage, probeSessionsDb, pruneAutoDreamSuccessEvents, pruneLocalObservability, pruneOrphanedSessionsFts, queryEvents, queueMessageToOutbox, queuedMessageToLine, rankSessionSearchHits, readArchivedMessages, readClientSessionLiveFrames, readClientSessionLiveUnits, readClientTimelinePage, readLiveOrTapeFramePayload, readTapeRecordPayload, readTapeRecordPayloadChunk, readUserMessagePayload, recordAutoDreamSuccessfulSession, recordLocalSkillSearchHits, recordLocalSkillView, recordTurnDispatchRunning, renameClientSession, replayMsgOutbox, reserveTurnIndex, restoreChatProject, sanitizeProjectInstructions, scanAutoDreamSuccessfulSessions, scanOpenTurnDispatches, scanRecentClientSessionMessages, searchChatProjectAssets, searchClientSessions, searchProjectAssets, searchSessions, selectEngineContextSuffix, setClientSessionModel, setClientSessionsBackend, softDeleteMasterSession, sqlProjectFilter, stripProjectAssetControlChars, sweepUsageAggregationGc, toLastMessagePreview, toPlainSessionText, turnDispatchInboxStats, updateChatProject, updateProjectAsset, upsertClientSession, upsertMasterClientSession, upsertSessionMeta, verifyClientSessionOwnership, withVersionCount } from './sessionsDb.js'
export type { AppendCostCreditsResult, AppendForRequestResult, AutoDreamSuccessfulSession, BatchClientSessionsAction, BatchClientSessionsInput, BatchClientSessionsResult, BatchSessionCasRow, ChatProject, ChatProjectCreateError, ChatProjectCreateResult, ChatProjectDeleteError, ChatProjectDeleteResult, ChatProjectDeletedManifest, ChatProjectRestoreError, ChatProjectRestoreResult, ChatProjectRuntimeBind, ChatProjectTemplate, ChatProjectUpdateError, ChatProjectUpdateResult, ClientSession, ClientSessionCollabParent, ClientSessionLastOutcome, ClientSessionLifecycle, ClientSessionLifecycleRef, ClientSessionLifecycleState, ClientSessionLiveFramePage, ClientSessionMeta, ClientSessionMetaPatch, ClientSessionOwnership, ClientSessionPartial, ClientSessionReadOptions, ClientSessionRunState, ClientSessionsBackend, ClientTimelineCursor, ClientTimelinePage, DeletedChatProject, DrainDelegateCostResult, EngineContextReadOptions, EventLogEntry, ExactTurnDispatchIdentity, InsertUsageLogResult, ListClientSessionsOpts, ListClientSessionsResult, ListProjectAssetsOpts, MarkClientSessionReadResult, MessageLike, ParsedProjectAssetCreate, PatchClientSessionMetaResult, PatchServerAuthoredResult, PinnedAssetsPage, ProjectAsset, ProjectAssetCreateError, ProjectAssetCreateInput, ProjectAssetCreateResult, ProjectAssetDeleteError, ProjectAssetDeleteResult, ProjectAssetSource, ProjectAssetUpdateError, ProjectAssetUpdateInput, ProjectAssetUpdateResult, QueuedMessage, ReadArchivedMessagesResult, SearchChatProjectAssetsOpts, SearchClientSessionsOpts, SearchClientSessionsResult, SearchHit, SearchProjectAssetsOpts, ServerAuthoredAppendResult, SessionMeta, SessionSearchHit, SessionSearchKind, SpillOverflowResult, TurnDispatchInboxOutcome, TurnDispatchInboxRow, TurnDispatchInboxState, UploadReferenceOptions, UpsertClientSessionResult, UsageAggregationGcStats, UsageLogEntry, UsageSummary, UsageTerminalStatus } from './sessionsDb.js'
export { RECOVERY_CONTINUATION_PREFIXES, _memoryUsageInternals, beginMemoryTurnObservation, classifyCurrentFactIntent, completeMemoryTurnObservation, currentReservedTurnIndex, getMemoryUsageDashboard, listPendingMemoryUsageEvents, markMemoryTurnEvidence, markMemoryUsageEventsReported, pruneMemoryUsage, recordMemoryUsageEvent, stripSystemInjectedPrefix } from './memoryUsage.js'
export type { MemoryRetrievalMode, MemoryUsageDashboard, MemoryUsageEventInput, MemoryUsageEventRow, MemoryUsageOperation, MemoryUsageOutcome, MemoryUsageType } from './memoryUsage.js'
export { planAppendServerAuthored, planAppendServerAuthoredBatch, planCostPatch, planDelegateCostMerge, planReplaceServerAuthoredKeepingOrderSlots, planSpillOverflow } from './clientSessionsPlan.js'
export type { AppendServerAuthoredBatchPlan, AppendServerAuthoredPlan, CostPatchPlan, DelegateCostMergePlan, DelegatePendingRow, SpillChunkPlan, SpillOverflowPlan } from './clientSessionsPlan.js'
export { migrateUserClientSessionsFromV3 } from './sessionsMigrate.js'
export type { UserSessionsMigrationResult } from './sessionsMigrate.js'
export { WechatAccountAlreadyBoundError, _sqliteDeleteWechatBinding, _sqliteGetWechatBindingByAccountId, _sqliteGetWechatBindingByUserId, _sqliteListActiveWechatBindings, _sqliteListAllWechatBindings, _sqliteUpdateWechatBindingCursor, _sqliteUpdateWechatBindingStatus, _sqliteUpsertWechatBinding, deleteWechatBinding, getWechatBindingByAccountId, getWechatBindingByUserId, listActiveWechatBindings, listAllWechatBindings, updateWechatBindingCursor, updateWechatBindingStatus, upsertWechatBinding } from './wechatBindings.js'
export type { UpsertWechatBindingInput, WechatBinding } from './wechatBindings.js'
export { MAX_SKILL_DESCRIPTION_LENGTH, MAX_SKILL_HISTORY_VERSIONS, MAX_SKILL_NAME_LENGTH, SKILL_AGENT_SCOPE_FILE, SKILL_PRIORITY_MAX, SKILL_PRIORITY_MIN, SkillStore, buildAgentSkillStore, buildRunSkillStore, buildUserSkillStore, formatFrontmatter, isPlatformReservedSkillName, normalizeSkillAgentScope, normalizeSkillPriority, parseFrontmatter, pruneSkillHistoryDir, resolveBaselineSkillsDirFromEnv, resolveDefaultAgentId, searchSkillMetadata, validateSkillAgentScope, validateSkillName } from './skillStore.js'
export type { SkillContent, SkillFrontmatter, SkillLayer, SkillMetadata, SkillSaveOptions, SkillScopeMode, SkillSearchResult, SkillSource, SkillStoreCompatOptions, SkillStoreOptions, SkillViewOptions } from './skillStore.js'
export { BOARD_PROJECT_ID_RE, PROJECT_CONTEXT_FLAG, PROJECT_CONTEXT_SCHEMA_VERSION, PROJECT_ID_ENV, PROJECT_INSTRUCTIONS_MAX, PROJECT_SEARCH_FLAG, allowedWorkspaceRoots, assertAllowedCwd, assetsRevision, clipProjectInstructions, commitProjectSkillOverlay, copySkillIntoProjectOverlay, emptyContentManifest, incrementProjectContextVersion, isProjectContextEnabled, isProjectSearchEnabled, isProjectStorageReadOnlyError, isUniqueConstraintError, loadProjectContext, loadProjectContextAllowReadOnly, loadProjectContextReadonly, parseBoardProjectId, parseProjectWorkspace, projectContextDir, projectIdSpawnEnv, projectInstructionsWithUnwrittenSeed, projectSessionFingerprint, projectSkillsDir, resolveProjectCwd, seedProjectInstructionsIfEmpty, setProjectSkillOverlay, skillOverlayManifestSha256, writeProjectInstructions } from './projectContext.js'
export type { CwdRejection, CwdResolution, ProjectContentManifest, ProjectContextMeta, ProjectContextSnapshot, ProjectContextWriteResult, ProjectInstructionsConflict, ProjectInstructionsFileStatus, ProjectInstructionsState, ProjectSkillManifestEntry, ProjectWorkspace } from './projectContext.js'
export { PROJECT_CANDIDATES_INDEX_MARKER, PROJECT_MEMORY_INDEX_MARKER, PROJECT_MEMORY_INDEX_MAX_CHARS, PROJECT_MEMORY_INDEX_MAX_LINES, ProjectMemoryDir, assertProjectMemoryFile, conflictFileName, planCandidateFileName, projectMemoryDataRootHint, sha256Hex } from './projectMemoryDir.js'
export type { OfficialInjectEntry, ProjectCandidateWriteResult, ProjectMemoryFileRead } from './projectMemoryDir.js'
export { AUTO_PROMOTE_ACTOR, PROJECT_MEMORY_LEDGER_DDL, PROJECT_MEMORY_LEDGER_SCHEMA_VERSION, ProjectMemoryLedger, ensureProjectMemoryLedger, officialManifestSha256 } from './projectMemoryLedger.js'
export type { CandidateStatus, CreateCandidateInput, CreateCandidateResult, LedgerAction, ProjectMemoryCandidateRow, ProjectMemoryOfficialRow, PromoteResult, SqlDb, SqlStatement } from './projectMemoryLedger.js'
export { PROJECT_SKILL_LEDGER_DDL, ProjectSkillLedger, ensureProjectSkillLedger, hashSkillTree, loadProjectSkillFileMap, openProjectSkillLedgerDb, skillManifestSha256FromFiles, verifySkillTree } from './projectSkillLedger.js'
export type { ProjectSkillRow, SkillTreeFile } from './projectSkillLedger.js'
export { frozenProjectDigests, loadFrozenProjectContext } from './projectContextFrozen.js'
export type { FrozenOfficialMemory, FrozenProjectContext, FrozenProjectContextDigests, FrozenProjectSkill } from './projectContextFrozen.js'
export { PROJECT_RUN_SNAPSHOT_KEEP, PROJECT_RUN_SNAPSHOT_MAX_AGE_MS, REDACTED_SLOT_NAMES, VOLATILE_SLOT_NAMES, classifySlot, createRunContextDescriptor, emptyProjectRunSnapshot, pruneProjectRunSnapshots, pruneProjectRunSnapshotsSync, readProjectRunContextFile, realpathOrNull, safeRunIdSegment, writeProjectRunContextFile } from './projectRunSnapshot.js'
export type { ProjectRunConflictPolicy, ProjectRunContextSnapshotDescriptor, ProjectRunCwdSource, ProjectRunSlotHash, RunContextDescriptor } from './projectRunSnapshot.js'
export { backupRefusedFiles, defaultManifestPath, migrateProjectContext } from './projectContextMigrate.js'
export type { MigrateProjectContextOpts, MigrationCopiedCandidate, MigrationCreatedDir, ProjectContextMigrationManifest } from './projectContextMigrate.js'
export { AUTHORITATIVE_BIND_MIN, AUTHORITATIVE_DEFAULT_APPLY, AUTHORITATIVE_MANUAL_REVIEW, MEMORY_ALLOW_ROOTS, OCV5_DEFAULT_BOARD_ID, applyProjectLayerMigration, assertPlanApplyable, compensateProjectLayerMigration, isDefaultApplySession, isPathInsideRoot, planProjectLayerMigration, readMemoryContent, repairProjectDirOwnership, sessionProjectFilterSql, summarizeManualReview } from './projectLayerMigrate.js'
export type { ApplyPorts, ApplyResult, DriftReason, InventoryAssetRow, InventorySession, LiveBoardProject, LiveChatProject, LiveSessionSnapshot, ManualReviewItem, PlannedOp, ProjectLayerInventory, ProjectLayerLivePorts, ProjectLayerPlan, SessionCasRow } from './projectLayerMigrate.js'
export { MAX_EVAL_ASSERTIONS, MAX_EVAL_ASSERTION_CHARS, MAX_EVAL_CASES, MAX_EVAL_EXPECTED_CHARS, MAX_EVAL_PROMPT_CHARS, parseSkillEvalsJson, serializeSkillEvals } from './skillEvals.js'
export type { ParseEvalsResult, SkillEvalCase, SkillEvalsFile } from './skillEvals.js'
export { applyExactNameGuard, cleanSkillQuery, cosineSim, getSkillEmbeddingProvider, isSkillEmbeddingAvailable, marketplaceArtifactHash, rankSkillsByVectors, resetSkillEmbeddingProvider, skillCanonicalInput, skillContentHash, skillEmbedText, skillEmbeddingBackendId, skillEmbeddingConfigFromEnv } from './skillEmbedding.js'
export type { RankedSkill, SkillEmbedMeta } from './skillEmbedding.js'
export { _resetMarketplaceSyncStateForTest, syncMarketplaceHub } from './marketplaceSync.js'
export { SkillDraftStore } from './skillDraftStore.js'
export type { SkillDraftAuthor, SkillDraftContent, SkillDraftOp, SkillDraftRecord, SkillDraftSummary, WriteSkillDraftInput } from './skillDraftStore.js'
export { archivalAdd, archivalCount, archivalDelete, archivalSearch } from './archivalStore.js'
export type { ArchivalEntry, ArchivalSearchResult } from './archivalStore.js'
export { TaskStore } from './taskStore.js'
export type { TaskDef, TaskExecution, TaskStatus, TaskTrigger } from './taskStore.js'
export { OPENAI_EMBEDDING_BASE_URL, OPENAI_LARGE_EMBEDDING_DIMENSIONS, OPENAI_LARGE_EMBEDDING_MODEL, OpenAIEmbeddingProvider, configFromEnv, currentEmbeddingProvider, defaultEmbeddingBatchSize, embeddingBackendId, getEmbeddingProvider, isEmbeddingAvailable, resetEmbeddingProvider } from './embedding.js'
export type { EmbeddingKind, EmbeddingProvider, EmbeddingProviderConfig } from './embedding.js'
export { decodeSessionVecId, deleteArchivalVector, encodeSessionVecId, hybridArchivalSearch, hybridSessionSearch, initVectorStore, notePersistentVectorMutation, reciprocalRankFusion, resetVectorStore, searchArchivalByVector, searchSessionsByVector, upsertArchivalVector, upsertSessionVector } from './vectorStore.js'
export type { HybridArchivalResult, HybridSessionResult, RRFCandidate } from './vectorStore.js'
export { CohereReranker, JinaReranker, getReranker, isRerankerAvailable, rerankResults, rerankerConfigFromEnv, resetReranker } from './reranker.js'
export type { RerankResult, Reranker, RerankerConfig } from './reranker.js'
export { estimateTokens, formatPackedContext, packContext } from './contextPacker.js'
export type { PackerCandidate, PackerOptions, PackerResult } from './contextPacker.js'
export { cleanupArchival, decayAccess, getLifecycleStats, recordAccess, resetLifecycleState } from './memoryLifecycle.js'
export type { CleanupOptions, CleanupResult, DecayOptions, LifecycleStats } from './memoryLifecycle.js'
export { ClaudeSummaryProvider, getSummaryProvider, isSummaryAvailable, resetSummaryProvider, summarizeFile, summaryConfigFromEnv } from './multimodalSummary.js'
export type { SummaryProvider, SummaryProviderConfig, SummaryResult } from './multimodalSummary.js'
export { deduplicateArchival, enqueueFullReindex, enqueueIndex, findExactDuplicates, getQueueSize, isReindexNeeded, processIndexQueue, purgeDeadLetters, reclaimExpiredLeases, recordEmbeddingModel, resetIndexPipelineState } from './indexPipeline.js'
export type { DuplicateGroup, PipelineStats, QueueEntry, ReindexOptions } from './indexPipeline.js'

export { fetchIdentityCompatProjection, identityCompatEnvironment, resolveRuntimeExecutionAgent } from './identityCompatRuntime.js'
export type { IdentityCompatRuntimeContext } from './identityCompatRuntime.js'

export { SessionFileIntegrityError, appendSessionFile, flushSessionFileIo, readSessionFile, replaceSessionFile, withSessionFile } from './sessionFileIo.js'
export type { SessionFileRestoreReceipt, SessionFileScope, SessionReadHandle } from './sessionFileIo.js'
export { SystemActionError, SystemActionStore, systemActionRequestHash } from './systemActions.js'
export type { PrepareSystemAction, SystemActionControlRecoveryRecord, SystemActionExecution, SystemActionReceiptBinding } from './systemActions.js'

export { createAuthorityPaths } from './authorityPaths.js'
export type { AuthorityPaths, ProjectFileLocations } from './authorityPaths.js'
export { CoreMemoryView, UserProfileView, asSkillReadView, createAuthoritySkillReadView } from './authorityViews.js'
export type { SkillReadView } from './authorityViews.js'

export { PROJECT_FORMAL_DB_APPLICATION_ID, PROJECT_FORMAL_DB_VERSION, openProjectFormalReadonly } from './projectFormalLedger.js'
export type { ProjectFormalLedgerView, ProjectFormalReadSource, ProjectFormalSnapshot } from './projectFormalLedger.js'

// OpenViking context façade (P1 B1: gateway-only callers; CLI stays cli_lease_blocked).
export { contextAccess, contextContentHash, contextEligibility, contextScopeKey } from './contextEligibility.js'
export type { ContextAccess, ContextAuthority, ContextReadOptions, ContextRejection, ContextSourceReference, GatewayContextAuthority } from './contextEligibility.js'
export { readCoreContextSource, readFormalProjectContextSources } from './contextSource.js'
export type { ContextCoreSource, ContextSources, SourceDescriptor } from './contextSource.js'

export { UPLOAD_REFERENCE_MAX_BYTES, UPLOAD_REFERENCE_MAX_MS, UPLOAD_REFERENCE_MAX_ROWS, hydrateUploadReferenceMessages, scanUploadReferenceRows } from './sessionUploadReferences.js'
export type { UploadDeferredPayload, UploadReferenceHydrator, UploadReferenceRow } from './sessionUploadReferences.js'

// Context governance: reversible archive, local skill usage, L1 janitor, runtime GC & config self-heal.
export { applySemanticMemoryMerge, archiveMemoryFiles, archiveUserSkill, isSkillScopeSuperset, isSkillScopeVisibleToAgent, listArchivedMemories, listArchivedSkills, resolveCompatLocalSkillStorageIdFromEnv, resolveEffectiveSkillAgentScope, restoreArchivedMemories, restoreArchivedSkills, searchArchivedMemories, searchArchivedSkills } from './contextArchive.js'
export type { ApplySemanticMemoryMergeInput, ApplySemanticMemoryMergeResult, ArchiveUserSkillGuard, ArchivedMemoryEntry, ArchivedSearchHit, ArchivedSkillEntry, MergedBatchArtifact, SemanticArchiveSuperseded, SemanticMemoryMergeGroup } from './contextArchive.js'
export {
  MAX_DISTILLED_MEMORY_BYTES,
  applyOversizedMemoryDistill,
  type ApplyOversizedMemoryDistillInput,
  type ApplyOversizedMemoryDistillResult,
} from './memoryDistill.js'
export { SKILL_USAGE_LOCAL_DDL, classifySkillTier, ensureSkillUsageLocalTable } from './skillUsageLocal.js'
export type { ClassifySkillTierOptions, LocalSkillUsageRecord, SkillActivityTier, SkillUsageDbLike } from './skillUsageLocal.js'
export { appendContextHygieneRun, buildContextHealthReport, listContextHygieneHistory, runContextJanitor } from './contextJanitor.js'
export type { BuildContextHealthReportInput, ContextHealthReport, ContextHealthSlot, ContextHygieneRunRecord, ContextSlimCandidate, ContextSlimCandidateKind, RunContextJanitorInput } from './contextJanitor.js'
export {
  DEFAULT_BAK_WHITELIST,
  DEFAULT_CRON_TAPE_MAX_AGE_MS,
  DEFAULT_INFLIGHT_SURFACE_MAX_AGE_MS,
  DEFAULT_RETRY_QUARANTINE_MAX_AGE_MS,
  DEFAULT_RETRY_QUARANTINE_MAX_BYTES,
  DEFAULT_STALE_BAK_MAX_AGE_MS,
  gcCronOccurrenceTapes,
  gcDelegateInflightSurface,
  gcRetryQueueQuarantine,
  gcStaleBakFiles,
  runRuntimeHygieneGc,
  verifySafeSubdirWithinRoot,
  type DelegateInflightSurfacePruner,
  type GcCronOccurrenceTapesOptions,
  type GcCronOccurrenceTapesReport,
  type GcDelegateInflightSurfaceOptions,
  type GcDelegateInflightSurfaceReport,
  type GcRetryQueueQuarantineOptions,
  type GcRetryQueueQuarantineReport,
  type GcStaleBakFilesOptions,
  type GcStaleBakFilesReport,
  type RuntimeHygieneGcOptions,
  type RuntimeHygieneGcReport,
  type SafeSubdirResult,
} from './runtimeHygieneGc.js'
export {
  DEPRECATED_PROVIDERS,
  LEGACY_MODEL_POINTER_ALIASES,
  healConfigModelPointers,
  resolveHealedModelPointer,
  resolveHealedProvider,
  type ConfigPointerHealFileName,
  type ConfigPointerMigration,
  type ConfigPointerSelfHealReport,
  type HealConfigModelPointersOptions,
  type HealedModelPointerResult,
  type HealedProviderResult,
  type ModelCatalogHealModel,
  type ModelCatalogHealView,
} from './configPointerSelfHeal.js'
export { BoundedDeltaStreamBuffer, EXEC_ENV_JOB_DEFAULT_CLOSE_DRAIN_MS, EXEC_ENV_JOB_DEFAULT_KILL_GRACE_MS, EXEC_ENV_JOB_DEFAULT_MAX_LIFETIME_MS, EXEC_ENV_JOB_DEFAULT_MAX_LOG_FILE_BYTES, EXEC_ENV_JOB_DEFAULT_TOMBSTONE_MAX, EXEC_ENV_JOB_HEAD_BYTES, EXEC_ENV_JOB_MAX_OUTPUT_BYTES, EXEC_ENV_JOB_TAIL_BYTES, ExecEnvJobError, ExecEnvJobRegistry, hasAliveVerifiedProcessGroup, hasAliveVerifiedProcessGroupAsync, leadingContinuationUtf8Count, parseProcStatFull, parseProcStatStartTimeTicks, readProcStartTimeTicksAsync, registerDefaultSyncProcOps, sendVerifiedGroupSignal, sendVerifiedGroupSignalAsync, trailingIncompleteUtf8Count } from './execEnvJobRegistry.js'
export type { BoundedDeltaReadResult, BoundedDeltaStreamBufferOptions, ExecEnvJobClosedEvent, ExecEnvJobErrorCode, ExecEnvJobRegistryOptions, ExecEnvJobStartResult, ExecEnvJobStartedEvent, ExecEnvJobTerminationCause, ExecEnvMigrationTombstoneResult, ExecEnvReapStopProof, ExecEnvShutdownResult, ExecEnvStartJobSpec, ExecEnvWaitJobAction, ExecEnvWaitJobResult, ParsedProcStat, VerifyProcessGroupOps, WaitJobOptions } from './execEnvJobRegistry.js'
