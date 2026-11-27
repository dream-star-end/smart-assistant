/**
 * OCV5-890 Wave 1B — Layer 1 Storage Seam public barrel.
 * Explicit named exports only (R2-export-star compliant).
 */
export {
  InMemoryArtifactBlobStore,
  UniversalEngineStateCapsuleStore,
  hasPendingRestoreMarker,
  restoreMarkerPath,
} from './engineStateCapsuleStore.js'

export type {
  CapsulePromptCacheMeta,
  CapsuleSidecarMetadata,
  ChunkedArtifactBlobStore,
  ChunkedUploadPartReceipt,
  ChunkedUploadSession,
  DegradeToTranscriptRequest,
  DegradeToTranscriptResult,
  ExportCapsuleRequest,
  ExportCapsuleResult,
  ImportCapsuleRequest,
  ImportCapsuleResult,
  RelocatedCapsulePath,
  ResolveResumeLadderRequest,
  ResumeLadderResolution,
  UniversalEngineStateCapsuleStoreOptions,
} from './engineStateCapsuleStore.js'

export {
  buildAnchoredV2HandoffPackage,
  buildColdDegradedSuffix,
  encodeCcbProjectDir,
  persistNativeTranscriptArchive,
  rebuildNativeTranscriptArchive,
} from './tapeWarmRebuilder.js'

export type {
  AnchoredToolOutputEntry,
  AnchoredV2HandoffPackage,
  BuildAnchoredV2HandoffInput,
  BuildColdDegradedSuffixInput,
  ColdDegradedSuffixResult,
  ContextRebuiltNoticePayload,
  NativeTranscriptArchiveFormat,
  NativeTranscriptArchiveResult,
  RebuildNativeTranscriptArchiveInput,
  TapeRecordInput,
} from './tapeWarmRebuilder.js'

export {
  AuthorityStateBridge,
  InMemorySessionAuthorityStore,
  PlacementEpochConflictError,
} from './authorityStateBridge.js'

export type {
  AckRollingCheckpointInput,
  AckRollingCheckpointResult,
  AuthorityBridgeMetrics,
  AuthorityStateBridgeOptions,
  LocalCheckpointRecord,
  LocalCheckpointStoreAdapter,
  LocalPromptStateAdapter,
  LocalPromptStateRecord,
  LocalResumeStateEntry,
  LocalResumeStoreAdapter,
  PeekRollingCheckpointResult,
  ReadPointerResult,
  ReadPromptStateResult,
  SaveRollingCheckpointInput,
  SaveRollingCheckpointResult,
  WritePointerInput,
  WritePointerResult,
  WritePromptStateInput,
  WritePromptStateResult,
} from './authorityStateBridge.js'

export {
  CodedAuthorityRpcError,
  RemoteSessionAuthorityStore,
  isAuthorityEndpointUnsupportedError,
} from './remoteSessionAuthorityClient.js'
export type {
  AuthorityFetchImpl,
  NarrowCapsulePatchInput,
  NarrowResumePatchInput,
  RemoteSessionAuthorityStoreOptions,
} from './remoteSessionAuthorityClient.js'

export { RemoteArtifactBlobStore } from './remoteArtifactBlobClient.js'
export type {
  ArtifactBlobFetchImpl,
  RemoteArtifactBlobStoreOptions,
} from './remoteArtifactBlobClient.js'
