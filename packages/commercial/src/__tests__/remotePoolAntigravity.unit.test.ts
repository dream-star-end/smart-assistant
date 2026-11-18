import assert from 'node:assert/strict'
import test from 'node:test'
import { REMOTE_DRIVER_PROTOCOL_VERSION, type RemoteProbeSnapshot } from '@openclaude/protocol'
import { defaultRemoteCanonicalModelId } from '../account-pool/remoteBrainPool.js'
import {
  buildDefaultDriverContextForNode,
  loadRemoteDriverRegistry,
  resolveProbedUpstreamModel,
} from '../account-pool/remotePool/index.js'

function sampleSnapshot(models: string[]): RemoteProbeSnapshot {
  return {
    schemaVersion: REMOTE_DRIVER_PROTOCOL_VERSION,
    engineId: 'antigravity',
    driverId: 'antigravity',
    driverVersion: '1.0.0',
    source: 'antigravity-cli:models',
    freshness: 'cli-observed',
    authPresent: true,
    accountObserved: true,
    cliVersion: '1.5.5',
    cliSha256: 'a'.repeat(64),
    models: models.map((upstreamModelId) => ({
      upstreamModelId,
      displayName: upstreamModelId,
      supportedEfforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
      supportsAdaptiveThinking: true,
      supportsVision: false,
    })),
    rawResponseSha256: 'b'.repeat(64),
    observedAt: '2026-11-18T00:00:00Z',
  }
}

test('loadRemoteDriverRegistry registers antigravity driver with capacity and authority', () => {
  const reg = loadRemoteDriverRegistry().get('antigravity')
  assert.ok(reg)
  assert.equal(reg.driverId, 'antigravity')
  assert.equal(reg.engineId, 'antigravity')
  assert.equal(reg.authorityEngine, 'antigravity')
  assert.equal(reg.profileMaxLanes, 5)
  assert.equal(reg.coreDigest, loadRemoteDriverRegistry().get('codex')?.coreDigest)
  assert.equal(reg.controllerSha256, loadRemoteDriverRegistry().get('codex')?.controllerSha256)
})

test('resolveProbedUpstreamModel maps antigravity slugs, efforts, and orchestrator alias', () => {
  const snap = sampleSnapshot([
    'gemini-4-carbon',
    'gemini-4-carbon-medium',
    'gemini-4-hydrogen-high',
    'gemini-pro-orchestrator',
    'claude-opus-5-5',
    'claude-sonnet-5-5-medium',
  ])

  assert.equal(
    resolveProbedUpstreamModel('antigravity', 'gemini-4-carbon-medium', snap),
    'gemini-4-carbon-medium',
  )
  assert.equal(
    resolveProbedUpstreamModel('antigravity', 'antigravity-gemini-4-hydrogen-remote', snap),
    'gemini-4-hydrogen-high',
  )
  assert.equal(
    resolveProbedUpstreamModel('antigravity', 'antigravity-orchestrator-carbon-remote', snap),
    'gemini-pro-orchestrator',
  )
  assert.equal(
    resolveProbedUpstreamModel('antigravity', 'antigravity-claude-opus-5.5-remote', snap),
    'claude-opus-5-5',
  )
  assert.equal(
    resolveProbedUpstreamModel('antigravity', 'antigravity-claude-sonnet-5.5-remote', snap),
    'claude-sonnet-5-5-medium',
  )
  assert.equal(resolveProbedUpstreamModel('antigravity', 'unknown-model', snap), null)
})

test('defaultRemoteCanonicalModelId normalizes antigravity remote slugs consistently', () => {
  assert.equal(
    defaultRemoteCanonicalModelId('antigravity', 'gemini-4-carbon-medium'),
    'antigravity-gemini-4-carbon-remote',
  )
  assert.equal(
    defaultRemoteCanonicalModelId('antigravity', 'gemini-pro-orchestrator'),
    'antigravity-orchestrator-carbon-remote',
  )
  assert.equal(
    defaultRemoteCanonicalModelId('antigravity', 'claude-opus-5-5'),
    'antigravity-claude-opus-5.5-remote',
  )
})

test('buildDefaultDriverContextForNode builds antigravity box paths with QEMU binary', () => {
  const ctx = buildDefaultDriverContextForNode({
    driverId: 'antigravity',
    sshUser: 'box',
    profileName: 'default',
    controllerSha256: 'c'.repeat(64),
  })
  assert.equal(ctx.cliPath, '/home/box/.local/bin/agy')
  assert.equal(ctx.qemuPath, '/home/box/.local/lib/antigravity-compat/usr/bin/qemu-x86_64-static')
  assert.equal(ctx.accountHome, '/home/box')
  assert.equal(ctx.profileName, 'default')
})
