import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { type ServerResponse, createServer } from 'node:http'
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
} from '@openclaude/protocol'
import type { Cc5BridgeBinding } from '../cc5BridgePort.js'
import type { Cc5ToolRequest } from '../cc5FixedTool.js'
import { cc5ToolInputSha256, type Cc5ToolReceipt, type Cc5ToolResult } from '../cc5NativeTool.js'
import { runCc5StdioBridge } from '../cc5StdioBridge.js'
import { Cc5ToolObservation } from '../cc5ToolObservation.js'
import { type Cc5ToolDelivery, runCc5ToolPump } from '../cc5ToolPump.js'

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
    name: 'mcp__ocbridge__Bash',
    arguments: { command: 'printf fixture' },
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

function original(f: ReturnType<typeof fixture>): Buffer {
  return Buffer.from(
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
}
function receiptPath(f: ReturnType<typeof fixture>): string {
  return join(f.root, f.binding.operationId,
    createHash('sha256').update(f.request.toolUseId).digest('hex'), 'receipt.json')
}
function effectPath(f: ReturnType<typeof fixture>): string { return join(f.root, 'local-effect') }
async function harness(f: ReturnType<typeof fixture>, delivery: Cc5ToolDelivery,
  options: { loseAck?: boolean; duplicate?: boolean; executionUnknown?: boolean;
    result?: Cc5ToolResult } = {}) {
  const socketPath = relative(process.cwd(), join(f.root, 's'))
  const controller = new AbortController()
  const observation = new Cc5ToolObservation(f.binding.operationId)
  let polled!: () => void
  const pollReady = new Promise<void>((resolve) => {
    polled = resolve
  })
  let pollCount = 0
  let resultCount = 0
  let effects = 0
  const results: Cc5ToolReceipt[] = []
  let idle!: () => void
  const idlePolled = new Promise<void>((resolve) => { idle = resolve })
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (b) => chunks.push(b))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString())
      assert.equal(body.capability, f.binding.capability)
      assert.equal(body.operationId, f.binding.operationId)
      if (req.url === '/tool/next') {
        pollCount++
        if (pollCount <= (options.duplicate ? 2 : 1)) res.end(JSON.stringify({ ok: true, delivery }))
        else idle() // An outstanding poll proves every preceding result ACK was consumed.
        polled()
      } else if (req.url === '/tool/result') {
        resultCount++
        results.push(body.receipt)
        if (options.loseAck) res.destroy()
        else res.end(JSON.stringify({ ok: true, commandId: body.receipt.commandId }))
      } else {
        res.writeHead(404).end()
      }
    })
  })
  server.listen(socketPath)
  await once(server, 'listening')
  const running = runCc5ToolPump({
    binding: f.binding,
    sessionKey: f.request.sessionKey,
    keyring: f.keyring,
    observation,
    signal: controller.signal,
    socketPath,
    executionRoot: f.root,
    executeTool: async (request): Promise<Cc5ToolResult> => {
      assert.equal(request.name, f.request.name)
      assert.deepEqual(request.arguments, f.request.arguments)
      effects++
      writeFileSync(effectPath(f), 'one local effect', { flag: 'wx', mode: 0o600 })
      if (options.executionUnknown) throw new Error('fixture effect occurred but completion is unknown')
      return options.result ?? { content: [{ type: 'text', text: 'one local effect' }], isError: false }
    },
  })
  // Attach a handler now so rejected negative fixtures never emit unhandled rejection.
  void running.catch(() => {})
  const close = async () => {
    controller.abort()
    await running.catch(() => {})
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  return {
    running,
    observation,
    controller,
    pollReady,
    idlePolled,
    close,
    counts: () => ({ pollCount, resultCount, effects }),
    receipt: () => results.at(-1),
    receipts: results,
  }
}

test('real Unix tool pump waits for the full original row, executes once and keeps polling until aborted', { timeout: 5000 }, async () => {
  const f = fixture()
  const h = await harness(f, { request: f.request, admission: f.admission })
  try {
    await h.pollReady
    const bytes = original(f)
    h.observation.ingest(bytes.subarray(0, bytes.length - 1))
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(existsSync(join(f.root, f.binding.operationId)), false)
    h.observation.ingest(bytes.subarray(bytes.length - 1))
    await h.idlePolled
    const receipt = h.receipt()!
    assert.deepEqual(h.counts(), { pollCount: 2, resultCount: 1, effects: 1 })
    assert.equal(receipt.dockerId, f.binding.dockerId)
    assert.equal(receipt.version, 2)
    assert.equal(receipt.name, f.request.name)
    assert.equal(receipt.inputSha256, cc5ToolInputSha256(f.request.arguments))
    assert.deepEqual(receipt.result, { content: [{ type: 'text', text: 'one local effect' }], isError: false })
    assert.equal(readFileSync(effectPath(f), 'utf8'), 'one local effect')
    assert.deepEqual(JSON.parse(readFileSync(receiptPath(f), 'utf8')), receipt)
    h.controller.abort()
    await h.running.catch(() => {})
  } finally {
    await h.close()
    f.cleanup()
  }
})

test('wrong signature, binding or trusted admission cannot create a journal or command effect', async (t) => {
  for (const kind of ['signature', 'binding', 'admission'] as const) {
    await t.test(kind, async () => {
      const f = fixture()
      const delivery = { request: structuredClone(f.request), admission: { ...f.admission } }
      if (kind === 'signature') delivery.request.authority = 'invalid'
      if (kind === 'binding') delivery.request.dockerId = 'c'.repeat(64)
      if (kind === 'admission') delivery.admission.authorityTurnId = 'wrong-turn'
      const h = await harness(f, delivery)
      try {
        h.observation.ingest(original(f))
        await assert.rejects(h.running)
        assert.equal(existsSync(join(f.root, f.binding.operationId)), false)
        assert.equal(h.counts().effects, 0)
        assert.equal(h.counts().resultCount, 0)
      } finally {
        await h.close()
        f.cleanup()
      }
    })
  }
})

test('an RPC without an original tool row aborts without effect', async () => {
  const f = fixture()
  const h = await harness(f, { request: f.request, admission: f.admission })
  try {
    await h.pollReady
    h.controller.abort()
    await assert.rejects(h.running)
    assert.equal(existsSync(join(f.root, f.binding.operationId)), false)
    assert.equal(h.counts().effects, 0)
    assert.equal(h.counts().resultCount, 0)
  } finally {
    await h.close()
    f.cleanup()
  }
})

test('lost result ACK leaves one real terminal receipt and never repeats the tool poll or effect', async () => {
  const f = fixture()
  const h = await harness(f, { request: f.request, admission: f.admission }, { loseAck: true })
  try {
    h.observation.ingest(original(f))
    await assert.rejects(h.running)
    const receipt = JSON.parse(readFileSync(receiptPath(f), 'utf8'))
    assert.equal(receipt.result.isError, false)
    assert.equal(h.receipt()!.commandId, receipt.commandId)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.deepEqual(h.counts(), { pollCount: 1, resultCount: 1, effects: 1 })
  } finally {
    await h.close()
    f.cleanup()
  }
})

test('a duplicate completed tool delivery reuses its receipt without repeating the effect', { timeout: 5000 }, async () => {
  const f = fixture()
  const h = await harness(f, { request: f.request, admission: f.admission }, { duplicate: true })
  try {
    h.observation.ingest(original(f))
    await h.idlePolled
    assert.deepEqual(h.counts(), { pollCount: 3, resultCount: 2, effects: 1 })
    assert.deepEqual(h.receipts[0], h.receipts[1])
    assert.equal(readFileSync(effectPath(f), 'utf8'), 'one local effect')
  } finally {
    await h.close()
    f.cleanup()
  }
})

test('a durable unknown attempt blocks replay even after a new pump starts', { timeout: 5000 }, async () => {
  const f = fixture()
  const delivery = { request: f.request, admission: f.admission }
  const first = await harness(f, delivery, { executionUnknown: true })
  try {
    first.observation.ingest(original(f))
    await assert.rejects(first.running, /fixture effect occurred/)
    assert.deepEqual(first.counts(), { pollCount: 1, resultCount: 0, effects: 1 })
    assert.equal(existsSync(receiptPath(f)), false)
    await first.close()
    const second = await harness(f, delivery)
    try {
      second.observation.ingest(original(f))
      await assert.rejects(second.running, /CC5_NATIVE_TOOL_EXECUTION_UNKNOWN/)
      assert.deepEqual(second.counts(), { pollCount: 1, resultCount: 0, effects: 0 })
      assert.equal(readFileSync(effectPath(f), 'utf8'), 'one local effect')
    } finally { await second.close() }
  } finally {
    await first.close()
    f.cleanup()
  }
})

test(
  'the actual stdio bridge observes original bytes, runs its tool pump and returns the same bytes',
  { timeout: 15000 },
  async () => {
    const f = fixture()
    const socketPath = relative(process.cwd(), join(f.root, 'bridge.sock'))
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const output: Buffer[] = []
    stdout.on('data', (b) => output.push(b))
    const raw = original(f)
    const controller = new AbortController()
    let stream: ServerResponse | undefined
    let complete!: () => void
    const toolComplete = new Promise<void>((resolve) => {
      complete = resolve
    })
    let commands = 0
    let polls = 0
    let lifecycleId: string | undefined
    let hostCloses = 0
    let idle!: () => void
    const idlePolled = new Promise<void>((resolve) => { idle = resolve })
    const server = createServer((req, res) => {
      let body = ''
      if (req.url === '/session/open') {
        stream = res
        req.on('data', (b) => {
          body += b.toString()
          for (let pos = body.indexOf('\n'); pos >= 0; pos = body.indexOf('\n')) {
            const frame = JSON.parse(body.slice(0, pos))
            body = body.slice(pos + 1)
            if (frame.type === 'open') {
              res.writeHead(200, { 'x-cc5-interactive-ready': '1' })
              res.flushHeaders()
            } else {
              assert.equal(frame.seq, 1)
              res.write(raw.subarray(0, 19))
              res.write(raw.subarray(19))
            }
          }
        })
        return
      }
      req.on('data', (b) => {
        body += b.toString()
      })
      req.on('end', () => {
        if (req.url === '/tool/next') {
          polls++
          if (polls === 1) res.end(
            JSON.stringify({ ok: true, delivery: { request: f.request, admission: f.admission } }),
          )
          else idle()
        } else if (req.url === '/tool/result') {
          const value = JSON.parse(body)
          assert.equal(value.receipt.version, 2)
          assert.equal(value.receipt.result.isError, false)
          commands++
          res.end(JSON.stringify({ ok: true, commandId: value.receipt.commandId }))
          complete()
        } else if (req.url === '/tool/register') {
          lifecycleId = JSON.parse(body).lifecycleId
          assert.equal(typeof lifecycleId, 'string')
          res.end(JSON.stringify({ ok: true, lifecycleId }))
        } else if (req.url === '/tool/stopped') {
          const value = JSON.parse(body)
          assert.equal(value.lifecycleId, lifecycleId)
          assert.equal(value.localStopped, true)
          assert.equal(hostCloses, 1)
          res.end(JSON.stringify({ ok: true, lifecycleId }))
        } else if (req.url === '/stop') {
          assert.equal(hostCloses, 1)
          res.end(JSON.stringify({ ok: true, remoteStopped: true }))
          stream?.end()
        } else {
          res.writeHead(404).end()
        }
      })
    })
    server.listen(socketPath)
    await once(server, 'listening')
    const running = runCc5StdioBridge({
      binding: f.binding,
      sessionKey: f.request.sessionKey,
      stdin,
      stdout,
      socketPath,
      signal: controller.signal,
      tools: { keyring: f.keyring, executionRoot: f.root, hostFactory(root, identity) {
        assert.equal(identity, lifecycleId)
        assert.equal(root, join(f.root, `host-${identity}`))
        return {
          async execute(name, args, request) {
            assert.equal(name, f.request.name)
            assert.deepEqual(args, f.request.arguments)
            assert.equal(request.toolUseId, f.request.toolUseId)
            writeFileSync(effectPath(f), 'one local effect', { flag: 'wx', mode: 0o600 })
            return { content: [{ type: 'text', text: 'one local effect' }], isError: false }
          },
          async close() { hostCloses++ },
        }
      } },
    })
    void running.catch(() => {})
    try {
      stdin.write(
        `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'synthetic transport fixture' } })}\n`,
      )
      await toolComplete
      await idlePolled
      assert.equal(commands, 1)
      assert.deepEqual(Buffer.concat(output), raw)
      assert.equal(existsSync(receiptPath(f)), true)
      assert.equal(readFileSync(effectPath(f), 'utf8'), 'one local effect')
      controller.abort()
      await running
      assert.equal(hostCloses, 1)
    } finally {
      controller.abort()
      await running.catch(() => {})
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      f.cleanup()
    }
  },
)


const RESULT_LIMIT = 128 * 1024
/** Wire bytes for these single-text-block fixtures: key order is already sorted. */
const resultBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value))

test('a 100KiB tool result is journaled and delivered instead of breaking the pump', { timeout: 5000 }, async () => {
  const f = fixture()
  const text = 'x'.repeat(100 * 1024)
  const produced: Cc5ToolResult = { content: [{ type: 'text', text }], isError: false }
  const h = await harness(f, { request: f.request, admission: f.admission }, { result: produced })
  try {
    h.observation.ingest(original(f))
    // A rejected pump shows up here instead of waiting for a poll that never comes.
    const outcome = await Promise.race([
      h.idlePolled.then(() => 'idle'),
      h.running.then(() => 'settled', () => 'failed'),
    ])
    assert.equal(outcome, 'idle')
    assert.deepEqual(h.counts(), { pollCount: 2, resultCount: 1, effects: 1 })
    assert.deepEqual(h.receipt()!.result, produced)
    assert.deepEqual(JSON.parse(readFileSync(receiptPath(f), 'utf8')), h.receipt())
  } finally {
    await h.close()
    f.cleanup()
  }
})

test('an oversized tool result is truncated with its original byte count, never fatal', { timeout: 5000 }, async () => {
  const f = fixture()
  const produced: Cc5ToolResult = { content: [{ type: 'text', text: 'y'.repeat(140 * 1024) }], isError: true }
  const producedBytes = resultBytes(produced)
  assert.ok(producedBytes > RESULT_LIMIT)
  const h = await harness(f, { request: f.request, admission: f.admission }, { result: produced, duplicate: true })
  try {
    h.observation.ingest(original(f))
    const outcome = await Promise.race([
      h.idlePolled.then(() => 'idle'),
      h.running.then(() => 'settled', () => 'failed'),
    ])
    assert.equal(outcome, 'idle')
    // The duplicate delivery replays the journaled receipt through readRecord.
    assert.deepEqual(h.counts(), { pollCount: 3, resultCount: 2, effects: 1 })
    const receipt = h.receipt()!
    assert.equal(receipt.result.isError, true)
    assert.equal(receipt.result.content.length, 1)
    assert.equal(receipt.result.content[0].type, 'text')
    const text = (receipt.result.content[0] as { type: string; text: string }).text
    assert.ok(text.startsWith('y'.repeat(4096)))
    assert.ok(text.endsWith(`[cc5 tool result truncated: original ${producedBytes} bytes]`))
    assert.ok(resultBytes(receipt.result) <= RESULT_LIMIT)
    assert.deepEqual(JSON.parse(readFileSync(receiptPath(f), 'utf8')), receipt)
  } finally {
    await h.close()
    f.cleanup()
  }
})
