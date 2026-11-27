/**
 * OCV5-915 P3-2 — Gate 4 Approval Coordinator, Shared Runtime Contracts, and Spill Reader
 * for `GatewayToolBrokerRuntime` (`rt-misc` rank 2).
 *
 * Extracted from `toolBrokerRuntime.ts` to keep both modules cleanly <= 800 lines.
 * Zero syncIo / process.env / emptyCatch / typeEscape.
 */
import { randomUUID } from 'node:crypto'
import type { ActionPolicyEvaluation, ExecEnvHostKind, ExecutionPolicyEnvelope } from '@openclaude/protocol'
import type { FrameLinkLike, ToolBrokerWireFrame } from '@openclaude/protocol/exec-env'
import { evaluateActionPolicy, type AiReviewHook, type LoadedActionPolicy } from './actionPolicyEngine.js'
import { evaluateShellForHook, type GuardMode } from './agentEfficiencyGuard.js'
import {
  ContainerLinkToolBrokerHost,
  ToolBrokerPolicyError,
  extractActionPolicyTarget,
  type DetachedApprovalCard,
  type ExecEnvLeaseManager,
  type ExecEnvLeaseRecord,
  type ScopedCapabilityTokenAuthority,
  type SpilledBlobRefOutput,
  type ToolApprovalDecision,
  type ToolApprovalRequest,
  type ToolBrokerResultEnvelope,
  type ToolBrokerServer,
} from './execEnv/index.js'
import type { Logger } from './logger.js'
import {
  TOOL_BROKER_APPROVAL_REQUEST_PREFIX,
  isPlainRecord,
  parseToolBrokerApprovalDecision,
  type SpillOwnershipStore,
} from './toolBrokerSessionStore.js'

const MAX_SPILL_READ_BYTES = 256 * 1024
const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set([
  'bash',
  'shell',
  'oc_bash',
  'run_command',
  'exec_command',
  'terminal',
])

export interface ToolBrokerApprovalCardContext {
  readonly requestId: string
  readonly approvalId: string
  readonly sessionKey: string
  readonly callId: string
  readonly toolName: string
  readonly command?: string
  readonly reason: string
  readonly evaluation: ActionPolicyEvaluation
  readonly expiresAt: number
}

export interface ToolBrokerApprovalBridge {
  openApprovalCard(ctx: ToolBrokerApprovalCardContext): Promise<void> | void
  settleApprovalCard?(input: {
    readonly requestId: string
    readonly sessionKey: string
    readonly behavior: 'allow' | 'deny'
    readonly reason: 'remote' | 'already_settled' | 'disconnect' | 'timeout' | 'crashed' | 'user_stop'
  }): Promise<void> | void
  markDetachedCard?(
    card: DetachedApprovalCard & { readonly requestId: string; readonly sessionKey: string },
  ): Promise<void> | void
}

export interface ToolBrokerPermissionResponseInput {
  readonly requestId: string
  readonly behavior: 'allow' | 'deny'
  readonly message?: string
  readonly updatedInput?: Record<string, unknown>
}

export interface GatewayToolBrokerRuntimeOptions {
  readonly homeDir?: string
  readonly walDir?: string
  readonly credDir?: string
  readonly execEnvId?: string
  readonly hostKind?: ExecEnvHostKind
  readonly loadedActionPolicy?: LoadedActionPolicy
  readonly actionPolicyPath?: string
  readonly aiReviewHook?: AiReviewHook
  readonly trustedStrongModels?: readonly string[]
  readonly defaultMainModel?: string
  readonly shellHookGuardMode?: GuardMode
  readonly detachedFallbackAfterMs?: number
  readonly maxConcurrentToolCalls?: number
  readonly maxInlinePayloadBytes?: number
  readonly maxConsumedNonces?: number
  readonly approvalBridge?: ToolBrokerApprovalBridge
  readonly baseToolEnv?: Readonly<Record<string, string | undefined>>
  readonly registerDefaultMcpTools?: boolean
  readonly registerAntigravityHook?: boolean
  readonly registerEfficiencyHook?: boolean
  readonly registerRemoteLaneBroker?: boolean
  readonly clock?: () => number
  readonly log?: Pick<Logger, 'info' | 'warn' | 'error'>
}

export interface HookEvaluateInput {
  readonly toolName: string
  readonly arguments?: Readonly<Record<string, unknown>>
  readonly command?: string
  readonly target?: string
  readonly mainModel?: string
  readonly callId?: string
  readonly mintCapabilityToken?: boolean
  readonly guardMode?: GuardMode
}

export interface HookEvaluateResult {
  readonly decision: 'allow' | 'deny'
  readonly code?: string
  readonly reason?: string
  readonly message?: string
  readonly approvalStatus?: 'not_required' | 'approved' | 'denied' | 'detached_pending'
  readonly evaluation?: ActionPolicyEvaluation
  readonly detachedCard?: DetachedApprovalCard
  readonly capabilityToken?: string
}

export interface McpExecuteInput {
  readonly toolName: string
  readonly arguments?: Readonly<Record<string, unknown>>
  readonly callId?: string
  readonly turnId?: string
  readonly timeoutMs?: number
  readonly mainModel?: string
}

export interface McpExecuteResult {
  readonly ok: boolean
  readonly result: ToolBrokerResultEnvelope
  readonly preview?: string
}

export interface SpillReadInput {
  readonly blobId: string
  readonly sha256?: string
  readonly offset?: number
  readonly limit?: number
}

export interface SpillReadResult {
  readonly ok: boolean
  readonly blobId?: string
  readonly sha256?: string
  readonly mimeType?: string
  readonly totalBytes?: number
  readonly offset?: number
  readonly bytesRead?: number
  readonly hasMore?: boolean
  readonly contentBase64?: string
  readonly textPreview?: string
  readonly errorCode?: string
  readonly errorMessage?: string
}

interface ActiveApprovalWaiter {
  readonly requestId: string
  readonly approvalId: string
  readonly sessionKey: string
  readonly turnId?: string
  readonly grantId?: string
  readonly callId: string
  readonly toolName: string
  phase: 'waiting' | 'answered_in_window' | 'released_to_detached'
  resolve: (decision: ToolApprovalDecision) => void
  onAbort: () => void
  signal: AbortSignal
}

export function extractShellCommand(args: Readonly<Record<string, unknown>>): string | undefined {
  for (const key of ['command', 'CommandLine', 'cmd', 'script']) {
    const val = args[key]
    if (typeof val === 'string' && val.trim().length > 0) return val
  }
  return undefined
}

export function isSpilledBlobRefOutput(value: unknown): value is SpilledBlobRefOutput {
  return (
    isPlainRecord(value) &&
    value.type === 'blob_ref' &&
    typeof value.blobId === 'string' &&
    typeof value.sha256 === 'string' &&
    typeof value.mimeType === 'string' &&
    typeof value.bytes === 'number'
  )
}

export function denyHookResponse(
  code: string,
  reason: string,
  extra?: Partial<HookEvaluateResult>,
): { readonly status: number; readonly body: HookEvaluateResult & { readonly ok: boolean } } {
  return { status: 200, body: { ok: true, decision: 'deny', code, reason, ...extra } }
}

export function mapMcpResultHttpStatus(result: ToolBrokerResultEnvelope): number {
  if (result.status === 'ok') return 200
  if (
    result.errorCode === 'TOOL_BROKER_TURN_TOKEN_REVOKED' ||
    result.errorCode === 'TOOL_BROKER_TURN_TOKEN_EXPIRED' ||
    result.errorCode === 'EXEC_FENCING_TOKEN_STALE'
  ) {
    return 401
  }
  return result.status === 'denied' ? 403 : 500
}

export function computeMcpEffectiveTimeout(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  requestedTimeoutMs: number | undefined,
): number | undefined {
  if (toolName !== 'oc_bash') return requestedTimeoutMs
  const softWaitMs =
    typeof args.timeout_ms === 'number' && Number.isFinite(args.timeout_ms)
      ? Math.max(50, Math.min(600_000, Math.floor(args.timeout_ms)))
      : 60_000
  return Math.min(660_000, Math.max(softWaitMs + 30_000, requestedTimeoutMs ?? 0))
}

export async function readAuthorizedSpillSlice(params: {
  readonly sessionKey: string
  readonly input: SpillReadInput
  readonly spillOwners: SpillOwnershipStore
  readonly server: ToolBrokerServer
}): Promise<{ readonly status: number; readonly body: SpillReadResult }> {
  const { sessionKey, input, spillOwners, server } = params
  if (!(await spillOwners.isAuthorized(input.blobId, sessionKey))) {
    return {
      status: 403,
      body: {
        ok: false,
        errorCode: 'SPILL_OWNERSHIP_DENIED',
        errorMessage: `Spilled blob "${input.blobId}" does not belong to session "${sessionKey}"`,
      },
    }
  }
  try {
    const verified = server.readSpilledBlobVerified(input.blobId)
    if (input.sha256 && verified.sha256 !== input.sha256) {
      throw new ToolBrokerPolicyError('TOOL_SPILLED_BLOB_CORRUPT', `Spilled blob "${input.blobId}" SHA-256 mismatch`)
    }
    const offset = Math.max(0, Math.min(verified.byteLength, Math.floor(input.offset ?? 0)))
    const limit = Math.max(1, Math.min(MAX_SPILL_READ_BYTES, Math.floor(input.limit ?? MAX_SPILL_READ_BYTES)))
    const slice = verified.bytes.subarray(offset, Math.min(verified.byteLength, offset + limit))
    const isText = verified.mimeType.startsWith('text/') || verified.mimeType.includes('json')
    return {
      status: 200,
      body: {
        ok: true,
        blobId: verified.blobId,
        sha256: verified.sha256,
        mimeType: verified.mimeType,
        totalBytes: verified.byteLength,
        offset,
        bytesRead: slice.byteLength,
        hasMore: offset + slice.byteLength < verified.byteLength,
        contentBase64: Buffer.from(slice).toString('base64'),
        ...(isText ? { textPreview: Buffer.from(slice).toString('utf8') } : {}),
      },
    }
  } catch (err) {
    const code = err instanceof ToolBrokerPolicyError ? err.code : 'TOOL_SPILLED_BLOB_MISSING'
    return {
      status: code === 'TOOL_SPILLED_BLOB_MISSING' ? 404 : 422,
      body: { ok: false, errorCode: code, errorMessage: err instanceof Error ? err.message : String(err) },
    }
  }
}

export class ToolBrokerApprovalCoordinator {
  private readonly activeApprovalWaiters = new Map<string, ActiveApprovalWaiter>()
  private readonly detachedApprovalIds = new Map<
    string,
    { readonly sessionKey: string; readonly card: DetachedApprovalCard }
  >()

  constructor(
    private readonly deps: {
      readonly approvalBridge?: ToolBrokerApprovalBridge
      readonly detachedFallbackAfterMs: number
      readonly leaseManager: ExecEnvLeaseManager
      readonly clock: () => number
      readonly log?: Pick<Logger, 'info' | 'warn' | 'error'>
    },
  ) {}

  handlePermissionResponse(input: ToolBrokerPermissionResponseInput): boolean {
    const decision = parseToolBrokerApprovalDecision(input)
    const effectiveBehavior: 'allow' | 'deny' = decision.decision === 'approve' ? 'allow' : 'deny'
    const active = this.activeApprovalWaiters.get(input.requestId)
    if (active) {
      if (active.phase !== 'waiting') return true
      active.phase = 'answered_in_window'
      active.signal.removeEventListener('abort', active.onAbort)
      this.activeApprovalWaiters.delete(input.requestId)
      this.settleCardBestEffort(active.requestId, active.sessionKey, effectiveBehavior, 'remote', 'settleApprovalCard')
      active.resolve(decision)
      return true
    }
    const detached = this.detachedApprovalIds.get(input.requestId)
    if (detached) {
      this.detachedApprovalIds.delete(input.requestId)
      this.settleCardBestEffort(input.requestId, detached.sessionKey, 'deny', 'timeout', 'detached settleApprovalCard')
      return true
    }
    return false
  }

  cancelTurnWaiters(sessionKey: string, turnId: string, reason: string, grantId?: string): number {
    let count = 0
    for (const [reqId, waiter] of [...this.activeApprovalWaiters]) {
      if (waiter.sessionKey !== sessionKey || waiter.turnId !== turnId || waiter.phase !== 'waiting') continue
      if (grantId !== undefined && waiter.grantId !== grantId) continue
      this.abortWaiterEntry(reqId, waiter, reason)
      count += 1
    }
    return count
  }

  cancelSessionWaiters(sessionKey: string, reason: string): void {
    for (const [reqId, waiter] of [...this.activeApprovalWaiters]) {
      if (waiter.sessionKey !== sessionKey || waiter.phase !== 'waiting') continue
      this.abortWaiterEntry(reqId, waiter, reason)
    }
  }

  private abortWaiterEntry(reqId: string, waiter: ActiveApprovalWaiter, reason: string): void {
    waiter.phase = 'released_to_detached'
    waiter.signal.removeEventListener('abort', waiter.onAbort)
    this.activeApprovalWaiters.delete(reqId)
    waiter.resolve({ decision: 'deny', reason })
    void Promise.resolve(
      this.deps.approvalBridge?.settleApprovalCard?.({
        requestId: reqId,
        sessionKey: waiter.sessionKey,
        behavior: 'deny',
        reason: 'user_stop',
      }),
    ).catch((err) => {
      void err
    })
  }

  async resolveHookHumanApproval(params: {
    readonly lease: ExecEnvLeaseRecord
    readonly sessionKey: string
    readonly turnId?: string
    readonly grantId?: string
    readonly signal?: AbortSignal
    readonly callId: string
    readonly effectiveName: string
    readonly effectiveArgs: Readonly<Record<string, unknown>>
    readonly command?: string
    readonly policyEval: ActionPolicyEvaluation
  }): Promise<{ readonly status: number; readonly body: HookEvaluateResult & { readonly ok: boolean } } | null> {
    const approvalId = `appr_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    const outcome = await this.awaitBlockingThenDetachedApproval(
      {
        approvalId,
        leaseId: params.lease.leaseId,
        sessionKey: params.sessionKey,
        turnId: params.turnId,
        grantId: params.grantId,
        callId: params.callId,
        toolName: params.effectiveName,
        arguments: params.effectiveArgs,
        command: params.command,
        evaluation: params.policyEval,
      },
      params.signal,
    )
    if (outcome.kind === 'detached') {
      const card: DetachedApprovalCard = {
        approvalId,
        leaseId: params.lease.leaseId,
        callId: params.callId,
        toolName: params.effectiveName,
        reason: params.policyEval.reason,
        evaluation: params.policyEval,
        createdAtMs: this.deps.clock(),
      }
      this.handleDetachedApprovalCard(card, params.sessionKey)
      return denyHookResponse(
        'APPROVAL_DEFERRED_DETACHED',
        `Human approval timed out after ${this.deps.detachedFallbackAfterMs}ms; downgraded to async approval card ${approvalId}`,
        { approvalStatus: 'detached_pending', evaluation: params.policyEval, detachedCard: card },
      )
    }
    if (outcome.decision !== 'approve') {
      return denyHookResponse('HUMAN_APPROVAL_DENIED', outcome.reason ?? 'Action denied by human approver', {
        approvalStatus: 'denied',
        evaluation: params.policyEval,
      })
    }
    return null
  }

  async requestApproval(req: ToolApprovalRequest, signal: AbortSignal): Promise<ToolApprovalDecision> {
    const bridge = this.deps.approvalBridge
    if (!bridge) return { decision: 'deny', reason: req.evaluation.reason }
    const requestId = `${TOOL_BROKER_APPROVAL_REQUEST_PREFIX}${req.approvalId}`
    return await new Promise<ToolApprovalDecision>((resolveDecision) => {
      if (signal.aborted) {
        resolveDecision({ decision: 'deny', reason: String(signal.reason ?? 'APPROVAL_ABORTED') })
        return
      }
      const onAbort = () => {
        const entry = this.activeApprovalWaiters.get(requestId)
        if (!entry || entry.phase !== 'waiting') return
        entry.phase = 'released_to_detached'
        this.activeApprovalWaiters.delete(requestId)
        const reasonText = String(signal.reason ?? 'APPROVAL_DEFERRED_DETACHED')
        if (!reasonText.includes('APPROVAL_DEFERRED_DETACHED')) {
          void Promise.resolve(
            bridge.settleApprovalCard?.({ requestId, sessionKey: req.sessionKey, behavior: 'deny', reason: 'user_stop' }),
          ).catch((err) => { void err })
        }
        resolveDecision({ decision: 'deny', reason: reasonText })
      }
      this.activeApprovalWaiters.set(requestId, {
        requestId,
        approvalId: req.approvalId,
        sessionKey: req.sessionKey,
        turnId: req.turnId,
        grantId: req.grantId,
        callId: req.callId,
        toolName: req.toolName,
        phase: 'waiting',
        resolve: resolveDecision,
        onAbort,
        signal,
      })
      signal.addEventListener('abort', onAbort, { once: true })
      void Promise.resolve(
        bridge.openApprovalCard({
          requestId,
          approvalId: req.approvalId,
          sessionKey: req.sessionKey,
          callId: req.callId,
          toolName: req.toolName,
          ...(req.command ? { command: req.command } : {}),
          reason: req.evaluation.reason,
          evaluation: req.evaluation,
          expiresAt: this.deps.clock() + 24 * 60 * 60_000,
        }),
      ).catch((err) => {
        const entry = this.activeApprovalWaiters.get(requestId)
        if (entry && entry.phase === 'waiting') {
          entry.phase = 'released_to_detached'
          signal.removeEventListener('abort', onAbort)
          this.activeApprovalWaiters.delete(requestId)
          resolveDecision({ decision: 'deny', reason: err instanceof Error ? err.message : String(err) })
        }
      })
    })
  }

  handleDetachedApprovalCard(card: DetachedApprovalCard, explicitSessionKey?: string): void {
    const requestId = `${TOOL_BROKER_APPROVAL_REQUEST_PREFIX}${card.approvalId}`
    const sessionKey = explicitSessionKey ?? this.deps.leaseManager.getLease(card.leaseId)?.sessionKey ?? ''
    this.detachedApprovalIds.set(requestId, { sessionKey, card })
    void Promise.resolve(this.deps.approvalBridge?.markDetachedCard?.({ ...card, requestId, sessionKey })).catch(
      (err) => {
        this.deps.log?.warn('tool-broker markDetachedCard failed', { err: String(err) })
      },
    )
  }

  private settleCardBestEffort(
    requestId: string,
    sessionKey: string,
    behavior: 'allow' | 'deny',
    reason: 'remote' | 'timeout',
    label: string,
  ): void {
    void Promise.resolve(
      this.deps.approvalBridge?.settleApprovalCard?.({ requestId, sessionKey, behavior, reason }),
    ).catch((err) => {
      this.deps.log?.warn(`tool-broker ${label} failed`, { err: String(err) })
    })
  }

  private async awaitBlockingThenDetachedApproval(
    request: ToolApprovalRequest,
    externalSignal?: AbortSignal,
  ): Promise<
    | { readonly kind: 'decided'; readonly decision: 'approve' | 'deny'; readonly reason?: string }
    | { readonly kind: 'detached' }
  > {
    if (!this.deps.approvalBridge) return { kind: 'decided', decision: 'deny', reason: request.evaluation.reason }
    if (externalSignal?.aborted) {
      return { kind: 'decided', decision: 'deny', reason: String(externalSignal.reason ?? 'APPROVAL_ABORTED') }
    }
    const controller = new AbortController()
    const onExternalAbort = () => controller.abort(externalSignal?.reason ?? new Error('APPROVAL_ABORTED'))
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true })
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      return await Promise.race([
        this.requestApproval(request, controller.signal).then((res) => ({
          kind: 'decided' as const,
          decision: res.decision,
          reason: res.reason,
        })),
        new Promise<{ readonly kind: 'detached' }>((resolveDetached) => {
          timer = setTimeout(() => {
            controller.abort(new Error('APPROVAL_DEFERRED_DETACHED'))
            resolveDetached({ kind: 'detached' })
          }, this.deps.detachedFallbackAfterMs)
        }),
      ])
    } catch (err) {
      return { kind: 'decided', decision: 'deny', reason: err instanceof Error ? err.message : String(err) }
    } finally {
      if (timer) clearTimeout(timer)
      externalSignal?.removeEventListener('abort', onExternalAbort)
    }
  }
}

export async function evaluateHookShellAndPolicy(params: {
  readonly sessionKey: string
  readonly effectiveName: string
  readonly effectiveArgs: Readonly<Record<string, unknown>>
  readonly input: HookEvaluateInput
  readonly shellHookGuardMode: GuardMode
  readonly defaultMainModel?: string
  readonly loadActionPolicy: () => LoadedActionPolicy
  readonly trustedStrongModels?: readonly string[]
  readonly aiReviewHook?: AiReviewHook
}): Promise<
  | { readonly denied: { readonly status: number; readonly body: HookEvaluateResult & { readonly ok: boolean } } }
  | { readonly denied: null; readonly command?: string; readonly effMessage?: string; readonly policyEval: ActionPolicyEvaluation }
> {
  const { sessionKey, effectiveName, effectiveArgs, input } = params
  const shellTool = SHELL_TOOL_NAMES.has(effectiveName.toLowerCase())
  const command = input.command ?? (shellTool ? extractShellCommand(effectiveArgs) : undefined)
  let effMessage: string | undefined
  if (shellTool && command) {
    const eff = evaluateShellForHook(command, input.guardMode ?? params.shellHookGuardMode)
    if (eff.decision === 'deny') {
      return {
        denied: denyHookResponse(
          'SHELL_EFFICIENCY_GUARD_DENIED',
          eff.message ?? 'Shell command blocked by efficiency guard',
        ),
      }
    }
    effMessage = eff.message ?? undefined
  }
  const mainModel = input.mainModel ?? params.defaultMainModel
  const target = extractActionPolicyTarget(effectiveArgs, input.target)
  const policyEval = await evaluateActionPolicy(
    {
      toolName: shellTool ? 'Bash' : effectiveName,
      ...(command ? { command } : {}),
      ...(target ? { target } : {}),
      args: { ...effectiveArgs },
      mainModel,
      sessionKey,
    },
    {
      loaded: params.loadActionPolicy(),
      mainModel,
      trustedStrongModels: params.trustedStrongModels,
      aiReviewHook: params.aiReviewHook,
    },
  )
  if (policyEval.tier === 'deny') {
    return {
      denied: denyHookResponse('ACTION_POLICY_DENIED', policyEval.reason, {
        evaluation: policyEval,
        approvalStatus: 'denied',
      }),
    }
  }
  return { denied: null, command, effMessage, policyEval }
}

interface BridgeHostBinding {
  readonly host: ContainerLinkToolBrokerHost
  readonly emitInbound: (raw: string) => void
}

export class ToolBrokerBridgeRegistry {
  private readonly bridgeHosts = new Map<object, BridgeHostBinding>()

  constructor(
    private readonly deps: {
      readonly server: ToolBrokerServer
      readonly leaseManager: ExecEnvLeaseManager
      readonly rebindAuthority: ScopedCapabilityTokenAuthority
    },
  ) {}

  attach(socketKey: object, sendRaw: (frame: string) => void): void {
    if (this.bridgeHosts.has(socketKey)) return
    const listeners = new Set<(raw: string) => void>()
    const link: FrameLinkLike = {
      send: sendRaw,
      onFrame(cb) {
        listeners.add(cb)
        return () => {
          listeners.delete(cb)
        }
      },
    }
    const host = new ContainerLinkToolBrokerHost({
      link,
      server: this.deps.server,
      leaseManager: this.deps.leaseManager,
      rebindAuthority: this.deps.rebindAuthority,
    })
    this.bridgeHosts.set(socketKey, {
      host,
      emitInbound(raw: string) {
        for (const cb of [...listeners]) cb(raw)
      },
    })
  }

  handleWireFrame(socketKey: object, frame: ToolBrokerWireFrame, sendRaw: (raw: string) => void): void {
    if (!this.bridgeHosts.has(socketKey)) this.attach(socketKey, sendRaw)
    this.bridgeHosts.get(socketKey)?.emitInbound(JSON.stringify(frame))
  }

  detach(socketKey: object, reason = 'bridge_ws_disconnected'): void {
    const binding = this.bridgeHosts.get(socketKey)
    if (!binding) return
    this.bridgeHosts.delete(socketKey)
    binding.host.dispose(reason)
  }

  disposeAll(reason = 'broker_runtime_disposed'): void {
    for (const key of [...this.bridgeHosts.keys()]) this.detach(key, reason)
  }
}

interface PendingHookEntry {
  readonly controller: AbortController
  readonly turnId?: string
  readonly grantId?: string
}

export class PendingHookEvaluationTracker {
  private readonly bySession = new Map<string, Set<PendingHookEntry>>()

  begin(sessionKey: string, turnId?: string, grantId?: string): { readonly signal: AbortSignal; readonly finish: () => void } {
    const entry: PendingHookEntry = { controller: new AbortController(), turnId, grantId }
    let set = this.bySession.get(sessionKey)
    if (!set) {
      set = new Set()
      this.bySession.set(sessionKey, set)
    }
    set.add(entry)
    return {
      signal: entry.controller.signal,
      finish: () => {
        const cur = this.bySession.get(sessionKey)
        if (!cur) return
        cur.delete(entry)
        if (cur.size === 0) this.bySession.delete(sessionKey)
      },
    }
  }

  cancelTurn(sessionKey: string, turnId: string, reason: string, grantId?: string): number {
    const set = this.bySession.get(sessionKey)
    if (!set) return 0
    let count = 0
    for (const entry of [...set]) {
      if (entry.turnId !== turnId) continue
      if (grantId !== undefined && entry.grantId !== grantId) continue
      set.delete(entry)
      if (!entry.controller.signal.aborted) entry.controller.abort(reason)
      count += 1
    }
    if (set.size === 0) this.bySession.delete(sessionKey)
    return count
  }

  cancelSession(sessionKey: string, reason: string): void {
    const set = this.bySession.get(sessionKey)
    if (!set) return
    this.bySession.delete(sessionKey)
    for (const entry of set) {
      if (!entry.controller.signal.aborted) entry.controller.abort(reason)
    }
  }
}

export function checkHookSessionPolicyList(
  sessionPolicy: ExecutionPolicyEnvelope,
  rawToolName: string,
  effectiveName: string,
): { readonly status: number; readonly body: HookEvaluateResult & { readonly ok: boolean } } | null {
  if (sessionPolicy.deniedTools?.includes(rawToolName) || sessionPolicy.deniedTools?.includes(effectiveName)) {
    return denyHookResponse('EXEC_POLICY_TOOL_DENIED', `Tool "${effectiveName}" denied by execution policy`)
  }
  if (
    sessionPolicy.allowedTools.length > 0 &&
    !sessionPolicy.allowedTools.includes(effectiveName) &&
    !sessionPolicy.allowedTools.includes(rawToolName)
  ) {
    return denyHookResponse('EXEC_POLICY_TOOL_NOT_ALLOWED', `Tool "${effectiveName}" is not in allowedTools`)
  }
  return null
}
