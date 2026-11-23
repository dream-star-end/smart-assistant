export * from './idleRecoveryError.js'
/**
 * @openclaude/protocol/browser: the protocol entry for the browser (web-react) and any other
 * non-Node consumer (phase 3 plan v3.6 §3.6, OCV5-558). Everything here is free of `node:*` in its
 * whole import graph; scripts/__tests__/protocolBrowserEntry.test.ts enforces that transitively and
 * that every node-free module of the root entry is also exported here.
 *
 * The root entry (`@openclaude/protocol`) stays the complete entry for Node (master, gateway,
 * egress, scripts); it additionally exports the modules that need node:crypto: traceId (id
 * generation), modelAuthority / dispatchAuthority (signature verification) and losslessTurnTape.
 */
export * from './frames.js'
export * from './swarm.js'
export * from './contextPressure.js'
export * from './liveUnits.js'
export * from './timelineLifecycle.js'
export * from './goalState.js'
export * from './events.js'
export * from './teamCards.js'
export * from './engineModels.js'
export * from './cc5TestModel.js'
export * from './cc5Backend.js'
export * from './remoteExecutionBackend.js'
export * from './grokExecution.js'
export * from './serviceTiers.js'
export * from './boxApiModels.js'
export * from './boxGptWebModels.js'
export * from './modelCostIndex.js'
export * from './computeCost.js'
export * from './sessionKey.js'
export * from './staticKeyProviders.js'
export * from './research.js'
export * from './agentVisibility.js'
export * from './collaboration.js'
export * from './marketplaceTaxonomy.js'
export * from './pluginManifest.js'
export * from './pluginUi.js'
export * from './marketplaceBundle.js'
export * from './containerPreview.js'
export * from './chatgptProxy.js'
export * from './internalRoutes.js'
export * from './toolFailureAudit.js'
export * from './turnErrorTaxonomy.js'
export * from './userErrorCatalog.js'
export * from './uploadLimits.js'
export * from './uploadChunkSizing.js'
export * from './marketplaceArtifact.js'
export * from './activeContent.js'
export * from './modelHistory.js'
export * from './messageReply.js'
export * from './mediaGeneration.js'
export * from './tutorialSnapshot.js'
export * from './delegation.js'
export * from './cursorSessionAuth.js'
export * from './runCost.js'
export * from './identityCompat.js'
export * from './serverFeatures.js'
export { measureLogWrite, takeLogWriteTimingSnapshot } from './logWriteTiming.js'
export * from './upstreamRetryHint.js'

export * from './promptPrivacy.js'
export * from './systemActions.js'
export * from './ccbTranscriptRestore.js'

export type { ModelSwitchCostRequest, ModelSwitchCostQuote, ModelSwitchCostRange, ModelSwitchCostAuthorization, ModelSwitchUnitPrice } from './modelSwitchCost.js'
export * from './systemHelp.js'

export * from './automaticRetryStatus.js'
export * from './advisorReadOnly.js'
export * from './advisorNoWrite.js'
export {
  HTTP_REST_CONTRACT_DOMAINS,
  HTTP_REST_CONTRACTS,
  SessionRunStateSchema,
  SessionLastOutcomeSchema,
  SessionMetaContractSchema,
  SessionListQuerySchema,
  SessionListResponseSchema,
  PutSessionRequestSchema,
  PutSessionAppliedResponseSchema,
  PutSessionExistedResponseSchema,
  PutSessionResponseSchema,
  BillingBalanceBreakdownSchema,
  BillingSubscriptionSummarySchema,
  BillingSubscriptionMeResponseSchema,
  PendingDecisionSourceSchema,
  PendingDecisionStatusSchema,
  PendingDecisionActionSchema,
  PendingDecisionRiskLevelSchema,
  PendingDecisionItemSchema,
  PendingDecisionWarningSchema,
  ListPendingDecisionsQuerySchema,
  ListPendingDecisionsResponseSchema,
  ResolvePendingDecisionRequestSchema,
  ResolvePendingDecisionResponseSchema,
  UserSiteVisibilitySchema,
  UserSiteCustomDomainStatusSchema,
  UserSiteAccessRoleSchema,
  UserSiteItemSchema,
  SiteEnvVarItemSchema,
  SitesSummaryResponseSchema,
  SiteDetailResponseSchema,
  PublicModelEffortSchema,
  PublicModelEngineSchema,
  PublicModelPlacementSchema,
  PublicModelItemSchema,
  LockedPublicModelItemSchema,
  PublicModelsResponseSchema,
  serializeRestContractSnapshot,
} from './httpContracts.js'
export type {
  HttpRestContractDomain,
  SessionRunStateContract,
  SessionLastOutcomeContract,
  SessionMetaContract,
  SessionListQueryContract,
  SessionListResponseContract,
  PutSessionRequestContract,
  PutSessionAppliedResponseContract,
  PutSessionExistedResponseContract,
  PutSessionResponseContract,
  BillingBalanceBreakdownContract,
  BillingSubscriptionSummaryContract,
  BillingSubscriptionMeResponseContract,
  PendingDecisionItemContract,
  PendingDecisionWarningContract,
  ListPendingDecisionsQueryContract,
  ListPendingDecisionsResponseContract,
  ResolvePendingDecisionRequestContract,
  ResolvePendingDecisionResponseContract,
  UserSiteItemContract,
  SiteEnvVarItemContract,
  SitesSummaryResponseContract,
  SiteDetailResponseContract,
  PublicModelItemContract,
  LockedPublicModelItemContract,
  PublicModelsResponseContract,
  HttpRouteContractDef,
  SerializedRouteContract,
  RestContractSnapshot,
} from './httpContracts.js'
export {
  LIVE_BROWSER_PROTOCOL_VERSION,
  LIVE_BROWSER_PUBLIC_WS_PATH,
  LIVE_BROWSER_INTERNAL_WS_PATH,
  LIVE_BROWSER_TICKET_PROTOCOL,
  LIVE_BROWSER_ASSERTION_HEADER,
  LIVE_BROWSER_BINARY_MAGIC,
  LIVE_BROWSER_BINARY_HEADER_BYTES,
  LIVE_BROWSER_MAX_BINARY_FRAME_BYTES,
  LIVE_BROWSER_FRAME_FORMAT_JPEG,
  LIVE_BROWSER_FRAME_FORMAT_PNG,
  LIVE_BROWSER_FRAME_FLAG_SETTLED,
  BROWSER_HANDOFF_RESUME_MAX_PATTERNS,
  BROWSER_HANDOFF_RESUME_MAX_STR_LEN,
  BROWSER_HANDOFF_MIN_DELAY_MS,
  BROWSER_HANDOFF_MAX_DELAY_MS,
  encodeLiveBrowserFrame,
  decodeLiveBrowserFrame,
  liveBrowserModifiersToBitmask,
  normalizeBrowserHandoffResumeWhen,
} from './liveBrowser.js'
export type {
  LiveBrowserFrameFormat,
  LiveBrowserFrameInput,
  LiveBrowserDecodedFrame,
  LiveBrowserViewport,
  LiveBrowserTab,
  LiveBrowserDialogInfo,
  LiveBrowserMouseButton,
  LiveBrowserModifiers,
  LiveBrowserStreamTicketResponse,
  BrowserHandoffResumeWhen,
  LiveBrowserHandoffReadyMessage,
  LiveBrowserHandoffVetoedMessage,
  LiveBrowserClientMessage,
  LiveBrowserStatePayload,
  LiveBrowserServerMessage,
  LiveBrowserServerControlMessage,
} from './liveBrowser.js'
