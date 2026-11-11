/**
 * Container half of one `remote-driver-v4` lane:
 * - Owns the real container `Cc5ToolHost` (never runs tools on master or remote node),
 * - Runs a container-side `RemoteObservationGate` over relayed `RemoteSecurityEvent`s so the
 *   container independently verifies `toolCallObserved` before executing any local tool,
 * - Manages per-turn admission, rolling lease renewal, undispatched `/abandon`, mid-turn
 *   `interrupt`, and dual-proof `/stop` + `/tool/stopped` teardown.
 */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { dirname, join } from 'node:path'
import {
  TURN_LEASE_RENEW_AFTER_MS,
  assertLeaseMatchesAuthority,
  parseRemoteDriverExecutionBackend,
  remoteCanonicalSha256,
  sameRemoteExecutionBackend,
  verifyAuthority,
  verifyTurnLease,
  type AuthorityKeyring,
  type ModelAuthorityPayload,
  type RemoteControlReply,
  type RemoteDriverExecutionBackend,
  type RemotePendingToolRequest,
  type RemotePresentationItem,
  type RemoteReceiptV4,
  type RemoteSecurityEvent,
} from '@openclaude/protocol'
import { CC5_MOUNT, readCc5AuthorityKeyring } from '../cc5BridgePort.js'
import type { Cc5FinanceTerminalOutcome } from '../cc5Finance.js'
import { privateDir, syncDir } from '../cc5FixedTool.js'
import { validateCc5NativeToolInput, type Cc5ToolResult } from '../cc5NativeTool.js'
import {
  cc5RemotePrompt,
  compileCc5ToolCatalog,
  type Cc5HostProfile,
  type Cc5ToolCatalog,
} from '../cc5ToolCatalog.js'
import { Cc5ToolHost } from '../cc5ToolHost.js'
import type { TurnParams } from '../engine/engineAdapter.js'
import type { EngineCreateOpts } from '../engine/registry.js'
import { createLogger } from '../logger.js'
import {
  RenewTurnLeaseError,
  refreshTurnModelAuthorityLease,
  type renewTurnLease,
} from '../masterTurnLease.js'
import { isRemoteResourceCode, nodeMemoryError } from '../remoteNodeMemory.js'
import { SubprocessRunner } from '../subprocessRunner.js'
import { RemoteObservationGate } from './observationGate.js'
import {
  assertRemotePoolBinding,
  remotePoolBackendOf,
  remotePoolNeed,
  type RemotePoolBinding,
  type RemoteRelayedFrame,
} from './types.js'

const log = createLogger({ module: 'remoteContainerLane' })
const LANE_UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const MAX_FRAME_BYTES = 8 * 1024 * 1024
const POLL_IDLE_MS = 15
const TOOL_IDLE_MS = 20
const DEFAULT_EXECUTION_ROOT = '/home/agent/.openclaude/.cc5-native-tools'
const LEASE_RENEW_RETRY_MS = 60_000

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref())
}

export function toHostSessionUuid(operationId: string, nativeSessionId: string): string {
  if (LANE_UUID_RE.test(nativeSessionId)) {
    return nativeSessionId.toLowerCase()
  }
  const hex = createHash('sha256').update(`${operationId}:${nativeSessionId}`, 'utf8').digest('hex')
  const variantNibble = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variantNibble}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export function remotePoolMount(): string {
  const value = process.env.OC_REMOTE_POOL_MOUNT
  return value && value.startsWith('/') && !value.includes('..') ? value.replace(/\/+$/, '') : CC5_MOUNT
}

export function remotePoolLanePaths(
  operationId: string,
  mount = remotePoolMount(),
): { binding: string; socket: string } {
  remotePoolNeed(LANE_UUID_RE.test(operationId), 'REMOTE_BINDING_PATH_INVALID')
  return {
    binding: `${mount}/${operationId}/binding.json`,
    socket: `${mount}/${operationId}/relay.sock`,
  }
}

function isLaneBindingPath(path: string, mount: string): boolean {
  const escaped = mount.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`^${escaped}/([a-f0-9-]{36})/binding\\.json$`, 'i').exec(path)
  return match !== null && LANE_UUID_RE.test(match[1]!)
}

function readSupervisorBinding(path: string, mount: string): unknown {
  remotePoolNeed(isLaneBindingPath(path, mount), 'REMOTE_BINDING_PATH_INVALID')
  const dir = lstatSync(dirname(path))
  remotePoolNeed(dir.isDirectory() && dir.uid === 0 && (dir.mode & 0o027) === 0, 'REMOTE_BINDING_PATH_INVALID')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const meta = fstatSync(fd)
    const link = lstatSync(path)
    remotePoolNeed(
      meta.isFile() &&
        !link.isSymbolicLink() &&
        meta.ino === link.ino &&
        meta.dev === link.dev &&
        meta.uid === 0 &&
        meta.nlink === 1 &&
        (meta.mode & 0o027) === 0 &&
        meta.size > 0 &&
        meta.size <= 8192,
      'REMOTE_BINDING_PATH_INVALID',
    )
    return JSON.parse(readFileSync(fd, 'utf8'))
  } finally {
    closeSync(fd)
  }
}

export function readRemotePoolBinding(path: string, now = Date.now()): Readonly<RemotePoolBinding> {
  try {
    const value = readSupervisorBinding(path, remotePoolMount()) as RemotePoolBinding
    assertRemotePoolBinding(value)
    remotePoolNeed(
      value.expiresAt > now && path === remotePoolLanePaths(value.operationId).binding,
      'REMOTE_BINDING_INVALID',
    )
    return Object.freeze({ ...value })
  } catch {
    throw new Error('REMOTE_BINDING_INVALID')
  }
}

export function refreshRemotePoolBinding(
  initial: Readonly<RemotePoolBinding>,
  socketPath: string,
  now = Date.now(),
): Readonly<RemotePoolBinding> {
  assertRemotePoolBinding(initial)
  try {
    const disk = readRemotePoolBinding(`${dirname(socketPath)}/binding.json`, now)
    for (const key of [
      'version',
      'backendKind',
      'operationId',
      'runId',
      'uid',
      'containerDbId',
      'dockerId',
      'sessionKey',
      'canonicalModel',
      'upstreamModel',
      'driverId',
      'engineId',
      'authorityEngine',
      'driverVersion',
      'driverDigest',
      'coreDigest',
      'probeFingerprint',
      'manifestSha256',
      'generation',
      'profileId',
      'authEpoch',
    ] as const) {
      remotePoolNeed(disk[key] === initial[key], 'REMOTE_BINDING_SCOPE_CHANGED')
    }
    remotePoolNeed(disk.expiresAt >= initial.expiresAt, 'REMOTE_BINDING_EXPIRY_REGRESSED')
    return disk
  } catch {
    return initial
  }
}

/** Single HTTP request over AF_UNIX `relay.sock` — never retries unknown deliveries. */
export function remotePoolControlRequest(
  path: string,
  body: Readonly<Record<string, unknown>>,
  socketPath: string,
  timeoutMs = 120_000,
): Promise<Record<string, unknown>> {
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath,
        agent: false,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_FRAME_BYTES) req.destroy(new Error('REMOTE_CONTROL_RESPONSE_LIMIT'))
          else chunks.push(chunk)
        })
        res.on('error', reject)
        res.on('aborted', () => reject(new Error('REMOTE_CONTROL_RESPONSE_UNKNOWN')))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if (res.statusCode !== 200) {
            try {
              const parsedErr = JSON.parse(text) as { error?: unknown; activeSessions?: unknown }
              if (isRemoteResourceCode(parsedErr.error)) {
                return reject(
                  nodeMemoryError(
                    typeof parsedErr.activeSessions === 'number' ? parsedErr.activeSessions : 0,
                    parsedErr.error,
                  ),
                )
              }
              if (typeof parsedErr.error === 'string' && /^[A-Z][A-Z0-9_]+$/.test(parsedErr.error)) {
                return reject(new Error(parsedErr.error))
              }
            } catch {
              /* fall through to fixed label */
            }
            return reject(new Error('REMOTE_CONTROL_REJECTED'))
          }
          try {
            const value = JSON.parse(text) as Record<string, unknown>
            if (!value || value.ok !== true) {
              throw new Error('REMOTE_CONTROL_REJECTED')
            }
            resolve(value)
          } catch {
            reject(new Error('REMOTE_CONTROL_RESPONSE_INVALID'))
          }
        })
      },
    )
    const timer = setTimeout(() => req.destroy(new Error('REMOTE_CONTROL_DELIVERY_UNKNOWN')), timeoutMs)
    timer.unref()
    req.once('close', () => clearTimeout(timer))
    req.once('error', reject)
    req.end(payload)
  })
}

export interface RemoteAdmittedIdentity {
  readonly authority: string
  readonly lease: string
  readonly turnKey: string
  readonly authorityTurnId: string
  readonly acceptedLeases: readonly string[]
}

export class RemotePoolRelayClient {
  private stopped = false
  private stopping?: Promise<void>
  private startSeq = 0

  constructor(
    private binding: Readonly<RemotePoolBinding>,
    private readonly call: (
      path: string,
      body: Readonly<Record<string, unknown>>,
    ) => Promise<Record<string, unknown>> = (path, body) =>
      remotePoolControlRequest(path, body, remotePoolLanePaths(binding.operationId).socket),
    private readonly reload: () => Readonly<RemotePoolBinding> = () =>
      readRemotePoolBinding(remotePoolLanePaths(binding.operationId).binding),
  ) {
    assertRemotePoolBinding(binding)
  }

  get currentBinding(): Readonly<RemotePoolBinding> {
    return this.binding
  }

  get closed(): boolean {
    return this.stopped
  }

  get admittedBaseline(): number {
    return this.startSeq
  }

  private scope(): Record<string, unknown> {
    const b = this.binding
    return {
      capability: b.capability,
      uid: b.uid,
      containerDbId: b.containerDbId,
      dockerId: b.dockerId,
      operationId: b.operationId,
      sessionKey: b.sessionKey,
      generation: b.generation,
      driverId: b.driverId,
      engineId: b.engineId,
    }
  }

  private adopt(): void {
    remotePoolNeed(!this.stopped, 'REMOTE_LANE_CLOSED')
    const next = this.reload()
    if (next.capability !== this.binding.capability) {
      this.binding = next
    }
  }

  async admit(input: {
    authority: string
    lease: string
    turnKey: string
    catalog: { tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> }
    instructions?: string
  }): Promise<{ seq: number; nativeSessionId: string }> {
    this.adopt()
    const reply = await this.call('/admit', {
      ...this.scope(),
      authority: input.authority,
      lease: input.lease,
      turnKey: input.turnKey,
      catalog: input.catalog,
      ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
    })
    remotePoolNeed(
      reply.ready === true &&
        typeof reply.seq === 'number' &&
        Number.isSafeInteger(reply.seq) &&
        reply.seq >= 0 &&
        typeof reply.nativeSessionId === 'string' &&
        reply.nativeSessionId.length > 0,
      'REMOTE_ADMIT_UNKNOWN',
    )
    this.startSeq = reply.seq
    return { seq: reply.seq, nativeSessionId: reply.nativeSessionId }
  }

  async command(command: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
    this.adopt()
    return await this.call('/command', { ...this.scope(), command })
  }

  async poll(afterSeq: number): Promise<Array<{ seq: number; frame: RemoteRelayedFrame }>> {
    remotePoolNeed(!this.stopped && Number.isSafeInteger(afterSeq) && afterSeq >= 0, 'REMOTE_POLL_INVALID')
    const reply = await this.call('/poll', { ...this.scope(), afterSeq })
    const frames = reply.frames
    remotePoolNeed(Array.isArray(frames) && frames.length <= 100_000, 'REMOTE_POLL_INVALID')
    for (const row of frames) {
      remotePoolNeed(
        row &&
          typeof row === 'object' &&
          typeof (row as { seq?: unknown }).seq === 'number' &&
          Number.isSafeInteger((row as { seq: number }).seq) &&
          (row as { seq: number }).seq > afterSeq &&
          (row as { frame?: unknown }).frame !== undefined,
        'REMOTE_POLL_INVALID',
      )
    }
    return frames as Array<{ seq: number; frame: RemoteRelayedFrame }>
  }

  async baseline(): Promise<number> {
    remotePoolNeed(!this.stopped, 'REMOTE_LANE_CLOSED')
    const reply = await this.call('/baseline', this.scope())
    remotePoolNeed(typeof reply.seq === 'number' && Number.isSafeInteger(reply.seq) && reply.seq >= 0, 'REMOTE_BASELINE_INVALID')
    this.startSeq = Math.max(this.startSeq, reply.seq)
    return this.startSeq
  }

  async toolNext(): Promise<{
    authority?: string
    lease?: string
    turnKey?: string
    request?: RemotePendingToolRequest
  }> {
    this.adopt()
    const reply = await this.call('/tool/next', this.scope())
    if (reply.request === undefined) {
      return {}
    }
    remotePoolNeed(
      typeof reply.authority === 'string' &&
        typeof reply.lease === 'string' &&
        typeof reply.turnKey === 'string' &&
        reply.request !== null &&
        typeof reply.request === 'object',
      'REMOTE_TOOL_DELIVERY_INVALID',
    )
    return {
      authority: reply.authority,
      lease: reply.lease,
      turnKey: reply.turnKey,
      request: reply.request as RemotePendingToolRequest,
    }
  }

  async toolResult(callId: string, result: Cc5ToolResult): Promise<void> {
    const reply = await this.call('/tool/result', { ...this.scope(), callId, result })
    remotePoolNeed(reply.callId === callId, 'REMOTE_TOOL_RESULT_UNKNOWN')
  }

  async toolAck(callId: string): Promise<void> {
    await this.call('/tool/ack', { ...this.scope(), callId })
  }

  async toolStopped(admitted: { authorityTurnId: string; turnKey: string }): Promise<void> {
    await this.call('/tool/stopped', {
      ...this.scope(),
      authorityTurnId: admitted.authorityTurnId,
      turnKey: admitted.turnKey,
    })
  }

  async renew(lease: string): Promise<void> {
    await this.call('/renew', { ...this.scope(), lease })
  }

  async abandon(turnKey: string): Promise<void> {
    const reply = await this.call('/abandon', { ...this.scope(), turnKey })
    remotePoolNeed(reply.abandoned === true, 'REMOTE_ABANDON_UNKNOWN')
  }

  async stop(): Promise<void> {
    this.stopped = true
    return (this.stopping ??= (async () => {
      const reply = await this.call('/stop', this.scope())
      remotePoolNeed(reply.remoteStopped === true, 'REMOTE_STOP_UNPROVEN')
    })().catch((err) => {
      this.stopping = undefined
      throw err
    }))
  }
}

export type LaneToolHost = Pick<Cc5ToolHost, 'tools' | 'execute' | 'close'>

export interface RemoteContainerLaneOptions {
  readonly executionRoot?: string
  readonly hostFactory?: (
    root: string,
    lifecycleId: string,
    profile: Cc5HostProfile,
    env: NodeJS.ProcessEnv,
  ) => LaneToolHost
  readonly toolContextFactory?: () => Promise<{
    profile: Cc5HostProfile
    env: NodeJS.ProcessEnv
    cleanup: () => void
  }>
  readonly binding?: Readonly<RemotePoolBinding>
  readonly socketPath?: string
  readonly call?: (path: string, body: Readonly<Record<string, unknown>>) => Promise<Record<string, unknown>>
  readonly keyring?: AuthorityKeyring
  readonly renewLease?: typeof renewTurnLease
  readonly leaseRenewAfterMs?: number
  readonly toolAuthorizeTimeoutMs?: number
  readonly platformPrompt?: string
  readonly observationOptions?: {
    readonly testFaultBypassObservation?: boolean
    readonly allowTestBypassInTmp?: boolean
  }
}

export interface RemoteTurnHandlers {
  readonly onNativeSession: (nativeSessionId: string) => void
  readonly onSubmitted: () => void
  readonly onSecurityEvent: (event: RemoteSecurityEvent) => void
  readonly onPresentationItem: (item: RemotePresentationItem) => void
  readonly onControlReply?: (reply: RemoteControlReply) => void
  readonly onToolExecuting?: (info: {
    readonly callId: string
    readonly clientToolName: string
    readonly remoteAlias: string
    readonly arguments: Readonly<Record<string, unknown>>
  }) => void
  readonly onToolExecuted?: (info: {
    readonly callId: string
    readonly clientToolName: string
    readonly remoteAlias: string
    readonly result: Cc5ToolResult
  }) => void
}

export type RemoteContainerTurnOutcome =
  | {
      readonly kind: 'settled'
      readonly receipt: RemoteReceiptV4
      readonly outcome: Cc5FinanceTerminalOutcome
      readonly nativeSessionId: string
    }
  | {
      readonly kind: 'abandoned'
      readonly nativeSessionId: string
    }

interface ActiveLaneTurn {
  readonly turnKey: string
  readonly authority: string
  readonly authorityTurnId: string
  readonly payload: ModelAuthorityPayload
  readonly lease: { leaseEnvelope: string }
  nativeSessionId?: string
  dispatched: boolean
  cancelRequested: boolean
  interruptSent: boolean
  stopLease?: () => void
  readonly abort: AbortController
}

export class RemoteContainerLane {
  readonly binding: Readonly<RemotePoolBinding>
  readonly backend: RemoteDriverExecutionBackend
  private readonly opts: EngineCreateOpts
  private readonly laneOptions: RemoteContainerLaneOptions
  private readonly keyring: AuthorityKeyring
  private readonly executionRoot: string
  private readonly socketPath?: string
  private readonly client: RemotePoolRelayClient
  private readonly allowedAliases = new Set<string>()
  private readonly observation: RemoteObservationGate
  private readonly seenAuthorityTurnIds = new Set<string>()

  private host?: LaneToolHost
  private cleanupContext?: () => void
  private catalog?: Cc5ToolCatalog
  private clientNameByRemoteName: Readonly<Record<string, string>> = {}
  private toolsInit?: Promise<Cc5ToolCatalog>

  private admitted?: RemoteAdmittedIdentity
  private activeTurn?: ActiveLaneTurn
  private turnMutex: Promise<void> = Promise.resolve()
  private failure?: Error
  private stopRun?: Promise<void>
  private boundNativeSessionId?: string

  constructor(opts: EngineCreateOpts, laneOptions: RemoteContainerLaneOptions = {}) {
    const scope = parseRemoteDriverExecutionBackend(opts.executionBackend)
    const binding = laneOptions.binding ?? readRemotePoolBinding(remotePoolLanePaths(scope.operationId).binding)
    remotePoolNeed(
      binding.sessionKey === opts.sessionKey &&
        binding.sessionKey === scope.sessionKey &&
        sameRemoteExecutionBackend(remotePoolBackendOf(binding), scope),
      'REMOTE_BINDING_SCOPE_MISMATCH',
    )
    this.opts = opts
    this.laneOptions = laneOptions
    this.binding = binding
    this.backend = remotePoolBackendOf(binding)
    this.keyring = laneOptions.keyring ?? readCc5AuthorityKeyring()
    this.executionRoot = laneOptions.executionRoot ?? DEFAULT_EXECUTION_ROOT
    this.socketPath = laneOptions.socketPath ?? (laneOptions.call ? undefined : remotePoolLanePaths(binding.operationId).socket)
    this.client = new RemotePoolRelayClient(
      binding,
      laneOptions.call ?? ((path, body) => remotePoolControlRequest(path, body, this.socketPath!)),
      this.socketPath && !laneOptions.binding
        ? () => refreshRemotePoolBinding(this.binding, this.socketPath!)
        : () => this.binding,
    )
    this.observation = new RemoteObservationGate(
      {
        operationId: binding.operationId,
        generation: binding.generation,
        profileId: binding.profileId,
        authEpoch: binding.authEpoch,
      },
      this.allowedAliases,
      (reason) => this.fence(reason),
      laneOptions.observationOptions,
    )
  }

  get stopped(): boolean {
    return this.stopRun !== undefined
  }

  get fenceError(): Error | undefined {
    return this.failure
  }

  get nativeSessionId(): string | undefined {
    return this.boundNativeSessionId
  }

  resolveClientToolName(remoteAlias: string): string {
    return this.clientNameByRemoteName[`mcp__ocbridge__${remoteAlias}`] ?? remoteAlias
  }

  private fence(reason: string): void {
    if (this.failure) return
    log.warn('remote-driver-v4 container lane fenced', {
      sessionKey: this.opts.sessionKey,
      driverId: this.binding.driverId,
      reason,
    })
    this.failure = new Error(reason)
    this.activeTurn?.abort.abort(this.failure)
    void this.stopLane().catch(() => {})
  }

  private async ensureTools(): Promise<Cc5ToolCatalog> {
    return (this.toolsInit ??= (async () => {
      privateDir(this.executionRoot)
      const lifecycleId = randomUUID()
      const root = join(this.executionRoot, `remotev4-${this.binding.driverId}-${lifecycleId}`)
      privateDir(root)
      syncDir(this.executionRoot)
      const context = this.laneOptions.toolContextFactory
        ? await this.laneOptions.toolContextFactory()
        : await new SubprocessRunner(this.opts).prepareRemoteToolContext()
      this.cleanupContext = context.cleanup
      try {
        const host =
          this.laneOptions.hostFactory?.(root, lifecycleId, context.profile, context.env) ??
          new Cc5ToolHost(
            root,
            lifecycleId,
            context.profile,
            async () => {
              throw new Error('REMOTE_PERMISSION_PROMPT_UNSUPPORTED')
            },
            context.env,
          )
        this.host = host
        const compiled = compileCc5ToolCatalog(await host.tools())
        this.catalog = compiled
        this.clientNameByRemoteName = compiled.clientNameByRemoteName
        for (const remoteName of Object.keys(compiled.clientNameByRemoteName)) {
          this.allowedAliases.add(remoteName.slice('mcp__ocbridge__'.length))
        }
        return compiled
      } catch (err) {
        await this.host?.close().catch(() => {})
        this.host = undefined
        context.cleanup()
        this.cleanupContext = undefined
        throw err
      }
    })())
  }

  validateTurnSubmission(params: TurnParams): {
    readonly authority: string
    readonly lease: string
    readonly turnKey: string
    readonly payload: ModelAuthorityPayload
    readonly prompt: string
  } {
    remotePoolNeed(
      !params.readOnly && !params.consultTurn && !this.opts.hermeticNoTools,
      'REMOTE_READ_ONLY_OR_CONSULT_UNSUPPORTED',
    )
    remotePoolNeed(!this.failure, this.failure?.message ?? 'REMOTE_LANE_FENCED')
    remotePoolNeed(this.stopRun === undefined, 'REMOTE_LANE_CLOSED')
    const authority = params.modelAuthority?.authorityEnvelope
    const lease = params.modelAuthority?.leaseEnvelope
    const turnKey = params.turnKey
    remotePoolNeed(
      typeof authority === 'string' &&
        typeof lease === 'string' &&
        typeof turnKey === 'string' &&
        /^[a-f0-9]{64}$/.test(turnKey),
      'REMOTE_TURN_AUTHORITY_MISSING',
    )
    const prompt =
      typeof params.input === 'string'
        ? params.input
        : params.input
            .map((block) => (typeof block.text === 'string' ? block.text : `[${block.type}]`))
            .join('\n')
    remotePoolNeed(prompt.trim().length > 0, 'REMOTE_PROMPT_EMPTY')

    const payload = verifyAuthority(authority, this.keyring, Date.now(), { allowExpired: true })
    const leasePayload = verifyTurnLease(lease, this.keyring, Date.now())
    assertLeaseMatchesAuthority(leasePayload, payload)
    remotePoolNeed(
      payload.engine === this.binding.authorityEngine &&
        payload.canonicalModel === this.binding.canonicalModel &&
        String(payload.uid) === this.binding.uid &&
        String(payload.containerId) === this.binding.containerDbId &&
        sameRemoteExecutionBackend(payload.executionBackend, this.backend),
      'REMOTE_TURN_AUTHORITY_SCOPE_MISMATCH',
    )
    remotePoolNeed(
      !this.seenAuthorityTurnIds.has(payload.authorityTurnId),
      'REMOTE_TURN_AUTHORITY_REPLAYED',
    )
    this.seenAuthorityTurnIds.add(payload.authorityTurnId)
    return { authority, lease, turnKey, payload, prompt }
  }

  async executeTurn(
    validated: {
      readonly authority: string
      readonly lease: string
      readonly turnKey: string
      readonly payload: ModelAuthorityPayload
      readonly prompt: string
      readonly effort?: string
    },
    handlers: RemoteTurnHandlers,
  ): Promise<RemoteContainerTurnOutcome> {
    let releaseMutex!: () => void
    const prev = this.turnMutex
    this.turnMutex = new Promise<void>((res) => {
      releaseMutex = res
    })
    await prev

    const turn: ActiveLaneTurn = {
      turnKey: validated.turnKey,
      authority: validated.authority,
      authorityTurnId: validated.payload.authorityTurnId,
      payload: validated.payload,
      lease: { leaseEnvelope: validated.lease },
      dispatched: false,
      cancelRequested: false,
      interruptSent: false,
      abort: new AbortController(),
    }
    this.activeTurn = turn

    try {
      remotePoolNeed(!this.failure && this.stopRun === undefined, this.failure?.message ?? 'REMOTE_LANE_CLOSED')
      const catalog = await this.ensureTools()
      const parsedCatalog = JSON.parse(catalog.json) as {
        tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>
      }
      const wireTools = parsedCatalog.tools.map((t) => ({
        name: t.name,
        description: typeof t.description === 'string' ? t.description : t.name,
        inputSchema: t.inputSchema,
      }))
      const basePrompt = this.laneOptions.platformPrompt ?? ''
      const instructions = cc5RemotePrompt(basePrompt, catalog, this.opts.agentBaseDir)

      this.admitted = {
        authority: turn.authority,
        lease: turn.lease.leaseEnvelope,
        turnKey: turn.turnKey,
        authorityTurnId: turn.authorityTurnId,
        acceptedLeases: [turn.lease.leaseEnvelope],
      }

      const admittedReply = await this.client.admit({
        authority: turn.authority,
        lease: turn.lease.leaseEnvelope,
        turnKey: turn.turnKey,
        catalog: { tools: wireTools },
        instructions,
      })

      turn.nativeSessionId = admittedReply.nativeSessionId
      this.boundNativeSessionId = admittedReply.nativeSessionId
      this.observation.bindSession(admittedReply.nativeSessionId)
      this.observation.beginTurn()
      handlers.onNativeSession(admittedReply.nativeSessionId)
      this.startLeaseRenewal(turn)

      if (turn.cancelRequested || turn.abort.signal.aborted) {
        this.observation.endTurn()
        turn.stopLease?.()
        await this.client.abandon(turn.turnKey)
        return { kind: 'abandoned', nativeSessionId: admittedReply.nativeSessionId }
      }

      turn.dispatched = true
      await this.client.command({
        kind: 'newTurn',
        commandId: `turn-${turn.authorityTurnId}`,
        model: this.binding.upstreamModel,
        prompt: validated.prompt,
        nativeSessionId: admittedReply.nativeSessionId,
        ...(validated.effort ? { effort: validated.effort } : {}),
        instructions,
      })
      handlers.onSubmitted()

      if (turn.cancelRequested && !turn.interruptSent) {
        turn.interruptSent = true
        void this.sendInterrupt(turn).catch(() => {})
      }

      return await this.runActiveTurnLoops(turn, admittedReply.seq, handlers)
    } finally {
      turn.stopLease?.()
      if (this.activeTurn === turn) {
        this.activeTurn = undefined
      }
      releaseMutex()
    }
  }

  private async runActiveTurnLoops(
    turn: ActiveLaneTurn,
    initialSeq: number,
    handlers: RemoteTurnHandlers,
  ): Promise<RemoteContainerTurnOutcome> {
    let afterSeq = initialSeq
    let pollInFlight: Promise<RemoteContainerTurnOutcome | null> | undefined
    let settledOutcome: RemoteContainerTurnOutcome | null = null
    const loopAbort = new AbortController()
    const onTurnAbort = () => loopAbort.abort(turn.abort.signal.reason)
    turn.abort.signal.addEventListener('abort', onTurnAbort, { once: true })

    const pollOnce = (): Promise<RemoteContainerTurnOutcome | null> => {
      if (settledOutcome) return Promise.resolve(settledOutcome)
      return (pollInFlight ??= (async () => {
        try {
          const rows = await this.client.poll(afterSeq)
          for (const row of rows) {
            afterSeq = row.seq
            const frame = row.frame
            if (frame.kind === 'security') {
              this.observation.ingestSecurityEvent(frame.event)
              handlers.onSecurityEvent(frame.event)
            } else if (frame.kind === 'presentation') {
              handlers.onPresentationItem(frame.item)
            } else if (frame.kind === 'control_reply') {
              handlers.onControlReply?.(frame.reply)
            } else if (frame.kind === 'turn_settled') {
              this.observation.endTurn()
              settledOutcome = {
                kind: 'settled',
                receipt: frame.receipt,
                outcome: frame.outcome,
                nativeSessionId: turn.nativeSessionId!,
              }
              loopAbort.abort()
              return settledOutcome
            } else if (frame.kind === 'relay_error') {
              throw new Error(frame.code)
            }
          }
          return null
        } finally {
          pollInFlight = undefined
        }
      })())
    }

    const pollLoop = async (): Promise<RemoteContainerTurnOutcome> => {
      while (!loopAbort.signal.aborted) {
        const out = await pollOnce()
        if (out) return out
        if (this.failure) throw this.failure
        await pause(POLL_IDLE_MS)
      }
      if (settledOutcome) return settledOutcome
      throw this.failure ?? new Error('REMOTE_TURN_ABORTED')
    }

    const toolPump = async (): Promise<void> => {
      while (!loopAbort.signal.aborted && !settledOutcome) {
        const delivery = await this.client.toolNext()
        if (!delivery.request) {
          await pause(TOOL_IDLE_MS)
          continue
        }
        // Ingest any security events published on the same relay tick before authorizing.
        await pollOnce()
        if (settledOutcome || loopAbort.signal.aborted) return
        await this.serveToolDelivery(turn, delivery as Required<typeof delivery>, handlers)
      }
    }

    try {
      const [outcome] = await Promise.all([
        pollLoop().catch((err) => {
          if (settledOutcome) return settledOutcome
          if (!turn.cancelRequested) {
            const code = err instanceof Error ? err.message : 'REMOTE_POLL_FAILED'
            this.fence(code)
          }
          throw err
        }),
        toolPump().catch((err) => {
          if (settledOutcome) return
          const code = err instanceof Error ? err.message : 'REMOTE_TOOL_PUMP_FAILED'
          this.fence(code)
          throw err
        }),
      ])
      return outcome
    } finally {
      loopAbort.abort()
      turn.abort.signal.removeEventListener('abort', onTurnAbort)
    }
  }

  private assertDeliveryLease(
    delivery: { lease: string },
    admitted: RemoteAdmittedIdentity,
    payload: ModelAuthorityPayload,
  ): void {
    if (delivery.lease === admitted.lease || admitted.acceptedLeases.includes(delivery.lease)) {
      return
    }
    const verified = verifyTurnLease(delivery.lease, this.keyring, Date.now(), { allowExpired: true })
    assertLeaseMatchesAuthority(verified, payload)
  }

  private async serveToolDelivery(
    turn: ActiveLaneTurn,
    delivery: {
      authority: string
      lease: string
      turnKey: string
      request: RemotePendingToolRequest
    },
    handlers: RemoteTurnHandlers,
  ): Promise<void> {
    const admitted = this.admitted
    remotePoolNeed(
      admitted !== undefined &&
        delivery.authority === admitted.authority &&
        delivery.turnKey === admitted.turnKey,
      'REMOTE_TOOL_ADMISSION_MISMATCH',
    )
    this.assertDeliveryLease(delivery, admitted, turn.payload)

    const req = delivery.request
    remotePoolNeed(
      req.server === 'ocbridge' &&
        req.argsHash === remoteCanonicalSha256(req.arguments),
      'REMOTE_TOOL_REQUEST_INVALID',
    )
    validateCc5NativeToolInput(`mcp__ocbridge__${req.name}`, req.arguments)
    const clientToolName = this.clientNameByRemoteName[`mcp__ocbridge__${req.name}`]
    remotePoolNeed(typeof clientToolName === 'string', 'REMOTE_TOOL_NOT_IN_CATALOG')

    await this.observation.authorize(
      req,
      this.laneOptions.toolAuthorizeTimeoutMs ?? 5_000,
    )

    const host = this.host
    remotePoolNeed(host !== undefined && this.stopRun === undefined, 'REMOTE_TOOLHOST_CLOSED')

    handlers.onToolExecuting?.({
      callId: req.callId,
      clientToolName,
      remoteAlias: req.name,
      arguments: req.arguments,
    })

    let result: Cc5ToolResult
    try {
      result = await host.execute(clientToolName, req.arguments, {
        nativeSessionId: toHostSessionUuid(this.binding.operationId, req.nativeSessionId),
        turnKey: admitted.turnKey,
        toolUseId: req.callId,
      })
    } catch (err) {
      throw err instanceof Error && /^CC5_[A-Z0-9_]+$/.test(err.message)
        ? err
        : new Error('REMOTE_TOOL_EFFECT_UNKNOWN')
    }

    handlers.onToolExecuted?.({
      callId: req.callId,
      clientToolName,
      remoteAlias: req.name,
      result,
    })

    await this.client.toolResult(req.callId, result)
    await this.client.toolAck(req.callId)
  }

  private startLeaseRenewal(turn: ActiveLaneTurn): void {
    if (this.activeTurn !== turn || this.stopRun !== undefined) return
    const controller = new AbortController()
    let timer: NodeJS.Timeout | undefined
    const stop = () => {
      if (turn.stopLease !== stop) return
      turn.stopLease = undefined
      controller.abort(new Error('remote-driver-v4 turn ended'))
      if (timer) clearTimeout(timer)
      timer = undefined
    }
    turn.stopLease = stop

    const schedule = (delayMs: number) => {
      if (turn.stopLease !== stop || this.activeTurn !== turn) return
      timer = setTimeout(() => {
        void run()
      }, delayMs)
      timer.unref()
    }

    const run = async (): Promise<void> => {
      if (this.activeTurn !== turn || this.stopRun !== undefined) return
      try {
        const renewed = await refreshTurnModelAuthorityLease(turn.turnKey, turn.lease, {
          ...(this.laneOptions.renewLease ? { renew: this.laneOptions.renewLease } : {}),
          signal: controller.signal,
          onRetry: (err, failures) => {
            if (failures === 1 || failures % 10 === 0) {
              log.warn('remote-driver-v4 lease renewal retry', {
                sessionKey: this.opts.sessionKey,
                turnKey: turn.turnKey,
                failures,
                err: err instanceof Error ? err.message : 'unknown',
              })
            }
          },
        })
        if (this.activeTurn !== turn || this.stopRun !== undefined) return
        await this.client.renew(renewed.lease)
        if (this.activeTurn !== turn || this.admitted?.turnKey !== turn.turnKey) return
        const accepted = [renewed.lease, ...this.admitted.acceptedLeases].filter(
          (v, idx, all) => all.indexOf(v) === idx,
        )
        this.admitted = { ...this.admitted, lease: renewed.lease, acceptedLeases: accepted }
        schedule(this.laneOptions.leaseRenewAfterMs ?? TURN_LEASE_RENEW_AFTER_MS)
      } catch (err) {
        if (this.activeTurn !== turn || this.stopRun !== undefined) return
        if (err instanceof RenewTurnLeaseError && !err.retryable) {
          this.fence(err.code)
          return
        }
        schedule(LEASE_RENEW_RETRY_MS)
      }
    }

    schedule(this.laneOptions.leaseRenewAfterMs ?? TURN_LEASE_RENEW_AFTER_MS)
  }

  private async sendInterrupt(turn: ActiveLaneTurn): Promise<void> {
    if (!turn.nativeSessionId || this.stopRun !== undefined) return
    await this.client.command({
      kind: 'interrupt',
      commandId: `interrupt-${randomUUID()}`,
      nativeSessionId: turn.nativeSessionId,
    })
  }

  interrupt(): boolean {
    const turn = this.activeTurn
    if (!turn) return false
    turn.cancelRequested = true
    if (!turn.dispatched) {
      turn.abort.abort(new Error('USER_CANCELLED'))
      return true
    }
    if (!turn.interruptSent) {
      turn.interruptSent = true
      void this.sendInterrupt(turn).catch((err) => {
        this.fence(err instanceof Error ? err.message : 'REMOTE_INTERRUPT_FAILED')
      })
    }
    return true
  }

  stopLane(): Promise<void> {
    this.activeTurn?.abort.abort(new Error('REMOTE_LANE_STOPPING'))
    this.activeTurn?.stopLease?.()
    return (this.stopRun ??= (async () => {
      const stopping = this.client.stop()
      stopping.catch(() => {})
      let localErr: unknown
      try {
        await this.toolsInit?.catch(() => {})
        await this.host?.close()
        this.host = undefined
        this.cleanupContext?.()
        this.cleanupContext = undefined
      } catch (err) {
        localErr = err
      }
      if (!localErr) {
        await this.proveLocalStop(
          this.admitted ?? { authorityTurnId: '', turnKey: '' },
          stopping,
        )
      }
      await stopping
      if (localErr) throw localErr
    })().catch((err) => {
      this.stopRun = undefined
      throw err
    }))
  }

  private async proveLocalStop(
    admitted: { authorityTurnId: string; turnKey: string },
    stopping: Promise<void>,
  ): Promise<void> {
    let settled = false
    void stopping.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    const payload = admitted.authorityTurnId
      ? admitted
      : { authorityTurnId: undefined as unknown as string, turnKey: undefined as unknown as string }
    for (let attempt = 0; attempt < 200 && !settled; attempt++) {
      try {
        await this.client.toolStopped(payload)
        return
      } catch {
        /* wait until relay marks revoked = true */
      }
      await pause(10)
    }
    await this.client.toolStopped(payload).catch(() => {})
  }
}
