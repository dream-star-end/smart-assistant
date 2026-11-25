import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  REMOTE_DRIVER_BACKEND,
  REMOTE_DRIVER_PROTOCOL_VERSION,
  authoritySigningInput,
  encodeAuthorityEnvelope,
  encodeTurnLeaseEnvelope,
  turnLeaseSigningInput,
  verifyAuthority,
  type AuthorityKeyring,
  type ModelAuthorityPayload,
  type RemoteReceiptV4,
  type TurnLease,
} from '@openclaude/protocol'
import { buildImageAttachmentHint } from '../../imageAttachmentHint.js'
import { RemoteContainerLane, type LaneToolHost } from '../containerLane.js'
import { RemoteEngineAdapter } from '../remoteEngineAdapter.js'
import {
  DEFAULT_REMOTE_IMAGE_ONLY_TEXT,
  buildRemoteInboundTurnPayload,
} from '../remoteInboundMultimodal.js'
import {
  remotePoolBackendOf,
  type RemotePoolBinding,
  type RemoteRelayedFrame,
} from '../types.js'

const VALID_1X1_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

function makeAntigravityBinding(overrides: Partial<RemotePoolBinding> = {}): RemotePoolBinding {
  const hex = (ch: string) => ch.repeat(64)
  return {
    version: REMOTE_DRIVER_PROTOCOL_VERSION,
    backendKind: REMOTE_DRIVER_BACKEND,
    operationId: randomUUID(),
    runId: `run_${randomUUID().slice(0, 8)}`,
    uid: '42',
    containerDbId: '7',
    dockerId: 'ctr_agy_multimodal',
    sessionKey: `agent:main:webchat:dm:agy_mm_${randomUUID().slice(0, 8)}`,
    canonicalModel: 'antigravity-gemini-4-carbon-remote',
    upstreamModel: 'gemini-4-carbon-high',
    driverId: 'antigravity',
    engineId: 'antigravity',
    authorityEngine: 'antigravity',
    driverVersion: '1.0.0',
    driverDigest: hex('a'),
    coreDigest: hex('b'),
    probeFingerprint: hex('c'),
    manifestSha256: hex('d'),
    generation: '1',
    profileId: randomUUID(),
    authEpoch: 'auth-epoch-1',
    capability: hex('e'),
    expiresAt: Date.now() + 600_000,
    ...overrides,
  }
}

function makeKeyFixture() {
  const kp = generateKeyPairSync('ed25519')
  const keyId = 'k-mm-1'
  const keyring: AuthorityKeyring = new Map([
    [keyId, new Uint8Array(Buffer.from(kp.publicKey.export({ format: 'jwk' }).x!, 'base64url'))],
  ])
  const signTurn = (args: { binding: RemotePoolBinding; supportsVision: boolean }) => {
    const now = Date.now()
    const turnKey = createHash('sha256').update(randomUUID()).digest('hex')
    const authorityTurnId = `at-${randomUUID()}`
    const payload: ModelAuthorityPayload = {
      v: 1,
      keyId,
      uid: Number(args.binding.uid),
      containerId: Number(args.binding.containerDbId),
      authorityTurnId,
      connectionChallenge: 'challenge-mm-1',
      canonicalModel: args.binding.canonicalModel,
      engine: args.binding.authorityEngine,
      executionDescriptor: {
        capabilityProfile: {},
        capabilitySchemaVersion: 1,
        contextWindow: 200_000,
        supportedEfforts: ['low', 'medium', 'high'],
        supportsVision: args.supportsVision,
      },
      executionBackend: remotePoolBackendOf(args.binding),
      executionRevision: 'rev-1',
      securityEpoch: 1,
      issuedAt: now - 1_000,
      expiresAt: now + 120_000,
    }
    const leasePayload: TurnLease = {
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
    const lease = encodeTurnLeaseEnvelope(
      leasePayload,
      sign(null, turnLeaseSigningInput(leasePayload), kp.privateKey),
    )
    verifyAuthority(authority, keyring, now)
    return { authority, lease, turnKey, payload }
  }
  return { keyring, signTurn }
}

function makeReceipt(
  binding: RemotePoolBinding,
  opts: { authorityTurnId: string; turnKey: string; nativeSessionId: string },
): RemoteReceiptV4 {
  return {
    version: REMOTE_DRIVER_PROTOCOL_VERSION,
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
    authorityTurnId: opts.authorityTurnId,
    turnKey: opts.turnKey,
    requestId: `req-${randomUUID()}`,
    nativeSessionId: opts.nativeSessionId,
    terminalId: `term-${randomUUID()}`,
    status: 'success',
    nativeStatus: 'success',
    usage: {
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    usageSemantics: 'antigravity_per_turn_v1',
    usageMode: 'per_turn',
    countersBaseline: null,
    countersFinal: { input_tokens: 120, output_tokens: 30 },
    rawEvidenceDigest: 'a'.repeat(64),
    semanticDigest: 'b'.repeat(64),
    provenance: {
      generation: binding.generation,
      manifestHash: binding.manifestSha256,
      coreDigest: binding.coreDigest,
      probeFingerprint: binding.probeFingerprint,
    },
    receiptDigest: 'c'.repeat(64),
  }
}

test('OCV5-893 B1: RemoteEngineAdapter advertises native multimodalInput for vision-enabled remote Antigravity and preserves plain string for local turns', () => {
  const binding = makeAntigravityBinding()
  const { keyring } = makeKeyFixture()
  const baseOpts = {
    agentId: 'main',
    agentBaseDir: '/tmp',
    sessionKey: binding.sessionKey,
    model: binding.canonicalModel,
    config: { auth: {}, gateway: { port: 0, accessToken: '' }, mcpServers: [] } as any,
    executionBackend: remotePoolBackendOf(binding),
  }
  const laneOpts = {
    binding,
    keyring,
    socketPath: '/tmp/nonexistent-agy-mm.sock',
    toolContextFactory: async () => ({
      profile: {} as any,
      env: {},
      platformPrompt: '',
      cleanup: () => {},
    }),
  }

  const visionAdapter = new RemoteEngineAdapter(
    {
      ...baseOpts,
      executionAuthority: {
        executionDescriptor: { supportsVision: true },
      },
    } as any,
    laneOpts,
  )
  assert.equal(visionAdapter.capabilities.multimodalInput, 'native')

  const textOnlyAdapter = new RemoteEngineAdapter(
    {
      ...baseOpts,
      executionAuthority: {
        executionDescriptor: { supportsVision: false },
      },
    } as any,
    laneOpts,
  )
  assert.equal(textOnlyAdapter.capabilities.multimodalInput, 'text-only')

  // Local (non-remote-driver-v4) turns keep plain string payload with zero regression
  const localPayload = buildRemoteInboundTurnPayload({
    finalText: 'local prompt',
    savedMedia: [{ kind: 'image', path: '/tmp/a.png', mimeType: 'image/png' }],
    executionBackend: undefined,
  })
  assert.equal(localPayload, 'local prompt')

  // Remote turns without images also keep plain string
  const textOnlyRemote = buildRemoteInboundTurnPayload({
    finalText: 'remote text only',
    savedMedia: [{ kind: 'file', path: '/tmp/doc.pdf', mimeType: 'application/pdf' }],
    executionBackend: remotePoolBackendOf(binding),
  })
  assert.equal(textOnlyRemote, 'remote text only')
})

test('OCV5-893 B1 E2E: inbound savedMedia PNG -> RemoteContainerLane materialization -> real python3 antigravity.py encode & media write (mixed, image-only, >9 MiB boundary, supportsVision=false)', async (t) => {
  const keepalive = setInterval(() => {}, 1_000)
  t.after(() => clearInterval(keepalive))
  const root = mkdtempSync(join(tmpdir(), 'oc-remote-inbound-mm-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const uploadsDir = join(root, 'uploads')
  const execRoot = join(root, 'exec')
  mkdirSync(uploadsDir, { recursive: true, mode: 0o700 })
  mkdirSync(execRoot, { recursive: true, mode: 0o700 })

  const normalPngPath = join(uploadsDir, 'photo-ok.png')
  writeFileSync(normalPngPath, VALID_1X1_PNG)
  const expectedSha256 = createHash('sha256').update(VALID_1X1_PNG).digest('hex')
  const expectedBase64 = VALID_1X1_PNG.toString('base64')

  // > 9 MiB raw PNG (base64 expands by 4/3 -> > 12 MiB DEFAULT_MAX_IMAGE_BYTES)
  const oversizedPngPath = join(uploadsDir, 'photo-over-9mb.png')
  const over9MiB = Buffer.alloc(9 * 1024 * 1024 + 64, 0x41)
  VALID_1X1_PNG.copy(over9MiB, 0)
  writeFileSync(oversizedPngPath, over9MiB)

  const binding = makeAntigravityBinding()
  const { keyring, signTurn } = makeKeyFixture()
  const nativeSessionId = `sess_${randomUUID().slice(0, 8)}`
  const commandsSent: Array<Record<string, unknown>> = []
  const frames: Array<{ seq: number; frame: RemoteRelayedFrame }> = []
  let nextSeq = 0
  let currentTurnKey = ''

  const host: LaneToolHost = {
    async tools() {
      return [
        {
          name: 'Read',
          description: 'Read a file from the workspace',
          inputSchema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
        },
      ]
    },
    async execute() {
      return { content: [{ type: 'text', text: 'unused' }], isError: false }
    },
    async close() {},
  }

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
      trustedMediaRoots: [uploadsDir],
      platformPrompt: 'test-platform-prompt',
      hostFactory: () => host,
      toolContextFactory: async () => ({
        profile: { cwd: execRoot, mcpConfigPath: null, settingsPath: null, disallowedTools: [] },
        env: {},
        platformPrompt: 'test-platform-prompt',
        cleanup: () => {},
      }),
      call: async (reqPath, body) => {
        if (reqPath === '/admit') {
          return { ok: true, ready: true, seq: nextSeq, nativeSessionId }
        }
        if (reqPath === '/command') {
          const cmd = body.command as Record<string, unknown>
          commandsSent.push(cmd)
          if (cmd.kind === 'newTurn') {
            const turnId = String(cmd.commandId).slice('turn-'.length)
            frames.push({
              seq: ++nextSeq,
              frame: {
                kind: 'turn_settled',
                receipt: makeReceipt(binding, {
                  authorityTurnId: turnId,
                  turnKey: currentTurnKey,
                  nativeSessionId,
                }),
                outcome: { state: 'proven', requestId: `req-${commandsSent.length}` },
              },
            })
          }
          return { ok: true, dispatched: true }
        }
        if (reqPath === '/poll') {
          const afterSeq = Number(body.afterSeq)
          return { ok: true, frames: frames.filter((f) => f.seq > afterSeq) }
        }
        if (reqPath === '/tool/next') return { ok: true }
        if (reqPath === '/stop') return { ok: true, stopped: true }
        return { ok: true }
      },
    },
  )
  t.after(() => lane.stopLane().catch(() => {}))

  const submitViaInboundPath = async (opts: {
    userText: string
    savedMedia: Array<{ kind: string; path: string; mimeType: string; sizeHint: string; name: string }>
    supportsVision: boolean
    omitHint?: boolean
  }) => {
    const finalText = opts.omitHint
      ? opts.userText
      : [
          opts.userText,
          '',
          '---',
          buildImageAttachmentHint({
            paths: opts.savedMedia.map((ip) => ({
              path: ip.path,
              mimeType: ip.mimeType,
              sizeHint: ip.sizeHint,
              name: ip.name,
            })),
          }),
        ].join('\n')
    const inboundPayload = buildRemoteInboundTurnPayload({
      finalText,
      savedMedia: opts.savedMedia,
      executionBackend: remotePoolBackendOf(binding),
    })
    assert.ok(Array.isArray(inboundPayload), 'remote turn with image must emit TurnInputBlock[]')

    const signed = signTurn({ binding, supportsVision: opts.supportsVision })
    currentTurnKey = signed.turnKey
    const validated = lane.validateTurnSubmission({
      input: inboundPayload,
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
          supportsVision: opts.supportsVision,
          supportedEfforts: ['low', 'medium', 'high'],
        },
      },
      onEvent: () => {},
      sessionTotals: { totalCostUSD: 0, turns: 0 },
      toolUseIdToName: new Map(),
    })
    return await lane.executeTurn(validated, {
      onNativeSession: () => {},
      onSubmitted: () => {},
      onSecurityEvent: () => {},
      onPresentationItem: () => {},
    })
  }

  // 1. Mixed text + saved PNG attachment -> materialized to base64 (path stripped!) and dispatched
  await submitViaInboundPath({
    userText: '请描述这张截图里的内容',
    savedMedia: [
      {
        kind: 'image',
        path: normalPngPath,
        mimeType: 'image/png',
        sizeHint: '68B',
        name: 'photo-ok.png',
      },
    ],
    supportsVision: true,
  })
  assert.equal(commandsSent.length, 1)
  const mixedCmd = commandsSent[0]!
  const mixedContent = mixedCmd.content as Array<Record<string, unknown>>
  assert.equal(mixedContent.length, 2)
  assert.equal(mixedContent[1]!.type, 'image')
  assert.equal(mixedContent[1]!.mimeType, 'image/png')
  assert.equal(mixedContent[1]!.data, expectedBase64)
  assert.equal('path' in mixedContent[1]!, false, 'container path MUST be stripped after materialization')

  // 2. Pure image-only (empty userText, omitHint=true) -> fills default text & dispatches base64 PNG
  await submitViaInboundPath({
    userText: '',
    savedMedia: [
      {
        kind: 'image',
        path: normalPngPath,
        mimeType: 'image/png',
        sizeHint: '68B',
        name: 'photo-ok.png',
      },
    ],
    supportsVision: true,
    omitHint: true,
  })
  assert.equal(commandsSent.length, 2)
  const imageOnlyCmd = commandsSent[1]!
  const imageOnlyContent = imageOnlyCmd.content as Array<Record<string, unknown>>
  assert.equal(imageOnlyContent[0]!.text, DEFAULT_REMOTE_IMAGE_ONLY_TEXT)
  assert.equal(imageOnlyContent[1]!.data, expectedBase64)

  // 3. Cross-language real python3 antigravity.py encode() + _AGY_HOST_PY disk write verification!
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')
  const hostMediaTmp = join(root, 'py-host-root')
  mkdirSync(join(hostMediaTmp, 'media'), { recursive: true })
  const pyOut = execFileSync(
    'python3',
    [
      '-c',
      [
        'import base64, hashlib, json, os, pathlib, sys',
        'sys.path.insert(0, sys.argv[1])',
        'from core.contract import load_driver',
        'agy, _, _ = load_driver("antigravity")',
        'mixed = json.loads(sys.argv[2])',
        'img_only = json.loads(sys.argv[3])',
        'host_root = pathlib.Path(sys.argv[4])',
        'r1 = agy.encode({**mixed, "commandId": "cmd_mm_1"}, {"initialized": True, "sessionId": "sess_1"})',
        'r2 = agy.encode({**img_only, "commandId": "cmd_mm_2"}, {"initialized": True, "sessionId": "sess_1"})',
        'p1 = json.loads(r1["lines"][0])',
        'p2 = json.loads(r2["lines"][0])',
        'img = p1["images"][0]',
        'decoded = base64.b64decode(img["data"], validate=True)',
        'out_path = host_root / "media" / "turn-1-img-0.png"',
        'out_path.write_bytes(decoded)',
        'print(json.dumps({',
        '  "mixed_prompt": p1["prompt"],',
        '  "mixed_count": len(p1["images"]),',
        '  "mixed_mime": img["mimeType"],',
        '  "mixed_sha256": img["sha256"],',
        '  "written_sha256": hashlib.sha256(out_path.read_bytes()).hexdigest(),',
        '  "written_bytes": out_path.stat().st_size,',
        '  "only_prompt": p2["prompt"],',
        '  "only_count": len(p2["images"]),',
        '  "only_sha256": p2["images"][0]["sha256"],',
        '}))',
      ].join('\n'),
      join(repoRoot, 'scripts', 'agent-remote'),
      JSON.stringify(mixedCmd),
      JSON.stringify(imageOnlyCmd),
      hostMediaTmp,
    ],
    { encoding: 'utf8' },
  )
  const pyRes = JSON.parse(pyOut) as {
    mixed_prompt: string
    mixed_count: number
    mixed_mime: string
    mixed_sha256: string
    written_sha256: string
    written_bytes: number
    only_prompt: string
    only_count: number
    only_sha256: string
  }
  assert.ok(pyRes.mixed_prompt.includes('请描述这张截图里的内容'))
  assert.equal(pyRes.mixed_count, 1)
  assert.equal(pyRes.mixed_mime, 'image/png')
  assert.equal(pyRes.mixed_sha256, expectedSha256)
  assert.equal(pyRes.written_sha256, expectedSha256)
  assert.equal(pyRes.written_bytes, VALID_1X1_PNG.length)
  assert.ok(pyRes.only_prompt.includes(DEFAULT_REMOTE_IMAGE_ONLY_TEXT))
  assert.equal(pyRes.only_count, 1)
  assert.equal(pyRes.only_sha256, expectedSha256)

  // 4. > 9 MiB raw PNG boundary MUST fail closed pre-dispatch with REMOTE_IMAGE_PAYLOAD_TOO_LARGE
  await assert.rejects(
    submitViaInboundPath({
      userText: '太大了',
      savedMedia: [
        {
          kind: 'image',
          path: oversizedPngPath,
          mimeType: 'image/png',
          sizeHint: '9.1MB',
          name: 'photo-over-9mb.png',
        },
      ],
      supportsVision: true,
    }),
    /REMOTE_IMAGE_PAYLOAD_TOO_LARGE/,
  )
  assert.equal(commandsSent.length, 2, 'oversized image (>9 MiB) must reject BEFORE dispatch')

  // 5. supportsVision=false MUST fail closed pre-dispatch with REMOTE_VISION_CONTENT_UNSUPPORTED (never silently drop image!)
  await assert.rejects(
    submitViaInboundPath({
      userText: '无视觉模型发图',
      savedMedia: [
        {
          kind: 'image',
          path: normalPngPath,
          mimeType: 'image/png',
          sizeHint: '68B',
          name: 'photo-ok.png',
        },
      ],
      supportsVision: false,
    }),
    /REMOTE_VISION_CONTENT_UNSUPPORTED/,
  )
  assert.equal(commandsSent.length, 2, 'supportsVision=false must reject BEFORE dispatch')
})
