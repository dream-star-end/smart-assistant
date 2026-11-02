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
  const port: Cc5BridgePort = {
    bindingId: binding.operationId,
    executionBackend,
    canonicalModel: binding.canonicalModel,
    async prepare() {
      assert.equal(admitted, 1, 'budget/admission must happen before bridge preparation/spawn')
      prepared++
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
    get provider() {
      throw new Error('OLD_PROVIDER_TOUCHED')
    },
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
  return { proc, writes, port, opts, counts: () => ({ prepared, admitted, renewed, stopped }) }
}

test('cc5 Runner skips old auth/setup; original fragmented output and lease use the dedicated port', async () => {
  const f = fixture()
  const runner = new SubprocessRunner(f.opts)
  const messages: unknown[] = []
  runner.on('message', (message) => messages.push(message))
  await runner.submit('literal user sentence', undefined, authority, 'turn1')
  assert.equal(f.counts().prepared, 1)
  assert.equal(f.counts().admitted, 1)
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
