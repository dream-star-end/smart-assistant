import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import {
  MODEL_AUTHORITY_VERSION,
  type ModelAuthorityPayload,
  type TurnLease,
  authoritySigningInput,
  encodeAuthorityEnvelope,
  encodeTurnLeaseEnvelope,
  turnLeaseSigningInput,
  verifyAuthority,
} from '@openclaude/protocol'
import { type Cc5BridgeBinding, cc5ControlRequest } from '../cc5BridgePort.js'
import type { Cc5ToolRequest } from '../cc5FixedTool.js'
import { type Cc5ToolReceipt, cc5ToolInputSha256, cc5ToolScopeHash } from '../cc5NativeTool.js'
import { type Cc5InteractiveHostPort, Cc5Relay } from '../cc5Relay.js'
import { CC5_PROMPT_MAX_BYTES } from '../cc5ToolCatalog.js'
import type { Cc5FinancePort } from '../cc5Finance.js'
import { StreamJson } from '../../box-bridge-mod/oc-bridge/hooks/frames.js'

function fixture(authorityTtlMs = 120000) {
  const key = generateKeyPairSync('ed25519')
  const jwk = key.publicKey.export({ format: 'jwk' }) as { x: string }
  const keyring = new Map([['test-key', new Uint8Array(Buffer.from(jwk.x, 'base64url'))]])
  const now = Date.now()
  const root = mkdtempSync(join(tmpdir(), 'cc5-fixed-tool-'))
  const binding: Cc5BridgeBinding = {
    version: 2,
    backendKind: 'cc5-interactive-v1',
    canonicalModel: 'box-claude-sonnet-5',
    sessionKey: 'agent:main:webchat:dm:fixture_chat1',
    runId: randomUUID(),
    uid: '912',
    containerDbId: '91',
    dockerId: 'a'.repeat(64),
    operationId: randomUUID(),
    capability: 'b'.repeat(64),
    expiresAt: now + 120000,
  }
  const a: ModelAuthorityPayload = {
    v: MODEL_AUTHORITY_VERSION,
    keyId: 'test-key',
    uid: 912,
    containerId: 91,
    authorityTurnId: randomBytes(16).toString('hex'),
    billingRequestId: randomUUID(),
    connectionChallenge: 'synthetic-connection',
    canonicalModel: 'box-claude-sonnet-5',
    engine: 'ccb',
    executionBackend: { kind: 'cc5-interactive-v1', sessionKey: binding.sessionKey, operationId: binding.operationId },
    securityEpoch: 12,
    executionRevision: 'test-r1',
    issuedAt: now,
    expiresAt: now + authorityTtlMs,
    executionDescriptor: {
      capabilityProfile: {},
      capabilitySchemaVersion: 1,
      contextWindow: 200000,
      supportedEfforts: [],
      supportsVision: false,
    },
  }
  const lease: TurnLease = {
    v: a.v,
    keyId: a.keyId,
    uid: a.uid,
    containerId: a.containerId,
    authorityTurnId: a.authorityTurnId,
    connectionChallenge: a.connectionChallenge,
    canonicalModel: a.canonicalModel,
    securityEpoch: a.securityEpoch,
    issuedAt: now,
    expiresAt: now + 2400000,
  }
  const envelope = (payload: ModelAuthorityPayload) =>
    encodeAuthorityEnvelope(payload, sign(null, authoritySigningInput(payload), key.privateKey))
  const leaseEnvelope = (payload: TurnLease) =>
    encodeTurnLeaseEnvelope(payload, sign(null, turnLeaseSigningInput(payload), key.privateKey))
  const request: Cc5ToolRequest = {
    uid: binding.uid,
    containerDbId: binding.containerDbId,
    dockerId: binding.dockerId,
    operationId: binding.operationId,
    sessionKey: 'agent:main:webchat:dm:fixture_chat1',
    turnKey: 'logical-billing-key-is-not-authority-id',
    nativeSessionId: randomUUID(),
    toolUseId: 'toolu_actual-frame',
    rpcId: 17,
    name: 'mcp__ocbridge__Read',
    arguments: { file_path: '/task/proof.txt' },
    authority: envelope(a),
    lease: leaseEnvelope(lease),
  }
  const observed = {
    nativeSessionId: request.nativeSessionId,
    toolUseId: request.toolUseId,
    name: request.name,
    input: request.arguments,
  }
  const producer = new StreamJson()
  producer.sessionId = request.nativeSessionId
  const admission = {
    turnKey: request.turnKey,
    authorityTurnId: a.authorityTurnId,
    connectionChallenge: a.connectionChallenge,
    securityEpoch: a.securityEpoch,
  }
  return {
    root,
    keyring,
    binding,
    a,
    lease,
    request,
    observed,
    admission,
    envelope,
    leaseEnvelope,
    nextResultId: (): string => JSON.parse(producer.result({ reason: 'answer', answer: 'fixture', durationMs: 0 }, null)).uuid,
    nextTurn: () => {
      const payload = { ...a, authorityTurnId: randomBytes(16).toString('hex'), billingRequestId: randomUUID() }
      return { authority: envelope(payload), lease: leaseEnvelope({ ...lease, authorityTurnId: payload.authorityTurnId }),
        turnKey: randomBytes(32).toString('hex'), payload }
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

async function harness(
  f: ReturnType<typeof fixture>,
  failure: 'none' | 'start' | 'stop' = 'none',
  financeOverride?: Cc5FinancePort,
  options: { configure?: boolean; prepare?: boolean; failConfigure?: boolean; replaceHost?: boolean;
    configureGate?: Promise<void>; prepareGate?: Promise<void>; fastConnectionCheck?: boolean } = {},
) {
  const written: Buffer[] = []
  const input = new PassThrough()
  const output = new PassThrough()
  input.on('data', (b) => written.push(b))
  let ready!: () => void
  let rejectReady!: (error: Error) => void
  let readySettled = false
  const readyPromise = new Promise<void>((resolve, reject) => {
    ready = () => {
      readySettled = true
      resolve()
    }
    rejectReady = reject
  })
  // A stop before READY is a failed start, exactly as the production transport reports it.
  void readyPromise.catch(() => {})
  let started!: () => void
  const startObserved = new Promise<void>((resolve) => {
    started = resolve
  })
  let markStopped!: () => void
  const stopObserved = new Promise<void>((resolve) => {
    markStopped = resolve
  })
  let starts = 0
  let stops = 0
  const configurePackets: Buffer[] = []
  const hostEvents: string[] = []
  let configureEntered!: () => void
  const configureEnteredPromise = new Promise<void>((resolve) => {
    configureEntered = resolve
  })
  const port: Cc5InteractiveHostPort = {
    ...(options.prepare
      ? { async prepare() {
        hostEvents.push('prepare')
        await options.prepareGate
        hostEvents.push('prepare-done')
      } }
      : {}),
    ...(options.configure
      ? { async configure(packet: Buffer) {
        configureEntered()
        await options.configureGate
        if (options.failConfigure) throw new Error('synthetic profile install failed')
        configurePackets.push(Buffer.from(packet))
        // Recorded on completion, so the event order is the order the remote saw.
        hostEvents.push('configure')
      } }
      : {}),
    start() {
      starts++
      hostEvents.push('start')
      financeEvents.push('host-start')
      started()
      if (failure === 'start') throw new Error('synthetic spawn status unknown')
      return { stdin: input, stdout: output, ready: readyPromise }
    },
    async stop() {
      stops++
      markStopped()
      rejectReady(new Error('synthetic host stopped'))
      // The node controller proves absence only from the round's LIFECYCLE record, which the
      // launch role writes before host.py prints READY (cc5-host-controller launch_locked).
      // Stopping a round the node never recorded yields no independent proof.
      if (!(readySettled && starts > 0)) throw new Error('synthetic remote absence unproved')
      if (failure === 'stop') throw new Error('synthetic remote absence unproved')
      return { remoteStopped: true }
    },
  }
  // Replacement launches get their own transport, as production builds a fresh ssh host.
  const replacements: Array<{ events: string[]; packets: Buffer[]; starts: number; written: Buffer[];
    ready: () => void; readySettled: boolean; input: PassThrough; output: PassThrough }> = []
  const replacementPort = (): Cc5InteractiveHostPort => {
    const replacement = { events: [] as string[], packets: [] as Buffer[], starts: 0,
      written: [] as Buffer[], ready: () => {}, readySettled: false, input: new PassThrough(),
      output: new PassThrough() }
    replacement.input.on('data', (bytes) => replacement.written.push(Buffer.from(bytes)))
    let resolveReady!: () => void
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve
    })
    void ready.catch(() => {})
    replacement.ready = () => {
      replacement.readySettled = true
      resolveReady()
    }
    let started!: () => void
    const startObserved = new Promise<void>((resolve) => {
      started = resolve
    })
    void startObserved.catch(() => {})
    replacements.push(replacement)
    return {
      async prepare() {
        replacement.events.push('prepare')
      },
      async configure(packet: Buffer) {
        replacement.packets.push(Buffer.from(packet))
        replacement.events.push('configure')
      },
      start() {
        replacement.starts++
        replacement.events.push('start')
        started()
        return { stdin: replacement.input, stdout: replacement.output, ready }
      },
      async stop() {
        replacement.events.push('stop')
        // Same controller rule as the initial transport: no lifecycle, no independent proof.
        if (!(replacement.readySettled && replacement.starts > 0))
          throw new Error('synthetic remote absence unproved')
        return { remoteStopped: true }
      },
    }
  }
  const runId = f.binding.runId
  const financeEvents: string[] = []
  const activeOperations = new Map<string, string>()
  const finance = {
    async admit(info: Parameters<Cc5FinancePort['admit']>[0]) {
      if (info.binding.expiresAt <= Date.now()) throw new Error('CC5_FINANCE_BINDING_EXPIRED')
      if (activeOperations.has(info.binding.operationId)) throw new Error('CC5_FINANCE_OPERATION_BUSY')
      const authority = verifyAuthority(info.authorityEnvelope, f.keyring, Date.now())
      activeOperations.set(info.binding.operationId, authority.billingRequestId!)
      financeEvents.push('admit')
      let hostAttempted = false
      return {
        async beforeHostStart() {
          hostAttempted = true
          financeEvents.push('host-effect')
        },
        async beforeDispatch() { financeEvents.push('dispatch-effect') },
        async terminal(receipt: unknown) {
          assert.ok(receipt && typeof receipt === 'object')
          if (activeOperations.get(info.binding.operationId) === authority.billingRequestId) {
            activeOperations.delete(info.binding.operationId)
          }
          financeEvents.push('settled')
          return { state: 'proven' as const, requestId: authority.billingRequestId! }
        },
        async stop(val: { hostStartAttempted: boolean; userSubmitted: boolean; remoteStopped: boolean }) {
          if (!hostAttempted && !val.hostStartAttempted && !val.userSubmitted && val.remoteStopped) {
            if (activeOperations.get(info.binding.operationId) === authority.billingRequestId) {
              activeOperations.delete(info.binding.operationId)
            }
          }
          financeEvents.push('stop')
        },
      }
    },
  }
  const relay = new Cc5Relay(f.binding, f.keyring, runId, port, join(f.root, 'relay-journal'), financeOverride ?? finance,
    { localStopTimeoutMs: 250, ...(options.replaceHost ? { replaceHost: replacementPort } : {}) })
  const socketPath = relative(process.cwd(), join(f.root, 'control.sock'))
  const toolSocket = relative(process.cwd(), join(f.root, 'tool.sock'))
  if (options.fastConnectionCheck) {
    for (const server of [relay.controlServer, relay.toolServer]) {
      server.connectionsCheckingInterval = 15
      server.headersTimeout = 10
      if (server.requestTimeout > 0) server.requestTimeout = 30
    }
  }
  relay.controlServer.listen(socketPath)
  relay.toolServer.listen(toolSocket)
  await Promise.all([once(relay.controlServer, 'listening'), once(relay.toolServer, 'listening')])
  const scope = { ...f.binding, sessionKey: f.request.sessionKey }
  const admit = (turn = { authority: f.request.authority, lease: f.request.lease, turnKey: f.request.turnKey }) =>
    cc5ControlRequest(
      '/admit',
      {
        ...scope,
        ...turn,
      },
      socketPath,
    )
  const lifecycleId = randomUUID()
  let registered = false
  const register = async (profile?: Record<string, unknown>) => {
    const accepted = await rpc(socketPath, '/tool/register', {
      ...scope,
      lifecycleId,
      ...(profile === undefined ? {} : { profile }),
    })
    registered = true
    return accepted
  }
  const stopped = () => rpc(socketPath, '/tool/stopped', { ...scope, lifecycleId, localStopped: true })
  const close = async () => {
    ready()
    if (registered) await stopped().catch(() => {})
    await relay.stop().catch(() => {})
    for (const server of [relay.controlServer, relay.toolServer]) {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    input.destroy()
    output.destroy()
  }
  return {
    relay,
    socketPath,
    toolSocket,
    scope,
    admit,
    ready,
    /** The launch fails before native READY, as a dead or stuck node would report it. */
    failReady: () => rejectReady(new Error('synthetic host never ready')),
    startObserved,
    stopObserved,
    close,
    input,
    output,
    written,
    runId,
    financeEvents,
    register,
    stopped,
    lifecycleId,
    configurePackets,
    configureEntered: configureEnteredPromise,
    hostEvents,
    replacements,
    counts: () => ({ starts, stops }),
  }
}
function rpcStatus(socketPath: string, path: string, body: unknown): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: 'POST' }, (res) => {
      res.resume()
      res.once('end', () => resolve(res.statusCode))
    })
    req.once('error', reject)
    req.end(JSON.stringify(body))
  })
}
function rpc(socketPath: string, path: string, body: unknown): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: 'POST' }, (res) => {
      let text = ''
      res.on('data', (b) => {
        text += b.toString()
      })
      res.once('end', () => {
        try {
          assert.equal(res.statusCode, 200)
          resolve(JSON.parse(text))
        } catch (e) {
          reject(e)
        }
      })
    })
    req.once('error', reject)
    req.end(JSON.stringify(body))
  })
}


async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000
  while (!check()) {
    assert.ok(Date.now() < deadline, 'fixture observation deadline')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}
async function stream(h: Awaited<ReturnType<typeof harness>>) {
  let response!: import('node:http').IncomingMessage
  const output: Buffer[] = []
  let ended = false
  const req = request({ socketPath: h.socketPath, path: '/session/open', method: 'POST' })
  req.on('error', () => {})
  const ready = new Promise<void>((resolve, reject) => {
    req.once('response', (res) => {
      response = res
      res.on('data', (bytes) => output.push(Buffer.from(bytes)))
      res.on('end', () => { ended = true })
      res.on('error', () => {})
      if (res.statusCode === 200) resolve()
      else { res.resume(); reject(new Error('stream not admitted')) }
    })
    req.once('error', reject)
  })
  req.write(`${JSON.stringify({ type: 'open', ...h.scope })}\n`)
  await ready
  let sequence = 0
  return {
    req, response, output, ended: () => ended,
    send(content = 'offline fixture') {
      const bytes = Buffer.from(`${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`)
      const frame = { seq: ++sequence, hash: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.toString('base64') }
      req.write(`${JSON.stringify(frame)}\n`)
      return frame
    },
    sendInterrupt() {
      const bytes = Buffer.from(`${JSON.stringify({ type: 'control_request', request_id: 'int-stdin-1', request: { subtype: 'interrupt' } })}\n`)
      const frame = { seq: ++sequence, hash: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.toString('base64') }
      req.write(`${JSON.stringify(frame)}\n`)
      return frame
    },
  }
}
function original(f: ReturnType<typeof fixture>, calls: Array<{ id: string; name?: string; input?: unknown }>) {
  return Buffer.from(`${JSON.stringify({ type: 'assistant', session_id: f.request.nativeSessionId,
    message: { model: 'claude-sonnet-5', content: calls.map((call) => ({ type: 'tool_use', id: call.id,
      name: call.name ?? f.request.name, input: call.input ?? f.request.arguments })) } })}\n`)
}
function terminal(f: ReturnType<typeof fixture>, extra: Record<string, unknown> = {}) {
  return Buffer.from(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
    session_id: f.request.nativeSessionId, uuid: f.nextResultId(),
    usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 11, cache_creation_input_tokens: 13 }, ...extra })}\n`)
}
async function start(f: ReturnType<typeof fixture>, finance?: Cc5FinancePort) {
  const h = await harness(f, 'none', finance)
  await h.register()
  h.ready()
  await h.admit()
  const s = await stream(h)
  s.send()
  await until(() => h.written.length === 1)
  h.output.write(`${JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-5', session_id: f.request.nativeSessionId })}\n`)
  return { h, s }
}
async function callTool(f: ReturnType<typeof fixture>, h: Awaited<ReturnType<typeof harness>>, id: string, rpcId: number,
  name = f.request.name, args: unknown = f.request.arguments, inputSha256 = cc5ToolInputSha256(args)) {
  const remote = rpc(h.toolSocket, '/roundtrip', { runId: h.runId, operationId: f.binding.operationId,
    rpcId, toolUseId: id, name, arguments: args, inputSha256 })
  void remote.catch(() => {})
  h.output.write(original(f, [{ id, name, input: args }]))
  const next = await rpc(h.socketPath, '/tool/next', h.scope)
  const delivery = next.delivery
  assert.equal(delivery.request.toolUseId, id)
  const receipt: Cc5ToolReceipt = { version: 2, scopeHash: cc5ToolScopeHash(delivery.request, delivery.admission), commandId: randomUUID(),
    dockerId: f.binding.dockerId, containerDbId: f.binding.containerDbId, operationId: f.binding.operationId,
    nativeSessionId: f.request.nativeSessionId, toolUseId: id, rpcId, name, inputSha256: cc5ToolInputSha256(args),
    result: { content: [{ type: 'text', text: 'real host fixture result' }], isError: false }, completedAt: Date.now() }
  return { remote, delivery, receipt,
    complete: async (value = receipt) => {
      const ack = await rpc(h.socketPath, '/tool/result', { ...h.scope, receipt: value })
      assert.equal(ack.commandId, value.commandId)
      const result = await remote
      assert.equal(result.version, 2)
      assert.deepEqual(result.result, value.result)
      return result
    } }
}

test('fresh financial admission precedes host startup; overlapping or reused identities cannot start effects', async () => {
  const f = fixture(); const h = await harness(f)
  try {
    const admission = h.admit()
    await h.startObserved
    assert.deepEqual(h.financeEvents, ['admit', 'host-effect', 'host-start'])
    await assert.rejects(h.admit(f.nextTurn()))
    h.ready(); await admission
    await assert.rejects(h.admit())
    assert.equal(h.counts().starts, 1)
    assert.equal(h.written.length, 0)
  } finally { await h.close(); f.cleanup() }
})

test('wrong UID/session/container and stream-before-admission fail before finance or host effects', async () => {
  for (const change of [{ uid: '999' }, { dockerId: 'c'.repeat(64) }, { sessionKey: 'agent:main:webchat:dm:different_chat' }]) {
    const f = fixture(); const h = await harness(f)
    try {
      await assert.rejects(rpc(h.socketPath, '/admit', { ...h.scope, ...change, authority: f.request.authority,
        lease: f.request.lease, turnKey: f.request.turnKey }))
      await assert.rejects(rpc(h.socketPath, '/session/open', { type: 'open', ...h.scope }))
      assert.deepEqual(h.financeEvents, [])
      assert.equal(h.counts().starts, 0)
    } finally { await h.close(); f.cleanup() }
  }
})

test('two serial user turns retain one native host/stream and settle distinct v2 receipts', async () => {
  const f = fixture(); const { h, s } = await start(f)
  try {
    const first = await callTool(f, h, 'read-1', 1); await first.complete()
    const edit = await callTool(f, h, 'edit-1', 2, 'mcp__ocbridge__Edit', { file_path: '/task/proof.txt', old_string: 'before', new_string: 'after' })
    await edit.complete({ ...edit.receipt, result: { content: [{ type: 'text', text: 'permission denied' }], isError: true } })
    h.output.write(terminal(f))
    await until(() => Buffer.concat(s.output).includes(Buffer.from('"type":"result"')))
    await assert.rejects(h.admit())
    for (const change of [
      { ...f.nextTurn(), turnKey: f.request.turnKey },
      { ...f.nextTurn(), authority: f.envelope({ ...f.a, authorityTurnId: randomBytes(16).toString('hex') }) },
    ]) await assert.rejects(h.admit(change))
    const next = f.nextTurn(); await h.admit(next)
    s.send('recall prior turn and read'); await until(() => h.written.length === 2)
    const read = await callTool(f, h, 'read-2', 3); await read.complete()
    h.output.write(terminal(f, { usage: { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }))
    await until(() => h.financeEvents.filter((event) => event === 'settled').length === 2)
    assert.deepEqual(h.counts(), { starts: 1, stops: 0 })
    assert.equal(h.financeEvents.filter((event) => event === 'host-effect').length, 2)
    const dirs = readdirSync(join(f.root, 'relay-journal')).filter((name) => /^[a-f0-9]{32}$/.test(name))
    assert.equal(dirs.length, 2)
    const receipts = dirs.map((dir) => JSON.parse(readFileSync(join(f.root, 'relay-journal', dir, 'native-terminal.json'), 'utf8')))
    assert.deepEqual(receipts.map((receipt) => receipt.usage.inputTokens).sort((a, b) => a - b), [2, 7])
    assert.ok(receipts.every((receipt) => receipt.version === 2 && receipt.nativeSessionId === f.request.nativeSessionId))
  } finally { s.req.destroy(); await h.close(); f.cleanup() }
})

/** The hash the node's MCP (cc5-fixed-mcp.py canonical) sends for these arguments. */
function nodeInputSha256(args: unknown): string {
  const script = fileURLToPath(new URL('../../../../scripts/agent-remote/cc5-fixed-mcp.py', import.meta.url))
  const child = spawnSync('python3', ['-I', '-B', '-c', 'import sys,json,hashlib,importlib.util\n' +
    'spec=importlib.util.spec_from_file_location("m",sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\n' +
    'print(hashlib.sha256(m.canonical(json.loads(sys.stdin.read()))).hexdigest())', script],
  { input: JSON.stringify(args), encoding: 'utf8', timeout: 5000 })
  assert.equal(child.status, 0, child.stderr)
  return child.stdout.trim()
}

test('nested arguments hashed by the node MCP are delivered: integer-like keys, small numbers, astral keys', async () => {
  // P4 audit r1: JSON.stringify ordered "2" before "10" and wrote 0.000001 where Python wrote 1e-06 -> 403.
  const f = fixture(); const { h } = await start(f)
  try {
    let rpcId = 1
    for (const args of [{ params: { '2': 'two', '10': 'ten' } }, { params: { value: 0.000001, tiny: 1e-7 } },
      { params: { '\u{1F600}': 1, '\uFFFF': 2 } }]) {
      const id = `extra-${rpcId}`
      const call = await callTool(f, h, id, rpcId++, 'mcp__ocbridge__ExecuteExtraTool', args, nodeInputSha256(args))
      assert.deepEqual(call.delivery.request.arguments, args)
      await call.complete()
    }
  } finally { await h.close(); f.cleanup() }
})

test('multiple original tool blocks queue serially and exact canonical input is required', async () => {
  const f = fixture(); const { h, s } = await start(f)
  try {
    const first = await callTool(f, h, 'read-1', 1, f.request.name, { limit: 2, file_path: '/task/proof.txt' })
    const second = rpc(h.toolSocket, '/roundtrip', { runId: h.runId, operationId: f.binding.operationId,
      rpcId: 2, toolUseId: 'bash-1', name: 'mcp__ocbridge__Bash', arguments: { command: 'true' }, inputSha256: cc5ToolInputSha256({ command: 'true' }) })
    void second.catch(() => {})
    h.output.write(original(f, [{ id: 'bash-1', name: 'mcp__ocbridge__Bash', input: { command: 'true' } }]))
    await first.complete()
    const next = await rpc(h.socketPath, '/tool/next', h.scope)
    const tool = next.delivery.request
    const receipt = { ...first.receipt, commandId: randomUUID(), toolUseId: tool.toolUseId, rpcId: tool.rpcId, name: tool.name,
      inputSha256: cc5ToolInputSha256(tool.arguments), scopeHash: cc5ToolScopeHash(tool, next.delivery.admission) }
    await rpc(h.socketPath, '/tool/result', { ...h.scope, receipt })
    assert.equal((await second).toolUseId, 'bash-1')
    assert.equal(h.counts().stops, 0)
  } finally { s.req.destroy(); await h.close(); f.cleanup() }
})

for (const fault of ['pending', 'throw', 'wrong-request']) test(`native terminal ${fault} retains unknown and withholds terminal bytes and next admission`, async () => {
  const f = fixture()
  const finance: Cc5FinancePort = { async admit() { return {
    async beforeHostStart() {}, async beforeDispatch() {}, async stop() {},
    async terminal() { if (fault === 'throw') throw new Error('commit ACK unknown')
      return fault === 'wrong-request' ? { state: 'proven', requestId: 'foreign-request' } : { state: 'pending' } },
  } } }
  const { h, s } = await start(f, finance)
  try {
    h.output.write(terminal(f)); await h.stopObserved
    await h.stopped(); await h.relay.stop()
    assert.equal(Buffer.concat(s.output).includes(Buffer.from('"type":"result"')), false)
    await assert.rejects(h.admit(f.nextTurn()))
  } finally { s.req.destroy(); await h.close(); f.cleanup() }
})

test('a terminal cannot settle while any original tool lacks a completed result', async () => {
  const f = fixture(); const { h, s } = await start(f)
  try {
    const tool = await callTool(f, h, 'read-1', 1)
    h.output.write(terminal(f)); await h.stopObserved
    await assert.rejects(tool.remote)
    assert.equal(h.financeEvents.includes('settled'), false)
    await h.stopped(); await h.relay.stop()
  } finally { s.req.destroy(); await h.close(); f.cleanup() }
})

test('changed observed arguments or a duplicate RPC cannot dispatch another tool effect', async () => {
  const f = fixture(); const { h, s } = await start(f)
  try {
    const tool = await callTool(f, h, 'read-1', 1); await tool.complete()
    await assert.rejects(rpc(h.toolSocket, '/roundtrip', { runId: h.runId, operationId: f.binding.operationId,
      rpcId: 1, toolUseId: 'read-2', name: f.request.name, arguments: f.request.arguments, inputSha256: cc5ToolInputSha256(f.request.arguments) }))
    await h.stopObserved
    assert.equal(h.financeEvents.includes('settled'), false)
  } finally { s.req.destroy(); await h.close(); f.cleanup() }
})

test('combined stop wakes output cleanup and requires the exact lifecycle clean-stop proof', async () => {
  const f = fixture(); const { h, s } = await start(f)
  try {
    let proven = false
    const stopping = h.relay.stop().then(() => { proven = true })
    await until(s.ended)
    assert.equal(proven, false)
    await assert.rejects(rpc(h.socketPath, '/tool/stopped', { ...h.scope, lifecycleId: randomUUID(), localStopped: true }))
    assert.equal(proven, false)
    await h.stopped(); await stopping
    assert.equal(proven, true)
    await assert.rejects(h.admit(f.nextTurn()))
  } finally { s.req.destroy(); await h.close(); f.cleanup() }
})

test('missing local clean exit times out as unknown and cannot be repaired into a successful stop', async () => {
  const f = fixture(); const { h, s } = await start(f)
  try {
    await assert.rejects(h.relay.stop())
    await h.stopped()
    await assert.rejects(h.relay.stop())
    await assert.rejects(h.admit(f.nextTurn()))
  } finally { s.req.destroy(); await h.close(); f.cleanup() }
})

test('independent remote absence proof is still required when local ToolHost stopped cleanly', async () => {
  const f = fixture(); const h = await harness(f, 'stop')
  try {
    await h.register(); h.ready(); await h.admit(); await h.stopped()
    await assert.rejects(h.relay.stop())
    assert.equal(h.counts().stops, 1)
  } finally { await h.close(); f.cleanup() }
})

test('unknown startup is burned once and wrong signed authority never starts a host', async () => {
  const f = fixture(); const h = await harness(f, 'start')
  try {
    h.ready(); await assert.rejects(h.admit()); await assert.rejects(h.admit())
    assert.equal(h.counts().starts, 1)
  } finally { await h.close(); f.cleanup() }
  const other = fixture(); const healthy = await harness(other)
  try {
    await assert.rejects(rpc(healthy.socketPath, '/admit', { ...healthy.scope, authority: other.envelope({ ...other.a, uid: 999 }),
      lease: other.request.lease, turnKey: other.request.turnKey }))
    assert.equal(healthy.counts().starts, 0)
    assert.deepEqual(healthy.financeEvents, [])
  } finally { await healthy.close(); other.cleanup() }
})

test('same stream sequence/hash is ignored but a conflicting input replay stops before a second dispatch', async () => {
  const f = fixture(); const { h, s } = await start(f)
  try {
    const first = JSON.parse(JSON.stringify({ seq: 1, bytes: h.written[0]!.toString('base64'),
      hash: createHash('sha256').update(h.written[0]!).digest('hex') }))
    s.req.write(`${JSON.stringify(first)}\n`)
    const bytes = Buffer.from(`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'conflicting' } })}\n`)
    s.req.write(`${JSON.stringify({ seq: 1, bytes: bytes.toString('base64'), hash: createHash('sha256').update(bytes).digest('hex') })}\n`)
    await h.stopObserved
    assert.equal(h.written.length, 1)
  } finally { s.req.destroy(); await h.close(); f.cleanup() }
})

test('tool execution requires lifecycle registration and the claimed canonical input hash', async () => {
  const f = fixture(); const h = await harness(f)
  let s: Awaited<ReturnType<typeof stream>> | undefined
  try {
    h.ready(); await h.admit(); s = await stream(h); s.send()
    await until(() => h.written.length === 1)
    const body = { runId: h.runId, operationId: f.binding.operationId, rpcId: 1, toolUseId: 'read-1',
      name: f.request.name, arguments: f.request.arguments, inputSha256: cc5ToolInputSha256(f.request.arguments) }
    await assert.rejects(rpc(h.toolSocket, '/roundtrip', body))
    await h.register()
    await assert.rejects(rpc(h.toolSocket, '/roundtrip', { ...body, inputSha256: '0'.repeat(64) }))
    assert.equal(h.counts().stops, 0)
    assert.equal(readdirSync(join(f.root, 'relay-journal', f.a.authorityTurnId)).some((name) => name.includes('attempt')), false)
  } finally { s?.req.destroy(); await h.close(); f.cleanup() }
})

test('admitted authority may expire while the current lease still permits tool delivery and receipt', async () => {
  const f = fixture(10000)
  const { h, s } = await start(f)
  const realNow = Date.now
  try {
    const remote = rpc(h.toolSocket, '/roundtrip', { runId: h.runId, operationId: f.binding.operationId,
      rpcId: 1, toolUseId: 'read-1', name: f.request.name, arguments: f.request.arguments, inputSha256: cc5ToolInputSha256(f.request.arguments) })
    void remote.catch(() => {})
    await until(() => readdirSync(join(f.root, 'relay-journal', f.a.authorityTurnId)).some((name) => name.endsWith('-attempt.json')))
    Date.now = () => f.a.expiresAt + 1000
    h.output.write(original(f, [{ id: 'read-1' }]))
    const { delivery } = await rpc(h.socketPath, '/tool/next', h.scope)
    const receipt: Cc5ToolReceipt = { version: 2, scopeHash: cc5ToolScopeHash(delivery.request, delivery.admission), commandId: randomUUID(),
      dockerId: f.binding.dockerId, containerDbId: f.binding.containerDbId, operationId: f.binding.operationId,
      nativeSessionId: f.request.nativeSessionId, toolUseId: 'read-1', rpcId: 1, name: f.request.name,
      inputSha256: cc5ToolInputSha256(f.request.arguments), result: { content: [{ type: 'text', text: 'complete' }], isError: false }, completedAt: Date.now() }
    await rpc(h.socketPath, '/tool/result', { ...h.scope, receipt })
    assert.deepEqual((await remote).result, receipt.result)
    const next = await callTool(f, h, 'read-2', 2)
    await next.complete()
    h.output.write(terminal(f))
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(h.financeEvents.includes('settled'), true)
    Date.now = realNow
    assert.equal(h.counts().stops, 0)
    assert.equal(readdirSync(join(f.root, 'relay-journal', f.a.authorityTurnId)).filter((name) => name.endsWith('-completed.json')).length, 2)
  } finally { Date.now = realNow; s.req.destroy(); await h.close(); f.cleanup() }
})


const RESULT_LIMIT = 128 * 1024
/** Wire bytes for these single-text-block fixtures: key order is already sorted. */
const resultBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value))

async function receiveToolResult(
  f: ReturnType<typeof fixture>,
  h: Awaited<ReturnType<typeof harness>>,
  id: string,
  rpcId: number,
  result: Cc5ToolReceipt['result'],
) {
  const remote = rpc(h.toolSocket, '/roundtrip', { runId: h.runId, operationId: f.binding.operationId,
    rpcId, toolUseId: id, name: f.request.name, arguments: f.request.arguments,
    inputSha256: cc5ToolInputSha256(f.request.arguments) })
  void remote.catch(() => {})
  await until(() => readdirSync(join(f.root, 'relay-journal', f.a.authorityTurnId)).some((name) => name.endsWith('-attempt.json')))
  h.output.write(original(f, [{ id }]))
  const { delivery } = await rpc(h.socketPath, '/tool/next', h.scope)
  const receipt: Cc5ToolReceipt = { version: 2, scopeHash: cc5ToolScopeHash(delivery.request, delivery.admission),
    commandId: randomUUID(), dockerId: f.binding.dockerId, containerDbId: f.binding.containerDbId,
    operationId: f.binding.operationId, nativeSessionId: f.request.nativeSessionId, toolUseId: id, rpcId,
    name: f.request.name, inputSha256: cc5ToolInputSha256(f.request.arguments), result, completedAt: Date.now() }
  await rpc(h.socketPath, '/tool/result', { ...h.scope, receipt })
  return { receipt, delivered: (await remote).result as Cc5ToolReceipt['result'] }
}

test('a 100KiB tool result crosses the relay envelope unchanged', async () => {
  const f = fixture()
  const { h, s } = await start(f)
  try {
    const produced: Cc5ToolReceipt['result'] = { content: [{ type: 'text', text: 'x'.repeat(100 * 1024) }], isError: false }
    const { receipt, delivered } = await receiveToolResult(f, h, 'read-large', 1, produced)
    assert.deepEqual(delivered, receipt.result)
    const completed = readdirSync(join(f.root, 'relay-journal', f.a.authorityTurnId))
      .filter((name) => name.endsWith('-completed.json'))
    assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'relay-journal', f.a.authorityTurnId, completed[0]), 'utf8')).result, produced)
  } finally { s.req.destroy(); await h.close(); f.cleanup() }
})

test('an oversized tool result is truncated for the model with its original byte count', async () => {
  const f = fixture()
  const { h, s } = await start(f)
  try {
    const produced: Cc5ToolReceipt['result'] = { content: [{ type: 'text', text: 'z'.repeat(140 * 1024) }], isError: true }
    const producedBytes = resultBytes(produced)
    const { delivered } = await receiveToolResult(f, h, 'read-oversized', 1, produced)
    assert.equal(delivered.isError, true)
    assert.equal(delivered.content.length, 1)
    assert.equal(delivered.content[0].type, 'text')
    const text = (delivered.content[0] as { type: string; text: string }).text
    assert.ok(text.startsWith('z'.repeat(4096)))
    assert.ok(text.endsWith(`[cc5 tool result truncated: original ${producedBytes} bytes]`))
    assert.ok(resultBytes(delivered) <= RESULT_LIMIT)
  } finally { s.req.destroy(); await h.close(); f.cleanup() }
})

test('dual-channel interrupt (HTTP + stdin) settles interrupted turn usage before admitting turn 2 without stopping host', async () => {
  const f = fixture()
  const { h, s } = await start(f)
  try {
    // 1) HTTP /interrupt arrives first, followed by stdin control_request interrupt (B1 race)
    const intRes = await rpc(h.socketPath, '/interrupt', h.scope)
    assert.equal(intRes.ok, true)
    assert.equal(intRes.interrupted, true)
    s.sendInterrupt()
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(h.counts().stops, 0)

    // 2) Host emits interrupted terminal result with real token usage; relay settles finance and releases activeOperations (B2)
    h.output.write(
      terminal(f, {
        subtype: 'interrupted',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      }),
    )
    await until(() => h.financeEvents.filter((e) => e === 'settled').length === 1)
    assert.equal(h.counts().stops, 0)

    // 3) Even a late trailing stdin interrupt after idle is idempotent and does not stop the host
    s.sendInterrupt()
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(h.counts().stops, 0)

    // 4) Turn 2 admission succeeds because turn 1 finance activeOperations was properly released by receipt settlement
    const next = f.nextTurn()
    const admitted = await h.admit(next)
    assert.equal(admitted.ready, true)
    s.send('second turn after interrupt')
    await until(() => h.written.length >= 3)
    h.output.write(terminal(f))
    await until(() => h.financeEvents.filter((e) => e === 'settled').length === 2)
    assert.deepEqual(h.counts(), { starts: 1, stops: 0 })
  } finally { s.req.destroy(); await h.close(); f.cleanup() }
})

test('stream transport disconnect detaches without stop, higher generation fences stale writer, and sequence gap returns 409', async () => {
  const f = fixture()
  const { h, s } = await start(f)
  let req2: ReturnType<typeof request> | undefined
  let reqGap: ReturnType<typeof request> | undefined
  try {
    h.output.write(terminal(f))
    await until(() => Buffer.concat(s.output).includes(Buffer.from('"type":"result"')))
    const next = f.nextTurn()
    await h.admit(next)

    // Abrupt client disconnect (ECONNRESET / destroy) detaches stream without stopping remote host (B4)
    s.req.destroy(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(h.counts().stops, 0)

    // Reconnect with generation=1 and lastAckedSeq=0 replays buffered frames
    const replayed: Buffer[] = []
    req2 = request({ socketPath: h.socketPath, path: '/session/open', method: 'POST' })
    req2.on('error', () => {})
    const ready2 = new Promise<void>((resolve, reject) => {
      req2!.once('response', (res) => {
        res.on('data', (bytes) => replayed.push(Buffer.from(bytes)))
        res.on('error', () => {})
        if (res.statusCode === 200) resolve()
        else reject(new Error(`reconnect stream not admitted: ${String(res.statusCode)}`))
      })
      req2!.once('error', reject)
    })
    req2.write(`${JSON.stringify({ type: 'open', generation: 1, lastAckedSeq: 0, ...h.scope })}\n`)
    await ready2
    await until(() => Buffer.concat(replayed).includes(Buffer.from('"type":"result"')))
    assert.equal(h.counts().stops, 0)
  } finally { reqGap?.destroy(); req2?.destroy(); s.req.destroy(); await h.close(); f.cleanup() }
})

/** One lane catalog shaped the way the bridge compiles it: tools under `mcp__ocbridge__<alias>`. */
function toolProfile(
  tools: Array<{ alias: string; client: string }> = [{ alias: 'Read', client: 'Read' }],
  prompt = 'fixture lane prompt',
) {
  const catalog = JSON.stringify({
    tools: tools.map(({ alias }) => ({
      name: alias,
      description: `${alias} tool`,
      inputSchema: { type: 'object', properties: {} },
    })),
  })
  return {
    catalog,
    catalogSha256: createHash('sha256').update(catalog).digest('hex'),
    prompt,
    toolNames: Object.fromEntries(tools.map(({ alias, client }) => [`mcp__ocbridge__${alias}`, client])) as Record<string, string>,
  }
}
/** The byte-exact packet the relay must hand to a profile-taking host. */
function profilePacket(profile: ReturnType<typeof toolProfile>): Buffer {
  return Buffer.from(JSON.stringify({ version: 1, catalog: profile.catalog,
    catalogSha256: profile.catalogSha256, prompt: profile.prompt }))
}
/** Records the finance turn's stop verdict; the relay verifies the signed authority itself. */
function financeProbe() {
  const events: string[] = []
  const stops: Array<{ hostStartAttempted: boolean; userSubmitted: boolean; remoteStopped: boolean }> = []
  const finance: Cc5FinancePort = {
    async admit() {
      events.push('admit')
      return {
        async beforeHostStart() { events.push('host-effect') },
        async beforeDispatch() { events.push('dispatch-effect') },
        async terminal() { throw new Error('unexpected terminal') },
        async stop(value) { events.push('stop'); stops.push(value) },
      }
    },
  }
  return { finance, events, stops }
}

test('a profile-taking host is not started by admission; the first stream configures it byte-exactly then starts once', async () => {
  const f = fixture()
  const h = await harness(f, 'none', undefined, { configure: true })
  let s: Awaited<ReturnType<typeof stream>> | undefined
  try {
    h.ready()
    const admitted = await h.admit()
    assert.equal(admitted.ready, true)
    // Admission alone has no catalog, so it must neither configure nor launch the host.
    assert.equal(h.counts().starts, 0)
    assert.deepEqual(h.hostEvents, [])
    assert.equal(h.configurePackets.length, 0)

    const profile = toolProfile()
    const registered = await h.register(profile)
    assert.deepEqual(registered.toolNames, profile.toolNames)
    // Registration only fixes the catalog; the host still waits for the stream.
    assert.equal(h.counts().starts, 0)
    assert.deepEqual(h.hostEvents, [])

    s = await stream(h)
    assert.deepEqual(h.hostEvents, ['configure', 'start'])
    assert.equal(h.configurePackets.length, 1)
    assert.deepEqual(h.configurePackets[0], profilePacket(profile))
    assert.equal(h.counts().starts, 1)
  } finally { s?.req.destroy(); await h.close(); f.cleanup() }
})

test('a profile-taking host rejects missing or invalid profiles while a legacy host accepts them', async () => {
  const f = fixture()
  const h = await harness(f, 'none', undefined, { configure: true })
  try {
    const valid = toolProfile()
    const invalid: Array<[string, unknown]> = [
      ['missing profile', undefined],
      ['bad catalog sha', { ...valid, catalogSha256: '0'.repeat(64) }],
      ['toolNames not matching the catalog', { ...toolProfile([{ alias: 'Read', client: 'Read' }]),
        toolNames: { mcp__ocbridge__Bash: 'Bash' } }],
      ['oversize prompt', { ...valid, prompt: 'p'.repeat(CC5_PROMPT_MAX_BYTES + 1) }],
    ]
    for (const [label, profile] of invalid) {
      await assert.rejects(
        rpc(h.socketPath, '/tool/register', { ...h.scope, lifecycleId: h.lifecycleId,
          ...(profile === undefined ? {} : { profile }) }),
        Error,
        label,
      )
    }
    // No rejected registration reaches the journal or burns the lifecycle.
    assert.deepEqual(readdirSync(join(f.root, 'relay-journal')), [])
    assert.equal(h.counts().starts, 0)
    const accepted = await h.register(valid)
    assert.deepEqual(accepted.toolNames, valid.toolNames)
  } finally { await h.close(); f.cleanup() }
})

test('a legacy host without configure still accepts a profile-less registration', async () => {
  const f = fixture()
  const h = await harness(f)
  let s: Awaited<ReturnType<typeof stream>> | undefined
  try {
    const registered = await h.register()
    assert.equal(registered.toolNames, null)
    h.ready()
    const admitted = await h.admit()
    assert.equal(admitted.ready, true)
    assert.deepEqual(h.hostEvents, ['start'])
    s = await stream(h)
    assert.equal(h.counts().starts, 1)
  } finally { s?.req.destroy(); await h.close(); f.cleanup() }
})

test('an ocbridge alias outside the registered catalog is rejected before any attempt journal or delivery', async () => {
  const f = fixture()
  const h = await harness(f, 'none', undefined, { configure: true })
  let s: Awaited<ReturnType<typeof stream>> | undefined
  try {
    await h.register(toolProfile([{ alias: 'Read', client: 'Read' }]))
    h.ready()
    await h.admit()
    s = await stream(h)
    s.send()
    await until(() => h.written.length === 1)
    h.output.write(`${JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-5', session_id: f.request.nativeSessionId })}\n`)

    // Well-formed alias, well-formed input, but not in the catalog the host was launched with.
    const args = { command: 'true' }
    await assert.rejects(rpc(h.toolSocket, '/roundtrip', { runId: h.runId, operationId: f.binding.operationId,
      rpcId: 1, toolUseId: 'bash-1', name: 'mcp__ocbridge__Bash', arguments: args,
      inputSha256: cc5ToolInputSha256(args) }))
    const journal = readdirSync(join(f.root, 'relay-journal', f.a.authorityTurnId))
    assert.deepEqual(journal.filter((name) => name.endsWith('-attempt.json')), [])
    assert.equal(h.counts().stops, 0)

    // The next delivery must be the catalogued call: an uncatalogued tool never reached /tool/next.
    const read = await callTool(f, h, 'read-1', 2)
    await read.complete()
  } finally { s?.req.destroy(); await h.close(); f.cleanup() }
})

test('re-registration after launch keeps the first catalog even with replace and a different profile', async () => {
  const f = fixture()
  const h = await harness(f, 'none', undefined, { configure: true })
  let s: Awaited<ReturnType<typeof stream>> | undefined
  try {
    const first = toolProfile([{ alias: 'Read', client: 'Read' }])
    const initial = await h.register(first)
    assert.deepEqual(initial.toolNames, first.toolNames)
    h.ready()
    await h.admit()
    // With a catalog already registered, admission is what launches the host exactly once.
    assert.deepEqual(h.hostEvents, ['configure', 'start'])
    assert.deepEqual(h.configurePackets, [profilePacket(first)])
    s = await stream(h)

    const second = toolProfile([{ alias: 'Edit', client: 'Edit' }])
    const replaced = await rpc(h.socketPath, '/tool/register', { ...h.scope, lifecycleId: h.lifecycleId,
      replace: true, profile: second })
    assert.deepEqual(replaced.toolNames, first.toolNames)
    // The launch profile is untouched: no second configure, no restart.
    assert.deepEqual(h.configurePackets, [profilePacket(first)])
    assert.equal(h.counts().starts, 1)
  } finally { s?.req.destroy(); await h.close(); f.cleanup() }
})

test('a stale catalog after the launch READY replaces the wrongly launched remote inside the same turn', async () => {
  const f = fixture()
  const fin = financeProbe()
  const h = await harness(f, 'none', fin.finance, { configure: true, prepare: true, replaceHost: true })
  let s: Awaited<ReturnType<typeof stream>> | undefined
  try {
    const first = toolProfile([{ alias: 'Read', client: 'Read' }])
    await h.register(first)
    const admitted = h.admit()
    void admitted.catch(() => {})
    await h.startObserved
    // The launch role committed its LIFECYCLE record and host.py printed READY.
    h.ready()
    const second = toolProfile([{ alias: 'Edit', client: 'Edit' }])
    const replaced = await rpc(h.socketPath, '/tool/register', { ...h.scope, lifecycleId: h.lifecycleId,
      replace: true, relaunch: true, profile: second })
    assert.deepEqual(replaced.toolNames, second.toolNames)
    assert.equal(h.replacements.length, 1)
    assert.deepEqual(h.replacements[0]!.packets, [profilePacket(second)])
    // The replacement's tool socket rotates the old round first: the controller refuses
    // `session-profile` while the old LIFECYCLE record still proves the previous round.
    assert.deepEqual(h.replacements[0]!.events, ['prepare', 'configure', 'start'])
    assert.equal(h.counts().stops, 1)
    h.replacements[0]!.ready()
    // Admission and the stream both wait for the replacement, not for the abandoned launch.
    await admitted
    s = await stream(h)
    s.send()
    await until(() => h.replacements[0]!.written.length === 1)
    assert.equal(h.written.length, 0, 'the replaced launch must not receive turn content')
    const stale = await rpcStatus(h.toolSocket, '/roundtrip', { runId: h.runId,
      operationId: f.binding.operationId, rpcId: 7, toolUseId: 'toolu_stale',
      name: 'mcp__ocbridge__Read', arguments: f.request.arguments,
      inputSha256: cc5ToolInputSha256(f.request.arguments) })
    assert.equal(stale, 403)
  } finally { s?.req.destroy(); await h.close(); f.cleanup() }
})

test('a stale catalog before the launch READY waits for the node lifecycle before replacing', async () => {
  const f = fixture()
  const fin = financeProbe()
  const h = await harness(f, 'none', fin.finance, { configure: true, prepare: true, replaceHost: true })
  let s: Awaited<ReturnType<typeof stream>> | undefined
  try {
    const first = toolProfile([{ alias: 'Read', client: 'Read' }])
    await h.register(first)
    const admitted = h.admit()
    void admitted.catch(() => {})
    await h.startObserved
    // start() only scheduled the launch role: the node has no LIFECYCLE.json to prove against,
    // so its stop would answer `already-stopped` and never yield an independent absence proof.
    const second = toolProfile([{ alias: 'Edit', client: 'Edit' }])
    let settled: Record<string, unknown> | undefined
    const pending = rpc(h.socketPath, '/tool/register', { ...h.scope, lifecycleId: h.lifecycleId,
      replace: true, relaunch: true, profile: second })
    void pending.then((value) => { settled = value }, () => {})
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(settled, undefined, 'the replacement waits for the launched host to be confirmed')
    assert.equal(h.replacements.length, 0)
    assert.equal(h.counts().stops, 0, 'no stop is issued before the lifecycle record exists')
    // Native READY: the controller wrote LIFECYCLE.json before it exec'd host.py.
    h.ready()
    const replaced = await pending
    assert.deepEqual(replaced.toolNames, second.toolNames)
    assert.equal(h.replacements.length, 1)
    assert.deepEqual(h.replacements[0]!.events, ['prepare', 'configure', 'start'])
    assert.deepEqual(h.replacements[0]!.packets, [profilePacket(second)])
    assert.equal(h.counts().stops, 1)
    // The replaced launch's own streams are dying on purpose; they must not revoke the turn.
    h.input.emit('error', new Error('dying stdin of the replaced launch'))
    h.replacements[0]!.ready()
    await admitted
    assert.equal(h.relay.stopped, false)
    s = await stream(h)
    s.send()
    await until(() => h.replacements[0]!.written.length === 1)
    assert.equal(h.written.length, 0, 'the replaced launch must not receive turn content')
    await h.stopped()
    await h.relay.stop()
    assert.equal(fin.events.filter((event) => event === 'admit').length, 1)
    assert.equal(fin.events.filter((event) => event === 'host-effect').length, 1)
    assert.deepEqual(fin.stops, [{ hostStartAttempted: true, userSubmitted: true, remoteStopped: true }])
  } finally { s?.req.destroy(); await h.close(); f.cleanup() }
})

test('a second mismatch while the replacement waits for READY coalesces into one replacement', async () => {
  const f = fixture()
  const fin = financeProbe()
  const h = await harness(f, 'none', fin.finance, { configure: true, prepare: true, replaceHost: true })
  let s: Awaited<ReturnType<typeof stream>> | undefined
  try {
    const first = toolProfile([{ alias: 'Read', client: 'Read' }])
    await h.register(first)
    const admitted = h.admit()
    void admitted.catch(() => {})
    await h.startObserved
    const second = toolProfile([{ alias: 'Edit', client: 'Edit' }])
    const third = toolProfile([{ alias: 'Bash', client: 'Bash' }])
    const firstRegister = rpc(h.socketPath, '/tool/register', { ...h.scope, lifecycleId: h.lifecycleId,
      replace: true, relaunch: true, profile: second })
    void firstRegister.catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(h.replacements.length, 0)
    // Accepted while the replacement still waits: the newest catalog wins, no second factory.
    const accepted = await rpc(h.socketPath, '/tool/register', { ...h.scope, lifecycleId: h.lifecycleId,
      replace: true, relaunch: true, profile: third })
    assert.deepEqual(accepted.toolNames, third.toolNames)
    assert.equal(h.replacements.length, 0, 'still waiting for the launched host READY')
    h.ready()
    assert.deepEqual((await firstRegister).toolNames, third.toolNames)
    assert.equal(h.replacements.length, 1)
    assert.deepEqual(h.replacements[0]!.events, ['prepare', 'configure', 'start'])
    assert.deepEqual(h.replacements[0]!.packets, [profilePacket(third)])
    assert.equal(h.counts().stops, 1)
    h.replacements[0]!.ready()
    await admitted
    s = await stream(h)
    s.send()
    await until(() => h.replacements[0]!.written.length === 1)
    assert.equal(h.written.length, 0)
    await h.stopped()
    await h.relay.stop()
    assert.equal(fin.events.filter((event) => event === 'admit').length, 1)
    assert.deepEqual(fin.stops, [{ hostStartAttempted: true, userSubmitted: true, remoteStopped: true }])
  } finally { s?.req.destroy(); await h.close(); f.cleanup() }
})

test('a launch that never becomes ready replaces nothing and leaves the stop unproven', async () => {
  const f = fixture()
  const fin = financeProbe()
  const h = await harness(f, 'none', fin.finance, { configure: true, prepare: true, replaceHost: true })
  try {
    await h.register(toolProfile())
    const admitted = h.admit()
    void admitted.catch(() => {})
    await h.startObserved
    const pending = rpcStatus(h.socketPath, '/tool/register', { ...h.scope, lifecycleId: h.lifecycleId,
      replace: true, relaunch: true, profile: toolProfile([{ alias: 'Edit', client: 'Edit' }]) })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(h.replacements.length, 0)
    // The launch fails before READY: the node never recorded this round, so nothing can be proven.
    h.failReady()
    assert.equal(await pending, 403)
    await assert.rejects(admitted)
    await h.relay.stop().catch(() => {})
    assert.equal(h.replacements.length, 0)
    assert.equal(h.written.length, 0, 'no user frame reached any host')
    assert.equal(fin.events.filter((event) => event === 'admit').length, 1)
    assert.equal(fin.events.filter((event) => event === 'host-effect').length, 1)
    assert.deepEqual(fin.stops, [{ hostStartAttempted: true, userSubmitted: false, remoteStopped: false }])
  } finally { await h.close(); f.cleanup() }
})

test('a replacement is refused once the user frame reached the remote', async () => {
  const f = fixture()
  const h = await harness(f, 'none', undefined, { configure: true, replaceHost: true })
  let s: Awaited<ReturnType<typeof stream>> | undefined
  try {
    const first = toolProfile([{ alias: 'Read', client: 'Read' }])
    await h.register(first)
    h.ready()
    await h.admit()
    s = await stream(h)
    s.send()
    await until(() => h.written.length === 1)
    const second = toolProfile([{ alias: 'Edit', client: 'Edit' }])
    const status = await rpcStatus(h.socketPath, '/tool/register', { ...h.scope, lifecycleId: h.lifecycleId,
      replace: true, relaunch: true, profile: second })
    assert.equal(status, 403)
    assert.equal(h.replacements.length, 0)
    assert.deepEqual(h.configurePackets, [profilePacket(first)])
  } finally { s?.req.destroy(); await h.close(); f.cleanup() }
})

test('a fresh lane installs the session profile before the tool socket and launches last', async () => {
  const f = fixture()
  const h = await harness(f, 'none', undefined, { configure: true, prepare: true })
  try {
    const profile = toolProfile()
    await h.register(profile)
    h.ready()
    await h.admit()
    // The node controller's tool-socket role validates the installed session, so the fresh
    // lane's profile install must finish first; the socket then opens and launch is last.
    assert.deepEqual(h.hostEvents, ['configure', 'prepare', 'prepare-done', 'start'])
    assert.deepEqual(h.configurePackets, [profilePacket(profile)])
    assert.equal(h.counts().starts, 1)
  } finally { await h.close(); f.cleanup() }
})

test('a failed profile install never opens the tool socket nor launches the remote', async () => {
  const f = fixture()
  const h = await harness(f, 'none', undefined, { configure: true, prepare: true, failConfigure: true })
  try {
    await h.register(toolProfile())
    h.ready()
    await assert.rejects(h.admit())
    assert.deepEqual(h.hostEvents, [])
    assert.equal(h.counts().starts, 0)
  } finally { await h.close(); f.cleanup() }
})

test('a live catalog during the fresh profile install re-installs it before the launch', async () => {
  const f = fixture()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const h = await harness(f, 'none', undefined, { configure: true, prepare: true, configureGate: gate })
  let s: Awaited<ReturnType<typeof stream>> | undefined
  try {
    const first = toolProfile([{ alias: 'Read', client: 'Read' }])
    await h.register(first)
    h.ready()
    const admitted = h.admit()
    void admitted.catch(() => {})
    await h.configureEntered
    // The bridge's live tools/list found the cached catalog stale while the first install ran.
    const second = toolProfile([{ alias: 'Edit', client: 'Edit' }])
    const replaced = rpc(h.socketPath, '/tool/register', { ...h.scope, lifecycleId: h.lifecycleId,
      replace: true, relaunch: true, profile: second })
    // Adopted (200) while the first install is still held: the start sequence, not this reply,
    // carries the newest profile to the node.
    assert.deepEqual((await replaced).toolNames, second.toolNames)
    release()
    await admitted
    assert.deepEqual(h.configurePackets, [profilePacket(first), profilePacket(second)])
    // No second launch: the same lane started once, with the new catalog, and was never replaced.
    assert.equal(h.counts().starts, 1)
    assert.equal(h.replacements.length, 0)
    s = await stream(h)
    s.send()
    await until(() => h.written.length === 1)
    // The tool socket opened after both installs and the launch carries the newest catalog.
    assert.deepEqual(h.hostEvents, ['configure', 'configure', 'prepare', 'prepare-done', 'start'])
    // The abandoned alias is not part of the launched catalog; only the new one is accepted.
    const stale = await rpcStatus(h.toolSocket, '/roundtrip', { runId: h.runId,
      operationId: f.binding.operationId, rpcId: 3, toolUseId: 'toolu_old_alias',
      name: 'mcp__ocbridge__Read', arguments: f.request.arguments,
      inputSha256: cc5ToolInputSha256(f.request.arguments) })
    assert.equal(stale, 403)
  } finally { s?.req.destroy(); await h.close(); f.cleanup() }
})

test('a live catalog after the profile install but before the launch only re-installs the profile', async () => {
  const f = fixture()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const h = await harness(f, 'none', undefined, { configure: true, prepare: true, prepareGate: gate })
  let s: Awaited<ReturnType<typeof stream>> | undefined
  try {
    const first = toolProfile([{ alias: 'Read', client: 'Read' }])
    await h.register(first)
    h.ready()
    const admitted = h.admit()
    void admitted.catch(() => {})
    await until(() => h.hostEvents.includes('prepare'))
    const second = toolProfile([{ alias: 'Edit', client: 'Edit' }])
    const replaced = rpc(h.socketPath, '/tool/register', { ...h.scope, lifecycleId: h.lifecycleId,
      replace: true, relaunch: true, profile: second })
    assert.deepEqual((await replaced).toolNames, second.toolNames)
    release()
    await admitted
    assert.deepEqual(h.configurePackets, [profilePacket(first), profilePacket(second)])
    assert.equal(h.counts().starts, 1)
    assert.equal(h.replacements.length, 0)
    s = await stream(h)
    s.send()
    await until(() => h.written.length === 1)
    // The installed socket is reused (the helper reads the catalog per request); launch is last.
    assert.deepEqual(h.hostEvents, ['configure', 'prepare', 'prepare-done', 'configure', 'prepare',
      'prepare-done', 'start'])
  } finally { s?.req.destroy(); await h.close(); f.cleanup() }
})

test('controlServer and toolServer disable requestTimeout so long-lived /session/open streams are not aborted by connection checks', async () => {
  const f = fixture()
  const h = await harness(f, 'none', undefined, { fastConnectionCheck: true })
  let s: Awaited<ReturnType<typeof stream>> | undefined
  try {
    await h.register()
    h.ready()
    await h.admit()
    s = await stream(h)
    let aborted = false
    s.response.once('aborted', () => {
      aborted = true
    })
    s.send('long turn before connection check window')
    await until(() => h.written.length === 1)
    h.output.write(`${JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-5', session_id: f.request.nativeSessionId })}\n`)
    // Wait past multiple connection check intervals while /session/open request body remains open
    await new Promise((resolve) => setTimeout(resolve, 120))
    assert.equal(aborted, false, '/session/open stream must not be aborted by http.Server requestTimeout')
    assert.equal(s.response.destroyed, false)
    assert.equal(h.relay.controlServer.requestTimeout, 0)
    assert.equal(h.relay.toolServer.requestTimeout, 0)
    h.output.write(terminal(f))
    await until(() => h.financeEvents.includes('settled'))
  } finally { s?.req.destroy(); await h.close(); f.cleanup() }
})

