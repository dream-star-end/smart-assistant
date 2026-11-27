/**
 * OCV5-890 Layer 3 — Unified ToolBrokerServer (`ToolBrokerTransport`).
 *
 * Single front door for BOTH Local Pool and Remote Pool tool invocations enforcing 7 gates:
 * 1. Lease & FencingToken validation (R10) + optional R8 ScopedCapabilityToken verification
 * 2. Monotonic ExecutionPolicy guard (R9): `hermetic_no_tools`, `read_only`, `allowedTools`
 * 3. Schema-filtered args SHA-256 verification (R11 / OCV5-800)
 * 4. Unified ActionPolicy (4-tier + `blocking_then_detached`) + Compound Shell hook guard (R9)
 * 5. Idempotency WAL (cached receipt on completed replay; `unknown_effect_fenced` fail-closed on in-flight/interrupted)
 * 6. Multi-concurrency execution semaphore (default 8) + cooperative cancellation
 * 7. Large output auto-spill to `blob_ref` (default > 256 KiB)
 *
 * Architecture invariants:
 * - R3-env / R3-crypto / R3-net / R3-special-case: zero violations.
 * - R2-same-layer: only imports L0 `@openclaude/protocol` and same-module `gateway-runtime` helpers.
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import {
  DEFAULT_ACTION_POLICY,
  computeSchemaFilteredArgsSha256,
  computeToolIdempotencyKey,
  isExecutionPolicyMonotonicTightening,
  isReadOnlyAllowedCanonicalTool,
  validateExecutionPolicyEnvelope,
  type ActionPolicyEvaluation,
  type ExecEnvChannelKind,
  type ExecutionPolicyEnvelope,
  type ToolBrokerTransport,
  type ToolCallEnvelope,
  type ToolCatalogEntry,
  type ToolResultEnvelope,
  type ToolStreamFrame,
} from '@openclaude/protocol'
import {
  evaluateActionPolicy,
  type AiReviewHook,
  type LoadedActionPolicy,
} from '../actionPolicyEngine.js'
import { evaluateShellForHook, type GuardMode } from '../agentEfficiencyGuard.js'
import { ExecEnvLeaseError, type ExecEnvLeaseManager } from './execEnvLease.js'
import {
  ScopedCapabilityTokenError,
  type ScopedCapabilityTokenAuthority,
} from './scopedCapabilityToken.js'
import {
  ToolBrokerDiskSpillStore,
  type DiskSpillReadResult,
  type VerifiedSpillBlobPayload,
} from './toolBrokerDiskSpill.js'

export const TOOL_BROKER_DEFAULT_MAX_CONCURRENCY = 8
export const TOOL_BROKER_DEFAULT_MAX_INLINE_PAYLOAD_BYTES = 256 * 1024
export const TOOL_BROKER_DEFAULT_DETACHED_FALLBACK_MS = 55_000

const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set([
  'bash',
  'shell',
  'oc_bash',
  'run_command',
  'exec_command',
  'terminal',
])

export class ToolBrokerPolicyError extends Error {
  readonly code: string

  constructor(code: string, message?: string) {
    super(message ?? code)
    this.name = 'ToolBrokerPolicyError'
    this.code = code
  }
}

export interface ToolBrokerInvokeRequest extends ToolCallEnvelope {
  readonly fencingToken?: string
  readonly brainGen?: number
  readonly sessionKey?: string
  readonly capabilityToken?: string
  /** Optional explicit alias for schema-filtered args digest (falls back to `argsSha256`). */
  readonly argsSchemaSha256?: string
  readonly mainModel?: string
}

export interface SpilledBlobRefOutput {
  readonly type: 'blob_ref'
  readonly blobId: string
  readonly sha256: string
  readonly mimeType: string
  readonly bytes: number
  readonly byteLength?: number
}

export interface DetachedApprovalCard {
  readonly approvalId: string
  readonly leaseId: string
  readonly callId: string
  readonly toolName: string
  readonly reason: string
  readonly evaluation: ActionPolicyEvaluation
  readonly createdAtMs: number
}

export interface ToolBrokerResultEnvelope extends ToolResultEnvelope {
  readonly replayStatus?: 'executed' | 'cached_receipt' | 'unknown_effect_fenced'
  readonly approvalStatus?: 'not_required' | 'approved' | 'denied' | 'detached_pending'
  readonly detachedCard?: DetachedApprovalCard
  readonly isError?: boolean
}

export interface ToolExecutionContext {
  readonly leaseId: string
  readonly sessionKey: string
  readonly callId: string
  readonly turnId: string
  readonly idempotencyKey: string
  readonly signal: AbortSignal
  readonly emitStdout: (chunk: string) => void
  readonly emitStderr: (chunk: string) => void
}

export type ToolHandler = (
  args: Readonly<Record<string, unknown>>,
  ctx: ToolExecutionContext,
) => Promise<unknown> | unknown

export interface RegisteredToolDefinition extends ToolCatalogEntry {
  readonly isShell?: boolean
  readonly handler: ToolHandler
}

export interface ToolApprovalRequest {
  readonly approvalId: string
  readonly leaseId: string
  readonly sessionKey: string
  readonly callId: string
  readonly toolName: string
  readonly arguments: Readonly<Record<string, unknown>>
  readonly command?: string
  readonly evaluation: ActionPolicyEvaluation
}

export type ToolApprovalDecision =
  | { readonly decision: 'approve'; readonly reason?: string }
  | { readonly decision: 'deny'; readonly reason?: string }

export type ToolApprovalHandler = (
  request: ToolApprovalRequest,
  signal: AbortSignal,
) => Promise<ToolApprovalDecision>

export type ToolSpillBlobFn = (
  bytes: Uint8Array,
  mimeType: string,
) => Promise<{
  readonly blobId: string
  readonly sha256?: string
  readonly mimeType?: string
  readonly bytes?: number
}>

export type ToolReadSpilledBlobFn = (
  blobId: string,
  expectedSha256?: string,
) =>
  | Promise<{ readonly bytes: Uint8Array; readonly mimeType: string; readonly sha256?: string } | null>
  | { readonly bytes: Uint8Array; readonly mimeType: string; readonly sha256?: string }
  | null

export interface ToolBrokerDurableWalAdapter {
  readonly durable: true
  writeAttempt(record: DiskWalAttemptRecord): 'created' | 'exists'
  writeResult(record: DiskWalResultRecord): void
  readAttempt(idempotencyKey: string): DiskWalAttemptRecord | null
  readResult(idempotencyKey: string): DiskWalResultRecord | null
  writeSpilledBlob?(
    blobId: string,
    bytes: Uint8Array,
    meta: { readonly sha256: string; readonly mimeType: string; readonly byteLength: number },
  ): void
  readSpilledBlob?(
    blobId: string,
    expectedSha256?: string,
  ): { readonly bytes: Uint8Array; readonly mimeType: string; readonly sha256?: string } | null
}

export interface ToolBrokerServerOptions {
  readonly channelKind?: ExecEnvChannelKind
  readonly leaseManager?: ExecEnvLeaseManager
  readonly requireFencingToken?: boolean
  readonly capabilityAuthority?: ScopedCapabilityTokenAuthority
  readonly requireCapabilityToken?: boolean
  readonly defaultPolicy?: ExecutionPolicyEnvelope
  readonly loadedActionPolicy?: LoadedActionPolicy
  readonly aiReviewHook?: AiReviewHook
  readonly trustedStrongModels?: readonly string[]
  readonly defaultMainModel?: string
  readonly shellHookGuardMode?: GuardMode
  readonly approvalHandler?: ToolApprovalHandler
  readonly detachedFallbackAfterMs?: number
  readonly onDetachedApprovalCard?: (card: DetachedApprovalCard) => void
  readonly maxConcurrentToolCalls?: number
  readonly maxInlinePayloadBytes?: number
  readonly spillBlob?: ToolSpillBlobFn
  readonly readSpilledBlob?: ToolReadSpilledBlobFn
  readonly walDir?: string
  readonly durableWalAdapter?: ToolBrokerDurableWalAdapter
  /**
   * B13: By default, non-readOnly (side-effecting) tools require a persistent `walDir` or
   * `durableWalAdapter` so crashes/restarts never re-execute side effects. Explicit opt-in only
   * for ephemeral unit tests.
   */
  readonly allowEphemeralSideEffects?: boolean
  readonly clock?: () => number
}

interface WalEntry {
  readonly idempotencyKey: string
  readonly leaseId: string
  readonly callId: string
  readonly argsSchemaSha256: string
  state: 'in_flight' | 'completed' | 'interrupted'
  receipt?: ToolBrokerResultEnvelope
}

export interface DiskWalAttemptRecord {
  readonly schemaVersion: 1
  readonly idempotencyKey: string
  readonly callId: string
  readonly toolName: string
  readonly argsSchemaSha256: string
  readonly leaseId: string
  readonly brainGen: number | null
  readonly createdAtMs: number
}

export interface DiskWalResultRecord {
  readonly schemaVersion: 1
  readonly idempotencyKey: string
  readonly callId: string
  readonly toolName: string
  readonly argsSchemaSha256: string
  readonly leaseId: string
  readonly brainGen: number | null
  readonly receipt: ToolBrokerResultEnvelope
  readonly finalizedAtMs: number
}

const SAFE_WAL_KEY_RE = /^[A-Za-z0-9._-]{1,128}$/

function walSafeKey(idempotencyKey: string): string {
  if (SAFE_WAL_KEY_RE.test(idempotencyKey)) {
    return idempotencyKey
  }
  return createHash('sha256').update(idempotencyKey, 'utf8').digest('hex')
}

function fsyncDirSync(dirPath: string): void {
  let dirFd: number | undefined
  try {
    const flags = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0)
    dirFd = openSync(dirPath, flags)
    fsyncSync(dirFd)
  } finally {
    if (dirFd !== undefined) closeSync(dirFd)
  }
}

function writeAllSync(fd: number, buf: Buffer): void {
  let offset = 0
  while (offset < buf.length) {
    offset += writeSync(fd, buf, offset, buf.length - offset)
  }
}

function isWalEntryInterrupted(entry: WalEntry | null): boolean {
  return entry !== null && entry.state === 'interrupted'
}

function readRegularJsonFileSync<T>(filePath: string): { readonly exists: boolean; readonly data?: T; readonly corrupt?: boolean } {
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(filePath)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') return { exists: false }
    throw err
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return { exists: true, corrupt: true }
  }
  try {
    const raw = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw) as T
    return { exists: true, data: parsed }
  } catch {
    return { exists: true, corrupt: true }
  }
}

interface InFlightCall {
  readonly callId: string
  readonly leaseId: string
  readonly idempotencyKey: string
  readonly controller: AbortController
  cancelReason?: string
  onCancel?: (reason: string) => void
}

class AsyncSemaphore {
  private readonly limit: number
  private active = 0
  private readonly queue: Array<{
    readonly resolve: () => void
    readonly reject: (err: Error) => void
    readonly signal?: AbortSignal
    readonly onAbort?: () => void
  }> = []

  constructor(limit: number) {
    this.limit = Math.max(1, Math.floor(limit))
  }

  get currentActive(): number {
    return this.active
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      throw new Error(String(signal.reason ?? 'TOOL_CALL_CANCELLED'))
    }
    if (this.active < this.limit) {
      this.active += 1
      return this.makeRelease()
    }
    await new Promise<void>((resolve, reject) => {
      const entry: {
        resolve: () => void
        reject: (err: Error) => void
        signal?: AbortSignal
        onAbort?: () => void
      } = { resolve, reject, signal }

      if (signal) {
        const onAbort = () => {
          const idx = this.queue.indexOf(entry)
          if (idx >= 0) this.queue.splice(idx, 1)
          reject(new Error(String(signal.reason ?? 'TOOL_CALL_CANCELLED')))
        }
        entry.onAbort = onAbort
        signal.addEventListener('abort', onAbort, { once: true })
      }
      this.queue.push(entry)
    })
    this.active += 1
    return this.makeRelease()
  }

  private makeRelease(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.active = Math.max(0, this.active - 1)
      const next = this.queue.shift()
      if (next) {
        if (next.signal && next.onAbort) {
          next.signal.removeEventListener('abort', next.onAbort)
        }
        next.resolve()
      }
    }
  }
}

function defaultInMemoryLoadedActionPolicy(): LoadedActionPolicy {
  return {
    ok: true,
    source: 'default',
    path: '<in-memory-default>',
    policy: {
      ...DEFAULT_ACTION_POLICY,
      rules: [...DEFAULT_ACTION_POLICY.rules],
    },
    warnings: [],
  }
}

function extractShellCommand(args: Readonly<Record<string, unknown>>): string | undefined {
  for (const key of ['command', 'CommandLine', 'cmd', 'script']) {
    const val = args[key]
    if (typeof val === 'string' && val.trim().length > 0) {
      return val
    }
  }
  return undefined
}

function isShellTool(canonicalName: string, entry?: RegisteredToolDefinition): boolean {
  if (entry?.isShell) return true
  return SHELL_TOOL_NAMES.has(canonicalName.toLowerCase())
}

function serializeOutputForSpill(output: unknown): {
  readonly bytes: Uint8Array
  readonly mimeType: string
} {
  if (output instanceof Uint8Array) {
    return { bytes: output, mimeType: 'application/octet-stream' }
  }
  if (typeof output === 'string') {
    return { bytes: Buffer.from(output, 'utf8'), mimeType: 'text/plain; charset=utf-8' }
  }
  const encoded = JSON.stringify(output ?? null)
  return { bytes: Buffer.from(encoded, 'utf8'), mimeType: 'application/json; charset=utf-8' }
}

export class ToolBrokerServer implements ToolBrokerTransport {
  readonly channelKind: ExecEnvChannelKind
  readonly maxConcurrentToolCalls: number
  readonly maxInlinePayloadBytes: number
  readonly detachedFallbackAfterMs: number

  private readonly leaseManager?: ExecEnvLeaseManager
  private readonly requireFencingToken: boolean
  private readonly capabilityAuthority?: ScopedCapabilityTokenAuthority
  private readonly requireCapabilityToken: boolean
  private readonly defaultPolicy?: ExecutionPolicyEnvelope
  private readonly loadedActionPolicy: LoadedActionPolicy
  private readonly aiReviewHook?: AiReviewHook
  private readonly trustedStrongModels?: readonly string[]
  private readonly defaultMainModel?: string
  private readonly shellHookGuardMode: GuardMode
  private readonly approvalHandler?: ToolApprovalHandler
  private readonly onDetachedApprovalCard?: (card: DetachedApprovalCard) => void
  private readonly spillBlob?: ToolSpillBlobFn
  private readonly readSpilledBlob?: ToolReadSpilledBlobFn
  private readonly walDir?: string
  private readonly durableWalAdapter?: ToolBrokerDurableWalAdapter
  private readonly diskSpillStore?: ToolBrokerDiskSpillStore
  private readonly allowEphemeralSideEffects: boolean
  private readonly clock: () => number

  private readonly tools = new Map<string, RegisteredToolDefinition>()
  private readonly policies = new Map<string, ExecutionPolicyEnvelope>()
  private readonly wal = new Map<string, WalEntry>()
  private readonly inFlight = new Map<string, InFlightCall>()
  private readonly fallbackSpillStore = new Map<
    string,
    { bytes: Uint8Array; mimeType: string; sha256: string; byteLength: number }
  >()
  private readonly semaphore: AsyncSemaphore
  private peakConcurrency = 0

  constructor(opts: ToolBrokerServerOptions = {}) {
    this.channelKind = opts.channelKind ?? 'ws_tunnel'
    this.leaseManager = opts.leaseManager
    this.requireFencingToken = opts.requireFencingToken ?? Boolean(opts.leaseManager)
    this.capabilityAuthority = opts.capabilityAuthority
    this.requireCapabilityToken = opts.requireCapabilityToken ?? Boolean(opts.capabilityAuthority)
    this.defaultPolicy = opts.defaultPolicy
      ? validateExecutionPolicyEnvelope(opts.defaultPolicy)
      : undefined
    this.loadedActionPolicy = opts.loadedActionPolicy ?? defaultInMemoryLoadedActionPolicy()
    this.aiReviewHook = opts.aiReviewHook
    this.trustedStrongModels = opts.trustedStrongModels
    this.defaultMainModel = opts.defaultMainModel
    this.shellHookGuardMode = opts.shellHookGuardMode ?? 'deny'
    this.approvalHandler = opts.approvalHandler
    this.detachedFallbackAfterMs = Math.max(
      1,
      Math.floor(opts.detachedFallbackAfterMs ?? TOOL_BROKER_DEFAULT_DETACHED_FALLBACK_MS),
    )
    this.onDetachedApprovalCard = opts.onDetachedApprovalCard
    this.maxConcurrentToolCalls = Math.max(
      1,
      Math.floor(opts.maxConcurrentToolCalls ?? TOOL_BROKER_DEFAULT_MAX_CONCURRENCY),
    )
    this.maxInlinePayloadBytes = Math.max(
      1,
      Math.floor(opts.maxInlinePayloadBytes ?? TOOL_BROKER_DEFAULT_MAX_INLINE_PAYLOAD_BYTES),
    )
    this.spillBlob = opts.spillBlob
    this.readSpilledBlob = opts.readSpilledBlob
    if (typeof opts.walDir === 'string' && opts.walDir.trim().length > 0) {
      const resolvedWalDir = resolve(opts.walDir)
      mkdirSync(resolvedWalDir, { recursive: true, mode: 0o700 })
      const st = lstatSync(resolvedWalDir)
      if (!st.isDirectory() || st.isSymbolicLink()) {
        throw new ToolBrokerPolicyError(
          'TOOL_WAL_DIR_INVALID',
          `WAL directory path is not a regular directory: ${resolvedWalDir}`,
        )
      }
      this.walDir = resolvedWalDir
      this.diskSpillStore = new ToolBrokerDiskSpillStore(resolvedWalDir)
    }
    if (opts.durableWalAdapter?.durable === true) {
      this.durableWalAdapter = opts.durableWalAdapter
    }
    this.allowEphemeralSideEffects = opts.allowEphemeralSideEffects === true
    this.clock = opts.clock ?? (() => Date.now())
    this.semaphore = new AsyncSemaphore(this.maxConcurrentToolCalls)
  }

  get hasDurableWal(): boolean {
    return this.walDir !== undefined || this.durableWalAdapter !== undefined
  }

  get hasDurableSpillStorage(): boolean {
    // B13: Reject unpaired external spillBlob override (writer without matching reader),
    // which would otherwise write to external storage while public reads hit a different store.
    if (this.spillBlob !== undefined) {
      return this.readSpilledBlob !== undefined
    }
    if (this.walDir !== undefined) return true
    if (
      typeof this.durableWalAdapter?.writeSpilledBlob === 'function' &&
      typeof this.durableWalAdapter?.readSpilledBlob === 'function'
    ) {
      return true
    }
    return false
  }

  registerTool(def: RegisteredToolDefinition): void {
    this.tools.set(def.canonicalName, def)
  }

  listCatalog(): readonly ToolCatalogEntry[] {
    const entries: ToolCatalogEntry[] = []
    for (const def of this.tools.values()) {
      entries.push({
        canonicalName: def.canonicalName,
        ...(def.aliasName === undefined ? {} : { aliasName: def.aliasName }),
        ...(def.description === undefined ? {} : { description: def.description }),
        ...(def.inputSchema === undefined ? {} : { inputSchema: def.inputSchema }),
        ...(def.readOnly === undefined ? {} : { readOnly: def.readOnly }),
        ...(def.idempotent === undefined ? {} : { idempotent: def.idempotent }),
      })
    }
    return entries
  }

  /**
   * Monotonically tightens the active ExecutionPolicy for `leaseId`.
   * Rejects any attempt to relax mode, tool allowlist, or privilege flags during runtime.
   */
  setPolicy(leaseId: string, policy: ExecutionPolicyEnvelope): ExecutionPolicyEnvelope {
    const validated = validateExecutionPolicyEnvelope(policy)
    const existing = this.policies.get(leaseId) ?? this.defaultPolicy
    if (existing && !isExecutionPolicyMonotonicTightening(existing, validated)) {
      throw new ToolBrokerPolicyError(
        'EXEC_POLICY_RELAXATION_FORBIDDEN',
        `Policy update for lease ${leaseId} violates monotonic tightening`,
      )
    }
    this.policies.set(leaseId, validated)
    return validated
  }

  getPolicy(leaseId: string): ExecutionPolicyEnvelope | null {
    return this.policies.get(leaseId) ?? this.defaultPolicy ?? null
  }

  getSpilledBlob(
    blobIdOrSha256: string,
  ): {
    readonly bytes: Uint8Array
    readonly mimeType: string
    readonly sha256?: string
    readonly byteLength?: number
  } | null {
    if (this.diskSpillStore !== undefined) {
      const diskRes = this.diskSpillStore.readAndVerifySync({ blobId: blobIdOrSha256 })
      if (!diskRes.ok) {
        return null
      }
      return {
        bytes: diskRes.bytes,
        mimeType: diskRes.mimeType,
        sha256: diskRes.sha256,
        byteLength: diskRes.byteLength,
      }
    }
    if (typeof this.durableWalAdapter?.readSpilledBlob === 'function') {
      const stored = this.durableWalAdapter.readSpilledBlob(blobIdOrSha256)
      if (!stored) return null
      const actualSha = createHash('sha256').update(stored.bytes).digest('hex')
      if (stored.sha256 !== undefined && actualSha !== stored.sha256) return null
      return {
        bytes: new Uint8Array(stored.bytes),
        mimeType: stored.mimeType,
        sha256: actualSha,
        byteLength: stored.bytes.byteLength,
      }
    }
    return this.fallbackSpillStore.get(blobIdOrSha256) ?? null
  }

  readSpilledBlobVerified(blobIdOrRef: string | SpilledBlobRefOutput): VerifiedSpillBlobPayload {
    const query: {
      readonly blobId: string
      readonly sha256?: string
      readonly expectedBytes?: number
      readonly fallbackMimeType?: string
    } =
      typeof blobIdOrRef === 'string'
        ? { blobId: blobIdOrRef }
        : {
            blobId: blobIdOrRef.blobId,
            sha256: blobIdOrRef.sha256,
            expectedBytes: blobIdOrRef.byteLength ?? blobIdOrRef.bytes,
            fallbackMimeType: blobIdOrRef.mimeType,
          }
    if (this.diskSpillStore !== undefined) {
      const diskRes: DiskSpillReadResult = this.diskSpillStore.readAndVerifySync(query)
      if (!diskRes.ok) {
        throw new ToolBrokerPolicyError(diskRes.errorCode, diskRes.message)
      }
      return {
        blobId: diskRes.blobId,
        sha256: diskRes.sha256,
        mimeType: diskRes.mimeType,
        bytes: diskRes.bytes,
        byteLength: diskRes.byteLength,
      }
    }
    if (typeof this.durableWalAdapter?.readSpilledBlob === 'function') {
      const stored = this.durableWalAdapter.readSpilledBlob(query.blobId, query.sha256)
      if (!stored) {
        throw new ToolBrokerPolicyError(
          'TOOL_SPILLED_BLOB_MISSING',
          `Spilled blob "${query.blobId}" not found in durable WAL adapter spill store`,
        )
      }
      return this.verifySpillBytesOrThrow(query, stored)
    }
    const mem = this.fallbackSpillStore.get(query.blobId)
    if (!mem) {
      throw new ToolBrokerPolicyError(
        'TOOL_SPILLED_BLOB_MISSING',
        `Spilled blob "${query.blobId}" not found in memory spill store`,
      )
    }
    return this.verifySpillBytesOrThrow(query, mem)
  }

  async readSpilledBlobVerifiedAsync(
    blobIdOrRef: string | SpilledBlobRefOutput,
  ): Promise<VerifiedSpillBlobPayload> {
    const query: {
      readonly blobId: string
      readonly sha256?: string
      readonly expectedBytes?: number
      readonly fallbackMimeType?: string
    } =
      typeof blobIdOrRef === 'string'
        ? { blobId: blobIdOrRef }
        : {
            blobId: blobIdOrRef.blobId,
            sha256: blobIdOrRef.sha256,
            expectedBytes: blobIdOrRef.byteLength ?? blobIdOrRef.bytes,
            fallbackMimeType: blobIdOrRef.mimeType,
          }
    if (this.readSpilledBlob !== undefined) {
      const stored = await this.readSpilledBlob(query.blobId, query.sha256)
      if (!stored) {
        throw new ToolBrokerPolicyError(
          'TOOL_SPILLED_BLOB_MISSING',
          `Spilled blob "${query.blobId}" not found in configured readSpilledBlob store`,
        )
      }
      return this.verifySpillBytesOrThrow(query, stored)
    }
    return this.readSpilledBlobVerified(blobIdOrRef)
  }

  private verifySpillBytesOrThrow(
    query: {
      readonly blobId: string
      readonly sha256?: string
      readonly expectedBytes?: number
      readonly fallbackMimeType?: string
    },
    stored: { readonly bytes: Uint8Array; readonly mimeType: string; readonly sha256?: string },
  ): VerifiedSpillBlobPayload {
    if (query.expectedBytes !== undefined && stored.bytes.byteLength !== query.expectedBytes) {
      throw new ToolBrokerPolicyError(
        'TOOL_SPILLED_BLOB_CORRUPT',
        `Spilled blob "${query.blobId}" byte length mismatch: expected ${query.expectedBytes}, got ${stored.bytes.byteLength}`,
      )
    }
    const actualSha = createHash('sha256').update(stored.bytes).digest('hex')
    if (stored.sha256 !== undefined && actualSha !== stored.sha256) {
      throw new ToolBrokerPolicyError(
        'TOOL_SPILLED_BLOB_CORRUPT',
        `Spilled blob "${query.blobId}" metadata SHA-256 mismatch`,
      )
    }
    if (query.sha256 !== undefined && actualSha !== query.sha256) {
      throw new ToolBrokerPolicyError(
        'TOOL_SPILLED_BLOB_CORRUPT',
        `Spilled blob "${query.blobId}" SHA-256 mismatch`,
      )
    }
    return {
      blobId: query.blobId,
      sha256: actualSha,
      mimeType: stored.mimeType || query.fallbackMimeType || 'application/octet-stream',
      bytes: new Uint8Array(stored.bytes),
      byteLength: stored.bytes.byteLength,
    }
  }

  get observedPeakConcurrency(): number {
    return this.peakConcurrency
  }

  /**
   * Marks all currently in-flight calls for `leaseId` as interrupted (e.g. on link drop)
   * so any replay hits `unknown_effect_fenced` fail-closed rather than re-running side effects.
   */
  markLeaseDisconnected(leaseId: string, reason = 'link_disconnected'): number {
    let count = 0
    for (const entry of this.wal.values()) {
      if (entry.leaseId === leaseId && entry.state === 'in_flight') {
        entry.state = 'interrupted'
        count += 1
      }
    }
    for (const active of this.inFlight.values()) {
      if (active.leaseId === leaseId) {
        active.cancelReason = reason
        active.controller.abort(new Error(reason))
      }
    }
    return count
  }

  async cancel(callId: string, reason: string, leaseId?: string): Promise<void> {
    const active = this.inFlight.get(callId)
    if (!active) return
    if (leaseId !== undefined && active.leaseId !== leaseId) return
    active.cancelReason = reason
    active.onCancel?.(reason)
    active.controller.abort(new Error(reason))
  }

  async invoke(call: ToolBrokerInvokeRequest): Promise<ToolBrokerResultEnvelope> {
    return this.executeInternal(call)
  }

  async *stream(call: ToolBrokerInvokeRequest): AsyncIterable<ToolStreamFrame> {
    const queue: ToolStreamFrame[] = []
    let done = false
    let notify: (() => void) | null = null
    let seq = 0

    const push = (frame: ToolStreamFrame) => {
      queue.push(frame)
      if (notify) {
        const wake = notify
        notify = null
        wake()
      }
    }

    push({ kind: 'tool_call', envelope: call, seq: ++seq })

    const runPromise = this.executeInternal(call, {
      onStdout: (chunk) => push({ kind: 'tool_stdout', callId: call.callId, chunk, seq: ++seq }),
      onStderr: (chunk) => push({ kind: 'tool_stderr', callId: call.callId, chunk, seq: ++seq }),
      onCancel: (reason) => push({ kind: 'tool_cancel', callId: call.callId, reason, seq: ++seq }),
    }).then((result) => {
      push({ kind: 'tool_result', envelope: result, seq: ++seq })
      done = true
      if (notify) {
        const wake = notify
        notify = null
        wake()
      }
    })

    try {
      while (!done || queue.length > 0) {
        if (queue.length > 0) {
          yield queue.shift()!
        } else {
          await new Promise<void>((resolve) => {
            notify = resolve
          })
        }
      }
    } finally {
      await runPromise
    }
  }

  private async executeInternal(
    call: ToolBrokerInvokeRequest,
    streamHooks?: {
      readonly onStdout?: (chunk: string) => void
      readonly onStderr?: (chunk: string) => void
      readonly onCancel?: (reason: string) => void
    },
  ): Promise<ToolBrokerResultEnvelope> {
    const startedAtMs = this.clock()

    const makeResult = (
      partial: Omit<
        ToolBrokerResultEnvelope,
        'schemaVersion' | 'leaseId' | 'turnId' | 'callId' | 'idempotencyKey' | 'durationMs'
      > & { idempotencyKey?: string },
    ): ToolBrokerResultEnvelope => ({
      schemaVersion: 1,
      leaseId: call.leaseId,
      turnId: call.turnId,
      callId: call.callId,
      idempotencyKey: partial.idempotencyKey ?? call.idempotencyKey,
      status: partial.status,
      ...(partial.output === undefined ? {} : { output: partial.output }),
      ...(partial.errorCode === undefined ? {} : { errorCode: partial.errorCode }),
      ...(partial.errorMessage === undefined ? {} : { errorMessage: partial.errorMessage }),
      ...(partial.spilledBlobId === undefined ? {} : { spilledBlobId: partial.spilledBlobId }),
      ...(partial.replayStatus === undefined ? {} : { replayStatus: partial.replayStatus }),
      ...(partial.approvalStatus === undefined ? {} : { approvalStatus: partial.approvalStatus }),
      ...(partial.detachedCard === undefined ? {} : { detachedCard: partial.detachedCard }),
      ...(partial.isError === undefined ? {} : { isError: partial.isError }),
      durationMs: Math.max(0, this.clock() - startedAtMs),
    })

    // ── Gate 1: Lease & FencingToken validation (R10) + R8 ScopedCapabilityToken ──────────
    let activeSessionKey = call.sessionKey ?? ''
    let activeBrainGen = call.brainGen
    if (this.leaseManager && (this.requireFencingToken || call.fencingToken !== undefined)) {
      if (!call.fencingToken) {
        return makeResult({
          status: 'denied',
          errorCode: 'EXEC_FENCING_TOKEN_STALE',
          errorMessage: 'Missing fencingToken for leased tool broker invocation',
        })
      }
      try {
        const lease = this.leaseManager.validateFencingToken(
          call.leaseId,
          call.fencingToken,
          call.brainGen,
        )
        activeSessionKey = call.sessionKey ?? lease.sessionKey
        activeBrainGen = lease.brainGen
      } catch (err) {
        const code = err instanceof ExecEnvLeaseError ? err.code : 'EXEC_FENCING_TOKEN_STALE'
        return makeResult({
          status: 'denied',
          errorCode: code,
          errorMessage: err instanceof Error ? err.message : String(err),
        })
      }
    }

    if (
      this.capabilityAuthority &&
      (this.requireCapabilityToken || call.capabilityToken !== undefined)
    ) {
      if (!call.capabilityToken) {
        return makeResult({
          status: 'denied',
          errorCode: 'CAPABILITY_TOKEN_MALFORMED',
          errorMessage: 'Missing R8 scoped capability token',
        })
      }
      try {
        this.capabilityAuthority.verifyAndConsumeToken(call.capabilityToken, {
          toolName: call.canonicalName,
          sessionKey: activeSessionKey,
          leaseId: call.leaseId,
          callId: call.callId,
          minBrainGen: activeBrainGen,
          nowMs: this.clock(),
        })
      } catch (err) {
        const code =
          err instanceof ScopedCapabilityTokenError
            ? err.code
            : 'CAPABILITY_TOKEN_SIGNATURE_INVALID'
        return makeResult({
          status: 'denied',
          errorCode: code,
          errorMessage: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // ── Gate 2: Monotonic ExecutionPolicy guard (R9) ──────────────────────────────────────
    const policy = this.getPolicy(call.leaseId)
    if (policy) {
      if (policy.mode === 'hermetic_no_tools') {
        return makeResult({
          status: 'denied',
          errorCode: 'EXEC_POLICY_HERMETIC_NO_TOOLS',
          errorMessage: 'Tool execution is blocked in hermetic_no_tools mode',
        })
      }
      if (policy.deniedTools?.includes(call.canonicalName)) {
        return makeResult({
          status: 'denied',
          errorCode: 'EXEC_POLICY_TOOL_DENIED',
          errorMessage: `Tool "${call.canonicalName}" is explicitly denied by execution policy`,
        })
      }
      if (policy.mode === 'read_only') {
        if (!isReadOnlyAllowedCanonicalTool(call.canonicalName, call.arguments)) {
          return makeResult({
            status: 'denied',
            errorCode: 'EXEC_POLICY_READ_ONLY_DENIED',
            errorMessage: `Tool "${call.canonicalName}" is forbidden in read_only execution mode`,
          })
        }
      }
      if (policy.allowedTools.length > 0 && !policy.allowedTools.includes(call.canonicalName)) {
        return makeResult({
          status: 'denied',
          errorCode: 'EXEC_POLICY_TOOL_NOT_ALLOWED',
          errorMessage: `Tool "${call.canonicalName}" is not in allowedCanonicalTools`,
        })
      }
    }

    const toolDef = this.tools.get(call.canonicalName)
    if (!toolDef) {
      return makeResult({
        status: 'error',
        errorCode: 'TOOL_NOT_REGISTERED',
        errorMessage: `Unknown canonical tool "${call.canonicalName}"`,
      })
    }

    // ── Gate 3: Schema-Filtered Observation Hash verification (R11 / OCV5-800) ───────────
    let expectedArgsSha256: string
    try {
      expectedArgsSha256 = computeSchemaFilteredArgsSha256(
        call.arguments,
        toolDef.inputSchema ?? null,
      )
    } catch (err) {
      return makeResult({
        status: 'denied',
        errorCode: 'TOOL_ARGS_SCHEMA_HASH_MISMATCH',
        errorMessage: err instanceof Error ? err.message : String(err),
      })
    }

    const providedArgsSha256 = call.argsSchemaSha256 ?? call.argsSha256
    if (
      providedArgsSha256 !== expectedArgsSha256 ||
      call.argsSha256 !== expectedArgsSha256 ||
      call.attestation.argsSha256 !== expectedArgsSha256
    ) {
      return makeResult({
        status: 'denied',
        errorCode: 'TOOL_ARGS_SCHEMA_HASH_MISMATCH',
        errorMessage: `Schema-filtered argument digest mismatch for tool "${call.canonicalName}"`,
      })
    }

    // ── Gate 4: Unified ActionPolicy + Compound Shell Guard (R9) ─────────────────────────
    let approvalStatus: ToolBrokerResultEnvelope['approvalStatus'] = 'not_required'
    const shellTool = isShellTool(call.canonicalName, toolDef)
    const command = shellTool ? extractShellCommand(call.arguments) : undefined

    if (shellTool && command) {
      const hookDecision = evaluateShellForHook(command, this.shellHookGuardMode)
      if (hookDecision.decision === 'deny') {
        return makeResult({
          status: 'denied',
          errorCode: 'SHELL_EFFICIENCY_GUARD_DENIED',
          errorMessage: hookDecision.message ?? 'Shell command blocked by efficiency guard',
        })
      }
    }

    const actionPolicyToolName = shellTool ? 'Bash' : call.canonicalName
    const policyEval = await evaluateActionPolicy(
      {
        toolName: actionPolicyToolName,
        ...(command === undefined ? {} : { command }),
        args: { ...call.arguments },
        mainModel: call.mainModel ?? this.defaultMainModel,
        sessionKey: activeSessionKey || undefined,
      },
      {
        loaded: this.loadedActionPolicy,
        mainModel: call.mainModel ?? this.defaultMainModel,
        trustedStrongModels: this.trustedStrongModels,
        aiReviewHook: this.aiReviewHook,
      },
    )

    if (policyEval.tier === 'deny') {
      return makeResult({
        status: 'denied',
        errorCode: 'ACTION_POLICY_DENIED',
        errorMessage: policyEval.reason,
        approvalStatus: 'denied',
      })
    }

    if (policyEval.tier === 'human_approval') {
      const approvalId = `appr_${randomUUID().replace(/-/g, '').slice(0, 12)}`
      const approvalReq: ToolApprovalRequest = {
        approvalId,
        leaseId: call.leaseId,
        sessionKey: activeSessionKey,
        callId: call.callId,
        toolName: call.canonicalName,
        arguments: call.arguments,
        command,
        evaluation: policyEval,
      }
      if (!this.approvalHandler) {
        return makeResult({
          status: 'denied',
          errorCode: 'HUMAN_APPROVAL_REQUIRED',
          errorMessage: policyEval.reason,
          approvalStatus: 'denied',
        })
      }

      const approvalOutcome = await this.awaitBlockingThenDetachedApproval(approvalReq)
      if (approvalOutcome.kind === 'detached') {
        const card: DetachedApprovalCard = {
          approvalId,
          leaseId: call.leaseId,
          callId: call.callId,
          toolName: call.canonicalName,
          reason: policyEval.reason,
          evaluation: policyEval,
          createdAtMs: this.clock(),
        }
        this.onDetachedApprovalCard?.(card)
        return makeResult({
          status: 'denied',
          errorCode: 'APPROVAL_DEFERRED_DETACHED',
          errorMessage: `Human approval timed out after ${this.detachedFallbackAfterMs}ms; downgraded to async approval card ${approvalId}`,
          approvalStatus: 'detached_pending',
          detachedCard: card,
        })
      }
      if (approvalOutcome.decision !== 'approve') {
        return makeResult({
          status: 'denied',
          errorCode: 'HUMAN_APPROVAL_DENIED',
          errorMessage: approvalOutcome.reason ?? 'Action denied by human approver',
          approvalStatus: 'denied',
        })
      }
      approvalStatus = 'approved'
    }

    // ── Gate 5: Idempotency WAL check (memory + cross-process disk WAL) ──────────────────
    let idempotencyKey: string
    try {
      idempotencyKey = computeToolIdempotencyKey(call.leaseId, call.turnId, call.callId)
    } catch (err) {
      return makeResult({
        status: 'denied',
        errorCode: 'EXEC_TOOL_CALL_IDEMPOTENCY_MISMATCH',
        errorMessage: err instanceof Error ? err.message : String(err),
      })
    }

    if (call.idempotencyKey !== idempotencyKey) {
      return makeResult({
        status: 'denied',
        errorCode: 'EXEC_TOOL_CALL_IDEMPOTENCY_MISMATCH',
        errorMessage: `Provided idempotencyKey "${call.idempotencyKey}" does not match expected "${idempotencyKey}"`,
      })
    }

    const preCheckReplay = await this.checkExistingWal(
      idempotencyKey,
      expectedArgsSha256,
      call,
      approvalStatus,
      makeResult,
    )
    if (preCheckReplay !== null) {
      return preCheckReplay
    }

    // ── Gate 6: Multi-concurrency scheduling + cooperative cancellation ──────────────────
    const controller = new AbortController()
    const inFlightRec: InFlightCall = {
      callId: call.callId,
      leaseId: call.leaseId,
      idempotencyKey,
      controller,
      onCancel: streamHooks?.onCancel,
    }
    this.inFlight.set(call.callId, inFlightRec)

    let release: (() => void) | null = null
    let timeoutTimer: NodeJS.Timeout | null = null
    let timedOut = false
    let walEntry: WalEntry | null = null

    try {
      release = await this.semaphore.acquire(controller.signal)
      if (this.semaphore.currentActive > this.peakConcurrency) {
        this.peakConcurrency = this.semaphore.currentActive
      }

      // Re-check WAL atomically BEFORE final synchronous fencing check and attempt creation.
      const postAcquireReplay = await this.checkExistingWal(
        idempotencyKey,
        expectedArgsSha256,
        call,
        approvalStatus,
        makeResult,
      )
      if (postAcquireReplay !== null) {
        return postAcquireReplay
      }

      // B13: Side-effecting tools MUST NOT execute without a persistent WAL (`walDir` or
      // `durableWalAdapter`) AND durable paired spill storage (to prevent dangling spilled receipts
      // after restart) unless explicitly opted into ephemeral test mode.
      if (
        toolDef.readOnly !== true &&
        !this.hasDurableWal &&
        !this.allowEphemeralSideEffects
      ) {
        return makeResult({
          idempotencyKey,
          status: 'denied',
          isError: true,
          errorCode: 'TOOL_BROKER_DURABLE_WAL_REQUIRED',
          errorMessage: `Side-effecting tool "${call.canonicalName}" requires a persistent WAL (walDir or durableWalAdapter) before execution`,
          approvalStatus,
        })
      }

      if (
        toolDef.readOnly !== true &&
        !this.hasDurableSpillStorage &&
        !this.allowEphemeralSideEffects
      ) {
        return makeResult({
          idempotencyKey,
          status: 'denied',
          isError: true,
          errorCode: 'TOOL_BROKER_DURABLE_SPILL_REQUIRED',
          errorMessage: `Side-effecting tool "${call.canonicalName}" requires durable paired spilled payload storage (walDir, paired spillBlob+readSpilledBlob, or durableWalAdapter writeSpilledBlob+readSpilledBlob)`,
          approvalStatus,
        })
      }

      // Atomic pre-side-effect fencing re-validation (B12 / R2): runs synchronously AFTER
      // all async approval/semaphore/WAL replay awaits and IMMEDIATELY BEFORE writing the
      // durable attempt marker or invoking the handler (zero `await`s in between).
      if (this.leaseManager && (this.requireFencingToken || call.fencingToken !== undefined)) {
        if (!call.fencingToken) {
          return makeResult({
            idempotencyKey,
            status: 'denied',
            errorCode: 'EXEC_FENCING_TOKEN_STALE',
            errorMessage: 'Missing fencingToken before tool side-effect execution',
          })
        }
        try {
          const lease = this.leaseManager.validateFencingToken(
            call.leaseId,
            call.fencingToken,
            call.brainGen,
          )
          activeBrainGen = lease.brainGen
        } catch (err) {
          const code = err instanceof ExecEnvLeaseError ? err.code : 'EXEC_FENCING_TOKEN_STALE'
          return makeResult({
            idempotencyKey,
            status: 'denied',
            errorCode: code,
            errorMessage: err instanceof Error ? err.message : String(err),
          })
        }
      }

      // Persist durable WAL attempt BEFORE running any side-effect handler.
      if (this.hasDurableWal) {
        const attemptStatus = this.writeDurableWalAttemptSync({
          schemaVersion: 1,
          idempotencyKey,
          callId: call.callId,
          toolName: call.canonicalName,
          argsSchemaSha256: expectedArgsSha256,
          leaseId: call.leaseId,
          brainGen: activeBrainGen ?? null,
          createdAtMs: this.clock(),
        })
        if (attemptStatus === 'exists') {
          const raced = await this.checkExistingWal(
            idempotencyKey,
            expectedArgsSha256,
            call,
            approvalStatus,
            makeResult,
          )
          if (raced !== null) return raced
          return makeResult({
            idempotencyKey,
            status: 'error',
            isError: true,
            errorCode: 'UNKNOWN_EFFECT_FENCED',
            errorMessage: `Call ${call.callId} (${idempotencyKey}) already has a persisted attempt; refusing fail-closed replay`,
            replayStatus: 'unknown_effect_fenced',
            approvalStatus,
          })
        }
      }

      walEntry = {
        idempotencyKey,
        leaseId: call.leaseId,
        callId: call.callId,
        argsSchemaSha256: expectedArgsSha256,
        state: 'in_flight',
      }
      this.wal.set(idempotencyKey, walEntry)

      if (call.timeoutMs !== undefined && call.timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          timedOut = true
          controller.abort(new Error(`Tool call timed out after ${call.timeoutMs}ms`))
        }, call.timeoutMs)
      }

      const rawOutput = await Promise.resolve(
        toolDef.handler(call.arguments, {
          leaseId: call.leaseId,
          sessionKey: activeSessionKey,
          callId: call.callId,
          turnId: call.turnId,
          idempotencyKey,
          signal: controller.signal,
          emitStdout: (chunk) => streamHooks?.onStdout?.(chunk),
          emitStderr: (chunk) => streamHooks?.onStderr?.(chunk),
        }),
      )

      // If marked interrupted mid-flight (e.g. link drop), keep WAL fenced as `interrupted`
      // and do NOT write a `.result.json` file.
      if (isWalEntryInterrupted(walEntry)) {
        return makeResult({
          idempotencyKey,
          status: 'error',
          isError: true,
          errorCode: 'UNKNOWN_EFFECT_FENCED',
          errorMessage: `Call ${call.callId} was interrupted mid-flight`,
          replayStatus: 'unknown_effect_fenced',
          approvalStatus,
        })
      }

      // ── Gate 7: Large payload auto-spill to BlobRef ────────────────────────────────────
      let finalOutput: unknown = rawOutput
      let spilledBlobId: string | undefined

      const serialized = serializeOutputForSpill(rawOutput)
      if (serialized.bytes.byteLength > this.maxInlinePayloadBytes) {
        const computedSha256 = createHash('sha256').update(serialized.bytes).digest('hex')
        if (this.spillBlob) {
          const spilled = await this.spillBlob(serialized.bytes, serialized.mimeType)
          spilledBlobId = spilled.blobId
          const byteLength = spilled.bytes ?? serialized.bytes.byteLength
          const ref: SpilledBlobRefOutput = {
            type: 'blob_ref',
            blobId: spilled.blobId,
            sha256: spilled.sha256 ?? computedSha256,
            mimeType: spilled.mimeType ?? serialized.mimeType,
            bytes: byteLength,
            byteLength,
          }
          finalOutput = ref
        } else if (this.diskSpillStore !== undefined) {
          const persisted = this.diskSpillStore.persistSync(serialized.bytes, serialized.mimeType)
          spilledBlobId = persisted.blobId
          const ref: SpilledBlobRefOutput = {
            type: 'blob_ref',
            blobId: persisted.blobId,
            sha256: persisted.sha256,
            mimeType: persisted.mimeType,
            bytes: persisted.bytes,
            byteLength: persisted.byteLength,
          }
          finalOutput = ref
        } else if (typeof this.durableWalAdapter?.writeSpilledBlob === 'function') {
          const blobId = `blob_${computedSha256}`
          const byteLength = serialized.bytes.byteLength
          this.durableWalAdapter.writeSpilledBlob(blobId, serialized.bytes, {
            sha256: computedSha256,
            mimeType: serialized.mimeType,
            byteLength,
          })
          spilledBlobId = blobId
          const ref: SpilledBlobRefOutput = {
            type: 'blob_ref',
            blobId,
            sha256: computedSha256,
            mimeType: serialized.mimeType,
            bytes: byteLength,
            byteLength,
          }
          finalOutput = ref
        } else {
          const blobId = `blob_${computedSha256}`
          this.fallbackSpillStore.set(blobId, {
            bytes: serialized.bytes,
            mimeType: serialized.mimeType,
            sha256: computedSha256,
            byteLength: serialized.bytes.byteLength,
          })
          spilledBlobId = blobId
          const ref: SpilledBlobRefOutput = {
            type: 'blob_ref',
            blobId,
            sha256: computedSha256,
            mimeType: serialized.mimeType,
            bytes: serialized.bytes.byteLength,
            byteLength: serialized.bytes.byteLength,
          }
          finalOutput = ref
        }
      }

      const receipt = makeResult({
        idempotencyKey,
        status: 'ok',
        output: finalOutput,
        spilledBlobId,
        replayStatus: 'executed',
        approvalStatus,
      })
      if (this.hasDurableWal) {
        this.writeDurableWalResultSync({
          schemaVersion: 1,
          idempotencyKey,
          callId: call.callId,
          toolName: call.canonicalName,
          argsSchemaSha256: expectedArgsSha256,
          leaseId: call.leaseId,
          brainGen: activeBrainGen ?? null,
          receipt,
          finalizedAtMs: this.clock(),
        })
      }
      walEntry.state = 'completed'
      walEntry.receipt = receipt
      return receipt
    } catch (err) {
      if (err instanceof ToolBrokerPolicyError) {
        throw err
      }
      if (isWalEntryInterrupted(walEntry)) {
        return makeResult({
          idempotencyKey,
          status: 'error',
          isError: true,
          errorCode: 'UNKNOWN_EFFECT_FENCED',
          errorMessage: err instanceof Error ? err.message : String(err),
          replayStatus: 'unknown_effect_fenced',
          approvalStatus,
        })
      }
      const receipt = makeResult({
        idempotencyKey,
        status: timedOut ? 'timeout' : 'error',
        errorCode: timedOut
          ? 'TOOL_CALL_TIMEOUT'
          : inFlightRec.cancelReason
            ? 'TOOL_CALL_CANCELLED'
            : 'TOOL_EXECUTION_ERROR',
        errorMessage: err instanceof Error ? err.message : String(err),
        replayStatus: 'executed',
        approvalStatus,
      })
      if (walEntry !== null) {
        if (this.hasDurableWal) {
          this.writeDurableWalResultSync({
            schemaVersion: 1,
            idempotencyKey,
            callId: call.callId,
            toolName: call.canonicalName,
            argsSchemaSha256: expectedArgsSha256,
            leaseId: call.leaseId,
            brainGen: activeBrainGen ?? null,
            receipt,
            finalizedAtMs: this.clock(),
          })
        }
        walEntry.state = 'completed'
        walEntry.receipt = receipt
      }
      return receipt
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer)
      release?.()
      this.inFlight.delete(call.callId)
    }
  }

  private async verifyReplayedSpilledReceipt(
    receipt: ToolBrokerResultEnvelope,
  ): Promise<
    | { readonly ok: true }
    | {
        readonly ok: false
        readonly errorCode: 'TOOL_SPILLED_BLOB_MISSING' | 'TOOL_SPILLED_BLOB_CORRUPT'
        readonly message: string
      }
  > {
    const replayBlobId = receipt.spilledBlobId
    if (typeof replayBlobId !== 'string' || replayBlobId.length === 0) {
      return { ok: true }
    }
    const outRef =
      receipt.output !== null &&
      typeof receipt.output === 'object' &&
      (receipt.output as Partial<SpilledBlobRefOutput>).type === 'blob_ref'
        ? (receipt.output as Partial<SpilledBlobRefOutput>)
        : null
    const expectedSha = typeof outRef?.sha256 === 'string' ? outRef.sha256 : undefined
    const expectedBytes =
      typeof outRef?.byteLength === 'number'
        ? outRef.byteLength
        : typeof outRef?.bytes === 'number'
          ? outRef.bytes
          : undefined
    const fallbackMimeType = typeof outRef?.mimeType === 'string' ? outRef.mimeType : undefined

    if (this.readSpilledBlob !== undefined) {
      try {
        const stored = await this.readSpilledBlob(replayBlobId, expectedSha)
        if (!stored) {
          return {
            ok: false,
            errorCode: 'TOOL_SPILLED_BLOB_MISSING',
            message: `Persisted spilled blob "${replayBlobId}" is missing from readSpilledBlob store`,
          }
        }
        this.verifySpillBytesOrThrow(
          { blobId: replayBlobId, sha256: expectedSha, expectedBytes, fallbackMimeType },
          stored,
        )
        return { ok: true }
      } catch (err) {
        if (err instanceof ToolBrokerPolicyError && err.code === 'TOOL_SPILLED_BLOB_CORRUPT') {
          return { ok: false, errorCode: 'TOOL_SPILLED_BLOB_CORRUPT', message: err.message }
        }
        return {
          ok: false,
          errorCode: 'TOOL_SPILLED_BLOB_MISSING',
          message: err instanceof Error ? err.message : String(err),
        }
      }
    }

    if (this.spillBlob !== undefined) {
      // B13: External spill writer without matching reader cannot verify persisted bytes;
      // only permitted in explicit ephemeral test mode.
      if (this.allowEphemeralSideEffects) {
        return { ok: true }
      }
      return {
        ok: false,
        errorCode: 'TOOL_SPILLED_BLOB_MISSING',
        message: `Spilled blob "${replayBlobId}" cannot be verified because external spillBlob lacks a paired readSpilledBlob reader`,
      }
    }

    if (this.diskSpillStore !== undefined) {
      const verified = this.diskSpillStore.readAndVerifySync({
        blobId: replayBlobId,
        sha256: expectedSha,
        expectedBytes,
        fallbackMimeType,
      })
      if (!verified.ok) {
        return { ok: false, errorCode: verified.errorCode, message: verified.message }
      }
      return { ok: true }
    }

    if (typeof this.durableWalAdapter?.readSpilledBlob === 'function') {
      try {
        const stored = this.durableWalAdapter.readSpilledBlob(replayBlobId, expectedSha)
        if (!stored) {
          return {
            ok: false,
            errorCode: 'TOOL_SPILLED_BLOB_MISSING',
            message: `Persisted spilled blob "${replayBlobId}" is missing from durable WAL adapter`,
          }
        }
        this.verifySpillBytesOrThrow(
          { blobId: replayBlobId, sha256: expectedSha, expectedBytes, fallbackMimeType },
          stored,
        )
        return { ok: true }
      } catch (err) {
        if (err instanceof ToolBrokerPolicyError && err.code === 'TOOL_SPILLED_BLOB_CORRUPT') {
          return { ok: false, errorCode: 'TOOL_SPILLED_BLOB_CORRUPT', message: err.message }
        }
        return {
          ok: false,
          errorCode: 'TOOL_SPILLED_BLOB_MISSING',
          message: err instanceof Error ? err.message : String(err),
        }
      }
    }

    return {
      ok: false,
      errorCode: 'TOOL_SPILLED_BLOB_MISSING',
      message: `No durable spill store configured to verify replayed blob "${replayBlobId}"`,
    }
  }

  private async checkExistingWal(
    idempotencyKey: string,
    expectedArgsSha256: string,
    call: ToolBrokerInvokeRequest,
    approvalStatus: ToolBrokerResultEnvelope['approvalStatus'],
    makeResult: (
      partial: Omit<
        ToolBrokerResultEnvelope,
        'schemaVersion' | 'leaseId' | 'turnId' | 'callId' | 'idempotencyKey' | 'durationMs'
      > & { idempotencyKey?: string },
    ) => ToolBrokerResultEnvelope,
  ): Promise<ToolBrokerResultEnvelope | null> {
    const existingWal = this.wal.get(idempotencyKey)
    if (existingWal) {
      if (existingWal.argsSchemaSha256 !== expectedArgsSha256) {
        throw new ToolBrokerPolicyError(
          'TOOL_IDEMPOTENCY_ARGS_CONFLICT',
          `Idempotency key "${idempotencyKey}" already bound to different argsSchemaSha256`,
        )
      }
      if (existingWal.state === 'completed' && existingWal.receipt) {
        return {
          ...existingWal.receipt,
          replayStatus: 'cached_receipt',
        }
      }
      return makeResult({
        idempotencyKey,
        status: 'error',
        isError: true,
        errorCode: 'UNKNOWN_EFFECT_FENCED',
        errorMessage: `Call ${call.callId} (${idempotencyKey}) is ${existingWal.state}; refusing fail-closed replay to prevent duplicate side effects`,
        replayStatus: 'unknown_effect_fenced',
        approvalStatus,
      })
    }

    if (this.durableWalAdapter !== undefined) {
      const adapterResult = this.durableWalAdapter.readResult(idempotencyKey)
      if (adapterResult !== null) {
        if (adapterResult.argsSchemaSha256 !== expectedArgsSha256) {
          throw new ToolBrokerPolicyError(
            'TOOL_IDEMPOTENCY_ARGS_CONFLICT',
            `Persisted WAL receipt for "${idempotencyKey}" has mismatched argsSchemaSha256`,
          )
        }
        const spillCheck = await this.verifyReplayedSpilledReceipt(adapterResult.receipt)
        if (!spillCheck.ok) {
          return makeResult({
            idempotencyKey,
            status: 'error',
            isError: true,
            errorCode: spillCheck.errorCode,
            errorMessage: spillCheck.message,
            replayStatus: 'unknown_effect_fenced',
            approvalStatus,
          })
        }
        this.wal.set(idempotencyKey, {
          idempotencyKey,
          leaseId: adapterResult.leaseId,
          callId: adapterResult.callId,
          argsSchemaSha256: adapterResult.argsSchemaSha256,
          state: 'completed',
          receipt: adapterResult.receipt,
        })
        return {
          ...adapterResult.receipt,
          replayStatus: 'cached_receipt',
        }
      }
      const adapterAttempt = this.durableWalAdapter.readAttempt(idempotencyKey)
      if (adapterAttempt !== null) {
        if (adapterAttempt.argsSchemaSha256 !== expectedArgsSha256) {
          throw new ToolBrokerPolicyError(
            'TOOL_IDEMPOTENCY_ARGS_CONFLICT',
            `Persisted WAL attempt for "${idempotencyKey}" has mismatched argsSchemaSha256`,
          )
        }
        return makeResult({
          idempotencyKey,
          status: 'error',
          isError: true,
          errorCode: 'UNKNOWN_EFFECT_FENCED',
          errorMessage: `Persisted WAL attempt for ${call.callId} (${idempotencyKey}) has no committed result; refusing fail-closed replay`,
          replayStatus: 'unknown_effect_fenced',
          approvalStatus,
        })
      }
    }

    if (this.walDir !== undefined) {
      const safeKey = walSafeKey(idempotencyKey)
      const resultPath = join(this.walDir, `${safeKey}.result.json`)
      const resultFile = readRegularJsonFileSync<DiskWalResultRecord>(resultPath)
      if (resultFile.exists) {
        if (resultFile.corrupt || !resultFile.data || !resultFile.data.receipt) {
          return makeResult({
            idempotencyKey,
            status: 'error',
            isError: true,
            errorCode: 'UNKNOWN_EFFECT_FENCED',
            errorMessage: `Persisted WAL result for ${idempotencyKey} is unreadable; refusing fail-closed replay`,
            replayStatus: 'unknown_effect_fenced',
            approvalStatus,
          })
        }
        if (resultFile.data.argsSchemaSha256 !== expectedArgsSha256) {
          throw new ToolBrokerPolicyError(
            'TOOL_IDEMPOTENCY_ARGS_CONFLICT',
            `Persisted WAL receipt for "${idempotencyKey}" has mismatched argsSchemaSha256`,
          )
        }
        // B13: Verify persisted spilled payload (canonical `<walDir>/spill/<sha256>.bin` or
        // legacy `<walDir>/spilled/<legacyBlobId>.bin`) matches receipt SHA-256 and byte length
        // before returning cached_receipt.
        const spillCheck = await this.verifyReplayedSpilledReceipt(resultFile.data.receipt)
        if (!spillCheck.ok) {
          return makeResult({
            idempotencyKey,
            status: 'error',
            isError: true,
            errorCode: spillCheck.errorCode,
            errorMessage: spillCheck.message,
            replayStatus: 'unknown_effect_fenced',
            approvalStatus,
          })
        }
        this.wal.set(idempotencyKey, {
          idempotencyKey,
          leaseId: resultFile.data.leaseId,
          callId: resultFile.data.callId,
          argsSchemaSha256: resultFile.data.argsSchemaSha256,
          state: 'completed',
          receipt: resultFile.data.receipt,
        })
        return {
          ...resultFile.data.receipt,
          replayStatus: 'cached_receipt',
        }
      }

      const attemptPath = join(this.walDir, `${safeKey}.attempt.json`)
      const attemptFile = readRegularJsonFileSync<DiskWalAttemptRecord>(attemptPath)
      if (attemptFile.exists) {
        if (
          !attemptFile.corrupt &&
          attemptFile.data &&
          typeof attemptFile.data.argsSchemaSha256 === 'string' &&
          attemptFile.data.argsSchemaSha256 !== expectedArgsSha256
        ) {
          throw new ToolBrokerPolicyError(
            'TOOL_IDEMPOTENCY_ARGS_CONFLICT',
            `Persisted WAL attempt for "${idempotencyKey}" has mismatched argsSchemaSha256`,
          )
        }
        return makeResult({
          idempotencyKey,
          status: 'error',
          isError: true,
          errorCode: 'UNKNOWN_EFFECT_FENCED',
          errorMessage: `Persisted WAL attempt for ${call.callId} (${idempotencyKey}) has no committed result; refusing fail-closed replay`,
          replayStatus: 'unknown_effect_fenced',
          approvalStatus,
        })
      }
    }

    return null
  }

  private writeDurableWalAttemptSync(record: DiskWalAttemptRecord): 'created' | 'exists' {
    if (this.durableWalAdapter !== undefined) {
      return this.durableWalAdapter.writeAttempt(record)
    }
    return this.writeDiskWalAttemptSync(record)
  }

  private writeDurableWalResultSync(record: DiskWalResultRecord): void {
    if (this.durableWalAdapter !== undefined) {
      this.durableWalAdapter.writeResult(record)
      return
    }
    this.writeDiskWalResultSync(record)
  }

  private writeDiskWalAttemptSync(record: DiskWalAttemptRecord): 'created' | 'exists' {
    if (this.walDir === undefined) return 'created'
    const safeKey = walSafeKey(record.idempotencyKey)
    const attemptPath = join(this.walDir, `${safeKey}.attempt.json`)
    const flags =
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      (fsConstants.O_NOFOLLOW ?? 0) |
      fsConstants.O_WRONLY
    let fd: number
    try {
      fd = openSync(attemptPath, flags, 0o600)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
        return 'exists'
      }
      throw err
    }
    try {
      writeAllSync(fd, Buffer.from(JSON.stringify(record), 'utf8'))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    fsyncDirSync(this.walDir)
    return 'created'
  }

  private writeDiskWalResultSync(record: DiskWalResultRecord): void {
    if (this.walDir === undefined) return
    const safeKey = walSafeKey(record.idempotencyKey)
    const resultPath = join(this.walDir, `${safeKey}.result.json`)
    const tmpPath = join(this.walDir, `.${safeKey}.${randomUUID()}.tmp`)
    const flags =
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      (fsConstants.O_NOFOLLOW ?? 0) |
      fsConstants.O_WRONLY
    let fd: number | undefined
    try {
      fd = openSync(tmpPath, flags, 0o600)
      writeAllSync(fd, Buffer.from(JSON.stringify(record), 'utf8'))
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      renameSync(tmpPath, resultPath)
      fsyncDirSync(this.walDir)
    } catch (err) {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          // Ignore close failure on cleanup path.
        }
      }
      try {
        unlinkSync(tmpPath)
      } catch {
        // Ignore temp cleanup failure.
      }
      throw err
    }
  }

  private async awaitBlockingThenDetachedApproval(
    request: ToolApprovalRequest,
  ): Promise<
    | { readonly kind: 'decided'; readonly decision: 'approve' | 'deny'; readonly reason?: string }
    | { readonly kind: 'detached' }
  > {
    const controller = new AbortController()
    let timer: NodeJS.Timeout | null = null
    try {
      return await Promise.race([
        this.approvalHandler!(request, controller.signal).then((res) => ({
          kind: 'decided' as const,
          decision: res.decision,
          reason: res.reason,
        })),
        new Promise<{ readonly kind: 'detached' }>((resolve) => {
          timer = setTimeout(() => {
            controller.abort(new Error('APPROVAL_DEFERRED_DETACHED'))
            resolve({ kind: 'detached' })
          }, this.detachedFallbackAfterMs)
        }),
      ])
    } catch (err) {
      return {
        kind: 'decided',
        decision: 'deny',
        reason: err instanceof Error ? err.message : String(err),
      }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
