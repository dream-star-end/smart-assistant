/**
 * OCV5-890 Layer 2 — Inference Pool v5 pure protocol contracts.
 *
 * L0 Contract Invariant (R2-contract-node): ZERO `node:*` imports allowed.
 */
import type { PlatformReasoningEffort } from '../engineModels.js'
import type { ModelAuthorityEngine } from '../modelAuthority.js'

export type { PlatformReasoningEffort }

export const INFERENCE_POOL_KINDS = [
  'local_pool',
  'remote_pool',
  'box_pool',
] as const
export type InferencePoolKind = (typeof INFERENCE_POOL_KINDS)[number]

export const INFERENCE_ENGINE_FAMILIES = [
  'cc',
  'codex',
  'antigravity',
  'grok',
  'cursor',
  'zcode',
] as const
export type InferenceEngineFamily = (typeof INFERENCE_ENGINE_FAMILIES)[number]

export const INFERENCE_SERVICE_TIERS = [
  'standard',
  'fast',
  'ultrafast',
] as const
export type InferenceServiceTier = (typeof INFERENCE_SERVICE_TIERS)[number]

export const TURN_POOL_PREFERENCES = [
  'auto',
  'pin_local',
  'pin_remote',
  'pin_box',
] as const
export type TurnPoolPreference = (typeof TURN_POOL_PREFERENCES)[number]

export interface LogicalModelCapability {
  readonly logicalModel: string
  readonly upstreamModelId?: string
  readonly supportsVision: boolean
  readonly supportedEfforts: readonly PlatformReasoningEffort[]
  readonly defaultEffort: PlatformReasoningEffort | null
  readonly supportedServiceTiers: readonly InferenceServiceTier[]
  readonly supportsReadOnly: boolean
  readonly supportsConsultTurn: boolean
  readonly supportsHermeticNoTools: boolean
  readonly supportsSwarm: boolean
  readonly supportsAdaptiveThinking?: boolean
  readonly contextWindow?: number | null
}

export interface DriverCapabilityManifest {
  readonly schemaVersion: 5
  readonly poolKind: InferencePoolKind
  readonly engineFamily: InferenceEngineFamily
  readonly authorityEngine: ModelAuthorityEngine
  readonly driverId: string
  readonly driverVersion: string
  readonly observedAt: string
  readonly models: readonly LogicalModelCapability[]
}

export interface TurnPlacementHint {
  readonly poolPreference: TurnPoolPreference
  readonly stickyHomeKey?: string
  readonly cacheAffinityKey?: string
  readonly preferredDriverId?: string
  readonly preferredProfileId?: string
  readonly placementEpoch?: number
}

export interface ToolBridgeEndpoint {
  readonly kind: 'unix_socket' | 'loopback_http' | 'in_process' | 'stdio_mcp'
  readonly uri: string
  readonly authTokenRef?: string
  readonly attestationMode?:
    | 'gateway_signed_grant'
    | 'dual_channel_observed'
    | 'schema_filtered_hook'
}

export type UnifiedTurnInputBlock =
  | {
      readonly type: 'text'
      readonly text: string
    }
  | {
      readonly type: 'blob_ref'
      readonly blobId: string
      readonly sha256: string
      readonly mimeType: string
      readonly logicalName?: string
    }
  | {
      readonly type: 'image_ref'
      readonly blobId?: string
      readonly uri?: string
      readonly sha256?: string
      readonly mimeType: string
      readonly altText?: string
    }

export interface UnifiedTurnRequest {
  readonly schemaVersion: 5
  readonly turnId: string
  readonly turnKey: string
  readonly requestId: string
  readonly tenantId: string
  readonly sessionKey: string
  readonly logicalModel: string
  readonly reasoningEffort?: PlatformReasoningEffort
  readonly serviceTier?: InferenceServiceTier
  readonly input: readonly UnifiedTurnInputBlock[]
  readonly systemInstructions?: string
  readonly placementHint?: TurnPlacementHint
  readonly toolBridge?: ToolBridgeEndpoint
  readonly readOnly?: boolean
  readonly consultTurn?: boolean
  readonly hermeticNoTools?: boolean
  readonly needsSwarm?: boolean
  readonly nativeSessionId?: string | null
  readonly authorityTurnId?: string
}

export interface NormalizedUsageCounters {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly reasoningTokens?: number
}

export interface TurnReceiptV5 {
  readonly version: 5
  readonly poolKind: InferencePoolKind
  readonly engineFamily: InferenceEngineFamily
  readonly driverId: string
  readonly driverVersion: string
  readonly tenantId: string
  readonly sessionKey: string
  readonly turnId: string
  readonly turnKey: string
  readonly requestId: string
  readonly logicalModel: string
  readonly canonicalModel: string
  readonly upstreamModel: string
  readonly serviceTier: InferenceServiceTier
  readonly placementEpoch: number
  readonly usageSemantics: string
  readonly usage: NormalizedUsageCounters
  readonly status: 'success' | 'error' | 'interrupted'
  readonly errorCode?: string
  readonly rawEvidenceDigest: string
  readonly semanticDigest: string
  readonly receiptDigest: string
  readonly finalizedAt: string
}

export type TurnReceiptV5Body = Omit<TurnReceiptV5, 'semanticDigest' | 'receiptDigest'>

export type NormalizedInferenceEvent =
  | {
      readonly kind: 'turn_admitted'
      readonly turnId: string
      readonly poolKind: InferencePoolKind
      readonly driverId: string
      readonly placementEpoch: number
      readonly seq: number
      readonly ts: string
    }
  | {
      readonly kind: 'turn_dispatched'
      readonly turnId: string
      readonly nativeSessionId?: string
      readonly nativeTurnId?: string
      readonly logicalModel: string
      readonly upstreamModel?: string
      readonly seq: number
      readonly ts: string
    }
  | {
      readonly kind: 'text_delta'
      readonly turnId: string
      readonly channel: 'answer' | 'reasoning'
      readonly delta: string
      readonly seq: number
      readonly ts: string
    }
  | {
      readonly kind: 'tool_call_delta'
      readonly turnId: string
      readonly callId: string
      readonly toolName: string
      readonly argsDelta: string
      readonly seq: number
      readonly ts: string
    }
  | {
      readonly kind: 'tool_call_request'
      readonly turnId: string
      readonly callId: string
      readonly toolName: string
      readonly arguments: Readonly<Record<string, unknown>>
      readonly argsSha256: string
      readonly seq: number
      readonly ts: string
    }
  | {
      readonly kind: 'tool_call_observed'
      readonly turnId: string
      readonly callId: string
      readonly toolName: string
      readonly phase: 'started' | 'completed'
      readonly argsSha256: string
      readonly seq: number
      readonly ts: string
    }
  | {
      readonly kind: 'permission_request'
      readonly turnId: string
      readonly permissionId: string
      readonly toolName: string
      readonly reason: string
      readonly riskLevel?: 'low' | 'medium' | 'high'
      readonly seq: number
      readonly ts: string
    }
  | {
      readonly kind: 'context_pressure'
      readonly turnId: string
      readonly usedTokens: number
      readonly contextWindow: number
      readonly ratio: number
      readonly seq: number
      readonly ts: string
    }
  | {
      readonly kind: 'context_compacted'
      readonly turnId: string
      readonly reason: string
      readonly beforeTokens?: number
      readonly afterTokens?: number
      readonly clearedPromptCache?: boolean
      readonly seq: number
      readonly ts: string
    }
  | {
      readonly kind: 'call_usage'
      readonly turnId: string
      readonly sampleId: string
      readonly scopeId: string
      readonly usage: NormalizedUsageCounters
      readonly seq: number
      readonly ts: string
    }
  | {
      readonly kind: 'turn_status'
      readonly turnId: string
      readonly phase: string
      readonly message?: string
      readonly seq: number
      readonly ts: string
    }
  | {
      readonly kind: 'disallowed_item'
      readonly turnId: string
      readonly itemType: string
      readonly reason: string
      readonly seq: number
      readonly ts: string
    }
  | {
      readonly kind: 'billing_receipt'
      readonly turnId: string
      readonly receipt: TurnReceiptV5
      readonly seq: number
      readonly ts: string
    }
  | {
      readonly kind: 'turn_terminal'
      readonly turnId: string
      readonly terminalId: string
      readonly status: 'success' | 'error' | 'interrupted'
      readonly errorCode?: string
      readonly seq: number
      readonly ts: string
    }

/**
 * Compile-time locked pool fallback policy invariants:
 * - Never silently downgrade a logical model.
 * - Always require capability superset on fallback target.
 * - Never fallback across pools after dispatch has already started.
 */
export interface PoolFallbackPolicy {
  readonly neverSilentDowngradeModel: true
  readonly requireCapabilitySuperset: true
  readonly allowCrossPoolOnPostDispatchFailure: false
  readonly allowPreDispatchPoolFallback: boolean
  readonly maxPreDispatchFallbackAttempts: number
  readonly allowedFallbackPools: readonly InferencePoolKind[]
}

export interface PoolMigrationControl {
  readonly allowAutoMigration: boolean
  readonly preserveStickyHome: boolean
  readonly requireCapsuleForWarmHandoff: boolean
  readonly drainTimeoutMs: number
}

export interface InferencePoolDriver {
  readonly poolKind: InferencePoolKind
  readonly engineFamily: InferenceEngineFamily
  readonly driverId: string
  readonly driverVersion: string
  probeCapabilities(): Promise<DriverCapabilityManifest>
  executeTurn(request: UnifiedTurnRequest): AsyncIterable<NormalizedInferenceEvent>
  interruptTurn(turnId: string, reason?: string): Promise<void>
}

export interface LogicalModelPoolBinding {
  readonly logicalModelId: string
  readonly poolKind: InferencePoolKind
  readonly driverId: string
  readonly canonicalModelId: string
  readonly priority: number
  readonly capabilities: LogicalModelCapability
  readonly enabled: boolean
}

export interface RequiredTurnCapabilities {
  readonly needsVision?: boolean
  readonly reasoningEffort?: PlatformReasoningEffort
  readonly serviceTier?: InferenceServiceTier
  readonly readOnly?: boolean
  readonly consultTurn?: boolean
  readonly hermeticNoTools?: boolean
  readonly needsSwarm?: boolean
}

export interface CapabilitySupersetCheckResult {
  readonly satisfied: boolean
  readonly logicalModel: string
  readonly matchedModel?: LogicalModelCapability
  readonly unsatisfiedReasons: readonly string[]
}

export interface ResolvedLogicalModelId {
  readonly logicalModel: string
  readonly poolPreference: 'pin_remote' | 'auto'
  readonly isLegacyRemoteAlias: boolean
}

export interface CacheAffinityKeyParts {
  readonly tenantId: string
  readonly sessionKey: string
  readonly logicalModel: string
  readonly engineFamily?: InferenceEngineFamily
  readonly systemPromptSha256?: string
}
