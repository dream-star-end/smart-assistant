import { createHash, timingSafeEqual } from 'node:crypto'
/** Box-side task relay. It never executes the model's file/command operation. */
import { EventEmitter, once } from 'node:events'
import {
  constants,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import { dirname, join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import {
  type AuthorityKeyring,
  type ModelAuthorityPayload,
  assertLeaseMatchesAuthority,
  verifyAuthority,
  verifyTurnLease,
} from '@openclaude/protocol'
import { CC5_BRIDGE_MAX_FRAME_BYTES, type Cc5BridgeBinding, assertCc5BindingScope,
  cc5AuthorityMatchesBinding } from './cc5BridgePort.js'
import type { Cc5FinancePort, Cc5FinanceTurn, Cc5NativeTerminalReceipt } from './cc5Finance.js'
import { Cc5NativeUsageObserver } from './cc5NativeUsage.js'
import { CC5_TOOL_RECEIPT_MAX_BYTES, type Cc5ToolReceipt, assertCc5ToolResult, boundCc5ToolResult,
  cc5ToolInputSha256, cc5ToolScopeHash, validateCc5NativeToolInput, CC5_NATIVE_TOOL_NAME } from './cc5NativeTool.js'
import { CC5_PROMPT_MAX_BYTES } from './cc5ToolCatalog.js'
import { Cc5ToolObservation } from './cc5ToolObservation.js'
import type { Cc5ToolDelivery } from './cc5ToolPump.js'

export interface Cc5InteractiveHostPort {
  /** Must launch the pinned original host once; only its original READY resolves ready. */
  start(): { stdin: Writable; stdout: Readable; ready: Promise<void> }
  /** Production hosts take the lane's session profile (tool catalog + prompt) before their one launch. */
  configure?(packet: Buffer): Promise<void>
  /** Reattach to an already-launched live remote session without re-running one-shot launch. */
  attach?(): { stdin: Writable; stdout: Readable; ready: Promise<void> }
  /** Opens the session-independent tool-socket channel; must not carry session data. */
  prepare?(): Promise<void>
  /** Independent identity-checked remote stop and absence proof, including failed startup. */
  stop(): Promise<{ remoteStopped: true }>
}
type Body = Record<string, unknown>
type PendingTool = { delivery: Cc5ToolDelivery; response: ServerResponse; delivered: boolean;
  receipt?: Cc5ToolReceipt; acknowledged: boolean; ack?: Promise<void> }
function requireRelay(ok: unknown): asserts ok {
  if (!ok) throw new Error('CC5_RELAY_REJECTED')
}
/** The bridge's lane profile, re-checked here and shipped byte-exact to the node controller. */
function sessionProfile(value: unknown): { packet: Buffer; catalogSha256: string;
  toolNames: Readonly<Record<string, string>> } {
  const profile = value as { catalog?: unknown; catalogSha256?: unknown; prompt?: unknown; toolNames?: unknown }
  requireRelay(profile && typeof profile === 'object' && !Array.isArray(profile) &&
    Object.keys(profile).sort().join(',') === 'catalog,catalogSha256,prompt,toolNames' &&
    typeof profile.catalog === 'string' && Buffer.byteLength(profile.catalog) <= 1048576 &&
    profile.catalogSha256 === sha(profile.catalog) &&
    typeof profile.prompt === 'string' && Buffer.byteLength(profile.prompt) <= CC5_PROMPT_MAX_BYTES &&
    profile.toolNames && typeof profile.toolNames === 'object' && !Array.isArray(profile.toolNames))
  const tools = (JSON.parse(profile.catalog) as { tools?: Array<{ name?: unknown }> }).tools
  const toolNames = profile.toolNames as Record<string, unknown>
  requireRelay(Array.isArray(tools) && tools.length >= 1 && tools.length <= 128 &&
    Object.keys(toolNames).length === tools.length &&
    tools.every((tool) => typeof tool?.name === 'string' && Object.hasOwn(toolNames, `mcp__ocbridge__${tool.name}`) &&
      CC5_NATIVE_TOOL_NAME.test(`mcp__ocbridge__${tool.name}`)) &&
    Object.values(toolNames).every((name) => typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(name)))
  const packet = Buffer.from(JSON.stringify({ version: 1, catalog: profile.catalog,
    catalogSha256: profile.catalogSha256, prompt: profile.prompt }))
  return { packet, catalogSha256: profile.catalogSha256 as string,
    toolNames: Object.freeze({ ...toolNames }) as Readonly<Record<string, string>> }
}
function sha(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}
async function jsonBody(req: IncomingMessage, maxBytes = 131072): Promise<Body> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    requireRelay(size <= maxBytes)
    chunks.push(chunk)
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  requireRelay(body && typeof body === 'object' && !Array.isArray(body))
  return body
}
function reply(res: ServerResponse, value: unknown): void {
  if (!res.destroyed && !res.writableEnded) res.end(JSON.stringify(value))
}

export class Cc5Relay {
  readonly controlServer = createServer((req, res) => {
    void this.control(req, res).catch(() => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      res.writeHead(403)
      res.end('{"ok":false,"error":"CC5_RELAY_REJECTED"}')
    })
  })
  readonly toolServer = createServer((req, res) => {
    void this.tool(req, res).catch(() => {
      if (this.toolBurned) void this.stop().catch(() => {})
      if (res.headersSent) {
        res.destroy()
        return
      }
      res.writeHead(403)
      res.end('{"ok":false,"error":"CC5_FIXED_TOOL_FAILED_OR_UNKNOWN"}')
    })
  })
  private readonly abort = new AbortController()
  private readonly observation: Cc5ToolObservation
  private readonly nativeUsage: Cc5NativeUsageObserver
  private financeTurn?: Cc5FinanceTurn
  private effectBarrier?: Promise<void>
  private outputTail: Promise<void> = Promise.resolve()
  private queuedOutputBytes = 0
  private outputBackpressured = false
  private userSubmitted = false
  private host?: ReturnType<Cc5InteractiveHostPort['start']>
  private hostReady?: Promise<void>
  /** Bumped when a stale catalog forces a replacement launch; older hosts must not act. */
  private hostEpoch = 0
  private launchAttempted = false
  private readonly outputEvents = new EventEmitter()
  private expiry?: ReturnType<typeof setTimeout>
  private stream?: ServerResponse
  private streamClaimed = false
  private phase: 'idle' | 'admitting' | 'running' | 'settling' | 'closed' = 'idle'
  private readonly usedAuthorities = new Set<string>()
  private readonly usedRequests = new Set<string>()
  private readonly usedTurns = new Set<string>()
  private readonly usedRpcIds = new Set<string>()
  private readonly usedToolIds = new Set<string>()
  private readonly turnTools = new Map<string, PendingTool>()
  private readonly toolQueue: PendingTool[] = []
  private waitingTools = 0
  private lifecycleId?: string
  /** The catalog the remote CLI is launched with; fixed for the lane once launch is attempted. */
  private profile?: { packet: Buffer; catalogSha256: string; toolNames: Readonly<Record<string, string>> }
  private localStopped = false
  private readonly localEvents = new EventEmitter()
  private output: Buffer[] = []
  private outputBytes = 0
  private admitted?: {
    authority: string
    lease: string
    payload: ModelAuthorityPayload
    turnKey: string
    journal: string
  }
  private revoked = false
  private stopPromise?: Promise<{ remoteStopped: true }>
  private userSeen = false
  private lastSequence = 0
  private lastHash?: string
  private toolBurned = false
  private pending?: PendingTool
  private poll?: { response: ServerResponse; timer: ReturnType<typeof setTimeout> }
  private bindingExpiresAt: number
  private interruptedTurn = false
  private streamGeneration = 0
  private outSeq = 0
  private readonly outputHistory: Array<{ seq: number; bytes: Buffer }> = []
  private outputHistoryBytes = 0
  private needsReattach = false
  /** One lane start at a time: `none` → `preparing` → `launched`, all before any user frame. */
  private launchStage: 'none' | 'preparing' | 'launched' = 'none'
  /** Bumped for every lane profile; preparation re-runs until the launch uses the newest one. */
  private profileEpoch = 0

  constructor(
    private binding: Readonly<Cc5BridgeBinding>,
    private readonly keyring: AuthorityKeyring,
    private readonly runId: string,
    private hostPort: Cc5InteractiveHostPort,
    private readonly journalRoot: string,
    private readonly finance: Cc5FinancePort,
    private readonly options: {
      localStopTimeoutMs?: number
      slidingTtlMs?: number
      onBindingExtended?: (expiresAt: number) => void
      recoverExistingJournal?: boolean
      /** The remote target's CLI model; native usage frames are held to exactly this model. */
      upstreamModel?: string
      /** Builds the transport for a replacement launch when a cached catalog turns out stale. */
      replaceHost?: () => Cc5InteractiveHostPort
    } = {},
  ) {
    assertCc5BindingScope(binding)
    requireRelay(keyring.size > 0 && /^[a-f0-9-]{36}$/.test(runId) &&
      binding.runId === runId && typeof finance?.admit === 'function')
    this.bindingExpiresAt = binding.expiresAt
    this.nativeUsage = new Cc5NativeUsageObserver(binding, { upstreamModel: options.upstreamModel })
    this.observation = new Cc5ToolObservation(binding.operationId)
    if (options.recoverExistingJournal && existsSync(journalRoot)) {
      const st = lstatSync(journalRoot)
      requireRelay(
        st.isDirectory() &&
          !st.isSymbolicLink() &&
          st.uid === process.getuid?.() &&
          (st.mode & 0o077) === 0,
      )
      const recoveredReceipts: Cc5NativeTerminalReceipt[] = []
      let maxInputSeq = 0
      let maxInputHash: string | undefined
      for (const entry of readdirSync(journalRoot)) {
        if (entry === 'local-stopped.json') {
          this.localStopped = true
        } else if (entry === 'local-registered.json' || /^local-registered-[a-f0-9-]{36}\.json$/.test(entry)) {
          const reg = JSON.parse(readFileSync(join(journalRoot, entry), 'utf8')) as {
            lifecycleId?: string
          }
          requireRelay(
            typeof reg?.lifecycleId === 'string' &&
              /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(reg.lifecycleId),
          )
          this.lifecycleId = reg.lifecycleId
          this.launchAttempted = true
        } else if (/^[a-f0-9]{32}$/.test(entry)) {
          const turnDir = join(journalRoot, entry)
          const turnSt = lstatSync(turnDir)
          requireRelay(
            turnSt.isDirectory() &&
              !turnSt.isSymbolicLink() &&
              turnSt.uid === process.getuid?.() &&
              (turnSt.mode & 0o077) === 0 &&
              existsSync(join(turnDir, 'admission.json')),
          )
          const adm = JSON.parse(readFileSync(join(turnDir, 'admission.json'), 'utf8')) as {
            authorityTurnId?: string
            turnKey?: string
            billingRequestId?: string
          }
          requireRelay(
            adm?.authorityTurnId === entry &&
              typeof adm.turnKey === 'string' &&
              adm.turnKey.length > 0 &&
              typeof adm.billingRequestId === 'string' &&
              adm.billingRequestId.length > 0,
          )
          this.usedAuthorities.add(adm.authorityTurnId)
          this.usedTurns.add(adm.turnKey)
          this.usedRequests.add(adm.billingRequestId)
          this.launchAttempted = true
          const hasNativeTerminal = existsSync(join(turnDir, 'native-terminal.json'))
          const hasTerminalProven = existsSync(join(turnDir, 'terminal-proven.json'))
          if (hasNativeTerminal && hasTerminalProven) {
            const term = JSON.parse(
              readFileSync(join(turnDir, 'native-terminal.json'), 'utf8'),
            ) as Cc5NativeTerminalReceipt
            const proven = JSON.parse(readFileSync(join(turnDir, 'terminal-proven.json'), 'utf8')) as {
              requestId?: string
              resultSha256?: string
            }
            requireRelay(
              proven?.requestId === adm.billingRequestId &&
                proven?.resultSha256 === term?.resultSha256 &&
                term?.version === 2 &&
                term.authorityTurnId === adm.authorityTurnId &&
                term.turnKey === adm.turnKey,
            )
            recoveredReceipts.push(term)
          } else {
            // Interrupted turn before terminal settlement: allow recovery if attachable and no dangling tool attempt
            requireRelay(!hasTerminalProven)
          }
          if (existsSync(join(turnDir, 'dispatch.json'))) {
            const disp = JSON.parse(readFileSync(join(turnDir, 'dispatch.json'), 'utf8')) as {
              sequence?: number
              hash?: string
            }
            requireRelay(
              typeof disp?.sequence === 'number' &&
                Number.isSafeInteger(disp.sequence) &&
                disp.sequence >= 1 &&
                typeof disp?.hash === 'string' &&
                /^[a-f0-9]{64}$/.test(disp.hash),
            )
            if (disp.sequence > maxInputSeq) {
              maxInputSeq = disp.sequence
              maxInputHash = disp.hash
            }
          }
          const turnFiles = readdirSync(turnDir)
          for (const f of turnFiles) {
            if (f.startsWith('tool-') && f.endsWith('-attempt.json')) {
              const completedName = f.replace(/-attempt\.json$/, '-completed.json')
              requireRelay(turnFiles.includes(completedName))
            }
            if (f.startsWith('tool-') && f.endsWith('-completed.json')) {
              const tr = JSON.parse(readFileSync(join(turnDir, f), 'utf8')) as {
                rpcId?: string | number
                toolUseId?: string
              }
              if (tr?.rpcId !== undefined) this.usedRpcIds.add(`${typeof tr.rpcId}:${tr.rpcId}`)
              if (typeof tr?.toolUseId === 'string') this.usedToolIds.add(tr.toolUseId)
            }
          }
        } else {
          requireRelay(false)
        }
      }
      requireRelay(!this.localStopped)
      if (this.launchAttempted || recoveredReceipts.length > 0) {
        // An already-launched session cannot be re-launched via one-shot start(); hostPort MUST support attach().
        requireRelay(typeof this.hostPort.attach === 'function')
        if (recoveredReceipts.length > 0) {
          this.nativeUsage.restoreFromReceipts(recoveredReceipts)
          this.observation.restoreSession(recoveredReceipts[0]!.nativeSessionId, this.usedToolIds)
        }
        this.lastSequence = maxInputSeq
        this.lastHash = maxInputHash
        this.needsReattach = true
      }
    } else {
      mkdirSync(journalRoot, { mode: 0o700, recursive: false })
      const st = lstatSync(journalRoot)
      requireRelay(st.isDirectory() && st.uid === process.getuid?.() && (st.mode & 0o077) === 0)
    }
    const parent = openSync(
      dirname(journalRoot),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
    try {
      fsyncSync(parent)
    } finally {
      closeSync(parent)
    }
    this.armExpiry(this.bindingExpiresAt)
  }
  private slideBindingExpiry(): number {
    if (this.options.slidingTtlMs && this.options.slidingTtlMs > 0) {
      const next = Math.max(this.bindingExpiresAt, Date.now() + this.options.slidingTtlMs)
      if (next > this.bindingExpiresAt) {
        const nextBinding = Object.freeze({ ...this.binding, expiresAt: next })
        this.options.onBindingExtended?.(next)
        this.binding = nextBinding
        this.bindingExpiresAt = next
      }
    }
    return this.bindingExpiresAt
  }
  private record(name: string, value: unknown, root = this.admitted?.journal ?? this.journalRoot): void {
    const fd = openSync(
      join(root, name),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    )
    try {
      writeFileSync(fd, JSON.stringify(value))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    const dir = openSync(
      root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
    try {
      fsyncSync(dir)
    } finally {
      closeSync(dir)
    }
  }
  private scope(body: Body, allowExpired = false): void {
    requireRelay(typeof body.capability === 'string' && /^[a-f0-9]{64}$/.test(body.capability))
    requireRelay(
      timingSafeEqual(Buffer.from(body.capability), Buffer.from(this.binding.capability)) &&
        body.uid === this.binding.uid &&
        body.containerDbId === this.binding.containerDbId &&
        body.dockerId === this.binding.dockerId &&
        body.operationId === this.binding.operationId &&
        body.sessionKey === this.binding.sessionKey &&
        (allowExpired || (!this.revoked && this.bindingExpiresAt > Date.now())),
    )
  }
  private verify(authority: string, lease: string, allowExpired = false): ModelAuthorityPayload {
    const now = Date.now()
    const a = verifyAuthority(authority, this.keyring, now, { allowExpired })
    assertLeaseMatchesAuthority(verifyTurnLease(lease, this.keyring, now), a)
    requireRelay(
      cc5AuthorityMatchesBinding(this.binding, a),
    )
    return a
  }
  private armExpiry(expiresAt: number): void {
    clearTimeout(this.expiry)
    this.expiry = setTimeout(
      () => {
        void this.stop().catch(() => {})
      },
      Math.max(0, Math.min(this.bindingExpiresAt, expiresAt) - Date.now()),
    )
    this.expiry.unref()
  }
  private bindHostStreams(host: ReturnType<Cc5InteractiveHostPort['start']>,
    epoch = this.hostEpoch): void {
    const stdin = host.stdin
    // A replaced host is stopped on purpose; its dying streams must not stop the relay.
    const current = (): boolean => epoch === this.hostEpoch
    const inputFailed = (): void => {
      if (current()) void this.stop().catch(() => {})
    }
    stdin.on('error', inputFailed)
    stdin.once('close', () => {
      inputFailed()
      stdin.removeListener('error', inputFailed)
    })
    host.stdout.on('data', (chunk: Buffer) => {
      if (this.revoked || !current()) return
      this.host!.stdout.pause()
      const bytes = Buffer.from(chunk)
      this.queuedOutputBytes += bytes.length
      this.outputTail = this.outputTail.then(async () => {
        if (!current()) {
          this.queuedOutputBytes -= bytes.length
          return
        }
        requireRelay(!this.revoked && this.queuedOutputBytes <= CC5_BRIDGE_MAX_FRAME_BYTES)
        const frames = this.nativeUsage.ingest(bytes)
        // Validate the entire complete chunk before a waiter can authorize a tool.
        this.observation.ingest(bytes)
        this.outputEvents.emit('data')
        for (const frame of frames) {
          requireRelay(!this.revoked)
          if (frame.receipt) {
            requireRelay(
              this.phase === 'running' &&
                this.userSeen &&
                this.financeTurn &&
                this.admitted &&
                frame.receipt.version === 2 &&
                frame.receipt.authorityTurnId === this.admitted.payload.authorityTurnId &&
                frame.receipt.turnKey === this.admitted.turnKey &&
                this.waitingTools === 0 &&
                this.toolQueue.length === 0 &&
                this.observation.toolUseIds.every((id) => this.turnTools.get(id)?.receipt),
            )
            this.verify(this.admitted.authority, this.admitted.lease, true)
            this.phase = 'settling'
            await Promise.all(
              [...this.turnTools.values()].map((tool) => {
                requireRelay(tool.receipt && tool.ack)
                return tool.ack
              }),
            )
            requireRelay([...this.turnTools.values()].every((tool) => tool.acknowledged) && !this.pending)
            this.record('native-terminal.json', frame.receipt)
            const outcome = await this.financeTurn.terminal(frame.receipt)
            requireRelay(outcome.state === 'proven' && outcome.requestId === this.admitted.payload.billingRequestId)
            this.record('terminal-proven.json', {
              requestId: outcome.requestId,
              resultSha256: frame.receipt.resultSha256,
            })
            requireRelay(!this.revoked)
            this.observation.endTurn()
            this.interruptedTurn = false
            this.phase = 'idle'
            this.armExpiry(this.bindingExpiresAt)
          }
          requireRelay(!this.revoked)
          this.publishOutput(frame.bytes)
        }
        this.queuedOutputBytes -= bytes.length
        if (!this.revoked && !this.outputBackpressured) this.host?.stdout.resume()
      }).catch(() => { void this.stop().catch(() => {}) })
    })
    host.stdout.once('end', () => {
      if (!current()) return
      void this.outputTail.then(() => {
        this.nativeUsage.finish()
        this.observation.finish()
      }).finally(() => this.stop()).catch(() => {})
    })
    host.stdout.once('error', () => {
      if (current()) void this.stop().catch(() => {})
    })
  }
  attachRecoveredHost(): void {
    if (!this.needsReattach) return
    requireRelay(!this.revoked && !this.hostReady && typeof this.hostPort.attach === 'function')
    this.launchAttempted = true
    this.needsReattach = false
    this.host = this.hostPort.attach()
    this.bindHostStreams(this.host)
    this.hostReady = Promise.resolve().then(async () => {
      await this.host!.ready
      requireRelay(!this.revoked)
    })
    void this.hostReady.catch(() => {
      void this.stop().catch(() => {})
    })
  }
  private ensureHost(): Promise<void> {
    if (this.hostReady) return this.hostReady
    requireRelay(!this.revoked)
    if (this.needsReattach) {
      this.attachRecoveredHost()
      return this.hostReady!
    }
    // Publish the joining promise BEFORE invoking start, even if start throws after spawning.
    const epoch = this.hostEpoch
    this.hostReady = Promise.resolve().then(async () => {
      requireRelay(!this.revoked && this.admitted && this.financeTurn && (this.profile || !this.hostPort.configure))
      this.launchAttempted = true
      this.launchStage = 'preparing'
      for (;;) {
        const prepared = await this.prepareLane(this.hostPort, false)
        requireRelay(!this.revoked && epoch === this.hostEpoch)
        if (prepared !== this.profileEpoch) continue
        // From here to start() there is no await: no profile can slip in after the last check.
        this.launchStage = 'launched'
        const host = this.hostPort.start()
        this.host = host
        this.bindHostStreams(host, epoch)
        break
      }
      await this.host.ready
      requireRelay(!this.revoked && epoch === this.hostEpoch)
    })
    void this.hostReady.catch(() => {
      if (epoch === this.hostEpoch) void this.stop().catch(() => {})
    })
    return this.hostReady
  }
  /** The host the stream will write to: a replacement launch extends what a stream must wait for. */
  private async waitForHost(): Promise<void> {
    for (;;) {
      const ready = this.hostReady ?? this.ensureHost()
      try {
        await ready
      } catch (error) {
        // A replaced host is stopped on purpose; only the current host's failure ends the stream.
        if (ready === this.hostReady) throw error
        continue
      }
      if (ready === this.hostReady) return
    }
  }
  /** The lane's remote preparation, in the one order the node controller accepts.
   *
   *  A fresh root has no installed session, and the controller validates that profile before it
   *  execs the tool-socket helper: `session-profile` must come first there. An already-launched
   *  round keeps its LIFECYCLE record as stop proof, and `session-profile` refuses while that
   *  record exists; only tool-socket's rotate proves the old round gone and clears it. The socket
   *  helper reads the catalog per request, so a later profile install still reaches it.
   *  A live catalog that arrives mid-way re-runs the pass before the launch. Returns the profile
   *  generation this pass installed; the caller launches only if no newer one has arrived. */
  private async prepareLane(host: Cc5InteractiveHostPort, replacement: boolean): Promise<number> {
    for (;;) {
      const generation = this.profileEpoch
      const profile = this.profile
      requireRelay(profile || !host.configure)
      if (replacement) {
        await host.prepare?.()
        requireRelay(!this.revoked)
        if (generation !== this.profileEpoch) continue
        if (profile && host.configure) await host.configure(profile.packet)
      } else {
        if (profile && host.configure) await host.configure(profile.packet)
        requireRelay(!this.revoked)
        // No socket for a stale catalog: re-install the newest profile first.
        if (generation !== this.profileEpoch) continue
        await host.prepare?.()
      }
      requireRelay(!this.revoked)
      if (generation === this.profileEpoch) return generation
    }
  }
  /** A live catalog found the registered one stale. Still preparing: the running start sequence
   *  re-installs this profile before it launches. Already launched: the remote runs the old
   *  catalog and is replaced. After the user frame neither is possible. */
  private adoptLaneProfile(profile: { packet: Buffer; catalogSha256: string;
    toolNames: Readonly<Record<string, string>> }): Promise<void> {
    requireRelay(this.launchAttempted && !this.needsReattach && !this.userSeen &&
      (this.phase === 'admitting' || this.phase === 'running') && !this.revoked)
    if (this.launchStage === 'launched') return this.replaceLaunchedHost(profile)
    this.profile = profile
    this.profileEpoch++
    // The start sequence in flight sees the epoch and re-installs before it launches; the stream
    // gates the user frame on that same launch, so nothing is dispatched with the old catalog.
    return Promise.resolve()
  }
  /** The cached catalog was stale, so the remote runs the wrong tool set. Replace it inside this
   *  admitted turn: nothing was dispatched yet, so no prompt or result can be lost. */
  private replaceLaunchedHost(profile: { packet: Buffer; catalogSha256: string;
    toolNames: Readonly<Record<string, string>> }): Promise<void> {
    const factory = this.options.replaceHost
    requireRelay(typeof factory === 'function' && this.launchStage === 'launched' && !this.needsReattach &&
      !this.userSeen && (this.phase === 'admitting' || this.phase === 'running') && !this.revoked)
    const epoch = ++this.hostEpoch
    const previous = this.hostPort
    this.profile = profile
    this.profileEpoch++
    this.launchStage = 'preparing'
    const replacement = (async () => {
      // Independent absence proof for the wrongly launched session before a second one exists.
      await previous.stop()
      requireRelay(!this.revoked && epoch === this.hostEpoch)
      const next = factory!()
      this.hostPort = next
      for (;;) {
        const prepared = await this.prepareLane(next, true)
        requireRelay(!this.revoked && epoch === this.hostEpoch)
        if (prepared !== this.profileEpoch) continue
        this.launchStage = 'launched'
        const host = next.start()
        this.host = host
        this.bindHostStreams(host, epoch)
        break
      }
    })()
    // Published before the old host can reject: a stream waiting on it waits for the replacement.
    // The registering bridge only waits for the launch; streams and admission wait for READY.
    this.hostReady = replacement.then(async () => {
      await this.host!.ready
      requireRelay(!this.revoked && epoch === this.hostEpoch)
    })
    void this.hostReady.catch(() => {
      if (epoch === this.hostEpoch) void this.stop().catch(() => {})
    })
    return replacement
  }

  private publishOutput(bytes: Buffer): void {
    const seq = ++this.outSeq
    this.outputHistory.push({ seq, bytes })
    this.outputHistoryBytes += bytes.length
    while (
      this.outputHistory.length > 1 &&
      (this.outputHistoryBytes > 2 * 1024 * 1024 || this.outputHistory.length > 512)
    ) {
      const evicted = this.outputHistory.shift()!
      this.outputHistoryBytes -= evicted.bytes.length
    }
    if (this.stream?.headersSent) {
      if (!this.stream.write(bytes)) this.outputBackpressured = true
    } else {
      this.outputBytes += bytes.length
      requireRelay(this.outputBytes <= CC5_BRIDGE_MAX_FRAME_BYTES)
      this.output.push(bytes)
    }
  }
  private interruptActiveTurn(writeControlFrame = true): void {
    if (this.phase !== 'running' && this.phase !== 'settling') return
    const firstInterrupt = !this.interruptedTurn
    this.interruptedTurn = true
    this.nativeUsage.interruptTurn()
    if (firstInterrupt && writeControlFrame && this.host) {
      const req = {
        type: 'control_request',
        request_id: `int-${Date.now()}`,
        request: { subtype: 'interrupt' },
      }
      try {
        this.host.stdin.write(`${JSON.stringify(req)}\n`)
      } catch {}
    }
  }

  /** Revoked relays never serve another turn; the owner must replace the lane. */
  get stopped(): boolean {
    return this.revoked
  }
  stop(): Promise<{ remoteStopped: true }> {
    if (this.stopPromise) return this.stopPromise
    this.revoked = true
    this.phase = 'closed'
    clearTimeout(this.expiry)
    this.abort.abort()
    if (this.poll) {
      clearTimeout(this.poll.timer)
      this.poll.response.destroy()
      this.poll = undefined
    }
    this.pending?.response.destroy()
    for (const tool of this.toolQueue) tool.response.destroy()
    // Wake the bridge before waiting for its independent local descendant proof.
    this.stream?.end()
    this.stopPromise = Promise.resolve()
      .then(async () => {
        await this.effectBarrier?.catch(() => {})
        let remoteStopped = !this.launchAttempted
        try {
          const remote = this.launchAttempted ? this.hostPort.stop().then((r) => r.remoteStopped === true) : Promise.resolve(true)
          const local = this.waitForLocalStop()
          const proofs = await Promise.allSettled([remote, local])
          remoteStopped = proofs.every((proof) => proof.status === 'fulfilled' && proof.value === true)
          requireRelay(remoteStopped)
        } finally {
          await this.financeTurn?.stop({ hostStartAttempted: this.launchAttempted,
            userSubmitted: this.userSubmitted, remoteStopped })
        }
        this.stream?.end()
        return { remoteStopped: true as const }
      })
      .catch((error) => {
        this.stream?.destroy()
        throw error
      })
    return this.stopPromise
  }
  private async waitForLocalStop(): Promise<true> {
    if (!this.lifecycleId || this.localStopped) return true
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        once(this.localEvents, 'stopped'),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('CC5_LOCAL_STOP_UNPROVEN')), this.options.localStopTimeoutMs ?? 5000)
        }),
      ])
      requireRelay(this.localStopped)
      return true
    } finally { clearTimeout(timer) }
  }
  private async control(req: IncomingMessage, res: ServerResponse): Promise<void> {
    requireRelay(req.method === 'POST')
    if (req.url === '/session/open') return this.open(req, res)
    // A receipt carries one bounded tool result plus its identifiers and scope.
    const body = await jsonBody(req, req.url === '/tool/result' ? CC5_TOOL_RECEIPT_MAX_BYTES
      : req.url === '/tool/register' ? 4 * 1024 * 1024 : 131072)
    this.scope(body, req.url === '/stop' || req.url === '/tool/stopped')
    if (req.url === '/stop') {
      reply(res, { ok: true, ...(await this.stop()) })
      return
    }
    if (req.url === '/interrupt') {
      this.interruptActiveTurn(true)
      reply(res, { ok: true, interrupted: true, phase: this.phase })
      return
    }
    if (req.url === '/tool/register') {
      requireRelay((!this.lifecycleId || body.replace === true) && typeof body.lifecycleId === 'string' &&
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(body.lifecycleId))
      const profile = body.profile === undefined ? undefined : sessionProfile(body.profile)
      requireRelay(profile || !this.hostPort.configure)
      requireRelay(body.relaunch === undefined || (body.relaunch === true && profile !== undefined))
      const isInitial = !this.lifecycleId
      this.lifecycleId = body.lifecycleId
      let replaced = false
      if (profile && !this.launchAttempted) this.profile = profile
      else if (body.relaunch === true) {
        // A replacement keeps the same lifecycle id; its registration is already journaled.
        replaced = true
        if (profile && profile.catalogSha256 !== this.profile?.catalogSha256) await this.adoptLaneProfile(profile)
      }
      this.localStopped = false
      if (!replaced) {
        this.record(
          isInitial ? 'local-registered.json' : `local-registered-${this.lifecycleId}.json`,
          { lifecycleId: this.lifecycleId },
          this.journalRoot,
        )
      }
      reply(res, { ok: true, lifecycleId: this.lifecycleId, toolNames: this.profile?.toolNames ?? null })
    } else if (req.url === '/tool/stopped') {
      requireRelay(this.lifecycleId && body.lifecycleId === this.lifecycleId && body.localStopped === true)
      if (!this.localStopped) {
        this.record('local-stopped.json', { lifecycleId: this.lifecycleId, localStopped: true }, this.journalRoot)
        this.localStopped = true
        this.localEvents.emit('stopped')
      }
      reply(res, { ok: true, lifecycleId: this.lifecycleId, localStopped: true })
      if (!this.revoked) void this.stop().catch(() => {})
    } else if (req.url === '/admit') {
      requireRelay(
        this.phase === 'idle' && !this.pending && !this.waitingTools && !this.toolQueue.length &&
          !this.localStopped && this.usedTurns.size < 10000 &&
          typeof body.authority === 'string' &&
          typeof body.lease === 'string' &&
          typeof body.turnKey === 'string' &&
          body.turnKey.length > 0 &&
          body.turnKey.length <= 512,
      )
      const payload = this.verify(body.authority, body.lease)
      requireRelay(/^[a-f0-9]{32}$/.test(payload.authorityTurnId) && typeof payload.billingRequestId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(payload.billingRequestId) &&
        !this.usedAuthorities.has(payload.authorityTurnId) && !this.usedRequests.has(payload.billingRequestId) &&
        !this.usedTurns.has(body.turnKey))
      this.phase = 'admitting' // Burn before the first asynchronous finance/effect boundary.
      this.usedAuthorities.add(payload.authorityTurnId)
      this.usedRequests.add(payload.billingRequestId)
      this.usedTurns.add(body.turnKey)
      try {
        const journal = join(this.journalRoot, payload.authorityTurnId)
        mkdirSync(journal, { mode: 0o700, recursive: false })
        const parent = openSync(this.journalRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        try { fsyncSync(parent) } finally { closeSync(parent) }
        this.admitted = { authority: body.authority, lease: body.lease, payload, turnKey: body.turnKey, journal }
        this.record('admission.json', {
          authorityTurnId: payload.authorityTurnId,
          turnKey: body.turnKey,
          billingRequestId: payload.billingRequestId,
        })
        const expiresAt = this.slideBindingExpiry()
        this.financeTurn = await this.finance.admit({ binding: this.binding,
          authorityEnvelope: body.authority, leaseEnvelope: body.lease,
          turnKey: body.turnKey, sessionKey: this.binding.sessionKey })
        if (this.revoked) {
          await this.financeTurn.stop({ hostStartAttempted: false, userSubmitted: false, remoteStopped: true })
          throw new Error('CC5_RELAY_REJECTED')
        }
        this.userSeen = false
        this.userSubmitted = false
        this.interruptedTurn = false
        this.turnTools.clear()
        this.observation.beginTurn()
        this.nativeUsage.beginTurn({ authorityTurnId: payload.authorityTurnId, turnKey: body.turnKey })
        this.armExpiry(verifyTurnLease(body.lease, this.keyring, Date.now()).expiresAt)
        // The per-turn marker also fences reuse of an already-running native worker.
        this.effectBarrier = this.financeTurn.beforeHostStart()
        await this.effectBarrier
        // A first launch waits for the bridge's catalog: its /session/open starts the host.
        if (!this.hostPort.configure || this.profile || this.launchAttempted || this.needsReattach) await this.waitForHost()
        this.verify(body.authority, body.lease)
        requireRelay(!this.revoked)
        this.phase = 'running'
        reply(res, { ok: true, ready: true, admissionHash: sha(`${body.authority}\0${body.lease}`), expiresAt })
      } catch (error) { void this.stop().catch(() => {}); throw error }
    } else if (req.url === '/renew') {
      requireRelay(this.admitted && (this.phase === 'running' || this.phase === 'settling') && typeof body.lease === 'string')
      this.verify(this.admitted.authority, body.lease, true)
      this.admitted.lease = body.lease
      const expiresAt = this.slideBindingExpiry()
      this.armExpiry(verifyTurnLease(body.lease, this.keyring, Date.now()).expiresAt)
      reply(res, { ok: true, expiresAt })
    } else if (req.url === '/tool/next') {
      requireRelay(this.lifecycleId && !this.localStopped && !this.poll && !this.pending?.delivered)
      this.poll = {
        response: res,
        timer: setTimeout(() => {
          this.poll = undefined
          reply(res, { ok: true, delivery: null })
        }, 25000),
      }
      res.once('close', () => {
        if (this.poll?.response === res) {
          clearTimeout(this.poll.timer)
          this.poll = undefined
        }
      })
      this.deliver()
    } else if (req.url === '/tool/result') {
      requireRelay(this.phase === 'running' && this.pending?.delivered && this.admitted && !this.pending.receipt)
      this.verify(this.admitted.authority, this.admitted.lease, true)
      const pending = this.pending
      const receipt = body.receipt as Cc5ToolReceipt
      // The wire receiver truncates instead of breaking the turn; the strict
      // shape/scope checks below still decide whether the receipt is admitted.
      if (receipt && typeof receipt === 'object' && !Array.isArray(receipt))
        receipt.result = boundCc5ToolResult(receipt.result)
      const tool = pending.delivery.request
      assertCc5ToolResult(receipt?.result)
      requireRelay(
        receipt?.version === 2 &&
          receipt.dockerId === this.binding.dockerId &&
          receipt.containerDbId === this.binding.containerDbId &&
          receipt.operationId === tool.operationId &&
          receipt.nativeSessionId === tool.nativeSessionId &&
          receipt.toolUseId === tool.toolUseId &&
          typeof receipt.rpcId === typeof tool.rpcId &&
          receipt.rpcId === tool.rpcId &&
          /^[a-f0-9-]{36}$/.test(receipt.commandId) &&
          receipt.name === tool.name && receipt.inputSha256 === cc5ToolInputSha256(tool.arguments) &&
          receipt.scopeHash === cc5ToolScopeHash(tool, pending.delivery.admission) &&
          Number.isSafeInteger(receipt.completedAt) && receipt.completedAt > 0 && receipt.completedAt <= Date.now() + 1000,
      )
      this.record(`tool-${sha(tool.toolUseId)}-completed.json`, receipt)
      pending.receipt = structuredClone(receipt)
      pending.ack = new Promise<void>((resolve, reject) => {
        res.once('finish', () => {
          pending.acknowledged = true
          if (this.pending === pending) this.pending = undefined
          this.deliver()
          resolve()
        })
        res.once('close', () => {
          if (!res.writableFinished) { reject(new Error('CC5_TOOL_RESULT_ACK_UNKNOWN')); void this.stop().catch(() => {}) }
        })
      })
      void pending.ack.catch(() => {})
      reply(pending.response, {
        version: 2,
        ok: true,
        runId: this.runId,
        rpcId: tool.rpcId,
        toolUseId: tool.toolUseId,
        operationId: tool.operationId,
        name: tool.name,
        inputSha256: receipt.inputSha256,
        result: receipt.result,
      })
      reply(res, { ok: true, commandId: receipt.commandId })
      await pending.ack
      if (this.pending === pending) this.pending = undefined
      this.deliver()
    } else throw new Error('CC5_RELAY_REJECTED')
  }
  private static isRecoverableTransportError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false
    const code = (error as { code?: string }).code
    const msg = (error as { message?: string }).message ?? ''
    return (
      code === 'ECONNRESET' ||
      code === 'EPIPE' ||
      code === 'ECONNABORTED' ||
      code === 'ERR_STREAM_PREMATURE_CLOSE' ||
      code === 'ERR_STREAM_DESTROYED' ||
      msg === 'aborted' ||
      msg === 'Premature close'
    )
  }
  private async open(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let buffer = ''
    let opened = false
    let protocolFailed = false
    let myGeneration = -1
    try {
      for await (const chunk of req) {
        try {
          buffer += chunk.toString('utf8')
          requireRelay(Buffer.byteLength(buffer) <= CC5_BRIDGE_MAX_FRAME_BYTES * 2)
          let at: number
          while ((at = buffer.indexOf('\n')) >= 0) {
            const body = JSON.parse(buffer.slice(0, at)) as Body
            buffer = buffer.slice(at + 1)
            if (!opened) {
              requireRelay(body.type === 'open' && this.admitted && this.financeTurn)
              this.scope(body)
              let nextGen = this.streamGeneration
              if (body.generation !== undefined) {
                requireRelay(
                  typeof body.generation === 'number' &&
                    Number.isSafeInteger(body.generation) &&
                    (this.streamClaimed
                      ? body.generation > this.streamGeneration
                      : body.generation >= this.streamGeneration),
                )
                nextGen = body.generation
              } else {
                requireRelay(!this.streamClaimed)
              }
              let hasLastAcked = false
              let lastAckedSeq = 0
              if (body.lastAckedSeq !== undefined) {
                requireRelay(
                  typeof body.lastAckedSeq === 'number' &&
                    Number.isSafeInteger(body.lastAckedSeq) &&
                    body.lastAckedSeq >= 0 &&
                    body.lastAckedSeq <= this.outSeq,
                )
                const minRetainedSeq =
                  this.outputHistory.length > 0 ? this.outputHistory[0]!.seq : this.outSeq + 1
                if (body.lastAckedSeq + 1 < minRetainedSeq) {
                  if (!res.headersSent) {
                    res.writeHead(409, { 'content-type': 'application/json' })
                    res.end('{"ok":false,"error":"CC5_STREAM_SEQ_GAP"}')
                  }
                  return
                }
                hasLastAcked = true
                lastAckedSeq = body.lastAckedSeq
              }
              const prevStream = this.stream
              this.streamGeneration = nextGen
              myGeneration = nextGen
              this.streamClaimed = true
              this.stream = res
              opened = true
              if (prevStream && prevStream !== res) {
                try {
                  prevStream.end()
                } catch {}
              }
              await this.waitForHost()
              if (myGeneration !== this.streamGeneration || this.stream !== res) return
              res.writeHead(200, {
                'x-cc5-interactive-ready': '1',
                'x-cc5-stream-generation': String(this.streamGeneration),
                'x-cc5-out-seq': String(this.outSeq),
              })
              res.flushHeaders()
              if (hasLastAcked) {
                for (const item of this.outputHistory) {
                  if (item.seq > lastAckedSeq) res.write(item.bytes)
                }
              } else {
                for (const raw of this.output) res.write(raw)
              }
              this.output = []
              this.outputBytes = 0
              res.on('drain', () => {
                if (myGeneration !== this.streamGeneration || this.stream !== res) return
                this.outputBackpressured = false
                if (!this.revoked && this.queuedOutputBytes === 0) this.host?.stdout.resume()
              })
            } else {
              if (myGeneration !== this.streamGeneration || this.stream !== res) return
              await this.input(body)
            }
          }
        } catch (innerErr) {
          if (!opened || myGeneration === this.streamGeneration) {
            protocolFailed = true
          }
          throw innerErr
        }
      }
      if (buffer.length > 0 && (!opened || myGeneration === this.streamGeneration)) {
        protocolFailed = true
        throw new Error('CC5_RELAY_REJECTED')
      }
    } catch (error) {
      if (opened && !protocolFailed && Cc5Relay.isRecoverableTransportError(error)) {
        // Recoverable client stream disconnect (e.g. ECONNRESET / aborted): detach without stopping host.
        return
      }
      if (!opened || myGeneration === this.streamGeneration) {
        protocolFailed = true
        throw error
      }
    } finally {
      if (opened && myGeneration === this.streamGeneration) {
        if (protocolFailed || this.revoked) {
          await this.stop()
        } else if (this.stream === res) {
          this.stream = undefined
          this.streamClaimed = false
        }
      }
    }
  }
  private async input(body: Body): Promise<void> {
    requireRelay(this.admitted && this.host && !this.revoked && this.bindingExpiresAt > Date.now())
    this.verify(this.admitted.authority, this.admitted.lease, true)
    requireRelay(
      Number.isSafeInteger(body.seq) &&
        typeof body.bytes === 'string' &&
        typeof body.hash === 'string',
    )
    const bytes = Buffer.from(body.bytes, 'base64')
    requireRelay(
      bytes.length <= CC5_BRIDGE_MAX_FRAME_BYTES &&
        bytes.toString('base64') === body.bytes &&
        sha(bytes) === body.hash &&
        bytes.at(-1) === 10,
    )
    if (body.seq === this.lastSequence && body.hash === this.lastHash) return
    requireRelay(body.seq === this.lastSequence + 1)
    const frame = JSON.parse(bytes.toString('utf8'))
    if (frame.type === 'user') {
      requireRelay(
        this.phase === 'running' && !this.userSeen &&
          frame.message?.role === 'user' &&
          (typeof frame.message.content === 'string' ||
            (Array.isArray(frame.message.content) &&
              frame.message.content.every(
                (v: { type?: string; text?: string }) =>
                  v?.type === 'text' && typeof v.text === 'string',
              ))),
      )
      this.record('dispatch.json', { sequence: body.seq, hash: body.hash })
      this.userSeen = true
      requireRelay(this.financeTurn)
      this.effectBarrier = this.financeTurn.beforeDispatch({ sequence: body.seq as number,
        inputSha256: body.hash as string })
      await this.effectBarrier
      requireRelay(!this.revoked)
      this.verify(this.admitted.authority, this.admitted.lease, true)
      this.lastSequence = body.seq as number
      this.lastHash = body.hash
      this.userSubmitted = true
      if (!this.host.stdin.write(bytes))
        await once(this.host.stdin, 'drain', { signal: this.abort.signal })
    } else {
      requireRelay(frame.type === 'control_request' && frame.request?.subtype === 'interrupt')
      this.lastSequence = body.seq as number
      this.lastHash = body.hash
      if ((this.phase === 'running' || this.phase === 'settling') && !this.interruptedTurn) {
        this.interruptActiveTurn(false)
        if (!this.host.stdin.write(bytes))
          await once(this.host.stdin, 'drain', { signal: this.abort.signal })
      }
    }
  }
  private deliver(): void {
    if (!this.pending) this.pending = this.toolQueue.shift()
    if (
      this.revoked ||
      !this.poll ||
      !this.pending ||
      this.pending.delivered ||
      this.pending.response.destroyed
    )
      return
    const poll = this.poll
    this.poll = undefined
    clearTimeout(poll.timer)
    this.pending.delivered = true // lost delivery ACK never creates another effect job.
    reply(poll.response, { ok: true, delivery: this.pending.delivery })
  }
  private async tool(req: IncomingMessage, res: ServerResponse): Promise<void> {
    requireRelay(req.method === 'POST' && req.url === '/roundtrip')
    const body = await jsonBody(req)
    requireRelay(
      !this.revoked &&
        this.bindingExpiresAt > Date.now() &&
        this.admitted &&
        this.userSeen &&
        this.phase === 'running' && this.lifecycleId && !this.localStopped &&
        this.usedToolIds.size < 10000 &&
        Object.keys(body).sort().join(',') === 'arguments,inputSha256,name,operationId,rpcId,runId,toolUseId' &&
        body.runId === this.runId &&
        body.operationId === this.binding.operationId &&
        typeof body.name === 'string' &&
        typeof body.toolUseId === 'string' &&
        body.toolUseId.length > 0 &&
        body.toolUseId.length <= 65536 &&
        ((typeof body.rpcId === 'string' && body.rpcId.length > 0 && body.rpcId.length <= 256) ||
          (typeof body.rpcId === 'number' && Number.isSafeInteger(body.rpcId))) &&
        body.rpcId !== body.toolUseId &&
        body.arguments &&
        typeof body.arguments === 'object' &&
        !Array.isArray(body.arguments),
    )
    const admitted = this.admitted
    this.verify(admitted.authority, admitted.lease, true)
    validateCc5NativeToolInput(body.name, body.arguments)
    requireRelay(!this.profile || Object.hasOwn(this.profile.toolNames, body.name))
    const inputSha256 = cc5ToolInputSha256(body.arguments)
    const rpcKey = `${typeof body.rpcId}:${body.rpcId}`
    requireRelay(body.inputSha256 === inputSha256 && !this.usedRpcIds.has(rpcKey) &&
      !this.usedToolIds.has(body.toolUseId))
    this.usedRpcIds.add(rpcKey)
    this.usedToolIds.add(body.toolUseId)
    this.toolBurned = true
    this.waitingTools++
    // A lost MCP caller revokes this operation even before its original hook row arrives.
    res.once('close', () => {
      if (!res.writableFinished) void this.stop().catch(() => {})
    })
    requireRelay(!res.destroyed && !req.aborted)
    this.record(`tool-${sha(body.toolUseId)}-attempt.json`, { rpcId: body.rpcId, toolUseId: body.toolUseId,
      name: body.name, inputSha256 })
    // RPC and original hook delivery are independent; either may arrive first.
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(10000)])
    try {
      while (!this.observation.nativeSessionId) await once(this.outputEvents, 'data', { signal })
      const nativeSessionId = this.observation.nativeSessionId
      const tool = {
        uid: this.binding.uid,
        containerDbId: this.binding.containerDbId,
        dockerId: this.binding.dockerId,
        operationId: this.binding.operationId,
        sessionKey: this.binding.sessionKey,
        turnKey: admitted.turnKey,
        nativeSessionId,
        toolUseId: body.toolUseId as string,
        rpcId: body.rpcId as string | number,
        name: body.name,
        arguments: body.arguments,
        authority: admitted.authority,
        lease: admitted.lease,
      }
      await this.observation.waitFor(tool, signal)
      requireRelay(!this.revoked && !res.destroyed && !req.aborted && this.admitted === admitted && this.phase === 'running')
      this.verify(admitted.authority, admitted.lease, true) // The active lease remains fresh after observation's await.
      tool.lease = admitted.lease
      const pending: PendingTool = {
        response: res,
        delivered: false,
        acknowledged: false,
        delivery: {
          request: tool,
          admission: {
            turnKey: admitted.turnKey,
            authorityTurnId: admitted.payload.authorityTurnId,
            connectionChallenge: admitted.payload.connectionChallenge,
            securityEpoch: admitted.payload.securityEpoch,
          },
        },
      }
      this.turnTools.set(tool.toolUseId, pending)
      this.toolQueue.push(pending)
      this.deliver()
    } finally { this.waitingTools-- }
  }
}
