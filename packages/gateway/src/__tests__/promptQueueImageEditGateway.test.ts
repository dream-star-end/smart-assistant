import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import type { OpenClaudeConfig } from '@openclaude/storage'
import { paths } from '@openclaude/storage'
import sharp from 'sharp'

import { Gateway } from '../server.js'
import {
  type AgentSession,
  type PromptQueueExecutionFence,
  SessionManager,
} from '../sessionManager.js'
import { V3_CODEX_RELAY_PREFIX } from '../v3CodexRelay.js'
import {
  makeV3MasterSink,
  SERVER_AUTHORED_PATH,
  setV3MasterSinkSingleton,
  type V3MasterSink,
} from '../v3MasterSink.js'
import { makeV3MasterRetryQueue } from '../v3MasterRetryQueue.js'

const JOB_ID = '71'.repeat(16)
const REQUEST_ID = '72'.repeat(16)
const TRACE_ID = '73'.repeat(16)
const SESSION_KEY = 'agent:codex:webchat:dm:queue-image-gateway'

function config(): OpenClaudeConfig {
  return {
    version: 1,
    gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
    auth: { mode: 'subscription', claudeCodePath: '' },
    sessions: { dbPath: '' },
    defaults: { model: 'glm-5.2' },
  } as unknown as OpenClaudeConfig
}

function session(): AgentSession {
  return {
    sessionKey: SESSION_KEY,
    agentId: 'codex',
    channel: 'webchat',
    peerId: 'queue-image-gateway',
    userId: '11',
    title: 'Queued ImageEdit production path',
    startedAt: Date.now(),
    runner: {
      engineId: 'codex-native',
      isRunning: false,
      clearSessionId() {},
      async shutdown() {},
    },
    ccbSessionId: null,
    lock: Promise.resolve(),
    lastUsedAt: 0,
    totalCostUSD: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    turns: 0,
    _lastCcbCumulativeCost: 0,
    _activeClientTurnCount: 0,
    toolUseIdToName: new Map(),
    executionTarget: { kind: 'local' },
    providerTag: 'codex-native',
  } as unknown as AgentSession
}

async function readJsonBody(req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

describe('queued ImageEdit production Gateway path', () => {
  test('activates before the paid relay and completes after the real lossless HTTP tape ACK', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'oc-queue-image-gateway-'))
    const outputPath = join(paths.generatedDir, `image2-edit-${JOB_ID}.png`)
    const sourceName = `queue-image-${JOB_ID}-source.png`
    const maskName = `queue-image-${JOB_ID}-mask.png`
    const guideName = `queue-image-${JOB_ID}-guide.png`
    const sourcePath = join(paths.uploadsDir, sourceName)
    const maskPath = join(paths.uploadsDir, maskName)
    const guidePath = join(paths.uploadsDir, guideName)
    const previousMaster = process.env.OPENCLAUDE_V3_MASTER_BASE_URL
    const previousToken = process.env.OPENCLAUDE_V3_CONTAINER_TOKEN
    const previousAuthority = process.env.OC_MODEL_AUTHORITY
    const relayBodies: Array<Record<string, unknown>> = []
    const tapeEnvelopes: Array<Record<string, unknown>> = []
    const delivered: Array<Record<string, unknown>> = []
    const reservations: Array<{ turnIndex: number; turnKey: string; traceId?: string }> = []
    const settlements: unknown[] = []
    const png = await sharp({
      create: { width: 2, height: 2, channels: 4, background: { r: 40, g: 80, b: 120, alpha: 1 } },
    }).png().toBuffer()
    const mask = await sharp({
      create: { width: 2, height: 2, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
    }).png().toBuffer()
    let sink: V3MasterSink
    let executionFence: PromptQueueExecutionFence | undefined
    const master = createServer(async (req, res) => {
      try {
        if (req.url === `${V3_CODEX_RELAY_PREFIX}/backend-api/codex/images/annotated-edits`) {
          assert.equal(req.headers.authorization, 'Bearer queue-image-test-token')
          assert.equal(req.headers['x-openclaude-image-job'], JOB_ID)
          relayBodies.push(await readJsonBody(req))
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
          return
        }
        if (req.url === SERVER_AUTHORED_PATH) {
          assert.equal(req.headers.authorization, 'Bearer queue-image-test-token')
          tapeEnvelopes.push(await readJsonBody(req))
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: true }))
          return
        }
        res.statusCode = 404
        res.end()
      } catch (error) {
        res.statusCode = 500
        res.end(error instanceof Error ? error.message : String(error))
      }
    })

    try {
      await mkdir(paths.uploadsDir, { recursive: true })
      await mkdir(paths.generatedDir, { recursive: true })
      await Promise.all([
        writeFile(sourcePath, png),
        writeFile(maskPath, mask),
        writeFile(guidePath, png),
      ])
      await new Promise<void>((resolve) => master.listen(0, '127.0.0.1', resolve))
      const address = master.address()
      assert.ok(address && typeof address === 'object')
      const baseUrl = `http://127.0.0.1:${address.port}`
      process.env.OPENCLAUDE_V3_MASTER_BASE_URL = baseUrl
      process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = 'queue-image-test-token'
      process.env.OC_MODEL_AUTHORITY = '0'

      const retryQueue = makeV3MasterRetryQueue({
        dir: join(tempDir, 'retry'),
        attemptSend: (payload) => sink.attemptOnce(payload),
      })
      sink = makeV3MasterSink({
        config: { baseUrl, bearer: 'queue-image-test-token' },
        retryQueue,
      })
      setV3MasterSinkSingleton(sink)

      const manager = new SessionManager(config())
      const activeSession = session()
      ;(manager as unknown as { _saveResumeMap: () => void })._saveResumeMap = () => {}
      ;(manager as unknown as { getOrCreate: () => Promise<AgentSession> }).getOrCreate = async () => activeSession
      executionFence = manager.beginPromptQueueExecutionFence(SESSION_KEY)
      assert.ok(executionFence)

      const lifecycle = {
        queueTurn: true as const,
        onTurnReserved: async (reservation: { turnIndex: number; turnKey: string; traceId?: string }) => {
          reservations.push(reservation)
          assert.equal(relayBodies.length, 0, 'activation must happen before the paid relay')
        },
        onSettled: async (error?: unknown) => { settlements.push(error) },
      }
      const frame = {
        type: 'inbound.message',
        channel: 'webchat',
        peer: { id: 'queue-image-gateway', kind: 'dm' },
        agentId: 'codex',
        model: 'gpt-5.6-sol',
        requestId: REQUEST_ID,
        traceId: TRACE_ID,
        _userId: '11',
        content: {
          text: '把圈选区域改成晚霞',
          media: [sourceName, maskName, guideName].map((name) => ({
            kind: 'image',
            url: `/api/media/${name}`,
            mimeType: 'image/png',
          })),
          imageEdit: {
            clientJobId: JOB_ID,
            sourceIndex: 0,
            maskIndex: 1,
            guideIndex: 2,
            width: 2,
            height: 2,
          },
        },
      }
      const agentsConfig = {
        default: 'main',
        agents: [
          { id: 'main', model: 'glm-5.2' },
          { id: 'codex', model: 'gpt-5.6-sol', provider: 'codex-native' },
        ],
      }
      const gateway = Object.create(Gateway.prototype) as Gateway & Record<string, any>
      Object.assign(gateway, {
        deps: { config: config(), agentsConfig },
        sessions: manager,
        _promptQueueLifecycleByFrame: new WeakMap([[frame, lifecycle]]),
        _promptQueueExecutionFenceByFrame: new WeakMap([[frame, executionFence]]),
        _shuttingDown: false,
        _runtimeRecycleDrainUntil: 0,
        _runtimeRecycleIngressActive: 0,
        _seenIdempotencyKeys: new Map(),
        trustedGoalFrames: new WeakSet(),
        clientsByPeer: new Map(),
        lastActiveChannel: new Map(),
        rateLimiter: { check: () => true },
        log: { debug() {}, info() {}, warn() {}, error() {} },
        _getAgentsConfig: async () => agentsConfig,
        deliver: (out: Record<string, unknown>) => { delivered.push(out) },
      })

      await (gateway as unknown as {
        dispatchInbound: (input: Record<string, unknown>) => Promise<void>
      }).dispatchInbound(frame)

      assert.equal(relayBodies.length, 1)
      assert.equal(relayBodies[0]?.jobId, JOB_ID)
      assert.equal(reservations.length, 1)
      assert.equal(reservations[0]?.traceId, TRACE_ID)
      assert.deepEqual(settlements, [undefined])
      assert.equal(await retryQueue.pendingCount(), 0)
      assert.equal(tapeEnvelopes.filter((entry) => entry.action === 'finalize').length, 1)
      const parts = tapeEnvelopes
        .filter((entry) => entry.action === 'part')
        .sort((a, b) => Number(a.partIndex) - Number(b.partIndex))
      const canonical = Buffer.concat(parts.map((entry) => Buffer.from(String(entry.data), 'base64')))
      const finalize = tapeEnvelopes.find((entry) => entry.action === 'finalize')
      assert.equal(createHash('sha256').update(canonical).digest('hex'), finalize?.tapeSha256)
      const persisted = JSON.parse(canonical.toString('utf8')) as Record<string, any>
      assert.equal(persisted.turnKey, reservations[0]?.turnKey)
      assert.equal(persisted.sessionId, 'queue-image-gateway')
      assert.equal(persisted.requestId, REQUEST_ID)
      assert.equal(persisted.usage?.model, 'gpt-image-2')
      assert.match(String(persisted.text), /Image 2 · 50 积分/)
      assert.equal(delivered.filter((entry) => entry.isFinal === true).length, 1)
      assert.equal(delivered.find((entry) => entry.isFinal === true)?.imageEditJobId, JOB_ID)
      assert.equal(activeSession._activeClientTurnCount, 0)
      assert.equal(executionFence.release(), undefined)
    } finally {
      setV3MasterSinkSingleton(null)
      executionFence?.release()
      await new Promise<void>((resolve) => master.close(() => resolve()))
      if (previousMaster === undefined) delete process.env.OPENCLAUDE_V3_MASTER_BASE_URL
      else process.env.OPENCLAUDE_V3_MASTER_BASE_URL = previousMaster
      if (previousToken === undefined) delete process.env.OPENCLAUDE_V3_CONTAINER_TOKEN
      else process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = previousToken
      if (previousAuthority === undefined) delete process.env.OC_MODEL_AUTHORITY
      else process.env.OC_MODEL_AUTHORITY = previousAuthority
      await Promise.all([
        rm(sourcePath, { force: true }),
        rm(maskPath, { force: true }),
        rm(guidePath, { force: true }),
        rm(outputPath, { force: true }),
        rm(tempDir, { recursive: true, force: true }),
      ])
    }
  })
})
