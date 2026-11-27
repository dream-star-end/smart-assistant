/**
 * OCV5-915 P3-2 — Container-Authoritative `GatewayToolBrokerRuntime` (`rt-misc` rank 2).
 *
 * Owns in-memory `ExecEnvLeaseManager`, ephemeral `ScopedCapabilityTokenAuthority`
 * (`randomBytes(32)` strictly in memory — NEVER in `process.env`, `requireCapabilityToken: true`),
 * turn-epoch-bound `octh1.*` / `octm1.*` tokens (with S2 `workspaceCwd` binding and S3 sliding
 * renewal), `ToolBrokerDiskSpillStore` + session-bound `SpillOwnershipStore`,
 * `BrokerBashJobManager` (S1 active/finished capacity separation), `ToolBrokerServer`,
 * bridge WS `ContainerLinkToolBrokerHost`, Antigravity/CCB/Cursor hook providers, and Gate 4 approval.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { join, relative, resolve } from 'node:path'
import {
  computeSchemaFilteredArgsSha256, computeToolIdempotencyKey, isReadOnlyAllowedCanonicalTool,
  type ExecEnvHostKind, type ExecutionPolicyEnvelope, type ExecutionPolicyMode, type ToolCallEnvelope,
} from '@openclaude/protocol'
import type { ToolBrokerWireFrame } from '@openclaude/protocol/exec-env'
import { paths } from '@openclaude/storage'
import { loadActionPolicy, type AiReviewHook, type LoadedActionPolicy } from './actionPolicyEngine.js'
import type { GuardMode } from './agentEfficiencyGuard.js'
import { registerEfficiencyBrokerHookProvider, type EfficiencyBrokerHookBinding } from './efficiencyHookConfig.js'
import { registerAntigravityBrokerHookProvider, type AntigravityBrokerHookBinding } from './engine/antigravityBrokerHook.js'
import { createDefaultLaneBroker, registerSelfhostRemoteLaneBrokerProvider } from './remotePool/containerLaneBroker.js'
import {
  ExecEnvLeaseError, ExecEnvLeaseManager, SCOPED_CAPABILITY_TOKEN_PREFIX, ScopedCapabilityTokenAuthority,
  TOOL_BROKER_DEFAULT_DETACHED_FALLBACK_MS, TOOL_BROKER_DEFAULT_MAX_CONCURRENCY,
  TOOL_BROKER_DEFAULT_MAX_INLINE_PAYLOAD_BYTES, ToolBrokerPolicyError, ToolBrokerServer,
  type ExecEnvLeaseRecord, type RegisteredToolDefinition, type ToolBrokerResultEnvelope,
} from './execEnv/index.js'
import { ToolBrokerDiskSpillStore } from './execEnv/toolBrokerDiskSpill.js'
import {
  PendingHookEvaluationTracker, ToolBrokerApprovalCoordinator, ToolBrokerBridgeRegistry,
  checkHookSessionPolicyList, computeMcpEffectiveTimeout, denyHookResponse, evaluateHookShellAndPolicy,
  isSpilledBlobRefOutput, mapMcpResultHttpStatus, readAuthorizedSpillSlice,
  type GatewayToolBrokerRuntimeOptions, type HookEvaluateInput, type HookEvaluateResult,
  type McpExecuteInput, type McpExecuteResult, type SpillReadInput, type SpillReadResult,
  type ToolBrokerApprovalBridge, type ToolBrokerApprovalCardContext, type ToolBrokerPermissionResponseInput,
} from './toolBrokerApprovals.js'
import { BrokerBashJobManager } from './toolBrokerBashJobs.js'
import { registerDefaultBrokerLocalTools } from './toolBrokerLocalTools.js'
import {
  SessionLeaseStore, SpillOwnershipStore, TOOL_BROKER_APPROVAL_REQUEST_PREFIX,
  TOOL_BROKER_HOOK_TOKEN_PREFIX, TOOL_BROKER_MCP_TOKEN_PREFIX, TurnScopedTokenStore,
  isPlainRecord, parseToolBrokerApprovalDecision, scrubToolBrokerEnv, stricterPolicyMode,
  validateAndUnwrapToolWrapper, writePrivateFileAtomic0600,
  type TurnScopedBrokerTokenClaims, type TurnTokenRevokedEvent,
} from './toolBrokerSessionStore.js'

export {
  TOOL_BROKER_APPROVAL_REQUEST_PREFIX, TOOL_BROKER_HOOK_TOKEN_PREFIX, TOOL_BROKER_MCP_TOKEN_PREFIX,
  parseToolBrokerApprovalDecision, scrubToolBrokerEnv,
}
export type {
  GatewayToolBrokerRuntimeOptions, HookEvaluateInput, HookEvaluateResult, McpExecuteInput, McpExecuteResult,
  SpillReadInput, SpillReadResult, ToolBrokerApprovalBridge, ToolBrokerApprovalCardContext,
  ToolBrokerPermissionResponseInput, TurnScopedBrokerTokenClaims,
}

const DEFAULT_SINGLE_USE_TTL_MS = 30_000
const SPILL_PREVIEW_BYTES = 4096

type VerifiedTurnContext =
  | { readonly ok: true; readonly claims: TurnScopedBrokerTokenClaims; readonly lease: ExecEnvLeaseRecord }
  | { readonly ok: false; readonly status: 401 | 403; readonly code: string; readonly message: string }
type HookHttpResponse = { readonly status: number; readonly body: HookEvaluateResult & { readonly ok: boolean } }
interface IssueTurnTokenInput {
  readonly sessionKey: string
  readonly mode?: ExecutionPolicyMode
  readonly turnEpoch?: number
  readonly turnId?: string
  readonly ttlMs?: number
  readonly workspaceCwd?: string
}

export class GatewayToolBrokerRuntime {
  readonly execEnvId: string
  readonly hostKind: ExecEnvHostKind
  readonly walDir: string
  readonly credDir: string
  readonly leaseManager: ExecEnvLeaseManager
  readonly capabilityAuthority: ScopedCapabilityTokenAuthority
  readonly spillStore: ToolBrokerDiskSpillStore
  readonly bashJobs: BrokerBashJobManager
  readonly server: ToolBrokerServer

  private readonly clock: () => number
  private readonly explicitLoadedActionPolicy?: LoadedActionPolicy
  private readonly actionPolicyPath?: string
  private readonly aiReviewHook?: AiReviewHook
  private readonly trustedStrongModels?: readonly string[]
  private readonly defaultMainModel?: string
  private readonly shellHookGuardMode: GuardMode
  private readonly baseToolEnv: Readonly<Record<string, string | undefined>>
  private readonly turnTokens: TurnScopedTokenStore
  private readonly sessionLeases: SessionLeaseStore
  private readonly spillOwners: SpillOwnershipStore
  private readonly approvals: ToolBrokerApprovalCoordinator
  private readonly bridgeRegistry: ToolBrokerBridgeRegistry
  private readonly pendingHooks = new PendingHookEvaluationTracker()
  private readonly activeCallWorkspaceCwd = new Map<string, string>()
  private unregisterAntigravityHook: (() => void) | null = null
  private unregisterEfficiencyHook: (() => void) | null = null
  private unregisterRemoteLaneBroker: (() => void) | null = null

  constructor(opts: GatewayToolBrokerRuntimeOptions = {}) {
    this.clock = opts.clock ?? (() => Date.now())
    this.execEnvId = opts.execEnvId ?? `env-local-${randomUUID().slice(0, 12)}`
    this.hostKind = opts.hostKind ?? 'local-docker'
    const homeDir = opts.homeDir ?? paths.home
    this.walDir = opts.walDir ?? join(homeDir, 'exec-env-broker-wal')
    this.credDir = opts.credDir ?? join(homeDir, 'tool-broker-runtime', 'turn-creds')
    this.explicitLoadedActionPolicy = opts.loadedActionPolicy
    this.actionPolicyPath = opts.actionPolicyPath
    this.aiReviewHook = opts.aiReviewHook
    this.trustedStrongModels = opts.trustedStrongModels
    this.defaultMainModel = opts.defaultMainModel
    this.shellHookGuardMode = opts.shellHookGuardMode ?? 'deny'
    const detachedFallbackAfterMs = Math.max(
      1,
      Math.floor(opts.detachedFallbackAfterMs ?? TOOL_BROKER_DEFAULT_DETACHED_FALLBACK_MS),
    )
    this.baseToolEnv = opts.baseToolEnv ?? {
      HOME: homeDir,
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      LANG: 'C.UTF-8',
    }
    this.turnTokens = new TurnScopedTokenStore({
      secret: randomBytes(32),
      clock: this.clock,
      onTurnRevoked: (scope) => { this.handleTurnTokenRevoked(scope) },
    })
    this.leaseManager = new ExecEnvLeaseManager({ clock: this.clock })
    this.capabilityAuthority = new ScopedCapabilityTokenAuthority({
      secret: randomBytes(32),
      defaultTtlMs: DEFAULT_SINGLE_USE_TTL_MS,
      maxConsumedNonces: opts.maxConsumedNonces ?? 10_000,
      clock: this.clock,
    })
    this.spillStore = new ToolBrokerDiskSpillStore(this.walDir)
    this.spillOwners = new SpillOwnershipStore(this.walDir, this.clock)
    this.bashJobs = new BrokerBashJobManager(this.clock)
    this.approvals = new ToolBrokerApprovalCoordinator({
      approvalBridge: opts.approvalBridge,
      detachedFallbackAfterMs,
      leaseManager: this.leaseManager,
      clock: this.clock,
      log: opts.log,
    })
    this.server = new ToolBrokerServer({
      channelKind: this.hostKind === 'local-docker' ? 'loopback_http' : 'ws_tunnel',
      leaseManager: this.leaseManager,
      requireFencingToken: true,
      capabilityAuthority: this.capabilityAuthority,
      requireCapabilityToken: true,
      authorizeBeforeExecute: (req) => this.authorizeMcpBeforeExecute(req),
      ...(this.explicitLoadedActionPolicy
        ? { loadedActionPolicy: this.explicitLoadedActionPolicy }
        : { actionPolicyLoader: () => this.loadAuthoritativeActionPolicy() }),
      aiReviewHook: this.aiReviewHook,
      trustedStrongModels: this.trustedStrongModels,
      defaultMainModel: this.defaultMainModel,
      shellHookGuardMode: this.shellHookGuardMode,
      detachedFallbackAfterMs,
      maxConcurrentToolCalls: opts.maxConcurrentToolCalls ?? TOOL_BROKER_DEFAULT_MAX_CONCURRENCY,
      maxInlinePayloadBytes: opts.maxInlinePayloadBytes ?? TOOL_BROKER_DEFAULT_MAX_INLINE_PAYLOAD_BYTES,
      walDir: this.walDir,
      clock: this.clock,
      approvalHandler: (req, signal) => this.approvals.requestApproval(req, signal),
      onDetachedApprovalCard: (card) => this.approvals.handleDetachedApprovalCard(card),
    })
    this.sessionLeases = new SessionLeaseStore({
      leaseManager: this.leaseManager,
      execEnvId: this.execEnvId,
      hostKind: this.hostKind,
      clock: this.clock,
      onPolicyApplied: (leaseId, policy) => this.server.setPolicy(leaseId, policy),
      onLeaseReplaced: (oldLeaseId) => {
        this.server.markLeaseDisconnected(oldLeaseId, 'lease_expired_replaced')
        this.bashJobs.reapLease(oldLeaseId)
      },
    })
    this.bridgeRegistry = new ToolBrokerBridgeRegistry({
      server: this.server,
      leaseManager: this.leaseManager,
      rebindAuthority: this.capabilityAuthority,
    })
    if (opts.registerDefaultMcpTools !== false) {
      registerDefaultBrokerLocalTools({
        registerTool: (def) => this.registerTool(def),
        bashJobs: this.bashJobs,
        baseToolEnv: this.baseToolEnv,
        resolveWorkspaceCwd: (ctx) =>
          this.activeCallWorkspaceCwd.get(`${ctx.leaseId}\u0000${ctx.callId}`) ??
          this.sessionLeases.getWorkspaceCwd(ctx.sessionKey),
      })
    }
    if (opts.registerAntigravityHook === true) this.registerAsAntigravityHookProvider()
    if (opts.registerEfficiencyHook === true) this.registerAsEfficiencyHookProvider()
    if (opts.registerRemoteLaneBroker === true) this.registerAsRemoteLaneBrokerProvider()
  }

  loadAuthoritativeActionPolicy(): LoadedActionPolicy {
    if (this.explicitLoadedActionPolicy) return this.explicitLoadedActionPolicy
    return loadActionPolicy(this.actionPolicyPath ? { policyPath: this.actionPolicyPath } : undefined)
  }

  registerAsAntigravityHookProvider(): () => void {
    this.unregisterAntigravityHook?.()
    this.unregisterAntigravityHook = registerAntigravityBrokerHookProvider(
      (req): AntigravityBrokerHookBinding => {
        const scope = this.turnTokens.allocateTurnScope(req.sessionKey)
        const base = {
          sessionKey: req.sessionKey,
          mode: req.mode,
          turnEpoch: scope.turnEpoch,
          turnId: scope.turnId,
          workspaceCwd: req.workspaceCwd,
        }
        const hook = this.issueTurnHookToken(base)
        const mcp = req.mode === 'hermetic_no_tools' ? null : this.issueTurnMcpToken(base)
        return {
          brokerUrl: `http://127.0.0.1:${req.gatewayPort}`,
          hookToken: hook.token,
          ...(mcp ? { mcpToken: mcp.token } : {}),
          leaseId: hook.lease.leaseId,
          turnId: scope.turnId,
          credDir: this.credDir,
          mode: hook.claims.mode,
          trackCredFile: (p: string) => {
            hook.trackCredFile(p)
            mcp?.trackCredFile(p)
          },
          revoke: () => {
            hook.revoke()
            mcp?.revoke()
          },
        }
      },
    )
    return () => {
      this.unregisterAntigravityHook?.()
      this.unregisterAntigravityHook = null
    }
  }

  registerAsEfficiencyHookProvider(): () => void {
    this.unregisterEfficiencyHook?.()
    const resolvedCredRoot = resolve(this.credDir)
    this.unregisterEfficiencyHook = registerEfficiencyBrokerHookProvider(
      async (req): Promise<EfficiencyBrokerHookBinding> => {
        const mode: ExecutionPolicyMode = req.hermeticNoTools
          ? 'hermetic_no_tools'
          : req.readOnly
            ? 'read_only'
            : 'normal'
        const issued = this.issueTurnHookToken({
          sessionKey: req.sessionKey,
          mode,
          workspaceCwd: req.workspaceCwd,
        })
        let hookTokenFile = join(this.credDir, `${issued.claims.tokenId}.tok`)
        if (req.tokenFilePath) {
          const candidate = resolve(req.tokenFilePath)
          const rel = relative(resolvedCredRoot, candidate)
          if (rel && !rel.startsWith('..') && !rel.includes('/')) hookTokenFile = candidate
        }
        try {
          await writePrivateFileAtomic0600(hookTokenFile, `${issued.token}\n`)
        } catch (err) {
          issued.revoke()
          throw err
        }
        issued.trackCredFile(hookTokenFile)
        return { brokerUrl: `http://127.0.0.1:${req.gatewayPort}`, hookTokenFile, revoke: () => issued.revoke() }
      },
    )
    return () => {
      this.unregisterEfficiencyHook?.()
      this.unregisterEfficiencyHook = null
    }
  }

  registerAsRemoteLaneBrokerProvider(): () => void {
    this.unregisterRemoteLaneBroker?.()
    this.unregisterRemoteLaneBroker = registerSelfhostRemoteLaneBrokerProvider((req) => ({
      broker: createDefaultLaneBroker(req),
      fencingTokenProvider: () => {
        const lease = this.ensureSessionLease(req.sessionKey, req.leaseId ? { leaseId: req.leaseId } : undefined)
        return { fencingToken: lease.fencingToken, brainGen: lease.brainGen }
      },
      issueCapabilityToken: ({ callId, toolName, sessionKey }) =>
        this.issueSingleUseCapabilityToken({ sessionKey: sessionKey || req.sessionKey, callId, toolName }).token,
    }))
    return () => {
      this.unregisterRemoteLaneBroker?.()
      this.unregisterRemoteLaneBroker = null
    }
  }

  registerTool(def: RegisteredToolDefinition): void {
    this.server.registerTool(def)
  }

  ensureSessionLease(
    sessionKey: string,
    opts?: {
      readonly leaseId?: string
      readonly tenantId?: string
      readonly policy?: ExecutionPolicyEnvelope
      readonly mode?: ExecutionPolicyMode
      readonly ttlMs?: number
      readonly workspaceCwd?: string
    },
  ): ExecEnvLeaseRecord {
    const lease = this.sessionLeases.ensureSessionLease(sessionKey, opts)
    if (!opts?.policy && opts?.mode) this.sessionLeases.tightenBaselineMode(sessionKey, opts.mode)
    return lease
  }

  setSessionWorkspaceCwd(sessionKey: string, workspaceCwd: string): string | undefined {
    return this.sessionLeases.setWorkspaceCwd(sessionKey, workspaceCwd)
  }
  getSessionWorkspaceCwd(sessionKey: string): string | undefined {
    return this.sessionLeases.getWorkspaceCwd(sessionKey)
  }
  getSessionLease(sessionKey: string): ExecEnvLeaseRecord | null {
    return this.sessionLeases.getSessionLease(sessionKey)
  }
  setSessionPolicy(sessionKey: string, policy: ExecutionPolicyEnvelope): ExecutionPolicyEnvelope {
    return this.sessionLeases.setBaselinePolicy(sessionKey, policy)
  }
  tightenSessionMode(sessionKey: string, mode: ExecutionPolicyMode): ExecutionPolicyEnvelope {
    return this.sessionLeases.tightenBaselineMode(sessionKey, mode)
  }

  async rebindSessionBrain(
    sessionKey: string,
    nextBrainGen: number,
    nextFencingToken = `ft_${randomBytes(16).toString('hex')}`,
  ): Promise<ExecEnvLeaseRecord> {
    const lease = this.ensureSessionLease(sessionKey)
    this.leaseManager.quiesceBrain(lease.leaseId)
    await this.leaseManager.exportAttachmentDigest(lease.leaseId)
    const rebound = (await this.leaseManager.rebindBrain(lease.leaseId, nextBrainGen, nextFencingToken)).lease
    this.sessionLeases.noteReboundBrainGen(sessionKey, rebound.brainGen)
    this.bashJobs.reapSession(sessionKey)
    return rebound
  }

  issueSingleUseCapabilityToken(input: {
    readonly sessionKey: string
    readonly callId: string
    readonly toolName: string
    readonly ttlMs?: number
  }): { readonly token: string; readonly lease: ExecEnvLeaseRecord } {
    const lease = this.ensureSessionLease(input.sessionKey)
    const issued = this.capabilityAuthority.issueToken({
      callId: input.callId,
      toolName: input.toolName,
      sessionKey: input.sessionKey,
      leaseId: lease.leaseId,
      brainGen: lease.brainGen,
      ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
    })
    return { token: issued.token, lease }
  }

  issueTurnHookToken(input: IssueTurnTokenInput) {
    return this.issueTurnScopedToken('hook', input)
  }

  issueTurnMcpToken(input: IssueTurnTokenInput) {
    return this.issueTurnScopedToken('mcp', input)
  }

  private issueTurnScopedToken(kind: 'hook' | 'mcp', input: IssueTurnTokenInput) {
    const lease = this.ensureSessionLease(input.sessionKey, { workspaceCwd: input.workspaceCwd })
    const resolvedCwd = input.workspaceCwd ?? this.sessionLeases.getWorkspaceCwd(input.sessionKey)
    const effectiveMode = stricterPolicyMode(
      this.sessionLeases.getBaselinePolicy(input.sessionKey).mode,
      input.mode ?? 'normal',
    )
    const issued = this.turnTokens.issue({
      kind,
      sessionKey: input.sessionKey,
      lease,
      mode: effectiveMode,
      turnEpoch: input.turnEpoch,
      turnId: input.turnId,
      ttlMs: input.ttlMs,
      workspaceCwd: resolvedCwd,
    })
    return { ...issued, lease }
  }

  verifyTurnScopedToken(token: string, expectedKind: 'hook' | 'mcp'): TurnScopedBrokerTokenClaims {
    return this.turnTokens.verify(token, expectedKind, this.leaseManager)
  }
  renewActiveTurnToken(tokenId: string): number | null {
    return this.turnTokens.renewActiveTurn(tokenId, this.leaseManager)
  }
  revokeTurnToken(tokenId: string): void {
    this.turnTokens.revokeToken(tokenId)
  }
  revokeTurnScope(sessionKey: string, turnId: string): number {
    return this.turnTokens.revokeTurn(sessionKey, turnId)
  }

  async handleInvokeRequest(input: {
    readonly capabilityToken?: string
    readonly leaseId?: string
    readonly fencingToken?: string
    readonly brainGen?: number
    readonly sessionKey?: string
    readonly call: ToolCallEnvelope
    readonly mainModel?: string
  }): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
    const capToken = input.capabilityToken?.trim() ?? ''
    if (!capToken.startsWith(`${SCOPED_CAPABILITY_TOKEN_PREFIX}.`)) {
      return {
        status: 401,
        body: { ok: false, errorCode: 'CAPABILITY_TOKEN_MALFORMED', errorMessage: 'Single-use octk1.* required' },
      }
    }
    try {
      const leaseId = input.leaseId ?? input.call.leaseId
      const result = await this.server.invoke({
        ...input.call,
        leaseId,
        fencingToken: input.fencingToken,
        brainGen: input.brainGen,
        sessionKey: input.sessionKey,
        capabilityToken: capToken,
        ...(input.mainModel ? { mainModel: input.mainModel } : {}),
      })
      const ownerSessionKey = input.sessionKey ?? this.leaseManager.getLease(leaseId)?.sessionKey ?? ''
      if (result.status === 'ok' && ownerSessionKey) {
        const blobId = result.spilledBlobId ?? (isSpilledBlobRefOutput(result.output) ? result.output.blobId : undefined)
        if (blobId) await this.spillOwners.recordOwnership(blobId, ownerSessionKey, leaseId)
      }
      return {
        status: result.status === 'ok' ? 200 : result.status === 'denied' ? 403 : 500,
        body: {
          ok: result.status === 'ok',
          result,
          ...(result.errorCode ? { errorCode: result.errorCode } : {}),
          ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
        },
      }
    } catch (err) {
      const code =
        err instanceof ToolBrokerPolicyError || err instanceof ExecEnvLeaseError ? err.code : 'TOOL_BROKER_INVOKE_ERROR'
      return {
        status: 403,
        body: { ok: false, errorCode: code, errorMessage: err instanceof Error ? err.message : String(err) },
      }
    }
  }

  private verifyTurnContext(token: string, expectedKind: 'hook' | 'mcp'): VerifiedTurnContext {
    let claims: TurnScopedBrokerTokenClaims
    try {
      claims = this.verifyTurnScopedToken(token, expectedKind)
    } catch (err) {
      return {
        ok: false,
        status: 401,
        code: err instanceof ToolBrokerPolicyError ? err.code : 'TOOL_BROKER_TURN_TOKEN_INVALID',
        message: err instanceof Error ? err.message : String(err),
      }
    }
    const lease = this.leaseManager.getLease(claims.leaseId)
    if (!lease || lease.state !== 'active' || this.clock() > lease.expiresAtMs) {
      return { ok: false, status: 403, code: 'EXEC_LEASE_EXPIRED', message: 'Lease inactive or expired' }
    }
    return { ok: true, claims, lease }
  }

  private authorizeHookRequest(
    hookToken: string,
    rawToolName: string,
    rawArgs: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ):
    | { readonly ok: false; readonly response: HookHttpResponse }
    | { readonly ok: true; readonly claims: TurnScopedBrokerTokenClaims; readonly lease: ExecEnvLeaseRecord; readonly effectiveName: string; readonly effectiveArgs: Readonly<Record<string, unknown>> } {
    const auth = this.verifyTurnContext(hookToken, 'hook')
    if (!auth.ok) {
      return { ok: false, response: { status: auth.status, body: { ok: false, decision: 'deny', code: auth.code, reason: auth.message } } }
    }
    if (signal?.aborted) {
      return { ok: false, response: denyHookResponse('HOOK_EVALUATION_CANCELLED', String(signal.reason || 'session_stopped')) }
    }
    const sessionPolicy = this.sessionLeases.getBaselinePolicy(auth.claims.sessionKey)
    const effectiveMode = stricterPolicyMode(sessionPolicy.mode, auth.claims.mode)
    const validated = validateAndUnwrapToolWrapper(rawToolName, rawArgs, effectiveMode)
    if (!validated.ok) return { ok: false, response: denyHookResponse(validated.code, validated.reason) }
    const listDenied = checkHookSessionPolicyList(sessionPolicy, rawToolName, validated.effectiveName)
    if (listDenied) return { ok: false, response: listDenied }
    return { ok: true, claims: auth.claims, lease: auth.lease, effectiveName: validated.effectiveName, effectiveArgs: validated.effectiveArgs }
  }

  async handleHookEvaluate(hookToken: string, input: HookEvaluateInput): Promise<HookHttpResponse> {
    const rawArgs = isPlainRecord(input.arguments) ? input.arguments : {}
    const initial = this.authorizeHookRequest(hookToken, input.toolName, rawArgs)
    if (!initial.ok) return initial.response
    const pending = this.pendingHooks.begin(initial.claims.sessionKey, initial.claims.turnId, initial.claims.tokenId)
    try {
      const evalRes = await evaluateHookShellAndPolicy({
        sessionKey: initial.claims.sessionKey,
        effectiveName: initial.effectiveName,
        effectiveArgs: initial.effectiveArgs,
        input,
        shellHookGuardMode: this.shellHookGuardMode,
        defaultMainModel: this.defaultMainModel,
        loadActionPolicy: () => this.loadAuthoritativeActionPolicy(),
        trustedStrongModels: this.trustedStrongModels,
        aiReviewHook: this.aiReviewHook,
      })
      if (evalRes.denied) return evalRes.denied
      const postPolicy = this.authorizeHookRequest(hookToken, input.toolName, rawArgs, pending.signal)
      if (!postPolicy.ok) return postPolicy.response

      let approvalStatus: HookEvaluateResult['approvalStatus'] = 'not_required'
      if (evalRes.policyEval.tier === 'human_approval') {
        const denied = await this.approvals.resolveHookHumanApproval({
          lease: postPolicy.lease,
          sessionKey: postPolicy.claims.sessionKey,
          turnId: postPolicy.claims.turnId,
          grantId: postPolicy.claims.tokenId,
          signal: pending.signal,
          callId: input.callId ?? `hook_${randomUUID().slice(0, 12)}`,
          effectiveName: postPolicy.effectiveName,
          effectiveArgs: postPolicy.effectiveArgs,
          command: evalRes.command,
          policyEval: evalRes.policyEval,
        })
        if (denied) return denied
        approvalStatus = 'approved'
      }

      const finalAuth = this.authorizeHookRequest(hookToken, input.toolName, rawArgs, pending.signal)
      if (!finalAuth.ok) return finalAuth.response
      const mintedToken = input.mintCapabilityToken
        ? this.capabilityAuthority.issueToken({
            callId: input.callId ?? `hook_${randomUUID().slice(0, 12)}`,
            toolName: finalAuth.effectiveName,
            sessionKey: finalAuth.claims.sessionKey,
            leaseId: finalAuth.lease.leaseId,
            brainGen: finalAuth.lease.brainGen,
          }).token
        : undefined
      return {
        status: 200,
        body: {
          ok: true,
          decision: 'allow',
          approvalStatus,
          evaluation: evalRes.policyEval,
          ...(evalRes.effMessage ? { message: evalRes.effMessage } : {}),
          ...(mintedToken ? { capabilityToken: mintedToken } : {}),
        },
      }
    } finally {
      pending.finish()
    }
  }

  private checkMcpModeAccess(
    sessionKey: string,
    tokenMode: ExecutionPolicyMode,
    toolName: string,
    args: Readonly<Record<string, unknown>>,
  ): { readonly status: number; readonly body: { readonly ok: false; readonly errorCode: string; readonly errorMessage: string } } | null {
    const effectiveMode = stricterPolicyMode(this.sessionLeases.getBaselinePolicy(sessionKey).mode, tokenMode)
    if (effectiveMode === 'hermetic_no_tools') {
      return {
        status: 403,
        body: { ok: false, errorCode: 'EXEC_POLICY_HERMETIC_NO_TOOLS', errorMessage: `Tool "${toolName}" blocked in hermetic_no_tools mode` },
      }
    }
    if (effectiveMode === 'read_only' && !isReadOnlyAllowedCanonicalTool(toolName, args)) {
      return {
        status: 403,
        body: { ok: false, errorCode: 'EXEC_POLICY_READ_ONLY_DENIED', errorMessage: `Tool "${toolName}" is forbidden in read_only mode` },
      }
    }
    return null
  }

  private async recordMcpSpillPreview(
    result: ToolBrokerResultEnvelope,
    sessionKey: string,
    leaseId: string,
  ): Promise<string | undefined> {
    if (result.status !== 'ok' || !isSpilledBlobRefOutput(result.output)) return undefined
    await this.spillOwners.recordOwnership(result.output.blobId, sessionKey, leaseId)
    try {
      const verified = this.server.readSpilledBlobVerified(result.output)
      return Buffer.from(verified.bytes.subarray(0, SPILL_PREVIEW_BYTES)).toString('utf8')
    } catch (err) {
      void err
      return undefined
    }
  }

  async handleMcpExecute(
    mcpToken: string,
    input: McpExecuteInput,
  ): Promise<{
    readonly status: number
    readonly body: McpExecuteResult | { readonly ok: false; readonly errorCode: string; readonly errorMessage: string }
  }> {
    const auth = this.verifyTurnContext(mcpToken, 'mcp')
    if (!auth.ok) {
      return { status: auth.status, body: { ok: false, errorCode: auth.code, errorMessage: auth.message } }
    }
    const { claims, lease } = auth
    const args = isPlainRecord(input.arguments) ? input.arguments : {}
    const modeDenied = this.checkMcpModeAccess(claims.sessionKey, claims.mode, input.toolName, args)
    if (modeDenied) return modeDenied

    // B02: Bind WAL identity to cryptographically verified claims.turnId (never untrusted body.turnId).
    const turnId = claims.turnId
    const callId = input.callId?.trim() || `mcp_call_${randomUUID().slice(0, 12)}`
    const idempotencyKey = computeToolIdempotencyKey(lease.leaseId, turnId, callId)
    const catalogEntry = this.server.listCatalog().find((e) => e.canonicalName === input.toolName)
    const argsSha256 = computeSchemaFilteredArgsSha256(args, catalogEntry?.inputSchema ?? null)
    const cap = this.capabilityAuthority.issueToken({
      callId,
      toolName: input.toolName,
      sessionKey: claims.sessionKey,
      leaseId: lease.leaseId,
      brainGen: lease.brainGen,
    })
    const effectiveTimeoutMs = computeMcpEffectiveTimeout(input.toolName, args, input.timeoutMs)
    const callCwdKey = `${lease.leaseId}\u0000${callId}`
    const turnWorkspaceCwd = claims.workspaceCwd ?? this.sessionLeases.getWorkspaceCwd(claims.sessionKey)
    if (turnWorkspaceCwd) this.activeCallWorkspaceCwd.set(callCwdKey, turnWorkspaceCwd)

    let result: ToolBrokerResultEnvelope
    try {
      result = await this.server.invoke({
        schemaVersion: 1,
        leaseId: lease.leaseId,
        turnId,
        callId,
        idempotencyKey,
        canonicalName: input.toolName,
        arguments: args,
        argsSha256,
        attestation: {
          kind: 'gateway_signed_grant',
          argsSha256,
          observedAt: new Date(this.clock()).toISOString(),
          grantId: claims.tokenId,
        },
        ...(effectiveTimeoutMs !== undefined ? { timeoutMs: effectiveTimeoutMs } : {}),
        fencingToken: lease.fencingToken,
        brainGen: lease.brainGen,
        sessionKey: claims.sessionKey,
        capabilityToken: cap.token,
        ...(input.mainModel ? { mainModel: input.mainModel } : {}),
      })
    } finally {
      this.activeCallWorkspaceCwd.delete(callCwdKey)
    }

    const preview = await this.recordMcpSpillPreview(result, claims.sessionKey, lease.leaseId)
    return {
      status: mapMcpResultHttpStatus(result),
      body: { ok: result.status === 'ok', result, ...(preview !== undefined ? { preview } : {}) },
    }
  }

  private handleTurnTokenRevoked(scope: TurnTokenRevokedEvent): void {
    const grantScope = scope.turnFullyRevoked ? undefined : scope.tokenId
    const reason = 'TOOL_BROKER_TURN_TOKEN_REVOKED'
    if (scope.turnFullyRevoked || scope.kind === 'hook') {
      this.pendingHooks.cancelTurn(scope.sessionKey, scope.turnId, reason, grantScope)
    }
    this.approvals.cancelTurnWaiters(scope.sessionKey, scope.turnId, reason, grantScope)
    if (scope.turnFullyRevoked || scope.kind === 'mcp') {
      this.server.cancelTurn(scope.sessionKey, scope.turnId, reason, grantScope)
      if (scope.turnFullyRevoked || scope.kindFullyRevoked) {
        this.bashJobs.reapTurn(scope.sessionKey, scope.turnId)
      }
    }
  }

  private authorizeMcpBeforeExecute(input: {
    readonly call: ToolCallEnvelope
    readonly sessionKey: string
    readonly leaseId: string
    readonly turnId: string
    readonly grantId?: string
  }): { readonly ok: true } | { readonly ok: false; readonly errorCode: string; readonly errorMessage: string } {
    const grantId = input.grantId
    if (!grantId || (!grantId.startsWith('mcp_') && !grantId.startsWith('hook_'))) return { ok: true }
    const active = this.turnTokens.verifyGrantActive(
      grantId,
      { sessionKey: input.sessionKey, turnId: input.turnId, leaseId: input.leaseId },
      this.leaseManager,
    )
    if (!active.ok) return { ok: false, errorCode: active.code, errorMessage: active.message }
    const modeDenied = this.checkMcpModeAccess(
      input.sessionKey,
      active.mode,
      input.call.canonicalName,
      input.call.arguments,
    )
    if (modeDenied) return { ok: false, errorCode: modeDenied.body.errorCode, errorMessage: modeDenied.body.errorMessage }
    return { ok: true }
  }

  async handleSpillRead(
    authToken: string,
    input: SpillReadInput,
  ): Promise<{ readonly status: number; readonly body: SpillReadResult }> {
    let claims: TurnScopedBrokerTokenClaims
    try {
      claims = this.verifyTurnScopedToken(
        authToken,
        authToken.startsWith(`${TOOL_BROKER_HOOK_TOKEN_PREFIX}.`) ? 'hook' : 'mcp',
      )
    } catch (err) {
      return {
        status: 401,
        body: {
          ok: false,
          errorCode: err instanceof ToolBrokerPolicyError ? err.code : 'TOOL_BROKER_TURN_TOKEN_INVALID',
          errorMessage: err instanceof Error ? err.message : String(err),
        },
      }
    }
    return await readAuthorizedSpillSlice({
      sessionKey: claims.sessionKey,
      input,
      spillOwners: this.spillOwners,
      server: this.server,
    })
  }

  attachBridgeSocket(socketKey: object, sendRaw: (frame: string) => void): void {
    this.bridgeRegistry.attach(socketKey, sendRaw)
  }

  handleBridgeWireFrame(socketKey: object, frame: ToolBrokerWireFrame, sendRaw: (raw: string) => void): void {
    this.bridgeRegistry.handleWireFrame(socketKey, frame, sendRaw)
  }

  detachBridgeSocket(socketKey: object, reason = 'bridge_ws_disconnected'): void {
    this.bridgeRegistry.detach(socketKey, reason)
  }

  handlePermissionResponse(input: ToolBrokerPermissionResponseInput): boolean {
    return this.approvals.handlePermissionResponse(input)
  }

  isToolBrokerApprovalRequestId(requestId: string): boolean {
    return requestId.startsWith(TOOL_BROKER_APPROVAL_REQUEST_PREFIX)
  }

  cancelSessionCalls(sessionKey: string, reason = 'session_stopped'): void {
    this.pendingHooks.cancelSession(sessionKey, reason)
    const lease = this.sessionLeases.getSessionLease(sessionKey)
    if (lease) this.server.markLeaseDisconnected(lease.leaseId, reason)
    this.turnTokens.revokeSession(sessionKey)
    this.bashJobs.reapSession(sessionKey, {
      includeSurvivors: reason === 'session_destroyed' || reason === 'broker_runtime_disposed',
    })
    this.approvals.cancelSessionWaiters(sessionKey, reason)
  }

  dispose(): void {
    this.unregisterAntigravityHook?.()
    this.unregisterAntigravityHook = null
    this.unregisterEfficiencyHook?.()
    this.unregisterEfficiencyHook = null
    this.unregisterRemoteLaneBroker?.()
    this.unregisterRemoteLaneBroker = null
    this.bridgeRegistry.disposeAll('broker_runtime_disposed')
    for (const sessionKey of this.sessionLeases.listSessionKeys()) {
      this.cancelSessionCalls(sessionKey, 'broker_runtime_disposed')
    }
    this.bashJobs.disposeAll()
  }
}
