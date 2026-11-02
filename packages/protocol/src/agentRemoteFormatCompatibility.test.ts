import assert from 'node:assert/strict'
import test from 'node:test'
import { compareAgentRemoteFormatVersions } from './agentRemoteFormatCompatibility.js'

const live = { checkpointSchemaVersion: 1, controlStoreUserVersion: 1 }
// Fixed source inventory: old P3 draft24294c82, not an activation or migration target.
const draft = { checkpointSchemaVersion: 3, controlStoreUserVersion: 5 }

test('live-to-draft headers require both migrations without filling missing state', () => {
  const result = compareAgentRemoteFormatVersions(live, draft)
  assert.deepEqual(result, {
    checkpoint: { sourceVersion: 1, targetVersion: 3, comparison: 'explicit-migration-required', direction: 'upgrade' },
    controlStore: { sourceVersion: 1, targetVersion: 5, comparison: 'explicit-migration-required', direction: 'upgrade' },
  })
})

test('downgrading headers also requires an explicit migration', () => {
  const result = compareAgentRemoteFormatVersions(draft, live)
  for (const field of [result.checkpoint, result.controlStore]) {
    assert.equal(field.comparison, 'explicit-migration-required')
    assert.equal(field.direction, 'downgrade')
  }
})

test('matching headers report equality without claiming content or authority validation', () => {
  const result = compareAgentRemoteFormatVersions(live, live)
  assert.equal(result.checkpoint.comparison, 'same-version')
  assert.equal(result.controlStore.direction, 'unchanged')
  assert.equal('supported' in result, false)
  assert.equal('restoreAllowed' in result, false)
})

test('unknown equal versions are still only a numeric comparison', () => {
  const unknown = { checkpointSchemaVersion: 99, controlStoreUserVersion: 77 }
  const result = compareAgentRemoteFormatVersions(unknown, unknown)
  assert.equal(result.checkpoint.comparison, 'same-version')
  assert.equal(result.controlStore.sourceVersion, 77)
  assert.equal('supported' in result.controlStore, false)
})

test('a one-sided format change does not change the other header', () => {
  const result = compareAgentRemoteFormatVersions(live, { ...live, checkpointSchemaVersion: 3 })
  assert.equal(result.checkpoint.comparison, 'explicit-migration-required')
  assert.equal(result.controlStore.comparison, 'same-version')
})

test('missing, extra and non-object descriptors are rejected on either side', () => {
  for (const bad of [null, undefined, [], 1, '1', {}, { checkpointSchemaVersion: 1 },
    { ...live, nativeWriterGeneration: 0 }, { schemaVersion: 1, checkpointId: 'unverified' }]) {
    assert.throws(() => compareAgentRemoteFormatVersions(bad, live), /FORMAT_HEADER_INVALID/)
    assert.throws(() => compareAgentRemoteFormatVersions(live, bad), /FORMAT_HEADER_INVALID/)
  }
})

test('zero, fractional, unsafe, nonfinite and coerced versions are rejected', () => {
  for (const version of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '1', undefined]) {
    for (const key of ['checkpointSchemaVersion', 'controlStoreUserVersion']) {
      const bad = { ...live, [key]: version }
      assert.throws(() => compareAgentRemoteFormatVersions(bad, live), /FORMAT_HEADER_INVALID/)
      assert.throws(() => compareAgentRemoteFormatVersions(live, bad), /FORMAT_HEADER_INVALID/)
    }
  }
})

test('comparison neither mutates input nor retains mutable header references', () => {
  const source = { ...live }
  const target = { ...draft }
  const result = compareAgentRemoteFormatVersions(source, target)
  assert.deepEqual(source, live)
  assert.deepEqual(target, draft)
  source.checkpointSchemaVersion = 55
  target.controlStoreUserVersion = 66
  assert.equal(result.checkpoint.sourceVersion, 1)
  assert.equal(result.controlStore.targetVersion, 5)
  assert.equal(Object.isFrozen(result.checkpoint), true)
})
