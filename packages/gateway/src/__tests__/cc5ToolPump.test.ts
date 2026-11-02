import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { type Server, type ServerResponse, createServer } from 'node:http'
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
import { CC5_FIXED_TOOL_NAME, type Cc5ToolRequest } from '../cc5FixedTool.js'
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
    version: 1,
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
    canonicalModel: 'cc5-remote-t1555u',
    engine: 'cursor',
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
    sessionKey: 'personal-task-session',
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
async function harness(f: ReturnType<typeof fixture>, delivery: Cc5ToolDelivery, loseAck = false) {
  const socketPath = relative(process.cwd(), join(f.root, 's'))
  const controller = new AbortController()
  const observation = new Cc5ToolObservation(f.binding.operationId)
  let polled!: () => void
  const pollReady = new Promise<void>((resolve) => {
    polled = resolve
  })
  let pollCount = 0
  let resultCount = 0
  let result: Record<string, unknown> | undefined
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (b) => chunks.push(b))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString())
      assert.equal(body.capability, f.binding.capability)
      assert.equal(body.operationId, f.binding.operationId)
      if (req.url === '/tool/next') {
        pollCount++
        res.end(JSON.stringify({ ok: true, delivery }))
        polled()
      } else if (req.url === '/tool/result') {
        resultCount++
        result = body.receipt
        if (loseAck) res.destroy()
        else res.end(JSON.stringify({ ok: true, commandId: result!.commandId }))
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
    close,
    counts: () => ({ pollCount, resultCount }),
    receipt: () => result,
  }
}

test('real Unix tool pump waits for the full original tool row then executes only in its fixed local root', async () => {
  const f = fixture()
  const h = await harness(f, { request: f.request, admission: f.admission })
  try {
    await h.pollReady
    const bytes = original(f)
    h.observation.ingest(bytes.subarray(0, bytes.length - 1))
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(existsSync(join(f.root, f.binding.operationId)), false)
    h.observation.ingest(bytes.subarray(bytes.length - 1))
    const receipt = await h.running
    assert.deepEqual(h.counts(), { pollCount: 1, resultCount: 1 })
    assert.deepEqual(h.receipt(), receipt)
    assert.equal(receipt.dockerId, f.binding.dockerId)
    assert.equal(
      readFileSync(join(f.root, f.binding.operationId, 'cc5-proof.txt'), 'utf8'),
      `${receipt.marker}\n`,
    )
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
    assert.equal(h.counts().resultCount, 0)
  } finally {
    await h.close()
    f.cleanup()
  }
})

test('lost result ACK leaves one real terminal receipt and never repeats the tool poll or effect', async () => {
  const f = fixture()
  const h = await harness(f, { request: f.request, admission: f.admission }, true)
  try {
    h.observation.ingest(original(f))
    await assert.rejects(h.running)
    const receipt = JSON.parse(
      readFileSync(join(f.root, f.binding.operationId, 'receipt.json'), 'utf8'),
    )
    assert.equal(receipt.exitCode, 0)
    assert.equal(h.receipt()!.commandId, receipt.commandId)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.deepEqual(h.counts(), { pollCount: 1, resultCount: 1 })
  } finally {
    await h.close()
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
          res.end(
            JSON.stringify({ ok: true, delivery: { request: f.request, admission: f.admission } }),
          )
        } else if (req.url === '/tool/result') {
          const value = JSON.parse(body)
          assert.equal(value.receipt.exitCode, 0)
          commands++
          res.end(JSON.stringify({ ok: true, commandId: value.receipt.commandId }))
          complete()
        } else if (req.url === '/stop') {
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
      tools: { keyring: f.keyring, executionRoot: f.root },
    })
    void running.catch(() => {})
    try {
      stdin.write(
        `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'synthetic transport fixture' } })}\n`,
      )
      await toolComplete
      assert.equal(commands, 1)
      assert.deepEqual(Buffer.concat(output), raw)
      assert.equal(existsSync(join(f.root, f.binding.operationId, 'receipt.json')), true)
      controller.abort()
      await running
    } finally {
      controller.abort()
      await running.catch(() => {})
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      f.cleanup()
    }
  },
)
