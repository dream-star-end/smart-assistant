import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  REMOTE_DRIVER_BACKEND,
  REMOTE_DRIVER_PROTOCOL_VERSION,
  authoritySigningInput,
  computeSchemaFilteredArgsSha256,
  encodeAuthorityEnvelope,
  encodeTurnLeaseEnvelope,
  remoteCanonicalSha256,
  turnLeaseSigningInput,
  validateToolCallEnvelope,
  verifyAuthority,
  type AuthorityKeyring,
  type ModelAuthorityPayload,
  type RemoteDriverCommand,
  type RemoteReceiptV4,
  type RemoteSecurityEvent,
  type TurnLease,
} from '@openclaude/protocol'
import type { ToolBrokerTransport, ToolCallEnvelope } from '@openclaude/protocol/exec-env'
import {
  assertFreshCc5Session,
  cc5SessionBackend,
  type CrossPoolMigrationGrant,
} from '../../cc5SessionBackend.js'
import { cc5ResumeId } from '../../engine/cc5ResumeId.js'
import type { EngineEvent } from '../../engine/engineEvents.js'
import { _setPlatformPricingLookupForTests } from '../../usageCost.js'
import { RemoteContainerLane, type LaneToolHost } from '../containerLane.js'
import { RemoteObservationGate } from '../observationGate.js'
import { RemotePoolRelay } from '../relay.js'
import { RemoteEngineAdapter } from '../remoteEngineAdapter.js'
import {
  REMOTE_V4_RESUME_PREFIX,
  extractPortableNativeSessionId,
  isRemoteV4ResumeId,
  parseRemoteV4ResumeId,
  rebindRemoteV4ResumeId,
  remoteV4ResumeId,
} from '../resumeId.js'
import {
  remotePoolBackendOf,
  type RemotePoolBinding,
  type RemotePoolFinancePort,
  type RemotePoolHostPort,
  type RemotePoolLaneSpec,
  type RemoteRelayedFrame,
} from '../types.js'

const HEX64_A = 'a'.repeat(64)
const HEX64_B = 'b'.repeat(64)
const HEX64_C = 'c'.repeat(64)

const tempDirs: string[] = []
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

after(() => {
  _setPlatformPricingLookupForTests(null)
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeKeyFixture() {
  const kp = generateKeyPairSync('ed25519')
  const keyId = 'v5-parity-key'
  const keyring: AuthorityKeyring = new Map([
    [keyId, new Uint8Array(Buffer.from(kp.publicKey.export({ format: 'jwk' }).x!, 'base64url'))],
  ])
  const signTurn = (input: {
    binding: RemotePoolBinding
    supportsVision?: boolean
    supportedEfforts?: readonly ('low' | 'medium' | 'high')[]
    authorityTurnId?: string
  }) => {
    const now = Date.now()
    const authorityTurnId = input.authorityTurnId ?? `at-${randomUUID()}`
    const payload: ModelAuthorityPayload = {
      v: 1,
      keyId,
      uid: Number(input.binding.uid),
      containerId: Number(input.binding.containerDbId),
      authorityTurnId,
      connectionChallenge: 'challenge-v5-parity',
      canonicalModel: input.binding.canonicalModel,
      engine: input.binding.authorityEngine,
      executionDescriptor: {
        capabilityProfile: {},
        capabilitySchemaVersion: 1,
        contextWindow: 200_000,
        supportedEfforts: [...(input.supportedEfforts ?? ['low', 'medium', 'high'])],
        supportsVision: input.supportsVision ?? false,
      },
      executionBackend: remotePoolBackendOf(input.binding),
      executionRevision: 'rev-v5-1',
      securityEpoch: 1,
      issuedAt: now - 1_000,
      expiresAt: now + 60_000,
    }
    const lease: TurnLease = {
      v: 1,
      keyId,
      uid: payload.uid,
      containerId: payload.containerId,
      authorityTurnId,
      canonicalModel: payload.canonicalModel,
      securityEpoch: payload.securityEpoch,
      connectionChallenge: payload.connectionChallenge,
      issuedAt: now - 1_000,
      expiresAt: now + 600_000,
    }
    const authority = encodeAuthorityEnvelope(
      payload,
      sign(null, authoritySigningInput(payload), kp.privateKey),
    )
    const leaseEnv = encodeTurnLeaseEnvelope(
      lease,
      sign(null, turnLeaseSigningInput(lease), kp.privateKey),
    )
    verifyAuthority(authority, keyring, now)
    return { authority, lease: leaseEnv, payload, turnKey: randomUUID().replace(/-/g, '').repeat(2) }
  }
  return { keyring, signTurn }
}

function makeBinding(overrides: Partial<RemotePoolBinding> = {}): RemotePoolBinding {
  return {
    version: REMOTE_DRIVER_PROTOCOL_VERSION,
    backendKind: REMOTE_DRIVER_BACKEND,
    operationId: randomUUID(),
    runId: `run-${randomUUID()}`,
    uid: '3',
    containerDbId: '7',
    dockerId: 'd'.repeat(64),
    sessionKey: `agent:main:webchat:dm:v5_${randomUUID().slice(0, 8)}`,
    canonicalModel: 'claude-sonnet-4-6-remote',
    upstreamModel: 'claude-sonnet-4-6',
    driverId: 'cc',
    engineId: 'cc',
    authorityEngine: 'ccb',
    driverVersion: '4.0.0',
    driverDigest: HEX64_A,
    coreDigest: HEX64_B,
    probeFingerprint: HEX64_C,
    manifestSha256: HEX64_A,
    generation: '1',
    profileId: `p-${randomUUID().toLowerCase()}`,
    authEpoch: 'epoch-1',
    capability: HEX64_B,
    expiresAt: Date.now() + 600_000,
    ...overrides,
  }
}

function makeToolObservedEvent(
  binding: RemotePoolBinding,
  input: {
    seq: number
    authorityTurnId: string
    nativeSessionId: string
    callId: string
    name: string
    arguments: Record<string, unknown>
    phase?: 'started' | 'completed'
    argsHash?: string
  },
): RemoteSecurityEvent {
  return {
    protocolVersion: REMOTE_DRIVER_PROTOCOL_VERSION,
    operationId: binding.operationId,
    generation: binding.generation,
    profileId: binding.profileId,
    authEpoch: binding.authEpoch,
    authorityTurnId: input.authorityTurnId,
    nativeSessionId: input.nativeSessionId,
    seq: input.seq,
    rawFrameRef: { channel: 'native', frameSeq: input.seq, sha256: HEX64_A },
    driverId: binding.driverId,
    driverVersion: binding.driverVersion,
    payload: {
      kind: 'toolCallObserved',
      callId: input.callId,
      name: input.name,
      arguments: input.arguments,
      argsHash: input.argsHash ?? remoteCanonicalSha256(input.arguments),
      phase: input.phase ?? 'started',
    },
  }
}

function makeReceipt(
  binding: RemotePoolBinding,
  input: {
    authorityTurnId: string
    turnKey: string
    nativeSessionId: string
    nativeStatus?: 'success' | 'error' | 'interrupted'
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    usageMode?: 'per_turn' | 'cumulative'
    usageSemantics?: string
    countersBaseline?: Readonly<Record<string, number>> | null
    countersFinal?: Readonly<Record<string, number>>
  },
): RemoteReceiptV4 {
  const nativeStatus = input.nativeStatus ?? 'success'
  return {
    version: 4,
    backendKind: 'remote-driver-v4',
    engineId: binding.engineId,
    driverId: binding.driverId,
    driverVersion: binding.driverVersion,
    driverDigest: binding.driverDigest,
    uid: binding.uid,
    containerDbId: binding.containerDbId,
    dockerId: binding.dockerId,
    operationId: binding.operationId,
    runId: binding.runId,
    sessionKey: binding.sessionKey,
    canonicalModel: binding.canonicalModel,
    upstreamModel: binding.upstreamModel,
    profileId: binding.profileId,
    authEpoch: binding.authEpoch,
    authorityTurnId: input.authorityTurnId,
    turnKey: input.turnKey,
    requestId: `req-${randomUUID()}`,
    nativeSessionId: input.nativeSessionId,
    terminalId: `term-${randomUUID()}`,
    status: nativeStatus === 'success' ? 'success' : 'error',
    nativeStatus,
    usage: {
      inputTokens: input.inputTokens ?? 100,
      outputTokens: input.outputTokens ?? 25,
      cacheReadTokens: input.cacheReadTokens ?? 0,
      cacheWriteTokens: input.cacheWriteTokens ?? 0,
    },
    usageSemantics: input.usageSemantics ?? 'cc_per_turn_v1',
    usageMode: input.usageMode ?? 'per_turn',
    countersBaseline: input.countersBaseline ?? null,
    countersFinal: input.countersFinal ?? {
      input_tokens: input.inputTokens ?? 100,
      output_tokens: input.outputTokens ?? 25,
    },
    rawEvidenceDigest: HEX64_A,
    semanticDigest: HEX64_B,
    provenance: {
      generation: binding.generation,
      manifestHash: binding.manifestSha256,
      coreDigest: binding.coreDigest,
      probeFingerprint: binding.probeFingerprint,
    },
    receiptDigest: HEX64_C,
  }
}

// ---------------------------------------------------------------------------
// 1. cc5SessionBackend + assertFreshCc5Session CrossPoolMigrationGrant
// ---------------------------------------------------------------------------

test('cc5SessionBackend preserves fail-closed without grant and allows controlled remote->local transition with valid CrossPoolMigrationGrant', () => {
  const opId = randomUUID()
  const sessionKey = 'agent:main:webchat:dm:mig_test_1'
  const remoteV4Id = remoteV4ResumeId(opId, 'native_sess_01')
  const legacyCc5Id = cc5ResumeId(opId, randomUUID())

  // Default (no poolMigration) remains 100% fail-closed for both remotev4: and cc5:
  assert.throws(
    () =>
      cc5SessionBackend({
        engineId: 'ccb',
        executionModel: 'claude-sonnet-4-6-remote',
        sessionKey,
        storedResumeId: remoteV4Id,
      }),
    /CC5_BACKEND_SCOPE_CHANGED_NEW_CHAT_REQUIRED/,
  )
  assert.throws(
    () =>
      cc5SessionBackend({
        engineId: 'ccb',
        executionModel: 'claude-sonnet-4-6-remote',
        sessionKey,
        storedResumeId: legacyCc5Id,
      }),
    /CC5_BACKEND_SCOPE_CHANGED_NEW_CHAT_REQUIRED/,
  )

  // Invalid grants still fail closed
  const badGrants = [
    { migrationId: 'short', placementEpoch: 1, allowBackendTransition: true },
    { migrationId: '        ', placementEpoch: 1, allowBackendTransition: true },
    { migrationId: 'mig-valid-1234', placementEpoch: 0, allowBackendTransition: true },
    { migrationId: 'mig-valid-1234', placementEpoch: 1.5, allowBackendTransition: true },
    { migrationId: 'mig-valid-1234', placementEpoch: 1, allowBackendTransition: false },
    {
      migrationId: 'mig-valid-1234',
      placementEpoch: 1,
      allowBackendTransition: true,
      continuityTier: 'bogus',
    },
  ]
  for (const bad of badGrants) {
    assert.throws(
      () =>
        cc5SessionBackend({
          engineId: 'ccb',
          executionModel: 'claude-sonnet-4-6-remote',
          sessionKey,
          storedResumeId: remoteV4Id,
          poolMigration: bad as unknown as CrossPoolMigrationGrant,
        }),
      /CC5_BACKEND_SCOPE_CHANGED_NEW_CHAT_REQUIRED/,
    )
  }

  // Valid grant unlocks controlled transition back to local (returns undefined)
  const validGrant: CrossPoolMigrationGrant = {
    migrationId: 'mig-20261125-001',
    placementEpoch: 2,
    allowBackendTransition: true,
    continuityTier: 'warm_capsule',
  }
  assert.equal(
    cc5SessionBackend({
      engineId: 'ccb',
      executionModel: 'claude-sonnet-4-6-remote',
      sessionKey,
      storedResumeId: remoteV4Id,
      poolMigration: validGrant,
    }),
    undefined,
  )
})

test('assertFreshCc5Session preserves fail-closed without grant and unlocks history->remote transition with valid CrossPoolMigrationGrant', async () => {
  const binding = makeBinding()
  const backend = remotePoolBackendOf(binding)

  // Default (no grant) still rejects existing turn / stored resume / persisted history
  await assert.rejects(
    assertFreshCc5Session({
      current: { turns: 3, runner: { nativeSessionId: 'local-sess-1' } },
      storedResumeId: 'local-sess-1',
      executionBackend: backend,
      sessionIds: ['s1'],
      hasPersistedTurnActivity: async () => true,
    }),
    /CC5_BACKEND_REQUIRES_NEW_SESSION/,
  )

  // Invalid grant still rejects
  await assert.rejects(
    assertFreshCc5Session({
      current: { turns: 1, runner: { nativeSessionId: 'local-sess-1' } },
      executionBackend: backend,
      sessionIds: ['s1'],
      hasPersistedTurnActivity: async () => true,
      poolMigration: {
        migrationId: 'tiny',
        placementEpoch: 1,
        allowBackendTransition: true,
      },
    }),
    /CC5_BACKEND_REQUIRES_NEW_SESSION/,
  )

  // Valid grant allows history-bearing session to migrate into remote pool
  await assert.doesNotReject(
    assertFreshCc5Session({
      current: { turns: 5, runner: { nativeSessionId: 'local-sess-1' } },
      storedResumeId: 'local-sess-1',
      executionBackend: backend,
      sessionIds: ['s1'],
      hasPersistedTurnActivity: async () => true,
      poolMigration: {
        migrationId: 'mig-local-to-remote-001',
        placementEpoch: 3,
        allowBackendTransition: true,
        continuityTier: 'hot_native',
      },
    }),
  )
})

// ---------------------------------------------------------------------------
// 2. resumeId.ts portable extraction & cross-node rebind
// ---------------------------------------------------------------------------

test('resumeId preserves v4 contract and supports extractPortableNativeSessionId + rebindRemoteV4ResumeId', () => {
  const oldOp = randomUUID().toUpperCase()
  const nextOp = randomUUID().toUpperCase()
  const wrapped = remoteV4ResumeId(oldOp, 'thr_codex_99')

  assert.equal(REMOTE_V4_RESUME_PREFIX, 'remotev4:')
  assert.equal(isRemoteV4ResumeId(wrapped), true)
  assert.deepEqual(parseRemoteV4ResumeId(wrapped), {
    bindingId: oldOp.toLowerCase(),
    nativeId: 'thr_codex_99',
  })

  // extractPortableNativeSessionId
  assert.equal(extractPortableNativeSessionId(wrapped), 'thr_codex_99')
  assert.equal(extractPortableNativeSessionId('thr_codex_99'), 'thr_codex_99')
  assert.equal(extractPortableNativeSessionId('remotev4:not-a-uuid:thr_codex_99'), null)
  assert.equal(extractPortableNativeSessionId('../escape'), null)
  assert.equal(extractPortableNativeSessionId('has spaces'), null)
  assert.equal(extractPortableNativeSessionId(''), null)
  assert.equal(extractPortableNativeSessionId(null), null)
  assert.equal(extractPortableNativeSessionId(undefined), null)

  // rebindRemoteV4ResumeId
  const rebound = rebindRemoteV4ResumeId(wrapped, nextOp)
  assert.equal(rebound, `${REMOTE_V4_RESUME_PREFIX}${nextOp.toLowerCase()}:thr_codex_99`)
  assert.equal(
    rebindRemoteV4ResumeId('bare_session_42', nextOp),
    `${REMOTE_V4_RESUME_PREFIX}${nextOp.toLowerCase()}:bare_session_42`,
  )
  assert.equal(rebindRemoteV4ResumeId(wrapped, 'not-a-uuid'), null)
  assert.equal(rebindRemoteV4ResumeId('remotev4:bad:id', nextOp), null)
  assert.equal(rebindRemoteV4ResumeId('../bad', nextOp), null)
})

// ---------------------------------------------------------------------------
// 3. observationGate.ts R11 / OCV5-800 schema-filtered alignment
// ---------------------------------------------------------------------------

test('RemoteObservationGate aligns schema-filtered args (strips CLI toolSummary) and fails closed on 1-byte tamper', async () => {
  const binding = makeBinding()
  const runCommandSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      CommandLine: { type: 'string' },
      WaitMsBeforeAsync: { type: 'integer' },
    },
    required: ['CommandLine'],
  }
  const observedArgs = {
    CommandLine: 'git status --short',
    WaitMsBeforeAsync: 5000,
    toolSummary: 'Check git status',
    _cliPrivateUi: 'badge',
  }
  const mcpArgs = {
    CommandLine: 'git status --short',
    WaitMsBeforeAsync: 5000,
  }
  const nativeSessionId = 'sess_obs_1'
  const authorityTurnId = 'at_obs_1'

  // 3a. With toolInputSchemas: zero false positive when CLI strips private UI fields
  const fencesOk: string[] = []
  const gateWithSchema = new RemoteObservationGate(
    {
      operationId: binding.operationId,
      generation: binding.generation,
      profileId: binding.profileId,
      authEpoch: binding.authEpoch,
    },
    new Set(['run_command']),
    (reason) => fencesOk.push(reason),
    { toolInputSchemas: new Map([['run_command', runCommandSchema]]) },
  )
  gateWithSchema.beginTurn()
  gateWithSchema.ingestSecurityEvent(
    makeToolObservedEvent(binding, {
      seq: 1,
      authorityTurnId,
      nativeSessionId,
      callId: 'call_r11_ok',
      name: 'run_command',
      arguments: observedArgs,
    }),
  )
  const authorized = await gateWithSchema.authorize({
    rpcId: 1,
    callId: 'call_r11_ok',
    nativeSessionId,
    server: 'ocbridge',
    name: 'run_command',
    arguments: mcpArgs,
    argsHash: remoteCanonicalSha256(mcpArgs),
  })
  assert.equal(authorized.argsHash, computeSchemaFilteredArgsSha256(mcpArgs, runCommandSchema))
  assert.deepEqual(fencesOk, [])

  // 3b. With toolInputSchemas: 1-byte tamper of schema-declared field fails closed immediately
  const fencesTamper: string[] = []
  const gateTamper = new RemoteObservationGate(
    {
      operationId: binding.operationId,
      generation: binding.generation,
      profileId: binding.profileId,
      authEpoch: binding.authEpoch,
    },
    new Set(['run_command']),
    (reason) => fencesTamper.push(reason),
    { toolInputSchemas: new Map([['run_command', runCommandSchema]]) },
  )
  gateTamper.beginTurn()
  gateTamper.ingestSecurityEvent(
    makeToolObservedEvent(binding, {
      seq: 1,
      authorityTurnId,
      nativeSessionId,
      callId: 'call_r11_tamper',
      name: 'run_command',
      arguments: observedArgs,
    }),
  )
  const tamperedArgs = {
    CommandLine: 'git status --shorT',
    WaitMsBeforeAsync: 5000,
  }
  await assert.rejects(
    gateTamper.authorize({
      rpcId: 2,
      callId: 'call_r11_tamper',
      nativeSessionId,
      server: 'ocbridge',
      name: 'run_command',
      arguments: tamperedArgs,
      argsHash: remoteCanonicalSha256(tamperedArgs),
    }),
    /REMOTE_TOOL_SCOPE_MISMATCH/,
  )
  assert.equal(gateTamper.isFenced, true)
  assert.equal(fencesTamper[0], 'REMOTE_TOOL_SCOPE_MISMATCH')

  // 3c. Without toolInputSchemas: 100% original strict full-object hash behavior preserved
  const fencesLegacy: string[] = []
  const gateLegacy = new RemoteObservationGate(
    {
      operationId: binding.operationId,
      generation: binding.generation,
      profileId: binding.profileId,
      authEpoch: binding.authEpoch,
    },
    new Set(['run_command']),
    (reason) => fencesLegacy.push(reason),
  )
  gateLegacy.beginTurn()
  gateLegacy.ingestSecurityEvent(
    makeToolObservedEvent(binding, {
      seq: 1,
      authorityTurnId,
      nativeSessionId,
      callId: 'call_r11_legacy',
      name: 'run_command',
      arguments: observedArgs,
    }),
  )
  await assert.rejects(
    gateLegacy.authorize({
      rpcId: 3,
      callId: 'call_r11_legacy',
      nativeSessionId,
      server: 'ocbridge',
      name: 'run_command',
      arguments: mcpArgs,
      argsHash: remoteCanonicalSha256(mcpArgs),
    }),
    /REMOTE_TOOL_SCOPE_MISMATCH/,
  )
  assert.equal(gateLegacy.isFenced, true)
})

// ---------------------------------------------------------------------------
// 4. containerLane.ts brokerTransport + serviceTier + multimodal + Gate #2 R11
// ---------------------------------------------------------------------------

test('RemoteContainerLane wires brokerTransport, serviceTier, vision-gated content, and catalog toolInputSchemas to Gate #2', async (t) => {
  const keepalive = setInterval(() => {}, 1_000)
  t.after(() => clearInterval(keepalive))
  const binding = makeBinding()
  const { keyring, signTurn } = makeKeyFixture()
  const execRoot = makeTempDir('oc-lane-v5-')
  const nativeSessionId = `sess_${randomUUID().slice(0, 8)}`
  const schema = {
    type: 'object',
    properties: {
      CommandLine: { type: 'string' },
    },
    required: ['CommandLine'],
  }

  let hostExecuteCalls = 0
  const host: LaneToolHost = {
    async tools() {
      return [
        {
          name: 'RunCommand',
          description: 'Execute a shell command',
          inputSchema: schema,
        },
      ]
    },
    async execute() {
      hostExecuteCalls += 1
      return { content: [{ type: 'text', text: 'host-should-not-run' }], isError: false }
    },
    async close() {},
  }

  const brokerCalls: ToolCallEnvelope[] = []
  const brokerTransport: ToolBrokerTransport = {
    channelKind: 'ws_tunnel',
    async invoke(call) {
      validateToolCallEnvelope(call, { inputSchema: schema })
      brokerCalls.push(call)
      return {
        schemaVersion: 1,
        leaseId: call.leaseId,
        turnId: call.turnId,
        callId: call.callId,
        idempotencyKey: call.idempotencyKey,
        status: 'ok',
        output: `broker-ok:${String(call.arguments.CommandLine)}`,
        durationMs: 4,
      }
    },
    async cancel() {},
  }

  const commandsSent: Array<Record<string, unknown>> = []
  const frames: Array<{ seq: number; frame: RemoteRelayedFrame }> = []
  let nextSeq = 0
  let pendingTool: {
    authority: string
    lease: string
    turnKey: string
    request: {
      rpcId: number
      callId: string
      nativeSessionId: string
      server: 'ocbridge'
      name: string
      arguments: Record<string, unknown>
      argsHash: string
    }
  } | null = null
  const toolResultsSent: Array<{ callId: string; result: unknown }> = []

  const lane = new RemoteContainerLane(
    {
      agentId: 'main',
      agentBaseDir: execRoot,
      sessionKey: binding.sessionKey,
      model: binding.canonicalModel,
      config: { auth: {}, gateway: { port: 0, accessToken: '' }, mcpServers: [] } as any,
      executionBackend: remotePoolBackendOf(binding),
    },
    {
      binding,
      keyring,
      executionRoot: execRoot,
      platformPrompt: 'test-platform-prompt',
      brokerTransport,
      execEnvLeaseId: 'lease-compute-pool-01',
      fencingTokenProvider: () => ({ fencingToken: 'fence-abc', brainGen: 4 }),
      blobResolver: async (blobId) => {
        if (blobId === 'blob_01') {
          return { mimeType: 'image/jpeg', data: '/9j/4AAQ' }
        }
        throw new Error('BLOB_NOT_FOUND')
      },
      hostFactory: () => host,
      toolContextFactory: async () => ({
        profile: { cwd: execRoot, mcpConfigPath: null, settingsPath: null, disallowedTools: [] },
        env: {},
        platformPrompt: 'test-platform-prompt',
        cleanup: () => {},
      }),
      call: async (path, body) => {
        if (path === '/admit') {
          return { ok: true, ready: true, seq: nextSeq, nativeSessionId }
        }
        if (path === '/command') {
          const cmd = body.command as Record<string, unknown>
          commandsSent.push(cmd)
          if (cmd.kind === 'newTurn') {
            const turnId = String(cmd.commandId).slice('turn-'.length)
            // First turn: emit toolCallObserved WITH CLI toolSummary, then MCP request WITHOUT toolSummary!
            if (commandsSent.length === 1) {
              const obsArgs = { CommandLine: 'echo hi', toolSummary: 'Say hi' }
              const mcpArgs = { CommandLine: 'echo hi' }
              frames.push({
                seq: ++nextSeq,
                frame: {
                  kind: 'security',
                  event: makeToolObservedEvent(binding, {
                    seq: 1,
                    authorityTurnId: turnId,
                    nativeSessionId,
                    callId: 'call_broker_1',
                    name: 'RunCommand',
                    arguments: obsArgs,
                  }),
                },
              })
              pendingTool = {
                authority: currentSigned.authority,
                lease: currentSigned.lease,
                turnKey: currentSigned.turnKey,
                request: {
                  rpcId: 10,
                  callId: 'call_broker_1',
                  nativeSessionId,
                  server: 'ocbridge',
                  name: 'RunCommand',
                  arguments: mcpArgs,
                  argsHash: remoteCanonicalSha256(mcpArgs),
                },
              }
            } else {
              // Second turn settles immediately
              frames.push({
                seq: ++nextSeq,
                frame: {
                  kind: 'turn_settled',
                  receipt: makeReceipt(binding, {
                    authorityTurnId: turnId,
                    turnKey: currentSigned.turnKey,
                    nativeSessionId,
                  }),
                  outcome: { state: 'proven', requestId: 'req-2' },
                },
              })
            }
          }
          return { ok: true, dispatched: true }
        }
        if (path === '/poll') {
          const afterSeq = Number(body.afterSeq)
          return { ok: true, frames: frames.filter((f) => f.seq > afterSeq) }
        }
        if (path === '/tool/next') {
          if (!pendingTool) return { ok: true }
          const out = pendingTool
          pendingTool = null
          return { ok: true, ...out }
        }
        if (path === '/tool/result') {
          toolResultsSent.push({ callId: String(body.callId), result: body.result })
          return { ok: true, callId: body.callId }
        }
        if (path === '/tool/ack') {
          frames.push({
            seq: ++nextSeq,
            frame: {
              kind: 'turn_settled',
              receipt: makeReceipt(binding, {
                authorityTurnId: currentSigned.payload.authorityTurnId,
                turnKey: currentSigned.turnKey,
                nativeSessionId,
              }),
              outcome: { state: 'proven', requestId: 'req-1' },
            },
          })
          return { ok: true }
        }
        if (path === '/tool/stopped') return { ok: true }
        if (path === '/stop') return { ok: true, remoteStopped: true }
        throw new Error(`unexpected path: ${path}`)
      },
    },
  )

  // Turn 1: supportsVision=true, multimodal input (image + blob_ref), serviceTier='fast'
  let currentSigned = signTurn({ binding, supportsVision: true })
  const validated1 = lane.validateTurnSubmission({
    input: [
      { type: 'text', text: 'Inspect this image' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
      },
      { type: 'blob_ref', blobId: 'blob_01', mimeType: 'image/jpeg' },
    ],
    serviceTier: 'fast',
    turnKey: currentSigned.turnKey,
    modelAuthority: {
      authorityEnvelope: currentSigned.authority,
      leaseEnvelope: currentSigned.lease,
      executionDescriptor: {
        canonicalModel: binding.canonicalModel,
        executionBackend: remotePoolBackendOf(binding),
        contextWindow: 200_000,
        capabilityZero: false,
        supportsThinking: true,
        supportsVision: true,
        supportedEfforts: ['low', 'medium', 'high'],
      },
    },
    onEvent: () => {},
    sessionTotals: { totalCostUSD: 0, turns: 0 },
    toolUseIdToName: new Map(),
  })
  assert.equal(validated1.serviceTier, 'fast')
  assert.deepEqual(validated1.content, [
    { type: 'text', text: 'Inspect this image' },
    { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
    { type: 'image', mimeType: 'image/jpeg', blobId: 'blob_01' },
  ])

  const out1 = await lane.executeTurn(validated1, {
    onNativeSession: () => {},
    onSubmitted: () => {},
    onSecurityEvent: () => {},
    onPresentationItem: () => {},
  })
  assert.equal(out1.kind, 'settled')
  assert.equal(hostExecuteCalls, 0, 'injected brokerTransport must bypass Cc5ToolHost.execute')
  assert.equal(brokerCalls.length, 1)
  assert.equal(brokerCalls[0]!.leaseId, 'lease-compute-pool-01')
  assert.equal(brokerCalls[0]!.attestation.kind, 'schema_filtered_hook')
  assert.equal(brokerCalls[0]!.attestation.grantId, 'fence-abc:4')
  assert.deepEqual(toolResultsSent[0], {
    callId: 'call_broker_1',
    result: { content: [{ type: 'text', text: 'broker-ok:echo hi' }], isError: false },
  })
  assert.equal(commandsSent[0]!.serviceTier, 'fast')
  assert.deepEqual(commandsSent[0]!.content, [
    { type: 'text', text: 'Inspect this image' },
    { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
    { type: 'image', mimeType: 'image/jpeg', data: '/9j/4AAQ' },
  ])

  // Real cross-language TS -> Python interoperability check (B02): feed the exact command emitted
  // by RemoteContainerLane into real codex.py, cc.py, and antigravity.py encoders!
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')
  const pyProbeOut = execFileSync(
    'python3',
    [
      '-c',
      [
        'import json, sys',
        'sys.path.insert(0, sys.argv[1])',
        'from core.contract import load_driver',
        'cmd = json.loads(sys.argv[2])',
        'cx, _, _ = load_driver("codex")',
        'cc, _, _ = load_driver("cc")',
        'agy, _, _ = load_driver("antigravity")',
        'cx_cmd = {**cmd, "commandId": "cmd_xlang_cx", "model": "gpt-6-luna"}',
        'cx_res = cx.encode(cx_cmd, {"initialized": True, "sessionId": "thr_xlang_1", "expectedModel": "gpt-6-luna", "cliVersion": "0.170.0"})',
        'cc_cmd = {**cmd, "commandId": "cmd_xlang_cc"}',
        'cc_res = cc.encode(cc_cmd, {"sessionId": "11111111-2222-4333-8444-555555555555"})',
        'agy_err = ""',
        'try:',
        '    agy.encode({**cmd, "commandId": "cmd_xlang_agy"}, {"initialized": True, "sessionId": "sess_agy_1"})',
        'except ValueError as exc:',
        '    agy_err = str(exc)',
        'print(json.dumps({"codex": json.loads(cx_res["lines"][0]), "cc": json.loads(cc_res["lines"][0]), "agyError": agy_err}))',
      ].join('\n'),
      join(repoRoot, 'scripts', 'agent-remote'),
      JSON.stringify(commandsSent[0]),
    ],
    { encoding: 'utf8' },
  )
  const xlang = JSON.parse(pyProbeOut) as {
    codex: { params: { serviceTierForTurn: string; input: unknown[] } }
    cc: { message: { content: unknown[] } }
    agyError: string
  }
  assert.equal(xlang.codex.params.serviceTierForTurn, 'priority')
  assert.deepEqual(xlang.codex.params.input, [
    { type: 'text', text: 'Inspect this image' },
    { type: 'image', url: 'data:image/png;base64,iVBORw0KGgo=' },
    { type: 'image', url: 'data:image/jpeg;base64,/9j/4AAQ' },
  ])
  assert.deepEqual(xlang.cc.message.content, [
    { type: 'text', text: 'Inspect this image' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/4AAQ' } },
  ])
  assert.equal(xlang.agyError, 'AGY_VISION_CONTENT_UNSUPPORTED')

  // Turn 2: supportsVision=false -> MUST fail closed BEFORE dispatch (never silently strip image!)
  currentSigned = signTurn({ binding, supportsVision: false })
  const validated2 = lane.validateTurnSubmission({
    input: [
      { type: 'text', text: 'No vision here' },
      { type: 'image', mimeType: 'image/png', data: 'AAAA' },
    ],
    turnKey: currentSigned.turnKey,
    modelAuthority: {
      authorityEnvelope: currentSigned.authority,
      leaseEnvelope: currentSigned.lease,
      executionDescriptor: {
        canonicalModel: binding.canonicalModel,
        executionBackend: remotePoolBackendOf(binding),
        contextWindow: 200_000,
        capabilityZero: false,
        supportsThinking: true,
        supportsVision: false,
        supportedEfforts: ['low', 'medium', 'high'],
      },
    },
    onEvent: () => {},
    sessionTotals: { totalCostUSD: 0, turns: 1 },
    toolUseIdToName: new Map(),
  })
  assert.equal(validated2.serviceTier, undefined)
  assert.ok(validated2.content && validated2.content.length === 2)
  await assert.rejects(
    lane.executeTurn(validated2, {
      onNativeSession: () => {},
      onSubmitted: () => {},
      onSecurityEvent: () => {},
      onPresentationItem: () => {},
    }),
    /REMOTE_VISION_CONTENT_UNSUPPORTED/,
  )
  assert.equal(commandsSent.length, 1, 'unsupported vision turn must reject BEFORE dispatch')

  // Turn 3: unresolvable blobId -> MUST fail closed BEFORE dispatch with REMOTE_IMAGE_BLOB_UNRESOLVED
  currentSigned = signTurn({ binding, supportsVision: true })
  const validated3 = lane.validateTurnSubmission({
    input: [
      { type: 'text', text: 'Missing blob' },
      { type: 'blob_ref', blobId: 'blob_missing_99', mimeType: 'image/png' },
    ],
    turnKey: currentSigned.turnKey,
    modelAuthority: {
      authorityEnvelope: currentSigned.authority,
      leaseEnvelope: currentSigned.lease,
      executionDescriptor: {
        canonicalModel: binding.canonicalModel,
        executionBackend: remotePoolBackendOf(binding),
        contextWindow: 200_000,
        capabilityZero: false,
        supportsThinking: true,
        supportsVision: true,
        supportedEfforts: ['low', 'medium', 'high'],
      },
    },
    onEvent: () => {},
    sessionTotals: { totalCostUSD: 0, turns: 1 },
    toolUseIdToName: new Map(),
  })
  await assert.rejects(
    lane.executeTurn(validated3, {
      onNativeSession: () => {},
      onSubmitted: () => {},
      onSecurityEvent: () => {},
      onPresentationItem: () => {},
    }),
    /REMOTE_IMAGE_BLOB_UNRESOLVED/,
  )
  assert.equal(commandsSent.length, 1, 'unresolved blob turn must reject BEFORE dispatch')

  await lane.stopLane()

  // Antigravity text-only remote channel rejects image content fail-closed even if supportsVision=true
  const agyBinding = makeBinding({
    canonicalModel: 'gemini-4-carbon-medium-remote',
    upstreamModel: 'gemini-4-carbon-medium',
    driverId: 'antigravity',
    engineId: 'antigravity',
    authorityEngine: 'antigravity',
  })
  const agySigned = signTurn({ binding: agyBinding, supportsVision: true })
  let agyDispatched = 0
  const agyLane = new RemoteContainerLane(
    {
      agentId: 'main',
      agentBaseDir: execRoot,
      sessionKey: agyBinding.sessionKey,
      model: agyBinding.canonicalModel,
      config: { auth: {}, gateway: { port: 0, accessToken: '' }, mcpServers: [] } as any,
      executionBackend: remotePoolBackendOf(agyBinding),
    },
    {
      binding: agyBinding,
      keyring,
      executionRoot: execRoot,
      platformPrompt: 'p',
      call: async (path) => {
        if (path === '/command') agyDispatched += 1
        if (path === '/stop') return { ok: true, remoteStopped: true }
        return { ok: true }
      },
    },
  )
  const agyValidated = agyLane.validateTurnSubmission({
    input: [
      { type: 'text', text: 'Look at this' },
      { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
    ],
    turnKey: agySigned.turnKey,
    modelAuthority: {
      authorityEnvelope: agySigned.authority,
      leaseEnvelope: agySigned.lease,
      executionDescriptor: {
        canonicalModel: agyBinding.canonicalModel,
        executionBackend: remotePoolBackendOf(agyBinding),
        contextWindow: 200_000,
        capabilityZero: false,
        supportsThinking: true,
        supportsVision: true,
        supportedEfforts: ['low', 'medium', 'high'],
      },
    },
    onEvent: () => {},
    sessionTotals: { totalCostUSD: 0, turns: 0 },
    toolUseIdToName: new Map(),
  })
  await assert.rejects(
    agyLane.executeTurn(agyValidated, {
      onNativeSession: () => {},
      onSubmitted: () => {},
      onSecurityEvent: () => {},
      onPresentationItem: () => {},
    }),
    /REMOTE_VISION_CONTENT_UNSUPPORTED/,
  )
  assert.equal(agyDispatched, 0)
  await agyLane.stopLane()
})

// ---------------------------------------------------------------------------
// 5. relay.ts handleClientCommand newTurn serviceTier & content validation
// ---------------------------------------------------------------------------

function makeFakeChild() {
  const proc = new EventEmitter() as unknown as {
    stdin: PassThrough
    stdout: PassThrough
    stderr: PassThrough
    kill: () => boolean
    emit: EventEmitter['emit']
    on: EventEmitter['on']
    once: EventEmitter['once']
  }
  proc.stdin = new PassThrough()
  proc.stdout = new PassThrough()
  proc.stderr = new PassThrough()
  proc.kill = () => true
  return proc
}

async function createRelayFixture() {
  const binding = makeBinding()
  const { keyring, signTurn } = makeKeyFixture()
  const journalDir = makeTempDir('oc-relay-v5-')
  const encodedCommands: RemoteDriverCommand[] = []
  const dispatchDigests: string[] = []
  const nativeSessionId = `relay_sess_${randomUUID().slice(0, 8)}`

  const appProc = makeFakeChild()
  const sockProc = makeFakeChild()

  const host: RemotePoolHostPort = {
    async preflight() {
      return { memoryOk: true, activeSessions: 0 }
    },
    async provision() {},
    open(role) {
      if (role === 'tool-socket') {
        queueMicrotask(() => {
          sockProc.stdout.write(
            `${JSON.stringify({
              version: 4,
              driverId: binding.driverId,
              engineId: binding.engineId,
              kind: 'socket-ready',
              operationId: binding.operationId,
              runId: binding.runId,
              generation: binding.generation,
            })}\n`,
          )
        })
        return sockProc as any
      }
      queueMicrotask(() => {
        appProc.stdout.write(
          `${JSON.stringify({
            version: 4,
            seq: 1,
            driverId: binding.driverId,
            engineId: binding.engineId,
            operationId: binding.operationId,
            runId: binding.runId,
            generation: binding.generation,
            profileId: binding.profileId,
            authEpoch: binding.authEpoch,
            kind: 'ready',
          })}\n`,
        )
      })
      return appProc as any
    },
    async stop() {
      return { remoteStopped: true as const }
    },
  }

  const finance: RemotePoolFinancePort = {
    async admit() {
      return {
        requestId: `req-${randomUUID()}`,
        async beforeHostStart() {},
        async beforeDispatch({ inputSha256 }) {
          dispatchDigests.push(inputSha256)
        },
        async bindNativeThread() {
          return null
        },
        async abandonUndispatched() {
          return { state: 'proven', requestId: 'req-abandoned' }
        },
        async terminal() {
          return { state: 'proven', requestId: 'req-term' }
        },
        async stop() {},
      }
    },
  }

  const fakeWorker = {
    async info() {
      return {
        driverId: binding.driverId,
        engineId: binding.engineId,
        authorityEngine: binding.authorityEngine,
        driverVersion: binding.driverVersion,
        driverDigest: binding.driverDigest,
        coreDigest: binding.coreDigest,
        usagePolicy: {
          semanticsId: 'cc_per_turn_v1',
          mode: 'per_turn' as const,
          inputField: 'input_tokens',
          outputField: 'output_tokens',
          inputIncludesCacheRead: false,
          outputIncludesReasoning: false,
          allowCacheWrite: true,
        },
      }
    },
    async encode(_driverId: string, command: RemoteDriverCommand, nativeState: Record<string, unknown>) {
      encodedCommands.push(command)
      return {
        lines: [JSON.stringify(command)],
        nextNativeState: nativeState,
        immediateControlReplies: [
          {
            commandId: command.commandId,
            commandKind: command.kind,
            ok: true,
            ...(command.kind === 'resume' ? { nativeSessionId } : {}),
          },
        ],
      }
    },
    async decode() {
      return { securityEvents: [], presentation: [], controlReplies: [], nextNativeState: {} }
    },
    async close() {},
  }

  const spec: RemotePoolLaneSpec = {
    controllerPath: '/tmp/fake-controller.py',
    controllerSha256: HEX64_A,
    manifest: {
      version: 4,
      root: '/tmp/fake-root',
      driverId: binding.driverId,
      engineId: binding.engineId,
      operationId: binding.operationId,
      runId: binding.runId,
      generation: binding.generation,
      profileId: binding.profileId,
      authEpoch: binding.authEpoch,
      model: binding.upstreamModel,
      driverDigest: binding.driverDigest,
      coreDigest: binding.coreDigest,
    },
    driverContext: {},
    verifiedProbe: {} as any,
  }

  const relay = new RemotePoolRelay({
    binding,
    keys: keyring,
    host,
    spec,
    journalDir,
    finance,
    worker: fakeWorker as any,
  })

  const scope = {
    capability: binding.capability,
    uid: binding.uid,
    containerDbId: binding.containerDbId,
    dockerId: binding.dockerId,
    operationId: binding.operationId,
    sessionKey: binding.sessionKey,
    generation: binding.generation,
    driverId: binding.driverId,
    engineId: binding.engineId,
  }
  const signed = signTurn({ binding, supportsVision: true })
  await relay.handleControl('/admit', {
    ...scope,
    authority: signed.authority,
    lease: signed.lease,
    turnKey: signed.turnKey,
    catalog: {
      tools: [
        {
          name: 'ReadFile',
          description: 'Read a file',
          inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ],
    },
  })

  return { relay, binding, scope, nativeSessionId, encodedCommands, dispatchDigests }
}

test('RemotePoolRelay validates serviceTier and content on newTurn and hashes them into inputSha256', async () => {
  const fx = await createRelayFixture()
  const content = [
    { type: 'text', text: 'Describe image' },
    { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
  ] as const

  const res = await fx.relay.handleControl('/command', {
    ...fx.scope,
    command: {
      kind: 'newTurn',
      commandId: 'cmd-valid-v5',
      model: fx.binding.upstreamModel,
      prompt: 'Describe image',
      nativeSessionId: fx.nativeSessionId,
      serviceTier: 'ultrafast',
      content,
    },
  })
  assert.equal(res.dispatched, true)

  const newTurnCmd = fx.encodedCommands.find((c) => c.kind === 'newTurn')
  assert.ok(newTurnCmd && newTurnCmd.kind === 'newTurn')
  assert.equal(newTurnCmd.serviceTier, 'ultrafast')
  assert.deepEqual(newTurnCmd.content, content)
  assert.equal(fx.dispatchDigests[0], remoteCanonicalSha256(newTurnCmd))

  // Clean stop
  await Promise.all([
    fx.relay.handleControl('/stop', fx.scope),
    fx.relay.handleControl('/tool/stopped', {
      ...fx.scope,
      authorityTurnId: (fx.relay as any).admitted.payload.authorityTurnId,
      turnKey: (fx.relay as any).admitted.turnKey,
    }),
  ]).catch(() => {})
})

test('RemotePoolRelay rejects invalid serviceTier, unresolved blobId image blocks, and malformed content blocks fail-closed', async () => {
  // Invalid serviceTier
  const fx1 = await createRelayFixture()
  await assert.rejects(
    fx1.relay.handleControl('/command', {
      ...fx1.scope,
      command: {
        kind: 'newTurn',
        commandId: 'cmd-bad-tier',
        model: fx1.binding.upstreamModel,
        prompt: 'hello',
        serviceTier: 'turbo',
      },
    }),
    /REMOTE_SERVICE_TIER_INVALID/,
  )

  // Unresolved blobId without data/path MUST be rejected with REMOTE_IMAGE_BLOB_UNRESOLVED
  const fxBlob = await createRelayFixture()
  await assert.rejects(
    fxBlob.relay.handleControl('/command', {
      ...fxBlob.scope,
      command: {
        kind: 'newTurn',
        commandId: 'cmd-unresolved-blob',
        model: fxBlob.binding.upstreamModel,
        prompt: 'describe',
        content: [
          { type: 'text', text: 'describe' },
          { type: 'image', mimeType: 'image/png', blobId: 'blob_img_1' },
        ],
      },
    }),
    /REMOTE_IMAGE_BLOB_UNRESOLVED/,
  )

  // Malformed content cases
  const badContents: unknown[] = [
    [],
    'not-an-array',
    [{ type: 'video', mimeType: 'video/mp4', data: 'abc' }],
    [{ type: 'image', mimeType: 'image/png' }], // missing data/blobId/path
    [{ type: 'image', mimeType: 'image/png', path: '../etc/passwd' }],
    [{ type: 'text', text: 'ok', extraField: 1 }],
  ]
  for (let i = 0; i < badContents.length; i++) {
    const fx = await createRelayFixture()
    await assert.rejects(
      fx.relay.handleControl('/command', {
        ...fx.scope,
        command: {
          kind: 'newTurn',
          commandId: `cmd-bad-content-${i}`,
          model: fx.binding.upstreamModel,
          prompt: 'hello',
          content: badContents[i],
        },
      }),
      /REMOTE_CONTENT_BLOCK_INVALID/,
    )
  }
})

// ---------------------------------------------------------------------------
// 6. remoteEngineAdapter.ts capabilities, compaction, call_usage, budget guard, allowMigratedResume
// ---------------------------------------------------------------------------

test('RemoteEngineAdapter aligns multimodalInput, emitsCallUsage, context_compacted, call_usage, creditBudgetFen interrupt, and allowMigratedResume', async (t) => {
  const keepalive = setInterval(() => {}, 1_000)
  t.after(() => clearInterval(keepalive))
  const binding = makeBinding({
    canonicalModel: 'claude-opus-5-5-remote',
    upstreamModel: 'claude-opus-4-6',
  })
  const { keyring, signTurn } = makeKeyFixture()
  const execRoot = makeTempDir('oc-adapter-v5-')
  const nativeSessionId = `adapter_sess_${randomUUID().slice(0, 8)}`

  // 6a. Capabilities: default text-only, vision-enabled -> 'native', emitsCallUsage === true
  const defaultAdapter = new RemoteEngineAdapter(
    {
      agentId: 'main',
      agentBaseDir: execRoot,
      sessionKey: binding.sessionKey,
      model: binding.canonicalModel,
      config: { auth: {}, gateway: { port: 0, accessToken: '' }, mcpServers: [] } as any,
      executionBackend: remotePoolBackendOf(binding),
    },
    { binding, keyring, call: async () => ({ ok: true }) },
  )
  assert.equal(defaultAdapter.capabilities.emitsCallUsage, true)
  assert.equal(defaultAdapter.capabilities.multimodalInput, 'text-only')

  const visionBinding = { ...binding, supportsVision: true } as RemotePoolBinding & {
    supportsVision: boolean
  }
  const visionByBindingAdapter = new RemoteEngineAdapter(
    {
      agentId: 'main',
      agentBaseDir: execRoot,
      sessionKey: binding.sessionKey,
      model: binding.canonicalModel,
      config: { auth: {}, gateway: { port: 0, accessToken: '' }, mcpServers: [] } as any,
      executionBackend: remotePoolBackendOf(binding),
    },
    { binding: visionBinding, keyring, call: async () => ({ ok: true }) },
  )
  assert.equal(visionByBindingAdapter.capabilities.multimodalInput, 'native')

  // 6b. allowMigratedResume vs strict isResumeIdCompatible / setResumeSessionId
  const foreignOp = randomUUID()
  const foreignResume = remoteV4ResumeId(foreignOp, 'migrated_native_99')
  assert.equal(defaultAdapter.isResumeIdCompatible(foreignResume), false)
  assert.throws(
    () => defaultAdapter.setResumeSessionId(foreignResume),
    /REMOTE_RESUME_ID_INCOMPATIBLE/,
  )
  const rebound = defaultAdapter.allowMigratedResume(foreignResume)
  assert.equal(rebound, remoteV4ResumeId(binding.operationId, 'migrated_native_99'))
  assert.equal(defaultAdapter.nativeSessionId, rebound)
  assert.equal(defaultAdapter.isResumeIdCompatible(rebound), true)
  assert.throws(
    () => defaultAdapter.allowMigratedResume('../invalid'),
    /REMOTE_MIGRATED_RESUME_ID_INVALID/,
  )

  // 6c. Live turn: serviceTier passthrough + context_compacted + call_usage + mid-turn creditBudgetFen circuit breaker
  _setPlatformPricingLookupForTests(async () => ({
    inputPerMtok: 1_000, // 1000 fen / 1M input tokens
    outputPerMtok: 1_000_000, // 1 fen per output token -> 100 output tokens = 100 fen >= 50 fen budget
    cacheReadPerMtok: 0,
    cacheWritePerMtok: 0,
    multiplier: '1.000',
  }))

  const frames: Array<{ seq: number; frame: RemoteRelayedFrame }> = []
  let seq = 0
  const commands: Array<Record<string, unknown>> = []
  let interruptReceived = false
  const signed = signTurn({ binding, supportsVision: true })

  const liveAdapter = new RemoteEngineAdapter(
    {
      agentId: 'main',
      agentBaseDir: execRoot,
      sessionKey: binding.sessionKey,
      model: binding.canonicalModel,
      config: { auth: {}, gateway: { port: 0, accessToken: '' }, mcpServers: [] } as any,
      executionBackend: remotePoolBackendOf(binding),
      executionAuthority: {
        executionDescriptor: { supportsVision: true },
      },
    } as any,
    {
      binding,
      keyring,
      executionRoot: execRoot,
      platformPrompt: 'prompt',
      hostFactory: () => ({
        async tools() {
          return [{ name: 'Read', description: 'Read file', inputSchema: { type: 'object' } }]
        },
        async execute() {
          return { content: [{ type: 'text', text: 'ok' }], isError: false }
        },
        async close() {},
      }),
      toolContextFactory: async () => ({
        profile: { cwd: execRoot, mcpConfigPath: null, settingsPath: null, disallowedTools: [] },
        env: {},
        platformPrompt: 'prompt',
        cleanup: () => {},
      }),
      call: async (path, body) => {
        if (path === '/admit') {
          return { ok: true, ready: true, seq, nativeSessionId }
        }
        if (path === '/command') {
          const cmd = body.command as Record<string, unknown>
          commands.push(cmd)
          if (cmd.kind === 'newTurn') {
            frames.push({
              seq: ++seq,
              frame: {
                kind: 'presentation',
                item: { kind: 'compaction', text: 'Compacted remote thread summary' },
              },
            })
            frames.push({
              seq: ++seq,
              frame: {
                kind: 'security',
                event: {
                  protocolVersion: REMOTE_DRIVER_PROTOCOL_VERSION,
                  operationId: binding.operationId,
                  generation: binding.generation,
                  profileId: binding.profileId,
                  authEpoch: binding.authEpoch,
                  authorityTurnId: signed.payload.authorityTurnId,
                  nativeSessionId,
                  seq: 1,
                  rawFrameRef: { channel: 'native', frameSeq: 1, sha256: HEX64_A },
                  driverId: binding.driverId,
                  driverVersion: binding.driverVersion,
                  payload: {
                    kind: 'usage',
                    sampleId: 'sample_mid_1',
                    scopeId: 'call_1',
                    semanticsId: 'cc_per_turn_v1',
                    rawCounters: { input_tokens: 1_000, output_tokens: 200 },
                  },
                },
              },
            })
          } else if (cmd.kind === 'interrupt') {
            interruptReceived = true
            frames.push({
              seq: ++seq,
              frame: {
                kind: 'turn_settled',
                receipt: makeReceipt(binding, {
                  authorityTurnId: signed.payload.authorityTurnId,
                  turnKey: signed.turnKey,
                  nativeSessionId,
                  nativeStatus: 'interrupted',
                  inputTokens: 1_000,
                  outputTokens: 200,
                }),
                outcome: { state: 'proven', requestId: 'req-budget' },
              },
            })
          }
          return { ok: true, dispatched: true }
        }
        if (path === '/poll') {
          const afterSeq = Number(body.afterSeq)
          return { ok: true, frames: frames.filter((f) => f.seq > afterSeq) }
        }
        if (path === '/tool/next') return { ok: true }
        if (path === '/tool/stopped') return { ok: true }
        if (path === '/stop') return { ok: true, remoteStopped: true }
        throw new Error(`unexpected path: ${path}`)
      },
    },
  )
  assert.equal(liveAdapter.capabilities.multimodalInput, 'native')

  const events: EngineEvent[] = []
  const run = liveAdapter.submitTurn({
    input: 'Run budget test',
    serviceTier: 'fast',
    creditBudgetFen: 50n,
    requestId: 'req-v5-parity',
    assistantMessageId: 'srv-msg-1',
    turnKey: signed.turnKey,
    modelAuthority: {
      authorityEnvelope: signed.authority,
      leaseEnvelope: signed.lease,
      executionDescriptor: {
        canonicalModel: binding.canonicalModel,
        executionBackend: remotePoolBackendOf(binding),
        contextWindow: 200_000,
        capabilityZero: false,
        supportsThinking: true,
        supportsVision: true,
        supportedEfforts: ['low', 'medium', 'high'],
      },
    },
    onEvent: (ev) => events.push(ev),
    sessionTotals: { totalCostUSD: 0, turns: 0 },
    toolUseIdToName: new Map(),
  })

  await run.submitted
  const summary = await run.summary
  assert.ok(summary !== null)
  assert.equal(commands[0]!.serviceTier, 'fast')
  assert.equal(interruptReceived, true, 'mid-turn usage exceeding creditBudgetFen must trigger interrupt(system)')

  const compactedEv = events.find((e) => e.kind === 'context_compacted')
  assert.ok(compactedEv && compactedEv.kind === 'context_compacted')
  assert.equal(compactedEv.compaction.engine, 'ccb')
  assert.equal(compactedEv.compaction.scope, 'native_context')
  assert.equal(compactedEv.compaction.strategy, 'native_summary')
  assert.equal(compactedEv.compaction.summaryPreview, 'Compacted remote thread summary')

  const callUsageEv = events.find((e) => e.kind === 'call_usage')
  assert.ok(callUsageEv && callUsageEv.kind === 'call_usage')
  assert.equal(callUsageEv.call.callId, 'sample_mid_1')
  assert.deepEqual(callUsageEv.call.targetIds, ['srv-msg-1-s0'])
  assert.equal(callUsageEv.call.usage.inputTokens, 1_000)
  assert.equal(callUsageEv.call.usage.outputTokens, 200)

  const errEv = events.find((e) => e.kind === 'error')
  assert.ok(errEv && errEv.kind === 'error')
  assert.match(errEv.error, /INSUFFICIENT_CREDITS/)

  await liveAdapter.shutdown()
})

// ---------------------------------------------------------------------------
// 7. B04 Regressions: AGY cumulative step snapshots & Codex cross-turn baseline
// ---------------------------------------------------------------------------

test('RemoteEngineAdapter (B04a): AGY multi-step cumulative snapshots replace per scopeId without false creditBudgetFen interrupt', async (t) => {
  const keepalive = setInterval(() => {}, 1_000)
  t.after(() => clearInterval(keepalive))
  const binding = makeBinding({
    canonicalModel: 'gemini-4-carbon-medium-remote',
    upstreamModel: 'gemini-4-carbon-medium',
    driverId: 'antigravity',
    engineId: 'antigravity',
    authorityEngine: 'antigravity',
  })
  const { keyring, signTurn } = makeKeyFixture()
  const execRoot = makeTempDir('oc-adapter-b04-agy-')
  const nativeSessionId = `agy_sess_${randomUUID().slice(0, 8)}`
  const signed = signTurn({ binding, supportsVision: false })

  // 1 fen per input token -> true total 150 fen; buggy sum (100 + 150 + 150 = 400 fen).
  // Budget set to 200 fen (strictly between 150 and 250/400).
  _setPlatformPricingLookupForTests(async () => ({
    inputPerMtok: 1_000_000,
    outputPerMtok: 0,
    cacheReadPerMtok: 0,
    cacheWritePerMtok: 0,
    multiplier: '1.000',
  }))

  const frames: Array<{ seq: number; frame: RemoteRelayedFrame }> = []
  let seq = 0
  let interruptReceived = false

  const adapter = new RemoteEngineAdapter(
    {
      agentId: 'main',
      agentBaseDir: execRoot,
      sessionKey: binding.sessionKey,
      model: binding.canonicalModel,
      config: { auth: {}, gateway: { port: 0, accessToken: '' }, mcpServers: [] } as any,
      executionBackend: remotePoolBackendOf(binding),
    },
    {
      binding,
      keyring,
      executionRoot: execRoot,
      platformPrompt: 'prompt',
      hostFactory: () => ({
        async tools() {
          return [{ name: 'Read', description: 'Read file', inputSchema: { type: 'object' } }]
        },
        async execute() {
          return { content: [{ type: 'text', text: 'ok' }], isError: false }
        },
        async close() {},
      }),
      toolContextFactory: async () => ({
        profile: { cwd: execRoot, mcpConfigPath: null, settingsPath: null, disallowedTools: [] },
        env: {},
        platformPrompt: 'prompt',
        cleanup: () => {},
      }),
      call: async (path, body) => {
        if (path === '/admit') return { ok: true, ready: true, seq, nativeSessionId }
        if (path === '/command') {
          const cmd = body.command as Record<string, unknown>
          if (cmd.kind === 'newTurn') {
            const scopeId = String(cmd.commandId)
            const samples = [
              { sampleId: `${scopeId}-s1`, input_tokens: 100, output_tokens: 10 },
              { sampleId: `${scopeId}-s2`, input_tokens: 150, output_tokens: 20 },
              { sampleId: scopeId, input_tokens: 150, output_tokens: 20 },
            ]
            for (let i = 0; i < samples.length; i += 1) {
              const s = samples[i]!
              frames.push({
                seq: ++seq,
                frame: {
                  kind: 'security',
                  event: {
                    protocolVersion: REMOTE_DRIVER_PROTOCOL_VERSION,
                    operationId: binding.operationId,
                    generation: binding.generation,
                    profileId: binding.profileId,
                    authEpoch: binding.authEpoch,
                    authorityTurnId: signed.payload.authorityTurnId,
                    nativeSessionId,
                    seq: i + 1,
                    rawFrameRef: { channel: 'native', frameSeq: i + 1, sha256: HEX64_A },
                    driverId: binding.driverId,
                    driverVersion: binding.driverVersion,
                    payload: {
                      kind: 'usage',
                      sampleId: s.sampleId,
                      scopeId,
                      semanticsId: 'antigravity-stream-json-v1',
                      rawCounters: {
                        input_tokens: s.input_tokens,
                        output_tokens: s.output_tokens,
                        cache_read_tokens: 0,
                      },
                    },
                  },
                },
              })
            }
            frames.push({
              seq: ++seq,
              frame: {
                kind: 'turn_settled',
                receipt: makeReceipt(binding, {
                  authorityTurnId: signed.payload.authorityTurnId,
                  turnKey: signed.turnKey,
                  nativeSessionId,
                  inputTokens: 150,
                  outputTokens: 20,
                  usageSemantics: 'antigravity-stream-json-v1',
                  countersFinal: { input_tokens: 150, output_tokens: 20, cache_read_tokens: 0 },
                }),
                outcome: { state: 'proven', requestId: 'req-agy-b04' },
              },
            })
          } else if (cmd.kind === 'interrupt') {
            interruptReceived = true
          }
          return { ok: true, dispatched: true }
        }
        if (path === '/poll') {
          const afterSeq = Number(body.afterSeq)
          return { ok: true, frames: frames.filter((f) => f.seq > afterSeq) }
        }
        if (path === '/tool/next') return { ok: true }
        if (path === '/tool/stopped') return { ok: true }
        if (path === '/stop') return { ok: true, remoteStopped: true }
        throw new Error(`unexpected path: ${path}`)
      },
    },
  )

  const events: EngineEvent[] = []
  const run = adapter.submitTurn({
    input: 'AGY multi-step cumulative test',
    creditBudgetFen: 200n,
    requestId: 'req-agy-b04',
    assistantMessageId: 'srv-agy-1',
    turnKey: signed.turnKey,
    modelAuthority: {
      authorityEnvelope: signed.authority,
      leaseEnvelope: signed.lease,
      executionDescriptor: {
        canonicalModel: binding.canonicalModel,
        executionBackend: remotePoolBackendOf(binding),
        contextWindow: 200_000,
        capabilityZero: false,
        supportsThinking: true,
        supportsVision: false,
        supportedEfforts: ['low', 'medium', 'high'],
      },
    },
    onEvent: (ev) => events.push(ev),
    sessionTotals: { totalCostUSD: 0, turns: 0 },
    toolUseIdToName: new Map(),
  })

  await run.submitted
  const summary = await run.summary
  assert.ok(summary !== null)
  assert.equal(interruptReceived, false, 'AGY cumulative step snapshots must NOT false-trigger budget guard')
  assert.equal(summary.isError, false)
  assert.equal(summary.usage.inputTokens, 150)
  assert.equal(summary.usage.outputTokens, 20)

  const callUsages = events.filter(
    (e): e is Extract<EngineEvent, { kind: 'call_usage' }> => e.kind === 'call_usage',
  )
  assert.equal(callUsages.length, 2, 'zero-delta duplicate result snapshot must not emit bogus third call_usage')
  assert.equal(
    callUsages.reduce((acc, c) => acc + (c.call.usage.inputTokens ?? 0), 0),
    150,
  )
  assert.equal(
    callUsages.reduce((acc, c) => acc + (c.call.usage.outputTokens ?? 0), 0),
    20,
  )

  await adapter.shutdown()
})

test('RemoteEngineAdapter (B04b): Codex cross-turn cumulative baseline & cachedInputTokens deduction prevent false Turn-2 interrupt', async (t) => {
  const keepalive = setInterval(() => {}, 1_000)
  t.after(() => clearInterval(keepalive))
  const binding = makeBinding({
    canonicalModel: 'gpt-6-luna-remote',
    upstreamModel: 'gpt-6-luna',
    driverId: 'codex',
    engineId: 'codex',
    authorityEngine: 'codex',
  })
  const { keyring, signTurn } = makeKeyFixture()
  const execRoot = makeTempDir('oc-adapter-b04-codex-')
  const nativeSessionId = `thr_codex_${randomUUID().slice(0, 8)}`

  // 1 fen per uncached input token, 0.1 fen per cache_read token.
  // Turn 1 cumulative: inputTokens=500 (cached=100 -> 400 uncached), output=50.
  // Turn 2 cumulative: inputTokens=620 (cached=140 -> delta raw 120, delta cached 40, delta uncached 80), output=80 (delta 30).
  // Real Turn 2 cost = 80*1 + 40*0.1 = 84 fen. Budget = 200 fen (strictly between 84/120 and buggy 620+).
  _setPlatformPricingLookupForTests(async () => ({
    inputPerMtok: 1_000_000,
    outputPerMtok: 0,
    cacheReadPerMtok: 100_000,
    cacheWritePerMtok: 0,
    multiplier: '1.000',
  }))

  const frames: Array<{ seq: number; frame: RemoteRelayedFrame }> = []
  let seq = 0
  let secSeq = 0
  let turnIndex = 0
  let currentSigned = signTurn({ binding, supportsVision: true })
  const interruptsByTurn: boolean[] = []

  const adapter = new RemoteEngineAdapter(
    {
      agentId: 'main',
      agentBaseDir: execRoot,
      sessionKey: binding.sessionKey,
      model: binding.canonicalModel,
      config: { auth: {}, gateway: { port: 0, accessToken: '' }, mcpServers: [] } as any,
      executionBackend: remotePoolBackendOf(binding),
    },
    {
      binding,
      keyring,
      executionRoot: execRoot,
      platformPrompt: 'prompt',
      hostFactory: () => ({
        async tools() {
          return [{ name: 'Read', description: 'Read file', inputSchema: { type: 'object' } }]
        },
        async execute() {
          return { content: [{ type: 'text', text: 'ok' }], isError: false }
        },
        async close() {},
      }),
      toolContextFactory: async () => ({
        profile: { cwd: execRoot, mcpConfigPath: null, settingsPath: null, disallowedTools: [] },
        env: {},
        platformPrompt: 'prompt',
        cleanup: () => {},
      }),
      call: async (path, body) => {
        if (path === '/admit') return { ok: true, ready: true, seq, nativeSessionId }
        if (path === '/command') {
          const cmd = body.command as Record<string, unknown>
          if (cmd.kind === 'newTurn') {
            turnIndex += 1
            interruptsByTurn.push(false)
            if (turnIndex === 1) {
              const t1Final = {
                inputTokens: 500,
                cachedInputTokens: 100,
                cacheWriteInputTokens: 0,
                outputTokens: 50,
                reasoningOutputTokens: 0,
              }
              frames.push({
                seq: ++seq,
                frame: {
                  kind: 'security',
                  event: {
                    protocolVersion: REMOTE_DRIVER_PROTOCOL_VERSION,
                    operationId: binding.operationId,
                    generation: binding.generation,
                    profileId: binding.profileId,
                    authEpoch: binding.authEpoch,
                    authorityTurnId: currentSigned.payload.authorityTurnId,
                    nativeSessionId,
                    seq: ++secSeq,
                    rawFrameRef: { channel: 'native', frameSeq: secSeq, sha256: HEX64_A },
                    driverId: binding.driverId,
                    driverVersion: binding.driverVersion,
                    payload: {
                      kind: 'usage',
                      sampleId: 't1-u1',
                      scopeId: 'turn_1',
                      semanticsId: 'codex-0.167-total-v1',
                      rawCounters: t1Final,
                    },
                  },
                },
              })
              frames.push({
                seq: ++seq,
                frame: {
                  kind: 'turn_settled',
                  receipt: makeReceipt(binding, {
                    authorityTurnId: currentSigned.payload.authorityTurnId,
                    turnKey: currentSigned.turnKey,
                    nativeSessionId,
                    inputTokens: 400,
                    outputTokens: 50,
                    cacheReadTokens: 100,
                    usageMode: 'cumulative',
                    usageSemantics: 'codex-0.167-total-v1',
                    countersBaseline: {
                      inputTokens: 0,
                      cachedInputTokens: 0,
                      cacheWriteInputTokens: 0,
                      outputTokens: 0,
                      reasoningOutputTokens: 0,
                    },
                    countersFinal: t1Final,
                  }),
                  outcome: { state: 'proven', requestId: 'req-cx-t1' },
                },
              })
            } else if (turnIndex === 2) {
              const t2Final = {
                inputTokens: 620,
                cachedInputTokens: 140,
                cacheWriteInputTokens: 0,
                outputTokens: 80,
                reasoningOutputTokens: 10,
              }
              frames.push({
                seq: ++seq,
                frame: {
                  kind: 'security',
                  event: {
                    protocolVersion: REMOTE_DRIVER_PROTOCOL_VERSION,
                    operationId: binding.operationId,
                    generation: binding.generation,
                    profileId: binding.profileId,
                    authEpoch: binding.authEpoch,
                    authorityTurnId: currentSigned.payload.authorityTurnId,
                    nativeSessionId,
                    seq: ++secSeq,
                    rawFrameRef: { channel: 'native', frameSeq: secSeq, sha256: HEX64_A },
                    driverId: binding.driverId,
                    driverVersion: binding.driverVersion,
                    payload: {
                      kind: 'usage',
                      sampleId: 't2-u1',
                      scopeId: 'turn_2',
                      semanticsId: 'codex-0.167-total-v1',
                      rawCounters: t2Final,
                    },
                  },
                },
              })
              // Give budget guard microtasks a chance to run before settling (must NOT interrupt)
              setTimeout(() => {
                frames.push({
                  seq: ++seq,
                  frame: {
                    kind: 'turn_settled',
                    receipt: makeReceipt(binding, {
                      authorityTurnId: currentSigned.payload.authorityTurnId,
                      turnKey: currentSigned.turnKey,
                      nativeSessionId,
                      inputTokens: 80,
                      outputTokens: 30,
                      cacheReadTokens: 40,
                      usageMode: 'cumulative',
                      usageSemantics: 'codex-0.167-total-v1',
                      countersBaseline: {
                        inputTokens: 500,
                        cachedInputTokens: 100,
                        cacheWriteInputTokens: 0,
                        outputTokens: 50,
                        reasoningOutputTokens: 0,
                      },
                      countersFinal: t2Final,
                    }),
                    outcome: { state: 'proven', requestId: 'req-cx-t2' },
                  },
                })
              }, 30)
            }
          } else if (cmd.kind === 'interrupt') {
            interruptsByTurn[turnIndex - 1] = true
          }
          return { ok: true, dispatched: true }
        }
        if (path === '/poll') {
          const afterSeq = Number(body.afterSeq)
          return { ok: true, frames: frames.filter((f) => f.seq > afterSeq) }
        }
        if (path === '/tool/next') return { ok: true }
        if (path === '/tool/stopped') return { ok: true }
        if (path === '/stop') return { ok: true, remoteStopped: true }
        throw new Error(`unexpected path: ${path}`)
      },
    },
  )

  const sessionTotals = { totalCostUSD: 0, turns: 0 }

  // Turn 1: establishes thread cumulative baseline at 500 input / 100 cached / 50 output
  const run1 = adapter.submitTurn({
    input: 'Codex turn 1',
    creditBudgetFen: 1_000n,
    requestId: 'req-cx-t1',
    assistantMessageId: 'srv-cx-1',
    turnKey: currentSigned.turnKey,
    modelAuthority: {
      authorityEnvelope: currentSigned.authority,
      leaseEnvelope: currentSigned.lease,
      executionDescriptor: {
        canonicalModel: binding.canonicalModel,
        executionBackend: remotePoolBackendOf(binding),
        contextWindow: 200_000,
        capabilityZero: false,
        supportsThinking: true,
        supportsVision: true,
        supportedEfforts: ['low', 'medium', 'high'],
      },
    },
    onEvent: () => {},
    sessionTotals,
    toolUseIdToName: new Map(),
  })
  await run1.submitted
  const sum1 = await run1.summary
  assert.ok(sum1 !== null && !sum1.isError)
  assert.equal(interruptsByTurn[0], false)

  // Turn 2: budget=200n (between real net cost 84 fen and thread cumulative 620+ fen)
  currentSigned = signTurn({ binding, supportsVision: true })
  const turn2Events: EngineEvent[] = []
  const run2 = adapter.submitTurn({
    input: 'Codex turn 2',
    creditBudgetFen: 200n,
    requestId: 'req-cx-t2',
    assistantMessageId: 'srv-cx-2',
    turnKey: currentSigned.turnKey,
    modelAuthority: {
      authorityEnvelope: currentSigned.authority,
      leaseEnvelope: currentSigned.lease,
      executionDescriptor: {
        canonicalModel: binding.canonicalModel,
        executionBackend: remotePoolBackendOf(binding),
        contextWindow: 200_000,
        capabilityZero: false,
        supportsThinking: true,
        supportsVision: true,
        supportedEfforts: ['low', 'medium', 'high'],
      },
    },
    onEvent: (ev) => turn2Events.push(ev),
    sessionTotals,
    toolUseIdToName: new Map(),
  })
  await run2.submitted
  const sum2 = await run2.summary
  assert.ok(sum2 !== null)
  assert.equal(interruptsByTurn[1], false, 'Codex Turn 2 must subtract Turn 1 baseline and cachedInputTokens')
  assert.equal(sum2.isError, false)
  assert.equal(sum2.usage.inputTokens, 80)
  assert.equal(sum2.usage.cacheReadTokens, 40)
  assert.equal(sum2.usage.outputTokens, 30)

  const t2CallUsage = turn2Events.find(
    (e): e is Extract<EngineEvent, { kind: 'call_usage' }> => e.kind === 'call_usage',
  )
  assert.ok(t2CallUsage)
  assert.equal(t2CallUsage.call.usage.inputTokens, 80)
  assert.equal(t2CallUsage.call.usage.cacheReadTokens, 40)
  assert.equal(t2CallUsage.call.usage.outputTokens, 30)
  assert.equal(t2CallUsage.call.usage.totalTokens, 150)

  await adapter.shutdown()
})

test('RemoteContainerLane & Relay (B02-R2): container-local image path is materialized to base64 before dispatch; unreadable path fails pre-dispatch; relay rejects raw path', async (t) => {
  const keepalive = setInterval(() => {}, 1_000)
  t.after(() => clearInterval(keepalive))
  const dir = mkdtempSync(join(tmpdir(), 'ocv5-b02-path-'))
  try {
    const imgPath = join(dir, 'diagram.png')
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02])
    writeFileSync(imgPath, pngBytes)

    const { keyring, signTurn } = makeKeyFixture()
    const binding = makeBinding({
      canonicalModel: 'claude-opus-4-6-remote',
      upstreamModel: 'claude-opus-4-6',
      driverId: 'cc',
      engineId: 'claude-code',
      authorityEngine: 'ccb',
    })
    const dispatchedCommands: Array<Record<string, unknown>> = []
    let admitCalls = 0
    const signed = signTurn({ binding, supportsVision: true })
    const lane = new RemoteContainerLane(
      {
        agentId: 'main',
        agentBaseDir: dir,
        sessionKey: binding.sessionKey,
        model: binding.canonicalModel,
        config: { auth: {}, gateway: { port: 0, accessToken: '' }, mcpServers: [] } as any,
        executionBackend: remotePoolBackendOf(binding),
      },
      {
        binding,
        keyring,
        executionRoot: dir,
        platformPrompt: 'prompt',
        hostFactory: () => ({
          async tools() {
            return [{ name: 'Read', description: 'read', inputSchema: { type: 'object', properties: {} } }]
          },
          async execute() {
            return { content: [{ type: 'text', text: 'ok' }], isError: false }
          },
          async close() {},
        }),
        toolContextFactory: async () => ({
          profile: { cwd: dir, mcpConfigPath: null, settingsPath: null, disallowedTools: [] },
          env: {},
          platformPrompt: 'prompt',
          cleanup: () => {},
        }),
        call: async (path, body) => {
          if (path === '/admit') {
            admitCalls += 1
            return { ok: true, ready: true, seq: 0, nativeSessionId: 'native-b02-r2' }
          }
          if (path === '/command') {
            dispatchedCommands.push(body.command as Record<string, unknown>)
            return { ok: true }
          }
          if (path === '/poll') {
            const afterSeq = Number(body.afterSeq ?? 0)
            if (afterSeq >= 1) return { frames: [] }
            return {
              frames: [
                {
                  seq: 1,
                  frame: {
                    kind: 'turn_settled',
                    receipt: makeReceipt(binding, {
                      authorityTurnId: signed.payload.authorityTurnId,
                      turnKey: signed.turnKey,
                      nativeSessionId: 'native-b02-r2',
                    }),
                    outcome: { state: 'proven', requestId: 'req-b02-r2' },
                  },
                },
              ],
            }
          }
          if (path === '/tool/next') return {}
          if (path === '/stop') return { ok: true, remoteStopped: true }
          throw new Error(`unexpected path: ${path}`)
        },
      },
    )

    // 1) Missing/unreadable path MUST fail closed BEFORE admit/dispatch!
    await assert.rejects(
      () =>
        lane.executeTurn(
          {
            authority: signed.authority,
            lease: signed.lease,
            turnKey: signed.turnKey,
            payload: signed.payload,
            prompt: 'Inspect missing image',
            content: [
              { type: 'text', text: 'Inspect missing image' },
              { type: 'image', mimeType: 'image/png', path: join(dir, 'does-not-exist.png') },
            ],
          },
          {
            onNativeSession: () => {},
            onSubmitted: () => {},
            onSecurityEvent: () => {},
            onPresentationItem: () => {},
          },
        ),
      /REMOTE_IMAGE_PATH_UNREADABLE/,
    )
    assert.equal(admitCalls, 0, 'unreadable image path must reject BEFORE admission/dispatch')
    assert.equal(dispatchedCommands.length, 0)

    // 2) Valid local container image path is materialized to base64 `data` (NO raw `path` on wire!)
    const outcome = await lane.executeTurn(
      {
        authority: signed.authority,
        lease: signed.lease,
        turnKey: signed.turnKey,
        payload: signed.payload,
        prompt: 'Inspect diagram',
        content: [
          { type: 'text', text: 'Inspect diagram' },
          { type: 'image', mimeType: 'image/png', path: imgPath },
        ],
      },
      {
        onNativeSession: () => {},
        onSubmitted: () => {},
        onSecurityEvent: () => {},
        onPresentationItem: () => {},
      },
    )
    assert.equal(outcome.kind, 'settled')
    assert.equal(dispatchedCommands.length, 1)
    const sentContent = dispatchedCommands[0]!.content as Array<Record<string, unknown>>
    assert.equal(sentContent.length, 2)
    assert.deepEqual(sentContent[1], {
      type: 'image',
      mimeType: 'image/png',
      data: pngBytes.toString('base64'),
    })
    assert.equal('path' in sentContent[1]!, false, 'raw container-local path must NOT cross wire')

    // 3) Verify real Python CC and Codex encoders BOTH accept the exact materialized wire output!
    const testRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')
    const ccEncoded = JSON.parse(
      execFileSync(
        'python3',
        [
          '-c',
          `import json, sys; sys.path.insert(0, ${JSON.stringify(join(testRepoRoot, 'scripts/agent-remote'))}); from drivers import cc; print(json.dumps(cc.encode(json.loads(sys.argv[1]), {"sessionId": "11111111-2222-4333-8444-555555555555"})["lines"]))`,
          JSON.stringify({
            kind: 'newTurn',
            commandId: 'cmd-cc-b02-r2',
            model: 'claude-opus-4-6',
            prompt: 'Inspect diagram',
            content: sentContent,
          }),
        ],
        { encoding: 'utf8' },
      ),
    ) as string[]
    assert.ok(ccEncoded.length >= 1, 'CC encoder must accept materialized image content from lane')
    const ccMsg = JSON.parse(ccEncoded[0]!) as { message: { content: unknown[] } }
    assert.deepEqual(ccMsg.message.content[1], {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: pngBytes.toString('base64') },
    })

    const codexEncoded = JSON.parse(
      execFileSync(
        'python3',
        [
          '-c',
          `import json, sys; sys.path.insert(0, ${JSON.stringify(join(testRepoRoot, 'scripts/agent-remote'))}); from drivers import codex; print(json.dumps(codex.encode(json.loads(sys.argv[1]), {"initialized": True, "sessionId": "t1", "expectedModel": "gpt-6-luna", "cliVersion": "0.172.0"})["lines"]))`,
          JSON.stringify({
            kind: 'newTurn',
            commandId: 'cmd-cx-b02-r2',
            model: 'gpt-6-luna',
            prompt: 'Inspect diagram',
            content: sentContent,
          }),
        ],
        { encoding: 'utf8' },
      ),
    ) as string[]
    assert.ok(codexEncoded.length >= 1, 'Codex encoder must accept materialized image content from lane')
    const cxMsg = JSON.parse(codexEncoded[0]!) as { params: { input: unknown[] } }
    assert.deepEqual(cxMsg.params.input[1], {
      type: 'image',
      url: `data:image/png;base64,${pngBytes.toString('base64')}`,
    })

    await lane.stopLane()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('RemoteEngineAdapter (B04-R2): brand-new adapter instance resuming a Codex thread hydrates authoritative /admit countersBaseline and avoids false budget interrupt', async (t) => {
  const keepalive = setInterval(() => {}, 1_000)
  t.after(() => clearInterval(keepalive))
  const { keyring, signTurn } = makeKeyFixture()
  const execRoot = makeTempDir('oc-adapter-b04-r2-')
  const binding = makeBinding({
    canonicalModel: 'gpt-6-luna-remote',
    upstreamModel: 'gpt-6-luna',
    driverId: 'codex',
    engineId: 'codex',
    authorityEngine: 'codex',
  })
  _setPlatformPricingLookupForTests(async () => ({
    inputPerMtok: 1_000_000,
    outputPerMtok: 0,
    cacheReadPerMtok: 100_000,
    cacheWritePerMtok: 0,
    multiplier: '1.000',
  }))

  const signedT2 = signTurn({ binding, supportsVision: true })
  const nativeSessionId = 'native-codex-resumed-b04-r2'
  let seq = 0
  let secSeq = 0
  let interrupted = false
  const frames: Array<{ seq: number; frame: Record<string, unknown> }> = []

  // Fresh brand-new RemoteEngineAdapter instance (never saw Turn 1; _threadCumulativeBaseline starts at 0)
  const freshAdapter = new RemoteEngineAdapter(
    {
      agentId: 'main',
      agentBaseDir: execRoot,
      sessionKey: binding.sessionKey,
      model: binding.canonicalModel,
      config: { auth: {}, gateway: { port: 0, accessToken: '' }, mcpServers: [] } as any,
      executionBackend: remotePoolBackendOf(binding),
    },
    {
      binding,
      keyring,
      executionRoot: execRoot,
      platformPrompt: 'prompt',
      hostFactory: () => ({
        async tools() {
          return [{ name: 'Read', description: 'read', inputSchema: { type: 'object', properties: {} } }]
        },
        async execute() {
          return { content: [{ type: 'text', text: 'ok' }], isError: false }
        },
        async close() {},
      }),
      toolContextFactory: async () => ({
        profile: { cwd: execRoot, mcpConfigPath: null, settingsPath: null, disallowedTools: [] },
        env: {},
        platformPrompt: 'prompt',
        cleanup: () => {},
      }),
      call: async (path, body) => {
        if (path === '/admit') {
          // Relay returns authoritative historical thread baseline from finance.bindNativeThread!
          return {
            ok: true,
            ready: true,
            seq,
            nativeSessionId,
            countersBaseline: {
              inputTokens: 500,
              cachedInputTokens: 100,
              cacheWriteInputTokens: 0,
              outputTokens: 50,
              reasoningOutputTokens: 0,
            },
          }
        }
        if (path === '/command') {
          const cmd = body.command as { kind?: string }
          if (cmd.kind === 'interrupt') {
            interrupted = true
            return { ok: true }
          }
          if (cmd.kind === 'newTurn') {
            const t2Final = {
              inputTokens: 620,
              cachedInputTokens: 140,
              cacheWriteInputTokens: 0,
              outputTokens: 80,
              reasoningOutputTokens: 10,
            }
            frames.push({
              seq: ++seq,
              frame: {
                kind: 'security',
                event: {
                  protocolVersion: REMOTE_DRIVER_PROTOCOL_VERSION,
                  operationId: binding.operationId,
                  generation: binding.generation,
                  profileId: binding.profileId,
                  authEpoch: binding.authEpoch,
                  authorityTurnId: signedT2.payload.authorityTurnId,
                  nativeSessionId,
                  seq: ++secSeq,
                  rawFrameRef: { channel: 'native', frameSeq: secSeq, sha256: HEX64_A },
                  driverId: binding.driverId,
                  driverVersion: binding.driverVersion,
                  payload: {
                    kind: 'usage',
                    sampleId: 'b04-r2-u1',
                    scopeId: 'turn_resumed',
                    semanticsId: 'codex-0.167-total-v1',
                    rawCounters: t2Final,
                  },
                },
              },
            })
            setTimeout(() => {
              frames.push({
                seq: ++seq,
                frame: {
                  kind: 'turn_settled',
                  receipt: makeReceipt(binding, {
                    authorityTurnId: signedT2.payload.authorityTurnId,
                    turnKey: signedT2.turnKey,
                    nativeSessionId,
                    inputTokens: 80,
                    outputTokens: 30,
                    cacheReadTokens: 40,
                    usageMode: 'cumulative',
                    usageSemantics: 'codex-0.167-total-v1',
                    countersBaseline: {
                      inputTokens: 500,
                      cachedInputTokens: 100,
                      cacheWriteInputTokens: 0,
                      outputTokens: 50,
                      reasoningOutputTokens: 0,
                    },
                    countersFinal: t2Final,
                  }),
                  outcome: { state: 'proven', requestId: 'req-b04-r2' },
                },
              })
            }, 25)
            return { ok: true }
          }
          return { ok: true }
        }
        if (path === '/poll') {
          const afterSeq = Number(body.afterSeq ?? 0)
          return { frames: frames.filter((f) => f.seq > afterSeq) }
        }
        if (path === '/tool/next') return {}
        if (path === '/stop') return { ok: true, remoteStopped: true }
        throw new Error(`unexpected path: ${path}`)
      },
    },
  )

  const events: EngineEvent[] = []
  const run = freshAdapter.submitTurn({
    input: 'Resumed turn on fresh adapter',
    creditBudgetFen: 200n, // Between true net cost (~84 fen) and thread cumulative (~620+ fen)
    requestId: 'req-b04-r2',
    assistantMessageId: 'srv-b04-r2',
    turnKey: signedT2.turnKey,
    modelAuthority: {
      authorityEnvelope: signedT2.authority,
      leaseEnvelope: signedT2.lease,
      executionDescriptor: {
        canonicalModel: binding.canonicalModel,
        executionBackend: remotePoolBackendOf(binding),
        contextWindow: 200_000,
        capabilityZero: false,
        supportsThinking: true,
        supportsVision: true,
        supportedEfforts: ['low', 'medium', 'high'],
      },
    },
    onEvent: (ev) => events.push(ev),
    sessionTotals: { totalCostUSD: 0, turns: 0 },
    toolUseIdToName: new Map(),
  })
  await run.submitted
  const sum = await run.summary
  assert.ok(sum !== null)
  assert.equal(
    interrupted,
    false,
    'fresh adapter resuming Codex thread must subtract authoritative /admit countersBaseline',
  )
  assert.equal(sum.isError, false)
  assert.equal(sum.usage.inputTokens, 80)
  assert.equal(sum.usage.cacheReadTokens, 40)
  assert.equal(sum.usage.outputTokens, 30)
  const callUsage = events.find(
    (e): e is Extract<EngineEvent, { kind: 'call_usage' }> => e.kind === 'call_usage',
  )
  assert.ok(callUsage)
  assert.equal(callUsage.call.usage.inputTokens, 80)
  assert.equal(callUsage.call.usage.cacheReadTokens, 40)
  assert.equal(callUsage.call.usage.outputTokens, 30)
  await freshAdapter.shutdown()
})
