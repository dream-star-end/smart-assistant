/**
 * OCV5-890 Layer 3 — Execution Environment public barrel.
 * Explicit named re-exports only (R2-export-star compliant).
 */
export {
  DUAL_POOL_PARITY_DIMENSIONS,
  EXECUTION_POLICY_MODES,
  EXEC_ENV_CHANNEL_KINDS,
  EXEC_ENV_HOST_KINDS,
  JOB_LIFECYCLE_CLASSES,
  SANDBOX_RED_CONTROL_IDS,
  TOOL_CALL_ATTESTATION_KINDS,
  defaultCapabilitiesForHostKind,
} from './contracts.js'

export type {
  DualPoolParityDimension,
  ExecEnvAttachmentDigest,
  ExecEnvCapabilities,
  ExecEnvChannelKind,
  ExecEnvHandle,
  ExecEnvHostKind,
  ExecEnvLease,
  ExecEnvStopProof,
  ExecutionPolicyEnvelope,
  ExecutionPolicyMode,
  JobLifecycleClass,
  JobOutcome,
  JobOutputDelta,
  JobStartResult,
  ManagedJobSummary,
  OpenToolBrokerChannelRequest,
  ProcessJobSeam,
  SandboxRedControlId,
  ScopedCapabilityTokenClaims,
  StartJobSpec,
  ToolBrokerTransport,
  ToolCallAttestation,
  ToolCallAttestationKind,
  ToolCallEnvelope,
  ToolCatalogEntry,
  ToolResultEnvelope,
  ToolStreamFrame,
  WorkspaceSeam,
  WorkspaceStatResult,
} from './contracts.js'

export {
  CANONICAL_READ_ONLY_TOOLS,
  SCHEMA_FILTERED_HASH_GOLDEN_VECTORS,
  computeSchemaFilteredArgsSha256,
  computeToolIdempotencyKey,
  filterArgsByInputSchema,
  isExecutionPolicyMonotonicTightening,
  isReadOnlyAllowedCanonicalTool,
  validateExecutionPolicyEnvelope,
  validateToolCallEnvelope,
} from './validators.js'

export type { SchemaFilteredHashGoldenVector } from './validators.js'

export {
  ContainerLinkToolBrokerClient,
  TOOL_BROKER_LOCAL_PREFIX,
  ToolBrokerTransportError,
  createInMemoryFrameLinkPair,
  isLoopbackBrokerUrl,
  isReservedToolBrokerFrame,
  isToolBrokerWireFrame,
  openExecEnvToolBrokerChannel,
  parseToolBrokerWireFrame,
  scrubToolBrokerEnv,
} from './brokerChannel.js'

export type {
  ContainerLinkToolBrokerClientOptions,
  FrameLinkLike,
  OpenToolBrokerChannelOptions,
  ToolBrokerRebindAck,
  ToolBrokerWireFrame,
} from './brokerChannel.js'

export {
  isParsedProcAlive,
  parseProcStatFull,
  parseProcStatStartTimeTicks,
  verifyProcGroupByStartTicks,
} from './procGroupIdentity.js'

export type { ParsedProcStat, ProcGroupVerifyReader } from './procGroupIdentity.js'
