import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import fs from 'node:fs'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import {
  CC5_FIXED_EXECUTION_ROOT,
  CC5_FIXED_TOOL_NAME,
  Cc5FixedToolExecutor,
  type Cc5ToolRequest,
} from '../cc5FixedTool.js'

test('production fixed execution root uses the precreated persistent personal data volume', () => {
  assert.equal(CC5_FIXED_EXECUTION_ROOT, '/home/agent/.openclaude/.cc5-t1555u')
})

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
  const executor = (executionRoot = root) =>
    new Cc5FixedToolExecutor(binding, request.sessionKey, keyring, admission, executionRoot)
  return {
    root,
    binding,
    a,
    lease,
    request,
    observed,
    executor,
    envelope,
    leaseEnvelope,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

test('signed sole tool really writes/reads a file in its fixed execution directory; a fresh executor reads the same receipt without rerunning', async () => {
  const f = fixture()
  try {
    const first = await f.executor().execute(f.request, f.observed)
    assert.equal(first.exitCode, 0)
    assert.equal(first.dockerId, f.binding.dockerId)
    assert.match(first.stdout, /UID=[0-9]+/)
    assert.match(first.stdout, /PIDNS=pid:\[[0-9]+\]/)
    const file = join(f.root, f.binding.operationId, 'cc5-proof.txt')
    assert.equal(readFileSync(file, 'utf8'), `${first.marker}\n`)
    const second = await f.executor().execute(f.request, f.observed)
    assert.deepEqual(second, first)
    assert.equal(readFileSync(file, 'utf8'), `${first.marker}\n`)
  } finally {
    f.cleanup()
  }
})

test('wrong scope, native observation, signature, lease or extra command input have zero file/command effect', async () => {
  const f = fixture()
  try {
    const cases: Array<Partial<Cc5ToolRequest>> = [
      { uid: '999' },
      { containerDbId: '99' },
      { dockerId: 'c'.repeat(64) },
      { operationId: randomUUID() },
      { sessionKey: 'other' },
      { turnKey: 'other' },
      { nativeSessionId: randomUUID() },
      { toolUseId: 'other-tool' },
      { rpcId: f.request.toolUseId },
      { name: 'Bash' },
      { arguments: { operationId: f.binding.operationId, command: 'touch outside' } },
      { authority: f.envelope({ ...f.a, uid: 999 }) },
      { authority: f.envelope({ ...f.a, connectionChallenge: 'other-challenge' }) },
      {
        lease: f.leaseEnvelope({
          ...f.lease,
          expiresAt: Date.now() - 10000,
          issuedAt: Date.now() - 20000,
        }),
      },
      { lease: f.leaseEnvelope({ ...f.lease, authorityTurnId: 'other-authority' }) },
      { authority: `${f.request.authority.slice(0, -4)}AAAA` },
    ]
    for (const changed of cases) {
      await assert.rejects(f.executor().execute({ ...f.request, ...changed }, f.observed))
      assert.equal(existsSync(join(f.root, f.binding.operationId)), false)
    }
  } finally {
    f.cleanup()
  }
})

test('same operation with a different real tool ID cannot reuse the first completed receipt or execute twice', async () => {
  const f = fixture()
  try {
    const first = await f.executor().execute(f.request, f.observed)
    await assert.rejects(
      f
        .executor()
        .execute(
          { ...f.request, toolUseId: 'toolu_new' },
          { ...f.observed, toolUseId: 'toolu_new' },
        ),
      /REJECTED/,
    )
    const persisted = JSON.parse(
      readFileSync(join(f.root, f.binding.operationId, 'receipt.json'), 'utf8'),
    )
    assert.deepEqual(persisted, first)
  } finally {
    f.cleanup()
  }
})

test('concurrent duplicate cannot start another command while the first attempt is unresolved', async () => {
  const f = fixture()
  try {
    const pending = f.executor().execute(f.request, f.observed)
    void pending.catch(() => {})
    await assert.rejects(f.executor().execute(f.request, f.observed), /DELIVERY_UNKNOWN/)
    const first = await pending
    assert.equal(first.exitCode, 0)
    assert.equal((await f.executor().execute(f.request, f.observed)).commandId, first.commandId)
  } finally {
    f.cleanup()
  }
})

test('failed fixed command leaves attempted/unknown and cannot be restarted by a new executor', async () => {
  const f = fixture()
  try {
    const work = join(f.root, f.binding.operationId)
    mkdirSync(work, { mode: 0o700 })
    writeFileSync(join(work, 'cc5-proof.txt'), 'preexisting-guard', { mode: 0o600 })
    await assert.rejects(f.executor().execute(f.request, f.observed), /EEXIST/)
    assert.equal(existsSync(join(work, 'attempt.json')), true)
    assert.equal(existsSync(join(work, 'receipt.json')), false)
    await assert.rejects(f.executor().execute(f.request, f.observed), /DELIVERY_UNKNOWN/)
    assert.equal(readFileSync(join(work, 'cc5-proof.txt'), 'utf8'), 'preexisting-guard')
  } finally {
    f.cleanup()
  }
})

test('new execution root parent fsync failure stops before journal creation or command effect', async () => {
  const f = fixture()
  const executionRoot = join(f.root, 'new-root')
  const original = fs.fsyncSync
  const parent = fs.statSync(f.root)
  let called = 0
  fs.fsyncSync = (fd: number): void => {
    const target = fs.fstatSync(fd)
    if (target.dev === parent.dev && target.ino === parent.ino) {
      called++
      throw Object.assign(new Error('injected parent fsync EIO'), { code: 'EIO' })
    }
    original(fd)
  }
  syncBuiltinESMExports()
  try {
    const executor = f.executor(executionRoot)
    await assert.rejects(executor.execute(f.request, f.observed), /parent fsync EIO/)
    assert.equal(called, 1)
    assert.equal(existsSync(join(executionRoot, f.binding.operationId)), false)
  } finally {
    fs.fsyncSync = original
    syncBuiltinESMExports()
    f.cleanup()
  }
})
