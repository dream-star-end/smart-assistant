/**
 * OCV5-890 Layer 3 — Execution Environment pure protocol contracts.
 *
 * L0 Contract Invariant (R2-contract-node): ZERO `node:*` imports allowed.
 * Binary payloads use standard ES `Uint8Array`.
 */

export const EXEC_ENV_HOST_KINDS = [
  'local-docker',
  'compute-pool-docker',
  'desktop-virtual',
] as const
export type ExecEnvHostKind = (typeof EXEC_ENV_HOST_KINDS)[number]

export const EXEC_ENV_CHANNEL_KINDS = [
  'uds_jsonrpc',
  'ws_tunnel',
  'loopback_http',
  'stdio_pipe',
] as const
export type ExecEnvChannelKind = (typeof EXEC_ENV_CHANNEL_KINDS)[number]

export const TOOL_CALL_ATTESTATION_KINDS = [
  'gateway_signed_grant',
  'dual_channel_observed',
  'schema_filtered_hook',
] as const
export type ToolCallAttestationKind = (typeof TOOL_CALL_ATTESTATION_KINDS)[number]

export const JOB_LIFECYCLE_CLASSES = [
  'ephemeral_turn',
  'managed_job',
  'daemon_service',
] as const
export type JobLifecycleClass = (typeof JOB_LIFECYCLE_CLASSES)[number]

export const EXECUTION_POLICY_MODES = [
  'normal',
  'read_only',
  'hermetic_no_tools',
] as const
export type ExecutionPolicyMode = (typeof EXECUTION_POLICY_MODES)[number]

export const SANDBOX_RED_CONTROL_IDS = [
  'R1',
  'R2',
  'R3',
  'R4a',
  'R4b',
  'R5',
  'R6',
  'R7',
  'R8',
  'R9',
  'R10',
  'R11',
] as const
export type SandboxRedControlId = (typeof SANDBOX_RED_CONTROL_IDS)[number]

export const DUAL_POOL_PARITY_DIMENSIONS = [
  'tool_call_attestation',
  'read_only_enforcement',
  'policy_monotonic_tightening',
  'usage_normalization',
  'receipt_digest_verification',
  'capsule_portability',
  'sticky_home_affinity',
  'context_compaction_signal',
  'service_tier_fidelity',
  'multimodal_input',
] as const
export type DualPoolParityDimension = (typeof DUAL_POOL_PARITY_DIMENSIONS)[number]

export interface ExecEnvCapabilities {
  readonly hostKind: ExecEnvHostKind
  readonly supportedChannels: readonly ExecEnvChannelKind[]
  readonly supportsManagedJobs: boolean
  readonly supportsDaemonServices: boolean
  readonly supportsWorkspaceSnapshots: boolean
  readonly supportsNetworkIsolation: boolean
  readonly supportsSeccompProfile: boolean
  readonly maxConcurrentJobs: number
}

export interface ExecEnvLease {
  readonly leaseId: string
  readonly tenantId: string
  readonly sessionKey: string
  readonly hostKind: ExecEnvHostKind
  readonly envId: string
  readonly placementEpoch: number
  readonly issuedAt: string
  readonly expiresAt: string
}

export interface ExecEnvAttachmentDigest {
  readonly leaseId: string
  readonly channelKind: ExecEnvChannelKind
  readonly workspaceTreeSha256: string
  readonly policyDigest: string
  readonly toolCatalogSha256: string
  readonly attachedAt: string
}

export interface ExecEnvStopProof {
  readonly leaseId: string
  readonly envId: string
  readonly reason: 'completed' | 'revoked' | 'timeout' | 'host_evicted' | 'error'
  readonly activeJobsTerminated: number
  readonly finalWorkspaceTreeSha256?: string | null
  readonly stoppedAt: string
  readonly proofDigest: string
}

export interface ExecEnvHandle {
  readonly envId: string
  readonly lease: ExecEnvLease
  readonly capabilities: ExecEnvCapabilities
  readonly attachment: ExecEnvAttachmentDigest
}

export interface ToolCatalogEntry {
  readonly canonicalName: string
  readonly aliasName?: string
  readonly description?: string
  readonly inputSchema?: Readonly<Record<string, unknown>>
  readonly readOnly?: boolean
  readonly idempotent?: boolean
}

export interface ToolCallAttestation {
  readonly kind: ToolCallAttestationKind
  readonly argsSha256: string
  readonly observedAt: string
  readonly grantId?: string
  readonly rawFrameSha256?: string
  readonly filteredKeys?: readonly string[]
}

export interface ToolCallEnvelope {
  readonly schemaVersion: 1
  readonly leaseId: string
  readonly turnId: string
  readonly callId: string
  readonly idempotencyKey: string
  readonly canonicalName: string
  readonly arguments: Readonly<Record<string, unknown>>
  readonly argsSha256: string
  readonly attestation: ToolCallAttestation
  readonly timeoutMs?: number
}

export interface ToolResultEnvelope {
  readonly schemaVersion: 1
  readonly leaseId: string
  readonly turnId: string
  readonly callId: string
  readonly idempotencyKey: string
  readonly status: 'ok' | 'error' | 'denied' | 'timeout'
  readonly output?: unknown
  readonly errorCode?: string
  readonly errorMessage?: string
  readonly durationMs: number
  readonly spilledBlobId?: string
}

export type ToolStreamFrame =
  | { readonly kind: 'tool_call'; readonly envelope: ToolCallEnvelope; readonly seq: number }
  | { readonly kind: 'tool_stdout'; readonly callId: string; readonly chunk: string; readonly seq: number }
  | { readonly kind: 'tool_stderr'; readonly callId: string; readonly chunk: string; readonly seq: number }
  | { readonly kind: 'tool_result'; readonly envelope: ToolResultEnvelope; readonly seq: number }
  | { readonly kind: 'tool_cancel'; readonly callId: string; readonly reason: string; readonly seq: number }

export interface ToolBrokerTransport {
  readonly channelKind: ExecEnvChannelKind
  invoke(call: ToolCallEnvelope): Promise<ToolResultEnvelope>
  stream?(call: ToolCallEnvelope): AsyncIterable<ToolStreamFrame>
  cancel(callId: string, reason: string): Promise<void>
}

export interface WorkspaceStatResult {
  readonly exists: boolean
  readonly isDirectory: boolean
  readonly sizeBytes: number
  readonly mtimeMs: number
}

export interface WorkspaceSeam {
  readFile(relativePath: string): Promise<Uint8Array>
  writeFile(relativePath: string, content: Uint8Array): Promise<void>
  stat(relativePath: string): Promise<WorkspaceStatResult>
  listDir(relativePath: string): Promise<readonly string[]>
  snapshot(): Promise<{
    readonly treeSha256: string
    readonly fileCount: number
    readonly totalBytes: number
  }>
}

export interface StartJobSpec {
  readonly jobId?: string
  readonly leaseId: string
  readonly lifecycleClass: JobLifecycleClass
  readonly command: readonly string[]
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
  readonly label?: string
}

export interface JobStartResult {
  readonly jobId: string
  readonly leaseId: string
  readonly lifecycleClass: JobLifecycleClass
  readonly pid?: number
  readonly startedAt: string
}

export interface JobOutputDelta {
  readonly jobId: string
  readonly stream: 'stdout' | 'stderr'
  readonly chunk: string
  readonly seq: number
  readonly ts: string
}

export interface JobOutcome {
  readonly jobId: string
  readonly status: 'exited' | 'killed' | 'timed_out' | 'failed'
  readonly exitCode: number | null
  readonly signal?: string | null
  readonly durationMs: number
  readonly finishedAt: string
}

export interface ManagedJobSummary {
  readonly jobId: string
  readonly leaseId: string
  readonly lifecycleClass: JobLifecycleClass
  readonly state: 'running' | 'exited' | 'killed' | 'timed_out' | 'failed'
  readonly label?: string
  readonly startedAt: string
  readonly finishedAt?: string | null
}

export interface ProcessJobSeam {
  startJob(spec: StartJobSpec): Promise<JobStartResult>
  streamOutput(jobId: string, sinceSeq?: number): AsyncIterable<JobOutputDelta>
  waitJob(jobId: string): Promise<JobOutcome>
  killJob(jobId: string, signal?: string): Promise<boolean>
  listJobs(leaseId: string): Promise<readonly ManagedJobSummary[]>
}

export interface ExecutionPolicyEnvelope {
  readonly schemaVersion: 1
  readonly mode: ExecutionPolicyMode
  readonly allowedTools: readonly string[]
  readonly deniedTools?: readonly string[]
  readonly allowNetworkEgress: boolean
  readonly allowWorkspaceWrite: boolean
  readonly allowSubprocessSpawn: boolean
  readonly maxToolCallsPerTurn?: number
  readonly policyDigest?: string
}

export interface ScopedCapabilityTokenClaims {
  readonly tokenId: string
  readonly leaseId: string
  readonly tenantId: string
  readonly sessionKey: string
  readonly allowedTools: readonly string[]
  readonly mode: ExecutionPolicyMode
  readonly issuedAt: number
  readonly expiresAt: number
}
