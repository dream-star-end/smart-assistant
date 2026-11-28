/**
 * OCV5-915 P3-2 — Gateway ToolBroker Session, Turn-Credential, Spill-Ownership,
 * Approval-Decision, and Wrapper-Validation Store (`rt-misc` rank 2).
 *
 * Enforces B01 (strict approval decision parser), B02 (turn-epoch tokens + private 0600 cred
 * files outside launchHome + immediate revocation), B07 (expired lease replacement + baseline
 * policy separation), B12 (session-bound spill owners), W05 (raw read-only + strict single-key
 * wrapper validation), Steward S2 (authoritative workspaceCwd binding), and Steward S3
 * (active-turn sliding credential & lease renewal with hard revocation/fencing/idle expiry).
 * Zero syncIo / process.env / emptyCatch / typeEscape.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  isExecutionPolicyMonotonicTightening, isReadOnlyAllowedCanonicalTool, remoteCanonicalJson, validateExecutionPolicyEnvelope,
  type ExecEnvHostKind, type ExecutionPolicyEnvelope, type ExecutionPolicyMode,
} from '@openclaude/protocol'
import { scrubToolBrokerEnv } from '@openclaude/protocol/exec-env'
import {
  ToolBrokerPolicyError, constantTimeBytesEqual, rfc2104HmacSha256,
  type ExecEnvLeaseManager, type ExecEnvLeaseRecord, type ToolApprovalDecision,
} from './execEnv/index.js'
import { BrokerBashJobManager, type BrokerBashResult } from './toolBrokerBashJobs.js'

export { BrokerBashJobManager, scrubToolBrokerEnv, type BrokerBashResult }

export const TOOL_BROKER_HOOK_TOKEN_PREFIX = 'octh1'
export const TOOL_BROKER_MCP_TOKEN_PREFIX = 'octm1'
export const TOOL_BROKER_APPROVAL_REQUEST_PREFIX = 'ask-user:tb:'
export const DEFAULT_TURN_TOKEN_TTL_MS = 15 * 60_000
export const MAX_ACTIVE_TURN_LIFETIME_MS = 12 * 60 * 60_000
const LEASE_AUTO_RENEW_THRESHOLD_MS = 5 * 60_000
const MAX_REVOKED_TOKEN_IDS = 20_000
const POLICY_MODE_RANK: Readonly<Record<ExecutionPolicyMode, number>> = Object.freeze({
  normal: 0,
  read_only: 1,
  hermetic_no_tools: 2,
})
const APPROVE_ANSWER_RE = /^(approve|approved|allow)$/i

function ignoreBestEffortError(err: unknown): void {
  void err
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

export function stricterPolicyMode(a: ExecutionPolicyMode, b: ExecutionPolicyMode): ExecutionPolicyMode {
  return POLICY_MODE_RANK[a] >= POLICY_MODE_RANK[b] ? a : b
}

export function defaultPolicyForMode(mode: ExecutionPolicyMode): ExecutionPolicyEnvelope {
  const normal = mode === 'normal'
  return validateExecutionPolicyEnvelope({
    schemaVersion: 1,
    mode,
    allowedTools: [],
    allowNetworkEgress: normal,
    allowWorkspaceWrite: normal,
    allowSubprocessSpawn: normal,
  })
}

function normalizeWorkspaceCwd(raw?: string): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed.length > 0 ? resolve(trimmed) : undefined
}

// ─── B01: Strict Approval Decision Parser ──────────────────────────────────────────────────
export interface ToolBrokerPermissionResponseLike {
  readonly requestId: string
  readonly behavior: 'allow' | 'deny'
  readonly message?: string
  readonly updatedInput?: Record<string, unknown>
}

export function parseToolBrokerApprovalDecision(
  input: Pick<ToolBrokerPermissionResponseLike, 'behavior' | 'message' | 'updatedInput'>,
): ToolApprovalDecision {
  if (input.behavior !== 'allow') {
    return { decision: 'deny', reason: input.message || 'Denied by human approver' }
  }
  const updated = input.updatedInput
  if (updated !== undefined) {
    if (!isPlainRecord(updated)) return { decision: 'deny', reason: 'Invalid approval updatedInput payload' }
    const answers = updated.answers
    if (!isPlainRecord(answers)) {
      return { decision: 'deny', reason: 'Missing approval answers in AskUserQuestion payload' }
    }
    const vals = Object.values(answers)
    if (vals.length === 0) return { decision: 'deny', reason: 'Empty approval answers denied' }
    for (const rawVal of vals) {
      if (typeof rawVal !== 'string' || !APPROVE_ANSWER_RE.test(rawVal.trim())) {
        return { decision: 'deny', reason: input.message || 'Denied by human approver' }
      }
    }
  }
  return { decision: 'approve' }
}

// ─── W05: Raw Wrapper Validation Before Unwrapping ─────────────────────────────────────────
export type ValidatedWrapperResult =
  | { readonly ok: true; readonly effectiveName: string; readonly effectiveArgs: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly code: string; readonly reason: string }

function isStrictNonEmptyToolName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
}

function unwrapCallMcpToolWrapper(rawArgs: Readonly<Record<string, unknown>>): ValidatedWrapperResult {
  const serverKeys = ['ServerName', 'server_name', 'serverName'].filter((k) => k in rawArgs)
  const toolKeys = ['ToolName', 'tool_name', 'toolName'].filter((k) => k in rawArgs)
  if (serverKeys.length > 1 || toolKeys.length > 1 || ('Arguments' in rawArgs && 'arguments' in rawArgs)) {
    return { ok: false, code: 'EXEC_POLICY_AMBIGUOUS_WRAPPER', reason: 'Ambiguous duplicate wrapper keys in call_mcp_tool' }
  }
  const serverName = serverKeys.length === 1 ? rawArgs[serverKeys[0]!] : undefined
  const innerTool = toolKeys.length === 1 ? rawArgs[toolKeys[0]!] : undefined
  const rawInnerArgs = 'Arguments' in rawArgs ? rawArgs.Arguments : rawArgs.arguments
  if (rawInnerArgs !== undefined && !isPlainRecord(rawInnerArgs)) {
    return { ok: false, code: 'EXEC_POLICY_AMBIGUOUS_WRAPPER', reason: 'call_mcp_tool arguments must be a plain object' }
  }
  const innerArgs = isPlainRecord(rawInnerArgs) ? rawInnerArgs : {}
  if (!isStrictNonEmptyToolName(innerTool)) {
    return { ok: true, effectiveName: 'call_mcp_tool', effectiveArgs: rawArgs }
  }
  const effectiveName = serverName === 'openclaude-memory' ? innerTool : `mcp_external_${innerTool}`
  return { ok: true, effectiveName, effectiveArgs: innerArgs }
}

function unwrapExecuteExtraToolWrapper(
  rawToolName: string,
  rawArgs: Readonly<Record<string, unknown>>,
): ValidatedWrapperResult {
  const toolKeys = ['tool_name', 'toolName'].filter((k) => k in rawArgs)
  if (toolKeys.length > 1 || ('arguments' in rawArgs && 'input' in rawArgs)) {
    return { ok: false, code: 'EXEC_POLICY_AMBIGUOUS_WRAPPER', reason: 'Ambiguous duplicate keys in ExecuteExtraTool' }
  }
  const innerTool = toolKeys.length === 1 ? rawArgs[toolKeys[0]!] : undefined
  if (!isStrictNonEmptyToolName(innerTool)) {
    return { ok: true, effectiveName: rawToolName, effectiveArgs: rawArgs }
  }
  const innerArgs = isPlainRecord(rawArgs.arguments)
    ? rawArgs.arguments
    : isPlainRecord(rawArgs.input)
      ? rawArgs.input
      : rawArgs
  return { ok: true, effectiveName: innerTool, effectiveArgs: innerArgs }
}

export function validateAndUnwrapToolWrapper(
  rawToolName: string,
  rawArgs: Readonly<Record<string, unknown>>,
  effectiveMode: ExecutionPolicyMode,
): ValidatedWrapperResult {
  if (!isStrictNonEmptyToolName(rawToolName)) {
    return { ok: false, code: 'EXEC_POLICY_INVALID_TOOL_NAME', reason: 'Invalid or padded tool name' }
  }
  if (effectiveMode === 'hermetic_no_tools') {
    return { ok: false, code: 'EXEC_POLICY_HERMETIC_NO_TOOLS', reason: `Tool "${rawToolName}" blocked in hermetic_no_tools mode` }
  }
  if (effectiveMode === 'read_only' && !isReadOnlyAllowedCanonicalTool(rawToolName, rawArgs)) {
    return { ok: false, code: 'EXEC_POLICY_READ_ONLY_DENIED', reason: `Tool "${rawToolName}" is forbidden in read_only mode` }
  }
  const lower = rawToolName.toLowerCase()
  if (lower === 'call_mcp_tool') return unwrapCallMcpToolWrapper(rawArgs)
  if (lower === 'executeextratool' || lower === 'execute_extra_tool') {
    return unwrapExecuteExtraToolWrapper(rawToolName, rawArgs)
  }
  return { ok: true, effectiveName: rawToolName, effectiveArgs: rawArgs }
}

// ─── B02 + S2 + S3: Turn-Epoch-Bound Scoped Token Store & Private 0600 Cred Writer ─────────
export interface TurnScopedBrokerTokenClaims {
  readonly kind: 'hook' | 'mcp'
  readonly tokenId: string
  readonly sessionKey: string
  readonly leaseId: string
  readonly brainGen: number
  readonly turnEpoch: number
  readonly turnId: string
  readonly mode: ExecutionPolicyMode
  readonly issuedAtMs: number
  readonly expiresAtMs: number
  readonly workspaceCwd?: string
}

interface ActiveTurnTokenEntry {
  readonly tokenId: string
  readonly sessionKey: string
  readonly leaseId: string
  readonly brainGen: number
  readonly turnId: string
  readonly turnEpoch: number
  readonly kind: 'hook' | 'mcp'
  readonly mode: ExecutionPolicyMode
  readonly issuedAtMs: number
  readonly ttlMs: number
  slidingExpiresAtMs: number
  readonly workspaceCwd?: string
  readonly credPaths: Set<string>
}

export async function writePrivateFileAtomic0600(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  const fh = await open(tmpPath, 'wx', 0o600)
  try {
    await fh.writeFile(content, 'utf8')
    await fh.chmod(0o600)
  } catch (err) {
    await fh.close().catch(ignoreBestEffortError)
    await unlink(tmpPath).catch(ignoreBestEffortError)
    throw err
  }
  await fh.close()
  try {
    await rename(tmpPath, filePath)
  } catch (err) {
    await unlink(tmpPath).catch(ignoreBestEffortError)
    throw err
  }
}

function isValidPolicyMode(value: unknown): value is ExecutionPolicyMode {
  return value === 'normal' || value === 'read_only' || value === 'hermetic_no_tools'
}

function parseVerifiedClaimFields(
  parsed: Record<string, unknown>,
  expectedKind: 'hook' | 'mcp',
): TurnScopedBrokerTokenClaims {
  const { kind, tokenId, sessionKey, leaseId, brainGen, turnEpoch, turnId, mode, issuedAtMs, expiresAtMs, workspaceCwd } = parsed
  const validCore =
    kind === expectedKind &&
    typeof tokenId === 'string' &&
    typeof sessionKey === 'string' &&
    typeof leaseId === 'string' &&
    typeof turnId === 'string' &&
    turnId.length > 0 &&
    isValidPolicyMode(mode)
  const validNums =
    typeof brainGen === 'number' &&
    Number.isSafeInteger(brainGen) &&
    typeof turnEpoch === 'number' &&
    Number.isSafeInteger(turnEpoch) &&
    turnEpoch >= 1 &&
    typeof issuedAtMs === 'number' &&
    typeof expiresAtMs === 'number'
  const validCwd = workspaceCwd === undefined || (typeof workspaceCwd === 'string' && workspaceCwd.trim().length > 0)
  if (!validCore || !validNums || !validCwd) {
    throw new ToolBrokerPolicyError('TOOL_BROKER_TURN_TOKEN_INVALID', 'Invalid turn token claim types')
  }
  return Object.freeze({
    kind: expectedKind,
    tokenId,
    sessionKey,
    leaseId,
    brainGen,
    turnEpoch,
    turnId,
    mode,
    issuedAtMs,
    expiresAtMs,
    ...(workspaceCwd ? { workspaceCwd } : {}),
  })
}

function decodeAndVerifyTurnToken(
  token: string,
  expectedKind: 'hook' | 'mcp',
  secret: Buffer,
): TurnScopedBrokerTokenClaims {
  const expectedPrefix = expectedKind === 'hook' ? TOOL_BROKER_HOOK_TOKEN_PREFIX : TOOL_BROKER_MCP_TOKEN_PREFIX
  if (typeof token !== 'string' || !token.startsWith(`${expectedPrefix}.`)) {
    throw new ToolBrokerPolicyError('TOOL_BROKER_TURN_TOKEN_INVALID', `Expected ${expectedPrefix}.* token`)
  }
  const parts = token.split('.')
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new ToolBrokerPolicyError('TOOL_BROKER_TURN_TOKEN_INVALID', 'Malformed turn token')
  }
  const expectedSig = rfc2104HmacSha256(secret, `${parts[0]}.${parts[1]}`)
  if (!constantTimeBytesEqual(Buffer.from(parts[2], 'base64url'), expectedSig)) {
    throw new ToolBrokerPolicyError('TOOL_BROKER_TURN_TOKEN_SIGNATURE_INVALID', 'Turn token signature invalid')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch (err) {
    void err
    throw new ToolBrokerPolicyError('TOOL_BROKER_TURN_TOKEN_INVALID', 'Unparseable turn token payload')
  }
  if (!isPlainRecord(parsed)) {
    throw new ToolBrokerPolicyError('TOOL_BROKER_TURN_TOKEN_INVALID', 'Invalid claims')
  }
  return parseVerifiedClaimFields(parsed, expectedKind)
}

function maybeAutoRenewActiveLease(
  lease: ExecEnvLeaseRecord,
  nextSlidingMs: number,
  now: number,
  leaseManager: ExecEnvLeaseManager,
): ExecEnvLeaseRecord {
  const desiredExpiry = Math.min(nextSlidingMs, now + lease.ttlMs)
  const nearExpiry = now >= lease.expiresAtMs - LEASE_AUTO_RENEW_THRESHOLD_MS && nextSlidingMs > lease.expiresAtMs
  if (!nearExpiry && desiredExpiry <= lease.expiresAtMs) return lease
  const extendMs = Math.max(1, desiredExpiry - lease.expiresAtMs)
  return leaseManager.renewLease(lease.leaseId, extendMs)
}

export interface TurnTokenRevokedEvent {
  readonly sessionKey: string
  readonly turnId: string
  readonly leaseId: string
  readonly tokenId?: string
  readonly kind?: 'hook' | 'mcp'
  readonly turnFullyRevoked: boolean
  readonly kindFullyRevoked: boolean
}

export class TurnScopedTokenStore {
  private readonly secret: Buffer
  private readonly clock: () => number
  private readonly activeTokens = new Map<string, ActiveTurnTokenEntry>()
  private readonly revokedTokenIds = new Set<string>()
  private readonly sessionEpochs = new Map<string, number>()
  private readonly credFileOwners = new Map<string, string>()
  private readonly onTurnRevoked?: (scope: TurnTokenRevokedEvent) => void

  constructor(opts: {
    readonly secret: Buffer
    readonly clock: () => number
    readonly onTurnRevoked?: (scope: TurnTokenRevokedEvent) => void
  }) {
    this.secret = opts.secret
    this.clock = opts.clock
    this.onTurnRevoked = opts.onTurnRevoked
  }

  allocateTurnScope(
    sessionKey: string,
    explicitTurnId?: string,
  ): { readonly turnEpoch: number; readonly turnId: string } {
    const nextEpoch = (this.sessionEpochs.get(sessionKey) ?? 0) + 1
    this.sessionEpochs.set(sessionKey, nextEpoch)
    return {
      turnEpoch: nextEpoch,
      turnId: explicitTurnId?.trim() || `tb_turn_${nextEpoch}_${randomBytes(6).toString('hex')}`,
    }
  }

  issue(input: {
    readonly kind: 'hook' | 'mcp'
    readonly sessionKey: string
    readonly lease: ExecEnvLeaseRecord
    readonly mode: ExecutionPolicyMode
    readonly turnEpoch?: number
    readonly turnId?: string
    readonly ttlMs?: number
    readonly workspaceCwd?: string
  }): {
    readonly token: string
    readonly claims: TurnScopedBrokerTokenClaims
    readonly revoke: () => void
    readonly trackCredFile: (filePath: string) => void
  } {
    const scope =
      input.turnEpoch !== undefined && input.turnId
        ? { turnEpoch: input.turnEpoch, turnId: input.turnId }
        : this.allocateTurnScope(input.sessionKey, input.turnId)
    const issuedAtMs = Math.floor(this.clock())
    const ttlMs = Math.max(1, Math.floor(input.ttlMs ?? DEFAULT_TURN_TOKEN_TTL_MS))
    const workspaceCwd = normalizeWorkspaceCwd(input.workspaceCwd)
    const tokenId = `${input.kind}_${randomBytes(12).toString('base64url')}`
    const claims: TurnScopedBrokerTokenClaims = Object.freeze({
      kind: input.kind,
      tokenId,
      sessionKey: input.sessionKey,
      leaseId: input.lease.leaseId,
      brainGen: input.lease.brainGen,
      turnEpoch: scope.turnEpoch,
      turnId: scope.turnId,
      mode: input.mode,
      issuedAtMs,
      expiresAtMs: issuedAtMs + ttlMs,
      ...(workspaceCwd ? { workspaceCwd } : {}),
    })
    const prefix = input.kind === 'hook' ? TOOL_BROKER_HOOK_TOKEN_PREFIX : TOOL_BROKER_MCP_TOKEN_PREFIX
    const body = `${prefix}.${Buffer.from(remoteCanonicalJson(claims), 'utf8').toString('base64url')}`
    const sigB64 = rfc2104HmacSha256(this.secret, body).toString('base64url')
    const entry: ActiveTurnTokenEntry = {
      tokenId,
      sessionKey: input.sessionKey,
      leaseId: input.lease.leaseId,
      brainGen: input.lease.brainGen,
      turnId: scope.turnId,
      turnEpoch: scope.turnEpoch,
      kind: input.kind,
      mode: input.mode,
      issuedAtMs,
      ttlMs,
      slidingExpiresAtMs: issuedAtMs + ttlMs,
      ...(workspaceCwd ? { workspaceCwd } : {}),
      credPaths: new Set(),
    }
    this.activeTokens.set(tokenId, entry)
    return {
      token: `${body}.${sigB64}`,
      claims,
      revoke: () => this.revokeToken(tokenId),
      trackCredFile: (filePath: string) => {
        if (this.activeTokens.has(tokenId)) {
          entry.credPaths.add(filePath)
          this.credFileOwners.set(filePath, tokenId)
        } else if (this.credFileOwners.get(filePath) === tokenId || !this.credFileOwners.has(filePath)) {
          void unlink(filePath).catch(ignoreBestEffortError)
        }
      },
    }
  }

  renewActiveTurn(tokenId: string, leaseManager?: ExecEnvLeaseManager): number | null {
    if (this.revokedTokenIds.has(tokenId)) return null
    const entry = this.activeTokens.get(tokenId)
    if (!entry) return null
    const now = Math.floor(this.clock())
    const absoluteCapMs = entry.issuedAtMs + MAX_ACTIVE_TURN_LIFETIME_MS
    if (now > entry.slidingExpiresAtMs || now > absoluteCapMs) return null
    const nextSlidingMs = Math.min(absoluteCapMs, now + entry.ttlMs)
    if (leaseManager) {
      const lease = leaseManager.getLease(entry.leaseId)
      if (!lease || lease.state !== 'active' || lease.sessionKey !== entry.sessionKey) return null
      if (entry.brainGen < lease.brainGen || now > lease.expiresAtMs) return null
      maybeAutoRenewActiveLease(lease, nextSlidingMs, now, leaseManager)
    }
    entry.slidingExpiresAtMs = nextSlidingMs
    return entry.slidingExpiresAtMs
  }

  verify(
    token: string,
    expectedKind: 'hook' | 'mcp',
    leaseManager: ExecEnvLeaseManager,
  ): TurnScopedBrokerTokenClaims {
    const claims = decodeAndVerifyTurnToken(token, expectedKind, this.secret)
    const entry = this.activeTokens.get(claims.tokenId)
    if (
      this.revokedTokenIds.has(claims.tokenId) ||
      !entry ||
      entry.sessionKey !== claims.sessionKey ||
      entry.leaseId !== claims.leaseId ||
      entry.brainGen !== claims.brainGen
    ) {
      throw new ToolBrokerPolicyError('TOOL_BROKER_TURN_TOKEN_REVOKED', 'Turn token revoked')
    }
    const now = this.clock()
    const absoluteCapMs = entry.issuedAtMs + MAX_ACTIVE_TURN_LIFETIME_MS
    if (now > entry.slidingExpiresAtMs || now > absoluteCapMs) {
      throw new ToolBrokerPolicyError('TOOL_BROKER_TURN_TOKEN_EXPIRED', 'Turn token expired')
    }
    const lease = leaseManager.getLease(claims.leaseId)
    if (!lease || lease.state !== 'active' || lease.sessionKey !== claims.sessionKey) {
      throw new ToolBrokerPolicyError('EXEC_LEASE_CLOSED', 'Session lease inactive or mismatched')
    }
    if (claims.brainGen < lease.brainGen) {
      throw new ToolBrokerPolicyError(
        'EXEC_FENCING_TOKEN_STALE',
        `Turn token brainGen (${claims.brainGen}) < active (${lease.brainGen})`,
      )
    }
    if (now > lease.expiresAtMs) {
      throw new ToolBrokerPolicyError('EXEC_LEASE_EXPIRED', `Lease ${claims.leaseId} expired`)
    }
    const nextSlidingMs = Math.min(absoluteCapMs, Math.floor(now) + entry.ttlMs)
    maybeAutoRenewActiveLease(lease, nextSlidingMs, Math.floor(now), leaseManager)
    entry.slidingExpiresAtMs = nextSlidingMs
    return Object.freeze({ ...claims, expiresAtMs: entry.slidingExpiresAtMs })
  }

  verifyGrantActive(
    grantId: string,
    expected: { readonly sessionKey: string; readonly turnId: string; readonly leaseId: string },
    leaseManager: ExecEnvLeaseManager,
  ):
    | { readonly ok: true; readonly mode: ExecutionPolicyMode }
    | { readonly ok: false; readonly code: string; readonly message: string } {
    const entry = this.activeTokens.get(grantId)
    if (this.revokedTokenIds.has(grantId) || !entry || entry.sessionKey !== expected.sessionKey || entry.turnId !== expected.turnId || entry.leaseId !== expected.leaseId) {
      return { ok: false, code: 'TOOL_BROKER_TURN_TOKEN_REVOKED', message: 'Turn token revoked before execution' }
    }
    const now = this.clock()
    if (now > entry.slidingExpiresAtMs || now > entry.issuedAtMs + MAX_ACTIVE_TURN_LIFETIME_MS) {
      return { ok: false, code: 'TOOL_BROKER_TURN_TOKEN_EXPIRED', message: 'Turn token expired before execution' }
    }
    const lease = leaseManager.getLease(entry.leaseId)
    if (!lease || lease.state !== 'active' || lease.sessionKey !== entry.sessionKey || now > lease.expiresAtMs) {
      return { ok: false, code: 'EXEC_LEASE_CLOSED', message: 'Session lease inactive or expired before execution' }
    }
    if (entry.brainGen < lease.brainGen) {
      return { ok: false, code: 'EXEC_FENCING_TOKEN_STALE', message: `Turn token brainGen (${entry.brainGen}) < active (${lease.brainGen})` }
    }
    return { ok: true, mode: entry.mode }
  }

  revokeToken(tokenId: string): void {
    const entry = this.activeTokens.get(tokenId)
    this.activeTokens.delete(tokenId)
    this.revokedTokenIds.add(tokenId)
    if (this.revokedTokenIds.size > MAX_REVOKED_TOKEN_IDS) {
      const oldest = this.revokedTokenIds.values().next().value
      if (typeof oldest === 'string') this.revokedTokenIds.delete(oldest)
    }
    if (entry) {
      for (const p of entry.credPaths) {
        if (this.credFileOwners.get(p) === tokenId) {
          this.credFileOwners.delete(p)
          void unlink(p).catch(ignoreBestEffortError)
        }
      }
      entry.credPaths.clear()
      let hasOtherSameKind = false
      let hasOtherAnyKind = false
      for (const other of this.activeTokens.values()) {
        if (other.sessionKey !== entry.sessionKey || other.turnId !== entry.turnId) continue
        hasOtherAnyKind = true
        if (other.kind === entry.kind) hasOtherSameKind = true
      }
      this.onTurnRevoked?.({
        sessionKey: entry.sessionKey,
        turnId: entry.turnId,
        leaseId: entry.leaseId,
        tokenId,
        kind: entry.kind,
        turnFullyRevoked: !hasOtherAnyKind,
        kindFullyRevoked: !hasOtherSameKind,
      })
    }
  }

  listActiveTurnIds(sessionKey: string): string[] {
    const turnIds = new Set<string>()
    for (const entry of this.activeTokens.values()) {
      if (entry.sessionKey === sessionKey && entry.turnId) turnIds.add(entry.turnId)
    }
    return [...turnIds]
  }

  revokeTurn(sessionKey: string, turnId: string): number {
    let count = 0
    for (const [tokenId, entry] of [...this.activeTokens]) {
      if (entry.sessionKey === sessionKey && entry.turnId === turnId) {
        this.revokeToken(tokenId)
        count += 1
      }
    }
    if (count === 0) {
      this.onTurnRevoked?.({ sessionKey, turnId, leaseId: '', turnFullyRevoked: true, kindFullyRevoked: true })
    }
    return count
  }

  revokeSession(sessionKey: string): number {
    let count = 0
    for (const [tokenId, entry] of [...this.activeTokens]) {
      if (entry.sessionKey === sessionKey) {
        this.revokeToken(tokenId)
        count += 1
      }
    }
    return count
  }
}

// ─── B07 + S2: Session Lease Store (Expired Replacement, Baseline Policy, Workspace CWD) ───
export class SessionLeaseStore {
  private readonly sessionLeaseIds = new Map<string, string>()
  private readonly sessionBaselinePolicies = new Map<string, ExecutionPolicyEnvelope>()
  private readonly sessionMaxBrainGen = new Map<string, number>()
  private readonly sessionWorkspaceCwds = new Map<string, string>()

  constructor(
    private readonly deps: {
      readonly leaseManager: ExecEnvLeaseManager
      readonly execEnvId: string
      readonly hostKind: ExecEnvHostKind
      readonly clock: () => number
      readonly onPolicyApplied: (leaseId: string, policy: ExecutionPolicyEnvelope) => void
      readonly onLeaseReplaced: (oldLeaseId: string) => void
    },
  ) {}

  getBaselinePolicy(sessionKey: string): ExecutionPolicyEnvelope {
    return this.sessionBaselinePolicies.get(sessionKey) ?? defaultPolicyForMode('normal')
  }

  private validateMonotonicCandidate(sessionKey: string, policy: ExecutionPolicyEnvelope): ExecutionPolicyEnvelope {
    const validated = validateExecutionPolicyEnvelope(policy)
    const current = this.sessionBaselinePolicies.get(sessionKey)
    if (current && !isExecutionPolicyMonotonicTightening(current, validated)) {
      throw new ToolBrokerPolicyError(
        'EXEC_POLICY_RELAXATION_FORBIDDEN',
        `Policy update for session ${sessionKey} violates monotonic tightening`,
      )
    }
    return validated
  }

  setBaselinePolicy(sessionKey: string, policy: ExecutionPolicyEnvelope): ExecutionPolicyEnvelope {
    const validated = this.validateMonotonicCandidate(sessionKey, policy)
    const lease = this.ensureSessionLease(sessionKey)
    this.deps.onPolicyApplied(lease.leaseId, validated)
    this.sessionBaselinePolicies.set(sessionKey, validated)
    return validated
  }

  tightenBaselineMode(sessionKey: string, mode: ExecutionPolicyMode): ExecutionPolicyEnvelope {
    const cur = this.getBaselinePolicy(sessionKey)
    let nextMode = stricterPolicyMode(cur.mode, mode)
    let allowedTools = cur.allowedTools
    if (nextMode === 'read_only' && cur.allowedTools.length > 0) {
      allowedTools = cur.allowedTools.filter((t) => isReadOnlyAllowedCanonicalTool(t))
      if (allowedTools.length === 0) nextMode = 'hermetic_no_tools'
    }
    const allowMut = nextMode === 'normal'
    return this.setBaselinePolicy(sessionKey, {
      ...cur, mode: nextMode, allowedTools: nextMode === 'hermetic_no_tools' ? [] : allowedTools,
      allowNetworkEgress: cur.allowNetworkEgress && allowMut, allowWorkspaceWrite: cur.allowWorkspaceWrite && allowMut,
      allowSubprocessSpawn: cur.allowSubprocessSpawn && allowMut,
    })
  }

  setWorkspaceCwd(sessionKey: string, workspaceCwd: string): string | undefined {
    const normalized = normalizeWorkspaceCwd(workspaceCwd)
    if (normalized) this.sessionWorkspaceCwds.set(sessionKey, normalized)
    return normalized
  }
  getWorkspaceCwd(sessionKey: string): string | undefined { return this.sessionWorkspaceCwds.get(sessionKey) }
  getSessionLease(sessionKey: string): ExecEnvLeaseRecord | null {
    const id = this.sessionLeaseIds.get(sessionKey)
    return id ? this.deps.leaseManager.getLease(id) : null
  }
  listSessionKeys(): string[] { return [...this.sessionLeaseIds.keys()] }

  ensureSessionLease(
    sessionKey: string,
    opts?: { readonly leaseId?: string; readonly tenantId?: string; readonly policy?: ExecutionPolicyEnvelope; readonly ttlMs?: number; readonly workspaceCwd?: string },
  ): ExecEnvLeaseRecord {
    const validatedPolicy = opts?.policy ? this.validateMonotonicCandidate(sessionKey, opts.policy) : undefined
    if (opts?.workspaceCwd) this.setWorkspaceCwd(sessionKey, opts.workspaceCwd)
    const now = this.deps.clock()
    const existingId = this.sessionLeaseIds.get(sessionKey)
    let nextBrainGen = Math.max(1, this.sessionMaxBrainGen.get(sessionKey) ?? 1)
    if (existingId) {
      const existing = this.deps.leaseManager.getLease(existingId)
      if (existing) {
        nextBrainGen = Math.max(nextBrainGen, existing.brainGen + 1)
        const reused = this.tryReuseActiveLease(sessionKey, existing, now, validatedPolicy)
        if (reused) return reused
        this.fenceAndCloseOldLease(existing)
      }
      this.sessionLeaseIds.delete(sessionKey)
    }
    return this.issueFreshLease(sessionKey, nextBrainGen, opts, validatedPolicy)
  }

  noteReboundBrainGen(sessionKey: string, brainGen: number): void {
    if (brainGen > (this.sessionMaxBrainGen.get(sessionKey) ?? 1)) this.sessionMaxBrainGen.set(sessionKey, brainGen)
  }

  private tryReuseActiveLease(
    sessionKey: string,
    existing: ExecEnvLeaseRecord,
    now: number,
    validatedPolicy?: ExecutionPolicyEnvelope,
  ): ExecEnvLeaseRecord | null {
    if (existing.state !== 'active' || now > existing.expiresAtMs) return null
    let active = existing
    if (now > existing.expiresAtMs - 60_000) {
      try { active = this.deps.leaseManager.renewLease(existing.leaseId) } catch (err) {
        void err
        if (this.deps.clock() > existing.expiresAtMs) return null
      }
    }
    if (validatedPolicy) {
      this.deps.onPolicyApplied(active.leaseId, validatedPolicy)
      this.sessionBaselinePolicies.set(sessionKey, validatedPolicy)
    }
    return active
  }

  private fenceAndCloseOldLease(oldLease: ExecEnvLeaseRecord): void {
    this.deps.onLeaseReplaced(oldLease.leaseId)
    if (oldLease.state !== 'closed') {
      try { this.deps.leaseManager.closeLease(oldLease.leaseId) } catch (err) { void err }
    }
  }

  private issueFreshLease(
    sessionKey: string,
    brainGen: number,
    opts?: { readonly leaseId?: string; readonly tenantId?: string; readonly policy?: ExecutionPolicyEnvelope; readonly ttlMs?: number },
    validatedPolicy?: ExecutionPolicyEnvelope,
  ): ExecEnvLeaseRecord {
    const policy = validatedPolicy ?? this.getBaselinePolicy(sessionKey)
    const lease = this.deps.leaseManager.issueLease({
      ...(opts?.leaseId ? { leaseId: opts.leaseId } : {}),
      execEnvId: this.deps.execEnvId, incarnationId: `inc_${randomUUID().slice(0, 12)}`,
      tenantId: opts?.tenantId ?? 'default', sessionKey, hostKind: this.deps.hostKind, brainGen,
      ...(opts?.ttlMs ? { ttlMs: opts.ttlMs } : {}),
    })
    try { this.deps.onPolicyApplied(lease.leaseId, policy) } catch (err) {
      try { this.deps.leaseManager.closeLease(lease.leaseId) } catch (closeErr) { void closeErr }
      throw err
    }
    this.sessionLeaseIds.set(sessionKey, lease.leaseId)
    this.sessionMaxBrainGen.set(sessionKey, lease.brainGen)
    this.sessionBaselinePolicies.set(sessionKey, policy)
    return lease
  }
}

// ─── B12: Session-Bound Spill Ownership Store (`0600` `.owners.json` Sidecar) ──────────────
interface SpillOwnerEntry { readonly sessionKey: string; readonly leaseId: string; readonly recordedAtMs: number }
interface SpillOwnersSidecar { readonly schemaVersion: 1; readonly blobId: string; readonly owners: readonly SpillOwnerEntry[] }

export class SpillOwnershipStore {
  private readonly ownersDir: string
  private readonly memoryOwners = new Map<string, Map<string, SpillOwnerEntry>>()

  constructor(walDir: string, private readonly clock: () => number) {
    this.ownersDir = join(walDir, 'spill-owners')
  }

  recordOwnership(blobId: string, sessionKey: string, leaseId: string): Promise<void> {
    if (!blobId || !sessionKey) return Promise.resolve()
    let bySession = this.memoryOwners.get(blobId)
    if (!bySession) { bySession = new Map(); this.memoryOwners.set(blobId, bySession) }
    bySession.set(sessionKey, { sessionKey, leaseId, recordedAtMs: Math.floor(this.clock()) })
    const sidecarPath = join(this.ownersDir, `${blobId.replace(/[^A-Za-z0-9._-]/g, '_')}.owners.json`)
    return this.persistMergedSidecar(sidecarPath, blobId, { schemaVersion: 1, blobId, owners: [...bySession.values()] }).catch(ignoreBestEffortError)
  }

  async isAuthorized(blobId: string, sessionKey: string): Promise<boolean> {
    if (!blobId || !sessionKey) return false
    if (this.memoryOwners.get(blobId)?.has(sessionKey)) return true
    const loaded = await this.readSidecar(join(this.ownersDir, `${blobId.replace(/[^A-Za-z0-9._-]/g, '_')}.owners.json`))
    if (!loaded || loaded.blobId !== blobId) return false
    let bySession = this.memoryOwners.get(blobId)
    if (!bySession) { bySession = new Map(); this.memoryOwners.set(blobId, bySession) }
    for (const owner of loaded.owners) bySession.set(owner.sessionKey, owner)
    return bySession.has(sessionKey)
  }

  private async persistMergedSidecar(sidecarPath: string, blobId: string, incoming: SpillOwnersSidecar): Promise<void> {
    const existing = await this.readSidecar(sidecarPath)
    const merged = new Map<string, SpillOwnerEntry>()
    if (existing && existing.blobId === blobId) {
      for (const owner of existing.owners) merged.set(owner.sessionKey, owner)
    }
    for (const owner of incoming.owners) merged.set(owner.sessionKey, owner)
    await writePrivateFileAtomic0600(sidecarPath, JSON.stringify({ schemaVersion: 1, blobId, owners: [...merged.values()] }))
  }

  private async readSidecar(sidecarPath: string): Promise<SpillOwnersSidecar | null> {
    try {
      const st = await lstat(sidecarPath)
      if (!st.isFile() || st.isSymbolicLink()) return null
      const parsed: unknown = JSON.parse(await readFile(sidecarPath, 'utf8'))
      if (!isPlainRecord(parsed) || parsed.schemaVersion !== 1 || typeof parsed.blobId !== 'string' || !Array.isArray(parsed.owners)) {
        return null
      }
      const owners: SpillOwnerEntry[] = []
      for (const item of parsed.owners) {
        if (isPlainRecord(item) && typeof item.sessionKey === 'string' && typeof item.leaseId === 'string' && typeof item.recordedAtMs === 'number') {
          owners.push({ sessionKey: item.sessionKey, leaseId: item.leaseId, recordedAtMs: item.recordedAtMs })
        }
      }
      return { schemaVersion: 1, blobId: parsed.blobId, owners }
    } catch (err) {
      void err
      return null
    }
  }
}
