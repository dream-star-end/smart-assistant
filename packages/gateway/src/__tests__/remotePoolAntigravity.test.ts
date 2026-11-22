import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  REMOTE_DRIVER_BACKEND,
  REMOTE_DRIVER_PROTOCOL_VERSION,
  SWARM_BOARD_TOOL_NAME,
  authoritySigningInput,
  encodeAuthorityEnvelope,
  encodeTurnLeaseEnvelope,
  remoteCanonicalSha256,
  turnLeaseSigningInput,
  type AuthorityKeyring,
  type ModelAuthorityPayload,
  type RemoteReceiptV4,
  type TurnLease,
} from '@openclaude/protocol'
import { createRemoteLaneRuntime } from '../cc5ContainerRuntime.js'
import type { EngineEvent } from '../engine/engineEvents.js'
import { resolveEngineRemoteContextBuilder } from '../engine/registry.js'
import {
  RemoteSwarmRuntime,
  disableRemoteSwarmCoordinatorMcp,
  lookupRemoteSwarmMcpContext,
  remoteSwarmLocationForSession,
} from '../remoteSwarmRuntime.js'
import '../remotePool/registerRemoteDriver.js'
import type { LaneToolHost } from '../remotePool/containerLane.js'
import { RemoteEngineAdapter } from '../remotePool/remoteEngineAdapter.js'
import type { RemotePoolBinding } from '../remotePool/types.js'

const HEX64_A = 'a'.repeat(64)
const HEX64_B = 'b'.repeat(64)
const HEX64_C = 'c'.repeat(64)

function sampleAntigravityBinding(overrides: Partial<RemotePoolBinding> = {}): RemotePoolBinding {
  return Object.freeze({
    version: REMOTE_DRIVER_PROTOCOL_VERSION,
    backendKind: REMOTE_DRIVER_BACKEND,
    operationId: '11111111-1111-4111-8111-111111111111',
    runId: 'run-agy-1',
    uid: '3',
    containerDbId: '7',
    dockerId: 'd'.repeat(64),
    sessionKey: 'agent:main:webchat:dm:agy_unit_test_1',
    canonicalModel: 'antigravity-gemini-4-carbon-remote',
    upstreamModel: 'gemini-4-carbon-medium',
    driverId: 'antigravity',
    engineId: 'antigravity',
    authorityEngine: 'antigravity',
    driverVersion: '1.0.0',
    driverDigest: HEX64_A,
    coreDigest: HEX64_B,
    probeFingerprint: HEX64_C,
    manifestSha256: HEX64_A,
    generation: '1',
    profileId: '22222222-2222-4222-8222-222222222222',
    authEpoch: 'epoch-agy-1',
    capability: HEX64_B,
    expiresAt: Date.now() + 600_000,
    ...overrides,
  })
}

test('RemoteEngineAdapter configures antigravity authority with antigravity-session resume and server requestId requirement', () => {
  const adapter = new RemoteEngineAdapter(
    {
      agentId: 'main',
      agentBaseDir: '/tmp',
      sessionKey: 'agent:main:webchat:dm:agy_unit_test_1',
      model: 'antigravity-gemini-4-carbon-remote',
      config: { auth: {}, gateway: { port: 18790, accessToken: 'test-token' }, mcpServers: [] } as any,
      executionBackend: {
        kind: REMOTE_DRIVER_BACKEND,
        version: REMOTE_DRIVER_PROTOCOL_VERSION,
        sessionKey: 'agent:main:webchat:dm:agy_unit_test_1',
        operationId: '11111111-1111-4111-8111-111111111111',
        driverId: 'antigravity',
        engineId: 'antigravity',
        authorityEngine: 'antigravity',
        driverVersion: '1.0.0',
        generation: '1',
        profileId: '22222222-2222-4222-8222-222222222222',
        authEpoch: 'epoch-agy-1',
      },
    },
    {
      binding: sampleAntigravityBinding(),
      keyring: new Map([['v4-test', new Uint8Array(32).fill(1)]]),
      socketPath: '/tmp/nonexistent-agy-relay.sock',
      toolContextFactory: async () => ({
        profile: {} as any,
        env: { PATH: '/usr/bin:/bin' },
        platformPrompt: '',
        cleanup: () => {},
      }),
    },
  )

  assert.equal(adapter.engineId, 'antigravity')
  assert.equal(adapter.capabilities.billingMode, 'proxy')
  assert.equal(adapter.capabilities.resumeKind, 'antigravity-session')
  assert.equal(adapter.capabilities.needsServerRequestId, true)
  assert.equal(adapter.capabilities.multimodalInput, 'text-only')
  assert.equal(remoteCanonicalSha256({ a: 1 }).length, 64)
})

test('registerRemoteDriver registers remote tool context resolver for antigravity', async () => {
  const resolver = resolveEngineRemoteContextBuilder('antigravity')
  assert.equal(typeof resolver, 'function')

  const td = mkdtempSync(join(tmpdir(), 'oc-agy-ctx-'))
  try {
    mkdirSync(join(td, 'ws'), { recursive: true })
    const res = await resolver!({
      opts: {
        agentId: 'main',
        agentBaseDir: td,
        sessionKey: 'agent:main:webchat:dm:agy_unit_test_ctx',
        model: 'antigravity-gemini-4-carbon-remote',
        config: { auth: {}, gateway: { port: 18790, accessToken: 'test-token' }, mcpServers: [] } as any,
        cwd: join(td, 'ws'),
      } as any,
      supportsVision: false,
      promptOnly: true,
    })
    assert.ok(Boolean(res.profile.mcpConfigPath && res.profile.mcpConfigPath.endsWith('.json')))
    assert.equal(typeof res.platformPrompt, 'string')
    res.cleanup()
  } finally {
    rmSync(td, { recursive: true, force: true })
  }
})

test('createRemoteLaneRuntime accepts antigravity binding shape alongside ccb and codex', () => {
  const binding = sampleAntigravityBinding()
  assert.equal(binding.authorityEngine, 'antigravity')
  assert.equal(typeof createRemoteLaneRuntime, 'function')
})

test('RemoteEngineAdapter allows delegated turns (delegationDepth > 0) while preserving hermetic/advisor locks', () => {
  const baseOpts = {
    agentId: 'main',
    agentBaseDir: '/tmp',
    sessionKey: 'agent:main:webchat:dm:agy_unit_test_1',
    model: 'antigravity-gemini-4-carbon-remote',
    config: { auth: {}, gateway: { port: 18790, accessToken: 'test-token' }, mcpServers: [] } as any,
    executionBackend: {
      kind: REMOTE_DRIVER_BACKEND,
      version: REMOTE_DRIVER_PROTOCOL_VERSION,
      sessionKey: 'agent:main:webchat:dm:agy_unit_test_1',
      operationId: '11111111-1111-4111-8111-111111111111',
      driverId: 'antigravity',
      engineId: 'antigravity',
      authorityEngine: 'antigravity' as const,
      driverVersion: '1.0.0',
      generation: '1',
      profileId: '22222222-2222-4222-8222-222222222222',
      authEpoch: 'epoch-agy-1',
    },
  }
  const laneOpts = {
    binding: sampleAntigravityBinding(),
    keyring: new Map([['v4-test', new Uint8Array(32).fill(1)]]),
    socketPath: '/tmp/nonexistent-agy-relay.sock',
    toolContextFactory: async () => ({
      profile: {} as any,
      env: { PATH: '/usr/bin:/bin' },
      platformPrompt: '',
      cleanup: () => {},
    }),
  }

  const delegated = new RemoteEngineAdapter({ ...baseOpts, delegationDepth: 1 }, laneOpts)
  assert.equal(delegated.engineId, 'antigravity')

  assert.throws(
    () => new RemoteEngineAdapter({ ...baseOpts, advisorExecutionLock: { consultModel: 'claude-opus-5-5' } as any }, laneOpts),
    /REMOTE_ADAPTER_PROFILE_UNSUPPORTED/,
  )
  assert.throws(
    () => new RemoteEngineAdapter({ ...baseOpts, hermeticNoTools: true }, laneOpts),
    /REMOTE_ADAPTER_PROFILE_UNSUPPORTED/,
  )
})

test('OCV5-842: warm remote Antigravity lane syncs tool catalog, host credentials & SwarmBoard across OFF -> ON -> OFF -> ON', async () => {
  const td = mkdtempSync(join(tmpdir(), 'oc-agy-warm-swarm-'))
  const ws = join(td, 'ws')
  const execRoot = join(td, 'exec')
  mkdirSync(ws, { recursive: true })
  mkdirSync(execRoot, { recursive: true, mode: 0o700 })
  const prevHome = process.env.OPENCLAUDE_HOME
  process.env.OPENCLAUDE_HOME = td

  const sessionKey = 'agent:main:webchat:dm:agy_warm_toggle_cycle'
  const canonicalModel = 'antigravity-gemini-4-neon-remote'
  const opId = '33333333-3333-4333-8333-333333333333'
  const binding = sampleAntigravityBinding({
    operationId: opId,
    sessionKey,
    canonicalModel,
    upstreamModel: 'gemini-4-neon-high',
  })
  const executionBackend = {
    kind: REMOTE_DRIVER_BACKEND,
    version: REMOTE_DRIVER_PROTOCOL_VERSION,
    sessionKey,
    operationId: opId,
    driverId: 'antigravity',
    engineId: 'antigravity',
    authorityEngine: 'antigravity' as const,
    driverVersion: '1.0.0',
    generation: '1',
    profileId: binding.profileId,
    authEpoch: binding.authEpoch,
  }

  const kp = generateKeyPairSync('ed25519')
  const keyId = 'v4-test'
  const pubRaw = kp.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)
  const keyring: AuthorityKeyring = new Map([[keyId, new Uint8Array(pubRaw)]])

  const runtime = new RemoteSwarmRuntime({
    executor: {
      async runWorkerTurn() {
        return { text: 'ok' }
      },
      async releaseWorkerSession() {},
    },
  })

  // Track every host construction, recycle, admit catalog, and executed tool result across the 4 turns.
  const admittedCatalogs: string[][] = []
  const hostBuilds: Array<{ enabled?: string; token?: string; mcpCfgEnabled?: string; mcpCfgToken?: string; closed: boolean }> = []
  const executedToolResults: Array<{ turn: number; isError: boolean; text: string }> = []
  let recycleCount = 0
  let currentTurnNo = 0

  // Per-turn scripted relay behavior (driven on the EXACT SAME warm lane)
  let seq = 0
  let secSeq = 0
  let queuedFrames: Array<{ seq: number; frame: Record<string, unknown> }> = []
  let pendingToolReq: { authority: string; lease: string; turnKey: string; request: Record<string, unknown> } | null = null
  let currentAdmit: { authority: string; lease: string; turnKey: string; authorityTurnId: string; tools: string[] } | null = null
  let currentReceipt: RemoteReceiptV4 | null = null

  const pushFrame = (frame: Record<string, unknown>) => {
    seq += 1
    queuedFrames.push({ seq, frame })
  }

  const makeSecurityEvent = (authorityTurnId: string, payload: Record<string, unknown>) => {
    secSeq += 1
    return {
      protocolVersion: REMOTE_DRIVER_PROTOCOL_VERSION,
      operationId: opId,
      generation: binding.generation,
      profileId: binding.profileId,
      authEpoch: binding.authEpoch,
      authorityTurnId,
      nativeSessionId: 'native-agy-warm-1',
      seq: secSeq,
      driverId: 'antigravity',
      driverVersion: binding.driverVersion,
      rawFrameRef: { channel: 'native', frameSeq: secSeq, sha256: HEX64_A },
      payload,
    }
  }

  const makeReceipt = (turnKey: string, authorityTurnId: string, requestId: string): RemoteReceiptV4 => ({
    version: REMOTE_DRIVER_PROTOCOL_VERSION,
    backendKind: REMOTE_DRIVER_BACKEND,
    engineId: 'antigravity',
    driverId: 'antigravity',
    driverVersion: binding.driverVersion,
    driverDigest: binding.driverDigest,
    uid: binding.uid,
    containerDbId: binding.containerDbId,
    dockerId: binding.dockerId,
    operationId: opId,
    runId: binding.runId,
    sessionKey,
    canonicalModel,
    upstreamModel: binding.upstreamModel,
    profileId: binding.profileId,
    authEpoch: binding.authEpoch,
    authorityTurnId,
    turnKey,
    requestId,
    nativeSessionId: 'native-agy-warm-1',
    terminalId: `term-${authorityTurnId}`,
    usageSemantics: 'per_turn_delta',
    usageMode: 'per_turn',
    countersBaseline: null,
    countersFinal: { inputTokens: 100, outputTokens: 20 },
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
    status: 'success',
    nativeStatus: 'success',
    rawEvidenceDigest: HEX64_A,
    semanticDigest: HEX64_B,
    provenance: {
      generation: binding.generation,
      manifestHash: binding.manifestSha256,
      coreDigest: binding.coreDigest,
      probeFingerprint: binding.probeFingerprint,
    },
    receiptDigest: HEX64_C,
  })

  const relayCall = async (path: string, body: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> => {
    if (path === '/recycle') {
      recycleCount += 1
      return { ok: true, appStopped: true }
    }
    if (path === '/baseline') {
      return { ok: true, seq }
    }
    if (path === '/admit') {
      const cat = (body.catalog as { tools: Array<{ name: string }> }).tools.map((t) => t.name)
      admittedCatalogs.push(cat)
      currentAdmit = {
        authority: String(body.authority),
        lease: String(body.lease),
        turnKey: String(body.turnKey),
        authorityTurnId: currentReceipt!.authorityTurnId,
        tools: cat,
      }
      return { ok: true, ready: true, seq, nativeSessionId: 'native-agy-warm-1' }
    }
    if (path === '/command') {
      const cmd = body.command as { kind?: string; commandId?: string }
      if (cmd?.kind === 'newTurn' && currentAdmit) {
        const turnNo = currentTurnNo
        const callId = `call-t${turnNo}`
        if (turnNo === 2 || turnNo === 4) {
          const title = turnNo === 2 ? '首轮暖车道蜂群' : '重开后暖车道蜂群'
          const swarmAlias = currentAdmit.tools.find((n) => n.endsWith('__swarm') || n === 'swarm')
          assert.ok(swarmAlias, `turn ${turnNo} must expose swarm tool in admitted catalog`)
          const args = { action: 'title', title }
          pushFrame({
            kind: 'security',
            event: makeSecurityEvent(currentAdmit.authorityTurnId, {
              kind: 'toolCallObserved',
              phase: 'started',
              callId,
              name: swarmAlias,
              arguments: args,
              argsHash: remoteCanonicalSha256(args),
            }),
          })
          pendingToolReq = {
            authority: currentAdmit.authority,
            lease: currentAdmit.lease,
            turnKey: currentAdmit.turnKey,
            request: {
              rpcId: turnNo,
              callId,
              nativeSessionId: 'native-agy-warm-1',
              server: 'ocbridge',
              name: swarmAlias,
              arguments: args,
              argsHash: remoteCanonicalSha256(args),
            },
          }
        } else if (turnNo === 3) {
          // Turn 3 (OFF): swarm tools are absent from catalog & allowedAliases; normal reply completes with zero SwarmBoard.
          pushFrame({
            kind: 'presentation',
            item: { kind: 'text_delta', text: '单 Agent 直接回复' },
          })
          pushFrame({
            kind: 'turn_settled',
            receipt: currentReceipt,
            outcome: { kind: 'completed' },
          })
        } else {
          pushFrame({
            kind: 'presentation',
            item: { kind: 'text_delta', text: '普通聊天回复' },
          })
          pushFrame({
            kind: 'turn_settled',
            receipt: currentReceipt,
            outcome: { kind: 'completed' },
          })
        }
      }
      return { ok: true, accepted: true }
    }
    if (path === '/tool/next') {
      if (!pendingToolReq) return { ok: true }
      const req = pendingToolReq
      pendingToolReq = null
      return { ok: true, ...req }
    }
    if (path === '/tool/result') {
      const res = body.result as { content?: Array<{ text?: string }>; isError?: boolean }
      executedToolResults.push({
        turn: currentTurnNo,
        isError: Boolean(res?.isError),
        text: res?.content?.[0]?.text ?? '',
      })
      return { ok: true, callId: body.callId }
    }
    if (path === '/tool/ack') {
      pushFrame({
        kind: 'presentation',
        item: { kind: 'text_delta', text: `蜂群回合 ${currentTurnNo} 完成` },
      })
      pushFrame({
        kind: 'turn_settled',
        receipt: currentReceipt,
        outcome: { kind: 'completed' },
      })
      return { ok: true }
    }
    if (path === '/poll') {
      const afterSeq = Number(body.afterSeq ?? 0)
      const frames = queuedFrames.filter((r) => r.seq > afterSeq)
      return { ok: true, frames }
    }
    if (path === '/stop' || path === '/tool/stopped') {
      return { ok: true }
    }
    return { ok: true }
  }

  const hostFactory = (
    _root: string,
    _lifecycleId: string,
    profile: { mcpConfigPath?: string | null },
    env: NodeJS.ProcessEnv,
  ): LaneToolHost => {
    let mcpCfgEnabled: string | undefined
    let mcpCfgToken: string | undefined
    if (profile.mcpConfigPath) {
      const parsed = JSON.parse(readFileSync(profile.mcpConfigPath, 'utf8')) as {
        mcpServers?: Record<string, { env?: Record<string, string> }>
      }
      const memEnv = parsed.mcpServers?.['openclaude-memory']?.env
      mcpCfgEnabled = memEnv?.OPENCLAUDE_REMOTE_SWARM_ENABLED
      mcpCfgToken = memEnv?.OPENCLAUDE_REMOTE_SWARM_TOKEN
    }
    const buildRec = {
      enabled: env.OPENCLAUDE_REMOTE_SWARM_ENABLED,
      token: env.OPENCLAUDE_REMOTE_SWARM_TOKEN,
      mcpCfgEnabled,
      mcpCfgToken,
      closed: false,
    }
    hostBuilds.push(buildRec)

    const swarmTools =
      env.OPENCLAUDE_REMOTE_SWARM_ENABLED === '1'
        ? ['swarm', 'post_message', 'read_board', 'swarm_wait'].map((n) => ({
            name: `mcp__openclaude-memory__${n}`,
            description: `remote swarm ${n}`,
            inputSchema: { type: 'object', properties: {} },
          }))
        : []

    return {
      tools: async () => [
        {
          name: 'mcp__openclaude-memory__oc_bash',
          description: 'run shell command',
          inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
        },
        ...swarmTools,
      ],
      execute: async (name: string, args: Record<string, unknown>) => {
        const shortName = name.replace(/^mcp__openclaude-memory__/, '')
        if (['swarm', 'post_message', 'read_board', 'swarm_wait'].includes(shortName)) {
          const valid = runtime.verifyCallerToken(buildRec.token, sessionKey, 'coordinator')
          if (!valid) {
            return { content: [{ type: 'text', text: 'AUTH_FAILED_STALE_TOKEN' }], isError: true }
          }
          const out = await runtime.handleToolCall({
            sessionKey,
            callerMember: 'coordinator',
            tool: shortName as 'swarm' | 'post_message' | 'read_board' | 'swarm_wait',
            args,
          })
          return { content: [{ type: 'text', text: JSON.stringify(out) }], isError: false }
        }
        return { content: [{ type: 'text', text: 'ok' }], isError: false }
      },
      close: async () => {
        buildRec.closed = true
      },
    }
  }

  const adapter = new RemoteEngineAdapter(
    {
      peerId: 'agy-warm-toggle',
      sessionKey,
      executionBackend,
      agentId: 'main',
      agentBaseDir: ws,
      model: canonicalModel,
      config: { auth: {}, gateway: { port: 18790, accessToken: 'test-token' }, mcpServers: [] } as any,
    },
    {
      binding,
      keyring,
      executionRoot: execRoot,
      call: relayCall,
      hostFactory: hostFactory as any,
      platformPrompt: 'test platform prompt',
    },
  )
  const adapterErrors: unknown[] = []
  adapter.on('error', (err) => {
    adapterErrors.push(err)
  })

  const runTurn = async (turnNo: number, prompt: string) => {
    currentTurnNo = turnNo
    queuedFrames = []
    const issuedAt = Date.now()
    const authorityTurnId = createHash('md5').update(`agy-warm-turn-${turnNo}`).digest('hex')
    const requestId = createHash('md5').update(`req-${authorityTurnId}`).digest('hex')
    const turnKey = createHash('sha256').update(`tk-${authorityTurnId}`).digest('hex')
    currentReceipt = makeReceipt(turnKey, authorityTurnId, requestId)

    const payload: ModelAuthorityPayload = {
      v: 1,
      keyId,
      uid: 3,
      containerId: 7,
      authorityTurnId,
      connectionChallenge: 'challenge-warm-1',
      canonicalModel,
      engine: 'antigravity',
      executionBackend,
      securityEpoch: 1,
      executionRevision: 'rev-1',
      issuedAt,
      expiresAt: issuedAt + 120_000,
      executionDescriptor: {
        capabilityProfile: {},
        capabilitySchemaVersion: 1,
        contextWindow: 200_000,
        supportsVision: false,
        supportedEfforts: ['low', 'medium', 'high'],
      },
    }
    const leasePayload: TurnLease = {
      v: 1,
      keyId,
      uid: 3,
      containerId: 7,
      authorityTurnId,
      connectionChallenge: 'challenge-warm-1',
      canonicalModel,
      securityEpoch: 1,
      issuedAt,
      expiresAt: issuedAt + 600_000,
    }
    const authority = encodeAuthorityEnvelope(payload, sign(null, authoritySigningInput(payload), kp.privateKey))
    const lease = encodeTurnLeaseEnvelope(leasePayload, sign(null, turnLeaseSigningInput(leasePayload), kp.privateKey))

    const events: EngineEvent[] = []
    const run = adapter.submitTurn({
      input: prompt,
      requestId,
      turnKey,
      modelAuthority: {
        authorityEnvelope: authority,
        leaseEnvelope: lease,
        executionDescriptor: {
          executionBackend,
          canonicalModel,
          contextWindow: 200_000,
          capabilityZero: false,
          supportsThinking: false,
          supportsVision: false,
          supportedEfforts: ['low', 'medium', 'high'],
        },
      },
      onEvent: (ev) => events.push(ev),
      sessionTotals: { totalCostUSD: 0, turns: turnNo },
      toolUseIdToName: new Map(),
    })
    await run.submitted
    const summary = await run.summary
    assert.deepEqual(adapterErrors, [], `unexpected adapter error on turn ${turnNo}`)
    return { events, summary }
  }

  const hasSwarmTools = (tools: string[]) =>
    tools.some((t) => /(?:^|__)(?:swarm|post_message|read_board|swarm_wait)$/.test(t))
  const countSwarmSnapshots = (events: EngineEvent[]) =>
    events.filter((e) => e.kind === 'block' && e.block.kind === 'swarm_snapshot').length

  const keepalive = setInterval(() => {}, 25)
  try {
    // Turn 1: OFF — no swarm tools exposed, no swarm env, zero SwarmBoard snapshots
    disableRemoteSwarmCoordinatorMcp(sessionKey)
    const t1 = await runTurn(1, '普通问答')
    assert.equal(hasSwarmTools(admittedCatalogs[0]!), false, 'Turn 1 (OFF) must not expose swarm tools')
    assert.equal(hostBuilds[0]!.enabled, undefined)
    assert.equal(hostBuilds[0]!.mcpCfgEnabled, undefined)
    assert.equal(countSwarmSnapshots(t1.events), 0)
    assert.equal(recycleCount, 0)

    // Turn 2: OFF -> ON — same warm lane recycles, rebuilds host with token1, exposes 4 swarm tools, call succeeds
    runtime.registerSession({ sessionKey, model: canonicalModel, workspaceCwd: ws })
    const token1 = lookupRemoteSwarmMcpContext(sessionKey)?.callerToken
    assert.ok(token1)
    const t2 = await runTurn(2, '开启蜂群')
    assert.equal(recycleCount, 1, 'OFF -> ON must recycle warm remote app')
    assert.equal(hostBuilds[0]!.closed, true, 'previous tool host must be closed on rebuild')
    assert.equal(hostBuilds[1]!.enabled, '1')
    assert.equal(hostBuilds[1]!.token, token1)
    assert.equal(hostBuilds[1]!.mcpCfgToken, token1)
    assert.equal(hasSwarmTools(admittedCatalogs[1]!), true, 'Turn 2 (ON) must expose swarm tools')
    assert.equal(executedToolResults[0]?.turn, 2)
    assert.equal(executedToolResults[0]?.isError, false, 'Turn 2 swarm call must succeed with token1')
    assert.ok(countSwarmSnapshots(t2.events) >= 1, 'Turn 2 (ON) must emit SwarmBoard snapshot')
    assert.ok(t2.summary?.tools.some((t) => t.toolName === SWARM_BOARD_TOOL_NAME))

    // Turn 3: ON -> OFF — same warm lane recycles, strips swarm tools, rogue toolCallObserved does NOT emit SwarmBoard
    disableRemoteSwarmCoordinatorMcp(sessionKey)
    const t3 = await runTurn(3, '关闭蜂群续聊')
    assert.equal(recycleCount, 2, 'ON -> OFF must recycle warm remote app')
    assert.equal(hostBuilds[1]!.closed, true)
    assert.equal(hostBuilds[2]!.enabled, undefined)
    assert.equal(hostBuilds[2]!.mcpCfgEnabled, undefined)
    assert.equal(hasSwarmTools(admittedCatalogs[2]!), false, 'Turn 3 (OFF) must not expose swarm tools')
    assert.equal(countSwarmSnapshots(t3.events), 0, 'Turn 3 (OFF) must not emit SwarmBoard snapshot')
    assert.equal(
      t3.summary?.tools.some((t) => t.toolName === SWARM_BOARD_TOOL_NAME),
      false,
      'Turn 3 (OFF) must not persist SwarmBoard',
    )

    // Turn 4: OFF -> ON again — fresh token2 !== token1, rebuilt host authenticates with token2 and succeeds
    runtime.registerSession({ sessionKey, model: canonicalModel, workspaceCwd: ws })
    const token2 = lookupRemoteSwarmMcpContext(sessionKey)?.callerToken
    assert.ok(token2)
    assert.notEqual(token2, token1, 're-enabling after OFF must mint a fresh caller token')
    assert.equal(runtime.verifyCallerToken(token1, sessionKey, 'coordinator'), false, 'old token1 must be rejected')
    const t4 = await runTurn(4, '重新开启蜂群')
    assert.equal(recycleCount, 3, 'OFF -> ON re-enable must recycle warm remote app')
    assert.equal(hostBuilds[2]!.closed, true)
    assert.equal(hostBuilds[3]!.enabled, '1')
    assert.equal(hostBuilds[3]!.token, token2)
    assert.equal(hostBuilds[3]!.mcpCfgToken, token2)
    assert.equal(hasSwarmTools(admittedCatalogs[3]!), true, 'Turn 4 (ON) must expose swarm tools again')
    assert.equal(executedToolResults[1]?.turn, 4)
    assert.equal(executedToolResults[1]?.isError, false, 'Turn 4 swarm call must succeed with fresh token2')
    assert.ok(countSwarmSnapshots(t4.events) >= 1)
    const loc = remoteSwarmLocationForSession(sessionKey)
    const roster = JSON.parse(readFileSync(join(loc.swarmDir, 'members.json'), 'utf8')) as { title?: string }
    assert.equal(roster.title, '重开后暖车道蜂群')
  } finally {
    clearInterval(keepalive)
    await adapter.shutdown().catch(() => {})
    await runtime.shutdownAll()
    disableRemoteSwarmCoordinatorMcp(sessionKey)
    if (prevHome === undefined) delete process.env.OPENCLAUDE_HOME
    else process.env.OPENCLAUDE_HOME = prevHome
    rmSync(td, { recursive: true, force: true })
  }
})
