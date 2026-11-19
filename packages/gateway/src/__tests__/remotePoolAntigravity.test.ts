import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  REMOTE_DRIVER_BACKEND,
  REMOTE_DRIVER_PROTOCOL_VERSION,
  remoteCanonicalSha256,
} from '@openclaude/protocol'
import { createRemoteLaneRuntime } from '../cc5ContainerRuntime.js'
import { resolveEngineRemoteContextBuilder } from '../engine/registry.js'
import '../remotePool/registerRemoteDriver.js'
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
