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
import { CC5_BRIDGE_MAX_FRAME_BYTES, type Cc5BridgeBinding } from './cc5BridgePort.js'
import { CC5_FIXED_TOOL_NAME, type Cc5FixedToolReceipt } from './cc5FixedTool.js'
import { Cc5ToolObservation } from './cc5ToolObservation.js'
import type { Cc5ToolDelivery } from './cc5ToolPump.js'

export interface Cc5InteractiveHostPort {
  /** Must launch the pinned original host once; only its original READY resolves ready. */
  start(): { stdin: Writable; stdout: Readable; ready: Promise<void> }
  /** Independent identity-checked remote stop and absence proof, including failed startup. */
  stop(): Promise<{ remoteStopped: true }>
}
type Body = Record<string, unknown>
function requireRelay(ok: unknown): asserts ok {
  if (!ok) throw new Error('CC5_RELAY_REJECTED')
}
function sha(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}
async function jsonBody(req: IncomingMessage): Promise<Body> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    requireRelay(size <= 131072)
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
  private sessionKey?: string
  private host?: ReturnType<Cc5InteractiveHostPort['start']>
  private hostReady?: Promise<void>
  private launchAttempted = false
  private readonly outputEvents = new EventEmitter()
  private expiry?: ReturnType<typeof setTimeout>
  private stream?: ServerResponse
  private streamClaimed = false
  private output: Buffer[] = []
  private outputBytes = 0
  private admitted?: {
    authority: string
    lease: string
    payload: ModelAuthorityPayload
    turnKey: string
  }
  private revoked = false
  private stopPromise?: Promise<{ remoteStopped: true }>
  private userSeen = false
  private lastSequence = 0
  private lastHash?: string
  private toolBurned = false
  private pending?: { delivery: Cc5ToolDelivery; response: ServerResponse; delivered: boolean }
  private poll?: { response: ServerResponse; timer: ReturnType<typeof setTimeout> }

  constructor(
    private readonly binding: Readonly<Cc5BridgeBinding>,
    private readonly keyring: AuthorityKeyring,
    private readonly runId: string,
    private readonly hostPort: Cc5InteractiveHostPort,
    private readonly journalRoot: string,
  ) {
    requireRelay(keyring.size > 0 && /^[a-f0-9-]{36}$/.test(runId))
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
    this.armExpiry(binding.expiresAt)
  }
  private record(name: string, value: unknown): void {
    const fd = openSync(
      join(this.journalRoot, name),
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
      this.journalRoot,
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
        typeof body.sessionKey === 'string' &&
        body.sessionKey.length > 0 &&
        body.sessionKey.length <= 512 &&
        (allowExpired || (!this.revoked && this.binding.expiresAt > Date.now())),
    )
    if (this.sessionKey) requireRelay(body.sessionKey === this.sessionKey)
    else this.sessionKey = body.sessionKey as string
  }
  private verify(authority: string, lease: string, allowExpired = false): ModelAuthorityPayload {
    const now = Date.now()
    const a = verifyAuthority(authority, this.keyring, now, { allowExpired })
    assertLeaseMatchesAuthority(verifyTurnLease(lease, this.keyring, now), a)
    requireRelay(
      String(a.uid) === this.binding.uid &&
        String(a.containerId) === this.binding.containerDbId &&
        a.canonicalModel === 'cc5-remote-t1555u' &&
        a.engine === 'cursor',
    )
    return a
  }
  private armExpiry(expiresAt: number): void {
    clearTimeout(this.expiry)
    this.expiry = setTimeout(
      () => {
        void this.stop().catch(() => {})
      },
      Math.max(0, Math.min(this.binding.expiresAt, expiresAt) - Date.now()),
    )
    this.expiry.unref()
  }
  private ensureHost(): Promise<void> {
    if (this.hostReady) return this.hostReady
    requireRelay(!this.revoked)
    // Publish the joining promise BEFORE invoking start, even if start throws after spawning.
    this.hostReady = Promise.resolve().then(async () => {
      requireRelay(!this.revoked)
      this.launchAttempted = true
      this.host = this.hostPort.start()
      this.host.stdout.on('data', (chunk: Buffer) => {
        if (this.revoked) return
        try {
          this.observation.ingest(chunk)
          this.outputEvents.emit('data')
          if (this.stream?.headersSent) {
            if (!this.stream.write(chunk)) this.host!.stdout.pause()
          } else {
            this.outputBytes += chunk.length
            requireRelay(this.outputBytes <= CC5_BRIDGE_MAX_FRAME_BYTES)
            this.output.push(chunk)
          }
        } catch {
          void this.stop().catch(() => {})
        }
      })
      this.host.stdout.once('end', () => {
        void this.stop().catch(() => {})
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

  stop(): Promise<{ remoteStopped: true }> {
    if (this.stopPromise) return this.stopPromise
    this.revoked = true
    clearTimeout(this.expiry)
    this.abort.abort()
    if (this.poll) {
      clearTimeout(this.poll.timer)
      this.poll.response.destroy()
      this.poll = undefined
    }
    this.pending?.response.destroy()
    this.stopPromise = Promise.resolve()
      .then(async () => {
        if (this.launchAttempted) requireRelay((await this.hostPort.stop()).remoteStopped === true)
        this.stream?.end()
        return { remoteStopped: true as const }
      })
      .catch((error) => {
        this.stream?.destroy()
        throw error
      })
    return this.stopPromise
  }
  private async control(req: IncomingMessage, res: ServerResponse): Promise<void> {
    requireRelay(req.method === 'POST')
    if (req.url === '/session/open') return this.open(req, res)
    const body = await jsonBody(req)
    this.scope(body, req.url === '/stop')
    if (req.url === '/stop') {
      reply(res, { ok: true, ...(await this.stop()) })
      return
    }
    if (req.url === '/admit') {
      requireRelay(
        !this.admitted &&
          typeof body.authority === 'string' &&
          typeof body.lease === 'string' &&
          typeof body.turnKey === 'string' &&
          body.turnKey.length > 0 &&
          body.turnKey.length <= 512,
      )
      const payload = this.verify(body.authority, body.lease)
      this.record('admission.json', {
        authorityTurnId: payload.authorityTurnId,
        turnKey: body.turnKey,
      })
      this.admitted = {
        authority: body.authority,
        lease: body.lease,
        payload,
        turnKey: body.turnKey,
      }
      this.armExpiry(verifyTurnLease(body.lease, this.keyring, Date.now()).expiresAt)
      await this.ensureHost()
      this.verify(body.authority, body.lease)
      reply(res, { ok: true, ready: true, admissionHash: sha(`${body.authority}\0${body.lease}`) })
    } else if (req.url === '/renew') {
      requireRelay(this.admitted && typeof body.lease === 'string')
      this.verify(this.admitted.authority, body.lease, true)
      this.admitted.lease = body.lease
      this.armExpiry(verifyTurnLease(body.lease, this.keyring, Date.now()).expiresAt)
      reply(res, { ok: true })
    } else if (req.url === '/tool/next') {
      requireRelay(!this.poll && !this.pending?.delivered)
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
      requireRelay(this.pending?.delivered && this.admitted)
      this.verify(this.admitted.authority, this.admitted.lease, true)
      const receipt = body.receipt as Cc5FixedToolReceipt
      const tool = this.pending.delivery.request
      requireRelay(
        receipt?.version === 1 &&
          receipt.exitCode === 0 &&
          receipt.dockerId === this.binding.dockerId &&
          receipt.containerDbId === this.binding.containerDbId &&
          receipt.operationId === tool.operationId &&
          receipt.nativeSessionId === tool.nativeSessionId &&
          receipt.toolUseId === tool.toolUseId &&
          typeof receipt.rpcId === typeof tool.rpcId &&
          receipt.rpcId === tool.rpcId &&
          /^[a-f0-9-]{36}$/.test(receipt.commandId) &&
          /^CC5_CONTAINER_[a-f0-9]{32}$/.test(receipt.marker) &&
          receipt.fileSha256 === sha(`${receipt.marker}\n`) &&
          Number.isSafeInteger(receipt.pid) &&
          receipt.pid > 0,
      )
      this.record('tool-completed.json', receipt)
      reply(this.pending.response, {
        ok: true,
        rpcId: tool.rpcId,
        toolUseId: tool.toolUseId,
        operationId: tool.operationId,
        receipt,
      })
      reply(res, { ok: true, commandId: receipt.commandId })
    } else throw new Error('CC5_RELAY_REJECTED')
  }
  private async open(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let buffer = ''
    let opened = false
    try {
      for await (const chunk of req) {
        buffer += chunk.toString('utf8')
        requireRelay(Buffer.byteLength(buffer) <= CC5_BRIDGE_MAX_FRAME_BYTES * 2)
        let at: number
        while ((at = buffer.indexOf('\n')) >= 0) {
          const body = JSON.parse(buffer.slice(0, at)) as Body
          buffer = buffer.slice(at + 1)
          if (!opened) {
            requireRelay(body.type === 'open' && !this.streamClaimed)
            this.scope(body)
            this.streamClaimed = true
            this.stream = res
            opened = true
            await this.ensureHost()
            res.writeHead(200, { 'x-cc5-interactive-ready': '1' })
            res.flushHeaders()
            for (const raw of this.output) res.write(raw)
            this.output = []
            this.outputBytes = 0
            res.on('drain', () => this.host?.stdout.resume())
          } else await this.input(body)
        }
      }
      requireRelay(!buffer)
    } finally {
      if (opened) await this.stop()
    }
  }
  private async input(body: Body): Promise<void> {
    requireRelay(this.admitted && this.host && !this.revoked && this.binding.expiresAt > Date.now())
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
        !this.userSeen &&
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
    } else requireRelay(frame.type === 'control_request' && frame.request?.subtype === 'interrupt')
    this.lastSequence = body.seq as number
    this.lastHash = body.hash
    if (!this.host.stdin.write(bytes))
      await once(this.host.stdin, 'drain', { signal: this.abort.signal })
  }
  private deliver(): void {
    if (!this.poll || !this.pending || this.pending.delivered) return
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
        this.binding.expiresAt > Date.now() &&
        this.admitted &&
        this.userSeen &&
        !this.toolBurned &&
        Object.keys(body).sort().join(',') === 'arguments,name,operationId,rpcId,runId,toolUseId' &&
        body.runId === this.runId &&
        body.operationId === this.binding.operationId &&
        body.name === CC5_FIXED_TOOL_NAME &&
        typeof body.toolUseId === 'string' &&
        body.toolUseId.length > 0 &&
        body.toolUseId.length <= 65536 &&
        ((typeof body.rpcId === 'string' && body.rpcId.length > 0 && body.rpcId.length <= 256) ||
          (typeof body.rpcId === 'number' && Number.isSafeInteger(body.rpcId))) &&
        body.rpcId !== body.toolUseId &&
        body.arguments &&
        typeof body.arguments === 'object' &&
        !Array.isArray(body.arguments) &&
        Object.keys(body.arguments).length === 1 &&
        (body.arguments as Body).operationId === this.binding.operationId,
    )
    this.verify(this.admitted.authority, this.admitted.lease, true)
    this.toolBurned = true
    this.record('tool-attempt.json', { rpcId: body.rpcId, toolUseId: body.toolUseId })
    // RPC and original hook delivery are independent; either may arrive first.
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(10000)])
    while (!this.observation.nativeSessionId) await once(this.outputEvents, 'data', { signal })
    const nativeSessionId = this.observation.nativeSessionId
    const tool = {
      uid: this.binding.uid,
      containerDbId: this.binding.containerDbId,
      dockerId: this.binding.dockerId,
      operationId: this.binding.operationId,
      sessionKey: this.sessionKey!,
      turnKey: this.admitted.turnKey,
      nativeSessionId,
      toolUseId: body.toolUseId as string,
      rpcId: body.rpcId as string | number,
      name: CC5_FIXED_TOOL_NAME,
      arguments: body.arguments,
      authority: this.admitted.authority,
      lease: this.admitted.lease,
    }
    await this.observation.waitFor(tool, this.abort.signal)
    requireRelay(!this.revoked)
    this.pending = {
      response: res,
      delivered: false,
      delivery: {
        request: tool,
        admission: {
          turnKey: this.admitted.turnKey,
          authorityTurnId: this.admitted.payload.authorityTurnId,
          connectionChallenge: this.admitted.payload.connectionChallenge,
          securityEpoch: this.admitted.payload.securityEpoch,
        },
      },
    }
    this.deliver()
  }
}
