/**
 * OCV5-890 Layer 2 — Inference Pool v5 public barrel.
 * Explicit named re-exports only (R2-export-star compliant).
 */
export {
  INFERENCE_ENGINE_FAMILIES,
  INFERENCE_POOL_KINDS,
  INFERENCE_SERVICE_TIERS,
  TURN_POOL_PREFERENCES,
} from './contracts.js'

export type {
  CacheAffinityKeyParts,
  CapabilitySupersetCheckResult,
  DriverCapabilityManifest,
  InferenceEngineFamily,
  InferencePoolDriver,
  InferencePoolKind,
  InferenceServiceTier,
  LogicalModelCapability,
  LogicalModelPoolBinding,
  NormalizedInferenceEvent,
  NormalizedUsageCounters,
  PlatformReasoningEffort,
  PoolFallbackPolicy,
  PoolMigrationControl,
  RequiredTurnCapabilities,
  ResolvedLogicalModelId,
  ToolBridgeEndpoint,
  TurnPlacementHint,
  TurnPoolPreference,
  TurnReceiptV5,
  TurnReceiptV5Body,
  UnifiedTurnInputBlock,
  UnifiedTurnRequest,
} from './contracts.js'

export {
  DEFAULT_POOL_FALLBACK_POLICY,
  checkCapabilitySuperset,
  computeCacheAffinityKey,
  computeEffectiveModelCapabilities,
  computeStickyHomeKey,
  computeTurnReceiptV5Digests,
  resolveLogicalModelId,
  validateDriverCapabilityManifest,
  validateTurnReceiptV5,
  validateUnifiedTurnRequest,
} from './validators.js'
