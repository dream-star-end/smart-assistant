/**
 * Container half of one Codex remote lane: the real CCB tool host, the master relay client and
 * this container's own native item observation. The protocol kernel stays the local one.
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  type AuthorityKeyring,
  type CodexExecutionBackend,
  type ModelAuthorityPayload,
  TURN_LEASE_RENEW_AFTER_MS,
  assertLeaseMatchesAuthority,
  parseCodexExecutionBackend,
  sameRemoteExecutionBackend,
  verifyAuthority,
  verifyTurnLease,
} from '@openclaude/protocol'
import { type Cc5ToolResult, cc5ToolInputSha256, validateCc5NativeToolInput } from './cc5NativeTool.js'
import { privateDir, syncDir } from './cc5FixedTool.js'
import { Cc5ToolHost } from './cc5ToolHost.js'
import {
  type Cc5HostProfile,
  type Cc5ToolCatalog,
  cc5RemotePrompt,
  compileCc5ToolCatalog,
} from './cc5ToolCatalog.js'
import { readCc5AuthorityKeyring } from './cc5BridgePort.js'
import { SubprocessRunner } from './subprocessRunner.js'
import {
  type renewTurnLease,
  RenewTurnLeaseError,
  refreshTurnModelAuthorityLease,
} from './masterTurnLease.js'
import {
  type CodexAdmittedIdentity,
  CodexRelayClient,
  codexControlRequest,
  codexLanePaths,
  readCodexBinding,
  refreshCodexBinding,
} from './codexRemotePort.js'
import { CodexRelayChild, asRelayChild } from './codexRemoteTransport.js'
import { CodexToolObservation } from './codexToolObservation.js'
import { type CodexRemoteBinding, codexBackend, codexNeed } from './codexRemoteContract.js'
import { CodexAppServerRunner } from './engine/codexAppServerRunner.js'
import type { TurnParams } from './engine/engineAdapter.js'
import type { EngineCreateOpts } from './engine/registry.js'
import { codexRunnerOptions } from './codexKernelOptions.js'
import { createLogger } from './logger.js'

const log = createLogger({ module: 'codexRemoteLane' })
const TOOL_IDLE_MS = 25
const DEFAULT_EXECUTION_ROOT = '/home/agent/.openclaude/.cc5-native-tools'
/** A renewal is retried on its own clock; the lease window, not this delay, is the deadline. */
const LEASE_RENEW_RETRY_MS = 60_000
const MAX_QUEUED_TURNS = 8

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref())
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

type LaneToolHost = Pick<Cc5ToolHost, 'tools' | 'execute' | 'close'>

/**
 * One container-side kernel generation. The kernel recycles its process after an interrupt, so a
 * chat has several of these; the lane identity (and the node's resident app) spans all of them.
 */
interface LaneGeneration {
  readonly client: CodexRelayClient
  readonly child: CodexRelayChild
  readonly abort: AbortController
  host?: LaneToolHost
  /** One host per generation, built once even when several turns race to need it. */
  toolsRun?: Promise<Cc5ToolCatalog>
  pumpRun?: Promise<void>
  closeRun?: Promise<void>
  cleanupContext?: () => void
}

/**
 * One turn of the lane, in order. The master admits exactly one at a time per lane, so the lane
 * owns the head of this list and queues the rest; ownership (and the tool host, the tool pump and
 * the lease renewal that go with it) is handed over one turn at a time.
 */
interface LaneTurn {
  readonly turnKey: string
  readonly authority: string
  readonly authorityTurnId: string
  readonly payload: ModelAuthorityPayload
  /** Mutable: the rolling renewal rewrites this envelope before every master call. */
  readonly lease: { leaseEnvelope: string }
  admission?: Promise<void>
  /** The node accepted `turn/start`: an effect may exist, so this turn is never abandoned. */
  dispatched: boolean
  /** The kernel's own result arrived and this turn is unwinding without a native terminal. */
  finishing: boolean
  stopLease?: () => void
}

export interface CodexRemoteLaneOptions {
  /** Fixtures only: production hosts tools under the persistent uid-local root. */
  executionRoot?: string
  hostFactory?: (root: string, lifecycleId: string, profile: Cc5HostProfile, env: NodeJS.ProcessEnv) => LaneToolHost
  /** Fixtures only: production reads the supervisor-owned binding, socket and keyring. */
  binding?: Readonly<CodexRemoteBinding>
  socketPath?: string
  keyring?: AuthorityKeyring
  /** Fixtures only: the master's rolling lease endpoint, reached through the same client. */
  renewLease?: typeof renewTurnLease
  /** Fixtures only: production slides the window 30 minutes ahead of the lease expiry. */
  leaseRenewAfterMs?: number
}

/** One lane = one chat. The resident app-server serves every turn of that chat. */
export class CodexRemoteLane {
  readonly kernel: CodexAppServerRunner
  readonly backend: CodexExecutionBackend
  private readonly observation: CodexToolObservation
  /** Live view of the alias set; filled once the catalog is known, before any frame arrives. */
  private readonly catalogNames = new Set<string>()
  private readonly keyring: AuthorityKeyring
  private readonly executionRoot: string
  private readonly laneOptions: CodexRemoteLaneOptions
  private readonly opts: EngineCreateOpts
  private readonly binding: Readonly<CodexRemoteBinding>
  private readonly socketPath: string
  private generation?: LaneGeneration
  private control?: CodexRelayClient
  private readonly generations = new Set<LaneGeneration>()
  private catalog?: Cc5ToolCatalog
  private toolNames: Readonly<Record<string, string>> = {}
  private admitted?: CodexAdmittedIdentity
  /** The turn the master currently holds an admission for (the only one that may be running). */
  private owner?: LaneTurn
  /** Turns submitted behind the owner, in submission order. */
  private readonly queued: LaneTurn[] = []
  private admission?: Promise<void>
  /**
   * Frames the kernel writes between two admissions (after a turn unwound locally, before the next
   * turn was admitted) are held here: they must never reach the master on a finished admission.
   */
  private gate?: Deferred<void>
  /** Kernel result `requestId` → the lane turn it belongs to. */
  private readonly turnByRequest = new Map<string, LaneTurn>()
  private stopRun?: Promise<void>
  private failure?: Error

  constructor(opts: EngineCreateOpts, laneOptions: CodexRemoteLaneOptions = {}) {
    const lane = this
    const scope = parseCodexExecutionBackend(opts.executionBackend)
    const binding = laneOptions.binding ?? readCodexBinding(codexLanePaths(scope.operationId).binding)
    codexNeed(binding.sessionKey === opts.sessionKey && binding.sessionKey === scope.sessionKey &&
      sameRemoteExecutionBackend(codexBackend(binding), scope), 'CODEX_BINDING_SCOPE_CHANGED')
    this.opts = opts
    this.laneOptions = laneOptions
    this.executionRoot = laneOptions.executionRoot ?? DEFAULT_EXECUTION_ROOT
    this.keyring = laneOptions.keyring ?? readCc5AuthorityKeyring()
    this.backend = codexBackend(binding)
    this.binding = binding
    this.socketPath = laneOptions.socketPath ?? codexLanePaths(binding.operationId).socket
    // The alias set is fixed by the catalog the master launched this lane with.
    this.observation = new CodexToolObservation(this.catalogNames, (reason) => this.fence(reason))
    this.kernel = new CodexAppServerRunner(codexRunnerOptions(opts, {
      // A getter, not a snapshot: a kernel recycled after an interrupt must pick up the fresh child.
      get child() { return asRelayChild(lane.current().child) },
      ready: () => this.readyForTurn(),
      instructions: (platformPrompt) => this.instructions(platformPrompt),
      // The kernel calls this on every shutdown, including the transient recycle behind a user
      // cancel. The lane itself is only revoked by stopLane(), from the adapter's shutdown.
      stop: () => this.recycle(),
    }))
    // The kernel reports one result per turn, whatever its outcome: a turn that never produced a
    // native terminal (cancel before `turn/start`, host error) still ends locally, and the lane
    // must hand its admission back instead of waiting for a terminal that cannot arrive.
    this.kernel.on('message', (message: { type?: unknown; requestId?: unknown }) => {
      if (message?.type !== 'result' || typeof message.requestId !== 'string') return
      this.finishTurn(message.requestId)
    })
  }

  /** The current kernel generation, created on first use and after every recycle. */
  private current(): LaneGeneration {
    return this.generation ??= this.spawn()
  }

  private spawn(): LaneGeneration {
    codexNeed(this.stopRun === undefined, 'CODEX_LANE_CLOSED')
    const client = new CodexRelayClient(
      this.binding,
      this.laneOptions.socketPath
        ? (path, body) => codexControlRequest(path, body, this.socketPath)
        : undefined,
      this.laneOptions.socketPath ? () => this.binding : () => refreshCodexBinding(this.binding, this.socketPath),
    )
    const child = new CodexRelayChild(client, { onFrame: (frame) => this.feed(frame) })
    const generation: LaneGeneration = { client, child, abort: new AbortController() }
    this.control = client
    this.generations.add(generation)
    // A generation spawned inside an admitted turn (the kernel restarts its app-server on a route
    // change) inherits that turn's gate, skips the frames this turn already produced, and — see
    // activate() — must also serve this turn's tool calls.
    if (this.gate) {
      // Interregnum: a turn is unwinding (or already unwound) and its admission has not been closed
      // by the master yet. Whatever the kernel recycled in between belongs to the next turn.
      child.setGate(this.gate.promise)
    } else if (this.admission) {
      const admission = this.admission
      child.setGate(admission.then(() => client.rebase()))
      void admission.then(() => this.activate(generation)).catch((error: unknown) => {
        this.fence(error instanceof Error ? error.message : 'CODEX_TOOLHOST_FAILED')
      })
    }
    return generation
  }

  /** Called once the catalog exists: the same alias table the node serves as `ocbridge`. */
  private bindCatalog(catalog: Cc5ToolCatalog): void {
    this.catalog = catalog
    this.toolNames = catalog.clientNameByRemoteName
    for (const name of Object.keys(catalog.clientNameByRemoteName)) {
      this.catalogNames.add(name.slice('mcp__ocbridge__'.length))
    }
  }

  /** The platform prompt plus the exact alias table the node serves. */
  private instructions(platformPrompt: string): string {
    codexNeed(this.catalog !== undefined, 'CODEX_TOOL_CATALOG_UNAVAILABLE')
    return cc5RemotePrompt(platformPrompt, this.catalog!, this.opts.agentBaseDir)
  }

  /** The admission the kernel must wait for before it writes this generation's first frame. */
  private readyForTurn(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.stopRun !== undefined) return Promise.reject(new Error('CODEX_LANE_CLOSED'))
    // An interregnum outranks the owner: the finishing turn's admission already resolved, but the
    // master has not closed it, so nothing may be written on top of it — not even by a generation
    // the kernel recycled in the meantime.
    if (this.gate) return this.gate.promise
    const owner = this.owner
    if (owner) return owner.admission ?? Promise.reject(new Error('CODEX_ADMIT_REQUIRED'))
    // A generation spawned between turns: hold it until the next turn is admitted.
    return this.admission ?? Promise.reject(new Error('CODEX_ADMIT_REQUIRED'))
  }

  /** Every relayed native frame passes the container's own gate before the kernel sees it. */
  private feed(frame: unknown): void {
    const f = frame as {
      result?: { thread?: { id?: unknown } }
      params?: { threadId?: unknown }
      method?: unknown
    }
    const threadId = typeof f?.result?.thread?.id === 'string' ? f.result.thread.id : f?.params?.threadId
    if (typeof threadId === 'string' && threadId) {
      if (this.observation.nativeThreadId === undefined) this.observation.bindThread(threadId)
      else codexNeed(this.observation.nativeThreadId === threadId, 'CODEX_NATIVE_THREAD_CHANGED')
    }
    this.observation.observe(frame)
    const method = f?.method
    if (method === 'turn/started') {
      // The node accepted `turn/start`: from here on an effect may exist for this turn.
      if (this.owner) this.owner.dispatched = true
      return
    }
    if (method !== 'turn/completed') return
    this.observation.endTurn()
    // The master settled this turn's receipt with the terminal: the lane is free again.
    if (this.owner) this.releaseTurn(this.owner)
  }

  /**
   * The kernel's own end of a turn. A relayed terminal already released the turn; anything else
   * means the turn unwound in this container without the master knowing.
   */
  private finishTurn(requestId: string): void {
    const turn = this.turnByRequest.get(requestId)
    if (!turn) return
    this.turnByRequest.delete(requestId)
    if (this.owner !== turn || turn.finishing) return
    if (turn.dispatched) {
      // `turn/start` reached the node but no terminal came back: the effect state is unknown, and
      // a second admission on top of that would be unprovable.
      this.fence('CODEX_TURN_UNSETTLED')
      return
    }
    turn.finishing = true
    // The interregnum starts here, synchronously: until the master confirms the closure, every
    // frame this container writes must wait, whichever generation the kernel ends up using.
    const gate = this.gate ??= deferred<void>()
    const generation = this.generation
    if (generation && !generation.child.killed) generation.child.setGate(gate.promise)
    const admission = turn.admission ?? Promise.resolve()
    // The abandon can only be sent once the master holds the (already proving) admission.
    void admission.then(() => this.abandon(turn), () => {})
  }

  /**
   * An admitted turn that provably never reached the node: the master closes the admission without
   * a receipt so the lane's next turn can admit on the same resident app.
   */
  private async abandon(turn: LaneTurn): Promise<void> {
    // Whatever the kernel writes from here belongs to the next turn: hold it until that turn's own
    // admission lands rather than letting it ride on the admission being abandoned. finishTurn
    // installed the gate already; re-install it in case the kernel recycled while this abandon
    // waited for its admission.
    const gate = this.gate ??= deferred<void>()
    const generation = this.generation
    if (generation && !generation.child.killed) generation.child.setGate(gate.promise)
    try {
      codexNeed(generation !== undefined && !generation.client.closed, 'CODEX_LANE_CLOSED')
      await generation!.client.abandon(turn.turnKey)
      log.info('codex remote turn abandoned before dispatch', {
        sessionKey: this.opts.sessionKey, turnKey: turn.turnKey,
      })
    } catch (error) {
      this.fence(error instanceof Error && /^CODEX_[A-Z_]+$/.test(error.message)
        ? error.message : 'CODEX_TURN_ABANDON_FAILED')
      return
    }
    this.releaseTurn(turn)
  }

  /**
   * FIFO handover: the next turn is admitted only after its predecessor ended, and it is the only
   * turn whose admission is installed as the shared child's gate.
   */
  private pumpTurns(): void {
    if (this.owner || this.stopRun !== undefined || this.failure) return
    const turn = this.queued.shift()
    if (!turn) return
    const generation = this.current()
    const admission = this.admit(turn)
    turn.admission = admission
    this.owner = turn
    this.admission = admission
    generation.child.setGate(admission)
    const held = this.gate
    this.gate = undefined
    if (held) void admission.then(() => held.resolve(), (error: Error) => held.reject(error))
    void admission.then(() => this.startLeaseRenewal(turn), () => {})
    void admission.catch((error: unknown) => {
      this.failure ??= error instanceof Error ? error : new Error('CODEX_ADMIT_FAILED')
      this.releaseTurn(turn)
    })
  }

  private releaseTurn(turn: LaneTurn): void {
    if (this.owner !== turn) return
    turn.stopLease?.()
    for (const [requestId, value] of this.turnByRequest) if (value === turn) this.turnByRequest.delete(requestId)
    this.owner = undefined
    this.admission = undefined
    this.pumpTurns()
  }

  /** Lane shutdown: no queued turn may be left waiting for an admission that will never come. */
  private abortTurns(): void {
    this.queued.length = 0
    this.turnByRequest.clear()
    const gate = this.gate
    this.gate = undefined
    gate?.reject(new Error('CODEX_LANE_CLOSED'))
    const owner = this.owner
    this.owner = undefined
    this.admission = undefined
    owner?.stopLease?.()
  }

  private async startHost(generation: LaneGeneration): Promise<LaneToolHost> {
    privateDir(this.executionRoot)
    // One host per kernel generation: the supervisor claims its profile with O_EXCL, so a host
    // recycled behind an interrupt must land in a fresh root, never reuse the old one.
    const lifecycleId = randomUUID()
    const root = join(this.executionRoot, `codex-${lifecycleId}`)
    privateDir(root)
    syncDir(this.executionRoot)
    const context = await new SubprocessRunner(this.opts).prepareRemoteToolContext()
    generation.cleanupContext = context.cleanup
    try {
      return this.laneOptions.hostFactory?.(root, lifecycleId, context.profile, context.env) ??
        new Cc5ToolHost(root, lifecycleId, context.profile, async () => {
          throw new Error('CODEX_REMOTE_PERMISSION_UNSUPPORTED')
        }, context.env)
    } catch (error) {
      context.cleanup()
      throw error
    }
  }

  /** Real tools in this container, from the same sources a local chat's CLI is started with. */
  private ensureTools(generation = this.current()): Promise<Cc5ToolCatalog> {
    return generation.toolsRun ??= this.buildTools(generation)
  }

  private async buildTools(generation: LaneGeneration): Promise<Cc5ToolCatalog> {
    const host: LaneToolHost = generation.host ?? await this.startHost(generation)
    generation.host = host
    if (!this.catalog) {
      try {
        this.bindCatalog(compileCc5ToolCatalog(await host.tools()))
      } catch (error) {
        await host.close()
        generation.host = undefined
        throw error
      }
    }
    codexNeed(this.catalog !== undefined, 'CODEX_TOOL_CATALOG_UNAVAILABLE')
    return this.catalog
  }

  /**
   * A kernel recycled inside an admitted turn (route change) must still get this turn's tools
   * executed: the fresh generation owns both the tool host and the tool pump of the live turn.
   */
  private async activate(generation: LaneGeneration): Promise<void> {
    if (this.owner === undefined || this.stopRun !== undefined || this.failure) return
    if (!this.admitted || generation.abort.signal.aborted) return
    await this.ensureTools(generation)
    if (this.stopRun !== undefined || generation.abort.signal.aborted) return
    this.startPump(generation)
  }

  /**
   * Per-turn admission, always before the kernel can write its first frame: the master only
   * provisions the node and opens both channels once it holds this turn's authority.
   */
  beginTurn(params: TurnParams): void {
    codexNeed(!params.readOnly && !params.consultTurn && !this.opts.hermeticNoTools, 'CODEX_REMOTE_READ_ONLY_UNSUPPORTED')
    codexNeed(!this.failure, this.failure?.message ?? 'CODEX_TURN_REJECTED')
    codexNeed(this.stopRun === undefined, 'CODEX_LANE_CLOSED')
    const authority = params.modelAuthority?.authorityEnvelope
    const lease = params.modelAuthority?.leaseEnvelope
    const turnKey = params.turnKey
    codexNeed(typeof authority === 'string' && typeof lease === 'string' &&
      typeof turnKey === 'string' && /^[a-f0-9]{64}$/.test(turnKey), 'CODEX_TURN_AUTHORITY_MISSING')
    codexNeed(this.queued.length < MAX_QUEUED_TURNS, 'CODEX_TURN_QUEUE_FULL')
    // Both checks are synchronous: a replayed authority must be refused before the kernel (and its
    // turn parser) exists, not asynchronously behind an admission or a queued predecessor.
    const payload = verifyAuthority(authority, this.keyring, Date.now(), { allowExpired: true })
    codexNeed(this.owner?.authorityTurnId !== payload.authorityTurnId &&
      this.queued.every((turn) => turn.authorityTurnId !== payload.authorityTurnId) &&
      this.admitted?.authorityTurnId !== payload.authorityTurnId, 'CODEX_TURN_REPLAYED')
    const turn: LaneTurn = {
      turnKey, authority, authorityTurnId: payload.authorityTurnId, payload,
      lease: { leaseEnvelope: lease }, dispatched: false, finishing: false,
    }
    if (typeof params.requestId === 'string') this.turnByRequest.set(params.requestId, turn)
    this.queued.push(turn)
    this.pumpTurns()
  }

  private async admit(turn: LaneTurn): Promise<void> {
    const leaseValue = verifyTurnLease(turn.lease.leaseEnvelope, this.keyring, Date.now())
    assertLeaseMatchesAuthority(leaseValue, turn.payload)
    // The host (and so the catalog the master publishes) exists before the admission is asked for.
    const catalog = await this.ensureTools()
    codexNeed(this.owner === turn && this.stopRun === undefined, 'CODEX_LANE_CLOSED')
    // Re-read after the await: the kernel may have recycled its generation while the host started.
    const generation = this.current()
    const binding = generation.client.currentBinding
    const payload = turn.payload
    codexNeed(payload.engine === 'codex' && payload.canonicalModel === binding.canonicalModel &&
      String(payload.uid) === binding.uid && String(payload.containerId) === binding.containerDbId &&
      sameRemoteExecutionBackend(payload.executionBackend, this.backend), 'CODEX_TURN_AUTHORITY_SCOPE_MISMATCH')
    const tools = (JSON.parse(catalog.json) as {
      tools: Array<{ name: string; inputSchema: Record<string, unknown> }>
    }).tools
    await generation.client.admit({
      authority: turn.authority, lease: turn.lease.leaseEnvelope, turnKey: turn.turnKey, catalog: { tools },
    })
    codexNeed(this.owner === turn && this.stopRun === undefined, 'CODEX_LANE_CLOSED')
    this.admitted = {
      authority: turn.authority, lease: turn.lease.leaseEnvelope, turnKey: turn.turnKey,
      authorityTurnId: payload.authorityTurnId, acceptedLeases: [turn.lease.leaseEnvelope],
    }
    this.observation.endTurn()
    // A turn already unwinding locally is about to be abandoned: no pump for it.
    if (turn.finishing) return
    await this.activate(this.current())
  }

  private startPump(generation: LaneGeneration): void {
    if (generation.pumpRun || generation.abort.signal.aborted || this.stopRun !== undefined) return
    generation.pumpRun = this.pump(generation).catch((error: unknown) => {
      this.fence(error instanceof Error ? error.message : 'CODEX_TOOL_CHANNEL_FAILED')
    })
  }

  /**
   * The master's lease window is a sliding credential, not a turn deadline: without a renewal
   * consumer every turn longer than its first window would be fenced mid-flight.
   */
  private startLeaseRenewal(turn: LaneTurn): void {
    if (this.owner !== turn || this.stopRun !== undefined) return
    const controller = new AbortController()
    let timer: NodeJS.Timeout | undefined
    const stop = (): void => {
      if (turn.stopLease !== stop) return
      turn.stopLease = undefined
      controller.abort(new Error('codex remote turn ended'))
      if (timer) clearTimeout(timer)
      timer = undefined
    }
    turn.stopLease = stop
    const schedule = (delay: number): void => {
      if (turn.stopLease !== stop || this.owner !== turn) return
      timer = setTimeout(() => { void run() }, delay)
      timer.unref()
    }
    const run = async (): Promise<void> => {
      if (this.owner !== turn || this.stopRun !== undefined) return
      try {
        const renewed = await refreshTurnModelAuthorityLease(turn.turnKey, turn.lease, {
          ...(this.laneOptions.renewLease ? { renew: this.laneOptions.renewLease } : {}),
          signal: controller.signal,
          onRetry: (error, failures) => {
            if (failures === 1 || failures % 10 === 0) {
              log.warn('codex remote turn lease renewal failed; retrying', {
                sessionKey: this.opts.sessionKey, turnKey: turn.turnKey, failures,
                err: error instanceof Error ? error.message : 'unknown',
              })
            }
          },
        })
        if (this.owner !== turn || this.stopRun !== undefined) return
        await this.publishRenewal(turn, renewed.lease)
        schedule(this.laneOptions.leaseRenewAfterMs ?? TURN_LEASE_RENEW_AFTER_MS)
      } catch (error) {
        if (this.owner !== turn || this.stopRun !== undefined) return
        // A revoked or finalized identity is never renewed again: the lane must stop, not retry.
        if (error instanceof RenewTurnLeaseError && !error.retryable) {
          this.fence(error.code)
          return
        }
        schedule(LEASE_RENEW_RETRY_MS)
      }
    }
    schedule(this.laneOptions.leaseRenewAfterMs ?? TURN_LEASE_RENEW_AFTER_MS)
  }

  private async publishRenewal(turn: LaneTurn, lease: string): Promise<void> {
    const generation = this.generation
    codexNeed(generation !== undefined && !generation.client.closed, 'CODEX_LANE_CLOSED')
    await generation!.client.renew(lease)
    // The ACK can land after this turn ended. A closed turn must never write the next turn's
    // credentials: the master already re-armed the lease, and serve() verifies signatures.
    if (this.owner !== turn || this.admitted?.turnKey !== turn.turnKey) {
      log.info('codex remote stale turn lease renewal ignored', {
        sessionKey: this.opts.sessionKey, turnKey: turn.turnKey,
      })
      return
    }
    // A `/tool/next` that was in flight when the renewal landed still carries the old lease.
    const accepted = [lease, this.admitted.lease].filter((value, index, all) => all.indexOf(value) === index)
    this.admitted = { ...this.admitted, lease, acceptedLeases: accepted }
    log.info('codex remote turn lease renewed', {
      sessionKey: this.opts.sessionKey, turnKey: turn.turnKey,
    })
  }

  private fence(reason: string): void {
    if (this.failure) return
    log.warn('codex remote lane fenced', { sessionKey: this.opts.sessionKey, reason })
    this.failure = new Error(reason)
    const generation = this.generation
    generation?.abort.abort()
    if (generation && !generation.child.killed) generation.child.kill()
    void this.stopLane().catch(() => {})
  }

  private async pump(generation: LaneGeneration): Promise<void> {
    while (!generation.abort.signal.aborted) {
      const delivery = await generation.client.toolNext()
      if (!delivery.request) {
        await pause(TOOL_IDLE_MS)
        continue
      }
      // An error here is an effect of unknown state: fence the lane, never retry.
      await this.serve(generation, delivery as CodexAdmittedIdentity & { request: Record<string, unknown> })
    }
  }

  /**
   * The master rewrites the admission lease on `/renew` before this container consumes that ACK,
   * so a legal delivery can carry a lease the local accepted list does not hold yet. Both orders
   * are accepted, but only for a lease the master signed for this exact turn — never an arbitrary
   * old credential, and never with the authority/turnKey/observation gates relaxed.
   */
  private assertDeliveryLease(delivery: CodexAdmittedIdentity, admitted: CodexAdmittedIdentity): void {
    if (delivery.lease === admitted.lease) return
    if ((admitted.acceptedLeases ?? []).includes(delivery.lease)) return
    const payload = this.owner?.payload
    codexNeed(payload !== undefined && payload.authorityTurnId === admitted.authorityTurnId,
      'CODEX_TOOL_ADMISSION_MISMATCH')
    // The master re-arms the window on every renewal; the signature and its turn binding are the
    // identity, not this process's clock.
    const lease = verifyTurnLease(delivery.lease, this.keyring, Date.now(), { allowExpired: true })
    assertLeaseMatchesAuthority(lease, payload)
  }

  private async serve(generation: LaneGeneration,
    delivery: CodexAdmittedIdentity & { request: Record<string, unknown> }): Promise<void> {
    const admitted = this.admitted
    codexNeed(admitted !== undefined && delivery.authority === admitted.authority &&
      delivery.turnKey === admitted.turnKey, 'CODEX_TOOL_ADMISSION_MISMATCH')
    this.assertDeliveryLease(delivery, admitted)
    const request = delivery.request
    const callId = request.callId
    const name = request.name
    const args = request.arguments
    codexNeed(typeof callId === 'string' && typeof name === 'string' && request.server === 'ocbridge' &&
      typeof request.inputSha256 === 'string' && request.inputSha256 === cc5ToolInputSha256(args),
      'CODEX_TOOL_REQUEST_INVALID')
    validateCc5NativeToolInput(`mcp__ocbridge__${name}`, args)
    const toolName = this.toolNames[`mcp__ocbridge__${name}`]
    codexNeed(typeof toolName === 'string', 'CODEX_TOOL_NOT_IN_CATALOG')
    // Our own stream must show the same native call before any effect is attempted.
    await this.observation.authorize({
      nativeThreadId: request.nativeThreadId as string,
      nativeTurnId: request.nativeTurnId as string,
      callId,
      server: 'ocbridge',
      name,
      arguments: args,
      inputSha256: request.inputSha256,
    })
    const host = generation.host
    codexNeed(host !== undefined && !generation.abort.signal.aborted, 'CODEX_TOOLHOST_CLOSED')
    let result: Cc5ToolResult
    try {
      result = await host.execute(toolName, args, {
        nativeSessionId: request.nativeThreadId as string,
        turnKey: admitted!.turnKey,
        toolUseId: callId,
      })
    } catch (error) {
      throw error instanceof Error && /^CC5_[A-Z_]+$/.test(error.message) ? error : new Error('CODEX_TOOL_EFFECT_UNKNOWN')
    }
    await generation.client.toolResult(callId, result)
    await generation.client.toolAck(callId)
  }

  /**
   * A transient kernel recycle (after a user cancel): this container's generation ends, the lane
   * and the node's resident app do not. The next turn admits again on a fresh client.
   */
  private async closeGeneration(generation: LaneGeneration): Promise<void> {
    generation.abort.abort()
    if (!generation.child.killed) generation.child.kill()
    return generation.closeRun ??= (async () => {
      // A host starting concurrently with shutdown still belongs to this generation.
      await generation.toolsRun?.catch(() => {})
      await generation.host?.close()
      await generation.pumpRun?.catch(() => {})
      generation.cleanupContext?.()
      this.generations.delete(generation)
    })().catch(error => { generation.closeRun = undefined; throw error })
  }

  private async recycle(): Promise<void> {
    const generation = this.generation
    if (!generation || this.stopRun !== undefined) return
    this.generation = undefined
    try { await this.closeGeneration(generation) }
    catch (error) {
      // Keep the host and its owner until a later shutdown can actually prove it stopped.
      this.failure ??= new Error('CODEX_LOCAL_STOP_UNPROVEN')
      throw error
    }
  }

  /** Kernel generations are disposable; the control connection and stop proofs are lane-owned. */
  stopLane(): Promise<void> {
    this.abortTurns()
    this.stopRun ??= (async () => {
      this.generation = undefined
      const client = this.control
      if (!client) return // no host, admission or remote effect was ever created
      const stopping = client.stop() // revoke before attempting local proof
      stopping.catch(() => {})
      let localError: unknown
      try { await Promise.all([...this.generations].map(g => this.closeGeneration(g))) }
      catch (error) { localError = error }
      if (!localError && this.admitted) await this.proveLocalStop(client, this.admitted, stopping)
      await stopping
      if (localError) throw localError
    })().catch((error) => {
      this.stopRun = undefined
      throw error
    })
    return this.stopRun
  }

  /**
   * The master accepts the local stop proof only once `/stop` has revoked the lane, and the two
   * requests race on separate sockets. The proof is idempotent, so repeat it until it lands.
   */
  private async proveLocalStop(client: CodexRelayClient, admitted: CodexAdmittedIdentity,
    stopping: Promise<void>): Promise<void> {
    let settled = false
    void stopping.then(() => { settled = true }, () => { settled = true })
    for (let attempt = 0; attempt < 200 && !settled; attempt++) {
      try {
        await client.toolStopped(admitted)
        return
      } catch {
        /* not revoked yet */
      }
      await pause(10)
    }
    await client.toolStopped(admitted).catch(() => {})
  }

  get stopped(): boolean { return this.stopRun !== undefined }
}
