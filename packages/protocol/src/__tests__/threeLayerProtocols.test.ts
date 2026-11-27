import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  CAPSULE_ALLOWED_PREFIXES_BY_ENGINE,
  ENGINE_STATE_CAPSULE_MAX_BYTES,
  ENGINE_STATE_CAPSULE_MAX_FILES,
  computeEngineStateCapsuleId,
  isAllowedCapsuleLogicalPath,
  validateArtifactBlobRef,
  validateCredentialLeaseHandle,
  validateEngineStateCapsuleManifest,
  validatePlacementDescriptor,
  type AuthorityEngineKind,
  type EngineStateCapsuleManifestBody,
} from '../storage-seam/index.js'

import {
  DEFAULT_POOL_FALLBACK_POLICY,
  checkCapabilitySuperset,
  computeCacheAffinityKey,
  computeEffectiveModelCapabilities,
  computeStickyHomeKey,
  computeTurnReceiptV5Digests,
  resolveLogicalModelId,
  validateDriverCapabilityManifest,
  validateTurnReceiptV5,
  validateUnifiedTurnRequest,
  type DriverCapabilityManifest,
  type LogicalModelCapability,
  type TurnReceiptV5Body,
} from '../inference-pool/index.js'

import {
  SCHEMA_FILTERED_HASH_GOLDEN_VECTORS,
  computeSchemaFilteredArgsSha256,
  computeToolIdempotencyKey,
  filterArgsByInputSchema,
  isExecutionPolicyMonotonicTightening,
  isReadOnlyAllowedCanonicalTool,
  validateExecutionPolicyEnvelope,
  validateToolCallEnvelope,
  type ExecutionPolicyEnvelope,
} from '../exec-env/index.js'

import { remoteCanonicalJson, remoteCanonicalSha256 } from '../remotePool/canonical.js'

const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)
const SHA_C = 'c'.repeat(64)
const NOW_ISO = '2026-11-25T12:00:00.000Z'
const LATER_ISO = '2026-11-25T13:00:00.000Z'
const SESSION_KEY = 'agent:main:webchat:dm:ocv5_890_session_01'

// ---------------------------------------------------------------------------
// Layer 1 — storage-seam
// ---------------------------------------------------------------------------

test('storage-seam: validateArtifactBlobRef accepts valid refs and fails closed on traversal/oversize/unknown keys', () => {
  const valid = validateArtifactBlobRef({
    blobId: 'blob_0001_upload',
    tenantId: 'tenant-42',
    sha256: SHA_A,
    sizeBytes: 4096,
    mimeType: 'application/pdf',
    kind: 'upload',
    logicalName: 'spec.pdf',
    containerRelativePath: 'uploads/2026/spec.pdf',
    storageBackend: 'local_cas',
    storageUri: 'cas://sha256/' + SHA_A,
    createdAt: NOW_ISO,
  })
  assert.equal(valid.blobId, 'blob_0001_upload')
  assert.equal(valid.kind, 'upload')

  assert.throws(
    () =>
      validateArtifactBlobRef({
        blobId: 'blob_0001_upload',
        tenantId: 'tenant-42',
        sha256: SHA_A,
        sizeBytes: ENGINE_STATE_CAPSULE_MAX_BYTES + 1,
        mimeType: 'application/octet-stream',
        kind: 'upload',
      }),
    /STORAGE_ARTIFACT_BLOB_REF_INVALID/,
  )

  assert.throws(
    () =>
      validateArtifactBlobRef({
        blobId: 'blob_0001_upload',
        tenantId: 'tenant-42',
        sha256: SHA_A,
        sizeBytes: 12,
        mimeType: 'text/plain',
        kind: 'upload',
        containerRelativePath: '../etc/passwd',
      }),
    /STORAGE_ARTIFACT_BLOB_REF_PATH_INVALID/,
  )

  assert.throws(
    () =>
      validateArtifactBlobRef({
        blobId: 'blob_0001_upload',
        tenantId: 'tenant-42',
        sha256: SHA_A,
        sizeBytes: 12,
        mimeType: 'text/plain',
        kind: 'upload',
        extraField: true,
      }),
    /STORAGE_ARTIFACT_BLOB_REF_INVALID/,
  )
})

test('storage-seam: validatePlacementDescriptor validates pool, epoch, and stickyHomeKey', () => {
  const sticky = computeStickyHomeKey(SESSION_KEY)
  const desc = validatePlacementDescriptor({
    poolKind: 'remote_pool',
    engine: 'antigravity',
    driverId: 'antigravity',
    placementEpoch: 3,
    profileId: 'prof-1',
    stickyHomeKey: sticky,
  })
  assert.equal(desc.stickyHomeKey, sticky)
  assert.equal(desc.placementEpoch, 3)

  assert.throws(
    () =>
      validatePlacementDescriptor({
        poolKind: 'remote_pool',
        engine: 'antigravity',
        driverId: 'antigravity',
        placementEpoch: 0,
      }),
    /STORAGE_PLACEMENT_DESCRIPTOR_INVALID/,
  )

  assert.throws(
    () =>
      validatePlacementDescriptor({
        poolKind: 'remote_pool',
        engine: 'antigravity',
        driverId: 'antigravity',
        placementEpoch: 1,
        stickyHomeKey: 'bad-sticky-key',
      }),
    /STORAGE_PLACEMENT_DESCRIPTOR_STICKY_KEY_INVALID/,
  )
})

test('storage-seam: isAllowedCapsuleLogicalPath enforces per-engine whitelist and blocks traversal & credentials', () => {
  const validExamples: ReadonlyArray<[AuthorityEngineKind, string]> = [
    ['ccb', 'projects/main/session.jsonl'],
    ['codex', 'rollouts/2026/thread-1.jsonl'],
    ['antigravity', 'brain/conv-1/state.db'],
    ['grok', 'conversations/c1.json'],
    ['cursor', 'chats/chat-1.json'],
    ['zcode', 'history/h1.json'],
  ]
  for (const [engine, path] of validExamples) {
    assert.equal(isAllowedCapsuleLogicalPath(engine, path), true, `${engine}:${path}`)
    assert.ok(CAPSULE_ALLOWED_PREFIXES_BY_ENGINE[engine].length > 0)
  }

  const forbiddenPaths = [
    '/etc/passwd',
    'sessions/../auth.json',
    'sessions/auth.json',
    'sessions/openclaude.json',
    'sessions/.ssh/id_ed25519',
    'sessions/sub/.env.production',
    'sessions/cert.pem',
    'sessions/private.key',
    'sessions/dir\\escape.txt',
    'C:sessions/foo.json',
    'sessions/',
    'unknown_root/data.json',
    'brain/conv-1/state.db', // checked against ccb below
  ]
  for (const bad of forbiddenPaths) {
    assert.equal(isAllowedCapsuleLogicalPath('ccb', bad), false, `ccb must reject ${bad}`)
  }
})

test('storage-seam: engine state capsule manifest validates id, size limits, file limits, and path security', () => {
  const body: EngineStateCapsuleManifestBody = {
    schemaVersion: 1,
    tenantId: 'tenant-1',
    sessionKey: SESSION_KEY,
    engine: 'codex',
    engineVersion: '0.170.0',
    portability: 'same_engine_version',
    placementEpoch: 2,
    nativeSessionId: 'thr_12345',
    totalBytes: 300,
    files: [
      { logicalPath: 'rollouts/r1.jsonl', sha256: SHA_A, sizeBytes: 200 },
      { logicalPath: 'sessions/meta.sqlite', sha256: SHA_B, sizeBytes: 100, isSqlite: true },
    ],
    createdAt: NOW_ISO,
  }
  const capsuleId = computeEngineStateCapsuleId(body)
  const validated = validateEngineStateCapsuleManifest({ ...body, capsuleId })
  assert.equal(validated.capsuleId, capsuleId)
  assert.equal(validated.files.length, 2)

  // Tampered capsuleId fails closed
  assert.throws(
    () => validateEngineStateCapsuleManifest({ ...body, capsuleId: SHA_C }),
    /STORAGE_CAPSULE_ID_MISMATCH/,
  )

  // Wrong schemaVersion fails closed
  assert.throws(
    () => validateEngineStateCapsuleManifest({ ...body, schemaVersion: 2, capsuleId }),
    /STORAGE_CAPSULE_SCHEMA_VERSION_UNSUPPORTED/,
  )

  // Credential path inside manifest fails closed
  const badPathBody: EngineStateCapsuleManifestBody = {
    ...body,
    totalBytes: 10,
    files: [{ logicalPath: 'sessions/auth.json', sha256: SHA_A, sizeBytes: 10 }],
  }
  assert.throws(
    () =>
      validateEngineStateCapsuleManifest({
        ...badPathBody,
        capsuleId: computeEngineStateCapsuleId(badPathBody),
      }),
    /STORAGE_CAPSULE_PATH_FORBIDDEN/,
  )

  // Exceeding max bytes (> 1 GiB) fails closed
  const oversizeBody: EngineStateCapsuleManifestBody = {
    ...body,
    totalBytes: ENGINE_STATE_CAPSULE_MAX_BYTES + 1,
    files: [
      { logicalPath: 'rollouts/a.bin', sha256: SHA_A, sizeBytes: ENGINE_STATE_CAPSULE_MAX_BYTES },
      { logicalPath: 'rollouts/b.bin', sha256: SHA_B, sizeBytes: 1 },
    ],
  }
  assert.throws(
    () =>
      validateEngineStateCapsuleManifest({
        ...oversizeBody,
        capsuleId: computeEngineStateCapsuleId(oversizeBody),
      }),
    /STORAGE_CAPSULE_SIZE_EXCEEDED/,
  )

  // Exceeding max file count (> 2048) fails closed
  const tooManyFiles = Array.from({ length: ENGINE_STATE_CAPSULE_MAX_FILES + 1 }, (_, i) => ({
    logicalPath: `sessions/f-${i}.json`,
    sha256: SHA_A,
    sizeBytes: 1,
  }))
  const manyBody: EngineStateCapsuleManifestBody = {
    ...body,
    totalBytes: tooManyFiles.length,
    files: tooManyFiles,
  }
  assert.throws(
    () =>
      validateEngineStateCapsuleManifest({
        ...manyBody,
        capsuleId: computeEngineStateCapsuleId(manyBody),
      }),
    /STORAGE_CAPSULE_TOO_MANY_FILES/,
  )
})

test('storage-seam: validateCredentialLeaseHandle enforces noRefreshToken=true for memfd_or_tmpfs', () => {
  const ok = validateCredentialLeaseHandle({
    leaseId: 'lease-cred-1',
    tenantId: 'tenant-1',
    profileId: 'prof-codex-1',
    engine: 'codex',
    mountKind: 'memfd_or_tmpfs',
    noRefreshToken: true,
    issuedAt: NOW_ISO,
    expiresAt: LATER_ISO,
    scope: ['inference:turn'],
  })
  assert.equal(ok.noRefreshToken, true)

  assert.throws(
    () =>
      validateCredentialLeaseHandle({
        leaseId: 'lease-cred-2',
        tenantId: 'tenant-1',
        profileId: 'prof-codex-1',
        engine: 'codex',
        mountKind: 'memfd_or_tmpfs',
        noRefreshToken: false,
        issuedAt: NOW_ISO,
        expiresAt: LATER_ISO,
      }),
    /STORAGE_CREDENTIAL_LEASE_REFRESH_TOKEN_FORBIDDEN/,
  )

  assert.throws(
    () =>
      validateCredentialLeaseHandle({
        leaseId: 'lease-cred-3',
        tenantId: 'tenant-1',
        profileId: 'prof-codex-1',
        engine: 'codex',
        mountKind: 'proxy_broker',
        noRefreshToken: false,
        issuedAt: LATER_ISO,
        expiresAt: NOW_ISO,
      }),
    /STORAGE_CREDENTIAL_LEASE_WINDOW_INVALID/,
  )
})

// ---------------------------------------------------------------------------
// Layer 2 — inference-pool
// ---------------------------------------------------------------------------

test('inference-pool: resolveLogicalModelId maps -remote legacy alias to pin_remote without mutating regular ids', () => {
  assert.deepEqual(resolveLogicalModelId('gpt-6.2-sol-remote'), {
    logicalModel: 'gpt-6.2-sol',
    poolPreference: 'pin_remote',
    isLegacyRemoteAlias: true,
  })
  assert.deepEqual(resolveLogicalModelId('gpt-6.2-sol'), {
    logicalModel: 'gpt-6.2-sol',
    poolPreference: 'auto',
    isLegacyRemoteAlias: false,
  })
  assert.throws(() => resolveLogicalModelId(''), /INFERENCE_MODEL_ID_INVALID/)
  assert.throws(() => resolveLogicalModelId('-remote'), /INFERENCE_MODEL_ID_INVALID/)
})

test('inference-pool: computeEffectiveModelCapabilities takes strict 3-way intersection with zero silent widening', () => {
  const probed: LogicalModelCapability = {
    logicalModel: 'gpt-6.2-sol',
    upstreamModelId: 'gpt-6.2-sol',
    supportsVision: true,
    supportedEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'medium',
    supportedServiceTiers: ['standard', 'fast', 'ultrafast'],
    supportsReadOnly: true,
    supportsConsultTurn: true,
    supportsHermeticNoTools: true,
    supportsSwarm: true,
    supportsAdaptiveThinking: true,
    contextWindow: 1_000_000,
  }
  const transport: LogicalModelCapability = {
    ...probed,
    supportsVision: true,
    supportedEfforts: ['medium', 'high', 'max'],
    defaultEffort: 'high',
    supportedServiceTiers: ['standard', 'fast'],
    supportsSwarm: false,
    contextWindow: 400_000,
  }
  const catalog: LogicalModelCapability = {
    ...probed,
    supportsVision: false, // catalog gates vision off -> intersection MUST be false
    supportedEfforts: ['low', 'medium', 'high'],
    defaultEffort: 'low', // low is dropped by transport -> falls back to probed 'medium'
    supportedServiceTiers: ['standard', 'fast', 'ultrafast'],
    supportsConsultTurn: false,
    contextWindow: 500_000,
  }

  const eff = computeEffectiveModelCapabilities(probed, transport, catalog)
  assert.equal(eff.supportsVision, false)
  assert.deepEqual(eff.supportedEfforts, ['medium', 'high'])
  assert.equal(eff.defaultEffort, 'medium')
  assert.deepEqual(eff.supportedServiceTiers, ['standard', 'fast'])
  assert.equal(eff.supportsReadOnly, true)
  assert.equal(eff.supportsConsultTurn, false)
  assert.equal(eff.supportsHermeticNoTools, true)
  assert.equal(eff.supportsSwarm, false)
  assert.equal(eff.contextWindow, 400_000)

  assert.throws(
    () =>
      computeEffectiveModelCapabilities(probed, transport, {
        ...catalog,
        logicalModel: 'other-model',
      }),
    /INFERENCE_CAPABILITY_MODEL_MISMATCH/,
  )
})

test('inference-pool: checkCapabilitySuperset reports exact unsatisfiedReasons and DEFAULT_POOL_FALLBACK_POLICY is locked', () => {
  const manifest: DriverCapabilityManifest = validateDriverCapabilityManifest({
    schemaVersion: 5,
    poolKind: 'remote_pool',
    engineFamily: 'codex',
    authorityEngine: 'codex',
    driverId: 'codex',
    driverVersion: '5.0.0',
    observedAt: NOW_ISO,
    models: [
      {
        logicalModel: 'gpt-6.2-sol',
        supportsVision: false,
        supportedEfforts: ['medium', 'high'],
        defaultEffort: 'medium',
        supportedServiceTiers: ['standard', 'fast'],
        supportsReadOnly: true,
        supportsConsultTurn: false,
        supportsHermeticNoTools: true,
        supportsSwarm: false,
      },
    ],
  })

  const ok = checkCapabilitySuperset(manifest, 'gpt-6.2-sol', {
    reasoningEffort: 'high',
    serviceTier: 'fast',
    readOnly: true,
    hermeticNoTools: true,
  })
  assert.equal(ok.satisfied, true)
  assert.deepEqual(ok.unsatisfiedReasons, [])

  const fail = checkCapabilitySuperset(manifest, 'gpt-6.2-sol', {
    needsVision: true,
    reasoningEffort: 'xhigh',
    serviceTier: 'ultrafast',
    consultTurn: true,
    needsSwarm: true,
  })
  assert.equal(fail.satisfied, false)
  assert.deepEqual(fail.unsatisfiedReasons, [
    'vision_unsupported',
    'reasoning_effort_unsupported:xhigh',
    'service_tier_unsupported:ultrafast',
    'consult_turn_unsupported',
    'swarm_unsupported',
  ])

  const missing = checkCapabilitySuperset(manifest, 'claude-opus-4-6', {})
  assert.equal(missing.satisfied, false)
  assert.deepEqual(missing.unsatisfiedReasons, ['logical_model_unsupported:claude-opus-4-6'])

  assert.equal(Object.isFrozen(DEFAULT_POOL_FALLBACK_POLICY), true)
  assert.equal(DEFAULT_POOL_FALLBACK_POLICY.neverSilentDowngradeModel, true)
  assert.equal(DEFAULT_POOL_FALLBACK_POLICY.requireCapabilitySuperset, true)
  assert.equal(DEFAULT_POOL_FALLBACK_POLICY.allowCrossPoolOnPostDispatchFailure, false)
})

test('inference-pool: stickyHomeKey and cacheAffinityKey produce stable s-<16hex> without op/gen churn', () => {
  const sticky1 = computeStickyHomeKey(SESSION_KEY)
  const sticky2 = computeStickyHomeKey(SESSION_KEY)
  assert.match(sticky1, /^s-[a-f0-9]{16}$/)
  assert.equal(sticky1, sticky2)
  assert.notEqual(sticky1, computeStickyHomeKey(SESSION_KEY + '_other'))

  const aff1 = computeCacheAffinityKey({
    tenantId: 'tenant-1',
    sessionKey: SESSION_KEY,
    logicalModel: 'gemini-3-pro',
    engineFamily: 'antigravity',
    systemPromptSha256: SHA_A,
  })
  const aff2 = computeCacheAffinityKey({
    tenantId: 'tenant-1',
    sessionKey: SESSION_KEY,
    logicalModel: 'gemini-3-pro',
    engineFamily: 'antigravity',
    systemPromptSha256: SHA_A,
  })
  assert.match(aff1, /^s-[a-f0-9]{16}$/)
  assert.equal(aff1, aff2)
  assert.notEqual(
    aff1,
    computeCacheAffinityKey({
      tenantId: 'tenant-1',
      sessionKey: SESSION_KEY,
      logicalModel: 'gemini-3-pro',
      engineFamily: 'antigravity',
      systemPromptSha256: SHA_B,
    }),
  )
})

test('inference-pool: TurnReceiptV5 digests are domain-separated, reconnect-stable, and tamper-evident', () => {
  const baseBody: TurnReceiptV5Body = {
    version: 5,
    poolKind: 'remote_pool',
    engineFamily: 'codex',
    driverId: 'codex',
    driverVersion: '5.0.0',
    tenantId: 'tenant-1',
    sessionKey: SESSION_KEY,
    turnId: 'turn-100',
    turnKey: SHA_A,
    requestId: 'req-100',
    logicalModel: 'gpt-6.2-sol',
    canonicalModel: 'gpt-6.2-sol',
    upstreamModel: 'gpt-6.2-sol',
    serviceTier: 'fast',
    placementEpoch: 1,
    usageSemantics: 'codex_v5_per_turn',
    usage: {
      inputTokens: 1200,
      outputTokens: 350,
      cacheReadTokens: 800,
      cacheWriteTokens: 0,
      reasoningTokens: 120,
    },
    status: 'success',
    rawEvidenceDigest: SHA_B,
    finalizedAt: NOW_ISO,
  }
  const digests = computeTurnReceiptV5Digests(baseBody)
  assert.notEqual(digests.semanticDigest, digests.receiptDigest)

  const receipt = validateTurnReceiptV5({ ...baseBody, ...digests })
  assert.equal(receipt.semanticDigest, digests.semanticDigest)
  assert.equal(receipt.receiptDigest, digests.receiptDigest)

  // Reconnect/re-placement with different placementEpoch keeps semanticDigest identical
  // while receiptDigest changes (domain separation).
  const replayedBody: TurnReceiptV5Body = {
    ...baseBody,
    placementEpoch: 2,
    poolKind: 'local_pool',
  }
  const replayedDigests = computeTurnReceiptV5Digests(replayedBody)
  assert.equal(replayedDigests.semanticDigest, digests.semanticDigest)
  assert.notEqual(replayedDigests.receiptDigest, digests.receiptDigest)

  // 1-token usage tamper fails digest verification
  assert.throws(
    () =>
      validateTurnReceiptV5({
        ...receipt,
        usage: { ...receipt.usage, outputTokens: 351 },
      }),
    /TURN_RECEIPT_V5_DIGEST_MISMATCH/,
  )
})

test('inference-pool: validateUnifiedTurnRequest accepts multimodal blocks and rejects hermetic + toolBridge', () => {
  const req = validateUnifiedTurnRequest({
    schemaVersion: 5,
    turnId: 'turn-200',
    turnKey: SHA_A,
    requestId: 'req-200',
    tenantId: 'tenant-1',
    sessionKey: SESSION_KEY,
    logicalModel: 'gpt-6.2-sol',
    reasoningEffort: 'high',
    serviceTier: 'fast',
    input: [
      { type: 'text', text: 'Analyze this screenshot' },
      { type: 'image_ref', blobId: 'blob_img_1', sha256: SHA_B, mimeType: 'image/png' },
      { type: 'blob_ref', blobId: 'blob_doc_1', sha256: SHA_C, mimeType: 'text/markdown' },
    ],
    placementHint: {
      poolPreference: 'auto',
      stickyHomeKey: computeStickyHomeKey(SESSION_KEY),
    },
    toolBridge: {
      kind: 'unix_socket',
      uri: 'unix:///run/oc/tool-bridge.sock',
      attestationMode: 'schema_filtered_hook',
    },
  })
  assert.equal(req.input.length, 3)

  assert.throws(
    () =>
      validateUnifiedTurnRequest({
        ...req,
        hermeticNoTools: true,
      }),
    /INFERENCE_TURN_HERMETIC_TOOL_BRIDGE_FORBIDDEN/,
  )
})

// ---------------------------------------------------------------------------
// Layer 3 — exec-env
// ---------------------------------------------------------------------------

test('exec-env: OCV5-800 schema-filtered hash strips toolSummary with zero false positives and catches 1-byte tamper', () => {
  const schema = {
    type: 'object',
    properties: {
      CommandLine: { type: 'string' },
      WaitMsBeforeAsync: { type: 'integer' },
    },
    required: ['CommandLine'],
  }

  const cleanArgs = { CommandLine: 'ls -la', WaitMsBeforeAsync: 5000 }
  const cliArgsWithUiFields = {
    CommandLine: 'ls -la',
    WaitMsBeforeAsync: 5000,
    toolSummary: 'List workspace directory',
    _internalUiLabel: 'shell',
  }
  const tamperedArgs = {
    CommandLine: 'ls -lb', // 1-byte tamper in declared argument
    WaitMsBeforeAsync: 5000,
    toolSummary: 'List workspace directory',
  }

  assert.deepEqual(filterArgsByInputSchema(cliArgsWithUiFields, schema), cleanArgs)
  assert.equal(
    computeSchemaFilteredArgsSha256(cleanArgs, schema),
    computeSchemaFilteredArgsSha256(cliArgsWithUiFields, schema),
  )
  assert.notEqual(
    computeSchemaFilteredArgsSha256(cleanArgs, schema),
    computeSchemaFilteredArgsSha256(tamperedArgs, schema),
  )

  // Without schema properties, falls back to full canonical hash (extra field changes hash)
  assert.equal(
    computeSchemaFilteredArgsSha256(cliArgsWithUiFields, null),
    remoteCanonicalSha256(cliArgsWithUiFields),
  )
  assert.notEqual(
    computeSchemaFilteredArgsSha256(cleanArgs, { type: 'object' }),
    computeSchemaFilteredArgsSha256(cliArgsWithUiFields, { type: 'object' }),
  )

  // Golden vectors match canonical JSON and SHA-256 deterministically
  assert.ok(SCHEMA_FILTERED_HASH_GOLDEN_VECTORS.length >= 3)
  for (const vec of SCHEMA_FILTERED_HASH_GOLDEN_VECTORS) {
    assert.equal(
      remoteCanonicalJson(filterArgsByInputSchema(vec.args, vec.inputSchema)),
      vec.filteredCanonical,
      vec.name,
    )
    assert.equal(computeSchemaFilteredArgsSha256(vec.args, vec.inputSchema), vec.sha256, vec.name)
  }
})

test('exec-env: validateToolCallEnvelope checks idempotencyKey, attestation hash, and schema-filtered hash', () => {
  const schema = {
    type: 'object',
    properties: { Path: { type: 'string' }, StartLine: { type: 'integer' } },
  }
  const args = { Path: '/workspace/a.ts', StartLine: 1, toolSummary: 'Read file' }
  const filteredHash = computeSchemaFilteredArgsSha256(args, schema)
  const idempotencyKey = computeToolIdempotencyKey('lease-1', 'turn-1', 'call-1')

  const envelope = validateToolCallEnvelope(
    {
      schemaVersion: 1,
      leaseId: 'lease-1',
      turnId: 'turn-1',
      callId: 'call-1',
      idempotencyKey,
      canonicalName: 'read_file',
      arguments: args,
      argsSha256: filteredHash,
      attestation: {
        kind: 'schema_filtered_hook',
        argsSha256: filteredHash,
        observedAt: NOW_ISO,
        filteredKeys: ['Path', 'StartLine'],
      },
      timeoutMs: 30_000,
    },
    { inputSchema: schema },
  )
  assert.equal(envelope.argsSha256, filteredHash)

  // Works without passing opts.inputSchema when attestation provides filteredKeys
  const selfValidated = validateToolCallEnvelope(envelope)
  assert.equal(selfValidated.idempotencyKey, idempotencyKey)

  // Tampered declared argument fails closed
  assert.throws(
    () =>
      validateToolCallEnvelope(
        {
          ...envelope,
          arguments: { ...args, Path: '/workspace/b.ts' },
        },
        { inputSchema: schema },
      ),
    /EXEC_TOOL_CALL_ARGS_HASH_MISMATCH/,
  )

  // Tampered idempotencyKey fails closed
  assert.throws(
    () =>
      validateToolCallEnvelope(
        {
          ...envelope,
          idempotencyKey: 'idem-00000000000000000000000000000000',
        },
        { inputSchema: schema },
      ),
    /EXEC_TOOL_CALL_IDEMPOTENCY_MISMATCH/,
  )
})

test('exec-env: execution policy validation, monotonic tightening, and cross-pool read-only tool predicate', () => {
  assert.equal(isReadOnlyAllowedCanonicalTool('read_file', { Path: '/a.ts' }), true)
  assert.equal(isReadOnlyAllowedCanonicalTool('oc_grep'), true)
  assert.equal(isReadOnlyAllowedCanonicalTool('consult_advisor'), true)
  assert.equal(isReadOnlyAllowedCanonicalTool('web_fetch', { method: 'GET' }), true)
  assert.equal(isReadOnlyAllowedCanonicalTool('web_fetch', { method: 'POST' }), false)
  assert.equal(isReadOnlyAllowedCanonicalTool('read_file', { overwrite: true }), false)
  assert.equal(isReadOnlyAllowedCanonicalTool('write_file'), false)
  assert.equal(isReadOnlyAllowedCanonicalTool('run_command'), false)
  assert.equal(isReadOnlyAllowedCanonicalTool('unknown_custom_tool'), false)

  const normalPolicy: ExecutionPolicyEnvelope = validateExecutionPolicyEnvelope({
    schemaVersion: 1,
    mode: 'normal',
    allowedTools: ['read_file', 'grep_search', 'write_file', 'run_command'],
    deniedTools: ['run_command'],
    allowNetworkEgress: true,
    allowWorkspaceWrite: true,
    allowSubprocessSpawn: true,
    maxToolCallsPerTurn: 20,
  })

  const readOnlyPolicy: ExecutionPolicyEnvelope = validateExecutionPolicyEnvelope({
    schemaVersion: 1,
    mode: 'read_only',
    allowedTools: ['read_file', 'grep_search'],
    allowNetworkEgress: false,
    allowWorkspaceWrite: false,
    allowSubprocessSpawn: false,
    maxToolCallsPerTurn: 10,
  })

  const hermeticPolicy: ExecutionPolicyEnvelope = validateExecutionPolicyEnvelope({
    schemaVersion: 1,
    mode: 'hermetic_no_tools',
    allowedTools: [],
    allowNetworkEgress: false,
    allowWorkspaceWrite: false,
    allowSubprocessSpawn: false,
    maxToolCallsPerTurn: 0,
  })

  // Valid monotonic tightenings
  assert.equal(isExecutionPolicyMonotonicTightening(normalPolicy, readOnlyPolicy), true)
  assert.equal(isExecutionPolicyMonotonicTightening(readOnlyPolicy, hermeticPolicy), true)
  assert.equal(isExecutionPolicyMonotonicTightening(normalPolicy, hermeticPolicy), true)

  // Mode relaxations MUST be rejected
  assert.equal(isExecutionPolicyMonotonicTightening(readOnlyPolicy, normalPolicy), false)
  assert.equal(isExecutionPolicyMonotonicTightening(hermeticPolicy, readOnlyPolicy), false)
  assert.equal(isExecutionPolicyMonotonicTightening(hermeticPolicy, normalPolicy), false)

  // Adding a tool outside parent allowlist MUST be rejected
  const widenedTools: ExecutionPolicyEnvelope = validateExecutionPolicyEnvelope({
    ...readOnlyPolicy,
    allowedTools: ['read_file', 'grep_search', 'list_dir'],
  })
  assert.equal(isExecutionPolicyMonotonicTightening(readOnlyPolicy, widenedTools), false)

  // Un-denying a parent-denied tool MUST be rejected
  const unDenied: ExecutionPolicyEnvelope = validateExecutionPolicyEnvelope({
    ...normalPolicy,
    allowedTools: ['read_file', 'run_command'],
    deniedTools: [],
  })
  assert.equal(isExecutionPolicyMonotonicTightening(normalPolicy, unDenied), false)

  // Relaxing maxToolCallsPerTurn MUST be rejected
  const moreCalls: ExecutionPolicyEnvelope = validateExecutionPolicyEnvelope({
    ...readOnlyPolicy,
    maxToolCallsPerTurn: 15,
  })
  assert.equal(isExecutionPolicyMonotonicTightening(readOnlyPolicy, moreCalls), false)

  // Invalid policy shapes fail closed
  assert.throws(
    () =>
      validateExecutionPolicyEnvelope({
        schemaVersion: 1,
        mode: 'read_only',
        allowedTools: ['read_file', 'write_file'],
        allowNetworkEgress: false,
        allowWorkspaceWrite: false,
        allowSubprocessSpawn: false,
      }),
    /EXEC_POLICY_READ_ONLY_TOOL_FORBIDDEN/,
  )
  assert.throws(
    () =>
      validateExecutionPolicyEnvelope({
        schemaVersion: 1,
        mode: 'hermetic_no_tools',
        allowedTools: ['read_file'],
        allowNetworkEgress: false,
        allowWorkspaceWrite: false,
        allowSubprocessSpawn: false,
      }),
    /EXEC_POLICY_HERMETIC_VIOLATION/,
  )
})

// ---------------------------------------------------------------------------
// Architecture Guard Invariants (R2-contract-node & R2-export-star)
// ---------------------------------------------------------------------------

test('architecture invariants: zero node:* imports, zero Buffer usage, and zero export * across all 3 layers', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const protocolSrc = resolve(here, '..')
  const layers = ['storage-seam', 'inference-pool', 'exec-env'] as const
  const files = ['contracts.ts', 'validators.ts', 'index.ts'] as const

  for (const layer of layers) {
    for (const file of files) {
      const fullPath = resolve(protocolSrc, layer, file)
      const content = readFileSync(fullPath, 'utf8')
      assert.doesNotMatch(
        content,
        /\bfrom\s+['"]node:/,
        `${layer}/${file} violates R2-contract-node`,
      )
      assert.doesNotMatch(
        content,
        /\bBuffer\b/,
        `${layer}/${file} must use Uint8Array instead of Node Buffer`,
      )
      if (file === 'index.ts') {
        assert.doesNotMatch(
          content,
          /^\s*export\s+\*/m,
          `${layer}/${file} violates R2-export-star`,
        )
      }
    }
  }
})
