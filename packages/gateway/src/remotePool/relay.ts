/**
 * Privileged master relay (`remote-driver-v4`) shared across all remote-pool drivers.
 *
 * Security & accounting invariants:
 * - Never executes model tools on master; gates every tool call through `RemoteObservationGate`
 *   and forwards authorized requests to the container tool host.
 * - Maintains a per-turn rolling `rawEvidenceDigest` (`advanceRawEvidenceDigest`) across
 *   `native_stdin`, `native_stdout`, and `fixed_mcp` raw bytes.
 * - Normalizes usage via driver's declarative `usagePolicy` into `RemoteReceiptV4`, rejecting
 *   missing usage on `success` (`REMOTE_MISSING_USAGE_SAMPLE`), cumulative counter drops, and
 *   conflicting duplicate terminals (`REMOTE_TERMINAL_CONFLICT`).
 * - Exposes `idle` (`!revoked && !starting && !active && servedSeq === outputSeq`) for R1 drain.
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { closeSync, constants, fsyncSync, mkdirSync, openSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  GENESIS_RAW_EVIDENCE_DIGEST,
  advanceRawEvidenceDigest,
  assertLeaseMatchesAuthority,
  buildRemoteReceiptV4,
  normalizeUsageWithPolicy,
  remoteCanonicalJson,
  remoteCanonicalSha256,
  sameRemoteExecutionBackend,
  validatePendingToolRequest,
  verifyAuthority,
  verifyTurnLease,
  type AuthorityKeyring,
  type ModelAuthorityPayload,
  type RemoteControlReply,
  type RemoteDriverCommand,
  type RemoteDriverUsagePolicy,
  type RemotePendingToolRequest,
  type RemoteReceiptV4,
} from '@openclaude/protocol'
import { assertCc5ToolResult, type Cc5ToolResult } from '../cc5NativeTool.js'
import { isRemoteResourceCode, memoryRejection, nodeMemoryError } from '../remoteNodeMemory.js'
import { DriverWorkerClient, type DriverWorkerInfo } from './driverWorkerClient.js'
import { RemoteObservationGate } from './observationGate.js'
import { readJsonLines } from './sshTransport.js'
import {
  assertRemotePoolBinding,
  remotePoolBackendOf,
  remotePoolNeed,
  type RemotePoolBinding,
  type RemotePoolFinancePort,
  type RemotePoolFinanceTurn,
  type RemotePoolHostPort,
  type RemotePoolLaneSpec,
  type RemoteRelayedFrame,
} from './types.js'

const MAX_BODY_BYTES = 2 * 1024 * 1024
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const MAX_TOOL_BODY_BYTES = 196_608

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  remotePoolNeed(req.method === 'POST' && !req.headers['transfer-encoding'], 'REMOTE_HTTP_INVALID')
  const chunks: Buffer[] = []
  let size = 0
  for await (const part of req) {
    size += part.length
    remotePoolNeed(size <= MAX_BODY_BYTES, 'REMOTE_HTTP_BODY_OVERFLOW')
    chunks.push(part)
  }
  const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
  remotePoolNeed(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'REMOTE_HTTP_BODY_INVALID')
  return parsed as Record<string, unknown>
}

interface PendingToolState {
  readonly seq: number
  readonly wireBody: Record<string, unknown>
  readonly request: RemotePendingToolRequest
  delivered: boolean
  result?: Cc5ToolResult
  acknowledged: boolean
}

interface PendingControlWaiter {
  readonly resolve: (reply: RemoteControlReply) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

interface SettledTerminalRecord {
  readonly canonicalHash: string
  readonly countersFinal: Readonly<Record<string, number>>
}

export interface RemotePoolRelayOptions {
  readonly binding: RemotePoolBinding
  readonly keys: AuthorityKeyring
  readonly host: RemotePoolHostPort
  readonly spec: RemotePoolLaneSpec
  readonly journalDir: string
  readonly finance: RemotePoolFinancePort
  readonly worker?: DriverWorkerClient
  readonly onNativeSession?: (nativeSessionId: string) => Promise<void>
  readonly onRemoteStart?: () => Promise<void>
  readonly observeFrame?: (channel: 'app' | 'tool', frame: unknown) => void
  readonly observationOptions?: {
    readonly testFaultBypassObservation?: boolean
    readonly testFaultAllowDuplicateClaim?: boolean
    readonly allowTestBypassInTmp?: boolean
    readonly authorizeTimeoutMs?: number
  }
}

export class RemotePoolRelay {
  readonly binding: Readonly<RemotePoolBinding>
  readonly controlServer = createServer((req, res) => {
    void this.serveHttp(req, res).catch((err) => {
      const code = err instanceof Error ? err.message : 'REMOTE_CONTROL_REJECTED'
      this.fence(code)
      if (!res.headersSent) {
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            ok: false,
            ...(memoryRejection(err) ?? { error: /^[A-Z][A-Z0-9_]+$/.test(code) ? code : 'REMOTE_CONTROL_REJECTED' }),
          }),
        )
      } else {
        res.destroy()
      }
    })
  })

  private readonly keys: AuthorityKeyring
  private readonly host: RemotePoolHostPort
  private readonly spec: RemotePoolLaneSpec
  private readonly journalDir: string
  private readonly finance: RemotePoolFinancePort
  private readonly worker: DriverWorkerClient
  private readonly ownsWorker: boolean
  private readonly onNativeSession: (nativeSessionId: string) => Promise<void>
  private readonly onRemoteStart: () => Promise<void>
  private readonly observeFrame?: (channel: 'app' | 'tool', frame: unknown) => void
  private readonly observationOptions?: RemotePoolRelayOptions['observationOptions']
  private readonly sandboxDuplicateFaultMode: boolean

  private revoked = false
  private firstCause?: string
  private stopping?: Promise<{ remoteStopped: true }>
  private localStopped = true
  private readonly localStops = new EventEmitter()
  private readonly stateEvents = new EventEmitter()
  private readonly acknowledgements = new EventEmitter()

  private launched = false
  private recyclingApp = false
  private appRecycled = false
  private launchedInstructions?: string
  private dispatchedTurnsCount = 0
  private memoryRefused?: 'REMOTE_NODE_MEMORY_EXHAUSTED' | 'REMOTE_NODE_TASKS_EXHAUSTED'
  private turnHostAttempted = false
  private starting = false
  private admitting?: Promise<void>
  private active = false
  private dispatching = false
  private newTurnAcked = false
  private activeNativeTurnId?: string
  private dispatchSeq = 0
  private epoch = 0

  private app?: ChildProcessWithoutNullStreams
  private socket?: ChildProcessWithoutNullStreams
  private appSeq = 0
  private socketSeq = 0
  private outputSeq = 0
  private servedSeq = 0
  private recordSeq = 0
  private securityEventSeq = 0
  private output: Array<{ seq: number; frame: RemoteRelayedFrame }> = []
  private outputBytes = 0
  private stateQueue: Promise<void> = Promise.resolve()

  private readonly usedAuthorities = new Set<string>()
  private readonly usedCommandIds = new Set<string>()
  private readonly tools = new Map<string, PendingToolState>()
  private readonly observedTurnCallIds = new Set<string>()
  private readonly pendingControlReplies = new Map<string, PendingControlWaiter>()
  private readonly settledTerminals = new Map<string, SettledTerminalRecord>()

  private driverInfo?: DriverWorkerInfo
  private usagePolicy?: RemoteDriverUsagePolicy
  private masterNativeState: Record<string, unknown> = {}
  private nativeSessionId?: string
  private boundSession?: { id: string; baseline: Readonly<Record<string, number>> | null }
  private countersBaseline: Readonly<Record<string, number>> | null = null
  private latestUsageCounters?: Readonly<Record<string, number>>
  private usageSampleCount = 0
  private rawEvidenceDigest = GENESIS_RAW_EVIDENCE_DIGEST
  private evidenceSeq = 0

  private observation?: RemoteObservationGate
  private catalogHash?: string
  private admitted?: { authority: string; lease: string; payload: ModelAuthorityPayload; turnKey: string }
  private financeTurn?: RemotePoolFinanceTurn
  private expiry?: ReturnType<typeof setTimeout>

  constructor(options: RemotePoolRelayOptions) {
    assertRemotePoolBinding(options.binding)
    this.binding = Object.freeze({ ...options.binding })
    this.keys = options.keys
    this.host = options.host
    this.spec = options.spec
    this.journalDir = options.journalDir
    this.finance = options.finance
    this.ownsWorker = !options.worker
    this.worker = options.worker ?? new DriverWorkerClient({ registryPath: options.spec.registryPath })
    this.onNativeSession = options.onNativeSession ?? (async () => {})
    this.onRemoteStart = options.onRemoteStart ?? (async () => {})
    this.observeFrame = options.observeFrame
    this.observationOptions = options.observationOptions
    this.sandboxDuplicateFaultMode =
      options.observationOptions?.testFaultAllowDuplicateClaim === true &&
      options.observationOptions?.allowTestBypassInTmp === true &&
      options.spec.manifest.root.startsWith('/tmp/oc-drvtest-')
    const initialUuid =
      typeof options.spec.driverContext?.initialSessionUuid === 'string'
        ? options.spec.driverContext.initialSessionUuid
        : undefined
    this.masterNativeState = {
      expectedModel: options.spec.manifest.model,
      operationId: options.binding.operationId,
      ...(initialUuid ? { sessionId: initialUuid } : {}),
      ...(options.spec.manifest.nativeSessionId ? { sessionId: options.spec.manifest.nativeSessionId } : {}),
    }
    this.stateEvents.setMaxListeners(64)
    this.acknowledgements.setMaxListeners(64)
    mkdirSync(this.journalDir, { recursive: true, mode: 0o700 })
    this.record('binding', { binding: this.binding, spec: this.spec })
  }

  get stopped(): boolean {
    return this.revoked
  }

  get fenceReason(): string | undefined {
    return this.firstCause
  }

  /**
   * True only when no admission is starting/active and every published frame (including `turn_settled`)
   * has been polled by the container — safe for R1 generation drain (`AC-5`).
   */
  get idle(): boolean {
    return !this.revoked && !this.starting && !this.active && !this.recyclingApp && this.servedSeq === this.outputSeq
  }

  private record(kind: string, value: unknown): void {
    const file = join(this.journalDir, `${String(++this.recordSeq).padStart(8, '0')}-${kind}.json`)
    const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      writeFileSync(fd, JSON.stringify(value))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    const dirFd = openSync(this.journalDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      fsyncSync(dirFd)
    } finally {
      closeSync(dirFd)
    }
  }

  private appendEvidence(channel: 'native_stdout' | 'native_stdin' | 'fixed_mcp', rawBytes: Uint8Array | string): void {
    this.rawEvidenceDigest = advanceRawEvidenceDigest(this.rawEvidenceDigest, {
      channel,
      seq: ++this.evidenceSeq,
      rawBytes,
    })
  }

  private enqueueStateOp<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.stateQueue.then(fn)
    this.stateQueue = next.then(
      () => {},
      () => {},
    )
    return next
  }

  private fence(reason: string): void {
    if (this.revoked) return
    const normalized = /^[A-Z][A-Z0-9_]+$/.test(reason) ? reason : 'REMOTE_RELAY_FENCED'
    this.firstCause = normalized
    try {
      this.record('fence', { code: normalized, detail: reason })
    } catch {
      // Preserve revoked flag even if disk fails.
    }
    this.revoked = true
    this.observation?.revoke(normalized)
    for (const [cmdId, waiter] of this.pendingControlReplies) {
      clearTimeout(waiter.timer)
      this.pendingControlReplies.delete(cmdId)
      waiter.reject(new Error(normalized))
    }
    this.stateEvents.emit('change')
    this.acknowledgements.emit('change')
    void this.stop().catch(() => {})
  }

  private assertScope(v: Record<string, unknown>, allowExpired = false): void {
    const b = this.binding
    remotePoolNeed(
      typeof v.capability === 'string' &&
        /^[a-f0-9]{64}$/.test(v.capability) &&
        timingSafeEqual(Buffer.from(v.capability), Buffer.from(b.capability)) &&
        v.operationId === b.operationId &&
        v.sessionKey === b.sessionKey &&
        v.uid === b.uid &&
        v.containerDbId === b.containerDbId &&
        v.dockerId === b.dockerId &&
        v.generation === b.generation &&
        v.driverId === b.driverId &&
        v.engineId === b.engineId &&
        (allowExpired || b.expiresAt > Date.now()),
      'REMOTE_SCOPE_REJECTED',
    )
    if (!allowExpired && this.revoked) {
      throw new Error(this.firstCause ?? 'REMOTE_RELAY_FENCED')
    }
  }

  private verifyAuthorityAndLease(authority: string, lease: string, allowExpiredAuthority = false): ModelAuthorityPayload {
    const a = verifyAuthority(authority, this.keys, Date.now(), { allowExpired: allowExpiredAuthority })
    assertLeaseMatchesAuthority(verifyTurnLease(lease, this.keys, Date.now()), a)
    remotePoolNeed(
      a.engine === this.binding.authorityEngine &&
        a.canonicalModel === this.binding.canonicalModel &&
        String(a.uid) === this.binding.uid &&
        String(a.containerId) === this.binding.containerDbId &&
        sameRemoteExecutionBackend(a.executionBackend, remotePoolBackendOf(this.binding)),
      'REMOTE_AUTHORITY_SCOPE_MISMATCH',
    )
    return a
  }

  private armLeaseTimer(lease: string): void {
    clearTimeout(this.expiry)
    const expiresAt = verifyTurnLease(lease, this.keys, Date.now()).expiresAt
    const ms = Math.max(0, Math.min(expiresAt, this.binding.expiresAt) - Date.now())
    this.expiry = setTimeout(() => this.fence('REMOTE_LEASE_EXPIRED'), ms)
    this.expiry.unref()
  }

  private publish(frame: RemoteRelayedFrame): void {
    const bytes = Buffer.byteLength(JSON.stringify(frame), 'utf8')
    this.outputBytes += bytes
    remotePoolNeed(this.outputBytes <= MAX_OUTPUT_BYTES, 'REMOTE_OUTPUT_BACKPRESSURE')
    this.output.push({ seq: ++this.outputSeq, frame })
  }

  private checkNodeIdentity(row: Record<string, unknown>): void {
    remotePoolNeed(row?.version === 4, 'REMOTE_NODE_PROTOCOL_MISMATCH')
    for (const k of ['driverId', 'engineId', 'operationId', 'runId', 'generation', 'profileId', 'authEpoch'] as const) {
      remotePoolNeed(row[k] === this.spec.manifest[k], 'REMOTE_NODE_IDENTITY_MISMATCH')
    }
  }

  private async ensureDriverInfo(): Promise<DriverWorkerInfo> {
    if (this.driverInfo) return this.driverInfo
    const info = await this.worker.info(this.binding.driverId)
    remotePoolNeed(
      info.driverId === this.binding.driverId &&
        info.engineId === this.binding.engineId &&
        info.authorityEngine === this.binding.authorityEngine &&
        info.driverVersion === this.binding.driverVersion &&
        info.driverDigest === this.binding.driverDigest &&
        info.coreDigest === this.binding.coreDigest,
      'REMOTE_DRIVER_OR_CORE_DIGEST_MISMATCH',
    )
    this.driverInfo = info
    this.usagePolicy = info.usagePolicy
    return info
  }

  private async bindSessionFinance(
    nativeSessionId: string,
    newlyCreated: boolean,
  ): Promise<Readonly<Record<string, number>> | null> {
    const finance = this.financeTurn
    remotePoolNeed(finance !== undefined, 'REMOTE_FINANCE_TURN_MISSING')
    if (this.boundSession) {
      remotePoolNeed(this.boundSession.id === nativeSessionId, 'REMOTE_SESSION_REBIND_MISMATCH')
      return this.boundSession.baseline
    }
    const baseline = await finance.bindNativeThread(nativeSessionId, newlyCreated)
    remotePoolNeed(!this.revoked && this.financeTurn === finance, 'REMOTE_SESSION_BIND_REVOKED')
    if (this.usagePolicy?.mode === 'cumulative') {
      remotePoolNeed(baseline !== null, 'REMOTE_CUMULATIVE_BASELINE_MISSING')
    }
    this.boundSession = { id: nativeSessionId, baseline }
    return baseline
  }

  private openSocket(): Promise<void> {
    const socket = (this.socket = this.host.open('tool-socket'))
    return new Promise((resolve, reject) => {
      let ready = false
      const timer = setTimeout(() => fail(new Error('REMOTE_TOOL_SOCKET_TIMEOUT')), 30_000)
      timer.unref()
      const fail = (err: Error) => {
        clearTimeout(timer)
        reject(err)
        this.fence(err.message)
      }
      readJsonLines(
        socket,
        (row: Record<string, any>) => {
          this.observeFrame?.('tool', row)
          if (!ready && row?.kind === 'error' && isRemoteResourceCode(row.code)) {
            const memErr = nodeMemoryError(row.activeSessions, row.code)
            this.memoryRefused = row.code
            throw memErr
          }
          remotePoolNeed(
            !this.revoked &&
              row?.version === 4 &&
              row.driverId === this.binding.driverId &&
              row.engineId === this.binding.engineId,
            'REMOTE_SOCKET_FRAME_INVALID',
          )
          if (!ready) {
            remotePoolNeed(
              row.kind === 'socket-ready' &&
                row.operationId === this.binding.operationId &&
                row.runId === this.binding.runId &&
                row.generation === this.binding.generation,
              'REMOTE_SOCKET_READY_INVALID',
            )
            ready = true
            clearTimeout(timer)
            resolve()
            return
          }
          if (
            row.kind === 'socket-error' &&
            typeof row.code === 'string' &&
            /^REMOTE_SOCKET_[A-Z0-9_]+$/.test(row.code)
          ) {
            throw new Error(row.code)
          }
          remotePoolNeed(
            row.kind === 'tool-request' && row.seq === ++this.socketSeq && typeof row.body === 'string',
            'REMOTE_SOCKET_REQUEST_INVALID',
          )
          const rawBytes = Buffer.from(row.body, 'base64')
          remotePoolNeed(
            rawBytes.length > 0 && rawBytes.length <= MAX_TOOL_BODY_BYTES && rawBytes.toString('base64') === row.body,
            'REMOTE_SOCKET_BODY_INVALID',
          )
          void this.handleToolSocketRequest(rawBytes, row.seq).catch((e: unknown) => {
            this.fence(e instanceof Error ? e.message : 'REMOTE_SOCKET_GATE_FAILED')
          })
        },
        fail,
      )
      socket.once('close', () => {
        if (!this.revoked) fail(new Error('REMOTE_TOOL_SOCKET_EXIT_UNKNOWN'))
      })
    })
  }

  private openApp(): Promise<void> {
    this.appSeq = 0
    const app = (this.app = this.host.open('launch'))
    return new Promise((resolve, reject) => {
      let ready = false
      const timer = setTimeout(() => fail(new Error('REMOTE_APP_READY_TIMEOUT')), 30_000)
      timer.unref()
      const fail = (err: Error) => {
        clearTimeout(timer)
        reject(err)
        this.fence(err.message)
      }
      readJsonLines(
        app,
        (row: Record<string, any>) => {
          if (this.app !== app) return
          this.observeFrame?.('app', row)
          remotePoolNeed(!this.revoked && row?.seq === ++this.appSeq, 'REMOTE_APP_SEQ_INVALID')
          this.checkNodeIdentity(row)
          if (!ready) {
            if (row.kind === 'error' && isRemoteResourceCode(row.code)) {
              const memErr = nodeMemoryError(row.activeSessions, row.code)
              this.memoryRefused = row.code
              throw memErr
            }
            remotePoolNeed(row.kind === 'ready', row.kind === 'error' ? String(row.code) : 'REMOTE_APP_READY_INVALID')
            ready = true
            clearTimeout(timer)
            this.record('ready', row)
            resolve()
            return
          }
          if (row.kind === 'stderr') return
          if (row.kind === 'error') {
            throw new Error(typeof row.code === 'string' ? row.code : 'REMOTE_NODE_POLICY_REJECTED')
          }
          remotePoolNeed(
            row.kind === 'stdout' &&
              Number.isSafeInteger(row.frameSeq) &&
              typeof row.frameSha256 === 'string' &&
              typeof row.rawB64 === 'string',
            'REMOTE_APP_STDOUT_INVALID',
          )
          const rawBytes = Buffer.from(row.rawB64, 'base64')
          remotePoolNeed(
            rawBytes.toString('base64') === row.rawB64 &&
              createHash('sha256').update(rawBytes).digest('hex') === row.frameSha256,
            'REMOTE_APP_STDOUT_HASH_MISMATCH',
          )
          void this.enqueueStateOp(() => this.processNativeStdout(row.frameSeq as number, rawBytes)).catch(
            (e: unknown) => {
              this.fence(e instanceof Error ? e.message : 'REMOTE_NATIVE_DECODE_FAILED')
            },
          )
        },
        (err: Error) => {
          if (this.app !== app) return
          fail(err)
        },
      )
      app.once('close', () => {
        if (!this.revoked && this.app === app) fail(new Error('REMOTE_HOST_EXIT_UNKNOWN'))
      })
    })
  }

  private async recycleWarmApp(allowDuringAdmit = false): Promise<{ appStopped: true; noHostEffect?: boolean }> {
    remotePoolNeed(
      !this.revoked &&
        !this.recyclingApp &&
        (allowDuringAdmit || (!this.active && !this.starting && !this.admitting)),
      'REMOTE_RECYCLE_BUSY',
    )
    if (!this.launched || this.appRecycled) {
      return { appStopped: true as const, noHostEffect: true }
    }
    remotePoolNeed(
      typeof this.host.recycleApp === 'function' && typeof this.host.reprovisionApp === 'function',
      'REMOTE_APP_RECYCLE_UNSUPPORTED',
    )
    this.recyclingApp = true
    const oldApp = this.app
    this.app = undefined
    try {
      const proof = await this.host.recycleApp()
      try {
        oldApp?.stdin.end()
      } catch {
        /* ignore broken pipe */
      }
      try {
        oldApp?.kill('SIGKILL')
      } catch {
        /* ignore already exited */
      }
      await this.stateQueue.catch(() => {})
      remotePoolNeed(proof.appStopped === true && !this.revoked, 'REMOTE_APP_STOP_UNPROVEN')
      this.appRecycled = true
      this.launchedInstructions = undefined
      const initialUuid =
        typeof this.spec.driverContext?.initialSessionUuid === 'string'
          ? this.spec.driverContext.initialSessionUuid
          : undefined
      const prevConcreteModel =
        typeof this.masterNativeState.resolvedConcreteModel === 'string'
          ? this.masterNativeState.resolvedConcreteModel
          : undefined
      this.masterNativeState = {
        expectedModel: this.spec.manifest.model,
        operationId: this.binding.operationId,
        ...(initialUuid ? { sessionId: initialUuid } : {}),
        ...(this.nativeSessionId ? { sessionId: this.nativeSessionId } : {}),
        ...(prevConcreteModel ? { resolvedConcreteModel: prevConcreteModel } : {}),
      }
      this.record('app-recycled', {
        nativeSessionId: this.nativeSessionId ?? null,
        noHostEffect: Boolean(proof.noHostEffect),
      })
      return {
        appStopped: true as const,
        ...(proof.noHostEffect ? { noHostEffect: true } : {}),
      }
    } catch (err) {
      try {
        oldApp?.kill('SIGKILL')
      } catch {
        /* ignore already exited */
      }
      this.fence(err instanceof Error ? err.message : 'REMOTE_APP_RECYCLE_FAILED')
      throw err
    } finally {
      this.recyclingApp = false
    }
  }

  private async handleToolSocketRequest(rawBytes: Buffer, seq: number): Promise<void> {
    remotePoolNeed(!this.localStopped && this.active && this.dispatching, 'REMOTE_TOOL_OUTSIDE_ACTIVE_TURN')
    this.appendEvidence('fixed_mcp', rawBytes)
    const wireBody = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBytes)) as Record<string, unknown>
    remotePoolNeed(
      wireBody &&
        typeof wireBody === 'object' &&
        wireBody.version === 4 &&
        wireBody.driverId === this.binding.driverId &&
        wireBody.engineId === this.binding.engineId &&
        wireBody.operationId === this.binding.operationId &&
        wireBody.runId === this.binding.runId &&
        wireBody.generation === this.binding.generation &&
        wireBody.profileId === this.binding.profileId &&
        wireBody.authEpoch === this.binding.authEpoch &&
        typeof wireBody.callId === 'string' &&
        (!this.tools.has(wireBody.callId) || this.sandboxDuplicateFaultMode),
      'REMOTE_TOOL_WIRE_BODY_INVALID',
    )
    const pendingReq = validatePendingToolRequest({
      rpcId: wireBody.rpcId,
      callId: wireBody.callId,
      nativeSessionId: wireBody.nativeSessionId,
      ...(wireBody.nativeTurnId !== undefined ? { nativeTurnId: wireBody.nativeTurnId } : {}),
      server: wireBody.server,
      name: wireBody.name,
      arguments: wireBody.arguments,
      argsHash: wireBody.argsHash,
    })
    this.record('tool-attempt', wireBody)

    await this.observation!.authorize({
      ...pendingReq,
      operationId: String(wireBody.operationId),
      generation: String(wireBody.generation),
      profileId: String(wireBody.profileId),
      authEpoch: String(wireBody.authEpoch),
    })

    remotePoolNeed(!this.revoked && !this.localStopped && this.admitted !== undefined, 'REMOTE_TOOL_REVOKED')
    this.verifyAuthorityAndLease(this.admitted.authority, this.admitted.lease, true)
    const toolMapKey =
      this.sandboxDuplicateFaultMode && this.tools.has(pendingReq.callId)
        ? `${pendingReq.callId}#dup${seq}`
        : pendingReq.callId
    this.tools.set(toolMapKey, {
      seq,
      wireBody,
      request: pendingReq,
      delivered: false,
      acknowledged: false,
    })
  }

  private async dispatchCommand(
    command: RemoteDriverCommand,
    opts: { publishReplies: boolean; waitReply: boolean; timeoutMs?: number },
  ): Promise<RemoteControlReply | undefined> {
    let waiterPromise: Promise<RemoteControlReply> | undefined
    const immediate = await this.enqueueStateOp(async () => {
      remotePoolNeed(!this.revoked && this.app !== undefined, 'REMOTE_COMMAND_LANE_CLOSED')
      const encoded = await this.worker.encode(this.binding.driverId, command, this.masterNativeState)
      this.masterNativeState = encoded.nextNativeState
      for (const line of encoded.lines) {
        this.appendEvidence('native_stdin', `${line}\n`)
      }
      const matchImm = encoded.immediateControlReplies.find((r) => r.commandId === command.commandId)
      if (command.kind === 'newTurn' && matchImm?.ok) {
        this.newTurnAcked = true
        if (typeof matchImm.nativeTurnId === 'string') {
          this.activeNativeTurnId = matchImm.nativeTurnId
        }
      }
      if (opts.waitReply && !matchImm) {
        waiterPromise = new Promise<RemoteControlReply>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.pendingControlReplies.delete(command.commandId)
            reject(new Error('REMOTE_CONTROL_REPLY_TIMEOUT'))
          }, opts.timeoutMs ?? 20_000)
          timer.unref()
          this.pendingControlReplies.set(command.commandId, { resolve, reject, timer })
        })
      }
      this.record('command', command)
      this.app.stdin.write(`${JSON.stringify({ kind: 'command', command })}\n`)
      if (opts.publishReplies) {
        for (const r of encoded.immediateControlReplies) {
          this.publish({ kind: 'control_reply', reply: r })
        }
      }
      return matchImm
    })
    if (immediate) return immediate
    if (waiterPromise) return await waiterPromise
    return undefined
  }

  private async processNativeStdout(frameSeq: number, rawBytes: Buffer): Promise<void> {
    remotePoolNeed(!this.revoked && this.admitted !== undefined, 'REMOTE_STDOUT_WITHOUT_ADMISSION')
    this.appendEvidence('native_stdout', rawBytes)
    const prevActiveTurnId = this.masterNativeState.activeTurnId
    const decoded = await this.worker.decode(this.binding.driverId, {
      channel: 'native',
      frameSeq,
      rawBytes,
      nativeState: this.masterNativeState,
      envelope: {
        operationId: this.binding.operationId,
        generation: this.binding.generation,
        profileId: this.binding.profileId,
        authEpoch: this.binding.authEpoch,
        authorityTurnId: this.admitted.payload.authorityTurnId,
        ...(this.nativeSessionId ? { nativeSessionId: this.nativeSessionId } : {}),
      },
      eventSeqStart: this.securityEventSeq + 1,
    })
    this.masterNativeState = decoded.nextNativeState
    this.securityEventSeq += decoded.securityEvents.length
    if (typeof this.masterNativeState.activeTurnId === 'string') {
      this.activeNativeTurnId = this.masterNativeState.activeTurnId
    }
    if (this.masterNativeState.activeTurnId !== prevActiveTurnId) {
      this.stateEvents.emit('change')
    }

    for (const reply of decoded.controlReplies) {
      if (reply.commandKind === 'newTurn' && reply.ok) {
        this.newTurnAcked = true
        if (typeof reply.nativeTurnId === 'string') {
          this.activeNativeTurnId = reply.nativeTurnId
        }
        this.stateEvents.emit('change')
      }
      const waiter = this.pendingControlReplies.get(reply.commandId)
      if (waiter) {
        clearTimeout(waiter.timer)
        this.pendingControlReplies.delete(reply.commandId)
        if (reply.ok) waiter.resolve(reply)
        else waiter.reject(new Error(reply.errorCode ?? 'REMOTE_CONTROL_COMMAND_FAILED'))
      } else {
        this.publish({ kind: 'control_reply', reply })
      }
    }

    for (const item of decoded.presentation) {
      this.publish({ kind: 'presentation', item })
    }

    for (const ev of decoded.securityEvents) {
      const p = ev.payload

      // Handle duplicate terminal replay (`cc` emits usage+turnTerminal with sampleId===terminalId).
      if (!this.active && p.kind === 'usage' && this.settledTerminals.has(p.sampleId)) {
        const prior = this.settledTerminals.get(p.sampleId)!
        remotePoolNeed(isDeepStrictEqual(p.rawCounters, prior.countersFinal), 'REMOTE_TERMINAL_CONFLICT')
        this.record('duplicate-usage', { sampleId: p.sampleId })
        continue
      }
      if (p.kind === 'turnTerminal' && this.settledTerminals.has(p.terminalId)) {
        const prior = this.settledTerminals.get(p.terminalId)!
        const candidateHash = remoteCanonicalSha256({
          terminalId: p.terminalId,
          status: p.status,
          ...(p.errorCode ? { errorCode: p.errorCode } : {}),
        })
        remotePoolNeed(candidateHash === prior.canonicalHash, 'REMOTE_TERMINAL_CONFLICT')
        this.record('duplicate-terminal', { terminalId: p.terminalId })
        continue
      }

      this.observation!.ingestSecurityEvent(ev)
      if (ev.nativeSessionId && ev.nativeSessionId !== 'unassigned' && !this.nativeSessionId) {
        this.nativeSessionId = ev.nativeSessionId
      }

      if (p.kind === 'toolCallObserved') {
        if (p.phase === 'started') {
          this.observedTurnCallIds.add(p.callId)
        } else {
          const tool = this.tools.get(p.callId)
          remotePoolNeed(tool?.result !== undefined, 'REMOTE_TOOL_COMPLETED_BEFORE_RESULT')
        }
      } else if (p.kind === 'usage') {
        remotePoolNeed(this.usagePolicy !== undefined && p.semanticsId === this.usagePolicy.semanticsId, 'REMOTE_USAGE_SEMANTICS_MISMATCH')
        if (!this.dispatching || p.scopeId === 'resume_replay') {
          remotePoolNeed(
            this.usagePolicy.mode === 'cumulative' &&
              this.countersBaseline !== null &&
              isDeepStrictEqual(p.rawCounters, this.countersBaseline),
            'REMOTE_USAGE_REPLAY_UNPROVEN',
          )
          this.record('usage-replay', { sampleId: p.sampleId })
          continue
        }
        const compareBase =
          this.usagePolicy.mode === 'cumulative'
            ? (this.latestUsageCounters ?? this.countersBaseline)
            : null
        normalizeUsageWithPolicy(this.usagePolicy, p.rawCounters, compareBase)
        this.latestUsageCounters = p.rawCounters
        this.usageSampleCount += 1
      }

      this.publish({ kind: 'security', event: ev })

      if (p.kind === 'turnTerminal') {
        await this.settleTerminal(p.terminalId, p.status, p.errorCode)
      }
    }
  }

  private zeroPerTurnCounters(policy: RemoteDriverUsagePolicy): Readonly<Record<string, number>> {
    const out: Record<string, number> = {
      [policy.inputField]: 0,
      [policy.outputField]: 0,
    }
    if (policy.cacheReadField) out[policy.cacheReadField] = 0
    if (policy.cacheWriteField) out[policy.cacheWriteField] = 0
    if (policy.reasoningField) out[policy.reasoningField] = 0
    return Object.freeze(out)
  }

  private waitToolAcknowledgements(): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (err?: Error) => {
        clearTimeout(timer)
        this.acknowledgements.removeListener('change', check)
        if (err) reject(err)
        else resolve()
      }
      const check = () => {
        if (this.revoked) finish(new Error('REMOTE_TOOL_RECEIPT_UNPROVEN'))
        else if ([...this.tools.values()].every((t) => t.result !== undefined && t.acknowledged)) finish()
      }
      const timer = setTimeout(() => finish(new Error('REMOTE_TOOL_RECEIPT_UNPROVEN')), 10_000)
      timer.unref()
      this.acknowledgements.on('change', check)
      check()
    })
  }

  private async settleTerminal(
    terminalId: string,
    nativeStatus: 'success' | 'error' | 'interrupted',
    errorCode?: string,
  ): Promise<void> {
    remotePoolNeed(
      this.active &&
        this.dispatching &&
        this.financeTurn !== undefined &&
        this.admitted !== undefined &&
        this.nativeSessionId !== undefined &&
        this.usagePolicy !== undefined,
      'REMOTE_TERMINAL_OUTSIDE_DISPATCHED_TURN',
    )
    if (nativeStatus === 'success') {
      remotePoolNeed(this.usageSampleCount > 0 && this.latestUsageCounters !== undefined, 'REMOTE_MISSING_USAGE_SAMPLE')
      remotePoolNeed(
        [...this.observedTurnCallIds].every((id) => this.tools.get(id)?.result !== undefined),
        'REMOTE_TOOL_RECEIPT_UNPROVEN',
      )
    }
    await this.waitToolAcknowledgements()

    const countersFinal =
      this.latestUsageCounters ??
      (this.usagePolicy.mode === 'cumulative'
        ? this.countersBaseline!
        : this.zeroPerTurnCounters(this.usagePolicy))

    const receipt: RemoteReceiptV4 = buildRemoteReceiptV4({
      engineId: this.binding.engineId,
      driverId: this.binding.driverId,
      driverVersion: this.binding.driverVersion,
      driverDigest: this.binding.driverDigest,
      uid: this.binding.uid,
      containerDbId: this.binding.containerDbId,
      dockerId: this.binding.dockerId,
      operationId: this.binding.operationId,
      runId: this.binding.runId,
      sessionKey: this.binding.sessionKey,
      canonicalModel: this.binding.canonicalModel,
      upstreamModel: this.spec.manifest.model,
      profileId: this.binding.profileId,
      authEpoch: this.binding.authEpoch,
      authorityTurnId: this.admitted.payload.authorityTurnId,
      turnKey: this.admitted.turnKey,
      requestId: this.financeTurn.requestId,
      nativeSessionId: this.nativeSessionId,
      terminalId,
      policy: this.usagePolicy,
      countersBaseline: this.usagePolicy.mode === 'cumulative' ? this.countersBaseline : null,
      countersFinal,
      nativeStatus,
      rawEvidenceDigest: this.rawEvidenceDigest,
      provenance: {
        generation: this.binding.generation,
        manifestHash: this.binding.manifestSha256,
        coreDigest: this.binding.coreDigest,
        probeFingerprint: this.binding.probeFingerprint,
      },
    })
    this.record('native-terminal', receipt)
    const outcome = await this.financeTurn.terminal(receipt)
    remotePoolNeed(
      outcome.state === 'proven' &&
        outcome.requestId === this.financeTurn.requestId &&
        (!this.admitted.payload.billingRequestId || outcome.requestId === this.admitted.payload.billingRequestId),
      'REMOTE_BILLING_PENDING',
    )
    this.record('terminal-proven', { requestId: outcome.requestId, receiptDigest: receipt.receiptDigest })

    const canonicalHash = remoteCanonicalSha256({
      terminalId,
      status: nativeStatus,
      ...(errorCode ? { errorCode } : {}),
    })
    this.settledTerminals.set(terminalId, { canonicalHash, countersFinal })
    if (this.settledTerminals.size > 128) {
      const oldest = this.settledTerminals.keys().next().value
      if (oldest !== undefined) this.settledTerminals.delete(oldest)
    }

    this.observation!.endTurn()
    this.active = false
    this.dispatching = false
    this.newTurnAcked = false
    this.activeNativeTurnId = undefined
    this.stateEvents.emit('change')
    this.publish({ kind: 'turn_settled', receipt, outcome })
  }

  private admit(v: Record<string, unknown>): Promise<{ ready: true; seq: number; nativeSessionId: string }> {
    remotePoolNeed(!this.admitting, 'REMOTE_ADMIT_CONCURRENT')
    const run = this.admitTurn(v)
    this.admitting = run.then(
      () => {},
      () => {},
    )
    return run.finally(() => {
      this.admitting = undefined
    })
  }

  private async admitTurn(v: Record<string, unknown>): Promise<{ ready: true; seq: number; nativeSessionId: string }> {
    remotePoolNeed(!this.active && !this.starting && !this.revoked, 'REMOTE_ADMIT_BUSY_OR_CLOSED')
    remotePoolNeed(
      typeof v.authority === 'string' && typeof v.lease === 'string' && typeof v.turnKey === 'string' && /^[a-f0-9]{64}$/.test(v.turnKey),
      'REMOTE_ADMIT_TICKET_INVALID',
    )
    const a = this.verifyAuthorityAndLease(v.authority, v.lease, false)
    remotePoolNeed(!this.usedAuthorities.has(a.authorityTurnId), 'REMOTE_AUTHORITY_REPLAYED')
    this.usedAuthorities.add(a.authorityTurnId)
    this.starting = true

    const catalog = v.catalog as { tools?: Array<{ name?: string; description?: string; inputSchema?: { type?: string } }> } | undefined
    remotePoolNeed(
      catalog &&
        Object.keys(catalog).join(',') === 'tools' &&
        Array.isArray(catalog.tools) &&
        catalog.tools.length > 0 &&
        catalog.tools.length <= 128 &&
        catalog.tools.every(
          (t) =>
            typeof t?.name === 'string' &&
            /^[A-Za-z0-9_-]{1,48}$/.test(t.name) &&
            typeof t.description === 'string' &&
            t.inputSchema?.type === 'object',
        ),
      'REMOTE_CATALOG_INVALID',
    )
    const aliasSet = new Set<string>(catalog.tools.map((t) => t.name!))
    remotePoolNeed(aliasSet.size === catalog.tools.length, 'REMOTE_CATALOG_DUPLICATE_TOOL')
    const catalogHash = remoteCanonicalSha256(catalog)
    remotePoolNeed(!this.catalogHash || this.catalogHash === catalogHash, 'REMOTE_CATALOG_DRIFT_ON_LANE')
    this.catalogHash = catalogHash

    const instructions = typeof v.instructions === 'string' ? v.instructions : undefined
    remotePoolNeed(
      instructions === undefined || (!instructions.includes('\u0000') && Buffer.byteLength(instructions, 'utf8') <= 256 * 1024),
      'REMOTE_INSTRUCTIONS_INVALID',
    )

    const info = await this.ensureDriverInfo()
    this.epoch += 1
    this.usedCommandIds.clear()
    this.tools.clear()
    this.observedTurnCallIds.clear()
    this.turnHostAttempted = false
    this.dispatching = false
    this.newTurnAcked = false
    this.activeNativeTurnId = undefined
    this.financeTurn = undefined
    this.boundSession = undefined
    this.countersBaseline = null
    this.latestUsageCounters = undefined
    this.usageSampleCount = 0
    this.rawEvidenceDigest = GENESIS_RAW_EVIDENCE_DIGEST
    this.evidenceSeq = 0

    this.financeTurn = await this.finance.admit({
      binding: this.binding,
      authorityEnvelope: v.authority,
      leaseEnvelope: v.lease,
      sessionKey: this.binding.sessionKey,
      turnKey: v.turnKey,
      usagePolicy: info.usagePolicy,
    })
    if (a.billingRequestId) {
      remotePoolNeed(this.financeTurn.requestId === a.billingRequestId, 'REMOTE_BILLING_REQUEST_MISMATCH')
    }
    this.admitted = { authority: v.authority, lease: v.lease, payload: a, turnKey: v.turnKey }
    remotePoolNeed(!this.revoked, 'REMOTE_REVOKED_DURING_ADMIT')
    await this.onRemoteStart()
    remotePoolNeed(!this.revoked, 'REMOTE_REVOKED_DURING_ADMIT')
    await this.financeTurn.beforeHostStart()
    remotePoolNeed(!this.revoked, 'REMOTE_REVOKED_DURING_ADMIT')
    this.record('admission', { authority: v.authority, lease: v.lease, turnKey: v.turnKey, catalogHash })

    this.observation ??= new RemoteObservationGate(
      {
        operationId: this.binding.operationId,
        generation: this.binding.generation,
        profileId: this.binding.profileId,
        authEpoch: this.binding.authEpoch,
      },
      aliasSet,
      (reason) => this.fence(reason),
      this.observationOptions,
    )
    this.observation.beginTurn()
    this.armLeaseTimer(v.lease)

    if (!this.launched) {
      const pre = await this.host.preflight()
      if (!pre.memoryOk) {
        const reason =
          pre.code === 'REMOTE_NODE_TASKS_EXHAUSTED'
            ? 'REMOTE_NODE_TASKS_EXHAUSTED'
            : 'REMOTE_NODE_MEMORY_EXHAUSTED'
        this.memoryRefused = reason
        throw nodeMemoryError(pre.activeSessions, reason)
      }
      this.launched = true
      this.turnHostAttempted = true
      try {
        await this.host.provision(catalog, instructions !== undefined ? { systemPrompt: instructions } : undefined)
      } catch (err) {
        const mem = memoryRejection(err)
        if (mem && (mem.error === 'REMOTE_NODE_MEMORY_EXHAUSTED' || mem.error === 'REMOTE_NODE_TASKS_EXHAUSTED')) {
          this.memoryRefused = mem.error
        }
        throw err
      }
      remotePoolNeed(!this.revoked, 'REMOTE_REVOKED_AFTER_PROVISION')
      await this.openSocket()
      remotePoolNeed(!this.revoked, 'REMOTE_REVOKED_AFTER_SOCKET')
      await this.openApp()
      remotePoolNeed(!this.revoked, 'REMOTE_REVOKED_AFTER_APP')

      const initReply = await this.dispatchCommand(
        {
          kind: 'initialize',
          commandId: `init-${this.epoch}`,
          model: this.spec.manifest.model,
          ...(instructions !== undefined ? { instructions } : {}),
        },
        { publishReplies: false, waitReply: true },
      )
      remotePoolNeed(initReply?.ok === true, 'REMOTE_INITIALIZE_FAILED')

      const preboundSessionId = this.spec.manifest.nativeSessionId
      if (preboundSessionId) {
        this.nativeSessionId = preboundSessionId
        this.observation.bindSession(preboundSessionId)
        this.countersBaseline = await this.bindSessionFinance(preboundSessionId, false)
      }

      const resumeReply = await this.dispatchCommand(
        {
          kind: 'resume',
          commandId: `resume-${this.epoch}`,
          model: this.spec.manifest.model,
          nativeSessionId: preboundSessionId ?? 'new',
          ...(instructions !== undefined ? { instructions } : {}),
        },
        { publishReplies: false, waitReply: true },
      )
      remotePoolNeed(
        resumeReply?.ok === true &&
          typeof resumeReply.nativeSessionId === 'string' &&
          resumeReply.nativeSessionId.length > 0 &&
          (!preboundSessionId || resumeReply.nativeSessionId === preboundSessionId),
        'REMOTE_RESUME_FAILED',
      )
      if (!preboundSessionId) {
        this.nativeSessionId = resumeReply.nativeSessionId
        this.observation.bindSession(this.nativeSessionId)
        this.countersBaseline = await this.bindSessionFinance(this.nativeSessionId, true)
      }
      await this.onNativeSession(this.nativeSessionId!)
      this.appRecycled = false
      this.launchedInstructions = instructions
    } else {
      remotePoolNeed(typeof this.nativeSessionId === 'string', 'REMOTE_WARM_LANE_WITHOUT_SESSION')
      this.countersBaseline = await this.bindSessionFinance(this.nativeSessionId, false)
      const needsAppRelaunch = this.appRecycled || instructions !== this.launchedInstructions
      if (needsAppRelaunch) {
        if (!this.appRecycled) {
          await this.recycleWarmApp(true)
        }
        remotePoolNeed(typeof this.host.reprovisionApp === 'function', 'REMOTE_APP_RECYCLE_UNSUPPORTED')
        this.turnHostAttempted = true
        await this.host.reprovisionApp(catalog, {
          ...(instructions !== undefined ? { systemPrompt: instructions } : {}),
          nativeSessionId: this.nativeSessionId,
          transcriptExists: this.dispatchedTurnsCount > 0,
        })
        remotePoolNeed(!this.revoked, 'REMOTE_REVOKED_AFTER_REPROVISION')
        await this.openApp()
        remotePoolNeed(!this.revoked, 'REMOTE_REVOKED_AFTER_APP')
        const initReply = await this.dispatchCommand(
          {
            kind: 'initialize',
            commandId: `init-${this.epoch}`,
            model: this.spec.manifest.model,
            ...(instructions !== undefined ? { instructions } : {}),
          },
          { publishReplies: false, waitReply: true },
        )
        remotePoolNeed(initReply?.ok === true, 'REMOTE_INITIALIZE_FAILED')
      }
      const resumeReply = await this.dispatchCommand(
        {
          kind: 'resume',
          commandId: `resume-${this.epoch}`,
          model: this.spec.manifest.model,
          nativeSessionId: this.nativeSessionId,
          ...(instructions !== undefined ? { instructions } : {}),
        },
        { publishReplies: false, waitReply: true },
      )
      remotePoolNeed(
        resumeReply?.ok === true && resumeReply.nativeSessionId === this.nativeSessionId,
        'REMOTE_WARM_RESUME_FAILED',
      )
      this.appRecycled = false
      this.launchedInstructions = instructions
    }

    remotePoolNeed(!this.revoked && typeof this.nativeSessionId === 'string', 'REMOTE_ADMIT_REVOKED')
    this.starting = false
    this.active = true
    this.localStopped = false
    return { ready: true, seq: this.outputSeq, nativeSessionId: this.nativeSessionId }
  }

  private waitForNewTurnAckOrSettle(timeoutMs = 2_000): Promise<void> {
    if (!this.active || this.newTurnAcked) return Promise.resolve()
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.stateEvents.removeListener('change', check)
        resolve()
      }
      const check = () => {
        if (!this.active || this.revoked || this.newTurnAcked) done()
      }
      const timer = setTimeout(done, timeoutMs)
      timer.unref()
      this.stateEvents.on('change', check)
      check()
    })
  }

  private async handleClientCommand(rawCommand: unknown): Promise<Record<string, unknown>> {
    remotePoolNeed(
      this.active && !this.revoked && this.app !== undefined && this.admitted !== undefined && typeof this.nativeSessionId === 'string',
      'REMOTE_COMMAND_OUTSIDE_ACTIVE_ADMISSION',
    )
    remotePoolNeed(rawCommand && typeof rawCommand === 'object' && !Array.isArray(rawCommand), 'REMOTE_COMMAND_INVALID')
    const cmd = rawCommand as Record<string, unknown>
    remotePoolNeed(
      typeof cmd.commandId === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(cmd.commandId) &&
        !this.usedCommandIds.has(cmd.commandId) &&
        this.usedCommandIds.size < 10_000,
      'REMOTE_COMMAND_ID_INVALID_OR_REPLAYED',
    )
    this.usedCommandIds.add(cmd.commandId)
    this.verifyAuthorityAndLease(this.admitted.authority, this.admitted.lease, true)

    if (cmd.kind === 'newTurn') {
      remotePoolNeed(
        !this.dispatching &&
          cmd.model === this.spec.manifest.model &&
          typeof cmd.prompt === 'string' &&
          cmd.prompt.trim().length > 0 &&
          (cmd.nativeSessionId === undefined || cmd.nativeSessionId === this.nativeSessionId),
        'REMOTE_NEW_TURN_INVALID',
      )
      if (cmd.effort !== undefined) {
        remotePoolNeed(
          typeof cmd.effort === 'string' &&
            (this.admitted.payload.executionDescriptor.supportedEfforts as readonly string[]).includes(cmd.effort),
          'REMOTE_EFFORT_NOT_SUPPORTED',
        )
      }
      const typedCmd: RemoteDriverCommand = {
        kind: 'newTurn',
        commandId: cmd.commandId,
        model: this.spec.manifest.model,
        prompt: cmd.prompt,
        nativeSessionId: this.nativeSessionId,
        ...(typeof cmd.effort === 'string' ? { effort: cmd.effort } : {}),
        ...(typeof cmd.instructions === 'string' ? { instructions: cmd.instructions } : {}),
      }
      // Burn dispatch flag BEFORE async effect marker so lost ACKs can never re-submit!
      this.dispatching = true
      this.newTurnAcked = false
      this.activeNativeTurnId = undefined
      await this.financeTurn!.beforeDispatch({
        sequence: ++this.dispatchSeq,
        inputSha256: remoteCanonicalSha256(typedCmd),
      })
      await this.dispatchCommand(typedCmd, { publishReplies: true, waitReply: false })
      this.dispatchedTurnsCount += 1
      return { dispatched: true }
    }

    if (cmd.kind === 'interrupt') {
      remotePoolNeed(cmd.nativeSessionId === this.nativeSessionId, 'REMOTE_INTERRUPT_SESSION_MISMATCH')
      if (!this.dispatching || !this.active) {
        return { alreadySettled: true }
      }
      // For async RPC drivers whose `newTurn` control reply is still in flight on stdout, wait briefly before encoding `interrupt`.
      if (!this.newTurnAcked) {
        await this.waitForNewTurnAckOrSettle(2_000)
      }
      if (!this.active || !this.dispatching) {
        return { alreadySettled: true }
      }
      if (!this.newTurnAcked) {
        return { deferredToStop: true }
      }
      const activeTurnId =
        this.activeNativeTurnId ?? (typeof cmd.nativeTurnId === 'string' ? cmd.nativeTurnId : undefined)
      const typedCmd: RemoteDriverCommand = {
        kind: 'interrupt',
        commandId: cmd.commandId,
        nativeSessionId: this.nativeSessionId,
        ...(activeTurnId ? { nativeTurnId: activeTurnId } : {}),
      }
      await this.dispatchCommand(typedCmd, { publishReplies: true, waitReply: false })
      return { interrupted: true }
    }

    if (cmd.kind === 'readState') {
      remotePoolNeed(cmd.nativeSessionId === this.nativeSessionId, 'REMOTE_READ_STATE_SESSION_MISMATCH')
      const typedCmd: RemoteDriverCommand = {
        kind: 'readState',
        commandId: cmd.commandId,
        nativeSessionId: this.nativeSessionId,
      }
      await this.dispatchCommand(typedCmd, { publishReplies: true, waitReply: false })
      return { requested: true }
    }

    throw new Error('REMOTE_CLIENT_COMMAND_FORBIDDEN')
  }

  private async abandon(v: Record<string, unknown>): Promise<void> {
    remotePoolNeed(
      this.active && !this.dispatching && !this.starting && !this.revoked && this.admitted && this.financeTurn,
      'REMOTE_ABANDON_INVALID_STATE',
    )
    remotePoolNeed(v.turnKey === this.admitted.turnKey, 'REMOTE_ABANDON_SCOPE_MISMATCH')
    clearTimeout(this.expiry)
    this.active = false
    this.observation?.endTurn()
    const outcome = await this.financeTurn.abandonUndispatched()
    remotePoolNeed(outcome.state === 'proven', 'REMOTE_ABANDON_UNSETTLED')
    this.record('abandoned', { authorityTurnId: this.admitted.payload.authorityTurnId, turnKey: v.turnKey })
  }

  private waitLocalStop(): Promise<void> {
    if (this.localStopped) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer)
        this.localStops.removeListener('stopped', done)
        resolve()
      }
      const timer = setTimeout(() => {
        this.localStops.removeListener('stopped', done)
        reject(new Error('REMOTE_LOCAL_STOP_TIMEOUT'))
      }, 5_000)
      timer.unref()
      this.localStops.once('stopped', done)
    })
  }

  async handleControl(path: string, v: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.assertScope(v, path === '/stop' || path === '/tool/stopped')
    if (path === '/admit') {
      return { ok: true, ...(await this.admit(v)) }
    }
    if (path === '/command') {
      return { ok: true, ...(await this.handleClientCommand(v.command)) }
    }
    if (path === '/poll') {
      remotePoolNeed(
        typeof v.afterSeq === 'number' &&
          Number.isSafeInteger(v.afterSeq) &&
          v.afterSeq >= 0 &&
          v.afterSeq <= this.outputSeq,
        'REMOTE_POLL_SEQ_INVALID',
      )
      const afterSeq = v.afterSeq
      this.output = this.output.filter((f) => f.seq > afterSeq)
      this.outputBytes = Buffer.byteLength(JSON.stringify(this.output), 'utf8')
      this.servedSeq = this.outputSeq
      return { ok: true, frames: this.output }
    }
    if (path === '/baseline') {
      remotePoolNeed(!this.revoked, 'REMOTE_BASELINE_REVOKED')
      return { ok: true, seq: this.outputSeq }
    }
    if (path === '/tool/next') {
      const tool = [...this.tools.values()].find((t) => !t.delivered)
      if (!tool) return { ok: true }
      tool.delivered = true
      this.record('tool-delivered', { callId: tool.request.callId })
      return {
        ok: true,
        request: tool.request,
        authority: this.admitted!.authority,
        lease: this.admitted!.lease,
        turnKey: this.admitted!.turnKey,
      }
    }
    if (path === '/tool/result') {
      const callId = typeof v.callId === 'string' ? v.callId : ''
      const direct = this.tools.get(callId)
      const tool =
        (direct?.delivered && !direct.result ? direct : undefined) ??
        (this.sandboxDuplicateFaultMode
          ? [...this.tools.values()].find((t) => t.request.callId === callId && t.delivered && !t.result)
          : undefined)
      remotePoolNeed(tool?.delivered && !tool.result, 'REMOTE_TOOL_RESULT_UNEXPECTED')
      assertCc5ToolResult(v.result)
      const cleanResult: Cc5ToolResult = {
        content: (v.result as Cc5ToolResult).content,
        isError: (v.result as Cc5ToolResult).isError,
      }
      tool.result = cleanResult
      this.record('tool-receipt', { callId, result: cleanResult })
      const { arguments: _args, ...identity } = tool.wireBody
      const receiptPayload = { ...identity, version: 4, ok: true, result: cleanResult }
      const responseFrame = {
        version: 4,
        driverId: this.binding.driverId,
        engineId: this.binding.engineId,
        kind: 'tool-response',
        seq: tool.seq,
        status: 200,
        body: Buffer.from(remoteCanonicalJson(receiptPayload), 'utf8').toString('base64'),
      }
      this.socket!.stdin.write(`${JSON.stringify(responseFrame)}\n`)
      return { ok: true, callId }
    }
    if (path === '/tool/ack') {
      const callId = typeof v.callId === 'string' ? v.callId : ''
      const direct = this.tools.get(callId)
      const tool =
        (direct?.result !== undefined && !direct.acknowledged ? direct : undefined) ??
        (this.sandboxDuplicateFaultMode
          ? [...this.tools.values()].find(
              (t) => t.request.callId === callId && t.result !== undefined && !t.acknowledged,
            )
          : undefined)
      remotePoolNeed(tool !== undefined && tool.result !== undefined && !tool.acknowledged, 'REMOTE_TOOL_ACK_INVALID')
      this.record('tool-ack', { callId })
      tool.acknowledged = true
      this.acknowledgements.emit('change')
      return { ok: true }
    }
    if (path === '/tool/stopped') {
      remotePoolNeed(
        this.revoked &&
          (!this.admitted ||
            (v.authorityTurnId === this.admitted.payload.authorityTurnId && v.turnKey === this.admitted.turnKey)),
        'REMOTE_LOCAL_STOP_SCOPE_MISMATCH',
      )
      this.localStopped = true
      this.record('local-stopped', {
        generation: this.binding.generation,
        authorityTurnId: v.authorityTurnId ?? null,
        turnKey: v.turnKey ?? null,
      })
      this.localStops.emit('stopped')
      return { ok: true }
    }
    if (path === '/renew') {
      remotePoolNeed(this.admitted !== undefined && typeof v.lease === 'string', 'REMOTE_RENEW_INVALID')
      this.verifyAuthorityAndLease(this.admitted.authority, v.lease, true)
      this.admitted.lease = v.lease
      this.armLeaseTimer(v.lease)
      return { ok: true }
    }
    if (path === '/abandon') {
      await this.abandon(v)
      return { ok: true, abandoned: true }
    }
    if (path === '/recycle') {
      return { ok: true, ...(await this.recycleWarmApp(false)) }
    }
    if (path === '/stop') {
      return { ok: true, ...(await this.stop()) }
    }
    throw new Error('REMOTE_CONTROL_PATH_UNKNOWN')
  }

  private async serveHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const v = await readJsonBody(req)
    const out = await this.handleControl(req.url ?? '', v)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(out))
  }

  stop(): Promise<{ remoteStopped: true }> {
    this.revoked = true
    clearTimeout(this.expiry)
    this.stateEvents.emit('change')
    this.acknowledgements.emit('change')
    return (this.stopping ??= (async () => {
      this.observation?.revoke()
      await this.admitting?.catch(() => {})
      let proof: { remoteStopped: true; noHostEffect?: boolean }
      try {
        proof = await this.host.stop()
      } finally {
        this.app?.stdin.end()
        this.socket?.stdin.end()
        this.app?.kill('SIGKILL')
        this.socket?.kill('SIGKILL')
      }
      await this.waitLocalStop()
      await this.financeTurn?.stop({
        hostStartAttempted: this.turnHostAttempted,
        userSubmitted: this.dispatching,
        remoteStopped: proof.remoteStopped && this.localStopped,
        ...(this.memoryRefused ? { nodeAdmissionRejected: true, nodeAdmissionReason: this.memoryRefused } : {}),
      })
      remotePoolNeed(proof.remoteStopped && this.localStopped, 'REMOTE_STOP_UNKNOWN')
      if (this.financeTurn && (this.active || this.starting) && !this.dispatching) {
        const outcome = await this.financeTurn.abandonUndispatched(
          this.firstCause
            ? { failureCode: 'INTERNAL_ERROR', diagnostic: this.firstCause.toLowerCase().slice(0, 64) }
            : undefined,
        )
        remotePoolNeed(outcome.state === 'proven', 'REMOTE_ABANDON_UNSETTLED')
        this.active = false
        this.starting = false
        this.record('abandoned', { authorityTurnId: this.admitted?.payload.authorityTurnId, cause: this.firstCause })
      }
      if (this.ownsWorker) {
        await this.worker.close()
      }
      this.record('stopped', { remoteStopped: true })
      return { remoteStopped: true as const }
    })().catch((err) => {
      this.stopping = undefined
      throw err
    }))
  }
}
