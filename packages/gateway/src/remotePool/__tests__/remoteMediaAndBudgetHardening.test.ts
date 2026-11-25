import assert from 'node:assert/strict'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  MODEL_AUTHORITY_VERSION,
  REMOTE_DRIVER_BACKEND,
  REMOTE_DRIVER_PROTOCOL_VERSION,
  authoritySigningInput,
  computeCostFen,
  encodeAuthorityEnvelope,
  encodeTurnLeaseEnvelope,
  turnLeaseSigningInput,
  type AuthorityKeyring,
  type ModelAuthorityPayload,
  type RemoteDriverAuthorityEngine,
  type RemoteDriverTurnContentBlock,
  type RemoteReceiptV4,
  type RemoteSecurityEvent,
  type TurnLease,
} from '@openclaude/protocol'
import type { OpenClaudeConfig } from '@openclaude/storage'
import { CREDIT_EXHAUSTED_DETAIL } from '../../creditExhaustion.js'
import type { EngineEvent } from '../../engine/engineEvents.js'
import type { EngineCreateOpts } from '../../engine/registry.js'
import { _setPlatformPricingLookupForTests } from '../../usageCost.js'
import { RemoteContainerLane } from '../containerLane.js'
import { DriverWorkerClient } from '../driverWorkerClient.js'
import { RemotePoolRelay, validateRemoteTurnContentBlocks } from '../relay.js'
import { RemoteEngineAdapter } from '../remoteEngineAdapter.js'
import {
  materializeTrustedImagePath,
  resolveTrustedMediaRoots,
} from '../remoteMediaMaterializer.js'
import { remoteV4ResumeId } from '../resumeId.js'
import {
  remotePoolBackendOf,
  type RemotePoolBinding,
  type RemotePoolFinancePort,
  type RemotePoolHostPort,
  type RemotePoolLaneSpec,
} from '../types.js'

// Valid 1x1 transparent PNG bytes.
const SAMPLE_PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2dIAAAAASUVORK5CYII=',
  'base64',
)
const SAMPLE_PNG_B64 = SAMPLE_PNG_BYTES.toString('base64')

const tempDirs: string[] = []
const workersToClose: DriverWorkerClient[] = []
const relaysToStop: RemotePoolRelay[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `oc-remote-b02-b04-${prefix}-`))
  tempDirs.push(dir)
  return dir
}

function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function makeTestKeypair(): {
  keyId: string
  keyring: AuthorityKeyring
  signTurn: (
    binding: Readonly<RemotePoolBinding>,
    opts?: { supportsVision?: boolean; billingRequestId?: string },
  ) => {
    authorityEnvelope: string
    leaseEnvelope: string
    authorityTurnId: string
    turnKey: string
    executionDescriptor: {
      readonly executionBackend: ReturnType<typeof remotePoolBackendOf>
      readonly canonicalModel: string
      readonly contextWindow: number | null
      readonly capabilityZero: boolean
      readonly supportsThinking: boolean
      readonly supportsVision: boolean
      readonly supportedEfforts: readonly string[]
    }
  }
} {
  const keyId = 'test-ed25519-k1'
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string }
  const rawPub = new Uint8Array(Buffer.from(jwk.x, 'base64url'))
  const keyring: AuthorityKeyring = new Map([[keyId, rawPub]])

  return {
    keyId,
    keyring,
    signTurn(binding, opts = {}) {
      const now = Date.now()
      const authorityTurnId = randomBytes(16).toString('hex')
      const turnKey = sha256Hex(`turn-key-${authorityTurnId}`)
      const executionBackend = remotePoolBackendOf(binding)
      const supportsVision = opts.supportsVision ?? true
      const payload: ModelAuthorityPayload = {
        v: MODEL_AUTHORITY_VERSION,
        keyId,
        uid: Number(binding.uid),
        containerId: Number(binding.containerDbId),
        authorityTurnId,
        connectionChallenge: 'conn-challenge-001',
        canonicalModel: binding.canonicalModel,
        engine: binding.authorityEngine,
        executionDescriptor: {
          capabilityProfile: {},
          capabilitySchemaVersion: 1,
          contextWindow: 200_000,
          supportedEfforts: ['low', 'medium', 'high'],
          supportsVision,
        },
        executionBackend,
        executionRevision: 'rev-1',
        securityEpoch: 1,
        issuedAt: now - 1_000,
        expiresAt: now + 60_000,
        ...(opts.billingRequestId ? { billingRequestId: opts.billingRequestId } : {}),
      }
      const lease: TurnLease = {
        v: MODEL_AUTHORITY_VERSION,
        keyId,
        uid: payload.uid,
        containerId: payload.containerId,
        authorityTurnId,
        canonicalModel: binding.canonicalModel,
        securityEpoch: 1,
        connectionChallenge: payload.connectionChallenge,
        issuedAt: now - 1_000,
        expiresAt: now + 30 * 60_000,
      }
      const authoritySig = sign(null, authoritySigningInput(payload), privateKey)
      const leaseSig = sign(null, turnLeaseSigningInput(lease), privateKey)
      return {
        authorityEnvelope: encodeAuthorityEnvelope(payload, authoritySig),
        leaseEnvelope: encodeTurnLeaseEnvelope(lease, leaseSig),
        authorityTurnId,
        turnKey,
        executionDescriptor: {
          executionBackend,
          canonicalModel: binding.canonicalModel,
          contextWindow: 200_000,
          capabilityZero: false,
          supportsThinking: true,
          supportsVision,
          supportedEfforts: ['low', 'medium', 'high'],
        },
      }
    },
  }
}

function makeBinding(overrides: Partial<RemotePoolBinding> = {}): RemotePoolBinding {
  const operationId = overrides.operationId ?? randomUUID()
  const runId = overrides.runId ?? randomUUID()
  const driverId = overrides.driverId ?? 'codex'
  const engineId = overrides.engineId ?? driverId
  const authorityEngine: RemoteDriverAuthorityEngine =
    overrides.authorityEngine ?? (driverId === 'cc' ? 'ccb' : 'codex')
  return {
    version: REMOTE_DRIVER_PROTOCOL_VERSION,
    backendKind: REMOTE_DRIVER_BACKEND,
    operationId,
    runId,
    uid: '1001',
    containerDbId: '42',
    dockerId: sha256Hex('docker-container-42'),
    sessionKey: 'agent:main:webchat:dm:hardening001',
    canonicalModel: driverId === 'cc' ? 'claude-opus-4-6-remote' : 'gpt-5.4-pro-remote',
    upstreamModel: driverId === 'cc' ? 'claude-opus-4-6' : 'gpt-5.4-pro',
    driverId,
    engineId,
    authorityEngine,
    driverVersion: '1.0.0',
    driverDigest: sha256Hex(`driver-digest-${driverId}`),
    coreDigest: sha256Hex('core-digest-v4'),
    probeFingerprint: sha256Hex('probe-fp-v4'),
    manifestSha256: sha256Hex('manifest-v4'),
    generation: '1',
    profileId: 'prof-1',
    authEpoch: 'epoch-1',
    capability: sha256Hex(`cap-${operationId}`),
    expiresAt: Date.now() + 3_600_000,
    ...overrides,
  }
}

function makeEngineCreateOpts(
  binding: Readonly<RemotePoolBinding>,
  agentBaseDir: string,
  extra: Partial<EngineCreateOpts> = {},
): EngineCreateOpts {
  return {
    sessionKey: binding.sessionKey,
    agentId: 'agent-main',
    agentBaseDir,
    config: {} as OpenClaudeConfig,
    model: binding.canonicalModel,
    executionBackend: remotePoolBackendOf(binding),
    ...extra,
  }
}

function makeStubLaneToolOptions(cwd: string) {
  return {
    executionRoot: makeTempDir('exec-root'),
    platformPrompt: 'test platform prompt',
    toolContextFactory: async () => ({
      profile: {
        cwd,
        mcpConfigPath: null,
        settingsPath: null,
        disallowedTools: [],
      },
      env: {},
      platformPrompt: 'test platform prompt',
      promptCwd: cwd,
      cleanup: () => {},
    }),
    hostFactory: () => ({
      tools: async () => [
        {
          name: 'Read',
          description: 'Read a file',
          inputSchema: { type: 'object', properties: { file_path: { type: 'string' } } },
        },
      ],
      execute: async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }),
      close: async () => {},
    }),
  }
}

interface FakeProcHandle {
  readonly proc: ChildProcessWithoutNullStreams
  readonly writeStdoutLine: (obj: Record<string, unknown>) => void
  readonly receivedStdinLines: string[]
}

function createFakeChildProcess(onStdinLine?: (line: string) => void): FakeProcHandle {
  const emitter = new EventEmitter() as EventEmitter & {
    stdin: PassThrough
    stdout: PassThrough
    stderr: PassThrough
    killed: boolean
    kill: () => boolean
  }
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const receivedStdinLines: string[] = []
  let stdinBuf = ''
  stdin.on('data', (chunk: Buffer) => {
    stdinBuf += chunk.toString('utf8')
    let idx: number
    while ((idx = stdinBuf.indexOf('\n')) >= 0) {
      const line = stdinBuf.slice(0, idx)
      stdinBuf = stdinBuf.slice(idx + 1)
      if (!line) continue
      receivedStdinLines.push(line)
      onStdinLine?.(line)
    }
  })

  emitter.stdin = stdin
  emitter.stdout = stdout
  emitter.stderr = stderr
  emitter.killed = false
  emitter.kill = () => {
    if (!emitter.killed) {
      emitter.killed = true
      stdout.end()
      stderr.end()
      emitter.emit('close', 0, 'SIGKILL')
    }
    return true
  }

  return {
    proc: emitter as unknown as ChildProcessWithoutNullStreams,
    writeStdoutLine(obj: Record<string, unknown>) {
      stdout.write(`${JSON.stringify(obj)}\n`)
    },
    receivedStdinLines,
  }
}

function makeFakeRelaySpec(
  binding: Readonly<RemotePoolBinding>,
  root: string,
  nativeSessionId?: string | null,
): RemotePoolLaneSpec {
  return {
    controllerPath: '/opt/openclaude/controller.py',
    controllerSha256: sha256Hex('controller'),
    manifest: {
      version: 4,
      root,
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
      ...(nativeSessionId ? { nativeSessionId } : {}),
    },
    driverContext: {},
    verifiedProbe: {
      schemaVersion: 4,
      engineId: binding.engineId,
      driverId: binding.driverId,
      driverVersion: binding.driverVersion,
      source: 'codex-app-server:model/list',
      freshness: 'cli-observed',
      authPresent: true,
      accountObserved: true,
      cliVersion: '0.175.0',
      cliSha256: sha256Hex('cli'),
      models: [
        {
          upstreamModelId: binding.upstreamModel,
          displayName: binding.upstreamModel,
          supportedEfforts: ['low', 'medium', 'high'],
          defaultEffort: 'medium',
          supportsAdaptiveThinking: false,
          supportsVision: true,
        },
      ],
      rawResponseSha256: sha256Hex('probe-raw'),
      observedAt: '2026-11-25T00:00:00Z',
    },
  }
}

let testKeepalive: ReturnType<typeof setInterval> | null = null

beforeEach(() => {
  testKeepalive = setInterval(() => {}, 250)
})

afterEach(async () => {
  if (testKeepalive !== null) {
    clearInterval(testKeepalive)
    testKeepalive = null
  }
  _setPlatformPricingLookupForTests(null)
  while (relaysToStop.length > 0) {
    const relay = relaysToStop.pop()!
    await relay.stop().catch(() => {})
  }
  while (workersToClose.length > 0) {
    const w = workersToClose.pop()!
    await w.close().catch(() => {})
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('B02: remote multimodal path image materialization & relay defense-in-depth', () => {
  it('materializes trusted PNG path to inline base64 data, strips path before dispatch, and passes real cc.py & codex.py encoders', async () => {
    const trustedDir = makeTempDir('trusted-media')
    const pngPath = join(trustedDir, 'diagram.png')
    writeFileSync(pngPath, SAMPLE_PNG_BYTES)

    const keys = makeTestKeypair()
    const binding = makeBinding({ driverId: 'cc', engineId: 'cc', authorityEngine: 'ccb' })
    const signed = keys.signTurn(binding, { supportsVision: true })

    const relayCalls: Array<{ path: string; body: Readonly<Record<string, unknown>> }> = []
    let commandContent: unknown
    let seq = 0

    const lane = new RemoteContainerLane(makeEngineCreateOpts(binding, trustedDir), {
      binding,
      keyring: keys.keyring,
      trustedMediaRoots: [trustedDir],
      ...makeStubLaneToolOptions(trustedDir),
      call: async (path, body) => {
        relayCalls.push({ path, body })
        if (path === '/admit') {
          return { ok: true, ready: true, seq: 0, nativeSessionId: 'cc-sess-001' }
        }
        if (path === '/command') {
          const cmd = body.command as Record<string, unknown>
          if (cmd.kind === 'newTurn') {
            commandContent = cmd.content
          }
          return { ok: true, dispatched: true }
        }
        if (path === '/poll') {
          seq += 1
          const receipt = {
            version: 4,
            backendKind: REMOTE_DRIVER_BACKEND,
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
            authorityTurnId: signed.authorityTurnId,
            turnKey: signed.turnKey,
            requestId: 'req-b02-1',
            nativeSessionId: 'cc-sess-001',
            terminalId: 'term-b02-1',
            usageSemantics: 'cc-result-per-turn-v1',
            usageMode: 'per_turn',
            countersBaseline: null,
            countersFinal: { input_tokens: 100, output_tokens: 20 },
            usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
            status: 'success',
            nativeStatus: 'success',
            rawEvidenceDigest: sha256Hex('ev'),
            semanticDigest: sha256Hex('sem'),
            provenance: {
              generation: binding.generation,
              manifestHash: binding.manifestSha256,
              coreDigest: binding.coreDigest,
              probeFingerprint: binding.probeFingerprint,
            },
            receiptDigest: sha256Hex('rcpt'),
          } as RemoteReceiptV4
          return {
            ok: true,
            frames: [
              {
                seq,
                frame: {
                  kind: 'turn_settled',
                  receipt,
                  outcome: { state: 'proven', requestId: 'req-b02-1' },
                },
              },
            ],
          }
        }
        if (path === '/tool/next') return { ok: true }
        if (path === '/stop') return { ok: true, remoteStopped: true }
        if (path === '/tool/stopped') return { ok: true }
        return { ok: true }
      },
    })

    const validated = lane.validateTurnSubmission({
      input: [
        { type: 'text', text: 'Describe this architecture chart' },
        { type: 'image', path: pngPath },
      ],
      turnKey: signed.turnKey,
      modelAuthority: {
        authorityEnvelope: signed.authorityEnvelope,
        leaseEnvelope: signed.leaseEnvelope,
        executionDescriptor: signed.executionDescriptor,
      },
      onEvent: () => {},
      sessionTotals: { totalCostUSD: 0, turns: 0 },
      toolUseIdToName: new Map(),
    })

    const outcome = await lane.executeTurn(validated, {
      onNativeSession: () => {},
      onSubmitted: () => {},
      onSecurityEvent: () => {},
      onPresentationItem: () => {},
    })

    assert.equal(outcome.kind, 'settled')
    assert.ok(relayCalls.some((c) => c.path === '/command'))
    assert.ok(Array.isArray(commandContent), 'newTurn must carry materialized content blocks')
    const blocks = commandContent as RemoteDriverTurnContentBlock[]
    assert.equal(blocks.length, 2)
    assert.deepEqual(blocks[0], { type: 'text', text: 'Describe this architecture chart' })
    assert.deepEqual(blocks[1], {
      type: 'image',
      mimeType: 'image/png',
      data: SAMPLE_PNG_B64,
    })
    assert.equal(
      Object.prototype.hasOwnProperty.call(blocks[1], 'path'),
      false,
      'source container path must be stripped before dispatch',
    )

    // Verify materialized blocks pass BOTH real Python encoders (`cc.py` and `codex.py`).
    const worker = new DriverWorkerClient()
    workersToClose.push(worker)

    const ccEncoded = await worker.encode(
      'cc',
      {
        kind: 'newTurn',
        commandId: 'cmd-cc-b02-1',
        model: 'claude-opus-4-6',
        prompt: 'Describe this architecture chart',
        nativeSessionId: 'cc-sess-001',
        content: blocks,
      },
      {
        initialized: true,
        sessionId: 'cc-sess-001',
        expectedModel: 'claude-opus-4-6',
      },
    )
    assert.equal(ccEncoded.lines.length, 1)
    const ccWire = JSON.parse(ccEncoded.lines[0]!) as {
      type: string
      message: { content: Array<Record<string, unknown>> }
    }
    assert.equal(ccWire.type, 'user')
    assert.deepEqual(ccWire.message.content[1], {
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: SAMPLE_PNG_B64,
      },
    })

    const codexEncoded = await worker.encode(
      'codex',
      {
        kind: 'newTurn',
        commandId: 'cmd-codex-b02-1',
        model: 'gpt-5.4-pro',
        prompt: 'Describe this architecture chart',
        nativeSessionId: 'thr-codex-001',
        content: blocks,
      },
      {
        initialized: true,
        sessionId: 'thr-codex-001',
        expectedModel: 'gpt-5.4-pro',
        cliVersion: '0.175.0',
      },
    )
    assert.equal(codexEncoded.lines.length, 1)
    const codexWire = JSON.parse(codexEncoded.lines[0]!) as {
      method: string
      params: { input: Array<Record<string, unknown>> }
    }
    assert.equal(codexWire.method, 'turn/start')
    assert.deepEqual(codexWire.params.input[1], {
      type: 'image',
      url: `data:image/png;base64,${SAMPLE_PNG_B64}`,
    })
  })

  it('fails closed BEFORE admit/dispatch on untrusted root, traversal, symlink escape, missing file, non-image magic, MIME mismatch, and size limit', async () => {
    const trustedDir = makeTempDir('trusted-root')
    const outsideDir = makeTempDir('outside-root')

    const outsidePng = join(outsideDir, 'secret.png')
    writeFileSync(outsidePng, SAMPLE_PNG_BYTES)

    const symlinkFile = join(trustedDir, 'link-secret.png')
    symlinkSync(outsidePng, symlinkFile)

    const symlinkDir = join(trustedDir, 'escaped-subdir')
    symlinkSync(outsideDir, symlinkDir)
    const viaSymlinkDir = join(symlinkDir, 'secret.png')

    const nonImagePath = join(trustedDir, 'not-an-image.png')
    writeFileSync(nonImagePath, 'plain text pretending to be png', 'utf8')

    const validPng = join(trustedDir, 'valid.png')
    writeFileSync(validPng, SAMPLE_PNG_BYTES)

    const largePng = join(trustedDir, 'oversized.png')
    writeFileSync(largePng, Buffer.concat([SAMPLE_PNG_BYTES, Buffer.alloc(512, 0x41)]))

    const cases: Array<{
      readonly name: string
      readonly inputBlock: { type: string; [k: string]: unknown }
      readonly maxImageBytes?: number
      readonly expectedCode: string
    }> = [
      {
        name: 'outside trustedMediaRoots',
        inputBlock: { type: 'image', mimeType: 'image/png', path: outsidePng },
        expectedCode: 'REMOTE_IMAGE_PATH_UNTRUSTED',
      },
      {
        name: 'path traversal segments',
        inputBlock: {
          type: 'image',
          mimeType: 'image/png',
          path: `${trustedDir}/../outside/secret.png`,
        },
        expectedCode: 'REMOTE_IMAGE_PATH_TRAVERSAL',
      },
      {
        name: 'file symlink escape',
        inputBlock: { type: 'image', mimeType: 'image/png', path: symlinkFile },
        expectedCode: 'REMOTE_IMAGE_PATH_SYMLINK_FORBIDDEN',
      },
      {
        name: 'parent directory symlink escape',
        inputBlock: { type: 'image', mimeType: 'image/png', path: viaSymlinkDir },
        expectedCode: 'REMOTE_IMAGE_PATH_SYMLINK_FORBIDDEN',
      },
      {
        name: 'non-existent file inside trusted root',
        inputBlock: {
          type: 'image',
          mimeType: 'image/png',
          path: join(trustedDir, 'missing.png'),
        },
        expectedCode: 'REMOTE_IMAGE_PATH_UNREADABLE',
      },
      {
        name: 'non-image magic bytes',
        inputBlock: { type: 'image', mimeType: 'image/png', path: nonImagePath },
        expectedCode: 'REMOTE_IMAGE_INVALID_FORMAT',
      },
      {
        name: 'explicit MIME mismatch against magic bytes',
        inputBlock: { type: 'image', mimeType: 'image/jpeg', path: validPng },
        expectedCode: 'REMOTE_IMAGE_MIME_MISMATCH',
      },
      {
        name: 'oversized image exceeds maxImageBytes',
        inputBlock: { type: 'image', mimeType: 'image/png', path: largePng },
        maxImageBytes: 256,
        expectedCode: 'REMOTE_IMAGE_PAYLOAD_TOO_LARGE',
      },
    ]

    for (const tc of cases) {
      const keys = makeTestKeypair()
      const binding = makeBinding({ driverId: 'codex', engineId: 'codex', authorityEngine: 'codex' })
      const signed = keys.signTurn(binding, { supportsVision: true })
      const relayCalls: string[] = []
      let submittedCalled = false

      const lane = new RemoteContainerLane(makeEngineCreateOpts(binding, trustedDir), {
        binding,
        keyring: keys.keyring,
        trustedMediaRoots: [trustedDir],
        maxImageBytes: tc.maxImageBytes,
        ...makeStubLaneToolOptions(trustedDir),
        call: async (path) => {
          relayCalls.push(path)
          return { ok: true }
        },
      })

      const validated = lane.validateTurnSubmission({
        input: [{ type: 'text', text: 'check image' }, tc.inputBlock],
        turnKey: signed.turnKey,
        modelAuthority: {
          authorityEnvelope: signed.authorityEnvelope,
          leaseEnvelope: signed.leaseEnvelope,
          executionDescriptor: signed.executionDescriptor,
        },
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })

      await assert.rejects(
        () =>
          lane.executeTurn(validated, {
            onNativeSession: () => {},
            onSubmitted: () => {
              submittedCalled = true
            },
            onSecurityEvent: () => {},
            onPresentationItem: () => {},
          }),
        { message: tc.expectedCode },
        `case failed: ${tc.name}`,
      )
      assert.equal(
        relayCalls.length,
        0,
        `relay must NEVER be called before materialization passes (${tc.name})`,
      )
      assert.equal(submittedCalled, false, `onSubmitted must not fire (${tc.name})`)
    }

    // Direct helper check: empty trusted roots fails closed.
    assert.throws(
      () =>
        materializeTrustedImagePath(validPng, {
          trustedMediaRoots: [],
          declaredMimeType: 'image/png',
        }),
      { message: 'REMOTE_IMAGE_PATH_UNTRUSTED' },
    )
  })

  it('rejects symlinked media roots themselves (auto-discovered uploads/promptCwd/baseHome and explicit roots) before admit/dispatch', async () => {
    const approvedBase = makeTempDir('approved-base')
    const approvedWorkspace = join(approvedBase, 'workspace')
    mkdirSync(approvedWorkspace, { recursive: true })
    const approvedPng = join(approvedWorkspace, 'in-scope.png')
    writeFileSync(approvedPng, SAMPLE_PNG_BYTES)

    const outsideDir = makeTempDir('outside-media')
    const outsidePng = join(outsideDir, 'out-of-scope.png')
    writeFileSync(outsidePng, SAMPLE_PNG_BYTES)

    // Symlinked auto-discovered `uploads` root pointing outside approvedBase.
    const symlinkUploads = join(approvedBase, 'uploads')
    symlinkSync(outsideDir, symlinkUploads)

    // Symlinked `agentBaseDir` / `promptCwd` pointing outside approvedBase.
    const symlinkPromptCwd = join(approvedBase, 'prompt-cwd-link')
    symlinkSync(outsideDir, symlinkPromptCwd)

    // Symlinked `baseHome` whose target contains a real `uploads` directory.
    const outsideHome = makeTempDir('outside-home')
    const outsideHomeUploads = join(outsideHome, 'uploads')
    mkdirSync(outsideHomeUploads, { recursive: true })
    const outsideHomePng = join(outsideHomeUploads, 'home-secret.png')
    writeFileSync(outsideHomePng, SAMPLE_PNG_BYTES)
    const symlinkBaseHome = join(approvedBase, 'home-link')
    symlinkSync(outsideHome, symlinkBaseHome)

    // 1) Auto-discovery must drop symlinked `uploads`, symlinked `promptCwd`, and symlinked `baseHome`.
    const discoveredFromApproved = resolveTrustedMediaRoots({
      agentBaseDir: approvedWorkspace,
      promptCwd: symlinkPromptCwd,
      env: { OPENCLAUDE_HOME: approvedBase },
    })
    assert.equal(discoveredFromApproved.includes(approvedWorkspace), true)
    assert.equal(discoveredFromApproved.includes(symlinkUploads), false)
    assert.equal(discoveredFromApproved.includes(symlinkPromptCwd), false)
    assert.equal(discoveredFromApproved.includes(outsideDir), false)

    const discoveredFromSymlinkHome = resolveTrustedMediaRoots({
      env: { OPENCLAUDE_HOME: symlinkBaseHome },
    })
    assert.equal(discoveredFromSymlinkHome.includes(join(symlinkBaseHome, 'uploads')), false)
    assert.equal(discoveredFromSymlinkHome.includes(outsideHomeUploads), false)

    // 2) Positive control: normal in-scope PNG under approvedWorkspace succeeds (admit=1, dispatch=1).
    {
      const keys = makeTestKeypair()
      const binding = makeBinding({ driverId: 'codex', engineId: 'codex', authorityEngine: 'codex' })
      const signed = keys.signTurn(binding, { supportsVision: true })
      let admitCalls = 0
      let dispatchCalls = 0
      let seq = 0

      const lane = new RemoteContainerLane(makeEngineCreateOpts(binding, approvedWorkspace), {
        binding,
        keyring: keys.keyring,
        ...makeStubLaneToolOptions(approvedWorkspace),
        call: async (path, body) => {
          if (path === '/admit') {
            admitCalls += 1
            return { ok: true, ready: true, seq: 0, nativeSessionId: 'thr-root-ok' }
          }
          if (path === '/command') {
            const cmd = body.command as Record<string, unknown>
            if (cmd.kind === 'newTurn') {
              dispatchCalls += 1
              const content = cmd.content as RemoteDriverTurnContentBlock[]
              assert.deepEqual(content[1], {
                type: 'image',
                mimeType: 'image/png',
                data: SAMPLE_PNG_B64,
              })
              assert.equal(Object.prototype.hasOwnProperty.call(content[1], 'path'), false)
            }
            return { ok: true, dispatched: true }
          }
          if (path === '/poll') {
            seq += 1
            const receipt = {
              version: 4,
              backendKind: REMOTE_DRIVER_BACKEND,
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
              authorityTurnId: signed.authorityTurnId,
              turnKey: signed.turnKey,
              requestId: 'req-root-ok',
              nativeSessionId: 'thr-root-ok',
              terminalId: 'term-root-ok',
              usageSemantics: 'codex-0.167-total-v1',
              usageMode: 'cumulative',
              countersBaseline: {
                inputTokens: 0,
                cachedInputTokens: 0,
                cacheWriteInputTokens: 0,
                outputTokens: 0,
                reasoningOutputTokens: 0,
              },
              countersFinal: {
                inputTokens: 100,
                cachedInputTokens: 0,
                cacheWriteInputTokens: 0,
                outputTokens: 20,
                reasoningOutputTokens: 0,
              },
              usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
              status: 'success',
              nativeStatus: 'success',
              rawEvidenceDigest: sha256Hex('ev-root-ok'),
              semanticDigest: sha256Hex('sem-root-ok'),
              provenance: {
                generation: binding.generation,
                manifestHash: binding.manifestSha256,
                coreDigest: binding.coreDigest,
                probeFingerprint: binding.probeFingerprint,
              },
              receiptDigest: sha256Hex('rcpt-root-ok'),
            } as RemoteReceiptV4
            return {
              ok: true,
              frames: [
                {
                  seq,
                  frame: {
                    kind: 'turn_settled',
                    receipt,
                    outcome: { state: 'proven', requestId: 'req-root-ok' },
                  },
                },
              ],
            }
          }
          if (path === '/tool/next') return { ok: true }
          if (path === '/stop') return { ok: true, remoteStopped: true }
          if (path === '/tool/stopped') return { ok: true }
          return { ok: true }
        },
      })

      const validated = lane.validateTurnSubmission({
        input: [
          { type: 'text', text: 'read approved image' },
          { type: 'image', mimeType: 'image/png', path: approvedPng },
        ],
        turnKey: signed.turnKey,
        modelAuthority: {
          authorityEnvelope: signed.authorityEnvelope,
          leaseEnvelope: signed.leaseEnvelope,
          executionDescriptor: signed.executionDescriptor,
        },
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })

      const outcome = await lane.executeTurn(validated, {
        onNativeSession: () => {},
        onSubmitted: () => {},
        onSecurityEvent: () => {},
        onPresentationItem: () => {},
      })
      assert.equal(outcome.kind, 'settled')
      assert.equal(admitCalls, 1)
      assert.equal(dispatchCalls, 1)
    }

    // 3) Negative controls: symlinked root alias (uploads -> outsideDir, promptCwd -> outsideDir,
    //    explicit trustedMediaRoots containing a symlink) MUST fail closed before admit/dispatch.
    const negativeCases: Array<{
      readonly label: string
      readonly agentBaseDir: string
      readonly trustedMediaRoots?: readonly string[]
      readonly imagePath: string
    }> = [
      {
        label: 'auto-discovered symlinked agentBaseDir/promptCwd via alias path',
        agentBaseDir: symlinkPromptCwd,
        imagePath: join(symlinkPromptCwd, 'out-of-scope.png'),
      },
      {
        label: 'auto-discovered symlinked agentBaseDir/promptCwd via resolved target path',
        agentBaseDir: symlinkPromptCwd,
        imagePath: outsidePng,
      },
      {
        label: 'auto-discovered symlinked uploads root via alias path',
        agentBaseDir: approvedWorkspace,
        trustedMediaRoots: discoveredFromApproved,
        imagePath: join(symlinkUploads, 'out-of-scope.png'),
      },
      {
        label: 'explicit trustedMediaRoots containing symlinked uploads root via alias path',
        agentBaseDir: approvedWorkspace,
        trustedMediaRoots: [symlinkUploads],
        imagePath: join(symlinkUploads, 'out-of-scope.png'),
      },
      {
        label: 'explicit trustedMediaRoots containing symlinked uploads root via real target path',
        agentBaseDir: approvedWorkspace,
        trustedMediaRoots: [symlinkUploads],
        imagePath: outsidePng,
      },
      {
        label: 'symlinked baseHome uploads via discovered roots',
        agentBaseDir: approvedWorkspace,
        trustedMediaRoots: discoveredFromSymlinkHome,
        imagePath: join(symlinkBaseHome, 'uploads', 'home-secret.png'),
      },
    ]

    for (const nc of negativeCases) {
      const keys = makeTestKeypair()
      const binding = makeBinding({ driverId: 'codex', engineId: 'codex', authorityEngine: 'codex' })
      const signed = keys.signTurn(binding, { supportsVision: true })
      let admitCalls = 0
      let dispatchCalls = 0
      let submittedCalled = false

      const lane = new RemoteContainerLane(makeEngineCreateOpts(binding, nc.agentBaseDir), {
        binding,
        keyring: keys.keyring,
        ...(nc.trustedMediaRoots !== undefined ? { trustedMediaRoots: nc.trustedMediaRoots } : {}),
        ...makeStubLaneToolOptions(approvedWorkspace),
        call: async (path, body) => {
          if (path === '/admit') admitCalls += 1
          if (path === '/command' && (body.command as Record<string, unknown>)?.kind === 'newTurn') {
            dispatchCalls += 1
          }
          return { ok: true }
        },
      })

      const validated = lane.validateTurnSubmission({
        input: [
          { type: 'text', text: 'attempt symlink root escape' },
          { type: 'image', mimeType: 'image/png', path: nc.imagePath },
        ],
        turnKey: signed.turnKey,
        modelAuthority: {
          authorityEnvelope: signed.authorityEnvelope,
          leaseEnvelope: signed.leaseEnvelope,
          executionDescriptor: signed.executionDescriptor,
        },
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })

      await assert.rejects(
        () =>
          lane.executeTurn(validated, {
            onNativeSession: () => {},
            onSubmitted: () => {
              submittedCalled = true
            },
            onSecurityEvent: () => {},
            onPresentationItem: () => {},
          }),
        { message: 'REMOTE_IMAGE_PATH_UNTRUSTED' },
        `symlink root case must fail closed: ${nc.label}`,
      )
      assert.equal(admitCalls, 0, `admitCalls must be 0 (${nc.label})`)
      assert.equal(dispatchCalls, 0, `dispatchCalls must be 0 (${nc.label})`)
      assert.equal(submittedCalled, false, `onSubmitted must not fire (${nc.label})`)
    }
  })

  it('relay.ts defense-in-depth rejects raw path images fail-closed before beforeDispatch or driver encode', async () => {
    // 1) Direct validator assertions
    assert.throws(
      () =>
        validateRemoteTurnContentBlocks([
          { type: 'text', text: 'hello' },
          { type: 'image', mimeType: 'image/png', path: '/etc/passwd' },
        ]),
      { message: 'REMOTE_IMAGE_PATH_UNSUPPORTED' },
    )
    assert.throws(
      () =>
        validateRemoteTurnContentBlocks([
          { type: 'image', mimeType: 'image/png', data: SAMPLE_PNG_B64, path: '/tmp/leak.png' },
        ]),
      { message: 'REMOTE_IMAGE_PATH_UNSUPPORTED' },
    )
    assert.throws(
      () =>
        validateRemoteTurnContentBlocks([
          { type: 'image', mimeType: 'image/png', blobId: 'blob-1' },
        ]),
      { message: 'REMOTE_IMAGE_BLOB_UNRESOLVED' },
    )
    assert.deepEqual(
      validateRemoteTurnContentBlocks([
        { type: 'text', text: 'ok' },
        { type: 'image', mimeType: 'image/png', data: SAMPLE_PNG_B64 },
      ]),
      [
        { type: 'text', text: 'ok' },
        { type: 'image', mimeType: 'image/png', data: SAMPLE_PNG_B64 },
      ],
    )

    // 2) Full RemotePoolRelay /command defense-in-depth check
    const worker = new DriverWorkerClient()
    workersToClose.push(worker)
    const info = await worker.info('codex')
    const binding = makeBinding({
      driverId: 'codex',
      engineId: 'codex',
      authorityEngine: 'codex',
      driverVersion: info.driverVersion,
      driverDigest: info.driverDigest,
      coreDigest: info.coreDigest,
    })
    const keys = makeTestKeypair()
    const signed = keys.signTurn(binding, { supportsVision: true, billingRequestId: 'req-relay-b02' })
    const spec = makeFakeRelaySpec(binding, makeTempDir('relay-root'))

    let appSeq = 0
    let frameSeq = 0
    let beforeDispatchCalls = 0
    let newTurnReceivedByApp = false

    const emitAppStdout = (proc: FakeProcHandle, nativePayload: Record<string, unknown>) => {
      const raw = Buffer.from(JSON.stringify(nativePayload), 'utf8')
      proc.writeStdoutLine({
        version: 4,
        seq: ++appSeq,
        driverId: binding.driverId,
        engineId: binding.engineId,
        operationId: binding.operationId,
        runId: binding.runId,
        generation: binding.generation,
        profileId: binding.profileId,
        authEpoch: binding.authEpoch,
        kind: 'stdout',
        frameSeq: ++frameSeq,
        frameSha256: sha256Hex(raw),
        rawB64: raw.toString('base64'),
      })
    }

    const host: RemotePoolHostPort = {
      preflight: async () => ({ memoryOk: true, activeSessions: 0 }),
      provision: async () => {},
      open(role) {
        if (role === 'tool-socket') {
          const sock = createFakeChildProcess()
          setImmediate(() => {
            sock.writeStdoutLine({
              version: 4,
              driverId: binding.driverId,
              engineId: binding.engineId,
              kind: 'socket-ready',
              operationId: binding.operationId,
              runId: binding.runId,
              generation: binding.generation,
            })
          })
          return sock.proc
        }
        let rpcId = 0
        const app = createFakeChildProcess((line) => {
          const msg = JSON.parse(line) as { kind: string; command: Record<string, unknown> }
          if (msg.kind !== 'command') return
          if (msg.command.kind === 'initialize') {
            rpcId += 1
            emitAppStdout(app, { id: rpcId, result: { userAgent: 'codex/0.175.0' } })
          } else if (msg.command.kind === 'resume') {
            rpcId += 1
            emitAppStdout(app, {
              id: rpcId,
              result: { thread: { id: 'thr-b02-defense' }, model: binding.upstreamModel },
            })
          } else if (msg.command.kind === 'newTurn') {
            newTurnReceivedByApp = true
          }
        })
        setImmediate(() => {
          app.writeStdoutLine({
            version: 4,
            seq: ++appSeq,
            driverId: binding.driverId,
            engineId: binding.engineId,
            operationId: binding.operationId,
            runId: binding.runId,
            generation: binding.generation,
            profileId: binding.profileId,
            authEpoch: binding.authEpoch,
            kind: 'ready',
          })
        })
        return app.proc
      },
      stop: async () => ({ remoteStopped: true }),
    }

    const finance: RemotePoolFinancePort = {
      admit: async () => ({
        requestId: 'req-relay-b02',
        beforeHostStart: async () => {},
        beforeDispatch: async () => {
          beforeDispatchCalls += 1
        },
        bindNativeThread: async () => ({
          inputTokens: 0,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
        }),
        abandonUndispatched: async () => ({ state: 'proven', requestId: 'req-relay-b02' }),
        terminal: async () => ({ state: 'proven', requestId: 'req-relay-b02' }),
        stop: async () => {},
      }),
    }

    const relay = new RemotePoolRelay({
      binding,
      keys: keys.keyring,
      host,
      spec,
      journalDir: makeTempDir('relay-journal-b02'),
      finance,
      worker,
    })
    relaysToStop.push(relay)

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

    const admitRes = await relay.handleControl('/admit', {
      ...scope,
      authority: signed.authorityEnvelope,
      lease: signed.leaseEnvelope,
      turnKey: signed.turnKey,
      catalog: {
        tools: [{ name: 'Read', description: 'Read file', inputSchema: { type: 'object' } }],
      },
    })
    assert.equal(admitRes.ready, true)

    await assert.rejects(
      () =>
        relay.handleControl('/command', {
          ...scope,
          command: {
            kind: 'newTurn',
            commandId: 'cmd-raw-path-1',
            model: binding.upstreamModel,
            prompt: 'read image',
            nativeSessionId: 'thr-b02-defense',
            content: [
              { type: 'text', text: 'read image' },
              { type: 'image', mimeType: 'image/png', path: '/home/agent/secret.png' },
            ],
          },
        }),
      { message: 'REMOTE_IMAGE_PATH_UNSUPPORTED' },
    )

    assert.equal(beforeDispatchCalls, 0, 'beforeDispatch must not run for rejected raw path')
    assert.equal(newTurnReceivedByApp, false, 'raw path command must never reach remote app')
  })
})

describe('B04: resumed cumulative thread budget guard inherits authoritative baseline across independent adapter instances', () => {
  interface ScriptedCodexTurn {
    readonly turnId: string
    readonly cumulativeCounters: {
      readonly inputTokens: number
      readonly cachedInputTokens: number
      readonly cacheWriteInputTokens: number
      readonly outputTokens: number
      readonly reasoningOutputTokens: number
    }
    readonly emitResumeReplay?: Readonly<Record<string, number>>
    readonly settleDelayMs?: number
    readonly answerText?: string
  }

  function createAuthoritativeCodexFinanceStore(): {
    readonly finance: RemotePoolFinancePort
    readonly baselinesByThread: Map<string, Readonly<Record<string, number>>>
    readonly settledReceipts: RemoteReceiptV4[]
  } {
    const baselinesByThread = new Map<string, Readonly<Record<string, number>>>()
    const settledReceipts: RemoteReceiptV4[] = []
    let reqSeq = 0

    const finance: RemotePoolFinancePort = {
      admit: async () => {
        const requestId = `req-b04-${++reqSeq}`
        return {
          requestId,
          beforeHostStart: async () => {},
          beforeDispatch: async () => {},
          bindNativeThread: async (nativeSessionId, newlyCreated) => {
            const existing = baselinesByThread.get(nativeSessionId)
            if (existing) return existing
            const zero = Object.freeze({
              inputTokens: 0,
              cachedInputTokens: 0,
              cacheWriteInputTokens: 0,
              outputTokens: 0,
              reasoningOutputTokens: 0,
            })
            if (newlyCreated) {
              baselinesByThread.set(nativeSessionId, zero)
            }
            return zero
          },
          abandonUndispatched: async () => ({ state: 'proven', requestId }),
          terminal: async (receipt) => {
            settledReceipts.push(receipt)
            baselinesByThread.set(receipt.nativeSessionId, Object.freeze({ ...receipt.countersFinal }))
            return { state: 'proven', requestId }
          },
          stop: async () => {},
        }
      },
    }

    return { finance, baselinesByThread, settledReceipts }
  }

  async function createCodexRelayAndAdapter(input: {
    readonly worker: DriverWorkerClient
    readonly keys: ReturnType<typeof makeTestKeypair>
    readonly finance: RemotePoolFinancePort
    readonly threadId: string
    readonly preboundNativeSessionId?: string
    readonly turnScript: ScriptedCodexTurn
    readonly workspaceDir: string
    readonly resumeSessionId?: string
  }): Promise<{
    readonly binding: RemotePoolBinding
    readonly relay: RemotePoolRelay
    readonly adapter: RemoteEngineAdapter
    readonly interruptsSeen: () => number
  }> {
    const info = await input.worker.info('codex')
    const binding = makeBinding({
      driverId: 'codex',
      engineId: 'codex',
      authorityEngine: 'codex',
      driverVersion: info.driverVersion,
      driverDigest: info.driverDigest,
      coreDigest: info.coreDigest,
    })
    const spec = makeFakeRelaySpec(
      binding,
      makeTempDir('codex-relay-root'),
      input.preboundNativeSessionId,
    )

    let appSeq = 0
    let frameSeq = 0
    let rpcId = 0
    let interruptCount = 0
    let completed = false

    const emitAppStdout = (proc: FakeProcHandle, nativePayload: Record<string, unknown>) => {
      const raw = Buffer.from(JSON.stringify(nativePayload), 'utf8')
      proc.writeStdoutLine({
        version: 4,
        seq: ++appSeq,
        driverId: binding.driverId,
        engineId: binding.engineId,
        operationId: binding.operationId,
        runId: binding.runId,
        generation: binding.generation,
        profileId: binding.profileId,
        authEpoch: binding.authEpoch,
        kind: 'stdout',
        frameSeq: ++frameSeq,
        frameSha256: sha256Hex(raw),
        rawB64: raw.toString('base64'),
      })
    }

    const host: RemotePoolHostPort = {
      preflight: async () => ({ memoryOk: true, activeSessions: 0 }),
      provision: async () => {},
      open(role) {
        if (role === 'tool-socket') {
          const sock = createFakeChildProcess()
          setImmediate(() => {
            sock.writeStdoutLine({
              version: 4,
              driverId: binding.driverId,
              engineId: binding.engineId,
              kind: 'socket-ready',
              operationId: binding.operationId,
              runId: binding.runId,
              generation: binding.generation,
            })
          })
          return sock.proc
        }
        const app = createFakeChildProcess((line) => {
          const msg = JSON.parse(line) as { kind: string; command: Record<string, unknown> }
          if (msg.kind !== 'command') return
          const kind = msg.command.kind
          if (kind === 'initialize') {
            rpcId += 1
            emitAppStdout(app, { id: rpcId, result: { userAgent: 'codex/0.175.0' } })
          } else if (kind === 'resume') {
            rpcId += 1
            if (input.turnScript.emitResumeReplay) {
              const r = input.turnScript.emitResumeReplay
              emitAppStdout(app, {
                method: 'thread/tokenUsage/updated',
                params: {
                  threadId: input.threadId,
                  tokenUsage: {
                    total: {
                      inputTokens: r.inputTokens,
                      cachedInputTokens: r.cachedInputTokens,
                      cacheWriteInputTokens: r.cacheWriteInputTokens ?? 0,
                      outputTokens: r.outputTokens,
                      reasoningOutputTokens: r.reasoningOutputTokens ?? 0,
                      totalTokens: (r.inputTokens ?? 0) + (r.outputTokens ?? 0),
                    },
                  },
                },
              })
            }
            emitAppStdout(app, {
              id: rpcId,
              result: { thread: { id: input.threadId }, model: binding.upstreamModel },
            })
          } else if (kind === 'newTurn') {
            rpcId += 1
            const turnId = input.turnScript.turnId
            emitAppStdout(app, { id: rpcId, result: { turn: { id: turnId } } })
            emitAppStdout(app, {
              method: 'item/agentMessage/delta',
              params: { delta: input.turnScript.answerText ?? 'ok' },
            })
            const c = input.turnScript.cumulativeCounters
            emitAppStdout(app, {
              method: 'thread/tokenUsage/updated',
              params: {
                threadId: input.threadId,
                turnId,
                tokenUsage: {
                  total: {
                    inputTokens: c.inputTokens,
                    cachedInputTokens: c.cachedInputTokens,
                    cacheWriteInputTokens: c.cacheWriteInputTokens,
                    outputTokens: c.outputTokens,
                    reasoningOutputTokens: c.reasoningOutputTokens,
                    totalTokens: c.inputTokens + c.outputTokens,
                  },
                },
              },
            })
            setTimeout(() => {
              if (completed) return
              completed = true
              emitAppStdout(app, {
                method: 'turn/completed',
                params: {
                  threadId: input.threadId,
                  turn: { id: turnId, status: 'completed' },
                },
              })
            }, input.turnScript.settleDelayMs ?? 80).unref()
          } else if (kind === 'interrupt') {
            interruptCount += 1
            rpcId += 1
            emitAppStdout(app, { id: rpcId, result: {} })
            if (!completed) {
              completed = true
              emitAppStdout(app, {
                method: 'turn/completed',
                params: {
                  threadId: input.threadId,
                  turn: { id: input.turnScript.turnId, status: 'interrupted' },
                },
              })
            }
          }
        })
        setImmediate(() => {
          app.writeStdoutLine({
            version: 4,
            seq: ++appSeq,
            driverId: binding.driverId,
            engineId: binding.engineId,
            operationId: binding.operationId,
            runId: binding.runId,
            generation: binding.generation,
            profileId: binding.profileId,
            authEpoch: binding.authEpoch,
            kind: 'ready',
          })
        })
        return app.proc
      },
      stop: async () => ({ remoteStopped: true }),
    }

    const relay = new RemotePoolRelay({
      binding,
      keys: input.keys.keyring,
      host,
      spec,
      journalDir: makeTempDir('codex-journal'),
      finance: input.finance,
      worker: input.worker,
    })
    relaysToStop.push(relay)

    const adapter = new RemoteEngineAdapter(
      makeEngineCreateOpts(binding, input.workspaceDir, {
        ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
      }),
      {
        binding,
        keyring: input.keys.keyring,
        ...makeStubLaneToolOptions(input.workspaceDir),
        call: (path, body) => relay.handleControl(path, body as Record<string, unknown>),
      },
    )

    return {
      binding,
      relay,
      adapter,
      interruptsSeen: () => interruptCount,
    }
  }

  it('does not trigger system interrupt on a freshly-constructed second RemoteEngineAdapter resuming a non-zero historical thread and matches authoritative net receipt', async () => {
    const pricing = {
      inputPerMtok: '1000',
      outputPerMtok: '2000',
      cacheReadPerMtok: '100',
      cacheWritePerMtok: '0',
      multiplier: '1.000',
    } as const
    _setPlatformPricingLookupForTests(async () => pricing)

    const worker = new DriverWorkerClient()
    workersToClose.push(worker)
    const keys = makeTestKeypair()
    const workspaceDir = makeTempDir('b04-workspace')
    const store = createAuthoritativeCodexFinanceStore()
    const threadId = 'thr-long-b04-001'

    // --- Instance 1: Turn 1 accumulates non-zero historical usage on the thread ---
    const turn1Cumulative = {
      inputTokens: 200_000, // includes 100_000 cachedInputTokens -> 100_000 uncached input
      cachedInputTokens: 100_000,
      cacheWriteInputTokens: 0,
      outputTokens: 20_000,
      reasoningOutputTokens: 0,
    }
    const inst1 = await createCodexRelayAndAdapter({
      worker,
      keys,
      finance: store.finance,
      threadId,
      workspaceDir,
      turnScript: {
        turnId: 'turn-b04-1',
        cumulativeCounters: turn1Cumulative,
        settleDelayMs: 30,
        answerText: 'turn-1-answer',
      },
    })

    const signed1 = keys.signTurn(inst1.binding, { billingRequestId: 'req-b04-1' })
    const run1 = inst1.adapter.submitTurn({
      input: 'first turn',
      requestId: 'req-b04-1',
      turnKey: signed1.turnKey,
      modelAuthority: {
        authorityEnvelope: signed1.authorityEnvelope,
        leaseEnvelope: signed1.leaseEnvelope,
        executionDescriptor: signed1.executionDescriptor,
      },
      onEvent: () => {},
      sessionTotals: { totalCostUSD: 0, turns: 0 },
      toolUseIdToName: new Map(),
    })
    await run1.submitted
    const summary1 = await run1.summary
    assert.ok(summary1)
    assert.equal(summary1.isError, false)
    assert.deepEqual(summary1.usage, {
      cost: 0,
      inputTokens: 100_000,
      outputTokens: 20_000,
      cacheReadTokens: 100_000,
      cacheCreationTokens: 0,
      totalTokens: 220_000,
    })
    await inst1.adapter.shutdown()

    // --- Instance 2: Completely independent fresh RemoteEngineAdapter resuming the SAME thread ---
    // Turn 2 net increment: uncached input +10_000, cacheRead +10_000 (raw input +20_000), output +5_000
    const turn2Cumulative = {
      inputTokens: 220_000,
      cachedInputTokens: 110_000,
      cacheWriteInputTokens: 0,
      outputTokens: 25_000,
      reasoningOutputTokens: 0,
    }
    const turn2NetFen = computeCostFen(
      {
        input_tokens: 10_000,
        output_tokens: 5_000,
        cache_read_tokens: 10_000,
        cache_write_tokens: 0,
      },
      {
        input_per_mtok: pricing.inputPerMtok,
        output_per_mtok: pricing.outputPerMtok,
        cache_read_per_mtok: pricing.cacheReadPerMtok,
        cache_write_per_mtok: pricing.cacheWritePerMtok,
        multiplier: pricing.multiplier,
      },
    )
    const cumulativeHistoryPlusTurn2Fen = computeCostFen(
      {
        input_tokens: 110_000,
        output_tokens: 25_000,
        cache_read_tokens: 110_000,
        cache_write_tokens: 0,
      },
      {
        input_per_mtok: pricing.inputPerMtok,
        output_per_mtok: pricing.outputPerMtok,
        cache_read_per_mtok: pricing.cacheReadPerMtok,
        cache_write_per_mtok: pricing.cacheWritePerMtok,
        multiplier: pricing.multiplier,
      },
    )
    assert.ok(
      turn2NetFen > 0n && cumulativeHistoryPlusTurn2Fen > turn2NetFen + 2n,
      `pricing sanity: net=${turn2NetFen}, cumulative=${cumulativeHistoryPlusTurn2Fen}`,
    )
    // Budget strictly between Turn 2 net cost and (historical + Turn 2) cumulative cost!
    const budgetFen = turn2NetFen + (cumulativeHistoryPlusTurn2Fen - turn2NetFen) / 2n
    assert.ok(budgetFen > turn2NetFen && budgetFen < cumulativeHistoryPlusTurn2Fen)

    const inst2 = await createCodexRelayAndAdapter({
      worker,
      keys,
      finance: store.finance,
      threadId,
      preboundNativeSessionId: threadId,
      workspaceDir,
      turnScript: {
        turnId: 'turn-b04-2',
        emitResumeReplay: turn1Cumulative,
        cumulativeCounters: turn2Cumulative,
        settleDelayMs: 90,
        answerText: 'turn-2-resumed-answer',
      },
    })
    // Also exercise `allowMigratedResume` which clears local baseline to zero before relay admission!
    inst2.adapter.allowMigratedResume(remoteV4ResumeId(inst1.binding.operationId, threadId))

    const events2: EngineEvent[] = []
    const billingEvents2: Array<{ usage?: Record<string, number> }> = []
    inst2.adapter.on('billing', (ev: { usage?: Record<string, number> }) => {
      billingEvents2.push(ev)
    })

    const signed2 = keys.signTurn(inst2.binding, { billingRequestId: 'req-b04-2' })
    const run2 = inst2.adapter.submitTurn({
      input: 'second turn after resume',
      requestId: 'req-b04-2',
      turnKey: signed2.turnKey,
      creditBudgetFen: budgetFen,
      modelAuthority: {
        authorityEnvelope: signed2.authorityEnvelope,
        leaseEnvelope: signed2.leaseEnvelope,
        executionDescriptor: signed2.executionDescriptor,
      },
      onEvent: (ev) => events2.push(ev),
      sessionTotals: { totalCostUSD: 0, turns: 1 },
      toolUseIdToName: new Map(),
    })

    await run2.submitted
    const summary2 = await run2.summary

    assert.equal(
      inst2.interruptsSeen(),
      0,
      'authoritative thread baseline must prevent false system interrupt on resumed thread',
    )
    assert.ok(summary2)
    assert.equal(summary2.isError, false)
    assert.equal(summary2.stopReason, 'end_turn')
    assert.equal(summary2.assistantText, 'turn-2-resumed-answer')
    assert.deepEqual(summary2.usage, {
      cost: 0,
      inputTokens: 10_000,
      outputTokens: 5_000,
      cacheReadTokens: 10_000,
      cacheCreationTokens: 0,
      totalTokens: 25_000,
    })

    // Authoritative receipt and billing sideband must both match exact Turn 2 net delta.
    const receipt2 = store.settledReceipts[1]!
    assert.deepEqual(receipt2.countersBaseline, turn1Cumulative)
    assert.deepEqual(receipt2.countersFinal, turn2Cumulative)
    assert.deepEqual(receipt2.usage, {
      inputTokens: 10_000,
      outputTokens: 5_000,
      cacheReadTokens: 10_000,
      cacheWriteTokens: 0,
    })
    assert.equal(billingEvents2.length, 1)
    assert.deepEqual(billingEvents2[0]?.usage, {
      input_tokens: 10_000,
      output_tokens: 5_000,
      cache_read_input_tokens: 10_000,
      cache_creation_input_tokens: 0,
    })
    assert.equal(
      events2.some((e) => e.kind === 'error'),
      false,
      'must not emit credit-exhausted error event',
    )

    await inst2.adapter.shutdown()

    // --- Instance 3 (positive control): budget guard STILL interrupts when Turn 3 real net cost >= budget ---
    const turn3Cumulative = {
      inputTokens: 320_000, // +100_000 raw input, +0 cacheRead -> +100_000 uncached input
      cachedInputTokens: 110_000,
      cacheWriteInputTokens: 0,
      outputTokens: 55_000, // +30_000 output
      reasoningOutputTokens: 0,
    }
    const inst3 = await createCodexRelayAndAdapter({
      worker,
      keys,
      finance: store.finance,
      threadId,
      preboundNativeSessionId: threadId,
      workspaceDir,
      turnScript: {
        turnId: 'turn-b04-3',
        cumulativeCounters: turn3Cumulative,
        settleDelayMs: 500,
        answerText: 'should-interrupt',
      },
    })
    const events3: EngineEvent[] = []
    const signed3 = keys.signTurn(inst3.binding, { billingRequestId: 'req-b04-3' })
    const run3 = inst3.adapter.submitTurn({
      input: 'expensive turn exceeding budget',
      requestId: 'req-b04-3',
      turnKey: signed3.turnKey,
      creditBudgetFen: budgetFen, // Turn 3 net cost >> budgetFen
      modelAuthority: {
        authorityEnvelope: signed3.authorityEnvelope,
        leaseEnvelope: signed3.leaseEnvelope,
        executionDescriptor: signed3.executionDescriptor,
      },
      onEvent: (ev) => events3.push(ev),
      sessionTotals: { totalCostUSD: 0, turns: 2 },
      toolUseIdToName: new Map(),
    })

    await run3.submitted
    const summary3 = await run3.summary
    assert.equal(
      inst3.interruptsSeen(),
      1,
      'budget guard must still trigger system interrupt when real net increment reaches budget',
    )
    assert.ok(summary3)
    assert.equal(summary3.isError, true)
    assert.equal(
      events3.some((e) => e.kind === 'error' && e.error === CREDIT_EXHAUSTED_DETAIL),
      true,
    )
    await inst3.adapter.shutdown()
  })

  it('ignores resume_replay security events for budget guard and supports explicit setResumeUsageBaseline', async () => {
    const pricing = {
      inputPerMtok: '1000',
      outputPerMtok: '2000',
      cacheReadPerMtok: '100',
      cacheWritePerMtok: '0',
      multiplier: '1.000',
    } as const
    _setPlatformPricingLookupForTests(async () => pricing)

    const keys = makeTestKeypair()
    const workspaceDir = makeTempDir('b04-replay-workspace')
    const binding = makeBinding({ driverId: 'codex', engineId: 'codex', authorityEngine: 'codex' })
    const signed = keys.signTurn(binding)

    let interruptSent = false
    let pollStage = 0

    const adapter = new RemoteEngineAdapter(makeEngineCreateOpts(binding, workspaceDir), {
      binding,
      keyring: keys.keyring,
      ...makeStubLaneToolOptions(workspaceDir),
      call: async (path, body) => {
        if (path === '/admit') {
          // Deliberately omit countersBaseline from /admit to test resume_replay + setResumeUsageBaseline path.
          return { ok: true, ready: true, seq: 0, nativeSessionId: 'thr-replay-1' }
        }
        if (path === '/command') {
          const cmd = body.command as Record<string, unknown>
          if (cmd.kind === 'interrupt') interruptSent = true
          return { ok: true, dispatched: true }
        }
        if (path === '/poll') {
          pollStage += 1
          if (pollStage === 1) {
            const replayEvent: RemoteSecurityEvent = {
              protocolVersion: 4,
              operationId: binding.operationId,
              generation: binding.generation,
              profileId: binding.profileId,
              authEpoch: binding.authEpoch,
              authorityTurnId: signed.authorityTurnId,
              nativeSessionId: 'thr-replay-1',
              seq: 1,
              rawFrameRef: { channel: 'native', frameSeq: 1, sha256: sha256Hex('f1') },
              driverId: 'codex',
              driverVersion: '1.0.0',
              payload: {
                kind: 'usage',
                sampleId: 'replay-u1',
                scopeId: 'resume_replay',
                semanticsId: 'codex-0.167-total-v1',
                rawCounters: {
                  inputTokens: 500_000,
                  cachedInputTokens: 200_000,
                  cacheWriteInputTokens: 0,
                  outputTokens: 50_000,
                  reasoningOutputTokens: 0,
                },
              },
            }
            const liveEvent: RemoteSecurityEvent = {
              protocolVersion: 4,
              operationId: binding.operationId,
              generation: binding.generation,
              profileId: binding.profileId,
              authEpoch: binding.authEpoch,
              authorityTurnId: signed.authorityTurnId,
              nativeSessionId: 'thr-replay-1',
              nativeTurnId: 'turn-r1',
              seq: 2,
              rawFrameRef: { channel: 'native', frameSeq: 2, sha256: sha256Hex('f2') },
              driverId: 'codex',
              driverVersion: '1.0.0',
              payload: {
                kind: 'usage',
                sampleId: 'turn-r1-u2',
                scopeId: 'turn-r1',
                semanticsId: 'codex-0.167-total-v1',
                rawCounters: {
                  inputTokens: 505_000,
                  cachedInputTokens: 202_000,
                  cacheWriteInputTokens: 0,
                  outputTokens: 51_000,
                  reasoningOutputTokens: 0,
                },
              },
            }
            return {
              ok: true,
              frames: [
                { seq: 1, frame: { kind: 'security', event: replayEvent } },
                { seq: 2, frame: { kind: 'security', event: liveEvent } },
              ],
            }
          }
          if (pollStage >= 2) {
            const receipt = {
              version: 4,
              backendKind: REMOTE_DRIVER_BACKEND,
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
              authorityTurnId: signed.authorityTurnId,
              turnKey: signed.turnKey,
              requestId: 'req-replay-1',
              nativeSessionId: 'thr-replay-1',
              terminalId: 'turn-r1',
              usageSemantics: 'codex-0.167-total-v1',
              usageMode: 'cumulative',
              countersBaseline: {
                inputTokens: 500_000,
                cachedInputTokens: 200_000,
                cacheWriteInputTokens: 0,
                outputTokens: 50_000,
                reasoningOutputTokens: 0,
              },
              countersFinal: {
                inputTokens: 505_000,
                cachedInputTokens: 202_000,
                cacheWriteInputTokens: 0,
                outputTokens: 51_000,
                reasoningOutputTokens: 0,
              },
              usage: {
                inputTokens: 3_000,
                outputTokens: 1_000,
                cacheReadTokens: 2_000,
                cacheWriteTokens: 0,
              },
              status: 'success',
              nativeStatus: 'success',
              rawEvidenceDigest: sha256Hex('ev-r1'),
              semanticDigest: sha256Hex('sem-r1'),
              provenance: {
                generation: binding.generation,
                manifestHash: binding.manifestSha256,
                coreDigest: binding.coreDigest,
                probeFingerprint: binding.probeFingerprint,
              },
              receiptDigest: sha256Hex('rcpt-r1'),
            } as RemoteReceiptV4
            return {
              ok: true,
              frames: [
                {
                  seq: 3,
                  frame: {
                    kind: 'turn_settled',
                    receipt,
                    outcome: { state: 'proven', requestId: 'req-replay-1' },
                  },
                },
              ],
            }
          }
          return { ok: true, frames: [] }
        }
        if (path === '/tool/next') return { ok: true }
        if (path === '/stop') return { ok: true, remoteStopped: true }
        if (path === '/tool/stopped') return { ok: true }
        return { ok: true }
      },
    })

    // Also verify setResumeUsageBaseline API works without throwing.
    adapter.setResumeUsageBaseline({
      inputTokens: 500_000,
      cachedInputTokens: 200_000,
      outputTokens: 50_000,
    })

    const callUsages: Array<{ callId: string; totalTokens: number }> = []
    const run = adapter.submitTurn({
      input: 'resume replay check',
      requestId: 'req-replay-1',
      turnKey: signed.turnKey,
      creditBudgetFen: 100n, // net cost is tiny (< 10 fen), while historical replay is > 400 fen
      modelAuthority: {
        authorityEnvelope: signed.authorityEnvelope,
        leaseEnvelope: signed.leaseEnvelope,
        executionDescriptor: signed.executionDescriptor,
      },
      onEvent: (ev) => {
        if (ev.kind === 'call_usage') {
          callUsages.push({ callId: ev.call.callId, totalTokens: ev.call.usage.totalTokens })
        }
      },
      sessionTotals: { totalCostUSD: 0, turns: 1 },
      toolUseIdToName: new Map(),
    })

    const keepalive = setInterval(() => {}, 50)
    try {
      await run.submitted
      const summary = await run.summary

      assert.equal(interruptSent, false)
      assert.ok(summary)
      assert.equal(summary.isError, false)
      assert.deepEqual(callUsages, [{ callId: 'turn-r1-u2', totalTokens: 6_000 }])
      assert.deepEqual(summary.usage, {
        cost: 0,
        inputTokens: 3_000,
        outputTokens: 1_000,
        cacheReadTokens: 2_000,
        cacheCreationTokens: 0,
        totalTokens: 6_000,
      })
    } finally {
      clearInterval(keepalive)
      await adapter.shutdown()
    }
  })
})
