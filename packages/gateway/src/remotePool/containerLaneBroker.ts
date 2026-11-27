/**
 * OCV5-915 P3-2 — Per-lane default `ToolBrokerServer` wrapper for `RemoteContainerLane`
 * (`rt-codex-remote` rank 1).
 *
 * Extracted from `containerLane.ts` so every Remote Pool tool execution — even when no
 * external `brokerTransport` is injected — passes through all 7 Layer 3 ToolBroker gates:
 *   - Ephemeral in-memory `ScopedCapabilityTokenAuthority` (`requireCapabilityToken: true`)
 *   - Per-lane `ExecEnvLeaseManager` + fencing token validation
 *   - Monotonic `read_only` ExecutionPolicy tightening on `turn.readOnly`
 *   - Single-use `(callId, clientToolName, sessionKey, leaseId, brainGen)` `octk1.*` tokens
 *   - Gate 4 ActionPolicy + 55s `blocking_then_detached` approval wired to `onPermissionRequest`
 *   - Gate 5 persistent WAL under `<laneRoot>/tool-broker-wal`
 *   - Gate 7 `>256 KiB` auto-spill formatting (`blob_ref` + SHA-256 + bounded head preview)
 *
 * Architecture invariants:
 * - Zero `process.env`, zero `node:http`/`fetch`, zero `syncIo`, zero `emptyCatch`, zero `typeEscape`.
 * - Only `import type` from sibling `rt-cc5` (`cc5NativeTool.ts` / `cc5ToolHost.ts`).
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  computeSchemaFilteredArgsSha256,
  computeToolIdempotencyKey,
  isAdvisorReadOnlyMcpTool,
  remoteCanonicalSha256,
  validateExecutionPolicyEnvelope,
  type ExecutionPolicyEnvelope,
  type ToolBrokerTransport,
  type ToolCallEnvelope,
  type ToolResultEnvelope,
} from '@openclaude/protocol'
import type { LoadedActionPolicy } from '../actionPolicyEngine.js'
import type { Cc5ToolResult } from '../cc5NativeTool.js'
import type { Cc5ToolHost } from '../cc5ToolHost.js'
import type { PermissionRequest } from '../engine/engineEvents.js'
import {
  ExecEnvLeaseManager,
  ScopedCapabilityTokenAuthority,
  TOOL_BROKER_DEFAULT_DETACHED_FALLBACK_MS,
  TOOL_BROKER_DEFAULT_MAX_CONCURRENCY,
  TOOL_BROKER_DEFAULT_MAX_INLINE_PAYLOAD_BYTES,
  ToolBrokerServer,
  loadAuthoritativeBrokerActionPolicy,
  type DetachedApprovalCard,
  type ExecEnvLeaseRecord,
  type SpilledBlobRefOutput,
  type ToolApprovalDecision,
  type ToolApprovalRequest,
} from '../execEnv/index.js'

export type LaneToolHostLike = Pick<Cc5ToolHost, 'tools' | 'execute' | 'close'>

const EXEC_ENV_IDENT_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SPILL_PREVIEW_MAX_BYTES = 4096

const READ_ONLY_BUILTIN_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'AskUserQuestion',
  'SearchExtraTools',
])

export function isAllowedInReadOnlyTurn(
  clientToolName: string,
  args: Readonly<Record<string, unknown>>,
): boolean {
  if (READ_ONLY_BUILTIN_TOOLS.has(clientToolName)) return true
  if (clientToolName.startsWith('mcp__openclaude-memory__')) {
    return isAdvisorReadOnlyMcpTool(clientToolName.slice('mcp__openclaude-memory__'.length))
  }
  if (clientToolName === 'ExecuteExtraTool') {
    const target = typeof args.tool_name === 'string' ? args.tool_name : ''
    return (
      target.startsWith('mcp__openclaude-memory__') &&
      isAdvisorReadOnlyMcpTool(target.slice('mcp__openclaude-memory__'.length))
    )
  }
  return false
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function isSpilledBlobRef(value: unknown): value is SpilledBlobRefOutput {
  if (!isPlainRecord(value)) return false
  return (
    value.type === 'blob_ref' &&
    typeof value.blobId === 'string' &&
    typeof value.sha256 === 'string' &&
    typeof value.mimeType === 'string' &&
    typeof value.bytes === 'number'
  )
}

function formatSpilledBlobResult(
  ref: SpilledBlobRefOutput,
  toolName: string,
  preview?: string,
): Cc5ToolResult {
  const header = `[tool-broker spilled output: tool=${toolName} blobId=${ref.blobId} sha256=${ref.sha256} bytes=${ref.bytes} mimeType=${ref.mimeType}]`
  const payloadJson = JSON.stringify(ref)
  const sections = [header, payloadJson]
  if (preview && preview.length > 0) {
    sections.push(`--- preview (first ${Math.min(preview.length, SPILL_PREVIEW_MAX_BYTES)} chars) ---\n${preview}`)
  }
  return {
    content: [{ type: 'text', text: sections.join('\n') }],
    isError: false,
  }
}

export function toolResultEnvelopeToCc5Result(
  envelope: ToolResultEnvelope,
  toolName: string,
  opts?: { readonly readSpilledPreview?: (ref: SpilledBlobRefOutput) => string | undefined },
): Cc5ToolResult {
  const isError = envelope.status !== 'ok'
  const out = envelope.output
  if (!isError && isSpilledBlobRef(out)) {
    const preview = opts?.readSpilledPreview?.(out)
    return formatSpilledBlobResult(out, toolName, preview)
  }
  if (out && typeof out === 'object' && !Array.isArray(out)) {
    const rec = out as { content?: unknown; isError?: unknown }
    if (
      Array.isArray(rec.content) &&
      rec.content.every(
        (b) =>
          b &&
          typeof b === 'object' &&
          !Array.isArray(b) &&
          typeof (b as { type?: unknown }).type === 'string',
      )
    ) {
      return {
        content: rec.content as Array<Record<string, unknown> & { type: string }>,
        isError: isError || rec.isError === true,
      }
    }
  }
  if (
    Array.isArray(out) &&
    out.every(
      (b) =>
        b &&
        typeof b === 'object' &&
        !Array.isArray(b) &&
        typeof (b as { type?: unknown }).type === 'string',
    )
  ) {
    return { content: out as Array<Record<string, unknown> & { type: string }>, isError }
  }
  if (typeof out === 'string') {
    return { content: [{ type: 'text', text: out }], isError }
  }
  if (out !== undefined) {
    return { content: [{ type: 'text', text: JSON.stringify(out) }], isError }
  }
  if (isError) {
    return {
      content: [
        {
          type: 'text',
          text:
            envelope.errorMessage ??
            envelope.errorCode ??
            `Tool ${toolName} failed (${envelope.status})`,
        },
      ],
      isError: true,
    }
  }
  return { content: [{ type: 'text', text: '' }], isError: false }
}

export function buildBrokerCallEnvelope(input: {
  readonly leaseId: string
  readonly turnId: string
  readonly callId: string
  readonly canonicalName: string
  readonly arguments: Readonly<Record<string, unknown>>
  readonly schema?: Record<string, unknown>
  readonly fencing?: { readonly fencingToken: string; readonly brainGen: number }
}): { readonly envelope: ToolCallEnvelope; readonly idempotencyKey: string } {
  const idempotencyKey = computeToolIdempotencyKey(input.leaseId, input.turnId, input.callId)
  const schema = input.schema
  const schemaProps =
    schema &&
    typeof schema.properties === 'object' &&
    schema.properties !== null &&
    !Array.isArray(schema.properties)
      ? Object.keys(schema.properties as Record<string, unknown>)
      : []
  const argsSha256 =
    schemaProps.length > 0
      ? computeSchemaFilteredArgsSha256(input.arguments, schema)
      : remoteCanonicalSha256(input.arguments)
  const candidateGrant = input.fencing
    ? `${input.fencing.fencingToken}:${input.fencing.brainGen}`
    : undefined
  const grantId =
    candidateGrant && EXEC_ENV_IDENT_RE.test(candidateGrant) ? candidateGrant : undefined
  const envelope: ToolCallEnvelope = {
    schemaVersion: 1,
    leaseId: input.leaseId,
    turnId: input.turnId,
    callId: input.callId,
    idempotencyKey,
    canonicalName: input.canonicalName,
    arguments: input.arguments,
    argsSha256,
    attestation: {
      kind: schemaProps.length > 0 ? 'schema_filtered_hook' : 'dual_channel_observed',
      argsSha256,
      observedAt: new Date().toISOString(),
      ...(grantId ? { grantId } : {}),
      ...(schemaProps.length > 0 ? { filteredKeys: schemaProps } : {}),
    },
  }
  return { envelope, idempotencyKey }
}

export interface RemoteLaneToolBrokerOptions {
  readonly operationId: string
  readonly sessionKey: string
  readonly walDir?: string
  readonly leaseId?: string
  readonly loadedActionPolicy?: LoadedActionPolicy
  readonly maxInlinePayloadBytes?: number
  readonly detachedFallbackAfterMs?: number
  readonly clock?: () => number
  readonly onDetachedApprovalCard?: (card: DetachedApprovalCard) => void
  readonly onHostResetNeeded?: (host: LaneToolHostLike, reason: string) => Promise<void> | void
  readonly getPermissionHandler?: () =>
    | ((request: PermissionRequest) => Promise<Record<string, unknown>>)
    | undefined
}

export type ExternalCapabilityTokenSupplier = (req: {
  readonly callId: string
  readonly toolName: string
  readonly sessionKey: string
  readonly leaseId: string
  readonly brainGen?: number
}) => string | Promise<string>

export interface ToolBrokerTransportWithAuth extends ToolBrokerTransport {
  invoke(
    call: ToolCallEnvelope,
    extra?: { readonly capabilityToken?: string; readonly sessionKey?: string },
  ): Promise<ToolResultEnvelope>
}

interface LaneExecContext {
  readonly host: LaneToolHostLike
  readonly nativeSessionUuid: string
  readonly turnKey: string
}

const STANDARD_POLICY: ExecutionPolicyEnvelope = validateExecutionPolicyEnvelope({
  schemaVersion: 1,
  mode: 'normal',
  allowedTools: [],
  allowNetworkEgress: true,
  allowWorkspaceWrite: true,
  allowSubprocessSpawn: true,
})

const READ_ONLY_POLICY: ExecutionPolicyEnvelope = validateExecutionPolicyEnvelope({
  schemaVersion: 1,
  mode: 'read_only',
  allowedTools: [],
  allowNetworkEgress: false,
  allowWorkspaceWrite: false,
  allowSubprocessSpawn: false,
})

export class RemoteLaneToolBroker {
  readonly leaseManager: ExecEnvLeaseManager
  readonly capabilityAuthority: ScopedCapabilityTokenAuthority
  readonly server: ToolBrokerServer
  baseLease: ExecEnvLeaseRecord

  private readonly sessionKey: string
  private readonly operationId: string
  private readonly clock: () => number
  private readonly onHostResetNeeded?: (host: LaneToolHostLike, reason: string) => Promise<void> | void
  private readonly getPermissionHandler?: () =>
    | ((request: PermissionRequest) => Promise<Record<string, unknown>>)
    | undefined
  private readonly registeredTools = new Set<string>()
  private readonly pendingExecByCallId = new Map<string, LaneExecContext>()
  private readonly readOnlyLeaseByTurn = new Map<string, ExecEnvLeaseRecord>()
  private readonly detachedCards: DetachedApprovalCard[] = []
  private readOnlyLeaseSeq = 0
  private pendingHostIsolation: Promise<void> = Promise.resolve()
  private activeCallId?: string
  private activeLeaseId?: string

  constructor(opts: RemoteLaneToolBrokerOptions) {
    this.sessionKey = opts.sessionKey
    this.operationId = opts.operationId
    this.clock = opts.clock ?? (() => Date.now())
    this.onHostResetNeeded = opts.onHostResetNeeded
    this.getPermissionHandler = opts.getPermissionHandler

    this.leaseManager = new ExecEnvLeaseManager({ clock: this.clock })
    this.capabilityAuthority = new ScopedCapabilityTokenAuthority({
      secret: randomBytes(32),
      defaultTtlMs: 30_000,
      clock: this.clock,
    })

    const baseLeaseId = opts.leaseId ?? `lane_${opts.operationId.replace(/[^A-Za-z0-9._:-]/g, '_')}`
    this.baseLease = this.leaseManager.issueLease({
      leaseId: baseLeaseId,
      execEnvId: `remote-lane-${opts.operationId.slice(0, 12)}`,
      incarnationId: `inc_${randomUUID().slice(0, 12)}`,
      sessionKey: opts.sessionKey,
      hostKind: 'compute-pool-docker',
      brainGen: 1,
    })

    const walDir = opts.walDir
    this.server = new ToolBrokerServer({
      channelKind: 'ws_tunnel',
      leaseManager: this.leaseManager,
      requireFencingToken: true,
      capabilityAuthority: this.capabilityAuthority,
      requireCapabilityToken: true,
      maxConcurrentToolCalls: TOOL_BROKER_DEFAULT_MAX_CONCURRENCY,
      maxInlinePayloadBytes:
        opts.maxInlinePayloadBytes ?? TOOL_BROKER_DEFAULT_MAX_INLINE_PAYLOAD_BYTES,
      detachedFallbackAfterMs:
        opts.detachedFallbackAfterMs ?? TOOL_BROKER_DEFAULT_DETACHED_FALLBACK_MS,
      ...(opts.loadedActionPolicy
        ? { loadedActionPolicy: opts.loadedActionPolicy }
        : { actionPolicyLoader: loadAuthoritativeBrokerActionPolicy }),
      ...(walDir ? { walDir } : { allowEphemeralSideEffects: true }),
      clock: this.clock,
      approvalHandler: (req, signal) => this.handleApproval(req, signal),
      onDetachedApprovalCard: (card) => {
        this.detachedCards.push(card)
        opts.onDetachedApprovalCard?.(card)
      },
    })
    this.server.setPolicy(this.baseLease.leaseId, STANDARD_POLICY)
  }

  get recordedDetachedCards(): readonly DetachedApprovalCard[] {
    return this.detachedCards
  }

  ensureToolRegistered(
    clientToolName: string,
    inputSchema?: Record<string, unknown>,
  ): void {
    if (this.registeredTools.has(clientToolName)) return
    this.registeredTools.add(clientToolName)
    this.server.registerTool({
      canonicalName: clientToolName,
      ...(inputSchema ? { inputSchema } : {}),
      readOnly: READ_ONLY_BUILTIN_TOOLS.has(clientToolName),
      handler: async (args, ctx) => {
        const execCtx = this.pendingExecByCallId.get(ctx.callId)
        if (!execCtx) {
          throw new Error('REMOTE_TOOLHOST_CLOSED')
        }
        return await new Promise<Cc5ToolResult>((resolveExec, rejectExec) => {
          let settled = false
          const finishResolve = (res: Cc5ToolResult) => {
            if (settled) return
            settled = true
            ctx.signal.removeEventListener('abort', onAbort)
            resolveExec(res)
          }
          const finishReject = (err: unknown) => {
            if (settled) return
            settled = true
            ctx.signal.removeEventListener('abort', onAbort)
            rejectExec(err)
          }
          const isolateAbortedHost = (reason: string) => {
            // B08: Close and isolate stuck Cc5ToolHost before allowing lane reuse so the
            // next call never hits CC5_TOOLHOST_CLOSED_OR_BUSY.
            const iso = Promise.resolve(execCtx.host.close())
              .catch((err) => { void err })
              .then(() => this.onHostResetNeeded?.(execCtx.host, reason))
              .catch((err) => { void err })
            this.pendingHostIsolation = this.pendingHostIsolation.then(() => iso)
            return iso
          }
          if (ctx.signal.aborted) {
            const reason = String(ctx.signal.reason ?? 'TOOL_CALL_CANCELLED')
            finishReject(new Error(reason))
            return
          }
          const onAbort = () => {
            const reason = String(ctx.signal.reason ?? 'TOOL_CALL_CANCELLED')
            void isolateAbortedHost(reason).finally(() => {
              finishReject(new Error(reason))
            })
          }
          ctx.signal.addEventListener('abort', onAbort, { once: true })
          execCtx.host
            .execute(clientToolName, args, {
              nativeSessionId: execCtx.nativeSessionUuid,
              turnKey: execCtx.turnKey,
              toolUseId: ctx.callId,
            })
            .then(finishResolve, finishReject)
        })
      },
    })
  }

  private ensureLiveBaseLease(): ExecEnvLeaseRecord {
    const now = this.clock()
    if (this.baseLease.state === 'active' && now <= this.baseLease.expiresAtMs) {
      if (now > this.baseLease.expiresAtMs - 60_000) {
        try {
          this.baseLease = this.leaseManager.renewLease(this.baseLease.leaseId)
          return this.baseLease
        } catch (err) {
          void err
        }
      } else {
        return this.baseLease
      }
    }
    this.server.markLeaseDisconnected(this.baseLease.leaseId, 'lease_expired_replaced')
    if (this.baseLease.state !== 'closed') {
      try { this.leaseManager.closeLease(this.baseLease.leaseId) } catch (err) { void err }
    }
    const nextGen = this.baseLease.brainGen + 1
    this.baseLease = this.leaseManager.issueLease({
      execEnvId: this.baseLease.execEnvId,
      incarnationId: `inc_${randomUUID().slice(0, 12)}`,
      sessionKey: this.sessionKey,
      hostKind: 'compute-pool-docker',
      brainGen: nextGen,
    })
    this.server.setPolicy(this.baseLease.leaseId, STANDARD_POLICY)
    return this.baseLease
  }

  private resolveLeaseForTurn(authorityTurnId: string, readOnly: boolean): ExecEnvLeaseRecord {
    const liveBase = this.ensureLiveBaseLease()
    if (!readOnly) return liveBase
    const existing = this.readOnlyLeaseByTurn.get(authorityTurnId)
    const now = this.clock()
    if (existing && existing.state === 'active' && now <= existing.expiresAtMs && existing.brainGen === liveBase.brainGen) {
      if (now > existing.expiresAtMs - 5 * 60_000) {
        try {
          const renewed = this.leaseManager.renewLease(existing.leaseId)
          this.readOnlyLeaseByTurn.set(authorityTurnId, renewed)
          return renewed
        } catch (err) {
          void err
        }
      } else {
        return existing
      }
    }
    return this.replaceReadOnlyTurnLease(authorityTurnId, liveBase, existing)
  }

  private replaceReadOnlyTurnLease(
    authorityTurnId: string,
    liveBase: ExecEnvLeaseRecord,
    previous: ExecEnvLeaseRecord | undefined,
  ): ExecEnvLeaseRecord {
    if (previous) {
      this.server.markLeaseDisconnected(previous.leaseId, 'ro_lease_expired_replaced')
      if (previous.state !== 'closed') {
        try { this.leaseManager.closeLease(previous.leaseId) } catch (err) { void err }
      }
    }
    this.readOnlyLeaseSeq += 1
    const safeTurn = authorityTurnId.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 40)
    const suffix = `:ro:${safeTurn}:g${this.readOnlyLeaseSeq}`
    const prefix = liveBase.leaseId.slice(0, Math.max(1, 120 - suffix.length))
    const roLease = this.leaseManager.issueLease({
      leaseId: `${prefix}${suffix}`,
      execEnvId: liveBase.execEnvId,
      incarnationId: liveBase.incarnationId,
      sessionKey: this.sessionKey,
      hostKind: 'compute-pool-docker',
      brainGen: liveBase.brainGen,
    })
    this.server.setPolicy(roLease.leaseId, READ_ONLY_POLICY)
    this.readOnlyLeaseByTurn.set(authorityTurnId, roLease)
    return roLease
  }

  async waitForHostIsolation(): Promise<void> {
    await this.pendingHostIsolation
  }

  async executeHostTool(input: {
    readonly host: LaneToolHostLike
    readonly clientToolName: string
    readonly arguments: Readonly<Record<string, unknown>>
    readonly schema?: Record<string, unknown>
    readonly callId: string
    readonly authorityTurnId: string
    readonly turnKey: string
    readonly nativeSessionUuid: string
    readonly readOnly: boolean
  }): Promise<Cc5ToolResult> {
    await this.pendingHostIsolation
    this.ensureToolRegistered(input.clientToolName, input.schema)
    const lease = this.resolveLeaseForTurn(input.authorityTurnId, input.readOnly)
    const { envelope, idempotencyKey } = buildBrokerCallEnvelope({
      leaseId: lease.leaseId,
      turnId: input.authorityTurnId,
      callId: input.callId,
      canonicalName: input.clientToolName,
      arguments: input.arguments,
      schema: input.schema,
      fencing: { fencingToken: lease.fencingToken, brainGen: lease.brainGen },
    })
    const { token: capabilityToken } = this.capabilityAuthority.issueToken({
      callId: input.callId,
      toolName: input.clientToolName,
      sessionKey: this.sessionKey,
      leaseId: lease.leaseId,
      brainGen: lease.brainGen,
    })

    this.pendingExecByCallId.set(input.callId, {
      host: input.host,
      nativeSessionUuid: input.nativeSessionUuid,
      turnKey: input.turnKey,
    })
    this.activeCallId = input.callId
    this.activeLeaseId = lease.leaseId
    try {
      const brokerResult = await this.server.invoke({
        ...envelope,
        fencingToken: lease.fencingToken,
        brainGen: lease.brainGen,
        sessionKey: this.sessionKey,
        capabilityToken,
      })
      if (brokerResult.callId !== input.callId || brokerResult.idempotencyKey !== idempotencyKey) {
        throw new Error('REMOTE_TOOL_EFFECT_UNKNOWN')
      }
      if (
        brokerResult.status === 'error' &&
        typeof brokerResult.errorMessage === 'string' &&
        /^CC5_[A-Z0-9_]+$/.test(brokerResult.errorMessage)
      ) {
        throw new Error(brokerResult.errorMessage)
      }
      return toolResultEnvelopeToCc5Result(brokerResult, input.clientToolName, {
        readSpilledPreview: (ref) => this.readSpilledTextPreview(ref),
      })
    } finally {
      this.pendingExecByCallId.delete(input.callId)
      if (this.activeCallId === input.callId) {
        this.activeCallId = undefined
        this.activeLeaseId = undefined
      }
    }
  }

  async cancelActive(reason: string): Promise<void> {
    if (this.activeCallId) {
      await this.server.cancel(this.activeCallId, reason, this.activeLeaseId)
    }
  }

  dispose(reason = 'remote_lane_disposed'): void {
    this.server.markLeaseDisconnected(this.baseLease.leaseId, reason)
    for (const roLease of this.readOnlyLeaseByTurn.values()) {
      this.server.markLeaseDisconnected(roLease.leaseId, reason)
    }
    this.pendingExecByCallId.clear()
    this.activeCallId = undefined
    this.activeLeaseId = undefined
  }

  private readSpilledTextPreview(ref: SpilledBlobRefOutput): string | undefined {
    try {
      const verified = this.server.readSpilledBlobVerified(ref)
      return Buffer.from(verified.bytes.subarray(0, SPILL_PREVIEW_MAX_BYTES)).toString('utf8')
    } catch (err) {
      void err
      return undefined
    }
  }

  private async handleApproval(
    req: ToolApprovalRequest,
    signal: AbortSignal,
  ): Promise<ToolApprovalDecision> {
    const onPermission = this.getPermissionHandler?.()
    if (!onPermission) {
      return { decision: 'deny', reason: req.evaluation.reason }
    }
    const permReq: PermissionRequest = {
      requestId: `perm-${req.approvalId}`,
      toolName: req.toolName,
      toolUseId: req.callId,
      input: {
        ...req.arguments,
        _approvalReason: req.evaluation.reason,
        _approvalId: req.approvalId,
      },
    }
    return await new Promise<ToolApprovalDecision>((resolveDecision) => {
      if (signal.aborted) {
        resolveDecision({ decision: 'deny', reason: String(signal.reason ?? 'APPROVAL_DEFERRED_DETACHED') })
        return
      }
      let settled = false
      const finish = (decision: ToolApprovalDecision) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        resolveDecision(decision)
      }
      const onAbort = () => {
        finish({ decision: 'deny', reason: String(signal.reason ?? 'APPROVAL_DEFERRED_DETACHED') })
      }
      signal.addEventListener('abort', onAbort, { once: true })
      onPermission(permReq).then(
        (reply) => {
          const behavior = reply.behavior === 'allow' || reply.approved === true ? 'approve' : 'deny'
          const reason = typeof reply.message === 'string' ? reply.message : undefined
          finish({ decision: behavior, ...(reason ? { reason } : {}) })
        },
        (err) => {
          finish({
            decision: 'deny',
            reason: err instanceof Error ? err.message : 'REMOTE_PERMISSION_REJECTED',
          })
        },
      )
    })
  }
}

export interface SelfhostRemoteLaneBrokerBinding {
  readonly broker?: RemoteLaneToolBroker
  readonly externalTransport?: ToolBrokerTransportWithAuth
  readonly leaseId?: string
  readonly fencingTokenProvider?: () => { fencingToken: string; brainGen: number }
  readonly issueCapabilityToken?: ExternalCapabilityTokenSupplier
}

export type SelfhostRemoteLaneBrokerProvider = (req: {
  readonly operationId: string
  readonly sessionKey: string
  readonly laneRoot: string
  readonly leaseId?: string
  readonly onHostResetNeeded?: (host: LaneToolHostLike, reason: string) => Promise<void> | void
  readonly getPermissionHandler?: () =>
    | ((request: PermissionRequest) => Promise<Record<string, unknown>>)
    | undefined
}) => SelfhostRemoteLaneBrokerBinding | null

let activeSelfhostRemoteLaneBrokerProvider: SelfhostRemoteLaneBrokerProvider | null = null

export function registerSelfhostRemoteLaneBrokerProvider(
  provider: SelfhostRemoteLaneBrokerProvider | null,
): () => void {
  activeSelfhostRemoteLaneBrokerProvider = provider
  return () => {
    if (activeSelfhostRemoteLaneBrokerProvider === provider) {
      activeSelfhostRemoteLaneBrokerProvider = null
    }
  }
}

export function isSelfhostRemoteLaneBrokerEnabled(): boolean {
  return activeSelfhostRemoteLaneBrokerProvider !== null
}

export function resolveSelfhostRemoteLaneBroker(
  req: Parameters<SelfhostRemoteLaneBrokerProvider>[0],
): SelfhostRemoteLaneBrokerBinding | null {
  return activeSelfhostRemoteLaneBrokerProvider ? activeSelfhostRemoteLaneBrokerProvider(req) : null
}

export function createDefaultLaneBroker(input: {
  readonly operationId: string
  readonly sessionKey: string
  readonly laneRoot: string
  readonly leaseId?: string
  readonly onHostResetNeeded?: (host: LaneToolHostLike, reason: string) => Promise<void> | void
  readonly getPermissionHandler?: () =>
    | ((request: PermissionRequest) => Promise<Record<string, unknown>>)
    | undefined
}): RemoteLaneToolBroker {
  return new RemoteLaneToolBroker({
    operationId: input.operationId,
    sessionKey: input.sessionKey,
    walDir: join(input.laneRoot, 'tool-broker-wal'),
    leaseId: input.leaseId,
    onHostResetNeeded: input.onHostResetNeeded,
    getPermissionHandler: input.getPermissionHandler,
  })
}

export async function invokeExternalBrokerTransport(input: {
  readonly broker: ToolBrokerTransportWithAuth
  readonly leaseId: string
  readonly turnId: string
  readonly callId: string
  readonly clientToolName: string
  readonly sessionKey?: string
  readonly arguments: Readonly<Record<string, unknown>>
  readonly schema?: Record<string, unknown>
  readonly fencing?: { readonly fencingToken: string; readonly brainGen: number }
  readonly capabilityToken?: string
  readonly issueCapabilityToken?: ExternalCapabilityTokenSupplier
}): Promise<Cc5ToolResult> {
  const { envelope, idempotencyKey } = buildBrokerCallEnvelope({
    leaseId: input.leaseId,
    turnId: input.turnId,
    callId: input.callId,
    canonicalName: input.clientToolName,
    arguments: input.arguments,
    schema: input.schema,
    fencing: input.fencing,
  })
  const capabilityToken =
    input.capabilityToken ??
    (input.issueCapabilityToken
      ? await input.issueCapabilityToken({
          callId: input.callId,
          toolName: input.clientToolName,
          sessionKey: input.sessionKey ?? '',
          leaseId: input.leaseId,
          brainGen: input.fencing?.brainGen,
        })
      : undefined)
  const extra =
    capabilityToken !== undefined || input.sessionKey !== undefined
      ? {
          ...(capabilityToken !== undefined ? { capabilityToken } : {}),
          ...(input.sessionKey !== undefined ? { sessionKey: input.sessionKey } : {}),
        }
      : undefined
  const brokerResult = extra
    ? await input.broker.invoke(envelope, extra)
    : await input.broker.invoke(envelope)
  if (brokerResult.callId !== input.callId || brokerResult.idempotencyKey !== idempotencyKey) {
    throw new Error('REMOTE_TOOL_EFFECT_UNKNOWN')
  }
  return toolResultEnvelopeToCc5Result(brokerResult, input.clientToolName)
}
