import { createHash, timingSafeEqual } from 'node:crypto'
/** Box-side task relay. It never executes the model's file/command operation. */
import { EventEmitter, once } from 'node:events'
import {
  constants,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
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
import type { Cc5FinancePort, Cc5FinanceTurn } from './cc5Finance.js'
import { Cc5NativeUsageObserver } from './cc5NativeUsage.js'
import { CC5_TOOL_RECEIPT_MAX_BYTES, type Cc5ToolReceipt, assertCc5ToolResult, boundCc5ToolResult,
  cc5ToolInputSha256, cc5ToolScopeHash, validateCc5NativeToolInput } from './cc5NativeTool.js'
import { Cc5ToolObservation } from './cc5ToolObservation.js'
import type { Cc5ToolDelivery } from './cc5ToolPump.js'

export interface Cc5InteractiveHostPort {
  /** Must launch the pinned original host once; only its original READY resolves ready. */
  start(): { stdin: Writable; stdout: Readable; ready: Promise<void> }
  /** Independent identity-checked remote stop and absence proof, including failed startup. */
  stop(): Promise<{ remoteStopped: true }>
}
type Body = Record<string, unknown>
type PendingTool = { delivery: Cc5ToolDelivery; response: ServerResponse; delivered: boolean;
  receipt?: Cc5ToolReceipt; acknowledged: boolean; ack?: Promise<void> }
function requireRelay(ok: unknown): asserts ok {
  if (!ok) throw new Error('CC5_RELAY_REJECTED')
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

  constructor(
    private readonly binding: Readonly<Cc5BridgeBinding>,
    private readonly keyring: AuthorityKeyring,
    private readonly runId: string,
    private readonly hostPort: Cc5InteractiveHostPort,
    private readonly journalRoot: string,
    private readonly finance: Cc5FinancePort,
    private readonly options: {
      localStopTimeoutMs?: number
      slidingTtlMs?: number
      onBindingExtended?: (expiresAt: number) => void
    } = {},
  ) {
    assertCc5BindingScope(binding)
    requireRelay(keyring.size > 0 && /^[a-f0-9-]{36}$/.test(runId) &&
      binding.runId === runId && typeof finance?.admit === 'function')
    this.bindingExpiresAt = binding.expiresAt
    this.nativeUsage = new Cc5NativeUsageObserver(binding)
    mkdirSync(journalRoot, { mode: 0o700, recursive: false })
    const st = lstatSync(journalRoot)
    requireRelay(st.isDirectory() && st.uid === process.getuid?.() && (st.mode & 0o077) === 0)
    const parent = openSync(
      dirname(journalRoot),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
    try {
      fsyncSync(parent)
    } finally {
      closeSync(parent)
    }
    this.observation = new Cc5ToolObservation(binding.operationId)
    this.armExpiry(this.bindingExpiresAt)
  }
  private slideBindingExpiry(): number {
    if (this.options.slidingTtlMs && this.options.slidingTtlMs > 0) {
      const next = Math.max(this.bindingExpiresAt, Date.now() + this.options.slidingTtlMs)
      if (next > this.bindingExpiresAt) {
        this.bindingExpiresAt = next
        this.options.onBindingExtended?.(next)
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
  private ensureHost(): Promise<void> {
    if (this.hostReady) return this.hostReady
    requireRelay(!this.revoked)
    // Publish the joining promise BEFORE invoking start, even if start throws after spawning.
    this.hostReady = Promise.resolve().then(async () => {
      requireRelay(!this.revoked && this.admitted && this.financeTurn)
      this.launchAttempted = true
      this.host = this.hostPort.start()
      const stdin = this.host.stdin
      const inputFailed = (): void => {
        void this.stop().catch(() => {})
      }
      stdin.on('error', inputFailed)
      stdin.once('close', () => {
        inputFailed()
        stdin.removeListener('error', inputFailed)
      })
      this.host.stdout.on('data', (chunk: Buffer) => {
        if (this.revoked) return
        this.host!.stdout.pause()
        const bytes = Buffer.from(chunk)
        this.queuedOutputBytes += bytes.length
        this.outputTail = this.outputTail.then(async () => {
          requireRelay(!this.revoked && this.queuedOutputBytes <= CC5_BRIDGE_MAX_FRAME_BYTES)
          const frames = this.nativeUsage.ingest(bytes)
          // Validate the entire complete chunk before a waiter can authorize a tool.
          this.observation.ingest(bytes)
          this.outputEvents.emit('data')
          for (const frame of frames) {
            requireRelay(!this.revoked)
            if (frame.receipt) {
              if (this.interruptedTurn && this.phase === 'idle') {
                this.interruptedTurn = false
              } else {
                requireRelay(this.phase === 'running' && this.userSeen && this.financeTurn && this.admitted &&
                  frame.receipt.version === 2 && frame.receipt.authorityTurnId === this.admitted.payload.authorityTurnId &&
                  frame.receipt.turnKey === this.admitted.turnKey && this.waitingTools === 0 && this.toolQueue.length === 0 &&
                  this.observation.toolUseIds.every((id) => this.turnTools.get(id)?.receipt))
                this.verify(this.admitted.authority, this.admitted.lease, true)
                this.phase = 'settling'
                await Promise.all([...this.turnTools.values()].map((tool) => {
                  requireRelay(tool.receipt && tool.ack)
                  return tool.ack
                }))
                requireRelay([...this.turnTools.values()].every((tool) => tool.acknowledged) && !this.pending)
                this.record('native-terminal.json', frame.receipt)
                const outcome = await this.financeTurn.terminal(frame.receipt)
                requireRelay(outcome.state === 'proven' && outcome.requestId === this.admitted.payload.billingRequestId)
                this.record('terminal-proven.json', { requestId: outcome.requestId,
                  resultSha256: frame.receipt.resultSha256 })
                requireRelay(!this.revoked)
                this.observation.endTurn()
                this.phase = 'idle'
                this.armExpiry(this.bindingExpiresAt)
              }
            }
            requireRelay(!this.revoked)
            this.publishOutput(frame.bytes)
          }
          this.queuedOutputBytes -= bytes.length
          if (!this.revoked && !this.outputBackpressured) this.host?.stdout.resume()
        }).catch(() => { void this.stop().catch(() => {}) })
      })
      this.host.stdout.once('end', () => {
        void this.outputTail.then(() => {
          this.nativeUsage.finish()
          this.observation.finish()
        }).finally(() => this.stop()).catch(() => {})
      })
      this.host.stdout.once('error', () => {
        void this.stop().catch(() => {})
      })
      await this.host.ready
      requireRelay(!this.revoked)
    })
    void this.hostReady.catch(() => {
      void this.stop().catch(() => {})
    })
    return this.hostReady
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
    this.interruptedTurn = true
    this.pending?.response.destroy()
    this.pending = undefined
    for (const tool of this.toolQueue) tool.response.destroy()
    this.toolQueue.length = 0
    this.turnTools.clear()
    this.observation.endTurn()
    this.nativeUsage.interruptTurn()
    this.phase = 'idle'
    this.armExpiry(this.bindingExpiresAt)
    if (writeControlFrame && this.host) {
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
    const body = await jsonBody(req, req.url === '/tool/result' ? CC5_TOOL_RECEIPT_MAX_BYTES : 131072)
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
      const isInitial = !this.lifecycleId
      this.lifecycleId = body.lifecycleId
      this.localStopped = false
      this.record(
        isInitial ? 'local-registered.json' : `local-registered-${this.lifecycleId}.json`,
        { lifecycleId: this.lifecycleId },
        this.journalRoot,
      )
      reply(res, { ok: true, lifecycleId: this.lifecycleId })
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
        const expiresAt = this.slideBindingExpiry()
        this.armExpiry(verifyTurnLease(body.lease, this.keyring, Date.now()).expiresAt)
        // The per-turn marker also fences reuse of an already-running native worker.
        this.effectBarrier = this.financeTurn.beforeHostStart()
        await this.effectBarrier
        await this.ensureHost()
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
  private async open(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let buffer = ''
    let opened = false
    let protocolFailed = false
    try {
      for await (const chunk of req) {
        buffer += chunk.toString('utf8')
        requireRelay(Buffer.byteLength(buffer) <= CC5_BRIDGE_MAX_FRAME_BYTES * 2)
        let at: number
        while ((at = buffer.indexOf('\n')) >= 0) {
          const body = JSON.parse(buffer.slice(0, at)) as Body
          buffer = buffer.slice(at + 1)
          if (!opened) {
            if (body.generation !== undefined) {
              requireRelay(
                typeof body.generation === 'number' &&
                  Number.isSafeInteger(body.generation) &&
                  body.generation >= this.streamGeneration,
              )
              if (body.generation > this.streamGeneration && this.stream) {
                this.stream.end()
                this.stream = undefined
                this.streamClaimed = false
              }
              this.streamGeneration = body.generation
            }
            requireRelay(body.type === 'open' && !this.streamClaimed && this.admitted && this.financeTurn)
            this.scope(body)
            this.streamClaimed = true
            this.stream = res
            opened = true
            await this.ensureHost()
            res.writeHead(200, {
              'x-cc5-interactive-ready': '1',
              'x-cc5-stream-generation': String(this.streamGeneration),
              'x-cc5-out-seq': String(this.outSeq),
            })
            res.flushHeaders()
            if (typeof body.lastAckedSeq === 'number' && Number.isSafeInteger(body.lastAckedSeq)) {
              for (const item of this.outputHistory) {
                if (item.seq > body.lastAckedSeq) res.write(item.bytes)
              }
            } else {
              for (const raw of this.output) res.write(raw)
            }
            this.output = []
            this.outputBytes = 0
            res.on('drain', () => {
              this.outputBackpressured = false
              if (!this.revoked && this.queuedOutputBytes === 0) this.host?.stdout.resume()
            })
          } else await this.input(body)
        }
      }
      requireRelay(!buffer)
    } catch (error) {
      protocolFailed = true
      throw error
    } finally {
      if (opened) {
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
    } else {
      requireRelay((this.phase === 'running' || this.phase === 'settling') && frame.type === 'control_request' && frame.request?.subtype === 'interrupt')
      this.interruptActiveTurn(false)
    }
    this.lastSequence = body.seq as number
    this.lastHash = body.hash
    if (frame.type === 'user') this.userSubmitted = true
    if (!this.host.stdin.write(bytes))
      await once(this.host.stdin, 'drain', { signal: this.abort.signal })
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
