import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { createServer } from 'node:http'
import { PassThrough } from 'node:stream'
import { afterEach, test } from 'node:test'
import { type Cc5BridgeBinding, type Cc5BridgePort, UnixCc5BridgePort } from '../cc5BridgePort.js'
import { runCc5StdioBridge } from '../cc5StdioBridge.js'
import { Cc5InteractiveAdapter } from '../engine/cc5InteractiveAdapter.js'
import { cc5ResumeId } from '../engine/cc5ResumeId.js'
import { createCcbBackend } from '../engine/ccbFactory.js'
import { CcbAdapter } from '../engine/ccbAdapter.js'
import { probeResumeArtifact } from '../engine/resumeArtifacts.js'
import { _resumeIdFor } from '../sessionSubmit.js'
import { SubprocessRunner, __setCcbSpawnForTests } from '../subprocessRunner.js'

const binding: Cc5BridgeBinding = {
  version: 2,
  backendKind: 'cc5-interactive-v1',
  canonicalModel: 'box-claude-sonnet-5',
  sessionKey: 'agent:main:webchat:dm:cc5native1',
  runId: randomUUID(),
  uid: '912',
  containerDbId: '91',
  dockerId: 'a'.repeat(64),
  operationId: randomUUID(),
  capability: 'b'.repeat(64),
  expiresAt: Date.now() + 120000,
}
const executionBackend = { kind: 'cc5-interactive-v1' as const, sessionKey: binding.sessionKey, operationId: binding.operationId }
const descriptor = {
  canonicalModel: binding.canonicalModel,
  executionBackend,
  contextOwner: 'box-native-v1' as const,
  contextWindow: 200000,
  capabilityZero: true,
  supportsThinking: true,
  supportsVision: false,
  supportedEfforts: [],
}
const authority = {
  authorityEnvelope: 'synthetic-authority',
  leaseEnvelope: 'synthetic-lease',
  executionDescriptor: descriptor,
}
const spawnOpts = {
  command: process.execPath,
  args: ['synthetic-child'],
  ccbBinaryDir: process.cwd(),
  env: { LANG: 'C.UTF-8' },
  stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
}
class FakeProc extends EventEmitter {
  pid = 42424242
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  kill(): boolean {
    this.emit('close', 0, null)
    return true
  }
  constructor() {
    super()
    this.stdin.on('finish', () => queueMicrotask(() => this.emit('close', 0, null)))
  }
}
afterEach(() => __setCcbSpawnForTests(null))

function fixture(admitError?: string) {
  const proc = new FakeProc()
  const writes: string[] = []
  proc.stdin.on('data', (bytes) => writes.push(bytes.toString()))
  let prepared = 0
  let admitted = 0
  let renewed = 0
  let stopped = 0
  const laneProfiles: unknown[] = []
  const port: Cc5BridgePort = {
    bindingId: binding.operationId,
    executionBackend,
    canonicalModel: binding.canonicalModel,
    async prepare(input) {
      assert.equal(admitted, 1, 'budget/admission must happen before bridge preparation/spawn')
      prepared++
      // The remote model gets a local chat's platform prompt and tool sources, run in this container.
      const lane = JSON.parse(readFileSync(input!.laneProfile!, 'utf8'))
      assert.equal(lane.version, 1)
      assert.match(lane.platformPrompt, /\S/)
      assert.equal(typeof lane.host.mcpConfigPath, 'string')
      assert.ok(JSON.parse(readFileSync(lane.host.mcpConfigPath, 'utf8')).mcpServers['openclaude-memory'])
      assert.deepEqual(lane.host.disallowedTools, ['SendMessage'])
      assert.equal(input!.cwd, lane.host.cwd)
      for (const key of Object.keys(input!.env!)) assert.doesNotMatch(key, /^(ANTHROPIC_|CLAUDE_CODE_OAUTH)|_API_KEY$/)
      laneProfiles.push(lane)
      return spawnOpts
    },
    async admit() {
      admitted++
      if (admitError) throw new Error(admitError)
    },
    async renew() {
      renewed++
    },
    async close() {
      stopped++
    },
  }
  const config = {
    terminal: { type: 'local' },
    get defaults() {
      throw new Error('OLD_CONFIG_TOUCHED')
    },
    // Only selects which platform MCP servers a local chat would get; never model auth.
    provider: 'anthropic',
    mcpServers: [],
    auth: {},
    gateway: { port: 18790, accessToken: 'fixture-token' },
  }
  const opts = {
    sessionKey: binding.sessionKey,
    executionBackend,
    agentId: 'main',
    agentBaseDir: process.cwd(),
    model: descriptor.canonicalModel,
    config: config as never,
    cc5BridgePort: port,
    harness: 'official-cc' as const,
    boxResidentCc: true,
    authorityEngine: 'ccb' as const,
    prepareBoxCc: async () => {
      throw new Error('OLD_BOX_POOL_TOUCHED')
    },
  }
  __setCcbSpawnForTests((got) => {
    assert.deepEqual(got, spawnOpts)
    return proc as never
  })
  return { proc, writes, port, opts, laneProfiles, counts: () => ({ prepared, admitted, renewed, stopped }) }
}

test('cc5 Runner skips old auth/setup, ships the platform lane profile; original fragmented output and lease use the dedicated port', async () => {
  const f = fixture()
  const runner = new SubprocessRunner(f.opts)
  const messages: unknown[] = []
  runner.on('message', (message) => messages.push(message))
  await runner.submit('literal user sentence', undefined, authority, 'turn1')
  assert.equal(f.counts().prepared, 1)
  assert.equal(f.counts().admitted, 1)
  assert.equal(f.laneProfiles.length, 1)
  assert.equal(f.writes.length, 1)
  assert.equal(JSON.parse(f.writes[0]!).type, 'user')
  f.proc.stdout.write('{"type":"assistant","message":{"content":[{"type":"text","text":"real')
  f.proc.stdout.write(' bytes"}]}}\n')
  assert.deepEqual(messages, [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'real bytes' }] } },
  ])
  await runner.updateTurnLease('renewed-lease')
  assert.equal(f.counts().renewed, 1)
  assert.equal(f.writes.length, 1)
  assert.equal((await runner.writeDelegateUserMessage('must not inject')).ok, false)
  await runner.shutdown()
  assert.equal(f.counts().stopped, 1)
})

test('cc5 admission ACK loss writes zero user frames and has no implicit retry', async () => {
  const f = fixture('ACK_LOST_UNKNOWN')
  const runner = new SubprocessRunner(f.opts)
  await assert.rejects(
    runner.submit('do not resend', undefined, authority, 'turn1'),
    /ACK_LOST_UNKNOWN/,
  )
  assert.equal(f.counts().admitted, 1)
  assert.deepEqual(f.writes, [])
  await runner.shutdown()
})

test('cc5 rejects missing authority/readOnly before spawning and never pins the CCB harness', async () => {
  const f = fixture()
  const runner = new SubprocessRunner(f.opts)
  await assert.rejects(runner.start(), /AUTHORITY_REQUIRED/)
  await assert.rejects(runner.submit('x'), /AUTHORITY_REQUIRED/)
  runner.setReadOnly(true)
  await assert.rejects(runner.submit('x', undefined, authority, 't'), /AUTHORITY_REQUIRED/)
  assert.equal(f.counts().prepared, 0)
  assert.throws(
    () => runner.pinBoxNativeHarness({ ...descriptor, contextOwner: 'box-native' as never }),
    /AUTHORITY_REQUIRED/,
  )
})

test('cc5 port snapshots mutable lease, burns admission on unknown, and requires positive remote stop', async () => {
  let calls = 0
  const port = new UnixCc5BridgePort(binding, binding.sessionKey, async (path, body) => {
    calls++
    if (path === '/stop') return { ok: true, remoteStopped: false }
    assert.equal(body.lease, 'synthetic-lease')
    await new Promise((resolve) => setImmediate(resolve))
    throw new Error('ACK_LOST')
  })
  const mutable = { ...authority }
  const pending = port.admit({
    authority: mutable,
    turnKey: 'turn',
    model: descriptor.canonicalModel,
  })
  mutable.leaseEnvelope = 'changed-after-call'
  await assert.rejects(pending, /ACK_LOST/)
  await assert.rejects(
    port.admit({ authority, turnKey: 'turn', model: descriptor.canonicalModel }),
    /BINDING_INVALID/,
  )
  assert.equal(calls, 1)
  await assert.rejects(port.close(), /BINDING_INVALID/)
  await assert.rejects(port.close(), /BINDING_INVALID/)
  assert.equal(calls, 2)
  await assert.rejects(port.renew('late'), /BINDING_INVALID/)
})

test('cc5 adapter keeps remote native IDs out of local artifact probes and forbids transport switch/resume', () => {
  const f = fixture()
  const adapter = new Cc5InteractiveAdapter(f.opts)
  let observed: unknown
  adapter.on('session_id', (id) => {
    observed = id
  })
  const native = randomUUID()
  adapter.emit('session_id', native)
  assert.equal(observed, cc5ResumeId(binding.operationId, native))
  assert.deepEqual(
    probeResumeArtifact('ccb', String(observed), { workspacePath: '/does-not-exist' }),
    { exists: false },
  )
  assert.equal(adapter.requiresReopenForModel('cursor-auto'), true)
  assert.throws(() => adapter.setModel('cursor-auto'), /REOPEN_SESSION/)
  assert.throws(() => adapter.setResumeSessionId(native), /REMOTE_RESUME_UNSUPPORTED/)
})

test('actual Unix HTTP stream preserves original bytes, hashes one user frame, and confirms separate remote stop', async () => {
  const socketPath = `\0cc5-test-${randomUUID()}`
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const received: string[] = []
  const original = Buffer.from(
    '{"type":"assistant","message":{"content":[{"type":"text","text":"合成bytes"}]}}\n',
  )
  const output: Buffer[] = []
  stdout.on('data', (b) => output.push(b))
  let stopCalls = 0
  let streamResponse: import('node:http').ServerResponse | undefined
  const server = createServer((req, res) => {
    if (req.url === '/stop') {
      stopCalls++
      req.resume()
      res.end(JSON.stringify({ ok: true, remoteStopped: true }))
      streamResponse?.end()
      return
    }
    streamResponse = res
    let buf = ''
    req.on('data', (b) => {
      buf += b.toString()
      let split: number
      while ((split = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, split)
        buf = buf.slice(split + 1)
        received.push(line)
        if (received.length === 1) {
          res.writeHead(200, { 'x-cc5-interactive-ready': '1' })
          res.flushHeaders()
        } else {
          res.write(original.subarray(0, 17))
          res.write(original.subarray(17))
        }
      }
    })
  })
  server.listen(socketPath)
  await once(server, 'listening')
  const controller = new AbortController()
  const running = runCc5StdioBridge({
    binding,
    sessionKey: binding.sessionKey,
    stdin,
    stdout,
    socketPath,
    signal: controller.signal,
  })
  try {
    const user = `${JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    })}\n`
    stdin.write(user)
    const deadline = Date.now() + 3000
    while (Buffer.concat(output).length < original.length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.deepEqual(Buffer.concat(output), original)
    assert.equal(received.length, 2)
    const input = JSON.parse(received[1]!)
    assert.equal(input.seq, 1)
    assert.equal(Buffer.from(input.bytes, 'base64').toString(), user)
    assert.equal(input.hash, createHash('sha256').update(user).digest('hex'))
    controller.abort()
    await running
    assert.equal(stopCalls, 1)
  } finally {
    controller.abort()
    await running.catch(() => {})
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('unproven remote stop still revokes the local generation and closes its stdin', async () => {
  const f = fixture()
  f.port.close = async () => {
    throw new Error('REMOTE_STILL_UNKNOWN')
  }
  const runner = new SubprocessRunner(f.opts)
  await runner.submit('one', undefined, authority, 't')
  await assert.rejects(runner.shutdown(), /CC5_REMOTE_STOP_UNPROVEN/)
  assert.equal(runner.isRunning, false)
  assert.equal(f.proc.stdin.writableEnded, true)
})

test('a persisted cc5 id never enters a local resume probe and the native route keeps the CCB model', () => {
  const remote = cc5ResumeId(binding.operationId, randomUUID())
  const host = {
    _resumeMap: new Map([['s', remote]]),
    get _resumeMapProvider() {
      throw new Error('MUST_NOT_PROBE_OLD_CURSOR_STATE')
    },
  }
  for (const provider of ['ccb', 'codex', 'cursor']) {
    assert.equal(_resumeIdFor.call(host as never, 's', provider, '/no-local-probe'), undefined)
  }
  // The same canonical Sonnet keeps its catalog engine while the verified
  // backend selects a distinct implementation, with no Cursor pool selector.
  const f = fixture()
  assert.ok(createCcbBackend(f.opts) instanceof Cc5InteractiveAdapter)
  const { executionBackend: _scope, cc5BridgePort: _port, ...local } = f.opts
  assert.ok(createCcbBackend(local) instanceof CcbAdapter)
  assert.throws(() => createCcbBackend({ ...local, cc5BridgePort: f.port }), /SCOPE_REQUIRED/)

})

test('native backend requires the same signed scope, never just the Sonnet model', async () => {
  const f = fixture()
  const runner = new SubprocessRunner(f.opts)
  const foreign = { ...authority, executionDescriptor: { ...descriptor,
    executionBackend: { ...executionBackend, operationId: randomUUID() } } }
  await assert.rejects(runner.submit('x', undefined, foreign, 't'), /AUTHORITY_REQUIRED/)
  assert.equal(f.counts().admitted, 0)
  assert.equal(f.counts().prepared, 0)
  const { executionBackend: _scope, ...noScope } = f.opts
  assert.throws(() => new Cc5InteractiveAdapter(noScope), /PROFILE_UNSUPPORTED/)
  const adapter = new Cc5InteractiveAdapter(f.opts)
  await adapter.preheat()
  assert.equal(f.counts().admitted, 0)
  assert.equal(f.counts().prepared, 0)
})

test('cc5 Runner interrupt uses port.interrupt as single canonical sender and allows turn 2 on same live bridge', async () => {
  const f = fixture()
  let interrupted = 0
  f.port.interrupt = async () => {
    interrupted++
  }
  const runner = new SubprocessRunner(f.opts)
  await runner.submit('first turn', undefined, authority, 'turn1')
  assert.equal(runner.interrupt(), true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(interrupted, 1)
  assert.equal(f.counts().stopped, 0)
  assert.equal(runner.isRunning, true)
  // Canonical control plane port.interrupt avoids duplicate stdin control_request race (B1)
  assert.equal(f.writes.length, 1)

  // Emit interrupted turn result so runner returns to idle, then submit turn 2 on the same live bridge
  f.proc.stdout.write(
    `${JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      session_id: '00000000-0000-4000-8000-000000000099',
      uuid: '00000000-0000-4000-8000-000000000098',
      duration_ms: 12,
      num_turns: 1,
      result: 'interrupted',
      stop_reason: 'end_turn',
      total_cost_usd: 0.001,
      usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    })}\n`,
  )
  await new Promise((resolve) => setTimeout(resolve, 25))
  const auth2 = {
    ...authority,
    authorityId: randomUUID(),
    billingRequestId: randomUUID(),
  }
  await runner. submit('second turn after interrupt', undefined, auth2, 'turn2')
  assert.equal(f.counts().prepared, 1)
  assert.equal(f.counts().admitted, 2)
  assert.equal(f.counts().stopped, 0)
  assert.equal(f.writes.length, 2)
  await runner.shutdown()
  assert.equal(f.counts().stopped, 1)
})

test('runCc5StdioBridge discards uncommitted half-line on stream disconnect and replays byte-exact valid JSON on generation-2 reconnect (B4)', async () => {
  const socketPath = `\0cc5-test-b4-${randomUUID()}`
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const fullLine = Buffer.from('{"type":"assistant","message":{"content":"hello"}}\n')
  const opens: Array<{ generation?: number; lastAckedSeq?: number }> = []
  const outputChunks: Buffer[] = []
  const controller = new AbortController()
  let stopCalls = 0

  stdout.on('data', (chunk: Buffer) => {
    outputChunks.push(Buffer.from(chunk))
    setImmediate(() => controller.abort())
  })

  const server = createServer((req, res) => {
    if (req.url === '/stop') {
      stopCalls++
      req.resume()
      res.end(JSON.stringify({ ok: true, remoteStopped: true }))
      return
    }
    let buf = ''
    req.on('error', () => {})
    req.on('data', (chunk) => {
      buf += chunk.toString()
      if (!buf.includes('\n')) return
      const opening = JSON.parse(buf.split('\n')[0]!) as { generation?: number; lastAckedSeq?: number }
      buf = ''
      opens.push({ generation: opening.generation, lastAckedSeq: opening.lastAckedSeq })
      res.writeHead(200, { 'x-cc5-interactive-ready': '1' })
      res.flushHeaders()
      if (opens.length === 1) {
        // Send uncommitted partial frame (19 bytes, no newline) and then drop connection
        res.write(fullLine.subarray(0, 19))
        setTimeout(() => res.destroy(), 25)
      } else {
        // Replay full frame on generation 2
        res.write(fullLine)
      }
    })
  })
  server.listen(socketPath)
  await once(server, 'listening')

  const running = runCc5StdioBridge({
    binding,
    sessionKey: binding.sessionKey,
    stdin,
    stdout,
    socketPath,
    signal: controller.signal,
  })
  try {
    await running
    assert.deepEqual(opens, [
      { generation: 1, lastAckedSeq: undefined },
      { generation: 2, lastAckedSeq: 0 },
    ])
    const output = Buffer.concat(outputChunks)
    assert.deepEqual(output, fullLine)
    assert.doesNotThrow(() => JSON.parse(output.toString('utf8')))
    assert.equal(stopCalls, 1)
  } finally {
    controller.abort()
    await running.catch(() => {})
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('node memory rejection crosses the real Unix stream boundary, with zero user frames', async () => {
  const socketPath=`\0cc5-memory-${randomUUID()}`, stdin=new PassThrough(), stdout=new PassThrough()
  let frames=0,stops=0
  const server=createServer((req,res)=>{
    if(req.url==='/stop'){stops++;req.resume();res.end(JSON.stringify({ok:true,remoteStopped:true}));return}
    let pending=''
    req.on('data',b=>{
      pending+=b.toString()
      while(pending.includes('\n')){
        const i=pending.indexOf('\n'), row=JSON.parse(pending.slice(0,i));pending=pending.slice(i+1)
        if(row.type==='open'){
          res.writeHead(503,{'x-oc-remote-error':'REMOTE_NODE_MEMORY_EXHAUSTED','x-oc-remote-active':'2'})
          res.end('{}')
        } else frames++
      }
    })
  })
  server.listen(socketPath);await once(server,'listening')
  try {
    const run=runCc5StdioBridge({binding,sessionKey:binding.sessionKey,stdin,stdout,socketPath})
    stdin.write(JSON.stringify({type:'user',message:{role:'user',content:[{type:'text',text:'must not dispatch'}]}})+'\n')
    await assert.rejects(run,(e:any)=>e.code==='REMOTE_NODE_MEMORY_EXHAUSTED' && e.activeSessions===2)
    assert.equal(frames,0);assert.equal(stops,1)
  } finally {stdin.destroy();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()))}
})
test('runCc5StdioBridge resets reconnect quota after frame progress so >2 transient drops over a session succeed while 3 consecutive drops without progress fail', async () => {
  const socketPath = `\0cc5-test-reconnect-reset-${randomUUID()}`
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const frames = [
    Buffer.from('{"type":"assistant","message":{"content":"frame-1"}}\n'),
    Buffer.from('{"type":"assistant","message":{"content":"frame-2"}}\n'),
    Buffer.from('{"type":"assistant","message":{"content":"frame-3"}}\n'),
    Buffer.from('{"type":"assistant","message":{"content":"frame-4"}}\n'),
  ]
  const opens: Array<{ generation?: number; lastAckedSeq?: number }> = []
  const outputChunks: Buffer[] = []
  const controller = new AbortController()
  let receivedFrames = 0

  stdout.on('data', (chunk: Buffer) => {
    outputChunks.push(Buffer.from(chunk))
    receivedFrames += chunk.toString('utf8').split('\n').filter(Boolean).length
    if (receivedFrames === frames.length) {
      setImmediate(() => controller.abort())
    }
  })

  const server = createServer((req, res) => {
    if (req.url === '/stop') {
      req.resume()
      res.end(JSON.stringify({ ok: true, remoteStopped: true }))
      return
    }
    let buf = ''
    req.on('error', () => {})
    req.on('data', (chunk) => {
      buf += chunk.toString()
      if (!buf.includes('\n')) return
      const opening = JSON.parse(buf.split('\n')[0]!) as { generation?: number; lastAckedSeq?: number }
      buf = ''
      opens.push({ generation: opening.generation, lastAckedSeq: opening.lastAckedSeq })
      res.writeHead(200, { 'x-cc5-interactive-ready': '1' })
      res.flushHeaders()
      const idx = opens.length - 1
      res.write(frames[idx]!)
      if (idx < frames.length - 1) {
        setTimeout(() => res.destroy(), 20)
      }
    })
  })
  server.listen(socketPath)
  await once(server, 'listening')

  const running = runCc5StdioBridge({
    binding,
    sessionKey: binding.sessionKey,
    stdin,
    stdout,
    socketPath,
    signal: controller.signal,
  })
  try {
    await running
    assert.deepEqual(opens, [
      { generation: 1, lastAckedSeq: undefined },
      { generation: 2, lastAckedSeq: 1 },
      { generation: 3, lastAckedSeq: 2 },
      { generation: 4, lastAckedSeq: 3 },
    ])
    assert.deepEqual(Buffer.concat(outputChunks), Buffer.concat(frames))
  } finally {
    controller.abort()
    await running.catch(() => {})
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  // Consecutive drops without any complete frame progress still bound retries at 2 and fail with CC5_OUTPUT_DELIVERY_UNKNOWN
  const failSocketPath = `\0cc5-test-reconnect-bound-${randomUUID()}`
  const failOpens: number[] = []
  const failServer = createServer((req, res) => {
    if (req.url === '/stop') {
      req.resume()
      res.end(JSON.stringify({ ok: true, remoteStopped: true }))
      return
    }
    req.on('error', () => {})
    req.once('data', () => {
      failOpens.push(failOpens.length + 1)
      res.writeHead(200, { 'x-cc5-interactive-ready': '1' })
      res.flushHeaders()
      res.write('{"partial_without_newline":')
      setTimeout(() => res.destroy(), 15)
    })
  })
  failServer.listen(failSocketPath)
  await once(failServer, 'listening')
  try {
    await assert.rejects(
      runCc5StdioBridge({
        binding,
        sessionKey: binding.sessionKey,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        socketPath: failSocketPath,
      }),
      /CC5_OUTPUT_DELIVERY_UNKNOWN/,
    )
    assert.deepEqual(failOpens, [1, 2, 3])
  } finally {
    failServer.closeAllConnections()
    await new Promise<void>((resolve) => failServer.close(() => resolve()))
  }
})
