import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { test } from 'node:test'
import {
  MODEL_AUTHORITY_VERSION,
  type ModelAuthorityPayload,
  type TurnLease,
  authoritySigningInput,
  encodeAuthorityEnvelope,
  encodeTurnLeaseEnvelope,
  turnLeaseSigningInput,
} from '@openclaude/protocol'
import { type Cc5BridgeBinding, cc5ControlRequest } from '../cc5BridgePort.js'
import { CC5_FIXED_TOOL_NAME, type Cc5ToolRequest } from '../cc5FixedTool.js'
import { type Cc5InteractiveHostPort, Cc5Relay } from '../cc5Relay.js'
import { runCc5StdioBridge } from '../cc5StdioBridge.js'
import type { Cc5FinancePort } from '../cc5Finance.js'

function fixture() {
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
    connectionChallenge: 'synthetic-connection',
    canonicalModel: 'box-claude-sonnet-5',
    engine: 'ccb',
    executionBackend: { kind: 'cc5-interactive-v1', sessionKey: binding.sessionKey, operationId: binding.operationId },
    securityEpoch: 12,
    executionRevision: 'test-r1',
    issuedAt: now,
    expiresAt: now + 120000,
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
    name: CC5_FIXED_TOOL_NAME,
    arguments: { operationId: binding.operationId },
    authority: envelope(a),
    lease: leaseEnvelope(lease),
  }
  const observed = {
    nativeSessionId: request.nativeSessionId,
    toolUseId: request.toolUseId,
    name: request.name,
    input: request.arguments,
  }
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
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

async function harness(
  f: ReturnType<typeof fixture>,
  failure: 'none' | 'start' | 'stop' | 'stdin-error' = 'none',
  financeOverride?: Cc5FinancePort,
) {
  const written: Buffer[] = []
  const input =
    failure === 'stdin-error'
      ? new Writable({
          write(chunk, _encoding, callback) {
            written.push(Buffer.from(chunk))
            queueMicrotask(() => callback(new Error('synthetic asynchronous EPIPE')))
          },
        })
      : new PassThrough()
  const output = new PassThrough()
  if (failure !== 'stdin-error') input.on('data', (b) => written.push(b))
  let ready!: () => void
  const readyPromise = new Promise<void>((resolve) => {
    ready = resolve
  })
  let started!: () => void
  const startObserved = new Promise<void>((resolve) => {
    started = resolve
  })
  let stopped!: () => void
  const stopObserved = new Promise<void>((resolve) => {
    stopped = resolve
  })
  let starts = 0
  let stops = 0
  const port: Cc5InteractiveHostPort = {
    start() {
      starts++
      financeEvents.push('host-start')
      started()
      if (failure === 'start') throw new Error('synthetic spawn status unknown')
      return { stdin: input, stdout: output, ready: readyPromise }
    },
    async stop() {
      stops++
      stopped()
      if (failure === 'stop') throw new Error('synthetic remote absence unproved')
      return { remoteStopped: true }
    },
  }
  const runId = f.binding.runId
  const financeEvents: string[] = []
  const finance = {
    async admit() {
      financeEvents.push('admit')
      return {
        async beforeHostStart() { financeEvents.push('host-effect') },
        async beforeDispatch() { financeEvents.push('dispatch-effect') },
        async terminal() { financeEvents.push('settled'); return { state: 'proven' as const, requestId: 'fixture-request' } },
        async stop() { financeEvents.push('stop') },
      }
    },
  }
  const relay = new Cc5Relay(f.binding, f.keyring, runId, port, join(f.root, 'relay-journal'), financeOverride ?? finance)
  const socketPath = relative(process.cwd(), join(f.root, 'control.sock'))
  const toolSocket = relative(process.cwd(), join(f.root, 'tool.sock'))
  relay.controlServer.listen(socketPath)
  relay.toolServer.listen(toolSocket)
  await Promise.all([once(relay.controlServer, 'listening'), once(relay.toolServer, 'listening')])
  const scope = { ...f.binding, sessionKey: f.request.sessionKey }
  const admit = () =>
    cc5ControlRequest(
      '/admit',
      {
        ...scope,
        authority: f.request.authority,
        lease: f.request.lease,
        turnKey: f.request.turnKey,
      },
      socketPath,
    )
  const close = async () => {
    ready()
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
    startObserved,
    stopObserved,
    close,
    input,
    output,
    written,
    runId,
    financeEvents,
    counts: () => ({ starts, stops }),
  }
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

test(
  'budgeted admission precedes opening the stream and starts exactly one host',
  { timeout: 15000 },
  async (t) => {
    for (const order of ['admit-first'])
      await t.test(order, async () => {
        const f = fixture()
        const h = await harness(f)
        const controller = new AbortController()
        let running: Promise<void> | undefined
        let admission: Promise<unknown> | undefined
        try {
          const open = () =>
            runCc5StdioBridge({
              binding: f.binding,
              sessionKey: f.request.sessionKey,
              stdin: new PassThrough(),
              stdout: new PassThrough(),
              socketPath: h.socketPath,
              signal: controller.signal,
            })
          if (order === 'open-first') running = open()
          else admission = h.admit()
          await h.startObserved
          if (order === 'open-first') admission = h.admit()
          else running = open()
          void running!.catch(() => {})
          h.ready()
          await admission
          assert.equal(h.counts().starts, 1)
          controller.abort()
          await running
          assert.deepEqual(h.counts(), { starts: 1, stops: 1 })
          assert.equal(h.written.length, 0)
        } finally {
          controller.abort()
          await running?.catch(() => {})
          await h.close()
          f.cleanup()
        }
      })
  },
)

test('a synchronous unknown host startup is burned once and still needs independent remote stop', async () => {
  const f = fixture()
  const h = await harness(f, 'start')
  try {
    await assert.rejects(h.admit())
    await assert.rejects(h.admit())
    assert.deepEqual(h.counts(), { starts: 1, stops: 1 })
    assert.equal(h.written.length, 0)
  } finally {
    await h.close()
    f.cleanup()
  }
})

test('wrong signed identity fails before host startup or dispatch', async () => {
  const f = fixture()
  const h = await harness(f)
  try {
    await assert.rejects(
      cc5ControlRequest(
        '/admit',
        {
          ...h.scope,
          authority: f.envelope({ ...f.a, uid: 999 }),
          lease: f.request.lease,
          turnKey: f.request.turnKey,
        },
        h.socketPath,
      ),
    )
    assert.equal(h.counts().starts, 0)
    assert.equal(h.written.length, 0)
  } finally {
    await h.close()
    f.cleanup()
  }
})

test('an open request without admitted finance cannot start a host', async () => {
  const f = fixture()
  const h = await harness(f)
  try {
    await assert.rejects(rpc(h.socketPath, '/session/open', { type: 'open', ...h.scope }))
    assert.equal(h.counts().starts, 0)
    assert.deepEqual(h.financeEvents, [])
  } finally { await h.close(); f.cleanup() }
})

test('finance and its durable startup marker run before any potentially billable host startup', async () => {
  const f = fixture()
  const events: string[] = []
  const finance: Cc5FinancePort = {
    async admit() {
      events.push('admit')
      return {
        async beforeHostStart() { events.push('host-effect'); throw new Error('fixture durable boundary failed') },
        async beforeDispatch() { throw new Error('must not dispatch') },
        async terminal() { throw new Error('must not settle') },
        async stop(info) { assert.equal(info.hostStartAttempted, false); events.push('stopped-before-host') },
      }
    },
  }
  const h = await harness(f, 'none', finance)
  try {
    await assert.rejects(h.admit())
    await h.relay.stop()
    await assert.rejects(h.admit())
    assert.deepEqual(events, ['admit', 'host-effect', 'stopped-before-host'])
    assert.equal(h.counts().starts, 0)
    assert.equal(h.written.length, 0)
  } finally { await h.close(); f.cleanup() }
})

test('same user and Sonnet authority cannot claim another session or operation', async () => {
  const f = fixture()
  const h = await harness(f)
  try {
    for (const executionBackend of [
      { ...f.a.executionBackend!, sessionKey: 'agent:main:webchat:dm:other_chat1' },
      { ...f.a.executionBackend!, operationId: randomUUID() },
    ]) await assert.rejects(cc5ControlRequest('/admit', { ...h.scope,
      authority: f.envelope({ ...f.a, executionBackend }), lease: f.request.lease,
      turnKey: f.request.turnKey }, h.socketPath))
    assert.equal(h.counts().starts, 0)
    assert.deepEqual(h.financeEvents, [])
  } finally { await h.close(); f.cleanup() }
})

test('original result bytes wait for proven settlement; native usage receipt never uses assistant text or CLI cost',
  { timeout: 15000 }, async () => {
    const f = fixture()
    let release!: () => void
    let entered!: () => void
    const settling = new Promise<void>((resolve) => { entered = resolve })
    const settled = new Promise<void>((resolve) => { release = resolve })
    const finance: Cc5FinancePort = { async admit() { return {
      async beforeHostStart() {}, async beforeDispatch() {}, async stop() {},
      async terminal(receipt) {
        assert.equal(receipt.nativeSessionId, f.request.nativeSessionId)
        assert.equal(receipt.upstreamModel, 'claude-sonnet-5')
        assert.deepEqual(receipt.usage, { inputTokens: 7, outputTokens: 3, cacheReadTokens: 11, cacheWriteTokens: 13 })
        entered(); await settled
        return { state: 'proven', requestId: 'existing-request-id' }
      },
    } } }
    const h = await harness(f, 'none', finance)
    const controller = new AbortController()
    const stdin = new PassThrough(); const stdout = new PassThrough(); const output: Buffer[] = []
    stdout.on('data', (bytes) => output.push(bytes))
    let running: Promise<void> | undefined
    try {
      const admitted = h.admit(); h.ready(); await admitted
      running = runCc5StdioBridge({ binding: f.binding, sessionKey: f.binding.sessionKey, stdin, stdout,
        socketPath: h.socketPath, signal: controller.signal })
      void running.catch(() => {})
      stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'fixture only' } })}\n`)
      if (!h.written.length) await once(h.input, 'data')
      const raw = Buffer.from(`${[
        { type: 'system', subtype: 'init', model: 'claude-sonnet-5', session_id: f.request.nativeSessionId },
        { type: 'result', subtype: 'success', is_error: false, session_id: f.request.nativeSessionId,
          total_cost_usd: 999999, result: '{"input_tokens":999999}', usage: { input_tokens: 7,
            output_tokens: 3, cache_read_input_tokens: 11, cache_creation_input_tokens: 13 } },
      ].map((row) => JSON.stringify(row)).join('\n')}\n`)
      h.output.write(raw)
      await settling
      assert.equal(Buffer.concat(output).includes(Buffer.from('"type":"result"')), false)
      release()
      const deadline = Date.now() + 2000
      while (Buffer.concat(output).length < raw.length && Date.now() < deadline)
        await new Promise<void>((resolve) => setImmediate(resolve))
      assert.deepEqual(Buffer.concat(output), raw)
      controller.abort(); await running
      assert.equal(h.written.length, 1)
    } finally {
      release(); controller.abort(); await running?.catch(() => {}); await h.close(); f.cleanup()
    }
  })

test('pending or throwing native settlement withholds terminal and records a started operation at stop',
  { timeout: 15000 }, async (t) => {
    for (const failure of ['pending', 'throw']) await t.test(failure, async () => {
      const f = fixture()
      const stops: unknown[] = []
      let settlements = 0
      const finance: Cc5FinancePort = { async admit() { return {
        async beforeHostStart() {}, async beforeDispatch() {},
        async terminal() {
          settlements++
          if (failure === 'throw') throw new Error('fixture commit acknowledgement unknown')
          return { state: 'pending' }
        },
        async stop(info) { stops.push(info) },
      } } }
      const h = await harness(f, 'none', finance)
      const controller = new AbortController(); const stdin = new PassThrough(); const stdout = new PassThrough()
      const output: Buffer[] = []; stdout.on('data', (bytes) => output.push(bytes))
      let running: Promise<void> | undefined
      try {
        const admitted = h.admit(); h.ready(); await admitted
        running = runCc5StdioBridge({ binding: f.binding, sessionKey: f.binding.sessionKey, stdin, stdout,
          socketPath: h.socketPath, signal: controller.signal })
        void running.catch(() => {})
        stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'fixture only' } })}\n`)
        if (!h.written.length) await once(h.input, 'data')
        h.output.write(`${[
          { type: 'system', subtype: 'init', model: 'claude-sonnet-5', session_id: f.request.nativeSessionId },
          { type: 'result', subtype: 'success', is_error: false, session_id: f.request.nativeSessionId,
            usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 11, cache_creation_input_tokens: 13 } },
        ].map((row) => JSON.stringify(row)).join('\n')}\n`)
        await h.stopObserved
        await h.relay.stop()
        assert.equal(Buffer.concat(output).includes(Buffer.from('"type":"result"')), false)
        assert.equal(settlements, 1)
        assert.deepEqual(stops, [{ hostStartAttempted: true, userSubmitted: true, remoteStopped: true }])
        await assert.rejects(h.admit())
        assert.equal(h.counts().starts, 1)
      } finally {
        controller.abort(); await running?.catch(() => {}); await h.close(); f.cleanup()
      }
    })
  })

test('missing remote absence proof never returns a positive stop result', async () => {
  const f = fixture()
  const h = await harness(f, 'stop')
  try {
    const admitted = h.admit()
    h.ready()
    await admitted
    await assert.rejects(cc5ControlRequest('/stop', h.scope, h.socketPath))
    await assert.rejects(h.relay.stop())
    assert.equal(h.counts().stops, 1)
  } finally {
    await h.close()
    f.cleanup()
  }
})

test(
  'real Unix relay and stdio child correlate RPC before original frames and return one real local command receipt',
  { timeout: 20000 },
  async () => {
    const f = fixture()
    const h = await harness(f)
    const controller = new AbortController()
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const output: Buffer[] = []
    stdout.on('data', (b) => output.push(b))
    const raw = Buffer.from(
      `${JSON.stringify({
        type: 'assistant',
        session_id: f.request.nativeSessionId,
        message: {
          content: [
            {
              type: 'tool_use',
              id: f.request.toolUseId,
              name: f.request.name,
              input: f.request.arguments,
            },
          ],
        },
      })}\n`,
    )
    let running: Promise<void> | undefined
    try {
      const accepted = h.admit()
      h.ready()
      await accepted
      running = runCc5StdioBridge({
        binding: f.binding,
        sessionKey: f.request.sessionKey,
        stdin,
        stdout,
        socketPath: h.socketPath,
        signal: controller.signal,
        tools: { keyring: f.keyring, executionRoot: f.root },
      })
      void running.catch(() => {})
      stdin.write(
        `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'fixture, no model' } })}\n`,
      )
      if (h.written.length === 0) await once(h.input, 'data')
      const result = rpc(h.toolSocket, '/roundtrip', {
        runId: h.runId,
        operationId: f.binding.operationId,
        rpcId: f.request.rpcId,
        toolUseId: f.request.toolUseId,
        name: f.request.name,
        arguments: f.request.arguments,
      })
      // The independent MCP request may precede all original authenticated output.
      await new Promise<void>((resolve) => setImmediate(resolve))
      h.output.write(raw.subarray(0, raw.length - 1))
      await new Promise<void>((resolve) => setImmediate(resolve))
      h.output.write(raw.subarray(raw.length - 1))
      const response = await result
      assert.equal(response.receipt.exitCode, 0)
      assert.equal(response.receipt.dockerId, f.binding.dockerId)
      assert.equal(
        readFileSync(join(f.root, f.binding.operationId, 'cc5-proof.txt'), 'utf8'),
        `${response.receipt.marker}\n`,
      )
      assert.deepEqual(Buffer.concat(output), raw)
      assert.equal(h.written.length, 1)
      controller.abort()
      await running
      assert.deepEqual(h.counts(), { starts: 1, stops: 1 })
    } finally {
      controller.abort()
      await running?.catch(() => {})
      await h.close()
      f.cleanup()
    }
  },
)

test(
  'same sequence/hash is ignored and a conflicting replay stops without a second user dispatch',
  { timeout: 15000 },
  async () => {
    const f = fixture()
    const h = await harness(f)
    let req: ReturnType<typeof request> | undefined
    try {
      const admission = h.admit()
      h.ready()
      await admission
      const opened = new Promise<void>((resolve, reject) => {
        req = request(
          { socketPath: h.socketPath, path: '/session/open', method: 'POST' },
          (res) => {
            res.resume()
            resolve()
          },
        )
        req.once('error', reject)
        req.on('error', () => {})
        req.write(`${JSON.stringify({ type: 'open', ...h.scope })}\n`)
      })
      await opened
      const bytes = Buffer.from(
        `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'synthetic once' } })}\n`,
      )
      const frame = {
        seq: 1,
        hash: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.toString('base64'),
      }
      req!.write(`${JSON.stringify(frame)}\n`)
      if (h.written.length === 0) await once(h.input, 'data')
      req!.write(`${JSON.stringify(frame)}\n`)
      const other = Buffer.from(
        `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'conflicting' } })}\n`,
      )
      req!.write(
        `${JSON.stringify({ seq: 1, hash: createHash('sha256').update(other).digest('hex'), bytes: other.toString('base64') })}\n`,
      )
      await h.stopObserved
      assert.equal(h.written.length, 1)
      assert.deepEqual(h.written[0], bytes)
    } finally {
      req?.destroy()
      await h.close()
      f.cleanup()
    }
  },
)

test(
  'binding expiry revokes execution yet leaves independent identity stop usable',
  { timeout: 15000 },
  async () => {
    const f = fixture()
    f.binding.expiresAt = Date.now() + 1500
    const h = await harness(f)
    try {
      const admission = h.admit()
      h.ready()
      await admission
      await h.stopObserved
      const stopped = await cc5ControlRequest('/stop', h.scope, h.socketPath)
      assert.equal(stopped.remoteStopped, true)
      assert.equal(h.counts().stops, 1)
      assert.equal(h.written.length, 0)
    } finally {
      await h.close()
      f.cleanup()
    }
  },
)

test(
  'MCP disconnect while waiting for the original row revokes the attached real tool pump before effect',
  { timeout: 15000 },
  async () => {
    const f = fixture()
    const h = await harness(f)
    const controller = new AbortController()
    const stdin = new PassThrough()
    let running: Promise<void> | undefined
    let req: ReturnType<typeof request> | undefined
    try {
      const admission = h.admit()
      h.ready()
      await admission
      running = runCc5StdioBridge({
        binding: f.binding,
        sessionKey: f.request.sessionKey,
        stdin,
        stdout: new PassThrough(),
        socketPath: h.socketPath,
        signal: controller.signal,
        tools: { keyring: f.keyring, executionRoot: f.root },
      })
      void running.catch(() => {})
      stdin.write(
        `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'disconnect fixture' } })}\n`,
      )
      if (h.written.length === 0) await once(h.input, 'data')
      req = request({ socketPath: h.toolSocket, path: '/roundtrip', method: 'POST' }, (res) =>
        res.resume(),
      )
      req.on('error', () => {})
      req.end(
        JSON.stringify({
          runId: h.runId,
          operationId: f.binding.operationId,
          rpcId: f.request.rpcId,
          toolUseId: f.request.toolUseId,
          name: f.request.name,
          arguments: f.request.arguments,
        }),
      )
      const deadline = Date.now() + 2000
      while (!existsSync(join(f.root, 'relay-journal/tool-attempt.json')) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 5))
      assert.ok(existsSync(join(f.root, 'relay-journal/tool-attempt.json')))
      req.destroy()
      await h.stopObserved
      h.output.write(
        `${JSON.stringify({
          type: 'assistant',
          session_id: f.request.nativeSessionId,
          message: {
            content: [
              {
                type: 'tool_use',
                id: f.request.toolUseId,
                name: f.request.name,
                input: f.request.arguments,
              },
            ],
          },
        })}\n`,
      )
      await assert.rejects(running)
      assert.equal(existsSync(join(f.root, f.binding.operationId)), false)
      assert.equal(h.counts().stops, 1)
    } finally {
      req?.destroy()
      controller.abort()
      await running?.catch(() => {})
      await h.close()
      f.cleanup()
    }
  },
)

test(
  'an asynchronous host stdin EPIPE invokes independent stop instead of escaping as an unhandled error',
  { timeout: 15000 },
  async () => {
    const f = fixture()
    const h = await harness(f, 'stdin-error')
    const controller = new AbortController()
    const stdin = new PassThrough()
    let running: Promise<void> | undefined
    try {
      const admission = h.admit()
      h.ready()
      await admission
      running = runCc5StdioBridge({
        binding: f.binding,
        sessionKey: f.request.sessionKey,
        stdin,
        stdout: new PassThrough(),
        socketPath: h.socketPath,
        signal: controller.signal,
      })
      void running.catch(() => {})
      stdin.write(
        `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'EPIPE fixture' } })}\n`,
      )
      await h.stopObserved
      await assert.rejects(running)
      assert.equal(h.written.length, 1)
      assert.equal(h.counts().stops, 1)
    } finally {
      controller.abort()
      await running?.catch(() => {})
      await h.close()
      f.cleanup()
    }
  },
)
