/**
 * OCV5-890 Wave 2 — Layer 2 Unified Inference Pool Drivers public barrel.
 * Explicit named re-exports only (R2-export-star compliant).
 */
export {
  CreditBudgetGuard,
  DEFAULT_UNIFIED_USAGE_SEMANTICS,
  InferencePoolDriverError,
  LocalPoolDriver,
  assertAdmitEligibility,
  buildLocalDriverCapabilityManifest,
  buildValidatedTurnReceiptV5,
  defaultEstimateCreditsFen,
  deriveRequiredCapabilities,
  extractCoreUnifiedTurnRequest,
  hasVisionInputBlocks,
  mergeUsageCountersMax,
} from './localPoolDriver.js'
export type {
  AbandonResult,
  BuildDriverCapabilityManifestOptions,
  CreditEstimatorFn,
  DriverAdmission,
  DriverModelCapabilityTriplet,
  DriverTerminalStatus,
  DriverTurnRequest,
  DriverTurnRetryContext,
  LocalPoolDriverOptions,
  PendingSettlementOutbox,
  PendingSettlementRecord,
  StopLaneResult,
  TurnSettlementInfo,
} from './localPoolDriver.js'

export {
  RemotePoolV5Driver,
  buildRemoteDriverCapabilityManifest,
} from './remotePoolV5Adapter.js'
export type {
  RemotePoolV5DriverOptions,
  RemoteV5LaneBridge,
  RemoteV5LaneEvent,
  RemoteV5TurnDispatchPayload,
} from './remotePoolV5Adapter.js'
