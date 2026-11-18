/**
 * Production-entry terminal settlement regression suite for `remote-driver-v4`
 * (`OCV5-776` / `INC-20261116-REMOTE-V4-FENCE-ORPHAN`).
 *
 * Proves through the real `SessionManager.getOrCreate` -> `SessionManager.submit` ->
 * `RemoteEngineAdapter` -> `RemoteContainerLane` -> `makeV3MasterSink` ->
 * `turn_dispatch_inbox` SQLite pipeline that every non-receipt exit path:
 *   1. Mid-turn `CC5_TOOLHOST_EXECUTION_UNKNOWN` lane fence after a completed tool
 *   2. Escalated user Stop (`runner.shutdown()` -> `stopLane()`) during a hung tool
 *   3. Planned gateway `beginPlannedShutdown()` mid-turn
 *   4. Pre-dispatch failure / pre-dispatch explicit user Stop (`abandoned`)
 * durably stages and ACKs the terminal tape, transitions `turn_dispatch_inbox` to
 * `terminal`, and emits the client-visible terminal error only after master ACK.
 */
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, test, type TestContext } from 'node:test'
import {
  REMOTE_DRIVER_BACKEND,
  REMOTE_DRIVER_PROTOCOL_VERSION,
  authoritySigningInput,
  encodeAuthorityEnvelope,
  encodeTurnLeaseEnvelope,
  parseRemoteDriverExecutionBackend,
  remoteCanonicalSha256,
  turnLeaseSigningInput,
  verifyAuthority,
  type AuthorityKeyring,
  type ModelAuthorityPayload,
  type TurnLease,
} from '@openclaude/protocol'
import type { OpenClaudeConfig } from '@openclaude/storage'

const testHome = mkdtempSync(join(tmpdir(), 'oc-rpool-settlement-home-'))
process.env.OPENCLAUDE_HOME = testHome
process.env.OC_USER_ID = '3'
Reflect.deleteProperty(process.env, 'OC_RUNTIME_CHANNEL')

const {
  closeSessionsDb,
  getTurnDispatchByDispatchId,
  insertQueuedTurnDispatch,
} = await import('@openclaude/storage')
const { SessionManager } = await import('../sessionManager.js')
const { registerRemoteDriverAdapter } = await import('../engine/registry.js')
const {
  __resetIntelligentUiDesiredCacheForTests,
  __setIntelligentUiDesiredFetchForTests,
} = await import('../intelligentUiDesired.js')
const { makeV3MasterRetryQueue } = await import('../v3MasterRetryQueue.js')
const {
  makeV3MasterSink,
  setV3MasterSinkSingleton,
} = await import('../v3MasterSink.js')
import type { V3MasterSinkWirePayload } from '../v3MasterSink.js'
const {
  inboxSinkStageFailedByDispatch,
  inboxSinkStagedByDispatch,
  resolveInboxTerminalAck,
} = await import('../turnDispatchInbox.js')
const {
  RemoteEngineAdapter,
  remotePoolBackendOf,
} = await import('../remotePool/index.js')
await import('../remotePool/registerRemoteDriver.js')

import type {
  LaneToolHost,
  RemoteContainerLaneOptions,
  RemotePoolBinding,
  RemoteRelayedFrame,
} from '../remotePool/index.js'

const laneOverridesByOpId = new Map<string, RemoteContainerLaneOptions>()
registerRemoteDriverAdapter((opts) => {
  const backend = parseRemoteDriverExecutionBackend(opts.executionBackend)
  return new RemoteEngineAdapter(opts, laneOverridesByOpId.get(backend.operationId) ?? {})
})

beforeEach(() => {
  __resetIntelligentUiDesiredCacheForTests()
  __setIntelligentUiDesiredFetchForTests(async () => false)
})

after(async () => {
  laneOverridesByOpId.clear()
  registerRemoteDriverAdapter((opts) => new RemoteEngineAdapter(opts))
  __resetIntelligentUiDesiredCacheForTests()
  setV3MasterSinkSingleton(null)
  await closeSessionsDb()
  rmSync(testHome, { recursive: true, force: true })
})

interface HarnessCallbackContext {
  readonly sm: InstanceType<typeof SessionManager>
  readonly session: Awaited<ReturnType<InstanceType<typeof SessionManager>['getOrCreate']>>
  readonly pushPollFrame: (frame: RemoteRelayedFrame) => void
  readonly enqueueTool: (callId: string, remoteAlias: string, args: Record<string, unknown>) => void
  readonly nativeSessionId: string
}

interface ScriptedHarnessOptions {
  readonly driverId?: 'cc' | 'codex'
  readonly terminalRequestGraceMs?: number
  readonly onAdmit?: (ctx: HarnessCallbackContext) => Promise<void>
  readonly onNewTurn?: (ctx: HarnessCallbackContext) => Promise<void>
  readonly executeTool: (
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    ctx: HarnessCallbackContext,
  ) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError: boolean }>
  readonly beforeMasterSend?: (payload: V3MasterSinkWirePayload) => Promise<void>
}

async function createScriptedSettlementHarness(t: TestContext, options: ScriptedHarnessOptions) {
  const driverId = options.driverId ?? 'cc'
  const authorityEngine = driverId === 'codex' ? 'codex' : 'ccb'
  const canonicalModel = driverId === 'codex' ? 'gpt-6-luna-remote' : 'claude-opus-5-5-remote'
  const upstreamModel = driverId === 'codex' ? 'gpt-5.4' : 'claude-opus-4-6'

  const sandbox = mkdtempSync(join(tmpdir(), `oc-rpool-settle-${driverId}-`))
  const peerId = `websettle${randomUUID().replace(/-/g, '').slice(0, 10)}`
  const sessionKey = `agent:main:webchat:dm:${peerId}`
  const operationId = randomUUID()
  const runId = randomUUID()
  const profileId = `p-${randomUUID().toLowerCase()}`
  const nativeSessionId = randomUUID()

  const kp = generateKeyPairSync('ed25519')
  const keyId = 'v4-settle-key'
  const keys: AuthorityKeyring = new Map([
    [keyId, new Uint8Array(Buffer.from(kp.publicKey.export({ format: 'jwk' }).x!, 'base64url'))],
  ])

  const binding: RemotePoolBinding = {
    version: REMOTE_DRIVER_PROTOCOL_VERSION,
    backendKind: REMOTE_DRIVER_BACKEND,
    operationId,
    runId,
    uid: '3',
    containerDbId: '7',
    dockerId: 'd'.repeat(64),
    sessionKey,
    canonicalModel,
    upstreamModel,
    driverId,
    engineId: driverId,
    authorityEngine,
    driverVersion: '4.0.0',
    driverDigest: '1'.repeat(64),
    coreDigest: '2'.repeat(64),
    probeFingerprint: '3'.repeat(64),
    manifestSha256: '4'.repeat(64),
    generation: '1',
    profileId,
    authEpoch: 'epoch-1',
    capability: 'c'.repeat(64),
    expiresAt: Date.now() + 600_000,
  }

  let pollSeq = 0
  const pollRows: Array<{ seq: number; frame: RemoteRelayedFrame }> = []
  const pendingDeliveries: Array<{
    callId: string
    name: string
    arguments: Record<string, unknown>
    argsHash: string
    nativeSessionId: string
  }> = []
  let activeAuthority = ''
  let activeAuthorityTurnId = ''
  let activeLease = ''
  let activeTurnKey = ''
  let revoked = false
  let abandonedCount = 0
  const hostCloseAbort = new AbortController()
  let smRef!: InstanceType<typeof SessionManager>
  let sessionRef!: Awaited<ReturnType<InstanceType<typeof SessionManager>['getOrCreate']>>

  const pushPollFrame = (frame: RemoteRelayedFrame): void => {
    pollSeq += 1
    pollRows.push({ seq: pollSeq, frame })
  }

  const enqueueTool = (callId: string, remoteAlias: string, args: Record<string, unknown>): void => {
    const argsHash = remoteCanonicalSha256(args)
    const nextSeq = pollSeq + 1
    pushPollFrame({
      kind: 'security',
      event: {
        protocolVersion: REMOTE_DRIVER_PROTOCOL_VERSION,
        operationId,
        generation: '1',
        profileId,
        authEpoch: 'epoch-1',
        authorityTurnId: activeAuthorityTurnId,
        nativeSessionId,
        seq: nextSeq,
        rawFrameRef: {
          channel: 'native',
          frameSeq: nextSeq,
          sha256: 'a'.repeat(64),
        },
        driverId,
        driverVersion: '4.0.0',
        payload: {
          kind: 'toolCallObserved',
          phase: 'started',
          name: remoteAlias,
          callId,
          arguments: structuredClone(args),
          argsHash,
        },
      },
    })
    pendingDeliveries.push({
      callId,
      name: remoteAlias,
      arguments: structuredClone(args),
      argsHash,
      nativeSessionId,
    })
  }

  const getCtx = (): HarnessCallbackContext => ({
    sm: smRef,
    session: sessionRef,
    pushPollFrame,
    enqueueTool,
    nativeSessionId,
  })

  const hostFactory = (): LaneToolHost => ({
    tools: async () => [
      {
        name: 'ReadImage',
        description: 'Reads uploaded image',
        inputSchema: {
          type: 'object',
          properties: { file_path: { type: 'string' } },
          required: ['file_path'],
        },
      },
      {
        name: 'SlowGrep',
        description: 'Greps workspace',
        inputSchema: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      },
    ],
    execute: async (name, rawArgs) =>
      options.executeTool(name, rawArgs as Record<string, unknown>, hostCloseAbort.signal, getCtx()),
    close: async () => {
      hostCloseAbort.abort(new Error('CC5_TOOLHOST_STOPPED_DURING_EXECUTION'))
    },
  })

  laneOverridesByOpId.set(operationId, {
    binding,
    keyring: keys,
    executionRoot: join(sandbox, 'exec'),
    hostFactory,
    toolContextFactory: async () => ({
      profile: { cwd: sandbox, mcpConfigPath: null, settingsPath: null, disallowedTools: [] },
      env: { PATH: '/usr/bin:/bin' },
      platformPrompt: 'test prompt',
      promptCwd: sandbox,
      cleanup: () => {},
    }),
    call: async (path, body) => {
      if (path === '/admit') {
        activeAuthority = String(body.authority ?? '')
        activeAuthorityTurnId = verifyAuthority(activeAuthority, keys, Date.now()).authorityTurnId
        activeLease = String(body.lease ?? '')
        activeTurnKey = String(body.turnKey ?? '')
        await options.onAdmit?.(getCtx())
        return { ready: true, nativeSessionId, seq: pollSeq }
      }
      if (path === '/command') {
        const command = body.command as Record<string, unknown> | undefined
        if (command?.kind === 'newTurn') {
          await options.onNewTurn?.(getCtx())
        }
        return {}
      }
      if (path === '/poll') {
        if (revoked) return { frames: [] }
        const afterSeq = Number(body.afterSeq ?? 0)
        return { frames: pollRows.filter((r) => r.seq > afterSeq) }
      }
      if (path === '/baseline') {
        return { seq: pollSeq }
      }
      if (path === '/tool/next') {
        if (revoked) return {}
        const next = pendingDeliveries.shift()
        if (!next) return {}
        return {
          authority: activeAuthority,
          lease: activeLease,
          turnKey: activeTurnKey,
          request: {
            rpcId: next.callId,
            server: 'ocbridge',
            name: next.name,
            callId: next.callId,
            arguments: next.arguments,
            argsHash: next.argsHash,
            nativeSessionId: next.nativeSessionId,
          },
        }
      }
      if (path === '/tool/result') {
        return { callId: String(body.callId ?? '') }
      }
      if (path === '/tool/ack' || path === '/tool/stopped' || path === '/renew') {
        return {}
      }
      if (path === '/abandon') {
        abandonedCount += 1
        return { abandoned: true }
      }
      if (path === '/recycle') {
        return { appStopped: true }
      }
      if (path === '/stop') {
        revoked = true
        return { remoteStopped: true }
      }
      throw new Error(`Unexpected control path: ${path}`)
    },
  })

  const masterServer = createServer((req, res) => {
    res.setHeader('connection', 'close')
    const url = req.url ?? '/'
    if (url.startsWith('/internal/v3/marketplace/sync')) {
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ identityCompat: { schema: 1, userId: '3', profiles: [] } }))
      return
    }
    if (url.startsWith('/internal/v3/platform-prompt-slots')) {
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ slots: [], promptPolicy: { schemaVersion: 1, profile: null } }))
      return
    }
    res.statusCode = 404
    res.end()
  })
  await new Promise<void>((resolve) => masterServer.listen(0, '127.0.0.1', resolve))
  const masterPort = (masterServer.address() as { port: number }).port
  const prevMasterUrl = process.env.OPENCLAUDE_V3_MASTER_BASE_URL
  const prevContainerToken = process.env.OPENCLAUDE_V3_CONTAINER_TOKEN
  process.env.OPENCLAUDE_V3_MASTER_BASE_URL = `http://127.0.0.1:${masterPort}`
  process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = 'synthetic-v4-settle-token'

  const sentPayloads: V3MasterSinkWirePayload[] = []
  const queueDir = join(sandbox, 'sink-queue')
  const retryQueue = makeV3MasterRetryQueue({
    dir: queueDir,
    attemptSend: async (payload) => {
      await options.beforeMasterSend?.(payload)
      sentPayloads.push(structuredClone(payload))
    },
    onDispatchAck: (dispatchId, attemptNo, status) =>
      resolveInboxTerminalAck(dispatchId, attemptNo, status),
  })
  const sink = makeV3MasterSink({
    config: { baseUrl: `http://127.0.0.1:${masterPort}`, bearer: 'oc-v3.7.synthetic' },
    retryQueue,
    attemptSendImpl: async (payload) => {
      await options.beforeMasterSend?.(payload)
      sentPayloads.push(structuredClone(payload))
      return {}
    },
    inboxHooks: {
      onStaged: async (dispatchId, attemptNo) => {
        await inboxSinkStagedByDispatch(dispatchId, attemptNo)
      },
      onAck: (dispatchId, attemptNo, status) =>
        resolveInboxTerminalAck(dispatchId, attemptNo, status),
      onStageFailed: async (dispatchId, attemptNo) => {
        await inboxSinkStageFailedByDispatch(dispatchId, attemptNo)
      },
    },
  })
  setV3MasterSinkSingleton(sink)

  const config = {
    version: 1,
    gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
    auth: { mode: 'subscription', claudeCodePath: '' },
    sessions: { dbPath: '' },
    defaults: { model: canonicalModel },
    mcpServers: [],
  } as unknown as OpenClaudeConfig

  const sm = new SessionManager(config)
  smRef = sm
  if (options.terminalRequestGraceMs !== undefined) {
    ;(sm as unknown as { _terminalRequestGraceMs: number })._terminalRequestGraceMs =
      options.terminalRequestGraceMs
  }

  const session = await sm.getOrCreate({
    sessionKey,
    peerId,
    channel: 'webchat',
    userId: '3',
    agent: { id: 'main', model: canonicalModel, cwd: sandbox },
    model: canonicalModel,
    executionAuthority: {
      source: 'bridge_signed',
      engine: authorityEngine,
      canonicalModel,
      executionBackend: remotePoolBackendOf(binding),
    },
    workspaceCwd: sandbox,
  })
  sessionRef = session
  assert.ok(session.runner instanceof RemoteEngineAdapter)

  t.after(async () => {
    laneOverridesByOpId.delete(operationId)
    retryQueue.stopPeriodic()
    await sm.shutdownAll().catch(() => {})
    if (prevMasterUrl === undefined) Reflect.deleteProperty(process.env, 'OPENCLAUDE_V3_MASTER_BASE_URL')
    else process.env.OPENCLAUDE_V3_MASTER_BASE_URL = prevMasterUrl
    if (prevContainerToken === undefined) Reflect.deleteProperty(process.env, 'OPENCLAUDE_V3_CONTAINER_TOKEN')
    else process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = prevContainerToken
    setV3MasterSinkSingleton(null)
    await new Promise<void>((resolve) => {
      masterServer.closeAllConnections()
      masterServer.close(() => resolve())
    })
    rmSync(sandbox, { recursive: true, force: true })
  })

  const submitDurableTurn = async (prompt: string) => {
    const dispatchId = randomUUID()
    const clientMessageId = `m-${randomUUID().slice(0, 12)}`
    const issuedAt = Date.now()
    const authorityTurnId = createHash('md5').update(`auth:${dispatchId}`).digest('hex')
    const requestId = createHash('md5').update(`req:${dispatchId}`).digest('hex')

    await insertQueuedTurnDispatch({
      userId: '3',
      sessionId: peerId,
      clientMessageId,
      dispatchId,
      attemptNo: 1,
      payloadHash: createHash('sha256').update(prompt).digest('hex'),
      now: issuedAt,
    })

    const payload: ModelAuthorityPayload = {
      v: 1,
      keyId,
      uid: 3,
      containerId: 7,
      authorityTurnId,
      ...(authorityEngine === 'codex' ? { billingRequestId: requestId } : {}),
      connectionChallenge: 'challenge-settle',
      canonicalModel,
      engine: authorityEngine,
      executionBackend: remotePoolBackendOf(binding),
      securityEpoch: 1,
      executionRevision: 'rev-1',
      issuedAt,
      expiresAt: issuedAt + 120_000,
      executionDescriptor: {
        capabilityProfile:
          authorityEngine === 'ccb'
            ? { ccb: { capabilityZero: true, supportsThinking: true, contextOwner: 'box-native-v1' } }
            : {},
        capabilitySchemaVersion: 1,
        contextWindow: 200_000,
        supportsVision: true,
        supportedEfforts: ['low', 'medium', 'high'],
      },
    }
    const leasePayload: TurnLease = {
      v: 1,
      keyId,
      uid: 3,
      containerId: 7,
      authorityTurnId,
      connectionChallenge: 'challenge-settle',
      canonicalModel,
      securityEpoch: 1,
      issuedAt,
      expiresAt: issuedAt + 600_000,
    }
    const authorityEnvelope = encodeAuthorityEnvelope(
      payload,
      sign(null, authoritySigningInput(payload), kp.privateKey),
    )
    const leaseEnvelope = encodeTurnLeaseEnvelope(
      leasePayload,
      sign(null, turnLeaseSigningInput(leasePayload), kp.privateKey),
    )

    const events: Array<Record<string, unknown>> = []
    await sm.submit(
      session,
      prompt,
      (ev) => events.push(ev as unknown as Record<string, unknown>),
      'medium',
      canonicalModel,
      requestId,
      `trace-${dispatchId.slice(0, 8)}`,
      undefined,
      {
        modelAuthority: {
          authorityEnvelope,
          leaseEnvelope,
          executionDescriptor: {
            executionBackend: remotePoolBackendOf(binding),
            canonicalModel,
            contextWindow: 200_000,
            capabilityZero: authorityEngine === 'ccb',
            supportsThinking: true,
            supportsVision: true,
            supportedEfforts: ['low', 'medium', 'high'],
          },
        },
        replayLifecycle: {
          clientMessageId,
          onStart: () => {},
          onBeforeRelease: () => {},
          onEnd: () => {},
        },
        dispatchContext: {
          userId: '3',
          sessionId: peerId,
          clientMessageId,
          dispatchId,
          attemptNo: 1,
        },
      },
    )

    await sm.awaitPendingPersistence()
    const inboxRow = await getTurnDispatchByDispatchId(dispatchId, 1)
    return { dispatchId, clientMessageId, events, inboxRow }
  }

  return {
    sm,
    session,
    sentPayloads,
    getAbandonedCount: () => abandonedCount,
    pushPollFrame,
    enqueueTool,
    submitDurableTurn,
  }
}

test(
  'mid-turn CC5_TOOLHOST_EXECUTION_UNKNOWN after completed tool persists crashed tape and terminal inbox once (INC-20261116-REMOTE-V4-FENCE-ORPHAN)',
  { timeout: 15_000 },
  async (t) => {
    const h = await createScriptedSettlementHarness(t, {
      terminalRequestGraceMs: 50,
      onNewTurn: async ({ enqueueTool }) => {
        enqueueTool('toolu_img_1', 'ReadImage', { file_path: '/home/agent/.openclaude/uploads/sample.jpg' })
      },
      executeTool: async (name, _args, _signal, ctx) => {
        if (name === 'ReadImage') {
          ctx.enqueueTool('toolu_grep_2', 'SlowGrep', { command: 'grep -rl x .' })
          return { content: [{ type: 'text', text: 'IMAGE_OK' }], isError: false }
        }
        throw new Error('CC5_TOOLHOST_EXECUTION_UNKNOWN')
      },
    })

    const res = await h.submitDurableTurn('inspect screenshot and locate project menu')

    assert.equal(h.sentPayloads.length, 1, 'crashed remote-v4 turn must stage and send exactly one terminal tape')
    const tape = h.sentPayloads[0]!
    assert.equal(tape.status, 'crashed')
    assert.equal(tape.errorCode, 'RUNNER_CRASHED')
    assert.match(String(tape.errorDetail ?? ''), /CC5_TOOLHOST_EXECUTION_UNKNOWN/)
    assert.equal(tape.tools?.length, 2, 'completed and in-flight tool entries must both be preserved on crash tape')
    assert.equal(tape.tools?.[0]?.toolName, 'ReadImage')
    assert.equal(tape.tools?.[0]?.completed, true)
    assert.equal(tape.tools?.[1]?.toolName, 'SlowGrep')
    assert.equal(tape.tools?.[1]?.completed, false)

    assert.equal(res.inboxRow?.state, 'terminal', 'turn_dispatch_inbox must converge to terminal, never stay running')
    assert.equal(res.inboxRow?.outcome, 'crashed')

    const terminalEvents = res.events.filter((e) => e.kind === 'error' || e.kind === 'final')
    assert.equal(terminalEvents.length, 1, 'browser stream must receive exactly one terminal frame even after delayed callbacks drain')
    const terminalErr = terminalEvents[0]!
    assert.equal(terminalErr.kind, 'error')
    assert.equal(terminalErr.errorCode, 'runner_crashed')
  },
)

test(
  'escalated user Stop during hung tool persists USER_CANCELLED tape instead of dropping on finalized null summary (INC-20261116-REMOTE-V4-FENCE-ORPHAN)',
  { timeout: 15_000 },
  async (t) => {
    let stopTriggered = false
    const h = await createScriptedSettlementHarness(t, {
      terminalRequestGraceMs: 60,
      onNewTurn: async ({ enqueueTool }) => {
        enqueueTool('toolu_hung_1', 'SlowGrep', { command: 'sleep 999' })
      },
      executeTool: async (_name, _args, signal, ctx) => {
        if (!stopTriggered) {
          stopTriggered = true
          setTimeout(() => {
            ctx.sm.interrupt(ctx.session.sessionKey, 'user')
          }, 15)
        }
        await new Promise<never>((_resolve, reject) => {
          if (signal.aborted) {
            reject(new Error('CC5_TOOLHOST_STOPPED_DURING_EXECUTION'))
            return
          }
          signal.addEventListener(
            'abort',
            () => reject(new Error('CC5_TOOLHOST_STOPPED_DURING_EXECUTION')),
            { once: true },
          )
        })
        throw new Error('unreachable')
      },
    })

    const res = await h.submitDurableTurn('run hung grep then click Stop')

    assert.equal(stopTriggered, true)
    assert.equal(h.sentPayloads.length, 1, 'escalated Stop must persist USER_CANCELLED tape once')
    const tape = h.sentPayloads[0]!
    assert.equal(tape.status, 'interrupted')
    assert.equal(tape.errorCode, 'USER_CANCELLED')
    assert.equal(res.inboxRow?.state, 'terminal')
    assert.equal(res.inboxRow?.outcome, 'interrupted')

    const terminalEvents = res.events.filter((e) => e.kind === 'error' || e.kind === 'final')
    assert.equal(terminalEvents.length, 1)
    const terminalErr = terminalEvents[0]!
    assert.equal(terminalErr.kind, 'error')
    assert.equal(terminalErr.errorCode, 'user_cancelled')
  },
)

test(
  'planned gateway beginPlannedShutdown mid-turn persists SERVICE_RESTART with no_response waiver instead of RUNNER_CRASHED (INC-20261116-REMOTE-V4-FENCE-ORPHAN)',
  { timeout: 15_000 },
  async (t) => {
    let shutdownTriggered = false
    const h = await createScriptedSettlementHarness(t, {
      terminalRequestGraceMs: 50,
      onNewTurn: async ({ enqueueTool }) => {
        enqueueTool('toolu_deploy_1', 'SlowGrep', { command: 'grep -rn foo .' })
      },
      executeTool: async (_name, _args, signal, ctx) => {
        if (!shutdownTriggered) {
          shutdownTriggered = true
          setTimeout(() => {
            // Exact gatewayLifecycle order: beginPlannedShutdown() runs before shutdownAll() sets _plannedTeardown.
            ctx.sm.beginPlannedShutdown()
          }, 15)
        }
        await new Promise<never>((_resolve, reject) => {
          if (signal.aborted) {
            reject(new Error('CC5_TOOLHOST_STOPPED_DURING_EXECUTION'))
            return
          }
          signal.addEventListener(
            'abort',
            () => reject(new Error('CC5_TOOLHOST_STOPPED_DURING_EXECUTION')),
            { once: true },
          )
        })
        throw new Error('unreachable')
      },
    })

    const res = await h.submitDurableTurn('in-flight turn during container SIGTERM')

    assert.equal(shutdownTriggered, true)
    assert.equal(h.sentPayloads.length, 1)
    const tape = h.sentPayloads[0]!
    assert.equal(tape.status, 'interrupted')
    assert.equal(tape.errorCode, 'SERVICE_RESTART')
    assert.equal(tape.waiveReason, 'no_response')
    assert.equal(res.inboxRow?.state, 'terminal')
    assert.equal(res.inboxRow?.outcome, 'interrupted')
    assert.equal(res.events.filter((e) => e.kind === 'error' || e.kind === 'final').length, 1)
  },
)

test(
  'pre-dispatch explicit user Stop waits for master ACK before surfacing error while pre-dispatch fence persists crashed tape (INC-20261116-REMOTE-V4-FENCE-ORPHAN)',
  { timeout: 15_000 },
  async (t) => {
    let eventsObservedDuringSend = -1
    let currentEventsRef: Array<Record<string, unknown>> | undefined

    const hCancel = await createScriptedSettlementHarness(t, {
      terminalRequestGraceMs: 50,
      onAdmit: async (ctx) => {
        ctx.sm.interrupt(ctx.session.sessionKey, 'user')
      },
      executeTool: async () => ({ content: [], isError: false }),
      beforeMasterSend: async () => {
        eventsObservedDuringSend =
          currentEventsRef?.filter((e) => e.kind === 'error').length ?? 0
      },
    })

    // Wrap onEvent check by inspecting via submitDurableTurn: beforeMasterSend runs before persistOrQueue resolves!
    const origSubmit = hCancel.sm.submit.bind(hCancel.sm)
    hCancel.sm.submit = (async (...args: Parameters<typeof origSubmit>) => {
      const origOnEvent = args[2]
      const captured: Array<Record<string, unknown>> = []
      currentEventsRef = captured
      args[2] = (ev) => {
        captured.push(ev as unknown as Record<string, unknown>)
        origOnEvent(ev)
      }
      return origSubmit(...args)
    }) as typeof origSubmit

    const cancelledRes = await hCancel.submitDurableTurn('cancel during admit')
    assert.equal(hCancel.getAbandonedCount(), 1)
    assert.equal(
      eventsObservedDuringSend,
      0,
      'terminal error frame MUST NOT be emitted before master sink ACKs the tape',
    )
    assert.equal(hCancel.sentPayloads.length, 1)
    assert.equal(hCancel.sentPayloads[0]!.status, 'interrupted')
    assert.equal(hCancel.sentPayloads[0]!.errorCode, 'USER_CANCELLED')
    assert.equal(cancelledRes.inboxRow?.state, 'terminal')
    assert.equal(cancelledRes.inboxRow?.outcome, 'interrupted')

    const hFence = await createScriptedSettlementHarness(t, {
      terminalRequestGraceMs: 50,
      onAdmit: async () => {
        throw new Error('REMOTE_HOST_CONTROL_FAILED')
      },
      executeTool: async () => ({ content: [], isError: false }),
    })

    const fencedRes = await hFence.submitDurableTurn('admit transport failure')
    assert.equal(hFence.sentPayloads.length, 1)
    assert.equal(hFence.sentPayloads[0]!.status, 'crashed')
    assert.equal(hFence.sentPayloads[0]!.errorCode, 'RUNNER_CRASHED')
    assert.match(String(hFence.sentPayloads[0]!.errorDetail ?? ''), /REMOTE_HOST_CONTROL_FAILED/)
    assert.equal(fencedRes.inboxRow?.state, 'terminal')
    assert.equal(fencedRes.inboxRow?.outcome, 'crashed')

    // Non-user lane fence while /admit is completing enters containerLane's pre-dispatch `abandoned` branch
    // (`turn.abort.signal.aborted === true` at line 1006): must settle as crashed RUNNER_CRASHED, never drop or fake USER_CANCELLED.
    const hAbandonedFence = await createScriptedSettlementHarness(t, {
      terminalRequestGraceMs: 50,
      onAdmit: async (ctx) => {
        const adapter = ctx.session.runner as InstanceType<typeof RemoteEngineAdapter>
        ;(adapter as unknown as { lane: { fence: (reason: string) => void } }).lane.fence(
          'REMOTE_LEASE_RENEW_FAILED',
        )
      },
      executeTool: async () => ({ content: [], isError: false }),
    })

    const abandonedFenceRes = await hAbandonedFence.submitDurableTurn('fenced before newTurn dispatch')
    assert.equal(hAbandonedFence.getAbandonedCount(), 1)
    assert.equal(
      hAbandonedFence.sentPayloads.length,
      1,
      'abandoned turn caused by lane fence must persist crashed tape instead of dropping',
    )
    assert.equal(hAbandonedFence.sentPayloads[0]!.status, 'crashed')
    assert.equal(hAbandonedFence.sentPayloads[0]!.errorCode, 'RUNNER_CRASHED')
    assert.match(
      String(hAbandonedFence.sentPayloads[0]!.errorDetail ?? ''),
      /REMOTE_LEASE_RENEW_FAILED/,
    )
    assert.equal(abandonedFenceRes.inboxRow?.state, 'terminal')
    assert.equal(abandonedFenceRes.inboxRow?.outcome, 'crashed')
  },
)
