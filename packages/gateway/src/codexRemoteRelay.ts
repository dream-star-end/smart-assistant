/** Privileged master relay. It never runs a model tool, and never trusts MCP metadata as observation. */
import { timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { constants, closeSync, fsyncSync, mkdirSync, openSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { assertLeaseMatchesAuthority, verifyAuthority, verifyTurnLease, sameRemoteExecutionBackend,
  type AuthorityKeyring, type ModelAuthorityPayload } from '@openclaude/protocol'
import { assertCc5ToolResult, cc5ToolInputSha256 } from './cc5NativeTool.js'
import { assertCodexBinding, buildCodexReceipt, codexBackend, codexJsonHash, codexNeed, nativeTokens,
  nativeDelta, type CodexNativeTokens, type CodexRemoteBinding } from './codexRemoteContract.js'
import { CodexToolObservation } from './codexToolObservation.js'
import { readCodexLines, type CodexHostPort, type CodexLaneSpec } from './codexRemoteHost.js'
import type { RemoteFinancePort, RemoteFinanceTurn } from './remoteFinance.js'

async function body(req: IncomingMessage): Promise<any> {
  codexNeed(req.method === 'POST' && !req.headers['transfer-encoding'])
  const chunks: Buffer[] = []; let size = 0
  for await (const part of req) { size += part.length; codexNeed(size <= 2 * 1024 * 1024); chunks.push(part) }
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
  codexNeed(value && typeof value === 'object' && !Array.isArray(value)); return value
}
interface Tool { seq: number; request: any; delivered: boolean; result?: unknown; acknowledged: boolean; nativeCompleted: boolean }
export class CodexRemoteRelay {
  readonly controlServer = createServer((req, res) => { void this.control(req, res).catch(e => {
    this.fence(e instanceof Error ? e.message : 'CODEX_CONTROL_REJECTED')
    if (!res.headersSent) { res.writeHead(403); res.end('{"ok":false,"error":"CODEX_REMOTE_REJECTED"}') }
    else res.destroy()
  }) })
  // Kept separate for the runtime's permission layout. Codex's tool channel is SSH, not container HTTP.
  readonly toolServer = createServer((_req, res) => { res.writeHead(403); res.end() })
  private revoked = false
  private stopping?: Promise<{ remoteStopped: true }>
  private localStopped = true
  private readonly localStops = new EventEmitter()
  private launched = false
  private turnHostAttempted = false
  private starting = false
  private admitting?: Promise<void>
  private app?: ChildProcessWithoutNullStreams
  private socket?: ChildProcessWithoutNullStreams
  private appSeq = 0
  private socketSeq = 0
  private outputSeq = 0
  private recordSeq = 0
  private output: Array<{ seq: number; frame: unknown }> = []
  private outputBytes = 0
  private outputTail = Promise.resolve()
  private readonly pending = new Map<string, string>()
  private readonly usedIds = new Set<string>()
  private readonly usedAuthorities = new Set<string>()
  private tools = new Map<string, Tool>()
  private observation?: CodexToolObservation
  private catalogHash?: string
  private admitted?: { authority: string; lease: string; payload: ModelAuthorityPayload; turnKey: string }
  private financeTurn?: RemoteFinanceTurn
  private baseline?: CodexNativeTokens
  private total?: CodexNativeTokens
  private thread?: string
  private dispatching = false
  private active = false
  private expiry?: ReturnType<typeof setTimeout>
  private firstCause?: string
  private readonly acknowledgements = new EventEmitter()
  private readonly terminals = new Map<string, string>()
  constructor(readonly binding: CodexRemoteBinding, private readonly keys: AuthorityKeyring,
    private readonly host: CodexHostPort, private readonly spec: CodexLaneSpec,
    private readonly journal: string, private readonly finance: RemoteFinancePort,
    private readonly onThread: (id: string) => Promise<void>,
    private readonly onRemoteStart: () => Promise<void> = async () => {}) {
    assertCodexBinding(binding)
    mkdirSync(journal, { recursive: true, mode: 0o700 })
    this.record('binding', { binding, spec })
  }
  get stopped(): boolean { return this.revoked }
  private record(kind: string, value: unknown): void {
    const fd = openSync(join(this.journal, `${String(++this.recordSeq).padStart(8,'0')}-${kind}.json`),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd) } finally { closeSync(fd) }
    const dir = openSync(this.journal, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { fsyncSync(dir) } finally { closeSync(dir) }
  }
  private fence(reason: string): void {
    if (this.revoked) return
    if (!this.firstCause) {
      this.firstCause = /^CODEX_[A-Z_]+$/.test(reason) ? reason : 'CODEX_RELAY_UNKNOWN'
      try { this.record('fence', { code: this.firstCause }) } catch { /* keep revoked even with disk failure */ }
    }
    this.revoked = true
    this.observation?.revoke(this.firstCause)
    void this.stop().catch(() => {})
  }
  private scope(v: any, expired = false): void {
    const b = this.binding
    codexNeed(typeof v.capability === 'string' && /^[a-f0-9]{64}$/.test(v.capability) &&
      timingSafeEqual(Buffer.from(v.capability), Buffer.from(b.capability)) && v.operationId === b.operationId &&
      v.sessionKey === b.sessionKey && v.uid === b.uid && v.containerDbId === b.containerDbId && v.dockerId === b.dockerId &&
      v.generation === b.generation && (expired || !this.revoked && b.expiresAt > Date.now()))
  }
  private verify(authority: string, lease: string, allowExpired = false): ModelAuthorityPayload {
    const a = verifyAuthority(authority, this.keys, Date.now(), { allowExpired })
    assertLeaseMatchesAuthority(verifyTurnLease(lease, this.keys, Date.now()), a)
    codexNeed(a.engine === 'codex' && a.canonicalModel === this.binding.canonicalModel &&
      String(a.uid) === this.binding.uid && String(a.containerId) === this.binding.containerDbId &&
      sameRemoteExecutionBackend(a.executionBackend, codexBackend(this.binding)))
    return a
  }
  private arm(lease: string): void {
    clearTimeout(this.expiry)
    const expiresAt = verifyTurnLease(lease, this.keys, Date.now()).expiresAt
    this.expiry = setTimeout(() => this.fence('CODEX_LEASE_EXPIRED'), Math.max(0, Math.min(expiresAt,this.binding.expiresAt)-Date.now()))
    this.expiry.unref()
  }
  private publish(frame: unknown): void {
    const bytes = Buffer.byteLength(JSON.stringify(frame)); this.outputBytes += bytes
    codexNeed(this.outputBytes <= 8 * 1024 * 1024, 'CODEX_OUTPUT_BACKPRESSURE')
    this.output.push({ seq: ++this.outputSeq, frame })
  }
  private admit(v: any): Promise<void> {
    codexNeed(!this.admitting)
    const pending = this.admitTurn(v)
    this.admitting = pending
    return pending.finally(() => { this.admitting = undefined })
  }
  private async admitTurn(v: any): Promise<void> {
    codexNeed(!this.active && !this.starting && !this.revoked)
    const a = this.verify(v.authority, v.lease)
    codexNeed(!this.usedAuthorities.has(a.authorityTurnId) && typeof v.turnKey === 'string' && /^[a-f0-9]{64}$/.test(v.turnKey))
    this.usedAuthorities.add(a.authorityTurnId); this.starting = true
    codexNeed(v.catalog && Object.keys(v.catalog).join(',') === 'tools' && Array.isArray(v.catalog.tools) &&
      v.catalog.tools.length > 0 && v.catalog.tools.length <= 128 &&
      v.catalog.tools.every((t: any) => /^[A-Za-z0-9_-]{1,48}$/.test(t?.name) && t.inputSchema?.type === 'object'))
    const names = new Set<string>(v.catalog.tools.map((t: any) => t.name))
    codexNeed(names.size === v.catalog.tools.length)
    const catalogHash = cc5ToolInputSha256(v.catalog)
    codexNeed(!this.catalogHash || this.catalogHash === catalogHash)
    this.catalogHash = catalogHash
    // Lane lifetime is not this admission's effect state (a resident app may serve many turns).
    this.turnHostAttempted = false; this.dispatching = false; this.financeTurn = undefined
    this.financeTurn = await this.finance.admit({ binding: this.binding, authorityEnvelope: v.authority,
      leaseEnvelope: v.lease, sessionKey: this.binding.sessionKey, turnKey: v.turnKey })
    this.admitted = { authority: v.authority, lease: v.lease, payload: a, turnKey: v.turnKey }
    codexNeed(!this.revoked) // stop owns and aborts this newly admitted prehost reservation
    await this.onRemoteStart() // durable generation CAS precedes any remote effect
    codexNeed(!this.revoked)
    await this.financeTurn.beforeHostStart()
    codexNeed(!this.revoked)
    this.record('admission', { authority: v.authority, lease: v.lease, turnKey: v.turnKey, catalogHash })
    this.observation ??= new CodexToolObservation(names, reason => this.fence(reason))
    this.tools.clear(); this.total = undefined; this.baseline = undefined; this.dispatching = false
    this.arm(v.lease)
    // The container must prove its tool host is stopped, independently of the remote scope proof.
    this.localStopped = false
    if (!this.launched) {
      this.launched = true; this.turnHostAttempted = true
      await this.host.provision(v.catalog)
      codexNeed(!this.revoked)
      await this.openSocket()
      codexNeed(!this.revoked)
      await this.openApp()
    } else if (this.thread) {
      codexNeed(this.financeTurn.bindNativeThread)
      this.baseline = await this.financeTurn.bindNativeThread(this.thread, false)
    }
    codexNeed(!this.revoked)
    this.starting = false; this.active = true
  }
  private identity(row: any): void {
    for (const k of ['operationId','runId','generation','profileId','authEpoch'] as const) codexNeed(row[k] === this.spec.manifest[k])
  }
  private openApp(): Promise<void> {
    const app = this.app = this.host.open('launch')
    return new Promise((resolve, reject) => {
      let ready = false
      const timer = setTimeout(() => fail(new Error('CODEX_READY_TIMEOUT')), 30000)
      const fail = (e: Error) => { clearTimeout(timer); reject(e); this.fence(e.message) }
      readCodexLines(app, row => {
        codexNeed(!this.revoked && row.version === 1 && row.engine === 'codex' && row.seq === ++this.appSeq)
        this.identity(row)
        if (!ready) {
          codexNeed(row.kind === 'ready'); ready = true; clearTimeout(timer); this.record('ready', row); resolve(); return
        }
        if (row.kind === 'stderr') return
        const f = row.payload
        if (f?.id !== undefined && f.method !== undefined) throw new Error('CODEX_SERVER_REQUEST_REJECTED')
        if (['item/started','item/completed'].includes(f?.method)) {
          const item = f.params?.item
          codexNeed(['agentMessage','reasoning','userMessage','contextCompaction','mcpToolCall'].includes(item?.type)
            && (item.type !== 'mcpToolCall' || item.server === 'ocbridge'), 'CODEX_NATIVE_ITEM_REJECTED')
        }
        codexNeed(row.kind === 'stdout', row.kind === 'error' ? row.code : 'CODEX_STDOUT_INVALID')
        // Serialize native protocol state but NEVER wait here for a tool channel response.
        this.outputTail = this.outputTail.then(() => this.native(row.payload)).catch(e => this.fence(e.message))
      }, fail)
      app.once('close', () => { if (!this.revoked) fail(new Error('CODEX_HOST_EXIT_UNKNOWN')) })
    })
  }
  private openSocket(): Promise<void> {
    const socket = this.socket = this.host.open('tool-socket')
    return new Promise((resolve, reject) => {
      let ready = false
      const timer = setTimeout(() => fail(new Error('CODEX_TOOL_SOCKET_TIMEOUT')), 30000)
      const fail = (e: Error) => { clearTimeout(timer); reject(e); this.fence(e.message) }
      readCodexLines(socket, row => {
        codexNeed(!this.revoked && row.version === 3 && row.engine === 'codex')
        if (!ready) {
          codexNeed(row.kind === 'socket-ready' && row.operationId === this.binding.operationId &&
            row.runId === this.binding.runId && row.generation === this.binding.generation)
          ready = true; clearTimeout(timer); resolve(); return
        }
        codexNeed(row.kind === 'tool-request' && row.seq === ++this.socketSeq && typeof row.body === 'string')
        const bytes = Buffer.from(row.body, 'base64'); codexNeed(bytes.length <= 131072 && bytes.toString('base64') === row.body)
        void this.tool(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)), row.seq).catch(e => this.fence(e.message))
      }, fail)
      socket.once('close', () => { if (!this.revoked) fail(new Error('CODEX_TOOL_SOCKET_UNKNOWN')) })
    })
  }
  private async tool(request: any, seq: number): Promise<void> {
    codexNeed(!this.localStopped && this.active && this.dispatching && request.version === 3 && request.engine === 'codex' &&
      request.operationId === this.binding.operationId && request.runId === this.binding.runId &&
      request.generation === this.binding.generation && !this.tools.has(request.callId))
    this.record('tool-attempt', request)
    await this.observation!.authorize(request)
    codexNeed(!this.revoked && !this.localStopped)
    this.verify(this.admitted!.authority, this.admitted!.lease, true)
    this.tools.set(request.callId, { request, seq, delivered: false, acknowledged: false, nativeCompleted: false })
  }
  private async native(frame: any): Promise<void> {
    codexNeed(!this.revoked)
    if (frame.method === 'turn/completed') {
      const key = `${frame.params?.threadId}:${frame.params?.turn?.id}`
      const previous = this.terminals.get(key)
      if (previous) { codexNeed(previous === cc5ToolInputSha256(frame), 'CODEX_TERMINAL_CONFLICT'); return }
    }
    this.observation!.observe(frame)
    if (frame.id !== undefined) {
      const method = this.pending.get(JSON.stringify(frame.id)); codexNeed(method)
      this.pending.delete(JSON.stringify(frame.id))
      if (['thread/start','thread/resume'].includes(method) && !frame.error) {
        const id = frame.result?.thread?.id
        codexNeed(typeof id === 'string' && frame.result.model === this.spec.manifest.model &&
          (!this.spec.manifest.nativeThreadId || id === this.spec.manifest.nativeThreadId))
        this.observation!.bindThread(id); this.thread = id
        codexNeed(this.financeTurn?.bindNativeThread)
        this.baseline = await this.financeTurn.bindNativeThread(id, method === 'thread/start')
        await this.onThread(id)
      }
    }
    const p = frame.params
    if (frame.method === 'thread/tokenUsage/updated') {
      codexNeed(this.active && this.dispatching && p?.threadId === this.thread && p.turnId === this.observation!.nativeTurnId)
      const { totalTokens, ...usage } = p.tokenUsage?.total ?? {}
      const total = nativeTokens(usage)
      codexNeed(Number.isSafeInteger(totalTokens) && totalTokens === total.inputTokens + total.outputTokens && this.baseline)
      nativeDelta(total, this.total ?? this.baseline); this.total = total
    }
    if (frame.method === 'item/completed' && p.item?.type === 'mcpToolCall') {
      const t = this.tools.get(p.item.id); codexNeed(t?.result); t.nativeCompleted = true
    }
    if (frame.method === 'turn/completed') {
      codexNeed(this.active && this.dispatching && this.total && this.baseline && this.financeTurn && this.admitted)
      codexNeed([...this.observation!.calls].every(c => {
        const t = this.tools.get(c.callId); return t?.result && t.nativeCompleted
      }), 'CODEX_TOOL_RECEIPT_UNPROVEN')
      await this.waitAcknowledgements()
      const status = p.turn.status; codexNeed(['completed','failed','interrupted'].includes(status))
      const receipt = buildCodexReceipt(this.binding, { upstreamModel: this.spec.manifest.model,
        authorityTurnId: this.admitted.payload.authorityTurnId, turnKey: this.admitted.turnKey,
        nativeThreadId: this.thread!, nativeTurnId: p.turn.id }, this.baseline, this.total, status)
      this.record('native-terminal', receipt)
      const outcome = await this.financeTurn.terminal(receipt)
      codexNeed(outcome.state === 'proven' && outcome.requestId === this.admitted.payload.billingRequestId, 'CODEX_BILLING_PENDING')
      this.record('terminal-proven', { requestId: outcome.requestId, digest: receipt.resultSha256 })
      this.terminals.set(`${p.threadId}:${p.turn.id}`, cc5ToolInputSha256(frame))
      this.observation!.endTurn(); this.active = false
    }
    codexNeed(!this.revoked); this.publish(frame)
  }
  private waitAcknowledgements(): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => { clearTimeout(timer); this.acknowledgements.removeListener('change',check); error ? reject(error) : resolve() }
      const check = () => {
        if (this.revoked) finish(new Error('CODEX_TOOL_RECEIPT_UNPROVEN'))
        else if ([...this.tools.values()].every(t => t.acknowledged)) finish()
      }
      const timer = setTimeout(() => finish(new Error('CODEX_TOOL_RECEIPT_UNPROVEN')),10000)
      this.acknowledgements.on('change',check); check()
    })
  }
  private async rpc(frame: any): Promise<void> {
    codexNeed(this.active && !this.revoked && this.app && frame && Object.keys(frame).every(k => ['id','method','params','jsonrpc'].includes(k)))
    const p = frame.params ?? {}, method = frame.method
    codexNeed(p && typeof p === 'object' && !Array.isArray(p))
    const allowed: Record<string, string[]> = { initialize: ['clientInfo','capabilities'], initialized: [],
      'thread/start': ['baseInstructions','developerInstructions'], 'thread/resume': ['threadId'],
      'turn/start': ['threadId','input','effort'], 'turn/interrupt': ['threadId','turnId'], 'thread/read': ['threadId','includeTurns'],
      'model/list': ['cursor','limit','includeHidden'], 'mcpServerStatus/list': ['cursor','limit'], 'account/read': [] }
    codexNeed(Object.hasOwn(allowed, method) && Object.keys(p).every(k => allowed[method]!.includes(k)))
    if (method !== 'initialized') {
      codexNeed(typeof frame.id === 'string' || typeof frame.id === 'number' && Number.isSafeInteger(frame.id))
      const key = JSON.stringify(frame.id); codexNeed(!this.usedIds.has(key) && this.usedIds.size < 100000)
      this.usedIds.add(key); this.pending.set(key, method)
    } else codexNeed(frame.id === undefined)
    if (method === 'thread/start' || method === 'thread/resume') {
      codexNeed(!this.thread && !this.baseline && !this.dispatching)
      codexNeed(method === 'thread/start' ? !this.spec.manifest.nativeThreadId : p.threadId === this.spec.manifest.nativeThreadId)
    }
    if (method === 'turn/start') {
      codexNeed(!this.dispatching && this.baseline && p.threadId === this.thread && Array.isArray(p.input) && p.input.length > 0)
      codexNeed(p.input.every((i: any) => i?.type === 'text' && typeof i.text === 'string' && Object.keys(i).every(k => ['type','text','text_elements'].includes(k))))
      if (p.effort !== undefined) codexNeed(this.admitted!.payload.executionDescriptor.supportedEfforts.includes(p.effort))
      this.dispatching = true // burn before async effect marker; never retry lost input ACK.
      await this.financeTurn!.beforeDispatch({ sequence: this.usedIds.size, inputSha256: codexJsonHash(JSON.stringify(frame)) })
    }
    if (method === 'turn/interrupt') codexNeed(p.threadId === this.thread && p.turnId === this.observation!.nativeTurnId)
    if (method === 'thread/read') codexNeed(p.threadId === this.thread)
    this.verify(this.admitted!.authority, this.admitted!.lease, true)
    codexNeed(!this.revoked); this.record('rpc', frame); this.app.stdin.write(`${JSON.stringify(frame)}\n`)
  }
  private async control(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const v = await body(req), path = req.url
    this.scope(v, path === '/stop' || path === '/tool/stopped')
    let result: any = {}
    if (path === '/admit') { await this.admit(v); result = { ready: true } }
    else if (path === '/rpc') await this.rpc(v.frame)
    else if (path === '/poll') {
      codexNeed(Number.isSafeInteger(v.afterSeq) && v.afterSeq >= 0 && v.afterSeq <= this.outputSeq)
      this.output = this.output.filter(f => f.seq > v.afterSeq)
      this.outputBytes = Buffer.byteLength(JSON.stringify(this.output)); result = { frames: this.output }
    } else if (path === '/tool/next') {
      const tool = [...this.tools.values()].find(t => !t.delivered)
      if (tool) { tool.delivered = true; this.record('tool-delivered', { callId: tool.request.callId }); result = { request: tool.request,
        authority: this.admitted!.authority, lease: this.admitted!.lease, turnKey: this.admitted!.turnKey, binding: this.binding } }
    } else if (path === '/tool/result') {
      const tool = this.tools.get(v.callId); codexNeed(tool?.delivered && !tool.result)
      assertCc5ToolResult(v.result); tool.result = v.result
      this.record('tool-receipt', { callId: v.callId, result: v.result })
      const { arguments: _, ...identity } = tool.request
      const response = { ...identity, ok: true, result: v.result }
      this.socket!.stdin.write(`${JSON.stringify({ version: 3, engine: 'codex', kind: 'tool-response', seq: tool.seq,
        status: 200, body: Buffer.from(JSON.stringify(response)).toString('base64') })}\n`)
      result = { callId: v.callId }
    } else if (path === '/tool/ack') {
      const tool = this.tools.get(v.callId); codexNeed(tool?.result && !tool.acknowledged)
      this.record('tool-ack', { callId: v.callId }); tool.acknowledged = true; this.acknowledgements.emit('change')
    } else if (path === '/tool/stopped') {
      codexNeed(this.revoked && this.admitted && v.authorityTurnId === this.admitted.payload.authorityTurnId
        && v.turnKey === this.admitted.turnKey, 'CODEX_LOCAL_STOP_SCOPE_MISMATCH')
      this.localStopped = true
      this.record('local-stopped', { generation: this.binding.generation, authorityTurnId: v.authorityTurnId, turnKey: v.turnKey })
      this.localStops.emit('stopped')
    }
    else if (path === '/renew') { this.verify(this.admitted!.authority, v.lease, true); this.admitted!.lease = v.lease; this.arm(v.lease) }
    else if (path === '/stop') result = await this.stop()
    else throw new Error('CODEX_CONTROL_REJECTED')
    res.end(JSON.stringify({ ok: true, ...result }))
  }
  private waitLocalStop(): Promise<void> {
    if (this.localStopped) return Promise.resolve()
    return new Promise((resolve,reject) => {
      const done = () => { clearTimeout(timer); this.localStops.removeListener('stopped',done); resolve() }
      const timer = setTimeout(() => { this.localStops.removeListener('stopped',done); reject(new Error('CODEX_STOP_UNKNOWN')) },5000)
      this.localStops.once('stopped',done)
    })
  }
  stop(): Promise<{ remoteStopped: true }> {
    this.revoked = true; clearTimeout(this.expiry)
    this.acknowledgements.emit('change')
    return this.stopping ??= (async () => {
      this.observation?.revoke()
      // Admission can be waiting on PG/Redis. Revoke first, then await its owned reservation.
      await this.admitting?.catch(() => {})
      const proof = await this.host.stop()
      await this.waitLocalStop()
      await this.financeTurn?.stop({ hostStartAttempted: this.turnHostAttempted, userSubmitted: this.dispatching,
        remoteStopped: proof.remoteStopped && this.localStopped })
      codexNeed(proof.remoteStopped && this.localStopped, 'CODEX_STOP_UNKNOWN')
      this.record('stopped', { remoteStopped: true }); return { remoteStopped: true as const }
    })().catch(error => { this.stopping = undefined; throw error })
  }
}
