import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { test } from 'node:test'
import {
  GENESIS_RAW_EVIDENCE_DIGEST,
  REMOTE_CANONICAL_GOLDEN_VECTORS,
  REMOTE_DRIVER_BACKEND,
  REMOTE_DRIVER_PROTOCOL_VERSION,
  advanceRawEvidenceDigest,
  authoritySigningInput,
  buildRemoteReceiptV4,
  computeRawEvidenceDigest,
  encodeAuthorityEnvelope,
  isRemoteBackendAuthority,
  normalizeUsageWithPolicy,
  parseRemoteExecutionBackend,
  remoteCanonicalJson,
  remoteCanonicalSha256,
  sameRemoteExecutionBackend,
  validatePendingToolRequest,
  validateRemoteReceiptV4,
  validateSecurityEvent,
  validateSecurityPayload,
  verifyAuthority,
  type RemoteDriverExecutionBackend,
  type RemoteDriverUsagePolicy,
} from '../index.js'

const OP_ID = '11111111-1111-4111-8111-111111111111'
const RUN_ID = '22222222-2222-4222-8222-222222222222'
const PROFILE_UUID = 'ebc80fa6-0348-49a3-b1c1-8a08017114d6'
const SESSION_KEY = 'agent:main:webchat:dm:remote_pool_v4_test'

test('canonical JSON matches cross-language UTF-8 byte-order golden vectors and rejects malformed values', () => {
  for (const vec of REMOTE_CANONICAL_GOLDEN_VECTORS) {
    assert.equal(remoteCanonicalJson(vec.value), vec.canonical, `canonical mismatch for ${vec.name}`)
    assert.equal(remoteCanonicalSha256(vec.value), vec.sha256, `sha256 mismatch for ${vec.name}`)
  }

  // Explicitly prove UTF-8 byte order (U+FFFD = EF BF BD before U+1F600 = F0 9F 98 80)
  // rather than UTF-16 code unit order (0xD83D < 0xFFFD).
  const nonBmpCanonical = remoteCanonicalJson({ '😀': 1, '\uFFFD': 2 })
  assert.equal(nonBmpCanonical, `{"${'\uFFFD'}":2,"😀":1}`)

  // Undefined object properties are omitted; undefined array slots become null.
  assert.equal(remoteCanonicalJson({ z: 1, drop: undefined, arr: [undefined, -0] }), '{"arr":[null,0],"z":1}')

  // Reject NaN, +/-Infinity, unsafe integers, float-integers >= 2^53, and lone UTF-16 surrogates.
  for (const bad of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    -(Number.MAX_SAFE_INTEGER + 1),
    1e21,
    'bad\uD800surrogate',
    { ['\uDC00key']: 1 },
  ]) {
    assert.throws(() => remoteCanonicalJson(bad), /REMOTE_CANONICAL_JSON_INVALID/)
  }
})

test('raw evidence hash chain binds ordered raw frame bytes without JSON re-encoding', () => {
  // Whitespace-different raw frames MUST hash differently because rawEvidenceDigest hashes raw bytes.
  const compact = computeRawEvidenceDigest([
    { channel: 'native_stdout', seq: 1, rawBytes: '{"type":"init"}\n' },
    { channel: 'fixed_mcp', seq: 2, rawBytes: '{"id":1,"method":"tools/call"}' },
  ])
  const spaced = computeRawEvidenceDigest([
    { channel: 'native_stdout', seq: 1, rawBytes: '{ "type": "init" }\n' },
    { channel: 'fixed_mcp', seq: 2, rawBytes: '{"id":1,"method":"tools/call"}' },
  ])
  assert.notEqual(compact, spaced)

  // Stepwise equals batch.
  let rolling = GENESIS_RAW_EVIDENCE_DIGEST
  rolling = advanceRawEvidenceDigest(rolling, { channel: 'native_stdout', seq: 1, rawBytes: '{"type":"init"}\n' })
  rolling = advanceRawEvidenceDigest(rolling, { channel: 'fixed_mcp', seq: 2, rawBytes: '{"id":1,"method":"tools/call"}' })
  assert.equal(rolling, compact)

  // Sequence gaps or out-of-order frames fail closed.
  assert.throws(
    () =>
      computeRawEvidenceDigest([
        { channel: 'native_stdout', seq: 1, rawBytes: 'a' },
        { channel: 'native_stdout', seq: 3, rawBytes: 'b' },
      ]),
    /REMOTE_RAW_EVIDENCE_SEQ_GAP/,
  )
})

test('RemoteDriverExecutionBackend supports cc, codex, synthetic 3rd driver, and preserves legacy v1/v2 backends', () => {
  const ccV4: RemoteDriverExecutionBackend = {
    kind: REMOTE_DRIVER_BACKEND,
    version: 4,
    engineId: 'cc',
    authorityEngine: 'ccb',
    driverId: 'cc',
    driverVersion: '1.0.0',
    sessionKey: SESSION_KEY,
    operationId: OP_ID,
    generation: '1',
    profileId: PROFILE_UUID,
    authEpoch: 'epoch-cc-1',
  }
  const codexV4: RemoteDriverExecutionBackend = {
    ...ccV4,
    engineId: 'codex',
    authorityEngine: 'codex',
    driverId: 'codex',
    authEpoch: '8b71e0a7-fec6-497b-a733-4fcafcd5ec36',
  }
  const exampleEchoV4: RemoteDriverExecutionBackend = {
    ...ccV4,
    engineId: 'example_echo',
    authorityEngine: 'grok',
    driverId: 'example_echo',
    authEpoch: 'epoch-echo-1',
  }

  assert.deepEqual(parseRemoteExecutionBackend(ccV4), ccV4)
  assert.deepEqual(parseRemoteExecutionBackend(codexV4), codexV4)
  assert.deepEqual(parseRemoteExecutionBackend(exampleEchoV4), exampleEchoV4)
  assert.equal(sameRemoteExecutionBackend(ccV4, { ...ccV4 }), true)
  assert.equal(sameRemoteExecutionBackend(ccV4, codexV4), false)

  // Built-in engine authority confusion fails closed (cc cannot claim codex authority).
  assert.throws(
    () => parseRemoteExecutionBackend({ ...ccV4, authorityEngine: 'codex' }),
    /REMOTE_DRIVER_BACKEND_SCOPE_INVALID/,
  )
  assert.equal(
    isRemoteBackendAuthority({
      engine: 'ccb',
      canonicalModel: 'claude-opus-5-5-remote',
      executionBackend: ccV4,
    }),
    true,
  )
  assert.equal(
    isRemoteBackendAuthority({
      engine: 'codex',
      canonicalModel: 'claude-opus-5-5-remote',
      executionBackend: ccV4,
    }),
    false,
  )

  // Signed ModelAuthorityEnvelope round-trips all 3 drivers (cc, codex, synthetic example_echo) with zero modelAuthority.ts changes.
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const keyId = 'mak1_testkey00000001'
  const now = 1760000000000
  const keys = new Map([[keyId, new Uint8Array(Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url'))]])
  const makeEnvelope = (value: Record<string, unknown>) =>
    encodeAuthorityEnvelope(value as any, sign(null, authoritySigningInput(value as any), privateKey))

  for (const [model, engine, backend] of [
    ['claude-opus-5-5-remote', 'ccb', ccV4],
    ['gpt-6-astra-remote', 'codex', codexV4],
    ['example-echo-remote', 'grok', exampleEchoV4],
  ] as const) {
    const payload = {
      v: 1,
      keyId,
      uid: 3,
      containerId: 7,
      authorityTurnId: 'a'.repeat(32),
      connectionChallenge: 'challenge-v4',
      canonicalModel: model,
      engine,
      executionBackend: backend,
      executionDescriptor: {
        capabilityProfile: {},
        capabilitySchemaVersion: 1,
        contextWindow: 200000,
        supportedEfforts: ['low', 'medium', 'high'],
        supportsVision: false,
      },
      executionRevision: 'b'.repeat(64),
      securityEpoch: 1,
      issuedAt: now,
      expiresAt: now + 60_000,
    }
    const verified = verifyAuthority(makeEnvelope(payload), keys, now)
    assert.deepEqual(verified.executionBackend, backend)
    // Engine mismatch rejected even if validly signed!
    assert.throws(() =>
      verifyAuthority(makeEnvelope({ ...payload, engine: engine === 'ccb' ? 'codex' : 'ccb' }), keys, now),
    )
  }

  // Legacy cc5-interactive-v1 and codex-app-server-v1 remain dual-readable without alteration.
  const legacyCc5 = { kind: 'cc5-interactive-v1' as const, sessionKey: SESSION_KEY, operationId: OP_ID }
  const legacyCodex = {
    kind: 'codex-app-server-v1' as const,
    version: 1 as const,
    sessionKey: SESSION_KEY,
    operationId: OP_ID,
    generation: '2',
    profileId: 'default',
    authEpoch: 'epoch-1',
  }
  assert.deepEqual(parseRemoteExecutionBackend(legacyCc5), legacyCc5)
  assert.deepEqual(parseRemoteExecutionBackend(legacyCodex), legacyCodex)
  assert.equal(sameRemoteExecutionBackend(legacyCc5, ccV4), false)
})

test('5 normalized security events and pendingToolRequest enforce native-channel & canonical-hash invariants', () => {
  const args = { cmd: 'echo sentinel', timeoutMs: 5000 }
  const argsHash = remoteCanonicalSha256(args)
  const baseEnvelope = {
    protocolVersion: REMOTE_DRIVER_PROTOCOL_VERSION,
    operationId: OP_ID,
    generation: '1',
    profileId: PROFILE_UUID,
    authEpoch: 'epoch-1',
    authorityTurnId: 'a'.repeat(32),
    nativeSessionId: 'sess-1',
    nativeTurnId: 'turn-1',
    seq: 1,
    rawFrameRef: { channel: 'native' as const, frameSeq: 1, sha256: 'c'.repeat(64) },
    driverId: 'codex',
    driverVersion: '1.0.0',
  }

  const payloads = [
    { kind: 'toolCallObserved', callId: 'call-1', name: 't0', argsHash, arguments: args, phase: 'started' },
    {
      kind: 'usage',
      sampleId: 'sample-1',
      scopeId: 'turn-1',
      semanticsId: 'codex-cumulative-v1',
      rawCounters: { inputTokens: 120, cachedInputTokens: 20, outputTokens: 50, reasoningOutputTokens: 10 },
    },
    { kind: 'turnTerminal', terminalId: 'term-1', status: 'success' },
    { kind: 'textDelta', channel: 'answer', delta: 'hello' },
    { kind: 'disallowedItem', reason: 'native_shell_blocked', itemType: 'commandExecution' },
  ] as const

  for (const [idx, payload] of payloads.entries()) {
    const validated = validateSecurityEvent({ ...baseEnvelope, seq: idx + 1, payload })
    assert.equal(validated.payload.kind, payload.kind)
  }

  // Non-native channel (fixed_mcp / probe) MUST NEVER emit security events.
  assert.throws(
    () => validateSecurityPayload(payloads[0], 'fixed_mcp'),
    /REMOTE_DRIVER_NON_NATIVE_SECURITY_EVENT/,
  )
  assert.throws(
    () =>
      validateSecurityEvent({
        ...baseEnvelope,
        rawFrameRef: { channel: 'fixed_mcp', frameSeq: 1, sha256: 'c'.repeat(64) },
        payload: payloads[0],
      }),
    /REMOTE_DRIVER_EVENT_INVALID/,
  )

  // Tampered argsHash on toolCallObserved or pendingToolRequest fails closed.
  assert.throws(
    () =>
      validateSecurityPayload(
        { ...payloads[0], argsHash: 'f'.repeat(64) },
        'native',
      ),
    /REMOTE_DRIVER_TOOL_ARGS_HASH_MISMATCH/,
  )
  assert.throws(
    () =>
      validatePendingToolRequest({
        rpcId: 7,
        callId: 'call-1',
        nativeSessionId: 'sess-1',
        nativeTurnId: 'turn-1',
        server: 'ocbridge',
        name: 't0',
        arguments: args,
        argsHash: 'f'.repeat(64),
      }),
    /REMOTE_DRIVER_MCP_ARGS_HASH_MISMATCH/,
  )

  const mcpReq = validatePendingToolRequest({
    rpcId: 7,
    callId: 'call-1',
    nativeSessionId: 'sess-1',
    nativeTurnId: 'turn-1',
    server: 'ocbridge',
    name: 't0',
    arguments: args,
    argsHash,
  })
  assert.equal(mcpReq.argsHash, argsHash)

  // Driver cannot smuggle price/cost/settled flags in usage counters or unknown event kinds.
  assert.throws(
    () =>
      validateSecurityPayload(
        {
          kind: 'usage',
          sampleId: 's1',
          scopeId: 't1',
          semanticsId: 'sem1',
          rawCounters: { inputTokens: 10, costUsd: 1 },
        },
        'native',
      ),
    /REMOTE_DRIVER_FORBIDDEN_BILLING_FIELD/,
  )
  assert.throws(
    () => validateSecurityPayload({ kind: 'grantToolBypass', callId: 'call-1' }, 'native'),
    /REMOTE_DRIVER_UNKNOWN_SECURITY_EVENT/,
  )
})

test('RemoteReceiptV4 normalizes CC per-turn and Codex cumulative usage and separates semantic vs transport digests', () => {
  const ccPolicy: RemoteDriverUsagePolicy = {
    semanticsId: 'cc-result-per-turn-v1',
    mode: 'per_turn',
    inputField: 'input_tokens',
    outputField: 'output_tokens',
    cacheReadField: 'cache_read_input_tokens',
    cacheWriteField: 'cache_creation_input_tokens',
    inputIncludesCacheRead: false,
    outputIncludesReasoning: true,
    allowCacheWrite: true,
  }

  const codexPolicy: RemoteDriverUsagePolicy = {
    semanticsId: 'codex-thread-cumulative-v1',
    mode: 'cumulative',
    inputField: 'inputTokens',
    outputField: 'outputTokens',
    cacheReadField: 'cachedInputTokens',
    cacheWriteField: 'cacheCreationInputTokens',
    reasoningField: 'reasoningOutputTokens',
    inputIncludesCacheRead: true,
    outputIncludesReasoning: true,
    allowCacheWrite: false,
  }

  // CC per-turn normalization.
  const ccNorm = normalizeUsageWithPolicy(
    ccPolicy,
    {
      input_tokens: 150,
      output_tokens: 80,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 200,
    },
    null,
  )
  assert.deepEqual(ccNorm.usage, {
    inputTokens: 150,
    outputTokens: 80,
    cacheReadTokens: 1000,
    cacheWriteTokens: 200,
  })
  assert.throws(
    () => normalizeUsageWithPolicy(ccPolicy, { input_tokens: 10, output_tokens: 5 }, { input_tokens: 0, output_tokens: 0 }),
    /REMOTE_USAGE_UNEXPECTED_BASELINE/,
  )

  // Codex cumulative delta normalization: input subtracts cachedInputTokens; reasoning included in output; cacheWrite=0 enforced.
  const codexNorm = normalizeUsageWithPolicy(
    codexPolicy,
    { inputTokens: 1500, cachedInputTokens: 400, outputTokens: 320, reasoningOutputTokens: 120, cacheCreationInputTokens: 0 },
    { inputTokens: 1000, cachedInputTokens: 100, outputTokens: 200, reasoningOutputTokens: 50, cacheCreationInputTokens: 0 },
  )
  // Delta: rawInput=500, cacheRead=300 => inputTokens = 500 - 300 = 200; outputTokens = 120.
  assert.deepEqual(codexNorm.usage, {
    inputTokens: 200,
    outputTokens: 120,
    cacheReadTokens: 300,
    cacheWriteTokens: 0,
  })

  // Red controls: missing baseline, counter decrease, cacheRead > input, and unproven cacheWrite > 0 all fail closed.
  assert.throws(
    () => normalizeUsageWithPolicy(codexPolicy, { inputTokens: 100, outputTokens: 20 }, null),
    /REMOTE_USAGE_BASELINE_REQUIRED/,
  )
  assert.throws(
    () =>
      normalizeUsageWithPolicy(
        codexPolicy,
        { inputTokens: 900, cachedInputTokens: 100, outputTokens: 250, reasoningOutputTokens: 50, cacheCreationInputTokens: 0 },
        { inputTokens: 1000, cachedInputTokens: 100, outputTokens: 200, reasoningOutputTokens: 50, cacheCreationInputTokens: 0 },
      ),
    /REMOTE_USAGE_COUNTER_DECREASED/,
  )
  assert.throws(
    () =>
      normalizeUsageWithPolicy(
        codexPolicy,
        { inputTokens: 1100, cachedInputTokens: 400, outputTokens: 250, reasoningOutputTokens: 50, cacheCreationInputTokens: 0 },
        { inputTokens: 1000, cachedInputTokens: 100, outputTokens: 200, reasoningOutputTokens: 50, cacheCreationInputTokens: 0 },
      ),
    /REMOTE_USAGE_CACHE_EXCEEDS_INPUT/,
  )
  assert.throws(
    () =>
      normalizeUsageWithPolicy(
        codexPolicy,
        { inputTokens: 1500, cachedInputTokens: 200, outputTokens: 250, reasoningOutputTokens: 50, cacheCreationInputTokens: 1 },
        { inputTokens: 1000, cachedInputTokens: 100, outputTokens: 200, reasoningOutputTokens: 50, cacheCreationInputTokens: 0 },
      ),
    /REMOTE_USAGE_CACHE_WRITE_UNPROVEN/,
  )

  // Build full ReceiptV4 and prove semanticDigest stays identical across transport runId/generation reconnects,
  // while receiptDigest binds full provenance and rejects tampering.
  const baseInput = {
    engineId: 'codex',
    driverId: 'codex',
    driverVersion: '1.0.0',
    driverDigest: '1'.repeat(64),
    uid: '3',
    containerDbId: '7',
    dockerId: '2'.repeat(64),
    operationId: OP_ID,
    runId: RUN_ID,
    sessionKey: SESSION_KEY,
    canonicalModel: 'gpt-6-astra-remote',
    upstreamModel: 'gpt-6-astra',
    profileId: PROFILE_UUID,
    authEpoch: '8b71e0a7-fec6-497b-a733-4fcafcd5ec36',
    authorityTurnId: 'a'.repeat(32),
    turnKey: '3'.repeat(64),
    requestId: 'req_turn_001',
    nativeSessionId: 'thread_abc',
    terminalId: 'turn_001',
    policy: codexPolicy,
    countersBaseline: { inputTokens: 1000, cachedInputTokens: 100, outputTokens: 200, reasoningOutputTokens: 50, cacheCreationInputTokens: 0 },
    countersFinal: { inputTokens: 1500, cachedInputTokens: 400, outputTokens: 320, reasoningOutputTokens: 120, cacheCreationInputTokens: 0 },
    nativeStatus: 'success' as const,
    rawEvidenceDigest: '4'.repeat(64),
    provenance: {
      generation: '1',
      manifestHash: '5'.repeat(64),
      coreDigest: '6'.repeat(64),
      probeFingerprint: '7'.repeat(64),
    },
  }
  const receiptGen1 = buildRemoteReceiptV4(baseInput)
  const receiptGen2 = buildRemoteReceiptV4({
    ...baseInput,
    runId: '33333333-3333-4333-8333-333333333333',
    rawEvidenceDigest: '8'.repeat(64),
    provenance: { ...baseInput.provenance, generation: '2' },
  })

  assert.equal(receiptGen1.semanticDigest, receiptGen2.semanticDigest)
  assert.notEqual(receiptGen1.receiptDigest, receiptGen2.receiptDigest)
  assert.deepEqual(validateRemoteReceiptV4(receiptGen1, codexPolicy), receiptGen1)
  assert.throws(
    () => validateRemoteReceiptV4({ ...receiptGen1, usage: { ...receiptGen1.usage, inputTokens: 199 } }, codexPolicy),
    /REMOTE_RECEIPT_V4_DIGEST_MISMATCH/,
  )
})
