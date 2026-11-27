/**
 * OCV5-890 Layer 3 — Execution Environment runtime public barrel.
 * Explicit named re-exports only (R2-export-star compliant).
 */
export {
  BoundedDeltaStreamBuffer,
  EXEC_ENV_JOB_DEFAULT_CLOSE_DRAIN_MS,
  EXEC_ENV_JOB_DEFAULT_KILL_GRACE_MS,
  EXEC_ENV_JOB_DEFAULT_MAX_LIFETIME_MS,
  EXEC_ENV_JOB_DEFAULT_TOMBSTONE_MAX,
  EXEC_ENV_JOB_HEAD_BYTES,
  EXEC_ENV_JOB_MAX_OUTPUT_BYTES,
  EXEC_ENV_JOB_TAIL_BYTES,
  ExecEnvJobError,
  ExecEnvJobRegistry,
  hasAliveVerifiedProcessGroup,
  leadingContinuationUtf8Count,
  parseProcStatStartTimeTicks,
  readProcStartTimeTicks,
  trailingIncompleteUtf8Count,
} from './jobRegistry.js'
export type {
  BoundedDeltaReadResult,
  BoundedDeltaStreamBufferOptions,
  ExecEnvJobErrorCode,
  ExecEnvJobRegistryOptions,
  ExecEnvJobStartResult,
  ExecEnvMigrationTombstoneResult,
  ExecEnvReapStopProof,
  ExecEnvStartJobSpec,
  ExecEnvWaitJobAction,
  ExecEnvWaitJobResult,
  WaitJobOptions,
} from './jobRegistry.js'

export { ExecEnvLeaseError, ExecEnvLeaseManager } from './execEnvLease.js'
export type {
  AttachmentDigestSnapshotProviders,
  ExecEnvIncarnationRecord,
  ExecEnvLeaseErrorCode,
  ExecEnvLeaseManagerOptions,
  ExecEnvLeaseRecord,
  ExecEnvLeaseState,
  ExecEnvLiveBrowserSnapshot,
  ExecEnvPreviewPort,
  ExecEnvRepoBinding,
  ExecEnvRuntimeAttachmentDigest,
  IssueExecEnvLeaseInput,
  RebindBrainResult,
} from './execEnvLease.js'

export {
  SCOPED_CAPABILITY_TOKEN_PREFIX,
  ScopedCapabilityTokenAuthority,
  ScopedCapabilityTokenError,
  constantTimeBytesEqual,
  rfc2104HmacSha256,
} from './scopedCapabilityToken.js'
export type {
  IssueScopedCapabilityTokenInput,
  ScopedCapabilityTokenAuthorityOptions,
  ScopedCapabilityTokenErrorCode,
  ScopedToolCapabilityClaims,
  VerifyScopedCapabilityTokenExpected,
} from './scopedCapabilityToken.js'

export {
  TOOL_BROKER_DEFAULT_DETACHED_FALLBACK_MS,
  TOOL_BROKER_DEFAULT_MAX_CONCURRENCY,
  TOOL_BROKER_DEFAULT_MAX_INLINE_PAYLOAD_BYTES,
  ToolBrokerPolicyError,
  ToolBrokerServer,
} from './toolBroker.js'
export type {
  DetachedApprovalCard,
  RegisteredToolDefinition,
  SpilledBlobRefOutput,
  ToolApprovalDecision,
  ToolApprovalHandler,
  ToolApprovalRequest,
  ToolBrokerInvokeRequest,
  ToolBrokerResultEnvelope,
  ToolBrokerServerOptions,
  ToolExecutionContext,
  ToolHandler,
  ToolSpillBlobFn,
} from './toolBroker.js'

export {
  ContainerLinkToolBrokerClient,
  ContainerLinkToolBrokerHost,
  ToolBrokerTransportError,
  createInMemoryFrameLinkPair,
  openChannel,
  parseToolBrokerWireFrame,
} from './containerLinkBrokerTransport.js'
export type {
  ContainerLinkToolBrokerClientOptions,
  ContainerLinkToolBrokerHostOptions,
  FrameLinkLike,
  OpenToolBrokerChannelOptions,
  ToolBrokerWireFrame,
} from './containerLinkBrokerTransport.js'
